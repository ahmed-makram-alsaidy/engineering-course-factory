// P9.3 encoder policy tests: capability descriptors, selection, fixed argv,
// bounds, and timeouts (unit matrix 1-13).
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 11-13. Deterministic,
// offline, zero processes, zero disk.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ENCODER_DRAIN_TIMEOUT_MS,
  ENCODER_EXIT_TIMEOUT_MS,
  ENCODER_PROBE_TIMEOUT_MS,
  ENCODER_PROCESS_STATES,
  ENCODER_QUEUE_CAP_FRAMES,
  ENCODER_STARTUP_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  MAX_ENCODER_QUEUE_BYTES,
  P93_FPS,
  P93_FLUSH_TIMEOUT_MS,
  initialEncoderRunStats,
  parseToolVersion,
  selectEncoderFamily,
} from "../src/encoder/encoder-interface.ts";
import {
  argvEquals,
  buildEncodeArgv,
  buildFfprobeArgv,
  buildProbeArgv,
  encodeArgvOutputPath,
  parseEncoderList,
} from "../src/encoder/encoder-argv.ts";

describe("P9.3: FFmpeg capability descriptor valid", () => {
  it("parses ffmpeg and ffprobe version banners without paths", () => {
    assert.equal(
      parseToolVersion("ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright", "ffmpeg"),
      "8.1.1-full_build-www.gyan.dev",
    );
    assert.equal(
      parseToolVersion("ffprobe version 8.1.1-full_build-www.gyan.dev Copyright", "ffprobe"),
      "8.1.1-full_build-www.gyan.dev",
    );
  });

  it("rejects foreign banners and inline control characters", () => {
    assert.equal(parseToolVersion("avconv version 1.0", "ffmpeg"), null);
    assert.equal(parseToolVersion("", "ffmpeg"), null);
    assert.equal(parseToolVersion("ffmpeg version 8.1\u0000evil", "ffmpeg"), null);
    // CRLF tool output tolerated; multi-line input parses its first line.
    assert.equal(parseToolVersion("ffmpeg version 8.1.1-foo\r", "ffmpeg"), "8.1.1-foo");
    assert.equal(parseToolVersion("ffmpeg version 8.1\ninjected", "ffmpeg"), "8.1");
  });
});

describe("P9.3: FFprobe capability descriptor valid", () => {
  it("ffprobe version parses independently of ffmpeg", () => {
    assert.equal(parseToolVersion("ffprobe version 7.0.2", "ffprobe"), "7.0.2");
    assert.equal(parseToolVersion("ffmpeg version 7.0.2", "ffprobe"), null);
  });
});

describe("P9.3: NVENC actual probe success/failure normalization", () => {
  it("listing alone never authorizes NVENC without a passing self-test", () => {
    const selection = selectEncoderFamily(
      { listed: true, selfTest: "fail" },
      { listed: true, selfTest: "pass" },
    );
    assert.equal(selection.ok, true);
    assert.equal(selection.ok && selection.descriptor.family, "LIBX264");
  });
});

describe("P9.3: libx264 probe", () => {
  it("encoder list pre-filter distinguishes listed from missing", () => {
    const list = parseEncoderList(" V....D h264_nvenc foo\n V....D libx264 bar\n");
    assert.equal(list.nvencListed, true);
    assert.equal(list.libx264Listed, true);
    const empty = parseEncoderList(" V....D mpeg4 xyz\n");
    assert.equal(empty.nvencListed, false);
    assert.equal(empty.libx264Listed, false);
  });
});

describe("P9.3: fixed profile selection", () => {
  it("NVENC chosen when healthy with no fallback flag", () => {
    const selection = selectEncoderFamily(
      { listed: true, selfTest: "pass" },
      { listed: true, selfTest: "pass" },
    );
    assert.equal(selection.ok, true);
    if (selection.ok) {
      assert.equal(selection.descriptor.family, "NVENC");
      assert.equal(selection.descriptor.profile, "nvenc-p4-cq23");
      assert.equal(selection.descriptor.profile_version, "1.0");
      assert.equal(selection.descriptor.fallback_used, false);
      assert.ok(!("fallback_reason" in selection.descriptor));
    }
  });

  it("NVENC chosen when healthy", () => {
    const selection = selectEncoderFamily(
      { listed: true, selfTest: "pass" },
      { listed: false, selfTest: "fail" },
    );
    assert.equal(selection.ok && selection.descriptor.family, "NVENC");
  });

  it("libx264 fallback explicit with reason when NVENC missing", () => {
    const selection = selectEncoderFamily(
      { listed: false, selfTest: "fail" },
      { listed: true, selfTest: "pass" },
    );
    assert.equal(selection.ok, true);
    if (selection.ok) {
      assert.equal(selection.descriptor.family, "LIBX264");
      assert.equal(selection.descriptor.profile, "libx264-veryfast-crf21");
      assert.equal(selection.descriptor.fallback_used, true);
      assert.equal(selection.descriptor.fallback_reason, "NVENC_ENCODER_MISSING");
    }
  });

  it("libx264 fallback explicit when NVENC self-test failed", () => {
    const selection = selectEncoderFamily(
      { listed: true, selfTest: "fail" },
      { listed: true, selfTest: "pass" },
    );
    assert.equal(selection.ok, true);
    if (selection.ok) {
      assert.equal(selection.descriptor.fallback_reason, "NVENC_SELF_TEST_FAILED");
    }
  });

  it("context-unavailable maps to the explicit context reason", () => {
    const selection = selectEncoderFamily(
      { listed: true, selfTest: "fail", contextUnavailable: true },
      { listed: true, selfTest: "pass" },
    );
    assert.equal(selection.ok, true);
    if (selection.ok) {
      assert.equal(selection.descriptor.fallback_reason, "NVENC_CONTEXT_UNAVAILABLE");
    }
  });

  it("no encoder available failure when both self-tests fail", () => {
    const selection = selectEncoderFamily(
      { listed: true, selfTest: "fail" },
      { listed: true, selfTest: "fail" },
    );
    assert.equal(selection.ok, false);
    if (!selection.ok) {
      assert.equal(selection.code, "ENCODER_UNAVAILABLE");
    }
  });

  it("libx264 without a passing self-test never selected", () => {
    const selection = selectEncoderFamily(
      { listed: false, selfTest: "fail" },
      { listed: true, selfTest: "fail" },
    );
    assert.equal(selection.ok, false);
  });
});

describe("P9.3: canonical geometry only", () => {
  it("encode argv carries exactly 1920x1080", () => {
    const argv = buildEncodeArgv({
      family: "NVENC",
      geometry: { width: 1920, height: 1080, fps: 30 },
      outputPath: "E:\\x\\screen.partial.mp4",
    });
    assert.ok(argv.includes("1920x1080"));
    assert.throws(() =>
      buildEncodeArgv({
        family: "NVENC",
        geometry: { width: 1280, height: 720, fps: 30 } as never,
        outputPath: "E:\\x\\screen.partial.mp4",
      }),
    );
  });
});

describe("P9.3: canonical FPS only", () => {
  it("argv carries framerate 30 and rate 30", () => {
    const argv = buildEncodeArgv({
      family: "LIBX264",
      geometry: { width: 1920, height: 1080, fps: 30 },
      outputPath: "E:\\x\\screen.partial.mp4",
    });
    const rateIndex = argv.indexOf("-framerate");
    assert.equal(argv[rateIndex + 1], "30");
    assert.equal(P93_FPS, 30);
  });
});

describe("P9.3: canonical BGRA input only", () => {
  it("rawvideo pipe contract is fixed bgra 1920x1080 30 pipe:0", () => {
    const argv = buildEncodeArgv({
      family: "NVENC",
      geometry: { width: 1920, height: 1080, fps: 30 },
      outputPath: "E:\\x\\screen.partial.mp4",
    });
    assert.deepEqual([...argv].slice(0, 13), [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-y",
      "-f",
      "rawvideo",
      "-pixel_format",
      "bgra",
      "-video_size",
      "1920x1080",
      "-framerate",
      "30",
      "-i",
    ]);
    assert.equal(argv[13], "pipe:0");
  });
});

describe("P9.3: canonical MP4/H264 output only", () => {
  it("NVENC argv is byte-exact frozen", () => {
    const argv = buildEncodeArgv({
      family: "NVENC",
      geometry: { width: 1920, height: 1080, fps: 30 },
      outputPath: "OUT",
    });
    assert.ok(
      argvEquals(argv, [
        "-hide_banner", "-loglevel", "warning", "-y",
        "-f", "rawvideo", "-pixel_format", "bgra",
        "-video_size", "1920x1080", "-framerate", "30",
        "-i", "pipe:0",
        "-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23",
        "-vf", "format=yuv420p", "-g", "60", "-r", "30",
        "-maxrate", "12M", "-bufsize", "24M",
        "-movflags", "+faststart", "-an", "OUT",
      ]),
    );
  });

  it("libx264 argv is byte-exact frozen", () => {
    const argv = buildEncodeArgv({
      family: "LIBX264",
      geometry: { width: 1920, height: 1080, fps: 30 },
      outputPath: "OUT",
    });
    assert.ok(
      argvEquals(argv, [
        "-hide_banner", "-loglevel", "warning", "-y",
        "-f", "rawvideo", "-pixel_format", "bgra",
        "-video_size", "1920x1080", "-framerate", "30",
        "-i", "pipe:0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
        "-vf", "format=yuv420p", "-g", "60", "-r", "30",
        "-maxrate", "12M", "-bufsize", "24M",
        "-movflags", "+faststart", "-an", "OUT",
      ]),
    );
  });

  it("output path is always the final argv element", () => {
    const argv = buildEncodeArgv({
      family: "NVENC",
      geometry: { width: 1920, height: 1080, fps: 30 },
      outputPath: "E:\\take\\screen.partial.mp4",
    });
    assert.equal(encodeArgvOutputPath(argv), "E:\\take\\screen.partial.mp4");
  });
});

describe("P9.3: audio NONE", () => {
  it("every encode argv carries exactly one -an and no audio codec", () => {
    for (const family of ["NVENC", "LIBX264"] as const) {
      const argv = buildEncodeArgv({
        family,
        geometry: { width: 1920, height: 1080, fps: 30 },
        outputPath: "OUT",
      });
      assert.equal(argv.filter((a) => a === "-an").length, 1);
      assert.ok(!argv.some((a) => a === "aac" || a === "-c:a"));
    }
  });
});

describe("P9.3: probe argv bounded and fixed", () => {
  it("self-test probes are 1 s testsrc with fixed size and rate", () => {
    const argv = buildProbeArgv({ family: "NVENC", outputPath: "PROBE" });
    assert.ok(argv.includes("testsrc=size=320x180:rate=10:duration=1"));
    assert.ok(argv.includes("1"));
    assert.equal(argv[argv.length - 1], "PROBE");
  });

  it("ffprobe argv is JSON format+streams+bounded packets", () => {
    const argv = buildFfprobeArgv("TARGET");
    assert.deepEqual(argv, [
      "-hide_banner", "-v", "error",
      "-show_format", "-show_streams", "-show_packets",
      "-read_intervals", "%+#60",
      "-print_format", "json", "TARGET",
    ]);
  });
});

describe("P9.3: process bounds frozen", () => {
  it("queue bound is 12 frames within the 96 MiB target", () => {
    assert.equal(ENCODER_QUEUE_CAP_FRAMES, 12);
    assert.ok(MAX_ENCODER_QUEUE_BYTES <= 96 * 1024 * 1024);
    assert.equal(MAX_ENCODER_QUEUE_BYTES, 12 * 1920 * 1080 * 4);
  });

  it("all waits are bounded", () => {
    assert.equal(ENCODER_PROBE_TIMEOUT_MS, 30_000);
    assert.equal(ENCODER_STARTUP_TIMEOUT_MS, 15_000);
    assert.equal(ENCODER_DRAIN_TIMEOUT_MS, 5_000);
    assert.equal(ENCODER_EXIT_TIMEOUT_MS, 10_000);
    assert.equal(FFPROBE_TIMEOUT_MS, 15_000);
    assert.equal(P93_FLUSH_TIMEOUT_MS, 30_000);
  });

  it("internal process states never collide with RecordingState", () => {
    assert.ok(ENCODER_PROCESS_STATES.includes("ENCODING"));
    assert.ok(!ENCODER_PROCESS_STATES.includes("RECORDING" as never));
    assert.ok(!ENCODER_PROCESS_STATES.includes("PUBLISHED" as never));
  });

  it("initial stats are zeroed and schema-valid", () => {
    const stats = initialEncoderRunStats();
    assert.equal(stats.state, "CREATED");
    assert.equal(stats.accepted_frames, 0);
    assert.equal(stats.media_digest, null);
  });
});
