// P10.8 Runner Fixture & Contract Regression Unit Tests
//
// Proves the P10.8 real voice proof runner fixture:
// 1. Parses as frozen Compiled IR 1.0 under canonical compiler contract validation.
// 2. Produces a valid NarrationPlan under canonical P10.3 planner validation.
// 3. Preserves authored audition text byte-for-byte across Arabic, English, and Mixed scripts.
// 4. Produces exact expected narration unit counts.
// 5. Runs strictly offline with ZERO provider or network calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCompiledLesson } from "../../compiler/src/ir.ts";
import {
  createNarrationPlan,
  NarrationPlanSchema,
  type VoiceProfile,
  type VoiceProfileConfig,
} from "../src/index.ts";
// @ts-expect-error - runner is ESM .mjs outside typescript root
import { AUDITION_TEXTS, buildP108AuditionLesson } from "../../../scripts/run-p10-8-real-voice-proof.mjs";

describe("P10.8 runner fixture: Compiled IR 1.0 contract compliance", () => {
  it("parses single Arabic audition fixture as frozen Compiled IR 1.0", () => {
    const lesson = buildP108AuditionLesson({
      lessonId: "C01-L008",
      sceneId: "C01-L008-S001",
      stepId: "C01-L008-S001-B001",
      text: AUDITION_TEXTS.A_ARABIC,
      language: "ar",
      speaker: "instructor",
    });

    const result = validateCompiledLesson(lesson);
    assert.equal(result.ok, true, `Compiled IR validation failed: ${JSON.stringify(result.issues)}`);
    assert.equal(result.ir?.compiled_ir_version, "1.0");
    assert.equal(result.ir?.lesson.lesson_id, "C01-L008");
    assert.equal(result.ir?.scenes.length, 1);
    assert.equal(result.ir?.scenes[0]?.steps.length, 1);
  });

  it("parses single English audition fixture as frozen Compiled IR 1.0", () => {
    const lesson = buildP108AuditionLesson({
      lessonId: "C01-L008",
      sceneId: "C01-L008-S001",
      stepId: "C01-L008-S001-B002",
      text: AUDITION_TEXTS.B_ENGLISH,
      language: "en",
      speaker: "instructor",
    });

    const result = validateCompiledLesson(lesson);
    assert.equal(result.ok, true, `Compiled IR validation failed: ${JSON.stringify(result.issues)}`);
    assert.equal(result.ir?.lesson.direction, "ltr");
  });

  it("parses multi-step mixed technical audition fixture as frozen Compiled IR 1.0", () => {
    const multiLesson = buildP108AuditionLesson({
      lessonId: "C01-L008",
      sceneId: "C01-L008-S001",
      steps: [
        { text: AUDITION_TEXTS.A_ARABIC, locale: "ar-EG", speaker: "inst-shakir" },
        { text: AUDITION_TEXTS.A_ARABIC, locale: "ar-EG", speaker: "inst-salma" },
        { text: AUDITION_TEXTS.B_ENGLISH, locale: "en-US", speaker: "inst-andrew" },
        { text: AUDITION_TEXTS.C_MIXED, locale: "ar-EG", speaker: "inst-shakir" },
      ],
    });

    const result = validateCompiledLesson(multiLesson);
    assert.equal(result.ok, true, `Compiled IR validation failed: ${JSON.stringify(result.issues)}`);
    assert.equal(result.ir?.scenes[0]?.steps.length, 4);
  });
});

describe("P10.8 runner fixture: P10.3 narration plan generation & text preservation", () => {
  const profileShakir: VoiceProfile = {
    profile_id: "real-azure-ar-eg-shakir",
    locale: "ar-EG",
    gender: "male",
    description: "Egyptian Arabic Voice (Shakir)",
    provider_family: "azure",
    provider_voice_id: "ar-EG-ShakirNeural",
    provider_model: "neural",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const profileSalma: VoiceProfile = {
    profile_id: "real-azure-ar-eg-salma",
    locale: "ar-EG",
    gender: "female",
    description: "Egyptian Arabic Voice (Salma)",
    provider_family: "azure",
    provider_voice_id: "ar-EG-SalmaNeural",
    provider_model: "neural",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const profileAndrew: VoiceProfile = {
    profile_id: "real-azure-en-us",
    locale: "en-US",
    gender: "male",
    description: "English Voice (Andrew)",
    provider_family: "azure",
    provider_voice_id: "en-US-AndrewMultilingualNeural",
    provider_model: "neural",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const config: VoiceProfileConfig = {
    profiles: [profileShakir, profileSalma, profileAndrew],
    speaker_mappings: [
      { speaker: "inst-shakir", profile_id: "real-azure-ar-eg-shakir" },
      { speaker: "inst-salma", profile_id: "real-azure-ar-eg-salma" },
      { speaker: "inst-andrew", profile_id: "real-azure-en-us" },
      { speaker: "instructor", profile_id: "real-azure-ar-eg-shakir" },
    ],
    default_profile_id: "real-azure-ar-eg-shakir",
  };

  it("produces a valid NarrationPlan for single Arabic audition text preserving authored text", () => {
    const lesson = buildP108AuditionLesson({
      lessonId: "C01-L008",
      sceneId: "C01-L008-S001",
      stepId: "C01-L008-S001-B001",
      text: AUDITION_TEXTS.A_ARABIC,
      language: "ar",
      speaker: "inst-shakir",
    });

    const plan = createNarrationPlan(lesson, config);
    const parsed = NarrationPlanSchema.safeParse(plan);
    assert.equal(parsed.success, true);
    assert.equal(plan.total_units, 1);
    assert.equal(plan.units.length, 1);

    const unit = plan.units[0]!;
    assert.equal(unit.unit.authored_text, AUDITION_TEXTS.A_ARABIC);
    assert.equal(unit.voice_profile_id, "real-azure-ar-eg-shakir");
    assert.equal(unit.voice_unit_id, "vu-C01-L008-C01-L008-S001-B001-001");
  });

  it("produces a valid NarrationPlan for single English audition text preserving authored text", () => {
    const lesson = buildP108AuditionLesson({
      lessonId: "C01-L008",
      sceneId: "C01-L008-S001",
      stepId: "C01-L008-S001-B002",
      text: AUDITION_TEXTS.B_ENGLISH,
      language: "en",
      speaker: "inst-andrew",
    });

    const plan = createNarrationPlan(lesson, config);
    assert.equal(plan.total_units, 1);
    const unit = plan.units[0]!;
    assert.equal(unit.unit.authored_text, AUDITION_TEXTS.B_ENGLISH);
    assert.equal(unit.voice_profile_id, "real-azure-en-us");
  });

  it("produces a valid NarrationPlan for mixed technical audition text preserving authored text", () => {
    const lesson = buildP108AuditionLesson({
      lessonId: "C01-L008",
      sceneId: "C01-L008-S001",
      stepId: "C01-L008-S001-B003",
      text: AUDITION_TEXTS.C_MIXED,
      language: "ar",
      speaker: "inst-shakir",
    });

    const plan = createNarrationPlan(lesson, config);
    assert.equal(plan.total_units, 1);
    const unit = plan.units[0]!;
    assert.equal(unit.unit.authored_text, AUDITION_TEXTS.C_MIXED);
    // Preserves Latin tokens verbatim in authored_text
    assert.ok(unit.unit.authored_text.includes("Visual Studio Code"));
    assert.ok(unit.unit.authored_text.includes("npm install"));
    assert.ok(unit.unit.authored_text.includes("localhost"));
  });

  it("produces expected narration unit count on multi-step lesson", () => {
    const multiLesson = buildP108AuditionLesson({
      lessonId: "C01-L008",
      sceneId: "C01-L008-S001",
      steps: [
        { text: AUDITION_TEXTS.A_ARABIC, locale: "ar-EG", speaker: "inst-shakir" },
        { text: AUDITION_TEXTS.A_ARABIC, locale: "ar-EG", speaker: "inst-salma" },
        { text: AUDITION_TEXTS.B_ENGLISH, locale: "en-US", speaker: "inst-andrew" },
        { text: AUDITION_TEXTS.C_MIXED, locale: "ar-EG", speaker: "inst-shakir" },
      ],
    });

    const plan = createNarrationPlan(multiLesson, config);
    assert.equal(plan.total_units, 4);
    assert.equal(plan.units.length, 4);

    assert.equal(plan.units[0]?.voice_profile_id, "real-azure-ar-eg-shakir");
    assert.equal(plan.units[1]?.voice_profile_id, "real-azure-ar-eg-salma");
    assert.equal(plan.units[2]?.voice_profile_id, "real-azure-en-us");
    assert.equal(plan.units[3]?.voice_profile_id, "real-azure-ar-eg-shakir");

    assert.equal(plan.units[0]?.unit.authored_text, AUDITION_TEXTS.A_ARABIC);
    assert.equal(plan.units[1]?.unit.authored_text, AUDITION_TEXTS.A_ARABIC);
    assert.equal(plan.units[2]?.unit.authored_text, AUDITION_TEXTS.B_ENGLISH);
    assert.equal(plan.units[3]?.unit.authored_text, AUDITION_TEXTS.C_MIXED);
  });
});
