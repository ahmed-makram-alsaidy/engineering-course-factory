// P10.2 Deterministic Offline Fake Voice Provider (FakeVoiceProvider)
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8, 30 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Key properties:
// - Completely offline: zero network, zero HTTP/fetch/axios, zero provider SDKs.
// - 100% deterministic: bit-exact RIFF WAV pcm_s16le 48 kHz mono output.
// - Zero floating-point divergence: precomputed 1024-entry integer sine lookup table.
// - Algorithmic duration: sample_count and duration_us derived from normalized text tokenization.
// - Exact alignment marks: monotonic, sample-bounded word marks matching token sequence.
// - Cancellation & timeout support: AbortSignal-aware with canonical CANCELLED / TIMEOUT taxonomy.
// - Test-only failure injection: strictly constructor/instance owned, never exposed to renderer.
// - Idempotent request correlation: request_id correlates operations without altering acoustic output.
// - Zero credentials, zero filesystem paths, zero production cache publication.

import {
  AUDIO_CHANNELS,
  AUDIO_CONTAINER,
  AUDIO_SAMPLE_RATE_HZ,
  MAX_AUDIO_SAMPLE_COUNT,
  MIN_AUDIO_SAMPLE_COUNT,
  durationUsForSampleCount,
} from "./audio-clock.ts";
import {
  type ProviderCapabilities,
  ProviderCapabilitiesSchema,
  type ProviderIdentity,
  ProviderIdentitySchema,
  type ProviderSynthesisResult,
  type VoiceProvider,
  VoiceProviderError,
  validateProviderSynthesisResult,
} from "./provider-interface.ts";
import {
  type AlignmentStatus,
  type NormalizedAlignment,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  type SynthesisRequest,
  SynthesisRequestSchema,
  type SynthesisResultDescriptor,
  VOICE_TIMEOUTS,
  type VoiceFailureCode,
  type WordMark,
} from "./protocol.ts";
import { encodeWavPcm16Mono48k } from "./wav.ts";

// ---------------------------------------------------------------------------
// Precomputed Integer Sine Lookup Table (1024 entries, amplitude 6000)
// Guarantees identical integer arithmetic across all CPU architectures
// ---------------------------------------------------------------------------

const SINE_TABLE_SIZE = 1024;
const SINE_AMPLITUDE = 6000; // Well within Int16 range [-32768, 32767], zero clipping
const SINE_TABLE = new Int16Array(SINE_TABLE_SIZE);

for (let i = 0; i < SINE_TABLE_SIZE; i++) {
  SINE_TABLE[i] = Math.round(SINE_AMPLITUDE * Math.sin((2 * Math.PI * i) / SINE_TABLE_SIZE));
}

// ---------------------------------------------------------------------------
// Failure Injection Configuration (Test-Only)
// ---------------------------------------------------------------------------

export interface FailureInjectionConfig {
  readonly code: VoiceFailureCode;
  readonly retryAfterMs?: number;
  readonly message?: string;
  readonly delayMs?: number;
  readonly target?: "synthesize" | "probe";
}

export interface FakeVoiceProviderOptions {
  readonly defaultVoiceId?: string;
  readonly supportedLocales?: readonly SupportedLocale[];
  readonly supportedVoices?: readonly string[];
  readonly maxTextLength?: number;
  readonly simulatedLatencyMs?: number;
  readonly failureInjection?: FailureInjectionConfig;
  readonly scheduler?: {
    setTimeout(fn: () => void, ms: number): { cancel: () => void };
    now(): number;
  };
}

// ---------------------------------------------------------------------------
// FakeVoiceProvider Implementation
// ---------------------------------------------------------------------------

export class FakeVoiceProvider implements VoiceProvider {
  readonly family = "fake" as const;
  readonly model = "deterministic-v1" as const;
  readonly defaultVoiceId: string;

  private readonly supportedLocales: readonly SupportedLocale[];
  private readonly supportedVoices?: readonly string[];
  private readonly maxTextLength: number;
  private readonly simulatedLatencyMs: number;
  private failureInjection?: FailureInjectionConfig;
  private readonly scheduler: {
    setTimeout(fn: () => void, ms: number): { cancel: () => void };
    now(): number;
  };

  // In-flight request cancellation tracking
  private readonly activeRequests = new Map<string, (err: Error) => void>();

  constructor(options: FakeVoiceProviderOptions = {}) {
    this.defaultVoiceId = options.defaultVoiceId ?? "fixture-neutral";
    this.supportedLocales = options.supportedLocales ?? [...SUPPORTED_LOCALES];
    this.supportedVoices = options.supportedVoices;
    this.maxTextLength = options.maxTextLength ?? 10_000;
    this.simulatedLatencyMs = options.simulatedLatencyMs ?? 0;
    this.failureInjection = options.failureInjection;

    this.scheduler = options.scheduler ?? {
      setTimeout(fn: () => void, ms: number) {
        const timer = setTimeout(fn, ms);
        return {
          cancel() {
            clearTimeout(timer);
          },
        };
      },
      now() {
        return Date.now();
      },
    };
  }

  /**
   * Returns current provider identity.
   */
  getIdentity(voiceId?: string): ProviderIdentity {
    return {
      provider_family: this.family,
      provider_model: this.model,
      provider_voice_id: voiceId ?? this.defaultVoiceId,
    };
  }

  /**
   * Injects failure for test scenarios.
   */
  injectFailure(config: FailureInjectionConfig | undefined): void {
    this.failureInjection = config;
  }

  /**
   * Probes provider capabilities.
   * Bound by VOICE_TIMEOUTS.probe_ms (5,000 ms).
   */
  async probeCapabilities(): Promise<ProviderCapabilities> {
    const identity = this.getIdentity();

    // Check for injected probe failure
    if (this.failureInjection && (this.failureInjection.target === "probe" || !this.failureInjection.target)) {
      if (this.failureInjection.target === "probe") {
        throw new VoiceProviderError({
          code: this.failureInjection.code,
          message: this.failureInjection.message ?? `Injected probe failure: ${this.failureInjection.code}`,
          provider_identity: identity,
          retry_after_ms: this.failureInjection.retryAfterMs,
        });
      }
    }

    const capabilities: ProviderCapabilities = {
      provider_family: this.family,
      supported_locales: this.supportedLocales,
      alignment_support: "word",
      supports_word_alignment: true,
      supports_phoneme_alignment: false,
      supports_cancellation: true,
      supports_idempotency_key: true,
      max_characters_per_request: this.maxTextLength,
      sample_rates: [AUDIO_SAMPLE_RATE_HZ],
      channels: [AUDIO_CHANNELS],
      output_formats: [AUDIO_CONTAINER],
      supports_rate_control: true,
      supports_pitch_control: true,
      supports_style_control: true,
    };

    return ProviderCapabilitiesSchema.parse(capabilities);
  }

  /**
   * Cancels in-flight synthesis operation by request_id.
   * Idempotent: safe to call if operation has already completed or does not exist.
   */
  async cancel(requestId: string): Promise<void> {
    const cancelFn = this.activeRequests.get(requestId);
    if (cancelFn) {
      const identity = this.getIdentity();
      cancelFn(
        new VoiceProviderError({
          code: "CANCELLED",
          message: `Synthesis request ${requestId} cancelled via provider cancel()`,
          provider_identity: identity,
        }),
      );
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * Synthesizes canonical audio deterministically.
   */
  async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<ProviderSynthesisResult> {
    const identity: ProviderIdentity = {
      provider_family: this.family,
      provider_model: this.model,
      provider_voice_id: request.voice_profile?.provider_voice_id ?? this.defaultVoiceId,
    };

    // 1. Immediate cancellation check before any execution
    if (signal?.aborted) {
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: `Synthesis request ${request.request_id} cancelled before start`,
        provider_identity: identity,
      });
    }

    // 2. Strict request validation
    const parsedRequest = SynthesisRequestSchema.parse(request);

    // 3. Text emptiness validation (whitespace-only rejected)
    const trimmedText = parsedRequest.normalized_text.trim();
    if (trimmedText.length === 0) {
      throw new VoiceProviderError({
        code: "TEXT_EMPTY",
        message: "Normalized text is empty or contains only whitespace",
        provider_identity: identity,
      });
    }

    // 4. Max text length boundary
    if (parsedRequest.normalized_text.length > this.maxTextLength) {
      throw new VoiceProviderError({
        code: "VALIDATION_FAILED",
        message: `Text length (${parsedRequest.normalized_text.length}) exceeds provider maximum of ${this.maxTextLength} characters`,
        provider_identity: identity,
      });
    }

    // 5. Locale support boundary
    if (!this.supportedLocales.includes(parsedRequest.locale)) {
      throw new VoiceProviderError({
        code: "UNSUPPORTED_LOCALE",
        message: `Provider does not support locale '${parsedRequest.locale}'`,
        provider_identity: identity,
      });
    }

    // 6. Voice ID support boundary (if configured)
    if (
      this.supportedVoices &&
      !this.supportedVoices.includes(parsedRequest.voice_profile.provider_voice_id)
    ) {
      throw new VoiceProviderError({
        code: "UNSUPPORTED_VOICE",
        message: `Provider voice '${parsedRequest.voice_profile.provider_voice_id}' is not supported`,
        provider_identity: identity,
      });
    }

    // 7. Test-Only Failure Injection
    if (this.failureInjection && this.failureInjection.target !== "probe") {
      const fi = this.failureInjection;
      if (fi.delayMs && fi.delayMs > 0) {
        await this.delayWithAbort(fi.delayMs, parsedRequest.request_id, signal, identity);
      }
      throw new VoiceProviderError({
        code: fi.code,
        message: fi.message ?? `Injected failure: ${fi.code}`,
        provider_identity: identity,
        retry_after_ms: fi.retryAfterMs,
      });
    }

    // 8. Simulated latency with cancellation support
    if (this.simulatedLatencyMs > 0) {
      await this.delayWithAbort(this.simulatedLatencyMs, parsedRequest.request_id, signal, identity);
    }

    // 9. Re-check cancellation after any delay
    if (signal?.aborted) {
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: `Synthesis request ${parsedRequest.request_id} cancelled during execution`,
        provider_identity: identity,
      });
    }

    // 10. Compute deterministic duration, word marks, and waveform
    const { sampleCount, durationUs, alignment, samples } = this.generateDeterministicAudio(parsedRequest);

    // 11. Encode to canonical RIFF WAV Buffer
    const audioBytes = encodeWavPcm16Mono48k(samples);

    // 12. Build descriptor
    const descriptor: SynthesisResultDescriptor = {
      provider_family: this.family,
      provider_model: this.model,
      provider_voice_id: parsedRequest.voice_profile.provider_voice_id,
      provider_request_id: parsedRequest.request_id,
      format: AUDIO_CONTAINER,
      sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
      channels: AUDIO_CHANNELS,
      sample_count: sampleCount,
      duration_us: durationUs,
      alignment_status: alignment.status,
      characters_billed: parsedRequest.normalized_text.length,
      latency_ms: this.simulatedLatencyMs > 0 ? this.simulatedLatencyMs : 5,
    };

    const result: ProviderSynthesisResult = {
      audio_bytes: audioBytes,
      descriptor,
      alignment,
      provider_family: descriptor.provider_family,
      provider_model: descriptor.provider_model,
      provider_voice_id: descriptor.provider_voice_id,
      provider_request_id: descriptor.provider_request_id,
      format: descriptor.format,
      sample_rate_hz: descriptor.sample_rate_hz,
      channels: descriptor.channels,
      sample_count: descriptor.sample_count,
      duration_us: descriptor.duration_us,
      alignment_status: descriptor.alignment_status,
      characters_billed: descriptor.characters_billed,
      latency_ms: descriptor.latency_ms,
    };

    // 13. Validate result strictly before returning
    validateProviderSynthesisResult(result);

    return result;
  }

  /**
   * Helper to wait for a delay while listening to AbortSignal and activeRequests.
   */
  private delayWithAbort(
    delayMs: number,
    requestId: string,
    signal: AbortSignal | undefined,
    identity: ProviderIdentity,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        settled = true;
        this.activeRequests.delete(requestId);
        timerHandle.cancel();
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      };

      const onAbort = () => {
        if (settled) return;
        cleanup();
        // Distinguish AbortSignal.timeout from manual abort
        const isTimeout =
          signal?.reason instanceof Error &&
          (signal.reason.name === "TimeoutError" || signal.reason.message.toLowerCase().includes("timeout"));

        const code: VoiceFailureCode = isTimeout ? "TIMEOUT" : "CANCELLED";
        reject(
          new VoiceProviderError({
            code,
            message: isTimeout
              ? `Synthesis request ${requestId} timed out after ${delayMs} ms`
              : `Synthesis request ${requestId} aborted by signal`,
            provider_identity: identity,
          }),
        );
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.activeRequests.set(requestId, (err: Error) => {
        if (settled) return;
        cleanup();
        reject(err);
      });

      const timerHandle = this.scheduler.setTimeout(() => {
        if (settled) return;
        cleanup();
        resolve();
      }, delayMs);
    });
  }

  /**
   * Generates deterministic samples, duration, and alignment from the request.
   *
   * Frozen duration formula:
   * 1. Tokenize normalized_text by whitespace.
   * 2. Lead-in: 2,400 samples (50 ms).
   * 3. Each token i:
   *    token_samples = 9600 + min(token_len, 20) * 480 (200..400 ms base).
   *    scaled_samples = round(token_samples / rate).
   *    scaled_gap = round(2400 / rate).
   * 4. Lead-out: 2,400 samples (50 ms).
   * 5. sample_count = max(4800, total_samples).
   * 6. duration_us = floor(sample_count * 125 / 6).
   * 7. Tone generation: Integer sine lookup table modulated by acoustic seed (FNV-1a of text + locale + profile).
   *    request_id is strictly EXCLUDED from acoustic seed.
   */
  private generateDeterministicAudio(request: SynthesisRequest): {
    sampleCount: number;
    durationUs: number;
    alignment: NormalizedAlignment;
    samples: Int16Array;
  } {
    const tokens = request.normalized_text.trim().split(/\s+/).filter(Boolean);
    const rate = request.voice_profile.rate; // 0.5 .. 2.0

    const leadInSamples = 2400; // 50 ms
    const baseGapSamples = 2400; // 50 ms
    const leadOutSamples = 2400; // 50 ms
    const scaledGapSamples = Math.max(960, Math.round(baseGapSamples / rate));

    const wordMarks: WordMark[] = [];
    let currentSample = leadInSamples;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const tokenLen = token.length;
      const baseTokenSamples = 9600 + Math.min(tokenLen, 20) * 480;
      const scaledTokenSamples = Math.max(2400, Math.round(baseTokenSamples / rate));

      const startSample = currentSample;
      const endSample = startSample + scaledTokenSamples;

      wordMarks.push({
        ordinal: i + 1,
        word: token,
        start_sample: startSample,
        end_sample: endSample,
      });

      currentSample = endSample + scaledGapSamples;
    }

    const calculatedSamples = currentSample + leadOutSamples;
    const sampleCount = Math.max(MIN_AUDIO_SAMPLE_COUNT, calculatedSamples);

    if (sampleCount > MAX_AUDIO_SAMPLE_COUNT) {
      throw new VoiceProviderError({
        code: "VALIDATION_FAILED",
        message: `Synthesized sample count ${sampleCount} exceeds maximum permitted 300-second limit (${MAX_AUDIO_SAMPLE_COUNT} samples)`,
        provider_identity: this.getIdentity(request.voice_profile.provider_voice_id),
      });
    }

    const durationUs = durationUsForSampleCount(sampleCount);

    // Build alignment container
    let alignment: NormalizedAlignment;
    if (request.request_alignment) {
      alignment = {
        status: "word",
        words: wordMarks,
        phonemes: [],
      };
    } else {
      alignment = {
        status: "none",
        words: [],
        phonemes: [],
      };
    }

    // Synthesize waveform samples
    const samples = new Int16Array(sampleCount);
    const acousticSeed = this.deriveAcousticSeed(request);

    // Base phase step derived from acoustic seed and profile pitch
    const pitchOffset = Math.round(request.voice_profile.pitch);
    const baseStep = Math.max(1, ((5 + (acousticSeed % 11) + pitchOffset) & 0x3f) || 1);

    // Fill samples: active tone during words, silence during lead-in, gaps, and lead-out
    for (let w = 0; w < wordMarks.length; w++) {
      const mark = wordMarks[w];
      const wordToken = mark.word;
      const wordSeed = this.hashToken(wordToken);
      const tokenStep = Math.max(1, ((baseStep + (wordSeed % 7)) & 0x3f) || 1);

      let phase = 0;
      for (let s = mark.start_sample; s < mark.end_sample && s < sampleCount; s++) {
        samples[s] = SINE_TABLE[phase & (SINE_TABLE_SIZE - 1)];
        phase += tokenStep;
      }
    }

    return { sampleCount, durationUs, alignment, samples };
  }

  /**
   * Computes deterministic 32-bit FNV-1a hash of request acoustic parameters.
   * Strictly excludes request_id, timestamps, and volatile IDs.
   */
  private deriveAcousticSeed(request: SynthesisRequest): number {
    const key = [
      request.locale,
      request.voice_profile.profile_id,
      request.voice_profile.provider_voice_id,
      request.voice_profile.rate.toFixed(2),
      request.voice_profile.pitch.toFixed(2),
      request.voice_profile.style ?? "default",
      request.normalized_text,
    ].join("|");

    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  /**
   * Deterministic 32-bit token hash.
   */
  private hashToken(token: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }
}
