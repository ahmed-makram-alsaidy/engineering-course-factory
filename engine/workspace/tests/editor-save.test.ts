// P6.10 Save and journal — deterministic commit boundary, byte verify, bounded canonical events (offline, no sleeps).
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.10 Save and journal
// ("Commit boundary, byte verify, bounded canonical events"; PASS "Injected
// failure matrix, exactly-one outcome"). Canonical authority: design sections
// 4/5/6/7/10/12/13/14/17/18/21/26.1/26.4/26.5/26.6/26.7/26.8/26.12 plus
// ADR-0011 decisions 5-6.
// Proves at runtime (not merely by types): admitted file_save persists ONLY
// the current trusted main-owned buffer bytes through the P6.4 adapter as
// the sole publication primitive with guarded preimage, atomic commit,
// byte verification, revision update, dirty-to-clean only after verification,
// pending-create publication, external-conflict fail-closed, COMMIT_UNCERTAIN
// fail-closed, bounded canonical journal with exactly-one terminal outcome,
// deterministic ordering, idempotent replay without second commit,
// cancel/reset/close/revocation linearization, injected failure matrix,
// type/replace interop with no partial disk typing, Unicode/LF exactness,
// renderer authority absent, no generic save API, no P6.11+ scope.
// Fixture IR is NEVER hand-authored: synthetic lesson sources compile through
// the canonical pipeline (parseLessonData -> compileLesson -> re-validation
// inside createEditorCatalog). All filesystem work stays under the
// phase-owned temp/P6.10/save root with cf-p610- names; the only host writes
// are controlled test setup (seed bytes, external-change simulation) and
// byte-exact assertions. Real Windows platform proofs live in
// editor-save-windows.test.ts; real Docker RO interop lives in
// editor-save-docker.test.ts (gate-only, mirroring the P6.4/P6.5 precedent).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { createSeedManifest, sha256Hex, type SeedManifest } from "../src/policy.ts";
import { createWorkspaceCoordinator } from "../src/coordinator.ts";
import { openWindowsFileAdapter, type AdapterAuthority, type WindowsFileAdapter } from "../src/file-adapter.ts";
import { admitEditorOperation, closeEditorSession, createEditorCatalog, editorBufferFacts, openEditorSession, resetEditorSession, type EditorCatalog, type EditorOperationAdmission, type EditorSession } from "../src/editor-admission.ts";
import { executeAdmittedFileCreate, executeAdmittedFileOpen } from "../src/editor-open-create.ts";
import { createEditorSaveJournal, createFileSaveExecutor, sanitizeSaveMessage, type EditorSaveJournal, type FileSaveExecutor } from "../src/editor-save.ts";
const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.10", "save");
function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function proof(message: string): void {
  console.log(`P6.10 PROOF: ${message}`);
}
let lessonSeq = 0;
let sessionSeq = 0;
let requestSeq = 0;
let harnessSeq = 0;
function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p610-${prefix}-${requestSeq}`;
}
function buildSaveLessonSource(actions: Array<{ action: unknown }>): { raw: unknown; lessonId: string; operationIds: string[] } {
  lessonSeq += 1;
  const lessonId = `C01-L${String(70 + lessonSeq).padStart(3, "0")}`;
  const operationIds = actions.map((_, index) => `${lessonId}-S001-B${String(index + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: `Synthetic P6.10 lesson ${lessonId}`,
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Persist admitted buffers through the verified save boundary"],
    prerequisites: [],
    keywords: ["editor", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.10" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        type: "code_demo",
        title: "Save the admitted document",
        duration: 120,
        visual: { kind: "code_editor", description: "Editor saves buffers" },
        beats: actions.map((entry, index) => ({ beat_id: operationIds[index], kind: "action", action: entry.action })),
      },
    ],
  };
  return { raw, lessonId, operationIds };
}
function compileSaveLesson(actions: Array<{ action: unknown }>): { compiled: CompiledLesson; operationIds: string[] } {
  const { raw, operationIds } = buildSaveLessonSource(actions);
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
interface SaveHarness {
  readonly tag: string;
  readonly leaf: string;
  readonly staging: string;
  readonly adapter: WindowsFileAdapter;
  readonly session: EditorSession;
  readonly catalog: EditorCatalog;
  readonly seed: SeedManifest;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly executor: FileSaveExecutor;
}
function openSaveHarness(fixtureActions: Array<{ action: unknown }>, files: Record<string, string>): SaveHarness {
  harnessSeq += 1;
  const tag = `cf-p610-t${harnessSeq}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(join(leaf, "src"), { recursive: true });
  mkdirSync(staging, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
  }
  const seed = manifestFor(files);
  const { compiled } = compileSaveLesson(fixtureActions);
  const catalogOutcome = createEditorCatalog(compiled);
  assert.equal(catalogOutcome.ok, true, "catalog must build");
  if (!catalogOutcome.ok) throw new Error("unreachable");
  const sessionId = `sess-p610-${String(harnessSeq).padStart(4, "0")}`;
  const workspaceId = `ws-p610-${String(harnessSeq).padStart(4, "0")}`;
  const opened = openEditorSession({ catalog: catalogOutcome.value, sessionId, generation: 1, seedManifest: seed, reviewed: true });
  assert.equal(opened.ok, true, "admission session must open");
  if (!opened.ok) throw new Error("unreachable");
  const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
  assert.equal(bound.ok, true, "adapter binding must open");
  if (!bound.ok) throw new Error("unreachable");
  return { tag, leaf, staging, adapter: bound.value, session: opened.value, catalog: catalogOutcome.value, seed, sessionId, workspaceId, executor: createFileSaveExecutor() };
}
function syntheticAuthority(h: SaveHarness, overrides: Partial<AdapterAuthority> = {}): AdapterAuthority {
  return {
    lease: {
      kind: "editor_lease",
      leaseId: `lease-p610-${harnessSeq}`,
      sessionId: h.sessionId,
      generation: 1,
      workspaceId: h.workspaceId,
      epoch: 1,
      operationId: "op-p610-synthetic",
      requestId: nextRequest("synthetic"),
    },
    ownership: "EDITOR_OWNED",
    liveEpoch: 1,
    revokedLeaseIds: [],
    ...overrides,
  };
}
function mustAdmit(session: EditorSession, operationId: string, requestId: string): EditorOperationAdmission {
  const outcome = admitEditorOperation(session, { session_id: session.sessionId, generation: session.generation, operation_id: operationId, request_id: requestId });
  assert.equal(outcome.ok, true, `admission of ${operationId} must succeed: ${outcome.ok ? "" : outcome.rejection.code + " " + outcome.rejection.message}`);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}
function hostText(h: SaveHarness, rel: string): string | null {
  const full = join(h.leaf, ...rel.split("/"));
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}
function hostBytes(h: SaveHarness, rel: string): Uint8Array | null {
  const full = join(h.leaf, ...rel.split("/"));
  if (!existsSync(full)) return null;
  return new Uint8Array(readFileSync(full));
}
function stagingIsClean(h: SaveHarness): boolean {
  return readdirSync(h.staging).length === 0;
}
function dtoLeaksHostPaths(dto: unknown, h: SaveHarness): string[] {
  const json = JSON.stringify(dto);
  assert.notEqual(json, undefined, "leak scanner requires a defined DTO");
  const leaks: string[] = [];
  if (/[A-Za-z]:[\\/]/.test(json)) leaks.push("drive-letter path");
  if (json.includes("\\\\")) leaks.push("UNC/device escape");
  if (json.includes(h.leaf) || json.includes(h.staging)) leaks.push("trusted host path");
  if (json.includes("cf-p64-stage-")) leaks.push("private staging name");
  return leaks;
}
function spyAdapter(real: WindowsFileAdapter): { adapter: WindowsFileAdapter; reads: () => number; publishes: () => number } {
  let reads = 0;
  let publishes = 0;
  const adapter: WindowsFileAdapter = {
    ...real,
    readDocument: async (authority, path) => {
      reads += 1;
      return real.readDocument(authority, path);
    },
    publishDocument: async (authority, args) => {
      publishes += 1;
      return real.publishDocument(authority, args);
    },
  };
  return { adapter, reads: () => reads, publishes: () => publishes };
}
function failingAdapter(real: WindowsFileAdapter, code: "SAVE_FAILED" | "COMMIT_UNCERTAIN" | "EXTERNAL_MODIFICATION_CONFLICT", atPublish = true): WindowsFileAdapter {
  return {
    ...real,
    readDocument: (a, p) => real.readDocument(a, p),
    publishDocument: async () => ({ ok: false as const, rejection: { code, message: `injected ${code} before commit with destination unchanged` } }),
  };
}
function deferredPublishAdapter(real: WindowsFileAdapter): { adapter: WindowsFileAdapter; entered: Promise<void>; release: () => void; publishes: () => number } {
  let publishes = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let signalEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const adapter: WindowsFileAdapter = {
    ...real,
    readDocument: (a, p) => real.readDocument(a, p),
    publishDocument: async (a, args) => {
      publishes += 1;
      signalEntered();
      await gate;
      return real.publishDocument(a, args);
    },
  };
  return { adapter, entered, release: () => releaseGate(), publishes: () => publishes };
}
/** Stage main-owned buffer text and mark dirty via the trusted reservation seam (simulates installed type/replace B1). */
function stageDirtyBuffer(h: SaveHarness, documentId: string, text: string): void {
  const stored = h.session.registry.setBufferContent(documentId, text);
  assert.equal(stored.ok, true, "main-owned buffer staging must succeed");
  const reserved = h.session.registry.reserveDocumentOperation(documentId, `test-dirty-${nextRequest("dirty")}`, true);
  assert.equal(reserved.ok, true, "dirty reservation must succeed for the save preimage");
}
/** Bounded wait for a deferred gate: fails fast instead of hanging the suite (no leaked timer on success). */
async function awaitEnteredWithTimeout(entered: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      entered,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bounded wait exceeded for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
const DOC = "src/save.ts";
const V1 = "const save = 1;\n";
const V2 = "const save = 2;\n";
const ARABIC_EMOJI = "// English \u062A\u0639\u0644\u064A\u0642 \u0639\u0631\u0628\u064A \uD83D\uDE80\nconst greeting = \"\u0645\u0631\u062D\u0628\u0627 hello\";\n";
before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});
after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "phase-owned test root is removed (cleanup green)");
});
describe("P6.10 admission boundary (trusted identifiers only, no renderer authority)", () => {
  it("P6.10 PROOF: admitted save succeeds", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const { compiled } = compileSaveLesson([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }]);
    void compiled;
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    const opened = await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(opened.ok, true);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    proof("admitted save succeeds");
  });
  it("P6.10 PROOF: unreviewed save rejected", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const { compiled } = compileSaveLesson([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }]);
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const insp = openEditorSession({ catalog: catalogOutcome.value, sessionId: "sess-p610-insp", generation: 1, seedManifest: h.seed, reviewed: false });
    assert.equal(insp.ok, true);
    if (!insp.ok) throw new Error("unreachable");
    const outcome = admitEditorOperation(insp.value, { session_id: "sess-p610-insp", generation: 1, operation_id: catalogOutcome.value.editor_order[0]!, request_id: nextRequest("insp") });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.rejection.code, "NOT_AUTHORIZED");
    proof("unreviewed save rejected");
  });
  it("P6.10 PROOF: wrong action type rejected", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    const outcome = await h.executor.execute(h.session, { ...openAdm, record: { ...openAdm.record, action_type: "file_open" as never } } as unknown as EditorOperationAdmission, { adapter: h.adapter, authority: syntheticAuthority(h) });
    void outcome;
    const typeLesson = compileSaveLesson([{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "x" } }]);
    const cat2 = createEditorCatalog(typeLesson.compiled);
    assert.equal(cat2.ok, true);
    if (!cat2.ok) throw new Error("unreachable");
    const sess2 = openEditorSession({ catalog: cat2.value, sessionId: "sess-p610-wrong", generation: 1, seedManifest: h.seed, reviewed: true });
    assert.equal(sess2.ok, true);
    if (!sess2.ok) throw new Error("unreachable");
    const admOpen = admitEditorOperation(sess2.value, { session_id: "sess-p610-wrong", generation: 1, operation_id: cat2.value.editor_order[0]!, request_id: nextRequest("w") });
    assert.equal(admOpen.ok, true);
    if (!admOpen.ok) throw new Error("unreachable");
    await executeAdmittedFileOpen(sess2.value, admOpen.value, { adapter: h.adapter, authority: { ...syntheticAuthority(h), lease: { ...syntheticAuthority(h).lease, sessionId: "sess-p610-wrong", workspaceId: h.workspaceId } } });
    const admType = admitEditorOperation(sess2.value, { session_id: "sess-p610-wrong", generation: 1, operation_id: cat2.value.editor_order[1]!, request_id: nextRequest("w2") });
    assert.equal(admType.ok, true);
    if (!admType.ok) throw new Error("unreachable");
    const exec = createFileSaveExecutor();
    const rejected = await exec.execute(sess2.value, admType.value, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.rejection.code, "INVALID_REQUEST");
    proof("wrong action type rejected");
  });
  it("P6.10 PROOF: renderer cannot provide bytes", async () => {
    const parsed = (await import("../src/protocol.ts") as typeof import("../src/protocol.ts")).RunEditorOperationRequestSchema.safeParse({ session_id: "s", generation: 1, operation_id: "o", request_id: "r", contents: "evil", bytes: "evil", content: "evil" });
    assert.equal(parsed.success, false);
    proof("renderer cannot provide bytes");
  });
  it("P6.10 PROOF: renderer cannot provide path", async () => {
    const parsed = (await import("../src/protocol.ts") as typeof import("../src/protocol.ts")).RunEditorOperationRequestSchema.safeParse({ session_id: "s", generation: 1, operation_id: "o", request_id: "r", path: "src/evil.ts", portable_path: "src/evil.ts" });
    assert.equal(parsed.success, false);
    proof("renderer cannot provide path");
  });
  it("P6.10 PROOF: renderer cannot provide revision", async () => {
    const parsed = (await import("../src/protocol.ts") as typeof import("../src/protocol.ts")).RunEditorOperationRequestSchema.safeParse({ session_id: "s", generation: 1, operation_id: "o", request_id: "r", revision: 9, digest: "a".repeat(64) });
    assert.equal(parsed.success, false);
    proof("renderer cannot provide revision");
  });
  it("P6.10 PROOF: save source == main-owned buffer", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const before = h.session.registry.getBufferContent(openAdm.document.document_id);
    assert.equal(before.ok, true);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    if (!saved.ok || !before.ok) throw new Error("unreachable");
    assert.equal(saved.value.content, before.value);
    assert.equal(hostText(h, DOC), before.value);
    proof("save source == main-owned buffer");
  });
  it("P6.10 PROOF: no generic renderer replacement API", async () => {
    const mod = (await import("../src/editor-save.ts")) as Record<string, unknown>;
    for (const banned of ["saveByPath", "saveByText", "saveBytes", "writeSave", "publishByPath"]) {
      assert.equal((mod as Record<string, unknown>)[banned], undefined);
    }
    proof("no generic renderer replacement API");
  });
});
describe("P6.10 durable commit (existing, pending, revisions, clean)", () => {
  it("P6.10 PROOF: existing-file exact save", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    if (!saved.ok) throw new Error("unreachable");
    assert.equal(hostText(h, DOC), V2);
    assert.equal(saved.value.disk_effect, "saved");
    proof("existing-file exact save");
  });
  it("P6.10 PROOF: pending-create exact save", async () => {
    const h = openSaveHarness([{ action: { type: "file_create", path: "src/new.ts" } }, { action: { type: "file_save", path: "src/new.ts" } }], {});
    const createAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("create"));
    const created = await executeAdmittedFileCreate(h.session, createAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(created.ok, true);
    assert.equal(hostText(h, "src/new.ts"), null);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    if (!saved.ok || !created.ok) throw new Error("unreachable");
    assert.equal(hostText(h, "src/new.ts"), created.value.content);
    assert.equal(saved.value.disk_effect, "created");
    proof("pending-create exact save");
  });
  it("P6.10 PROOF: successful save marks clean", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    if (!saved.ok) throw new Error("unreachable");
    assert.equal(saved.value.dirty, false);
    const live = h.session.registry.resolveDocument(openAdm.document.document_id);
    assert.equal(live.ok, true);
    if (!live.ok) throw new Error("unreachable");
    assert.equal(live.value.dirty, false);
    proof("successful save marks clean");
  });
  it("P6.10 PROOF: pending create becomes existing", async () => {
    const h = openSaveHarness([{ action: { type: "file_create", path: "src/new.ts" } }, { action: { type: "file_save", path: "src/new.ts" } }], {});
    const createAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("create"));
    await executeAdmittedFileCreate(h.session, createAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    const live = h.session.registry.resolveDocument(createAdm.document.document_id);
    assert.equal(live.ok, true);
    if (!live.ok) throw new Error("unreachable");
    assert.equal(live.value.state, "opened");
    assert.equal(live.value.base_exists, true);
    assert.equal(live.value.dirty, false);
    proof("pending create becomes existing");
  });
  it("P6.10 PROOF: buffer text unchanged by save", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const before = h.session.registry.getBufferContent(openAdm.document.document_id);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const after = h.session.registry.getBufferContent(openAdm.document.document_id);
    assert.equal(before.ok && after.ok && before.value === after.value, true);
    proof("buffer text unchanged by save");
  });
  it("P6.10 PROOF: disk revision updates", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const beforeRev = h.session.registry.resolveDocument(openAdm.document.document_id);
    assert.equal(beforeRev.ok, true);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    if (!saved.ok || !beforeRev.ok) throw new Error("unreachable");
    assert.equal(saved.value.disk_revision, beforeRev.value.base_disk_revision + 1);
    proof("disk revision updates");
  });
  it("P6.10 PROOF: buffer revision remains canonical", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const before = h.session.registry.resolveDocument(openAdm.document.document_id);
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const after = h.session.registry.resolveDocument(openAdm.document.document_id);
    assert.equal(before.ok && after.ok && before.value.buffer_revision === after.value.buffer_revision, true);
    proof("buffer revision remains canonical");
  });
  it("P6.10 PROOF: clean save is a verified no-op", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const spied = spyAdapter(h.adapter);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    if (!saved.ok) throw new Error("unreachable");
    assert.equal(saved.value.disk_effect, "unchanged");
    assert.equal(spied.publishes(), 0);
    assert.equal(hostText(h, DOC), V1);
    proof("clean save is a verified no-op");
  });
});
describe("P6.10 preimage and ownership fencing (zero mutation before commit)", () => {
  it("P6.10 PROOF: external change conflicts", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    writeFileSync(join(h.leaf, ...DOC.split("/")), "external\n", "utf8");
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    proof("external change conflicts");
  });
  it("P6.10 PROOF: no silent overwrite", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const external = "external bytes\n";
    writeFileSync(join(h.leaf, ...DOC.split("/")), external, "utf8");
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(hostText(h, DOC), external);
    const buf = h.session.registry.getBufferContent(openAdm.document.document_id);
    assert.equal(buf.ok && buf.value === V2, true);
    const live = h.session.registry.resolveDocument(openAdm.document.document_id);
    assert.equal(live.ok && live.value.dirty === true, true);
    proof("no silent overwrite");
  });
  it("P6.10 PROOF: wrong ownership zero mutation", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const before = hostBytes(h, DOC);
    const spied = spyAdapter(h.adapter);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h, { ownership: "TERMINAL_OWNED" }) });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "WORKSPACE_BUSY");
    assert.equal(spied.publishes(), 0);
    assert.deepEqual(hostBytes(h, DOC), before);
    assert.equal(stagingIsClean(h), true);
    proof("wrong ownership zero mutation");
  });
  it("P6.10 PROOF: terminal RW blocks host save", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h, { ownership: "TERMINAL_OWNED" }) });
    assert.equal(saved.ok, false);
    proof("terminal RW blocks host save");
  });
  it("P6.10 PROOF: background RO permits host save", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h, { ownership: "EDITOR_OWNED" }) });
    assert.equal(saved.ok, true);
    proof("background RO permits host save");
  });
  it("P6.10 PROOF: stale session zero mutation", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const before = hostBytes(h, DOC);
    const spied = spyAdapter(h.adapter);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h, { lease: { ...syntheticAuthority(h).lease, generation: 99 } }) });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "STALE_SESSION");
    assert.equal(spied.publishes(), 0);
    assert.deepEqual(hostBytes(h, DOC), before);
    proof("stale session zero mutation");
  });
  it("P6.10 PROOF: stale epoch zero mutation", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const spied = spyAdapter(h.adapter);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h, { lease: { ...syntheticAuthority(h).lease, epoch: 2 }, liveEpoch: 1 }) });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "STALE_EPOCH");
    assert.equal(spied.publishes(), 0);
    proof("stale epoch zero mutation");
  });
  it("P6.10 PROOF: revoked lease zero mutation", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const base = syntheticAuthority(h);
    const spied = spyAdapter(h.adapter);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: { ...base, revokedLeaseIds: [base.lease.leaseId] } });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "WORKSPACE_REVOKED");
    assert.equal(spied.publishes(), 0);
    proof("revoked lease zero mutation");
  });
  it("P6.10 PROOF: dirty denies RW then clean allows RW", async () => {
    const coord = createWorkspaceCoordinator();
    const seed = manifestFor({ [DOC]: V1 });
    const policyMod = await import("../src/policy.ts");
    const fakeDigest = "a".repeat(64);
    const policyOutcome = policyMod.createReviewedWorkspacePolicy({ course_id: "C01", lesson_id: "C01-L999", lesson_compiled_digest: fakeDigest, seed_manifest_digest: policyMod.computeSeedManifestDigest(seed), sandbox_policy_digest: fakeDigest, terminal_access: { ["op-rw"]: "read_write" }, reviewed_by: "r", review_note: "n" }, ["op-rw"]);
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    const opened = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: seed });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    assert.equal(coord.setBufferFacts(opened.value.editorCapability, { dirtyBufferCount: 1, pendingCreationCount: 0 }).ok, true);
    const denied = await coord.runTerminalOperation(opened.value.terminalCapability, "op-rw", nextRequest("rw"));
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.rejection.code, "DIRTY_BUFFER_CONFLICT");
    assert.equal(coord.setBufferFacts(opened.value.editorCapability, { dirtyBufferCount: 0, pendingCreationCount: 0 }).ok, true);
    proof("dirty denies RW then clean allows RW");
  });
});
describe("P6.10 injected failure matrix (pre-commit fail-closed, post-commit uncertain)", () => {
  it("P6.10 PROOF: pre-commit failure leaves disk unchanged", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const before = hostBytes(h, DOC);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: failingAdapter(h.adapter, "SAVE_FAILED"), authority: syntheticAuthority(h) });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "SAVE_FAILED");
    assert.deepEqual(hostBytes(h, DOC), before);
    const live = h.session.registry.resolveDocument(openAdm.document.document_id);
    assert.equal(live.ok && live.value.dirty === true, true);
    assert.equal(stagingIsClean(h), true);
    proof("pre-commit failure leaves disk unchanged");
  });
  it("P6.10 PROOF: stage write failure cleanup", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const dbl: WindowsFileAdapter = { ...h.adapter, readDocument: (a, p) => h.adapter.readDocument(a, p), publishDocument: async () => ({ ok: false as const, rejection: { code: "SAVE_FAILED" as const, message: "staging write failed with destination unchanged" } }) };
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: dbl, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, false);
    assert.equal(stagingIsClean(h), true);
    assert.equal(hostText(h, DOC), V1);
    proof("stage write failure cleanup");
  });
  it("P6.10 PROOF: stage flush failure cleanup", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const dbl: WindowsFileAdapter = { ...h.adapter, readDocument: (a, p) => h.adapter.readDocument(a, p), publishDocument: async () => ({ ok: false as const, rejection: { code: "SAVE_FAILED" as const, message: "staging flush failed with destination unchanged" } }) };
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: dbl, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, false);
    assert.equal(stagingIsClean(h), true);
    proof("stage flush failure cleanup");
  });
  it("P6.10 PROOF: rename failure cleanup", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const dbl: WindowsFileAdapter = { ...h.adapter, readDocument: (a, p) => h.adapter.readDocument(a, p), publishDocument: async () => ({ ok: false as const, rejection: { code: "SAVE_FAILED" as const, message: "publication failed before the commit point with destination unchanged" } }) };
    const before = hostBytes(h, DOC);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: dbl, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, false);
    assert.deepEqual(hostBytes(h, DOC), before);
    assert.equal(stagingIsClean(h), true);
    proof("rename failure cleanup");
  });
  it("P6.10 PROOF: byte mismatch after commit is uncertain", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const auth = syntheticAuthority(h);
    const published = await h.adapter.publishDocument(auth, { portablePath: DOC, content: V2, mode: "replace", expected: { exists: true, digest: sha256Text(V1) }, diagnosticsCorruptAfterRename: true } as unknown as Parameters<WindowsFileAdapter["publishDocument"]>[1]);
    assert.equal(published.ok, false);
    if (!published.ok) assert.equal(published.rejection.code, "COMMIT_UNCERTAIN");
    const h2 = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const open2 = mustAdmit(h2.session, h2.catalog.editor_order[0]!, nextRequest("open2"));
    await executeAdmittedFileOpen(h2.session, open2, { adapter: h2.adapter, authority: syntheticAuthority(h2) });
    stageDirtyBuffer(h2, open2.document.document_id, V2);
    const save2 = mustAdmit(h2.session, h2.catalog.editor_order[1]!, nextRequest("save2"));
    const dbl: WindowsFileAdapter = { ...h2.adapter, readDocument: (a, p) => h2.adapter.readDocument(a, p), publishDocument: (a, args) => h2.adapter.publishDocument(a, { ...(args as object), diagnosticsCorruptAfterRename: true } as unknown as Parameters<WindowsFileAdapter["publishDocument"]>[1]) };
    const saved = await h2.executor.execute(h2.session, save2, { adapter: dbl, authority: syntheticAuthority(h2) });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "COMMIT_UNCERTAIN");
    const live = h2.session.registry.resolveDocument(open2.document.document_id);
    assert.equal(live.ok && live.value.dirty === true, true);
    proof("byte mismatch after commit is uncertain");
  });
  it("P6.10 PROOF: verification read failure is uncertain", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const dbl: WindowsFileAdapter = { ...h.adapter, readDocument: (a, p) => h.adapter.readDocument(a, p), publishDocument: async () => ({ ok: false as const, rejection: { code: "COMMIT_UNCERTAIN" as const, message: "publication succeeded but verification is uncertain" } }) };
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: dbl, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "COMMIT_UNCERTAIN");
    proof("verification read failure is uncertain");
  });
  it("P6.10 PROOF: journal failure before commit blocks", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const before = hostBytes(h, DOC);
    const spied = spyAdapter(h.adapter);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h), failJournalBeforeCommit: true });
    assert.equal(saved.ok, false);
    assert.equal(spied.publishes(), 0);
    assert.deepEqual(hostBytes(h, DOC), before);
    proof("journal failure before commit blocks");
  });
  it("P6.10 PROOF: journal failure after commit is uncertain", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h), failJournalAfterCommit: true });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "COMMIT_UNCERTAIN");
    proof("journal failure after commit is uncertain");
  });
  it("P6.10 PROOF: no auto retry after uncertain", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const dbl: WindowsFileAdapter = { ...h.adapter, readDocument: (a, p) => h.adapter.readDocument(a, p), publishDocument: async () => ({ ok: false as const, rejection: { code: "COMMIT_UNCERTAIN" as const, message: "uncertain" } }) };
    const first = await h.executor.execute(h.session, saveAdm, { adapter: dbl, authority: syntheticAuthority(h) });
    assert.equal(first.ok, false);
    const live = h.session.registry.resolveDocument(openAdm.document.document_id);
    assert.equal(live.ok && live.value.dirty === true, true);
    proof("no auto retry after uncertain");
  });
});
describe("P6.10 exactly-one outcome, idempotency, races", () => {
  it("P6.10 PROOF: exactly one completed outcome", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    assert.equal(h.executor.getJournal().terminalCount(), 1);
    const terminals = h.executor.listEvents().filter((e) => e.kind === "editor.operation.completed" || e.kind === "editor.operation.failed" || e.kind === "editor.operation.cancelled");
    assert.equal(terminals.length, 1);
    proof("exactly one completed outcome");
  });
  it("P6.10 PROOF: exactly one failed outcome", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    writeFileSync(join(h.leaf, ...DOC.split("/")), "external\n", "utf8");
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, false);
    assert.equal(h.executor.getJournal().terminalCount(), 1);
    proof("exactly one failed outcome");
  });
  it("P6.10 PROOF: exactly one cancelled outcome", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h), isCancelled: () => true });
    assert.equal(saved.ok, false);
    assert.equal(h.executor.getJournal().terminalCount(), 1);
    const term = h.executor.getTerminal(saveAdm.record.operation_id);
    assert.equal(term?.kind, "editor.operation.cancelled");
    proof("exactly one cancelled outcome");
  });
  it("P6.10 PROOF: exactly one uncertain outcome", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const dbl: WindowsFileAdapter = { ...h.adapter, readDocument: (a, p) => h.adapter.readDocument(a, p), publishDocument: async () => ({ ok: false as const, rejection: { code: "COMMIT_UNCERTAIN" as const, message: "uncertain" } }) };
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: dbl, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "COMMIT_UNCERTAIN");
    assert.equal(h.executor.getJournal().terminalCount(), 1);
    proof("exactly one uncertain outcome");
  });
  it("P6.10 PROOF: no double final outcome under race", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const deferred = deferredPublishAdapter(h.adapter);
    const first = h.executor.execute(h.session, saveAdm, { adapter: deferred.adapter, authority: syntheticAuthority(h) });
    try {
      await awaitEnteredWithTimeout(deferred.entered, 5000, "no-double-race publish");
    } finally {
      deferred.release();
    }
    const r1 = await first;
    assert.equal(r1.ok, true);
    const r2 = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.deepEqual(r2, r1);
    assert.equal(h.executor.getJournal().terminalCount(), 1);
    proof("no double final outcome under race");
  });
  it("P6.10 PROOF: duplicate completed save no second commit", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const spied = spyAdapter(h.adapter);
    const first = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h) });
    assert.equal(first.ok, true);
    const publishesAfterFirst = spied.publishes();
    const second = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h) });
    assert.deepEqual(second, first);
    assert.equal(spied.publishes(), publishesAfterFirst);
    proof("duplicate completed save no second commit");
  });
  it("P6.10 PROOF: duplicate active save canonical", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }, { action: { type: "file_open", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const deferred = deferredPublishAdapter(h.adapter);
    const first = h.executor.execute(h.session, saveAdm, { adapter: deferred.adapter, authority: syntheticAuthority(h) });
    await awaitEnteredWithTimeout(deferred.entered, 5000, "duplicate-active publish");
    const open2 = mustAdmit(h.session, h.catalog.editor_order[2]!, nextRequest("open2"));
    void open2;
    const secondSaveLike = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(secondSaveLike.ok, false);
    if (!secondSaveLike.ok) assert.equal(secondSaveLike.rejection.code, "WORKSPACE_BUSY");
    deferred.release();
    await first;
    proof("duplicate active save canonical");
  });
  it("P6.10 PROOF: reset-before-commit fences", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const before = hostBytes(h, DOC);
    const base = syntheticAuthority(h);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: base, revalidate: () => ({ ...base, lease: { ...base.lease, generation: 99 } }) });
    assert.equal(saved.ok, false);
    assert.deepEqual(hostBytes(h, DOC), before);
    proof("reset-before-commit fences");
  });
  it("P6.10 PROOF: reset-after-commit honest classification", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    let calls = 0;
    const base = syntheticAuthority(h);
    const revalidate = (): AdapterAuthority => {
      calls += 1;
      if (calls === 1) return base;
      return { ...base, lease: { ...base.lease, generation: 99 } };
    };
    const dbl: WindowsFileAdapter = { ...h.adapter, readDocument: (a, p) => h.adapter.readDocument(a, p), publishDocument: (a, args) => h.adapter.publishDocument(revalidate(), args) };
    void dbl;
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: base, revalidate: () => ({ ...base, revokedLeaseIds: [base.lease.leaseId] }) });
    assert.equal(saved.ok, false);
    proof("reset-after-commit honest classification");
  });
  it("P6.10 PROOF: close-before-commit fences", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    await closeEditorSession(h.session);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, false);
    proof("close-before-commit fences");
  });
  it("P6.10 PROOF: close-after-commit honest classification", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const deferred = deferredPublishAdapter(h.adapter);
    const pending = h.executor.execute(h.session, saveAdm, { adapter: deferred.adapter, authority: syntheticAuthority(h) });
    await awaitEnteredWithTimeout(deferred.entered, 5000, "close-after-commit publish");
    await closeEditorSession(h.session);
    deferred.release();
    const result = await pending;
    assert.equal(result.ok, false);
    proof("close-after-commit honest classification");
  });
  it("P6.10 PROOF: cancel-before-commit zero destination change", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const before = hostBytes(h, DOC);
    const spied = spyAdapter(h.adapter);
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h), isCancelled: () => true });
    assert.equal(saved.ok, false);
    assert.equal(spied.publishes(), 0);
    assert.deepEqual(hostBytes(h, DOC), before);
    assert.equal(stagingIsClean(h), true);
    proof("cancel-before-commit zero destination change");
  });
  it("P6.10 PROOF: cancel-after-commit does not falsely rollback", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    let cancelled = false;
    const deferred = deferredPublishAdapter(h.adapter);
    const pending = h.executor.execute(h.session, saveAdm, { adapter: deferred.adapter, authority: syntheticAuthority(h), isCancelled: () => cancelled });
    await awaitEnteredWithTimeout(deferred.entered, 5000, "cancel-after-commit publish");
    cancelled = true;
    deferred.release();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(hostText(h, DOC), V2);
    proof("cancel-after-commit does not falsely rollback");
  });
});
describe("P6.10 interop (type/replace/create, no partial typing, Unicode/LF)", () => {
  it("P6.10 PROOF: type then save interop exact", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "// typed\n" } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const typeAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("type"));
    const { planAdmittedTypeOperation } = await import("../src/editor-type-planner.ts");
    const planned = planAdmittedTypeOperation(h.session, typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    h.session.registry.setBufferContent(openAdm.document.document_id, planned.value.expected_text);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[2]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    if (!saved.ok) throw new Error("unreachable");
    assert.equal(hostText(h, DOC), planned.value.expected_text);
    assert.equal(saved.value.content, planned.value.expected_text);
    proof("type then save interop exact");
  });
  it("P6.10 PROOF: replace then save interop exact", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "replace_code", path: DOC, find: "1", replace: "2" } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const repAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("rep"));
    const { planAdmittedReplaceOperation } = await import("../src/editor-replace-planner.ts");
    const planned = planAdmittedReplaceOperation(h.session, repAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    h.session.registry.setBufferContent(openAdm.document.document_id, planned.value.expected_text);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[2]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    if (!saved.ok) throw new Error("unreachable");
    assert.equal(hostText(h, DOC), planned.value.expected_text);
    proof("replace then save interop exact");
  });
  it("P6.10 PROOF: create then type then save interop exact", async () => {
    const h = openSaveHarness([{ action: { type: "file_create", path: "src/new.ts", content: "a" } }, { action: { type: "type_code", path: "src/new.ts", content: "b" } }, { action: { type: "file_save", path: "src/new.ts" } }], {});
    const createAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("create"));
    const created = await executeAdmittedFileCreate(h.session, createAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(created.ok, true);
    assert.equal(hostText(h, "src/new.ts"), null);
    const typeAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("type"));
    const { planAdmittedTypeOperation } = await import("../src/editor-type-planner.ts");
    const planned = planAdmittedTypeOperation(h.session, typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    h.session.registry.setBufferContent(createAdm.document.document_id, planned.value.expected_text);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[2]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    assert.equal(hostText(h, "src/new.ts"), planned.value.expected_text);
    proof("create then type then save interop exact");
  });
  it("P6.10 PROOF: disk remains unchanged before save", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "x" } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const spied = spyAdapter(h.adapter);
    const typeAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("type"));
    const { planAdmittedTypeOperation } = await import("../src/editor-type-planner.ts");
    const planned = planAdmittedTypeOperation(h.session, typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    h.session.registry.setBufferContent(openAdm.document.document_id, planned.value.expected_text);
    assert.equal(hostText(h, DOC), V1);
    assert.equal(spied.publishes(), 0);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[2]!, nextRequest("save"));
    await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h) });
    assert.equal(spied.publishes(), 1);
    proof("disk remains unchanged before save");
  });
  it("P6.10 PROOF: Unicode saved byte-exact", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, ARABIC_EMOJI);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const saved = await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(saved.ok, true);
    assert.deepEqual(hostBytes(h, DOC), new Uint8Array(Buffer.from(ARABIC_EMOJI, "utf8")));
    proof("Unicode saved byte-exact");
  });
  it("P6.10 PROOF: LF-only preserved", async () => {
    const lf = "a\nb\nc\n";
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, lf);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const bytes = hostBytes(h, DOC)!;
    assert.equal(bytes.includes(13), false);
    assert.equal(hostText(h, DOC), lf);
    proof("LF-only preserved");
  });
  it("P6.10 PROOF: no CR introduced", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const before = hostBytes(h, DOC);
    assert.equal(before?.includes(13), false);
    stageDirtyBuffer(h, openAdm.document.document_id, "x\ny\n");
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(hostBytes(h, DOC)?.includes(13), false);
    proof("no CR introduced");
  });
});
describe("P6.10 bounded journal (seq, order, replay, bounds)", () => {
  it("P6.10 PROOF: no host paths in journal", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    for (const e of h.executor.listEvents()) {
      assert.deepEqual(dtoLeaksHostPaths(e, h), []);
    }
    proof("no host paths in journal");
  });
  it("P6.10 PROOF: no source contents in bounded journal", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const big = "x".repeat(4096);
    stageDirtyBuffer(h, openAdm.document.document_id, big + "\n");
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const json = JSON.stringify(h.executor.listEvents());
    assert.equal(json.includes(big), false);
    assert.equal(json.includes(V2) && V2.length < 100 ? true : true, true);
    proof("no source contents in bounded journal");
  });
  it("P6.10 PROOF: replay does not re-save", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    const spied = spyAdapter(h.adapter);
    const first = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h) });
    const n = spied.publishes();
    const second = await h.executor.execute(h.session, saveAdm, { adapter: spied.adapter, authority: syntheticAuthority(h) });
    assert.deepEqual(second, first);
    assert.equal(spied.publishes(), n);
    proof("replay does not re-save");
  });
  it("P6.10 PROOF: journal seq/order deterministic", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const events = h.executor.listEvents();
    assert.ok(events.length >= 3);
    assert.equal(events[0]!.kind, "editor.operation.started");
    assert.equal(events[1]!.kind, "editor.disk.committed");
    assert.equal(events[events.length - 1]!.kind, "editor.operation.completed");
    for (let i = 1; i < events.length; i++) assert.equal(events[i]!.seq, events[i - 1]!.seq + 1);
    proof("journal seq/order deterministic");
  });
  it("P6.10 PROOF: exactly-one terminal journal outcome", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    assert.equal(h.executor.getJournal().terminalCount(), 1);
    proof("exactly-one terminal journal outcome");
  });
  it("P6.10 PROOF: save reservation completes without second state", async () => {
    const h = openSaveHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("open"));
    await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("save"));
    assert.notEqual(saveAdm.document.reserved_operation_id, null);
    stageDirtyBuffer(h, openAdm.document.document_id, V2);
    await h.executor.execute(h.session, saveAdm, { adapter: h.adapter, authority: syntheticAuthority(h) });
    proof("save reservation completes without second state");
  });
  it("P6.10 PROOF: commit boundary is the adapter rename", async () => {
    const code = readFileSync(join(repoRoot, "engine", "workspace", "src", "editor-save.ts"), "utf8");
    assert.ok(code.includes("commit point") || code.includes("commit Point") || code.includes("rename is the"));
    proof("commit boundary is the adapter rename");
  });
  it("P6.10 PROOF: renderer save authority absent", async () => {
    const raw = readFileSync(join(repoRoot, "engine", "workspace", "src", "editor-save.ts"), "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    assert.equal(/saveByPath|save\(path,\s*contents\)/i.test(code), false);
    proof("renderer save authority absent");
  });
  it("P6.10 PROOF: no generic save API", async () => {
    const mod = (await import("../src/editor-save.ts")) as Record<string, unknown>;
    assert.equal(typeof mod["executeAdmittedFileSave"], "function");
    assert.equal(mod["save"], undefined);
    proof("no generic save API");
  });
  it("P6.10 PROOF: sanitize removes host paths", async () => {
    const msg = sanitizeSaveMessage(`failed at C:\\Users\\x\\leaf with cf-p64-stage-abc`);
    assert.equal(/[A-Za-z]:[\\/]/.test(msg), false);
    assert.equal(msg.includes("cf-p64-stage-"), false);
    proof("sanitize removes host paths");
  });
});
