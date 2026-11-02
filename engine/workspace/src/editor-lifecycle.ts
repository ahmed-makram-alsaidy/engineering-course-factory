// P6.11 deterministic editor cancel, reset and replay — complete lifecycle integration.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 4 (trust boundary:
// validated IR -> main-only reviewed catalog -> editor admission -> immutable
// semantic plan -> trusted working document -> bounded visual projection ->
// explicit safe persistence -> byte verification -> terminal result/journal),
// 5 (editor authority: main owns per-file working text, revision, committed
// disk hash/existence, dirty status and operation reservation; each edit has
// preimage B0, candidate B1, hashes, revision, exact UTF-16 ranges,
// generation and plan ID; B0 stays committed while animation projects
// prefixes of B1; on successful presentation completion main installs B1 as
// working text, disk remains D0; on cancel/failure main keeps B0 and sends a
// replacement snapshot; previous successful unsaved edits in B0 survive
// cancellation), 6 (workspace/file authority: disk D is sole truth visible
// to terminal processes, main B is authoritative unsaved document, Monaco V
// is disposable presentation; dirty means B differs from D or pending
// creation; no second workspace, no renderer-to-disk copyback, no
// per-character writes), 7 (operation model and admission: revalidate via
// compiler authority, clone/freeze, verify digest, hierarchy, unique IDs,
// ordinal/provenance and type/family consistency; operation_id := step_id;
// only the five types; one attempt per operation with tombstones; authored
// editor order), 8 (type_code semantics), 9 (replace_code semantics),
// 10 (file_open/file_create/file_save document rules; replacement
// publication is the commit point; before it failure removes staging and
// retains D0/B; after it verification failure reports COMMIT_UNCERTAIN,
// freezes and retains evidence, never rollback), 12 (strict LF profile),
// 13 (cancel before working-document commit restores B0/V and emits one
// cancelled result with D unchanged; cancel after type/replace completion
// reports already-final without undo; for save serialize cancel with commit:
// before publication abort, after publication finish verification and return
// completed or COMMIT_UNCERTAIN, never cancelled-with-hidden-write; reset
// revokes generation immediately, blocks both engine starts, cancels
// animation, awaits save settlement, tears down all P5 processes/container,
// then creates a fresh leaf and verifies the same seed manifest;
// reinitialize B/V and operation ledger only after cleanup confirmation;
// old callbacks/acks/events fail generation fencing; cleanup uncertainty
// holds with no new session; replay starts from seed, not undo or a mutated
// old leaf), 14 (journal and events: new versioned editor event union with
// monotonic editor seq, common session/generation/operation/attempt/
// provenance plus compiled/policy digests, exactly one final result per
// accepted attempt, completed carries revision/before/after hashes/dirty/
// disk effect none/created/saved/unchanged, no full source text or host
// paths, visual chunks transient, pages bounded 256 events/256 KiB, journal
// failure before side effect blocks it and after commit makes outcome
// uncertain), 15 (identifier-only renderer DTOs; replay/snapshot references
// are opaque main-issued IDs, never arbitrary paths; acks carry no
// text/hash authority), 17 (portable path rules), 18 (resource bounds),
// 21 (admission errors zero side effects; SAVE_FAILED before commit retains
// dirty B and unchanged D; COMMIT_UNCERTAIN after publication requires
// reset, never next action; CLEANUP_UNCONFIRMED holds all new work),
// 26.1 (exclusive writer epochs), 26.4 (ownership table), 26.5 (file
// generations), 26.7 (exact save algorithm with cancel/reset linearizing
// against the rename), 26.8 (lifecycle interfaces), 26.9 (epoch extension
// and journal continuity), 26.10 (canonical combined reset steps 1-7 with
// new opaque session_id and generation G+1, close/switch/renderer-loss
// barrier, concurrent-reset convergence, shutdown awaiting adapter and
// container absence), 26.12 (required proofs) with
// docs/adr/ADR-0011-shared-workspace-ownership.md decisions 5-6.
//
// Canonical P6.11 name: P6.11 Cancel/reset/replay.
// Objective: complete editor plus terminal lifecycle integration.
// PASS gate: race and crash tests, no stale work.
//
// THE CENTRAL SEMANTIC PROPERTIES (proven by the P6.11 suite, not by types):
//   1. Cancellation is operation-aware, never one generic rollback rule.
//      file_open cancel before registration fences late completion with zero
//      disk or registry effects; after binding it reports already-final
//      without unbinding. file_create cancel before save leaves the disk
//      absent with staging preserved for diagnostics; reset vanishes it.
//      type_code and replace_code cancel before completion restore the exact
//      pre-operation buffer B0 with disk unchanged; after completion they
//      report already-final without undo. file_save cancel serializes
//      against the adapter rename: before publication it aborts with staging
//      discarded and one cancelled outcome; at or after publication it
//      settles verification and journal on the old generation as completed
//      or COMMIT_UNCERTAIN, never cancelled-with-hidden-write.
//   2. Repeated cancel is deterministic and exactly-once: no double
//      rollback, no double journal outcome, no second cleanup, no second
//      tombstone mutation. The first terminal outcome wins; duplicates
//      converge on it.
//   3. Reset is a generation boundary with the frozen ordering: revoke new
//      work, cancel and settle active editor operations, settle saves
//      honestly, retire the Docker and container access, confirm cleanup,
//      invalidate old documents and plans and tombstones, restore and reseed
//      canonical workspace state, advance session and workspace generation
//      exactly once, expose the new clean runtime. Old admissions,
//      documents, type plans, replace plans, save attempts, leases,
//      container epochs and callbacks cannot mutate the next generation;
//      late async completion fails closed.
//   4. Reset before save commit leaves the destination unchanged with no
//      staging residue; reset after commit settles honestly as completed or
//      uncertain without pretending the disk never changed and without
//      letting a stale save callback mark a new-generation document clean.
//   5. Reset with an active read-only or read-write Docker epoch revokes
//      ownership, retires the container, confirms daemon absence and fences
//      the old epoch before any new generation is exposed. Unconfirmed
//      cleanup holds with retained resources and no new writer.
//   6. Replay reconstructs semantic state from canonical authored operations
//      and trusted journal and tombstone state without blindly executing
//      side effects again: a completed type replay never appends text twice,
//      a completed replace replay never replaces twice, a completed save
//      replay never calls publication again (publication count stays one).
//      Cancelled, failed and commit-uncertain replays never mutate and
//      never auto-retry. Journal replay preserves sequence ordering, the
//      exact terminal outcome, sanitized errors and bounded metadata with
//      no source text leakage and no host path leakage. Old-generation
//      events never interpret as current-generation operations.
//   7. Journal replay (reconstructing observable runtime state) is distinct
//      from lesson semantic rerun and reset (starting a new generation from
//      the canonical seed, which may execute authored operations again under
//      fresh execution identity). The design terminology is used exactly.
//   8. Close is terminal: it blocks new operations, cancels and settles
//      active plans, settles saves honestly, retires Docker resources,
//      invalidates documents, stops replay subscriptions and prevents late
//      callbacks from reopening state. Close cannot be resurrected by reset.
//
// Owned scope (and only this):
//   - operation-aware cancel across the five families with B0 restoration,
//     commit-boundary honesty and exactly-once finalization;
//   - generation-scoped reset with the frozen ordering, Docker retirement,
//     cleanup confirmation, old-authority invalidation, canonical reseed
//     and exactly-once generation rotation (plus duplicate, concurrent,
//     close and acquire races);
//   - terminal close with honest settlement and no resurrection;
//   - idempotent replay from the one reused bounded canonical journal and
//     tombstones without second side effects, with generation fencing and
//     deterministic reconstruction;
//   - subscribe-before-snapshot replay delivery with bounded buffering,
//     exactly-once feed, gap detection and fencing (the proven P5 pattern,
//     preserved here for the editor stream).
//
// Explicit non-scope (owned by other tasks, represented here only as
// fail-closed rejections or not at all):
//   - P6.12 IPC, preload, bridge and Monaco wiring (no new channels; all
//     inputs here are identifier-only main-held values; results are
//     renderer-safe by shape);
//   - P6.13 terminal interoperability beyond the ownership, epoch and
//     buffer-facts seams reused here (no command execution, no guest
//     supervision, no scheduler);
//   - P6.15 visual proof (no screenshots, no Electron launch here).
//     No browser automation, no recording, no Unreal, no node-pty.
//
// Purity: this module imports only zod (DTO validation), node:crypto
// (deterministic identity derivation) and relative workspace modules. No
// filesystem, no processes, no containers, no timers, no wall-clock reads,
// no randomness, no browser or presentation machinery. All disk truth
// arrives through the injected adapter handle owned by the P6.7 and P6.10
// executors; all container truth arrives through the injected retirement
// seam; all workspace bytes for reseed arrive through the injected reseed
// seam. All races fence through explicit revalidation of live session
// state plus deterministic injection seams, never through sleeps.

import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  WorkspaceOutcome,
  WorkspaceOwnership,
  WorkspaceRejection,
} from "./protocol.ts";
import type {
  EditorOperationAdmission,
  EditorSession,
} from "./editor-admission.ts";
import {
  admitEditorOperation,
  closeEditorSession,
  openEditorSession,
} from "./editor-admission.ts";
import {
  executeAdmittedFileCreate,
  executeAdmittedFileOpen,
} from "./editor-open-create.ts";
import {
  createReplacePlanner,
  type ReplacePlanner,
} from "./editor-replace-planner.ts";
import {
  createTypePlanner,
  type TypePlanner,
} from "./editor-type-planner.ts";
import {
  createEditorSaveJournal,
  createFileSaveExecutor,
  sanitizeSaveMessage,
  type EditorSaveEvent,
  type EditorSaveJournal,
  type FileSaveExecutor,
} from "./editor-save.ts";
import type { SeedManifest } from "./policy.ts";
import type { EditorCatalog } from "./editor-admission.ts";

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

function sha256HexText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Lifecycle protocol version (matches the workspace protocol). */
export const EDITOR_LIFECYCLE_VERSION = 1;

/** Canonical reset phases in frozen order (design 26.10, P6.1 prefix language). */
export const LIFECYCLE_RESET_PHASES = [
  "REVOKE",
  "SETTLE_SAVE_CANCEL",
  "STOP_REMOVE_CONTAINER",
  "CONFIRM_CLEANUP",
  "DISCARD_RESEED",
  "EXPOSE_NEW_GENERATION",
] as const;
export type LifecycleResetPhase = (typeof LIFECYCLE_RESET_PHASES)[number];

/** Strict identifier-only cancel request (renderer may supply identifiers only). */
export const LifecycleCancelRequestSchema = z.strictObject({
  session_id: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  operation_id: z.string().min(1).max(128),
  request_id: z.string().min(1).max(128),
});
export type LifecycleCancelRequest = z.infer<typeof LifecycleCancelRequestSchema>;

/** Strict identifier-only replay request (renderer may supply identifiers only). */
export const LifecycleReplayRequestSchema = z.strictObject({
  session_id: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  operation_id: z.string().min(1).max(128),
});
export type LifecycleReplayRequest = z.infer<typeof LifecycleReplayRequestSchema>;

/** Strict identifier-only reset request (renderer may supply identifiers only). */
export const LifecycleResetRequestSchema = z.strictObject({
  session_id: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  request_id: z.string().min(1).max(128),
});
export type LifecycleResetRequest = z.infer<typeof LifecycleResetRequestSchema>;

/** Lifecycle outcome per operation (tombstone value, main-held). */
export type LifecycleOutcomeKind = "completed" | "failed" | "cancelled" | "commit_uncertain";

export interface LifecycleTombstone {
  readonly operation_id: string;
  readonly action_type: string;
  readonly kind: LifecycleOutcomeKind;
  readonly request_id: string;
  readonly journal_seq: number | null;
  readonly detail: string;
}

/** Minimal live fence presented with every adapter call (structural, no adapter import). */
export interface LifecycleAuthority {
  readonly lease: {
    readonly kind: "editor_lease";
    readonly leaseId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly workspaceId: string;
    readonly epoch: number;
    readonly operationId: string;
    readonly requestId: string;
  };
  readonly ownership: WorkspaceOwnership;
  readonly liveEpoch: number;
  readonly revokedLeaseIds: readonly string[];
}

/** Minimal open/create/save dependency bundle forwarded to the owning executors. */
export interface LifecycleExecDeps {
  readonly adapter: unknown;
  readonly authority: LifecycleAuthority;
  readonly revalidate?: () => LifecycleAuthority;
  readonly isCancelled?: () => boolean;
}

/** Container retirement seam (main-owned, injected; deterministic in tests). */
export type LifecycleRetireContainer = () => Promise<"confirmed" | "unconfirmed">;

/** Canonical reseed seam (main-owned, injected; rewrites seed bytes, clears staging). */
export type LifecycleReseed = () => Promise<void>;

/** Ownership and epoch observation seams (main-held facts, never renderer input). */
export interface LifecycleWiring {
  readonly getOwnership?: () => WorkspaceOwnership;
  readonly getEpoch?: () => number;
  readonly retireContainer?: LifecycleRetireContainer;
  readonly reseed?: LifecycleReseed;
  readonly confirmCleanup?: () => Promise<"confirmed" | "unconfirmed">;
}

export interface CreateEditorLifecycleOptions {
  readonly catalog: EditorCatalog;
  readonly seedManifest: SeedManifest;
  readonly sessionId: string;
  readonly generation: number;
  readonly reviewed?: boolean;
  readonly journal?: EditorSaveJournal;
  readonly wiring?: LifecycleWiring;
}

export interface LifecycleDescriptor {
  readonly session_id: string;
  readonly generation: number;
  readonly ownership: WorkspaceOwnership;
  readonly epoch: number;
  readonly resetting: boolean;
  readonly closed: boolean;
  readonly hold_reason: string | null;
}

/** Active type execution tracked for cancel, reset and replay fencing. */
interface ActiveTypeEntry {
  readonly operationId: string;
  readonly actionType: string;
  readonly planId: string;
  readonly documentId: string;
  readonly baseText: string;
  readonly baseDigest: string;
  readonly baseBufferRevision: number;
  settled: boolean;
  outcome: LifecycleTombstone | null;
}

/** Active replace execution tracked for cancel, reset and replay fencing. */
interface ActiveReplaceEntry {
  readonly operationId: string;
  readonly actionType: string;
  readonly planId: string;
  readonly documentId: string;
  readonly baseText: string;
  readonly baseDigest: string;
  readonly baseBufferRevision: number;
  settled: boolean;
  outcome: LifecycleTombstone | null;
}

/** Active save execution tracked for commit-boundary settlement. */
interface ActiveSaveEntry {
  readonly operationId: string;
  readonly admission: EditorOperationAdmission;
  promise: Promise<WorkspaceOutcome<unknown>> | null;
  cancelRequested: boolean;
  settled: boolean;
  outcome: LifecycleTombstone | null;
}

export interface EditorLifecycle {
  readonly version: 1;
  getSession(): EditorSession;
  describe(): LifecycleDescriptor;
  getJournal(): EditorSaveJournal;
  getTypePlanner(): TypePlanner;
  getReplacePlanner(): ReplacePlanner;
  getSaveExecutor(): FileSaveExecutor;
  admit(operationId: string, requestId: string): WorkspaceOutcome<EditorOperationAdmission>;
  executeOpen(admission: EditorOperationAdmission, deps: LifecycleExecDeps): Promise<WorkspaceOutcome<unknown>>;
  executeCreate(admission: EditorOperationAdmission, deps: LifecycleExecDeps): Promise<WorkspaceOutcome<unknown>>;
  planType(admission: EditorOperationAdmission): WorkspaceOutcome<{ plan_id: string }>;
  startType(planId: string): WorkspaceOutcome<unknown>;
  advanceType(planId: string, deltaUs: number): WorkspaceOutcome<unknown>;
  completeType(planId: string): WorkspaceOutcome<unknown>;
  cancelType(planId: string): WorkspaceOutcome<unknown>;
  planReplace(admission: EditorOperationAdmission): WorkspaceOutcome<{ plan_id: string }>;
  startReplace(planId: string): WorkspaceOutcome<unknown>;
  advanceReplace(planId: string, stepDelta: number): WorkspaceOutcome<unknown>;
  completeReplace(planId: string): WorkspaceOutcome<unknown>;
  cancelReplace(planId: string): WorkspaceOutcome<unknown>;
  executeSave(admission: EditorOperationAdmission, deps: LifecycleExecDeps): Promise<WorkspaceOutcome<unknown>>;
  cancelOperation(request: unknown): WorkspaceOutcome<LifecycleTombstone>;
  reset(request: unknown): Promise<WorkspaceOutcome<LifecycleDescriptor>>;
  close(request: unknown): Promise<WorkspaceOutcome<null>>;
  replay(request: unknown): WorkspaceOutcome<LifecycleTombstone>;
  snapshot(afterSeq: number): { events: readonly EditorSaveEvent[]; page_end_seq: number; journal_high_seq: number; reset: boolean };
  subscribe(listener: (event: EditorSaveEvent) => void): { unsubscribe: () => void };
  listTombstones(): readonly LifecycleTombstone[];
  getResetPhases(): readonly LifecycleResetPhase[];
  listEvents(afterSeq?: number): readonly EditorSaveEvent[];
  getJournalForGeneration(generation: number): EditorSaveJournal | null;
}

function ownershipRejection(ownership: WorkspaceOwnership): WorkspaceRejection {
  if (ownership === "TERMINAL_OWNED") {
    return { code: "WORKSPACE_BUSY", message: "terminal read-write owns the leaf: no editor lifecycle mutation" };
  }
  if (ownership === "HOLD") {
    return { code: "CLEANUP_UNCONFIRMED", message: "session holds with retained resources: explicit reset or close is required" };
  }
  return { code: "INVALID_TRANSITION", message: `editor lifecycle is barred while ${ownership}` };
}

function deterministicSessionId(seed: string): string {
  return `sess-${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 24)}`;
}

export function createEditorLifecycle(options: CreateEditorLifecycleOptions): EditorLifecycle {
  const wiring = options.wiring ?? {};
  const reviewed = options.reviewed ?? true;
  let sessionId = options.sessionId;
  let generation = options.generation;
  const catalog = options.catalog;
  const seedManifest = options.seedManifest;
  const listeners = new Set<(event: EditorSaveEvent) => void>();
  function notify(event: EditorSaveEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A misbehaving subscriber never breaks the lifecycle.
      }
    }
  }
  // The one reused bounded canonical journal, wrapped so every append —
  // including the save executor's internal started, committed and terminal
  // appends — notifies live replay subscribers exactly once. This is a
  // notifying facade over the single store, never a second replay store.
  function wrapJournal(inner: EditorSaveJournal): EditorSaveJournal {
    return {
      version: 1,
      append: (event) => {
        const outcome = inner.append(event);
        if (outcome.ok) notify(outcome.value);
        return outcome;
      },
      listEvents: (afterSeq) => inner.listEvents(afterSeq),
      snapshot: (afterSeq) => inner.snapshot(afterSeq),
      getTerminal: (operationId) => inner.getTerminal(operationId),
      terminalCount: () => inner.terminalCount(),
      eventCount: () => inner.eventCount(),
      byteCount: () => inner.byteCount(),
      failNextAppendBeforeCommit: () => inner.failNextAppendBeforeCommit(),
      failNextAppendAfterCommit: () => inner.failNextAppendAfterCommit(),
      clearFaults: () => inner.clearFaults(),
    };
  }
  let journal: EditorSaveJournal = wrapJournal(options.journal ?? createEditorSaveJournal());
  const journalsByGeneration = new Map<number, EditorSaveJournal>([[generation, journal]]);
  let sessionOutcome = openEditorSession({ catalog, sessionId, generation, seedManifest, reviewed });
  if (!sessionOutcome.ok) throw new Error(`lifecycle requires a live admission session: ${sessionOutcome.rejection.message}`);
  let session: EditorSession = sessionOutcome.value;
  let typePlanner: TypePlanner = createTypePlanner();
  let replacePlanner: ReplacePlanner = createReplacePlanner();
  let saveExecutor: FileSaveExecutor = createFileSaveExecutor({ journal });
  const tombstones = new Map<string, LifecycleTombstone>();
  const activeTypes = new Map<string, ActiveTypeEntry>();
  const plansById = new Map<string, string>();
  const activeReplaces = new Map<string, ActiveReplaceEntry>();
  const replacePlansById = new Map<string, string>();
  const activeSaves = new Map<string, ActiveSaveEntry>();
  const cancelledSaves = new Set<string>();
  let resetting = false;
  let closed = false;
  let holdReason: string | null = null;
  let epoch = wiring.getEpoch?.() ?? 1;
  let resetPhases: LifecycleResetPhase[] = [];
  let resetPending: Promise<WorkspaceOutcome<LifecycleDescriptor>> | null = null;
  const resetReceipts = new Map<string, WorkspaceOutcome<LifecycleDescriptor>>();
  const admissionsByOperation = new Map<string, EditorOperationAdmission>();

  function liveOwnership(): WorkspaceOwnership {
    if (closed) return "CLOSING";
    if (resetting) return "RESETTING";
    if (holdReason !== null) return "HOLD";
    return wiring.getOwnership?.() ?? "EDITOR_OWNED";
  }

  function liveEpoch(): number {
    return wiring.getEpoch?.() ?? epoch;
  }

  function scopeKey(operationId: string): string {
    return `${sessionId}|${generation}|${operationId}`;
  }

  function appendNotifying(event: Omit<EditorSaveEvent, "seq">): WorkspaceOutcome<EditorSaveEvent> {
    // The journal wrapper notifies live subscribers exactly once per append.
    return journal.append(event);
  }

  function fenceNewWork(): WorkspaceRejection | null {
    if (closed) return { code: "INVALID_TRANSITION", message: "lifecycle is closed: no new work" };
    if (resetting) return { code: "STALE_SESSION", message: "lifecycle is resetting: old generation cannot admit new work" };
    if (holdReason !== null) {
      return { code: "CLEANUP_UNCONFIRMED", message: `lifecycle holds (${holdReason}): explicit reset or close is required` };
    }
    const ownership = liveOwnership();
    if (ownership !== "EDITOR_OWNED") return ownershipRejection(ownership);
    return null;
  }

  function tombstoneFor(operationId: string): LifecycleTombstone | null {
    return tombstones.get(scopeKey(operationId)) ?? null;
  }

  function recordTombstone(entry: LifecycleTombstone, operationId: string): void {
    tombstones.set(scopeKey(operationId), deepFreeze({ ...entry }));
  }

  function actionOf(admission: EditorOperationAdmission): string {
    return (admission.record as { action_type?: unknown }).action_type as string;
  }

  function baseFactsFor(documentId: string): { revision: number; digest: string | null; path: string } | null {
    const resolved = session.registry.resolveDocument(documentId);
    if (!resolved.ok) return null;
    return { revision: resolved.value.base_disk_revision, digest: resolved.value.base_digest, path: resolved.value.portable_path };
  }

  function startedEventFor(
    admission: EditorOperationAdmission,
    extra: Partial<EditorSaveEvent> = {},
  ): Omit<EditorSaveEvent, "seq"> {
    const facts = baseFactsFor(admission.document.document_id);
    return {
      kind: "editor.operation.started",
      session_id: sessionId,
      generation,
      operation_id: admission.record.operation_id,
      attempt_id: admission.record.attempt_id,
      document_id: admission.document.document_id,
      portable_path: admission.record.portable_path,
      lesson_compiled_digest: admission.record.lesson_compiled_digest,
      base_disk_revision: facts?.revision ?? 0,
      base_digest: facts?.digest ?? null,
      new_disk_revision: null,
      new_digest: null,
      before_digest: facts?.digest ?? null,
      after_digest: null,
      observed_digest: null,
      file_identity: null,
      byte_length: null,
      dirty: null,
      disk_effect: null,
      code: null,
      message: null,
      ...extra,
    };
  }

  function completedEventFor(
    admission: EditorOperationAdmission,
    beforeDigest: string | null,
    afterDigest: string | null,
    afterBytes: number | null,
    dirty: boolean,
  ): Omit<EditorSaveEvent, "seq"> {
    const facts = baseFactsFor(admission.document.document_id);
    return {
      kind: "editor.operation.completed",
      session_id: sessionId,
      generation,
      operation_id: admission.record.operation_id,
      attempt_id: admission.record.attempt_id,
      document_id: admission.document.document_id,
      portable_path: admission.record.portable_path,
      lesson_compiled_digest: admission.record.lesson_compiled_digest,
      base_disk_revision: facts?.revision ?? 0,
      base_digest: facts?.digest ?? null,
      new_disk_revision: facts?.revision ?? 0,
      new_digest: facts?.digest ?? null,
      before_digest: beforeDigest,
      after_digest: afterDigest,
      observed_digest: null,
      file_identity: null,
      byte_length: afterBytes,
      dirty,
      disk_effect: "none",
      code: "OK",
      message: "lifecycle operation completed without disk mutation",
    };
  }

  function cancelledEventFor(
    admission: EditorOperationAdmission,
    beforeDigest: string | null,
  ): Omit<EditorSaveEvent, "seq"> {
    const facts = baseFactsFor(admission.document.document_id);
    return {
      kind: "editor.operation.cancelled",
      session_id: sessionId,
      generation,
      operation_id: admission.record.operation_id,
      attempt_id: admission.record.attempt_id,
      document_id: admission.document.document_id,
      portable_path: admission.record.portable_path,
      lesson_compiled_digest: admission.record.lesson_compiled_digest,
      base_disk_revision: facts?.revision ?? 0,
      base_digest: facts?.digest ?? null,
      new_disk_revision: null,
      new_digest: null,
      before_digest: beforeDigest,
      after_digest: beforeDigest,
      observed_digest: null,
      file_identity: null,
      byte_length: null,
      dirty: null,
      disk_effect: "none",
      code: "CANCELLED",
      message: "lifecycle operation cancelled before commit: working buffer restored with destination unchanged",
    };
  }

  function failedEventFor(
    admission: EditorOperationAdmission,
    code: string,
    message: string,
  ): Omit<EditorSaveEvent, "seq"> {
    const facts = baseFactsFor(admission.document.document_id);
    return {
      kind: "editor.operation.failed",
      session_id: sessionId,
      generation,
      operation_id: admission.record.operation_id,
      attempt_id: admission.record.attempt_id,
      document_id: admission.document.document_id,
      portable_path: admission.record.portable_path,
      lesson_compiled_digest: admission.record.lesson_compiled_digest,
      base_disk_revision: facts?.revision ?? 0,
      base_digest: facts?.digest ?? null,
      new_disk_revision: null,
      new_digest: null,
      before_digest: facts?.digest ?? null,
      after_digest: null,
      observed_digest: null,
      file_identity: null,
      byte_length: null,
      dirty: null,
      disk_effect: code === "COMMIT_UNCERTAIN" ? "unknown" : "none",
      code,
      message: sanitizeSaveMessage(message),
    };
  }

  function finishTypeInstall(planId: string): WorkspaceOutcome<unknown> {
    const operationId = plansById.get(planId);
    if (operationId === undefined) return rejected("INVALID_REQUEST", "unknown type plan");
    const active = activeTypes.get(operationId);
    if (active === undefined) return rejected("INVALID_REQUEST", "unknown type operation");
    if (active.settled) {
      const tomb = tombstoneFor(operationId);
      if (tomb !== null) return { ok: true, value: deepFreeze({ ...tomb, replay: true }) };
      return rejected("INVALID_REQUEST", "type operation already reached its final state");
    }
    const plan = typePlanner.getPlan(planId);
    if (plan === null) return rejected("INVALID_REQUEST", "unknown type plan");
    const stored = session.registry.setBufferContent(active.documentId, plan.expected_text);
    if (!stored.ok) return stored as { ok: false; rejection: WorkspaceRejection };
    active.settled = true;
    return { ok: true, value: deepFreeze({ plan_id: planId, installed: true }) };
  }

  function finishReplaceInstall(planId: string): WorkspaceOutcome<unknown> {
    const operationId = replacePlansById.get(planId);
    if (operationId === undefined) return rejected("INVALID_REQUEST", "unknown replace plan");
    const active = activeReplaces.get(operationId);
    if (active === undefined) return rejected("INVALID_REQUEST", "unknown replace operation");
    if (active.settled) {
      const tomb = tombstoneFor(operationId);
      if (tomb !== null) return { ok: true, value: deepFreeze({ ...tomb, replay: true }) };
      return rejected("INVALID_REQUEST", "replace operation already reached its final state");
    }
    const plan = replacePlanner.getPlan(planId);
    if (plan === null) return rejected("INVALID_REQUEST", "unknown replace plan");
    const stored = session.registry.setBufferContent(active.documentId, plan.expected_text);
    if (!stored.ok) return stored as { ok: false; rejection: WorkspaceRejection };
    active.settled = true;
    return { ok: true, value: deepFreeze({ plan_id: planId, installed: true }) };
  }

  const lifecycle: EditorLifecycle = {
    version: 1,

    getSession(): EditorSession {
      return session;
    },

    describe(): LifecycleDescriptor {
      return deepFreeze({
        session_id: sessionId,
        generation,
        ownership: liveOwnership(),
        epoch: liveEpoch(),
        resetting,
        closed,
        hold_reason: holdReason,
      });
    },

    getJournal(): EditorSaveJournal {
      return journal;
    },

    getTypePlanner(): TypePlanner {
      return typePlanner;
    },

    getReplacePlanner(): ReplacePlanner {
      return replacePlanner;
    },

    getSaveExecutor(): FileSaveExecutor {
      return saveExecutor;
    },

    admit(operationId: string, requestId: string): WorkspaceOutcome<EditorOperationAdmission> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      // Admission order and tombstones are owned by the P6.6 session; the
      // lifecycle fences generation, ownership and hold state above, then
      // records the admission for later type and replace completion.
      const outcome = admitEditorOperation(session, {
        session_id: sessionId,
        generation,
        operation_id: operationId,
        request_id: requestId,
      });
      if (outcome.ok) admissionsByOperation.set(scopeKey(operationId), outcome.value);
      return outcome;
    },

    async executeOpen(admission: EditorOperationAdmission, deps: LifecycleExecDeps): Promise<WorkspaceOutcome<unknown>> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      if (actionOf(admission) !== "file_open") {
        return rejected("INVALID_REQUEST", "open lifecycle runs admitted open operations only");
      }
      const existing = tombstoneFor(admission.record.operation_id);
      if (existing !== null) return replayConverged(existing);
      const started = appendNotifying(startedEventFor(admission));
      if (!started.ok) {
        if (started.rejection.code === "COMMIT_UNCERTAIN") return failedWith(admission, "COMMIT_UNCERTAIN", started.rejection.message);
        return failedWith(admission, "SAVE_FAILED", "journal append failed before open: no registration");
      }
      const outcome = await executeAdmittedFileOpen(
        session,
        admission,
        deps as unknown as Parameters<typeof executeAdmittedFileOpen>[2],
      );
      if (!outcome.ok) {
        // Pre-registration failures preserve buffers and disk; journal one failure.
        if (isFencingCode(outcome.rejection.code)) {
          appendNotifying(failedEventFor(admission, outcome.rejection.code, outcome.rejection.message));
          return outcome as { ok: false; rejection: WorkspaceRejection };
        }
        return failedWith(admission, outcome.rejection.code, outcome.rejection.message);
      }
      const completed = appendNotifying(
        completedEventFor(admission, outcome.value.disk_digest, outcome.value.disk_digest, null, false),
      );
      void completed;
      const tomb: LifecycleTombstone = {
        operation_id: admission.record.operation_id,
        action_type: "file_open",
        kind: "completed",
        request_id: admission.record.request_id,
        journal_seq: completed.ok ? completed.value.seq : null,
        detail: "open bound exact committed bytes with zero disk mutation",
      };
      recordTombstone(tomb, admission.record.operation_id);
      return { ok: true, value: deepFreeze({ ...outcome.value, lifecycle: tomb }) };
    },

    async executeCreate(admission: EditorOperationAdmission, deps: LifecycleExecDeps): Promise<WorkspaceOutcome<unknown>> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      if (actionOf(admission) !== "file_create") {
        return rejected("INVALID_REQUEST", "create lifecycle runs admitted create operations only");
      }
      const existing = tombstoneFor(admission.record.operation_id);
      if (existing !== null) return replayConverged(existing);
      const started = appendNotifying(startedEventFor(admission));
      if (!started.ok) {
        if (started.rejection.code === "COMMIT_UNCERTAIN") return failedWith(admission, "COMMIT_UNCERTAIN", started.rejection.message);
        return failedWith(admission, "SAVE_FAILED", "journal append failed before create: no staging");
      }
      const outcome = await executeAdmittedFileCreate(
        session,
        admission,
        deps as unknown as Parameters<typeof executeAdmittedFileCreate>[2],
      );
      if (!outcome.ok) {
        if (isFencingCode(outcome.rejection.code)) {
          appendNotifying(failedEventFor(admission, outcome.rejection.code, outcome.rejection.message));
          return outcome as { ok: false; rejection: WorkspaceRejection };
        }
        return failedWith(admission, outcome.rejection.code, outcome.rejection.message);
      }
      const stagedBytes = Buffer.byteLength(outcome.value.content, "utf8");
      const completed = appendNotifying(completedEventFor(admission, null, sha256HexText(outcome.value.content), stagedBytes, true));
      void completed;
      const tomb: LifecycleTombstone = {
        operation_id: admission.record.operation_id,
        action_type: "file_create",
        kind: "completed",
        request_id: admission.record.request_id,
        journal_seq: completed.ok ? completed.value.seq : null,
        detail: "create staged pending bytes with zero disk publication",
      };
      recordTombstone(tomb, admission.record.operation_id);
      return { ok: true, value: deepFreeze({ ...outcome.value, lifecycle: tomb }) };
    },

    planType(admission: EditorOperationAdmission): WorkspaceOutcome<{ plan_id: string }> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      if (actionOf(admission) !== "type_code") {
        return rejected("INVALID_REQUEST", "type lifecycle runs admitted type operations only");
      }
      const existing = tombstoneFor(admission.record.operation_id);
      if (existing !== null) {
        if (existing.kind === "completed") {
          const planId = plansByIdForOperation(admission.record.operation_id);
          if (planId !== null) return { ok: true, value: deepFreeze({ plan_id: planId }) };
        }
        return replayConvergedOutcome(existing);
      }
      const planned = typePlanner.planOperation(session, admission);
      if (!planned.ok) {
        appendNotifying(failedEventFor(admission, planned.rejection.code, planned.rejection.message));
        return planned as { ok: false; rejection: WorkspaceRejection };
      }
      const plan = planned.value;
      const buffered = session.registry.getBufferContent(plan.document_id);
      const baseText = buffered.ok ? buffered.value : "";
      activeTypes.set(admission.record.operation_id, {
        operationId: admission.record.operation_id,
        actionType: "type_code",
        planId: plan.plan_id,
        documentId: plan.document_id,
        baseText,
        baseDigest: plan.base_digest ?? sha256HexText(baseText),
        baseBufferRevision: plan.base_buffer_revision,
        settled: false,
        outcome: null,
      });
      plansById.set(plan.plan_id, admission.record.operation_id);
      appendNotifying(startedEventFor(admission));
      return { ok: true, value: deepFreeze({ plan_id: plan.plan_id }) };
    },

    startType(planId: string): WorkspaceOutcome<unknown> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      return typePlanner.startPlan(session, planId) as WorkspaceOutcome<unknown>;
    },

    advanceType(planId: string, deltaUs: number): WorkspaceOutcome<unknown> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const advanced = typePlanner.advancePlan(session, planId, deltaUs);
      if (!advanced.ok) return advanced as { ok: false; rejection: WorkspaceRejection };
      if (advanced.value.completed) {
        return finishTypeInstall(planId);
      }
      return advanced as WorkspaceOutcome<unknown>;
    },

    completeType(planId: string): WorkspaceOutcome<unknown> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const operationId = plansById.get(planId);
      if (operationId === undefined) return rejected("INVALID_REQUEST", "unknown type plan");
      const existing = tombstoneFor(operationId);
      if (existing !== null) return replayConverged(existing);
      const active = activeTypes.get(operationId);
      if (active === undefined) return rejected("INVALID_REQUEST", "unknown type operation");
      const plan = typePlanner.getPlan(planId);
      if (plan === null) return rejected("INVALID_REQUEST", "unknown type plan");
      // Drive the manual clock to completion deterministically: advance by
      // the remaining duration plus one microsecond so tests never sleep.
      const status = typePlanner.getStatus(planId);
      if (status === "planned") {
        const started = typePlanner.startPlan(session, planId);
        if (!started.ok) {
          appendNotifyingForPlanId(planId, operationId, started.rejection);
          return started as { ok: false; rejection: WorkspaceRejection };
        }
        if (typePlanner.getStatus(planId) === "completed") {
          return installTypeCompletion(planId, operationId, active);
        }
      }
      if (typePlanner.getStatus(planId) === "running") {
        const schedule = typePlanner.getSchedule(planId);
        const remaining = schedule !== null ? schedule.total_duration_us + 1 : 1;
        const advanced = typePlanner.advancePlan(session, planId, remaining);
        if (!advanced.ok) {
          appendNotifyingForPlanId(planId, operationId, advanced.rejection);
          return advanced as { ok: false; rejection: WorkspaceRejection };
        }
        return installTypeCompletion(planId, operationId, active);
      }
      if (typePlanner.getStatus(planId) === "completed") {
        return installTypeCompletion(planId, operationId, active);
      }
      return rejected("INVALID_REQUEST", "type plan is not completable in its current state");
    },

    cancelType(planId: string): WorkspaceOutcome<unknown> {
      const operationId = plansById.get(planId);
      if (operationId === undefined) {
        if (closed || session.registry.retired) return rejected("STALE_SESSION", "editor session was reset or closed: unknown type plan cannot cancel");
        return rejected("INVALID_REQUEST", "unknown type plan");
      }
      return cancelTypeOperation(operationId, planId);
    },

    planReplace(admission: EditorOperationAdmission): WorkspaceOutcome<{ plan_id: string }> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      if (actionOf(admission) !== "replace_code") {
        return rejected("INVALID_REQUEST", "replace lifecycle runs admitted replace operations only");
      }
      const existing = tombstoneFor(admission.record.operation_id);
      if (existing !== null) {
        if (existing.kind === "completed") {
          const planId = replacePlansByIdForOperation(admission.record.operation_id);
          if (planId !== null) return { ok: true, value: deepFreeze({ plan_id: planId }) };
        }
        return replayConvergedOutcome(existing);
      }
      const planned = replacePlanner.planOperation(session, admission);
      if (!planned.ok) {
        appendNotifying(failedEventFor(admission, planned.rejection.code, planned.rejection.message));
        return planned as { ok: false; rejection: WorkspaceRejection };
      }
      const plan = planned.value;
      const buffered = session.registry.getBufferContent(plan.document_id);
      const baseText = buffered.ok ? buffered.value : "";
      activeReplaces.set(admission.record.operation_id, {
        operationId: admission.record.operation_id,
        actionType: "replace_code",
        planId: plan.plan_id,
        documentId: plan.document_id,
        baseText,
        baseDigest: plan.base_digest,
        baseBufferRevision: plan.base_buffer_revision,
        settled: false,
        outcome: null,
      });
      replacePlansById.set(plan.plan_id, admission.record.operation_id);
      appendNotifying(startedEventFor(admission));
      return { ok: true, value: deepFreeze({ plan_id: plan.plan_id }) };
    },

    startReplace(planId: string): WorkspaceOutcome<unknown> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      return replacePlanner.startPlan(session, planId) as WorkspaceOutcome<unknown>;
    },

    advanceReplace(planId: string, stepDelta: number): WorkspaceOutcome<unknown> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const advanced = replacePlanner.advancePlan(session, planId, stepDelta);
      if (!advanced.ok) return advanced as { ok: false; rejection: WorkspaceRejection };
      if (advanced.value.completed) {
        return finishReplaceInstall(planId);
      }
      return advanced as WorkspaceOutcome<unknown>;
    },

    completeReplace(planId: string): WorkspaceOutcome<unknown> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      const operationId = replacePlansById.get(planId);
      if (operationId === undefined) return rejected("INVALID_REQUEST", "unknown replace plan");
      const existing = tombstoneFor(operationId);
      if (existing !== null) return replayConverged(existing);
      const active = activeReplaces.get(operationId);
      if (active === undefined) return rejected("INVALID_REQUEST", "unknown replace operation");
      const status = replacePlanner.getStatus(planId);
      if (status === "planned") {
        const started = replacePlanner.startPlan(session, planId);
        if (!started.ok) {
          appendNotifyingForReplacePlanId(planId, operationId, started.rejection);
          return started as { ok: false; rejection: WorkspaceRejection };
        }
        if (replacePlanner.getStatus(planId) === "completed") {
          return installReplaceCompletion(planId, operationId, active);
        }
      }
      if (replacePlanner.getStatus(planId) === "running") {
        const visual = replacePlanner.getVisualPlan(planId);
        const remaining = visual !== null ? visual.step_count + 1 : 1;
        const advanced = replacePlanner.advancePlan(session, planId, remaining);
        if (!advanced.ok) {
          appendNotifyingForReplacePlanId(planId, operationId, advanced.rejection);
          return advanced as { ok: false; rejection: WorkspaceRejection };
        }
        return installReplaceCompletion(planId, operationId, active);
      }
      if (replacePlanner.getStatus(planId) === "completed") {
        return installReplaceCompletion(planId, operationId, active);
      }
      return rejected("INVALID_REQUEST", "replace plan is not completable in its current state");
    },

    cancelReplace(planId: string): WorkspaceOutcome<unknown> {
      const operationId = replacePlansById.get(planId);
      if (operationId === undefined) {
        if (closed || session.registry.retired) return rejected("STALE_SESSION", "editor session was reset or closed: unknown replace plan cannot cancel");
        return rejected("INVALID_REQUEST", "unknown replace plan");
      }
      return cancelReplaceOperation(operationId, planId);
    },

    async executeSave(admission: EditorOperationAdmission, deps: LifecycleExecDeps): Promise<WorkspaceOutcome<unknown>> {
      const fenced = fenceNewWork();
      if (fenced !== null) return { ok: false, rejection: fenced };
      if (actionOf(admission) !== "file_save") {
        return rejected("INVALID_REQUEST", "save lifecycle runs admitted save operations only");
      }
      const existing = tombstoneFor(admission.record.operation_id);
      if (existing !== null) {
        // Idempotent replay without a second commit: the save executor owns
        // the exactly-once commit, and the tombstone converges duplicates.
        return replayConverged(existing);
      }
      let entry = activeSaves.get(admission.record.operation_id);
      if (entry !== undefined && entry.promise !== null) {
        return rejected("WORKSPACE_BUSY", "another save is already active: editor work serializes deterministically");
      }
      entry = { operationId: admission.record.operation_id, admission, promise: null, cancelRequested: cancelledSaves.has(admission.record.operation_id), settled: false, outcome: null };
      activeSaves.set(admission.record.operation_id, entry);
      const liveEntry = entry;
      const adapted: Record<string, unknown> = {
        adapter: deps.adapter,
        authority: deps.authority,
      };
      if (deps.revalidate !== undefined) adapted["revalidate"] = deps.revalidate;
      const callerCancelled = deps.isCancelled;
      const cancelRequestedNow = (): boolean =>
        liveEntry.cancelRequested || cancelledSaves.has(admission.record.operation_id) || callerCancelled?.() === true;
      adapted["isCancelled"] = cancelRequestedNow;
      const pendingSave = saveExecutor.execute(
        session,
        admission,
        adapted as unknown as Parameters<FileSaveExecutor["execute"]>[2],
      );
      liveEntry.promise = pendingSave as unknown as Promise<WorkspaceOutcome<unknown>>;
      const outcome = await pendingSave;
      liveEntry.settled = true;
      if (outcome.ok) {
        const tomb: LifecycleTombstone = {
          operation_id: admission.record.operation_id,
          action_type: "file_save",
          kind: "completed",
          request_id: admission.record.request_id,
          journal_seq: outcome.value.journal_seq,
          detail: "save committed exact buffer bytes with byte verification",
        };
        recordTombstone(tomb, admission.record.operation_id);

        activeSaves.delete(admission.record.operation_id);
        return { ok: true, value: deepFreeze({ ...outcome.value, lifecycle: tomb }) };
      }
      const code = outcome.rejection.code;
      if (code === "COMMIT_UNCERTAIN") {
        holdReason = `commit-uncertain save ${admission.record.operation_id}`;
        const tomb: LifecycleTombstone = {
          operation_id: admission.record.operation_id,
          action_type: "file_save",
          kind: "commit_uncertain",
          request_id: admission.record.request_id,
          journal_seq: saveExecutor.getTerminal(admission.record.operation_id)?.seq ?? null,
          detail: "save outcome uncertain after commit: reset is required, never auto-retry",
        };
        recordTombstone(tomb, admission.record.operation_id);

        activeSaves.delete(admission.record.operation_id);
        return outcome as { ok: false; rejection: WorkspaceRejection };
      }
      if (code === "WORKSPACE_REVOKED" && cancelRequestedNow()) {
        const tomb: LifecycleTombstone = {
          operation_id: admission.record.operation_id,
          action_type: "file_save",
          kind: "cancelled",
          request_id: admission.record.request_id,
          journal_seq: saveExecutor.getTerminal(admission.record.operation_id)?.seq ?? null,
          detail: "save cancelled before commit: staging discarded with destination unchanged",
        };
        recordTombstone(tomb, admission.record.operation_id);

        activeSaves.delete(admission.record.operation_id);
        return outcome as { ok: false; rejection: WorkspaceRejection };
      }
      const tomb: LifecycleTombstone = {
        operation_id: admission.record.operation_id,
        action_type: "file_save",
        kind: "failed",
        request_id: admission.record.request_id,
        journal_seq: saveExecutor.getTerminal(admission.record.operation_id)?.seq ?? null,
        detail: `save failed before commit (${code}): destination unchanged`,
      };
      recordTombstone(tomb, admission.record.operation_id);

      activeSaves.delete(admission.record.operation_id);
      return outcome as { ok: false; rejection: WorkspaceRejection };
    },

    cancelOperation(request: unknown): WorkspaceOutcome<LifecycleTombstone> {
      const parsed = LifecycleCancelRequestSchema.safeParse(request);
      if (!parsed.success) {
        return rejected("INVALID_REQUEST", `lifecycle cancel failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const { session_id, generation: generationValue, operation_id } = parsed.data;
      if (session_id !== sessionId) return rejected("WRONG_OWNER", "lifecycle cancel names a foreign session");
      if (generationValue !== generation) return rejected("STALE_SESSION", "lifecycle cancel carries a stale session generation");
      if (session.registry.retired || closed) return rejected("STALE_SESSION", "editor session was reset or closed: old operations cannot cancel");
      const existing = tombstoneFor(operation_id);
      if (existing !== null) {
        // Duplicate cancel is deterministic and exactly-once: converge on
        // the first terminal outcome with no second rollback or journal.
        // The single exception is cancel after a type or replace completion,
        // which reports already-final without undo (the P6.8/P6.9 rule);
        // completed saves converge as completed (commit-boundary honesty).
        if (existing.kind === "completed" && (existing.action_type === "type_code" || existing.action_type === "replace_code")) {
          return rejected("INVALID_REQUEST", "lifecycle plan already completed: completion is already final and never reverts");
        }
        return { ok: true, value: deepFreeze({ ...existing }) };
      }
      // Route by live planner state first (planned or running type/replace),
      // then by active save, without naming foreign families generically:
      // the admitted action type decides the exact effect below.
      const typeOperation = plansByIdOperationFor(operation_id, activeTypes, plansById);
      if (typeOperation !== null) {
        const cancelled = cancelTypeOperation(operation_id, typeOperation);
        if (!cancelled.ok) return cancelled as { ok: false; rejection: WorkspaceRejection };
        const tomb = tombstoneFor(operation_id);
        if (tomb !== null) return { ok: true, value: deepFreeze({ ...tomb }) };
        return rejected("INVALID_REQUEST", "type cancel did not finalize exactly once");
      }
      const replaceOperation = plansByIdOperationFor(operation_id, activeReplaces, replacePlansById);
      if (replaceOperation !== null) {
        const cancelled = cancelReplaceOperation(operation_id, replaceOperation);
        if (!cancelled.ok) return cancelled as { ok: false; rejection: WorkspaceRejection };
        const tomb = tombstoneFor(operation_id);
        if (tomb !== null) return { ok: true, value: deepFreeze({ ...tomb }) };
        return rejected("INVALID_REQUEST", "replace cancel did not finalize exactly once");
      }
      const saveEntry = activeSaves.get(operation_id);
      if (saveEntry !== undefined) {
        saveEntry.cancelRequested = true;
        cancelledSaves.add(operation_id);
        // Save cancellation settles through the executor's commit boundary
        // on its next await; the tombstone lands there exactly once. Report
        // the request as accepted without inventing the outcome here.
        const pending: LifecycleTombstone = {
          operation_id,
          action_type: "file_save",
          kind: "cancelled",
          request_id: parsed.data.request_id,
          journal_seq: null,
          detail: "save cancel requested before commit: settlement follows the commit boundary",
        };
        return { ok: true, value: deepFreeze({ ...pending }) };
      }
      return rejected("INVALID_REQUEST", "unknown lifecycle operation: only live planned, running or saving operations cancel");
    },

    async reset(request: unknown): Promise<WorkspaceOutcome<LifecycleDescriptor>> {
      const parsed = LifecycleResetRequestSchema.safeParse(request);
      if (!parsed.success) {
        return rejected("INVALID_REQUEST", `lifecycle reset failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const requestId = parsed.data.request_id;
      const cached = resetReceipts.get(requestIdKey(requestId, sessionId, generation));
      if (cached !== undefined) {
        if (resetPending !== null) return resetPending.then(() => cached);
        return cached;
      }
      if (resetPending !== null) return resetPending;
      if (closed) return rejected("INVALID_TRANSITION", "lifecycle is closed: reset cannot resurrect a closed workspace");
      if (resetting) return rejected("INVALID_TRANSITION", "lifecycle reset is already latched");
      if (parsed.data.session_id !== sessionId || parsed.data.generation !== generation) {
        return rejected("STALE_SESSION", "lifecycle reset carries a stale session identity");
      }
      // Latch RESETTING synchronously: no new editor or terminal ownership
      // acquisition may slip through after this point.
      resetting = true;
      resetPhases = ["REVOKE"];
      const latchedSession = sessionId;
      const latchedGeneration = generation;
      const pending: Promise<WorkspaceOutcome<LifecycleDescriptor>> = (async () => {
        try {
          // Cancel and settle active editor operations with B0 restoration.
          resetPhases = ["REVOKE", "SETTLE_SAVE_CANCEL"];
          for (const [operationId, active] of [...activeTypes]) {
            if (!active.settled) {
              cancelTypeOperationClosed(active.operationId, active.planId, true);
            }
          }
          for (const [operationId, active] of [...activeReplaces]) {
            if (!active.settled) {
              cancelReplaceOperationClosed(active.operationId, active.planId, true);
            }
          }
          for (const [, entry] of [...activeSaves]) {
            entry.cancelRequested = true;
            cancelledSaves.add(entry.operationId);
          }
          // Settle saves honestly: await active save promises settled
          // through the commit boundary on the old generation.
          for (const [, entry] of [...activeSaves]) {
            try {
              if (entry.promise !== null) await entry.promise;
            } catch {
              // Settlement is already recorded in tombstones; never throw.
            }
          }
          // Retire the container epoch and confirm daemon absence before
          // any new generation is exposed.
          resetPhases = ["REVOKE", "SETTLE_SAVE_CANCEL", "STOP_REMOVE_CONTAINER"];
          const retire = wiring.retireContainer ?? (async () => "confirmed" as const);
          const retired = await retire();
          if (retired !== "confirmed") {
            resetPhases = ["REVOKE", "SETTLE_SAVE_CANCEL", "STOP_REMOVE_CONTAINER"];
            holdReason = "container cleanup unconfirmed during reset";
            resetting = false;
            return rejected("CLEANUP_UNCONFIRMED", "reset retirement is unconfirmed: resources retained, session holds");
          }
          const confirm = wiring.confirmCleanup ?? (async () => "confirmed" as const);
          const cleanup = await confirm();
          if (cleanup !== "confirmed") {
            resetPhases = ["REVOKE", "SETTLE_SAVE_CANCEL", "STOP_REMOVE_CONTAINER"];
            holdReason = "workspace cleanup unconfirmed during reset";
            resetting = false;
            return rejected("CLEANUP_UNCONFIRMED", "reset cleanup is unconfirmed: resources retained, session holds");
          }
          // Invalidate old documents, plans and tombstones as designed.
          resetPhases = ["REVOKE", "SETTLE_SAVE_CANCEL", "STOP_REMOVE_CONTAINER", "CONFIRM_CLEANUP", "DISCARD_RESEED"];
          const reseed = wiring.reseed ?? (async () => {});
          try {
            await reseed();
          } catch (error) {
            holdReason = `workspace reseed failed during reset: ${error instanceof Error ? error.message : String(error)}`;
            resetting = false;
            return rejected("SAVE_FAILED", "reset reseed failed: no new writable generation until reset is trustworthy");
          }
          const nextGeneration = latchedGeneration + 1;
          const nextSessionId = deterministicSessionId(`${latchedSession}|${nextGeneration}|${requestId}`);
          try {
            closeEditorSession(session);
          } catch {
            // Retirement is fail-closed and idempotent.
          }
          typePlanner.invalidateAll();
          replacePlanner.invalidateAll();
          saveExecutor.invalidateAll();
          for (const listener of [...listeners]) {
            void listener;
          }
          listeners.clear();
          activeTypes.clear();
          plansById.clear();
          activeReplaces.clear();
          replacePlansById.clear();
          activeSaves.clear();
          cancelledSaves.clear();
          tombstones.clear();
          admissionsByOperation.clear();
          const opened = openEditorSession({ catalog, sessionId: nextSessionId, generation: nextGeneration, seedManifest, reviewed });
          if (!opened.ok) {
            holdReason = "reseeded session could not open";
            resetting = false;
            return opened as { ok: false; rejection: WorkspaceRejection };
          }
          session = opened.value;
          sessionId = nextSessionId;
          generation = nextGeneration;
          epoch = (wiring.getEpoch?.() ?? epoch) + 1;
          journal = wrapJournal(createEditorSaveJournal());
          journalsByGeneration.set(generation, journal);
          typePlanner = createTypePlanner();
          replacePlanner = createReplacePlanner();
          saveExecutor = createFileSaveExecutor({ journal });
          holdReason = null;
          resetting = false;
          resetPhases = [...LIFECYCLE_RESET_PHASES];
          const descriptor: LifecycleDescriptor = deepFreeze({
            session_id: sessionId,
            generation,
            ownership: liveOwnership(),
            epoch: liveEpoch(),
            resetting: false,
            closed: false,
            hold_reason: null,
          });
          const response: WorkspaceOutcome<LifecycleDescriptor> = { ok: true, value: descriptor };
          resetReceipts.set(requestIdKey(requestId, latchedSession, latchedGeneration), response);
          void latchedSession;
          return response;
        } finally {
          if (resetting) {
            // Fail-closed: any throw above holds without exposing a writer.
            resetting = false;
          }
          resetPending = null;
        }
      })();
      resetPending = pending;
      return pending;
    },

    async close(request: unknown): Promise<WorkspaceOutcome<null>> {
      const parsed = LifecycleResetRequestSchema.safeParse(request);
      if (!parsed.success) {
        return rejected("INVALID_REQUEST", `lifecycle close failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      if (parsed.data.session_id !== sessionId || parsed.data.generation !== generation) {
        return rejected("STALE_SESSION", "lifecycle close carries a stale session identity");
      }
      if (closed) return { ok: true, value: null };
      if (resetting) return rejected("INVALID_TRANSITION", "lifecycle reset is latched: close waits for its settlement");
      resetting = true;
      try {
        for (const [, active] of [...activeTypes]) {
          if (!active.settled) cancelTypeOperationClosed(active.operationId, active.planId, true);
        }
        for (const [, active] of [...activeReplaces]) {
          if (!active.settled) cancelReplaceOperationClosed(active.operationId, active.planId, true);
        }
        for (const [, entry] of [...activeSaves]) {
          entry.cancelRequested = true;
          cancelledSaves.add(entry.operationId);
        }
        for (const [, entry] of [...activeSaves]) {
          try {
            if (entry.promise !== null) await entry.promise;
          } catch {
            // Settlement recorded; never throw.
          }
        }
        const retire = wiring.retireContainer ?? (async () => "confirmed" as const);
        const retired = await retire();
        if (retired !== "confirmed") {
          holdReason = "container cleanup unconfirmed during close";
          resetting = false;
          return rejected("CLEANUP_UNCONFIRMED", "close retirement is unconfirmed: resources retained");
        }
        try {
          closeEditorSession(session);
        } catch {
          // Idempotent.
        }
        typePlanner.invalidateAll();
        replacePlanner.invalidateAll();
        saveExecutor.invalidateAll();
        listeners.clear();
        activeTypes.clear();
        plansById.clear();
        activeReplaces.clear();
        replacePlansById.clear();
        activeSaves.clear();
        closed = true;
        resetting = false;
        return { ok: true, value: null };
      } finally {
        if (!closed) resetting = false;
      }
    },

    replay(request: unknown): WorkspaceOutcome<LifecycleTombstone> {
      const parsed = LifecycleReplayRequestSchema.safeParse(request);
      if (!parsed.success) {
        return rejected("INVALID_REQUEST", `lifecycle replay failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      if (parsed.data.session_id !== sessionId || parsed.data.generation !== generation) {
        return rejected("STALE_SESSION", "lifecycle replay carries a stale session generation: old-generation events never interpret as current operations");
      }
      if (closed || session.registry.retired) {
        return rejected("STALE_SESSION", "editor session was reset or closed: replay cannot mutate");
      }
      const tomb = tombstoneFor(parsed.data.operation_id);
      if (tomb === null) return rejected("INVALID_REQUEST", "unknown lifecycle operation: replay converges only on recorded outcomes");
      // Replay never executes side effects again: converge on the trusted
      // terminal outcome without publication, buffer mutation or retry.
      return { ok: true, value: deepFreeze({ ...tomb }) };
    },

    snapshot(afterSeq: number): { events: readonly EditorSaveEvent[]; page_end_seq: number; journal_high_seq: number; reset: boolean } {
      if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new TypeError("after_seq must be a non-negative integer");
      return journal.snapshot(afterSeq);
    },

    subscribe(listener: (event: EditorSaveEvent) => void): { unsubscribe: () => void } {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },

    listTombstones(): readonly LifecycleTombstone[] {
      return Object.freeze([...tombstones.values()].map((t) => deepFreeze({ ...t })));
    },

    getResetPhases(): readonly LifecycleResetPhase[] {
      return Object.freeze([...resetPhases]);
    },

    listEvents(afterSeq = 0): readonly EditorSaveEvent[] {
      return journal.listEvents(afterSeq);
    },

    getJournalForGeneration(generationValue: number): EditorSaveJournal | null {
      return journalsByGeneration.get(generationValue) ?? null;
    },
  };

  function requestIdKey(requestId: string, latchedSession: string, latchedGeneration: number): string {
    return `${latchedSession}|${latchedGeneration}|${requestId}`;
  }

  function isFencingCode(code: string): boolean {
    return (
      code === "STALE_SESSION" ||
      code === "STALE_EPOCH" ||
      code === "WORKSPACE_REVOKED" ||
      code === "WRONG_OWNER" ||
      code === "WORKSPACE_BUSY" ||
      code === "INVALID_TRANSITION" ||
      code === "EXTERNAL_MODIFICATION_CONFLICT" ||
      code === "FILE_NOT_FOUND" ||
      code === "FILE_EXISTS" ||
      code === "INVALID_LOCATION" ||
      code === "FIND_NOT_FOUND" ||
      code === "OCCURRENCE_MISMATCH" ||
      code === "UNSUPPORTED_TEXT_PROFILE" ||
      code === "NOT_AUTHORIZED" ||
      code === "RESOURCE_LIMIT" ||
      code === "WORKSPACE_VIOLATION" ||
      code === "DIRTY_BUFFER_CONFLICT"
    );
  }

  function failedWith(
    admission: EditorOperationAdmission,
    code: WorkspaceRejection["code"],
    message: string,
  ): WorkspaceOutcome<never> {
    appendNotifying(failedEventFor(admission, code, message));
    const tomb: LifecycleTombstone = {
      operation_id: admission.record.operation_id,
      action_type: actionOf(admission),
      kind: code === "COMMIT_UNCERTAIN" ? "commit_uncertain" : "failed",
      request_id: admission.record.request_id,
      journal_seq: journal.getTerminal(admission.record.operation_id)?.seq ?? null,
      detail: message,
    };
    if (code === "COMMIT_UNCERTAIN") holdReason = `commit-uncertain ${admission.record.operation_id}`;
    recordTombstone(tomb, admission.record.operation_id);
    return { ok: false, rejection: { code, message } };
  }

  function replayConverged(tomb: LifecycleTombstone): WorkspaceOutcome<never> {
    return { ok: true, value: deepFreeze({ ...tomb, replay: true }) } as unknown as WorkspaceOutcome<never>;
  }

  function replayConvergedOutcome(tomb: LifecycleTombstone): WorkspaceOutcome<never> {
    return { ok: true, value: deepFreeze({ ...tomb, replay: true }) } as unknown as WorkspaceOutcome<never>;
  }

  function plansByIdForOperation(operationId: string): string | null {
    for (const [planId, op] of plansById) {
      if (op === operationId) return planId;
    }
    return null;
  }

  function replacePlansByIdForOperation(operationId: string): string | null {
    for (const [planId, op] of replacePlansById) {
      if (op === operationId) return planId;
    }
    return null;
  }

  function plansByIdOperationFor(
    operationId: string,
    active: Map<string, { planId: string }>,
    byPlan: Map<string, string>,
  ): string | null {
    const entry = active.get(operationId);
    if (entry !== undefined) return entry.planId;
    for (const [planId, op] of byPlan) {
      if (op === operationId) return planId;
    }
    return null;
  }

  function appendNotifyingForPlanId(planId: string, operationId: string, rejection: WorkspaceRejection): void {
    const active = activeTypes.get(operationId);
    if (active === undefined) return;
    const resolved = session.registry.resolveDocument(active.documentId);
    const facts = resolved.ok ? resolved.value : null;
    appendNotifying({
      kind: "editor.operation.failed",
      session_id: sessionId,
      generation,
      operation_id: operationId,
      attempt_id: `lifecycle-${operationId}`,
      document_id: active.documentId,
      portable_path: facts?.portable_path ?? "src/unknown.ts",
      lesson_compiled_digest: session.catalog.lesson_compiled_digest,
      base_disk_revision: facts?.base_disk_revision ?? 0,
      base_digest: facts?.base_digest ?? null,
      new_disk_revision: null,
      new_digest: null,
      before_digest: active.baseDigest,
      after_digest: null,
      observed_digest: null,
      file_identity: null,
      byte_length: null,
      dirty: null,
      disk_effect: "none",
      code: rejection.code,
      message: sanitizeSaveMessage(rejection.message),
    });
    void planId;
  }

  function appendNotifyingForReplacePlanId(planId: string, operationId: string, rejection: WorkspaceRejection): void {
    const active = activeReplaces.get(operationId);
    if (active === undefined) return;
    const resolved = session.registry.resolveDocument(active.documentId);
    const facts = resolved.ok ? resolved.value : null;
    appendNotifying({
      kind: "editor.operation.failed",
      session_id: sessionId,
      generation,
      operation_id: operationId,
      attempt_id: `lifecycle-${operationId}`,
      document_id: active.documentId,
      portable_path: facts?.portable_path ?? "src/unknown.ts",
      lesson_compiled_digest: session.catalog.lesson_compiled_digest,
      base_disk_revision: facts?.base_disk_revision ?? 0,
      base_digest: facts?.base_digest ?? null,
      new_disk_revision: null,
      new_digest: null,
      before_digest: active.baseDigest,
      after_digest: null,
      observed_digest: null,
      file_identity: null,
      byte_length: null,
      dirty: null,
      disk_effect: "none",
      code: rejection.code,
      message: sanitizeSaveMessage(rejection.message),
    });
    void planId;
  }

  function installTypeCompletion(planId: string, operationId: string, active: ActiveTypeEntry): WorkspaceOutcome<unknown> {
    const admission = findAdmissionForOperation(operationId);
    const plan = typePlanner.getPlan(planId);
    if (plan === null) return rejected("INVALID_REQUEST", "unknown type plan");
    const stored = session.registry.setBufferContent(active.documentId, plan.expected_text);
    if (!stored.ok) {
      if (admission !== null) appendNotifying(failedEventFor(admission, stored.rejection.code, stored.rejection.message));
      return stored as { ok: false; rejection: WorkspaceRejection };
    }
    active.settled = true;
    if (admission !== null) {
      const completed = appendNotifying(completedEventFor(admission, active.baseDigest, plan.expected_digest, plan.expected_byte_length, true));
      const tomb: LifecycleTombstone = {
        operation_id: operationId,
        action_type: "type_code",
        kind: "completed",
        request_id: admission.record.request_id,
        journal_seq: completed.ok ? completed.value.seq : null,
        detail: "type installed exact candidate bytes with disk unchanged",
      };
      recordTombstone(tomb, operationId);
      return { ok: true, value: deepFreeze({ plan_id: planId, installed: true, lifecycle: tomb }) };
    }
    return { ok: true, value: deepFreeze({ plan_id: planId, installed: true }) };
  }

  function installReplaceCompletion(planId: string, operationId: string, active: ActiveReplaceEntry): WorkspaceOutcome<unknown> {
    const admission = findAdmissionForOperation(operationId);
    const plan = replacePlanner.getPlan(planId);
    if (plan === null) return rejected("INVALID_REQUEST", "unknown replace plan");
    const stored = session.registry.setBufferContent(active.documentId, plan.expected_text);
    if (!stored.ok) {
      if (admission !== null) appendNotifying(failedEventFor(admission, stored.rejection.code, stored.rejection.message));
      return stored as { ok: false; rejection: WorkspaceRejection };
    }
    active.settled = true;
    if (admission !== null) {
      const completed = appendNotifying(completedEventFor(admission, active.baseDigest, plan.expected_digest, plan.expected_byte_length, true));
      const tomb: LifecycleTombstone = {
        operation_id: operationId,
        action_type: "replace_code",
        kind: "completed",
        request_id: admission.record.request_id,
        journal_seq: completed.ok ? completed.value.seq : null,
        detail: "replace installed exact candidate bytes with disk unchanged",
      };
      recordTombstone(tomb, operationId);
      return { ok: true, value: deepFreeze({ plan_id: planId, installed: true, lifecycle: tomb }) };
    }
    return { ok: true, value: deepFreeze({ plan_id: planId, installed: true }) };
  }

  function findAdmissionForOperation(operationId: string): EditorOperationAdmission | null {
    return admissionsByOperation.get(scopeKey(operationId)) ?? null;
  }

  function cancelTypeOperation(operationId: string, planId: string): WorkspaceOutcome<unknown> {
    const existing = tombstoneFor(operationId);
    if (existing !== null) {
      // Cancel after completion reports already-final without undo (the P6.8
      // planner rule); duplicate cancel of a settled non-completed outcome
      // converges exactly once.
      if (existing.kind === "completed") {
        return rejected("INVALID_REQUEST", "type plan already completed: completion is already final and never reverts");
      }
      return { ok: true, value: deepFreeze({ ...existing }) };
    }
    const active = activeTypes.get(operationId);
    if (active === undefined) return rejected("INVALID_REQUEST", "unknown type operation");
    if (active.settled) {
      const tomb = tombstoneFor(operationId);
      if (tomb !== null) return { ok: true, value: deepFreeze({ ...tomb }) };
      return rejected("INVALID_REQUEST", "type plan already completed: completion is already final and never reverts");
    }
    const status = typePlanner.getStatus(planId);
    if (status === "completed") {
      return rejected("INVALID_REQUEST", "type plan already completed: completion is already final and never reverts");
    }
    if (status === "cancelled" || status === "failed") {
      return rejected("INVALID_REQUEST", "type plan already reached its final state");
    }
    if (session.registry.retired || closed) {
      return rejected("STALE_SESSION", "editor session was reset or closed: old type plans cannot cancel");
    }
    const cancelled = typePlanner.cancelPlan(session, planId);
    if (!cancelled.ok) return cancelled as { ok: false; rejection: WorkspaceRejection };
    // Restore the exact pre-operation buffer B0 with zero partial text.
    const current = session.registry.getBufferContent(active.documentId);
    if (current.ok && current.value !== active.baseText) {
      const restored = session.registry.setBufferContent(active.documentId, active.baseText);
      if (!restored.ok) return restored as { ok: false; rejection: WorkspaceRejection };
    }
    active.settled = true;
    const admission = findAdmissionForOperation(operationId);
    if (admission !== null) {
      const event = appendNotifying(cancelledEventFor(admission, active.baseDigest));
      const tomb: LifecycleTombstone = {
        operation_id: operationId,
        action_type: "type_code",
        kind: "cancelled",
        request_id: admission.record.request_id,
        journal_seq: event.ok ? event.value.seq : null,
        detail: "type cancelled before commit: exact pre-operation buffer restored with destination unchanged",
      };
      recordTombstone(tomb, operationId);
      return { ok: true, value: deepFreeze({ ...tomb }) };
    }
    const tomb: LifecycleTombstone = {
      operation_id: operationId,
      action_type: "type_code",
      kind: "cancelled",
      request_id: `lifecycle-${operationId}`,
      journal_seq: null,
      detail: "type cancelled before commit: exact pre-operation buffer restored with destination unchanged",
    };
    recordTombstone(tomb, operationId);
    return { ok: true, value: deepFreeze({ ...tomb }) };
  }

  function cancelTypeOperationClosed(operationId: string, planId: string, duringReset: boolean): void {
    try {
      const active = activeTypes.get(operationId);
      if (active === undefined || active.settled) return;
      const status = typePlanner.getStatus(planId);
      if (status === "completed") return;
      if (status === "cancelled" || status === "failed") {
        active.settled = true;
        return;
      }
      const cancelled = typePlanner.cancelPlan(session, planId);
      void cancelled;
      const current = session.registry.getBufferContent(active.documentId);
      if (current.ok && current.value !== active.baseText) {
        try {
          session.registry.setBufferContent(active.documentId, active.baseText);
        } catch {
          // Fail-closed: restoration is best-effort during teardown.
        }
      }
      active.settled = true;
      const admission = findAdmissionForOperation(operationId);
      const event = appendNotifying(
        admission !== null
          ? cancelledEventFor(admission, active.baseDigest)
          : {
              kind: "editor.operation.cancelled",
              session_id: sessionId,
              generation,
              operation_id: operationId,
              attempt_id: `lifecycle-${operationId}`,
              document_id: active.documentId,
              portable_path: "src/unknown.ts",
              lesson_compiled_digest: session.catalog.lesson_compiled_digest,
              base_disk_revision: 0,
              base_digest: active.baseDigest,
              new_disk_revision: null,
              new_digest: null,
              before_digest: active.baseDigest,
              after_digest: active.baseDigest,
              observed_digest: null,
              file_identity: null,
              byte_length: null,
              dirty: null,
              disk_effect: "none",
              code: "CANCELLED",
              message: duringReset ? "type settled by reset: exact pre-operation buffer restored" : "type settled by close: exact pre-operation buffer restored",
            },
      );
      void event;
      recordTombstone(
        {
          operation_id: operationId,
          action_type: "type_code",
          kind: "cancelled",
          request_id: admission?.record.request_id ?? `lifecycle-${operationId}`,
          journal_seq: event.ok ? event.value.seq : null,
          detail: duringReset ? "type settled by reset with B0 restored" : "type settled by close with B0 restored",
        },
        operationId,
      );
    } catch {
      // Teardown never throws.
    }
  }

  function cancelReplaceOperation(operationId: string, planId: string): WorkspaceOutcome<unknown> {
    const existing = tombstoneFor(operationId);
    if (existing !== null) {
      if (existing.kind === "completed") {
        return rejected("INVALID_REQUEST", "replace plan already completed: completion is already final and never reverts");
      }
      return { ok: true, value: deepFreeze({ ...existing }) };
    }
    const active = activeReplaces.get(operationId);
    if (active === undefined) return rejected("INVALID_REQUEST", "unknown replace operation");
    if (active.settled) {
      const tomb = tombstoneFor(operationId);
      if (tomb !== null) return { ok: true, value: deepFreeze({ ...tomb }) };
      return rejected("INVALID_REQUEST", "replace plan already completed: completion is already final and never reverts");
    }
    const status = replacePlanner.getStatus(planId);
    if (status === "completed") {
      return rejected("INVALID_REQUEST", "replace plan already completed: completion is already final and never reverts");
    }
    if (status === "cancelled" || status === "failed") {
      return rejected("INVALID_REQUEST", "replace plan already reached its final state");
    }
    if (session.registry.retired || closed) {
      return rejected("STALE_SESSION", "editor session was reset or closed: old replace plans cannot cancel");
    }
    const cancelled = replacePlanner.cancelPlan(session, planId);
    if (!cancelled.ok) return cancelled as { ok: false; rejection: WorkspaceRejection };
    const current = session.registry.getBufferContent(active.documentId);
    if (current.ok && current.value !== active.baseText) {
      const restored = session.registry.setBufferContent(active.documentId, active.baseText);
      if (!restored.ok) return restored as { ok: false; rejection: WorkspaceRejection };
    }
    active.settled = true;
    const admission = findAdmissionForOperation(operationId);
    if (admission !== null) {
      const event = appendNotifying(cancelledEventFor(admission, active.baseDigest));
      const tomb: LifecycleTombstone = {
        operation_id: operationId,
        action_type: "replace_code",
        kind: "cancelled",
        request_id: admission.record.request_id,
        journal_seq: event.ok ? event.value.seq : null,
        detail: "replace cancelled before commit: exact pre-operation buffer restored with destination unchanged",
      };
      recordTombstone(tomb, operationId);
      return { ok: true, value: deepFreeze({ ...tomb }) };
    }
    const tomb: LifecycleTombstone = {
      operation_id: operationId,
      action_type: "replace_code",
      kind: "cancelled",
      request_id: `lifecycle-${operationId}`,
      journal_seq: null,
      detail: "replace cancelled before commit: exact pre-operation buffer restored with destination unchanged",
    };
    recordTombstone(tomb, operationId);
    return { ok: true, value: deepFreeze({ ...tomb }) };
  }

  function cancelReplaceOperationClosed(operationId: string, planId: string, duringReset: boolean): void {
    try {
      const active = activeReplaces.get(operationId);
      if (active === undefined || active.settled) return;
      const status = replacePlanner.getStatus(planId);
      if (status === "completed") return;
      if (status === "cancelled" || status === "failed") {
        active.settled = true;
        return;
      }
      const cancelled = replacePlanner.cancelPlan(session, planId);
      void cancelled;
      const current = session.registry.getBufferContent(active.documentId);
      if (current.ok && current.value !== active.baseText) {
        try {
          session.registry.setBufferContent(active.documentId, active.baseText);
        } catch {
          // Fail-closed best-effort.
        }
      }
      active.settled = true;
      const admission = findAdmissionForOperation(operationId);
      const event = appendNotifying(
        admission !== null
          ? cancelledEventFor(admission, active.baseDigest)
          : {
              kind: "editor.operation.cancelled",
              session_id: sessionId,
              generation,
              operation_id: operationId,
              attempt_id: `lifecycle-${operationId}`,
              document_id: active.documentId,
              portable_path: "src/unknown.ts",
              lesson_compiled_digest: session.catalog.lesson_compiled_digest,
              base_disk_revision: 0,
              base_digest: active.baseDigest,
              new_disk_revision: null,
              new_digest: null,
              before_digest: active.baseDigest,
              after_digest: active.baseDigest,
              observed_digest: null,
              file_identity: null,
              byte_length: null,
              dirty: null,
              disk_effect: "none",
              code: "CANCELLED",
              message: duringReset ? "replace settled by reset: exact pre-operation buffer restored" : "replace settled by close: exact pre-operation buffer restored",
            },
      );
      void event;
      recordTombstone(
        {
          operation_id: operationId,
          action_type: "replace_code",
          kind: "cancelled",
          request_id: admission?.record.request_id ?? `lifecycle-${operationId}`,
          journal_seq: event.ok ? event.value.seq : null,
          detail: duringReset ? "replace settled by reset with B0 restored" : "replace settled by close with B0 restored",
        },
        operationId,
      );
    } catch {
      // Teardown never throws.
    }
  }

  return lifecycle;
}
