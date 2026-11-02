// P9.2 session lifecycle + ordering + fencing tests (matrix items 5-9,
// 15-28 and watchdog/starvation state).
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 6, 9, 16, 19, 23.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NATIVE_TO_RECORDING_ERROR, RecordingCaptureError } from "../src/capture/wgc-session.ts";
import { NO_VALID_FRAME_MS } from "../src/capture/wgc-session.ts";
import { CAPTURE_QUEUE_CAP } from "../src/capture/capture-format.ts";
import { makeTestSession, openAndStart } from "./capture-helpers.ts";

describe("P9.2: geometry enforcement", () => {
  it("valid 1920x1080 source accepted", () => {
    const test = makeTestSession();
    const opened = test.session.open();
    assert.deepEqual(opened, { itemWidth: 1920, itemHeight: 1080 });
    test.session.close();
  });

  it("geometry mismatch rejected at preflight (no silent scale)", () => {
    const test = makeTestSession({ itemWidth: 1600, itemHeight: 900 });
    try {
      test.session.open();
      assert.fail("must throw");
    } catch (failure) {
      const dto = (failure as RecordingCaptureError).dto;
      assert.equal(dto.code, "WINDOW_GEOMETRY_MISMATCH");
      assert.equal(dto.phase, "PREFLIGHT");
      assert.ok(dto.message.includes("1920x1080"));
    }
    assert.equal(test.driver.closeCalls, 1);
    test.session.close();
  });
});

describe("P9.2: frame sequencing and timestamp ordering", () => {
  it("frame_seq increments strictly with no reuse on drops", () => {
    const test = makeTestSession({ defaultFrames: 5 });
    openAndStart(test);
    assert.equal(test.session.pump(), 5);
    const seqs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      seqs.push(test.session.take()!.frame_seq);
    }
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
    test.session.close();
  });

  it("timestamp decrease drops the frame without reusing sequence", () => {
    const test = makeTestSession({
      script: [
        { kind: "frame", timestampUs: 2000000 },
        { kind: "frame", timestampUs: 1000000 },
        { kind: "frame", timestampUs: 3000000 },
      ],
    });
    openAndStart(test);
    assert.equal(test.session.pump(), 2);
    const stats = test.session.stats();
    assert.equal(stats.acceptedFrames, 2);
    assert.equal(stats.droppedFrames, 1);
    assert.equal(test.session.take()?.frame_seq, 1);
    assert.equal(test.session.take()?.frame_seq, 2);
    assert.equal(test.session.take(), undefined);
    test.session.close();
  });

  it("equal timestamps preserve ordering (non-decreasing allowed)", () => {
    const test = makeTestSession({
      script: [
        { kind: "frame", timestampUs: 5000000 },
        { kind: "frame", timestampUs: 5000000 },
      ],
    });
    openAndStart(test);
    assert.equal(test.session.pump(), 2);
    test.session.close();
  });

  it("slow consumer keeps a bounded queue with drop-oldest accounting", () => {
    const test = makeTestSession({ defaultFrames: 20 });
    openAndStart(test);
    assert.equal(test.session.pump(), 20);
    const stats = test.session.stats();
    assert.equal(stats.pendingFrames, CAPTURE_QUEUE_CAP);
    assert.equal(stats.acceptedFrames, 20);
    assert.equal(stats.droppedFrames, 20 - CAPTURE_QUEUE_CAP);
    // Oldest retained frame continues the sequence (1..8 dropped, 9 first).
    assert.equal(test.session.take()?.frame_seq, 20 - CAPTURE_QUEUE_CAP + 1);
    test.session.close();
  });

  it("queue never exceeds its cap under repeated pumps", () => {
    const test = makeTestSession({ defaultFrames: 200 });
    openAndStart(test);
    for (let i = 0; i < 10; i += 1) {
      test.session.pump();
      assert.ok(test.session.pendingCount <= CAPTURE_QUEUE_CAP);
    }
    test.session.close();
  });
});

describe("P9.2: lifecycle, reentrancy, and fencing", () => {
  it("start once, duplicate start deterministic", () => {
    const test = makeTestSession();
    test.session.open();
    test.session.start();
    try {
      test.session.start();
      assert.fail("must throw");
    } catch (failure) {
      assert.equal((failure as RecordingCaptureError).dto.code, "RECORDER_ALREADY_ACTIVE");
    }
    assert.equal(test.session.stats().state, "started");
    test.session.close();
  });

  it("start before open rejected", () => {
    const test = makeTestSession();
    assert.throws(() => test.session.start(), RecordingCaptureError);
    test.session.close();
  });

  it("stop active session, duplicate stop deterministic", () => {
    const test = makeTestSession({ defaultFrames: 3 });
    openAndStart(test);
    test.session.pump();
    const first = test.session.stop();
    assert.equal(first.acceptedFrames, 3);
    const second = test.session.stop();
    assert.deepEqual(second, first);
    assert.equal(test.driver.stopCalls, 1);
    test.session.close();
  });

  it("close after stop releases everything exactly once", () => {
    const test = makeTestSession();
    openAndStart(test);
    test.session.stop();
    test.session.close();
    test.session.close();
    assert.equal(test.driver.closeCalls, 1);
    assert.equal(test.session.stats().state, "closed");
  });

  it("operations after close fail or drain safely (no resurrection)", () => {
    const test = makeTestSession();
    openAndStart(test);
    test.session.close();
    assert.throws(() => test.session.open(), RecordingCaptureError);
    assert.throws(() => test.session.start(), RecordingCaptureError);
    assert.equal(test.session.pump(), 0);
    assert.equal(test.session.take(), undefined);
    assert.equal(test.driver.closeCalls, 1);
  });

  it("pump after stop accepts nothing (late frames fenced)", () => {
    const test = makeTestSession({ defaultFrames: 10 });
    openAndStart(test);
    test.session.pump();
    const acceptedBefore = test.session.stats().acceptedFrames;
    test.session.stop();
    assert.equal(test.session.pump(), 0);
    assert.equal(test.session.stats().acceptedFrames, acceptedBefore);
    test.session.close();
  });

  it("close during source-close callback is deterministic", () => {
    const test = makeTestSession({
      script: [{ kind: "frame" }, { kind: "source-lost" }],
    });
    openAndStart(test);
    let calls = 0;
    test.session.onSourceClosed(() => {
      calls += 1;
      test.session.close();
    });
    test.session.pump();
    assert.equal(calls, 1);
    assert.equal(test.session.stats().state, "closed");
    assert.equal(test.session.pump(), 0);
  });

  it("one capture session maximum per workstation", () => {
    const first = makeTestSession();
    const second = makeTestSession();
    first.session.open();
    first.session.start();
    second.session.open();
    try {
      second.session.start();
      assert.fail("must throw");
    } catch (failure) {
      assert.equal((failure as RecordingCaptureError).dto.code, "RECORDER_ALREADY_ACTIVE");
    }
    first.session.stop();
    second.session.start();
    assert.equal(second.session.stats().state, "started");
    first.session.close();
    second.session.close();
  });
});

describe("P9.2: source loss, geometry change, device loss", () => {
  it("source-close event propagated exactly once", () => {
    const test = makeTestSession({
      script: [{ kind: "frame" }, { kind: "source-lost" }, { kind: "frame" }],
    });
    openAndStart(test);
    let calls = 0;
    test.session.onSourceClosed(() => {
      calls += 1;
    });
    assert.equal(test.session.pump(), 1);
    assert.equal(calls, 1);
    assert.equal(test.session.stats().sourceLost, true);
    // Pre-loss accepted frame remains deliverable; nothing new arrives.
    assert.equal(test.session.take()?.frame_seq, 1);
    assert.equal(test.session.pump(), 0);
    assert.equal(calls, 1);
    test.session.close();
  });

  it("geometry-change event propagated with safe dimensions, then held", () => {
    const test = makeTestSession({
      script: [
        { kind: "frame" },
        { kind: "geometry-changed", width: 1600, height: 900 },
        { kind: "frame" },
      ],
    });
    openAndStart(test);
    let seen: { observedWidth: number; observedHeight: number } | null = null;
    test.session.onGeometryChange((info) => {
      seen = {
        observedWidth: info.observedWidth,
        observedHeight: info.observedHeight,
      };
    });
    assert.equal(test.session.pump(), 1);
    assert.deepEqual(seen, { observedWidth: 1600, observedHeight: 900 });
    assert.equal(test.session.stats().geometryChanged, true);
    assert.equal(test.session.pump(), 0);
    test.session.close();
  });

  it("per-frame canonical drift latches geometry hold", () => {
    const test = makeTestSession({
      script: [
        { kind: "frame", width: 1920, height: 1080 },
        { kind: "frame", width: 1280, height: 720 },
      ],
    });
    openAndStart(test);
    assert.equal(test.session.pump(), 1);
    assert.equal(test.session.stats().geometryChanged, true);
    test.session.close();
  });

  it("device-lost translated to a latched typed condition", () => {
    const test = makeTestSession({
      script: [
        { kind: "frame" },
        { kind: "throw", code: "DEVICE_LOST", message: "device removed" },
        { kind: "frame" },
      ],
    });
    openAndStart(test);
    assert.equal(test.session.pump(), 1);
    const stats = test.session.stats();
    assert.equal(stats.deviceLost, true);
    assert.equal(stats.sourceLost, true);
    test.session.close();
  });

  it("native error vocabulary maps to the frozen protocol codes", () => {
    assert.equal(NATIVE_TO_RECORDING_ERROR["DEVICE_LOST"].code, "CAPTURE_SOURCE_LOST");
    assert.equal(NATIVE_TO_RECORDING_ERROR["GEOMETRY_MISMATCH"].code, "WINDOW_GEOMETRY_MISMATCH");
    assert.equal(NATIVE_TO_RECORDING_ERROR["INVALID_SOURCE"].code, "INVALID_IDENTITY");
    assert.equal(NATIVE_TO_RECORDING_ERROR["WRONG_OWNER"].code, "INVALID_IDENTITY");
    assert.equal(NATIVE_TO_RECORDING_ERROR["ALREADY_STARTED"].code, "RECORDER_ALREADY_ACTIVE");
  });

  it("raw native failures sanitized (no COM text, paths, or stacks)", () => {
    const test = makeTestSession({
      openThrow: {
        raw: "HRESULT 0x80070005 at E:\\secret\\native.cc:12\n at foo (E:\\bar)",
      },
    });
    try {
      test.session.open();
      assert.fail("must throw");
    } catch (failure) {
      const dto = (failure as RecordingCaptureError).dto;
      assert.equal(dto.code, "CAPTURE_SOURCE_LOST");
      assert.ok(!dto.message.includes("E:\\"));
      assert.ok(!dto.message.includes("HRESULT"));
      assert.ok(!dto.message.includes(" at "));
    }
    test.session.close();
  });
});

describe("P9.2: no-valid-frame watchdog state", () => {
  it("watchdog reports starvation after 2 s without valid frames", () => {
    const test = makeTestSession({ defaultFrames: 1 });
    openAndStart(test);
    let state = test.session.watchdogState();
    assert.equal(state.lastValidFrameMs, null);
    assert.equal(state.starved, false);
    test.session.pump();
    state = test.session.watchdogState();
    assert.equal(state.lastValidFrameMs, 1000);
    assert.equal(state.starved, false);
    test.clock.advance(NO_VALID_FRAME_MS - 1);
    assert.equal(test.session.watchdogState().starved, false);
    test.clock.advance(1);
    const starved = test.session.watchdogState();
    assert.equal(starved.starved, true);
    assert.equal(starved.starvedMs, NO_VALID_FRAME_MS);
    test.session.close();
  });

  it("fresh valid frame clears starvation", () => {
    const test = makeTestSession({
      script: [{ kind: "frame" }, { kind: "empty" }, { kind: "frame" }],
    });
    openAndStart(test);
    assert.equal(test.session.pump(), 1);
    test.clock.advance(5000);
    assert.equal(test.session.watchdogState().starved, true);
    assert.equal(test.session.pump(), 1);
    assert.equal(test.session.watchdogState().starved, false);
    test.session.close();
  });

  it("detection window is exactly the frozen 2 s", () => {
    assert.equal(NO_VALID_FRAME_MS, 2000);
  });
});
