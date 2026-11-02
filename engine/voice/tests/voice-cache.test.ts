// P10.4 Content-Addressed Immutable Voice Cache Test Suite
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 18, 19, 20.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWavPcm16Mono48k } from "../src/wav.ts";
import { sha256Hex } from "../src/canonical.ts";
import type { NormalizedAlignment, VoiceAssetMetadata } from "../src/protocol.ts";
import { VoiceCache } from "../host/voice-cache.ts";

function createToneSamples(sampleCount: number, amplitude = 6000, freq = 440): Int16Array {
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / 48000));
  }
  return samples;
}

function makeTestFixture(cacheKey: string) {
  const samples = createToneSamples(48000);
  const audioBytes = encodeWavPcm16Mono48k(samples);
  const digest = sha256Hex(audioBytes);

  const metadata: VoiceAssetMetadata = {
    voice_unit_id: "vu-C01-L003-B001-001",
    cache_key: cacheKey,
    audio_asset_digest: digest,
    sample_rate_hz: 48000,
    channels: 1,
    bits_per_sample: 16,
    sample_format: "pcm_s16le",
    sample_count: 48000,
    duration_us: 1000000,
    provider_family: "fake",
    provider_model: "deterministic-v1",
    provider_voice_id: "boston-01",
    text_normalization_version: "1.0",
    audio_normalization_version: "1.0",
    voice_contract_version: "1.0",
    alignment_status: "word",
  };

  const alignment: NormalizedAlignment = {
    status: "word",
    words: [
      { ordinal: 1, word: "hello", start_sample: 0, end_sample: 24000 },
      { ordinal: 2, word: "world", start_sample: 24000, end_sample: 48000 },
    ],
    phonemes: [],
  };

  return { audioBytes, metadata, alignment, digest };
}

describe("voice-cache: cache-first inspection and atomic publication", () => {
  const testDir = mkdtempSync(join(tmpdir(), "cf-cache-test-"));
  const cacheRoot = join(testDir, "voice-cache");
  const tempRoot = join(testDir, "voice-temp");
  const cache = new VoiceCache({ voiceCacheRoot: cacheRoot, voiceTempRoot: tempRoot });
  const key1 = "1111111111111111111111111111111111111111111111111111111111111111";

  it("returns MISS for nonexistent cache entry", async () => {
    const inspected = await cache.inspect(key1);
    assert.equal(inspected.hit, false);
    if (!inspected.hit) {
      assert.equal(inspected.reason, "MISS");
    }
  });

  it("atomically publishes asset and sidecars", async () => {
    const fixture = makeTestFixture(key1);
    const published = await cache.publish(key1, fixture.metadata, fixture.audioBytes, fixture.alignment);
    assert.equal(published.cache_key, key1);
    assert.equal(published.audio_asset_digest, fixture.digest);

    // Immediate inspect returns HIT
    const inspected = await cache.inspect(key1);
    assert.equal(inspected.hit, true);
    if (inspected.hit) {
      assert.equal(inspected.asset.audio_asset_digest, fixture.digest);
      assert.equal(inspected.audioBytes.length, fixture.audioBytes.length);
      assert.equal(inspected.alignment.status, "word");
      assert.equal(inspected.alignment.words.length, 2);
    }
  });

  it("enforces immutability: existing valid asset is never overwritten", async () => {
    const fixture = makeTestFixture(key1);
    // Attempt to publish different metadata for the same key
    const differentMetadata: VoiceAssetMetadata = {
      ...fixture.metadata,
      provider_voice_id: "different-voice",
    };

    const result = await cache.publish(key1, differentMetadata, fixture.audioBytes, fixture.alignment);
    // Should preserve original asset
    assert.equal(result.provider_voice_id, "boston-01");

    const inspectAfter = await cache.inspect(key1);
    assert.equal(inspectAfter.hit, true);
    if (inspectAfter.hit) {
      assert.equal(inspectAfter.asset.provider_voice_id, "boston-01");
    }
  });

  it("cleans up test directory", () => {
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe("voice-cache: corruption detection and bounded recovery", () => {
  const testDir = mkdtempSync(join(tmpdir(), "cf-corrupt-test-"));
  const cacheRoot = join(testDir, "voice-cache");
  const tempRoot = join(testDir, "voice-temp");
  const cache = new VoiceCache({ voiceCacheRoot: cacheRoot, voiceTempRoot: tempRoot });
  const key2 = "2222222222222222222222222222222222222222222222222222222222222222";

  it("detects audio byte digest mismatch as CORRUPT", async () => {
    const fixture = makeTestFixture(key2);
    await cache.publish(key2, fixture.metadata, fixture.audioBytes, fixture.alignment);

    const inspect1 = await cache.inspect(key2);
    assert.equal(inspect1.hit, true);
    if (!inspect1.hit) return;

    // Tamper with audio.wav
    writeFileSync(inspect1.paths.audioPath, Buffer.from("corrupted audio bytes"));

    const inspectTampered = await cache.inspect(key2);
    assert.equal(inspectTampered.hit, false);
    if (!inspectTampered.hit) {
      assert.equal(inspectTampered.reason, "CORRUPT");
    }
  });

  it("evicts corrupted cache entry without touching other entries", async () => {
    const keyOther = "3333333333333333333333333333333333333333333333333333333333333333";
    const fixtureOther = makeTestFixture(keyOther);
    await cache.publish(keyOther, fixtureOther.metadata, fixtureOther.audioBytes, fixtureOther.alignment);

    // Evict corrupted key2
    await cache.evict(key2);

    // key2 is now MISS
    const checkKey2 = await cache.inspect(key2);
    assert.equal(checkKey2.hit, false);
    if (!checkKey2.hit) {
      assert.equal(checkKey2.reason, "MISS");
    }

    // keyOther remains fully intact and valid
    const checkOther = await cache.inspect(keyOther);
    assert.equal(checkOther.hit, true);
  });

  it("detects partial entries (e.g. metadata present, audio absent) as CORRUPT", async () => {
    const keyPartial = "4444444444444444444444444444444444444444444444444444444444444444";
    const fixture = makeTestFixture(keyPartial);
    await cache.publish(keyPartial, fixture.metadata, fixture.audioBytes, fixture.alignment);

    const inspected = await cache.inspect(keyPartial);
    assert.equal(inspected.hit, true);
    if (!inspected.hit) return;

    // Delete audio.wav to create partial entry
    rmSync(inspected.paths.audioPath);

    const inspectPartial = await cache.inspect(keyPartial);
    assert.equal(inspectPartial.hit, false);
    if (!inspectPartial.hit) {
      assert.equal(inspectPartial.reason, "CORRUPT");
    }
  });

  it("cleans up test directory", () => {
    rmSync(testDir, { recursive: true, force: true });
  });
});
