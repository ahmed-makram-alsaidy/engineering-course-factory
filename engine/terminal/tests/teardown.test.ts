// P5.9 stop/crash/teardown — deterministic unit tests (no Docker, no real
// processes, injected clocks/seams). Canonical scope (docs/P5-DESIGN-SPEC.md,
// task table row "P5.9 Stop/crash/teardown"):
//
//   1. Guest group-escape gate (design "Stop / Cleanup": "inventory guest
//      processes against init/supervisor/active groups. Unknown/escaped live
//      descendant or ambiguity -> full teardown"): a confirmed stop whose
//      inventory discloses an escaped (setsid/daemonized) process group is
//      classified process_failed UNEXPECTED_DESCENDANTS — never a clean
//      process_stopped; an inventory failure is ambiguity and classifies the
//      same way (fail closed); a clean inventory keeps the canonical
//      process_stopped trace; known groups (container init, the supervisor's
//      own group, active table entries) are excluded.
//   2. Reconciliation + the new-session barrier (design "Container
//      Lifecycle": "Daemon outage -> preserve ledger/workspace,
//      CLEANUP_UNCONFIRMED/HOLD, block new sessions until reconciliation. On
//      launch reconcile exact recorded sessions matching
//      owner/phase/installation labels"): the launch reconcile removes only
//      exactly-labelled owned leftovers, reports an explicit "unavailable"
//      status on a daemon/transport outage (ledger preserved, never a silent
//      success), and unconfirmed leftovers block prepare with
//      CLEANUP_UNCONFIRMED until a successful reconcile clears the barrier.
//
// The provider's REAL Docker behavior (group escape, helper loss, main loss,
// label-scoped reconciliation against the live daemon) is proven in
// tests/p59-docker.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GuestProcessTable,
  STOP_GRACE_MS,
  type GuestSpawn,
  type GuestSpawnedProcess,
  type GuestTimer,
} from "../container/process-groups.ts";
import { StartProcessFrameSchema } from "../container/protocol.ts";
import type { GuestFrame } from "../container/protocol.ts";

import { ContainerLedger } from "../src/providers/docker-ledger.ts";
import {
  DockerSandboxProvider,
  type DockerProviderConfig,
  type ReconciliationReport,
} from "../src/providers/docker.ts";
import type {
  AdmittedSession,
  ProviderSession,
} from "../src/providers/execution-provider.ts";
import type {
  DockerInvocationResult,
  DockerInvokeOptions,
} from "../src/providers/docker-cli.ts";

// -----------------------------------------------------------------------------
// Guest process table harness (fake spawn, fake clock, fake inventory seam)
// -----------------------------------------------------------------------------

interface FakeClock {
  now(): number;
  advance(ms: number): void;
  timer: GuestTimer;
  pendingCount(): number;
}

function fakeClock(): FakeClock {
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
    timer,
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
  emitClose(code: number | null, signal: string | null): void;
}

function fakeChild(pid: number, siblings: FakeChild[]): FakeChild {
  const child: FakeChild = {
    pid,
    pgid: pid,
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
    emitClose(code, signal) {
      if (child.closed) return;
      child.closed = true;
      child.exitInfo = { code, signal };
      for (const listener of [...child.exitListeners]) listener(code, signal);
      for (const listener of [...child.closeListeners]) listener(code, signal);
    },
  };
  (child as unknown as { groupAlive(): boolean }).groupAlive = () =>
    siblings.some((sibling) => sibling.pgid === child.pgid && !sibling.closed);
  return child;
}

type InventoryResult = { readonly pgids: readonly number[]; readonly selfPgid: number | null } | null;
type InventoryImpl = (done: (result: InventoryResult) => void) => void;

interface Harness {
  clock: FakeClock;
  children: FakeChild[];
  frames: GuestFrame[];
  table: GuestProcessTable;
  setInventory(impl: InventoryImpl): void;
}

function harness(): Harness {
  const clock = fakeClock();
  const children: FakeChild[] = [];
  const spawn: GuestSpawn = () => {
    const pid = 1000 + children.length;
    const child = fakeChild(pid, children);
    children.push(child);
    const handle: GuestSpawnedProcess = {
      pid: child.pid,
      pgid: child.pgid,
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
  let inventoryImpl: InventoryImpl = (done) => done({ pgids: [], selfPgid: 1 });
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
  return { clock, children, frames, table, setInventory: (impl) => { inventoryImpl = impl; } };
}

function startFrame(processId: string, overrides: Record<string, unknown> = {}): Parameters<GuestProcessTable["start"]>[0] {
  return StartProcessFrameSchema.parse({
    type: "start_process",
    seq: 1,
    process_id: processId,
    attempt_id: `att-${processId}`,
    command: "node server.js",
    cwd: "/workspace",
    env: [],
    ...overrides,
  }) as Parameters<GuestProcessTable["start"]>[0];
}

/** Drive one full graceful stop: SIGINT observed, group dies, pipes drain. */
function driveStopToGroupDeath(h: Harness, index: number, processId = `proc_${index + 1}`): void {
  const child = h.children[index]!;
  h.table.stop(processId);
  assert.ok(child.signals.includes("SIGINT"), "graceful SIGINT was sent");
  h.clock.advance(STOP_GRACE_MS - 1);
  assert.ok(!child.signals.includes("SIGKILL"), "a dying group is not force-killed before the grace expires");
  child.emitClose(0, null); // SIGINT handled, group dead, pipes drain
}

describe("P5.9 guest group-escape gate at stop confirmation", () => {
  it("a stop with an escaped live process group is classified UNEXPECTED_DESCENDANTS, never a clean stop", () => {
    const h = harness();
    h.table.start(startFrame("proc_1"));
    h.setInventory((done) => done({ pgids: [1, h.children[0]!.pgid, 4242], selfPgid: 1 }));
    driveStopToGroupDeath(h, 0);
    const failed = h.frames.find((f) => f.type === "process_failed");
    assert.ok(failed && failed.type === "process_failed");
    assert.equal(failed.process_id, "proc_1");
    assert.equal(failed.code, "UNEXPECTED_DESCENDANTS");
    assert.match(failed.message, /escaped/);
    assert.equal(
      h.frames.some((f) => f.type === "process_stopped"),
      false,
      "an escaped descendant must never produce a clean process_stopped",
    );
  });

  it("a clean inventory keeps the canonical confirmed-stop trace", () => {
    const h = harness();
    h.table.start(startFrame("proc_1"));
    driveStopToGroupDeath(h, 0);
    const stopped = h.frames.find((f) => f.type === "process_stopped");
    assert.ok(stopped && stopped.type === "process_stopped");
    assert.equal(stopped.process_id, "proc_1");
    assert.equal(stopped.forced, false);
    assert.equal(stopped.exit_code, 0);
    assert.equal(
      h.frames.some((f) => f.type === "process_failed"),
      false,
      "a clean inventory must not classify an escape",
    );
  });

  it("known groups (container init, supervisor's own group, active table entries) are never classified as escapes", () => {
    const h = harness();
    h.table.start(startFrame("proc_1"));
    h.table.start(startFrame("proc_2"));
    const selfPgid = 7;
    // Alive groups: container init (1), the supervisor's own group (7), BOTH
    // active managed groups, and the inventory probe (shares the supervisor's
    // group). None of these is an escape.
    h.setInventory((done) => done({
      pgids: [1, selfPgid, h.children[0]!.pgid, h.children[1]!.pgid],
      selfPgid,
    }));
    driveStopToGroupDeath(h, 0);
    const stopped = h.frames.find((f) => f.type === "process_stopped");
    assert.ok(stopped && stopped.type === "process_stopped", "the stop of proc_1 is confirmed cleanly");
    assert.equal(h.frames.some((f) => f.type === "process_failed"), false);
  });

  it("an inventory failure is ambiguity and fails closed (UNEXPECTED_DESCENDANTS)", () => {
    const h = harness();
    h.table.start(startFrame("proc_1"));
    h.setInventory((done) => done(null));
    driveStopToGroupDeath(h, 0);
    const failed = h.frames.find((f) => f.type === "process_failed");
    assert.ok(failed && failed.type === "process_failed");
    assert.equal(failed.code, "UNEXPECTED_DESCENDANTS");
    assert.match(failed.message, /ambiguity/);
    assert.equal(h.frames.some((f) => f.type === "process_stopped"), false);
  });

  it("an inventory that cannot identify the supervisor's own group is treated as ambiguity", () => {
    const h = harness();
    h.table.start(startFrame("proc_1"));
    h.setInventory((done) => done({ pgids: [1, h.children[0]!.pgid], selfPgid: null }));
    driveStopToGroupDeath(h, 0);
    const failed = h.frames.find((f) => f.type === "process_failed");
    assert.ok(failed && failed.type === "process_failed");
    assert.equal(failed.code, "UNEXPECTED_DESCENDANTS");
  });

  it("a forced (SIGKILL) stop also passes through the escape gate", () => {
    const h = harness();
    h.table.start(startFrame("proc_1"));
    h.setInventory((done) => done({ pgids: [1, h.children[0]!.pgid, 5150], selfPgid: 1 }));
    h.table.stop("proc_1");
    const child = h.children[0]!;
    h.clock.advance(STOP_GRACE_MS + 1); // grace expires -> SIGKILL fallback
    assert.ok(child.signals.includes("SIGKILL"));
    child.emitClose(null, "SIGKILL");
    const failed = h.frames.find((f) => f.type === "process_failed");
    assert.ok(failed && failed.type === "process_failed");
    assert.equal(failed.code, "UNEXPECTED_DESCENDANTS");
  });

  it("a foreground cancellation whose group escapes is also classified UNEXPECTED_DESCENDANTS", () => {
    const h = harness();
    h.table.start(startFrame("fg-att-1", { mode: "foreground" }));
    h.setInventory((done) => done({ pgids: [1, h.children[0]!.pgid, 6060], selfPgid: 1 }));
    driveStopToGroupDeath(h, 0, "fg-att-1");
    const failed = h.frames.find((f) => f.type === "process_failed");
    assert.ok(failed && failed.type === "process_failed");
    assert.equal(failed.process_id, "fg-att-1");
    assert.equal(failed.code, "UNEXPECTED_DESCENDANTS");
    assert.equal(h.frames.some((f) => f.type === "process_stopped"), false);
  });
});

// -----------------------------------------------------------------------------
// Reconciliation + new-session barrier (diagnostics invoke seam)
// -----------------------------------------------------------------------------

interface InvokePlan {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  spawnError?: Error;
}

function invocationResult(plan: InvokePlan): DockerInvocationResult {
  return {
    exitCode: plan.spawnError !== undefined ? null : plan.exitCode,
    signal: null,
    stdout: Buffer.from(plan.stdout ?? "", "utf8"),
    stderr: Buffer.from(plan.stderr ?? "", "utf8"),
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    spawnError: plan.spawnError ?? null,
  };
}

function fakeProvider(
  plan: (argv: readonly string[]) => InvokePlan,
  calls: Array<readonly string[]> = [],
): DockerSandboxProvider {
  const config: DockerProviderConfig = {
    cli: {
      dockerExe: "C:\\fake\\docker.exe",
      context: "desktop-linux",
      configDir: "C:\\fake\\config",
      clientEnv: {},
    },
    imageReference: "sha256:" + "a".repeat(64),
    installationId: "cf-p59-units",
    // Diagnostics-only seam (trusted machine configuration; never
    // renderer-facing): the deterministic reconcile tests drive the Docker
    // invocations through this function instead of the real transport.
    diagnosticsDockerInvoke: async (options: DockerInvokeOptions) => {
      calls.push(options.argv);
      return invocationResult(plan(options.argv));
    },
  };
  return new DockerSandboxProvider(config);
}

function psPlan(ids: readonly string[]): InvokePlan {
  return { exitCode: 0, stdout: ids.join("\n") + (ids.length > 0 ? "\n" : "") };
}

const GARBAGE_INPUT = { session_id: "sess-x", generation: 1 } as unknown as AdmittedSession;

function failureCode(error: unknown): string {
  return (error as Error & { code?: string }).code ?? "";
}

describe("P5.9 reconciliation and the new-session barrier", () => {
  it("the launch reconcile removes exactly-labelled owned leftovers and prepare then proceeds past the barrier", async () => {
    const calls: Array<readonly string[]> = [];
    const leftOverId = "b".repeat(64);
    let rmOutcome: InvokePlan = { exitCode: 1, stderr: "unexpected rm failure" };
    // Phase 1: the removal answer is lost AND the daemon cannot be reached
    // for the authoritative verification (genuine uncertainty -> HOLD).
    // Phase 3: the removal succeeds outright.
    let inspectOutcome: InvokePlan = { exitCode: 1, spawnError: new Error("daemon unreachable during verification") };
    const provider = fakeProvider((argv) => {
      if (argv[0] === "ps") return psPlan([leftOverId]);
      if (argv[0] === "rm") return rmOutcome;
      if (argv[0] === "inspect") return inspectOutcome;
      throw new Error(`unexpected invocation: ${argv.join(" ")}`);
    }, calls);

    // First prepare runs the launch reconcile; the unconfirmed removal blocks
    // the new session (CLEANUP_UNCONFIRMED) BEFORE any create.
    await assert.rejects(provider.prepare(GARBAGE_INPUT), (error: unknown) =>
      failureCode(error) === "CLEANUP_UNCONFIRMED");
    const report: ReconciliationReport = await provider.reconcileRecordedSessions();
    assert.equal(report.status, "reconciled");
    assert.equal(report.scanned, 1);
    assert.deepEqual(report.unconfirmed.map((e) => e.container_id), [leftOverId]);
    assert.equal(report.reconciled.length, 0);

    // The barrier still holds.
    await assert.rejects(provider.prepare(GARBAGE_INPUT), (error: unknown) =>
      failureCode(error) === "CLEANUP_UNCONFIRMED");

    // A reconcile that proves the container gone clears the barrier (the
    // removal succeeds outright, so no verification query is needed).
    rmOutcome = { exitCode: 0, stdout: leftOverId + "\n" };
    inspectOutcome = { exitCode: 0, stdout: "{}" };
    const cleared = await provider.reconcileRecordedSessions();
    assert.equal(cleared.status, "reconciled");
    assert.deepEqual(cleared.reconciled.map((e) => e.container_id), [leftOverId]);
    assert.equal(cleared.unconfirmed.length, 0);

    // The barrier is lifted: prepare now fails with the canonical trusted-
    // input rejection (garbage context), never with CLEANUP_UNCONFIRMED.
    await assert.rejects(provider.prepare(GARBAGE_INPUT), (error: unknown) =>
      failureCode(error) === "NOT_AUTHORIZED");
    assert.ok(
      calls.some((argv) => argv[0] === "ps"),
      "the reconcile used the label-scoped ps listing",
    );
    assert.ok(
      calls.every((argv) => argv[0] !== "create"),
      "no container creation was attempted in this unit",
    );
  });

  it("the label scope is exactly owner+phase+installation (never a global prune)", async () => {
    const calls: Array<readonly string[]> = [];
    const provider = fakeProvider(() => psPlan([]), calls);
    const report = await provider.reconcileRecordedSessions();
    assert.equal(report.status, "reconciled");
    assert.equal(report.scanned, 0);
    const ps = calls.find((argv) => argv[0] === "ps");
    assert.ok(ps !== undefined, "the reconcile listed containers through docker ps");
    const labelFilters = ps!.filter((token) => token.startsWith("label="));
    assert.equal(labelFilters.length, 3, "exactly the owner/phase/installation labels");
    assert.ok(labelFilters.some((f) => f === "label=com.course-factory.owner=terminal-engine"));
    assert.ok(labelFilters.some((f) => f === "label=com.course-factory.phase=P5"));
    assert.ok(labelFilters.some((f) => f === "label=com.course-factory.installation=cf-p59-units"));
    assert.ok(!calls.some((argv) => argv.includes("prune")), "no prune anywhere");
    assert.ok(!calls.some((argv) => argv[0] === "rm"), "nothing to remove");
  });

  it("a daemon outage reports status unavailable, preserves the ledger and never blocks silently", async () => {
    const calls: Array<readonly string[]> = [];
    const provider = fakeProvider(() => ({ exitCode: 1, spawnError: new Error("daemon unreachable") }), calls);
    const report = await provider.reconcileRecordedSessions();
    assert.equal(report.status, "unavailable");
    assert.equal(report.scanned, 0);
    assert.equal(report.reconciled.length, 0);
    assert.equal(report.unconfirmed.length, 0);
    // The outage is NOT an unconfirmed removal: prepare proceeds past the
    // reconcile and fails later on its own merits (here: the garbage trusted
    // input), never with CLEANUP_UNCONFIRMED.
    await assert.rejects(provider.prepare(GARBAGE_INPUT), (error: unknown) =>
      failureCode(error) === "NOT_AUTHORIZED");
  });

  it("the daemon's exact not-found answer counts as authoritative removal during reconciliation", async () => {
    const calls: Array<readonly string[]> = [];
    const goneId = "c".repeat(64);
    const provider = fakeProvider((argv) => {
      if (argv[0] === "ps") return psPlan([goneId]);
      if (argv[0] === "rm") return { exitCode: 1, stderr: `Error: No such container: ${goneId}` };
      throw new Error(`unexpected invocation: ${argv.join(" ")}`);
    }, calls);
    const report = await provider.reconcileRecordedSessions();
    assert.equal(report.status, "reconciled");
    assert.deepEqual(report.reconciled.map((e) => e.container_id), [goneId]);
    assert.equal(report.unconfirmed.length, 0);
  });

  it("a lost rm answer under load is NOT uncertainty when the daemon's authoritative listing proves the container gone", async () => {
    const calls: Array<readonly string[]> = [];
    const goneId = "e".repeat(64);
    const provider = fakeProvider((argv) => {
      if (argv[0] === "ps") return psPlan([goneId]);
      if (argv[0] === "rm") return { exitCode: 1, stderr: "unexpected rm failure" };
      if (argv[0] === "inspect") return { exitCode: 1, stderr: `error: no such object: ${goneId}` };
      throw new Error(`unexpected invocation: ${argv.join(" ")}`);
    }, calls);
    const report = await provider.reconcileRecordedSessions();
    assert.equal(report.status, "reconciled");
    assert.deepEqual(report.reconciled.map((e) => e.container_id), [goneId]);
    assert.equal(report.unconfirmed.length, 0, "a proven-gone container is never reported unconfirmed");
    assert.ok(calls.some((argv) => argv[0] === "inspect"), "the authoritative verification ran");
  });

  it("a mid-removal container (rm answers 'already in progress') is confirmed through the authoritative listing, not held uncertain", async () => {
    const calls: Array<readonly string[]> = [];
    const goneId = "f".repeat(64);
    const provider = fakeProvider((argv) => {
      if (argv[0] === "ps") return psPlan([goneId]);
      if (argv[0] === "rm") {
        return { exitCode: 1, stderr: `Error response from daemon: removal of container ${goneId} is already in progress` };
      }
      if (argv[0] === "inspect") return { exitCode: 1, stderr: `error: no such object: ${goneId}` };
      throw new Error(`unexpected invocation: ${argv.join(" ")}`);
    }, calls);
    const report = await provider.reconcileRecordedSessions();
    assert.equal(report.status, "reconciled");
    assert.deepEqual(report.reconciled.map((e) => e.container_id), [goneId]);
    assert.equal(report.unconfirmed.length, 0);
  });
});

describe("P5.9 ownership ledger (uncertain cleanup preservation)", () => {
  it("an unconfirmed removal keeps the entry (HOLD_CLEANUP) and reconciliation still reports it as lingering", () => {
    const ledger = new ContainerLedger();
    const entry = ledger.recordIntent({
      containerId: "d".repeat(64),
      name: "cf-lesson-sess",
      session_id: "sess-1",
      generation: 1,
      lesson_id: "L1",
      createdAtEpochMs: 0,
    });
    assert.equal(entry.state, "ALLOCATING");
    ledger.markCleanupUncertain(entry.containerId);
    assert.equal(ledger.get(entry.containerId)?.state, "HOLD_CLEANUP");
    assert.equal(ledger.uncertainCount(), 1);
    const summary = ledger.reconcile([entry.containerId]);
    assert.equal(summary.lingering.length, 1, "the uncertain entry stays the provider's cleanup responsibility");
    // Only a confirmed removal clears it.
    ledger.forget(entry.containerId);
    assert.equal(ledger.uncertainCount(), 0);
  });
});

// Type-only guard: ProviderSession must stay opaque across the P5.9 surface.
type _OpaqueSessionCheck = ProviderSession;
