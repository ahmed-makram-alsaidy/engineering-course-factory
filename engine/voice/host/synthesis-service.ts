// P10.4 Voice Synthesis Orchestration Service
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8, 16, 18, 19, 29 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 4, 8, 9.
//
// Orchestration Flow:
// PlannedNarrationUnit + VoiceProfile
//   -> Cache-First Inspection (voiceCache.inspect)
//        [HIT]  -> Return validated immutable asset immediately (0 provider calls)
//        [MISS] -> Single-flight lock per cache_key
//                   -> Disk space preflight (fail closed with LOW_DISK_ABORT)
//                   -> Build SynthesisRequest (request_id decoupled from identity)
//                   -> trusted VoiceProvider.synthesize
//                   -> VoiceAssetNormalizer (FFmpeg + sample-domain mastering)
//                   -> VoiceAssetValidator (11-point validation)
//                   -> Atomic publication to immutable cache (voiceCache.publish)
//                   -> Return newly published asset
//        [CORRUPT] -> Evict corrupt entry (1x bounded recovery) -> Synthesize
//
// Invariants:
// - Zero cloud vendor SDKs.
// - Zero runtime session or take ID pollution in cache identity.
// - In-process single-flight per cache_key prevents concurrent duplicate generation.
// - Existing valid cache entry is NEVER overwritten.
// - Cancellation cleans up staging and leaves no partial cache artifacts.

import { randomUUID } from "node:crypto";
import {
  AUDIO_BITS_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_FORMAT,
  AUDIO_SAMPLE_RATE_HZ,
} from "../src/audio-clock.ts";
import {
  AUDIO_NORMALIZATION_VERSION,
  TEXT_NORMALIZATION_VERSION,
  VOICE_CONTRACT_VERSION,
  VOICE_CONTRACT_VERSION_1_1,
  VoiceAssetMetadataSchema,
  type NormalizedAlignment,
  type VoiceAssetMetadata,
  type VoiceProfile,
} from "../src/protocol.ts";
import {
  type ProviderSynthesisResult,
  type VoiceProvider,
  VoiceProviderError,
} from "../src/provider-interface.ts";
import { resolveVoiceProvider } from "../src/provider-registry.ts";
import { createPlannedSynthesisRequest, type PlannedNarrationUnit } from "../src/narration-planner.ts";
import { VoiceAssetNormalizer } from "./audio-normalizer.ts";
import { VoiceCache } from "./voice-cache.ts";
import { VoiceValidationError } from "./asset-validator.ts";

export interface SynthesizeNarrationInput {
  readonly plannedUnit: PlannedNarrationUnit;
  readonly profile: VoiceProfile;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export interface SynthesizedVoiceAsset {
  readonly asset: VoiceAssetMetadata;
  readonly audio_bytes: Buffer;
  readonly alignment: NormalizedAlignment;
  readonly cache_hit: boolean;
}

export interface VoiceSynthesisServiceOptions {
  readonly cache?: VoiceCache;
  readonly normalizer?: VoiceAssetNormalizer;
  readonly providerResolver?: (family: string) => VoiceProvider;
}

export class VoiceSynthesisService {
  readonly cache: VoiceCache;
  readonly normalizer: VoiceAssetNormalizer;
  private readonly providerResolver: (family: string) => VoiceProvider;

  /** In-process single-flight map indexed by canonical cache_key. */
  private readonly inFlight = new Map<string, Promise<SynthesizedVoiceAsset>>();

  constructor(options?: VoiceSynthesisServiceOptions) {
    this.cache = options?.cache ?? new VoiceCache();
    this.normalizer = options?.normalizer ?? new VoiceAssetNormalizer();
    this.providerResolver = options?.providerResolver ?? resolveVoiceProvider;
  }

  /**
   * Synthesizes and masters a PlannedNarrationUnit with strict cache-first semantics.
   */
  async synthesizeUnit(input: SynthesizeNarrationInput): Promise<SynthesizedVoiceAsset> {
    const { plannedUnit, profile, signal } = input;
    const cacheKey = plannedUnit.cache_key;

    if (signal?.aborted) {
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: "[CANCELLED] Synthesis cancelled before execution",
        provider_identity: {
          provider_family: profile.provider_family,
          provider_model: profile.provider_model,
          provider_voice_id: profile.provider_voice_id,
        },
      });
    }

    // 1. In-process single-flight: if an identical cache_key operation is already running, await it
    const existingFlight = this.inFlight.get(cacheKey);
    if (existingFlight) {
      return existingFlight;
    }

    // 2. Synchronously register single flight before any await to avoid async race
    const flightPromise = (async () => {
      // Cache-first inspection
      const inspectResult = await this.cache.inspect(cacheKey);
      if (inspectResult.hit) {
        return {
          asset: inspectResult.asset,
          audio_bytes: inspectResult.audioBytes,
          alignment: inspectResult.alignment,
          cache_hit: true,
        };
      }

      if (inspectResult.reason === "CORRUPT") {
        // Apply 1x bounded recovery: evict corrupt entry, proceed to regenerate once
        await this.cache.evict(cacheKey);
      }

      return this.executeSynthesisFlight(input);
    })();

    this.inFlight.set(cacheKey, flightPromise);

    try {
      return await flightPromise;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /**
   * Internal worker executing provider synthesis, normalization, validation and atomic publication.
   */
  private async executeSynthesisFlight(input: SynthesizeNarrationInput): Promise<SynthesizedVoiceAsset> {
    const { plannedUnit, profile, signal } = input;
    const cacheKey = plannedUnit.cache_key;

    const providerIdentity = {
      provider_family: profile.provider_family,
      provider_model: profile.provider_model,
      provider_voice_id: profile.provider_voice_id,
    };

    // Resolve provider adapter
    let provider;
    try {
      provider = this.providerResolver(profile.provider_family);
    } catch (err: unknown) {
      throw new VoiceProviderError({
        code: "UNSUPPORTED_VOICE",
        message: `Failed to resolve provider for family '${profile.provider_family}': ${err instanceof Error ? err.message : String(err)}`,
        provider_identity: providerIdentity,
        cause: err,
      });
    }

    // Prepare SynthesisRequest (request_id generated separately, does not affect cache identity)
    const rawRequestId = input.requestId ?? `req-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const synthesisRequest = createPlannedSynthesisRequest(plannedUnit, profile, rawRequestId);

    // Call Provider
    let providerResult: ProviderSynthesisResult;
    try {
      providerResult = await provider.synthesize(synthesisRequest, signal);
    } catch (err: unknown) {
      if (err instanceof VoiceProviderError) {
        throw err;
      }
      throw new VoiceProviderError({
        code: signal?.aborted ? "CANCELLED" : "SYNTHESIS_FAILED",
        message: err instanceof Error ? err.message : String(err),
        provider_identity: providerIdentity,
        cause: err,
      });
    }

    // Check cancellation after provider synthesis
    if (signal?.aborted) {
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: "Synthesis cancelled after provider output",
        provider_identity: providerIdentity,
      });
    }

    // Call Normalizer
    let normResult;
    try {
      normResult = await this.normalizer.normalize(
        providerResult.audio_bytes,
        providerResult.alignment,
        {
          signal,
          inputSampleRate: providerResult.sample_rate_hz,
          inputChannels: providerResult.channels,
        },
      );
    } catch (err: unknown) {
      if (err instanceof VoiceValidationError) {
        throw new VoiceProviderError({
          code: "VALIDATION_FAILED",
          message: err.message,
          provider_identity: providerIdentity,
          cause: err,
        });
      }
      if (err instanceof VoiceProviderError) {
        throw err;
      }
      throw new VoiceProviderError({
        code: signal?.aborted ? "CANCELLED" : "NORMALIZATION_FAILED",
        message: `Audio normalization failed: ${err instanceof Error ? err.message : String(err)}`,
        provider_identity: providerIdentity,
        cause: err,
      });
    }

    // Build canonical VoiceAssetMetadata
    let metadata: VoiceAssetMetadata;
    try {
      metadata = VoiceAssetMetadataSchema.parse({
        voice_unit_id: plannedUnit.voice_unit_id,
        cache_key: cacheKey,
        audio_asset_digest: normResult.report.audio_sha256,
        sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
        channels: AUDIO_CHANNELS,
        bits_per_sample: AUDIO_BITS_PER_SAMPLE,
        sample_format: AUDIO_SAMPLE_FORMAT,
        sample_count: normResult.sample_count,
        duration_us: normResult.duration_us,
        provider_family: profile.provider_family,
        provider_model: profile.provider_model,
        provider_voice_id: profile.provider_voice_id,
        text_normalization_version: TEXT_NORMALIZATION_VERSION,
        audio_normalization_version: AUDIO_NORMALIZATION_VERSION,
        voice_contract_version: profile.delivery_profile_id
          ? VOICE_CONTRACT_VERSION_1_1
          : VOICE_CONTRACT_VERSION,
        alignment_status: normResult.alignment.status,
      });
    } catch (err: unknown) {
      throw new VoiceProviderError({
        code: "VALIDATION_FAILED",
        message: `Generated VoiceAsset metadata contract violation: ${err instanceof Error ? err.message : String(err)}`,
        provider_identity: providerIdentity,
        cause: err,
      });
    }

    // Atomically publish into immutable cache
    try {
      await this.cache.publish(
        cacheKey,
        metadata,
        normResult.canonical_wav,
        normResult.alignment,
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("[LOW_DISK_ABORT]")) {
        throw new VoiceProviderError({
          code: "LOW_DISK_ABORT",
          message: err.message,
          provider_identity: providerIdentity,
          cause: err,
        });
      }
      throw new VoiceProviderError({
        code: "VALIDATION_FAILED",
        message: `Atomic cache publication failed: ${err instanceof Error ? err.message : String(err)}`,
        provider_identity: providerIdentity,
        cause: err,
      });
    }

    return {
      asset: metadata,
      audio_bytes: normResult.canonical_wav,
      alignment: normResult.alignment,
      cache_hit: false,
    };
  }
}
