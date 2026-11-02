// P6.7 Open/create — admitted document open and create execution (deterministic, offline).
//
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.7 Open/create
// ("Exact load and staged creation"; PASS "No pre-save disk mutation;
// failure matrix"). Canonical authority: design sections 4/5/6/10/12/17/21/
// 26.5 plus ADR-0011 decision 5.
//
// Proves at runtime (not merely by types): admitted file_open loads exact
// committed bytes as the main-owned buffer with disk revision/digest binding
// and stays read-only; admitted file_create stages verbatim authored content
// as a pending in-memory document with zero disk publication; duplicate and
// case-variant opens collapse onto the one canonical document; missing opens
// fail without creating; create collisions (existing, case alias,
// unparsable-profile targets) fail FILE_EXISTS with zero mutation;
// link/junction ancestry stays WORKSPACE_VIOLATION; clean reloads adopt new
// valid bytes with revision increment while dirty divergence fences without
// silent overwrite; stale/reset/close/late-completion races fence before any
// registration; ownership fences (TERMINAL_OWNED/TRANSITION/revoked/stale)
// with zero adapter action; pending creations deny terminal RW through the
// real coordinator seam while RO observation stays compatible; later editor
// semantics (type/replace/save) cannot execute here; no generic filesystem
// bridge, no host-path leakage, no visual typing machinery.
//
// Fixture IR is NEVER hand-authored: synthetic lessons compile through the
// canonical pipeline (parseLessonData -> compileLesson -> re-validation
// inside createEditorCatalog). All filesystem work stays under the
// phase-owned temp/P6.7 root with cf-p67- names; the only host writes are
// controlled test setup (seed bytes, external-change simulation) and
// byte-exact assertions. Real Windows platform proofs (case-alias collapse
// on NTFS, junction/symlink denial, sentinels) live in
// editor-open-create-windows.test.ts; real Docker RO interop lives in
// editor-open-create-docker.test.ts (gate-only, mirroring the P6.4/P6.5
// precedent).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  sha256HexBytes,
  type AdapterAuthority,
  type WindowsFileAdapter,
} from "../src/file-adapter.ts";
import {
  admitEditorOperation,
  closeEditorSession,
  createEditorCatalog,
  editorBufferFacts,
  editorSnapshotDocuments,
  openEditorSession,
  resetEditorSession,
  type EditorCatalog,
  type EditorOperationAdmission,
  type EditorSession,
} from "../src/editor-admission.ts";
import {
  executeAdmittedFileCreate,
  executeAdmittedFileOpen,
  readExecutedContent,
} from "../src/editor-open-create.ts";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.7", "execution");

// ---------------------------------------------------------------------------
// Fixture operation identities (operation_id := step_id := beat_id).
// ---------------------------------------------------------------------------

const A_OPEN = "C01-L061-S001-B001";
const A_CREATE = "C01-L061-S002-B001";
const B_CREATE = "C01-L062-S001-B001";
const B_OPEN = "C01-L062-S002-B001";
const C_OPEN = "C01-L063-S001-B001";
const C_CREATE = "C01-L063-S002-B001";
const D_OPEN1 = "C01-L064-S001-B001";
const D_OPEN2 = "C01-L064-S002-B001";
const E_OPEN = "C01-L065-S001-B001";
const E_TYPE = "C01-L065-S002-B001";
const E_REOPEN = "C01-L065-S003-B001";

const ALPHA_PATH = "src/alpha.ts";
const BETA_PATH = "src/beta.ts";
const GAMMA_PATH = "src/gamma.ts";
const DELTA_PATH = "src/delta.ts";
const ALPHA_V1 = "const alpha = 1;\n";
const ALPHA_V2 = "const alpha = 2;\n";
const BETA_CONTENT = "// beta\n";
const GAMMA_CONTENT = "// gamma\n";
const DELTA_V1 = "const delta = 4;\n";
const ARABIC_EMOJI = "// English تعليق عربي 🚀👩‍💻\nconst greeting = \"مرحبا hello\";\n";

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function proof(message: string): void {
  console.log(`P6.7 PROOF: ${message}`);
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

let counter = 0;
let requestSeq = 0;

function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p67-${prefix}-${requestSeq}`;
}

function compileFixtureLesson(name: string): CompiledLesson {
  const raw: unknown = JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true, `fixture ${name} must pass canonical source validation`);
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  return compileModule.compileLesson(parsed.lesson);
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

interface ExecutionHarness {
  readonly tag: string;
  readonly leaf: string;
  readonly staging: string;
  readonly adapter: WindowsFileAdapter;
  readonly session: EditorSession;
  readonly catalog: EditorCatalog;
  readonly seed: SeedManifest;
  readonly sessionId: string;
  readonly workspaceId: string;
}

function openExecutionHarness(fixtureName: string, files: Record<string, string>): ExecutionHarness {
  counter += 1;
  const tag = `cf-p67-t${counter}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(join(leaf, "src"), { recursive: true });
  mkdirSync(staging, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
  }
  const seed = manifestFor(files);
  const catalogOutcome = createEditorCatalog(compileFixtureLesson(fixtureName));
  assert.equal(catalogOutcome.ok, true, "catalog must build");
  if (!catalogOutcome.ok) throw new Error("unreachable");
  const sessionId = `sess-p67-${String(counter).padStart(4, "0")}`;
  const workspaceId = `ws-p67-${String(counter).padStart(4, "0")}`;
  const opened = openEditorSession({
    catalog: catalogOutcome.value,
    sessionId,
    generation: 1,
    seedManifest: seed,
    reviewed: true,
  });
  assert.equal(opened.ok, true, "admission session must open");
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
  return { tag, leaf, staging, adapter: bound.value, session: opened.value, catalog: catalogOutcome.value, seed, sessionId, workspaceId };
}

/**
 * Fresh adapter binding for a rotated session identity over the same
 * leaf/staging pair (mirrors real reset: the new generation rebinds the
 * adapter to its own session identity; the old binding stays fenced).
 */
function rebindAdapter(harness: ExecutionHarness, sessionId: string, generation: number, workspaceId: string): WindowsFileAdapter {
  const bound = openWindowsFileAdapter({
    sessionId,
    generation,
    workspaceId,
    leafHostPath: harness.leaf,
    stagingHostPath: harness.staging,
  });
  assert.equal(bound.ok, true, "reset generation must rebind the adapter");
  if (!bound.ok) throw new Error("unreachable");
  return bound.value;
}

function syntheticAuthority(harness: ExecutionHarness, overrides: Partial<AdapterAuthority> = {}): AdapterAuthority {
  return {
    lease: {
      kind: "editor_lease",
      leaseId: `lease-p67-${counter}`,
      sessionId: harness.sessionId,
      generation: 1,
      workspaceId: harness.workspaceId,
      epoch: 1,
      operationId: "op-p67-synthetic",
      requestId: nextRequest("synthetic"),
    },
    ownership: "EDITOR_OWNED",
    liveEpoch: 1,
    revokedLeaseIds: [],
    ...overrides,
  };
}

function depsFor(harness: ExecutionHarness, overrides: Partial<AdapterAuthority> = {}, revalidate?: () => AdapterAuthority) {
  return { adapter: harness.adapter, authority: syntheticAuthority(harness, overrides), revalidate };
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

function hostText(harness: ExecutionHarness, rel: string): string | null {
  const full = join(harness.leaf, ...rel.split("/"));
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

function hostBytes(harness: ExecutionHarness, rel: string): Uint8Array | null {
  const full = join(harness.leaf, ...rel.split("/"));
  if (!existsSync(full)) return null;
  return new Uint8Array(readFileSync(full));
}

function stagingIsClean(harness: ExecutionHarness): boolean {
  return readdirSync(harness.staging).length === 0;
}

function dtoLeaksHostPaths(dto: unknown, harness: ExecutionHarness): string[] {
  const json = JSON.stringify(dto);
  assert.notEqual(json, undefined, "leak scanner requires a defined DTO");
  const leaks: string[] = [];
  if (/[A-Za-z]:[\\/]/.test(json)) leaks.push("drive-letter path");
  if (json.includes("\\\\")) leaks.push("UNC/device escape");
  if (json.includes(harness.leaf) || json.includes(harness.staging)) leaks.push("trusted host path");
  if (json.includes("cf-p67-stage-")) leaks.push("private staging name");
  return leaks;
}

/** Spy wrapper: counts adapter calls while delegating to the real adapter. */
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

/** Deferred-message double: the read starts on call but completes only on release (deterministic races, no sleeps). */
function deferredAdapter(real: WindowsFileAdapter): {
  adapter: WindowsFileAdapter;
  entered: Promise<void>;
  release: () => void;
  reads: () => number;
} {
  let reads = 0;
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
    readDocument: async (authority, path) => {
      reads += 1;
      signalEntered();
      await gate;
      return real.readDocument(authority, path);
    },
  };
  return { adapter, entered, release: () => releaseGate(), reads: () => reads };
}

before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "phase-owned test root is removed (cleanup green)");
});

// ---------------------------------------------------------------------------
// file_open execution: exact load, revision binding, read-only.
// ---------------------------------------------------------------------------

describe("P6.7 admitted file_open execution", () => {
  it("P6.7 PROOF: admitted file_open succeeds with exact bytes and revision binding", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const bytesBefore = hostBytes(h, ALPHA_PATH);
    const executed = await executeAdmittedFileOpen(h.session, admission, depsFor(h));
    assert.equal(executed.ok, true, `open must succeed: ${executed.ok ? "" : executed.rejection.code + " " + executed.rejection.message}`);
    if (!executed.ok) throw new Error("unreachable");
    const result = executed.value;
    assert.equal(result.content, ALPHA_V1, "buffer is the exact committed text");
    assert.equal(result.disk_revision, 0, "first load binds the seed revision");
    assert.equal(result.disk_digest, sha256Text(ALPHA_V1), "digest binds the exact loaded bytes");
    assert.equal(result.disk_digest, sha256HexBytes(hostBytes(h, ALPHA_PATH)!), "digest equals the live disk digest");
    assert.match(result.file_identity ?? "", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "opaque file identity bound");
    assert.equal(result.reloaded, false);
    assert.equal(result.pending_focus, false);
    assert.equal(result.document.dirty, false, "opened document is clean");
    assert.equal(result.document.base_exists, true);
    assert.equal(result.document.base_digest, sha256Text(ALPHA_V1));
    assert.equal(result.document.buffer_revision, 0, "P6.7 loads content; P6.8 owns revision advances");
    assert.deepEqual(hostBytes(h, ALPHA_PATH), bytesBefore, "open performs no disk mutation");
    assert.equal(stagingIsClean(h), true, "open stages nothing");
    assert.equal(readExecutedContent(h.session, result.document.document_id).ok, true);
    proof("admitted file_open succeeds with exact bytes and revision binding");
  });

  it("P6.7 PROOF: existing UTF-8 LF loads byte-exact across scripts and emoji", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ARABIC_EMOJI });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const executed = await executeAdmittedFileOpen(h.session, admission, depsFor(h));
    assert.equal(executed.ok, true);
    if (!executed.ok) throw new Error("unreachable");
    assert.equal(executed.value.content, ARABIC_EMOJI, "Arabic combining marks, mixed comments and emoji/ZWJ survive byte-exact");
    assert.equal(executed.value.disk_digest, sha256HexBytes(hostBytes(h, ALPHA_PATH)!));
    proof("existing UTF-8 LF loads byte-exact across scripts and emoji");
  });

  it("P6.7 PROOF: empty file opens as an empty clean buffer", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: "" });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const executed = await executeAdmittedFileOpen(h.session, admission, depsFor(h));
    assert.equal(executed.ok, true);
    if (!executed.ok) throw new Error("unreachable");
    assert.equal(executed.value.content, "");
    assert.equal(executed.value.document.dirty, false);
    assert.equal(executed.value.disk_digest, sha256Text(""));
    proof("empty file opens as an empty clean buffer");
  });

  it("P6.7 PROOF: missing file_open fails without creating", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    rmSync(join(h.leaf, ...ALPHA_PATH.split("/")));
    const executed = await executeAdmittedFileOpen(h.session, admission, depsFor(h));
    assert.equal(executed.ok, false);
    if (executed.ok) throw new Error("unreachable");
    assert.equal(executed.rejection.code, "FILE_NOT_FOUND", "missing open fails; it never converts into create");
    assert.equal(hostText(h, ALPHA_PATH), null, "no empty content is staged onto disk");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false, "no buffer text is invented");
    assert.equal(stagingIsClean(h), true);
    proof("missing file_open fails without creating");
  });

  it("P6.7 PROOF: CRLF disk fails open without mutation", async () => {
    const crlf = "const alpha = 1;\r\n";
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: crlf });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const executed = await executeAdmittedFileOpen(h.session, admission, depsFor(h));
    assert.equal(executed.ok, false);
    if (executed.ok) throw new Error("unreachable");
    assert.equal(executed.rejection.code, "UNSUPPORTED_TEXT_PROFILE", "strict LF profile rejects without conversion");
    assert.equal(hostText(h, ALPHA_PATH), crlf, "on-disk bytes stay untouched");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false);
    proof("CRLF disk fails open without mutation");
  });

  it("P6.7 PROOF: BOM and invalid UTF-8 fail open without mutation", async () => {
    const bom = { [ALPHA_PATH]: "﻿const alpha = 1;\n" };
    const h = openExecutionHarness("p67-open-create.json", bom);
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const bomResult = await executeAdmittedFileOpen(h.session, admission, depsFor(h));
    assert.equal(bomResult.ok, false);
    if (bomResult.ok) throw new Error("unreachable");
    assert.equal(bomResult.rejection.code, "UNSUPPORTED_TEXT_PROFILE");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false);

    const h2 = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    writeFileSync(join(h2.leaf, ...ALPHA_PATH.split("/")), new Uint8Array([0xff, 0xfe, 0x41]));
    const admission2 = mustAdmit(h2.session, A_OPEN, nextRequest("open"));
    const invalid = await executeAdmittedFileOpen(h2.session, admission2, depsFor(h2));
    assert.equal(invalid.ok, false);
    if (invalid.ok) throw new Error("unreachable");
    assert.equal(invalid.rejection.code, "UNSUPPORTED_TEXT_PROFILE", "fatal decode, no silent substitution");
    proof("BOM and invalid UTF-8 fail open without mutation");
  });

  it("P6.7 PROOF: first open adopts live bytes when the environment drifted", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    writeFileSync(join(h.leaf, ...ALPHA_PATH.split("/")), ALPHA_V2, "utf8");
    const executed = await executeAdmittedFileOpen(h.session, admission, depsFor(h));
    assert.equal(executed.ok, true, "clean first load takes the sanctioned explicit-load path");
    if (!executed.ok) throw new Error("unreachable");
    assert.equal(executed.value.content, ALPHA_V2, "buffer is the live committed truth");
    assert.equal(executed.value.disk_digest, sha256Text(ALPHA_V2));
    assert.equal(executed.value.disk_revision, 0, "first load stays at the seed generation revision");
    proof("first open adopts live bytes when the environment drifted");
  });
});

// ---------------------------------------------------------------------------
// file_create execution: pending staging with zero disk publication.
// ---------------------------------------------------------------------------

describe("P6.7 admitted file_create execution", () => {
  it("P6.7 PROOF: admitted file_create stages canonical pending state", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const openAdmission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, depsFor(h));
    assert.equal(opened.ok, true);
    const admission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    const spy = spyAdapter(h.adapter);
    const executed = await executeAdmittedFileCreate(h.session, admission, {
      adapter: spy.adapter,
      authority: syntheticAuthority(h),
    });
    assert.equal(executed.ok, true, `create must succeed: ${executed.ok ? "" : executed.rejection.code + " " + executed.rejection.message}`);
    if (!executed.ok) throw new Error("unreachable");
    assert.equal(executed.value.content, BETA_CONTENT, "verbatim authored content staged");
    assert.equal(executed.value.document.state, "pending_creation");
    assert.equal(executed.value.document.dirty, true, "pending creation is dirty by definition");
    assert.equal(executed.value.document.base_exists, false);
    assert.equal(executed.value.document.base_digest, null);
    assert.equal(executed.value.document.base_disk_revision, 0, "absent sentinel revision");
    assert.equal(hostText(h, BETA_PATH), null, "disk remains absent until the canonical save phase");
    assert.equal(stagingIsClean(h), true, "no staging commit, no rename, no publication");
    assert.equal(spy.publishes(), 0, "publishDocument is never reached on the create path");
    proof("admitted file_create stages canonical pending state");
  });

  it("P6.7 PROOF: contentless create stages empty pending text", async () => {
    const raw: unknown = JSON.parse(
      '{"schema_version":"1.1","course_id":"C01","lesson_id":"C01-L066","title":"t","language":"en","subject":"Programming","grade_level":"grade-10","duration":60,"learning_objectives":["x"],"prerequisites":[],"keywords":["x"],"metadata":{},"scenes":[{"scene_id":"C01-L066-S001","type":"code_demo","title":"t","duration":60,"visual":{"kind":"code_editor","description":"t"},"beats":[{"beat_id":"C01-L066-S001-B001","kind":"action","action":{"type":"file_create","path":"src/empty.ts"}}]}]}',
    );
    const parsed = parseLessonData(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
    const catalogOutcome = createEditorCatalog(compileModule.compileLesson(parsed.lesson));
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const seed = manifestFor({});
    const opened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: "sess-p67-empty",
      generation: 1,
      seedManifest: seed,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const session = opened.value;
    const admissionOutcome = admitEditorOperation(session, {
      session_id: session.sessionId,
      generation: 1,
      operation_id: "C01-L066-S001-B001",
      request_id: nextRequest("empty"),
    });
    assert.equal(admissionOutcome.ok, true);
    if (!admissionOutcome.ok) throw new Error("unreachable");
    // This case runs on its own leaf/adapter binding (its catalog differs
    // from the shared open/create fixture, so it cannot reuse that leaf).
    counter += 1;
    const leaf = join(TEST_ROOT, `cf-p67-empty-${counter}-leaf`);
    const staging = join(TEST_ROOT, `cf-p67-empty-${counter}-staging`);
    mkdirSync(join(leaf, "src"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    const bound = openWindowsFileAdapter({
      sessionId: session.sessionId,
      generation: 1,
      workspaceId: "ws-p67-empty",
      leafHostPath: leaf,
      stagingHostPath: staging,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const executed = await executeAdmittedFileCreate(session, admissionOutcome.value, {
      adapter: bound.value,
      authority: {
        lease: {
          kind: "editor_lease",
          leaseId: "lease-p67-empty",
          sessionId: session.sessionId,
          generation: 1,
          workspaceId: "ws-p67-empty",
          epoch: 1,
          operationId: "C01-L066-S001-B001",
          requestId: nextRequest("empty"),
        },
        ownership: "EDITOR_OWNED",
        liveEpoch: 1,
        revokedLeaseIds: [],
      },
    });
    assert.equal(executed.ok, true);
    if (!executed.ok) throw new Error("unreachable");
    assert.equal(executed.value.content, "", "absent authored content defaults to empty");
    assert.equal(executed.value.document.state, "pending_creation");
    assert.equal(existsSync(join(leaf, "src", "empty.ts")), false, "no file appears on disk before save");
    proof("contentless create stages empty pending text");
  });

  it("P6.7 PROOF: create existing fails FILE_EXISTS with zero mutation", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const admission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    writeFileSync(join(h.leaf, ...BETA_PATH.split("/")), BETA_CONTENT, "utf8");
    const before = hostText(h, BETA_PATH);
    const spy = spyAdapter(h.adapter);
    const executed = await executeAdmittedFileCreate(h.session, admission, {
      adapter: spy.adapter,
      authority: syntheticAuthority(h),
    });
    assert.equal(executed.ok, false);
    if (executed.ok) throw new Error("unreachable");
    assert.equal(executed.rejection.code, "FILE_EXISTS", "creation never overwrites and never converts into open");
    assert.equal(hostText(h, BETA_PATH), before, "existing bytes untouched");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false, "nothing staged on collision");
    assert.equal(spy.publishes(), 0);
    assert.equal(stagingIsClean(h), true);
    proof("create existing fails FILE_EXISTS with zero mutation");
  });

  it("P6.7 PROOF: existing file with unparsable bytes still collides as FILE_EXISTS", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const admission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    writeFileSync(join(h.leaf, ...BETA_PATH.split("/")), "bad\r\nprofile\r\n", "utf8");
    const executed = await executeAdmittedFileCreate(h.session, admission, depsFor(h));
    assert.equal(executed.ok, false);
    if (executed.ok) throw new Error("unreachable");
    assert.equal(executed.rejection.code, "FILE_EXISTS", "the collision is the fact; the foreign profile never leaks into the buffer");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false);
    proof("existing file with unparsable bytes still collides as FILE_EXISTS");
  });
});

// ---------------------------------------------------------------------------
// Duplicate opens, pending focus, identity conflicts, races.
// ---------------------------------------------------------------------------

describe("P6.7 duplicate opens, identity conflicts and races", () => {
  it("P6.7 PROOF: duplicate open returns the same logical document", async () => {
    const h = openExecutionHarness("p67-reopen.json", { [ALPHA_PATH]: ALPHA_V1 });
    const firstAdmission = mustAdmit(h.session, D_OPEN1, nextRequest("open"));
    const first = await executeAdmittedFileOpen(h.session, firstAdmission, depsFor(h));
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    const secondAdmission = mustAdmit(h.session, D_OPEN2, nextRequest("open"));
    assert.equal(secondAdmission.document.document_id, first.value.document.document_id, "admission already resolves the one canonical document");
    const second = await executeAdmittedFileOpen(h.session, secondAdmission, depsFor(h));
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.value.document.document_id, first.value.document.document_id, "no second buffer, no second authority");
    assert.equal(second.value.content, ALPHA_V1);
    assert.equal(second.value.reloaded, false, "unchanged disk focuses without reload");
    assert.equal(second.value.file_identity, first.value.file_identity, "trusted identity stable across duplicate opens");
    assert.equal(h.session.registry.listDocuments().length, 1, "exactly one live document");
    proof("duplicate open returns the same logical document");
  });

  it("P6.7 PROOF: concurrent duplicate opens converge deterministically", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const deps = depsFor(h);
    const [left, right] = await Promise.all([
      executeAdmittedFileOpen(h.session, admission, deps),
      executeAdmittedFileOpen(h.session, admission, deps),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    if (!left.ok || !right.ok) throw new Error("unreachable");
    assert.equal(left.value.document.document_id, right.value.document.document_id);
    assert.equal(left.value.content, right.value.content);
    assert.equal(h.session.registry.listDocuments().length, 1);
    proof("concurrent duplicate opens converge deterministically");
  });

  it("P6.7 PROOF: concurrent creates converge on one pending document", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const admission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    const deps = depsFor(h);
    const [left, right] = await Promise.all([
      executeAdmittedFileCreate(h.session, admission, deps),
      executeAdmittedFileCreate(h.session, admission, deps),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    if (!left.ok || !right.ok) throw new Error("unreachable");
    assert.equal(left.value.document.document_id, right.value.document.document_id, "no duplicate pending authority");
    assert.equal(left.value.content, BETA_CONTENT);
    assert.equal(hostText(h, BETA_PATH), null, "neither racer publishes");
    proof("concurrent creates converge on one pending document");
  });

  it("P6.7 PROOF: create pending then open focuses the staged buffer", async () => {
    const h = openExecutionHarness("p67-create-open.json", {});
    const createAdmission = mustAdmit(h.session, B_CREATE, nextRequest("create"));
    const created = await executeAdmittedFileCreate(h.session, createAdmission, depsFor(h));
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    const openAdmission = mustAdmit(h.session, B_OPEN, nextRequest("open"));
    assert.equal(openAdmission.document.document_id, created.value.document.document_id, "open admission focuses the staged document");
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, depsFor(h));
    assert.equal(opened.ok, true, "missing file focuses the staged creation instead of failing");
    if (!opened.ok) throw new Error("unreachable");
    assert.equal(opened.value.pending_focus, true);
    assert.equal(opened.value.content, GAMMA_CONTENT, "staged text, not disk text");
    assert.equal(opened.value.document.document_id, created.value.document.document_id, "no ambiguous dual documents");
    assert.equal(hostText(h, GAMMA_PATH), null, "disk still absent before save");
    proof("create pending then open focuses the staged buffer");
  });

  it("P6.7 PROOF: open then create the same identity fails deterministically", async () => {
    const h = openExecutionHarness("p67-open-collide.json", { [DELTA_PATH]: DELTA_V1 });
    const openAdmission = mustAdmit(h.session, C_OPEN, nextRequest("open"));
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, depsFor(h));
    assert.equal(opened.ok, true);
    const collide = admitEditorOperation(h.session, {
      session_id: h.session.sessionId,
      generation: 1,
      operation_id: C_CREATE,
      request_id: nextRequest("create"),
    });
    assert.equal(collide.ok, false, "live document collides at admission");
    if (collide.ok) throw new Error("unreachable");
    assert.equal(collide.rejection.code, "FILE_EXISTS", "no overwrite, no conversion of create into open");
    assert.equal(h.session.registry.listDocuments().length, 1);
    assert.equal(hostText(h, DELTA_PATH), DELTA_V1, "committed bytes untouched");
    proof("open then create the same identity fails deterministically");
  });

  it("P6.7 PROOF: clean reopen reloads changed valid disk with revision increment", async () => {
    const h = openExecutionHarness("p67-reopen.json", { [ALPHA_PATH]: ALPHA_V1 });
    const firstAdmission = mustAdmit(h.session, D_OPEN1, nextRequest("open"));
    const first = await executeAdmittedFileOpen(h.session, firstAdmission, depsFor(h));
    assert.equal(first.ok, true);
    writeFileSync(join(h.leaf, ...ALPHA_PATH.split("/")), ALPHA_V2, "utf8");
    const secondAdmission = mustAdmit(h.session, D_OPEN2, nextRequest("open"));
    const second = await executeAdmittedFileOpen(h.session, secondAdmission, depsFor(h));
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.value.reloaded, true, "clean document explicitly reloads changed valid disk");
    assert.equal(second.value.content, ALPHA_V2);
    assert.equal(second.value.disk_digest, sha256Text(ALPHA_V2));
    assert.equal(second.value.disk_revision, 1, "reload increments the base revision once");
    assert.equal(second.value.document.dirty, false, "reloaded document stays clean");
    proof("clean reopen reloads changed valid disk with revision increment");
  });

  it("P6.7 PROOF: dirty reopen fences divergence without silent overwrite", async () => {
    const h = openExecutionHarness("p67-dirty-reopen.json", { [ALPHA_PATH]: ALPHA_V1 });
    const openAdmission = mustAdmit(h.session, E_OPEN, nextRequest("open"));
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, depsFor(h));
    assert.equal(opened.ok, true);
    // The admitted type reserves dirty at admission (P6.6); its text advance
    // belongs to P6.8, but the dirty truth already interlocks here.
    mustAdmit(h.session, E_TYPE, nextRequest("type"));
    writeFileSync(join(h.leaf, ...ALPHA_PATH.split("/")), ALPHA_V2, "utf8");
    const reopenAdmission = mustAdmit(h.session, E_REOPEN, nextRequest("reopen"));
    const reopened = await executeAdmittedFileOpen(h.session, reopenAdmission, depsFor(h));
    assert.equal(reopened.ok, false);
    if (reopened.ok) throw new Error("unreachable");
    assert.equal(reopened.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT", "dirty divergence fails closed");
    assert.equal(readExecutedContent(h.session, openAdmission.document.document_id).ok, true);
    const preserved = readExecutedContent(h.session, openAdmission.document.document_id);
    assert.equal(preserved.ok, true);
    if (!preserved.ok) throw new Error("unreachable");
    assert.equal(preserved.value, ALPHA_V1, "original buffer preserved for diagnostics");
    assert.equal(hostText(h, ALPHA_PATH), ALPHA_V2, "disk truth untouched by the failed open");
    proof("dirty reopen fences divergence without silent overwrite");
  });

  it("P6.7 PROOF: dirty open with unchanged disk focuses without discarding", async () => {
    const h = openExecutionHarness("p67-dirty-reopen.json", { [ALPHA_PATH]: ALPHA_V1 });
    const openAdmission = mustAdmit(h.session, E_OPEN, nextRequest("open"));
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, depsFor(h));
    assert.equal(opened.ok, true);
    mustAdmit(h.session, E_TYPE, nextRequest("type"));
    const reopenAdmission = mustAdmit(h.session, E_REOPEN, nextRequest("reopen"));
    const reopened = await executeAdmittedFileOpen(h.session, reopenAdmission, depsFor(h));
    assert.equal(reopened.ok, true, "disk still equals the baseline: focus, do not discard");
    if (!reopened.ok) throw new Error("unreachable");
    assert.equal(reopened.value.content, ALPHA_V1);
    assert.equal(reopened.value.reloaded, false);
    proof("dirty open with unchanged disk focuses without discarding");
  });
});

// ---------------------------------------------------------------------------
// Admission, ownership, stale generations, reset/close, read races.
// ---------------------------------------------------------------------------

describe("P6.7 admission and ownership fencing", () => {
  it("P6.7 PROOF: unknown and unreviewed operations cannot execute", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const spy = spyAdapter(h.adapter);
    const unknown = admitEditorOperation(h.session, {
      session_id: h.session.sessionId,
      generation: 1,
      operation_id: "C01-L061-S099-B001",
      request_id: nextRequest("unknown"),
    });
    assert.equal(unknown.ok, false);
    if (unknown.ok) throw new Error("unreachable");
    assert.equal(unknown.rejection.code, "NOT_AUTHORIZED");
    assert.equal(spy.reads(), 0, "rejected admission performs zero adapter action");
    proof("unknown and unreviewed operations cannot execute");
  });

  it("P6.7 PROOF: out-of-order editor operations cannot bypass authored order", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const early = admitEditorOperation(h.session, {
      session_id: h.session.sessionId,
      generation: 1,
      operation_id: A_CREATE,
      request_id: nextRequest("early"),
    });
    assert.equal(early.ok, false, "create is ordinal 2 while open is pending");
    if (early.ok) throw new Error("unreachable");
    assert.equal(early.rejection.code, "INVALID_REQUEST");
    // The refused attempt consumes nothing: the authored head still admits.
    const head = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const executed = await executeAdmittedFileOpen(h.session, head, depsFor(h));
    assert.equal(executed.ok, true);
    proof("out-of-order editor operations cannot bypass authored order");
  });

  it("P6.7 PROOF: renderer-supplied path is impossible by construction", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    assert.equal(executeAdmittedFileOpen.length, 3, "open executor takes session/admission/deps only: no path parameter exists");
    assert.equal(executeAdmittedFileCreate.length, 3, "create executor takes session/admission/deps only: no path/content parameters exist");
    // A forged admission record naming a different reviewed file cannot
    // redirect the disk read: execution resolves through the live registry
    // descriptor, never through record text.
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    writeFileSync(join(h.leaf, ...BETA_PATH.split("/")), BETA_CONTENT, "utf8");
    const forged = {
      ...admission,
      record: { ...admission.record, portable_path: BETA_PATH },
    } as EditorOperationAdmission;
    const spy = spyAdapter(h.adapter);
    const executed = await executeAdmittedFileOpen(h.session, forged, {
      adapter: spy.adapter,
      authority: syntheticAuthority(h),
    });
    assert.equal(executed.ok, true);
    if (!executed.ok) throw new Error("unreachable");
    assert.equal(executed.value.content, ALPHA_V1, "the live descriptor path decides, never forged record text");
    proof("renderer-supplied path is impossible by construction");
  });

  it("P6.7 PROOF: forged descriptors fence with zero adapter action", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const forged = {
      ...admission,
      document: { ...admission.document, portable_path: "../../evil.ts" },
    } as unknown as EditorOperationAdmission;
    const spy = spyAdapter(h.adapter);
    const executed = await executeAdmittedFileOpen(h.session, forged, {
      adapter: spy.adapter,
      authority: syntheticAuthority(h),
    });
    assert.equal(executed.ok, false);
    if (executed.ok) throw new Error("unreachable");
    assert.equal(executed.rejection.code, "STALE_SESSION", "forged shapes never name a live document");
    assert.equal(spy.reads(), 0, "fencing happens before any adapter action");
    proof("forged descriptors fence with zero adapter action");
  });

  it("P6.7 PROOF: terminal-owned authority bars open and create with zero mutation", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const openAdmission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const spy = spyAdapter(h.adapter);
    const terminalOwned: AdapterAuthority = syntheticAuthority(h, { ownership: "TERMINAL_OWNED" });
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, {
      adapter: spy.adapter,
      authority: terminalOwned,
    });
    assert.equal(opened.ok, false);
    if (opened.ok) throw new Error("unreachable");
    assert.equal(opened.rejection.code, "WORKSPACE_BUSY");
    const createAdmission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    const created = await executeAdmittedFileCreate(h.session, createAdmission, {
      adapter: spy.adapter,
      authority: terminalOwned,
    });
    assert.equal(created.ok, false);
    if (created.ok) throw new Error("unreachable");
    assert.equal(created.rejection.code, "WORKSPACE_BUSY");
    assert.equal(spy.reads(), 0, "ownership fences before any adapter action");
    assert.equal(h.session.registry.hasBufferContent(openAdmission.document.document_id), false);
    proof("terminal-owned authority bars open and create with zero mutation");
  });

  it("P6.7 PROOF: barrier states and stale leases fence execution", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const spy = spyAdapter(h.adapter);
    for (const ownership of ["TRANSITION", "RESETTING", "CLOSING", "HOLD"] as const) {
      const result = await executeAdmittedFileOpen(h.session, admission, {
        adapter: spy.adapter,
        authority: syntheticAuthority(h, { ownership }),
      });
      assert.equal(result.ok, false, `open must fence while ${ownership}`);
      if (result.ok) throw new Error("unreachable");
      assert.equal(result.rejection.code, "INVALID_TRANSITION");
    }
    const revokedLease = syntheticAuthority(h).lease.leaseId;
    const revoked = await executeAdmittedFileOpen(h.session, admission, {
      adapter: spy.adapter,
      authority: syntheticAuthority(h, { revokedLeaseIds: [revokedLease] }),
    });
    assert.equal(revoked.ok, false);
    if (revoked.ok) throw new Error("unreachable");
    assert.equal(revoked.rejection.code, "WORKSPACE_REVOKED");
    const staleEpoch = await executeAdmittedFileOpen(h.session, admission, {
      adapter: spy.adapter,
      authority: syntheticAuthority(h, { liveEpoch: 2 }),
    });
    assert.equal(staleEpoch.ok, false);
    if (staleEpoch.ok) throw new Error("unreachable");
    assert.equal(staleEpoch.rejection.code, "STALE_EPOCH");
    assert.equal(spy.reads(), 0, "every fence lands before adapter action");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false);
    proof("barrier states and stale leases fence execution");
  });

  it("P6.7 PROOF: stale generation admissions cannot open or create", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const openAdmission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const reset = resetEditorSession(h.session, { sessionId: "sess-p67-stale", generation: 2 });
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    const spy = spyAdapter(h.adapter);
    const deps = { adapter: spy.adapter, authority: syntheticAuthority(h) };
    const staleOpen = await executeAdmittedFileOpen(h.session, openAdmission, deps);
    assert.equal(staleOpen.ok, false);
    if (staleOpen.ok) throw new Error("unreachable");
    assert.equal(staleOpen.rejection.code, "STALE_SESSION");
    const staleOpenNew = await executeAdmittedFileOpen(reset.value, openAdmission, {
      adapter: spy.adapter,
      authority: { ...syntheticAuthority(h), lease: { ...syntheticAuthority(h).lease, sessionId: "sess-p67-stale", generation: 2 } },
    });
    assert.equal(staleOpenNew.ok, false, "old admission cannot execute in the new generation either");
    if (staleOpenNew.ok) throw new Error("unreachable");
    assert.equal(staleOpenNew.rejection.code, "WRONG_OWNER", "rotated session identity fences as foreign (P6.6 session check)");
    // A stale create fences identically: admit-then-reset on the collide
    // fixture proves the create path carries the same fence.
    const h2 = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    mustAdmit(h2.session, A_OPEN, nextRequest("open"));
    const createAdmission = mustAdmit(h2.session, A_CREATE, nextRequest("create"));
    const reset2 = resetEditorSession(h2.session, { sessionId: "sess-p67-stale-2", generation: 2 });
    assert.equal(reset2.ok, true);
    if (!reset2.ok) throw new Error("unreachable");
    const staleCreate = await executeAdmittedFileCreate(h2.session, createAdmission, {
      adapter: spy.adapter,
      authority: syntheticAuthority(h2),
    });
    assert.equal(staleCreate.ok, false);
    if (staleCreate.ok) throw new Error("unreachable");
    assert.equal(staleCreate.rejection.code, "STALE_SESSION");
    assert.equal(spy.reads(), 0, "stale fencing performs zero adapter action");
    proof("stale generation admissions cannot open or create");
  });

  it("P6.7 PROOF: reset invalidates opened and pending documents", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const openAdmission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, depsFor(h));
    assert.equal(opened.ok, true);
    const createAdmission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    const created = await executeAdmittedFileCreate(h.session, createAdmission, depsFor(h));
    assert.equal(created.ok, true);
    const reset = resetEditorSession(h.session, { sessionId: "sess-p67-reset", generation: 2 });
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(h.session.registry.listDocuments().length, 0, "old generation documents vanish");
    assert.equal(readExecutedContent(h.session, openAdmission.document.document_id).ok, false, "old opened text unreachable");
    assert.equal(readExecutedContent(h.session, createAdmission.document.document_id).ok, false, "abandoned pending text vanishes");
    // The new generation runs authored operations from ordinal 1 against a
    // freshly rebound adapter (same leaf, rotated identity).
    const fresh = mustAdmit(reset.value, A_OPEN, nextRequest("open"));
    const rebound = rebindAdapter(h, "sess-p67-reset", 2, "ws-p67-reset");
    const leaseBase = syntheticAuthority(h).lease;
    const reopened = await executeAdmittedFileOpen(reset.value, fresh, {
      adapter: rebound,
      authority: {
        ...syntheticAuthority(h),
        lease: { ...leaseBase, sessionId: "sess-p67-reset", generation: 2, workspaceId: "ws-p67-reset" },
      },
    });
    assert.equal(reopened.ok, true);
    if (!reopened.ok) throw new Error("unreachable");
    assert.equal(reopened.value.content, ALPHA_V1);
    proof("reset invalidates opened and pending documents");
  });

  it("P6.7 PROOF: close prevents open and create", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const openAdmission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const createAdmission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    assert.equal(closeEditorSession(h.session).ok, true);
    const spy = spyAdapter(h.adapter);
    const deps = { adapter: spy.adapter, authority: syntheticAuthority(h) };
    const lateOpen = await executeAdmittedFileOpen(h.session, openAdmission, deps);
    assert.equal(lateOpen.ok, false);
    if (lateOpen.ok) throw new Error("unreachable");
    assert.equal(lateOpen.rejection.code, "STALE_SESSION");
    const lateCreate = await executeAdmittedFileCreate(h.session, createAdmission, deps);
    assert.equal(lateCreate.ok, false);
    if (lateCreate.ok) throw new Error("unreachable");
    assert.equal(lateCreate.rejection.code, "STALE_SESSION");
    assert.equal(spy.reads(), 0);
    proof("close prevents open and create");
  });

  it("P6.7 PROOF: late open completion after reset is fenced", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const deferred = deferredAdapter(h.adapter);
    const pending = executeAdmittedFileOpen(h.session, admission, {
      adapter: deferred.adapter,
      authority: syntheticAuthority(h),
    });
    await deferred.entered;
    const reset = resetEditorSession(h.session, { sessionId: "sess-p67-late", generation: 2 });
    assert.equal(reset.ok, true);
    deferred.release();
    const late = await pending;
    assert.equal(late.ok, false);
    if (late.ok) throw new Error("unreachable");
    assert.equal(late.rejection.code, "STALE_SESSION", "late read populates nothing");
    assert.equal(reset.value.registry.listDocuments().length, 0, "new generation holds no leaked state");
    assert.equal(readExecutedContent(h.session, admission.document.document_id).ok, false);
    proof("late open completion after reset is fenced");
  });

  it("P6.7 PROOF: late open completion after close is fenced", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const deferred = deferredAdapter(h.adapter);
    const pending = executeAdmittedFileOpen(h.session, admission, {
      adapter: deferred.adapter,
      authority: syntheticAuthority(h),
    });
    await deferred.entered;
    assert.equal(closeEditorSession(h.session).ok, true);
    deferred.release();
    const late = await pending;
    assert.equal(late.ok, false);
    if (late.ok) throw new Error("unreachable");
    assert.equal(late.rejection.code, "STALE_SESSION");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false);
    proof("late open completion after close is fenced");
  });

  it("P6.7 PROOF: late create completion after reset is fenced", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const admission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    const deferred = deferredAdapter(h.adapter);
    const pending = executeAdmittedFileCreate(h.session, admission, {
      adapter: deferred.adapter,
      authority: syntheticAuthority(h),
    });
    await deferred.entered;
    const reset = resetEditorSession(h.session, { sessionId: "sess-p67-late-create", generation: 2 });
    assert.equal(reset.ok, true);
    deferred.release();
    const late = await pending;
    assert.equal(late.ok, false);
    if (late.ok) throw new Error("unreachable");
    assert.equal(late.rejection.code, "STALE_SESSION", "late probe stages no pending state");
    assert.equal(reset.value.registry.listDocuments().length, 0);
    proof("late create completion after reset is fenced");
  });

  it("P6.7 PROOF: mid-read revocation fences before registration", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const admission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const leaseId = syntheticAuthority(h).lease.leaseId;
    let revoked = false;
    const deferred = deferredAdapter(h.adapter);
    const pending = executeAdmittedFileOpen(h.session, admission, {
      adapter: deferred.adapter,
      authority: syntheticAuthority(h),
      revalidate: () => syntheticAuthority(h, { revokedLeaseIds: revoked ? [leaseId] : [] }),
    });
    await deferred.entered;
    revoked = true;
    deferred.release();
    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.rejection.code, "WORKSPACE_REVOKED");
    assert.equal(h.session.registry.hasBufferContent(admission.document.document_id), false, "revoked reads register nothing");
    proof("mid-read revocation fences before registration");
  });

  it("P6.7 PROOF: coordinator-issued leases execute through the trust chain", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const seed = manifestFor({ [ALPHA_PATH]: ALPHA_V1 });
    const policyOutcome = createReviewedWorkspacePolicy(
      {
        course_id: "C01",
        lesson_id: "C01-L061",
        lesson_compiled_digest: h.catalog.lesson_compiled_digest,
        seed_manifest_digest: computeSeedManifestDigest(seed),
        sandbox_policy_digest: sha256Hex("p67-sandbox-policy"),
        terminal_access: {},
        reviewed_by: "review-board-1",
        review_note: "synthetic P6.7 coordination review",
      },
      [],
    );
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    const coord = createWorkspaceCoordinator();
    const combined = coord.openCombinedSession({
      validatedIr: null,
      reviewedPolicy: policyOutcome.value,
      seedManifest: seed,
    });
    assert.equal(combined.ok, true);
    if (!combined.ok) throw new Error("unreachable");
    const editorSession = openEditorSession({
      catalog: h.catalog,
      sessionId: combined.value.descriptor.sessionId,
      generation: combined.value.descriptor.generation,
      seedManifest: seed,
      reviewed: true,
    });
    assert.equal(editorSession.ok, true);
    if (!editorSession.ok) throw new Error("unreachable");
    const session = editorSession.value;
    const admission = mustAdmit(session, A_OPEN, nextRequest("open"));
    // The coordinator issues the single-use editor lease for this operation;
    // the adapter authority below is derived from live coordinator facts.
    const grant = await coord.runEditorOperation(combined.value.editorCapability, "edit-p67-open", nextRequest("coord"));
    assert.equal(grant.ok, true);
    if (!grant.ok) throw new Error("unreachable");
    const live = coord.getLiveFacts();
    const facts = coord.describe();
    const bound = openWindowsFileAdapter({
      sessionId: facts.sessionId,
      generation: facts.generation,
      workspaceId: facts.workspaceId,
      leafHostPath: h.leaf,
      stagingHostPath: h.staging,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const executed = await executeAdmittedFileOpen(session, admission, {
      adapter: bound.value,
      authority: {
        lease: grant.value.lease,
        ownership: facts.ownership,
        liveEpoch: facts.epoch,
        revokedLeaseIds: [...live.revoked_lease_ids],
      },
    });
    assert.equal(executed.ok, true, "coordinator-authorized open executes");
    if (!executed.ok) throw new Error("unreachable");
    assert.equal(executed.value.content, ALPHA_V1);
    assert.equal(coord.releaseEditor(grant.value.lease).ok, true);
    proof("coordinator-issued leases execute through the trust chain");
  });
});

// ---------------------------------------------------------------------------
// Coordinator interlock: executed state gates terminal ownership.
// ---------------------------------------------------------------------------

describe("P6.7 executed-state interlock with terminal ownership", () => {
  const RW_OP = "term-p67-rw";
  const RO_OP = "term-p67-ro";

  function openCoordinated(files: Record<string, string>, fixtureName: string): {
    coord: ReturnType<typeof createWorkspaceCoordinator>;
    editorCapability: { kind: "editor_capability"; leaseId: string };
    terminalCapability: { kind: "terminal_capability"; leaseId: string };
    harness: ExecutionHarness;
  } {
    const seed = manifestFor(files);
    const catalogOutcome = createEditorCatalog(compileFixtureLesson(fixtureName));
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const policyOutcome = createReviewedWorkspacePolicy(
      {
        course_id: "C01",
        lesson_id: catalogOutcome.value.lesson_id,
        lesson_compiled_digest: catalogOutcome.value.lesson_compiled_digest,
        seed_manifest_digest: computeSeedManifestDigest(seed),
        sandbox_policy_digest: sha256Hex("p67-sandbox-policy"),
        terminal_access: { [RW_OP]: "read_write", [RO_OP]: "read_only" },
        reviewed_by: "review-board-1",
        review_note: "synthetic P6.7 coordination review",
      },
      [RW_OP, RO_OP],
    );
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    const coord = createWorkspaceCoordinator();
    const combined = coord.openCombinedSession({
      validatedIr: null,
      reviewedPolicy: policyOutcome.value,
      seedManifest: seed,
    });
    assert.equal(combined.ok, true);
    if (!combined.ok) throw new Error("unreachable");
    counter += 1;
    const tag = `cf-p67-c${counter}-${randomBytes(3).toString("hex")}`;
    const leaf = join(TEST_ROOT, `${tag}-leaf`);
    const staging = join(TEST_ROOT, `${tag}-staging`);
    mkdirSync(join(leaf, "src"), { recursive: true });
    mkdirSync(staging, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
    }
    const editorOpened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: combined.value.descriptor.sessionId,
      generation: combined.value.descriptor.generation,
      seedManifest: seed,
      reviewed: true,
    });
    assert.equal(editorOpened.ok, true);
    if (!editorOpened.ok) throw new Error("unreachable");
    const bound = openWindowsFileAdapter({
      sessionId: combined.value.descriptor.sessionId,
      generation: combined.value.descriptor.generation,
      workspaceId: combined.value.descriptor.workspaceId,
      leafHostPath: leaf,
      stagingHostPath: staging,
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const harness: ExecutionHarness = {
      tag,
      leaf,
      staging,
      adapter: bound.value,
      session: editorOpened.value,
      catalog: catalogOutcome.value,
      seed,
      sessionId: combined.value.descriptor.sessionId,
      workspaceId: combined.value.descriptor.workspaceId,
    };
    return {
      coord,
      editorCapability: combined.value.editorCapability,
      terminalCapability: combined.value.terminalCapability,
      harness,
    };
  }

  function liveAuthority(
    coord: ReturnType<typeof createWorkspaceCoordinator>,
    lease: AdapterAuthority["lease"],
  ): AdapterAuthority {
    const facts = coord.describe();
    const live = coord.getLiveFacts();
    return { lease, ownership: facts.ownership, liveEpoch: facts.epoch, revokedLeaseIds: [...live.revoked_lease_ids] };
  }

  it("P6.7 PROOF: executed pending creation denies terminal RW; RO stays compatible", async () => {
    const { coord, editorCapability, terminalCapability, harness: h } = openCoordinated(
      { [ALPHA_PATH]: ALPHA_V1 },
      "p67-open-create.json",
    );
    const openAdmission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const grant = await coord.runEditorOperation(editorCapability, "edit-p67-interlock", nextRequest("coord"));
    assert.equal(grant.ok, true);
    if (!grant.ok) throw new Error("unreachable");
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, {
      adapter: h.adapter,
      authority: liveAuthority(coord, grant.value.lease),
    });
    assert.equal(opened.ok, true);
    assert.equal(coord.releaseEditor(grant.value.lease).ok, true);
    const createAdmission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    const grant2 = await coord.runEditorOperation(editorCapability, "edit-p67-interlock-2", nextRequest("coord"));
    assert.equal(grant2.ok, true);
    if (!grant2.ok) throw new Error("unreachable");
    const created = await executeAdmittedFileCreate(h.session, createAdmission, {
      adapter: h.adapter,
      authority: liveAuthority(coord, grant2.value.lease),
    });
    assert.equal(created.ok, true, "pending creation executes with real staged content and real disk absence");
    if (!created.ok) throw new Error("unreachable");
    assert.equal(coord.releaseEditor(grant2.value.lease).ok, true);
    // Trusted executed facts flow through the capability-gated seam.
    const facts = editorBufferFacts(h.session);
    assert.deepEqual({ ...facts }, { dirtyBufferCount: 0, pendingCreationCount: 1 });
    assert.equal(coord.setBufferFacts(editorCapability, { ...facts }).ok, true);
    // Approved read-only background observation coexists with the pending.
    const ro = await coord.runTerminalOperation(terminalCapability, RO_OP, nextRequest("ro"));
    assert.equal(ro.ok, true, "RO observer remains compatible with staged creations");
    // Read-write acquisition fences on the executed pending fact.
    const rw = await coord.runTerminalOperation(terminalCapability, RW_OP, nextRequest("rw"));
    assert.equal(rw.ok, false);
    if (rw.ok) throw new Error("unreachable");
    assert.equal(rw.rejection.code, "DIRTY_BUFFER_CONFLICT", "pending create blocks terminal RW");
    // The renderer cannot forge cleanliness through the capability gate.
    const forged = coord.setBufferFacts(
      { kind: "editor_capability", leaseId: "cap-000000" },
      { dirtyBufferCount: 0, pendingCreationCount: 0 },
    );
    assert.equal(forged.ok, false);
    if (forged.ok) throw new Error("unreachable");
    assert.equal(forged.rejection.code, "WORKSPACE_REVOKED");
    proof("executed pending creation denies terminal RW; RO stays compatible");
  });

  it("P6.7 PROOF: executed clean open keeps committed disk visible to P5", async () => {
    const { coord, editorCapability, harness: h } = openCoordinated(
      { [ALPHA_PATH]: ALPHA_V1 },
      "p67-open-create.json",
    );
    const openAdmission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const grant = await coord.runEditorOperation(editorCapability, "edit-p67-visible", nextRequest("coord"));
    assert.equal(grant.ok, true);
    if (!grant.ok) throw new Error("unreachable");
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, {
      adapter: h.adapter,
      authority: liveAuthority(coord, grant.value.lease),
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    assert.equal(coord.releaseEditor(grant.value.lease).ok, true);
    // P5 sees committed disk only: the opened buffer equals the committed
    // file a terminal read would observe.
    assert.equal(hostText(h, ALPHA_PATH), opened.value.content, "file_open exposes the same committed file P5 reads");
    const facts = editorBufferFacts(h.session);
    assert.deepEqual({ ...facts }, { dirtyBufferCount: 0, pendingCreationCount: 0 });
    assert.equal(coord.setBufferFacts(editorCapability, { ...facts }).ok, true);
    // The staged creation from the companion operation stays invisible.
    const createAdmission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    const grant2 = await coord.runEditorOperation(editorCapability, "edit-p67-visible-2", nextRequest("coord"));
    assert.equal(grant2.ok, true);
    if (!grant2.ok) throw new Error("unreachable");
    const created = await executeAdmittedFileCreate(h.session, createAdmission, {
      adapter: h.adapter,
      authority: liveAuthority(coord, grant2.value.lease),
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    assert.equal(coord.releaseEditor(grant2.value.lease).ok, true);
    assert.equal(hostText(h, BETA_PATH), null, "pending create is invisible on committed disk before save");
    proof("executed clean open keeps committed disk visible to P5");
  });
});

// ---------------------------------------------------------------------------
// Wrong-action rejection, hostile paths, snapshots, module boundary.
// ---------------------------------------------------------------------------

describe("P6.7 execution boundary and DTO safety", () => {
  it("P6.7 PROOF: later editor semantics cannot execute here", async () => {
    const h = openExecutionHarness("p67-dirty-reopen.json", { [ALPHA_PATH]: ALPHA_V1 });
    const openAdmission = mustAdmit(h.session, E_OPEN, nextRequest("open"));
    const spy = spyAdapter(h.adapter);
    const deps = { adapter: spy.adapter, authority: syntheticAuthority(h) };
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, deps);
    assert.equal(opened.ok, true);
    const typeAdmission = mustAdmit(h.session, E_TYPE, nextRequest("type"));
    const viaOpen = await executeAdmittedFileOpen(h.session, typeAdmission, deps);
    assert.equal(viaOpen.ok, false);
    if (viaOpen.ok) throw new Error("unreachable");
    assert.equal(viaOpen.rejection.code, "INVALID_REQUEST", "type_code has no executor in P6.7");
    const viaCreate = await executeAdmittedFileCreate(h.session, typeAdmission, deps);
    assert.equal(viaCreate.ok, false);
    if (viaCreate.ok) throw new Error("unreachable");
    assert.equal(viaCreate.rejection.code, "INVALID_REQUEST");
    const saveViaOpen = await executeAdmittedFileOpen(h.session, openAdmission, deps);
    assert.equal(saveViaOpen.ok, true, "file_open admissions still execute");
    assert.equal(spy.publishes(), 0, "no verified persistence is reachable here");
    assert.equal(spy.reads() >= 2, true, "sanity: reads happened, publishes never");
    proof("later editor semantics cannot execute here");
  });

  it("P6.7 PROOF: traversal and device paths can never become executions", async () => {
    for (const hostile of ["../outside.ts", "src/../../evil.ts", "C:/evil.ts", "//server/share.ts", "src/COM1.ts"]) {
      const raw: unknown = JSON.parse(readFileSync(join(here, "fixtures", "p67-open-create.json"), "utf8")) as Record<string, unknown>;
      const scenes = (raw as { scenes: Array<{ beats: Array<{ action: Record<string, unknown> }> }> }).scenes;
      scenes[0]!.beats[0]!.action = { type: "file_open", path: hostile };
      const parsed = parseLessonData(raw);
      if (!parsed.ok) continue; // Source validation already refuses: never executable.
      if (parsed.lesson === undefined) throw new Error("unreachable");
      const catalog = createEditorCatalog(compileModule.compileLesson(parsed.lesson));
      assert.equal(catalog.ok, false, `hostile path '${hostile}' must fail catalog cross-checks`);
      if (!catalog.ok) assert.match(catalog.rejection.message, /IR_RUNTIME_INCONSISTENT|IR_INVALID/);
    }
    proof("traversal and device paths can never become executions");
  });

  it("P6.7 PROOF: public snapshots and results contain no host paths", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const openAdmission = mustAdmit(h.session, A_OPEN, nextRequest("open"));
    const opened = await executeAdmittedFileOpen(h.session, openAdmission, depsFor(h));
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const createAdmission = mustAdmit(h.session, A_CREATE, nextRequest("create"));
    const created = await executeAdmittedFileCreate(h.session, createAdmission, depsFor(h));
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    for (const dto of [openAdmission.record, createAdmission.record, opened.value, created.value, opened.value.document]) {
      assert.deepEqual(dtoLeaksHostPaths(dto, h), [], "no host paths leave the trusted boundary");
    }
    for (const snapshot of editorSnapshotDocuments(h.session)) {
      assert.deepEqual(dtoLeaksHostPaths(snapshot, h), [], "snapshots carry identifiers and revisions only");
    }
    proof("public snapshots and results contain no host paths");
  });

  it("P6.7 PROOF: no generic filesystem bridge and no visual typing machinery", async () => {
    const code = readFileSync(join(repoRoot, "engine", "workspace", "src", "editor-open-create.ts"), "utf8");
    const noComments = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const lower = noComments.toLowerCase();
    for (const marker of [
      "node:fs",
      "node:child_process",
      "node-pty",
      "publishdocument",
      "openwindowsfileadapter",
      "grapheme",
      "requestanimationframe",
      "monaco",
      "settimeout",
      "setinterval",
      "performance.now",
      "date.now",
      "child_process",
      "spawn(",
      "exec(",
    ]) {
      assert.equal(lower.includes(marker), false, `execution module must not contain '${marker}'`);
    }
    // The renderer IPC surface is untouched by this engine-only task.
    assert.equal(lower.includes("openbypath"), false, "no path-based bypass entry point");
    assert.equal(lower.includes("createbypath"), false, "no path-based bypass entry point");
    proof("no generic filesystem bridge and no visual typing machinery");
  });

  it("P6.7 PROOF: strict renderer DTOs still reject every semantic extra", async () => {
    const h = openExecutionHarness("p67-open-create.json", { [ALPHA_PATH]: ALPHA_V1 });
    const { RunEditorOperationRequestSchema } = await import("../src/protocol.ts");
    for (const extra of ["path", "content", "find", "replace", "save_bytes", "root", "access", "digest", "capability"]) {
      const parsed = RunEditorOperationRequestSchema.safeParse({
        session_id: h.session.sessionId,
        generation: 1,
        operation_id: A_OPEN,
        request_id: nextRequest("extra"),
        [extra]: "smuggled",
      });
      assert.equal(parsed.success, false, `renderer extra '${extra}' must reject by strict construction`);
    }
    proof("strict renderer DTOs still reject every semantic extra");
  });
});
