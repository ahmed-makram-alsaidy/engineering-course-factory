// P9.8 proof-helper units — deterministic, offline, zero sleeps/processes.
//
// Covers the pure proof computations in electron/recording-proof-helpers.ts:
// canonical invocation parsing, exact 30/1 rational goldens, anchor mapping
// errors, evidence scrubbing, frame-diversity gates, byte variance.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countDistinctP98Frames,
  countP98FrameTransitions,
  isCanonicalP98Invocation,
  isP98SafeLogLine,
  p98AnchorMappingErrorUs,
  p98ByteVariance,
  p98FrameIndexForElapsedUs,
  p98VerbatimManifestFrames,
  p98VideoTimeForFrameIndex,
  parseP98Argv,
  parseP98Framemd5,
  passesP98DiversityGate,
  scrubP98EvidenceText,
} from "../electron/recording-proof-helpers.ts";

describe("p98 proof argv parsing", () => {
  it("recognizes the canonical proof invocation only", () => {
    const canonical = parseP98Argv(["--proof-p98", "--smoke-p615", "--record-safe", "--window-size=1920x1080"]);
    assert.equal(isCanonicalP98Invocation(canonical), true);
    assert.equal(isCanonicalP98Invocation(parseP98Argv(["--proof-p98", "--smoke-p615", "--window-size=1920x1080"])), false);
    assert.equal(isCanonicalP98Invocation(parseP98Argv(["--proof-p98", "--smoke-p615", "--record-safe", "--window-size=1600x900"])), false);
    assert.equal(isCanonicalP98Invocation(parseP98Argv(["--smoke-p615", "--record-safe", "--window-size=1920x1080"])), false);
    assert.equal(isCanonicalP98Invocation(parseP98Argv([])), false);
  });
});

describe("p98 exact rational 30/1 CFR goldens", () => {
  it("maps canonical frame indices to exact video times with zero drift", () => {
    assert.equal(p98VideoTimeForFrameIndex(0), 0);
    assert.equal(p98VideoTimeForFrameIndex(1), 33_333);
    assert.equal(p98VideoTimeForFrameIndex(2), 66_666);
    assert.equal(p98VideoTimeForFrameIndex(29), 966_666);
    assert.equal(p98VideoTimeForFrameIndex(30), 1_000_000);
    assert.equal(p98VideoTimeForFrameIndex(300), 10_000_000);
    assert.equal(p98VideoTimeForFrameIndex(1800), 60_000_000);
  });

  it("inverts elapsed microseconds to the preceding frame index", () => {
    assert.equal(p98FrameIndexForElapsedUs(0), 0);
    assert.equal(p98FrameIndexForElapsedUs(33_333), 0);
    assert.equal(p98FrameIndexForElapsedUs(33_334), 1);
    assert.equal(p98FrameIndexForElapsedUs(1_000_000), 30);
  });

  it("keeps anchor mapping errors within one frame interval", () => {
    const error = p98AnchorMappingErrorUs({ anchorRuntimeMs: 1050.5, takeStartRuntimeMs: 1000, anchorVideoTimeUs: 33_333 });
    assert.ok(error >= 0 && error < 33_334, `mapping error in bound, got ${error}`);
    const late = p98AnchorMappingErrorUs({ anchorRuntimeMs: 2000, takeStartRuntimeMs: 1000, anchorVideoTimeUs: 1_000_000 });
    assert.equal(late, 0);
  });
});

describe("p98 evidence scrubbing", () => {
  it("redacts host paths and bounds output", () => {
    assert.equal(scrubP98EvidenceText("failed at D:\\course-factory\\x"), "failed at [path]");
    assert.equal(scrubP98EvidenceText("\\\\server\\share\\x"), "[path]");
    assert.equal(scrubP98EvidenceText(42), "[scrubbed]");
  });

  it("flags unsafe log lines carrying host identity", () => {
    assert.equal(isP98SafeLogLine("P98_TAKE captured=180 encoded=180"), true);
    assert.equal(isP98SafeLogLine("P98_MEDIA drive=D: free=ok"), true);
    assert.equal(isP98SafeLogLine("wrote D:\\course-factory\\renders\\x.mp4"), false);
    assert.equal(isP98SafeLogLine("window HWND 0x00000000001203AA ready"), false);
    assert.equal(isP98SafeLogLine("child pid: 1234 exited"), false);
  });
});

describe("p98 frame diversity", () => {
  it("counts distinct digests and gates frozen video", () => {
    assert.equal(countDistinctP98Frames(["a", "A ", "b", "a", "c"]), 3);
    assert.equal(passesP98DiversityGate(["a", "a", "a"]), false);
    assert.equal(passesP98DiversityGate(["a", "b", "c"]), true);
  });

  it("measures byte variance with zero for uniform input", () => {
    assert.equal(p98ByteVariance(new Uint8Array(0)), 0);
    assert.equal(p98ByteVariance(new Uint8Array([7, 7, 7, 7])), 0);
    assert.ok(p98ByteVariance(new Uint8Array([0, 255, 0, 255])) > 1000);
  });
});

describe("p98 Manifest 1.1 verbatim frame mapping", () => {
  it("maps settlement truth verbatim to Manifest 1.1 without projection", () => {
    const frames = p98VerbatimManifestFrames({
      capturedFrames: 10,
      encodedFrames: 257,
      droppedFrames: 0,
      coalescedFrames: 3,
      fillerFrames: 247,
    });
    assert.equal(frames.captured_frame_count, 10);
    assert.equal(frames.encoded_frame_count, 257);
    assert.equal(frames.dropped_frame_count, 0);
    assert.equal(frames.coalesced_frame_count, 3);
    assert.equal(frames.filler_frame_count, 247);
  });

  it("parses framemd5 stdout and counts transitions", () => {
    const stdout = [
      "#tb 0: 1/30",
      "#media_type 0: video",
      "0, 0, 0, 1, 6220800, aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0, 1, 1, 1, 6220800, aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0, 2, 2, 1, 6220800, bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0, 3, 3, 1, 6220800, cccccccccccccccccccccccccccccccc",
      "",
    ].join("\n");
    const digests = parseP98Framemd5(stdout);
    assert.deepEqual(digests, [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "cccccccccccccccccccccccccccccccc",
    ]);
    assert.equal(countDistinctP98Frames(digests), 3);
    assert.equal(countP98FrameTransitions(digests), 2);
    assert.equal(passesP98DiversityGate(digests), true);
  });
});
