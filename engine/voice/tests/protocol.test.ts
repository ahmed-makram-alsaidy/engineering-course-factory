// P10.1 Voice Protocol & Contract Unit Tests
//
// Tests Voice Protocol v1, versions, safe identifiers, locales, VoiceProfile,
// NarrationUnit, Alignment models, VoiceAsset metadata duration invariant,
// failure taxonomy, retry classifications, and timeouts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_NORMALIZATION_VERSION,
  AlignmentStatusSchema,
  CourseIdSchema,
  DeliveryToneSchema,
  LessonIdSchema,
  NormalizedAlignmentSchema,
  PhonemeMarkSchema,
  RuntimeFenceSchema,
  SceneIdSchema,
  Sha256HexSchema,
  StepIdSchema,
  SupportedLocaleSchema,
  TEXT_NORMALIZATION_VERSION,
  VOICE_CONTRACT_VERSION,
  VOICE_FAILURE_CODES,
  VOICE_MANIFEST_VERSION,
  VOICE_PROTOCOL_VERSION,
  VOICE_RETRY_CLASSIFICATIONS,
  VOICE_TIMEOUTS,
  VoiceAssetMetadataSchema,
  type VoiceFailureCode,
  VoiceIdentifierSchema,
  type VoiceProfile,
  VoiceProfileSchema,
  VoiceUnitIdSchema,
  WordMarkSchema,
  classifyVoiceFailureCode,
  NarrationUnitSchema,
} from "../src/protocol.ts";

describe("protocol: versions and literals", () => {
  it("freezes protocol and contract version literals", () => {
    assert.equal(VOICE_PROTOCOL_VERSION, "v1");
    assert.equal(VOICE_MANIFEST_VERSION, "1.0");
    assert.equal(TEXT_NORMALIZATION_VERSION, "1.0");
    assert.equal(AUDIO_NORMALIZATION_VERSION, "1.0");
    assert.equal(VOICE_CONTRACT_VERSION, "1.0");
  });
});

describe("protocol: safe identifier rules", () => {
  it("accepts valid alphanumeric, period, dash, and underscore identifiers", () => {
    const valid = [
      "ar-instructor-primary",
      "step-001",
      "beat_12",
      "model.v1",
      "C01-L003-S001-B001",
    ];
    for (const id of valid) {
      assert.equal(VoiceIdentifierSchema.parse(id), id);
    }
  });

  it("rejects invalid characters, traversal, and whitespace", () => {
    const invalid = [
      "",
      "   ",
      "-starts-with-dash",
      "has/slash",
      "has\\backslash",
      "../traversal",
      "has space",
      "has$special!",
      "a".repeat(129),
    ];
    for (const id of invalid) {
      assert.throws(() => VoiceIdentifierSchema.parse(id));
    }
  });

  it("validates structured lesson, scene, and course identifiers", () => {
    assert.equal(CourseIdSchema.parse("C01"), "C01");
    assert.throws(() => CourseIdSchema.parse("Course01"));

    assert.equal(LessonIdSchema.parse("C01-L003"), "C01-L003");
    assert.throws(() => LessonIdSchema.parse("L003"));

    assert.equal(SceneIdSchema.parse("C01-L003-S014"), "C01-L003-S014");
    assert.throws(() => SceneIdSchema.parse("C01-L003-S14"));

    assert.equal(VoiceUnitIdSchema.parse("vu-C01-L003-S001-B001-001"), "vu-C01-L003-S001-B001-001");
    assert.throws(() => VoiceUnitIdSchema.parse("not-vu-prefix"));
  });

  it("validates SHA-256 hex digest shape", () => {
    const validHex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    assert.equal(Sha256HexSchema.parse(validHex), validHex);
    assert.throws(() => Sha256HexSchema.parse(validHex.toUpperCase())); // must be lowercase
    assert.throws(() => Sha256HexSchema.parse(validHex.slice(1))); // 63 chars
    assert.throws(() => Sha256HexSchema.parse(validHex + "a")); // 65 chars
  });
});

describe("protocol: supported locales", () => {
  it("accepts all 4 canonical locales", () => {
    const locales = ["ar-EG", "ar-SA", "en-US", "en-GB"];
    for (const loc of locales) {
      assert.equal(SupportedLocaleSchema.parse(loc), loc);
    }
  });

  it("rejects unsupported, malformed, or injected locale strings", () => {
    const invalid = ["fr-FR", "es-ES", "ar", "en", "en-US-extra", "ar-EG; rm -rf /"];
    for (const loc of invalid) {
      assert.throws(() => SupportedLocaleSchema.parse(loc));
    }
  });
});

describe("protocol: VoiceProfile contract", () => {
  const validProfile: VoiceProfile = {
    profile_id: "ar-instructor-primary",
    locale: "ar-EG",
    gender: "male",
    description: "Primary Egyptian Arabic technical instructor voice",
    provider_family: "fake",
    provider_voice_id: "voice-cairo-01",
    provider_model: "synthetic-v1",
    rate: 1.0,
    pitch: 0.0,
    style: "instructional",
    normalization_policy: "standard-v1",
  };

  it("accepts a valid provider-neutral profile", () => {
    const parsed = VoiceProfileSchema.parse(validProfile);
    assert.equal(parsed.profile_id, "ar-instructor-primary");
    assert.equal(parsed.rate, 1.0);
  });

  it("enforces speech rate and pitch bounds", () => {
    assert.throws(() => VoiceProfileSchema.parse({ ...validProfile, rate: 0.4 }));
    assert.throws(() => VoiceProfileSchema.parse({ ...validProfile, rate: 2.1 }));
    assert.throws(() => VoiceProfileSchema.parse({ ...validProfile, pitch: -13 }));
    assert.throws(() => VoiceProfileSchema.parse({ ...validProfile, pitch: 13 }));
  });

  it("strict schema rejects any credentials or secret keys", () => {
    const hostileProfiles = [
      { ...validProfile, api_key: "sk-secret-key-12345" },
      { ...validProfile, token: "bearer-token" },
      { ...validProfile, secret: "super-secret" },
      { ...validProfile, password: "admin" },
      { ...validProfile, authorization: "Bearer xyz" },
    ];
    for (const hostile of hostileProfiles) {
      assert.throws(() => VoiceProfileSchema.parse(hostile));
    }
  });
});

describe("protocol: NarrationUnit contract", () => {
  const validUnit = {
    lesson_id: "C01-L003",
    scene_id: "C01-L003-S001",
    step_id: "C01-L003-S001-B001",
    narration_ordinal: 1,
    locale: "ar-EG" as const,
    authored_text: "أهلاً بكم في دورة كورس فاكتوري لتعليم البرمجة.",
    voice_profile_id: "ar-instructor-primary",
    normalization_version: "1.0" as const,
    speaker: "instructor",
    delivery: "enthusiastic" as const,
    pause_before_seconds: 1,
    pause_after_seconds: 2,
  };

  it("accepts a valid narration unit", () => {
    const parsed = NarrationUnitSchema.parse(validUnit);
    assert.equal(parsed.lesson_id, "C01-L003");
    assert.equal(parsed.pause_after_seconds, 2);
  });

  it("strictly rejects volatile runtime session or execution fields", () => {
    const hostileUnits = [
      { ...validUnit, runtime_session_id: "sess-123" },
      { ...validUnit, generation: 1 },
      { ...validUnit, take_id: "t01" },
      { ...validUnit, recording_session_id: "rec-001" },
      { ...validUnit, wall_clock: new Date().toISOString() },
      { ...validUnit, machine_path: "D:\\temp" },
    ];
    for (const hostile of hostileUnits) {
      assert.throws(() => NarrationUnitSchema.parse(hostile));
    }
  });

  it("enforces delivery tones matching Schema 1.1 / IR 1.0", () => {
    for (const tone of ["neutral", "enthusiastic", "calm", "serious"] as const) {
      assert.equal(DeliveryToneSchema.parse(tone), tone);
    }
    assert.throws(() => DeliveryToneSchema.parse("angry"));
  });
});

describe("protocol: alignment schemas and invariants", () => {
  it("accepts valid word and phoneme marks", () => {
    const wordMark = WordMarkSchema.parse({
      ordinal: 1,
      word: "hello",
      start_sample: 0,
      end_sample: 12000,
    });
    assert.equal(wordMark.word, "hello");

    const phonemeMark = PhonemeMarkSchema.parse({
      ordinal: 1,
      phoneme: "HH",
      start_sample: 0,
      end_sample: 2400,
    });
    assert.equal(phonemeMark.phoneme, "HH");
  });

  it("rejects inverted sample ranges in marks", () => {
    assert.throws(() =>
      WordMarkSchema.parse({
        ordinal: 1,
        word: "fail",
        start_sample: 5000,
        end_sample: 4000,
      }),
    );
  });

  it("enforces alignment status consistency in NormalizedAlignment", () => {
    // 1. status: "none" requires empty arrays
    assert.ok(
      NormalizedAlignmentSchema.parse({
        status: "none",
        words: [],
        phonemes: [],
      }),
    );
    assert.throws(() =>
      NormalizedAlignmentSchema.parse({
        status: "none",
        words: [{ ordinal: 1, word: "hi", start_sample: 0, end_sample: 100 }],
      }),
    );

    // 2. status: "word" requires non-empty words and empty phonemes
    assert.ok(
      NormalizedAlignmentSchema.parse({
        status: "word",
        words: [{ ordinal: 1, word: "hi", start_sample: 0, end_sample: 100 }],
        phonemes: [],
      }),
    );
    assert.throws(() =>
      NormalizedAlignmentSchema.parse({
        status: "word",
        words: [],
        phonemes: [],
      }),
    );

    // 3. status: "phoneme" requires non-empty phonemes and empty words
    assert.ok(
      NormalizedAlignmentSchema.parse({
        status: "phoneme",
        words: [],
        phonemes: [{ ordinal: 1, phoneme: "HH", start_sample: 0, end_sample: 50 }],
      }),
    );

    // 4. status: "word_and_phoneme" requires both
    assert.ok(
      NormalizedAlignmentSchema.parse({
        status: "word_and_phoneme",
        words: [{ ordinal: 1, word: "hi", start_sample: 0, end_sample: 100 }],
        phonemes: [{ ordinal: 1, phoneme: "HH", start_sample: 0, end_sample: 50 }],
      }),
    );
  });
});

describe("protocol: VoiceAssetMetadata contract & duration invariant", () => {
  const sampleCount = 96_000; // 2 seconds
  const expectedDuration = 2_000_000; // 2 s = 2,000,000 us

  const validMetadata = {
    voice_unit_id: "vu-C01-L003-S001-B001-001",
    cache_key: "a".repeat(64),
    audio_asset_digest: "b".repeat(64),
    sample_rate_hz: 48000 as const,
    channels: 1 as const,
    bits_per_sample: 16 as const,
    sample_format: "pcm_s16le" as const,
    sample_count: sampleCount,
    duration_us: expectedDuration,
    provider_family: "fake",
    provider_model: "synthetic-v1",
    provider_voice_id: "cairo-01",
    text_normalization_version: "1.0" as const,
    audio_normalization_version: "1.0" as const,
    voice_contract_version: "1.0" as const,
    alignment_status: "none" as const,
  };

  it("accepts valid voice asset metadata adhering to the exact duration invariant", () => {
    const parsed = VoiceAssetMetadataSchema.parse(validMetadata);
    assert.equal(parsed.sample_count, sampleCount);
    assert.equal(parsed.duration_us, expectedDuration);
  });

  it("rejects metadata where duration_us disagrees with sample_count", () => {
    assert.throws(
      () =>
        VoiceAssetMetadataSchema.parse({
          ...validMetadata,
          duration_us: expectedDuration + 1, // incorrect by 1 us
        }),
      /\[DURATION_INVARIANT_VIOLATION\]/,
    );
  });

  it("enforces sample count bounds (4,800 to 14,400,000)", () => {
    assert.throws(() =>
      VoiceAssetMetadataSchema.parse({
        ...validMetadata,
        sample_count: 4_799, // below minimum 100 ms
        duration_us: Math.floor((4_799 * 125) / 6),
      }),
    );

    assert.throws(() =>
      VoiceAssetMetadataSchema.parse({
        ...validMetadata,
        sample_count: 14_400_001, // above maximum 300 s
        duration_us: Math.floor((14_400_001 * 125) / 6),
      }),
    );
  });
});

describe("protocol: failure taxonomy and retry classifications", () => {
  it("contains exactly 15 failure codes", () => {
    assert.equal(VOICE_FAILURE_CODES.length, 15);
  });

  it("deterministically classifies all 15 failure codes", () => {
    const nonRetryable: VoiceFailureCode[] = [
      "CONFIG_INVALID",
      "AUTH_FAILED",
      "UNSUPPORTED_LOCALE",
      "UNSUPPORTED_VOICE",
      "TEXT_EMPTY",
      "NORMALIZATION_FAILED",
      "VALIDATION_FAILED",
    ];
    for (const code of nonRetryable) {
      assert.equal(classifyVoiceFailureCode(code), "NON_RETRYABLE");
    }

    const retryable: VoiceFailureCode[] = [
      "RATE_LIMITED",
      "PROVIDER_UNAVAILABLE",
      "CACHE_CORRUPT",
    ];
    for (const code of retryable) {
      assert.equal(classifyVoiceFailureCode(code), "RETRYABLE");
    }

    const uncertain: VoiceFailureCode[] = [
      "TIMEOUT",
      "SYNTHESIS_FAILED",
    ];
    for (const code of uncertain) {
      assert.equal(classifyVoiceFailureCode(code), "UNCERTAIN_DO_NOT_BLIND_RETRY");
    }

    const terminal: VoiceFailureCode[] = [
      "CANCELLED",
      "RESET_INTERRUPTED",
      "LOW_DISK_ABORT",
    ];
    for (const code of terminal) {
      assert.equal(classifyVoiceFailureCode(code), "TERMINAL");
    }
  });

  it("all classifications belong to the 4 approved categories", () => {
    for (const code of VOICE_FAILURE_CODES) {
      const cat = classifyVoiceFailureCode(code);
      assert.ok(VOICE_RETRY_CLASSIFICATIONS.includes(cat));
    }
  });
});

describe("protocol: timeout contract", () => {
  it("freezes exact operational timeout constants", () => {
    assert.equal(VOICE_TIMEOUTS.probe_ms, 5_000);
    assert.equal(VOICE_TIMEOUTS.synthesis_ms, 30_000);
    assert.equal(VOICE_TIMEOUTS.download_ms, 15_000);
    assert.equal(VOICE_TIMEOUTS.normalization_ms, 10_000);
    assert.equal(VOICE_TIMEOUTS.validation_ms, 5_000);
    assert.equal(VOICE_TIMEOUTS.graceful_termination_ms, 5_000);
  });
});

describe("protocol: runtime fence separation", () => {
  it("validates runtime fence independently from cache identity", () => {
    const fence = RuntimeFenceSchema.parse({
      runtime_session_id: "sess-voice-001",
      generation: 2,
      lesson_id: "C01-L003",
    });
    assert.equal(fence.runtime_session_id, "sess-voice-001");
    assert.equal(fence.generation, 2);
  });
});
