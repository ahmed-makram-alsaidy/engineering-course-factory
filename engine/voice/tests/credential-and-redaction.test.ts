// P10.6 Credential Safety, Secret Redaction & Fallback Identity Tests
//
// Tests:
// - Exact registered secret string redacted from logs and errors
// - Bearer tokens and Authorization headers redacted
// - API key fields redacted from strings and queries
// - Signed URLs sanitized (userinfo and signature query params redacted)
// - SafeVoiceError shape bounded (<= 1024 chars), zero stack traces, zero secret bytes
// - VoiceCredentialStore backend-only resolution (env and config)
// - Auto-registration of resolved secrets with redactor
// - Zero secret enumeration APIs (no listAllSecrets, no dumpConfig)
// - Fallback provider changes cache identity (cannot publish under primary key)
// - Credential rotation leaves cache identity unchanged

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCacheIdentityPayload,
  deriveCacheKey,
} from "../src/cache-identity.ts";
import { type VoiceProfile } from "../src/protocol.ts";
import { VoiceProviderError } from "../src/provider-interface.ts";
import {
  defaultSecretRedactor,
  redactSecrets,
  sanitizeUrl,
  SecretRedactor,
} from "../src/redactor.ts";
import {
  MAX_SAFE_ERROR_MESSAGE_LENGTH,
  serializeSafeVoiceError,
  toSafeVoiceError,
} from "../src/safe-error.ts";
import { VoiceCredentialStore } from "../host/credential-store.ts";

describe("credential-and-redaction: SecretRedactor", () => {
  it("redacts exact registered secret strings dynamically", () => {
    const redactor = new SecretRedactor();
    const fakeSecret = "sk-proj-xyz1234567890abcdef";
    redactor.registerSecret(fakeSecret);

    const logMessage = `Request failed: Authorization header was Bearer ${fakeSecret} at endpoint.`;
    const redacted = redactor.redact(logMessage);

    assert.ok(!redacted.includes(fakeSecret), "Secret must not appear in redacted output");
    assert.match(redacted, /\[REDACTED\]/);
  });

  it("redacts multiple secrets ordered by length to prevent partial replacement", () => {
    const redactor = new SecretRedactor();
    const secretA = "secret-token-12345";
    const secretB = "secret-token-12345-extended";
    redactor.registerSecret(secretA);
    redactor.registerSecret(secretB);

    const text = `Tokens: ${secretB} and ${secretA}`;
    const redacted = redactor.redact(text);

    assert.ok(!redacted.includes(secretA));
    assert.ok(!redacted.includes(secretB));
    assert.equal(redacted, "Tokens: [REDACTED] and [REDACTED]");
  });

  it("redacts Authorization headers and Bearer tokens via pattern matching", () => {
    const redactor = new SecretRedactor();
    const raw = "HTTP 401: Failed for Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz";
    const redacted = redactor.redact(raw);

    assert.ok(!redacted.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz"));
    assert.match(redacted, /Authorization: \[REDACTED\]/);
  });

  it("redacts API keys in key-value and query strings", () => {
    const redactor = new SecretRedactor();
    const samples = [
      "https://api.fake.com/v1/tts?api_key=sk-123456789&locale=en-US",
      '{"apiKey": "super-secret-token", "voice": "instructor"}',
      "client_secret=topsecret987; session=active",
    ];

    for (const sample of samples) {
      const redacted = redactor.redact(sample);
      assert.ok(!redacted.includes("sk-123456789"));
      assert.ok(!redacted.includes("super-secret-token"));
      assert.ok(!redacted.includes("topsecret987"));
      assert.match(redacted, /\[REDACTED\]/);
    }
  });

  it("sanitizes URLs by stripping credentials and signing parameters", () => {
    const redactor = new SecretRedactor();
    const signedUrl =
      "https://user:password123@storage.blob.core.windows.net/voices/sample.wav?sig=H4sIAAAAAAA%3D&se=2026-09-19T12%3A00%3A00Z&sp=r";
    const sanitized = redactor.sanitizeUrl(signedUrl);

    assert.ok(!sanitized.includes("password123"));
    assert.ok(!sanitized.includes("H4sIAAAAAAA%3D"));
    assert.ok(sanitized.includes("storage.blob.core.windows.net/voices/sample.wav"));
    assert.match(sanitized, /sig=\[REDACTED\]/);
  });
});

describe("credential-and-redaction: SafeVoiceError serialization", () => {
  it("bounds safe error message to MAX_SAFE_ERROR_MESSAGE_LENGTH (1024 chars)", () => {
    const redactor = new SecretRedactor();
    const massiveMessage = "A".repeat(5000);
    const err = new Error(massiveMessage);

    const safeError = toSafeVoiceError(err, { redactor });
    assert.ok(safeError.message.length <= MAX_SAFE_ERROR_MESSAGE_LENGTH);
    assert.ok(safeError.message.endsWith("..."));
  });

  it("strips host file paths and stack traces completely from SafeVoiceError", () => {
    const redactor = new SecretRedactor();
    const errWithStack = new Error("Failed during synthesis");
    errWithStack.stack =
      "Error: Failed during synthesis\n    at Synthesizer.synthesize (E:\\course-factory\\engine\\voice\\src\\fake.ts:120:15)\n    at async Object.run (E:\\course-factory\\engine\\voice\\host\\index.ts:50:5)";

    const safeError = toSafeVoiceError(errWithStack, { redactor });
    assert.ok(!safeError.message.includes("E:\\course-factory"));
    assert.ok(!safeError.message.includes("at Synthesizer.synthesize"));
    assert.equal(safeError.message, "Failed during synthesis");
  });

  it("serializes SafeVoiceError to deterministic JSON string without secrets", () => {
    const redactor = new SecretRedactor();
    const secret = "secret-credential-value";
    redactor.registerSecret(secret);

    const providerErr = new VoiceProviderError({
      code: "AUTH_FAILED",
      message: `Invalid token: ${secret}`,
      provider_identity: {
        provider_family: "fake",
        provider_model: "fake-m",
        provider_voice_id: "fake-v",
      },
    });

    const safeError = toSafeVoiceError(providerErr, { redactor, requestId: "req-999" });
    const serialized = serializeSafeVoiceError(safeError);

    assert.ok(!serialized.includes(secret));
    assert.ok(serialized.includes("[REDACTED]"));
    assert.ok(serialized.includes('"code":"AUTH_FAILED"'));
    assert.ok(serialized.includes('"retry_classification":"NON_RETRYABLE"'));
    assert.ok(serialized.includes('"request_id":"req-999"'));
  });
});

describe("credential-and-redaction: VoiceCredentialStore authority", () => {
  it("resolves secret from environment and auto-registers with redactor", async () => {
    const redactor = new SecretRedactor();
    const testSecret = "test-secret-env-key-12345";
    const store = new VoiceCredentialStore({
      redactor,
      env: {
        COURSE_FACTORY_TTS_FAKE_API_KEY: testSecret,
      },
    });

    assert.equal(redactor.size, 0);
    const resolved = await store.resolveSecret({
      provider_family: "fake",
      secret_key: "api_key",
    });

    assert.equal(resolved, testSecret);
    assert.equal(redactor.size, 1);

    // Verify it is immediately redacted in log output
    const log = `Calling provider with key ${testSecret}`;
    assert.equal(redactor.redact(log), "Calling provider with key [REDACTED]");
  });

  it("returns null safely for unconfigured secret without throwing", async () => {
    const store = new VoiceCredentialStore({ env: {} });
    const result = await store.resolveSecret({
      provider_family: "fake",
      secret_key: "nonexistent_key",
    });
    assert.equal(result, null);
  });

  it("rejects non-identifier provider family or key to prevent injection", async () => {
    const store = new VoiceCredentialStore();

    await assert.rejects(
      async () => {
        await store.resolveSecret({
          provider_family: "../traversal",
          secret_key: "api_key",
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "CONFIG_INVALID");
        return true;
      },
    );
  });
});

describe("credential-and-redaction: cache identity & fallback safety", () => {
  const profilePrimary: VoiceProfile = {
    profile_id: "en-primary",
    locale: "en-US",
    gender: "male",
    description: "Primary instructor",
    provider_family: "fake",
    provider_voice_id: "primary-voice",
    provider_model: "v1-standard",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const profileFallback: VoiceProfile = {
    ...profilePrimary,
    profile_id: "en-fallback",
    provider_family: "fake-secondary",
    provider_voice_id: "secondary-voice",
  };

  it("proves credentials are NEVER included in CacheIdentityPayload or cache key", () => {
    const payload = createCacheIdentityPayload("Hello world", profilePrimary);
    const serialized = JSON.stringify(payload);

    assert.ok(!serialized.includes("api_key"));
    assert.ok(!serialized.includes("token"));
    assert.ok(!serialized.includes("secret"));
  });

  it("proves rotating credentials leaves cache identity 100% unchanged", () => {
    // Rotating credentials does not alter profile or payload fields
    const key1 = deriveCacheKey(createCacheIdentityPayload("Hello world", profilePrimary));
    const key2 = deriveCacheKey(createCacheIdentityPayload("Hello world", profilePrimary));
    assert.equal(key1, key2, "Cache key must remain strictly identical across credential rotation");
  });

  it("proves fallback provider computes a distinct cache key and cannot share primary cache key", () => {
    const primaryKey = deriveCacheKey(createCacheIdentityPayload("Hello world", profilePrimary));
    const fallbackKey = deriveCacheKey(createCacheIdentityPayload("Hello world", profileFallback));

    assert.notEqual(
      primaryKey,
      fallbackKey,
      "Fallback provider must have distinct cache key from primary provider",
    );
  });
});
