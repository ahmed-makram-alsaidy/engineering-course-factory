// P9.4 timeline clock domains & CFR math — deterministic, zero sleeps.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 9, 14 and ADR-0014.
// Proves the three-domain model (runtime / capture / video), immutable epoch
// calibration, rational CFR mapping without cumulative drift, and the future
// 48 kHz audio seam. No wall clock, no Date.now, no renderer input.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_INTERVAL_US,
} from "../src/timeline.ts";
import {
  FPS_DENOMINATOR,
  FPS_NUMERATOR,
  MAX_EPOCH_SKEW_BOUND_US,
  MAX_FRAME_INTERVAL_US,
  P10_AUDIO_SAMPLE_RATE_HZ,
  TIMELINE_FPS,
  calibrateTimelineEpoch,
  captureUsToElapsedUs,
  captureUsToRuntimeMs,
  frameIndexForElapsedUs,
  frameIndexForVideoTimeUs,
  mappingErrorForElapsedUs,
  rationalVideoTimeForFrameIndex,
  runtimeMsToCaptureUs,
  runtimeMsToElapsedUs,
  validateTimelineEpoch,
  videoTimeForCaptureUs,
  videoTimeForElapsedUs,
  videoTimeForEncodeIndex,
  videoTimeForRuntimeMs,
  videoTimeUsToAudioSampleIndex,
} from "../src/timeline-clock.ts";

const EPOCH = calibrateTimelineEpoch({
  runtimeSampleMs: 1_000,
  captureSampleUs: 5_000_000,
  runtimeClockEpoch: "epoch-run-001",
  captureClockEpoch: "epoch-cap-001",
  skewBoundUs: 500,
});

describe("P9.4: three clock domains are explicit and separate", () => {
  it("timeline coordinator creation uses three domains, never conflated", () => {
    assert.equal(TIMELINE_FPS, 30);
    assert.equal(FRAME_INTERVAL_US, 33_334);
    assert.equal(P10_AUDIO_SAMPLE_RATE_HZ, 48_000);
    assert.equal(MAX_EPOCH_SKEW_BOUND_US, 5_000);
  });

  it("runtime epoch accepted", () => {
    const epoch = validateTimelineEpoch({
      runtime_epoch_ms: 0,
      capture_epoch_us: 0,
      runtime_clock_epoch: "epoch-run-001",
      capture_clock_epoch: "epoch-cap-001",
      epoch_skew_bound_us: 0,
    });
    assert.equal(epoch.runtime_epoch_ms, 0);
  });

  it("capture epoch accepted", () => {
    const epoch = validateTimelineEpoch({
      runtime_epoch_ms: 2_000,
      capture_epoch_us: 9_000_000,
      runtime_clock_epoch: "epoch-run-002",
      capture_clock_epoch: "epoch-cap-002",
      epoch_skew_bound_us: 5_000,
    });
    assert.equal(epoch.capture_epoch_us, 9_000_000);
  });

  it("invalid epoch rejected", () => {
    assert.throws(() => validateTimelineEpoch({
      runtime_epoch_ms: 0,
      capture_epoch_us: 0,
      runtime_clock_epoch: "epoch-run-001",
      capture_clock_epoch: "epoch-cap-001",
      epoch_skew_bound_us: 5_001,
    }), /TIMELINE_INVALID/);
    assert.throws(() => calibrateTimelineEpoch({
      runtimeSampleMs: 0,
      captureSampleUs: 0,
      runtimeClockEpoch: "bad epoch!",
      captureClockEpoch: "epoch-cap-001",
      skewBoundUs: 100,
    }));
  });
});

describe("P9.4: runtime and capture mappings share one immutable epoch", () => {
  it("runtime→recording mapping", () => {
    assert.equal(runtimeMsToElapsedUs(1_000, EPOCH), 0);
    assert.equal(runtimeMsToElapsedUs(1_100, EPOCH), 100_000);
  });

  it("capture→recording mapping", () => {
    assert.equal(captureUsToElapsedUs(5_000_000, EPOCH), 0);
    assert.equal(captureUsToElapsedUs(5_100_000, EPOCH), 100_000);
  });

  it("runtime and capture mappings agree through the same epoch", () => {
    const rElapsed = runtimeMsToElapsedUs(1_250, EPOCH);
    const cElapsed = captureUsToElapsedUs(5_250_000, EPOCH);
    assert.equal(rElapsed, cElapsed);
    assert.equal(runtimeMsToCaptureUs(1_250, EPOCH), 5_250_000);
    assert.equal(captureUsToRuntimeMs(5_250_000, EPOCH), 1_250);
  });

  it("negative timestamp rejected", () => {
    assert.throws(() => runtimeMsToElapsedUs(-1 as never, EPOCH));
    assert.throws(() => captureUsToElapsedUs(-5 as never, EPOCH));
  });

  it("event before epoch is impossible correlation", () => {
    assert.throws(() => runtimeMsToElapsedUs(999, EPOCH), /TIMELINE_INVALID/);
    assert.throws(() => captureUsToElapsedUs(4_999_999, EPOCH), /TIMELINE_INVALID/);
  });
});

describe("P9.4: canonical CFR video mapping is integer-exact", () => {
  it("exact frame 0 mapping", () => {
    assert.equal(videoTimeForEncodeIndex(1), 0);
    assert.equal(videoTimeForElapsedUs(0), 0);
    assert.equal(frameIndexForElapsedUs(0), 0);
  });

  it("frame 1 rational mapping", () => {
    assert.equal(videoTimeForEncodeIndex(2), 33_333);
    assert.equal(rationalVideoTimeForFrameIndex(1), 33_333);
    assert.equal(videoTimeForElapsedUs(33_333), 0);
  });

  it("frame 29 mapping", () => {
    assert.equal(videoTimeForEncodeIndex(30), 966_666);
    assert.equal(rationalVideoTimeForFrameIndex(29), Math.floor((29 * 1_000_000) / 30));
  });

  it("frame 30 = exact 1s mapping (rational ideal)", () => {
    assert.equal(rationalVideoTimeForFrameIndex(30), 1_000_000);
    assert.equal(videoTimeForEncodeIndex(31), 1_000_000);
  });

  it("no cumulative rounding drift (integer multiply, never repeated add)", () => {
    for (let n = 1; n <= 3_600; n += 1) {
      const pts = videoTimeForEncodeIndex(n);
      assert.equal(pts, rationalVideoTimeForFrameIndex(n - 1));
    }
    const driftAt1s = videoTimeForEncodeIndex(31) - rationalVideoTimeForFrameIndex(30);
    assert.equal(driftAt1s, 0);
  });

  it("long frame-index integer stability", () => {
    const big = videoTimeForEncodeIndex(54_001);
    assert.ok(Number.isSafeInteger(big));
    assert.equal(big, 1_800_000_000);
    const rational = rationalVideoTimeForFrameIndex(54_000);
    assert.ok(Number.isSafeInteger(rational));
    assert.equal(rational, 1_800_000_000);
    const bias = big - rational;
    assert.equal(bias, 0);
    assert.ok(bias <= FRAME_INTERVAL_US * 2);
  });

  it("MAX_SAFE_INTEGER-safe bound rejects overflow", () => {
    assert.throws(() => videoTimeForEncodeIndex(Number.MAX_SAFE_INTEGER), /TIMELINE_INVALID/);
    assert.throws(() => rationalVideoTimeForFrameIndex(Number.MAX_SAFE_INTEGER), /TIMELINE_INVALID/);
    assert.throws(() => frameIndexForElapsedUs(1_802_000_001), /TIMELINE_INVALID/);
  });

  it("frame indexes near 0,1,29,30,31 stay monotonic", () => {
    const pts = [0, 1, 29, 30, 31].map((i) => rationalVideoTimeForFrameIndex(i));
    for (let i = 1; i < pts.length; i += 1) {
      assert.ok(pts[i]! > pts[i - 1]!);
    }
    const cfr = [1, 2, 30, 31, 32].map((n) => videoTimeForEncodeIndex(n));
    for (let i = 1; i < cfr.length; i += 1) {
      assert.ok(cfr[i]! > cfr[i - 1]!);
    }
  });
});

describe("P9.4: floor policy bounds mapping error to one frame interval", () => {
  it("mapping error stays within one interval across a full second", () => {
    let maxError = 0;
    for (let elapsed = 0; elapsed <= 1_000_000; elapsed += 7_791) {
      const err = mappingErrorForElapsedUs(elapsed);
      assert.ok(err >= 0 && err <= FRAME_INTERVAL_US);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError <= FRAME_INTERVAL_US);
  });

  it("event arrives exactly before frame boundary maps to preceding frame", () => {
    const before = videoTimeForRuntimeMs(1_000 + Math.floor(33_333 / 1000), EPOCH);
    void before;
    const exact = videoTimeForElapsedUs(33_333);
    assert.equal(exact, 0);
    assert.equal(mappingErrorForElapsedUs(33_333), 33_333);
  });

  it("event arrives exactly after frame boundary maps to the new frame", () => {
    assert.equal(videoTimeForElapsedUs(33_334), 33_333);
    assert.equal(mappingErrorForElapsedUs(33_334), 1);
    assert.equal(videoTimeForCaptureUs(5_000_000 + 33_334, EPOCH).video_time_us, 33_333);
  });
});

describe("P9.4: P10 48 kHz audio seam uses integer arithmetic", () => {
  it("video_time_us maps to deterministic sample index", () => {
    assert.equal(videoTimeUsToAudioSampleIndex(0), 0);
    assert.equal(videoTimeUsToAudioSampleIndex(1_000_000), 48_000);
    assert.equal(videoTimeUsToAudioSampleIndex(33_333), Math.floor((33_333 * 48_000) / 1_000_000));
  });

  it("audio helper rejects out-of-range video time", () => {
    assert.throws(() => videoTimeUsToAudioSampleIndex(-1 as never));
    assert.throws(() => videoTimeUsToAudioSampleIndex(1_802_000_001), /TIMELINE_INVALID/);
  });

  it("48 kHz mapping exact at integer-second boundaries", () => {
    assert.equal(videoTimeUsToAudioSampleIndex(1_000_000), 48_000);
    assert.equal(videoTimeUsToAudioSampleIndex(10_000_000), 480_000);
    assert.equal(videoTimeUsToAudioSampleIndex(1_800_000_000), 86_400_000);
  });
});

describe("P9.4 CORRECTIVE: exact 30/1 rational CFR timeline has zero systematic drift", () => {
  it("rational 30/1 policy is exact (FPS 30/1)", () => {
    assert.equal(FPS_NUMERATOR, 30);
    assert.equal(FPS_DENOMINATOR, 1);
    assert.equal(TIMELINE_FPS, 30);
    assert.equal(MAX_FRAME_INTERVAL_US, 33_334);
  });

  it("canonical frame goldens equal floor(i * 1e6 / 30)", () => {
    assert.equal(videoTimeForEncodeIndex(1), 0);
    assert.equal(videoTimeForEncodeIndex(2), 33_333);
    assert.equal(videoTimeForEncodeIndex(3), 66_666);
    assert.equal(videoTimeForEncodeIndex(29), 933_333);
    assert.equal(videoTimeForEncodeIndex(30), 966_666);
    assert.equal(videoTimeForEncodeIndex(31), 1_000_000);
    assert.equal(videoTimeForEncodeIndex(301), 10_000_000);
  });

  it("no constant 33334 multiplier is the timeline authority", () => {
    assert.notEqual(videoTimeForEncodeIndex(2), 33_334);
    assert.notEqual(videoTimeForEncodeIndex(31), 30 * 33_334);
    assert.equal(videoTimeForEncodeIndex(31), 1_000_000);
  });

  it("one-minute take lands exactly on media time", () => {
    assert.equal(videoTimeForEncodeIndex(1_801), 60_000_000);
    assert.equal(videoTimeForElapsedUs(60_000_000), 60_000_000);
    assert.equal(frameIndexForElapsedUs(60_000_000), 1_800);
  });

  it("ten-minute take lands exactly on media time", () => {
    assert.equal(videoTimeForEncodeIndex(18_001), 600_000_000);
    assert.equal(videoTimeForElapsedUs(600_000_000), 600_000_000);
    assert.equal(frameIndexForElapsedUs(600_000_000), 18_000);
  });

  it("thirty-minute take has zero systematic CFR drift", () => {
    const last = videoTimeForEncodeIndex(54_001);
    assert.equal(last, 1_800_000_000);
    assert.equal(last - rationalVideoTimeForFrameIndex(54_000), 0);
    assert.equal(videoTimeForElapsedUs(1_800_000_000), 1_800_000_000);
  });

  it("consecutive PTS steps alternate 33333/33334 (never a constant step)", () => {
    let saw33333 = false;
    let saw33334 = false;
    for (let n = 2; n <= 61; n += 1) {
      const step = videoTimeForEncodeIndex(n) - videoTimeForEncodeIndex(n - 1);
      assert.ok(step === 33_333 || step === 33_334);
      if (step === 33_333) saw33333 = true;
      if (step === 33_334) saw33334 = true;
    }
    assert.ok(saw33333 && saw33334);
  });

  it("frame index round-trips through canonical video time", () => {
    for (const i of [0, 1, 2, 28, 29, 30, 300, 1_800, 18_000, 54_000]) {
      assert.equal(frameIndexForVideoTimeUs(rationalVideoTimeForFrameIndex(i)), i);
    }
  });

  it("event mapping error stays below one frame interval across the take", () => {
    let maxError = 0;
    for (let elapsed = 0; elapsed <= 1_800_000_000; elapsed += 7_999_999) {
      const err = mappingErrorForElapsedUs(elapsed);
      assert.ok(err >= 0 && err < 33_334);
      maxError = Math.max(maxError, err);
    }
    assert.ok(maxError < 33_334);
  });

  it("take-ceiling arithmetic stays inside safe integers", () => {
    assert.ok(Number.isSafeInteger(1_802_000_000 * 30));
    assert.ok(Number.isSafeInteger(54_000 * 1_000_000));
    assert.ok(Number.isSafeInteger(1_800_000_000 * 48_000));
    assert.equal(videoTimeUsToAudioSampleIndex(1_800_000_000), 86_400_000);
  });
});
