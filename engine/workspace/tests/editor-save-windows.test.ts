// P6.10 Save and journal — REAL Windows platform proofs (no mocks, no skips).
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.10 Save and journal.
// These tests prove the commit semantics that depend on the actual NTFS
// substrate: guarded existing-file replacement, pending-file creation,
// byte-exact Unicode/LF, atomic replacement (only complete old/new bytes),
// external-modification conflict with zero clobber, open-handle sharing
// failure then success, post-save byte verification, and staging cleanup.
// Deterministic fencing, journal ordering, and failure classification are
// proven in editor-save.test.ts; this suite proves the platform behavior
// that determinism cannot.
// Every resource lives under the phase-owned temp/P6.10/windows root with
// cf-p610-w names. These tests FAIL (never skip) when the platform behavior
// is unavailable.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { createSeedManifest, sha256Hex, type SeedManifest } from "../src/policy.ts";
import { openWindowsFileAdapter, type AdapterAuthority, type WindowsFileAdapter } from "../src/file-adapter.ts";
import { admitEditorOperation, createEditorCatalog, openEditorSession, type EditorCatalog, type EditorOperationAdmission, type EditorSession } from "../src/editor-admission.ts";
import { executeAdmittedFileCreate, executeAdmittedFileOpen } from "../src/editor-open-create.ts";
import { createFileSaveExecutor } from "../src/editor-save.ts";
const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.10", "windows");
let counter = 0;
let requestSeq = 0;
function proof(message: string): void {
  console.log(`P6.10 PROOF: ${message}`);
}
function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p610w-${prefix}-${requestSeq}`;
}
function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function buildLesson(actions: Array<{ action: unknown }>): { compiled: CompiledLesson; operationIds: string[] } {
  counter += 1;
  const lessonId = `C01-L${String(80 + counter).padStart(3, "0")}`;
  const operationIds = actions.map((_, i) => `${lessonId}-S001-B${String(i + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: `Synthetic P6.10 windows ${lessonId}`,
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Windows save proof"],
    prerequisites: [],
    keywords: ["editor", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.10" },
    scenes: [{ scene_id: `${lessonId}-S001`, type: "code_demo", title: "Save", duration: 60, visual: { kind: "code_editor", description: "save" }, beats: actions.map((e, i) => ({ beat_id: operationIds[i], kind: "action", action: e.action })) }],
  };
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  return { compiled: compileModule.compileLesson(parsed.lesson), operationIds };
}
function manifestFor(files: Record<string, string>): SeedManifest {
  const entries = [
    { portable_path: "src", kind: "directory" as const, byte_length: 0, sha256: null as string | null },
    ...Object.entries(files).map(([portable_path, text]) => ({ portable_path, kind: "regular_file" as const, byte_length: Buffer.byteLength(text, "utf8"), sha256: sha256Hex(text) as string | null })),
  ];
  const outcome = createSeedManifest(entries);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}
interface WHarness {
  readonly leaf: string;
  readonly staging: string;
  readonly adapter: WindowsFileAdapter;
  readonly session: EditorSession;
  readonly catalog: EditorCatalog;
  readonly sessionId: string;
  readonly workspaceId: string;
}
function openHarness(actions: Array<{ action: unknown }>, files: Record<string, string>): WHarness {
  const tag = `cf-p610-w${counter}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(join(leaf, "src"), { recursive: true });
  mkdirSync(staging, { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
  const seed = manifestFor(files);
  const { compiled } = buildLesson(actions);
  const cat = createEditorCatalog(compiled);
  assert.equal(cat.ok, true);
  if (!cat.ok) throw new Error("unreachable");
  const sessionId = `sess-p610w-${String(counter).padStart(4, "0")}`;
  const workspaceId = `ws-p610w-${String(counter).padStart(4, "0")}`;
  const opened = openEditorSession({ catalog: cat.value, sessionId, generation: 1, seedManifest: seed, reviewed: true });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error("unreachable");
  return { leaf, staging, adapter: bound.value, session: opened.value, catalog: cat.value, sessionId, workspaceId };
}
function authorityFor(h: WHarness): AdapterAuthority {
  return {
    lease: { kind: "editor_lease", leaseId: `lease-p610w-${counter}`, sessionId: h.sessionId, generation: 1, workspaceId: h.workspaceId, epoch: 1, operationId: "op-w", requestId: nextRequest("auth") },
    ownership: "EDITOR_OWNED",
    liveEpoch: 1,
    revokedLeaseIds: [],
  };
}
function mustAdmit(session: EditorSession, operationId: string, requestId: string): EditorOperationAdmission {
  const outcome = admitEditorOperation(session, { session_id: session.sessionId, generation: session.generation, operation_id: operationId, request_id: requestId });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}
function stageDirty(h: WHarness, docId: string, text: string): void {
  assert.equal(h.session.registry.setBufferContent(docId, text).ok, true);
  assert.equal(h.session.registry.reserveDocumentOperation(docId, `test-dirty-${nextRequest("d")}`, true).ok, true);
}
const DOC = "src/save.ts";
const V1 = "const save = 1;\n";
const V2 = "const save = 2;\n";
const UNI = "// English \u062A\u0639\u0644\u064A\u0642 \u0639\u0631\u0628\u064A \uD83D\uDE80\nconst g = \"\u0645\u0631\u062D\u0628\u0627\";\n";
before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});
after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false);
});
describe("P6.10 windows commit (NTFS, no mocks)", () => {
  it("P6.10 PROOF: windows existing replace exact", async () => {
    const h = openHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("o"));
    assert.equal((await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: authorityFor(h) })).ok, true);
    stageDirty(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("s"));
    const exec = createFileSaveExecutor();
    const saved = await exec.execute(h.session, saveAdm, { adapter: h.adapter, authority: authorityFor(h) });
    assert.equal(saved.ok, true);
    assert.equal(readFileSync(join(h.leaf, ...DOC.split("/")), "utf8"), V2);
    assert.equal(readdirSync(h.staging).length, 0);
    proof("windows existing replace exact");
  });
  it("P6.10 PROOF: windows pending create exact", async () => {
    const h = openHarness([{ action: { type: "file_create", path: "src/new.ts", content: "hi\n" } }, { action: { type: "file_save", path: "src/new.ts" } }], {});
    const createAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("c"));
    const created = await executeAdmittedFileCreate(h.session, createAdm, { adapter: h.adapter, authority: authorityFor(h) });
    assert.equal(created.ok, true);
    assert.equal(existsSync(join(h.leaf, "src", "new.ts")), false);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("s"));
    const exec = createFileSaveExecutor();
    const saved = await exec.execute(h.session, saveAdm, { adapter: h.adapter, authority: authorityFor(h) });
    assert.equal(saved.ok, true);
    assert.equal(readFileSync(join(h.leaf, "src", "new.ts"), "utf8"), "hi\n");
    proof("windows pending create exact");
  });
  it("P6.10 PROOF: windows unicode LF byte-exact", async () => {
    const h = openHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("o"));
    assert.equal((await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: authorityFor(h) })).ok, true);
    stageDirty(h, openAdm.document.document_id, UNI);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("s"));
    const saved = await createFileSaveExecutor().execute(h.session, saveAdm, { adapter: h.adapter, authority: authorityFor(h) });
    assert.equal(saved.ok, true);
    const bytes = new Uint8Array(readFileSync(join(h.leaf, ...DOC.split("/"))));
    assert.deepEqual(bytes, new Uint8Array(Buffer.from(UNI, "utf8")));
    assert.equal(bytes.includes(13), false);
    proof("windows unicode LF byte-exact");
  });
  it("P6.10 PROOF: windows external conflict zero clobber", async () => {
    const h = openHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("o"));
    assert.equal((await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: authorityFor(h) })).ok, true);
    stageDirty(h, openAdm.document.document_id, V2);
    writeFileSync(join(h.leaf, ...DOC.split("/")), "external\n", "utf8");
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("s"));
    const saved = await createFileSaveExecutor().execute(h.session, saveAdm, { adapter: h.adapter, authority: authorityFor(h) });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.equal(saved.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(readFileSync(join(h.leaf, ...DOC.split("/")), "utf8"), "external\n");
    proof("windows external conflict zero clobber");
  });
  it("P6.10 PROOF: windows sharing failure then success", async () => {
    const h = openHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("o"));
    assert.equal((await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: authorityFor(h) })).ok, true);
    stageDirty(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("s"));
    const target = join(h.leaf, ...DOC.split("/"));
    const handle = await open(target, "r");
    try {
      const blocked = await createFileSaveExecutor().execute(h.session, saveAdm, { adapter: h.adapter, authority: authorityFor(h) });
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.rejection.code, "SAVE_FAILED");
      assert.equal(readFileSync(target, "utf8"), V1);
    } finally {
      await handle.close();
    }
    const retry = await createFileSaveExecutor().execute(h.session, saveAdm, { adapter: h.adapter, authority: authorityFor(h) });
    assert.equal(retry.ok, true);
    assert.equal(readFileSync(target, "utf8"), V2);
    proof("windows sharing failure then success");
  });
  it("P6.10 PROOF: windows byte verification and staging clean", async () => {
    const h = openHarness([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }], { [DOC]: V1 });
    const openAdm = mustAdmit(h.session, h.catalog.editor_order[0]!, nextRequest("o"));
    assert.equal((await executeAdmittedFileOpen(h.session, openAdm, { adapter: h.adapter, authority: authorityFor(h) })).ok, true);
    stageDirty(h, openAdm.document.document_id, V2);
    const saveAdm = mustAdmit(h.session, h.catalog.editor_order[1]!, nextRequest("s"));
    const saved = await createFileSaveExecutor().execute(h.session, saveAdm, { adapter: h.adapter, authority: authorityFor(h) });
    assert.equal(saved.ok, true);
    if (!saved.ok) throw new Error("unreachable");
    assert.equal(saved.value.disk_digest, sha256Text(V2));
    assert.equal(readFileSync(join(h.leaf, ...DOC.split("/")), "utf8"), V2);
    assert.equal(readdirSync(h.staging).length, 0);
    proof("windows byte verification and staging clean");
  });
});
