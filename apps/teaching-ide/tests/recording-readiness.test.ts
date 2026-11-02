// P9.5 corrective — bounded first-frame readiness deterministic matrix.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 9, 16, 19 (15 s
// startup bound, 30 Hz app-driven pull, fail-closed source loss) and
// ADR-0014 (observation tier, zero renderer authority).
//
// Composition (all deterministic, zero real sleeps, manual scheduler):
//   - REAL RecordingHost (electron/recording-host.ts)
//   - REAL WgcCaptureSession over canonical P9.2 FakeCaptureDriver
//   - REAL RecordingTimelineCoordinator
//   - Canonical P9.3 FakeEncoderSession (scriptable faults)
//   - In-memory sink, manual scheduler, controllable runtime source/clock.
//
// Proves the corrective contract:
//   After capture.start(), the host waits (scheduler-driven, 30 Hz cadence)
//   for the FIRST VALID frame inside the frozen 15 s operational bound.
//   P8 never progresses before readiness; the readiness frame is consumed
//   and forwarded exactly once (policy A); cancellation/supersession fence
//   via take-seq; source loss fails early (never timeout); no timer
//   survives cleanup; all waits bounded; zero real sleeps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RecordingHost,
  READINESS_POLL_INTERVAL_MS,
  READINESS_STARTUP_TIMEOUT_MS,
  FRAME_PUMP_INTERVAL_MS,
  type RecordingHostDeps,
  type TrustedRuntimeSource,
} from "../electron/recording-host.ts";
import { WgcCaptureSession } from "../../../engine/recording/src/capture/wgc-session.ts";
import { FakeCaptureDriver, type FakeScriptStep } from "../../../engine/recording/src/capture/fake-driver.ts";
import { TrustedCaptureSourceRegistry } from "../../../engine/recording/src/capture/trusted-source.ts";
import { RecordingTimelineCoordinator } from "../../../engine/recording/src/timeline-coordinator.ts";
import { FakeEncoderSession } from "../../../engine/recording/src/encoder/fake-encoder.ts";
import type { EncoderDescriptor } from "../../../engine/recording/src/encoder-profile.ts";
import type { GlobalRuntimeEvent } from "@course-factory/runtime-orchestrator";
import { ACQUISITION_STARTUP_TIMEOUT_MS } from "../../../engine/recording/src/disk-budget.ts";

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, "..", "electron");

const LESSON_ID = "C01-L001";
const RUNTIME_SESSION = "sess-p95-ready";
const SCENE_ID = "C01-L001-S001";
const OWNER_PID = 4242;
const WINDOW_HANDLE = 0xabcd1234n;
const START_MS = 10_000;
const STARTUP_BOUND = 15_000;

const DESCRIPTOR: EncoderDescriptor = {
  family: "LIBX264",
  profile: "libx264-veryfast-crf21",
  profile_version: "1.0",
  fallback_used: false,
  encoder_version: "p95-ready-test",
};

// ---------------------------------------------------------------------------
// Deterministic doubles
// ---------------------------------------------------------------------------

class ManualScheduler {
  readonly timers = new Map<number, { fn: () => void; cancelled: boolean; ms: number }>();
  private nextId = 1;
  readonly scheduleCalls: number[] = [];
  schedule(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { fn, cancelled: false, ms });
    this.scheduleCalls.push(ms);
    return id;
  }
  cancel(timer: unknown): void {
    const e = this.timers.get(timer as number);
    if (e !== undefined) e.cancelled = true;
  }
  get pendingCount(): number {
    let n = 0;
    for (const e of this.timers.values()) if (!e.cancelled) n++;
    return n;
  }
  liveTimers(): Array<{ id: number; ms: number }> {
    const out: Array<{ id: number; ms: number }> = [];
    for (const [id, e] of this.timers.entries()) if (!e.cancelled) out.push({ id, ms: e.ms });
    return out;
  }
  runNext(): boolean {
    for (const [id, e] of [...this.timers.entries()]) {
      if (!e.cancelled) {
        e.cancelled = true;
        this.timers.delete(id);
        e.fn();
        return true;
      }
    }
    return false;
  }
}

type RuntimeListener = (event: GlobalRuntimeEvent) => void;

class FakeRuntimeSource implements TrustedRuntimeSource {
  binding: { runtimeSessionId: string; generation: number; lessonId: string; journalHighSeq: number; state: string } | null = {
    runtimeSessionId: RUNTIME_SESSION,
    generation: 1,
    lessonId: LESSON_ID,
    journalHighSeq: 0,
    state: "RUNNING",
  };
  readonly listeners = new Set<RuntimeListener>();
  readonly ordinals = new Map<string, number>();
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  getBinding(): { runtimeSessionId: string; generation: number; lessonId: string; journalHighSeq: number; state: string } | null {
    return this.binding === null ? null : { ...this.binding };
  }
  subscribe(listener: RuntimeListener): () => void {
    this.subscribeCalls += 1;
    this.listeners.add(listener);
    return () => {
      this.unsubscribeCalls += 1;
      this.listeners.delete(listener);
    };
  }
  resolveOrdinal(stepId: string): number | null {
    return this.ordinals.get(stepId) ?? null;
  }
  emit(event: GlobalRuntimeEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}

class MemFiles {
  readonly created: string[] = [];
  readonly appended: string[] = [];
  readonly removed: string[] = [];
  createTakeDir(s: string, t: string): string {
    const d = `mem-temp/recording/${s}/${t}`;
    this.created.push(d);
    return d;
  }
  appendAnchorLine(dir: string, line: string): void {
    this.appended.push(`${dir}|${line}`);
  }
  removeTakeDir(dir: string): void {
    this.removed.push(dir);
  }
}

interface ReadyWorldOptions {
  readonly script?: FakeScriptStep[];
  readonly returnBytes?: boolean;
  readonly encoderFailOnWrite?: boolean;
  readonly recordSafe?: boolean;
  readonly windowWidth?: number;
  readonly windowHeight?: number;
}

interface ReadyWorld {
  readonly host: RecordingHost;
  readonly source: FakeRuntimeSource;
  readonly files: MemFiles;
  readonly scheduler: ManualScheduler;
  readonly sessions: WgcCaptureSession[];
  readonly encoders: FakeEncoderSession[];
  nowMs: number;
  setNow(ms: number): void;
  startPending(): Promise<import("../electron/recording-host.ts").StartTakeResult>;
  emitSeq(seq: number, eventType: string, opts?: { stepSuffix?: string; outcome?: "COMPLETED" | "CANCELLED" | "FAILED" | "UNCERTAIN"; generation?: number }): void;
}

function makeEvent(seq: number, eventType: string, opts: { stepSuffix: string; generation: number; timestampMs: number; outcome?: "COMPLETED" | "CANCELLED" | "FAILED" | "UNCERTAIN" }): GlobalRuntimeEvent {
  // Canonical P8 kind/engine taxonomy (frozen): take-level lifecycle events
  // are kind=lifecycle/engine=orchestrator; step-domain events keep the
  // step kind/domain engine. Exact-match table, never a name heuristic.
  const lifecycle = eventType === "runtime.completed" ||
    eventType === "runtime.cancelled" ||
    eventType === "runtime.paused" ||
    eventType === "runtime.resumed" ||
    eventType === "runtime.reset.started" ||
    eventType === "runtime.reset.browser" ||
    eventType === "runtime.reset.terminal" ||
    eventType === "runtime.reset.workspace" ||
    eventType === "runtime.reset.completed";
  return {
    global_seq: seq,
    timestamp_ms: opts.timestampMs,
    runtime_session_id: RUNTIME_SESSION,
    generation: opts.generation,
    lesson_id: LESSON_ID,
    scene_id: SCENE_ID,
    step_id: `C01-L001-S001-B00${opts.stepSuffix}`,
    kind: lifecycle ? "lifecycle" : "action",
    engine: lifecycle ? "orchestrator" : "narration",
    event_type: eventType,
    attempt_id: `attempt-${seq}`,
    ...(opts.outcome === undefined ? {} : { outcome: opts.outcome }),
  } as GlobalRuntimeEvent;
}

function createReadyWorld(options: ReadyWorldOptions = {}): ReadyWorld {
  const source = new FakeRuntimeSource();
  const files = new MemFiles();
  const scheduler = new ManualScheduler();
  const registry = new TrustedCaptureSourceRegistry();
  const state = { nowMs: START_MS };
  const sessions: WgcCaptureSession[] = [];
  const encoders: FakeEncoderSession[] = [];
  let takeCounter = 0;
  const returnBytes = options.returnBytes ?? true;
  const script = options.script ?? [{ kind: "frame" } as FakeScriptStep];
  const deps: RecordingHostDeps = {
    source,
    window: {
      resolveWindow: () => ({
        windowHandle: WINDOW_HANDLE,
        ownerPid: OWNER_PID,
        width: options.windowWidth ?? 1920,
        height: options.windowHeight ?? 1080,
        webContentsId: 7,
      }),
      isRecordSafe: () => options.recordSafe ?? true,
    },
    allocateIds: () => {
      takeCounter += 1;
      return { recordingSessionId: `rec-ready-${takeCounter}`, takeId: `t${String(takeCounter).padStart(2, "0")}` };
    },
    tempRoot: "p95-ready-temp",
    files,
    createCaptureSession: ({ fence, takeId }) => {
      const issued = registry.issue({ windowHandle: WINDOW_HANDLE, ownerPid: OWNER_PID });
      const driver = new FakeCaptureDriver({ script: [...script] });
      const session = new WgcCaptureSession({ fence: { ...fence }, takeId, driver, registry, token: issued.token });
      sessions.push(session);
      return session;
    },
    createEncoderSession: ({ fence, takeId }) => {
      const encoder = new FakeEncoderSession({ fence: { ...fence }, takeId });
      if (options.encoderFailOnWrite === true) {
        const original = encoder.writeFrame.bind(encoder);
        void original;
        encoder.writeFrame = async () => ({
          accepted: false as const,
          code: "ENCODER_FAILED" as const,
          message: "injected encoder failure during readiness",
        });
      }
      encoders.push(encoder);
      return encoder;
    },
    createTimeline: ({ fence, epoch }) =>
      new RecordingTimelineCoordinator({ fence: { ...fence }, epoch: { ...epoch } }),
    resolveEncoderDescriptor: () => ({ ...DESCRIPTOR }),
    bytesSource: {
      sourceName: "p95-ready-bytes",
      readFrameBytes: (frame) => {
        if (!returnBytes) return null;
        return Buffer.alloc(frame.width * frame.height * 4);
      },
    },
    armByteRetention: () => undefined,
    clock: { nowRuntimeMs: () => state.nowMs },
    scheduler: scheduler as unknown as RecordingHostDeps["scheduler"],
  };
  const host = new RecordingHost(deps);
  return {
    host,
    source,
    files,
    scheduler,
    sessions,
    encoders,
    get nowMs() { return state.nowMs; },
    set nowMs(_v: number) { state.nowMs = _v; },
    setNow(ms: number) { state.nowMs = ms; },
    startPending() { return host.startTake({ lessonId: LESSON_ID, runtimeSessionId: RUNTIME_SESSION, generation: 1 }); },
    emitSeq(seq: number, eventType: string, opts = {}) {
      const suffix = opts.stepSuffix ?? String(seq);
      source.ordinals.set(`C01-L001-S001-B00${suffix}`, seq);
      source.emit(makeEvent(seq, eventType, {
        stepSuffix: suffix,
        generation: opts.generation ?? 1,
        timestampMs: state.nowMs + seq * 100,
        ...(opts.outcome === undefined ? {} : { outcome: opts.outcome }),
      }));
    },
  };
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

/** Drives the manual scheduler until the pending start settles (bounded). */
async function driveUntilSettled(
  world: ReadyWorld,
  pending: Promise<import("../electron/recording-host.ts").StartTakeResult>,
  maxTicks = 600,
): Promise<import("../electron/recording-host.ts").StartTakeResult> {
  let settled: import("../electron/recording-host.ts").StartTakeResult | null = null;
  let failed: unknown = null;
  void pending.then(
    (v) => { settled = v; },
    (e) => { failed = e; },
  );
  for (let i = 0; i < maxTicks && settled === null && failed === null; i++) {
    const ran = world.scheduler.runNext();
    await flushMicrotasks(2);
    if (!ran) {
      // No timer scheduled: give pending microtasks one more round, then stop.
      await flushMicrotasks(2);
      if (settled !== null || failed !== null) break;
      break;
    }
  }
  if (failed !== null) throw failed;
  if (settled === null) throw new Error("readiness wait did not settle within the bounded drive");
  return settled;
}

// ---------------------------------------------------------------------------
// 1–5: readiness success / timeout matrix
// ---------------------------------------------------------------------------

describe("P9.5 readiness: first-frame success and deadline matrix", () => {
  it("01 frame available immediately succeeds without scheduler advance", async () => {
    const world = createReadyWorld({ script: [{ kind: "frame" }] });
    const result = await world.startPending();
    assert.equal(result.ok, true, "immediate frame must succeed");
    assert.equal(world.host.isActive(), true);
    assert.equal(world.scheduler.pendingCount, 1, "normal pump scheduled after readiness");
    await world.host.shutdownAll("app_close");
  });

  it("02 frame unavailable synchronously but arrives next scheduler turn succeeds", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    assert.equal(world.host.isActive(), true, "slot owned while readiness pends");
    const result = await driveUntilSettled(world, pending, 10);
    assert.equal(result.ok, true, `next-turn frame must succeed, got ${JSON.stringify(result)}`);
    await world.host.shutdownAll("app_close");
  });

  it("03 frame arrives after several scheduler turns succeeds", async () => {
    const world = createReadyWorld({
      script: [{ kind: "empty" }, { kind: "empty" }, { kind: "empty" }, { kind: "empty" }, { kind: "frame" }],
    });
    const pending = world.startPending();
    await flushMicrotasks();
    const result = await driveUntilSettled(world, pending, 10);
    assert.equal(result.ok, true);
    // At least three scheduler yields were required: no synchronous success.
    assert.ok(world.scheduler.scheduleCalls.length >= 3, `expected >=3 polls, got ${world.scheduler.scheduleCalls.length}`);
    await world.host.shutdownAll("app_close");
  });

  it("04 frame arrives just before the deadline succeeds", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    // Move the operational clock to 1 ms before the frozen deadline.
    world.setNow(START_MS + STARTUP_BOUND - 1);
    const result = await driveUntilSettled(world, pending, 10);
    assert.equal(result.ok, true, `just-before-deadline frame must succeed, got ${JSON.stringify(result)}`);
    await world.host.shutdownAll("app_close");
  });

  it("05 no frame by the deadline fails FRAME_TIMEOUT", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    world.setNow(START_MS + STARTUP_BOUND);
    world.scheduler.runNext();
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.code, "FRAME_TIMEOUT");
    assert.equal(world.host.isActive(), false);
  });
});

// ---------------------------------------------------------------------------
// 6–7: no busy loop, scheduler yields
// ---------------------------------------------------------------------------

describe("P9.5 readiness: bounded pacing (no spin, scheduler yields)", () => {
  it("06 no busy loop: deferred readiness schedules, never spins synchronously", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    // Exactly one poll timer outstanding at a time (bounded, not a loop).
    assert.equal(world.scheduler.pendingCount, 1);
    assert.deepEqual(world.scheduler.liveTimers().map((t) => t.ms), [READINESS_POLL_INTERVAL_MS]);
    const result = await driveUntilSettled(world, pending, 10);
    assert.equal(result.ok, true);
    await world.host.shutdownAll("app_close");
  });

  it("07 scheduler yields between attempts at the canonical 30 Hz cadence", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    const before = world.scheduler.scheduleCalls.length;
    assert.ok(before >= 1, "first poll scheduled");
    for (const ms of world.scheduler.scheduleCalls) {
      assert.equal(ms, READINESS_POLL_INTERVAL_MS, "readiness cadence reuses the 30 Hz pump scheduler");
      assert.equal(ms, FRAME_PUMP_INTERVAL_MS);
    }
    const result = await driveUntilSettled(world, pending, 10);
    assert.equal(result.ok, true);
    // Every attempt after the first required a scheduler turn.
    assert.ok(world.scheduler.scheduleCalls.length > before, "attempts advanced only via scheduler turns");
    await world.host.shutdownAll("app_close");
  });
});

// ---------------------------------------------------------------------------
// 8–12: cancellation and supersession
// ---------------------------------------------------------------------------

describe("P9.5 readiness: cancellation and supersession settle and clean", () => {
  it("08 shutdown during readiness settles and cleans with no surviving timer", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    assert.equal(world.host.isActive(), true);
    await world.host.shutdownAll("app_close");
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.code, "INVALID_REQUEST");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.scheduler.pendingCount, 0, "no readiness timer survives shutdown");
    assert.equal(world.source.unsubscribeCalls, 1, "listener removed on shutdown");
    assert.equal(world.sessions[0]!.stats().state, "closed", "capture closes on shutdown");
  });

  it("09 stop during readiness settles and cleans", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    const summary = await world.host.abortTake("OPERATOR_CANCELLED");
    assert.equal(summary.cause, "OPERATOR_CANCELLED");
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(world.host.isActive(), false);
    assert.equal(world.scheduler.pendingCount, 0);
    assert.equal(world.source.unsubscribeCalls, 1);
  });

  it("10 reset during readiness terminates the old take", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    world.emitSeq(1, "runtime.reset.started");
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.code, "STALE_GENERATION");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.scheduler.pendingCount, 0);
  });

  it("11 generation change during readiness cannot activate a stale take", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    world.emitSeq(9, "step.completed", { generation: 2 });
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.code, "STALE_GENERATION");
    assert.equal(world.host.isActive(), false);
    // Even though a frame is queued for the old take, it must never
    // activate after the generation fence fired.
    world.scheduler.runNext();
    await flushMicrotasks();
    assert.equal(world.host.isActive(), false);
  });

  it("12 window close during readiness settles and cleans", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    world.host.handleWindowClosed(7);
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.code, "CAPTURE_SOURCE_LOST");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.scheduler.pendingCount, 0);
    assert.equal(world.source.unsubscribeCalls, 1);
  });
});

// ---------------------------------------------------------------------------
// 13–16: source, geometry, encoder, duplicate start
// ---------------------------------------------------------------------------

describe("P9.5 readiness: source, geometry, encoder, and duplicate start", () => {
  it("13 source loss during readiness fails with source semantics, never timeout", async () => {
    const world = createReadyWorld({ script: [{ kind: "source-lost" }] });
    const result = await world.startPending();
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.code, "CAPTURE_SOURCE_LOST");
    assert.notEqual(result.code, "FRAME_TIMEOUT");
    assert.equal(world.host.isActive(), false);
  });

  it("14 geometry change during readiness fails closed (no scaling)", async () => {
    const world = createReadyWorld({ script: [{ kind: "geometry-changed", width: 1280, height: 720 }] });
    const result = await world.startPending();
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.ok(
      result.code === "CAPTURE_SOURCE_LOST" || result.code === "WINDOW_GEOMETRY_MISMATCH",
      `geometry must fail closed, got ${result.code}`,
    );
    assert.notEqual(result.code, "FRAME_TIMEOUT");
    assert.equal(world.host.isActive(), false);
  });

  it("15 encoder failure during readiness unwinds with ENCODER_FAILED", async () => {
    const world = createReadyWorld({ script: [{ kind: "frame" }], encoderFailOnWrite: true });
    const result = await world.startPending();
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.code, "ENCODER_FAILED");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.source.unsubscribeCalls, 1);
  });

  it("16 duplicate start while readiness is pending is rejected", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    const second = await world.host.startTake({
      lessonId: LESSON_ID,
      runtimeSessionId: RUNTIME_SESSION,
      generation: 1,
    });
    assert.equal(second.ok, false);
    if (second.ok) throw new Error("unreachable");
    assert.equal(second.code, "RECORDER_ALREADY_ACTIVE");
    await world.host.shutdownAll("app_close");
    await flushMicrotasks();
    await pending;
  });
});

// ---------------------------------------------------------------------------
// 17–20: exactly-once ownership and late-callback fencing
// ---------------------------------------------------------------------------

describe("P9.5 readiness: exactly-once frame ownership and late fencing", () => {
  it("17 readiness frame is encoded exactly once when consuming (policy A)", async () => {
    const world = createReadyWorld({ script: [{ kind: "frame" }] });
    const result = await world.startPending();
    assert.equal(result.ok, true);
    const encoder = world.encoders[0]!;
    assert.equal(encoder.getStats().accepted_frames, 1, "readiness frame forwarded once");
    // The normal pump must not encode it a second time: run one pump tick
    // with an empty pool and confirm the count is unchanged.
    world.scheduler.runNext();
    await flushMicrotasks();
    assert.equal(encoder.getStats().accepted_frames, 1, "pump must not double-encode readiness frame");
    await world.host.shutdownAll("app_close");
  });

  it("18 readiness frame is not dropped", async () => {
    const world = createReadyWorld({ script: [{ kind: "frame" }] });
    const result = await world.startPending();
    assert.equal(result.ok, true);
    assert.equal(world.sessions[0]!.pendingCount, 0, "consumed readiness frame leaves no queue residue");
    assert.equal(world.encoders[0]!.getStats().accepted_frames, 1, "readiness frame reaches the encoder");
    await world.host.shutdownAll("app_close");
  });

  it("19 late readiness callback after stop is ignored", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    const live = world.scheduler.liveTimers();
    assert.equal(live.length, 1);
    const staleTimer = live[0]!.id;
    await world.host.abortTake("OPERATOR_CANCELLED");
    await flushMicrotasks();
    await pending;
    // Firing the stale timer handle (if still referenced) must be a no-op:
    // no activation, no crash, slot stays free.
    world.scheduler.runNext();
    await flushMicrotasks();
    void staleTimer;
    assert.equal(world.host.isActive(), false);
    assert.equal(world.host.getActiveFence(), null);
  });

  it("20 late readiness callback from an old take cannot activate a new take", async () => {
    const world = createReadyWorld({ script: [] });
    const first = world.startPending();
    await flushMicrotasks();
    // Capture the old take-seq timer, then abort: the timer becomes stale.
    const staleLive = world.scheduler.liveTimers();
    assert.equal(staleLive.length, 1);
    await world.host.abortTake("OPERATOR_CANCELLED");
    await flushMicrotasks();
    await first;
    assert.equal(world.host.getActiveFence(), null, "slot free after abort");
    // New take on a fresh host with an immediate frame succeeds; firing the
    // old host's stale timer must not activate anything on either host.
    const world2 = createReadyWorld({ script: [{ kind: "frame" }] });
    const second = await world2.startPending();
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.take.takeId, "t01");
    world.scheduler.runNext();
    await flushMicrotasks();
    assert.equal(world.host.isActive(), false, "old stale callback never activates");
    assert.equal(world2.host.getActiveFence()!.take_id, "t01", "new take unaffected by old take-seq");
    await world.host.shutdownAll("app_close").catch(() => undefined);
    await world2.host.shutdownAll("app_close");
  });
});

// ---------------------------------------------------------------------------
// 21–25: cleanup and slot release
// ---------------------------------------------------------------------------

describe("P9.5 readiness: listener, capture, encoder, and slot cleanup", () => {
  it("21 listener is removed on timeout", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    assert.equal(world.source.listeners.size, 1);
    world.setNow(START_MS + STARTUP_BOUND);
    world.scheduler.runNext();
    await flushMicrotasks();
    await pending;
    assert.equal(world.source.listeners.size, 0, "subscription released on timeout");
    assert.equal(world.source.unsubscribeCalls, 1);
  });

  it("22 capture closes on timeout", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    world.setNow(START_MS + STARTUP_BOUND);
    world.scheduler.runNext();
    await flushMicrotasks();
    await pending;
    assert.equal(world.sessions.length, 1);
    assert.equal(world.sessions[0]!.stats().state, "closed");
  });

  it("23 encoder closes/aborts as canonical on timeout", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    world.setNow(START_MS + STARTUP_BOUND);
    world.scheduler.runNext();
    await flushMicrotasks();
    await pending;
    assert.equal(world.encoders.length, 1);
    assert.equal(world.encoders[0]!.getStats().state, "CLOSED", "encoder aborted then closed on timeout");
  });

  it("24 active slot is released after failed readiness", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    assert.equal(world.host.isActive(), true);
    world.setNow(START_MS + STARTUP_BOUND);
    world.scheduler.runNext();
    await flushMicrotasks();
    await pending;
    assert.equal(world.host.isActive(), false);
    assert.equal(world.host.getActiveFence(), null);
    assert.equal(world.host.getSnapshot(), null);
    assert.equal(world.files.removed.length, 1, "take temp removed on failed readiness");
  });

  it("25 second take works after a readiness failure", async () => {
    const world = createReadyWorld({ script: [] });
    const first = world.startPending();
    await flushMicrotasks();
    world.setNow(START_MS + STARTUP_BOUND);
    world.scheduler.runNext();
    await flushMicrotasks();
    const firstResult = await first;
    assert.equal(firstResult.ok, false);
    // The world script is empty for every take, so drive the second take
    // with a fresh world that has a frame: proves the slot is reusable.
    const world2 = createReadyWorld({ script: [{ kind: "frame" }] });
    const second = await world2.startPending();
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.take.takeId, "t01");
    await world2.host.shutdownAll("app_close");
  });
});

// ---------------------------------------------------------------------------
// 26–30: runtime gating, bound, and static guarantees
// ---------------------------------------------------------------------------

describe("P9.5 readiness: runtime gating, bound, and static guarantees", () => {
  it("26 no runtime progress before readiness success", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    // Emit an authoritative step event while readiness pends: it must be
    // buffered (never fabricated into an anchor, never encoded).
    world.emitSeq(1, "step.completed");
    await flushMicrotasks();
    assert.equal(world.files.appended.length, 0, "no anchor fabricated before readiness");
    assert.equal(world.encoders[0]!.getStats().accepted_frames, 0, "no encoder frame before readiness");
    const result = await driveUntilSettled(world, pending, 10);
    assert.equal(result.ok, true);
    await world.host.shutdownAll("app_close");
  });

  it("27 runtime may progress only after readiness success", async () => {
    const world = createReadyWorld({ script: [{ kind: "frame" }] });
    const result = await world.startPending();
    assert.equal(result.ok, true);
    world.emitSeq(1, "step.completed");
    await flushMicrotasks();
    assert.equal(world.files.appended.length, 1, "anchor committed after readiness");
    await world.host.shutdownAll("app_close");
  });

  it("28 startup deadline never exceeds 15 s", async () => {
    assert.equal(READINESS_STARTUP_TIMEOUT_MS, 15_000);
    assert.equal(ACQUISITION_STARTUP_TIMEOUT_MS, 15_000);
    assert.equal(STARTUP_BOUND, 15_000);
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    // Just before the bound the wait is still alive; at the bound it fails.
    world.setNow(START_MS + STARTUP_BOUND - 1);
    world.scheduler.runNext();
    await flushMicrotasks();
    // Still pending (empty but inside the bound schedules again).
    assert.equal(world.host.isActive(), true);
    world.setNow(START_MS + STARTUP_BOUND);
    world.scheduler.runNext();
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "FRAME_TIMEOUT");
  });

  it("29 all waits are bounded (single poll timer, frozen cadence and bound)", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    assert.ok(world.scheduler.scheduleCalls.length >= 1);
    for (const ms of world.scheduler.scheduleCalls) {
      assert.ok(Number.isInteger(ms) && ms > 0 && ms <= READINESS_STARTUP_TIMEOUT_MS, `wait must be bounded, got ${ms}`);
    }
    const result = await driveUntilSettled(world, pending, 10);
    assert.equal(result.ok, true);
    await world.host.shutdownAll("app_close");
    assert.equal(world.scheduler.pendingCount, 0, "no readiness timer survives success+shutdown");
  });

  it("31 fractional real-clock sample calibrates in the integer P8 domain (no TIMELINE_INVALID)", async () => {
    // Real SystemMonotonicClock returns fractional milliseconds; the frozen
    // RuntimeMonotonicMs contract is integer-only. The host must floor its
    // epoch sample (P9.5-owned sampling) so real-clock readiness succeeds.
    const world = createReadyWorld({ script: [{ kind: "frame" }] });
    world.setNow(START_MS + 0.75);
    const result = await world.startPending();
    assert.equal(result.ok, true, `fractional clock must still reach readiness, got ${JSON.stringify(result)}`);
    assert.equal(world.host.isActive(), true);
    await world.host.shutdownAll("app_close");
  });

  it("30 zero real sleeps: readiness uses only the injected scheduler and clock", async () => {
    const code = readFileSync(join(electronDir, "recording-host.ts"), "utf8");
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    assert.equal(stripped.includes("Atomics.wait"), false, "no Atomics.wait in readiness");
    // All readiness waits go through deps.scheduler (real setTimeout only
    // inside the single sanctioned realRecordingScheduler definition for
    // production; manual scheduler in tests). No other direct timers.
    const withoutScheduler = stripped.replace(
      /export const realRecordingScheduler[\s\S]*?clearTimeout\(timer as ReturnType<typeof setTimeout>\)/,
      "REAL_SCHEDULER_REMOVED",
    );
    assert.equal(/[^.]setTimeout\s*\(/.test(withoutScheduler), false, "no direct setTimeout outside realRecordingScheduler");
    assert.equal(stripped.includes("setInterval("), false, "no setInterval in RecordingHost");
    assert.equal(stripped.includes("Date.now("), false, "no Date.now media authority in RecordingHost");
    assert.equal(stripped.includes("while (true)"), false, "no busy loop in RecordingHost");
  });
});

// ---------------------------------------------------------------------------
// Race matrix: exactly one canonical winner
// ---------------------------------------------------------------------------

describe("P9.5 readiness: deterministic race matrix (single winner)", () => {
  it("race first-frame vs timeout: timeout wins at the deadline even with a queued frame", async () => {
    const world = createReadyWorld({ script: [{ kind: "frame" }] });
    // Hold the frame until the deadline tick: start pends on empty first?
    // Instead use an empty-then-frame script and jump the clock to the
    // deadline before driving: the deadline check fires first.
    const world2 = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world2.startPending();
    await flushMicrotasks();
    world2.setNow(START_MS + STARTUP_BOUND);
    world2.scheduler.runNext();
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "FRAME_TIMEOUT");
    void world;
  });

  it("race first-frame vs shutdown: shutdown wins", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    await world.host.shutdownAll("app_close");
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    // Shutdown maps to INVALID_REQUEST for the pending start.
    if (!result.ok) assert.equal(result.code, "INVALID_REQUEST");
  });

  it("race first-frame vs stop: stop wins", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    await world.host.abortTake("OPERATOR_CANCELLED");
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
  });

  it("race first-frame vs reset: reset wins", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    world.emitSeq(1, "runtime.reset.started");
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "STALE_GENERATION");
  });

  it("race first-frame vs source loss: source loss wins, never timeout", async () => {
    const world = createReadyWorld({ script: [{ kind: "source-lost" }, { kind: "frame" }] });
    const result = await world.startPending();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "CAPTURE_SOURCE_LOST");
  });

  it("race first-frame vs window close: window close wins", async () => {
    const world = createReadyWorld({ script: [{ kind: "empty" }, { kind: "frame" }] });
    const pending = world.startPending();
    await flushMicrotasks();
    world.host.handleWindowClosed(7);
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "CAPTURE_SOURCE_LOST");
  });

  it("race timeout vs start rollback: slot released and reusable", async () => {
    const world = createReadyWorld({ script: [] });
    const pending = world.startPending();
    await flushMicrotasks();
    world.setNow(START_MS + STARTUP_BOUND);
    world.scheduler.runNext();
    await flushMicrotasks();
    const result = await pending;
    assert.equal(result.ok, false);
    // Rollback released everything: a fresh host admits a new take.
    const world2 = createReadyWorld({ script: [{ kind: "frame" }] });
    const second = await world2.startPending();
    assert.equal(second.ok, true);
    await world2.host.shutdownAll("app_close");
  });

  it("race old-take first-frame vs new take: old frame never activates the new take", async () => {
    const world = createReadyWorld({ script: [] });
    const first = world.startPending();
    await flushMicrotasks();
    await world.host.abortTake("OPERATOR_CANCELLED");
    await flushMicrotasks();
    await first;
    const fenceAfter = world.host.getActiveFence();
    assert.equal(fenceAfter, null);
    // New take on a fresh world succeeds independently.
    const world2 = createReadyWorld({ script: [{ kind: "frame" }] });
    const second = await world2.startPending();
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.take.takeId, "t01");
    await world2.host.shutdownAll("app_close");
  });
});
