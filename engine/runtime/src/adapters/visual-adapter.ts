// P8.4 Visual Runtime Adapter (Teaching IDE Presentation Seam Wrapper)
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 9, Section 10, Section 32, and ADR-0013.
// Coordinates visual presentation actions:
// - highlight (instructional code highlighting)
//
// Preserves:
// - Presentation intent dispatch only (no pixel rendering, no screen recording, no Unreal)
// - Main-owned presentation boundary
// - Path and line range resolved exclusively from compiled step authority
// - Renderer cannot inject coordinates or arbitrary paths
// - Bounded duration and clean cancellation

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
import { type Clock, SystemMonotonicClock } from "../clock.ts";

// ---------------------------------------------------------------------------
// Visual Admission Record
// ---------------------------------------------------------------------------

export interface VisualAdapterAdmission extends CommonAdapterAdmission {
  readonly actionType: "highlight";
  readonly targetPath: string;
  readonly line?: number;
  readonly lineEnd?: number;
}

// ---------------------------------------------------------------------------
// Visual Presentation Seam Port
// ---------------------------------------------------------------------------

export interface VisualPresentationIntent {
  readonly operation_id: string;
  readonly path: string;
  readonly line?: number;
  readonly line_end?: number;
}

export interface VisualPresentationHost {
  showHighlight(intent: VisualPresentationIntent): Promise<void> | void;
  clearHighlight?(): Promise<void> | void;
  reset?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// VisualRuntimeAdapter Options
// ---------------------------------------------------------------------------

export interface VisualRuntimeAdapterOptions {
  readonly host?: VisualPresentationHost;
  readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// VisualRuntimeAdapter Implementation
// ---------------------------------------------------------------------------

export class VisualRuntimeAdapter implements EngineAdapter<VisualAdapterAdmission> {
  readonly family = "visual" as const;

  private readonly host?: VisualPresentationHost;
  private readonly clock: Clock;
  private currentGeneration = 1;
  private currentSessionId: string | null = null;
  private activeOperationId: string | null = null;

  constructor(options: VisualRuntimeAdapterOptions = {}) {
    this.host = options.host;
    this.clock = options.clock ?? new SystemMonotonicClock();
  }

  setSessionBinding(sessionId: string, generation: number): void {
    this.currentSessionId = sessionId;
    this.currentGeneration = generation;
  }

  async admit(step: CompiledStep, context: OrchestratorContext): Promise<VisualAdapterAdmission> {
    // 1. Static family routing check
    const routing = resolveStepRouting(step);
    const stepFamily = routeStepToEngineFamily(routing.kind, routing.actionType, routing.waitCondition);

    fenceAdapterInvocation(
      this.family,
      stepFamily,
      context,
      this.currentSessionId ?? undefined,
      this.currentGeneration,
    );

    if (step.kind !== "operation" || step.operation.type !== "highlight") {
      throw new RuntimeError({
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Visual adapter received unsupported action '${step.kind === "operation" ? step.operation.type : step.kind}'`,
        stepId: step.step_id,
      });
    }

    const highlightAction = step.operation.parameters as unknown as { path: string; line?: number; line_end?: number };

    return createCommonAdmission({
      admissionId: `adm-visual-${step.step_id}-${context.attempt_id}`,
      operationId: step.step_id,
      sessionId: context.runtime_session_id,
      generation: context.generation,
      attemptId: context.attempt_id,
      lessonId: context.lesson_id,
      stepId: step.step_id,
      engine: this.family,
      actionType: "highlight" as const,
      targetPath: highlightAction.path,
      line: highlightAction.line,
      lineEnd: highlightAction.line_end,
    });
  }

  async execute(admission: VisualAdapterAdmission, signal: AbortSignal): Promise<EngineExecutionResult> {
    const startMs = this.clock.now();

    // 1. Session & generation fencing
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

    // 2. Cancellation check
    if (signal.aborted) {
      return normalizeCancellation({
        engine: this.family,
        admission,
        duration_ms: 0,
        message: "Visual operation cancelled before execution",
      });
    }

    this.activeOperationId = admission.operationId;

    try {
      if (this.host) {
        await this.host.showHighlight({
          operation_id: admission.operationId,
          path: admission.targetPath,
          line: admission.line,
          line_end: admission.lineEnd,
        });
      }

      const elapsed = this.clock.now() - startMs;

      if (signal.aborted) {
        return normalizeCancellation({
          engine: this.family,
          admission,
          duration_ms: elapsed,
          message: "Visual highlight cancelled",
        });
      }

      return normalizeSuccess({
        engine: this.family,
        admission,
        duration_ms: elapsed,
      });
    } catch (err) {
      const elapsed = this.clock.now() - startMs;
      const rawMessage = err instanceof Error ? err.message : String(err);

      return normalizeFailure({
        engine: this.family,
        admission,
        duration_ms: elapsed,
        code: "ENGINE_DISPATCH_FAILED",
        message: rawMessage,
        retry: "NOT_RETRYABLE",
      });
    } finally {
      this.activeOperationId = null;
    }
  }

  isClean(): boolean {
    return this.activeOperationId === null;
  }

  async cancel(operationId: string): Promise<void> {
    if (this.activeOperationId === operationId) {
      if (this.host?.clearHighlight) {
        await this.host.clearHighlight();
      }
      this.activeOperationId = null;
    }
  }

  async reset(generation: number): Promise<void> {
    if (this.host?.reset) {
      await this.host.reset();
    }
    this.activeOperationId = null;
    this.currentGeneration = generation;
  }

  async close(): Promise<void> {
    if (this.host?.close) {
      await this.host.close();
    }
    this.activeOperationId = null;
  }
}
