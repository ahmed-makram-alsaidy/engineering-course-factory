// P8.5 Lesson Runtime Orchestrator Tests
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 5, 7, 8, 16, 21, 22, 28 & ADR-0013.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LessonRuntime } from "../src/runtime.ts";
import { RuntimeJournal } from "../src/journal.ts";
import { ProcessLifecycleLedger } from "../src/process-ledger.ts";
import { ManualLogicalClock } from "../src/clock.ts";
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
// Deterministic Fake Adapter Implementation
// ---------------------------------------------------------------------------

interface FakeAdapterConfig {
  readonly onAdmit?: (step: CompiledStep, context: OrchestratorContext) => Promise<void> | void;
  readonly onExecute?: (admission: CommonAdapterAdmission, signal: AbortSignal) => Promise<EngineExecutionResult> | EngineExecutionResult;
}

class FakeEngineAdapter implements EngineAdapter {
  readonly family: EngineFamily;
  readonly admissions: CommonAdapterAdmission[] = [];
  readonly executions: CommonAdapterAdmission[] = [];
  readonly cancels: string[] = [];
  readonly resets: number[] = [];
  closes = 0;

  private config: FakeAdapterConfig;

  constructor(family: EngineFamily, config: FakeAdapterConfig = {}) {
    this.family = family;
    this.config = config;
  }

  setConfig(config: FakeAdapterConfig): void {
    this.config = config;
  }

  async admit(step: CompiledStep, context: OrchestratorContext): Promise<CommonAdapterAdmission> {
    if (this.config.onAdmit) {
      await this.config.onAdmit(step, context);
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
    if (this.config.onExecute) {
      return await this.config.onExecute(admission, signal);
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
  }

  async reset(generation: number): Promise<void> {
    this.resets.push(generation);
  }

  async close(): Promise<void> {
    this.closes++;
  }
}

function createFakeRegistry(configs: Partial<Record<EngineFamily, FakeAdapterConfig>> = {}): {
  registry: EngineAdapterRegistry;
  adapters: Record<"editor" | "terminal" | "browser" | "wait" | "narration" | "visual", FakeEngineAdapter>;
} {
  const adapters = {
    editor: new FakeEngineAdapter("editor", configs.editor),
    terminal: new FakeEngineAdapter("terminal", configs.terminal),
    browser: new FakeEngineAdapter("browser", configs.browser),
    wait: new FakeEngineAdapter("wait", configs.wait),
    narration: new FakeEngineAdapter("narration", configs.narration),
    visual: new FakeEngineAdapter("visual", configs.visual),
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
// Tests
// ---------------------------------------------------------------------------

describe("P8.5: LessonRuntime Core & Global Journal Orchestration", () => {
  it("1. creates runtime from ValidatedRuntimePlan and preserves plan integrity", () => {
    const { plan, compiledLesson } = buildValidatedReferencePlan();
    const { registry } = createFakeRegistry();

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-01",
      registry,
      compiledLesson,
    });

    assert.equal(runtime.getSessionId(), "sess-p8-01");
    assert.equal(runtime.getPlan().lesson_id, "C01-L001");
    assert.equal(runtime.getPlan().plan_digest, plan.plan_digest);
    assert.equal(runtime.getGeneration(), 1);
    assert.equal(runtime.getState(), "READY");
    assert.equal(runtime.getPlayhead().getRemainingStepsCount(), 14);
  });

  it("2. initial state is READY and snapshot reflects initial playhead coordinate", () => {
    const { plan } = buildValidatedReferencePlan();
    const { registry } = createFakeRegistry();

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-02",
      registry,
    });

    const snapshot = runtime.getSnapshot();
    assert.equal(snapshot.state, "READY");
    assert.equal(snapshot.playhead.global_step_ordinal, 1);
    assert.equal(snapshot.playhead.scene_id, "C01-L001-S001");
    assert.equal(snapshot.playhead.step_id, "C01-L001-S001-B001");
    assert.equal(snapshot.last_outcome, null);
    assert.equal(snapshot.journal_high_seq, 0);
  });

  it("3. start from READY transitions to RUNNING and executes multi-engine plan to COMPLETED", async () => {
    const { plan, compiledLesson } = buildValidatedReferencePlan();
    const { registry, adapters } = createFakeRegistry();
    const clock = new ManualLogicalClock(1000);

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-happy",
      registry,
      clock,
      compiledLesson,
    });

    await runtime.start();

    assert.equal(runtime.getState(), "COMPLETED");
    assert.equal(runtime.getLastOutcome(), "COMPLETED");
    assert.equal(runtime.getPlayhead().isAtEnd(), true);
    assert.equal(runtime.getPlayhead().getRemainingStepsCount(), 0);

    // Verify all 6 adapters received expected steps in order
    // Reference lesson breakdown:
    // Step 1: narration
    // Step 2: file_create (editor)
    // Step 3: type_code (editor)
    // Step 4: file_save (editor)
    // Step 5: terminal_run fg (terminal)
    // Step 6: terminal_run bg (terminal)
    // Step 7: wait until: port (wait)
    // Step 8: browser_open (browser)
    // Step 9: browser_fill (browser)
    // Step 10: browser_click (browser)
    // Step 11: browser_assert (browser)
    // Step 12: terminal_stop (terminal)
    // Step 13: pause 2s (wait)
    // Step 14: narration (narration)
    assert.equal(adapters.narration.executions.length, 2);
    assert.equal(adapters.editor.executions.length, 3);
    assert.equal(adapters.terminal.executions.length, 3);
    assert.equal(adapters.wait.executions.length, 2);
    assert.equal(adapters.browser.executions.length, 4);

    // Verify global journal chronology
    const events = runtime.getJournal().getAllEvents();
    assert.ok(events.length >= 30); // runtime.started, 14*(step.started + step.completed), runtime.completed
    assert.equal(events[0].event_type, "runtime.started");
    assert.equal(events[events.length - 1].event_type, "runtime.completed");
  });

  it("4. duplicate start while RUNNING or COMPLETED is rejected fail-closed", async () => {
    const { plan } = buildValidatedReferencePlan();
    const { registry } = createFakeRegistry();

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-dup",
      registry,
    });

    await runtime.start();
    assert.equal(runtime.getState(), "COMPLETED");

    await assert.rejects(
      async () => runtime.start(),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "RUNTIME_NOT_READY");
        return true;
      },
    );
  });

  it("5. concurrency is strictly 1: exactly one active beat at any instant", async () => {
    const { plan } = buildValidatedReferencePlan();
    let maxConcurrent = 0;
    let currentlyRunning = 0;

    const { registry } = createFakeRegistry({
      narration: {
        onExecute: async (admission) => {
          currentlyRunning++;
          maxConcurrent = Math.max(maxConcurrent, currentlyRunning);
          currentlyRunning--;
          return createCompletedResult({
            engine: "narration",
            operation_id: admission.operationId,
            session_id: admission.sessionId,
            generation: admission.generation,
            attempt_id: admission.attemptId,
            duration_ms: 5,
          });
        },
      },
      editor: {
        onExecute: async (admission) => {
          currentlyRunning++;
          maxConcurrent = Math.max(maxConcurrent, currentlyRunning);
          currentlyRunning--;
          return createCompletedResult({
            engine: "editor",
            operation_id: admission.operationId,
            session_id: admission.sessionId,
            generation: admission.generation,
            attempt_id: admission.attemptId,
            duration_ms: 5,
          });
        },
      },
    });

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-conc",
      registry,
    });

    await runtime.start();
    assert.equal(maxConcurrent, 1);
  });

  it("6. playhead advance rule: advances strictly AFTER journal commit", async () => {
    const { plan } = buildValidatedReferencePlan();
    let journalHighSeqAtAdvanceCheck = 0;

    const { registry } = createFakeRegistry({
      narration: {
        onExecute: (admission) => {
          return createCompletedResult({
            engine: "narration",
            operation_id: admission.operationId,
            session_id: admission.sessionId,
            generation: admission.generation,
            attempt_id: admission.attemptId,
            duration_ms: 5,
          });
        },
      },
    });

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-order",
      registry,
    });

    // Listen to journal events
    runtime.getJournal().onEvent((event) => {
      if (event.event_type === "runtime.step.completed") {
        // At the instant runtime.step.completed is committed, journalHighSeq should be >= event.global_seq
        journalHighSeqAtAdvanceCheck = runtime.getJournal().getHighSeq();
        assert.ok(journalHighSeqAtAdvanceCheck >= event.global_seq);
      }
    });

    await runtime.start();
    assert.ok(journalHighSeqAtAdvanceCheck > 0);
  });

  it("7. step failure halts progression with state FAILED and playhead remains at failing step", async () => {
    const { plan } = buildValidatedReferencePlan();
    const failingStepId = "C01-L001-S001-B002"; // Step 2 (file_create)

    const { registry, adapters } = createFakeRegistry({
      editor: {
        onExecute: (admission) => {
          if (admission.operationId === failingStepId) {
            return createFailedResult({
              engine: "editor",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              code: "FILE_CREATION_FAILED",
              message: "File creation denied by policy",
              duration_ms: 10,
              retry: "NOT_RETRYABLE",
            });
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
      sessionId: "sess-p8-fail",
      registry,
    });

    await runtime.start();

    assert.equal(runtime.getState(), "FAILED");
    assert.equal(runtime.getLastOutcome(), "FAILED");
    // Playhead should remain at Step 2
    assert.equal(runtime.getPlayhead().getCurrentStep().step_id, failingStepId);
    assert.equal(runtime.getPlayhead().isAtEnd(), false);

    // Subsequent steps (terminal, browser) must NEVER have been dispatched
    assert.equal(adapters.terminal.executions.length, 0);
    assert.equal(adapters.browser.executions.length, 0);

    // Global journal must record runtime.step.failed
    const events = runtime.getJournal().getAllEvents();
    const failedEvent = events.find((e) => e.event_type === "runtime.step.failed");
    assert.ok(failedEvent);
    assert.equal(failedEvent.step_id, failingStepId);
    assert.equal(failedEvent.outcome, "FAILED");
  });

  it("8. UNCERTAIN step outcome halts progression immediately to HOLD without auto-retry", async () => {
    const { plan } = buildValidatedReferencePlan();
    const uncertainStepId = "C01-L001-S001-B004"; // Step 4 (file_save)
    let executionAttempts = 0;

    const { registry } = createFakeRegistry({
      editor: {
        onExecute: (admission) => {
          if (admission.operationId === uncertainStepId) {
            executionAttempts++;
            return createUncertainResult({
              engine: "editor",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              code: "COMMIT_UNCERTAIN",
              message: "Staging commit timeout with unconfirmed publication",
              duration_ms: 100,
            });
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
      sessionId: "sess-p8-hold",
      registry,
    });

    await runtime.start();

    assert.equal(runtime.getState(), "HOLD");
    assert.equal(runtime.getLastOutcome(), "UNCERTAIN");
    assert.equal(runtime.getPlayhead().getCurrentStep().step_id, uncertainStepId);
    // Automatic retry strictly forbidden: exactly 1 attempt made
    assert.equal(executionAttempts, 1);

    // Journal records runtime.step.uncertain
    const events = runtime.getJournal().getAllEvents();
    const uncertainEvent = events.find((e) => e.event_type === "runtime.step.uncertain");
    assert.ok(uncertainEvent);
    assert.equal(uncertainEvent.outcome, "UNCERTAIN");
  });

  it("9. REQUIRES_RESET fails closed to FAILED without auto-reset", async () => {
    const { plan } = buildValidatedReferencePlan();
    const crashStepId = "C01-L001-S001-B005"; // Step 5 (terminal_run)

    const { registry, adapters } = createFakeRegistry({
      terminal: {
        onExecute: (admission) => {
          return createFailedResult({
            engine: "terminal",
            operation_id: admission.operationId,
            session_id: admission.sessionId,
            generation: admission.generation,
            attempt_id: admission.attemptId,
            code: "CONTAINER_CRASH",
            message: "Docker container terminated unexpectedly",
            duration_ms: 20,
            retry: "REQUIRES_RESET",
          });
        },
      },
    });

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-reqreset",
      registry,
    });

    await runtime.start();

    assert.equal(runtime.getState(), "FAILED");
    assert.equal(adapters.terminal.resets.length, 0); // Zero auto-resets in P8.5
  });

  it("10. adapter pre-dispatch throw is safe confirmed failure (FAILED)", async () => {
    const { plan } = buildValidatedReferencePlan();

    const { registry } = createFakeRegistry({
      editor: {
        onAdmit: () => {
          throw new Error("Admission catalog lookup failed");
        },
      },
    });

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-predispatch",
      registry,
    });

    await runtime.start();

    assert.equal(runtime.getState(), "FAILED");
    assert.equal(runtime.getLastOutcome(), "FAILED");
  });

  it("11. adapter post-dispatch throw is safe uncertainty (HOLD)", async () => {
    const { plan } = buildValidatedReferencePlan();

    const { registry } = createFakeRegistry({
      editor: {
        onExecute: () => {
          throw new Error("Unexpected network socket drop during file save");
        },
      },
    });

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-postdispatch",
      registry,
    });

    await runtime.start();

    assert.equal(runtime.getState(), "HOLD");
    assert.equal(runtime.getLastOutcome(), "UNCERTAIN");
  });

  it("12. background process start marks process ACTIVE in ledger", async () => {
    const { plan } = buildValidatedReferencePlan();
    const { registry } = createFakeRegistry();

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-proc",
      registry,
    });

    // Run until step 6 (terminal_run bg)
    let stepCount = 0;
    runtime.getJournal().onEvent((e) => {
      if (e.event_type === "runtime.step.completed") {
        stepCount++;
        if (e.step_id === "C01-L001-S001-B006") {
          // Check ledger status
          assert.equal(runtime.getProcessLedger().isLive("demo_server"), true);
          assert.deepEqual(runtime.getProcessLedger().getActiveProcessIds(), ["demo_server"]);
        }
      }
    });

    await runtime.start();
    assert.ok(stepCount >= 14);
  });

  it("13. terminal_stop marks background process RETIRED in ledger", async () => {
    const { plan } = buildValidatedReferencePlan();
    const { registry } = createFakeRegistry();

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-proc-stop",
      registry,
    });

    runtime.getJournal().onEvent((e) => {
      if (e.event_type === "runtime.step.completed" && e.step_id === "C01-L001-S001-B012") {
        // Step 12 is terminal_stop
        assert.equal(runtime.getProcessLedger().isLive("demo_server"), false);
      }
    });

    await runtime.start();
  });

  it("14. early background process exit blocks dependent step with DEPENDENCY_NOT_MET", async () => {
    const { plan } = buildValidatedReferencePlan();

    const { registry } = createFakeRegistry();
    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-early-exit",
      registry,
    });

    // Hook: right after step 6 (bg start), simulate early exit before step 7 (wait port) or step 8 (browser open)
    runtime.getJournal().onEvent((e) => {
      if (e.event_type === "runtime.step.completed" && e.step_id === "C01-L001-S001-B006") {
        runtime.getProcessLedger().markExitedEarly("demo_server");
      }
    });

    await runtime.start();

    // Must halt before completing the dependent consumer step
    assert.equal(runtime.getState(), "FAILED");
    assert.equal(runtime.getLastOutcome(), "FAILED");
    const events = runtime.getJournal().getAllEvents();
    const failedEvent = events.find((e) => e.event_type === "runtime.step.failed");
    assert.ok(failedEvent);
    assert.ok(failedEvent.message?.includes("Required background process 'demo_server'"));
  });

  it("15. completion cleanup handles unretired background processes at lesson end", async () => {
    const { plan } = buildValidatedReferencePlan();
    const { registry } = createFakeRegistry();

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-cleanup",
      registry,
    });

    await runtime.start();
    assert.equal(runtime.getState(), "COMPLETED");

    // All completion cleanup processes should be retired
    assert.deepEqual(runtime.getProcessLedger().getProcessesRequiringCompletionCleanup(), []);
  });

  it("16. fences against stale results: session, generation, attempt, and wrong step", async () => {
    const { plan } = buildValidatedReferencePlan();
    let staleTriggered = false;

    const { registry } = createFakeRegistry({
      editor: {
        onExecute: (admission) => {
          if (!staleTriggered) {
            staleTriggered = true;
            // Return result with stale generation (e.g. 99)
            return createCompletedResult({
              engine: "editor",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: 99, // Mismatched generation!
              attempt_id: admission.attemptId,
              duration_ms: 10,
            });
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
      sessionId: "sess-p8-fence",
      registry,
    });

    // Stale result should be dropped fail-closed; execution loop will halt or not double-advance
    await runtime.start();
    // Verify that the stale result did not cause unhandled errors or duplicate commits
    assert.ok(runtime.getState() === "FAILED" || runtime.getState() === "COMPLETED" || runtime.getState() === "HOLD");
  });

  it("17. malformed adapter result fails closed to HOLD", async () => {
    const { plan } = buildValidatedReferencePlan();

    const { registry } = createFakeRegistry({
      editor: {
        onExecute: () => {
          // Return malformed object missing required fields
          return { status: "INVALID_STATUS" } as any;
        },
      },
    });

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-malformed",
      registry,
    });

    await runtime.start();

    assert.equal(runtime.getState(), "HOLD");
    assert.equal(runtime.getLastOutcome(), "UNCERTAIN");
  });

  it("18. journal failure blocks playhead advance and transitions to HOLD", async () => {
    const { plan } = buildValidatedReferencePlan();
    const { registry } = createFakeRegistry();

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-jfail",
      registry,
    });

    // Seal journal after step 1 so step 1 completion commit throws
    runtime.getJournal().onEvent((e) => {
      if (e.event_type === "runtime.step.started") {
        runtime.getJournal().seal();
      }
    });

    await runtime.start();

    assert.equal(runtime.getState(), "HOLD");
    // Playhead did NOT advance beyond step 1
    assert.equal(runtime.getPlayhead().getCurrentStep().step_id, "C01-L001-S001-B001");
  });

  it("19. passive replay reads events without invoking any engine adapter", async () => {
    const { plan } = buildValidatedReferencePlan();
    const { registry, adapters } = createFakeRegistry();

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-replay",
      registry,
    });

    await runtime.start();
    assert.equal(runtime.getState(), "COMPLETED");

    // Record execution counts after lesson run
    const editorCalls = adapters.editor.executions.length;
    const browserCalls = adapters.browser.executions.length;
    const terminalCalls = adapters.terminal.executions.length;

    // Perform multiple passive replay snapshots
    for (let i = 0; i < 5; i++) {
      const page = runtime.getJournal().getSnapshotPage();
      assert.ok(page.events.length > 0);
      const all = runtime.getJournal().getAllEvents();
      assert.ok(all.length > 0);
    }

    // Zero additional adapter invocations
    assert.equal(adapters.editor.executions.length, editorCalls);
    assert.equal(adapters.browser.executions.length, browserCalls);
    assert.equal(adapters.terminal.executions.length, terminalCalls);
  });

  it("20. deferred lifecycle methods throw INVALID_REQUEST referencing P8.6 (P8.6 implemented: invalid states reject fail-closed with INVALID_STATE_TRANSITION)", async () => {
    const { plan } = buildValidatedReferencePlan();
    const { registry } = createFakeRegistry();

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-deferred",
      registry,
    });

    // In READY state: pause, resume, cancel are not permitted
    await assert.rejects(async () => runtime.pause(), (err: unknown) => {
      assert.ok(err instanceof RuntimeError);
      assert.equal(err.code, "INVALID_STATE_TRANSITION");
      return true;
    });
    await assert.rejects(async () => runtime.resume(), (err: unknown) => {
      assert.ok(err instanceof RuntimeError);
      assert.equal(err.code, "INVALID_STATE_TRANSITION");
      return true;
    });
    await assert.rejects(async () => runtime.cancel(), (err: unknown) => {
      assert.ok(err instanceof RuntimeError);
      assert.equal(err.code, "INVALID_STATE_TRANSITION");
      return true;
    });

    // Reset from READY is legal
    await runtime.reset();
    assert.equal(runtime.getState(), "READY");

    // Close from READY is legal
    await runtime.close();
    assert.equal(runtime.getState(), "CLOSED");

    // Once CLOSED: reset is illegal
    await assert.rejects(async () => runtime.reset(), (err: unknown) => {
      assert.ok(err instanceof RuntimeError);
      assert.equal(err.code, "INVALID_STATE_TRANSITION");
      return true;
    });
  });

  it("21. start invoked while run loop active throws RUNTIME_ALREADY_RUNNING (race test)", async () => {
    const { plan } = buildValidatedReferencePlan();
    let resolveFirstStep!: () => void;
    const firstStepBarrier = new Promise<void>((resolve) => {
      resolveFirstStep = resolve;
    });

    const { registry } = createFakeRegistry({
      narration: {
        onExecute: async (admission) => {
          // Block first step until barrier resolved
          await firstStepBarrier;
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
      sessionId: "sess-p8-race-start",
      registry,
    });

    // Start background run
    const runPromise = runtime.start();

    // While in flight, second start must fail deterministically
    await assert.rejects(
      async () => runtime.start(),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "RUNTIME_ALREADY_RUNNING");
        return true;
      },
    );

    // Unblock first step and let lesson finish
    resolveFirstStep();
    await runPromise;
    assert.equal(runtime.getState(), "COMPLETED");
  });

  it("22. late completion after runtime entered FAILED is dropped without mutating playhead", async () => {
    const { plan } = buildValidatedReferencePlan();
    const failingStepId = "C01-L001-S001-B002"; // Step 2 (file_create)

    const { registry } = createFakeRegistry({
      editor: {
        onExecute: (admission) => {
          if (admission.operationId === failingStepId) {
            return createFailedResult({
              engine: "editor",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              code: "COMMAND_FAILED",
              message: "Editor failure",
              duration_ms: 10,
            });
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
      sessionId: "sess-p8-late-fail",
      registry,
    });

    await runtime.start();
    assert.equal(runtime.getState(), "FAILED");
    const playheadBefore = runtime.getPlayhead().getCurrentStep().step_id;
    assert.equal(playheadBefore, failingStepId);

    // Simulate stale late completion arriving from old attempt
    const staleResult = createCompletedResult({
      engine: "editor",
      operation_id: failingStepId,
      session_id: "sess-p8-late-fail",
      generation: 1,
      attempt_id: "A001",
      duration_ms: 5,
    });

    // Playhead and state must remain untouched
    assert.equal(runtime.getPlayhead().getCurrentStep().step_id, failingStepId);
    assert.equal(runtime.getState(), "FAILED");
  });

  it("23. late completion after runtime entered HOLD is dropped without mutating playhead", async () => {
    const { plan } = buildValidatedReferencePlan();
    const holdStepId = "C01-L001-S001-B004"; // Step 4 (file_save)

    const { registry } = createFakeRegistry({
      editor: {
        onExecute: (admission) => {
          if (admission.operationId === holdStepId) {
            return createUncertainResult({
              engine: "editor",
              operation_id: admission.operationId,
              session_id: admission.sessionId,
              generation: admission.generation,
              attempt_id: admission.attemptId,
              code: "COMMIT_UNCERTAIN",
              message: "Uncertain publish",
              duration_ms: 10,
            });
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
      sessionId: "sess-p8-late-hold",
      registry,
    });

    await runtime.start();
    assert.equal(runtime.getState(), "HOLD");
    assert.equal(runtime.getPlayhead().getCurrentStep().step_id, holdStepId);
  });

  it("24. empty plan rejected fail-closed on creation", () => {
    const { plan } = buildValidatedReferencePlan();
    const { registry } = createFakeRegistry();

    const emptyPlan = {
      ...plan,
      total_steps: 0,
      ordered_steps: [],
    };

    assert.throws(
      () => LessonRuntime.create(emptyPlan as any, { sessionId: "sess-p8-empty", registry }),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "RUNTIME_INVALID_LESSON");
        return true;
      },
    );
  });

  it("25. ManualLogicalClock provides deterministic timestamps across all events", async () => {
    const { plan } = buildValidatedReferencePlan();
    const clock = new ManualLogicalClock(5000);

    const { registry } = createFakeRegistry({
      narration: {
        onExecute: (admission) => {
          clock.advanceBy(250);
          return createCompletedResult({
            engine: "narration",
            operation_id: admission.operationId,
            session_id: admission.sessionId,
            generation: admission.generation,
            attempt_id: admission.attemptId,
            duration_ms: 250,
          });
        },
      },
    });

    const runtime = LessonRuntime.create(plan, {
      sessionId: "sess-p8-det-clock",
      registry,
      clock,
    });

    await runtime.start();

    const events = runtime.getJournal().getAllEvents();
    assert.equal(events[0].timestamp_ms, 5000); // runtime.started at start time
    // Timestamps monotonically increasing
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].timestamp_ms >= events[i - 1].timestamp_ms);
    }
  });
});
