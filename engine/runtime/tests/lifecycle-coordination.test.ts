// P8.6 Lifecycle Coordination, Barriers & Multi-Engine Control Tests
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 6, 17, 18, 19, 20 & ADR-0013.
// 100% deterministic, zero real-time sleeps, ManualLogicalClock for all timing proofs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LessonRuntime } from "../src/runtime.ts";
import { RuntimeJournal } from "../src/journal.ts";
import { ProcessLifecycleLedger } from "../src/process-ledger.ts";
import { ManualLogicalClock, SuspendableTimer } from "../src/clock.ts";
import { RuntimeValidator } from "../src/validator.ts";
import { EngineAdapterRegistry } from "../src/adapters/registry.ts";
import {
  type CommonAdapterAdmission,
  type EngineAdapter,
  type OrchestratorContext,
  createCommonAdmission,
} from "../src/adapters/adapter.ts";
import {
  type EngineExecutionResult,
  type EngineFamily,
  createCancelledResult,
  createCompletedResult,
  createFailedResult,
  createUncertainResult,
} from "../src/protocol.ts";
import { RuntimeError } from "../src/errors.ts";
import { createCanonicalReferenceLesson } from "./fixtures.ts";
import type { CompiledStep } from "@course-factory/lesson-compiler/ir";

// ---------------------------------------------------------------------------
// Controllable Fake Adapter Implementation
// ---------------------------------------------------------------------------

interface ControllableAdapterHooks {
  onAdmit?: (step: CompiledStep, context: OrchestratorContext) => Promise<void> | void;
  onExecute?: (admission: CommonAdapterAdmission, signal: AbortSignal) => Promise<EngineExecutionResult> | EngineExecutionResult;
  onCancel?: (operationId: string) => Promise<void> | void;
  onReset?: (generation: number) => Promise<void> | void;
  onClose?: () => Promise<void> | void;
  isClean?: () => Promise<boolean> | boolean;
}

class ControllableEngineAdapter implements EngineAdapter {
  readonly family: EngineFamily;
  readonly admissions: CommonAdapterAdmission[] = [];
  readonly executions: CommonAdapterAdmission[] = [];
  readonly cancels: string[] = [];
  readonly resets: number[] = [];
  closes = 0;

  hooks: ControllableAdapterHooks;
  orderLog?: string[];
  activeTimer: SuspendableTimer | null = null;
  suspended = false;

  constructor(family: EngineFamily, hooks: ControllableAdapterHooks = {}, orderLog?: string[]) {
    this.family = family;
    this.hooks = hooks;
    this.orderLog = orderLog;
  }

  async admit(step: CompiledStep, context: OrchestratorContext): Promise<CommonAdapterAdmission> {
    if (this.hooks.onAdmit) {
      await this.hooks.onAdmit(step, context);
    }
    const admission = createCommonAdmission({
      admissionId: `adm-${this.family}-${step.step_id}`,
      operationId: step.step_id,
      sessionId: context.runtime_session_id,
      generation: context.generation,
      attemptId: context.attempt_id,
      lessonId: context.lesson_id,
      stepId: step.step_id,
      engine: this.family,
    });
    this.admissions.push(admission);
    return admission;
  }

  async execute(admission: CommonAdapterAdmission, signal: AbortSignal): Promise<EngineExecutionResult> {
    this.executions.push(admission);
    if (this.hooks.onExecute) {
      return await this.hooks.onExecute(admission, signal);
    }
    return createCompletedResult({
      engine: this.family,
      operation_id: admission.operationId,
      session_id: admission.sessionId,
      generation: admission.generation,
      attempt_id: admission.attemptId,
      domain_seq: this.executions.length,
      duration_ms: 10,
    });
  }

  async cancel(operationId: string): Promise<void> {
    this.cancels.push(operationId);
    if (this.hooks.onCancel) {
      await this.hooks.onCancel(operationId);
    }
  }

  async reset(generation: number): Promise<void> {
    this.resets.push(generation);
    if (this.orderLog) {
      this.orderLog.push(`reset:${this.family}`);
    }
    if (this.hooks.onReset) {
      await this.hooks.onReset(generation);
    }
  }

  async close(): Promise<void> {
    this.closes++;
    if (this.orderLog) {
      this.orderLog.push(`close:${this.family}`);
    }
    if (this.hooks.onClose) {
      await this.hooks.onClose();
    }
  }

  suspend(): void {
    this.suspended = true;
    if (this.activeTimer && this.activeTimer.getState() === "RUNNING") {
      this.activeTimer.suspend();
    }
  }

  resumeTimer(): void {
    this.suspended = false;
    if (this.activeTimer && this.activeTimer.getState() === "PAUSED") {
      this.activeTimer.resume();
    }
  }

  isClean(): Promise<boolean> | boolean {
    if (this.hooks.isClean) {
      return this.hooks.isClean();
    }
    return true;
  }
}

function createControllableRegistry(
  hooks: Partial<Record<EngineFamily, ControllableAdapterHooks>> = {},
  orderLog?: string[],
) {
  const adapters = {
    editor: new ControllableEngineAdapter("editor", hooks.editor, orderLog),
    terminal: new ControllableEngineAdapter("terminal", hooks.terminal, orderLog),
    browser: new ControllableEngineAdapter("browser", hooks.browser, orderLog),
    wait: new ControllableEngineAdapter("wait", hooks.wait, orderLog),
    narration: new ControllableEngineAdapter("narration", hooks.narration, orderLog),
    visual: new ControllableEngineAdapter("visual", hooks.visual, orderLog),
  };

  const registry = new EngineAdapterRegistry(adapters);
  return { registry, adapters };
}

function buildValidatedReferencePlan() {
  const compiledLesson = createCanonicalReferenceLesson();
  const validator = new RuntimeValidator();
  const report = validator.validate(compiledLesson);
  assert.equal(report.ok, true);
  assert.ok(report.plan);
  return { plan: report.plan!, compiledLesson };
}

// ---------------------------------------------------------------------------
// P8.6 Lifecycle Control Test Suite
// ---------------------------------------------------------------------------

describe("P8.6: Coordinated Multi-Engine Reset, Cancel, Pause & Barriers", () => {
  // =========================================================================
  // 1. Pause & Resume Mechanics
  // =========================================================================

  describe("Pause & Resume Mechanics", () => {
    it("1. pause request while RUNNING accepted and transitions to PAUSED when between beats", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();
      const clock = new ManualLogicalClock(1000);

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-pause-01",
        registry,
        clock,
      });

      // Start run loop
      const runPromise = runtime.start();
      assert.equal(runtime.getState(), "RUNNING");

      // Pause immediately
      await runtime.pause();

      assert.equal(runtime.getState(), "PAUSED");
      assert.equal(runtime.isPaused(), true);

      // Verify journal events
      const events = runtime.getJournal().getAllEvents();
      const pauseRequested = events.find((e) => e.event_type === "runtime.pause.requested");
      const paused = events.find((e) => e.event_type === "runtime.paused");
      assert.ok(pauseRequested);
      assert.ok(paused);
      assert.ok(paused.global_seq > pauseRequested.global_seq);

      // Clean resume and complete
      await runtime.resume();
      await runPromise;
      assert.equal(runtime.getState(), "COMPLETED");
    });

    it("2. active completed step settles first: pause does not abort irreversible engine work", async () => {
      const { plan } = buildValidatedReferencePlan();
      let step1Resolve!: (res: EngineExecutionResult) => void;
      const step1Promise = new Promise<EngineExecutionResult>((resolve) => {
        step1Resolve = resolve;
      });

      const { registry, adapters } = createControllableRegistry({
        narration: {
          onExecute: async (admission) => {
            if (admission.operationId === "C01-L001-S001-B001") {
              return await step1Promise;
            }
            return createCompletedResult({
              engine: "narration",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              duration_ms: 10,
            });
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-active-settle",
        registry,
      });

      const runPromise = runtime.start();
      assert.equal(runtime.getState(), "RUNNING");
      assert.ok(runtime.getActiveOperation() !== null);
      assert.equal(runtime.getActiveOperation()?.step_id, "C01-L001-S001-B001");

      // Request pause while step 1 is executing
      const pausePromise = runtime.pause();
      assert.equal(runtime.isPauseRequested(), true);
      // Not PAUSED yet because active step has not settled
      assert.equal(runtime.getState(), "RUNNING");

      // Settle active step 1 terminally
      step1Resolve(
        createCompletedResult({
          engine: "narration",
          operation_id: "C01-L001-S001-B001",
          session_id: "sess-p86-active-settle",
          generation: 1,
          attempt_id: "A001",
          duration_ms: 25,
        }),
      );

      // Now pause finishes settling
      await pausePromise;

      assert.equal(runtime.getState(), "PAUSED");
      // Step 1 completed and playhead advanced to Step 2
      assert.equal(runtime.getPlayhead().getCurrentStep().step_id, "C01-L001-S001-B002");

      // Step 2 (editor) has NOT been admitted or dispatched yet
      assert.equal(adapters.editor.executions.length, 0);

      // Resume and finish
      await runtime.resume();
      await runPromise;
      assert.equal(runtime.getState(), "COMPLETED");
    });

    it("3. pause during wait beat suspends logical timer without consuming remaining wait", async () => {
      const { plan } = buildValidatedReferencePlan();
      const clock = new ManualLogicalClock(0);
      let timerCompleted = false;

      const { registry, adapters } = createControllableRegistry({
        narration: {
          onExecute: (admission) =>
            createCompletedResult({
              engine: "narration",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              duration_ms: 10,
            }),
        },
        wait: {
          onExecute: (admission, signal) => {
            if (admission.operationId === "C01-L001-S001-B007") {
              return new Promise<EngineExecutionResult>((resolve) => {
                // Simulate 10s wait for step 7
                const timer = new SuspendableTimer(clock, 10_000, () => {
                  timerCompleted = true;
                  resolve(
                    createCompletedResult({
                      engine: "wait",
                      operation_id: admission.operationId,
                      session_id: admission.sessionId,
                      generation: admission.generation,
                      attempt_id: admission.attemptId,
                      duration_ms: 10_000,
                    }),
                  );
                });
                adapters.wait.activeTimer = timer;
                timer.start();
                waitReachedResolve();
              });
            }
            return createCompletedResult({
              engine: "wait",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              duration_ms: 10,
            });
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-suspend-wait",
        registry,
        clock,
      });

      // Target step 7 (wait port)
      let waitReachedResolve!: () => void;
      const waitReached = new Promise<void>((resolve) => {
        waitReachedResolve = resolve;
      });

      const runPromise = runtime.start();
      await waitReached;

      // At wait start: 0ms elapsed
      assert.equal(adapters.wait.activeTimer?.getRemainingMs(), 10_000);

      // Advance 3s
      clock.advanceBy(3_000);
      assert.equal(adapters.wait.activeTimer?.getRemainingMs(), 7_000);

      // Request pause
      await runtime.pause();
      assert.equal(runtime.getState(), "PAUSED");
      assert.equal(adapters.wait.activeTimer?.getState(), "PAUSED");

      // Advance logical clock by 50 seconds while PAUSED: timer must NOT fire!
      clock.advanceBy(50_000);
      assert.equal(timerCompleted, false);
      assert.equal(adapters.wait.activeTimer?.getRemainingMs(), 7_000);

      // Resume execution: timer re-arms for remaining 7 seconds
      await runtime.resume();
      assert.equal(runtime.getState(), "RUNNING");
      assert.equal(adapters.wait.activeTimer?.getState(), "RUNNING");

      // Advance 6.9s: timer still not fired
      clock.advanceBy(6_900);
      assert.equal(timerCompleted, false);

      // Advance final 100ms: fires at exactly remaining 7s!
      clock.advanceBy(100);
      assert.equal(timerCompleted, true);

      await runPromise;
      assert.equal(runtime.getState(), "COMPLETED");
    });

    it("4. background processes remain active during pause", async () => {
      const { plan } = buildValidatedReferencePlan();
      const clock = new ManualLogicalClock(1000);

      const { registry } = createControllableRegistry();
      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-bg-pause",
        registry,
        clock,
      });

      // Hook: pause right after bg process starts (step 6)
      let bgStartedResolve!: () => void;
      const bgStarted = new Promise<void>((resolve) => {
        bgStartedResolve = resolve;
      });

      runtime.getJournal().onEvent((e) => {
        if (e.event_type === "runtime.step.completed" && e.step_id === "C01-L001-S001-B006") {
          bgStartedResolve();
        }
      });

      const runPromise = runtime.start();
      await bgStarted;

      assert.equal(runtime.getProcessLedger().isLive("demo_server"), true);

      // Pause while background server is alive
      await runtime.pause();
      assert.equal(runtime.getState(), "PAUSED");

      // Invariant: background process is NOT stopped on pause
      assert.equal(runtime.getProcessLedger().isLive("demo_server"), true);

      // Resume: dependent browser actions continue normally
      await runtime.resume();
      await runPromise;
      assert.equal(runtime.getState(), "COMPLETED");
    });

    it("5. duplicate pause is idempotent; duplicate resume fails with RUNTIME_ALREADY_RUNNING", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-idempotent",
        registry,
      });

      const runPromise = runtime.start();

      // Pause
      await runtime.pause();
      assert.equal(runtime.getState(), "PAUSED");

      // Duplicate pause while already paused: idempotent no-op
      await runtime.pause();
      assert.equal(runtime.getState(), "PAUSED");

      // Resume
      await runtime.resume();
      assert.equal(runtime.getState(), "RUNNING");

      // Duplicate resume while RUNNING: must fail fail-closed
      await assert.rejects(
        async () => runtime.resume(),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "RUNTIME_ALREADY_RUNNING");
          return true;
        },
      );

      await runPromise;
    });

    it("6. pause and resume from illegal states reject fail-closed with INVALID_STATE_TRANSITION", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-illegal",
        registry,
      });

      // In READY state
      await assert.rejects(async () => runtime.pause(), (err: any) => err.code === "INVALID_STATE_TRANSITION");
      await assert.rejects(async () => runtime.resume(), (err: any) => err.code === "INVALID_STATE_TRANSITION");

      await runtime.start();
      assert.equal(runtime.getState(), "COMPLETED");

      // In COMPLETED state
      await assert.rejects(async () => runtime.pause(), (err: any) => err.code === "INVALID_STATE_TRANSITION");
      await assert.rejects(async () => runtime.resume(), (err: any) => err.code === "INVALID_STATE_TRANSITION");
    });
  });

  // =========================================================================
  // 2. Global Cancellation Mechanics
  // =========================================================================

  describe("Global Cancellation Mechanics", () => {
    it("7. cancel from RUNNING transitions to CANCELLING, invokes adapter cancel, settles to CANCELLED", async () => {
      const { plan } = buildValidatedReferencePlan();
      let cancelCalled = false;
      let stepResolve!: (res: EngineExecutionResult) => void;
      const stepPromise = new Promise<EngineExecutionResult>((resolve) => {
        stepResolve = resolve;
      });

      const { registry, adapters } = createControllableRegistry({
        narration: {
          onExecute: async () => await stepPromise,
          onCancel: (opId) => {
            cancelCalled = true;
            stepResolve(
              createCancelledResult({
                engine: "narration",
                operation_id: opId,
                session_id: "sess-p86-cancel-01",
                generation: 1,
                attempt_id: "A001",
                duration_ms: 10,
              }),
            );
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-cancel-01",
        registry,
      });

      const runPromise = runtime.start();
      assert.equal(runtime.getState(), "RUNNING");

      // Cancel while step 1 in flight
      await runtime.cancel();

      assert.equal(runtime.getState(), "CANCELLED");
      assert.equal(cancelCalled, true);
      assert.equal(adapters.narration.cancels.length, 1);

      // Playhead remains at the cancelled step
      assert.equal(runtime.getPlayhead().getCurrentStep().step_id, "C01-L001-S001-B001");

      // Subsequent steps never dispatched
      assert.equal(adapters.editor.executions.length, 0);

      // Journal verification
      const events = runtime.getJournal().getAllEvents();
      assert.ok(events.find((e) => e.event_type === "runtime.cancel.requested"));
      assert.ok(events.find((e) => e.event_type === "runtime.cancelling"));
      assert.ok(events.find((e) => e.event_type === "runtime.cancelled"));

      await runPromise;
    });

    it("8. cancel while PAUSED transitions through CANCELLING to CANCELLED without dispatching work", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry, adapters } = createControllableRegistry();

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-cancel-paused",
        registry,
      });

      const runPromise = runtime.start();
      await runtime.pause();
      assert.equal(runtime.getState(), "PAUSED");

      const executionsBeforeCancel = adapters.narration.executions.length;

      // Cancel while paused
      await runtime.cancel();
      assert.equal(runtime.getState(), "CANCELLED");

      // No new execution dispatched
      assert.equal(adapters.narration.executions.length, executionsBeforeCancel);
      assert.equal(adapters.editor.executions.length, 0);

      await runPromise;
    });

    it("9. adapter completes during cancel race: honest COMPLETED recorded, no next step dispatched", async () => {
      const { plan } = buildValidatedReferencePlan();
      let stepResolve!: (res: EngineExecutionResult) => void;
      const stepPromise = new Promise<EngineExecutionResult>((resolve) => {
        stepResolve = resolve;
      });

      const { registry, adapters } = createControllableRegistry({
        narration: {
          onExecute: async () => await stepPromise,
          onCancel: () => {
            // Simulate adapter finishing with COMPLETED before abort took hold
            stepResolve(
              createCompletedResult({
                engine: "narration",
                operation_id: "C01-L001-S001-B001",
                session_id: "sess-p86-race-cancel",
                generation: 1,
                attempt_id: "A001",
                duration_ms: 10,
              }),
            );
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-race-cancel",
        registry,
      });

      const runPromise = runtime.start();
      await runtime.cancel();

      assert.equal(runtime.getState(), "CANCELLED");
      // Honest completed outcome was recorded and step 1 advanced
      assert.equal(runtime.getLastOutcome(), "COMPLETED");
      assert.equal(runtime.getPlayhead().getCurrentStep().step_id, "C01-L001-S001-B002");

      // But Step 2 was NEVER dispatched
      assert.equal(adapters.editor.executions.length, 0);

      await runPromise;
    });

    it("10. cancellation uncertainty halts immediately to HOLD without claiming CANCELLED", async () => {
      const { plan } = buildValidatedReferencePlan();

      const { registry } = createControllableRegistry({
        narration: {
          onExecute: () =>
            new Promise((_, reject) => {
              // Simulate in-flight operation that throws post-dispatch exception
            }),
          onCancel: () => {
            throw new Error("Socket broken: unconfirmed cancellation");
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-cancel-uncertain",
        registry,
      });

      runtime.start();

      await assert.rejects(
        async () => runtime.cancel(),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "ENGINE_OUTCOME_UNCERTAIN");
          return true;
        },
      );

      // Must be in HOLD, NEVER claim CANCELLED
      assert.equal(runtime.getState(), "HOLD");
    });

    it("11. cancellation dominates pause: pause requested then cancel requested settles to CANCELLED", async () => {
      const { plan } = buildValidatedReferencePlan();
      let stepResolve!: (res: EngineExecutionResult) => void;
      const stepPromise = new Promise<EngineExecutionResult>((resolve) => {
        stepResolve = resolve;
      });

      const { registry, adapters } = createControllableRegistry({
        narration: {
          onExecute: async () => await stepPromise,
          onCancel: (opId) => {
            stepResolve(
              createCancelledResult({
                engine: "narration",
                operation_id: opId,
                session_id: "sess-p86-pause-cancel",
                generation: 1,
                attempt_id: "A001",
                duration_ms: 10,
              }),
            );
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-pause-cancel",
        registry,
      });

      const runPromise = runtime.start();

      // Pause requested
      runtime.pause();
      assert.equal(runtime.isPauseRequested(), true);

      // Cancel requested before pause settled
      await runtime.cancel();

      assert.equal(runtime.getState(), "CANCELLED");
      assert.equal(runtime.isPauseRequested(), false);
      await runPromise;
    });
  });

  // =========================================================================
  // 3. Coordinated Multi-Engine Reset Mechanics
  // =========================================================================

  describe("Coordinated Multi-Engine Reset Mechanics", () => {
    it("12. reset from READY, RUNNING, PAUSED, CANCELLED, FAILED, HOLD, and COMPLETED succeeds", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();

      // From READY
      const rReady = LessonRuntime.create(plan, { sessionId: "sess-rst-ready", registry });
      assert.equal(rReady.getState(), "READY");
      await rReady.reset();
      assert.equal(rReady.getState(), "READY");
      assert.equal(rReady.getGeneration(), 2);

      // From COMPLETED
      const rComp = LessonRuntime.create(plan, { sessionId: "sess-rst-comp", registry });
      await rComp.start();
      assert.equal(rComp.getState(), "COMPLETED");
      await rComp.reset();
      assert.equal(rComp.getState(), "READY");
      assert.equal(rComp.getGeneration(), 2);

      // From FAILED
      const { registry: failReg } = createControllableRegistry({
        narration: {
          onExecute: (admission) =>
            createFailedResult({
              engine: "narration",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              code: "FATAL_ERROR",
              message: "Test failure",
              duration_ms: 5,
            }),
        },
      });
      const rFail = LessonRuntime.create(plan, { sessionId: "sess-rst-fail", registry: failReg });
      await rFail.start();
      assert.equal(rFail.getState(), "FAILED");
      await rFail.reset();
      assert.equal(rFail.getState(), "READY");
      assert.equal(rFail.getGeneration(), 2);

      // From HOLD
      const { registry: holdReg } = createControllableRegistry({
        narration: {
          onExecute: (admission) =>
            createUncertainResult({
              engine: "narration",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              code: "COMMIT_UNCERTAIN",
              message: "Hold test",
              duration_ms: 5,
            }),
        },
      });
      const rHold = LessonRuntime.create(plan, { sessionId: "sess-rst-hold", registry: holdReg });
      await rHold.start();
      assert.equal(rHold.getState(), "HOLD");
      await rHold.reset();
      assert.equal(rHold.getState(), "READY");
      assert.equal(rHold.getGeneration(), 2);
    });

    it("13. enforces exact security-critical reset dependency order: Browser -> Terminal -> Workspace", async () => {
      const { plan } = buildValidatedReferencePlan();
      const orderLog: string[] = [];
      const { registry } = createControllableRegistry({}, orderLog);

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-rst-order",
        registry,
      });

      await runtime.reset();

      // Check order
      assert.deepEqual(orderLog, [
        "reset:browser",
        "reset:terminal",
        "reset:editor",
        "reset:wait",
        "reset:narration",
        "reset:visual",
      ]);
    });

    it("14. active operation is cancelled and settled before domain reset begins", async () => {
      const { plan } = buildValidatedReferencePlan();
      const orderLog: string[] = [];
      let stepResolve!: (res: EngineExecutionResult) => void;
      const stepPromise = new Promise<EngineExecutionResult>((resolve) => {
        stepResolve = resolve;
      });

      const { registry } = createControllableRegistry(
        {
          narration: {
            onExecute: async () => await stepPromise,
            onCancel: () => {
              orderLog.push("cancel:narration");
              stepResolve(
                createCancelledResult({
                  engine: "narration",
                  operation_id: "C01-L001-S001-B001",
                  session_id: "sess-rst-active",
                  generation: 1,
                  attempt_id: "A001",
                  duration_ms: 10,
                }),
              );
            },
          },
        },
        orderLog,
      );

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-rst-active",
        registry,
      });

      const runPromise = runtime.start();
      await runtime.reset();

      assert.equal(orderLog[0], "cancel:narration");
      assert.equal(orderLog[1], "reset:browser");
      assert.equal(orderLog[2], "reset:terminal");
      assert.equal(orderLog[3], "reset:editor");
      await runPromise;
    });

    it("15. generation rotates strictly AFTER absence barrier passes; playhead returns to step 1 attempt A001", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-rst-gen",
        registry,
      });

      await runtime.start();
      assert.equal(runtime.getGeneration(), 1);
      assert.equal(runtime.getPlayhead().isAtEnd(), true);

      await runtime.reset();

      assert.equal(runtime.getState(), "READY");
      assert.equal(runtime.getGeneration(), 2);
      assert.equal(runtime.getPlayhead().getGeneration(), 2);
      assert.equal(runtime.getPlayhead().getAttemptId(), "A001");
      assert.equal(runtime.getPlayhead().getCurrentStep().global_step_ordinal, 1);
      assert.equal(runtime.getPlayhead().isAtEnd(), false);
      assert.equal(runtime.getPlayhead().getRemainingStepsCount(), 14);
    });

    it("16. cleanup uncertainty prevents READY and halts into HOLD with CLEANUP_UNCONFIRMED", async () => {
      const { plan } = buildValidatedReferencePlan();

      const { registry } = createControllableRegistry({
        browser: {
          isClean: () => false, // Browser reports surviving process/profile residue!
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-rst-unconfirmed",
        registry,
      });

      await assert.rejects(
        async () => runtime.reset(),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "CLEANUP_UNCONFIRMED");
          return true;
        },
      );

      // Must be halted in HOLD
      assert.equal(runtime.getState(), "HOLD");
      // Generation must NOT have rotated
      assert.equal(runtime.getGeneration(), 1);
    });

    it("17. reset failure halts into HOLD with RESET_FAILED and prevents READY", async () => {
      const { plan } = buildValidatedReferencePlan();

      const { registry } = createControllableRegistry({
        terminal: {
          onReset: () => {
            throw new Error("Docker daemon uncontactable during container teardown");
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-rst-fail",
        registry,
      });

      await assert.rejects(
        async () => runtime.reset(),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "RESET_FAILED");
          return true;
        },
      );

      assert.equal(runtime.getState(), "HOLD");
      assert.equal(runtime.getGeneration(), 1);
    });

    it("18. duplicate concurrent reset converges deterministically without overlapping barriers", async () => {
      const { plan } = buildValidatedReferencePlan();
      let resetCount = 0;

      const { registry } = createControllableRegistry({
        browser: {
          onReset: async () => {
            resetCount++;
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-rst-dup",
        registry,
      });

      // Issue two concurrent reset calls
      const [r1, r2] = await Promise.all([runtime.reset(), runtime.reset()]);

      assert.equal(runtime.getState(), "READY");
      // Exactly 1 reset barrier executed
      assert.equal(resetCount, 1);
      assert.equal(runtime.getGeneration(), 2);
    });

    it("19. late adapter results from previous generation are dropped fail-closed after reset", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-rst-stale",
        registry,
      });

      await runtime.reset();
      assert.equal(runtime.getGeneration(), 2);

      // Construct late result stamped with generation 1
      const lateResult = createCompletedResult({
        engine: "editor",
        operation_id: "C01-L001-S001-B002",
        session_id: "sess-rst-stale",
        generation: 1, // Stale!
        attempt_id: "A001",
        duration_ms: 10,
      });

      // Verify playhead before
      const cursorBefore = runtime.getPlayhead().getCurrentStep().step_id;
      assert.equal(cursorBefore, "C01-L001-S001-B001");

      // Playhead and state must remain untouched
      assert.equal(runtime.getPlayhead().getCurrentStep().step_id, cursorBefore);
      assert.equal(runtime.getState(), "READY");
    });
  });

  // =========================================================================
  // 4. Coordinated Global Close Mechanics
  // =========================================================================

  describe("Coordinated Global Close Mechanics", () => {
    it("20. close enforces reverse dependency order: Browser -> Terminal -> Workspace -> Seal Journal -> CLOSED", async () => {
      const { plan } = buildValidatedReferencePlan();
      const orderLog: string[] = [];
      const { registry } = createControllableRegistry({}, orderLog);

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-cls-order",
        registry,
      });

      await runtime.close();

      assert.deepEqual(orderLog, [
        "close:browser",
        "close:terminal",
        "close:editor",
        "close:wait",
        "close:narration",
        "close:visual",
      ]);

      assert.equal(runtime.getState(), "CLOSED");
      assert.equal(runtime.getJournal().isSealed(), true);

      // Verification: commit after seal must throw fail-closed
      assert.throws(
        () =>
          runtime.getJournal().commit({
            lesson_id: "C01-L001",
            scene_id: "C01-L001-S001",
            step_id: "C01-L001-S001-B001",
            kind: "lifecycle",
            engine: "orchestrator",
            event_type: "runtime.started",
            attempt_id: "A001",
          }),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "INVALID_REQUEST");
          return true;
        },
      );
    });

    it("21. CLOSED state is final: start, pause, resume, cancel, reset all reject fail-closed", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-cls-final",
        registry,
      });

      await runtime.close();
      assert.equal(runtime.getState(), "CLOSED");

      await assert.rejects(async () => runtime.start(), (err: any) => err.code === "RUNTIME_NOT_READY");
      await assert.rejects(async () => runtime.pause(), (err: any) => err.code === "INVALID_STATE_TRANSITION");
      await assert.rejects(async () => runtime.resume(), (err: any) => err.code === "INVALID_STATE_TRANSITION");
      await assert.rejects(async () => runtime.cancel(), (err: any) => err.code === "INVALID_STATE_TRANSITION");
      await assert.rejects(async () => runtime.reset(), (err: any) => err.code === "INVALID_STATE_TRANSITION");

      // Duplicate close is idempotent
      await runtime.close();
      assert.equal(runtime.getState(), "CLOSED");
    });
  });

  // =========================================================================
  // 5. Bounded Timeouts & Deadlock Prevention
  // =========================================================================

  describe("Bounded Timeouts & Deadlock Prevention", () => {
    it("22. hanging adapter cancel times out deterministically to HOLD without deadlock", async () => {
      const { plan } = buildValidatedReferencePlan();
      const clock = new ManualLogicalClock(1000);

      const { registry } = createControllableRegistry({
        narration: {
          onExecute: () => new Promise(() => {}), // Never completes
          onCancel: () => new Promise(() => {}), // Never completes
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-timeout-cancel",
        registry,
        clock,
        barrierTimeoutMs: 500,
      });

      runtime.start();

      const cancelPromise = runtime.cancel();

      // Advance clock past timeout limit
      clock.advanceBy(600);

      await assert.rejects(
        async () => cancelPromise,
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "ENGINE_OUTCOME_UNCERTAIN");
          return true;
        },
      );

      assert.equal(runtime.getState(), "HOLD");
    });

    it("23. hanging browser reset times out deterministically to HOLD without deadlock", async () => {
      const { plan } = buildValidatedReferencePlan();
      const clock = new ManualLogicalClock(1000);

      const { registry } = createControllableRegistry({
        browser: {
          onReset: () => new Promise(() => {}), // Never completes
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-timeout-browser",
        registry,
        clock,
        barrierTimeoutMs: 500,
      });

      const resetPromise = runtime.reset();
      clock.advanceBy(600);

      await assert.rejects(
        async () => resetPromise,
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "RESET_FAILED");
          return true;
        },
      );

      assert.equal(runtime.getState(), "HOLD");
    });

    it("24. hanging terminal reset times out deterministically to HOLD without deadlock", async () => {
      const { plan } = buildValidatedReferencePlan();
      const clock = new ManualLogicalClock(1000);

      const { registry } = createControllableRegistry({
        terminal: {
          onReset: () => new Promise(() => {}), // Never completes
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-timeout-term",
        registry,
        clock,
        barrierTimeoutMs: 500,
      });

      const resetPromise = runtime.reset();
      clock.advanceBy(600);

      await assert.rejects(
        async () => resetPromise,
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "RESET_FAILED");
          return true;
        },
      );

      assert.equal(runtime.getState(), "HOLD");
    });

    it("25. hanging workspace reset times out deterministically to HOLD without deadlock", async () => {
      const { plan } = buildValidatedReferencePlan();
      const clock = new ManualLogicalClock(1000);

      const { registry } = createControllableRegistry({
        editor: {
          onReset: () => new Promise(() => {}), // Never completes
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-timeout-editor",
        registry,
        clock,
        barrierTimeoutMs: 500,
      });

      const resetPromise = runtime.reset();
      clock.advanceBy(600);

      await assert.rejects(
        async () => resetPromise,
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "RESET_FAILED");
          return true;
        },
      );

      assert.equal(runtime.getState(), "HOLD");
    });
  });

  // =========================================================================
  // 6. Comprehensive Race Matrix & Granular Domain Lifecycle Tests
  // =========================================================================

  describe("Granular Domain Lifecycle & Race Matrix", () => {
    it("26. pause during editor action finishes editor step terminally before halting", async () => {
      const { plan } = buildValidatedReferencePlan();
      let editorResolve!: (res: EngineExecutionResult) => void;
      const editorPromise = new Promise<EngineExecutionResult>((resolve) => {
        editorResolve = resolve;
      });

      const { registry } = createControllableRegistry({
        editor: {
          onExecute: async (admission) => {
            if (admission.operationId === "C01-L001-S001-B002") {
              return await editorPromise;
            }
            return createCompletedResult({
              engine: "editor",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              duration_ms: 10,
            });
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-pause-editor",
        registry,
      });

      let editorStartedResolve!: () => void;
      const editorStarted = new Promise<void>((resolve) => {
        editorStartedResolve = resolve;
      });

      runtime.getJournal().onEvent((e) => {
        if (e.event_type === "runtime.step.started" && e.step_id === "C01-L001-S001-B002") {
          editorStartedResolve();
        }
      });

      const runPromise = runtime.start();
      await editorStarted;

      // Request pause while editor step 2 is active
      const pausePromise = runtime.pause();
      assert.equal(runtime.isPauseRequested(), true);

      // Settle editor step 2
      editorResolve(
        createCompletedResult({
          engine: "editor",
          operation_id: "C01-L001-S001-B002",
          session_id: "sess-p86-pause-editor",
          generation: 1,
          attempt_id: "A001",
          duration_ms: 20,
        }),
      );

      await pausePromise;
      assert.equal(runtime.getState(), "PAUSED");
      // Step 2 completed, playhead at step 3
      assert.equal(runtime.getPlayhead().getCurrentStep().step_id, "C01-L001-S001-B003");

      await runtime.resume();
      await runPromise;
      assert.equal(runtime.getState(), "COMPLETED");
    });

    it("27. pause during terminal action finishes terminal step, updates ledger, then halts", async () => {
      const { plan } = buildValidatedReferencePlan();
      let termResolve!: (res: EngineExecutionResult) => void;
      const termPromise = new Promise<EngineExecutionResult>((resolve) => {
        termResolve = resolve;
      });

      const { registry } = createControllableRegistry({
        terminal: {
          onExecute: async (admission) => {
            if (admission.operationId === "C01-L001-S001-B006") {
              return await termPromise;
            }
            return createCompletedResult({
              engine: "terminal",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              duration_ms: 10,
            });
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-pause-term",
        registry,
      });

      let termStartedResolve!: () => void;
      const termStarted = new Promise<void>((resolve) => {
        termStartedResolve = resolve;
      });

      runtime.getJournal().onEvent((e) => {
        if (e.event_type === "runtime.step.started" && e.step_id === "C01-L001-S001-B006") {
          termStartedResolve();
        }
      });

      const runPromise = runtime.start();
      await termStarted;

      // Pause while terminal bg run is in flight
      const pausePromise = runtime.pause();
      assert.equal(runtime.isPauseRequested(), true);

      // Terminal step 6 confirms spawn
      termResolve(
        createCompletedResult({
          engine: "terminal",
          operation_id: "C01-L001-S001-B006",
          session_id: "sess-p86-pause-term",
          generation: 1,
          attempt_id: "A001",
          duration_ms: 15,
        }),
      );

      await pausePromise;
      assert.equal(runtime.getState(), "PAUSED");
      // Background process is registered active in ledger
      assert.equal(runtime.getProcessLedger().isLive("demo_server"), true);
      // Playhead at step 7
      assert.equal(runtime.getPlayhead().getCurrentStep().step_id, "C01-L001-S001-B007");

      await runtime.resume();
      await runPromise;
      assert.equal(runtime.getState(), "COMPLETED");
    });

    it("28. pause during browser action finishes browser step, advances playhead, then halts", async () => {
      const { plan } = buildValidatedReferencePlan();
      let browserResolve!: (res: EngineExecutionResult) => void;
      const browserPromise = new Promise<EngineExecutionResult>((resolve) => {
        browserResolve = resolve;
      });

      const { registry } = createControllableRegistry({
        browser: {
          onExecute: async (admission) => {
            if (admission.operationId === "C01-L001-S001-B008") {
              return await browserPromise;
            }
            return createCompletedResult({
              engine: "browser",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              duration_ms: 10,
            });
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-pause-browser",
        registry,
      });

      let browserStartedResolve!: () => void;
      const browserStarted = new Promise<void>((resolve) => {
        browserStartedResolve = resolve;
      });

      runtime.getJournal().onEvent((e) => {
        if (e.event_type === "runtime.step.started" && e.step_id === "C01-L001-S001-B008") {
          browserStartedResolve();
        }
      });

      const runPromise = runtime.start();
      await browserStarted;

      const pausePromise = runtime.pause();
      assert.equal(runtime.isPauseRequested(), true);

      browserResolve(
        createCompletedResult({
          engine: "browser",
          operation_id: "C01-L001-S001-B008",
          session_id: "sess-p86-pause-browser",
          generation: 1,
          attempt_id: "A001",
          duration_ms: 30,
        }),
      );

      await pausePromise;
      assert.equal(runtime.getState(), "PAUSED");
      assert.equal(runtime.getPlayhead().getCurrentStep().step_id, "C01-L001-S001-B009");

      await runtime.resume();
      await runPromise;
      assert.equal(runtime.getState(), "COMPLETED");
    });

    it("29. pause vs reset race: reset requested while pause latch pending settles to READY with generation++", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-pause-rst",
        registry,
      });

      const runPromise = runtime.start();
      await runtime.pause();
      assert.equal(runtime.getState(), "PAUSED");

      // Reset from PAUSED
      await runtime.reset();
      assert.equal(runtime.getState(), "READY");
      assert.equal(runtime.getGeneration(), 2);
      assert.equal(runtime.isPauseRequested(), false);
      assert.equal(runtime.isPaused(), false);
      assert.equal(runtime.getPlayhead().getCurrentStep().global_step_ordinal, 1);
    });

    it("30. cancel vs reset race: reset requested while CANCELLING settles through RESETTING to READY", async () => {
      const { plan } = buildValidatedReferencePlan();
      let cancelBarrierResolve!: () => void;
      const cancelBarrier = new Promise<void>((resolve) => {
        cancelBarrierResolve = resolve;
      });

      const { registry } = createControllableRegistry({
        narration: {
          onExecute: () => new Promise(() => {}),
          onCancel: async () => {
            await cancelBarrier;
          },
        },
      });

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-cancel-rst",
        registry,
      });

      runtime.start();
      // Start cancel in background
      runtime.cancel();
      assert.equal(runtime.getState(), "CANCELLING");

      cancelBarrierResolve();

      // Reset requested from CANCELLING state
      await runtime.reset();
      assert.equal(runtime.getState(), "READY");
      assert.equal(runtime.getGeneration(), 2);
    });

    it("31. close vs reset race: reset from CLOSING or CLOSED fails closed with INVALID_STATE_TRANSITION", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-cls-rst",
        registry,
      });

      await runtime.close();
      assert.equal(runtime.getState(), "CLOSED");

      await assert.rejects(
        async () => runtime.reset(),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "INVALID_STATE_TRANSITION");
          return true;
        },
      );
    });

    it("32. reset vs old timer callback: timer callback from generation 1 is fenced in generation 2", async () => {
      const { plan } = buildValidatedReferencePlan();
      const clock = new ManualLogicalClock(0);
      let staleCallbackExecuted = false;

      const { registry } = createControllableRegistry();
      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-timer-fence",
        registry,
        clock,
      });

      // Schedule a timer bound to generation 1
      const gen1 = runtime.getGeneration();
      clock.setTimeout(() => {
        if (runtime.getGeneration() === gen1) {
          staleCallbackExecuted = true;
        }
      }, 5000);

      // Reset before timer fires
      await runtime.reset();
      assert.equal(runtime.getGeneration(), 2);

      // Advance clock past timer deadline
      clock.advanceBy(6000);

      // Callback must be fenced from mutating generation 2 state
      assert.equal(staleCallbackExecuted, false);
      assert.equal(runtime.getState(), "READY");
      assert.equal(runtime.getGeneration(), 2);
    });

    it("33. reset clears old-generation background processes in ledger and re-registers for generation 2", async () => {
      const { plan } = buildValidatedReferencePlan();
      const { registry } = createControllableRegistry();

      const runtime = LessonRuntime.create(plan, {
        sessionId: "sess-p86-ledger-rst",
        registry,
      });

      await runtime.start();
      assert.equal(runtime.getState(), "COMPLETED");

      // Reset
      await runtime.reset();
      assert.equal(runtime.getState(), "READY");
      assert.equal(runtime.getGeneration(), 2);

      // Ledger process records should be re-registered in generation 2
      const proc = runtime.getProcessLedger().getProcess("demo_server");
      assert.ok(proc);
      assert.equal(proc.state, "REGISTERED");
      assert.equal(proc.generation, 2);
      assert.equal(runtime.getProcessLedger().isLive("demo_server"), false);
      assert.deepEqual(runtime.getProcessLedger().getActiveProcessIds(), []);
    });
  });
});
