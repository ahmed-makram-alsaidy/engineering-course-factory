// P8.6 Lifecycle Coordination & Multi-Engine Barriers
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 6, 17, 18, 19, 20 & ADR-0013.
// Coordinates:
// 1. Pause request latch, honest active step settlement, wait timer suspension, progression halt
// 2. Resume validation, timer re-arming, sequential progression continuation
// 3. Global cancellation, adapter abort signaling, honest termination settlement
// 4. Strict multi-engine reset dependency order (Browser P7 -> Terminal P5 -> Workspace P6)
// 5. Absence barrier confirmation before generation rotation
// 6. Generation rotation strictly confined to RESETTING
// 7. Multi-engine close dependency order, journal sealing, and CLOSED finality
// 8. Bounded barrier timeouts with deterministic test clock support
// Zero Electron, zero child_process, zero side effects.

import { RuntimeError, sanitizeErrorMessage } from "./errors.ts";
import type { EngineAdapterRegistry } from "./adapters/registry.ts";
import type { RuntimeStateMachine } from "./state-machine.ts";
import type { PlayheadCursor } from "./playhead.ts";
import type { RuntimeJournal } from "./journal.ts";
import type { ProcessLifecycleLedger } from "./process-ledger.ts";
import type { Clock } from "./clock.ts";
import { SystemMonotonicClock } from "./clock.ts";
import type { ValidatedRuntimePlan } from "./validator.ts";
import type { ActiveOperationDescriptor } from "./runtime.ts";
import type { RuntimeErrorCode } from "./errors.ts";

// ---------------------------------------------------------------------------
// Lifecycle Coordination Types & Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_BARRIER_TIMEOUT_MS = 5000;

export interface LifecycleBarrierOptions {
  readonly timeoutMs?: number;
  readonly clock?: Clock;
}

export interface LifecycleCoordinatorOptions {
  readonly sessionId: string;
  readonly plan: ValidatedRuntimePlan;
  readonly stateMachine: RuntimeStateMachine;
  readonly playhead: PlayheadCursor;
  readonly journal: RuntimeJournal;
  readonly registry: EngineAdapterRegistry;
  readonly processLedger: ProcessLifecycleLedger;
  readonly clock?: Clock;
  readonly barrierTimeoutMs?: number;
  readonly getActiveOperation: () => ActiveOperationDescriptor | null;
  readonly clearActiveOperation: () => void;
  readonly getActiveAbortController: () => AbortController | null;
  readonly onRunLoopStepSettled?: () => void;
}

// ---------------------------------------------------------------------------
// Bounded Lifecycle Barrier
// ---------------------------------------------------------------------------

export class LifecycleBarrier {
  private readonly defaultTimeoutMs: number;
  private readonly clock: Clock;

  constructor(options: LifecycleBarrierOptions = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;
    this.clock = options.clock ?? new SystemMonotonicClock();
  }

  async runWithTimeout<T>(
    action: () => Promise<T>,
    timeoutMs?: number,
    operationName = "Lifecycle operation",
    errorCode: RuntimeErrorCode = "RESET_FAILED",
  ): Promise<T> {
    const limit = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const handle = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new RuntimeError({
            code: errorCode,
            message: `${operationName} timed out after ${limit}ms`,
            retry: "UNCERTAIN_DO_NOT_RETRY",
          }),
        );
      }, limit);

      action()
        .then((res) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimeout(handle);
          resolve(res);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          this.clock.clearTimeout(handle);
          reject(err);
        });
    });
  }
}

// ---------------------------------------------------------------------------
// Absence Barrier (Cross-Engine Resource Absence Verification)
// ---------------------------------------------------------------------------

export interface AbsenceCheckParams {
  readonly activeOperation: ActiveOperationDescriptor | null;
  readonly activeProcessIds: readonly string[];
  readonly registry: EngineAdapterRegistry;
}

export class AbsenceBarrier {
  private readonly barrier: LifecycleBarrier;

  constructor(barrier: LifecycleBarrier) {
    this.barrier = barrier;
  }

  async verifyAbsence(params: AbsenceCheckParams, timeoutMs?: number): Promise<void> {
    // 1. Verify zero active operations
    if (params.activeOperation !== null) {
      throw new RuntimeError({
        code: "CLEANUP_UNCONFIRMED",
        message: `Absence barrier failed: active operation '${params.activeOperation.step_id}' is still registered`,
        retry: "UNCERTAIN_DO_NOT_RETRY",
      });
    }

    // 2. Verify zero active background processes
    if (params.activeProcessIds.length > 0) {
      throw new RuntimeError({
        code: "CLEANUP_UNCONFIRMED",
        message: `Absence barrier failed: background processes [${params.activeProcessIds.join(", ")}] are still active`,
        retry: "UNCERTAIN_DO_NOT_RETRY",
      });
    }

    // 3. Verify each registered engine adapter reports clean / absent
    for (const family of params.registry.listRegisteredFamilies()) {
      const adapter = params.registry.getAdapter(family);
      if (typeof adapter.isClean === "function") {
        const cleanResult = await this.barrier.runWithTimeout(
          async () => adapter.isClean!(),
          timeoutMs ?? 1000,
          `Absence check for engine '${family}'`,
          "CLEANUP_UNCONFIRMED",
        );

        if (!cleanResult) {
          throw new RuntimeError({
            code: "CLEANUP_UNCONFIRMED",
            message: `Absence barrier failed: engine adapter '${family}' confirmed residual uncleaned resources`,
            retry: "UNCERTAIN_DO_NOT_RETRY",
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Coordinated Lifecycle Controller
// ---------------------------------------------------------------------------

export class LifecycleCoordinator {
  private readonly sessionId: string;
  private readonly plan: ValidatedRuntimePlan;
  private readonly stateMachine: RuntimeStateMachine;
  private readonly playhead: PlayheadCursor;
  private readonly journal: RuntimeJournal;
  private readonly registry: EngineAdapterRegistry;
  private readonly processLedger: ProcessLifecycleLedger;
  private readonly clock: Clock;
  private readonly barrierTimeoutMs: number;

  private readonly getActiveOperation: () => ActiveOperationDescriptor | null;
  private readonly clearActiveOperation: () => void;
  private readonly getActiveAbortController: () => AbortController | null;

  private readonly barrier: LifecycleBarrier;
  private readonly absenceBarrier: AbsenceBarrier;

  // Lifecycle latches and in-flight promises
  private pauseRequested = false;
  private pauseSettlementPromise: Promise<void> | null = null;
  private pauseSettlementResolver: (() => void) | null = null;
  private resumeWaiters: Set<() => void> = new Set();

  private cancelInFlightPromise: Promise<void> | null = null;
  private resetInFlightPromise: Promise<void> | null = null;
  private closeInFlightPromise: Promise<void> | null = null;

  constructor(options: LifecycleCoordinatorOptions) {
    this.sessionId = options.sessionId;
    this.plan = options.plan;
    this.stateMachine = options.stateMachine;
    this.playhead = options.playhead;
    this.journal = options.journal;
    this.registry = options.registry;
    this.processLedger = options.processLedger;
    this.clock = options.clock ?? new SystemMonotonicClock();
    this.barrierTimeoutMs = options.barrierTimeoutMs ?? DEFAULT_BARRIER_TIMEOUT_MS;

    this.getActiveOperation = options.getActiveOperation;
    this.clearActiveOperation = options.clearActiveOperation;
    this.getActiveAbortController = options.getActiveAbortController;

    this.barrier = new LifecycleBarrier({
      timeoutMs: this.barrierTimeoutMs,
      clock: this.clock,
    });
    this.absenceBarrier = new AbsenceBarrier(this.barrier);
  }

  isPauseRequested(): boolean {
    return this.pauseRequested;
  }

  isPaused(): boolean {
    return this.stateMachine.isPaused();
  }

  isResetInFlight(): boolean {
    return this.resetInFlightPromise !== null;
  }

  isCancelInFlight(): boolean {
    return this.cancelInFlightPromise !== null;
  }

  isCloseInFlight(): boolean {
    return this.closeInFlightPromise !== null;
  }

  // -------------------------------------------------------------------------
  // Pause Mechanics
  // -------------------------------------------------------------------------

  /**
   * Requests execution pause.
   * - If state is already PAUSED: idempotent no-op.
   * - If not legal to transition to PAUSED from current state: throws INVALID_STATE_TRANSITION.
   * - Sets pauseRequested latch.
   * - If active step is a suspendable wait beat: suspends timer and immediately reaches PAUSED.
   * - If active step is an irreversible domain operation: allows it to reach terminal settlement,
   *   then halts progression before the next beat and transitions to PAUSED.
   * - If between beats: immediately transitions to PAUSED without dispatching next step.
   * Lifecycle control never lies: does not resolve until the runtime actually reaches PAUSED.
   */
  async requestPause(): Promise<void> {
    const currentState = this.stateMachine.getState();

    // Idempotency: duplicate pause while already PAUSED converges cleanly
    if (currentState === "PAUSED") {
      return;
    }

    // Legality check: pause is only legal from RUNNING
    if (currentState !== "RUNNING") {
      throw new RuntimeError({
        code: "INVALID_STATE_TRANSITION",
        message: `Cannot request pause from state '${currentState}' (only legal from 'RUNNING')`,
      });
    }

    if (this.pauseRequested && this.pauseSettlementPromise) {
      // Already awaiting active step settlement
      return await this.pauseSettlementPromise;
    }

    this.pauseRequested = true;

    const currentStep = this.playhead.getCurrentStep();
    const currentGeneration = this.stateMachine.getGeneration();
    const currentAttemptId = this.playhead.getAttemptId();

    // Commit pause requested event
    this.journal.commit({
      runtime_session_id: this.sessionId,
      generation: currentGeneration,
      lesson_id: this.plan.lesson_id,
      scene_id: currentStep.scene_id,
      step_id: currentStep.step_id,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.pause.requested",
      attempt_id: currentAttemptId,
      message: "Pause requested by caller",
    });

    const activeOp = this.getActiveOperation();

    // Case 1: No active operation in flight (between beats)
    if (activeOp === null) {
      this.stateMachine.transition("PAUSED");
      this.journal.commit({
        runtime_session_id: this.sessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: "lifecycle",
        engine: "orchestrator",
        event_type: "runtime.paused",
        attempt_id: currentAttemptId,
        message: "Playhead halted on pause barrier",
      });
      return;
    }

    // Case 2: Active operation is an interruptible wait beat
    const activeAdapter = this.registry.getAdapter(activeOp.engine);
    if (activeOp.engine === "wait" && typeof activeAdapter.suspend === "function") {
      activeAdapter.suspend();
      this.stateMachine.transition("PAUSED");
      this.journal.commit({
        runtime_session_id: this.sessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: "lifecycle",
        engine: "orchestrator",
        event_type: "runtime.paused",
        attempt_id: currentAttemptId,
        message: "Wait timer suspended on pause barrier",
      });
      return;
    }

    // Case 3: Active operation is an irreversible domain operation (editor, terminal, browser)
    // Allow it to reach honest terminal settlement. Progression halts BEFORE dispatching next beat.
    this.pauseSettlementPromise = new Promise<void>((resolve) => {
      this.pauseSettlementResolver = resolve;
    });

    await this.pauseSettlementPromise;
  }

  /**
   * Called by the sequential run loop between beats when pauseRequested is observed.
   * Transitions to PAUSED, commits runtime.paused, and unblocks requestPause() callers.
   */
  acknowledgePauseBeforeDispatch(): void {
    if (!this.pauseRequested) return;

    const currentStep = this.playhead.getCurrentStep();
    const currentGeneration = this.stateMachine.getGeneration();
    const currentAttemptId = this.playhead.getAttemptId();

    if (this.stateMachine.getState() === "RUNNING") {
      this.stateMachine.transition("PAUSED");
      this.journal.commit({
        runtime_session_id: this.sessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: "lifecycle",
        engine: "orchestrator",
        event_type: "runtime.paused",
        attempt_id: currentAttemptId,
        message: "Playhead halted on pause barrier",
      });
    }

    if (this.pauseSettlementResolver) {
      const resolve = this.pauseSettlementResolver;
      this.pauseSettlementResolver = null;
      this.pauseSettlementPromise = null;
      resolve();
    }
  }

  /**
   * Called by runLoop when in PAUSED to wait until resume() is invoked.
   */
  async waitForResume(): Promise<void> {
    if (this.stateMachine.getState() !== "PAUSED") {
      return;
    }

    return new Promise<void>((resolve) => {
      this.resumeWaiters.add(resolve);
    });
  }

  // -------------------------------------------------------------------------
  // Resume Mechanics
  // -------------------------------------------------------------------------

  /**
   * Resumes execution from PAUSED.
   * - Only legal from PAUSED.
   * - If RUNNING: fails deterministically with RUNTIME_ALREADY_RUNNING.
   * - If other state: fails closed with INVALID_STATE_TRANSITION.
   * - Clears pause latch.
   * - Transitions PAUSED -> RUNNING.
   * - Re-arms suspended wait timer if active.
   * - Dispatches pending step at current cursor; never duplicates completed steps.
   */
  async resume(): Promise<void> {
    const currentState = this.stateMachine.getState();

    if (currentState === "RUNNING") {
      throw new RuntimeError({
        code: "RUNTIME_ALREADY_RUNNING",
        message: "Lesson execution is already running",
      });
    }

    if (currentState !== "PAUSED") {
      throw new RuntimeError({
        code: "INVALID_STATE_TRANSITION",
        message: `Cannot resume runtime from state '${currentState}' (must be 'PAUSED')`,
      });
    }

    this.pauseRequested = false;

    // Transition PAUSED -> RUNNING
    this.stateMachine.transition("RUNNING");

    const currentStep = this.playhead.getCurrentStep();
    const currentGeneration = this.stateMachine.getGeneration();
    const currentAttemptId = this.playhead.getAttemptId();

    this.journal.commit({
      runtime_session_id: this.sessionId,
      generation: currentGeneration,
      lesson_id: this.plan.lesson_id,
      scene_id: currentStep.scene_id,
      step_id: currentStep.step_id,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.resumed",
      attempt_id: currentAttemptId,
      message: "Lesson execution resumed",
    });

    // If an active adapter was suspended (e.g. wait adapter), resume its timer
    const activeOp = this.getActiveOperation();
    if (activeOp !== null) {
      const activeAdapter = this.registry.getAdapter(activeOp.engine);
      if (typeof activeAdapter.resumeTimer === "function") {
        activeAdapter.resumeTimer();
      }
    }

    // Wake up any runLoop waiters
    for (const waiter of this.resumeWaiters) {
      waiter();
    }
    this.resumeWaiters.clear();
  }

  // -------------------------------------------------------------------------
  // Cancellation Mechanics
  // -------------------------------------------------------------------------

  /**
   * Cancels global lesson execution.
   * - Allowed from RUNNING or PAUSED.
   * - If CANCELLED: returns immediately (idempotent).
   * - If CANCELLING: converges on in-flight cancel barrier.
   * - Other states: fail closed with INVALID_STATE_TRANSITION.
   * - Signals active adapter cancel and waits for honest settlement.
   * - Transitions to CANCELLED (or HOLD on uncertainty).
   * - Playhead remains at current step (no rewind).
   */
  async cancel(): Promise<void> {
    const currentState = this.stateMachine.getState();

    if (currentState === "CANCELLED") {
      return;
    }

    if (this.cancelInFlightPromise) {
      return await this.cancelInFlightPromise;
    }

    if (currentState !== "RUNNING" && currentState !== "PAUSED") {
      throw new RuntimeError({
        code: "INVALID_STATE_TRANSITION",
        message: `Cannot cancel runtime from state '${currentState}' (only legal from 'RUNNING' or 'PAUSED')`,
      });
    }

    this.cancelInFlightPromise = this.executeCancelBarrier();
    try {
      await this.cancelInFlightPromise;
    } finally {
      this.cancelInFlightPromise = null;
    }
  }

  private async executeCancelBarrier(): Promise<void> {
    // Cancellation dominates any pending pause
    this.pauseRequested = false;
    if (this.pauseSettlementResolver) {
      this.pauseSettlementResolver();
      this.pauseSettlementResolver = null;
      this.pauseSettlementPromise = null;
    }
    for (const waiter of this.resumeWaiters) {
      waiter();
    }
    this.resumeWaiters.clear();

    const currentStep = this.playhead.getCurrentStep();
    const currentGeneration = this.stateMachine.getGeneration();
    const currentAttemptId = this.playhead.getAttemptId();

    this.journal.commit({
      runtime_session_id: this.sessionId,
      generation: currentGeneration,
      lesson_id: this.plan.lesson_id,
      scene_id: currentStep.scene_id,
      step_id: currentStep.step_id,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.cancel.requested",
      attempt_id: currentAttemptId,
      message: "Cancellation requested by caller",
    });

    // Transition to CANCELLING
    this.stateMachine.transition("CANCELLING");

    this.journal.commit({
      runtime_session_id: this.sessionId,
      generation: currentGeneration,
      lesson_id: this.plan.lesson_id,
      scene_id: currentStep.scene_id,
      step_id: currentStep.step_id,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.cancelling",
      attempt_id: currentAttemptId,
      message: "Global cancellation in progress; awaiting active settlement",
    });

    // Settle active operation if any
    const activeOp = this.getActiveOperation();
    if (activeOp !== null) {
      const abortCtrl = this.getActiveAbortController();
      if (abortCtrl) {
        abortCtrl.abort();
      }

      const adapter = this.registry.getAdapter(activeOp.engine);
      try {
        await this.barrier.runWithTimeout(
          async () => adapter.cancel(activeOp.step_id),
          this.barrierTimeoutMs,
          `Cancel adapter operation '${activeOp.step_id}'`,
          "ENGINE_OUTCOME_UNCERTAIN",
        );
      } catch (cancelErr) {
        // Lost confirmation -> enter HOLD
        const msg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
        this.clearActiveOperation();
        this.stateMachine.transition("HOLD", { reason: `Cancellation settlement failed: ${msg}` });
        throw new RuntimeError({
          code: "ENGINE_OUTCOME_UNCERTAIN",
          message: `Cancellation cannot confirm whether active side effect settled: ${sanitizeErrorMessage(msg)}`,
          retry: "UNCERTAIN_DO_NOT_RETRY",
        });
      }

      this.clearActiveOperation();
    }

    // Stop active background processes in ledger
    this.processLedger.retireAll();

    // Check if cancellation entered HOLD due to race or failure
    if (this.stateMachine.getState() === "HOLD") {
      throw new RuntimeError({
        code: "ENGINE_OUTCOME_UNCERTAIN",
        message: "Cancellation resulted in uncertain outcome; runtime is in HOLD",
        retry: "UNCERTAIN_DO_NOT_RETRY",
      });
    }

    // Transition CANCELLING -> CANCELLED (if not overtaken by RESETTING or CLOSING)
    if (this.stateMachine.getState() === "CANCELLING") {
      this.journal.commit({
        runtime_session_id: this.sessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: "lifecycle",
        engine: "orchestrator",
        event_type: "runtime.cancelled",
        attempt_id: currentAttemptId,
        outcome: "CANCELLED",
        message: "Lesson execution cancelled cleanly",
      });

      this.stateMachine.transition("CANCELLED");
    }
  }

  // -------------------------------------------------------------------------
  // Coordinated Reset Mechanics
  // -------------------------------------------------------------------------

  /**
   * Coordinated full multi-engine reset sequence.
   * Enforces the proven security-critical dependency ordering:
   *   1. Revoke incoming work (enter RESETTING)
   *   2. Cancel and settle active operation
   *   3. Reset Browser (P7 Engine) — FIRST (releases network dependency on Terminal)
   *   4. Reset Terminal (P5 Engine) — SECOND (removes containers/network, releases volume mounts)
   *   5. Reset Workspace/Editor (P6 Engine) — THIRD (disposes models, deletes and reseeds session leaf)
   *   6. Reset other adapters (wait, narration, visual)
   *   7. Confirm Absence Barrier (zero surviving processes, containers, listeners)
   *   8. Rotate global generation (generation = generation + 1) strictly AFTER absence confirmed
   *   9. Reset playhead to first step (sceneIndex: 0, stepIndex: 0, attempt: A001)
   *   10. Reset process ledger for new generation
   *   11. Clear generation-scoped latches
   *   12. Expose READY state
   * If absence cannot be confirmed or reset fails: fails closed into HOLD, never exposes READY.
   */
  async reset(): Promise<void> {
    const currentState = this.stateMachine.getState();

    if (currentState === "CLOSED" || currentState === "CLOSING") {
      throw new RuntimeError({
        code: "INVALID_STATE_TRANSITION",
        message: `Cannot reset runtime in state '${currentState}' (runtime is permanently closed)`,
      });
    }

    if (this.resetInFlightPromise) {
      // Re-entrancy: converge on active reset barrier
      return await this.resetInFlightPromise;
    }

    this.resetInFlightPromise = this.executeResetBarrier();
    try {
      await this.resetInFlightPromise;
    } finally {
      this.resetInFlightPromise = null;
    }
  }

  private async executeResetBarrier(): Promise<void> {
    // Revoke any in-flight pause/resume/cancel
    this.pauseRequested = false;
    if (this.pauseSettlementResolver) {
      this.pauseSettlementResolver();
      this.pauseSettlementResolver = null;
      this.pauseSettlementPromise = null;
    }
    for (const waiter of this.resumeWaiters) {
      waiter();
    }
    this.resumeWaiters.clear();

    const oldGeneration = this.stateMachine.getGeneration();
    const nextGenerationCandidate = oldGeneration + 1;
    const currentStep = this.playhead.getCurrentStep();
    const currentAttemptId = this.playhead.getAttemptId();

    // 1. Revoke work & Enter RESETTING
    this.stateMachine.transition("RESETTING");

    this.journal.commit({
      runtime_session_id: this.sessionId,
      generation: oldGeneration,
      lesson_id: this.plan.lesson_id,
      scene_id: currentStep.scene_id,
      step_id: currentStep.step_id,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.reset.started",
      attempt_id: currentAttemptId,
      message: `Reset sequence initiated for generation ${oldGeneration}`,
    });

    try {
      // 2. Cancel and settle active operation if any
      const activeOp = this.getActiveOperation();
      if (activeOp !== null) {
        const abortCtrl = this.getActiveAbortController();
        if (abortCtrl) {
          abortCtrl.abort();
        }

        const adapter = this.registry.getAdapter(activeOp.engine);
        await this.barrier.runWithTimeout(
          async () => adapter.cancel(activeOp.step_id),
          this.barrierTimeoutMs,
          `Cancel active operation '${activeOp.step_id}' during reset`,
          "RESET_FAILED",
        );
        this.clearActiveOperation();
      }

      // 3. Reset Browser (P7 Engine) — FIRST
      this.journal.commit({
        runtime_session_id: this.sessionId,
        generation: oldGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: "lifecycle",
        engine: "browser",
        event_type: "runtime.reset.browser",
        attempt_id: currentAttemptId,
        message: "Resetting Browser Engine (P7)",
      });

      const browserAdapter = this.registry.getAdapter("browser");
      await this.barrier.runWithTimeout(
        async () => browserAdapter.reset(nextGenerationCandidate),
        this.barrierTimeoutMs,
        "Browser engine reset",
        "RESET_FAILED",
      );

      // 4. Reset Terminal (P5 Engine) — SECOND
      this.journal.commit({
        runtime_session_id: this.sessionId,
        generation: oldGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: "lifecycle",
        engine: "terminal",
        event_type: "runtime.reset.terminal",
        attempt_id: currentAttemptId,
        message: "Resetting Terminal Engine (P5)",
      });

      const terminalAdapter = this.registry.getAdapter("terminal");
      await this.barrier.runWithTimeout(
        async () => terminalAdapter.reset(nextGenerationCandidate),
        this.barrierTimeoutMs,
        "Terminal engine reset",
        "RESET_FAILED",
      );

      // 5. Reset Workspace/Editor (P6 Engine) — THIRD
      this.journal.commit({
        runtime_session_id: this.sessionId,
        generation: oldGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: "lifecycle",
        engine: "editor",
        event_type: "runtime.reset.workspace",
        attempt_id: currentAttemptId,
        message: "Resetting Workspace/Editor Engine (P6)",
      });

      const editorAdapter = this.registry.getAdapter("editor");
      await this.barrier.runWithTimeout(
        async () => editorAdapter.reset(nextGenerationCandidate),
        this.barrierTimeoutMs,
        "Workspace/Editor engine reset",
        "RESET_FAILED",
      );

      // 6. Reset Other Adapters (Wait, Narration, Visual)
      const waitAdapter = this.registry.getAdapter("wait");
      await this.barrier.runWithTimeout(
        async () => waitAdapter.reset(nextGenerationCandidate),
        this.barrierTimeoutMs,
        "Wait adapter reset",
        "RESET_FAILED",
      );

      const narrationAdapter = this.registry.getAdapter("narration");
      await this.barrier.runWithTimeout(
        async () => narrationAdapter.reset(nextGenerationCandidate),
        this.barrierTimeoutMs,
        "Narration adapter reset",
        "RESET_FAILED",
      );

      const visualAdapter = this.registry.getAdapter("visual");
      await this.barrier.runWithTimeout(
        async () => visualAdapter.reset(nextGenerationCandidate),
        this.barrierTimeoutMs,
        "Visual adapter reset",
        "RESET_FAILED",
      );

      // Retire process ledger
      this.processLedger.retireAll();

      // 7. Confirm Absence Barrier BEFORE generation rotation
      await this.absenceBarrier.verifyAbsence(
        {
          activeOperation: this.getActiveOperation(),
          activeProcessIds: this.processLedger.getActiveProcessIds(),
          registry: this.registry,
        },
        this.barrierTimeoutMs,
      );

      // 8. Rotate Generation (generation = generation + 1)
      const newGeneration = this.stateMachine.rotateGeneration(nextGenerationCandidate);

      // 9. Reset Playhead Cursor to start of lesson plan
      this.playhead.reset(newGeneration);

      // 10. Reinitialize Process Ledger for new generation
      this.processLedger.reset(this.plan.background_processes, newGeneration);

      // 11. Clear generation-scoped latches
      this.pauseRequested = false;
      this.clearActiveOperation();

      // 12. Commit Reset Completed to Global Journal
      const initialStep = this.playhead.getCurrentStep();
      this.journal.commit({
        runtime_session_id: this.sessionId,
        generation: newGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: initialStep.scene_id,
        step_id: initialStep.step_id,
        kind: "lifecycle",
        engine: "orchestrator",
        event_type: "runtime.reset.completed",
        attempt_id: this.playhead.getAttemptId(),
        message: `Reset completed; generation rotated from ${oldGeneration} to ${newGeneration}`,
      });

      // 13. Expose READY
      this.stateMachine.transition("READY");
    } catch (resetErr) {
      // Any teardown failure halts to HOLD; never exposes READY on unconfirmed state
      const rawMsg = resetErr instanceof Error ? resetErr.message : String(resetErr);
      const isUnconfirmed =
        (resetErr instanceof RuntimeError && resetErr.code === "CLEANUP_UNCONFIRMED") ||
        rawMsg.includes("CLEANUP_UNCONFIRMED") ||
        rawMsg.includes("Absence barrier");

      this.stateMachine.transition("HOLD", { reason: `Reset failed: ${rawMsg}` });

      if (isUnconfirmed) {
        throw new RuntimeError({
          code: "CLEANUP_UNCONFIRMED",
          message: `Reset cleanup unconfirmed: ${sanitizeErrorMessage(rawMsg)}`,
          retry: "UNCERTAIN_DO_NOT_RETRY",
        });
      }

      throw new RuntimeError({
        code: "RESET_FAILED",
        message: `Reset failed: ${sanitizeErrorMessage(rawMsg)}`,
        retry: "UNCERTAIN_DO_NOT_RETRY",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Coordinated Global Close Mechanics
  // -------------------------------------------------------------------------

  /**
   * Coordinated global close barrier.
   * Ordered reverse-dependency teardown:
   *   1. Enter CLOSING
   *   2. Cancel/settle active operation
   *   3. Close Browser (P7)
   *   4. Close Terminal (P5)
   *   5. Close Workspace (P6)
   *   6. Close other adapters (wait, narration, visual)
   *   7. Commit runtime.closed
   *   8. Seal Global Journal
   *   9. Enter CLOSED
   * After CLOSED, all subsequent lifecycle commands fail closed.
   */
  async close(): Promise<void> {
    const currentState = this.stateMachine.getState();

    if (currentState === "CLOSED") {
      return;
    }

    if (this.closeInFlightPromise) {
      return await this.closeInFlightPromise;
    }

    this.closeInFlightPromise = this.executeCloseBarrier();
    try {
      await this.closeInFlightPromise;
    } finally {
      this.closeInFlightPromise = null;
    }
  }

  private async executeCloseBarrier(): Promise<void> {
    this.pauseRequested = false;
    if (this.pauseSettlementResolver) {
      this.pauseSettlementResolver();
      this.pauseSettlementResolver = null;
      this.pauseSettlementPromise = null;
    }
    for (const waiter of this.resumeWaiters) {
      waiter();
    }
    this.resumeWaiters.clear();

    const currentGeneration = this.stateMachine.getGeneration();
    const currentStep = this.playhead.getCurrentStep();
    const currentAttemptId = this.playhead.getAttemptId();

    // 1. Enter CLOSING
    this.stateMachine.transition("CLOSING");

    this.journal.commit({
      runtime_session_id: this.sessionId,
      generation: currentGeneration,
      lesson_id: this.plan.lesson_id,
      scene_id: currentStep.scene_id,
      step_id: currentStep.step_id,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.closing",
      attempt_id: currentAttemptId,
      message: "Permanent runtime close initiated",
    });

    try {
      // 2. Cancel and settle active operation
      const activeOp = this.getActiveOperation();
      if (activeOp !== null) {
        const abortCtrl = this.getActiveAbortController();
        if (abortCtrl) {
          abortCtrl.abort();
        }

        const adapter = this.registry.getAdapter(activeOp.engine);
        await this.barrier.runWithTimeout(
          async () => adapter.cancel(activeOp.step_id),
          this.barrierTimeoutMs,
          "Cancel active operation during close",
          "RESET_FAILED",
        );
        this.clearActiveOperation();
      }

      // 3. Close Engines in Reverse Dependency Order
      // 3a. Browser (P7)
      const browserAdapter = this.registry.getAdapter("browser");
      await this.barrier.runWithTimeout(
        async () => browserAdapter.close(),
        this.barrierTimeoutMs,
        "Browser engine close",
        "RESET_FAILED",
      );

      // 3b. Terminal (P5)
      const terminalAdapter = this.registry.getAdapter("terminal");
      await this.barrier.runWithTimeout(
        async () => terminalAdapter.close(),
        this.barrierTimeoutMs,
        "Terminal engine close",
        "RESET_FAILED",
      );

      // 3c. Workspace/Editor (P6)
      const editorAdapter = this.registry.getAdapter("editor");
      await this.barrier.runWithTimeout(
        async () => editorAdapter.close(),
        this.barrierTimeoutMs,
        "Workspace/Editor engine close",
        "RESET_FAILED",
      );

      // 3d. Other adapters
      await this.registry.getAdapter("wait").close();
      await this.registry.getAdapter("narration").close();
      await this.registry.getAdapter("visual").close();

      // Retire process ledger
      this.processLedger.retireAll();

      // 4. Commit runtime.closed event BEFORE sealing journal
      this.journal.commit({
        runtime_session_id: this.sessionId,
        generation: currentGeneration,
        lesson_id: this.plan.lesson_id,
        scene_id: currentStep.scene_id,
        step_id: currentStep.step_id,
        kind: "lifecycle",
        engine: "orchestrator",
        event_type: "runtime.closed",
        attempt_id: currentAttemptId,
        message: "Runtime closed and resources disposed cleanly",
      });

      // 5. Seal Global Runtime Journal
      this.journal.seal();

      // 6. Transition to CLOSED
      this.stateMachine.transition("CLOSED");
    } catch (closeErr) {
      const rawMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
      throw new RuntimeError({
        code: "RESET_FAILED",
        message: `Coordinated close failed: ${sanitizeErrorMessage(rawMsg)}`,
        retry: "UNCERTAIN_DO_NOT_RETRY",
      });
    }
  }
}
