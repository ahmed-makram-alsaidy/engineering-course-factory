// P8.4 Browser Runtime Adapter (P7 Browser Automation Engine Wrapper)
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 9, Section 10, Section 32, and ADR-0013.
// Coordinates browser-owned actions:
// - browser_open
// - browser_click
// - browser_fill
// - browser_press
// - browser_refresh
// - browser_wait
// - browser_assert
//
// Preserves:
// - P7 BrowserRuntimeHost & BrowserAdmissionSession authority
// - Identifier-only dispatch: P8 supplies operation_id only
// - Zero URL, selector, fill value, key, or timeout passed from P8
// - Ephemeral profile isolation
// - Chromium process supervision (zero zombie processes)
// - NetworkRouteShield and loopback proxy protection
// - Deterministic crash recovery: crash maps to REQUIRES_RESET
// - Domain journal correlation via domain_seq without payload leakage
//
// P8 never launches Chromium outside P7 or creates a second browser engine.

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
// Browser Admission Record
// ---------------------------------------------------------------------------

export type BrowserActionType =
  | "browser_open"
  | "browser_click"
  | "browser_fill"
  | "browser_press"
  | "browser_refresh"
  | "browser_wait"
  | "browser_assert";

export interface BrowserAdapterAdmission extends CommonAdapterAdmission {
  readonly actionType: BrowserActionType;
}

// ---------------------------------------------------------------------------
// Browser Domain Session Port (Narrow main-held interface)
// ---------------------------------------------------------------------------

export interface BrowserDomainOutcome {
  readonly ok: boolean;
  readonly domain_seq?: number;
  readonly receipt?: {
    readonly domain_seq?: number;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retry?: RetryCategory;
    readonly uncertain?: boolean;
  };
}

export interface BrowserDomainSession {
  readonly sessionId: string;
  readonly generation: number;
  runOperation(request: {
    session_id: string;
    operation_id: string;
    request_id: string;
  }): Promise<BrowserDomainOutcome>;
  cancelOperation(operationId: string): Promise<boolean> | boolean;
  reset(generation: number): Promise<void> | void;
  close(): Promise<void> | void;
  getJournalSeq?(): number;
}

// ---------------------------------------------------------------------------
// BrowserRuntimeAdapter Options
// ---------------------------------------------------------------------------

export interface BrowserRuntimeAdapterOptions {
  readonly session?: BrowserDomainSession;
  readonly getSession?: () => BrowserDomainSession | null;
  readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// BrowserRuntimeAdapter Implementation
// ---------------------------------------------------------------------------

export class BrowserRuntimeAdapter implements EngineAdapter<BrowserAdapterAdmission> {
  readonly family = "browser" as const;

  private activeSession: BrowserDomainSession | null = null;
  private readonly getSessionFn?: () => BrowserDomainSession | null;
  private readonly clock: Clock;

  constructor(options: BrowserRuntimeAdapterOptions = {}) {
    this.activeSession = options.session ?? null;
    this.getSessionFn = options.getSession;
    this.clock = options.clock ?? new SystemMonotonicClock();
  }

  setSession(session: BrowserDomainSession | null): void {
    this.activeSession = session;
  }

  private resolveSession(): BrowserDomainSession {
    const session = this.activeSession ?? this.getSessionFn?.() ?? null;
    if (!session) {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Browser engine domain session is not bound or unavailable",
      });
    }
    return session;
  }

  async admit(step: CompiledStep, context: OrchestratorContext): Promise<BrowserAdapterAdmission> {
    // 1. Family routing check
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
        message: `Browser adapter received unsupported step kind '${step.kind}'`,
        stepId: step.step_id,
      });
    }

    const type = step.operation.type;
    const validBrowserActions: readonly string[] = [
      "browser_open",
      "browser_click",
      "browser_fill",
      "browser_press",
      "browser_refresh",
      "browser_wait",
      "browser_assert",
    ];

    if (!validBrowserActions.includes(type)) {
      throw new RuntimeError({
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Action '${type}' is not owned by Browser engine`,
        stepId: step.step_id,
      });
    }

    return createCommonAdmission({
      admissionId: `adm-browser-${step.step_id}-${context.attempt_id}`,
      operationId: step.step_id,
      sessionId: context.runtime_session_id,
      generation: context.generation,
      attemptId: context.attempt_id,
      lessonId: context.lesson_id,
      stepId: step.step_id,
      engine: this.family,
      actionType: type as BrowserActionType,
    });
  }

  async execute(admission: BrowserAdapterAdmission, signal: AbortSignal): Promise<EngineExecutionResult> {
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

    // 3. Identifier-only execution: P8 supplies ONLY identifiers
    const requestId = `req-browser-${admission.operationId}-${admission.attemptId}`;

    try {
      const outcome = await session.runOperation({
        session_id: admission.sessionId,
        operation_id: admission.operationId,
        request_id: requestId,
      });

      const elapsedMs = this.clock.now() - startMs;
      const domainSeq = outcome.domain_seq ?? outcome.receipt?.domain_seq;

      if (signal.aborted) {
        return normalizeCancellation({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          domain_seq: domainSeq,
          message: "Browser operation cancelled",
        });
      }

      if (outcome.ok) {
        return normalizeSuccess({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          domain_seq: domainSeq,
        });
      }

      const err = outcome.error ?? { code: "BROWSER_ACTION_FAILED", message: "Browser execution failed" };

      // Ambiguous side-effect outcome
      if (err.uncertain) {
        return normalizeUncertainty({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          code: err.code || "ENGINE_OUTCOME_UNCERTAIN",
          message: err.message,
          domain_seq: domainSeq,
        });
      }

      // Cancellation check
      if (err.code === "OPERATION_CANCELLED") {
        return normalizeCancellation({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          domain_seq: domainSeq,
          message: err.message,
        });
      }

      // Crash / disconnected session requires reset
      if (
        err.code === "PAGE_CRASHED" ||
        err.code === "BROWSER_CRASHED" ||
        err.code === "STALE_SESSION" ||
        err.code === "STALE_GENERATION"
      ) {
        return normalizeFailure({
          engine: this.family,
          admission,
          duration_ms: elapsedMs,
          code: err.code,
          message: err.message,
          domain_seq: domainSeq,
          retry: "REQUIRES_RESET",
        });
      }

      // Deterministic browser failure
      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: elapsedMs,
        code: err.code,
        message: err.message,
        domain_seq: domainSeq,
        retry: err.retry ?? "NOT_RETRYABLE",
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
      await session.cancelOperation(operationId);
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
