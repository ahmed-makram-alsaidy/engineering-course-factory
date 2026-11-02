// P9.2 capability + frame-format contract tests (matrix items 1-2, 10-14,
// 29-30 and pool/memory bounds).
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 6, 11, 19.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_BYTES_PER_PIXEL,
  CAPTURE_FRAME_BYTES_1080P,
  CAPTURE_FRAME_POOL_SIZE,
  CAPTURE_FRAME_SEQ_INITIAL,
  CAPTURE_HEIGHT,
  CAPTURE_PIXEL_FORMAT,
  CAPTURE_QUEUE_CAP,
  CAPTURE_WIDTH,
  CaptureFrameSchema,
  MAX_RETAINED_FRAME_BYTES,
  isCanonicalGeometry,
  isCoherentFrameLayout,
  retainedFrameBytes,
} from "../src/capture/capture-format.ts";
import {
  NativeCapabilitySchema,
  evaluateCaptureCapability,
  type NativeCapability,
} from "../src/capture/capture-capability.ts";
import { RecordingCaptureError } from "../src/capture/wgc-session.ts";
import { FRAME_SEQ_INITIAL } from "../src/timeline.ts";
import { FAKE_OWNER_PID, makeTestSession, openAndStart } from "./capture-helpers.ts";

const CANONICAL: NativeCapability = {
  backend: "wgc-window",
  wgc_supported: true,
  create_for_window_supported: true,
  d3d11_available: true,
  d3d_adapter: "hardware",
  cursor_disable_supported: true,
  border_disable_supported: true,
  os_build: 26200,
};

describe("P9.2: capability probe schema", () => {
  it("accepts a canonical capability record", () => {
    assert.deepEqual(NativeCapabilitySchema.parse(CANONICAL), CANONICAL);
  });

  it("rejects hostile capability fields (paths, handles, pointers)", () => {
    for (const hostile of [
      { path: "E:\\ffmpeg\\x.exe" },
      { hwnd: 131072 },
      { pid: 4242 },
      { nativePointer: "0x1234" },
      { ffmpegArgs: ["-y"] },
    ]) {
      assert.equal(
        NativeCapabilitySchema.safeParse({ ...CANONICAL, ...hostile }).success,
        false,
      );
    }
  });

  it("usable verdict requires every mandatory fact", () => {
    assert.equal(evaluateCaptureCapability(CANONICAL).usable, true);
    const mandatory: (keyof NativeCapability)[] = [
      "wgc_supported",
      "create_for_window_supported",
      "d3d11_available",
      "cursor_disable_supported",
    ];
    for (const key of mandatory) {
      const broken = { ...CANONICAL, [key]: false };
      const verdict = evaluateCaptureCapability(broken);
      assert.equal(verdict.usable, false, String(key));
      assert.ok(verdict.holdReasons.length > 0);
    }
  });

  it("unsupported WGC refuses the session with a sanitized error", () => {
    const test = makeTestSession({
      capability: { wgc_supported: false, create_for_window_supported: false },
    });
    assert.throws(() => test.session.open(), RecordingCaptureError);
    try {
      test.session.open();
      assert.fail("must throw");
    } catch (failure) {
      const dto = (failure as RecordingCaptureError).dto;
      assert.equal(dto.code, "INVALID_REQUEST");
      assert.equal(dto.phase, "PREFLIGHT");
    }
    test.session.close();
  });

  it("missing cursor-disable support holds (never silently captures cursor)", () => {
    const verdict = evaluateCaptureCapability({
      ...CANONICAL,
      cursor_disable_supported: false,
    });
    assert.equal(verdict.usable, false);
    assert.equal(verdict.cursorHidden, true);
    const test = makeTestSession({
      capability: { cursor_disable_supported: false },
    });
    assert.throws(() => test.session.open(), RecordingCaptureError);
    test.session.close();
  });

  it("border capability is recorded but never fatal", () => {
    const withBorder = evaluateCaptureCapability(CANONICAL);
    assert.equal(withBorder.borderSuppressed, true);
    const withoutBorder = evaluateCaptureCapability({
      ...CANONICAL,
      border_disable_supported: false,
    });
    assert.equal(withoutBorder.usable, true);
    assert.equal(withoutBorder.borderSuppressed, false);
    const test = makeTestSession({
      capability: { border_disable_supported: false },
    });
    test.session.open();
    test.session.start();
    assert.equal(test.session.stats().borderSuppressed, false);
    assert.equal(test.session.stats().cursorHidden, true);
    test.session.close();
  });

  it("warp adapter is explicit degraded, never silent", () => {
    const verdict = evaluateCaptureCapability({
      ...CANONICAL,
      d3d_adapter: "warp",
    });
    assert.equal(verdict.usable, true);
    assert.equal(verdict.degradedAdapter, true);
    assert.equal(evaluateCaptureCapability(CANONICAL).degradedAdapter, false);
  });
});

describe("P9.2: frame format and pool bounds", () => {
  it("intermediate pixel format is frozen bgra8", () => {
    assert.equal(CAPTURE_PIXEL_FORMAT, "bgra8");
    assert.equal(CAPTURE_BYTES_PER_PIXEL, 4);
  });

  it("canonical geometry is exactly 1920x1080", () => {
    assert.equal(CAPTURE_WIDTH, 1920);
    assert.equal(CAPTURE_HEIGHT, 1080);
    assert.ok(isCanonicalGeometry(1920, 1080));
    assert.ok(!isCanonicalGeometry(1600, 900));
    assert.ok(!isCanonicalGeometry(1920, 1200));
  });

  it("frame pool is bounded within 8..32 with bounded memory", () => {
    assert.ok(CAPTURE_FRAME_POOL_SIZE >= 8 && CAPTURE_FRAME_POOL_SIZE <= 32);
    assert.equal(CAPTURE_FRAME_BYTES_1080P, 1920 * 1080 * 4);
    assert.equal(
      MAX_RETAINED_FRAME_BYTES,
      retainedFrameBytes(CAPTURE_FRAME_POOL_SIZE),
    );
    assert.ok(MAX_RETAINED_FRAME_BYTES <= 96 * 1024 * 1024);
  });

  it("pending queue is bounded (metadata only, no pixel retention)", () => {
    assert.ok(CAPTURE_QUEUE_CAP >= 1 && CAPTURE_QUEUE_CAP <= 32);
  });

  it("frame_seq starts at 1 (P9.1 contract preserved)", () => {
    assert.equal(CAPTURE_FRAME_SEQ_INITIAL, 1);
    assert.equal(FRAME_SEQ_INITIAL, 1);
  });

  it("valid BGRA frame accepted with sequence from 1", () => {
    const test = makeTestSession({ defaultFrames: 1 });
    openAndStart(test);
    assert.equal(test.session.pump(), 1);
    const frame = test.session.take();
    assert.ok(frame !== undefined);
    assert.equal(frame.frame_seq, 1);
    assert.equal(frame.pixel_format, "bgra8");
    assert.equal(frame.width, 1920);
    assert.equal(frame.height, 1080);
    assert.equal(frame.generation, 1);
    assert.equal(frame.recording_session_id, "rec-p92-test-001");
    assert.ok(!("windowHandle" in frame));
    assert.ok(!("hwnd" in frame));
    test.session.close();
  });

  it("schema rejects non-BGRA pixel formats", () => {
    const base = {
      frame_seq: 1,
      capture_timestamp_us: 1000,
      capture_clock_epoch: "cap-epoch-1",
      width: 1920,
      height: 1080,
      stride_bytes: 7680,
      byte_length: 8294400,
      recording_session_id: "rec-p92-test-001",
      runtime_session_id: "sess-runtime-001",
      generation: 1,
    };
    assert.equal(
      CaptureFrameSchema.safeParse({ ...base, pixel_format: "bgra8" }).success,
      true,
    );
    for (const bad of ["rgb24", "yuv420p", "h264", "nv12"]) {
      assert.equal(
        CaptureFrameSchema.safeParse({ ...base, pixel_format: bad }).success,
        false,
        bad,
      );
    }
  });

  it("zero-size frame rejected without sequence advance", () => {
    const test = makeTestSession({
      script: [
        { kind: "frame", width: 0, height: 0 },
        { kind: "frame", width: 1920, height: 0 },
        { kind: "frame" },
      ],
    });
    openAndStart(test);
    assert.equal(test.session.pump(), 1);
    const stats = test.session.stats();
    assert.equal(stats.acceptedFrames, 1);
    assert.equal(stats.droppedFrames, 2);
    assert.equal(test.session.take()?.frame_seq, 1);
    test.session.close();
  });

  it("oversized geometry rejected", () => {
    const test = makeTestSession({
      script: [{ kind: "frame", width: 8000, height: 5000 }, { kind: "frame" }],
    });
    openAndStart(test);
    assert.equal(test.session.pump(), 1);
    assert.equal(test.session.stats().droppedFrames, 1);
    test.session.close();
  });

  it("incoherent stride rejected", () => {
    const narrow = {
      width: 1920,
      height: 1080,
      stride_bytes: 100,
      byte_length: 8294400,
    };
    assert.equal(isCoherentFrameLayout(narrow), false);
    assert.equal(
      isCoherentFrameLayout({
        width: 1920,
        height: 1080,
        stride_bytes: 7680,
        byte_length: 8294400,
      }),
      true,
    );
    assert.equal(
      isCoherentFrameLayout({
        width: 1920,
        height: 1080,
        stride_bytes: 8192,
        byte_length: 8192 * 1080,
      }),
      true,
    );
  });

  it("fake owner identity is the documented test constant", () => {
    assert.equal(FAKE_OWNER_PID, 4242);
  });
});
