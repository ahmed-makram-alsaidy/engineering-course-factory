// P10.8 Google Gemini Voice Provider Offline Unit Tests
// Tests request construction, error mapping, cancellation, bounds, redaction,
// and normalization with ZERO live network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GeminiVoiceProvider,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_VOICE_1,
  DEFAULT_GEMINI_VOICE_2,
  buildPcmWavHeader,
  upsample24kTo48kMono,
  isPlaceholderCredential,
} from "../src/gemini-provider.ts";
import { type SynthesisRequest, type VoiceProfile } from "../src/protocol.ts";
import { VoiceProviderError, MAX_PROVIDER_RESPONSE_BYTES } from "../src/provider-interface.ts";
import { buildWavHeader, parseWavHeader } from "../src/wav.ts";
import { SecretRedactor } from "../src/redactor.ts";
import { VoiceAssetNormalizer } from "../host/audio-normalizer.ts";
import { validateVoiceAssetBytes } from "../host/asset-validator.ts";
// @ts-expect-error - audition runner is ESM .mjs outside the TypeScript root
import { deriveGeminiAuditionCacheKey, buildConversationalStylePrompt, buildStrongerEgyptianStylePrompt, SCRIPT_A, SCRIPT_B } from "../../../scripts/run-p10-8-gemini-audition.mjs";

function createMockProfile(overrides?: Partial<VoiceProfile>): VoiceProfile {
  return {
    profile_id: "test-profile-gemini-1",
    locale: "ar-EG",
    gender: "male",
    description: "Egyptian Arabic male instructor via Gemini",
    provider_family: "gemini",
    provider_voice_id: DEFAULT_GEMINI_VOICE_1,
    provider_model: DEFAULT_GEMINI_TTS_MODEL,
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
    ...overrides,
  };
}

function createMockRequest(overrides?: Partial<SynthesisRequest>): SynthesisRequest {
  return {
    request_id: "req-gemini-test-001",
    cache_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    normalized_text: "أهلًا بيك، النهارده هنشتغل سوا على API بسيطة بـ Node.js.",
    locale: "ar-EG",
    voice_profile: createMockProfile(),
    request_alignment: false,
    ...overrides,
  };
}

/**
 * Creates synthetic 24 kHz 16-bit linear PCM mono audio (e.g. 1 second = 24,000 samples = 48,000 bytes).
 */
function createMock24kPcmPayload(sampleCount: number = 24000): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  // Fill with a synthetic 440 Hz tone to ensure non-silent signal
  for (let i = 0; i < sampleCount; i++) {
    const val = Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
    buf.writeInt16LE(val, i * 2);
  }
  return buf;
}

function createMockGeminiJsonResponse(pcmBytes: Buffer, mimeType: string = "audio/pcm;rate=24000"): string {
  const base64Audio = pcmBytes.toString("base64");
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Audio,
              },
            },
          ],
        },
      },
    ],
  });
}

describe("GeminiVoiceProvider: Offline Unit Tests", () => {
  it("probes capabilities returning expected schema and defaults", async () => {
    const provider = new GeminiVoiceProvider();
    const caps = await provider.probeCapabilities();

    assert.equal(caps.provider_family, "gemini");
    assert.ok(caps.supported_locales.includes("ar-EG"));
    assert.ok(caps.supported_locales.includes("en-US"));
    assert.equal(caps.alignment_support, "none");
    assert.equal(caps.supports_cancellation, true);
    assert.deepEqual(caps.sample_rates, [24000, 48000]);
    assert.deepEqual(caps.channels, [1]);
    assert.ok(caps.output_formats.includes("audio/pcm"));
  });

  it("constructs valid REST request with x-goog-api-key header and no key in URL", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    const mockPcm = createMock24kPcmPayload(24000); // 1 sec at 24kHz
    const mockJson = createMockGeminiJsonResponse(mockPcm);

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body ?? "{}"));

      return new Response(mockJson, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const testApiKey = "test-gemini-api-key-998877";
    const provider = new GeminiVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return testApiKey;
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
    });

    const req = createMockRequest();
    const result = await provider.synthesize(req);

    // 1. URL verification: must target generativelanguage and model, NEVER include api key in query
    assert.ok(capturedUrl.includes("generativelanguage.googleapis.com"));
    assert.ok(capturedUrl.includes(DEFAULT_GEMINI_TTS_MODEL));
    assert.ok(!capturedUrl.includes(testApiKey), "API key must never appear in URL");

    // 2. Header verification: API key must be in x-goog-api-key header
    assert.equal(capturedHeaders["x-goog-api-key"], testApiKey);
    assert.equal(capturedHeaders["Content-Type"], "application/json");

    // 3. Body payload verification
    assert.equal(capturedBody.generationConfig?.responseModalities?.[0], "AUDIO");
    assert.equal(
      capturedBody.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName,
      DEFAULT_GEMINI_VOICE_1,
    );
    assert.equal(capturedBody.contents?.[0]?.parts?.[0]?.text, req.normalized_text);

    // 4. Synthesized result canonical checks (upsampled to 48kHz linear PCM)
    assert.equal(result.provider_family, "gemini");
    assert.equal(result.sample_rate_hz, 48000);
    assert.equal(result.channels, 1);
    assert.equal(result.sample_count, 48000);
    assert.equal(result.duration_us, 1_000_000);
    assert.equal(result.format, "wav");
  });

  it("rejects obvious placeholder credentials such as PUT_YOUR_KEY_HERE and <your-gemini-api-key>", () => {
    assert.equal(isPlaceholderCredential("PUT_YOUR_KEY_HERE"), true);
    assert.equal(isPlaceholderCredential("<your-gemini-api-key>"), true);
    assert.equal(isPlaceholderCredential("<insert-key>"), true);
    assert.equal(isPlaceholderCredential("your_api_key_here"), true);
    assert.equal(isPlaceholderCredential("TODO"), true);
    assert.equal(isPlaceholderCredential("CHANGEME"), true);
    assert.equal(isPlaceholderCredential(""), true);
    assert.equal(isPlaceholderCredential("   "), true);
    assert.equal(isPlaceholderCredential(null), true);
    assert.equal(isPlaceholderCredential(undefined), true);

    // Legitimate key pattern must be accepted
    assert.equal(isPlaceholderCredential("AIzaSyD-mockValidKey991827461"), false);
  });

  it("fails with AUTH_FAILED when API key is missing or is an obvious placeholder", async () => {
    const placeholderKeys = ["PUT_YOUR_KEY_HERE", "<your-gemini-api-key>"];

    for (const placeholder of placeholderKeys) {
      const provider = new GeminiVoiceProvider({
        secretResolver: {
          async resolveSecret() {
            return placeholder;
          },
          async hasSecret() {
            return true;
          },
        },
      });

      const req = createMockRequest();
      await assert.rejects(
        async () => provider.synthesize(req),
        (err: unknown) => {
          assert.ok(err instanceof VoiceProviderError);
          assert.equal(err.code, "AUTH_FAILED");
          assert.equal(err.provider_identity.provider_family, "gemini");
          return true;
        },
      );
    }
  });

  it("maps 400 with API_KEY_INVALID to AUTH_FAILED", async () => {
    const mockFetch = (async () => {
      const errorPayload = {
        error: {
          code: 400,
          message: "API key not valid. Please pass a valid API key.",
          status: "INVALID_ARGUMENT",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              "reason": "API_KEY_INVALID",
              "domain": "googleapis.com",
            },
          ],
        },
      };
      return new Response(JSON.stringify(errorPayload), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new GeminiVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-invalid-key";
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => provider.synthesize(createMockRequest()),
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "AUTH_FAILED");
        assert.match(err.message, /API_KEY_INVALID/i);
        return true;
      },
    );
  });

  it("preserves style prompt and authored text byte-for-byte in raw synthesis", async () => {
    let capturedPrompt = "";

    const mockPcm = createMock24kPcmPayload(12000); // 0.5s
    const mockJson = createMockGeminiJsonResponse(mockPcm);

    const mockFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      capturedPrompt = body.contents?.[0]?.parts?.[0]?.text;
      return new Response(mockJson, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const provider = new GeminiVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-api-key";
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
    });

    const testPrompt = buildConversationalStylePrompt(SCRIPT_A);
    const result = await provider.synthesizeRaw({
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_2,
      promptText: testPrompt,
    });

    assert.equal(capturedPrompt, testPrompt);
    assert.ok(capturedPrompt.includes(SCRIPT_A), "Prompt must include exact authored text byte-for-byte");
    assert.ok(capturedPrompt.includes("Young Egyptian male technical instructor"));
    assert.equal(result.sourceSampleRate, 24000);
    assert.equal(result.voice, DEFAULT_GEMINI_VOICE_2);
    assert.equal(result.rawPcm.length, mockPcm.length);
  });

  it("enforces MAX_PROVIDER_RESPONSE_BYTES limit", async () => {
    const oversizedPcm = Buffer.alloc(MAX_PROVIDER_RESPONSE_BYTES + 1024);
    const mockJson = createMockGeminiJsonResponse(oversizedPcm);

    const mockFetch = (async () => {
      return new Response(mockJson, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const provider = new GeminiVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-api-key";
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
    });

    await assert.rejects(
      async () => provider.synthesize(createMockRequest()),
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "SYNTHESIS_FAILED");
        assert.match(err.message, /exceeds maximum allowed limit/i);
        return true;
      },
    );
  });

  it("handles AbortSignal pre-aborted cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new GeminiVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-key";
        },
        async hasSecret() {
          return true;
        },
      },
    });

    await assert.rejects(
      async () => provider.synthesize(createMockRequest(), controller.signal),
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "CANCELLED");
        return true;
      },
    );
  });

  it("handles in-flight cancellation via provider.cancel(requestId)", async () => {
    let cancelCalled = false;
    const mockFetch = (async (_url: unknown, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          cancelCalled = true;
          const abortErr = new Error("The operation was aborted");
          abortErr.name = "AbortError";
          reject(abortErr);
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          cancelCalled = true;
          const abortErr = new Error("The operation was aborted");
          abortErr.name = "AbortError";
          reject(abortErr);
        });
      });
    }) as unknown as typeof fetch;

    const provider = new GeminiVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-key";
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
    });

    const req = createMockRequest({ request_id: "req-gemini-cancel-01" });
    const synthPromise = provider.synthesize(req);

    await provider.cancel("req-gemini-cancel-01");

    await assert.rejects(
      async () => synthPromise,
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "CANCELLED");
        return true;
      },
    );
    assert.equal(cancelCalled, true);
  });

  it("maps 401/403 to AUTH_FAILED, 429 to RATE_LIMITED, 503 to PROVIDER_UNAVAILABLE", async () => {
    const testCases: Array<{
      status: number;
      headers: Record<string, string>;
      expectedCode: string;
      expectedRetry?: number;
    }> = [
      { status: 401, headers: {}, expectedCode: "AUTH_FAILED" },
      { status: 403, headers: {}, expectedCode: "AUTH_FAILED" },
      { status: 404, headers: {}, expectedCode: "UNSUPPORTED_VOICE" },
      { status: 429, headers: { "retry-after": "7" }, expectedCode: "RATE_LIMITED", expectedRetry: 7000 },
      { status: 503, headers: {}, expectedCode: "PROVIDER_UNAVAILABLE" },
    ];

    for (const tc of testCases) {
      const mockFetch = (async () => {
        return new Response(JSON.stringify({ error: { message: `Simulated error ${tc.status}` } }), {
          status: tc.status,
          headers: tc.headers,
        });
      }) as unknown as typeof fetch;

      const provider = new GeminiVoiceProvider({
        secretResolver: {
          async resolveSecret() {
            return "test-key";
          },
          async hasSecret() {
            return true;
          },
        },
        fetchFn: mockFetch,
      });

      await assert.rejects(
        async () => provider.synthesize(createMockRequest()),
        (err: unknown) => {
          assert.ok(err instanceof VoiceProviderError);
          assert.equal(err.code, tc.expectedCode);
          if (tc.expectedRetry !== undefined) {
            assert.equal(err.retry_after_ms, tc.expectedRetry);
          }
          return true;
        },
      );
    }
  });

  it("redacts secret API key from error messages", async () => {
    const secretKey = "super-secret-gemini-api-key-xyz123";
    const redactor = new SecretRedactor();

    const mockFetch = (async () => {
      return new Response(`Error involving secret: ${secretKey}`, { status: 400 });
    }) as unknown as typeof fetch;

    const provider = new GeminiVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return secretKey;
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
      redactor,
    });

    await assert.rejects(
      async () => provider.synthesize(createMockRequest()),
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.ok(!err.message.includes(secretKey), "Error message must not contain secret key");
        return true;
      },
    );
  });

  it("distinct prompt => distinct audition identity", () => {
    const prompt1 = buildConversationalStylePrompt(SCRIPT_A);
    const prompt2 = buildStrongerEgyptianStylePrompt(SCRIPT_A);

    const id1 = deriveGeminiAuditionCacheKey({
      variant: "G1",
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_1,
      sourceText: SCRIPT_A,
      stylePrompt: prompt1,
    });

    const id2 = deriveGeminiAuditionCacheKey({
      variant: "G4",
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_1,
      sourceText: SCRIPT_A,
      stylePrompt: prompt2,
    });

    assert.notEqual(id1.key, id2.key, "Different prompts must produce distinct audition cache keys");
    assert.notEqual(id1.stylePromptSha256, id2.stylePromptSha256);
    assert.equal(id1.sourceTextSha256, id2.sourceTextSha256, "Identical source texts share source_text_sha256");
  });

  it("distinct voice/model => distinct audition identity", () => {
    const prompt = buildConversationalStylePrompt(SCRIPT_A);

    const idCharon = deriveGeminiAuditionCacheKey({
      variant: "G1",
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_1,
      sourceText: SCRIPT_A,
      stylePrompt: prompt,
    });

    const idPuck = deriveGeminiAuditionCacheKey({
      variant: "G2",
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_2,
      sourceText: SCRIPT_A,
      stylePrompt: prompt,
    });

    assert.notEqual(idCharon.key, idPuck.key, "Different voices must produce distinct audition cache keys");

    const idFallbackModel = deriveGeminiAuditionCacheKey({
      variant: "G1",
      model: "gemini-2.5-flash-tts",
      voice: DEFAULT_GEMINI_VOICE_1,
      sourceText: SCRIPT_A,
      stylePrompt: prompt,
    });

    assert.notEqual(idCharon.key, idFallbackModel.key, "Different models must produce distinct audition cache keys");
  });

  it("normalizes 24kHz provider output through P10.4 pipeline to valid canonical 48kHz WAV", async () => {
    // Generate 1.5 seconds of 24 kHz audio (36,000 samples)
    const pcm24k = createMock24kPcmPayload(36000);
    const header24k = buildPcmWavHeader(36000, 24000, 1, 16);
    const wav24k = Buffer.concat([header24k, pcm24k]);

    const normalizer = new VoiceAssetNormalizer();
    const result = await normalizer.normalize(wav24k);

    // Validate canonical properties
    assert.equal(result.canonical_wav.length > 44, true);
    const parsed = parseWavHeader(result.canonical_wav);
    assert.equal(parsed.sampleRate, 48000);
    assert.equal(parsed.channels, 1);
    assert.equal(parsed.bitsPerSample, 16);

    // 11-point asset validation
    const report = validateVoiceAssetBytes(result.canonical_wav);
    assert.ok(report);
    assert.equal(report.format, "wav");
    assert.equal(report.sample_rate_hz, 48000);
    assert.equal(report.channels, 1);
    assert.equal(report.bits_per_sample, 16);
  });
});
