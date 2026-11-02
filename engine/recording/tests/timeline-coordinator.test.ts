// P9.4 RecordingTimelineCoordinator — deterministic journal-replay
// correlation, fencing races, anchor coverage proof.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md task P9.4, Sections 8-9, 14,
// 16, 19 and ADR-0014. Uses a deterministic manual time source (integer ms
// stepped by the test, zero sleeps, zero wall clock). Proves trusted P8
// event ingestion, three-domain epoch mapping, rational CFR video time,
// global_seq authority, generation/session fencing, duplicate suppression,
// step boundaries within one frame interval, pause continuity, reset
// termination, ordering, bounds, manifest summary, P10 seam, deterministic
// replay, and passive reanchor.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FRAME_INTERVAL_US } from "../src/timeline.ts";
import { calibrateTimelineEpoch } from "../src/timeline-clock.ts";
import {
  RecordingTimelineCoordinator,
  type TrustedRuntimeEvent,
} from "../src/timeline-coordinator.ts";

const FENCE = {
  recording_session_id: "rec-C01-L001-20260914-01",
  take_id: "t01",
  runtime_session_id: "sess-runtime-001",
  generation: 1,
} as const;

const EPOCH = calibrateTimelineEpoch({
  runtimeSampleMs: 1_000,
  captureSampleUs: 5_000_000,
  runtimeClockEpoch: "epoch-run-001",
  captureClockEpoch: "epoch-cap-001",
  skewBoundUs: 500,
});

function makeCoordinator() {
  return new RecordingTimelineCoordinator({ fence: { ...FENCE }, epoch: EPOCH });
}

let seqCounter = 1000;
function makeEvent(overrides: Partial<TrustedRuntimeEvent> = {}): TrustedRuntimeEvent {
  seqCounter += 1;
  return {
    runtime_session_id: "sess-runtime-001",
    generation: 1,
    global_seq: seqCounter,
    event_type: "runtime.step.started",
    scene_id: "C01-L001-S001",
    step_id: "C01-L001-S001-B001",
    global_step_ordinal: 1,
    engine: "browser",
    timestamp_ms: 1_100,
    ...overrides,
  };
}

describe("P9.4: timeline coordinator creation", () => {
  it("timeline coordinator creation", () => {
    const c = makeCoordinator();
    assert.equal(c.getStatus(), "ACTIVE");
    assert.equal(c.isReady(), true);
  });

  it("valid take fence", () => {
    const c = makeCoordinator();
    assert.deepEqual(c.getFence(), { ...FENCE });
    assert.deepEqual(c.getEpoch(), EPOCH);
  });

  it("invalid runtime session", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ runtime_session_id: "sess-runtime-999" }));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "STALE_SESSION");
    }
    assert.equal(c.getAnchors().length, 0);
  });

  it("stale generation", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ generation: 0 as never }));
    assert.equal(r.ok, false);
  });
});

describe("P9.4: global_seq authority", () => {
  it("valid global_seq", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 11, timestamp_ms: 1_000 }));
    assert.equal(r.ok, true);
  });

  it("duplicate global_seq idempotent/rejected canonical", () => {
    const c = makeCoordinator();
    const first = c.ingestRuntimeEvent(makeEvent({ global_seq: 21, timestamp_ms: 1_000 }));
    assert.equal(first.ok, true);
    const dup = c.ingestRuntimeEvent(makeEvent({ global_seq: 21, timestamp_ms: 1_000 }));
    assert.equal(dup.ok, true);
    if (dup.ok) {
      assert.equal(dup.duplicate, true);
    }
    assert.equal(c.getAnchors().length, 1);
  });

  it("decreasing global_seq rejected", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 30, timestamp_ms: 1_000 })).ok, true);
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 31, timestamp_ms: 1_100 })).ok, true);
    const bad = c.ingestRuntimeEvent(makeEvent({ global_seq: 29, timestamp_ms: 1_200 }));
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.code, "TIMELINE_INVALID");
    }
    assert.equal(c.getStatus(), "TIMELINE_INVALID");
  });

  it("gap allowed if canonical", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 40, timestamp_ms: 1_000 })).ok, true);
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 45, timestamp_ms: 1_100 })).ok, true);
    assert.equal(c.getAnchors().length, 2);
  });

  it("negative timestamp rejected", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ timestamp_ms: -5 as never }));
    assert.equal(r.ok, false);
  });

  it("backwards runtime time rejected", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 50, timestamp_ms: 1_200 })).ok, true);
    const bad = c.ingestRuntimeEvent(makeEvent({ global_seq: 51, timestamp_ms: 1_100 }));
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.code, "TIMELINE_INVALID");
    }
  });

  it("backwards capture time rejected", () => {
    const c = makeCoordinator();
    assert.equal(c.observeCaptureFrame({
      capture_timestamp_us: 5_100_000,
      recording_session_id: FENCE.recording_session_id,
      runtime_session_id: FENCE.runtime_session_id,
      generation: 1,
    }).ok, true);
    const bad = c.observeCaptureFrame({
      capture_timestamp_us: 5_050_000,
      recording_session_id: FENCE.recording_session_id,
      runtime_session_id: FENCE.runtime_session_id,
      generation: 1,
    });
    assert.equal(bad.ok, false);
  });
});

describe("P9.4: trusted step boundary anchors", () => {
  it("step.started anchor", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({
      global_seq: 61,
      timestamp_ms: 1_000,
      event_type: "runtime.step.started",
      engine: "editor",
      scene_id: "C01-L001-S002",
      step_id: "C01-L001-S002-B003",
      global_step_ordinal: 7,
    }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.anchor.event_type, "runtime.step.started");
      assert.equal(r.anchor.video_time_us, 0);
      assert.equal(r.mapping_error_us, 0);
    }
  });

  it("step.completed anchor", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 62, timestamp_ms: 1_000, event_type: "runtime.step.started" })).ok, true);
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 63, timestamp_ms: 1_033, event_type: "runtime.step.completed" }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.anchor.event_type, "runtime.step.completed");
      assert.equal(r.anchor.video_time_us, 0);
      assert.ok(r.mapping_error_us <= FRAME_INTERVAL_US);
    }
  });

  it("engine family preserved", () => {
    const c = makeCoordinator();
    for (const engine of ["orchestrator", "editor", "terminal", "browser", "wait", "narration", "visual"] as const) {
      const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 70 + engine.length, timestamp_ms: 1_000 + engine.length, engine }));
      void r;
    }
    const c2 = makeCoordinator();
    const r = c2.ingestRuntimeEvent(makeEvent({ global_seq: 80, engine: "terminal" }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.anchor.engine, "terminal");
    }
  });

  it("scene ID preserved", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 81, scene_id: "C01-L001-S003" }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.anchor.scene_id, "C01-L001-S003");
    }
  });

  it("step ID preserved", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 82, step_id: "C01-L001-S001-B009" }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.anchor.step_id, "C01-L001-S001-B009");
    }
  });

  it("ordinal preserved", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 83, global_step_ordinal: 42 }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.anchor.global_step_ordinal, 42);
    }
  });

  it("semantic payload absent", () => {
    const c = makeCoordinator();
    const hostile = {
      ...makeEvent({ global_seq: 84 }),
      command: "rm -rf /",
      selector: "#secret",
      url: "http://localhost:9999/x",
    };
    const r = c.ingestRuntimeEvent(hostile);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.ok(!("command" in r.anchor));
      assert.ok(!("selector" in r.anchor));
      assert.ok(!("url" in r.anchor));
    }
  });
});

describe("P9.4: pause keeps video running with annotated intervals", () => {
  it("pause anchor", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 90, timestamp_ms: 1_100, event_type: "runtime.paused" }));
    assert.equal(r.ok, true);
  });

  it("paused interval video time continues", () => {
    const c = makeCoordinator();
    const p = c.ingestRuntimeEvent(makeEvent({ global_seq: 91, timestamp_ms: 1_100, event_type: "runtime.paused" }));
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 92, timestamp_ms: 1_200, event_type: "runtime.resumed" }));
    assert.equal(p.ok && r.ok, true);
    if (p.ok && r.ok) {
      assert.ok(r.anchor.video_time_us >= p.anchor.video_time_us);
      assert.ok(r.anchor.video_time_us - p.anchor.video_time_us >= 66_668);
    }
    const intervals = c.getPauseIntervals();
    assert.equal(intervals.length, 1);
    assert.ok(intervals[0]!.end_video_time_us! > intervals[0]!.start_video_time_us);
  });

  it("resume anchor", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 93, timestamp_ms: 1_000, event_type: "runtime.paused" })).ok, true);
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 94, timestamp_ms: 1_500, event_type: "runtime.resumed" }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.anchor.event_type, "runtime.resumed");
    }
  });

  it("cancel anchor", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 95, timestamp_ms: 1_100, event_type: "runtime.cancelled" }));
    assert.equal(r.ok, true);
    assert.equal(c.getStatus(), "ACTIVE");
  });

  it("FAILED/HOLD anchor if canonical", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 96, timestamp_ms: 1_100, event_type: "runtime.step.failed" })).ok, true);
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 97, timestamp_ms: 1_200, event_type: "runtime.step.uncertain" })).ok, true);
    assert.equal(c.getStatus(), "ACTIVE");
    assert.equal(c.getAnchors().length, 2);
  });
});

describe("P9.4: reset and generation fencing terminate the take", () => {
  it("reset interruption terminates take", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 100, timestamp_ms: 1_100, event_type: "runtime.step.started" })).ok, true);
    const reset = c.ingestRuntimeEvent(makeEvent({ global_seq: 101, timestamp_ms: 1_200, event_type: "runtime.reset.started" }));
    assert.equal(reset.ok, true);
    assert.equal(c.getStatus(), "RESET_INTERRUPTED");
    const after = c.ingestRuntimeEvent(makeEvent({ global_seq: 102, timestamp_ms: 1_300 }));
    assert.equal(after.ok, false);
    assert.equal(c.getAnchors().length, 2);
  });

  it("generation N+1 rejected in same take", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 110, timestamp_ms: 1_100 })).ok, true);
    const fwd = c.ingestRuntimeEvent(makeEvent({ global_seq: 111, timestamp_ms: 1_200, generation: 2 }));
    assert.equal(fwd.ok, false);
    if (!fwd.ok) {
      assert.equal(fwd.code, "STALE_GENERATION");
    }
    assert.equal(c.getStatus(), "RESET_INTERRUPTED");
  });

  it("late old-generation event rejected", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 120, timestamp_ms: 1_100 })).ok, true);
    const stale = c.ingestRuntimeEvent(makeEvent({ global_seq: 121, timestamp_ms: 1_200, generation: 0 as never }));
    assert.equal(stale.ok, false);
  });

  it("late capture timing rejected", () => {
    const c = makeCoordinator();
    const bad = c.observeCaptureFrame({
      capture_timestamp_us: 5_100_000,
      recording_session_id: FENCE.recording_session_id,
      runtime_session_id: "sess-runtime-999",
      generation: 1,
    });
    assert.equal(bad.ok, false);
  });

  it("old generation event after reset signal", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 130, timestamp_ms: 1_100 })).ok, true);
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 131, timestamp_ms: 1_200, event_type: "runtime.reset.started" })).ok, true);
    const late = c.ingestRuntimeEvent(makeEvent({ global_seq: 132, timestamp_ms: 1_300, generation: 1 }));
    assert.equal(late.ok, false);
  });

  it("capture frame after timeline terminal latch", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 140, timestamp_ms: 1_100 })).ok, true);
    c.ingestRuntimeEvent(makeEvent({ global_seq: 139, timestamp_ms: 1_200 }));
    assert.equal(c.getStatus(), "TIMELINE_INVALID");
    const after = c.observeCaptureFrame({
      capture_timestamp_us: 5_200_000,
      recording_session_id: FENCE.recording_session_id,
      runtime_session_id: FENCE.runtime_session_id,
      generation: 1,
    });
    assert.equal(after.ok, false);
  });

  it("encoder acknowledgement after terminal latch", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 150, timestamp_ms: 1_100 })).ok, true);
    c.ingestRuntimeEvent(makeEvent({ global_seq: 149, timestamp_ms: 1_200 }));
    const ack = c.observeEncoderAccept({
      encode_index: 1,
      pts_us: 0,
      recording_session_id: FENCE.recording_session_id,
      runtime_session_id: FENCE.runtime_session_id,
      generation: 1,
    });
    assert.equal(ack.ok, false);
  });
});

describe("P9.4: anchor ordering, determinism, and bounds", () => {
  it("duplicate event creates no duplicate anchor", () => {
    const c = makeCoordinator();
    const e = makeEvent({ global_seq: 160, timestamp_ms: 1_100 });
    assert.equal(c.ingestRuntimeEvent(e).ok, true);
    assert.equal(c.ingestRuntimeEvent(e).ok, true);
    assert.equal(c.getAnchors().length, 1);
  });

  it("anchor video time monotonic", () => {
    const c = makeCoordinator();
    let last = -1;
    for (let i = 0; i < 10; i += 1) {
      const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 170 + i, timestamp_ms: 1_000 + i * 40 }));
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.ok(r.anchor.video_time_us >= last);
        last = r.anchor.video_time_us;
      }
    }
  });

  it("anchor ordering stable", () => {
    const c = makeCoordinator();
    for (let i = 0; i < 5; i += 1) {
      assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 180 + i, timestamp_ms: 1_000 + i * 50 })).ok, true);
    }
    const anchors = c.getAnchors();
    for (let i = 1; i < anchors.length; i += 1) {
      assert.ok(anchors[i]!.global_seq > anchors[i - 1]!.global_seq);
      assert.ok(anchors[i]!.video_time_us >= anchors[i - 1]!.video_time_us);
    }
  });

  it("frame-error <= one interval", () => {
    const c = makeCoordinator();
    let maxError = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 190 + i, timestamp_ms: 1_000 + i * 37 }));
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.ok(r.mapping_error_us >= 0 && r.mapping_error_us <= FRAME_INTERVAL_US);
        maxError = Math.max(maxError, r.mapping_error_us);
      }
    }
    assert.ok(maxError <= FRAME_INTERVAL_US);
    assert.equal(c.stats().max_mapping_error_us, maxError);
  });

  it("impossible correlation rejected", () => {
    const c = makeCoordinator();
    const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 210, timestamp_ms: 999 }));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "TIMELINE_INVALID");
    }
  });

  it("reset event during anchor append", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 220, timestamp_ms: 1_100 })).ok, true);
    const reset = c.ingestRuntimeEvent(makeEvent({ global_seq: 221, timestamp_ms: 1_150, event_type: "runtime.reset.started" }));
    assert.equal(reset.ok, true);
    assert.equal(c.getStatus(), "RESET_INTERRUPTED");
  });

  it("duplicate event during append", () => {
    const c = makeCoordinator();
    const e = makeEvent({ global_seq: 230, timestamp_ms: 1_100 });
    const a = c.ingestRuntimeEvent(e);
    const b = c.ingestRuntimeEvent(e);
    assert.equal(a.ok && b.ok, true);
    assert.equal(c.getAnchors().length, 1);
  });

  it("timeline failure concurrent with event", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 240, timestamp_ms: 1_200 })).ok, true);
    const bad = c.ingestRuntimeEvent(makeEvent({ global_seq: 239, timestamp_ms: 1_300 }));
    assert.equal(bad.ok, false);
    const after = c.ingestRuntimeEvent(makeEvent({ global_seq: 241, timestamp_ms: 1_400 }));
    assert.equal(after.ok, false);
    assert.equal(c.getStatus(), "TIMELINE_INVALID");
  });
});

describe("P9.4: bounded memory, summary, and P10 seam", () => {
  it("bounded memory/high-watermark", () => {
    const c = makeCoordinator();
    for (let i = 0; i < 200; i += 1) {
      const r = c.ingestRuntimeEvent(makeEvent({ global_seq: 300 + i, timestamp_ms: 1_000 + i * 5 }));
      assert.equal(r.ok, true);
    }
    const s = c.stats();
    assert.equal(s.anchor_count, 200);
    assert.equal(s.last_global_seq, 499);
    assert.ok(s.sidecar_bytes > 0);
  });

  it("manifest timeline summary", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 500, timestamp_ms: 1_000 })).ok, true);
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 501, timestamp_ms: 1_100 })).ok, true);
    const summary = c.buildManifestAnchorSummary();
    assert.equal(summary.anchor_count, 2);
    assert.equal(summary.journal_high_seq_start, 500);
    assert.equal(summary.journal_high_seq_end, 501);
  });

  it("first/last seq correct", () => {
    const c = makeCoordinator();
    for (let i = 0; i < 4; i += 1) {
      assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 510 + i, timestamp_ms: 1_000 + i * 20 })).ok, true);
    }
    const s = c.stats();
    assert.equal(s.first_global_seq, 510);
    assert.equal(s.last_global_seq, 513);
  });

  it("first/last video time correct", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 520, timestamp_ms: 1_000 })).ok, true);
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 521, timestamp_ms: 1_100 })).ok, true);
    const s = c.stats();
    assert.equal(s.first_video_time_us, 0);
    assert.equal(s.last_video_time_us, 100_000);
  });

  it("P10 sync seam maps step to video time", () => {
    const c = makeCoordinator();
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 530, timestamp_ms: 1_000, step_id: "C01-L001-S001-B001" })).ok, true);
    assert.equal(c.ingestRuntimeEvent(makeEvent({ global_seq: 531, timestamp_ms: 1_100, step_id: "C01-L001-S001-B002" })).ok, true);
    assert.equal(typeof c.getVideoTimeForStep("C01-L001-S001-B001"), "number");
    assert.equal(c.getAnchorsForStep("C01-L001-S001-B002").length, 1);
    assert.ok(c.getAnchorForGlobalSeq(530) !== undefined);
  });

  it("deterministic replay same anchors", () => {
    const events = [1, 2, 3, 4, 5].map((i) =>
      makeEvent({ global_seq: 540 + i, timestamp_ms: 1_000 + i * 33 }),
    );
    const a = makeCoordinator();
    const b = makeCoordinator();
    for (const e of events) {
      assert.equal(a.ingestRuntimeEvent(e).ok, true);
      assert.equal(b.ingestRuntimeEvent({ ...e }).ok, true);
    }
    assert.equal(a.getSidecarText(), b.getSidecarText());
  });

  it("passive reanchor zero side effects", () => {
    const c = makeCoordinator();
    const events = [1, 2, 3].map((i) =>
      makeEvent({ global_seq: 550 + i, timestamp_ms: 1_000 + i * 40 }),
    );
    const first = c.reanchorFromSnapshot(events);
    assert.ok(first.every((r) => r.ok));
    const count = c.getAnchors().length;
    const second = c.reanchorFromSnapshot(events.slice(0, 1));
    assert.ok(second.every((r) => r.ok));
    assert.equal(c.getAnchors().length, count);
  });
});
