// P8.5 Lesson Runtime Orchestrator Core Engine
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 5, 7, 8, 16, 21, 22, 28 & ADR-0013.
// Coordinates:
// 1. Initialized strictly from immutable ValidatedRuntimePlan
// 2. Sequential execution loop (concurrency = 1)
// 3. Engine adapter dispatch via closed EngineAdapterRegistry
// 4. Global runtime journal event correlation
// 5. Playhead advancement proof rule (advances strictly AFTER journal commit)
// 6. Process lifecycle tracking
// 7. Deterministic terminal completion, confirmed failure, and UNCERTAIN -> HOLD
// 8. Zero renderer command/URL/selector authority
// Zero Electron, zero child_process, zero side effects.

import { createHash } from "node:crypto";
import type { CompiledLesson, CompiledStep } from "@course-factory/lesson-compiler/ir";
import type { ValidatedRuntimePlan, ValidatedStepPlan } from "./validator.ts";
import { ValidatedRuntimePlanSchema } from "./validator.ts";
import {
  type EngineExecutionResult,
  type EngineFamily,
  type GlobalRuntimeEvent,
  type RuntimeSnapshotDto,
  type RuntimeState,
  type TerminalStatus,
  EngineExecutionResultSchema,
  RuntimeSessionIdSchema,
  RuntimeSnapshotDtoSchema,
} from "./protocol.ts";
import { RuntimeError, sanitizeErrorMessage } from "./errors.ts";
import { RuntimeStateMachine } from "./state-machine.ts";
import { PlayheadCursor, type StepCompletionCommitProof } from "./playhead.ts";
import { RuntimeJournal } from "./journal.ts";
import { ProcessLifecycleLedger } from "./process-ledger.ts";
import { type Clock, SystemMonotonicClock } from "./clock.ts";
import { EngineAdapterRegistry } from "./adapters/registry.ts";
import type { CommonAdapterAdmission, OrchestratorContext } from "./adapters/adapter.ts";
import { LifecycleCoordinator } from "./lifecycle-coordination.ts";

// ---------------------------------------------------------------------------
// Canonical JSON & Digest Helper
// ---------------------------------------------------------------------------

function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep) as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted as T;
  }
  return value;
}

function computeDigest(data: unknown): string {
  const json = JSON.stringify(sortKeysDeep(data));
  return createHash("sha256").update(json, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// LessonRuntime Options & Types
// ---------------------------------------------------------------------------

export interface LessonRuntimeOptions {
  readonly sessionId: string;
  readonly generation?: number;
  readonly registry: EngineAdapterRegistry;
  readonly clock?: Clock;
  readonly compiledLesson?: CompiledLesson;
  readonly initialState?: RuntimeState;
  readonly barrierTimeoutMs?: number;
}

export interface ActiveOperationDescriptor {
  readonly step_id: string;
  readonly engine: EngineFamily;
  readonly attempt_id: string;
  readonly generation: number;
}

// ---------------------------------------------------------------------------
// LessonRuntime Class
// ---------------------------------------------------------------------------

export class LessonRuntime {
  readonly runtimeSessionId: string;
  readonly lessonId: string;
  readonly plan: ValidatedRuntimePlan;
  readonly stateMachine: RuntimeStateMachine;
  readonly playhead: PlayheadCursor;
  readonly registry: EngineAdapterRegistry;
  readonly journal: RuntimeJournal;
  readonly processLedger: ProcessLifecycleLedger;
  readonly clock: Clock;

  private readonly stepMap: Map<string, CompiledStep> = new Map();
  private activeOperation: ActiveOperationDescriptor | null = null;
  private activeAbortController: AbortController | null = null;
  private lastOutcome: TerminalStatus | null = null;
  private executionPromise: Promise<void> | null = null;
  private readonly coordinator: LifecycleCoordinator;

  private constructor(plan: ValidatedRuntimePlan, options: LessonRuntimeOptions) {
    this.runtimeSessionId = RuntimeSessionIdSchema.parse(options.sessionId);
    this.lessonId = plan.lesson_id;
    this.plan = plan;
    this.registry = options.registry;
    this.clock = options.clock ?? new SystemMonotonicClock();

    const generation = options.generation ?? 1;

    // Index compiled steps if compiledLesson is provided
    if (options.compiledLesson) {
      if (options.compiledLesson.source.hash.value !== plan.compiled_ir_digest) {
        throw new RuntimeError({
          code: "RUNTIME_INVALID_LESSON",
          message: `CompiledLesson source hash (${options.compiledLesson.source.hash.value}) does not match plan compiled_ir_digest (${plan.compiled_ir_digest})`,
        });
      }
      for (const scene of options.compiledLesson.scenes) {
        for (const step of scene.steps) {
          this.stepMap.set(step.step_id, step);
        }
      }
    }

    this.stateMachine = new RuntimeStateMachine({
      sessionId: this.runtimeSessionId,
      generation,
      initialState: options.initialState ?? "READY",
      clock: this.clock,
    });

    this.playhead = PlayheadCursor.createFromPlan(plan, { generation });

    this.journal = new RuntimeJournal({
      sessionId: this.runtimeSessionId,
      generation,
      clock: this.clock,
    });

    this.processLedger = new ProcessLifecycleLedger(plan.background_processes, generation);

    this.coordinator = new LifecycleCoordinator({
      sessionId: this.runtimeSessionId,
      plan: this.plan,
      stateMachine: this.stateMachine,
      playhead: this.playhead,
      journal: this.journal,
      registry: this.registry,
      processLedger: this.processLedger,
      clock: this.clock,
      barrierTimeoutMs: options.barrierTimeoutMs,
      getActiveOperation: () => this.activeOperation,
      clearActiveOperation: () => {
        this.activeOperation = null;
        this.activeAbortController = null;
      },
      getActiveAbortController: () => this.activeAbortController,
    });
  }

  /**
   * Factory method initializing a LessonRuntime strictly from a ValidatedRuntimePlan.
   * Enforces non-empty plan, valid session ID, and intact digest.
   */
  static create(plan: ValidatedRuntimePlan, options: LessonRuntimeOptions): LessonRuntime {
    if (!plan || typeof plan !== "object") {
      throw new RuntimeError({
        code: "RUNTIME_INVALID_LESSON",
        message: "Cannot create LessonRuntime: plan is null or not an object",
      });
    }

    // Validate plan structure
    const planParsed = ValidatedRuntimePlanSchema.safeParse(plan);
    if (!planParsed.success) {
      throw new RuntimeError({
        code: "RUNTIME_INVALID_LESSON",
        message: `Invalid ValidatedRuntimePlan: ${planParsed.error.message}`,
      });
    }

    if (plan.total_steps <= 0 || !Array.isArray(plan.ordered_steps) || plan.ordered_steps.length === 0) {
      throw new RuntimeError({
        code: "RUNTIME_INVALID_LESSON",
        message: "Cannot create LessonRuntime: plan contains zero ordered steps",
      });
    }

    if (!options.registry || !(options.registry instanceof EngineAdapterRegistry)) {
      throw new RuntimeError({
        code: "ENGINE_UNAVAILABLE",
        message: "Cannot create LessonRuntime: registry must be an instance of EngineAdapterRegistry",
      });
    }

    return new LessonRuntime(plan, options);
  }

  getState(): RuntimeState {
    return this.stateMachine.getState();
  }

  getSessionId(): string {
    return this.runtimeSessionId;
  }

  getGeneration(): number {
    return this.stateMachine.getGeneration();
  }

  getPlan(): ValidatedRuntimePlan {
    return this.plan;
  }

  getPlayhead(): PlayheadCursor {
    return this.playhead;
  }

  getJournal(): RuntimeJournal {
    return this.journal;
  }

  getProcessLedger(): ProcessLifecycleLedger {
    return this.processLedger;
  }

  getLastOutcome(): TerminalStatus | null {
    return this.lastOutcome;
  }

  getActiveOperation(): ActiveOperationDescriptor | null {
    return this.activeOperation ? Object.freeze({ ...this.activeOperation }) : null;
  }

  /**
   * Returns presentation-safe runtime snapshot adhering to RuntimeSnapshotDtoSchema.
   */
  getSnapshot(): RuntimeSnapshotDto {
    const playheadDto = this.playhead.getSnapshot();
    const activeProcesses = this.processLedger.getActiveProcessIds();

    const dto: RuntimeSnapshotDto = {
      runtime_session_id: this.runtimeSessionId,
      lesson_id: this.lessonId,
      generation: this.stateMachine.getGeneration(),
      state: this.stateMachine.getState(),
      playhead: playheadDto,
      active_process_ids: [...activeProcesses],
      last_outcome: this.lastOutcome,
      journal_high_seq: this.journal.getHighSeq(),
    };

    RuntimeSnapshotDtoSchema.parse(dto);
    return Object.freeze(dto);
  }

  /**
   * Starts sequential lesson execution from READY.
   * Concurrency is strictly 1.
   * Fails closed if called while already running or in HOLD.
   */
  async start(): Promise<void> {
    const currentState = this.stateMachine.getState();
    if (currentState === "RUNNING") {
      throw new RuntimeError({
        code: "RUNTIME_ALREADY_RUNNING",
        message: "Lesson execution is already running",
      });
    }
    if (currentState === "HOLD") {
      throw new RuntimeError({
        code: "RUNTIME_IN_HOLD",
        message: "Runtime is halted in HOLD state due to uncertain outcome; execution blocked",
      });
    }
    if (currentState !== "READY") {
      throw new RuntimeError({
        code: "RUNTIME_NOT_READY",
        message: `Cannot start runtime from state '${currentState}' (must be 'READY')`,
      });
    }

    this.stateMachine.transition("RUNNING");

    const firstStep = this.playhead.getCurrentStep();
    this.journal.commit({
      runtime_session_id: this.runtimeSessionId,
      generation: this.stateMachine.getGeneration(),
      lesson_id: this.plan.lesson_id,
      scene_id: firstStep.scene_id,
      step_id: firstStep.step_id,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.started",
      attempt_id: this.playhead.getAttemptId(),
      message: "Lesson execution started",
    });

    this.executionPromise = this.runLoop();
    await this.executionPromise;
  }

  /**
   * Bounded sequential run loop.
   * Iterates through plan steps one at a time until completed, failed, or hold.
   */
  private async runLoop(): Promise<void> {
    while (!this.playhead.isAtEnd()) {
      // 1. Check if paused or pause was requested before dispatching next beat
      if (this.stateMachine.isPaused() || this.coordinator.isPauseRequested()) {
        this.coordinator.acknowledgePauseBeforeDispatch();
        await this.coordinator.waitForResume();
      }

      // If state is not RUNNING after waiting, exit loop
      if (!this.stateMachine.isRunning() || this.playhead.isAtEnd()) {
        break;
      }

      await this.executeStep();

      // 2. Check if pause was requested while executeStep was running or state became PAUSED
      if (
        this.stateMachine.isPaused() ||
        (this.stateMachine.isRunning() && this.coordinator.isPauseRequested() && !this.playhead.isAtEnd())
      ) {
        this.coordinator.acknowledgePauseBeforeDispatch();
        await this.coordinator.waitForResume();
      }

      if (!this.stateMachine.isRunning() && !this.stateMachine.isPaused()) {
        break;
      }
    }
  }

  /**
   * Resolves a step to an admissible CompiledStep structure.
   */
  private resolveCompiledStep(stepPlan: ValidatedStepPlan): CompiledStep {
    const found = this.stepMap.get(stepPlan.step_id);
    if (found) {
      return found;
    }

    const common = {
      step_id: stepPlan.step_id,
      ordinal: stepPlan.global_step_ordinal,
      derived: false as const,
      source_ref: {
        scene_id: stepPlan.scene_id,
        scene_ordinal: stepPlan.scene_index + 1,
        beat_id: stepPlan.step_id,
        form: "authored_beat" as const,
      },
    };

    if (stepPlan.kind === "narration") {
      return {
        kind: "narration",
        ...common,
        narration: {
          text: "Simulated narration beat",
          language: "en",
          direction: "ltr",
        },
      };
    }

    if (stepPlan.kind === "pause") {
      return {
        kind: "pause",
        ...common,
        seconds: 1,
      };
    }

    return {
      kind: "operation",
      ...common,
      operation: {
        type: stepPlan.action_type ?? "wait",
        family: stepPlan.engine as any,
        parameters: { type: stepPlan.action_type ?? "wait" } as any,
      },
    };
  }

  /**
   * Executes exactly one step sequentially according to the canonical execution rule.
   */
  private async executeStep(): Promise<void> {
    if (this.activeOperation !== null) {
      throw new RuntimeError({
        code: "DUPLICATE_OPERATION",
        message: `Step dispatch rejected: operation '${this.activeOperation.step_id}' is already in flight`,
      });
    }

    const currentStep = this.playhead.getCurrentStep();
    const currentGeneration = this.stateMachine.getGeneration();
    const currentAttemptId = this.playhead.getAttemptId();

    // 1. Dependency gate: verify live prerequisites
    try {
      this.processLedger.verifyDependencies(currentStep.step_id, currentStep.dependencies);
    } catch (depErr) {
      const msg = depErr instanceof Error ? depErr.message : String(depErr);
      this.lastOutcome = "FAILED";
      this.journal.commit({
        runtime_session_id: this.runtimeSessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: currentStep.kind,
        engine: currentStep.engine,
        event_type: "runtime.step.failed",
        attempt_id: currentAttemptId,
        outcome: "FAILED",
        message: sanitizeErrorMessage(msg),
      });
      this.stateMachine.transition("FAILED", { reason: msg });
      return;
    }

    // 2. Resolve adapter by validated engine family
    const adapter = this.registry.getAdapter(currentStep.engine);
    const compiledStep = this.resolveCompiledStep(currentStep);

    const context: OrchestratorContext = {
      runtime_session_id: this.runtimeSessionId,
      generation: currentGeneration,
      lesson_id: this.plan.lesson_id,
      attempt_id: currentAttemptId,
      plan: this.plan,
    };

    // Record active operation latch
    this.activeOperation = {
      step_id: currentStep.step_id,
      engine: currentStep.engine,
      attempt_id: currentAttemptId,
      generation: currentGeneration,
    };

    // 3. Pre-dispatch admission
    let admission: CommonAdapterAdmission;
    try {
      admission = await adapter.admit(compiledStep, context);
    } catch (admitErr) {
      // Pre-dispatch exception: safe confirmed failure before side effects
      this.activeOperation = null;
      const msg = admitErr instanceof Error ? admitErr.message : String(admitErr);
      this.lastOutcome = "FAILED";
      this.journal.commit({
        runtime_session_id: this.runtimeSessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: currentStep.kind,
        engine: currentStep.engine,
        event_type: "runtime.step.failed",
        attempt_id: currentAttemptId,
        outcome: "FAILED",
        message: sanitizeErrorMessage(`Admit failed: ${msg}`),
      });
      this.stateMachine.transition("FAILED", { reason: `Admit failed: ${msg}` });
      return;
    }

    // 4. Commit step-started event to global journal
    this.journal.commit({
      runtime_session_id: this.runtimeSessionId,
      generation: currentGeneration,
      lesson_id: this.plan.lesson_id,
      scene_id: currentStep.scene_id,
      step_id: currentStep.step_id,
      kind: currentStep.kind,
      engine: currentStep.engine,
      event_type: "runtime.step.started",
      attempt_id: currentAttemptId,
    });

    // 5. Execute adapter attempt
    this.activeAbortController = new AbortController();
    let rawResult: EngineExecutionResult;
    try {
      rawResult = await adapter.execute(admission, this.activeAbortController.signal);
    } catch (execErr) {
      this.activeOperation = null;
      this.activeAbortController = null;
      // If runtime was reset, closed, or cancelled while executing, drop late throw
      if (
        this.stateMachine.getState() === "RESETTING" ||
        this.stateMachine.getState() === "CLOSING" ||
        this.stateMachine.getState() === "CLOSED" ||
        this.stateMachine.getGeneration() !== currentGeneration
      ) {
        return;
      }
      // POST-DISPATCH EXCEPTION: lost trusted confirmation -> UNCERTAIN / HOLD
      const msg = execErr instanceof Error ? execErr.message : String(execErr);
      this.lastOutcome = "UNCERTAIN";
      this.journal.commit({
        runtime_session_id: this.runtimeSessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: currentStep.kind,
        engine: currentStep.engine,
        event_type: "runtime.step.uncertain",
        attempt_id: currentAttemptId,
        outcome: "UNCERTAIN",
        message: sanitizeErrorMessage(`Post-dispatch throw: ${msg}`),
      });
      this.stateMachine.transition("HOLD", { reason: `Post-dispatch adapter exception: ${msg}` });
      return;
    }

    // 6. Validate normalized execution envelope
    const parsed = EngineExecutionResultSchema.safeParse(rawResult);
    if (!parsed.success) {
      this.activeOperation = null;
      this.lastOutcome = "UNCERTAIN";
      this.journal.commit({
        runtime_session_id: this.runtimeSessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: currentStep.kind,
        engine: currentStep.engine,
        event_type: "runtime.step.uncertain",
        attempt_id: currentAttemptId,
        outcome: "UNCERTAIN",
        message: "Adapter returned malformed result envelope",
      });
      this.stateMachine.transition("HOLD", { reason: "Malformed adapter result envelope" });
      return;
    }

    const result = parsed.data;

    // 7. Fencing enforcement (session, generation, attempt, operation)
    if (
      result.session_id !== this.runtimeSessionId ||
      result.generation !== currentGeneration ||
      result.attempt_id !== currentAttemptId ||
      result.operation_id !== currentStep.step_id
    ) {
      // Stale or foreign result: reject fail-closed without mutating playhead or journal
      this.activeOperation = null;
      return;
    }

    // 8. Outcome dispatch
    if (result.status === "COMPLETED") {
      // Update background process ledger if applicable
      if (currentStep.engine === "terminal") {
        const bgProc = this.plan.background_processes.find((p) => p.producer_step_id === currentStep.step_id);
        if (bgProc) {
          this.processLedger.markActive(bgProc.process_id, currentStep.step_id, currentGeneration);
        }
        const stopProc = this.plan.background_processes.find((p) => p.stopped_step_id === currentStep.step_id);
        if (stopProc) {
          this.processLedger.markRetired(stopProc.process_id, currentStep.step_id);
        }
      }

      // Commit terminal completion event to Global Runtime Journal
      let committedEvent: GlobalRuntimeEvent;
      try {
        committedEvent = this.journal.commit({
          runtime_session_id: this.runtimeSessionId,
          generation: currentGeneration,
          lesson_id: this.plan.lesson_id,
          scene_id: currentStep.scene_id,
          step_id: currentStep.step_id,
          kind: currentStep.kind,
          engine: currentStep.engine,
          event_type: "runtime.step.completed",
          attempt_id: currentAttemptId,
          domain_ref: result.detail.domain_seq ? { engine: result.engine, domain_seq: result.detail.domain_seq } : undefined,
          outcome: "COMPLETED",
          message: result.detail.message,
        });
      } catch {
        // Journal commit failed: DO NOT advance playhead
        this.activeOperation = null;
        this.lastOutcome = "UNCERTAIN";
        this.stateMachine.transition("HOLD", { reason: "Journal commit failed for completed step" });
        return;
      }

      // Construct authorized StepCompletionCommitProof
      const proof: StepCompletionCommitProof = {
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        global_step_ordinal: currentStep.global_step_ordinal,
        attempt_id: currentAttemptId,
        generation: currentGeneration,
        status: "COMPLETED",
        journal_seq: committedEvent.global_seq,
        committed: true,
      };

      this.activeOperation = null;
      this.activeAbortController = null;

      // Advance playhead by exactly one step
      const advanceResult = this.playhead.advance(proof);
      this.lastOutcome = "COMPLETED";

      // If runtime is in cancellation, do NOT dispatch next step or mark completed
      if (this.stateMachine.getState() === "CANCELLING") {
        return;
      }

      if (advanceResult.endOfPlan) {
        // Lesson completed all steps: perform normal completion cleanup
        await this.executeCompletionCleanup();

        this.journal.commit({
          runtime_session_id: this.runtimeSessionId,
          generation: currentGeneration,
          lesson_id: this.plan.lesson_id,
          scene_id: currentStep.scene_id,
          step_id: currentStep.step_id,
          kind: "lifecycle",
          engine: "orchestrator",
          event_type: "runtime.completed",
          attempt_id: currentAttemptId,
          outcome: "COMPLETED",
          message: "Lesson execution completed successfully",
        });

        this.stateMachine.transition("COMPLETED");
        return;
      }

      // Check if scene crossed
      const nextStep = this.playhead.getCurrentStep();
      if (nextStep.scene_id !== currentStep.scene_id) {
        this.journal.commit({
          runtime_session_id: this.runtimeSessionId,
          generation: currentGeneration,
          lesson_id: this.plan.lesson_id,
          scene_id: nextStep.scene_id,
          step_id: nextStep.step_id,
          kind: "lifecycle",
          engine: "orchestrator",
          event_type: "scene.transition",
          attempt_id: this.playhead.getAttemptId(),
          message: `Transitioning to scene ${nextStep.scene_id}`,
        });
      }
      return;
    }

    if (result.status === "FAILED") {
      this.activeOperation = null;
      this.activeAbortController = null;
      this.lastOutcome = "FAILED";
      this.journal.commit({
        runtime_session_id: this.runtimeSessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: currentStep.kind,
        engine: currentStep.engine,
        event_type: "runtime.step.failed",
        attempt_id: currentAttemptId,
        outcome: "FAILED",
        message: result.detail.message,
      });
      this.stateMachine.transition("FAILED", { reason: result.detail.message ?? "Step execution failed" });
      return;
    }

    if (result.status === "UNCERTAIN") {
      this.activeOperation = null;
      this.activeAbortController = null;
      this.lastOutcome = "UNCERTAIN";
      this.journal.commit({
        runtime_session_id: this.runtimeSessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: currentStep.kind,
        engine: currentStep.engine,
        event_type: "runtime.step.uncertain",
        attempt_id: currentAttemptId,
        outcome: "UNCERTAIN",
        message: result.detail.message,
      });
      this.stateMachine.transition("HOLD", { reason: result.detail.message ?? "Step execution uncertain" });
      return;
    }

    if (result.status === "CANCELLED") {
      this.activeOperation = null;
      this.activeAbortController = null;
      this.lastOutcome = "CANCELLED";
      this.journal.commit({
        runtime_session_id: this.runtimeSessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: currentStep.kind,
        engine: currentStep.engine,
        event_type: "runtime.step.cancelled",
        attempt_id: currentAttemptId,
        outcome: "CANCELLED",
        message: result.detail.message,
      });
      if (this.stateMachine.getState() === "RUNNING") {
        this.stateMachine.transition("FAILED", { reason: "Step execution was cancelled" });
      }
      return;
    }
  }

  /**
   * Cleans up background processes declared for lesson completion cleanup.
   */
  private async executeCompletionCleanup(): Promise<void> {
    for (const processId of this.plan.completion_cleanup_processes) {
      if (this.processLedger.isLive(processId)) {
        this.processLedger.markRetired(processId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle Coordination (P8.6)
  // -------------------------------------------------------------------------

  /**
   * Requests coordinated pause. Progression halts honestly at beat boundary.
   */
  async pause(): Promise<void> {
    return await this.coordinator.requestPause();
  }

  /**
   * Canonical requestPause alias.
   */
  async requestPause(): Promise<void> {
    return await this.coordinator.requestPause();
  }

  /**
   * Resumes sequential execution from PAUSED state.
   */
  async resume(): Promise<void> {
    return await this.coordinator.resume();
  }

  /**
   * Cancels global runtime execution honestly.
   */
  async cancel(): Promise<void> {
    return await this.coordinator.cancel();
  }

  /**
   * Executes coordinated multi-engine reset (Browser -> Terminal -> Workspace).
   */
  async reset(): Promise<void> {
    return await this.coordinator.reset();
  }

  /**
   * Executes coordinated global close barrier.
   */
  async close(): Promise<void> {
    return await this.coordinator.close();
  }

  isPaused(): boolean {
    return this.coordinator.isPaused();
  }

  isPauseRequested(): boolean {
    return this.coordinator.isPauseRequested();
  }

  getCoordinator(): LifecycleCoordinator {
    return this.coordinator;
  }
}
