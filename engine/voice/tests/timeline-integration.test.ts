// P10.5 Timeline Synchronization Integration Tests
//
// End-to-end integration:
// 1. Real P10.3 NarrationPlan from compiled lesson structure
// 2. Real P10.4 VoiceSynthesisService + FakeVoiceProvider -> immutable cache
// 3. Trusted P9 RecordingTimeline anchors -> sample-accurate VoiceTimeline binding
// 4. Assembled composition-ready 48 kHz mono PCM16 track
// 5. Read-only structural verification against actual P9 r4 take t02 anchors
//
// Zero real cloud provider calls, zero video mutation, zero residue.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_SAMPLES_PER_VIDEO_FRAME,
  audioTimeUsForSampleIndex,
  durationUsForSampleCount,
  sampleIndexForAudioTimeUs,
} from "../src/audio-clock.ts";
import { parseWavHeader } from "../src/wav.ts";
import {
  assembleLessonAudioTrack,
  bindVoiceTimeline,
  parseVoiceTimeline,
  serializeVoiceTimeline,
  type VoiceTimeline,
  type VoiceTimelineAnchor,
  VoiceTimelineAnchorSchema,
} from "../src/timeline.ts";
import { FakeVoiceProvider } from "../src/fake-provider.ts";
import { VoiceCache } from "../host/voice-cache.ts";
import { VoiceAssetNormalizer } from "../host/audio-normalizer.ts";
import { VoiceSynthesisService } from "../host/synthesis-service.ts";
import { createNarrationPlan } from "../src/narration-planner.ts";
import type { RuntimeFence, VoiceProfile } from "../src/protocol.ts";

const profileEn: VoiceProfile = {
  profile_id: "en-instructor-01",
  locale: "en-US",
  gender: "male",
  description: "English Instructor",
  provider_family: "fake",
  provider_voice_id: "inst-en",
  provider_model: "synthetic-v1",
  rate: 1.0,
  pitch: 0.0,
  normalization_policy: "standard-v1",
};

const profileConfig = {
  profiles: [profileEn],
  speaker_mappings: [{ speaker: "instructor", profile_id: "en-instructor-01" }],
  default_profile_id: "en-instructor-01",
};

describe("timeline-integration: end-to-end plan -> cache -> anchors -> timeline", () => {
  const testDir = mkdtempSync(join(tmpdir(), "cf-sync-e2e-"));
  const cacheRoot = join(testDir, "voice-cache");
  const tempRoot = join(testDir, "voice-temp");

  const voiceCache = new VoiceCache({
    voiceCacheRoot: cacheRoot,
    voiceTempRoot: tempRoot,
    minFreeDiskBytes: 1024,
  });
  const normalizer = new VoiceAssetNormalizer();
  const synthesisService = new VoiceSynthesisService({
    cache: voiceCache,
    normalizer,
    providerResolver: () => new FakeVoiceProvider(),
  });

  const lesson = {
    compiled_ir_version: "1.0",
    lesson: { course_id: "C01", lesson_id: "C01-L003", language: "en" },
    scenes: [
      {
        scene_id: "C01-L003-S001",
        ordinal: 1,
        steps: [
          {
            kind: "narration",
            step_id: "C01-L003-S001-B001",
            ordinal: 1,
            derived: false,
            source_ref: {
              scene_id: "C01-L003-S001",
              scene_ordinal: 1,
              beat_id: "B001",
              form: "authored_beat",
            },
            narration: {
              text: "Welcome to Docker containerization.",
              language: "en",
              direction: "ltr",
              speaker: "instructor",
              pause_before: 1,
              pause_after: 1,
            },
          },
          {
            kind: "narration",
            step_id: "C01-L003-S001-B002",
            ordinal: 2,
            derived: false,
            source_ref: {
              scene_id: "C01-L003-S001",
              scene_ordinal: 1,
              beat_id: "B002",
              form: "authored_beat",
            },
            narration: {
              text: "Let's inspect the Dockerfile in VS Code.",
              language: "en",
              direction: "ltr",
              speaker: "instructor",
              pause_before: 0,
              pause_after: 0,
            },
          },
        ],
      },
    ],
  };

  const plan = createNarrationPlan(lesson, profileConfig);

  it("synthesizes assets into cache, binds to anchors, and emits valid track", async () => {
    // 1. Synthesize all planned units
    const assetMap = new Map();
    const audioBuffers = new Map();

    for (const unit of plan.units) {
      const synResult = await synthesisService.synthesizeUnit({
        plannedUnit: unit,
        profile: profileEn,
      });
      assetMap.set(unit.cache_key, synResult.asset);
      audioBuffers.set(unit.cache_key, synResult.audio_bytes);
    }

    assert.equal(assetMap.size, 2);

    // 2. Trusted P9 anchors simulating a 1080p30 recording take
    const fence: RuntimeFence = {
      runtime_session_id: "rec-session-001",
      generation: 1,
      lesson_id: "C01-L003",
    };

    const cue1DurationSamples = assetMap.get(plan.units[0]!.cache_key)!.sample_count;
    const cue1TotalSamples = 48_000 + cue1DurationSamples + 48_000; // pause_before + speech + pause_after
    // Place cue 1 at 2 seconds (2,000,000 us = 96,000 samples)
    const cue1StartUs = 2_000_000;
    // Place cue 2 well after cue 1 finishes (at 8 seconds = 8,000,000 us)
    const cue2StartUs = 8_000_000;

    const anchors: VoiceTimelineAnchor[] = [
      {
        recording_session_id: "rec-session-001",
        take_id: "t01",
        runtime_session_id: "rec-session-001",
        generation: 1,
        video_time_us: cue1StartUs,
        runtime_monotonic_ms: 2000,
        global_seq: 10,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
      {
        recording_session_id: "rec-session-001",
        take_id: "t01",
        runtime_session_id: "rec-session-001",
        generation: 1,
        video_time_us: cue2StartUs,
        runtime_monotonic_ms: 8000,
        global_seq: 20,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B002",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    // 3. Bind timeline
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence, {
      recording_ref: { recording_session_id: "rec-session-001", take_id: "t01" },
    });

    assert.equal(timeline.cues.length, 2);
    assert.equal(timeline.cues[0]!.start_sample, 96_000);
    assert.equal(timeline.cues[0]!.speech_start_sample, 96_000 + 48_000); // 1s pause
    assert.equal(timeline.cues[0]!.cue_end_sample, 96_000 + cue1TotalSamples);
    assert.equal(timeline.cues[1]!.start_sample, 384_000); // 8,000,000 us -> 384,000 samples
    assert.ok(timeline.validation_summary.valid);
    assert.equal(timeline.validation_summary.outcome, "PASS");

    // 4. Assemble track
    const trackWav = assembleLessonAudioTrack(timeline, audioBuffers);
    const wavInfo = parseWavHeader(trackWav);
    assert.equal(wavInfo.sampleRate, 48_000);
    assert.equal(wavInfo.channels, 1);
    assert.equal(wavInfo.bitsPerSample, 16);
    assert.equal(wavInfo.sampleCount, timeline.validation_summary.last_end_sample);
  });

  it("cleans up test directory", () => {
    rmSync(testDir, { recursive: true, force: true });
    assert.equal(existsSync(testDir), false);
  });
});

describe("timeline-integration: read-only actual P9 r4 take t02 proof", () => {
  const r4AnchorsPath = "D:\\course-factory\\renders\\intermediate\\screen\\C01-L615\\C01-L615--gen1--taket02.anchors.jsonl";

  it("reads and structurally validates actual P9 r4 anchors without mutation", () => {
    if (!existsSync(r4AnchorsPath)) {
      // If environment does not have D: or r4 fixture, skip gracefully
      return;
    }

    const lines = readFileSync(r4AnchorsPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    assert.equal(lines.length, 16);

    const parsedAnchors: VoiceTimelineAnchor[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = JSON.parse(lines[i]!);
      const parsed = VoiceTimelineAnchorSchema.parse(raw);
      parsedAnchors.push(parsed);
    }

    // Monotonic sequences
    for (let i = 0; i < parsedAnchors.length; i++) {
      assert.equal(parsedAnchors[i]!.global_seq, i + 1);
    }

    // Filter narration anchors
    const narrationStarts = parsedAnchors.filter(
      (a) => a.engine === "narration" && a.event_type === "runtime.step.started",
    );
    assert.equal(narrationStarts.length, 2);

    const b002 = narrationStarts[0]!;
    const b006 = narrationStarts[1]!;

    assert.equal(b002.step_id, "C01-L615-S001-B002");
    assert.equal(b002.video_time_us, 1_166_666);
    assert.equal(b002.global_seq, 4);

    assert.equal(b006.step_id, "C01-L615-S001-B006");
    assert.equal(b006.video_time_us, 9_800_000);
    assert.equal(b006.global_seq, 12);

    // Verify exact integer sample mapping for real anchors
    const b002Sample = sampleIndexForAudioTimeUs(b002.video_time_us);
    // 1,166,666 * 6 / 125 = 6,999,996 / 125 = 55,999 samples
    assert.equal(b002Sample, 55_999);

    const b006Sample = sampleIndexForAudioTimeUs(b006.video_time_us);
    // 9,800,000 * 6 / 125 = 58,800,000 / 125 = 470,400 samples
    assert.equal(b006Sample, 470_400);

    // Quantization error on both is strictly < 20.834 us
    const b002MappedUs = audioTimeUsForSampleIndex(b002Sample);
    const b002ErrorUs = b002.video_time_us - b002MappedUs;
    assert.ok(b002ErrorUs >= 0);
    assert.ok(b002ErrorUs <= 21);

    const b006MappedUs = audioTimeUsForSampleIndex(b006Sample);
    const b006ErrorUs = b006.video_time_us - b006MappedUs;
    assert.equal(b006ErrorUs, 0); // 9,800,000 us maps with exact 0 remainder!
  });
});
