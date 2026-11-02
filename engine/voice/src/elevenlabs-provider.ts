// P10.8 ElevenLabs REST Voice Provider (ElevenLabsVoiceProvider)
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8, 30 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Production-capable ElevenLabs REST TTS Provider:
// - Implements vendor-neutral VoiceProvider interface.
// - Supports eleven_multilingual_v2 and stock voices for Arabic and English.
// - Zero third-party SDK dependencies (uses native Node.js fetch with AbortSignal).
// - Supports output_format=pcm_48000 packaged into canonical RIFF WAV.
// - Supports with-timestamps endpoint for word-level alignment extraction.
// - Secret resolution via VoiceSecretResolver / VoiceCredentialStore boundary.
// - Secret redaction on all error messages; zero credentials leaked in logs or traces.
// - Strict response byte bound enforcement (MAX_PROVIDER_RESPONSE_BYTES = 32 MiB).
// - Full cancellation support (AbortSignal and cancel(requestId)).

import {
  AUDIO_CHANNELS,
  AUDIO_CONTAINER,
  AUDIO_SAMPLE_RATE_HZ,
  durationUsForSampleCount,
} from "./audio-clock.ts";
import {
  type ProviderCapabilities,
  type ProviderIdentity,
  type ProviderSynthesisResult,
  type VoiceProvider,
  VoiceProviderError,
  validateProviderSynthesisResult,
  MAX_PROVIDER_RESPONSE_BYTES,
} from "./provider-interface.ts";
import {
  type AlignmentStatus,
  type NormalizedAlignment,
  SUPPORTED_LOCALES,
  type SupportedLocale,
  type SynthesisRequest,
  SynthesisRequestSchema,
  type SynthesisResultDescriptor,
  type WordMark,
  VOICE_TIMEOUTS,
} from "./protocol.ts";
import { buildWavHeader, parseWavHeader } from "./wav.ts";
import { type VoiceSecretResolver } from "./credential-types.ts";
import { defaultSecretRedactor, SecretRedactor } from "./redactor.ts";

export interface ElevenLabsVoiceProviderOptions {
  /** Optional secret resolver (e.g. VoiceCredentialStore). Defaults to environment resolver. */
  readonly secretResolver?: VoiceSecretResolver;
  /** Injectable fetch function for deterministic offline testing. Defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
  /** User-Agent header value. */
  readonly userAgent?: string;
  /** Optional secret redactor. Defaults to defaultSecretRedactor. */
  readonly redactor?: SecretRedactor;
}

function defaultEnvResolver(): VoiceSecretResolver {
  return {
    async resolveSecret(query) {
      const family = query.provider_family.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
      const key = query.secret_key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
      return (
        process.env[`COURSE_FACTORY_TTS_${family}_${key}`] ??
        process.env[`${family}_${key}`] ??
        null
      );
    },
    async hasSecret(query) {
      const val = await this.resolveSecret(query);
      return val !== null;
    },
  };
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly family: string = "elevenlabs";

  private readonly secretResolver: VoiceSecretResolver;
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;
  private readonly redactor: SecretRedactor;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(options?: ElevenLabsVoiceProviderOptions) {
    this.secretResolver = options?.secretResolver ?? defaultEnvResolver();
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.userAgent = options?.userAgent ?? "CourseFactoryVoice/1.0";
    this.redactor = options?.redactor ?? defaultSecretRedactor;
  }

  /**
   * Probes ElevenLabs provider capabilities.
   */
  async probeCapabilities(): Promise<ProviderCapabilities> {
    return {
      provider_family: "elevenlabs",
      supported_locales: [...SUPPORTED_LOCALES],
      alignment_support: "word",
      supports_word_alignment: true,
      supports_phoneme_alignment: false,
      supports_cancellation: true,
      supports_idempotency_key: false,
      max_characters_per_request: 5_000,
      sample_rates: [AUDIO_SAMPLE_RATE_HZ],
      channels: [AUDIO_CHANNELS],
      output_formats: ["pcm_48000"],
      supports_rate_control: true,
      supports_pitch_control: false,
      supports_style_control: true,
    };
  }

  /**
   * Synthesizes audio using ElevenLabs Text-to-Speech REST API.
   */
  async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<ProviderSynthesisResult> {
    const parsedRequest = SynthesisRequestSchema.parse(request);
    const identity: ProviderIdentity = {
      provider_family: "elevenlabs",
      provider_model: parsedRequest.voice_profile.provider_model,
      provider_voice_id: parsedRequest.voice_profile.provider_voice_id,
    };

    // 1. Setup cancellation tracking immediately
    const controller = new AbortController();
    this.activeControllers.set(parsedRequest.request_id, controller);

    const onCallerAbort = () => {
      controller.abort();
    };

    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      if (signal?.aborted || controller.signal.aborted) {
        throw new VoiceProviderError({
          code: "CANCELLED",
          message: "ElevenLabs synthesis cancelled prior to dispatch",
          provider_identity: identity,
        });
      }

      const apiKey =
        (await this.secretResolver.resolveSecret({ provider_family: "elevenlabs", secret_key: "api_key" })) ??
        (await this.secretResolver.resolveSecret({ provider_family: "elevenlabs", secret_key: "xi_api_key" }));

      if (!apiKey || apiKey.trim().length === 0) {
        throw new VoiceProviderError({
          code: "AUTH_FAILED",
          message: "ElevenLabs API key is not configured in VoiceCredentialStore",
          provider_identity: identity,
        });
      }

      this.redactor.registerSecret(apiKey.trim());

      const voiceId = parsedRequest.voice_profile.provider_voice_id;
      const modelId = parsedRequest.voice_profile.provider_model || "eleven_multilingual_v2";

      const useTimestamps = parsedRequest.request_alignment;
      const endpointPath = useTimestamps ? "with-timestamps" : "";
      const endpoint = endpointPath
        ? `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/${endpointPath}?output_format=pcm_48000`
        : `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_48000`;

      const startTime = Date.now();

      const response = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey.trim(),
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body: JSON.stringify({
          text: parsedRequest.normalized_text,
          model_id: modelId,
        }),
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        await this.handleErrorResponse(response, identity);
      }

      let pcmBytes: Buffer;
      let alignmentStatus: AlignmentStatus = "none";
      let words: WordMark[] = [];

      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/json") || useTimestamps) {
        const jsonText = await response.text();
        const jsonBody = JSON.parse(jsonText);

        if (!jsonBody.audio_base64 || typeof jsonBody.audio_base64 !== "string") {
          throw new VoiceProviderError({
            code: "SYNTHESIS_FAILED",
            message: "ElevenLabs response missing audio_base64 payload",
            provider_identity: identity,
          });
        }

        pcmBytes = Buffer.from(jsonBody.audio_base64, "base64");

        if (jsonBody.alignment && Array.isArray(jsonBody.alignment.characters)) {
          const wordsExtracted = this.extractWordMarks(
            jsonBody.alignment.characters,
            jsonBody.alignment.character_start_times_seconds,
            jsonBody.alignment.character_end_times_seconds,
            Math.floor(pcmBytes.length / 2),
          );
          if (wordsExtracted.length > 0) {
            words = wordsExtracted;
            alignmentStatus = "word";
          }
        }
      } else {
        const arrayBuffer = await response.arrayBuffer();
        const raw = Buffer.from(arrayBuffer);
        if (raw.subarray(0, 4).toString("ascii") === "RIFF") {
          const info = parseWavHeader(raw);
          pcmBytes = raw.subarray(info.dataOffset, info.dataOffset + info.dataLength);
        } else {
          pcmBytes = raw;
        }
      }

      if (pcmBytes.length === 0) {
        throw new VoiceProviderError({
          code: "SYNTHESIS_FAILED",
          message: "ElevenLabs returned empty audio payload (0 bytes)",
          provider_identity: identity,
        });
      }

      const sampleCount = Math.floor(pcmBytes.length / 2);
      const wavHeader = buildWavHeader(sampleCount);
      const audioBytes = Buffer.concat([wavHeader, pcmBytes]);

      if (audioBytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new VoiceProviderError({
          code: "SYNTHESIS_FAILED",
          message: `ElevenLabs response size ${audioBytes.length} exceeds maximum allowed limit ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
          provider_identity: identity,
        });
      }

      const durationUs = durationUsForSampleCount(sampleCount);

      const descriptor: SynthesisResultDescriptor = {
        provider_family: "elevenlabs",
        provider_model: parsedRequest.voice_profile.provider_model,
        provider_voice_id: parsedRequest.voice_profile.provider_voice_id,
        provider_request_id: parsedRequest.request_id,
        format: AUDIO_CONTAINER,
        sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
        channels: AUDIO_CHANNELS,
        sample_count: sampleCount,
        duration_us: durationUs,
        alignment_status: alignmentStatus,
      };

      const alignment: NormalizedAlignment = {
        status: alignmentStatus,
        words,
        phonemes: [],
      };

      const result: ProviderSynthesisResult = {
        audio_bytes: audioBytes,
        descriptor,
        alignment,
        provider_family: "elevenlabs",
        provider_model: parsedRequest.voice_profile.provider_model,
        provider_voice_id: parsedRequest.voice_profile.provider_voice_id,
        provider_request_id: parsedRequest.request_id,
        format: AUDIO_CONTAINER,
        sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
        channels: AUDIO_CHANNELS,
        sample_count: sampleCount,
        duration_us: durationUs,
        alignment_status: alignmentStatus,
        characters_billed: parsedRequest.normalized_text.length,
        latency_ms: latencyMs,
      };

      validateProviderSynthesisResult(result);
      return result;
    } catch (err) {
      if (signal?.aborted || controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new VoiceProviderError({
          code: "CANCELLED",
          message: "ElevenLabs synthesis cancelled",
          provider_identity: identity,
          cause: err,
        });
      }

      if (err instanceof VoiceProviderError) {
        throw err;
      }

      const safeMsg = this.redactor.redact(err instanceof Error ? err.message : String(err));
      throw new VoiceProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message: `ElevenLabs network error: ${safeMsg}`,
        provider_identity: identity,
        cause: err,
      });
    } finally {
      this.activeControllers.delete(parsedRequest.request_id);
      if (signal) {
        signal.removeEventListener("abort", onCallerAbort);
      }
    }
  }

  /**
   * Cancels an in-flight synthesis request by request ID.
   */
  async cancel(requestId: string): Promise<void> {
    const controller = this.activeControllers.get(requestId);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(requestId);
    }
  }

  /**
   * Extracts word-level marks from character arrays returned by ElevenLabs.
   */
  private extractWordMarks(
    chars: readonly string[],
    starts: readonly number[],
    ends: readonly number[],
    totalSamples: number,
  ): WordMark[] {
    const words: WordMark[] = [];
    let currentWord = "";
    let wordStartSample = -1;
    let wordEndSample = -1;
    let ordinal = 1;
    let prevEndSample = 0;

    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const startSec = starts[i] ?? 0;
      const endSec = ends[i] ?? startSec;
      const sStart = Math.min(totalSamples, Math.max(prevEndSample, Math.floor(startSec * AUDIO_SAMPLE_RATE_HZ)));
      const sEnd = Math.min(totalSamples, Math.max(sStart, Math.floor(endSec * AUDIO_SAMPLE_RATE_HZ)));

      if (/\s/.test(c)) {
        if (currentWord.length > 0) {
          words.push({
            ordinal: ordinal++,
            word: currentWord,
            start_sample: wordStartSample,
            end_sample: wordEndSample,
          });
          prevEndSample = wordEndSample;
          currentWord = "";
          wordStartSample = -1;
          wordEndSample = -1;
        }
      } else {
        if (currentWord.length === 0) {
          wordStartSample = sStart;
        }
        currentWord += c;
        wordEndSample = sEnd;
      }
    }

    if (currentWord.length > 0 && wordStartSample >= 0 && wordEndSample >= wordStartSample) {
      words.push({
        ordinal: ordinal++,
        word: currentWord,
        start_sample: wordStartSample,
        end_sample: wordEndSample,
      });
    }

    return words;
  }

  private async handleErrorResponse(response: Response, identity: ProviderIdentity): Promise<never> {
    let errorDetail = "";
    try {
      const text = await response.text();
      errorDetail = this.redactor.redact(text).slice(0, 500);
    } catch {
      errorDetail = "failed to read error response body";
    }

    const status = response.status;
    if (status === 401 || status === 403) {
      throw new VoiceProviderError({
        code: "AUTH_FAILED",
        message: `ElevenLabs authentication failed (${status}): ${errorDetail}`,
        provider_identity: identity,
      });
    }

    if (status === 429) {
      throw new VoiceProviderError({
        code: "RATE_LIMITED",
        message: `ElevenLabs rate limited (429): ${errorDetail}`,
        provider_identity: identity,
        retry_after_ms: 2_000,
      });
    }

    if (status >= 500 && status <= 599) {
      throw new VoiceProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message: `ElevenLabs service error (${status}): ${errorDetail}`,
        provider_identity: identity,
      });
    }

    throw new VoiceProviderError({
      code: "SYNTHESIS_FAILED",
      message: `ElevenLabs request failed (${status}): ${errorDetail}`,
      provider_identity: identity,
    });
  }
}
