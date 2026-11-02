// P9.1 RecordingManifest 1.0 Schema & Safe-Field Enforcement.
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 15, 20-22 and ADR-0014
// (Honest Lifecycle and Storage). Defines <take>.manifest.json version 1.0
// with the frozen safe-field allowlist, cross-field publication invariants,
// media digest convention, 64 KiB serialized-size bound, and deterministic
// canonical serialization (in-memory helpers only; P9.3/P9.6 own physical
// lifecycle). Forbidden fields are structurally impossible (strictObject)
// plus privacy-text enforcement on free-text fields.

import { z } from "zod";
import {
  MAX_TAKE_DURATION_US,
  MicrosecondSchema,
  PrivacySafeTextSchema,
  PublicationStatusSchema,
  RECORDING_PROTOCOL_VERSION,
  RecordingCourseIdSchema,
  RecordingEpochSchema,
  RecordingGenerationSchema,
  RecordingLessonIdSchema,
  RecordingOutcomeSchema,
  RecordingRuntimeSessionIdSchema,
  RecordingSessionIdSchema,
  RecordingSha256HexSchema,
  RecordingTerminalCauseSchema,
  TakeDurationUsSchema,
  TakeIdSchema,
  terminalCauseToOutcome,
  type PublicationStatus,
  type RecordingOutcome,
  type RecordingTerminalCause,
} from "./protocol.ts";
import {
  CANONICAL_REQUESTED_PROFILE,
  EncoderDescriptorSchema,
  RECORDING_FPS,
  RECORDING_HEIGHT,
  RECORDING_WIDTH,
  RESERVED_AUDIO_SLOT,
  RequestedRecordingProfileSchema,
  ReservedAudioSlotSchema,
  type EncoderDescriptor,
} from "./encoder-profile.ts";
import {
  FrameCounters10Schema,
  FrameCounters11Schema,
  FrameCountersSchema,
  type FrameCounters,
  type FrameCounters10,
  type FrameCounters11,
} from "./timeline.ts";

// ---------------------------------------------------------------------------
// Manifest Version & Size Bound (P9-DESIGN-SPEC Section 19 + Addendum)
// ---------------------------------------------------------------------------

/** Current RecordingManifest schema version 1.1 (P9.1 Corrective Addendum). */
export const RECORDING_MANIFEST_VERSION = "1.1";

/** Historical RecordingManifest schema version 1.0 (read-only historical). */
export const HISTORICAL_RECORDING_MANIFEST_VERSION_1_0 = "1.0";

/** Supported RecordingManifest versions. */
export const RECORDING_MANIFEST_VERSIONS = ["1.0", "1.1"] as const;
export const RecordingManifestVersionSchema = z.enum(RECORDING_MANIFEST_VERSIONS);
export type RecordingManifestVersion = z.infer<typeof RecordingManifestVersionSchema>;

/** Manifest serialized ceiling: <= 64 KiB (UTF-8 bytes, not JS chars). */
export const MAX_MANIFEST_BYTES = 65_536;

// ---------------------------------------------------------------------------
// Capture Backend Descriptor (WGC window canonical; no silent fallback)
// ---------------------------------------------------------------------------

export const CaptureBackendSchema = z.strictObject({
  backend: z.literal("wgc-window"),
  degraded: z.literal(false),
  cursor_capture: z.literal(false),
});
export type CaptureBackend = z.infer<typeof CaptureBackendSchema>;

// ---------------------------------------------------------------------------
// Media Validation Summary (post-record checks owned by P9.3/P9.6;
// P9.1 freezes the summary shape only)
// ---------------------------------------------------------------------------

export const MEDIA_CHECK_NAMES = [
  "container_readable",
  "codec_h264",
  "resolution_1920x1080",
  "fps_approx_30",
  "duration_within_tolerance",
  "nonzero_frames",
  "pts_monotonic",
  "size_within_ceiling",
] as const;

export const MediaCheckNameSchema = z.enum(MEDIA_CHECK_NAMES);
export type MediaCheckName = z.infer<typeof MediaCheckNameSchema>;

export const MediaCheckResultSchema = z.strictObject({
  check: MediaCheckNameSchema,
  passed: z.boolean(),
});
export type MediaCheckResult = z.infer<typeof MediaCheckResultSchema>;

export const MediaValidationSummarySchema = z.strictObject({
  verdict: z.enum(["PASS", "FAIL"]),
  checks: z.array(MediaCheckResultSchema).min(1).max(32),
});
export type MediaValidationSummary = z.infer<typeof MediaValidationSummarySchema>;

// ---------------------------------------------------------------------------
// Preflight Summary (P9-DESIGN-SPEC Section 21 gate record)
// ---------------------------------------------------------------------------

export const PreflightSummarySchema = z.strictObject({
  free_bytes_at_start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  geometry_verified: z.literal(true),
  encoder_probe_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
});
export type PreflightSummary = z.infer<typeof PreflightSummarySchema>;

// ---------------------------------------------------------------------------
// Anchor Summary (sidecar digest; per-anchor data stays in anchors.jsonl)
// ---------------------------------------------------------------------------

export const AnchorSummarySchema = z.strictObject({
  anchor_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  first_video_time_us: TakeDurationUsSchema,
  last_video_time_us: TakeDurationUsSchema,
  journal_high_seq_start: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  journal_high_seq_end: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  anchors_sha256: RecordingSha256HexSchema,
});
export type AnchorSummary = z.infer<typeof AnchorSummarySchema>;

// ---------------------------------------------------------------------------
// RecordingManifest Schemas (1.1 Current + 1.0 Historical Read-Only)
// ---------------------------------------------------------------------------

const baseManifestShape = {
  recording_protocol_version: z.literal(RECORDING_PROTOCOL_VERSION),
  recording_session_id: RecordingSessionIdSchema,
  take_id: TakeIdSchema,
  lesson_id: RecordingLessonIdSchema,
  course_id: RecordingCourseIdSchema,
  runtime_session_id: RecordingRuntimeSessionIdSchema,
  generation: RecordingGenerationSchema,
  record_safe: z.literal(true),
  capture: CaptureBackendSchema,
  requested_profile: RequestedRecordingProfileSchema,
  encoder: EncoderDescriptorSchema,
  epoch: RecordingEpochSchema,
  recording_start_us: MicrosecondSchema,
  recording_end_us: MicrosecondSchema,
  duration_us: TakeDurationUsSchema,
  tail_duration_ms: z.number().int().min(0).max(10_000),
  anchors: AnchorSummarySchema,
  publication_status: PublicationStatusSchema,
  outcome: RecordingOutcomeSchema,
  terminal_cause: RecordingTerminalCauseSchema,
  media_sha256: RecordingSha256HexSchema.nullable(),
  media_size_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  media_validation: MediaValidationSummarySchema.nullable(),
  audio: ReservedAudioSlotSchema,
  video_width: z.literal(RECORDING_WIDTH),
  video_height: z.literal(RECORDING_HEIGHT),
  video_fps: z.literal(RECORDING_FPS),
  preflight: PreflightSummarySchema,
  app_version: PrivacySafeTextSchema,
};

function applyCommonManifestInvariants(
  m: {
    terminal_cause: RecordingTerminalCause;
    outcome: RecordingOutcome;
    recording_start_us: number;
    recording_end_us: number;
    duration_us: number;
    anchors: AnchorSummary;
    publication_status: PublicationStatus;
    media_sha256: string | null;
    media_size_bytes: number;
    media_validation: MediaValidationSummary | null;
    tail_duration_ms: number;
    frames: { encoded_frame_count: number };
  },
  ctx: z.RefinementCtx,
): void {
  // Invariant 1: terminal cause must map to the declared outcome bucket.
  const expectedOutcome = terminalCauseToOutcome(m.terminal_cause);
  if (m.outcome !== expectedOutcome) {
    ctx.addIssue({
      code: "custom",
      path: ["outcome"],
      message: `terminal_cause '${m.terminal_cause}' requires outcome '${expectedOutcome}' (got '${m.outcome}')`,
    });
  }
  // Invariant 2: end >= start; duration equals the interval.
  if (m.recording_end_us < m.recording_start_us) {
    ctx.addIssue({
      code: "custom",
      path: ["recording_end_us"],
      message: "recording_end_us must not precede recording_start_us",
    });
  }
  if (m.duration_us !== m.recording_end_us - m.recording_start_us) {
    ctx.addIssue({
      code: "custom",
      path: ["duration_us"],
      message: "duration_us must equal recording_end_us - recording_start_us",
    });
  }
  if (m.duration_us > MAX_TAKE_DURATION_US) {
    ctx.addIssue({
      code: "custom",
      path: ["duration_us"],
      message: `duration_us exceeds take ceiling ${MAX_TAKE_DURATION_US}`,
    });
  }
  // Invariant 3: anchor time range within take duration.
  if (m.anchors.last_video_time_us > m.duration_us) {
    ctx.addIssue({
      code: "custom",
      path: ["anchors"],
      message: "anchor last_video_time_us exceeds take duration_us",
    });
  }
  if (m.anchors.first_video_time_us > m.anchors.last_video_time_us) {
    ctx.addIssue({
      code: "custom",
      path: ["anchors"],
      message: "anchor first_video_time_us exceeds last_video_time_us",
    });
  }
  if (m.anchors.journal_high_seq_end < m.anchors.journal_high_seq_start) {
    ctx.addIssue({
      code: "custom",
      path: ["anchors"],
      message: "journal_high_seq_end precedes journal_high_seq_start",
    });
  }
  // Invariant 4: PUBLISHED requires success + digest + frames + PASS.
  if (m.publication_status === "PUBLISHED") {
    if (m.outcome !== "COMPLETED") {
      ctx.addIssue({
        code: "custom",
        path: ["publication_status"],
        message: "PUBLISHED requires outcome COMPLETED",
      });
    }
    if (m.media_sha256 === null) {
      ctx.addIssue({
        code: "custom",
        path: ["media_sha256"],
        message: "PUBLISHED requires a SHA-256 media digest",
      });
    }
    if (m.duration_us === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["duration_us"],
        message: "PUBLISHED requires duration_us > 0",
      });
    }
    if (m.frames.encoded_frame_count === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["frames"],
        message: "PUBLISHED requires encoded_frame_count > 0",
      });
    }
    if (
      m.media_validation === null ||
      m.media_validation.verdict !== "PASS"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["media_validation"],
        message: "PUBLISHED requires media validation PASS",
      });
    }
    if (m.tail_duration_ms !== 2_000) {
      ctx.addIssue({
        code: "custom",
        path: ["tail_duration_ms"],
        message: "PUBLISHED completed takes require the 2,000 ms tail",
      });
    }
  }
  // Invariant 5: PURGED (cancelled) claims no digest and no media bytes.
  if (m.publication_status === "PURGED") {
    if (m.media_sha256 !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["media_sha256"],
        message: "PURGED takes must not claim a media digest",
      });
    }
    if (m.media_size_bytes !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["media_size_bytes"],
        message: "PURGED takes must not claim final media bytes",
      });
    }
    if (m.outcome !== "CANCELLED") {
      ctx.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "PURGED requires outcome CANCELLED",
      });
    }
  }
  // Invariant 6: terminal failure/incomplete causes never PUBLISHED.
  if (
    (m.outcome === "FAILED" ||
      m.outcome === "INCOMPLETE" ||
      m.outcome === "CANCELLED" ||
      m.outcome === "RESET_INTERRUPTED") &&
    (m.publication_status === "PUBLISHED" ||
      m.publication_status === "VALIDATED")
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["publication_status"],
      message: `outcome ${m.outcome} cannot be ${m.publication_status}`,
    });
  }
  // Invariant 7: FAILED outcome cannot claim successful validation.
  if (
    m.outcome === "FAILED" &&
    m.media_validation !== null &&
    m.media_validation.verdict === "PASS"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["media_validation"],
      message: "FAILED outcome cannot claim media validation PASS",
    });
  }
  // Invariant 8: QUARANTINED is for diagnostic partials (FAILED only).
  if (m.publication_status === "QUARANTINED" && m.outcome !== "FAILED") {
    ctx.addIssue({
      code: "custom",
      path: ["publication_status"],
      message: "QUARANTINED requires outcome FAILED",
    });
  }
}

/** Historical RecordingManifest 1.0 schema (read-only historical). */
export const RecordingManifest10Schema = z
  .strictObject({
    manifest_version: z.literal(HISTORICAL_RECORDING_MANIFEST_VERSION_1_0),
    ...baseManifestShape,
    frames: FrameCounters10Schema,
  })
  .superRefine((m, ctx) => {
    applyCommonManifestInvariants(m, ctx);
  });

/** Current RecordingManifest 1.1 schema (current publication contract). */
export const RecordingManifest11Schema = z
  .strictObject({
    manifest_version: z.literal(RECORDING_MANIFEST_VERSION),
    ...baseManifestShape,
    frames: FrameCounters11Schema,
  })
  .superRefine((m, ctx) => {
    applyCommonManifestInvariants(m, ctx);
    // (P4) PUBLISHED requires captured >= 1 (readiness contract)
    if (m.publication_status === "PUBLISHED" && m.frames.captured_frame_count < 1) {
      ctx.addIssue({
        code: "custom",
        path: ["frames", "captured_frame_count"],
        message: "PUBLISHED completed takes require captured_frame_count >= 1",
      });
    }
  });

/** Discriminated union accepting both current 1.1 and historical 1.0 manifests. */
export const AnyRecordingManifestSchema = z.discriminatedUnion("manifest_version", [
  RecordingManifest11Schema,
  RecordingManifest10Schema,
]);

/** Canonical RecordingManifestSchema defaults to current 1.1 schema. */
export const RecordingManifestSchema = RecordingManifest11Schema;

export type RecordingManifest11 = z.infer<typeof RecordingManifest11Schema>;
export type RecordingManifest10 = z.infer<typeof RecordingManifest10Schema>;
export type RecordingManifest = RecordingManifest11;
export type AnyRecordingManifest = z.infer<typeof AnyRecordingManifestSchema>;

// ---------------------------------------------------------------------------
// Canonical Serialization (deterministic; UTF-8 byte size, not char count)
// ---------------------------------------------------------------------------

/** Minimal local sorted-keys canonicalization (canonical-json-v1 mirror). */
export function sortManifestKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortManifestKeysDeep) as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortManifestKeysDeep(source[key]);
    }
    return sorted as T;
  }
  return value;
}

/** Canonical manifest JSON: sorted keys, 2-space indent, LF, no BOM. */
export function canonicalManifestJson(manifest: AnyRecordingManifest): string {
  const parsed = AnyRecordingManifestSchema.parse(manifest);
  return `${JSON.stringify(sortManifestKeysDeep(parsed), null, 2)}\n`;
}

/** UTF-8 serialized byte size of the canonical manifest form. */
export function manifestByteSize(manifest: AnyRecordingManifest): number {
  return Buffer.byteLength(canonicalManifestJson(manifest), "utf8");
}

/**
 * Parses + validates an externally supplied manifest object, including the
 * 64 KiB serialized-size bound. Accepts current 1.1 and historical 1.0.
 * Rejects unknown keys (fail closed).
 */
export function parseRecordingManifest(value: unknown): AnyRecordingManifest {
  const parsed = AnyRecordingManifestSchema.parse(value);
  const bytes = Buffer.byteLength(canonicalManifestJson(parsed), "utf8");
  if (bytes > MAX_MANIFEST_BYTES) {
    throw new Error(
      `[MANIFEST_TOO_LARGE] canonical manifest is ${bytes} bytes (max ${MAX_MANIFEST_BYTES})`,
    );
  }
  return parsed;
}

/**
 * Parses + validates against the current 1.1 schema strictly.
 */
export function parseCurrentRecordingManifest(value: unknown): RecordingManifest11 {
  const parsed = RecordingManifest11Schema.parse(value);
  const bytes = Buffer.byteLength(canonicalManifestJson(parsed), "utf8");
  if (bytes > MAX_MANIFEST_BYTES) {
    throw new Error(
      `[MANIFEST_TOO_LARGE] canonical manifest is ${bytes} bytes (max ${MAX_MANIFEST_BYTES})`,
    );
  }
  return parsed;
}

/** Validates a canonical manifest JSON string (size + schema + version). */
export function parseRecordingManifestJson(text: string): AnyRecordingManifest {
  if (text.length === 0) {
    throw new Error("[MANIFEST_EMPTY] manifest JSON must not be empty");
  }
  return parseRecordingManifest(JSON.parse(text));
}

// ---------------------------------------------------------------------------
// Canonical Manifest Builder (emits 1.1 only)
// ---------------------------------------------------------------------------

export interface CanonicalManifestSeed {
  recording_session_id: string;
  take_id: string;
  lesson_id: string;
  course_id: string;
  runtime_session_id: string;
  generation: number;
  encoder: EncoderDescriptor;
  epoch: { capture_clock_epoch: string; runtime_clock_epoch: string; epoch_skew_bound_us: number };
  recording_start_us: number;
  recording_end_us: number;
  tail_duration_ms: number;
  frames: {
    captured_frame_count: number;
    encoded_frame_count: number;
    dropped_frame_count: number;
    coalesced_frame_count: number;
    filler_frame_count: number;
  };
  anchors: {
    anchor_count: number;
    first_video_time_us: number;
    last_video_time_us: number;
    journal_high_seq_start: number;
    journal_high_seq_end: number;
    anchors_sha256: string;
  };
  publication_status: PublicationStatus;
  outcome: RecordingOutcome;
  terminal_cause:
    | "SUCCESS"
    | "OPERATOR_CANCELLED"
    | "RESET_INTERRUPTED"
    | "CAPTURE_SOURCE_LOST"
    | "LOW_DISK_ABORT"
    | "ENCODER_FAILED"
    | "MEDIA_VALIDATION_FAILED"
    | "APP_CLOSED"
    | "DIAGNOSTIC_PARTIAL"
    | "PREFLIGHT_REFUSED"
    | "STARTUP_TIMEOUT";
  media_sha256: string | null;
  media_size_bytes: number;
  media_validation: { verdict: "PASS" | "FAIL"; checks: { check: (typeof MEDIA_CHECK_NAMES)[number]; passed: boolean }[] } | null;
  preflight: { free_bytes_at_start: number; encoder_probe_id: string };
  app_version: string;
}

/** Builds a canonical manifest with frozen profile/geometry/audio defaults. Emits 1.1 only. */
export function buildCanonicalManifest(seed: CanonicalManifestSeed): RecordingManifest11 {
  return RecordingManifest11Schema.parse({
    manifest_version: RECORDING_MANIFEST_VERSION,
    recording_protocol_version: RECORDING_PROTOCOL_VERSION,
    recording_session_id: seed.recording_session_id,
    take_id: seed.take_id,
    lesson_id: seed.lesson_id,
    course_id: seed.course_id,
    runtime_session_id: seed.runtime_session_id,
    generation: seed.generation,
    record_safe: true,
    capture: { backend: "wgc-window", degraded: false, cursor_capture: false },
    requested_profile: CANONICAL_REQUESTED_PROFILE,
    encoder: seed.encoder,
    epoch: seed.epoch,
    recording_start_us: seed.recording_start_us,
    recording_end_us: seed.recording_end_us,
    duration_us: seed.recording_end_us - seed.recording_start_us,
    tail_duration_ms: seed.tail_duration_ms,
    frames: seed.frames,
    anchors: seed.anchors,
    publication_status: seed.publication_status,
    outcome: seed.outcome,
    terminal_cause: seed.terminal_cause,
    media_sha256: seed.media_sha256,
    media_size_bytes: seed.media_size_bytes,
    media_validation: seed.media_validation,
    audio: RESERVED_AUDIO_SLOT,
    video_width: 1920,
    video_height: 1080,
    video_fps: 30,
    preflight: {
      free_bytes_at_start: seed.preflight.free_bytes_at_start,
      geometry_verified: true,
      encoder_probe_id: seed.preflight.encoder_probe_id,
    },
    app_version: seed.app_version,
  });
}
