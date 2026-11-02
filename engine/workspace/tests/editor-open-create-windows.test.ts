// P6.7 Open/create — REAL Windows platform proofs (no mocks, no skips).
//
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.7 Open/create. These
// tests prove the execution semantics that depend on the actual NTFS
// substrate: Windows case-alias collapse onto one document authority (no
// duplicate writable buffers for src/CaseA.ts vs src/casea.ts), creation
// case-collision as FILE_EXISTS (no clobber), junction/symlink ancestry and
// link targets denied with outside sentinels untouched, and pending
// creations absent from the real disk before save. Byte-exact loading,
// failure codes and fencing logic are proven deterministically in
// editor-open-create.test.ts; this suite proves the platform behavior that
// determinism cannot.
//
// Every resource lives under the phase-owned temp/P6.7/windows root with
// cf-p67-w names. Outside sentinels are siblings of the leaf (outside the
// owned workspace but inside the phase root). These tests FAIL (never skip)
// when the platform behavior is unavailable.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { createSeedManifest, sha256Hex, type SeedManifest } from "../src/policy.ts";
import { openWindowsFileAdapter, type AdapterAuthority, type WindowsFileAdapter } from "../src/file-adapter.ts";
import {
  admitEditorOperation,
  createEditorCatalog,
  openEditorSession,
  type EditorCatalog,
  type EditorOperationAdmission,
  type EditorSession,
} from "../src/editor-admission.ts";
import { executeAdmittedFileCreate, executeAdmittedFileOpen } from "../src/editor-open-create.ts";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.7", "windows");

const CASE_OPEN1 = "C01-L067-S001-B001";
const CASE_OPEN2 = "C01-L067-S002-B001";
const JUN_OPEN = "C01-L068-S001-B001";
const JUN_CREATE = "C01-L068-S002-B001";
const LINK_OPEN = "C01-L069-S001-B001";
const A_OPEN = "C01-L061-S001-B001";
const A_CREATE = "C01-L061-S002-B001";

let counter = 0;
let requestSeq = 0;

function proof(message: string): void {
  console.log(`P6.7 PROOF: ${message}`);
}

function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p67w-${prefix}-${requestSeq}`;
}

function compileFixtureLesson(name: string): CompiledLesson {
  const raw: unknown = JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true, `fixture ${name} must pass canonical source validation`);
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  return compileModule.compileLesson(parsed.lesson);
}

interface WindowsHarness {
  readonly tag: string;
  readonly leaf: string;
  readonly staging: string;
  readonly adapter: WindowsFileAdapter;
  readonly session: EditorSession;
  readonly catalog: EditorCatalog;
  readonly sessionId: string;
  readonly workspaceId: string;
}

function openHarness(
  fixtureName: string,
  seedEntries: Array<{ portable_path: string; kind: "directory" | "regular_file"; text?: string }>,
  writeDisk: (leaf: string) => void,
): WindowsHarness {
  counter += 1;
  const tag = `cf-p67-w${counter}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(leaf, { recursive: true });
  mkdirSync(staging, { recursive: true });
  writeDisk(leaf);
  const manifestOutcome = createSeedManifest(
    seedEntries.map((entry) => ({
      portable_path: entry.portable_path,
      kind: entry.kind,
      byte_length: entry.kind === "directory" ? 0 : Buffer.byteLength(entry.text ?? "", "utf8"),
      sha256: entry.kind === "directory" ? null : sha256Hex(entry.text ?? ""),
    })),
  );
  assert.equal(manifestOutcome.ok, true, "seed manifest must build");
  if (!manifestOutcome.ok) throw new Error("unreachable");
  const catalogOutcome = createEditorCatalog(compileFixtureLesson(fixtureName));
  assert.equal(catalogOutcome.ok, true, "catalog must build");
  if (!catalogOutcome.ok) throw new Error("unreachable");
  const sessionId = `sess-p67w-${String(counter).padStart(4, "0")}`;
  const workspaceId = `ws-p67w-${String(counter).padStart(4, "0")}`;
  const opened = openEditorSession({
    catalog: catalogOutcome.value,
    sessionId,
    generation: 1,
    seedManifest: manifestOutcome.value,
    reviewed: true,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const bound = openWindowsFileAdapter({
    sessionId,
    generation: 1,
    workspaceId,
    leafHostPath: leaf,
    stagingHostPath: staging,
  });
  assert.equal(bound.ok, true, "adapter binding must open");
  if (!bound.ok) throw new Error("unreachable");
  return { tag, leaf, staging, adapter: bound.value, session: opened.value, catalog: catalogOutcome.value, sessionId, workspaceId };
}

function authority(h: WindowsHarness): AdapterAuthority {
  return {
    lease: {
      kind: "editor_lease",
      leaseId: `lease-p67w-${counter}`,
      sessionId: h.sessionId,
      generation: 1,
      workspaceId: h.workspaceId,
      epoch: 1,
      operationId: "op-p67w-1",
      requestId: nextRequest("lease"),
    },
    ownership: "EDITOR_OWNED",
    liveEpoch: 1,
    revokedLeaseIds: [],
  };
}

function mustAdmit(session: EditorSession, operationId: string): EditorOperationAdmission {
  const outcome = admitEditorOperation(session, {
    session_id: session.sessionId,
    generation: session.generation,
    operation_id: operationId,
    request_id: nextRequest("admit"),
  });
  assert.equal(outcome.ok, true, `admission of ${operationId} must succeed: ${outcome.ok ? "" : outcome.rejection.code}`);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "phase-owned test root is removed (cleanup green)");
});

describe("P6.7 real Windows file identity and confinement", () => {
  it("P6.7 PROOF: Windows case alias collapses onto one document authority", async () => {
    const text = "const caseA = \"mixed\";\n";
    const h = openHarness(
      "p67-case-variant.json",
      [
        { portable_path: "src", kind: "directory" },
        { portable_path: "src/CaseA.ts", kind: "regular_file", text },
      ],
      (leaf) => {
        mkdirSync(join(leaf, "src"), { recursive: true });
        writeFileSync(join(leaf, "src", "CaseA.ts"), text, "utf8");
      },
    );
    const first = mustAdmit(h.session, CASE_OPEN1);
    const opened = await executeAdmittedFileOpen(h.session, first, { adapter: h.adapter, authority: authority(h) });
    assert.equal(opened.ok, true, `exact-case open must succeed: ${opened.ok ? "" : opened.rejection.code}`);
    if (!opened.ok) throw new Error("unreachable");
    assert.equal(opened.value.content, text);
    // The case-variant admission resolves to the same canonical document
    // (P6.6 collapse); execution reads through the live descriptor's exact
    // disk spelling, so no alias read and no second authority can form.
    const second = mustAdmit(h.session, CASE_OPEN2);
    assert.equal(second.document.document_id, first.document.document_id, "one canonical document per Windows file");
    const refocused = await executeAdmittedFileOpen(h.session, second, { adapter: h.adapter, authority: authority(h) });
    assert.equal(refocused.ok, true);
    if (!refocused.ok) throw new Error("unreachable");
    assert.equal(refocused.value.document.document_id, first.document.document_id, "no duplicate writable authority");
    assert.equal(refocused.value.content, text);
    assert.equal(refocused.value.reloaded, false);
    assert.equal(refocused.value.file_identity, opened.value.file_identity, "trusted identity stable across case variants");
    assert.equal(h.session.registry.listDocuments().length, 1, "exactly one live document for both spellings");
    proof("Windows case alias collapses onto one document authority");
  });

  it("P6.7 PROOF: create through a Windows case alias fails without clobber", async () => {
    const existing = "const upper = 1;\n";
    const h = openHarness(
      "p67-open-create.json",
      [
        { portable_path: "src", kind: "directory" },
        { portable_path: "src/alpha.ts", kind: "regular_file", text: "const alpha = 1;\n" },
      ],
      (leaf) => {
        mkdirSync(join(leaf, "src"), { recursive: true });
        writeFileSync(join(leaf, "src", "alpha.ts"), "const alpha = 1;\n", "utf8");
        // Existing file under a different case than the authored creation.
        writeFileSync(join(leaf, "src", "Beta.ts"), existing, "utf8");
      },
    );
    mustAdmit(h.session, A_OPEN);
    const admission = mustAdmit(h.session, A_CREATE);
    const created = await executeAdmittedFileCreate(h.session, admission, { adapter: h.adapter, authority: authority(h) });
    assert.equal(created.ok, false);
    if (created.ok) throw new Error("unreachable");
    assert.equal(created.rejection.code, "FILE_EXISTS", "canonical case collision: no second document, no clobber");
    assert.equal(readFileSync(join(h.leaf, "src", "Beta.ts"), "utf8"), existing, "existing bytes untouched");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false, "nothing staged on collision");
    assert.equal(readdirSync(h.staging).length, 0, "no staging residue");
    proof("create through a Windows case alias fails without clobber");
  });

  it("P6.7 PROOF: junction ancestry escapes are rejected (sentinel unchanged)", async () => {
    const outsideSeed = "const seen = true;\n";
    const h = openHarness(
      "p67-windows-junction.json",
      [
        { portable_path: "jun", kind: "directory" },
        { portable_path: "jun/seen.ts", kind: "regular_file", text: outsideSeed },
      ],
      (leaf) => {
        const outside = join(TEST_ROOT, `${leaf.split("\\").pop()}-outside`);
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "seen.ts"), outsideSeed, "utf8");
        writeFileSync(join(outside, "sentinel.txt"), "do-not-touch", "utf8");
        symlinkSync(outside, join(leaf, "jun"), "junction");
        assert.equal(lstatSync(join(leaf, "jun")).isSymbolicLink(), true, "the fixture is a real reparse point");
      },
    );
    const outside = join(TEST_ROOT, `${h.leaf.split("\\").pop()}-outside`);
    const openAdmission = mustAdmit(h.session, JUN_OPEN);
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, { adapter: h.adapter, authority: authority(h) });
    assert.equal(opened.ok, false);
    if (opened.ok) throw new Error("unreachable");
    assert.equal(opened.rejection.code, "WORKSPACE_VIOLATION", "reparse ancestry never resolves");
    const createAdmission = mustAdmit(h.session, JUN_CREATE);
    const created = await executeAdmittedFileCreate(h.session, createAdmission, { adapter: h.adapter, authority: authority(h) });
    assert.equal(created.ok, false);
    if (created.ok) throw new Error("unreachable");
    assert.equal(created.rejection.code, "WORKSPACE_VIOLATION", "creation through reparse ancestry never resolves");
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "do-not-touch", "outside sentinel untouched");
    assert.equal(readFileSync(join(outside, "seen.ts"), "utf8"), outsideSeed, "outside bytes untouched");
    assert.equal(h.session.registry.hasBufferContent(openAdmission.document.document_id), false);
    assert.equal(h.session.registry.hasBufferContent(createAdmission.document.document_id), false);
    proof("junction ancestry escapes are rejected (sentinel unchanged)");
  });

  it("P6.7 PROOF: symlink file targets are never opened (sentinel unchanged)", async () => {
    const h = openHarness(
      "p67-windows-link.json",
      [{ portable_path: "link.ts", kind: "regular_file", text: "do-not-touch" }],
      (leaf) => {
        const outside = join(TEST_ROOT, `${leaf.split("\\").pop()}-outside`);
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "sentinel.txt"), "do-not-touch", "utf8");
        symlinkSync(join(outside, "sentinel.txt"), join(leaf, "link.ts"), "file");
      },
    );
    const outside = join(TEST_ROOT, `${h.leaf.split("\\").pop()}-outside`);
    const admission = mustAdmit(h.session, LINK_OPEN);
    const opened = await executeAdmittedFileOpen(h.session, admission, { adapter: h.adapter, authority: authority(h) });
    assert.equal(opened.ok, false);
    if (opened.ok) throw new Error("unreachable");
    assert.equal(opened.rejection.code, "WORKSPACE_VIOLATION", "link targets are never followed");
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "do-not-touch", "outside sentinel untouched");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false);
    proof("symlink file targets are never opened (sentinel unchanged)");
  });

  it("P6.7 PROOF: pending create stays absent on the real disk (sentinel intact)", async () => {
    const alpha = "const alpha = 1;\n";
    const h = openHarness(
      "p67-open-create.json",
      [
        { portable_path: "src", kind: "directory" },
        { portable_path: "src/alpha.ts", kind: "regular_file", text: alpha },
      ],
      (leaf) => {
        mkdirSync(join(leaf, "src"), { recursive: true });
        writeFileSync(join(leaf, "src", "alpha.ts"), alpha, "utf8");
        writeFileSync(join(TEST_ROOT, `${leaf.split("\\").pop()}-sentinel.txt`), "do-not-touch", "utf8");
      },
    );
    const sentinel = join(TEST_ROOT, `${h.leaf.split("\\").pop()}-sentinel.txt`);
    const openAdmission = mustAdmit(h.session, A_OPEN);
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, { adapter: h.adapter, authority: authority(h) });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    assert.equal(readFileSync(join(h.leaf, "src", "alpha.ts"), "utf8"), opened.value.content, "open exposes committed bytes");
    const createAdmission = mustAdmit(h.session, A_CREATE);
    const created = await executeAdmittedFileCreate(h.session, createAdmission, { adapter: h.adapter, authority: authority(h) });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    assert.equal(existsSync(join(h.leaf, "src", "beta.ts")), false, "pending create does not appear on disk before save");
    assert.equal(readdirSync(h.staging).length, 0, "no staging residue");
    assert.equal(readFileSync(sentinel, "utf8"), "do-not-touch", "outside sentinel intact");
    proof("pending create stays absent on the real disk (sentinel intact)");
  });

  it("P6.7 PROOF: real missing open and existing create fail closed", async () => {
    const alpha = "const alpha = 1;\n";
    const beta = "// beta on disk\n";
    const h = openHarness(
      "p67-open-create.json",
      [
        { portable_path: "src", kind: "directory" },
        { portable_path: "src/alpha.ts", kind: "regular_file", text: alpha },
      ],
      (leaf) => {
        mkdirSync(join(leaf, "src"), { recursive: true });
        writeFileSync(join(leaf, "src", "alpha.ts"), alpha, "utf8");
      },
    );
    const openAdmission = mustAdmit(h.session, A_OPEN);
    rmSync(join(h.leaf, "src", "alpha.ts"));
    const missing = await executeAdmittedFileOpen(h.session, openAdmission, { adapter: h.adapter, authority: authority(h) });
    assert.equal(missing.ok, false);
    if (missing.ok) throw new Error("unreachable");
    assert.equal(missing.rejection.code, "FILE_NOT_FOUND", "missing open fails; never converts into create");
    const createAdmission = mustAdmit(h.session, A_CREATE);
    writeFileSync(join(h.leaf, "src", "beta.ts"), beta, "utf8");
    const collision = await executeAdmittedFileCreate(h.session, createAdmission, { adapter: h.adapter, authority: authority(h) });
    assert.equal(collision.ok, false);
    if (collision.ok) throw new Error("unreachable");
    assert.equal(collision.rejection.code, "FILE_EXISTS", "existing create fails; never overwrites");
    assert.equal(readFileSync(join(h.leaf, "src", "beta.ts"), "utf8"), beta, "existing bytes unchanged");
    assert.equal(existsSync(join(h.leaf, "src", "alpha.ts")), false, "missing file stays missing");
    proof("real missing open and existing create fail closed");
  });
});
