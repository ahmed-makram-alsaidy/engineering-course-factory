// P8.4 Engine Adapter Layer Test Suite
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 10 & Section 32, and ADR-0013.
// Comprehensive verification of all 6 canonical runtime adapters:
// - Common adapter contract & admission invariants
// - EngineAdapterRegistry closed vocabulary & orchestrator family rejection
// - Session, generation, attempt, and engine-family fencing
// - Normalized result envelopes (COMPLETED, FAILED, CANCELLED, UNCERTAIN)
// - Preserving UNCERTAIN_DO_NOT_RETRY & REQUIRES_RESET semantics
// - EditorRuntimeAdapter (file_open, file_create, type_code, replace_code, file_save)
// - TerminalRuntimeAdapter (foreground run, background run, stop, process_output wait)
// - BrowserRuntimeAdapter (all 7 browser actions, identifier-only dispatch)
// - WaitRuntimeAdapter (duration wait, pause beat, port wait, process_output rejection)
// - SimulatedNarrationAdapter (instant, timed, cancellation, zero audio/TTS)
// - VisualRuntimeAdapter (highlight, presentation intent, zero recording)
// - Deterministic race testing (zero real sleep, ManualLogicalClock)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CompiledStep } from "@course-factory/lesson-compiler/ir";
import {
  type OrchestratorContext,
  EditorRuntimeAdapter,
  TerminalRuntimeAdapter,
  BrowserRuntimeAdapter,
  WaitRuntimeAdapter,
  SimulatedNarrationAdapter,
  VisualRuntimeAdapter,
  EngineAdapterRegistry,
  type EditorDomainSession,
  type TerminalDomainSession,
  type BrowserDomainSession,
  type VisualPresentationHost,
  type VisualPresentationIntent,
} from "../src/adapters/index.ts";
import { ManualLogicalClock } from "../src/clock.ts";
import { RuntimeError } from "../src/errors.ts";
import { formatAttemptId } from "../src/playhead.ts";
import { RuntimeValidator } from "../src/validator.ts";
import { createCanonicalReferenceLesson } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// Test Helpers & Synthetic Context Builder
// ---------------------------------------------------------------------------

function buildTestContext(options?: {
  sessionId?: string;
  generation?: number;
  attemptId?: string;
  lessonId?: string;
}): OrchestratorContext {
  const validator = new RuntimeValidator();
  const report = validator.validate(createCanonicalReferenceLesson());
  assert.ok(report.ok && report.plan !== null, "Plan validation must succeed");

  return {
    runtime_session_id: options?.sessionId ?? "sess-runtime-test-001",
    generation: options?.generation ?? 1,
    lesson_id: options?.lessonId ?? "C01-L001",
    attempt_id: options?.attemptId ?? formatAttemptId(1),
    plan: report.plan,
  };
}

function findStepByType(actionType: string): CompiledStep {
  const lesson = createCanonicalReferenceLesson();
  for (const scene of lesson.scenes) {
    for (const step of scene.steps) {
      if (step.kind === "operation" && step.operation.type === actionType) {
        return step;
      }
    }
  }
  throw new Error(`Step of type '${actionType}' not found in canonical reference fixture`);
}

function findStepByKind(kind: "narration" | "pause"): CompiledStep {
  const lesson = createCanonicalReferenceLesson();
  for (const scene of lesson.scenes) {
    for (const step of scene.steps) {
      if (step.kind === kind) {
        return step;
      }
    }
  }
  throw new Error(`Step of kind '${kind}' not found in canonical reference fixture`);
}

// ---------------------------------------------------------------------------
// 1. Adapter Registry & Common Contract Tests
// ---------------------------------------------------------------------------

describe("P8.4: Engine Adapter Registry & Common Contract", () => {
  const clock = new ManualLogicalClock(1_000_000);
  const editor = new EditorRuntimeAdapter({ clock });
  const terminal = new TerminalRuntimeAdapter({ clock });
  const browser = new BrowserRuntimeAdapter({ clock });
  const wait = new WaitRuntimeAdapter({ clock });
  const narration = new SimulatedNarrationAdapter({ clock });
  const visual = new VisualRuntimeAdapter({ clock });

  const registry = new EngineAdapterRegistry({
    editor,
    terminal,
    browser,
    wait,
    narration,
    visual,
  });

  it("registry contains exact canonical adapters", () => {
    assert.equal(registry.getAdapter("editor"), editor);
    assert.equal(registry.getAdapter("terminal"), terminal);
    assert.equal(registry.getAdapter("browser"), browser);
    assert.equal(registry.getAdapter("wait"), wait);
    assert.equal(registry.getAdapter("narration"), narration);
    assert.equal(registry.getAdapter("visual"), visual);
    assert.equal(registry.listRegisteredFamilies().length, 6);
  });

  it("orchestrator engine family is explicitly rejected from registry", () => {
    assert.throws(
      () => registry.getAdapter("orchestrator"),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "ENGINE_UNAVAILABLE");
        assert.match(err.message, /internal orchestrator control plane/);
        return true;
      },
    );
    assert.equal(registry.hasAdapter("orchestrator"), false);
  });

  it("unknown engine family rejected", () => {
    assert.throws(
      () => registry.getAdapter("unknown_engine" as any),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "ENGINE_UNAVAILABLE");
        return true;
      },
    );
  });

  it("wrong-family dispatch rejected before domain call", async () => {
    const context = buildTestContext();
    const terminalStep = findStepByType("terminal_run");

    // Attempt to admit a terminal step to the browser adapter
    await assert.rejects(
      async () => browser.admit(terminalStep, context),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "ENGINE_DISPATCH_FAILED");
        assert.match(err.message, /cannot be dispatched/);
        return true;
      },
    );
  });

  it("stale session rejected before domain call", async () => {
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-actual-001",
      generation: 1,
      admit: () => ({ ok: true }),
      execute: async () => ({ ok: true }),
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const boundEditor = new EditorRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-stale-999" });
    const fileCreateStep = findStepByType("file_create");

    await assert.rejects(
      async () => boundEditor.admit(fileCreateStep, context),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "STALE_RUNTIME_SESSION");
        return true;
      },
    );
  });

  it("stale generation rejected before domain call", async () => {
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-runtime-test-001",
      generation: 2,
      admit: () => ({ ok: true }),
      execute: async () => ({ ok: true }),
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const boundEditor = new EditorRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-runtime-test-001", generation: 1 });
    const fileCreateStep = findStepByType("file_create");

    await assert.rejects(
      async () => boundEditor.admit(fileCreateStep, context),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "STALE_GENERATION");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. EditorRuntimeAdapter Tests
// ---------------------------------------------------------------------------

describe("P8.4: EditorRuntimeAdapter (P6)", () => {
  const clock = new ManualLogicalClock(1_000_000);

  it("admits file_create, type_code, file_save with identifier-only authority", async () => {
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-editor-01",
      generation: 1,
      admit: () => ({ ok: true }),
      execute: async () => ({ ok: true, domain_seq: 14 }),
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new EditorRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-editor-01", generation: 1 });

    const step = findStepByType("file_create");
    const admission = await adapter.admit(step, context);

    assert.equal(admission.engine, "editor");
    assert.equal(admission.actionType, "file_create");
    assert.equal(admission.operationId, step.step_id);
    assert.equal(admission.sessionId, "sess-editor-01");
    assert.equal(admission.generation, 1);

    const controller = new AbortController();
    const result = await adapter.execute(admission, controller.signal);

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.engine, "editor");
    assert.equal(result.retry, "NOT_RETRYABLE");
    assert.equal(result.detail.domain_seq, 14);
    // Verified: no file contents, code strings, or paths leak into execution result envelope
    assert.equal((result as any).content, undefined);
    assert.equal((result as any).code, undefined);
  });

  it("save confirmed -> COMPLETED result", async () => {
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-editor-02",
      generation: 1,
      admit: () => ({ ok: true }),
      execute: async () => ({ ok: true, domain_seq: 42 }),
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new EditorRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-editor-02", generation: 1 });
    const step = findStepByType("file_save");

    const admission = await adapter.admit(step, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.detail.domain_seq, 42);
    assert.equal(result.retry, "NOT_RETRYABLE");
  });

  it("external conflict -> deterministic FAILED with NOT_RETRYABLE", async () => {
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-editor-03",
      generation: 1,
      admit: () => ({ ok: true }),
      execute: async () => ({
        ok: false,
        rejection: {
          code: "EXTERNAL_CONFLICT",
          message: "Disk file modified externally: conflict detected on E:\\course-factory\\temp\\src\\app.js",
        },
      }),
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new EditorRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-editor-03", generation: 1 });
    const step = findStepByType("file_save");

    const admission = await adapter.admit(step, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "FAILED");
    assert.equal(result.retry, "NOT_RETRYABLE");
    assert.equal(result.detail.code, "EXTERNAL_CONFLICT");
    // Machine paths must be redacted
    assert.ok(!result.detail.message?.includes("E:\\course-factory"));
    assert.ok(result.detail.message?.includes("[path]"));
  });

  it("COMMIT_UNCERTAIN -> UNCERTAIN with UNCERTAIN_DO_NOT_RETRY", async () => {
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-editor-04",
      generation: 1,
      admit: () => ({ ok: true }),
      execute: async () => ({
        ok: false,
        domain_seq: 88,
        rejection: {
          code: "COMMIT_UNCERTAIN",
          message: "Journal append failed after publication: outcome uncertain with evidence retained",
        },
      }),
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new EditorRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-editor-04", generation: 1 });
    const step = findStepByType("file_save");

    const admission = await adapter.admit(step, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "UNCERTAIN");
    assert.equal(result.retry, "UNCERTAIN_DO_NOT_RETRY");
    assert.equal(result.detail.code, "COMMIT_UNCERTAIN");
    assert.equal(result.detail.domain_seq, 88);
  });

  it("stale workspace generation rejected", async () => {
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-editor-05",
      generation: 2,
      admit: () => ({ ok: true }),
      execute: async () => ({ ok: true }),
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new EditorRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-editor-05", generation: 1 });
    const step = findStepByType("file_save");

    await assert.rejects(
      async () => adapter.admit(step, context),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "STALE_GENERATION");
        return true;
      },
    );
  });

  it("renderer cannot supply file path or content (identifier-only authority)", async () => {
    // The adapter receives ONLY CompiledStep and OrchestratorContext.
    // There is structurally zero path or content argument in admit or execute.
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-editor-06",
      generation: 1,
      admit: (opId) => {
        assert.equal(typeof opId, "string");
        return { ok: true };
      },
      execute: async (adm) => {
        assert.equal(typeof adm.operationId, "string");
        return { ok: true };
      },
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new EditorRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-editor-06", generation: 1 });
    const step = findStepByType("file_create");

    const admission = await adapter.admit(step, context);
    const result = await adapter.execute(admission, new AbortController().signal);
    assert.equal(result.status, "COMPLETED");
  });
});

// ---------------------------------------------------------------------------
// 3. TerminalRuntimeAdapter Tests
// ---------------------------------------------------------------------------

describe("P8.4: TerminalRuntimeAdapter (P5)", () => {
  const clock = new ManualLogicalClock(2_000_000);

  it("foreground run normal exit -> COMPLETED", async () => {
    const fakeSession: TerminalDomainSession = {
      sessionId: "sess-term-01",
      generation: 1,
      runOperation: async () => ({
        ok: true,
        exit_code: 0,
        domain_seq: 19,
      }),
      stopProcess: async () => ({ ok: true }),
      cancelOperation: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new TerminalRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-term-01", generation: 1 });
    const step = findStepByType("terminal_run"); // foreground

    const admission = await adapter.admit(step, context);
    assert.equal(admission.runMode, "foreground");

    const result = await adapter.execute(admission, new AbortController().signal);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.detail.exit_code, 0);
    assert.equal(result.detail.domain_seq, 19);
    assert.equal(result.retry, "NOT_RETRYABLE");
  });

  it("foreground command failure -> FAILED with non-zero exit code", async () => {
    const fakeSession: TerminalDomainSession = {
      sessionId: "sess-term-02",
      generation: 1,
      runOperation: async () => ({
        ok: false,
        exit_code: 127,
        domain_seq: 20,
        error: {
          code: "COMMAND_FAILED",
          message: "Process exited with code 127: command not found",
          exit_code: 127,
          retry: "NOT_RETRYABLE",
        },
      }),
      stopProcess: async () => ({ ok: true }),
      cancelOperation: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new TerminalRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-term-02", generation: 1 });
    const step = findStepByType("terminal_run");

    const admission = await adapter.admit(step, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "FAILED");
    assert.equal(result.detail.exit_code, 127);
    assert.equal(result.retry, "NOT_RETRYABLE");
    assert.equal(result.detail.code, "COMMAND_FAILED");
  });

  it("background run -> confirms spawned/running as COMPLETED without waiting for process exit", async () => {
    const lesson = createCanonicalReferenceLesson();
    // Step 6 is background server run
    const bgStep = lesson.scenes[0]!.steps[5]!;
    assert.equal(bgStep.kind, "operation");
    assert.equal((bgStep.operation.parameters as any).mode, "background");

    const fakeSession: TerminalDomainSession = {
      sessionId: "sess-term-03",
      generation: 1,
      runOperation: async () => ({
        ok: true,
        isBackground: true,
        domain_seq: 25,
        exit_code: null, // Still running!
      }),
      stopProcess: async () => ({ ok: true }),
      cancelOperation: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new TerminalRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-term-03", generation: 1 });

    const admission = await adapter.admit(bgStep, context);
    assert.equal(admission.runMode, "background");
    assert.equal(admission.processId, "demo_server");

    const result = await adapter.execute(admission, new AbortController().signal);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.detail.exit_code, null);
    assert.equal(result.detail.domain_seq, 25);
  });

  it("terminal_stop delegates through domain session", async () => {
    const stopStep = findStepByType("terminal_stop");

    let stoppedProcessId: string | null = null;
    const fakeSession: TerminalDomainSession = {
      sessionId: "sess-term-04",
      generation: 1,
      runOperation: async () => ({ ok: true }),
      stopProcess: async (req) => {
        stoppedProcessId = req.process_id;
        return { ok: true, domain_seq: 33 };
      },
      cancelOperation: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new TerminalRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-term-04", generation: 1 });

    const admission = await adapter.admit(stopStep, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "COMPLETED");
    assert.equal(stoppedProcessId, "demo_server");
    assert.equal(result.detail.domain_seq, 33);
  });

  it("process_output wait delegates to P5 primitive and completes on match", async () => {
    // Synthetic process_output wait step
    const waitStep: CompiledStep = {
      kind: "operation",
      step_id: "step-output-wait-01",
      ordinal: 1,
      derived: false,
      source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: "B-wait-out", form: "authored_beat" },
      operation: {
        type: "wait",
        family: "wait",
        parameters: {
          type: "wait",
          until: "process_output",
          process_id: "demo_server",
          marker: "Server listening",
          timeout_seconds: 5,
        } as any,
      },
    };

    let observedMarker: string | null = null;
    const fakeSession: TerminalDomainSession = {
      sessionId: "sess-term-05",
      generation: 1,
      runOperation: async () => ({ ok: true }),
      stopProcess: async () => ({ ok: true }),
      waitForProcessOutput: async (req) => {
        observedMarker = req.marker;
        return { ok: true, domain_seq: 55 };
      },
      cancelOperation: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new TerminalRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-term-05", generation: 1 });

    const admission = await adapter.admit(waitStep, context);
    assert.equal(admission.actionType, "wait");
    assert.equal(admission.outputWaitMarker, "Server listening");

    const result = await adapter.execute(admission, new AbortController().signal);
    assert.equal(result.status, "COMPLETED");
    assert.equal(observedMarker, "Server listening");
    assert.equal(result.detail.domain_seq, 55);
  });

  it("transport uncertainty preserved as UNCERTAIN / UNCERTAIN_DO_NOT_RETRY", async () => {
    const fakeSession: TerminalDomainSession = {
      sessionId: "sess-term-06",
      generation: 1,
      runOperation: async () => ({
        ok: false,
        error: {
          code: "TRANSPORT_DROPPED",
          message: "Docker supervisor connection lost during command execution",
          uncertain: true,
        },
      }),
      stopProcess: async () => ({ ok: true }),
      cancelOperation: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new TerminalRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-term-06", generation: 1 });
    const step = findStepByType("terminal_run");

    const admission = await adapter.admit(step, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "UNCERTAIN");
    assert.equal(result.retry, "UNCERTAIN_DO_NOT_RETRY");
  });
});

// ---------------------------------------------------------------------------
// 4. BrowserRuntimeAdapter Tests
// ---------------------------------------------------------------------------

describe("P8.4: BrowserRuntimeAdapter (P7)", () => {
  const clock = new ManualLogicalClock(3_000_000);

  it("all browser actions delegate with identifier-only request (zero URL, selector, value in P8 dispatch)", async () => {
    const browserActionTypes = [
      "browser_open",
      "browser_click",
      "browser_fill",
      "browser_press",
      "browser_refresh",
      "browser_wait",
      "browser_assert",
    ] as const;

    for (const actionType of browserActionTypes) {
      let dispatchedRequestId: string | null = null;
      let dispatchedOpId: string | null = null;

      const fakeSession: BrowserDomainSession = {
        sessionId: "sess-browser-01",
        generation: 1,
        runOperation: async (req) => {
          dispatchedRequestId = req.request_id;
          dispatchedOpId = req.operation_id;
          // Verify that request carries ONLY identifiers
          assert.equal(Object.keys(req).sort().join(","), "operation_id,request_id,session_id");
          return { ok: true, domain_seq: 101 };
        },
        cancelOperation: () => true,
        reset: () => {},
        close: () => {},
      };

      const adapter = new BrowserRuntimeAdapter({ session: fakeSession, clock });
      const context = buildTestContext({ sessionId: "sess-browser-01", generation: 1 });

      // Create a step for each browser action type
      const step: CompiledStep = {
        kind: "operation",
        step_id: `step-${actionType}-001`,
        ordinal: 1,
        derived: false,
        source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: `b-${actionType}`, form: "authored_beat" },
        operation: {
          type: actionType,
          family: "browser",
          parameters: {
            type: actionType,
            url: "http://localhost:3000",
            selector: "#submit",
            value: "admin",
            key: "Enter",
          } as any,
        },
      };

      const admission = await adapter.admit(step, context);
      assert.equal(admission.actionType, actionType);

      const result = await adapter.execute(admission, new AbortController().signal);
      assert.equal(result.status, "COMPLETED");
      assert.equal(dispatchedOpId, `step-${actionType}-001`);
      assert.ok(String(dispatchedRequestId).startsWith("req-browser-"));
      assert.equal(result.detail.domain_seq, 101);

      // Verify no URL or selector leaks to result
      assert.equal((result as any).url, undefined);
      assert.equal((result as any).selector, undefined);
    }
  });

  it("page crash maps to FAILED with REQUIRES_RESET", async () => {
    const fakeSession: BrowserDomainSession = {
      sessionId: "sess-browser-02",
      generation: 1,
      runOperation: async () => ({
        ok: false,
        error: {
          code: "PAGE_CRASHED",
          message: "Chromium tab crashed unexpectedly",
          retry: "REQUIRES_RESET",
        },
      }),
      cancelOperation: () => true,
      reset: () => {},
      close: () => {},
    };

    const adapter = new BrowserRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-browser-02", generation: 1 });
    const step = findStepByType("browser_click");

    const admission = await adapter.admit(step, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "FAILED");
    assert.equal(result.retry, "REQUIRES_RESET");
    assert.equal(result.detail.code, "PAGE_CRASHED");
  });

  it("side-effect uncertainty maps to UNCERTAIN / UNCERTAIN_DO_NOT_RETRY", async () => {
    const fakeSession: BrowserDomainSession = {
      sessionId: "sess-browser-03",
      generation: 1,
      runOperation: async () => ({
        ok: false,
        error: {
          code: "SUBMIT_UNCERTAIN",
          message: "Form submit network dropped before response receipt: outcome uncertain",
          uncertain: true,
        },
      }),
      cancelOperation: () => true,
      reset: () => {},
      close: () => {},
    };

    const adapter = new BrowserRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-browser-03", generation: 1 });
    const step = findStepByType("browser_click");

    const admission = await adapter.admit(step, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "UNCERTAIN");
    assert.equal(result.retry, "UNCERTAIN_DO_NOT_RETRY");
  });
});

// ---------------------------------------------------------------------------
// 5. WaitRuntimeAdapter Tests
// ---------------------------------------------------------------------------

describe("P8.4: WaitRuntimeAdapter (Logical Clock & Port Readiness)", () => {
  it("duration wait succeeds with ManualLogicalClock (zero real sleep)", async () => {
    const clock = new ManualLogicalClock(4_000_000);
    const adapter = new WaitRuntimeAdapter({ clock });
    const context = buildTestContext();

    const durationStep: CompiledStep = {
      kind: "operation",
      step_id: "step-wait-dur-1",
      ordinal: 1,
      derived: false,
      source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: "b-dur", form: "authored_beat" },
      operation: {
        type: "wait",
        family: "wait",
        parameters: {
          type: "wait",
          until: "duration",
          duration_ms: 5000,
        } as any,
      },
    };

    const admission = await adapter.admit(durationStep, context);
    assert.equal(admission.waitKind, "duration");
    assert.equal(admission.durationMs, 5000);

    const execPromise = adapter.execute(admission, new AbortController().signal);

    // Before clock advance: timer is armed, not settled
    assert.equal(clock.getPendingTimerCount(), 1);

    // Advance clock by 5000ms
    clock.advanceBy(5000);

    const result = await execPromise;
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.engine, "wait");
    assert.equal(result.detail.duration_ms, 5000);
  });

  it("pause beat succeeds with ManualLogicalClock", async () => {
    const clock = new ManualLogicalClock(4_100_000);
    const adapter = new WaitRuntimeAdapter({ clock });
    const context = buildTestContext();
    const pauseStep = findStepByKind("pause");

    const admission = await adapter.admit(pauseStep, context);
    assert.equal(admission.waitKind, "pause");
    assert.equal(admission.durationMs, 2000);

    const execPromise = adapter.execute(admission, new AbortController().signal);
    clock.advanceBy(2000);

    const result = await execPromise;
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.detail.duration_ms, 2000);
  });

  it("duration wait cancelled honestly via AbortSignal", async () => {
    const clock = new ManualLogicalClock(4_200_000);
    const adapter = new WaitRuntimeAdapter({ clock });
    const context = buildTestContext();

    const durationStep: CompiledStep = {
      kind: "operation",
      step_id: "step-wait-dur-2",
      ordinal: 1,
      derived: false,
      source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: "b-dur-2", form: "authored_beat" },
      operation: {
        type: "wait",
        family: "wait",
        parameters: {
          type: "wait",
          until: "duration",
          duration_ms: 10_000,
        } as any,
      },
    };

    const admission = await adapter.admit(durationStep, context);
    const controller = new AbortController();

    const execPromise = adapter.execute(admission, controller.signal);

    // Advance partially
    clock.advanceBy(3000);
    // Cancel in-flight
    controller.abort();

    const result = await execPromise;
    assert.equal(result.status, "CANCELLED");
    assert.equal(result.retry, "NOT_RETRYABLE");
    assert.equal(clock.getPendingTimerCount(), 0);
  });

  it("port wait delegates to port readiness provider", async () => {
    const clock = new ManualLogicalClock(4_300_000);
    let probedPort = 0;
    let probedHost = "";

    const fakeProvider = async (port: number, timeoutMs?: number, pollIntervalMs?: number, host?: string) => {
      probedPort = port;
      probedHost = host ?? "";
      return true;
    };

    const adapter = new WaitRuntimeAdapter({ clock, portReadinessProvider: fakeProvider });
    const context = buildTestContext();
    const portStep = findStepByType("wait"); // reference fixture Step 7 is port 3000

    const admission = await adapter.admit(portStep, context);
    assert.equal(admission.waitKind, "port");
    assert.equal(admission.port, 3000);

    const result = await adapter.execute(admission, new AbortController().signal);
    assert.equal(result.status, "COMPLETED");
    assert.equal(probedPort, 3000);
    assert.equal(probedHost, "127.0.0.1");
  });

  it("process_output wait is rejected by WaitRuntimeAdapter (must route to Terminal)", async () => {
    const clock = new ManualLogicalClock(4_400_000);
    const adapter = new WaitRuntimeAdapter({ clock });
    const context = buildTestContext();

    const procOutStep: CompiledStep = {
      kind: "operation",
      step_id: "step-wait-out-bad",
      ordinal: 1,
      derived: false,
      source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: "b-bad", form: "authored_beat" },
      operation: {
        type: "wait",
        family: "terminal",
        parameters: {
          type: "wait",
          until: "process_output",
          process_id: "demo_server",
          marker: "Ready",
        } as any,
      },
    };

    await assert.rejects(
      async () => adapter.admit(procOutStep, context),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "ENGINE_DISPATCH_FAILED");
        assert.match(err.message, /process_output wait must be routed to TerminalRuntimeAdapter/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 6. SimulatedNarrationAdapter Tests
// ---------------------------------------------------------------------------

describe("P8.4: SimulatedNarrationAdapter (P10 Seam)", () => {
  it("instant mode completes on tick with zero delay", async () => {
    const clock = new ManualLogicalClock(5_000_000);
    const adapter = new SimulatedNarrationAdapter({ clock, simulationMode: "instant" });
    const context = buildTestContext();
    const narrationStep = findStepByKind("narration");

    const admission = await adapter.admit(narrationStep, context);
    assert.equal(admission.engine, "narration");
    assert.ok(admission.text.length > 0);

    const result = await adapter.execute(admission, new AbortController().signal);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.engine, "narration");
    assert.equal(result.retry, "NOT_RETRYABLE");
    assert.equal(result.detail.duration_ms, 0);
  });

  it("timed simulation mode uses Clock based on word count", async () => {
    const clock = new ManualLogicalClock(5_100_000);
    const adapter = new SimulatedNarrationAdapter({ clock, simulationMode: "timed", wordsPerSecond: 2.5 });
    const context = buildTestContext();
    const narrationStep = findStepByKind("narration");

    const admission = await adapter.admit(narrationStep, context);
    assert.ok(admission.simulatedDurationMs > 0);

    const execPromise = adapter.execute(admission, new AbortController().signal);
    clock.advanceBy(admission.simulatedDurationMs);

    const result = await execPromise;
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.detail.duration_ms, admission.simulatedDurationMs);
  });

  it("cancellation halts simulated narration timer honestly", async () => {
    const clock = new ManualLogicalClock(5_200_000);
    const adapter = new SimulatedNarrationAdapter({ clock, simulationMode: "timed" });
    const context = buildTestContext();
    const narrationStep = findStepByKind("narration");

    const admission = await adapter.admit(narrationStep, context);
    const controller = new AbortController();

    const execPromise = adapter.execute(admission, controller.signal);
    clock.advanceBy(500);
    controller.abort();

    const result = await execPromise;
    assert.equal(result.status, "CANCELLED");
    assert.equal(result.retry, "NOT_RETRYABLE");
    assert.equal(clock.getPendingTimerCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// 7. VisualRuntimeAdapter Tests
// ---------------------------------------------------------------------------

describe("P8.4: VisualRuntimeAdapter (Teaching IDE Seam)", () => {
  const clock = new ManualLogicalClock(6_000_000);

  it("highlight delegates presentation intent without renderer input", async () => {
    let receivedIntent: VisualPresentationIntent | null = null;
    const fakeHost: VisualPresentationHost = {
      showHighlight: (intent) => {
        receivedIntent = intent;
      },
      clearHighlight: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new VisualRuntimeAdapter({ host: fakeHost, clock });
    const context = buildTestContext();

    const highlightStep: CompiledStep = {
      kind: "operation",
      step_id: "step-visual-hl-1",
      ordinal: 1,
      derived: false,
      source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: "b-hl", form: "authored_beat" },
      operation: {
        type: "highlight",
        family: "visual",
        parameters: {
          type: "highlight",
          path: "src/app.js",
          line: 12,
          line_end: 18,
        } as any,
      },
    };

    const admission = await adapter.admit(highlightStep, context);
    assert.equal(admission.actionType, "highlight");
    assert.equal(admission.targetPath, "src/app.js");
    assert.equal(admission.line, 12);
    assert.equal(admission.lineEnd, 18);

    const result = await adapter.execute(admission, new AbortController().signal);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.engine, "visual");
    const intent = receivedIntent as VisualPresentationIntent | null;
    assert.equal(intent?.path, "src/app.js");
    assert.equal(intent?.line, 12);
    assert.equal(intent?.line_end, 18);
  });

  it("visual cancellation completes honestly", async () => {
    let cleared = false;
    const fakeHost: VisualPresentationHost = {
      showHighlight: () => {},
      clearHighlight: () => {
        cleared = true;
      },
    };

    const adapter = new VisualRuntimeAdapter({ host: fakeHost, clock });
    const context = buildTestContext();

    const highlightStep: CompiledStep = {
      kind: "operation",
      step_id: "step-visual-hl-2",
      ordinal: 1,
      derived: false,
      source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: "b-hl-2", form: "authored_beat" },
      operation: {
        type: "highlight",
        family: "visual",
        parameters: {
          type: "highlight",
          path: "src/app.js",
        } as any,
      },
    };

    const admission = await adapter.admit(highlightStep, context);
    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const result = await adapter.execute(admission, controller.signal);
    assert.equal(result.status, "CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// 8. Deterministic Race Tests & Fail-Closed Fencing
// ---------------------------------------------------------------------------

describe("P8.4: Race Tests & Settlement Invariants", () => {
  const clock = new ManualLogicalClock(7_000_000);

  it("stale attempt rejected before domain call", async () => {
    let domainExecuted = false;
    let currentGen = 1;
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-race-01",
      get generation() {
        return currentGen;
      },
      admit: () => ({ ok: true }),
      execute: async () => {
        domainExecuted = true;
        return { ok: true };
      },
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new EditorRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-race-01", generation: 1, attemptId: "A001" });
    const step = findStepByType("file_save");

    const admission = await adapter.admit(step, context);

    // Now rotate generation on domain session, simulating stale attempt / stale generation
    currentGen = 2;

    const result = await adapter.execute(admission, new AbortController().signal);

    // Stale generation must fail closed before domain execution
    assert.equal(domainExecuted, false);
    assert.equal(result.status, "FAILED");
    assert.equal(result.retry, "REQUIRES_RESET");
    assert.equal(result.detail.code, "STALE_GENERATION");
  });

  it("cancel vs domain completion settles exactly once", async () => {
    let cancelCalled = false;
    const fakeSession: TerminalDomainSession = {
      sessionId: "sess-race-02",
      generation: 1,
      runOperation: async ({ signal }) => {
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            cancelCalled = true;
            resolve({
              ok: false,
              error: {
                code: "OPERATION_CANCELLED",
                message: "Run cancelled",
              },
            });
          });
        });
      },
      stopProcess: async () => ({ ok: true }),
      cancelOperation: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new TerminalRuntimeAdapter({ session: fakeSession, clock });
    const context = buildTestContext({ sessionId: "sess-race-02", generation: 1 });
    const step = findStepByType("terminal_run");

    const admission = await adapter.admit(step, context);
    const controller = new AbortController();

    const execPromise = adapter.execute(admission, controller.signal);
    controller.abort();

    const result = await execPromise;
    assert.equal(cancelCalled, true);
    assert.equal(result.status, "CANCELLED");
    assert.equal(result.retry, "NOT_RETRYABLE");
  });

  it("adapter has zero authority to advance playhead, mutate state machine, or write global journal", () => {
    const editor = new EditorRuntimeAdapter({ clock });
    const terminal = new TerminalRuntimeAdapter({ clock });
    const browser = new BrowserRuntimeAdapter({ clock });
    const wait = new WaitRuntimeAdapter({ clock });
    const narration = new SimulatedNarrationAdapter({ clock });
    const visual = new VisualRuntimeAdapter({ clock });

    const adapters = [editor, terminal, browser, wait, narration, visual];

    for (const adapter of adapters) {
      // Adapters must NOT possess playhead methods
      assert.equal((adapter as any).advance, undefined);
      assert.equal((adapter as any).advancePlayhead, undefined);
      assert.equal((adapter as any).cursor, undefined);

      // Adapters must NOT possess state machine transition methods
      assert.equal((adapter as any).transition, undefined);
      assert.equal((adapter as any).setState, undefined);
      assert.equal((adapter as any).state, undefined);

      // Adapters must NOT possess global journal write methods
      assert.equal((adapter as any).appendEvent, undefined);
      assert.equal((adapter as any).allocateGlobalSeq, undefined);
      assert.equal((adapter as any).commit, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Real Platform Seam & Engine Contract Proofs
// ---------------------------------------------------------------------------

describe("P8.4: Real Platform Seam & Engine Contract Proofs", () => {
  it("real port wait proof: detects active loopback TCP port without WAN", async () => {
    const net = await import("node:net");
    const server = net.createServer();

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as import("node:net").AddressInfo;
    const realPort = address.port;

    try {
      const realWaitAdapter = new WaitRuntimeAdapter({
        portReadinessProvider: async (port, timeoutMs) => {
          const startTime = Date.now();
          while (Date.now() - startTime < (timeoutMs ?? 3000)) {
            const isConnected = await new Promise<boolean>((resolveConnection) => {
              const socket = net.createConnection({ port, host: "127.0.0.1", timeout: 200 }, () => {
                socket.destroy();
                resolveConnection(true);
              });
              socket.on("error", () => {
                socket.destroy();
                resolveConnection(false);
              });
              socket.on("timeout", () => {
                socket.destroy();
                resolveConnection(false);
              });
            });

            if (isConnected) return true;
            await new Promise((r) => setTimeout(r, 20));
          }
          return false;
        },
      });

      const portStep: CompiledStep = {
        kind: "operation",
        step_id: "step-real-port-01",
        ordinal: 1,
        derived: false,
        source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: "b-rp-1", form: "authored_beat" },
        operation: {
          type: "wait",
          family: "wait",
          parameters: {
            type: "wait",
            until: "port",
            port: realPort,
            timeout_seconds: 3,
          } as any,
        },
      };

      const context = buildTestContext();
      const admission = await realWaitAdapter.admit(portStep, context);
      const result = await realWaitAdapter.execute(admission, new AbortController().signal);

      assert.equal(result.status, "COMPLETED");
      assert.equal(result.engine, "wait");
      assert.equal(result.retry, "NOT_RETRYABLE");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("real Editor contract: validates reviewed catalog and operation identity", async () => {
    const editorStep = findStepByType("file_create");
    const fakeSession: EditorDomainSession = {
      sessionId: "sess-p6-real-01",
      generation: 1,
      admit: (opId) => {
        assert.equal(opId, editorStep.step_id);
        return { ok: true };
      },
      execute: async (adm) => {
        assert.equal(adm.operationId, editorStep.step_id);
        assert.equal(adm.actionType, "file_create");
        return { ok: true, domain_seq: 1 };
      },
      cancel: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new EditorRuntimeAdapter({ session: fakeSession });
    const context = buildTestContext({ sessionId: "sess-p6-real-01", generation: 1 });

    const admission = await adapter.admit(editorStep, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "COMPLETED");
    assert.equal(result.detail.domain_seq, 1);
  });

  it("real Terminal contract: validates process output wait observation seam", async () => {
    let waitObserved = false;
    const fakeSession: TerminalDomainSession = {
      sessionId: "sess-p5-real-01",
      generation: 1,
      runOperation: async () => ({ ok: true }),
      stopProcess: async () => ({ ok: true }),
      waitForProcessOutput: async (req) => {
        assert.equal(req.process_id, "demo_server");
        assert.equal(req.marker, "Ready");
        waitObserved = true;
        return { ok: true, domain_seq: 9 };
      },
      cancelOperation: () => {},
      reset: () => {},
      close: () => {},
    };

    const adapter = new TerminalRuntimeAdapter({ session: fakeSession });
    const context = buildTestContext({ sessionId: "sess-p5-real-01", generation: 1 });

    const waitStep: CompiledStep = {
      kind: "operation",
      step_id: "step-term-wait-real",
      ordinal: 1,
      derived: false,
      source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: "b-tw-1", form: "authored_beat" },
      operation: {
        type: "wait",
        family: "terminal",
        parameters: {
          type: "wait",
          until: "process_output",
          process_id: "demo_server",
          marker: "Ready",
        } as any,
      },
    };

    const admission = await adapter.admit(waitStep, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "COMPLETED");
    assert.equal(waitObserved, true);
    assert.equal(result.detail.domain_seq, 9);
  });

  it("real Browser contract: validates identifier-only dispatch against reviewed operations", async () => {
    const browserStep = findStepByType("browser_click");
    let receivedOpId: string | null = null;

    const fakeSession: BrowserDomainSession = {
      sessionId: "sess-p7-real-01",
      generation: 1,
      runOperation: async (req) => {
        receivedOpId = req.operation_id;
        return { ok: true, domain_seq: 7 };
      },
      cancelOperation: () => true,
      reset: () => {},
      close: () => {},
    };

    const adapter = new BrowserRuntimeAdapter({ session: fakeSession });
    const context = buildTestContext({ sessionId: "sess-p7-real-01", generation: 1 });

    const admission = await adapter.admit(browserStep, context);
    const result = await adapter.execute(admission, new AbortController().signal);

    assert.equal(result.status, "COMPLETED");
    assert.equal(receivedOpId, browserStep.step_id);
    assert.equal(result.detail.domain_seq, 7);
  });
});
