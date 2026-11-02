// P10.8 single-flow speech-writing diagnostic -- offline, zero-network tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeWavPcm16Mono48k } from "../src/wav.ts";
// @ts-expect-error - audition runner is ESM .mjs outside the TypeScript root
import { buildY1ShakirSingleFlowSsml, buildY2ShakirSpokenEgyptianSsml, buildY3OmniSingleFlowSsml, classifyQuietSegments, analyzeRhythm, deriveSingleFlowCacheKey, OMNI_PARAMETERS, Y1_SOURCE_TEXT, Y2_SOURCE_TEXT, Y3_SOURCE_TEXT } from "../../../scripts/run-p10-8-single-flow-diagnostic.mjs";

function assertSingleFlow(ssml: string) {
  assert.ok(!ssml.includes("<s>"), "must not use sentence elements");
  assert.ok(!ssml.includes("</s>"), "must not use sentence elements");
  assert.ok(!ssml.includes("<p>"), "must not use paragraph elements");
  assert.ok(!ssml.includes("</p>"), "must not use paragraph elements");
  assert.ok(!ssml.includes("<break"), "must not use break tags");
  assert.ok(!ssml.includes("Sentenceboundary-exact"), "must not use sentence-boundary timing");
  assert.ok(!ssml.includes("...") && !ssml.includes("…"), "must not use ellipses");
}

function spokenSurface(ssml: string) {
  return ssml.replace(/<[^>]+>/g, "");
}

describe("P10.8 single-flow SSML", () => {
  it("Y1 uses Shakir comma-exact timing in one spoken flow", () => {
    const ssml = buildY1ShakirSingleFlowSsml() as string;
    assertSingleFlow(ssml);
    assert.match(ssml, /ar-EG-ShakirNeural/);
    assert.match(ssml, /<mstts:silence type="Comma-exact" value="80ms"\/>/);
    assert.match(ssml, /<sub alias="[^"]+">API<\/sub>/);
    assert.match(ssml, /<sub alias="[^"]+">Node\.js<\/sub>/);
    assert.equal((spokenSurface(ssml).match(/\./g) ?? []).length, 2, "only Node.js and the terminal period may contain dots");
  });

  it("Y2 preserves the alternate spoken Egyptian wording with identical timing policy", () => {
    const ssml = buildY2ShakirSpokenEgyptianSsml() as string;
    assertSingleFlow(ssml);
    assert.match(ssml, /Comma-exact" value="80ms"/);
    assert.match(ssml, /بص النهارده/);
    assert.match(ssml, /هنفهم الدنيا واحدة واحدة\./);
    assert.equal((spokenSurface(ssml).match(/\./g) ?? []).length, 2, "only Node.js and the terminal period may contain dots");
  });

  it("Y3 uses only supported Omni controls and grouped language spans", () => {
    const ssml = buildY3OmniSingleFlowSsml() as string;
    assertSingleFlow(ssml);
    assert.ok(!ssml.includes("mstts:silence"), "Omni must not receive unsupported silence tags");
    assert.match(ssml, /en-US-Andrew:DragonHDOmniLatestNeural/);
    assert.match(ssml, new RegExp(`parameters="${OMNI_PARAMETERS}"`));
    assert.match(ssml, /<mstts:express-as style="calm" styledegree="0\.5">/);
    assert.equal((ssml.match(/<lang xml:lang="ar-EG">/g) ?? []).length, 1, "Arabic remains one outer flow span");
    assert.equal((ssml.match(/<lang xml:lang="en-US">/g) ?? []).length, 4, "only four necessary technical terms switch language");
    assert.equal((spokenSurface(ssml).match(/\./g) ?? []).length, 2, "only Node.js and the terminal period may contain dots");
  });

  it("uses the specified spoken source scripts", () => {
    assert.match(Y1_SOURCE_TEXT, /^أهلًا بيك، النهارده هنشتغل سوا/);
    assert.match(Y2_SOURCE_TEXT, /^أهلًا بيك، بص النهارده هنشتغل سوا/);
    assert.match(Y3_SOURCE_TEXT, /^أهلًا بيك، النهارده هنشتغل سوا/);
    for (const source of [Y1_SOURCE_TEXT, Y2_SOURCE_TEXT, Y3_SOURCE_TEXT]) {
      assert.equal((source.match(/\./g) ?? []).length, 2, "source has Node.js and one terminal period only");
    }
  });

  it("derives distinct isolated identities when SSML or parameters change", () => {
    const y1 = buildY1ShakirSingleFlowSsml() as string;
    const y2 = buildY2ShakirSpokenEgyptianSsml() as string;
    const base = {
      variant: "Y1",
      ssml: y1,
      sourceText: Y1_SOURCE_TEXT,
      parameters: { comma_exact_ms: 80 },
      locale: "ar-EG",
      profileId: "audition-azure-y1-shakir-single-flow",
      providerFamily: "azure",
      providerModel: "ssml-direct",
      ssmlVoiceName: "ar-EG-ShakirNeural",
    };
    const first = deriveSingleFlowCacheKey(base);
    const changedText = deriveSingleFlowCacheKey({ ...base, variant: "Y2", ssml: y2, sourceText: Y2_SOURCE_TEXT });
    const changedParameters = deriveSingleFlowCacheKey({ ...base, parameters: { comma_exact_ms: 70 } });

    assert.match(first.key, /^[0-9a-f]{64}$/);
    assert.match(first.ssmlSha256, /^[0-9a-f]{64}$/);
    assert.match(first.sourceTextSha256, /^[0-9a-f]{64}$/);
    assert.match(first.parametersSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(first.key, changedText.key);
    assert.notEqual(first.key, changedParameters.key);
  });
});

describe("P10.8 single-flow rhythm measurement", () => {
  it("separates leading, internal, and trailing quiet segments", () => {
    const samples = new Int16Array(48_000);
    // 100ms lead, 200ms speech, 350ms internal pause, 200ms speech, 150ms tail.
    samples.fill(1_000, 4_800, 14_400);
    samples.fill(1_000, 31_200, 40_800);
    const audio = encodeWavPcm16Mono48k(samples);
    const segments = classifyQuietSegments(audio);
    assert.deepEqual(segments.leading_segments.map((segment: { duration_ms: number }) => segment.duration_ms), [100]);
    assert.deepEqual(segments.internal_segments.map((segment: { duration_ms: number }) => segment.duration_ms), [350]);
    assert.deepEqual(segments.trailing_segments.map((segment: { duration_ms: number }) => segment.duration_ms), [150]);

    const rhythm = analyzeRhythm(audio, "<speak><voice>one two three four</voice></speak>");
    assert.equal(rhythm.total_duration_seconds, 1);
    assert.equal(rhythm.words_per_minute_estimate, 240);
    assert.equal(rhythm.internal_gt300ms_count, 1);
    assert.equal(rhythm.internal_gt500ms_count, 0);
  });
});
