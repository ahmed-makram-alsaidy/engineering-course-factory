// P6.13 terminal interoperability — the trusted editor-to-terminal and
// terminal-to-editor handoff over ONE authoritative shared workspace.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 16 (P5
// interoperability, concurrency and watchers), 10 (explicit save), 14
// (journal), 15 (identifier-only IPC), 21 (failure semantics), 22 task
// P6.13 ("Real shared bind, dirty reads, RW invalidation, background
// watcher"; PASS "Exact saved target observed; no partial typing") and the
// frozen contract 26.1/26.4/26.5/26.7/26.8/26.9/26.10 plus ADR-0011.
//
// What this module owns (and only this):
//   - composing the already-passing authorities without weakening any of
//     them: the P6.2 WorkspaceCoordinator (ownership/epochs/barriers), the
//     P6.11 EditorLifecycle (admission/execution/cancel/journal), the P6.4
//     WindowsFileAdapter (sole publication primitive, injected bound
//     handle) and one access-epoch terminal container reached through the
//     injected structural TerminalEpochOps (real DockerAccessEpochProvider
//     in platform proofs, deterministic doubles in unit proofs).
//   - the canonical target flow on the same leaf: admitted open/create,
//     admitted type/replace installed into the main-owned buffer, verified
//     save as the commit barrier, then terminal observation of exactly the
//     committed bytes — plus the reverse handoff (RW modify, confirmed
//     retirement, explicit reacquire before further editing).
//   - authored-order serialization: the verified save completes before a
//     following terminal operation may start; the shared trace records
//     save-commit before terminal-start deterministically (monotonic
//     interop seq, never wall-clock inference).
//   - main-owned dirty truth: buffer facts flow from the live editor
//     registry into the coordinator before every terminal admission, so a
//     dirty buffer or pending creation denies read-write with
//     DIRTY_BUFFER_CONFLICT and the renderer cannot forge cleanliness.
//   - post-RW reacquire discipline: after every read-write epoch the
//     previously loaded documents require an explicit authored open
//     before further type/replace/save (EXTERNAL_MODIFICATION_CONFLICT
//     otherwise, never a silent overwrite or rebase).
//
// What this module NEVER does:
//   - it never decides terminal access (the digest-bound reviewed policy
//     resolved by the coordinator is the only access authority; no command
//     parameter exists anywhere here, so inference is structurally
//     impossible);
//   - it never accepts renderer paths/bytes/commands (every request is a
//     strict identifier-only DTO; observation rel_paths resolve from
//     main-held saved targets or strict portable-path probes owned by the
//     main-side caller — never from renderer input);
//   - it never writes the leaf itself (publication flows only through the
//     owning save executor; leaf allocation/seeding/cleanup arrives via
//     injected main-held seams, same standing as Electron main);
//   - it never creates a generic execution API (foreground reads run the
//     fixed guest cat transport, foreground runs run the fixed guest node
//     transport at the reviewed saved target, writes run the fixed bounded
//     guest write transport — all through TerminalEpochOps, all admitted
//     first by the coordinator);
//   - it never bypasses the coordinator barrier (every editor mutation is
//     reserved through runEditorOperation, every terminal action through
//     runTerminalOperation, every RW release retires through the bridge so
//     editor authority resumes only after confirmed container absence);
//   - it never keeps wall-clock time (ordering is the monotonic trace seq
//     plus the coordinator barrier receipts; bounded waits live in tests).
//
// Purity: zod plus relative workspace modules only. No filesystem, no
// processes, no containers, no timers, no terminal-engine import (the
// provider arrives as a structural interface so this package keeps its
// P6.1 import boundary; the real provider is injected by main/tests).

import { z } from "zod";
import {
  PortablePathSchema,
  WorkspaceIdentifierSchema,
  type WorkspaceExecutionPermit,
  type WorkspaceOutcome,
  type WorkspaceOwnership,
  type WorkspaceRejection,
} from "./protocol.ts";
import type { ReviewedWorkspacePolicy, SeedManifest } from "./policy.ts";
import {
  createWorkspaceCoordinator,
  type CombinedSessionDescriptor,
  type EditorCapability,
  type EditorLease,
  type EpochCapability,
  type SharedWorkspaceCoordinator,
  type TerminalCapability,
  type TerminalLease,
} from "./coordinator.ts";
import { createEditorCatalog, editorBufferFacts, editorSnapshotDocuments } from "./editor-admission.ts";
import { createEditorLifecycle, type EditorLifecycle, type LifecycleExecDeps } from "./editor-lifecycle.ts";
import type { AdapterAuthority, WindowsFileAdapter } from "./file-adapter.ts";
import type { EditorSaveEvent } from "./editor-save.ts";

/** Interop protocol version (matches the workspace protocol). */
export const EDITOR_TERMINAL_INTEROP_VERSION = 1;

/** Bounded terminal output captured per observation (bytes, never pages). */
export const INTEROP_MAX_OBSERVED_BYTES = 65536;

/** Bounded trace detail text (mirrors the save-journal message bound). */
export const INTEROP_MAX_TRACE_CHARS = 512;

/** Runtime-only live epoch handle (structural; the real provider owns it). */
export interface EpochHandleLike {
  readonly handleId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly access: "read_only" | "read_write";
  readonly leaseId: string;
  readonly containerId: string;
  readonly containerName: string;
}

/** Terminal observation result (P5 journal-owned actuals, passive here). */
export interface EpochObservation {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Structural access-epoch terminal operations (main-held). The real
 * DockerAccessEpochProvider implements this shape in platform proofs;
 * deterministic tests inject a double over the same leaf. No command,
 * environment, mount or image value crosses this seam: preparation binds
 * the coordinator-issued permit, reads/runs/writes name a validated
 * workspace-relative target only.
 */
export interface TerminalEpochOps {
  prepareEpoch(args: {
    readonly sessionId: string;
    readonly generation: number;
    readonly epoch: number;
    readonly access: "read_only" | "read_write";
    readonly leafHostPath: string;
    readonly leaseId: string;
    readonly policyDigest: string;
    readonly containerName: string;
    readonly testRunId: string;
  }): Promise<EpochHandleLike>;
  readEpochFile(handle: EpochHandleLike, relPath: string): Promise<EpochObservation>;
  runEpochScript(handle: EpochHandleLike, relPath: string): Promise<EpochObservation>;
  attemptEpochWrite(handle: EpochHandleLike, relPath: string, content: string): Promise<EpochObservation>;
  retireEpoch(handle: EpochHandleLike, cause: string): Promise<{ cleanup: "confirmed" | "unconfirmed" }>;
}

/** Main-held leaf preparation seam (allocate/clear/seed the disk leaf). */
export type InteropPrepareLeaf = (seedFiles: Readonly<Record<string, string>>) => void;

/** Main-held adapter binding seam (bind the coordinator leaf + staging). */
export type InteropBindAdapter = (descriptor: {
  readonly sessionId: string;
  readonly generation: number;
  readonly workspaceId: string;
}) => { ok: true; adapter: WindowsFileAdapter } | { ok: false; code: string; message: string };

/** Main-held interop creation arguments (all reviewed/owned, never renderer input). */
export interface InteropSessionConfig {
  readonly compiledLesson: unknown;
  readonly reviewedPolicy: ReviewedWorkspacePolicy;
  readonly seedManifest: SeedManifest;
  /** Exact seed bytes for initial seeding and reset reseed (keys are portable paths). */
  readonly seedFiles: Readonly<Record<string, string>>;
  readonly leafHostPath: string;
  readonly installationId: string;
  readonly containerNamePrefix: string;
  readonly testRunId: string;
  readonly terminal: TerminalEpochOps;
  readonly prepareLeaf: InteropPrepareLeaf;
  readonly bindAdapter: InteropBindAdapter;
}

/** Strict identifier-only interop operation request (no path/content/command extra survives). */
export const InteropOperationRequestSchema = z
  .strictObject({
    session_id: WorkspaceIdentifierSchema,
    generation: z.number().int().min(1),
    operation_id: WorkspaceIdentifierSchema,
    request_id: WorkspaceIdentifierSchema,
  })
  .readonly();
export type InteropOperationRequest = z.infer<typeof InteropOperationRequestSchema>;
/** Strict identifier-only lifecycle request (reset/close/stop paths). */
export const InteropLifecycleRequestSchema = z
  .strictObject({
    session_id: WorkspaceIdentifierSchema,
    generation: z.number().int().min(1),
    request_id: WorkspaceIdentifierSchema,
  })
  .readonly();
export type InteropLifecycleRequest = z.infer<typeof InteropLifecycleRequestSchema>;

/** Strict main-held terminal modification request (bounded content, validated target). */
export const InteropModifyRequestSchema = z
  .strictObject({
    session_id: WorkspaceIdentifierSchema,
    generation: z.number().int().min(1),
    operation_id: WorkspaceIdentifierSchema,
    request_id: WorkspaceIdentifierSchema,
    rel_path: PortablePathSchema,
    content: z.string().max(4096),
  })
  .readonly()
  .superRefine((value, ctx) => {
    if (value.content.includes("\0")) {
      ctx.addIssue({ code: "custom", message: "modification content must not contain NUL" });
    }
  });
export type InteropModifyRequest = z.infer<typeof InteropModifyRequestSchema>;

/** Strict main-held observation probe (validated target only, no command). */
export const InteropObserveRequestSchema = z
  .strictObject({
    session_id: WorkspaceIdentifierSchema,
    generation: z.number().int().min(1),
    rel_path: PortablePathSchema,
  })
  .readonly();
export type InteropObserveRequest = z.infer<typeof InteropObserveRequestSchema>;

/** Shared-trace event kinds (interop-owned monotonic seq; no timestamps). */
export const InteropTraceKindSchema = z.enum([
  "interop.session.opened",
  "interop.editor.completed",
  "interop.save.committed",
  "interop.terminal.admitted",
  "interop.terminal.observed",
  "interop.terminal.retired",
  "interop.files.invalidated",
  "interop.cancelled",
  "interop.reset.completed",
  "interop.close.completed",
  "interop.hold.entered",
]);
export type InteropTraceKind = z.infer<typeof InteropTraceKindSchema>;

export interface InteropTraceEvent {
  readonly seq: number;
  readonly kind: InteropTraceKind;
  readonly session_id: string;
  readonly generation: number;
  readonly epoch: number;
  readonly operation_id: string | null;
  readonly detail: string;
}

function rejected(code: WorkspaceRejection["code"], message: string): { ok: false; rejection: WorkspaceRejection } {
  return { ok: false, rejection: { code, message } };
}

function sanitizeDetail(detail: string): string {
  return detail.replace(/[\r\n\t]+/g, " ").slice(0, INTEROP_MAX_TRACE_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function outcomeCode(outcome: unknown): string {
  if (isRecord(outcome) && isRecord(outcome["rejection"]) && typeof outcome["rejection"]["code"] === "string") {
    return outcome["rejection"]["code"] as string;
  }
  return "UNKNOWN";
}

/** Safe interop session descriptor (identifiers/revisions/flags only). */
export interface InteropDescriptor {
  readonly session_id: string;
  readonly generation: number;
  readonly ownership: WorkspaceOwnership;
  readonly epoch: number;
  readonly epoch_access: "read_only" | "read_write" | null;
  readonly workspace_revision: number;
  readonly ro_observers: number;
  readonly dirty_buffers: number;
  readonly pending_creations: number;
  readonly save_active: boolean;
  readonly last_saved_target: string | null;
  readonly last_saved_revision: number | null;
  readonly reacquire_required: number;
  readonly trace_length: number;
  readonly closed: boolean;
}

export interface InteropSavedTarget {
  readonly portable_path: string;
  readonly disk_revision: number;
  readonly disk_digest: string | null;
  readonly operation_id: string;
  readonly journal_seq: number;
}

export interface InteropTerminalRead {
  readonly target: string;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stdout_bytes: number;
  readonly journal_seq_before: number | null;
  readonly trace_seq: number;
}

/** The main-owned editor/terminal interop session (one combined lesson session). */
export interface EditorTerminalInterop {
  readonly version: 1;
  describe(): InteropDescriptor;
  runOpenDocument(request: unknown): Promise<WorkspaceOutcome<{ document_id: string }>>;
  runCreateDocument(request: unknown): Promise<WorkspaceOutcome<{ document_id: string }>>;
  runTypeDocument(request: unknown): Promise<WorkspaceOutcome<{ plan_id: string }>>;
  runReplaceDocument(request: unknown): Promise<WorkspaceOutcome<{ plan_id: string }>>;
  runSaveDocument(request: unknown): Promise<WorkspaceOutcome<InteropSavedTarget>>;
  runReacquireDocument(request: unknown): Promise<WorkspaceOutcome<{ document_id: string }>>;
  cancelDocument(request: unknown): WorkspaceOutcome<{ kind: string }>;
  startWatcher(request: unknown): Promise<WorkspaceOutcome<{ observers: number }>>;
  stopWatcher(request: unknown): Promise<WorkspaceOutcome<{ observers: number }>>;
  observeCommitted(request: unknown): Promise<WorkspaceOutcome<{ exit_code: number | null; stdout: string }>>;
  terminalReadSaved(request: unknown): Promise<WorkspaceOutcome<InteropTerminalRead>>;
  terminalRunSaved(request: unknown): Promise<WorkspaceOutcome<InteropTerminalRead>>;
  terminalModify(request: unknown): Promise<WorkspaceOutcome<{ exit_code: number | null; changed: boolean }>>;
  resetSession(request: unknown): Promise<WorkspaceOutcome<InteropDescriptor>>;
  closeSession(request: unknown): Promise<WorkspaceOutcome<null>>;
  sharedTrace(afterSeq?: number): readonly InteropTraceEvent[];
  editorEvents(afterSeq?: number): readonly EditorSaveEvent[];
  workspaceEvents(): readonly { seq: number; type: string }[];
}

/**
 * Create the main-owned interop session. Verifies the reviewed policy
 * through the coordinator, prepares the disk leaf through the main-held
 * seam, binds the adapter and opens the editor lifecycle on the SAME
 * coordinator-issued session identity both engines share.
 */
export function createEditorTerminalInterop(config: InteropSessionConfig): WorkspaceOutcome<EditorTerminalInterop> {
  const terminal = config.terminal;
  let closed = false;
  let resetting = false;
  let traceSeq = 0;
  const trace: InteropTraceEvent[] = [];
  // Live RO epoch sharing: one real container, many admitted observers.
  let epochHandle: EpochHandleLike | null = null;
  const roOwners = new Map<string, { operationId: string }>();
  // Post-RW reacquire discipline: canonical keys requiring an explicit
  // authored open before further type/replace/save (same generation).
  const reacquireRequired = new Set<string>();
  let lastSaved: InteropSavedTarget | null = null;
  let containerSeq = 0;

  const coord: SharedWorkspaceCoordinator = createWorkspaceCoordinator({
    provider: {
      prepare: () => Promise.resolve("confirmed"),
      retire: (cause: string) => {
        const live = epochHandle;
        if (live === null) return Promise.resolve("confirmed" as const);
        return terminal.retireEpoch(live, cause).then(
          (outcome) => {
            if (outcome.cleanup === "confirmed") epochHandle = null;
            return outcome.cleanup;
          },
          () => "unconfirmed" as const,
        );
      },
    },
  });

  const opened = coord.openCombinedSession({
    validatedIr: config.compiledLesson,
    reviewedPolicy: config.reviewedPolicy,
    seedManifest: config.seedManifest,
  });
  if (!opened.ok) return opened as { ok: false; rejection: WorkspaceRejection };
  let editorCapability: EditorCapability = opened.value.editorCapability;
  let terminalCapability: TerminalCapability = opened.value.terminalCapability;
  let epochCapability: EpochCapability = opened.value.epochCapability;

  // Cached session facts for the trace writer: the trace must never throw
  // on a terminal barrier (close/reset record completion last), so it
  // carries the last confirmed facts when the live descriptor is gone.
  let cachedSessionId = opened.value.descriptor.sessionId;
  let cachedGeneration = opened.value.descriptor.generation;
  let cachedEpoch = opened.value.descriptor.epoch;

  function refreshCache(): void {
    try {
      const live = coord.describe();
      cachedSessionId = live.sessionId;
      cachedGeneration = live.generation;
      cachedEpoch = live.epoch;
    } catch {
      // The last confirmed facts still identify the trace correctly.
    }
  }

  function recordTrace(kind: InteropTraceKind, operationId: string | null, detail: string): InteropTraceEvent {
    refreshCache();
    traceSeq += 1;
    const event: InteropTraceEvent = Object.freeze({
      seq: traceSeq,
      kind,
      session_id: cachedSessionId,
      generation: cachedGeneration,
      epoch: cachedEpoch,
      operation_id: operationId,
      detail: sanitizeDetail(detail),
    });
    trace.push(event);
    return event;
  }

  function holdTrace(cause: string): void {
    recordTrace("interop.hold.entered", null, `session holds: ${cause}`);
  }

  try {
    config.prepareLeaf(config.seedFiles);
  } catch {
    return rejected("INVALID_REQUEST", "interop leaf preparation failed: no session was opened");
  }
  const bound = config.bindAdapter({
    sessionId: opened.value.descriptor.sessionId,
    generation: opened.value.descriptor.generation,
    workspaceId: opened.value.descriptor.workspaceId,
  });
  if (!bound.ok) return rejected("INVALID_REQUEST", `interop adapter binding failed: ${bound.message}`);
  let adapter: WindowsFileAdapter = bound.adapter;

  const catalogOutcome = createEditorCatalog(config.compiledLesson);
  if (!catalogOutcome.ok) return catalogOutcome as { ok: false; rejection: WorkspaceRejection };
  const catalog = catalogOutcome.value;
  let lifecycle: EditorLifecycle = createEditorLifecycle({
    catalog,
    seedManifest: config.seedManifest,
    sessionId: opened.value.descriptor.sessionId,
    generation: opened.value.descriptor.generation,
    reviewed: true,
    wiring: {
      getOwnership: () => coord.describe().ownership,
      getEpoch: () => coord.describe().epoch,
    },
  });

  recordTrace("interop.session.opened", null, `combined session opened ownership=${coord.describe().ownership} epoch=${coord.describe().epoch}`);

  function liveDescriptor(): CombinedSessionDescriptor {
    return coord.describe();
  }

  function fenceRequest(sessionId: string, generation: number): WorkspaceRejection | null {
    const live = liveDescriptor();
    if (closed) return { code: "INVALID_TRANSITION", message: "interop session is closed: no new work" };
    if (resetting) return { code: "STALE_SESSION", message: "interop session is resetting: old work cannot proceed" };
    if (sessionId !== live.sessionId) return { code: "WRONG_OWNER", message: "interop request names a foreign session" };
    if (generation !== live.generation) return { code: "STALE_SESSION", message: "interop request carries a stale session generation" };
    const ownership = live.ownership;
    if (ownership === "HOLD") {
      return { code: "CLEANUP_UNCONFIRMED", message: "session holds with retained resources: explicit reset or close is required" };
    }
    if (ownership === "RESETTING" || ownership === "CLOSING" || ownership === "TRANSITION") {
      return { code: "INVALID_TRANSITION", message: `interop work is barred while ${ownership}` };
    }
    return null;
  }

  function syncFacts(): void {
    const session = lifecycle.getSession();
    const facts = editorBufferFacts(session);
    const syncOutcome = coord.setBufferFacts(editorCapability, { dirtyBufferCount: facts.dirtyBufferCount, pendingCreationCount: facts.pendingCreationCount });
    void syncOutcome;
    const documents = editorSnapshotDocuments(session);
    coord.setOpenDocuments(
      editorCapability,
      documents.map((entry) => ({
        portable_path: entry.portable_path,
        disk_revision: entry.disk_revision,
        buffer_revision: entry.buffer_revision,
        dirty: entry.dirty,
      })),
    );
  }

  function freshAuthority(lease: EditorLease): AdapterAuthority {
    const live = liveDescriptor();
    const facts = coord.getLiveFacts();
    return {
      lease,
      ownership: live.ownership,
      liveEpoch: live.epoch,
      revokedLeaseIds: [...facts.revoked_lease_ids],
    };
  }

  function lifecycleDeps(lease: EditorLease): LifecycleExecDeps {
    const authority = freshAuthority(lease);
    return {
      adapter,
      authority: {
        lease: {
          kind: "editor_lease",
          leaseId: lease.leaseId,
          sessionId: lease.sessionId,
          generation: lease.generation,
          workspaceId: lease.workspaceId,
          epoch: lease.epoch,
          operationId: lease.operationId,
          requestId: lease.requestId,
        },
        ownership: authority.ownership,
        liveEpoch: authority.liveEpoch,
        revokedLeaseIds: authority.revokedLeaseIds,
      },
      revalidate: () => {
        const fresh = freshAuthority(lease);
        return {
          lease: {
            kind: "editor_lease",
            leaseId: lease.leaseId,
            sessionId: lease.sessionId,
            generation: lease.generation,
            workspaceId: lease.workspaceId,
            epoch: lease.epoch,
            operationId: lease.operationId,
            requestId: lease.requestId,
          },
          ownership: fresh.ownership,
          liveEpoch: fresh.liveEpoch,
          revokedLeaseIds: fresh.revokedLeaseIds,
        };
      },
    };
  }

  function parseOperation(request: unknown): { ok: true; value: InteropOperationRequest } | { ok: false; rejection: WorkspaceRejection } {
    const parsed = InteropOperationRequestSchema.safeParse(request);
    if (!parsed.success) {
      return rejected("INVALID_REQUEST", `interop request failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
    }
    const fenced = fenceRequest(parsed.data.session_id, parsed.data.generation);
    if (fenced !== null) return { ok: false, rejection: fenced };
    return { ok: true, value: parsed.data };
  }

  function checkReacquire(portablePath: string): WorkspaceRejection | null {
    if (reacquireRequired.has(portablePath.toLowerCase())) {
      return {
        code: "EXTERNAL_MODIFICATION_CONFLICT",
        message: "document predates a terminal write epoch: explicit reopen is required before further editing, never a silent rebase",
      };
    }
    return null;
  }

  /**
   * Reviewed operation target resolved pre-admission from the frozen
   * catalog (never renderer input). Lets ordering/ownership conflicts fail
   * BEFORE admission consumes the attempt or reserves buffer state.
   */
  function reviewedTarget(operationId: string): string | null {
    return catalog.operations.get(operationId)?.portable_path ?? null;
  }

  function admissionTarget(admission: { record: { portable_path: string } }): string {
    return admission.record.portable_path;
  }

  async function reserveEditor(operationId: string, requestId: string): Promise<WorkspaceOutcome<EditorLease>> {
    const reserved = await coord.runEditorOperation(editorCapability, operationId, requestId);
    if (!reserved.ok) return reserved as { ok: false; rejection: WorkspaceRejection };
    return { ok: true, value: reserved.value.lease };
  }

  async function runEditorThroughLifecycle(
    operationId: string,
    requestId: string,
    kind: "open" | "create" | "type" | "replace" | "save",
    step: (admission: Parameters<EditorLifecycle["executeOpen"]>[0], deps: LifecycleExecDeps) => Promise<WorkspaceOutcome<unknown>>,
  ): Promise<WorkspaceOutcome<{ admission: { record: { portable_path: string } }; result: unknown }>> {
    const leaseOutcome = await reserveEditor(operationId, requestId);
    if (!leaseOutcome.ok) return leaseOutcome as { ok: false; rejection: WorkspaceRejection };
    const lease = leaseOutcome.value;
    try {
      const admitted = lifecycle.admit(operationId, requestId);
      if (!admitted.ok) {
        coord.releaseEditor(lease);
        return admitted as { ok: false; rejection: WorkspaceRejection };
      }
      if (kind === "save") {
        const begun = coord.beginSave(editorCapability);
        if (!begun.ok) {
          coord.releaseEditor(lease);
          return begun as { ok: false; rejection: WorkspaceRejection };
        }
      }
      const deps = lifecycleDeps(lease);
      const result = await step(admitted.value, deps);
      if (kind === "save") {
        const ended = coord.endSave(editorCapability);
        if (!ended.ok) {
          coord.releaseEditor(lease);
          return ended as { ok: false; rejection: WorkspaceRejection };
        }
      }
      coord.releaseEditor(lease);
      syncFacts();
      if (!result.ok) return result as { ok: false; rejection: WorkspaceRejection };
      return { ok: true, value: { admission: admitted.value, result: result.value } };
    } catch {
      if (kind === "save") {
        try {
          coord.endSave(editorCapability);
        } catch {
          // Release below still runs; the barrier never sticks.
        }
      }
      try {
        coord.releaseEditor(lease);
      } catch {
        // Fail-closed: the coordinator owns the slot receipt.
      }
      return rejected("INVALID_REQUEST", "interop editor step failed safely with the reservation released");
    }
  }

  function nextContainerName(purpose: string): string {
    containerSeq += 1;
    return `${config.containerNamePrefix}${purpose}-${containerSeq}`;
  }

  async function ensureRoEpoch(permit: WorkspaceExecutionPermit): Promise<WorkspaceOutcome<EpochHandleLike>> {
    if (epochHandle !== null) {
      if (epochHandle.epoch !== permit.epoch || epochHandle.access !== "read_only") {
        return rejected("STALE_EPOCH", "live epoch handle does not match the admitted read-only permit");
      }
      return { ok: true, value: epochHandle };
    }
    try {
      const handle = await terminal.prepareEpoch({
        sessionId: permit.session_id,
        generation: permit.generation,
        epoch: permit.epoch,
        access: "read_only",
        leafHostPath: config.leafHostPath,
        leaseId: permit.lease_id,
        policyDigest: permit.policy_digest,
        containerName: nextContainerName("ro"),
        testRunId: config.testRunId,
      });
      epochHandle = handle;
      return { ok: true, value: handle };
    } catch (error) {
      const code = (error as { code?: string }).code ?? "INVALID_REQUEST";
      const message = error instanceof Error ? error.message : String(error);
      return rejected(code as WorkspaceRejection["code"], `read-only epoch preparation failed safely: ${message.slice(0, 200)}`);
    }
  }

  async function releaseRoOwner(lease: TerminalLease): Promise<WorkspaceOutcome<null>> {
    roOwners.delete(lease.leaseId);
    const released = await coord.releaseTerminal(lease);
    if (!released.ok) return released as { ok: false; rejection: WorkspaceRejection };
    if (roOwners.size === 0 && epochHandle !== null && epochHandle.access === "read_only") {
      const retiring = epochHandle;
      try {
        const outcome = await terminal.retireEpoch(retiring, "ro_release");
        if (outcome.cleanup !== "confirmed") {
          epochHandle = retiring;
          coord.onProviderFailure(epochCapability, "read-only epoch retirement is unconfirmed");
          holdTrace("read-only epoch retirement is unconfirmed");
          return rejected("CLEANUP_UNCONFIRMED", "read-only retirement is unconfirmed: session holds with retained resources");
        }
        epochHandle = null;
        recordTrace("interop.terminal.retired", null, `read-only epoch retired cleanup=confirmed`);
      } catch {
        coord.onProviderFailure(epochCapability, "read-only epoch retirement failed");
        holdTrace("read-only epoch retirement failed");
        return rejected("CLEANUP_UNCONFIRMED", "read-only retirement failed: session holds with retained resources");
      }
    }
    return { ok: true, value: null };
  }

  function boundObservation(output: EpochObservation): { exit_code: number | null; stdout: string } | { tooLarge: true } {
    const bytes = Buffer.byteLength(output.stdout, "utf8");
    if (bytes > INTEROP_MAX_OBSERVED_BYTES) return { tooLarge: true };
    return { exit_code: output.exitCode, stdout: output.stdout };
  }

  const interop: EditorTerminalInterop = {
    version: 1,

    describe(): InteropDescriptor {
      const live = liveDescriptor();
      const logical = coord.getLogicalState();
      return Object.freeze({
        session_id: live.sessionId,
        generation: live.generation,
        ownership: live.ownership,
        epoch: live.epoch,
        epoch_access: live.epochAccess,
        workspace_revision: live.workspaceRevision,
        ro_observers: roOwners.size,
        dirty_buffers: logical.dirtyBufferCount,
        pending_creations: logical.pendingCreationCount,
        save_active: logical.saveActive,
        last_saved_target: lastSaved?.portable_path ?? null,
        last_saved_revision: lastSaved?.disk_revision ?? null,
        reacquire_required: reacquireRequired.size,
        trace_length: trace.length,
        closed,
      });
    },

    async runOpenDocument(request: unknown): Promise<WorkspaceOutcome<{ document_id: string }>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      const outcome = await runEditorThroughLifecycle(operation_id, request_id, "open", (admission, deps) => lifecycle.executeOpen(admission, deps));
      if (!outcome.ok) return outcome as { ok: false; rejection: WorkspaceRejection };
      const target = admissionTarget(outcome.value.admission);
      reacquireRequired.delete(target.toLowerCase());
      const settled = lifecycle.getJournal().getTerminal(operation_id);
      const documentId = settled?.document_id ?? "";
      recordTrace("interop.editor.completed", operation_id, `open ${target} document=${documentId}`);
      return { ok: true, value: Object.freeze({ document_id: documentId }) };
    },

    async runCreateDocument(request: unknown): Promise<WorkspaceOutcome<{ document_id: string }>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      const outcome = await runEditorThroughLifecycle(operation_id, request_id, "create", (admission, deps) => lifecycle.executeCreate(admission, deps));
      if (!outcome.ok) return outcome as { ok: false; rejection: WorkspaceRejection };
      const settled = lifecycle.getJournal().getTerminal(operation_id);
      const documentId = settled?.document_id ?? "";
      recordTrace("interop.editor.completed", operation_id, `create staged document=${documentId}`);
      return { ok: true, value: Object.freeze({ document_id: documentId }) };
    },

    async runTypeDocument(request: unknown): Promise<WorkspaceOutcome<{ plan_id: string }>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      const preTarget = reviewedTarget(operation_id);
      if (preTarget !== null) {
        const preGated = checkReacquire(preTarget);
        if (preGated !== null) return { ok: false, rejection: preGated };
      }
      const leaseOutcome = await reserveEditor(operation_id, request_id);
      if (!leaseOutcome.ok) return leaseOutcome as { ok: false; rejection: WorkspaceRejection };
      const lease = leaseOutcome.value;
      try {
        const admitted = lifecycle.admit(operation_id, request_id);
        if (!admitted.ok) {
          coord.releaseEditor(lease);
          return admitted as { ok: false; rejection: WorkspaceRejection };
        }
        const gated = checkReacquire(admissionTarget(admitted.value));
        if (gated !== null) {
          coord.releaseEditor(lease);
          return { ok: false, rejection: gated };
        }
        const planned = lifecycle.planType(admitted.value);
        if (!planned.ok) {
          coord.releaseEditor(lease);
          return planned as { ok: false; rejection: WorkspaceRejection };
        }
        const completed = lifecycle.completeType(planned.value.plan_id);
        coord.releaseEditor(lease);
        syncFacts();
        if (!completed.ok) return completed as { ok: false; rejection: WorkspaceRejection };
        recordTrace("interop.editor.completed", operation_id, `type installed plan=${planned.value.plan_id} disk unchanged until save`);
        return { ok: true, value: Object.freeze({ plan_id: planned.value.plan_id }) };
      } catch {
        try {
          coord.releaseEditor(lease);
        } catch {
          // Coordinator owns the slot receipt.
        }
        return rejected("INVALID_REQUEST", "interop type step failed safely with the reservation released");
      }
    },

    async runReplaceDocument(request: unknown): Promise<WorkspaceOutcome<{ plan_id: string }>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      const preTarget = reviewedTarget(operation_id);
      if (preTarget !== null) {
        const preGated = checkReacquire(preTarget);
        if (preGated !== null) return { ok: false, rejection: preGated };
      }
      const leaseOutcome = await reserveEditor(operation_id, request_id);
      if (!leaseOutcome.ok) return leaseOutcome as { ok: false; rejection: WorkspaceRejection };
      const lease = leaseOutcome.value;
      try {
        const admitted = lifecycle.admit(operation_id, request_id);
        if (!admitted.ok) {
          coord.releaseEditor(lease);
          return admitted as { ok: false; rejection: WorkspaceRejection };
        }
        const gated = checkReacquire(admissionTarget(admitted.value));
        if (gated !== null) {
          coord.releaseEditor(lease);
          return { ok: false, rejection: gated };
        }
        const planned = lifecycle.planReplace(admitted.value);
        if (!planned.ok) {
          coord.releaseEditor(lease);
          return planned as { ok: false; rejection: WorkspaceRejection };
        }
        const completed = lifecycle.completeReplace(planned.value.plan_id);
        coord.releaseEditor(lease);
        syncFacts();
        if (!completed.ok) return completed as { ok: false; rejection: WorkspaceRejection };
        recordTrace("interop.editor.completed", operation_id, `replace installed plan=${planned.value.plan_id} disk unchanged until save`);
        return { ok: true, value: Object.freeze({ plan_id: planned.value.plan_id }) };
      } catch {
        try {
          coord.releaseEditor(lease);
        } catch {
          // Coordinator owns the slot receipt.
        }
        return rejected("INVALID_REQUEST", "interop replace step failed safely with the reservation released");
      }
    },

    async runSaveDocument(request: unknown): Promise<WorkspaceOutcome<InteropSavedTarget>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      const preTarget = reviewedTarget(operation_id);
      if (preTarget !== null) {
        const preGated = checkReacquire(preTarget);
        if (preGated !== null) return { ok: false, rejection: preGated };
      }
      // The save barrier resolves its target from the reviewed admission
      // inside the lifecycle; no path travels in this request. The
      // pre-admission reacquire check above keeps stale attempts from
      // consuming coordinator state; the in-step check below revalidates
      // after the reservation against an intervening write epoch.
      const outcome = await runEditorThroughLifecycle(operation_id, request_id, "save", async (admission, deps) => {
        const gated = checkReacquire(admissionTarget(admission));
        if (gated !== null) return { ok: false, rejection: gated };
        return lifecycle.executeSave(admission, deps);
      });
      if (!outcome.ok) return outcome as { ok: false; rejection: WorkspaceRejection };
      const settled = lifecycle.getJournal().getTerminal(operation_id);
      const saved: InteropSavedTarget = Object.freeze({
        portable_path: settled?.portable_path ?? admissionTarget(outcome.value.admission),
        disk_revision: settled?.new_disk_revision ?? 0,
        disk_digest: settled?.new_digest ?? null,
        operation_id,
        journal_seq: settled?.seq ?? 0,
      });
      lastSaved = saved;
      recordTrace("interop.save.committed", operation_id, `save committed ${saved.portable_path} revision=${saved.disk_revision} journal_seq=${saved.journal_seq}`);
      return { ok: true, value: saved };
    },

    async runReacquireDocument(request: unknown): Promise<WorkspaceOutcome<{ document_id: string }>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      const outcome = await runEditorThroughLifecycle(operation_id, request_id, "open", (admission, deps) => lifecycle.executeOpen(admission, deps));
      if (!outcome.ok) return outcome as { ok: false; rejection: WorkspaceRejection };
      const target = admissionTarget(outcome.value.admission);
      reacquireRequired.delete(target.toLowerCase());
      const settled = lifecycle.getJournal().getTerminal(operation_id);
      recordTrace("interop.editor.completed", operation_id, `reacquire ${target} after terminal epoch`);
      return { ok: true, value: Object.freeze({ document_id: settled?.document_id ?? "" }) };
    },

    cancelDocument(request: unknown): WorkspaceOutcome<{ kind: string }> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const result = lifecycle.cancelOperation({
        session_id: parsed.value.session_id,
        generation: parsed.value.generation,
        operation_id: parsed.value.operation_id,
        request_id: parsed.value.request_id,
      });
      if (!result.ok) return result as { ok: false; rejection: WorkspaceRejection };
      syncFacts();
      recordTrace("interop.cancelled", parsed.value.operation_id, `cancel settled kind=${result.value.kind} disk holds committed bytes`);
      return { ok: true, value: Object.freeze({ kind: result.value.kind }) };
    },

    async startWatcher(request: unknown): Promise<WorkspaceOutcome<{ observers: number }>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      const admitted = await coord.runTerminalOperation(terminalCapability, operation_id, request_id);
      if (!admitted.ok) return admitted as { ok: false; rejection: WorkspaceRejection };
      const prepared = await ensureRoEpoch(admitted.value.permit);
      if (!prepared.ok) {
        await coord.releaseTerminal(admitted.value.lease);
        return prepared as { ok: false; rejection: WorkspaceRejection };
      }
      roOwners.set(admitted.value.lease.leaseId, { operationId: operation_id });
      recordTrace("interop.terminal.admitted", operation_id, `background observer admitted epoch=${admitted.value.permit.epoch} observers=${roOwners.size}`);
      return { ok: true, value: Object.freeze({ observers: roOwners.size }) };
    },

    async stopWatcher(request: unknown): Promise<WorkspaceOutcome<{ observers: number }>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      const stopped = await coord.stopTerminal(terminalCapability, operation_id, request_id);
      if (!stopped.ok) return stopped as { ok: false; rejection: WorkspaceRejection };
      for (const [leaseId, owner] of [...roOwners]) {
        if (owner.operationId === operation_id) roOwners.delete(leaseId);
      }
      if (roOwners.size === 0 && epochHandle !== null && epochHandle.access === "read_only") {
        const retiring = epochHandle;
        try {
          const outcome = await terminal.retireEpoch(retiring, "watcher_stop");
          if (outcome.cleanup !== "confirmed") {
            coord.onProviderFailure(epochCapability, "watcher epoch retirement is unconfirmed");
            holdTrace("watcher epoch retirement is unconfirmed");
            return rejected("CLEANUP_UNCONFIRMED", "watcher retirement is unconfirmed: session holds with retained resources");
          }
          epochHandle = null;
          recordTrace("interop.terminal.retired", operation_id, `observer epoch retired cleanup=confirmed`);
        } catch {
          coord.onProviderFailure(epochCapability, "watcher epoch retirement failed");
          holdTrace("watcher epoch retirement failed");
          return rejected("CLEANUP_UNCONFIRMED", "watcher retirement failed: session holds with retained resources");
        }
      }
      return { ok: true, value: Object.freeze({ observers: roOwners.size }) };
    },

    async observeCommitted(request: unknown): Promise<WorkspaceOutcome<{ exit_code: number | null; stdout: string }>> {
      const parsed = InteropObserveRequestSchema.safeParse(request);
      if (!parsed.success) {
        return rejected("INVALID_REQUEST", `interop observation failed strict validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const fenced = fenceRequest(parsed.data.session_id, parsed.data.generation);
      if (fenced !== null) return { ok: false, rejection: fenced };
      if (epochHandle === null || roOwners.size === 0) {
        return rejected("INVALID_REQUEST", "no live admitted observer: observations flow only under a started watcher");
      }
      let output: EpochObservation;
      try {
        output = await terminal.readEpochFile(epochHandle, parsed.data.rel_path);
      } catch (error) {
        const code = (error as { code?: string }).code ?? "INVALID_REQUEST";
        const message = error instanceof Error ? error.message : String(error);
        return rejected(code as WorkspaceRejection["code"], `observer read failed safely: ${message.slice(0, 200)}`);
      }
      const bounded = boundObservation(output);
      if ("tooLarge" in bounded) {
        return rejected("RESOURCE_LIMIT", "observed bytes exceed the interop observation bound");
      }
      return { ok: true, value: Object.freeze({ exit_code: bounded.exit_code, stdout: bounded.stdout }) };
    },

    async terminalReadSaved(request: unknown): Promise<WorkspaceOutcome<InteropTerminalRead>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      if (lastSaved === null) {
        return rejected("INVALID_REQUEST", "no verified save precedes this terminal read: the foreground read resolves its target from the completed save only");
      }
      const admitted = await coord.runTerminalOperation(terminalCapability, operation_id, request_id);
      if (!admitted.ok) return admitted as { ok: false; rejection: WorkspaceRejection };
      recordTrace("interop.terminal.admitted", operation_id, `foreground read admitted after save journal_seq=${lastSaved.journal_seq} target=${lastSaved.portable_path}`);
      const prepared = await ensureRoEpoch(admitted.value.permit);
      if (!prepared.ok) {
        await coord.releaseTerminal(admitted.value.lease);
        return prepared as { ok: false; rejection: WorkspaceRejection };
      }
      roOwners.set(admitted.value.lease.leaseId, { operationId: `${operation_id}#fg` });
      let output: EpochObservation;
      try {
        output = await terminal.readEpochFile(prepared.value, lastSaved.portable_path);
      } catch (error) {
        await releaseRoOwner(admitted.value.lease);
        const code = (error as { code?: string }).code ?? "INVALID_REQUEST";
        const message = error instanceof Error ? error.message : String(error);
        return rejected(code as WorkspaceRejection["code"], `foreground read failed safely: ${message.slice(0, 200)}`);
      }
      const bounded = boundObservation(output);
      if ("tooLarge" in bounded) {
        await releaseRoOwner(admitted.value.lease);
        return rejected("RESOURCE_LIMIT", "terminal output exceeds the interop observation bound");
      }
      const read: InteropTerminalRead = Object.freeze({
        target: lastSaved.portable_path,
        exit_code: bounded.exit_code,
        stdout: bounded.stdout,
        stdout_bytes: Buffer.byteLength(bounded.stdout, "utf8"),
        journal_seq_before: lastSaved.journal_seq,
        trace_seq: 0,
      });
      const observed = recordTrace("interop.terminal.observed", operation_id, `foreground read ${read.target} exit=${read.exit_code} bytes=${read.stdout_bytes} after save journal_seq=${lastSaved.journal_seq}`);
      const released = await releaseRoOwner(admitted.value.lease);
      if (!released.ok) return released as { ok: false; rejection: WorkspaceRejection };
      return { ok: true, value: Object.freeze({ ...read, trace_seq: observed.seq }) };
    },

    async terminalRunSaved(request: unknown): Promise<WorkspaceOutcome<InteropTerminalRead>> {
      const parsed = parseOperation(request);
      if (!parsed.ok) return parsed;
      const { operation_id, request_id } = parsed.value;
      if (lastSaved === null) {
        return rejected("INVALID_REQUEST", "no verified save precedes this terminal run: the foreground run resolves its target from the completed save only");
      }
      if (!lastSaved.portable_path.endsWith(".js")) {
        return rejected("INVALID_REQUEST", "foreground runs execute committed workspace scripts only");
      }
      const admitted = await coord.runTerminalOperation(terminalCapability, operation_id, request_id);
      if (!admitted.ok) return admitted as { ok: false; rejection: WorkspaceRejection };
      recordTrace("interop.terminal.admitted", operation_id, `foreground run admitted after save journal_seq=${lastSaved.journal_seq} target=${lastSaved.portable_path}`);
      const prepared = await ensureRoEpoch(admitted.value.permit);
      if (!prepared.ok) {
        await coord.releaseTerminal(admitted.value.lease);
        return prepared as { ok: false; rejection: WorkspaceRejection };
      }
      roOwners.set(admitted.value.lease.leaseId, { operationId: `${operation_id}#fg` });
      let output: EpochObservation;
      try {
        output = await terminal.runEpochScript(prepared.value, lastSaved.portable_path);
      } catch (error) {
        await releaseRoOwner(admitted.value.lease);
        const code = (error as { code?: string }).code ?? "INVALID_REQUEST";
        const message = error instanceof Error ? error.message : String(error);
        return rejected(code as WorkspaceRejection["code"], `foreground run failed safely: ${message.slice(0, 200)}`);
      }
      const bounded = boundObservation(output);
      if ("tooLarge" in bounded) {
        await releaseRoOwner(admitted.value.lease);
        return rejected("RESOURCE_LIMIT", "terminal output exceeds the interop observation bound");
      }
      const read: InteropTerminalRead = Object.freeze({
        target: lastSaved.portable_path,
        exit_code: bounded.exit_code,
        stdout: bounded.stdout,
        stdout_bytes: Buffer.byteLength(bounded.stdout, "utf8"),
        journal_seq_before: lastSaved.journal_seq,
        trace_seq: 0,
      });
      const observed = recordTrace("interop.terminal.observed", operation_id, `foreground run ${read.target} exit=${read.exit_code} bytes=${read.stdout_bytes} after save journal_seq=${lastSaved.journal_seq}`);
      const released = await releaseRoOwner(admitted.value.lease);
      if (!released.ok) return released as { ok: false; rejection: WorkspaceRejection };
      return { ok: true, value: Object.freeze({ ...read, trace_seq: observed.seq }) };
    },

    async terminalModify(request: unknown): Promise<WorkspaceOutcome<{ exit_code: number | null; changed: boolean }>> {
      const parsed = InteropModifyRequestSchema.safeParse(request);
      if (!parsed.success) {
        return rejected("INVALID_REQUEST", `interop modification failed strict validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const fenced = fenceRequest(parsed.data.session_id, parsed.data.generation);
      if (fenced !== null) return { ok: false, rejection: fenced };
      const { operation_id, request_id, rel_path, content } = parsed.data;
      syncFacts();
      const admitted = await coord.runTerminalOperation(terminalCapability, operation_id, request_id);
      if (!admitted.ok) return admitted as { ok: false; rejection: WorkspaceRejection };
      if (admitted.value.access !== "read_write") {
        await coord.releaseTerminal(admitted.value.lease);
        return rejected("NOT_AUTHORIZED", "modification requires a reviewed read-write operation");
      }
      recordTrace("interop.terminal.admitted", operation_id, `write epoch admitted epoch=${admitted.value.permit.epoch} target=${rel_path}`);
      let handle: EpochHandleLike;
      try {
        handle = await terminal.prepareEpoch({
          sessionId: admitted.value.permit.session_id,
          generation: admitted.value.permit.generation,
          epoch: admitted.value.permit.epoch,
          access: "read_write",
          leafHostPath: config.leafHostPath,
          leaseId: admitted.value.permit.lease_id,
          policyDigest: admitted.value.permit.policy_digest,
          containerName: nextContainerName("rw"),
          testRunId: config.testRunId,
        });
      } catch (error) {
        await coord.releaseTerminal(admitted.value.lease).catch(() => null);
        const message = error instanceof Error ? error.message : String(error);
        return rejected("INVALID_REQUEST", `write epoch preparation failed safely: ${message.slice(0, 200)}`);
      }
      epochHandle = handle;
      let output: EpochObservation;
      try {
        output = await terminal.attemptEpochWrite(handle, rel_path, content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string }).code ?? "INVALID_REQUEST";
        await coord.releaseTerminal(admitted.value.lease);
        epochHandle = null;
        return rejected(code as WorkspaceRejection["code"], `terminal modification failed safely: ${message.slice(0, 200)}`);
      }
      const changed = output.exitCode === 0;
      recordTrace("interop.terminal.observed", operation_id, `terminal wrote ${rel_path} exit=${output.exitCode} bytes=${content.length}`);
      const released = await coord.releaseTerminal(admitted.value.lease);
      epochHandle = null;
      if (!released.ok) {
        holdTrace(`write retirement is unconfirmed (${outcomeCode(released)})`);
        return released as { ok: false; rejection: WorkspaceRejection };
      }
      recordTrace("interop.terminal.retired", operation_id, `write epoch retired cleanup=confirmed ownership=${released.value.ownership} epoch=${released.value.epoch}`);
      const loaded = editorSnapshotDocuments(lifecycle.getSession());
      for (const entry of loaded) {
        reacquireRequired.add(entry.portable_path.toLowerCase());
      }
      // The pre-write save record is stale once the guest owns the bytes:
      // the next foreground read/run resolves only from a fresh verified
      // save, never from a pre-write journal sequence.
      lastSaved = null;
      recordTrace("interop.files.invalidated", operation_id, `documents require explicit open after write epoch: ${loaded.length} loaded`);
      syncFacts();
      return { ok: true, value: Object.freeze({ exit_code: output.exitCode, changed }) };
    },

    async resetSession(request: unknown): Promise<WorkspaceOutcome<InteropDescriptor>> {
      const parsed = InteropLifecycleRequestSchema.safeParse(request);
      if (!parsed.success) {
        return rejected("INVALID_REQUEST", `interop reset failed strict validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const live = liveDescriptor();
      if (closed) return rejected("INVALID_TRANSITION", "interop session is closed: reset cannot reopen it");
      if (parsed.data.session_id !== live.sessionId) return rejected("WRONG_OWNER", "interop reset names a foreign session");
      if (parsed.data.generation !== live.generation) return rejected("STALE_SESSION", "interop reset carries a stale session generation");
      resetting = true;
      try {
        try {
          await lifecycle.close({ session_id: live.sessionId, generation: live.generation, request_id: `${parsed.data.request_id}-ed` });
        } catch {
          // Editor close is best-effort; the coordinator barrier below still runs.
        }
        const outcome = await coord.resetCombinedSession(
          { sessionId: live.sessionId, generation: live.generation, workspaceId: live.workspaceId, workspaceRevision: live.workspaceRevision, ownership: live.ownership, epoch: live.epoch, epochAccess: live.epochAccess },
          parsed.data.request_id,
        );
        if (!outcome.ok) {
          resetting = false;
          holdTrace(`reset barrier failed (${outcomeCode(outcome)})`);
          return outcome as { ok: false; rejection: WorkspaceRejection };
        }
        epochHandle = null;
        roOwners.clear();
        reacquireRequired.clear();
        lastSaved = null;
        try {
          config.prepareLeaf(config.seedFiles);
        } catch {
          resetting = false;
          holdTrace("reset reseed failed");
          return rejected("CLEANUP_UNCONFIRMED", "reset reseed failed: session holds without a new generation");
        }
        const rebound = config.bindAdapter({
          sessionId: outcome.value.descriptor.sessionId,
          generation: outcome.value.descriptor.generation,
          workspaceId: outcome.value.descriptor.workspaceId,
        });
        if (!rebound.ok) {
          resetting = false;
          holdTrace("reset adapter rebind failed");
          return rejected("CLEANUP_UNCONFIRMED", "reset adapter rebind failed: session holds without a new generation");
        }
        adapter = rebound.adapter;
        editorCapability = outcome.value.editorCapability;
        terminalCapability = outcome.value.terminalCapability;
        epochCapability = outcome.value.epochCapability;
        lifecycle = createEditorLifecycle({
          catalog: catalogOutcome.value,
          seedManifest: config.seedManifest,
          sessionId: outcome.value.descriptor.sessionId,
          generation: outcome.value.descriptor.generation,
          reviewed: true,
          wiring: {
            getOwnership: () => coord.describe().ownership,
            getEpoch: () => coord.describe().epoch,
          },
        });
        syncFacts();
        resetting = false;
        recordTrace("interop.reset.completed", null, `reset exposed generation=${outcome.value.descriptor.generation} ownership=${outcome.value.descriptor.ownership}`);
        return { ok: true, value: interop.describe() };
      } catch {
        resetting = false;
        holdTrace("reset failed unexpectedly");
        return rejected("CLEANUP_UNCONFIRMED", "interop reset failed safely with retained resources");
      }
    },

    async closeSession(request: unknown): Promise<WorkspaceOutcome<null>> {
      const parsed = InteropLifecycleRequestSchema.safeParse(request);
      if (!parsed.success) {
        return rejected("INVALID_REQUEST", `interop close failed strict validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const live = liveDescriptor();
      if (parsed.data.session_id !== live.sessionId) return rejected("WRONG_OWNER", "interop close names a foreign session");
      if (parsed.data.generation !== live.generation) return rejected("STALE_SESSION", "interop close carries a stale session generation");
      if (closed) return { ok: true, value: null };
      try {
        try {
          await lifecycle.close({ session_id: live.sessionId, generation: live.generation, request_id: `${parsed.data.request_id}-ed` });
        } catch {
          // Editor close is best-effort; the coordinator barrier still runs.
        }
        const outcome = await coord.closeCombinedSession(
          { sessionId: live.sessionId, generation: live.generation, workspaceId: live.workspaceId, workspaceRevision: live.workspaceRevision, ownership: live.ownership, epoch: live.epoch, epochAccess: live.epochAccess },
          parsed.data.request_id,
        );
        epochHandle = null;
        roOwners.clear();
        reacquireRequired.clear();
        closed = true;
        if (!outcome.ok) {
          holdTrace(`close barrier failed (${outcomeCode(outcome)})`);
          return outcome as { ok: false; rejection: WorkspaceRejection };
        }
        recordTrace("interop.close.completed", null, `close retired editor and terminal domains`);
        return { ok: true, value: null };
      } catch {
        closed = true;
        epochHandle = null;
        roOwners.clear();
        reacquireRequired.clear();
        holdTrace("close failed unexpectedly");
        return rejected("CLEANUP_UNCONFIRMED", "interop close failed safely with retained resources");
      }
    },

    sharedTrace(afterSeq = 0): readonly InteropTraceEvent[] {
      return Object.freeze(trace.filter((event) => event.seq > afterSeq).map((event) => event));
    },

    editorEvents(afterSeq = 0): readonly EditorSaveEvent[] {
      return lifecycle.getJournal().listEvents(afterSeq);
    },

    workspaceEvents(): readonly { seq: number; type: string }[] {
      return Object.freeze(coord.listEvents().map((event) => ({ seq: event.seq, type: event.type })));
    },
  };

  syncFacts();
  return { ok: true, value: interop };
}
