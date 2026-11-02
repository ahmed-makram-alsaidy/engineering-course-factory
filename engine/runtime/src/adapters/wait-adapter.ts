// P8.4 Wait Runtime Adapter (P8 Logical Clock & Port Readiness Wrapper)
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 8.3, Section 9, Section 10, Section 32, and ADR-0013.
// Coordinates wait-family actions:
// - pause beat (kind: "pause", seconds: N)
// - duration wait (action: "wait", until: "duration", duration_ms: N)
// - port wait (action: "wait", until: "port", port: N, timeout_seconds?: N)
//
// Crucial routing rule:
// - process_output wait is owned by TerminalRuntimeAdapter, NOT WaitRuntimeAdapter.
//
// Preserves:
// - Deterministic Logical Clock (Clock interface, ManualLogicalClock for zero-sleep tests)
// - SuspendableTimer pause/resume compatibility
// - Loopback-only port readiness polling (no arbitrary WAN sockets)
// - Honest cancellation without late completion race conditions
//
// P8 never executes real sleeps in tests.

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
  resolveStepRouting,
} from "./adapter.ts";
import {
  type EngineExecutionResult,
  routeStepToEngineFamily,
} from "../protocol.ts";
import { RuntimeError } from "../errors.ts";
import { type Clock, SuspendableTimer, SystemMonotonicClock } from "../clock.ts";

// ---------------------------------------------------------------------------
// Wait Admission Record
// ---------------------------------------------------------------------------

export type WaitKind = "duration" | "port" | "pause";

export interface WaitAdapterAdmission extends CommonAdapterAdmission {
  readonly waitKind: WaitKind;
  readonly durationMs?: number;
  readonly port?: number;
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Port Readiness Provider Port
// ---------------------------------------------------------------------------

export interface PortReadinessProvider {
  (port: number, timeoutMs?: number, pollIntervalMs?: number, host?: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// WaitRuntimeAdapter Options
// ---------------------------------------------------------------------------

export interface WaitRuntimeAdapterOptions {
  readonly clock?: Clock;
  readonly portReadinessProvider?: PortReadinessProvider;
}

// ---------------------------------------------------------------------------
// WaitRuntimeAdapter Implementation
// ---------------------------------------------------------------------------

export class WaitRuntimeAdapter implements EngineAdapter<WaitAdapterAdmission> {
  readonly family = "wait" as const;

  private readonly clock: Clock;
  private readonly portReadinessProvider?: PortReadinessProvider;
  private activeTimer: SuspendableTimer | null = null;
  private activeOperationId: string | null = null;
  private currentGeneration = 1;
  private currentSessionId: string | null = null;

  constructor(options: WaitRuntimeAdapterOptions = {}) {
    this.clock = options.clock ?? new SystemMonotonicClock();
    this.portReadinessProvider = options.portReadinessProvider;
  }

  setSessionBinding(sessionId: string, generation: number): void {
    this.currentSessionId = sessionId;
    this.currentGeneration = generation;
  }

  async admit(step: CompiledStep, context: OrchestratorContext): Promise<WaitAdapterAdmission> {
    // 1. Static family routing check
    const routing = resolveStepRouting(step);
    const stepFamily = routeStepToEngineFamily(routing.kind, routing.actionType, routing.waitCondition);

    // CRITICAL: process_output wait must NOT be admitted by Wait adapter
    if (routing.waitCondition === "process_output") {
      throw new RuntimeError({
        code: "ENGINE_DISPATCH_FAILED",
        message: "process_output wait must be routed to TerminalRuntimeAdapter, not WaitRuntimeAdapter",
        stepId: step.step_id,
      });
    }

    fenceAdapterInvocation(
      this.family,
      stepFamily,
      context,
      this.currentSessionId ?? undefined,
      this.currentGeneration,
    );

    let waitKind: WaitKind;
    let durationMs: number | undefined;
    let port: number | undefined;
    let timeoutMs: number | undefined;

    if (step.kind === "pause") {
      waitKind = "pause";
      durationMs = step.seconds * 1000;
    } else if (step.kind === "operation" && step.operation.type === "wait") {
      const act = step.operation.parameters as unknown as { until: string; duration_ms?: number; port?: number; timeout_seconds?: number };
      if (act.until === "duration") {
        waitKind = "duration";
        durationMs = act.duration_ms ?? 0;
      } else if (act.until === "port") {
        waitKind = "port";
        port = act.port;
        timeoutMs = (act.timeout_seconds ?? 10) * 1000;
      } else {
        throw new RuntimeError({
          code: "ENGINE_DISPATCH_FAILED",
          message: `Wait adapter cannot admit wait condition '${act.until}'`,
          stepId: step.step_id,
        });
      }
    } else {
      throw new RuntimeError({
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Step '${step.step_id}' is not a valid wait or pause beat`,
        stepId: step.step_id,
      });
    }

    return createCommonAdmission({
      admissionId: `adm-wait-${step.step_id}-${context.attempt_id}`,
      operationId: step.step_id,
      sessionId: context.runtime_session_id,
      generation: context.generation,
      attemptId: context.attempt_id,
      lessonId: context.lesson_id,
      stepId: step.step_id,
      engine: this.family,
      waitKind,
      durationMs,
      port,
      timeoutMs,
    });
  }

  async execute(admission: WaitAdapterAdmission, signal: AbortSignal): Promise<EngineExecutionResult> {
    const startMs = this.clock.now();

    // 1. Session & generation fencing check
    if (this.currentSessionId !== null && admission.sessionId !== this.currentSessionId) {
      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: 0,
        code: "STALE_RUNTIME_SESSION",
        message: `Admission session '${admission.sessionId}' does not match active session '${this.currentSessionId}'`,
        retry: "REQUIRES_RESET",
      });
    }

    if (admission.generation !== this.currentGeneration) {
      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: 0,
        code: "STALE_GENERATION",
        message: `Admission generation ${admission.generation} does not match active generation ${this.currentGeneration}`,
        retry: "REQUIRES_RESET",
      });
    }

    // 2. Early cancellation check
    if (signal.aborted) {
      return normalizeCancellation({
        engine: this.family,
        admission,
        duration_ms: 0,
        message: "Wait operation cancelled before execution",
      });
    }

    this.activeOperationId = admission.operationId;

    try {
      // 3. Duration wait or pause beat execution
      if (admission.waitKind === "duration" || admission.waitKind === "pause") {
        const targetDuration = Math.max(0, admission.durationMs ?? 0);

        return await new Promise<EngineExecutionResult>((resolve) => {
          let timerSettled = false;

          const onAbort = () => {
            if (timerSettled) return;
            timerSettled = true;
            this.activeTimer?.cancel();
            this.activeTimer = null;
            signal.removeEventListener("abort", onAbort);
            const elapsed = this.clock.now() - startMs;
            resolve(
              normalizeCancellation({
                engine: this.family,
                admission,
                duration_ms: elapsed,
                message: "Duration wait cancelled",
              }),
            );
          };

          signal.addEventListener("abort", onAbort, { once: true });

          this.activeTimer = new SuspendableTimer(this.clock, targetDuration, () => {
            if (timerSettled) return;
            timerSettled = true;
            signal.removeEventListener("abort", onAbort);
            this.activeTimer = null;
            const elapsed = this.clock.now() - startMs;
            resolve(
              normalizeSuccess({
                engine: this.family,
                admission,
                duration_ms: elapsed,
              }),
            );
          });

          this.activeTimer.start();
        });
      }

      // 4. Port wait execution
      if (admission.waitKind === "port") {
        const port = admission.port;
        if (!port || port < 1 || port > 65535) {
          return normalizeFailure({
            engine: this.family,
            admission,
            duration_ms: 0,
            code: "INVALID_REQUEST",
            message: `Invalid port number '${port}' for port wait`,
            retry: "NOT_RETRYABLE",
          });
        }

        const timeoutMs = admission.timeoutMs ?? 10_000;

        if (!this.portReadinessProvider) {
          // If no provider injected, fail closed
          return normalizeFailure({
            engine: this.family,
            admission,
            duration_ms: 0,
            code: "ENGINE_UNAVAILABLE",
            message: "Port readiness provider is not configured on WaitRuntimeAdapter",
            retry: "NOT_RETRYABLE",
          });
        }

        try {
          const isReady = await this.portReadinessProvider(port, timeoutMs, 100, "127.0.0.1");
          const elapsed = this.clock.now() - startMs;

          if (signal.aborted) {
            return normalizeCancellation({
              engine: this.family,
              admission,
              duration_ms: elapsed,
              message: "Port wait cancelled",
            });
          }

          if (isReady) {
            return normalizeSuccess({
              engine: this.family,
              admission,
              duration_ms: elapsed,
            });
          }

          return normalizeFailure({
            engine: this.family,
            admission,
            duration_ms: elapsed,
            code: "PORT_UNAVAILABLE",
            message: `Port ${port} failed to become ready within ${timeoutMs}ms`,
            retry: "NOT_RETRYABLE",
          });
        } catch (err) {
          const elapsed = this.clock.now() - startMs;
          const msg = err instanceof Error ? err.message : String(err);

          if (signal.aborted) {
            return normalizeCancellation({
              engine: this.family,
              admission,
              duration_ms: elapsed,
              message: "Port wait cancelled",
            });
          }

          return normalizeFailure({
            engine: this.family,
            admission,
            duration_ms: elapsed,
            code: "PORT_UNAVAILABLE",
            message: msg,
            retry: "NOT_RETRYABLE",
          });
        }
      }

      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: this.clock.now() - startMs,
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Unknown wait kind '${admission.waitKind}'`,
        retry: "NOT_RETRYABLE",
      });
    } finally {
      this.activeOperationId = null;
      this.activeTimer = null;
    }
  }

  suspend(): void {
    if (this.activeTimer && this.activeTimer.getState() === "RUNNING") {
      this.activeTimer.suspend();
    }
  }

  resumeTimer(): void {
    if (this.activeTimer && this.activeTimer.getState() === "PAUSED") {
      this.activeTimer.resume();
    }
  }

  getActiveTimer(): SuspendableTimer | null {
    return this.activeTimer;
  }

  isClean(): boolean {
    return this.activeTimer === null && this.activeOperationId === null;
  }

  async cancel(operationId: string): Promise<void> {
    if (this.activeOperationId === operationId || this.activeTimer) {
      this.activeTimer?.cancel();
      this.activeTimer = null;
      this.activeOperationId = null;
    }
  }

  async reset(generation: number): Promise<void> {
    if (this.activeTimer) {
      this.activeTimer.cancel();
      this.activeTimer = null;
    }
    this.activeOperationId = null;
    this.currentGeneration = generation;
  }

  async close(): Promise<void> {
    if (this.activeTimer) {
      this.activeTimer.dispose();
      this.activeTimer = null;
    }
    this.activeOperationId = null;
  }
}
