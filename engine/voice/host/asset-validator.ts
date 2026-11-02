// P10.4 Strict Voice Asset Validation (11-Point Validation Contract)
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 26 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 12.
//
// 11 Validation Gates:
// Gate 1:  [Container Check] ...... Valid RIFF header with "WAVE" format tag and "fmt " / "data" chunks.
// Gate 2:  [Codec Check] .......... Format code 1 (PCM), uncompressed.
// Gate 3:  [Sample Rate] .......... Exactly 48,000 Hz.
// Gate 4:  [Channels] ............. Exactly 1 (mono).
// Gate 5:  [Bit Depth] ............ Exactly 16 bits per sample (pcm_s16le).
// Gate 6:  [Sample Count] ......... sample_count > 0 and integer.
// Gate 7:  [Mathematical Duration]  duration_us == floor(sample_count * 125 / 6).
// Gate 8:  [Duration Bounds] ...... 100,000 us <= duration_us <= 300,000,000 us (100 ms to 300 s).
// Gate 9:  [Signal Presence] ...... RMS energy > -60.0 dBFS (rejects dead silence/empty streams).
// Gate 10: [Signal Integrity] ..... Zero NaN, zero Inf, zero clipping saturation runs (>= 3 consecutive full-scale).
// Gate 11: [Digest Match] ......... SHA-256 over byte stream matches recorded audio_sha256.

import { sha256Hex } from "../src/canonical.ts";
import {
  AUDIO_BITS_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_FORMAT,
  AUDIO_SAMPLE_RATE_HZ,
  MAX_AUDIO_SAMPLE_COUNT,
  MAX_NARRATION_DURATION_US,
  MIN_AUDIO_SAMPLE_COUNT,
  MIN_NARRATION_DURATION_US,
  durationUsForSampleCount,
} from "../src/audio-clock.ts";
import {
  VoiceAssetMetadataSchema,
  type VoiceAssetMetadata,
  type Sha256Hex,
} from "../src/protocol.ts";
import { parseWavHeader, type WavHeaderInfo } from "../src/wav.ts";

/** Minimum allowed RMS energy in dBFS: -60.0 dBFS. */
export const MIN_RMS_ENERGY_DBFS = -60.0 as const;

/** Consecutive full-scale sample count indicating digital clipping saturation: 3 samples. */
export const CLIPPING_CONSECUTIVE_LIMIT = 3 as const;

export interface AudioValidationReport {
  readonly format: "wav";
  readonly sample_rate_hz: typeof AUDIO_SAMPLE_RATE_HZ;
  readonly channels: typeof AUDIO_CHANNELS;
  readonly bits_per_sample: typeof AUDIO_BITS_PER_SAMPLE;
  readonly sample_format: typeof AUDIO_SAMPLE_FORMAT;
  readonly sample_count: number;
  readonly duration_us: number;
  readonly audio_sha256: Sha256Hex;
  readonly rms_energy_dbfs: number;
  readonly peak_amplitude: number;
  readonly peak_dbfs: number;
}

export class VoiceValidationError extends Error {
  readonly code: "VALIDATION_FAILED" | "CACHE_CORRUPT";
  readonly gateNumber: number;

  constructor(message: string, gateNumber: number, code: "VALIDATION_FAILED" | "CACHE_CORRUPT" = "VALIDATION_FAILED") {
    super(message);
    this.name = "VoiceValidationError";
    this.code = code;
    this.gateNumber = gateNumber;
  }
}

/**
 * Validates audio WAV bytes against the authoritative 11-point validation contract.
 * Returns detailed audio inspection metrics if all 11 gates pass.
 * Throws VoiceValidationError if any gate is violated.
 */
export function validateVoiceAssetBytes(
  wavBuffer: Buffer,
  options?: {
    expectedDigest?: string;
    asCacheIntegrity?: boolean;
  },
): AudioValidationReport {
  const errCode = options?.asCacheIntegrity ? "CACHE_CORRUPT" : "VALIDATION_FAILED";

  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length === 0) {
    throw new VoiceValidationError("[VALIDATION_FAILED: Gate 1] WAV input must be a non-empty Buffer", 1, errCode);
  }

  // Gate 1: Container Check
  let wavInfo: WavHeaderInfo;
  try {
    wavInfo = parseWavHeader(wavBuffer);
  } catch (err: unknown) {
    throw new VoiceValidationError(
      `[VALIDATION_FAILED: Gate 1] Malformed WAV container: ${err instanceof Error ? err.message : String(err)}`,
      1,
      errCode,
    );
  }

  // Gate 2: Codec Check (formatCode === 1 PCM)
  if (wavInfo.formatCode !== 1) {
    throw new VoiceValidationError(
      `[VALIDATION_FAILED: Gate 2] Non-PCM audio format code: expected 1 (PCM), got ${wavInfo.formatCode}`,
      2,
      errCode,
    );
  }

  // Gate 3: Sample Rate (48,000 Hz)
  if (wavInfo.sampleRate !== AUDIO_SAMPLE_RATE_HZ) {
    throw new VoiceValidationError(
      `[VALIDATION_FAILED: Gate 3] Sample rate mismatch: expected ${AUDIO_SAMPLE_RATE_HZ} Hz, got ${wavInfo.sampleRate} Hz`,
      3,
      errCode,
    );
  }

  // Gate 4: Channels (1 mono)
  if (wavInfo.channels !== AUDIO_CHANNELS) {
    throw new VoiceValidationError(
      `[VALIDATION_FAILED: Gate 4] Channel count mismatch: expected ${AUDIO_CHANNELS} (mono), got ${wavInfo.channels}`,
      4,
      errCode,
    );
  }

  // Gate 5: Bit Depth (16 bits)
  if (wavInfo.bitsPerSample !== AUDIO_BITS_PER_SAMPLE) {
    throw new VoiceValidationError(
      `[VALIDATION_FAILED: Gate 5] Bit depth mismatch: expected ${AUDIO_BITS_PER_SAMPLE} bits, got ${wavInfo.bitsPerSample}`,
      5,
      errCode,
    );
  }

  // Gate 6: Sample Count (> 0 and integer)
  const sampleCount = wavInfo.sampleCount;
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) {
    throw new VoiceValidationError(
      `[VALIDATION_FAILED: Gate 6] Invalid sample count: ${sampleCount}`,
      6,
      errCode,
    );
  }

  // Gate 7: Mathematical Duration
  const duration_us = durationUsForSampleCount(sampleCount);

  // Gate 8: Duration Bounds (100 ms to 300 s)
  if (
    duration_us < MIN_NARRATION_DURATION_US ||
    duration_us > MAX_NARRATION_DURATION_US ||
    sampleCount < MIN_AUDIO_SAMPLE_COUNT ||
    sampleCount > MAX_AUDIO_SAMPLE_COUNT
  ) {
    throw new VoiceValidationError(
      `[VALIDATION_FAILED: Gate 8] Duration out of bounds: ${duration_us} us (${sampleCount} samples). ` +
        `Allowed bounds: ${MIN_NARRATION_DURATION_US}..${MAX_NARRATION_DURATION_US} us`,
      8,
      errCode,
    );
  }

  // Read PCM samples
  const pcmBytes = wavBuffer.subarray(wavInfo.dataOffset, wavInfo.dataOffset + wavInfo.dataLength);
  const sampleArray = new Int16Array(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    Math.floor(pcmBytes.byteLength / 2),
  );

  let sumSquares = 0;
  let peakAbs = 0;
  let consecutiveFullScale = 0;

  for (let i = 0; i < sampleArray.length; i++) {
    const s = sampleArray[i];

    // Gate 10: Signal Integrity check (NaN / Inf)
    if (!Number.isFinite(s)) {
      throw new VoiceValidationError(
        `[VALIDATION_FAILED: Gate 10] Non-finite sample detected at index ${i}`,
        10,
        errCode,
      );
    }

    const abs = Math.abs(s);
    if (abs > peakAbs) {
      peakAbs = abs;
    }

    // Gate 10: Clipping check (3 or more consecutive full-scale samples)
    if (s === 32767 || s === -32768) {
      consecutiveFullScale++;
      if (consecutiveFullScale >= CLIPPING_CONSECUTIVE_LIMIT) {
        throw new VoiceValidationError(
          `[VALIDATION_FAILED: Gate 10] Digital clipping saturation detected: ${consecutiveFullScale} consecutive full-scale samples at index ${i}`,
          10,
          errCode,
        );
      }
    } else {
      consecutiveFullScale = 0;
    }

    // Normalize sample in [-1.0, 1.0] for RMS calculation
    const normalized = s / 32768.0;
    sumSquares += normalized * normalized;
  }

  // Gate 9: Signal Presence (RMS energy > -60 dBFS)
  const meanSquare = sumSquares / sampleArray.length;
  const rms = Math.sqrt(meanSquare);
  const rmsDbFs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

  if (rmsDbFs <= MIN_RMS_ENERGY_DBFS) {
    throw new VoiceValidationError(
      `[VALIDATION_FAILED: Gate 9] RMS energy too low (silence or near-silence): ${rmsDbFs.toFixed(2)} dBFS <= ${MIN_RMS_ENERGY_DBFS} dBFS`,
      9,
      errCode,
    );
  }

  // Gate 11: Digest Match
  const computedSha256 = sha256Hex(wavBuffer);
  if (options?.expectedDigest) {
    const expected = options.expectedDigest.toLowerCase();
    if (computedSha256 !== expected) {
      throw new VoiceValidationError(
        `[VALIDATION_FAILED: Gate 11] SHA-256 digest mismatch: expected '${expected}', got '${computedSha256}'`,
        11,
        errCode,
      );
    }
  }

  const peakDbFs = peakAbs > 0 ? 20 * Math.log10(peakAbs / 32768.0) : -Infinity;

  return {
    format: "wav",
    sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
    channels: AUDIO_CHANNELS,
    bits_per_sample: AUDIO_BITS_PER_SAMPLE,
    sample_format: AUDIO_SAMPLE_FORMAT,
    sample_count: sampleCount,
    duration_us,
    audio_sha256: computedSha256,
    rms_energy_dbfs: rmsDbFs,
    peak_amplitude: peakAbs,
    peak_dbfs: peakDbFs,
  };
}

/**
 * Validates that VoiceAssetMetadata truthfully reflects the canonical audio WAV bytes.
 */
export function validateVoiceAssetMetadataAgainstBytes(
  metadata: VoiceAssetMetadata,
  wavBuffer: Buffer,
): AudioValidationReport {
  // Validate schema
  VoiceAssetMetadataSchema.parse(metadata);

  // Validate audio bytes and check digest
  const report = validateVoiceAssetBytes(wavBuffer, {
    expectedDigest: metadata.audio_asset_digest,
    asCacheIntegrity: true,
  });

  if (metadata.sample_count !== report.sample_count) {
    throw new VoiceValidationError(
      `[CACHE_CORRUPT] Metadata sample_count (${metadata.sample_count}) does not match decoded audio (${report.sample_count})`,
      6,
      "CACHE_CORRUPT",
    );
  }

  if (metadata.duration_us !== report.duration_us) {
    throw new VoiceValidationError(
      `[CACHE_CORRUPT] Metadata duration_us (${metadata.duration_us}) does not match decoded audio (${report.duration_us})`,
      7,
      "CACHE_CORRUPT",
    );
  }

  return report;
}
