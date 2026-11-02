// P10.8 Gemini Production Adoption Integration Tests
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8, 30 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Tests:
// 1. Immutable Egyptian Technical Instructor Delivery Profile (egyptian-technical-instructor-v1).
// 2. Production Voice Profiles (Primary: Charon, Secondary: Puck, Fallback: Azure Shakir).
// 3. Cache Identity v1.1 completeness, determinism, and strict credential exclusion.
// 4. GeminiVoiceProvider production adapter: prompt steering, cancellation, timeouts, safe failure mapping, bounds.
// 5. End-to-end cache-first synthesis with Gemini provider and delivery profile.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_PROFILE_ID,
  APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_VERSION,
  AZURE_FALLBACK_INSTRUCTOR_PROFILE,
  CacheIdentityPayloadSchema,
  CacheIdentityPayloadV1Schema,
  CacheIdentityPayloadV1_1Schema,
  DeliveryProfileSchema,
  EGYPTIAN_TECHNICAL_INSTRUCTOR_DELIVERY_PROFILE,
  EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_DIGEST,
  EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_PREFIX,
  GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
  GEMINI_SECONDARY_INSTRUCTOR_PROFILE,
  GeminiVoiceProvider,
  buildDeliveryPromptText,
  buildPcmWavHeader,
  createCacheIdentityPayload,
  deriveCacheKey,
  getRegisteredDeliveryProfileIds,
  resolveDeliveryProfile,
  resolveVoiceProvider,
  type SynthesisRequest,
  type VoiceProfile,
  VOICE_CONTRACT_VERSION,
  VOICE_CONTRACT_VERSION_1_1,
  VOICE_PROTOCOL_VERSION,
  VOICE_PROTOCOL_VERSION_1_1,
  VoiceProviderError,
} from "../src/index.ts";

describe("P10.8 Delivery Profile: egyptian-technical-instructor-v1", () => {
  it("conforms to DeliveryProfileSchema with frozen v1 values", () => {
    const profile = resolveDeliveryProfile(APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_PROFILE_ID);
    assert.equal(profile.delivery_profile_id, "egyptian-technical-instructor-v1");
    assert.equal(profile.version, "1.0");
    assert.equal(profile.prompt_digest, EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_DIGEST);
    assert.equal(profile.prompt_prefix, EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_PREFIX);

    const parsed = DeliveryProfileSchema.parse(profile);
    assert.equal(parsed.delivery_profile_id, "egyptian-technical-instructor-v1");
  });

  it("contains approved prompt semantics matching G4 audition run", () => {
    const prefix = EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_PREFIX;
    assert.ok(prefix.includes("Young Egyptian male technical instructor"));
    assert.ok(prefix.includes("Cairo colloquial Egyptian Arabic"));
    assert.ok(prefix.includes("Very relaxed, confident, conversational peer-mentor tone"));
    assert.ok(prefix.includes("Avoid any formal Modern Standard Arabic"));
    assert.ok(prefix.includes("seamless integration of English technical keywords"));
    assert.ok(prefix.includes("Zero theatricality, zero news-broadcaster cadence"));
    assert.ok(prefix.endsWith("Transcript:\n"));
  });

  it("lists approved profile in registered delivery profiles", () => {
    const ids = getRegisteredDeliveryProfileIds();
    assert.ok(ids.includes("egyptian-technical-instructor-v1"));
  });

  it("builds prompt text by concatenating prefix with transcript", () => {
    const transcript = "أهلاً بيك في كورس فاكتوري.";
    const fullPrompt = buildDeliveryPromptText("egyptian-technical-instructor-v1", transcript);
    assert.ok(fullPrompt.startsWith(EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_PREFIX));
    assert.ok(fullPrompt.endsWith(transcript));
  });

  it("fails closed on unknown delivery profile ID", () => {
    assert.throws(
      () => resolveDeliveryProfile("non-existent-profile"),
      /\[DELIVERY_PROFILE_UNKNOWN\]/,
    );
  });
});

describe("P10.8 Production Voice Profiles", () => {
  it("primary instructor profile binds Charon and approved delivery profile", () => {
    assert.equal(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.profile_id, "gemini-ar-eg-charon-instructor");
    assert.equal(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.provider_family, "gemini");
    assert.equal(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.provider_voice_id, "Charon");
    assert.equal(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.provider_model, "gemini-3.1-flash-tts-preview");
    assert.equal(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.locale, "ar-EG");
    assert.equal(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.gender, "male");
    assert.equal(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.delivery_profile_id, "egyptian-technical-instructor-v1");
    assert.equal(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.delivery_prompt_version, "1.0");
    assert.equal(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.delivery_prompt_digest, EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_DIGEST);
  });

  it("secondary instructor profile binds Puck with distinct profile identity", () => {
    assert.equal(GEMINI_SECONDARY_INSTRUCTOR_PROFILE.profile_id, "gemini-ar-eg-puck-instructor");
    assert.equal(GEMINI_SECONDARY_INSTRUCTOR_PROFILE.provider_family, "gemini");
    assert.equal(GEMINI_SECONDARY_INSTRUCTOR_PROFILE.provider_voice_id, "Puck");
    assert.equal(GEMINI_SECONDARY_INSTRUCTOR_PROFILE.provider_model, "gemini-3.1-flash-tts-preview");
    assert.equal(GEMINI_SECONDARY_INSTRUCTOR_PROFILE.delivery_profile_id, "egyptian-technical-instructor-v1");
    assert.notEqual(GEMINI_PRIMARY_INSTRUCTOR_PROFILE.profile_id, GEMINI_SECONDARY_INSTRUCTOR_PROFILE.profile_id);
  });

  it("retained Azure fallback profile is valid and has no delivery profile", () => {
    assert.equal(AZURE_FALLBACK_INSTRUCTOR_PROFILE.profile_id, "azure-ar-eg-shakir-instructor");
    assert.equal(AZURE_FALLBACK_INSTRUCTOR_PROFILE.provider_family, "azure");
    assert.equal(AZURE_FALLBACK_INSTRUCTOR_PROFILE.provider_voice_id, "ar-EG-ShakirNeural");
    assert.equal(AZURE_FALLBACK_INSTRUCTOR_PROFILE.delivery_profile_id, undefined);
  });
});

describe("P10.8 Cache Safety & Additive Versioning", () => {
  const text = "النهارده هنشتغل سوا على API بسيطة بـ Node.js.";

  it("proves same complete acoustic identity -> exact same cache key", () => {
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    assert.equal(key1, key2);
    assert.match(key1, /^[0-9a-f]{64}$/);
  });

  it("proves different voice produces different cache key", () => {
    const keyCharon = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const keyPuck = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_SECONDARY_INSTRUCTOR_PROFILE));
    assert.notEqual(keyCharon, keyPuck);
  });

  it("proves different model produces different cache key", () => {
    const profileFallback: VoiceProfile = {
      ...GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      provider_model: "gemini-2.5-flash-tts",
    };
    const key31 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key25 = deriveCacheKey(createCacheIdentityPayload(text, profileFallback));
    assert.notEqual(key31, key25);
  });

  it("proves different text produces different cache key", () => {
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload("نص آخر مختلف للدرس", GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    assert.notEqual(key1, key2);
  });

  it("proves different delivery profile produces different cache key", () => {
    const profileAlt: VoiceProfile = {
      ...GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      delivery_profile_id: "alt-style-v1",
      delivery_prompt_version: "1.0",
      delivery_prompt_digest: "1111111111111111111111111111111111111111111111111111111111111111",
    };
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload(text, profileAlt));
    assert.notEqual(key1, key2);
  });

  it("proves different delivery prompt version produces different cache key", () => {
    const profileAltVersion: VoiceProfile = {
      ...GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      delivery_prompt_version: "1.1",
    };
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload(text, profileAltVersion));
    assert.notEqual(key1, key2);
  });

  it("proves different delivery prompt digest produces different cache key", () => {
    const profileAltDigest: VoiceProfile = {
      ...GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      delivery_prompt_digest: "2222222222222222222222222222222222222222222222222222222222222222",
    };
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload(text, profileAltDigest));
    assert.notEqual(key1, key2);
  });

  it("proves legacy v1 cache key is 100% preserved (backward compatibility)", () => {
    const legacyPayload = createCacheIdentityPayload(text, AZURE_FALLBACK_INSTRUCTOR_PROFILE);
    assert.equal(legacyPayload.voice_contract_version, "1.0");
    assert.equal("delivery_profile_id" in legacyPayload, false);

    const legacyKey = deriveCacheKey(legacyPayload);
    assert.match(legacyKey, /^[0-9a-f]{64}$/);
  });

  it("strictly rejects credential fields in both v1.0 and v1.1 payload schemas", () => {
    const payload = createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE);
    const hostile = [
      { ...payload, api_key: "ai-secret" },
      { ...payload, token: "bearer-token" },
      { ...payload, authorization: "Bearer xyz" },
      { ...payload, secret: "password" },
      { ...payload, local_path: "C:\\Users\\admin" },
      { ...payload, take_id: "take-001" },
    ];

    for (const h of hostile) {
      assert.throws(() => CacheIdentityPayloadSchema.parse(h));
      assert.throws(() => CacheIdentityPayloadV1_1Schema.parse(h));
    }
  });
});

describe("P10.8 Gemini Production Provider Adapter", () => {
  it("resolves from trusted provider registry by default", () => {
    const provider = resolveVoiceProvider("gemini");
    assert.ok(provider instanceof GeminiVoiceProvider);
    assert.equal(provider.family, "gemini");
  });

  it("dispatches request with approved delivery prompt to Gemini REST endpoint", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    // Create 1 second 24 kHz synthetic PCM
    const sampleCount = 24000;
    const pcmData = Buffer.alloc(sampleCount * 2);
    const base64Audio = pcmData.toString("base64");

    const mockFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = JSON.parse(String(init?.body || "{}"));

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/pcm;rate=24000",
                      data: base64Audio,
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const provider = new GeminiVoiceProvider({
      fetchFn: mockFetch as any,
      secretResolver: {
        resolveSecret: async () => "test-gemini-key",
        hasSecret: async () => true,
      },
    });

    const request: SynthesisRequest = {
      request_id: "req-p108-test-01",
      cache_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      normalized_text: "أهلاً بيك في كورس فاكتوري.",
      locale: "ar-EG",
      voice_profile: GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      request_alignment: false,
    };

    const result = await provider.synthesize(request);

    // Verify endpoint
    assert.ok(capturedUrl.includes("generativelanguage.googleapis.com"));
    assert.ok(capturedUrl.includes("gemini-3.1-flash-tts-preview:generateContent"));

    // Verify header (credential in header only, never in query string)
    assert.equal(capturedHeaders["x-goog-api-key"], "test-gemini-key");
    assert.equal(capturedUrl.includes("test-gemini-key"), false);

    // Verify prompt text includes approved Egyptian instructor direction
    const sentText = capturedBody?.contents?.[0]?.parts?.[0]?.text;
    assert.ok(sentText.includes("Audio Profile: Young Egyptian male technical instructor"));
    assert.ok(sentText.includes("Transcript:\nأهلاً بيك في كورس فاكتوري."));

    // Verify voiceName
    assert.equal(
      capturedBody?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName,
      "Charon",
    );

    // Verify canonical 48 kHz upsampling
    assert.equal(result.sample_rate_hz, 48000);
    assert.equal(result.channels, 1);
    assert.equal(result.format, "wav");
    assert.equal(result.sample_count, sampleCount * 2); // 24k -> 48k (48,000 samples = 1 sec)
  });

  it("handles cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new GeminiVoiceProvider({
      secretResolver: {
        resolveSecret: async () => "test-key",
        hasSecret: async () => true,
      },
    });

    const request: SynthesisRequest = {
      request_id: "req-p108-cancel-01",
      cache_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      normalized_text: "نص تجريبي.",
      locale: "ar-EG",
      voice_profile: GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      request_alignment: false,
    };

    await assert.rejects(
      async () => provider.synthesize(request, controller.signal),
      (err: VoiceProviderError) => {
        assert.equal(err.code, "CANCELLED");
        assert.equal(err.retry_classification, "TERMINAL");
        return true;
      },
    );
  });

  it("maps 401/403/API_KEY_INVALID to AUTH_FAILED and redacts secrets", async () => {
    const secretKey = "super-secret-api-key-9999";
    const mockFetch = async () =>
      new Response(
        JSON.stringify({ error: { message: `API_KEY_INVALID: ${secretKey} is not valid` } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );

    const provider = new GeminiVoiceProvider({
      fetchFn: mockFetch as any,
      secretResolver: {
        resolveSecret: async () => secretKey,
        hasSecret: async () => true,
      },
    });

    const request: SynthesisRequest = {
      request_id: "req-p108-auth-01",
      cache_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      normalized_text: "نص تجريبي.",
      locale: "ar-EG",
      voice_profile: GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      request_alignment: false,
    };

    await assert.rejects(
      async () => provider.synthesize(request),
      (err: VoiceProviderError) => {
        assert.equal(err.code, "AUTH_FAILED");
        assert.equal(err.retry_classification, "NON_RETRYABLE");
        assert.equal(err.message.includes(secretKey), false);
        return true;
      },
    );
  });

  it("maps 429 to RATE_LIMITED with Retry-After", async () => {
    const mockFetch = async () =>
      new Response("Rate limit exceeded", {
        status: 429,
        headers: { "Retry-After": "5" },
      });

    const provider = new GeminiVoiceProvider({
      fetchFn: mockFetch as any,
      secretResolver: {
        resolveSecret: async () => "test-key",
        hasSecret: async () => true,
      },
    });

    const request: SynthesisRequest = {
      request_id: "req-p108-rate-01",
      cache_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      normalized_text: "نص تجريبي.",
      locale: "ar-EG",
      voice_profile: GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      request_alignment: false,
    };

    await assert.rejects(
      async () => provider.synthesize(request),
      (err: VoiceProviderError) => {
        assert.equal(err.code, "RATE_LIMITED");
        assert.equal(err.retry_classification, "RETRYABLE");
        assert.equal(err.retry_after_ms, 5000);
        return true;
      },
    );
  });
});
