// P9.4 Timeline Clock Domains & Epoch Mapping.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 8-9, 14, 16 and
// docs/adr/ADR-0014-screen-recording-boundary.md (Shared Monotonic Time).
//
// Three conceptual clock domains (never assumed interchangeable):
//   1. Runtime Clock — P8 SystemMonotonicClock / performance.now() baseline.
//      P8 GlobalRuntimeEvent.timestamp_ms lives here. Ordering authority.
//   2. Capture Clock — P9.2 WGC/internal capture timestamp (raw internal
//      capture-clock microseconds). Same machine, separate epoch/domain.
//      Raw QPC ticks never enter any public protocol (P9.1 frozen).
//   3. Video Clock — normalized encoded CFR presentation timeline,
//      video_time_us, integer microseconds, starts at canonical zero.
//      Derived from P9.3 encoder acceptance order (CFR 30), never wall clock.
//
// Session epoch mapping is established once per take (immutable):
//   runtime_epoch_ms + capture_epoch_us + video_epoch (zero).
// Never rebased mid-take. Calibration is an explicit bounded dual-sample.
// Drift policy for one bounded take: backwards movement latches
// TIMELINE_INVALID; excessive divergence beyond the frozen bound latches
// TIMELINE_INVALID. No silent reordering, no resampling.
//
// Video time uses integer arithmetic only. Canonical CFR PTS is the exact
// rational 30/1 media timeline: zero-based frame index i maps to
// floor(i x 1,000,000 / 30) (one-based encode index n maps with i = n-1).
// No floating accumulation, no repeated rounded addition, no Date.now
// authority. FRAME_INTERVAL_US (33,334 = ceil(1e6/30)) is retained ONLY as
// the maximum single-frame correlation error bound — it is never multiplied
// as a per-frame step (that constant-step policy accumulated +0.666... us
// per frame, ~36 ms at the 30 min take ceiling, and is corrected here).
// Anchors always carry encoder-truth PTS so dropped captures cannot create
// timeline ambiguity.
//
// Zero Electron, zero child processes, zero fs, zero P8 imports (mirrored
// shapes only), zero renderer authority, zero IPC.

import { z } from "zod";
import { FRAME_INTERVAL_US } from "./timeline.ts";
import { RECORDING_FPS } from "./encoder-profile.ts";
import {
  MAX_TAKE_DURATION_US,
  MicrosecondSchema,
  RecordingIdentifierSchema,
  RuntimeMonotonicMsSchema,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Frozen P9.4 Clock Constants
// ---------------------------------------------------------------------------

/** Canonical video frames per second (P9.1/P9.3 frozen). */
export const TIMELINE_FPS = RECORDING_FPS;

/** Exact rational CFR numerator: 30 frames ... */
export const FPS_NUMERATOR = 30;
/** Exact rational CFR denominator: ... per 1 second (30/1 CFR). */
export const FPS_DENOMINATOR = 1;

/** Microseconds per second (exact, for rational CFR math). */
export const MICROS_PER_SECOND = 1_000_000;

/**
 * Maximum single-frame interval: ceil(1,000,000 / 30) = 33,334 us.
 * Alias of the frozen P9.1 FRAME_INTERVAL_US. This is the ceiling of one
 * 30 FPS frame interval and therefore the upper bound for single-frame
 * event-correlation error — it is NOT the canonical per-frame duration.
 */
export const MAX_FRAME_INTERVAL_US = FRAME_INTERVAL_US;

/**
 * Maximum acceptable epoch calibration uncertainty: 5,000 us (5 ms).
 * Rationale: dual-sample adjacency (runtime clock read adjacent to capture
 * clock read at acquisition start) must be well within one frame interval
 * (33,334 us) so step-boundary mapping error stays bounded. Epochs carrying
 * a larger skew bound are rejected fail-closed. Re-sampled only on
 * pause/resume boundaries per design Section 9 (new take epoch, never a
 * mid-take rebase).
 */
export const MAX_EPOCH_SKEW_BOUND_US = 5_000;

/**
 * Maximum acceptable capture/runtime divergence for one bounded take.
 * If a capture-derived elapsed and a runtime-derived elapsed observed at
 * the coordinator disagree by more than this, the timeline latches
 * TIMELINE_INVALID. Set to two frame intervals (66,668 us) so genuine
 * scheduling jitter (tens of ms) cannot falsely invalidate, while true
 * clock breaks (seconds) always latch.
 */
export const MAX_TIMELINE_DIVERGENCE_US = MAX_FRAME_INTERVAL_US * 2;

/** Reserved P10 audio seam: 48 kHz sample rate (metadata only, no audio). */
export const P10_AUDIO_SAMPLE_RATE_HZ = 48_000;

// ---------------------------------------------------------------------------
// Epoch Mapping Schema (immutable per take)
// ---------------------------------------------------------------------------

export const TimelineEpochSchema = z.strictObject({
  runtime_epoch_ms: RuntimeMonotonicMsSchema,
  capture_epoch_us: MicrosecondSchema,
  runtime_clock_epoch: RecordingIdentifierSchema,
  capture_clock_epoch: RecordingIdentifierSchema,
  epoch_skew_bound_us: MicrosecondSchema,
});

export type TimelineEpoch = z.infer<typeof TimelineEpochSchema>;

/**
 * Validates an epoch mapping: integer domains, skew bound within the frozen
 * calibration ceiling, opaque epoch identities well-formed. Video epoch is
 * canonically zero (first encoded frame PTS 0) and needs no stored value.
 */
export function validateTimelineEpoch(value: unknown): TimelineEpoch {
  const parsed = TimelineEpochSchema.parse(value);
  if (parsed.epoch_skew_bound_us > MAX_EPOCH_SKEW_BOUND_US) {
    throw new Error(
      `[TIMELINE_INVALID] epoch skew bound exceeds maximum calibration uncertainty`,
    );
  }
  return parsed;
}

/**
 * Deterministic bounded calibration: builds an immutable epoch mapping from
 * two adjacently sampled readings (runtime clock ms + capture clock us).
 * The caller performs the dual-sample Main-side (same pattern as design
 * Section 9: qpc sample adjacent to clock.now() at acquisition start).
 * Offset is derived, never assumed: callers must NOT assume
 * runtime_ms x 1000 == capture_us without this mapping.
 */
export function calibrateTimelineEpoch(input: {
  runtimeSampleMs: number;
  captureSampleUs: number;
  runtimeClockEpoch: string;
  captureClockEpoch: string;
  skewBoundUs: number;
}): TimelineEpoch {
  return validateTimelineEpoch({
    runtime_epoch_ms: input.runtimeSampleMs,
    capture_epoch_us: input.captureSampleUs,
    runtime_clock_epoch: input.runtimeClockEpoch,
    capture_clock_epoch: input.captureClockEpoch,
    epoch_skew_bound_us: input.skewBoundUs,
  });
}

// ---------------------------------------------------------------------------
// CFR Video Time (canonical encoder-truth PTS)
// ---------------------------------------------------------------------------

/**
 * Canonical CFR PTS: encode index n (1-based acceptance order, zero-based
 * frame index i = n-1) maps to floor(i x 1,000,000 / 30) on the exact
 * rational 30/1 media timeline. Single canonical implementation shared with
 * rationalVideoTimeForFrameIndex below (and with P9.3 ptsForEncodeIndex) —
 * anchors carry encoder truth so dropped captures cannot warp the timeline.
 * Systematic CFR drift relative to the exact rational timeline is 0 us.
 */
export function videoTimeForEncodeIndex(encodeIndex: number): number {
  if (!Number.isInteger(encodeIndex) || encodeIndex < 1) {
    throw new Error("[TIMELINE_INVALID] encode index must be an integer >= 1");
  }
  return rationalVideoTimeForFrameIndex(encodeIndex - 1);
}

/**
 * Exact rational video time for a 0-based frame index:
 * floor(frameIndex x 1,000,000 / 30). Integer/rational arithmetic, no float
 * accumulation, no repeated rounded addition. This IS the canonical CFR
 * timeline (frame 1 -> 0 us, frame 2 -> 33,333 us, frame 31 -> 1,000,000 us).
 */
export function rationalVideoTimeForFrameIndex(frameIndex: number): number {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error("[TIMELINE_INVALID] frame index must be an integer >= 0");
  }
  if (frameIndex > Math.floor((Number.MAX_SAFE_INTEGER * FPS_NUMERATOR) / (MICROS_PER_SECOND * FPS_DENOMINATOR))) {
    throw new Error("[TIMELINE_INVALID] frame index would overflow video time");
  }
  return Math.floor((frameIndex * MICROS_PER_SECOND) / TIMELINE_FPS);
}

/**
 * Preceding-frame (floor) policy: elapsed recording time maps to the
 * greatest encoded frame index at or before it, floor(t x 30 / 1,000,000).
 * Guarantees causality (never maps an event to future video not yet
 * encoded). Integer arithmetic only: t <= 1,802,000,000 us (take ceiling)
 * so t x 30 <= 5.41e10, far inside Number.MAX_SAFE_INTEGER. Frozen P9.4
 * event->video policy.
 */
export function frameIndexForElapsedUs(elapsedUs: number): number {
  if (!Number.isInteger(elapsedUs) || elapsedUs < 0) {
    throw new Error("[TIMELINE_INVALID] elapsed time must be an integer >= 0");
  }
  if (elapsedUs > MAX_TAKE_DURATION_US) {
    throw new Error("[TIMELINE_INVALID] elapsed time exceeds take ceiling");
  }
  return Math.floor((elapsedUs * TIMELINE_FPS) / MICROS_PER_SECOND);
}

/** Floor-policy video time for an elapsed recording time. */
export function videoTimeForElapsedUs(elapsedUs: number): number {
  return rationalVideoTimeForFrameIndex(frameIndexForElapsedUs(elapsedUs));
}

/**
 * Exact inverse of rationalVideoTimeForFrameIndex on canonical timestamps:
 * recovers the frame index i whose canonical timestamp equals videoTimeUs.
 * Canonical timestamps satisfy video = floor(i x 1e6 / 30), hence
 * video x 30 / 1e6 lies within 3e-5 below i, so round() recovers i exactly;
 * computed with integer arithmetic as floor((video x 60 + 1e6) / 2e6).
 * video <= 1,802,000,000 us so video x 60 <= 1.09e11, inside safe integers.
 */
export function frameIndexForVideoTimeUs(videoTimeUs: number): number {
  if (!Number.isInteger(videoTimeUs) || videoTimeUs < 0) {
    throw new Error("[TIMELINE_INVALID] video time must be an integer >= 0");
  }
  if (videoTimeUs > MAX_TAKE_DURATION_US) {
    throw new Error("[TIMELINE_INVALID] video time exceeds take ceiling");
  }
  return Math.floor(
    (videoTimeUs * TIMELINE_FPS * 2 + MICROS_PER_SECOND) / (2 * MICROS_PER_SECOND),
  );
}

/** Mapping error for the floor policy: elapsed - video_time in [0, interval]. */
export function mappingErrorForElapsedUs(elapsedUs: number): number {
  return elapsedUs - videoTimeForElapsedUs(elapsedUs);
}

// ---------------------------------------------------------------------------
// Cross-Domain Mapping (explicit, via the immutable epoch)
// ---------------------------------------------------------------------------

/** Runtime timestamp (ms domain) -> take-relative elapsed (us). */
export function runtimeMsToElapsedUs(
  runtimeMs: number,
  epoch: TimelineEpoch,
): number {
  if (!Number.isInteger(runtimeMs) || runtimeMs < 0) {
    throw new Error("[TIMELINE_INVALID] runtime timestamp must be an integer >= 0");
  }
  if (runtimeMs < epoch.runtime_epoch_ms) {
    throw new Error("[TIMELINE_INVALID] runtime event precedes take epoch");
  }
  const elapsed = (runtimeMs - epoch.runtime_epoch_ms) * 1000;
  if (!Number.isSafeInteger(elapsed) || elapsed > MAX_TAKE_DURATION_US) {
    throw new Error("[TIMELINE_INVALID] runtime elapsed exceeds take ceiling");
  }
  return elapsed;
}

/** Capture timestamp (us domain) -> take-relative elapsed (us). */
export function captureUsToElapsedUs(
  captureUs: number,
  epoch: TimelineEpoch,
): number {
  if (!Number.isInteger(captureUs) || captureUs < 0) {
    throw new Error("[TIMELINE_INVALID] capture timestamp must be an integer >= 0");
  }
  if (captureUs < epoch.capture_epoch_us) {
    throw new Error("[TIMELINE_INVALID] capture frame precedes take epoch");
  }
  const elapsed = captureUs - epoch.capture_epoch_us;
  if (!Number.isSafeInteger(elapsed) || elapsed > MAX_TAKE_DURATION_US) {
    throw new Error("[TIMELINE_INVALID] capture elapsed exceeds take ceiling");
  }
  return elapsed;
}

/** Runtime timestamp -> capture-domain equivalent (for diagnostics only). */
export function runtimeMsToCaptureUs(
  runtimeMs: number,
  epoch: TimelineEpoch,
): number {
  return epoch.capture_epoch_us + runtimeMsToElapsedUs(runtimeMs, epoch);
}

/** Capture timestamp -> runtime-domain equivalent ms (floor, diagnostics). */
export function captureUsToRuntimeMs(
  captureUs: number,
  epoch: TimelineEpoch,
): number {
  const elapsed = captureUsToElapsedUs(captureUs, epoch);
  return epoch.runtime_epoch_ms + Math.floor(elapsed / 1000);
}

/** Runtime timestamp -> floor-policy video_time_us (canonical event mapping). */
export function videoTimeForRuntimeMs(
  runtimeMs: number,
  epoch: TimelineEpoch,
): { video_time_us: number; elapsed_us: number; mapping_error_us: number } {
  const elapsed = runtimeMsToElapsedUs(runtimeMs, epoch);
  const videoTime = videoTimeForElapsedUs(elapsed);
  return {
    video_time_us: videoTime,
    elapsed_us: elapsed,
    mapping_error_us: elapsed - videoTime,
  };
}

/** Capture timestamp -> floor-policy video_time_us (diagnostics/correlation). */
export function videoTimeForCaptureUs(
  captureUs: number,
  epoch: TimelineEpoch,
): { video_time_us: number; elapsed_us: number; mapping_error_us: number } {
  const elapsed = captureUsToElapsedUs(captureUs, epoch);
  const videoTime = videoTimeForElapsedUs(elapsed);
  return {
    video_time_us: videoTime,
    elapsed_us: elapsed,
    mapping_error_us: elapsed - videoTime,
  };
}

// ---------------------------------------------------------------------------
// P10 Audio Seam (timing metadata only, no audio)
// ---------------------------------------------------------------------------

/**
 * Deterministic helper: video_time_us -> future 48 kHz audio sample index.
 * Integer arithmetic: floor(video_time_us x 48000 / 1e6). Timing metadata
 * only — no audio files, no synthesis, no muxing (P10 scope).
 */
export function videoTimeUsToAudioSampleIndex(videoTimeUs: number): number {
  if (!Number.isInteger(videoTimeUs) || videoTimeUs < 0) {
    throw new Error("[TIMELINE_INVALID] video time must be an integer >= 0");
  }
  if (videoTimeUs > MAX_TAKE_DURATION_US) {
    throw new Error("[TIMELINE_INVALID] video time exceeds take ceiling");
  }
  return Math.floor((videoTimeUs * P10_AUDIO_SAMPLE_RATE_HZ) / MICROS_PER_SECOND);
}
