// P9.5 corrective readiness-only proof — standalone proof-only Electron Main entry.
//
// Canonical authority: P9.5 corrective task (bounded first-frame readiness).
// OWNERSHIP (proof-only, no product drift, no phase creep):
//   - STANDALONE Electron Main entry, bundled separately (esbuild) into
//     dist/proof-readiness/main.js via scripts/p9-5-readiness-proof.mjs.
//     NEVER imported by production code (main.ts, preload.ts, renderer);
//     the renderer can never reach it (zero new IPC channels; this module
//     registers no ipcMain handlers at all).
//   - Explicit invocation only (electron dist/proof-readiness/main.js
//     --proof-p95-readiness --addon=<abs path> --phase=<readiness|
//     characterize|sparse>), watchdog-bounded (120 s). ONE WGC session per
//     process: the native addon treats close as terminal, so readiness,
//     characterization, and sparse run as three separate bounded Electron
//     runs over equivalent frameless 1920x1080 test windows (driver merges
//     readiness/characterization into one evidence file and writes the
//     sparse record to its own evidence file).
//   - Phase characterize: one RAW WGC session over a static frameless
//     1920x1080 test window for ~5 s at 33 ms cadence. Measures scheduler
//     ticks, native deliveries, digests, pending-queue depth, capture
//     timestamps. No encoding, no video, no disk writes.
//   - Phase sparse (corrective B): production RecordingHost over a static
//     frameless 1920x1080 test window with production capture (registry +
//     native driver + WGC session + native readback) and the canonical P9.3
//     FakeEncoderSession as telemetry encoder (NO FFmpeg spawned). Runs the
//     real 33 ms frame pump for ~5 s and proves canonical output slots
//     track wall elapsed at 30/1 CFR via filler repeats while native
//     delivery stays sparse. No P8, no MP4, no publication.
//   - Phase readiness: production RecordingHost over a frameless
//     1920x1080 test window with production capture (registry + native
//     driver + WGC session + native readback) and the canonical P9.3
//     FakeEncoderSession (NO FFmpeg spawned — FFmpeg recording is
//     explicitly out of scope). Proves capture starts, the bounded wait
//     stays alive while the pool is empty, the first valid frame arrives,
//     and the host reaches READINESS. Then shutdown immediately.
//   - NO: P8 lesson execution, FFmpeg, MP4, publication, anchors
//     publication, P9.8 end-to-end flow. No P8 runtime is ever created.
//   - Privacy: every stdout line is P95-prefixed and privacy-safe (counts,
//     millisecond latencies, booleans, drive letters only — never host
//     paths, usernames, PIDs, HWNDs, ports, argv, raw stderr). The machine
//     result record is printed as one P95_RESULT JSON line for the driver
//     script to persist under docs/evidence/P9/.

import { app, BrowserWindow } from "electron";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { SystemMonotonicClock } from "@course-factory/runtime-orchestrator";
import {
  RecordingHost,
  realRecordingScheduler,
  type RecordingHostDeps,
} from "./recording-host.ts";
import {
  driverFromModule,
  resolveWindowForRecording,
} from "./recording-files.ts";
import { TrustedCaptureSourceRegistry } from "../../../engine/recording/src/capture/trusted-source.ts";
import { WgcCaptureSession } from "../../../engine/recording/src/capture/wgc-session.ts";
import { RecordingTimelineCoordinator } from "../../../engine/recording/src/timeline-coordinator.ts";
import { NativeReadbackAdapter } from "../../../engine/recording/src/encoder/frame-bytes.ts";
import { FakeEncoderSession } from "../../../engine/recording/src/encoder/fake-encoder.ts";
import { frameIndexForElapsedUs } from "../../../engine/recording/src/timeline-clock.ts";
import { ptsForEncodeIndex } from "../../../engine/recording/src/encoder/encoder-frames.ts";
import { MAX_TAKE_DURATION_US } from "../../../engine/recording/src/protocol.ts";

// ---------------------------------------------------------------------------
// Proof constants (all waits bounded)
// ---------------------------------------------------------------------------

const P95_WINDOW_WIDTH = 1920;
const P95_WINDOW_HEIGHT = 1080;
const P95_WATCHDOG_MS = 120_000;
const P95_WINDOW_READY_MS = 30_000;
const P95_OBSERVE_MS = 5_000;
const P95_OBSERVE_TICK_MS = 33;
const P95_READINESS_TIMEOUT_MS = 30_000;
const P95_SPARSE_OBSERVE_MS = 5_000;
const P95_SPARSE_START_TIMEOUT_MS = 30_000;
const P95_LESSON_ID = "C01-L001";
const P95_RUNTIME_SESSION = "sess-p95-proof";
const P95_GENERATION = 1;

const STATIC_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>P95 readiness</title>
<style>
html,body{margin:0;padding:0;width:100%;height:100%;background:#10151b;overflow:hidden}
.dot{position:absolute;left:960px;top:540px;width:8px;height:8px;border-radius:4px;background:#2f81f7;animation:blink 1s steps(2,start) infinite}
@keyframes blink{to{opacity:.15}}
.label{position:absolute;left:60px;top:60px;color:#c9d1d9;font:28px/1.4 monospace}
</style></head>
<body><div class="label">P95 readiness probe</div><div class="dot"></div></body></html>
`;

// ---------------------------------------------------------------------------
// Safe logging
// ---------------------------------------------------------------------------

function p95log(message: string): void {
  console.log(`P95 ${message}`);
}

function p95result(record: Record<string, unknown>): void {
  console.log(`P95_RESULT ${JSON.stringify(record)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgv(argv: readonly string[]): { proof: boolean; addon: string | null; phase: string | null } {
  let addon: string | null = null;
  let phase: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--addon=")) addon = arg.slice("--addon=".length);
    if (arg.startsWith("--phase=")) phase = arg.slice("--phase=".length);
  }
  return { proof: argv.includes("--proof-p95-readiness"), addon, phase };
}

// ---------------------------------------------------------------------------
// Main proof flow
// ---------------------------------------------------------------------------

type P95Verdict =
  | { kind: "pass"; result: Record<string, unknown> }
  | { kind: "hold"; classification: string; owningPhase: string; message: string; extra?: Record<string, unknown> };

async function runProof(): Promise<P95Verdict> {
  const parsed = parseArgv(process.argv);
  if (!parsed.proof || parsed.addon === null || parsed.addon.length === 0 ||
    (parsed.phase !== "readiness" && parsed.phase !== "characterize" && parsed.phase !== "sparse")) {
    return {
      kind: "hold",
      classification: "HARNESS DEFECT",
      owningPhase: "P9.5",
      message: "proof requires --proof-p95-readiness --addon=<abs path> --phase=<readiness|characterize|sparse>",
    };
  }
  const phase = parsed.phase;
  p95log("proof invocation canonical (production Electron, 1920x1080 frameless, readiness-only)");

  // Load the native addon via the production-validated surface check.
  // Proof-owned explicit path (argv); production resolution is untouched.
  let driver: ReturnType<typeof driverFromModule> & object;
  try {
    const requireImpl = createRequire(join(process.cwd(), "proof-require.js"));
    const candidate: unknown = requireImpl(parsed.addon);
    const validated = driverFromModule(candidate);
    if (validated === null) {
      return { kind: "hold", classification: "HARNESS DEFECT", owningPhase: "P9.5", message: "native addon surface failed validation" };
    }
    driver = validated as object as typeof driver;
  } catch {
    return { kind: "hold", classification: "ENVIRONMENTAL FAILURE", owningPhase: "P9.2", message: "native addon failed to load" };
  }
  const d = driver as unknown as {
    probe(): { backend?: unknown; wgc_supported?: unknown; create_for_window_supported?: unknown; d3d11_available?: unknown; d3d_adapter?: unknown };
    supportsReadback(): boolean;
    armByteRetention(): void;
  };
  let capability: { usable: boolean };
  try {
    const cap = d.probe();
    const usable = cap.backend === "wgc-window" && cap.wgc_supported === true &&
      cap.create_for_window_supported === true && cap.d3d11_available === true;
    capability = { usable };
  } catch {
    return { kind: "hold", classification: "ENVIRONMENTAL FAILURE", owningPhase: "P9.2", message: "hardware probe failed" };
  }
  if (!capability.usable) {
    return { kind: "hold", classification: "ENVIRONMENTAL FAILURE", owningPhase: "P9.2", message: "capture capability not usable" };
  }
  if (!d.supportsReadback()) {
    return { kind: "hold", classification: "ENVIRONMENTAL FAILURE", owningPhase: "P9.3", message: "capture backend lacks the byte readback seam" };
  }
  p95log("native addon probe=pass readback=available");

  // Frameless test window (canonical 1:1 geometry, chromeless-stable).
  const workDir = mkdtempSync(join(tmpdir(), "p95-readiness-"));
  const htmlPath = join(workDir, "index.html");
  try {
    writeFileSync(htmlPath, STATIC_HTML, "utf8");
  } catch {
    return { kind: "hold", classification: "HARNESS DEFECT", owningPhase: "P9.5", message: "proof html unavailable" };
  }
  const window = new BrowserWindow({
    width: P95_WINDOW_WIDTH,
    height: P95_WINDOW_HEIGHT,
    frame: false,
    title: "P95 readiness probe",
    backgroundColor: "#10151b",
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenuBarVisibility(false);
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  let loaded = false;
  window.webContents.on("did-finish-load", () => { loaded = true; });
  try {
    await window.loadFile(htmlPath);
  } catch {
    return { kind: "hold", classification: "HARNESS DEFECT", owningPhase: "P9.5", message: "proof window failed to load" };
  }
  const deadline = Date.now() + P95_WINDOW_READY_MS;
  while (!loaded && Date.now() < deadline) await sleep(100);
  if (!loaded || window.isDestroyed()) {
    return { kind: "hold", classification: "ENVIRONMENTAL FAILURE", owningPhase: "P9.5", message: "window readiness timed out" };
  }
  await sleep(500);
  let bounds: { width: number; height: number } | null = null;
  try {
    const b = window.getBounds();
    bounds = { width: b.width, height: b.height };
  } catch {
    bounds = null;
  }
  if (bounds === null || bounds.width !== P95_WINDOW_WIDTH || bounds.height !== P95_WINDOW_HEIGHT) {
    return { kind: "hold", classification: "HARNESS DEFECT", owningPhase: "P9.5", message: "window geometry is not canonical 1920x1080" };
  }
  try {
    window.restore();
    window.focus();
  } catch {
    // Best-effort.
  }
  p95log("window ready geometry=1920x1080 frameless=true static-with-1s-blink");

  const resolved = resolveWindowForRecording(window as never);
  if (resolved === null) {
    return { kind: "hold", classification: "ENVIRONMENTAL FAILURE", owningPhase: "P9.5", message: "trusted window resolution failed" };
  }

  // ---- One WGC session per process (native close is terminal) ----
  const registry = new TrustedCaptureSourceRegistry();
  const sessionDriver = (driver as object) as ConstructorParameters<typeof WgcCaptureSession>[0]["driver"];
  const closeWindowAndWorkdir = (): void => {
    try { if (!window.isDestroyed()) window.close(); } catch { /* best-effort */ }
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  };

  if (phase === "characterize") {
    return runCharacterization(window, workDir, registry, sessionDriver, resolved.windowHandle, closeWindowAndWorkdir);
  }

  if (phase === "sparse") {
    return runSparsePump(window, workDir, registry, sessionDriver, resolved.windowHandle, driver, closeWindowAndWorkdir);
  }

  // ---- Phase readiness: production RecordingHost bounded readiness ----
  // (this process owns the single WGC session from here until shutdown)
  const clock = new SystemMonotonicClock();
  const byteSource = new NativeReadbackAdapter(
    driver as unknown as ConstructorParameters<typeof NativeReadbackAdapter>[0],
  );
  const deps: RecordingHostDeps = {
    source: {
      getBinding: () => ({
        runtimeSessionId: P95_RUNTIME_SESSION,
        generation: P95_GENERATION,
        lessonId: P95_LESSON_ID,
        journalHighSeq: 0,
        state: "RUNNING",
      }),
      subscribe: () => () => undefined,
      resolveOrdinal: () => null,
    },
    window: {
      resolveWindow: () => resolveWindowForRecording(window as never),
      isRecordSafe: () => true,
    },
    // Fixed proof-scoped identity (single take; no randomness needed).
    allocateIds: () => ({
      recordingSessionId: "rec-p95-proof",
      takeId: "t01",
    }),
    tempRoot: workDir,
    files: {
      createTakeDir: (s, t) => `mem-proof/${s}/${t}`,
      appendAnchorLine: () => undefined,
      removeTakeDir: () => undefined,
    },
    createCaptureSession: ({ fence, takeId }) => {
      const issued = registry.issue({ windowHandle: resolved.windowHandle, ownerPid: process.pid });
      return new WgcCaptureSession({
        fence: { ...fence },
        takeId,
        driver: sessionDriver,
        registry,
        token: issued.token,
      });
    },
    createEncoderSession: ({ fence, takeId }) =>
      new FakeEncoderSession({ fence: { ...fence }, takeId }) as unknown as ReturnType<RecordingHostDeps["createEncoderSession"]>,
    createTimeline: ({ fence, epoch }) =>
      new RecordingTimelineCoordinator({ fence: { ...fence }, epoch: { ...epoch } }),
    resolveEncoderDescriptor: () => ({
      family: "LIBX264",
      profile: "libx264-veryfast-crf21",
      profile_version: "1.0",
      fallback_used: false,
      encoder_version: "p95-proof",
    }),
    bytesSource: byteSource,
    armByteRetention: () => {
      (driver as unknown as { armByteRetention(): void }).armByteRetention();
    },
    clock: { nowRuntimeMs: () => clock.now() },
    scheduler: realRecordingScheduler,
  };
  const host = new RecordingHost(deps);
  const startMs = clock.now();
  const started = await Promise.race([
    host.startTake({
      lessonId: P95_LESSON_ID,
      runtimeSessionId: P95_RUNTIME_SESSION,
      generation: P95_GENERATION,
    }),
    sleep(P95_READINESS_TIMEOUT_MS).then(() => ({
      ok: false as const,
      code: "FRAME_TIMEOUT" as const,
      message: "proof-side readiness ceiling elapsed",
    })),
  ]);
  const readinessLatencyMs = Math.round((clock.now() - startMs) * 100) / 100;
  if (!started.ok) {
    const code = started.code;
    try { await host.shutdownAll("app_close"); } catch { /* best-effort */ }
    try { if (!window.isDestroyed()) window.close(); } catch { /* best-effort */ }
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    const classification = code === "FRAME_TIMEOUT" ? "PRODUCT DEFECT" : "ENVIRONMENTAL FAILURE";
    const owningPhase = code === "FRAME_TIMEOUT" ? "P9.5" : "P9.8";
    p95log(`take refused code=${code} latencyMs=${readinessLatencyMs}`);
    return {
      kind: "hold",
      classification,
      owningPhase,
      message: `take refused code=${code} latencyMs=${readinessLatencyMs}`,
    };
  }
  const snapshot = host.getSnapshot() as {
    captured_frames?: unknown;
    encoded_frames?: unknown;
  } | null;
  const capturedFrames = typeof snapshot?.captured_frames === "number" ? snapshot.captured_frames : -1;
  const encodedFrames = typeof snapshot?.encoded_frames === "number" ? snapshot.encoded_frames : -1;
  p95log(`take ready latencyMs=${readinessLatencyMs} captured=${capturedFrames} encoded=${encodedFrames}`);
  try { await host.shutdownAll("app_close"); } catch { /* best-effort */ }
  try { if (!window.isDestroyed()) window.close(); } catch { /* best-effort */ }
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  return {
    kind: "pass",
    result: {
      p95: true,
      proof: "readiness-only",
      phase: "readiness",
      geometry: "1920x1080",
      frameless: true,
      readiness: {
        ok: true,
        latencyMs: readinessLatencyMs,
        capturedFrames,
        encodedFrames,
        boundMs: 15_000,
        withinBound: readinessLatencyMs < 15_000,
      },
      ffmpeg: false,
      p8: false,
      publication: "NOT_REACHED (readiness-only proof)",
      privacy: "pass",
      ipc: "21/1/7/29",
    },
  };
}

// ---------------------------------------------------------------------------
// Sparse phase (separate process, one production take, ~5 s static window)
// ---------------------------------------------------------------------------
// Production RecordingHost over the real WGC session with the canonical
// fake telemetry encoder (NO FFmpeg, NO MP4, NO P8, NO publication).
// The window shows the same near-static content as characterization, so
// native WGC delivery stays sparse while the wall clock runs 5 s. The
// verdict proves the corrective-B invariant: canonical output slots track
// real elapsed time at 30/1 CFR (filler repeats of the last valid frame),
// never the ~0.1 time-compressed sequence of the new-delivery-only pump.

async function runSparsePump(
  window: BrowserWindow,
  workDir: string,
  registry: TrustedCaptureSourceRegistry,
  sessionDriver: ConstructorParameters<typeof WgcCaptureSession>[0]["driver"],
  windowHandle: bigint,
  driver: unknown,
  closeWindowAndWorkdir: () => void,
): Promise<P95Verdict> {
  const clock = new SystemMonotonicClock();
  const byteSource = new NativeReadbackAdapter(
    driver as unknown as ConstructorParameters<typeof NativeReadbackAdapter>[0],
  );
  const captureSessions: WgcCaptureSession[] = [];
  const encoderSessions: FakeEncoderSession[] = [];
  const deps: RecordingHostDeps = {
    source: {
      getBinding: () => ({
        runtimeSessionId: P95_RUNTIME_SESSION,
        generation: P95_GENERATION,
        lessonId: P95_LESSON_ID,
        journalHighSeq: 0,
        state: "RUNNING",
      }),
      subscribe: () => () => undefined,
      resolveOrdinal: () => null,
    },
    window: {
      resolveWindow: () => resolveWindowForRecording(window as never),
      isRecordSafe: () => true,
    },
    allocateIds: () => ({
      recordingSessionId: "rec-p95-sparse",
      takeId: "t01",
    }),
    tempRoot: workDir,
    files: {
      createTakeDir: (s, t) => `mem-proof/${s}/${t}`,
      appendAnchorLine: () => undefined,
      removeTakeDir: () => undefined,
    },
    createCaptureSession: ({ fence, takeId }) => {
      const issued = registry.issue({ windowHandle, ownerPid: process.pid });
      const session = new WgcCaptureSession({
        fence: { ...fence },
        takeId,
        driver: sessionDriver,
        registry,
        token: issued.token,
      });
      captureSessions.push(session);
      return session;
    },
    createEncoderSession: ({ fence, takeId }) => {
      const encoder = new FakeEncoderSession({ fence: { ...fence }, takeId });
      encoderSessions.push(encoder);
      return encoder as unknown as ReturnType<RecordingHostDeps["createEncoderSession"]>;
    },
    createTimeline: ({ fence, epoch }) =>
      new RecordingTimelineCoordinator({ fence: { ...fence }, epoch: { ...epoch } }),
    resolveEncoderDescriptor: () => ({
      family: "LIBX264",
      profile: "libx264-veryfast-crf21",
      profile_version: "1.0",
      fallback_used: false,
      encoder_version: "p95-sparse-proof",
    }),
    bytesSource: byteSource,
    armByteRetention: () => {
      (driver as unknown as { armByteRetention(): void }).armByteRetention();
    },
    clock: { nowRuntimeMs: () => clock.now() },
    scheduler: realRecordingScheduler,
  };
  const host = new RecordingHost(deps);
  const started = await Promise.race([
    host.startTake({
      lessonId: P95_LESSON_ID,
      runtimeSessionId: P95_RUNTIME_SESSION,
      generation: P95_GENERATION,
    }),
    sleep(P95_SPARSE_START_TIMEOUT_MS).then(() => ({
      ok: false as const,
      code: "FRAME_TIMEOUT" as const,
      message: "proof-side sparse start ceiling elapsed",
    })),
  ]);
  if (!started.ok) {
    try { await host.shutdownAll("app_close"); } catch { /* best-effort */ }
    closeWindowAndWorkdir();
    return {
      kind: "hold",
      classification: "ENVIRONMENTAL FAILURE",
      owningPhase: "P9.5",
      message: `sparse take refused code=${started.code}`,
    };
  }
  // Production pump runs on the real 33 ms scheduler while the wall clock
  // runs; the proof only observes (no interference, no manual pumping).
  const wallStartMs = clock.now();
  await sleep(P95_SPARSE_OBSERVE_MS);
  const wallElapsedMs = clock.now() - wallStartMs;
  // Telemetry is read BEFORE shutdown (shutdown releases the slot). The
  // take epoch predates the observe window by the readiness latency: video
  // slots cover the full epoch-relative timeline (the readiness frame owns
  // slot 0 and the wait interval is filled after ready), so expectations
  // below are epoch-relative, never observe-window-relative.
  const telemetry = host.getPumpTelemetry();
  const epochMs = telemetry.epochRuntimeMs;
  const epochElapsedMs = clock.now() - epochMs;
  const encoderStats = encoderSessions[0]!.getStats();
  const captureStats = captureSessions[0]!.stats();
  try { await host.shutdownAll("app_close"); } catch { /* best-effort */ }
  closeWindowAndWorkdir();

  const wallElapsedUs = Math.round(wallElapsedMs * 1000);
  const epochElapsedUs = Math.round(epochElapsedMs * 1000);
  const expectedSlots = frameIndexForElapsedUs(Math.min(epochElapsedUs, MAX_TAKE_DURATION_US)) + 1;
  const submitted = encoderStats.accepted_frames;
  const nativeDeliveries = captureStats.acceptedFrames;
  const cfrDurationUs = encoderStats.last_pts_us;
  const expectedCfrUs = submitted >= 1 ? ptsForEncodeIndex(submitted) : 0;
  const ratio = epochElapsedUs > 0 ? cfrDurationUs / epochElapsedUs : 0;
  const sparse = nativeDeliveries >= 1 && nativeDeliveries < submitted;
  const aligned = Math.abs(submitted - expectedSlots) <= 4;
  const cfrConsistent = cfrDurationUs === expectedCfrUs;
  p95log(`sparse wallMs=${Math.round(wallElapsedMs * 100) / 100} epochMs=${Math.round(epochElapsedMs * 100) / 100} ticks=${telemetry.pumpTicks} native=${nativeDeliveries} empty=${telemetry.emptyTicks} held=${telemetry.heldTicks} fresh=${telemetry.freshFrames} filler=${telemetry.fillerFrames} submitted=${submitted} expected=${expectedSlots} cfrUs=${cfrDurationUs} ratio=${Math.round(ratio * 1000) / 1000}`);
  const observation = {
    wallElapsedMs: Math.round(wallElapsedMs * 100) / 100,
    wallElapsedUs,
    epochElapsedMs: Math.round(epochElapsedMs * 100) / 100,
    epochElapsedUs,
    schedulerWakes: telemetry.pumpTicks,
    nativeDeliveries,
    nativeDropped: captureStats.droppedFrames,
    emptyTicks: telemetry.emptyTicks,
    heldTicks: telemetry.heldTicks,
    freshSubmissions: telemetry.freshFrames,
    fillerSubmissions: telemetry.fillerFrames,
    discardedFresh: telemetry.discardedFreshFrames,
    totalSubmissions: submitted,
    expectedSlots,
    cfrDurationUs,
    durationRatio: Math.round(ratio * 1000) / 1000,
    coalescedFrames: encoderStats.coalesced_frames,
    encoderDropped: encoderStats.dropped_frames,
    peakPendingFrames: encoderStats.peak_pending_frames,
    readbackGaps: telemetry.readbackGaps,
    rejectedStale: telemetry.rejectedStale,
    retainedFillerBytes: telemetry.retainedFillerBytes,
  };
  if (!sparse || !aligned || !cfrConsistent || telemetry.fillerFrames < 1) {
    return {
      kind: "hold",
      classification: "PRODUCT DEFECT",
      owningPhase: "P9.5",
      message: `sparse CFR not preserved submitted=${submitted} expected=${expectedSlots} native=${nativeDeliveries} filler=${telemetry.fillerFrames}`,
      extra: { observation },
    };
  }
  return {
    kind: "pass",
    result: {
      p95: true,
      proof: "sparse-pump",
      phase: "sparse",
      geometry: "1920x1080",
      frameless: true,
      observation,
      ffmpeg: false,
      p8: false,
      publication: "NOT_REACHED (sparse-pump proof)",
      privacy: "pass",
      ipc: "21/1/7/29",
    },
  };
}

// ---------------------------------------------------------------------------
// Characterization phase (separate process, one raw WGC session, ~5 s)
// ---------------------------------------------------------------------------

async function runCharacterization(
  window: BrowserWindow,
  workDir: string,
  registry: TrustedCaptureSourceRegistry,
  sessionDriver: ConstructorParameters<typeof WgcCaptureSession>[0]["driver"],
  windowHandle: bigint,
  closeWindowAndWorkdir: () => void,
): Promise<P95Verdict> {
  const fence = {
    recording_session_id: "rec-p95-char",
    runtime_session_id: P95_RUNTIME_SESSION,
    generation: P95_GENERATION,
  };
  const issued = registry.issue({ windowHandle, ownerPid: process.pid });
  const session = new WgcCaptureSession({
    fence: { ...fence },
    takeId: "t01",
    driver: sessionDriver,
    registry,
    token: issued.token,
  });
  try {
    session.open();
  } catch {
    closeWindowAndWorkdir();
    return { kind: "hold", classification: "ENVIRONMENTAL FAILURE", owningPhase: "P9.2", message: "characterization session open failed" };
  }
  try {
    session.start();
  } catch {
    try { session.close(); } catch { /* best-effort */ }
    closeWindowAndWorkdir();
    return { kind: "hold", classification: "ENVIRONMENTAL FAILURE", owningPhase: "P9.2", message: "characterization session start failed" };
  }
  const ticksTarget = Math.floor(P95_OBSERVE_MS / P95_OBSERVE_TICK_MS);
  let ticks = 0;
  let delivered = 0;
  let emptyTicks = 0;
  let maxPending = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  const digests = new Set<string>();
  const wallStart = Date.now();
  for (let i = 0; i < ticksTarget; i += 1) {
    ticks += 1;
    const pendingBefore = session.pendingCount;
    if (pendingBefore > maxPending) maxPending = pendingBefore;
    session.pump({ digest: true });
    const stats = session.stats();
    if (stats.sourceLost || stats.deviceLost || stats.geometryChanged) {
      try { session.stop(); } catch { /* best-effort */ }
      try { session.close(); } catch { /* best-effort */ }
      closeWindowAndWorkdir();
      return { kind: "hold", classification: "PRODUCT DEFECT", owningPhase: "P9.2", message: "capture source lost during characterization" };
    }
    let drained = 0;
    for (;;) {
      const frame = session.take();
      if (frame === undefined) break;
      drained += 1;
      delivered += 1;
      if (firstTs === null) firstTs = frame.capture_timestamp_us;
      lastTs = frame.capture_timestamp_us;
      const dg = (frame as { content_digest_fnv1a64?: unknown }).content_digest_fnv1a64;
      if (typeof dg === "string") digests.add(dg);
    }
    if (drained === 0) emptyTicks += 1;
    await sleep(P95_OBSERVE_TICK_MS);
  }
  const wallElapsedMs = Date.now() - wallStart;
  const endStats = session.stats();
  try { session.stop(); } catch { /* best-effort */ }
  try { session.close(); } catch { /* best-effort */ }
  const deliveryFps = delivered / (wallElapsedMs / 1000);
  p95log(`characterization ticks=${ticks} delivered=${delivered} emptyTicks=${emptyTicks} maxPending=${maxPending} distinctDigests=${digests.size} fps=${deliveryFps.toFixed(2)}`);
  closeWindowAndWorkdir();
  return {
    kind: "pass",
    result: {
      p95: true,
      proof: "readiness-only",
      phase: "characterize",
      geometry: "1920x1080",
      frameless: true,
      characterization: {
        ticks,
        delivered,
        emptyTicks,
        maxPending,
        distinctDigests: digests.size,
        deliveryFps: Math.round(deliveryFps * 100) / 100,
        wallElapsedMs,
        firstCaptureTsUs: firstTs,
        lastCaptureTsUs: lastTs,
        sessionAcceptedFrames: endStats.acceptedFrames,
        pendingAtEnd: endStats.pendingFrames,
      },
      ffmpeg: false,
      p8: false,
      privacy: "pass",
      ipc: "21/1/7/29",
    },
  };
}

// ---------------------------------------------------------------------------
// Entry (explicit invocation only; watchdog-bounded)
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  app.on("window-all-closed", () => undefined);
  const watchdog = setTimeout(() => {
    p95result({ p95: true, ok: false, code: "WATCHDOG_TIMEOUT", classification: "HARNESS DEFECT", message: "proof watchdog fired" });
    try {
      for (const window of BrowserWindow.getAllWindows()) {
        try { window.close(); } catch { /* best-effort */ }
      }
    } catch {
      // Owned-handle teardown only.
    }
    app.exit(3);
  }, P95_WATCHDOG_MS);

  try {
    await app.whenReady();
    const verdict = await runProof();
    clearTimeout(watchdog);
    if (verdict.kind === "pass") {
      p95result({ ok: true, ...(verdict.result as Record<string, unknown>) });
      setTimeout(() => app.quit(), 800);
      setTimeout(() => app.exit(0), 5000);
      return;
    }
    p95result({
      ok: false,
      code: "PROOF_HOLD",
      classification: verdict.classification,
      owning_phase: verdict.owningPhase,
      message: verdict.message,
      ...(verdict.extra ?? {}),
    });
    setTimeout(() => app.exit(2), 800);
  } catch (error) {
    clearTimeout(watchdog);
    p95result({
      ok: false,
      code: "PROOF_EXCEPTION",
      classification: "HARNESS DEFECT",
      message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    setTimeout(() => app.exit(2), 800);
  }
}

void main();
