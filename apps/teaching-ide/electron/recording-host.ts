// P9.5 RecordingHost — Electron Main-owned recording orchestrator.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 4-5, 8-9, 16-19 and
// docs/adr/ADR-0014-screen-recording-boundary.md (observation tier below
// execution, window-scoped WGC, shared monotonic time, zero renderer media
// authority).
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module owns orchestration ONLY: transactional take startup,
//     trusted runtime/window binding, bounded frame-pump scheduling,
//     epoch calibration, terminal routing, and ordered shutdown. It never
//     reimplements WGC acquisition, FFmpeg encoding, timeline math, or P8
//     runtime logic — those stay owned by P9.2 / P9.3 / P9.4 / P8.
//   - Electron Main authority. The renderer has zero recording authority:
//     no start/stop channel, no window/encoder/path input, no snapshot push.
//     This module imports nothing from Electron and exposes no IPC.
//   - At most one active take per host, fenced by
//     (recording_session_id, take_id, runtime_session_id, generation).
//     A second start while active fails closed with RECORDER_ALREADY_ACTIVE.
//   - P8 remains execution authority. This host never advances the playhead,
//     never executes steps, never appends P8 journal entries, never mutates
//     global_seq, never resets P8, and never closes P5/P6/P7 domains.
//   - Temp takes only. This host never marks a take PUBLISHED-equivalent and
//     never writes under the final delivery root. End-of-life safety
//     (continuous disk watching, crash recovery, final delivery) is later
//     scope, not here.
//   - Scheduler time paces the pump only. Due video slots derive from the
//     trusted monotonic recording epoch through the exact rational 30/1 CFR
//     mapping (P9.4 helper); per-slot PTS stays encoder-assigned by
//     acceptance order (P9.3 frozen). This module never derives video time
//     from scheduler elapsed or callback counts.
//
// Testability: every boundary is injected (capture/encoder/timeline
// factories, trusted runtime source, window resolver, file sink, clocks,
// scheduler, identity factory). Unit runs are fully deterministic with a
// manual scheduler and scripted fakes; production assembly lives beside the
// Main wiring and uses the real components.

import {
  RECORDING_TAIL_MS,
  MAX_TAKE_DURATION_US,
  sanitizeRecordingMessage,
  toRecordingErrorDto,
  type RecordingErrorCode,
  type TakeFence,
} from "../../../engine/recording/src/protocol.ts";
import { ACQUISITION_STARTUP_TIMEOUT_MS } from "../../../engine/recording/src/disk-budget.ts";
import {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
} from "../../../engine/recording/src/capture/capture-format.ts";
import type { WgcCaptureSession } from "../../../engine/recording/src/capture/wgc-session.ts";
import type {
  RecordingTimelineCoordinator,
  TimelineFence,
} from "../../../engine/recording/src/timeline-coordinator.ts";
import {
  calibrateTimelineEpoch,
  frameIndexForElapsedUs,
  type TimelineEpoch,
} from "../../../engine/recording/src/timeline-clock.ts";
import { serializeAnchorLine } from "../../../engine/recording/src/timeline.ts";
import { RecordingSnapshotDtoSchema } from "../../../engine/recording/src/protocol.ts";
import type { InternalEncoderSession } from "../../../engine/recording/src/encoder/encoder-interface.ts";
import type { EncoderDescriptor } from "../../../engine/recording/src/encoder-profile.ts";
import type { CpuFrameBytesSource } from "../../../engine/recording/src/encoder/frame-bytes.ts";
import type {
  EngineFamily,
  GlobalRuntimeEvent,
} from "@course-factory/runtime-orchestrator";

// ---------------------------------------------------------------------------
// Frozen P9.5 bounds
// ---------------------------------------------------------------------------

/** Canonical take geometry: 1920x1080, 1:1, no scaling. */
export const RECORDING_HOST_WIDTH = CAPTURE_WIDTH;
export const RECORDING_HOST_HEIGHT = CAPTURE_HEIGHT;

/**
 * Frame-pump pacing interval in scheduler milliseconds (30 Hz pull).
 * Pacing only — never video-time authority.
 */
export const FRAME_PUMP_INTERVAL_MS = 33;

/**
 * Upper bound on captured frames forwarded to the encoder per scheduler
 * tick. The P9.2/P9.3 bounded queues stay authoritative; this bound keeps
 * a single tick from starving the event loop under burst drains. Fresh and
 * filler submissions share this per-tick budget jointly.
 */
export const MAX_FRAMES_PER_TICK = 8;

/**
 * Final catch-up bound for completion-time slot fill (tail). Covers the
 * bounded tail interval plus margin; steady-state tail fill is only a
 * couple of slots because the pump keeps submitting during the tail.
 * Completion can never enqueue hundreds of frames after a stall: larger
 * gaps converge over pump ticks before completion instead.
 */
export const TAIL_FINAL_FILL_CAP = 64;

/**
 * Single retained filler frame bound (bytes): one canonical 1080p BGRA
 * frame. The pump retains at most one owned copy of the last valid real
 * frame for duplicate slots; history is never accumulated.
 */
export const RETAINED_FILLER_FRAME_BYTES = CAPTURE_WIDTH * CAPTURE_HEIGHT * 4;

/**
 * Legacy synchronous readiness drain bound (retained for frozen-bounds
 * compatibility; no longer the readiness authority).
 *
 * P9.5 corrective: readiness is now a BOUNDED, cancellable,
 * scheduler-driven first-frame wait honoring READINESS_STARTUP_TIMEOUT_MS
 * (15 s, the frozen acquisition-first-frame bound). The synchronous
 * three-drain policy could never observe a real WGC first present (pool
 * starts empty; first frame arrives on/after a vsync, measured <=100 ms)
 * and is therefore retired as authority. The export stays 3 so frozen
 * bound audits keep passing; production readiness never uses it.
 */
export const READINESS_MAX_PUMPS = 3;

/**
 * Readiness poll cadence in scheduler milliseconds. Reuses the canonical
 * 30 Hz app-driven pump pacing (FRAME_PUMP_INTERVAL_MS): one bounded
 * take() re-check per tick, never a spin, never a magic fast loop.
 * Scheduler time paces only; video time stays encoder-PTS truth.
 */
export const READINESS_POLL_INTERVAL_MS = FRAME_PUMP_INTERVAL_MS;

/**
 * Frozen startup bound for first-frame readiness (15 s, operational
 * monotonic time via the injected clock + scheduler, never video time,
 * never Date.now media authority). Re-exports the single frozen truth
 * from disk-budget (no competing timeout).
 */
export const READINESS_STARTUP_TIMEOUT_MS = ACQUISITION_STARTUP_TIMEOUT_MS;

/**
 * Epoch calibration skew bound (us). The runtime sample (subscribe time)
 * and the capture sample (first readiness frame) are taken back-to-back in
 * one synchronous startup section on same-machine monotonic clocks; the
 * per-anchor mapping error stays independently latched within one frame
 * interval by the coordinator.
 */
export const RECORDING_HOST_SKEW_BOUND_US = 1_000;

/** Opaque epoch identities (well-formed identifiers, never clock values). */
export const RUNTIME_CLOCK_EPOCH_ID = "rec-runtime-clock-v1";

/** Tight BGRA row stride for canonical 1080p (readback bytes are packed). */
export const TIGHT_STRIDE_BYTES_1080P = CAPTURE_WIDTH * 4;

// ---------------------------------------------------------------------------
// Injected boundaries (deterministic-test friendly)
// ---------------------------------------------------------------------------

/** Trusted Main-side P8 runtime binding snapshot (facts only, no handles). */
export interface TrustedRuntimeBinding {
  readonly runtimeSessionId: string;
  readonly generation: number;
  readonly lessonId: string;
  readonly journalHighSeq: number;
  readonly state: string;
}

/**
 * Trusted Main-side runtime event source. Implemented over a live
 * LessonRuntime journal in production (same object identity, Main-side
 * subscription) and over a scripted emitter in tests. Renderer input can
 * never reach this boundary.
 */
export interface TrustedRuntimeSource {
  getBinding(): TrustedRuntimeBinding | null;
  subscribe(listener: (event: GlobalRuntimeEvent) => void): () => void;
  resolveOrdinal(stepId: string): number | null;
}

/** Trusted Main-side window resolution (raw handles never leave Main). */
export interface ResolvedRecordingWindow {
  readonly windowHandle: bigint;
  readonly ownerPid: number;
  readonly width: number;
  readonly height: number;
  readonly webContentsId: number | null;
}

export interface RecordingWindowResolver {
  resolveWindow(): ResolvedRecordingWindow | null;
  isRecordSafe(): boolean;
}

/** Trusted temp take storage (temp class only, never the delivery root). */
export interface TakeFileSink {
  createTakeDir(recordingSessionId: string, takeId: string): string;
  appendAnchorLine(takeDir: string, lineWithLf: string): void;
  removeTakeDir(takeDir: string): void;
}

/** Pacing scheduler (real timers in production, manual in tests). */
export interface RecordingScheduler {
  schedule(fn: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}

export const realRecordingScheduler: RecordingScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

export interface RecordingHostDeps {
  readonly source: TrustedRuntimeSource;
  readonly window: RecordingWindowResolver;
  readonly allocateIds: () => { recordingSessionId: string; takeId: string };
  readonly tempRoot: string;
  readonly files: TakeFileSink;
  readonly createCaptureSession: (input: {
    fence: TakeFence;
    takeId: string;
  }) => WgcCaptureSession;
  readonly createEncoderSession: (input: {
    fence: TakeFence;
    takeId: string;
  }) => InternalEncoderSession;
  readonly createTimeline: (input: {
    fence: TimelineFence;
    epoch: TimelineEpoch;
  }) => RecordingTimelineCoordinator;
  readonly resolveEncoderDescriptor: () => EncoderDescriptor;
  readonly bytesSource: CpuFrameBytesSource;
  readonly armByteRetention: () => void;
  readonly clock: { nowRuntimeMs(): number };
  readonly scheduler: RecordingScheduler;
}

// ---------------------------------------------------------------------------
// Public DTOs (safe fields only)
// ---------------------------------------------------------------------------

export type RecordingHostState = "IDLE" | "RECORDING" | "STOPPING";

export interface TakeHandle {
  readonly recordingSessionId: string;
  readonly takeId: string;
  readonly runtimeSessionId: string;
  readonly generation: number;
  readonly lessonId: string;
}

export type StartTakeResult =
  | { readonly ok: true; readonly take: TakeHandle }
  | { readonly ok: false; readonly code: RecordingErrorCode; readonly message: string };

export interface TempTakeResult {
  readonly recordingSessionId: string;
  readonly takeId: string;
  readonly runtimeSessionId: string;
  readonly generation: number;
  readonly lessonId: string;
  readonly outcome: "COMPLETED";
  readonly encoderFamily: "NVENC" | "LIBX264";
  readonly encoderFallbackUsed: boolean;
  readonly capturedFrames: number;
  readonly encodedFrames: number;
  readonly droppedFrames: number;
  readonly coalescedFrames: number;
  /**
   * Duplicate slots submitted by repeating the last valid real frame
   * (wall-clock CFR filler). A subset of encodedFrames, reported separately
   * so proof evidence can distinguish sparse-source repeats from fresh
   * capture. Never a capture: capturedFrames counts native deliveries only.
   */
  readonly fillerFrames: number;
  readonly mediaFrameCount: number | null;
  readonly readbackGaps: number;
  readonly durationVideoTimeUs: number;
  readonly anchorCount: number;
  readonly firstGlobalSeq: number | null;
  readonly lastGlobalSeq: number | null;
  readonly firstVideoTimeUs: number | null;
  readonly lastVideoTimeUs: number | null;
  readonly anchorsSha256: string;
  readonly mediaDigest: string;
  readonly mediaSizeBytes: number;
  readonly validationVerdict: "PASS";
}

export type AbortCause =
  | "OPERATOR_CANCELLED"
  | "RESET_INTERRUPTED"
  | "CAPTURE_SOURCE_LOST"
  | "LOW_DISK_ABORT"
  | "ENCODER_FAILED"
  | "MEDIA_VALIDATION_FAILED"
  | "APP_CLOSED"
  | "DIAGNOSTIC_PARTIAL"
  | "PREFLIGHT_REFUSED"
  | "STARTUP_TIMEOUT";

export interface AbortSummary {
  readonly recordingSessionId: string;
  readonly takeId: string;
  readonly cause: AbortCause;
  readonly outcome: "CANCELLED" | "RESET_INTERRUPTED" | "FAILED" | "INCOMPLETE";
  readonly anchorsCommitted: number;
  readonly encodedFrames: number;
}

/** Host error carrying a renderer/log-safe DTO (no handles, no paths). */
export class RecordingHostError extends Error {
  readonly dto: ReturnType<typeof toRecordingErrorDto>;
  constructor(code: RecordingErrorCode, message: string) {
    super(`[${code}] ${sanitizeRecordingMessage(message)}`);
    this.name = "RecordingHostError";
    this.dto = toRecordingErrorDto({ code, message, phase: "ACQUISITION" });
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

export interface ForwardableFrame {
  readonly frame_seq: number;
  readonly capture_timestamp_us: number;
  readonly capture_clock_epoch: string;
  readonly width: number;
  readonly height: number;
  readonly stride_bytes: number;
  readonly byte_length: number;
  readonly recording_session_id: string;
  readonly runtime_session_id: string;
  readonly generation: number;
  readonly content_digest_fnv1a64?: string;
}

/**
 * Single retained filler source: the last valid real captured frame,
 * held as one owned byte copy for wall-clock duplicate slots.
 *
 * Provenance stays truthful: capture timestamp, content digest, geometry,
 * and fence identify the real source frame being repeated. The encoder
 * submission sequence number is intentionally NOT retained here: every
 * submission (fresh or filler) consumes the take's nextSubmitSeq nonce so
 * the frozen strictly-increasing encoder ordering holds without ever
 * reusing a capture sequence number.
 */
export interface RetainedFillerFrame {
  readonly capture_timestamp_us: number;
  readonly content_digest_fnv1a64?: string;
  readonly width: number;
  readonly height: number;
  readonly stride_bytes: number;
  readonly bytes: Uint8Array;
  readonly recording_session_id: string;
  readonly runtime_session_id: string;
  readonly generation: number;
}

/** Read-only pump telemetry (proof evidence + deterministic tests). */
export interface PumpTelemetry {
  readonly active: boolean;
  readonly epochRuntimeMs: number;
  readonly pumpTicks: number;
  readonly heldTicks: number;
  readonly emptyTicks: number;
  readonly freshFrames: number;
  readonly fillerFrames: number;
  readonly discardedFreshFrames: number;
  readonly readbackGaps: number;
  readonly rejectedStale: number;
  readonly nextSubmitSeq: number;
  readonly retainedFillerBytes: number;
  readonly submittedFrames: number;
  readonly dueSlots: number;
}

interface ActiveTake {
  readonly takeSeq: number;
  readonly fence: TakeFence;
  readonly takeId: string;
  readonly lessonId: string;
  readonly webContentsId: number | null;
  readonly takeDir: string;
  capture: WgcCaptureSession | null;
  encoder: InternalEncoderSession | null;
  timeline: RecordingTimelineCoordinator | null;
  coordinatorReady: boolean;
  unsubscribe: () => void;
  epochRuntimeMs: number;
  encoderFamily: "NVENC" | "LIBX264";
  encoderFallbackUsed: boolean;
  pumpTimer: unknown | null;
  tailTimer: unknown | null;
  pumpInFlight: boolean;
  finishing: boolean;
  tailClosed: boolean;
  terminal: AbortSummary | null;
  readbackGaps: number;
  rejectedStale: number;
  // -- wall-clock CFR filler (P9.5 corrective B) ---------------------------
  // nextSubmitSeq: encoder-submission ordering nonce (starts at 1). Every
  //   writeFrame (fresh or filler) consumes the next value. This is NOT a
  //   capture sequence number and never increments a capture counter:
  //   capture truth stays in capture stats, capture timestamps, and content
  //   digests (all passed through unmodified). The encoder requires only a
  //   strictly increasing frame_seq for ordering validation; PTS derives
  //   from acceptance order (P9.3 frozen), so the nonce never affects media
  //   timing. In runs without filler the values coincide with capture order.
  // lastFillerSource: single retained last valid real frame (owned byte
  //   copy, bounded to one frame). Null until the first accepted real
  //   frame: filler is never synthesized before first real content.
  // fillerFrames: filler submissions (subset of encoder accepted frames).
  // discardedFreshFrames: fresh frames superseded under newest-wins
  //   contention (reported inside droppedFrames).
  // freshFrames / pumpTicks / heldTicks / emptyTicks: pump accounting.
  nextSubmitSeq: number;
  lastFillerSource: RetainedFillerFrame | null;
  fillerFrames: number;
  discardedFreshFrames: number;
  freshFrames: number;
  pumpTicks: number;
  heldTicks: number;
  emptyTicks: number;
  bufferedEvents: GlobalRuntimeEvent[];
  settlementResolve: ((value: TempTakeResult) => void) | null;
  settlementReject: ((reason: RecordingHostError) => void) | null;
  readonly settled: Promise<TempTakeResult>;
  // -- bounded first-frame readiness (P9.5 corrective) ---------------------
  // While readiness is pending the take lives in `pendingTake` (slot owned,
  // coordinator not yet ready, pump not yet scheduled). The readiness wait
  // is scheduler-driven at READINESS_POLL_INTERVAL_MS until the first valid
  // frame or the operational deadline (epoch + 15 s). Exactly one poll
  // timer exists at a time; it never survives take cleanup (take-seq fenced).
  readinessTimer: unknown | null;
  readinessDeadlineMs: number;
  readinessSettled: boolean;
  readinessResolve: ((frame: ForwardableFrame) => void) | null;
  readinessReject: ((reason: { code: RecordingErrorCode; message: string }) => void) | null;
}

interface ReadinessFailure {
  readonly code: RecordingErrorCode;
  readonly message: string;
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TAKE_ID_RE = /^t\d{2,}$/;
const LESSON_ID_RE = /^C\d{2}-L\d{3}$/;

function failStart(
  code: RecordingErrorCode,
  message: string,
): StartTakeResult {
  return { ok: false, code, message: sanitizeRecordingMessage(message) };
}

function isResetEventType(eventType: string): boolean {
  return eventType === "runtime.reset.started" ||
    eventType === "runtime.reset.browser" ||
    eventType === "runtime.reset.terminal" ||
    eventType === "runtime.reset.workspace" ||
    eventType === "runtime.reset.completed";
}

/**
 * Canonical take-level COMPLETED discriminator (P9.5 Corrective C).
 *
 * Frozen P8 taxonomy (engine/runtime/src/runtime.ts, protocol.ts):
 *   - Every successful step commits `runtime.step.completed` with
 *     `outcome: "COMPLETED"`, `kind` = the step kind (narration/action/
 *     pause) and `engine` = the domain family (terminal/browser/...).
 *   - Only end-of-plan commits `runtime.completed` with
 *     `outcome: "COMPLETED"`, `kind: "lifecycle"`, `engine: "orchestrator"`.
 *
 * Routing take completion on `outcome === "COMPLETED"` alone mistakes each
 * step outcome for runtime completion and stops the frame pump after the
 * first step. The take may finish successfully ONLY on the lifecycle-
 * orchestrator terminal event above (plus the active take fence, enforced
 * by the caller). Step outcomes remain anchors/events only. No step-index,
 * event-name-substring, or sequence-number heuristic is used.
 */
function isCanonicalRuntimeTerminalCompleted(event: GlobalRuntimeEvent): boolean {
  if (event.event_type !== "runtime.completed") return false;
  if (event.kind !== "lifecycle") return false;
  if ((event.engine as string) !== "orchestrator") return false;
  if ((event as { outcome?: unknown }).outcome !== "COMPLETED") return false;
  return true;
}

// ---------------------------------------------------------------------------
// RecordingHost
// ---------------------------------------------------------------------------

export class RecordingHost {
  private readonly deps: RecordingHostDeps;
  private active: ActiveTake | null = null;
  private pendingTake: ActiveTake | null = null;
  private takeSeqCounter = 0;
  private lastTerminal: AbortSummary | TempTakeResult | null = null;
  private shutdownDone = false;

  constructor(deps: RecordingHostDeps) {
    this.deps = deps;
  }

  /** Current host state (IDLE until a take owns the slot, incl. readiness). */
  getState(): RecordingHostState {
    if (this.active !== null) {
      return this.active.finishing ? "STOPPING" : "RECORDING";
    }
    if (this.pendingTake !== null) return "RECORDING";
    return "IDLE";
  }

  /** True while a take owns the single slot (active or readiness-pending). */
  isActive(): boolean {
    return this.active !== null || this.pendingTake !== null;
  }

  /** Active take fence for shutdown/wiring coordination (frozen copy). */
  getActiveFence(): (TakeFence & { take_id: string }) | null {
    if (this.active !== null) {
      return { ...this.active.fence, take_id: this.active.takeId };
    }
    if (this.pendingTake !== null) {
      return { ...this.pendingTake.fence, take_id: this.pendingTake.takeId };
    }
    return null;
  }

  /** Last terminal summary (success result or abort summary), if any. */
  getLastTerminal(): AbortSummary | TempTakeResult | null {
    return this.lastTerminal;
  }

  /**
   * Starts one recording take transactionally. Dependency order:
   * slot -> runtime association -> generation -> window -> record-safe ->
   * geometry -> identity -> temp location -> subscribe -> epoch sample ->
   * encoder -> capture -> retention -> readiness -> coordinator -> pump.
   * Any failure unwinds everything already created: no half-active take.
   */
  async startTake(input: {
    lessonId: string;
    runtimeSessionId: string;
    generation: number;
  }): Promise<StartTakeResult> {
    if (this.shutdownDone) {
      return failStart("INVALID_REQUEST", "recording host is shut down");
    }
    if (this.active !== null || this.pendingTake !== null) {
      return failStart(
        "RECORDER_ALREADY_ACTIVE",
        "another recording take is already active on this workstation",
      );
    }
    if (
      typeof input.lessonId !== "string" || !LESSON_ID_RE.test(input.lessonId) ||
      typeof input.runtimeSessionId !== "string" || !IDENTIFIER_RE.test(input.runtimeSessionId) ||
      !Number.isInteger(input.generation) || input.generation < 1
    ) {
      return failStart("INVALID_REQUEST", "take binding failed trusted validation");
    }

    // Trusted runtime association + generation (Main-side facts only).
    const binding = this.deps.source.getBinding();
    if (binding === null) {
      return failStart("INVALID_REQUEST", "no active runtime session to record");
    }
    if (binding.runtimeSessionId !== input.runtimeSessionId) {
      return failStart("STALE_SESSION", "runtime session does not match the active session");
    }
    if (binding.generation !== input.generation) {
      return failStart("STALE_GENERATION", "generation does not match the active runtime");
    }
    if (binding.lessonId !== input.lessonId) {
      return failStart("INVALID_REQUEST", "lesson does not match the active runtime");
    }

    // Trusted window, record-safe mode, canonical geometry.
    const resolved = this.deps.window.resolveWindow();
    if (resolved === null || resolved.windowHandle <= 0n || resolved.ownerPid <= 0) {
      return failStart("INVALID_IDENTITY", "trusted capture window is unavailable");
    }
    if (!this.deps.window.isRecordSafe()) {
      return failStart("INVALID_REQUEST", "recording requires record-safe presentation mode");
    }
    if (resolved.width !== RECORDING_HOST_WIDTH || resolved.height !== RECORDING_HOST_HEIGHT) {
      return failStart(
        "WINDOW_GEOMETRY_MISMATCH",
        `capture source is ${resolved.width}x${resolved.height}; canonical take requires ${RECORDING_HOST_WIDTH}x${RECORDING_HOST_HEIGHT}`,
      );
    }

    // Recording identity (one coherent fence for capture/encoder/timeline).
    const ids = this.deps.allocateIds();
    if (
      typeof ids.recordingSessionId !== "string" || !IDENTIFIER_RE.test(ids.recordingSessionId) ||
      typeof ids.takeId !== "string" || !TAKE_ID_RE.test(ids.takeId)
    ) {
      return failStart("INVALID_REQUEST", "recording identity failed trusted validation");
    }
    const fence: TakeFence = {
      recording_session_id: ids.recordingSessionId,
      runtime_session_id: input.runtimeSessionId,
      generation: input.generation,
    };

    // Trusted temp take location (temp class only).
    let takeDir: string;
    try {
      takeDir = this.deps.files.createTakeDir(ids.recordingSessionId, ids.takeId);
    } catch {
      return failStart("INVALID_REQUEST", "trusted take storage is unavailable");
    }

    // Subscribe to the trusted runtime source FIRST, then verify the attach
    // boundary: the runtime must not have progressed yet, otherwise earlier
    // anchors would be fabricated — fail closed instead.
    const takeSeq = ++this.takeSeqCounter;
    const take = this.newPendingTake(
      takeSeq,
      fence,
      ids.takeId,
      input.lessonId,
      resolved.webContentsId,
      takeDir,
    );
    try {
      take.unsubscribe = this.deps.source.subscribe((event) => this.onRuntimeEvent(takeSeq, event));
    } catch {
      this.safeRemoveTakeDir(takeDir);
      return failStart("INVALID_REQUEST", "trusted runtime subscription failed");
    }
    const boundary = this.deps.source.getBinding();
    if (
      boundary === null ||
      boundary.runtimeSessionId !== fence.runtime_session_id ||
      boundary.generation !== fence.generation ||
      boundary.journalHighSeq > 0
    ) {
      this.safeUnsubscribe(take.unsubscribe);
      this.safeRemoveTakeDir(takeDir);
      return failStart(
        "INVALID_REQUEST",
        "runtime already progressed beyond the recording attach boundary",
      );
    }
    // Floor to the integer-millisecond P8 domain: the frozen
    // RuntimeMonotonicMs contract is integer-only and the real
    // SystemMonotonicClock returns fractional milliseconds. Flooring here
    // (P9.5-owned sampling, no contract change) keeps the epoch sample in
    // the same domain as authoritative P8 journal timestamps; the 1 ms
    // quantization is far inside the 1,000 us skew bound accounting and
    // the coordinator's independent per-anchor error latch.
    take.epochRuntimeMs = Math.floor(this.deps.clock.nowRuntimeMs());

    // Encoder (real EncoderHost in production; scripted fake in tests).
    take.encoder = this.deps.createEncoderSession({ fence: { ...fence }, takeId: ids.takeId });
    let descriptor: EncoderDescriptor;
    try {
      descriptor = this.deps.resolveEncoderDescriptor();
    } catch {
      await this.unwindStart(take);
      return failStart("ENCODER_START_FAILED", "encoder selection is unavailable");
    }
    take.encoderFamily = descriptor.family;
    take.encoderFallbackUsed = descriptor.fallback_used;
    try {
      await take.encoder.prepare({
        tempRoot: this.deps.tempRoot,
        recordingSessionId: fence.recording_session_id,
        takeId: ids.takeId,
      });
      await take.encoder.start(descriptor);
    } catch {
      await this.unwindStart(take);
      return failStart("ENCODER_START_FAILED", "encoder failed to start");
    }

    // Capture (production WGC; the session owns geometry enforcement).
    take.capture = this.deps.createCaptureSession({ fence: { ...fence }, takeId: ids.takeId });
    try {
      take.capture.open();
      take.capture.start();
    } catch {
      await this.unwindStart(take);
      return failStart("CAPTURE_SOURCE_LOST", "capture source failed to start");
    }
    try {
      this.deps.armByteRetention();
    } catch {
      await this.unwindStart(take);
      return failStart("CAPTURE_SOURCE_LOST", "capture byte retention failed to arm");
    }

    // Readiness: BOUNDED, cancellable, scheduler-driven first-frame wait
    // (P9.5 corrective). The native WGC pool legitimately starts empty;
    // the first present arrives asynchronously on/after a vsync boundary
    // (measured <=100 ms real). The old synchronous three-drain policy
    // observed only microseconds and failed closed with a false
    // FRAME_TIMEOUT before any real frame could arrive.
    //
    // New contract (canonical, frozen 15 s startup bound):
    // - After capture.start(), wait for the FIRST VALID capture frame.
    // - P8 runtime MUST NOT start / lesson MUST NOT progress until this
    //   wait succeeds (startTake stays pending; coordinator not ready;
    //   events buffered, never fabricated).
    // - Poll via the existing 30 Hz pump scheduler abstraction
    //   (READINESS_POLL_INTERVAL_MS): attempt take() -> if valid, ready;
    //   else schedule the next bounded check. Never spin, never block
    //   Electron Main, never synchronous sleep, never a blocking
    //   shared-memory wait.
    // - Deadline is operational monotonic time (injected clock +
    //   scheduler), never video time, never Date.now media authority:
    //   readinessStartMs + 15 s. Timeout -> FRAME_TIMEOUT + unwind.
    // - Terminal capture conditions fail early with source semantics
    //   (CAPTURE_SOURCE_LOST / geometry), never converted to timeout.
    // - Cancellation (shutdown / window close / stop / reset / generation
    //   rotation / rollback) terminates immediately; no readiness timer
    //   survives take cleanup (take-seq fenced).
    // - First-frame ownership policy A (documented): the readiness frame
    //   is CONSUMED via take() and immediately FORWARDED into the
    //   canonical encoder/frame path exactly once. The normal pump never
    //   re-encodes it (queue already drained). No fabrication, no drop,
    //   no double encode, no screenshots/fallback.
    //
    // The slot is claimed as pending BEFORE awaiting so a duplicate start
    // is rejected, runtime events are buffered (not lost), and
    // supersession can fence the wait.
    this.pendingTake = take;
    let first: ForwardableFrame;
    try {
      first = await this.waitForFirstFrame(take);
    } catch (failure) {
      const code = (failure as ReadinessFailure).code ?? "FRAME_TIMEOUT";
      const message = (failure as ReadinessFailure).message ??
        "capture produced no frames during readiness";
      // Cancellation paths (shutdown/window/abort/reset) already unwound
      // and cleared pendingTake before rejecting; only unwind here when
      // the pending slot still holds this take (timeout / source loss).
      if (this.pendingTake === take) {
        this.clearReadinessTimer(take);
        await this.unwindStart(take);
        this.pendingTake = null;
        try {
          take.settlementReject?.(
            new RecordingHostError(code, `readiness failed: ${code}`),
          );
        } catch {
          // Best-effort (catcher attached at create).
        }
      }
      return failStart(code, message);
    }
    // Success path: the wait resolved but a superseding terminal may have
    // cleared or replaced the pending slot (shutdown / reset / abort raced
    // the final poll). Fencing owns correctness: only the still-pending
    // take with the identical take-seq may activate.
    if (this.pendingTake !== take) {
      await this.unwindStart(take);
      return failStart("STALE_GENERATION", "take superseded during readiness");
    }
    this.clearReadinessTimer(take);
    this.pendingTake = null;
    // Re-validate the world before activation: shutdown, runtime rotation,
    // and geometry are fail-closed even after a frame arrived.
    if (this.shutdownDone) {
      await this.unwindStart(take);
      return failStart("INVALID_REQUEST", "recording host shut down during readiness");
    }
    const rotated = this.deps.source.getBinding();
    if (
      rotated === null ||
      rotated.runtimeSessionId !== fence.runtime_session_id ||
      rotated.generation !== fence.generation
    ) {
      await this.unwindStart(take);
      return failStart("STALE_GENERATION", "runtime rotated during readiness");
    }
    const reResolved = this.deps.window.resolveWindow();
    if (reResolved === null || reResolved.windowHandle <= 0n || reResolved.ownerPid <= 0) {
      await this.unwindStart(take);
      return failStart("CAPTURE_SOURCE_LOST", "capture source lost during readiness");
    }
    if (reResolved.width !== RECORDING_HOST_WIDTH || reResolved.height !== RECORDING_HOST_HEIGHT) {
      await this.unwindStart(take);
      return failStart(
        "WINDOW_GEOMETRY_MISMATCH",
        "capture geometry changed during readiness",
      );
    }

    // Epoch calibration (P9.4 helper; no new clock math here) + timeline
    // coordinator over the identical fence.
    try {
      const epoch = calibrateTimelineEpoch({
        runtimeSampleMs: take.epochRuntimeMs,
        captureSampleUs: first.capture_timestamp_us,
        runtimeClockEpoch: RUNTIME_CLOCK_EPOCH_ID,
        captureClockEpoch: first.capture_clock_epoch,
        skewBoundUs: RECORDING_HOST_SKEW_BOUND_US,
      });
      take.timeline = this.deps.createTimeline({
        fence: {
          recording_session_id: fence.recording_session_id,
          take_id: ids.takeId,
          runtime_session_id: fence.runtime_session_id,
          generation: fence.generation,
        },
        epoch,
      });
      take.coordinatorReady = true;
    } catch {
      await this.unwindStart(take);
      return failStart("TIMELINE_INVALID", "timeline epoch calibration failed");
    }

    // Activate: the slot is claimed only now that every dependency holds
    // the identical fence. Forward the readiness frame(s), then schedule.
    // forwardFrame aborts the take itself on failure (single abort owns the
    // terminal); the outer abort below is only a fallback when forwardFrame
    // returned false without latching (avoids a double-abort race with
    // immediate fakes where the inner abort may have already released).
    this.active = take;
    const forwarded = await this.forwardFrame(take, first);
    if (!forwarded) {
      if (take.terminal === null && this.active === take) {
        try {
          await this.abortActiveTake("ENCODER_FAILED");
        } catch {
          // Inner abort already settled the take; the failure below still
          // reports the canonical code.
        }
      }
      return failStart("ENCODER_FAILED", "readiness frame was rejected by the encoder");
    }
    this.drainBufferedEvents(take);
    if (take.terminal !== null) {
      // A buffered terminal event (e.g. reset raced startup) already ended
      // the take during replay; report the terminal cause, not success.
      const cause = take.terminal.cause;
      return failStart(
        cause === "RESET_INTERRUPTED" ? "STALE_GENERATION" : "INVALID_REQUEST",
        "take terminated during startup replay",
      );
    }
    this.schedulePump(take);
    return {
      ok: true,
      take: {
        recordingSessionId: fence.recording_session_id,
        takeId: ids.takeId,
        runtimeSessionId: fence.runtime_session_id,
        generation: fence.generation,
        lessonId: input.lessonId,
      },
    };
  }

  /**
   * Settles when the active (or just-terminal) take completes: resolves
   * with the safe temp take result on normal completion, rejects with a
   * safe host error on abort. Late callers after slot release observe the
   * last terminal outcome instead of hanging.
   */
  awaitSettlement(): Promise<TempTakeResult> {
    if (this.active !== null) {
      return this.active.settled;
    }
    if (this.lastTerminal !== null && "mediaDigest" in this.lastTerminal) {
      return Promise.resolve(this.lastTerminal as TempTakeResult);
    }
    return Promise.reject(
      new RecordingHostError("INVALID_REQUEST", "no recording take to settle"),
    );
  }

  /**
   * Renderer reload has no host entry point by design: reload cannot start,
   * stop, or steer a take. This method exists only so tests and wiring can
   * name the invariant — it performs zero state changes.
   */
  notifyRendererReloaded(): void {
    // Intentionally a no-op: renderer reload carries zero recording authority.
  }

  /** Captured-window destroy: stop scheduling at once, fail the take closed. */
  handleWindowClosed(webContentsId: number): void {
    // Readiness-pending take: terminate the wait immediately (source loss
    // disposition, never a timeout); no timer survives cleanup.
    const pending = this.pendingTake;
    if (pending !== null) {
      if (!this.matchesWindow(pending, webContentsId)) return;
      this.failPendingTake(
        pending,
        "CAPTURE_SOURCE_LOST",
        "capture window closed during readiness",
        "APP_CLOSED",
      );
      return;
    }
    const take = this.active;
    if (take === null) return;
    if (!this.matchesWindow(take, webContentsId)) return;
    // Stop frame scheduling immediately; the abort path below invalidates
    // the capture source on the bounded shutdown seam.
    this.clearPump(take);
    if (take.terminal !== null || take.finishing) return;
    void this.abortActiveTake("APP_CLOSED");
  }

  /**
   * App shutdown barrier entry. P9 cleanup runs BEFORE P8 domain cleanup
   * (the wiring awaits this before RuntimeHost shutdown): stops scheduling,
   * aborts the owned pipeline only, and releases the slot. Never touches
   * P5/P6/P7 domains. Never throws.
   */
  async shutdownAll(_cause = "app_close"): Promise<void> {
    this.shutdownDone = true;
    const pending = this.pendingTake;
    if (pending !== null) {
      this.failPendingTake(
        pending,
        "INVALID_REQUEST",
        "recording host shut down during readiness",
        "APP_CLOSED",
      );
    }
    const take = this.active;
    if (take === null) return;
    try {
      await this.abortActiveTake("APP_CLOSED");
    } catch {
      // Shutdown proceeds; the abort path already released the slot.
    }
  }

  /** Read-only frozen snapshot (safe fields only; null when idle). */
  getSnapshot(): Readonly<Record<string, unknown>> | null {
    const take = this.active;
    if (take === null || take.capture === null || take.encoder === null) {
      return null;
    }
    const captureStats = take.capture.stats();
    const encoderStats = take.encoder.getStats();
    const elapsedUs = Math.min(
      Math.max(0, Math.floor((this.deps.clock.nowRuntimeMs() - take.epochRuntimeMs) * 1000)),
      MAX_TAKE_DURATION_US,
    );
    const candidate = {
      recording_session_id: take.fence.recording_session_id,
      take_id: take.takeId,
      state: take.finishing ? "STOPPING" : "RECORDING",
      runtime_session_id: take.fence.runtime_session_id,
      generation: take.fence.generation,
      elapsed_us: elapsedUs,
      captured_frames: captureStats.acceptedFrames,
      encoded_frames: encoderStats.accepted_frames,
      dropped_frames: captureStats.droppedFrames + encoderStats.dropped_frames,
      filler_frames: take.fillerFrames,
      encoder_family: take.encoderFamily,
      record_safe: true as const,
      last_outcome: null,
    };
    return Object.freeze(RecordingSnapshotDtoSchema.parse(candidate));
  }

  /** Read-only pump telemetry for proof evidence and tests (safe fields only). */
  getPumpTelemetry(): PumpTelemetry {
    const take = this.active;
    if (take === null || take.capture === null || take.encoder === null) {
      return {
        active: false,
        epochRuntimeMs: 0,
        pumpTicks: 0,
        heldTicks: 0,
        emptyTicks: 0,
        freshFrames: 0,
        fillerFrames: 0,
        discardedFreshFrames: 0,
        readbackGaps: 0,
        rejectedStale: 0,
        nextSubmitSeq: 0,
        retainedFillerBytes: 0,
        submittedFrames: 0,
        dueSlots: 0,
      };
    }
    return {
      active: true,
      epochRuntimeMs: take.epochRuntimeMs,
      pumpTicks: take.pumpTicks,
      heldTicks: take.heldTicks,
      emptyTicks: take.emptyTicks,
      freshFrames: take.freshFrames,
      fillerFrames: take.fillerFrames,
      discardedFreshFrames: take.discardedFreshFrames,
      readbackGaps: take.readbackGaps,
      rejectedStale: take.rejectedStale,
      nextSubmitSeq: take.nextSubmitSeq,
      retainedFillerBytes: take.lastFillerSource?.bytes.length ?? 0,
      submittedFrames: take.encoder.getStats().accepted_frames,
      dueSlots: this.dueSlotTarget(take),
    };
  }

  /**
   * Canonical due-slot count: the number of CFR video slots (0-based frame
   * indices 0..N-1) belonging to the recording timeline at the current
   * trusted monotonic reading. Wall-clock authority is the P9.4 frozen
   * floor mapping over the take epoch; the scheduler never contributes.
   */
  private dueSlotTarget(take: ActiveTake): number {
    let nowMs: number;
    try {
      nowMs = this.deps.clock.nowRuntimeMs();
    } catch {
      return take.encoder?.getStats().accepted_frames ?? 0;
    }
    const elapsedUs = Math.min(
      Math.max(0, Math.floor((nowMs - take.epochRuntimeMs) * 1000)),
      MAX_TAKE_DURATION_US,
    );
    return frameIndexForElapsedUs(elapsedUs) + 1;
  }

  // -- trusted runtime ingest (Main-side only) --------------------------------

  private onRuntimeEvent(takeSeq: number, event: GlobalRuntimeEvent): void {
    // Readiness-pending take: buffer authoritative facts (never fabricate,
    // never progress) but abort immediately on generation rotation / reset
    // so a stale take can never activate.
    const pending = this.pendingTake;
    if (pending !== null && pending.takeSeq === takeSeq && pending.readinessSettled === false) {
      if (event.runtime_session_id !== pending.fence.runtime_session_id) {
        return; // Stale session: never mutates the pending take.
      }
      if (event.generation !== pending.fence.generation) {
        if (event.generation > pending.fence.generation || isResetEventType(event.event_type)) {
          this.failPendingTake(
            pending,
            "STALE_GENERATION",
            "runtime rotated during readiness",
            "RESET_INTERRUPTED",
          );
        }
        return;
      }
      if (isResetEventType(event.event_type)) {
        this.failPendingTake(
          pending,
          "STALE_GENERATION",
          "runtime reset during readiness",
          "RESET_INTERRUPTED",
        );
        return;
      }
      pending.bufferedEvents.push(event);
      return;
    }
    // Late event for a previous pending take (take-seq mismatch): never
    // mutates the current take.
    if (pending !== null && takeSeq !== pending.takeSeq && this.active === null) {
      // No active take yet; the event belongs to a superseded pending take.
      // Fall through to the active check below which will drop it.
    }
    const take = this.active;
    if (take === null || take.takeSeq !== takeSeq || take.terminal !== null) {
      return; // Late event for a previous or settled take: never mutates.
    }
    if (!take.coordinatorReady || take.timeline === null) {
      take.bufferedEvents.push(event);
      return;
    }
    this.ingestIntoTake(take, event);
  }

  private drainBufferedEvents(take: ActiveTake): void {
    const buffered = take.bufferedEvents.splice(0, take.bufferedEvents.length);
    for (const event of buffered) {
      if (take.terminal !== null) return;
      this.ingestIntoTake(take, event);
    }
  }

  private ingestIntoTake(take: ActiveTake, event: GlobalRuntimeEvent): void {
    // Generation fence first: forward rotation ends the take, stale late
    // events are ignored without mutating timeline state.
    if (event.runtime_session_id !== take.fence.runtime_session_id) return;
    if (event.generation !== take.fence.generation) {
      if (event.generation > take.fence.generation || isResetEventType(event.event_type)) {
        void this.abortActiveTake("RESET_INTERRUPTED");
      }
      return;
    }
    if (isResetEventType(event.event_type)) {
      this.projectAndAnchor(take, event);
      void this.abortActiveTake("RESET_INTERRUPTED");
      return;
    }
    // Terminal routing by authoritative outcome/type (P8 facts only).
    // COMPLETED is take-terminal ONLY on the canonical lifecycle-
    // orchestrator `runtime.completed` event (isCanonicalRuntimeTerminal-
    // Completed): step-level `runtime.step.completed` outcomes anchor only.
    const outcome = (event as { outcome?: unknown }).outcome;
    if (isCanonicalRuntimeTerminalCompleted(event)) {
      this.projectAndAnchor(take, event);
      void this.finishActiveTake();
      return;
    }
    if (event.event_type === "runtime.cancelled" || outcome === "CANCELLED") {
      this.projectAndAnchor(take, event);
      void this.abortActiveTake("OPERATOR_CANCELLED");
      return;
    }
    if (outcome === "FAILED" || outcome === "UNCERTAIN") {
      this.projectAndAnchor(take, event);
      void this.abortActiveTake("DIAGNOSTIC_PARTIAL");
      return;
    }
    if (event.event_type === "runtime.closed" || event.event_type === "runtime.closing") {
      this.projectAndAnchor(take, event);
      void this.abortActiveTake("APP_CLOSED");
      return;
    }
    this.projectAndAnchor(take, event);
  }

  /** Projects safe P8 journal facts into the P9.4 coordinator (no payload). */
  private projectAndAnchor(take: ActiveTake, event: GlobalRuntimeEvent): void {
    if (take.timeline === null) return;
    const ordinal = this.deps.source.resolveOrdinal(event.step_id);
    if (ordinal === null) return; // Unknown step: never fabricate an anchor.
    const result = take.timeline.ingestRuntimeEvent({
      runtime_session_id: event.runtime_session_id,
      generation: event.generation,
      global_seq: event.global_seq,
      event_type: event.event_type,
      scene_id: event.scene_id,
      step_id: event.step_id,
      global_step_ordinal: ordinal,
      engine: event.engine as EngineFamily,
      timestamp_ms: event.timestamp_ms,
    });
    if (!result.ok) {
      if (result.terminal) {
        // Coordinator latched (reset/interrupted/invalid): end the take on
        // the latched side, never anchor a misleading event.
        if (take.timeline.getStatus() === "RESET_INTERRUPTED") {
          void this.abortActiveTake("RESET_INTERRUPTED");
        } else {
          void this.abortActiveTake("DIAGNOSTIC_PARTIAL");
        }
      }
      return;
    }
    if (!result.duplicate) {
      try {
        this.deps.files.appendAnchorLine(take.takeDir, serializeAnchorLine(result.anchor));
      } catch {
        void this.abortActiveTake("DIAGNOSTIC_PARTIAL");
      }
    }
  }

  // -- bounded first-frame readiness (P9.5 corrective) ------------------------

  /**
   * Bounded, cancellable, scheduler-driven first-frame wait.
   *
   * Operational deadline: readinessStartMs (injected monotonic clock just
   * after capture.start()) + READINESS_STARTUP_TIMEOUT_MS (15 s frozen).
   * Cadence: READINESS_POLL_INTERVAL_MS (30 Hz pump scheduler reuse).
   * Exactly one poll timer at a time; every poll yields via the scheduler
   * (no spin, no block, no sleep, no blocking shared-memory wait).
   * Late callbacks are take-seq fenced and ignored after supersession.
   *
   * Resolves with the FIRST VALID frame (consumed via take(); caller
   * forwards it exactly once into the encoder path — policy A).
   * Rejects with FRAME_TIMEOUT at the deadline or CAPTURE_SOURCE_LOST /
   * geometry on terminal capture conditions (never converts source loss
   * into a timeout). Cancellation rejects with the mapped start code and
   * unwinds; no timer survives cleanup.
   */
  private waitForFirstFrame(take: ActiveTake): Promise<ForwardableFrame> {
    // Operational start: sample the injected monotonic clock now (just
    // after capture.start() + retention arm). The deadline never exceeds
    // start + 15 s by construction.
    const startMs = this.deps.clock.nowRuntimeMs();
    take.readinessDeadlineMs = startMs + READINESS_STARTUP_TIMEOUT_MS;
    take.readinessSettled = false;
    return new Promise<ForwardableFrame>((resolve, reject) => {
      take.readinessResolve = resolve;
      take.readinessReject = reject;
      // Immediate bounded attempt preserves the fast path when a frame is
      // already queued (e.g. synthetic drivers): no timer needed.
      // When empty, fall through to the scheduler-driven polls below.
      const immediate = this.tryReadinessAttempt(take);
      if (immediate.status === "frame") {
        this.settleReadinessSuccess(take, immediate.frame);
        return;
      }
      if (immediate.status === "source-lost") {
        this.settleReadinessFailure(take, "CAPTURE_SOURCE_LOST", immediate.message);
        return;
      }
      if (immediate.status === "geometry") {
        this.settleReadinessFailure(take, immediate.geometryCode, immediate.message);
        return;
      }
      // Empty: schedule the first bounded re-check. The deadline is
      // enforced on every poll via the injected clock (see readinessPoll);
      // a separate timeout timer would double the bound and break manual-
      // scheduler determinism, so the single poll chain owns both frame
      // observation and deadline enforcement.
      this.scheduleReadinessPoll(take);
    });
  }

  private scheduleReadinessPoll(take: ActiveTake): void {
    if (take.readinessSettled) return;
    if (this.pendingTake !== take) return;
    this.clearReadinessTimer(take);
    take.readinessTimer = this.deps.scheduler.schedule(() => {
      take.readinessTimer = null;
      this.readinessPoll(take.takeSeq);
    }, READINESS_POLL_INTERVAL_MS);
  }

  private clearReadinessTimer(take: ActiveTake): void {
    if (take.readinessTimer !== null) {
      try {
        this.deps.scheduler.cancel(take.readinessTimer);
      } catch {
        // Timer release is best-effort; take-seq fencing owns correctness.
      }
      take.readinessTimer = null;
    }
  }

  /**
   * One bounded readiness poll (scheduler-driven). Deadline is checked
   * FIRST so timeout wins deterministically at now >= deadline even if a
   * frame happens to be queued on that tick (exactly-one-winner race).
   * Source loss / geometry fail early with source semantics.
   */
  private readinessPoll(takeSeq: number): void {
    const take = this.pendingTake;
    if (take === null || take.takeSeq !== takeSeq) return;
    if (take.readinessSettled) return;
    if (take.capture === null) {
      this.settleReadinessFailure(take, "CAPTURE_SOURCE_LOST", "capture missing during readiness");
      return;
    }
    // Operational deadline (injected monotonic clock, never video time).
    let nowMs: number;
    try {
      nowMs = this.deps.clock.nowRuntimeMs();
    } catch {
      this.settleReadinessFailure(take, "FRAME_TIMEOUT", "readiness clock failed");
      return;
    }
    if (nowMs >= take.readinessDeadlineMs) {
      this.settleReadinessFailure(take, "FRAME_TIMEOUT", "capture produced no frames during readiness");
      return;
    }
    const attempt = this.tryReadinessAttempt(take);
    if (attempt.status === "frame") {
      this.settleReadinessSuccess(take, attempt.frame);
      return;
    }
    if (attempt.status === "source-lost") {
      this.settleReadinessFailure(take, "CAPTURE_SOURCE_LOST", attempt.message);
      return;
    }
    if (attempt.status === "geometry") {
      this.settleReadinessFailure(take, attempt.geometryCode, attempt.message);
      return;
    }
    // Empty and still inside the bound: schedule the next bounded check.
    this.scheduleReadinessPoll(take);
  }

  private tryReadinessAttempt(take: ActiveTake):
    | { readonly status: "frame"; readonly frame: ForwardableFrame }
    | { readonly status: "empty" }
    | { readonly status: "source-lost"; readonly message: string }
    | { readonly status: "geometry"; readonly geometryCode: RecordingErrorCode; readonly message: string } {
    const capture = take.capture;
    if (capture === null) {
      return { status: "source-lost", message: "capture missing during readiness" };
    }
    try {
      capture.pump({ digest: true });
    } catch {
      return { status: "source-lost", message: "capture pump failed during readiness" };
    }
    let stats: ReturnType<WgcCaptureSession["stats"]>;
    try {
      stats = capture.stats();
    } catch {
      return { status: "source-lost", message: "capture stats failed during readiness" };
    }
    // Terminal capture conditions fail early with source semantics — never
    // converted into FRAME_TIMEOUT, never waited to the deadline.
    if (stats.sourceLost || stats.deviceLost) {
      return { status: "source-lost", message: "capture source lost during readiness" };
    }
    if (stats.geometryChanged) {
      return {
        status: "geometry",
        geometryCode: "CAPTURE_SOURCE_LOST",
        message: "capture geometry changed during readiness",
      };
    }
    let peeked: ForwardableFrame | undefined;
    try {
      peeked = capture.take() as ForwardableFrame | undefined;
    } catch {
      return { status: "source-lost", message: "capture take failed during readiness" };
    }
    if (peeked !== undefined) {
      // Validate the candidate minimally (canonical geometry + fence):
      // a corrupt first frame must not prove readiness.
      if (peeked.width !== RECORDING_HOST_WIDTH || peeked.height !== RECORDING_HOST_HEIGHT) {
        return {
          status: "geometry",
          geometryCode: "WINDOW_GEOMETRY_MISMATCH",
          message: "first frame geometry is not canonical",
        };
      }
      if (
        peeked.recording_session_id !== take.fence.recording_session_id ||
        peeked.runtime_session_id !== take.fence.runtime_session_id ||
        peeked.generation !== take.fence.generation
      ) {
        // Stale-fenced frame during readiness: ignore this tick (do not
        // prove readiness) and re-poll inside the bound.
        return { status: "empty" };
      }
      return { status: "frame", frame: peeked };
    }
    return { status: "empty" };
  }

  private settleReadinessSuccess(take: ActiveTake, frame: ForwardableFrame): void {
    if (take.readinessSettled) return;
    if (this.pendingTake !== take) return;
    take.readinessSettled = true;
    this.clearReadinessTimer(take);
    take.readinessResolve?.(frame);
    take.readinessResolve = null;
    take.readinessReject = null;
  }

  private settleReadinessFailure(
    take: ActiveTake,
    code: RecordingErrorCode,
    message: string,
  ): void {
    if (take.readinessSettled) return;
    // Mark settled synchronously so re-entrant polls/events are fenced.
    // Resource unwind + slot clear belong to the startTake catcher (single
    // unwind, no double-release); this only rejects the wait.
    take.readinessSettled = true;
    this.clearReadinessTimer(take);
    const reject = take.readinessReject;
    take.readinessResolve = null;
    take.readinessReject = null;
    reject?.({ code, message });
  }

  /**
   * Fails a readiness-pending take from a superseding path (shutdown,
   * window close, explicit stop, reset/generation). Records the canonical
   * abort summary (for getLastTerminal / duplicate-abort determinism),
   * unwinds phase-owned resources, clears the slot, and rejects the
   * pending startTake with the mapped start code. No timer survives.
   * Late callbacks from the old take-seq are fenced and ignored.
   */
  private failPendingTake(
    take: ActiveTake,
    startCode: RecordingErrorCode,
    startMessage: string,
    abortCause: AbortCause,
  ): AbortSummary {
    if (this.pendingTake !== take) {
      // Already settled (timeout raced supersession): report the last
      // terminal deterministically instead of double-settling.
      if (this.lastTerminal !== null && !("mediaDigest" in this.lastTerminal)) {
        return this.lastTerminal as AbortSummary;
      }
      const fallback: AbortSummary = {
        recordingSessionId: take.fence.recording_session_id,
        takeId: take.takeId,
        cause: abortCause,
        outcome: abortCause === "OPERATOR_CANCELLED"
          ? "CANCELLED"
          : abortCause === "RESET_INTERRUPTED"
            ? "RESET_INTERRUPTED"
            : abortCause === "PREFLIGHT_REFUSED" || abortCause === "STARTUP_TIMEOUT" || abortCause === "APP_CLOSED" || abortCause === "LOW_DISK_ABORT"
              ? "INCOMPLETE"
              : "FAILED",
        anchorsCommitted: 0,
        encodedFrames: 0,
      };
      return fallback;
    }
    take.readinessSettled = true;
    this.clearReadinessTimer(take);
    const summary: AbortSummary = {
      recordingSessionId: take.fence.recording_session_id,
      takeId: take.takeId,
      cause: abortCause,
      outcome: abortCause === "OPERATOR_CANCELLED"
        ? "CANCELLED"
        : abortCause === "RESET_INTERRUPTED"
          ? "RESET_INTERRUPTED"
          : abortCause === "PREFLIGHT_REFUSED" || abortCause === "STARTUP_TIMEOUT" || abortCause === "APP_CLOSED" || abortCause === "LOW_DISK_ABORT"
            ? "INCOMPLETE"
            : "FAILED",
      anchorsCommitted: 0,
      encodedFrames: take.encoder?.getStats().accepted_frames ?? 0,
    };
    // Clear the slot synchronously so no further poll, event, or start can
    // advance the old take after this point.
    this.pendingTake = null;
    const reject = take.readinessReject;
    take.readinessResolve = null;
    take.readinessReject = null;
    void (async () => {
      try {
        await this.unwindStart(take);
      } catch {
        // Best-effort.
      }
      this.lastTerminal = summary;
      try {
        take.settlementReject?.(
          new RecordingHostError(startCode, `readiness failed: ${startCode}`),
        );
      } catch {
        // Best-effort.
      }
      reject?.({ code: startCode, message: startMessage });
    })();
    // Set lastTerminal synchronously for deterministic duplicate-abort
    // reads (abortTake during readiness returns this summary).
    this.lastTerminal = summary;
    return summary;
  }

  // -- bounded frame pump (wall-clock CFR slots + filler) --------------------

  private schedulePump(take: ActiveTake): void {
    if (take.terminal !== null || take.finishing) return;
    this.clearPump(take);
    take.pumpTimer = this.deps.scheduler.schedule(() => {
      take.pumpTimer = null;
      void this.pumpTick(take.takeSeq);
    }, FRAME_PUMP_INTERVAL_MS);
  }

  private clearPump(take: ActiveTake): void {
    if (take.pumpTimer !== null) {
      try {
        this.deps.scheduler.cancel(take.pumpTimer);
      } catch {
        // Timer release is best-effort; the take-seq fence owns correctness.
      }
      take.pumpTimer = null;
    }
  }

  private async pumpTick(takeSeq: number): Promise<void> {
    const take = this.active;
    if (take === null || take.takeSeq !== takeSeq) return;
    if (take.terminal !== null || take.finishing || take.pumpInFlight) return;
    take.pumpInFlight = true;
    try {
      await this.pumpOnce(take);
    } finally {
      take.pumpInFlight = false;
    }
    if (this.active === take && take.terminal === null && !take.finishing) {
      this.schedulePump(take);
    }
  }

  /**
   * One bounded pump execution: drains the WGC pool, then satisfies the
   * canonical due video slots from the trusted wall clock (P9.4 frozen
   * floor mapping over the take epoch). Fresh frames are forwarded first;
   * remaining due slots repeat the last valid real frame (filler). Returns
   * the submitted count for this execution.
   *
   * Three truths stay separate: CAPTURE DELIVERY (native frames observed),
   * VIDEO FRAME SLOT (canonical due positions from wall time), ENCODER
   * SUBMISSION (one per satisfied slot). Sparse delivery never implies
   * sparse slots: the pump fills every due slot exactly once.
   *
   * During the completion tail the scheduler pump is stopped (as before);
   * direct pump executions still satisfy due slots in tail mode so tests
   * and wiring can keep the tail at real-time CFR before completion fills
   * any residual slots.
   */
  async pumpOnce(take?: ActiveTake): Promise<number> {
    const owned = take ?? this.active;
    if (owned === null || owned.capture === null || owned.encoder === null) return 0;
    if (owned.terminal !== null || owned.tailClosed) return 0;
    const tailMode = owned.finishing;
    owned.pumpTicks += 1;
    owned.capture.pump({ digest: true });
    return this.fillDueSlots(owned, MAX_FRAMES_PER_TICK, !tailMode);
  }

  /**
   * Satisfies due video slots up to maxFrames submissions. Fresh deliveries
   * win every contested slot (newest first); the remainder repeats the
   * last valid real frame. When no slot is due, fresh frames stay held in
   * the bounded capture queue (never premature slots, never lost content).
   * Late wakes converge over ticks (bounded per-tick catch-up, never a
   * hundreds-frame burst). With terminalChecks, source loss or geometry
   * drift aborts fail-closed before any submission; the completion tail
   * skips those checks because terminal routing is already decided.
   */
  private async fillDueSlots(take: ActiveTake, maxFrames: number, terminalChecks: boolean): Promise<number> {
    if (take.capture === null || take.encoder === null) return 0;
    if (terminalChecks) {
      const stats = take.capture.stats();
      if (stats.sourceLost || stats.deviceLost) {
        void this.abortActiveTake("CAPTURE_SOURCE_LOST");
        return 0;
      }
      if (stats.geometryChanged) {
        // Geometry drift invalidates the canonical take; the success path
        // must not silently continue at a new size.
        void this.abortActiveTake("CAPTURE_SOURCE_LOST");
        return 0;
      }
    }
    const target = this.dueSlotTarget(take);
    const submittedAtEntry = take.encoder.getStats().accepted_frames;
    if (target - submittedAtEntry <= 0) {
      // No canonical slot due yet: hold fresh frames in the bounded capture
      // queue (overflow drops there stay capture-accounted). The native
      // drain above already ran, so loss detection stays live.
      take.heldTicks += 1;
      return 0;
    }
    const deficit = target - submittedAtEntry;
    // Drain fresh deliveries (bounded by this fill's submission budget; the
    // capture queue itself stays the authoritative bound). Every drained
    // frame is resolved inside this fill: forwarded, superseded, or skipped
    // with honest accounting. Fills never run concurrently (the scheduler
    // pump stops at completion and completion fills once), so capture
    // observation order always matches drain order.
    const batch: ForwardableFrame[] = [];
    for (let i = 0; i < maxFrames; i += 1) {
      const frame = take.capture.take();
      if (frame === undefined) break;
      batch.push(frame);
    }
    if (batch.length === 0) {
      take.emptyTicks += 1;
    }
    // Newest-wins contention: when more fresh frames arrived than due slots,
    // the newest `deficit` frames occupy the slots and the older ones are
    // superseded (counted as dropped: oldest unencoded frames yielded for
    // wall alignment, never silently lost).
    const freshBudget = Math.min(batch.length, deficit);
    const superseded = batch.length - freshBudget;
    if (superseded > 0) {
      take.discardedFreshFrames += superseded;
    }
    let forwarded = 0;
    for (const frame of batch.slice(superseded)) {
      let ok: boolean;
      try {
        ok = await this.forwardFrame(take, frame);
      } catch {
        // Terminal race (e.g. release closed the encoder mid-fill): stop
        // quietly; the abort path already owns the take outcome.
        return forwarded;
      }
      if (!ok) return forwarded;
      forwarded += 1;
      if (forwarded >= maxFrames) return forwarded;
    }
    // Filler covers the remaining due slots by repeating the last valid
    // real frame. Before the first accepted real frame there is no filler
    // source, so nothing is synthesized (readiness contract preserved).
    while (forwarded < maxFrames && take.lastFillerSource !== null) {
      const submitted = take.encoder === null
        ? target
        : take.encoder.getStats().accepted_frames;
      if (submitted >= target) break;
      let ok: boolean;
      try {
        ok = await this.forwardFillerFrame(take);
      } catch {
        return forwarded;
      }
      if (!ok) return forwarded;
      forwarded += 1;
    }
    return forwarded;
  }

  /**
   * Forwards one fresh capture delivery. The submission consumes the take's
   * next encoder-submission nonce (never the capture sequence number, which
   * stays capture truth). On acceptance the frame becomes the filler source
   * (one owned byte copy replaces the previous single slot). Unreadable
   * bytes skip with honest accounting and never invent pixels; the slot is
   * then covered by filler later in the same fill pass.
   */
  private async forwardFrame(take: ActiveTake, frame: ForwardableFrame): Promise<boolean> {
    if (take.timeline !== null) {
      const observed = take.timeline.observeCaptureFrame({
        capture_timestamp_us: frame.capture_timestamp_us,
        recording_session_id: take.fence.recording_session_id,
        runtime_session_id: take.fence.runtime_session_id,
        generation: take.fence.generation,
      });
      if (!observed.ok && observed.terminal) {
        void this.abortActiveTake(
          take.timeline.getStatus() === "RESET_INTERRUPTED"
            ? "RESET_INTERRUPTED"
            : "DIAGNOSTIC_PARTIAL",
        );
        return false;
      }
    }
    const submitSeq = take.nextSubmitSeq;
    const envelope = {
      frame_seq: submitSeq,
      capture_timestamp_us: frame.capture_timestamp_us,
      width: frame.width,
      height: frame.height,
      pixel_format: "bgra8" as const,
      stride_bytes: TIGHT_STRIDE_BYTES_1080P,
      recording_session_id: take.fence.recording_session_id,
      take_id: take.takeId,
      runtime_session_id: take.fence.runtime_session_id,
      generation: take.fence.generation,
      ...(frame.content_digest_fnv1a64 === undefined
        ? {}
        : { content_digest_fnv1a64: frame.content_digest_fnv1a64 }),
    };
    const bytes = this.deps.bytesSource.readFrameBytes(envelope);
    if (bytes === null) {
      // Never invent pixels: skip the frame with honest accounting.
      take.readbackGaps += 1;
      return true;
    }
    take.nextSubmitSeq = submitSeq + 1;
    const ok = await this.submitEnvelope(take, envelope, bytes);
    if (!ok) return false;
    take.freshFrames += 1;
    // Retain one owned copy as the filler source. The encoder packs its own
    // bytes synchronously and retains nothing of the caller's buffer, but
    // the copy keeps retention independent of every byte-source lifetime
    // (no borrowed native handle outlives its valid window here).
    const retained = new Uint8Array(bytes.length);
    retained.set(bytes);
    take.lastFillerSource = {
      capture_timestamp_us: frame.capture_timestamp_us,
      ...(frame.content_digest_fnv1a64 === undefined
        ? {}
        : { content_digest_fnv1a64: frame.content_digest_fnv1a64 }),
      width: frame.width,
      height: frame.height,
      stride_bytes: TIGHT_STRIDE_BYTES_1080P,
      bytes: retained,
      recording_session_id: take.fence.recording_session_id,
      runtime_session_id: take.fence.runtime_session_id,
      generation: take.fence.generation,
    };
    return true;
  }

  /**
   * Submits one filler slot repeating the last valid real frame. This is
   * NOT a capture delivery: no capture observation, no capture counter,
   * no readback call (the single retained copy is reused). The encoder
   * still assigns the next exact rational PTS by acceptance order, and the
   * frozen identical-digest pacing policy counts the repeat as encoder-
   * coalesced internally; the public TempTakeResult coalesced count
   * projects that back out (P9.5 Corrective C adjudication: filler is
   * output CFR telemetry, not P9.1 source-side coalescing).
   */
  private async forwardFillerFrame(take: ActiveTake): Promise<boolean> {
    const source = take.lastFillerSource;
    if (source === null || take.encoder === null) return true;
    const submitSeq = take.nextSubmitSeq;
    take.nextSubmitSeq = submitSeq + 1;
    const envelope = {
      frame_seq: submitSeq,
      capture_timestamp_us: source.capture_timestamp_us,
      width: source.width,
      height: source.height,
      pixel_format: "bgra8" as const,
      stride_bytes: source.stride_bytes,
      recording_session_id: take.fence.recording_session_id,
      take_id: take.takeId,
      runtime_session_id: take.fence.runtime_session_id,
      generation: take.fence.generation,
      filler: true,
      ...(source.content_digest_fnv1a64 === undefined
        ? {}
        : { content_digest_fnv1a64: source.content_digest_fnv1a64 }),
    };
    const ok = await this.submitEnvelope(take, envelope, source.bytes);
    if (!ok) return false;
    take.fillerFrames += 1;
    return true;
  }

  /**
   * Single encoder submission seam shared by fresh and filler frames.
   * Returns true when the slot was submitted (accepted, stale-fenced, or
   * benign tail race); false only when the take can no longer claim exact
   * timing. Genuine encoder failure aborts fail-closed outside the
   * completion tail; inside the tail a rejected write is benign because
   * intake may already be closing under finish.
   */
  private async submitEnvelope(
    take: ActiveTake,
    envelope: {
      readonly frame_seq: number;
      readonly capture_timestamp_us: number;
      readonly width: number;
      readonly height: number;
      readonly pixel_format: "bgra8";
      readonly stride_bytes: number;
      readonly recording_session_id: string;
      readonly take_id: string;
      readonly runtime_session_id: string;
      readonly generation: number;
      readonly content_digest_fnv1a64?: string;
      readonly filler?: boolean;
    },
    bytes: Uint8Array,
  ): Promise<boolean> {
    if (take.encoder === null) return false;
    const result = await take.encoder.writeFrame({ ...envelope, bytes });
    if (!result.accepted) {
      if (result.code === "STALE_SESSION" || result.code === "STALE_GENERATION") {
        take.rejectedStale += 1;
        return true;
      }
      if (!take.finishing) {
        void this.abortActiveTake("ENCODER_FAILED");
      }
      return false;
    }
    if (take.timeline !== null) {
      const acked = take.timeline.observeEncoderAccept({
        encode_index: result.encode_seq,
        pts_us: result.pts_us,
        recording_session_id: take.fence.recording_session_id,
        runtime_session_id: take.fence.runtime_session_id,
        generation: take.fence.generation,
      });
      if (!acked.ok && acked.terminal) {
        // Encoder PTS diverged from the canonical CFR timeline: the take
        // can no longer claim exact timing — end it closed.
        if (!take.finishing) {
          void this.abortActiveTake("DIAGNOSTIC_PARTIAL");
        }
        return false;
      }
    }
    return true;
  }

  // -- normal completion (bounded tail, ordered teardown) -----------------------

  private finishActiveTake(): Promise<TempTakeResult> {
    const take = this.active;
    if (take === null) {
      return Promise.reject(new RecordingHostError("INVALID_REQUEST", "no active take to finish"));
    }
    if (take.terminal !== null || take.finishing) {
      return take.settled;
    }
    take.finishing = true;
    this.clearPump(take);
    // Bounded tail: the final presentation frame settles before acquisition
    // stops. The timer is scheduler-driven (manual in tests) and any abort,
    // reset, close, or shutdown supersedes it via take-seq fencing. The
    // scheduler pump stays stopped through the tail (as before); completion
    // fills any residual due slots before the encoder flush so the tail
    // keeps real-time CFR even when the source idles.
    const seq = take.takeSeq;
    take.tailTimer = this.deps.scheduler.schedule(() => {
      take.tailTimer = null;
      void this.completeTake(seq);
    }, RECORDING_TAIL_MS);
    return take.settled;
  }

  private async completeTake(takeSeq: number): Promise<void> {
    const take = this.active;
    if (take === null || take.takeSeq !== takeSeq || take.terminal !== null) return;
    // Ordered teardown: stop scheduling -> final wall-clock slot fill ->
    // stop capture acceptance -> stop WGC -> flush encoder (bounded) ->
    // validate -> summarize -> close subscription -> release token ->
    // release slot.
    take.tailClosed = true;
    this.clearPump(take);
    // Final fill: the tail interval belongs to the timeline even when the
    // source idled, so due slots are satisfied (bounded) before the flush.
    // Terminal checks are skipped: P8 already decided COMPLETED.
    try {
      await this.fillDueSlots(take, TAIL_FINAL_FILL_CAP, false);
    } catch {
      // Fill is best-effort; finish below decides the outcome.
    }
    try {
      take.capture?.stop();
    } catch {
      // Stop is best-effort release; finish below decides the outcome.
    }
    let finished: Awaited<ReturnType<InternalEncoderSession["finish"]>>;
    try {
      if (take.encoder === null) {
        throw new Error("encoder missing at finish");
      }
      finished = await take.encoder.finish();
    } catch {
      await this.abortActiveTake("MEDIA_VALIDATION_FAILED");
      return;
    }
    if (finished.validation_verdict !== "PASS") {
      await this.abortActiveTake("MEDIA_VALIDATION_FAILED");
      return;
    }
    if (take.timeline === null) {
      await this.abortActiveTake("DIAGNOSTIC_PARTIAL");
      return;
    }
    const summary = take.timeline.buildManifestAnchorSummary();
    const captureStats = take.capture?.stats();
    const encoderStats = take.encoder?.getStats();
    const result: TempTakeResult = {
      recordingSessionId: take.fence.recording_session_id,
      takeId: take.takeId,
      runtimeSessionId: take.fence.runtime_session_id,
      generation: take.fence.generation,
      lessonId: take.lessonId,
      outcome: "COMPLETED",
      encoderFamily: take.encoderFamily,
      encoderFallbackUsed: take.encoderFallbackUsed,
      capturedFrames: captureStats?.acceptedFrames ?? 0,
      encodedFrames: encoderStats?.piped_frames ?? (encoderStats?.accepted_frames ?? 0),
      droppedFrames: (captureStats?.droppedFrames ?? 0) +
        (encoderStats?.dropped_frames ?? 0) +
        take.discardedFreshFrames,
      coalescedFrames: encoderStats?.piped_dup_frames ?? 0,
      fillerFrames: encoderStats?.piped_filler_frames ?? take.fillerFrames,
      mediaFrameCount: finished.media_frame_count,
      readbackGaps: take.readbackGaps,
      durationVideoTimeUs: encoderStats?.last_pts_us ?? 0,
      anchorCount: summary.anchor_count,
      firstGlobalSeq: summary.anchor_count === 0 ? null : summary.journal_high_seq_start,
      lastGlobalSeq: summary.anchor_count === 0 ? null : summary.journal_high_seq_end,
      firstVideoTimeUs: summary.anchor_count === 0 ? null : summary.first_video_time_us,
      lastVideoTimeUs: summary.anchor_count === 0 ? null : summary.last_video_time_us,
      anchorsSha256: summary.anchors_sha256,
      mediaDigest: finished.media_digest,
      mediaSizeBytes: finished.media_size_bytes,
      validationVerdict: "PASS",
    };
    this.releaseTake(take);
    this.lastTerminal = result;
    take.settlementResolve?.(result);
  }

  // -- abort (fail-closed, pipeline only) ---------------------------------------

  private async abortActiveTake(cause: AbortCause): Promise<AbortSummary> {
    const take = this.active;
    if (take === null) {
      throw new RecordingHostError("INVALID_REQUEST", "no active take to abort");
    }
    if (take.terminal !== null) {
      return take.terminal;
    }
    // Synchronous prefix: stop scheduling at once so no further frames,
    // tail timers, or callbacks can advance the take after this point.
    this.clearPump(take);
    if (take.tailTimer !== null) {
      try {
        this.deps.scheduler.cancel(take.tailTimer);
      } catch {
        // Timer release is best-effort; fencing owns correctness.
      }
      take.tailTimer = null;
    }
    take.finishing = false;
    const summary: AbortSummary = {
      recordingSessionId: take.fence.recording_session_id,
      takeId: take.takeId,
      cause,
      outcome: cause === "OPERATOR_CANCELLED"
        ? "CANCELLED"
        : cause === "RESET_INTERRUPTED"
          ? "RESET_INTERRUPTED"
          // P9.6 diagnosis: LOW_DISK_ABORT joins the INCOMPLETE group per the
          // frozen cause→outcome map (LOW_DISK_ABORT → INCOMPLETE). The take
          // stops safely with no publication; the safety supervisor owns the
          // latch and the purge. No other P9.6 behavior enters this module.
          : cause === "PREFLIGHT_REFUSED" || cause === "STARTUP_TIMEOUT" || cause === "APP_CLOSED" || cause === "LOW_DISK_ABORT"
            ? "INCOMPLETE"
            : "FAILED",
      anchorsCommitted: take.timeline?.stats().anchor_count ?? 0,
      encodedFrames: take.encoder?.getStats().accepted_frames ?? 0,
    };
    take.terminal = summary;
    try {
      take.capture?.stop();
    } catch {
      // Best-effort release.
    }
    try {
      await take.encoder?.abort(cause);
    } catch {
      // Abort owns no error surface beyond the summary.
    }
    this.releaseTake(take);
    this.lastTerminal = summary;
    take.settlementReject?.(
      new RecordingHostError(
        cause === "OPERATOR_CANCELLED" ? "INVALID_REQUEST" : "CAPTURE_SOURCE_LOST",
        `take ended: ${cause}`,
      ),
    );
    return summary;
  }

  /** Public abort entry for wiring/tests (duplicate calls deterministic). */
  async abortTake(cause: AbortCause = "OPERATOR_CANCELLED"): Promise<AbortSummary> {
    // Explicit stop/cancel during readiness: terminate the wait
    // immediately, unwind, and report the canonical abort summary. The
    // pending startTake settles with the mapped start code (never hangs).
    const pending = this.pendingTake;
    if (pending !== null) {
      const startCode: RecordingErrorCode = cause === "LOW_DISK_ABORT"
        ? "LOW_DISK_ABORT"
        : cause === "CAPTURE_SOURCE_LOST"
          ? "CAPTURE_SOURCE_LOST"
          : cause === "RESET_INTERRUPTED"
            ? "STALE_GENERATION"
            : cause === "ENCODER_FAILED" || cause === "DIAGNOSTIC_PARTIAL" || cause === "MEDIA_VALIDATION_FAILED"
              ? "ENCODER_FAILED"
              : "INVALID_REQUEST";
      const summary = this.failPendingTake(
        pending,
        startCode,
        `take stopped during readiness: ${cause}`,
        cause,
      );
      return summary;
    }
    if (this.active === null) {
      if (this.lastTerminal !== null && !("mediaDigest" in this.lastTerminal)) {
        return this.lastTerminal as AbortSummary;
      }
      throw new RecordingHostError("INVALID_REQUEST", "no active take to abort");
    }
    return this.abortActiveTake(cause);
  }

  // -- release ---------------------------------------------------------------

  private releaseTake(take: ActiveTake): void {
    this.clearReadinessTimer(take);
    this.safeUnsubscribe(take.unsubscribe);
    try {
      take.capture?.close();
    } catch {
      // Release-what-exists is complete when the slot below is freed.
    }
    try {
      void take.encoder?.close();
    } catch {
      // Encoder close is best-effort after abort/finish settlement.
    }
    if (this.active === take) {
      this.active = null;
    }
    if (this.pendingTake === take) {
      this.pendingTake = null;
    }
  }

  // -- startup unwind (phase-owned resources only) ------------------------------

  private async unwindStart(take: ActiveTake): Promise<void> {
    this.clearReadinessTimer(take);
    if (take.pumpTimer !== null) {
      try {
        this.deps.scheduler.cancel(take.pumpTimer);
      } catch {
        // Best-effort.
      }
      take.pumpTimer = null;
    }
    if (take.tailTimer !== null) {
      try {
        this.deps.scheduler.cancel(take.tailTimer);
      } catch {
        // Best-effort.
      }
      take.tailTimer = null;
    }
    if (take.capture !== null) {
      try {
        take.capture.stop();
      } catch {
        // Best-effort.
      }
      try {
        take.capture.close();
      } catch {
        // Best-effort.
      }
    }
    if (take.encoder !== null) {
      try {
        await take.encoder.abort("startup-unwind");
      } catch {
        // Best-effort.
      }
      try {
        await take.encoder.close();
      } catch {
        // Best-effort.
      }
    }
    this.safeUnsubscribe(take.unsubscribe);
    this.safeRemoveTakeDir(take.takeDir);
  }

  private newPendingTake(
    takeSeq: number,
    fence: TakeFence,
    takeId: string,
    lessonId: string,
    webContentsId: number | null,
    takeDir: string,
  ): ActiveTake {
    let settlementResolve: ((value: TempTakeResult) => void) | null = null;
    let settlementReject: ((reason: RecordingHostError) => void) | null = null;
    const settled = new Promise<TempTakeResult>((resolve, reject) => {
      settlementResolve = resolve;
      settlementReject = reject;
    });
    // Every pending take settles exactly once (finish or abort); attach a
    // no-op catcher so an unobserved abort never surfaces as an unhandled
    // rejection — awaitSettlement() still observes the outcome.
    settled.catch(() => undefined);
    return {
      takeSeq,
      fence: { ...fence },
      takeId,
      lessonId,
      webContentsId,
      takeDir,
      capture: null,
      encoder: null,
      timeline: null,
      coordinatorReady: false,
      unsubscribe: () => undefined,
      epochRuntimeMs: 0,
      encoderFamily: "LIBX264",
      encoderFallbackUsed: false,
      pumpTimer: null,
      tailTimer: null,
      pumpInFlight: false,
      finishing: false,
      tailClosed: false,
      terminal: null,
      readbackGaps: 0,
      rejectedStale: 0,
      nextSubmitSeq: 1,
      lastFillerSource: null,
      fillerFrames: 0,
      discardedFreshFrames: 0,
      freshFrames: 0,
      pumpTicks: 0,
      heldTicks: 0,
      emptyTicks: 0,
      bufferedEvents: [],
      settlementResolve,
      settlementReject,
      settled,
      readinessTimer: null,
      readinessDeadlineMs: 0,
      readinessSettled: false,
      readinessResolve: null,
      readinessReject: null,
    };
  }

  private matchesWindow(take: ActiveTake, webContentsId: number): boolean {
    // Unknown binding fails closed: an untargeted close still ends the take
    // rather than risk recording past window loss.
    if (take.webContentsId === null) return true;
    return take.webContentsId === webContentsId;
  }

  private safeUnsubscribe(unsubscribe: (() => void) | undefined): void {
    if (typeof unsubscribe !== "function") return;
    try {
      unsubscribe();
    } catch {
      // Listener release is best-effort; the take-seq fence owns correctness.
    }
  }

  private safeRemoveTakeDir(takeDir: string): void {
    try {
      this.deps.files.removeTakeDir(takeDir);
    } catch {
      // Startup unwind is best-effort; residue is reported by the gate.
    }
  }
}
