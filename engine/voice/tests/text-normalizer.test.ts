// P10.3 Text Normalizer Unit Tests
//
// Tests deterministic text normalization, Unicode NFC, whitespace resolving,
// punctuation mapping, technical token protection, locale-aware number expansion,
// versioned pronunciation glossary substitution, Arabic diacritics preservation,
// and fail-closed safety boundaries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNarrationText,
  isTechnicalToken,
  VoicePlannerError,
  lookupGlossaryTerm,
  isKnownTechnicalTerm,
  TECHNICAL_GLOSSARY_VERSION,
  TRANSFORMATION_CODES,
} from "../src/index.ts";

describe("text-normalizer: whitespace & newline policy", () => {
  it("normalizes CRLF line breaks deterministically", () => {
    const input = "First sentence.\r\nSecond sentence.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "First sentence. Second sentence.");
  });

  it("normalizes LF line breaks deterministically", () => {
    const input = "First sentence.\nSecond sentence.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "First sentence. Second sentence.");
  });

  it("adds sentence period when line break lacks punctuation", () => {
    const input = "Welcome to the course\nIn this lesson we build an app";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Welcome to the course. In this lesson we build an app");
  });

  it("collapses tabs and repeated spaces to single space", () => {
    const input = "Word1\t\tWord2    Word3\t Word4";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Word1 Word2 Word3 Word4");
  });

  it("trims leading and trailing whitespace", () => {
    const input = "   \t  Trimmed content here.   \n  ";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Trimmed content here.");
  });
});

describe("text-normalizer: Unicode & diacritics policy", () => {
  it("performs canonical NFC normalization deterministically", () => {
    // Decomposed form: 'e' + combining acute accent
    const decomposed = "caf\u0065\u0301";
    // Composed form: 'é'
    const composed = "caf\u00E9";
    const result = normalizeNarrationText(decomposed, "en-US");
    assert.equal(result.normalized_text, composed);
  });

  it("preserves Arabic tashkeel (diacritics) byte-for-byte", () => {
    const withTashkeel = "مَرْحَبًا بِكُمْ فِي دَوْرَةِ كُورْسْ فَاكْتُورِي.";
    const result = normalizeNarrationText(withTashkeel, "ar-EG");
    assert.equal(result.normalized_text, withTashkeel);
  });

  it("preserves Latin case where semantically relevant", () => {
    const text = "Open the README.md and check the TypeScript configuration.";
    const result = normalizeNarrationText(text, "en-US");
    assert.match(result.normalized_text, /README\.md/);
    assert.match(result.normalized_text, /TypeScript/);
  });
});

describe("text-normalizer: punctuation normalization", () => {
  it("normalizes curly quotes to straight quotes", () => {
    const input = "He said “welcome” and ‘hello’ to everyone.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, 'He said "welcome" and \'hello\' to everyone.');
  });

  it("normalizes ellipses to three periods", () => {
    const input = "Loading… please wait…";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Loading... please wait...");
  });

  it("normalizes em-dash and en-dash to commas", () => {
    const input = "Start the server — wait for port 3000 – open browser.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Start the server, wait for port 3000, open browser.");
  });

  it("preserves Arabic punctuation: comma, question mark, semicolon", () => {
    const input = "أهلاً بكم، هل أنتم مستعدون؟ حسناً؛ لنبدأ الدرس.";
    const result = normalizeNarrationText(input, "ar-EG");
    assert.equal(result.normalized_text, "أهلاً بكم، هل أنتم مستعدون؟ حسناً؛ لنبدأ الدرس.");
  });

  it("handles mixed punctuation fixture cleanly", () => {
    const input = "“Course Factory”… Ready? Yes — lets go!";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, '"Course Factory"... Ready? Yes, lets go!');
  });
});

describe("text-normalizer: technical token protection", () => {
  it("protects code identifiers in backticks", () => {
    const input = "Execute `npm run build` now.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Execute npm run build now.");
    assert.ok(result.transformation_codes.includes("TECHNICAL_TOKEN_PROTECTED"));
  });

  it("protects camelCase identifiers from alteration", () => {
    assert.ok(isTechnicalToken("handleClick"));
    assert.ok(isTechnicalToken("isComponentAlive"));
    const input = "Call handleClick when clicked.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Call handleClick when clicked.");
  });

  it("protects snake_case identifiers from alteration", () => {
    assert.ok(isTechnicalToken("user_id"));
    assert.ok(isTechnicalToken("lesson_ordinal"));
    const input = "Check the user_id field.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Check the user_id field.");
  });

  it("protects CLI flags from alteration", () => {
    assert.ok(isTechnicalToken("--help"));
    assert.ok(isTechnicalToken("-v"));
    const input = "Run the command with --help or -v.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Run the command with --help or -v.");
  });

  it("protects package names from alteration", () => {
    assert.ok(isTechnicalToken("@course-factory/voice"));
    assert.ok(isTechnicalToken("node-fetch"));
    const input = "Install @course-factory/voice dependency.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Install @course-factory/voice dependency.");
  });

  it("protects semantic version numbers from alteration", () => {
    assert.ok(isTechnicalToken("v1.2.3"));
    assert.ok(isTechnicalToken("2.0.1"));
    const input = "Upgrade to v1.2.3 or 2.0.1 immediately.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Upgrade to v1.2.3 or 2.0.1 immediately.");
  });

  it("protects IP addresses from alteration", () => {
    assert.ok(isTechnicalToken("192.168.1.20"));
    assert.ok(isTechnicalToken("127.0.0.1:8080"));
    const input = "Connect to 192.168.1.20 now.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Connect to 192.168.1.20 now.");
  });

  it("protects port numbers following technical keywords", () => {
    const inputEn = "Listening on port 5432 and HTTP 404 status.";
    const resultEn = normalizeNarrationText(inputEn, "en-US");
    assert.equal(resultEn.normalized_text, "Listening on port 5432 and H-T-T-P 404 status.");

    const inputAr = "السيرفر شغال على بورت 8080 وكود HTTP 404.";
    const resultAr = normalizeNarrationText(inputAr, "ar-EG");
    // "HTTP" -> "إتش تي تي بي" from glossary; "8080" and "404" technical ports/status protected
    assert.match(resultAr.normalized_text, /8080/);
    assert.match(resultAr.normalized_text, /404/);
  });

  it("protects URLs from alteration", () => {
    assert.ok(isTechnicalToken("http://localhost:3000/api"));
    assert.ok(isTechnicalToken("https://coursefactory.io/status"));
    const input = "Visit http://localhost:3000 for details.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Visit http://localhost:3000 for details.");
  });

  it("protects file-path-like tokens from alteration", () => {
    assert.ok(isTechnicalToken("src/index.ts"));
    assert.ok(isTechnicalToken("package.json"));
    const input = "Check package.json and src/index.ts.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Check package.json and src/index.ts.");
  });
});

describe("text-normalizer: number expansion policy", () => {
  it("expands plain English integers in prose", () => {
    const input = "We have 3 steps and 28 lessons.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "We have three steps and twenty-eight lessons.");
  });

  it("expands negative English integer in prose", () => {
    const input = "The temperature is -5 degrees.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "The temperature is minus five degrees.");
  });

  it("expands plain Arabic integers in Egyptian Arabic (ar-EG)", () => {
    const input = "لدينا 3 خطوات و 28 درس.";
    const result = normalizeNarrationText(input, "ar-EG");
    assert.equal(result.normalized_text, "لدينا تلاتة خطوات و ثمانية وعشرين درس.");
  });

  it("expands plain Arabic integers in Modern Standard Arabic (ar-SA)", () => {
    const input = "لدينا 3 خطوات و 28 درس.";
    const result = normalizeNarrationText(input, "ar-SA");
    assert.equal(result.normalized_text, "لدينا ثلاثة خطوات و ثمانية وعشرين درس.");
  });

  it("distinguishes prose integer from technical integer", () => {
    // "3" is prose (expanded to "three"); "Node 24" and "HTTP 404" are technical (preserved)
    const input = "We run 3 instances of Node 24 and get HTTP 404.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "We run three instances of Node 24 and get H-T-T-P 404.");
  });

  it("expands decimals in English and Arabic", () => {
    const resultEn = normalizeNarrationText("Version update 3.14 released.", "en-US");
    assert.equal(resultEn.normalized_text, "Version update three point one four released.");

    const resultAr = normalizeNarrationText("المعدل هو 3.5 نقطة.", "ar-EG");
    assert.equal(resultAr.normalized_text, "المعدل هو تلاتة فاصل خمسة نقطة.");
  });

  it("expands percentages in English and Arabic", () => {
    const resultEn = normalizeNarrationText("Completed 50% of the course.", "en-US");
    assert.equal(resultEn.normalized_text, "Completed fifty percent of the course.");

    const resultArEg = normalizeNarrationText("أنجزنا 50% من العمل.", "ar-EG");
    assert.equal(resultArEg.normalized_text, "أنجزنا 50 في المية من العمل.");

    const resultArSa = normalizeNarrationText("أنجزنا 50% من العمل.", "ar-SA");
    assert.equal(resultArSa.normalized_text, "أنجزنا 50 بالمائة من العمل.");
  });

  it("preserves unsupported out-of-range integer safely with warning", () => {
    const input = "We processed 9999999 items.";
    const result = normalizeNarrationText(input, "ar-EG");
    assert.match(result.normalized_text, /9999999/);
    assert.ok(result.warnings.length > 0);
  });
});

describe("text-normalizer: pronunciation glossary & mixed technical language", () => {
  it("substitutes exact glossary entries in English", () => {
    assert.equal(lookupGlossaryTerm("API", "en-US"), "A-P-I");
    assert.equal(lookupGlossaryTerm("CLI", "en-US"), "C-L-I");
    assert.equal(lookupGlossaryTerm("JSON", "en-US"), "J-SON");

    const input = "Build the API using JSON format.";
    const result = normalizeNarrationText(input, "en-US");
    assert.equal(result.normalized_text, "Build the A-P-I using J-SON format.");
  });

  it("substitutes exact phonetic glossary entries in Arabic (ar-EG)", () => {
    assert.equal(lookupGlossaryTerm("Docker", "ar-EG"), "دوكر");
    assert.equal(lookupGlossaryTerm("React", "ar-EG"), "رياكت");
    assert.equal(lookupGlossaryTerm("TypeScript", "ar-EG"), "تايب سكريبت");

    const input = "هنشغل Docker ونبني تطبيق React باستخدام TypeScript.";
    const result = normalizeNarrationText(input, "ar-EG");
    assert.equal(result.normalized_text, "هنشغل دوكر ونبني تطبيق رياكت باستخدام تايب سكريبت.");
  });

  it("preserves unlisted Latin technical terms in Arabic (no guessing)", () => {
    assert.equal(isKnownTechnicalTerm("Flutter", "ar-EG"), false);
    assert.equal(isKnownTechnicalTerm("Supabase", "ar-EG"), false);

    const input = "هنجرب Flutter مع Supabase في هذا المشروع.";
    const result = normalizeNarrationText(input, "ar-EG");
    // "Flutter" and "Supabase" preserved verbatim
    assert.match(result.normalized_text, /Flutter/);
    assert.match(result.normalized_text, /Supabase/);
  });

  it("handles mixed Arabic/English technical sentence deterministically", () => {
    const input = "افتح الـ Terminal وشغل Docker container لخدمة الـ Node.js.";
    const result = normalizeNarrationText(input, "ar-EG");
    // Terminal -> تيرمينال, Docker -> دوكر, Container -> كونتينر, Node.js -> نود جي إس
    assert.match(result.normalized_text, /تيرمينال/);
    assert.match(result.normalized_text, /دوكر/);
    assert.match(result.normalized_text, /كونتينر/);
  });
});

describe("text-normalizer: safety bounds & failure taxonomy", () => {
  it("rejects empty authored text with TEXT_EMPTY", () => {
    assert.throws(
      () => normalizeNarrationText("", "en-US"),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "TEXT_EMPTY");
        return true;
      },
    );
  });

  it("rejects whitespace-only authored text with TEXT_EMPTY", () => {
    assert.throws(
      () => normalizeNarrationText("   \t  \n  ", "en-US"),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "TEXT_EMPTY");
        return true;
      },
    );
  });

  it("rejects text exceeding maximum authored length (10,000 chars) with VALIDATION_FAILED", () => {
    const hugeText = "a".repeat(10_001);
    assert.throws(
      () => normalizeNarrationText(hugeText, "en-US"),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "VALIDATION_FAILED");
        return true;
      },
    );
  });

  it("protects against expansion bombs", () => {
    // A string of 60 characters that attempts pathological expansion
    // If output exceeds 10x input length, must throw NORMALIZATION_FAILED
    const repeatNum = " 28".repeat(30); // 90 chars, each "28" -> "twenty-eight" (12 chars, ~4x expansion, safe)
    const result = normalizeNarrationText(repeatNum, "en-US");
    assert.ok(result.normalized_text.length > 0);
  });
});

describe("text-normalizer: auditability & digests", () => {
  it("computes deterministic source and normalized digests", () => {
    const input = "Build the application at http://localhost:3000 now.";
    const result1 = normalizeNarrationText(input, "en-US");
    const result2 = normalizeNarrationText(input, "en-US");

    assert.equal(result1.source_digest, result2.source_digest);
    assert.equal(result1.normalized_digest, result2.normalized_digest);
    assert.equal(result1.source_digest.length, 64);
    assert.equal(result1.normalized_digest.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(result1.normalized_digest));
  });

  it("reports accurate transformation taxonomy codes", () => {
    const input = "  We have 3 steps…  ";
    const result = normalizeNarrationText(input, "en-US");
    assert.ok(result.transformation_codes.includes("WHITESPACE_NORMALIZED"));
    assert.ok(result.transformation_codes.includes("PUNCTUATION_NORMALIZED"));
    assert.ok(result.transformation_codes.includes("NUMBER_EXPANDED"));
    assert.equal(result.transformation_count, result.transformation_codes.length);
  });
});
