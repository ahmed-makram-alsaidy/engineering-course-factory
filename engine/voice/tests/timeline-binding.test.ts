// P10.5 Timeline Binding Unit Tests
//
// Tests sample-accurate voice timeline binding against trusted P9 anchors:
// - Exact step identity and anchor matching
// - Missing / duplicate anchor fail-closed rejection
// - Session and generation fence enforcement
// - Integer sample mapping and quantization error bound (< 20.834 us / < 1 sample)
// - Harmonic 30 FPS video relation (1,600 samples per frame)
// - Authored order vs runtime anchor order consistency
// - Non-duplicating pause representation (Outcome A)
// - Alignment marks globalization and bounds checking
// - Sample-domain overlap detection
// - Window overflow detection (VOICE_EXCEEDS_WINDOW)
// - Silence gap preservation without time-stretching

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_SAMPLES_PER_VIDEO_FRAME,
  audioTimeUsForSampleIndex,
  durationUsForSampleCount,
  sampleIndexForAudioTimeUs,
} from "../src/audio-clock.ts";
import {
  type BoundVoiceCue,
  type VoiceTimelineAnchor,
  bindVoiceTimeline,
  safeBindVoiceTimeline,
  VoiceTimelineBindingError,
  globalizeAlignmentMarks,
} from "../src/timeline.ts";
import { createNarrationPlan, type PlannedNarrationUnit } from "../src/narration-planner.ts";
import type { NormalizedAlignment, RuntimeFence, VoiceAssetMetadata, VoiceProfile } from "../src/protocol.ts";

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

function createMockAsset(
  plannedUnit: PlannedNarrationUnit,
  sampleCount = 48_000,
  alignmentStatus: "none" | "word" = "none",
): { asset: VoiceAssetMetadata; alignment?: NormalizedAlignment } {
  const durationUs = durationUsForSampleCount(sampleCount);
  const asset: VoiceAssetMetadata = {
    voice_unit_id: plannedUnit.voice_unit_id,
    cache_key: plannedUnit.cache_key,
    audio_asset_digest: "a".repeat(64),
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
    alignment_status: alignmentStatus,
  };

  let alignment: NormalizedAlignment | undefined;
  if (alignmentStatus === "word") {
    alignment = {
      status: "word",
      words: [
        { ordinal: 1, word: "Hello", start_sample: 0, end_sample: 24_000 },
        { ordinal: 2, word: "world", start_sample: 24_000, end_sample: sampleCount },
      ],
      phonemes: [],
    };
  }

  return { asset, alignment };
}

describe("timeline-binding: anchor matching and identity", () => {
  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "First instruction." },
    { step_id: "C01-L003-S001-B002", text: "Second instruction." },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);

  const assetMap = new Map<string, { asset: VoiceAssetMetadata; alignment?: NormalizedAlignment }>();
  for (const unit of plan.units) {
    assetMap.set(unit.cache_key, createMockAsset(unit, 48_000));
  }

  const fence: RuntimeFence = {
    runtime_session_id: "sess-01",
    generation: 1,
    lesson_id: "C01-L003",
  };

  it("binds each planned narration unit to its trusted start anchor", () => {
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 1_000_000,
        global_seq: 10,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 3_000_000,
        global_seq: 20,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B002",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    assert.equal(timeline.cues.length, 2);
    assert.equal(timeline.cues[0]!.step_id, "C01-L003-S001-B001");
    assert.equal(timeline.cues[0]!.start_sample, 48_000); // 1,000,000 us -> 48,000 samples
    assert.equal(timeline.cues[0]!.anchor_global_seq, 10);
    assert.equal(timeline.cues[1]!.step_id, "C01-L003-S001-B002");
    assert.equal(timeline.cues[1]!.start_sample, 144_000); // 3,000,000 us -> 144,000 samples
    assert.equal(timeline.cues[1]!.anchor_global_seq, 20);
  });

  it("fails closed when an anchor is missing for a planned step", () => {
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 1_000_000,
        global_seq: 10,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
      // Step B002 is omitted
    ];

    assert.throws(
      () => bindVoiceTimeline(plan, assetMap, anchors, fence),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "ANCHOR_MISSING");
        return true;
      },
    );
  });

  it("fails closed when duplicate start anchors exist for one step", () => {
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 1_000_000,
        global_seq: 10,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 1_033_333,
        global_seq: 11,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B001", // Duplicate start anchor!
        engine: "narration",
        event_type: "runtime.step.started",
      },
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 3_000_000,
        global_seq: 20,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B002",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    assert.throws(
      () => bindVoiceTimeline(plan, assetMap, anchors, fence),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "ANCHOR_DUPLICATE");
        return true;
      },
    );
  });

  it("rejects anchor with wrong scene_id", () => {
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 1_000_000,
        global_seq: 10,
        scene_id: "C01-L003-S999", // Wrong scene!
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 3_000_000,
        global_seq: 20,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B002",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    assert.throws(
      () => bindVoiceTimeline(plan, assetMap, anchors, fence),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "STEP_MISMATCH");
        return true;
      },
    );
  });

  it("rejects when fence lesson_id does not match plan lesson_id", () => {
    const wrongFence: RuntimeFence = {
      runtime_session_id: "sess-01",
      generation: 1,
      lesson_id: "C01-L999", // Wrong lesson!
    };
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 1_000_000,
        global_seq: 10,
        scene_id: "C01-L003-S001",
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    assert.throws(
      () => bindVoiceTimeline(plan, assetMap, anchors, wrongFence),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "LESSON_MISMATCH");
        return true;
      },
    );
  });
});

describe("timeline-binding: fences and isolation", () => {
  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "Step 1." },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);
  const assetMap = new Map<string, { asset: VoiceAssetMetadata }>();
  for (const unit of plan.units) {
    assetMap.set(unit.cache_key, createMockAsset(unit, 48_000));
  }

  it("rejects stale runtime session in anchors", () => {
    const fence: RuntimeFence = { runtime_session_id: "active-session", generation: 1 };
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "stale-session",
        generation: 1,
        video_time_us: 0,
        global_seq: 1,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    assert.throws(
      () => bindVoiceTimeline(plan, assetMap, anchors, fence),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "STALE_RUNTIME_SESSION");
        return true;
      },
    );
  });

  it("rejects stale or wrong generation in anchors", () => {
    const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 2 };
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1, // Stale generation 1 vs active 2!
        video_time_us: 0,
        global_seq: 1,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    assert.throws(
      () => bindVoiceTimeline(plan, assetMap, anchors, fence),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "STALE_GENERATION");
        return true;
      },
    );
  });
});

describe("timeline-binding: sample mapping & quantization", () => {
  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "Mapping test." },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);
  const assetMap = new Map<string, { asset: VoiceAssetMetadata }>();
  for (const unit of plan.units) {
    assetMap.set(unit.cache_key, createMockAsset(unit, 48_000));
  }
  const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 1 };

  it("maps video time 0 to sample 0 exactly", () => {
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
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    assert.equal(timeline.cues[0]!.start_sample, 0);
    assert.equal(timeline.cues[0]!.quantization_error_us, 0);
    assert.equal(timeline.cues[0]!.quantization_error_ns, 0);
  });

  it("maps video time 1,000,000 us to exact 48,000 samples", () => {
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
    ];
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    assert.equal(timeline.cues[0]!.start_sample, 48_000);
    assert.equal(timeline.cues[0]!.quantization_error_us, 0);
    assert.equal(timeline.cues[0]!.quantization_error_ns, 0);
  });

  it("maps 33,333 us with exact quantization error < 20.834 us", () => {
    // 33,333 * 6 / 125 = 199,998 / 125 = 1599.984 -> sample 1599
    // mapped audio time = floor(1599 * 125 / 6) = floor(199875 / 6) = 33312 us
    // error_us = 33333 - 33312 = 21 us (microsecond integer rounding)
    // exact rational error = 33333 - 1599 * 125 / 6 = 123 / 6 = 20.5 us < 20.834 us!
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 33_333,
        global_seq: 1,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];
    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    assert.equal(timeline.cues[0]!.start_sample, 1599);
    assert.ok(timeline.cues[0]!.quantization_error_ns < 20_834);
  });

  it("proves exact harmonic 30 FPS relationship (1,600 samples per frame)", () => {
    assert.equal(AUDIO_SAMPLES_PER_VIDEO_FRAME, 1_600);
    assert.equal(48_000 / 30, 1_600);
    // At exactly frame 1 boundary (video_time_us = 33,334 us in P9 discrete integer CFR):
    const s = sampleIndexForAudioTimeUs(33_334);
    assert.equal(s, 1_600);
    // At exactly frame 30 boundary (1 second = 1,000,000 us):
    assert.equal(sampleIndexForAudioTimeUs(1_000_000), 48_000);
    assert.equal(48_000 / 1_600, 30);
  });
});

describe("timeline-binding: ordering and contradictions", () => {
  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "First." },
    { step_id: "C01-L003-S001-B002", text: "Second." },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);
  const assetMap = new Map<string, { asset: VoiceAssetMetadata }>();
  for (const unit of plan.units) {
    assetMap.set(unit.cache_key, createMockAsset(unit, 48_000));
  }
  const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 1 };

  it("fails closed when runtime sequence contradicts authored sequence", () => {
    // Authored: B001 then B002
    // Runtime seq: B001 has seq 20, B002 has seq 10 (contradiction!)
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 1_000_000,
        global_seq: 20,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 2_000_000,
        global_seq: 10,
        step_id: "C01-L003-S001-B002",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    assert.throws(
      () => bindVoiceTimeline(plan, assetMap, anchors, fence),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "ORDER_CONTRADICTION");
        return true;
      },
    );
  });

  it("fails closed when video timestamps contradict authored sequence", () => {
    // Authored: B001 then B002
    // Runtime time: B001 at 5 s, B002 at 2 s
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 5_000_000,
        global_seq: 10,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 2_000_000,
        global_seq: 20,
        step_id: "C01-L003-S001-B002",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    assert.throws(
      () => bindVoiceTimeline(plan, assetMap, anchors, fence),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "ORDER_CONTRADICTION");
        return true;
      },
    );
  });
});

describe("timeline-binding: pauses and non-duplication (Outcome A)", () => {
  const lesson = createMockLesson([
    {
      step_id: "C01-L003-S001-B001",
      text: "With pauses.",
      pause_before: 1, // 1 sec = 48,000 samples
      pause_after: 2,  // 2 sec = 96,000 samples
    },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);
  const assetMap = new Map<string, { asset: VoiceAssetMetadata }>();
  for (const unit of plan.units) {
    // 1 sec speech asset = 48,000 samples
    assetMap.set(unit.cache_key, createMockAsset(unit, 48_000));
  }
  const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 1 };

  it("maps speech and pauses inside authoritative interval without double-counting", () => {
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 2_000_000, // Anchor at 2 s = 96,000 samples
        global_seq: 10,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const cue = timeline.cues[0]!;

    assert.equal(cue.start_sample, 96_000);
    assert.equal(cue.pause_before_samples, 48_000);
    assert.equal(cue.speech_start_sample, 144_000); // 96,000 + 48,000
    assert.equal(cue.asset_sample_count, 48_000);
    assert.equal(cue.speech_end_sample, 192_000);   // 144,000 + 48,000
    assert.equal(cue.pause_after_samples, 96_000);
    assert.equal(cue.cue_end_sample, 288_000);      // 192,000 + 96,000
  });

  it("handles zero-second pauses cleanly", () => {
    const zeroLesson = createMockLesson([
      { step_id: "C01-L003-S001-B001", text: "Zero pause.", pause_before: 0, pause_after: 0 },
    ]);
    const zeroPlan = createNarrationPlan(zeroLesson, profileConfig);
    const zeroAssetMap = new Map<string, { asset: VoiceAssetMetadata }>();
    for (const unit of zeroPlan.units) {
      zeroAssetMap.set(unit.cache_key, createMockAsset(unit, 48_000));
    }

    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 1_000_000,
        global_seq: 10,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    const timeline = bindVoiceTimeline(zeroPlan, zeroAssetMap, anchors, fence);
    const cue = timeline.cues[0]!;
    assert.equal(cue.pause_before_samples, 0);
    assert.equal(cue.pause_after_samples, 0);
    assert.equal(cue.speech_start_sample, cue.start_sample);
    assert.equal(cue.speech_end_sample, cue.cue_end_sample);
  });
});

describe("timeline-binding: overlap and window limits", () => {
  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "First long speech." },
    { step_id: "C01-L003-S001-B002", text: "Second speech." },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);
  const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 1 };

  it("detects sample-domain overlap when previous cue extends past next start anchor", () => {
    // Cue 1: 3 seconds speech = 144,000 samples. Starts at sample 0 (video 0 us).
    // Ends at sample 144,000 (video 3,000,000 us).
    // Cue 2: Starts at video 2,000,000 us (sample 96,000) -> OVERLAP of 48,000 samples!
    const assetMap = new Map<string, { asset: VoiceAssetMetadata }>();
    assetMap.set(plan.units[0]!.cache_key, createMockAsset(plan.units[0]!, 144_000));
    assetMap.set(plan.units[1]!.cache_key, createMockAsset(plan.units[1]!, 48_000));

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
        video_time_us: 2_000_000, // 2 s < 3 s of cue 1!
        global_seq: 2,
        step_id: "C01-L003-S001-B002",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    assert.throws(
      () => bindVoiceTimeline(plan, assetMap, anchors, fence),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "CUE_OVERLAP");
        return true;
      },
    );
  });

  it("fails closed with VOICE_EXCEEDS_WINDOW when cue audio exceeds take media duration", () => {
    const singleLesson = createMockLesson([
      { step_id: "C01-L003-S001-B001", text: "Long audio step." },
    ]);
    const singlePlan = createNarrationPlan(singleLesson, profileConfig);
    const assetMap = new Map<string, { asset: VoiceAssetMetadata }>();
    assetMap.set(singlePlan.units[0]!.cache_key, createMockAsset(singlePlan.units[0]!, 144_000)); // 3 sec = 144,000 samples

    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 1_000_000, // Starts at 1 s
        global_seq: 1,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    // Media duration is 3 seconds (3,000,000 us). Cue ends at 1s + 3s = 4s > 3s!
    assert.throws(
      () =>
        bindVoiceTimeline(singlePlan, assetMap, anchors, fence, {
          media_duration_us: 3_000_000,
        }),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "VOICE_EXCEEDS_WINDOW");
        return true;
      },
    );
  });

  it("fails closed with VOICE_EXCEEDS_WINDOW when audio exceeds step completion window", () => {
    const singleLesson = createMockLesson([
      { step_id: "C01-L003-S001-B001", text: "Window check step." },
    ]);
    const singlePlan = createNarrationPlan(singleLesson, profileConfig);
    const assetMap = new Map<string, { asset: VoiceAssetMetadata }>();
    assetMap.set(singlePlan.units[0]!.cache_key, createMockAsset(singlePlan.units[0]!, 96_000)); // 2 sec audio

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
        video_time_us: 2_000_000, // Completed 1 s later! Audio is 2 s.
        global_seq: 2,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.completed",
      },
    ];

    assert.throws(
      () =>
        bindVoiceTimeline(singlePlan, assetMap, anchors, fence, {
          check_step_completion: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "VOICE_EXCEEDS_WINDOW");
        return true;
      },
    );
  });
});

describe("timeline-binding: alignment globalization", () => {
  const lesson = createMockLesson([
    { step_id: "C01-L003-S001-B001", text: "Hello world.", pause_before: 1 },
  ]);
  const plan = createNarrationPlan(lesson, profileConfig);
  const assetMap = new Map<string, { asset: VoiceAssetMetadata; alignment?: NormalizedAlignment }>();
  const mockAsset = createMockAsset(plan.units[0]!, 48_000, "word");
  assetMap.set(plan.units[0]!.cache_key, mockAsset);

  const fence: RuntimeFence = { runtime_session_id: "sess-01", generation: 1 };

  it("globalizes word marks relative to speech_start_sample", () => {
    // Video time: 2,000,000 us -> start_sample = 96,000
    // pause_before = 1 s -> speech_start_sample = 96,000 + 48,000 = 144,000
    const anchors: VoiceTimelineAnchor[] = [
      {
        runtime_session_id: "sess-01",
        generation: 1,
        video_time_us: 2_000_000,
        global_seq: 1,
        step_id: "C01-L003-S001-B001",
        engine: "narration",
        event_type: "runtime.step.started",
      },
    ];

    const timeline = bindVoiceTimeline(plan, assetMap, anchors, fence);
    const cue = timeline.cues[0]!;
    assert.ok(cue.alignment);
    assert.equal(cue.alignment.status, "word");
    assert.equal(cue.alignment.words.length, 2);

    // Word 1: local [0, 24,000] -> global [144,000, 168,000]
    assert.equal(cue.alignment.words[0]!.word, "Hello");
    assert.equal(cue.alignment.words[0]!.start_sample, 144_000);
    assert.equal(cue.alignment.words[0]!.end_sample, 168_000);

    // Word 2: local [24,000, 48,000] -> global [168,000, 192,000]
    assert.equal(cue.alignment.words[1]!.word, "world");
    assert.equal(cue.alignment.words[1]!.start_sample, 168_000);
    assert.equal(cue.alignment.words[1]!.end_sample, 192_000);
  });

  it("rejects alignment marks that exceed asset bounds", () => {
    const badAlignment: NormalizedAlignment = {
      status: "word",
      words: [
        { ordinal: 1, word: "overflow", start_sample: 0, end_sample: 999_999 },
      ],
      phonemes: [],
    };

    assert.throws(
      () => globalizeAlignmentMarks(badAlignment, 1000, 48_000),
      (err: unknown) => {
        assert.ok(err instanceof VoiceTimelineBindingError);
        assert.equal(err.code, "ALIGNMENT_OUT_OF_BOUNDS");
        return true;
      },
    );
  });
});
