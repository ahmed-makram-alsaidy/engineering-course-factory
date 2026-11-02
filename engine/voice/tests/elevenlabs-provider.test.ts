// P10.8 ElevenLabs Voice Provider Offline Unit Tests
// Tests all request mapping, error handling, cancellation, bounds, and redaction with ZERO network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ElevenLabsVoiceProvider } from "../src/elevenlabs-provider.ts";
import { type SynthesisRequest, type VoiceProfile } from "../src/protocol.ts";
import { VoiceProviderError } from "../src/provider-interface.ts";
import { SecretRedactor } from "../src/redactor.ts";

function createMockProfile(overrides?: Partial<VoiceProfile>): VoiceProfile {
  return {
    profile_id: "test-eleven-profile-1",
    locale: "ar-EG",
    gender: "male",
    description: "Egyptian Arabic male instructor",
    provider_family: "elevenlabs",
    provider_voice_id: "mock-voice-id-123",
    provider_model: "eleven_multilingual_v2",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
    ...overrides,
  };
}

function createMockRequest(overrides?: Partial<SynthesisRequest>): SynthesisRequest {
  return {
    request_id: "req-eleven-test-001",
    cache_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    normalized_text: "أهلاً بيك في كورس Node.js.",
    locale: "ar-EG",
    voice_profile: createMockProfile(),
    request_alignment: true,
    ...overrides,
  };
}

describe("ElevenLabsVoiceProvider: Offline Unit Tests", () => {
  it("probes capabilities returning expected schema and defaults", async () => {
    const provider = new ElevenLabsVoiceProvider();
    const caps = await provider.probeCapabilities();

    assert.equal(caps.provider_family, "elevenlabs");
    assert.ok(caps.supported_locales.includes("ar-EG"));
    assert.equal(caps.alignment_support, "word");
    assert.equal(caps.supports_word_alignment, true);
    assert.equal(caps.supports_cancellation, true);
    assert.deepEqual(caps.sample_rates, [48000]);
    assert.deepEqual(caps.channels, [1]);
    assert.deepEqual(caps.output_formats, ["pcm_48000"]);
  });

  it("fails with AUTH_FAILED when API key is not configured", async () => {
    const provider = new ElevenLabsVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return null;
        },
        async hasSecret() {
          return false;
        },
      },
    });

    await assert.rejects(
      async () => provider.synthesize(createMockRequest()),
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "AUTH_FAILED");
        assert.equal(err.provider_identity.provider_family, "elevenlabs");
        return true;
      },
    );
  });

  it("synthesizes with timestamps extracting monotonic word marks and canonical WAV", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    // 48000 samples = 96000 bytes PCM
    const pcm = Buffer.alloc(96000);
    const audioBase64 = pcm.toString("base64");

    const mockResponsePayload = {
      audio_base64: audioBase64,
      alignment: {
        characters: ["H", "i", " ", "A", "l", "l"],
        character_start_times_seconds: [0.0, 0.1, 0.2, 0.25, 0.3, 0.35],
        character_end_times_seconds: [0.1, 0.2, 0.25, 0.3, 0.35, 0.45],
      },
    };

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = String(init?.body ?? "");

      return new Response(JSON.stringify(mockResponsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new ElevenLabsVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-xi-key-abc";
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
    });

    const req = createMockRequest();
    const result = await provider.synthesize(req);

    assert.ok(capturedUrl.includes("with-timestamps"));
    assert.equal(capturedHeaders["xi-api-key"], "test-xi-key-abc");
    assert.match(capturedBody, /"model_id":"eleven_multilingual_v2"/);

    assert.equal(result.sample_rate_hz, 48000);
    assert.equal(result.channels, 1);
    assert.equal(result.sample_count, 48000);
    assert.equal(result.alignment_status, "word");
    assert.equal(result.alignment.words.length, 2);
    assert.equal(result.alignment.words[0].word, "Hi");
    assert.equal(result.alignment.words[1].word, "All");
    assert.ok(result.alignment.words[0].start_sample <= result.alignment.words[0].end_sample);
    assert.ok(result.alignment.words[0].end_sample <= result.alignment.words[1].start_sample);
  });

  it("maps 401 error to AUTH_FAILED", async () => {
    const mockFetch = (async () => {
      return new Response("Invalid API Key", { status: 401 });
    }) as unknown as typeof fetch;

    const provider = new ElevenLabsVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-xi-key";
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
        return true;
      },
    );
  });

  it("maps 429 error to RATE_LIMITED", async () => {
    const mockFetch = (async () => {
      return new Response("Quota exceeded", { status: 429 });
    }) as unknown as typeof fetch;

    const provider = new ElevenLabsVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-xi-key";
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
        assert.equal(err.code, "RATE_LIMITED");
        return true;
      },
    );
  });

  it("maps 500 error to PROVIDER_UNAVAILABLE", async () => {
    const mockFetch = (async () => {
      return new Response("Internal server error", { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new ElevenLabsVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-xi-key";
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
        assert.equal(err.code, "PROVIDER_UNAVAILABLE");
        return true;
      },
    );
  });

  it("handles AbortSignal pre-aborted cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new ElevenLabsVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-xi-key";
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

    const provider = new ElevenLabsVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return "test-xi-key";
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
    });

    const req = createMockRequest({ request_id: "req-eleven-cancel-01" });
    const synthPromise = provider.synthesize(req);

    await provider.cancel("req-eleven-cancel-01");

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

  it("redacts secret keys from error messages", async () => {
    const secretKey = "elevenlabs-super-secret-token-321";
    const redactor = new SecretRedactor();

    const mockFetch = (async () => {
      return new Response(`Bad request token: ${secretKey}`, { status: 400 });
    }) as unknown as typeof fetch;

    const provider = new ElevenLabsVoiceProvider({
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
});
