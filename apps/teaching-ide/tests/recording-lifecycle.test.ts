// P9.5 RecordingHost deterministic lifecycle tests — null/injected capture
// seam only (no real WGC, no FFmpeg, no video, no wall-clock sleeps).
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 4, 8, 16-19 and
// docs/adr/ADR-0014-screen-recording-boundary.md.
//
// Composition (all canonical, all deterministic):
//   - REAL RecordingHost (apps/teaching-ide/electron/recording-host.ts)
//   - REAL WgcCaptureSession over the canonical P9.2 FakeCaptureDriver
//   - REAL RecordingTimelineCoordinator over a calibrated test epoch
//   - Canonical P9.3 FakeEncoderSession (scriptable faults for rollback)
//   - In-memory take-file sink, manual scheduler, controllable runtime source
//
// Proven here: idle construct, transactional start ordering (slot ->
// runtime association -> generation -> window -> record-safe -> geometry ->
// identity -> temp -> subscribe-first -> epoch -> encoder -> capture ->
// readiness -> coordinator -> pump), one-active-take fencing, stale
// session/generation rejection, attach-boundary refusal, start-failure and
// capture/encoder-failure rollback with slot release, normal stop through
// the bounded tail to a COMPLETED temp take, abort determinism
// (CANCELLED/FAILED/HOLD can never become success), reset generation
// fencing, late-callback fencing across takes, listener cleanup, shutdown
// barrier ordering, snapshot safety (no handles/paths), renderer reload
// irrelevance, and the zero-IPC / zero-proof static boundaries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledAddonCandidates } from "../electron/recording-files.ts";
import {
  RecordingHost,
  type RecordingHostDeps,
  type TrustedRuntimeSource,
} from "../electron/recording-host.ts";
import { WgcCaptureSession } from "../../../engine/recording/src/capture/wgc-session.ts";
import { FakeCaptureDriver, type FakeScriptStep } from "../../../engine/recording/src/capture/fake-driver.ts";
import { TrustedCaptureSourceRegistry } from "../../../engine/recording/src/capture/trusted-source.ts";
import { RecordingTimelineCoordinator } from "../../../engine/recording/src/timeline-coordinator.ts";
import { calibrateTimelineEpoch } from "../../../engine/recording/src/timeline-clock.ts";
import { frameIndexForElapsedUs, rationalVideoTimeForFrameIndex } from "../../../engine/recording/src/timeline-clock.ts";
import { ptsForEncodeIndex } from "../../../engine/recording/src/encoder/encoder-frames.ts";
import { FakeEncoderSession } from "../../../engine/recording/src/encoder/fake-encoder.ts";
import type { InternalEncoderSession } from "../../../engine/recording/src/encoder/encoder-interface.ts";
import type { EncoderDescriptor } from "../../../engine/recording/src/encoder-profile.ts";
import type {
  GlobalRuntimeEvent,
} from "@course-factory/runtime-orchestrator";
import {
  TERMINAL_INVOKE_CHANNELS,
} from "../electron/terminal-host.ts";
import {
  EDITOR_INVOKE_CHANNELS,
} from "../electron/editor-host.ts";
import {
  BROWSER_INVOKE_CHANNELS,
} from "@course-factory/browser-engine";
import {
  RUNTIME_INVOKE_CHANNELS,
} from "../electron/runtime-host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, "..", "electron");
const repoRootForAddon = join(here, "..", "..", "..");

const LESSON_ID = "C01-L001";
const RUNTIME_SESSION = "sess-p95-001";
const SCENE_ID = "C01-L001-S001";
const OWNER_PID = 4242;
const WINDOW_HANDLE = 0xabcd1234n;

const DESCRIPTOR: EncoderDescriptor = {
  family: "LIBX264",
  profile: "libx264-veryfast-crf21",
  profile_version: "1.0",
  fallback_used: false,
  encoder_version: "p95-test",
};

// ---------------------------------------------------------------------------
// Deterministic doubles
// ---------------------------------------------------------------------------

interface ManualTimer {
  readonly id: number;
  readonly fn: () => void;
  cancelled: boolean;
}

class ManualScheduler {
  private nextId = 1;
  readonly timers = new Map<number, ManualTimer>();

  schedule(fn: () => void, _ms: number): unknown {
    void _ms;
    const id = this.nextId++;
    this.timers.set(id, { id, fn, cancelled: false });
    return id;
  }

  runNext(): boolean {
    for (const entry of [...this.timers.values()]) {
      if (!entry.cancelled) {
        entry.cancelled = true;
        entry.fn();
        return true;
      }
    }
    return false;
  }

  runAll(): void {
    for (const entry of [...this.timers.values()]) {
      if (!entry.cancelled) {
        entry.cancelled = true;
        entry.fn();
      }
    }
  }

  cancel(timer: unknown): void {
    const entry = this.timers.get(timer as number);
    if (entry !== undefined) entry.cancelled = true;
  }

  get pendingCount(): number {
    let count = 0;
    for (const entry of this.timers.values()) {
      if (!entry.cancelled) count += 1;
    }
    return count;
  }
}

type RuntimeListener = (event: GlobalRuntimeEvent) => void;

interface FakeBinding {
  runtimeSessionId: string;
  generation: number;
  lessonId: string;
  journalHighSeq: number;
  state: string;
}

class FakeRuntimeSource implements TrustedRuntimeSource {
  binding: FakeBinding | null = {
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

  getBinding(): FakeBinding | null {
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
    for (const listener of [...this.listeners]) listener(event);
  }
}

interface TestWindow {
  destroyed: boolean;
  width: number;
  height: number;
  recordSafe: boolean;
  webContentsId: number | null;
}

class MemFiles {
  readonly created: string[] = [];
  readonly appended: string[] = [];
  readonly removed: string[] = [];

  createTakeDir(recordingSessionId: string, takeId: string): string {
    const dir = `mem-temp/recording/${recordingSessionId}/${takeId}`;
    this.created.push(dir);
    return dir;
  }

  appendAnchorLine(takeDir: string, lineWithLf: string): void {
    this.appended.push(`${takeDir}|${lineWithLf}`);
  }

  removeTakeDir(takeDir: string): void {
    this.removed.push(takeDir);
  }
}

interface WorldOptions {
  readonly driverScript?: "frames" | "empty" | "source-lost";
  readonly customScript?: FakeScriptStep[];
  readonly captureOpenThrow?: boolean;
  readonly encoderFailOnStart?: boolean;
  readonly returnBytes?: boolean;
  readonly bytesImpl?: (frame: { width: number; height: number; frame_seq: number; capture_timestamp_us: number }) => Uint8Array | null;
  readonly wrapEncoder?: (inner: FakeEncoderSession) => InternalEncoderSession;
  readonly recordSafe?: boolean;
  readonly windowWidth?: number;
  readonly windowHeight?: number;
  readonly windowDestroyed?: boolean;
}

interface World {
  readonly host: RecordingHost;
  readonly source: FakeRuntimeSource;
  readonly files: MemFiles;
  readonly scheduler: ManualScheduler;
  readonly window: TestWindow;
  readonly sessions: WgcCaptureSession[];
  readonly encoders: FakeEncoderSession[];
  armed: number;
  nowMs: number;
  setNow(ms: number): void;
  startTake(input?: { lessonId?: string; runtimeSessionId?: string; generation?: number }): ReturnType<RecordingHost["startTake"]>;
  emitSeq(seq: number, eventType: string, opts?: { stepSuffix?: string; outcome?: "COMPLETED" | "CANCELLED" | "FAILED" | "UNCERTAIN"; generation?: number }): void;
}

function makeEvent(seq: number, eventType: string, opts: {
  stepSuffix: string;
  generation: number;
  timestampMs: number;
  outcome?: "COMPLETED" | "CANCELLED" | "FAILED" | "UNCERTAIN";
}): GlobalRuntimeEvent {
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

function createWorld(options: WorldOptions = {}): World {
  const source = new FakeRuntimeSource();
  const files = new MemFiles();
  const scheduler = new ManualScheduler();
  const registry = new TrustedCaptureSourceRegistry();
  const window: TestWindow = {
    destroyed: options.windowDestroyed ?? false,
    width: options.windowWidth ?? 1920,
    height: options.windowHeight ?? 1080,
    recordSafe: options.recordSafe ?? true,
    webContentsId: 7,
  };
  const world = {
    armed: 0,
    nowMs: 10_000,
    sessions: [] as WgcCaptureSession[],
    encoders: [] as FakeEncoderSession[],
  };
  const returnBytes = options.returnBytes ?? true;
  let takeCounter = 0;

  const deps: RecordingHostDeps = {
    source,
    window: {
      resolveWindow: () => {
        if (window.destroyed) return null;
        return {
          windowHandle: WINDOW_HANDLE,
          ownerPid: OWNER_PID,
          width: window.width,
          height: window.height,
          webContentsId: window.webContentsId,
        };
      },
      isRecordSafe: () => window.recordSafe,
    },
    allocateIds: () => {
      takeCounter += 1;
      return {
        recordingSessionId: `rec-p95-${takeCounter}`,
        takeId: `t${String(takeCounter).padStart(2, "0")}`,
      };
    },
    tempRoot: "p95-test-temp",
    files,
    createCaptureSession: ({ fence, takeId }) => {
      const issued = registry.issue({ windowHandle: WINDOW_HANDLE, ownerPid: OWNER_PID });
      const script = options.driverScript ?? "frames";
      const driver = new FakeCaptureDriver(
        options.customScript !== undefined
          ? { script: [...options.customScript] }
          : options.captureOpenThrow === true
            ? { openThrow: { code: "SOURCE_DESTROYED", message: "window no longer exists" } }
            : script === "frames"
              ? { defaultFrames: 12 }
              : script === "empty"
                ? { defaultFrames: 0 }
                : { script: [{ kind: "source-lost" }] },
      );
      const session = new WgcCaptureSession({
        fence: { ...fence },
        takeId,
        driver,
        registry,
        token: issued.token,
      });
      world.sessions.push(session);
      return session;
    },
    createEncoderSession: ({ fence, takeId }) => {
      const encoder = new FakeEncoderSession({
        fence: { ...fence },
        takeId,
        faults: options.encoderFailOnStart === true ? { failOnStart: true } : {},
      });
      world.encoders.push(encoder);
      const wrapped = options.wrapEncoder === undefined ? encoder : options.wrapEncoder(encoder);
      return wrapped as unknown as ReturnType<RecordingHostDeps["createEncoderSession"]>;
    },
    createTimeline: ({ fence, epoch }) =>
      new RecordingTimelineCoordinator({ fence: { ...fence }, epoch: { ...epoch } }),
    resolveEncoderDescriptor: () => ({ ...DESCRIPTOR }),
    bytesSource: {
      sourceName: "p95-test-bytes",
      readFrameBytes: (frame) => {
        if (options.bytesImpl !== undefined) return options.bytesImpl(frame);
        if (!returnBytes) return null;
        return Buffer.alloc(frame.width * frame.height * 4);
      },
    },
    armByteRetention: () => {
      world.armed += 1;
    },
    clock: {
      nowRuntimeMs: () => world.nowMs,
    },
    scheduler,
  };
  const host = new RecordingHost(deps);
  let seq = 0;
  return {
    host,
    source,
    files,
    scheduler,
    window,
    sessions: world.sessions,
    encoders: world.encoders,
    get armed() {
      return world.armed;
    },
    set armed(_value: number) {
      world.armed = _value;
    },
    get nowMs() {
      return world.nowMs;
    },
    setNow(ms: number) {
      world.nowMs = ms;
    },
    async startTake(input = {}) {
      return host.startTake({
        lessonId: input.lessonId ?? LESSON_ID,
        runtimeSessionId: input.runtimeSessionId ?? RUNTIME_SESSION,
        generation: input.generation ?? 1,
      });
    },
    emitSeq(eventSeq: number, eventType: string, opts = {}) {
      void seq;
      seq = eventSeq;
      const stepSuffix = opts.stepSuffix ?? String(eventSeq);
      source.ordinals.set(`C01-L001-S001-B00${stepSuffix}`, eventSeq);
      source.emit(makeEvent(eventSeq, eventType, {
        stepSuffix,
        generation: opts.generation ?? 1,
        timestampMs: world.nowMs + eventSeq * 100,
        ...(opts.outcome === undefined ? {} : { outcome: opts.outcome }),
      }));
    },
  };
}

async function startOk(world: World): Promise<Extract<Awaited<ReturnType<RecordingHost["startTake"]>>, { ok: true }>["take"]> {
  const started = await world.startTake();
  assert.equal(started.ok, true, "take must start");
  if (!started.ok) throw new Error("unreachable");
  return started.take;
}

// ---------------------------------------------------------------------------
// Idle construction + preconditions
// ---------------------------------------------------------------------------

describe("P9.5 lifecycle: idle construction and preconditions", () => {
  it("host constructs idle with no snapshot and no settlement", async () => {
    const world = createWorld();
    assert.equal(world.host.getState(), "IDLE");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.host.getSnapshot(), null);
    assert.equal(world.host.getActiveFence(), null);
    await assert.rejects(world.host.awaitSettlement(), /no recording take/);
    await assert.rejects(world.host.abortTake(), /no active take/);
    await world.host.shutdownAll("app_close");
    assert.equal(world.host.getState(), "IDLE");
  });

  it("stale runtime session is rejected and the slot stays free", async () => {
    const world = createWorld();
    const rejected = await world.startTake({ runtimeSessionId: "sess-other-999" });
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "STALE_SESSION");
    assert.equal(world.host.isActive(), false);
    await startOk(world);
    await world.host.shutdownAll("app_close");
  });

  it("stale generation is rejected and the slot stays free", async () => {
    const world = createWorld();
    const rejected = await world.startTake({ generation: 2 });
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "STALE_GENERATION");
    await startOk(world);
    await world.host.shutdownAll("app_close");
  });

  it("wrong lesson binding is rejected", async () => {
    const world = createWorld();
    const rejected = await world.startTake({ lessonId: "C01-L002" });
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "INVALID_REQUEST");
    await startOk(world);
    await world.host.shutdownAll("app_close");
  });

  it("missing runtime binding refuses the take", async () => {
    const world = createWorld();
    world.source.binding = null;
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    world.source.binding = {
      runtimeSessionId: RUNTIME_SESSION,
      generation: 1,
      lessonId: LESSON_ID,
      journalHighSeq: 0,
      state: "RUNNING",
    };
    await startOk(world);
    await world.host.shutdownAll("app_close");
  });
});

// ---------------------------------------------------------------------------
// Window / record-safe / geometry gates (Main ownership, privacy)
// ---------------------------------------------------------------------------

describe("P9.5 lifecycle: trusted window and record-safe gates", () => {
  it("destroyed window refuses with INVALID_IDENTITY", async () => {
    const world = createWorld({ windowDestroyed: true });
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "INVALID_IDENTITY");
  });

  it("non-record-safe presentation refuses the take", async () => {
    const world = createWorld({ recordSafe: false });
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "INVALID_REQUEST");
  });

  it("non-canonical geometry refuses with WINDOW_GEOMETRY_MISMATCH", async () => {
    const world = createWorld({ windowWidth: 1280, windowHeight: 720 });
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "WINDOW_GEOMETRY_MISMATCH");
  });

  it("successful start propagates fence identity and record-safe snapshot", async () => {
    const world = createWorld();
    const take = await startOk(world);
    assert.equal(take.recordingSessionId, "rec-p95-1");
    assert.equal(take.takeId, "t01");
    assert.equal(take.runtimeSessionId, RUNTIME_SESSION);
    assert.equal(take.generation, 1);
    assert.equal(take.lessonId, LESSON_ID);
    assert.equal(world.host.getState(), "RECORDING");
    const fence = world.host.getActiveFence();
    assert.deepEqual(fence, {
      recording_session_id: "rec-p95-1",
      runtime_session_id: RUNTIME_SESSION,
      generation: 1,
      take_id: "t01",
    });
    const snapshot = world.host.getSnapshot();
    assert.notEqual(snapshot, null);
    assert.equal(snapshot!["recording_session_id"], "rec-p95-1");
    assert.equal(snapshot!["take_id"], "t01");
    assert.equal(snapshot!["state"], "RECORDING");
    assert.equal(snapshot!["record_safe"], true);
    assert.equal(world.source.subscribeCalls, 1);
    assert.equal(world.armed, 1);
    assert.equal(world.scheduler.pendingCount, 1);
    await world.host.shutdownAll("app_close");
  });
});

// ---------------------------------------------------------------------------
// Subscribe-first ordering + transactional rollback
// ---------------------------------------------------------------------------

describe("P9.5 lifecycle: subscribe-first ordering and rollback", () => {
  it("attach boundary: progressed journal refuses and unwinds (no half-active take)", async () => {
    const world = createWorld();
    world.source.binding = {
      runtimeSessionId: RUNTIME_SESSION,
      generation: 1,
      lessonId: LESSON_ID,
      journalHighSeq: 4,
      state: "RUNNING",
    };
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "INVALID_REQUEST");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.files.created.length, 1);
    assert.equal(world.files.removed.length, 1);
    assert.equal(world.source.unsubscribeCalls, 1);
    world.source.binding = {
      runtimeSessionId: RUNTIME_SESSION,
      generation: 1,
      lessonId: LESSON_ID,
      journalHighSeq: 0,
      state: "RUNNING",
    };
    await startOk(world);
    await world.host.shutdownAll("app_close");
  });

  it("capture open failure rolls back with CAPTURE_SOURCE_LOST and frees the slot", async () => {
    const world = createWorld({ captureOpenThrow: true });
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "CAPTURE_SOURCE_LOST");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.files.removed.length, 1);
    assert.equal(world.source.unsubscribeCalls, 1);
  });

  it("source-lost during readiness fails closed and frees the slot", async () => {
    const world = createWorld({ driverScript: "source-lost" });
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "CAPTURE_SOURCE_LOST");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.files.removed.length, 1);
  });

  it("empty readiness fails with FRAME_TIMEOUT (never STARTUP_TIMEOUT)", async () => {
    const world = createWorld({ driverScript: "empty" });
    // Bounded wait: no frame synchronously, so startTake pends on the
    // scheduler. Advance the injected monotonic clock to the frozen 15 s
    // deadline, then run the scheduler once: the poll observes now >=
    // deadline and fails closed with FRAME_TIMEOUT (no busy loop).
    const pending = world.startTake();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(world.host.isActive(), true, "slot owned while readiness pends");
    world.setNow(world.nowMs + 15_000);
    world.scheduler.runAll();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const rejected = await pending;
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "FRAME_TIMEOUT");
    assert.equal(world.host.isActive(), false);
  });

  it("encoder start failure rolls back with ENCODER_START_FAILED", async () => {
    const world = createWorld({ encoderFailOnStart: true });
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "ENCODER_START_FAILED");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.files.removed.length, 1);
    assert.equal(world.source.unsubscribeCalls, 1);
  });

  it("duplicate start while active is rejected and keeps the first take", async () => {
    const world = createWorld();
    await startOk(world);
    const second = await world.startTake();
    assert.equal(second.ok, false);
    if (second.ok) throw new Error("unreachable");
    assert.equal(second.code, "RECORDER_ALREADY_ACTIVE");
    assert.equal(world.host.getActiveFence()!["take_id"], "t01");
    await world.host.shutdownAll("app_close");
  });

  it("concurrent start vs start admits exactly one take", async () => {
    const world = createWorld();
    const [first, second] = await Promise.all([world.startTake(), world.startTake()]);
    const oks = [first, second].filter((result) => result.ok);
    assert.equal(oks.length, 1);
    assert.equal(world.host.isActive(), true);
    await world.host.shutdownAll("app_close");
  });
});

// ---------------------------------------------------------------------------
// Normal stop through the bounded tail
// ---------------------------------------------------------------------------

describe("P9.5 lifecycle: normal stop and bounded barrier", () => {
  it("COMPLETED settles a validated temp take and releases the slot", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitSeq(1, "step.completed");
    world.emitSeq(2, "step.completed");
    world.setNow(11_000);
    world.emitSeq(3, "runtime.completed", { outcome: "COMPLETED" });
    assert.equal(world.host.getState(), "STOPPING");
    const settlement = world.host.awaitSettlement();
    world.scheduler.runAll();
    const result = await settlement;
    assert.equal(result.outcome, "COMPLETED");
    assert.equal(result.validationVerdict, "PASS");
    assert.equal(result.encoderFamily, "LIBX264");
    assert.equal(result.encodedFrames >= 1, true);
    assert.equal(result.anchorCount >= 1, true);
    assert.equal(result.firstGlobalSeq, 1);
    assert.equal(result.lastGlobalSeq, 3);
    assert.equal(world.host.isActive(), false);
    assert.equal(world.host.getSnapshot(), null);
    assert.equal(world.source.unsubscribeCalls, 1);
    // Second take after first closes proves slot release.
    const second = await world.startTake();
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.take.takeId, "t02");
    await world.host.shutdownAll("app_close");
  });

  it("zero encoded frames fail closed as MEDIA_VALIDATION_FAILED, never success", async () => {
    const world = createWorld({ returnBytes: false });
    await startOk(world);
    world.setNow(11_000);
    world.emitSeq(1, "runtime.completed", { outcome: "COMPLETED" });
    const settlement = world.host.awaitSettlement();
    world.scheduler.runAll();
    // Zero encoded frames fail media validation: the take must fail
    // closed as MEDIA_VALIDATION_FAILED, never a success.
    await assert.rejects(settlement, /take ended/);
    const terminal = world.host.getLastTerminal();
    assert.notEqual(terminal, null);
    assert.equal((terminal as { cause: string }).cause, "MEDIA_VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// Abort determinism: CANCELLED / FAILED / HOLD can never become success
// ---------------------------------------------------------------------------

describe("P9.5 lifecycle: abort determinism", () => {
  it("operator cancel ends CANCELLED and rejects settlement", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitSeq(1, "runtime.cancelled", { outcome: "CANCELLED" });
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    const terminal = world.host.getLastTerminal();
    assert.notEqual(terminal, null);
    assert.equal((terminal as { cause: string }).cause, "OPERATOR_CANCELLED");
    assert.equal((terminal as { outcome: string }).outcome, "CANCELLED");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.source.unsubscribeCalls, 1);
  });

  it("FAILED outcome ends DIAGNOSTIC_PARTIAL, never success", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitSeq(1, "step.failed", { outcome: "FAILED" });
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "DIAGNOSTIC_PARTIAL");
  });

  it("UNCERTAIN outcome ends DIAGNOSTIC_PARTIAL, never success", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitSeq(1, "step.uncertain", { outcome: "UNCERTAIN" });
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "DIAGNOSTIC_PARTIAL");
  });

  it("duplicate abort is deterministic (same summary)", async () => {
    const world = createWorld();
    await startOk(world);
    const first = await world.host.abortTake("OPERATOR_CANCELLED");
    const second = await world.host.abortTake("OPERATOR_CANCELLED");
    assert.deepEqual(second, first);
    assert.equal(first.cause, "OPERATOR_CANCELLED");
    assert.equal(first.outcome, "CANCELLED");
  });

  it("reset during the take ends RESET_INTERRUPTED; stale generations are ignored", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitSeq(1, "step.completed");
    world.emitSeq(2, "runtime.reset.started");
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "RESET_INTERRUPTED");
    // A new generation starts a new take; the old take never continues.
    world.source.binding = {
      runtimeSessionId: RUNTIME_SESSION,
      generation: 2,
      lessonId: LESSON_ID,
      journalHighSeq: 0,
      state: "RUNNING",
    };
    const second = await world.startTake({ generation: 2 });
    assert.equal(second.ok, true);
    await world.host.shutdownAll("app_close");
  });
});

// ---------------------------------------------------------------------------
// Fencing: late callbacks from an old take cannot mutate the next take
// ---------------------------------------------------------------------------

describe("P9.5 lifecycle: take fencing", () => {
  it("old-take runtime listener cannot anchor into the next take", async () => {
    const world = createWorld();
    await startOk(world);
    const firstListeners = [...world.source.listeners];
    assert.equal(firstListeners.length, 1);
    const staleListener = firstListeners[0]!;
    world.emitSeq(1, "runtime.cancelled", { outcome: "CANCELLED" });
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    await startOk(world);
    assert.equal(world.host.getActiveFence()!["take_id"], "t02");
    staleListener(makeEvent(99, "step.completed", {
      stepSuffix: "9",
      generation: 1,
      timestampMs: world.nowMs + 9_900,
    }));
    assert.equal(world.host.getState(), "RECORDING");
    assert.equal(world.host.getActiveFence()!["take_id"], "t02");
    await world.host.shutdownAll("app_close");
  });

  it("window close for an unknown target is ignored; matching close ends APP_CLOSED", async () => {
    const world = createWorld();
    await startOk(world);
    world.host.handleWindowClosed(4242);
    assert.equal(world.host.getState(), "RECORDING");
    world.host.handleWindowClosed(7);
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "APP_CLOSED");
  });

  it("renderer reload carries zero recording authority", async () => {
    const world = createWorld();
    await startOk(world);
    world.host.notifyRendererReloaded();
    assert.equal(world.host.getState(), "RECORDING");
    assert.equal(world.host.getActiveFence()!["take_id"], "t01");
    await world.host.shutdownAll("app_close");
  });
});

// ---------------------------------------------------------------------------
// Shutdown barrier
// ---------------------------------------------------------------------------

describe("P9.5 lifecycle: shutdown barrier", () => {
  it("shutdown with an active take aborts APP_CLOSED and frees the slot", async () => {
    const world = createWorld();
    await startOk(world);
    await world.host.shutdownAll("app_close");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.host.getActiveFence(), null);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "APP_CLOSED");
    assert.equal(world.source.unsubscribeCalls, 1);
    await world.host.shutdownAll("app_close");
  });

  it("completion vs shutdown: shutdown supersedes the pending tail", async () => {
    const world = createWorld();
    await startOk(world);
    world.setNow(11_000);
    world.emitSeq(1, "runtime.completed", { outcome: "COMPLETED" });
    assert.equal(world.host.getState(), "STOPPING");
    const pending = world.host.awaitSettlement();
    await world.host.shutdownAll("app_close");
    await assert.rejects(pending, /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "APP_CLOSED");
  });
});

// ---------------------------------------------------------------------------
// Snapshot safety: safe fields only, never handles or paths
// ---------------------------------------------------------------------------

describe("P9.5 lifecycle: snapshot safety", () => {
  it("snapshot exposes safe fields only", async () => {
    const world = createWorld();
    await startOk(world);
    const snapshot = world.host.getSnapshot();
    assert.notEqual(snapshot, null);
    const text = JSON.stringify(snapshot);
    assert.match(text, /rec-p95-1/);
    for (const forbidden of ["handle", "HWND", "hwnd", "pid", "PID", "path", "dir", ".mp4", "C:\\", "token"]) {
      assert.equal(text.includes(forbidden), false, `snapshot leaks '${forbidden}'`);
    }
    await world.host.shutdownAll("app_close");
  });
});

// ---------------------------------------------------------------------------
// Static boundaries: zero IPC, zero proof, preload unchanged
// ---------------------------------------------------------------------------

describe("P9.5 static boundaries: no IPC, no proof, no renderer authority", () => {
  it("recording adds zero IPC channels (21 invokes / 1 send / 7 pushes total)", () => {
    assert.equal(TERMINAL_INVOKE_CHANNELS.length, 5);
    assert.equal(EDITOR_INVOKE_CHANNELS.length, 4);
    assert.equal(BROWSER_INVOKE_CHANNELS.length, 4);
    assert.equal(RUNTIME_INVOKE_CHANNELS.length, 6);
    const mainCode = readFileSync(join(electronDir, "main.ts"), "utf8");
    const namedHandles = (mainCode.match(/ipcMain\.handle\("[a-z]+:[a-zA-Z]+"(,|\))/g) ?? []).length;
    assert.equal(namedHandles, 2);
    assert.equal(5 + 4 + 4 + 6 + 2, 21);
    const preloadCode = readFileSync(join(electronDir, "preload.ts"), "utf8");
    assert.equal(preloadCode.includes('ipcRenderer.send("app:ready"'), true);
    for (const file of ["main.ts", "preload.ts", "terminal-host.ts", "editor-host.ts", "browser-host.ts", "runtime-host.ts", "recording-host.ts", "recording-files.ts"]) {
      const code = readFileSync(join(electronDir, file), "utf8");
      assert.equal(code.includes("recording:"), false, `${file} carries a recording channel`);
    }
  });

  it("P9.8 proof scope is present and bounded: proof harness, no MP4, no production coupling", () => {
    assert.equal(existsSync(join(electronDir, "recording-proof.ts")), true);
    assert.equal(existsSync(join(electronDir, "recording-proof-helpers.ts")), true);
    const proofCode = readFileSync(join(electronDir, "recording-proof.ts"), "utf8");
    for (const forbidden of ["recording:", "desktopCapturer", "CopyFromScreen", "shell: true", "ipcRenderer"]) {
      assert.equal(proofCode.includes(forbidden), false, `recording-proof.ts contains '${forbidden}'`);
    }
    assert.equal(
      proofCode.includes('from "./main.ts"') || proofCode.includes("from './main.ts'"),
      false,
      "recording-proof.ts must never import production main.ts",
    );
    for (const file of ["recording-host.ts", "recording-files.ts"]) {
      const code = readFileSync(join(electronDir, file), "utf8");
      for (const forbidden of [
        "recording-proof",
        "desktopCapturer",
        "CopyFromScreen",
        "shell: true",
        "Date.now(",
        "renderRoot",
        "quarantine",
      ]) {
        assert.equal(code.includes(forbidden), false, `${file} contains '${forbidden}'`);
      }
    }
  });

  it("recording modules import nothing from Electron (Main-owned, no renderer path)", () => {
    for (const file of ["recording-host.ts", "recording-files.ts"]) {
      const code = readFileSync(join(electronDir, file), "utf8");
      assert.equal(code.includes('from "electron"'), false);
      assert.equal(code.includes("from '../src/"), false);
    }
  });
});

// ---------------------------------------------------------------------------
// P9.6 integration: low-disk abort + bounded shutdown on the real host
// ---------------------------------------------------------------------------

describe("P9.6 lifecycle: low-disk abort and bounded shutdown", () => {
  it("LOW_DISK_ABORT ends the take INCOMPLETE and frees the slot", async () => {
    const world = createWorld();
    await startOk(world);
    const summary = await world.host.abortTake("LOW_DISK_ABORT");
    assert.equal(summary.cause, "LOW_DISK_ABORT");
    assert.equal(summary.outcome, "INCOMPLETE");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.host.getActiveFence(), null);
    assert.equal(world.source.unsubscribeCalls, 1);
  });

  it("LOW_DISK_ABORT can never settle as success", async () => {
    const world = createWorld();
    await startOk(world);
    const pending = world.host.awaitSettlement();
    await world.host.abortTake("LOW_DISK_ABORT");
    await assert.rejects(pending, /take ended/);
    const terminal = world.host.getLastTerminal() as { cause: string; outcome: string };
    assert.equal(terminal.cause, "LOW_DISK_ABORT");
    assert.equal(terminal.outcome, "INCOMPLETE");
  });

  it("source-lost capture refuses the take fail-closed", async () => {
    const world = createWorld({ driverScript: "source-lost" });
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "CAPTURE_SOURCE_LOST");
    assert.equal(world.host.isActive(), false);
  });

  it("duplicate low-disk abort is deterministic (single outcome)", async () => {
    const world = createWorld();
    await startOk(world);
    const first = await world.host.abortTake("LOW_DISK_ABORT");
    const second = await world.host.abortTake("LOW_DISK_ABORT");
    assert.deepEqual(second, first);
    assert.equal(world.source.unsubscribeCalls, 1);
  });

  it("shutdown after low-disk abort stays resolved with no survivors", async () => {
    const world = createWorld();
    await startOk(world);
    await world.host.abortTake("LOW_DISK_ABORT");
    await world.host.shutdownAll("app_close");
    assert.equal(world.host.isActive(), false);
    assert.equal(world.host.getSnapshot(), null);
    assert.equal(world.sessions.length, 1);
    assert.equal(world.sessions[0]!.stats().state, "closed");
  });

  it("no blind resume: shutdown refuses a new take on the old host", async () => {
    const world = createWorld();
    await startOk(world);
    await world.host.shutdownAll("app_close");
    const rejected = await world.startTake();
    assert.equal(rejected.ok, false);
    if (rejected.ok) throw new Error("unreachable");
    assert.equal(rejected.code, "INVALID_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// P9.5 corrective: bundled WGC addon resolution (off-by-one repair)
// ---------------------------------------------------------------------------
// P9.8 discovered that resolveBundledAddonCandidates walked one parent
// level too few from the production dist/main bundle base and constructed
// <repo>/apps/engine/recording/native/... instead of the canonical
// <repo>/engine/recording/native/.... These proofs pin the corrected math
// WITHOUT loading the .node binary: they prove only that the correct
// binary location can be resolved, never Electron compatibility.

describe("P9.5 corrective: bundled addon candidate resolution", () => {
  const PRODUCTION_MAIN_DIR = join(
    repoRootForAddon,
    "apps",
    "teaching-ide",
    "dist",
    "main",
  );
  const CANONICAL_SUFFIX = join(
    "engine",
    "recording",
    "native",
    "wgc",
    "build",
    "Release",
    "wgc_capture.node",
  );
  const EXPECTED_CANDIDATE = join(repoRootForAddon, CANONICAL_SUFFIX);

  it("bundled addon candidate resolves under repo engine (P9.5 corrective)", () => {
    const candidates = resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR);
    assert.deepEqual(candidates, [EXPECTED_CANDIDATE]);
  });

  it("production dist/main resolves the repository root correctly", () => {
    const candidates = resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR);
    assert.equal(candidates.length, 1);
    const candidate = candidates[0]!;
    assert.ok(isAbsolute(candidate), "candidate must be absolute");
    assert.equal(
      resolve(candidate),
      join(repoRootForAddon, "engine", "recording", "native", "wgc", "build", "Release", "wgc_capture.node"),
    );
  });

  it("native candidate is under repo engine and never under repo apps engine", () => {
    const candidate = resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR)[0]!;
    const underEngine = join(repoRootForAddon, "engine", "recording", "native") + sep;
    const forbiddenPrefix = join(repoRootForAddon, "apps", "engine") + sep;
    assert.ok(
      candidate.startsWith(underEngine),
      `candidate must live under repo engine: ${candidate}`,
    );
    assert.equal(
      candidate.startsWith(forbiddenPrefix),
      false,
      `candidate must never live under repo apps engine: ${candidate}`,
    );
    assert.ok(!candidate.includes(`${sep}apps${sep}engine${sep}`));
  });

  it("candidate ordering is unchanged and deterministic", () => {
    const first = resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR);
    const second = resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR);
    assert.equal(first.length, 1);
    assert.deepEqual(second, first);
    assert.deepEqual(first, [EXPECTED_CANDIDATE]);
  });

  it("resolution takes only the Main-owned bundle dir (no renderer input slot)", () => {
    assert.equal(resolveBundledAddonCandidates.length, 1);
  });

  it("resolution has no process.cwd dependency", () => {
    const before = resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR);
    const savedCwd = process.cwd();
    process.chdir(tmpdir());
    try {
      assert.deepEqual(resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR), before);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it("resolution has no environment-variable override", () => {
    const before = resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR);
    const planted = {
      WGC_ADDON_PATH: join(tmpdir(), "evil.node"),
      WGC_CAPTURE_PATH: join(tmpdir(), "evil.node"),
      COURSE_FACTORY_REPO: tmpdir(),
      COURSE_FACTORY_ADDON: join(tmpdir(), "evil.node"),
    } as const;
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(planted)) saved[key] = process.env[key];
    try {
      for (const [key, value] of Object.entries(planted)) process.env[key] = value;
      assert.deepEqual(resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR), before);
    } finally {
      for (const key of Object.keys(planted)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("storage relocation to D does not affect native addon resolution", () => {
    const candidate = resolveBundledAddonCandidates(PRODUCTION_MAIN_DIR)[0]!;
    const configured = JSON.parse(
      readFileSync(join(repoRootForAddon, "config", "recording-paths.json"), "utf8"),
    ) as { recordingTempRoot: string; recordingRenderRoot: string };
    for (const root of [configured.recordingTempRoot, configured.recordingRenderRoot]) {
      assert.ok(typeof root === "string" && root.length > 0);
      assert.equal(candidate.startsWith(resolve(root) + sep), false);
    }
    assert.ok(candidate.startsWith(resolve(repoRootForAddon) + sep));
  });
});

// ---------------------------------------------------------------------------
// P9.5 corrective B: wall-clock CFR duplicate/filler frame-pump policy
// ---------------------------------------------------------------------------
// Deterministic matrix (manual monotonic clock, manual scheduler, fake
// capture source, fake encoder, zero real sleeps). The pump must preserve
// real elapsed recording duration at canonical 30/1 CFR even when WGC
// delivers no new source frame for one or more video frame slots: every
// canonical video slot receives exactly one encoder submission (fresh when
// available, otherwise a repeat of the last valid real frame). Video slot
// authority is the exact P9.4 rational mapping over the trusted recording
// epoch; the 33 ms scheduler is pacing only.

const FILLER_EPOCH_MS = 10_000;
const FILLER_FRAME_BYTES = 1920 * 1080 * 4;

async function flushFiller(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await Promise.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
}

/** Canonical due-slot count for wall time nowMs against a take epoch. */
function fillerDueTarget(epochMs: number, nowMs: number): number {
  return frameIndexForElapsedUs(Math.max(0, (nowMs - epochMs) * 1000)) + 1;
}

function fillerSubmitted(world: World): number {
  return world.encoders[0]!.getStats().accepted_frames;
}

function fillerCaptured(world: World): number {
  return world.sessions[0]!.stats().acceptedFrames;
}

/** Sparse script: `deliveries` fresh frames each followed by an empty poll. */
function sparseFillerScript(deliveries: number, trailingEmpty = 600): FakeScriptStep[] {
  const steps: FakeScriptStep[] = [];
  for (let i = 0; i < deliveries; i++) {
    steps.push({ kind: "frame" }, { kind: "empty" });
  }
  for (let i = 0; i < trailingEmpty; i++) steps.push({ kind: "empty" });
  return steps;
}

function distinctDigestFillerScript(digests: string[]): FakeScriptStep[] {
  const steps: FakeScriptStep[] = digests.map((digest) => ({ kind: "frame", digest }) as FakeScriptStep);
  steps.push({ kind: "empty" });
  for (let i = 0; i < 200; i++) steps.push({ kind: "empty" });
  return steps;
}

/** Recording encoder wrapper: delegates to the canonical fake and records submissions. */
interface RecordingEncoder extends InternalEncoderSession {
  writes: Array<{ frame_seq: number; digest: string | undefined; bytes: Uint8Array }>;
}
function makeRecordingEncoder(inner: FakeEncoderSession): RecordingEncoder {
  const writes: Array<{ frame_seq: number; digest: string | undefined; bytes: Uint8Array }> = [];
  return {
    writes,
    prepare: (target) => inner.prepare(target),
    start: (descriptor) => inner.start(descriptor),
    writeFrame: async (frame: unknown) => {
      const candidate = frame as {
        frame_seq: number;
        content_digest_fnv1a64?: string;
        bytes: Uint8Array;
      };
      const result = await inner.writeFrame(frame);
      if (result.accepted) {
        writes.push({
          frame_seq: candidate.frame_seq,
          digest: candidate.content_digest_fnv1a64,
          // Normalized owned copy so byte comparisons are prototype-stable.
          bytes: Buffer.from(candidate.bytes),
        });
      }
      return result;
    },
    finish: () => inner.finish(),
    abort: (reason) => inner.abort(reason),
    close: () => inner.close(),
    getStats: () => inner.getStats(),
  };
}

describe("P9.5 corrective B: sparse delivery preserves wall-clock CFR duration", () => {
  it("F04 static 5 s golden: sparse deliveries still yield full canonical CFR duration", async () => {
    // Real-world mirror: ~15 native deliveries over a 5 s static window must
    // still produce the canonical ~150 CFR positions (ratio ~= 1.0), never
    // the ~0.1 time-compressed sequence of the new-delivery-only pump.
    const world = createWorld({ customScript: sparseFillerScript(15) });
    const epochMs = world.nowMs;
    await startOk(world);
    assert.equal(fillerSubmitted(world), 1, "readiness occupies slot 0");
    assert.equal(fillerCaptured(world), 1, "one native delivery consumed by readiness");
    for (let step = 1; step <= 50; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerCaptured(world), 15, "sparse source delivered only 15 native frames");
    const target = fillerDueTarget(epochMs, epochMs + 5000);
    assert.equal(target, 151, "frozen helper defines the 5 s slot count");
    const submitted = fillerSubmitted(world);
    assert.equal(submitted, target, `encoder submissions must track wall slots (got ${submitted}, want ${target})`);
    const stats = world.encoders[0]!.getStats();
    assert.equal(stats.last_pts_us, ptsForEncodeIndex(151));
    assert.equal(stats.last_pts_us, 5_000_000);
    const ratio = stats.last_pts_us / 5_000_000;
    assert.ok(Math.abs(ratio - 1) < 1 / 150, `CFR duration must match wall elapsed (ratio=${ratio})`);
    assert.ok(ratio > 0.5, `must not reproduce the ~0.1 compression (ratio=${ratio})`);
    await world.host.shutdownAll("app_close");
  });

  it("F01 fresh frame every slot needs no filler", async () => {
    const world = createWorld({ customScript: sparseFillerScript(40) });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    // 100 ms steps carry 3 due slots each; fresh frames arrive one per tick
    // and filler covers the remaining slots of each step.
    const target = fillerDueTarget(epochMs, epochMs + 1000);
    assert.equal(target, 31);
    assert.equal(fillerSubmitted(world), target);
    assert.equal(fillerCaptured(world), 11, "one native delivery per pump tick plus readiness");
    const telemetry = world.host.getPumpTelemetry();
    assert.equal(telemetry.fillerFrames, fillerSubmitted(world) - fillerCaptured(world));
    await world.host.shutdownAll("app_close");
  });

  it("F02 one real frame then sparse source keeps every CFR slot", async () => {
    const world = createWorld({ customScript: sparseFillerScript(1) });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 20; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerCaptured(world), 1, "source delivered exactly one native frame");
    assert.equal(fillerSubmitted(world), fillerDueTarget(epochMs, epochMs + 2000));
    assert.equal(fillerSubmitted(world), 61);
    const telemetry = world.host.getPumpTelemetry();
    assert.equal(telemetry.fillerFrames, 60);
    assert.equal(telemetry.freshFrames, 1);
    await world.host.shutdownAll("app_close");
  });

  it("F03 static 1 s yields the canonical slot count", async () => {
    const world = createWorld({ customScript: sparseFillerScript(2) });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 31);
    assert.equal(world.encoders[0]!.getStats().last_pts_us, rationalVideoTimeForFrameIndex(30));
    await world.host.shutdownAll("app_close");
  });

  it("F05 static 30 s simulated shows no timing compression", async () => {
    const shared = Buffer.alloc(FILLER_FRAME_BYTES);
    const world = createWorld({
      customScript: sparseFillerScript(8),
      bytesImpl: () => shared,
    });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 300; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    const target = fillerDueTarget(epochMs, epochMs + 30_000);
    assert.equal(target, 901);
    assert.equal(fillerSubmitted(world), target);
    assert.equal(world.encoders[0]!.getStats().last_pts_us, 30_000_000);
    assert.ok(fillerCaptured(world) <= 8, "source stayed sparse");
    await world.host.shutdownAll("app_close");
  });

  it("F06+F39 long simulated duration has no systematic timer drift", async () => {
    const shared = Buffer.alloc(FILLER_FRAME_BYTES);
    const world = createWorld({
      customScript: sparseFillerScript(4),
      bytesImpl: () => shared,
    });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 1_800_000);
    for (let i = 0; i < 7000 && fillerSubmitted(world) < 54_001; i += 1) {
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 54_001, "30 min maps to the exact frozen slot count");
    const stats = world.encoders[0]!.getStats();
    assert.equal(stats.last_pts_us, 1_800_000_000, "30 min video time exact, drift 0");
    assert.equal(stats.last_pts_us, rationalVideoTimeForFrameIndex(54_000));
    assert.equal(stats.last_pts_us, ptsForEncodeIndex(54_001));
    await world.host.shutdownAll("app_close");
  });

  it("F07 scheduler cadence is not timing authority", async () => {
    // Only a handful of irregular pump ticks cover a full 5 s wall interval:
    // submitted slots must still track wall time, never the callback count.
    const world = createWorld({ customScript: sparseFillerScript(6) });
    const epochMs = world.nowMs;
    await startOk(world);
    const advances = [2000, 2000, 1000];
    let now = epochMs;
    for (const advance of advances) {
      now += advance;
      world.setNow(now);
      for (let i = 0; i < 40 && fillerSubmitted(world) < fillerDueTarget(epochMs, now); i += 1) {
        await world.host.pumpOnce();
      }
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 151, "3 wall intervals yield full slots, not 3 frames");
    await world.host.shutdownAll("app_close");
  });

  it("F08 scheduler jitter of several ms still yields correct slots", async () => {
    const world = createWorld({ customScript: sparseFillerScript(10) });
    const epochMs = world.nowMs;
    await startOk(world);
    const advances = [28, 39, 31, 36, 29, 34, 33, 30, 37, 32];
    let now = epochMs;
    for (const advance of advances) {
      now += advance;
      world.setNow(now);
      await world.host.pumpOnce();
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), fillerDueTarget(epochMs, now));
    await world.host.shutdownAll("app_close");
  });

  it("F09 scheduler wakes early with no premature frame slot", async () => {
    const world = createWorld({ customScript: [{ kind: "frame" }, { kind: "empty" }] });
    await startOk(world);
    assert.equal(fillerSubmitted(world), 1);
    // Early wake: no wall advance and no fresh frame -> nothing submitted.
    await world.host.pumpOnce();
    await flushFiller();
    assert.equal(fillerSubmitted(world), 1, "early wake submits no premature slot");
    await world.host.shutdownAll("app_close");
  });

  it("F09b fresh frames wait while no slot is due (held, never lost)", async () => {
    const world = createWorld({
      customScript: [{ kind: "frame" }, { kind: "frame" }, { kind: "frame" }, { kind: "empty" }],
    });
    await startOk(world);
    assert.equal(world.sessions[0]!.pendingCount, 2, "two fresh frames queued behind readiness");
    await world.host.pumpOnce();
    await flushFiller();
    assert.equal(fillerSubmitted(world), 1, "no due slot means no premature submission");
    assert.equal(world.sessions[0]!.pendingCount, 2, "held fresh frames are preserved");
    await world.host.shutdownAll("app_close");
  });

  it("F10 scheduler wakes late with frozen bounded catch-up", async () => {
    const world = createWorld({ customScript: sparseFillerScript(3) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 5000);
    await world.host.pumpOnce();
    await flushFiller();
    const afterOneTick = fillerSubmitted(world);
    assert.ok(afterOneTick <= 1 + 8, `single tick bounded to 8 frames (got ${afterOneTick})`);
    assert.ok(afterOneTick > 1, "late wake makes progress");
    for (let i = 0; i < 40 && fillerSubmitted(world) < 151; i += 1) {
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 151, "bounded catch-up converges to wall slots");
    await world.host.shutdownAll("app_close");
  });

  it("F11 multiple source frames before one slot use newest with truthful drops", async () => {
    const digests = [
      "1111111111111111",
      "2222222222222222",
      "3333333333333333",
      "4444444444444444",
      "5555555555555555",
    ];
    let recording: RecordingEncoder | null = null;
    const world = createWorld({
      customScript: distinctDigestFillerScript(digests),
      wrapEncoder: (inner) => {
        recording = makeRecordingEncoder(inner);
        return recording;
      },
    });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 100);
    await world.host.pumpOnce();
    await flushFiller();
    // Readiness consumed d1; deficit is 3 while 4 fresh contend: newest 3 win.
    assert.equal(fillerSubmitted(world), 4);
    const submittedDigests = recording!.writes.map((w) => w.digest);
    assert.deepEqual(submittedDigests, [digests[0], digests[2], digests[3], digests[4]]);
    const telemetry = world.host.getPumpTelemetry();
    assert.equal(telemetry.discardedFreshFrames, 1, "superseded fresh frame accounted as dropped");
    assert.equal(telemetry.freshFrames, 4);
    await world.host.shutdownAll("app_close");
  });

  it("F12 zero fresh frame for a slot duplicates the last valid frame", async () => {
    let recording: RecordingEncoder | null = null;
    const world = createWorld({
      customScript: sparseFillerScript(2),
      bytesImpl: (frame) => Buffer.alloc(FILLER_FRAME_BYTES, frame.frame_seq & 0xff),
      wrapEncoder: (inner) => {
        recording = makeRecordingEncoder(inner);
        return recording;
      },
    });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 5; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.ok(recording!.writes.length >= 3);
    const lastFresh = recording!.writes[1]!;
    for (const extra of recording!.writes.slice(2)) {
      assert.deepEqual(extra.bytes, lastFresh.bytes, "filler repeats the last valid frame bytes");
      assert.equal(extra.digest, lastFresh.digest, "filler carries the last valid digest");
    }
    await world.host.shutdownAll("app_close");
  });

  it("F13 filler never increments captured", async () => {
    const world = createWorld({ customScript: sparseFillerScript(2) });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerCaptured(world), 2, "captured counts native deliveries only");
    assert.equal(fillerSubmitted(world), 31, "submitted tracks wall slots");
    await world.host.shutdownAll("app_close");
  });

  it("F14 filler increments submitted per canonical accounting", async () => {
    const world = createWorld({ customScript: sparseFillerScript(1) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 1000);
    for (let i = 0; i < 20 && fillerSubmitted(world) < 31; i += 1) {
      await world.host.pumpOnce();
    }
    await flushFiller();
    const stats = world.encoders[0]!.getStats();
    assert.equal(stats.accepted_frames, 31);
    assert.equal(stats.submitted_frames, 31);
    const telemetry = world.host.getPumpTelemetry();
    assert.equal(telemetry.fillerFrames, 30);
    assert.equal(telemetry.freshFrames, 1);
    await world.host.shutdownAll("app_close");
  });

  it("F15 each filler slot is encoded exactly once", async () => {
    const world = createWorld({ customScript: sparseFillerScript(1) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 100);
    await world.host.pumpOnce();
    await flushFiller();
    // Elapsed 100 ms -> slots 0..3 -> exactly 4 submissions, no more.
    assert.equal(fillerSubmitted(world), 4);
    await world.host.pumpOnce();
    await flushFiller();
    assert.equal(fillerSubmitted(world), 4, "no duplicate encoding without wall advance");
    await world.host.shutdownAll("app_close");
  });

  it("F16 first real readiness frame remains first content authority", async () => {
    let recording: RecordingEncoder | null = null;
    const world = createWorld({
      customScript: sparseFillerScript(1),
      bytesImpl: (frame) => Buffer.alloc(FILLER_FRAME_BYTES, frame.frame_seq & 0xff),
      wrapEncoder: (inner) => {
        recording = makeRecordingEncoder(inner);
        return recording;
      },
    });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 5; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    const first = recording!.writes[0]!;
    assert.ok(recording!.writes.length > 1);
    for (const extra of recording!.writes.slice(1)) {
      assert.deepEqual(extra.bytes, first.bytes, "every filler repeats the readiness frame");
    }
    await world.host.shutdownAll("app_close");
  });

  it("F17 no filler before the first real frame", async () => {
    const world = createWorld({ returnBytes: false, customScript: sparseFillerScript(3) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 1000);
    for (let i = 0; i < 10; i += 1) {
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 0, "unreadable first frames never authorize filler");
    assert.equal(world.host.getState(), "RECORDING");
    await world.host.shutdownAll("app_close");
  });
});

describe("P9.5 corrective B: loss, lifecycle, and backpressure fences", () => {
  it("F18 source loss is never hidden by duplication", async () => {
    const world = createWorld({
      customScript: [{ kind: "frame" }, { kind: "empty" }, { kind: "source-lost" }, { kind: "empty" }],
    });
    const epochMs = world.nowMs;
    await startOk(world);
    const settlement = world.host.awaitSettlement();
    world.setNow(epochMs + 500);
    await world.host.pumpOnce();
    await flushFiller();
    await assert.rejects(settlement, /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "CAPTURE_SOURCE_LOST");
    const frozen = fillerSubmitted(world);
    world.setNow(epochMs + 2000);
    await world.host.pumpOnce();
    await flushFiller();
    assert.equal(fillerSubmitted(world), frozen, "no filler after source loss");
  });

  it("F19 geometry loss is never hidden by duplication", async () => {
    const world = createWorld({
      customScript: [
        { kind: "frame" },
        { kind: "empty" },
        { kind: "geometry-changed", width: 1280, height: 720 },
        { kind: "empty" },
      ],
    });
    const epochMs = world.nowMs;
    await startOk(world);
    const settlement = world.host.awaitSettlement();
    world.setNow(epochMs + 500);
    await world.host.pumpOnce();
    await flushFiller();
    await assert.rejects(settlement, /take ended/);
    const cause = (world.host.getLastTerminal() as { cause: string }).cause;
    assert.equal(cause, "CAPTURE_SOURCE_LOST");
  });

  it("F20 window close is never hidden by duplication", async () => {
    const world = createWorld({ customScript: sparseFillerScript(2) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 500);
    await world.host.pumpOnce();
    await flushFiller();
    const before = fillerSubmitted(world);
    assert.ok(before > 1, "slots accrued before close");
    world.host.handleWindowClosed(7);
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "APP_CLOSED");
    world.setNow(epochMs + 2000);
    await world.host.pumpOnce();
    await flushFiller();
    assert.equal(fillerSubmitted(world), before, "no filler after window close");
  });

  it("F21 stop cancels future filler slots", async () => {
    const world = createWorld({ customScript: sparseFillerScript(2) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 500);
    await world.host.pumpOnce();
    await flushFiller();
    await world.host.abortTake("OPERATOR_CANCELLED");
    const frozen = fillerSubmitted(world);
    world.setNow(epochMs + 3000);
    world.scheduler.runAll();
    await world.host.pumpOnce();
    await flushFiller();
    assert.equal(fillerSubmitted(world), frozen, "aborted take submits nothing further");
  });

  it("F22 reset cancels old-generation filler slots", async () => {
    const world = createWorld({ customScript: sparseFillerScript(4) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 500);
    await world.host.pumpOnce();
    await flushFiller();
    const firstEncoderWrites = fillerSubmitted(world);
    assert.ok(firstEncoderWrites > 1);
    world.emitSeq(1, "runtime.reset.started");
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "RESET_INTERRUPTED");
    world.source.binding = {
      runtimeSessionId: RUNTIME_SESSION,
      generation: 2,
      lessonId: LESSON_ID,
      journalHighSeq: 0,
      state: "RUNNING",
    };
    const second = await world.startTake({ generation: 2 });
    assert.equal(second.ok, true, "new generation starts a new take");
    world.scheduler.runAll();
    await flushFiller();
    assert.equal(fillerSubmitted(world) >= firstEncoderWrites, true);
    await world.host.shutdownAll("app_close");
  });

  it("F23 stale old-take scheduler cannot submit to the new take", async () => {
    const world = createWorld({ customScript: sparseFillerScript(6) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 1000);
    for (let i = 0; i < 10 && fillerSubmitted(world) < 31; i += 1) {
      await world.host.pumpOnce();
    }
    await flushFiller();
    const firstTakeWrites = world.encoders[0]!.getStats().accepted_frames;
    assert.equal(firstTakeWrites, 31);
    await world.host.abortTake("OPERATOR_CANCELLED");
    const second = await world.startTake();
    assert.equal(second.ok, true);
    world.scheduler.runAll();
    await flushFiller();
    assert.equal(world.encoders[0]!.getStats().accepted_frames, firstTakeWrites, "old take never advances");
    assert.equal(world.encoders[1]!.getStats().accepted_frames, 1, "new take holds only its readiness slot");
    await world.host.shutdownAll("app_close");
  });

  it("F24 pause continues real-time slots", async () => {
    const world = createWorld({ customScript: sparseFillerScript(2) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.emitSeq(1, "runtime.paused");
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 31, "video time continues while runtime is paused");
    await world.host.shutdownAll("app_close");
  });

  it("F25 resume does not jump or compress video time", async () => {
    const world = createWorld({ customScript: sparseFillerScript(2) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.emitSeq(1, "runtime.paused");
    world.setNow(epochMs + 500);
    await world.host.pumpOnce();
    await world.host.pumpOnce();
    world.emitSeq(2, "runtime.resumed");
    world.setNow(epochMs + 1000);
    for (let i = 0; i < 10 && fillerSubmitted(world) < 31; i += 1) {
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 31, "resume lands exactly on wall slots");
    assert.equal(world.encoders[0]!.getStats().last_pts_us, ptsForEncodeIndex(31));
    await world.host.shutdownAll("app_close");
  });

  it("F26 completion tail preserves CFR duration", async () => {
    const world = createWorld({ customScript: sparseFillerScript(4) });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 31);
    world.emitSeq(1, "runtime.completed", { outcome: "COMPLETED" });
    assert.equal(world.host.getState(), "STOPPING");
    const settlement = world.host.awaitSettlement();
    // The scheduler pump stops at completion; direct tail-mode executions
    // keep the 2 s tail at real-time CFR (fresh when present, filler for
    // the static outro), then the tail timer completes the take.
    for (let step = 11; step <= 30; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 91, "tail slots accrue before completion");
    world.scheduler.runAll();
    const result = await settlement;
    assert.equal(result.outcome, "COMPLETED");
    // 3 s wall elapsed (1 s + 2 s tail) -> 91 canonical slots, all submitted.
    assert.equal(result.encodedFrames, 91);
    assert.equal(result.durationVideoTimeUs, ptsForEncodeIndex(91));
    assert.equal(result.fillerFrames, 91 - fillerCaptured(world));
    await world.host.shutdownAll("app_close").catch(() => undefined);
  });

  it("F27+F28 encoder backpressure stays bounded and queue never exceeds 12", async () => {
    const world = createWorld({ customScript: sparseFillerScript(30) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 5000);
    let maxPerTick = 0;
    for (let i = 0; i < 40 && fillerSubmitted(world) < 151; i += 1) {
      const before = fillerSubmitted(world);
      await world.host.pumpOnce();
      maxPerTick = Math.max(maxPerTick, fillerSubmitted(world) - before);
    }
    await flushFiller();
    assert.ok(maxPerTick <= 8, `per-tick submissions bounded (got ${maxPerTick})`);
    assert.equal(fillerSubmitted(world), 151);
    const stats = world.encoders[0]!.getStats();
    assert.ok(stats.peak_pending_frames <= 12, "encoder queue never exceeds 12");
    await world.host.shutdownAll("app_close");
  });

  it("F29 filler retention is bounded to one frame", async () => {
    const world = createWorld({ customScript: sparseFillerScript(5) });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    const telemetry = world.host.getPumpTelemetry();
    assert.equal(telemetry.retainedFillerBytes, FILLER_FRAME_BYTES, "exactly one retained BGRA frame");
    assert.ok(telemetry.fillerFrames > 0);
    await world.host.shutdownAll("app_close");
  });

  it("F30 filler performs no unbounded byte copies", async () => {
    let readCalls = 0;
    const world = createWorld({
      customScript: sparseFillerScript(2),
      bytesImpl: () => {
        readCalls += 1;
        return Buffer.alloc(FILLER_FRAME_BYTES);
      },
    });
    const epochMs = world.nowMs;
    await startOk(world);
    const readsAfterStart = readCalls;
    assert.equal(readsAfterStart, 1, "readiness reads exactly one frame");
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    // Only the second native delivery is read; all 29 filler slots reuse the
    // single retained copy without touching the byte source again.
    assert.equal(readCalls, 2, `byte source touched only for fresh frames (got ${readCalls})`);
    assert.equal(fillerSubmitted(world), 31);
    await world.host.shutdownAll("app_close");
  });

  it("F31 latest frame lifetime stays valid across filler ticks", async () => {
    let recording: RecordingEncoder | null = null;
    const world = createWorld({
      customScript: sparseFillerScript(2),
      bytesImpl: (frame) => Buffer.alloc(FILLER_FRAME_BYTES, frame.frame_seq & 0xff),
      wrapEncoder: (inner) => {
        recording = makeRecordingEncoder(inner);
        return recording;
      },
    });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.ok(recording!.writes.length >= 31);
    const reference = recording!.writes[1]!.bytes;
    for (const extra of recording!.writes.slice(1)) {
      assert.deepEqual(extra.bytes, reference, "retained bytes never mutate under pending work");
    }
    await world.host.shutdownAll("app_close");
  });

  it("F32 no double encode across readiness and pump", async () => {
    const world = createWorld({ customScript: sparseFillerScript(3) });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 5; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    // Slots 0..15 -> exactly 16 submissions: readiness once + pump fill.
    assert.equal(fillerSubmitted(world), 16);
    const stats = world.encoders[0]!.getStats();
    assert.equal(stats.submitted_frames, stats.accepted_frames);
    await world.host.shutdownAll("app_close");
  });

  it("F33 coalesced real frames are accounted truthfully", async () => {
    const digest = "aaaaaaaaaaaaaaaa";
    const steps: FakeScriptStep[] = [
      { kind: "frame", digest },
      { kind: "frame", digest },
      { kind: "frame", digest },
      { kind: "empty" },
    ];
    for (let i = 0; i < 200; i++) steps.push({ kind: "empty" });
    const world = createWorld({ customScript: steps });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 5; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    const stats = world.encoders[0]!.getStats();
    // Identical consecutive digests (fresh duplicates + filler repeats) are
    // counted coalesced per the frozen P9.3 pacing policy, still written.
    assert.ok(stats.coalesced_frames >= 2, `coalesced counted (got ${stats.coalesced_frames})`);
    assert.equal(fillerSubmitted(world), 16);
    await world.host.shutdownAll("app_close");
  });

  it("F34 dropped frames are accounted truthfully", async () => {
    const digests = [
      "1111111111111111",
      "2222222222222222",
      "3333333333333333",
      "4444444444444444",
      "5555555555555555",
      "6666666666666666",
    ];
    const world = createWorld({ customScript: distinctDigestFillerScript(digests) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 100);
    await world.host.pumpOnce();
    await flushFiller();
    const telemetry = world.host.getPumpTelemetry();
    assert.equal(telemetry.discardedFreshFrames, 2, "two oldest fresh frames superseded");
    const settlement = world.host.awaitSettlement();
    world.emitSeq(1, "runtime.completed", { outcome: "COMPLETED" });
    world.scheduler.runAll();
    const result = await settlement;
    assert.equal(result.droppedFrames, telemetry.discardedFreshFrames, "reported drops include alignment discards");
    await world.host.shutdownAll("app_close").catch(() => undefined);
  });

  it("F35 filler is never classified as captured", async () => {
    const world = createWorld({ customScript: sparseFillerScript(3) });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerCaptured(world), 3);
    assert.equal(fillerSubmitted(world), 31);
    const snapshot = world.host.getSnapshot()!;
    assert.equal(snapshot["captured_frames"], 3);
    assert.equal(snapshot["encoded_frames"], 31);
    await world.host.shutdownAll("app_close");
  });

  it("F36 exact PTS sequence matches the rational helper", async () => {
    const world = createWorld({ customScript: sparseFillerScript(4) });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 10; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
    }
    await flushFiller();
    const stats = world.encoders[0]!.getStats();
    assert.equal(stats.accepted_frames, 31);
    for (const n of [1, 2, 3, 30, 31]) {
      assert.equal(ptsForEncodeIndex(n), rationalVideoTimeForFrameIndex(n - 1), `slot ${n} PTS exact`);
    }
    assert.equal(stats.last_pts_us, ptsForEncodeIndex(31));
    assert.equal(stats.last_pts_us, rationalVideoTimeForFrameIndex(30));
    await world.host.shutdownAll("app_close");
  });

  it("F37+F38 one and ten seconds map to canonical slot counts", async () => {
    assert.equal(frameIndexForElapsedUs(1_000_000), 30);
    assert.equal(frameIndexForElapsedUs(10_000_000), 300);
    const world = createWorld({ customScript: sparseFillerScript(2) });
    const epochMs = world.nowMs;
    await startOk(world);
    world.setNow(epochMs + 10_000);
    for (let i = 0; i < 60 && fillerSubmitted(world) < 301; i += 1) {
      await world.host.pumpOnce();
    }
    await flushFiller();
    assert.equal(fillerSubmitted(world), 301);
    assert.equal(world.encoders[0]!.getStats().last_pts_us, 10_000_000);
    await world.host.shutdownAll("app_close");
  });

  it("F40 zero real sleeps and no timer authority in the pump", async () => {
    const code = readFileSync(join(electronDir, "recording-host.ts"), "utf8");
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const withoutScheduler = stripped.replace(
      /export const realRecordingScheduler[\s\S]*?clearTimeout\(timer as ReturnType<typeof setTimeout>\)/,
      "REAL_SCHEDULER_REMOVED",
    );
    assert.equal(/[^.]setTimeout\s*\(/.test(withoutScheduler), false, "no direct setTimeout outside realRecordingScheduler");
    assert.equal(stripped.includes("setInterval("), false, "no setInterval in RecordingHost");
    assert.equal(stripped.includes("Date.now("), false, "no Date.now media authority in RecordingHost");
    assert.equal(stripped.includes("while (true)"), false, "no busy loop in RecordingHost");
    assert.equal(stripped.includes("Atomics.wait"), false, "no Atomics.wait in RecordingHost");
  });
});
