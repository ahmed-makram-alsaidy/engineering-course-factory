// P10.1 Voice Manifest 1.0 Schema & Builder Contract
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 27 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Defines the authoritative VoiceManifest version 1.0 schema, cue entries,
// audio summaries, publication invariants, canonical builder, and strict parser.
//
// Manifest describes generated lesson voice assets BEFORE live runtime execution:
//   - Identifies lesson and compiled source digest
//   - Links each authored narration step to its normalized 48 kHz audio asset
//   - Bridges authored cues to future P10.5 / P9 video sync via unbound sync state
//   - Strictly excludes volatile runtime sessions, generation counters, take IDs,
//     HWNDs, PIDs, provider credentials, and machine-absolute paths.

import { z } from "zod";
import {
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
import { canonicalJsonPretty } from "./canonical.ts";
import {
  AlignmentStatusSchema,
  CacheKeySchema,
  CourseIdSchema,
  LessonIdSchema,
  MAX_VOICE_MANIFEST_BYTES,
  SceneIdSchema,
  Sha256HexSchema,
  StepIdSchema,
  SupportedLocaleSchema,
  VOICE_MANIFEST_VERSION,
  VOICE_PROTOCOL_VERSION,
  VoiceIdentifierSchema,
  VoiceManifestVersionSchema,
  VoiceProtocolVersionSchema,
  VoiceUnitIdSchema,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Path Safety Check for Alignment References (POSIX project-relative only)
// ---------------------------------------------------------------------------

function validateProjectRelativePath(val: string, ctx: z.RefinementCtx, field: string): void {
  if (val.includes("\\")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `[PATH_NOT_PROJECT_RELATIVE] ${field} must not contain backslashes: '${val}'`,
    });
  }
  if (/^[A-Za-z]:/.test(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `[PATH_NOT_PROJECT_RELATIVE] ${field} must not contain drive letters: '${val}'`,
    });
  }
  if (val.startsWith("/")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `[PATH_NOT_PROJECT_RELATIVE] ${field} must not start with root slash: '${val}'`,
    });
  }
  if (val.split("/").includes("..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `[PATH_NOT_PROJECT_RELATIVE] ${field} must not contain traversal segments: '${val}'`,
    });
  }
}

// ---------------------------------------------------------------------------
// Voice Manifest Cue Schema (Authored Step -> Normalized Audio Asset)
// ---------------------------------------------------------------------------

/**
 * Sync state placeholder for future P10.5 timeline integration.
 * In P10.1, the manifest describes audio before live take recording,
 * so sync is explicitly "unbound" rather than a fabricated timestamp.
 */
export const CueSyncStateSchema = z.literal("unbound");
export type CueSyncState = z.infer<typeof CueSyncStateSchema>;

/**
 * One cue entry in the VoiceManifest.
 * Connects an authored narration step to its validated, normalized 48 kHz voice asset.
 */
export const VoiceManifestCueSchema = z
  .strictObject({
    step_id: StepIdSchema,
    scene_id: SceneIdSchema,
    ordinal: z.number().int().positive(),
    voice_unit_id: VoiceUnitIdSchema,
    cache_key: CacheKeySchema,
    audio_asset_digest: Sha256HexSchema,
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
    alignment_ref: z
      .string()
      .min(1)
      .max(256)
      .optional(),
    pause_before_seconds: z.number().int().nonnegative().optional(),
    pause_after_seconds: z.number().int().nonnegative().optional(),
    sync_state: CueSyncStateSchema.default("unbound"),
  })
  .superRefine((val, ctx) => {
    const expectedDuration = durationUsForSampleCount(val.sample_count);
    if (val.duration_us !== expectedDuration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["duration_us"],
        message: `[CUE_DURATION_MISMATCH] cue duration_us (${val.duration_us}) must match sample_count (${expectedDuration})`,
      });
    }
    if (val.alignment_ref !== undefined) {
      validateProjectRelativePath(val.alignment_ref, ctx, "alignment_ref");
    }
  });
export type VoiceManifestCue = z.infer<typeof VoiceManifestCueSchema>;

// ---------------------------------------------------------------------------
// Voice Manifest Audio Summary Schema
// ---------------------------------------------------------------------------

export const VoiceManifestAudioSummarySchema = z
  .strictObject({
    format: z.literal(AUDIO_CONTAINER),
    sample_rate_hz: z.literal(AUDIO_SAMPLE_RATE_HZ),
    channels: z.literal(AUDIO_CHANNELS),
    sample_format: z.literal(AUDIO_SAMPLE_FORMAT),
    total_samples: z.number().int().nonnegative(),
    total_duration_us: z.number().int().nonnegative(),
    cue_count: z.number().int().positive(),
  })
  .superRefine((val, ctx) => {
    const expectedDuration = durationUsForSampleCount(val.total_samples);
    if (val.total_duration_us !== expectedDuration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["total_duration_us"],
        message: `[TOTAL_DURATION_MISMATCH] total_duration_us (${val.total_duration_us}) must match total_samples (${expectedDuration})`,
      });
    }
  });
export type VoiceManifestAudioSummary = z.infer<typeof VoiceManifestAudioSummarySchema>;

// ---------------------------------------------------------------------------
// Voice Manifest Schema 1.0 (Canonical Document)
// ---------------------------------------------------------------------------

export const VoiceManifestSchema = z
  .strictObject({
    manifest_version: VoiceManifestVersionSchema,
    protocol_version: VoiceProtocolVersionSchema,
    lesson_id: LessonIdSchema,
    course_id: CourseIdSchema,
    compiled_digest: Sha256HexSchema,
    voice_profile_id: VoiceIdentifierSchema,
    locale: SupportedLocaleSchema,
    provider_family: VoiceIdentifierSchema,
    provider_model: VoiceIdentifierSchema,
    audio: VoiceManifestAudioSummarySchema,
    cues: z.array(VoiceManifestCueSchema).min(1),
  })
  .superRefine((val, ctx) => {
    // 1. Invariant: audio.cue_count == cues.length
    if (val.audio.cue_count !== val.cues.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audio", "cue_count"],
        message: `[CUE_COUNT_MISMATCH] audio.cue_count (${val.audio.cue_count}) must equal cues.length (${val.cues.length})`,
      });
    }

    // 2. Invariant: audio.total_samples == sum of cue sample counts
    const computedTotalSamples = val.cues.reduce((acc, cue) => acc + cue.sample_count, 0);
    if (val.audio.total_samples !== computedTotalSamples) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["audio", "total_samples"],
        message: `[TOTAL_SAMPLES_MISMATCH] audio.total_samples (${val.audio.total_samples}) must equal sum of cue samples (${computedTotalSamples})`,
      });
    }

    // 3. Invariant: Ordinals must be strictly increasing 1..N
    for (let i = 0; i < val.cues.length; i++) {
      const cue = val.cues[i];
      if (cue && cue.ordinal !== i + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cues", i, "ordinal"],
          message: `[ORDINAL_SEQUENCE_INVALID] cue[${i}].ordinal must be ${i + 1}, received: ${cue ? cue.ordinal : undefined}`,
        });
      }
    }
  });
export type VoiceManifest = z.infer<typeof VoiceManifestSchema>;

// ---------------------------------------------------------------------------
// Canonical Builder & Parser API
// ---------------------------------------------------------------------------

export interface BuildVoiceManifestInput {
  readonly lesson_id: string;
  readonly course_id: string;
  readonly compiled_digest: string;
  readonly voice_profile_id: string;
  readonly locale: "ar-EG" | "ar-SA" | "en-US" | "en-GB";
  readonly provider_family: string;
  readonly provider_model: string;
  readonly cues: readonly VoiceManifestCue[];
}

/**
 * Builds and validates a canonical VoiceManifest 1.0 document.
 * Automatically computes audio summary fields (total_samples, total_duration_us, cue_count)
 * and verifies size bounds.
 */
export function buildVoiceManifest(input: BuildVoiceManifestInput): VoiceManifest {
  const totalSamples = input.cues.reduce((acc, cue) => acc + cue.sample_count, 0);
  const totalDurationUs = durationUsForSampleCount(totalSamples);

  const rawManifest = {
    manifest_version: VOICE_MANIFEST_VERSION,
    protocol_version: VOICE_PROTOCOL_VERSION,
    lesson_id: input.lesson_id,
    course_id: input.course_id,
    compiled_digest: input.compiled_digest,
    voice_profile_id: input.voice_profile_id,
    locale: input.locale,
    provider_family: input.provider_family,
    provider_model: input.provider_model,
    audio: {
      format: AUDIO_CONTAINER,
      sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
      channels: AUDIO_CHANNELS,
      sample_format: AUDIO_SAMPLE_FORMAT,
      total_samples: totalSamples,
      total_duration_us: totalDurationUs,
      cue_count: input.cues.length,
    },
    cues: [...input.cues],
  };

  const parsed = VoiceManifestSchema.parse(rawManifest);

  // Validate serialized size bound
  const serialized = serializeVoiceManifest(parsed);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > MAX_VOICE_MANIFEST_BYTES) {
    throw new RangeError(
      `[MANIFEST_SIZE_EXCEEDED] serialized manifest size (${byteLength} bytes) exceeds limit (${MAX_VOICE_MANIFEST_BYTES} bytes)`,
    );
  }

  return parsed;
}

/**
 * Parses and validates a JSON string into a canonical VoiceManifest 1.0 document.
 * Rejects unknown fields, invalid versions, and corrupted data.
 */
export function parseVoiceManifest(jsonString: string): VoiceManifest {
  if (typeof jsonString !== "string") {
    throw new TypeError("[MANIFEST_PARSE_ERROR] jsonString must be a string");
  }

  const byteLength = Buffer.byteLength(jsonString, "utf8");
  if (byteLength > MAX_VOICE_MANIFEST_BYTES) {
    throw new RangeError(
      `[MANIFEST_SIZE_EXCEEDED] input JSON size (${byteLength} bytes) exceeds limit (${MAX_VOICE_MANIFEST_BYTES} bytes)`,
    );
  }

  if (jsonString.trim().length === 0) {
    throw new TypeError("[MANIFEST_PARSE_ERROR] jsonString must be a non-empty string");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonString);
  } catch (err) {
    throw new TypeError(
      `[MANIFEST_PARSE_ERROR] malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return VoiceManifestSchema.parse(raw);
}

/**
 * Serializes a canonical VoiceManifest to a formatted, deterministic UTF-8 JSON string.
 */
export function serializeVoiceManifest(manifest: VoiceManifest): string {
  const validated = VoiceManifestSchema.parse(manifest);
  return canonicalJsonPretty(validated);
}
