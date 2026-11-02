// P6.9 deterministic exact replacement planner — plan admitted replace_code
// operations only, with zero buffer or disk mutation.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 4 (trust boundary:
// validated IR -> main-only reviewed catalog -> editor admission -> immutable
// semantic plan -> trusted working document), 5 (editor authority: main owns
// per-file working text; each edit has preimage B0, candidate B1, hashes,
// revision, exact UTF-16 ranges, generation and plan ID; B0 stays committed
// while animation projects prefixes of B1; on completion main installs B1;
// on cancel/failure main keeps B0; disk remains D0), 7 (operation model and
// admission: operation_id := step_id; one attempt per operation with
// tombstones; authored editor order), 9 (replace_code semantics: exact
// case-sensitive non-overlapping matches in B0 scanning left-to-right,
// advance by find length, never search newly inserted replacement text;
// default expected count 1; zero -> FIND_NOT_FOUND; any positive count
// different from occurrences -> OCCURRENCE_MISMATCH; equal count -> replace
// all matched ranges simultaneously from B0; `aaa` with find `aa` has one
// non-overlapping match; empty replacement deletes; empty find is
// schema-invalid; no normalization or regex; plan all ranges before
// animation; present replacements in ascending original order with derived
// offset adjustments; highlight/remove each exact span and type its
// replacement; one transaction even for many matches; cancellation restores
// all of B0; unchanged replacement is a successful no-op), 12 (strict LF
// profile: reject CR/CRLF/BOM/NUL/unpaired surrogates with
// UNSUPPORTED_TEXT_PROFILE, never convert; no NFC/NFKC; Monaco positions in
// UTF-16 units, byte hashes in UTF-8, never confused), 18 (1 MiB UTF-8 per
// file/result; 16 MiB total working documents; reject over-budget before
// mutation, never truncate), 21 (admission errors zero side effects;
// planning errors preserve B/D) and 26.5 (buffer stores base disk
// revision/digest/existence plus independent buffer revision) with
// docs/adr/ADR-0011-shared-workspace-ownership.md decision 5 (main owns
// unsaved text; disk owns committed text; terminal reads committed disk).
//
// Canonical P6.9 name: P6.9 Exact replacement.
// Objective: match guards and transactional visual plan.
//
// THE CENTRAL SEMANTIC PROPERTIES (proven by the P6.9 suite, not by types):
//   1. Authoritative text comes ONLY from the reviewed admitted replace_code
//      operation (resolved through the P6.6 admission record). This module
//      exposes no generic replace(document, find, replace) entry point: the
//      planner takes the live EditorSession handle plus the frozen admission
//      only. Renderer compromise cannot choose bytes, targets, match indices
//      or occurrence expectations.
//   2. Matching is exact literal semantics only: case-sensitive,
//      non-overlapping, left-to-right over JS string (UTF-16 code-unit)
//      positions, advancing by find length past each hit and never scanning
//      newly inserted replacement text. No trimming, case-folding,
//      normalization, whitespace collapsing, line-ending conversion, fuzzy
//      scoring, regular expressions, AST matching or search heuristics exist
//      anywhere on this path (proven by static scans plus behavioral
//      goldens). The module constructs no RegExp and calls no
//      match/search/replace string method.
//   3. The occurrence guard is exact: expected count (authored occurrences,
//      default 1) must equal the enumerated actual count. Zero actual
//      matches reject FIND_NOT_FOUND; any positive actual count different
//      from expected rejects OCCURRENCE_MISMATCH — including several matches
//      under the default of 1. The planner never silently replaces the first
//      match, never replaces all on mismatch, and never asks the renderer.
//   4. The candidate B1 is built simultaneously from B0 in one linear pass
//      (segment join, never repeated whole-string copies): either every
//      canonical replacement applies or the plan rejects with B0 preserved
//      exactly. All guard checks finish before any candidate assembly that
//      could be mistaken for progress, and no partial replacement can
//      remain: the registry buffer is never written here at all.
//   5. The visual plan is engine-only data: per match in ascending original
//      order, exactly three deterministic steps (highlight the exact span,
//      remove the exact span, insert the replacement text) with both the
//      original B0 ranges and the offset-adjusted live ranges. The semantic
//      B1 is fully known before the first visual step exists; presentation
//      can never change it. Simulating the steps in order reproduces B1
//      exactly; any strict prefix does not. Monaco itself is untouched
//      (P6.12 owns wiring); ranges are already canonical UTF-16 line/column
//      positions for that future boundary.
//   6. Plans bind the exact live document revision and generation they were
//      created from. Stale buffer bytes, retired sessions and rotated
//      generations fence before any progress, with zero mutation.
//   7. P6.9 plans only (like P6.8): the registry buffer, disk bytes, dirty
//      accounting and buffer revisions are NEVER written here. The P6.6
//      dirty reservation stands as admitted; buffer-revision advances and
//      B1 installation belong to the future presentation/commit phase.
//      Disk stays byte-identical (P5 keeps seeing committed bytes); the
//      publication name appears nowhere in this file by construction.
//
// Owned scope (and only this):
//   - enumerateReplaceMatches: exact non-overlapping match enumeration.
//   - replaceLineColumn: LF line geometry to exact UTF-16 line/column.
//   - planAdmittedReplaceOperation: pure admission + live B0 -> frozen
//     ReplacePlan (B0/B1 with digests, exact matches, transactional visual
//     steps, occurrence binding).
//   - createReplacePlanner: main-owned plan lifecycle (planned/running/
//     completed/cancelled/failed) over a manual step clock, with
//     per-document serialization, idempotent replay convergence, cancel with
//     zero mutation, and reset/close invalidation. No timers, no sleeps.
//
// Explicit non-scope (owned by later tasks, represented here only as
// fail-closed rejections or not at all):
//   - buffer installation and buffer-revision advances (future
//     presentation/commit phase; P6.6 reservation semantics preserved here);
//   - verified persistence, journals and disk publication (later save task;
//     the publication name appears nowhere in this file by construction);
//   - typing geometry beyond shared line math (later task owns its planner);
//   - cancel/reset/replay beyond plan invalidation (later lifecycle task);
//   - IPC/preload/Monaco wiring and visual presentation (later tasks; no
//     model edits, no frames, no keyboard synthesis here);
//   - terminal interop beyond the unchanged buffer-facts seam;
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

/** Planner protocol version (matches the workspace protocol). */
export const EDITOR_REPLACE_PLANNER_VERSION = 1;

/** Default expected occurrence count when the authored operation omits it (spec section 9). */
export const REPLACE_DEFAULT_OCCURRENCES = 1;
/** Authored find/replace ceiling each (spec section 18: 1 MiB UTF-8 per file/result). */
export const REPLACE_MAX_AUTHOR_UTF8_BYTES = 1048576;
/** Working-document ceiling (spec section 18: 16 MiB total working documents). */
export const REPLACE_MAX_BUFFER_UTF8_BYTES = 16777216;
/** Absolute match ceiling: enumeration stops past this many hits (fail-closed, never truncated). */
export const REPLACE_MAX_MATCHES = 10000;
/** Bounded live plans per planner instance (planned + running). */
export const REPLACE_MAX_ACTIVE_PLANS = 32;

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
  if (value.includes("﻿")) problems.push("BOM is not allowed inside authored text");
  return problems;
}

// ---------------------------------------------------------------------------
// Exact literal match enumeration (no patterns, no heuristics).
// ---------------------------------------------------------------------------

/**
 * Enumerate exact non-overlapping occurrences of find in baseText,
 * scanning left-to-right and advancing by find length past each hit
 * (spec section 9). Case-sensitive, code-unit exact, never rescanning
 * replacement text (replacement is not an input here at all). The
 * canonical overlap rule falls out of the advance: `aaa` with find `aa`
 * yields exactly start [0] (the next search starts at offset 2, where no
 * second `aa` remains); `aaaa` with find `aa` yields [0, 2].
 *
 * Empty find rejects INVALID_REQUEST (schema-invalid: the canonical
 * contract requires find min 1, so admission can never carry it; this is
 * the defense-in-depth boundary that also prevents pathological infinite
 * enumeration). Past-ceiling hit counts reject RESOURCE_LIMIT instead of
 * truncating.
 */
export function enumerateReplaceMatches(baseText: string, find: string): WorkspaceOutcome<readonly number[]> {
  if (typeof find !== "string" || find.length === 0) {
    return rejected("INVALID_REQUEST", "replacement find text must be a non-empty literal: empty find is schema-invalid");
  }
  const starts: number[] = [];
  let cursor = 0;
  for (;;) {
    const at = baseText.indexOf(find, cursor);
    if (at === -1) break;
    starts.push(at);
    if (starts.length > REPLACE_MAX_MATCHES) {
      return rejected("RESOURCE_LIMIT", `replacement match enumeration exceeds the bounded match ceiling (${REPLACE_MAX_MATCHES} matches)`);
    }
    cursor = at + find.length;
  }
  return { ok: true, value: Object.freeze([...starts]) };
}

/** Exact UTF-16 line/column position (Monaco columns are UTF-16 units). */
export interface ReplacePosition {
  readonly line: number;
  readonly column_utf16: number;
}

/**
 * Translate one UTF-16 offset in LF-only text to its canonical line and
 * UTF-16 column. Logical lines follow the frozen LF model (LF count + 1;
 * the empty trailing line is addressable). Because splitting happens only
 * on LF (a BMP scalar), JS string offsets already are UTF-16 units, so no
 * grapheme/column conversion exists: surrogate pairs before the offset
 * count 2, exactly as Monaco columns do.
 */
export function replaceLineColumn(baseText: string, offsetUtf16: number): ReplacePosition {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offsetUtf16; index += 1) {
    if (baseText[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return deepFreeze({ line, column_utf16: offsetUtf16 - lineStart + 1 });
}

// ---------------------------------------------------------------------------
// Replace plan (immutable, deterministic, main-held).
// ---------------------------------------------------------------------------

/** Strict envelope for the trusted plan identity (identifiers only). */
export const ReplacePlanEnvelopeSchema = z.strictObject({
  kind: z.literal("replace_plan"),
  planner_version: z.literal(EDITOR_REPLACE_PLANNER_VERSION),
  plan_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  session_id: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  document_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  operation_id: z.string().min(1).max(128),
});
export type ReplacePlanEnvelope = z.infer<typeof ReplacePlanEnvelopeSchema>;

/** One exact match range in B0 (UTF-16 offsets with canonical line/column). */
export interface ReplaceMatch {
  readonly index: number;
  readonly start_utf16: number;
  readonly end_utf16: number;
  readonly start: ReplacePosition;
  readonly end: ReplacePosition;
}

/** One deterministic visual step of the transactional visual plan. */
export interface ReplaceVisualStep {
  readonly seq: number;
  readonly kind: "highlight" | "remove" | "insert";
  /** Zero-based match this step belongs to (ascending original order). */
  readonly match_index: number;
  /** Exact span in the original B0 coordinates. */
  readonly original_start_utf16: number;
  readonly original_end_utf16: number;
  /**
   * Exact span in the live buffer coordinates after all earlier matches
   * were replaced (derived offset adjustment). For insert steps the span
   * is empty (start == end): the caret where replacement text is typed.
   * Highlight and remove steps carry the span to select and delete.
   */
  readonly adjusted_start_utf16: number;
  readonly adjusted_end_utf16: number;
  /** Replacement text for insert steps; empty for highlight/remove steps. */
  readonly text: string;
}

/**
 * Immutable deterministic replace plan: everything the future
 * execution/presentation phase needs, nothing it must recompute.
 * Main-held and deeply frozen. Logical identifiers, literal authored text
 * and digests only: no host path, no workspace path, no container
 * identity, no capability token exists in this DTO by construction.
 */
export interface ReplacePlan {
  readonly kind: "replace_plan";
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
  readonly base_digest: string;
  readonly base_byte_length: number;
  readonly base_utf16_length: number;
  readonly find_text: string;
  readonly find_byte_length: number;
  readonly replace_text: string;
  readonly replace_byte_length: number;
  readonly expected_occurrences: number;
  readonly actual_match_count: number;
  readonly matches: readonly ReplaceMatch[];
  readonly expected_text: string;
  readonly expected_digest: string;
  readonly expected_byte_length: number;
  readonly expected_utf16_length: number;
  /** False exactly when the operation is a successful no-op (find == replace). */
  readonly changed: boolean;
  readonly visual_steps: readonly ReplaceVisualStep[];
  readonly visual_step_count: number;
}

function deterministicPlanId(args: {
  sessionId: string;
  generation: number;
  documentId: string;
  operationId: string;
  baseBufferRevision: number;
  baseDigest: string;
  findLiteral: string;
  replaceLiteral: string;
  expectedOccurrences: number;
}): string {
  const canonical = JSON.stringify({
    kind: "replace_plan",
    planner_version: EDITOR_REPLACE_PLANNER_VERSION,
    session_id: args.sessionId,
    generation: args.generation,
    document_id: args.documentId,
    operation_id: args.operationId,
    base_buffer_revision: args.baseBufferRevision,
    base_digest: args.baseDigest,
    find_text: args.findLiteral,
    replace_text: args.replaceLiteral,
    expected_occurrences: args.expectedOccurrences,
  });
  return `rp-${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Plan one admitted replace_code operation against its live B0.
 *
 * Inputs are the live EditorSession handle plus the frozen P6.6 admission
 * only: path, find, replace and occurrences all resolve from reviewed
 * compiled IR through that admission. There is deliberately no
 * replaceByText/document/find/replace overload: renderer-supplied find
 * text, replacement text, match indices, occurrence overrides, regex
 * flags, positions and revision authority cannot reach this function (the
 * session handle is unforgeable and the admission envelope is strict
 * identifier-only at the P6.6 boundary).
 *
 * Zero mutation: the registry, disk bytes, dirty flags and revisions are
 * only read. Guard failures (FIND_NOT_FOUND, OCCURRENCE_MISMATCH) and
 * over-budget inputs (RESOURCE_LIMIT) reject before any candidate exists;
 * profile failures reject UNSUPPORTED_TEXT_PROFILE. All preserve B/D.
 */
export function planAdmittedReplaceOperation(
  session: EditorSession,
  admission: EditorOperationAdmission,
): WorkspaceOutcome<ReplacePlan> {
  if (admission === null || typeof admission !== "object") {
    return rejected("INVALID_REQUEST", "replacement planning requires a P6.6 admission record, never raw text");
  }
  const record = (admission as EditorOperationAdmission).record;
  const parameters = (admission as EditorOperationAdmission).parameters;
  const admittedDocument = (admission as EditorOperationAdmission).document;
  if (record === null || typeof record !== "object" || parameters === null || typeof parameters !== "object") {
    return rejected("INVALID_REQUEST", "replacement planning requires a P6.6 admission record, never raw text");
  }
  const actionType = (record as { action_type?: unknown }).action_type;
  if (actionType !== "replace_code") {
    return rejected("INVALID_REQUEST", `replace planner runs admitted replace operations only (got '${String(actionType)}')`);
  }
  if ((parameters as { type?: unknown }).type !== "replace_code") {
    return rejected("INVALID_REQUEST", "replace planner runs admitted replace operations only (parameter mismatch)");
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
    return rejected("FILE_NOT_FOUND", "replacement target has no executed buffer: open or create it through the admitted execution path first");
  }
  const baseText = buffered.value;
  if (baseText.includes("\r")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "working text is outside the strict LF profile: CR bytes are never converted");
  }
  const baseBytes = utf8ByteLength(baseText);
  if (baseBytes > REPLACE_MAX_BUFFER_UTF8_BYTES) {
    return rejected("RESOURCE_LIMIT", `working document exceeds the 16 MiB working-document ceiling (${baseBytes} bytes)`);
  }

  const authored = parameters as { find?: unknown; replace?: unknown; occurrences?: unknown };
  if (typeof authored.find !== "string" || typeof authored.replace !== "string") {
    return rejected("INVALID_REQUEST", "admitted replacement operation carries no executable find/replace literals");
  }
  const findLiteral: string = authored.find;
  const replaceLiteral: string = authored.replace;
  let expectedOccurrences = REPLACE_DEFAULT_OCCURRENCES;
  if (authored.occurrences !== undefined) {
    if (!Number.isInteger(authored.occurrences) || (authored.occurrences as number) < 1) {
      return rejected("INVALID_REQUEST", "admitted occurrence expectation must be a positive integer");
    }
    expectedOccurrences = authored.occurrences as number;
  }
  if (findLiteral.length === 0) {
    return rejected("INVALID_REQUEST", "replacement find text must be a non-empty literal: empty find is schema-invalid");
  }
  const findProblems = authoredProfileProblems(findLiteral);
  if (findProblems.length > 0) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", `admitted find text is outside the strict LF profile: ${findProblems.join("; ")}`);
  }
  const replaceProblems = authoredProfileProblems(replaceLiteral);
  if (replaceProblems.length > 0) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", `admitted replacement text is outside the strict LF profile: ${replaceProblems.join("; ")}`);
  }
  const findBytes = utf8ByteLength(findLiteral);
  if (findBytes > REPLACE_MAX_AUTHOR_UTF8_BYTES) {
    return rejected("RESOURCE_LIMIT", `admitted find text exceeds the 1 MiB per-operation ceiling (${findBytes} bytes)`);
  }
  const replaceBytes = utf8ByteLength(replaceLiteral);
  if (replaceBytes > REPLACE_MAX_AUTHOR_UTF8_BYTES) {
    return rejected("RESOURCE_LIMIT", `admitted replacement text exceeds the 1 MiB per-operation ceiling (${replaceBytes} bytes)`);
  }

  // -- exact occurrence guard (all validation finishes before assembly) -----
  const enumerated = enumerateReplaceMatches(baseText, findLiteral);
  if (!enumerated.ok) return enumerated as { ok: false; rejection: WorkspaceRejection };
  const starts = enumerated.value;
  if (starts.length === 0) {
    return rejected("FIND_NOT_FOUND", "admitted find literal has no exact occurrence in the working document: no mutation, no revision advance");
  }
  if (starts.length !== expectedOccurrences) {
    return rejected(
      "OCCURRENCE_MISMATCH",
      `admitted find literal has ${starts.length} exact occurrences but the authored guard expects ${expectedOccurrences}: no partial replacement, no first-match fallback`,
    );
  }

  // -- simultaneous candidate assembly: one linear pass over B0 ------------
  const parts: string[] = [];
  let cursor = 0;
  for (const at of starts) {
    parts.push(baseText.slice(cursor, at));
    parts.push(replaceLiteral);
    cursor = at + findLiteral.length;
  }
  parts.push(baseText.slice(cursor));
  const expectedText = parts.join("");
  if (expectedText.includes("\r")) {
    return rejected("UNSUPPORTED_TEXT_PROFILE", "planned candidate is outside the strict LF profile: CR bytes are never introduced");
  }
  const expectedBytes = utf8ByteLength(expectedText);
  if (expectedBytes > REPLACE_MAX_BUFFER_UTF8_BYTES) {
    return rejected("RESOURCE_LIMIT", `planned candidate exceeds the 16 MiB working-document ceiling (${expectedBytes} bytes)`);
  }

  const changed = expectedText !== baseText;
  const matches: ReplaceMatch[] = starts.map((at, index) => {
    const end = at + findLiteral.length;
    return deepFreeze({
      index,
      start_utf16: at,
      end_utf16: end,
      start: replaceLineColumn(baseText, at),
      end: replaceLineColumn(baseText, end),
    });
  });

  // -- transactional visual plan: ascending original order with derived -----
  // -- offset adjustments (highlight/remove each exact span, insert its -----
  // -- replacement). A no-op (find == replace) presents zero steps and -----
  // -- completes immediately, mirroring the empty-content type no-op. ------
  const visualSteps: ReplaceVisualStep[] = [];
  if (changed) {
    let shift = 0;
    for (const [matchIndex, at] of starts.entries()) {
      const adjustedStart = at + shift;
      const adjustedEnd = adjustedStart + findLiteral.length;
      const seq = matchIndex * 3;
      visualSteps.push(
        deepFreeze({
          seq,
          kind: "highlight",
          match_index: matchIndex,
          original_start_utf16: at,
          original_end_utf16: at + findLiteral.length,
          adjusted_start_utf16: adjustedStart,
          adjusted_end_utf16: adjustedEnd,
          text: "",
        }),
        deepFreeze({
          seq: seq + 1,
          kind: "remove",
          match_index: matchIndex,
          original_start_utf16: at,
          original_end_utf16: at + findLiteral.length,
          adjusted_start_utf16: adjustedStart,
          adjusted_end_utf16: adjustedEnd,
          text: "",
        }),
        deepFreeze({
          seq: seq + 2,
          kind: "insert",
          match_index: matchIndex,
          original_start_utf16: at,
          original_end_utf16: at + findLiteral.length,
          adjusted_start_utf16: adjustedStart,
          adjusted_end_utf16: adjustedStart,
          text: replaceLiteral,
        }),
      );
      shift += replaceLiteral.length - findLiteral.length;
    }
  }

  const baseDigest = sha256HexText(baseText);
  const expectedDigest = sha256HexText(expectedText);
  const planId = deterministicPlanId({
    sessionId: session.sessionId,
    generation: session.generation,
    documentId: live.document_id,
    operationId: record.operation_id,
    baseBufferRevision: live.buffer_revision,
    baseDigest,
    findLiteral,
    replaceLiteral,
    expectedOccurrences,
  });

  const plan: ReplacePlan = {
    kind: "replace_plan",
    planner_version: EDITOR_REPLACE_PLANNER_VERSION,
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
    base_byte_length: baseBytes,
    base_utf16_length: baseText.length,
    find_text: findLiteral,
    find_byte_length: findBytes,
    replace_text: replaceLiteral,
    replace_byte_length: replaceBytes,
    expected_occurrences: expectedOccurrences,
    actual_match_count: starts.length,
    matches: Object.freeze([...matches]),
    expected_text: expectedText,
    expected_digest: expectedDigest,
    expected_byte_length: expectedBytes,
    expected_utf16_length: expectedText.length,
    changed,
    visual_steps: Object.freeze([...visualSteps]),
    visual_step_count: visualSteps.length,
  };
  const envelopeCheck = ReplacePlanEnvelopeSchema.safeParse({
    kind: plan.kind,
    planner_version: plan.planner_version,
    plan_id: plan.plan_id,
    session_id: plan.session_id,
    generation: plan.generation,
    document_id: plan.document_id,
    operation_id: plan.operation_id,
  });
  if (!envelopeCheck.success) {
    return rejected("INVALID_REQUEST", "internal: issued replace plan failed strict validation");
  }
  if (plan.matches.length !== plan.actual_match_count) {
    return rejected("INVALID_REQUEST", "internal: planned match ranges drifted from the occurrence guard");
  }
  if (plan.visual_step_count !== plan.visual_steps.length) {
    return rejected("INVALID_REQUEST", "internal: planned visual steps drifted from their count");
  }
  return { ok: true, value: deepFreeze(plan) };
}

// ---------------------------------------------------------------------------
// Transactional visual plan view (engine-only projection of one plan).
// ---------------------------------------------------------------------------

/**
 * Immutable engine-only visual plan: the deterministic presentation the
 * future Monaco boundary will project. Main-held and deeply frozen. No
 * host path, no container identity, no capability token exists here by
 * construction. The semantic candidate (expected_text) is already final:
 * presentation failure or cancel restores B0, never a prefix of B1.
 */
export interface ReplaceVisualPlan {
  readonly kind: "replace_visual_plan";
  readonly planner_version: 1;
  readonly plan_id: string;
  readonly operation_id: string;
  readonly document_id: string;
  readonly steps: readonly ReplaceVisualStep[];
  readonly step_count: number;
}

function visualPlanOf(plan: ReplacePlan): ReplaceVisualPlan {
  return deepFreeze({
    kind: "replace_visual_plan",
    planner_version: EDITOR_REPLACE_PLANNER_VERSION,
    plan_id: plan.plan_id,
    operation_id: plan.operation_id,
    document_id: plan.document_id,
    steps: plan.visual_steps,
    step_count: plan.visual_step_count,
  });
}

// ---------------------------------------------------------------------------
// Plan lifecycle (main-owned, manual step clock, zero mutation).
// ---------------------------------------------------------------------------

/** Canonical plan states (pause/resume deliberately absent: P8 owns beats). */
export type ReplacePlanStatus = "planned" | "running" | "completed" | "cancelled" | "failed";

export interface ReplacePlanView {
  readonly plan: ReplacePlan;
  readonly visual: ReplaceVisualPlan;
  readonly status: ReplacePlanStatus;
  readonly next_step_index: number;
}

export interface ReplaceAdvanceResult {
  readonly plan: ReplacePlan;
  readonly visual: ReplaceVisualPlan;
  readonly status: ReplacePlanStatus;
  readonly next_step_index: number;
  readonly completed: boolean;
}

interface RuntimeEntry {
  plan: ReplacePlan;
  visual: ReplaceVisualPlan;
  status: ReplacePlanStatus;
  next_step_index: number;
  canonicalKey: string;
}

export interface CreateReplacePlannerOptions {
  readonly maxActive?: number;
}

/**
 * Main-owned replace-plan lifecycle for one generation scope. The caller
 * holds the live EditorSession and presents it on every mutating call so
 * reset, close, generation rotation and buffer divergence fence
 * deterministically. The planner instance itself is clock-free: logical
 * progress advances only through advancePlan with an explicit integer step
 * count (manual step clock; the visual plan carries no timing policy —
 * design section 11 pacing belongs to the typing scheduler, not to
 * replacement). There are no timers to cancel; completion, cancel, reset,
 * close and failure simply stop logical progress with zero buffer or disk
 * effects.
 */
export interface ReplacePlanner {
  planOperation(session: EditorSession, admission: EditorOperationAdmission): WorkspaceOutcome<ReplacePlan>;
  getPlan(planId: string): ReplacePlan | null;
  getVisualPlan(planId: string): ReplaceVisualPlan | null;
  getStatus(planId: string): ReplacePlanStatus | null;
  startPlan(session: EditorSession, planId: string): WorkspaceOutcome<ReplaceVisualPlan>;
  advancePlan(session: EditorSession, planId: string, stepDelta: number): WorkspaceOutcome<ReplaceAdvanceResult>;
  cancelPlan(session: EditorSession, planId: string): WorkspaceOutcome<ReplacePlanView>;
  invalidateAll(): void;
  listPlans(): readonly ReplacePlanView[];
}

function liveFenceForEntry(session: EditorSession, entry: RuntimeEntry): WorkspaceRejection | null {
  if (session.registry.retired) {
    return { code: "STALE_SESSION", message: "editor session was reset or closed: old replace plans cannot advance" };
  }
  if (entry.plan.session_id !== session.sessionId) {
    return { code: "WRONG_OWNER", message: "replace plan belongs to a foreign session" };
  }
  if (entry.plan.generation !== session.generation) {
    return { code: "STALE_SESSION", message: "replace plan carries a stale session generation" };
  }
  const resolved = session.registry.resolveDocument(entry.plan.document_id);
  if (!resolved.ok) {
    return { code: "STALE_SESSION", message: "replace plan document is no longer live in this generation" };
  }
  const live = resolved.value;
  if (live.externally_modified) {
    return {
      code: "EXTERNAL_MODIFICATION_CONFLICT",
      message: "document base diverged from committed disk: old replace plan is stale, never silently rebased",
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
    return { code: "STALE_SESSION", message: "replace plan buffer is no longer available in this generation" };
  }
  if (sha256HexText(current.value) !== entry.plan.base_digest) {
    return {
      code: "EXTERNAL_MODIFICATION_CONFLICT",
      message: "document buffer bytes moved after this plan was created: old plan is stale",
    };
  }
  return null;
}

export function createReplacePlanner(options: CreateReplacePlannerOptions = {}): ReplacePlanner {
  const maxActive = options.maxActive ?? REPLACE_MAX_ACTIVE_PLANS;
  const byPlan = new Map<string, RuntimeEntry>();
  const byOperation = new Map<string, string>();
  const activeByDocument = new Map<string, string>();

  function operationScopeKey(plan: ReplacePlan): string {
    return `${plan.session_id}|${plan.generation}|${plan.operation_id}`;
  }

  function viewOf(entry: RuntimeEntry): ReplacePlanView {
    return deepFreeze({
      plan: entry.plan,
      visual: entry.visual,
      status: entry.status,
      next_step_index: entry.next_step_index,
    });
  }

  const planner: ReplacePlanner = {
    planOperation(session: EditorSession, admission: EditorOperationAdmission): WorkspaceOutcome<ReplacePlan> {
      const planned = planAdmittedReplaceOperation(session, admission);
      if (!planned.ok) return planned;
      const plan = planned.value;
      const visual = visualPlanOf(plan);

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
          return rejected("INVALID_REQUEST", "another replacement is already active for this document: operations serialize deterministically");
        }
      }

      let activeCount = 0;
      for (const entry of byPlan.values()) {
        if (entry.status === "planned" || entry.status === "running") activeCount += 1;
      }
      if (activeCount >= maxActive) {
        return rejected("RESOURCE_LIMIT", `bounded replace planner holds at most ${maxActive} live plans`);
      }

      const entry: RuntimeEntry = {
        plan,
        visual,
        status: "planned",
        next_step_index: 0,
        canonicalKey,
      };
      byPlan.set(plan.plan_id, entry);
      byOperation.set(scopeKey, plan.plan_id);
      activeByDocument.set(canonicalKey, plan.plan_id);
      return { ok: true, value: plan };
    },

    getPlan(planId: string): ReplacePlan | null {
      return byPlan.get(planId)?.plan ?? null;
    },

    getVisualPlan(planId: string): ReplaceVisualPlan | null {
      return byPlan.get(planId)?.visual ?? null;
    },

    getStatus(planId: string): ReplacePlanStatus | null {
      return byPlan.get(planId)?.status ?? null;
    },

    startPlan(session: EditorSession, planId: string): WorkspaceOutcome<ReplaceVisualPlan> {
      const entry = byPlan.get(planId);
      if (entry === undefined) {
        if (session.registry.retired) {
          return rejected("STALE_SESSION", "editor session was reset or closed: unknown replace plan cannot start");
        }
        return rejected("INVALID_REQUEST", "unknown replace plan");
      }
      if (entry.status === "completed" || entry.status === "cancelled" || entry.status === "failed") {
        return rejected("INVALID_REQUEST", "replace plan already reached its final state: completion is already final and start never replays");
      }
      if (entry.status === "running") return { ok: true, value: entry.visual };
      const fenced = liveFenceForEntry(session, entry);
      if (fenced !== null) {
        entry.status = "failed";
        if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
        return { ok: false, rejection: fenced };
      }
      entry.status = "running";
      if (entry.visual.step_count === 0) {
        entry.status = "completed";
        if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
      }
      return { ok: true, value: entry.visual };
    },

    advancePlan(session: EditorSession, planId: string, stepDelta: number): WorkspaceOutcome<ReplaceAdvanceResult> {
      const entry = byPlan.get(planId);
      if (entry === undefined) {
        if (session.registry.retired) {
          return rejected("STALE_SESSION", "editor session was reset or closed: unknown replace plan cannot advance");
        }
        return rejected("INVALID_REQUEST", "unknown replace plan");
      }
      if (entry.status === "planned") {
        return rejected("INVALID_REQUEST", "replace plan is not running: start it before advancing the manual step clock");
      }
      if (entry.status === "completed" || entry.status === "cancelled" || entry.status === "failed") {
        return rejected("INVALID_REQUEST", "replace plan already reached its final state: no further logical progress");
      }
      if (!Number.isInteger(stepDelta) || stepDelta < 0) {
        return rejected("INVALID_REQUEST", "the manual step clock advances by a non-negative integer step count");
      }
      const fenced = liveFenceForEntry(session, entry);
      if (fenced !== null) {
        entry.status = "failed";
        if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
        return { ok: false, rejection: fenced };
      }
      entry.next_step_index = Math.min(entry.visual.step_count, entry.next_step_index + stepDelta);
      let completed = false;
      if (entry.next_step_index >= entry.visual.step_count) {
        entry.status = "completed";
        completed = true;
        if (activeByDocument.get(entry.canonicalKey) === entry.plan.plan_id) activeByDocument.delete(entry.canonicalKey);
      }
      const result: ReplaceAdvanceResult = {
        plan: entry.plan,
        visual: entry.visual,
        status: entry.status,
        next_step_index: entry.next_step_index,
        completed,
      };
      return { ok: true, value: deepFreeze(result) };
    },

    cancelPlan(session: EditorSession, planId: string): WorkspaceOutcome<ReplacePlanView> {
      const entry = byPlan.get(planId);
      if (entry === undefined) {
        if (session.registry.retired) {
          return rejected("STALE_SESSION", "editor session was reset or closed: unknown replace plan cannot cancel");
        }
        return rejected("INVALID_REQUEST", "unknown replace plan");
      }
      if (entry.status === "completed") {
        return rejected("INVALID_REQUEST", "replace plan already completed: completion is already final and never reverts");
      }
      if (entry.status === "cancelled" || entry.status === "failed") {
        return rejected("INVALID_REQUEST", "replace plan already reached its final state");
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

    listPlans(): readonly ReplacePlanView[] {
      return Object.freeze([...byPlan.values()].map((entry) => viewOf(entry)));
    },
  };

  return planner;
}
