// P5.7 foreground completion state machine — deterministic unit tests (fake
// clock/timers, no Docker, no OS processes). Proves the canonical semantics
// from docs/P5-DESIGN-SPEC.md "Foreground Execution":
//   - expected/actual matrix (PASS is exactly actual === expected; actual 7 /
//     expected 7 PASSes; actual 7 / expected 0 FAILs with the true code);
//   - the deadline state machine (armed after the ack, exit before deadline
//     wins, late exit cannot undo a latched timeout, no invented exit code);
//   - one immutable final result (duplicate/late terminal reports ignored);
//   - bounded drain ordering (terminal event + result only after the drain
//     window; outputs recorded during the drain precede the terminal event);
//   - descendant classification (FAIL/UNEXPECTED_DESCENDANTS, never a PASS
//     with surviving owned descendants) and OUTPUT_LIMIT handling;
//   - cancellation (SKIPPED/CANCELLED, trusted operation identity only) and
//     the session-close abort (no final result published after close);
//   - stop-confirmation bound expiry (unconfirmed cleanup + teardown).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ForegroundRun, type ForegroundRunCallbacks } from "../src/foreground.ts";
import type { ExecutionGrant } from "../src/admission.ts";
import type { OperationResult, RuntimeEvent, RuntimeEventType } from "../src/protocol.ts";
import { OperationResultSchema, RuntimeEventSchema } from "../src/protocol.ts";

// -- deterministic fake clock + timer queue -----------------------------------

function fakeClock() {
  let nowMs = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const timersApi = {
    set(fn: () => void, ms: number): unknown {
      const id = nextId++;
      timers.push({ at: nowMs + ms, fn, id });
      return id;
    },
    clear(handle: unknown): void {
      const index = timers.findIndex((t) => t.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  return {
    timers: timersApi,
    now: () => nowMs,
    advance(ms: number): void {
      const target = nowMs + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (next === undefined || next.at > target) break;
        nowMs = next.at;
        timers.shift();
        next.fn();
      }
      nowMs = target;
    },
    pendingTimers: () => timers.length,
  };
}

// -- harness -------------------------------------------------------------------

function makeGrant(overrides: Partial<ExecutionGrant> = {}): ExecutionGrant {
  return {
    kind: "execution_grant",
    grant_version: 1,
    session_id: "sess-fg",
    generation: 1,
    request_id: "req-1",
    attempt_id: "att-0000001",
    operation_id: "op-1",
    operation_type: "terminal_run",
    mode: "foreground",
    course_id: "C01",
    lesson_id: "L",
    scene_id: "S1",
    beat_id: "B1",
    process_id: null,
    command: "node fixture.js",
    cwd: null,
    timeout_ms: 60_000,
    expected_exit_code: 0,
    ...overrides,
  };
}

interface Fixture {
  clock: ReturnType<typeof fakeClock>;
  events: Array<{ type: RuntimeEventType; payload: unknown }>;
  exitedFacts: Array<{ exit_code: number | null; signal: string | null; stopped: boolean; forced: boolean }>;
  stopCount: number;
  teardowns: Array<{ code: string; message: string }>;
  results: OperationResult[];
  aborts: Array<{ code: string; message: string }>;
  outputBytes: number;
  run: ForegroundRun;
  /** Build a fully stamped runtime event for schema checks (journal-shape parity). */
  asJournalEvent(index: number): RuntimeEvent;
}

function makeRun(grantOverrides: Partial<ExecutionGrant> = {}, opts: { drainWindowMs?: number; stopConfirmTimeoutMs?: number; deadlineMs?: number } = {}): Fixture {
  const clock = fakeClock();
  const grant = makeGrant({ timeout_ms: opts.deadlineMs ?? 60_000, ...grantOverrides });
  const fx: Fixture = {
    clock,
    events: [],
    exitedFacts: [],
    stopCount: 0,
    teardowns: [],
    results: [],
    aborts: [],
    outputBytes: 0,
    run: null as unknown as ForegroundRun,
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
        process_id: null,
        type: emission.type,
        payload: emission.payload,
      }) as RuntimeEvent;
    },
  };
  const callbacks: ForegroundRunCallbacks = {
    emitEvent: (type, payload) => fx.events.push({ type, payload }),
    markExited: (facts) => fx.exitedFacts.push({ ...facts }),
    sendStop: () => {
      fx.stopCount += 1;
    },
    teardown: (code, message) => fx.teardowns.push({ code, message }),
    onFinalized: (result) => fx.results.push(result),
    onAborted: (code, message) => fx.aborts.push({ code, message }),
    outputBytes: () => fx.outputBytes,
  };
  fx.run = new ForegroundRun({
    grant,
    callbacks,
    timers: clock.timers,
    nowMs: clock.now,
    drainWindowMs: opts.drainWindowMs ?? 500,
    stopConfirmTimeoutMs: opts.stopConfirmTimeoutMs ?? 6_000,
    deadlineMs: opts.deadlineMs ?? 60_000,
  });
  return fx;
}

const DRAIN = 500;

function completedPayload(fx: Fixture): { outcome: string; reason: string | null; exit_code: number | null; forced: boolean } {
  const completed = fx.events.filter((e) => e.type === "operation.completed");
  assert.equal(completed.length, 1, "exactly one final result event");
  return completed[0]!.payload as { outcome: string; reason: string | null; exit_code: number | null; forced: boolean };
}

describe("P5.7 foreground state machine: expected/actual matrix", () => {
  it("actual 0 / expected 0 -> PASS with the true values in the result", () => {
    const fx = makeRun();
    fx.run.onAck();
    fx.run.onExitFrame(0, null, 1_250);
    fx.clock.advance(DRAIN);
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "PASS");
    assert.equal(completed.reason, null);
    assert.equal(completed.exit_code, 0);
    assert.equal(completed.forced, false);
    const result = fx.results[0]!;
    assert.equal(result.exit_code, 0);
    assert.equal(result.expected_exit_code, 0);
    assert.equal(result.reason, null);
    assert.equal(result.state, "EXITED");
    assert.equal(result.forced, false);
    assert.equal(result.cleanup_status, "confirmed");
    assert.equal(result.timeout_ms, 60_000);
    assert.equal(fx.teardowns.length, 0, "PASS never tears the session down");
  });

  it("actual 7 / expected 7 -> PASS (never a hard-coded exit 0)", () => {
    const fx = makeRun({ expected_exit_code: 7 });
    fx.run.onAck();
    fx.run.onExitFrame(7, null, 900);
    fx.clock.advance(DRAIN);
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "PASS");
    assert.equal(completed.exit_code, 7);
    assert.equal(fx.results[0]!.exit_code, 7);
    assert.equal(fx.results[0]!.expected_exit_code, 7);
  });

  it("actual 7 / expected 0 -> FAIL/EXIT_CODE_MISMATCH with the true code preserved", () => {
    const fx = makeRun({ expected_exit_code: 0 });
    fx.run.onAck();
    fx.run.onExitFrame(7, null, 42);
    fx.clock.advance(DRAIN);
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "FAIL");
    assert.equal(completed.reason, "EXIT_CODE_MISMATCH");
    assert.equal(completed.exit_code, 7, "the true exit code is never flattened");
    assert.equal(fx.results[0]!.exit_code, 7);
    assert.deepEqual(fx.teardowns, [{ code: "EXIT_CODE_MISMATCH", message: "foreground command exited 7; the granted expectation was 0" }]);
  });

  it("null expected exit defaults to PASS on any observed code", () => {
    const fx = makeRun({ expected_exit_code: null });
    fx.run.onAck();
    fx.run.onExitFrame(3, null, 10);
    fx.clock.advance(DRAIN);
    assert.equal(completedPayload(fx).outcome, "PASS");
  });
});

describe("P5.7 foreground state machine: deadline", () => {
  it("deadline expiry: timeout -> stopping -> stop -> drain -> FAIL/TIMEOUT with a null exit code", () => {
    const fx = makeRun({}, { deadlineMs: 1_000 });
    fx.run.onAck();
    fx.clock.advance(1_000);
    const types = fx.events.map((e) => e.type);
    assert.ok(types.includes("process.timeout"));
    assert.ok(types.includes("process.stopping"));
    assert.equal(fx.stopCount, 1, "the latched timeout sends exactly one guest stop");
    fx.run.onStoppedFrame(false, 130, "SIGINT", 1_400);
    fx.clock.advance(DRAIN);
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "FAIL");
    assert.equal(completed.reason, "TIMEOUT");
    assert.equal(completed.exit_code, null, "no invented exit code for a deadline termination");
    const result = fx.results[0]!;
    assert.equal(result.exit_code, null);
    assert.equal(result.reason, "TIMEOUT");
    assert.equal(result.forced, true);
    assert.equal(result.signal, "SIGINT", "the real kill signal is preserved separately");
    assert.deepEqual(fx.teardowns, [{ code: "TIMEOUT", message: "the trusted foreground deadline (1000 ms) expired" }]);
    // Canonical event order: timeout -> stopping -> (drain) -> stopped -> completed.
    const order = fx.events.map((e) => e.type);
    assert.ok(order.indexOf("process.timeout") < order.indexOf("process.stopping"));
    assert.ok(order.indexOf("process.stopping") < order.indexOf("process.stopped"));
    assert.ok(order.indexOf("process.stopped") < order.indexOf("operation.completed"));
  });

  it("exit observed before the deadline wins (deadline disarmed, no timeout event)", () => {
    const fx = makeRun({}, { deadlineMs: 1_000 });
    fx.run.onAck();
    fx.clock.advance(600);
    fx.run.onExitFrame(0, null, 600);
    assert.equal(fx.clock.pendingTimers() <= 1, true, "only the drain timer remains");
    fx.clock.advance(10_000);
    assert.equal(fx.events.some((e) => e.type === "process.timeout"), false);
    assert.equal(completedPayload(fx).outcome, "PASS");
  });

  it("a late matching exit cannot undo a latched timeout (exactly one result)", () => {
    const fx = makeRun({ expected_exit_code: 0 }, { deadlineMs: 1_000 });
    fx.run.onAck();
    fx.clock.advance(1_000);
    fx.run.onStoppedFrame(true, null, "SIGKILL", 3_500);
    fx.clock.advance(DRAIN);
    assert.equal(completedPayload(fx).reason, "TIMEOUT");
    // Late natural exit frame after finalization: ignored entirely.
    fx.run.onExitFrame(0, null, 4_000);
    fx.run.onStoppedFrame(true, null, "SIGKILL", 4_000);
    fx.clock.advance(DRAIN * 4);
    const completed = fx.events.filter((e) => e.type === "operation.completed");
    assert.equal(completed.length, 1);
    assert.equal((completed[0]!.payload as { reason: string }).reason, "TIMEOUT");
  });

  it("stop-confirmation bound expiry finalizes with unconfirmed cleanup + teardown", () => {
    const fx = makeRun({}, { deadlineMs: 1_000, stopConfirmTimeoutMs: 6_000 });
    fx.run.onAck();
    fx.clock.advance(1_000);
    fx.clock.advance(6_000);
    const completed = completedPayload(fx);
    assert.equal(completed.reason, "TIMEOUT");
    assert.equal(fx.results[0]!.cleanup_status, "unconfirmed");
    assert.equal(fx.teardowns.length, 1, "an uncertain group always requests teardown");
  });
});

describe("P5.7 foreground state machine: drain ordering", () => {
  it("terminal event and final result are emitted only after the drain window", () => {
    const fx = makeRun();
    fx.run.onAck();
    fx.run.onExitFrame(0, null, 100);
    // Halfway through the drain window nothing terminal has been emitted yet.
    fx.clock.advance(DRAIN - 1);
    assert.equal(fx.events.some((e) => e.type === "process.exited"), false);
    assert.equal(fx.events.some((e) => e.type === "operation.completed"), false);
    // The drain completes: terminal event -> final result, in that order.
    fx.clock.advance(1);
    const types = fx.events.map((e) => e.type);
    assert.ok(types.indexOf("process.exited") < types.indexOf("operation.completed"));
  });

  it("markExited happens at finalize so drain-window output precedes the terminal event", () => {
    const fx = makeRun();
    fx.run.onAck();
    fx.run.onExitFrame(0, null, 100);
    fx.clock.advance(DRAIN - 1);
    assert.deepEqual(fx.exitedFacts, [], "the registry stays output-accepting during the drain");
    fx.clock.advance(1);
    assert.equal(fx.exitedFacts.length, 1);
    assert.deepEqual(fx.exitedFacts[0], { exit_code: 0, signal: null, stopped: false, forced: false });
  });
});

describe("P5.7 foreground state machine: descendants / output limit", () => {
  it("residual descendants classify FAIL/UNEXPECTED_DESCENDANTS with the true exit code", () => {
    const fx = makeRun();
    fx.run.onAck();
    fx.run.onExitFrame(0, null, 120);
    fx.run.onDescendantFailure();
    fx.clock.advance(DRAIN);
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "FAIL");
    assert.equal(completed.reason, "UNEXPECTED_DESCENDANTS");
    assert.equal(completed.exit_code, 0, "the direct command's true exit fact is preserved");
    assert.equal(fx.results[0]!.reason, "UNEXPECTED_DESCENDANTS");
    assert.equal(fx.teardowns.length, 1, "residual owned descendants demand full teardown");
  });

  it("a descendant report before the exit frame upgrades the natural exit classification", () => {
    const fx = makeRun();
    fx.run.onAck();
    fx.run.onDescendantFailure();
    fx.run.onExitFrame(7, null, 55);
    fx.clock.advance(DRAIN);
    assert.equal(completedPayload(fx).reason, "UNEXPECTED_DESCENDANTS");
    assert.equal(fx.results[0]!.exit_code, 7);
  });

  it("an output limit ends FAIL/OUTPUT_LIMIT (truncated, teardown, confirmed cleanup)", () => {
    const fx = makeRun();
    fx.outputBytes = 1_048_577;
    fx.run.onAck();
    fx.run.onOutputLimitFailure();
    fx.run.onStoppedFrame(true, null, "SIGKILL", 2_000);
    fx.clock.advance(DRAIN);
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "FAIL");
    assert.equal(completed.reason, "OUTPUT_LIMIT");
    assert.equal(completed.exit_code, null);
    const result = fx.results[0]!;
    assert.equal(result.truncated, true);
    assert.equal(result.cleanup_status, "confirmed");
    assert.equal(fx.teardowns.length, 1);
  });

  it("output limit without a stop confirmation finalizes unconfirmed + teardown", () => {
    const fx = makeRun({}, { stopConfirmTimeoutMs: 6_000 });
    fx.run.onAck();
    fx.run.onOutputLimitFailure();
    fx.clock.advance(6_000);
    assert.equal(completedPayload(fx).reason, "OUTPUT_LIMIT");
    assert.equal(fx.results[0]!.cleanup_status, "unconfirmed");
    assert.equal(fx.teardowns.length, 1);
  });
});

describe("P5.7 foreground state machine: one immutable result / duplicates", () => {
  it("duplicate terminal frames and latches never produce a second result", () => {
    const fx = makeRun();
    fx.run.onAck();
    fx.run.onExitFrame(0, null, 10);
    fx.clock.advance(DRAIN);
    assert.equal(fx.results.length, 1);
    fx.run.onExitFrame(1, null, 20);
    fx.run.onStoppedFrame(true, null, "SIGKILL", 30);
    fx.run.onDescendantFailure();
    fx.run.onOutputLimitFailure();
    fx.run.onDeadline();
    fx.run.onConfirmExpired();
    fx.clock.advance(DRAIN * 10);
    assert.equal(fx.results.length, 1);
    assert.equal(fx.events.filter((e) => e.type === "operation.completed").length, 1);
    assert.equal(fx.teardowns.length, 0);
  });

  it("the result parses as the canonical OperationResult DTO on every terminal path", () => {
    for (const build of [
      () => {
        const fx = makeRun();
        fx.run.onAck();
        fx.run.onExitFrame(0, null, 10);
        fx.clock.advance(DRAIN);
        return fx.results[0]!;
      },
      () => {
        const fx = makeRun({}, { deadlineMs: 100 });
        fx.run.onAck();
        fx.clock.advance(100);
        fx.run.onStoppedFrame(false, null, "SIGINT", 500);
        fx.clock.advance(DRAIN);
        return fx.results[0]!;
      },
      () => {
        const fx = makeRun();
        // Spawn failure is detected while still awaiting the authoritative
        // ack (phase "starting") — before any onAck transition.
        fx.run.onSpawnFailed("no guest acknowledgment");
        return fx.results[0]!;
      },
    ]) {
      const result = build();
      assert.ok(result !== undefined, "every terminal path produces the one final result");
      const parsed = OperationResultSchema.safeParse(result);
      assert.equal(parsed.success, true, `result must satisfy the canonical DTO: ${JSON.stringify(result)}`);
      assert.doesNotMatch(result.stdout_ref ?? "", /[\\/]/, "opaque refs never carry path separators");
      assert.doesNotMatch(result.stderr_ref ?? "", /[\\/]/, "opaque refs never carry path separators");
    }
  });

  it("emitted run events satisfy the full runtime event schema (journal-shape parity)", () => {
    const fx = makeRun({}, { deadlineMs: 100 });
    fx.run.onAck();
    fx.run.onExitFrame(0, null, 60);
    fx.clock.advance(40);
    fx.clock.advance(1_000);
    fx.run.onStoppedFrame(false, 130, "SIGINT", 1_100);
    fx.clock.advance(DRAIN);
    for (let index = 0; index < fx.events.length; index += 1) {
      const parsed = RuntimeEventSchema.safeParse(fx.asJournalEvent(index));
      assert.equal(parsed.success, true, `event ${fx.events[index]!.type} must be journal-storable`);
    }
  });
});

describe("P5.7 foreground state machine: cancellation", () => {
  it("cancel during running: stopping -> stop -> drain -> SKIPPED/CANCELLED (null exit code)", async () => {
    const fx = makeRun();
    fx.run.onAck();
    const cancelled = fx.run.cancel();
    assert.equal(fx.stopCount, 1);
    assert.ok(fx.events.some((e) => e.type === "process.stopping"));
    fx.run.onStoppedFrame(false, 130, "SIGINT", 2_100);
    fx.clock.advance(DRAIN);
    await cancelled;
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "SKIPPED");
    assert.equal(completed.reason, "CANCELLED");
    assert.equal(completed.exit_code, null);
    assert.equal(fx.results[0]!.cleanup_status, "confirmed");
    assert.equal(fx.teardowns.length, 0, "a cancelled operation does not tear the session down");
  });

  it("cancel during starting dispatches at the authoritative ack", async () => {
    const fx = makeRun();
    const cancelled = fx.run.cancel();
    assert.equal(fx.stopCount, 0, "no stop frame for an unspawned group");
    fx.run.onAck();
    assert.equal(fx.stopCount, 1, "the latched cancel dispatches at the ack");
    fx.run.onStoppedFrame(true, null, "SIGKILL", 300);
    fx.clock.advance(DRAIN);
    await cancelled;
    assert.equal(completedPayload(fx).reason, "CANCELLED");
  });

  it("a late exit cannot undo a latched cancellation", async () => {
    const fx = makeRun({ expected_exit_code: 0 });
    fx.run.onAck();
    const cancelled = fx.run.cancel();
    fx.run.onExitFrame(0, null, 50);
    fx.run.onStoppedFrame(false, 0, "SIGINT", 60);
    fx.clock.advance(DRAIN);
    await cancelled;
    assert.equal(completedPayload(fx).reason, "CANCELLED");
    assert.equal(fx.events.filter((e) => e.type === "operation.completed").length, 1);
  });

  it("cancel after the exit settled resolves without a second result", async () => {
    const fx = makeRun();
    fx.run.onAck();
    fx.run.onExitFrame(0, null, 10);
    fx.clock.advance(DRAIN);
    await fx.run.cancel();
    assert.equal(fx.events.filter((e) => e.type === "operation.completed").length, 1);
  });
});

describe("P5.7 foreground state machine: spawn failure / session close", () => {
  it("spawn failure: failed -> completed (no invented start/exit) + teardown", () => {
    const fx = makeRun();
    // Detected while still awaiting the authoritative guest ack.
    fx.run.onSpawnFailed("timed out waiting for the guest start acknowledgment");
    const types = fx.events.map((e) => e.type);
    assert.deepEqual(types, ["process.failed", "operation.completed"]);
    const completed = completedPayload(fx);
    assert.equal(completed.outcome, "FAIL");
    assert.equal(completed.reason, "SPAWN_FAILED");
    assert.equal(completed.exit_code, null);
    assert.equal(fx.results[0]!.state, "DISPOSED");
    assert.deepEqual(fx.exitedFacts, [], "a never-started process records no death fact");
    assert.equal(fx.teardowns.length, 1);
  });

  it("session close aborts the run: no final result, no events, abort surfaced", () => {
    const fx = makeRun();
    fx.run.onAck();
    fx.run.sessionClosing("NOT_AUTHORIZED", "the session closed while the foreground operation was active");
    fx.run.onExitFrame(0, null, 10);
    fx.run.onDeadline();
    fx.clock.advance(10_000);
    assert.equal(fx.results.length, 0, "no final result is published after close");
    assert.equal(fx.events.length, 0);
    assert.equal(fx.stopCount, 0);
    assert.deepEqual(fx.aborts, [{ code: "NOT_AUTHORIZED", message: "the session closed while the foreground operation was active" }]);
  });

  it("close during a latched stop aborts without a second teardown request", () => {
    const fx = makeRun({}, { deadlineMs: 100 });
    fx.run.onAck();
    fx.clock.advance(100);
    fx.run.sessionClosing("TRANSPORT_FAILED", "transport death");
    fx.run.onStoppedFrame(false, null, "SIGINT", 500);
    fx.clock.advance(10_000);
    assert.equal(fx.results.length, 0);
    assert.equal(fx.teardowns.length, 0);
  });
});
