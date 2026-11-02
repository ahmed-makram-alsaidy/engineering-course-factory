// P10.1 Cache Identity & Content-Addressing Unit Tests
//
// Tests canonical JSON stability, cache key determinism, sensitivity to all
// audio-affecting synthesis parameters, strict exclusion of volatile runtime
// and placement fields, and VoiceUnitId derivation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../src/canonical.ts";
import {
  type CacheIdentityPayload,
  CacheIdentityPayloadSchema,
  CacheIdentityPayloadV1Schema,
  CacheIdentityPayloadV1_1Schema,
  createCacheIdentityPayload,
  deriveCacheKey,
  deriveVoiceUnitId,
} from "../src/cache-identity.ts";
import {
  type VoiceProfile,
  VOICE_CONTRACT_VERSION,
  VOICE_CONTRACT_VERSION_1_1,
} from "../src/protocol.ts";
import {
  APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_PROFILE_ID,
  APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_VERSION,
  EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_DIGEST,
  GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
  GEMINI_SECONDARY_INSTRUCTOR_PROFILE,
} from "../src/delivery-profile.ts";

describe("cache-identity: canonical JSON serialization", () => {
  it("produces identical serialization regardless of object key insertion order", () => {
    const objA = { z: 1, a: 2, m: { y: "hello", b: "world" } };
    const objB = { a: 2, m: { b: "world", y: "hello" }, z: 1 };

    assert.equal(canonicalJson(objA), canonicalJson(objB));
    assert.equal(canonicalJson(objA), '{"a":2,"m":{"b":"world","y":"hello"},"z":1}');
  });

  it("preserves array order strictly", () => {
    const arrA = [1, 2, 3];
    const arrB = [3, 2, 1];
    assert.notEqual(canonicalJson(arrA), canonicalJson(arrB));
  });
});

describe("cache-identity: cache key derivation and determinism", () => {
  const profile: VoiceProfile = {
    profile_id: "ar-instructor-primary",
    locale: "ar-EG",
    gender: "male",
    description: "Primary Egyptian instructor",
    provider_family: "fake",
    provider_voice_id: "cairo-01",
    provider_model: "synthetic-v1",
    rate: 1.0,
    pitch: 0.0,
    style: "instructive",
    normalization_policy: "standard-v1",
  };

  const text = "أهلاً بكم في دورة كورس فاكتوري.";

  it("derives a 64-character lowercase hexadecimal cache key deterministically", () => {
    const payload = createCacheIdentityPayload(text, profile);
    const key1 = deriveCacheKey(payload);
    const key2 = deriveCacheKey(payload);

    assert.equal(key1, key2);
    assert.match(key1, /^[0-9a-f]{64}$/);
  });

  it("changes cache key when normalized text changes", () => {
    const payloadA = createCacheIdentityPayload(text, profile);
    const payloadB = createCacheIdentityPayload("نص مختلف تماماً.", profile);

    assert.notEqual(deriveCacheKey(payloadA), deriveCacheKey(payloadB));
  });

  it("changes cache key when locale changes", () => {
    const payloadA = createCacheIdentityPayload(text, profile);
    const payloadB = createCacheIdentityPayload(text, { ...profile, locale: "ar-SA" });

    assert.notEqual(deriveCacheKey(payloadA), deriveCacheKey(payloadB));
  });

  it("changes cache key when provider family or model changes", () => {
    const payloadA = createCacheIdentityPayload(text, profile);
    const payloadB = createCacheIdentityPayload(text, {
      ...profile,
      provider_family: "other-provider",
    });
    const payloadC = createCacheIdentityPayload(text, {
      ...profile,
      provider_model: "model-v2",
    });

    assert.notEqual(deriveCacheKey(payloadA), deriveCacheKey(payloadB));
    assert.notEqual(deriveCacheKey(payloadA), deriveCacheKey(payloadC));
  });

  it("changes cache key when rate, pitch, or style change", () => {
    const payloadBase = createCacheIdentityPayload(text, profile);
    const payloadRate = createCacheIdentityPayload(text, { ...profile, rate: 1.1 });
    const payloadPitch = createCacheIdentityPayload(text, { ...profile, pitch: 1.5 });
    const payloadStyle = createCacheIdentityPayload(text, { ...profile, style: "conversational" });

    const keyBase = deriveCacheKey(payloadBase);
    assert.notEqual(keyBase, deriveCacheKey(payloadRate));
    assert.notEqual(keyBase, deriveCacheKey(payloadPitch));
    assert.notEqual(keyBase, deriveCacheKey(payloadStyle));
  });

  it("changes cache key when normalization version changes", () => {
    const payloadA = createCacheIdentityPayload(text, profile);
    const payloadB: CacheIdentityPayload = {
      ...payloadA,
      text_normalization_version: "2.0" as any,
    };

    assert.notEqual(deriveCacheKey(payloadA), deriveCacheKey(payloadB));
  });
});

describe("cache-identity: strict exclusion of volatile and placement fields", () => {
  const profile: VoiceProfile = {
    profile_id: "en-instructor-primary",
    locale: "en-US",
    gender: "female",
    description: "Primary English instructor",
    provider_family: "fake",
    provider_voice_id: "us-01",
    provider_model: "synthetic-v1",
    rate: 1.0,
    pitch: 0.0,
    style: "instructive",
    normalization_policy: "standard-v1",
  };

  const text = "Welcome to Course Factory.";
  const payload = createCacheIdentityPayload(text, profile);

  it("cache key is identical across different lessons and steps for the same phrase", () => {
    // Both lessons C01-L001 and C02-L015 use the exact same text and profile
    const key1 = deriveCacheKey(payload);
    const key2 = deriveCacheKey(payload);
    assert.equal(key1, key2);
  });

  it("schema strictly rejects any placement or volatile execution fields", () => {
    const hostilePayloads = [
      { ...payload, lesson_id: "C01-L003" },
      { ...payload, scene_id: "C01-L003-S001" },
      { ...payload, step_id: "C01-L003-S001-B001" },
      { ...payload, runtime_session_id: "sess-001" },
      { ...payload, generation: 1 },
      { ...payload, take_id: "t01" },
      { ...payload, recording_id: "rec-001" },
      { ...payload, wall_time: "2026-09-19T00:00:00Z" },
      { ...payload, machine_path: "D:\\renders" },
    ];

    for (const hostile of hostilePayloads) {
      assert.throws(() => CacheIdentityPayloadSchema.parse(hostile));
    }
  });
});

describe("cache-identity: VoiceUnitId derivation", () => {
  it("derives deterministic voice unit ID from placement metadata", () => {
    const id = deriveVoiceUnitId("C01-L003", "C01-L003-S001-B001", 1);
    assert.equal(id, "vu-C01-L003-C01-L003-S001-B001-001");
  });

  it("rejects invalid or non-positive ordinals", () => {
    assert.throws(() => deriveVoiceUnitId("C01-L003", "B001", 0));
    assert.throws(() => deriveVoiceUnitId("C01-L003", "B001", -5));
    assert.throws(() => deriveVoiceUnitId("C01-L003", "B001", 1.5));
  });
});

describe("cache-identity v1.1: delivery profile & natural-language steering identity", () => {
  const text = "أهلاً بيك في درس الـ API.";

  it("derives v1.1 cache identity for profiles with delivery_profile_id", () => {
    const payload = createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE);

    assert.equal(payload.voice_contract_version, VOICE_CONTRACT_VERSION_1_1);
    assert.equal("delivery_profile_id" in payload, true);
    if ("delivery_profile_id" in payload) {
      assert.equal(payload.delivery_profile_id, APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_PROFILE_ID);
      assert.equal(payload.delivery_prompt_version, APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_VERSION);
      assert.equal(payload.delivery_prompt_digest, EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_DIGEST);
    }

    const parsed = CacheIdentityPayloadV1_1Schema.parse(payload);
    assert.ok(parsed);
  });

  it("preserves v1.0 cache identity for profiles without delivery_profile_id", () => {
    const legacyProfile: VoiceProfile = {
      profile_id: "azure-ar-shakir",
      locale: "ar-EG",
      gender: "male",
      description: "Legacy Azure Shakir",
      provider_family: "azure",
      provider_voice_id: "ar-EG-ShakirNeural",
      provider_model: "neural",
      rate: 1.0,
      pitch: 0.0,
      normalization_policy: "standard-v1",
    };

    const payload = createCacheIdentityPayload(text, legacyProfile);
    assert.equal(payload.voice_contract_version, VOICE_CONTRACT_VERSION);
    assert.equal("delivery_profile_id" in payload, false);

    const parsed = CacheIdentityPayloadV1Schema.parse(payload);
    assert.ok(parsed);
  });

  it("proves identical inputs derive identical cache key (repeatability)", () => {
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    assert.equal(key1, key2);
  });

  it("proves different voice produces different cache key", () => {
    const keyPrimary = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const keySecondary = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_SECONDARY_INSTRUCTOR_PROFILE));
    assert.notEqual(keyPrimary, keySecondary);
  });

  it("proves different model produces different cache key", () => {
    const profileFallbackModel: VoiceProfile = {
      ...GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      provider_model: "gemini-2.5-flash-tts",
    };
    const keyPrimary = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const keyFallback = deriveCacheKey(createCacheIdentityPayload(text, profileFallbackModel));
    assert.notEqual(keyPrimary, keyFallback);
  });

  it("proves different text produces different cache key", () => {
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload("نص آخر مختلف تماماً", GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    assert.notEqual(key1, key2);
  });

  it("proves different delivery profile produces different cache key", () => {
    const profileAltDelivery: VoiceProfile = {
      ...GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      delivery_profile_id: "alt-delivery-v1",
      delivery_prompt_version: "1.0",
      delivery_prompt_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload(text, profileAltDelivery));
    assert.notEqual(key1, key2);
  });

  it("proves different delivery prompt version produces different cache key", () => {
    const profileAltVersion: VoiceProfile = {
      ...GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      delivery_prompt_version: "2.0",
    };
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload(text, profileAltVersion));
    assert.notEqual(key1, key2);
  });

  it("proves different delivery prompt digest produces different cache key", () => {
    const profileAltDigest: VoiceProfile = {
      ...GEMINI_PRIMARY_INSTRUCTOR_PROFILE,
      delivery_prompt_digest: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    };
    const key1 = deriveCacheKey(createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE));
    const key2 = deriveCacheKey(createCacheIdentityPayload(text, profileAltDigest));
    assert.notEqual(key1, key2);
  });

  it("proves v1.1 payload schema strictly rejects credentials and volatile fields", () => {
    const validPayload = createCacheIdentityPayload(text, GEMINI_PRIMARY_INSTRUCTOR_PROFILE);

    const hostile = [
      { ...validPayload, api_key: "secret-key-12345" },
      { ...validPayload, token: "bearer-xyz" },
      { ...validPayload, authorization: "Bearer 123" },
      { ...validPayload, secret: "classified" },
      { ...validPayload, lesson_id: "C01-L003" },
      { ...validPayload, machine_path: "D:\\voice-proof" },
    ];

    for (const h of hostile) {
      assert.throws(() => CacheIdentityPayloadV1_1Schema.parse(h));
      assert.throws(() => CacheIdentityPayloadSchema.parse(h));
    }
  });
});
