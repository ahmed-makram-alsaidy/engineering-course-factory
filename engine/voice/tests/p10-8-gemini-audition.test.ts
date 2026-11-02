// P10.8 Gemini TTS Audition Fixtures & Integration Unit Tests
// Tests the audition variant plan, style prompt construction, isolated cache keys,
// credential discovery, and WAITING_FOR_CREDENTIAL handling with zero live network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_GEMINI_TTS_MODEL,
  FALLBACK_GEMINI_TTS_MODELS,
  DEFAULT_GEMINI_VOICE_1,
  DEFAULT_GEMINI_VOICE_2,
  buildPcmWavHeader,
} from "../src/gemini-provider.ts";
import { VoiceProviderError } from "../src/provider-interface.ts";
import { VoiceCredentialStore } from "../host/credential-store.ts";
// @ts-expect-error - audition runner is ESM .mjs outside the TypeScript root
import { SCRIPT_A, SCRIPT_B, buildConversationalStylePrompt, buildStrongerEgyptianStylePrompt, deriveGeminiAuditionCacheKey, getAuditionVariantPlan, resolveGeminiCredentials, executeAuditionPlan, main as runGeminiAudition } from "../../../scripts/run-p10-8-gemini-audition.mjs";

describe("P10.8 Gemini Audition: Prompt & Variant Plan", () => {
  it("defines exactly 4 planned variants (G1, G2, G3, G4)", () => {
    const plan = getAuditionVariantPlan();
    assert.equal(plan.length, 4);

    const [g1, g2, g3, g4] = plan;

    assert.equal(g1.variant, "G1");
    assert.equal(g1.voice, DEFAULT_GEMINI_VOICE_1); // Charon
    assert.equal(g1.scriptId, "SCRIPT_A");
    assert.equal(g1.locale, "ar-EG");

    assert.equal(g2.variant, "G2");
    assert.equal(g2.voice, DEFAULT_GEMINI_VOICE_2); // Puck
    assert.equal(g2.scriptId, "SCRIPT_A");
    assert.equal(g2.locale, "ar-EG");

    assert.equal(g3.variant, "G3");
    assert.equal(g3.voice, DEFAULT_GEMINI_VOICE_1); // Charon
    assert.equal(g3.scriptId, "SCRIPT_B");
    assert.equal(g3.locale, "ar-EG");

    assert.equal(g4.variant, "G4");
    assert.equal(g4.voice, DEFAULT_GEMINI_VOICE_1);
    assert.equal(g4.scriptId, "SCRIPT_A");
    assert.equal(g4.styleType, "stronger_egyptian_instructor");
  });

  it("preserves exact authored scripts A and B", () => {
    assert.ok(SCRIPT_A.includes("أهلًا بيك"));
    assert.ok(SCRIPT_A.includes("Node.js"));
    assert.ok(SCRIPT_A.includes("request"));
    assert.ok(SCRIPT_A.includes("response"));

    assert.ok(SCRIPT_B.includes("Visual Studio Code"));
    assert.ok(SCRIPT_B.includes("npm install"));
    assert.ok(SCRIPT_B.includes("localhost"));
    assert.ok(SCRIPT_B.includes("3000"));
  });

  it("builds conversational Egyptian style prompt embedding exact instructions and transcript", () => {
    const prompt = buildConversationalStylePrompt(SCRIPT_A);
    assert.match(prompt, /Audio Profile: Young Egyptian male technical instructor/);
    assert.match(prompt, /Director's Notes:/);
    assert.match(prompt, /natural Egyptian conversational Arabic/);
    assert.match(prompt, /Pronounce English technical terms naturally/);
    assert.match(prompt, /Transcript:/);
    assert.ok(prompt.endsWith(SCRIPT_A));
  });

  it("builds stronger Egyptian instructor style prompt for G4", () => {
    const prompt = buildStrongerEgyptianStylePrompt(SCRIPT_A);
    assert.match(prompt, /Audio Profile: Young Egyptian male technical instructor/);
    assert.match(prompt, /Cairo colloquial Egyptian Arabic/);
    assert.match(prompt, /Avoid any formal Modern Standard Arabic/);
    assert.match(prompt, /Transcript:/);
    assert.ok(prompt.endsWith(SCRIPT_A));
  });
});

describe("P10.8 Gemini Audition: Cache Safety & Identity Isolation", () => {
  it("derives distinct isolated audition cache keys binding model, voice, prompt, and text", () => {
    const keyG1 = deriveGeminiAuditionCacheKey({
      variant: "G1",
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_1,
      sourceText: SCRIPT_A,
      stylePrompt: buildConversationalStylePrompt(SCRIPT_A),
    });

    const keyG2 = deriveGeminiAuditionCacheKey({
      variant: "G2",
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_2,
      sourceText: SCRIPT_A,
      stylePrompt: buildConversationalStylePrompt(SCRIPT_A),
    });

    const keyG3 = deriveGeminiAuditionCacheKey({
      variant: "G3",
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_1,
      sourceText: SCRIPT_B,
      stylePrompt: buildConversationalStylePrompt(SCRIPT_B),
    });

    assert.equal(typeof keyG1.key, "string");
    assert.equal(keyG1.key.length, 64);
    assert.match(keyG1.key, /^[0-9a-f]{64}$/);

    assert.notEqual(keyG1.key, keyG2.key);
    assert.notEqual(keyG1.key, keyG3.key);
    assert.notEqual(keyG2.key, keyG3.key);

    assert.equal(keyG1.payload.audition, "P10.8-gemini-v1");
    assert.equal(keyG1.payload.locale, "ar-EG");
  });

  it("is fully deterministic for identical audition inputs", () => {
    const key1 = deriveGeminiAuditionCacheKey({
      variant: "G1",
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_1,
      sourceText: SCRIPT_A,
      stylePrompt: buildConversationalStylePrompt(SCRIPT_A),
    });

    const key2 = deriveGeminiAuditionCacheKey({
      variant: "G1",
      model: DEFAULT_GEMINI_TTS_MODEL,
      voice: DEFAULT_GEMINI_VOICE_1,
      sourceText: SCRIPT_A,
      stylePrompt: buildConversationalStylePrompt(SCRIPT_A),
    });

    assert.equal(key1.key, key2.key);
    assert.equal(key1.sourceTextSha256, key2.sourceTextSha256);
    assert.equal(key1.stylePromptSha256, key2.stylePromptSha256);
  });
});

describe("P10.8 Gemini Audition: Safe Credential Discovery & WAITING_FOR_CREDENTIAL", () => {
  it("safely detects when credentials are missing and reports without secret leakage", async () => {
    const emptyStore = new VoiceCredentialStore({
      env: {},
      testSecrets: new Map(),
    });

    const creds = await resolveGeminiCredentials(emptyStore);
    assert.equal(creds.available, false);
    assert.equal(creds.source, null);
  });

  it("rejects obvious placeholder credentials in store and env", async () => {
    const placeholderStore = new VoiceCredentialStore({
      env: {
        GEMINI_API_KEY: "PUT_YOUR_KEY_HERE",
        GOOGLE_API_KEY: "<your-gemini-api-key>",
      },
      testSecrets: new Map([
        ["gemini", new Map([["api_key", "PUT_YOUR_KEY_HERE"]])],
      ]),
    });

    const creds = await resolveGeminiCredentials(placeholderStore);
    assert.equal(creds.available, false, "Placeholder credentials must be rejected");
    assert.equal(creds.source, null);
  });

  it("safely detects when credentials are present in store", async () => {
    const testSecrets = new Map([
      ["gemini", new Map([["api_key", "secret-val-123"]])],
    ]);
    const mockStore = new VoiceCredentialStore({
      env: {},
      testSecrets,
    });

    const creds = await resolveGeminiCredentials(mockStore);
    assert.equal(creds.available, true);
    assert.match(creds.source, /VoiceCredentialStore/);
  });

  it("executes audition runner and cleanly exits with WAITING_FOR_CREDENTIAL (exit 2) when unconfigured", async () => {
    // Run the main runner without live credentials
    // Temporarily ensure env keys are unset for test
    const origKey = process.env.GEMINI_API_KEY;
    const origGKey = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      const result = await runGeminiAudition();
      assert.equal(result.status, "WAITING_FOR_CREDENTIAL");
      assert.equal(result.exitCode, 2);

      // Verify evidence file was written safely
      const evidencePath = resolve("docs/evidence/P10/P10.8-gemini-audition.json");
      assert.ok(existsSync(evidencePath), "Evidence file must be written");

      const evidenceContent = JSON.parse(readFileSync(evidencePath, "utf8"));
      assert.equal(evidenceContent.phase, "P10.8");
      assert.equal(evidenceContent.status, "WAITING_FOR_CREDENTIAL");
      assert.equal(evidenceContent.primary_model, DEFAULT_GEMINI_TTS_MODEL);
      assert.deepEqual(evidenceContent.target_voices, [DEFAULT_GEMINI_VOICE_1, DEFAULT_GEMINI_VOICE_2]);
      assert.equal(evidenceContent.production_contract_impact, "REQUIRES DESIGN DECISION IF APPROVED");
    } finally {
      if (origKey !== undefined) process.env.GEMINI_API_KEY = origKey;
      if (origGKey !== undefined) process.env.GOOGLE_API_KEY = origGKey;
      // Clean up local evidence written during test in engine/voice to keep working tree clean
      if (existsSync("docs")) {
        rmSync("docs", { recursive: true, force: true });
      }
    }
  });
});

describe("P10.8 Gemini Audition: Execution Guards (Auth Stop & G4 Gating)", () => {
  function createSynthetic24kWav(sampleCount = 24000): Buffer {
    const buf = Buffer.alloc(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
      const val = Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / 24000));
      buf.writeInt16LE(val, i * 2);
    }
    const header = buildPcmWavHeader(sampleCount, 24000, 1, 16);
    return Buffer.concat([header, buf]);
  }

  it("STOPS immediately after the first failed live request on 401/403/API_KEY_INVALID without continuing G2/G3/G4", async () => {
    let callCount = 0;
    const calledVariants: string[] = [];

    const mockProvider = {
      synthesizeRaw: async (options: { model: string; voice: string; promptText: string }) => {
        callCount++;
        calledVariants.push(options.voice);
        throw new VoiceProviderError({
          code: "AUTH_FAILED",
          message: "Gemini authentication failed (API_KEY_INVALID): Invalid key",
          provider_identity: {
            provider_family: "gemini",
            provider_model: options.model,
            provider_voice_id: options.voice,
          },
        });
      },
    };

    const result = await executeAuditionPlan({
      provider: mockProvider as any,
      outputDir: null, // Avoid writing to disk in test
    });

    // Exactly 1 request dispatched (for G1), then immediately aborted
    assert.equal(callCount, 1, "Must make exactly 1 call before stopping on auth failure");
    assert.equal(result.realRequestCount, 1);
    assert.equal(result.fatalAuthError, true);
    assert.equal(result.sampleResults.length, 1);
    assert.equal(result.sampleResults[0].variant, "G1");
    assert.equal(result.sampleResults[0].status, "FAILED");
    assert.equal(result.sampleResults[0].error_code, "AUTH_FAILED");
  });

  it("gates G4: skips G4 when G1 fails technical synthesis", async () => {
    let callCount = 0;
    const dispatched: string[] = [];

    const mockWav = createSynthetic24kWav(24000);

    const mockProvider = {
      synthesizeRaw: async (options: { model: string; voice: string; promptText: string }) => {
        callCount++;
        dispatched.push(options.voice);
        if (callCount === 1) {
          // G1 fails with a non-auth error (e.g. transient 500)
          throw new VoiceProviderError({
            code: "PROVIDER_UNAVAILABLE",
            message: "Temporary server error",
            provider_identity: {
              provider_family: "gemini",
              provider_model: options.model,
              provider_voice_id: options.voice,
            },
          });
        }
        // G2 and G3 succeed
        return {
          rawPcm: mockWav.subarray(44),
          sourceSampleRate: 24000,
          wavBuffer: mockWav,
          model: options.model,
          voice: options.voice,
          mimeType: "audio/pcm;rate=24000",
        };
      },
    };

    const result = await executeAuditionPlan({
      provider: mockProvider as any,
      outputDir: null,
    });

    // G1 failed, G2 succeeded, G3 succeeded, G4 was skipped by gate
    assert.equal(result.sampleResults.length, 4);
    const g4Result = result.sampleResults.find((r: any) => r.variant === "G4");
    assert.ok(g4Result);
    assert.equal(g4Result.status, "NOT GENERATED");
    assert.equal(g4Result.canonical_validation, "SKIPPED");
    assert.match(g4Result.reason, /Gated on G1 and G2/);

    // G4 synthesizeRaw was never called! Only G1, G2, G3 were called = 3 calls
    assert.equal(callCount, 3);
  });

  it("gates G4: executes G4 when G1 and G2 both complete technical synthesis successfully", async () => {
    let callCount = 0;
    const dispatchedVariants: string[] = [];

    const mockWav = createSynthetic24kWav(24000);

    const mockProvider = {
      synthesizeRaw: async (options: { model: string; voice: string; promptText: string }) => {
        callCount++;
        dispatchedVariants.push(options.voice);
        return {
          rawPcm: mockWav.subarray(44),
          sourceSampleRate: 24000,
          wavBuffer: mockWav,
          model: options.model,
          voice: options.voice,
          mimeType: "audio/pcm;rate=24000",
        };
      },
    };

    const result = await executeAuditionPlan({
      provider: mockProvider as any,
      outputDir: null,
    });

    // All 4 variants should have succeeded
    assert.equal(callCount, 4);
    assert.equal(result.sampleResults.length, 4);
    for (const sample of result.sampleResults) {
      assert.equal(sample.canonical_validation, "PASS");
    }
    const g4Result = result.sampleResults.find((r: any) => r.variant === "G4");
    assert.ok(g4Result);
    assert.equal(g4Result.canonical_validation, "PASS");
  });
});
