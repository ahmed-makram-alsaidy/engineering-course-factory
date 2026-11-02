// P5.10 output waits — deterministic unit tests (no Docker, no timers beyond
// short trusted deadlines, no processes). Canonical scope
// (docs/P5-DESIGN-SPEC.md, task table row "P5.10 Output waits" + section
// "Process-output waits / readiness"):
//
//   admitted waits (trusted WaitAdmission from canonical IR; duration/port
//   waits stay UNSUPPORTED_PHASE, no TCP workflow) + the internal
//   waitForProcessOutput primitive (early/spanning per-stream/abort/deadline/
//   exit; no lost markers).
//
// The REAL Docker behavior (early READY not lost through a live container,
// spanning/ANSI/CRLF over real guest pipes, deadline/abort/exit against live
// lifetimes, journal integration) is proven in tests/p510-docker.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { WAIT_POLICY } from "../src/policy.ts";
import {
  WaitAdmissionSchema,
  createAdmissionService,
  type WaitAdmission,
} from "../src/admission.ts";
import {
  normalizeWaitLiteral,
  waitForProcessOutput,
  OutputWaitError,
} from "../src/output-wait.ts";
import {
  RUNTIME_EVENT_VERSION,
  type OutputStream,
  type RuntimeEvent,
} from "../src/protocol.ts";
import {
  authorizedSession,
  BACKGROUND_OP,
  boundRun,
  compileFixture,
  compileFromData,
  FOREGROUND_OP,
  inspectionSession,
  MIXED_LESSON,
  WAIT_OP,
} from "./admission-fixtures.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function syntheticWait(overrides: Partial<WaitAdmission> = {}): WaitAdmission {
  return WaitAdmissionSchema.parse({
    kind: "wait_admission",
    grant_version: 1,
    session_id: "sess-test",
    generation: 1,
    request_id: "req-w",
    operation_id: "op-w",
    attempt_id: "att-000001",
    course_id: "C01",
    lesson_id: "L01",
    scene_id: "S01",
    beat_id: "B01",
    target: { process_id: "proc-1", defined_in: { scene_id: "S01", beat_id: "B01" } },
    text: "READY",
    timeout_ms: 5000,
    ...overrides,
  });
}

let nextSeq = 1;

function outputEvent(
  wait: WaitAdmission,
  seq: number,
  stream: OutputStream,
  text: string,
  processId?: string,
): RuntimeEvent {
  return {
    runtime_event_version: RUNTIME_EVENT_VERSION,
    session_id: wait.session_id,
    generation: wait.generation,
    seq,
    monotonic_ms: seq * 10,
    operation_id: "op-bg",
    attempt_id: "att-000001",
    course_id: "C01",
    lesson_id: "L01",
    scene_id: "S01",
    beat_id: "B01",
    process_id: processId ?? wait.target.process_id,
    type: "process.output",
    payload: { stream, text, stream_offset: 0 },
  };
}

function terminalEvent(
  wait: WaitAdmission,
  seq: number,
  type: "process.exited" | "process.stopped" | "process.failed" | "operation.completed" | "runtime.closed" | "runtime.failed" | "runtime.closing",
  processId?: string,
): RuntimeEvent {
  const payloadByType: Record<string, unknown> = {
    "process.exited": { exit_code: 0, signal: null, duration_ms: 10 },
    "process.stopped": { cause: "operator_stop", forced: false, exit_code: null, signal: null },
    "process.failed": { code: "BACKGROUND_EXITED_EARLY", message: "exited on its own" },
    "operation.completed": { outcome: "FAIL", reason: "BACKGROUND_EXITED_EARLY", exit_code: 0, forced: false },
    "runtime.closed": { cleanup_status: "confirmed" },
    "runtime.failed": { code: "BACKGROUND_EXITED_EARLY", message: "session failed" },
    "runtime.closing": { cause: "failure" },
  };
  const isSession = type.startsWith("runtime.");
  return {
    runtime_event_version: RUNTIME_EVENT_VERSION,
    session_id: wait.session_id,
    generation: wait.generation,
    seq,
    monotonic_ms: seq * 10,
    operation_id: isSession ? null : "op-bg",
    attempt_id: isSession ? null : "att-000001",
    course_id: isSession ? null : "C01",
    lesson_id: isSession ? null : "L01",
    scene_id: isSession ? null : "S01",
    beat_id: isSession ? null : "B01",
    process_id: isSession ? null : (processId ?? wait.target.process_id),
    type: type as RuntimeEvent["type"],
    payload: payloadByType[type],
  };
}

interface Harness {
  promise: Promise<{ process_id: string; stream: OutputStream; seq: number; operation_id: string; attempt_id: string }>;
  emit(event: RuntimeEvent): void;
  isDisposed(): boolean;
}

/** Subscribe-before-history harness: subscribe first, buffer during history, drain after. */
function runWait(
  wait: WaitAdmission,
  args: {
    history?: readonly RuntimeEvent[];
    live?: boolean;
    signal?: AbortSignal | null;
    duringHistory?: (emit: (event: RuntimeEvent) => void) => void;
  } = {},
): Harness {
  const history = args.history ?? [];
  let listener: ((event: RuntimeEvent) => void) | null = null;
  let disposed = false;
  const subscribe = (l: (event: RuntimeEvent) => void) => {
    listener = l;
    return { dispose: () => { disposed = true; listener = null; } };
  };
  const getHistory = (): readonly RuntimeEvent[] => {
    if (args.duringHistory !== undefined && listener !== null) {
      args.duringHistory((event) => listener?.(event));
    }
    return history;
  };
  const isLive = (): boolean => args.live ?? true;
  const promise = waitForProcessOutput(wait, {
    subscribe,
    getHistory,
    isLive,
    signal: args.signal ?? null,
  });
  // Silence unhandled rejection warnings in tests that expect rejection; the
  // caller still awaits and asserts.
  promise.catch(() => { /* asserted by the caller */ });
  return {
    promise,
    emit: (event) => listener?.(event),
    isDisposed: () => disposed,
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<OutputWaitError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OutputWaitError, "waiter rejects with OutputWaitError");
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

function cloneIr(ir: CompiledLesson): CompiledLesson {
  return JSON.parse(JSON.stringify(ir)) as CompiledLesson;
}

/** Compile a minimal lesson with one background process plus caller-supplied extra beats. */
function compileWithBeats(lessonId: string, backgroundProcessId: string, extraBeats: unknown[]): CompiledLesson {
  return compileFromData({
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: `P5.10 synthetic (${lessonId})`,
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 120,
    learning_objectives: ["Prove P5.10 wait admission"],
    prerequisites: [],
    keywords: [],
    metadata: { synthetic_fixture: true, phase: "P5.10" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        type: "code_demo",
        title: "Background",
        duration: 60,
        visual: { kind: "terminal", description: "synthetic" },
        beats: [
          {
            beat_id: `${lessonId}-S001-B001`,
            kind: "action",
            action: { type: "terminal_run", command: "node server.js", mode: "background", process_id: backgroundProcessId, cwd: "app" },
          },
          ...(extraBeats as Array<{ beat_id: string; kind: string; action: unknown }>),
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// P5.10 wait admission
// ---------------------------------------------------------------------------

describe("P5.10 wait admission (trusted WaitAdmission from canonical IR)", () => {
  it("a process_output wait resolves to an immutable wait admission with the exact literal/timeout/target", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const result = service.admitRunOperation(identity, boundRun(identity, WAIT_OP, "req-wait"));
    assert.equal(result.ok, true);
    if (!result.ok || result.value.kind !== "wait_admission") return assert.fail("expected a wait admission");
    const admitted: WaitAdmission = result.value;
    assert.equal(admitted.kind, "wait_admission");
    assert.equal(admitted.operation_id, WAIT_OP);
    assert.equal(admitted.attempt_id, "att-000001");
    assert.equal(admitted.text, "READY", "exact authored literal preserved");
    assert.equal(admitted.timeout_ms, 30_000, "authored timeout preserved");
    assert.deepEqual(admitted.target, {
      process_id: "dev-server",
      defined_in: { scene_id: "C01-L052-S002", beat_id: "C01-L052-S002-B001" },
    });
    assert.deepEqual(
      { course: admitted.course_id, lesson: admitted.lesson_id, scene: admitted.scene_id, beat: admitted.beat_id },
      { course: "C01", lesson: "C01-L052", scene: "C01-L052-S003", beat: "C01-L052-S003-B001" },
    );
    assert.equal(Object.isFrozen(admitted), true, "wait admission is deeply frozen");
    assert.equal(Object.isFrozen(admitted.target), true);
  });

  it("a wait is admitted while its process is defined-but-unstarted (early registration, unlike stops)", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    // No background start yet: the authored stop would be PROCESS_NOT_STARTED,
    // but the wait for the same process admits (register at spawn, no loss).
    const wait = service.admitRunOperation(identity, boundRun(identity, WAIT_OP, "req-early-wait"));
    assert.equal(wait.ok, true, "defined-but-unstarted wait admits for early registration");
    const stop = service.admitStopProcess(identity, { session_id: identity.session_id, process_id: "dev-server", request_id: "req-early-stop" });
    assert.equal(stop.ok, false);
    if (!stop.ok) assert.equal(stop.rejection.code, "PROCESS_NOT_STARTED");
  });

  it("duration and port waits stay UNSUPPORTED_PHASE (no TCP workflow, no wait scheduling in P5)", () => {
    const ir = compileWithBeats("C01-L510", "srv-1", [
      { beat_id: "C01-L510-S001-B002", kind: "action", action: { type: "wait", until: "duration", seconds: 5 } },
      { beat_id: "C01-L510-S001-B003", kind: "action", action: { type: "wait", until: "port", port: 3000, timeout_seconds: 10 } },
    ]);
    const service = createAdmissionService();
    const catalog = service.installLesson(ir);
    assert.equal(catalog.ok, true);
    if (!catalog.ok) return;
    const session = service.openSession(catalog.value, { executionAuthorized: true });
    assert.equal(session.ok, true);
    if (!session.ok) return;
    const identity = session.value.identity;
    for (const op of ["C01-L510-S001-B002", "C01-L510-S001-B003"] as const) {
      const result = service.admitRunOperation(identity, { session_id: identity.session_id, operation_id: op, request_id: `req-${op}` });
      assert.equal(result.ok, false, op);
      if (!result.ok) assert.equal(result.rejection.code, "UNSUPPORTED_PHASE", op);
    }
  });

  it("an oversized readiness literal (>4096 chars) is rejected INVALID_REQUEST with zero execution slot held", () => {
    const base = compileFixture(MIXED_LESSON);
    const forged = cloneIr(base);
    for (const scene of forged.scenes) {
      for (const step of scene.steps) {
        if (step.kind === "operation" && step.operation.parameters.type === "wait") {
          (step.operation.parameters as { text: string }).text = "R".repeat(WAIT_POLICY.max_text_chars + 1);
        }
      }
    }
    // Keep the inventory in agreement so the catalog passes and admission
    // applies the runtime policy (the user-visible rejection is admission's).
    for (const process of forged.processes) {
      process.output_waits = process.output_waits.map((w) => ({ ...w, text: "R".repeat(WAIT_POLICY.max_text_chars + 1) }));
    }
    const service = createAdmissionService();
    const catalog = service.installLesson(forged);
    assert.equal(catalog.ok, true, "catalog passes when inventory agrees; admission enforces the literal bound");
    if (!catalog.ok) return;
    const session = service.openSession(catalog.value, { executionAuthorized: true });
    assert.equal(session.ok, true);
    if (!session.ok) return;
    const result = service.admitRunOperation(session.value.identity, boundRun(session.value.identity, WAIT_OP, "req-big"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "INVALID_REQUEST");
  });

  it("a NUL-containing readiness literal is rejected INVALID_REQUEST", () => {
    const base = compileFixture(MIXED_LESSON);
    const forged = cloneIr(base);
    for (const scene of forged.scenes) {
      for (const step of scene.steps) {
        if (step.kind === "operation" && step.operation.parameters.type === "wait") {
          (step.operation.parameters as { text: string }).text = "REA\0DY";
        }
      }
    }
    for (const process of forged.processes) {
      process.output_waits = process.output_waits.map((w) => ({ ...w, text: "REA\0DY" }));
    }
    const service = createAdmissionService();
    const catalog = service.installLesson(forged);
    assert.equal(catalog.ok, true);
    if (!catalog.ok) return;
    const session = service.openSession(catalog.value, { executionAuthorized: true });
    assert.equal(session.ok, true);
    if (!session.ok) return;
    const result = service.admitRunOperation(session.value.identity, boundRun(session.value.identity, WAIT_OP, "req-nul"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "INVALID_REQUEST");
  });

  it("an authored wait timeout above the 3600 s ceiling is rejected before any waiter exists", () => {
    const base = compileFixture(MIXED_LESSON);
    const forged = cloneIr(base);
    for (const scene of forged.scenes) {
      for (const step of scene.steps) {
        if (step.kind === "operation" && step.operation.parameters.type === "wait") {
          (step.operation.parameters as { timeout_seconds: number }).timeout_seconds = 9999;
        }
      }
    }
    for (const process of forged.processes) {
      process.output_waits = process.output_waits.map((w) => ({ ...w, timeout_seconds: 9999 }));
    }
    const service = createAdmissionService();
    const catalog = service.installLesson(forged);
    assert.equal(catalog.ok, true);
    if (!catalog.ok) return;
    const session = service.openSession(catalog.value, { executionAuthorized: true });
    assert.equal(session.ok, true);
    if (!session.ok) return;
    const result = service.admitRunOperation(session.value.identity, boundRun(session.value.identity, WAIT_OP, "req-timeout"));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.rejection.code, "INVALID_REQUEST");
      assert.match(result.rejection.message, /3600/);
    }
  });

  it("forged wait references cannot form a catalog (IR_RUNTIME_INCONSISTENT, no repair)", () => {
    const base = compileFixture(MIXED_LESSON);
    // defined_in disagreement
    const forgedDefinedIn = cloneIr(base);
    for (const scene of forgedDefinedIn.scenes) {
      for (const step of scene.steps) {
        if (step.kind === "operation" && step.operation.parameters.type === "wait" && step.operation.references?.process) {
          step.operation.references.process.defined_in = { scene_id: "C01-L052-S001", beat_id: "C01-L052-S001-B002" };
        }
      }
    }
    assert.equal(createAdmissionService().installLesson(forgedDefinedIn).ok, false);
    const definedInResult = createAdmissionService().installLesson(forgedDefinedIn);
    if (!definedInResult.ok) assert.equal(definedInResult.rejection.code, "IR_RUNTIME_INCONSISTENT");
    // inventory text disagreement
    const forgedText = cloneIr(base);
    for (const scene of forgedText.scenes) {
      for (const step of scene.steps) {
        if (step.kind === "operation" && step.operation.parameters.type === "wait") {
          (step.operation.parameters as { text: string }).text = "FORGED_MARKER";
        }
      }
    }
    const textResult = createAdmissionService().installLesson(forgedText);
    assert.equal(textResult.ok, false);
    if (!textResult.ok) assert.equal(textResult.rejection.code, "IR_RUNTIME_INCONSISTENT");
  });

  it("one attempt per wait operation: duplicates reject regardless of request id; reset reuses in a new generation", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    assert.equal(service.admitRunOperation(identity, boundRun(identity, WAIT_OP, "req-1")).ok, true);
    const again = service.admitRunOperation(identity, boundRun(identity, WAIT_OP, "req-2"));
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.rejection.code, "DUPLICATE_START");
    const reset = service.resetRuntime(identity, { session_id: identity.session_id, request_id: "req-reset" });
    assert.equal(reset.ok, true);
    if (!reset.ok) return;
    const fresh = service.admitRunOperation(reset.value, boundRun(reset.value, WAIT_OP, "req-fresh"));
    assert.equal(fresh.ok, true, "only reset reuses a wait definition, in a new generation");
    if (fresh.ok && fresh.value.kind === "wait_admission") {
      assert.equal(fresh.value.generation, 2);
      assert.equal(fresh.value.attempt_id, "att-000002");
    }
  });

  it("waits hold no execution slot: a foreground and a background still admit alongside a reserved wait", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    assert.equal(service.admitRunOperation(identity, boundRun(identity, WAIT_OP, "req-w")).ok, true);
    assert.equal(service.admitRunOperation(identity, boundRun(identity, FOREGROUND_OP, "req-fg")).ok, true);
    assert.equal(service.admitRunOperation(identity, boundRun(identity, BACKGROUND_OP, "req-bg")).ok, true);
  });

  it("inspection-only sessions never receive wait admissions; stale generations fail safely", () => {
    const { service, identity } = inspectionSession(MIXED_LESSON);
    const result = service.admitRunOperation(identity, boundRun(identity, WAIT_OP, "req-w"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "NOT_AUTHORIZED");
    const live = authorizedSession(MIXED_LESSON);
    const stale = live.service.admitRunOperation(
      { session_id: live.identity.session_id, generation: live.identity.generation + 3 },
      boundRun(live.identity, WAIT_OP, "req-stale"),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "STALE_SESSION");
  });

  it("the wait admission schema structurally excludes renderer-relevant execution policy", () => {
    const keys = Object.keys(WaitAdmissionSchema.shape).sort();
    assert.deepEqual(keys, [
      "attempt_id",
      "beat_id",
      "course_id",
      "generation",
      "grant_version",
      "kind",
      "lesson_id",
      "operation_id",
      "request_id",
      "scene_id",
      "session_id",
      "target",
      "text",
      "timeout_ms",
    ]);
    for (const banned of ["command", "env", "image", "mounts", "user", "network", "container", "shell", "stdin", "cwd", "predicate"]) {
      assert.equal(banned in WaitAdmissionSchema.shape, false, `wait admissions must not carry "${banned}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// waitForProcessOutput primitive
// ---------------------------------------------------------------------------

describe("P5.10 waitForProcessOutput primitive (no Docker)", () => {
  it("an already-journaled marker on a live process resolves immediately with its seq/stream", async () => {
    const wait = syntheticWait({ text: "READY", timeout_ms: 1000 });
    const history = [outputEvent(wait, 4, "stdout", "booting\n"), outputEvent(wait, 7, "stdout", "READY\n")];
    const h = runWait(wait, { history, live: true });
    const match = await h.promise;
    assert.equal(match.stream, "stdout");
    assert.equal(match.seq, 7, "the completing event's journal seq is retained");
    assert.equal(match.process_id, "proc-1");
    assert.equal(h.isDisposed(), true, "listeners are removed on settle");
  });

  it("an already-dead target rejects PROCESS_EXITED even when history holds the marker (dead wins)", async () => {
    const wait = syntheticWait({ text: "READY" });
    const history = [outputEvent(wait, 3, "stdout", "READY\n")];
    const h = runWait(wait, { history, live: false });
    await rejectsWith(h.promise, "PROCESS_EXITED");
    assert.equal(h.isDisposed(), true);
  });

  it("a chunk-spanning marker across two output events matches on the completing seq", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 11, "stdout", "REA"));
    h.emit(outputEvent(wait, 12, "stdout", "DY\n"));
    const match = await settled;
    assert.equal(match.seq, 12);
    assert.equal(match.stream, "stdout");
  });

  it("half-markers on different streams never combine (no cross-stream concatenation)", async () => {
    const wait = syntheticWait({ text: "READY", timeout_ms: 120 });
    const h = runWait(wait, { history: [], live: true });
    h.emit(outputEvent(wait, 21, "stdout", "REA"));
    h.emit(outputEvent(wait, 22, "stderr", "DY"));
    await rejectsWith(h.promise, "TIMEOUT");
  });

  it("either stream can satisfy the wait (stderr marker retains its stream)", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 31, "stderr", "READY\n"));
    const match = await settled;
    assert.equal(match.stream, "stderr");
    assert.equal(match.seq, 31);
  });

  it("ANSI CSI escapes around the marker are stripped incrementally", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 41, "stdout", "\u001b[32mREADY\u001b[0m\n"));
    const match = await settled;
    assert.equal(match.seq, 41);
  });

  it("an ANSI escape split across chunks never leaks raw bytes into the search", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 51, "stdout", "RE\u001b[3"));
    h.emit(outputEvent(wait, 52, "stdout", "2mADY\n"));
    const match = await settled;
    assert.equal(match.seq, 52);
  });

  it("OSC sequences are stripped (title prefix cannot hide the marker)", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 61, "stdout", "\u001b]0;server title\u0007READY\n"));
    const match = await settled;
    assert.equal(match.seq, 61);
  });

  it("CRLF output matches an LF literal (normalization observes emitted text)", async () => {
    const wait = syntheticWait({ text: "READY\nDONE" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 71, "stdout", "READY\r\nDONE"));
    const match = await settled;
    assert.equal(match.seq, 71);
  });

  it("a CRLF pair split across chunks still normalizes to one newline", async () => {
    const wait = syntheticWait({ text: "READY\n" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 81, "stdout", "READY\r"));
    h.emit(outputEvent(wait, 82, "stdout", "\n"));
    const match = await settled;
    assert.equal(match.seq, 82);
  });

  it("matching is case-sensitive (lowercase output never satisfies an uppercase literal)", async () => {
    const wait = syntheticWait({ text: "READY", timeout_ms: 120 });
    const h = runWait(wait, { history: [], live: true });
    h.emit(outputEvent(wait, 91, "stdout", "ready\n"));
    h.emit(outputEvent(wait, 92, "stderr", "Ready\n"));
    await rejectsWith(h.promise, "TIMEOUT");
  });

  it("a history tail plus a live head span the marker (tail carries across the history/live boundary)", async () => {
    const wait = syntheticWait({ text: "READY" });
    const history = [outputEvent(wait, 101, "stdout", "REA")];
    const h = runWait(wait, { history, live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 102, "stdout", "DY\n"));
    const match = await settled;
    assert.equal(match.seq, 102);
  });

  it("output arriving during the history check is buffered, never lost (subscribe before history)", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, {
      history: [],
      live: true,
      duringHistory: (emit) => {
        emit(outputEvent(wait, 111, "stdout", "READY\n"));
      },
    });
    const match = await h.promise;
    assert.equal(match.seq, 111, "the arrival buffered during the history read still matches");
  });

  it("the trusted deadline settles TIMEOUT and removes listeners", async () => {
    const wait = syntheticWait({ text: "NEVER_PRINTED", timeout_ms: 80 });
    const h = runWait(wait, { history: [], live: true });
    await rejectsWith(h.promise, "TIMEOUT");
    assert.equal(h.isDisposed(), true);
  });

  it("an abort signal settles CANCELLED and removes listeners", async () => {
    const wait = syntheticWait({ text: "READY", timeout_ms: 5000 });
    const controller = new AbortController();
    const h = runWait(wait, { history: [], live: true, signal: controller.signal });
    const settled = h.promise;
    controller.abort();
    await rejectsWith(settled, "CANCELLED");
    assert.equal(h.isDisposed(), true);
  });

  it("an already-aborted signal rejects CANCELLED without subscribing work", async () => {
    const wait = syntheticWait({ text: "READY" });
    const controller = new AbortController();
    controller.abort();
    const h = runWait(wait, { history: [], live: true, signal: controller.signal });
    await rejectsWith(h.promise, "CANCELLED");
  });

  it("a natural exit before the marker settles PROCESS_EXITED", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 121, "stdout", "booting\n"));
    h.emit(terminalEvent(wait, 122, "process.exited"));
    await rejectsWith(settled, "PROCESS_EXITED");
    assert.equal(h.isDisposed(), true);
  });

  it("a match before the exit wins; the late exit cannot revise it (settle once)", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(outputEvent(wait, 131, "stdout", "READY\n"));
    h.emit(terminalEvent(wait, 132, "process.exited"));
    const match = await settled;
    assert.equal(match.seq, 131);
  });

  it("an exit before a late marker wins; the late marker is ignored (settle once)", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(terminalEvent(wait, 141, "process.exited"));
    h.emit(outputEvent(wait, 142, "stdout", "READY\n"));
    await rejectsWith(settled, "PROCESS_EXITED");
  });

  it("a session-terminal event ends the wait with PROCESS_EXITED", async () => {
    const wait = syntheticWait({ text: "READY" });
    const h = runWait(wait, { history: [], live: true });
    const settled = h.promise;
    h.emit(terminalEvent(wait, 151, "runtime.closed"));
    await rejectsWith(settled, "PROCESS_EXITED");
  });

  it("output for other processes is ignored", async () => {
    const wait = syntheticWait({ text: "READY", timeout_ms: 120 });
    const h = runWait(wait, { history: [], live: true });
    h.emit(outputEvent(wait, 161, "stdout", "READY\n", "other-proc"));
    h.emit(outputEvent(wait, 162, "stderr", "READY\n", "other-proc"));
    await rejectsWith(h.promise, "TIMEOUT");
  });

  it("a malformed wait admission rejects INVALID_REQUEST with zero subscription side effects", async () => {
    const bad = { ...syntheticWait(), text: "" };
    let subscribed = false;
    const promise = waitForProcessOutput(bad as WaitAdmission, {
      subscribe: () => { subscribed = true; return { dispose: () => {} }; },
      getHistory: () => [],
      isLive: () => true,
    });
    promise.catch(() => { /* asserted below */ });
    await rejectsWith(promise, "INVALID_REQUEST");
    assert.equal(subscribed, false, "no subscription is established for an invalid wait");
  });

  it("normalizeWaitLiteral folds CRLF/CR to LF (marker-side normalization)", () => {
    assert.equal(normalizeWaitLiteral("A\r\nB"), "A\nB");
    assert.equal(normalizeWaitLiteral("A\rB"), "A\nB");
    assert.equal(normalizeWaitLiteral("READY"), "READY");
  });
});

// ---------------------------------------------------------------------------
// P5.10 source safety (in-suite counterpart of the gate scans)
// ---------------------------------------------------------------------------

describe("P5.10 output-wait source safety", () => {
  it("the waiter owns no execution/network machinery (import- and call-level)", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const strip = (code: string): string =>
      code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const waiter = strip(readFileSync(join(here, "..", "src", "output-wait.ts"), "utf8"));
    for (const forbidden of [
      "node:child_process",
      "node:net",
      "node:http",
      "node:dns",
      "node-pty",
      "docker",
      "spawn(",
      "exec(",
      "fetch(",
      "net.connect",
      "createConnection",
    ]) {
      assert.equal(waiter.includes(forbidden), false, `output-wait.ts references ${forbidden}`);
    }
  });
});
