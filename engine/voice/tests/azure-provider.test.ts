// P10.8 Azure Voice Provider Offline Unit Tests
// Tests all request mapping, error handling, cancellation, bounds, and redaction with ZERO network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AzureVoiceProvider } from "../src/azure-provider.ts";
import { type SynthesisRequest, type VoiceProfile } from "../src/protocol.ts";
import { VoiceProviderError } from "../src/provider-interface.ts";
import { buildWavHeader } from "../src/wav.ts";
import { SecretRedactor } from "../src/redactor.ts";

function createMockProfile(overrides?: Partial<VoiceProfile>): VoiceProfile {
  return {
    profile_id: "test-profile-1",
    locale: "ar-EG",
    gender: "male",
    description: "Egyptian Arabic male instructor",
    provider_family: "azure",
    provider_voice_id: "ar-EG-ShakirNeural",
    provider_model: "neural",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
    ...overrides,
  };
}

function createMockRequest(overrides?: Partial<SynthesisRequest>): SynthesisRequest {
  return {
    request_id: "req-azure-test-001",
    cache_key: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    normalized_text: "أهلاً بيك في كورس Node.js & TypeScript.",
    locale: "ar-EG",
    voice_profile: createMockProfile(),
    request_alignment: false,
    ...overrides,
  };
}

function createMockWavBuffer(sampleCount: number): Buffer {
  const header = buildWavHeader(sampleCount);
  const pcm = Buffer.alloc(sampleCount * 2);
  return Buffer.concat([header, pcm]);
}

describe("AzureVoiceProvider: Offline Unit Tests", () => {
  it("probes capabilities returning expected schema and defaults", async () => {
    const provider = new AzureVoiceProvider();
    const caps = await provider.probeCapabilities();

    assert.equal(caps.provider_family, "azure");
    assert.ok(caps.supported_locales.includes("ar-EG"));
    assert.ok(caps.supported_locales.includes("en-US"));
    assert.equal(caps.alignment_support, "none");
    assert.equal(caps.supports_cancellation, true);
    assert.deepEqual(caps.sample_rates, [48000]);
    assert.deepEqual(caps.channels, [1]);
    assert.deepEqual(caps.output_formats, ["riff-48khz-16bit-mono-pcm"]);
  });

  it("fails with AUTH_FAILED when API key is not configured", async () => {
    const provider = new AzureVoiceProvider({
      secretResolver: {
        async resolveSecret() {
          return null;
        },
        async hasSecret() {
          return false;
        },
      },
    });

    const req = createMockRequest();
    await assert.rejects(
      async () => provider.synthesize(req),
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "AUTH_FAILED");
        assert.equal(err.provider_identity.provider_family, "azure");
        return true;
      },
    );
  });

  it("fails with CONFIG_INVALID when region is not configured", async () => {
    const provider = new AzureVoiceProvider({
      secretResolver: {
        async resolveSecret(q) {
          if (q.secret_key === "api_key") return "mock-secret-key-1234567890";
          return null;
        },
        async hasSecret(q) {
          return q.secret_key === "api_key";
        },
      },
    });

    const req = createMockRequest();
    await assert.rejects(
      async () => provider.synthesize(req),
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /region/i);
        return true;
      },
    );
  });

  it("successfully synthesizes and maps headers, SSML, and audio", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const mockWav = createMockWavBuffer(48000); // 1 second

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = String(init?.body ?? "");

      return new Response(new Uint8Array(mockWav), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      });
    }) as unknown as typeof fetch;

    const provider = new AzureVoiceProvider({
      secretResolver: {
        async resolveSecret(q) {
          if (q.secret_key === "api_key") return "test-azure-key-secret-999";
          if (q.secret_key === "region") return "eastus";
          return null;
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
    });

    const req = createMockRequest();
    const result = await provider.synthesize(req);

    assert.equal(capturedUrl, "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    assert.equal(capturedHeaders["Ocp-Apim-Subscription-Key"], "test-azure-key-secret-999");
    assert.equal(capturedHeaders["Content-Type"], "application/ssml+xml");
    assert.equal(capturedHeaders["X-Microsoft-OutputFormat"], "riff-48khz-16bit-mono-pcm");

    // SSML validation (escapes & to &amp;)
    assert.match(capturedBody, /<speak/);
    assert.match(capturedBody, /xml:lang="ar-EG"/);
    assert.match(capturedBody, /<voice name="ar-EG-ShakirNeural">/);
    assert.match(capturedBody, /Node\.js &amp; TypeScript\./);

    // Audio validation
    assert.equal(result.sample_rate_hz, 48000);
    assert.equal(result.channels, 1);
    assert.equal(result.sample_count, 48000);
    assert.equal(result.duration_us, 1_000_000);
    assert.equal(result.alignment_status, "none");
    assert.equal(result.format, "wav");
    assert.equal(result.audio_bytes.length, mockWav.length);
  });

  it("maps 401 error to AUTH_FAILED", async () => {
    const mockFetch = (async () => {
      return new Response("Unauthorized access", { status: 401 });
    }) as unknown as typeof fetch;

    const provider = new AzureVoiceProvider({
      defaultRegion: "eastus",
      secretResolver: {
        async resolveSecret() {
          return "test-key-abc";
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

  it("maps 429 error to RATE_LIMITED and honors Retry-After header", async () => {
    const mockFetch = (async () => {
      return new Response("Too many requests", {
        status: 429,
        headers: { "Retry-After": "5" },
      });
    }) as unknown as typeof fetch;

    const provider = new AzureVoiceProvider({
      defaultRegion: "eastus",
      secretResolver: {
        async resolveSecret() {
          return "test-key-abc";
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
        assert.equal(err.retry_after_ms, 5_000);
        return true;
      },
    );
  });

  it("maps 503 error to PROVIDER_UNAVAILABLE", async () => {
    const mockFetch = (async () => {
      return new Response("Service temporarily overloaded", { status: 503 });
    }) as unknown as typeof fetch;

    const provider = new AzureVoiceProvider({
      defaultRegion: "eastus",
      secretResolver: {
        async resolveSecret() {
          return "test-key-abc";
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

    const provider = new AzureVoiceProvider({
      defaultRegion: "eastus",
      secretResolver: {
        async resolveSecret() {
          return "test-key-abc";
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

    const provider = new AzureVoiceProvider({
      defaultRegion: "eastus",
      secretResolver: {
        async resolveSecret() {
          return "test-key-abc";
        },
        async hasSecret() {
          return true;
        },
      },
      fetchFn: mockFetch,
    });

    const req = createMockRequest({ request_id: "req-to-cancel-01" });
    const synthPromise = provider.synthesize(req);

    // Call cancel while in-flight
    await provider.cancel("req-to-cancel-01");

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
    const secretKey = "super-secret-azure-api-key-987654";
    const redactor = new SecretRedactor();

    const mockFetch = (async () => {
      // Simulate error response echoing the secret
      return new Response(`Error with key: ${secretKey}`, { status: 400 });
    }) as unknown as typeof fetch;

    const provider = new AzureVoiceProvider({
      defaultRegion: "eastus",
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
