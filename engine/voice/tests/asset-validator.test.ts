// P10.4 11-Point Voice Asset Validation Test Suite
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 26.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeWavPcm16Mono48k, buildWavHeader } from "../src/wav.ts";
import { durationUsForSampleCount } from "../src/audio-clock.ts";
import { sha256Hex } from "../src/canonical.ts";
import {
  validateVoiceAssetBytes,
  validateVoiceAssetMetadataAgainstBytes,
  VoiceValidationError,
} from "../host/asset-validator.ts";
import type { VoiceAssetMetadata } from "../src/protocol.ts";

function createToneSamples(sampleCount: number, amplitude = 6000, freq = 440): Int16Array {
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / 48000));
  }
  return samples;
}

describe("asset-validator: container and format gates (Gates 1-5)", () => {
  it("Gate 1: accepts valid canonical WAV buffer", () => {
    const samples = createToneSamples(48000); // 1 sec
    const wav = encodeWavPcm16Mono48k(samples);
    const report = validateVoiceAssetBytes(wav);
    assert.equal(report.sample_count, 48000);
    assert.equal(report.sample_rate_hz, 48000);
    assert.equal(report.channels, 1);
    assert.equal(report.bits_per_sample, 16);
    assert.equal(report.format, "wav");
  });

  it("Gate 1: rejects empty buffer or truncated header", () => {
    assert.throws(() => validateVoiceAssetBytes(Buffer.alloc(0)), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 1;
    });

    assert.throws(() => validateVoiceAssetBytes(Buffer.from("RIFF1234")), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 1;
    });
  });

  it("Gate 2: rejects non-PCM format code", () => {
    const samples = createToneSamples(4800);
    const wav = encodeWavPcm16Mono48k(samples);
    // Overwrite format code at offset 20 with 3 (IEEE float)
    wav.writeUInt16LE(3, 20);

    assert.throws(() => validateVoiceAssetBytes(wav), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 2;
    });
  });

  it("Gate 3: rejects wrong sample rate (e.g. 44,100 Hz)", () => {
    const samples = createToneSamples(4800);
    const wav = encodeWavPcm16Mono48k(samples);
    // Overwrite sample rate at offset 24 with 44100
    wav.writeUInt32LE(44100, 24);

    assert.throws(() => validateVoiceAssetBytes(wav), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 3;
    });
  });

  it("Gate 4: rejects multi-channel audio (e.g. stereo)", () => {
    const samples = createToneSamples(4800);
    const wav = encodeWavPcm16Mono48k(samples);
    // Overwrite channels at offset 22 with 2
    wav.writeUInt16LE(2, 22);

    assert.throws(() => validateVoiceAssetBytes(wav), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 4;
    });
  });

  it("Gate 5: rejects non-16-bit depth (e.g. 24-bit)", () => {
    const samples = createToneSamples(4800);
    const wav = encodeWavPcm16Mono48k(samples);
    // Overwrite bitsPerSample at offset 34 with 24
    wav.writeUInt16LE(24, 34);

    assert.throws(() => validateVoiceAssetBytes(wav), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 5;
    });
  });
});

describe("asset-validator: timing and bounds gates (Gates 6-8)", () => {
  it("Gate 7: enforces exact rational mathematical duration", () => {
    const sampleCount = 96000;
    const expectedUs = durationUsForSampleCount(sampleCount);
    assert.equal(expectedUs, 2000000);

    const samples = createToneSamples(sampleCount);
    const wav = encodeWavPcm16Mono48k(samples);
    const report = validateVoiceAssetBytes(wav);
    assert.equal(report.duration_us, expectedUs);
  });

  it("Gate 8: accepts minimum duration (100 ms = 4,800 samples)", () => {
    const samples = createToneSamples(4800);
    const wav = encodeWavPcm16Mono48k(samples);
    const report = validateVoiceAssetBytes(wav);
    assert.equal(report.sample_count, 4800);
    assert.equal(report.duration_us, 100000);
  });

  it("Gate 8: rejects duration below minimum (e.g. 99 ms = 4,752 samples)", () => {
    const samples = createToneSamples(4752);
    const wav = encodeWavPcm16Mono48k(samples);
    assert.throws(() => validateVoiceAssetBytes(wav), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 8;
    });
  });

  it("Gate 8: rejects sample count exceeding upper bound", () => {
    // Fabricate header claiming sample count above 300 s (e.g. 14,448,000 samples)
    const header = buildWavHeader(14448000);
    assert.throws(() => validateVoiceAssetBytes(header), (err: unknown) => {
      return err instanceof VoiceValidationError;
    });
  });
});

describe("asset-validator: signal health and integrity (Gates 9-11)", () => {
  it("Gate 9: rejects pure digital silence (RMS <= -60 dBFS)", () => {
    const silence = new Int16Array(48000); // all zeros
    const wav = encodeWavPcm16Mono48k(silence);

    assert.throws(() => validateVoiceAssetBytes(wav), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 9;
    });
  });

  it("Gate 9: rejects near-silent low amplitude noise below -60 dBFS", () => {
    const nearSilence = new Int16Array(48000);
    for (let i = 0; i < nearSilence.length; i++) {
      nearSilence[i] = i % 2 === 0 ? 1 : -1; // amplitude 1 = -90 dBFS
    }
    const wav = encodeWavPcm16Mono48k(nearSilence);

    assert.throws(() => validateVoiceAssetBytes(wav), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 9;
    });
  });

  it("Gate 10: rejects digital clipping saturation (>= 3 consecutive full-scale samples)", () => {
    const samples = createToneSamples(48000);
    // Inject 3 consecutive saturated samples
    samples[1000] = 32767;
    samples[1001] = 32767;
    samples[1002] = 32767;

    const wav = encodeWavPcm16Mono48k(samples);
    assert.throws(() => validateVoiceAssetBytes(wav), (err: unknown) => {
      return err instanceof VoiceValidationError && err.gateNumber === 10;
    });
  });

  it("Gate 10: permits isolated non-saturated peak samples", () => {
    const samples = createToneSamples(48000);
    // 1 isolated full-scale sample is representable and not a saturation run
    samples[1000] = 32767;
    samples[1001] = 20000;

    const wav = encodeWavPcm16Mono48k(samples);
    assert.doesNotThrow(() => validateVoiceAssetBytes(wav));
  });

  it("Gate 11: verifies exact SHA-256 byte digest", () => {
    const samples = createToneSamples(48000);
    const wav = encodeWavPcm16Mono48k(samples);
    const expected = sha256Hex(wav);

    const report = validateVoiceAssetBytes(wav, { expectedDigest: expected });
    assert.equal(report.audio_sha256, expected);

    // Mismatched digest fails
    const badDigest = "0000000000000000000000000000000000000000000000000000000000000000";
    assert.throws(
      () => validateVoiceAssetBytes(wav, { expectedDigest: badDigest }),
      (err: unknown) => {
        return err instanceof VoiceValidationError && err.gateNumber === 11;
      },
    );
  });
});

describe("asset-validator: metadata validation against audio bytes", () => {
  it("validates truthful metadata against canonical audio bytes", () => {
    const samples = createToneSamples(48000);
    const wav = encodeWavPcm16Mono48k(samples);
    const digest = sha256Hex(wav);

    const metadata: VoiceAssetMetadata = {
      voice_unit_id: "vu-C01-L003-B001-001",
      cache_key: "3d9e87c0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef012345678",
      audio_asset_digest: digest,
      sample_rate_hz: 48000,
      channels: 1,
      bits_per_sample: 16,
      sample_format: "pcm_s16le",
      sample_count: 48000,
      duration_us: 1000000,
      provider_family: "fake",
      provider_model: "deterministic-v1",
      provider_voice_id: "boston-01",
      text_normalization_version: "1.0",
      audio_normalization_version: "1.0",
      voice_contract_version: "1.0",
      alignment_status: "none",
    };

    assert.doesNotThrow(() => validateVoiceAssetMetadataAgainstBytes(metadata, wav));
  });

  it("throws CACHE_CORRUPT when audio bytes do not match metadata digest", () => {
    const samples = createToneSamples(48000);
    const wav = encodeWavPcm16Mono48k(samples);

    const metadata: VoiceAssetMetadata = {
      voice_unit_id: "vu-C01-L003-B001-001",
      cache_key: "3d9e87c0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef012345678",
      audio_asset_digest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      sample_rate_hz: 48000,
      channels: 1,
      bits_per_sample: 16,
      sample_format: "pcm_s16le",
      sample_count: 48000,
      duration_us: 1000000,
      provider_family: "fake",
      provider_model: "deterministic-v1",
      provider_voice_id: "boston-01",
      text_normalization_version: "1.0",
      audio_normalization_version: "1.0",
      voice_contract_version: "1.0",
      alignment_status: "none",
    };

    assert.throws(
      () => validateVoiceAssetMetadataAgainstBytes(metadata, wav),
      (err: unknown) => {
        return err instanceof VoiceValidationError && err.code === "CACHE_CORRUPT";
      },
    );
  });
});
