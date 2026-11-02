// P9.5 CORRECTIVE C — take-level terminal routing + filler accounting.
// Deterministic tests over the REAL RecordingHost + REAL WgcCaptureSession /
// FakeDriver + REAL timeline coordinator + canonical fake encoder. Zero real
// sleeps, zero Electron, zero FFmpeg, zero publication.
//
// Canonical authorities:
//   - P8 event taxonomy: engine/runtime/src/runtime.ts (step commit
//     `runtime.step.completed` + outcome COMPLETED per step; single
//     `runtime.completed` + outcome COMPLETED at end-of-plan) and
//     engine/runtime/src/lifecycle-coordination.ts (runtime.cancelled /
//     reset.* / closing / closed lifecycle events).
//   - P9.1 FrameCounters: engine/recording/src/timeline.ts (dropped /
//     coalesced were captured; encoded bounded by captured + coalesced).
//   - P9.5 filler policy: apps/teaching-ide/electron/recording-host.ts
//     (wall-clock CFR slots, retained-frame repeats, fillerFrames telemetry).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RecordingHost,
  TAIL_FINAL_FILL_CAP,
  type RecordingHostDeps,
  type TrustedRuntimeSource,
} from "../electron/recording-host.ts";
import { WgcCaptureSession } from "../../../engine/recording/src/capture/wgc-session.ts";
import { FakeCaptureDriver, type FakeScriptStep } from "../../../engine/recording/src/capture/fake-driver.ts";
import { TrustedCaptureSourceRegistry } from "../../../engine/recording/src/capture/trusted-source.ts";
import { RecordingTimelineCoordinator } from "../../../engine/recording/src/timeline-coordinator.ts";
import { FakeEncoderSession } from "../../../engine/recording/src/encoder/fake-encoder.ts";
import type { InternalEncoderSession } from "../../../engine/recording/src/encoder/encoder-interface.ts";
import type { EncoderDescriptor } from "../../../engine/recording/src/encoder-profile.ts";
import type { GlobalRuntimeEvent } from "@course-factory/runtime-orchestrator";
import { buildCanonicalManifest, type CanonicalManifestSeed } from "../../../engine/recording/src/manifest.ts";
import { FrameCountersSchema } from "../../../engine/recording/src/timeline.ts";

const here = dirname(fileURLToPath(import.meta.url));

const LESSON_ID = "C01-L001";
const COURSE_ID = "C01";
const RUNTIME_SESSION = "sess-p95c-001";
const SCENE_ID = "C01-L001-S001";
const OWNER_PID = 4242;
const WINDOW_HANDLE = 0xabcd1234n;

const DESCRIPTOR: EncoderDescriptor = {
  family: "LIBX264",
  profile: "libx264-veryfast-crf21",
  profile_version: "1.0",
  fallback_used: false,
  encoder_version: "p95c-test",
};

const STEP_IDS = [
  "C01-L001-S001-B001",
  "C01-L001-S001-B002",
  "C01-L001-S001-B003",
  "C01-L001-S001-B004",
  "C01-L001-S001-B005",
  "C01-L001-S001-B006",
  "C01-L001-S001-B007",
];
const STEP_ENGINES = [
  "terminal",
  "terminal",
  "browser",
  "editor",
  "terminal",
  "browser",
  "terminal",
] as const;

// ---------------------------------------------------------------------------
// Deterministic doubles (P9.5-owned pattern, self-contained)
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

class FakeRuntimeSource implements TrustedRuntimeSource {
  binding = {
    runtimeSessionId: RUNTIME_SESSION,
    generation: 1,
    lessonId: LESSON_ID,
    journalHighSeq: 0,
    state: "RUNNING",
  };
  readonly listeners = new Set<RuntimeListener>();
  readonly ordinals = new Map<string, number>();
  getBinding(): typeof this.binding | null {
    return this.binding === null ? null : { ...this.binding };
  }
  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
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

class MemFiles {
  readonly appended: string[] = [];
  createTakeDir(recordingSessionId: string, takeId: string): string {
    return `mem-temp/recording/${recordingSessionId}/${takeId}`;
  }
  appendAnchorLine(takeDir: string, lineWithLf: string): void {
    this.appended.push(`${takeDir}|${lineWithLf}`);
  }
  removeTakeDir(_takeDir: string): void {
    // Intentionally retained in memory for assertions.
  }
}

interface World {
  readonly host: RecordingHost;
  readonly source: FakeRuntimeSource;
  readonly scheduler: ManualScheduler;
  readonly encoders: FakeEncoderSession[];
  nowMs: number;
  setNow(ms: number): void;
  startTake(): ReturnType<RecordingHost["startTake"]>;
  emitCanonical(event: CanonicalFragment): void;
}

/** Trusted P8 event fragment; the harness stamps seq/time/fence/attempt. */
interface CanonicalFragment {
  readonly scene_id: string;
  readonly step_id: string;
  readonly kind: GlobalRuntimeEvent["kind"];
  readonly engine: GlobalRuntimeEvent["engine"];
  readonly event_type: string;
  readonly outcome?: GlobalRuntimeEvent["outcome"];
  readonly generation?: number;
  readonly runtime_session_id?: string;
}

const liveWorlds: World[] = [];
afterEach(async () => {
  // The P9.2 capture session is process-singleton: every take must release
  // its session even when an assertion fails, or later takes refuse to start.
  while (liveWorlds.length > 0) {
    const world = liveWorlds.pop()!;
    try {
      await world.host.shutdownAll("app_close");
    } catch {
      // Cleanup is best-effort; the test verdict stands.
    }
  }
});

/** Models the real encoder's continuous pipe drain: the deterministic fake
 *  only drains on demand, so without this the single 64-slot tail fill would
 *  queue-drop in the fake while the real EncoderHost drains concurrently. */
class AutoDrainEncoder {
  private readonly inner: FakeEncoderSession;
  constructor(inner: FakeEncoderSession) {
    this.inner = inner;
  }  prepare(target: { tempRoot: string; recordingSessionId: string; takeId: string }) {
    return this.inner.prepare(target);
  }
  start(descriptor: EncoderDescriptor) {
    return this.inner.start(descriptor);
  }
  async writeFrame(frame: unknown) {
    const result = await this.inner.writeFrame(frame);
    this.inner.drainForTest();
    return result;
  }
  finish() {
    return this.inner.finish();
  }
  abort(reason: string) {
    return this.inner.abort(reason);
  }
  close() {
    return this.inner.close();
  }
  getStats() {
    return this.inner.getStats();
  }
}

function createWorld(options: { script?: FakeScriptStep[] } = {}): World {
  const source = new FakeRuntimeSource();  const scheduler = new ManualScheduler();
  const registry = new TrustedCaptureSourceRegistry();
  const encoders: FakeEncoderSession[] = [];
  const worldState = { nowMs: 10_000 };
  let takeCounter = 0;
  const deps: RecordingHostDeps = {
    source,
    window: {
      resolveWindow: () => ({
        windowHandle: WINDOW_HANDLE,
        ownerPid: OWNER_PID,
        width: 1920,
        height: 1080,
        webContentsId: 7,
      }),
      isRecordSafe: () => true,
    },
    allocateIds: () => {
      takeCounter += 1;
      return {
        recordingSessionId: `rec-p95c-${takeCounter}`,
        takeId: `t${String(takeCounter).padStart(2, "0")}`,
      };
    },
    tempRoot: "p95c-test-temp",
    files: new MemFiles(),
    createCaptureSession: ({ fence, takeId }) => {
      const issued = registry.issue({ windowHandle: WINDOW_HANDLE, ownerPid: OWNER_PID });
      const driver = new FakeCaptureDriver(
        options.script !== undefined
          ? { script: [...options.script] }
          : { defaultFrames: 12 },
      );
      return new WgcCaptureSession({
        fence: { ...fence },
        takeId,
        driver,
        registry,
        token: issued.token,
      });
    },
    createEncoderSession: ({ fence, takeId }) => {
      const encoder = new FakeEncoderSession({ fence: { ...fence }, takeId });
      encoders.push(encoder);
      return new AutoDrainEncoder(encoder) as unknown as InternalEncoderSession;
    },
    createTimeline: ({ fence, epoch }) =>
      new RecordingTimelineCoordinator({ fence: { ...fence }, epoch: { ...epoch } }),
    resolveEncoderDescriptor: () => ({ ...DESCRIPTOR }),
    bytesSource: {
      sourceName: "p95c-test-bytes",
      readFrameBytes: (frame) => Buffer.alloc(frame.width * frame.height * 4),
    },
    armByteRetention: () => undefined,
    clock: {
      nowRuntimeMs: () => worldState.nowMs,
    },
    scheduler,
  };
  const host = new RecordingHost(deps);
  let seq = 0;
  const world: World = {
    host,
    source,
    scheduler,
    encoders,
    get nowMs() {
      return worldState.nowMs;
    },
    setNow(ms: number) {
      worldState.nowMs = ms;
    },
    async startTake() {
      return host.startTake({
        lessonId: LESSON_ID,
        runtimeSessionId: RUNTIME_SESSION,
        generation: 1,
      });
    },
    emitCanonical(event) {
      seq += 1;
      const stepId = event.step_id;
      if (!source.ordinals.has(stepId)) {
        source.ordinals.set(stepId, seq);
      }
      const { generation, runtime_session_id, ...rest } = event;
      source.emit({
        global_seq: seq,
        timestamp_ms: worldState.nowMs,
        runtime_session_id: runtime_session_id ?? RUNTIME_SESSION,
        generation: generation ?? 1,
        lesson_id: LESSON_ID,
        attempt_id: `attempt-${seq}`,
        ...rest,
        step_id: stepId,
      });
    },
  };
  liveWorlds.push(world);
  return world;
}

async function startOk(world: World): Promise<void> {
  const started = await world.startTake();
  assert.equal(started.ok, true, "take must start");
}

function stepCompleted(stepIndex: number): CanonicalFragment {
  return {
    scene_id: SCENE_ID,
    step_id: STEP_IDS[stepIndex]!,
    kind: "action",
    engine: STEP_ENGINES[stepIndex],
    event_type: "runtime.step.completed",
    outcome: "COMPLETED",
  };
}

function stepStarted(stepIndex: number): CanonicalFragment {
  return {
    scene_id: SCENE_ID,
    step_id: STEP_IDS[stepIndex]!,
    kind: "action",
    engine: STEP_ENGINES[stepIndex],
    event_type: "runtime.step.started",
  };
}

function runtimeCompleted(): CanonicalFragment {
  return {
    scene_id: SCENE_ID,
    step_id: STEP_IDS[STEP_IDS.length - 1]!,
    kind: "lifecycle",
    engine: "orchestrator",
    event_type: "runtime.completed",
    outcome: "COMPLETED",
  };
}

/** Drains the fake encoder queue to model the real encoder's continuous pipe drain. */
function drainEncoder(world: World): void {
  for (const encoder of world.encoders) {
    encoder.drainForTest();
  }
}

// ---------------------------------------------------------------------------
// PART A — take-level terminal routing
// ---------------------------------------------------------------------------

describe("P9.5-C C1: step COMPLETED never finishes the take", () => {
  it("first canonical step COMPLETED does NOT finish the take", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitCanonical(stepStarted(0));
    assert.equal(world.host.getState(), "RECORDING");
    world.emitCanonical(stepCompleted(0));
    assert.equal(world.host.getState(), "RECORDING", "take must stay RECORDING after step 1 COMPLETED");
    assert.equal(world.host.isActive(), true);
    await world.host.shutdownAll("app_close");
  });

  it("middle step COMPLETED does NOT finish the take", async () => {
    const world = createWorld();
    await startOk(world);
    for (let i = 0; i < 3; i += 1) {
      world.emitCanonical(stepStarted(i));
      world.emitCanonical(stepCompleted(i));
      assert.equal(world.host.getState(), "RECORDING", `take must stay RECORDING after step ${i + 1} COMPLETED`);
    }
    await world.host.shutdownAll("app_close");
  });

  it("final authored step COMPLETED alone does NOT finish the take", async () => {
    const world = createWorld();
    await startOk(world);
    for (let i = 0; i < STEP_IDS.length; i += 1) {
      world.emitCanonical(stepStarted(i));
      world.emitCanonical(stepCompleted(i));
    }
    assert.equal(
      world.host.getState(),
      "RECORDING",
      "final step COMPLETED alone is not the canonical runtime terminal",
    );
    await world.host.shutdownAll("app_close");
  });
});

describe("P9.5-C C1: authoritative runtime COMPLETED finishes the take", () => {
  it("runtime COMPLETED finishes the take and starts exactly one tail", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitCanonical(stepStarted(0));
    world.emitCanonical(stepCompleted(0));
    assert.equal(world.host.getState(), "RECORDING");
    const pendingBefore = world.scheduler.pendingCount;
    assert.equal(pendingBefore, 1, "only the frame pump is scheduled before terminal");
    world.emitCanonical(runtimeCompleted());
    assert.equal(world.host.getState(), "STOPPING", "tail starts only after runtime terminal");
    assert.equal(world.scheduler.pendingCount, 1, "exactly one tail timer is scheduled");
    // Repeated/idempotent terminal events cannot start a second tail.
    world.emitCanonical(runtimeCompleted());
    assert.equal(world.scheduler.pendingCount, 1, "repeated terminal starts no second tail");
    assert.equal(world.host.getState(), "STOPPING");
    const settlement = world.host.awaitSettlement();
    world.scheduler.runAll();
    const result = await settlement;
    assert.equal(result.outcome, "COMPLETED");
    assert.equal(world.host.isActive(), false);
  });

  it("fabricated runtime terminal events never finish the take", async () => {
    const world = createWorld();
    await startOk(world);
    // Wrong kind: step-domain event carrying the runtime name.
    world.emitCanonical({
      scene_id: SCENE_ID,
      step_id: STEP_IDS[0]!,
      kind: "action",
      engine: "orchestrator",
      event_type: "runtime.completed",
      outcome: "COMPLETED",
    });
    assert.equal(world.host.getState(), "RECORDING", "wrong-kind terminal must not finish");
    // Wrong engine: non-orchestrator claimant.
    world.emitCanonical({
      scene_id: SCENE_ID,
      step_id: STEP_IDS[0]!,
      kind: "lifecycle",
      engine: "terminal",
      event_type: "runtime.completed",
      outcome: "COMPLETED",
    });
    assert.equal(world.host.getState(), "RECORDING", "wrong-engine terminal must not finish");
    // Missing outcome: unsigned terminal claim.
    world.emitCanonical({
      scene_id: SCENE_ID,
      step_id: STEP_IDS[0]!,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.completed",
    });
    assert.equal(world.host.getState(), "RECORDING", "outcome-less terminal must not finish");
    // Canonical terminal still finishes afterwards.
    world.emitCanonical(runtimeCompleted());
    assert.equal(world.host.getState(), "STOPPING");
    const settlement = world.host.awaitSettlement();
    world.scheduler.runAll();
    const result = await settlement;
    assert.equal(result.outcome, "COMPLETED");
  });
});

describe("P9.5-C C1: other terminal outcomes and fences preserved", () => {
  it("step FAILED routes DIAGNOSTIC_PARTIAL (frozen P8/P9 contract)", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitCanonical({
      scene_id: SCENE_ID,
      step_id: STEP_IDS[1]!,
      kind: "action",
      engine: "terminal",
      event_type: "runtime.step.failed",
      outcome: "FAILED",
    });
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "DIAGNOSTIC_PARTIAL");
  });

  it("step UNCERTAIN routes DIAGNOSTIC_PARTIAL (HOLD preserved)", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitCanonical({
      scene_id: SCENE_ID,
      step_id: STEP_IDS[1]!,
      kind: "action",
      engine: "browser",
      event_type: "runtime.step.uncertain",
      outcome: "UNCERTAIN",
    });
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "DIAGNOSTIC_PARTIAL");
  });

  it("runtime.cancelled routes OPERATOR_CANCELLED", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitCanonical({
      scene_id: SCENE_ID,
      step_id: STEP_IDS[0]!,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.cancelled",
      outcome: "CANCELLED",
    });
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    const terminal = world.host.getLastTerminal() as { cause: string; outcome: string };
    assert.equal(terminal.cause, "OPERATOR_CANCELLED");
    assert.equal(terminal.outcome, "CANCELLED");
  });

  it("stale old-generation COMPLETED cannot terminate the current take", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitCanonical(stepCompleted(0));
    assert.equal(world.host.getState(), "RECORDING");
    world.emitCanonical({
      scene_id: SCENE_ID,
      step_id: STEP_IDS[0]!,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.completed",
      outcome: "COMPLETED",
      generation: 0,
    });
    assert.equal(world.host.getState(), "RECORDING", "stale generation terminal is fenced");
    world.emitCanonical(runtimeCompleted());
    assert.equal(world.host.getState(), "STOPPING");
    const settlement = world.host.awaitSettlement();
    world.scheduler.runAll();
    assert.equal((await settlement).outcome, "COMPLETED");
  });

  it("stale old-runtime-session COMPLETED cannot terminate the current take", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitCanonical({
      scene_id: SCENE_ID,
      step_id: STEP_IDS[0]!,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.completed",
      outcome: "COMPLETED",
      runtime_session_id: "sess-p95c-stale",
    });
    assert.equal(world.host.getState(), "RECORDING", "stale session terminal is fenced");
    await world.host.shutdownAll("app_close");
  });

  it("reset during the take interrupts; later canonical terminal is fenced", async () => {
    const world = createWorld();
    await startOk(world);
    world.emitCanonical(stepCompleted(0));
    world.emitCanonical({
      scene_id: SCENE_ID,
      step_id: STEP_IDS[1]!,
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.reset.started",
    });
    await assert.rejects(world.host.awaitSettlement(), /take ended/);
    assert.equal((world.host.getLastTerminal() as { cause: string }).cause, "RESET_INTERRUPTED");
  });
});

describe("P9.5-C C1: full 7-step micro-proof (pump, anchors, tail)", () => {
  it("all 7 steps flow without premature stop; pump stays active; anchors cover every step", async () => {
    const world = createWorld();
    const epochMs = world.nowMs;
    await startOk(world);
    // Lesson wall time: ~2.8 s across 7 steps with the CFR pump kept up.
    for (let i = 0; i < STEP_IDS.length; i += 1) {
      world.setNow(epochMs + i * 400);
      world.emitCanonical(stepStarted(i));
      assert.equal(world.host.getState(), "RECORDING", `pump must stay active at step ${i + 1} start`);
      await world.host.pumpOnce();
      drainEncoder(world);
      world.emitCanonical(stepCompleted(i));
      assert.equal(world.host.getState(), "RECORDING", `pump must stay active across step ${i + 1} boundary`);
      await world.host.pumpOnce();
      drainEncoder(world);
    }
    const mid = world.host.getPumpTelemetry();
    assert.equal(mid.active, true, "frame pump remains active across all step boundaries");
    assert.ok(mid.pumpTicks >= 14, `pump kept ticking across steps (got ${mid.pumpTicks})`);
    assert.equal(mid.fillerFrames >= 0, true);
    // Authoritative terminal after the final step transitions cleanly to tail.
    world.setNow(epochMs + 2_800);
    world.emitCanonical(runtimeCompleted());
    assert.equal(world.host.getState(), "STOPPING", "runtime terminal after final step starts the tail");
    // Canonical 2 s tail elapses on the manual scheduler, then the take settles.
    world.setNow(epochMs + 4_800);
    const settlement = world.host.awaitSettlement();
    world.scheduler.runAll();
    const result = await settlement;
    assert.equal(result.outcome, "COMPLETED");
    assert.equal(result.anchorCount, 15, "every step boundary plus terminal is anchored");
    assert.equal(result.firstGlobalSeq, 1);
    assert.equal(result.lastGlobalSeq, 15);
    assert.ok(
      (result.lastVideoTimeUs ?? 0) <= result.durationVideoTimeUs,
      "trusted anchors are covered by full-duration + tail CFR media",
    );
    assert.equal(world.host.isActive(), false);
  });
});

// ---------------------------------------------------------------------------
// PART B — filler / coalesced accounting adjudication
// ---------------------------------------------------------------------------

function manifestFrames11(input: {
  capturedFrames: number;
  encodedFrames: number;
  droppedFrames: number;
  coalescedFrames: number;
  fillerFrames: number;
}): {
  captured_frame_count: number;
  encoded_frame_count: number;
  dropped_frame_count: number;
  coalesced_frame_count: number;
  filler_frame_count: number;
} {
  return {
    captured_frame_count: input.capturedFrames,
    encoded_frame_count: input.encodedFrames,
    dropped_frame_count: input.droppedFrames,
    coalesced_frame_count: input.coalescedFrames,
    filler_frame_count: input.fillerFrames,
  };
}

describe("P9.5-C C2: filler is not coalesced (adjudication)", () => {
  it("sparse take keeps public coalesced within captured while filler is preserved", async () => {
    const script: FakeScriptStep[] = [{ kind: "frame", digest: "aaaaaaaaaaaaaaaa" }];
    for (let i = 0; i < 40; i += 1) script.push({ kind: "empty" });
    script.push({ kind: "frame", digest: "aaaaaaaaaaaaaaaa" });
    for (let i = 0; i < 40; i += 1) script.push({ kind: "empty" });
    script.push({ kind: "frame", digest: "aaaaaaaaaaaaaaaa" });
    for (let i = 0; i < 400; i += 1) script.push({ kind: "empty" });
    const world = createWorld({ script });
    const epochMs = world.nowMs;
    await startOk(world);
    // ~5 s wall with 3 native deliveries: the pump must fill every CFR slot.
    for (let step = 1; step <= 50; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
      drainEncoder(world);
    }
    const tele = world.host.getPumpTelemetry();
    assert.ok(tele.fillerFrames >= 100, `filler covers sparse slots (got ${tele.fillerFrames})`);
    assert.equal(tele.freshFrames, 2, "readiness consumed the first native delivery; pump forwarded the rest");
    world.emitCanonical(runtimeCompleted());
    world.setNow(epochMs + 7_000);
    const settlement = world.host.awaitSettlement();
    world.scheduler.runAll();
    const result = await settlement;
    assert.ok(result.capturedFrames <= 5, `native captured stays small (got ${result.capturedFrames})`);
    assert.ok(result.fillerFrames >= 100, `filler preserved, never decremented (got ${result.fillerFrames})`);
    assert.ok(
      result.coalescedFrames <= result.capturedFrames,
      `public coalesced excludes filler: ${result.coalescedFrames} <= ${result.capturedFrames}`,
    );
    assert.ok(result.encodedFrames >= 100, "output slots remain truthful CFR coverage");
  });

  it("static sparse golden: FrameCounters passes without lying about captured", () => {
    // Native 3, submitted ~150 CFR positions (3 fresh + 147 filler).
    // Under 1.1 truthful counters are:
    // captured 3, encoded 150, filler 147, coalesced 2, dropped 0.
    const truthful11 = {
      captured_frame_count: 3,
      encoded_frame_count: 150,
      dropped_frame_count: 0,
      coalesced_frame_count: 2,
      filler_frame_count: 147,
    };
    assert.equal(
      FrameCountersSchema.safeParse(truthful11).success,
      true,
      "truthful 1.1 counters pass with captured and encoded intact",
    );
    // Old false shape (encoded minus filler projection: 3/3/0/2/147) refuses (filler 147 > encoded 3):
    const oldProjected = {
      captured_frame_count: 3,
      encoded_frame_count: 3,
      dropped_frame_count: 0,
      coalesced_frame_count: 2,
      filler_frame_count: 147,
    };
    assert.equal(
      FrameCountersSchema.safeParse(oldProjected).success,
      false,
      "old projected shape refuses under 1.1 (filler cannot exceed encoded)",
    );
  });

  it("manifest build proof: P9.8-shaped sparse settlement builds a strict P9.1 manifest", () => {
    // Real P9.8 r2/r3 shape: captured 3, encoded 150, filler 147, coalesced 2, dropped 0.
    // Truthful Manifest 1.1 builds without projection; old projected shape refuses.
    const seedBase: CanonicalManifestSeed = {
      recording_session_id: "rec-p95c-golden",
      take_id: "t01",
      lesson_id: LESSON_ID,
      course_id: COURSE_ID,
      runtime_session_id: RUNTIME_SESSION,
      generation: 1,
      encoder: DESCRIPTOR,
      epoch: {
        capture_clock_epoch: "wgc-capture-clock-v1",
        runtime_clock_epoch: "rec-runtime-clock-v1",
        epoch_skew_bound_us: 500,
      },
      recording_start_us: 0,
      recording_end_us: 4_966_666,
      tail_duration_ms: 2_000,
      frames: {
        captured_frame_count: 3,
        encoded_frame_count: 150,
        dropped_frame_count: 0,
        coalesced_frame_count: 2,
        filler_frame_count: 147,
      },
      anchors: {
        anchor_count: 16,
        first_video_time_us: 0,
        last_video_time_us: 4_900_000,
        journal_high_seq_start: 1,
        journal_high_seq_end: 16,
        anchors_sha256: "d".repeat(64),
      },
      publication_status: "PUBLISHED",
      outcome: "COMPLETED",
      terminal_cause: "SUCCESS",
      media_sha256: "c".repeat(64),
      media_size_bytes: 7_200_000,
      media_validation: {
        verdict: "PASS",
        checks: [
          { check: "container_readable", passed: true },
          { check: "codec_h264", passed: true },
          { check: "resolution_1920x1080", passed: true },
          { check: "fps_approx_30", passed: true },
          { check: "duration_within_tolerance", passed: true },
          { check: "nonzero_frames", passed: true },
          { check: "pts_monotonic", passed: true },
          { check: "size_within_ceiling", passed: true },
        ],
      },
      preflight: { free_bytes_at_start: 64_000_000_000, encoder_probe_id: "p95c-probe" },
      app_version: "p95c-test-1.0.0",
    };
    assert.throws(
      () =>
        buildCanonicalManifest({
          ...seedBase,
          frames: {
            captured_frame_count: 3,
            encoded_frame_count: 3,
            dropped_frame_count: 0,
            coalesced_frame_count: 2,
            filler_frame_count: 147,
          },
        }),
      /filler frames cannot exceed encoded frames/,
      "old false projected shape must refuse strict Manifest 1.1 validation",
    );
    const manifest = buildCanonicalManifest(seedBase);
    assert.equal(manifest.frames.captured_frame_count, 3, "captured never inflated");
    assert.equal(manifest.frames.encoded_frame_count, 150, "encoded matches output truth");
    assert.equal(manifest.frames.filler_frame_count, 147, "filler explicit");
    assert.equal(manifest.frames.coalesced_frame_count, 2);
    assert.ok(manifest.anchors.last_video_time_us <= manifest.duration_us);
  });

  it("verbatim settlement of a real sparse settlement builds the manifest 1.1", async () => {
    const script: FakeScriptStep[] = [{ kind: "frame", digest: "bbbbbbbbbbbbbbbb" }];
    for (let i = 0; i < 300; i += 1) script.push({ kind: "empty" });
    script.push({ kind: "frame", digest: "bbbbbbbbbbbbbbbb" });
    for (let i = 0; i < 300; i += 1) script.push({ kind: "empty" });
    const world = createWorld({ script });
    const epochMs = world.nowMs;
    await startOk(world);
    for (let step = 1; step <= 40; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
      drainEncoder(world);
    }
    world.emitCanonical(runtimeCompleted());
    world.setNow(epochMs + 6_000);
    const settlement = world.host.awaitSettlement();
    world.scheduler.runAll();
    const result = await settlement;
    const frames = manifestFrames11(result);
    assert.ok(
      FrameCountersSchema.safeParse(frames).success,
      `verbatim settlement counters pass: ${JSON.stringify(frames)}`,
    );
    assert.equal(frames.captured_frame_count, result.capturedFrames, "captured never inflated");
    assert.equal(frames.encoded_frame_count, result.encodedFrames, "encoded matches output truth");
    assert.equal(frames.filler_frame_count, result.fillerFrames, "filler matches settlement truth");
  });

  it("tail cap audit: the 64-slot cap covers the canonical tail when the pump keeps CFR", async () => {
    assert.equal(TAIL_FINAL_FILL_CAP, 64, "tail cap frozen at 64");
    const world = createWorld();
    const epochMs = world.nowMs;
    await startOk(world);
    // Keep the pump converged so the tail residual is small; the cap then
    // has headroom (64 >= 60 tail slots + margin) and never dominates.
    for (let step = 1; step <= 30; step += 1) {
      world.setNow(epochMs + step * 100);
      await world.host.pumpOnce();
      drainEncoder(world);
    }
    world.emitCanonical(runtimeCompleted());
    const teleAtTerminal = world.host.getPumpTelemetry();
    const dueAtTerminal = teleAtTerminal.dueSlots;
    const submittedAtTerminal = teleAtTerminal.submittedFrames;
    const residual = dueAtTerminal - submittedAtTerminal;
    assert.ok(
      residual <= TAIL_FINAL_FILL_CAP,
      `tail residual ${residual} fits the frozen 64-slot cap (pump kept CFR, cap not dominant)`,
    );
    world.setNow(epochMs + 5_000);
    const settlement = world.host.awaitSettlement();
    world.scheduler.runAll();
    const result = await settlement;
    assert.equal(result.outcome, "COMPLETED");
    assert.ok(result.durationVideoTimeUs >= 4_900_000, "tail keeps real-time CFR duration");
  });
});
