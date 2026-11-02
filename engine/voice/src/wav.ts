// P10.2 Minimal Deterministic WAV (pcm_s16le, 48 kHz, mono) Encoder & Inspector
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 10 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Generates standard 44-byte RIFF WAV headers for 48,000 Hz 16-bit mono linear PCM.
// Header fields:
// - Offset 00: "RIFF" (4 bytes)
// - Offset 04: ChunkSize (4 bytes LE = 36 + Subchunk2Size)
// - Offset 08: "WAVE" (4 bytes)
// - Offset 12: "fmt " (4 bytes)
// - Offset 16: Subchunk1Size = 16 (4 bytes LE)
// - Offset 20: AudioFormat = 1 (Linear PCM, 2 bytes LE)
// - Offset 22: NumChannels = 1 (Mono, 2 bytes LE)
// - Offset 24: SampleRate = 48,000 (4 bytes LE)
// - Offset 28: ByteRate = 96,000 (48,000 * 1 * 2, 4 bytes LE)
// - Offset 32: BlockAlign = 2 (1 * 2, 2 bytes LE)
// - Offset 34: BitsPerSample = 16 (2 bytes LE)
// - Offset 36: "data" (4 bytes)
// - Offset 40: Subchunk2Size = sample_count * 2 (4 bytes LE)
// - Offset 44: Raw PCM 16-bit little-endian samples
//
// Pure Node.js Buffer manipulation. Zero third-party audio dependencies.

import {
  AUDIO_BITS_PER_SAMPLE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE_HZ,
} from "./audio-clock.ts";

export const WAV_HEADER_BYTES = 44 as const;
export const PCM_FORMAT_CODE = 1 as const;
export const CANONICAL_BYTE_RATE = (AUDIO_SAMPLE_RATE_HZ * AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8)) as number; // 96000
export const CANONICAL_BLOCK_ALIGN = (AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8)) as number; // 2

export interface WavHeaderInfo {
  readonly formatCode: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
  readonly dataOffset: number;
  readonly dataLength: number;
  readonly sampleCount: number;
}

/**
 * Builds a canonical 44-byte RIFF header for linear PCM 16-bit mono 48,000 Hz.
 */
export function buildWavHeader(sampleCount: number): Buffer {
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new Error(`[WAV_INVALID_SAMPLE_COUNT] sampleCount must be a non-negative integer, got ${sampleCount}`);
  }

  const dataLength = sampleCount * CANONICAL_BLOCK_ALIGN;
  const chunkSize = 36 + dataLength;

  // Enforce 32-bit RIFF size limit safety
  if (chunkSize > 0xffffffff) {
    throw new Error(`[WAV_SIZE_EXCEEDED] Audio data exceeds 32-bit RIFF container capacity: ${chunkSize} bytes`);
  }

  const header = Buffer.alloc(WAV_HEADER_BYTES);

  // "RIFF"
  header.write("RIFF", 0, 4, "ascii");
  // ChunkSize = 36 + dataLength
  header.writeUInt32LE(chunkSize, 4);
  // "WAVE"
  header.write("WAVE", 8, 4, "ascii");
  // "fmt "
  header.write("fmt ", 12, 4, "ascii");
  // Subchunk1Size = 16 for PCM
  header.writeUInt32LE(16, 16);
  // AudioFormat = 1 (PCM)
  header.writeUInt16LE(PCM_FORMAT_CODE, 20);
  // NumChannels = 1
  header.writeUInt16LE(AUDIO_CHANNELS, 22);
  // SampleRate = 48000
  header.writeUInt32LE(AUDIO_SAMPLE_RATE_HZ, 24);
  // ByteRate = 96000
  header.writeUInt32LE(CANONICAL_BYTE_RATE, 28);
  // BlockAlign = 2
  header.writeUInt16LE(CANONICAL_BLOCK_ALIGN, 32);
  // BitsPerSample = 16
  header.writeUInt16LE(AUDIO_BITS_PER_SAMPLE, 34);
  // "data"
  header.write("data", 36, 4, "ascii");
  // Subchunk2Size
  header.writeUInt32LE(dataLength, 40);

  return header;
}

/**
 * Encodes an Int16Array of audio samples into a canonical RIFF WAV Buffer.
 */
export function encodeWavPcm16Mono48k(samples: Int16Array): Buffer {
  const header = buildWavHeader(samples.length);
  const pcmBuffer = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  return Buffer.concat([header, pcmBuffer], WAV_HEADER_BYTES + pcmBuffer.length);
}

/**
 * Parses and verifies canonical WAV header properties from a Buffer.
 * Throws descriptive Error on any malformed or non-canonical field.
 */
export function parseWavHeader(buffer: Buffer): WavHeaderInfo {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("[WAV_HEADER_INVALID] Input must be a Node.js Buffer");
  }

  if (buffer.length < WAV_HEADER_BYTES) {
    throw new Error(
      `[WAV_HEADER_TOO_SMALL] Buffer length ${buffer.length} bytes is smaller than minimum WAV header (${WAV_HEADER_BYTES} bytes)`,
    );
  }

  const riff = buffer.subarray(0, 4).toString("ascii");
  if (riff !== "RIFF") {
    throw new Error(`[WAV_HEADER_INVALID] Expected 'RIFF' signature, found '${riff}'`);
  }

  const chunkSize = buffer.readUInt32LE(4);
  const wave = buffer.subarray(8, 12).toString("ascii");
  if (wave !== "WAVE") {
    throw new Error(`[WAV_HEADER_INVALID] Expected 'WAVE' format, found '${wave}'`);
  }

  // Search chunks sequentially starting after "WAVE"
  let offset = 12;
  let fmtFound = false;
  let dataFound = false;
  let formatCode = 0;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString("ascii");
    const subchunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === "fmt ") {
      if (subchunkSize < 16) {
        throw new Error(`[WAV_FMT_TOO_SMALL] 'fmt ' chunk size ${subchunkSize} is less than required 16`);
      }
      fmtFound = true;
      formatCode = buffer.readUInt16LE(offset + 8);
      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      byteRate = buffer.readUInt32LE(offset + 16);
      blockAlign = buffer.readUInt16LE(offset + 20);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
      offset += 8 + subchunkSize;
    } else if (chunkId === "data") {
      dataFound = true;
      dataOffset = offset + 8;
      dataLength = subchunkSize;
      offset += 8 + subchunkSize;
      break; // Primary data chunk located
    } else {
      // Skip unknown chunk
      offset += 8 + subchunkSize;
    }
  }

  if (!fmtFound) {
    throw new Error("[WAV_MISSING_FMT] Required 'fmt ' subchunk not found in WAV buffer");
  }

  if (!dataFound) {
    throw new Error("[WAV_MISSING_DATA] Required 'data' subchunk not found in WAV buffer");
  }

  if (dataOffset + dataLength > buffer.length) {
    throw new Error(
      `[WAV_TRUNCATED_DATA] WAV data chunk declares ${dataLength} bytes but only ${buffer.length - dataOffset} bytes available`,
    );
  }

  const sampleCount = Math.floor(dataLength / blockAlign);

  return {
    formatCode,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
    dataOffset,
    dataLength,
    sampleCount,
  };
}

/**
 * Validates that a WAV buffer strictly adheres to P10 canonical mastering rules:
 * RIFF, PCM (1), 48 kHz, mono (1), 16-bit, exact byteRate and blockAlign.
 */
export function validateCanonicalWav(buffer: Buffer): WavHeaderInfo {
  const info = parseWavHeader(buffer);

  if (info.formatCode !== PCM_FORMAT_CODE) {
    throw new Error(`[WAV_NON_CANONICAL_FORMAT] Expected PCM format code 1, got ${info.formatCode}`);
  }
  if (info.channels !== AUDIO_CHANNELS) {
    throw new Error(`[WAV_NON_CANONICAL_CHANNELS] Expected ${AUDIO_CHANNELS} channel (mono), got ${info.channels}`);
  }
  if (info.sampleRate !== AUDIO_SAMPLE_RATE_HZ) {
    throw new Error(
      `[WAV_NON_CANONICAL_SAMPLE_RATE] Expected ${AUDIO_SAMPLE_RATE_HZ} Hz, got ${info.sampleRate} Hz`,
    );
  }
  if (info.bitsPerSample !== AUDIO_BITS_PER_SAMPLE) {
    throw new Error(
      `[WAV_NON_CANONICAL_BITS] Expected ${AUDIO_BITS_PER_SAMPLE} bits per sample, got ${info.bitsPerSample}`,
    );
  }
  if (info.byteRate !== CANONICAL_BYTE_RATE) {
    throw new Error(
      `[WAV_NON_CANONICAL_BYTE_RATE] Expected byteRate ${CANONICAL_BYTE_RATE}, got ${info.byteRate}`,
    );
  }
  if (info.blockAlign !== CANONICAL_BLOCK_ALIGN) {
    throw new Error(
      `[WAV_NON_CANONICAL_BLOCK_ALIGN] Expected blockAlign ${CANONICAL_BLOCK_ALIGN}, got ${info.blockAlign}`,
    );
  }

  return info;
}
