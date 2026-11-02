// P10.8 Arabic Tuning Fixture — Offline Regression Tests (zero network, zero provider calls)
//
// Proves for the audition-only tuning experiment:
// 1. Each tuning fixture is valid frozen Compiled IR 1.0.
// 2. Authored tuning text is preserved byte-for-byte through P10.3 planning.
// 3. Distinct text variants (A/B/C/M1/M2) produce distinct CacheKeys.
// 4. Rate variants (C vs D) produce distinct CacheKeys under the frozen identity.
// 5. Baseline A / M1 cache identity is unaffected (matches frozen P10.8 keys).
// 6. Production P10.3 normalization behavior is unchanged (glossary + technical protection).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateCompiledLesson } from "../../compiler/src/ir.ts";
import {
  createNarrationPlan,
  type VoiceProfile,
  type VoiceProfileConfig,
} from "../src/index.ts";
import { normalizeNarrationText } from "../src/text-normalizer.ts";
// @ts-expect-error - tuning runner is ESM .mjs outside typescript root
import { TUNING_TEXTS, buildTuningProfiles } from "../../../scripts/run-p10-8-arabic-tuning-proof.mjs";
// @ts-expect-error - baseline runner is ESM .mjs outside typescript root
import { AUDITION_TEXTS, buildP108AuditionLesson } from "../../../scripts/run-p10-8-real-voice-proof.mjs";

const { shakir, shakirProsody } = buildTuningProfiles("azure");

const configFor = (target: VoiceProfile): VoiceProfileConfig => ({
  default_profile_id: target.profile_id,
  profiles: [shakir, shakirProsody],
  speaker_mappings: [{ speaker: "instructor", profile_id: target.profile_id }],
});

function planFor(text: string, profile: VoiceProfile, stepId: string) {
  const lesson = buildP108AuditionLesson({
    lessonId: "C01-L008",
    sceneId: "C01-L008-S001",
    stepId,
    text,
    language: "ar",
    speaker: "instructor",
  });
  return { lesson, plan: createNarrationPlan(lesson, configFor(profile)) };
}

const TUNING = TUNING_TEXTS as Record<string, string>;
const BASELINE = AUDITION_TEXTS as { A_ARABIC: string; B_ENGLISH: string; C_MIXED: string };

describe("P10.8 tuning fixtures: valid Compiled IR 1.0 + text preservation", () => {
  for (const [key, text] of Object.entries(TUNING)) {
    it(`${key} parses as frozen Compiled IR 1.0 and preserves authored text`, () => {
      const lesson = buildP108AuditionLesson({
        lessonId: "C01-L008",
        sceneId: "C01-L008-S001",
        stepId: `C01-L008-S001-${key.slice(0, 6)}`,
        text,
        language: "ar",
        speaker: "instructor",
      });
      const result = validateCompiledLesson(lesson);
      assert.equal(result.ok, true, JSON.stringify(result.issues));
      assert.equal(result.ir?.compiled_ir_version, "1.0");

      const { plan } = planFor(text, shakir, "C01-L008-S001-TST01");
      assert.equal(plan.total_units, 1);
      assert.equal(plan.units[0]?.unit.authored_text, text);
    });
  }
});

describe("P10.8 tuning fixtures: distinct CacheKeys where acoustically distinct", () => {
  it("A/B/C produce three distinct CacheKeys under the same VoiceProfile", () => {
    const a = planFor(BASELINE.A_ARABIC, shakir, "C01-L008-S001-TSTA01").plan.units[0]?.cache_key;
    const b = planFor(TUNING.B_SELECTIVE_TASHKEEL, shakir, "C01-L008-S001-TSTB01").plan.units[0]
      ?.cache_key;
    const c = planFor(TUNING.C_SPOKEN_PHRASING, shakir, "C01-L008-S001-TSTC01").plan.units[0]
      ?.cache_key;
    assert.ok(a && b && c);
    assert.notEqual(a, b);
    assert.notEqual(a, c);
    assert.notEqual(b, c);
  });

  it("C vs D (rate 0.95) produce distinct CacheKeys on identical text", () => {
    const c = planFor(TUNING.C_SPOKEN_PHRASING, shakir, "C01-L008-S001-TSTC02").plan.units[0]
      ?.cache_key;
    const d = planFor(TUNING.C_SPOKEN_PHRASING, shakirProsody, "C01-L008-S001-TSTD02").plan.units[0]
      ?.cache_key;
    assert.ok(c && d);
    assert.notEqual(c, d);
  });

  it("M1 vs M2 produce distinct CacheKeys", () => {
    const m1 = planFor(BASELINE.C_MIXED, shakir, "C01-L008-S001-TSTM101").plan.units[0]?.cache_key;
    const m2 = planFor(TUNING.M2_MIXED_PHRASING, shakir, "C01-L008-S001-TSTM201").plan.units[0]
      ?.cache_key;
    assert.ok(m1 && m2);
    assert.notEqual(m1, m2);
  });
});

describe("P10.8 tuning: baseline cache identity unaffected + P10.3 production unchanged", () => {
  it("baseline A cache key matches frozen P10.8 value", () => {
    const a = planFor(BASELINE.A_ARABIC, shakir, "C01-L008-S001-TSTA02").plan.units[0]?.cache_key;
    assert.equal(a, "d193d622483b1162a9c78fade3d2a26984d2da7fe0c32c87d2d07deb7efdb33b");
  });

  it("mixed baseline M1 cache key matches frozen P10.8 value", () => {
    const m1 = planFor(BASELINE.C_MIXED, shakir, "C01-L008-S001-TSTM102").plan.units[0]?.cache_key;
    assert.equal(m1, "85ffa4557313fbc6739409d5cdbdf790f355ba20073e17c18dbabe33ea5f4a1c");
  });

  it("P10.3 glossary still substitutes API/Node.js and protects technical tokens", () => {
    const r = normalizeNarrationText(BASELINE.A_ARABIC, "ar-EG");
    assert.ok(r.normalized_text.includes("إيه بي آي"));
    assert.ok(r.normalized_text.includes("نود جي إس"));
    const m = normalizeNarrationText(BASELINE.C_MIXED, "ar-EG");
    assert.ok(m.normalized_text.includes("Visual Studio Code"));
    assert.ok(m.normalized_text.includes("localhost"));
    assert.ok(m.normalized_text.includes("port 3000"));
  });
});
