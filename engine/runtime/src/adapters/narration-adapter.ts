// P8.4 Narration Runtime Adapter (Simulated Narration Implementation for P8)
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 8.1, Section 9, Section 10, Section 32, and ADR-0013.
// Coordinates narration beats:
// - kind: "narration"
//
// Design:
// - P10 Voice Engine is not yet implemented.
// - P8 provides SimulatedNarrationAdapter fulfilling the NarrationRuntimeAdapter contract.
// - In automated test / instant mode: completes deterministically on logical clock tick.
// - In timed simulation mode: computes deterministic speech duration via word count
//   and logical clock SuspendableTimer.
// - Honest cancellation supported without race conditions.
// - Future P10 RealAudioNarrationAdapter will implement NarrationRuntimeAdapter
//   without changing any P8 core orchestration code.
//
// Zero TTS, zero ElevenLabs, zero audio files, zero microphone hardware in P8.

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
// Narration Admission Record
// ---------------------------------------------------------------------------

export interface NarrationAdapterAdmission extends CommonAdapterAdmission {
  readonly text: string;
  readonly language: "en" | "ar";
  readonly pauseBeforeMs: number;
  readonly pauseAfterMs: number;
  readonly simulatedDurationMs: number;
}

// ---------------------------------------------------------------------------
// Narration Adapter Contract (Future-proof for P10)
// ---------------------------------------------------------------------------

export interface NarrationRuntimeAdapter extends EngineAdapter<NarrationAdapterAdmission> {
  readonly family: "narration";
}

// ---------------------------------------------------------------------------
// SimulatedNarrationAdapter Options
// ---------------------------------------------------------------------------

export interface SimulatedNarrationAdapterOptions {
  readonly clock?: Clock;
  readonly simulationMode?: "instant" | "timed";
  /** Words per second for timed mode (default: 2.5 words/second = 150 wpm) */
  readonly wordsPerSecond?: number;
}

// ---------------------------------------------------------------------------
// SimulatedNarrationAdapter Implementation
// ---------------------------------------------------------------------------

export class SimulatedNarrationAdapter implements NarrationRuntimeAdapter {
  readonly family = "narration" as const;

  private readonly clock: Clock;
  private readonly simulationMode: "instant" | "timed";
  private readonly wordsPerSecond: number;
  private activeTimer: SuspendableTimer | null = null;
  private activeOperationId: string | null = null;
  private currentGeneration = 1;
  private currentSessionId: string | null = null;

  constructor(options: SimulatedNarrationAdapterOptions = {}) {
    this.clock = options.clock ?? new SystemMonotonicClock();
    this.simulationMode = options.simulationMode ?? "instant";
    this.wordsPerSecond = options.wordsPerSecond ?? 2.5;
  }

  setSessionBinding(sessionId: string, generation: number): void {
    this.currentSessionId = sessionId;
    this.currentGeneration = generation;
  }

  async admit(step: CompiledStep, context: OrchestratorContext): Promise<NarrationAdapterAdmission> {
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

    if (step.kind !== "narration") {
      throw new RuntimeError({
        code: "UNSUPPORTED_ACTION_TYPE",
        message: `Narration adapter received unsupported step kind '${step.kind}'`,
        stepId: step.step_id,
      });
    }

    const narration = step.narration;
    const text = narration.text;
    const language = narration.language;
    const pauseBeforeMs = (narration.pause_before ?? 0) * 1000;
    const pauseAfterMs = (narration.pause_after ?? 0) * 1000;

    let simulatedDurationMs = 0;
    if (this.simulationMode === "timed") {
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      simulatedDurationMs =
        Math.round((words / this.wordsPerSecond) * 1000) + pauseBeforeMs + pauseAfterMs;
    }

    return createCommonAdmission({
      admissionId: `adm-narration-${step.step_id}-${context.attempt_id}`,
      operationId: step.step_id,
      sessionId: context.runtime_session_id,
      generation: context.generation,
      attemptId: context.attempt_id,
      lessonId: context.lesson_id,
      stepId: step.step_id,
      engine: this.family,
      text,
      language,
      pauseBeforeMs,
      pauseAfterMs,
      simulatedDurationMs,
    });
  }

  async execute(admission: NarrationAdapterAdmission, signal: AbortSignal): Promise<EngineExecutionResult> {
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

    // 2. Early cancellation check
    if (signal.aborted) {
      return normalizeCancellation({
        engine: this.family,
        admission,
        duration_ms: 0,
        message: "Narration operation cancelled before execution",
      });
    }

    this.activeOperationId = admission.operationId;

    try {
      // 3. Simulation execution
      if (this.simulationMode === "instant" || admission.simulatedDurationMs === 0) {
        // Instant simulated narration: completes deterministically
        return normalizeSuccess({
          engine: this.family,
          admission,
          duration_ms: 0,
        });
      }

      // Timed simulated narration via Clock
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
              message: "Simulated narration cancelled",
            }),
          );
        };

        signal.addEventListener("abort", onAbort, { once: true });

        this.activeTimer = new SuspendableTimer(this.clock, admission.simulatedDurationMs, () => {
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
