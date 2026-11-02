// P10.4 Canonical Audio Normalization Pipeline
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 11, 24, 25 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 5, 11.
//
// 7-Stage Normalization Pipeline:
// 1. Decode / Ingress raw provider audio bytes.
// 2. High-quality resampling to 48,000 Hz using soxr filter.
// 3. Channel downmixing to 1 channel (mono).
// 4. Loudness analysis & normalization:
//    - Duration >= 400 ms & finite R128: Two-pass EBU R128 linear normalization
//      Target: Integrated -19.0 ± 0.5 LUFS, True Peak <= -1.0 dBFS, LRA <= 6.0 LU.
//    - Duration < 400 ms or non-finite R128: Deterministic true-peak fallback
//      Target: True Peak <= -1.0 dBFS (peak amplitude <= 29,193).
// 5. Sample-domain DC offset correction (zero-mean subtraction).
// 6. Sample-domain deterministic silence edge trimming:
//    - Preserves internal pauses completely (zero alteration of pedagogical cadence).
//    - Trims excess synthetic leading silence beyond 20 ms (960 samples).
//    - Trims excess trailing decoder padding beyond 50 ms (2400 samples).
// 7. Word alignment timestamp remapping (resampling scaling - leading trim).
// 8. Canonical 44-byte minimal RIFF WAV encoding (pcm_s16le, 48 kHz, mono).
// 9. Verification against 11-point validation contract.

import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE_HZ,
  durationUsForSampleCount,
} from "../src/audio-clock.ts";
import {
  type AlignmentStatus,
  type NormalizedAlignment,
  NormalizedAlignmentSchema,
  VOICE_TIMEOUTS,
  type WordMark,
  type PhonemeMark,
} from "../src/protocol.ts";
import { encodeWavPcm16Mono48k } from "../src/wav.ts";
import {
  resolvePinnedFfmpeg,
  runTrustedFfmpeg,
} from "./normalizer-process.ts";
import {
  validateVoiceAssetBytes,
  type AudioValidationReport,
} from "./asset-validator.ts";

/** Silence amplitude threshold in 16-bit PCM: |sample| <= 32 (~ -60 dBFS). */
export const SILENCE_AMPLITUDE_THRESHOLD = 32 as const;

/** Maximum allowed leading silence in canonical samples (20 ms at 48 kHz): 960 samples. */
export const MAX_LEADING_SILENCE_SAMPLES = 960 as const;

/** Maximum allowed trailing silence in canonical samples (50 ms at 48 kHz): 2,400 samples. */
export const MAX_TRAILING_SILENCE_SAMPLES = 2_400 as const;

/** Minimum sample count required for EBU R128 momentary measurement window (400 ms): 19,200 samples. */
export const EBU_R128_MIN_SAMPLES = 19_200 as const;

/** Target maximum peak amplitude for short-clip peak normalization (-1.0 dBFS): 29,193. */
export const PEAK_TARGET_AMPLITUDE = 29_193 as const; // 32768 * 10^(-1/20)

export interface LoudnormMeasuredParams {
  readonly input_i: string;
  readonly input_tp: string;
  readonly input_lra: string;
  readonly input_thresh: string;
  readonly target_offset: string;
}

export interface NormalizationMetrics {
  readonly normalization_mode: "ebu_r128_two_pass" | "short_clip_peak_fallback";
  readonly measured_i?: number;
  readonly measured_tp?: number;
  readonly measured_lra?: number;
  readonly measured_thresh?: number;
  readonly target_offset?: number;
  readonly dc_offset_removed: number;
  readonly leading_samples_trimmed: number;
  readonly trailing_samples_trimmed: number;
}

export interface VoiceNormalizationResult {
  readonly canonical_wav: Buffer;
  readonly sample_count: number;
  readonly duration_us: number;
  readonly alignment: NormalizedAlignment;
  readonly report: AudioValidationReport;
  readonly metrics: NormalizationMetrics;
}

export interface NormalizationOptions {
  readonly ffmpegPath?: string;
  readonly inputSampleRate?: number;
  readonly inputChannels?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Parses loudnorm JSON block from FFmpeg stderr output.
 */
export function parseLoudnormJson(stderr: string): LoudnormMeasuredParams | null {
  const jsonMatch = stderr.match(/\{\s*"input_i"\s*:\s*"[^"]+"[\s\S]*?"target_offset"\s*:\s*"[^"]+"\s*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (
        typeof obj["input_i"] === "string" &&
        typeof obj["input_tp"] === "string" &&
        typeof obj["input_lra"] === "string" &&
        typeof obj["input_thresh"] === "string" &&
        typeof obj["target_offset"] === "string"
      ) {
        return {
          input_i: obj["input_i"],
          input_tp: obj["input_tp"],
          input_lra: obj["input_lra"],
          input_thresh: obj["input_thresh"],
          target_offset: obj["target_offset"],
        };
      }
    }
  } catch {
    // Malformed JSON block
  }
  return null;
}

/**
 * Removes DC offset in the sample domain by subtracting the mean sample amplitude.
 * Returns the modified Int16Array and the measured DC offset.
 */
export function removeDcOffset(samples: Int16Array): { samples: Int16Array; dcOffset: number } {
  if (samples.length === 0) {
    return { samples, dcOffset: 0 };
  }

  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i];
  }
  const mean = sum / samples.length;
  const dcOffset = Math.round(mean);

  if (dcOffset === 0) {
    return { samples, dcOffset: 0 };
  }

  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const corrected = samples[i] - dcOffset;
    out[i] = Math.max(-32768, Math.min(32767, corrected));
  }
  return { samples: out, dcOffset };
}

/**
 * Deterministically trims excess synthetic leading and trailing silence.
 * Strictly preserves all internal pauses between speech clauses.
 */
export function trimSilenceEdges(
  samples: Int16Array,
  threshold: number = SILENCE_AMPLITUDE_THRESHOLD,
  maxLeading: number = MAX_LEADING_SILENCE_SAMPLES,
  maxTrailing: number = MAX_TRAILING_SILENCE_SAMPLES,
): {
  trimmedSamples: Int16Array;
  leadingTrimmed: number;
  trailingTrimmed: number;
} {
  if (samples.length === 0) {
    return { trimmedSamples: samples, leadingTrimmed: 0, trailingTrimmed: 0 };
  }

  // Find first non-silent sample from start
  let firstNonSilent = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > threshold) {
      firstNonSilent = i;
      break;
    }
  }

  // Find last non-silent sample from end
  let lastNonSilent = -1;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (Math.abs(samples[i]) > threshold) {
      lastNonSilent = i;
      break;
    }
  }

  // If entirely silent, leave untouched (asset validator Gate 9 will fail it)
  if (firstNonSilent === -1 || lastNonSilent === -1) {
    return { trimmedSamples: samples, leadingTrimmed: 0, trailingTrimmed: 0 };
  }

  // Leading silence trimming: retain up to maxLeading samples before firstNonSilent
  let trimStart = 0;
  if (firstNonSilent > maxLeading) {
    trimStart = firstNonSilent - maxLeading;
  }

  // Trailing silence trimming: retain up to maxTrailing samples after lastNonSilent
  let trimEnd = samples.length;
  const trailingCount = samples.length - 1 - lastNonSilent;
  if (trailingCount > maxTrailing) {
    trimEnd = lastNonSilent + maxTrailing + 1;
  }

  const leadingTrimmed = trimStart;
  const trailingTrimmed = samples.length - trimEnd;

  const trimmedSamples = samples.subarray(trimStart, trimEnd);
  return {
    trimmedSamples,
    leadingTrimmed,
    trailingTrimmed,
  };
}

/**
 * Remaps provider alignment marks to canonical sample domain after resampling and edge trimming.
 * If alignment cannot be mapped truthfully or becomes invalid, degrades status to "none".
 */
export function remapAlignmentMarks(
  originalAlignment: NormalizedAlignment,
  inputSampleRate: number,
  leadingTrimmedSamples: number,
  finalSampleCount: number,
): NormalizedAlignment {
  if (originalAlignment.status === "none" || (originalAlignment.words.length === 0 && originalAlignment.phonemes.length === 0)) {
    return { status: "none", words: [], phonemes: [] };
  }

  const rateRatio = AUDIO_SAMPLE_RATE_HZ / inputSampleRate;

  const remapWord = (m: WordMark): WordMark => {
    const resampledStart = Math.round(m.start_sample * rateRatio);
    const resampledEnd = Math.round(m.end_sample * rateRatio);
    const shiftedStart = resampledStart - leadingTrimmedSamples;
    const shiftedEnd = resampledEnd - leadingTrimmedSamples;
    return {
      ordinal: m.ordinal,
      word: m.word,
      start_sample: shiftedStart,
      end_sample: shiftedEnd,
    };
  };

  const remapPhoneme = (p: PhonemeMark): PhonemeMark => {
    const resampledStart = Math.round(p.start_sample * rateRatio);
    const resampledEnd = Math.round(p.end_sample * rateRatio);
    const shiftedStart = resampledStart - leadingTrimmedSamples;
    const shiftedEnd = resampledEnd - leadingTrimmedSamples;
    return {
      ordinal: p.ordinal,
      phoneme: p.phoneme,
      start_sample: shiftedStart,
      end_sample: shiftedEnd,
    };
  };

  try {
    const remappedWords = originalAlignment.words.map(remapWord);
    const remappedPhonemes = originalAlignment.phonemes.map(remapPhoneme);

    // Verify word marks monotonicity and boundary constraints
    let prevEnd = 0;
    for (const w of remappedWords) {
      if (
        w.start_sample < 0 ||
        w.start_sample < prevEnd ||
        w.end_sample > finalSampleCount ||
        w.start_sample > w.end_sample
      ) {
        // Degrade honestly on negative, non-monotonic or out of bounds marks
        return { status: "none", words: [], phonemes: [] };
      }
      prevEnd = w.end_sample;
    }

    const candidate = {
      status: originalAlignment.status,
      words: remappedWords,
      phonemes: remappedPhonemes,
    };

    return NormalizedAlignmentSchema.parse(candidate);
  } catch {
    return { status: "none", words: [], phonemes: [] };
  }
}

/**
 * VoiceAssetNormalizer: transforms raw provider audio bytes into canonical 48 kHz mono 16-bit WAV.
 */
export class VoiceAssetNormalizer {
  private readonly ffmpegPath: string;

  constructor(options?: { ffmpegPath?: string }) {
    this.ffmpegPath = resolvePinnedFfmpeg({ ffmpegPath: options?.ffmpegPath });
  }

  /**
   * Normalizes raw audio bytes into canonical mastered RIFF WAV adhering to P10 standards.
   */
  async normalize(
    rawAudioBytes: Buffer,
    alignment: NormalizedAlignment = { status: "none", words: [], phonemes: [] },
    options?: NormalizationOptions,
  ): Promise<VoiceNormalizationResult> {
    const ffmpeg = options?.ffmpegPath ?? this.ffmpegPath;
    const timeoutMs = options?.timeoutMs ?? VOICE_TIMEOUTS.normalization_ms;
    const signal = options?.signal;
    const inRate = options?.inputSampleRate ?? AUDIO_SAMPLE_RATE_HZ;

    if (signal?.aborted) {
      throw new Error("[CANCELLED] Normalization cancelled before execution");
    }

    // Pass 1: Loudness measurement & resampling test
    const pass1Result = await runTrustedFfmpeg({
      ffmpegPath: ffmpeg,
      argv: [
        "-hide_banner",
        "-i", "pipe:0",
        "-af", "aresample=48000:resampler=soxr,loudnorm=I=-19.0:TP=-1.0:LRA=6.0:print_format=json",
        "-f", "null",
        "-",
      ],
      inputBuffer: rawAudioBytes,
      timeoutMs,
      signal,
    });

    const loudnormParams = parseLoudnormJson(pass1Result.stderr);

    // Determine if audio is suitable for EBU R128 two-pass
    const hasFiniteLoudness =
      loudnormParams !== null &&
      Number.isFinite(parseFloat(loudnormParams.input_i)) &&
      Number.isFinite(parseFloat(loudnormParams.target_offset));

    let rawPcmBuffer: Buffer;
    let normalizationMode: "ebu_r128_two_pass" | "short_clip_peak_fallback";

    if (hasFiniteLoudness) {
      // Pass 2: EBU R128 linear normalization
      normalizationMode = "ebu_r128_two_pass";
      const af =
        `aresample=48000:resampler=soxr,` +
        `loudnorm=I=-19.0:TP=-1.0:LRA=6.0:` +
        `measured_I=${loudnormParams.input_i}:` +
        `measured_TP=${loudnormParams.input_tp}:` +
        `measured_LRA=${loudnormParams.input_lra}:` +
        `measured_thresh=${loudnormParams.input_thresh}:` +
        `offset=${loudnormParams.target_offset}:linear=true`;

      const pass2Result = await runTrustedFfmpeg({
        ffmpegPath: ffmpeg,
        argv: [
          "-hide_banner",
          "-v", "error",
          "-i", "pipe:0",
          "-af", af,
          "-ar", "48000",
          "-ac", "1",
          "-c:a", "pcm_s16le",
          "-f", "s16le",
          "pipe:1",
        ],
        inputBuffer: rawAudioBytes,
        timeoutMs,
        signal,
      });
      rawPcmBuffer = pass2Result.stdout;
    } else {
      // Short-clip fallback: resample only via FFmpeg, peak normalize in sample domain
      normalizationMode = "short_clip_peak_fallback";
      const fallbackResult = await runTrustedFfmpeg({
        ffmpegPath: ffmpeg,
        argv: [
          "-hide_banner",
          "-v", "error",
          "-i", "pipe:0",
          "-af", "aresample=48000:resampler=soxr",
          "-ar", "48000",
          "-ac", "1",
          "-c:a", "pcm_s16le",
          "-f", "s16le",
          "pipe:1",
        ],
        inputBuffer: rawAudioBytes,
        timeoutMs,
        signal,
      });
      rawPcmBuffer = fallbackResult.stdout;
    }

    // Convert raw PCM to Int16Array
    const sampleCount = Math.floor(rawPcmBuffer.length / 2);
    const pcmSamples = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      pcmSamples[i] = rawPcmBuffer.readInt16LE(i * 2);
    }

    // Stage 5: DC Offset Removal
    const { samples: dcCorrected, dcOffset } = removeDcOffset(pcmSamples);

    // Stage 6: Deterministic Silence Edge Trimming
    const {
      trimmedSamples,
      leadingTrimmed,
      trailingTrimmed,
    } = trimSilenceEdges(dcCorrected);

    let processedSamples = trimmedSamples;

    // For short clip fallback: perform peak normalization to TP <= -1.0 dBFS (peak amplitude <= 29,193)
    if (normalizationMode === "short_clip_peak_fallback" && processedSamples.length > 0) {
      let maxPeak = 0;
      for (let i = 0; i < processedSamples.length; i++) {
        const abs = Math.abs(processedSamples[i]);
        if (abs > maxPeak) maxPeak = abs;
      }
      if (maxPeak > 0) {
        const scale = PEAK_TARGET_AMPLITUDE / maxPeak;
        const peakScaled = new Int16Array(processedSamples.length);
        for (let i = 0; i < processedSamples.length; i++) {
          peakScaled[i] = Math.max(-32768, Math.min(32767, Math.round(processedSamples[i] * scale)));
        }
        processedSamples = peakScaled;
      }
    }

    // Stage 7: Word Alignment Remapping
    const remappedAlignment = remapAlignmentMarks(
      alignment,
      inRate,
      leadingTrimmed,
      processedSamples.length,
    );

    // Stage 8: Pack canonical minimal 44-byte RIFF WAV
    const canonicalWav = encodeWavPcm16Mono48k(processedSamples);

    // Stage 9: 11-point validation
    const report = validateVoiceAssetBytes(canonicalWav);

    const metrics: NormalizationMetrics = {
      normalization_mode: normalizationMode,
      measured_i: loudnormParams ? parseFloat(loudnormParams.input_i) : undefined,
      measured_tp: loudnormParams ? parseFloat(loudnormParams.input_tp) : undefined,
      measured_lra: loudnormParams ? parseFloat(loudnormParams.input_lra) : undefined,
      measured_thresh: loudnormParams ? parseFloat(loudnormParams.input_thresh) : undefined,
      target_offset: loudnormParams ? parseFloat(loudnormParams.target_offset) : undefined,
      dc_offset_removed: dcOffset,
      leading_samples_trimmed: leadingTrimmed,
      trailing_samples_trimmed: trailingTrimmed,
    };

    return {
      canonical_wav: canonicalWav,
      sample_count: processedSamples.length,
      duration_us: report.duration_us,
      alignment: remappedAlignment,
      report,
      metrics,
    };
  }
}
