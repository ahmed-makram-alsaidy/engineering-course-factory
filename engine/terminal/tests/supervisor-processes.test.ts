// P5.5 guest process table â€” deterministic unit tests for the supervisor-side
// process-group lifecycle (fake spawn, fake timers, no OS processes). Proves:
// one controlled process group per logical id, authoritative process_started
// ack, per-stream output offsets with UTF-8 chunk spanning, output bound
// (SIGKILL + process_failed), graceful SIGINT stop with the design grace,
// force fallback after an ignored SIGINT, stopAll/shutdown, duplicate-start
// rejection, and the guest-side cwd defenses.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GuestProcessTable,
  GUEST_COMMAND_ENV_BASE,
  GUEST_OUTPUT_PROCESS_LIMIT_BYTES,
  STOP_GRACE_MS,
  STOP_VERIFY_MS,
  type GuestSpawn,
  type GuestSpawnedProcess,
  type GuestTimer,
} from "../container/process-groups.ts";
import { StartProcessFrameSchema } from "../container/protocol.ts";
import type { GuestFrame } from "../container/protocol.ts";

/** Deterministic fake clock + fake timer queue. */
function fakeClock() {
  let nowMs = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const timer: GuestTimer = {
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
    timer,
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
    pendingCount: () => timers.length,
  };
}

interface FakeChild {
  pid: number;
  pgid: number;
  closed: boolean;
  exitInfo: { code: number | null; signal: string | null } | null;
  stdoutListeners: Array<(chunk: Buffer) => void>;
  stderrListeners: Array<(chunk: Buffer) => void>;
  exitListeners: Array<(code: number | null, signal: string | null) => void>;
  closeListeners: Array<(code: number | null, signal: string | null) => void>;
  signals: string[];
  emitStdout(chunk: Buffer): void;
  emitStderr(chunk: Buffer): void;
  emitClose(code: number | null, signal: string | null): void;
}

function fakeChild(pid: number, pgid: number, siblings: FakeChild[]): FakeChild {
  const child: FakeChild = {
    pid,
    pgid,
    closed: false,
    exitInfo: null,
    stdoutListeners: [],
    stderrListeners: [],
    exitListeners: [],
    closeListeners: [],
    signals: [],
    emitStdout(chunk) {
      for (const listener of [...child.stdoutListeners]) listener(chunk);
    },
    emitStderr(chunk) {
      for (const listener of [...child.stderrListeners]) listener(chunk);
    },
    emitClose(code, signal) {
      if (child.closed) return;
      child.closed = true;
      child.exitInfo = { code, signal };
      for (const listener of [...child.exitListeners]) listener(code, signal);
      for (const listener of [...child.closeListeners]) listener(code, signal);
    },
  };
  child.signals = [];
  // Group-alive probe over the sibling table (mirrors kill(-pgid, 0)).
  (child as unknown as { groupAlive(): boolean }).groupAlive = () =>
    siblings.some((sibling) => sibling.pgid === pgid && !sibling.closed);
  return child;
}

/** Harness: fake spawn returning queued children in creation order. */
function harness() {
  const clock = fakeClock();
  const children: FakeChild[] = [];
  const spawnArgs: Array<{ command: string; cwd: string; env: Record<string, string> }> = [];
  const spawn: GuestSpawn = (args) => {
    spawnArgs.push(args);
    const pid = 1000 + children.length;
    const child = fakeChild(pid, pid, children);
    children.push(child);
    const handle: GuestSpawnedProcess = {
      pid: child.pid,
      pgid: child.pid,
      onStdout: (listener) => child.stdoutListeners.push(listener),
      onStderr: (listener) => child.stderrListeners.push(listener),
      onExit: (listener) => child.exitListeners.push(listener),
      onClose: (listener) => child.closeListeners.push(listener),
      signalGroup: (signal) => child.signals.push(signal),
      groupAlive: () => (child as unknown as { groupAlive(): boolean }).groupAlive(),
    };
    return handle;
  };
  const frames: GuestFrame[] = [];
  // P5.9: default harness inventory is clean (no escaped groups); individual
  // tests override it through `tableInventory` / `failInventory`.
  let inventoryImpl: (
    done: (result: { pgids: readonly number[]; selfPgid: number | null } | null) => void,
  ) => void = (done) => done({ pgids: [], selfPgid: 1 });
  const table = new GuestProcessTable({
    spawn,
    now: clock.now,
    seq: (() => {
      let seq = 0;
      return () => ++seq;
    })(),
    emit: (frame) => frames.push(frame),
    timer: clock.timer,
    inventoryGroups: (done) => inventoryImpl(done),
  });
  return {
    clock, children, spawnArgs, frames, table,
    tableInventory(impl: typeof inventoryImpl) { inventoryImpl = impl; },
  };
}

function startFrame(overrides: Record<string, unknown> = {}): Parameters<GuestProcessTable["start"]>[0] {
  const raw = {
    type: "start_process",
    seq: 1,
    process_id: "dev_server",
    attempt_id: "att-1",
    command: "node server.js",
    cwd: "/workspace/app",
    env: [{ name: "TZ", value: "UTC" }],
    ...overrides,
  };
  return StartProcessFrameSchema.parse(raw) as Parameters<GuestProcessTable["start"]>[0];
}

describe("P5.5 guest process table", () => {
  it("start emits an authoritative process_started ack with runtime pid/pgid", () => {
    const { table, frames, children } = harness();
    table.start(startFrame());
    assert.equal(children.length, 1);
    const started = frames.find((f) => f.type === "process_started");
    assert.ok(started && started.type === "process_started");
    assert.equal(started.process_id, "dev_server");
    assert.equal(started.pid, 1000);
    assert.equal(started.pgid, 1000, "detached child is its own group leader");
    assert.equal(table.size, 1);
  });

  it("the guest command env is reconstructed from the fixed base plus forwardable entries only", () => {
    const { table, spawnArgs } = harness();
    table.start(startFrame());
    const env = spawnArgs[0]!.env;
    assert.equal(env.PATH, GUEST_COMMAND_ENV_BASE.PATH);
    assert.equal(env.HOME, GUEST_COMMAND_ENV_BASE.HOME);
    assert.equal(env.TMPDIR, GUEST_COMMAND_ENV_BASE.TMPDIR);
    assert.equal(env.TERM, GUEST_COMMAND_ENV_BASE.TERM);
    assert.equal(env.TZ, "UTC", "the allowlisted forward was applied");
  });

  it("output frames carry per-stream byte offsets and arrive in emission order", () => {
    const { table, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    child.emitStdout(Buffer.from("P55_STARTED\n", "utf8"));
    child.emitStderr(Buffer.from("warn\n", "utf8"));
    child.emitStdout(Buffer.from("P55_TICK_1\n", "utf8"));
    const outputs = frames.filter((f) => f.type === "process_output");
    assert.deepEqual(
      outputs.map((f) => (f.type === "process_output" ? `${f.stream}:${f.stream_offset}:${f.text.trim()}` : "")),
      ["stdout:0:P55_STARTED", "stderr:0:warn", "stdout:12:P55_TICK_1"],
    );
  });

  it("UTF-8 sequences split across chunks decode without corruption (chunk-spanning)", () => {
    const { table, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    const text = "hÃ©llo-Ã¼nÃ¯code";
    const bytes = Buffer.from(text, "utf8");
    // Split in the middle of the two-byte 'Ã©'.
    child.emitStdout(bytes.subarray(0, 2));
    child.emitStdout(bytes.subarray(2));
    const outputs = frames.filter((f) => f.type === "process_output");
    const joined = outputs.map((f) => (f.type === "process_output" ? f.text : "")).join("");
    assert.equal(joined, text);
    const offsets = outputs.map((f) => (f.type === "process_output" ? f.stream_offset : -1));
    assert.deepEqual(offsets, [0, 2], "byte offsets track raw chunk boundaries");
  });

  it("a duplicate start of the same logical id fails closed (guest-side defense)", () => {
    const { table, frames } = harness();
    table.start(startFrame());
    table.start(startFrame({ attempt_id: "att-2" }));
    const error = frames.find((f) => f.type === "error");
    assert.ok(error && error.type === "error");
    assert.equal(error.code, "DUPLICATE_START");
    assert.equal(table.size, 1, "no second process group");
  });

  it("dot segments in the guest cwd are rejected (belt-and-braces traversal defense)", () => {
    const { table, frames, children } = harness();
    table.start(startFrame({ cwd: "/workspace/../etc" }));
    assert.equal(children.length, 0, "nothing was spawned");
    const error = frames.find((f) => f.type === "error");
    assert.ok(error && error.type === "error");
    assert.equal(error.code, "PROTOCOL_FAILED");
  });

  it("graceful stop: SIGINT to the group; a responding process exits within grace (forced=false)", () => {
    const { table, clock, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    table.stop("dev_server");
    assert.deepEqual(child.signals, ["SIGINT"], "graceful signal first (design Stop/Cleanup)");
    assert.equal(table.size, 1, "still awaiting death confirmation");
    // The process honors the graceful signal within the 2 s grace.
    clock.advance(STOP_GRACE_MS - 1);
    child.emitClose(0, null);
    const stopped = frames.find((f) => f.type === "process_stopped");
    assert.ok(stopped && stopped.type === "process_stopped");
    assert.equal(stopped.forced, false);
    assert.equal(stopped.exit_code, 0);
    assert.equal(table.size, 0);
    assert.equal(clock.pendingCount(), 0, "no stray kill timers");
  });

  it("force fallback: a SIGINT-ignoring group is SIGKILLed after the design grace (forced=true)", () => {
    const { table, clock, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    table.stop("dev_server");
    clock.advance(STOP_GRACE_MS); // grace elapses, process ignores SIGINT
    assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"], "SIGKILL after the 2 s grace");
    assert.equal(clock.pendingCount() >= 1, true, "death/drain verification armed");
    clock.advance(50); // group dies
    child.emitClose(null, "SIGKILL");
    const stopped = frames.find((f) => f.type === "process_stopped");
    assert.ok(stopped && stopped.type === "process_stopped");
    assert.equal(stopped.forced, true);
    assert.equal(stopped.signal, "SIGKILL");
  });

  it("stop of an already exited process answers ALREADY_EXITED with no signal", () => {
    const { table, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    child.emitClose(0, null); // natural exit
    table.stop("dev_server");
    const error = frames.find((f) => f.type === "error");
    assert.ok(error && error.type === "error");
    assert.equal(error.code, "ALREADY_EXITED");
    assert.equal(children.length, 1);
  });

  it("stop of an unknown process answers INVALID_PROCESS_REFERENCE with no signal", () => {
    const { table, frames } = harness();
    table.stop("unknown_process");
    const error = frames.find((f) => f.type === "error");
    assert.ok(error && error.type === "error");
    assert.equal(error.code, "INVALID_PROCESS_REFERENCE");
  });

  it("natural exit emits process_exit with the true code after pipes drained", () => {
    const { table, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    child.emitStdout(Buffer.from("P55_EXIT_CODE\n"));
    child.emitClose(3, null);
    const exited = frames.find((f) => f.type === "process_exit");
    assert.ok(exited && exited.type === "process_exit");
    assert.equal(exited.exit_code, 3);
    assert.equal(table.size, 0);
  });

  it("output beyond the 1 MiB bound SIGKILLs the group and reports process_failed OUTPUT_LIMIT", () => {
    const { table, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    // Two chunks: the second pushes the decoded total past the bound.
    const chunk = Buffer.alloc(700_000, 0x61);
    child.emitStdout(chunk);
    child.emitStdout(chunk);
    const failed = frames.find((f) => f.type === "process_failed");
    assert.ok(failed && failed.type === "process_failed");
    assert.equal(failed.code, "OUTPUT_LIMIT");
    assert.deepEqual(child.signals, ["SIGKILL"]);
  });

  it("stopAll(force) SIGKILLs every live group (EOF/lease-loss fail-safe)", () => {
    const { table, children } = harness();
    table.start(startFrame());
    table.start(startFrame({ process_id: "worker", attempt_id: "att-2" }));
    table.stopAll(true);
    for (const child of children) assert.ok(child.signals.includes("SIGKILL"));
    assert.equal(table.size, 2, "entries linger until death confirms");
  });

  it("requestShutdown stops groups and acks once all are dead", () => {
    const { table, clock, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    let completed = false;
    table.requestShutdown(() => {
      completed = true;
    });
    assert.deepEqual(child.signals, ["SIGINT"], "shutdown prefers the graceful signal");
    clock.advance(STOP_GRACE_MS - 10);
    child.emitClose(0, null);
    clock.advance(10);
    const ack = frames.find((f) => f.type === "shutdown_ack");
    assert.ok(ack, "shutdown_ack emitted");
    assert.equal(completed, true);
  });

  it("requestShutdown forces groups that resist and acks within the deadline", () => {
    const { table, clock, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    let completed = false;
    table.requestShutdown(() => {
      completed = true;
    });
    clock.advance(4_000); // past the shutdown ack deadline
    assert.deepEqual(child.signals, ["SIGINT", "SIGKILL"]);
    assert.equal(completed, true);
    const ack = frames.find((f) => f.type === "shutdown_ack");
    assert.ok(ack);
  });

  it("a process that dies during the graceful window is never double-reported", () => {
    const { table, clock, children, frames } = harness();
    table.start(startFrame());
    const child = children[0]!;
    table.stop("dev_server");
    child.emitClose(0, null);
    // A (bogus) duplicate close event must not produce a second frame.
    child.emitClose(1, null);
    const stopped = frames.filter((f) => f.type === "process_stopped");
    assert.equal(stopped.length, 1);
    clock.advance(STOP_GRACE_MS + STOP_VERIFY_MS);
    assert.equal(frames.filter((f) => f.type === "process_stopped").length, 1, "no late duplicate");
  });
});
