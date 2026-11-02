// P10.4 Canonical Audio Normalization Pipeline Test Suite
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 24, 25.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeWavPcm16Mono48k, parseWavHeader } from "../src/wav.ts";
import { sha256Hex } from "../src/canonical.ts";
import {
  VoiceAssetNormalizer,
  removeDcOffset,
  trimSilenceEdges,
  remapAlignmentMarks,
  parseLoudnormJson,
} from "../host/audio-normalizer.ts";
import type { NormalizedAlignment } from "../src/protocol.ts";

function createToneSamples(sampleCount: number, amplitude = 6000, freq = 440): Int16Array {
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / 48000));
  }
  return samples;
}

/** Creates a synthetic WAV buffer with custom sample rate and channels for ingress testing. */
function createCustomWav(sampleRate: number, channels: number, sampleCount: number): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = sampleCount * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);

  const data = Buffer.alloc(dataLength);
  for (let i = 0; i < sampleCount; i++) {
    const val = Math.round(5000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    for (let c = 0; c < channels; c++) {
      data.writeInt16LE(val, (i * channels + c) * 2);
    }
  }

  return Buffer.concat([header, data]);
}

describe("audio-normalizer: DC offset correction", () => {
  it("leaves zero-mean signal unchanged", () => {
    const samples = createToneSamples(48000);
    const { samples: corrected, dcOffset } = removeDcOffset(samples);
    assert.equal(dcOffset, 0);
    assert.equal(corrected.length, samples.length);
  });

  it("removes DC bias accurately", () => {
    const original = createToneSamples(4800);
    const biased = new Int16Array(original.length);
    const bias = 500;
    for (let i = 0; i < original.length; i++) {
      biased[i] = original[i] + bias;
    }

    const { samples: corrected, dcOffset } = removeDcOffset(biased);
    assert.equal(dcOffset, bias);

    // Verify mean of corrected signal is 0
    let sum = 0;
    for (let i = 0; i < corrected.length; i++) {
      sum += corrected[i];
    }
    const residualMean = Math.round(sum / corrected.length);
    assert.equal(residualMean, 0);
  });
});

describe("audio-normalizer: silence edge trimming policy", () => {
  it("trims excess leading silence down to exactly 20 ms (960 samples)", () => {
    // 5000 samples silence + 4800 samples tone (with non-zero first sample)
    const leadingSilence = 5000;
    const tone = createToneSamples(4800);
    tone[0] = 5000; // ensure first sample is immediately non-silent
    const combined = new Int16Array(leadingSilence + tone.length);
    combined.set(tone, leadingSilence);

    const { trimmedSamples, leadingTrimmed } = trimSilenceEdges(combined);
    // 5000 - 960 = 4040 samples trimmed
    assert.equal(leadingTrimmed, 5000 - 960);
    assert.equal(trimmedSamples.length, 960 + tone.length);
  });

  it("trims excess trailing silence down to exactly 50 ms (2400 samples)", () => {
    // 4800 samples tone + 8000 samples trailing silence
    const tone = createToneSamples(4800);
    const trailingSilence = 8000;
    const combined = new Int16Array(tone.length + trailingSilence);
    combined.set(tone, 0);

    const { trimmedSamples, trailingTrimmed } = trimSilenceEdges(combined);
    // 8000 - 2400 = 5600 samples trimmed
    assert.equal(trailingTrimmed, 8000 - 2400);
    assert.equal(trimmedSamples.length, tone.length + 2400);
  });

  it("strictly preserves internal spoken pauses", () => {
    // tone1 (4800) + internal silence (10,000) + tone2 (4800)
    const tone1 = createToneSamples(4800);
    const internalSilenceLen = 10000;
    const tone2 = createToneSamples(4800);
    const total = tone1.length + internalSilenceLen + tone2.length;
    const combined = new Int16Array(total);
    combined.set(tone1, 0);
    combined.set(tone2, tone1.length + internalSilenceLen);

    const { trimmedSamples, leadingTrimmed, trailingTrimmed } = trimSilenceEdges(combined);
    // Leading and trailing are 0, so internal silence is 100% preserved
    assert.equal(leadingTrimmed, 0);
    assert.equal(trailingTrimmed, 0);
    assert.equal(trimmedSamples.length, total);
  });
});

describe("audio-normalizer: loudnorm parser helper", () => {
  it("parses valid loudnorm JSON from FFmpeg output", () => {
    const stderrSample = `
[Parsed_loudnorm_0 @ 0000026029db07c0] 
{
	"input_i" : "-18.50",
	"input_tp" : "-14.75",
	"input_lra" : "1.20",
	"input_thresh" : "-28.50",
	"output_i" : "-19.00",
	"output_tp" : "-15.30",
	"output_lra" : "1.20",
	"output_thresh" : "-29.00",
	"normalization_type" : "linear",
	"target_offset" : "0.00"
}
`;
    const parsed = parseLoudnormJson(stderrSample);
    assert.ok(parsed !== null);
    assert.equal(parsed!.input_i, "-18.50");
    assert.equal(parsed!.input_tp, "-14.75");
    assert.equal(parsed!.input_lra, "1.20");
    assert.equal(parsed!.target_offset, "0.00");
  });

  it("returns null when loudnorm JSON is absent", () => {
    const parsed = parseLoudnormJson("Some random stderr output without JSON");
    assert.equal(parsed, null);
  });
});

describe("audio-normalizer: alignment mark remapping", () => {
  it("remaps word marks after resampling and leading silence trimming", () => {
    const original: NormalizedAlignment = {
      status: "word",
      words: [
        { ordinal: 1, word: "first", start_sample: 4410, end_sample: 8820 },
        { ordinal: 2, word: "second", start_sample: 8820, end_sample: 13230 },
      ],
      phonemes: [],
    };

    // 44.1k to 48k: ratio = 48000 / 44100 = 1.088435...
    // 4410 * (48000/44100) = 4800
    // 8820 * (48000/44100) = 9600
    // If leading trimmed is 960 samples:
    // start becomes 4800 - 960 = 3840
    // end becomes 9600 - 960 = 8640
    const remapped = remapAlignmentMarks(original, 44100, 960, 48000);
    assert.equal(remapped.status, "word");
    assert.equal(remapped.words.length, 2);
    assert.equal(remapped.words[0].start_sample, 3840);
    assert.equal(remapped.words[0].end_sample, 8640);
  });

  it("degrades status to 'none' when remapping creates non-monotonic or out of bounds marks", () => {
    const original: NormalizedAlignment = {
      status: "word",
      words: [
        { ordinal: 1, word: "out", start_sample: 50000, end_sample: 60000 },
      ],
      phonemes: [],
    };

    // Final sample count is 10,000, so marks at 50,000 are out of bounds
    const degraded = remapAlignmentMarks(original, 48000, 0, 10000);
    assert.equal(degraded.status, "none");
    assert.equal(degraded.words.length, 0);
  });
});

describe("audio-normalizer: full FFmpeg pipeline execution", () => {
  const normalizer = new VoiceAssetNormalizer();

  it("normalizes standard 48 kHz mono PCM fixture via EBU R128 two-pass", async () => {
    const samples = createToneSamples(48000); // 1 sec
    const wav = encodeWavPcm16Mono48k(samples);

    const result = await normalizer.normalize(wav);
    assert.equal(result.metrics.normalization_mode, "ebu_r128_two_pass");
    assert.equal(result.report.sample_rate_hz, 48000);
    assert.equal(result.report.channels, 1);
    assert.equal(result.report.bits_per_sample, 16);
    assert.ok(result.report.peak_dbfs <= -1.0, "True peak must be <= -1.0 dBFS");
  });

  it("resamples 44.1 kHz mono input fixture to canonical 48 kHz", async () => {
    const wav44k = createCustomWav(44100, 1, 44100); // 1 sec at 44.1 kHz

    const result = await normalizer.normalize(wav44k, undefined, { inputSampleRate: 44100 });
    assert.equal(result.report.sample_rate_hz, 48000);
    assert.equal(result.report.channels, 1);
    const parsed = parseWavHeader(result.canonical_wav);
    assert.equal(parsed.sampleRate, 48000);
    assert.equal(parsed.channels, 1);
  });

  it("downmixes 48 kHz stereo input fixture to canonical mono", async () => {
    const wavStereo = createCustomWav(48000, 2, 48000); // 1 sec stereo

    const result = await normalizer.normalize(wavStereo, undefined, { inputChannels: 2 });
    assert.equal(result.report.channels, 1);
    const parsed = parseWavHeader(result.canonical_wav);
    assert.equal(parsed.channels, 1);
  });

  it("handles short audio clips (< 400 ms) via short_clip_peak_fallback", async () => {
    const samples = createToneSamples(9600); // 200 ms
    const wav = encodeWavPcm16Mono48k(samples);

    const result = await normalizer.normalize(wav);
    assert.equal(result.metrics.normalization_mode, "short_clip_peak_fallback");
    assert.ok(result.report.peak_dbfs <= -1.0);
    assert.equal(result.report.sample_rate_hz, 48000);
  });

  it("is bit-exact and repeatable across multiple runs", async () => {
    const samples = createToneSamples(48000);
    const wav = encodeWavPcm16Mono48k(samples);

    const res1 = await normalizer.normalize(wav);
    const res2 = await normalizer.normalize(wav);

    const hash1 = sha256Hex(res1.canonical_wav);
    const hash2 = sha256Hex(res2.canonical_wav);
    assert.equal(hash1, hash2, "Repeated normalization must produce identical SHA-256 byte digest");
  });
});
