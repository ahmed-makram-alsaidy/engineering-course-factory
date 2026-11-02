// P10.1 Canonical Audio Clock & Exact Rational Mathematics
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Sections 10-14 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Freezes canonical 48 kHz mono 16-bit PCM WAV audio constants and exact
// rational integer sample-time mapping formulas.
//
// Sample index s at 48,000 Hz maps to:
//   audio_time_us(s) = floor(s * 1,000,000 / 48,000) = floor(s * 125 / 6)
// Inverse audio time t (in microseconds) maps to:
//   sample_index(t) = floor(t * 48,000 / 1,000,000) = floor(t * 6 / 125)
//
// Harmonic video relation:
//   48,000 / 30 = 1,600 samples per 30 FPS video frame (exact integer).
//
// Pure math and contract constants only: zero FFmpeg, zero audio hardware,
// zero floating-point accumulation.

// ---------------------------------------------------------------------------
// Canonical Audio Mastering Constants (Frozen)
// ---------------------------------------------------------------------------

/** Canonical container: RIFF WAV (.wav). */
export const AUDIO_CONTAINER = "wav" as const;

/** Canonical encoding: Linear uncompressed PCM. */
export const AUDIO_CODEC = "pcm" as const;

/** Canonical sampling rate: 48,000 Hz (exact). */
export const AUDIO_SAMPLE_RATE_HZ = 48_000 as const;

/** Canonical channel layout: 1 channel (mono). */
export const AUDIO_CHANNELS = 1 as const;

/** Canonical bit depth: 16-bit signed integer. */
export const AUDIO_BITS_PER_SAMPLE = 16 as const;

/** Canonical sample format: 16-bit signed little-endian PCM. */
export const AUDIO_SAMPLE_FORMAT = "pcm_s16le" as const;

/** Compressed audio formats (MP3, AAC, Opus) are prohibited from timing authority. */
export const COMPRESSED_FORMATS_CANONICAL = false as const;

// ---------------------------------------------------------------------------
// Video Cadence Harmonic Pure Facts
// ---------------------------------------------------------------------------

/** Nominal video frame rate for Course Factory presentation capture. */
export const VIDEO_FPS = 30 as const;

/**
 * Exactly 1,600 audio samples per 30 FPS video frame (48,000 / 30 = 1,600).
 * Pure mathematical fact: video frame boundaries align with integer audio sample boundaries.
 */
export const AUDIO_SAMPLES_PER_VIDEO_FRAME = 1_600 as const;

// ---------------------------------------------------------------------------
// Duration & Sample Count Bounds (P10-DESIGN-SPEC Section 26)
// ---------------------------------------------------------------------------

/** Microseconds per second (exact rational basis). */
export const MICROS_PER_SECOND = 1_000_000 as const;

/** Minimum allowed narration unit duration: 100 ms (100,000 us). */
export const MIN_NARRATION_DURATION_US = 100_000 as const;

/** Maximum allowed narration unit duration: 300 s (5 minutes = 300,000,000 us). */
export const MAX_NARRATION_DURATION_US = 300_000_000 as const;

/**
 * Minimum sample count for a valid published narration asset at 48 kHz:
 * 100 ms * 48,000 / 1,000 = 4,800 samples.
 */
export const MIN_AUDIO_SAMPLE_COUNT = 4_800 as const;

/**
 * Maximum sample count for a single narration unit at 48 kHz:
 * 300 s * 48,000 = 14,400,000 samples.
 */
export const MAX_AUDIO_SAMPLE_COUNT = 14_400_000 as const;

/**
 * Maximum take ceiling sample count (30 minutes = 1,800 s):
 * 1,800 * 48,000 = 86,400,000 samples.
 */
export const MAX_TAKE_AUDIO_SAMPLE_COUNT = 86_400_000 as const;

/** Safe upper bound for sample indexing (guarantees safe integer arithmetic). */
export const MAX_SAFE_SAMPLE_INDEX = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------
// Exact Rational Sample Time Helpers
// ---------------------------------------------------------------------------

/**
 * Exact rational audio time in integer microseconds for a zero-based sample index.
 * Uses integer math: floor(s * 1,000,000 / 48,000) = floor(s * 125 / 6).
 * Zero cumulative floating-point timing drift.
 */
export function audioTimeUsForSampleIndex(sampleIndex: number): number {
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0) {
    throw new RangeError(
      `[AUDIO_CLOCK_INVALID] sampleIndex must be a non-negative integer, received: ${sampleIndex}`,
    );
  }
  if (!Number.isSafeInteger(sampleIndex)) {
    throw new RangeError(
      `[AUDIO_CLOCK_INVALID] sampleIndex exceeds Number.MAX_SAFE_INTEGER: ${sampleIndex}`,
    );
  }

  // Safe integer multiplication: 125 * sampleIndex fits in safe integer up to ~7.2e13 samples
  // (> 47,000 hours of 48 kHz audio). For absolute safety, use BigInt.
  const bigSample = BigInt(sampleIndex);
  const bigMicros = (bigSample * 125n) / 6n;
  const result = Number(bigMicros);

  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`[AUDIO_CLOCK_OVERFLOW] result microseconds exceeds safe integer`);
  }
  return result;
}

/**
 * Exact rational sample index for an audio duration in integer microseconds.
 * Uses integer math: floor(t * 48,000 / 1,000,000) = floor(t * 6 / 125).
 * Floor policy: maps to the latest completed audio sample at or before t.
 */
export function sampleIndexForAudioTimeUs(timeUs: number): number {
  if (!Number.isInteger(timeUs) || timeUs < 0) {
    throw new RangeError(
      `[AUDIO_CLOCK_INVALID] timeUs must be a non-negative integer, received: ${timeUs}`,
    );
  }
  if (!Number.isSafeInteger(timeUs)) {
    throw new RangeError(
      `[AUDIO_CLOCK_INVALID] timeUs exceeds Number.MAX_SAFE_INTEGER: ${timeUs}`,
    );
  }

  const bigTime = BigInt(timeUs);
  const bigSample = (bigTime * 6n) / 125n;
  const result = Number(bigSample);

  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`[AUDIO_CLOCK_OVERFLOW] result sample index exceeds safe integer`);
  }
  return result;
}

/**
 * Derived duration in integer microseconds for an exact sample count.
 * Alias for audioTimeUsForSampleIndex with semantic parameter naming.
 */
export function durationUsForSampleCount(sampleCount: number): number {
  return audioTimeUsForSampleIndex(sampleCount);
}

/**
 * Derived sample count for an exact duration in integer microseconds.
 * Alias for sampleIndexForAudioTimeUs with semantic parameter naming.
 */
export function sampleCountForDurationUs(durationUs: number): number {
  return sampleIndexForAudioTimeUs(durationUs);
}

/**
 * Exact inverse of audioTimeUsForSampleIndex on canonical timestamps:
 * recovers the exact sample index s whose canonical timestamp equals canonicalTimeUs.
 * Canonical timestamps satisfy t = floor(s * 125 / 6), hence (t * 6 + 5) / 125
 * recovers s exactly for all non-negative integer sample indices.
 */
export function canonicalSampleIndexForAudioTimeUs(canonicalTimeUs: number): number {
  if (!Number.isInteger(canonicalTimeUs) || canonicalTimeUs < 0) {
    throw new RangeError(
      `[AUDIO_CLOCK_INVALID] canonicalTimeUs must be a non-negative integer, received: ${canonicalTimeUs}`,
    );
  }
  if (!Number.isSafeInteger(canonicalTimeUs)) {
    throw new RangeError(
      `[AUDIO_CLOCK_INVALID] canonicalTimeUs exceeds Number.MAX_SAFE_INTEGER: ${canonicalTimeUs}`,
    );
  }

  const bigTime = BigInt(canonicalTimeUs);
  const bigSample = (bigTime * 6n + 5n) / 125n;
  const result = Number(bigSample);

  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`[AUDIO_CLOCK_OVERFLOW] result sample index exceeds safe integer`);
  }
  return result;
}
