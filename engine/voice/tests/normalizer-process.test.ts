// P10.4 Normalizer Process Safety & Tool Resolution Test Suite
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 31.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePinnedFfmpeg,
  runTrustedFfmpeg,
  searchPathForExecutable,
} from "../host/normalizer-process.ts";

describe("normalizer-process: tool resolution", () => {
  it("resolves pinned FFmpeg from environment", () => {
    const ffmpegPath = resolvePinnedFfmpeg();
    assert.equal(typeof ffmpegPath, "string");
    assert.ok(ffmpegPath.length > 0);
  });

  it("throws descriptive error when tool cannot be pinned", () => {
    assert.throws(
      () => resolvePinnedFfmpeg({ ffmpegPath: "C:\\nonexistent\\path\\to\\ffmpeg.exe" }),
      /\[ENCODER_UNAVAILABLE\]/,
    );
  });

  it("searchPathForExecutable returns null for non-existent executable", () => {
    const notFound = searchPathForExecutable("definitely-non-existent-ffmpeg-binary-12345");
    assert.equal(notFound, null);
  });
});

describe("normalizer-process: execution and safety", () => {
  const ffmpeg = resolvePinnedFfmpeg();

  it("runs version probe with shell:false and captures output", async () => {
    const result = await runTrustedFfmpeg({
      ffmpegPath: ffmpeg,
      argv: ["-version"],
    });

    assert.equal(result.exitCode, 0);
    const stdout = result.stdout.toString("utf8");
    assert.ok(stdout.includes("ffmpeg version"));
  });

  it("fails closed on invalid argv", async () => {
    await assert.rejects(
      () =>
        runTrustedFfmpeg({
          ffmpegPath: ffmpeg,
          argv: ["-invalid_flag_definitely_fails"],
        }),
      /\[NORMALIZATION_FAILED\]/,
    );
  });

  it("respects cancellation before execution", async () => {
    const ac = new AbortController();
    ac.abort();

    await assert.rejects(
      () =>
        runTrustedFfmpeg({
          ffmpegPath: ffmpeg,
          argv: ["-version"],
          signal: ac.signal,
        }),
      /\[CANCELLED\]/,
    );
  });

  it("respects timeout and terminates owned child process", async () => {
    // Pipe null output with short 10ms timeout on a command that waits
    const ac = new AbortController();
    await assert.rejects(
      () =>
        runTrustedFfmpeg({
          ffmpegPath: ffmpeg,
          argv: ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "5", "-f", "null", "-"],
          timeoutMs: 20,
        }),
      /\[TIMEOUT\]/,
    );
  });
});
