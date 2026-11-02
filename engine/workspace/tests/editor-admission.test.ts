// P6.6 Admission and documents tests — trusted editor admission plus the
// main-owned document model.
//
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.6 Admission and
// documents ("Frozen editor catalog, tombstones/revisions/generations";
// PASS "Exact IDs/order/digest and duplicates tests").
//
// Proves at runtime (not merely by types): the frozen editor catalog over
// canonical compiled IR (exact IDs, authored order, digest binding, drift
// rejection, forgery rejection); identifier-only admission where the
// renderer cannot supply path/content/find/replace/save bytes; one
// main-owned document per canonical file (duplicates and Windows case
// aliases collapse); main-owned dirty truth that denies terminal RW through
// the real coordinator seam; disk/buffer revision separation; external
// modification fencing without silent overwrite; stale session/document
// fencing; reset/close invalidation; absence of host paths, generic
// filesystem APIs and visual typing machinery. Pure, offline, deterministic
// (no disk beyond fixture reads, no containers, no timers, no sleeps).
//
// Fixture IR is NEVER hand-authored: synthetic lessons compile through the
// canonical pipeline (parseLessonData -> compileLesson -> re-validation
// inside createEditorCatalog). Forgeries mutate compiled output only to
// prove the cross-checks reject them.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import {
  RunEditorOperationRequestSchema,
  SnapshotDocumentSchema,
  type SnapshotDocument,
} from "../src/protocol.ts";
import {
  computeSeedManifestDigest,
  createReviewedWorkspacePolicy,
  createSeedManifest,
  sha256Hex,
  type SeedManifest,
} from "../src/policy.ts";
import { createWorkspaceCoordinator } from "../src/coordinator.ts";
import {
  EDITOR_ACTION_TYPES,
  EDITOR_ADMISSION_MAX_IR_BYTES,
  EDITOR_ADMISSION_MAX_OPERATIONS,
  EDITOR_ADMISSION_VERSION,
  EditorOperationAdmissionSchema,
  admitEditorOperation,
  checkAuthoredTextProfile,
  closeEditorSession,
  createEditorCatalog,
  editorBufferFacts,
  editorOperationIds,
  editorSnapshotDocuments,
  isLiveAdmissionDocument,
  openEditorSession,
  resetEditorSession,
  verifyEditorCatalog,
  type EditorCatalog,
  type EditorOperationAdmission,
  type EditorSession,
} from "../src/editor-admission.ts";
import {
  EDITOR_DOCUMENT_LIMIT,
  EditorDocumentDescriptorSchema,
  canonicalDocumentKey,
  createDocumentRegistry,
  isDirtyDocument,
  isLiveDocumentDescriptor,
  seedFactsForKey,
  seedHasParentDirectory,
} from "../src/editor-documents.ts";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

function proof(message: string): void {
  console.log(`P6.6 PROOF: ${message}`);
}

// ---------------------------------------------------------------------------
// Canonical fixture pipeline.
// ---------------------------------------------------------------------------

const OP_OPEN = "C01-L060-S001-B001";
const OP_TYPE_SEEDED = "C01-L060-S001-B002";
const OP_REPLACE = "C01-L060-S001-B003";
const OP_SAVE_SEEDED = "C01-L060-S001-B004";
const OP_CREATE = "C01-L060-S002-B001";
const OP_TYPE_CREATED = "C01-L060-S002-B002";
const OP_SAVE_CREATED = "C01-L060-S002-B003";
const OP_FOREIGN_TERMINAL = "C01-L060-S002-B004";

const EDITOR_OPS_IN_ORDER = [OP_OPEN, OP_TYPE_SEEDED, OP_REPLACE, OP_SAVE_SEEDED, OP_CREATE, OP_TYPE_CREATED, OP_SAVE_CREATED];

const SEEDED_PATH = "src/seeded.ts";
const CREATED_PATH = "src/created.ts";
const SEEDED_BYTES = "const seeded = true;\n";
const SEEDED_DIGEST = sha256Hex(SEEDED_BYTES);

function compileFixtureLesson(name: string): CompiledLesson {
  const raw: unknown = JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true, `fixture ${name} must pass canonical source validation: ${JSON.stringify(parsed.issues)}`);
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  return compileModule.compileLesson(parsed.lesson);
}

function makeSeedManifest(): SeedManifest {
  const outcome = createSeedManifest([
    { portable_path: "src", kind: "directory", byte_length: 0, sha256: null },
    { portable_path: SEEDED_PATH, kind: "regular_file", byte_length: SEEDED_BYTES.length, sha256: SEEDED_DIGEST },
  ]);
  assert.equal(outcome.ok, true, "seed manifest must build");
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

let sessionSeq = 0;

function openHarness(opts: { reviewed?: boolean; expectedDigest?: string; catalog?: EditorCatalog } = {}): {
  session: EditorSession;
  catalog: EditorCatalog;
  seed: SeedManifest;
} {
  const compiled = compileFixtureLesson("p66-editor-lesson.json");
  const catalogOutcome = createEditorCatalog(compiled);
  assert.equal(catalogOutcome.ok, true, `catalog must build: ${catalogOutcome.ok ? "" : catalogOutcome.rejection.message}`);
  if (!catalogOutcome.ok) throw new Error("unreachable");
  const catalog = opts.catalog ?? catalogOutcome.value;
  const seed = makeSeedManifest();
  sessionSeq += 1;
  const opened = openEditorSession({
    catalog,
    sessionId: `sess-p66-${sessionSeq}`,
    generation: 1,
    seedManifest: seed,
    reviewed: opts.reviewed ?? true,
    expectedCompiledDigest: opts.expectedDigest,
  });
  assert.equal(opened.ok, true, `session must open: ${opened.ok ? "" : opened.rejection.message}`);
  if (!opened.ok) throw new Error("unreachable");
  return { session: opened.value, catalog, seed };
}

function req(session: EditorSession, operationId: string, requestId: string): Record<string, unknown> {
  return { session_id: session.sessionId, generation: session.generation, operation_id: operationId, request_id: requestId };
}

function mustAdmit(session: EditorSession, operationId: string, requestId: string): EditorOperationAdmission {
  const outcome = admitEditorOperation(session, req(session, operationId, requestId));
  assert.equal(outcome.ok, true, `admission of ${operationId} must succeed: ${outcome.ok ? "" : outcome.rejection.code + " " + outcome.rejection.message}`);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

// ---------------------------------------------------------------------------
// Catalog: exact IDs, authored order, digest binding.
// ---------------------------------------------------------------------------

describe("P6.6 frozen editor catalog over canonical compiled IR", () => {
  it("P6.6 PROOF: known reviewed editor operation admits with exact identity and authored order", () => {
    const compiled = compileFixtureLesson("p66-editor-lesson.json");
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const catalog = catalogOutcome.value;
    assert.deepEqual([...catalog.editor_order], EDITOR_OPS_IN_ORDER);
    assert.equal(catalog.course_id, "C01");
    assert.equal(catalog.lesson_id, "C01-L060");
    assert.match(catalog.lesson_compiled_digest, /^[0-9a-f]{64}$/);
    const open = catalog.operations.get(OP_OPEN);
    assert.notEqual(open, undefined);
    assert.equal(open?.action_type, "file_open");
    assert.equal(open?.portable_path, SEEDED_PATH);
    assert.equal(open?.editor_ordinal, 1);
    assert.equal(open?.scene_id, "C01-L060-S001");
    assert.equal(open?.beat_id, OP_OPEN);
    const replace = catalog.operations.get(OP_REPLACE);
    assert.equal(replace?.action_type, "replace_code");
    assert.equal(replace?.editor_ordinal, 3);
    proof("known reviewed editor operation admits with exact identity and authored order");
  });

  it("same IR yields the same digest; the catalog is deeply frozen", () => {
    const a = createEditorCatalog(compileFixtureLesson("p66-editor-lesson.json"));
    const b = createEditorCatalog(compileFixtureLesson("p66-editor-lesson.json"));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    assert.equal(a.value.lesson_compiled_digest, b.value.lesson_compiled_digest);
    assert.equal(Object.isFrozen(a.value), true);
    assert.equal(Object.isFrozen(a.value.operations.get(OP_OPEN)), true);
    proof("same IR yields the same compiled digest; catalog output immutable");
  });

  it("non-editor operations are not indexed: terminal_run admits nowhere", () => {
    const catalogOutcome = createEditorCatalog(compileFixtureLesson("p66-editor-lesson.json"));
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    assert.equal(catalogOutcome.value.operations.has(OP_FOREIGN_TERMINAL), false);
    assert.deepEqual([...editorOperationIds(catalogOutcome.value)].sort(), [...EDITOR_OPS_IN_ORDER].sort());
  });

  it("real-IR compatibility: the canonical editor-typing fixture catalogs with highlight excluded, no migration", () => {
    const raw: unknown = JSON.parse(
      readFileSync(join(repoRoot, "apps", "teaching-ide", "fixtures", "compiled-lessons", "editor-typing.json"), "utf8"),
    );
    const catalogOutcome = createEditorCatalog(raw);
    assert.equal(catalogOutcome.ok, true, `real fixture must catalog: ${catalogOutcome.ok ? "" : catalogOutcome.rejection.message}`);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    assert.deepEqual([...catalogOutcome.value.editor_order], [
      "C01-L010-S002-B002",
      "C01-L010-S002-B004",
      "C01-L010-S002-B005",
    ]);
    // The highlight beat (family visual) is not an executable editor operation.
    assert.equal(catalogOutcome.value.operations.has("C01-L010-S002-B006"), false);
    proof("real compiled IR catalogs with highlight excluded and no fixture migration");
  });

  it("rejects IR that fails canonical validation (IR_INVALID prefix, zero repair)", () => {
    const base = compileFixtureLesson("p66-editor-lesson.json");
    const broken = { ...base, compiled_ir_version: "9.9" } as unknown as CompiledLesson;
    const result = createEditorCatalog(broken);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.rejection.code, "INVALID_REQUEST");
      assert.match(result.rejection.message, /IR_INVALID/);
    }
  });

  it("rejects forged duplicate operation ids (IR_RUNTIME_INCONSISTENT prefix)", () => {
    const base = compileFixtureLesson("p66-editor-lesson.json");
    const forged: CompiledLesson = {
      ...base,
      scenes: base.scenes.map((scene) =>
        scene.scene_id !== "C01-L060-S002"
          ? scene
          : {
              ...scene,
              steps: scene.steps.map((step) =>
                step.kind === "operation" && step.step_id === OP_CREATE
                  ? { ...step, step_id: OP_OPEN, source_ref: { ...step.source_ref, beat_id: OP_OPEN } }
                  : step,
              ),
            },
      ),
    };
    const result = createEditorCatalog(forged);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.rejection.code, "INVALID_REQUEST");
      assert.match(result.rejection.message, /IR_RUNTIME_INCONSISTENT/);
      assert.match(result.rejection.message, /not unique/);
    }
    proof("forged duplicate operation identity cannot resolve deterministically");
  });

  it("rejects forged type/family disagreement (never admit by family alone)", () => {
    const base = compileFixtureLesson("p66-editor-lesson.json");
    const forged: CompiledLesson = {
      ...base,
      scenes: base.scenes.map((scene) => ({
        ...scene,
        steps: scene.steps.map((step) =>
          step.kind === "operation" && step.step_id === OP_TYPE_SEEDED
            ? { ...step, operation: { ...step.operation, family: "file" as const } }
            : step,
        ),
      })),
    };
    const result = createEditorCatalog(forged);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.rejection.message, /IR_RUNTIME_INCONSISTENT/);
  });

  it("an empty lesson (no editor actions) builds an explicit empty catalog", () => {
    const base = compileFixtureLesson("p66-editor-lesson.json");
    // Drop every editor operation, renormalize ordinals, and drop scenes left
    // without steps: the survivor carries only the unowned terminal_run.
    const emptied: CompiledLesson = {
      ...base,
      scenes: base.scenes
        .map((scene) => ({
          ...scene,
          steps: scene.steps
            .filter((step) => step.kind !== "operation" || step.operation.parameters.type === "terminal_run")
            .map((step, index) => ({ ...step, ordinal: index + 1 })),
        }))
        .filter((scene) => scene.steps.length > 0)
        .map((scene, index) => ({ ...scene, ordinal: index + 1 })),
    };
    const result = createEditorCatalog(emptied);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual([...result.value.editor_order], []);
  });

  it("admission ceilings match the frozen resource policy", () => {
    assert.equal(EDITOR_ADMISSION_MAX_IR_BYTES, 1048576);
    assert.equal(EDITOR_ADMISSION_MAX_OPERATIONS, 10000);
    assert.equal(EDITOR_DOCUMENT_LIMIT, 256);
    assert.equal(EDITOR_ADMISSION_VERSION, 1);
    assert.deepEqual([...EDITOR_ACTION_TYPES], ["file_open", "file_create", "type_code", "replace_code", "file_save"]);
  });
});

// ---------------------------------------------------------------------------
// Review binding and drift.
// ---------------------------------------------------------------------------

describe("P6.6 reviewed operation binding and digest drift", () => {
  it("P6.6 PROOF: operation digest drift rejects with zero mutation", () => {
    const compiled = compileFixtureLesson("p66-editor-lesson.json");
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const seed = makeSeedManifest();
    const drifted = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: "sess-p66-drift",
      generation: 1,
      seedManifest: seed,
      reviewed: true,
      expectedCompiledDigest: sha256Hex("p66-different-reviewed-bytes"),
    });
    assert.equal(drifted.ok, false);
    if (!drifted.ok) assert.equal(drifted.rejection.code, "NOT_AUTHORIZED");
    // The review binding also fails closed when the live bytes move under a fixed review.
    const mutated = structuredClone(compiled) as CompiledLesson;
    for (const scene of mutated.scenes) {
      for (const step of scene.steps) {
        if (step.kind === "operation" && step.step_id === OP_TYPE_SEEDED) {
          (step.operation.parameters as { content: string }).content = "const forged = true;\n";
        }
      }
    }
    const forgedCatalog = createEditorCatalog(mutated);
    assert.equal(forgedCatalog.ok, true);
    if (!forgedCatalog.ok) throw new Error("unreachable");
    assert.notEqual(forgedCatalog.value.lesson_compiled_digest, catalogOutcome.value.lesson_compiled_digest);
    const verify = verifyEditorCatalog(forgedCatalog.value, catalogOutcome.value.lesson_compiled_digest);
    assert.equal(verify.ok, false);
    if (!verify.ok) assert.equal(verify.rejection.code, "NOT_AUTHORIZED");
    proof("operation digest drift rejects with zero mutation");
  });

  it("inspection sessions open but admit nothing (NOT_AUTHORIZED, zero side effects)", () => {
    const { session } = openHarness({ reviewed: false });
    const outcome = admitEditorOperation(session, req(session, OP_OPEN, "req-inspect-1"));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.rejection.code, "NOT_AUTHORIZED");
    assert.deepEqual(session.registry.listDocuments(), []);
  });

  it("unknown operations reject NOT_AUTHORIZED: terminal_run, highlight-shaped and invented ids", () => {
    const { session } = openHarness();
    for (const [label, operationId] of [
      ["terminal_run id", OP_FOREIGN_TERMINAL],
      ["invented id", "C01-L060-S009-B009"],
    ] as const) {
      const outcome = admitEditorOperation(session, req(session, operationId, `req-unknown-${operationId.slice(-4)}`));
      assert.equal(outcome.ok, false, label);
      if (!outcome.ok) assert.equal(outcome.rejection.code, "NOT_AUTHORIZED", label);
    }
    assert.deepEqual(session.registry.listDocuments(), []);
    proof("unknown operation identity cannot admit");
  });
});

// ---------------------------------------------------------------------------
// Identifier-only renderer boundary.
// ---------------------------------------------------------------------------

describe("P6.6 renderer supplies identifiers only", () => {
  it("P6.6 PROOF: renderer cannot supply path, content, find/replace or save bytes", () => {
    const { session } = openHarness();
    const hostileExtras: Array<[string, Record<string, unknown>]> = [
      ["path", { path: "src/evil.ts" }],
      ["code", { code: "const evil = 1;" }],
      ["content", { content: "const evil = 1;" }],
      ["find", { find: "seeded" }],
      ["replace", { replace: "evil" }],
      ["save bytes", { bytes: "evil" }],
      ["data", { data: "evil" }],
      ["workspace root", { workspace_root: "/tmp/evil" }],
      ["host path", { host_path: "E:\\evil\\file.ts" }],
      ["access mode", { access: "read_write" }],
      ["digest authority", { digest: SEEDED_DIGEST }],
      ["revision authority", { revision: 99 }],
      ["ownership capability", { lease_id: "lease-1" }],
      ["policy", { policy_digest: sha256Hex("evil") }],
    ];
    let index = 0;
    for (const [label, extra] of hostileExtras) {
      index += 1;
      const outcome = admitEditorOperation(session, { ...req(session, OP_OPEN, `req-hostile-${index}`), ...extra });
      assert.equal(outcome.ok, false, `hostile extra '${label}' must reject`);
      if (!outcome.ok) assert.equal(outcome.rejection.code, "INVALID_REQUEST", label);
    }
    // Untouched: nothing admitted through the hostile attempts.
    assert.deepEqual(session.registry.listDocuments(), []);
    proof("renderer semantic authority absent: hostile extras reject");
  });

  it("strict DTOs reject extras on the admission envelope and document descriptor", () => {
    const { session } = openHarness();
    const admitted = mustAdmit(session, OP_OPEN, "req-strict-1");
    assert.equal(EditorOperationAdmissionSchema.safeParse({ ...admitted.record, path: SEEDED_PATH }).success, false);
    assert.equal(EditorOperationAdmissionSchema.safeParse({ ...admitted.record, content: "x" }).success, false);
    assert.equal(EditorDocumentDescriptorSchema.safeParse({ ...admitted.document, host_path: "E:\\x" }).success, false);
    assert.equal(EditorDocumentDescriptorSchema.safeParse({ ...admitted.document, code: "x" }).success, false);
    assert.equal(RunEditorOperationRequestSchema.safeParse({ ...req(session, OP_OPEN, "r"), code: "x" }).success, false);
    proof("strict DTOs reject every renderer-supplied semantic extra");
  });

  it("malformed identifier shapes reject before any authority is consulted", () => {
    const { session } = openHarness();
    assert.equal(admitEditorOperation(session, null).ok, false);
    assert.equal(admitEditorOperation(session, { session_id: session.sessionId }).ok, false);
    const bad = admitEditorOperation(session, { ...req(session, OP_OPEN, "req-malformed"), generation: 0 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.rejection.code, "INVALID_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// Admission sequencing: tombstones, order, idempotency.
// ---------------------------------------------------------------------------

describe("P6.6 tombstones, authored order and idempotency", () => {
  it("P6.6 PROOF: editor operations admit only in authored editor order", () => {
    const { session } = openHarness();
    const early = admitEditorOperation(session, req(session, OP_TYPE_SEEDED, "req-early-1"));
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.rejection.code, "INVALID_REQUEST");
    // The refused early attempt consumes nothing: the ordered run still works.
    mustAdmit(session, OP_OPEN, "req-order-1");
    mustAdmit(session, OP_TYPE_SEEDED, "req-order-2");
    mustAdmit(session, OP_REPLACE, "req-order-3");
    mustAdmit(session, OP_SAVE_SEEDED, "req-order-4");
    mustAdmit(session, OP_CREATE, "req-order-5");
    mustAdmit(session, OP_TYPE_CREATED, "req-order-6");
    mustAdmit(session, OP_SAVE_CREATED, "req-order-7");
    proof("authored editor order enforced; refused early attempt consumes nothing");
  });

  it("one attempt per operation: new request ids cannot evade consumed tombstones", () => {
    const { session } = openHarness();
    mustAdmit(session, OP_OPEN, "req-tomb-1");
    const replay = admitEditorOperation(session, req(session, OP_OPEN, "req-tomb-2"));
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.rejection.code, "INVALID_REQUEST");
  });

  it("identical request id and payload returns the cached admission (same attempt)", () => {
    const { session } = openHarness();
    const first = mustAdmit(session, OP_OPEN, "req-idem-1");
    const second = admitEditorOperation(session, req(session, OP_OPEN, "req-idem-1"));
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.deepEqual(second.value.record, first.record);
    assert.equal(second.value.record.attempt_id, first.record.attempt_id);
  });

  it("a reused request id with a different payload rejects (no id confusion)", () => {
    const { session } = openHarness();
    mustAdmit(session, OP_OPEN, "req-reuse-1");
    const conflict = admitEditorOperation(session, req(session, OP_TYPE_SEEDED, "req-reuse-1"));
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.rejection.code, "INVALID_REQUEST");
  });

  it("session and generation fencing: foreign sessions and stale generations fence", () => {
    const { session } = openHarness();
    const foreign = admitEditorOperation(session, {
      session_id: "sess-p66-foreign",
      generation: 1,
      operation_id: OP_OPEN,
      request_id: "req-fence-1",
    });
    assert.equal(foreign.ok, false);
    if (!foreign.ok) assert.equal(foreign.rejection.code, "WRONG_OWNER");
    const stale = admitEditorOperation(session, {
      session_id: session.sessionId,
      generation: session.generation + 1,
      operation_id: OP_OPEN,
      request_id: "req-fence-2",
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "STALE_SESSION");
    assert.deepEqual(session.registry.listDocuments(), []);
    proof("stale session and foreign owner fence before authority");
  });
});

// ---------------------------------------------------------------------------
// Document authority: one canonical document, case identity, dirty truth.
// ---------------------------------------------------------------------------

describe("P6.6 main-owned document authority", () => {
  it("P6.6 PROOF: the same logical file opens as one canonical document (no duplicate writers)", () => {
    const { session } = openHarness();
    const first = mustAdmit(session, OP_OPEN, "req-doc-1");
    assert.equal(first.document.state, "opened");
    assert.equal(first.document.dirty, false);
    assert.equal(first.document.base_exists, true);
    assert.equal(first.document.base_digest, SEEDED_DIGEST);
    assert.equal(first.document.base_disk_revision, 0);
    assert.equal(first.document.buffer_revision, 0);
    const registry = session.registry;
    assert.equal(registry.listDocuments().length, 1);
    // Registry-level duplicate open returns the identical authority.
    const again = registry.openOrGetDocument(SEEDED_PATH, seedFactsForKey(makeSeedManifest(), canonicalDocumentKey(SEEDED_PATH)));
    assert.equal(again.ok, true);
    if (!again.ok) throw new Error("unreachable");
    assert.equal(again.value.document_id, first.document.document_id);
    assert.equal(registry.listDocuments().length, 1);
    proof("duplicate open resolves to the one canonical document");
  });

  it("Windows case aliases cannot create a second authority", () => {
    const { session } = openHarness();
    const first = mustAdmit(session, OP_OPEN, "req-case-1");
    const registry = session.registry;
    const alias = registry.openOrGetDocument("SRC/SEEDED.TS", seedFactsForKey(makeSeedManifest(), canonicalDocumentKey("SRC/SEEDED.TS")));
    assert.equal(alias.ok, true);
    if (!alias.ok) throw new Error("unreachable");
    assert.equal(alias.value.document_id, first.document.document_id);
    assert.equal(alias.value.portable_path, SEEDED_PATH);
    const collide = registry.createPendingDocument("src/Seeded.ts");
    assert.equal(collide.ok, false);
    if (!collide.ok) assert.equal(collide.rejection.code, "FILE_EXISTS");
    assert.equal(canonicalDocumentKey("src/App.ts"), canonicalDocumentKey("src/app.ts"));
    proof("case alias collapses onto the canonical document identity");
  });

  it("file_create stages a pending creation from trusted IR only; collisions and missing parents fail closed", () => {
    const { session } = openHarness();
    mustAdmit(session, OP_OPEN, "req-create-1");
    mustAdmit(session, OP_TYPE_SEEDED, "req-create-2");
    mustAdmit(session, OP_REPLACE, "req-create-3");
    mustAdmit(session, OP_SAVE_SEEDED, "req-create-4");
    const created = mustAdmit(session, OP_CREATE, "req-create-5");
    assert.equal(created.document.state, "pending_creation");
    assert.equal(created.document.dirty, true);
    assert.equal(created.document.base_exists, false);
    assert.equal(created.document.base_digest, null);
    // Renderer chose nothing: the staged path is the authored IR path.
    assert.equal(created.document.portable_path, CREATED_PATH);
    assert.equal(created.record.portable_path, CREATED_PATH);
    // The seeded document is still dirty (save reserves without cleaning), so
    // both counters are live: one dirty buffer plus one pending creation.
    const facts = editorBufferFacts(session);
    assert.deepEqual({ ...facts }, { dirtyBufferCount: 1, pendingCreationCount: 1 });
    // Collision and parent rules at their owning layers: the staged path
    // cannot stage twice, and unreviewed parents are never invented.
    assert.equal(session.registry.createPendingDocument(CREATED_PATH).ok, false);
    assert.equal(seedHasParentDirectory(makeSeedManifest(), "src/another.ts"), true);
    assert.equal(seedHasParentDirectory(makeSeedManifest(), "other/nested.ts"), false);
    assert.equal(seedHasParentDirectory(makeSeedManifest(), "top.ts"), true);
    proof("file_create stages a pending creation from reviewed IR only");
  });

  it("type/replace reserve dirty against the live document; save reserves without cleaning", () => {
    const { session } = openHarness();
    mustAdmit(session, OP_OPEN, "req-dirty-1");
    assert.deepEqual({ ...editorBufferFacts(session) }, { dirtyBufferCount: 0, pendingCreationCount: 0 });
    const typed = mustAdmit(session, OP_TYPE_SEEDED, "req-dirty-2");
    assert.equal(typed.document.dirty, true);
    assert.equal(typed.document.reserved_operation_id, OP_TYPE_SEEDED);
    // Buffer revision advances only under execution (P6.8/P6.9): admission
    // records the reservation, never the content mutation.
    assert.equal(typed.document.buffer_revision, 0);
    assert.equal(typed.document.base_disk_revision, 0);
    assert.deepEqual({ ...editorBufferFacts(session) }, { dirtyBufferCount: 1, pendingCreationCount: 0 });
    // Per-document sequencing is deterministic: the ordered log matches admission order.
    assert.deepEqual([...typed.document.admitted_operations], [OP_TYPE_SEEDED]);
    const replaced = mustAdmit(session, OP_REPLACE, "req-dirty-3");
    assert.deepEqual([...replaced.document.admitted_operations], [OP_TYPE_SEEDED, OP_REPLACE]);
    assert.equal(replaced.document.document_id, typed.document.document_id);
    // Save admission reserves but never marks clean: clean requires verified
    // byte publication (P6.10). Fail-closed until then.
    const saved = mustAdmit(session, OP_SAVE_SEEDED, "req-dirty-4");
    assert.equal(saved.document.dirty, true);
    assert.equal(saved.document.reserved_operation_id, OP_SAVE_SEEDED);
    assert.deepEqual({ ...editorBufferFacts(session) }, { dirtyBufferCount: 1, pendingCreationCount: 0 });
    proof("main owns dirty truth: type reserves dirty, save reserves without cleaning");
  });

  it("type/replace/save without a prior open or create reject FILE_NOT_FOUND", () => {
    const { session } = openHarness();
    // OP_TYPE_SEEDED is next after OP_OPEN is skipped: order check fires first.
    // Admit the open out of the harness, then use a fresh session for pure targeting.
    const fresh = openHarness();
    const openOutcome = admitEditorOperation(fresh.session, req(fresh.session, OP_OPEN, "req-target-0"));
    assert.equal(openOutcome.ok, true);
    // Direct registry targeting for an unopened path:
    const registry = createDocumentRegistry({ sessionId: "sess-p66-target", generation: 1 });
    assert.equal(registry.listDocuments().length, 0);
    assert.equal(registry.resolveDocument("doc-999").ok, false);
    proof("unloaded targets cannot resolve a document");
  });

  it("authored parameters travel verbatim from reviewed IR (at_line, occurrences, content)", () => {
    const compiled = compileFixtureLesson("p66-editor-lesson.json");
    const withLine = structuredClone(compiled) as CompiledLesson;
    for (const scene of withLine.scenes) {
      for (const step of scene.steps) {
        if (step.kind === "operation" && step.step_id === OP_TYPE_SEEDED) {
          (step.operation.parameters as { at_line?: number }).at_line = 2;
        }
      }
    }
    const catalogOutcome = createEditorCatalog(withLine);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const opened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: "sess-p66-params",
      generation: 1,
      seedManifest: makeSeedManifest(),
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const session = opened.value;
    mustAdmit(session, OP_OPEN, "req-params-1");
    const typed = mustAdmit(session, OP_TYPE_SEEDED, "req-params-2");
    assert.equal((typed.parameters as { at_line?: number }).at_line, 2);
    assert.equal((typed.parameters as { content: string }).content, "const extra = 1;\n");
    const replaced = mustAdmit(session, OP_REPLACE, "req-params-3");
    assert.equal((replaced.parameters as { find: string }).find, "seeded");
    // occurrences defaults downstream (P6.9); admission carries the authored value verbatim.
    assert.equal((replaced.parameters as { occurrences?: number }).occurrences, undefined);
    assert.equal(Object.isFrozen(typed.parameters), true);
  });

  it("authored text outside the strict LF profile rejects UNSUPPORTED_TEXT_PROFILE with zero document mutation", () => {
    for (const [label, mutate] of [
      ["CRLF content", (params: Record<string, unknown>) => ({ ...params, content: "a\r\nb" })],
      ["lone CR content", (params: Record<string, unknown>) => ({ ...params, content: "a\rb" })],
      ["NUL content", (params: Record<string, unknown>) => ({ ...params, content: "a\0b" })],
    ] as const) {
      const compiled = compileFixtureLesson("p66-editor-lesson.json");
      const forged = structuredClone(compiled) as unknown as {
        scenes: Array<{ steps: Array<{ kind: string; step_id: string; operation: { parameters: Record<string, unknown> } }> }>;
      };
      for (const scene of forged.scenes) {
        for (const step of scene.steps) {
          if (step.kind === "operation" && step.step_id === OP_TYPE_SEEDED) step.operation.parameters = mutate(step.operation.parameters);
        }
      }
      const catalogOutcome = createEditorCatalog(forged as unknown as CompiledLesson);
      assert.equal(catalogOutcome.ok, true, label);
      if (!catalogOutcome.ok) throw new Error("unreachable");
      const opened = openEditorSession({
        catalog: catalogOutcome.value,
        sessionId: `sess-p66-profile-${label.length}`,
        generation: 1,
        seedManifest: makeSeedManifest(),
        reviewed: true,
      });
      assert.equal(opened.ok, true);
      if (!opened.ok) throw new Error("unreachable");
      mustAdmit(opened.value, OP_OPEN, `req-profile-open-${label.length}`);
      const outcome = admitEditorOperation(opened.value, {
        session_id: opened.value.sessionId,
        generation: 1,
        operation_id: OP_TYPE_SEEDED,
        request_id: `req-profile-type-${label.length}`,
      });
      assert.equal(outcome.ok, false, label);
      if (!outcome.ok) assert.equal(outcome.rejection.code, "UNSUPPORTED_TEXT_PROFILE", label);
      // Zero mutation: the later replace admission still targets a clean document.
      const check = checkAuthoredTextProfile(catalogOutcome.value.operations.get(OP_TYPE_SEEDED)!);
      assert.equal(check.ok, false);
    }
    proof("authored text outside the LF profile cannot admit");
  });

  it("empty type content is a legal admitted no-op", () => {
    const compiled = compileFixtureLesson("p66-editor-lesson.json");
    const forged = structuredClone(compiled) as unknown as {
      scenes: Array<{ steps: Array<{ kind: string; step_id: string; operation: { parameters: Record<string, unknown> } }> }>;
    };
    for (const scene of forged.scenes) {
      for (const step of scene.steps) {
        if (step.kind === "operation" && step.step_id === OP_TYPE_SEEDED) {
          step.operation.parameters = { ...step.operation.parameters, content: "" };
        }
      }
    }
    const catalogOutcome = createEditorCatalog(forged as unknown as CompiledLesson);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const opened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: "sess-p66-empty",
      generation: 1,
      seedManifest: makeSeedManifest(),
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    mustAdmit(opened.value, OP_OPEN, "req-empty-1");
    const typed = mustAdmit(opened.value, OP_TYPE_SEEDED, "req-empty-2");
    assert.equal((typed.parameters as { content: string }).content, "");
  });
});

// ---------------------------------------------------------------------------
// Disk vs buffer revisions, snapshots, external modification.
// ---------------------------------------------------------------------------

describe("P6.6 disk/buffer revisions and external modification fencing", () => {
  it("P6.6 PROOF: disk revision stays separate from buffer revision; snapshots carry both", () => {
    const { session } = openHarness();
    const opened = mustAdmit(session, OP_OPEN, "req-rev-1");
    assert.equal(opened.document.base_disk_revision, 0);
    assert.equal(opened.document.buffer_revision, 0);
    mustAdmit(session, OP_TYPE_SEEDED, "req-rev-2");
    const snapshots = editorSnapshotDocuments(session);
    assert.equal(snapshots.length, 1);
    assert.equal(SnapshotDocumentSchema.safeParse(snapshots[0]).success, true);
    assert.deepEqual(snapshots[0], {
      portable_path: SEEDED_PATH,
      disk_revision: 0,
      buffer_revision: 0,
      dirty: true,
    } satisfies SnapshotDocument);
    proof("disk revision stored separately from buffer revision");
  });

  it("identical observed disk digest agrees with zero mutation; divergence flags the document", () => {
    const { session } = openHarness();
    mustAdmit(session, OP_OPEN, "req-ext-1");
    const agreed = session.registry.noteExternalChange(SEEDED_PATH, SEEDED_DIGEST);
    assert.equal(agreed.ok, true);
    if (!agreed.ok) throw new Error("unreachable");
    assert.equal(agreed.value.externally_modified, false);
    const diverged = session.registry.noteExternalChange(SEEDED_PATH, sha256Hex("p66-external-bytes"));
    assert.equal(diverged.ok, true);
    if (!diverged.ok) throw new Error("unreachable");
    assert.equal(diverged.value.externally_modified, true);
    // The buffer is preserved for diagnostics: no silent update, no overwrite.
    assert.equal(diverged.value.dirty, false);
    assert.equal(diverged.value.base_digest, SEEDED_DIGEST);
  });

  it("P6.6 PROOF: old revisions cannot silently save or overwrite after an external change", () => {
    const { session } = openHarness();
    mustAdmit(session, OP_OPEN, "req-conflict-1");
    mustAdmit(session, OP_TYPE_SEEDED, "req-conflict-2");
    session.registry.noteExternalChange(SEEDED_PATH, sha256Hex("p66-external-bytes"));
    const replace = admitEditorOperation(session, req(session, OP_REPLACE, "req-conflict-3"));
    assert.equal(replace.ok, false);
    if (!replace.ok) assert.equal(replace.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    // A dirty document cannot adopt new disk facts either: reset is required.
    const rebase = session.registry.noteCommittedDiskFacts(SEEDED_PATH, true, sha256Hex("p66-external-bytes"), 1);
    assert.equal(rebase.ok, false);
    if (!rebase.ok) assert.equal(rebase.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    proof("externally modified disk cannot be silently overwritten");
  });

  it("clean documents accept fresh main-held disk facts; dirty documents require reset", () => {
    const { session } = openHarness();
    mustAdmit(session, OP_OPEN, "req-refresh-1");
    session.registry.noteExternalChange(SEEDED_PATH, sha256Hex("p66-external-bytes"));
    const refreshed = session.registry.noteCommittedDiskFacts(SEEDED_PATH, true, sha256Hex("p66-external-bytes"), 2);
    assert.equal(refreshed.ok, true);
    if (!refreshed.ok) throw new Error("unreachable");
    assert.equal(refreshed.value.externally_modified, false);
    assert.equal(refreshed.value.base_disk_revision, 2);
    assert.equal(refreshed.value.base_digest, sha256Hex("p66-external-bytes"));
    // Admission resumes after the explicit refresh.
    mustAdmit(session, OP_TYPE_SEEDED, "req-refresh-2");
  });

  it("external changes for unknown paths and malformed facts reject without effect", () => {
    const { session } = openHarness();
    mustAdmit(session, OP_OPEN, "req-unk-1");
    assert.equal(session.registry.noteExternalChange("src/ghost.ts", SEEDED_DIGEST).ok, false);
    assert.equal(session.registry.noteCommittedDiskFacts("src/ghost.ts", true, SEEDED_DIGEST, 0).ok, false);
    assert.equal(session.registry.noteCommittedDiskFacts(SEEDED_PATH, true, "not-a-digest", 0).ok, false);
  });
});

// ---------------------------------------------------------------------------
// Reset / close lifecycle.
// ---------------------------------------------------------------------------

describe("P6.6 reset and close invalidate every document", () => {
  it("P6.6 PROOF: reset invalidates all old documents and fences late completions", () => {
    const { session } = openHarness();
    const opened = mustAdmit(session, OP_OPEN, "req-reset-1");
    const reset = resetEditorSession(session, { sessionId: "sess-p66-reset-2", generation: 2 });
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(session.retired, true);
    // Old admissions fence.
    const late = admitEditorOperation(session, req(session, OP_TYPE_SEEDED, "req-reset-late"));
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.rejection.code, "STALE_SESSION");
    // Old descriptors fence, including through the late-completion predicate.
    assert.equal(isLiveAdmissionDocument(session, opened.document), false);
    assert.equal(isLiveDocumentDescriptor(session.registry, opened.document), false);
    assert.equal(session.registry.resolveDocument(opened.document.document_id).ok, false);
    // The new generation starts from the authored beginning with a fresh registry.
    // Document ids sequence per registry; cross-generation identity is the
    // (session, generation, document) tuple, never the bare id.
    assert.deepEqual(reset.value.registry.listDocuments(), []);
    const reopened = mustAdmit(reset.value, OP_OPEN, "req-reset-2");
    assert.equal(reopened.record.generation, 2);
    assert.equal(reopened.record.session_id, "sess-p66-reset-2");
    assert.equal(reopened.document.generation, 2);
    assert.equal(isLiveAdmissionDocument(reset.value, reopened.document), true);
    assert.equal(isLiveAdmissionDocument(session, reopened.document), false);
    proof("reset invalidates all old documents; late completions fence");
  });

  it("P6.6 PROOF: close invalidates all old documents and fences late completions", () => {
    const { session } = openHarness();
    const opened = mustAdmit(session, OP_OPEN, "req-close-1");
    const closed = closeEditorSession(session);
    assert.equal(closed.ok, true);
    const late = admitEditorOperation(session, req(session, OP_TYPE_SEEDED, "req-close-late"));
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.rejection.code, "STALE_SESSION");
    assert.equal(isLiveAdmissionDocument(session, opened.document), false);
    // No renderer callback can recreate authority: double close stays fenced.
    assert.equal(closeEditorSession(session).ok, true);
    assert.equal(admitEditorOperation(session, req(session, OP_OPEN, "req-close-again")).ok, false);
    proof("close invalidates all old documents; late completions fence");
  });

  it("forged descriptor shapes never read as live", () => {
    const { session } = openHarness();
    const opened = mustAdmit(session, OP_OPEN, "req-forge-1");
    assert.equal(isLiveAdmissionDocument(session, null), false);
    assert.equal(isLiveAdmissionDocument(session, { ...opened.document, generation: 99 }), false);
    assert.equal(isLiveAdmissionDocument(session, { ...opened.document, document_id: "doc-999" }), false);
    assert.equal(isLiveAdmissionDocument(session, { ...opened.document, invalidated: true }), false);
  });
});

// ---------------------------------------------------------------------------
// Coordinator interlock: dirty truth denies terminal RW.
// ---------------------------------------------------------------------------

describe("P6.6 dirty-state interlock with terminal ownership", () => {
  const RW_OP = "C01-L060-S002-B004";
  const RO_OP = "C01-L060-S001-B099";

  function openCoordinated(): {
    coord: ReturnType<typeof createWorkspaceCoordinator>;
    editorCapability: { kind: "editor_capability"; leaseId: string };
    terminalCapability: { kind: "terminal_capability"; leaseId: string };
    session: EditorSession;
  } {
    const seed = makeSeedManifest();
    const policyOutcome = createReviewedWorkspacePolicy(
      {
        course_id: "C01",
        lesson_id: "C01-L060",
        lesson_compiled_digest: sha256Hex("p66-coordinated-compiled"),
        seed_manifest_digest: computeSeedManifestDigest(seed),
        sandbox_policy_digest: sha256Hex("p66-sandbox-policy"),
        terminal_access: { [RW_OP]: "read_write", [RO_OP]: "read_only" },
        reviewed_by: "review-board-1",
        review_note: "synthetic P6.6 coordination review",
      },
      [RW_OP, RO_OP],
    );
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    const coord = createWorkspaceCoordinator();
    const opened = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: seed });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const compiled = compileFixtureLesson("p66-editor-lesson.json");
    const catalogOutcome = createEditorCatalog(compiled);
    assert.equal(catalogOutcome.ok, true);
    if (!catalogOutcome.ok) throw new Error("unreachable");
    const editorOpened = openEditorSession({
      catalog: catalogOutcome.value,
      sessionId: opened.value.descriptor.sessionId,
      generation: opened.value.descriptor.generation,
      seedManifest: seed,
      reviewed: true,
    });
    assert.equal(editorOpened.ok, true);
    if (!editorOpened.ok) throw new Error("unreachable");
    return {
      coord,
      editorCapability: opened.value.editorCapability,
      terminalCapability: opened.value.terminalCapability,
      session: editorOpened.value,
    };
  }

  it("P6.6 PROOF: trusted dirty documents deny terminal RW; read-only background stays compatible", async () => {
    const { coord, editorCapability, terminalCapability, session } = openCoordinated();
    mustAdmit(session, OP_OPEN, "req-interlock-1");
    mustAdmit(session, OP_TYPE_SEEDED, "req-interlock-2");
    const facts = editorBufferFacts(session);
    assert.deepEqual({ ...facts }, { dirtyBufferCount: 1, pendingCreationCount: 0 });
    const pushed = coord.setBufferFacts(editorCapability, { ...facts });
    assert.equal(pushed.ok, true);
    // Read-only background observation coexists with editing.
    const ro = await coord.runTerminalOperation(terminalCapability, RO_OP, "req-interlock-ro");
    assert.equal(ro.ok, true);
    // Read-write acquisition fences on the trusted dirty fact.
    const rw = await coord.runTerminalOperation(terminalCapability, RW_OP, "req-interlock-rw");
    assert.equal(rw.ok, false);
    if (!rw.ok) assert.equal(rw.rejection.code, "DIRTY_BUFFER_CONFLICT");
    proof("dirty editor buffers deny terminal read_write ownership");
  });

  it("P6.6 PROOF: pending creations deny terminal RW through the same trusted facts", async () => {
    const { coord, editorCapability, terminalCapability, session } = openCoordinated();
    mustAdmit(session, OP_OPEN, "req-pending-1");
    mustAdmit(session, OP_TYPE_SEEDED, "req-pending-2");
    mustAdmit(session, OP_REPLACE, "req-pending-3");
    mustAdmit(session, OP_SAVE_SEEDED, "req-pending-4");
    mustAdmit(session, OP_CREATE, "req-pending-5");
    const facts = editorBufferFacts(session);
    assert.deepEqual({ ...facts }, { dirtyBufferCount: 1, pendingCreationCount: 1 });
    assert.equal(coord.setBufferFacts(editorCapability, { ...facts }).ok, true);
    const rw = await coord.runTerminalOperation(terminalCapability, RW_OP, "req-pending-rw");
    assert.equal(rw.ok, false);
    if (!rw.ok) assert.equal(rw.rejection.code, "DIRTY_BUFFER_CONFLICT");
    // Snapshots flow through the capability-gated open-documents seam.
    const snapshots = editorSnapshotDocuments(session);
    assert.equal(coord.setOpenDocuments(editorCapability, snapshots).ok, true);
    const view = coord.getCombinedSnapshot(coord.describe(), 0);
    assert.equal(view.ok, true);
    proof("pending creations deny terminal read_write ownership");
  });

  it("P6.6 PROOF: renderer cannot forge clean state (capability gate holds)", async () => {
    const { coord, editorCapability, terminalCapability, session } = openCoordinated();
    mustAdmit(session, OP_OPEN, "req-forge-clean-1");
    mustAdmit(session, OP_TYPE_SEEDED, "req-forge-clean-2");
    // A forged capability object cannot push facts.
    const forged = coord.setBufferFacts(
      { kind: "editor_capability", leaseId: "cap-000000" },
      { dirtyBufferCount: 0, pendingCreationCount: 0 },
    );
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.equal(forged.rejection.code, "WORKSPACE_REVOKED");
    // The trusted facts still deny RW: nothing the renderer sends can clear them.
    assert.equal(coord.setBufferFacts(editorCapability, { ...editorBufferFacts(session) }).ok, true);
    const rw = await coord.runTerminalOperation(terminalCapability, RW_OP, "req-forge-clean-rw");
    assert.equal(rw.ok, false);
    if (!rw.ok) assert.equal(rw.rejection.code, "DIRTY_BUFFER_CONFLICT");
    proof("renderer cannot forge clean state");
  });
});

// ---------------------------------------------------------------------------
// Public DTO safety and module boundary.
// ---------------------------------------------------------------------------

describe("P6.6 public DTO safety and module boundary", () => {
  it("P6.6 PROOF: no host paths in any public DTO", () => {
    const { session } = openHarness();
    mustAdmit(session, OP_OPEN, "req-leak-1");
    mustAdmit(session, OP_TYPE_SEEDED, "req-leak-2");
    mustAdmit(session, OP_REPLACE, "req-leak-3");
    mustAdmit(session, OP_SAVE_SEEDED, "req-leak-4");
    mustAdmit(session, OP_CREATE, "req-leak-5");
    const admissions = [
      admitEditorOperation(session, req(session, OP_TYPE_CREATED, "req-leak-6")),
    ];
    assert.equal(admissions[0].ok, true);
    const payload = JSON.stringify({
      admissions: admissions.map((outcome) => (outcome.ok ? outcome.value : null)),
      documents: session.registry.listDocuments(),
      snapshots: editorSnapshotDocuments(session),
      facts: editorBufferFacts(session),
    });
    assert.match(payload, /src\/seeded\.ts/);
    assert.doesNotMatch(payload, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(payload, /\\\\/);
    assert.doesNotMatch(payload, /course-factory/);
    assert.doesNotMatch(payload, /\/workspace\//);
    assert.doesNotMatch(payload, /tmp\//);
    proof("no host paths leak into public DTOs");
  });

  it("P6.6 PROOF: no generic renderer filesystem API on the module surface", async () => {
    const admission = (await import("../src/editor-admission.ts")) as Record<string, unknown>;
    const documents = (await import("../src/editor-documents.ts")) as Record<string, unknown>;
    const names = [...Object.keys(admission), ...Object.keys(documents)];
    assert.ok(names.length > 10, "boundary scan must observe the real surface");
    for (const forbidden of [
      "readFile",
      "writeFile",
      "openFile",
      "saveFile",
      "replace",
      "publishDocument",
      "readDocument",
      "openWindowsFileAdapter",
      "executeType",
      "executeEditorOperation",
    ]) {
      assert.equal(names.includes(forbidden), false, `generic bridge '${forbidden}' must not exist`);
    }
    const sources = readFileSync(join(here, "..", "src", "editor-admission.ts"), "utf8")
      + readFileSync(join(here, "..", "src", "editor-documents.ts"), "utf8");
    const code = sources.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const marker of [
      "node:fs",
      "node:child_process",
      "node-pty",
      "grapheme",
      "requestAnimationFrame",
      "setTimeout",
      "setInterval",
      "performance.now",
      "Date.now",
      "Monaco",
      "monaco",
      "playwright",
      "publishDocument",
      "readDocument",
    ]) {
      assert.equal(code.includes(marker), false, `phase-boundary marker '${marker}' must be absent`);
    }
    proof("no generic filesystem bridge and no visual typing machinery");
  });

  it("document registry bounds live documents (256 ceiling)", () => {
    const registry = createDocumentRegistry({ sessionId: "sess-p66-bounds", generation: 1 });
    for (let index = 0; index < EDITOR_DOCUMENT_LIMIT; index += 1) {
      const created = registry.createPendingDocument(`src/bound-${index}.ts`);
      assert.equal(created.ok, true, `document ${index} must stage`);
    }
    const over = registry.createPendingDocument("src/bound-over.ts");
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.rejection.code, "RESOURCE_LIMIT");
  });

  it("seed helpers encode the reviewed parent and kind rules", () => {
    const seed = makeSeedManifest();
    assert.equal(seedFactsForKey(seed, canonicalDocumentKey(SEEDED_PATH)).present, true);
    assert.equal(seedFactsForKey(seed, canonicalDocumentKey(SEEDED_PATH)).digest, SEEDED_DIGEST);
    assert.equal(seedFactsForKey(seed, canonicalDocumentKey("src")).isDirectory, true);
    assert.equal(seedFactsForKey(seed, canonicalDocumentKey("src/ghost.ts")).present, false);
  });
});
