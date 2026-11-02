// P8.4 Editor Runtime Adapter (P6 Workspace & Typing Engine Wrapper)
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 10, Section 12, Section 32, and ADR-0013.
// Coordinates file and editor actions:
// - file_open
// - file_create
// - type_code
// - replace_code
// - file_save
//
// Preserves:
// - P6 WorkspaceCoordinator authority
// - Main-owned unsaved buffers
// - Monaco projection only (zero Monaco in P8)
// - Disk committed authority via WindowsFileAdapter
// - Access epochs and generation fencing
// - Atomic NTFS publications
// - External conflict detection
// - COMMIT_UNCERTAIN semantics (maps to UNCERTAIN / UNCERTAIN_DO_NOT_RETRY)
//
// P8 never manipulates the filesystem, Monaco, or file contents directly.

import type { CompiledStep } from "@course-factory/lesson-compiler/ir";
import {
  type CommonAdapterAdmission,
  type EngineAdapter,
  type OrchestratorContext,
  createCommonAdmission,
  fenceAdapterInvocation,
  normalizeCancellation,
  normalizeFailure,
  normalizeSuccess,
  normalizeUncertainty,
  resolveStepRouting,
} from "./adapter.ts";
import {
  type EngineExecutionResult,
  routeStepToEngineFamily,
} from "../protocol.ts";
import { RuntimeError, type RetryCategory } from "../errors.ts";
import { type Clock, SystemMonotonicClock } from "../clock.ts";

// ---------------------------------------------------------------------------
// Editor Admission Record
// ---------------------------------------------------------------------------

export interface EditorAdapterAdmission extends CommonAdapterAdmission {
  readonly actionType: "file_open" | "file_create" | "type_code" | "replace_code" | "file_save";
  readonly targetPath?: string;
}

// ---------------------------------------------------------------------------
// Editor Domain Session Port (Narrow main-held interface)
// ---------------------------------------------------------------------------

export interface EditorDomainOutcome<T = unknown> {
  readonly ok: boolean;
  readonly value?: T;
  readonly domain_seq?: number;
  readonly rejection?: {
    readonly code: string;
    readonly message: string;
    readonly retry?: RetryCategory;
  };
}

export interface EditorDomainSession {
  readonly sessionId: string;
  readonly generation: number;
  admit(operationId: string, requestId: string): Promise<EditorDomainOutcome> | EditorDomainOutcome;
  execute(admission: EditorAdapterAdmission, signal: AbortSignal): Promise<EditorDomainOutcome>;
  cancel(operationId: string): Promise<void> | void;
  reset(generation: number): Promise<void> | void;
  close(): Promise<void> | void;
  getJournalSeq?(): number;
}

// ---------------------------------------------------------------------------
// EditorRuntimeAdapter Options
// ---------------------------------------------------------------------------

export interface EditorRuntimeAdapterOptions {
  readonly session?: EditorDomainSession;
  readonly getSession?: () => EditorDomainSession | null;
  readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// EditorRuntimeAdapter Implementation
// ---------------------------------------------------------------------------

export class EditorRuntimeAdapter implements EngineAdapter<EditorAdapterAdmission> {
  readonly family = "editor" as const;

  private activeSession: EditorDomainSession | null = null;
  private readonly getSessionFn?: () => EditorDomainSession | null;
  private readonly clock: Clock;
  private inFlightOperationId: string | null = null;

  constructor(options: EditorRuntimeAdapterOptions = {}) {
    this.activeSession = options.session ?? null;
    this.getSessionFn = options.getSession;
    this.clock = options.clock ?? new SystemMonotonicClock();
  }

  setSession(session: EditorDomainSession | null): void {
    this.activeSession = session;
  }

  private resolveSession(): EditorDomainSession {
    const session = this.activeSession ?? this.getSessionFn?.() ?? null;
    if (!session) {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Editor engine domain session is not bound or unavailable",
      });
    }
    return session;
  }

  async admit(step: CompiledStep, context: OrchestratorContext): Promise<EditorAdapterAdmission> {
    // 1. Static family routing check
    const routing = resolveStepRouting(step);
    const stepFamily = routeStepToEngineFamily(routing.kind, routing.actionType, routing.waitCondition);

    if (stepFamily !== this.family) {
      throw new RuntimeError({
        code: "ENGINE_DISPATCH_FAILED",
        message: `Step routed to family '${stepFamily}' cannot be dispatched to '${this.family}' adapter`,
        stepId: step.step_id,
      });
    }

    const session = this.resolveSession();
    fenceAdapterInvocation(this.family, stepFamily, context, session.sessionId, session.generation);

    // 2. Action type validation for editor family
    if (step.kind !== "operation") {
      throw new RuntimeError({
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Editor adapter received unsupported step kind '${step.kind}'`,
        stepId: step.step_id,
      });
    }

    const type = step.operation.type;
    if (
      type !== "file_open" &&
      type !== "file_create" &&
      type !== "type_code" &&
      type !== "replace_code" &&
      type !== "file_save"
    ) {
      throw new RuntimeError({
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Action '${type}' is not owned by Editor engine`,
        stepId: step.step_id,
      });
    }

    // 3. Delegate admission check to domain session
    const domainAdmission = await session.admit(step.step_id, `req-admit-${step.step_id}-${context.attempt_id}`);
    if (!domainAdmission.ok) {
      const rej = domainAdmission.rejection ?? { code: "ENGINE_DISPATCH_FAILED", message: "Editor admission rejected" };
      throw new RuntimeError({
        code: rej.code === "STALE_GENERATION" || rej.code === "STALE_SESSION" ? "STALE_GENERATION" : "ENGINE_DISPATCH_FAILED",
        message: rej.message,
        stepId: step.step_id,
      });
    }

    const path = "path" in step.operation.parameters ? (step.operation.parameters as { path: string }).path : undefined;

    return createCommonAdmission({
      admissionId: `adm-editor-${step.step_id}-${context.attempt_id}`,
      operationId: step.step_id,
      sessionId: context.runtime_session_id,
      generation: context.generation,
      attemptId: context.attempt_id,
      lessonId: context.lesson_id,
      stepId: step.step_id,
      engine: this.family,
      actionType: type as EditorAdapterAdmission["actionType"],
      targetPath: path,
    });
  }

  async execute(admission: EditorAdapterAdmission, signal: AbortSignal): Promise<EngineExecutionResult> {
    const session = this.resolveSession();
    const startMs = this.clock.now();

    // 1. Verify admission fencing before domain call
    if (admission.sessionId !== session.sessionId) {
      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: 0,
        code: "STALE_RUNTIME_SESSION",
        message: `Admission session '${admission.sessionId}' does not match active session '${session.sessionId}'`,
        retry: "REQUIRES_RESET",
      });
    }

    if (admission.generation !== session.generation) {
      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: 0,
        code: "STALE_GENERATION",
        message: `Admission generation ${admission.generation} does not match active generation ${session.generation}`,
        retry: "REQUIRES_RESET",
      });
    }

    // 2. Check early cancellation
    if (signal.aborted) {
      return normalizeCancellation({
        engine: this.family,
        admission,
        duration_ms: 0,
        message: "Operation cancelled before execution",
      });
    }

    this.inFlightOperationId = admission.operationId;

    try {
      // 3. Delegate to domain engine
      const domainOutcome = await session.execute(admission, signal);
      const elapsedMs = this.clock.now() - startMs;

      // Check if cancelled during execution
      if (signal.aborted) {
        return normalizeCancellation({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          domain_seq: domainOutcome.domain_seq,
          message: "Operation cancelled during execution",
        });
      }

      if (domainOutcome.ok) {
        return normalizeSuccess({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          domain_seq: domainOutcome.domain_seq,
        });
      }

      const rej = domainOutcome.rejection ?? { code: "ENGINE_DISPATCH_FAILED", message: "Editor execution failed" };

      // Invariant: COMMIT_UNCERTAIN maps strictly to UNCERTAIN / UNCERTAIN_DO_NOT_RETRY
      if (rej.code === "COMMIT_UNCERTAIN") {
        return normalizeUncertainty({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          code: "COMMIT_UNCERTAIN",
          message: rej.message,
          domain_seq: domainOutcome.domain_seq,
        });
      }

      // Cancellation check from domain
      if (rej.code === "OPERATION_CANCELLED") {
        return normalizeCancellation({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          domain_seq: domainOutcome.domain_seq,
          message: rej.message,
        });
      }

      // Stale session or generation requires reset
      if (rej.code === "STALE_SESSION" || rej.code === "STALE_GENERATION") {
        return normalizeFailure({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          code: rej.code,
          message: rej.message,
          domain_seq: domainOutcome.domain_seq,
          retry: "REQUIRES_RESET",
        });
      }

      // External conflict is deterministic NOT_RETRYABLE
      if (rej.code === "EXTERNAL_CONFLICT") {
        return normalizeFailure({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          code: "EXTERNAL_CONFLICT",
          message: rej.message,
          domain_seq: domainOutcome.domain_seq,
          retry: "NOT_RETRYABLE",
        });
      }

      // Standard deterministic failure
      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: elapsedMs,
        code: rej.code,
        message: rej.message,
        domain_seq: domainOutcome.domain_seq,
        retry: rej.retry ?? "NOT_RETRYABLE",
      });
    } catch (err) {
      const elapsedMs = this.clock.now() - startMs;
      const rawMessage = err instanceof Error ? err.message : String(err);

      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: elapsedMs,
        code: "ENGINE_DISPATCH_FAILED",
        message: rawMessage,
        retry: "NOT_RETRYABLE",
      });
    } finally {
      this.inFlightOperationId = null;
    }
  }

  isClean(): boolean {
    return this.inFlightOperationId === null;
  }

  async cancel(operationId: string): Promise<void> {
    const session = this.activeSession ?? this.getSessionFn?.() ?? null;
    if (session) {
      await session.cancel(operationId);
    }
  }

  async reset(generation: number): Promise<void> {
    const session = this.activeSession ?? this.getSessionFn?.() ?? null;
    if (session) {
      await session.reset(generation);
    }
  }

  async close(): Promise<void> {
    const session = this.activeSession ?? this.getSessionFn?.() ?? null;
    if (session) {
      await session.close();
    }
    this.activeSession = null;
  }
}
