// P9.2 trusted-source + driver-surface tests (matrix items 3-4, 31-34).
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 4-6 and ADR-0014
// (threats T3, T10: renderer has no capture-scope authority).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPTURE_DRIVER_METHODS,
  CaptureBackendError,
  hasFixedDriverSurface,
} from "../src/capture/capture-driver.ts";
import { CaptureFrameSchema } from "../src/capture/capture-format.ts";
import { FakeCaptureDriver } from "../src/capture/fake-driver.ts";
import {
  RecordingCaptureError,
  WgcCaptureSession,
} from "../src/capture/wgc-session.ts";
import {
  TrustedCaptureSourceRegistry,
  UnknownCaptureSourceError,
} from "../src/capture/trusted-source.ts";
import {
  InternalRecordingStartDescriptorSchema,
  RecordingErrorDtoSchema,
  RecordingSnapshotDtoSchema,
} from "../src/protocol.ts";
import { RecordingManifestSchema } from "../src/manifest.ts";
import { RecordingTimelineAnchorSchema } from "../src/timeline.ts";
import { EncoderDescriptorSchema } from "../src/encoder-profile.ts";
import { makeAnchor, makeManifestSeed } from "./fixtures.ts";
import { buildCanonicalManifest } from "../src/manifest.ts";
import { FAKE_OWNER_PID, makeTestSession, openAndStart } from "./capture-helpers.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

describe("P9.2: trusted source resolution", () => {
  it("invalid capture source rejected (null handle)", () => {
    const registry = new TrustedCaptureSourceRegistry();
    assert.throws(
      () => registry.issue({ windowHandle: 0n, ownerPid: FAKE_OWNER_PID }),
      UnknownCaptureSourceError,
    );
    assert.throws(
      () => registry.issue({ windowHandle: -7n, ownerPid: FAKE_OWNER_PID }),
      UnknownCaptureSourceError,
    );
  });

  it("invalid owner rejected at issuance", () => {
    const registry = new TrustedCaptureSourceRegistry();
    assert.throws(
      () => registry.issue({ windowHandle: 0x1000n, ownerPid: 0 }),
      UnknownCaptureSourceError,
    );
  });

  it("unknown token rejected on resolve and open", () => {
    const registry = new TrustedCaptureSourceRegistry();
    assert.throws(() => registry.resolve("wsrc-nope"), UnknownCaptureSourceError);
    assert.throws(() => registry.resolve(""), UnknownCaptureSourceError);
    assert.throws(
      () => registry.resolve("../../../etc/passwd"),
      UnknownCaptureSourceError,
    );
    const test = makeTestSession();
    test.registry.revoke(test.token);
    try {
      test.session.open();
      assert.fail("must throw");
    } catch (failure) {
      assert.equal((failure as RecordingCaptureError).dto.code, "INVALID_IDENTITY");
    }
    test.session.close();
  });

  it("destroyed source rejected (window no longer exists)", () => {
    const registry = new TrustedCaptureSourceRegistry();
    const driver = new FakeCaptureDriver();
    const issued = registry.issue({ windowHandle: 0xdeadn, ownerPid: FAKE_OWNER_PID });
    const session = new WgcCaptureSession({
      fence: {
        recording_session_id: "rec-p92-test-002",
        runtime_session_id: "sess-runtime-001",
        generation: 1,
      },
      takeId: "t01",
      driver,
      registry,
      token: issued.token,
    });
    try {
      session.open();
      assert.fail("must throw");
    } catch (failure) {
      assert.equal((failure as RecordingCaptureError).dto.code, "CAPTURE_SOURCE_LOST");
    }
    session.close();
  });

  it("wrong owner rejected (window belongs elsewhere)", () => {
    const registry = new TrustedCaptureSourceRegistry();
    const driver = new FakeCaptureDriver();
    const issued = registry.issue({ windowHandle: 0x1000n, ownerPid: 9999 });
    const session = new WgcCaptureSession({
      fence: {
        recording_session_id: "rec-p92-test-003",
        runtime_session_id: "sess-runtime-001",
        generation: 1,
      },
      takeId: "t01",
      driver,
      registry,
      token: issued.token,
    });
    try {
      session.open();
      assert.fail("must throw");
    } catch (failure) {
      assert.equal((failure as RecordingCaptureError).dto.code, "INVALID_IDENTITY");
    }
    session.close();
  });

  it("revoked tokens stay revoked (no resurrection)", () => {
    const registry = new TrustedCaptureSourceRegistry();
    const issued = registry.issue({ windowHandle: 0x1000n, ownerPid: FAKE_OWNER_PID });
    assert.equal(registry.liveCount, 1);
    registry.revoke(issued.token);
    assert.equal(registry.liveCount, 0);
    assert.throws(() => registry.resolve(issued.token), UnknownCaptureSourceError);
    registry.revoke(issued.token);
    registry.revokeAll();
  });

  it("renderer cannot supply window identity through any public schema", () => {
    const schemas: Record<string, { safeParse(v: unknown): { success: boolean } }> = {
      manifest: RecordingManifestSchema,
      anchor: RecordingTimelineAnchorSchema,
      snapshot: RecordingSnapshotDtoSchema,
      "start-descriptor": InternalRecordingStartDescriptorSchema,
      "error-dto": RecordingErrorDtoSchema,
      "encoder-descriptor": EncoderDescriptorSchema,
      "capture-frame": CaptureFrameSchema,
    };
    const bases: Record<string, Record<string, unknown>> = {
      manifest: { ...buildCanonicalManifest(makeManifestSeed()) },
      anchor: { ...makeAnchor() },
      snapshot: {
        recording_session_id: "rec-a",
        take_id: "t01",
        state: "RECORDING",
        runtime_session_id: "sess-1",
        generation: 1,
        elapsed_us: 10,
        captured_frames: 1,
        encoded_frames: 1,
        dropped_frames: 0,
        filler_frames: 0,
        encoder_family: "NVENC",
        record_safe: true,
        last_outcome: null,
      },
      "start-descriptor": {
        lesson_id: "C01-L001",
        runtime_session_id: "sess-1",
        generation: 1,
        take_id: "t01",
        recording_profile_id: "rec-1080p30-h264-v1",
        record_safe: true,
      },
      "error-dto": { code: "ENCODER_FAILED", message: "x", retry: "NOT_RETRYABLE" },
      "encoder-descriptor": {
        family: "NVENC",
        profile: "nvenc-p4-cq23",
        profile_version: "1.0",
        fallback_used: false,
        encoder_version: "8.1.1",
      },
      "capture-frame": {
        frame_seq: 1,
        capture_timestamp_us: 1000,
        capture_clock_epoch: "cap-epoch-1",
        width: 1920,
        height: 1080,
        pixel_format: "bgra8",
        stride_bytes: 7680,
        byte_length: 8294400,
        recording_session_id: "rec-a",
        runtime_session_id: "sess-1",
        generation: 1,
      },
    };
    for (const key of ["hwnd", "windowHandle", "window_handle", "pid", "ownerPid", "owner_pid", "handle"]) {
      for (const name of Object.keys(schemas)) {
        assert.equal(
          schemas[name]!.safeParse({ ...bases[name], [key]: 131072 }).success,
          false,
          `${name} accepted '${key}'`,
        );
      }
    }
  });
});

describe("P9.2: fixed driver surface (no scope creep)", () => {
  it("driver surface is exactly the seven fixed operations", () => {
    assert.deepEqual([...CAPTURE_DRIVER_METHODS], [
      "probe",
      "open",
      "start",
      "acquire",
      "stop",
      "close",
      "stats",
    ]);
    assert.ok(hasFixedDriverSurface(new FakeCaptureDriver()));
  });

  it("no desktop, monitor, coordinate, or discovery entry points", () => {
    const driver = new FakeCaptureDriver() as unknown as Record<string, unknown>;
    for (const forbidden of [
      "captureDesktop",
      "captureMonitor",
      "captureWindow",
      "setCoordinates",
      "findWindow",
      "enumWindows",
      "setRawPointer",
      "encode",
      "spawnEncoder",
    ]) {
      assert.equal(forbidden in driver, false, forbidden);
    }
  });

  it("production source has no arbitrary-window or desktop capture tokens", () => {
    const srcDir = join(__dirname, "..", "src", "capture");
    const nativeDir = join(__dirname, "..", "native", "wgc", "src");
    const files: string[] = [];
    for (const entry of readdirSync(srcDir)) {
      if (entry.endsWith(".ts")) {
        files.push(join(srcDir, entry));
      }
    }
    for (const entry of readdirSync(nativeDir)) {
      if (entry.endsWith(".cc") || entry.endsWith(".h")) {
        files.push(join(nativeDir, entry));
      }
    }
    const forbidden = [
      "CreateForMonitor",
      "desktopCapturer",
      "CopyFromScreen",
      "EnumWindows",
      "FindWindow",
      "BitBlt",
      "DuplicateOutput",
      "IDXGIOutputDuplication",
      "MonitorFrom",
      "GetMonitorInfo",
    ];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const token of forbidden) {
        assert.ok(!content.includes(token), `${file} contains '${token}'`);
      }
    }
  });

  it("typed backend errors carry bounded codes only", () => {
    const failure = new CaptureBackendError("DEVICE_LOST", "device removed");
    assert.equal(failure.nativeCode, "DEVICE_LOST");
  });
});
