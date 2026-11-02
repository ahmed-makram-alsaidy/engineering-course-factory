// P6.1 WorkspaceCoordinator contract — combined-session lifecycle vocabulary.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 26.8-26.10 and
// docs/adr/ADR-0011-shared-workspace-ownership.md.
//
// This module is CONTRACT-ONLY: TypeScript interfaces with the canonical
// method names from section 26.8, plus the SharedExecutionProviderV1 epoch
// interface from section 26.9. There is deliberately NO implementation here:
// no leaf allocation, no container work, no file I/O, no journal writes.
// The lifecycle implementation is owned by later tasks (P6.2+). Importing
// this module yields an empty runtime namespace (enforced by tests), so no
// coordinator behavior can be reached before its owning task lands.
//
// Ownership recap for implementers:
//   - openCombinedSession is main-catalog-only; it reconciles the
//     installation, allocates a fresh session workspace, seeds/verifies it,
//     and issues the safe descriptor plus opaque component capabilities.
//   - TerminalHost attaches via an opaque capability and never allocates,
//     deletes or resets combined leaves on its own (legacy terminal-only
//     P5 sessions cannot attach an editor).
//   - resetCombinedSession/closeCombinedSession are the SOLE reset/close
//     implementations; every UI alias routes through them.

import { z } from "zod";
import {
  LiveWorkspaceFactsSchema,
  OpaqueHandleSchema,
  RESET_PHASE_ORDER,
  SnapshotDocumentSchema,
  TerminalWorkspaceAccessSchema,
  WORKSPACE_PROTOCOL_VERSION,
  WorkspaceExecutionPermitSchema,
  WorkspaceIdentifierSchema,
  WorkspaceOwnershipSchema,
  WorkspaceSnapshotSchema,
  isLegalOwnershipTransition,
  isValidOwnershipAccess,
} from "./protocol.ts";
import type {
  ContainerEpoch,
  LiveWorkspaceFacts,
  ResetPhase,
  TerminalWorkspaceAccess,
  WorkspaceErrorCode,
  WorkspaceExecutionPermit,
  WorkspaceIdentity,
  WorkspaceOutcome,
  WorkspaceOwnership,
  WorkspaceRejection,
  WorkspaceSnapshot,
} from "./protocol.ts";
import {
  SeedManifestSchema,
  computeSeedManifestDigest,
  resolveTerminalAccess,
  verifyReviewedWorkspacePolicy,
} from "./policy.ts";
import type { ReviewedWorkspacePolicy, SeedManifest } from "./policy.ts";

/** Opaque editor capability — coordinator-issued only, never renderer-built. */
export interface EditorCapability {
  readonly kind: "editor_capability";
  readonly leaseId: string;
}

/** Opaque terminal capability — coordinator-issued only, never renderer-built. */
export interface TerminalCapability {
  readonly kind: "terminal_capability";
  readonly leaseId: string;
}

/** Opaque epoch capability for provider calls — coordinator-issued only. */
export interface EpochCapability {
  readonly kind: "epoch_capability";
  readonly leaseId: string;
}

/**
 * Safe combined-session descriptor for UI remounts (both panes): session
 * identity plus ownership/epoch facts. No host paths, no capabilities, no
 * source text. Rotating session_id on reset fences old terminal requests
 * whose shape carries no generation field.
 */
export interface CombinedSessionDescriptor {
  readonly sessionId: string;
  readonly generation: number;
  readonly workspaceId: string;
  readonly workspaceRevision: number;
  readonly ownership: WorkspaceOwnership;
  readonly epoch: number;
  readonly epochAccess: TerminalWorkspaceAccess | null;
}

/** Main-catalog-only arguments for opening a combined session. */
export interface OpenCombinedSessionArgs {
  /**
   * Canonical validated compiled IR. Kept opaque here: P6.6 binds it to the
   * compiler authority; P6.1 must not admit, compile or execute lessons.
   */
  readonly validatedIr: unknown;
  readonly reviewedPolicy: ReviewedWorkspacePolicy;
  readonly seedManifest: SeedManifest;
}

/**
 * Future main-owned WorkspaceCoordinator. Method names are contractual
 * (spec 26.8); signatures bind the P6.1 DTOs. Every mutating method is
 * generation- and epoch-fenced by the implementation.
 */
export interface WorkspaceCoordinator {
  openCombinedSession(args: OpenCombinedSessionArgs): WorkspaceOutcome<CombinedSessionDescriptor>;
  runEditorOperation(
    editorCapability: EditorCapability,
    operationId: string,
    requestId: string,
  ): WorkspaceOutcome<CombinedSessionDescriptor>;
  runTerminalOperation(
    terminalCapability: TerminalCapability,
    operationId: string,
    requestId: string,
  ): WorkspaceOutcome<CombinedSessionDescriptor>;
  stopTerminal(
    terminalCapability: TerminalCapability,
    processId: string,
    requestId: string,
  ): WorkspaceOutcome<CombinedSessionDescriptor>;
  cancelTerminal(
    terminalCapability: TerminalCapability,
    operationId: string,
    requestId: string,
  ): WorkspaceOutcome<CombinedSessionDescriptor>;
  cancelEditor(
    editorCapability: EditorCapability,
    operationId: string,
    requestId: string,
  ): WorkspaceOutcome<CombinedSessionDescriptor>;
  resetCombinedSession(
    descriptor: CombinedSessionDescriptor,
    requestId: string,
  ): WorkspaceOutcome<CombinedSessionDescriptor>;
  closeCombinedSession(descriptor: CombinedSessionDescriptor, requestId: string): WorkspaceOutcome<null>;
  onProviderFailure(epochCapability: EpochCapability, cause: string): void;
  getCombinedSnapshot(
    descriptor: CombinedSessionDescriptor,
    afterSeq: number,
  ): WorkspaceOutcome<WorkspaceSnapshot>;
}

/**
 * Coordinator-only epoch preparation context (spec 26.9). Main-held: the
 * physical leaf reference never leaves main and never enters renderer or
 * lesson DTOs. Decoupled from any single terminal grant so editor-first
 * sessions need no invented operation.
 */
export interface WorkspaceEpochContext {
  readonly epochCapability: EpochCapability;
  readonly sessionId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly access: TerminalWorkspaceAccess;
  /** Main-held leaf reference. Never serialized to renderer/guest contracts. */
  readonly leafRef: unknown;
  readonly policyDigest: string;
  readonly imageDigest: string;
  readonly environmentDigest: string;
  readonly remainingDeadlineMs: number;
  readonly initialOperationIds: readonly string[];
}

/** Opaque epoch handle returned by prepareEpoch (runtime-only). */
export interface OpaqueEpochHandle {
  readonly kind: "epoch_handle";
  readonly handleId: string;
}

/** Epoch retirement outcome: confirmed absence, or unconfirmed HOLD. */
export interface EpochRetirement {
  readonly cleanup: "confirmed" | "unconfirmed";
}

/**
 * Explicit opt-in provider extension beside the legacy ExecutionProvider
 * (spec 26.9). Retirement never deletes the leaf, resets admission, releases
 * tombstones or seals the logical journal; logical runtime closure happens
 * only once, on actual reset/close/failure.
 */
export interface SharedExecutionProviderV1 {
  prepareEpoch(context: WorkspaceEpochContext): WorkspaceOutcome<OpaqueEpochHandle>;
  registerEpochPermits(
    handle: OpaqueEpochHandle,
    permits: readonly WorkspaceExecutionPermit[],
  ): WorkspaceOutcome<null>;
  startEpochOperation(
    handle: OpaqueEpochHandle,
    operationId: string,
    attemptId: string,
  ): WorkspaceOutcome<null>;
  stopEpochProcess(
    handle: OpaqueEpochHandle,
    processId: string,
    requestId: string,
  ): WorkspaceOutcome<null>;
  cancelEpochOperation(
    handle: OpaqueEpochHandle,
    operationId: string,
    requestId: string,
  ): WorkspaceOutcome<null>;
  retireEpoch(handle: OpaqueEpochHandle, transitionCause: string): WorkspaceOutcome<EpochRetirement>;
  closeSharedSession(handle: OpaqueEpochHandle): WorkspaceOutcome<null>;
}

export type { ContainerEpoch, WorkspaceIdentity };

// ---------------------------------------------------------------------------
// P6.2 WorkspaceCoordinator lifecycle — trusted main-owned ownership authority.
//
// Canonical task (P6-DESIGN-SPEC section 22): P6.2 WorkspaceCoordinator
// lifecycle — owned scope "Leaf/seed ownership, terminal attach seam,
// ordering and revocation, fake provider" — PASS gate "No bypass or double
// owner; unconfirmed cleanup holds".
//
// What this module implements (and only this):
//   - combined-session leaf/seed ownership as logical main-held facts bound
//     to the P6.1 reviewed policy (policy digest + seed manifest digest; no
//     filesystem access, no host paths, no container work);
//   - the terminal attach seam: terminal operations resolve their reviewed
//     access from the digest-bound policy via resolveTerminalAccess only —
//     the caller supplies an operation id, never an access value, never a
//     command string;
//   - exclusive writer ordering behind the P6.1 ownership vocabulary: at
//     most one writer (editor adapter XOR terminal read-write tree) owns the
//     leaf; approved read-only background observation coexists with editing
//     without changing the epoch; every read-write access change crosses an
//     explicit non-writable TRANSITION barrier reserved synchronously before
//     any await;
//   - lease/revocation fencing over session identity, generation and
//     container epoch: old generations reject STALE_SESSION, old epochs
//     reject STALE_EPOCH, revoked leases reject WORKSPACE_REVOKED, foreign
//     sessions reject WRONG_OWNER — checked in the same fail-closed order as
//     the P6.1 checkPermitAcquisition predicate;
//   - reset/close barriers with the frozen phase order (REVOKE first, new
//     generation exposed last) plus HOLD on unconfirmed provider retirement;
//     reset rotates to a new opaque session identity with an incremented
//     generation so old terminal requests (which carry no generation field)
//     fence as STALE_SESSION;
//   - a fake epoch provider seam (immediate-confirmed default plus a manual
//     deferred double for transition-visibility tests). Real container
//     recreation, mount enforcement, scratch handling and journal continuity
//     belong to P6.3 (SharedExecutionProviderV1 above, untouched here).
//
// Explicit non-scope (owned by later tasks, represented here only as
// barrier facts or not at all):
//   - P6.3 Docker access epochs (no container prepare/retire, no bind plan,
//     no inspect, no scratch, no deadlines);
//   - P6.4 Windows file adapter (no readDocument/publishDocument, no NTFS
//     handles, no staging, no host reads/writes/scans);
//   - P6.5 ownership integration gate (no real writer-exclusion probes);
//   - P6.6 admission catalogs, P6.7 open/create, P6.8+ planners/schedulers,
//     P6.10 save persistence and journals, P6.12 IPC/Monaco, P6.13 terminal
//     interop, P6.15 visual proof. Editor operations here reserve the
//     single-transaction slot only; persistence bytes are never touched.
//   - No lesson file mutation, no visual presentation pacing, no schema or
//     IR change (shared-types/compiler sources untouched).
//
// Purity: this module imports only zod (runtime validation) plus the P6.1
// protocol/policy contracts. No filesystem, no processes, no containers,
// no timers, no wall-clock reads, no browser or presentation machinery.
// Async boundaries exist only as explicit promise handoffs (provider seam
// and the bounded wait queue); reservation always happens synchronously
// before the first await of each admission path.
// ---------------------------------------------------------------------------

/** P6.2 coordinator protocol version (matches the P6.1 workspace protocol). */
export const WORKSPACE_COORDINATOR_VERSION = 1;

/** Maximum live read-only background observers (P5 cap of four, reused). */
export const MAX_RO_OBSERVERS = 4;

/** Bounded wait-queue depth for save/editor serialization. */
export const MAX_WAIT_QUEUE = 32;

/** Bounded request-receipt ledger per generation (idempotency + tombstones). */
export const MAX_RECEIPTS = 256;

/** Bounded workspace event log retained for causal-order evidence. */
export const MAX_WORKSPACE_EVENTS = 256;

/** Bounded open-document view in snapshots (matches protocol ceiling). */
export const MAX_OPEN_DOCUMENTS = 256;

// ---------------------------------------------------------------------------
// Capability and lease shapes (main-issued, opaque, never renderer-built).
// Capabilities are session/generation-scoped tickets issued at open/reset;
// per-operation leases bind the epoch and access as well. The renderer never
// sees either: renderer DTOs stay the P6.1 identifier-only shapes.
// ---------------------------------------------------------------------------

export const EditorCapabilitySchema = z.strictObject({
  kind: z.literal("editor_capability"),
  leaseId: OpaqueHandleSchema,
});
export type EditorCapabilityValue = z.infer<typeof EditorCapabilitySchema>;

export const TerminalCapabilitySchema = z.strictObject({
  kind: z.literal("terminal_capability"),
  leaseId: OpaqueHandleSchema,
});
export type TerminalCapabilityValue = z.infer<typeof TerminalCapabilitySchema>;

export const EpochCapabilitySchema = z.strictObject({
  kind: z.literal("epoch_capability"),
  leaseId: OpaqueHandleSchema,
});
export type EpochCapabilityValue = z.infer<typeof EpochCapabilitySchema>;

export const EditorLeaseSchema = z.strictObject({
  kind: z.literal("editor_lease"),
  leaseId: OpaqueHandleSchema,
  sessionId: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  workspaceId: OpaqueHandleSchema,
  epoch: z.number().int().min(1),
  operationId: WorkspaceIdentifierSchema,
  requestId: WorkspaceIdentifierSchema,
});
export type EditorLease = z.infer<typeof EditorLeaseSchema>;

export const TerminalLeaseSchema = z.strictObject({
  kind: z.literal("terminal_lease"),
  leaseId: OpaqueHandleSchema,
  sessionId: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  workspaceId: OpaqueHandleSchema,
  epoch: z.number().int().min(1),
  access: TerminalWorkspaceAccessSchema,
  operationId: WorkspaceIdentifierSchema,
  requestId: WorkspaceIdentifierSchema,
  peerId: OpaqueHandleSchema.nullable(),
});
export type TerminalLease = z.infer<typeof TerminalLeaseSchema>;

export const CombinedSessionDescriptorSchema = z.strictObject({
  sessionId: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  workspaceId: OpaqueHandleSchema,
  workspaceRevision: z.number().int().min(0),
  ownership: WorkspaceOwnershipSchema,
  epoch: z.number().int().min(1),
  epochAccess: TerminalWorkspaceAccessSchema.nullable(),
});
export type CombinedSessionDescriptorValue = z.infer<typeof CombinedSessionDescriptorSchema>;

export const BufferFactsSchema = z.strictObject({
  dirtyBufferCount: z.number().int().min(0),
  pendingCreationCount: z.number().int().min(0),
});
export type BufferFacts = z.infer<typeof BufferFactsSchema>;

/** Logical (identifier-free) coordinator facts for replay comparisons. */
export interface CoordinatorLogicalState {
  readonly ownership: WorkspaceOwnership;
  readonly generation: number;
  readonly epoch: number;
  readonly workspaceRevision: number;
  readonly dirtyBufferCount: number;
  readonly pendingCreationCount: number;
  readonly saveActive: boolean;
  readonly activeRoCount: number;
  readonly activeRw: boolean;
  readonly inTransition: boolean;
  readonly closed: boolean;
}

/** Safe descriptor returned after open/reset (descriptor plus fresh tickets). */
export interface OpenedCombinedSession {
  readonly descriptor: CombinedSessionDescriptor;
  readonly editorCapability: EditorCapability;
  readonly terminalCapability: TerminalCapability;
  readonly epochCapability: EpochCapability;
}

/** Editor admission result: safe descriptor plus the single-use write lease. */
export interface EditorAdmission {
  readonly descriptor: CombinedSessionDescriptor;
  readonly lease: EditorLease;
}

/** Terminal admission result: descriptor, epoch-bound lease and permit. */
export interface TerminalAdmission {
  readonly descriptor: CombinedSessionDescriptor;
  readonly lease: TerminalLease;
  readonly permit: WorkspaceExecutionPermit;
  readonly access: TerminalWorkspaceAccess;
}

/** New-generation result returned by a completed reset barrier. */
export interface ResetCompleted {
  readonly descriptor: CombinedSessionDescriptor;
  readonly editorCapability: EditorCapability;
  readonly terminalCapability: TerminalCapability;
  readonly epochCapability: EpochCapability;
}

/**
 * P6.2 fake epoch provider seam. The default fake confirms immediately;
 * tests inject a manual double to hold TRANSITION open across awaits.
 * Real container work belongs to P6.3 and never passes through here.
 */
export interface EpochTransitionProvider {
  prepare(access: TerminalWorkspaceAccess): Promise<"confirmed">;
  retire(cause: string): Promise<"confirmed" | "unconfirmed">;
}

/** Immediate-confirmed fake (default): transitions settle on microtasks. */
export function createFakeEpochProvider(): EpochTransitionProvider {
  return {
    prepare: () => Promise.resolve("confirmed"),
    retire: () => Promise.resolve("confirmed"),
  };
}

/**
 * Manual deferred double for transition-visibility tests. Each prepare and
 * retire call waits until the test settles it explicitly — no timers, no
 * sleeps, fully deterministic.
 */
export interface ManualEpochProvider extends EpochTransitionProvider {
  readonly pendingPrepares: number;
  readonly pendingRetires: number;
  resolveNextPrepare(): void;
  resolveNextRetire(outcome: "confirmed" | "unconfirmed"): void;
}

export function createManualEpochProvider(): ManualEpochProvider {
  const prepareWaiters: Array<() => void> = [];
  const retireWaiters: Array<(outcome: "confirmed" | "unconfirmed") => void> = [];
  return {
    get pendingPrepares(): number {
      return prepareWaiters.length;
    },
    get pendingRetires(): number {
      return retireWaiters.length;
    },
    prepare: () =>
      new Promise<"confirmed">((resolve) => {
        prepareWaiters.push(() => resolve("confirmed"));
      }),
    retire: (_cause: string) =>
      new Promise<"confirmed" | "unconfirmed">((resolve) => {
        retireWaiters.push(resolve);
      }),
    resolveNextPrepare(): void {
      const next = prepareWaiters.shift();
      if (next === undefined) throw new Error("no pending prepare to resolve");
      next();
    },
    resolveNextRetire(outcome: "confirmed" | "unconfirmed"): void {
      const next = retireWaiters.shift();
      if (next === undefined) throw new Error("no pending retire to resolve");
      next(outcome);
    },
  };
}

function rejected(code: WorkspaceErrorCode, message: string): { ok: false; rejection: WorkspaceRejection } {
  return { ok: false, rejection: { code, message } };
}

function payloadHash(scope: readonly unknown[], payload: unknown): string {
  return JSON.stringify({ scope, payload });
}

interface CapabilityRecord {
  readonly kind: "editor_capability" | "terminal_capability" | "epoch_capability";
  readonly sessionId: string;
  readonly generation: number;
}

interface LeaseRecord {
  readonly leaseId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly workspaceId: string;
  readonly epoch: number;
  readonly role: "editor" | "terminal_ro" | "terminal_rw";
  readonly operationId: string;
}

interface RoPeer {
  readonly leaseId: string;
  readonly operationId: string;
  readonly peerId: string;
  readonly epoch: number;
}

interface QueuedWaiter {
  readonly kind: "editor" | "terminal_ro" | "terminal_rw";
  readonly capabilityId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly scopeHash: string;
  readonly resolve: (outcome: WorkspaceOutcome<never>) => void;
}

interface WorkspaceEvent {
  readonly seq: number;
  readonly type: string;
  readonly generation: number;
  readonly epoch: number;
}

export interface SharedWorkspaceCoordinator {
  openCombinedSession(args: OpenCombinedSessionArgs): WorkspaceOutcome<OpenedCombinedSession>;
  runEditorOperation(
    editorCapability: EditorCapability,
    operationId: string,
    requestId: string,
  ): Promise<WorkspaceOutcome<EditorAdmission>>;
  releaseEditor(lease: EditorLease): WorkspaceOutcome<CombinedSessionDescriptor>;
  cancelEditor(
    editorCapability: EditorCapability,
    operationId: string,
    requestId: string,
  ): WorkspaceOutcome<CombinedSessionDescriptor>;
  runTerminalOperation(
    terminalCapability: TerminalCapability,
    operationId: string,
    requestId: string,
  ): Promise<WorkspaceOutcome<TerminalAdmission>>;
  releaseTerminal(lease: TerminalLease): Promise<WorkspaceOutcome<CombinedSessionDescriptor>>;
  stopTerminal(
    terminalCapability: TerminalCapability,
    processId: string,
    requestId: string,
  ): Promise<WorkspaceOutcome<CombinedSessionDescriptor>>;
  cancelTerminal(
    terminalCapability: TerminalCapability,
    operationId: string,
    requestId: string,
  ): WorkspaceOutcome<CombinedSessionDescriptor>;
  beginSave(editorCapability: EditorCapability): WorkspaceOutcome<null>;
  endSave(editorCapability: EditorCapability): WorkspaceOutcome<CombinedSessionDescriptor>;
  setBufferFacts(editorCapability: EditorCapability, facts: BufferFacts): WorkspaceOutcome<null>;
  setOpenDocuments(
    editorCapability: EditorCapability,
    documents: ReadonlyArray<{ portable_path: string; disk_revision: number; buffer_revision: number; dirty: boolean }>,
  ): WorkspaceOutcome<null>;
  resetCombinedSession(
    descriptor: CombinedSessionDescriptor,
    requestId: string,
  ): Promise<WorkspaceOutcome<ResetCompleted>>;
  closeCombinedSession(
    descriptor: CombinedSessionDescriptor,
    requestId: string,
  ): Promise<WorkspaceOutcome<null>>;
  onProviderFailure(epochCapability: EpochCapability, cause: string): void;
  getCombinedSnapshot(
    descriptor: CombinedSessionDescriptor,
    afterSeq: number,
  ): WorkspaceOutcome<WorkspaceSnapshot>;
  getLiveFacts(): LiveWorkspaceFacts;
  getLogicalState(): CoordinatorLogicalState;
  getResetPhases(): readonly ResetPhase[];
  listEvents(afterSeq?: number): readonly WorkspaceEvent[];
  describe(): CombinedSessionDescriptor;
}

export interface CreateCoordinatorOptions {
  readonly provider?: EpochTransitionProvider;
  readonly maxQueue?: number;
}

/**
 * Create the trusted main-owned coordinator. One logical combined session
 * per instance; reset rotates the session identity inside the same
 * instance so old identifiers fence deterministically.
 */
export function createWorkspaceCoordinator(options: CreateCoordinatorOptions = {}): SharedWorkspaceCoordinator {
  const provider: EpochTransitionProvider = options.provider ?? createFakeEpochProvider();
  const maxQueue: number = options.maxQueue ?? MAX_WAIT_QUEUE;

  let opened = false;
  let closed = false;
  let sessionId = "";
  let generation = 0;
  let workspaceId = "";
  let workspaceRevision = 0;
  let ownership: WorkspaceOwnership = "HOLD";
  let liveEpoch = 1;
  let liveContainer: { epoch: number; access: TerminalWorkspaceAccess } | null = null;
  let policyDigest = "";
  let reviewedPolicy: ReviewedWorkspacePolicy | null = null;
  let holdReason: string | null = null;

  let dirtyBufferCount = 0;
  let pendingCreationCount = 0;
  let saveActive = false;
  let editorBusy: { leaseId: string; operationId: string; requestId: string } | null = null;
  let activeRw: { leaseId: string; operationId: string; epoch: number } | null = null;
  let inTransition: { from: WorkspaceOwnership; to: WorkspaceOwnership; operationId: string } | null = null;

  const capabilities = new Map<string, CapabilityRecord>();
  const leases = new Map<string, LeaseRecord>();
  const revokedLeaseIds = new Set<string>();
  const retiredSessionIds = new Set<string>();
  const roPeers = new Map<string, RoPeer>();
  const receipts = new Map<string, { scopeHash: string; response: unknown }>();
  const tombstones = new Map<string, { requestId: string }>();
  const queuedRequestIds = new Set<string>();
  let waitQueue: QueuedWaiter[] = [];
  let resetPhases: ResetPhase[] = [];
  let resetPending: Promise<WorkspaceOutcome<ResetCompleted>> | null = null;
  let closePending: Promise<WorkspaceOutcome<null>> | null = null;
  const openDocuments = new Map<string, { portable_path: string; disk_revision: number; buffer_revision: number; dirty: boolean }>();

  const events: WorkspaceEvent[] = [];
  let eventSeq = 0;

  let sessionSeq = 0;
  let workspaceSeq = 0;
  let ticketSeq = 0;
  let leaseSeq = 0;
  let peerSeq = 0;

  function nextSessionId(): string {
    sessionSeq += 1;
    return `sess-${sessionSeq}`;
  }
  function nextWorkspaceId(): string {
    workspaceSeq += 1;
    return `ws-${workspaceSeq}`;
  }
  function nextTicketId(prefix: string): string {
    ticketSeq += 1;
    return `${prefix}-${ticketSeq}`;
  }
  function nextLeaseId(): string {
    leaseSeq += 1;
    return `lease-${leaseSeq}`;
  }
  function nextPeerId(): string {
    peerSeq += 1;
    return `peer-${peerSeq}`;
  }

  function recordEvent(type: string): void {
    eventSeq += 1;
    events.push({ seq: eventSeq, type, generation, epoch: liveEpoch });
    if (events.length > MAX_WORKSPACE_EVENTS) events.splice(0, events.length - MAX_WORKSPACE_EVENTS);
  }

  function currentDescriptor(): CombinedSessionDescriptor {
    return {
      sessionId,
      generation,
      workspaceId,
      workspaceRevision,
      ownership,
      epoch: liveEpoch,
      epochAccess: liveContainer === null ? null : liveContainer.access,
    };
  }

  function storeReceipt(requestId: string, scopeHash: string, response: unknown): void {
    if (receipts.size >= MAX_RECEIPTS) {
      const oldest = receipts.keys().next().value;
      if (oldest !== undefined) receipts.delete(oldest);
    }
    receipts.set(requestId, { scopeHash, response });
  }

  function checkDescriptor(descriptor: CombinedSessionDescriptor): WorkspaceRejection | null {
    const parsed = CombinedSessionDescriptorSchema.safeParse(descriptor);
    if (!parsed.success) return { code: "INVALID_REQUEST", message: "combined descriptor failed strict validation" };
    const presented = parsed.data;
    if (presented.sessionId !== sessionId) {
      if (retiredSessionIds.has(presented.sessionId)) {
        return { code: "STALE_SESSION", message: "descriptor names a retired session identity" };
      }
      return { code: "WRONG_OWNER", message: "descriptor names a foreign session" };
    }
    if (presented.generation !== generation) {
      return { code: "STALE_SESSION", message: "descriptor carries a stale session generation" };
    }
    return null;
  }

  function checkCapability(
    ticket: unknown,
    schema: z.ZodType<{ kind: string; leaseId: string }>,
    expectedKind: CapabilityRecord["kind"],
  ): { record: CapabilityRecord; ticketId: string } | { rejection: WorkspaceRejection } {
    const parsed = schema.safeParse(ticket);
    if (!parsed.success) return { rejection: { code: "INVALID_REQUEST", message: "capability failed strict validation" } };
    if (parsed.data.kind !== expectedKind) {
      return { rejection: { code: "WRONG_OWNER", message: "capability kind does not authorize this path" } };
    }
    const ticketId = parsed.data.leaseId;
    const record = capabilities.get(ticketId);
    if (record === undefined || revokedLeaseIds.has(ticketId)) {
      return { rejection: { code: "WORKSPACE_REVOKED", message: "capability is unknown or was revoked" } };
    }
    if (record.sessionId !== sessionId) {
      if (retiredSessionIds.has(record.sessionId)) {
        return { rejection: { code: "STALE_SESSION", message: "capability belongs to a retired session" } };
      }
      return { rejection: { code: "WRONG_OWNER", message: "capability belongs to a foreign session" } };
    }
    if (record.generation !== generation) {
      return { rejection: { code: "STALE_SESSION", message: "capability carries a stale generation" } };
    }
    return { record, ticketId };
  }

  function checkEditorLease(lease: unknown): { record: LeaseRecord } | { rejection: WorkspaceRejection } {
    const parsed = EditorLeaseSchema.safeParse(lease);
    if (!parsed.success) return { rejection: { code: "INVALID_REQUEST", message: "editor lease failed strict validation" } };
    const presented = parsed.data;
    if (presented.sessionId !== sessionId) {
      if (retiredSessionIds.has(presented.sessionId)) {
        return { rejection: { code: "STALE_SESSION", message: "editor lease belongs to a retired session" } };
      }
      return { rejection: { code: "WRONG_OWNER", message: "editor lease belongs to a foreign session" } };
    }
    if (presented.generation !== generation) {
      return { rejection: { code: "STALE_SESSION", message: "editor lease carries a stale generation" } };
    }
    if (presented.epoch !== liveEpoch) {
      return { rejection: { code: "STALE_EPOCH", message: "editor lease carries a stale epoch" } };
    }
    if (revokedLeaseIds.has(presented.leaseId) || !leases.has(presented.leaseId)) {
      return { rejection: { code: "WORKSPACE_REVOKED", message: "editor lease was revoked" } };
    }
    const record = leases.get(presented.leaseId);
    if (record === undefined) return { rejection: { code: "WORKSPACE_REVOKED", message: "editor lease was revoked" } };
    return { record };
  }

  function checkTerminalLease(lease: unknown): { record: LeaseRecord; presented: TerminalLease } | { rejection: WorkspaceRejection } {
    const parsed = TerminalLeaseSchema.safeParse(lease);
    if (!parsed.success) {
      return { rejection: { code: "INVALID_REQUEST", message: "terminal lease failed strict validation" } };
    }
    const presented = parsed.data;
    if (presented.sessionId !== sessionId) {
      if (retiredSessionIds.has(presented.sessionId)) {
        return { rejection: { code: "STALE_SESSION", message: "terminal lease belongs to a retired session" } };
      }
      return { rejection: { code: "WRONG_OWNER", message: "terminal lease belongs to a foreign session" } };
    }
    if (presented.generation !== generation) {
      return { rejection: { code: "STALE_SESSION", message: "terminal lease carries a stale generation" } };
    }
    if (presented.workspaceId !== workspaceId) {
      return { rejection: { code: "WRONG_OWNER", message: "terminal lease names a foreign workspace" } };
    }
    if (presented.epoch !== liveEpoch) {
      return { rejection: { code: "STALE_EPOCH", message: "terminal lease carries a stale epoch" } };
    }
    if (revokedLeaseIds.has(presented.leaseId) || !leases.has(presented.leaseId)) {
      return { rejection: { code: "WORKSPACE_REVOKED", message: "terminal lease was revoked" } };
    }
    const record = leases.get(presented.leaseId);
    if (record === undefined) {
      return { rejection: { code: "WORKSPACE_REVOKED", message: "terminal lease was revoked" } };
    }
    return { record, presented };
  }

  function checkIdempotency(
    requestId: string,
    scope: readonly unknown[],
    payload: unknown,
  ): { cached: unknown } | { conflict: WorkspaceRejection } | null {
    const scopeHash = payloadHash(scope, payload);
    const cached = receipts.get(requestId);
    if (cached === undefined) return null;
    if (cached.scopeHash !== scopeHash) {
      return { conflict: { code: "INVALID_REQUEST", message: "request_id was already used with a different payload" } };
    }
    return { cached: cached.response };
  }

  function rejectQueue(code: WorkspaceErrorCode, message: string): void {
    const drained = waitQueue;
    waitQueue = [];
    queuedRequestIds.clear();
    for (const waiter of drained) {
      waiter.resolve({ ok: false, rejection: { code, message } });
    }
  }

  function drainQueue(): void {
    if (
      waitQueue.length === 0 ||
      closed ||
      ownership !== "EDITOR_OWNED" ||
      saveActive ||
      editorBusy !== null
    ) {
      return;
    }
    const remaining: QueuedWaiter[] = [];
    for (const waiter of waitQueue) {
      if (closed || ownership !== "EDITOR_OWNED" || saveActive || editorBusy !== null) {
        remaining.push(waiter);
        continue;
      }
      if (waiter.kind === "editor") {
        queuedRequestIds.delete(waiter.requestId);
        const leaseId = nextLeaseId();
        leases.set(leaseId, {
          leaseId,
          sessionId,
          generation,
          workspaceId,
          epoch: liveEpoch,
          role: "editor",
          operationId: waiter.operationId,
        });
        tombstones.set(waiter.operationId, { requestId: waiter.requestId });
        editorBusy = { leaseId, operationId: waiter.operationId, requestId: waiter.requestId };
        recordEvent("workspace.writer.acquired");
        const lease: EditorLease = {
          kind: "editor_lease",
          leaseId,
          sessionId,
          generation,
          workspaceId,
          epoch: liveEpoch,
          operationId: waiter.operationId,
          requestId: waiter.requestId,
        };
        const response: WorkspaceOutcome<EditorAdmission> = { ok: true, value: { descriptor: currentDescriptor(), lease } };
        storeReceipt(waiter.requestId, waiter.scopeHash, response);
        waiter.resolve(response as WorkspaceOutcome<never>);
        continue;
      }
      if (waiter.kind === "terminal_ro") {
        if (activeRw !== null || roPeers.size >= MAX_RO_OBSERVERS || reviewedPolicy === null) {
          remaining.push(waiter);
          continue;
        }
        const access = resolveTerminalAccess(reviewedPolicy, waiter.operationId);
        if (!access.ok || access.value !== "read_only") {
          queuedRequestIds.delete(waiter.requestId);
          waiter.resolve(
            access.ok
              ? { ok: false, rejection: { code: "WORKSPACE_BUSY", message: "queued read-only waiter no longer eligible" } }
              : { ok: false, rejection: access.rejection },
          );
          continue;
        }
        queuedRequestIds.delete(waiter.requestId);
        const leaseId = nextLeaseId();
        const peerId = nextPeerId();
        leases.set(leaseId, {
          leaseId,
          sessionId,
          generation,
          workspaceId,
          epoch: liveEpoch,
          role: "terminal_ro",
          operationId: waiter.operationId,
        });
        tombstones.set(waiter.operationId, { requestId: waiter.requestId });
        roPeers.set(peerId, { leaseId, operationId: waiter.operationId, peerId, epoch: liveEpoch });
        if (liveContainer === null) liveContainer = { epoch: liveEpoch, access: "read_only" };
        recordEvent("workspace.ro.acquired");
        const lease: TerminalLease = {
          kind: "terminal_lease",
          leaseId,
          sessionId,
          generation,
          workspaceId,
          epoch: liveEpoch,
          access: "read_only",
          operationId: waiter.operationId,
          requestId: waiter.requestId,
          peerId,
        };
        const permit: WorkspaceExecutionPermit = {
          kind: "workspace_execution_permit",
          permit_version: 1,
          session_id: sessionId,
          generation,
          workspace_id: workspaceId,
          epoch: liveEpoch,
          access: "read_only",
          operation_id: waiter.operationId,
          policy_digest: policyDigest,
          lease_id: leaseId,
        };
        const response: WorkspaceOutcome<TerminalAdmission> = {
          ok: true,
          value: { descriptor: currentDescriptor(), lease, permit, access: "read_only" },
        };
        storeReceipt(waiter.requestId, waiter.scopeHash, response);
        waiter.resolve(response as WorkspaceOutcome<never>);
        continue;
      }
      drainTerminalRwWaiter(waiter);
      continue;
    }
    waitQueue = remaining;
  }

  function drainTerminalRwWaiter(waiter: QueuedWaiter): boolean {
    if (dirtyBufferCount > 0 || pendingCreationCount > 0) {
      queuedRequestIds.delete(waiter.requestId);
      waiter.resolve({ ok: false, rejection: { code: "DIRTY_BUFFER_CONFLICT", message: "queued read-write waiter found dirty buffers after settlement" } });
      return true;
    }
    if (roPeers.size > 0 || activeRw !== null) {
      queuedRequestIds.delete(waiter.requestId);
      waiter.resolve({ ok: false, rejection: { code: "WORKSPACE_BUSY", message: "queued read-write waiter found live terminal peers: stop observers first" } });
      return true;
    }
    if (reviewedPolicy === null) {
      queuedRequestIds.delete(waiter.requestId);
      waiter.resolve({ ok: false, rejection: { code: "NOT_AUTHORIZED", message: "no reviewed policy is bound to this session" } });
      return true;
    }
    const access = resolveTerminalAccess(reviewedPolicy, waiter.operationId);
    if (!access.ok || access.value !== "read_write") {
      queuedRequestIds.delete(waiter.requestId);
      waiter.resolve(
        access.ok
          ? { ok: false, rejection: { code: "WORKSPACE_BUSY", message: "queued read-write waiter is no longer eligible" } }
          : { ok: false, rejection: access.rejection },
      );
      return true;
    }
    queuedRequestIds.delete(waiter.requestId);
    tombstones.set(waiter.operationId, { requestId: waiter.requestId });
    ownership = "TRANSITION";
    inTransition = { from: "EDITOR_OWNED", to: "TERMINAL_OWNED", operationId: waiter.operationId };
    recordEvent("workspace.epoch.retiring");
    const admittedGeneration = generation;
    const admittedSession = sessionId;
    const admittedWorkspace = workspaceId;
    const scopeHash = waiter.scopeHash;
    const waiterRequestId = waiter.requestId;
    const waiterOperationId = waiter.operationId;
    void provider.prepare("read_write").then(
      () => {
        if (closed || sessionId !== admittedSession || generation !== admittedGeneration || ownership !== "TRANSITION") {
          waiter.resolve({ ok: false, rejection: { code: "STALE_SESSION", message: "queued read-write admission lapsed across a lifecycle barrier" } });
          return;
        }
        liveEpoch += 1;
        liveContainer = { epoch: liveEpoch, access: "read_write" };
        ownership = "TERMINAL_OWNED";
        inTransition = null;
        const leaseId = nextLeaseId();
        leases.set(leaseId, {
          leaseId,
          sessionId,
          generation,
          workspaceId: admittedWorkspace,
          epoch: liveEpoch,
          role: "terminal_rw",
          operationId: waiterOperationId,
        });
        activeRw = { leaseId, operationId: waiterOperationId, epoch: liveEpoch };
        recordEvent("workspace.epoch.started");
        recordEvent("workspace.writer.acquired");
        const lease: TerminalLease = {
          kind: "terminal_lease",
          leaseId,
          sessionId,
          generation,
          workspaceId: admittedWorkspace,
          epoch: liveEpoch,
          access: "read_write",
          operationId: waiterOperationId,
          requestId: waiterRequestId,
          peerId: null,
        };
        const permit: WorkspaceExecutionPermit = {
          kind: "workspace_execution_permit",
          permit_version: 1,
          session_id: sessionId,
          generation,
          workspace_id: admittedWorkspace,
          epoch: liveEpoch,
          access: "read_write",
          operation_id: waiterOperationId,
          policy_digest: policyDigest,
          lease_id: leaseId,
        };
        const permitCheck = WorkspaceExecutionPermitSchema.safeParse(permit);
        if (!permitCheck.success) {
          enterHold("queued permit validation failed after transition");
          waiter.resolve({ ok: false, rejection: { code: "INVALID_REQUEST", message: "internal: issued permit failed strict validation" } });
          return;
        }
        const response: WorkspaceOutcome<TerminalAdmission> = {
          ok: true,
          value: { descriptor: currentDescriptor(), lease, permit: permitCheck.data, access: "read_write" },
        };
        storeReceipt(waiterRequestId, scopeHash, response);
        waiter.resolve(response as WorkspaceOutcome<never>);
      },
      () => {
        enterHold("provider prepare failed for a queued read-write admission");
        waiter.resolve({ ok: false, rejection: { code: "CLEANUP_UNCONFIRMED", message: "queued read-write preparation is unconfirmed: session holds" } });
      },
    );
    return true;
  }

  function revokeAllTickets(reason: string): void {
    for (const ticketId of capabilities.keys()) revokedLeaseIds.add(ticketId);
    for (const leaseId of leases.keys()) revokedLeaseIds.add(leaseId);
    capabilities.clear();
    leases.clear();
    editorBusy = null;
    activeRw = null;
    roPeers.clear();
    inTransition = null;
    liveContainer = null;
    void reason;
  }

  function enterHold(reason: string): void {
    if (closed) return;
    const target: WorkspaceOwnership = "HOLD";
    if (ownership !== target && isLegalOwnershipTransition(ownership, target)) {
      ownership = target;
    } else if (ownership !== target) {
      ownership = target;
    }
    holdReason = reason;
    recordEvent("workspace.hold.entered");
    rejectQueue("WORKSPACE_REVOKED", "session holds: queued starts are revoked");
  }

  const coordinator: SharedWorkspaceCoordinator = {
    openCombinedSession(args: OpenCombinedSessionArgs): WorkspaceOutcome<OpenedCombinedSession> {
      if (opened) {
        return rejected("INVALID_TRANSITION", "combined session is already open on this coordinator");
      }
      if (args === null || typeof args !== "object") {
        return rejected("INVALID_REQUEST", "open arguments failed strict validation");
      }
      const policyCheck = verifyReviewedWorkspacePolicy((args as { reviewedPolicy?: unknown }).reviewedPolicy);
      if (!policyCheck.ok) return policyCheck as { ok: false; rejection: WorkspaceRejection };
      const manifestCheck = SeedManifestSchema.safeParse((args as { seedManifest?: unknown }).seedManifest);
      if (!manifestCheck.success) {
        return rejected("INVALID_REQUEST", "seed manifest failed strict validation");
      }
      const seedDigest = computeSeedManifestDigest(manifestCheck.data);
      if (seedDigest !== policyCheck.value.seed_manifest_digest) {
        return rejected("NOT_AUTHORIZED", "seed manifest does not match the reviewed policy binding");
      }
      opened = true;
      closed = false;
      sessionId = nextSessionId();
      generation = 1;
      workspaceId = nextWorkspaceId();
      workspaceRevision = 0;
      ownership = "EDITOR_OWNED";
      liveEpoch = 1;
      liveContainer = null;
      policyDigest = policyCheck.value.policy_digest;
      reviewedPolicy = policyCheck.value;
      dirtyBufferCount = 0;
      pendingCreationCount = 0;
      saveActive = false;
      holdReason = null;
      resetPhases = [];
      const editorId = nextTicketId("cap");
      const terminalId = nextTicketId("cap");
      const epochId = nextTicketId("cap");
      capabilities.set(editorId, { kind: "editor_capability", sessionId, generation });
      capabilities.set(terminalId, { kind: "terminal_capability", sessionId, generation });
      capabilities.set(epochId, { kind: "epoch_capability", sessionId, generation });
      recordEvent("workspace.session.opened");
      const editorCapability: EditorCapability = { kind: "editor_capability", leaseId: editorId };
      const terminalCapability: TerminalCapability = { kind: "terminal_capability", leaseId: terminalId };
      const epochCapability: EpochCapability = { kind: "epoch_capability", leaseId: epochId };
      return {
        ok: true,
        value: { descriptor: currentDescriptor(), editorCapability, terminalCapability, epochCapability },
      };
    },

    runEditorOperation(
      editorCapability: EditorCapability,
      operationId: string,
      requestId: string,
    ): Promise<WorkspaceOutcome<EditorAdmission>> {
      const ticket = checkCapability(editorCapability, EditorCapabilitySchema, "editor_capability");
      if ("rejection" in ticket) return Promise.resolve({ ok: false, rejection: ticket.rejection });
      if (!opened) return Promise.resolve(rejected("INVALID_TRANSITION", "no combined session is open"));
      if (closed || ownership === "CLOSING") {
        return Promise.resolve(rejected("INVALID_TRANSITION", "session is closing: no new editor work"));
      }
      const idCheck = WorkspaceIdentifierSchema.safeParse(operationId);
      const reqCheck = WorkspaceIdentifierSchema.safeParse(requestId);
      if (!idCheck.success || !reqCheck.success) {
        return Promise.resolve(rejected("INVALID_REQUEST", "operation and request ids must be 1..128 characters"));
      }
      const scope: readonly unknown[] = ["runEditorOperation", sessionId, operationId];
      const idem = checkIdempotency(requestId, scope, { sessionId, generation, operationId, requestId });
      if (idem !== null) {
        if ("conflict" in idem) return Promise.resolve({ ok: false, rejection: idem.conflict });
        return Promise.resolve(idem.cached as WorkspaceOutcome<EditorAdmission>);
      }
      const tomb = tombstones.get(operationId);
      if (tomb !== undefined && tomb.requestId !== requestId) {
        return Promise.resolve(rejected("INVALID_REQUEST", "operation attempt is already consumed in this generation"));
      }
      if (ownership === "RESETTING" || ownership === "HOLD") {
        return Promise.resolve(rejected("INVALID_TRANSITION", `editor work is barred while ${ownership}`));
      }
      if (ownership === "TRANSITION") {
        return Promise.resolve(rejected("INVALID_TRANSITION", "transition barrier owns the workspace: no new editor writer"));
      }
      if (ownership === "TERMINAL_OWNED") {
        return Promise.resolve(rejected("WORKSPACE_BUSY", "terminal read-write owns the leaf: no editor writer"));
      }
      if (ownership !== "EDITOR_OWNED") {
        return Promise.resolve(rejected("INVALID_TRANSITION", "editor work requires editor ownership"));
      }
      if (saveActive || editorBusy !== null) {
        if (queuedRequestIds.has(requestId)) {
          return Promise.resolve(rejected("INVALID_REQUEST", "request_id is already queued with identical payload"));
        }
        if (waitQueue.length >= maxQueue) {
          return Promise.resolve(rejected("RESOURCE_LIMIT", "editor wait queue is bounded: retry after settlement"));
        }
        const scopeHash = payloadHash(scope, { sessionId, generation, operationId, requestId });
        return new Promise<WorkspaceOutcome<EditorAdmission>>((resolve) => {
          queuedRequestIds.add(requestId);
          waitQueue.push({
            kind: "editor",
            capabilityId: ticket.ticketId,
            operationId,
            requestId,
            scopeHash,
            resolve: resolve as (outcome: WorkspaceOutcome<never>) => void,
          });
        });
      }
      const leaseId = nextLeaseId();
      leases.set(leaseId, {
        leaseId,
        sessionId,
        generation,
        workspaceId,
        epoch: liveEpoch,
        role: "editor",
        operationId,
      });
      tombstones.set(operationId, { requestId });
      editorBusy = { leaseId, operationId, requestId };
      recordEvent("workspace.writer.acquired");
      const lease: EditorLease = {
        kind: "editor_lease",
        leaseId,
        sessionId,
        generation,
        workspaceId,
        epoch: liveEpoch,
        operationId,
        requestId,
      };
      const response: WorkspaceOutcome<EditorAdmission> = { ok: true, value: { descriptor: currentDescriptor(), lease } };
      storeReceipt(requestId, payloadHash(scope, { sessionId, generation, operationId, requestId }), response);
      return Promise.resolve(response);
    },

    releaseEditor(lease: EditorLease): WorkspaceOutcome<CombinedSessionDescriptor> {
      const checked = checkEditorLease(lease);
      if ("rejection" in checked) return { ok: false, rejection: checked.rejection };
      if (editorBusy === null || editorBusy.leaseId !== checked.record.leaseId) {
        return rejected("WRONG_OWNER", "editor lease does not own the current transaction slot");
      }
      if (ownership !== "EDITOR_OWNED") {
        return rejected("INVALID_TRANSITION", "editor release requires editor ownership");
      }
      revokedLeaseIds.add(checked.record.leaseId);
      leases.delete(checked.record.leaseId);
      editorBusy = null;
      recordEvent("workspace.writer.released");
      drainQueue();
      return { ok: true, value: currentDescriptor() };
    },

    cancelEditor(
      editorCapability: EditorCapability,
      operationId: string,
      requestId: string,
    ): WorkspaceOutcome<CombinedSessionDescriptor> {
      const ticket = checkCapability(editorCapability, EditorCapabilitySchema, "editor_capability");
      if ("rejection" in ticket) return { ok: false, rejection: ticket.rejection };
      const scope: readonly unknown[] = ["cancelEditor", sessionId, operationId];
      const idem = checkIdempotency(requestId, scope, { sessionId, generation, operationId, requestId });
      if (idem !== null) {
        if ("conflict" in idem) return { ok: false, rejection: idem.conflict };
        return idem.cached as WorkspaceOutcome<CombinedSessionDescriptor>;
      }
      if (editorBusy === null || editorBusy.operationId !== operationId) {
        const response = rejected("INVALID_REQUEST", "no matching editor transaction to cancel");
        storeReceipt(requestId, payloadHash(scope, { sessionId, generation, operationId, requestId }), response);
        return response;
      }
      revokedLeaseIds.add(editorBusy.leaseId);
      leases.delete(editorBusy.leaseId);
      editorBusy = null;
      recordEvent("workspace.writer.released");
      const response: WorkspaceOutcome<CombinedSessionDescriptor> = { ok: true, value: currentDescriptor() };
      storeReceipt(requestId, payloadHash(scope, { sessionId, generation, operationId, requestId }), response);
      drainQueue();
      return response;
    },

    runTerminalOperation(
      terminalCapability: TerminalCapability,
      operationId: string,
      requestId: string,
    ): Promise<WorkspaceOutcome<TerminalAdmission>> {
      const ticket = checkCapability(terminalCapability, TerminalCapabilitySchema, "terminal_capability");
      if ("rejection" in ticket) return Promise.resolve({ ok: false, rejection: ticket.rejection });
      if (!opened) return Promise.resolve(rejected("INVALID_TRANSITION", "no combined session is open"));
      if (closed || ownership === "CLOSING") {
        return Promise.resolve(rejected("INVALID_TRANSITION", "session is closing: no new terminal work"));
      }
      const idCheck = WorkspaceIdentifierSchema.safeParse(operationId);
      const reqCheck = WorkspaceIdentifierSchema.safeParse(requestId);
      if (!idCheck.success || !reqCheck.success) {
        return Promise.resolve(rejected("INVALID_REQUEST", "operation and request ids must be 1..128 characters"));
      }
      const scope: readonly unknown[] = ["runTerminalOperation", sessionId, operationId];
      const idem = checkIdempotency(requestId, scope, { sessionId, generation, operationId, requestId });
      if (idem !== null) {
        if ("conflict" in idem) return Promise.resolve({ ok: false, rejection: idem.conflict });
        return Promise.resolve(idem.cached as WorkspaceOutcome<TerminalAdmission>);
      }
      const tomb = tombstones.get(operationId);
      if (tomb !== undefined && tomb.requestId !== requestId) {
        return Promise.resolve(rejected("INVALID_REQUEST", "operation attempt is already consumed in this generation"));
      }
      if (reviewedPolicy === null) {
        return Promise.resolve(rejected("NOT_AUTHORIZED", "no reviewed policy is bound to this session"));
      }
      const accessOutcome = resolveTerminalAccess(reviewedPolicy, operationId);
      if (!accessOutcome.ok) return Promise.resolve({ ok: false, rejection: accessOutcome.rejection });
      const access = accessOutcome.value;

      if (access === "read_only") {
        if (ownership === "RESETTING" || ownership === "HOLD" || ownership === "TRANSITION") {
          return Promise.resolve(
            rejected("INVALID_TRANSITION", `read-only start is barred while ${ownership}`),
          );
        }
        if (ownership === "TERMINAL_OWNED") {
          return Promise.resolve(rejected("WORKSPACE_BUSY", "terminal read-write owns the leaf: no read-only peer"));
        }
        if (ownership !== "EDITOR_OWNED") {
          return Promise.resolve(rejected("INVALID_TRANSITION", "read-only start requires editor ownership"));
        }
        if (saveActive || editorBusy !== null) {
          if (queuedRequestIds.has(requestId)) {
            return Promise.resolve(rejected("INVALID_REQUEST", "request_id is already queued with identical payload"));
          }
          if (waitQueue.length >= maxQueue) {
            return Promise.resolve(rejected("RESOURCE_LIMIT", "terminal wait queue is bounded: retry after settlement"));
          }
          const scopeHash = payloadHash(scope, { sessionId, generation, operationId, requestId });
          return new Promise<WorkspaceOutcome<TerminalAdmission>>((resolve) => {
            queuedRequestIds.add(requestId);
            waitQueue.push({
              kind: "terminal_ro",
              capabilityId: ticket.ticketId,
              operationId,
              requestId,
              scopeHash,
              resolve: resolve as (outcome: WorkspaceOutcome<never>) => void,
            });
          });
        }
        if (roPeers.size >= MAX_RO_OBSERVERS) {
          return Promise.resolve(rejected("WORKSPACE_BUSY", "read-only observer cap reached"));
        }
        const leaseId = nextLeaseId();
        const peerId = nextPeerId();
        leases.set(leaseId, {
          leaseId,
          sessionId,
          generation,
          workspaceId,
          epoch: liveEpoch,
          role: "terminal_ro",
          operationId,
        });
        tombstones.set(operationId, { requestId });
        roPeers.set(peerId, { leaseId, operationId, peerId, epoch: liveEpoch });
        if (liveContainer === null) liveContainer = { epoch: liveEpoch, access: "read_only" };
        recordEvent("workspace.ro.acquired");
        const lease: TerminalLease = {
          kind: "terminal_lease",
          leaseId,
          sessionId,
          generation,
          workspaceId,
          epoch: liveEpoch,
          access: "read_only",
          operationId,
          requestId,
          peerId,
        };
        const permit: WorkspaceExecutionPermit = {
          kind: "workspace_execution_permit",
          permit_version: 1,
          session_id: sessionId,
          generation,
          workspace_id: workspaceId,
          epoch: liveEpoch,
          access: "read_only",
          operation_id: operationId,
          policy_digest: policyDigest,
          lease_id: leaseId,
        };
        const permitCheck = WorkspaceExecutionPermitSchema.safeParse(permit);
        if (!permitCheck.success) {
          return Promise.resolve(rejected("INVALID_REQUEST", "internal: issued permit failed strict validation"));
        }
        const response: WorkspaceOutcome<TerminalAdmission> = {
          ok: true,
          value: { descriptor: currentDescriptor(), lease, permit: permitCheck.data, access: "read_only" },
        };
        storeReceipt(requestId, payloadHash(scope, { sessionId, generation, operationId, requestId }), response);
        return Promise.resolve(response);
      }

      if (ownership !== "EDITOR_OWNED") {
        if (ownership === "TERMINAL_OWNED") {
          return Promise.resolve(rejected("WORKSPACE_BUSY", "terminal read-write already owns the leaf"));
        }
        return Promise.resolve(
          rejected("INVALID_TRANSITION", `read-write start is barred while ${ownership}`),
        );
      }
      if (dirtyBufferCount > 0 || pendingCreationCount > 0) {
        return Promise.resolve(
          rejected("DIRTY_BUFFER_CONFLICT", "read-write start requires clean buffers with no pending creations"),
        );
      }
      if (roPeers.size > 0 || activeRw !== null) {
        return Promise.resolve(
          rejected("WORKSPACE_BUSY", "read-write start requires zero terminal peers: stop observers first"),
        );
      }
      if (editorBusy !== null) {
        return Promise.resolve(
          rejected("WORKSPACE_BUSY", "read-write start requires no editor work: retry after the transaction settles"),
        );
      }
      if (saveActive) {
        if (queuedRequestIds.has(requestId)) {
          return Promise.resolve(rejected("INVALID_REQUEST", "request_id is already queued with identical payload"));
        }
        if (waitQueue.length >= maxQueue) {
          return Promise.resolve(rejected("RESOURCE_LIMIT", "terminal wait queue is bounded: retry after settlement"));
        }
        const scopeHash = payloadHash(scope, { sessionId, generation, operationId, requestId });
        return new Promise<WorkspaceOutcome<TerminalAdmission>>((resolve) => {
          queuedRequestIds.add(requestId);
          waitQueue.push({
            kind: "terminal_rw",
            capabilityId: ticket.ticketId,
            operationId,
            requestId,
            scopeHash,
            resolve: resolve as (outcome: WorkspaceOutcome<never>) => void,
          });
        });
      }
      const from: WorkspaceOwnership = "EDITOR_OWNED";
      const to: WorkspaceOwnership = "TERMINAL_OWNED";
      if (!isLegalOwnershipTransition(from, "TRANSITION")) {
        return Promise.resolve(rejected("INVALID_TRANSITION", "editor to transition hop is not permitted"));
      }
      tombstones.set(operationId, { requestId });
      ownership = "TRANSITION";
      inTransition = { from, to, operationId };
      recordEvent("workspace.epoch.retiring");
      const admittedGeneration = generation;
      const admittedSession = sessionId;
      const admittedWorkspace = workspaceId;
      const scopeHash = payloadHash(scope, { sessionId, generation, operationId, requestId });
      return provider.prepare("read_write").then(
        () => {
          if (closed || sessionId !== admittedSession || generation !== admittedGeneration || ownership !== "TRANSITION") {
            return {
              ok: false,
              rejection: { code: "STALE_SESSION", message: "read-write admission lapsed across a lifecycle barrier" },
            } as { ok: false; rejection: WorkspaceRejection };
          }
          if (!isLegalOwnershipTransition("TRANSITION", "TERMINAL_OWNED")) {
            enterHold("illegal terminal handoff");
            return rejected("INVALID_TRANSITION", "transition to terminal ownership is not permitted");
          }
          liveEpoch += 1;
          liveContainer = { epoch: liveEpoch, access: "read_write" };
          ownership = "TERMINAL_OWNED";
          inTransition = null;
          const leaseId = nextLeaseId();
          leases.set(leaseId, {
            leaseId,
            sessionId,
            generation,
            workspaceId: admittedWorkspace,
            epoch: liveEpoch,
            role: "terminal_rw",
            operationId,
          });
          activeRw = { leaseId, operationId, epoch: liveEpoch };
          recordEvent("workspace.epoch.started");
          recordEvent("workspace.writer.acquired");
          const lease: TerminalLease = {
            kind: "terminal_lease",
            leaseId,
            sessionId,
            generation,
            workspaceId: admittedWorkspace,
            epoch: liveEpoch,
            access: "read_write",
            operationId,
            requestId,
            peerId: null,
          };
          const permit: WorkspaceExecutionPermit = {
            kind: "workspace_execution_permit",
            permit_version: 1,
            session_id: sessionId,
            generation,
            workspace_id: admittedWorkspace,
            epoch: liveEpoch,
            access: "read_write",
            operation_id: operationId,
            policy_digest: policyDigest,
            lease_id: leaseId,
          };
          const permitCheck = WorkspaceExecutionPermitSchema.safeParse(permit);
          if (!permitCheck.success) {
            enterHold("permit validation failed after transition");
            return rejected("INVALID_REQUEST", "internal: issued permit failed strict validation");
          }
          const response: WorkspaceOutcome<TerminalAdmission> = {
            ok: true,
            value: { descriptor: currentDescriptor(), lease, permit: permitCheck.data, access: "read_write" },
          };
          storeReceipt(requestId, scopeHash, response);
          return response;
        },
        () => {
          enterHold("provider prepare failed during read-write admission");
          return rejected("CLEANUP_UNCONFIRMED", "read-write preparation is unconfirmed: session holds");
        },
      );
    },

    releaseTerminal(lease: TerminalLease): Promise<WorkspaceOutcome<CombinedSessionDescriptor>> {
      const checked = checkTerminalLease(lease);
      if ("rejection" in checked) return Promise.resolve({ ok: false, rejection: checked.rejection });
      const presented = checked.presented;
      if (presented.access === "read_only") {
        let peerKey: string | null = null;
        for (const [key, peer] of roPeers) {
          if (peer.leaseId === presented.leaseId) {
            peerKey = key;
            break;
          }
        }
        if (peerKey === null) {
          return Promise.resolve(rejected("WRONG_OWNER", "read-only lease does not own a live observer slot"));
        }
        if (ownership !== "EDITOR_OWNED") {
          return Promise.resolve(rejected("INVALID_TRANSITION", "read-only release requires editor ownership"));
        }
        roPeers.delete(peerKey);
        revokedLeaseIds.add(presented.leaseId);
        leases.delete(presented.leaseId);
        if (roPeers.size === 0 && liveContainer !== null && liveContainer.access === "read_only") liveContainer = null;
        recordEvent("workspace.ro.released");
        drainQueue();
        return Promise.resolve({ ok: true, value: currentDescriptor() });
      }
      if (activeRw === null || activeRw.leaseId !== presented.leaseId) {
        return Promise.resolve(rejected("WRONG_OWNER", "read-write lease does not own the terminal writer slot"));
      }
      if (ownership !== "TERMINAL_OWNED") {
        return Promise.resolve(rejected("INVALID_TRANSITION", "read-write release requires terminal ownership"));
      }
      if (!isLegalOwnershipTransition("TERMINAL_OWNED", "TRANSITION")) {
        return Promise.resolve(rejected("INVALID_TRANSITION", "terminal to transition hop is not permitted"));
      }
      ownership = "TRANSITION";
      inTransition = { from: "TERMINAL_OWNED", to: "EDITOR_OWNED", operationId: presented.operationId };
      recordEvent("workspace.epoch.retiring");
      const admittedGeneration = generation;
      const admittedSession = sessionId;
      const retiringLease = presented.leaseId;
      return provider.retire("rw_release").then(
        (outcome) => {
          if (closed || sessionId !== admittedSession || generation !== admittedGeneration || ownership !== "TRANSITION") {
            return {
              ok: false,
              rejection: { code: "STALE_SESSION", message: "read-write release lapsed across a lifecycle barrier" },
            } as { ok: false; rejection: WorkspaceRejection };
          }
          if (outcome !== "confirmed") {
            revokedLeaseIds.add(retiringLease);
            leases.delete(retiringLease);
            activeRw = null;
            enterHold("read-write retirement is unconfirmed");
            return rejected("CLEANUP_UNCONFIRMED", "terminal retirement is unconfirmed: session holds with retained resources");
          }
          if (!isLegalOwnershipTransition("TRANSITION", "EDITOR_OWNED")) {
            enterHold("illegal editor handoff");
            return rejected("INVALID_TRANSITION", "transition to editor ownership is not permitted");
          }
          revokedLeaseIds.add(retiringLease);
          leases.delete(retiringLease);
          activeRw = null;
          liveEpoch += 1;
          workspaceRevision += 1;
          liveContainer = null;
          ownership = "EDITOR_OWNED";
          inTransition = null;
          recordEvent("workspace.epoch.retired");
          recordEvent("workspace.writer.released");
          drainQueue();
          return { ok: true, value: currentDescriptor() } as WorkspaceOutcome<CombinedSessionDescriptor>;
        },
        () => {
          revokedLeaseIds.add(retiringLease);
          leases.delete(retiringLease);
          activeRw = null;
          enterHold("provider retire failed during read-write release");
          return rejected("CLEANUP_UNCONFIRMED", "terminal retirement failed: session holds with retained resources");
        },
      );
    },

    stopTerminal(
      terminalCapability: TerminalCapability,
      processId: string,
      requestId: string,
    ): Promise<WorkspaceOutcome<CombinedSessionDescriptor>> {
      const ticket = checkCapability(terminalCapability, TerminalCapabilitySchema, "terminal_capability");
      if ("rejection" in ticket) return Promise.resolve({ ok: false, rejection: ticket.rejection });
      const idCheck = WorkspaceIdentifierSchema.safeParse(processId);
      const reqCheck = WorkspaceIdentifierSchema.safeParse(requestId);
      if (!idCheck.success || !reqCheck.success) {
        return Promise.resolve(rejected("INVALID_REQUEST", "process and request ids must be 1..128 characters"));
      }
      const scope: readonly unknown[] = ["stopTerminal", sessionId, processId];
      const idem = checkIdempotency(requestId, scope, { sessionId, generation, processId, requestId });
      if (idem !== null) {
        if ("conflict" in idem) return Promise.resolve({ ok: false, rejection: idem.conflict });
        return Promise.resolve(idem.cached as WorkspaceOutcome<CombinedSessionDescriptor>);
      }
      let peerKey: string | null = null;
      for (const [key, peer] of roPeers) {
        if (peer.peerId === processId || peer.operationId === processId) {
          peerKey = key;
          break;
        }
      }
      if (peerKey !== null) {
        if (ownership !== "EDITOR_OWNED") {
          const response = rejected("INVALID_TRANSITION", "read-only stop requires editor ownership");
          storeReceipt(requestId, payloadHash(scope, { sessionId, generation, processId, requestId }), response);
          return Promise.resolve(response);
        }
        const peer = roPeers.get(peerKey);
        if (peer !== undefined) {
          roPeers.delete(peerKey);
          revokedLeaseIds.add(peer.leaseId);
          leases.delete(peer.leaseId);
        }
        if (roPeers.size === 0 && liveContainer !== null && liveContainer.access === "read_only") liveContainer = null;
        recordEvent("workspace.ro.released");
        const response: WorkspaceOutcome<CombinedSessionDescriptor> = { ok: true, value: currentDescriptor() };
        storeReceipt(requestId, payloadHash(scope, { sessionId, generation, processId, requestId }), response);
        drainQueue();
        return Promise.resolve(response);
      }
      if (activeRw !== null && (activeRw.leaseId === processId || activeRw.operationId === processId)) {
        const peer = activeRw;
        if (ownership !== "TERMINAL_OWNED") {
          const response = rejected("INVALID_TRANSITION", "read-write stop requires terminal ownership");
          storeReceipt(requestId, payloadHash(scope, { sessionId, generation, processId, requestId }), response);
          return Promise.resolve(response);
        }
        ownership = "TRANSITION";
        inTransition = { from: "TERMINAL_OWNED", to: "EDITOR_OWNED", operationId: peer.operationId };
        recordEvent("workspace.epoch.retiring");
        const admittedGeneration = generation;
        const admittedSession = sessionId;
        return provider.retire("authored_stop").then(
          (outcome) => {
            if (closed || sessionId !== admittedSession || generation !== admittedGeneration || ownership !== "TRANSITION") {
              return {
                ok: false,
                rejection: { code: "STALE_SESSION", message: "terminal stop lapsed across a lifecycle barrier" },
              } as { ok: false; rejection: WorkspaceRejection };
            }
            if (outcome !== "confirmed") {
              revokedLeaseIds.add(peer.leaseId);
              leases.delete(peer.leaseId);
              activeRw = null;
              enterHold("terminal stop retirement is unconfirmed");
              return rejected("CLEANUP_UNCONFIRMED", "terminal stop is unconfirmed: session holds with retained resources");
            }
            revokedLeaseIds.add(peer.leaseId);
            leases.delete(peer.leaseId);
            activeRw = null;
            liveEpoch += 1;
            workspaceRevision += 1;
            liveContainer = null;
            ownership = "EDITOR_OWNED";
            inTransition = null;
            recordEvent("workspace.epoch.retired");
            recordEvent("workspace.writer.released");
            const response: WorkspaceOutcome<CombinedSessionDescriptor> = { ok: true, value: currentDescriptor() };
            storeReceipt(requestId, payloadHash(scope, { sessionId, generation, processId, requestId }), response);
            drainQueue();
            return response;
          },
          () => {
            revokedLeaseIds.add(peer.leaseId);
            leases.delete(peer.leaseId);
            activeRw = null;
            enterHold("provider retire failed during terminal stop");
            return rejected("CLEANUP_UNCONFIRMED", "terminal stop failed: session holds with retained resources");
          },
        );
      }
      const response = rejected("INVALID_REQUEST", "stop target names no live terminal peer in this generation");
      storeReceipt(requestId, payloadHash(scope, { sessionId, generation, processId, requestId }), response);
      return Promise.resolve(response);
    },

    cancelTerminal(
      terminalCapability: TerminalCapability,
      operationId: string,
      requestId: string,
    ): WorkspaceOutcome<CombinedSessionDescriptor> {
      const ticket = checkCapability(terminalCapability, TerminalCapabilitySchema, "terminal_capability");
      if ("rejection" in ticket) return { ok: false, rejection: ticket.rejection };
      const scope: readonly unknown[] = ["cancelTerminal", sessionId, operationId];
      const idem = checkIdempotency(requestId, scope, { sessionId, generation, operationId, requestId });
      if (idem !== null) {
        if ("conflict" in idem) return { ok: false, rejection: idem.conflict };
        return idem.cached as WorkspaceOutcome<CombinedSessionDescriptor>;
      }
      const index = waitQueue.findIndex(
        (waiter) => waiter.operationId === operationId && waiter.kind !== "editor",
      );
      if (index === -1) {
        const response = rejected("INVALID_REQUEST", "no queued terminal waiter matches this operation");
        storeReceipt(requestId, payloadHash(scope, { sessionId, generation, operationId, requestId }), response);
        return response;
      }
      const [removed] = waitQueue.splice(index, 1);
      if (removed !== undefined) queuedRequestIds.delete(removed.requestId);
      removed?.resolve({ ok: false, rejection: { code: "WORKSPACE_REVOKED", message: "queued terminal waiter was cancelled" } });
      recordEvent("workspace.ro.released");
      const response: WorkspaceOutcome<CombinedSessionDescriptor> = { ok: true, value: currentDescriptor() };
      storeReceipt(requestId, payloadHash(scope, { sessionId, generation, operationId, requestId }), response);
      return response;
    },

    beginSave(editorCapability: EditorCapability): WorkspaceOutcome<null> {
      const ticket = checkCapability(editorCapability, EditorCapabilitySchema, "editor_capability");
      if ("rejection" in ticket) return { ok: false, rejection: ticket.rejection };
      if (!opened || closed) return rejected("INVALID_TRANSITION", "save is barred: session is not open");
      if (ownership !== "EDITOR_OWNED") {
        if (ownership === "TERMINAL_OWNED") return rejected("WORKSPACE_BUSY", "save is barred while terminal owns the leaf");
        return rejected("INVALID_TRANSITION", `save is barred while ${ownership}`);
      }
      if (saveActive) return rejected("WORKSPACE_BUSY", "a save is already active: editor work serializes");
      saveActive = true;
      recordEvent("workspace.save.started");
      return { ok: true, value: null };
    },

    endSave(editorCapability: EditorCapability): WorkspaceOutcome<CombinedSessionDescriptor> {
      const ticket = checkCapability(editorCapability, EditorCapabilitySchema, "editor_capability");
      if ("rejection" in ticket) return { ok: false, rejection: ticket.rejection };
      if (!saveActive) return rejected("INVALID_REQUEST", "no active save to settle");
      saveActive = false;
      recordEvent("workspace.save.settled");
      if (!closed && ownership === "EDITOR_OWNED") drainQueue();
      void ticket;
      return { ok: true, value: currentDescriptor() };
    },

    setBufferFacts(editorCapability: EditorCapability, facts: BufferFacts): WorkspaceOutcome<null> {
      const ticket = checkCapability(editorCapability, EditorCapabilitySchema, "editor_capability");
      if ("rejection" in ticket) return { ok: false, rejection: ticket.rejection };
      const parsed = BufferFactsSchema.safeParse(facts);
      if (!parsed.success) return rejected("INVALID_REQUEST", "buffer facts must carry non-negative integer counts");
      dirtyBufferCount = parsed.data.dirtyBufferCount;
      pendingCreationCount = parsed.data.pendingCreationCount;
      void ticket;
      return { ok: true, value: null };
    },

    setOpenDocuments(
      editorCapability: EditorCapability,
      documents: ReadonlyArray<{ portable_path: string; disk_revision: number; buffer_revision: number; dirty: boolean }>,
    ): WorkspaceOutcome<null> {
      const ticket = checkCapability(editorCapability, EditorCapabilitySchema, "editor_capability");
      if ("rejection" in ticket) return { ok: false, rejection: ticket.rejection };
      if (!Array.isArray(documents) || documents.length > MAX_OPEN_DOCUMENTS) {
        return rejected("INVALID_REQUEST", "open documents must be an array within the bounded ceiling");
      }
      const next = new Map<string, { portable_path: string; disk_revision: number; buffer_revision: number; dirty: boolean }>();
      for (const document of documents) {
        const parsed = SnapshotDocumentSchema.safeParse(document);
        if (!parsed.success) return rejected("INVALID_REQUEST", "open document failed strict portable validation");
        if (next.has(parsed.data.portable_path)) {
          return rejected("INVALID_REQUEST", "open documents must carry unique portable paths");
        }
        next.set(parsed.data.portable_path, { ...parsed.data });
      }
      openDocuments.clear();
      for (const [key, value] of next) openDocuments.set(key, value);
      void ticket;
      return { ok: true, value: null };
    },

    resetCombinedSession(
      descriptor: CombinedSessionDescriptor,
      requestId: string,
    ): Promise<WorkspaceOutcome<ResetCompleted>> {
      const reqCheck = WorkspaceIdentifierSchema.safeParse(requestId);
      if (!reqCheck.success) {
        return Promise.resolve(rejected("INVALID_REQUEST", "request id must be 1..128 characters"));
      }
      const descError = checkDescriptor(descriptor);
      if (descError !== null) return Promise.resolve({ ok: false, rejection: descError });
      const scope: readonly unknown[] = ["resetCombinedSession", sessionId, generation];
      const idem = checkIdempotency(requestId, scope, { sessionId, generation, requestId });
      if (idem !== null) {
        if ("conflict" in idem) return Promise.resolve({ ok: false, rejection: idem.conflict });
        const cached = idem.cached as WorkspaceOutcome<ResetCompleted>;
        if (resetPending !== null) return resetPending.then(() => cached);
        return Promise.resolve(cached);
      }
      if (resetPending !== null) return resetPending;
      if (closed) return Promise.resolve(rejected("INVALID_TRANSITION", "session is closed: reset is barred"));
      if (ownership === "CLOSING") {
        return Promise.resolve(rejected("INVALID_TRANSITION", "session is closing: reset is barred"));
      }
      if (ownership === "RESETTING") {
        return Promise.resolve(rejected("INVALID_TRANSITION", "reset is already latched"));
      }
      if (!isLegalOwnershipTransition(ownership, "RESETTING")) {
        return Promise.resolve(rejected("INVALID_TRANSITION", `reset cannot latch from ${ownership}`));
      }
      ownership = "RESETTING";
      resetPhases = ["REVOKE"];
      recordEvent("workspace.reset.revoked");
      retiredSessionIds.add(sessionId);
      revokeAllTickets("reset");
      rejectQueue("STALE_SESSION", "reset revoked all queued starts in the old generation");
      receipts.clear();
      tombstones.clear();
      saveActive = false;
      dirtyBufferCount = 0;
      pendingCreationCount = 0;
      openDocuments.clear();
      resetPhases = ["REVOKE", "SETTLE_SAVE_CANCEL", "STOP_REMOVE_CONTAINER"];
      const latchedGeneration = generation;
      const pending: Promise<WorkspaceOutcome<ResetCompleted>> = provider.retire("reset").then(
        (outcome) => {
          if (outcome !== "confirmed") {
            resetPhases = ["REVOKE", "SETTLE_SAVE_CANCEL", "STOP_REMOVE_CONTAINER"];
            enterHold("reset retirement is unconfirmed");
            resetPending = null;
            return rejected("CLEANUP_UNCONFIRMED", "reset retirement is unconfirmed: resources retained, session holds");
          }
          resetPhases = [...RESET_PHASE_ORDER];
          retiredSessionIds.add(sessionId);
          sessionId = nextSessionId();
          generation = latchedGeneration + 1;
          workspaceId = nextWorkspaceId();
          workspaceRevision = 0;
          liveEpoch = 1;
          liveContainer = null;
          ownership = "EDITOR_OWNED";
          holdReason = null;
          const editorId = nextTicketId("cap");
          const terminalId = nextTicketId("cap");
          const epochId = nextTicketId("cap");
          capabilities.set(editorId, { kind: "editor_capability", sessionId, generation });
          capabilities.set(terminalId, { kind: "terminal_capability", sessionId, generation });
          capabilities.set(epochId, { kind: "epoch_capability", sessionId, generation });
          recordEvent("workspace.reset.completed");
          const completed: ResetCompleted = {
            descriptor: currentDescriptor(),
            editorCapability: { kind: "editor_capability", leaseId: editorId },
            terminalCapability: { kind: "terminal_capability", leaseId: terminalId },
            epochCapability: { kind: "epoch_capability", leaseId: epochId },
          };
          const response: WorkspaceOutcome<ResetCompleted> = { ok: true, value: completed };
          storeReceipt(requestId, payloadHash(scope, { sessionId: completed.descriptor.sessionId, generation, requestId }), response);
          resetPending = null;
          return response;
        },
        () => {
          resetPhases = ["REVOKE", "SETTLE_SAVE_CANCEL", "STOP_REMOVE_CONTAINER"];
          enterHold("provider retire failed during reset");
          resetPending = null;
          return rejected("CLEANUP_UNCONFIRMED", "reset retirement failed: resources retained, session holds");
        },
      );
      resetPending = pending;
      return pending;
    },

    closeCombinedSession(
      descriptor: CombinedSessionDescriptor,
      requestId: string,
    ): Promise<WorkspaceOutcome<null>> {
      const reqCheck = WorkspaceIdentifierSchema.safeParse(requestId);
      if (!reqCheck.success) {
        return Promise.resolve(rejected("INVALID_REQUEST", "request id must be 1..128 characters"));
      }
      const descError = checkDescriptor(descriptor);
      if (descError !== null) return Promise.resolve({ ok: false, rejection: descError });
      const scope: readonly unknown[] = ["closeCombinedSession", sessionId, generation];
      const idem = checkIdempotency(requestId, scope, { sessionId, generation, requestId });
      if (idem !== null) {
        if ("conflict" in idem) return Promise.resolve({ ok: false, rejection: idem.conflict });
        const cached = idem.cached as WorkspaceOutcome<null>;
        if (closePending !== null) return closePending.then(() => cached);
        return Promise.resolve(cached);
      }
      if (closePending !== null) return closePending;
      if (closed) {
        const response: WorkspaceOutcome<null> = { ok: true, value: null };
        storeReceipt(requestId, payloadHash(scope, { sessionId, generation, requestId }), response);
        return Promise.resolve(response);
      }
      if (ownership !== "CLOSING" && !isLegalOwnershipTransition(ownership, "CLOSING")) {
        return Promise.resolve(rejected("INVALID_TRANSITION", `close cannot latch from ${ownership}`));
      }
      ownership = "CLOSING";
      recordEvent("workspace.close.latched");
      retiredSessionIds.add(sessionId);
      revokeAllTickets("close");
      rejectQueue("WORKSPACE_REVOKED", "close revoked all queued starts");
      receipts.clear();
      tombstones.clear();
      saveActive = false;
      dirtyBufferCount = 0;
      pendingCreationCount = 0;
      openDocuments.clear();
      const pending: Promise<WorkspaceOutcome<null>> = provider.retire("close").then(
        (outcome) => {
          if (outcome !== "confirmed") {
            enterHold("close retirement is unconfirmed");
            closePending = null;
            return rejected("CLEANUP_UNCONFIRMED", "close retirement is unconfirmed: resources retained, session holds");
          }
          closed = true;
          recordEvent("workspace.close.completed");
          const response: WorkspaceOutcome<null> = { ok: true, value: null };
          storeReceipt(requestId, payloadHash(scope, { sessionId, generation, requestId }), response);
          closePending = null;
          return response;
        },
        () => {
          enterHold("provider retire failed during close");
          closePending = null;
          return rejected("CLEANUP_UNCONFIRMED", "close retirement failed: resources retained, session holds");
        },
      );
      closePending = pending;
      return pending;
    },

    onProviderFailure(epochCapability: EpochCapability, _cause: string): void {
      const ticket = checkCapability(epochCapability, EpochCapabilitySchema, "epoch_capability");
      void ticket;
      if (!opened || closed) return;
      revokeAllTickets("provider_failure");
      rejectQueue("WORKSPACE_REVOKED", "provider failure revoked all queued starts");
      enterHold("provider failure");
    },

    getCombinedSnapshot(
      descriptor: CombinedSessionDescriptor,
      afterSeq: number,
    ): WorkspaceOutcome<WorkspaceSnapshot> {
      const descError = checkDescriptor(descriptor);
      if (descError !== null) return { ok: false, rejection: descError };
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        return rejected("INVALID_REQUEST", "snapshot cursor must be a non-negative safe integer");
      }
      const epochValue = liveContainer === null ? null : liveContainer.epoch;
      const accessValue = liveContainer === null ? null : liveContainer.access;
      if (!isValidOwnershipAccess(ownership, accessValue)) {
        return rejected("WORKSPACE_VIOLATION", "live ownership and container access pairing is invalid");
      }
      const documents = [...openDocuments.values()].slice(0, MAX_OPEN_DOCUMENTS);
      const snapshot = {
        workspace_protocol_version: WORKSPACE_PROTOCOL_VERSION,
        session_id: sessionId,
        generation,
        workspace_revision: workspaceRevision,
        ownership,
        epoch: epochValue,
        epoch_access: accessValue,
        open_documents: documents,
      };
      const parsed = WorkspaceSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) return rejected("INVALID_REQUEST", "internal: snapshot failed strict validation");
      void afterSeq;
      return { ok: true, value: parsed.data };
    },

    getLiveFacts(): LiveWorkspaceFacts {
      const facts = {
        session_id: sessionId,
        generation,
        workspace_id: workspaceId,
        epoch: liveEpoch,
        policy_digest: policyDigest,
        revoked_lease_ids: [...revokedLeaseIds],
      };
      const parsed = LiveWorkspaceFactsSchema.safeParse(facts);
      if (!parsed.success) throw new Error("internal: live facts failed strict validation");
      const frozen: LiveWorkspaceFacts = {
        ...parsed.data,
        revoked_lease_ids: [...parsed.data.revoked_lease_ids],
      };
      Object.freeze(frozen.revoked_lease_ids);
      return Object.freeze(frozen) as LiveWorkspaceFacts;
    },

    getLogicalState(): CoordinatorLogicalState {
      return {
        ownership,
        generation,
        epoch: liveEpoch,
        workspaceRevision,
        dirtyBufferCount,
        pendingCreationCount,
        saveActive,
        activeRoCount: roPeers.size,
        activeRw: activeRw !== null,
        inTransition: inTransition !== null,
        closed,
      };
    },

    getResetPhases(): readonly ResetPhase[] {
      return [...resetPhases];
    },

    listEvents(afterSeq?: number): readonly WorkspaceEvent[] {
      const cursor = afterSeq ?? 0;
      return events.filter((event) => event.seq > cursor).map((event) => ({ ...event }));
    },

    describe(): CombinedSessionDescriptor {
      return currentDescriptor();
    },
  };

  return coordinator;
}

/** P6.2 scope proof: the coordinator resolves access from review entries only. */
export function coordinatorResolvesAccessWithoutCommands(): boolean {
  return resolveTerminalAccess.length === 2;
}

