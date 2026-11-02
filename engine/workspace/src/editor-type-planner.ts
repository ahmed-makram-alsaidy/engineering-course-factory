// P6.8 deterministic type planner and scheduler — plan and schedule admitted
// type_code operations only, with zero buffer or disk mutation.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 4 (trust boundary:
// validated IR -> main-only reviewed catalog -> editor admission -> immutable
// semantic plan -> trusted working document), 5 (editor authority: main owns
// per-file working text; each edit has preimage B0, candidate B1, hashes,
// revision, exact UTF-16 ranges, generation and plan ID; B0 stays committed
// while animation projects prefixes of B1; on completion main installs B1;
// on cancel/failure main keeps B0; disk remains D0), 7 (operation model and
// admission: operation_id := step_id; one attempt per operation with
// tombstones; authored editor order), 8 (type_code semantics: exact authored
// path, never active tab/cursor/selection; absent at_line appends at exact
// EOF with no newline; present at_line inserts at column 1 of that existing
// logical line; logical lines = LF count + 1 including the empty trailing
// line, empty file has line 1; out-of-range rejects INVALID_LOCATION, no
// pad/clamp; empty content is a successful no-op consuming the operation; no
// auto-indent/formatting; resolve once against B0, create B1 by exact
// slicing; verify B1 hash at plan completion), 11 (deterministic typing
// scheduler: versioned main-only policy, digest-bound at session start;
// default 40 clusters/second, integer microsecond base 25,000; +80,000 after
// . , ; : ! ?, +180,000 after LF, +20,000 after space/tab with newline
// precedence; first chunk at time zero; fixed 120/second profile with floor
// interval; no jitter or wall-clock text choices; above 8,192 clusters the
// fast profile with groups of up to 32 stopping at LF, group due time is the
// last member cumulative due time; freeze before animation; pause beats are
// P8; timing changes may change duration, never B1), 12 (strict LF profile:
// reject CR/CRLF/BOM/invalid UTF-8/NUL/unpaired surrogates with
// UNSUPPORTED_TEXT_PROFILE, never convert; no NFC/NFKC; pinned grapheme
// segmentation recorded in policy for Arabic combining marks, mixed comments
// and emoji/ZWJ; Monaco positions in UTF-16 units, byte hashes in UTF-8,
// never confused; main sends explicit boundaries), 18 (1 MiB IR/file/result
// ceilings; reject over-budget before mutation, never truncate; reject a
// schedule that cannot fit remaining session time), 21 (admission errors zero
// side effects; planning errors preserve B/D) and 26.5 (buffer stores base
// disk revision/digest/existence plus independent buffer revision; typing
// changes only buffer revision) with
// docs/adr/ADR-0011-shared-workspace-ownership.md decision 5 (main owns
// unsaved text; disk owns committed text; terminal reads committed disk).
//
// Canonical P6.8 name: P6.8 Type planner/scheduler.
// Objective: deterministic planning and scheduling for admitted type_code
// only (UTF-16 positions, grapheme segmentation, deterministic batches) with
// golden semantic and schedule outputs, Unicode and large-block proofs.
//
// THE CENTRAL SEMANTIC PROPERTIES (proven by the P6.8 suite, not by types):
//   1. Authoritative text comes ONLY from the reviewed admitted type_code
//      operation (resolved through the P6.6 admission record). This module
//      exposes no generic type(document, text, position) entry point: the
//      planner takes the live EditorSession handle plus the frozen admission
//      only. Renderer compromise cannot choose bytes, targets or pacing.
//   2. Concatenating all planned units equals the exact authored payload
//      byte-for-byte (no added/removed/normalized/reordered/corrected
//      character; human-looking timing never alters semantics).
//   3. Positioning is deterministic: exact insertion at the authored line
//      start (column 1, UTF-16), otherwise append at exact EOF. No cursor,
//      selection, fuzzy, AST or renderer-cursor authority.
//   4. Scheduling is deterministic: the same operation, document state and
//      policy version always yield the identical logical schedule (integer
//      microseconds, first unit at zero). No randomness, no wall-clock reads.
//   5. Plans bind the exact live document revision and generation they were
//      created from. Stale buffer, retired session or new generation fences
//      before any progress, with zero mutation.
//   6. P6.8 plans and schedules only: the registry buffer, disk bytes,
//      dirty accounting and buffer revisions are NEVER written here. Disk
//      stays byte-identical (P5 keeps seeing committed bytes); the future
//      presentation/commit phase owns installation.
//
// Owned scope (and only this):
//   - resolveTypeInsertion: LF line geometry to an exact UTF-16 offset.
//   - segmentGraphemes: pinned Intl.Segmenter grapheme clustering.
//   - planAdmittedTypeOperation: pure admission + live B0 -> frozen TypePlan
//     (B1 candidate, units, explicit UTF-16 boundaries, digests).
//   - scheduleTypePlan: pure TypePlan -> frozen TypeSchedule (integer
//     microsecond due times, presentation groups, timeout).
//   - createTypePlanner: main-owned plan lifecycle (planned/running/
//     completed/cancelled/failed) over a manual logical clock, with
//     per-document serialization, idempotent replay convergence, cancel with
//     zero mutation, and reset/close invalidation. No timers, no sleeps.
//
// Explicit non-scope (owned by later tasks, represented here only as
// fail-closed rejections or not at all):
//   - buffer installation and buffer-revision advances (future
//     presentation/commit phase; P6.6 reservation semantics preserved here);
//   - verified persistence, journals and disk publication (later save task;
//     the publication name appears nowhere in this file by construction);
//   - occurrence matching and transactional replacement (later task);
//   - cancel/reset/replay beyond plan invalidation (later lifecycle task);
//   - IPC/preload/Monaco wiring and visual presentation (later tasks; no
//     model edits, no frames, no keyboard synthesis here);
//   - terminal interop beyond the unchanged buffer-facts seam;
//   - pause/resume beats (explicitly P8 per section 11; not implemented);
//   - browser automation, recording, node-pty (never).
//
// Purity: this module imports only zod (DTO validation), node:crypto
// (digest binding) and relative workspace modules. No filesystem, no
// processes, no containers, no timers, no wall-clock reads, no browser or
// presentation machinery. All races fence through explicit revalidation of
// live session state, never through sleeps.

import { z } from "zod";
import { createHash } from "node:crypto";
import type { WorkspaceOutcome, WorkspaceRejection } from "./protocol.ts";
import type {
  EditorOperationAdmission,
  EditorSession,
} from "./editor-admission.ts";
import { isLiveAdmissionDocument } from "./editor-admission.ts";
import { canonicalDocumentKey } from "./editor-documents.ts";

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

/** Planner/scheduler protocol version (matches the workspace protocol). */
export const EDITOR_TYPE_PLANNER_VERSION = 1;

/** Typing timing policy version (digest-bound at session start per section 11). */
export const TYPING_POLICY_VERSION = 1;

/**
 * Pinned grapheme segmentation implementation identifier, recorded in every
 * policy and plan (section 12). The locale is undetermined ("und") so no
 * language-specific tailoring can change cluster boundaries; granularity is
 * grapheme. Main sends explicit per-unit UTF-16 boundaries so platform ICU
 * differences cannot change frozen schedules.
 */
export const TYPING_SEGMENTATION_ID = "Intl.Segmenter:und:grapheme:v1";

/** Default profile: 40 grapheme clusters/second. */
export const TYPING_DEFAULT_CLUSTERS_PER_SECOND = 40;
/** Integer microsecond base interval for the default profile (1,000,000 / 40). */
export const TYPING_BASE_INTERVAL_US_DEFAULT = 25000;
/** Fast profile: 120 clusters/second (fixed profile per section 11). */
export const TYPING_FAST_CLUSTERS_PER_SECOND = 120;
/** Integer microsecond base interval for the fast profile (floor(1,000,000 / 120)). */
export const TYPING_BASE_INTERVAL_US_FAST = 8333;
/** Added pause after . , ; : ! ? (microseconds). */
export const TYPING_PAUSE_PUNCTUATION_US = 80000;
/** Added pause after LF (microseconds; takes precedence over other pauses). */
export const TYPING_PAUSE_NEWLINE_US = 180000;
/** Added pause after space/tab (microseconds). */
export const TYPING_PAUSE_SPACE_US = 20000;
/** Inserts above this cluster count use the fast profile with grouping. */
export const TYPING_LARGE_BLOCK_CLUSTERS = 8192;
/** Maximum presentation group size for large blocks (stopping at LF). */
export const TYPING_MAX_GROUP_CLUSTERS = 32;
/** Authored UTF-8 ceiling per plan (section 18: 1 MiB per file/result). */
export const TYPING_MAX_AUTHOR_UTF8_BYTES = 1048576;
/** Absolute unit ceiling (one grapheme per byte in the densest ASCII case). */
export const TYPING_MAX_UNITS = 1048576;
/**
 * Absolute schedule-duration ceiling (30 minutes, matching the coordinator
 * logical session ceiling in section 26.9). A plan whose deterministic
 * duration cannot fit a session is rejected RESOURCE_LIMIT before any
 * lifecycle entry exists, never truncated.
 */
export const TYPING_MAX_SCHEDULE_DURATION_US = 1800000000;
/** Bounded live plans per planner instance (planned + running). */
export const TYPING_MAX_ACTIVE_PLANS = 32;
/** Presentation timeout slack: planned duration + 10 seconds (section 11). */
export const TYPING_PRESENTATION_TIMEOUT_EXTRA_US = 10000000;

// ---------------------------------------------------------------------------
// Typing policy (versioned, digest-bound, main-only).
// ---------------------------------------------------------------------------

/** Fixed timing profile selected deterministically from the unit count. */
export type TypingProfile = "default" | "fast";

export interface TypingPolicy {
  readonly policy_version: 1;
  readonly profile: TypingProfile;
  readonly clusters_per_second: 40 | 120;
  readonly base_interval_us: 25000 | 8333;
  readonly punctuation_pause_us: 80000;
  readonly newline_pause_us: 180000;
  readonly space_pause_us: 20000;
  readonly segmentation: string;
  readonly policy_digest: string;
}

function policyDigestFor(profile: TypingProfile, baseIntervalUs: number): string {
  const canonical = JSON.stringify({
    policy_version: TYPING_POLICY_VERSION,
    profile,
    clusters_per_second: profile === "default" ? 40 : 120,
    base_interval_us: baseIntervalUs,
    punctuation_pause_us: TYPING_PAUSE_PUNCTUATION_US,
    newline_pause_us: TYPING_PAUSE_NEWLINE_US,
    space_pause_us: TYPING_PAUSE_SPACE_US,
    segmentation: TYPING_SEGMENTATION_ID,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Default 40/second policy (main-only, frozen). */
export const DEFAULT_TYPING_POLICY: TypingPolicy = deepFreeze({
  policy_version: TYPING_POLICY_VERSION,
  profile: "default",
  clusters_per_second: 40,
  base_interval_us: TYPING_BASE_INTERVAL_US_DEFAULT,
  punctuation_pause_us: TYPING_PAUSE_PUNCTUATION_US,
  newline_pause_us: TYPING_PAUSE_NEWLINE_US,
  space_pause_us: TYPING_PAUSE_SPACE_US,
  segmentation: TYPING_SEGMENTATION_ID,
  policy_digest: policyDigestFor("default", TYPING_BASE_INTERVAL_US_DEFAULT),
});

/** Fast 120/second policy for inserts above 8,192 clusters (main-only, frozen). */
export const FAST_TYPING_POLICY: TypingPolicy = deepFreeze({
  policy_version: TYPING_POLICY_VERSION,
  profile: "fast",
  clusters_per_second: 120,
  base_interval_us: TYPING_BASE_INTERVAL_US_FAST,
  punctuation_pause_us: TYPING_PAUSE_PUNCTUATION_US,
  newline_pause_us: TYPING_PAUSE_NEWLINE_US,
  space_pause_us: TYPING_PAUSE_SPACE_US,
  segmentation: TYPING_SEGMENTATION_ID,
  policy_digest: policyDigestFor("fast", TYPING_BASE_INTERVAL_US_FAST),
});

/**
 * Deterministic profile selection (section 11): inserts above 8,192
 * grapheme clusters use the fast profile from the outset, otherwise the
 * default profile. No wall-clock, no heuristics, no renderer input.
 */
export function resolveTypingPolicyForUnitCount(unitCount: number): TypingPolicy {
  return unitCount > TYPING_LARGE_BLOCK_CLUSTERS ? FAST_TYPING_POLICY : DEFAULT_TYPING_POLICY;
}

// ---------------------------------------------------------------------------
// Small pure helpers (digests, text profile).
// ---------------------------------------------------------------------------

function sha256HexText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function authoredProfileProblems(value: string): string[] {
  const problems: string[] = [];
  if (value.includes("\r")) problems.push("CR bytes are not allowed (strict LF profile; CRLF/lone CR rejected, never converted)");
  if (value.includes("\0")) problems.push("NUL is not allowed");
  if (LONE_SURROGATE_PATTERN.test(value)) problems.push("unpaired UTF-16 surrogates are not allowed");
  if (value.includes("\uFEFF")) problems.push("BOM is not allowed inside authored text");
  return problems;
}

// ---------------------------------------------------------------------------
// Grapheme segmentation (pinned, deterministic, no normalization).
// ---------------------------------------------------------------------------

let cachedSegmenter: { segment(text: string): Iterable<{ segment: string }> } | null = null;

function liveSegmenter(): { segment(text: string): Iterable<{ segment: string }> } | null {
  if (cachedSegmenter !== null) return cachedSegmenter;
  const holder = Intl as unknown as Record<string, unknown>;
  const Ctor = holder["Segmenter"] as (new (locale: string, options: { granularity: string }) => { segment(text: string): Iterable<{ segment: string }> }) | undefined;
  if (typeof Ctor !== "function") return null;
  try {
    cachedSegmenter = new Ctor("und", { granularity: "grapheme" });
    return cachedSegmenter;
  } catch {
    return null;
  }
}

/**
 * Segment text into grapheme clusters with the pinned implementation.
 * Never splits surrogate pairs, ZWJ sequences, combining marks or regional
 * indicators naively; never normalizes (no NFC/NFKC); preserves LF as its
 * own cluster. The concatenation invariant (units.join("") === text) is
 * checked by the planner and the suite.
 */
export function segmentGraphemes(text: string): readonly string[] {
  const segmenter = liveSegmenter();
  if (segmenter === null) {
    throw new Error("internal: grapheme segmentation is unavailable on this runtime");
  }
  const units: string[] = [];
  for (const part of segmenter.segment(text)) units.push(part.segment);
  return Object.freeze([...units]);
}

// ---------------------------------------------------------------------------
// Insertion geometry (exact LF line model, UTF-16 offsets).
// ---------------------------------------------------------------------------

/** Exact insertion target in UTF-16 units (Monaco positions are UTF-16). */
export interface TypeInsertion {
  readonly mode: "append" | "line_start";
  readonly offset_utf16: number;
  readonly line: number;
  readonly column_utf16: number;
}

/**
 * Resolve the deterministic insertion target against B0.
 *
 * Absent at_line appends at exact EOF (no newline inserted). Present at_line
 * inserts at column 1 of that existing logical line, where logical lines =
 * LF count + 1 including the empty trailing line and the empty file has
 * line 1. Out-of-range rejects INVALID_LOCATION (no pad, no clamp). Cursor
 * and selection are irrelevant by construction (no such input exists).
 */
export function resolveTypeInsertion(baseText: string, atLine: number | undefined): WorkspaceOutcome<TypeInsertion> {
  if (baseText.includes("\r")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "working text is outside the strict LF profile: CR bytes are never converted");
  }
  const lines = baseText.split("\n");
  if (atLine === undefined) {
    const last = lines[lines.length - 1] ?? "";
    const value: TypeInsertion = {
      mode: "append",
      offset_utf16: baseText.length,
      line: lines.length,
      column_utf16: last.length + 1,
    };
    return { ok: true, value: deepFreeze(value) };
  }
  if (!Number.isInteger(atLine) || atLine < 1 || atLine > lines.length) {
    return rejected("INVALID_LOCATION", `insertion line ${String(atLine)} is outside the 1..${lines.length} logical lines of this document: targets are never padded or clamped`);
  }
  let offset = 0;
  for (let index = 0; index < atLine - 1; index += 1) {
    offset += (lines[index] ?? "").length + 1;
  }
  const value: TypeInsertion = { mode: "line_start", offset_utf16: offset, line: atLine, column_utf16: 1 };
  return { ok: true, value: deepFreeze(value) };
}

// ---------------------------------------------------------------------------
// Type plan (immutable, deterministic, main-held).
// ---------------------------------------------------------------------------

/** Strict envelope for the trusted plan identity (identifiers only). */
export const TypePlanEnvelopeSchema = z.strictObject({
  kind: z.literal("type_plan"),
  planner_version: z.literal(EDITOR_TYPE_PLANNER_VERSION),
  plan_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  session_id: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  document_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  operation_id: z.string().min(1).max(128),
});
export type TypePlanEnvelope = z.infer<typeof TypePlanEnvelopeSchema>;

/**
 * Immutable deterministic type plan: everything the future
 * execution/presentation phase needs, nothing it must recompute.
 * Main-held and deeply frozen. Logical identifiers and text digests only:
 * no host path, no workspace path, no container identity, no capability
 * token exists in this DTO by construction.
 */
export interface TypePlan {
  readonly kind: "type_plan";
  readonly planner_version: 1;
  readonly plan_id: string;
  readonly session_id: string;
  readonly generation: number;
  readonly document_id: string;
  readonly portable_path: string;
  readonly operation_id: string;
  readonly attempt_id: string;
  readonly base_buffer_revision: number;
  readonly base_disk_revision: number;
  readonly base_digest: string | null;
  readonly base_byte_length: number;
  readonly base_utf16_length: number;
  readonly insertion: TypeInsertion;
  readonly source_text: string;
  readonly source_byte_length: number;
  readonly units: readonly string[];
  readonly unit_start_utf16: readonly number[];
  readonly unit_count: number;
  readonly expected_text: string;
  readonly expected_digest: string;
  readonly expected_byte_length: number;
  readonly expected_utf16_length: number;
  readonly segmentation: string;
  readonly policy_profile: TypingProfile;
  readonly policy_digest: string;
}

function deterministicPlanId(args: {
  sessionId: string;
  generation: number;
  documentId: string;
  operationId: string;
  baseBufferRevision: number;
  baseDigest: string | null;
  offsetUtf16: number;
  sourceText: string;
  segmentation: string;
  policyDigest: string;
}): string {
  const canonical = JSON.stringify({
    kind: "type_plan",
    planner_version: EDITOR_TYPE_PLANNER_VERSION,
    session_id: args.sessionId,
    generation: args.generation,
    document_id: args.documentId,
    operation_id: args.operationId,
    base_buffer_revision: args.baseBufferRevision,
    base_digest: args.baseDigest,
    offset_utf16: args.offsetUtf16,
    source_text: args.sourceText,
    segmentation: args.segmentation,
    policy_digest: args.policyDigest,
  });
  return `tp-${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Plan one admitted type_code operation against its live B0.
 *
 * Inputs are the live EditorSession handle plus the frozen P6.6 admission
 * only: path, content, at_line and ordering all resolve from reviewed
 * compiled IR through that admission. There is deliberately no
 * planByText/document/text/position overload: renderer-supplied text,
 * targets and timing cannot reach this function (the session handle is
 * unforgeable and the admission envelope is strict identifier-only at the
 * P6.6 boundary).
 *
 * Zero mutation: the registry, disk bytes, dirty flags and revisions are
 * only read. Over-budget inputs reject RESOURCE_LIMIT before any lifecycle
 * entry exists; location failures reject INVALID_LOCATION; profile failures
 * reject UNSUPPORTED_TEXT_PROFILE. All preserve B/D.
 */
export function planAdmittedTypeOperation(
  session: EditorSession,
  admission: EditorOperationAdmission,
): WorkspaceOutcome<TypePlan> {
  if (admission === null || typeof admission !== "object") {
    return rejected("INVALID_REQUEST", "type planning requires a P6.6 admission record, never raw text");
  }
  const record = (admission as EditorOperationAdmission).record;
  const parameters = (admission as EditorOperationAdmission).parameters;
  const admittedDocument = (admission as EditorOperationAdmission).document;
  if (record === null || typeof record !== "object" || parameters === null || typeof parameters !== "object") {
    return rejected("INVALID_REQUEST", "type planning requires a P6.6 admission record, never raw text");
  }
  const actionType = (record as { action_type?: unknown }).action_type;
  if (actionType !== "type_code") {
    return rejected("INVALID_REQUEST", `type planner runs admitted type operations only (got '${String(actionType)}')`);
  }
  if ((parameters as { type?: unknown }).type !== "type_code") {
    return rejected("INVALID_REQUEST", "type planner runs admitted type operations only (parameter mismatch)");
  }
  if (record.session_id !== session.sessionId) {
    return rejected("WRONG_OWNER", "admission names a foreign session");
  }
  if (record.generation !== session.generation) {
    return rejected("STALE_SESSION", "admission carries a stale session generation");
  }
  if (session.registry.retired) {
    return rejected("STALE_SESSION", "editor session was reset or closed: old admissions cannot plan");
  }
  if (!isLiveAdmissionDocument(session, admittedDocument)) {
    return rejected("STALE_SESSION", "admission document is not live in this generation");
  }
  const resolved = session.registry.resolveDocument(admittedDocument.document_id);
  if (!resolved.ok) return resolved as { ok: false; rejection: WorkspaceRejection };
  const live = resolved.value;
  if (live.externally_modified) {
    return rejected(
      "EXTERNAL_MODIFICATION_CONFLICT",
      "document base diverged from committed disk: explicit reload (clean) or reset (dirty/pending) is required, never a silent rebase",
    );
  }
  if (canonicalDocumentKey(live.portable_path) !== canonicalDocumentKey(record.portable_path)) {
    return rejected("INVALID_REQUEST", "admission document does not name the admitted target");
  }
  const buffered = session.registry.getBufferContent(live.document_id);
  if (!buffered.ok) {
    if (buffered.rejection.code === "STALE_SESSION") return buffered as { ok: false; rejection: WorkspaceRejection };
    return rejected("FILE_NOT_FOUND", "type target has no executed buffer: open or create it through the admitted execution path first");
  }
  const baseText = buffered.value;
  if (baseText.includes("\r")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "working text is outside the strict LF profile: CR bytes are never converted");
  }

  const authored = parameters as { content?: unknown; at_line?: unknown; path?: unknown };
  if (typeof authored.content !== "string") {
    return rejected("INVALID_REQUEST", "admitted type operation carries no executable text");
  }
  const sourceText: string = authored.content;
  let atLine: number | undefined;
  if (authored.at_line !== undefined) {
    if (!Number.isInteger(authored.at_line) || (authored.at_line as number) < 1) {
      return rejected("INVALID_REQUEST", "admitted insertion line must be a positive integer");
    }
    atLine = authored.at_line as number;
  }
  const profileProblems = authoredProfileProblems(sourceText);
  if (profileProblems.length > 0) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", `admitted text is outside the strict LF profile: ${profileProblems.join("; ")}`);
  }
  const sourceBytes = utf8ByteLength(sourceText);
  if (sourceBytes > TYPING_MAX_AUTHOR_UTF8_BYTES) {
    return rejected("RESOURCE_LIMIT", `admitted text exceeds the 1 MiB per-operation ceiling (${sourceBytes} bytes)`);
  }

  const insertionOutcome = resolveTypeInsertion(baseText, atLine);
  if (!insertionOutcome.ok) return insertionOutcome as { ok: false; rejection: WorkspaceRejection };
  const insertion = insertionOutcome.value;

  let units: readonly string[];
  try {
    units = segmentGraphemes(sourceText);
  } catch {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "authored text cannot be segmented under the pinned grapheme profile");
  }
  if (units.length > TYPING_MAX_UNITS) {
    return rejected("RESOURCE_LIMIT", `admitted text exceeds the bounded typing-unit ceiling (${units.length} units)`);
  }
  if (units.join("") !== sourceText) {
    return rejected("INVALID_REQUEST", "internal: grapheme segmentation drifted from the authored bytes");
  }

  const expectedText = baseText.slice(0, insertion.offset_utf16) + sourceText + baseText.slice(insertion.offset_utf16);
  if (expectedText.includes("\r")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "planned candidate is outside the strict LF profile: CR bytes are never introduced");
  }

  const policy = resolveTypingPolicyForUnitCount(units.length);
  const baseDigest = sha256HexText(baseText);
  const expectedDigest = sha256HexText(expectedText);
  const planId = deterministicPlanId({
    sessionId: session.sessionId,
    generation: session.generation,
    documentId: live.document_id,
    operationId: record.operation_id,
    baseBufferRevision: live.buffer_revision,
    baseDigest,
    offsetUtf16: insertion.offset_utf16,
    sourceText,
    segmentation: TYPING_SEGMENTATION_ID,
    policyDigest: policy.policy_digest,
  });

  const starts: number[] = [];
  let cursor = insertion.offset_utf16;
  for (const unit of units) {
    starts.push(cursor);
    cursor += unit.length;
  }

  const plan: TypePlan = {
    kind: "type_plan",
    planner_version: EDITOR_TYPE_PLANNER_VERSION,
    plan_id: planId,
    session_id: session.sessionId,
    generation: session.generation,
    document_id: live.document_id,
    portable_path: live.portable_path,
    operation_id: record.operation_id,
    attempt_id: record.attempt_id,
    base_buffer_revision: live.buffer_revision,
    base_disk_revision: live.base_disk_revision,
    base_digest: baseDigest,
    base_byte_length: utf8ByteLength(baseText),
    base_utf16_length: baseText.length,
    insertion,
    source_text: sourceText,
    source_byte_length: sourceBytes,
    units,
    unit_start_utf16: Object.freeze([...starts]),
    unit_count: units.length,
    expected_text: expectedText,
    expected_digest: expectedDigest,
    expected_byte_length: utf8ByteLength(expectedText),
    expected_utf16_length: expectedText.length,
    segmentation: TYPING_SEGMENTATION_ID,
    policy_profile: policy.profile,
    policy_digest: policy.policy_digest,
  };
  const envelopeCheck = TypePlanEnvelopeSchema.safeParse({
    kind: plan.kind,
    planner_version: plan.planner_version,
    plan_id: plan.plan_id,
    session_id: plan.session_id,
    generation: plan.generation,
    document_id: plan.document_id,
    operation_id: plan.operation_id,
  });
  if (!envelopeCheck.success) {
    return rejected("INVALID_REQUEST", "internal: issued type plan failed strict validation");
  }
  return { ok: true, value: deepFreeze(plan) };
}

// ---------------------------------------------------------------------------
// Deterministic schedule (pure, integer microseconds, frozen before display).
// ---------------------------------------------------------------------------

/** One logical typing unit with its frozen due time and UTF-16 boundaries. */
export interface TypeScheduleUnit {
  readonly index: number;
  readonly due_us: number;
  readonly start_utf16: number;
  readonly end_utf16: number;
}

/** One presentation batch (large blocks group up to 32 units, stopping at LF). */
export interface TypeScheduleGroup {
  readonly group_seq: number;
  readonly unit_start: number;
  readonly unit_end_exclusive: number;
  readonly due_us: number;
}

/**
 * Immutable deterministic schedule: logical time only, never wall-clock.
 * The same plan always yields the identical schedule (deep-equal). Timing
 * changes may change duration, never the planned candidate bytes.
 */
export interface TypeSchedule {
  readonly kind: "type_schedule";
  readonly scheduler_version: 1;
  readonly plan_id: string;
  readonly operation_id: string;
  readonly document_id: string;
  readonly policy_profile: TypingProfile;
  readonly policy_digest: string;
  readonly base_interval_us: number;
  readonly units: readonly TypeScheduleUnit[];
  readonly groups: readonly TypeScheduleGroup[];
  readonly unit_count: number;
  readonly total_duration_us: number;
  readonly presentation_timeout_us: number;
}

function pauseAfterCluster(previous: string, policy: TypingPolicy): number {
  if (previous.length === 0) return 0;
  const points = Array.from(previous);
  const last = points[points.length - 1] ?? "";
  if (last === "\n") return policy.newline_pause_us;
  if (last === "." || last === "," || last === ";" || last === ":" || last === "!" || last === "?") {
    return policy.punctuation_pause_us;
  }
  if (last === " " || last === "	") return policy.space_pause_us;
  return 0;
}

/**
 * Derive the frozen logical schedule for one plan. Pure and deterministic:
 * no randomness, no clock reads. The first unit is due at logical zero;
 * each later unit adds the profile base interval plus the pause determined
 * by the previous cluster (newline takes precedence). Large inserts use the
 * fast profile with groups of up to 32 units stopping at LF; the group due
 * time is its last member cumulative due time. Small inserts group 1:1.
 */
export function scheduleTypePlan(plan: TypePlan): WorkspaceOutcome<TypeSchedule> {
  if (plan === null || typeof plan !== "object" || plan.kind !== "type_plan") {
    return rejected("INVALID_REQUEST", "scheduling requires a P6.8 type plan, never raw text");
  }
  if (plan.planner_version !== EDITOR_TYPE_PLANNER_VERSION) {
    return rejected("INVALID_REQUEST", "type plan carries an unsupported planner version");
  }
  if (!Array.isArray(plan.units) || !Array.isArray(plan.unit_start_utf16)) {
    return rejected("INVALID_REQUEST", "type plan carries malformed typing units");
  }
  if (plan.units.length !== plan.unit_start_utf16.length) {
    return rejected("INVALID_REQUEST", "type plan unit boundaries do not match its typing units");
  }
  if (plan.units.join("") !== plan.source_text) {
    return rejected("INVALID_REQUEST", "type plan units drifted from the authored source text");
  }
  const policy = plan.policy_profile === "fast" ? FAST_TYPING_POLICY : DEFAULT_TYPING_POLICY;
  if (plan.policy_digest !== policy.policy_digest) {
    return rejected("INVALID_REQUEST", "type plan binds a different timing policy digest than its profile selects");
  }
  if (plan.unit_count !== plan.units.length) {
    return rejected("INVALID_REQUEST", "type plan unit count does not match its typing units");
  }

  const units: TypeScheduleUnit[] = [];
  let due = 0;
  for (let index = 0; index < plan.units.length; index += 1) {
    if (index === 0) {
      due = 0;
    } else {
      due += policy.base_interval_us + pauseAfterCluster(plan.units[index - 1] ?? "", policy);
    }
    const start = plan.unit_start_utf16[index] ?? 0;
    const end = start + (plan.units[index] ?? "").length;
    units.push({ index, due_us: due, start_utf16: start, end_utf16: end });
  }
  const total = units.length === 0 ? 0 : (units[units.length - 1]?.due_us ?? 0);
  if (total > TYPING_MAX_SCHEDULE_DURATION_US) {
    return rejected("RESOURCE_LIMIT", `planned schedule cannot fit the bounded session time (${total}us exceeds the ceiling)`);
  }

  const groups: TypeScheduleGroup[] = [];
  if (plan.policy_profile === "fast") {
    let cursor = 0;
    let seq = 0;
    while (cursor < units.length) {
      let end = Math.min(cursor + TYPING_MAX_GROUP_CLUSTERS, units.length);
      for (let scan = cursor; scan < end; scan += 1) {
        if (plan.units[scan] === "\n") {
          end = scan + 1;
          break;
        }
      }
      const lastDue = units[end - 1]?.due_us ?? 0;
      groups.push({ group_seq: seq, unit_start: cursor, unit_end_exclusive: end, due_us: lastDue });
      seq += 1;
      cursor = end;
    }
  } else {
    for (let index = 0; index < units.length; index += 1) {
      groups.push({ group_seq: index, unit_start: index, unit_end_exclusive: index + 1, due_us: units[index]?.due_us ?? 0 });
    }
  }

  const schedule: TypeSchedule = {
    kind: "type_schedule",
    scheduler_version: 1,
    plan_id: plan.plan_id,
    operation_id: plan.operation_id,
    document_id: plan.document_id,
    policy_profile: plan.policy_profile,
    policy_digest: plan.policy_digest,
    base_interval_us: policy.base_interval_us,
    units: Object.freeze([...units]),
    groups: Object.freeze([...groups]),
    unit_count: units.length,
    total_duration_us: total,
    presentation_timeout_us: total + TYPING_PRESENTATION_TIMEOUT_EXTRA_US,
  };
  return { ok: true, value: deepFreeze(schedule) };
}

// ---------------------------------------------------------------------------
// Plan lifecycle (main-owned, manual logical clock, zero mutation).
// ---------------------------------------------------------------------------

/** Canonical scheduler states (pause/resume deliberately absent: P8 owns beats). */
export type TypePlanStatus = "planned" | "running" | "completed" | "cancelled" | "failed";

export interface TypePlanView {
  readonly plan: TypePlan;
  readonly schedule: TypeSchedule;
  readonly status: TypePlanStatus;
  readonly elapsed_us: number;
  readonly next_unit_index: number;
}

export interface TypeAdvanceResult {
  readonly plan: TypePlan;
  readonly schedule: TypeSchedule;
  readonly status: TypePlanStatus;
  readonly elapsed_us: number;
  readonly next_unit_index: number;
  readonly completed: boolean;
}

interface RuntimeEntry {
  plan: TypePlan;
  schedule: TypeSchedule;
  status: TypePlanStatus;
  elapsed_us: number;
  next_unit_index: number;
  canonicalKey: string;
}

export interface CreateTypePlannerOptions {
  readonly maxActive?: number;
}

/**
 * Main-owned type-plan lifecycle for one generation scope. The caller holds
 * the live EditorSession and presents it on every mutating call so reset,
 * close, generation rotation and buffer divergence fence deterministically.
 * The planner instance itself is clock-free: logical time advances only
 * through advancePlan with an explicit integer microsecond delta (manual
 * clock). There are no timers to cancel; completion, cancel, reset, close
 * and failure simply stop logical progress with zero buffer or disk effects.
 */
export interface TypePlanner {
  planOperation(session: EditorSession, admission: EditorOperationAdmission): WorkspaceOutcome<TypePlan>;
  getPlan(planId: string): TypePlan | null;
  getSchedule(planId: string): TypeSchedule | null;
  getStatus(planId: string): TypePlanStatus | null;
  startPlan(session: EditorSession, planId: string): WorkspaceOutcome<TypeSchedule>;
  advancePlan(session: EditorSession, planId: string, deltaUs: number): WorkspaceOutcome<TypeAdvanceResult>;
  cancelPlan(session: EditorSession, planId: string): WorkspaceOutcome<TypePlanView>;
  invalidateAll(): void;
  listPlans(): readonly TypePlanView[];
}

function liveFenceForEntry(session: EditorSession, entry: RuntimeEntry): WorkspaceRejection | null {
  if (session.registry.retired) {
    return { code: "STALE_SESSION", message: "editor session was reset or closed: old type plans cannot advance" };
  }
  if (entry.plan.session_id !== session.sessionId) {
    return { code: "WRONG_OWNER", message: "type plan belongs to a foreign session" };
  }
  if (entry.plan.generation !== session.generation) {
    return { code: "STALE_SESSION", message: "type plan carries a stale session generation" };
  }
  const resolved = session.registry.resolveDocument(entry.plan.document_id);
  if (!resolved.ok) {
    return { code: "STALE_SESSION", message: "type plan document is no longer live in this generation" };
  }
  const live = resolved.value;
  if (live.externally_modified) {
    return {
      code: "EXTERNAL_MODIFICATION_CONFLICT",
      message: "document base diverged from committed disk: old type plan is stale, never silently rebased",
    };
  }
  if (live.buffer_revision !== entry.plan.base_buffer_revision) {
    return {
      code: "EXTERNAL_MODIFICATION_CONFLICT",
      message: "document buffer revision moved after this plan was created: old plan is stale",
    };
  }
  const current = session.registry.getBufferContent(live.document_id);
  if (!current.ok) {
    return { code: "STALE_SESSION", message: "type plan buffer is no longer available in this generation" };
  }
  if (sha256HexText(current.value) !== entry.plan.base_digest) {
    return {
      code: "EXTERNAL_MODIFICATION_CONFLICT",
      message: "document buffer bytes moved after this plan was created: old plan is stale",
    };
  }
  return null;
}

export function createTypePlanner(options: CreateTypePlannerOptions = {}): TypePlanner {
  const maxActive = options.maxActive ?? TYPING_MAX_ACTIVE_PLANS;
  const byPlan = new Map<string, RuntimeEntry>();
  const byOperation = new Map<string, string>();
  const activeByDocument = new Map<string, string>();

  function operationScopeKey(plan: TypePlan): string {
    return `${plan.session_id}|${plan.generation}|${plan.operation_id}`;
  }

  function viewOf(entry: RuntimeEntry): TypePlanView {
    return deepFreeze({
      plan: entry.plan,
      schedule: entry.schedule,
      status: entry.status,
      elapsed_us: entry.elapsed_us,
      next_unit_index: entry.next_unit_index,
    });
  }

  const planner: TypePlanner = {
    planOperation(session: EditorSession, admission: EditorOperationAdmission): WorkspaceOutcome<TypePlan> {
      const planned = planAdmittedTypeOperation(session, admission);
      if (!planned.ok) return planned;
      const plan = planned.value;
      const scheduled = scheduleTypePlan(plan);
      if (!scheduled.ok) return scheduled as { ok: false; rejection: WorkspaceRejection };
      const schedule = scheduled.value;

      const scopeKey = operationScopeKey(plan);
      const knownPlanId = byOperation.get(scopeKey);
      if (knownPlanId !== undefined) {
        const known = byPlan.get(knownPlanId);
        if (known !== undefined) {
          if (known.plan.plan_id === plan.plan_id) return { ok: true, value: known.plan };
          return rejected("INVALID_REQUEST", "operation attempt is already consumed in this generation: replay converges on the admitted plan");
        }
      }

      const canonicalKey = canonicalDocumentKey(plan.portable_path);
      const activePlanId = activeByDocument.get(canonicalKey);
      if (activePlanId !== undefined) {
        const active = byPlan.get(activePlanId);
        if (active !== undefined && (active.status === "planned" || active.status === "running")) {
          return rejected("INVALID_REQUEST", "another type operation is already active for this document: operations serialize deterministically");
        }
      }

      let activeCount = 0;
      for (const entry of byPlan.values()) {
        if (entry.status === "planned" || entry.status === "running") activeCount += 1;
      }
      if (activeCount >= maxActive) {
        return rejected("RESOURCE_LIMIT", `bounded type planner holds at most ${maxActive} live plans`);
      }

      const entry: RuntimeEntry = {
        plan,
        schedule,
        status: "planned",
        elapsed_us: 0,
        next_unit_index: 0,
        canonicalKey,
      };
      byPlan.set(plan.plan_id, entry);
      byOperation.set(scopeKey, plan.plan_id);
      activeByDocument.set(canonicalKey, plan.plan_id);
      return { ok: true, value: plan };
    },

    getPlan(planId: string): TypePlan | null {
      return byPlan.get(planId)?.plan ?? null;
    },

    getSchedule(planId: string): TypeSchedule | null {
      return byPlan.get(planId)?.schedule ?? null;
    },

    getStatus(planId: string): TypePlanStatus | null {
      return byPlan.get(planId)?.status ?? null;
    },

    startPlan(session: EditorSession, planId: string): WorkspaceOutcome<TypeSchedule> {
      const entry = byPlan.get(planId);
      if (entry === undefined) {
        if (session.registry.retired) {
          return rejected("STALE_SESSION", "editor session was reset or closed: unknown type plan cannot start");
        }
        return rejected("INVALID_REQUEST", "unknown type plan");
      }
      if (entry.status === "completed" || entry.status === "cancelled" || entry.status === "failed") {
        return rejected("INVALID_REQUEST", "type plan already reached its final state: completion is already final and start never replays");
      }
      if (entry.status === "running") return { ok: true, value: entry.schedule };
      const fenced = liveFenceForEntry(session, entry);
      if (fenced !== null) {
        entry.status = "failed";
        if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
        return { ok: false, rejection: fenced };
      }
      entry.status = "running";
      if (entry.schedule.unit_count === 0) {
        entry.status = "completed";
        if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
      }
      return { ok: true, value: entry.schedule };
    },

    advancePlan(session: EditorSession, planId: string, deltaUs: number): WorkspaceOutcome<TypeAdvanceResult> {
      const entry = byPlan.get(planId);
      if (entry === undefined) {
        if (session.registry.retired) {
          return rejected("STALE_SESSION", "editor session was reset or closed: unknown type plan cannot advance");
        }
        return rejected("INVALID_REQUEST", "unknown type plan");
      }
      if (entry.status === "planned") {
        return rejected("INVALID_REQUEST", "type plan is not running: start it before advancing the logical clock");
      }
      if (entry.status === "completed" || entry.status === "cancelled" || entry.status === "failed") {
        return rejected("INVALID_REQUEST", "type plan already reached its final state: no further logical progress");
      }
      if (!Number.isInteger(deltaUs) || deltaUs < 0) {
        return rejected("INVALID_REQUEST", "logical clock advances by a non-negative integer microsecond delta");
      }
      const fenced = liveFenceForEntry(session, entry);
      if (fenced !== null) {
        entry.status = "failed";
        if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
        return { ok: false, rejection: fenced };
      }
      entry.elapsed_us += deltaUs;
      while (
        entry.next_unit_index < entry.schedule.units.length &&
        (entry.schedule.units[entry.next_unit_index]?.due_us ?? Number.MAX_SAFE_INTEGER) <= entry.elapsed_us
      ) {
        entry.next_unit_index += 1;
      }
      let completed = false;
      if (entry.next_unit_index >= entry.schedule.units.length && entry.elapsed_us >= entry.schedule.total_duration_us) {
        entry.status = "completed";
        completed = true;
        if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
      }
      const result: TypeAdvanceResult = {
        plan: entry.plan,
        schedule: entry.schedule,
        status: entry.status,
        elapsed_us: entry.elapsed_us,
        next_unit_index: entry.next_unit_index,
        completed,
      };
      return { ok: true, value: deepFreeze(result) };
    },

    cancelPlan(session: EditorSession, planId: string): WorkspaceOutcome<TypePlanView> {
      const entry = byPlan.get(planId);
      if (entry === undefined) {
        if (session.registry.retired) {
          return rejected("STALE_SESSION", "editor session was reset or closed: unknown type plan cannot cancel");
        }
        return rejected("INVALID_REQUEST", "unknown type plan");
      }
      if (entry.status === "completed") {
        return rejected("INVALID_REQUEST", "type plan already completed: completion is already final and never reverts");
      }
      if (entry.status === "cancelled" || entry.status === "failed") {
        return rejected("INVALID_REQUEST", "type plan already reached its final state");
      }
      const fenced = liveFenceForEntry(session, entry);
      if (fenced !== null && fenced.code === "STALE_SESSION") {
        entry.status = "failed";
        if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
        return { ok: false, rejection: fenced };
      }
      entry.status = "cancelled";
      if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
      return { ok: true, value: viewOf(entry) };
    },

    invalidateAll(): void {
      byPlan.clear();
      byOperation.clear();
      activeByDocument.clear();
    },

    listPlans(): readonly TypePlanView[] {
      return Object.freeze([...byPlan.values()].map((entry) => viewOf(entry)));
    },
  };

  return planner;
}
