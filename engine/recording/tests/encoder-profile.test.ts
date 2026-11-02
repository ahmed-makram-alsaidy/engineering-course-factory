// Tests for P9.1 canonical requested profile, encoder descriptor
// (explicit fallback, never silent), backpressure descriptor, audio NONE.
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 10-13, ADR-0014.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BackpressurePolicySchema,
  CANONICAL_REQUESTED_PROFILE,
  CURSOR_CAPTURE_ENABLED,
  ENCODER_PROFILE_VERSION,
  EncoderDescriptorSchema,
  P10_EXPECTED_SAMPLE_RATE_HZ,
  RECORDING_AUDIO_PRESENT,
  RECORDING_BUFSIZE_BITS,
  RECORDING_CODEC,
  RECORDING_CONTAINER,
  RECORDING_FASTSTART,
  RECORDING_FPS,
  RECORDING_GOP,
  RECORDING_HEIGHT,
  RECORDING_MAXRATE_BPS,
  RECORDING_PIX_FMT,
  RECORDING_WIDTH,
  RESERVED_AUDIO_SLOT,
  RequestedRecordingProfileSchema,
  ReservedAudioSlotSchema,
  X264_CRF,
  X264_PRESET,
} from "../src/encoder-profile.ts";

describe("P9.1: canonical requested profile is frozen", () => {
  it("canonical profile carries exact frozen values", () => {
    assert.deepEqual(CANONICAL_REQUESTED_PROFILE, {
      profile_id: "rec-1080p30-h264-v1",
      width: 1920,
      height: 1080,
      fps: 30,
      codec: "h264",
      container: "mp4",
      pix_fmt: "yuv420p",
      faststart: true,
      gop: 60,
      maxrate_bps: 12_000_000,
      bufsize_bits: 24_000_000,
      nvenc_preset: "p4",
      nvenc_cq: 23,
      nvenc_rc: "vbr",
      x264_preset: "veryfast",
      x264_crf: 21,
      audio_present: false,
      cursor_capture: false,
      sdr: true,
    });
  });

  it("profile constants match the frozen table", () => {
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
    assert.equal(X264_PRESET, "veryfast");
    assert.equal(X264_CRF, 21);
  });

  it("arbitrary resolution is rejected", () => {
    const bad = { ...CANONICAL_REQUESTED_PROFILE, width: 1600, height: 900 };
    assert.ok(!RequestedRecordingProfileSchema.safeParse(bad).success);
  });

  it("arbitrary FPS is rejected", () => {
    for (const fps of [24, 25, 29, 31, 60]) {
      const bad = { ...CANONICAL_REQUESTED_PROFILE, fps };
      assert.ok(!RequestedRecordingProfileSchema.safeParse(bad).success, String(fps));
    }
  });

  it("non-H.264 codec and audio tracks are rejected", () => {
    assert.ok(
      !RequestedRecordingProfileSchema.safeParse({
        ...CANONICAL_REQUESTED_PROFILE,
        codec: "hevc",
      }).success,
    );
    assert.ok(
      !RequestedRecordingProfileSchema.safeParse({
        ...CANONICAL_REQUESTED_PROFILE,
        audio_present: true,
      }).success,
    );
  });

  it("audio is NONE with a 48 kHz P10 reserved seam", () => {
    assert.equal(RECORDING_AUDIO_PRESENT, false);
    assert.equal(P10_EXPECTED_SAMPLE_RATE_HZ, 48_000);
    assert.deepEqual(RESERVED_AUDIO_SLOT, {
      present: false,
      expected_codec: "aac",
      sample_rate: 48_000,
      sync_basis: "video_time_us anchors",
    });
    assert.ok(ReservedAudioSlotSchema.safeParse(RESERVED_AUDIO_SLOT).success);
    assert.ok(
      !ReservedAudioSlotSchema.safeParse({ ...RESERVED_AUDIO_SLOT, present: true })
        .success,
    );
  });

  it("cursor capture is canonically false", () => {
    assert.equal(CURSOR_CAPTURE_ENABLED, false);
  });
});

describe("P9.1: encoder descriptor makes fallback explicit", () => {
  it("accepts a valid NVENC descriptor", () => {
    const nvenc = {
      family: "NVENC",
      profile: "nvenc-p4-cq23",
      profile_version: "1.0",
      fallback_used: false,
      encoder_version: "8.1.1-full_build",
    };
    assert.ok(EncoderDescriptorSchema.safeParse(nvenc).success);
    assert.equal(ENCODER_PROFILE_VERSION, "1.0");
  });

  it("accepts a valid libx264 fallback descriptor with reason", () => {
    const x264 = {
      family: "LIBX264",
      profile: "libx264-veryfast-crf21",
      profile_version: "1.0",
      fallback_used: true,
      fallback_reason: "NVENC_SELF_TEST_FAILED",
      encoder_version: "8.1.1-full_build",
    };
    assert.ok(EncoderDescriptorSchema.safeParse(x264).success);
  });

  it("rejects unknown encoders", () => {
    const bad = {
      family: "QUICKSYNC",
      profile: "nvenc-p4-cq23",
      profile_version: "1.0",
      fallback_used: false,
      encoder_version: "1.0",
    };
    assert.ok(!EncoderDescriptorSchema.safeParse(bad).success);
  });

  it("fallback without reason is rejected (no silent fallback)", () => {
    const silent = {
      family: "LIBX264",
      profile: "libx264-veryfast-crf21",
      profile_version: "1.0",
      fallback_used: true,
      encoder_version: "8.1.1",
    };
    assert.ok(!EncoderDescriptorSchema.safeParse(silent).success);
  });

  it("NVENC marked as fallback is rejected", () => {
    const bad = {
      family: "NVENC",
      profile: "nvenc-p4-cq23",
      profile_version: "1.0",
      fallback_used: true,
      fallback_reason: "NVENC_SELF_TEST_FAILED",
      encoder_version: "8.1.1",
    };
    assert.ok(!EncoderDescriptorSchema.safeParse(bad).success);
  });

  it("family/profile mismatch is rejected", () => {
    const bad = {
      family: "NVENC",
      profile: "libx264-veryfast-crf21",
      profile_version: "1.0",
      fallback_used: false,
      encoder_version: "8.1.1",
    };
    assert.ok(!EncoderDescriptorSchema.safeParse(bad).success);
  });

  it("executable paths and argv are structurally impossible", () => {
    const hostile = {
      family: "NVENC",
      profile: "nvenc-p4-cq23",
      profile_version: "1.0",
      fallback_used: false,
      encoder_version: "8.1.1",
      ffmpegPath: "E:\\ffmpeg\\ffmpeg.exe",
      ffmpegArgs: ["-y", "-f", "rawvideo"],
      executablePath: "/usr/bin/ffmpeg",
    };
    assert.ok(!EncoderDescriptorSchema.safeParse(hostile).success);
  });

  it("encoder version rejects host paths", () => {
    const bad = {
      family: "NVENC",
      profile: "nvenc-p4-cq23",
      profile_version: "1.0",
      fallback_used: false,
      encoder_version: "E:\\tools\\ffmpeg.exe",
    };
    assert.ok(!EncoderDescriptorSchema.safeParse(bad).success);
  });
});

describe("P9.1: backpressure policy descriptor", () => {
  it("accepts a bounded drop-oldest policy", () => {
    const good = {
      queue_capacity_frames: 16,
      overflow_policy: "drop-oldest",
      max_queue_bytes: 96_000_000,
      drop_ceiling_per_minute: 60,
      drop_ceiling_exceeded: false,
    };
    assert.ok(BackpressurePolicySchema.safeParse(good).success);
  });

  it("rejects unbounded queues and non-drop-oldest policies", () => {
    const unbounded = {
      queue_capacity_frames: 1024,
      overflow_policy: "drop-oldest",
      max_queue_bytes: 96_000_000,
      drop_ceiling_per_minute: 60,
      drop_ceiling_exceeded: false,
    };
    assert.ok(!BackpressurePolicySchema.safeParse(unbounded).success);
    const blocking = {
      queue_capacity_frames: 16,
      overflow_policy: "block",
      max_queue_bytes: 96_000_000,
      drop_ceiling_per_minute: 60,
      drop_ceiling_exceeded: false,
    };
    assert.ok(!BackpressurePolicySchema.safeParse(blocking).success);
  });
});
