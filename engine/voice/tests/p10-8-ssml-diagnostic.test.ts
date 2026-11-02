// P10.8 SSML Diagnostic — Offline Regression Tests (zero network, zero provider calls)
//
// Proves for the audition-only SSML diagnostic:
// 1. SSML builders emit balanced XML with no '...' pause hacks and bounded breaks.
// 2. Shakir variants use no <lang> (unsupported on non-multilingual voices).
// 3. Multilingual builder uses ar-EG/en-US <lang> spans (+ say-as for API).
// 4. Audition cache keys are distinct per variant, 64-hex, and never production keys.
// 5. All audition profile/voice ids satisfy the frozen VoiceIdentifier shape.
// 6. Inventory safe-field projector drops everything outside the allowlist.
// 7. Inventory fetch uses injectable transport and never leaks the key in errors.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  VoiceIdentifierSchema,
  CacheKeySchema,
} from "../src/index.ts";
// @ts-expect-error - diagnostic script is ESM .mjs outside typescript root
import { escapeXml, buildS1ShakirBreaksSsml, buildS2ShakirPronunciationSsml, buildMAndrewMultilingualSsml, buildHOmniSsml, buildNNaturalScriptSsml, buildH2EnhancePronunciationSsml, buildMultilingualBody, sanitizeVoiceIdForProfile, deriveAuditionCacheKey, primaryLocaleOfShortName } from "../../../scripts/run-p10-8-ssml-diagnostic.mjs";
// @ts-expect-error - inventory script is ESM .mjs outside typescript root
import { toSafeVoiceEntry, filterInventoryCandidates, fetchVoiceListRaw } from "../../../scripts/p10-8-voice-inventory.mjs";

const VOID_TAGS = new Set(["break"]);

function assertBalancedXml(ssml: string) {
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*?)?(\/?)>/g;
  const stack: string[] = [];
  for (const m of ssml.matchAll(re)) {
    const full = m[0];
    const tag = m[1] as string;
    const selfClose = (m[3] as string) === "/" || VOID_TAGS.has(tag);
    if (full.startsWith("</")) {
      assert.equal(stack.pop(), tag, `Mismatched closing tag: ${full}`);
    } else if (!selfClose) {
      stack.push(tag);
    }
  }
  assert.equal(stack.length, 0, `Unclosed tags remain: ${JSON.stringify(stack)}`);
}

function breakTimes(ssml: string): number[] {
  return [...ssml.matchAll(/<break time="(\d+)ms"\/>/g)].map((m) => parseInt(m[1] as string, 10));
}

describe("SSML builders: well-formed XML, no punctuation hacks, bounded breaks", () => {
  const variants: Record<string, string> = {
    S1: buildS1ShakirBreaksSsml() as string,
    S2: buildS2ShakirPronunciationSsml() as string,
    M: buildMAndrewMultilingualSsml() as string,
    H: buildHOmniSsml("en-US-Andrew:DragonHDOmniLatestNeural", "en-US") as string,
    N: buildNNaturalScriptSsml() as string,
  };

  for (const [key, ssml] of Object.entries(variants)) {
    it(`${key} emits balanced XML`, () => assertBalancedXml(ssml));
    it(`${key} contains no ellipsis pause hack`, () => {
      assert.ok(!ssml.includes("..."), `${key} must not use ... for timing`);
      assert.ok(!ssml.includes("…"), `${key} must not use … for timing`);
    });
    it(`${key} break times within 80–280ms design band`, () => {
      const times = breakTimes(ssml);
      assert.ok(times.length > 0, `${key} must contain explicit <break> elements`);
      for (const t of times) {
        assert.ok(t >= 80 && t <= 280, `${key} break ${t}ms outside 80–280ms band`);
      }
    });
  }

  it("S1 breaks stay in the 100–220ms initial range", () => {
    for (const t of breakTimes(variants.S1 as string)) {
      assert.ok(t >= 100 && t <= 220, `S1 break ${t}ms outside 100–220ms`);
    }
  });

  it("escapeXml escapes markup-significant characters", () => {
    assert.equal(escapeXml('a&b<c>d"e\'f'), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("SSML builders: voice-appropriate constructs", () => {
  it("S1/S2/N (Shakir standard voice) use no <lang> element", () => {
    for (const ssml of [buildS1ShakirBreaksSsml(), buildS2ShakirPronunciationSsml(), buildNNaturalScriptSsml()] as string[]) {
      assert.ok(!ssml.includes("<lang"), "non-multilingual voice must not use <lang>");
      assert.ok(ssml.includes('name="ar-EG-ShakirNeural"'), "Shakir variants must target Shakir");
    }
  });

  it("S1 uses no pronunciation controls (clean S2 baseline)", () => {
    const s1 = buildS1ShakirBreaksSsml() as string;
    assert.ok(!s1.includes("<sub"), "S1 must not contain <sub>");
    assert.ok(!s1.includes("<say-as"), "S1 must not contain <say-as>");
    assert.ok(!s1.includes("<phoneme"), "S1 must not contain <phoneme>");
  });

  it("S2 controls API/Node.js via <sub> alias, leaves request/response native", () => {
    const s2 = buildS2ShakirPronunciationSsml() as string;
    assert.ok(s2.includes('<sub alias="إيه بي آي">API</sub>'), "S2 must alias API");
    assert.ok(s2.includes("<sub alias="), "S2 must contain sub aliases");
    assert.ok(s2.includes("request"), "S2 keeps native request token");
    assert.ok(s2.includes("response"), "S2 keeps native response token");
    assert.ok(!s2.includes("<phoneme"), "S2 must not invent IPA phonemes");
  });

  it("M uses one Andrew persona with ar-EG/en-US spans + say-as API + mixed-tech tail", () => {
    const m = buildMAndrewMultilingualSsml() as string;
    assert.ok(m.includes('name="en-US-AndrewMultilingualNeural"'), "M must target AndrewMultilingual");
    assert.ok(m.includes('xml:lang="en-US"'), "M speak default must be en-US");
    assert.ok(m.includes('<lang xml:lang="ar-EG">'), "M must wrap Arabic spans");
    assert.ok(m.includes('<lang xml:lang="en-US">'), "M must wrap English spans");
    assert.ok(m.includes('<say-as interpret-as="characters">API</say-as>'), "M must spell API via say-as");
    assert.ok(m.includes("Visual Studio Code"), "M must carry the mixed-tech tail");
    assert.ok(m.includes("localhost"), "M must carry localhost token");
  });

  it("H2 carries enhancePronunciation voice parameters only", () => {
    const h2 = buildH2EnhancePronunciationSsml("en-US-Ava:DragonHDLatestNeural", "en-US") as string;
    assert.ok(h2.includes('parameters="enhancePronunciation=true"'), "H2 must set enhancePronunciation");
  });

  it("N differs from S1 (alternate wording, same break treatment)", () => {
    const s1 = buildS1ShakirBreaksSsml() as string;
    const n = buildNNaturalScriptSsml() as string;
    assert.notEqual(s1, n);
    assert.ok((n as string).includes("هنشتغل سوا"), "N must use the alternate wording");
  });

  it("multilingual body without tail omits mixed-tech tokens", () => {
    const body = buildMultilingualBody({ includeMixedTech: false }) as string;
    assert.ok(!body.includes("Visual Studio Code"), "core-only body must omit mixed-tech tail");
  });
});

describe("Audition cache identity: distinct, well-formed, never production", () => {
  const base = {
    locale: "ar-EG",
    profileId: "audition-azure-s1-shakir-breaks",
    providerFamily: "azure",
    providerModel: "ssml-direct",
    ssmlVoiceName: "ar-EG-ShakirNeural",
    rate: 1.0,
    pitch: 0.0,
  };
  const s1 = deriveAuditionCacheKey({ ...base, variant: "S1", ssml: buildS1ShakirBreaksSsml() as string });
  const s2 = deriveAuditionCacheKey({ ...base, variant: "S2", profileId: "audition-azure-s2-shakir-pron", ssml: buildS2ShakirPronunciationSsml() as string });

  it("variant keys are 64-hex and distinct", () => {
    assert.equal(CacheKeySchema.safeParse(s1.key).success, true);
    assert.equal(CacheKeySchema.safeParse(s2.key).success, true);
    assert.notEqual(s1.key, s2.key);
  });

  it("identical inputs derive identical keys (deterministic)", () => {
    const again = deriveAuditionCacheKey({ ...base, variant: "S1", ssml: buildS1ShakirBreaksSsml() as string });
    assert.equal(again.key, s1.key);
  });

  it("all audition profile ids satisfy the frozen VoiceIdentifier shape", () => {
    for (const id of [
      "audition-azure-s1-shakir-breaks",
      "audition-azure-s2-shakir-pron",
      "audition-azure-m-andrew-multilingual",
      "audition-azure-h-omni",
      "audition-azure-h2-hd-pron",
      "audition-azure-n-natural-shakir",
    ]) {
      assert.equal(VoiceIdentifierSchema.safeParse(id).success, true, `profile id rejected: ${id}`);
    }
  });

  it("colon-bearing SSML voice names sanitize to valid VoiceIdentifier tokens", () => {
    const sanitized = sanitizeVoiceIdForProfile("en-US-Andrew:DragonHDOmniLatestNeural") as string;
    assert.equal(sanitized, "en-US-Andrew-DragonHDOmniLatestNeural");
    assert.equal(VoiceIdentifierSchema.safeParse(sanitized).success, true);
    assert.ok(!sanitized.includes(":"), "sanitized id must contain no colon");
  });

  it("primaryLocaleOfShortName derives the speak default locale", () => {
    assert.equal(primaryLocaleOfShortName("en-US-Andrew:DragonHDOmniLatestNeural"), "en-US");
    assert.equal(primaryLocaleOfShortName("ar-EG-Shakir:DragonHDOmniLatestNeural"), "ar-EG");
  });
});

describe("Inventory boundary: safe fields only, injectable transport", () => {
  it("toSafeVoiceEntry keeps allowlisted fields and drops everything else", () => {
    const entry = toSafeVoiceEntry({
      ShortName: "ar-EG-ShakirNeural",
      Locale: "ar-EG",
      Gender: "Male",
      VoiceType: "Neural",
      Status: "GA",
      StyleList: [],
      SecondaryLocaleList: ["ar-SA"],
      DisplayName: "Shakir",
      SampleRateHertz: "48000",
      WordsPerMinute: "150",
      SecretKey: "SHOULD-NEVER-PASS",
      Authorization: "Bearer SHOULD-NEVER-PASS",
      ApiKey: "SHOULD-NEVER-PASS",
    });
    assert.ok(entry);
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes("SHOULD-NEVER-PASS"), "secret-like fields must never pass the projector");
    assert.equal(entry.ShortName, "ar-EG-ShakirNeural");
  });

  it("filterInventoryCandidates buckets ar-EG / Andrew / Omni / DragonHD / MAI", () => {
    const list = [
      { ShortName: "ar-EG-ShakirNeural", Locale: "ar-EG" },
      { ShortName: "ar-EG-SalmaNeural", Locale: "ar-EG" },
      { ShortName: "en-US-AndrewMultilingualNeural", Locale: "en-US" },
      { ShortName: "en-US-Andrew:DragonHDOmniLatestNeural", Locale: "en-US" },
      { ShortName: "en-US-Ava:DragonHDLatestNeural", Locale: "en-US" },
    ];
    const buckets = filterInventoryCandidates(list);
    assert.equal(buckets.arEG.length, 2);
    assert.equal(buckets.shakir.length, 1);
    assert.equal(buckets.andrewMultilingual.length, 1);
    assert.equal(buckets.dragonHDOmni.length, 1);
    assert.equal(buckets.dragonHD.length, 1);
    assert.equal(buckets.total, 5);
  });

  it("fetchVoiceListRaw uses injected transport and never leaks the key on error", async () => {
    const fakeKey = "FAKE-KEY-ABC123";
    const failingFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => "auth failed",
    });
    await assert.rejects(
      fetchVoiceListRaw({ apiKey: fakeKey, region: "francecentral" }, failingFetch),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes(fakeKey), "error must never contain the key");
        assert.ok(err.message.includes("401"), "error must carry the HTTP status");
        return true;
      },
    );
    const okFetch = async () => ({
      ok: true,
      json: async () => [{ ShortName: "ar-EG-ShakirNeural" }],
    });
    const raw = await fetchVoiceListRaw({ apiKey: fakeKey, region: "francecentral" }, okFetch);
    assert.equal(raw.length, 1);
  });
});
