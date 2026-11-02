// P6.6 main-owned document registry — the single authority for unsaved editor state.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 5 (editor authority),
// 6 (workspace/file authority: disk D is committed truth, main B is the
// authoritative unsaved document, Monaco V is disposable presentation), 10
// (open/create/save document rules), 22 task P6.6 ("Admission and documents";
// PASS "Exact IDs/order/digest and duplicates tests"), 26.5 (file
// generations: ledger key, seed revision 0, buffer revision independent of
// disk revision) and docs/adr/ADR-0011-shared-workspace-ownership.md
// decision 5 (main owns unsaved text; disk owns committed text).
//
// Canonical P6.6 name: P6.6 Admission and documents.
// Objective: the trusted admission path for editor/document operations plus
// the main-owned document model required by later typing tasks.
//
// Owned scope (and only this):
//   - ONE main-owned registry per session generation holding every live
//     editor document descriptor: identity, logical path, generation binding,
//     base disk revision/digest/existence, independent buffer revision,
//     dirty/clean truth, opened vs created-but-unsaved state, per-document
//     ordered operation log, external-modification and invalidation flags;
//   - deterministic document identity: one logical document per
//     normalized/canonical file; Windows case aliases resolve to the same
//     document (P6.4 case policy preserved: no second writable authority for
//     src/App.ts vs src/app.ts);
//   - main-owned dirty truth consumed by the WorkspaceCoordinator through the
//     existing capability-gated setBufferFacts/setOpenDocuments seam (the
//     renderer can never forge cleanliness);
//   - external-modification fencing: a disk change after open never silently
//     updates or overwrites the main buffer; clean documents accept fresh
//     main-held facts, dirty/pending documents require reset;
//   - reset/close invalidation: old descriptors fence as STALE_SESSION, late
//     completions cannot reopen documents.
//
// Explicit non-scope (owned by later tasks, represented here only as
// explicitly marked reservation fields or not at all):
//   - P6.7 open/create execution (adapter reads, staged content bytes);
// P6.7 amendment (additive only): the adapter reads and staged content bytes
// above are held THROUGH this registry by the P6.7 content store below
// (setBufferContent / getBufferContent / hasBufferContent) — the single
// main-owned holder of executed buffer text. There is no second content
// authority. No P6.6 descriptor shape, method signature or behavior changed.
// P6.10 amendment (additive only): verified save commits bind through the
// noteSaveCommitted seam below (pending to opened, dirty to clean, base
// revision plus one, buffer revision and text preserved). No P6.6/P6.7
// descriptor shape, method signature or behavior changed.
//   - P6.8 type planner/scheduler (UTF-16 ranges, graphemes, pacing);
//   - P6.9 exact replacement (match guards, transactional plans);
//   - P6.10 save persistence and journals (byte verification, revision
//     increments on commit, clean marking after verified publication);
//   - P6.12 IPC/Monaco wiring (no preload/renderer import of this module);
//   - P6.13 terminal interop beyond the buffer-facts seam (no containers).
// This module performs zero disk I/O, zero container work, zero presentation
// behavior and zero wall-clock reads. Base disk facts arrive only as
// main-held reviewed seed-manifest entries or explicit main-only
// noteCommittedDiskFacts calls (fed later by verified adapter reads); the
// renderer supplies nothing.
//
// Trust model:
//   - The registry object is a live main-held value, never serialized. The
//     renderer cannot construct or forge it; renderer input arrives only as
//     strict identifier-only DTOs parsed by the admission layer.
//   - Document descriptors are renderer-safe snapshots: opaque document ids
//     plus logical portable paths, revisions and flags only. Host absolute
//     paths cannot be expressed here by construction (no such field exists).
//   - A dirty buffer knows the committed disk revision it originated from
//     (base_disk_revision/base_digest); future save must compare, never
//     silently overwrite (enforced here by external-modification fencing,
//     completed by P6.10 byte verification).

import { z } from "zod";
import {
  OpaqueHandleSchema,
  PortablePathSchema,
  Sha256HexSchema,
  SnapshotDocumentSchema,
  WorkspaceIdentifierSchema,
  type SnapshotDocument,
  type WorkspaceOutcome,
  type WorkspaceRejection,
} from "./protocol.ts";
import type { SeedManifest } from "./policy.ts";

/** Registry protocol version (matches the workspace protocol). */
export const EDITOR_DOCUMENTS_VERSION = 1;

/** Bounded live documents per session generation (spec section 18: 256 documents). */
export const EDITOR_DOCUMENT_LIMIT = 256;

function rejected(code: WorkspaceRejection["code"], message: string): { ok: false; rejection: WorkspaceRejection } {
  return { ok: false, rejection: { code, message } };
}

/**
 * Canonical document identity key for one portable path. Windows treats file
 * names case-insensitively (P6.4), so identity lowercases the portable path:
 * src/App.ts and src/app.ts resolve to the same document and can never form
 * two writable authorities. The display path keeps the first-seen authored
 * form; only the key is normalized.
 */
export function canonicalDocumentKey(portablePath: string): string {
  return portablePath.toLowerCase();
}

/** Live document lifecycle state owned by P6.6 (execution states belong to later tasks). */
export const EditorDocumentStateSchema = z.enum(["opened", "pending_creation"]);
export type EditorDocumentState = z.infer<typeof EditorDocumentStateSchema>;

/**
 * Renderer-safe document descriptor. Logical identifiers, revisions and flags
 * only: opaque document id, lesson-relative display path, generation binding,
 * base disk facts, independent buffer revision, dirty truth, reservation and
 * fencing flags, and the ordered admitted-operation log (identifiers only).
 * No host path, no source text, no capability token exists in this DTO.
 */
export const EditorDocumentDescriptorSchema = z.strictObject({
  document_id: OpaqueHandleSchema,
  portable_path: PortablePathSchema,
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  state: EditorDocumentStateSchema,
  base_disk_revision: z.number().int().min(0),
  base_digest: Sha256HexSchema.nullable(),
  base_exists: z.boolean(),
  buffer_revision: z.number().int().min(0),
  dirty: z.boolean(),
  reserved_operation_id: WorkspaceIdentifierSchema.nullable(),
  externally_modified: z.boolean(),
  invalidated: z.boolean(),
  admitted_operations: z.array(WorkspaceIdentifierSchema).max(10000),
});
export type EditorDocumentDescriptor = z.infer<typeof EditorDocumentDescriptorSchema>;

/** Dirty means the working document differs from disk or is pending creation (spec section 6). */
export function isDirtyDocument(descriptor: EditorDocumentDescriptor): boolean {
  return descriptor.dirty;
}

/** Main-held seed facts for one portable path (reviewed manifest, never renderer input). */
export interface SeedDiskFacts {
  readonly present: boolean;
  readonly isDirectory: boolean;
  readonly digest: string | null;
}

/** Resolve reviewed seed facts for a canonical document key (case-insensitive, Windows identity). */
export function seedFactsForKey(seedManifest: SeedManifest, canonicalKey: string): SeedDiskFacts {
  for (const entry of seedManifest.entries) {
    if (entry.portable_path.toLowerCase() !== canonicalKey) continue;
    if (entry.kind === "directory") return { present: true, isDirectory: true, digest: null };
    return { present: true, isDirectory: false, digest: entry.sha256 };
  }
  return { present: false, isDirectory: false, digest: null };
}

/** True when the portable path is top-level (no parent directory to check). */
export function isTopLevelPath(portablePath: string): boolean {
  return !portablePath.includes("/");
}

/** Parent directory of a nested portable path (caller guarantees non-top-level). */
export function parentDirectoryOf(portablePath: string): string {
  return portablePath.slice(0, portablePath.lastIndexOf("/"));
}

/** True when the reviewed seed manifest carries a directory entry for the parent (case-insensitive). */
export function seedHasParentDirectory(seedManifest: SeedManifest, portablePath: string): boolean {
  if (isTopLevelPath(portablePath)) return true;
  const parentKey = parentDirectoryOf(portablePath).toLowerCase();
  return seedManifest.entries.some((entry) => entry.kind === "directory" && entry.portable_path.toLowerCase() === parentKey);
}

interface DocumentRecord {
  descriptor: EditorDocumentDescriptor;
  canonicalKey: string;
}

/**
 * Main-owned document registry: ONE per session generation. Created by
 * main/orchestrator code holding the reviewed seed manifest; never built
 * from renderer input, never serialized to the renderer. All mutating
 * methods are main-only by construction (the live object is unforgeable).
 */
export interface DocumentRegistry {
  readonly sessionId: string;
  readonly generation: number;
  readonly retired: boolean;
  openOrGetDocument(portablePath: string, seedFacts: SeedDiskFacts): WorkspaceOutcome<EditorDocumentDescriptor>;
  createPendingDocument(portablePath: string): WorkspaceOutcome<EditorDocumentDescriptor>;
  /**
   * P6.7 executed buffer text (main-owned, single authority).
   *
   * Stores the exact text bound by open/create execution: byte-exact disk
   * bytes decoded by the trusted adapter (open) or verbatim authored content
   * from the trusted admission record (create). Buffer revision is left
   * untouched: P6.7 loads/stages content, P6.8/P6.9 own revision advances.
   * Text-profile authority stays at the boundary (adapter decode for open,
   * P6.6 admission for create); the store itself is profile-agnostic.
   * Rejects on retired registries (STALE_SESSION), unknown/invalidated
   * documents (STALE_SESSION) and externally-flagged documents
   * (EXTERNAL_MODIFICATION_CONFLICT, fail-closed: conflicted buffers are
   * preserved, never overwritten).
   */
  setBufferContent(documentId: string, content: string): WorkspaceOutcome<EditorDocumentDescriptor>;
  /**
   * Read executed buffer text. Rejects STALE_SESSION on retired registries
   * and unknown/invalidated documents; rejects FILE_NOT_FOUND when the live
   * document was admitted but never executed (no staged/loaded text yet).
   */
  getBufferContent(documentId: string): WorkspaceOutcome<string>;
  /** True when executed text is staged/loaded for a live document. */
  hasBufferContent(documentId: string): boolean;
  reserveDocumentOperation(documentId: string, operationId: string, markDirty: boolean): WorkspaceOutcome<EditorDocumentDescriptor>;
  noteCommittedDiskFacts(portablePath: string, exists: boolean, digest: string | null, revision: number): WorkspaceOutcome<EditorDocumentDescriptor>;
  /**
   * P6.10 verified save commit (main-owned, single authority).
   *
   * Binds the document to newly verified committed disk facts after the
   * trusted adapter published and byte-verified the exact main-owned buffer
   * bytes. Transitions pending_creation to opened with existence true,
   * clears dirty to false, advances the base disk revision once, preserves
   * the buffer revision and buffer text exactly, and clears the external
   * flag. Rejects on retired registries (STALE_SESSION),
   * unknown/invalidated documents (STALE_SESSION), externally-flagged
   * documents (EXTERNAL_MODIFICATION_CONFLICT, fail-closed), and
   * non-incremental revisions (INVALID_REQUEST). Clean no-op saves never
   * reach here (no revision increment). There is no second save state: the
   * P6.6 dirty reservation is completed here, never duplicated.
   */
  noteSaveCommitted(portablePath: string, exists: boolean, digest: string | null, revision: number): WorkspaceOutcome<EditorDocumentDescriptor>;
  noteExternalChange(portablePath: string, observedDigest: string | null): WorkspaceOutcome<EditorDocumentDescriptor>;
  resolveDocument(documentId: string): WorkspaceOutcome<EditorDocumentDescriptor>;
  hasDocumentForKey(canonicalKey: string): boolean;
  listDocuments(): readonly EditorDocumentDescriptor[];
  bufferFacts(): { readonly dirtyBufferCount: number; readonly pendingCreationCount: number };
  snapshotDocuments(): SnapshotDocument[];
  invalidateAll(): void;
}

export interface CreateDocumentRegistryArgs {
  readonly sessionId: string;
  readonly generation: number;
}

/** Freeze and return a copy of a live descriptor (callers never alias registry state). */
function freezeDescriptor(record: DocumentRecord): EditorDocumentDescriptor {
  const copy: EditorDocumentDescriptor = {
    ...record.descriptor,
    admitted_operations: [...record.descriptor.admitted_operations],
  };
  return Object.freeze(copy) as EditorDocumentDescriptor;
}

function checkDescriptorShape(descriptor: EditorDocumentDescriptor): string | null {
  const parsed = EditorDocumentDescriptorSchema.safeParse(descriptor);
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "descriptor failed strict validation";
  return null;
}

/**
 * Create the main-owned registry for one session generation. Seed revision
 * starts at 0 (spec 26.5); each document records the base disk revision it
 * originated from, independent of its buffer revision.
 */
export function createDocumentRegistry(args: CreateDocumentRegistryArgs): DocumentRegistry {
  const idCheck = WorkspaceIdentifierSchema.safeParse(args.sessionId);
  if (!idCheck.success) throw new TypeError("document registry requires a 1..128 character session id");
  if (!Number.isInteger(args.generation) || args.generation < 1) {
    throw new TypeError("document registry requires a generation >= 1");
  }
  const sessionId = args.sessionId;
  const generation = args.generation;
  let retired = false;
  let documentSeq = 0;
  const byId = new Map<string, DocumentRecord>();
  const byKey = new Map<string, DocumentRecord>();
  // P6.7 executed buffer text, keyed by opaque document id. Part of the same
  // registry authority (cleared by invalidateAll with the descriptors); there
  // is no second content store anywhere.
  const bufferText = new Map<string, string>();

  function liveCheck(): WorkspaceRejection | null {
    if (retired) return { code: "STALE_SESSION", message: "document registry was retired by reset or close" };
    return null;
  }

  function nextDocumentId(): string {
    documentSeq += 1;
    return `doc-${documentSeq}`;
  }

  const registry: DocumentRegistry = {
    get sessionId(): string {
      return sessionId;
    },
    get generation(): number {
      return generation;
    },
    get retired(): boolean {
      return retired;
    },

    openOrGetDocument(portablePath: string, seedFacts: SeedDiskFacts): WorkspaceOutcome<EditorDocumentDescriptor> {
      const fenced = liveCheck();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const pathCheck = PortablePathSchema.safeParse(portablePath);
      if (!pathCheck.success) return rejected("INVALID_REQUEST", "document path failed strict portable validation");
      const key = canonicalDocumentKey(pathCheck.data);
      const existing = byKey.get(key);
      // Duplicate open returns the ONE canonical document: a second writable
      // buffer for the same file is impossible by construction.
      if (existing !== undefined && !existing.descriptor.invalidated) return { ok: true, value: freezeDescriptor(existing) };
      if (seedFacts.isDirectory) return rejected("INVALID_REQUEST", `document '${pathCheck.data}' names a directory in the reviewed seed manifest`);
      if (!seedFacts.present) return rejected("FILE_NOT_FOUND", `document '${pathCheck.data}' is absent from the workspace and has no staged creation`);
      if (byId.size >= EDITOR_DOCUMENT_LIMIT) {
        return rejected("RESOURCE_LIMIT", `document registry is bounded to ${EDITOR_DOCUMENT_LIMIT} live documents`);
      }
      const record: DocumentRecord = {
        canonicalKey: key,
        descriptor: {
          document_id: nextDocumentId(),
          portable_path: pathCheck.data,
          session_id: sessionId,
          generation,
          state: "opened",
          base_disk_revision: 0,
          base_digest: seedFacts.digest,
          base_exists: true,
          buffer_revision: 0,
          dirty: false,
          reserved_operation_id: null,
          externally_modified: false,
          invalidated: false,
          admitted_operations: [],
        },
      };
      const shapeError = checkDescriptorShape(record.descriptor);
      if (shapeError !== null) return rejected("INVALID_REQUEST", `internal: issued descriptor failed strict validation (${shapeError})`);
      byId.set(record.descriptor.document_id, record);
      byKey.set(key, record);
      return { ok: true, value: freezeDescriptor(record) };
    },

    createPendingDocument(portablePath: string): WorkspaceOutcome<EditorDocumentDescriptor> {
      const fenced = liveCheck();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const pathCheck = PortablePathSchema.safeParse(portablePath);
      if (!pathCheck.success) return rejected("INVALID_REQUEST", "document path failed strict portable validation");
      const key = canonicalDocumentKey(pathCheck.data);
      // Collision semantics (spec section 10): an existing live document for
      // the same canonical file fails FILE_EXISTS; case aliases count as
      // existing because identity is case-insensitive.
      if (byKey.has(key)) return rejected("FILE_EXISTS", `document '${pathCheck.data}' already has a live document (case aliases collide)`);
      if (byId.size >= EDITOR_DOCUMENT_LIMIT) {
        return rejected("RESOURCE_LIMIT", `document registry is bounded to ${EDITOR_DOCUMENT_LIMIT} live documents`);
      }
      const record: DocumentRecord = {
        canonicalKey: key,
        descriptor: {
          document_id: nextDocumentId(),
          portable_path: pathCheck.data,
          session_id: sessionId,
          generation,
          state: "pending_creation",
          base_disk_revision: 0,
          base_digest: null,
          base_exists: false,
          buffer_revision: 0,
          dirty: true,
          reserved_operation_id: null,
          externally_modified: false,
          invalidated: false,
          admitted_operations: [],
        },
      };
      const shapeError = checkDescriptorShape(record.descriptor);
      if (shapeError !== null) return rejected("INVALID_REQUEST", `internal: issued descriptor failed strict validation (${shapeError})`);
      byId.set(record.descriptor.document_id, record);
      byKey.set(key, record);
      return { ok: true, value: freezeDescriptor(record) };
    },

    setBufferContent(documentId: string, content: string): WorkspaceOutcome<EditorDocumentDescriptor> {
      const fenced = liveCheck();
      if (fenced !== null) return { ok: false, rejection: fenced };
      if (typeof content !== "string") return rejected("INVALID_REQUEST", "buffer content must be text");
      const record = byId.get(documentId);
      if (record === undefined || record.descriptor.invalidated) {
        return rejected("STALE_SESSION", "document descriptor is unknown or was invalidated in this generation");
      }
      if (record.descriptor.externally_modified) {
        return rejected(
          "EXTERNAL_MODIFICATION_CONFLICT",
          "conflicted buffer is preserved: explicit reload (clean) or reset (dirty/pending) is required, never a silent overwrite",
        );
      }
      bufferText.set(documentId, content);
      return { ok: true, value: freezeDescriptor(record) };
    },

    getBufferContent(documentId: string): WorkspaceOutcome<string> {
      const fenced = liveCheck();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const record = byId.get(documentId);
      if (record === undefined || record.descriptor.invalidated) {
        return rejected("STALE_SESSION", "document descriptor is unknown or was invalidated in this generation");
      }
      const content = bufferText.get(documentId);
      if (content === undefined) {
        return rejected("FILE_NOT_FOUND", "document was admitted but never executed: no staged or loaded text exists");
      }
      return { ok: true, value: content };
    },

    hasBufferContent(documentId: string): boolean {
      if (retired) return false;
      const record = byId.get(documentId);
      if (record === undefined || record.descriptor.invalidated) return false;
      return bufferText.has(documentId);
    },

    reserveDocumentOperation(
      documentId: string,
      operationId: string,
      markDirty: boolean,
    ): WorkspaceOutcome<EditorDocumentDescriptor> {
      const fenced = liveCheck();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const record = byId.get(documentId);
      if (record === undefined || record.descriptor.invalidated) {
        return rejected("STALE_SESSION", "document descriptor is unknown or was invalidated in this generation");
      }
      if (record.descriptor.externally_modified) {
        return rejected(
          "EXTERNAL_MODIFICATION_CONFLICT",
          "document base diverged from committed disk: explicit reload (clean) or reset (dirty/pending) is required, never a silent overwrite",
        );
      }
      record.descriptor = {
        ...record.descriptor,
        dirty: record.descriptor.dirty || markDirty,
        reserved_operation_id: operationId,
        admitted_operations: [...record.descriptor.admitted_operations, operationId],
      };
      return { ok: true, value: freezeDescriptor(record) };
    },

    noteCommittedDiskFacts(
      portablePath: string,
      exists: boolean,
      digest: string | null,
      revision: number,
    ): WorkspaceOutcome<EditorDocumentDescriptor> {
      const fenced = liveCheck();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const pathCheck = PortablePathSchema.safeParse(portablePath);
      if (!pathCheck.success) return rejected("INVALID_REQUEST", "document path failed strict portable validation");
      if (!Number.isInteger(revision) || revision < 0) return rejected("INVALID_REQUEST", "disk revision must be a non-negative integer");
      if (digest !== null && !Sha256HexSchema.safeParse(digest).success) {
        return rejected("INVALID_REQUEST", "disk digest must be lowercase hex SHA-256 or null");
      }
      if (!exists && (digest !== null || revision !== 0)) {
        return rejected("INVALID_REQUEST", "an absent disk target must carry null digest and zero revision");
      }
      const record = byKey.get(canonicalDocumentKey(pathCheck.data));
      if (record === undefined || record.descriptor.invalidated) return rejected("FILE_NOT_FOUND", "no live document names this path in this generation");
      // A dirty or pending document never silently rebases onto new disk
      // facts: unexpected host mutation under a dirty buffer requires reset.
      if (record.descriptor.dirty || record.descriptor.state === "pending_creation") {
        return rejected(
          "EXTERNAL_MODIFICATION_CONFLICT",
          "dirty/pending document cannot adopt new disk facts: reset is required, never a silent rebase",
        );
      }
      record.descriptor = {
        ...record.descriptor,
        base_disk_revision: revision,
        base_digest: digest,
        base_exists: exists,
        externally_modified: false,
      };
      return { ok: true, value: freezeDescriptor(record) };
    },

    noteSaveCommitted(
      portablePath: string,
      exists: boolean,
      digest: string | null,
      revision: number,
    ): WorkspaceOutcome<EditorDocumentDescriptor> {
      const fenced = liveCheck();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const pathCheck = PortablePathSchema.safeParse(portablePath);
      if (!pathCheck.success) return rejected("INVALID_REQUEST", "document path failed strict portable validation");
      if (!Number.isInteger(revision) || revision < 0) return rejected("INVALID_REQUEST", "disk revision must be a non-negative integer");
      if (digest !== null && !Sha256HexSchema.safeParse(digest).success) {
        return rejected("INVALID_REQUEST", "disk digest must be lowercase hex SHA-256 or null");
      }
      if (!exists) return rejected("INVALID_REQUEST", "a verified save always publishes existence: absent commits never mark clean");
      if (digest === null) return rejected("INVALID_REQUEST", "a verified save always binds its byte digest");
      const record = byKey.get(canonicalDocumentKey(pathCheck.data));
      if (record === undefined || record.descriptor.invalidated) return rejected("FILE_NOT_FOUND", "no live document names this path in this generation");
      if (record.descriptor.externally_modified) {
        return rejected(
          "EXTERNAL_MODIFICATION_CONFLICT",
          "conflicted document cannot bind a save revision: explicit reload (clean) or reset (dirty/pending) is required",
        );
      }
      if (revision !== record.descriptor.base_disk_revision + 1) {
        return rejected("INVALID_REQUEST", "verified save advances the base disk revision exactly once");
      }
      record.descriptor = {
        ...record.descriptor,
        state: "opened",
        base_disk_revision: revision,
        base_digest: digest,
        base_exists: true,
        dirty: false,
        reserved_operation_id: record.descriptor.reserved_operation_id,
        externally_modified: false,
      };
      const shapeError = checkDescriptorShape(record.descriptor);
      if (shapeError !== null) return rejected("INVALID_REQUEST", `internal: save-committed descriptor failed strict validation (${shapeError})`);
      return { ok: true, value: freezeDescriptor(record) };
    },

    noteExternalChange(portablePath: string, observedDigest: string | null): WorkspaceOutcome<EditorDocumentDescriptor> {
      const fenced = liveCheck();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const pathCheck = PortablePathSchema.safeParse(portablePath);
      if (!pathCheck.success) return rejected("INVALID_REQUEST", "document path failed strict portable validation");
      const record = byKey.get(canonicalDocumentKey(pathCheck.data));
      if (record === undefined || record.descriptor.invalidated) return rejected("FILE_NOT_FOUND", "no live document names this path in this generation");
      // Identical digest means no divergence: report clean agreement with zero
      // mutation of the fencing flag.
      if ((record.descriptor.base_digest ?? null) === (observedDigest ?? null)) {
        return { ok: true, value: freezeDescriptor(record) };
      }
      record.descriptor = { ...record.descriptor, externally_modified: true };
      return { ok: true, value: freezeDescriptor(record) };
    },

    resolveDocument(documentId: string): WorkspaceOutcome<EditorDocumentDescriptor> {
      const fenced = liveCheck();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const record = byId.get(documentId);
      if (record === undefined || record.descriptor.invalidated) {
        return rejected("STALE_SESSION", "document descriptor is unknown or was invalidated in this generation");
      }
      return { ok: true, value: freezeDescriptor(record) };
    },

    hasDocumentForKey(canonicalKey: string): boolean {
      const record = byKey.get(canonicalKey);
      return record !== undefined && !record.descriptor.invalidated;
    },

    listDocuments(): readonly EditorDocumentDescriptor[] {
      return [...byId.values()]
        .filter((record) => !record.descriptor.invalidated)
        .map((record) => freezeDescriptor(record));
    },

    bufferFacts(): { readonly dirtyBufferCount: number; readonly pendingCreationCount: number } {
      let dirtyBufferCount = 0;
      let pendingCreationCount = 0;
      for (const record of byId.values()) {
        if (record.descriptor.invalidated) continue;
        if (record.descriptor.state === "pending_creation") {
          pendingCreationCount += 1;
        } else if (record.descriptor.dirty) {
          dirtyBufferCount += 1;
        }
      }
      // Pending creations are dirty by definition (spec section 6), but the
      // coordinator counts them separately: report both counters exactly.
      return { dirtyBufferCount, pendingCreationCount };
    },

    snapshotDocuments(): SnapshotDocument[] {
      const snapshots: SnapshotDocument[] = [];
      for (const record of byId.values()) {
        if (record.descriptor.invalidated) continue;
        const parsed = SnapshotDocumentSchema.safeParse({
          portable_path: record.descriptor.portable_path,
          disk_revision: record.descriptor.base_disk_revision,
          buffer_revision: record.descriptor.buffer_revision,
          dirty: record.descriptor.dirty,
        });
        // Descriptors are shape-checked at creation; a snapshot failure here
        // is an internal invariant violation, never renderer input.
        if (!parsed.success) throw new Error("internal: document snapshot failed strict validation");
        snapshots.push(parsed.data);
      }
      return snapshots;
    },

    invalidateAll(): void {
      retired = true;
      for (const record of byId.values()) {
        record.descriptor = { ...record.descriptor, invalidated: true };
      }
      byId.clear();
      byKey.clear();
      // P6.7: executed/staged text vanishes with the generation (abandoned
      // pending creations and late completions can never resurface).
      bufferText.clear();
    },
  };

  return registry;
}

/**
 * Late-completion fence for future execution tasks: true only when the
 * presented descriptor is a strict descriptor naming a live document of this
 * exact registry generation. Stale generations, retired registries and forged
 * shapes all fence closed.
 */
export function isLiveDocumentDescriptor(registry: DocumentRegistry, descriptor: unknown): boolean {
  const parsed = EditorDocumentDescriptorSchema.safeParse(descriptor);
  if (!parsed.success) return false;
  const value = parsed.data;
  if (value.invalidated) return false;
  if (value.session_id !== registry.sessionId || value.generation !== registry.generation) return false;
  if (registry.retired) return false;
  const resolved = registry.resolveDocument(value.document_id);
  if (!resolved.ok) return false;
  return resolved.value.portable_path.toLowerCase() === value.portable_path.toLowerCase();
}
