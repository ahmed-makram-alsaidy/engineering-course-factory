// Tests for P9.1 Recording Protocol v1: versions, identities, states,
// outcomes, publication status, error taxonomy + retry mapping, snapshot,
// internal start descriptor, epoch contract, fencing, privacy validation.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 15-16, ADR-0014.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION } from "@course-factory/shared-types";
import { COMPILED_IR_VERSION } from "@course-factory/lesson-compiler/ir";
import {
  CaptureSourceTokenSchema,
  InternalRecordingStartDescriptorSchema,
  MAX_TAKE_DURATION_US,
  PUBLICATION_STATUSES,
  RECORDING_ERROR_CODES,
  RECORDING_ERROR_RETRY_MAP,
  RECORDING_OUTCOMES,
  RECORDING_PHASES,
  RECORDING_PROTOCOL_VERSION,
  RECORDING_RETRY_CATEGORIES,
  RECORDING_STATES,
  RECORDING_TERMINAL_CAUSES,
  RecordingEpochSchema,
  RecordingErrorDtoSchema,
  RecordingGenerationSchema,
  RecordingSessionIdSchema,
  RecordingSnapshotDtoSchema,
  RecordingStateSchema,
  TakeFenceSchema,
  TakeIdSchema,
  isPrivacySafeText,
  isStaleGeneration,
  matchesTakeFence,
  sanitizeRecordingMessage,
  terminalCauseToOutcome,
  toRecordingErrorDto,
} from "../src/protocol.ts";

describe("P9.1: recording protocol version is frozen", () => {
  it("recording protocol version is exactly 1", () => {
    assert.equal(RECORDING_PROTOCOL_VERSION, 1);
  });

  it("recording protocol version is distinct from the P8 runtime protocol concept", () => {
    assert.equal(typeof RECORDING_PROTOCOL_VERSION, "number");
    assert.ok(Number.isInteger(RECORDING_PROTOCOL_VERSION));
  });
});

describe("P9.1: canonical recording identity", () => {
  it("accepts a valid recording_session_id", () => {
    assert.equal(
      RecordingSessionIdSchema.parse("rec-C01-L001-20260914-01"),
      "rec-C01-L001-20260914-01",
    );
  });

  it("rejects an invalid recording_session_id (empty, spaces, slashes)", () => {
    for (const bad of ["", "has space", "a/b", "a\\b", ".leading-dot", "-lead"]) {
      assert.ok(!RecordingSessionIdSchema.safeParse(bad).success, bad);
    }
  });

  it("accepts a valid take_id (t01)", () => {
    assert.equal(TakeIdSchema.parse("t01"), "t01");
  });

  it("rejects invalid take_id values", () => {
    for (const bad of ["", "take-1", "1", "t1", "T01", "t-01", "t 01"]) {
      assert.ok(!TakeIdSchema.safeParse(bad).success, bad);
    }
  });

  it("rejects invalid runtime_session_id", () => {
    assert.ok(!RecordingSessionIdSchema.safeParse("").success);
    assert.ok(!RecordingSessionIdSchema.safeParse("sess with space").success);
  });

  it("accepts generation >= 1 and rejects invalid generations", () => {
    assert.equal(RecordingGenerationSchema.parse(1), 1);
    for (const bad of [0, -1, 1.5, NaN, Infinity, "1", null]) {
      assert.ok(!RecordingGenerationSchema.safeParse(bad).success, String(bad));
    }
  });

  it("identity shape rejects paths, ports, and spaced names", () => {
    const hostile = [
      "E:\\course-factory\\temp",
      "\\\\server\\share",
      "/home/user/x",
      "127.0.0.1:3000",
      "has:colon",
      "has space",
    ];
    for (const bad of hostile) {
      assert.ok(!RecordingSessionIdSchema.safeParse(bad).success, bad);
    }
  });
});

describe("P9.1: recording states, outcomes, publication status", () => {
  it("recording state table is frozen at 10 canonical states", () => {
    assert.deepEqual([...RECORDING_STATES], [
      "CREATED",
      "PREFLIGHT",
      "PREPARED",
      "RECORDING",
      "STOPPING",
      "VALIDATING",
      "PUBLISHED",
      "FAILED",
      "INCOMPLETE",
      "CLOSED",
    ]);
  });

  it("rejects invented states", () => {
    assert.ok(!RecordingStateSchema.safeParse("PAUSED").success);
    assert.ok(!RecordingStateSchema.safeParse("RECORDING_PAUSED").success);
    assert.ok(!RecordingStateSchema.safeParse("capTURING").success);
  });

  it("outcome buckets are the 5 design buckets", () => {
    assert.deepEqual([...RECORDING_OUTCOMES], [
      "COMPLETED",
      "CANCELLED",
      "RESET_INTERRUPTED",
      "FAILED",
      "INCOMPLETE",
    ]);
  });

  it("terminal causes are fine-grained and map to design buckets", () => {
    assert.equal(RECORDING_TERMINAL_CAUSES.length, 11);
    assert.equal(terminalCauseToOutcome("SUCCESS"), "COMPLETED");
    assert.equal(terminalCauseToOutcome("OPERATOR_CANCELLED"), "CANCELLED");
    assert.equal(terminalCauseToOutcome("RESET_INTERRUPTED"), "RESET_INTERRUPTED");
    assert.equal(terminalCauseToOutcome("CAPTURE_SOURCE_LOST"), "FAILED");
    assert.equal(terminalCauseToOutcome("LOW_DISK_ABORT"), "INCOMPLETE");
    assert.equal(terminalCauseToOutcome("ENCODER_FAILED"), "FAILED");
    assert.equal(terminalCauseToOutcome("MEDIA_VALIDATION_FAILED"), "FAILED");
    assert.equal(terminalCauseToOutcome("APP_CLOSED"), "INCOMPLETE");
    assert.equal(terminalCauseToOutcome("DIAGNOSTIC_PARTIAL"), "FAILED");
    assert.equal(terminalCauseToOutcome("PREFLIGHT_REFUSED"), "INCOMPLETE");
    assert.equal(terminalCauseToOutcome("STARTUP_TIMEOUT"), "INCOMPLETE");
  });

  it("publication statuses are the 6 frozen values", () => {
    assert.deepEqual([...PUBLICATION_STATUSES], [
      "NOT_CREATED",
      "TEMPORARY",
      "QUARANTINED",
      "VALIDATED",
      "PUBLISHED",
      "PURGED",
    ]);
  });

  it("recording phases are the 7 frozen values", () => {
    assert.equal(RECORDING_PHASES.length, 7);
  });
});

describe("P9.1: error taxonomy and retry mapping", () => {
  it("error taxonomy holds exactly the 19 canonical codes", () => {
    assert.equal(RECORDING_ERROR_CODES.length, 19);
    for (const code of [
      "INVALID_REQUEST",
      "STALE_GENERATION",
      "RECORDER_ALREADY_ACTIVE",
      "DISK_PREFLIGHT_FAILED",
      "LOW_DISK_ABORT",
      "CAPTURE_SOURCE_LOST",
      "ENCODER_FAILED",
      "MEDIA_VALIDATION_FAILED",
      "TIMELINE_INVALID",
      "PUBLICATION_FAILED",
      "CLEANUP_UNCONFIRMED",
    ]) {
      assert.ok(
        (RECORDING_ERROR_CODES as readonly string[]).includes(code),
        code,
      );
    }
  });

  it("retry taxonomy is closed with exactly four categories", () => {
    assert.deepEqual([...RECORDING_RETRY_CATEGORIES], [
      "SAFE_TO_RETRY",
      "NOT_RETRYABLE",
      "REQUIRES_RESET",
      "UNCERTAIN_DO_NOT_RETRY",
    ]);
  });

  it("no partial/publication/reset/uncertain code maps to SAFE_TO_RETRY", () => {
    for (const [code, retry] of Object.entries(RECORDING_ERROR_RETRY_MAP)) {
      assert.notEqual(retry, "SAFE_TO_RETRY", code);
    }
    assert.equal(RECORDING_ERROR_RETRY_MAP["STALE_GENERATION"], "REQUIRES_RESET");
    assert.equal(RECORDING_ERROR_RETRY_MAP["STALE_SESSION"], "REQUIRES_RESET");
    assert.equal(
      RECORDING_ERROR_RETRY_MAP["CLEANUP_UNCONFIRMED"],
      "UNCERTAIN_DO_NOT_RETRY",
    );
    assert.equal(RECORDING_ERROR_RETRY_MAP["PUBLICATION_FAILED"], "NOT_RETRYABLE");
  });

  it("error DTO enforces the frozen retry mapping", () => {
    const good = {
      code: "CAPTURE_SOURCE_LOST",
      message: "capture source lost",
      retry: "NOT_RETRYABLE",
    } as const;
    assert.ok(RecordingErrorDtoSchema.safeParse(good).success);
    const bad = { ...good, retry: "SAFE_TO_RETRY" };
    assert.ok(!RecordingErrorDtoSchema.safeParse(bad).success);
  });

  it("error DTO rejects unknown keys and exposes only safe fields", () => {
    const hostile = {
      code: "ENCODER_FAILED",
      message: "encoder failed",
      retry: "NOT_RETRYABLE",
      stack: "Error\n    at foo (E:\\x\\y.ts:1:1)",
      pid: 1234,
    };
    assert.ok(!RecordingErrorDtoSchema.safeParse(hostile).success);
  });

  it("toRecordingErrorDto sanitizes and applies the frozen mapping", () => {
    const dto = toRecordingErrorDto({
      code: "ENCODER_FAILED",
      message: "boom at E:\\course-factory\\x.ts:1:1",
      recording_session_id: "rec-a",
      take_id: "t01",
      phase: "ENCODING",
    });
    assert.equal(dto.retry, "NOT_RETRYABLE");
    assert.ok(!dto.message.includes("E:\\course-factory"));
  });
});

describe("P9.1: privacy-safe text validation", () => {
  it("rejects Windows absolute paths, UNC paths, POSIX paths, newlines", () => {
    assert.equal(isPrivacySafeText("plain version 8.1.1-full_build"), true);
    assert.equal(isPrivacySafeText("E:\\course-factory\\temp"), false);
    assert.equal(isPrivacySafeText("\\\\server\\share\\x"), false);
    assert.equal(isPrivacySafeText("/home/user/repo"), false);
    assert.equal(isPrivacySafeText("line1\nline2"), false);
    assert.equal(isPrivacySafeText("tab\there"), false);
  });

  it("sanitizeRecordingMessage redacts paths and strips stacks", () => {
    const clean = sanitizeRecordingMessage(
      "fail E:\\course-factory\\x.ts:1:1\n    at foo (E:\\y\\z.ts:2:2)",
    );
    assert.ok(!clean.includes("E:\\course-factory"));
    assert.ok(!clean.includes("at foo"));
    assert.ok(clean.length <= 512);
  });
});

describe("P9.1: snapshot, start descriptor, epoch, fencing", () => {
  it("accepts a safe RecordingSnapshotDto", () => {
    const snap = {
      recording_session_id: "rec-C01-L001-20260914-01",
      take_id: "t01",
      state: "RECORDING",
      runtime_session_id: "sess-runtime-001",
      generation: 1,
      elapsed_us: 1_000_000,
      captured_frames: 30,
      encoded_frames: 30,
      dropped_frames: 0,
      filler_frames: 0,
      encoder_family: "NVENC",
      record_safe: true,
      last_outcome: null,
    };
    assert.ok(RecordingSnapshotDtoSchema.safeParse(snap).success);
  });

  it("snapshot rejects semantic payload injection", () => {
    const hostile = {
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
      command: "npm run evil",
      selector: "#x",
      url: "http://127.0.0.1:9999/",
    };
    assert.ok(!RecordingSnapshotDtoSchema.safeParse(hostile).success);
  });

  it("internal start descriptor accepts trusted fields only", () => {
    const good = {
      lesson_id: "C01-L001",
      runtime_session_id: "sess-runtime-001",
      generation: 1,
      take_id: "t01",
      recording_profile_id: "rec-1080p30-h264-v1",
      record_safe: true,
    };
    assert.ok(InternalRecordingStartDescriptorSchema.safeParse(good).success);
    const hostile = {
      ...good,
      outputPath: "E:\\evil\\out.mp4",
      ffmpegArgs: ["-y"],
      hwnd: 12345,
      record_safe: false,
    };
    assert.ok(!InternalRecordingStartDescriptorSchema.safeParse(hostile).success);
  });

  it("capture-source token is opaque and internal-only", () => {
    assert.ok(CaptureSourceTokenSchema.safeParse("cap-source-001").success);
    assert.ok(!CaptureSourceTokenSchema.safeParse("").success);
  });

  it("epoch contract carries opaque epochs and skew bound, no QPC", () => {
    const good = {
      capture_clock_epoch: "epoch-cap-001",
      runtime_clock_epoch: "epoch-run-001",
      epoch_skew_bound_us: 500,
    };
    assert.ok(RecordingEpochSchema.safeParse(good).success);
    const withQpc = { ...good, qpc_ticks: 123456789 };
    assert.ok(!RecordingEpochSchema.safeParse(withQpc).success);
  });

  it("one-generation-per-take fence predicates behave", () => {
    const take = {
      recording_session_id: "rec-a",
      runtime_session_id: "sess-1",
      generation: 1,
    };
    assert.ok(TakeFenceSchema.safeParse(take).success);
    assert.equal(matchesTakeFence(take, take), true);
    const stale = { ...take, generation: 2 };
    assert.equal(matchesTakeFence(stale, take), false);
    assert.equal(isStaleGeneration(stale, take), true);
    assert.equal(isStaleGeneration(take, take), false);
    const otherSession = { ...take, runtime_session_id: "sess-2" };
    assert.equal(matchesTakeFence(otherSession, take), false);
  });

  it("take duration ceiling equals 30 min + 2 s tail", () => {
    assert.equal(MAX_TAKE_DURATION_US, 1_802_000_000);
  });

  it("canonical Schema version remains 1.1 (no schema change)", () => {
    assert.equal(SCHEMA_VERSION, "1.1");
  });

  it("canonical Compiled IR version remains 1.0 (no IR change)", () => {
    assert.equal(COMPILED_IR_VERSION, "1.0");
  });
});
