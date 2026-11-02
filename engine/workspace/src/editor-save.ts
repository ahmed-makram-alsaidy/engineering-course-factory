// P6.10 admitted document save — commit boundary, byte verify, bounded canonical events.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 4 (trust boundary:
// validated IR -> main-only reviewed catalog -> editor admission -> immutable
// semantic plan -> trusted working document -> bounded visual projection ->
// explicit safe persistence -> byte verification -> terminal result/journal),
// 5 (editor authority: main owns per-file working text, revision, committed
// disk hash/existence, dirty status), 6 (workspace/file authority: disk D is
// committed truth, main B is authoritative unsaved document; dirty means B
// differs from D or pending creation), 7 (operation model and admission:
// operation_id := step_id; only the five types; one attempt per operation
// with tombstones; authored editor order), 10 (file_open/file_create/
// file_save document rules: save persists the main working buffer never
// Monaco text; clean save verifies without rewriting; dirty save checks
// baseline existence/hash and path identity, stages complete UTF-8 bytes
// privately same filesystem, flushes, publishes no-clobber creation or
// guarded replacement, reopens and verifies exact bytes/length/hash; the
// replacement publication is the commit point; before it failure removes
// staging retains D0/B; after it verification failure reports
// COMMIT_UNCERTAIN freezes retains evidence never rollback; mark clean only
// after verification; save completion is barrier before following terminal
// run), 12 (strict LF profile), 13 (cancel before commit restores B0/V one
// cancelled D unchanged; cancel after type/replace already-final; for save
// serialize cancel with commit before abort after finish verification never
// cancelled-with-hidden-write; reset revokes awaits save settlement), 14
// (journal and events: new versioned editor event union separate from P5 v1;
// main assigns monotonic editor seq; common session/generation/operation/
// attempt/provenance plus compiled/policy digests correlate; exactly one
// final per accepted attempt; completed includes revision before/after
// hashes dirty disk effect none/created/saved/unchanged; no full source or
// host paths; visual chunks transient max 10/sec no per-char; pages 256
// events/256KiB retention 4MiB then gap plus snapshot never fabricated;
// journal failure before side effect blocks after commit uncertain; P5
// journal unchanged redaction-before-storage), 17 (portable path rules), 18
// (resource bounds: 1MiB IR/file/result 16MiB working 256 documents 10000
// operations), 21 (admission errors zero side effects; planning errors
// preserve B/D; SAVE_FAILED before commit retains dirty B unchanged D;
// COMMIT_UNCERTAIN after publication requires reset never next action;
// CLEANUP_UNCONFIRMED holds), 26.1 (exclusive writer epochs: EDITOR_OWNED
// adapter-only writer with verified RO watcher coexistence;
// TERMINAL_OWNED RW-only no host access; TRANSITION/RESETTING/CLOSING/HOLD
// no authored writer), 26.4 (ownership table: save active RO watchers
// continue terminal starts wait other editor serialize; dirty buffers deny
// RW; RW request waits for running save), 26.5 (file generations: ledger
// key session generation portable_path; seed revision 0; each verified save
// increments file and workspace revision once; buffer stores base disk
// revision/digest/existence plus independent buffer revision), 26.6 (host
// file backend: narrow main-only adapter readDocument publishDocument
// scanAfterWriter seedFreshLeaf removeOwnedLeaf), 26.7 (exact save
// algorithm steps 1-7 and watcher visibility: reserve under coordinator
// require EDITOR_OWNED live revision no foreground; resolve authored path
// open/validate stable handles compare expected preimage; encode immutable
// main buffer exact UTF-8 LF private CREATE_NEW staging same NTFS volume
// never renderer name never guest tree write verify flush; recheck
// revocation revision identity publish SetFileInformationByHandle
// ReplaceIfExists FALSE create TRUE replace same-volume rename complete
// file never truncate/delete-copy; rename is commit point; reopen validate
// byte-compare flush; sharing before rename SAVE_FAILED unchanged
// verification after rename COMMIT_UNCERTAIN freeze never rollback; no-op
// save verifies returns unchanged no rename/revision; cancel/reset
// linearize step 4 revocation wins abort stage prior state publication wins
// settle verification/journal old generation; watcher old fd completes old
// bytes reopen sees new complete once bind propagates no partial typing),
// 26.8 (lifecycle interfaces: save serializes waits RO foreground/save RO
// watchers continue), 26.9 (provider epochs journal continuity), 26.10
// (reset barrier), 26.12 (proofs: RO watcher plus save same container/PID
// saves inspect RW false guest deny host succeed; writer exclusion; dirty
// plus RO read; external modifications; atomic publication large repeated
// only complete old/new no missing create no-clobber staging never visible;
// save failures disk full sharing flush/rename/readback/journal cancel no
// false completion COMMIT_UNCERTAIN blocks next; reset/close races; stale
// identifiers; link attacks; hostile renderer; watch visibility polling
// reopen 250ms bounded 5s; replay/UI fresh seed exact actions byte goldens;
// cleanup/regression) with
// docs/adr/ADR-0011-shared-workspace-ownership.md decisions 5 (main owns
// unsaved disk owns committed) and 6 (Windows adapter narrow publication).
//
// Canonical P6.10 name: P6.10 Save and journal.
// Objective: commit boundary, byte verify, bounded canonical events.
// PASS gate: injected failure matrix, exactly-one outcome.
//
// THE CENTRAL SEMANTIC PROPERTIES (proven by the P6.10 suite, not by types):
//   1. Save authority derives ONLY from reviewed Compiled IR through P6.6
//      admission through current live document authority through current
//      coordinator editor-write authority. The renderer supplies identifiers
//      only. There is deliberately no saveByPath/path-contents-bytes-digest
//      revision-destination-overwrite-staging-root-access production path:
//      the executor takes the live EditorSession handle plus the frozen
//      file_save admission only, and every semantic value (logical path,
//      buffer bytes, expected preimage, mode) resolves from trusted state.
//   2. The bytes persisted come ONLY from the current trusted main-owned
//      document buffer (registry getBufferContent). Monaco/IPC/clipboard/
//      disk/terminal text is never read.
//   3. The disk preimage is guarded: for opened existing documents the save
//      binds the exact committed revision/digest the buffer originated from
//      and rejects before publication when the live disk drifted
//      (EXTERNAL_MODIFICATION_CONFLICT zero clobber buffer preserved not
//      clean never rebase/merge/last-write-wins). For pending creations the
//      disk is expected absent and an appearing target fails closed
//      (FILE_EXISTS never overwrite).
//   4. Publication reuses the P6.4 trusted WindowsFileAdapter as the sole
//      physical primitive. No second write implementation exists here (the
//      staging/rename/flush/verify security logic is never duplicated).
//   5. The adapter rename is the irreversible commit point. Before it every
//      failure/cancel/reset/close leaves the destination unchanged with
//      staging cleaned and the document dirty/pending. After it verification
//      uncertainty reports COMMIT_UNCERTAIN fail-closed never ordinary
//      SAVE_FAILED never false clean never blind retry never silent
//      rollback.
//   6. Byte verification is required: actual disk bytes must equal intended
//      main-owned buffer bytes. OS rename success alone never marks clean.
//   7. Dirty becomes clean ONLY after atomic publication plus byte
//      verification plus still-live/current plus journal completion. Clean
//      saves verify and return unchanged with no rename/revision increment.
//   8. Journal is the one canonical bounded editor journal owned here (no
//      second editor journal anywhere): monotonic editor seq, exact design
//      event names, bounded metadata only (logical IDs revisions digests
//      codes effects lengths flags), no source text no host/staging paths
//      no container/PID no secrets, deterministic started then optional
//      committed then exactly-one terminal ordering, terminal never before
//      verification, replay reconstructs without second commit, duplicates
//      converge, races finish-once.
// Owned scope (and only this):
//   - executeAdmittedFileSave: admission-bound guarded save through the
//     trusted adapter with preimage fencing, mode selection (create vs
//     replace from document state), clean no-op verification, revision
//     update via the registry save-commit seam, dirty-to-clean only after
//     verification, external-conflict flagging, COMMIT_UNCERTAIN
//     fail-closed, cancel/reset/close/revocation linearization, exactly-one
//     result per admitted attempt with idempotent replay and per-executor
//     single-transaction serialization.
//   - createEditorSaveJournal plus createFileSaveExecutor: the one bounded
//     canonical journal (started/committed/completed/failed/cancelled with
//     the exact design names) with monotonic seq, 256-event/256KiB pages,
//     finish-once terminal per operation, bounded snapshots, replay without
//     mutation, journal-failure injection (before blocks after uncertain).
// Explicit non-scope (owned by later tasks, represented here only as
// fail-closed rejections or not at all):
//   - P6.8 type geometry beyond reading the authoritative buffer (no
//     planning/scheduling/pacing/cursor work here);
//   - P6.9 occurrence matching beyond reading the authoritative buffer;
//   - P6.11 cancel/reset/replay beyond the save-transaction linearization
//     (no animation, no full lifecycle integration, no checkpoint);
//   - P6.12 IPC/preload/Monaco wiring (no new channels; results are
//     main-held renderer-safe by shape);
//   - P6.13 terminal interop beyond the unchanged buffer-facts seam plus
//     the RO-watcher coexistence proof (no RW execution here);
//   - P6.15 visual proof (no screenshots, no Electron launch here).
//     No browser automation, no recording, no Unreal, no node-pty.
// Purity: this module imports only zod (DTO validation), node:crypto
// (digest binding) and relative workspace modules. No filesystem, no
// processes, no containers, no timers, no wall-clock reads, no browser or
// presentation machinery. All disk truth arrives through the injected
// WindowsFileAdapter handle. All races fence through explicit revalidation
// of live session state plus the deterministic isCancelled/revalidate
// seams, never through sleeps.
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
import { isLiveAdmissionDocument } from "./editor-admission.ts";
import { canonicalDocumentKey } from "./editor-documents.ts";
import type { AdapterAuthority, WindowsFileAdapter } from "./file-adapter.ts";
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
/** Save executor protocol version (matches the workspace protocol). */
export const EDITOR_SAVE_VERSION = 1;
/** Bounded canonical save journal: at most 256 events (matches coordinator/philosophy). */
export const SAVE_JOURNAL_MAX_EVENTS = 256;
/** Bounded canonical save journal: at most 256 KiB of event JSON. */
export const SAVE_JOURNAL_MAX_BYTES = 262144;
/** Bounded diagnostic message inside journal events (safe operation messages only). */
export const SAVE_JOURNAL_MAX_MESSAGE_CHARS = 512;
/** Canonical disk effects for save outcomes (design completed effects plus fail-closed markers). */
export const SaveDiskEffectSchema = z.enum(["none", "created", "saved", "unchanged", "unknown"]);
export type SaveDiskEffect = z.infer<typeof SaveDiskEffectSchema>;
/** Exact canonical editor event names owned by P6.10 (design section 14 subset). */
export const EditorSaveEventKindSchema = z.enum([
  "editor.operation.started",
  "editor.disk.committed",
  "editor.operation.completed",
  "editor.operation.failed",
  "editor.operation.cancelled",
]);
export type EditorSaveEventKind = z.infer<typeof EditorSaveEventKindSchema>;
/** Strict schema for one bounded canonical save journal event. */
export const EditorSaveEventSchema = z.strictObject({
  kind: EditorSaveEventKindSchema,
  seq: z.number().int().min(1),
  session_id: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  operation_id: z.string().min(1).max(128),
  attempt_id: z.string().min(1).max(128),
  document_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  portable_path: z.string().min(1).max(256),
  lesson_compiled_digest: z.string().regex(/^[0-9a-f]{64}$/),
  base_disk_revision: z.number().int().min(0),
  base_digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  new_disk_revision: z.number().int().min(0).nullable(),
  new_digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  before_digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  after_digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  observed_digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  file_identity: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).nullable(),
  byte_length: z.number().int().min(0).nullable(),
  dirty: z.boolean().nullable(),
  disk_effect: SaveDiskEffectSchema.nullable(),
  code: z.string().min(1).max(64).nullable(),
  message: z.string().max(1024).nullable(),
});
export type EditorSaveEvent = z.infer<typeof EditorSaveEventSchema>;
function sha256HexText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
/** Strip host-absolute/staging/container secrets from diagnostics before storage (redaction-before-storage). */
export function sanitizeSaveMessage(message: string): string {
  let out = message;
  out = out.replace(/[A-Za-z]:[\\/][^\s\"']*/g, "[path]");
  out = out.replace(/\/[^\s\"']*cf-p64-stage-[^\s\"']*/g, "[staging]");
  out = out.replace(/cf-p64-stage-[A-Za-z0-9._-]+/g, "[staging]");
  out = out.replace(/\/workspace[^\s\"']*/g, "[workspace]");
  out = out.replace(/\b[0-9a-f]{64}\b/gi, (m) => m.slice(0, 12) + "…");
  if (out.length > SAVE_JOURNAL_MAX_MESSAGE_CHARS) out = out.slice(0, SAVE_JOURNAL_MAX_MESSAGE_CHARS);
  return out;
}
/** Main-owned bounded canonical save journal: the ONE editor journal (no second journal anywhere). */
export interface EditorSaveJournal {
  readonly version: 1;
  append(event: Omit<EditorSaveEvent, "seq">): WorkspaceOutcome<EditorSaveEvent>;
  listEvents(afterSeq?: number): readonly EditorSaveEvent[];
  snapshot(afterSeq: number): { events: readonly EditorSaveEvent[]; page_end_seq: number; journal_high_seq: number; reset: boolean };
  getTerminal(operationId: string): EditorSaveEvent | null;
  terminalCount(): number;
  eventCount(): number;
  byteCount(): number;
  failNextAppendBeforeCommit(): void;
  failNextAppendAfterCommit(): void;
  clearFaults(): void;
}
/** Create the one canonical bounded save journal for a session generation scope. */
export function createEditorSaveJournal(): EditorSaveJournal {
  const events: EditorSaveEvent[] = [];
  let seq = 0;
  let bytes = 0;
  const terminalByOperation = new Map<string, EditorSaveEvent>();
  let failBefore = false;
  let failAfter = false;
  let afterCommitArmed = false;
  function append(event: Omit<EditorSaveEvent, "seq">): WorkspaceOutcome<EditorSaveEvent> {
    const isTerminal = event.kind === "editor.operation.completed" || event.kind === "editor.operation.failed" || event.kind === "editor.operation.cancelled";
    const isStarted = event.kind === "editor.operation.started";
    if (failBefore && isStarted) {
      failBefore = false;
      return rejected("SAVE_FAILED", "journal append failed before commit: publication blocked with destination unchanged");
    }
    if (failAfter && (afterCommitArmed || isTerminal || event.kind === "editor.disk.committed")) {
      failAfter = false;
      afterCommitArmed = false;
      return rejected("COMMIT_UNCERTAIN", "journal append failed after commit: outcome uncertain with evidence retained");
    }
    if (isTerminal) {
      const existing = terminalByOperation.get(event.operation_id);
      if (existing !== undefined) {
        return { ok: true, value: existing };
      }
    }
    if (events.length >= SAVE_JOURNAL_MAX_EVENTS) {
      return rejected("RESOURCE_LIMIT", "save journal is bounded to 256 events: explicit reset is required");
    }
    const candidate = { ...event, seq: seq + 1 } as EditorSaveEvent;
    const checked = EditorSaveEventSchema.safeParse(candidate);
    if (!checked.success) {
      return rejected("INVALID_REQUEST", "internal: issued save event failed strict validation");
    }
    const size = Buffer.byteLength(JSON.stringify(checked.data), "utf8");
    if (bytes + size > SAVE_JOURNAL_MAX_BYTES) {
      return rejected("RESOURCE_LIMIT", "save journal is bounded to 256 KiB: explicit reset is required");
    }
    seq += 1;
    bytes += size;
    const frozen = deepFreeze(checked.data);
    events.push(frozen);
    if (isTerminal) terminalByOperation.set(event.operation_id, frozen);
    if (event.kind === "editor.disk.committed") afterCommitArmed = true;
    if (isTerminal) afterCommitArmed = false;
    return { ok: true, value: frozen };
  }
  return {
    version: 1,
    append,
    listEvents(afterSeq = 0): readonly EditorSaveEvent[] {
      return Object.freeze(events.filter((e) => e.seq > afterSeq).map((e) => e));
    },
    snapshot(afterSeq: number): { events: readonly EditorSaveEvent[]; page_end_seq: number; journal_high_seq: number; reset: boolean } {
      if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new TypeError("after_seq must be a non-negative integer");
      const reset = afterSeq > seq;
      if (reset) return { events: Object.freeze([]), page_end_seq: seq, journal_high_seq: seq, reset: true };
      const page: EditorSaveEvent[] = [];
      let pageBytes = 0;
      let pageEnd = afterSeq;
      for (const e of events) {
        if (e.seq <= afterSeq) continue;
        const size = Buffer.byteLength(JSON.stringify(e), "utf8");
        if (page.length > 0 && (page.length >= 256 || pageBytes + size > 262144)) break;
        page.push(e);
        pageBytes += size;
        pageEnd = e.seq;
        if (page.length >= 256 || pageBytes >= 262144) break;
      }
      return { events: Object.freeze(page), page_end_seq: pageEnd, journal_high_seq: seq, reset: false };
    },
    getTerminal(operationId: string): EditorSaveEvent | null {
      return terminalByOperation.get(operationId) ?? null;
    },
    terminalCount(): number {
      return terminalByOperation.size;
    },
    eventCount(): number {
      return events.length;
    },
    byteCount(): number {
      return bytes;
    },
    failNextAppendBeforeCommit(): void {
      failBefore = true;
    },
    failNextAppendAfterCommit(): void {
      failAfter = true;
      afterCommitArmed = false;
    },
    clearFaults(): void {
      failBefore = false;
      failAfter = false;
      afterCommitArmed = false;
    },
  };
}
/** Main-held executed-save result (logical identifiers and digests only). */
export interface ExecutedFileSave {
  readonly documentId: string;
  readonly portable_path: string;
  readonly content: string;
  readonly disk_revision: number;
  readonly disk_digest: string | null;
  readonly file_identity: string | null;
  readonly disk_effect: SaveDiskEffect;
  readonly dirty: boolean;
  readonly journal_seq: number;
}
/** Deterministic injection seams for the save transaction (no wall-clock, no sleeps). */
export interface SaveExecutionDeps {
  readonly adapter: WindowsFileAdapter;
  readonly authority: AdapterAuthority;
  readonly revalidate?: () => AdapterAuthority;
  readonly isCancelled?: () => boolean;
  readonly failJournalBeforeCommit?: boolean;
  readonly failJournalAfterCommit?: boolean;
}
/** Main-owned save executor: single-transaction serialization plus idempotent replay. */
export interface FileSaveExecutor {
  execute(session: EditorSession, admission: EditorOperationAdmission, deps: SaveExecutionDeps): Promise<WorkspaceOutcome<ExecutedFileSave>>;
  getJournal(): EditorSaveJournal;
  listEvents(afterSeq?: number): readonly EditorSaveEvent[];
  getTerminal(operationId: string): EditorSaveEvent | null;
  invalidateAll(): void;
}
function ownershipRejection(ownership: WorkspaceOwnership): WorkspaceRejection {
  if (ownership === "TERMINAL_OWNED") {
    return { code: "WORKSPACE_BUSY", message: "terminal read-write owns the leaf: no host file access" };
  }
  return { code: "INVALID_TRANSITION", message: `host file access is barred while ${ownership}` };
}
function checkExecutionAuthority(session: EditorSession, authority: AdapterAuthority): { ok: true } | { ok: false; rejection: WorkspaceRejection } {
  if (authority.lease.sessionId !== session.sessionId) {
    return rejected("WRONG_OWNER", "editor lease names a different session than the admission session");
  }
  if (authority.lease.generation !== session.generation) {
    return rejected("STALE_SESSION", "editor lease carries a stale session generation");
  }
  if (authority.lease.epoch !== authority.liveEpoch) {
    return rejected("STALE_EPOCH", "editor lease carries a stale container epoch");
  }
  if (authority.revokedLeaseIds.includes(authority.lease.leaseId)) {
    return rejected("WORKSPACE_REVOKED", "editor lease was revoked");
  }
  if (authority.ownership !== "EDITOR_OWNED") {
    return { ok: false, rejection: ownershipRejection(authority.ownership) };
  }
  return { ok: true };
}
function checkAdmissionBinding(session: EditorSession, admission: EditorOperationAdmission): { ok: true } | { ok: false; rejection: WorkspaceRejection } {
  if (admission === null || typeof admission !== "object") {
    return rejected("INVALID_REQUEST", "execution requires a P6.6 admission record, never a raw path");
  }
  const record = (admission as EditorOperationAdmission).record;
  const parameters = (admission as EditorOperationAdmission).parameters;
  const document = (admission as EditorOperationAdmission).document;
  if (record === null || typeof record !== "object" || parameters === null || typeof parameters !== "object") {
    return rejected("INVALID_REQUEST", "execution requires a P6.6 admission record, never a raw path");
  }
  if (record.session_id !== session.sessionId) {
    return rejected("WRONG_OWNER", "admission names a foreign session");
  }
  if (record.generation !== session.generation) {
    return rejected("STALE_SESSION", "admission carries a stale session generation");
  }
  if (session.registry.retired) {
    return rejected("STALE_SESSION", "editor session was reset or closed: old admissions cannot execute");
  }
  if (!isLiveAdmissionDocument(session, document)) {
    return rejected("STALE_SESSION", "admission document is not live in this generation");
  }
  return { ok: true };
}
function revalidateAfterAwait(session: EditorSession, admission: EditorOperationAdmission, deps: SaveExecutionDeps): { ok: true; authority: AdapterAuthority } | { ok: false; rejection: WorkspaceRejection } {
  if (session.registry.retired) {
    return rejected("STALE_SESSION", "editor session was reset or closed while the save was in flight: late completion fenced");
  }
  if (!isLiveAdmissionDocument(session, admission.document)) {
    return rejected("STALE_SESSION", "admission document is no longer live in this generation: late completion fenced");
  }
  let live = deps.authority;
  if (deps.revalidate !== undefined) {
    try {
      live = deps.revalidate();
    } catch {
      return rejected("WORKSPACE_REVOKED", "execution fence could not be revalidated after the await; late completion fenced");
    }
  }
  if (live.lease.sessionId !== session.sessionId) {
    return rejected("STALE_SESSION", "execution fence names a retired session identity");
  }
  if (live.lease.generation !== session.generation) {
    return rejected("STALE_SESSION", "execution fence carries a stale session generation");
  }
  if (live.lease.epoch !== live.liveEpoch) {
    return rejected("STALE_EPOCH", "execution fence carries a stale container epoch");
  }
  if (live.revokedLeaseIds.includes(live.lease.leaseId)) {
    return rejected("WORKSPACE_REVOKED", "editor lease was revoked while the save was in flight");
  }
  if (live.ownership !== "EDITOR_OWNED") {
    return { ok: false, rejection: ownershipRejection(live.ownership) };
  }
  return { ok: true, authority: live };
}
/** Create the main-owned save executor for one generation scope (single-transaction, idempotent). */
export function createFileSaveExecutor(options: { journal?: EditorSaveJournal } = {}): FileSaveExecutor {
  const journal = options.journal ?? createEditorSaveJournal();
  let active: { operationId: string; canonicalKey: string } | null = null;
  const completed = new Map<string, WorkspaceOutcome<ExecutedFileSave>>();
  let invalidated = false;
  function scopeKey(session: EditorSession, operationId: string): string {
    return `${session.sessionId}|${session.generation}|${operationId}`;
  }
  async function execute(session: EditorSession, admission: EditorOperationAdmission, deps: SaveExecutionDeps): Promise<WorkspaceOutcome<ExecutedFileSave>> {
    if (invalidated) {
      return rejected("STALE_SESSION", "save executor was invalidated by reset or close");
    }
    if (deps.failJournalBeforeCommit === true) journal.failNextAppendBeforeCommit();
    if (deps.failJournalAfterCommit === true) journal.failNextAppendAfterCommit();
    const binding = checkAdmissionBinding(session, admission);
    if (!binding.ok) return binding;
    if (admission.record.action_type !== "file_save") {
      return rejected("INVALID_REQUEST", "save executor runs file_save admissions only: later editor semantics stay deferred");
    }
    if (deps === null || typeof deps !== "object" || deps.adapter === null || typeof deps.adapter !== "object") {
      return rejected("INVALID_REQUEST", "save execution requires the trusted file adapter handle");
    }
    const key = scopeKey(session, admission.record.operation_id);
    const cached = completed.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const journalReplay = journal.getTerminal(admission.record.operation_id);
    if (journalReplay !== null) {
      const replayed = replayFromJournal(session, admission, journalReplay);
      if (replayed !== null) {
        completed.set(key, replayed);
        return replayed;
      }
    }
    if (active !== null) {
      return rejected("WORKSPACE_BUSY", "another save is already active: editor work serializes deterministically");
    }
    const resolved = session.registry.resolveDocument(admission.document.document_id);
    if (!resolved.ok) return resolved as { ok: false; rejection: WorkspaceRejection };
    const liveDescriptor = resolved.value;
    const canonicalKey = canonicalDocumentKey(liveDescriptor.portable_path);
    active = { operationId: admission.record.operation_id, canonicalKey };
    let settled = false;
    let terminal: WorkspaceOutcome<ExecutedFileSave> | null = null;
    const finishOnce = (outcome: WorkspaceOutcome<ExecutedFileSave>): WorkspaceOutcome<ExecutedFileSave> => {
      if (settled) return terminal as WorkspaceOutcome<ExecutedFileSave>;
      settled = true;
      terminal = outcome;
      completed.set(key, outcome);
      active = null;
      return outcome;
    };
    const failOnce = async (code: WorkspaceRejection["code"], message: string, extra: Partial<EditorSaveEvent> = {}): Promise<WorkspaceOutcome<ExecutedFileSave>> => {
      const safe = sanitizeSaveMessage(message);
      const buffered = session.registry.hasBufferContent(liveDescriptor.document_id) ? session.registry.getBufferContent(liveDescriptor.document_id) : null;
      void buffered;
      const current = session.registry.resolveDocument(admission.document.document_id);
      const beforeDigest = current.ok ? current.value.base_digest : liveDescriptor.base_digest;
      const beforeRevision = current.ok ? current.value.base_disk_revision : liveDescriptor.base_disk_revision;
      const failedEvent: Omit<EditorSaveEvent, "seq"> = {
        kind: "editor.operation.failed",
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: admission.record.operation_id,
        attempt_id: admission.record.attempt_id,
        document_id: liveDescriptor.document_id,
        portable_path: liveDescriptor.portable_path,
        lesson_compiled_digest: admission.record.lesson_compiled_digest,
        base_disk_revision: beforeRevision,
        base_digest: beforeDigest,
        new_disk_revision: null,
        new_digest: null,
        before_digest: beforeDigest,
        after_digest: null,
        observed_digest: (extra.observed_digest as string | null) ?? null,
        file_identity: null,
        byte_length: null,
        dirty: true,
        disk_effect: code === "COMMIT_UNCERTAIN" ? "unknown" : "none",
        code,
        message: safe,
      };
      const appended = journal.append(failedEvent);
      if (!appended.ok && appended.rejection.code === "COMMIT_UNCERTAIN") {
        const uncertain: WorkspaceOutcome<ExecutedFileSave> = { ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: "journal finalization failed after commit: outcome uncertain with evidence retained" } };
        try {
          session.registry.noteExternalChange(liveDescriptor.portable_path, beforeDigest);
        } catch { /* flagging is best-effort fail-closed */ }
        return finishOnce(uncertain);
      }
      void appended;
      return finishOnce({ ok: false, rejection: { code, message } });
    };
    try {
      if (deps.isCancelled?.() === true) {
        const cancelled = await cancelOnce(session, admission, liveDescriptor, journal, key, completed);
        active = null;
        if (cancelled !== null) {
          settled = true;
          terminal = cancelled;
          return cancelled;
        }
        return finishOnce(rejected("WORKSPACE_REVOKED", "save was cancelled before commit: staging discarded with destination unchanged") as { ok: false; rejection: WorkspaceRejection });
      }
      const fence = checkExecutionAuthority(session, deps.authority);
      if (!fence.ok) {
        const code = fence.rejection.code;
        const msg = fence.rejection.message;
        active = null;
        const startedProbe = journal.append({
          kind: "editor.operation.started",
          session_id: session.sessionId,
          generation: session.generation,
          operation_id: admission.record.operation_id,
          attempt_id: admission.record.attempt_id,
          document_id: liveDescriptor.document_id,
          portable_path: liveDescriptor.portable_path,
          lesson_compiled_digest: admission.record.lesson_compiled_digest,
          base_disk_revision: liveDescriptor.base_disk_revision,
          base_digest: liveDescriptor.base_digest,
          new_disk_revision: null,
          new_digest: null,
          before_digest: liveDescriptor.base_digest,
          after_digest: null,
          observed_digest: null,
          file_identity: null,
          byte_length: null,
          dirty: liveDescriptor.dirty,
          disk_effect: null,
          code: null,
          message: null,
        });
        void startedProbe;
        return finishOnce({ ok: false, rejection: { code, message: msg } });
      }
      const buffered = session.registry.getBufferContent(liveDescriptor.document_id);
      if (!buffered.ok) {
        active = null;
        if (buffered.rejection.code === "STALE_SESSION") return finishOnce(buffered as { ok: false; rejection: WorkspaceRejection });
        return finishOnce(rejected("FILE_NOT_FOUND", "save target has no executed buffer: open or create it through the admitted execution path first"));
      }
      const bufferText = buffered.value;
      const bufferDigest = sha256HexText(bufferText);
      const started = journal.append({
        kind: "editor.operation.started",
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: admission.record.operation_id,
        attempt_id: admission.record.attempt_id,
        document_id: liveDescriptor.document_id,
        portable_path: liveDescriptor.portable_path,
        lesson_compiled_digest: admission.record.lesson_compiled_digest,
        base_disk_revision: liveDescriptor.base_disk_revision,
        base_digest: liveDescriptor.base_digest,
        new_disk_revision: null,
        new_digest: null,
        before_digest: liveDescriptor.base_digest,
        after_digest: null,
        observed_digest: null,
        file_identity: null,
        byte_length: null,
        dirty: liveDescriptor.dirty,
        disk_effect: null,
        code: null,
        message: null,
      });
      if (!started.ok) {
        active = null;
        if (started.rejection.code === "COMMIT_UNCERTAIN") {
          return finishOnce({ ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: started.rejection.message } });
        }
        return finishOnce({ ok: false, rejection: { code: "SAVE_FAILED", message: "journal append failed before commit: publication blocked with destination unchanged" } });
      }
      if (liveDescriptor.externally_modified) {
        return await failOnce("EXTERNAL_MODIFICATION_CONFLICT", "document base diverged from committed disk: dirty buffer preserved, reset is required, never a silent overwrite");
      }
      const fresh = session.registry.resolveDocument(admission.document.document_id);
      if (!fresh.ok) {
        return await failOnce("STALE_SESSION", "admission document is no longer live: late completion fenced");
      }
      const document = fresh.value;
      if (!document.dirty && document.state === "opened") {
        const verified = await deps.adapter.readDocument(deps.authority, document.portable_path);
        const after = revalidateAfterAwait(session, admission, deps);
        if (!after.ok) {
          if (deps.isCancelled?.() === true) {
            const cancelled = await cancelOnce(session, admission, liveDescriptor, journal, key, completed);
            if (cancelled !== null) {
              settled = true;
              terminal = cancelled;
              active = null;
              return cancelled;
            }
          }
          return await failOnce(after.rejection.code, after.rejection.message);
        }
        if (!verified.ok) {
          if (verified.rejection.code === "FILE_NOT_FOUND") {
            session.registry.noteExternalChange(document.portable_path, null);
            return await failOnce("EXTERNAL_MODIFICATION_CONFLICT", "the file was removed after the observed preimage: clean save cannot verify, reset is required", { observed_digest: null });
          }
          return await failOnce(verified.rejection.code as WorkspaceRejection["code"], verified.rejection.message);
        }
        if (verified.value.digest !== document.base_digest) {
          session.registry.noteExternalChange(document.portable_path, verified.value.digest);
          return await failOnce("EXTERNAL_MODIFICATION_CONFLICT", "document base diverged from committed disk: clean save verifies without overwriting, explicit reload or reset is required", { observed_digest: verified.value.digest });
        }
        const completedEvent: Omit<EditorSaveEvent, "seq"> = {
          kind: "editor.operation.completed",
          session_id: session.sessionId,
          generation: session.generation,
          operation_id: admission.record.operation_id,
          attempt_id: admission.record.attempt_id,
          document_id: document.document_id,
          portable_path: document.portable_path,
          lesson_compiled_digest: admission.record.lesson_compiled_digest,
          base_disk_revision: document.base_disk_revision,
          base_digest: document.base_digest,
          new_disk_revision: document.base_disk_revision,
          new_digest: document.base_digest,
          before_digest: document.base_digest,
          after_digest: document.base_digest,
          observed_digest: null,
          file_identity: verified.value.file_identity,
          byte_length: verified.value.byte_length,
          dirty: false,
          disk_effect: "unchanged",
          code: "OK",
          message: "clean save verified without rewriting",
        };
        const appended = journal.append(completedEvent);
        if (!appended.ok) {
          if (appended.rejection.code === "COMMIT_UNCERTAIN") {
            return finishOnce({ ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: appended.rejection.message } });
          }
          return await failOnce("SAVE_FAILED", "journal finalization failed: clean save cannot complete");
        }
        const result: ExecutedFileSave = deepFreeze({
          documentId: document.document_id,
          portable_path: document.portable_path,
          content: bufferText,
          disk_revision: document.base_disk_revision,
          disk_digest: document.base_digest,
          file_identity: verified.value.file_identity,
          disk_effect: "unchanged" as SaveDiskEffect,
          dirty: false,
          journal_seq: appended.value.seq,
        });
        return finishOnce({ ok: true, value: result });
      }
      const isPending = document.state === "pending_creation";
      const mode = isPending ? "create" : "replace";
      const expected = isPending ? { exists: false as const, digest: null } : { exists: true as const, digest: document.base_digest };
      if (!isPending && (expected.digest === null || expected.digest === undefined)) {
        return await failOnce("INVALID_REQUEST", "dirty existing document carries no base digest: save cannot guard its preimage");
      }
      if (deps.isCancelled?.() === true) {
        const cancelled = await cancelOnce(session, admission, liveDescriptor, journal, key, completed);
        if (cancelled !== null) {
          settled = true;
          terminal = cancelled;
          active = null;
          return cancelled;
        }
        return await failOnce("WORKSPACE_REVOKED", "save was cancelled before commit");
      }
      const publishArgs = {
        portablePath: document.portable_path,
        content: bufferText,
        mode: mode as "create" | "replace",
        expected,
        revalidate: deps.revalidate,
      };
      const published = await deps.adapter.publishDocument(deps.authority, publishArgs as unknown as Parameters<WindowsFileAdapter["publishDocument"]>[1]);
      const cancelAtBoundary = deps.isCancelled?.() === true;
      const liveness = revalidateAfterAwait(session, admission, deps);
      const livenessFailed = !liveness.ok;
      if (!published.ok) {
        const code = published.rejection.code as WorkspaceRejection["code"];
        if (code === "COMMIT_UNCERTAIN") {
          try {
            session.registry.noteExternalChange(document.portable_path, document.base_digest);
          } catch { /* best-effort */ }
          const uncertainEvent: Omit<EditorSaveEvent, "seq"> = {
            kind: "editor.operation.failed",
            session_id: session.sessionId,
            generation: session.generation,
            operation_id: admission.record.operation_id,
            attempt_id: admission.record.attempt_id,
            document_id: document.document_id,
            portable_path: document.portable_path,
            lesson_compiled_digest: admission.record.lesson_compiled_digest,
            base_disk_revision: document.base_disk_revision,
            base_digest: document.base_digest,
            new_disk_revision: null,
            new_digest: null,
            before_digest: document.base_digest,
            after_digest: null,
            observed_digest: null,
            file_identity: null,
            byte_length: null,
            dirty: true,
            disk_effect: "unknown",
            code: "COMMIT_UNCERTAIN",
            message: sanitizeSaveMessage(published.rejection.message),
          };
          const appended = journal.append(uncertainEvent);
          void appended;
          return finishOnce({ ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: published.rejection.message } });
        }
        if (code === "EXTERNAL_MODIFICATION_CONFLICT" || code === "FILE_EXISTS" || code === "FILE_NOT_FOUND") {
          let observed: string | null = null;
          try {
            const probe = await deps.adapter.readDocument(deps.authority, document.portable_path);
            if (probe.ok) observed = probe.value.digest;
          } catch { /* observation is best-effort */ }
          try {
            session.registry.noteExternalChange(document.portable_path, observed);
          } catch { /* best-effort */ }
          if (code === "FILE_EXISTS") {
            try {
              session.registry.noteExternalChange(document.portable_path, observed ?? bufferDigest);
            } catch { /* best-effort */ }
            return await failOnce("EXTERNAL_MODIFICATION_CONFLICT", "a file appeared where a creation is staged: pending buffer preserved, reset is required, never a silent overwrite", { observed_digest: observed });
          }
          return await failOnce(code, published.rejection.message, { observed_digest: observed });
        }
        if (code === "STALE_SESSION" || code === "STALE_EPOCH" || code === "WORKSPACE_REVOKED" || code === "WRONG_OWNER" || code === "WORKSPACE_BUSY" || code === "INVALID_TRANSITION" || code === "WORKSPACE_VIOLATION") {
          return await failOnce(code, published.rejection.message);
        }
        return await failOnce(code === "SAVE_FAILED" ? "SAVE_FAILED" : code, published.rejection.message);
      }
      if (livenessFailed) {
        try {
          session.registry.noteExternalChange(document.portable_path, published.value.digest);
        } catch { /* best-effort */ }
        const uncertainEvent: Omit<EditorSaveEvent, "seq"> = {
          kind: "editor.operation.failed",
          session_id: session.sessionId,
          generation: session.generation,
          operation_id: admission.record.operation_id,
          attempt_id: admission.record.attempt_id,
          document_id: document.document_id,
          portable_path: document.portable_path,
          lesson_compiled_digest: admission.record.lesson_compiled_digest,
          base_disk_revision: document.base_disk_revision,
          base_digest: document.base_digest,
          new_disk_revision: null,
          new_digest: published.value.digest,
          before_digest: document.base_digest,
          after_digest: null,
          observed_digest: published.value.digest,
          file_identity: published.value.file_identity,
          byte_length: published.value.byte_length,
          dirty: true,
          disk_effect: "unknown",
          code: "COMMIT_UNCERTAIN",
          message: sanitizeSaveMessage(`publication won before ${(liveness as { ok: false; rejection: WorkspaceRejection }).rejection.code}: outcome uncertain with evidence retained`),
        };
        journal.append(uncertainEvent);
        return finishOnce({ ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: `publication succeeded before ${(liveness as { ok: false; rejection: WorkspaceRejection }).rejection.code}: outcome uncertain, reset is required` } });
      }
      if (published.value.digest !== bufferDigest || published.value.byte_length !== Buffer.byteLength(bufferText, "utf8")) {
        try {
          session.registry.noteExternalChange(document.portable_path, published.value.digest);
        } catch { /* best-effort */ }
        const uncertainEvent: Omit<EditorSaveEvent, "seq"> = {
          kind: "editor.operation.failed",
          session_id: session.sessionId,
          generation: session.generation,
          operation_id: admission.record.operation_id,
          attempt_id: admission.record.attempt_id,
          document_id: document.document_id,
          portable_path: document.portable_path,
          lesson_compiled_digest: admission.record.lesson_compiled_digest,
          base_disk_revision: document.base_disk_revision,
          base_digest: document.base_digest,
          new_disk_revision: null,
          new_digest: published.value.digest,
          before_digest: document.base_digest,
          after_digest: published.value.digest,
          observed_digest: published.value.digest,
          file_identity: published.value.file_identity,
          byte_length: published.value.byte_length,
          dirty: true,
          disk_effect: "unknown",
          code: "COMMIT_UNCERTAIN",
          message: "published digest drifts from the authoritative buffer: outcome uncertain, reset is required",
        };
        journal.append(uncertainEvent);
        return finishOnce({ ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: "published bytes drift from the authoritative buffer: outcome uncertain, reset is required" } });
      }
      const committed = journal.append({
        kind: "editor.disk.committed",
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: admission.record.operation_id,
        attempt_id: admission.record.attempt_id,
        document_id: document.document_id,
        portable_path: document.portable_path,
        lesson_compiled_digest: admission.record.lesson_compiled_digest,
        base_disk_revision: document.base_disk_revision,
        base_digest: document.base_digest,
        new_disk_revision: document.base_disk_revision + 1,
        new_digest: published.value.digest,
        before_digest: document.base_digest,
        after_digest: published.value.digest,
        observed_digest: null,
        file_identity: published.value.file_identity,
        byte_length: published.value.byte_length,
        dirty: null,
        disk_effect: isPending ? "created" : "saved",
        code: null,
        message: null,
      });
      if (!committed.ok) {
        try {
          session.registry.noteExternalChange(document.portable_path, published.value.digest);
        } catch { /* best-effort */ }
        return finishOnce({ ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: "journal commit marker failed after publication: outcome uncertain with evidence retained" } });
      }
      if (cancelAtBoundary) {
        // Cancel at the commit boundary never lies: publication already won,
        // so settle verification/journal on the old generation (completed).
      }
      const nextRevision = document.base_disk_revision + 1;
      const commitSeam = (session.registry as unknown as { noteSaveCommitted?: (portablePath: string, exists: boolean, digest: string | null, revision: number) => WorkspaceOutcome<unknown> }).noteSaveCommitted;
      if (typeof commitSeam === "function") {
        const applied = commitSeam.call(session.registry, document.portable_path, true, published.value.digest, nextRevision);
        if (!applied.ok) {
          try {
            session.registry.noteExternalChange(document.portable_path, published.value.digest);
          } catch { /* best-effort */ }
          return await failOnce("COMMIT_UNCERTAIN", "verified publication could not bind its revision: outcome uncertain, reset is required");
        }
      } else {
        const fallback = session.registry.noteCommittedDiskFacts(document.portable_path, true, published.value.digest, nextRevision);
        if (!fallback.ok) {
          const dirtyFallback = session.registry.resolveDocument(document.document_id);
          void dirtyFallback;
          try {
            session.registry.noteExternalChange(document.portable_path, published.value.digest);
          } catch { /* best-effort */ }
          return await failOnce("COMMIT_UNCERTAIN", "verified publication could not bind its revision: outcome uncertain, reset is required");
        }
      }
      const afterCommit = session.registry.resolveDocument(document.document_id);
      const boundDigest = afterCommit.ok ? afterCommit.value.base_digest : published.value.digest;
      const boundRevision = afterCommit.ok ? afterCommit.value.base_disk_revision : nextRevision;
      const diskEffect: SaveDiskEffect = isPending ? "created" : "saved";
      const completedEvent: Omit<EditorSaveEvent, "seq"> = {
        kind: "editor.operation.completed",
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: admission.record.operation_id,
        attempt_id: admission.record.attempt_id,
        document_id: document.document_id,
        portable_path: document.portable_path,
        lesson_compiled_digest: admission.record.lesson_compiled_digest,
        base_disk_revision: document.base_disk_revision,
        base_digest: document.base_digest,
        new_disk_revision: boundRevision,
        new_digest: boundDigest,
        before_digest: document.base_digest,
        after_digest: boundDigest,
        observed_digest: null,
        file_identity: published.value.file_identity,
        byte_length: published.value.byte_length,
        dirty: false,
        disk_effect: diskEffect,
        code: "OK",
        message: isPending ? "pending creation published as its first committed file" : "dirty buffer published as a guarded replacement",
      };
      const appended = journal.append(completedEvent);
      if (!appended.ok) {
        return finishOnce({ ok: false, rejection: { code: "COMMIT_UNCERTAIN", message: "journal finalization failed after commit: outcome uncertain with evidence retained" } });
      }
      const finalDoc = session.registry.resolveDocument(document.document_id);
      const finalDirty = finalDoc.ok ? finalDoc.value.dirty : false;
      const result: ExecutedFileSave = deepFreeze({
        documentId: document.document_id,
        portable_path: document.portable_path,
        content: bufferText,
        disk_revision: boundRevision,
        disk_digest: boundDigest,
        file_identity: published.value.file_identity,
        disk_effect: diskEffect,
        dirty: finalDirty,
        journal_seq: appended.value.seq,
      });
      return finishOnce({ ok: true, value: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await failOnce("SAVE_FAILED", `save failed before commit with destination unchanged: ${sanitizeSaveMessage(message)}`);
    }
  }
  function replayFromJournal(session: EditorSession, admission: EditorOperationAdmission, terminal: EditorSaveEvent): WorkspaceOutcome<ExecutedFileSave> | null {
    if (terminal.session_id !== session.sessionId || terminal.generation !== session.generation) return null;
    if (terminal.operation_id !== admission.record.operation_id) return null;
    if (terminal.kind === "editor.operation.completed") {
      const doc = session.registry.resolveDocument(admission.document.document_id);
      const content = doc.ok ? session.registry.getBufferContent(doc.value.document_id) : null;
      const text = content !== null && content.ok ? content.value : "";
      const result: ExecutedFileSave = deepFreeze({
        documentId: admission.document.document_id,
        portable_path: admission.record.portable_path,
        content: text,
        disk_revision: terminal.new_disk_revision ?? 0,
        disk_digest: terminal.after_digest,
        file_identity: terminal.file_identity,
        disk_effect: (terminal.disk_effect ?? "saved") as SaveDiskEffect,
        dirty: false,
        journal_seq: terminal.seq,
      });
      return { ok: true, value: result };
    }
    if (terminal.kind === "editor.operation.failed") {
      const code = (terminal.code ?? "SAVE_FAILED") as WorkspaceRejection["code"];
      return { ok: false, rejection: { code, message: terminal.message ?? "replayed save failure without second commit" } };
    }
    if (terminal.kind === "editor.operation.cancelled") {
      return { ok: false, rejection: { code: "WORKSPACE_REVOKED", message: terminal.message ?? "replayed save cancellation without second commit" } };
    }
    return null;
  }
  async function cancelOnce(session: EditorSession, admission: EditorOperationAdmission, descriptor: { document_id: string; portable_path: string; base_disk_revision: number; base_digest: string | null; dirty: boolean }, targetJournal: EditorSaveJournal, key: string, done: Map<string, WorkspaceOutcome<ExecutedFileSave>>): Promise<WorkspaceOutcome<ExecutedFileSave> | null> {
    const existing = targetJournal.getTerminal(admission.record.operation_id);
    if (existing !== null) {
      const replayed = replayFromJournal(session, admission, existing);
      if (replayed !== null) {
        done.set(key, replayed);
        return replayed;
      }
    }
    const cancelledEvent: Omit<EditorSaveEvent, "seq"> = {
      kind: "editor.operation.cancelled",
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: admission.record.operation_id,
      attempt_id: admission.record.attempt_id,
      document_id: descriptor.document_id,
      portable_path: descriptor.portable_path,
      lesson_compiled_digest: admission.record.lesson_compiled_digest,
      base_disk_revision: descriptor.base_disk_revision,
      base_digest: descriptor.base_digest,
      new_disk_revision: null,
      new_digest: null,
      before_digest: descriptor.base_digest,
      after_digest: null,
      observed_digest: null,
      file_identity: null,
      byte_length: null,
      dirty: true,
      disk_effect: "none",
      code: "CANCELLED",
      message: "save cancelled before commit: staging discarded with destination unchanged",
    };
    const appended = targetJournal.append(cancelledEvent);
    if (!appended.ok) {
      const failed: WorkspaceOutcome<ExecutedFileSave> = { ok: false, rejection: { code: "SAVE_FAILED", message: "cancel could not journal its outcome: destination unchanged" } };
      done.set(key, failed);
      return failed;
    }
    const outcome: WorkspaceOutcome<ExecutedFileSave> = { ok: false, rejection: { code: "WORKSPACE_REVOKED", message: "save cancelled before commit: staging discarded with destination unchanged" } };
    done.set(key, outcome);
    return outcome;
  }
  return {
    execute,
    getJournal(): EditorSaveJournal {
      return journal;
    },
    listEvents(afterSeq = 0): readonly EditorSaveEvent[] {
      return journal.listEvents(afterSeq);
    },
    getTerminal(operationId: string): EditorSaveEvent | null {
      return journal.getTerminal(operationId);
    },
    invalidateAll(): void {
      invalidated = true;
      active = null;
    },
  };
}
/**
 * Single-shot admitted save helper (creates an ephemeral executor). Prefer
 * createFileSaveExecutor for idempotent replay and single-transaction
 * serialization across calls: the helper cannot converge duplicates.
 */
export async function executeAdmittedFileSave(session: EditorSession, admission: EditorOperationAdmission, deps: SaveExecutionDeps): Promise<WorkspaceOutcome<ExecutedFileSave>> {
  return createFileSaveExecutor().execute(session, admission, deps);
}
