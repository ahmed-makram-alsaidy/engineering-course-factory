// P6.6 trusted editor admission — reviewed operation identity plus the
// main-owned document model admission resolves into.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 4 (trust boundary:
// validated IR -> main-only reviewed catalog -> editor admission), 5 (editor
// authority), 7 (operation model and admission: revalidate via the compiler
// authority, clone/freeze, verify digest, hierarchy, unique IDs,
// ordinal/provenance, type/family consistency; operation_id := step_id; only
// the five types; one attempt per operation with tombstones; authored editor
// order), 12 (strict LF execution profile), 15 (identifier-only renderer
// requests; replay/snapshot references are opaque main-issued IDs), 17
// (portable path rules), 18 (1 MiB IR ceiling, 10,000 admitted operations,
// 256 documents), 21 (admission errors have zero side effects) and 26.5
// (file generations) with docs/adr/ADR-0011-shared-workspace-ownership.md.
//
// Canonical P6.6 name: P6.6 Admission and documents.
//
// THE CENTRAL SECURITY PROPERTY (mirroring P5 admission without duplicating
// it): the renderer never supplies the file semantics that will execute. A
// renderer request carries session/generation/operation/request identifiers
// ONLY; trusted admission resolves that identifier against the canonical
// validated CompiledLesson IR, confirms eligibility, checks session lifecycle
// state, and derives an immutable EditorOperationAdmission. Later execution
// tasks (P6.7+) may obtain path/content/find/replace semantics ONLY through
// an admission record. Renderer compromise can therefore lie about pixels or
// acknowledgements; it cannot choose file bytes.
//
// Request-shape consequences enforced here:
//   - file paths, code text, replacement text, find text, save bytes,
//     workspace roots, host paths, access modes and digest/revision authority
//     are never renderer fields: the P6.1 RunEditorOperationRequestSchema is
//     strict, so any such extra key rejects INVALID_REQUEST by construction;
//   - operationId -> reviewed Compiled IR action -> exact trusted semantics;
//   - public/runtime-safe DTOs (admissions, descriptors, snapshots) contain
//     logical identifiers only; host absolute paths remain internal to the
//     trusted Windows file adapter boundary (P6.4) and never appear here.
//
// Owned scope (and only this):
//   - the frozen editor catalog: immutable, cross-checked index of exactly
//     the five editor actions (file_open, file_create, type_code,
//     replace_code, file_save) built ONLY from CompiledLesson IR that the
//     canonical P3 authority re-validates here; digest-bound over the
//     canonical compiled bytes (same serialization as P5 admission, so one
//     reviewed lesson_compiled_digest binds both engines);
//   - admission sessions: one per session generation, binding a catalog, a
//     reviewed seed manifest, review authorization (inspection sessions stay
//     NOT_AUTHORIZED) and a main-owned DocumentRegistry;
//   - identifier-only admission with tombstones (one attempt per operation
//     per generation), identical-request caching, conflicting-payload
//     rejection, authored-editor-order enforcement and per-action document
//     resolution (open focuses, create stages pending, type/replace reserve
//     dirty, save reserves without cleaning).
//
// Explicit non-scope (owned by later tasks):
//   - P6.7 open/create execution (adapter reads, staged content bytes).
//     P6.6 admission requires a prior open/create admission before
//     type/replace/save resolve a document; validated auto-load of an
//     unopened existing file inside type execution (spec section 8) is a
//     P6.7/P6.8-owned extension of this rule, versioned there — never an
//     unloaded-document admission state here;
//   - P6.8 type planning (at_line location validation, UTF-16 ranges,
//     grapheme scheduling, pacing, cursor animation);
//   - P6.9 replacement matching (occurrence counting, transactional plans);
//   - P6.10 save persistence (byte verification, disk/workspace revision
//     increments on commit, clean marking after verified publication, journal
//     events); P6.6 save admission reserves only and never marks clean;
//   - P6.12 IPC/preload/Monaco wiring (no new channels here);
//   - visual typing schedulers, browser automation, recording (never).
//
// Error-code note: catalog-build inconsistencies are reported as
// INVALID_REQUEST with an IR_INVALID:/IR_RUNTIME_INCONSISTENT: message
// prefix. The frozen WorkspaceErrorCode enum (P6.1) is deliberately NOT
// extended mid-phase; the message prefix keeps main diagnostics greppable
// while the renderer-visible code stays inside the canonical taxonomy.
//
// Purity: this module imports only zod, the canonical compiler authority
// (validate + canonical bytes), the P6.1 protocol/policy contracts and the
// P6.6 document registry. No filesystem, no processes, no containers, no
// timers, no wall-clock reads, no browser or presentation machinery.

import { z } from "zod";
import {
  validateCompiledLesson,
  type CompiledLesson,
  type CompiledOperation,
} from "@course-factory/lesson-compiler/ir";
import { serializeCompiledLesson, sha256Hex } from "../../compiler/src/canonical.ts";
import {
  OpaqueHandleSchema,
  PortablePathSchema,
  RunEditorOperationRequestSchema,
  Sha256HexSchema,
  WorkspaceIdentifierSchema,
  type SnapshotDocument,
  type WorkspaceOutcome,
  type WorkspaceRejection,
} from "./protocol.ts";
import {
  canonicalDocumentKey,
  createDocumentRegistry,
  isLiveDocumentDescriptor,
  seedFactsForKey,
  seedHasParentDirectory,
  type DocumentRegistry,
  type EditorDocumentDescriptor,
} from "./editor-documents.ts";
import type { SeedManifest } from "./policy.ts";

/** Admission protocol version (matches the workspace protocol). */
export const EDITOR_ADMISSION_VERSION = 1;

/** Compiled-IR admission ceiling in bytes (spec section 18: 1 MiB). */
export const EDITOR_ADMISSION_MAX_IR_BYTES = 1048576;

/** Maximum editor operations indexed per lesson (spec section 18: 10,000). */
export const EDITOR_ADMISSION_MAX_OPERATIONS = 10000;

function rejected(code: WorkspaceRejection["code"], message: string): { ok: false; rejection: WorkspaceRejection } {
  return { ok: false, rejection: { code, message } };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** The exact five authored editor action types P6 executes (spec 4.1/22). */
export const EDITOR_ACTION_TYPES = ["file_open", "file_create", "type_code", "replace_code", "file_save"] as const;
export type EditorActionType = (typeof EDITOR_ACTION_TYPES)[number];

function isEditorActionType(value: string): value is EditorActionType {
  return (EDITOR_ACTION_TYPES as readonly string[]).includes(value);
}

/** Expected IR family per editor action (spec section 3: create is file, the other four are editor). */
function expectedFamilyFor(actionType: EditorActionType): string {
  return actionType === "file_create" ? "file" : "editor";
}

// ---------------------------------------------------------------------------
// Frozen editor catalog.
// ---------------------------------------------------------------------------

/** Trusted authored parameters for one editor operation (exact IR copy, main-held, never renderer input). */
export type EditorActionParameters = Extract<CompiledOperation["parameters"], { type: EditorActionType }>;

export interface EditorOperationEntry {
  readonly operation_id: string;
  readonly scene_id: string;
  readonly beat_id: string;
  readonly scene_ordinal: number;
  readonly step_ordinal: number;
  /** 1-based position among the lesson's editor operations in authored order (admission sequencing). */
  readonly editor_ordinal: number;
  readonly action_type: EditorActionType;
  /** Authored logical path from reviewed IR (never a host path, never renderer input). */
  readonly portable_path: string;
  /** Exact authored parameters preserved verbatim (content/find/replace/at_line/occurrences). */
  readonly parameters: EditorActionParameters;
}

export interface EditorCatalog {
  /** SHA-256 over the canonical compiled bytes (same serialization as P5 admission). */
  readonly lesson_compiled_digest: string;
  readonly course_id: string;
  readonly lesson_id: string;
  readonly operations: ReadonlyMap<string, EditorOperationEntry>;
  /** Editor operation ids in authored order (the admission sequence). */
  readonly editor_order: readonly string[];
}

type FlatEditorStep = {
  sceneId: string;
  sceneOrdinal: number;
  stepOrdinal: number;
  stepId: string;
  beatId: string;
  operation: CompiledOperation;
};

/**
 * Build the immutable editor catalog. Accepts unknown IR and re-validates it
 * through the canonical P3 authority; raw objects are never trusted.
 * Cross-checks reject inconsistent IR without repair. Non-editor actions
 * (terminal_run, browser_*, wait, highlight, ...) are not indexed: admitting
 * them later rejects NOT_AUTHORIZED.
 */
export function createEditorCatalog(ir: unknown): WorkspaceOutcome<EditorCatalog> {
  const validated = validateCompiledLesson(ir);
  if (!validated.ok || validated.ir === undefined) {
    return rejected("INVALID_REQUEST", "IR_INVALID: compiled lesson failed canonical validation");
  }
  const parsed: CompiledLesson = validated.ir;

  if (Buffer.byteLength(serializeCompiledLesson(parsed), "utf8") > EDITOR_ADMISSION_MAX_IR_BYTES) {
    return rejected("INVALID_REQUEST", "IR_INVALID: compiled IR exceeds the 1 MiB admission ceiling");
  }

  // -- order / uniqueness / provenance cross-checks (mirrors P5 admission) --
  const seenSceneIds = new Set<string>();
  for (const [index, scene] of parsed.scenes.entries()) {
    if (seenSceneIds.has(scene.scene_id)) {
      return rejected("INVALID_REQUEST", `IR_RUNTIME_INCONSISTENT: duplicate scene id '${scene.scene_id}'`);
    }
    seenSceneIds.add(scene.scene_id);
    if (scene.ordinal !== index + 1) {
      return rejected(
        "INVALID_REQUEST",
        `IR_RUNTIME_INCONSISTENT: scene '${scene.scene_id}' ordinal ${scene.ordinal} does not match authored position ${index + 1}`,
      );
    }
    for (const [stepIndex, step] of scene.steps.entries()) {
      if (step.ordinal !== stepIndex + 1) {
        return rejected(
          "INVALID_REQUEST",
          `IR_RUNTIME_INCONSISTENT: step '${step.step_id}' ordinal ${step.ordinal} does not match authored position ${stepIndex + 1}`,
        );
      }
      if (step.source_ref.scene_id !== scene.scene_id) {
        return rejected(
          "INVALID_REQUEST",
          `IR_RUNTIME_INCONSISTENT: step '${step.step_id}' provenance scene '${step.source_ref.scene_id}' does not match containing scene '${scene.scene_id}'`,
        );
      }
    }
  }

  // -- editor operation index (operation_id := step_id, no IR mutation) ------
  const operations = new Map<string, EditorOperationEntry>();
  const editorOrder: string[] = [];
  for (const [sceneIndex, scene] of parsed.scenes.entries()) {
    for (const [stepIndex, step] of scene.steps.entries()) {
      if (step.kind !== "operation") continue;
      if (step.source_ref.beat_id === null) {
        return rejected(
          "INVALID_REQUEST",
          `IR_RUNTIME_INCONSISTENT: operation step '${step.step_id}' has no beat provenance; operations are authored beats`,
        );
      }
      const operationId = step.step_id;
      if (operations.has(operationId) || editorOrder.includes(operationId)) {
        return rejected(
          "INVALID_REQUEST",
          `IR_RUNTIME_INCONSISTENT: operation id '${operationId}' is not unique across the lesson; requests could not resolve to exactly one operation`,
        );
      }
      const operation = step.operation;
      if (operation.type !== (operation.parameters as { type?: unknown }).type) {
        return rejected(
          "INVALID_REQUEST",
          `IR_RUNTIME_INCONSISTENT: operation '${operationId}' type '${operation.type}' disagrees with its parameters type`,
        );
      }
      // Admit by exact action type, never by family alone (spec section 3).
      if (!isEditorActionType(operation.type)) continue;
      if (operation.family !== expectedFamilyFor(operation.type)) {
        return rejected(
          "INVALID_REQUEST",
          `IR_RUNTIME_INCONSISTENT: editor operation '${operationId}' family '${operation.family}' does not match its type '${operation.type}'`,
        );
      }
      const parameters = operation.parameters as EditorActionParameters;
      if (typeof parameters.path !== "string" || PortablePathSchema.safeParse(parameters.path).success === false) {
        return rejected(
          "INVALID_REQUEST",
          `IR_RUNTIME_INCONSISTENT: editor operation '${operationId}' carries no valid lesson-relative path`,
        );
      }
      editorOrder.push(operationId);
      operations.set(
        operationId,
        deepFreeze({
          operation_id: operationId,
          scene_id: scene.scene_id,
          beat_id: step.source_ref.beat_id,
          scene_ordinal: sceneIndex + 1,
          step_ordinal: stepIndex + 1,
          editor_ordinal: editorOrder.length,
          action_type: operation.type,
          portable_path: parameters.path,
          parameters,
        }),
      );
    }
  }

  // Duplicate step ids across non-editor operations must still fence: two
  // operations sharing a step id could otherwise resolve ambiguously.
  const seenStepIds = new Set<string>();
  for (const scene of parsed.scenes) {
    for (const step of scene.steps) {
      if (step.kind !== "operation") continue;
      if (seenStepIds.has(step.step_id)) {
        return rejected(
          "INVALID_REQUEST",
          `IR_RUNTIME_INCONSISTENT: operation id '${step.step_id}' is not unique across the lesson; requests could not resolve to exactly one operation`,
        );
      }
      seenStepIds.add(step.step_id);
    }
  }

  if (editorOrder.length > EDITOR_ADMISSION_MAX_OPERATIONS) {
    return rejected("RESOURCE_LIMIT", "IR_INVALID: lesson exceeds the 10,000 editor-operation ceiling");
  }

  const digest = sha256Hex(serializeCompiledLesson(parsed));
  const catalog: EditorCatalog = {
    lesson_compiled_digest: digest,
    course_id: parsed.lesson.course_id,
    lesson_id: parsed.lesson.lesson_id,
    operations,
    editor_order: Object.freeze([...editorOrder]),
  };
  return { ok: true, value: deepFreeze(catalog) };
}

/** Sorted editor operation ids of a catalog. */
export function editorOperationIds(catalog: EditorCatalog): readonly string[] {
  return Object.freeze([...catalog.editor_order].sort());
}

/**
 * Revalidate a catalog binding (session-open path): the digest must match the
 * expected reviewed digest or authorization fails with zero mutation.
 */
export function verifyEditorCatalog(catalog: EditorCatalog, expectedDigest?: string): WorkspaceOutcome<EditorCatalog> {
  if (typeof catalog.lesson_compiled_digest !== "string" || !/^[0-9a-f]{64}$/.test(catalog.lesson_compiled_digest)) {
    return rejected("INVALID_REQUEST", "IR_INVALID: editor catalog carries no well-formed compiled digest");
  }
  if (expectedDigest !== undefined && catalog.lesson_compiled_digest !== expectedDigest) {
    return rejected("NOT_AUTHORIZED", "editor catalog binds different compiled IR bytes than the review authorizes");
  }
  return { ok: true, value: catalog };
}

// ---------------------------------------------------------------------------
// Authored text-profile eligibility (spec section 12, strict LF profile).
// ---------------------------------------------------------------------------

function textProfileProblems(value: string): string[] {
  const problems: string[] = [];
  if (value.includes("\r")) problems.push("CR bytes are not allowed (strict LF profile; CRLF/lone CR rejected, never converted)");
  if (value.includes("\0")) problems.push("NUL is not allowed");
  // Lone UTF-16 surrogates (unpaired halves) cannot encode to valid UTF-8.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    problems.push("unpaired UTF-16 surrogates are not allowed");
  }
  // UTF-8 BOM must never be smuggled inside authored text.
  if (value.includes("﻿")) problems.push("BOM is not allowed inside authored text");
  return problems;
}

/**
 * Planning-eligibility check for authored text carried by one catalog entry.
 * Empty type_code content is a legal no-op (admitted); CR/NUL/surrogate/BOM
 * content rejects UNSUPPORTED_TEXT_PROFILE with zero side effects. Location
 * validation (at_line range) and occurrence counting belong to the P6.8/P6.9
 * planners, which own buffer geometry.
 */
export function checkAuthoredTextProfile(entry: EditorOperationEntry): WorkspaceOutcome<null> {
  const parameters = entry.parameters;
  const samples: string[] = [];
  if (parameters.type === "type_code") samples.push(parameters.content);
  if (parameters.type === "file_create" && parameters.content !== undefined) samples.push(parameters.content);
  if (parameters.type === "replace_code") samples.push(parameters.find, parameters.replace);
  for (const sample of samples) {
    const problems = textProfileProblems(sample);
    if (problems.length > 0) {
      return rejected("UNSUPPORTED_TEXT_PROFILE", `operation '${entry.operation_id}' authored text is outside the strict LF profile: ${problems.join("; ")}`);
    }
  }
  return { ok: true, value: null };
}

// ---------------------------------------------------------------------------
// Trusted admission record.
// ---------------------------------------------------------------------------

/** Strict schema for the trusted admission record (renderer-visible codes only, main-held values). */
export const EditorOperationAdmissionSchema = z.strictObject({
  kind: z.literal("editor_operation_admission"),
  admission_version: z.literal(EDITOR_ADMISSION_VERSION),
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  operation_id: WorkspaceIdentifierSchema,
  request_id: WorkspaceIdentifierSchema,
  attempt_id: WorkspaceIdentifierSchema,
  action_type: z.enum(EDITOR_ACTION_TYPES),
  scene_id: WorkspaceIdentifierSchema,
  beat_id: WorkspaceIdentifierSchema,
  editor_ordinal: z.number().int().min(1),
  portable_path: PortablePathSchema,
  document_id: OpaqueHandleSchema,
  lesson_compiled_digest: Sha256HexSchema,
});
export type EditorOperationAdmissionValue = z.infer<typeof EditorOperationAdmissionSchema>;

/**
 * Trusted admission: the ONLY object through which later execution tasks may
 * obtain editor path/content/find/replace semantics. Main-held, deeply
 * frozen, portable (no host paths). The renderer never sees the embedded
 * authored parameters object (main-held sidecar); the strict schema above
 * validates the identifier envelope shared with snapshots/diagnostics.
 */
export interface EditorOperationAdmission {
  readonly record: EditorOperationAdmissionValue;
  /** Exact authored parameters from reviewed IR (content/find/replace/at_line/occurrences/path). */
  readonly parameters: EditorActionParameters;
  /** Live document descriptor after this admission (renderer-safe snapshot). */
  readonly document: EditorDocumentDescriptor;
}

// ---------------------------------------------------------------------------
// Admission session: one per session generation.
// ---------------------------------------------------------------------------

export interface OpenEditorSessionArgs {
  readonly catalog: EditorCatalog;
  readonly sessionId: string;
  readonly generation: number;
  readonly seedManifest: SeedManifest;
  /** False marks an inspection session (P4-like): every admission rejects NOT_AUTHORIZED with zero mutation. */
  readonly reviewed: boolean;
  /** Optional review binding: the authorized compiled digest must match the catalog digest. */
  readonly expectedCompiledDigest?: string;
}

/** Opaque main-owned admission session (live object, never serialized, never renderer input). */
export interface EditorSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly catalog: EditorCatalog;
  readonly reviewed: boolean;
  readonly retired: boolean;
  readonly registry: DocumentRegistry;
}

interface SessionState {
  retired: boolean;
  nextEditorOrdinal: number;
  attemptSeq: number;
  receipts: Map<string, { scopeHash: string; response: WorkspaceOutcome<EditorOperationAdmission> }>;
  tombstones: Map<string, { requestId: string }>;
}

function payloadHash(scope: readonly unknown[], payload: unknown): string {
  return JSON.stringify({ scope, payload });
}

/**
 * Open the main-owned admission session for one generation. Binds the frozen
 * catalog (digest-checked against the review when expectedCompiledDigest is
 * given) and the reviewed seed manifest (base disk facts for documents).
 * Inspection sessions (reviewed: false) open successfully but admit nothing.
 */
export function openEditorSession(args: OpenEditorSessionArgs): WorkspaceOutcome<EditorSession> {
  const digestCheck = verifyEditorCatalog(args.catalog, args.expectedCompiledDigest);
  if (!digestCheck.ok) return digestCheck as { ok: false; rejection: WorkspaceRejection };
  const idCheck = WorkspaceIdentifierSchema.safeParse(args.sessionId);
  if (!idCheck.success) return rejected("INVALID_REQUEST", "editor session requires a 1..128 character session id");
  if (!Number.isInteger(args.generation) || args.generation < 1) {
    return rejected("INVALID_REQUEST", "editor session requires a generation >= 1");
  }
  const state: SessionState = {
    retired: false,
    nextEditorOrdinal: 1,
    attemptSeq: 0,
    receipts: new Map(),
    tombstones: new Map(),
  };
  const registry = createDocumentRegistry({ sessionId: args.sessionId, generation: args.generation });
  const session: EditorSession = {
    sessionId: args.sessionId,
    generation: args.generation,
    catalog: digestCheck.value,
    reviewed: args.reviewed,
    registry,
    get retired(): boolean {
      return state.retired;
    },
  };
  // Retire through the explicit session lifecycle only (reset/close below);
  // the registry retires with it.
  STATES.set(session, state);
  SEEDS.set(session, args.seedManifest);
  return { ok: true, value: session };
}

const STATES = new WeakMap<EditorSession, SessionState>();
const SEEDS = new WeakMap<EditorSession, SeedManifest>();

function sessionState(session: EditorSession): SessionState | null {
  return STATES.get(session) ?? null;
}

function sessionSeed(session: EditorSession): SeedManifest | null {
  return SEEDS.get(session) ?? null;
}

/** Retire the session for a new generation: old admissions/descriptors fence as STALE_SESSION. */
export function resetEditorSession(
  session: EditorSession,
  next: { readonly sessionId: string; readonly generation: number },
): WorkspaceOutcome<EditorSession> {
  const state = sessionState(session);
  const seed = sessionSeed(session);
  if (state === null || seed === null) return rejected("INVALID_REQUEST", "unknown editor session handle");
  if (state.retired) return rejected("STALE_SESSION", "editor session is already retired");
  state.retired = true;
  session.registry.invalidateAll();
  return openEditorSession({
    catalog: session.catalog,
    sessionId: next.sessionId,
    generation: next.generation,
    seedManifest: seed,
    reviewed: session.reviewed,
  });
}

/** Close the session: every descriptor/admission fences, no late completion can reopen a document. */
export function closeEditorSession(session: EditorSession): WorkspaceOutcome<null> {
  const state = sessionState(session);
  if (state === null) return rejected("INVALID_REQUEST", "unknown editor session handle");
  if (state.retired) return { ok: true, value: null };
  state.retired = true;
  session.registry.invalidateAll();
  return { ok: true, value: null };
}

/**
 * Admit one editor operation from an identifier-only renderer request. The
 * request is strict-parsed: renderer-supplied paths, code, find/replace
 * text, save bytes, roots, access modes or digests reject INVALID_REQUEST.
 * All semantic data resolves from the reviewed catalog entry.
 */
export function admitEditorOperation(session: EditorSession, request: unknown): WorkspaceOutcome<EditorOperationAdmission> {
  const state = sessionState(session);
  if (state === null) return rejected("INVALID_REQUEST", "unknown editor session handle");
  const parsed = RunEditorOperationRequestSchema.safeParse(request);
  if (!parsed.success) {
    return rejected("INVALID_REQUEST", `editor request failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
  }
  const { session_id, generation, operation_id, request_id } = parsed.data;
  if (state.retired || session.registry.retired) {
    return rejected("STALE_SESSION", "editor session was reset or closed: old operation identities cannot admit");
  }
  if (session_id !== session.sessionId) return rejected("WRONG_OWNER", "editor request names a foreign session");
  if (generation !== session.generation) return rejected("STALE_SESSION", "editor request carries a stale session generation");
  if (!session.reviewed) return rejected("NOT_AUTHORIZED", "inspection sessions cannot admit editor operations");

  const scope: readonly unknown[] = ["admitEditorOperation", session.sessionId, session.generation, operation_id];
  const scopeHash = payloadHash(scope, { session_id, generation, operation_id, request_id });
  const cached = state.receipts.get(request_id);
  if (cached !== undefined) {
    if (cached.scopeHash !== scopeHash) {
      return rejected("INVALID_REQUEST", "request_id was already used with a different payload");
    }
    return cached.response;
  }
  const tomb = state.tombstones.get(operation_id);
  if (tomb !== undefined && tomb.requestId !== request_id) {
    return rejected("INVALID_REQUEST", "operation attempt is already consumed in this generation");
  }

  const entry = session.catalog.operations.get(operation_id);
  if (entry === undefined) {
    return rejected("NOT_AUTHORIZED", `operation '${operation_id}' is not a reviewed editor operation of this lesson`);
  }
  if (entry.editor_ordinal !== state.nextEditorOrdinal) {
    return rejected(
      "INVALID_REQUEST",
      `operation '${operation_id}' is not the next authored editor operation (expected '${nextExpectedOperationId(session, state) ?? "(none)"}')`,
    );
  }
  const profile = checkAuthoredTextProfile(entry);
  if (!profile.ok) return profile as { ok: false; rejection: WorkspaceRejection };

  const seed = sessionSeed(session);
  if (seed === null) return rejected("INVALID_REQUEST", "internal: editor session lost its seed binding");
  const key = canonicalDocumentKey(entry.portable_path);

  // -- per-action document resolution (admission only; execution is P6.7+) --
  let document: EditorDocumentDescriptor;
  if (entry.action_type === "file_open") {
    const known = findLiveDocument(session.registry, key);
    if (known !== null) {
      if (known.externally_modified) {
        return rejected(
          "EXTERNAL_MODIFICATION_CONFLICT",
          "document base diverged from committed disk: refresh main-held disk facts (clean) or reset (dirty/pending) before reopening",
        );
      }
      document = known;
    } else {
      const facts = seedFactsForKey(seed, key);
      const opened = session.registry.openOrGetDocument(entry.portable_path, facts);
      if (!opened.ok) return opened as { ok: false; rejection: WorkspaceRejection };
      document = opened.value;
    }
  } else if (entry.action_type === "file_create") {
    if (session.registry.hasDocumentForKey(key)) {
      return rejected("FILE_EXISTS", `document '${entry.portable_path}' already has a live document (case aliases collide)`);
    }
    const facts = seedFactsForKey(seed, key);
    if (facts.present) return rejected("FILE_EXISTS", `document '${entry.portable_path}' already exists in the reviewed workspace`);
    if (!seedHasParentDirectory(seed, entry.portable_path)) {
      return rejected("FILE_NOT_FOUND", `document '${entry.portable_path}' has no reviewed parent directory: parents are never invented`);
    }
    const created = session.registry.createPendingDocument(entry.portable_path);
    if (!created.ok) return created as { ok: false; rejection: WorkspaceRejection };
    document = created.value;
  } else if (entry.action_type === "file_save") {
    const known = findLiveDocument(session.registry, key);
    if (known === null) return rejected("FILE_NOT_FOUND", `save target '${entry.portable_path}' has no live document: open or create it first`);
    // P6.6 save admission reserves only: clean marking requires verified byte
    // publication (P6.10). The reservation sequences the save after the edits
    // it persists without claiming persistence happened.
    const reserved = session.registry.reserveDocumentOperation(known.document_id, operation_id, false);
    if (!reserved.ok) return reserved as { ok: false; rejection: WorkspaceRejection };
    document = reserved.value;
  } else {
    // type_code / replace_code: the target must already be a live document
    // (prior open/create admission in authored order). There is no
    // unloaded-document admission state in P6.6.
    const known = findLiveDocument(session.registry, key);
    if (known === null) {
      return rejected("FILE_NOT_FOUND", `target '${entry.portable_path}' has no live document: open or create it first`);
    }
    // The reservation marks the buffer dirty at admission: an admitted edit
    // will mutate the buffer, so terminal RW must already fence (fail-closed)
    // before the owning execution task runs. Buffer text and revision
    // advances belong to P6.8/P6.9.
    const reserved = session.registry.reserveDocumentOperation(known.document_id, operation_id, true);
    if (!reserved.ok) return reserved as { ok: false; rejection: WorkspaceRejection };
    document = reserved.value;
  }

  state.attemptSeq += 1;
  const attemptId = `att-${state.attemptSeq}`;
  const envelope = {
    kind: "editor_operation_admission",
    admission_version: EDITOR_ADMISSION_VERSION,
    session_id: session.sessionId,
    generation: session.generation,
    operation_id,
    request_id,
    attempt_id: attemptId,
    action_type: entry.action_type,
    scene_id: entry.scene_id,
    beat_id: entry.beat_id,
    editor_ordinal: entry.editor_ordinal,
    portable_path: entry.portable_path,
    document_id: document.document_id,
    lesson_compiled_digest: session.catalog.lesson_compiled_digest,
  } as const;
  const envelopeCheck = EditorOperationAdmissionSchema.safeParse(envelope);
  if (!envelopeCheck.success) {
    return rejected("INVALID_REQUEST", "internal: issued admission failed strict validation");
  }
  const admission: EditorOperationAdmission = deepFreeze({
    record: envelopeCheck.data,
    parameters: entry.parameters,
    document,
  });
  const response: WorkspaceOutcome<EditorOperationAdmission> = { ok: true, value: admission };
  state.receipts.set(request_id, { scopeHash, response });
  state.tombstones.set(operation_id, { requestId: request_id });
  state.nextEditorOrdinal += 1;
  return response;
}

function nextExpectedOperationId(session: EditorSession, state: SessionState): string | null {
  const ordinal = state.nextEditorOrdinal;
  for (const id of session.catalog.editor_order) {
    const entry = session.catalog.operations.get(id);
    if (entry !== undefined && entry.editor_ordinal === ordinal) return id;
  }
  return null;
}

function findLiveDocument(registry: DocumentRegistry, canonicalKey: string): EditorDocumentDescriptor | null {
  for (const descriptor of registry.listDocuments()) {
    if (canonicalDocumentKey(descriptor.portable_path) === canonicalKey) return descriptor;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Coordinator seam: trusted buffer facts for terminal RW gating.
// ---------------------------------------------------------------------------

/**
 * Trusted dirty/pending counts for the WorkspaceCoordinator's
 * capability-gated setBufferFacts seam. Derived from the main-owned registry,
 * never from renderer claims: the renderer cannot forge cleanliness because
 * it cannot reach this function (main-only module) and cannot fabricate the
 * live session handle it requires.
 */
export function editorBufferFacts(session: EditorSession): {
  readonly dirtyBufferCount: number;
  readonly pendingCreationCount: number;
} {
  return session.registry.bufferFacts();
}

/** Renderer-safe document list for the coordinator's setOpenDocuments seam (identifiers/revisions/flags only). */
export function editorSnapshotDocuments(session: EditorSession): SnapshotDocument[] {
  return session.registry.snapshotDocuments();
}

/** Late-completion fence: true only for a strict descriptor naming a live document of this session generation. */
export function isLiveAdmissionDocument(session: EditorSession, descriptor: unknown): boolean {
  return isLiveDocumentDescriptor(session.registry, descriptor);
}

export type { EditorDocumentDescriptor };
