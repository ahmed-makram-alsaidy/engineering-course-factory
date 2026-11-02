// P10.1 Voice Protocol — voice_protocol_version = "v1"
//
// Canonical authority: docs/P10-DESIGN-SPEC.md and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Contract-only: Voice Protocol v1, canonical versions, bounded safe identifiers,
// supported locales, VoiceProfile schema, NarrationUnit schema, alignment types,
// VoiceAsset metadata, SynthesisRequest/Result contracts, failure taxonomy with
// retry classifications, frozen timeouts, and active-runtime fence types.
// Zero provider SDKs, zero FFmpeg execution, zero filesystem writes, zero IPC.

import { z } from "zod";
import {
  AUDIO_BITS_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_CONTAINER,
  AUDIO_SAMPLE_FORMAT,
  AUDIO_SAMPLE_RATE_HZ,
  MAX_AUDIO_SAMPLE_COUNT,
  MAX_NARRATION_DURATION_US,
  MIN_AUDIO_SAMPLE_COUNT,
  MIN_NARRATION_DURATION_US,
  durationUsForSampleCount,
} from "./audio-clock.ts";

// ---------------------------------------------------------------------------
// Protocol & Contract Versions (Frozen)
// ---------------------------------------------------------------------------

/** Voice Protocol version: "v1" (frozen contract authority). */
export const VOICE_PROTOCOL_VERSION = "v1" as const;
export const VoiceProtocolVersionSchema = z.literal(VOICE_PROTOCOL_VERSION);
export type VoiceProtocolVersion = z.infer<typeof VoiceProtocolVersionSchema>;

/** Voice Manifest schema version: "1.0" (independently evolvable from protocol). */
export const VOICE_MANIFEST_VERSION = "1.0" as const;
export const VoiceManifestVersionSchema = z.literal(VOICE_MANIFEST_VERSION);
export type VoiceManifestVersion = z.infer<typeof VoiceManifestVersionSchema>;

/** Text normalization rules version: "1.0" (frozen initial value). */
export const TEXT_NORMALIZATION_VERSION = "1.0" as const;
export const TextNormalizationVersionSchema = z.string().regex(/^\d+\.\d+$/);
export type TextNormalizationVersion = z.infer<typeof TextNormalizationVersionSchema>;

/** Audio mastering/normalization pipeline version: "1.0" (frozen initial value). */
export const AUDIO_NORMALIZATION_VERSION = "1.0" as const;
export const AudioNormalizationVersionSchema = z.string().regex(/^\d+\.\d+$/);
export type AudioNormalizationVersion = z.infer<typeof AudioNormalizationVersionSchema>;

/** Voice contract specification version: "1.0" (frozen initial value). */
export const VOICE_CONTRACT_VERSION = "1.0" as const;
export const VoiceContractVersionSchema = z.string().regex(/^\d+\.\d+$/);
export type VoiceContractVersion = z.infer<typeof VoiceContractVersionSchema>;

/** Voice Protocol version 1.1 additive extension (natural-language delivery steering). */
export const VOICE_PROTOCOL_VERSION_1_1 = "v1.1" as const;

/** Voice contract specification version 1.1 (additive delivery profile extension). */
export const VOICE_CONTRACT_VERSION_1_1 = "1.1" as const;

// ---------------------------------------------------------------------------
// Canonical Bounds Constants (P10-DESIGN-SPEC Section 5, 26, 29)
// ---------------------------------------------------------------------------

/** Maximum length for string identifiers. */
export const MAX_VOICE_IDENTIFIER_LENGTH = 128 as const;

/** Maximum length for authored narration text: 10,000 characters. */
export const MAX_AUTHORED_TEXT_LENGTH = 10_000 as const;

/** Maximum length for profile descriptions. */
export const MAX_DESCRIPTION_LENGTH = 256 as const;

/** Maximum manifest serialized size: 64 KiB (UTF-8 bytes). */
export const MAX_VOICE_MANIFEST_BYTES = 65_536 as const;

// ---------------------------------------------------------------------------
// Core Bounded Identifiers (Safe: no paths, no traversal, no credentials)
// ---------------------------------------------------------------------------

/** Bounded safe identifier: 1-128 chars, [A-Za-z0-9._-], starts with alphanumeric. */
export const VoiceIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_VOICE_IDENTIFIER_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export type VoiceIdentifier = z.infer<typeof VoiceIdentifierSchema>;

/** Course identifier (e.g. "C01"). */
export const CourseIdSchema = z.string().regex(/^C\d{2}$/);
export type CourseId = z.infer<typeof CourseIdSchema>;

/** Lesson identifier (e.g. "C01-L003"). */
export const LessonIdSchema = z.string().regex(/^C\d{2}-L\d{3}$/);
export type LessonId = z.infer<typeof LessonIdSchema>;

/** Scene identifier (e.g. "C01-L003-S014"). */
export const SceneIdSchema = z.string().regex(/^C\d{2}-L\d{3}-S\d{3}$/);
export type SceneId = z.infer<typeof SceneIdSchema>;

/** Step identifier (authored beat ID e.g. "C01-L003-S014-B001" or derived step ID). */
export const StepIdSchema = VoiceIdentifierSchema;
export type StepId = z.infer<typeof StepIdSchema>;

/**
 * Voice Unit identifier (identifies authored placement, e.g. "vu-C01-L003-S001-B001-001").
 * Distinct from CacheKey (which identifies synthesized acoustic content).
 */
export const VoiceUnitIdSchema = z
  .string()
  .min(5)
  .max(MAX_VOICE_IDENTIFIER_LENGTH)
  .regex(/^vu-[A-Za-z0-9._-]+$/);
export type VoiceUnitId = z.infer<typeof VoiceUnitIdSchema>;

/** Cache key: 64 lowercase hexadecimal characters (SHA-256 digest of cache identity). */
export const CacheKeySchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
export type CacheKey = z.infer<typeof CacheKeySchema>;

/** Standard 64-character lowercase SHA-256 hexadecimal digest. */
export const Sha256HexSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

// ---------------------------------------------------------------------------
// Supported Locales
// ---------------------------------------------------------------------------

/** Initial approved synthesis locales for Course Factory. */
export const SUPPORTED_LOCALES = ["ar-EG", "ar-SA", "en-US", "en-GB"] as const;
export const SupportedLocaleSchema = z.enum(SUPPORTED_LOCALES);
export type SupportedLocale = z.infer<typeof SupportedLocaleSchema>;

/** Bounded safe BCP-47-like locale string (allows future locales without schema break). */
export const SafeLocaleSchema = z
  .string()
  .min(2)
  .max(16)
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/);
export type SafeLocale = z.infer<typeof SafeLocaleSchema>;

// ---------------------------------------------------------------------------
// Voice Profile (Provider-Neutral Configuration)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral VoiceProfile contract v1 (frozen initial specification).
 * Represents configuration identity only; strictly forbids credentials.
 */
export const VoiceProfileV1Schema = z.strictObject({
  profile_id: VoiceIdentifierSchema,
  locale: SupportedLocaleSchema,
  gender: z.enum(["male", "female", "neutral"]),
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
  provider_family: VoiceIdentifierSchema,
  provider_voice_id: VoiceIdentifierSchema,
  provider_model: VoiceIdentifierSchema,
  rate: z.number().min(0.5).max(2.0).default(1.0),
  pitch: z.number().min(-12.0).max(12.0).default(0.0),
  style: VoiceIdentifierSchema.optional(),
  normalization_policy: VoiceIdentifierSchema.default("standard-v1"),
});
export type VoiceProfileV1 = z.infer<typeof VoiceProfileV1Schema>;

/**
 * Provider-neutral VoiceProfile contract (evolved with additive v1.1 delivery profile support).
 * Represents configuration identity only; strictly forbids credentials (API keys,
 * tokens, signed URLs, passwords).
 */
export const VoiceProfileSchema = z.strictObject({
  profile_id: VoiceIdentifierSchema,
  locale: SupportedLocaleSchema,
  gender: z.enum(["male", "female", "neutral"]),
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
  provider_family: VoiceIdentifierSchema,
  provider_voice_id: VoiceIdentifierSchema,
  provider_model: VoiceIdentifierSchema,
  rate: z.number().min(0.5).max(2.0).default(1.0),
  pitch: z.number().min(-12.0).max(12.0).default(0.0),
  style: VoiceIdentifierSchema.optional(),
  normalization_policy: VoiceIdentifierSchema.default("standard-v1"),
  // Additive v1.1 delivery profile fields (audio-affecting natural-language steering)
  delivery_profile_id: VoiceIdentifierSchema.optional(),
  delivery_prompt_version: z.string().regex(/^\d+\.\d+$/).optional(),
  delivery_prompt_digest: Sha256HexSchema.optional(),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

// ---------------------------------------------------------------------------
// Narration Unit Contract (Authored Pedagogical Unit)
// ---------------------------------------------------------------------------

/** Delivery tone values matching IR 1.0. */
export const DELIVERY_TONES = ["neutral", "enthusiastic", "calm", "serious"] as const;
export const DeliveryToneSchema = z.enum(DELIVERY_TONES);
export type DeliveryTone = z.infer<typeof DeliveryToneSchema>;

/**
 * Immutable NarrationUnit contract.
 * Represents the atomic pedagogical unit of authored narration.
 * Strictly excludes volatile runtime sessions, generation counts, take IDs,
 * wall-clock timestamps, and local machine paths.
 */
export const NarrationUnitSchema = z.strictObject({
  lesson_id: LessonIdSchema,
  scene_id: SceneIdSchema,
  step_id: StepIdSchema,
  narration_ordinal: z.number().int().positive(),
  locale: SupportedLocaleSchema,
  authored_text: z.string().min(1).max(MAX_AUTHORED_TEXT_LENGTH),
  voice_profile_id: VoiceIdentifierSchema,
  normalization_version: TextNormalizationVersionSchema.default(TEXT_NORMALIZATION_VERSION),
  speaker: z.string().min(1).max(64).optional(),
  delivery: DeliveryToneSchema.optional(),
  pause_before_seconds: z.number().int().nonnegative().optional(),
  pause_after_seconds: z.number().int().nonnegative().optional(),
});
export type NarrationUnit = z.infer<typeof NarrationUnitSchema>;

// ---------------------------------------------------------------------------
// Alignment Contracts (Optional Word & Phoneme Timing)
// ---------------------------------------------------------------------------

/** Alignment status descriptor. */
export const ALIGNMENT_STATUSES = [
  "none",
  "word",
  "phoneme",
  "word_and_phoneme",
] as const;
export const AlignmentStatusSchema = z.enum(ALIGNMENT_STATUSES);
export type AlignmentStatus = z.infer<typeof AlignmentStatusSchema>;

/** Normalized word-level timing mark (sample-domain exact authority). */
export const WordMarkSchema = z
  .strictObject({
    ordinal: z.number().int().positive(),
    word: z.string().min(1).max(128),
    start_sample: z.number().int().nonnegative(),
    end_sample: z.number().int().nonnegative(),
  })
  .refine((val) => val.start_sample <= val.end_sample, {
    message: "[ALIGNMENT_INVALID] word start_sample must be <= end_sample",
  });
export type WordMark = z.infer<typeof WordMarkSchema>;

/** Normalized phoneme-level timing mark (sample-domain exact authority). */
export const PhonemeMarkSchema = z
  .strictObject({
    ordinal: z.number().int().positive(),
    phoneme: z.string().min(1).max(32),
    start_sample: z.number().int().nonnegative(),
    end_sample: z.number().int().nonnegative(),
  })
  .refine((val) => val.start_sample <= val.end_sample, {
    message: "[ALIGNMENT_INVALID] phoneme start_sample must be <= end_sample",
  });
export type PhonemeMark = z.infer<typeof PhonemeMarkSchema>;

/** Normalized alignment data container with cross-field status enforcement. */
export const NormalizedAlignmentSchema = z
  .strictObject({
    status: AlignmentStatusSchema,
    words: z.array(WordMarkSchema).default([]),
    phonemes: z.array(PhonemeMarkSchema).default([]),
  })
  .superRefine((val, ctx) => {
    if (val.status === "none") {
      if (val.words.length > 0 || val.phonemes.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "[ALIGNMENT_STATUS_MISMATCH] status 'none' requires empty words and phonemes",
        });
      }
    } else if (val.status === "word") {
      if (val.words.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "[ALIGNMENT_STATUS_MISMATCH] status 'word' requires non-empty words array",
        });
      }
      if (val.phonemes.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "[ALIGNMENT_STATUS_MISMATCH] status 'word' requires empty phonemes array",
        });
      }
    } else if (val.status === "phoneme") {
      if (val.phonemes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "[ALIGNMENT_STATUS_MISMATCH] status 'phoneme' requires non-empty phonemes array",
        });
      }
      if (val.words.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "[ALIGNMENT_STATUS_MISMATCH] status 'phoneme' requires empty words array",
        });
      }
    } else if (val.status === "word_and_phoneme") {
      if (val.words.length === 0 || val.phonemes.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "[ALIGNMENT_STATUS_MISMATCH] status 'word_and_phoneme' requires non-empty words and phonemes",
        });
      }
    }
  });
export type NormalizedAlignment = z.infer<typeof NormalizedAlignmentSchema>;

// ---------------------------------------------------------------------------
// Voice Asset Metadata Contract
// ---------------------------------------------------------------------------

/**
 * Immutable metadata for a normalized 48 kHz voice asset.
 * Enforces the mathematical duration invariant:
 * duration_us == floor(sample_count * 125 / 6)
 */
export const VoiceAssetMetadataSchema = z
  .strictObject({
    voice_unit_id: VoiceUnitIdSchema,
    cache_key: CacheKeySchema,
    audio_asset_digest: Sha256HexSchema,
    sample_rate_hz: z.literal(AUDIO_SAMPLE_RATE_HZ),
    channels: z.literal(AUDIO_CHANNELS),
    bits_per_sample: z.literal(AUDIO_BITS_PER_SAMPLE),
    sample_format: z.literal(AUDIO_SAMPLE_FORMAT),
    sample_count: z
      .number()
      .int()
      .min(MIN_AUDIO_SAMPLE_COUNT)
      .max(MAX_AUDIO_SAMPLE_COUNT),
    duration_us: z
      .number()
      .int()
      .min(MIN_NARRATION_DURATION_US)
      .max(MAX_NARRATION_DURATION_US),
    provider_family: VoiceIdentifierSchema,
    provider_model: VoiceIdentifierSchema,
    provider_voice_id: VoiceIdentifierSchema,
    text_normalization_version: TextNormalizationVersionSchema,
    audio_normalization_version: AudioNormalizationVersionSchema,
    voice_contract_version: VoiceContractVersionSchema,
    alignment_status: AlignmentStatusSchema,
  })
  .superRefine((val, ctx) => {
    const expectedDuration = durationUsForSampleCount(val.sample_count);
    if (val.duration_us !== expectedDuration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["duration_us"],
        message: `[DURATION_INVARIANT_VIOLATION] duration_us (${val.duration_us}) must equal exact rational formula for sample_count (${expectedDuration})`,
      });
    }
  });
export type VoiceAssetMetadata = z.infer<typeof VoiceAssetMetadataSchema>;

// ---------------------------------------------------------------------------
// Provider Request & Result Contracts (Provider-Neutral Envelope)
// ---------------------------------------------------------------------------

/**
 * Provider-neutral synthesis request descriptor.
 * Contains only semantic synthesis inputs; contains zero credentials,
 * zero filesystem paths, and zero runtime session identifiers.
 */
export const SynthesisRequestSchema = z.strictObject({
  request_id: VoiceIdentifierSchema,
  cache_key: CacheKeySchema,
  normalized_text: z.string().min(1).max(MAX_AUTHORED_TEXT_LENGTH),
  locale: SupportedLocaleSchema,
  voice_profile: VoiceProfileSchema,
  request_alignment: z.boolean().default(false),
});
export type SynthesisRequest = z.infer<typeof SynthesisRequestSchema>;

/**
 * Provider synthesis result descriptor metadata (media envelope).
 */
export const SynthesisResultDescriptorSchema = z.strictObject({
  provider_family: VoiceIdentifierSchema,
  provider_model: VoiceIdentifierSchema,
  provider_voice_id: VoiceIdentifierSchema,
  provider_request_id: VoiceIdentifierSchema,
  format: z.literal(AUDIO_CONTAINER),
  sample_rate_hz: z.literal(AUDIO_SAMPLE_RATE_HZ),
  channels: z.literal(AUDIO_CHANNELS),
  sample_count: z
    .number()
    .int()
    .min(MIN_AUDIO_SAMPLE_COUNT)
    .max(MAX_AUDIO_SAMPLE_COUNT),
  duration_us: z
    .number()
    .int()
    .min(MIN_NARRATION_DURATION_US)
    .max(MAX_NARRATION_DURATION_US),
  alignment_status: AlignmentStatusSchema,
  characters_billed: z.number().int().nonnegative().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
});
export type SynthesisResultDescriptor = z.infer<typeof SynthesisResultDescriptorSchema>;

// ---------------------------------------------------------------------------
// Failure Taxonomy & Retry Classification
// ---------------------------------------------------------------------------

export const VOICE_FAILURE_CODES = [
  "CONFIG_INVALID",
  "AUTH_FAILED",
  "UNSUPPORTED_LOCALE",
  "UNSUPPORTED_VOICE",
  "TEXT_EMPTY",
  "NORMALIZATION_FAILED",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "CACHE_CORRUPT",
  "TIMEOUT",
  "SYNTHESIS_FAILED",
  "CANCELLED",
  "RESET_INTERRUPTED",
  "LOW_DISK_ABORT",
] as const;

export const VoiceFailureCodeSchema = z.enum(VOICE_FAILURE_CODES);
export type VoiceFailureCode = z.infer<typeof VoiceFailureCodeSchema>;

export const VOICE_RETRY_CLASSIFICATIONS = [
  "NON_RETRYABLE",
  "RETRYABLE",
  "UNCERTAIN_DO_NOT_BLIND_RETRY",
  "TERMINAL",
] as const;

export const VoiceRetryClassificationSchema = z.enum(VOICE_RETRY_CLASSIFICATIONS);
export type VoiceRetryClassification = z.infer<typeof VoiceRetryClassificationSchema>;

/**
 * Deterministically classifies a voice failure code into its retry category.
 */
export function classifyVoiceFailureCode(code: VoiceFailureCode): VoiceRetryClassification {
  switch (code) {
    case "CONFIG_INVALID":
    case "AUTH_FAILED":
    case "UNSUPPORTED_LOCALE":
    case "UNSUPPORTED_VOICE":
    case "TEXT_EMPTY":
    case "NORMALIZATION_FAILED":
    case "VALIDATION_FAILED":
      return "NON_RETRYABLE";

    case "RATE_LIMITED":
    case "PROVIDER_UNAVAILABLE":
    case "CACHE_CORRUPT":
      return "RETRYABLE";

    case "TIMEOUT":
    case "SYNTHESIS_FAILED":
      return "UNCERTAIN_DO_NOT_BLIND_RETRY";

    case "CANCELLED":
    case "RESET_INTERRUPTED":
    case "LOW_DISK_ABORT":
      return "TERMINAL";
  }
}

// ---------------------------------------------------------------------------
// Timeout Contract (Frozen Constants, P10-DESIGN-SPEC Section 29)
// ---------------------------------------------------------------------------

export const VOICE_TIMEOUTS = {
  probe_ms: 5_000,
  synthesis_ms: 30_000,
  download_ms: 15_000,
  normalization_ms: 10_000,
  validation_ms: 5_000,
  graceful_termination_ms: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Active-Runtime Fence Contract (Strictly Decoupled from Cache Identity)
// ---------------------------------------------------------------------------

/**
 * RuntimeFence identifies the active execution context in P8 orchestration.
 * Must NEVER enter CacheIdentityPayload: cache identity depends solely on
 * acoustic content, not volatile runtime sessions or take generation counters.
 */
export const RuntimeFenceSchema = z.strictObject({
  runtime_session_id: VoiceIdentifierSchema,
  generation: z.number().int().positive(),
  lesson_id: LessonIdSchema.optional(),
});
export type RuntimeFence = z.infer<typeof RuntimeFenceSchema>;
