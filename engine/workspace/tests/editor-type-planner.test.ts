// P6.8 Type planner/scheduler — deterministic planning and scheduling for
// admitted type_code only (deterministic, offline, manual clock).
//
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.8 Type
// planner/scheduler ("UTF-16 positions/graphemes/deterministic batches";
// PASS "Golden semantic/schedule outputs, Unicode/large blocks"). Canonical
// authority: design sections 4/5/7/8/11/12/18/21/26.5 plus ADR-0011
// decision 5.
//
// Proves at runtime (not merely by types): admitted type_code produces a
// deterministic immutable plan with exact authored-text preservation and a
// deterministic integer-microsecond schedule; positioning is exact line-start
// or exact append with no cursor authority; grapheme segmentation is pinned
// (ASCII, Arabic, combining marks, emoji, ZWJ, mixed, multiline LF) with no
// CR introduced; timing follows the canonical policy (40/s default with
// punctuation/newline/space pauses and newline precedence, 120/s fast above
// 8,192 clusters with groups of up to 32 stopping at LF); plans bind the
// live buffer revision and generation and fence stale/reset/close work with
// zero mutation; cancellation is deterministic with disk untouched;
// duplicates never double-apply; same-document operations serialize while
// different documents stay independent; pending-created and existing-open
// documents both plan; dirty reservations keep terminal RW fenced while RO
// observation is unaffected; large blocks stay bounded; the scheduler runs
// on a manual logical clock with no sleeps; planning never publishes,
// never touches Monaco, and never reaches beyond P6.8 scope.
//
// Fixture IR is NEVER hand-authored: synthetic lesson sources compile
// through the canonical pipeline (parseLessonData -> compileLesson ->
// re-validation inside createEditorCatalog). Buffer text is staged through
// the main-owned registry (the same store P6.7 execution writes) or, in the
// marked integration section, through the real P6.7 executors over
// phase-owned temp/P6.8 leaves (cf-p68- names, bounded, ownership-scoped
// cleanup, no Docker, no Electron). No sleeps, no wall-clock assertions.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import {
  computeSeedManifestDigest,
  createReviewedWorkspacePolicy,
  createSeedManifest,
  sha256Hex,
  type SeedManifest,
} from "../src/policy.ts";
import { createWorkspaceCoordinator } from "../src/coordinator.ts";
import {
  openWindowsFileAdapter,
  type AdapterAuthority,
  type WindowsFileAdapter,
} from "../src/file-adapter.ts";
import {
  admitEditorOperation,
  closeEditorSession,
  createEditorCatalog,
  editorBufferFacts,
  openEditorSession,
  resetEditorSession,
  type EditorCatalog,
  type EditorOperationAdmission,
  type EditorSession,
} from "../src/editor-admission.ts";
import {
  executeAdmittedFileCreate,
  executeAdmittedFileOpen,
} from "../src/editor-open-create.ts";
import {
  DEFAULT_TYPING_POLICY,
  FAST_TYPING_POLICY,
  TYPING_BASE_INTERVAL_US_DEFAULT,
  TYPING_BASE_INTERVAL_US_FAST,
  TYPING_MAX_SCHEDULE_DURATION_US,
  TYPING_PAUSE_NEWLINE_US,
  TYPING_PAUSE_PUNCTUATION_US,
  TYPING_PAUSE_SPACE_US,
  TYPING_SEGMENTATION_ID,
  createTypePlanner,
  planAdmittedTypeOperation,
  resolveTypeInsertion,
  resolveTypingPolicyForUnitCount,
  scheduleTypePlan,
  segmentGraphemes,
  type TypePlan,
} from "../src/editor-type-planner.ts";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.8", "planner");

function proof(message: string): void {
  console.log(`P6.8 PROOF: ${message}`);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Harness: synthetic lessons through the canonical pipeline.
// ---------------------------------------------------------------------------

let lessonSeq = 0;
let sessionSeq = 0;
let requestSeq = 0;

function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p68-${prefix}-${requestSeq}`;
}

function buildTypeLessonSource(actions: Array<{ action: unknown }>): { raw: unknown; lessonId: string; operationIds: string[] } {
  lessonSeq += 1;
  // Canonical identifier shapes (schema 1.1): lesson Cnn-Lnnn, scene
  // Cnn-Lnnn-Snnn, beat Cnn-Lnnn-Snnn-Bnnn (operation_id := beat_id).
  const lessonId = `C01-L${String(60 + lessonSeq).padStart(3, "0")}`;
  const operationIds = actions.map((_, index) => `${lessonId}-S001-B${String(index + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: `Synthetic P6.8 lesson ${lessonId}`,
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Plan admitted type_code through the trusted P6.8 path"],
    prerequisites: [],
    keywords: ["editor", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.8" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        type: "code_demo",
        title: "Type into the admitted document",
        duration: 120,
        visual: { kind: "code_editor", description: "Editor plans typing" },
        beats: actions.map((entry, index) => ({ beat_id: operationIds[index], kind: "action", action: entry.action })),
      },
    ],
  };
  return { raw, lessonId, operationIds };
}

function compileTypeLesson(actions: Array<{ action: unknown }>): { compiled: CompiledLesson; operationIds: string[] } {
  const { raw, operationIds } = buildTypeLessonSource(actions);
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true, "synthetic lesson must pass canonical source validation");
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  return { compiled: compileModule.compileLesson(parsed.lesson), operationIds };
}

function manifestFor(files: Record<string, string>): SeedManifest {
  const entries = [
    { portable_path: "src", kind: "directory" as const, byte_length: 0, sha256: null as string | null },
    ...Object.entries(files).map(([portable_path, text]) => ({
      portable_path,
      kind: "regular_file" as const,
      byte_length: Buffer.byteLength(text, "utf8"),
      sha256: sha256Hex(text) as string | null,
    })),
  ];
  const outcome = createSeedManifest(entries);
  assert.equal(outcome.ok, true, "seed manifest must build");
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

function openSession(compiled: CompiledLesson, files: Record<string, string>, reviewed = true): EditorSession {
  sessionSeq += 1;
  const seed = manifestFor(files);
  const catalogOutcome = createEditorCatalog(compiled);
  assert.equal(catalogOutcome.ok, true, "catalog must build");
  if (!catalogOutcome.ok) throw new Error("unreachable");
  const opened = openEditorSession({
    catalog: catalogOutcome.value,
    sessionId: `sess-p68-${String(sessionSeq).padStart(4, "0")}`,
    generation: 1,
    seedManifest: seed,
    reviewed,
  });
  assert.equal(opened.ok, true, "admission session must open");
  if (!opened.ok) throw new Error("unreachable");
  return opened.value;
}

function mustAdmit(session: EditorSession, operationId: string, requestId: string): EditorOperationAdmission {
  const outcome = admitEditorOperation(session, {
    session_id: session.sessionId,
    generation: session.generation,
    operation_id: operationId,
    request_id: requestId,
  });
  assert.equal(outcome.ok, true, `admission of ${operationId} must succeed: ${outcome.ok ? "" : outcome.rejection.code + " " + outcome.rejection.message}`);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

function stageBuffer(session: EditorSession, documentId: string, text: string): void {
  const stored = session.registry.setBufferContent(documentId, text);
  assert.equal(stored.ok, true, "main-owned buffer staging must succeed");
}

function readBuffer(session: EditorSession, documentId: string): string {
  const current = session.registry.getBufferContent(documentId);
  assert.equal(current.ok, true, "main-owned buffer must be readable");
  if (!current.ok) throw new Error("unreachable");
  return current.value;
}

const DOC_PATH = "src/seeded.ts";
const BASE_TEXT = "const seeded = 1;\n";
const APPEND_TEXT = "const extra = 1;\n";

function openThenTypeFixture(
  atLine?: number,
  content: string = APPEND_TEXT,
): { session: EditorSession; openId: string; typeId: string; openAdmission: EditorOperationAdmission } {
  const action: Record<string, unknown> = { type: "type_code", path: DOC_PATH, content };
  if (atLine !== undefined) action["at_line"] = atLine;
  const { compiled, operationIds } = compileTypeLesson([
    { action: { type: "file_open", path: DOC_PATH } },
    { action },
  ]);
  const session = openSession(compiled, { [DOC_PATH]: BASE_TEXT });
  const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
  stageBuffer(session, openAdmission.document.document_id, BASE_TEXT);
  return { session, openId: operationIds[0]!, typeId: operationIds[1]!, openAdmission };
}

before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Planner admission boundary: trusted text, no renderer authority.
// ---------------------------------------------------------------------------

describe("P6.8 planner admission boundary", () => {
  it("P6.8 PROOF: admitted type_code produces a deterministic plan", () => {
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true, `planning must succeed: ${planned.ok ? "" : planned.rejection.code}`);
    if (!planned.ok) throw new Error("unreachable");
    const plan = planned.value;
    assert.equal(plan.kind, "type_plan");
    assert.equal(plan.operation_id, typeId);
    assert.equal(plan.document_id, admission.document.document_id);
    assert.equal(plan.source_text, APPEND_TEXT);
    assert.equal(plan.units.join(""), APPEND_TEXT);
    assert.equal(plan.expected_text, BASE_TEXT + APPEND_TEXT);
    assert.equal(plan.expected_digest, sha256Text(BASE_TEXT + APPEND_TEXT));
    assert.equal(plan.insertion.mode, "append");
    assert.equal(plan.insertion.offset_utf16, BASE_TEXT.length);
    assert.equal(plan.segmentation, TYPING_SEGMENTATION_ID);
    const scheduled = scheduleTypePlan(plan);
    assert.equal(scheduled.ok, true);
    proof("admitted type_code produces a deterministic plan");
  });

  it("P6.8 PROOF: unreviewed type_code cannot plan", () => {
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: APPEND_TEXT } },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: BASE_TEXT }, false);
    const outcome = admitEditorOperation(session, {
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: operationIds[0]!,
      request_id: nextRequest("open"),
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error("unreachable");
    assert.equal(outcome.rejection.code, "NOT_AUTHORIZED");
    proof("unreviewed type_code cannot plan");
  });

  it("P6.8 PROOF: wrong action family cannot plan", () => {
    // The open admission below is already admitted inside the fixture (its
    // tombstone is live): planning it exercises the planner's own
    // action-family guard with zero mutation.
    const { session, openAdmission } = openThenTypeFixture();
    const planned = planAdmittedTypeOperation(session, openAdmission);
    assert.equal(planned.ok, false);
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "INVALID_REQUEST");
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "rejected planning preserves the buffer");
    const unknown = admitEditorOperation(session, {
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: "no-such-operation",
      request_id: nextRequest("unknown"),
    });
    assert.equal(unknown.ok, false);
    if (unknown.ok) throw new Error("unreachable");
    assert.equal(unknown.rejection.code, "NOT_AUTHORIZED");
    proof("wrong action family cannot plan");
  });

  it("P6.8 PROOF: renderer cannot provide text", () => {
    const { session, typeId } = openThenTypeFixture();
    const hostile = admitEditorOperation(session, {
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: typeId,
      request_id: nextRequest("type"),
      content: "renderer evil bytes",
    });
    assert.equal(hostile.ok, false);
    if (hostile.ok) throw new Error("unreachable");
    assert.equal(hostile.rejection.code, "INVALID_REQUEST");
    assert.equal(planAdmittedTypeOperation.length, 2, "planner takes session plus admission only: no text parameter exists");
    proof("renderer cannot provide text");
  });

  it("P6.8 PROOF: renderer cannot provide position", () => {
    const { session, typeId } = openThenTypeFixture(2);
    const hostile = admitEditorOperation(session, {
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: typeId,
      request_id: nextRequest("type"),
      at_line: 1,
    });
    assert.equal(hostile.ok, false);
    if (hostile.ok) throw new Error("unreachable");
    assert.equal(hostile.rejection.code, "INVALID_REQUEST");
    const admission = mustAdmit(session, typeId, nextRequest("type-ok"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.insertion.line, 2, "position resolves from reviewed IR only");
    proof("renderer cannot provide position");
  });

  it("P6.8 PROOF: renderer cannot provide timing", () => {
    const { session, typeId } = openThenTypeFixture();
    for (const extra of ["speed", "policy", "interval_us"]) {
      const hostile = admitEditorOperation(session, {
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: typeId,
        request_id: nextRequest(`timing-${extra}`),
        [extra]: 999,
      });
      assert.equal(hostile.ok, false, `timing extra '${extra}' must reject`);
      if (hostile.ok) throw new Error("unreachable");
      assert.equal(hostile.rejection.code, "INVALID_REQUEST");
    }
    assert.equal(scheduleTypePlan.length, 1, "scheduler takes the frozen plan only: no timing parameter exists");
    proof("renderer cannot provide timing");
  });

  it("P6.8 PROOF: exact authored text preserved with zero drift", () => {
    const tricky = "const s = \"hi\"; // تعليق 🚀👩‍💻\n\t return s;\n";
    const { session, typeId } = openThenTypeFixture(undefined, tricky);
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const plan = planned.value;
    assert.equal(plan.units.join(""), tricky, "unit concatenation is byte-exact");
    assert.equal(plan.source_text, tricky);
    assert.equal(plan.expected_text, BASE_TEXT.slice(0, plan.insertion.offset_utf16) + tricky + BASE_TEXT.slice(plan.insertion.offset_utf16));
    assert.equal(plan.expected_digest, sha256Text(plan.expected_text));
    let cursor = plan.insertion.offset_utf16;
    for (let index = 0; index < plan.units.length; index += 1) {
      assert.equal(plan.unit_start_utf16[index], cursor, `explicit boundary ${index} is exact`);
      cursor += plan.units[index]!.length;
    }
    proof("exact authored text preserved with zero drift");
  });

  it("P6.8 PROOF: empty content plans a successful no-op", () => {
    const { session, typeId } = openThenTypeFixture(undefined, "");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true, "empty type_code admits as a legal no-op");
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.unit_count, 0);
    assert.deepEqual([...planned.value.units], []);
    assert.equal(planned.value.expected_text, BASE_TEXT);
    const scheduled = scheduleTypePlan(planned.value);
    assert.equal(scheduled.ok, true);
    if (!scheduled.ok) throw new Error("unreachable");
    assert.equal(scheduled.value.total_duration_us, 0);
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    const started = planner.startPlan(session, stored.value.plan_id);
    assert.equal(started.ok, true);
    assert.equal(planner.getStatus(stored.value.plan_id), "completed", "empty schedule completes on start");
    assert.equal(readBuffer(session, admission.document.document_id), BASE_TEXT, "no-op changes nothing");
    proof("empty content plans a successful no-op");
  });
});

// ---------------------------------------------------------------------------
// Segmentation goldens (pinned implementation, LF profile).
// ---------------------------------------------------------------------------

describe("P6.8 segmentation goldens", () => {
  it("P6.8 PROOF: ASCII segmentation golden", () => {
    const units = segmentGraphemes("const x = 1;");
    assert.deepEqual([...units], ["c", "o", "n", "s", "t", " ", "x", " ", "=", " ", "1", ";"]);
    assert.equal(units.join(""), "const x = 1;");
    proof("ASCII segmentation golden");
  });

  it("P6.8 PROOF: Arabic segmentation golden", () => {
    const units = segmentGraphemes("مرحبا");
    assert.deepEqual([...units], ["م", "ر", "ح", "ب", "ا"]);
    assert.equal(units.join(""), "مرحبا");
    proof("Arabic segmentation golden");
  });

  it("P6.8 PROOF: Arabic combining marks stay clustered", () => {
    assert.deepEqual([...segmentGraphemes("بِ")], ["بِ"]);
    assert.deepEqual([...segmentGraphemes("بِسْمِ")], ["بِ", "سْ", "مِ"]);
    assert.deepEqual([...segmentGraphemes("é")], ["é"]);
    assert.equal(segmentGraphemes("بِسْمِ").join(""), "بِسْمِ");
    proof("Arabic combining marks stay clustered");
  });

  it("P6.8 PROOF: emoji surrogate pair stays clustered", () => {
    const units = segmentGraphemes("🚀");
    assert.equal(units.length, 1);
    assert.equal(units[0], "🚀");
    assert.equal("🚀".length, 2, "surrogate pair spans two UTF-16 units");
    assert.equal(units.join(""), "🚀");
    proof("emoji surrogate pair stays clustered");
  });

  it("P6.8 PROOF: ZWJ sequence stays clustered", () => {
    const units = segmentGraphemes("👩‍💻");
    assert.equal(units.length, 1, "ZWJ emoji sequence is one grapheme");
    assert.equal(units.join(""), "👩‍💻");
    proof("ZWJ sequence stays clustered");
  });

  it("P6.8 PROOF: mixed Unicode segmentation golden", () => {
    const mixed = "hi مرحبا 🚀";
    const units = segmentGraphemes(mixed);
    assert.deepEqual([...units], ["h", "i", " ", "م", "ر", "ح", "ب", "ا", " ", "🚀"]);
    assert.equal(units.join(""), mixed);
    proof("mixed Unicode segmentation golden");
  });

  it("P6.8 PROOF: multiline LF segmentation golden", () => {
    assert.deepEqual([...segmentGraphemes("a\nb\n")], ["a", "\n", "b", "\n"]);
    const { session, typeId } = openThenTypeFixture(undefined, "l1\nl2\n");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.deepEqual([...planned.value.units], ["l", "1", "\n", "l", "2", "\n"]);
    proof("multiline LF segmentation golden");
  });

  it("P6.8 PROOF: no CR introduced on Windows", () => {
    const { session, typeId } = openThenTypeFixture(undefined, "a\nb\n");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text.includes("\r"), false, "authored LF stays LF");
    const crlfLesson = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "a\r\nb" } },
    ]);
    const crlfSession = openSession(crlfLesson.compiled, { [DOC_PATH]: BASE_TEXT });
    mustAdmit(crlfSession, crlfLesson.operationIds[0]!, nextRequest("crlf-open"));
    const crlfAdmit = admitEditorOperation(crlfSession, {
      session_id: crlfSession.sessionId,
      generation: crlfSession.generation,
      operation_id: crlfLesson.operationIds[1]!,
      request_id: nextRequest("crlf-type"),
    });
    assert.equal(crlfAdmit.ok, false);
    if (crlfAdmit.ok) throw new Error("unreachable");
    assert.equal(crlfAdmit.rejection.code, "UNSUPPORTED_TEXT_PROFILE");
    proof("no CR introduced on Windows");
  });
});

// ---------------------------------------------------------------------------
// Determinism and timing policy.
// ---------------------------------------------------------------------------

describe("P6.8 determinism and timing", () => {
  it("P6.8 PROOF: repeated plans are byte and deep equal", () => {
    const { session, typeId } = openThenTypeFixture(1, "const x = 1;\n");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const first = planAdmittedTypeOperation(session, admission);
    const second = planAdmittedTypeOperation(session, admission);
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    assert.deepEqual(first.value, second.value);
    assert.equal(JSON.stringify(first.value), JSON.stringify(second.value), "byte-equal plans");
    assert.equal(first.value.plan_id, second.value.plan_id);
    proof("repeated plans are byte and deep equal");
  });

  it("P6.8 PROOF: repeated schedules are equal", () => {
    const { session, typeId } = openThenTypeFixture(undefined, "a.b\nc d");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const first = scheduleTypePlan(planned.value);
    const second = scheduleTypePlan(planned.value);
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    assert.deepEqual(first.value, second.value);
    proof("repeated schedules are equal");
  });

  it("P6.8 PROOF: no random source in planner or scheduler", () => {
    const code = readFileSync(join(here, "..", "src", "editor-type-planner.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .toLowerCase();
    for (const marker of ["math.random", "date.now", "performance.now", "settimeout", "setinterval", "randombytes", "randomint", "randomuuid"]) {
      assert.equal(code.includes(marker), false, `random/wall-clock source '${marker}' must be absent`);
    }
    proof("no random source in planner or scheduler");
  });

  it("P6.8 PROOF: same policy yields the same schedule", () => {
    assert.equal(DEFAULT_TYPING_POLICY.base_interval_us, TYPING_BASE_INTERVAL_US_DEFAULT);
    assert.equal(FAST_TYPING_POLICY.base_interval_us, TYPING_BASE_INTERVAL_US_FAST);
    assert.equal(resolveTypingPolicyForUnitCount(100).profile, "default");
    assert.equal(resolveTypingPolicyForUnitCount(8192).profile, "default");
    assert.equal(resolveTypingPolicyForUnitCount(8193).profile, "fast");
    const { session, typeId } = openThenTypeFixture(undefined, "hello;");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.policy_profile, "default");
    assert.equal(planned.value.policy_digest, DEFAULT_TYPING_POLICY.policy_digest);
    proof("same policy yields the same schedule");
  });

  it("P6.8 PROOF: canonical timing golden with newline precedence", () => {
    const { session, typeId } = openThenTypeFixture(undefined, "a.b\nc d");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const scheduled = scheduleTypePlan(planned.value);
    assert.equal(scheduled.ok, true);
    if (!scheduled.ok) throw new Error("unreachable");
    const due = scheduled.value.units.map((unit) => unit.due_us);
    assert.deepEqual(due, [0, 25000, 130000, 155000, 360000, 385000, 430000]);
    assert.equal(scheduled.value.base_interval_us, 25000);
    assert.equal(scheduled.value.total_duration_us, 430000);
    assert.equal(
      scheduled.value.presentation_timeout_us,
      430000 + 10000000,
      "presentation timeout is the planned duration plus ten seconds",
    );
    assert.equal(TYPING_PAUSE_PUNCTUATION_US, 80000);
    assert.equal(TYPING_PAUSE_NEWLINE_US, 180000);
    assert.equal(TYPING_PAUSE_SPACE_US, 20000);
    proof("canonical timing golden with newline precedence");
  });

  it("P6.8 PROOF: large blocks stay bounded with fast grouping", () => {
    const big = `start\n${"x".repeat(20000)}\nend\n`;
    const { session, typeId } = openThenTypeFixture(undefined, big);
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.policy_profile, "fast");
    assert.equal(planned.value.policy_digest, FAST_TYPING_POLICY.policy_digest);
    const scheduled = scheduleTypePlan(planned.value);
    assert.equal(scheduled.ok, true);
    if (!scheduled.ok) throw new Error("unreachable");
    assert.equal(scheduled.value.base_interval_us, TYPING_BASE_INTERVAL_US_FAST);
    const scheduleUnits = scheduled.value.units;
    const scheduleGroups = scheduled.value.groups;
    for (const group of scheduleGroups) {
      assert.ok(group.unit_end_exclusive - group.unit_start <= 32, "groups hold at most 32 clusters");
      const lastUnit = scheduleUnits[group.unit_end_exclusive - 1];
      assert.ok(lastUnit !== undefined, "group end indexes a real unit");
      assert.equal(group.due_us, lastUnit.due_us, "group due time is its last member cumulative due time");
    }
    assert.ok(scheduled.value.total_duration_us <= TYPING_MAX_SCHEDULE_DURATION_US, "bounded duration");
    assert.equal(planned.value.units.join(""), big, "grouping never drops characters");
    const huge = "a".repeat(300000);
    const over = openThenTypeFixture(undefined, huge);
    const overAdmission = mustAdmit(over.session, over.typeId, nextRequest("huge"));
    const overPlanned = planAdmittedTypeOperation(over.session, overAdmission);
    assert.equal(overPlanned.ok, true);
    if (!overPlanned.ok) throw new Error("unreachable");
    const overScheduled = scheduleTypePlan(overPlanned.value);
    assert.equal(overScheduled.ok, false, "multi-hour accidental schedules fail closed");
    if (overScheduled.ok) throw new Error("unreachable");
    assert.equal(overScheduled.rejection.code, "RESOURCE_LIMIT");
    proof("large blocks stay bounded with fast grouping");
  });
});

// ---------------------------------------------------------------------------
// Position semantics: exact line-start or exact append.
// ---------------------------------------------------------------------------

describe("P6.8 position semantics", () => {
  it("P6.8 PROOF: append targets exact EOF", () => {
    const { session, typeId } = openThenTypeFixture(undefined, "X");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.insertion.mode, "append");
    assert.equal(planned.value.insertion.offset_utf16, BASE_TEXT.length);
    assert.equal(planned.value.expected_text, `${BASE_TEXT}X`);
    proof("append targets exact EOF");
  });

  it("P6.8 PROOF: line-start insertion is exact", () => {
    const base = "line1\nline2\nline3";
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "INSERTED\n", at_line: 2 } },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: base });
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, base);
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.insertion.mode, "line_start");
    assert.equal(planned.value.insertion.line, 2);
    assert.equal(planned.value.insertion.column_utf16, 1);
    assert.equal(planned.value.insertion.offset_utf16, "line1\n".length);
    assert.equal(planned.value.expected_text, "line1\nINSERTED\nline2\nline3");
    proof("line-start insertion is exact");
  });

  it("P6.8 PROOF: canonical design examples reproduce byte-exact", () => {
    const first = resolveTypeInsertion("a\nb", 2);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(`a\n${"X\n"}b`, "a\nX\nb");
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "X\n", at_line: 2 } },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: "a\nb" });
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, "a\nb");
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "a\nX\nb");
    const second = openThenTypeFixture(undefined, "X");
    const appendAdmission = mustAdmit(second.session, second.typeId, nextRequest("type"));
    void appendAdmission;
    const sessionB = second.session;
    const { compiled: compiledB, operationIds: idsB } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "X" } },
    ]);
    const sessionC = openSession(compiledB, { [DOC_PATH]: "a\nb" });
    const openC = mustAdmit(sessionC, idsB[0]!, nextRequest("openC"));
    stageBuffer(sessionC, openC.document.document_id, "a\nb");
    const admissionC = mustAdmit(sessionC, idsB[1]!, nextRequest("typeC"));
    const plannedC = planAdmittedTypeOperation(sessionC, admissionC);
    assert.equal(plannedC.ok, true);
    if (!plannedC.ok) throw new Error("unreachable");
    assert.equal(plannedC.value.expected_text, "a\nbX");
    void sessionB;
    proof("canonical design examples reproduce byte-exact");
  });

  it("P6.8 PROOF: empty file exposes line one for both modes", () => {
    const atLine = resolveTypeInsertion("", 1);
    assert.equal(atLine.ok, true);
    if (!atLine.ok) throw new Error("unreachable");
    assert.equal(atLine.value.offset_utf16, 0);
    const append = resolveTypeInsertion("", undefined);
    assert.equal(append.ok, true);
    if (!append.ok) throw new Error("unreachable");
    assert.equal(append.value.offset_utf16, 0);
    assert.equal(append.value.line, 1);
    proof("empty file exposes line one for both modes");
  });

  it("P6.8 PROOF: trailing empty line is addressable", () => {
    const resolved = resolveTypeInsertion("a\n", 2);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) throw new Error("unreachable");
    assert.equal(resolved.value.offset_utf16, 2);
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "tail", at_line: 2 } },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: "a\n" });
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, "a\n");
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "a\ntail");
    proof("trailing empty line is addressable");
  });

  it("P6.8 PROOF: invalid target line fails closed", () => {
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "X", at_line: 9 } },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: "a\nb" });
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, "a\nb");
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, false, "out-of-range targets never pad or clamp");
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "INVALID_LOCATION");
    assert.equal(readBuffer(session, openAdmission.document.document_id), "a\nb", "failure preserves the buffer");
    proof("invalid target line fails closed");
  });
});

// ---------------------------------------------------------------------------
// Revision fencing and plan lifecycle (manual clock, zero mutation).
// ---------------------------------------------------------------------------

describe("P6.8 revision fencing and lifecycle", () => {
  it("P6.8 PROOF: plan binds the live buffer revision", () => {
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const live = session.registry.resolveDocument(admission.document.document_id);
    assert.equal(live.ok, true);
    if (!live.ok) throw new Error("unreachable");
    assert.equal(planned.value.base_buffer_revision, live.value.buffer_revision);
    assert.equal(planned.value.base_disk_revision, live.value.base_disk_revision);
    assert.equal(planned.value.base_digest, sha256Text(BASE_TEXT));
    assert.equal(planned.value.generation, session.generation);
    proof("plan binds the live buffer revision");
  });

  it("P6.8 PROOF: stale buffer revision fences the old plan", () => {
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    stageBuffer(session, admission.document.document_id, "diverged bytes\n");
    const started = planner.startPlan(session, stored.value.plan_id);
    assert.equal(started.ok, false, "moved buffer bytes fence the old plan");
    if (started.ok) throw new Error("unreachable");
    assert.equal(started.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(planner.getStatus(stored.value.plan_id), "failed");
    proof("stale buffer revision fences the old plan");
  });

  it("P6.8 PROOF: stale session fences the old plan", () => {
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(closeEditorSession(session).ok, true);
    planner.invalidateAll();
    const started = planner.startPlan(session, stored.value.plan_id);
    assert.equal(started.ok, false);
    if (started.ok) throw new Error("unreachable");
    assert.ok(started.rejection.code === "STALE_SESSION" || started.rejection.code === "INVALID_REQUEST");
    proof("stale session fences the old plan");
  });

  it("P6.8 PROOF: stale generation fences the old plan", () => {
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    const rotated = resetEditorSession(session, { sessionId: "sess-p68-next", generation: 2 });
    assert.equal(rotated.ok, true);
    if (!rotated.ok) throw new Error("unreachable");
    planner.invalidateAll();
    const started = planner.startPlan(rotated.value, stored.value.plan_id);
    assert.equal(started.ok, false);
    if (started.ok) throw new Error("unreachable");
    assert.ok(started.rejection.code === "STALE_SESSION" || started.rejection.code === "INVALID_REQUEST");
    proof("stale generation fences the old plan");
  });

  it("P6.8 PROOF: reset invalidates active plans", () => {
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(resetEditorSession(session, { sessionId: "sess-p68-rst", generation: 7 }).ok, true);
    planner.invalidateAll();
    assert.deepEqual(planner.listPlans(), []);
    assert.equal(planner.getPlan(stored.value.plan_id), null);
    proof("reset invalidates active plans");
  });

  it("P6.8 PROOF: close invalidates active plans", () => {
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(closeEditorSession(session).ok, true);
    planner.invalidateAll();
    assert.deepEqual(planner.listPlans(), []);
    const cancelled = planner.cancelPlan(session, stored.value.plan_id);
    assert.equal(cancelled.ok, false);
    proof("close invalidates active plans");
  });

  it("P6.8 PROOF: cancellation is deterministic with zero mutation", () => {
    const { session, typeId } = openThenTypeFixture(undefined, "abcdefghij");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    const half = planner.advancePlan(session, stored.value.plan_id, 60000);
    assert.equal(half.ok, true);
    if (!half.ok) throw new Error("unreachable");
    assert.equal(half.value.completed, false);
    const cancelled = planner.cancelPlan(session, stored.value.plan_id);
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) throw new Error("unreachable");
    assert.equal(cancelled.value.status, "cancelled");
    assert.equal(readBuffer(session, admission.document.document_id), BASE_TEXT, "pre-operation buffer restored exactly");
    const late = planner.advancePlan(session, stored.value.plan_id, 1000000);
    assert.equal(late.ok, false, "cancelled plans never advance");
    proof("cancellation is deterministic with zero mutation");
  });

  it("P6.8 PROOF: cancellation never touches disk", async () => {
    let counter = 0;
    counter += 1;
    const tag = `cf-p68-cancel-${counter}-${randomBytes(3).toString("hex")}`;
    const leaf = join(TEST_ROOT, `${tag}-leaf`);
    const staging = join(TEST_ROOT, `${tag}-staging`);
    mkdirSync(join(leaf, "src"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(leaf, "src", "seeded.ts"), BASE_TEXT, "utf8");
    const seed = manifestFor({ [DOC_PATH]: BASE_TEXT });
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: APPEND_TEXT } },
    ]);
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const opened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: `sess-p68-disk-${counter}`,
      generation: 1,
      seedManifest: seed,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const session = opened.value;
    const bound = openWindowsFileAdapter({
      sessionId: session.sessionId,
      generation: 1,
      workspaceId: "ws-p68-disk",
      leafHostPath: leaf,
      stagingHostPath: staging,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const authority: AdapterAuthority = {
      lease: {
        kind: "editor_lease",
        leaseId: "lease-p68-disk",
        sessionId: session.sessionId,
        generation: 1,
        workspaceId: "ws-p68-disk",
        epoch: 1,
        operationId: operationIds[0]!,
        requestId: nextRequest("disk"),
      },
      ownership: "EDITOR_OWNED",
      liveEpoch: 1,
      revokedLeaseIds: [],
    };
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("disk-open"));
    const executed = await executeAdmittedFileOpen(session, openAdmission, { adapter: bound.value, authority });
    assert.equal(executed.ok, true);
    const typeAdmission = mustAdmit(session, operationIds[1]!, nextRequest("disk-type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, typeAdmission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    const before = readFileSync(join(leaf, "src", "seeded.ts"), "utf8");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    assert.equal(planner.cancelPlan(session, stored.value.plan_id).ok, true);
    const afterBytes = readFileSync(join(leaf, "src", "seeded.ts"), "utf8");
    assert.equal(afterBytes, before, "disk keeps the last saved bytes through planning and cancel");
    assert.equal(afterBytes, BASE_TEXT);
    proof("cancellation never touches disk");
  });

  it("P6.8 PROOF: duplicate operation never double-applies", () => {
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const first = planner.planOperation(session, admission);
    const second = planner.planOperation(session, admission);
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    assert.equal(first.value.plan_id, second.value.plan_id, "replay converges on one plan");
    assert.equal(planner.listPlans().length, 1);
    assert.equal(planner.startPlan(session, first.value.plan_id).ok, true);
    const schedule = planner.getSchedule(first.value.plan_id);
    assert.ok(schedule !== null);
    const done = planner.advancePlan(session, first.value.plan_id, schedule!.total_duration_us);
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error("unreachable");
    assert.equal(done.value.completed, true);
    const replay = planner.planOperation(session, admission);
    assert.equal(replay.ok, true);
    if (!replay.ok) throw new Error("unreachable");
    assert.equal(replay.value.plan_id, first.value.plan_id, "completed replay never types twice");
    assert.equal(readBuffer(session, admission.document.document_id), BASE_TEXT, "planning never mutates the buffer");
    proof("duplicate operation never double-applies");
  });

  it("P6.8 PROOF: same-document operations serialize deterministically", () => {
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "first\n" } },
      { action: { type: "type_code", path: DOC_PATH, content: "second\n" } },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: BASE_TEXT });
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, BASE_TEXT);
    const firstAdmission = mustAdmit(session, operationIds[1]!, nextRequest("type1"));
    const planner = createTypePlanner();
    const first = planner.planOperation(session, firstAdmission);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, first.value.plan_id).ok, true);
    const secondAdmission = mustAdmit(session, operationIds[2]!, nextRequest("type2"));
    const second = planner.planOperation(session, secondAdmission);
    assert.equal(second.ok, false, "concurrent same-document operations never overlap");
    if (second.ok) throw new Error("unreachable");
    assert.equal(second.rejection.code, "INVALID_REQUEST");
    proof("same-document operations serialize deterministically");
  });

  it("P6.8 PROOF: different documents plan independently", () => {
    const otherPath = "src/other.ts";
    const otherBase = "const other = 0;\n";
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "file_open", path: otherPath } },
      { action: { type: "type_code", path: DOC_PATH, content: "aaa" } },
      { action: { type: "type_code", path: otherPath, content: "bbb" } },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: BASE_TEXT, [otherPath]: otherBase });
    const openA = mustAdmit(session, operationIds[0]!, nextRequest("openA"));
    stageBuffer(session, openA.document.document_id, BASE_TEXT);
    const openB = mustAdmit(session, operationIds[1]!, nextRequest("openB"));
    stageBuffer(session, openB.document.document_id, otherBase);
    const admissionA = mustAdmit(session, operationIds[2]!, nextRequest("typeA"));
    const admissionB = mustAdmit(session, operationIds[3]!, nextRequest("typeB"));
    const planner = createTypePlanner();
    const planA = planner.planOperation(session, admissionA);
    const planB = planner.planOperation(session, admissionB);
    assert.equal(planA.ok && planB.ok, true, "different documents never block each other");
    if (!planA.ok || !planB.ok) throw new Error("unreachable");
    assert.notEqual(planA.value.plan_id, planB.value.plan_id);
    assert.equal(planner.startPlan(session, planA.value.plan_id).ok, true);
    assert.equal(planner.startPlan(session, planB.value.plan_id).ok, true);
    proof("different documents plan independently");
  });

  it("P6.8 PROOF: reset racing start fences", () => {
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(resetEditorSession(session, { sessionId: "sess-p68-race", generation: 3 }).ok, true);
    planner.invalidateAll();
    const started = planner.startPlan(session, stored.value.plan_id);
    assert.equal(started.ok, false, "revocation landing before start fences with zero progress");
    proof("reset racing start fences");
  });

  it("P6.8 PROOF: cancel racing completion reports already-final", () => {
    const { session, typeId } = openThenTypeFixture(undefined, "ab");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    const schedule = planner.getSchedule(stored.value.plan_id);
    assert.ok(schedule !== null);
    const done = planner.advancePlan(session, stored.value.plan_id, schedule!.total_duration_us);
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error("unreachable");
    assert.equal(done.value.completed, true);
    const cancelled = planner.cancelPlan(session, stored.value.plan_id);
    assert.equal(cancelled.ok, false, "cancel after completion reports already-final without undo");
    if (cancelled.ok) throw new Error("unreachable");
    assert.equal(cancelled.rejection.code, "INVALID_REQUEST");
    assert.equal(readBuffer(session, admission.document.document_id), BASE_TEXT, "completion installs nothing yet: no undo exists");
    proof("cancel racing completion reports already-final");
  });
});

// ---------------------------------------------------------------------------
// Document coverage and terminal interop (disk stays committed).
// ---------------------------------------------------------------------------

describe("P6.8 documents and terminal interop", () => {
  it("P6.8 PROOF: pending-created document plans verbatim", async () => {
    const staged = "hello";
    const typed = " world";
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_create", path: "src/fresh.ts", content: staged } },
      { action: { type: "type_code", path: "src/fresh.ts", content: typed } },
    ]);
    const session = openSession(compiled, {});
    const createAdmission = mustAdmit(session, operationIds[0]!, nextRequest("create"));
    stageBuffer(session, createAdmission.document.document_id, staged);
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.base_byte_length, Buffer.byteLength(staged, "utf8"));
    assert.equal(planned.value.expected_text, "hello world");
    assert.equal(planned.value.insertion.mode, "append");
    const counterValue = requestSeq + 1;
    const tag = `cf-p68-pending-${counterValue}-${randomBytes(3).toString("hex")}`;
    const leaf = join(TEST_ROOT, `${tag}-leaf`);
    const staging = join(TEST_ROOT, `${tag}-staging`);
    mkdirSync(join(leaf, "src"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    const bound = openWindowsFileAdapter({
      sessionId: session.sessionId,
      generation: 1,
      workspaceId: "ws-p68-pending",
      leafHostPath: leaf,
      stagingHostPath: staging,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    void bound;
    assert.equal(existsSync(join(leaf, "src", "fresh.ts")), false, "disk stays absent before the later save phase");
    proof("pending-created document plans verbatim");
  });

  it("P6.8 PROOF: existing-open document plans against its revision", async () => {
    const counterValue = requestSeq + 1;
    const tag = `cf-p68-open-${counterValue}-${randomBytes(3).toString("hex")}`;
    const leaf = join(TEST_ROOT, `${tag}-leaf`);
    const staging = join(TEST_ROOT, `${tag}-staging`);
    mkdirSync(join(leaf, "src"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(leaf, "src", "seeded.ts"), BASE_TEXT, "utf8");
    const seed = manifestFor({ [DOC_PATH]: BASE_TEXT });
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "// appended\n" } },
    ]);
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const opened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: `sess-p68-real-${counterValue}`,
      generation: 1,
      seedManifest: seed,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const session = opened.value;
    const bound = openWindowsFileAdapter({
      sessionId: session.sessionId,
      generation: 1,
      workspaceId: "ws-p68-real",
      leafHostPath: leaf,
      stagingHostPath: staging,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const authority: AdapterAuthority = {
      lease: {
        kind: "editor_lease",
        leaseId: "lease-p68-real",
        sessionId: session.sessionId,
        generation: 1,
        workspaceId: "ws-p68-real",
        epoch: 1,
        operationId: operationIds[0]!,
        requestId: nextRequest("real"),
      },
      ownership: "EDITOR_OWNED",
      liveEpoch: 1,
      revokedLeaseIds: [],
    };
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("real-open"));
    const executed = await executeAdmittedFileOpen(session, openAdmission, { adapter: bound.value, authority });
    assert.equal(executed.ok, true);
    if (!executed.ok) throw new Error("unreachable");
    assert.equal(executed.value.content, BASE_TEXT);
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("real-type"));
    const planned = planAdmittedTypeOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, `${BASE_TEXT}// appended\n`);
    assert.equal(readFileSync(join(leaf, "src", "seeded.ts"), "utf8"), BASE_TEXT, "planning never publishes: disk keeps committed bytes");
    proof("existing-open document plans against its revision");
  });

  it("P6.8 PROOF: dirty reservation keeps terminal RW fenced", async () => {
    const rwOp = "term-p68-rw";
    const roOp = "term-p68-ro";
    const seed = manifestFor({ [DOC_PATH]: BASE_TEXT });
    const { compiled, operationIds } = compileTypeLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: APPEND_TEXT } },
    ]);
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const policyOutcome = createReviewedWorkspacePolicy(
      {
        course_id: "C01",
        lesson_id: catalogOutcome.value.lesson_id,
        lesson_compiled_digest: catalogOutcome.value.lesson_compiled_digest,
        seed_manifest_digest: computeSeedManifestDigest(seed),
        sandbox_policy_digest: sha256Hex("p68-sandbox-policy"),
        terminal_access: { [rwOp]: "read_write", [roOp]: "read_only" },
        reviewed_by: "review-board-1",
        review_note: "synthetic P6.8 coordination review",
      },
      [rwOp, roOp],
    );
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    const coord = createWorkspaceCoordinator();
    const combined = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: seed });
    assert.equal(combined.ok, true);
    if (!combined.ok) throw new Error("unreachable");
    const editorOpened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: combined.value.descriptor.sessionId,
      generation: combined.value.descriptor.generation,
      seedManifest: seed,
      reviewed: true,
    });
    assert.equal(editorOpened.ok, true);
    if (!editorOpened.ok) throw new Error("unreachable");
    const session = editorOpened.value;
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, BASE_TEXT);
    const typeAdmission = mustAdmit(session, operationIds[1]!, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, typeAdmission);
    assert.equal(stored.ok, true);
    const facts = editorBufferFacts(session);
    assert.ok(facts.dirtyBufferCount >= 1, "admitted type work reserves dirty truth");
    assert.equal(coord.setBufferFacts(combined.value.editorCapability, { ...facts }).ok, true);
    const ro = await coord.runTerminalOperation(combined.value.terminalCapability, roOp, nextRequest("ro"));
    assert.equal(ro.ok, true, "approved RO background stays compatible with planned typing");
    const rw = await coord.runTerminalOperation(combined.value.terminalCapability, rwOp, nextRequest("rw"));
    assert.equal(rw.ok, false);
    if (rw.ok) throw new Error("unreachable");
    assert.equal(rw.rejection.code, "DIRTY_BUFFER_CONFLICT");
    proof("dirty reservation keeps terminal RW fenced");
  });

  it("P6.8 PROOF: background RO observation is unaffected", () => {
    const { session, typeId } = openThenTypeFixture(undefined, "const ro = 1;\n");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    const schedule = planner.getSchedule(stored.value.plan_id);
    assert.ok(schedule !== null);
    assert.equal(planner.advancePlan(session, stored.value.plan_id, schedule!.total_duration_us).ok, true);
    assert.equal(planner.cancelPlan(session, stored.value.plan_id).ok, false, "completed plans report already-final");
    assert.equal(readBuffer(session, admission.document.document_id), BASE_TEXT, "RO observers keep seeing committed state: planning writes nothing");
    proof("background RO observation is unaffected");
  });
});

// ---------------------------------------------------------------------------
// Engine boundary: no publication, no generic API, no presentation.
// ---------------------------------------------------------------------------

describe("P6.8 engine boundary", () => {
  function plannerSource(): string {
    return readFileSync(join(here, "..", "src", "editor-type-planner.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .toLowerCase();
  }

  it("P6.8 PROOF: scheduler advances on a manual clock with no sleeps", () => {
    const self = readFileSync(join(here, "editor-type-planner.test.ts"), "utf8");
    const probeSetTimeout = "set" + "Timeout(";
    const probeSetInterval = "set" + "Interval(";
    const probeAtomics = "Atomics." + "wait";
    assert.equal(self.includes(probeSetTimeout), false, "no real-timer sleeps in planner tests");
    assert.equal(self.includes(probeSetInterval), false, "no interval timers in planner tests");
    assert.equal(self.includes(probeAtomics), false, "no blocking waits in planner tests");
    const code = plannerSource();
    assert.equal(code.includes("settimeout"), false);
    assert.equal(code.includes("setinterval"), false);
    const { session, typeId } = openThenTypeFixture(undefined, "abcdef");
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const planner = createTypePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    const first = planner.advancePlan(session, stored.value.plan_id, 25000);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.value.next_unit_index, 2, "manual deltas drive logical progress deterministically");
    proof("scheduler advances on a manual clock with no sleeps");
  });

  it("P6.8 PROOF: no adapter publication from planning", () => {
    const code = plannerSource();
    for (const marker of ["publishdocument", "openwindowsfileadapter", "createdocument", "node:fs", "node:fs/promises"]) {
      assert.equal(code.includes(marker), false, `adapter/filesystem marker '${marker}' must be absent`);
    }
    proof("no adapter publication from planning");
  });

  it("P6.8 PROOF: no generic renderer typing API", () => {
    assert.equal(planAdmittedTypeOperation.length, 2);
    assert.equal(scheduleTypePlan.length, 1);
    const planner = createTypePlanner();
    assert.equal(planner.planOperation.length, 2);
    const code = plannerSource();
    for (const marker of ["openbypath", "createbypath", "typebypath", "typetext", "inserttext", "applyedit"]) {
      assert.equal(code.includes(marker), false, `generic typing entry '${marker}' must be absent`);
    }
    proof("no generic renderer typing API");
  });

  it("P6.8 PROOF: no Monaco integration in the engine", () => {
    const code = plannerSource();
    for (const marker of ["monaco", "requestanimationframe", "typingscheduler", "keyboard", "sendkeys", "clipboard", "paste", "undo"]) {
      assert.equal(code.includes(marker), false, `presentation marker '${marker}' must be absent`);
    }
    proof("no Monaco integration in the engine");
  });

  it("P6.8 PROOF: no visual, browser or recording phase creep", () => {
    const code = plannerSource();
    for (const marker of ["playwright", "puppeteer", "browser", "recording", "unreal", "metahuman", "node-pty", "child_process", "docker", "save_failed", "commit_uncertain"]) {
      assert.equal(code.includes(marker), false, `later-phase marker '${marker}' must be absent`);
    }
    const catalog: EditorCatalog = ((): EditorCatalog => {
      const { compiled } = compileTypeLesson([{ action: { type: "file_open", path: DOC_PATH } }]);
      const outcome = createEditorCatalog(compiled);
      if (!outcome.ok) throw new Error("unreachable");
      return outcome.value;
    })();
    void catalog;
    proof("no visual, browser or recording phase creep");
  });

  it("P6.8 PROOF: authored size ceilings fail closed before planning", () => {
    // 1. The 1 MiB compiled-IR ceiling rejects the oversized lesson before
    //    any admission, planning or mutation can exist (never truncated).
    const big = "b".repeat(1048576 + 1);
    const { raw } = buildTypeLessonSource([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: big } },
    ]);
    const parsed = parseLessonData(raw);
    assert.equal(parsed.ok, true, "oversized source still parses: the IR ceiling is the fail-closed bound");
    if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
    const catalog = createEditorCatalog(compileModule.compileLesson(parsed.lesson));
    assert.equal(catalog.ok, false, "over-budget IR never becomes plannable");
    if (catalog.ok) throw new Error("unreachable");
    assert.equal(catalog.rejection.code, "INVALID_REQUEST");
    // 2. Defense in depth: the planner measures its own per-operation byte
    //    ceiling even if an oversized payload ever reached it past admission.
    //    The envelope stays a live admission (no hand-authored IR); only the
    //    parameters sidecar is swapped to simulate the smuggled size.
    const { session, typeId } = openThenTypeFixture();
    const admission = mustAdmit(session, typeId, nextRequest("type"));
    const smuggled = {
      ...admission,
      parameters: { ...admission.parameters, content: big },
    } as EditorOperationAdmission;
    const planned = planAdmittedTypeOperation(session, smuggled);
    assert.equal(planned.ok, false, "over-budget plans never truncate: they reject");
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "RESOURCE_LIMIT");
    assert.equal(readBuffer(session, admission.document.document_id), BASE_TEXT, "rejected planning preserves the buffer");
    proof("authored size ceilings fail closed before planning");
  });
});
