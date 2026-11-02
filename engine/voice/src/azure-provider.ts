// P10.8 Microsoft Azure Speech REST Voice Provider (AzureVoiceProvider)
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8, 30 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Production-capable Azure Speech REST TTS Provider:
// - Implements vendor-neutral VoiceProvider interface.
// - Supports explicit Egyptian Arabic (ar-EG-ShakirNeural, ar-EG-SalmaNeural)
//   and English neural voices (e.g. en-US-AndrewMultilingualNeural, en-US-JennyNeural).
// - Zero third-party SDK dependencies (uses native Node.js fetch with AbortSignal).
// - Requests native canonical format: riff-48khz-16bit-mono-pcm (48 kHz mono 16-bit PCM RIFF WAV).
// - Secret resolution via VoiceSecretResolver / VoiceCredentialStore boundary.
// - Secret redaction on all error messages; zero credentials leaked in logs or traces.
// - Strict response byte bound enforcement (MAX_PROVIDER_RESPONSE_BYTES = 32 MiB).
// - Full cancellation support (AbortSignal and cancel(requestId)).
// - Standard error mapping into canonical VoiceFailureCode taxonomy (AUTH_FAILED, RATE_LIMITED, etc.).

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
  VOICE_TIMEOUTS,
} from "./protocol.ts";
import { parseWavHeader } from "./wav.ts";
import { type VoiceSecretResolver } from "./credential-types.ts";
import { defaultSecretRedactor, SecretRedactor } from "./redactor.ts";

export interface AzureVoiceProviderOptions {
  /** Optional secret resolver (e.g. VoiceCredentialStore). Defaults to environment resolver. */
  readonly secretResolver?: VoiceSecretResolver;
  /** Default Azure region if not specified in credentials (e.g. "eastus"). */
  readonly defaultRegion?: string;
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

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export class AzureVoiceProvider implements VoiceProvider {
  readonly family: string = "azure";

  private readonly secretResolver: VoiceSecretResolver;
  private readonly defaultRegion?: string;
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;
  private readonly redactor: SecretRedactor;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(options?: AzureVoiceProviderOptions) {
    this.secretResolver = options?.secretResolver ?? defaultEnvResolver();
    this.defaultRegion = options?.defaultRegion;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.userAgent = options?.userAgent ?? "CourseFactoryVoice/1.0";
    this.redactor = options?.redactor ?? defaultSecretRedactor;
  }

  /**
   * Probes Azure Speech provider capabilities.
   */
  async probeCapabilities(): Promise<ProviderCapabilities> {
    return {
      provider_family: "azure",
      supported_locales: [...SUPPORTED_LOCALES],
      alignment_support: "none",
      supports_word_alignment: false,
      supports_phoneme_alignment: false,
      supports_cancellation: true,
      supports_idempotency_key: false,
      max_characters_per_request: 10_000,
      sample_rates: [AUDIO_SAMPLE_RATE_HZ],
      channels: [AUDIO_CHANNELS],
      output_formats: ["riff-48khz-16bit-mono-pcm"],
      supports_rate_control: true,
      supports_pitch_control: true,
      supports_style_control: false,
    };
  }

  /**
   * Synthesizes audio using Azure Speech Text-to-Speech REST API.
   * Format: riff-48khz-16bit-mono-pcm (standard canonical WAV).
   */
  async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<ProviderSynthesisResult> {
    const parsedRequest = SynthesisRequestSchema.parse(request);
    const identity: ProviderIdentity = {
      provider_family: "azure",
      provider_model: parsedRequest.voice_profile.provider_model,
      provider_voice_id: parsedRequest.voice_profile.provider_voice_id,
    };

    // 1. Setup cancellation tracking immediately (before async resolution)
    const controller = new AbortController();
    this.activeControllers.set(parsedRequest.request_id, controller);

    const onCallerAbort = () => {
      controller.abort();
    };

    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      // 2. Check pre-aborted signal
      if (signal?.aborted || controller.signal.aborted) {
        throw new VoiceProviderError({
          code: "CANCELLED",
          message: "Azure Speech synthesis cancelled prior to dispatch",
          provider_identity: identity,
        });
      }

      // 3. Resolve credentials safely
      const apiKey =
        (await this.secretResolver.resolveSecret({ provider_family: "azure", secret_key: "api_key" })) ??
        (await this.secretResolver.resolveSecret({ provider_family: "azure", secret_key: "speech_key" })) ??
        (await this.secretResolver.resolveSecret({ provider_family: "azure", secret_key: "subscription_key" }));

      if (!apiKey || apiKey.trim().length === 0) {
        throw new VoiceProviderError({
          code: "AUTH_FAILED",
          message: "Azure Speech API key is not configured in VoiceCredentialStore",
          provider_identity: identity,
        });
      }

      // Register secret with redactor immediately
      this.redactor.registerSecret(apiKey.trim());

      const region =
        (await this.secretResolver.resolveSecret({ provider_family: "azure", secret_key: "region" })) ??
        (await this.secretResolver.resolveSecret({ provider_family: "azure", secret_key: "service_region" })) ??
        this.defaultRegion;

      if (!region || region.trim().length === 0) {
        throw new VoiceProviderError({
          code: "CONFIG_INVALID",
          message: "Azure Speech region is not configured in VoiceCredentialStore",
          provider_identity: identity,
        });
      }

      const trimmedRegion = region.trim().toLowerCase();
      const endpoint = `https://${trimmedRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;

      // 4. Build SSML payload
      const ssml = this.buildSsml(parsedRequest);

      const startTime = Date.now();
      const response = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": apiKey.trim(),
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "riff-48khz-16bit-mono-pcm",
          "User-Agent": this.userAgent,
        },
        body: ssml,
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        await this.handleErrorResponse(response, identity);
      }

      // Read audio data buffer
      const arrayBuffer = await response.arrayBuffer();
      const audioBytes = Buffer.from(arrayBuffer);

      if (audioBytes.length === 0) {
        throw new VoiceProviderError({
          code: "SYNTHESIS_FAILED",
          message: "Azure Speech returned empty audio response (0 bytes)",
          provider_identity: identity,
        });
      }

      if (audioBytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new VoiceProviderError({
          code: "SYNTHESIS_FAILED",
          message: `Azure Speech response size ${audioBytes.length} exceeds maximum allowed limit ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
          provider_identity: identity,
        });
      }

      // Parse WAV header to confirm format and exact sample count
      const wavInfo = parseWavHeader(audioBytes);
      if (
        wavInfo.formatCode !== 1 ||
        wavInfo.channels !== AUDIO_CHANNELS ||
        wavInfo.sampleRate !== AUDIO_SAMPLE_RATE_HZ
      ) {
        throw new VoiceProviderError({
          code: "SYNTHESIS_FAILED",
          message: `Azure Speech audio format mismatch: format=${wavInfo.formatCode} rate=${wavInfo.sampleRate} channels=${wavInfo.channels}`,
          provider_identity: identity,
        });
      }

      const sampleCount = wavInfo.sampleCount;
      const durationUs = durationUsForSampleCount(sampleCount);

      const descriptor: SynthesisResultDescriptor = {
        provider_family: "azure",
        provider_model: parsedRequest.voice_profile.provider_model,
        provider_voice_id: parsedRequest.voice_profile.provider_voice_id,
        provider_request_id: parsedRequest.request_id,
        format: AUDIO_CONTAINER,
        sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
        channels: AUDIO_CHANNELS,
        sample_count: sampleCount,
        duration_us: durationUs,
        alignment_status: "none",
      };

      const alignment: NormalizedAlignment = {
        status: "none",
        words: [],
        phonemes: [],
      };

      const result: ProviderSynthesisResult = {
        audio_bytes: audioBytes,
        descriptor,
        alignment,
        provider_family: "azure",
        provider_model: parsedRequest.voice_profile.provider_model,
        provider_voice_id: parsedRequest.voice_profile.provider_voice_id,
        provider_request_id: parsedRequest.request_id,
        format: AUDIO_CONTAINER,
        sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
        channels: AUDIO_CHANNELS,
        sample_count: sampleCount,
        duration_us: durationUs,
        alignment_status: "none",
        characters_billed: parsedRequest.normalized_text.length,
        latency_ms: latencyMs,
      };

      // Validate against canonical contract
      validateProviderSynthesisResult(result);

      return result;
    } catch (err) {
      if (signal?.aborted || controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new VoiceProviderError({
          code: "CANCELLED",
          message: "Azure Speech synthesis cancelled",
          provider_identity: identity,
          cause: err,
        });
      }

      if (err instanceof VoiceProviderError) {
        throw err;
      }

      const rawMsg = err instanceof Error ? err.message : String(err);
      const safeMsg = this.redactor.redact(rawMsg);

      throw new VoiceProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message: `Azure Speech network error: ${safeMsg}`,
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
   * Constructs valid SSML payload for Azure Speech.
   */
  private buildSsml(request: SynthesisRequest): string {
    const voiceId = request.voice_profile.provider_voice_id;
    const locale = request.locale;
    const escapedText = escapeXml(request.normalized_text);
    const rate = request.voice_profile.rate;
    const pitch = request.voice_profile.pitch;

    let prosodyAttrs = "";
    if (rate !== 1.0) {
      const pct = Math.round((rate - 1.0) * 100);
      prosodyAttrs += ` rate="${pct >= 0 ? `+${pct}%` : `${pct}%`}"`;
    }
    if (pitch !== 0) {
      const pct = Math.round(pitch * 100);
      prosodyAttrs += ` pitch="${pct >= 0 ? `+${pct}%` : `${pct}%`}"`;
    }

    if (prosodyAttrs.length > 0) {
      return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voiceId}"><prosody${prosodyAttrs}>${escapedText}</prosody></voice></speak>`;
    }

    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${locale}"><voice name="${voiceId}">${escapedText}</voice></speak>`;
  }

  /**
   * Maps HTTP error responses to canonical VoiceProviderError taxonomy.
   */
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
        message: `Azure Speech authentication failed (${status}): ${errorDetail}`,
        provider_identity: identity,
      });
    }

    if (status === 429) {
      let retryAfterMs = 2_000;
      const retryHeader = response.headers.get("retry-after");
      if (retryHeader) {
        const parsedSec = Number.parseInt(retryHeader, 10);
        if (!Number.isNaN(parsedSec)) {
          retryAfterMs = Math.min(30_000, Math.max(1_000, parsedSec * 1_000));
        }
      }
      throw new VoiceProviderError({
        code: "RATE_LIMITED",
        message: `Azure Speech rate limited (429): ${errorDetail}`,
        provider_identity: identity,
        retry_after_ms: retryAfterMs,
      });
    }

    if (status === 400) {
      throw new VoiceProviderError({
        code: "VALIDATION_FAILED",
        message: `Azure Speech invalid request (400): ${errorDetail}`,
        provider_identity: identity,
      });
    }

    if (status >= 500 && status <= 599) {
      throw new VoiceProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message: `Azure Speech service unavailable (${status}): ${errorDetail}`,
        provider_identity: identity,
      });
    }

    throw new VoiceProviderError({
      code: "SYNTHESIS_FAILED",
      message: `Azure Speech synthesis request failed with HTTP ${status}: ${errorDetail}`,
      provider_identity: identity,
    });
  }
}
