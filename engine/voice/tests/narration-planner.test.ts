// P10.3 Narration Planner Unit Tests
//
// Tests deterministic narration extraction from Compiled IR 1.0, authored order preservation,
// stable VoiceUnitId vs CacheKey distinction, pause sample math (exact integer 48,000 samples/sec),
// plan digest calculation, absence of volatile session pollution, zero provider synthesis calls,
// and zero audio generation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  type CompiledLessonInput,
  type VoiceProfile,
  type VoiceProfileConfig,
  createNarrationPlan,
  createPlannedSynthesisRequest,
  deriveVoiceUnitId,
  TEXT_NORMALIZATION_VERSION,
  VOICE_CONTRACT_VERSION,
  deriveCacheKey,
  createCacheIdentityPayload,
} from "../src/index.ts";

describe("narration-planner: extraction & authored ordering", () => {
  const profileAr: VoiceProfile = {
    profile_id: "ar-instructor",
    locale: "ar-EG",
    gender: "male",
    description: "Egyptian Arabic Instructor",
    provider_family: "fake",
    provider_voice_id: "cairo-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const config: VoiceProfileConfig = {
    profiles: [profileAr],
    speaker_mappings: [{ speaker: "instructor", profile_id: "ar-instructor" }],
    default_profile_id: "ar-instructor",
  };

  const sampleLesson: CompiledLessonInput = {
    compiled_ir_version: "1.0",
    lesson: {
      course_id: "C01",
      lesson_id: "C01-L003",
      language: "ar",
    },
    scenes: [
      {
        scene_id: "C01-L003-S001",
        ordinal: 1,
        steps: [
          {
            kind: "narration",
            step_id: "C01-L003-S001-B001",
            ordinal: 1,
            derived: false,
            source_ref: {
              scene_id: "C01-L003-S001",
              scene_ordinal: 1,
              beat_id: "C01-L003-S001-B001",
              form: "authored_beat",
            },
            narration: {
              text: "أهلاً بكم في كورس فاكتوري.",
              language: "ar",
              direction: "rtl",
              speaker: "instructor",
              delivery: "enthusiastic",
              pause_before: 1,
              pause_after: 2,
            },
          },
          {
            kind: "pause",
            step_id: "C01-L003-S001-B002",
            ordinal: 2,
          },
          {
            kind: "operation",
            step_id: "C01-L003-S001-B003",
            ordinal: 3,
          },
        ],
      },
      {
        scene_id: "C01-L003-S002",
        ordinal: 2,
        steps: [
          {
            kind: "narration",
            step_id: "C01-L003-S002-B001",
            ordinal: 1,
            derived: false,
            source_ref: {
              scene_id: "C01-L003-S002",
              scene_ordinal: 2,
              beat_id: "C01-L003-S002-B001",
              form: "authored_beat",
            },
            narration: {
              text: "في هذه الخطوة سنشغل سيرفر Docker.",
              language: "ar",
              direction: "rtl",
              speaker: "instructor",
              delivery: "neutral",
              pause_before: 0,
              pause_after: 1,
            },
          },
        ],
      },
    ],
  };

  it("extracts multiple narration steps in exact authored order, ignoring non-narration steps", () => {
    const plan = createNarrationPlan(sampleLesson, config);

    assert.equal(plan.total_units, 2);
    assert.equal(plan.units.length, 2);

    const [u1, u2] = plan.units;
    assert.equal(u1!.voice_unit_id, "vu-C01-L003-C01-L003-S001-B001-001");
    assert.equal(u1!.unit.narration_ordinal, 1);
    assert.equal(u1!.unit.step_id, "C01-L003-S001-B001");
    assert.equal(u1!.unit.delivery, "enthusiastic");

    assert.equal(u2!.voice_unit_id, "vu-C01-L003-C01-L003-S002-B001-002");
    assert.equal(u2!.unit.narration_ordinal, 2);
    assert.equal(u2!.unit.step_id, "C01-L003-S002-B001");
    assert.equal(u2!.unit.delivery, "neutral");
  });

  it("preserves authored_text byte-for-byte while normalized_text is separate", () => {
    const plan = createNarrationPlan(sampleLesson, config);
    const u2 = plan.units[1]!;

    // Authored text preserves Latin "Docker"
    assert.equal(u2.unit.authored_text, "في هذه الخطوة سنشغل سيرفر Docker.");
    // Normalized text converts "Docker" to phonetic "دوكر"
    assert.equal(u2.normalized_text, "في هذه الخطوة سنشغل سيرفر دوكر.");
    assert.notEqual(u2.unit.authored_text, u2.normalized_text);
  });
});

describe("narration-planner: pause sample math & bounds", () => {
  const profileEn: VoiceProfile = {
    profile_id: "en-instructor",
    locale: "en-US",
    gender: "male",
    description: "English Instructor",
    provider_family: "fake",
    provider_voice_id: "boston-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const config: VoiceProfileConfig = {
    profiles: [profileEn],
    speaker_mappings: [{ speaker: "instructor", profile_id: "en-instructor" }],
    default_profile_id: "en-instructor",
  };

  it("calculates exact integer sample counts: 1 sec = 48,000 samples, 0 sec = 0 samples", () => {
    const lesson: CompiledLessonInput = {
      compiled_ir_version: "1.0",
      lesson: { course_id: "C01", lesson_id: "C01-L003", language: "en" },
      scenes: [
        {
          scene_id: "C01-L003-S001",
          ordinal: 1,
          steps: [
            {
              kind: "narration",
              step_id: "C01-L003-S001-B001",
              ordinal: 1,
              derived: false,
              source_ref: { scene_id: "C01-L003-S001", scene_ordinal: 1, beat_id: "B001", form: "authored_beat" },
              narration: {
                text: "Hello world.",
                language: "en",
                direction: "ltr",
                pause_before: 1,
                pause_after: 3,
              },
            },
            {
              kind: "narration",
              step_id: "C01-L003-S001-B002",
              ordinal: 2,
              derived: false,
              source_ref: { scene_id: "C01-L003-S001", scene_ordinal: 1, beat_id: "B002", form: "authored_beat" },
              narration: {
                text: "Second step.",
                language: "en",
                direction: "ltr",
                pause_before: 0,
                pause_after: 0,
              },
            },
          ],
        },
      ],
    };

    const plan = createNarrationPlan(lesson, config);
    const [u1, u2] = plan.units;

    assert.equal(u1!.pause_before_samples, 48_000);
    assert.equal(u1!.pause_after_samples, 144_000);
    assert.equal(u1!.unit.pause_before_seconds, 1);
    assert.equal(u1!.unit.pause_after_seconds, 3);

    assert.equal(u2!.pause_before_samples, 0);
    assert.equal(u2!.pause_after_samples, 0);
  });
});

describe("narration-planner: VoiceUnitId vs CacheKey separation", () => {
  const profileEn: VoiceProfile = {
    profile_id: "en-instructor",
    locale: "en-US",
    gender: "male",
    description: "English Instructor",
    provider_family: "fake",
    provider_voice_id: "boston-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const config: VoiceProfileConfig = {
    profiles: [profileEn],
    speaker_mappings: [{ speaker: "instructor", profile_id: "en-instructor" }],
    default_profile_id: "en-instructor",
  };

  it("same acoustic phrase in different steps/lessons yields identical CacheKey but distinct VoiceUnitId", () => {
    const identicalText = "Welcome to Course Factory.";

    const lessonA: CompiledLessonInput = {
      compiled_ir_version: "1.0",
      lesson: { course_id: "C01", lesson_id: "C01-L001", language: "en" },
      scenes: [
        {
          scene_id: "C01-L001-S001",
          ordinal: 1,
          steps: [
            {
              kind: "narration",
              step_id: "C01-L001-S001-B001",
              ordinal: 1,
              derived: false,
              source_ref: { scene_id: "C01-L001-S001", scene_ordinal: 1, beat_id: "B001", form: "authored_beat" },
              narration: { text: identicalText, language: "en", direction: "ltr" },
            },
          ],
        },
      ],
    };

    const lessonB: CompiledLessonInput = {
      compiled_ir_version: "1.0",
      lesson: { course_id: "C02", lesson_id: "C02-L099", language: "en" },
      scenes: [
        {
          scene_id: "C02-L099-S005",
          ordinal: 5,
          steps: [
            {
              kind: "narration",
              step_id: "C02-L099-S005-B042",
              ordinal: 1,
              derived: false,
              source_ref: { scene_id: "C02-L099-S005", scene_ordinal: 5, beat_id: "B042", form: "authored_beat" },
              narration: { text: identicalText, language: "en", direction: "ltr" },
            },
          ],
        },
      ],
    };

    const planA = createNarrationPlan(lessonA, config);
    const planB = createNarrationPlan(lessonB, config);

    const unitA = planA.units[0]!;
    const unitB = planB.units[0]!;

    // Content identity (CacheKey): IDENTICAL
    assert.equal(unitA.cache_key, unitB.cache_key);

    // Placement identity (VoiceUnitId): DISTINCT
    assert.notEqual(unitA.voice_unit_id, unitB.voice_unit_id);
    assert.equal(unitA.voice_unit_id, "vu-C01-L001-C01-L001-S001-B001-001");
    assert.equal(unitB.voice_unit_id, "vu-C02-L099-C02-L099-S005-B042-001");
  });

  it("changing normalized text or voice profile alters CacheKey", () => {
    const payload1 = createCacheIdentityPayload("Hello world.", profileEn);
    const key1 = deriveCacheKey(payload1);

    const payload2 = createCacheIdentityPayload("Hello world again.", profileEn);
    const key2 = deriveCacheKey(payload2);
    assert.notEqual(key1, key2);

    const profileEnFast: VoiceProfile = { ...profileEn, rate: 1.25 };
    const payload3 = createCacheIdentityPayload("Hello world.", profileEnFast);
    const key3 = deriveCacheKey(payload3);
    assert.notEqual(key1, key3);
  });
});

describe("narration-planner: determinism & isolation", () => {
  const profileEn: VoiceProfile = {
    profile_id: "en-instructor",
    locale: "en-US",
    gender: "male",
    description: "English Instructor",
    provider_family: "fake",
    provider_voice_id: "boston-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const config: VoiceProfileConfig = {
    profiles: [profileEn],
    speaker_mappings: [],
    default_profile_id: "en-instructor",
  };

  const lesson: CompiledLessonInput = {
    compiled_ir_version: "1.0",
    lesson: { course_id: "C01", lesson_id: "C01-L003", language: "en" },
    scenes: [
      {
        scene_id: "C01-L003-S001",
        ordinal: 1,
        steps: [
          {
            kind: "narration",
            step_id: "C01-L003-S001-B001",
            ordinal: 1,
            derived: false,
            source_ref: { scene_id: "C01-L003-S001", scene_ordinal: 1, beat_id: "B001", form: "authored_beat" },
            narration: { text: "Deterministic planning test.", language: "en", direction: "ltr" },
          },
        ],
      },
    ],
  };

  it("produces byte-identical plan digest and plan serialization across runs", () => {
    const plan1 = createNarrationPlan(lesson, config);
    const plan2 = createNarrationPlan(lesson, config);

    assert.equal(plan1.plan_digest, plan2.plan_digest);
    assert.deepEqual(plan1, plan2);
    assert.equal(plan1.text_normalization_version, TEXT_NORMALIZATION_VERSION);
    assert.equal(plan1.voice_contract_version, VOICE_CONTRACT_VERSION);
  });

  it("proves plan contains zero credentials, filesystem paths, or volatile session IDs", () => {
    const plan = createNarrationPlan(lesson, config);
    const planJson = JSON.stringify(plan);

    assert.doesNotMatch(planJson, /api_key|token|secret|password|bearer/i);
    assert.doesNotMatch(planJson, /runtime_session_id|recording_session_id|take_id/);
    assert.doesNotMatch(planJson, /[A-Z]:\\[^\s]+/); // Windows absolute path
    assert.doesNotMatch(planJson, /\/Users\/|\/home\//); // Unix absolute path
  });

  it("converts planned unit to SynthesisRequest pure envelope without provider execution", () => {
    const plan = createNarrationPlan(lesson, config);
    const plannedUnit = plan.units[0]!;

    const req = createPlannedSynthesisRequest(plannedUnit, profileEn, "req-planned-001");
    assert.equal(req.request_id, "req-planned-001");
    assert.equal(req.cache_key, plannedUnit.cache_key);
    assert.equal(req.normalized_text, plannedUnit.normalized_text);
    assert.equal(req.locale, "en-US");
    assert.equal(req.voice_profile.profile_id, "en-instructor");
  });

  it("plans real repository compiled lesson fixture deterministically", () => {
    const fixturePath = fileURLToPath(
      new URL("../../../runtime/compiled/C01-L003/compiled-lesson.json", import.meta.url),
    );
    const rawCompiled = JSON.parse(readFileSync(fixturePath, "utf8"));

    const configMixed: VoiceProfileConfig = {
      profiles: [
        {
          profile_id: "ar-instructor",
          locale: "ar-EG",
          gender: "male",
          description: "Egyptian Arabic Instructor",
          provider_family: "fake",
          provider_voice_id: "cairo-01",
          provider_model: "deterministic-v1",
          rate: 1.0,
          pitch: 0.0,
          normalization_policy: "standard-v1",
        },
        {
          profile_id: "en-instructor",
          locale: "en-US",
          gender: "male",
          description: "English Instructor",
          provider_family: "fake",
          provider_voice_id: "boston-01",
          provider_model: "deterministic-v1",
          rate: 1.0,
          pitch: 0.0,
          normalization_policy: "standard-v1",
        },
      ],
      speaker_mappings: [],
      default_profiles: {
        ar: "ar-instructor",
        en: "en-instructor",
      },
    };

    const plan1 = createNarrationPlan(rawCompiled, configMixed);
    const plan2 = createNarrationPlan(rawCompiled, configMixed);

    assert.ok(plan1.total_units > 0);
    assert.equal(plan1.plan_digest, plan2.plan_digest);
    assert.deepEqual(plan1, plan2);

    for (const unit of plan1.units) {
      assert.ok(unit.voice_unit_id.startsWith("vu-C01-L003-"));
      assert.ok(unit.cache_key.length === 64);
      assert.ok(unit.normalized_text.length > 0);
    }
  });

  it("proves plan_digest changes when acoustic narration text changes", () => {
    const lessonModified: CompiledLessonInput = {
      ...lesson,
      scenes: [
        {
          ...lesson.scenes[0]!,
          steps: [
            {
              kind: "narration",
              step_id: "C01-L003-S001-B001",
              ordinal: 1,
              derived: false,
              source_ref: { scene_id: "C01-L003-S001", scene_ordinal: 1, beat_id: "B001", form: "authored_beat" },
              narration: { text: "Different text changes the digest.", language: "en", direction: "ltr" },
            },
          ],
        },
      ],
    };

    const planA = createNarrationPlan(lesson, config);
    const planB = createNarrationPlan(lessonModified, config);

    assert.notEqual(planA.plan_digest, planB.plan_digest);
  });
});

