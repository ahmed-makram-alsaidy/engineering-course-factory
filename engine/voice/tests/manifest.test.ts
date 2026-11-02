// P10.1 Voice Manifest 1.0 Unit Tests
//
// Tests VoiceManifest schema, canonical builder, strict parser, round-trip,
// audio summary invariants, cue table verification, size bounds, and path safety.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type BuildVoiceManifestInput,
  type VoiceManifest,
  type VoiceManifestCue,
  VoiceManifestSchema,
  buildVoiceManifest,
  parseVoiceManifest,
  serializeVoiceManifest,
} from "../src/manifest.ts";
import { durationUsForSampleCount } from "../src/audio-clock.ts";

describe("manifest: canonical VoiceManifest 1.0 construction & validation", () => {
  const sampleCountCue1 = 96_000; // 2.0 s = 2,000,000 us
  const sampleCountCue2 = 144_000; // 3.0 s = 3,000,000 us

  const cue1: VoiceManifestCue = {
    step_id: "C01-L003-S001-B001",
    scene_id: "C01-L003-S001",
    ordinal: 1,
    voice_unit_id: "vu-C01-L003-S001-B001-001",
    cache_key: "1".repeat(64),
    audio_asset_digest: "a".repeat(64),
    sample_count: sampleCountCue1,
    duration_us: durationUsForSampleCount(sampleCountCue1),
    alignment_status: "word",
    alignment_ref: "cues/C01-L003-S001-B001.alignment.json",
    pause_before_seconds: 0,
    pause_after_seconds: 1,
    sync_state: "unbound",
  };

  const cue2: VoiceManifestCue = {
    step_id: "C01-L003-S001-B002",
    scene_id: "C01-L003-S001",
    ordinal: 2,
    voice_unit_id: "vu-C01-L003-S001-B002-002",
    cache_key: "2".repeat(64),
    audio_asset_digest: "b".repeat(64),
    sample_count: sampleCountCue2,
    duration_us: durationUsForSampleCount(sampleCountCue2),
    alignment_status: "none",
    pause_before_seconds: 0,
    pause_after_seconds: 0,
    sync_state: "unbound",
  };

  const manifestInput: BuildVoiceManifestInput = {
    lesson_id: "C01-L003",
    course_id: "C01",
    compiled_digest: "c".repeat(64),
    voice_profile_id: "ar-instructor-primary",
    locale: "ar-EG",
    provider_family: "fake",
    provider_model: "synthetic-v1",
    cues: [cue1, cue2],
  };

  it("builds a canonical VoiceManifest 1.0 with exact summary fields", () => {
    const manifest = buildVoiceManifest(manifestInput);

    assert.equal(manifest.manifest_version, "1.0");
    assert.equal(manifest.protocol_version, "v1");
    assert.equal(manifest.lesson_id, "C01-L003");
    assert.equal(manifest.audio.cue_count, 2);
    assert.equal(manifest.audio.total_samples, 240_000);
    assert.equal(manifest.audio.total_duration_us, 5_000_000);
    assert.equal(manifest.cues.length, 2);
  });

  it("serializes and parses round-trip with deep equality", () => {
    const manifest = buildVoiceManifest(manifestInput);
    const serialized = serializeVoiceManifest(manifest);
    const parsed = parseVoiceManifest(serialized);

    assert.deepEqual(parsed, manifest);
  });

  it("builder is deterministic across multiple calls", () => {
    const manifest1 = buildVoiceManifest(manifestInput);
    const manifest2 = buildVoiceManifest(manifestInput);

    assert.equal(serializeVoiceManifest(manifest1), serializeVoiceManifest(manifest2));
  });
});

describe("manifest: strict validation & publication invariants", () => {
  const sampleCount = 96_000;
  const durationUs = 2_000_000;

  const validCue: VoiceManifestCue = {
    step_id: "C01-L003-S001-B001",
    scene_id: "C01-L003-S001",
    ordinal: 1,
    voice_unit_id: "vu-C01-L003-S001-B001-001",
    cache_key: "1".repeat(64),
    audio_asset_digest: "a".repeat(64),
    sample_count: sampleCount,
    duration_us: durationUs,
    alignment_status: "none",
    sync_state: "unbound",
  };

  const baseManifest: VoiceManifest = {
    manifest_version: "1.0",
    protocol_version: "v1",
    lesson_id: "C01-L003",
    course_id: "C01",
    compiled_digest: "c".repeat(64),
    voice_profile_id: "ar-instructor-primary",
    locale: "ar-EG",
    provider_family: "fake",
    provider_model: "synthetic-v1",
    audio: {
      format: "wav",
      sample_rate_hz: 48_000,
      channels: 1,
      sample_format: "pcm_s16le",
      total_samples: sampleCount,
      total_duration_us: durationUs,
      cue_count: 1,
    },
    cues: [validCue],
  };

  it("rejects unknown or unexpected top-level fields (strictObject)", () => {
    const hostile = { ...baseManifest, unexpected_field: "injected" };
    assert.throws(() => VoiceManifestSchema.parse(hostile));
  });

  it("rejects wrong manifest or protocol versions", () => {
    assert.throws(() => VoiceManifestSchema.parse({ ...baseManifest, manifest_version: "2.0" }));
    assert.throws(() => VoiceManifestSchema.parse({ ...baseManifest, protocol_version: "v2" }));
  });

  it("rejects when audio.cue_count does not match cues array length", () => {
    assert.throws(
      () =>
        VoiceManifestSchema.parse({
          ...baseManifest,
          audio: { ...baseManifest.audio, cue_count: 5 },
        }),
      /\[CUE_COUNT_MISMATCH\]/,
    );
  });

  it("rejects when audio.total_samples does not match cue sample sum", () => {
    assert.throws(
      () =>
        VoiceManifestSchema.parse({
          ...baseManifest,
          audio: { ...baseManifest.audio, total_samples: sampleCount + 100 },
        }),
      /\[TOTAL_SAMPLES_MISMATCH\]/,
    );
  });

  it("rejects non-sequential or out-of-order cue ordinals", () => {
    assert.throws(
      () =>
        VoiceManifestSchema.parse({
          ...baseManifest,
          cues: [{ ...validCue, ordinal: 2 }],
        }),
      /\[ORDINAL_SEQUENCE_INVALID\]/,
    );
  });

  it("rejects volatile runtime session fields in manifest", () => {
    const hostileManifests = [
      { ...baseManifest, runtime_session_id: "sess-001" },
      { ...baseManifest, generation: 1 },
      { ...baseManifest, take_id: "t01" },
      { ...baseManifest, hwnd: 123456 },
      { ...baseManifest, pid: 9876 },
      { ...baseManifest, api_key: "sk-secret" },
    ];
    for (const hostile of hostileManifests) {
      assert.throws(() => VoiceManifestSchema.parse(hostile));
    }
  });

  it("enforces project-relative POSIX paths for alignment_ref (no drive letters or traversal)", () => {
    const hostileRefs = [
      "D:\\renders\\alignment.json", // Windows drive letter + backslash
      "\\network\\share\\align.json", // UNC path
      "/root/alignment.json", // root absolute
      "../cues/alignment.json", // parent traversal
    ];

    for (const ref of hostileRefs) {
      assert.throws(() =>
        VoiceManifestSchema.parse({
          ...baseManifest,
          cues: [{ ...validCue, alignment_ref: ref }],
        }),
      );
    }
  });
});

describe("manifest: parser bounds and size ceiling", () => {
  it("rejects empty or whitespace-only JSON input", () => {
    assert.throws(() => parseVoiceManifest(""), /\[MANIFEST_PARSE_ERROR\]/);
    assert.throws(() => parseVoiceManifest("   "), /\[MANIFEST_PARSE_ERROR\]/);
  });

  it("rejects malformed JSON", () => {
    assert.throws(() => parseVoiceManifest("{ not valid json }"), /\[MANIFEST_PARSE_ERROR\]/);
  });

  it("rejects manifest exceeding 64 KiB (65,536 bytes) limit", () => {
    const oversizedJson = " ".repeat(65_537);
    assert.throws(() => parseVoiceManifest(oversizedJson), /\[MANIFEST_SIZE_EXCEEDED\]/);
  });
});
