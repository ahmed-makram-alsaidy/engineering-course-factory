// P10.2 WAV Header, Encoding & Inspection Tests
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 10 and
// docs/adr/ADR-0015-voice-generation-boundary.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_BLOCK_ALIGN,
  CANONICAL_BYTE_RATE,
  PCM_FORMAT_CODE,
  WAV_HEADER_BYTES,
  buildWavHeader,
  encodeWavPcm16Mono48k,
  parseWavHeader,
  validateCanonicalWav,
} from "../src/wav.ts";

describe("wav: canonical 44-byte RIFF header construction", () => {
  it("builds a canonical 44-byte header for 48 kHz mono PCM16", () => {
    const sampleCount = 48000; // 1 second
    const header = buildWavHeader(sampleCount);

    assert.equal(header.length, WAV_HEADER_BYTES);
    assert.equal(header.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(header.readUInt32LE(4), 36 + sampleCount * 2);
    assert.equal(header.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(header.subarray(12, 16).toString("ascii"), "fmt ");
    assert.equal(header.readUInt32LE(16), 16); // PCM subchunk1 size
    assert.equal(header.readUInt16LE(20), PCM_FORMAT_CODE); // 1 = PCM
    assert.equal(header.readUInt16LE(22), 1); // mono
    assert.equal(header.readUInt32LE(24), 48000); // 48 kHz
    assert.equal(header.readUInt32LE(28), CANONICAL_BYTE_RATE); // 96000
    assert.equal(header.readUInt16LE(32), CANONICAL_BLOCK_ALIGN); // 2
    assert.equal(header.readUInt16LE(34), 16); // 16-bit
    assert.equal(header.subarray(36, 40).toString("ascii"), "data");
    assert.equal(header.readUInt32LE(40), sampleCount * 2);
  });

  it("encodes Int16Array samples into complete WAV Buffer", () => {
    const samples = new Int16Array(4800); // 100 ms
    for (let i = 0; i < samples.length; i++) {
      samples[i] = (i % 2000) - 1000;
    }

    const wavBuffer = encodeWavPcm16Mono48k(samples);
    assert.equal(wavBuffer.length, WAV_HEADER_BYTES + 4800 * 2);

    const info = validateCanonicalWav(wavBuffer);
    assert.equal(info.formatCode, 1);
    assert.equal(info.channels, 1);
    assert.equal(info.sampleRate, 48000);
    assert.equal(info.byteRate, 96000);
    assert.equal(info.blockAlign, 2);
    assert.equal(info.bitsPerSample, 16);
    assert.equal(info.sampleCount, 4800);
    assert.equal(info.dataLength, 9600);
  });

  it("rejects negative or non-integer sample count in buildWavHeader", () => {
    assert.throws(() => buildWavHeader(-1), /\[WAV_INVALID_SAMPLE_COUNT\]/);
    assert.throws(() => buildWavHeader(1.5), /\[WAV_INVALID_SAMPLE_COUNT\]/);
  });
});

describe("wav: parser validation & corruption detection", () => {
  it("parses valid WAV buffer correctly", () => {
    const samples = new Int16Array(9600);
    const wav = encodeWavPcm16Mono48k(samples);
    const info = parseWavHeader(wav);

    assert.equal(info.sampleCount, 9600);
    assert.equal(info.dataLength, 19200);
    assert.equal(info.dataOffset, 44);
  });

  it("rejects buffer smaller than 44 bytes", () => {
    const small = Buffer.alloc(20);
    assert.throws(() => parseWavHeader(small), /\[WAV_HEADER_TOO_SMALL\]/);
  });

  it("rejects non-RIFF header", () => {
    const bad = buildWavHeader(100);
    bad.write("FORM", 0, 4, "ascii");
    assert.throws(() => parseWavHeader(bad), /\[WAV_HEADER_INVALID\]/);
  });

  it("rejects non-WAVE format", () => {
    const bad = buildWavHeader(100);
    bad.write("AIFF", 8, 4, "ascii");
    assert.throws(() => parseWavHeader(bad), /\[WAV_HEADER_INVALID\]/);
  });

  it("rejects non-PCM format in validateCanonicalWav", () => {
    const bad = encodeWavPcm16Mono48k(new Int16Array(100));
    bad.writeUInt16LE(3, 20); // IEEE float = 3
    assert.throws(() => validateCanonicalWav(bad), /\[WAV_NON_CANONICAL_FORMAT\]/);
  });

  it("rejects stereo in validateCanonicalWav", () => {
    const bad = encodeWavPcm16Mono48k(new Int16Array(100));
    bad.writeUInt16LE(2, 22); // stereo
    assert.throws(() => validateCanonicalWav(bad), /\[WAV_NON_CANONICAL_CHANNELS\]/);
  });

  it("rejects 44.1 kHz in validateCanonicalWav", () => {
    const bad = encodeWavPcm16Mono48k(new Int16Array(100));
    bad.writeUInt32LE(44100, 24);
    assert.throws(() => validateCanonicalWav(bad), /\[WAV_NON_CANONICAL_SAMPLE_RATE\]/);
  });

  it("rejects truncated data chunk", () => {
    const header = buildWavHeader(1000); // expects 2000 bytes data
    const truncated = Buffer.concat([header, Buffer.alloc(500)]);
    assert.throws(() => parseWavHeader(truncated), /\[WAV_TRUNCATED_DATA\]/);
  });
});
