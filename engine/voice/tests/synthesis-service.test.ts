// P10.4 Voice Synthesis Orchestration Service Test Suite
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8, 16, 18, 19, 29.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeVoiceProvider } from "../src/fake-provider.ts";
import { createNarrationPlan } from "../src/narration-planner.ts";
import type { VoiceProfile } from "../src/protocol.ts";
import { VoiceCache } from "../host/voice-cache.ts";
import { VoiceAssetNormalizer } from "../host/audio-normalizer.ts";
import { VoiceSynthesisService } from "../host/synthesis-service.ts";

const profileEn: VoiceProfile = {
  profile_id: "en-inst",
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

const profileConfig = {
  profiles: [profileEn],
  speaker_mappings: [{ speaker: "inst", profile_id: "en-inst" }],
  default_profile_id: "en-inst",
};

function makeTestPlan(narrationText: string, lessonId = "C01-L003") {
  const lesson = {
    compiled_ir_version: "1.0",
    lesson: { course_id: "C01", lesson_id: lessonId, language: "en" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        ordinal: 1,
        steps: [
          {
            kind: "narration",
            step_id: `${lessonId}-S001-B001`,
            ordinal: 1,
            derived: false,
            source_ref: { scene_id: `${lessonId}-S001`, scene_ordinal: 1, beat_id: "B001", form: "authored_beat" },
            narration: { text: narrationText, language: "en", direction: "ltr" },
          },
        ],
      },
    ],
  };
  return createNarrationPlan(lesson, profileConfig);
}

describe("synthesis-service: cache-first semantics & provider bypass", () => {
  const testDir = mkdtempSync(join(tmpdir(), "cf-synth-test-"));
  const cacheRoot = join(testDir, "voice-cache");
  const tempRoot = join(testDir, "voice-temp");

  // Instrument FakeVoiceProvider to count calls
  let providerCalls = 0;
  const fakeProvider = new FakeVoiceProvider();
  const countingProvider = {
    family: "fake",
    probeCapabilities: () => fakeProvider.probeCapabilities(),
    cancel: (id: string) => fakeProvider.cancel(id),
    synthesize: async (req: any, sig?: AbortSignal) => {
      providerCalls++;
      return fakeProvider.synthesize(req, sig);
    },
  };

  const service = new VoiceSynthesisService({
    cache: new VoiceCache({ voiceCacheRoot: cacheRoot, voiceTempRoot: tempRoot }),
    normalizer: new VoiceAssetNormalizer(),
    providerResolver: () => countingProvider as any,
  });

  it("call 1 (MISS): invokes provider once, normalizes, and publishes to cache", async () => {
    const plan = makeTestPlan("This is a cache first test sentence.");
    const unit = plan.units[0];

    assert.equal(providerCalls, 0);
    const result = await service.synthesizeUnit({
      plannedUnit: unit,
      profile: profileEn,
    });

    assert.equal(result.cache_hit, false);
    assert.equal(providerCalls, 1);
    assert.equal(result.asset.sample_rate_hz, 48000);
    assert.equal(result.asset.channels, 1);
    assert.equal(result.asset.bits_per_sample, 16);
    assert.ok(result.asset.audio_asset_digest.length === 64);
  });

  it("call 2 (HIT): bypasses provider and normalization completely, returning identical asset", async () => {
    const plan = makeTestPlan("This is a cache first test sentence.");
    const unit = plan.units[0];

    // Second call with identical content
    const result2 = await service.synthesizeUnit({
      plannedUnit: unit,
      profile: profileEn,
    });

    assert.equal(result2.cache_hit, true);
    assert.equal(providerCalls, 1, "Provider must NOT be called on cache hit (count remains 1)");

    const inspected = await service.cache.inspect(unit.cache_key);
    assert.equal(inspected.hit, true);
    if (inspected.hit) {
      assert.equal(result2.asset.audio_asset_digest, inspected.asset.audio_asset_digest);
    }
  });

  it("cleans up test directory", () => {
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe("synthesis-service: single-flight concurrency", () => {
  const testDir = mkdtempSync(join(tmpdir(), "cf-flight-test-"));
  const cacheRoot = join(testDir, "voice-cache");
  const tempRoot = join(testDir, "voice-temp");

  let flightProviderCalls = 0;
  const fakeProvider = new FakeVoiceProvider({ simulatedLatencyMs: 30 });
  const countingProvider = {
    family: "fake",
    probeCapabilities: () => fakeProvider.probeCapabilities(),
    cancel: (id: string) => fakeProvider.cancel(id),
    synthesize: async (req: any, sig?: AbortSignal) => {
      flightProviderCalls++;
      return fakeProvider.synthesize(req, sig);
    },
  };

  const service = new VoiceSynthesisService({
    cache: new VoiceCache({ voiceCacheRoot: cacheRoot, voiceTempRoot: tempRoot }),
    normalizer: new VoiceAssetNormalizer(),
    providerResolver: () => countingProvider as any,
  });

  it("deduplicates concurrent identical requests via in-process single-flight", async () => {
    const plan = makeTestPlan("Concurrent narration synthesis test.");
    const unit = plan.units[0];

    // Launch two concurrent requests for the same unit
    const [resA, resB] = await Promise.all([
      service.synthesizeUnit({ plannedUnit: unit, profile: profileEn }),
      service.synthesizeUnit({ plannedUnit: unit, profile: profileEn }),
    ]);

    // Provider should have been called exactly once
    assert.equal(flightProviderCalls, 1, "Single-flight must collapse concurrent requests to 1 provider call");
    assert.equal(resA.asset.audio_asset_digest, resB.asset.audio_asset_digest);
    assert.equal(resA.audio_bytes.length, resB.audio_bytes.length);
  });

  it("cleans up test directory", () => {
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe("synthesis-service: request_id decoupling & independent keys", () => {
  const testDir = mkdtempSync(join(tmpdir(), "cf-decouple-test-"));
  const cacheRoot = join(testDir, "voice-cache");
  const tempRoot = join(testDir, "voice-temp");

  const service = new VoiceSynthesisService({
    cache: new VoiceCache({ voiceCacheRoot: cacheRoot, voiceTempRoot: tempRoot }),
    normalizer: new VoiceAssetNormalizer(),
  });

  it("request_id does not alter synthesized audio or cache identity", async () => {
    const plan = makeTestPlan("Acoustically identical phrase.");
    const unit = plan.units[0];

    const res1 = await service.synthesizeUnit({
      plannedUnit: unit,
      profile: profileEn,
      requestId: "req-operation-alpha",
    });

    const res2 = await service.synthesizeUnit({
      plannedUnit: unit,
      profile: profileEn,
      requestId: "req-operation-beta",
    });

    assert.equal(res1.asset.cache_key, res2.asset.cache_key);
    assert.equal(res1.asset.audio_asset_digest, res2.asset.audio_asset_digest);
  });

  it("different text generates distinct cache keys and independent assets", async () => {
    const planA = makeTestPlan("Phrase Alpha.");
    const planB = makeTestPlan("Phrase Beta.");

    const resA = await service.synthesizeUnit({ plannedUnit: planA.units[0], profile: profileEn });
    const resB = await service.synthesizeUnit({ plannedUnit: planB.units[0], profile: profileEn });

    assert.notEqual(resA.asset.cache_key, resB.asset.cache_key);
    assert.notEqual(resA.asset.audio_asset_digest, resB.asset.audio_asset_digest);
  });

  it("cleans up test directory", () => {
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe("synthesis-service: cancellation and corruption recovery", () => {
  const testDir = mkdtempSync(join(tmpdir(), "cf-cancel-test-"));
  const cacheRoot = join(testDir, "voice-cache");
  const tempRoot = join(testDir, "voice-temp");

  const service = new VoiceSynthesisService({
    cache: new VoiceCache({ voiceCacheRoot: cacheRoot, voiceTempRoot: tempRoot }),
    normalizer: new VoiceAssetNormalizer(),
  });

  it("aborts immediately when signal is cancelled before start", async () => {
    const plan = makeTestPlan("Cancellation test sentence.");
    const ac = new AbortController();
    ac.abort();

    await assert.rejects(
      () =>
        service.synthesizeUnit({
          plannedUnit: plan.units[0],
          profile: profileEn,
          signal: ac.signal,
        }),
      /\[CANCELLED\]/,
    );
  });

  it("recovers from CACHE_CORRUPT by evicting and resynthesizing once", async () => {
    const plan = makeTestPlan("Recovery test sentence.");
    const unit = plan.units[0];

    // Initial synthesis
    const res1 = await service.synthesizeUnit({ plannedUnit: unit, profile: profileEn });
    assert.equal(res1.cache_hit, false);

    // Corrupt the audio.wav file on disk
    const inspected = await service.cache.inspect(unit.cache_key);
    assert.equal(inspected.hit, true);
    if (inspected.hit) {
      writeFileSync(inspected.paths.audioPath, Buffer.from("damaged bytes"));
    }

    // Second call detects corruption, evicts, and resynthesizes
    const resRecovered = await service.synthesizeUnit({ plannedUnit: unit, profile: profileEn });
    assert.equal(resRecovered.cache_hit, false);
    assert.equal(resRecovered.asset.audio_asset_digest, res1.asset.audio_asset_digest);
  });

  it("proves VoiceAsset contains zero secrets and zero absolute paths", async () => {
    const plan = makeTestPlan("Security audit sentence.");
    const res = await service.synthesizeUnit({ plannedUnit: plan.units[0], profile: profileEn });

    const serialized = JSON.stringify(res.asset);
    assert.equal(serialized.includes("apiKey"), false);
    assert.equal(serialized.includes("secret"), false);
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes("D:\\"), false);
    assert.equal(serialized.includes("C:\\"), false);
  });

  it("cleans up test directory", () => {
    rmSync(testDir, { recursive: true, force: true });
  });
});
