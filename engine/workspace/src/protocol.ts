// P6.1 shared workspace protocol — workspace_protocol_version = 1.
//
// Main-owned coordination vocabulary for ONE lesson workspace shared by the
// P5 terminal engine and the P6 typing engine. Canonical authority:
// docs/P6-DESIGN-SPEC.md section 26 and
// docs/adr/ADR-0011-shared-workspace-ownership.md.
//
// This module is contract-only: pure Zod schemas plus pure transition and
// fencing predicates. Zero behavior, zero I/O, zero process/container work.
// It may be imported by main-process code only; it is never renderer input.
//
// Frozen model encoded here (P6.0, do not reinterpret):
//   - exclusive writer periods: at most one writer owns the leaf at any time;
//   - the coordinator is main-owned; editor buffers are main-owned;
//   - disk is the committed workspace authority; file_save is the publication
//     boundary (publication itself is a later task);
//   - access changes use container lifecycle/epochs (recreation, never
//     in-place remount); access choice is main-only reviewed policy;
//   - the renderer never selects access; lesson source and compiled IR carry
//     no access fields (no schema/IR change).
//
// Portable means portable: no DTO in this module can express a host absolute
// path. Host paths live only in main-held runtime state owned by a later
// task, never in these contracts.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Version — independent workspace protocol version. Evolves separately from
// the lesson source schema (1.1), the compiled IR (1.0) and the terminal
// runtime protocol (runtime_event_version = 1); the contracts never drift.
// ---------------------------------------------------------------------------

export const WORKSPACE_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Identifiers, digests, opaque handles, portable paths.
// ---------------------------------------------------------------------------

/** Runtime/lesson identifiers: 1-128 chars (same bound as the P5 IPC rule). */
export const WorkspaceIdentifierSchema = z.string().min(1).max(128);
export type WorkspaceIdentifier = z.infer<typeof WorkspaceIdentifierSchema>;

/** Lowercase hex SHA-256 digest (seed/policy/compiled bindings). */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/**
 * Opaque main-issued handle (workspace, lease, file identity, plan). The
 * shape deliberately cannot express a filesystem path: no separators, no
 * drive letters, no whitespace.
 */
export const OpaqueHandleSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export type OpaqueHandle = z.infer<typeof OpaqueHandleSchema>;

const PORTABLE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;
/** Windows reserved device basenames (checked per path segment, case-insensitive). */
const RESERVED_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * Lesson-relative portable path (same machine-independence rule as authored
 * file paths: project-relative POSIX, no absolute/drive/UNC/device/ADS
 * forms, no traversal, no empty segments, no reserved names, no trailing
 * dots/spaces, no controls/NUL). Host absolute paths cannot parse here by
 * construction. Case-alias and collision detection needs the live tree and
 * belongs to a later task, not to this static contract.
 */
export const PortablePathSchema = z.string().superRefine((value, ctx) => {
  const problems: string[] = [];
  if (value.length === 0) problems.push("empty path");
  if (value.includes("\\")) problems.push("backslashes are not allowed (use '/')");
  if (/^[A-Za-z]:/.test(value)) problems.push("drive letters are not allowed");
  if (value.startsWith("/")) problems.push("leading '/' is not allowed (must be lesson-relative)");
  if (value.startsWith("//")) problems.push("UNC prefixes are not allowed");
  if (value.includes(":") || value.toLowerCase().includes("::$")) {
    problems.push("drive/ADS separators are not allowed");
  }
  if (value.includes("\0")) problems.push("NUL is not allowed");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) problems.push("control characters are not allowed");
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    problems.push("empty segments (double, leading or trailing slashes) are not allowed");
  }
  if (segments.includes("..") || segments.includes(".")) {
    problems.push("dot segments are not allowed");
  }
  for (const segment of segments) {
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      problems.push(`segment '${segment}' must not end with a space or dot`);
    }
    const basename = segment.split(".")[0].toLowerCase();
    if (RESERVED_BASENAMES.has(basename)) {
      problems.push(`segment '${segment}' is a reserved device name`);
    }
  }
  if (!PORTABLE_PATH_PATTERN.test(value)) {
    problems.push("characters outside [A-Za-z0-9_-./] are not allowed");
  }
  if (problems.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: `[INVALID_PORTABLE_PATH] '${value}' is not a valid lesson-relative path: ${problems.join("; ")}`,
    });
  }
});
export type PortablePath = z.infer<typeof PortablePathSchema>;

// ---------------------------------------------------------------------------
// Access capabilities and ownership states — the exact frozen vocabulary.
//
// TerminalWorkspaceAccess is the per-operation reviewed value from
// ReviewedWorkspacePolicyV1 (spec section 26.2): read_only | read_write.
// WorkspaceOwnership is the coordinator state (spec section 26.1). The two
// combine without ambiguity: EDITOR_OWNED admits the file adapter as the
// sole writer (a verified read-only container may coexist for background
// observation); TERMINAL_OWNED admits exactly one read-write guest process
// tree and no host access; TRANSITION/RESETTING/CLOSING/HOLD admit no
// authored writer at all.
// ---------------------------------------------------------------------------

/** Reviewed per-operation terminal access (spec 26.2, exact names). */
export const TerminalWorkspaceAccessSchema = z.enum(["read_only", "read_write"]);
export type TerminalWorkspaceAccess = z.infer<typeof TerminalWorkspaceAccessSchema>;

/** Coordinator ownership states (spec 26.1, exact names). */
export const WorkspaceOwnershipSchema = z.enum([
  "EDITOR_OWNED",
  "TERMINAL_OWNED",
  "TRANSITION",
  "RESETTING",
  "CLOSING",
  "HOLD",
]);
export type WorkspaceOwnership = z.infer<typeof WorkspaceOwnershipSchema>;

/** The single active writer a state admits. There is no state with two writers. */
export const WorkspaceWriterSchema = z.enum(["editor_adapter", "terminal_rw", "none"]);
export type WorkspaceWriter = z.infer<typeof WorkspaceWriterSchema>;

/** Which writer owns the leaf in each state. Read-only observers are readers, never writers. */
export function ownershipWriter(state: WorkspaceOwnership): WorkspaceWriter {
  switch (state) {
    case "EDITOR_OWNED":
      return "editor_adapter";
    case "TERMINAL_OWNED":
      return "terminal_rw";
    case "TRANSITION":
    case "RESETTING":
    case "CLOSING":
    case "HOLD":
      return "none";
  }
}

/** True only for the editor-owned write period (main file adapter may publish). */
export function allowsEditorWrite(state: WorkspaceOwnership): boolean {
  return ownershipWriter(state) === "editor_adapter";
}

/** True only while the read-write guest tree owns the leaf (no host access). */
export function allowsTerminalWrite(state: WorkspaceOwnership): boolean {
  return ownershipWriter(state) === "terminal_rw";
}

/**
 * True while approved background observation may coexist with editing: the
 * editor-owned state with a verified read-only bind. Read-write ownership
 * never admits background peers.
 */
export function allowsBackgroundObservation(state: WorkspaceOwnership): boolean {
  return state === "EDITOR_OWNED";
}

// ---------------------------------------------------------------------------
// Ownership transitions — fail-closed. Direct EDITOR_OWNED <-> TERMINAL_OWNED
// hops are illegal: every access change passes through TRANSITION (revoke,
// retire, verify absence, prepare next epoch). HOLD never returns directly
// to an owned state: recovery goes through the reset barrier, which issues a
// new session identity and generation rather than reusing the old leaf.
// ---------------------------------------------------------------------------

const LEGAL_OWNERSHIP_TRANSITIONS: Readonly<Record<WorkspaceOwnership, readonly WorkspaceOwnership[]>> =
  Object.freeze({
    EDITOR_OWNED: ["TRANSITION", "RESETTING", "CLOSING", "HOLD"],
    TERMINAL_OWNED: ["TRANSITION", "RESETTING", "CLOSING", "HOLD"],
    TRANSITION: ["EDITOR_OWNED", "TERMINAL_OWNED", "RESETTING", "CLOSING", "HOLD"],
    RESETTING: ["HOLD", "CLOSING"],
    CLOSING: ["HOLD"],
    HOLD: ["RESETTING", "CLOSING"],
  });

/** Fail-closed transition check: unknown or unlisted hops reject. */
export function isLegalOwnershipTransition(from: WorkspaceOwnership, to: WorkspaceOwnership): boolean {
  const allowed = LEGAL_OWNERSHIP_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/**
 * Steady-state ownership/access pairing (spec 26.1-26.4). EDITOR_OWNED admits
 * no container or one verified read-only container; TERMINAL_OWNED admits
 * exactly the read-write epoch; barriers admit no authored writer (TRANSITION
 * transiently holds the retiring/preparing epoch while no authored operation
 * may start; RESETTING/CLOSING/HOLD expose no live access — an unconfirmed
 * lingering container is a HOLD retirement record owned by a later task, not
 * a live capability).
 */
export function isValidOwnershipAccess(
  ownership: WorkspaceOwnership,
  epochAccess: TerminalWorkspaceAccess | null,
): boolean {
  switch (ownership) {
    case "EDITOR_OWNED":
      return epochAccess === null || epochAccess === "read_only";
    case "TERMINAL_OWNED":
      return epochAccess === "read_write";
    case "TRANSITION":
      return true;
    case "RESETTING":
    case "CLOSING":
    case "HOLD":
      return epochAccess === null;
  }
}

// ---------------------------------------------------------------------------
// Container epoch identity — runtime-only, main-owned.
//
// The workspace identity is portable (course/lesson/session/generation plus
// an opaque workspace handle and a monotonic workspace revision). The
// container epoch is a replaceable execution resource bound to one access
// value: mount permission is fixed at creation and never changed in place.
// Epochs are monotonic per session generation, never authored, never
// renderer-selected; stale epochs reject.
// ---------------------------------------------------------------------------

/** Portable workspace identity. No host path can be expressed here. */
export const WorkspaceIdentitySchema = z.strictObject({
  workspace_protocol_version: z.literal(WORKSPACE_PROTOCOL_VERSION),
  course_id: WorkspaceIdentifierSchema,
  lesson_id: WorkspaceIdentifierSchema,
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  workspace_id: OpaqueHandleSchema,
  workspace_revision: z.number().int().min(0),
});
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

/** One container epoch: exactly one access value for its whole lifetime. */
export const ContainerEpochSchema = z.strictObject({
  workspace_protocol_version: z.literal(WORKSPACE_PROTOCOL_VERSION),
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  /** Monotonic per session generation; starts at 1. */
  epoch: z.number().int().min(1),
  access: TerminalWorkspaceAccessSchema,
  lease_id: OpaqueHandleSchema,
});
export type ContainerEpoch = z.infer<typeof ContainerEpochSchema>;

/** Next epoch number for a live epoch (monotonic, never reused). */
export function nextEpochNumber(currentEpoch: number): number {
  return currentEpoch + 1;
}

/** True when the presented epoch is not the live one (stale epochs reject). */
export function isStaleEpoch(liveEpoch: number, presentedEpoch: number): boolean {
  return presentedEpoch !== liveEpoch;
}

/** True when the presented generation is not the live one (old generations fence). */
export function isStaleGeneration(liveGeneration: number, presentedGeneration: number): boolean {
  return presentedGeneration !== liveGeneration;
}

// ---------------------------------------------------------------------------
// File revisions and editor buffer descriptors (protocol shapes only).
//
// Ledger key (spec 26.5): (session_id, generation, portable_path). Disk is
// the committed authority; main holds the unsaved working document; the
// presentation surface is disposable. Typing changes only the buffer
// revision; only a verified save advances disk and workspace revisions
// (later tasks). Renderer submissions never carry authoritative digests or
// revisions: those arrive only in main-owned records.
// ---------------------------------------------------------------------------

/** Committed disk facts for one lesson-relative file. */
export const FileDiskRecordSchema = z
  .strictObject({
    portable_path: PortablePathSchema,
    disk_revision: z.number().int().min(0),
    exists: z.boolean(),
    /** Byte digest of the committed file; null exactly when the file is absent. */
    digest: Sha256HexSchema.nullable(),
    byte_length: z.number().int().min(0),
    /** Adapter-observed file identity; null exactly when the file is absent. */
    file_identity: OpaqueHandleSchema.nullable(),
    observed_workspace_revision: z.number().int().min(0),
  })
  .superRefine((record, ctx) => {
    if (!record.exists && (record.digest !== null || record.byte_length !== 0 || record.file_identity !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "[FILE_RECORD_INCONSISTENT] an absent file must carry null digest, zero length and null identity",
      });
    }
    if (record.exists && (record.digest === null || record.file_identity === null)) {
      ctx.addIssue({
        code: "custom",
        message: "[FILE_RECORD_INCONSISTENT] a present file must carry a digest and an observed identity",
      });
    }
  });
export type FileDiskRecord = z.infer<typeof FileDiskRecordSchema>;

/** Main-owned unsaved editor document facts (no text content in this DTO). */
export const BufferDescriptorSchema = z.strictObject({
  portable_path: PortablePathSchema,
  base_disk_revision: z.number().int().min(0),
  base_digest: Sha256HexSchema.nullable(),
  base_exists: z.boolean(),
  buffer_revision: z.number().int().min(0),
  dirty: z.boolean(),
  generation: z.number().int().min(1),
});
export type BufferDescriptor = z.infer<typeof BufferDescriptorSchema>;

/** Dirty means the working document differs from disk or is pending creation. */
export function isDirtyBuffer(descriptor: BufferDescriptor): boolean {
  return descriptor.dirty;
}

// ---------------------------------------------------------------------------
// Read-write admission preconditions (pure policy check, no I/O).
//
// A read-write terminal epoch requires exclusivity BEFORE any container
// work: no dirty or pending editor state, no active terminal peer, no save
// in flight, and editor-owned current state. This predicate encodes the
// frozen rules; the actual epoch recreation is a later task.
// ---------------------------------------------------------------------------

export const TerminalRWPreconditionsSchema = z.strictObject({
  ownership: WorkspaceOwnershipSchema,
  dirty_buffer_count: z.number().int().min(0),
  pending_creation_count: z.number().int().min(0),
  active_terminal_peers: z.number().int().min(0),
  save_active: z.boolean(),
});
export type TerminalRWPreconditions = z.infer<typeof TerminalRWPreconditionsSchema>;

/** Fail-closed exclusivity check for read-write admission. */
export function checkTerminalRWPreconditions(
  preconditions: TerminalRWPreconditions,
): { ok: true } | { ok: false; code: "DIRTY_BUFFER_CONFLICT" | "WORKSPACE_BUSY" | "INVALID_TRANSITION" } {
  const parsed = TerminalRWPreconditionsSchema.safeParse(preconditions);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_TRANSITION" };
  }
  const value = parsed.data;
  if (value.ownership !== "EDITOR_OWNED") {
    return { ok: false, code: "INVALID_TRANSITION" };
  }
  if (value.save_active) {
    return { ok: false, code: "WORKSPACE_BUSY" };
  }
  if (value.dirty_buffer_count > 0 || value.pending_creation_count > 0) {
    return { ok: false, code: "DIRTY_BUFFER_CONFLICT" };
  }
  if (value.active_terminal_peers > 0) {
    return { ok: false, code: "WORKSPACE_BUSY" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// WorkspaceExecutionPermitV1 — the private wrapper binding a validated
// terminal grant to policy, session/generation, epoch, access and an opaque
// coordinator lease. Coordinator-issued only (later task); branding alone
// is not authority — the provider rechecks it against live reservation
// state. The renderer cannot submit this wrapper: no renderer DTO carries
// these fields.
// ---------------------------------------------------------------------------

export const WORKSPACE_PERMIT_VERSION = 1;

export const WorkspaceExecutionPermitSchema = z.strictObject({
  kind: z.literal("workspace_execution_permit"),
  permit_version: z.literal(WORKSPACE_PERMIT_VERSION),
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  workspace_id: OpaqueHandleSchema,
  epoch: z.number().int().min(1),
  access: TerminalWorkspaceAccessSchema,
  /** Admitted terminal operation, or null for an epoch-preparation permit with empty initial grants. */
  operation_id: WorkspaceIdentifierSchema.nullable(),
  policy_digest: Sha256HexSchema,
  lease_id: OpaqueHandleSchema,
});
export type WorkspaceExecutionPermit = z.infer<typeof WorkspaceExecutionPermitSchema>;

/** Live coordinator facts a presented permit is checked against (main-held, never renderer input). */
export const LiveWorkspaceFactsSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  workspace_id: OpaqueHandleSchema,
  epoch: z.number().int().min(1),
  policy_digest: Sha256HexSchema,
  /** Lease ids revoked by reset/close/retirement (later task owns the set). */
  revoked_lease_ids: z.array(OpaqueHandleSchema),
});
export type LiveWorkspaceFacts = z.infer<typeof LiveWorkspaceFactsSchema>;

/**
 * Fail-closed permit acquisition check (pure, no I/O): session mismatch
 * rejects WRONG_OWNER; old generation rejects STALE_SESSION; old epoch
 * rejects STALE_EPOCH; revoked lease rejects WORKSPACE_REVOKED; policy
 * drift rejects NOT_AUTHORIZED. Later tasks call this before any epoch or
 * provider work; P6.1 proves the fencing logic here.
 */
export function checkPermitAcquisition(
  permit: WorkspaceExecutionPermit,
  live: LiveWorkspaceFacts,
): { ok: true } | { ok: false; rejection: WorkspaceRejection } {
  const parsedPermit = WorkspaceExecutionPermitSchema.safeParse(permit);
  if (!parsedPermit.success) {
    return { ok: false, rejection: { code: "INVALID_REQUEST", message: "permit failed strict validation" } };
  }
  const parsedLive = LiveWorkspaceFactsSchema.safeParse(live);
  if (!parsedLive.success) {
    return { ok: false, rejection: { code: "INVALID_REQUEST", message: "live workspace facts failed validation" } };
  }
  const presented = parsedPermit.data;
  const current = parsedLive.data;
  if (presented.session_id !== current.session_id || presented.workspace_id !== current.workspace_id) {
    return { ok: false, rejection: { code: "WRONG_OWNER", message: "permit names a different session or workspace" } };
  }
  if (presented.generation !== current.generation) {
    return {
      ok: false,
      rejection: { code: "STALE_SESSION", message: "permit carries a stale session generation" },
    };
  }
  if (presented.epoch !== current.epoch) {
    return { ok: false, rejection: { code: "STALE_EPOCH", message: "permit carries a stale container epoch" } };
  }
  if (current.revoked_lease_ids.includes(presented.lease_id)) {
    return { ok: false, rejection: { code: "WORKSPACE_REVOKED", message: "permit lease was revoked" } };
  }
  if (presented.policy_digest !== current.policy_digest) {
    return {
      ok: false,
      rejection: { code: "NOT_AUTHORIZED", message: "permit binds a different reviewed policy" },
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Renderer-facing editor requests — identifier-only, strict.
//
// The renderer carries session/generation/operation/request identity plus
// safe replay cursors only. There is deliberately no capability, path,
// content, policy, epoch or lease field: any such extra key rejects by
// construction (strict schemas), and the coordinator resolves authority
// from trusted main state.
// ---------------------------------------------------------------------------

export const RunEditorOperationRequestSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  operation_id: WorkspaceIdentifierSchema,
  request_id: WorkspaceIdentifierSchema,
});
export type RunEditorOperationRequest = z.infer<typeof RunEditorOperationRequestSchema>;

export const CancelEditorOperationRequestSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  operation_id: WorkspaceIdentifierSchema,
  request_id: WorkspaceIdentifierSchema,
});
export type CancelEditorOperationRequest = z.infer<typeof CancelEditorOperationRequestSchema>;

export const GetEditorSnapshotRequestSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  after_seq: z.number().int().min(0),
});
export type GetEditorSnapshotRequest = z.infer<typeof GetEditorSnapshotRequestSchema>;

export const AcknowledgePresentationRequestSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  operation_id: WorkspaceIdentifierSchema,
  plan_id: WorkspaceIdentifierSchema,
  chunk_seq: z.number().int().min(0),
});
export type AcknowledgePresentationRequest = z.infer<typeof AcknowledgePresentationRequestSchema>;

// ---------------------------------------------------------------------------
// Workspace snapshot — safe main-to-renderer view. Identifiers, revisions
// and dirty flags only: no host paths, no source text, no capabilities.
// ---------------------------------------------------------------------------

export const SnapshotDocumentSchema = z.strictObject({
  portable_path: PortablePathSchema,
  disk_revision: z.number().int().min(0),
  buffer_revision: z.number().int().min(0),
  dirty: z.boolean(),
});
export type SnapshotDocument = z.infer<typeof SnapshotDocumentSchema>;

export const WorkspaceSnapshotSchema = z.strictObject({
  workspace_protocol_version: z.literal(WORKSPACE_PROTOCOL_VERSION),
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  workspace_revision: z.number().int().min(0),
  ownership: WorkspaceOwnershipSchema,
  /** Live container epoch, or null when no container exists. */
  epoch: z.number().int().min(1).nullable(),
  /** Access of the live container, or null when no container exists. */
  epoch_access: TerminalWorkspaceAccessSchema.nullable(),
  open_documents: z.array(SnapshotDocumentSchema).max(256),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

// ---------------------------------------------------------------------------
// Reset/close ordering contract — the frozen barrier sequence (spec 26.10):
// revoke -> settle save/cancel typing -> stop/remove terminal container ->
// confirm cleanup -> discard/reseed workspace -> expose new generation.
// Later tasks enforce this ordering; P6.1 makes it representable and
// checkable: only exact prefixes are valid, and only the full sequence is
// complete. Close follows the same barrier without reseeding.
// ---------------------------------------------------------------------------

export const RESET_PHASE_ORDER = [
  "REVOKE",
  "SETTLE_SAVE_CANCEL",
  "STOP_REMOVE_CONTAINER",
  "CONFIRM_CLEANUP",
  "DISCARD_RESEED",
  "EXPOSE_NEW_GENERATION",
] as const;
export type ResetPhase = (typeof RESET_PHASE_ORDER)[number];

export const ResetPhaseSchema = z.enum(RESET_PHASE_ORDER);
export type ResetPhaseValue = z.infer<typeof ResetPhaseSchema>;

/** True only when the phases form an exact ordered prefix of the barrier (no skips, no repeats, no reorder). */
export function isValidResetPrefix(phases: readonly ResetPhase[]): boolean {
  for (const [index, phase] of phases.entries()) {
    if (RESET_PHASE_ORDER[index] !== phase) return false;
  }
  return true;
}

/** True only when the barrier ran to completion (new generation exposed). */
export function isCompleteResetSequence(phases: readonly ResetPhase[]): boolean {
  return phases.length === RESET_PHASE_ORDER.length && isValidResetPrefix(phases);
}

// ---------------------------------------------------------------------------
// Workspace/editor error model — the new editor-protocol codes. These extend
// the P5 taxonomy for the shared workspace; they are NOT inserted into P5's
// strict runtime enum (spec 21: codes belong to the new editor protocol).
// Every code maps to exactly one outcome category:
//   reject — invalid request, zero side effects, legitimate work preserved
//   hold   — fail-closed prerequisite/session condition, no new work
//   fail   — the admitted operation fails, then teardown/settlement
// ---------------------------------------------------------------------------

export const WorkspaceErrorCodeSchema = z.enum([
  // Admission errors: zero side effects (spec 21).
  "INVALID_REQUEST",
  "NOT_AUTHORIZED",
  "STALE_SESSION",
  "STALE_EPOCH",
  "WRONG_OWNER",
  "UNSUPPORTED_PHASE",
  "RESOURCE_LIMIT",
  // Planning errors: preserve working document and disk (spec 21).
  "FILE_NOT_FOUND",
  "FILE_EXISTS",
  "INVALID_LOCATION",
  "FIND_NOT_FOUND",
  "OCCURRENCE_MISMATCH",
  "UNSUPPORTED_TEXT_PROFILE",
  // Workspace/ownership errors (spec 26).
  "DISK_CONFLICT",
  "WORKSPACE_VIOLATION",
  "WORKSPACE_BUSY",
  "WORKSPACE_REVOKED",
  "DIRTY_BUFFER_CONFLICT",
  "EXTERNAL_MODIFICATION_CONFLICT",
  "INVALID_TRANSITION",
  // Persistence/cleanup errors (spec 21, 26.7, 26.10).
  "SAVE_FAILED",
  "COMMIT_UNCERTAIN",
  "CLEANUP_UNCONFIRMED",
]);
export type WorkspaceErrorCode = z.infer<typeof WorkspaceErrorCodeSchema>;

export type WorkspaceErrorCategory = "reject" | "hold" | "fail";

export const WORKSPACE_ERROR_CATEGORY: Readonly<Record<WorkspaceErrorCode, WorkspaceErrorCategory>> = Object.freeze({
  INVALID_REQUEST: "reject",
  NOT_AUTHORIZED: "hold",
  STALE_SESSION: "reject",
  STALE_EPOCH: "reject",
  WRONG_OWNER: "reject",
  UNSUPPORTED_PHASE: "hold",
  RESOURCE_LIMIT: "reject",
  FILE_NOT_FOUND: "reject",
  FILE_EXISTS: "reject",
  INVALID_LOCATION: "reject",
  FIND_NOT_FOUND: "reject",
  OCCURRENCE_MISMATCH: "reject",
  UNSUPPORTED_TEXT_PROFILE: "reject",
  DISK_CONFLICT: "hold",
  WORKSPACE_VIOLATION: "hold",
  WORKSPACE_BUSY: "reject",
  WORKSPACE_REVOKED: "reject",
  DIRTY_BUFFER_CONFLICT: "reject",
  EXTERNAL_MODIFICATION_CONFLICT: "hold",
  INVALID_TRANSITION: "reject",
  SAVE_FAILED: "fail",
  COMMIT_UNCERTAIN: "hold",
  CLEANUP_UNCONFIRMED: "hold",
});

export interface WorkspaceRejection {
  readonly code: WorkspaceErrorCode;
  readonly message: string;
}

export type WorkspaceOutcome<T> = { ok: true; value: T } | { ok: false; rejection: WorkspaceRejection };
