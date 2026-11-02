// P5.1 runtime protocol tests — valid objects parse, malformed objects are
// rejected, canonical state enums reject unknown values, event ordering
// metadata is representable, output channels are distinguishable, logical
// process ids and course/lesson/scene/beat provenance round-trip, runtime
// session identity stays separate from lesson identity, and the compiled IR
// contract remains uncontaminated by runtime state.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCompiledLesson } from "@course-factory/lesson-compiler/ir";
import {
  ContainerLifecycleStateSchema,
  OperationOutcomeSchema,
  OperationResultSchema,
  ProcessStateSchema,
  RUNTIME_EVENT_VERSION,
  RuntimeEventSchema,
  RuntimeSessionIdentitySchema,
} from "../src/protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Synthetic portable identity — no machine paths anywhere in fixtures. */
const SESSION = "sess-20260906-cf51-a1b2c3d4";
const PROVENANCE = {
  course_id: "C01",
  lesson_id: "L011",
  scene_id: "S014",
  beat_id: "run-dev-server",
};

/** Payload arrives as unknown (discriminated at runtime); tests read it through this typed view. */
function pay(event: { payload: unknown }): Record<string, any> {
  return event.payload as Record<string, any>;
}

function makeEvent(overrides: Record<string, unknown> = {}, payload: unknown = { cleanup_status: "confirmed" }) {
  return {
    runtime_event_version: RUNTIME_EVENT_VERSION,
    session_id: SESSION,
    generation: 1,
    seq: 1,
    monotonic_ms: 0,
    operation_id: null,
    attempt_id: null,
    course_id: null,
    lesson_id: null,
    scene_id: null,
    beat_id: null,
    process_id: null,
    type: "runtime.closed",
    payload,
    ...overrides,
  };
}

describe("runtime protocol: session events", () => {
  it("a valid session event with null operation provenance parses", () => {
    const event = makeEvent({ seq: 7, monotonic_ms: 1234 });
    const parsed = RuntimeEventSchema.parse(event);
    assert.equal(parsed.seq, 7);
    assert.equal(parsed.monotonic_ms, 1234);
    assert.equal(parsed.operation_id, null);
  });

  it("runtime.* events must use null operation provenance (design invariant)", () => {
    const bad = makeEvent({ operation_id: "op-1", attempt_id: "att-1" });
    assert.equal(RuntimeEventSchema.safeParse(bad).success, false);
  });

  it("runtime.failed carries a structured code payload", () => {
    const event = makeEvent({ type: "runtime.failed", payload: { code: "TRANSPORT_FAILED", message: "frame stream lost" } });
    const parsed = RuntimeEventSchema.parse(event);
    assert.equal(pay(parsed).code, "TRANSPORT_FAILED");
  });
});

describe("runtime protocol: operation events", () => {
  it("a fully provenanced operation.accepted event parses", () => {
    const event = makeEvent(
      {
        type: "operation.accepted",
        operation_id: "start-server",
        attempt_id: "att-0001",
        ...PROVENANCE,
        process_id: "dev-server",
        payload: {},
      },
      {},
    );
    const parsed = RuntimeEventSchema.parse(event);
    assert.equal(parsed.course_id, "C01");
    assert.equal(parsed.lesson_id, "L011");
    assert.equal(parsed.scene_id, "S014");
    assert.equal(parsed.beat_id, "run-dev-server");
    assert.equal(parsed.process_id, "dev-server");
  });

  it("operation events require non-null operation_id and attempt_id", () => {
    assert.equal(RuntimeEventSchema.safeParse(makeEvent({ type: "operation.accepted", payload: {} })).success, false);
    assert.equal(
      RuntimeEventSchema.safeParse(makeEvent({ type: "operation.completed", operation_id: "op", attempt_id: null, payload: { outcome: "PASS", reason: null, exit_code: 0, forced: false } }))
        .success,
      false,
    );
  });

  it("logical process_id is preserved exactly (background id, foreground null)", () => {
    const background = makeEvent({ type: "process.started", process_id: "dev-server", payload: {} }, {});
    assert.equal(RuntimeEventSchema.parse(background).process_id, "dev-server");
    const foreground = makeEvent({ type: "process.started", operation_id: "install", attempt_id: "att-1", course_id: "C01", lesson_id: "L011", process_id: null, payload: {} }, {});
    assert.equal(RuntimeEventSchema.parse(foreground).process_id, null);
  });
});

describe("runtime protocol: output events", () => {
  it("stdout and stderr are distinguishable output channels", () => {
    const out = makeEvent(
      { type: "process.output", operation_id: "op", attempt_id: "att", process_id: "dev-server", payload: { stream: "stdout", text: "hello", stream_offset: 0 } },
      undefined,
    );
    const err = makeEvent(
      { type: "process.output", operation_id: "op", attempt_id: "att", process_id: "dev-server", payload: { stream: "stderr", text: "warn", stream_offset: 0 } },
      undefined,
    );
    const parsedOut = RuntimeEventSchema.parse(out);
    const parsedErr = RuntimeEventSchema.parse(err);
    assert.equal(pay(parsedOut).stream, "stdout");
    assert.equal(pay(parsedErr).stream, "stderr");
  });

  it("there is no system/runtime output stream: diagnostics are separate event types", () => {
    const bad = makeEvent(
      { type: "process.output", operation_id: "op", attempt_id: "att", payload: { stream: "system", text: "docker diagnostics", stream_offset: 0 } },
      undefined,
    );
    assert.equal(RuntimeEventSchema.safeParse(bad).success, false);
  });

  it("output payloads reject extra keys and missing offsets", () => {
    const extra = makeEvent(
      { type: "process.output", operation_id: "op", attempt_id: "att", payload: { stream: "stdout", text: "x", stream_offset: 0, pid: 4242 } },
      undefined,
    );
    assert.equal(RuntimeEventSchema.safeParse(extra).success, false, "OS pid must not ride on output events");
    const missing = makeEvent(
      { type: "process.output", operation_id: "op", attempt_id: "att", payload: { stream: "stdout", text: "x" } },
      undefined,
    );
    assert.equal(RuntimeEventSchema.safeParse(missing).success, false);
  });
});

describe("runtime protocol: event ordering metadata", () => {
  it("strictly increasing journal seq with per-stream offsets is representable", () => {
    const events = [0, 1, 2, 3, 4].map((i) =>
      RuntimeEventSchema.parse(
        makeEvent(
          {
            seq: i + 1,
            monotonic_ms: 100 * i,
            type: "process.output",
            operation_id: "op",
            attempt_id: "att",
            process_id: "dev-server",
            payload: { stream: i % 2 === 0 ? "stdout" : "stderr", text: `chunk ${i}`, stream_offset: i * 8 },
          },
          undefined,
        ),
      ),
    );
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
    assert.deepEqual(events.map((e) => pay(e).stream_offset), [0, 8, 16, 24, 32]);
    assert.deepEqual(events.map((e) => e.monotonic_ms), [0, 100, 200, 300, 400]);
    // per-stream order is independently representable
    assert.deepEqual(events.filter((e) => pay(e).stream === "stdout").map((e) => pay(e).stream_offset), [0, 16, 32]);
    assert.deepEqual(events.filter((e) => pay(e).stream === "stderr").map((e) => pay(e).stream_offset), [8, 24]);
  });

  it("event types outside the canonical design set are rejected", () => {
    assert.equal(RuntimeEventSchema.safeParse(makeEvent({ type: "process.chunk" })).success, false);
    assert.equal(RuntimeEventSchema.safeParse(makeEvent({ type: "exec" })).success, false);
  });

  it("the envelope is strict: unknown keys and missing fields are rejected", () => {
    assert.equal(RuntimeEventSchema.safeParse(makeEvent({ render_hint: "x" })).success, false);
    const { seq: _omit, ...noSeq } = makeEvent();
    assert.equal(RuntimeEventSchema.safeParse(noSeq).success, false);
    assert.equal(RuntimeEventSchema.safeParse(makeEvent({ runtime_event_version: 2 })).success, false);
  });
});

describe("runtime protocol: canonical state enums", () => {
  it("process states are exactly the design five and reject unknown values", () => {
    for (const state of ["STARTING", "RUNNING", "STOPPING", "EXITED", "DISPOSED"]) {
      assert.equal(ProcessStateSchema.safeParse(state).success, true, state);
    }
    for (const state of ["pending", "running", "stopped", "cancelled", "READY", ""]) {
      assert.equal(ProcessStateSchema.safeParse(state).success, false, state);
    }
  });

  it("operation outcomes are the canonical architecture states with no enum drift", () => {
    for (const outcome of ["PENDING", "RUNNING", "PASS", "HOLD", "FAIL", "SKIPPED"]) {
      assert.equal(OperationOutcomeSchema.safeParse(outcome).success, true, outcome);
    }
    assert.equal(OperationOutcomeSchema.safeParse("CANCELED").success, false);
    assert.equal(OperationOutcomeSchema.safeParse("DONE").success, false);
  });

  it("container lifecycle vocabulary is the design sequence plus HOLD_CLEANUP", () => {
    for (const state of ["ALLOCATING", "CREATED", "STARTING", "READY", "CLOSING", "REMOVED", "HOLD_CLEANUP"]) {
      assert.equal(ContainerLifecycleStateSchema.safeParse(state).success, true, state);
    }
    assert.equal(ContainerLifecycleStateSchema.safeParse("RUNNING").success, false);
  });
});

describe("runtime protocol: final result DTO", () => {
  it("the full foreground result DTO parses with opaque refs", () => {
    const result = OperationResultSchema.parse({
      runtime_event_version: RUNTIME_EVENT_VERSION,
      session_id: SESSION,
      generation: 1,
      operation_id: "install-deps",
      attempt_id: "att-0001",
      course_id: "C01",
      lesson_id: "L011",
      scene_id: "S014",
      beat_id: "install-deps",
      process_id: null,
      state: "EXITED",
      reason: null,
      started_ms: 100,
      ended_ms: 450,
      duration_ms: 350,
      exit_code: 0,
      signal: null,
      expected_exit_code: 0,
      timeout_ms: 60000,
      forced: false,
      cleanup_status: "confirmed",
      stdout_ref: "jrnl-0007-out",
      stderr_ref: "jrnl-0008-err",
      output_bytes: 128,
      truncated: false,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout_ref, "jrnl-0007-out");
  });

  it("a never-started result keeps null timing and exit data (no invented values)", () => {
    const result = OperationResultSchema.parse({
      runtime_event_version: RUNTIME_EVENT_VERSION,
      session_id: SESSION,
      generation: 1,
      operation_id: "install-deps",
      attempt_id: "att-0001",
      course_id: "C01",
      lesson_id: "L011",
      scene_id: "S014",
      beat_id: "install-deps",
      process_id: null,
      state: "DISPOSED",
      reason: "SPAWN_FAILED",
      started_ms: null,
      ended_ms: null,
      duration_ms: 0,
      exit_code: null,
      signal: null,
      expected_exit_code: 0,
      timeout_ms: 60000,
      forced: false,
      cleanup_status: "confirmed",
      stdout_ref: null,
      stderr_ref: null,
      output_bytes: 0,
      truncated: false,
    });
    assert.equal(result.started_ms, null);
    assert.equal(result.exit_code, null);
    assert.equal(result.reason, "SPAWN_FAILED");
  });

  it("result bounds: exit codes are real POSIX codes, opaque refs reject paths", () => {
    const base = {
      runtime_event_version: RUNTIME_EVENT_VERSION,
      session_id: SESSION,
      generation: 1,
      operation_id: "op",
      attempt_id: "att",
      course_id: null,
      lesson_id: null,
      scene_id: null,
      beat_id: null,
      process_id: null,
      state: "EXITED",
      reason: null,
      started_ms: 0,
      ended_ms: 1,
      duration_ms: 1,
      exit_code: null,
      signal: null,
      expected_exit_code: null,
      timeout_ms: null,
      forced: false,
      cleanup_status: "confirmed",
      stdout_ref: null,
      stderr_ref: null,
      output_bytes: 0,
      truncated: false,
    };
    assert.equal(OperationResultSchema.safeParse({ ...base, exit_code: 256 }).success, false);
    assert.equal(OperationResultSchema.safeParse({ ...base, exit_code: -1 }).success, false);
    assert.equal(OperationResultSchema.safeParse({ ...base, stdout_ref: "E:\\logs\\out.txt" }).success, false, "refs are opaque tokens, never paths");
    assert.equal(OperationResultSchema.safeParse({ ...base, output_bytes: -1 }).success, false);
  });
});

describe("runtime protocol: session identity separation", () => {
  it("runtime session identity is engine-generated and independent of lesson identity", () => {
    const session = RuntimeSessionIdentitySchema.parse({ session_id: SESSION, generation: 3 });
    assert.equal(session.session_id, SESSION);
    assert.equal(session.generation, 3);
    assert.equal(RuntimeSessionIdentitySchema.safeParse({ session_id: SESSION, generation: 0 }).success, false);
    assert.equal(RuntimeSessionIdentitySchema.safeParse({ session_id: "", generation: 1 }).success, false);
  });

  it("the same lesson provenance is valid under two different runtime sessions", () => {
    const mk = (sessionId: string) =>
      makeEvent(
        {
          session_id: sessionId,
          type: "operation.accepted",
          operation_id: "op",
          attempt_id: "att",
          ...PROVENANCE,
          payload: {},
        },
        {},
      );
    const a = RuntimeEventSchema.parse(mk("sess-aaaa"));
    const b = RuntimeEventSchema.parse(mk("sess-bbbb"));
    assert.equal(a.course_id, b.course_id);
    assert.notEqual(a.session_id, b.session_id);
    // session identity is opaque and never composed from lesson fields
    assert.equal(RuntimeSessionIdentitySchema.safeParse({ session_id: "C01-L011", generation: 1 }).success, true, "opaque id, not a derived address");
  });
});

describe("runtime protocol: compiled IR stays uncontaminated", () => {
  const goldenPath = join(here, "..", "..", "compiler", "tests", "golden", "C01-L011-compiled-lesson.json");
  const golden: unknown = JSON.parse(readFileSync(goldenPath, "utf8"));

  it("the canonical golden IR still validates", () => {
    const result = validateCompiledLesson(golden);
    assert.equal(result.ok, true);
  });

  it("runtime session fields are rejected by the IR contract (strict separation)", () => {
    const contaminated = { ...(golden as object), session_id: SESSION, generation: 1 };
    const result = validateCompiledLesson(contaminated);
    assert.equal(result.ok, false, "compiled IR must never carry runtime session state");
  });
});
