// P10.1 Audio Clock & Rational Timing Unit Tests
//
// Tests canonical audio constants, exact integer formulas, inverse mappings,
// video harmonic relationship (1,600 samples = 33,333 us), long-duration
// goldens (10 min, 30 min, 300 s), and boundary rejection.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_BITS_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_CODEC,
  AUDIO_CONTAINER,
  AUDIO_SAMPLE_FORMAT,
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_SAMPLES_PER_VIDEO_FRAME,
  COMPRESSED_FORMATS_CANONICAL,
  MAX_AUDIO_SAMPLE_COUNT,
  MAX_NARRATION_DURATION_US,
  MAX_TAKE_AUDIO_SAMPLE_COUNT,
  MIN_AUDIO_SAMPLE_COUNT,
  MIN_NARRATION_DURATION_US,
  VIDEO_FPS,
  audioTimeUsForSampleIndex,
  canonicalSampleIndexForAudioTimeUs,
  durationUsForSampleCount,
  sampleCountForDurationUs,
  sampleIndexForAudioTimeUs,
} from "../src/audio-clock.ts";

describe("audio-clock: canonical constants", () => {
  it("freezes RIFF WAV and uncompressed Linear PCM 16-bit 48 kHz mono format", () => {
    assert.equal(AUDIO_CONTAINER, "wav");
    assert.equal(AUDIO_CODEC, "pcm");
    assert.equal(AUDIO_SAMPLE_RATE_HZ, 48_000);
    assert.equal(AUDIO_CHANNELS, 1);
    assert.equal(AUDIO_BITS_PER_SAMPLE, 16);
    assert.equal(AUDIO_SAMPLE_FORMAT, "pcm_s16le");
    assert.equal(COMPRESSED_FORMATS_CANONICAL, false);
  });

  it("freezes exact video frame harmonic relationship (48,000 / 30 = 1,600)", () => {
    assert.equal(VIDEO_FPS, 30);
    assert.equal(AUDIO_SAMPLES_PER_VIDEO_FRAME, 1_600);
    assert.equal(AUDIO_SAMPLE_RATE_HZ / VIDEO_FPS, 1_600);
  });

  it("freezes narration duration bounds (100 ms to 300 s)", () => {
    assert.equal(MIN_NARRATION_DURATION_US, 100_000);
    assert.equal(MAX_NARRATION_DURATION_US, 300_000_000);
    assert.equal(MIN_AUDIO_SAMPLE_COUNT, 4_800);
    assert.equal(MAX_AUDIO_SAMPLE_COUNT, 14_400_000);
    assert.equal(MAX_TAKE_AUDIO_SAMPLE_COUNT, 86_400_000);
  });
});

describe("audio-clock: exact rational timing mapping", () => {
  it("sample 0 maps to 0 us", () => {
    assert.equal(audioTimeUsForSampleIndex(0), 0);
    assert.equal(durationUsForSampleCount(0), 0);
  });

  it("sample 1 maps to exact floor(125/6) = 20 us", () => {
    assert.equal(audioTimeUsForSampleIndex(1), 20);
    assert.equal(Math.floor(125 / 6), 20);
  });

  it("sample 2 maps to exact floor(250/6) = 41 us", () => {
    assert.equal(audioTimeUsForSampleIndex(2), 41);
  });

  it("sample 3 maps to exact floor(375/6) = 62 us", () => {
    assert.equal(audioTimeUsForSampleIndex(3), 62);
  });

  it("sample 6 maps to exact 125 us (zero remainder)", () => {
    assert.equal(audioTimeUsForSampleIndex(6), 125);
  });

  it("sample 1,600 (one 30 FPS video frame) maps to exact 33,333 us", () => {
    assert.equal(audioTimeUsForSampleIndex(1_600), 33_333);
    assert.equal(Math.floor((1_600 * 125) / 6), 33_333);
  });

  it("sample 3,200 (two 30 FPS video frames) maps to exact 66,666 us", () => {
    assert.equal(audioTimeUsForSampleIndex(3_200), 66_666);
  });

  it("sample 4,800 (minimum narration unit = 100 ms) maps to 100,000 us", () => {
    assert.equal(audioTimeUsForSampleIndex(4_800), 100_000);
  });

  it("sample 48,000 (one second) maps to exact 1,000,000 us", () => {
    assert.equal(audioTimeUsForSampleIndex(48_000), 1_000_000);
  });
});

describe("audio-clock: long-duration timing goldens (zero drift)", () => {
  it("300 seconds upper bound: 14,400,000 samples = exact 300,000,000 us", () => {
    const samples = 14_400_000;
    const timeUs = audioTimeUsForSampleIndex(samples);
    assert.equal(timeUs, 300_000_000);
    assert.equal(sampleIndexForAudioTimeUs(timeUs), samples);
  });

  it("10 minutes: 28,800,000 samples = exact 600,000,000 us", () => {
    const samples = 28_800_000;
    const timeUs = audioTimeUsForSampleIndex(samples);
    assert.equal(timeUs, 600_000_000);
    assert.equal(sampleIndexForAudioTimeUs(timeUs), samples);
  });

  it("30 minutes take ceiling: 86,400,000 samples = exact 1,800,000,000 us", () => {
    const samples = 86_400_000;
    const timeUs = audioTimeUsForSampleIndex(samples);
    assert.equal(timeUs, 1_800_000_000);
    assert.equal(sampleIndexForAudioTimeUs(timeUs), samples);
  });

  it("proves 0 us cumulative drift across 1,000 consecutive 1-second ticks", () => {
    for (let second = 1; second <= 1_000; second++) {
      const samples = second * 48_000;
      const expectedUs = second * 1_000_000;
      assert.equal(audioTimeUsForSampleIndex(samples), expectedUs);
    }
  });
});

describe("audio-clock: inverse conversion and floor policy", () => {
  it("canonical inverse recovers exact sample boundaries without error", () => {
    const testSamples = [0, 1, 2, 3, 6, 12, 48, 1_600, 4_800, 48_000, 14_400_000, 86_400_000];
    for (const s of testSamples) {
      const us = audioTimeUsForSampleIndex(s);
      const recovered = canonicalSampleIndexForAudioTimeUs(us);
      assert.equal(recovered, s);
    }
  });

  it("applies floor policy to intra-sample microsecond timestamps", () => {
    // Sample 0 is in [0, 20.833 us). At 20 us, floor(20 * 6 / 125) = 0.
    assert.equal(sampleIndexForAudioTimeUs(0), 0);
    assert.equal(sampleIndexForAudioTimeUs(20), 0);
    // At 21 us: floor(21 * 6 / 125) = floor(126 / 125) = 1.
    assert.equal(sampleIndexForAudioTimeUs(21), 1);
  });

  it("durationUsForSampleCount and sampleCountForDurationUs aliases match", () => {
    assert.equal(durationUsForSampleCount(48_000), 1_000_000);
    assert.equal(sampleCountForDurationUs(1_000_000), 48_000);
  });
});

describe("audio-clock: error handling and input bounds", () => {
  it("rejects negative sample index", () => {
    assert.throws(() => audioTimeUsForSampleIndex(-1), /\[AUDIO_CLOCK_INVALID\]/);
  });

  it("rejects non-integer sample index", () => {
    assert.throws(() => audioTimeUsForSampleIndex(1.5), /\[AUDIO_CLOCK_INVALID\]/);
    assert.throws(() => audioTimeUsForSampleIndex(Number.NaN), /\[AUDIO_CLOCK_INVALID\]/);
  });

  it("rejects negative time in microseconds", () => {
    assert.throws(() => sampleIndexForAudioTimeUs(-50), /\[AUDIO_CLOCK_INVALID\]/);
  });

  it("rejects non-integer time in microseconds", () => {
    assert.throws(() => sampleIndexForAudioTimeUs(100.25), /\[AUDIO_CLOCK_INVALID\]/);
    assert.throws(() => sampleIndexForAudioTimeUs(Number.POSITIVE_INFINITY), /\[AUDIO_CLOCK_INVALID\]/);
  });
});
