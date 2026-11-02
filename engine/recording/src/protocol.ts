// P9.1 Recording Protocol — recording_protocol_version = 1.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md and
// docs/adr/ADR-0014-screen-recording-boundary.md.
// This module is contract-only: Recording Protocol v1, recording states,
// terminal outcomes, publication status, error taxonomy with frozen retry
// mapping, safe error DTOs, snapshot DTO, trusted internal start descriptor,
// opaque capture-source token, clock-epoch correlation contract, privacy-safe
// string validation, and generation-fencing predicates.
// Zero capture, zero FFmpeg, zero Electron, zero filesystem, zero P8 imports
// (P8 and P9 are separate trust domains; P9 mirrors P8 identifier shapes
// locally instead of importing the orchestrator).

import { z } from "zod";

// ---------------------------------------------------------------------------
// Protocol Version
// ---------------------------------------------------------------------------

/** Recording Protocol v1 (frozen; distinct from P8 Runtime Protocol v1). */
export const RECORDING_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Canonical Bounds Constants (P9-DESIGN-SPEC Sections 16, 19, 21)
// ---------------------------------------------------------------------------

/** Maximum length for string identifiers (P8 resolver convention). */
export const MAX_RECORDING_IDENTIFIER_LENGTH = 128;

/** Maximum length for sanitized safe messages. */
export const MAX_SAFE_MESSAGE_LENGTH = 512;

/** Maximum take duration: P8 session ceiling 30 min + 2 s tail, in seconds. */
export const MAX_TAKE_DURATION_S = 1_802;

/** Maximum take duration in microseconds (canonical normalized unit). */
export const MAX_TAKE_DURATION_US = MAX_TAKE_DURATION_S * 1_000_000;

/** Bounded post-record tail after P8 terminal state (P9-DESIGN-SPEC 16.2). */
export const RECORDING_TAIL_MS = 2_000;

// ---------------------------------------------------------------------------
// Core Identifiers (opaque, safe: no paths, no PID/HWND/ports/usernames)
// ---------------------------------------------------------------------------

/** Canonical identifier shape: 1-128 chars, no path separators or spaces. */
export const RecordingIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_RECORDING_IDENTIFIER_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export type RecordingIdentifier = z.infer<typeof RecordingIdentifierSchema>;

/** Recording session identity: one session per take, Main-issued, opaque. */
export const RecordingSessionIdSchema = RecordingIdentifierSchema;
export type RecordingSessionId = z.infer<typeof RecordingSessionIdSchema>;

/**
 * Take identity: `t01`, `t02`, ... per (lesson, generation), Main-issued.
 * At least two digits; extensible beyond `t99` without format change.
 */
export const TakeIdSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^t\d{2,}$/);
export type TakeId = z.infer<typeof TakeIdSchema>;

/** Correlated P8 runtime session identity (opaque reference, never mutated). */
export const RecordingRuntimeSessionIdSchema = RecordingIdentifierSchema;
export type RecordingRuntimeSessionId = z.infer<
  typeof RecordingRuntimeSessionIdSchema
>;

/** Monotonic P8 generation fenced to this take (starts at 1, one per take). */
export const RecordingGenerationSchema = z.number().int().min(1);
export type RecordingGeneration = z.infer<typeof RecordingGenerationSchema>;

/** Strictly increasing P8 journal sequence referenced by anchors. */
export const RecordingGlobalSeqSchema = z.number().int().min(1);
export type RecordingGlobalSeq = z.infer<typeof RecordingGlobalSeqSchema>;

/** Course identifier mirror (e.g. "C01"; standalone, no shared-types import). */
export const RecordingCourseIdSchema = z.string().regex(/^C\d{2}$/);
export type RecordingCourseId = z.infer<typeof RecordingCourseIdSchema>;

/** Lesson identifier mirror (e.g. "C01-L003"). */
export const RecordingLessonIdSchema = z.string().regex(/^C\d{2}-L\d{3}$/);
export type RecordingLessonId = z.infer<typeof RecordingLessonIdSchema>;

/** Scene identifier mirror (e.g. "C01-L003-S014"). */
export const RecordingSceneIdSchema = z.string().regex(/^C\d{2}-L\d{3}-S\d{3}$/);
export type RecordingSceneId = z.infer<typeof RecordingSceneIdSchema>;

/** Step identifier mirror (authored beat id or derived scene step id). */
export const RecordingStepIdSchema = RecordingIdentifierSchema;
export type RecordingStepId = z.infer<typeof RecordingStepIdSchema>;

/** 1-based ordinal of the step within the authored lesson plan. */
export const GlobalStepOrdinalSchema = z.number().int().min(1);
export type GlobalStepOrdinal = z.infer<typeof GlobalStepOrdinalSchema>;

/** Lowercase hex SHA-256 digest (media digest convention: lowercase only). */
export const RecordingSha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type RecordingSha256Hex = z.infer<typeof RecordingSha256HexSchema>;

// ---------------------------------------------------------------------------
// Timestamp Model (canonical normalized unit: integer microseconds)
// ---------------------------------------------------------------------------

/**
 * Canonical microsecond timestamp: integer, non-negative, JSON-safe.
 * Zod rejects NaN/Infinity/fractional values natively (proven by unit test).
 * Raw QPC ticks are never user-facing contract (P9.2/P9.4 own QPC mapping).
 */
export const MicrosecondSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export type Microsecond = z.infer<typeof MicrosecondSchema>;

/** Take-relative duration bound: 0 .. 30 min + 2 s tail ceiling. */
export const TakeDurationUsSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_TAKE_DURATION_US);
export type TakeDurationUs = z.infer<typeof TakeDurationUsSchema>;

/** P8 journal millisecond timestamp mirror (P8 `timestamp_ms` domain). */
export const RuntimeMonotonicMsSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export type RuntimeMonotonicMs = z.infer<typeof RuntimeMonotonicMsSchema>;

// ---------------------------------------------------------------------------
// Recording States (P9-DESIGN-SPEC Section 16 lifecycle table)
// ---------------------------------------------------------------------------

export const RECORDING_STATES = [
  "CREATED",
  "PREFLIGHT",
  "PREPARED",
  "RECORDING",
  "STOPPING",
  "VALIDATING",
  "PUBLISHED",
  "FAILED",
  "INCOMPLETE",
  "CLOSED",
] as const;

export const RecordingStateSchema = z.enum(RECORDING_STATES);
export type RecordingState = z.infer<typeof RecordingStateSchema>;

// ---------------------------------------------------------------------------
// Terminal Outcomes (P9-DESIGN-SPEC Section 15 manifest `outcome` buckets)
// ---------------------------------------------------------------------------

export const RECORDING_OUTCOMES = [
  "COMPLETED",
  "CANCELLED",
  "RESET_INTERRUPTED",
  "FAILED",
  "INCOMPLETE",
] as const;

export const RecordingOutcomeSchema = z.enum(RECORDING_OUTCOMES);
export type RecordingOutcome = z.infer<typeof RecordingOutcomeSchema>;

// ---------------------------------------------------------------------------
// Terminal Causes (stable machine-readable codes; never collapsed to FAILED)
// ---------------------------------------------------------------------------

export const RECORDING_TERMINAL_CAUSES = [
  "SUCCESS",
  "OPERATOR_CANCELLED",
  "RESET_INTERRUPTED",
  "CAPTURE_SOURCE_LOST",
  "LOW_DISK_ABORT",
  "ENCODER_FAILED",
  "MEDIA_VALIDATION_FAILED",
  "APP_CLOSED",
  "DIAGNOSTIC_PARTIAL",
  "PREFLIGHT_REFUSED",
  "STARTUP_TIMEOUT",
] as const;

export const RecordingTerminalCauseSchema = z.enum(RECORDING_TERMINAL_CAUSES);
export type RecordingTerminalCause = z.infer<
  typeof RecordingTerminalCauseSchema
>;

/** Frozen mapping from fine-grained terminal cause to design outcome bucket. */
export const TERMINAL_CAUSE_TO_OUTCOME: Record<
  RecordingTerminalCause,
  RecordingOutcome
> = {
  SUCCESS: "COMPLETED",
  OPERATOR_CANCELLED: "CANCELLED",
  RESET_INTERRUPTED: "RESET_INTERRUPTED",
  CAPTURE_SOURCE_LOST: "FAILED",
  LOW_DISK_ABORT: "INCOMPLETE",
  ENCODER_FAILED: "FAILED",
  MEDIA_VALIDATION_FAILED: "FAILED",
  APP_CLOSED: "INCOMPLETE",
  DIAGNOSTIC_PARTIAL: "FAILED",
  PREFLIGHT_REFUSED: "INCOMPLETE",
  STARTUP_TIMEOUT: "INCOMPLETE",
};

export function terminalCauseToOutcome(
  cause: RecordingTerminalCause,
): RecordingOutcome {
  return TERMINAL_CAUSE_TO_OUTCOME[cause];
}

// ---------------------------------------------------------------------------
// Publication Status (artifact lifecycle; FAILED/HOLD/CANCELLED never valid)
// ---------------------------------------------------------------------------

export const PUBLICATION_STATUSES = [
  "NOT_CREATED",
  "TEMPORARY",
  "QUARANTINED",
  "VALIDATED",
  "PUBLISHED",
  "PURGED",
] as const;

export const PublicationStatusSchema = z.enum(PUBLICATION_STATUSES);
export type PublicationStatus = z.infer<typeof PublicationStatusSchema>;

// ---------------------------------------------------------------------------
// Recording Phases (error attribution; closed vocabulary)
// ---------------------------------------------------------------------------

export const RECORDING_PHASES = [
  "PREFLIGHT",
  "ACQUISITION",
  "ENCODING",
  "VALIDATION",
  "PUBLICATION",
  "CLEANUP",
  "SHUTDOWN",
] as const;

export const RecordingPhaseSchema = z.enum(RECORDING_PHASES);
export type RecordingPhase = z.infer<typeof RecordingPhaseSchema>;

// ---------------------------------------------------------------------------
// Error Taxonomy (bounded, stable; raw native/FFmpeg errors never exposed)
// ---------------------------------------------------------------------------

export const RECORDING_ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_IDENTITY",
  "STALE_SESSION",
  "STALE_GENERATION",
  "RECORDER_ALREADY_ACTIVE",
  "DISK_PREFLIGHT_FAILED",
  "LOW_DISK_ABORT",
  "CAPTURE_SOURCE_LOST",
  "WINDOW_GEOMETRY_MISMATCH",
  "FRAME_TIMEOUT",
  "CAPTURE_BACKPRESSURE_EXCEEDED",
  "ENCODER_UNAVAILABLE",
  "ENCODER_START_FAILED",
  "ENCODER_FAILED",
  "ENCODER_TIMEOUT",
  "MEDIA_VALIDATION_FAILED",
  "TIMELINE_INVALID",
  "PUBLICATION_FAILED",
  "CLEANUP_UNCONFIRMED",
] as const;

export const RecordingErrorCodeSchema = z.enum(RECORDING_ERROR_CODES);
export type RecordingErrorCode = z.infer<typeof RecordingErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Retry Taxonomy (P8-compatible closed categories; no automatic blind retry)
// ---------------------------------------------------------------------------

export const RECORDING_RETRY_CATEGORIES = [
  "SAFE_TO_RETRY",
  "NOT_RETRYABLE",
  "REQUIRES_RESET",
  "UNCERTAIN_DO_NOT_RETRY",
] as const;

export const RecordingRetryCategorySchema = z.enum(RECORDING_RETRY_CATEGORIES);
export type RecordingRetryCategory = z.infer<
  typeof RecordingRetryCategorySchema
>;

/**
 * Frozen error -> retry mapping. No automatic retry semantics for partial
 * recording, publication, reset-interrupted takes, or uncertain cleanup:
 * none of those codes map to SAFE_TO_RETRY (enforced by unit test over this
 * table and by the DTO invariant below).
 */
export const RECORDING_ERROR_RETRY_MAP: Record<
  RecordingErrorCode,
  RecordingRetryCategory
> = {
  INVALID_REQUEST: "NOT_RETRYABLE",
  INVALID_IDENTITY: "NOT_RETRYABLE",
  STALE_SESSION: "REQUIRES_RESET",
  STALE_GENERATION: "REQUIRES_RESET",
  RECORDER_ALREADY_ACTIVE: "NOT_RETRYABLE",
  DISK_PREFLIGHT_FAILED: "NOT_RETRYABLE",
  LOW_DISK_ABORT: "NOT_RETRYABLE",
  CAPTURE_SOURCE_LOST: "NOT_RETRYABLE",
  WINDOW_GEOMETRY_MISMATCH: "NOT_RETRYABLE",
  FRAME_TIMEOUT: "NOT_RETRYABLE",
  CAPTURE_BACKPRESSURE_EXCEEDED: "NOT_RETRYABLE",
  ENCODER_UNAVAILABLE: "NOT_RETRYABLE",
  ENCODER_START_FAILED: "NOT_RETRYABLE",
  ENCODER_FAILED: "NOT_RETRYABLE",
  ENCODER_TIMEOUT: "NOT_RETRYABLE",
  MEDIA_VALIDATION_FAILED: "NOT_RETRYABLE",
  TIMELINE_INVALID: "NOT_RETRYABLE",
  PUBLICATION_FAILED: "NOT_RETRYABLE",
  CLEANUP_UNCONFIRMED: "UNCERTAIN_DO_NOT_RETRY",
};

// ---------------------------------------------------------------------------
// Privacy-Safe String Validation (lightweight guard, not a DLP engine)
// ---------------------------------------------------------------------------

const WINDOWS_ABSOLUTE_PATH = /[A-Za-z]:[\\/][^\s"'`)]*/;
const UNC_PATH = /\\\\[^\s"'`)]*/;
const POSIX_ABSOLUTE_PATH = /(^|[\s("'])(\/[\w.-]+(\/[\w.-]+)+)/;
const CONTROL_OR_NEWLINE = /[\u0000-\u001F\u007F]/;

/** Returns true when free text is safe for renderer/log-facing DTO fields. */
export function isPrivacySafeText(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (CONTROL_OR_NEWLINE.test(value)) {
    return false;
  }
  if (WINDOWS_ABSOLUTE_PATH.test(value)) {
    return false;
  }
  if (UNC_PATH.test(value)) {
    return false;
  }
  if (POSIX_ABSOLUTE_PATH.test(value)) {
    return false;
  }
  return true;
}

/**
 * Sanitizes a diagnostic message for safe DTO inclusion: redacts host paths,
 * strips stack-trace lines, collapses whitespace, caps length. Local to P9
 * (no P8 dependency inversion; mirrors the P8 sanitizer contract).
 */
export function sanitizeRecordingMessage(message: string): string {
  if (typeof message !== "string") {
    return "[sanitized error]";
  }
  let clean = message;
  clean = clean.replace(/(?:\r?\n|^)\s*at\s+[^\n]*\([^)]+\)/g, " ");
  clean = clean.replace(/\r?\n\s*at\s+.*(?:\r?\n|$)/g, " ");
  clean = clean.replace(/[A-Za-z]:[\\/][^\s"'`)]*/g, "[path]");
  clean = clean.replace(/\\\\[^\s"'`)]*/g, "[path]");
  clean = clean.replace(/(^|[\s("'])(\/[\w.-]+(\/[\w.-]+)+)/g, "$1[path]");
  clean = clean.replace(/\s+/g, " ").trim();
  if (clean.length > MAX_SAFE_MESSAGE_LENGTH) {
    clean = clean.slice(0, MAX_SAFE_MESSAGE_LENGTH - 3) + "...";
  }
  return clean || "[sanitized error]";
}

/** Privacy-safe free-text field: bounded + rejects host paths/control chars. */
export const PrivacySafeTextSchema = z
  .string()
  .min(1)
  .max(MAX_SAFE_MESSAGE_LENGTH)
  .refine(isPrivacySafeText, {
    message: "text must not contain host paths or control characters",
  });
export type PrivacySafeText = z.infer<typeof PrivacySafeTextSchema>;

// ---------------------------------------------------------------------------
// Safe Recording Error DTO (renderer/log-safe; fail-closed on unknown keys)
// ---------------------------------------------------------------------------

export const RecordingErrorDtoSchema = z
  .strictObject({
    code: RecordingErrorCodeSchema,
    message: z.string().min(1).max(MAX_SAFE_MESSAGE_LENGTH),
    retry: RecordingRetryCategorySchema,
    recording_session_id: RecordingSessionIdSchema.optional(),
    take_id: TakeIdSchema.optional(),
    phase: RecordingPhaseSchema.optional(),
  })
  .superRefine((err, ctx) => {
    // Invariant: retry category must equal the frozen per-code mapping.
    const expected = RECORDING_ERROR_RETRY_MAP[err.code];
    if (err.retry !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["retry"],
        message: `Error code '${err.code}' must have retry category '${expected}' (got '${err.retry}')`,
      });
    }
    // Invariant: uncertain cleanup is never retried automatically.
    if (
      err.code === "CLEANUP_UNCONFIRMED" &&
      err.retry !== "UNCERTAIN_DO_NOT_RETRY"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["retry"],
        message: "CLEANUP_UNCONFIRMED must be UNCERTAIN_DO_NOT_RETRY",
      });
    }
  });

export type RecordingErrorDto = z.infer<typeof RecordingErrorDtoSchema>;

/** Builds a sanitized error DTO with the frozen retry mapping applied. */
export function toRecordingErrorDto(input: {
  code: RecordingErrorCode;
  message: string;
  recording_session_id?: string;
  take_id?: string;
  phase?: RecordingPhase;
}): RecordingErrorDto {
  return RecordingErrorDtoSchema.parse({
    code: input.code,
    message: sanitizeRecordingMessage(input.message),
    retry: RECORDING_ERROR_RETRY_MAP[input.code],
    ...(input.recording_session_id === undefined
      ? {}
      : { recording_session_id: input.recording_session_id }),
    ...(input.take_id === undefined ? {} : { take_id: input.take_id }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
  });
}

// ---------------------------------------------------------------------------
// Recording Snapshot DTO (bounded status for future RecordingHost/UI use)
// ---------------------------------------------------------------------------

export const RecordingSnapshotDtoSchema = z.strictObject({
  recording_session_id: RecordingSessionIdSchema,
  take_id: TakeIdSchema,
  state: RecordingStateSchema,
  runtime_session_id: RecordingRuntimeSessionIdSchema,
  generation: RecordingGenerationSchema,
  elapsed_us: TakeDurationUsSchema,
  captured_frames: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  encoded_frames: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  dropped_frames: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  filler_frames: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  encoder_family: z.enum(["NVENC", "LIBX264"]),
  record_safe: z.literal(true),
  last_outcome: RecordingOutcomeSchema.nullable(),
});

export type RecordingSnapshotDto = z.infer<typeof RecordingSnapshotDtoSchema>;

// ---------------------------------------------------------------------------
// Trusted Internal Start Descriptor (Main-side only; never renderer-facing)
// ---------------------------------------------------------------------------

export const RECORDING_PROFILE_ID = "rec-1080p30-h264-v1";

/**
 * Internal descriptor for future Main-side RecordingHost construction.
 * Accepts lesson/runtime correlation + profile id + privacy flag ONLY.
 * No paths, no codec args, no window titles, no HWND, no FFmpeg args —
 * those keys are structurally impossible (strictObject).
 */
export const InternalRecordingStartDescriptorSchema = z.strictObject({
  lesson_id: RecordingLessonIdSchema,
  runtime_session_id: RecordingRuntimeSessionIdSchema,
  generation: RecordingGenerationSchema,
  take_id: TakeIdSchema,
  recording_profile_id: z.literal(RECORDING_PROFILE_ID),
  record_safe: z.literal(true),
});

export type InternalRecordingStartDescriptor = z.infer<
  typeof InternalRecordingStartDescriptorSchema
>;

// ---------------------------------------------------------------------------
// Opaque Internal Capture-Source Token (never crosses trust boundaries)
// ---------------------------------------------------------------------------

/**
 * Opaque capture-source token type. Main-side only: P9.2/P9.5 resolve the
 * native window handle behind this token. Raw HWND values never appear in
 * manifests, anchors, snapshots, or any cross-boundary schema (proven by
 * hostile-field tests: those schemas structurally reject `hwnd`).
 */
export const CaptureSourceTokenSchema = RecordingIdentifierSchema;
export type CaptureSourceToken = z.infer<typeof CaptureSourceTokenSchema>;

// ---------------------------------------------------------------------------
// Clock-Epoch Correlation Contract (normalized; no platform internals)
// ---------------------------------------------------------------------------

/**
 * Session epoch mapping metadata. Carries opaque epoch identities plus the
 * bounded skew guarantee — enough for P9.4 to validate correlation without
 * exposing QPC ticks, handle data, or any platform internals. Mapping
 * implementation is P9.4 scope; this is the contract shape only.
 */
export const RecordingEpochSchema = z.strictObject({
  capture_clock_epoch: RecordingIdentifierSchema,
  runtime_clock_epoch: RecordingIdentifierSchema,
  epoch_skew_bound_us: MicrosecondSchema,
});

export type RecordingEpoch = z.infer<typeof RecordingEpochSchema>;

// ---------------------------------------------------------------------------
// Generation Fencing Predicates (pure contract helpers; enforcement is later)
// ---------------------------------------------------------------------------

/** Minimal identity envelope every fenced timeline record must carry. */
export const TakeFenceSchema = z.strictObject({
  recording_session_id: RecordingSessionIdSchema,
  runtime_session_id: RecordingRuntimeSessionIdSchema,
  generation: RecordingGenerationSchema,
});

export type TakeFence = z.infer<typeof TakeFenceSchema>;

/**
 * True when a timeline record belongs to the take (all three fence fields
 * equal). Old-generation frame events, runtime anchors, capture callbacks,
 * and encoder acknowledgements failing this predicate are rejectable later.
 */
export function matchesTakeFence(
  record: TakeFence,
  take: TakeFence,
): boolean {
  return (
    record.recording_session_id === take.recording_session_id &&
    record.runtime_session_id === take.runtime_session_id &&
    record.generation === take.generation
  );
}

/** True when the record's generation differs from the take's (stale). */
export function isStaleGeneration(record: TakeFence, take: TakeFence): boolean {
  return record.generation !== take.generation;
}
