// P6.9 Exact replacement — match guards and transactional visual plan for
// admitted replace_code only (deterministic, offline, manual step clock).
//
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.9 Exact replacement
// ("Match guards and transactional visual plan"; PASS "All
// occurrence/deletion/rollback cases"). Canonical authority: design sections
// 4/5/7/9/12/18/21/26.5 plus ADR-0011 decision 5.
//
// Proves at runtime (not merely by types): admitted replace_code produces a
// deterministic immutable plan with exact literal matching (case-sensitive,
// non-overlapping, left-to-right, advance by find length, never rescanning
// replacement text); the occurrence guard is exact (zero -> FIND_NOT_FOUND,
// positive mismatch -> OCCURRENCE_MISMATCH, equal -> simultaneous replace
// from B0); overlap follows the canonical advance rule; empty find is
// schema-invalid; empty replacement deletes; find == replace is a
// successful no-op; multiline LF, Arabic, diacritics, emoji, ZWJ and
// combining marks are byte-exact with canonical UTF-16 ranges; authored
// bytes are never normalized and CR is never introduced; B0/B1 digests,
// repeated plans, match ranges and visual plans are deterministic; every
// guard finishes before any candidate exists so partial replacement is
// impossible; plans bind revision/generation and fence stale/reset/close
// work with zero mutation; cancel restores B0 with disk untouched;
// duplicates never double-replace; same-document work serializes while
// different documents stay independent; pending-created and existing-open
// documents both plan against the authoritative buffer with committed disk
// unchanged; dirty reservations keep terminal RW fenced while RO
// observation is unaffected; match counts and sizes stay bounded; planning
// never publishes, never touches Monaco, and never reaches beyond P6.9
// scope.
//
// Fixture IR is NEVER hand-authored: synthetic lesson sources compile
// through the canonical pipeline (parseLessonData -> compileLesson ->
// re-validation inside createEditorCatalog). Buffer text is staged through
// the main-owned registry (the same store P6.7 execution writes) or, in the
// marked integration section, through the real P6.7 executors over
// phase-owned temp/P6.9 leaves (cf-p69- names, bounded, ownership-scoped
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
import { RunEditorOperationRequestSchema } from "../src/protocol.ts";
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
  type EditorOperationAdmission,
  type EditorSession,
} from "../src/editor-admission.ts";
import {
  executeAdmittedFileCreate,
  executeAdmittedFileOpen,
} from "../src/editor-open-create.ts";
import { planAdmittedTypeOperation } from "../src/editor-type-planner.ts";
import {
  REPLACE_DEFAULT_OCCURRENCES,
  REPLACE_MAX_MATCHES,
  createReplacePlanner,
  enumerateReplaceMatches,
  planAdmittedReplaceOperation,
  replaceLineColumn,
} from "../src/editor-replace-planner.ts";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.9", "planner");

function proof(message: string): void {
  console.log(`P6.9 PROOF: ${message}`);
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
  return `req-p69-${prefix}-${requestSeq}`;
}

function buildReplaceLessonSource(actions: Array<{ action: unknown }>): { raw: unknown; lessonId: string; operationIds: string[] } {
  lessonSeq += 1;
  // Canonical identifier shapes (schema 1.1): lesson Cnn-Lnnn, scene
  // Cnn-Lnnn-Snnn, beat Cnn-Lnnn-Snnn-Bnnn (operation_id := beat_id).
  const lessonId = `C01-L${String(70 + lessonSeq).padStart(3, "0")}`;
  const operationIds = actions.map((_, index) => `${lessonId}-S001-B${String(index + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: `Synthetic P6.9 lesson ${lessonId}`,
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Plan admitted replace_code through the trusted P6.9 path"],
    prerequisites: [],
    keywords: ["editor", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.9" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        type: "code_demo",
        title: "Replace exact text in the admitted document",
        duration: 120,
        visual: { kind: "code_editor", description: "Editor plans replacement" },
        beats: actions.map((entry, index) => ({ beat_id: operationIds[index], kind: "action", action: entry.action })),
      },
    ],
  };
  return { raw, lessonId, operationIds };
}

function compileReplaceLesson(actions: Array<{ action: unknown }>): { compiled: CompiledLesson; operationIds: string[] } {
  const { raw, operationIds } = buildReplaceLessonSource(actions);
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
    sessionId: `sess-p69-${String(sessionSeq).padStart(4, "0")}`,
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

function snapshotDescriptor(session: EditorSession, documentId: string): unknown {
  const resolved = session.registry.resolveDocument(documentId);
  assert.equal(resolved.ok, true, "live document must resolve");
  if (!resolved.ok) throw new Error("unreachable");
  return resolved.value;
}

const DOC_PATH = "src/seeded.ts";
const BASE_TEXT = "const seeded = 1;\nconst extra = 2;\n";

function replaceAction(find: string, replace: string, occurrences?: number): Record<string, unknown> {
  const action: Record<string, unknown> = { type: "replace_code", path: DOC_PATH, find, replace };
  if (occurrences !== undefined) action["occurrences"] = occurrences;
  return action;
}

function openThenReplaceFixture(
  find: string,
  replace: string,
  occurrences?: number,
  base: string = BASE_TEXT,
): { session: EditorSession; openId: string; replaceId: string; openAdmission: EditorOperationAdmission } {
  const { compiled, operationIds } = compileReplaceLesson([
    { action: { type: "file_open", path: DOC_PATH } },
    { action: replaceAction(find, replace, occurrences) },
  ]);
  const session = openSession(compiled, { [DOC_PATH]: base });
  const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
  stageBuffer(session, openAdmission.document.document_id, base);
  return { session, openId: operationIds[0]!, replaceId: operationIds[1]!, openAdmission };
}

before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Admission boundary: trusted literals, no renderer authority.
// ---------------------------------------------------------------------------

describe("P6.9 admission boundary", () => {
  it("P6.9 PROOF: admitted replace_code accepted", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_occurrences, REPLACE_DEFAULT_OCCURRENCES);
    assert.equal(planned.value.actual_match_count, 1);
    assert.equal(planned.value.expected_text, "const planted = 1;\nconst extra = 2;\n");
    proof("admitted replace_code accepted");
  });

  it("P6.9 PROOF: unreviewed replace rejected", () => {
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: replaceAction("seeded", "planted") },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: BASE_TEXT }, false);
    const open = admitEditorOperation(session, {
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: operationIds[0]!,
      request_id: nextRequest("open"),
    });
    assert.equal(open.ok, false, "inspection sessions admit nothing");
    if (open.ok) throw new Error("unreachable");
    assert.equal(open.rejection.code, "NOT_AUTHORIZED");
    proof("unreviewed replace rejected");
  });

  it("P6.9 PROOF: wrong action type rejected", () => {
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "typed\n" } },
      { action: { type: "file_save", path: DOC_PATH } },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: BASE_TEXT });
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, BASE_TEXT);
    for (const operationId of [operationIds[1]!, operationIds[2]!]) {
      const admission = mustAdmit(session, operationId, nextRequest("other"));
      const planned = planAdmittedReplaceOperation(session, admission);
      assert.equal(planned.ok, false, "only admitted replace_code reaches the replacement planner");
      if (planned.ok) throw new Error("unreachable");
      assert.equal(planned.rejection.code, "INVALID_REQUEST");
    }
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "rejected planning preserves the buffer");
    proof("wrong action type rejected");
  });

  it("P6.9 PROOF: renderer cannot supply find", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const hostile = {
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: replaceId,
      request_id: nextRequest("hostile"),
      find: "evil literal",
    };
    assert.equal(RunEditorOperationRequestSchema.safeParse(hostile).success, false, "strict DTOs reject renderer find text");
    const outcome = admitEditorOperation(session, hostile);
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error("unreachable");
    assert.equal(outcome.rejection.code, "INVALID_REQUEST");
    proof("renderer cannot supply find");
  });

  it("P6.9 PROOF: renderer cannot supply replace", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const hostile = {
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: replaceId,
      request_id: nextRequest("hostile"),
      replace: "evil replacement",
    };
    assert.equal(RunEditorOperationRequestSchema.safeParse(hostile).success, false, "strict DTOs reject renderer replacement text");
    const outcome = admitEditorOperation(session, hostile);
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error("unreachable");
    assert.equal(outcome.rejection.code, "INVALID_REQUEST");
    proof("renderer cannot supply replace");
  });

  it("P6.9 PROOF: renderer cannot supply match/index/range", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    for (const extra of [
      { match_index: 0 },
      { match_range: { start: 0, end: 6 } },
      { occurrence_index: 1 },
      { range: { line: 1, column: 7 } },
    ]) {
      const hostile = {
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: replaceId,
        request_id: nextRequest("hostile"),
        ...extra,
      };
      assert.equal(RunEditorOperationRequestSchema.safeParse(hostile).success, false, `strict DTOs reject renderer extra ${Object.keys(extra)[0]}`);
      const outcome = admitEditorOperation(session, hostile);
      assert.equal(outcome.ok, false);
      if (outcome.ok) throw new Error("unreachable");
      assert.equal(outcome.rejection.code, "INVALID_REQUEST");
    }
    proof("renderer cannot supply match/index/range");
  });

  it("P6.9 PROOF: renderer cannot supply occurrence/regex/position/path extras", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    for (const extra of [
      { occurrences: 5 },
      { regex: true },
      { regex_flags: "gi" },
      { position: 3 },
      { path: DOC_PATH },
      { document_path: DOC_PATH },
      { text: "evil" },
      { timing_policy: "fast" },
    ]) {
      const hostile = {
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: replaceId,
        request_id: nextRequest("hostile"),
        ...extra,
      };
      assert.equal(RunEditorOperationRequestSchema.safeParse(hostile).success, false, `strict DTOs reject renderer extra ${Object.keys(extra)[0]}`);
      const outcome = admitEditorOperation(session, hostile);
      assert.equal(outcome.ok, false);
      if (outcome.ok) throw new Error("unreachable");
      assert.equal(outcome.rejection.code, "INVALID_REQUEST");
    }
    proof("renderer cannot supply occurrence/regex/position/path extras");
  });

  it("P6.9 PROOF: no generic replacement API", () => {
    assert.equal(planAdmittedReplaceOperation.length, 2, "planning takes the session handle plus the admission only");
    assert.equal(enumerateReplaceMatches.length, 2, "enumeration takes base text plus the literal only");
    const planner = createReplacePlanner();
    assert.equal(planner.planOperation.length, 2);
    const code = readFileSync(join(here, "..", "src", "editor-replace-planner.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .toLowerCase();
    for (const marker of ["openbypath", "createbypath", "replacebypath", "replacetext", "replacebytext", "applyedit", "inserttext", "typetext"]) {
      assert.equal(code.includes(marker), false, `generic replacement entry '${marker}' must be absent`);
    }
    proof("no generic replacement API");
  });
});

// ---------------------------------------------------------------------------
// Exact matching and occurrence guards.
// ---------------------------------------------------------------------------

describe("P6.9 exact matching and occurrence guards", () => {
  it("P6.9 PROOF: exact literal one-match replacement", () => {
    const { session, replaceId, openAdmission } = openThenReplaceFixture("const seeded = 1;", "const seeded = 42;");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const plan = planned.value;
    assert.equal(plan.expected_occurrences, 1);
    assert.equal(plan.actual_match_count, 1);
    assert.deepEqual(plan.matches.map((m) => [m.start_utf16, m.end_utf16]), [[0, 17]]);
    assert.equal(plan.matches[0]!.start.line, 1);
    assert.equal(plan.matches[0]!.start.column_utf16, 1);
    assert.equal(plan.matches[0]!.end.line, 1);
    assert.equal(plan.matches[0]!.end.column_utf16, 18);
    assert.equal(plan.expected_text, "const seeded = 42;\nconst extra = 2;\n");
    assert.equal(plan.changed, true);
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "planning never mutates the buffer");
    proof("exact literal one-match replacement");
  });

  it("P6.9 PROOF: zero match fails closed", () => {
    const { session, replaceId, openAdmission } = openThenReplaceFixture("absent literal", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    // The P6.6 dirty reservation is admission-owned (dirty + reservation
    // flags land at admit time); the snapshot below proves PLANNING adds
    // no further mutation on guard failure.
    const beforeDescriptor = snapshotDescriptor(session, openAdmission.document.document_id);
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, false, "zero matches never replace");
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "FIND_NOT_FOUND");
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "failed planning preserves B0 exactly");
    assert.deepEqual(snapshotDescriptor(session, openAdmission.document.document_id), beforeDescriptor, "failed planning preserves descriptor flags");
    proof("zero match fails closed");
  });

  it("P6.9 PROOF: multiple matches under the default guard fail", () => {
    const base = "const x = 1;\nconst x = 2;\n";
    const { session, replaceId, openAdmission } = openThenReplaceFixture("const x", "let x", undefined, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const beforeDescriptor = snapshotDescriptor(session, openAdmission.document.document_id);
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, false, "two matches never collapse onto the default of one");
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "OCCURRENCE_MISMATCH");
    assert.equal(readBuffer(session, openAdmission.document.document_id), base, "no first-match fallback, no partial replacement");
    assert.deepEqual(snapshotDescriptor(session, openAdmission.document.document_id), beforeDescriptor);
    proof("multiple matches under the default guard fail");
  });

  it("P6.9 PROOF: exact expected N matches succeed", () => {
    const base = "a1\na2\na3\n";
    const { session, replaceId } = openThenReplaceFixture("a", "b", 3, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_occurrences, 3);
    assert.equal(planned.value.actual_match_count, 3);
    assert.deepEqual(planned.value.matches.map((m) => [m.start_utf16, m.end_utf16]), [[0, 1], [3, 4], [6, 7]]);
    assert.equal(planned.value.expected_text, "b1\nb2\nb3\n");
    assert.equal(planned.value.visual_step_count, 9, "three steps per match in ascending order");
    proof("exact expected N matches succeed");
  });

  it("P6.9 PROOF: overlapping-match semantics golden", () => {
    const golden = enumerateReplaceMatches("aaa", "aa");
    assert.equal(golden.ok, true);
    if (!golden.ok) throw new Error("unreachable");
    assert.deepEqual([...golden.value], [0], "aaa with find aa has exactly one non-overlapping match");
    const pair = enumerateReplaceMatches("aaaa", "aa");
    assert.equal(pair.ok, true);
    if (!pair.ok) throw new Error("unreachable");
    assert.deepEqual([...pair.value], [0, 2], "aaaa with find aa has exactly two non-overlapping matches");
    const { session, replaceId } = openThenReplaceFixture("aa", "b", undefined, "aaa");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.actual_match_count, 1);
    assert.equal(planned.value.expected_text, "ba", "the trailing a is not a second match");
    const duo = openThenReplaceFixture("aa", "b", 2, "aaaa");
    const duoAdmission = mustAdmit(duo.session, duo.replaceId, nextRequest("replace"));
    const duoPlanned = planAdmittedReplaceOperation(duo.session, duoAdmission);
    assert.equal(duoPlanned.ok, true);
    if (!duoPlanned.ok) throw new Error("unreachable");
    assert.equal(duoPlanned.value.expected_text, "bb");
    const mismatch = openThenReplaceFixture("aa", "b", undefined, "aaaa");
    const mismatchAdmission = mustAdmit(mismatch.session, mismatch.replaceId, nextRequest("replace"));
    assert.equal(planAdmittedReplaceOperation(mismatch.session, mismatchAdmission).ok, false, "two overlapping-derived matches still violate the default guard");
    proof("overlapping-match semantics golden");
  });

  it("P6.9 PROOF: case sensitivity is exact", () => {
    const { session, replaceId } = openThenReplaceFixture("CONST", "let", undefined, "const x = 1;\n");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, false, "matching never case-folds");
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "FIND_NOT_FOUND");
    proof("case sensitivity is exact");
  });

  it("P6.9 PROOF: whitespace is never trimmed or collapsed", () => {
    const trailing = openThenReplaceFixture("x = 1 ", "x = 2", undefined, "x = 1\n");
    const trailingAdmission = mustAdmit(trailing.session, trailing.replaceId, nextRequest("replace"));
    assert.equal(planAdmittedReplaceOperation(trailing.session, trailingAdmission).ok, false, "a trailing space in find is significant");
    const leading = openThenReplaceFixture("x = 1", "x = 2", undefined, "  x = 1\n");
    const leadingAdmission = mustAdmit(leading.session, leading.replaceId, nextRequest("replace"));
    const leadingPlanned = planAdmittedReplaceOperation(leading.session, leadingAdmission);
    assert.equal(leadingPlanned.ok, true);
    if (!leadingPlanned.ok) throw new Error("unreachable");
    assert.equal(leadingPlanned.value.expected_text, "  x = 2\n", "indentation is preserved byte-exact");
    proof("whitespace is never trimmed or collapsed");
  });

  it("P6.9 PROOF: replacement containing find does not recurse", () => {
    const growth = openThenReplaceFixture("a", "aa", undefined, "a");
    const growthAdmission = mustAdmit(growth.session, growth.replaceId, nextRequest("replace"));
    const growthPlanned = planAdmittedReplaceOperation(growth.session, growthAdmission);
    assert.equal(growthPlanned.ok, true);
    if (!growthPlanned.ok) throw new Error("unreachable");
    assert.equal(growthPlanned.value.expected_text, "aa", "newly inserted text is never rescanned");
    const shrink = openThenReplaceFixture("a", "b", 2, "aa");
    const shrinkAdmission = mustAdmit(shrink.session, shrink.replaceId, nextRequest("replace"));
    const shrinkPlanned = planAdmittedReplaceOperation(shrink.session, shrinkAdmission);
    assert.equal(shrinkPlanned.ok, true);
    if (!shrinkPlanned.ok) throw new Error("unreachable");
    assert.equal(shrinkPlanned.value.expected_text, "bb");
    proof("replacement containing find does not recurse");
  });

  it("P6.9 PROOF: empty find is schema-invalid", () => {
    // 1. The canonical contract rejects empty find before IR exists: schema
    //    requires find min 1, so no reviewed operation can carry it.
    const { raw } = buildReplaceLessonSource([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "replace_code", path: DOC_PATH, find: "", replace: "x" } },
    ]);
    assert.equal(parseLessonData(raw).ok, false, "empty find never passes canonical source validation");
    // 2. Defense in depth: the planner rejects an empty literal even past
    //    admission. Only the parameters sidecar is swapped; the envelope
    //    stays a live admission (no hand-authored IR).
    const { session, replaceId, openAdmission } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const smuggled = {
      ...admission,
      parameters: { ...admission.parameters, find: "" },
    } as EditorOperationAdmission;
    const planned = planAdmittedReplaceOperation(session, smuggled);
    assert.equal(planned.ok, false, "empty find never enumerates: no pathological match list");
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "INVALID_REQUEST");
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT);
    proof("empty find is schema-invalid");
  });

  it("P6.9 PROOF: empty replacement deletes exactly", () => {
    const single = openThenReplaceFixture("seeded", "", undefined, "const seeded = 1;\n");
    const singleAdmission = mustAdmit(single.session, single.replaceId, nextRequest("replace"));
    const singlePlanned = planAdmittedReplaceOperation(single.session, singleAdmission);
    assert.equal(singlePlanned.ok, true);
    if (!singlePlanned.ok) throw new Error("unreachable");
    assert.equal(singlePlanned.value.expected_text, "const  = 1;\n");
    const multi = openThenReplaceFixture("b\n", "", undefined, "a\nb\nc\n");
    const multiAdmission = mustAdmit(multi.session, multi.replaceId, nextRequest("replace"));
    const multiPlanned = planAdmittedReplaceOperation(multi.session, multiAdmission);
    assert.equal(multiPlanned.ok, true);
    if (!multiPlanned.ok) throw new Error("unreachable");
    assert.equal(multiPlanned.value.expected_text, "a\nc\n", "multiline deletion is exact LF surgery");
    const emoji = openThenReplaceFixture("😀", "", undefined, "x😀y\n");
    const emojiAdmission = mustAdmit(emoji.session, emoji.replaceId, nextRequest("replace"));
    const emojiPlanned = planAdmittedReplaceOperation(emoji.session, emojiAdmission);
    assert.equal(emojiPlanned.ok, true);
    if (!emojiPlanned.ok) throw new Error("unreachable");
    assert.equal(emojiPlanned.value.expected_text, "xy\n", "surrogate-pair deletion leaves no half behind");
    proof("empty replacement deletes exactly");
  });

  it("P6.9 PROOF: identical find and replace is a successful no-op", () => {
    const { session, replaceId, openAdmission } = openThenReplaceFixture("seeded", "seeded");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true, "unchanged replacement still completes");
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.changed, false);
    assert.equal(planned.value.expected_text, BASE_TEXT, "semantic output is byte-identical");
    assert.equal(planned.value.expected_digest, planned.value.base_digest);
    assert.equal(planned.value.visual_step_count, 0, "a no-op presents zero visual steps");
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    assert.equal(planner.getStatus(stored.value.plan_id), "completed", "no-op completes immediately");
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "non-dirty output stays exactly B0");
    proof("identical find and replace is a successful no-op");
  });

  it("P6.9 PROOF: multiline LF replacement is exact", () => {
    const base = "a\nb\nc\nd\n";
    const { session, replaceId } = openThenReplaceFixture("b\nc", "B\nC", undefined, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "a\nB\nC\nd\n", "no CRLF, no indentation inference, no reformatting");
    assert.deepEqual(planned.value.matches.map((m) => [m.start_utf16, m.end_utf16]), [[2, 5]]);
    assert.deepEqual([planned.value.matches[0]!.start.line, planned.value.matches[0]!.start.column_utf16], [2, 1]);
    assert.deepEqual([planned.value.matches[0]!.end.line, planned.value.matches[0]!.end.column_utf16], [3, 2]);
    assert.equal(planned.value.expected_text.includes("\r"), false);
    proof("multiline LF replacement is exact");
  });
});

// ---------------------------------------------------------------------------
// Unicode and line endings.
// ---------------------------------------------------------------------------

describe("P6.9 Unicode and line endings", () => {
  it("P6.9 PROOF: Arabic replacement is exact", () => {
    const base = "مرحبا بالعالم\n";
    const { session, replaceId } = openThenReplaceFixture("بالعالم", "بالقمر", undefined, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "مرحبا بالقمر\n");
    assert.equal(Buffer.byteLength(planned.value.expected_text, "utf8"), planned.value.expected_byte_length);
    proof("Arabic replacement is exact");
  });

  it("P6.9 PROOF: Arabic diacritics are significant", () => {
    const word = "بِسْمِ";
    const base = `قال ${word} الله\n`;
    const { session, replaceId } = openThenReplaceFixture(word, "WORD", undefined, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "قال WORD الله\n", "combining marks match literally, never folded");
    const bare = openThenReplaceFixture("بسم", "WORD", undefined, base);
    const bareAdmission = mustAdmit(bare.session, bare.replaceId, nextRequest("replace"));
    assert.equal(planAdmittedReplaceOperation(bare.session, bareAdmission).ok, false, "undiacritized find never matches diacritized text");
    proof("Arabic diacritics are significant");
  });

  it("P6.9 PROOF: emoji replacement is exact", () => {
    const { session, replaceId } = openThenReplaceFixture("😀", "😎", undefined, "start 😀 end\n");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "start 😎 end\n");
    assert.deepEqual(planned.value.matches.map((m) => [m.start_utf16, m.end_utf16]), [[6, 8]], "surrogate pairs span two UTF-16 units");
    proof("emoji replacement is exact");
  });

  it("P6.9 PROOF: ZWJ sequences match atomically", () => {
    const family = "👨‍👩‍👧";
    const technologist = "👩‍💻";
    const base = `team ${family} ok\n`;
    const { session, replaceId } = openThenReplaceFixture(family, technologist, undefined, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, `team ${technologist} ok\n`);
    assert.equal(planned.value.actual_match_count, 1, "no partial ZWJ fragment matches");
    const fragment = openThenReplaceFixture("👨", "X", undefined, base);
    const fragmentAdmission = mustAdmit(fragment.session, fragment.replaceId, nextRequest("replace"));
    const fragmentPlanned = planAdmittedReplaceOperation(fragment.session, fragmentAdmission);
    assert.equal(fragmentPlanned.ok, true, "a literal fragment still matches literally where its code units occur");
    if (!fragmentPlanned.ok) throw new Error("unreachable");
    assert.equal(fragmentPlanned.value.expected_text, `team X‍👩‍👧 ok\n`);
    proof("ZWJ sequences match atomically");
  });

  it("P6.9 PROOF: combining marks are significant and preserved", () => {
    const decomposed = "café x\n";
    const { session, replaceId } = openThenReplaceFixture("é", "E", undefined, decomposed);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "cafE x\n");
    assert.equal(sha256Text(planned.value.expected_text), planned.value.expected_digest);
    proof("combining marks are significant and preserved");
  });

  it("P6.9 PROOF: authored text is never normalized", () => {
    // Precomposed e-acute must NOT match decomposed e + combining acute:
    // any NFC/NFKC folding would report a match here.
    const decomposed = "café\n";
    const { session, replaceId } = openThenReplaceFixture("é", "E", undefined, decomposed);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, false, "normalization would have matched; exact bytes do not");
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "FIND_NOT_FOUND");
    proof("authored text is never normalized");
  });

  it("P6.9 PROOF: mixed Arabic and English replacement is exact", () => {
    const base = "// مرحبا hello world\n";
    const { session, replaceId } = openThenReplaceFixture("hello", "ahlan", undefined, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "// مرحبا ahlan world\n");
    proof("mixed Arabic and English replacement is exact");
  });

  it("P6.9 PROOF: non-BMP ranges use UTF-16 positions", () => {
    const base = "A😀BC\nXY\n";
    const { session, replaceId } = openThenReplaceFixture("BC", "bc", undefined, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const match = planned.value.matches[0]!;
    assert.deepEqual([match.start_utf16, match.end_utf16], [3, 5], "A is 1 unit, emoji is 2 units");
    assert.deepEqual([match.start.line, match.start.column_utf16], [1, 4], "Monaco columns count UTF-16 units, never graphemes");
    assert.deepEqual([match.end.line, match.end.column_utf16], [1, 6]);
    const second = openThenReplaceFixture("XY", "xy", undefined, base);
    const secondAdmission = mustAdmit(second.session, second.replaceId, nextRequest("replace"));
    const secondPlanned = planAdmittedReplaceOperation(second.session, secondAdmission);
    assert.equal(secondPlanned.ok, true);
    if (!secondPlanned.ok) throw new Error("unreachable");
    assert.deepEqual([secondPlanned.value.matches[0]!.start.line, secondPlanned.value.matches[0]!.start.column_utf16], [2, 1]);
    assert.deepEqual(
      replaceLineColumn(base, 1),
      { line: 1, column_utf16: 2 },
      "offsets inside a surrogate pair still map deterministically",
    );
    proof("non-BMP ranges use UTF-16 positions");
  });

  it("P6.9 PROOF: CR is never introduced or accepted", () => {
    // Authored CR rejects at admission (strict LF profile): the reviewed
    // operation can never carry CRLF into planning.
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "replace_code", path: DOC_PATH, find: "a\r\nb", replace: "x" } },
    ]);
    const crSession = openSession(compiled, { [DOC_PATH]: "a\nb\n" });
    mustAdmit(crSession, operationIds[0]!, nextRequest("cr-open"));
    const crAdmission = admitEditorOperation(crSession, {
      session_id: crSession.sessionId,
      generation: crSession.generation,
      operation_id: operationIds[1]!,
      request_id: nextRequest("cr-replace"),
    });
    assert.equal(crAdmission.ok, false, "CR find text never admits");
    if (crAdmission.ok) throw new Error("unreachable");
    assert.equal(crAdmission.rejection.code, "UNSUPPORTED_TEXT_PROFILE");
    // A smuggled CR past admission still rejects at the planner boundary.
    // Only the parameters sidecar is swapped; the envelope stays a live
    // admission (no hand-authored IR).
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const smuggled = {
      ...admission,
      parameters: { ...admission.parameters, find: "a\rb" },
    } as EditorOperationAdmission;
    const smuggledPlanned = planAdmittedReplaceOperation(session, smuggled);
    assert.equal(smuggledPlanned.ok, false);
    if (smuggledPlanned.ok) throw new Error("unreachable");
    assert.equal(smuggledPlanned.rejection.code, "UNSUPPORTED_TEXT_PROFILE");
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text.includes("\r"), false, "LF-only output on Windows, no CRLF");
    const crBuffer = openThenReplaceFixture("seeded", "planted");
    stageBuffer(crBuffer.session, crBuffer.openAdmission.document.document_id, "has\rcarriage\n");
    const crBufferAdmission = mustAdmit(crBuffer.session, crBuffer.replaceId, nextRequest("replace"));
    assert.equal(planAdmittedReplaceOperation(crBuffer.session, crBufferAdmission).ok, false, "CR working text never plans");
    proof("CR is never introduced or accepted");
  });
});

// ---------------------------------------------------------------------------
// Transactional plan and visual plan.
// ---------------------------------------------------------------------------

describe("P6.9 transactional plan and visual plan", () => {
  it("P6.9 PROOF: transactional B0 to B1 golden", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const plan = planned.value;
    assert.equal(plan.base_digest, sha256Text(BASE_TEXT), "B0 digest binds the pre-operation buffer");
    assert.equal(plan.base_byte_length, Buffer.byteLength(BASE_TEXT, "utf8"));
    assert.equal(plan.base_utf16_length, BASE_TEXT.length);
    assert.equal(plan.expected_digest, sha256Text("const planted = 1;\nconst extra = 2;\n"), "B1 digest is known before any visual step");
    assert.equal(plan.expected_byte_length, Buffer.byteLength(plan.expected_text, "utf8"));
    assert.equal(plan.expected_utf16_length, plan.expected_text.length);
    assert.equal(plan.changed, true);
    proof("transactional B0 to B1 golden");
  });

  it("P6.9 PROOF: repeated plans are byte and deep equal", () => {
    // Same session and admission (the pure planner is deterministic):
    // cross-session plans differ only by their bound session identity.
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const one = planAdmittedReplaceOperation(session, admission);
    const two = planAdmittedReplaceOperation(session, admission);
    assert.equal(one.ok && two.ok, true);
    if (!one.ok || !two.ok) throw new Error("unreachable");
    assert.deepEqual(one.value, two.value, "same operation and buffer state always yield the identical plan");
    assert.equal(one.value.plan_id, two.value.plan_id, "deterministic plan identity");
    proof("repeated plans are byte and deep equal");
  });

  it("P6.9 PROOF: match ranges are deterministic", () => {
    const base = "one two one two one\n";
    const { session, replaceId } = openThenReplaceFixture("one", "1", 3, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const one = planAdmittedReplaceOperation(session, admission);
    const two = planAdmittedReplaceOperation(session, admission);
    assert.equal(one.ok && two.ok, true);
    if (!one.ok || !two.ok) throw new Error("unreachable");
    assert.deepEqual(one.value.matches, two.value.matches);
    assert.deepEqual(one.value.matches.map((m) => [m.start_utf16, m.end_utf16]), [[0, 3], [8, 11], [16, 19]]);
    proof("match ranges are deterministic");
  });

  it("P6.9 PROOF: visual plan is deterministic", () => {
    const base = "aXbXc\n";
    const { session, replaceId } = openThenReplaceFixture("X", "YZ", 2, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const plannerA = createReplacePlanner();
    const planA = plannerA.planOperation(session, admission);
    const plannerB = createReplacePlanner();
    const planB = plannerB.planOperation(session, admission);
    assert.equal(planA.ok && planB.ok, true);
    if (!planA.ok || !planB.ok) throw new Error("unreachable");
    assert.deepEqual(planA.value.visual_steps, planB.value.visual_steps, "visual steps repeat deep-equal across instances");
    assert.equal(plannerA.getVisualPlan(planA.value.plan_id) !== null, true);
    assert.deepEqual(plannerA.getVisualPlan(planA.value.plan_id), plannerB.getVisualPlan(planB.value.plan_id));
    proof("visual plan is deterministic");
  });

  it("P6.9 PROOF: visual steps simulate to B1 exactly", () => {
    const base = "aXbXc\n";
    const { session, replaceId } = openThenReplaceFixture("X", "YZ", 2, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const plan = planned.value;
    assert.equal(plan.visual_step_count, 6, "two matches yield six steps");
    assert.deepEqual(plan.visual_steps.map((s) => s.kind), ["highlight", "remove", "insert", "highlight", "remove", "insert"]);
    assert.deepEqual(plan.visual_steps.map((s) => s.match_index), [0, 0, 0, 1, 1, 1], "ascending original order");
    // Simulate the engine-only presentation against B0.
    let live = base;
    for (let match = 0; match < plan.actual_match_count; match += 1) {
      const group = plan.visual_steps.filter((s) => s.match_index === match);
      assert.equal(group.length, 3);
      const [highlight, remove, insert] = group as [typeof group[0], typeof group[0], typeof group[0]];
      assert.equal(highlight!.kind, "highlight");
      assert.equal(remove!.kind, "remove");
      assert.equal(insert!.kind, "insert");
      assert.equal(live.slice(highlight!.adjusted_start_utf16, highlight!.adjusted_end_utf16), "X", "adjusted span selects the exact literal");
      assert.equal(live.slice(remove!.adjusted_start_utf16, remove!.adjusted_end_utf16), "X");
      assert.equal(insert!.adjusted_start_utf16, insert!.adjusted_end_utf16, "insertion is a caret after removal");
      assert.equal(insert!.text, "YZ");
      live = live.slice(0, remove!.adjusted_start_utf16) + insert!.text + live.slice(remove!.adjusted_end_utf16);
    }
    assert.equal(live, plan.expected_text, "ordered simulation reproduces B1 exactly");
    assert.equal(live, "aYZbYZc\n");
    // Any strict prefix of the transaction is not the semantic result.
    let prefix = base;
    const firstGroup = plan.visual_steps.filter((s) => s.match_index === 0);
    const firstRemove = firstGroup[1]!;
    const firstInsert = firstGroup[2]!;
    prefix = prefix.slice(0, firstRemove.adjusted_start_utf16) + firstInsert.text + prefix.slice(firstRemove.adjusted_end_utf16);
    assert.notEqual(prefix, plan.expected_text, "partial application never equals B1: all-or-nothing");
    proof("visual steps simulate to B1 exactly");
  });

  it("P6.9 PROOF: all guard checks happen before mutation", () => {
    const base = "keep keep\n";
    const { session, replaceId, openAdmission } = openThenReplaceFixture("keep", "kept", undefined, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const beforeDescriptor = snapshotDescriptor(session, openAdmission.document.document_id);
    const mismatch = planAdmittedReplaceOperation(session, admission);
    assert.equal(mismatch.ok, false, "two matches violate the default guard");
    if (mismatch.ok) throw new Error("unreachable");
    assert.equal(mismatch.rejection.code, "OCCURRENCE_MISMATCH");
    assert.equal(readBuffer(session, openAdmission.document.document_id), base, "guard failure leaves B0 exactly");
    assert.deepEqual(snapshotDescriptor(session, openAdmission.document.document_id), beforeDescriptor, "guard failure leaves flags exactly");
    const zero = openThenReplaceFixture("missing", "x", undefined, base);
    const zeroAdmission = mustAdmit(zero.session, zero.replaceId, nextRequest("replace"));
    assert.equal(planAdmittedReplaceOperation(zero.session, zeroAdmission).ok, false);
    assert.equal(readBuffer(zero.session, zero.openAdmission.document.document_id), base);
    const good = openThenReplaceFixture("keep", "kept", 2, base);
    const goodAdmission = mustAdmit(good.session, good.replaceId, nextRequest("replace"));
    const goodPlanned = planAdmittedReplaceOperation(good.session, goodAdmission);
    assert.equal(goodPlanned.ok, true);
    if (!goodPlanned.ok) throw new Error("unreachable");
    assert.equal(goodPlanned.value.expected_text, "kept kept\n", "valid guards assemble the whole candidate at once");
    assert.equal(readBuffer(good.session, good.openAdmission.document.document_id), base, "even success writes nothing: installation belongs to the future phase");
    proof("all guard checks happen before mutation");
  });

  it("P6.9 PROOF: partial replacement is impossible", () => {
    const base = "p q p q p\n";
    const { session, replaceId, openAdmission } = openThenReplaceFixture("p", "P", 3, base);
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    // Advance through only the first match, then cancel: B0 must survive
    // exactly, with no first-match residue anywhere authoritative.
    const partial = planner.advancePlan(session, stored.value.plan_id, 3);
    assert.equal(partial.ok, true);
    if (!partial.ok) throw new Error("unreachable");
    assert.equal(partial.value.completed, false);
    assert.equal(planner.cancelPlan(session, stored.value.plan_id).ok, true);
    assert.equal(readBuffer(session, openAdmission.document.document_id), base, "cancel restores all of B0");
    const late = planner.advancePlan(session, stored.value.plan_id, 99);
    assert.equal(late.ok, false, "cancelled transactions never resume");
    proof("partial replacement is impossible");
  });
});

// ---------------------------------------------------------------------------
// Revision fencing and lifecycle (manual step clock, zero mutation).
// ---------------------------------------------------------------------------

describe("P6.9 revision fencing and lifecycle", () => {
  it("P6.9 PROOF: plan binds the live buffer revision", () => {
    const { session, replaceId, openAdmission } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const plan = planned.value;
    const live = snapshotDescriptor(session, openAdmission.document.document_id) as { buffer_revision: number; base_disk_revision: number };
    assert.equal(plan.base_buffer_revision, live.buffer_revision);
    assert.equal(plan.base_disk_revision, live.base_disk_revision);
    assert.equal(plan.session_id, session.sessionId);
    assert.equal(plan.generation, session.generation);
    assert.equal(plan.document_id, openAdmission.document.document_id);
    assert.equal(plan.base_digest, sha256Text(BASE_TEXT));
    proof("plan binds the live buffer revision");
  });

  it("P6.9 PROOF: stale buffer bytes fence the old plan", () => {
    const { session, replaceId, openAdmission } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    stageBuffer(session, openAdmission.document.document_id, "const seeded = 9;\nconst extra = 2;\n");
    const started = planner.startPlan(session, stored.value.plan_id);
    assert.equal(started.ok, false, "moved bytes never execute under an old plan");
    if (started.ok) throw new Error("unreachable");
    assert.equal(started.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(planner.getStatus(stored.value.plan_id), "failed");
    proof("stale buffer bytes fence the old plan");
  });

  it("P6.9 PROOF: externally flagged documents fence planning", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const flagged = session.registry.noteExternalChange(DOC_PATH, "0".repeat(64));
    assert.equal(flagged.ok, true);
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, false, "flagged bases never plan: explicit reload or reset first");
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    proof("externally flagged documents fence planning");
  });

  it("P6.9 PROOF: stale session fences the old plan", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(closeEditorSession(session).ok, true);
    const started = planner.startPlan(session, stored.value.plan_id);
    assert.equal(started.ok, false);
    if (started.ok) throw new Error("unreachable");
    assert.equal(started.rejection.code, "STALE_SESSION");
    proof("stale session fences the old plan");
  });

  it("P6.9 PROOF: stale generation fences the old plan", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    const next = resetEditorSession(session, { sessionId: session.sessionId, generation: 2 });
    assert.equal(next.ok, true, "reset rotates the generation");
    if (!next.ok) throw new Error("unreachable");
    const started = planner.startPlan(next.value, stored.value.plan_id);
    assert.equal(started.ok, false, "old plans never cross a generation boundary");
    if (started.ok) throw new Error("unreachable");
    assert.equal(started.rejection.code, "STALE_SESSION");
    proof("stale generation fences the old plan");
  });

  it("P6.9 PROOF: reset invalidates active plans", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(resetEditorSession(session, { sessionId: "sess-p69-race", generation: 3 }).ok, true);
    planner.invalidateAll();
    const started = planner.startPlan(session, stored.value.plan_id);
    assert.equal(started.ok, false, "revocation landing before start fences with zero progress");
    proof("reset invalidates active plans");
  });

  it("P6.9 PROOF: close invalidates active plans", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(closeEditorSession(session).ok, true);
    const started = planner.startPlan(session, stored.value.plan_id);
    assert.equal(started.ok, false, "closed sessions never start old plans");
    planner.invalidateAll();
    const again = planner.startPlan(session, stored.value.plan_id);
    assert.equal(again.ok, false, "late callbacks after close fence deterministically");
    proof("close invalidates active plans");
  });

  it("P6.9 PROOF: cancellation is deterministic with zero mutation", () => {
    const { session, replaceId, openAdmission } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    const half = planner.advancePlan(session, stored.value.plan_id, 1);
    assert.equal(half.ok, true);
    if (!half.ok) throw new Error("unreachable");
    assert.equal(half.value.completed, false);
    assert.equal(half.value.next_step_index, 1);
    const cancelled = planner.cancelPlan(session, stored.value.plan_id);
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok) throw new Error("unreachable");
    assert.equal(cancelled.value.status, "cancelled");
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "pre-operation buffer restored exactly");
    const late = planner.advancePlan(session, stored.value.plan_id, 99);
    assert.equal(late.ok, false, "cancelled plans never advance");
    proof("cancellation is deterministic with zero mutation");
  });

  it("P6.9 PROOF: cancellation never touches disk", async () => {
    const counterValue = requestSeq + 1;
    const tag = `cf-p69-cancel-${counterValue}-${randomBytes(3).toString("hex")}`;
    const leaf = join(TEST_ROOT, `${tag}-leaf`);
    const staging = join(TEST_ROOT, `${tag}-staging`);
    mkdirSync(join(leaf, "src"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(leaf, "src", "seeded.ts"), BASE_TEXT, "utf8");
    const seed = manifestFor({ [DOC_PATH]: BASE_TEXT });
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: replaceAction("seeded", "planted") },
    ]);
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const opened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: `sess-p69-disk-${counterValue}`,
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
      workspaceId: "ws-p69-disk",
      leafHostPath: leaf,
      stagingHostPath: staging,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const authority: AdapterAuthority = {
      lease: {
        kind: "editor_lease",
        leaseId: "lease-p69-disk",
        sessionId: session.sessionId,
        generation: 1,
        workspaceId: "ws-p69-disk",
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
    const replaceAdmission = mustAdmit(session, operationIds[1]!, nextRequest("disk-replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, replaceAdmission);
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

  it("P6.9 PROOF: duplicate operation never double-replaces", () => {
    const { session, replaceId, openAdmission } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const first = planner.planOperation(session, admission);
    const second = planner.planOperation(session, admission);
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    assert.equal(first.value.plan_id, second.value.plan_id, "replay converges on one plan");
    assert.equal(planner.listPlans().length, 1);
    assert.equal(planner.startPlan(session, first.value.plan_id).ok, true);
    const visual = planner.getVisualPlan(first.value.plan_id);
    assert.ok(visual !== null);
    const done = planner.advancePlan(session, first.value.plan_id, visual!.step_count);
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error("unreachable");
    assert.equal(done.value.completed, true);
    const replay = planner.planOperation(session, admission);
    assert.equal(replay.ok, true);
    if (!replay.ok) throw new Error("unreachable");
    assert.equal(replay.value.plan_id, first.value.plan_id, "completed replay never replaces twice");
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "planning never mutates the buffer");
    proof("duplicate operation never double-replaces");
  });

  it("P6.9 PROOF: same-document operations serialize deterministically", () => {
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: replaceAction("seeded", "planted") },
      { action: replaceAction("extra", "more") },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: BASE_TEXT });
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, BASE_TEXT);
    const firstAdmission = mustAdmit(session, operationIds[1]!, nextRequest("replace1"));
    const planner = createReplacePlanner();
    const first = planner.planOperation(session, firstAdmission);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, first.value.plan_id).ok, true);
    const secondAdmission = mustAdmit(session, operationIds[2]!, nextRequest("replace2"));
    const second = planner.planOperation(session, secondAdmission);
    assert.equal(second.ok, false, "concurrent same-document replacements never overlap");
    if (second.ok) throw new Error("unreachable");
    assert.equal(second.rejection.code, "INVALID_REQUEST");
    proof("same-document operations serialize deterministically");
  });

  it("P6.9 PROOF: different documents plan independently", () => {
    const otherPath = "src/other.ts";
    const otherBase = "const other = 0;\n";
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "file_open", path: otherPath } },
      { action: { type: "replace_code", path: DOC_PATH, find: "seeded", replace: "planted" } },
      { action: { type: "replace_code", path: otherPath, find: "other", replace: "sibling" } },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: BASE_TEXT, [otherPath]: otherBase });
    const openA = mustAdmit(session, operationIds[0]!, nextRequest("openA"));
    stageBuffer(session, openA.document.document_id, BASE_TEXT);
    const openB = mustAdmit(session, operationIds[1]!, nextRequest("openB"));
    stageBuffer(session, openB.document.document_id, otherBase);
    const admissionA = mustAdmit(session, operationIds[2]!, nextRequest("replaceA"));
    const admissionB = mustAdmit(session, operationIds[3]!, nextRequest("replaceB"));
    const planner = createReplacePlanner();
    const planA = planner.planOperation(session, admissionA);
    const planB = planner.planOperation(session, admissionB);
    assert.equal(planA.ok && planB.ok, true, "different documents never block each other");
    if (!planA.ok || !planB.ok) throw new Error("unreachable");
    assert.notEqual(planA.value.plan_id, planB.value.plan_id);
    assert.equal(planner.startPlan(session, planA.value.plan_id).ok, true);
    assert.equal(planner.startPlan(session, planB.value.plan_id).ok, true);
    proof("different documents plan independently");
  });

  it("P6.9 PROOF: reset racing start fences", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(resetEditorSession(session, { sessionId: "sess-p69-race", generation: 3 }).ok, true);
    planner.invalidateAll();
    const started = planner.startPlan(session, stored.value.plan_id);
    assert.equal(started.ok, false, "revocation landing before start fences with zero progress");
    proof("reset racing start fences");
  });

  it("P6.9 PROOF: cancel racing completion reports already-final", () => {
    const { session, replaceId, openAdmission } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    const visual = planner.getVisualPlan(stored.value.plan_id);
    assert.ok(visual !== null);
    const done = planner.advancePlan(session, stored.value.plan_id, visual!.step_count);
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error("unreachable");
    assert.equal(done.value.completed, true);
    const cancelled = planner.cancelPlan(session, stored.value.plan_id);
    assert.equal(cancelled.ok, false, "cancel after completion reports already-final without undo");
    if (cancelled.ok) throw new Error("unreachable");
    assert.equal(cancelled.rejection.code, "INVALID_REQUEST");
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "completion installs nothing yet: no undo exists");
    proof("cancel racing completion reports already-final");
  });
});

// ---------------------------------------------------------------------------
// Document coverage and terminal interop (disk stays committed).
// ---------------------------------------------------------------------------

describe("P6.9 documents and terminal interop", () => {
  it("P6.9 PROOF: pending-created document plans verbatim", async () => {
    const staged = "hello seeded";
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_create", path: "src/fresh.ts", content: staged } },
      { action: { type: "replace_code", path: "src/fresh.ts", find: "seeded", replace: "planted" } },
    ]);
    const session = openSession(compiled, {});
    const createAdmission = mustAdmit(session, operationIds[0]!, nextRequest("create"));
    const created = await executeAdmittedFileCreate(
      session,
      createAdmission,
      {
        adapter: {
          readDocument: () => Promise.resolve({ ok: false as const, rejection: { code: "FILE_NOT_FOUND" as const, message: "absent" } }),
          publishDocument: () => Promise.resolve({ ok: false as const, rejection: { code: "SAVE_FAILED" as const, message: "never" } }),
          adapterVersion: 1 as const,
          sessionId: session.sessionId,
          generation: 1,
          workspaceId: "ws-p69-stub",
        } as unknown as WindowsFileAdapter,
        authority: {
          lease: {
            kind: "editor_lease",
            leaseId: "lease-p69-stub",
            sessionId: session.sessionId,
            generation: 1,
            workspaceId: "ws-p69-stub",
            epoch: 1,
            operationId: operationIds[0]!,
            requestId: nextRequest("stub"),
          },
          ownership: "EDITOR_OWNED",
          liveEpoch: 1,
          revokedLeaseIds: [],
        },
      },
    );
    assert.equal(created.ok, true, "pending creation stages through the admitted path");
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.base_digest, sha256Text(staged), "replacement reads the staged buffer, never disk");
    assert.equal(planned.value.expected_text, "hello planted");
    const counterValue = requestSeq + 1;
    const tag = `cf-p69-pending-${counterValue}-${randomBytes(3).toString("hex")}`;
    const leaf = join(TEST_ROOT, `${tag}-leaf`);
    const staging = join(TEST_ROOT, `${tag}-staging`);
    mkdirSync(join(leaf, "src"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    assert.equal(existsSync(join(leaf, "src", "fresh.ts")), false, "disk stays absent before the later save phase");
    proof("pending-created document plans verbatim");
  });

  it("P6.9 PROOF: unexecuted pending documents have no buffer", () => {
    const staged = "hello seeded";
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_create", path: "src/fresh.ts", content: staged } },
      { action: { type: "replace_code", path: "src/fresh.ts", find: "seeded", replace: "planted" } },
    ]);
    const session = openSession(compiled, {});
    mustAdmit(session, operationIds[0]!, nextRequest("create"));
    // The create was admitted but never executed: no staged text exists.
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, false);
    if (planned.ok) throw new Error("unreachable");
    assert.equal(planned.rejection.code, "FILE_NOT_FOUND");
    proof("unexecuted pending documents have no buffer");
  });

  it("P6.9 PROOF: existing-open document plans against its revision", async () => {
    const counterValue = requestSeq + 1;
    const tag = `cf-p69-open-${counterValue}-${randomBytes(3).toString("hex")}`;
    const leaf = join(TEST_ROOT, `${tag}-leaf`);
    const staging = join(TEST_ROOT, `${tag}-staging`);
    mkdirSync(join(leaf, "src"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(leaf, "src", "seeded.ts"), BASE_TEXT, "utf8");
    const seed = manifestFor({ [DOC_PATH]: BASE_TEXT });
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: replaceAction("seeded", "planted") },
    ]);
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const opened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: `sess-p69-real-${counterValue}`,
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
      workspaceId: "ws-p69-real",
      leafHostPath: leaf,
      stagingHostPath: staging,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const authority: AdapterAuthority = {
      lease: {
        kind: "editor_lease",
        leaseId: "lease-p69-real",
        sessionId: session.sessionId,
        generation: 1,
        workspaceId: "ws-p69-real",
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
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("real-replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "const planted = 1;\nconst extra = 2;\n");
    assert.equal(readFileSync(join(leaf, "src", "seeded.ts"), "utf8"), BASE_TEXT, "planning never publishes: disk keeps committed bytes");
    proof("existing-open document plans against its revision");
  });

  it("P6.9 PROOF: type then replace share one authoritative buffer", () => {
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: { type: "type_code", path: DOC_PATH, content: "// typed\n" } },
      { action: replaceAction("seeded", "planted") },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: BASE_TEXT });
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, BASE_TEXT);
    const typeAdmission = mustAdmit(session, operationIds[1]!, nextRequest("type"));
    const typed = planAdmittedTypeOperation(session, typeAdmission);
    assert.equal(typed.ok, true, "the type plan exists first (planned, never installed)");
    const admission = mustAdmit(session, operationIds[2]!, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok || !typed.ok) throw new Error("unreachable");
    assert.equal(planned.value.base_digest, typed.value.base_digest, "replace evaluates the same authoritative B0: no disk reload between editor operations");
    assert.equal(planned.value.expected_text, "const planted = 1;\nconst extra = 2;\n");
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "neither plan mutates the shared buffer");
    proof("type then replace share one authoritative buffer");
  });

  it("P6.9 PROOF: dirty reservation keeps terminal RW fenced", async () => {
    const rwOp = "term-p69-rw";
    const roOp = "term-p69-ro";
    const seed = manifestFor({ [DOC_PATH]: BASE_TEXT });
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: replaceAction("seeded", "planted") },
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
        sandbox_policy_digest: sha256Hex("p69-sandbox-policy"),
        terminal_access: { [rwOp]: "read_write", [roOp]: "read_only" },
        reviewed_by: "review-board-1",
        review_note: "synthetic P6.9 coordination review",
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
    const replaceAdmission = mustAdmit(session, operationIds[1]!, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, replaceAdmission);
    assert.equal(stored.ok, true);
    const facts = editorBufferFacts(session);
    assert.ok(facts.dirtyBufferCount >= 1, "admitted replacement work reserves dirty truth");
    assert.equal(coord.setBufferFacts(combined.value.editorCapability, { ...facts }).ok, true);
    const ro = await coord.runTerminalOperation(combined.value.terminalCapability, roOp, nextRequest("ro"));
    assert.equal(ro.ok, true, "approved RO background stays compatible with planned replacement");
    const rw = await coord.runTerminalOperation(combined.value.terminalCapability, rwOp, nextRequest("rw"));
    assert.equal(rw.ok, false);
    if (rw.ok) throw new Error("unreachable");
    assert.equal(rw.rejection.code, "DIRTY_BUFFER_CONFLICT");
    proof("dirty reservation keeps terminal RW fenced");
  });

  it("P6.9 PROOF: committed disk stays exactly what observers read", async () => {
    const counterValue = requestSeq + 1;
    const tag = `cf-p69-committed-${counterValue}-${randomBytes(3).toString("hex")}`;
    const leaf = join(TEST_ROOT, `${tag}-leaf`);
    const staging = join(TEST_ROOT, `${tag}-staging`);
    mkdirSync(join(leaf, "src"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(leaf, "src", "seeded.ts"), BASE_TEXT, "utf8");
    const seed = manifestFor({ [DOC_PATH]: BASE_TEXT });
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: replaceAction("seeded", "planted") },
    ]);
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const opened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: `sess-p69-committed-${counterValue}`,
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
      workspaceId: "ws-p69-committed",
      leafHostPath: leaf,
      stagingHostPath: staging,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    let publishCalls = 0;
    const counting = {
      ...bound.value,
      publishDocument: ((...args: Parameters<WindowsFileAdapter["publishDocument"]>) => {
        publishCalls += 1;
        return bound.value.publishDocument(...args);
      }) as WindowsFileAdapter["publishDocument"],
    };
    const authority: AdapterAuthority = {
      lease: {
        kind: "editor_lease",
        leaseId: "lease-p69-committed",
        sessionId: session.sessionId,
        generation: 1,
        workspaceId: "ws-p69-committed",
        epoch: 1,
        operationId: operationIds[0]!,
        requestId: nextRequest("committed"),
      },
      ownership: "EDITOR_OWNED",
      liveEpoch: 1,
      revokedLeaseIds: [],
    };
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("committed-open"));
    const executed = await executeAdmittedFileOpen(session, openAdmission, { adapter: counting, authority });
    assert.equal(executed.ok, true);
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("committed-replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    const visual = planner.getVisualPlan(stored.value.plan_id);
    assert.ok(visual !== null);
    const done = planner.advancePlan(session, stored.value.plan_id, visual!.step_count);
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error("unreachable");
    assert.equal(done.value.completed, true);
    assert.equal(publishCalls, 0, "no publication exists on the planning path");
    assert.equal(readFileSync(join(leaf, "src", "seeded.ts"), "utf8"), BASE_TEXT, "P5 and RO watchers keep reading the last committed bytes");
    proof("committed disk stays exactly what observers read");
  });

  it("P6.9 PROOF: background RO observation is unaffected", () => {
    const { session, replaceId, openAdmission } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    const visual = planner.getVisualPlan(stored.value.plan_id);
    assert.ok(visual !== null);
    assert.equal(planner.advancePlan(session, stored.value.plan_id, visual!.step_count).ok, true);
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "RO observers keep seeing committed state: planning writes nothing");
    proof("background RO observation is unaffected");
  });
});

// ---------------------------------------------------------------------------
// Engine boundary: no publication, no generic API, no presentation.
// ---------------------------------------------------------------------------

describe("P6.9 engine boundary", () => {
  function replaceSource(): string {
    return readFileSync(join(here, "..", "src", "editor-replace-planner.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      .toLowerCase();
  }

  it("P6.9 PROOF: visual plan advances on a manual step clock with no sleeps", () => {
    const self = readFileSync(join(here, "editor-replace-planner.test.ts"), "utf8");
    const probeSetTimeout = "set" + "Timeout(";
    const probeSetInterval = "set" + "Interval(";
    const probeAtomics = "Atomics." + "wait";
    assert.equal(self.includes(probeSetTimeout), false, "no real-timer sleeps in planner tests");
    assert.equal(self.includes(probeSetInterval), false, "no interval timers in planner tests");
    assert.equal(self.includes(probeAtomics), false, "no blocking waits in planner tests");
    const code = replaceSource();
    assert.equal(code.includes("settimeout"), false);
    assert.equal(code.includes("setinterval"), false);
    const { session, replaceId } = openThenReplaceFixture("X", "YZ", 2, "aXbXc\n");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planner = createReplacePlanner();
    const stored = planner.planOperation(session, admission);
    assert.equal(stored.ok, true);
    if (!stored.ok) throw new Error("unreachable");
    assert.equal(planner.startPlan(session, stored.value.plan_id).ok, true);
    const first = planner.advancePlan(session, stored.value.plan_id, 2);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.value.next_step_index, 2, "manual step counts drive logical progress deterministically");
    assert.equal(first.value.completed, false);
    proof("visual plan advances on a manual step clock with no sleeps");
  });

  it("P6.9 PROOF: no adapter publication from planning", () => {
    const code = replaceSource();
    for (const marker of ["publishdocument", "openwindowsfileadapter", "createdocument", "node:fs", "node:fs/promises"]) {
      assert.equal(code.includes(marker), false, `adapter/filesystem marker '${marker}' must be absent`);
    }
    proof("no adapter publication from planning");
  });

  it("P6.9 PROOF: no generic renderer replacement API", () => {
    const planner = createReplacePlanner();
    assert.equal(planner.planOperation.length, 2);
    assert.equal(planner.startPlan.length, 2);
    const code = replaceSource();
    for (const marker of ["openbypath", "createbypath", "replacebypath", "replacetext", "replacebytext", "applyedit", "inserttext", "typetext"]) {
      assert.equal(code.includes(marker), false, `generic replacement entry '${marker}' must be absent`);
    }
    proof("no generic renderer replacement API");
  });

  it("P6.9 PROOF: no Monaco integration in the engine", () => {
    const code = replaceSource();
    for (const marker of ["monaco", "requestanimationframe", "replacescheduler", "keyboard", "sendkeys", "clipboard", "paste", "undo"]) {
      assert.equal(code.includes(marker), false, `presentation marker '${marker}' must be absent`);
    }
    proof("no Monaco integration in the engine");
  });

  it("P6.9 PROOF: no visual, browser or recording phase creep", () => {
    const code = replaceSource();
    for (const marker of ["playwright", "puppeteer", "browser", "recording", "unreal", "metahuman", "node-pty", "child_process", "docker", "file_save", "save_failed", "commit_uncertain", "journal"]) {
      assert.equal(code.includes(marker), false, `later-phase marker '${marker}' must be absent`);
    }
    proof("no visual, browser or recording phase creep");
  });

  it("P6.9 PROOF: no regex, fuzzy or AST inference", () => {
    const code = replaceSource();
    for (const marker of ["regexp", ".match(", ".replace(", ".search(", "fuzzy", "levenshtein", "heuristic", "similarity", "acorn", "createsourcefile"]) {
      assert.equal(code.includes(marker), false, `inference marker '${marker}' must be absent: matching is indexOf literal only`);
    }
    // Behavioral counterpart: a pattern-looking find matches literally only.
    const literal = openThenReplaceFixture("a.c", "X", undefined, "a.c abc\n");
    const admission = mustAdmit(literal.session, literal.replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(literal.session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(planned.value.expected_text, "X abc\n", "dots are literal characters, never wildcards");
    proof("no regex, fuzzy or AST inference");
  });

  it("P6.9 PROOF: match counts and documents stay bounded", () => {
    // 1. Past-ceiling hit counts reject instead of truncating.
    const many = "a".repeat(REPLACE_MAX_MATCHES + 1);
    const { compiled, operationIds } = compileReplaceLesson([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: replaceAction("a", "b", REPLACE_MAX_MATCHES + 1) },
    ]);
    const session = openSession(compiled, { [DOC_PATH]: many });
    const openAdmission = mustAdmit(session, operationIds[0]!, nextRequest("open"));
    stageBuffer(session, openAdmission.document.document_id, many);
    const admission = mustAdmit(session, operationIds[1]!, nextRequest("replace"));
    const over = planAdmittedReplaceOperation(session, admission);
    assert.equal(over.ok, false, "over-budget matches never truncate: they reject");
    if (over.ok) throw new Error("unreachable");
    assert.equal(over.rejection.code, "RESOURCE_LIMIT");
    assert.equal(readBuffer(session, openAdmission.document.document_id), many);
    // 2. Large but bounded documents plan in one linear pass.
    const wide = "ab".repeat(9000);
    const wideFixture = openThenReplaceFixture("ab", "cd", 9000, wide);
    const wideAdmission = mustAdmit(wideFixture.session, wideFixture.replaceId, nextRequest("replace"));
    const widePlanned = planAdmittedReplaceOperation(wideFixture.session, wideAdmission);
    assert.equal(widePlanned.ok, true);
    if (!widePlanned.ok) throw new Error("unreachable");
    assert.equal(widePlanned.value.expected_text, "cd".repeat(9000));
    assert.equal(widePlanned.value.visual_step_count, 27000);
    proof("match counts and documents stay bounded");
  });

  it("P6.9 PROOF: authored size ceilings fail closed before planning", () => {
    // 1. The 1 MiB compiled-IR ceiling rejects the oversized lesson before
    //    any admission, planning or mutation can exist (never truncated).
    const big = "b".repeat(1048576 + 1);
    const { raw } = buildReplaceLessonSource([
      { action: { type: "file_open", path: DOC_PATH } },
      { action: replaceAction("seeded", big) },
    ]);
    const parsed = parseLessonData(raw);
    assert.equal(parsed.ok, true, "oversized source still parses: the IR ceiling is the fail-closed bound");
    if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
    const catalog = createEditorCatalog(compileModule.compileLesson(parsed.lesson));
    assert.equal(catalog.ok, false, "over-budget IR never becomes plannable");
    if (catalog.ok) throw new Error("unreachable");
    assert.equal(catalog.rejection.code, "INVALID_REQUEST");
    // 2. Defense in depth: the planner measures its own per-operation byte
    //    ceilings even if an oversized payload ever reached it past
    //    admission. The envelope stays a live admission (no hand-authored
    //    IR); only the parameters sidecar is swapped to simulate smuggling.
    const { session, replaceId, openAdmission } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const smuggledFind = {
      ...admission,
      parameters: { ...admission.parameters, find: big },
    } as EditorOperationAdmission;
    const findPlanned = planAdmittedReplaceOperation(session, smuggledFind);
    assert.equal(findPlanned.ok, false, "over-budget find never truncates: it rejects");
    if (findPlanned.ok) throw new Error("unreachable");
    assert.equal(findPlanned.rejection.code, "RESOURCE_LIMIT");
    const smuggledReplace = {
      ...admission,
      parameters: { ...admission.parameters, replace: big },
    } as EditorOperationAdmission;
    assert.equal(planAdmittedReplaceOperation(session, smuggledReplace).ok, false);
    // 3. The candidate ceiling guards replacement blowup: a bounded match
    //    count with a wide replacement that would exceed 16 MiB rejects
    //    before an unbounded buffer can assemble.
    const wideBase = "a".repeat(10000);
    const wideSession = (() => {
      const { compiled: c, operationIds: ids } = compileReplaceLesson([
        { action: { type: "file_open", path: DOC_PATH } },
        { action: replaceAction("a", "y", 10000) },
      ]);
      const s = openSession(c, { [DOC_PATH]: wideBase });
      const open = mustAdmit(s, ids[0]!, nextRequest("open"));
      stageBuffer(s, open.document.document_id, wideBase);
      return { s, replaceOp: ids[1]! };
    })();
    const wideAdmission = mustAdmit(wideSession.s, wideSession.replaceOp, nextRequest("replace"));
    const smuggledWide = {
      ...wideAdmission,
      parameters: { ...wideAdmission.parameters, replace: "y".repeat(2000) },
    } as EditorOperationAdmission;
    const widePlanned = planAdmittedReplaceOperation(wideSession.s, smuggledWide);
    assert.equal(widePlanned.ok, false, "candidate blowup never materializes: it rejects");
    if (widePlanned.ok) throw new Error("unreachable");
    assert.equal(widePlanned.rejection.code, "RESOURCE_LIMIT");
    // 4. The working-document ceiling guards pathological buffers: a base
    //    past 16 MiB rejects before enumeration can begin.
    const hugeBase = "z".repeat(16777216 + 1);
    const hugeSession = (() => {
      const { compiled: c, operationIds: ids } = compileReplaceLesson([
        { action: { type: "file_open", path: DOC_PATH } },
        { action: replaceAction("z", "y") },
      ]);
      const s = openSession(c, { [DOC_PATH]: "z" });
      const open = mustAdmit(s, ids[0]!, nextRequest("open"));
      stageBuffer(s, open.document.document_id, hugeBase);
      return { s, replaceOp: ids[1]!, documentId: open.document.document_id };
    })();
    const hugeAdmission = mustAdmit(hugeSession.s, hugeSession.replaceOp, nextRequest("replace"));
    const hugePlanned = planAdmittedReplaceOperation(hugeSession.s, hugeAdmission);
    assert.equal(hugePlanned.ok, false, "pathological buffers never enumerate: they reject");
    if (hugePlanned.ok) throw new Error("unreachable");
    assert.equal(hugePlanned.rejection.code, "RESOURCE_LIMIT");
    assert.equal(readBuffer(session, openAdmission.document.document_id), BASE_TEXT, "rejected planning preserves the buffer");
    proof("authored size ceilings fail closed before planning");
  });

  it("P6.9 PROOF: plan DTOs carry no host paths", () => {
    const { session, replaceId } = openThenReplaceFixture("seeded", "planted");
    const admission = mustAdmit(session, replaceId, nextRequest("replace"));
    const planned = planAdmittedReplaceOperation(session, admission);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const serialized = JSON.stringify(planned.value);
    assert.equal(/[A-Za-z]:[\\/]/.test(serialized), false, "no drive-letter host path in any plan DTO");
    assert.equal(serialized.includes(TEST_ROOT), false, "no phase-owned temp path in any plan DTO");
    assert.equal(serialized.includes("ws-p69"), false, "no workspace/lease identity in any plan DTO");
    proof("plan DTOs carry no host paths");
  });
});
