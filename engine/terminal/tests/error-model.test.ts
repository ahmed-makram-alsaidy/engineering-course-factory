// P5.1 error model tests — the protocol carries the exact design taxonomy and
// every code maps to exactly one outcome category.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_CODE_CATEGORY,
  RUNTIME_EVENT_VERSION,
  RuntimeErrorCodeSchema,
  RuntimeEventSchema,
} from "../src/protocol.ts";

/** The exact design code set (table + codes named in the design text). */
const DESIGN_CODES = [
  "INVALID_REQUEST",
  "WRONG_OWNER",
  "STALE_SESSION",
  "DUPLICATE_START",
  "INVALID_PROCESS_REFERENCE",
  "PROCESS_NOT_STARTED",
  "IR_INVALID",
  "IR_RUNTIME_INCONSISTENT",
  "NOT_AUTHORIZED",
  "DOCKER_UNAVAILABLE",
  "WRONG_BACKEND",
  "STORAGE_UNVERIFIED",
  "IMAGE_UNAVAILABLE",
  "WORKSPACE_VIOLATION",
  "UNSUPPORTED_COMMAND_PROFILE",
  "SPAWN_FAILED",
  "EXIT_CODE_MISMATCH",
  "TIMEOUT",
  "OUTPUT_LIMIT",
  "LOG_BACKPRESSURE",
  "TRANSPORT_FAILED",
  "PROTOCOL_FAILED",
  "LEASE_EXPIRED",
  "BACKGROUND_EXITED_EARLY",
  "UNEXPECTED_DESCENDANTS",
  "CANCELLED",
  "CLEANUP_UNCONFIRMED",
  "UNSUPPORTED_PHASE",
  // P5.3 HOLD codes (workspace/environment resolution; no execution machinery).
  "WORKSPACE_UNAVAILABLE",
  "ENVIRONMENT_POLICY_VIOLATION",
  // P5.10 reject code (process-output waits; already-dead target, zero wait).
  "PROCESS_EXITED",
] as const;

describe("P5.1 error model", () => {
  it("carries exactly the design code set", () => {
    const defined = RuntimeErrorCodeSchema.options;
    assert.deepEqual([...defined].sort(), [...DESIGN_CODES].sort());
    assert.equal(defined.length, DESIGN_CODES.length);
  });

  it("rejects unknown codes", () => {
    assert.equal(RuntimeErrorCodeSchema.safeParse("SHell_DENIED").success, false);
    assert.equal(RuntimeErrorCodeSchema.safeParse("ALREADY_EXITED").success, false, "ALREADY_EXITED is a stop outcome, not an error code");
  });

  it("maps every code to exactly one outcome category", () => {
    for (const code of DESIGN_CODES) {
      assert.ok(code in ERROR_CODE_CATEGORY, `${code} must be categorized`);
    }
    assert.equal(Object.keys(ERROR_CODE_CATEGORY).length, DESIGN_CODES.length);
  });

  it("category counts match the design table", () => {
    const counts = { reject: 0, hold: 0, fail: 0, skipped: 0 };
    for (const category of Object.values(ERROR_CODE_CATEGORY)) counts[category] += 1;
    // P5.3 amendment: +2 HOLD codes (WORKSPACE_UNAVAILABLE, ENVIRONMENT_POLICY_VIOLATION).
    // P5.10 amendment: +1 reject code (PROCESS_EXITED — already-dead wait target).
    assert.deepEqual(counts, { reject: 7, hold: 13, fail: 10, skipped: 1 });
  });

  it("spot-checks the design table rows", () => {
    // "Reject, zero spawn, preserve legitimate work."
    // (P5.10: PROCESS_EXITED joins this row — reject, zero wait, legitimate
    // background lifetime preserved.)
    for (const code of ["INVALID_REQUEST", "WRONG_OWNER", "STALE_SESSION", "DUPLICATE_START", "INVALID_PROCESS_REFERENCE", "PROCESS_NOT_STARTED", "PROCESS_EXITED"]) {
      assert.equal(ERROR_CODE_CATEGORY[code as keyof typeof ERROR_CODE_CATEGORY], "reject", code);
    }
    // Prerequisite HOLD, no host fallback.
    for (const code of ["DOCKER_UNAVAILABLE", "WRONG_BACKEND", "STORAGE_UNVERIFIED", "IMAGE_UNAVAILABLE"]) {
      assert.equal(ERROR_CODE_CATEGORY[code as keyof typeof ERROR_CODE_CATEGORY], "hold", code);
    }
    // FAIL with teardown.
    for (const code of ["SPAWN_FAILED", "EXIT_CODE_MISMATCH", "TIMEOUT", "OUTPUT_LIMIT", "UNEXPECTED_DESCENDANTS"]) {
      assert.equal(ERROR_CODE_CATEGORY[code as keyof typeof ERROR_CODE_CATEGORY], "fail", code);
    }
    // "CANCELLED | SKIPPED, cleanup confirmed."
    assert.equal(ERROR_CODE_CATEGORY.CANCELLED, "skipped");
    // "CLEANUP_UNCONFIRMED | HOLD, original cause retained."
    assert.equal(ERROR_CODE_CATEGORY.CLEANUP_UNCONFIRMED, "hold");
    // "UNSUPPORTED_PHASE | HOLD, no later-phase execution."
    assert.equal(ERROR_CODE_CATEGORY.UNSUPPORTED_PHASE, "hold");
  });

  it("codes are usable inside structured failure events", () => {
    const event = RuntimeEventSchema.parse({
      runtime_event_version: RUNTIME_EVENT_VERSION,
      session_id: "sess-1",
      generation: 1,
      seq: 1,
      monotonic_ms: 0,
      operation_id: "op",
      attempt_id: "att",
      course_id: "C01",
      lesson_id: "L011",
      scene_id: "S014",
      beat_id: "b",
      process_id: null,
      type: "process.failed",
      payload: { code: "EXIT_CODE_MISMATCH", message: "actual 7, expected 0" },
    });
    assert.equal((event.payload as { code: string }).code, "EXIT_CODE_MISMATCH");

    const completed = RuntimeEventSchema.parse({
      runtime_event_version: RUNTIME_EVENT_VERSION,
      session_id: "sess-1",
      generation: 1,
      seq: 2,
      monotonic_ms: 5,
      operation_id: "op",
      attempt_id: "att",
      course_id: "C01",
      lesson_id: "L011",
      scene_id: "S014",
      beat_id: "b",
      process_id: null,
      type: "operation.completed",
      payload: { outcome: "SKIPPED", reason: "CANCELLED", exit_code: null, forced: false },
    });
    const completedPayload = completed.payload as { outcome: string; reason: string };
    assert.equal(completedPayload.outcome, "SKIPPED");
    assert.equal(completedPayload.reason, "CANCELLED");
  });
});
