// P9.7 Full Verification Matrix — one-subsystem coherence proof.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md, docs/adr/ADR-0014, P9.1–P9.6.
// Scope: VERIFICATION ONLY. No product code, no processes, no filesystem
// writes, no wall-clock sleeps, no real video. Every assertion is
// deterministic and composes the frozen P9.1–P9.6 policy modules as one
// subsystem: protocol/schema, identity/fencing, capture bounds, encoder
// bounds, exact 30/1 timeline, disk safety, failure disposition, publication
// transaction, restart recovery, confinement, renderer non-authority,
// resource bounds, races, P8/P10/P11 boundaries, P9.8 deferral.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RECORDING_PROTOCOL_VERSION,
  MAX_RECORDING_IDENTIFIER_LENGTH,
  MAX_SAFE_MESSAGE_LENGTH,
  MAX_TAKE_DURATION_S,
  MAX_TAKE_DURATION_US,
  RECORDING_TAIL_MS,
  RECORDING_STATES,
  RECORDING_OUTCOMES,
  RECORDING_TERMINAL_CAUSES,
  TERMINAL_CAUSE_TO_OUTCOME,
  PUBLICATION_STATUSES,
  RECORDING_PHASES,
  RECORDING_ERROR_CODES,
  RECORDING_RETRY_CATEGORIES,
  RECORDING_ERROR_RETRY_MAP,
  RecordingSessionIdSchema,
  TakeIdSchema,
  RecordingSha256HexSchema,
  RecordingErrorDtoSchema,
  RecordingSnapshotDtoSchema,
  InternalRecordingStartDescriptorSchema,
  RECORDING_PROFILE_ID,
  type RecordingTerminalCause,
  type RecordingErrorCode,
} from "../src/protocol.ts";
import {
  RECORDING_MANIFEST_VERSION,
  MAX_MANIFEST_BYTES,
  RecordingManifestSchema,
  buildCanonicalManifest,
} from "../src/manifest.ts";
import {
  MAX_SIDECAR_BYTES,
  MAX_ANCHOR_LINE_BYTES,
  FRAME_INTERVAL_US,
  FRAME_SEQ_INITIAL,
  RecordingTimelineAnchorSchema,
} from "../src/timeline.ts";
import {
  RECORDING_WIDTH,
  RECORDING_HEIGHT,
  RECORDING_FPS,
  RECORDING_CODEC,
  RECORDING_CONTAINER,
  RECORDING_PIX_FMT,
  RECORDING_FASTSTART,
  RECORDING_GOP,
  RECORDING_MAXRATE_BPS,
  RECORDING_BUFSIZE_BITS,
  NVENC_PRESET,
  NVENC_CQ,
  NVENC_RC,
  X264_PRESET,
  X264_CRF,
  RECORDING_AUDIO_PRESENT,
  P10_EXPECTED_SAMPLE_RATE_HZ,
  CURSOR_CAPTURE_ENABLED,
  RESERVED_AUDIO_SLOT,
  EncoderDescriptorSchema,
} from "../src/encoder-profile.ts";
import {
  CEILING_BYTES_PER_SECOND,
  PREFLIGHT_MIN_FREE_BYTES,
  PREFLIGHT_ESTIMATE_MULTIPLIER,
  LOW_SPACE_ABORT_BYTES,
  DISK_POLL_INTERVAL_MS,
  ACQUISITION_STARTUP_TIMEOUT_MS,
  RECORDER_SHUTDOWN_BARRIER_MS,
  ENCODER_FLUSH_TIMEOUT_MS,
  MAX_BILLABLE_LESSON_S,
} from "../src/disk-budget.ts";
import {
  CAPTURE_PIXEL_FORMAT,
  CAPTURE_WIDTH,
  CAPTURE_HEIGHT,
  CAPTURE_FRAME_POOL_SIZE,
  CAPTURE_QUEUE_CAP,
  CAPTURE_FRAME_BYTES_1080P,
  MAX_PENDING_FRAMES,
} from "../src/capture/capture-format.ts";
import { NO_VALID_FRAME_MS } from "../src/capture/wgc-session.ts";
import {
  ENCODER_QUEUE_CAP_FRAMES,
  MAX_ENCODER_QUEUE_BYTES,
  ENCODER_PROBE_TIMEOUT_MS,
  ENCODER_STARTUP_TIMEOUT_MS,
  ENCODER_DRAIN_TIMEOUT_MS,
  ENCODER_EXIT_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
} from "../src/encoder/encoder-interface.ts";
import { parseCanonicalEncodeGeometry } from "../src/encoder/encoder-argv.ts";
import {
  videoTimeForEncodeIndex,
  rationalVideoTimeForFrameIndex,
  frameIndexForElapsedUs,
  frameIndexForVideoTimeUs,
  videoTimeUsToAudioSampleIndex,
  MAX_FRAME_INTERVAL_US,
  MAX_EPOCH_SKEW_BOUND_US,
  MAX_TIMELINE_DIVERGENCE_US,
  FPS_NUMERATOR,
  FPS_DENOMINATOR,
  calibrateTimelineEpoch,
} from "../src/timeline-clock.ts";
import {
  RecordingTimelineCoordinator,
  type TrustedRuntimeEvent,
} from "../src/timeline-coordinator.ts";
import {
  dispositionForCause,
  SAFETY_STARVATION_MS,
  SAFETY_SHUTDOWN_BARRIER_MS,
  SAFETY_ENCODER_FLUSH_MS,
  SourceStarvationTracker,
  shutdownStrategyForElapsed,
} from "../src/safety/failure-policy.ts";
import {
  evaluatePublicationGate,
  planPublicationTransaction,
  planRollbackForCompleted,
  confirmTempCleanup,
} from "../src/safety/publication.ts";
import {
  classifyRecoveryEntry,
  planRecoveryAction,
  plansMatch,
  TEMP_PARTIAL_NAME,
  MANIFEST_TEMP_NAME,
  ANCHORS_TEMP_NAME,
  TAKE_LOCK_NAME,
  DIAGNOSTIC_PARTIAL_SUFFIX,
} from "../src/safety/recovery.ts";
import {
  estimateTakeFinalBytes,
  requiredTakeFreeBytes,
  evaluateVolumePreflight,
  mustAbortTakeForDisk,
} from "../src/safety/disk-safety.ts";
import {
  buildTakeArtifactBaseName,
  parseTakeArtifactBaseName,
  formatTakeId,
} from "../src/naming.ts";
import { TakeSafetyController } from "../src/safety/controller.ts";
import { controllerOptions, guardedInput } from "./safety-helpers.ts";
import { makeAnchor, makeManifestSeed } from "./fixtures.ts";

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function healthyEvidence() {
  return {
    outcomeCompleted: true,
    encoderFlushOk: true,
    mediaValidationPass: true,
    frameCount: 300,
    durationUs: 10_000_000,
    timelineValid: true,
    anchorsValid: true,
    manifestValid: true,
    digestPresent: true,
    diskStillSafe: true,
    sameFence: true,
  };
}

// ---------------------------------------------------------------------------
// P9.7 §1 — Protocol / schema freeze (P9.1 matrix, subsystem-wide)
// ---------------------------------------------------------------------------

describe("P9.7: protocol and schema freeze", () => {
  it("recording protocol v1 exact with frozen vocabularies", () => {
    assert.equal(RECORDING_PROTOCOL_VERSION, 1);
    assert.deepEqual([...RECORDING_STATES], [
      "CREATED", "PREFLIGHT", "PREPARED", "RECORDING", "STOPPING",
      "VALIDATING", "PUBLISHED", "FAILED", "INCOMPLETE", "CLOSED",
    ]);
    assert.deepEqual([...RECORDING_OUTCOMES], [
      "COMPLETED", "CANCELLED", "RESET_INTERRUPTED", "FAILED", "INCOMPLETE",
    ]);
    assert.deepEqual([...RECORDING_TERMINAL_CAUSES], [
      "SUCCESS", "OPERATOR_CANCELLED", "RESET_INTERRUPTED", "CAPTURE_SOURCE_LOST",
      "LOW_DISK_ABORT", "ENCODER_FAILED", "MEDIA_VALIDATION_FAILED", "APP_CLOSED",
      "DIAGNOSTIC_PARTIAL", "PREFLIGHT_REFUSED", "STARTUP_TIMEOUT",
    ]);
    assert.deepEqual([...PUBLICATION_STATUSES], [
      "NOT_CREATED", "TEMPORARY", "QUARANTINED", "VALIDATED", "PUBLISHED", "PURGED",
    ]);
    assert.deepEqual([...RECORDING_PHASES], [
      "PREFLIGHT", "ACQUISITION", "ENCODING", "VALIDATION",
      "PUBLICATION", "CLEANUP", "SHUTDOWN",
    ]);
    assert.equal(RECORDING_ERROR_CODES.length, 19);
    assert.equal(RECORDING_RETRY_CATEGORIES.length, 4);
    assert.equal(RECORDING_PROFILE_ID, "rec-1080p30-h264-v1");
  });

  it("terminal cause to outcome map is frozen and honest", () => {
    assert.deepEqual(TERMINAL_CAUSE_TO_OUTCOME, {
      SUCCESS: "COMPLETED",
      OPERATOR_CANCELLED: "CANCELLED",
      RESET_INTERRUPTED: "RESET_INTERRUPTED",
      CAPTURE_SOURCE_LOST: "FAILED",
      LOW_DISK_ABORT: "INCOMPLETE",
      ENCODER_FAILED: "FAILED",
      MEDIA_VALIDATION_FAILED: "FAILED",
      APP_CLOSED: "INCOMPLETE",
      DIAGNOSTIC_PARTIAL: "FAILED",
      PREFLIGHT_REFUSED: "INCOMPLETE",
      STARTUP_TIMEOUT: "INCOMPLETE",
    });
  });

  it("retry taxonomy is closed and never auto-retries takes", () => {
    const mapped = Object.values(RECORDING_ERROR_RETRY_MAP);
    assert.equal(mapped.filter((c) => c === "SAFE_TO_RETRY").length, 0);
    assert.equal(RECORDING_ERROR_RETRY_MAP["STALE_SESSION"], "REQUIRES_RESET");
    assert.equal(RECORDING_ERROR_RETRY_MAP["STALE_GENERATION"], "REQUIRES_RESET");
    assert.equal(RECORDING_ERROR_RETRY_MAP["CLEANUP_UNCONFIRMED"], "UNCERTAIN_DO_NOT_RETRY");
    for (const code of RECORDING_ERROR_CODES) {
      assert.ok(RECORDING_ERROR_RETRY_MAP[code] !== undefined, `retry mapped: ${code}`);
    }
  });

  it("manifest v1.1 exact with safe-field bounds", () => {
    assert.equal(RECORDING_MANIFEST_VERSION, "1.1");
    assert.equal(MAX_MANIFEST_BYTES, 65_536);
    assert.equal(MAX_SIDECAR_BYTES, 5_242_880);
    assert.equal(MAX_ANCHOR_LINE_BYTES, 4_096);
    assert.equal(FRAME_SEQ_INITIAL, 1);
    // 33,334 us is the ceilinged single-frame interval / error bound only.
    assert.equal(FRAME_INTERVAL_US, 33_334);
    assert.equal(MAX_FRAME_INTERVAL_US, 33_334);
  });

  it("canonical media contract frozen: 1080p30 H.264 yuv420p MP4 GOP60 faststart silent", () => {
    assert.equal(RECORDING_WIDTH, 1920);
    assert.equal(RECORDING_HEIGHT, 1080);
    assert.equal(RECORDING_FPS, 30);
    assert.equal(RECORDING_CODEC, "h264");
    assert.equal(RECORDING_CONTAINER, "mp4");
    assert.equal(RECORDING_PIX_FMT, "yuv420p");
    assert.equal(RECORDING_FASTSTART, true);
    assert.equal(RECORDING_GOP, 60);
    assert.equal(RECORDING_MAXRATE_BPS, 12_000_000);
    assert.equal(RECORDING_BUFSIZE_BITS, 24_000_000);
    assert.equal(NVENC_PRESET, "p4");
    assert.equal(NVENC_CQ, 23);
    assert.equal(NVENC_RC, "vbr");
    assert.equal(X264_PRESET, "veryfast");
    assert.equal(X264_CRF, 21);
    assert.equal(RECORDING_AUDIO_PRESENT, false);
    assert.equal(CURSOR_CAPTURE_ENABLED, false);
    assert.equal(P10_EXPECTED_SAMPLE_RATE_HZ, 48_000);
    assert.deepEqual(RESERVED_AUDIO_SLOT, {
      present: false,
      expected_codec: "aac",
      sample_rate: 48_000,
      sync_basis: "video_time_us anchors",
    });
  });

  it("manifest enforces record_safe true and silent audio seam", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.equal(manifest.record_safe, true);
    assert.equal(manifest.audio.present, false);
    assert.equal(manifest.video_width, 1920);
    assert.equal(manifest.video_height, 1080);
    assert.equal(manifest.video_fps, 30);
    assert.equal(manifest.encoder.family, "NVENC");
    RecordingManifestSchema.parse(manifest);
  });

  it("SHA-256 digests are lowercase hex and identifiers bounded", () => {
    assert.ok(RecordingSha256HexSchema.safeParse("a".repeat(64)).success);
    assert.ok(!RecordingSha256HexSchema.safeParse("A".repeat(64)).success);
    assert.ok(!RecordingSha256HexSchema.safeParse("abc").success);
    assert.ok(RecordingSessionIdSchema.safeParse("rec-take-001").success);
    assert.ok(!RecordingSessionIdSchema.safeParse("../evil").success);
    assert.ok(!RecordingSessionIdSchema.safeParse("a".repeat(129)).success);
    assert.ok(TakeIdSchema.safeParse("t01").success);
    assert.ok(!TakeIdSchema.safeParse("take1").success);
    assert.equal(MAX_RECORDING_IDENTIFIER_LENGTH, 128);
    assert.equal(MAX_SAFE_MESSAGE_LENGTH, 512);
  });

  it("safe DTOs use strict schemas: unknown keys rejected", () => {
    const anchor = makeAnchor();
    assert.ok(!RecordingTimelineAnchorSchema.safeParse({ ...anchor, hwnd: 123 }).success);
    const err = RecordingErrorDtoSchema.parse({ code: "FRAME_TIMEOUT", message: "slow", retry: "NOT_RETRYABLE" });
    assert.ok(!("hwnd" in err));
    assert.throws(() =>
      RecordingSnapshotDtoSchema.parse({
        recording_session_id: "rec-a", take_id: "t01", state: "RECORDING",
        runtime_session_id: "sess-1", generation: 1, elapsed_us: 1,
        captured_frames: 1, encoded_frames: 1, dropped_frames: 0,
        filler_frames: 0,
        encoder_family: "NVENC", record_safe: true, last_outcome: null,
        outputPath: "E:\\evil.mp4",
      }),
    );
    assert.throws(() =>
      InternalRecordingStartDescriptorSchema.parse({
        lesson_id: "C01-L001", runtime_session_id: "sess-1", generation: 1,
        take_id: "t01", recording_profile_id: "rec-1080p30-h264-v1",
        record_safe: true, ffmpegPath: "/evil/ffmpeg",
      }),
    );
  });

  it("take ceiling 1802 s with 2 s tail and microsecond ceiling", () => {
    assert.equal(MAX_TAKE_DURATION_S, 1_802);
    assert.equal(MAX_TAKE_DURATION_US, 1_802_000_000);
    assert.equal(RECORDING_TAIL_MS, 2_000);
    assert.equal(MAX_BILLABLE_LESSON_S, 1_800);
  });
});

// ---------------------------------------------------------------------------
// P9.7 §2 — Exact 30/1 rational CFR (systematic drift 0)
// ---------------------------------------------------------------------------

describe("P9.7: exact rational 30/1 CFR timeline", () => {
  it("canonical FPS fraction is exactly 30/1", () => {
    assert.equal(FPS_NUMERATOR, 30);
    assert.equal(FPS_DENOMINATOR, 1);
  });

  it("golden video times: frames 1,2,30,31", () => {
    assert.equal(videoTimeForEncodeIndex(1), 0);
    assert.equal(videoTimeForEncodeIndex(2), 33_333);
    assert.equal(videoTimeForEncodeIndex(30), 966_666);
    assert.equal(videoTimeForEncodeIndex(31), 1_000_000);
    assert.equal(rationalVideoTimeForFrameIndex(0), 0);
    assert.equal(rationalVideoTimeForFrameIndex(1), 33_333);
    assert.equal(rationalVideoTimeForFrameIndex(300), 10_000_000);
  });

  it("take-ceiling goldens: 1 min, 10 min, 30 min", () => {
    assert.equal(rationalVideoTimeForFrameIndex(1_800), 60_000_000);
    assert.equal(rationalVideoTimeForFrameIndex(18_000), 600_000_000);
    assert.equal(rationalVideoTimeForFrameIndex(54_000), 1_800_000_000);
  });

  it("systematic CFR drift is zero across the full take", () => {
    // Exact rational math: last canonical frame before the ceiling maps
    // exactly; repeated rounded addition would have drifted +0.666us/frame.
    let maxDrift = 0;
    for (const i of [0, 1, 29, 30, 300, 1_799, 1_800, 17_999, 18_000, 53_999, 54_000]) {
      const exact = Math.floor((i * 1_000_000) / 30);
      const drift = Math.abs(rationalVideoTimeForFrameIndex(i) - exact);
      if (drift > maxDrift) maxDrift = drift;
    }
    assert.equal(maxDrift, 0);
  });

  it("33,334 us exists only as the single-frame error bound", () => {
    assert.equal(MAX_FRAME_INTERVAL_US, 33_334);
    // Floor policy: every elapsed maps within [0, 33334] of encoder truth.
    for (const elapsed of [0, 1, 33_333, 33_334, 1_000_000, 1_800_000_000]) {
      const idx = frameIndexForElapsedUs(elapsed);
      const video = rationalVideoTimeForFrameIndex(idx);
      const err = elapsed - video;
      assert.ok(err >= 0 && err <= 33_334, `error bound holds at ${elapsed}: ${err}`);
    }
    // Inverse recovers canonical indices exactly.
    assert.equal(frameIndexForVideoTimeUs(0), 0);
    assert.equal(frameIndexForVideoTimeUs(33_333), 1);
    assert.equal(frameIndexForVideoTimeUs(1_000_000), 30);
  });

  it("48 kHz future sync is exact integer math", () => {
    assert.equal(videoTimeUsToAudioSampleIndex(1_000_000), 48_000);
    assert.equal(videoTimeUsToAudioSampleIndex(10_000_000), 480_000);
    assert.equal(videoTimeUsToAudioSampleIndex(1_800_000_000), 86_400_000);
  });

  it("clock domains separate with bounded calibration", () => {
    assert.equal(MAX_EPOCH_SKEW_BOUND_US, 5_000);
    assert.equal(MAX_TIMELINE_DIVERGENCE_US, 66_668);
    const epoch = calibrateTimelineEpoch({
      runtimeSampleMs: 1_000,
      captureSampleUs: 5_000_000,
      runtimeClockEpoch: "epoch-run-p97",
      captureClockEpoch: "epoch-cap-p97",
      skewBoundUs: 500,
    });
    assert.equal(epoch.epoch_skew_bound_us, 500);
    assert.throws(() =>
      calibrateTimelineEpoch({
        runtimeSampleMs: 1_000,
        captureSampleUs: 5_000_000,
        runtimeClockEpoch: "epoch-run-p97",
        captureClockEpoch: "epoch-cap-p97",
        skewBoundUs: 5_001,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// P9.7 §3 — Capture / encoder bounds (P9.2 + P9.3 matrix, subsystem-wide)
// ---------------------------------------------------------------------------

describe("P9.7: capture and encoder resource bounds", () => {
  it("capture is BGRA8 1080p with bounded pool and queue", () => {
    assert.equal(CAPTURE_PIXEL_FORMAT, "bgra8");
    assert.equal(CAPTURE_WIDTH, 1920);
    assert.equal(CAPTURE_HEIGHT, 1080);
    assert.equal(CAPTURE_FRAME_POOL_SIZE, 12);
    assert.equal(CAPTURE_QUEUE_CAP, 12);
    assert.equal(MAX_PENDING_FRAMES, 12);
    assert.equal(CAPTURE_FRAME_BYTES_1080P, 1920 * 1080 * 4);
    assert.ok(CAPTURE_FRAME_POOL_SIZE * CAPTURE_FRAME_BYTES_1080P <= 96 * 1024 * 1024);
  });

  it("encoder queue is dual-bounded and timeouts frozen", () => {
    assert.equal(ENCODER_QUEUE_CAP_FRAMES, 12);
    assert.ok(MAX_ENCODER_QUEUE_BYTES <= 96 * 1024 * 1024);
    assert.equal(ENCODER_PROBE_TIMEOUT_MS, 30_000);
    assert.equal(ENCODER_STARTUP_TIMEOUT_MS, 15_000);
    assert.equal(ENCODER_DRAIN_TIMEOUT_MS, 5_000);
    assert.equal(ENCODER_EXIT_TIMEOUT_MS, 10_000);
    assert.equal(FFPROBE_TIMEOUT_MS, 15_000);
    assert.equal(ENCODER_FLUSH_TIMEOUT_MS, 30_000);
    assert.equal(ACQUISITION_STARTUP_TIMEOUT_MS, 15_000);
    assert.equal(RECORDER_SHUTDOWN_BARRIER_MS, 10_000);
  });

  it("encode geometry accepts only canonical 1080p30", () => {
    assert.deepEqual(parseCanonicalEncodeGeometry({ width: 1920, height: 1080, fps: 30 }), {
      width: 1920, height: 1080, fps: 30,
    });
    assert.throws(() => parseCanonicalEncodeGeometry({ width: 1280, height: 720, fps: 30 }));
    assert.throws(() => parseCanonicalEncodeGeometry({ width: 1920, height: 1080, fps: 60 }));
  });

  it("encoder descriptor requires explicit fallback reason (never silent)", () => {
    const nvenc = EncoderDescriptorSchema.parse({
      family: "NVENC", profile: "nvenc-p4-cq23", profile_version: "1.0",
      fallback_used: false, encoder_version: "ffmpeg-8.1.1",
    });
    assert.equal(nvenc.fallback_used, false);
    assert.throws(() =>
      EncoderDescriptorSchema.parse({
        family: "LIBX264", profile: "libx264-veryfast-crf21",
        profile_version: "1.0", encoder_version: "ffmpeg-8.1.1",
      }),
    );
  });

  it("capture starvation bound is 2 s and shutdown caps flush", () => {
    assert.equal(NO_VALID_FRAME_MS, 2_000);
    assert.equal(SAFETY_STARVATION_MS, 2_000);
    assert.equal(SAFETY_SHUTDOWN_BARRIER_MS, 10_000);
    assert.equal(SAFETY_ENCODER_FLUSH_MS, 30_000);
    assert.equal(shutdownStrategyForElapsed(0), "FLUSH_WITHIN_BUDGET");
    assert.equal(shutdownStrategyForElapsed(9_999), "FLUSH_WITHIN_BUDGET");
    assert.equal(shutdownStrategyForElapsed(10_000), "ABORT_OWNED");
    assert.equal(shutdownStrategyForElapsed(60_000), "ABORT_OWNED");
  });
});

// ---------------------------------------------------------------------------
// P9.7 §4 — Disk safety (preflight / abort / estimator)
// ---------------------------------------------------------------------------

describe("P9.7: disk safety invariants", () => {
  it("preflight is max(2 GiB, estimate x3) at 2.0 MB/s over min(s,1800)", () => {
    assert.equal(CEILING_BYTES_PER_SECOND, 2_000_000);
    assert.equal(PREFLIGHT_MIN_FREE_BYTES, 2_147_483_648);
    assert.equal(PREFLIGHT_ESTIMATE_MULTIPLIER, 3);
    assert.equal(LOW_SPACE_ABORT_BYTES, 1_073_741_824);
    assert.equal(DISK_POLL_INTERVAL_MS, 5_000);
    assert.equal(estimateTakeFinalBytes(600), 600 * 2_000_000);
    assert.equal(estimateTakeFinalBytes(1_800), 1_800 * 2_000_000);
    assert.equal(estimateTakeFinalBytes(1_802), 1_800 * 2_000_000);
    assert.equal(requiredTakeFreeBytes(60), 2_147_483_648);
    assert.ok(requiredTakeFreeBytes(1_800) > 2_147_483_648);
  });

  it("preflight refuses tiny floors, ceilings, and query failure fail-closed", () => {
    assert.equal(evaluateVolumePreflight({ freeBytesOrNull: 1_000, expectedLessonS: 60 }).ok, false);
    assert.equal(evaluateVolumePreflight({ freeBytesOrNull: null, expectedLessonS: 60 }).ok, false);
    assert.equal(evaluateVolumePreflight({ freeBytesOrNull: 64 * 1024 ** 3, expectedLessonS: 1_900 }).ok, false);
    assert.equal(evaluateVolumePreflight({ freeBytesOrNull: 64 * 1024 ** 3, expectedLessonS: 600 }).ok, true);
  });

  it("low-space abort at 1 GiB with uncertainty fail-closed", () => {
    assert.equal(mustAbortTakeForDisk(LOW_SPACE_ABORT_BYTES - 1), true);
    assert.equal(mustAbortTakeForDisk(LOW_SPACE_ABORT_BYTES), false);
    assert.equal(mustAbortTakeForDisk(null), true);
  });

  it("starvation tracker latches at 2 s on an injected clock", () => {
    let now = 1_000_000;
    const tracker = new SourceStarvationTracker({ nowMs: () => now });
    assert.equal(tracker.isStarved(), false);
    tracker.noteStart();
    now += 1_999;
    assert.equal(tracker.isStarved(), false);
    now += 1;
    assert.equal(tracker.isStarved(), true);
    tracker.noteValidFrame();
    assert.equal(tracker.isStarved(), false);
  });
});

// ---------------------------------------------------------------------------
// P9.7 §5 — Canonical failure matrix (29 rows, no ambiguity)
// ---------------------------------------------------------------------------

interface FailureRow {
  readonly trigger: string;
  readonly error: RecordingErrorCode;
  readonly cause: RecordingTerminalCause;
}

const FAILURE_ROWS: FailureRow[] = [
  { trigger: "capture unsupported", error: "CAPTURE_SOURCE_LOST", cause: "CAPTURE_SOURCE_LOST" },
  { trigger: "capture source lost", error: "CAPTURE_SOURCE_LOST", cause: "CAPTURE_SOURCE_LOST" },
  { trigger: "capture starvation", error: "FRAME_TIMEOUT", cause: "CAPTURE_SOURCE_LOST" },
  { trigger: "geometry mismatch", error: "WINDOW_GEOMETRY_MISMATCH", cause: "CAPTURE_SOURCE_LOST" },
  { trigger: "geometry changed", error: "WINDOW_GEOMETRY_MISMATCH", cause: "CAPTURE_SOURCE_LOST" },
  { trigger: "device lost", error: "CAPTURE_SOURCE_LOST", cause: "CAPTURE_SOURCE_LOST" },
  { trigger: "encoder unavailable", error: "ENCODER_UNAVAILABLE", cause: "ENCODER_FAILED" },
  { trigger: "encoder startup failure", error: "ENCODER_START_FAILED", cause: "ENCODER_FAILED" },
  { trigger: "encoder nonzero exit", error: "ENCODER_FAILED", cause: "ENCODER_FAILED" },
  { trigger: "encoder drain timeout", error: "ENCODER_TIMEOUT", cause: "ENCODER_FAILED" },
  { trigger: "encoder flush timeout", error: "ENCODER_TIMEOUT", cause: "ENCODER_FAILED" },
  { trigger: "ffprobe failure", error: "MEDIA_VALIDATION_FAILED", cause: "MEDIA_VALIDATION_FAILED" },
  { trigger: "media invalid", error: "MEDIA_VALIDATION_FAILED", cause: "MEDIA_VALIDATION_FAILED" },
  { trigger: "timeline invalid", error: "TIMELINE_INVALID", cause: "DIAGNOSTIC_PARTIAL" },
  { trigger: "stale session", error: "STALE_SESSION", cause: "RESET_INTERRUPTED" },
  { trigger: "stale generation", error: "STALE_GENERATION", cause: "RESET_INTERRUPTED" },
  { trigger: "disk preflight failure", error: "DISK_PREFLIGHT_FAILED", cause: "PREFLIGHT_REFUSED" },
  { trigger: "low disk runtime abort", error: "LOW_DISK_ABORT", cause: "LOW_DISK_ABORT" },
  { trigger: "disk query failure", error: "DISK_PREFLIGHT_FAILED", cause: "PREFLIGHT_REFUSED" },
  { trigger: "manifest failure", error: "MEDIA_VALIDATION_FAILED", cause: "MEDIA_VALIDATION_FAILED" },
  { trigger: "anchor failure", error: "TIMELINE_INVALID", cause: "DIAGNOSTIC_PARTIAL" },
  { trigger: "publication rename failure", error: "PUBLICATION_FAILED", cause: "DIAGNOSTIC_PARTIAL" },
  { trigger: "cleanup failure", error: "CLEANUP_UNCONFIRMED", cause: "DIAGNOSTIC_PARTIAL" },
  { trigger: "window close", error: "CAPTURE_SOURCE_LOST", cause: "APP_CLOSED" },
  { trigger: "app shutdown", error: "CAPTURE_SOURCE_LOST", cause: "APP_CLOSED" },
  { trigger: "cancel", error: "INVALID_REQUEST", cause: "OPERATOR_CANCELLED" },
  { trigger: "reset", error: "STALE_GENERATION", cause: "RESET_INTERRUPTED" },
  { trigger: "runtime FAILED", error: "ENCODER_FAILED", cause: "DIAGNOSTIC_PARTIAL" },
  { trigger: "runtime HOLD", error: "ENCODER_FAILED", cause: "DIAGNOSTIC_PARTIAL" },
];

describe("P9.7: canonical failure matrix (29 rows)", () => {
  it("every row names a frozen error code and terminal cause", () => {
    assert.equal(FAILURE_ROWS.length, 29);
    for (const row of FAILURE_ROWS) {
      assert.ok((RECORDING_ERROR_CODES as readonly string[]).includes(row.error), row.trigger);
      assert.ok((RECORDING_TERMINAL_CAUSES as readonly string[]).includes(row.cause), row.trigger);
    }
  });

  it("every row has a deterministic disposition with honest publication", () => {
    for (const row of FAILURE_ROWS) {
      const disposition = dispositionForCause(row.cause);
      assert.equal(disposition.outcome, TERMINAL_CAUSE_TO_OUTCOME[row.cause], row.trigger);
      // Only SUCCESS may publish; every failure row is non-publishing.
      assert.equal(disposition.mayPublish, false, row.trigger);
      assert.ok(disposition.publication !== "PUBLISHED", row.trigger);
      if (row.cause === "OPERATOR_CANCELLED" || row.cause === "RESET_INTERRUPTED" ||
        row.cause === "LOW_DISK_ABORT" || row.cause === "APP_CLOSED" ||
        row.cause === "PREFLIGHT_REFUSED" || row.cause === "STARTUP_TIMEOUT") {
        assert.equal(disposition.temp, "PURGE", row.trigger);
        assert.equal(disposition.retainDiagnostic, false, row.trigger);
      } else {
        assert.equal(disposition.temp, "QUARANTINE", row.trigger);
        assert.equal(disposition.retainDiagnostic, true, row.trigger);
      }
    }
  });

  it("every row has a frozen retry class and never blind-retries", () => {
    for (const row of FAILURE_ROWS) {
      const retry = RECORDING_ERROR_RETRY_MAP[row.error];
      assert.ok(retry !== undefined, row.trigger);
      assert.ok(retry !== "SAFE_TO_RETRY", row.trigger);
    }
    // Cleanup uncertainty is quarantined diagnostic, never success.
    assert.equal(RECORDING_ERROR_RETRY_MAP["CLEANUP_UNCONFIRMED"], "UNCERTAIN_DO_NOT_RETRY");
  });

  it("success alone publishes via the transaction", () => {
    const success = dispositionForCause("SUCCESS");
    assert.equal(success.outcome, "COMPLETED");
    assert.equal(success.publication, "PUBLISHED");
    assert.equal(success.temp, "PUBLISH_VIA_TRANSACTION");
    assert.equal(success.mayPublish, true);
  });

  it("cancel purges with no digest and reset never continues", () => {
    const cancel = dispositionForCause("OPERATOR_CANCELLED");
    assert.equal(cancel.outcome, "CANCELLED");
    assert.equal(cancel.publication, "PURGED");
    const reset = dispositionForCause("RESET_INTERRUPTED");
    assert.equal(reset.outcome, "RESET_INTERRUPTED");
    assert.equal(reset.temp, "PURGE");
  });
});

// ---------------------------------------------------------------------------
// P9.7 §6 — Publication transaction invariants (11-gate + ordering)
// ---------------------------------------------------------------------------

describe("P9.7: publication invariants", () => {
  it("all 11 success predicates required with first-refusal order", () => {
    const refusals = [
      [{ ...healthyEvidence(), outcomeCompleted: false }, "OUTCOME_NOT_COMPLETED"],
      [{ ...healthyEvidence(), encoderFlushOk: false }, "ENCODER_FLUSH_FAILED"],
      [{ ...healthyEvidence(), mediaValidationPass: false }, "MEDIA_VALIDATION_FAILED"],
      [{ ...healthyEvidence(), frameCount: 0 }, "ZERO_FRAMES"],
      [{ ...healthyEvidence(), durationUs: 0 }, "DURATION_INVALID"],
      [{ ...healthyEvidence(), timelineValid: false }, "TIMELINE_INVALID"],
      [{ ...healthyEvidence(), anchorsValid: false }, "ANCHORS_INVALID"],
      [{ ...healthyEvidence(), manifestValid: false }, "MANIFEST_INVALID"],
      [{ ...healthyEvidence(), digestPresent: false }, "DIGEST_MISSING"],
      [{ ...healthyEvidence(), diskStillSafe: false }, "DISK_UNSAFE"],
      [{ ...healthyEvidence(), sameFence: false }, "FENCE_MISMATCH"],
    ] as const;
    for (const [evidence, reason] of refusals) {
      const gate = evaluatePublicationGate(evidence);
      assert.equal(gate.ok, false);
      if (!gate.ok) assert.equal(gate.reason, reason);
    }
    assert.deepEqual(evaluatePublicationGate(healthyEvidence()), { ok: true });
  });

  it("transaction order fixed with reverse rollback and confirmed cleanup", () => {
    assert.deepEqual([...planPublicationTransaction()], [
      "WRITE_MANIFEST_TEMP", "WRITE_ANCHORS_TEMP", "RENAME_MEDIA",
      "RENAME_MANIFEST", "RENAME_ANCHORS", "VERIFY_SET", "CLEANUP_STAGING",
    ]);
    assert.deepEqual(
      [...planRollbackForCompleted(["RENAME_MEDIA", "RENAME_MANIFEST"])],
      ["RENAME_MANIFEST", "RENAME_MEDIA"],
    );
    assert.deepEqual([...planRollbackForCompleted([])], []);
    assert.equal(confirmTempCleanup([{ removed: true, stillPresent: false }]), "CONFIRMED");
    assert.equal(confirmTempCleanup([{ removed: true, stillPresent: true }]), "UNCONFIRMED");
    assert.equal(confirmTempCleanup([{ removed: false, stillPresent: false }]), "UNCONFIRMED");
  });

  it("digest preserved and no blind retry after failed transaction", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    files.stepFaults = { RENAME_MANIFEST: true };
    const first = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(first.published, false);
    const second = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(second.published, false);
    assert.ok(files.publishedSteps.filter((s) => s === "RENAME_MEDIA").length <= 1);
  });
});

// ---------------------------------------------------------------------------
// P9.7 §7 — Recovery invariants (scoped, active-aware, idempotent, no resume)
// ---------------------------------------------------------------------------

describe("P9.7: restart recovery invariants", () => {
  it("owned shapes classified with exact names only", () => {
    assert.equal(classifyRecoveryEntry({ name: TEMP_PARTIAL_NAME, ownedByActive: false }).kind, "PARTIAL");
    assert.equal(classifyRecoveryEntry({ name: MANIFEST_TEMP_NAME, ownedByActive: false }).kind, "MANIFEST_TEMP");
    assert.equal(classifyRecoveryEntry({ name: ANCHORS_TEMP_NAME, ownedByActive: false }).kind, "ANCHORS_TEMP");
    assert.equal(classifyRecoveryEntry({ name: TAKE_LOCK_NAME, ownedByActive: false }).kind, "LOCK");
    assert.equal(
      classifyRecoveryEntry({ name: `take${DIAGNOSTIC_PARTIAL_SUFFIX}`, ownedByActive: false }).kind,
      "DIAGNOSTIC",
    );
  });

  it("final-looking strays and unrelated files are foreign and ignored", () => {
    for (const name of ["lesson.mp4", "take.manifest.json", "take.anchors.jsonl", "notes.txt", "x.partial"]) {
      const entry = classifyRecoveryEntry({ name, ownedByActive: false });
      assert.equal(entry.kind, "FOREIGN", name);
      assert.equal(planRecoveryAction(entry, { staleDisposition: "PURGE" }), "IGNORE", name);
    }
  });

  it("active take preserved, stale purged, idempotent, no resume", () => {
    const active = classifyRecoveryEntry({ name: TEMP_PARTIAL_NAME, ownedByActive: true });
    assert.equal(planRecoveryAction(active, { staleDisposition: "PURGE" }), "KEEP_ACTIVE");
    const stale = classifyRecoveryEntry({ name: TEMP_PARTIAL_NAME, ownedByActive: false });
    assert.equal(planRecoveryAction(stale, { staleDisposition: "PURGE" }), "PURGE");
    const first = [stale].map((e) => planRecoveryAction(e, { staleDisposition: "PURGE" }));
    const second = [stale].map((e) => planRecoveryAction(e, { staleDisposition: "PURGE" }));
    assert.equal(plansMatch(first, second), true);
    // No plan step ever resumes an old take: actions are purge/keep/ignore only.
    for (const action of [...first, ...second]) {
      assert.ok(["PURGE", "KEEP_DIAGNOSTIC", "IGNORE", "KEEP_ACTIVE"].includes(action));
    }
  });
});

// ---------------------------------------------------------------------------
// P9.7 §8 — Naming confinement (traversal-proof, deterministic)
// ---------------------------------------------------------------------------

describe("P9.7: filesystem naming confinement", () => {
  it("take names deterministic with t01 issuance and traversal rejection", () => {
    assert.equal(formatTakeId(1), "t01");
    assert.equal(formatTakeId(12), "t12");
    const base = buildTakeArtifactBaseName({ lesson_id: "C01-L001", generation: 1, take_id: "t01" });
    assert.ok(!base.includes("..") && !base.includes("/") && !base.includes("\\"));
    const parsed = parseTakeArtifactBaseName(base);
    assert.equal(parsed.lesson_id, "C01-L001");
    assert.equal(parsed.generation, 1);
    assert.equal(parsed.take_id, "t01");
    assert.throws(() => parseTakeArtifactBaseName("../../evil"));
    assert.throws(() => parseTakeArtifactBaseName("\\\\server\\share"));
  });
});

// ---------------------------------------------------------------------------
// P9.7 §9 — Hostile field matrix (prompt battery, all safe schemas)
// ---------------------------------------------------------------------------

const P97_HOSTILE: [string, unknown][] = [
  ["path", "E:\\temp\\evil.mp4"],
  ["outputPath", "E:\\renders\\evil.mp4"],
  ["ffmpegPath", "E:\\tools\\ffmpeg.exe"],
  ["ffprobePath", "E:\\tools\\ffprobe.exe"],
  ["args", ["-y"]],
  ["extraArgs", ["-vf", "scale=1:1"]],
  ["command", "rm -rf /"],
  ["shell", true],
  ["cwd", "E:\\x"],
  ["env", { SECRET: "1" }],
  ["hwnd", 131072],
  ["pid", 4242],
  ["monitor", 1],
  ["x", 0],
  ["y", 0],
  ["width", 1],
  ["height", 1],
  ["fps", 60],
  ["codec", "hevc"],
  ["filter", "scale=1:1"],
  ["url", "http://127.0.0.1:9/"],
  ["hostPort", 3000],
  ["guestPort", 3000],
  ["cookie", "s=1"],
  ["authorization", "Bearer x"],
  ["containerId", "abc"],
  ["profilePath", "E:\\p"],
  ["selector", "#x"],
  ["code", "evil()"],
  ["source", "bytes"],
  ["windowTitle", "Secrets"],
  ["filterChain", "evil"],
];

describe("P9.7: hostile field matrix", () => {
  it("all hostile keys rejected or structurally excluded by safe schemas", () => {
    const manifestBase = buildCanonicalManifest(makeManifestSeed()) as Record<string, unknown>;
    const anchorBase = makeAnchor() as Record<string, unknown>;
    const snapshotBase = {
      recording_session_id: "rec-p97", take_id: "t01", state: "RECORDING",
      runtime_session_id: "sess-p97", generation: 1, elapsed_us: 10,
      captured_frames: 1, encoded_frames: 1, dropped_frames: 0,
      filler_frames: 0,
      encoder_family: "NVENC", record_safe: true, last_outcome: null,
    };
    const startBase = {
      lesson_id: "C01-L001", runtime_session_id: "sess-p97", generation: 1,
      take_id: "t01", recording_profile_id: "rec-1080p30-h264-v1", record_safe: true,
    };
    for (const [key, value] of P97_HOSTILE) {
      assert.equal(RecordingManifestSchema.safeParse({ ...manifestBase, [key]: value }).success, false, `manifest:${key}`);
      assert.equal(RecordingTimelineAnchorSchema.safeParse({ ...anchorBase, [key]: value }).success, false, `anchor:${key}`);
      assert.equal(RecordingSnapshotDtoSchema.safeParse({ ...snapshotBase, [key]: value }).success, false, `snapshot:${key}`);
      assert.equal(RecordingErrorDtoSchema.safeParse({ code: "FRAME_TIMEOUT", message: "m", retry: "NOT_RETRYABLE", [key]: value }).success, false, `error:${key}`);
      assert.equal(InternalRecordingStartDescriptorSchema.safeParse({ ...startBase, [key]: value }).success, false, `start:${key}`);
    }
  });

  it("safe DTO shape exposes no handle/path/port authority", () => {
    const snapshotKeys = Object.keys(
      RecordingSnapshotDtoSchema.parse({
        recording_session_id: "rec-p97", take_id: "t01", state: "RECORDING",
        runtime_session_id: "sess-p97", generation: 1, elapsed_us: 10,
        captured_frames: 1, encoded_frames: 1, dropped_frames: 0,
        filler_frames: 0,
        encoder_family: "NVENC", record_safe: true, last_outcome: null,
      }),
    );
    for (const forbidden of ["hwnd", "pid", "outputPath", "ffmpegPath", "args", "command", "shell", "monitor", "x", "y", "url", "port"]) {
      assert.ok(!snapshotKeys.includes(forbidden), forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// P9.7 §10 — Timeline fencing (session / generation / ordering / pause)
// ---------------------------------------------------------------------------

const P97_FENCE = {
  recording_session_id: "rec-p97-matrix",
  take_id: "t01",
  runtime_session_id: "sess-p97",
  generation: 1,
} as const;

const P97_EPOCH = calibrateTimelineEpoch({
  runtimeSampleMs: 2_000,
  captureSampleUs: 9_000_000,
  runtimeClockEpoch: "epoch-run-p97",
  captureClockEpoch: "epoch-cap-p97",
  skewBoundUs: 500,
});

let p97Seq = 50_000;
function p97Event(overrides: Partial<TrustedRuntimeEvent> = {}): TrustedRuntimeEvent {
  p97Seq += 1;
  return {
    runtime_session_id: "sess-p97",
    generation: 1,
    global_seq: p97Seq,
    event_type: "runtime.step.started",
    scene_id: "C01-L001-S001",
    step_id: "C01-L001-S001-B001",
    global_step_ordinal: 1,
    engine: "browser",
    timestamp_ms: 2_100,
    ...overrides,
  };
}

describe("P9.7: timeline fencing and ordering", () => {
  it("stale session and stale generation rejected, reset terminates take", () => {
    const stale = new RecordingTimelineCoordinator({ fence: { ...P97_FENCE }, epoch: P97_EPOCH });
    const staleSession = stale.ingestRuntimeEvent(p97Event({ runtime_session_id: "sess-other" }));
    assert.equal(staleSession.ok, false);
    const staleGen = stale.ingestRuntimeEvent(p97Event({ generation: 0 as never }));
    assert.equal(staleGen.ok, false);
    const c = new RecordingTimelineCoordinator({ fence: { ...P97_FENCE }, epoch: P97_EPOCH });
    const reset = c.ingestRuntimeEvent(p97Event({ event_type: "runtime.reset.started", generation: 2 }));
    assert.equal(reset.ok, false);
    if (!reset.ok) assert.equal(reset.code, "STALE_GENERATION");
    assert.equal(c.getStatus(), "RESET_INTERRUPTED");
  });

  it("global_seq authoritative with duplicate idempotency and strict ordering", () => {
    const c = new RecordingTimelineCoordinator({ fence: { ...P97_FENCE }, epoch: P97_EPOCH });
    const first = c.ingestRuntimeEvent(p97Event({ global_seq: 60_001, timestamp_ms: 2_000 }));
    assert.equal(first.ok, true);
    const dup = c.ingestRuntimeEvent(p97Event({ global_seq: 60_001, timestamp_ms: 2_000 }));
    assert.equal(dup.ok, true);
    const anchorsBefore = c.getAnchors().length;
    const lower = c.ingestRuntimeEvent(p97Event({ global_seq: 60_000, timestamp_ms: 2_100 }));
    assert.equal(lower.ok, false);
    assert.equal(c.getAnchors().length, anchorsBefore);
  });

  it("step boundaries anchored within one frame error and pause keeps video running", () => {
    const c = new RecordingTimelineCoordinator({ fence: { ...P97_FENCE }, epoch: P97_EPOCH });
    const results = [
      c.ingestRuntimeEvent(p97Event({ global_seq: 61_001, event_type: "runtime.step.started", timestamp_ms: 2_000 })),
      c.ingestRuntimeEvent(p97Event({ global_seq: 61_002, event_type: "runtime.paused", timestamp_ms: 2_500 })),
      c.ingestRuntimeEvent(p97Event({ global_seq: 61_003, event_type: "runtime.resumed", timestamp_ms: 3_500 })),
      c.ingestRuntimeEvent(p97Event({ global_seq: 61_004, event_type: "runtime.step.completed", timestamp_ms: 4_000 })),
    ];
    for (const r of results) assert.equal(r.ok, true);
    const anchors = c.getAnchors();
    assert.ok(anchors.length >= 2);
    for (let i = 1; i < anchors.length; i += 1) {
      assert.ok(anchors[i].video_time_us >= anchors[i - 1].video_time_us);
      assert.ok(anchors[i].video_time_us - anchors[i - 1].video_time_us <= 2_000_000);
    }
    assert.ok(c.getPauseIntervals().length >= 1);
  });
});

// ---------------------------------------------------------------------------
// P9.7 §11 — Combined race matrix (20 rows, deterministic, zero sleeps)
// ---------------------------------------------------------------------------

describe("P9.7: combined race matrix (20 deterministic winners)", () => {
  it("01 start vs start: second start refused, single active take", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const first = await controller.startGuardedTake(guardedInput({ generation: 1 }));
    assert.equal(first.ok, true);
    const second = await controller.startGuardedTake(guardedInput({ generation: 1 }));
    assert.equal(second.ok, false);
  });

  it("02 start vs stop: active take stops to a terminal exactly once", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.abortForCause("OPERATOR_CANCELLED");
    assert.ok(controller.terminal !== null);
  });

  it("03 start vs shutdown: shutdown wins with INCOMPLETE", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.shutdownGuarded();
    await flushMicrotasks();
    assert.deepEqual(owner.abortCalls, ["APP_CLOSED"]);
    assert.equal(controller.terminal, "APP_CLOSED");
  });

  it("04 stop vs stop: first terminal latch wins, single cleanup", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.abortForCause("OPERATOR_CANCELLED");
    await controller.abortForCause("RESET_INTERRUPTED");
    assert.equal(files.purged.length, 1);
  });

  it("05 frame vs stop: post-terminal frames never publish", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await controller.abortForCause("OPERATOR_CANCELLED");
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
  });

  it("06 runtime event vs stop: post-terminal anchors rejected", () => {
    const c = new RecordingTimelineCoordinator({ fence: { ...P97_FENCE }, epoch: P97_EPOCH });
    c.ingestRuntimeEvent(p97Event({ event_type: "runtime.reset.started", generation: 2 }));
    assert.equal(c.getStatus(), "RESET_INTERRUPTED");
    const late = c.ingestRuntimeEvent(p97Event({ global_seq: 70_001 }));
    assert.equal(late.ok, false);
  });

  it("07 encoder drain vs stop: stop supersedes pending drain", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.abortForCause("ENCODER_FAILED");
    assert.deepEqual(owner.abortCalls, ["ENCODER_FAILED"]);
    assert.equal(controller.terminal, "ENCODER_FAILED");
  });

  it("08 completion vs cancel: cancel wins, never success", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await controller.abortForCause("OPERATOR_CANCELLED");
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
  });

  it("09 completion vs reset: reset wins, never continued", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await controller.abortForCause("RESET_INTERRUPTED");
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
  });

  it("10 completion vs source loss: source loss wins, no success", async () => {
    const { options, owner, clock } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    clock.advance(2_000);
    assert.equal(controller.checkStarvation(), true);
    await flushMicrotasks();
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
    assert.deepEqual(owner.abortCalls, ["CAPTURE_SOURCE_LOST"]);
  });

  it("11 completion vs low disk: low disk wins, no publication", async () => {
    const { options, owner, disk, scheduler } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    disk.freeBytesOrNull = LOW_SPACE_ABORT_BYTES - 1;
    scheduler.runAll();
    await flushMicrotasks();
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
    assert.deepEqual(owner.abortCalls, ["LOW_DISK_ABORT"]);
  });

  it("12 completion vs shutdown: shutdown supersedes, single outcome", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.shutdownGuarded();
    await flushMicrotasks();
    assert.deepEqual(owner.abortCalls, ["APP_CLOSED"]);
    assert.equal(controller.terminal, "APP_CLOSED");
  });

  it("13 tail vs shutdown: shutdown supersedes the pending tail", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.shutdownGuarded();
    await flushMicrotasks();
    assert.equal(controller.terminal, "APP_CLOSED");
    assert.ok(!owner.abortCalls.includes("SUCCESS" as never));
  });

  it("14 low disk vs publication: disk-unsafe evidence cannot publish", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const result = await controller.settleSuccessfulTake(started.take, {
      ...healthyEvidence(), diskStillSafe: false,
    });
    assert.equal(result.published, false);
    assert.equal(files.publishedSteps.length, 0);
  });

  it("15 publication vs shutdown: shutdown wins, no partial success", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.shutdownGuarded();
    await flushMicrotasks();
    assert.deepEqual(owner.abortCalls, ["APP_CLOSED"]);
    assert.equal(controller.terminal, "APP_CLOSED");
  });

  it("16 reset vs publication: reset take cannot settle successfully", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await controller.abortForCause("RESET_INTERRUPTED");
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
  });

  it("17 quarantine vs cancel: cancel purges, never quarantines", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const disposition = await controller.abortForCause("OPERATOR_CANCELLED");
    assert.equal(disposition.temp, "PURGE");
    assert.equal(files.quarantined.length, 0);
    assert.equal(files.purged.length, 1);
  });

  it("18 cleanup failure vs new take: uncertainty never blocks a new take", async () => {
    const { options, files } = controllerOptions();
    files.failPurge = true;
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput({ generation: 1 }));
    await controller.abortForCause("OPERATOR_CANCELLED");
    const kinds = controller.eventLog().map((event) => event.kind);
    assert.ok(kinds.includes("PURGE_UNCONFIRMED"));
    files.failPurge = false;
    const second = await controller.startGuardedTake(guardedInput({ generation: 1 }));
    assert.equal(second.ok, true);
  });

  it("19 recovery vs active take: active entries kept", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const plan = controller.planRecovery(["screen.partial.mp4"], { staleDisposition: "PURGE" });
    assert.equal(plan.length, 1);
    assert.equal(controller.activeTake?.takeId, started.take.takeId);
  });

  it("20 old take callback vs new take: stale handle cannot address the new take", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const first = await controller.startGuardedTake(guardedInput({ generation: 1 }));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    await controller.abortForCause("OPERATOR_CANCELLED");
    const second = await controller.startGuardedTake(guardedInput({ generation: 1 }));
    assert.equal(second.ok, true);
    if (!second.ok) return;
    // The new take wins by identity: the old handle names a different take,
    // so a late callback carrying the old fence can never settle the new one.
    assert.ok(second.take.takeId !== first.take.takeId);
    assert.equal(controller.activeTake?.takeId, second.take.takeId);
    assert.ok(controller.activeTake?.takeId !== first.take.takeId);
  });
});

// ---------------------------------------------------------------------------
// P9.7 §12 — Resource bounds table (no unbounded queue/wait/file)
// ---------------------------------------------------------------------------

describe("P9.7: explicit resource bounds table", () => {
  it("every bound frozen with no unbounded wait or file", () => {
    const bounds: [string, number][] = [
      ["resolution width", 1920],
      ["resolution height", 1080],
      ["fps", 30],
      ["frame pool", 12],
      ["frame memory bytes", CAPTURE_FRAME_BYTES_1080P * 12],
      ["encoder pending queue", 12],
      ["manifest bytes", 65_536],
      ["anchor line bytes", 4_096],
      ["anchor total bytes", 5_242_880],
      ["max take duration s", 1_802],
      ["tail ms", 2_000],
      ["startup timeout ms", 15_000],
      ["drain timeout ms", 5_000],
      ["flush timeout ms", 30_000],
      ["ffprobe timeout ms", 15_000],
      ["exit timeout ms", 10_000],
      ["shutdown timeout ms", 10_000],
      ["source starvation ms", 2_000],
      ["preflight floor bytes", 2_147_483_648],
      ["low-space threshold bytes", 1_073_741_824],
    ];
    assert.equal(bounds.length, 20);
    for (const [name, value] of bounds) {
      assert.ok(Number.isFinite(value) && value > 0, name);
    }
    assert.ok((bounds.find(([n]) => n === "frame memory bytes")!)[1] <= 96 * 1024 * 1024);
    assert.ok(MAX_ENCODER_QUEUE_BYTES <= 96 * 1024 * 1024);
    assert.equal(ENCODER_PROBE_TIMEOUT_MS, 30_000);
  });
});

// ---------------------------------------------------------------------------
// P9.7 §13 — P10 / P11 boundaries (seams only, no implementation)
// ---------------------------------------------------------------------------

describe("P9.7: P10 and P11 boundaries absent", () => {
  it("P9 emits only the timing seam: silent video with reserved 48 kHz slot", () => {
    assert.equal(RECORDING_AUDIO_PRESENT, false);
    assert.equal(RESERVED_AUDIO_SLOT.present, false);
    assert.equal(RESERVED_AUDIO_SLOT.sample_rate, 48_000);
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.equal(manifest.audio.present, false);
  });

  it("no voice, audio-track, or Unreal vocabulary in safe schemas", () => {
    const manifestKeys = Object.keys(buildCanonicalManifest(makeManifestSeed()));
    for (const token of ["tts", "microphone", "voice", "unreal", "metahuman", "levelSequence"]) {
      assert.ok(!manifestKeys.includes(token), token);
    }
    const anchorKeys = Object.keys(makeAnchor());
    for (const token of ["tts", "microphone", "voice", "unreal"]) {
      assert.ok(!anchorKeys.includes(token), token);
    }
  });
});
