// P8.1 Orchestration Protocol — runtime_protocol_version = 1.
//
// Canonical authority: docs/P8-DESIGN-SPEC.md and docs/adr/ADR-0013-runtime-orchestration-boundary.md.
// This module is contract-only: pure Zod schemas, deterministic constants, closed vocabularies,
// normalized execution envelopes, retry taxonomy, and safe identifier-only DTOs.
// Zero engine execution, zero side effects, zero heavy imports.

import { z } from "zod";
import {
  MAX_ERROR_MESSAGE_LENGTH,
  RetryCategorySchema,
  RuntimeErrorCodeSchema,
  sanitizeErrorMessage,
  type RetryCategory,
  type RuntimeErrorCode,
} from "./errors.ts";

// ---------------------------------------------------------------------------
// Protocol Version
// ---------------------------------------------------------------------------

export const RUNTIME_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Canonical Bounds Constants (P8-DESIGN-SPEC Section 15 & Section 25)
// ---------------------------------------------------------------------------

/** Maximum number of journal events returned in a single snapshot page. */
export const MAX_JOURNAL_PAGE_EVENTS = 256;

/** Maximum byte size for a single journal snapshot page (256 KiB). */
export const MAX_JOURNAL_PAGE_BYTES = 262_144;

/** Maximum byte size for the in-memory global runtime journal per session (16 MiB). */
export const MAX_JOURNAL_SESSION_BYTES = 16_777_216;

/** Maximum allowable authored steps per lesson. */
export const MAX_LESSON_STEPS = 10_000;

/** Maximum length for string identifiers. */
export const MAX_IDENTIFIER_LENGTH = 128;

/** Maximum length for sanitized detail messages. */
export const MAX_DETAIL_MESSAGE_LENGTH = 512;

// ---------------------------------------------------------------------------
// Core Identifiers
// ---------------------------------------------------------------------------

/** Canonical identifier schema: 1-128 chars alphanumeric and common delimiters. */
export const RuntimeIdentifierSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export type RuntimeIdentifier = z.infer<typeof RuntimeIdentifierSchema>;

/** Runtime session identity: e.g. "sess-runtime-001". */
export const RuntimeSessionIdSchema = RuntimeIdentifierSchema;
export type RuntimeSessionId = z.infer<typeof RuntimeSessionIdSchema>;

/** Monotonic generation number: increments on each coordinated reset (starts at 1). */
export const GenerationSchema = z.number().int().min(1);
export type Generation = z.infer<typeof GenerationSchema>;

/** Execution attempt identifier: formatted as "A" + digits, e.g. "A001". */
export const AttemptIdSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(/^A\d{3,}$/);
export type AttemptId = z.infer<typeof AttemptIdSchema>;

/** Strictly increasing monotonic global journal sequence (1, 2, 3...). */
export const GlobalJournalSeqSchema = z.number().int().min(1);
export type GlobalJournalSeq = z.infer<typeof GlobalJournalSeqSchema>;

/** Course identifier: e.g. "C01". */
export const CourseIdSchema = z.string().regex(/^C\d{2}$/);
export type CourseId = z.infer<typeof CourseIdSchema>;

/** Lesson identifier: e.g. "C01-L003". */
export const LessonIdSchema = z.string().regex(/^C\d{2}-L\d{3}$/);
export type LessonId = z.infer<typeof LessonIdSchema>;

/** Scene identifier: e.g. "C01-L003-S014". */
export const SceneIdSchema = z.string().regex(/^C\d{2}-L\d{3}-S\d{3}$/);
export type SceneId = z.infer<typeof SceneIdSchema>;

/** Step identifier: authored beat id (C01-L003-S014-B001) or derived scene step id (C01-L003-S014-STEP001). */
export const StepIdSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export type StepId = z.infer<typeof StepIdSchema>;

/** Operation identifier: matches the step id for action beats. */
export const OperationIdSchema = StepIdSchema;
export type OperationId = z.infer<typeof OperationIdSchema>;

/** Logical background process identifier: e.g. "dev_server". */
export const ProcessIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export type ProcessId = z.infer<typeof ProcessIdSchema>;

/** Lowercase hex SHA-256 digest string (64 characters). */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

// ---------------------------------------------------------------------------
// Runtime States (13 Explicit States)
// ---------------------------------------------------------------------------

export const RUNTIME_STATES = [
  "CREATED",
  "VALIDATING",
  "READY",
  "RUNNING",
  "PAUSED",
  "CANCELLING",
  "CANCELLED",
  "RESETTING",
  "COMPLETED",
  "FAILED",
  "HOLD",
  "CLOSING",
  "CLOSED",
] as const;

export const RuntimeStateSchema = z.enum(RUNTIME_STATES);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

// ---------------------------------------------------------------------------
// Engine Families (Closed Vocabulary)
// ---------------------------------------------------------------------------

export const ENGINE_FAMILIES = [
  "orchestrator",
  "editor",
  "terminal",
  "browser",
  "wait",
  "narration",
  "visual",
] as const;

export const EngineFamilySchema = z.enum(ENGINE_FAMILIES);
export type EngineFamily = z.infer<typeof EngineFamilySchema>;

// ---------------------------------------------------------------------------
// Action Families & Static Routing Contract
// ---------------------------------------------------------------------------

export const ACTION_FAMILIES = ["file", "editor", "terminal", "wait", "browser", "visual"] as const;
export const ActionFamilySchema = z.enum(ACTION_FAMILIES);
export type ActionFamily = z.infer<typeof ActionFamilySchema>;

export const STEP_KINDS = ["narration", "action", "pause"] as const;
export const StepKindSchema = z.enum(STEP_KINDS);
export type StepKind = z.infer<typeof StepKindSchema>;

export const ACTION_TYPES = [
  "file_open",
  "file_create",
  "type_code",
  "replace_code",
  "file_save",
  "terminal_run",
  "terminal_stop",
  "wait",
  "browser_open",
  "browser_click",
  "browser_fill",
  "browser_press",
  "browser_refresh",
  "browser_wait",
  "browser_assert",
  "highlight",
] as const;
export const ActionTypeSchema = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof ActionTypeSchema>;

/**
 * Static routing determination: resolves the authoritative EngineFamily
 * for a compiled step without any dynamic heuristics.
 */
export function routeStepToEngineFamily(
  kind: StepKind,
  actionType?: ActionType,
  waitCondition?: "duration" | "port" | "process_output",
): EngineFamily {
  if (kind === "narration") {
    return "narration";
  }
  if (kind === "pause") {
    return "wait";
  }
  if (kind === "action") {
    switch (actionType) {
      case "file_open":
      case "file_create":
      case "type_code":
      case "replace_code":
      case "file_save":
        return "editor";

      case "terminal_run":
      case "terminal_stop":
        return "terminal";

      case "browser_open":
      case "browser_click":
      case "browser_fill":
      case "browser_press":
      case "browser_refresh":
      case "browser_wait":
      case "browser_assert":
        return "browser";

      case "wait":
        if (waitCondition === "process_output") {
          return "terminal";
        }
        return "wait";

      case "highlight":
        return "visual";

      default:
        throw new Error(`[UNSUPPORTED_ACTION_TYPE] Unknown action type '${actionType}'`);
    }
  }
  throw new Error(`[UNSUPPORTED_STEP_KIND] Unknown step kind '${kind}'`);
}

// ---------------------------------------------------------------------------
// Terminal Statuses (Normalized Engine Outcomes)
// ---------------------------------------------------------------------------

export const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED", "UNCERTAIN"] as const;
export const TerminalStatusSchema = z.enum(TERMINAL_STATUSES);
export type TerminalStatus = z.infer<typeof TerminalStatusSchema>;

// ---------------------------------------------------------------------------
// Domain Journal Reference
// ---------------------------------------------------------------------------

export const DomainJournalReferenceSchema = z.strictObject({
  engine: EngineFamilySchema,
  domain_seq: z.number().int().min(1),
});
export type DomainJournalReference = z.infer<typeof DomainJournalReferenceSchema>;

// ---------------------------------------------------------------------------
// Normalized Engine Execution Result Envelope
// ---------------------------------------------------------------------------

export const EngineExecutionDetailSchema = z.strictObject({
  code: z.string().min(1).max(MAX_IDENTIFIER_LENGTH).optional(),
  message: z.string().max(MAX_DETAIL_MESSAGE_LENGTH).optional(),
  exit_code: z.number().int().nullable().optional(),
  domain_seq: z.number().int().min(1).optional(),
  duration_ms: z.number().int().min(0),
});
export type EngineExecutionDetail = z.infer<typeof EngineExecutionDetailSchema>;

/**
 * Canonical normalized execution result envelope returned by all engine adapters.
 * Binds orchestration-level context without leaking internal command strings,
 * source code, DOM selectors, URLs, or file paths.
 */
export const EngineExecutionResultSchema = z
  .strictObject({
    status: TerminalStatusSchema,
    engine: EngineFamilySchema,
    operation_id: OperationIdSchema,
    session_id: RuntimeSessionIdSchema,
    generation: GenerationSchema,
    attempt_id: AttemptIdSchema,
    retry: RetryCategorySchema,
    detail: EngineExecutionDetailSchema,
  })
  .superRefine((res, ctx) => {
    // Invariant 1: UNCERTAIN status MUST map to UNCERTAIN_DO_NOT_RETRY
    if (res.status === "UNCERTAIN" && res.retry !== "UNCERTAIN_DO_NOT_RETRY") {
      ctx.addIssue({
        code: "custom",
        path: ["retry"],
        message: `Status 'UNCERTAIN' must have retry category 'UNCERTAIN_DO_NOT_RETRY' (got '${res.retry}')`,
      });
    }

    // Invariant 2: COMPLETED status cannot be retried (already final success)
    if (res.status === "COMPLETED" && res.retry !== "NOT_RETRYABLE") {
      ctx.addIssue({
        code: "custom",
        path: ["retry"],
        message: `Status 'COMPLETED' must have retry category 'NOT_RETRYABLE' (got '${res.retry}')`,
      });
    }

    // Invariant 3: CANCELLED status cannot be SAFE_TO_RETRY without reset/new attempt
    if (res.status === "CANCELLED" && res.retry === "SAFE_TO_RETRY") {
      ctx.addIssue({
        code: "custom",
        path: ["retry"],
        message: `Status 'CANCELLED' cannot have retry category 'SAFE_TO_RETRY'`,
      });
    }
  });

export type EngineExecutionResult = z.infer<typeof EngineExecutionResultSchema>;

// ---------------------------------------------------------------------------
// Safe Playhead DTO
// ---------------------------------------------------------------------------

export const PlayheadDtoSchema = z.strictObject({
  lesson_id: LessonIdSchema,
  scene_index: z.number().int().min(0),
  scene_id: SceneIdSchema,
  step_index: z.number().int().min(0),
  step_id: StepIdSchema,
  global_step_ordinal: z.number().int().min(1),
  total_steps: z.number().int().min(1),
  attempt_id: AttemptIdSchema,
  generation: GenerationSchema,
});
export type PlayheadDto = z.infer<typeof PlayheadDtoSchema>;

// ---------------------------------------------------------------------------
// Global Runtime Journal Event DTO
// ---------------------------------------------------------------------------

export const GlobalRuntimeEventSchema = z.strictObject({
  global_seq: GlobalJournalSeqSchema,
  timestamp_ms: z.number().int().min(0),
  runtime_session_id: RuntimeSessionIdSchema,
  generation: GenerationSchema,
  lesson_id: LessonIdSchema,
  scene_id: SceneIdSchema,
  step_id: StepIdSchema,
  kind: z.enum(["narration", "action", "pause", "lifecycle"]),
  engine: EngineFamilySchema,
  event_type: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
  attempt_id: AttemptIdSchema,
  domain_ref: DomainJournalReferenceSchema.optional(),
  outcome: TerminalStatusSchema.optional(),
  message: z.string().max(MAX_DETAIL_MESSAGE_LENGTH).optional(),
});
export type GlobalRuntimeEvent = z.infer<typeof GlobalRuntimeEventSchema>;

// ---------------------------------------------------------------------------
// Safe Runtime Snapshot DTO (Public / Presentation Safe)
// ---------------------------------------------------------------------------

export const RuntimeSnapshotDtoSchema = z.strictObject({
  runtime_session_id: RuntimeSessionIdSchema,
  lesson_id: LessonIdSchema,
  generation: GenerationSchema,
  state: RuntimeStateSchema,
  playhead: PlayheadDtoSchema,
  active_process_ids: z.array(ProcessIdSchema),
  last_outcome: TerminalStatusSchema.nullable(),
  journal_high_seq: z.number().int().min(0),
});
export type RuntimeSnapshotDto = z.infer<typeof RuntimeSnapshotDtoSchema>;

// ---------------------------------------------------------------------------
// Process Lifecycle Ledger DTO (Metadata Only)
// ---------------------------------------------------------------------------

export const PROCESS_LIFECYCLE_STATES = [
  "REGISTERED",
  "SPAWNED",
  "RUNNING",
  "STOPPING",
  "STOPPED",
  "RETIRED",
] as const;
export const ProcessLifecycleStateSchema = z.enum(PROCESS_LIFECYCLE_STATES);
export type ProcessLifecycleState = z.infer<typeof ProcessLifecycleStateSchema>;

export const ProcessLifecycleEntryDtoSchema = z.strictObject({
  process_id: ProcessIdSchema,
  started_step_id: StepIdSchema,
  stopped_step_id: StepIdSchema.optional(),
  state: ProcessLifecycleStateSchema,
});
export type ProcessLifecycleEntryDto = z.infer<typeof ProcessLifecycleEntryDtoSchema>;

// ---------------------------------------------------------------------------
// Safe Runtime Session Descriptor
// ---------------------------------------------------------------------------

export const SafeRuntimeSessionDescriptorSchema = z.strictObject({
  session_id: RuntimeSessionIdSchema,
  lesson_id: LessonIdSchema,
  generation: GenerationSchema,
  state: RuntimeStateSchema,
  created_at_ms: z.number().int().min(0),
});
export type SafeRuntimeSessionDescriptor = z.infer<typeof SafeRuntimeSessionDescriptorSchema>;

// ---------------------------------------------------------------------------
// Future Identifier-Only Request DTOs (Main/Renderer IPC Surface)
// ---------------------------------------------------------------------------

export const StartLessonRequestSchema = z.strictObject({
  session_id: RuntimeSessionIdSchema,
  request_id: RuntimeIdentifierSchema,
});
export type StartLessonRequest = z.infer<typeof StartLessonRequestSchema>;

export const PauseLessonRequestSchema = z.strictObject({
  session_id: RuntimeSessionIdSchema,
  request_id: RuntimeIdentifierSchema,
});
export type PauseLessonRequest = z.infer<typeof PauseLessonRequestSchema>;

export const ResumeLessonRequestSchema = z.strictObject({
  session_id: RuntimeSessionIdSchema,
  request_id: RuntimeIdentifierSchema,
});
export type ResumeLessonRequest = z.infer<typeof ResumeLessonRequestSchema>;

export const CancelLessonRequestSchema = z.strictObject({
  session_id: RuntimeSessionIdSchema,
  request_id: RuntimeIdentifierSchema,
});
export type CancelLessonRequest = z.infer<typeof CancelLessonRequestSchema>;

export const ResetLessonRequestSchema = z.strictObject({
  session_id: RuntimeSessionIdSchema,
  request_id: RuntimeIdentifierSchema,
});
export type ResetLessonRequest = z.infer<typeof ResetLessonRequestSchema>;

export const GetRuntimeSnapshotRequestSchema = z.strictObject({
  session_id: RuntimeSessionIdSchema,
  after_seq: z.number().int().min(0).optional(),
});
export type GetRuntimeSnapshotRequest = z.infer<typeof GetRuntimeSnapshotRequestSchema>;

// ---------------------------------------------------------------------------
// Result Envelope Factory Helpers
// ---------------------------------------------------------------------------

export function createCompletedResult(params: {
  engine: EngineFamily;
  operation_id: string;
  session_id: string;
  generation: number;
  attempt_id: string;
  exit_code?: number | null;
  domain_seq?: number;
  duration_ms: number;
}): EngineExecutionResult {
  return EngineExecutionResultSchema.parse({
    status: "COMPLETED",
    engine: params.engine,
    operation_id: params.operation_id,
    session_id: params.session_id,
    generation: params.generation,
    attempt_id: params.attempt_id,
    retry: "NOT_RETRYABLE",
    detail: {
      exit_code: params.exit_code,
      domain_seq: params.domain_seq,
      duration_ms: params.duration_ms,
    },
  });
}

export function createFailedResult(params: {
  engine: EngineFamily;
  operation_id: string;
  session_id: string;
  generation: number;
  attempt_id: string;
  code: string;
  message: string;
  exit_code?: number | null;
  domain_seq?: number;
  duration_ms: number;
  retry?: RetryCategory;
}): EngineExecutionResult {
  return EngineExecutionResultSchema.parse({
    status: "FAILED",
    engine: params.engine,
    operation_id: params.operation_id,
    session_id: params.session_id,
    generation: params.generation,
    attempt_id: params.attempt_id,
    retry: params.retry ?? "NOT_RETRYABLE",
    detail: {
      code: params.code,
      message: sanitizeErrorMessage(params.message),
      exit_code: params.exit_code,
      domain_seq: params.domain_seq,
      duration_ms: params.duration_ms,
    },
  });
}

export function createCancelledResult(params: {
  engine: EngineFamily;
  operation_id: string;
  session_id: string;
  generation: number;
  attempt_id: string;
  message?: string;
  domain_seq?: number;
  duration_ms: number;
}): EngineExecutionResult {
  return EngineExecutionResultSchema.parse({
    status: "CANCELLED",
    engine: params.engine,
    operation_id: params.operation_id,
    session_id: params.session_id,
    generation: params.generation,
    attempt_id: params.attempt_id,
    retry: "NOT_RETRYABLE",
    detail: {
      code: "OPERATION_CANCELLED",
      message: sanitizeErrorMessage(params.message ?? "Operation cancelled"),
      domain_seq: params.domain_seq,
      duration_ms: params.duration_ms,
    },
  });
}

export function createUncertainResult(params: {
  engine: EngineFamily;
  operation_id: string;
  session_id: string;
  generation: number;
  attempt_id: string;
  code: string;
  message: string;
  domain_seq?: number;
  duration_ms: number;
}): EngineExecutionResult {
  return EngineExecutionResultSchema.parse({
    status: "UNCERTAIN",
    engine: params.engine,
    operation_id: params.operation_id,
    session_id: params.session_id,
    generation: params.generation,
    attempt_id: params.attempt_id,
    retry: "UNCERTAIN_DO_NOT_RETRY",
    detail: {
      code: params.code,
      message: sanitizeErrorMessage(params.message),
      domain_seq: params.domain_seq,
      duration_ms: params.duration_ms,
    },
  });
}
