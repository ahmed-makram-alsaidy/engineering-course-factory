// P10.2 Voice Provider Interface & Canonical Provider-Neutral Contracts
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Establishes the provider-neutral abstraction boundary:
// - VoiceProvider interface (probeCapabilities, synthesize, cancel)
// - ProviderIdentity (family, model, voice_id — strictly no credentials/endpoints)
// - ProviderCapabilities (supported locales, alignment modes, limits)
// - ProviderSynthesisResult (audio bytes Buffer, media descriptors, alignment)
// - VoiceProviderError (unified failure taxonomy, retry classification, retry-after)
// - Maximum provider response byte bound (32 MiB)
//
// Raw provider output boundary: providers output raw audio data. Normalization
// into immutable cached assets is strictly owned by the P10.4 pipeline.
// Zero provider SDKs, zero cloud vendor lock-in, zero credentials.

import { z } from "zod";
import {
  AUDIO_CHANNELS,
  AUDIO_CONTAINER,
  AUDIO_SAMPLE_RATE_HZ,
  MAX_AUDIO_SAMPLE_COUNT,
  MAX_NARRATION_DURATION_US,
  MIN_AUDIO_SAMPLE_COUNT,
  MIN_NARRATION_DURATION_US,
  durationUsForSampleCount,
} from "./audio-clock.ts";
import {
  type AlignmentStatus,
  AlignmentStatusSchema,
  type NormalizedAlignment,
  NormalizedAlignmentSchema,
  type SupportedLocale,
  SupportedLocaleSchema,
  type SynthesisRequest,
  type SynthesisResultDescriptor,
  SynthesisResultDescriptorSchema,
  VOICE_TIMEOUTS,
  type VoiceFailureCode,
  VoiceFailureCodeSchema,
  type VoiceIdentifier,
  VoiceIdentifierSchema,
  type VoiceRetryClassification,
  VoiceRetryClassificationSchema,
  classifyVoiceFailureCode,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Provider Response Bounds Constants
// ---------------------------------------------------------------------------

/**
 * Maximum allowed provider response size in bytes: 32 MiB (33,554,432 bytes).
 * Rationale: 300 s of 48 kHz mono 16-bit PCM = 28,800,000 bytes.
 * 32 MiB provides ample headroom for WAV headers or uncompressed data
 * while strictly bounding memory consumption.
 */
export const MAX_PROVIDER_RESPONSE_BYTES = 33_554_432 as const; // 32 MiB

/** Maximum allowed retry_after_ms delay: 30,000 ms (30 seconds). */
export const MAX_RETRY_AFTER_MS = 30_000 as const;

// ---------------------------------------------------------------------------
// Voice Provider Identity
// ---------------------------------------------------------------------------

/**
 * Strict Voice Provider Identity contract.
 * Represents configuration and provenance identity only.
 * Strictly forbids credentials, secrets, endpoint URLs, and network paths.
 */
export const ProviderIdentitySchema = z.strictObject({
  provider_family: VoiceIdentifierSchema,
  provider_model: VoiceIdentifierSchema,
  provider_voice_id: VoiceIdentifierSchema,
});
export type ProviderIdentity = z.infer<typeof ProviderIdentitySchema>;

// ---------------------------------------------------------------------------
// Provider Capabilities
// ---------------------------------------------------------------------------

/**
 * Typed provider capability descriptor.
 * Describes static or probed synthesis capabilities in a vendor-neutral schema.
 */
export const ProviderCapabilitiesSchema = z.strictObject({
  provider_family: VoiceIdentifierSchema,
  supported_locales: z.array(SupportedLocaleSchema).min(1).readonly(),
  alignment_support: AlignmentStatusSchema,
  supports_word_alignment: z.boolean(),
  supports_phoneme_alignment: z.boolean(),
  supports_cancellation: z.boolean(),
  supports_idempotency_key: z.boolean(),
  max_characters_per_request: z.number().int().positive(),
  sample_rates: z.array(z.number().int().positive()).min(1).readonly(),
  channels: z.array(z.number().int().positive()).min(1).readonly(),
  output_formats: z.array(z.string().min(1)).min(1).readonly(),
  supports_rate_control: z.boolean(),
  supports_pitch_control: z.boolean(),
  supports_style_control: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Provider Synthesis Result
// ---------------------------------------------------------------------------

/**
 * Provider-neutral synthesis result carrying raw audio payload Buffer,
 * canonical descriptor metadata, and optional alignment marks.
 */
export interface ProviderSynthesisResult {
  readonly audio_bytes: Buffer;
  readonly descriptor: SynthesisResultDescriptor;
  readonly alignment: NormalizedAlignment;

  // Convenience accessors mirroring descriptor fields
  readonly provider_family: VoiceIdentifier;
  readonly provider_model: VoiceIdentifier;
  readonly provider_voice_id: VoiceIdentifier;
  readonly provider_request_id: VoiceIdentifier;
  readonly format: typeof AUDIO_CONTAINER;
  readonly sample_rate_hz: typeof AUDIO_SAMPLE_RATE_HZ;
  readonly channels: typeof AUDIO_CHANNELS;
  readonly sample_count: number;
  readonly duration_us: number;
  readonly alignment_status: AlignmentStatus;
  readonly characters_billed?: number;
  readonly latency_ms?: number;
}

// ---------------------------------------------------------------------------
// Unified Voice Provider Error
// ---------------------------------------------------------------------------

export interface VoiceProviderErrorOptions {
  readonly code: VoiceFailureCode;
  readonly message: string;
  readonly provider_identity: ProviderIdentity;
  readonly retry_after_ms?: number;
  readonly cause?: unknown;
}

/**
 * Canonical error type thrown across provider boundaries.
 * Sanitizes messages to prevent secret leakage (API tokens, headers, auth query params).
 */
export class VoiceProviderError extends Error {
  readonly code: VoiceFailureCode;
  readonly retry_classification: VoiceRetryClassification;
  readonly provider_identity: ProviderIdentity;
  readonly retry_after_ms?: number;

  constructor(options: VoiceProviderErrorOptions) {
    const sanitizedMessage = sanitizeErrorMessage(options.message);
    super(sanitizedMessage);
    this.name = "VoiceProviderError";
    this.code = options.code;
    this.retry_classification = classifyVoiceFailureCode(options.code);
    this.provider_identity = Object.freeze({ ...options.provider_identity });

    if (options.retry_after_ms !== undefined) {
      this.retry_after_ms = Math.max(0, Math.min(MAX_RETRY_AFTER_MS, Math.floor(options.retry_after_ms)));
    }

    if (options.cause !== undefined) {
      this.cause = options.cause;
    }

    // Freeze instance to prevent post-creation modification
    Object.freeze(this);
  }
}

/**
 * Sanitizes error messages by scrubbing potential API keys, bearer tokens, and secrets.
 */
function sanitizeErrorMessage(msg: string): string {
  if (typeof msg !== "string") return "Unknown provider error";
  return msg
    .replace(/(?:api[_-]?key|bearer|token|secret|password|auth)[:=\s]+[A-Za-z0-9._~+/-]{8,}/gi, "[REDACTED_SECRET]")
    .replace(/https?:\/\/[^\s]+/gi, "[REDACTED_URL]");
}

// ---------------------------------------------------------------------------
// Provider Synthesis Result Validator
// ---------------------------------------------------------------------------

/**
 * Structurally validates a ProviderSynthesisResult against canonical contracts.
 * Enforces size limits, duration invariant, and monotonic alignment bounds.
 */
export function validateProviderSynthesisResult(result: ProviderSynthesisResult): void {
  if (!result || typeof result !== "object") {
    throw new Error("[PROVIDER_RESULT_INVALID] Result must be a non-null object");
  }

  if (!Buffer.isBuffer(result.audio_bytes)) {
    throw new Error("[PROVIDER_RESULT_INVALID] audio_bytes must be a Node.js Buffer");
  }

  if (result.audio_bytes.length === 0) {
    throw new Error("[PROVIDER_RESULT_EMPTY] audio_bytes Buffer is empty (0 bytes)");
  }

  if (result.audio_bytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error(
      `[PROVIDER_RESULT_SIZE_EXCEEDED] audio_bytes length ${result.audio_bytes.length} bytes exceeds maximum allowed limit ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
    );
  }

  // Validate descriptor schema
  SynthesisResultDescriptorSchema.parse(result.descriptor);

  // Validate alignment container
  NormalizedAlignmentSchema.parse(result.alignment);

  // Cross-check alignment status
  if (result.alignment.status !== result.alignment_status) {
    throw new Error(
      `[ALIGNMENT_STATUS_MISMATCH] descriptor status '${result.alignment_status}' does not match container status '${result.alignment.status}'`,
    );
  }

  // Cross-check duration invariant
  const expectedDurationUs = durationUsForSampleCount(result.sample_count);
  if (result.duration_us !== expectedDurationUs) {
    throw new Error(
      `[DURATION_INVARIANT_VIOLATION] duration_us (${result.duration_us}) must match exact rational formula (${expectedDurationUs})`,
    );
  }

  // Validate word mark sequence monotonicity and sample bounds
  let prevEnd = 0;
  for (let i = 0; i < result.alignment.words.length; i++) {
    const mark = result.alignment.words[i];
    if (mark.start_sample < prevEnd) {
      throw new Error(
        `[ALIGNMENT_NON_MONOTONIC] Word mark ordinal ${mark.ordinal} starts at ${mark.start_sample} which precedes previous end ${prevEnd}`,
      );
    }
    if (mark.end_sample > result.sample_count) {
      throw new Error(
        `[ALIGNMENT_OUT_OF_BOUNDS] Word mark ordinal ${mark.ordinal} ends at ${mark.end_sample} which exceeds sample_count ${result.sample_count}`,
      );
    }
    prevEnd = mark.end_sample;
  }
}

// ---------------------------------------------------------------------------
// Provider-Neutral VoiceProvider Interface
// ---------------------------------------------------------------------------

/**
 * Canonical provider-neutral synthesis interface.
 * All P10 synthesis operations MUST depend solely on this interface.
 * Concrete vendor adapters must implement this contract.
 */
export interface VoiceProvider {
  /** Provider family identifier (e.g. "fake", "openai", "elevenlabs"). */
  readonly family: string;

  /**
   * Probes provider capabilities and operational status.
   * Bound by VOICE_TIMEOUTS.probe_ms (5,000 ms).
   */
  probeCapabilities(): Promise<ProviderCapabilities>;

  /**
   * Synthesizes audio for a canonical SynthesisRequest.
   * Bound by VOICE_TIMEOUTS.synthesis_ms (30,000 ms).
   * Respects AbortSignal for prompt cancellation.
   */
  synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<ProviderSynthesisResult>;

  /**
   * Cancels an in-flight synthesis operation by its request_id.
   * Idempotent: returns cleanly if the operation is already finished or unknown.
   */
  cancel(requestId: string): Promise<void>;
}
