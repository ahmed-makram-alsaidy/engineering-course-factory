// P8.4 Base Engine Adapter Contract & Common Types
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 10 & Section 32, and ADR-0013.
// Standardized narrow adapter interface between P8 orchestration protocol
// and domain execution engines. Identifier-only, decoupled, fail-closed.
// Adapters translate:
//   trusted validated operation identity
//             ↓
//   domain engine invocation
//             ↓
//   domain result/error
//             ↓
//   P8 normalized EngineExecutionResult
//
// P8 adapters do NOT own domain semantics, do NOT advance playhead,
// do NOT mutate global state machine, and do NOT write global journal events.

import type { CompiledStep } from "@course-factory/lesson-compiler/ir";
import type { ValidatedRuntimePlan } from "../validator.ts";
import {
  type ActionType,
  type AttemptId,
  type EngineExecutionResult,
  type EngineFamily,
  type Generation,
  type OperationId,
  type RuntimeSessionId,
  type StepId,
  type StepKind,
  createCancelledResult,
  createCompletedResult,
  createFailedResult,
  createUncertainResult,
} from "../protocol.ts";
import {
  RuntimeError,
  type RetryCategory,
  type RuntimeErrorCode,
  sanitizeErrorMessage,
} from "../errors.ts";

// ---------------------------------------------------------------------------
// Step Routing Resolution Helper
// ---------------------------------------------------------------------------

export function resolveStepRouting(step: CompiledStep): {
  kind: StepKind;
  actionType?: ActionType;
  waitCondition?: "duration" | "port" | "process_output";
} {
  if (step.kind === "narration") {
    return { kind: "narration" };
  }
  if (step.kind === "pause") {
    return { kind: "pause" };
  }
  const op = step.operation;
  const params = op.parameters as unknown as { type: string; until?: "duration" | "port" | "process_output" };
  const waitCond = op.type === "wait" ? params.until : undefined;

  return {
    kind: "action",
    actionType: op.type as ActionType,
    waitCondition: waitCond,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator Context (Passed into admit)
// ---------------------------------------------------------------------------

export interface OrchestratorContext {
  /** Trusted runtime session identifier */
  readonly runtime_session_id: RuntimeSessionId;
  /** Monotonic generation number */
  readonly generation: Generation;
  /** Authored lesson identifier */
  readonly lesson_id: string;
  /** Current attempt identifier (e.g. "A001") */
  readonly attempt_id: AttemptId;
  /** Immutable validated runtime plan from P8.2 */
  readonly plan: ValidatedRuntimePlan;
  /** Optional cancellation signal */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Common Adapter Admission Record
// ---------------------------------------------------------------------------

export interface CommonAdapterAdmission {
  readonly admissionId: string;
  readonly operationId: OperationId;
  readonly sessionId: RuntimeSessionId;
  readonly generation: Generation;
  readonly attemptId: AttemptId;
  readonly lessonId: string;
  readonly stepId: StepId;
  readonly engine: EngineFamily;

  // Protocol aliases (snake_case)
  readonly admission_id: string;
  readonly operation_id: OperationId;
  readonly session_id: RuntimeSessionId;
  readonly attempt_id: AttemptId;
  readonly lesson_id: string;
  readonly step_id: StepId;
}

/**
 * Creates a deeply-frozen canonical CommonAdapterAdmission record.
 */
export function createCommonAdmission<T extends Record<string, unknown>>(
  params: {
    admissionId: string;
    operationId: string;
    sessionId: string;
    generation: number;
    attemptId: string;
    lessonId: string;
    stepId: string;
    engine: EngineFamily;
  } & T,
): CommonAdapterAdmission & T {
  return Object.freeze({
    ...params,
    admission_id: params.admissionId,
    operation_id: params.operationId,
    session_id: params.sessionId,
    attempt_id: params.attemptId,
    lesson_id: params.lessonId,
    step_id: params.stepId,
  });
}

// ---------------------------------------------------------------------------
// Base Engine Adapter Interface (P8-DESIGN-SPEC Section 10)
// ---------------------------------------------------------------------------

export interface EngineAdapter<TAdmission extends CommonAdapterAdmission = CommonAdapterAdmission> {
  /** Owning engine family */
  readonly family: EngineFamily;

  /**
   * Validates preconditions and creates an immutable admission record.
   * Fails closed if session, generation, attempt, or engine family mismatch.
   */
  admit(step: CompiledStep, context: OrchestratorContext): Promise<TAdmission>;

  /**
   * Executes the admitted operation with cancellation support.
   * Returns a normalized EngineExecutionResult envelope.
   * Never throws for expected domain failures; always returns a valid envelope.
   */
  execute(admission: TAdmission, signal: AbortSignal): Promise<EngineExecutionResult>;

  /**
   * Aborts the currently active operation for this engine.
   * Must await honest domain settlement.
   */
  cancel(operationId: string): Promise<void>;

  /**
   * Resets domain state for a new generation.
   * Scope is confined strictly to this adapter's domain resources.
   */
  reset(generation: number): Promise<void>;

  /**
   * Permanently disposes engine resources.
   * Scope is confined strictly to this adapter's domain resources.
   */
  close(): Promise<void>;

  /**
   * Suspends an interruptible active operation (e.g. wait or narration timer).
   * Irreversible domain operations (terminal, browser, editor) do not implement this.
   */
  suspend?(): void;

  /**
   * Resumes a previously suspended interruptible operation.
   */
  resumeTimer?(): void;

  /**
   * Verifies that all domain resources have been cleanly torn down.
   * Used by the absence barrier before rotating generation.
   */
  isClean?(): Promise<boolean> | boolean;
}

// ---------------------------------------------------------------------------
// Normalization Helper Utilities
// ---------------------------------------------------------------------------

export interface NormalizeResultParams {
  engine: EngineFamily;
  admission: CommonAdapterAdmission;
  duration_ms: number;
  domain_seq?: number;
}

export function normalizeSuccess(
  params: NormalizeResultParams & { exit_code?: number | null },
): EngineExecutionResult {
  return createCompletedResult({
    engine: params.engine,
    operation_id: params.admission.operationId,
    session_id: params.admission.sessionId,
    generation: params.admission.generation,
    attempt_id: params.admission.attemptId,
    exit_code: params.exit_code,
    domain_seq: params.domain_seq,
    duration_ms: Math.max(0, Math.round(params.duration_ms)),
  });
}

export function normalizeFailure(
  params: NormalizeResultParams & {
    code: string;
    message: string;
    exit_code?: number | null;
    retry?: RetryCategory;
  },
): EngineExecutionResult {
  return createFailedResult({
    engine: params.engine,
    operation_id: params.admission.operationId,
    session_id: params.admission.sessionId,
    generation: params.admission.generation,
    attempt_id: params.admission.attemptId,
    code: params.code,
    message: sanitizeErrorMessage(params.message),
    exit_code: params.exit_code,
    domain_seq: params.domain_seq,
    duration_ms: Math.max(0, Math.round(params.duration_ms)),
    retry: params.retry ?? "NOT_RETRYABLE",
  });
}

export function normalizeCancellation(
  params: NormalizeResultParams & { message?: string },
): EngineExecutionResult {
  return createCancelledResult({
    engine: params.engine,
    operation_id: params.admission.operationId,
    session_id: params.admission.sessionId,
    generation: params.admission.generation,
    attempt_id: params.admission.attemptId,
    message: sanitizeErrorMessage(params.message ?? "Operation cancelled"),
    domain_seq: params.domain_seq,
    duration_ms: Math.max(0, Math.round(params.duration_ms)),
  });
}

export function normalizeUncertainty(
  params: NormalizeResultParams & { code: string; message: string },
): EngineExecutionResult {
  return createUncertainResult({
    engine: params.engine,
    operation_id: params.admission.operationId,
    session_id: params.admission.sessionId,
    generation: params.admission.generation,
    attempt_id: params.admission.attemptId,
    code: params.code,
    message: sanitizeErrorMessage(params.message),
    domain_seq: params.domain_seq,
    duration_ms: Math.max(0, Math.round(params.duration_ms)),
  });
}

// ---------------------------------------------------------------------------
// Pre-Dispatch Fencing Check
// ---------------------------------------------------------------------------

export function fenceAdapterInvocation(
  adapterFamily: EngineFamily,
  stepFamily: EngineFamily,
  context: OrchestratorContext,
  activeSessionId?: string,
  activeGeneration?: number,
): void {
  // 1. Wrong engine family
  if (stepFamily !== adapterFamily) {
    throw new RuntimeError({
      code: "ENGINE_DISPATCH_FAILED",
      message: `Step routed to family '${stepFamily}' cannot be dispatched to '${adapterFamily}' adapter`,
      requestId: null,
      stepId: undefined,
    });
  }

  // 2. Session fencing
  if (activeSessionId !== undefined && context.runtime_session_id !== activeSessionId) {
    throw new RuntimeError({
      code: "STALE_RUNTIME_SESSION",
      message: `Request session '${context.runtime_session_id}' does not match active session '${activeSessionId}'`,
      requestId: null,
      stepId: undefined,
    });
  }

  // 3. Generation fencing
  if (activeGeneration !== undefined && context.generation !== activeGeneration) {
    throw new RuntimeError({
      code: "STALE_GENERATION",
      message: `Request generation ${context.generation} does not match active generation ${activeGeneration}`,
      requestId: null,
      stepId: undefined,
    });
  }
}
