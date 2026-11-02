// P9.4 Recording Timeline Coordinator — runtime<->capture<->video correlation.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 8-9, 14, 16, 19 and
// docs/adr/ADR-0014-screen-recording-boundary.md (observation tier, shared
// monotonic time, generation fencing).
//
// Maps trusted P8 runtime monotonic timeline + P8 GlobalRuntimeEvent
// global_seq + playhead/step boundaries + P9.2 capture-clock timestamps +
// P9.3 encoder CFR video timeline into safe RecordingTimeline anchors so
// future P10 voice can answer "at what video timestamp did runtime event /
// step X occur?".
//
// Conceptual path (P8 execution authority preserved, P9 observes only):
//   P8 RuntimeJournal -> trusted Main-side event source -> this coordinator
//   -> immutable runtime<->capture epoch mapping -> capture frame timing
//   -> encoder CFR timing -> video_time_us -> RecordingTimelineAnchor
//   -> bounded writer sink -> anchors sidecar / manifest summary.
//
// P8 remains execution authority. This module never appends P8 events,
// never rewrites global_seq, never changes runtime timestamps, playhead,
// steps, or completion. It projects only safe fields (session, generation,
// seq, type, scene/step/ordinal, engine family, monotonic timestamp) and
// drops every semantic payload.
//
// Clock domains (explicit, never interchangeable):
//   Runtime : P8 monotonic ms (event timestamp_ms)
//   Capture : P9.2 raw internal capture-clock us
//   Video   : normalized CFR video_time_us from canonical zero
// Epoch mapping is immutable for the take; continuous rebasing is forbidden.
// Event->video policy is frozen to preceding-frame (floor): the greatest
// encoded frame boundary at or before the event elapsed time. Error is
// therefore always in [0, FRAME_INTERVAL_US] (<= one 30 FPS interval).
// Step-boundary anchors violating that bound latch TIMELINE_INVALID and
// never publish a misleading anchor.
//
// Fencing: bound to (recording_session_id, take_id, runtime_session_id,
// generation). Mismatched runtime_session_id -> STALE_SESSION (rejected, no
// latch). Mismatched generation -> STALE_GENERATION; forward rotation or an
// explicit runtime.reset.* event latches RESET_INTERRUPTED terminal (the
// take never continues across a generation). Late old-generation events,
// late capture timings, and late encoder acks after the latch never produce
// anchors and never mutate the timeline.
//
// Ordering: global_seq strictly increasing (gaps allowed for filtered
// journal streams); immediate duplicate (same seq as last) is idempotent
// (returns the existing anchor, no duplicate); older seqs latch
// TIMELINE_INVALID (never silently reordered). video_time_us is
// non-decreasing. Anchors stream to a bounded sink (<= 5 MiB total,
// <= 4 KiB/line); overflow latches TIMELINE_INVALID.
//
// Pause (Policy A): P8 pause never pauses video. Pause/resume lifecycle
// events are anchored in real/video time; the frozen visual interval stays
// part of video duration and is annotated via getPauseIntervals() for P10.
// Cancel/FAILED/HOLD lifecycle events are anchored as timeline truth; take
// publication policy stays P9.6 scope. Reset terminates the take.
//
// Start ordering primitive (enforced by the future P9.5 host, provided here
// as construction order): prepare subscription -> establish epochs ->
// establish video frame zero -> recorder ready -> runtime execution allowed.
// Reanchor is passive only (no runtime side effects, no second encoder
// start, no step replay).
//
// Zero Electron, zero child processes, zero fs, zero Date.now / performance
// timing authority, zero renderer input, zero IPC, zero TTS/audio/Unreal,
// zero P8 imports (mirrored shapes only). Platform-neutral TS.

import { z } from "zod";
import {
  FRAME_INTERVAL_US,
  RecordingTimelineAnchorSchema,
  type RecordingTimelineAnchor,
} from "./timeline.ts";
import {
  MAX_TAKE_DURATION_US,
  sanitizeRecordingMessage,
  type RecordingErrorCode,
  type TakeFence,
} from "./protocol.ts";
import {
  MAX_EPOCH_SKEW_BOUND_US,
  captureUsToElapsedUs,
  frameIndexForElapsedUs,
  frameIndexForVideoTimeUs,
  runtimeMsToElapsedUs,
  validateTimelineEpoch,
  videoTimeForElapsedUs,
  videoTimeForEncodeIndex,
  type TimelineEpoch,
} from "./timeline-clock.ts";
import {
  BoundedAnchorWriter,
  buildAnchorSummary,
} from "./timeline-writer.ts";
import type { AnchorSummary } from "./manifest.ts";

// ---------------------------------------------------------------------------
// Trusted Input Shapes (P8-mirrored, Main-side only; no P8 imports)
// ---------------------------------------------------------------------------

export const TIMELINE_ENGINE_FAMILIES = [
  "orchestrator",
  "editor",
  "terminal",
  "browser",
  "wait",
  "narration",
  "visual",
] as const;

export const TimelineEngineFamilySchema = z.enum(TIMELINE_ENGINE_FAMILIES);
export type TimelineEngineFamily = z.infer<typeof TimelineEngineFamilySchema>;

/**
 * Trusted Main-side projection of one P8 GlobalRuntimeEvent. The future
 * RecordingHost builds this Main-side from the journal object identity
 * (plus trusted playhead ordinal for global_step_ordinal, which the journal
 * does not carry). Renderer input can never reach here: there is no IPC,
 * no renderer path, and every field is re-validated below.
 */
export const TrustedRuntimeEventSchema = z.object({
  runtime_session_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  generation: z.number().int().min(1),
  global_seq: z.number().int().min(1),
  event_type: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  scene_id: z.string().regex(/^C\d{2}-L\d{3}-S\d{3}$/),
  step_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  global_step_ordinal: z.number().int().min(1),
  engine: TimelineEngineFamilySchema,
  timestamp_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export type TrustedRuntimeEvent = z.infer<typeof TrustedRuntimeEventSchema>;

export const TimelineFenceSchema = z.strictObject({
  recording_session_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  take_id: z.string().min(3).max(32).regex(/^t\d{2,}$/),
  runtime_session_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  generation: z.number().int().min(1),
});

export type TimelineFence = z.infer<typeof TimelineFenceSchema>;

export interface TimelineCoordinatorOptions {
  readonly fence: TimelineFence;
  readonly epoch: TimelineEpoch;
}

export const TIMELINE_STATUSES = ["ACTIVE", "RESET_INTERRUPTED", "TIMELINE_INVALID"] as const;
export type TimelineStatus = (typeof TIMELINE_STATUSES)[number];

export interface TimelineIngestOk {
  readonly ok: true;
  readonly anchor: RecordingTimelineAnchor;
  readonly duplicate: boolean;
  readonly mapping_error_us: number;
  readonly frame_index: number;
}

export interface TimelineIngestReject {
  readonly ok: false;
  readonly code: RecordingErrorCode;
  readonly message: string;
  readonly terminal: boolean;
}

export type TimelineIngestResult = TimelineIngestOk | TimelineIngestReject;

export interface PauseInterval {
  readonly start_video_time_us: number;
  readonly end_video_time_us: number | null;
  readonly start_global_seq: number;
  readonly end_global_seq: number | null;
}

export interface TimelineStats {
  readonly status: TimelineStatus;
  readonly anchor_count: number;
  readonly sidecar_bytes: number;
  readonly first_global_seq: number | null;
  readonly last_global_seq: number | null;
  readonly first_video_time_us: number | null;
  readonly last_video_time_us: number | null;
  readonly last_mapping_error_us: number | null;
  readonly max_mapping_error_us: number | null;
  readonly pause_interval_count: number;
}

function sanitized(code: RecordingErrorCode, message: string): { code: RecordingErrorCode; message: string } {
  return { code, message: sanitizeRecordingMessage(message) };
}

function isResetEventType(eventType: string): boolean {
  return eventType === "runtime.reset.started" ||
    eventType === "runtime.reset.browser" ||
    eventType === "runtime.reset.terminal" ||
    eventType === "runtime.reset.workspace" ||
    eventType === "runtime.reset.completed";
}

/**
 * RecordingTimelineCoordinator: one take's immutable-epoch correlation owner.
 * All methods are synchronous and deterministic (no clock reads, no I/O).
 */
export class RecordingTimelineCoordinator {
  private readonly fence: TimelineFence;
  private readonly epoch: TimelineEpoch;
  private readonly writer = new BoundedAnchorWriter();
  private readonly anchors: RecordingTimelineAnchor[] = [];
  // Bounded idempotency index: seq -> anchor, capped by the sidecar ceiling
  // (<= 5 MiB, ~20k anchors max). High-watermark (lastGlobalSeq) still owns
  // ordering; the map only proves duplicates without an unbounded Set.
  private readonly seqIndex = new Map<number, RecordingTimelineAnchor>();
  private readonly stepFirstVideoTime = new Map<string, number>();
  private readonly pauseIntervals: PauseInterval[] = [];
  private openPause: { start_video_time_us: number; start_global_seq: number } | null = null;

  private status: TimelineStatus = "ACTIVE";
  private terminalCode: RecordingErrorCode | null = null;

  private lastGlobalSeq = 0;
  private lastVideoTimeUs = -1;
  private lastRuntimeMs: number | null = null;
  private lastCaptureUs: number | null = null;
  private lastEncodeIndex = 0;
  private lastPtsUs = -1;
  private lastMappingErrorUs: number | null = null;
  private maxMappingErrorUs: number | null = null;
  private firstGlobalSeq: number | null = null;
  private firstVideoTimeUs: number | null = null;

  constructor(options: TimelineCoordinatorOptions) {
    this.fence = TimelineFenceSchema.parse(options.fence);
    const epoch = validateTimelineEpoch(options.epoch);
    if (epoch.epoch_skew_bound_us > MAX_EPOCH_SKEW_BOUND_US) {
      throw new Error("[TIMELINE_INVALID] epoch skew bound exceeds calibration ceiling");
    }
    this.epoch = Object.freeze({ ...epoch });
    Object.freeze(this.fence);
  }

  /** Bound take fence (frozen copy). */
  getFence(): TimelineFence {
    return { ...this.fence };
  }

  /** Immutable epoch mapping (frozen copy; never rebased). */
  getEpoch(): TimelineEpoch {
    return { ...this.epoch };
  }

  /** Current timeline status (ACTIVE until a terminal latch). */
  getStatus(): TimelineStatus {
    return this.status;
  }

  /** True when the coordinator is ready to correlate (ACTIVE + epoch set). */
  isReady(): boolean {
    return this.status === "ACTIVE";
  }

  /** Committed anchors in order (frozen copies, read-only P10 seam). */
  getAnchors(): readonly RecordingTimelineAnchor[] {
    return Object.freeze([...this.anchors]);
  }

  /** Serialized sidecar text (canonical JSONL, LF, no BOM). */
  getSidecarText(): string {
    return this.writer.sidecarText();
  }

  /** Pause intervals annotated in video time (P10 seam; video never collapsed). */
  getPauseIntervals(): readonly PauseInterval[] {
    return Object.freeze([...this.pauseIntervals, ...(this.openPause === null ? [] : [{
      start_video_time_us: this.openPause.start_video_time_us,
      end_video_time_us: null,
      start_global_seq: this.openPause.start_global_seq,
      end_global_seq: null,
    } as PauseInterval])]);
  }

  stats(): TimelineStats {
    return {
      status: this.status,
      anchor_count: this.anchors.length,
      sidecar_bytes: this.writer.totalBytes,
      first_global_seq: this.firstGlobalSeq,
      last_global_seq: this.anchors.length === 0 ? null : this.lastGlobalSeq,
      first_video_time_us: this.firstVideoTimeUs,
      last_video_time_us: this.anchors.length === 0 ? null : this.lastVideoTimeUs,
      last_mapping_error_us: this.lastMappingErrorUs,
      max_mapping_error_us: this.maxMappingErrorUs,
      pause_interval_count: this.pauseIntervals.length + (this.openPause === null ? 0 : 1),
    };
  }

  /** P9.1 AnchorSummary for future manifest finalization (no publication). */
  buildManifestAnchorSummary(): AnchorSummary {
    return buildAnchorSummary(this.anchors, this.writer.sidecarText());
  }

  // -- P10 sync seam (read-only) --------------------------------------------

  getAnchorForGlobalSeq(globalSeq: number): RecordingTimelineAnchor | undefined {
    const found = this.anchors.find((a) => a.global_seq === globalSeq);
    return found === undefined ? undefined : { ...found };
  }

  getAnchorsForStep(stepId: string): readonly RecordingTimelineAnchor[] {
    return Object.freeze(this.anchors.filter((a) => a.step_id === stepId).map((a) => ({ ...a })));
  }

  /** First video_time_us observed for a step (P10 cue alignment), if any. */
  getVideoTimeForStep(stepId: string): number | undefined {
    return this.stepFirstVideoTime.get(stepId);
  }

  stepIds(): readonly string[] {
    return Object.freeze([...this.stepFirstVideoTime.keys()]);
  }

  // -- Trusted runtime event ingestion (Main-side only) ---------------------

  ingestRuntimeEvent(input: unknown): TimelineIngestResult {
    if (this.status !== "ACTIVE") {
      const code = this.terminalCode ?? "TIMELINE_INVALID";
      return {
        ok: false,
        ...sanitized(code, this.status === "RESET_INTERRUPTED"
          ? "take timeline is terminated by reset interruption"
          : "take timeline is invalid"),
        terminal: true,
      };
    }
    const parsed = TrustedRuntimeEventSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, ...sanitized("INVALID_REQUEST", "runtime event failed trusted projection validation"), terminal: false };
    }
    const event = parsed.data;

    if (event.runtime_session_id !== this.fence.runtime_session_id) {
      return { ok: false, ...sanitized("STALE_SESSION", "stale runtime session for this take"), terminal: false };
    }
    if (event.generation !== this.fence.generation) {
      if (event.generation > this.fence.generation || isResetEventType(event.event_type)) {
        this.latchResetInterrupted();
        return { ok: false, ...sanitized("STALE_GENERATION", "generation rotation terminates this take"), terminal: true };
      }
      return { ok: false, ...sanitized("STALE_GENERATION", "stale generation for this take"), terminal: false };
    }
    if (isResetEventType(event.event_type)) {
      const anchored = this.commitAnchor(event);
      if (!anchored.ok) {
        return anchored;
      }
      this.latchResetInterrupted();
      return anchored;
    }

    const known = this.seqIndex.get(event.global_seq);
    if (known !== undefined) {
      return {
        ok: true,
        anchor: { ...known },
        duplicate: true,
        mapping_error_us: this.lastMappingErrorUs ?? 0,
        frame_index: frameIndexForVideoTimeUs(known.video_time_us),
      };
    }
    if (event.global_seq <= this.lastGlobalSeq) {
      this.latchInvalid("TIMELINE_INVALID", "runtime event order violated");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "runtime event order violated"), terminal: true };
    }
    if (this.lastRuntimeMs !== null && event.timestamp_ms < this.lastRuntimeMs) {
      this.latchInvalid("TIMELINE_INVALID", "runtime clock moved backwards");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "runtime clock moved backwards"), terminal: true };
    }

    return this.commitAnchor(event);
  }

  /**
   * Passive reanchor from a bounded journal snapshot page (subscribe ->
   * snapshot -> begin pattern). Ingests each projected event idempotently;
   * never touches runtime, encoder, or capture state. Returns per-event
   * results in input order without reordering.
   */
  reanchorFromSnapshot(events: readonly unknown[]): readonly TimelineIngestResult[] {
    return events.map((e) => this.ingestRuntimeEvent(e));
  }

  // -- Capture / encoder observation (fenced, never creates anchors) --------

  observeCaptureFrame(input: { capture_timestamp_us: number } & TakeFence): TimelineIngestReject | { ok: true } {
    if (this.status !== "ACTIVE") {
      const code = this.terminalCode ?? "TIMELINE_INVALID";
      return { ok: false, ...sanitized(code, "take timeline is terminal"), terminal: true };
    }
    if (input.recording_session_id !== this.fence.recording_session_id ||
      input.runtime_session_id !== this.fence.runtime_session_id) {
      return { ok: false, ...sanitized("STALE_SESSION", "stale capture take fence"), terminal: false };
    }
    if (input.generation !== this.fence.generation) {
      if (input.generation > this.fence.generation) {
        this.latchResetInterrupted();
        return { ok: false, ...sanitized("STALE_GENERATION", "capture generation terminates this take"), terminal: true };
      }
      return { ok: false, ...sanitized("STALE_GENERATION", "stale capture generation"), terminal: false };
    }
    const ts = input.capture_timestamp_us;
    if (!Number.isInteger(ts) || ts < 0 || !Number.isSafeInteger(ts)) {
      return { ok: false, ...sanitized("INVALID_REQUEST", "capture timestamp failed validation"), terminal: false };
    }
    if (this.lastCaptureUs !== null && ts < this.lastCaptureUs) {
      this.latchInvalid("TIMELINE_INVALID", "capture clock moved backwards");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "capture clock moved backwards"), terminal: true };
    }
    let elapsed: number;
    try {
      elapsed = captureUsToElapsedUs(ts, this.epoch);
    } catch {
      this.latchInvalid("TIMELINE_INVALID", "capture frame cannot be correlated");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "capture frame cannot be correlated"), terminal: true };
    }
    void elapsed;
    this.lastCaptureUs = ts;
    return { ok: true };
  }

  observeEncoderAccept(input: { encode_index: number; pts_us: number } & TakeFence): TimelineIngestReject | { ok: true } {
    if (this.status !== "ACTIVE") {
      const code = this.terminalCode ?? "TIMELINE_INVALID";
      return { ok: false, ...sanitized(code, "take timeline is terminal"), terminal: true };
    }
    if (input.recording_session_id !== this.fence.recording_session_id ||
      input.runtime_session_id !== this.fence.runtime_session_id) {
      return { ok: false, ...sanitized("STALE_SESSION", "stale encoder take fence"), terminal: false };
    }
    if (input.generation !== this.fence.generation) {
      if (input.generation > this.fence.generation) {
        this.latchResetInterrupted();
        return { ok: false, ...sanitized("STALE_GENERATION", "encoder generation terminates this take"), terminal: true };
      }
      return { ok: false, ...sanitized("STALE_GENERATION", "stale encoder generation"), terminal: false };
    }
    if (!Number.isInteger(input.encode_index) || input.encode_index < 1) {
      return { ok: false, ...sanitized("INVALID_REQUEST", "encoder index failed validation"), terminal: false };
    }
    if (input.encode_index <= this.lastEncodeIndex) {
      this.latchInvalid("TIMELINE_INVALID", "encoder acknowledgement order violated");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "encoder acknowledgement order violated"), terminal: true };
    }
    let expected: number;
    try {
      expected = videoTimeForEncodeIndex(input.encode_index);
    } catch {
      return { ok: false, ...sanitized("INVALID_REQUEST", "encoder index failed validation"), terminal: false };
    }
    if (input.pts_us !== expected) {
      this.latchInvalid("TIMELINE_INVALID", "encoder PTS diverges from canonical CFR timeline");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "encoder PTS diverges from canonical CFR timeline"), terminal: true };
    }
    if (input.pts_us < this.lastPtsUs) {
      this.latchInvalid("TIMELINE_INVALID", "encoder PTS moved backwards");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "encoder PTS moved backwards"), terminal: true };
    }
    this.lastEncodeIndex = input.encode_index;
    this.lastPtsUs = input.pts_us;
    return { ok: true };
  }

  // -- internals --------------------------------------------------------------

  private commitAnchor(event: TrustedRuntimeEvent): TimelineIngestResult {
    let elapsed: number;
    try {
      elapsed = runtimeMsToElapsedUs(event.timestamp_ms, this.epoch);
    } catch {
      this.latchInvalid("TIMELINE_INVALID", "runtime event cannot be correlated");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "runtime event cannot be correlated"), terminal: true };
    }
    if (elapsed > MAX_TAKE_DURATION_US) {
      this.latchInvalid("TIMELINE_INVALID", "runtime event exceeds take ceiling");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "runtime event exceeds take ceiling"), terminal: true };
    }
    const frameIndex = frameIndexForElapsedUs(elapsed);
    const videoTime = videoTimeForElapsedUs(elapsed);
    const mappingError = elapsed - videoTime;
    if (mappingError < 0 || mappingError > FRAME_INTERVAL_US) {
      this.latchInvalid("TIMELINE_INVALID", "event cannot be mapped within one frame interval");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "event cannot be mapped within one frame interval"), terminal: true };
    }
    if (videoTime < this.lastVideoTimeUs) {
      this.latchInvalid("TIMELINE_INVALID", "video timeline moved backwards");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "video timeline moved backwards"), terminal: true };
    }
    const candidate = {
      recording_session_id: this.fence.recording_session_id,
      take_id: this.fence.take_id,
      runtime_session_id: this.fence.runtime_session_id,
      generation: this.fence.generation,
      video_time_us: videoTime,
      runtime_monotonic_ms: event.timestamp_ms,
      global_seq: event.global_seq,
      scene_id: event.scene_id,
      step_id: event.step_id,
      global_step_ordinal: event.global_step_ordinal,
      engine: event.engine,
      event_type: event.event_type,
    };
    const parsedAnchor = RecordingTimelineAnchorSchema.safeParse(candidate);
    if (!parsedAnchor.success) {
      return { ok: false, ...sanitized("INVALID_REQUEST", "anchor failed frozen schema validation"), terminal: false };
    }
    const anchor = parsedAnchor.data;
    try {
      this.writer.append(anchor);
    } catch {
      this.latchInvalid("TIMELINE_INVALID", "anchors sidecar bound exceeded");
      return { ok: false, ...sanitized("TIMELINE_INVALID", "anchors sidecar bound exceeded"), terminal: true };
    }
    this.anchors.push(anchor);
    this.seqIndex.set(event.global_seq, anchor);
    this.lastGlobalSeq = event.global_seq;
    this.lastVideoTimeUs = videoTime;
    this.lastRuntimeMs = event.timestamp_ms;
    this.lastMappingErrorUs = mappingError;
    this.maxMappingErrorUs = this.maxMappingErrorUs === null
      ? mappingError
      : Math.max(this.maxMappingErrorUs, mappingError);
    if (this.firstGlobalSeq === null) {
      this.firstGlobalSeq = event.global_seq;
    }
    if (this.firstVideoTimeUs === null) {
      this.firstVideoTimeUs = videoTime;
    }
    if (!this.stepFirstVideoTime.has(event.step_id)) {
      this.stepFirstVideoTime.set(event.step_id, videoTime);
    }
    this.trackPauseLifecycle(event, videoTime);
    return {
      ok: true,
      anchor: { ...anchor },
      duplicate: false,
      mapping_error_us: mappingError,
      frame_index: frameIndex,
    };
  }

  private trackPauseLifecycle(event: TrustedRuntimeEvent, videoTime: number): void {
    if (event.event_type === "runtime.paused") {
      if (this.openPause === null) {
        this.openPause = { start_video_time_us: videoTime, start_global_seq: event.global_seq };
      }
      return;
    }
    if (event.event_type === "runtime.resumed") {
      if (this.openPause !== null) {
        this.pauseIntervals.push({
          start_video_time_us: this.openPause.start_video_time_us,
          end_video_time_us: videoTime,
          start_global_seq: this.openPause.start_global_seq,
          end_global_seq: event.global_seq,
        });
        this.openPause = null;
      }
    }
  }

  private latchResetInterrupted(): void {
    if (this.status === "ACTIVE") {
      this.status = "RESET_INTERRUPTED";
      this.terminalCode = "STALE_GENERATION";
    }
  }

  private latchInvalid(code: RecordingErrorCode, _reason: string): void {
    void _reason;
    if (this.status === "ACTIVE") {
      this.status = "TIMELINE_INVALID";
      this.terminalCode = code;
    }
  }
}

/** Narrow fence check shared with capture/encoder observers (pure). */
export function timelineFenceMatches(record: TakeFence, take: TakeFence): boolean {
  return record.recording_session_id === take.recording_session_id &&
    record.runtime_session_id === take.runtime_session_id &&
    record.generation === take.generation;
}
