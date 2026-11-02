// P8.4 Terminal Runtime Adapter (P5 Terminal Engine Wrapper)
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 9, Section 10, Section 22, Section 32, and ADR-0013.
// Coordinates terminal-owned actions:
// - terminal_run (foreground and background)
// - terminal_stop
// - wait (until: "process_output")
//
// Preserves:
// - P5 DockerSandboxProvider authority
// - Non-root 1000:1000 execution
// - CapDrop ALL, no-new-privileges, read-only rootfs
// - Single /workspace mount, zero published ports, no Docker socket
// - Background process lifecycle (spawn confirmation != process exit)
// - waitForProcessOutput canonical observation primitive
// - Transport / supervisor uncertainty -> UNCERTAIN / UNCERTAIN_DO_NOT_RETRY
//
// P8 NEVER executes host commands or bypasses the P5 sandbox.

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
// Terminal Admission Record
// ---------------------------------------------------------------------------

export interface TerminalAdapterAdmission extends CommonAdapterAdmission {
  readonly actionType: "terminal_run" | "terminal_stop" | "wait";
  readonly runMode?: "foreground" | "background";
  readonly processId?: string;
  readonly expectedExitCode?: number;
  readonly outputWaitMarker?: string;
  readonly outputWaitTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Terminal Domain Session Port (Narrow main-held interface)
// ---------------------------------------------------------------------------

export interface TerminalRunOutcome {
  readonly ok: boolean;
  readonly exit_code?: number | null;
  readonly domain_seq?: number;
  readonly isBackground?: boolean;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly exit_code?: number | null;
    readonly uncertain?: boolean;
    readonly retry?: RetryCategory;
  };
}

export interface TerminalDomainSession {
  readonly sessionId: string;
  readonly generation: number;
  runOperation(request: {
    session_id: string;
    operation_id: string;
    request_id: string;
    signal?: AbortSignal;
  }): Promise<TerminalRunOutcome>;
  stopProcess(request: {
    session_id: string;
    process_id: string;
    request_id: string;
  }): Promise<{ ok: boolean; domain_seq?: number; error?: { code: string; message: string } }>;
  waitForProcessOutput?(request: {
    session_id: string;
    process_id: string;
    marker: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; domain_seq?: number; error?: { code: string; message: string } }>;
  cancelOperation(request: {
    session_id: string;
    operation_id: string;
    request_id: string;
  }): Promise<void> | void;
  reset(generation: number): Promise<void> | void;
  close(): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// TerminalRuntimeAdapter Options
// ---------------------------------------------------------------------------

export interface TerminalRuntimeAdapterOptions {
  readonly session?: TerminalDomainSession;
  readonly getSession?: () => TerminalDomainSession | null;
  readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// TerminalRuntimeAdapter Implementation
// ---------------------------------------------------------------------------

export class TerminalRuntimeAdapter implements EngineAdapter<TerminalAdapterAdmission> {
  readonly family = "terminal" as const;

  private activeSession: TerminalDomainSession | null = null;
  private readonly getSessionFn?: () => TerminalDomainSession | null;
  private readonly clock: Clock;

  constructor(options: TerminalRuntimeAdapterOptions = {}) {
    this.activeSession = options.session ?? null;
    this.getSessionFn = options.getSession;
    this.clock = options.clock ?? new SystemMonotonicClock();
  }

  setSession(session: TerminalDomainSession | null): void {
    this.activeSession = session;
  }

  private resolveSession(): TerminalDomainSession {
    const session = this.activeSession ?? this.getSessionFn?.() ?? null;
    if (!session) {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Terminal engine domain session is not bound or unavailable",
      });
    }
    return session;
  }

  async admit(step: CompiledStep, context: OrchestratorContext): Promise<TerminalAdapterAdmission> {
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

    if (step.kind !== "operation") {
      throw new RuntimeError({
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Terminal adapter received unsupported step kind '${step.kind}'`,
        stepId: step.step_id,
      });
    }

    const type = step.operation.type;
    let runMode: "foreground" | "background" | undefined;
    let processId: string | undefined;
    let expectedExitCode: number | undefined;
    let outputWaitMarker: string | undefined;
    let outputWaitTimeoutMs: number | undefined;

    if (type === "terminal_run") {
      const act = step.operation.parameters as unknown as { mode?: "foreground" | "background"; process_id?: string; expected_exit_code?: number };
      runMode = act.mode ?? "foreground";
      processId = act.process_id;
      expectedExitCode = act.expected_exit_code ?? 0;
    } else if (type === "terminal_stop") {
      const act = step.operation.parameters as unknown as { process_id: string };
      processId = act.process_id;
    } else if (type === "wait") {
      const act = step.operation.parameters as unknown as { until: string; process_id?: string; marker?: string; timeout_seconds?: number };
      if (act.until !== "process_output") {
        throw new RuntimeError({
          code: "ENGINE_DISPATCH_FAILED",
          message: `Terminal adapter only owns 'process_output' waits, not '${act.until}'`,
          stepId: step.step_id,
        });
      }
      processId = act.process_id;
      outputWaitMarker = act.marker;
      outputWaitTimeoutMs = (act.timeout_seconds ?? 10) * 1000;
    } else {
      throw new RuntimeError({
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Action '${type}' is not owned by Terminal engine`,
        stepId: step.step_id,
      });
    }

    return createCommonAdmission({
      admissionId: `adm-terminal-${step.step_id}-${context.attempt_id}`,
      operationId: step.step_id,
      sessionId: context.runtime_session_id,
      generation: context.generation,
      attemptId: context.attempt_id,
      lessonId: context.lesson_id,
      stepId: step.step_id,
      engine: this.family,
      actionType: type as TerminalAdapterAdmission["actionType"],
      runMode,
      processId,
      expectedExitCode,
      outputWaitMarker,
      outputWaitTimeoutMs,
    });
  }

  async execute(admission: TerminalAdapterAdmission, signal: AbortSignal): Promise<EngineExecutionResult> {
    const session = this.resolveSession();
    const startMs = this.clock.now();

    // 1. Fencing verification
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

    // 2. Early cancellation check
    if (signal.aborted) {
      return normalizeCancellation({
        engine: this.family,
        admission,
        duration_ms: 0,
        message: "Operation cancelled before execution",
      });
    }

    const requestId = `req-term-${admission.operationId}-${admission.attemptId}`;

    try {
      // 3. Dispatch based on terminal action type
      if (admission.actionType === "terminal_run") {
        const runOutcome = await session.runOperation({
          session_id: admission.sessionId,
          operation_id: admission.operationId,
          request_id: requestId,
          signal,
        });

        const elapsedMs = this.clock.now() - startMs;

        if (signal.aborted) {
          return normalizeCancellation({
            engine: this.family,
            admission,
            duration_ms: elapsedMs,
            domain_seq: runOutcome.domain_seq,
            message: "Terminal run cancelled",
          });
        }

        if (runOutcome.ok) {
          // Success: for background, confirmed spawned; for foreground, confirmed exit code
          return normalizeSuccess({
            engine: this.family,
            admission,
            duration_ms: elapsedMs,
            exit_code: runOutcome.exit_code,
            domain_seq: runOutcome.domain_seq,
          });
        }

        const err = runOutcome.error ?? { code: "PROCESS_FAILED", message: "Terminal process run failed" };

        // Uncertainty mapping (transport failure / supervisor loss)
        if (err.uncertain) {
          return normalizeUncertainty({
            engine: this.family,
            admission,
            duration_ms: elapsedMs,
            code: err.code || "ENGINE_OUTCOME_UNCERTAIN",
            message: err.message,
            domain_seq: runOutcome.domain_seq,
          });
        }

        // Cancellation from domain
        if (err.code === "OPERATION_CANCELLED") {
          return normalizeCancellation({
            engine: this.family,
            admission,
            duration_ms: elapsedMs,
            domain_seq: runOutcome.domain_seq,
            message: err.message,
          });
        }

        return normalizeFailure({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          code: err.code,
          message: err.message,
          exit_code: err.exit_code ?? runOutcome.exit_code ?? null,
          domain_seq: runOutcome.domain_seq,
          retry: err.retry ?? "NOT_RETRYABLE",
        });
      }

      if (admission.actionType === "terminal_stop") {
        if (!admission.processId) {
          return normalizeFailure({
            engine: this.family,
            admission,
            duration_ms: 0,
            code: "INVALID_REQUEST",
            message: "terminal_stop missing target process_id",
            retry: "NOT_RETRYABLE",
          });
        }

        const stopOutcome = await session.stopProcess({
          session_id: admission.sessionId,
          process_id: admission.processId,
          request_id: requestId,
        });

        const elapsedMs = this.clock.now() - startMs;

        if (signal.aborted) {
          return normalizeCancellation({
            engine: this.family,
            admission,
            duration_ms: elapsedMs,
            domain_seq: stopOutcome.domain_seq,
            message: "Terminal stop cancelled",
          });
        }

        if (stopOutcome.ok) {
          return normalizeSuccess({
            engine: this.family,
            admission,
            duration_ms: elapsedMs,
            domain_seq: stopOutcome.domain_seq,
          });
        }

        const err = stopOutcome.error ?? { code: "STOP_FAILED", message: "Process stop failed" };
        return normalizeFailure({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          code: err.code,
          message: err.message,
          domain_seq: stopOutcome.domain_seq,
          retry: "NOT_RETRYABLE",
        });
      }

      if (admission.actionType === "wait") {
        if (!session.waitForProcessOutput) {
          return normalizeFailure({
            engine: this.family,
            admission,
            duration_ms: 0,
            code: "ENGINE_UNAVAILABLE",
            message: "Terminal engine does not provide waitForProcessOutput primitive",
            retry: "NOT_RETRYABLE",
          });
        }

        if (!admission.processId || !admission.outputWaitMarker) {
          return normalizeFailure({
            engine: this.family,
            admission,
            duration_ms: 0,
            code: "INVALID_REQUEST",
            message: "process_output wait missing process_id or marker",
            retry: "NOT_RETRYABLE",
          });
        }

        const waitOutcome = await session.waitForProcessOutput({
          session_id: admission.sessionId,
          process_id: admission.processId,
          marker: admission.outputWaitMarker,
          timeoutMs: admission.outputWaitTimeoutMs ?? 10_000,
          signal,
        });

        const elapsedMs = this.clock.now() - startMs;

        if (signal.aborted) {
          return normalizeCancellation({
            engine: this.family,
            admission,
            duration_ms: elapsedMs,
            domain_seq: waitOutcome.domain_seq,
            message: "Process output wait cancelled",
          });
        }

        if (waitOutcome.ok) {
          return normalizeSuccess({
            engine: this.family,
            admission,
            duration_ms: elapsedMs,
            domain_seq: waitOutcome.domain_seq,
          });
        }

        const err = waitOutcome.error ?? { code: "WAIT_FAILED", message: "Process output wait timed out or failed" };
        return normalizeFailure({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          code: err.code,
          message: err.message,
          domain_seq: waitOutcome.domain_seq,
          retry: "NOT_RETRYABLE",
        });
      }

      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: this.clock.now() - startMs,
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Unknown terminal action type '${admission.actionType}'`,
        retry: "NOT_RETRYABLE",
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
    }
  }

  isClean(): boolean {
    return true;
  }

  async cancel(operationId: string): Promise<void> {
    const session = this.activeSession ?? this.getSessionFn?.() ?? null;
    if (session) {
      await session.cancelOperation({
        session_id: session.sessionId,
        operation_id: operationId,
        request_id: `req-cancel-${operationId}`,
      });
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
