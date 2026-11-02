// Tests for P8.1 Runtime Error Taxonomy & Sanitization
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 21 & 29.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ERROR_MESSAGE_LENGTH,
  RETRY_CATEGORIES,
  RUNTIME_ERROR_CODES,
  RuntimeError,
  RuntimeErrorCodeSchema,
  RuntimeErrorDtoSchema,
  defaultRetryForCode,
  sanitizeErrorMessage,
} from "../src/errors.ts";

describe("P8.1: Runtime Error Taxonomy", () => {
  it("all runtime error codes are unique", () => {
    const set = new Set(RUNTIME_ERROR_CODES);
    assert.equal(set.size, RUNTIME_ERROR_CODES.length);
    assert.equal(RUNTIME_ERROR_CODES.length, 19);
  });

  it("parses every registered error code", () => {
    for (const code of RUNTIME_ERROR_CODES) {
      assert.equal(RuntimeErrorCodeSchema.parse(code), code);
    }
  });

  it("rejects unknown error code", () => {
    assert.throws(() => RuntimeErrorCodeSchema.parse("UNKNOWN_ERROR"));
    assert.throws(() => RuntimeErrorCodeSchema.parse("FATAL_CRASH"));
    assert.throws(() => RuntimeErrorCodeSchema.parse(""));
  });

  it("retry taxonomy is closed with exactly four categories", () => {
    assert.equal(RETRY_CATEGORIES.length, 4);
    assert.deepEqual([...RETRY_CATEGORIES], [
      "SAFE_TO_RETRY",
      "NOT_RETRYABLE",
      "REQUIRES_RESET",
      "UNCERTAIN_DO_NOT_RETRY",
    ]);
  });

  it("defaultRetryForCode maps every registered code safely", () => {
    for (const code of RUNTIME_ERROR_CODES) {
      const retry = defaultRetryForCode(code);
      assert.ok(RETRY_CATEGORIES.includes(retry));
    }
    assert.equal(defaultRetryForCode("ENGINE_OUTCOME_UNCERTAIN"), "UNCERTAIN_DO_NOT_RETRY");
    assert.equal(defaultRetryForCode("CLEANUP_UNCONFIRMED"), "UNCERTAIN_DO_NOT_RETRY");
    assert.equal(defaultRetryForCode("STALE_GENERATION"), "REQUIRES_RESET");
    assert.equal(defaultRetryForCode("PREFLIGHT_VALIDATION_FAILED"), "NOT_RETRYABLE");
  });
});

describe("P8.1: Message Sanitization", () => {
  it("redacts Windows absolute paths", () => {
    const raw = "File read failed at E:\\course-factory\\workspace\\secret.env and C:\\Users\\Administrator\\token.txt";
    const clean = sanitizeErrorMessage(raw);
    assert.ok(!clean.includes("E:\\course-factory"));
    assert.ok(!clean.includes("C:\\Users"));
    assert.ok(clean.includes("[path]"));
  });

  it("redacts POSIX absolute paths", () => {
    const raw = "Permission denied at /home/user/repo/.git/config";
    const clean = sanitizeErrorMessage(raw);
    assert.ok(!clean.includes("/home/user"));
    assert.ok(clean.includes("[path]"));
  });

  it("redacts UNC paths", () => {
    const raw = "Network path \\\\fileserver\\shared\\keys unreachable";
    const clean = sanitizeErrorMessage(raw);
    assert.ok(!clean.includes("\\\\fileserver\\shared"));
    assert.ok(clean.includes("[path]"));
  });

  it("strips JavaScript stack traces", () => {
    const raw = `Error: Something failed
    at executeCommand (E:\\course-factory\\src\\runner.ts:42:15)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;
    const clean = sanitizeErrorMessage(raw);
    assert.ok(!clean.includes("runner.ts"));
    assert.ok(!clean.includes("at executeCommand"));
  });

  it("enforces MAX_ERROR_MESSAGE_LENGTH ceiling", () => {
    const longMessage = "A".repeat(1000);
    const clean = sanitizeErrorMessage(longMessage);
    assert.ok(clean.length <= MAX_ERROR_MESSAGE_LENGTH);
    assert.ok(clean.endsWith("..."));
  });

  it("handles non-string or empty input safely", () => {
    assert.equal(sanitizeErrorMessage("" as any), "[sanitized error]");
    assert.equal(sanitizeErrorMessage(null as any), "[sanitized error]");
  });
});

describe("P8.1: RuntimeError and RuntimeErrorDto", () => {
  it("RuntimeError serializes to a clean, validated DTO", () => {
    const err = new RuntimeError({
      code: "DEPENDENCY_NOT_MET",
      message: "Port 3000 not reachable at E:\\course-factory\\temp\\log.txt",
      requestId: "req-001",
      stepId: "C01-L001-S001-B005",
    });

    const dto = err.toDto();
    const validated = RuntimeErrorDtoSchema.parse(dto);

    assert.equal(validated.code, "DEPENDENCY_NOT_MET");
    assert.equal(validated.retry, "NOT_RETRYABLE");
    assert.equal(validated.request_id, "req-001");
    assert.equal(validated.step_id, "C01-L001-S001-B005");
    assert.ok(!validated.message.includes("E:\\course-factory"));
    assert.ok(validated.message.includes("[path]"));
  });

  it("RuntimeError retains internal cause without leaking to DTO", () => {
    const underlying = new Error("Root OS socket ECONNREFUSED");
    const err = new RuntimeError({
      code: "ENGINE_DISPATCH_FAILED",
      message: "Browser launch timeout",
      cause: underlying,
    });

    assert.equal(err.cause, underlying);
    const dto = err.toDto();
    assert.equal((dto as any).cause, undefined);
  });

  it("RuntimeErrorDto rejects hostile extra keys", () => {
    const hostile = {
      code: "ENGINE_DISPATCH_FAILED",
      message: "Failed",
      retry: "NOT_RETRYABLE",
      request_id: "req-1",
      stack: "Error: raw stack trace",
      command: "rm -rf /",
    };
    assert.throws(() => RuntimeErrorDtoSchema.parse(hostile));
  });

  it("RuntimeErrorDto enforces UNCERTAIN_DO_NOT_RETRY invariant for uncertain errors", () => {
    // Valid combination
    assert.doesNotThrow(() =>
      RuntimeErrorDtoSchema.parse({
        code: "ENGINE_OUTCOME_UNCERTAIN",
        message: "Side effect unknown",
        retry: "UNCERTAIN_DO_NOT_RETRY",
        request_id: null,
      })
    );

    // Invalid combination: UNCERTAIN cannot be SAFE_TO_RETRY
    assert.throws(() =>
      RuntimeErrorDtoSchema.parse({
        code: "ENGINE_OUTCOME_UNCERTAIN",
        message: "Side effect unknown",
        retry: "SAFE_TO_RETRY",
        request_id: null,
      })
    );

    // Invalid combination: CLEANUP_UNCONFIRMED cannot be NOT_RETRYABLE
    assert.throws(() =>
      RuntimeErrorDtoSchema.parse({
        code: "CLEANUP_UNCONFIRMED",
        message: "Container absence not confirmed",
        retry: "NOT_RETRYABLE",
        request_id: null,
      })
    );
  });
});
