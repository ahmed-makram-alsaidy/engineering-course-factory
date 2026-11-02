// P10.8 exact-silence diagnostic -- offline regression tests (zero network).
// Locks the two-sample audition structure without changing production behavior.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeWavPcm16Mono48k } from "../src/wav.ts";
// @ts-expect-error - audition runner is ESM .mjs outside the TypeScript root
import { buildX1ShakirExactSilenceSsml, buildX2OmniMinimalBoundariesSsml, deriveExactSilenceCacheKey, EXACT_SCRIPT_SENTENCES, measureInternalSilences } from "../../../scripts/run-p10-8-exact-silence.mjs";

describe("P10.8 exact-silence SSML", () => {
  it("X1 gives Shakir exact sentence and comma silence without boundary stacking", () => {
    const ssml = buildX1ShakirExactSilenceSsml() as string;

    assert.match(ssml, /xmlns:mstts="http:\/\/www\.w3\.org\/2001\/mstts"/);
    assert.match(ssml, /type="Sentenceboundary-exact" value="180ms"/);
    assert.match(ssml, /type="Comma-exact" value="70ms"/);
    assert.match(ssml, /type="Leading-exact" value="80ms"/);
    assert.match(ssml, /type="Tailing-exact" value="100ms"/);
    assert.match(ssml, /<sub alias="[^"]+">API<\/sub>/);
    assert.match(ssml, /<sub alias="[^"]+">Node\.js<\/sub>/);
    assert.match(ssml, /request/);
    assert.match(ssml, /response/);
    assert.ok(!ssml.includes("<s>"), "X1 must not use sentence elements");
    assert.ok(!ssml.includes("</s>"), "X1 must not use sentence elements");
    assert.ok(!ssml.includes("<break"), "X1 must not combine breaks with sentence punctuation");
    assert.ok(!ssml.includes("...") && !ssml.includes("…"), "X1 must not use ellipses");
  });

  it("X2 uses only verified Omni boundary structure", () => {
    const ssml = buildX2OmniMinimalBoundariesSsml() as string;

    assert.match(ssml, /en-US-Andrew:DragonHDOmniLatestNeural/);
    assert.match(ssml, /<lang xml:lang="ar-EG">/);
    assert.match(ssml, /<lang xml:lang="en-US">/);
    assert.ok(!ssml.includes("mstts:silence"), "Omni does not support mstts:silence");
    assert.ok(!ssml.includes("<break"), "Omni does not support break");
    assert.ok(!ssml.includes("<s>"), "X2 must not use sentence elements");
    assert.ok(!ssml.includes("<p>"), "X2 must not use paragraph elements");
    assert.ok(!ssml.includes("...") && !ssml.includes("…"), "X2 must not use ellipses");
  });

  it("preserves the specified natural Egyptian script", () => {
    assert.deepEqual(EXACT_SCRIPT_SENTENCES, [
      "أهلًا بيك.",
      "النهارده هنشتغل سوا على API بسيطة بـ Node.js.",
      "هنبدأ نعمل request، وبعدها نشوف الـ response.",
      "واحدة واحدة.",
    ]);
  });

  it("uses isolated SSML-SHA256-bound audition identities", () => {
    const x1 = buildX1ShakirExactSilenceSsml() as string;
    const x2 = buildX2OmniMinimalBoundariesSsml() as string;
    const first = deriveExactSilenceCacheKey({
      variant: "X1",
      ssml: x1,
      locale: "ar-EG",
      profileId: "audition-azure-x1-shakir-exact",
      providerFamily: "azure",
      providerModel: "ssml-direct",
      ssmlVoiceName: "ar-EG-ShakirNeural",
      rate: 1,
      pitch: 0,
    });
    const second = deriveExactSilenceCacheKey({
      variant: "X2",
      ssml: x2,
      locale: "en-US",
      profileId: "audition-azure-x2-omni-minimal",
      providerFamily: "azure",
      providerModel: "ssml-direct",
      ssmlVoiceName: "en-US-Andrew:DragonHDOmniLatestNeural",
      rate: 1,
      pitch: 0,
    });

    assert.match(first.key, /^[0-9a-f]{64}$/);
    assert.match(second.key, /^[0-9a-f]{64}$/);
    assert.match(first.ssmlSha256, /^[0-9a-f]{64}$/);
    assert.match(second.ssmlSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(first.key, second.key);
  });
});

describe("P10.8 exact-silence measurement", () => {
  it("excludes leading and trailing silence while measuring an internal gap", () => {
    const samples = new Int16Array(48_000);
    // 100ms lead, 200ms speech, 180ms internal gap, 300ms speech, 220ms tail.
    samples.fill(1_000, 4_800, 14_400);
    samples.fill(1_000, 23_040, 37_440);

    const measurement = measureInternalSilences(encodeWavPcm16Mono48k(samples));
    assert.deepEqual(measurement, {
      count: 1,
      median_ms: 180,
      max_ms: 180,
      gt500_count: 0,
      all_ms: [180],
    });
  });
});
