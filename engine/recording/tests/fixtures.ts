// P9.1 canonical test fixtures: valid anchor + manifest seeds.
// Deterministic, privacy-safe (no host paths, no PIDs, no ports).

import type { CanonicalManifestSeed } from "../src/manifest.ts";
import type { RecordingTimelineAnchor } from "../src/timeline.ts";

export const VALID_TAKE_FENCE = {
  recording_session_id: "rec-C01-L001-20260914-01",
  runtime_session_id: "sess-runtime-001",
  generation: 1,
} as const;

export function makeAnchor(
  overrides: Partial<RecordingTimelineAnchor> = {},
  seqBase = 0,
): RecordingTimelineAnchor {
  return {
    recording_session_id: "rec-C01-L001-20260914-01",
    take_id: "t01",
    runtime_session_id: "sess-runtime-001",
    generation: 1,
    video_time_us: 33_334 + seqBase * 1_000,
    runtime_monotonic_ms: 1_000 + seqBase,
    global_seq: 10 + seqBase,
    scene_id: "C01-L001-S001",
    step_id: "C01-L001-S001-B001",
    global_step_ordinal: 1,
    engine: "browser",
    event_type: "step.started",
    ...overrides,
  };
}

export function makeManifestSeed(
  overrides: Partial<CanonicalManifestSeed> = {},
): CanonicalManifestSeed {
  return {
    recording_session_id: "rec-C01-L001-20260914-01",
    take_id: "t01",
    lesson_id: "C01-L001",
    course_id: "C01",
    runtime_session_id: "sess-runtime-001",
    generation: 1,
    encoder: {
      family: "NVENC",
      profile: "nvenc-p4-cq23",
      profile_version: "1.0",
      fallback_used: false,
      encoder_version: "8.1.1-full_build",
    },
    epoch: {
      capture_clock_epoch: "epoch-cap-001",
      runtime_clock_epoch: "epoch-run-001",
      epoch_skew_bound_us: 500,
    },
    recording_start_us: 0,
    recording_end_us: 600_000_000,
    tail_duration_ms: 2_000,
    frames: {
      captured_frame_count: 18_000,
      encoded_frame_count: 18_000,
      dropped_frame_count: 0,
      coalesced_frame_count: 120,
      filler_frame_count: 0,
    },
    anchors: {
      anchor_count: 24,
      first_video_time_us: 0,
      last_video_time_us: 599_900_000,
      journal_high_seq_start: 1,
      journal_high_seq_end: 240,
      anchors_sha256: "a".repeat(64),
    },
    publication_status: "PUBLISHED",
    outcome: "COMPLETED",
    terminal_cause: "SUCCESS",
    media_sha256: "b".repeat(64),
    media_size_bytes: 900_000_000,
    media_validation: {
      verdict: "PASS",
      checks: [
        { check: "container_readable", passed: true },
        { check: "codec_h264", passed: true },
        { check: "resolution_1920x1080", passed: true },
        { check: "fps_approx_30", passed: true },
        { check: "duration_within_tolerance", passed: true },
        { check: "nonzero_frames", passed: true },
        { check: "pts_monotonic", passed: true },
        { check: "size_within_ceiling", passed: true },
      ],
    },
    preflight: {
      free_bytes_at_start: 20_000_000_000,
      encoder_probe_id: "probe-20260914-001",
    },
    app_version: "teaching-ide 0.1.0",
    ...overrides,
  };
}
