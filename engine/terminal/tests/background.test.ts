// P5.8 background lifetime state machine — deterministic unit tests (no
// Docker, no OS processes, no timers). Proves the canonical semantics from
// docs/P5-DESIGN-SPEC.md ("Background Execution", "Process Model", "Output
// Event Contract", "Stop / Cleanup"):
//   - start/lifetime distinction: the STARTED fact is latched at the
//     authoritative ack and lifetime terminal events never rewrite it;
//   - confirmed stop finalization: authored stop PASS (forced=true when the
//     SIGKILL fallback was required, per "Authored stop can PASS forced=true
//     after confirmed death"), operator stop SKIPPED/CANCELLED;
//   - early exit (including 0): FAIL/BACKGROUND_EXITED_EARLY with the TRUE
//     code, then the session fail/close request;
//   - guest failure classifications (OUTPUT_LIMIT / UNEXPECTED_DESCENDANTS):
//     FAIL/<code> + teardown;
//   - one immutable final result: duplicate/late terminal frames can never
//     emit a second operation.completed;
//   - session close/failure/ceiling abort: no final result published;
//   - canonical outcome mapping and journal-storability (schema parity) of
//     every emitted event with the background process identity preserved.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRun, backgroundStopOutcome, type BackgroundRunCallbacks } from "../src/background.ts";
import type { ExecutionGrant } from "../src/admission.ts";
import type { RuntimeEvent, RuntimeEventType, StopCause } from "../src/protocol.ts";
import { RuntimeEventSchema } from "../src/protocol.ts";

// -- harness -------------------------------------------------------------------

function makeGrant(overrides: Partial<ExecutionGrant> = {}): ExecutionGrant {
  return {
    kind: "execution_grant",
    grant_version: 1,
    session_id: "sess-bg",
    generation: 1,
    request_id: "req-1",
    attempt_id: "att-0000001",
    operation_id: "op-bg-1",
    operation_type: "terminal_run",
    mode: "background",
    course_id: "C01",
    lesson_id: "L",
    scene_id: "S1",
    beat_id: "B1",
    process_id: "worker_1",
    command: "node worker.js",
    cwd: null,
    timeout_ms: null,
    expected_exit_code: null,
    ...overrides,
  };
}

interface Fixture {
  events: Array<{ type: RuntimeEventType; payload: unknown }>;
  teardowns: Array<{ code: string; message: string }>;
  run: BackgroundRun;
  /** Build a fully stamped runtime event for schema checks (journal-shape parity). */
  asJournalEvent(index: number): RuntimeEvent;
}

function makeRun(grantOverrides: Partial<ExecutionGrant> = {}): Fixture {
  const grant = makeGrant(grantOverrides);
  const fx: Fixture = {
    events: [],
    teardowns: [],
    run: null as unknown as BackgroundRun,
    asJournalEvent(index: number): RuntimeEvent {
      const emission = fx.events[index]!;
      return RuntimeEventSchema.parse({
        runtime_event_version: 1,
        session_id: grant.session_id,
        generation: grant.generation,
        seq: index + 1,
        monotonic_ms: index,
        operation_id: grant.operation_id,
        attempt_id: grant.attempt_id,
        course_id: grant.course_id,
        lesson_id: grant.lesson_id,
        scene_id: grant.scene_id,
        beat_id: grant.beat_id,
        process_id: grant.process_id,
        type: emission.type,
        payload: emission.payload,
      }) as RuntimeEvent;
    },
  };
  const callbacks: BackgroundRunCallbacks = {
    emitEvent: (type, payload) => fx.events.push({ type, payload }),
    teardown: (code, message) => fx.teardowns.push({ code, message }),
  };
  fx.run = new BackgroundRun({ grant, callbacks });
  fx.run.onStarted();
  return fx;
}

function completedPayload(fx: Fixture): { outcome: string; reason: string | null; exit_code: number | null; forced: boolean } {
  const completed = fx.events.filter((e) => e.type === "operation.completed");
  assert.equal(completed.length, 1, "exactly one final result event");
  return completed[0]!.payload as { outcome: string; reason: string | null; exit_code: number | null; forced: boolean };
}

// -----------------------------------------------------------------------------

describe("P5.8 background state machine: start/lifetime distinction", () => {
  it("the STARTED fact is latched at the ack with no event emission; the receipt outcome is never rewritten", () => {
    const grant = makeGrant();
    const events: Array<{ type: RuntimeEventType; payload: unknown }> = [];
    const run = new BackgroundRun({
      grant,
      callbacks: { emitEvent: (type, payload) => events.push({ type, payload }), teardown: () => {} },
    });
    run.onStarted();
    assert.equal(events.length, 0, "the start completes early and silently (receipt = STARTED fact)");
    // A later lifetime event cannot rewrite the start outcome: the machine
    // only appends the terminal trace.
    run.onStoppedFrame("authored_stop", { forced: false, exit_code: null, signal: "SIGINT" });
    assert.equal(events.length, 2, "terminal trace only");
  });

  it("no lifetime may finalize before the STARTED fact (terminal frames during starting are ignored)", () => {
    const grant = makeGrant();
    const events: Array<{ type: RuntimeEventType; payload: unknown }> = [];
    const teardowns: Array<{ code: string; message: string }> = [];
    const run = new BackgroundRun({
      grant,
      callbacks: { emitEvent: (type, payload) => events.push({ type, payload }), teardown: (c, m) => teardowns.push({ code: c, message: m }) },
    });
    run.onEarlyExit(0, null);
    run.onStoppedFrame("authored_stop", { forced: false, exit_code: null, signal: "SIGINT" });
    run.onFailedFrame("OUTPUT_LIMIT", "bound");
    assert.equal(events.length, 0, "no lifetime trace before the authoritative start ack");
    assert.equal(teardowns.length, 0);
    // After the ack the lifetime is live and can finalize normally.
    run.onStarted();
    run.onStoppedFrame("authored_stop", { forced: false, exit_code: null, signal: "SIGINT" });
    assert.equal(events.filter((e) => e.type === "operation.completed").length, 1);
  });
});

describe("P5.8 background state machine: confirmed stop finalization", () => {
  it("authored stop (graceful) -> process.stopped then operation.completed PASS, forced=false, no teardown", () => {
    const fx = makeRun();
    fx.run.onStoppedFrame("authored_stop", { forced: false, exit_code: null, signal: "SIGINT" });
    assert.deepEqual(
      fx.events.map((e) => e.type),
      ["process.stopped", "operation.completed"],
      "canonical stop trace order",
    );
    const stopped = fx.events[0]!.payload as { cause: string; forced: boolean; exit_code: number | null; signal: string | null };
    assert.equal(stopped.cause, "authored_stop");
    assert.equal(stopped.forced, false);
    assert.equal(stopped.signal, "SIGINT");
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "PASS");
    assert.equal(completed.reason, null);
    assert.equal(completed.forced, false);
    assert.equal(completed.exit_code, null, "no invented exit code for a signal death");
    assert.equal(fx.teardowns.length, 0, "a confirmed stop leaves the session alive");
  });

  it("authored stop can PASS forced=true after confirmed death (SIGKILL fallback was required)", () => {
    const fx = makeRun();
    fx.run.onStoppedFrame("authored_stop", { forced: true, exit_code: null, signal: "SIGKILL" });
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "PASS");
    assert.equal(completed.forced, true, "the force fallback is reported on the result");
    assert.equal(completed.reason, null);
  });

  it("operator stop -> SKIPPED/CANCELLED (operator-initiated termination, no authored completion)", () => {
    const fx = makeRun();
    fx.run.onStoppedFrame("operator_stop", { forced: false, exit_code: null, signal: "SIGINT" });
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "SKIPPED");
    assert.equal(completed.reason, "CANCELLED");
    assert.equal(fx.teardowns.length, 0);
  });

  it("a terminal frame arriving after finalization can never emit a second result", () => {
    const fx = makeRun();
    fx.run.onStoppedFrame("authored_stop", { forced: false, exit_code: null, signal: "SIGINT" });
    fx.run.onEarlyExit(0, null);
    fx.run.onStoppedFrame("operator_stop", { forced: true, exit_code: 137, signal: "SIGKILL" });
    fx.run.onFailedFrame("OUTPUT_LIMIT", "late");
    assert.equal(fx.events.filter((e) => e.type === "operation.completed").length, 1, "one immutable final result");
    assert.equal(fx.teardowns.length, 0, "no duplicate teardown request");
  });
});

describe("P5.8 background state machine: early exit", () => {
  it("natural exit 0 -> FAIL/BACKGROUND_EXITED_EARLY with the true code, then session fail/close", () => {
    const fx = makeRun();
    fx.run.onEarlyExit(0, null);
    assert.deepEqual(
      fx.events.map((e) => e.type),
      ["process.failed", "operation.completed"],
      "failed -> completed (the provider emitted process.exited with the true death fact)",
    );
    const failed = fx.events[0]!.payload as { code: string; message: string };
    assert.equal(failed.code, "BACKGROUND_EXITED_EARLY");
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "FAIL");
    assert.equal(completed.reason, "BACKGROUND_EXITED_EARLY");
    assert.equal(completed.exit_code, 0, "exit 0 is still an EARLY background exit (no readiness claim)");
    assert.equal(completed.forced, false);
    assert.equal(fx.teardowns.length, 1, "the session fails and closes");
    assert.equal(fx.teardowns[0]!.code, "BACKGROUND_EXITED_EARLY");
  });

  it("natural exit 3 -> the TRUE exit code is preserved (never flattened)", () => {
    const fx = makeRun();
    fx.run.onEarlyExit(3, null);
    const completed = completedPayload(fx);
    assert.equal(completed.exit_code, 3);
  });

  it("exit-after-stop-finalization cannot rewrite the latched stop outcome", () => {
    const fx = makeRun();
    fx.run.onStoppedFrame("authored_stop", { forced: false, exit_code: null, signal: "SIGINT" });
    fx.run.onEarlyExit(7, null);
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "PASS", "the confirmed stop owns the record; the late exit cannot undo it");
  });
});

describe("P5.8 background state machine: guest failure classifications", () => {
  it("OUTPUT_LIMIT -> FAIL/OUTPUT_LIMIT with managed teardown", () => {
    const fx = makeRun();
    fx.run.onFailedFrame("OUTPUT_LIMIT", "per-process decoded output exceeded 1 MiB");
    const failed = fx.events[0]!.payload as { code: string };
    assert.equal(failed.code, "OUTPUT_LIMIT");
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "FAIL");
    assert.equal(completed.reason, "OUTPUT_LIMIT");
    assert.equal(completed.exit_code, null, "no invented exit code for a bound termination");
    assert.equal(fx.teardowns.length, 1);
    assert.equal(fx.teardowns[0]!.code, "OUTPUT_LIMIT");
  });

  it("UNEXPECTED_DESCENDANTS -> FAIL/UNEXPECTED_DESCENDANTS with full teardown", () => {
    const fx = makeRun();
    fx.run.onFailedFrame("UNEXPECTED_DESCENDANTS", "residual group");
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "FAIL");
    assert.equal(completed.reason, "UNEXPECTED_DESCENDANTS");
    assert.equal(fx.teardowns.length, 1);
    assert.equal(fx.teardowns[0]!.code, "UNEXPECTED_DESCENDANTS");
  });

  it("a duplicate failure frame after finalization never emits a second result or teardown", () => {
    const fx = makeRun();
    fx.run.onFailedFrame("OUTPUT_LIMIT", "first");
    fx.run.onFailedFrame("OUTPUT_LIMIT", "duplicate");
    assert.equal(fx.events.filter((e) => e.type === "operation.completed").length, 1);
    assert.equal(fx.teardowns.length, 1);
  });
});

describe("P5.8 background state machine: session closing / ceiling abort", () => {
  it("session close/failure/ceiling aborts the lifetime: no final result, no teardown request", () => {
    const fx = makeRun();
    fx.run.sessionClosing();
    fx.run.onStoppedFrame("authored_stop", { forced: false, exit_code: null, signal: "SIGINT" });
    fx.run.onEarlyExit(0, null);
    fx.run.onFailedFrame("OUTPUT_LIMIT", "late");
    assert.equal(fx.events.length, 0, "no event after the session's terminal trace begins");
    assert.equal(fx.teardowns.length, 0);
  });

  it("a lifetime that already finalized is untouched by a later session closing", () => {
    const fx = makeRun();
    fx.run.onStoppedFrame("operator_stop", { forced: false, exit_code: null, signal: "SIGINT" });
    const before = [...fx.events];
    fx.run.sessionClosing();
    assert.deepEqual(fx.events, before, "the immutable result stands");
  });
});

describe("P5.8 background stop outcome mapping (canonical table)", () => {
  it("authored stop PASSes; operator/cancelled/session stops are SKIPPED/CANCELLED; deadline is a defensive FAIL", () => {
    assert.deepEqual(backgroundStopOutcome("authored_stop"), { outcome: "PASS", reason: null });
    assert.deepEqual(backgroundStopOutcome("operator_stop"), { outcome: "SKIPPED", reason: "CANCELLED" });
    assert.deepEqual(backgroundStopOutcome("operation_cancelled"), { outcome: "SKIPPED", reason: "CANCELLED" });
    assert.deepEqual(backgroundStopOutcome("session_closing"), { outcome: "SKIPPED", reason: "CANCELLED" });
    assert.deepEqual(backgroundStopOutcome("timeout"), { outcome: "FAIL", reason: "TIMEOUT" });
  });
});

describe("P5.8 background state machine: journal-shape parity", () => {
  const causes: Array<StopCause> = ["authored_stop", "operator_stop"];

  for (const cause of causes) {
    it(`every emitted event of a ${cause} lifetime parses as a journal-storable runtime event (background process_id preserved)`, () => {
      const fx = makeRun();
      fx.run.onStoppedFrame(cause, { forced: cause === "authored_stop" ? false : true, exit_code: null, signal: "SIGINT" });
      for (let index = 0; index < fx.events.length; index++) {
        const event = fx.asJournalEvent(index);
        assert.equal(event.type.startsWith("operation.") || event.type.startsWith("process."), true);
        assert.equal(event.process_id, "worker_1", "background events keep the authored logical id");
        assert.equal(event.operation_id, "op-bg-1");
      }
      const stopped = fx.asJournalEvent(0);
      assert.equal(stopped.type, "process.stopped");
      const completed = fx.asJournalEvent(1);
      assert.equal(completed.type, "operation.completed");
    });
  }

  it("every emitted event of an early-exit lifetime parses as a journal-storable runtime event", () => {
    const fx = makeRun();
    fx.run.onEarlyExit(0, null);
    for (let index = 0; index < fx.events.length; index++) {
      const event = fx.asJournalEvent(index);
      assert.equal(event.process_id, "worker_1");
    }
    assert.equal(fx.asJournalEvent(0)!.type, "process.failed");
    assert.equal(fx.asJournalEvent(1)!.type, "operation.completed");
  });
});
