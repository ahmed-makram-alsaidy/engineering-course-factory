// P10.5 Audio Timeline / P8-P9 Sync Integration
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Sections 13, 14, 15, 23, 27 and
// docs/adr/ADR-0015-voice-generation-boundary.md Sections 1, 6, 7, 14.
//
// Binds each validated narration VoiceAsset to the authoritative video timeline
// without transferring timeline authority into P10:
// - Consumes frozen P8 narration identity & order (from NarrationPlan)
// - Consumes P10.4 validated VoiceAssets (immutable content-addressed)
// - Consumes trusted P9 RuntimeJournal-derived anchors (anchors.jsonl)
// - Binds exact sample-domain coordinates via frozen integer clock arithmetic
// - Globalizes word and phoneme alignment marks to absolute timeline samples
// - Audits pause semantics to prevent double-counting of P8 runtime intervals
// - Detects sample-domain overlaps and window boundary overflows (fail-closed)
// - Computes deterministic SHA-256 timeline digest over placement facts
// - Produces composition-ready 48 kHz mono PCM16 lesson track (sample-domain)
//
// Zero cloud provider SDKs, zero video re-encode, zero final MP4 mux, zero new IPC.

import { z } from "zod";
import {
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_SAMPLES_PER_VIDEO_FRAME,
  audioTimeUsForSampleIndex,
  durationUsForSampleCount,
  sampleIndexForAudioTimeUs,
} from "./audio-clock.ts";
import { canonicalJson, canonicalJsonPretty, sha256Hex } from "./canonical.ts";
import {
  type AlignmentStatus,
  AlignmentStatusSchema,
  type CacheKey,
  CacheKeySchema,
  type CourseId,
  CourseIdSchema,
  type LessonId,
  LessonIdSchema,
  type NormalizedAlignment,
  type PhonemeMark,
  type RuntimeFence,
  RuntimeFenceSchema,
  type SceneId,
  SceneIdSchema,
  type Sha256Hex,
  Sha256HexSchema,
  type StepId,
  StepIdSchema,
  type VoiceAssetMetadata,
  type VoiceIdentifier,
  VoiceIdentifierSchema,
  type VoiceUnitId,
  VoiceUnitIdSchema,
  type WordMark,
} from "./protocol.ts";
import type { NarrationPlan, PlannedNarrationUnit } from "./narration-planner.ts";
import { buildWavHeader, parseWavHeader, WAV_HEADER_BYTES } from "./wav.ts";

// ---------------------------------------------------------------------------
// Constants & Versioning
// ---------------------------------------------------------------------------

/** Voice Timeline Schema Version: "1.0". */
export const VOICE_TIMELINE_VERSION = "1.0" as const;
export const VoiceTimelineVersionSchema = z.literal(VOICE_TIMELINE_VERSION);
export type VoiceTimelineVersion = z.infer<typeof VoiceTimelineVersionSchema>;

/** Maximum allowed audio sample quantization error in microseconds (< 1 sample @ 48 kHz). */
export const MAX_AUDIO_QUANTIZATION_ERROR_US = (125 / 6); // ~20.8333... us (< 20.834 us)

/** Maximum allowed audio sample quantization error in nanoseconds: 125,000 / 6 ns. */
export const MAX_AUDIO_QUANTIZATION_ERROR_NS = 20_834;

// ---------------------------------------------------------------------------
// P9 Trusted Anchor Contract (Read-Only Input)
// ---------------------------------------------------------------------------

/**
 * P9 RecordingTimeline anchor envelope.
 * Strictly requires trusted execution facts from P9 anchors.jsonl.
 * Rejects DOM/renderer/wall-clock timestamps and paths.
 */
export const VoiceTimelineAnchorSchema = z.strictObject({
  recording_session_id: VoiceIdentifierSchema.optional(),
  take_id: VoiceIdentifierSchema.optional(),
  runtime_session_id: VoiceIdentifierSchema,
  generation: z.number().int().positive(),
  video_time_us: z.number().int().nonnegative(),
  runtime_monotonic_ms: z.number().int().nonnegative().optional(),
  global_seq: z.number().int().positive(),
  scene_id: SceneIdSchema.optional(),
  step_id: StepIdSchema,
  global_step_ordinal: z.number().int().positive().optional(),
  engine: z.string().min(1).optional(),
  event_type: z.string().min(1).max(128),
});
export type VoiceTimelineAnchor = z.infer<typeof VoiceTimelineAnchorSchema>;

// ---------------------------------------------------------------------------
// Globalized Alignment Contracts
// ---------------------------------------------------------------------------

export const GlobalWordMarkSchema = z
  .strictObject({
    ordinal: z.number().int().positive(),
    word: z.string().min(1).max(128),
    start_sample: z.number().int().nonnegative(),
    end_sample: z.number().int().nonnegative(),
    start_time_us: z.number().int().nonnegative(),
    end_time_us: z.number().int().nonnegative(),
  })
  .refine((val) => val.start_sample <= val.end_sample, {
    message: "[ALIGNMENT_INVALID] global word start_sample must be <= end_sample",
  });
export type GlobalWordMark = z.infer<typeof GlobalWordMarkSchema>;

export const GlobalPhonemeMarkSchema = z
  .strictObject({
    ordinal: z.number().int().positive(),
    phoneme: z.string().min(1).max(32),
    start_sample: z.number().int().nonnegative(),
    end_sample: z.number().int().nonnegative(),
    start_time_us: z.number().int().nonnegative(),
    end_time_us: z.number().int().nonnegative(),
  })
  .refine((val) => val.start_sample <= val.end_sample, {
    message: "[ALIGNMENT_INVALID] global phoneme start_sample must be <= end_sample",
  });
export type GlobalPhonemeMark = z.infer<typeof GlobalPhonemeMarkSchema>;

export const GlobalizedAlignmentSchema = z.strictObject({
  status: AlignmentStatusSchema,
  words: z.array(GlobalWordMarkSchema).default([]),
  phonemes: z.array(GlobalPhonemeMarkSchema).default([]),
});
export type GlobalizedAlignment = z.infer<typeof GlobalizedAlignmentSchema>;

// ---------------------------------------------------------------------------
// Bound Voice Cue Contract
// ---------------------------------------------------------------------------

export const BoundVoiceCueSchema = z
  .strictObject({
    voice_unit_id: VoiceUnitIdSchema,
    step_id: StepIdSchema,
    scene_id: SceneIdSchema.optional(),
    ordinal: z.number().int().positive(),
    cache_key: CacheKeySchema,
    audio_asset_digest: Sha256HexSchema,
    anchor_global_seq: z.number().int().positive(),
    anchor_video_time_us: z.number().int().nonnegative(),
    start_sample: z.number().int().nonnegative(),
    speech_start_sample: z.number().int().nonnegative(),
    speech_end_sample: z.number().int().nonnegative(),
    pause_before_samples: z.number().int().nonnegative(),
    pause_after_samples: z.number().int().nonnegative(),
    asset_sample_count: z.number().int().positive(),
    cue_end_sample: z.number().int().nonnegative(),
    alignment_status: AlignmentStatusSchema,
    alignment_ref: z.string().min(1).max(256).optional(),
    alignment: GlobalizedAlignmentSchema.optional(),
    quantization_error_us: z.number().int().nonnegative(),
    quantization_error_ns: z.number().int().nonnegative(),
  })
  .superRefine((val, ctx) => {
    // Math invariants:
    // speech_start_sample == start_sample + pause_before_samples
    if (val.speech_start_sample !== val.start_sample + val.pause_before_samples) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["speech_start_sample"],
        message: `speech_start_sample (${val.speech_start_sample}) must equal start_sample + pause_before_samples (${val.start_sample + val.pause_before_samples})`,
      });
    }
    // speech_end_sample == speech_start_sample + asset_sample_count
    if (val.speech_end_sample !== val.speech_start_sample + val.asset_sample_count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["speech_end_sample"],
        message: `speech_end_sample (${val.speech_end_sample}) must equal speech_start_sample + asset_sample_count (${val.speech_start_sample + val.asset_sample_count})`,
      });
    }
    // cue_end_sample == speech_end_sample + pause_after_samples
    if (val.cue_end_sample !== val.speech_end_sample + val.pause_after_samples) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cue_end_sample"],
        message: `cue_end_sample (${val.cue_end_sample}) must equal speech_end_sample + pause_after_samples (${val.speech_end_sample + val.pause_after_samples})`,
      });
    }
    // Quantization bound: error < 1 audio sample (< 20.834 us)
    if (val.quantization_error_ns >= MAX_AUDIO_QUANTIZATION_ERROR_NS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quantization_error_ns"],
        message: `quantization_error_ns (${val.quantization_error_ns}) exceeds 1 audio sample limit (${MAX_AUDIO_QUANTIZATION_ERROR_NS} ns)`,
      });
    }
  });
export type BoundVoiceCue = z.infer<typeof BoundVoiceCueSchema>;

// ---------------------------------------------------------------------------
// Timeline Validation Summary Contract
// ---------------------------------------------------------------------------

export const VoiceTimelineValidationSummarySchema = z.strictObject({
  valid: z.boolean(),
  outcome: z.enum(["PASS", "HOLD", "FAILED"]),
  errors: z.array(z.string()),
  cue_count: z.number().int().nonnegative(),
  first_start_sample: z.number().int().nonnegative().nullable(),
  last_end_sample: z.number().int().nonnegative().nullable(),
  total_speech_samples: z.number().int().nonnegative(),
  total_pause_samples: z.number().int().nonnegative(),
  max_quantization_error_us: z.number().int().nonnegative(),
  max_quantization_error_ns: z.number().int().nonnegative(),
  harmonic_30fps_exact: z.literal(true),
});
export type VoiceTimelineValidationSummary = z.infer<typeof VoiceTimelineValidationSummarySchema>;

// ---------------------------------------------------------------------------
// Recording Identity Reference
// ---------------------------------------------------------------------------

export const RecordingIdentityRefSchema = z.strictObject({
  recording_session_id: VoiceIdentifierSchema.optional(),
  take_id: VoiceIdentifierSchema.optional(),
});
export type RecordingIdentityRef = z.infer<typeof RecordingIdentityRefSchema>;

// ---------------------------------------------------------------------------
// Canonical Voice Timeline Schema 1.0
// ---------------------------------------------------------------------------

export const VoiceTimelineSchema = z
  .strictObject({
    timeline_version: VoiceTimelineVersionSchema,
    lesson_id: LessonIdSchema,
    course_id: CourseIdSchema.optional(),
    runtime_session_id: VoiceIdentifierSchema,
    generation: z.number().int().positive(),
    recording_ref: RecordingIdentityRefSchema.optional(),
    sample_rate_hz: z.literal(AUDIO_SAMPLE_RATE_HZ),
    cues: z.array(BoundVoiceCueSchema),
    timeline_digest: Sha256HexSchema,
    validation_summary: VoiceTimelineValidationSummarySchema,
  })
  .superRefine((val, ctx) => {
    // 1. Ordinals must be strictly 1..N
    for (let i = 0; i < val.cues.length; i++) {
      const cue = val.cues[i];
      if (cue && cue.ordinal !== i + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cues", i, "ordinal"],
          message: `cue[${i}].ordinal must be ${i + 1}, received: ${cue ? cue.ordinal : undefined}`,
        });
      }
    }

    // 2. Monotonic non-overlapping cues
    for (let i = 0; i < val.cues.length - 1; i++) {
      const curr = val.cues[i];
      const next = val.cues[i + 1];
      if (curr && next) {
        if (curr.anchor_global_seq >= next.anchor_global_seq) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["cues", i, "anchor_global_seq"],
            message: `cues must have strictly monotonic anchor_global_seq: ${curr.anchor_global_seq} >= ${next.anchor_global_seq}`,
          });
        }
        if (curr.cue_end_sample > next.start_sample) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["cues", i, "cue_end_sample"],
            message: `sample overlap between cue ${i + 1} (end: ${curr.cue_end_sample}) and cue ${i + 2} (start: ${next.start_sample})`,
          });
        }
      }
    }
  });
export type VoiceTimeline = z.infer<typeof VoiceTimelineSchema>;

// ---------------------------------------------------------------------------
// Error Model
// ---------------------------------------------------------------------------

export type VoiceTimelineErrorCode =
  | "ANCHOR_MISSING"
  | "ANCHOR_DUPLICATE"
  | "STEP_MISMATCH"
  | "LESSON_MISMATCH"
  | "STALE_RUNTIME_SESSION"
  | "STALE_GENERATION"
  | "MIXED_GENERATION"
  | "ORDER_CONTRADICTION"
  | "CUE_OVERLAP"
  | "VOICE_EXCEEDS_WINDOW"
  | "QUANTIZATION_EXCEEDED"
  | "ALIGNMENT_OUT_OF_BOUNDS"
  | "VALIDATION_FAILED";

export class VoiceTimelineBindingError extends Error {
  readonly code: VoiceTimelineErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: VoiceTimelineErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`);
    this.name = "VoiceTimelineBindingError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Alignment Marks Globalization (Asset-Local -> Global Timeline Samples)
// ---------------------------------------------------------------------------

/**
 * Transforms asset-local alignment marks into absolute timeline sample indices and microseconds.
 *
 * Rules:
 * global_word_start = speech_start_sample + local_word_start
 * global_word_end   = speech_start_sample + local_word_end
 * All marks must strictly lie within [0, asset_sample_count].
 * If a mark exceeds bounds, fails closed per frozen alignment policy.
 */
export function globalizeAlignmentMarks(
  alignment: NormalizedAlignment,
  speechStartSample: number,
  assetSampleCount: number,
): GlobalizedAlignment {
  if (alignment.status === "none") {
    return {
      status: "none",
      words: [],
      phonemes: [],
    };
  }

  const globalWords: GlobalWordMark[] = [];
  for (const mark of alignment.words) {
    if (mark.start_sample < 0 || mark.end_sample > assetSampleCount || mark.start_sample > mark.end_sample) {
      throw new VoiceTimelineBindingError(
        "ALIGNMENT_OUT_OF_BOUNDS",
        `Word mark '${mark.word}' [${mark.start_sample}, ${mark.end_sample}] exceeds asset sample bounds [0, ${assetSampleCount}]`,
        { mark, assetSampleCount },
      );
    }
    const startSample = speechStartSample + mark.start_sample;
    const endSample = speechStartSample + mark.end_sample;
    globalWords.push({
      ordinal: mark.ordinal,
      word: mark.word,
      start_sample: startSample,
      end_sample: endSample,
      start_time_us: audioTimeUsForSampleIndex(startSample),
      end_time_us: audioTimeUsForSampleIndex(endSample),
    });
  }

  const globalPhonemes: GlobalPhonemeMark[] = [];
  for (const mark of alignment.phonemes) {
    if (mark.start_sample < 0 || mark.end_sample > assetSampleCount || mark.start_sample > mark.end_sample) {
      throw new VoiceTimelineBindingError(
        "ALIGNMENT_OUT_OF_BOUNDS",
        `Phoneme mark '${mark.phoneme}' [${mark.start_sample}, ${mark.end_sample}] exceeds asset sample bounds [0, ${assetSampleCount}]`,
        { mark, assetSampleCount },
      );
    }
    const startSample = speechStartSample + mark.start_sample;
    const endSample = speechStartSample + mark.end_sample;
    globalPhonemes.push({
      ordinal: mark.ordinal,
      phoneme: mark.phoneme,
      start_sample: startSample,
      end_sample: endSample,
      start_time_us: audioTimeUsForSampleIndex(startSample),
      end_time_us: audioTimeUsForSampleIndex(endSample),
    });
  }

  return {
    status: alignment.status,
    words: globalWords,
    phonemes: globalPhonemes,
  };
}

// ---------------------------------------------------------------------------
// Timeline Digest Computation
// ---------------------------------------------------------------------------

export interface TimelineDigestInput {
  readonly timeline_version: string;
  readonly lesson_id: string;
  readonly runtime_session_id: string;
  readonly generation: number;
  readonly recording_ref?: RecordingIdentityRef;
  readonly sample_rate_hz: number;
  readonly cues: readonly {
    readonly voice_unit_id: string;
    readonly step_id: string;
    readonly cache_key: string;
    readonly audio_asset_digest: string;
    readonly anchor_global_seq: number;
    readonly anchor_video_time_us: number;
    readonly start_sample: number;
    readonly speech_start_sample: number;
    readonly speech_end_sample: number;
    readonly pause_before_samples: number;
    readonly pause_after_samples: number;
    readonly asset_sample_count: number;
    readonly cue_end_sample: number;
  }[];
}

/**
 * Computes a deterministic SHA-256 digest over canonical timeline placement facts.
 * Excludes wall clock, host paths, PIDs, and user metadata.
 */
export function computeTimelineDigest(input: TimelineDigestInput): Sha256Hex {
  const payload = {
    timeline_version: input.timeline_version,
    lesson_id: input.lesson_id,
    runtime_session_id: input.runtime_session_id,
    generation: input.generation,
    recording_ref: input.recording_ref ?? null,
    sample_rate_hz: input.sample_rate_hz,
    total_cues: input.cues.length,
    cues: input.cues.map((c) => ({
      voice_unit_id: c.voice_unit_id,
      step_id: c.step_id,
      cache_key: c.cache_key,
      audio_asset_digest: c.audio_asset_digest,
      anchor_global_seq: c.anchor_global_seq,
      anchor_video_time_us: c.anchor_video_time_us,
      start_sample: c.start_sample,
      speech_start_sample: c.speech_start_sample,
      speech_end_sample: c.speech_end_sample,
      pause_before_samples: c.pause_before_samples,
      pause_after_samples: c.pause_after_samples,
      asset_sample_count: c.asset_sample_count,
      cue_end_sample: c.cue_end_sample,
    })),
  };
  return sha256Hex(canonicalJson(payload));
}

// ---------------------------------------------------------------------------
// Timeline Binding Engine
// ---------------------------------------------------------------------------

export interface VoiceAssetItem {
  readonly asset: VoiceAssetMetadata;
  readonly alignment?: NormalizedAlignment;
}

export type VoiceAssetLookup =
  | Map<string, VoiceAssetItem | VoiceAssetMetadata>
  | readonly VoiceAssetMetadata[]
  | ((cacheKey: string) => VoiceAssetMetadata | VoiceAssetItem | undefined);

export interface BindVoiceTimelineOptions {
  readonly recording_ref?: RecordingIdentityRef;
  readonly media_duration_us?: number;
  readonly check_step_completion?: boolean;
  readonly signal?: AbortSignal;
}

export type SafeBindResult =
  | { readonly ok: true; readonly timeline: VoiceTimeline }
  | {
      readonly ok: false;
      readonly code: VoiceTimelineErrorCode;
      readonly reason: string;
      readonly details?: Record<string, unknown>;
    };

function resolveAssetFromLookup(
  lookup: VoiceAssetLookup,
  cacheKey: string,
): { asset: VoiceAssetMetadata; alignment?: NormalizedAlignment } | undefined {
  if (typeof lookup === "function") {
    const res = lookup(cacheKey);
    if (!res) return undefined;
    if ("asset" in res) {
      return { asset: res.asset, alignment: res.alignment };
    }
    return { asset: res as VoiceAssetMetadata };
  }
  if (lookup instanceof Map) {
    const res = lookup.get(cacheKey);
    if (!res) return undefined;
    if ("asset" in res) {
      return { asset: res.asset, alignment: res.alignment };
    }
    return { asset: res as VoiceAssetMetadata };
  }
  if (Array.isArray(lookup)) {
    const found = lookup.find((a) => a.cache_key === cacheKey);
    if (!found) return undefined;
    return { asset: found };
  }
  return undefined;
}

/**
 * Binds a NarrationPlan and validated VoiceAssets to trusted P9 anchors.
 * Throws VoiceTimelineBindingError on any contract violation or sync failure.
 */
export function bindVoiceTimeline(
  plan: NarrationPlan,
  assets: VoiceAssetLookup,
  rawAnchors: readonly unknown[],
  fence: RuntimeFence,
  options?: BindVoiceTimelineOptions,
): VoiceTimeline {
  if (options?.signal?.aborted) {
    throw new VoiceTimelineBindingError("VALIDATION_FAILED", "Binding aborted by caller signal");
  }

  // 1. Validate fence
  const parsedFence = RuntimeFenceSchema.parse(fence);
  if (parsedFence.lesson_id !== undefined && parsedFence.lesson_id !== plan.lesson_id) {
    throw new VoiceTimelineBindingError(
      "LESSON_MISMATCH",
      `Fence lesson_id '${parsedFence.lesson_id}' does not match plan lesson_id '${plan.lesson_id}'`,
      { fenceLessonId: parsedFence.lesson_id, planLessonId: plan.lesson_id },
    );
  }

  // 2. Validate and index anchors
  const narrationStartAnchors = new Map<string, VoiceTimelineAnchor[]>();
  const stepCompletedAnchors = new Map<string, VoiceTimelineAnchor>();

  for (let idx = 0; idx < rawAnchors.length; idx++) {
    const raw = rawAnchors[idx];
    const parsed = VoiceTimelineAnchorSchema.safeParse(raw);
    if (!parsed.success) {
      throw new VoiceTimelineBindingError(
        "VALIDATION_FAILED",
        `Anchor at index ${idx} failed frozen schema validation: ${parsed.error.message}`,
        { index: idx },
      );
    }
    const anchor = parsed.data;

    // Fence enforcement on every anchor in the stream
    if (anchor.runtime_session_id !== parsedFence.runtime_session_id) {
      throw new VoiceTimelineBindingError(
        "STALE_RUNTIME_SESSION",
        `Anchor at seq ${anchor.global_seq} session '${anchor.runtime_session_id}' does not match active session '${parsedFence.runtime_session_id}'`,
        { anchorSession: anchor.runtime_session_id, fenceSession: parsedFence.runtime_session_id },
      );
    }

    if (anchor.generation !== parsedFence.generation) {
      throw new VoiceTimelineBindingError(
        "STALE_GENERATION",
        `Anchor at seq ${anchor.global_seq} generation ${anchor.generation} does not match active generation ${parsedFence.generation}`,
        { anchorGeneration: anchor.generation, fenceGeneration: parsedFence.generation },
      );
    }

    // Recording reference enforcement if provided
    if (options?.recording_ref?.recording_session_id && anchor.recording_session_id) {
      if (anchor.recording_session_id !== options.recording_ref.recording_session_id) {
        throw new VoiceTimelineBindingError(
          "VALIDATION_FAILED",
          `Anchor recording_session_id '${anchor.recording_session_id}' does not match expected '${options.recording_ref.recording_session_id}'`,
        );
      }
    }
    if (options?.recording_ref?.take_id && anchor.take_id) {
      if (anchor.take_id !== options.recording_ref.take_id) {
        throw new VoiceTimelineBindingError(
          "VALIDATION_FAILED",
          `Anchor take_id '${anchor.take_id}' does not match expected '${options.recording_ref.take_id}'`,
        );
      }
    }

    // Classify narration start events
    const isStart =
      anchor.event_type === "runtime.step.started" || anchor.event_type === "step.started";
    const isCompleted =
      anchor.event_type === "runtime.step.completed" || anchor.event_type === "step.completed";
    const isNarrationEngine = anchor.engine === undefined || anchor.engine === "narration";

    if (isStart && isNarrationEngine) {
      const existing = narrationStartAnchors.get(anchor.step_id) ?? [];
      existing.push(anchor);
      narrationStartAnchors.set(anchor.step_id, existing);
    }

    if (isCompleted && isNarrationEngine) {
      stepCompletedAnchors.set(anchor.step_id, anchor);
    }
  }

  // Check for duplicate start anchors
  for (const [stepId, list] of narrationStartAnchors.entries()) {
    if (list.length > 1) {
      throw new VoiceTimelineBindingError(
        "ANCHOR_DUPLICATE",
        `Multiple authoritative start anchors found for narration step '${stepId}' (${list.length} anchors)`,
        { stepId, count: list.length },
      );
    }
  }

  // 3. Bind planned narration units to anchors
  const boundCues: BoundVoiceCue[] = [];
  let maxQuantizationErrorUs = 0;
  let maxQuantizationErrorNs = 0;
  let totalSpeechSamples = 0;
  let totalPauseSamples = 0;

  for (let i = 0; i < plan.units.length; i++) {
    const plannedUnit: PlannedNarrationUnit = plan.units[i]!;
    const stepId = plannedUnit.unit.step_id;
    const sceneId = plannedUnit.unit.scene_id;

    // Anchor resolution
    const startList = narrationStartAnchors.get(stepId);
    if (!startList || startList.length === 0) {
      throw new VoiceTimelineBindingError(
        "ANCHOR_MISSING",
        `Missing required authoritative start anchor for narration step '${stepId}'`,
        { stepId, voiceUnitId: plannedUnit.voice_unit_id },
      );
    }
    const anchor = startList[0]!;

    // Step / Scene identity verification
    if (anchor.step_id !== stepId) {
      throw new VoiceTimelineBindingError(
        "STEP_MISMATCH",
        `Anchor step_id '${anchor.step_id}' does not match planned step_id '${stepId}'`,
        { anchorStepId: anchor.step_id, plannedStepId: stepId },
      );
    }
    if (anchor.scene_id !== undefined && anchor.scene_id !== sceneId) {
      throw new VoiceTimelineBindingError(
        "STEP_MISMATCH",
        `Anchor scene_id '${anchor.scene_id}' does not match planned scene_id '${sceneId}'`,
        { anchorSceneId: anchor.scene_id, plannedSceneId: sceneId },
      );
    }

    // Resolve cached VoiceAsset
    const resolvedAssetItem = resolveAssetFromLookup(assets, plannedUnit.cache_key);
    if (!resolvedAssetItem) {
      throw new VoiceTimelineBindingError(
        "VALIDATION_FAILED",
        `No validated VoiceAsset found for cache_key '${plannedUnit.cache_key}' (step '${stepId}')`,
        { cacheKey: plannedUnit.cache_key, stepId },
      );
    }
    const asset = resolvedAssetItem.asset;

    // Canonical sample mapping: floor(t * 48000 / 1000000) = floor(t * 6 / 125)
    const anchorVideoTimeUs = anchor.video_time_us;
    const startSample = sampleIndexForAudioTimeUs(anchorVideoTimeUs);
    const mappedAudioTimeUs = audioTimeUsForSampleIndex(startSample);

    // Exact quantization error arithmetic
    // anchorVideoTimeUs * 6 - startSample * 125
    const bigTime = BigInt(anchorVideoTimeUs);
    const bigSample = BigInt(startSample);
    const numerator = bigTime * 6n - bigSample * 125n;
    if (numerator < 0n || numerator >= 125n) {
      throw new VoiceTimelineBindingError(
        "QUANTIZATION_EXCEEDED",
        `Quantization math invariant failed for video_time_us=${anchorVideoTimeUs}`,
        { anchorVideoTimeUs, startSample },
      );
    }

    const quantizationErrorUs = anchorVideoTimeUs - mappedAudioTimeUs;
    const quantizationErrorNs = Number((numerator * 1000n) / 6n);

    if (quantizationErrorNs >= MAX_AUDIO_QUANTIZATION_ERROR_NS) {
      throw new VoiceTimelineBindingError(
        "QUANTIZATION_EXCEEDED",
        `Audio sample quantization error (${quantizationErrorNs} ns) exceeds 1 sample period (< 20.834 us)`,
        { quantizationErrorNs, quantizationErrorUs, anchorVideoTimeUs },
      );
    }

    maxQuantizationErrorUs = Math.max(maxQuantizationErrorUs, quantizationErrorUs);
    maxQuantizationErrorNs = Math.max(maxQuantizationErrorNs, quantizationErrorNs);

    // Non-duplicating pause representation (Outcome A)
    const pauseBeforeSamples = plannedUnit.pause_before_samples;
    const pauseAfterSamples = plannedUnit.pause_after_samples;
    const speechStartSample = startSample + pauseBeforeSamples;
    const speechEndSample = speechStartSample + asset.sample_count;
    const cueEndSample = speechEndSample + pauseAfterSamples;

    totalSpeechSamples += asset.sample_count;
    totalPauseSamples += pauseBeforeSamples + pauseAfterSamples;

    // Alignment marks globalization
    let globalAlignment: GlobalizedAlignment | undefined;
    if (resolvedAssetItem.alignment && resolvedAssetItem.alignment.status !== "none") {
      globalAlignment = globalizeAlignmentMarks(
        resolvedAssetItem.alignment,
        speechStartSample,
        asset.sample_count,
      );
    }

    const boundCue: BoundVoiceCue = {
      voice_unit_id: plannedUnit.voice_unit_id,
      step_id: stepId,
      ...(sceneId ? { scene_id: sceneId } : {}),
      ordinal: i + 1,
      cache_key: plannedUnit.cache_key,
      audio_asset_digest: asset.audio_asset_digest,
      anchor_global_seq: anchor.global_seq,
      anchor_video_time_us: anchorVideoTimeUs,
      start_sample: startSample,
      speech_start_sample: speechStartSample,
      speech_end_sample: speechEndSample,
      pause_before_samples: pauseBeforeSamples,
      pause_after_samples: pauseAfterSamples,
      asset_sample_count: asset.sample_count,
      cue_end_sample: cueEndSample,
      alignment_status: asset.alignment_status,
      alignment_ref: `cues/${stepId}.alignment.json`,
      ...(globalAlignment ? { alignment: globalAlignment } : {}),
      quantization_error_us: quantizationErrorUs,
      quantization_error_ns: quantizationErrorNs,
    };

    boundCues.push(boundCue);

    // Check step completion window if present and requested
    if (options?.check_step_completion) {
      const completedAnchor = stepCompletedAnchors.get(stepId);
      if (completedAnchor) {
        const completedSample = sampleIndexForAudioTimeUs(completedAnchor.video_time_us);
        if (cueEndSample > completedSample) {
          throw new VoiceTimelineBindingError(
            "VOICE_EXCEEDS_WINDOW",
            `Narration audio for step '${stepId}' (end sample ${cueEndSample}) exceeds step completion window (sample ${completedSample})`,
            { stepId, cueEndSample, completedSample },
          );
        }
      }
    }

    // Check media duration ceiling if provided
    if (options?.media_duration_us !== undefined) {
      const mediaEndSample = sampleIndexForAudioTimeUs(options.media_duration_us);
      if (cueEndSample > mediaEndSample) {
        throw new VoiceTimelineBindingError(
          "VOICE_EXCEEDS_WINDOW",
          `Narration audio for step '${stepId}' (end sample ${cueEndSample}) exceeds take media duration (sample ${mediaEndSample})`,
          { stepId, cueEndSample, mediaEndSample },
        );
      }
    }
  }

  // 4. Verify cue ordering agreement & sample overlap
  for (let i = 0; i < boundCues.length - 1; i++) {
    const curr = boundCues[i]!;
    const next = boundCues[i + 1]!;

    // Contradictory order check (Authored order vs Anchor order)
    if (curr.anchor_global_seq >= next.anchor_global_seq) {
      throw new VoiceTimelineBindingError(
        "ORDER_CONTRADICTION",
        `Authored narration order contradicts runtime anchor global_seq: cue '${curr.step_id}' (seq ${curr.anchor_global_seq}) >= cue '${next.step_id}' (seq ${next.anchor_global_seq})`,
        { currSeq: curr.anchor_global_seq, nextSeq: next.anchor_global_seq },
      );
    }
    if (curr.anchor_video_time_us > next.anchor_video_time_us) {
      throw new VoiceTimelineBindingError(
        "ORDER_CONTRADICTION",
        `Authored narration order contradicts runtime video time: cue '${curr.step_id}' (${curr.anchor_video_time_us} us) > cue '${next.step_id}' (${next.anchor_video_time_us} us)`,
        { currTime: curr.anchor_video_time_us, nextTime: next.anchor_video_time_us },
      );
    }

    // Sample-domain overlap check
    if (curr.cue_end_sample > next.start_sample) {
      throw new VoiceTimelineBindingError(
        "CUE_OVERLAP",
        `Narration interval overlap detected between cue '${curr.step_id}' (ends at sample ${curr.cue_end_sample}) and cue '${next.step_id}' (starts at sample ${next.start_sample})`,
        {
          currStep: curr.step_id,
          currEndSample: curr.cue_end_sample,
          nextStep: next.step_id,
          nextStartSample: next.start_sample,
          overlapSamples: curr.cue_end_sample - next.start_sample,
        },
      );
    }
  }

  // 5. Compute validation summary
  const firstStart = boundCues.length > 0 ? boundCues[0]!.start_sample : null;
  const lastEnd = boundCues.length > 0 ? boundCues[boundCues.length - 1]!.cue_end_sample : null;

  const validationSummary: VoiceTimelineValidationSummary = {
    valid: true,
    outcome: "PASS",
    errors: [],
    cue_count: boundCues.length,
    first_start_sample: firstStart,
    last_end_sample: lastEnd,
    total_speech_samples: totalSpeechSamples,
    total_pause_samples: totalPauseSamples,
    max_quantization_error_us: maxQuantizationErrorUs,
    max_quantization_error_ns: maxQuantizationErrorNs,
    harmonic_30fps_exact: true,
  };

  // 6. Compute timeline digest
  const timelineDigest = computeTimelineDigest({
    timeline_version: VOICE_TIMELINE_VERSION,
    lesson_id: plan.lesson_id,
    runtime_session_id: parsedFence.runtime_session_id,
    generation: parsedFence.generation,
    recording_ref: options?.recording_ref,
    sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
    cues: boundCues,
  });

  const timelineCandidate = {
    timeline_version: VOICE_TIMELINE_VERSION,
    lesson_id: plan.lesson_id,
    course_id: plan.course_id,
    runtime_session_id: parsedFence.runtime_session_id,
    generation: parsedFence.generation,
    ...(options?.recording_ref ? { recording_ref: options.recording_ref } : {}),
    sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
    cues: boundCues,
    timeline_digest: timelineDigest,
    validation_summary: validationSummary,
  };

  return VoiceTimelineSchema.parse(timelineCandidate);
}

/**
 * Non-throwing safe wrapper around bindVoiceTimeline.
 */
export function safeBindVoiceTimeline(
  plan: NarrationPlan,
  assets: VoiceAssetLookup,
  rawAnchors: readonly unknown[],
  fence: RuntimeFence,
  options?: BindVoiceTimelineOptions,
): SafeBindResult {
  try {
    const timeline = bindVoiceTimeline(plan, assets, rawAnchors, fence, options);
    return { ok: true, timeline };
  } catch (err) {
    if (err instanceof VoiceTimelineBindingError) {
      return {
        ok: false,
        code: err.code,
        reason: err.message,
        details: err.details,
      };
    }
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Serialization and Parsing API
// ---------------------------------------------------------------------------

export function serializeVoiceTimeline(timeline: VoiceTimeline): string {
  const validated = VoiceTimelineSchema.parse(timeline);
  return canonicalJsonPretty(validated);
}

export function parseVoiceTimeline(jsonString: string): VoiceTimeline {
  if (typeof jsonString !== "string" || jsonString.trim().length === 0) {
    throw new TypeError("[TIMELINE_PARSE_ERROR] jsonString must be a non-empty string");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(jsonString);
  } catch (err) {
    throw new TypeError(`[TIMELINE_PARSE_ERROR] malformed JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return VoiceTimelineSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Pure Sample-Domain Lesson Audio Track Assembler
// ---------------------------------------------------------------------------

export interface AssembleVoiceTrackOptions {
  /**
   * Total audio samples in the assembled track.
   * If not specified, defaults to the end sample of the last cue.
   */
  readonly total_samples?: number;

  /**
   * Total video frames encoded by P9 (e.g. from RecordingManifest 1.1).
   * When specified, full video frame coverage is exact: frames * 1,600 samples.
   */
  readonly video_frame_count?: number;
}

/**
 * Assembles an uncompressed composition-ready 48 kHz mono PCM16 WAV audio track
 * from immutable cached VoiceAssets positioned at exact sample coordinates.
 *
 * Invariants:
 * - Pure sample-domain placement (zero FFmpeg, zero time-stretching, zero resampling).
 * - Inter-cue gaps and pauses are filled with exact linear zeros.
 * - Confirms zero sample overlap before writing.
 * - Emits standard 44-byte RIFF WAV header with exact byte lengths.
 */
export function assembleLessonAudioTrack(
  timeline: VoiceTimeline,
  assetAudioMap: Map<string, Buffer>,
  options?: AssembleVoiceTrackOptions,
): Buffer {
  let targetTotalSamples = 0;

  if (options?.video_frame_count !== undefined) {
    if (!Number.isInteger(options.video_frame_count) || options.video_frame_count < 0) {
      throw new RangeError(`[TRACK_INVALID_FRAMES] video_frame_count must be a non-negative integer`);
    }
    // Exact harmonic relation: 1,600 samples per 30 FPS video frame
    targetTotalSamples = options.video_frame_count * AUDIO_SAMPLES_PER_VIDEO_FRAME;
  } else if (options?.total_samples !== undefined) {
    if (!Number.isInteger(options.total_samples) || options.total_samples < 0) {
      throw new RangeError(`[TRACK_INVALID_SAMPLES] total_samples must be a non-negative integer`);
    }
    targetTotalSamples = options.total_samples;
  } else {
    // Default to last cue extent
    targetTotalSamples = timeline.validation_summary.last_end_sample ?? 0;
  }

  // Ensure target total samples covers at least all cues
  const lastCueEnd = timeline.validation_summary.last_end_sample ?? 0;
  if (targetTotalSamples < lastCueEnd) {
    throw new VoiceTimelineBindingError(
      "VOICE_EXCEEDS_WINDOW",
      `Assembled track length (${targetTotalSamples} samples) is smaller than last cue end (${lastCueEnd} samples)`,
      { targetTotalSamples, lastCueEnd },
    );
  }

  // 16-bit mono = 2 bytes per sample
  const bytesPerSample = 2;
  const pcmByteLength = targetTotalSamples * bytesPerSample;
  const pcmBuffer = Buffer.alloc(pcmByteLength); // alloc zero-initializes memory

  for (const cue of timeline.cues) {
    const rawAssetWav = assetAudioMap.get(cue.cache_key);
    if (!rawAssetWav) {
      throw new VoiceTimelineBindingError(
        "VALIDATION_FAILED",
        `Missing audio WAV buffer for cue cache_key '${cue.cache_key}' (step '${cue.step_id}')`,
        { cacheKey: cue.cache_key, stepId: cue.step_id },
      );
    }

    const wavInfo = parseWavHeader(rawAssetWav);
    if (wavInfo.sampleCount !== cue.asset_sample_count) {
      throw new VoiceTimelineBindingError(
        "VALIDATION_FAILED",
        `Audio WAV sample count (${wavInfo.sampleCount}) does not match cue asset_sample_count (${cue.asset_sample_count})`,
        { wavSampleCount: wavInfo.sampleCount, cueSampleCount: cue.asset_sample_count },
      );
    }

    const cuePcm = rawAssetWav.subarray(wavInfo.dataOffset, wavInfo.dataOffset + wavInfo.dataLength);
    const destByteOffset = cue.speech_start_sample * bytesPerSample;
    const destEndOffset = destByteOffset + cuePcm.byteLength;

    if (destEndOffset > pcmByteLength) {
      throw new VoiceTimelineBindingError(
        "VOICE_EXCEEDS_WINDOW",
        `Cue '${cue.step_id}' audio extends beyond track PCM buffer: ${destEndOffset} > ${pcmByteLength}`,
        { destEndOffset, pcmByteLength },
      );
    }

    cuePcm.copy(pcmBuffer, destByteOffset);
  }

  const header = buildWavHeader(targetTotalSamples);
  return Buffer.concat([header, pcmBuffer], WAV_HEADER_BYTES + pcmByteLength);
}
