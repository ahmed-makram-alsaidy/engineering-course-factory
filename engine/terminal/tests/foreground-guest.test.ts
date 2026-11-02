// P5.7 guest process table — foreground completion policy, deterministic
// unit tests (fake spawn, fake timers, no OS processes). Proves the
// supervisor-side half of the canonical foreground semantics:
//   - a clean foreground exit is reported only when the WHOLE group is gone;
//   - owned descendants surviving the direct command's exit are force-killed
//     and verified dead BEFORE any report; the classification is
//     process_failed UNEXPECTED_DESCENDANTS after the true exit fact;
//   - the deadline stop path keeps the P5.5 group-verification semantics
//     (SIGINT -> grace -> SIGKILL -> verified death) for foreground groups;
//   - the per-process output bound still applies to foreground groups;
//   - a racing stop during the residual verification never double-signals.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GuestProcessTable,
  STOP_GRACE_MS,
  STOP_VERIFY_MS,
  type GuestSpawn,
  type GuestSpawnedProcess,
  type GuestTimer,
} from "../container/process-groups.ts";
import { StartProcessFrameSchema } from "../container/protocol.ts";
import type { GuestFrame } from "../container/protocol.ts";

// -- deterministic fake clock + timer queue ------------------------------------

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

// -- fake child + harness (mirrors the P5.5 deterministic harness) ---------------

interface FakeChild {
  pid: number;
  pgid: number;
  closed: boolean;
  exitDelivered: boolean;
  stdoutListeners: Array<(chunk: Buffer) => void>;
  stderrListeners: Array<(chunk: Buffer) => void>;
  exitListeners: Array<(code: number | null, signal: string | null) => void>;
  closeListeners: Array<(code: number | null, signal: string | null) => void>;
  signals: string[];
  /** Extra live group members (descendants) — alive until force-killed. */
  descendants: number;
  /** A descendant that ignores SIGKILL (uncertain group, session fail-closed). */
  killImmune: boolean;
  emitStdout(chunk: Buffer): void;
  emitStderr(chunk: Buffer): void;
  /** DIRECT process death (immediate; pipes may still be open). */
  emitExit(code: number | null, signal: string | null): void;
  /** Stdio drained (fires after the direct exit in reality). */
  emitClose(code: number | null, signal: string | null): void;
  addDescendant(): void;
}

function fakeChild(pid: number): FakeChild {
  const child: FakeChild = {
    pid,
    pgid: pid,
    closed: false,
    exitDelivered: false,
    stdoutListeners: [],
    stderrListeners: [],
    exitListeners: [],
    closeListeners: [],
    signals: [],
    descendants: 0,
    killImmune: false,
    emitStdout(chunk) {
      for (const listener of [...child.stdoutListeners]) listener(chunk);
    },
    emitStderr(chunk) {
      for (const listener of [...child.stderrListeners]) listener(chunk);
    },
    emitExit(code, signal) {
      if (child.exitDelivered) return;
      child.exitDelivered = true;
      for (const listener of [...child.exitListeners]) listener(code, signal);
    },
    emitClose(code, signal) {
      if (child.closed) return;
      child.closed = true;
      child.exitDelivered = true;
      for (const listener of [...child.exitListeners]) listener(code, signal);
      for (const listener of [...child.closeListeners]) listener(code, signal);
    },
    addDescendant() {
      child.descendants += 1;
    },
  };
  return child;
}

function harness() {
  const clock = fakeClock();
  const children: FakeChild[] = [];
  const spawn: GuestSpawn = () => {
    const pid = 1000 + children.length;
    const child = fakeChild(pid);
    children.push(child);
    const handle: GuestSpawnedProcess = {
      pid: child.pid,
      pgid: child.pid,
      onStdout: (listener) => child.stdoutListeners.push(listener),
      onStderr: (listener) => child.stderrListeners.push(listener),
      onExit: (listener) => child.exitListeners.push(listener),
      onClose: (listener) => child.closeListeners.push(listener),
      signalGroup: (signal) => {
        child.signals.push(signal);
        if (signal === "SIGKILL" && !child.killImmune) child.descendants = 0;
      },
      // Mirrors kill(-pgid, 0): the dead direct child is no longer a live
      // member, so after its exit only descendants keep the group alive.
      groupAlive: () => (child.exitDelivered ? child.descendants > 0 : !child.closed || child.descendants > 0),
    };
    return handle;
  };
  const frames: GuestFrame[] = [];
  // P5.9: default harness inventory is clean (no escaped groups); individual
  // tests can override it via `tableInventory`.
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
  return { clock, children, frames, table, tableInventory(impl: typeof inventoryImpl) { inventoryImpl = impl; } };
}

function foregroundFrame(overrides: Record<string, unknown> = {}): Parameters<GuestProcessTable["start"]>[0] {
  return StartProcessFrameSchema.parse({
    type: "start_process",
    seq: 1,
    process_id: "fg-att-1",
    attempt_id: "att-1",
    command: "node parent.js",
    cwd: "/workspace",
    env: [],
    mode: "foreground",
    ...overrides,
  }) as Parameters<GuestProcessTable["start"]>[0];
}

function frameTypes(frames: GuestFrame[]): string[] {
  return frames.map((f) => f.type);
}

describe("P5.7 guest process table: foreground completion policy", () => {
  it("a clean foreground exit is reported once the whole group is gone and the pipes drained", () => {
    const { clock, children, frames, table } = harness();
    table.start(foregroundFrame());
    const child = children[0]!;
    child.emitStdout(Buffer.from("P57_OK\n"));
    // Direct death first; the report still waits for the pipe drain.
    child.emitExit(0, null);
    assert.deepEqual(frameTypes(frames), ["process_started", "process_output"], "nothing is reported before the drain");
    child.emitClose(0, null);
    const types = frameTypes(frames);
    assert.deepEqual(types, ["process_started", "process_output", "process_exit"]);
    const exit = frames[2];
    assert.ok(exit && exit.type === "process_exit");
    assert.equal(exit.exit_code, 0);
    assert.equal(exit.signal, null);
    assert.equal(table.size, 0);
    assert.equal(clock.pendingCount(), 0, "no verification timers linger after a clean exit");
  });

  it("owned descendants surviving the direct exit are force-killed and verified before reporting", () => {
    const { clock, children, frames, table } = harness();
    table.start(foregroundFrame());
    const child = children[0]!;
    // The parent exits while two owned descendants remain alive. The direct
    // exit triggers the force fallback; the verified report follows the
    // subsequent pipe drain.
    child.addDescendant();
    child.addDescendant();
    child.emitExit(0, null);
    assert.ok(child.signals.includes("SIGKILL"), "the residual group is force-killed at the direct exit");
    assert.deepEqual(frameTypes(frames), ["process_started"], "nothing is reported while the group is being verified");
    child.emitClose(0, null);
    const types = frameTypes(frames);
    assert.deepEqual(types, ["process_started", "process_exit", "process_failed"]);
    const exit = frames[1];
    assert.ok(exit && exit.type === "process_exit");
    assert.equal(exit.exit_code, 0, "the TRUE direct-child exit fact is preserved");
    const failed = frames[2];
    assert.ok(failed && failed.type === "process_failed");
    assert.equal((failed as { code: string }).code, "UNEXPECTED_DESCENDANTS");
    assert.equal(table.size, 0, "the entry is reaped only after the whole group is verified dead");
    assert.equal(clock.pendingCount(), 0);
  });

  it("a residual group that cannot die inside the verification bound fails the session", () => {
    const { clock, children, frames, table } = harness();
    table.start(foregroundFrame());
    const child = children[0]!;
    child.killImmune = true;
    child.addDescendant();
    child.emitExit(0, null);
    child.emitClose(0, null);
    clock.advance(STOP_GRACE_MS + STOP_VERIFY_MS + 10);
    const types = frameTypes(frames);
    assert.deepEqual(types, ["process_started", "error"]);
    const error = frames[1];
    assert.ok(error && error.type === "error");
    assert.equal((error as { code: string }).code, "STOP_VERIFY_FAILED");
    assert.equal(table.size, 0, "the uncertain entry is dropped; the host tears the container down");
  });

  it("the deadline stop path keeps the P5.5 verified-group semantics for foreground groups", () => {
    const { clock, children, frames, table } = harness();
    table.start(foregroundFrame());
    const child = children[0]!;
    // A SIGINT-ignoring descendant keeps the group alive past the grace.
    child.addDescendant();
    table.stop("fg-att-1");
    assert.ok(child.signals.includes("SIGINT"), "the graceful signal is applied first");
    clock.advance(2_000);
    assert.ok(child.signals.filter((s) => s === "SIGKILL").length >= 1, "SIGKILL after the grace");
    // The group dies during death/drain verification.
    child.emitClose(null, "SIGINT");
    clock.advance(100);
    const types = frameTypes(frames);
    assert.deepEqual(types, ["process_started", "process_stopped"]);
    const stopped = frames[1];
    assert.ok(stopped && stopped.type === "process_stopped");
    assert.equal((stopped as { forced: boolean }).forced, true);
    assert.equal(table.size, 0);
  });

  it("a stop frame racing the residual verification never double-signals", () => {
    const { children, frames, table } = harness();
    table.start(foregroundFrame());
    const child = children[0]!;
    child.addDescendant();
    child.emitExit(0, null);
    // The host's stop frame arrives while the residual verification runs:
    // no graceful signal is added, and nothing is reported yet.
    table.stop("fg-att-1");
    const sigintCount = child.signals.filter((s) => s === "SIGINT").length;
    assert.equal(sigintCount, 0, "no graceful signal is added mid-verification");
    assert.equal(frameTypes(frames).filter((t) => t === "process_exit").length, 0);
  });

  it("the output bound applies to foreground groups (SIGKILL + process_failed OUTPUT_LIMIT)", () => {
    const { children, frames, table } = harness();
    table.start(foregroundFrame());
    const child = children[0]!;
    const chunk = Buffer.alloc(64 * 1024, 0x61); // 64 KiB per write
    for (let i = 0; i < 17; i += 1) child.emitStdout(chunk); // > 1 MiB
    const types = frameTypes(frames);
    assert.equal(types.includes("process_failed"), true);
    const failed = frames.find((f) => f.type === "process_failed") as { code: string };
    assert.equal(failed.code, "OUTPUT_LIMIT");
    assert.ok(child.signals.includes("SIGKILL"), "the group is killed on the bound violation");
  });

  it("background groups are unaffected by the foreground policy (mode absent = background)", () => {
    const { children, frames, table } = harness();
    table.start(foregroundFrame({ process_id: "bg_1", command: "node server.js", mode: undefined }));
    const child = children[0]!;
    child.addDescendant();
    child.emitClose(0, null);
    // Background natural exit with surviving descendants is still the P5.5
    // natural-exit fact (BACKGROUND_EXITED_EARLY is the host's
    // classification); the guest reports the plain exit.
    const types = frameTypes(frames);
    assert.deepEqual(types, ["process_started", "process_exit"]);
    assert.equal(table.size, 0);
  });
});
