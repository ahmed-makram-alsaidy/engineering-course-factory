// Tests for P8.1 Orchestration Protocol, Normalized Envelopes & DTO Contracts
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Sections 1-34, and ADR-0013.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_FAMILIES,
  ACTION_TYPES,
  ActionFamilySchema,
  ActionTypeSchema,
  AttemptIdSchema,
  CancelLessonRequestSchema,
  DomainJournalReferenceSchema,
  ENGINE_FAMILIES,
  EngineExecutionResultSchema,
  EngineFamilySchema,
  GenerationSchema,
  GetRuntimeSnapshotRequestSchema,
  GlobalJournalSeqSchema,
  GlobalRuntimeEventSchema,
  LessonIdSchema,
  MAX_JOURNAL_PAGE_BYTES,
  MAX_JOURNAL_PAGE_EVENTS,
  MAX_JOURNAL_SESSION_BYTES,
  MAX_LESSON_STEPS,
  OperationIdSchema,
  PauseLessonRequestSchema,
  PlayheadDtoSchema,
  ProcessIdSchema,
  ProcessLifecycleEntryDtoSchema,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_STATES,
  ResetLessonRequestSchema,
  ResumeLessonRequestSchema,
  RuntimeIdentifierSchema,
  RuntimeSessionIdSchema,
  RuntimeSnapshotDtoSchema,
  RuntimeStateSchema,
  SafeRuntimeSessionDescriptorSchema,
  SceneIdSchema,
  StartLessonRequestSchema,
  StepIdSchema,
  TERMINAL_STATUSES,
  TerminalStatusSchema,
  createCancelledResult,
  createCompletedResult,
  createFailedResult,
  createUncertainResult,
  routeStepToEngineFamily,
} from "../src/protocol.ts";
import { SCHEMA_VERSION } from "@course-factory/shared-types";
import { COMPILED_IR_VERSION } from "@course-factory/lesson-compiler/ir";

describe("P8.1: Protocol Version & Bounds Constants", () => {
  it("runtime protocol version is 1", () => {
    assert.equal(RUNTIME_PROTOCOL_VERSION, 1);
  });

  it("canonical bounds constants are preserved from design", () => {
    assert.equal(MAX_JOURNAL_PAGE_EVENTS, 256);
    assert.equal(MAX_JOURNAL_PAGE_BYTES, 262_144);
    assert.equal(MAX_JOURNAL_SESSION_BYTES, 16_777_216);
    assert.equal(MAX_LESSON_STEPS, 10_000);
  });

  it("canonical Schema version remains 1.1", () => {
    assert.equal(SCHEMA_VERSION, "1.1");
  });

  it("canonical Compiled IR version remains 1.0", () => {
    assert.equal(COMPILED_IR_VERSION, "1.0");
  });
});

describe("P8.1: Runtime States (13 States Closed Taxonomy)", () => {
  it("exactly 13 canonical runtime states are registered", () => {
    assert.equal(RUNTIME_STATES.length, 13);
    assert.deepEqual([...RUNTIME_STATES], [
      "CREATED",
      "VALIDATING",
      "READY",
      "RUNNING",
      "PAUSED",
      "CANCELLING",
      "CANCELLED",
      "RESETTING",
      "COMPLETED",
      "FAILED",
      "HOLD",
      "CLOSING",
      "CLOSED",
    ]);
  });

  it("every canonical runtime state parses successfully", () => {
    for (const state of RUNTIME_STATES) {
      assert.equal(RuntimeStateSchema.parse(state), state);
    }
  });

  it("rejects unknown runtime state", () => {
    assert.throws(() => RuntimeStateSchema.parse("UNKNOWN"));
    assert.throws(() => RuntimeStateSchema.parse("STARTING"));
    assert.throws(() => RuntimeStateSchema.parse("STOPPED"));
    assert.throws(() => RuntimeStateSchema.parse(""));
  });
});

describe("P8.1: Engine Families & Action Families Closed Taxonomy", () => {
  it("exactly 7 canonical engine families are registered", () => {
    assert.equal(ENGINE_FAMILIES.length, 7);
    assert.deepEqual([...ENGINE_FAMILIES], [
      "orchestrator",
      "editor",
      "terminal",
      "browser",
      "wait",
      "narration",
      "visual",
    ]);
  });

  it("every engine family parses successfully", () => {
    for (const family of ENGINE_FAMILIES) {
      assert.equal(EngineFamilySchema.parse(family), family);
    }
  });

  it("rejects unknown engine family", () => {
    assert.throws(() => EngineFamilySchema.parse("shell"));
    assert.throws(() => EngineFamilySchema.parse("playwright"));
    assert.throws(() => EngineFamilySchema.parse("docker"));
    assert.throws(() => EngineFamilySchema.parse(""));
  });

  it("action families match canonical compiled IR families", () => {
    assert.equal(ACTION_FAMILIES.length, 6);
    assert.deepEqual([...ACTION_FAMILIES], [
      "file",
      "editor",
      "terminal",
      "wait",
      "browser",
      "visual",
    ]);
    for (const af of ACTION_FAMILIES) {
      assert.equal(ActionFamilySchema.parse(af), af);
    }
  });

  it("action types match canonical schema 1.1 actions", () => {
    assert.equal(ACTION_TYPES.length, 16);
    for (const at of ACTION_TYPES) {
      assert.equal(ActionTypeSchema.parse(at), at);
    }
  });
});

describe("P8.1: Action Family Routing Contract", () => {
  it("routes narration steps deterministically to narration engine", () => {
    assert.equal(routeStepToEngineFamily("narration"), "narration");
  });

  it("routes pause steps deterministically to wait engine", () => {
    assert.equal(routeStepToEngineFamily("pause"), "wait");
  });

  it("routes file and editor action steps deterministically to editor engine", () => {
    assert.equal(routeStepToEngineFamily("action", "file_open"), "editor");
    assert.equal(routeStepToEngineFamily("action", "file_create"), "editor");
    assert.equal(routeStepToEngineFamily("action", "type_code"), "editor");
    assert.equal(routeStepToEngineFamily("action", "replace_code"), "editor");
    assert.equal(routeStepToEngineFamily("action", "file_save"), "editor");
  });

  it("routes terminal action steps deterministically to terminal engine", () => {
    assert.equal(routeStepToEngineFamily("action", "terminal_run"), "terminal");
    assert.equal(routeStepToEngineFamily("action", "terminal_stop"), "terminal");
  });

  it("routes browser action steps deterministically to browser engine", () => {
    assert.equal(routeStepToEngineFamily("action", "browser_open"), "browser");
    assert.equal(routeStepToEngineFamily("action", "browser_click"), "browser");
    assert.equal(routeStepToEngineFamily("action", "browser_fill"), "browser");
    assert.equal(routeStepToEngineFamily("action", "browser_press"), "browser");
    assert.equal(routeStepToEngineFamily("action", "browser_refresh"), "browser");
    assert.equal(routeStepToEngineFamily("action", "browser_wait"), "browser");
    assert.equal(routeStepToEngineFamily("action", "browser_assert"), "browser");
  });

  it("routes wait action steps deterministically by wait condition", () => {
    assert.equal(routeStepToEngineFamily("action", "wait", "duration"), "wait");
    assert.equal(routeStepToEngineFamily("action", "wait", "port"), "wait");
    assert.equal(routeStepToEngineFamily("action", "wait", "process_output"), "terminal");
  });

  it("routes highlight action step to visual engine", () => {
    assert.equal(routeStepToEngineFamily("action", "highlight"), "visual");
  });

  it("rejects unknown action types during routing", () => {
    assert.throws(() => routeStepToEngineFamily("action", "unknown_action" as any));
  });
});

describe("P8.1: Core Identifier Schemas", () => {
  it("accepts valid identifiers", () => {
    assert.equal(RuntimeIdentifierSchema.parse("sess-001"), "sess-001");
    assert.equal(RuntimeSessionIdSchema.parse("sess_run_01"), "sess_run_01");
    assert.equal(AttemptIdSchema.parse("A001"), "A001");
    assert.equal(AttemptIdSchema.parse("A002"), "A002");
    assert.equal(GlobalJournalSeqSchema.parse(1), 1);
    assert.equal(GenerationSchema.parse(1), 1);
    assert.equal(GenerationSchema.parse(42), 42);
    assert.equal(LessonIdSchema.parse("C01-L003"), "C01-L003");
    assert.equal(SceneIdSchema.parse("C01-L003-S001"), "C01-L003-S001");
    assert.equal(StepIdSchema.parse("C01-L003-S001-B001"), "C01-L003-S001-B001");
    assert.equal(StepIdSchema.parse("C01-L003-S001-STEP001"), "C01-L003-S001-STEP001");
    assert.equal(ProcessIdSchema.parse("dev_server"), "dev_server");
  });

  it("rejects invalid generations", () => {
    assert.throws(() => GenerationSchema.parse(0));
    assert.throws(() => GenerationSchema.parse(-1));
    assert.throws(() => GenerationSchema.parse(1.5));
    assert.throws(() => GenerationSchema.parse("1" as any));
  });

  it("rejects malformed attempt IDs", () => {
    assert.throws(() => AttemptIdSchema.parse("attempt1"));
    assert.throws(() => AttemptIdSchema.parse("B001"));
    assert.throws(() => AttemptIdSchema.parse("A"));
    assert.throws(() => AttemptIdSchema.parse("A1"));
    assert.throws(() => AttemptIdSchema.parse(""));
  });

  it("rejects invalid global journal sequences", () => {
    assert.throws(() => GlobalJournalSeqSchema.parse(0));
    assert.throws(() => GlobalJournalSeqSchema.parse(-1));
    assert.throws(() => GlobalJournalSeqSchema.parse(2.5));
  });
});

describe("P8.1: Normalized Engine Execution Result Envelope", () => {
  it("validates canonical COMPLETED result envelope", () => {
    const res = createCompletedResult({
      engine: "terminal",
      operation_id: "C01-L001-S001-B001",
      session_id: "sess-01",
      generation: 1,
      attempt_id: "A001",
      exit_code: 0,
      domain_seq: 42,
      duration_ms: 120,
    });
    const parsed = EngineExecutionResultSchema.parse(res);
    assert.equal(parsed.status, "COMPLETED");
    assert.equal(parsed.engine, "terminal");
    assert.equal(parsed.retry, "NOT_RETRYABLE");
    assert.equal(parsed.detail.exit_code, 0);
    assert.equal(parsed.detail.domain_seq, 42);
    assert.equal(parsed.detail.duration_ms, 120);
  });

  it("validates canonical FAILED result envelope", () => {
    const res = createFailedResult({
      engine: "browser",
      operation_id: "C01-L001-S001-B002",
      session_id: "sess-01",
      generation: 1,
      attempt_id: "A001",
      code: "ASSERTION_FAILED",
      message: "Expected text 'Hello' not visible",
      domain_seq: 15,
      duration_ms: 350,
      retry: "NOT_RETRYABLE",
    });
    const parsed = EngineExecutionResultSchema.parse(res);
    assert.equal(parsed.status, "FAILED");
    assert.equal(parsed.engine, "browser");
    assert.equal(parsed.detail.code, "ASSERTION_FAILED");
    assert.equal(parsed.retry, "NOT_RETRYABLE");
  });

  it("validates canonical CANCELLED result envelope", () => {
    const res = createCancelledResult({
      engine: "editor",
      operation_id: "C01-L001-S001-B003",
      session_id: "sess-01",
      generation: 1,
      attempt_id: "A001",
      duration_ms: 45,
    });
    const parsed = EngineExecutionResultSchema.parse(res);
    assert.equal(parsed.status, "CANCELLED");
    assert.equal(parsed.engine, "editor");
    assert.equal(parsed.retry, "NOT_RETRYABLE");
    assert.equal(parsed.detail.code, "OPERATION_CANCELLED");
  });

  it("validates canonical UNCERTAIN result envelope", () => {
    const res = createUncertainResult({
      engine: "editor",
      operation_id: "C01-L001-S001-B004",
      session_id: "sess-01",
      generation: 1,
      attempt_id: "A001",
      code: "COMMIT_UNCERTAIN",
      message: "Rename succeeded but handle verify timed out",
      domain_seq: 88,
      duration_ms: 500,
    });
    const parsed = EngineExecutionResultSchema.parse(res);
    assert.equal(parsed.status, "UNCERTAIN");
    assert.equal(parsed.engine, "editor");
    assert.equal(parsed.retry, "UNCERTAIN_DO_NOT_RETRY");
  });

  it("INVARIANT: UNCERTAIN + SAFE_TO_RETRY rejects fail-closed", () => {
    const invalid = {
      status: "UNCERTAIN",
      engine: "editor",
      operation_id: "op-1",
      session_id: "sess-1",
      generation: 1,
      attempt_id: "A001",
      retry: "SAFE_TO_RETRY",
      detail: { duration_ms: 10 },
    };
    assert.throws(() => EngineExecutionResultSchema.parse(invalid));
  });

  it("INVARIANT: UNCERTAIN + NOT_RETRYABLE rejects fail-closed", () => {
    const invalid = {
      status: "UNCERTAIN",
      engine: "terminal",
      operation_id: "op-1",
      session_id: "sess-1",
      generation: 1,
      attempt_id: "A001",
      retry: "NOT_RETRYABLE",
      detail: { duration_ms: 10 },
    };
    assert.throws(() => EngineExecutionResultSchema.parse(invalid));
  });

  it("INVARIANT: COMPLETED + SAFE_TO_RETRY rejects fail-closed", () => {
    const invalid = {
      status: "COMPLETED",
      engine: "terminal",
      operation_id: "op-1",
      session_id: "sess-1",
      generation: 1,
      attempt_id: "A001",
      retry: "SAFE_TO_RETRY",
      detail: { duration_ms: 10 },
    };
    assert.throws(() => EngineExecutionResultSchema.parse(invalid));
  });

  it("INVARIANT: CANCELLED + SAFE_TO_RETRY rejects fail-closed", () => {
    const invalid = {
      status: "CANCELLED",
      engine: "terminal",
      operation_id: "op-1",
      session_id: "sess-1",
      generation: 1,
      attempt_id: "A001",
      retry: "SAFE_TO_RETRY",
      detail: { duration_ms: 10 },
    };
    assert.throws(() => EngineExecutionResultSchema.parse(invalid));
  });

  it("rejects hostile execution payload keys in execution result", () => {
    const base = {
      status: "COMPLETED",
      engine: "terminal",
      operation_id: "op-1",
      session_id: "sess-1",
      generation: 1,
      attempt_id: "A001",
      retry: "NOT_RETRYABLE",
      detail: { duration_ms: 10 },
    };

    const hostileKeys = [
      "command",
      "code",
      "source",
      "url",
      "selector",
      "fill",
      "path",
      "pid",
      "container_id",
      "profile_path",
      "stack",
    ];

    for (const key of hostileKeys) {
      assert.throws(
        () => EngineExecutionResultSchema.parse({ ...base, [key]: "malicious" }),
        new RegExp(`(unrecognized_keys|invalid_type)`, "i")
      );
    }
  });

  it("detail message in result is bounded and path-sanitized", () => {
    const res = createFailedResult({
      engine: "terminal",
      operation_id: "op-1",
      session_id: "sess-1",
      generation: 1,
      attempt_id: "A001",
      code: "EXIT_CODE_MISMATCH",
      message: "Command failed at E:\\course-factory\\temp\\scratch.js",
      duration_ms: 50,
    });
    assert.ok(!res.detail.message!.includes("E:\\course-factory"));
    assert.ok(res.detail.message!.includes("[path]"));
  });
});

describe("P8.1: Playhead DTO Contract", () => {
  it("validates clean playhead DTO", () => {
    const playhead = {
      lesson_id: "C01-L001",
      scene_index: 0,
      scene_id: "C01-L001-S001",
      step_index: 3,
      step_id: "C01-L001-S001-B004",
      global_step_ordinal: 4,
      total_steps: 25,
      attempt_id: "A001",
      generation: 1,
    };
    const parsed = PlayheadDtoSchema.parse(playhead);
    assert.equal(parsed.lesson_id, "C01-L001");
    assert.equal(parsed.global_step_ordinal, 4);
  });

  it("rejects playhead with negative ordinals or invalid IDs", () => {
    assert.throws(() =>
      PlayheadDtoSchema.parse({
        lesson_id: "invalid-id",
        scene_index: -1,
        scene_id: "bad-scene",
        step_index: 0,
        step_id: "",
        global_step_ordinal: 0,
        total_steps: 0,
        attempt_id: "bad",
        generation: 0,
      })
    );
  });

  it("playhead DTO is deterministic JSON roundtrip", () => {
    const playhead = {
      lesson_id: "C01-L001",
      scene_index: 1,
      scene_id: "C01-L001-S002",
      step_index: 0,
      step_id: "C01-L001-S002-B001",
      global_step_ordinal: 10,
      total_steps: 30,
      attempt_id: "A002",
      generation: 2,
    };
    const json = JSON.stringify(playhead);
    const roundtripped = PlayheadDtoSchema.parse(JSON.parse(json));
    assert.deepEqual(roundtripped, playhead);
  });
});

describe("P8.1: Safe Runtime Snapshot DTO", () => {
  it("validates bounded runtime snapshot DTO", () => {
    const snapshot = {
      runtime_session_id: "sess-01",
      lesson_id: "C01-L001",
      generation: 1,
      state: "RUNNING",
      playhead: {
        lesson_id: "C01-L001",
        scene_index: 0,
        scene_id: "C01-L001-S001",
        step_index: 0,
        step_id: "C01-L001-S001-B001",
        global_step_ordinal: 1,
        total_steps: 10,
        attempt_id: "A001",
        generation: 1,
      },
      active_process_ids: ["dev_server"],
      last_outcome: "COMPLETED",
      journal_high_seq: 5,
    };
    const parsed = RuntimeSnapshotDtoSchema.parse(snapshot);
    assert.equal(parsed.state, "RUNNING");
    assert.equal(parsed.active_process_ids[0], "dev_server");
  });

  it("rejects snapshot with extra unreviewed fields", () => {
    const hostile = {
      runtime_session_id: "sess-01",
      lesson_id: "C01-L001",
      generation: 1,
      state: "RUNNING",
      playhead: {
        lesson_id: "C01-L001",
        scene_index: 0,
        scene_id: "C01-L001-S001",
        step_index: 0,
        step_id: "C01-L001-S001-B001",
        global_step_ordinal: 1,
        total_steps: 10,
        attempt_id: "A001",
        generation: 1,
      },
      active_process_ids: [],
      last_outcome: null,
      journal_high_seq: 0,
      code_buffer: "console.log('leaked code')",
    };
    assert.throws(() => RuntimeSnapshotDtoSchema.parse(hostile));
  });
});

describe("P8.1: Identifier-Only Future Request DTOs (IPC Surface)", () => {
  it("validates StartLessonRequest strictly", () => {
    const req = { session_id: "sess-01", request_id: "req-1" };
    assert.deepEqual(StartLessonRequestSchema.parse(req), req);
    assert.throws(() => StartLessonRequestSchema.parse({ ...req, command: "npm test" }));
    assert.throws(() => StartLessonRequestSchema.parse({ ...req, playhead_target: 5 }));
  });

  it("validates PauseLessonRequest strictly", () => {
    const req = { session_id: "sess-01", request_id: "req-2" };
    assert.deepEqual(PauseLessonRequestSchema.parse(req), req);
    assert.throws(() => PauseLessonRequestSchema.parse({ ...req, pause_seconds: 10 }));
  });

  it("validates ResumeLessonRequest strictly", () => {
    const req = { session_id: "sess-01", request_id: "req-3" };
    assert.deepEqual(ResumeLessonRequestSchema.parse(req), req);
    assert.throws(() => ResumeLessonRequestSchema.parse({ ...req, skip_step: true }));
  });

  it("validates CancelLessonRequest strictly", () => {
    const req = { session_id: "sess-01", request_id: "req-4" };
    assert.deepEqual(CancelLessonRequestSchema.parse(req), req);
    assert.throws(() => CancelLessonRequestSchema.parse({ ...req, force_kill: true }));
  });

  it("validates ResetLessonRequest strictly", () => {
    const req = { session_id: "sess-01", request_id: "req-5" };
    assert.deepEqual(ResetLessonRequestSchema.parse(req), req);
    assert.throws(() => ResetLessonRequestSchema.parse({ ...req, preserve_files: true }));
  });

  it("validates GetRuntimeSnapshotRequest strictly", () => {
    const req = { session_id: "sess-01", after_seq: 10 };
    assert.deepEqual(GetRuntimeSnapshotRequestSchema.parse(req), req);
    assert.throws(() => GetRuntimeSnapshotRequestSchema.parse({ ...req, include_dom: true }));
  });
});

describe("P8.1: Domain Journal Reference & Global Event DTO", () => {
  it("validates DomainJournalReferenceSchema", () => {
    const ref = { engine: "terminal", domain_seq: 100 };
    assert.deepEqual(DomainJournalReferenceSchema.parse(ref), ref);
    assert.throws(() => DomainJournalReferenceSchema.parse({ engine: "unknown", domain_seq: 100 }));
    assert.throws(() => DomainJournalReferenceSchema.parse({ engine: "terminal", domain_seq: 0 }));
  });

  it("validates GlobalRuntimeEventSchema with domain correlation", () => {
    const event = {
      global_seq: 12,
      timestamp_ms: 1540,
      runtime_session_id: "sess-01",
      generation: 1,
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B002",
      kind: "action",
      engine: "terminal",
      event_type: "engine.completed",
      attempt_id: "A001",
      domain_ref: {
        engine: "terminal",
        domain_seq: 42,
      },
      outcome: "COMPLETED",
      message: "Terminal command exit 0",
    };
    const parsed = GlobalRuntimeEventSchema.parse(event);
    assert.equal(parsed.global_seq, 12);
    assert.equal(parsed.domain_ref?.domain_seq, 42);
    assert.equal(parsed.outcome, "COMPLETED");
  });
});

describe("P8.1: Process Lifecycle Ledger Entry DTO", () => {
  it("validates process record DTO", () => {
    const entry = {
      process_id: "dev_server",
      started_step_id: "C01-L001-S001-B003",
      stopped_step_id: "C01-L001-S001-B010",
      state: "RUNNING",
    };
    const parsed = ProcessLifecycleEntryDtoSchema.parse(entry);
    assert.equal(parsed.process_id, "dev_server");
    assert.equal(parsed.state, "RUNNING");
  });
});
