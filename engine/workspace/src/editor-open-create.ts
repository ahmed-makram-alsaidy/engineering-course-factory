// P6.7 admitted document open and create — exact load and staged creation.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 4 (trust boundary:
// validated IR -> main-only reviewed catalog -> editor admission -> trusted
// working document), 5 (editor authority: main owns per-file working text,
// revision, committed disk hash/existence, dirty status), 6 (workspace/file
// authority: disk D is committed truth, main B is the authoritative unsaved
// document; dirty means B differs from D or the file is pending creation),
// 10 (file_open / file_create / file_save document rules), 12 (strict LF
// execution profile), 17 (portable path rules), 18 (resource bounds), 21
// (admission errors have zero side effects; planning errors preserve B/D)
// and 26.5 (file generations: seed revision 0, buffer revision independent)
// with docs/adr/ADR-0011-shared-workspace-ownership.md decision 5 (main owns
// unsaved text; disk owns committed text).
//
// Canonical P6.7 name: P6.7 Open/create.
// Objective: exact load and staged creation. PASS gate: no pre-save disk
// mutation; failure matrix.
//
// THE CENTRAL SEMANTIC PROPERTY: file_open and file_create execute ONLY from
// a P6.6 EditorOperationAdmission. There is deliberately no
// openByPath(path) / createByPath(path, content) production path: the caller
// supplies the live EditorSession handle plus the frozen admission record,
// and every semantic value (logical path, staged content) resolves from
// reviewed compiled IR through that admission. Renderer compromise cannot
// choose open/create paths or bytes because the renderer can never construct
// a live session handle or a registry-backed admission.
//
// Trust chain executed here:
//
//   Compiled IR -> P6.6 Editor Admission -> main-owned document authority
//   (this module + editor-documents.ts) -> WorkspaceCoordinator ownership
//   (lease/epoch fence) -> WindowsFileAdapter -> authoritative shared leaf.
//
// Owned scope (and only this):
//   - executeAdmittedFileOpen: admission-bound confined read through the
//     trusted adapter; byte-exact buffer binding with disk revision/digest;
//     duplicate/case-alias focus onto the one canonical document; clean
//     reload of changed valid disk with revision increment; dirty divergence
//     fenced without silent overwrite; missing files fail (except focusing an
//     already-staged pending buffer); read-only (never publishes).
//   - executeAdmittedFileCreate: admission-bound pending staging of verbatim
//     authored content (default empty) into the main-owned registry; live
//     existence/collision probing through the trusted adapter (existing,
//     case-alias and unparsable-profile targets all collide as FILE_EXISTS;
//     link/junction ancestry still fails WORKSPACE_VIOLATION); missing
//     parents fail; zero disk publication (P6.10 owns verified persistence).
//   - Generation/ownership fencing before AND after every adapter await, so
//     reset/close/revocation landing mid-read can never register stale state
//     (deterministic revalidate seam, never sleeps).
//
// Explicit non-scope (owned by later tasks, represented here only as
// fail-closed rejections or not at all):
//   - P6.8 type planning (no UTF-16 ranges, graphemes, pacing, cursor work);
//   - P6.9 replacement matching (no occurrence counting, no plans);
//   - P6.10 save persistence (this module NEVER calls publishDocument; the
//     name appears nowhere in this file by construction) and journals;
//   - P6.11 cancel/reset/replay beyond invalidation fencing (no animation);
//   - P6.12 IPC/preload/Monaco wiring (no new channels; results are
//     main-held, renderer-safe by shape);
//   - P6.13 terminal interop beyond the unchanged buffer-facts seam.
// Executing a type_code / replace_code / file_save admission through either
// entry point rejects INVALID_REQUEST with zero adapter action and zero
// registry mutation: later editor semantics cannot leak in through here.
//
// Purity: this module imports only relative workspace modules (protocol
// shapes, admission session/fences, document registry, adapter types). No
// filesystem, no processes, no containers, no timers, no wall-clock reads,
// no browser or presentation machinery. All disk truth arrives through the
// injected WindowsFileAdapter handle.

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
import type { EditorDocumentDescriptor } from "./editor-documents.ts";
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

/** Execution protocol version (matches the workspace protocol). */
export const EDITOR_OPEN_CREATE_VERSION = 1;

/**
 * Main-held execution dependencies. The adapter is the injected trusted
 * WindowsFileAdapter bound to the coordinator leaf; the authority is the
 * coordinator-issued editor lease plus the live ownership/epoch fence
 * (main-held facts, never renderer input). The optional revalidate supplier
 * is consulted after every adapter await before any registry mutation: a
 * reset, close, revocation or ownership change landing mid-read aborts with
 * zero registration. Tests drive races deterministically through this seam
 * (manual doubles), never through sleeps.
 */
export interface OpenCreateDeps {
  readonly adapter: WindowsFileAdapter;
  readonly authority: AdapterAuthority;
  readonly revalidate?: () => AdapterAuthority;
}

/** Main-held executed-open result (logical identifiers and digests only). */
export interface ExecutedFileOpen {
  readonly document: EditorDocumentDescriptor;
  /** Exact buffer text now bound (byte-exact disk bytes, or staged pending text on focus). */
  readonly content: string;
  /** Base disk revision the buffer corresponds to (seed revision 0 on first load, +1 per clean reload). */
  readonly disk_revision: number;
  /** SHA-256 over the exact bytes the buffer corresponds to (null only for pending focus). */
  readonly disk_digest: string | null;
  /** Trusted opaque file identity from the adapter (null only for pending focus). */
  readonly file_identity: string | null;
  /** True when a clean loaded document reloaded changed valid disk bytes. */
  readonly reloaded: boolean;
  /** True when the open focused an already-staged pending creation instead of reading disk. */
  readonly pending_focus: boolean;
}

/** Main-held executed-create result (logical identifiers only, no disk facts: nothing was published). */
export interface ExecutedFileCreate {
  readonly document: EditorDocumentDescriptor;
  /** Exact staged text (verbatim authored content, default empty). */
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Fences (fail-closed, before and after every adapter await).
// ---------------------------------------------------------------------------

function ownershipRejection(ownership: WorkspaceOwnership): WorkspaceRejection {
  if (ownership === "TERMINAL_OWNED") {
    return { code: "WORKSPACE_BUSY", message: "terminal read-write owns the leaf: no host file access" };
  }
  return { code: "INVALID_TRANSITION", message: `host file access is barred while ${ownership}` };
}

/**
 * Check a presented authority against the live editor session binding.
 * Mirrors the adapter's fail-closed order (session -> generation -> epoch ->
 * revocation -> ownership) without touching disk, so execution fails fast
 * with zero adapter action when authority is already stale.
 */
function checkExecutionAuthority(
  session: EditorSession,
  authority: AdapterAuthority,
): { ok: true } | { ok: false; rejection: WorkspaceRejection } {
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

/**
 * Revalidate after an adapter await, before any registry mutation. A reset
 * or close retires the registry synchronously, so liveness checks catch
 * those races; the revalidate supplier additionally observes coordinator
 * revocation/ownership changes that do not retire the admission session.
 */
function revalidateAfterAwait(
  session: EditorSession,
  admission: EditorOperationAdmission,
  deps: OpenCreateDeps,
): { ok: true; authority: AdapterAuthority } | { ok: false; rejection: WorkspaceRejection } {
  if (session.registry.retired) {
    return rejected("STALE_SESSION", "editor session was reset or closed while the file read was in flight: late completion fenced");
  }
  if (!isLiveAdmissionDocument(session, admission.document)) {
    return rejected("STALE_SESSION", "admission document is no longer live in this generation: late completion fenced");
  }
  let live = deps.authority;
  if (deps.revalidate !== undefined) {
    try {
      live = deps.revalidate();
    } catch {
      return rejected("WORKSPACE_REVOKED", "execution fence could not be revalidated after the read; late completion fenced");
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
    return rejected("WORKSPACE_REVOKED", "editor lease was revoked while the file read was in flight");
  }
  if (live.ownership !== "EDITOR_OWNED") {
    return { ok: false, rejection: ownershipRejection(live.ownership) };
  }
  return { ok: true, authority: live };
}

/**
 * Admission/session binding shared by both executors. Verifies the admission
 * is a live P6.6 record of this exact session generation before any adapter
 * action: stale generations, foreign sessions, retired sessions and forged
 * descriptors all fence here with zero disk or registry effects.
 */
function checkAdmissionBinding(
  session: EditorSession,
  admission: EditorOperationAdmission,
): { ok: true } | { ok: false; rejection: WorkspaceRejection } {
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

// ---------------------------------------------------------------------------
// file_open execution.
// ---------------------------------------------------------------------------

/**
 * Execute an admitted file_open: load exact committed bytes through the
 * trusted adapter and bind them to the main-owned document.
 *
 * Read path resolves through the LIVE DESCRIPTOR's portable path
 * (first-seen authored form, main-held), so a case-variant admission for an
 * already-open file focuses the same canonical document instead of issuing
 * a second alias read: duplicate writable buffers are impossible.
 *
 * The read is strictly read-only: this function never calls
 * publishDocument (the name is absent from this module by construction).
 */
export async function executeAdmittedFileOpen(
  session: EditorSession,
  admission: EditorOperationAdmission,
  deps: OpenCreateDeps,
): Promise<WorkspaceOutcome<ExecutedFileOpen>> {
  const binding = checkAdmissionBinding(session, admission);
  if (!binding.ok) return binding;
  if (admission.record.action_type !== "file_open") {
    return rejected(
      "INVALID_REQUEST",
      `open executor runs file_open admissions only (got '${String(admission.record.action_type)}'): later editor semantics stay deferred`,
    );
  }
  if (deps === null || typeof deps !== "object" || deps.adapter === null || typeof deps.adapter !== "object") {
    return rejected("INVALID_REQUEST", "open execution requires the trusted file adapter handle");
  }
  const fence = checkExecutionAuthority(session, deps.authority);
  if (!fence.ok) return fence;

  const resolved = session.registry.resolveDocument(admission.document.document_id);
  if (!resolved.ok) return resolved as { ok: false; rejection: WorkspaceRejection };
  const live = resolved.value;

  const read = await deps.adapter.readDocument(deps.authority, live.portable_path);

  const after = revalidateAfterAwait(session, admission, deps);
  if (!after.ok) return after;
  const current = session.registry.resolveDocument(admission.document.document_id);
  if (!current.ok) return current as { ok: false; rejection: WorkspaceRejection };
  const document = current.value;

  // -- missing file ---------------------------------------------------------
  if (!read.ok && read.rejection.code === "FILE_NOT_FOUND") {
    // Canonical exception (spec section 10): an already-staged pending
    // creation focuses its buffer instead of failing. When the pending
    // document has staged text (its create already executed), open returns
    // that buffer with zero disk effects.
    if (document.state === "pending_creation") {
      const staged = session.registry.getBufferContent(document.document_id);
      if (staged.ok) {
        return {
          ok: true,
          value: deepFreeze({
            document,
            content: staged.value,
            disk_revision: 0,
            disk_digest: null,
            file_identity: null,
            reloaded: false,
            pending_focus: true,
          }),
        };
      }
      // Pending admitted but never staged (its create has not executed):
      // the buffer does not exist yet, so the open honestly reports absence
      // with zero mutation rather than inventing content.
      return { ok: false, rejection: { code: "FILE_NOT_FOUND", message: "the file does not exist and its staged creation has no executed content yet" } };
    }
    // Missing open never converts into create and never mutates: no empty
    // content is staged, no descriptor flag changes, the buffer (if any) is
    // preserved for diagnostics. A clean loaded document whose file was
    // removed stays retryable: a later open after restore reloads normally.
    return { ok: false, rejection: { code: "FILE_NOT_FOUND", message: "the file does not exist" } };
  }
  if (!read.ok) {
    // Profile/confinement/ownership failures propagate with zero registry
    // mutation: UNSUPPORTED_TEXT_PROFILE leaves exact disk bytes untouched,
    // WORKSPACE_VIOLATION keeps the link/junction ancestry denied.
    return read as { ok: false; rejection: WorkspaceRejection };
  }
  const observed = read.value;

  // -- pending document whose target appeared on disk ------------------------
  // A staged creation colliding with a newborn disk file is an external
  // modification of the pending base (absent): preserve the staged buffer,
  // flag the conflict, never silently adopt or overwrite either side.
  if (document.state === "pending_creation") {
    session.registry.noteExternalChange(document.portable_path, observed.digest);
    return rejected(
      "EXTERNAL_MODIFICATION_CONFLICT",
      "a file appeared where a creation is staged: pending buffer preserved, reset is required, never a silent overwrite",
    );
  }

  // -- dirty document with diverged disk: fence, never silently rebase -----
  // A dirty buffer knows the committed revision it originated from; any drift
  // flags the conflict and preserves the buffer for diagnostics.
  if (document.dirty && observed.digest !== document.base_digest) {
    session.registry.noteExternalChange(document.portable_path, observed.digest);
    return rejected(
      "EXTERNAL_MODIFICATION_CONFLICT",
      "document base diverged from committed disk: dirty buffer preserved, reset is required, never a silent rebase",
    );
  }

  const hasContent = session.registry.hasBufferContent(document.document_id);

  // -- bound to these exact bytes already: pure focus, zero registry writes -
  // Covers clean duplicate opens (same bytes, no reload) and dirty opens
  // whose disk still equals the baseline (existing edits are not discarded).
  if (hasContent && observed.digest === document.base_digest) {
    const focused = session.registry.getBufferContent(document.document_id);
    if (!focused.ok) return focused as { ok: false; rejection: WorkspaceRejection };
    return {
      ok: true,
      value: deepFreeze({
        document,
        content: focused.value,
        disk_revision: document.base_disk_revision,
        disk_digest: document.base_digest,
        file_identity: observed.file_identity,
        reloaded: false,
        pending_focus: false,
      }),
    };
  }

  // -- clean loaded document, disk changed to new valid bytes ----------------
  // Explicit reload adopts them and increments the base revision once. The
  // old buffer is clean, so nothing unsaved is lost. (Dirty divergence
  // returned above, so reaching here with differing bytes means clean.)
  if (hasContent) {
    const rebound = session.registry.noteCommittedDiskFacts(
      document.portable_path,
      true,
      observed.digest,
      document.base_disk_revision + 1,
    );
    if (!rebound.ok) return rebound as { ok: false; rejection: WorkspaceRejection };
    const stored = session.registry.setBufferContent(document.document_id, observed.content);
    if (!stored.ok) return stored as { ok: false; rejection: WorkspaceRejection };
    return {
      ok: true,
      value: deepFreeze({
        document: stored.value,
        content: observed.content,
        disk_revision: stored.value.base_disk_revision,
        disk_digest: observed.digest,
        file_identity: observed.file_identity,
        reloaded: true,
        pending_focus: false,
      }),
    };
  }

  // -- first load: bind the live disk revision --------------------------------
  // The descriptor carries reviewed seed facts (revision 0); the buffer now
  // becomes exactly the committed bytes. When the live digest already equals
  // the seed digest and no stale flag stands, this is a pure bind; otherwise
  // the clean document adopts the live bytes through the main-held facts
  // seam (the sanctioned explicit-load path for clean documents, which also
  // clears a stale conflict flag once bytes agree again) at the seed
  // generation revision. A dirty reservation without executed text (admitted
  // edit awaiting its owning execution) binds the same true base its edit
  // will apply onto; dirty divergence already returned above, so a rebind
  // here never touches a diverged dirty document (the seam itself rejects
  // dirty/pending adoption fail-closed).
  if (observed.digest !== document.base_digest || document.externally_modified) {
    const adopted = session.registry.noteCommittedDiskFacts(document.portable_path, true, observed.digest, 0);
    if (!adopted.ok) return adopted as { ok: false; rejection: WorkspaceRejection };
  }
  const stored = session.registry.setBufferContent(document.document_id, observed.content);
  if (!stored.ok) return stored as { ok: false; rejection: WorkspaceRejection };
  return {
    ok: true,
    value: deepFreeze({
      document: stored.value,
      content: observed.content,
      disk_revision: stored.value.base_disk_revision,
      disk_digest: observed.digest,
      file_identity: observed.file_identity,
      reloaded: false,
      pending_focus: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// file_create execution.
// ---------------------------------------------------------------------------

/**
 * Execute an admitted file_create: stage verbatim authored content into the
 * main-owned pending document. The disk remains unchanged (no publication,
 * no staging commit, no rename): P6.10 owns verified persistence.
 *
 * Before staging, the live target is probed through the trusted adapter:
 * an existing file, a Windows case alias and even an existing file with an
 * unparsable text profile all collide as FILE_EXISTS (creation never
 * overwrites and never converts into open). Link/junction ancestry and
 * missing parents surface through the adapter as WORKSPACE_VIOLATION /
 * FILE_NOT_FOUND with zero mutation.
 */
export async function executeAdmittedFileCreate(
  session: EditorSession,
  admission: EditorOperationAdmission,
  deps: OpenCreateDeps,
): Promise<WorkspaceOutcome<ExecutedFileCreate>> {
  const binding = checkAdmissionBinding(session, admission);
  if (!binding.ok) return binding;
  if (admission.record.action_type !== "file_create") {
    return rejected(
      "INVALID_REQUEST",
      `create executor runs file_create admissions only (got '${String(admission.record.action_type)}'): later editor semantics stay deferred`,
    );
  }
  if (deps === null || typeof deps !== "object" || deps.adapter === null || typeof deps.adapter !== "object") {
    return rejected("INVALID_REQUEST", "create execution requires the trusted file adapter handle");
  }
  const fence = checkExecutionAuthority(session, deps.authority);
  if (!fence.ok) return fence;

  const resolved = session.registry.resolveDocument(admission.document.document_id);
  if (!resolved.ok) return resolved as { ok: false; rejection: WorkspaceRejection };
  const live = resolved.value;
  if (live.state !== "pending_creation") {
    return rejected("INVALID_REQUEST", "create execution requires the admitted pending document");
  }

  // Authored content is trusted IR resolved through the admission (profile
  // authority is P6.6 admission; absent content defaults to empty).
  const authored = admission.parameters;
  const staged = authored.type === "file_create" && authored.content !== undefined ? authored.content : "";

  // Idempotent replay: the same admission executing twice stages once and
  // reports the same buffer deterministically.
  if (session.registry.hasBufferContent(live.document_id)) {
    const existing = session.registry.getBufferContent(live.document_id);
    if (!existing.ok) return existing as { ok: false; rejection: WorkspaceRejection };
    if (existing.value !== staged) {
      return rejected("INVALID_REQUEST", "pending document already stages different content: replay payload conflicts");
    }
    return { ok: true, value: deepFreeze({ document: live, content: existing.value }) };
  }

  // Live collision probe through the trusted adapter (read-only: never a
  // publication). The descriptor path is the canonical first-seen form, so
  // Windows case aliases of the same logical file collapse here as well.
  const probe = await deps.adapter.readDocument(deps.authority, live.portable_path);

  const after = revalidateAfterAwait(session, admission, deps);
  if (!after.ok) return after;
  const current = session.registry.resolveDocument(admission.document.document_id);
  if (!current.ok) return current as { ok: false; rejection: WorkspaceRejection };
  if (current.value.state !== "pending_creation") {
    return rejected("INVALID_REQUEST", "create execution requires the admitted pending document");
  }
  // A racing execution of the same admission may have staged while the probe
  // was in flight: converge deterministically instead of double-staging.
  if (session.registry.hasBufferContent(current.value.document_id)) {
    const raced = session.registry.getBufferContent(current.value.document_id);
    if (!raced.ok) return raced as { ok: false; rejection: WorkspaceRejection };
    if (raced.value !== staged) {
      return rejected("INVALID_REQUEST", "pending document already stages different content: replay payload conflicts");
    }
    return { ok: true, value: deepFreeze({ document: current.value, content: raced.value }) };
  }

  if (probe.ok) {
    return rejected("FILE_EXISTS", "the file already exists: creation never overwrites and never converts into open");
  }
  if (probe.rejection.code === "UNSUPPORTED_TEXT_PROFILE") {
    // An existing file with bytes outside the execution profile still
    // exists: the collision is the fact, and its profile never leaks into
    // the pending buffer.
    return rejected("FILE_EXISTS", "the file already exists: creation never overwrites and never converts into open");
  }
  if (probe.rejection.code === "WORKSPACE_VIOLATION" && /only by case/.test(probe.rejection.message)) {
    // Canonical Windows case collision (spec section 10): no second logical
    // document, no accidental clobber.
    return rejected("FILE_EXISTS", "a file differing only by case already exists: creation never clobbers a case alias");
  }
  if (probe.rejection.code !== "FILE_NOT_FOUND") {
    // Ancestry links, ownership fences, stale leases and observation errors
    // propagate with zero registry mutation and zero disk effects.
    return probe as { ok: false; rejection: WorkspaceRejection };
  }

  // Absent target confirmed by trusted facts: stage the pending buffer.
  // No adapter publication happens on this path (see module header).
  const stored = session.registry.setBufferContent(current.value.document_id, staged);
  if (!stored.ok) return stored as { ok: false; rejection: WorkspaceRejection };
  return { ok: true, value: deepFreeze({ document: stored.value, content: staged }) };
}

/**
 * Main-held read of executed buffer text (open loads, create stages).
 * Fences stale sessions and unexecuted documents; never touches disk.
 */
export function readExecutedContent(
  session: EditorSession,
  documentId: string,
): WorkspaceOutcome<string> {
  if (session.registry.retired) {
    return rejected("STALE_SESSION", "editor session was reset or closed");
  }
  return session.registry.getBufferContent(documentId);
}
