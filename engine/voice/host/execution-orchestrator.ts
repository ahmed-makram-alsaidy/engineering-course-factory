// P10.6 Voice Execution Orchestrator
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 9, 16, 18, 19, 28, 29 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 4, 8, 9, 11.
//
// Responsibilities:
// - Coordinates cache-first inspection, single-flight deduplication, and atomic publishing.
// - Limits global synthesis concurrency (<= 4) and per-provider concurrency (<= 2).
// - Enforces bounded retry orchestration with anti-blind-retry semantics.
// - Enforces active runtime session and generation fencing.
// - Bounded graceful shutdown (<= 5,000 ms) with safe idempotency.
// - Cancellation at every stage: queued, backoff, provider, and normalization.
// - Content acceptance vs active runtime acceptance: valid published cache preserved even if cancelled.
// - Safe fallback enforcement: fallback provider never publishes under primary provider cache key.

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
  type RuntimeFence,
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
import { createCacheIdentityPayload, deriveCacheKey } from "../src/cache-identity.ts";
import { VoiceAssetNormalizer } from "./audio-normalizer.ts";
import { VoiceCache } from "./voice-cache.ts";
import { VoiceValidationError } from "./asset-validator.ts";
import { ConcurrencyLimiter, type ConcurrencyLimiterOptions } from "./concurrency-limiter.ts";
import { VoiceRetryOrchestrator, type RetryPolicyConfig } from "./retry-orchestrator.ts";

export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface ExecuteNarrationInput {
  readonly plannedUnit: PlannedNarrationUnit;
  readonly profile: VoiceProfile;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
  readonly fence?: RuntimeFence;
}

export interface OrchestratedVoiceAsset {
  readonly asset: VoiceAssetMetadata;
  readonly audio_bytes: Buffer;
  readonly alignment: NormalizedAlignment;
  readonly cache_hit: boolean;
  readonly attempt_count: number;
  readonly delays_ms: readonly number[];
  readonly stale: boolean;
}

export interface VoiceExecutionOrchestratorOptions {
  readonly cache?: VoiceCache;
  readonly normalizer?: VoiceAssetNormalizer;
  readonly providerResolver?: (family: string) => VoiceProvider;
  readonly concurrencyLimiter?: ConcurrencyLimiter;
  readonly concurrencyOptions?: ConcurrencyLimiterOptions;
  readonly retryOrchestrator?: VoiceRetryOrchestrator;
  readonly retryConfig?: RetryPolicyConfig;
  readonly initialFence?: RuntimeFence;
}

export class VoiceExecutionOrchestrator {
  readonly cache: VoiceCache;
  readonly normalizer: VoiceAssetNormalizer;
  readonly concurrencyLimiter: ConcurrencyLimiter;
  readonly retryOrchestrator: VoiceRetryOrchestrator;
  private readonly providerResolver: (family: string) => VoiceProvider;

  /** Active runtime fence. */
  private currentFence: RuntimeFence | null;

  /** Single-flight deduplication map keyed by canonical cache_key. */
  private readonly inFlight = new Map<string, Promise<OrchestratedVoiceAsset>>();

  /** Set of AbortControllers for active operations (for cancellation & shutdown). */
  private readonly activeControllers = new Set<AbortController>();

  /** Set of active promises currently running (for graceful shutdown draining). */
  private readonly activeTasks = new Set<Promise<unknown>>();

  private shuttingDown = false;
  private isClosed = false;

  constructor(options?: VoiceExecutionOrchestratorOptions) {
    this.cache = options?.cache ?? new VoiceCache();
    this.normalizer = options?.normalizer ?? new VoiceAssetNormalizer();
    this.providerResolver = options?.providerResolver ?? resolveVoiceProvider;
    this.concurrencyLimiter =
      options?.concurrencyLimiter ?? new ConcurrencyLimiter(options?.concurrencyOptions);
    this.retryOrchestrator =
      options?.retryOrchestrator ?? new VoiceRetryOrchestrator(options?.retryConfig);
    this.currentFence = options?.initialFence ?? null;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get activeTaskCount(): number {
    return this.activeTasks.size;
  }

  getActiveFence(): RuntimeFence | null {
    return this.currentFence ? { ...this.currentFence } : null;
  }

  /**
   * Rotates or updates the active runtime fence (e.g. on P8 reset).
   * Aborts active in-flight operations that were bound to a previous generation.
   */
  async rotateFence(newFence: RuntimeFence): Promise<void> {
    this.currentFence = { ...newFence };

    // Abort active operations to prevent stale results from continuing
    for (const controller of this.activeControllers) {
      try {
        controller.abort();
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Bounded graceful shutdown:
   * 1. Stops accepting new operations.
   * 2. Clears concurrency queue (waiters throw CANCELLED).
   * 3. Signals active controllers to abort.
   * 4. Bounded wait (<= 5,000 ms) for active tasks to settle.
   * 5. Idempotent: Calling twice is safe.
   */
  async shutdown(timeoutMs = GRACEFUL_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.isClosed) {
      return;
    }
    this.shuttingDown = true;

    // 1. Clear concurrency queue
    this.concurrencyLimiter.clearQueue("Voice subsystem shutdown");

    // 2. Abort all active operations
    for (const controller of this.activeControllers) {
      try {
        controller.abort();
      } catch {
        // Ignore
      }
    }

    // 3. Bounded wait for active tasks
    if (this.activeTasks.size > 0) {
      const allTasks = Promise.allSettled(Array.from(this.activeTasks));
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(resolve, Math.max(0, timeoutMs));
      });

      await Promise.race([allTasks, timeoutPromise]);
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }

    this.isClosed = true;
  }

  /**
   * Main synthesis orchestration entrypoint.
   */
  async synthesizeUnit(input: ExecuteNarrationInput): Promise<OrchestratedVoiceAsset> {
    if (this.shuttingDown || this.isClosed) {
      throw new VoiceProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message: "Voice subsystem is shutting down; rejecting new synthesis requests",
        provider_identity: {
          provider_family: input.profile.provider_family,
          provider_model: input.profile.provider_model,
          provider_voice_id: input.profile.provider_voice_id,
        },
      });
    }

    const { plannedUnit, profile, signal, fence } = input;
    const cacheKey = plannedUnit.cache_key;

    // Check immediate caller cancellation
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
      const result = await existingFlight;
      const isStale = this.checkIfStale(fence);
      return {
        ...result,
        stale: isStale,
      };
    }

    // 2. Cache-first inspection (BEFORE acquiring concurrency or queueing)
    const inspectResult = await this.cache.inspect(cacheKey);
    if (inspectResult.hit) {
      const isStale = this.checkIfStale(fence);
      return {
        asset: inspectResult.asset,
        audio_bytes: inspectResult.audioBytes,
        alignment: inspectResult.alignment,
        cache_hit: true,
        attempt_count: 0,
        delays_ms: [],
        stale: isStale,
      };
    }

    if (inspectResult.reason === "CORRUPT") {
      // 1x bounded eviction before regenerating
      await this.cache.evict(cacheKey);
    }

    // 3. Register single-flight promise
    const flightPromise = this.executeSynthesisFlight(input);
    this.inFlight.set(cacheKey, flightPromise);

    const trackedTask = flightPromise.then(
      () => {},
      () => {},
    );
    this.activeTasks.add(trackedTask);

    try {
      const result = await flightPromise;
      return result;
    } finally {
      this.inFlight.delete(cacheKey);
      this.activeTasks.delete(trackedTask);
    }
  }

  private async executeSynthesisFlight(input: ExecuteNarrationInput): Promise<OrchestratedVoiceAsset> {
    const { plannedUnit, profile, signal, fence } = input;
    const cacheKey = plannedUnit.cache_key;

    const providerIdentity = {
      provider_family: profile.provider_family,
      provider_model: profile.provider_model,
      provider_voice_id: profile.provider_voice_id,
    };

    // Internal abort controller for lifecycle management and caller cancellation
    const internalController = new AbortController();
    this.activeControllers.add(internalController);

    const onCallerAbort = () => {
      internalController.abort();
    };
    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const effectiveSignal = internalController.signal;

    // Resolve provider adapter
    let provider: VoiceProvider;
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

    // Check fallback cache safety: provider must match planned profile
    const expectedKey = deriveCacheKey(
      createCacheIdentityPayload(plannedUnit.normalized_text, profile),
    );

    if (expectedKey !== cacheKey) {
      throw new VoiceProviderError({
        code: "CONFIG_INVALID",
        message: "Provider profile mismatch with planned cache identity",
        provider_identity: providerIdentity,
      });
    }

    // Step A: Acquire concurrency slot (consumes quota during provider call only)
    let slot;
    try {
      slot = await this.concurrencyLimiter.acquire(profile.provider_family, effectiveSignal);
    } catch (err) {
      this.cleanupController(internalController, signal, onCallerAbort);
      throw err;
    }

    // Step B: Execute Provider Synthesis with bounded retry orchestrator
    const rawRequestId = input.requestId ?? `req-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const synthesisRequest = createPlannedSynthesisRequest(plannedUnit, profile, rawRequestId);

    let providerResult: ProviderSynthesisResult;
    let retryAttempts = 0;
    let retryDelays: number[] = [];

    try {
      const retryOutcome = await this.retryOrchestrator.executeWithRetry(
        async (_attemptNumber) => {
          if (effectiveSignal.aborted) {
            throw new VoiceProviderError({
              code: "CANCELLED",
              message: "Synthesis cancelled before provider call",
              provider_identity: providerIdentity,
            });
          }
          return await provider.synthesize(synthesisRequest, effectiveSignal);
        },
        {
          signal: effectiveSignal,
          fallbackIdentity: providerIdentity,
        },
      );
      providerResult = retryOutcome.result;
      retryAttempts = retryOutcome.record.attempt_count;
      retryDelays = retryOutcome.record.delays_ms;
    } catch (err: unknown) {
      if (err instanceof VoiceProviderError) {
        throw err;
      }
      throw new VoiceProviderError({
        code: effectiveSignal.aborted ? "CANCELLED" : "SYNTHESIS_FAILED",
        message: err instanceof Error ? err.message : String(err),
        provider_identity: providerIdentity,
        cause: err,
      });
    } finally {
      // Release provider concurrency slot immediately upon provider completion
      slot.release();
    }

    // Step C: Audio Normalization (Local CPU, does not hold provider concurrency slot)
    if (effectiveSignal.aborted) {
      this.cleanupController(internalController, signal, onCallerAbort);
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: "Synthesis cancelled after provider output",
        provider_identity: providerIdentity,
      });
    }

    let normResult;
    try {
      normResult = await this.normalizer.normalize(
        providerResult.audio_bytes,
        providerResult.alignment,
        {
          signal: effectiveSignal,
          inputSampleRate: providerResult.sample_rate_hz,
          inputChannels: providerResult.channels,
        },
      );
    } catch (err: unknown) {
      this.cleanupController(internalController, signal, onCallerAbort);
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
        code: effectiveSignal.aborted ? "CANCELLED" : "NORMALIZATION_FAILED",
        message: `Audio normalization failed: ${err instanceof Error ? err.message : String(err)}`,
        provider_identity: providerIdentity,
        cause: err,
      });
    }

    // Step D: Validate VoiceAssetMetadata
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
      this.cleanupController(internalController, signal, onCallerAbort);
      throw new VoiceProviderError({
        code: "VALIDATION_FAILED",
        message: `Generated VoiceAsset metadata contract violation: ${err instanceof Error ? err.message : String(err)}`,
        provider_identity: providerIdentity,
        cause: err,
      });
    }

    // Step E: Atomic publication into immutable cache
    try {
      await this.cache.publish(
        cacheKey,
        metadata,
        normResult.canonical_wav,
        normResult.alignment,
      );
    } catch (err: unknown) {
      this.cleanupController(internalController, signal, onCallerAbort);
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

    this.cleanupController(internalController, signal, onCallerAbort);

    // Step F: Content Acceptance vs Active Runtime Acceptance
    // If cancelled AFTER valid atomic publication: content cache is preserved,
    // but caller receives cancellation error or stale status.
    if (signal?.aborted) {
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: "Operation cancelled after cache publication",
        provider_identity: providerIdentity,
      });
    }

    const isStale = this.checkIfStale(fence);

    return {
      asset: metadata,
      audio_bytes: normResult.canonical_wav,
      alignment: normResult.alignment,
      cache_hit: false,
      attempt_count: retryAttempts,
      delays_ms: retryDelays,
      stale: isStale,
    };
  }

  private checkIfStale(fence?: RuntimeFence): boolean {
    if (!fence || !this.currentFence) {
      return false;
    }
    if (fence.runtime_session_id !== this.currentFence.runtime_session_id) {
      return true;
    }
    if (fence.generation !== this.currentFence.generation) {
      return true;
    }
    if (fence.lesson_id && this.currentFence.lesson_id && fence.lesson_id !== this.currentFence.lesson_id) {
      return true;
    }
    return false;
  }

  private cleanupController(
    controller: AbortController,
    signal?: AbortSignal,
    abortHandler?: () => void,
  ): void {
    this.activeControllers.delete(controller);
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
