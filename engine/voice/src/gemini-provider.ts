// P10.8 Google Gemini TTS REST Voice Provider (GeminiVoiceProvider)
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8, 30 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Production-capable Google Gemini TTS REST Provider:
// - Implements vendor-neutral VoiceProvider interface.
// - Supports primary candidate model gemini-3.1-flash-tts-preview with fallback to gemini-2.5-flash-tts / gemini-2.5-pro-tts.
// - Supports prebuilt voices suitable for technical instruction (Charon, Puck).
// - Zero third-party SDK dependencies (uses native Node.js fetch with AbortSignal).
// - Credential safety: API key passed safely via x-goog-api-key header (never in URL query string).
// - Secret resolution via VoiceSecretResolver / VoiceCredentialStore boundary with safe redactor registration.
// - Zero secret leakage on error messages and logs.
// - Strict response byte bound enforcement (MAX_PROVIDER_RESPONSE_BYTES = 32 MiB).
// - Full cancellation support (AbortSignal and cancel(requestId)).
// - Standard error mapping into canonical VoiceFailureCode taxonomy.

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
import { buildWavHeader, parseWavHeader } from "./wav.ts";
import { type VoiceSecretResolver } from "./credential-types.ts";
import { defaultSecretRedactor, SecretRedactor } from "./redactor.ts";
import { buildDeliveryPromptText } from "./delivery-profile.ts";

export const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview" as const;
export const FALLBACK_GEMINI_TTS_MODELS = [
  "gemini-2.5-flash-tts",
  "gemini-2.5-pro-tts",
] as const;

export const DEFAULT_GEMINI_VOICE_1 = "Charon" as const;
export const DEFAULT_GEMINI_VOICE_2 = "Puck" as const;

export interface GeminiVoiceProviderOptions {
  /** Optional secret resolver (e.g. VoiceCredentialStore). Defaults to environment resolver. */
  readonly secretResolver?: VoiceSecretResolver;
  /** Injectable fetch function for deterministic offline testing. Defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
  /** User-Agent header value. */
  readonly userAgent?: string;
  /** Optional secret redactor. Defaults to defaultSecretRedactor. */
  readonly redactor?: SecretRedactor;
  /** Default Gemini TTS model. Defaults to gemini-3.1-flash-tts-preview. */
  readonly defaultModel?: string;
  /** Default Gemini prebuilt voice. Defaults to Charon. */
  readonly defaultVoice?: string;
  /** Default delivery profile ID if not specified in VoiceProfile. */
  readonly defaultDeliveryProfileId?: string;
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

/**
 * Returns true if the credential string is null, empty, or an obvious placeholder value.
 * Rejects patterns such as PUT_YOUR_KEY_HERE, <your-gemini-api-key>, etc.
 */
export function isPlaceholderCredential(val: string | null | undefined): boolean {
  if (!val || typeof val !== "string") return true;
  const trimmed = val.trim();
  if (trimmed.length === 0) return true;
  if (/^<.*>$/.test(trimmed)) return true;
  if (/put_your_key_here/i.test(trimmed)) return true;
  if (/your[_-]?gemini[_-]?api[_-]?key/i.test(trimmed)) return true;
  if (/your[_-]?api[_-]?key/i.test(trimmed)) return true;
  if (/your[_-]?key[_-]?here/i.test(trimmed)) return true;
  if (/insert[_-]?key/i.test(trimmed)) return true;
  if (/placeholder/i.test(trimmed)) return true;
  if (/changeme/i.test(trimmed)) return true;
  if (/todo/i.test(trimmed)) return true;
  return false;
}

/**
 * Builds a standard 44-byte RIFF header for linear PCM 16-bit mono at an arbitrary sample rate.
 */
export function buildPcmWavHeader(
  sampleCount: number,
  sampleRate: number = 24000,
  channels: number = 1,
  bitsPerSample: number = 16,
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataLength = sampleCount * blockAlign;
  const chunkSize = 36 + dataLength;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(chunkSize, 4);
  header.write("WAVE", 8, 4, "ascii");
  header.write("fmt ", 12, 4, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM = 1
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, 4, "ascii");
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/**
 * Performs 2:1 linear upsampling from 24 kHz to 48 kHz for mono 16-bit PCM.
 */
export function upsample24kTo48kMono(pcm24k: Buffer): Buffer {
  const inSampleCount = Math.floor(pcm24k.length / 2);
  if (inSampleCount === 0) return Buffer.alloc(0);
  const outSampleCount = inSampleCount * 2;
  const outBuffer = Buffer.alloc(outSampleCount * 2);

  for (let i = 0; i < inSampleCount; i++) {
    const s0 = pcm24k.readInt16LE(i * 2);
    const s1 = i + 1 < inSampleCount ? pcm24k.readInt16LE((i + 1) * 2) : s0;
    const mid = Math.round((s0 + s1) / 2);

    outBuffer.writeInt16LE(s0, i * 4);
    outBuffer.writeInt16LE(mid, i * 4 + 2);
  }

  return outBuffer;
}

export interface GeminiRawSynthesisOptions {
  readonly model?: string;
  readonly voice?: string;
  readonly promptText: string;
  readonly signal?: AbortSignal;
}

export interface GeminiRawSynthesisResult {
  readonly rawPcm: Buffer;
  readonly sourceSampleRate: number;
  readonly wavBuffer: Buffer;
  readonly model: string;
  readonly voice: string;
  readonly mimeType: string;
}

export class GeminiVoiceProvider implements VoiceProvider {
  readonly family: string = "gemini";

  private readonly secretResolver: VoiceSecretResolver;
  private readonly fetchFn: typeof fetch;
  private readonly userAgent: string;
  private readonly redactor: SecretRedactor;
  private readonly defaultModel: string;
  private readonly defaultVoice: string;
  private readonly defaultDeliveryProfileId?: string;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(options?: GeminiVoiceProviderOptions) {
    this.secretResolver = options?.secretResolver ?? defaultEnvResolver();
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.userAgent = options?.userAgent ?? "CourseFactoryVoice/1.0 (Gemini)";
    this.redactor = options?.redactor ?? defaultSecretRedactor;
    this.defaultModel = options?.defaultModel ?? DEFAULT_GEMINI_TTS_MODEL;
    this.defaultVoice = options?.defaultVoice ?? DEFAULT_GEMINI_VOICE_1;
    this.defaultDeliveryProfileId = options?.defaultDeliveryProfileId;
  }

  /**
   * Probes Gemini TTS provider capabilities.
   */
  async probeCapabilities(): Promise<ProviderCapabilities> {
    return {
      provider_family: "gemini",
      supported_locales: [...SUPPORTED_LOCALES],
      alignment_support: "none",
      supports_word_alignment: false,
      supports_phoneme_alignment: false,
      supports_cancellation: true,
      supports_idempotency_key: false,
      max_characters_per_request: 10_000,
      sample_rates: [24000, AUDIO_SAMPLE_RATE_HZ],
      channels: [AUDIO_CHANNELS],
      output_formats: ["audio/pcm", "audio/wav"],
      supports_rate_control: false,
      supports_pitch_control: false,
      supports_style_control: true,
    };
  }

  /**
   * Synthesizes audio using Google Gemini Text-to-Speech REST API.
   * Conforms to the provider-neutral VoiceProvider contract.
   */
  async synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<ProviderSynthesisResult> {
    const parsedRequest = SynthesisRequestSchema.parse(request);
    const model = parsedRequest.voice_profile.provider_model || this.defaultModel;
    const voiceId = parsedRequest.voice_profile.provider_voice_id || this.defaultVoice;

    const identity: ProviderIdentity = {
      provider_family: "gemini",
      provider_model: model,
      provider_voice_id: voiceId,
    };

    // 1. Setup cancellation tracking
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
          message: "Gemini TTS synthesis cancelled prior to dispatch",
          provider_identity: identity,
        });
      }

      // 3. Resolve credentials safely
      const apiKey = await this.resolveApiKey();
      if (!apiKey) {
        throw new VoiceProviderError({
          code: "AUTH_FAILED",
          message: "Gemini API key is not configured in VoiceCredentialStore",
          provider_identity: identity,
        });
      }

      this.redactor.registerSecret(apiKey);

      // 4. Construct prompt text
      const promptText = this.buildPromptText(parsedRequest);

      // 5. Dispatch raw synthesis request
      const rawResult = await this.executeSynthesisRequest({
        model,
        voice: voiceId,
        promptText,
        apiKey,
        signal: controller.signal,
        identity,
      });

      // 6. Convert to canonical 48 kHz linear PCM WAV for VoiceProvider result
      let pcm48k: Buffer;
      if (rawResult.sourceSampleRate === AUDIO_SAMPLE_RATE_HZ) {
        pcm48k = rawResult.rawPcm;
      } else if (rawResult.sourceSampleRate === 24000) {
        pcm48k = upsample24kTo48kMono(rawResult.rawPcm);
      } else {
        pcm48k = upsample24kTo48kMono(rawResult.rawPcm);
      }

      const sampleCount = Math.floor(pcm48k.length / 2);
      const wavHeader = buildWavHeader(sampleCount);
      const audioBytes = Buffer.concat([wavHeader, pcm48k]);

      if (audioBytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new VoiceProviderError({
          code: "SYNTHESIS_FAILED",
          message: `Gemini response size ${audioBytes.length} exceeds maximum allowed limit ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
          provider_identity: identity,
        });
      }

      const durationUs = durationUsForSampleCount(sampleCount);

      const descriptor: SynthesisResultDescriptor = {
        provider_family: "gemini",
        provider_model: model,
        provider_voice_id: voiceId,
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
        provider_family: "gemini",
        provider_model: model,
        provider_voice_id: voiceId,
        provider_request_id: parsedRequest.request_id,
        format: AUDIO_CONTAINER,
        sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
        channels: AUDIO_CHANNELS,
        sample_count: sampleCount,
        duration_us: durationUs,
        alignment_status: "none",
        characters_billed: parsedRequest.normalized_text.length,
      };

      validateProviderSynthesisResult(result);
      return result;
    } catch (err) {
      if (signal?.aborted || controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw new VoiceProviderError({
          code: "CANCELLED",
          message: "Gemini TTS synthesis cancelled",
          provider_identity: identity,
          cause: err,
        });
      }
      if (err instanceof VoiceProviderError) {
        throw err;
      }
      throw new VoiceProviderError({
        code: "SYNTHESIS_FAILED",
        message: `Gemini TTS synthesis failed: ${this.redactor.redact(err instanceof Error ? err.message : String(err))}`,
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
   * Idempotent: safe if request is unknown or finished.
   */
  async cancel(requestId: string): Promise<void> {
    const controller = this.activeControllers.get(requestId);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(requestId);
    }
  }

  /**
   * Executes raw synthesis returning unmodified PCM bytes and source sample rate.
   * Used by the P10.8 audition runner for canonical P10.4 normalization.
   */
  async synthesizeRaw(options: GeminiRawSynthesisOptions): Promise<GeminiRawSynthesisResult> {
    const model = options.model ?? this.defaultModel;
    const voice = options.voice ?? this.defaultVoice;
    const identity: ProviderIdentity = {
      provider_family: "gemini",
      provider_model: model,
      provider_voice_id: voice,
    };

    if (options.signal?.aborted) {
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: "Gemini raw synthesis cancelled prior to dispatch",
        provider_identity: identity,
      });
    }

    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      throw new VoiceProviderError({
        code: "AUTH_FAILED",
        message: "Gemini API key is not configured in VoiceCredentialStore",
        provider_identity: identity,
      });
    }

    this.redactor.registerSecret(apiKey);

    return this.executeSynthesisRequest({
      model,
      voice,
      promptText: options.promptText,
      apiKey,
      signal: options.signal,
      identity,
    });
  }

  private async resolveApiKey(): Promise<string | null> {
    const fromGemini = await this.secretResolver.resolveSecret({ provider_family: "gemini", secret_key: "api_key" });
    if (fromGemini && !isPlaceholderCredential(fromGemini)) return fromGemini.trim();

    const fromGoogle = await this.secretResolver.resolveSecret({ provider_family: "google", secret_key: "api_key" });
    if (fromGoogle && !isPlaceholderCredential(fromGoogle)) return fromGoogle.trim();

    const envCandidates = [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "COURSE_FACTORY_TTS_GEMINI_API_KEY",
      "COURSE_FACTORY_TTS_GOOGLE_API_KEY",
    ];

    for (const envVar of envCandidates) {
      const val = process.env[envVar];
      if (val && !isPlaceholderCredential(val)) return val.trim();
    }

    return null;
  }

  private buildPromptText(request: SynthesisRequest): string {
    const deliveryProfileId =
      request.voice_profile.delivery_profile_id ?? this.defaultDeliveryProfileId;
    if (deliveryProfileId) {
      return buildDeliveryPromptText(deliveryProfileId, request.normalized_text);
    }
    return request.normalized_text;
  }

  private async executeSynthesisRequest({
    model,
    voice,
    promptText,
    apiKey,
    signal,
    identity,
  }: {
    model: string;
    voice: string;
    promptText: string;
    apiKey: string;
    signal?: AbortSignal;
    identity: ProviderIdentity;
  }): Promise<GeminiRawSynthesisResult> {
    // API key passed safely via x-goog-api-key header (never in URL query string)
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: promptText,
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      },
    };

    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (fetchErr) {
      if (signal?.aborted || (fetchErr instanceof Error && fetchErr.name === "AbortError")) {
        throw new VoiceProviderError({
          code: "CANCELLED",
          message: "Gemini synthesis request aborted",
          provider_identity: identity,
          cause: fetchErr,
        });
      }
      if (fetchErr instanceof Error && fetchErr.name === "TimeoutError") {
        throw new VoiceProviderError({
          code: "TIMEOUT",
          message: "Gemini synthesis request timed out",
          provider_identity: identity,
          cause: fetchErr,
        });
      }
      throw new VoiceProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message: `Gemini synthesis network connection failed: ${this.redactor.redact(fetchErr instanceof Error ? fetchErr.message : String(fetchErr))}`,
        provider_identity: identity,
        cause: fetchErr,
      });
    }

    if (!response.ok) {
      await this.handleErrorResponse(response, identity);
    }

    let jsonBody: unknown;
    try {
      jsonBody = await response.json();
    } catch (parseErr) {
      throw new VoiceProviderError({
        code: "SYNTHESIS_FAILED",
        message: "Failed to parse Gemini response as JSON",
        provider_identity: identity,
        cause: parseErr,
      });
    }

    const typedBody = jsonBody as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: string; data?: string };
            inline_data?: { mimeType?: string; data?: string };
          }>;
        };
      }>;
    };

    const inlineData =
      typedBody.candidates?.[0]?.content?.parts?.[0]?.inlineData ??
      typedBody.candidates?.[0]?.content?.parts?.[0]?.inline_data;

    if (!inlineData || typeof inlineData.data !== "string" || inlineData.data.length === 0) {
      throw new VoiceProviderError({
        code: "SYNTHESIS_FAILED",
        message: "Gemini response missing audio inlineData payload",
        provider_identity: identity,
      });
    }

    const rawBytes = Buffer.from(inlineData.data, "base64");
    if (rawBytes.length === 0) {
      throw new VoiceProviderError({
        code: "SYNTHESIS_FAILED",
        message: "Gemini returned empty audio payload (0 bytes)",
        provider_identity: identity,
      });
    }

    if (rawBytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new VoiceProviderError({
        code: "SYNTHESIS_FAILED",
        message: `Gemini response size ${rawBytes.length} exceeds maximum allowed limit ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
        provider_identity: identity,
      });
    }

    const mimeType = inlineData.mimeType ?? "audio/pcm;rate=24000";
    let sourceSampleRate = 24000;
    const rateMatch = mimeType.match(/rate=(\d+)/i);
    if (rateMatch) {
      sourceSampleRate = parseInt(rateMatch[1], 10);
    }

    let rawPcm: Buffer;
    let wavBuffer: Buffer;

    if (rawBytes.subarray(0, 4).toString("ascii") === "RIFF") {
      const info = parseWavHeader(rawBytes);
      sourceSampleRate = info.sampleRate;
      rawPcm = rawBytes.subarray(info.dataOffset, info.dataOffset + info.dataLength);
      wavBuffer = rawBytes;
    } else {
      rawPcm = rawBytes;
      const sampleCount = Math.floor(rawPcm.length / 2);
      const header = buildPcmWavHeader(sampleCount, sourceSampleRate, 1, 16);
      wavBuffer = Buffer.concat([header, rawPcm]);
    }

    return {
      rawPcm,
      sourceSampleRate,
      wavBuffer,
      model,
      voice,
      mimeType,
    };
  }

  private async handleErrorResponse(response: Response, identity: ProviderIdentity): Promise<never> {
    let errorText = "";
    try {
      errorText = await response.text();
    } catch {
      errorText = `HTTP ${response.status} ${response.statusText}`;
    }

    const redactedError = this.redactor.redact(errorText);

    let retryAfterMs: number | undefined;
    const retryHeader = response.headers.get("retry-after");
    if (retryHeader) {
      const seconds = parseFloat(retryHeader);
      if (!Number.isNaN(seconds) && seconds > 0) {
        retryAfterMs = Math.round(seconds * 1000);
      }
    }

    if (response.status === 400) {
      if (/API_KEY_INVALID|api_key_invalid|api\s*key\s*(?:not\s*valid|invalid)/i.test(redactedError)) {
        throw new VoiceProviderError({
          code: "AUTH_FAILED",
          message: `Gemini authentication failed (API_KEY_INVALID): ${redactedError}`,
          provider_identity: identity,
        });
      }
      throw new VoiceProviderError({
        code: "VALIDATION_FAILED",
        message: `Gemini validation failed: ${redactedError}`,
        provider_identity: identity,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new VoiceProviderError({
        code: "AUTH_FAILED",
        message: `Gemini authentication failed: ${redactedError}`,
        provider_identity: identity,
      });
    }

    if (response.status === 404) {
      throw new VoiceProviderError({
        code: "UNSUPPORTED_VOICE",
        message: `Gemini model or voice not found: ${redactedError}`,
        provider_identity: identity,
      });
    }

    if (response.status === 429) {
      throw new VoiceProviderError({
        code: "RATE_LIMITED",
        message: `Gemini rate limit exceeded: ${redactedError}`,
        provider_identity: identity,
        retry_after_ms: retryAfterMs,
      });
    }

    if (response.status >= 500) {
      throw new VoiceProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message: `Gemini service unavailable (HTTP ${response.status}): ${redactedError}`,
        provider_identity: identity,
      });
    }

    throw new VoiceProviderError({
      code: "SYNTHESIS_FAILED",
      message: `Gemini synthesis request failed with HTTP ${response.status}: ${redactedError}`,
      provider_identity: identity,
    });
  }
}
