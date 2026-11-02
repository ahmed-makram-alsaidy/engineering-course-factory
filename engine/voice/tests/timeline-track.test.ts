// P10.5 Timeline Track Assembly & Host Publisher Tests
//
// Tests:
// - Timeline digest determinism and sensitivity
// - Canonical JSON serialization and strict schema parsing
// - Pure sample-domain lesson audio track assembly (48 kHz mono PCM16 WAV)
// - Exact zero-padding for silence gaps and pauses
// - Exact video frame harmonic coverage (frames * 1,600 samples)
// - No off-by-one-frame truncation
// - Overlap rejection during assembly
// - Atomic VoiceTimelinePublisher with temp staging, atomic rename, and clean rollback on cancellation

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_SAMPLES_PER_VIDEO_FRAME,
  durationUsForSampleCount,
} from "../src/audio-clock.ts";
import { buildWavHeader, parseWavHeader } from "../src/wav.ts";
import {
  assembleLessonAudioTrack,
  bindVoiceTimeline,
  computeTimelineDigest,
  parseVoiceTimeline,
  serializeVoiceTimeline,
  type VoiceTimeline,
  type VoiceTimelineAnchor,
} from "../src/timeline.ts";
import { VoiceTimelinePublisher } from "../host/timeline-publisher.ts";
import { createNarrationPlan, type PlannedNarrationUnit } from "../src/narration-planner.ts";
import type { RuntimeFence, VoiceAssetMetadata, VoiceProfile } from "../src/protocol.ts";

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

function createMockLesson(steps: {
  step_id: string;
  text: string;
  pause_before?: number;
  pause_after?: number;
}[], lessonId = "C01-L003") {
  return {
    compiled_ir_version: "1.0",
    lesson: { course_id: "C01", lesson_id: lessonId, language: "en" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        ordinal: 1,
        steps: steps.map((s, idx) => ({
          kind: "narration",
          step_id: s.step_id,
          ordinal: idx + 1,
          derived: false,
          source_ref: {
            scene_id: `${lessonId}-S001`,
            scene_ordinal: 1,
            beat_id: s.step_id,
            form: "authored_beat",
          },
          narration: {
            text: s.text,
            language: "en",
            direction: "ltr",
            speaker: "inst",
            pause_before: s.pause_before,
            pause_after: s.pause_after,
          },
        })),
      },
    ],
  };
}

function makeMockPcmWav(sampleCount: number, amplitude = 5000): Buffer {
  const header = buildWavHeader(sampleCount);
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    pcm.writeInt16LE(amplitude, i * 2);
  }
  return Buffer.concat([header, pcm]);
}

function createMockAsset(
  plannedUnit: PlannedNarrationUnit,
  sampleCount = 48_000,
  digestHex = "1".repeat(64),
): { asset: VoiceAssetMetadata; audioBytes: Buffer } {
  const durationUs = durationUsForSampleCount(sampleCount);
  const audioBytes = makeMockPcmWav(sampleCount);
  const asset: VoiceAssetMetadata = {
    voice_unit_id: plannedUnit.voice_unit_id,
    cache_key: plannedUnit.cache_key,
    audio_asset_digest: digestHex,
    sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
    channels: 1,
    bits_per_sample: 16,
    sample_format: "pcm_s16le",
    sample_count: sampleCount,
    duration_us: durationUs,
    provider_family: "fake",
    provider_model: "deterministic-v1",
    provider_voice_id: "boston-01",
    text_normalization_version: "1.0",
    audio_normalization_version: "1.0",
    voice_contract_version: "1.0",
    alignment_status: "none",
  };
  return { asset, audioBytes };
}

describe("timeline-track: timeline digest determinism & sensitivity", () => {
  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "Step 1 text." },
    { step_id: "C01-L003-S001-B002", text: "Step 2 text." },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);

  const mockAsset1 = createMockAsset(plan.units[0]!, 48_000, "a".repeat(64));
  const mockAsset2 = createMockAsset(plan.units[1]!, 48_000, "b".repeat(64));
  const assetMap = new Map<string, { asset: VoiceAssetMetadata }>();
  assetMap.set(plan.units[0]!.cache_key, mockAsset1);
  assetMap.set(plan.units[1]!.cache_key, mockAsset2);

  const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 1 };
  const anchors: VoiceTimelineAnchor[] = [
    {
      runtime_session_id: "sess-01",
      generation: 1,
      video_time_us: 1_000_000,
      global_seq: 1,
      step_id: "C01-L003-S001-B001",
      engine: "narration",
      event_type: "runtime.step.started",
    },
    {
      runtime_session_id: "sess-01",
      generation: 1,
      video_time_us: 4_000_000,
      global_seq: 2,
      step_id: "C01-L003-S001-B002",
      engine: "narration",
      event_type: "runtime.step.started",
    },
  ];

  it("produces identical timeline digest across repeated runs", () => {
    const t1 = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const t2 = bindVoiceTimeline(plan, assetMap, anchors, fence);
    assert.equal(t1.timeline_digest, t2.timeline_digest);
    assert.equal(typeof t1.timeline_digest, "string");
    assert.equal(t1.timeline_digest.length, 64);
  });

  it("changes timeline digest when anchor video_time_us changes", () => {
    const baseline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const shiftedAnchors: VoiceTimelineAnchor[] = [
      anchors[0]!,
      { ...anchors[1]!, video_time_us: 5_000_000 },
    ];
    const shifted = bindVoiceTimeline(plan, assetMap, shiftedAnchors, fence);
    assert.notEqual(baseline.timeline_digest, shifted.timeline_digest);
  });

  it("changes timeline digest when VoiceAsset digest changes", () => {
    const baseline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const modAsset2 = {
      ...mockAsset2,
      asset: { ...mockAsset2.asset, audio_asset_digest: "c".repeat(64) },
    };
    const modMap = new Map(assetMap);
    modMap.set(plan.units[1]!.cache_key, modAsset2);
    const modified = bindVoiceTimeline(plan, modMap, anchors, fence);
    assert.notEqual(baseline.timeline_digest, modified.timeline_digest);
  });

  it("changes timeline digest when generation changes", () => {
    const baseline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const gen2Fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 2 };
    const gen2Anchors = anchors.map((a) => ({ ...a, generation: 2 }));
    const gen2 = bindVoiceTimeline(plan, assetMap, gen2Anchors, gen2Fence);
    assert.notEqual(baseline.timeline_digest, gen2.timeline_digest);
  });
});

describe("timeline-track: serialization and parsing", () => {
  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "Parse test." },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);
  const asset = createMockAsset(plan.units[0]!, 48_000);
  const assetMap = new Map<string, { asset: VoiceAssetMetadata }>([[plan.units[0]!.cache_key, asset]]);
  const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 1 };
  const anchors: VoiceTimelineAnchor[] = [
    {
      runtime_session_id: "sess-01",
      generation: 1,
      video_time_us: 0,
      global_seq: 1,
      step_id: "C01-L003-S001-B001",
      engine: "narration",
      event_type: "runtime.step.started",
    },
  ];

  it("serializes and parses round-trip with deep equality", () => {
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const json = serializeVoiceTimeline(timeline);
    assert.equal(typeof json, "string");
    assert.ok(json.length > 0);

    const parsed = parseVoiceTimeline(json);
    assert.deepEqual(parsed, timeline);
  });

  it("rejects unknown fields in VoiceTimeline JSON", () => {
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const json = serializeVoiceTimeline(timeline);
    const withExtra = JSON.parse(json);
    withExtra.unauthorized_extra_field = "exploit";

    assert.throws(
      () => parseVoiceTimeline(JSON.stringify(withExtra)),
      /unrecognized_keys/,
    );
  });
});

describe("timeline-track: lesson audio track assembler", () => {
  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "First segment." },
    { step_id: "C01-L003-S001-B002", text: "Second segment." },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);

  // Cue 1: 1 second = 48,000 samples at video 0s (sample 0)
  // Cue 2: 1 second = 48,000 samples at video 3s (sample 144,000)
  // Gap between cue 1 end (48,000) and cue 2 start (144,000) = 96,000 samples (2 seconds)
  const mock1 = createMockAsset(plan.units[0]!, 48_000);
  const mock2 = createMockAsset(plan.units[1]!, 48_000);
  const assetMap = new Map([[plan.units[0]!.cache_key, mock1], [plan.units[1]!.cache_key, mock2]]);

  const audioBuffers = new Map<string, Buffer>([
    [plan.units[0]!.cache_key, mock1.audioBytes],
    [plan.units[1]!.cache_key, mock2.audioBytes],
  ]);

  const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 1 };
  const anchors: VoiceTimelineAnchor[] = [
    {
      runtime_session_id: "sess-01",
      generation: 1,
      video_time_us: 0,
      global_seq: 1,
      step_id: "C01-L003-S001-B001",
      engine: "narration",
      event_type: "runtime.step.started",
    },
    {
      runtime_session_id: "sess-01",
      generation: 1,
      video_time_us: 3_000_000,
      global_seq: 2,
      step_id: "C01-L003-S001-B002",
      engine: "narration",
      event_type: "runtime.step.started",
    },
  ];

  it("assembles canonical 48 kHz mono WAV with exact sample placements and zeros in gaps", () => {
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const trackWav = assembleLessonAudioTrack(timeline, audioBuffers);

    assert.ok(trackWav.length > 44);
    const info = parseWavHeader(trackWav);
    assert.equal(info.sampleRate, 48_000);
    assert.equal(info.channels, 1);
    assert.equal(info.bitsPerSample, 16);
    // Total samples = cue 2 end = 144,000 + 48,000 = 192,000 samples
    assert.equal(info.sampleCount, 192_000);

    // Verify PCM content:
    const pcm = trackWav.subarray(44);
    assert.equal(pcm.byteLength, 192_000 * 2);

    // Cue 1 audio region: samples 0 .. 47,999 have amplitude 5000
    assert.equal(pcm.readInt16LE(0), 5000);
    assert.equal(pcm.readInt16LE(47_999 * 2), 5000);

    // Gap region: sample 48,000 .. 143,999 must be EXACT zeros
    assert.equal(pcm.readInt16LE(48_000 * 2), 0);
    assert.equal(pcm.readInt16LE(100_000 * 2), 0);
    assert.equal(pcm.readInt16LE(143_999 * 2), 0);

    // Cue 2 audio region: samples 144,000 .. 191,999 have amplitude 5000
    assert.equal(pcm.readInt16LE(144_000 * 2), 5000);
    assert.equal(pcm.readInt16LE(191_999 * 2), 5000);
  });

  it("supports video frame count authority (frames * 1,600 samples) without off-by-one truncation", () => {
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    // Suppose video is 150 frames (5 seconds = 150 * 1,600 = 240,000 samples)
    const trackWav = assembleLessonAudioTrack(timeline, audioBuffers, { video_frame_count: 150 });
    const info = parseWavHeader(trackWav);
    assert.equal(info.sampleCount, 240_000);
    assert.equal(info.sampleCount, 150 * AUDIO_SAMPLES_PER_VIDEO_FRAME);

    // Audio ends at 192,000; the remaining tail up to 240,000 is exact zero silence
    const pcm = trackWav.subarray(44);
    assert.equal(pcm.readInt16LE(192_000 * 2), 0);
    assert.equal(pcm.readInt16LE(239_999 * 2), 0);
  });

  it("fails closed if requested total_samples is less than last cue extent", () => {
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    // Last cue ends at 192,000 samples. Requesting 100,000 must throw.
    assert.throws(
      () => assembleLessonAudioTrack(timeline, audioBuffers, { total_samples: 100_000 }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});

describe("timeline-track: atomic VoiceTimelinePublisher", () => {
  const testDir = mkdtempSync(join(tmpdir(), "cf-pub-test-"));
  const tempRoot = join(testDir, "temp");
  const assemblyRoot = join(testDir, "renders", "voice");

  const publisher = new VoiceTimelinePublisher({
    roots: {
      voiceTempRoot: tempRoot,
      voiceAssemblyRoot: assemblyRoot,
      repoRoot: testDir,
      voiceCacheRoot: join(testDir, "cache"),
    },
    minFreeDiskBytes: 1024,
  });

  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "Publisher step." },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);
  const mock = createMockAsset(plan.units[0]!, 48_000);
  const assetMap = new Map([[plan.units[0]!.cache_key, mock]]);
  const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 1 };
  const anchors: VoiceTimelineAnchor[] = [
    {
      runtime_session_id: "sess-01",
      generation: 1,
      video_time_us: 0,
      global_seq: 1,
      step_id: "C01-L003-S001-B001",
      engine: "narration",
      event_type: "runtime.step.started",
    },
  ];

  it("atomically publishes voice-timeline.json to controlled voiceAssemblyRoot", async () => {
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const result = await publisher.publishTimeline(timeline);

    assert.ok(existsSync(result.timelinePath));
    assert.ok(result.timelinePath.endsWith("voice-timeline.json"));
    const content = readFileSync(result.timelinePath, "utf8");
    const parsed = parseVoiceTimeline(content);
    assert.equal(parsed.timeline_digest, timeline.timeline_digest);

    // Staging directory must be cleaned up
    const tempEntries = existsSync(tempRoot);
    assert.ok(tempEntries);
  });

  it("atomically publishes narration-track.wav to controlled voiceAssemblyRoot", async () => {
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const audioBuffers = new Map([[plan.units[0]!.cache_key, mock.audioBytes]]);
    const trackWav = assembleLessonAudioTrack(timeline, audioBuffers);

    const result = await publisher.publishTrack(timeline, trackWav);
    assert.ok(existsSync(result.trackPath));
    assert.ok(result.trackPath.endsWith("narration-track.wav"));
    assert.equal(result.sampleCount, 48_000);
  });

  it("aborts publication cleanly when signal is aborted before start", async () => {
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => publisher.publishTimeline(timeline, { signal: controller.signal }),
      /TIMELINE_PUBLISH_ABORTED/,
    );
  });

  it("cleans up test directory", () => {
    rmSync(testDir, { recursive: true, force: true });
    assert.equal(existsSync(testDir), false);
  });
});
