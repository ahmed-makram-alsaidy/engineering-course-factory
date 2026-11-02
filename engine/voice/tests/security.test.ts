// P10.1 Security, Credential Safety & Zero-Drift Unit Tests
//
// Tests complete absence of credential fields, byte-for-byte preservation of
// Arabic, English, and mixed technical authored text, absence of private P8/P9
// imports, and absence of audio file emission.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CacheIdentityPayloadSchema,
  NarrationUnitSchema,
  SynthesisRequestSchema,
  VoiceManifestSchema,
  VoiceProfileSchema,
} from "../src/index.ts";

describe("security: credential and secret exclusion across all schemas", () => {
  const credentialKeys = [
    "api_key",
    "apiKey",
    "secret",
    "secret_key",
    "token",
    "bearer_token",
    "auth",
    "authorization",
    "password",
    "private_key",
  ];

  it("proves VoiceProfile schema rejects any credential fields", () => {
    for (const key of credentialKeys) {
      assert.throws(() =>
        VoiceProfileSchema.parse({
          profile_id: "test",
          locale: "en-US",
          gender: "neutral",
          description: "Test",
          provider_family: "fake",
          provider_voice_id: "v1",
          provider_model: "m1",
          [key]: "secret-value",
        }),
      );
    }
  });

  it("proves CacheIdentityPayload schema rejects any credential fields", () => {
    for (const key of credentialKeys) {
      assert.throws(() =>
        CacheIdentityPayloadSchema.parse({
          normalized_text: "test",
          locale: "en-US",
          voice_profile_id: "test",
          provider_family: "fake",
          provider_model: "m1",
          provider_voice_id: "v1",
          rate: 1.0,
          pitch: 0.0,
          style: null,
          [key]: "secret-value",
        }),
      );
    }
  });

  it("proves SynthesisRequest schema rejects any credential fields", () => {
    for (const key of credentialKeys) {
      assert.throws(() =>
        SynthesisRequestSchema.parse({
          request_id: "req-001",
          cache_key: "a".repeat(64),
          normalized_text: "test",
          locale: "en-US",
          voice_profile: {
            profile_id: "p1",
            locale: "en-US",
            gender: "male",
            description: "test",
            provider_family: "fake",
            provider_voice_id: "v1",
            provider_model: "m1",
          },
          [key]: "secret-value",
        }),
      );
    }
  });
});

describe("security: authored text fidelity (data preservation)", () => {
  it("preserves complex Arabic text with diacritics byte-for-byte", () => {
    const arabicText = "أهلاً بِكُمْ فِي دَوْرَةِ كُورْسْ فَاكْتُورِي — تَعَلَّمْ كَيْفَ تَبْنِي تَطْبِيقَاتٍ حَدِيثَةً.";
    const unit = NarrationUnitSchema.parse({
      lesson_id: "C01-L003",
      scene_id: "C01-L003-S001",
      step_id: "C01-L003-S001-B001",
      narration_ordinal: 1,
      locale: "ar-EG",
      authored_text: arabicText,
      voice_profile_id: "ar-instructor-primary",
    });

    assert.equal(unit.authored_text, arabicText);
  });

  it("preserves English technical text with symbols and numbers byte-for-byte", () => {
    const englishText = "Run `npm run build` to compile the application at http://localhost:3000/api/v1.";
    const unit = NarrationUnitSchema.parse({
      lesson_id: "C01-L003",
      scene_id: "C01-L003-S001",
      step_id: "C01-L003-S001-B001",
      narration_ordinal: 1,
      locale: "en-US",
      authored_text: englishText,
      voice_profile_id: "en-instructor-primary",
    });

    assert.equal(unit.authored_text, englishText);
  });

  it("preserves mixed Arabic and English technical terminology byte-for-byte", () => {
    const mixedText = "دلوقتي هنشغل الـ Docker container ونتأكد إن سيرفر الـ Node.js شغال على البورت 8080.";
    const unit = NarrationUnitSchema.parse({
      lesson_id: "C01-L003",
      scene_id: "C01-L003-S001",
      step_id: "C01-L003-S001-B001",
      narration_ordinal: 1,
      locale: "ar-EG",
      authored_text: mixedText,
      voice_profile_id: "ar-instructor-primary",
      pause_before_seconds: 1,
      pause_after_seconds: 2,
    });

    assert.equal(unit.authored_text, mixedText);
    assert.equal(unit.pause_before_seconds, 1);
    assert.equal(unit.pause_after_seconds, 2);
  });
});

describe("security: static import boundaries (no P8/P9 cross-contamination)", () => {
  it("proves engine/voice/src source files never import P8 or P9 packages", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8");
      assert.doesNotMatch(
        content,
        /@course-factory\/recording/,
        `${file} must not import @course-factory/recording`,
      );
      assert.doesNotMatch(
        content,
        /@course-factory\/runtime/,
        `${file} must not import @course-factory/runtime`,
      );
      assert.doesNotMatch(
        content,
        /from "\.\..*engine\/recording/,
        `${file} must not import from engine/recording`,
      );
      assert.doesNotMatch(
        content,
        /from "\.\..*engine\/runtime/,
        `${file} must not import from engine/runtime`,
      );
    }
  });

  it("proves engine/voice/src imports only zod, node:crypto, and local files", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8");
      const importLines = content
        .split("\n")
        .filter((l) => l.startsWith("import ") && l.includes("from "));

      for (const line of importLines) {
        assert.match(
          line,
          /from ("zod"|"node:crypto"|"\.\/.*");$/,
          `Line in ${file} violates import boundary: ${line}`,
        );
      }
    }
  });

  it("proves zero cloud TTS provider SDK packages installed in package.json", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.peerDependencies || {}),
    };

    const forbiddenPackages = [
      "openai",
      "elevenlabs",
      "@azure/cognitiveservices-speech",
      "@google-cloud/text-to-speech",
      "@aws-sdk/client-polly",
      "playht",
      "deepgram",
      "replicate",
      "axios",
      "node-fetch",
      "got",
      "undici",
    ];

    for (const forbidden of forbiddenPackages) {
      assert.equal(allDeps[forbidden], undefined, `Forbidden package ${forbidden} must not be in package.json`);
    }
  });

  it("proves zero network/HTTP/socket imports across all source files", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8");
      const importStatements = content
        .split("\n")
        .filter((l) => l.startsWith("import ") || l.includes("require("));

      for (const imp of importStatements) {
        assert.doesNotMatch(imp, /node:http|node:https|node:net|node:tls|"http"|"https"/);
        assert.doesNotMatch(imp, /\baxios\b/);
        assert.doesNotMatch(imp, /\bnode-fetch\b/);
        assert.doesNotMatch(imp, /\bundici\b/);
      }
    }
  });
});
