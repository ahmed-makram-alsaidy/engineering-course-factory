// P6.12 safe editor IPC and Monaco projection — main-owned bridge, read-only model projection.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md section 15 (IPC/main/preload/
// renderer architecture), sections 4 (trust boundary: validated IR ->
// main-only reviewed catalog -> editor admission -> immutable semantic plan ->
// trusted working document -> bounded visual projection), 5 (editor authority:
// main owns per-file working text; B0 stays committed while animation projects
// prefixes of B1; on successful presentation completion main installs B1;
// Monaco V is disposable presentation), 6 (disk D is committed truth, main B
// is authoritative unsaved text), 11 (deterministic scheduler; renderer
// applies due chunks in bounded batches; late frames catch up, never drop or
// duplicate characters), 12 (strict LF profile; Monaco positions in UTF-16
// units; byte hashes in UTF-8), 13 (cancel/reset/replay), 14 (journal and
// events: monotonic seq, exactly one final result, bounded snapshots,
// transient visual chunks, subscribe-before-snapshot), 17 (portable path
// rules; Record Safe Mode shows lesson-relative paths only), 18 (resource
// bounds: 64 KiB transport frames, 256 KiB in flight), 21 (admission errors
// zero side effects) and 26.8/26.10 (lifecycle interfaces; reset barrier)
// with docs/adr/ADR-0011-shared-workspace-ownership.md decisions 5-6.
//
// Canonical P6.12 name: P6.12 Safe IPC and Monaco.
// Objective: main/preload bridge, read-only model projection/backpressure.
// PASS gate: hostile renderer tests and faithful model semantics.
//
// THE CENTRAL SECURITY PROPERTY: the renderer requests only trusted reviewed
// operation identifiers and acknowledges presentation progress with
// identifier-only receipts. Every semantic value (path, content, find,
// replace, occurrences, timing policy, save bytes, revisions, digests,
// workspace root, access mode, epoch, lease) resolves main-side from the
// reviewed admission plus the live lifecycle. Renderer compromise can lie
// about pixels or acknowledgements; it cannot choose file bytes, targets,
// pacing or persistence outcomes.
//
// Owned scope (and only this):
//   - strict channel enumeration (four renderer->main invokes, two
//     main->renderer pushes; no generic invoke/send; no editor reset channel:
//     reset routes through the shared lifecycle owner per section 15, so this
//     bridge exposes run/cancel/snapshot/acknowledge only);
//   - safe IPC DTOs: strict identifier-only requests (the frozen P6.1
//     schemas, reused, never loosened), bounded document snapshots carrying
//     the exact main-owned buffer text for Monaco display (UI content, never
//     authorization), and bounded trusted presentation frames derived from
//     the P6.8 schedule groups and the P6.9 visual steps with explicit UTF-16
//     boundaries the renderer must never recompute;
//   - the ack-gated presentation driver over the P6.11 EditorLifecycle:
//     intermediate acknowledgements advance the main-owned planner clock by
//     the trusted frame delta (progress only, never bytes); the final
//     acknowledgement settles through the lifecycle completion path (single
//     B1 installation, single journal terminal, single tombstone); duplicate
//     acknowledgements converge idempotently; gaps reject fail-closed with a
//     resync directive; stale sessions/generations/plans fence with zero
//     mutation; acknowledgements carry no text, hash, revision or save
//     authority and can never bypass save preconditions;
//   - safe error sanitization (stable WorkspaceErrorCode, bounded message,
//     no host paths, no staging names, no container identity, no stacks);
//   - subscribe-before-snapshot delivery over the single reused canonical
//     journal (the proven P5 pattern, preserved here for the editor stream).
//
// Presentation-ack model (documented choice within the design envelope):
// section 5 installs B1 "on successful presentation completion" while section
// 4/15 treat acknowledgements as transport progress that cannot choose bytes.
// This driver reconciles both: planner progress is ack-driven (no completion
// merely because a timer fired — there are no timers here at all), the final
// ack settles through the lifecycle completion path (exactly one B1 install,
// exactly one journal terminal), and the installed bytes are always the
// main-computed candidate, never renderer text. A renderer that never acks
// leaves B0 untouched (fail-closed); a renderer that lies about display
// cannot alter B1.
//
// Transport bounds (section 18): one document snapshot carries at most 64 KiB
// of display text; one run/snapshot response carries at most 256 KiB in
// flight. Oversized operations are rejected RESOURCE_LIMIT fail-closed with
// the working document preserved (admission reservation released through the
// lifecycle cancel path): source bytes are never truncated. Chunked snapshot
// paging for multi-megabyte buffers is deferred to P6.14 if ever required;
// the engine ceilings (1 MiB per file, 16 MiB working set) are unchanged.
//
// Explicit non-scope (owned by later tasks, represented here only as
// fail-closed rejections or not at all):
//   - P6.13 terminal interoperability (no shared coordinator leaf, no Docker
//     epoch, no dirty-read/RW-invalidation wiring beyond the unchanged
//     buffer-facts seam the lifecycle already feeds; live app interlock
//     arrives with the shared leaf);
//   - P6.14 full verification and P6.15 Electron visual proof (no screenshots,
//     no Electron launch, no window capture here; production build health is
//     asserted by the gate, visual frames by P6.15);
//   - pause/resume beats (explicitly P8); browser automation, recording,
//     Unreal, node-pty (never).
//
// Purity: this module imports only zod (DTO validation) and relative
// workspace modules. No filesystem, no processes, no containers, no timers,
// no wall-clock reads, no randomness, no browser or Monaco machinery. All
// disk truth arrives through the caller-provided LifecycleExecDeps owned by
// main (adapter handle plus coordinator-style lease, never renderer input);
// all races fence through live lifecycle state plus explicit revalidation.

import { z } from "zod";
import {
  AcknowledgePresentationRequestSchema,
  CancelEditorOperationRequestSchema,
  GetEditorSnapshotRequestSchema,
  OpaqueHandleSchema,
  PortablePathSchema,
  RunEditorOperationRequestSchema,
  WorkspaceIdentifierSchema,
  type WorkspaceRejection,
} from "./protocol.ts";
import { EditorSaveEventSchema, type EditorSaveEvent } from "./editor-save.ts";
import { replaceLineColumn } from "./editor-replace-planner.ts";
import type { ReplaceVisualPlan } from "./editor-replace-planner.ts";
import type { TypePlan, TypeSchedule } from "./editor-type-planner.ts";
import type {
  EditorLifecycle,
  LifecycleExecDeps,
} from "./editor-lifecycle.ts";

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

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** IPC protocol version (matches the workspace protocol). */
export const EDITOR_IPC_VERSION = 1;

/** The four and only four renderer->main editor invoke channels. */
export const EDITOR_INVOKE_CHANNELS = Object.freeze([
  "editor:runOperation",
  "editor:cancelOperation",
  "editor:getSnapshot",
  "editor:acknowledgePresentation",
] as const);

export type EditorInvokeChannel = (typeof EDITOR_INVOKE_CHANNELS)[number];

/** Main->renderer trusted event push (copied journal DTOs only). */
export const EDITOR_EVENT_CHANNEL = "editor:event";

/** Main->renderer trusted presentation push (bounded frames only). */
export const EDITOR_PRESENTATION_CHANNEL = "editor:presentation";

/** One document snapshot carries at most 64 KiB of display text (spec 18). */
export const EDITOR_IPC_MAX_DOCUMENT_TEXT_BYTES = 64 * 1024;

/** One run/snapshot response carries at most 256 KiB in flight (spec 18). */
export const EDITOR_IPC_MAX_IN_FLIGHT_BYTES = 256 * 1024;

/** Safe renderer-visible message bound (matches the save journal ceiling). */
export const EDITOR_IPC_MAX_MESSAGE_CHARS = 512;

// ---------------------------------------------------------------------------
// Safe IPC DTOs — main-owned display data, bounded, lesson-relative only.
// ---------------------------------------------------------------------------

/** Strict UTF-16 line/column position (Monaco coordinates). */
export const EditorPositionSchema = z.strictObject({
  line: z.number().int().min(1),
  column_utf16: z.number().int().min(1),
});
export type EditorPosition = z.infer<typeof EditorPositionSchema>;

/**
 * Bounded document snapshot: the exact main-owned buffer text for Monaco
 * display plus the main-owned dirty/clean truth. UI content only: the
 * renderer must never treat this text as execution or persistence authority
 * (there is deliberately no channel that accepts renderer text back).
 */
export const EditorDocumentSnapshotSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  document_id: OpaqueHandleSchema,
  portable_path: PortablePathSchema,
  disk_revision: z.number().int().min(0),
  buffer_revision: z.number().int().min(0),
  dirty: z.boolean(),
  pending_creation: z.boolean(),
  has_content: z.boolean(),
  content: z.string().max(EDITOR_IPC_MAX_DOCUMENT_TEXT_BYTES * 4),
  content_bytes: z.number().int().min(0),
  content_utf16_length: z.number().int().min(0),
});
export type EditorDocumentSnapshot = z.infer<typeof EditorDocumentSnapshotSchema>;

/**
 * One trusted type presentation frame: exactly one schedule group (the
 * bounded batch the renderer applies atomically). The renderer applies
 * frames in chunk_seq order at the given UTF-16 start in its current
 * projection and acknowledges each frame once. Timing policy (due_us) is
 * display pacing only; it can never change the candidate bytes.
 */
export const TypePresentationFrameSchema = z.strictObject({
  kind: z.literal("type_chunk"),
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  document_id: OpaqueHandleSchema,
  operation_id: WorkspaceIdentifierSchema,
  plan_id: OpaqueHandleSchema,
  chunk_seq: z.number().int().min(0),
  chunk_count: z.number().int().min(0),
  text: z.string().max(EDITOR_IPC_MAX_DOCUMENT_TEXT_BYTES),
  start_utf16: z.number().int().min(0),
  end_utf16: z.number().int().min(0),
  start: EditorPositionSchema,
  due_us: z.number().int().min(0),
});
export type TypePresentationFrame = z.infer<typeof TypePresentationFrameSchema>;

/**
 * One trusted replace presentation step: exactly one P6.9 visual step
 * (highlight, then remove, then insert per match, ascending original order).
 * The renderer applies steps in step_seq order via direct model edits and
 * acknowledges each step once. Highlight steps change selection only.
 */
export const ReplacePresentationFrameSchema = z.strictObject({
  kind: z.literal("replace_step"),
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  document_id: OpaqueHandleSchema,
  operation_id: WorkspaceIdentifierSchema,
  plan_id: OpaqueHandleSchema,
  step_seq: z.number().int().min(0),
  step_count: z.number().int().min(0),
  step_kind: z.enum(["highlight", "remove", "insert"]),
  match_index: z.number().int().min(0),
  original_start_utf16: z.number().int().min(0),
  original_end_utf16: z.number().int().min(0),
  adjusted_start_utf16: z.number().int().min(0),
  adjusted_end_utf16: z.number().int().min(0),
  start: EditorPositionSchema,
  end: EditorPositionSchema,
  text: z.string().max(EDITOR_IPC_MAX_DOCUMENT_TEXT_BYTES),
});
export type ReplacePresentationFrame = z.infer<typeof ReplacePresentationFrameSchema>;

/** Trusted presentation frame: exactly one type chunk or replace step. */
export const EditorPresentationFrameSchema = z.union([TypePresentationFrameSchema, ReplacePresentationFrameSchema]);
export type EditorPresentationFrame = z.infer<typeof EditorPresentationFrameSchema>;

/** Safe run-operation value: receipt plus initial projection plus frames. */
export const EditorRunValueSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  operation_id: WorkspaceIdentifierSchema,
  action_type: z.enum(["file_open", "file_create", "type_code", "replace_code", "file_save"]),
  plan_id: OpaqueHandleSchema.nullable(),
  completed: z.boolean(),
  frames: z.array(EditorPresentationFrameSchema).max(10000),
  document: EditorDocumentSnapshotSchema.nullable(),
  journal_seq: z.number().int().min(1).nullable(),
  detail: z.string().max(EDITOR_IPC_MAX_MESSAGE_CHARS),
});
export type EditorRunValue = z.infer<typeof EditorRunValueSchema>;

/** Safe acknowledgement value: fenced progress receipt, never bytes. */
export const EditorAckValueSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  operation_id: WorkspaceIdentifierSchema,
  plan_id: OpaqueHandleSchema,
  chunk_seq: z.number().int().min(0),
  expected_next: z.number().int().min(0),
  completed: z.boolean(),
  duplicate: z.boolean(),
  document: EditorDocumentSnapshotSchema.nullable(),
  journal_seq: z.number().int().min(1).nullable(),
});
export type EditorAckValue = z.infer<typeof EditorAckValueSchema>;

/** Safe cancel value: the lifecycle tombstone (identifiers only). */
export const EditorCancelValueSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  operation_id: WorkspaceIdentifierSchema,
  action_type: z.string().min(1).max(64),
  kind: z.enum(["completed", "failed", "cancelled", "commit_uncertain"]),
  request_id: WorkspaceIdentifierSchema,
  journal_seq: z.number().int().min(1).nullable(),
});
export type EditorCancelValue = z.infer<typeof EditorCancelValueSchema>;

/** Bounded snapshot page: documents plus journal events plus cursors. */
export const EditorSnapshotPageSchema = z.strictObject({
  session_id: WorkspaceIdentifierSchema,
  generation: z.number().int().min(1),
  documents: z.array(EditorDocumentSnapshotSchema).max(256),
  events: z.array(EditorSaveEventSchema).max(256),
  page_end_seq: z.number().int().min(0),
  journal_high_seq: z.number().int().min(0),
  reset: z.boolean(),
});
export type EditorSnapshotPage = z.infer<typeof EditorSnapshotPageSchema>;

/** Renderer-safe invoke response (never stacks, paths, PIDs or secrets). */
export type EditorInvokeResponse =
  | { ok: true; run: EditorRunValue }
  | { ok: true; cancel: EditorCancelValue }
  | { ok: true; page: EditorSnapshotPage }
  | { ok: true; ack: EditorAckValue }
  | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// Safe error sanitization — Record Safe Mode by construction.
// ---------------------------------------------------------------------------

/**
 * Convert an engine rejection into a renderer-safe error: stable code plus a
 * bounded message with host-absolute paths, staging names, container
 * identity and secret-shaped tokens redacted. Lesson-relative portable paths
 * (forward slashes, no drive) survive: they are the legitimate UI identity.
 */
export function sanitizeEditorMessage(message: string): string {
  let out = message;
  out = out.replace(/[A-Za-z]:[\\/][^\s"'`]*/g, "[path]");
  out = out.replace(/\\\\[^\s"'`]*/g, "[path]");
  out = out.replace(/\/[^\s"'`]*cf-p[0-9a-z-]*stage-[^\s"'`]*/gi, "[staging]");
  out = out.replace(/cf-p[0-9a-z-]*stage-[A-Za-z0-9._-]+/gi, "[staging]");
  out = out.replace(/\b[0-9a-f]{64}\b/gi, (m) => `${m.slice(0, 12)}…`);
  out = out.replace(/\b(container|pid|process)[_:=-]?\s*[A-Za-z0-9._-]{8,}\b/gi, "[id]");
  if (out.length > EDITOR_IPC_MAX_MESSAGE_CHARS) out = out.slice(0, EDITOR_IPC_MAX_MESSAGE_CHARS);
  return out;
}

function safeFailure(code: string, message: string): EditorInvokeResponse {
  return { ok: false, code, message: sanitizeEditorMessage(message) };
}

function rejectionToResponse(rejection: WorkspaceRejection): EditorInvokeResponse {
  return safeFailure(rejection.code, rejection.message);
}

// ---------------------------------------------------------------------------
// Pure frame builders — trusted ranges from main-held plans, never renderer
// arithmetic. Deterministic: same plan yields byte-identical frames.
// ---------------------------------------------------------------------------

/**
 * Build one presentation frame per schedule group for an admitted type plan.
 * Positions are absolute UTF-16 offsets in the evolving projection (B0 plus
 * all earlier groups), with canonical line/column for direct Monaco ranges.
 * The renderer must apply frames in chunk_seq order, exactly once each.
 */
export function buildTypeFrames(
  sessionId: string,
  generation: number,
  plan: TypePlan,
  schedule: TypeSchedule,
): TypePresentationFrame[] {
  const frames: TypePresentationFrame[] = [];
  // Reconstruct B0: B1 is B0[0:off] + source + B0[off:], so slicing the
  // authored source back out at the exact insertion offset yields B0.
  const insertionOffset = plan.insertion.offset_utf16;
  const sourceLength = plan.source_text.length;
  let projection: string =
    plan.expected_text.slice(0, insertionOffset) + plan.expected_text.slice(insertionOffset + sourceLength);
  let consumedUnits = 0;
  for (const group of schedule.groups) {
    const groupText = plan.units.slice(group.unit_start, group.unit_end_exclusive).join("");
    const startUtf16 = insertionOffset + consumedUnits;
    const endUtf16 = startUtf16 + groupText.length;
    const start = replaceLineColumn(projection, startUtf16);
    const frame: TypePresentationFrame = {
      kind: "type_chunk",
      session_id: sessionId,
      generation,
      document_id: plan.document_id,
      operation_id: plan.operation_id,
      plan_id: plan.plan_id,
      chunk_seq: group.group_seq,
      chunk_count: schedule.groups.length,
      text: groupText,
      start_utf16: startUtf16,
      end_utf16: endUtf16,
      start: { line: start.line, column_utf16: start.column_utf16 },
      due_us: group.due_us,
    };
    frames.push(deepFreeze(frame));
    projection = projection.slice(0, startUtf16) + groupText + projection.slice(startUtf16);
    consumedUnits += groupText.length;
  }
  return Object.freeze(frames) as TypePresentationFrame[];
}

/**
 * Build one presentation frame per visual step for an admitted replace plan.
 * Line/column positions are derived main-side against the simulated live
 * projection (B0 with all earlier matches replaced), so the renderer never
 * computes matching, offsets or adjustments.
 */
export function buildReplaceFrames(
  sessionId: string,
  generation: number,
  plan: { document_id: string; operation_id: string },
  visual: ReplaceVisualPlan,
  baseText: string,
): ReplacePresentationFrame[] {
  const frames: ReplacePresentationFrame[] = [];
  // Simulate the live projection to resolve adjusted spans to line/column.
  let projection = baseText;
  for (const step of visual.steps) {
    const start = replaceLineColumn(projection, step.adjusted_start_utf16);
    const end = replaceLineColumn(projection, step.adjusted_end_utf16);
    const frame: ReplacePresentationFrame = {
      kind: "replace_step",
      session_id: sessionId,
      generation,
      document_id: plan.document_id,
      operation_id: plan.operation_id,
      plan_id: visual.plan_id,
      step_seq: step.seq,
      step_count: visual.step_count,
      step_kind: step.kind,
      match_index: step.match_index,
      original_start_utf16: step.original_start_utf16,
      original_end_utf16: step.original_end_utf16,
      adjusted_start_utf16: step.adjusted_start_utf16,
      adjusted_end_utf16: step.adjusted_end_utf16,
      start: { line: start.line, column_utf16: start.column_utf16 },
      end: { line: end.line, column_utf16: end.column_utf16 },
      text: step.text,
    };
    frames.push(deepFreeze(frame));
    // Advance the simulation exactly as presentation would: remove deletes
    // the span, insert splices the replacement text, highlight is selection.
    if (step.kind === "remove") {
      projection = projection.slice(0, step.adjusted_start_utf16) + projection.slice(step.adjusted_end_utf16);
    } else if (step.kind === "insert" && step.text.length > 0) {
      projection =
        projection.slice(0, step.adjusted_start_utf16) + step.text + projection.slice(step.adjusted_start_utf16);
    }
  }
  return Object.freeze(frames) as ReplacePresentationFrame[];
}

// ---------------------------------------------------------------------------
// Ack-gated presentation driver over one P6.11 EditorLifecycle.
// ---------------------------------------------------------------------------

export interface CreateEditorIpcDriverOptions {
  readonly lifecycle: EditorLifecycle;
}

interface TrackedPresentation {
  readonly operationId: string;
  readonly planId: string;
  readonly documentId: string;
  readonly kind: "type" | "replace";
  readonly frameCount: number;
  /** Previous group due for delta computation (type only). */
  prevDueUs: number;
  /** Next expected chunk/step sequence (gap detection). */
  expectedNext: number;
  completed: boolean;
  journalSeq: number | null;
}

export interface EditorIpcDriver {
  readonly version: 1;
  describe(): { session_id: string; generation: number };
  runOperation(request: unknown, deps?: LifecycleExecDeps): Promise<EditorInvokeResponse>;
  cancelOperation(request: unknown): EditorInvokeResponse;
  getSnapshot(request: unknown): EditorInvokeResponse;
  acknowledge(request: unknown): Promise<EditorInvokeResponse>;
  subscribe(listener: (event: EditorSaveEvent) => void): { unsubscribe: () => void };
}

/**
 * Create the main-owned IPC driver for one lifecycle generation scope. The
 * driver holds no filesystem, container or presentation machinery: execution
 * dependencies (adapter handle plus coordinator-style lease) arrive per call
 * from main-held Electron state, never from the renderer.
 */
export function createEditorIpcDriver(options: CreateEditorIpcDriverOptions): EditorIpcDriver {
  const lifecycle = options.lifecycle;
  const tracked = new Map<string, TrackedPresentation>();
  let observedGeneration = lifecycle.describe().generation;

  /** Drop tracked presentation receipts across a generation rotation: old
   * plans, frames and ack cursors can never advance the new generation. */
  function syncGeneration(): void {
    const current = lifecycle.describe().generation;
    if (current !== observedGeneration) {
      observedGeneration = current;
      tracked.clear();
    }
  }

  function liveDescriptor(): { session_id: string; generation: number } {
    const described = lifecycle.describe();
    return { session_id: described.session_id, generation: described.generation };
  }

  function fenceRequest(sessionId: string, generation: number): WorkspaceRejection | null {
    const live = liveDescriptor();
    if (sessionId !== live.session_id) {
      return { code: "WRONG_OWNER", message: "editor request names a foreign session" };
    }
    if (generation !== live.generation) {
      return { code: "STALE_SESSION", message: "editor request carries a stale session generation" };
    }
    return null;
  }

  function snapshotDocument(documentId: string): EditorDocumentSnapshot | null {
    const live = liveDescriptor();
    const session = lifecycle.getSession();
    const resolved = session.registry.resolveDocument(documentId);
    if (!resolved.ok) return null;
    const descriptor = resolved.value;
    const buffered = session.registry.getBufferContent(documentId);
    const hasContent = buffered.ok;
    const content = buffered.ok ? buffered.value : "";
    const contentBytes = utf8ByteLength(content);
    if (contentBytes > EDITOR_IPC_MAX_DOCUMENT_TEXT_BYTES) {
      // Fail-closed per transport bound: never truncate display bytes. The
      // caller converts this null into a RESOURCE_LIMIT rejection with the
      // working document preserved.
      return null;
    }
    return deepFreeze({
      session_id: live.session_id,
      generation: live.generation,
      document_id: descriptor.document_id,
      portable_path: descriptor.portable_path,
      disk_revision: descriptor.base_disk_revision,
      buffer_revision: descriptor.buffer_revision,
      dirty: descriptor.dirty,
      pending_creation: descriptor.state === "pending_creation",
      has_content: hasContent,
      content,
      content_bytes: contentBytes,
      content_utf16_length: content.length,
    });
  }

  function snapshotDocumentOfOperation(operationId: string): EditorDocumentSnapshot | null {
    // Resolve through the canonical journal terminal: every settled operation
    // records its trusted document_id there, generation-scoped. The
    // descriptor's admitted-operation log covers reservations only
    // (type/replace/save); open/create focus without reserving, so the log
    // alone can never be the projection index.
    const terminal = lifecycle.getJournal().getTerminal(operationId);
    if (terminal === null) return null;
    return snapshotDocument(terminal.document_id);
  }

  function tombstoneSeq(operationId: string): number | null {
    // Generation-scoped settlement only: replay converges on the live
    // generation's recorded outcome and fences old generations, so an
    // operation settled before a reset can never masquerade as current work.
    const live = liveDescriptor();
    const replayed = lifecycle.replay({ session_id: live.session_id, generation: live.generation, operation_id: operationId });
    if (!replayed.ok) return null;
    return replayed.value.journal_seq;
  }

  function settledTombstone(operationId: string): { kind: string; action_type: string; request_id: string; journal_seq: number | null } | null {
    const live = liveDescriptor();
    const replayed = lifecycle.replay({ session_id: live.session_id, generation: live.generation, operation_id: operationId });
    if (!replayed.ok) return null;
    return replayed.value;
  }

  function checkInFlight(value: unknown): WorkspaceRejection | null {
    const bytes = utf8ByteLength(JSON.stringify(value) ?? "");
    if (bytes > EDITOR_IPC_MAX_IN_FLIGHT_BYTES) {
      return {
        code: "RESOURCE_LIMIT",
        message: `editor projection exceeds the 256 KiB in-flight bound (${bytes} bytes): explicit reset or a smaller operation is required, never truncation`,
      };
    }
    return null;
  }

  function releaseReservation(operationId: string): void {
    // Fail-closed cleanup for over-budget projections: cancel releases the
    // P6.6 dirty reservation and restores B0 with disk unchanged. Best
    // effort: the reservation may already be settled (completed ops).
    if (settledTombstone(operationId) !== null) return;
    const live = liveDescriptor();
    lifecycle.cancelOperation({
      session_id: live.session_id,
      generation: live.generation,
      operation_id: operationId,
      request_id: `ipc-release-${operationId.slice(-16)}`,
    });
  }

  const driver: EditorIpcDriver = {
    version: 1,

    describe(): { session_id: string; generation: number } {
      return liveDescriptor();
    },

    async runOperation(request: unknown, deps?: LifecycleExecDeps): Promise<EditorInvokeResponse> {
      const parsed = RunEditorOperationRequestSchema.safeParse(request);
      if (!parsed.success) {
        return safeFailure("INVALID_REQUEST", `editor run failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const { session_id, generation, operation_id, request_id } = parsed.data;
      syncGeneration();
      const fenced = fenceRequest(session_id, generation);
      if (fenced !== null) return rejectionToResponse(fenced);

      // Exactly-once run: a settled operation never executes twice. Completed
      // operations converge on a projection-only value (snapshot, no frames,
      // no second commit); consumed non-completed operations reject without
      // touching buffers or disk. Settlement is generation-scoped: old
      // generations never converge as current work.
      const settled = settledTombstone(operation_id);
      if (settled !== null) {
        const live = liveDescriptor();
        if (settled.kind !== "completed") {
          return safeFailure("INVALID_REQUEST", `editor operation already settled (${settled.kind}): one attempt per operation, never an implicit retry`);
        }
        const document = snapshotDocumentOfOperation(operation_id);
        const value: EditorRunValue = {
          session_id: live.session_id,
          generation: live.generation,
          operation_id,
          action_type: (settled.action_type === "file_open" || settled.action_type === "file_create" || settled.action_type === "type_code" || settled.action_type === "replace_code" || settled.action_type === "file_save") ? settled.action_type : "file_open",
          plan_id: null,
          completed: true,
          frames: [],
          document,
          journal_seq: settled.journal_seq,
          detail: "operation already completed: projection converges without a second commit",
        };
        const bounded = checkInFlight(value);
        if (bounded !== null) return rejectionToResponse(bounded);
        return { ok: true, run: deepFreeze(value) };
      }

      const admitted = lifecycle.admit(operation_id, request_id);
      if (!admitted.ok) return rejectionToResponse(admitted.rejection);
      const admission = admitted.value;
      const actionType = (admission.record as { action_type?: unknown }).action_type as string;
      const live = liveDescriptor();

      if (actionType === "file_open" || actionType === "file_create" || actionType === "file_save") {
        if (deps === undefined) {
          releaseReservation(operation_id);
          return safeFailure("INVALID_REQUEST", "editor persistence requires main-held execution dependencies: renderer identifiers alone never authorize disk work");
        }
        const outcome =
          actionType === "file_open"
            ? await lifecycle.executeOpen(admission, deps)
            : actionType === "file_create"
              ? await lifecycle.executeCreate(admission, deps)
              : await lifecycle.executeSave(admission, deps);
        if (!outcome.ok) return rejectionToResponse(outcome.rejection);
        // Snapshot through the admission's resolved document: open/create
        // focus without reserving, so the reservation log alone can never
        // be the projection index.
        const document = snapshotDocument(admission.document.document_id);
        if (document === null) {
          return safeFailure("RESOURCE_LIMIT", "editor document projection exceeds the 64 KiB display bound: explicit reset or a smaller document is required, never truncation");
        }
        const value: EditorRunValue = {
          session_id: live.session_id,
          generation: live.generation,
          operation_id,
          action_type: actionType,
          plan_id: null,
          completed: true,
          frames: [],
          document,
          journal_seq: tombstoneSeq(operation_id),
          detail:
            actionType === "file_save"
              ? "save committed exact buffer bytes with byte verification"
              : actionType === "file_create"
                ? "create staged pending bytes with zero disk publication"
                : "open bound exact committed bytes with zero disk mutation",
        };
        const bounded = checkInFlight(value);
        if (bounded !== null) return rejectionToResponse(bounded);
        return { ok: true, run: deepFreeze(value) };
      }

      if (actionType === "type_code") {
        const planned = lifecycle.planType(admission);
        if (!planned.ok) return rejectionToResponse(planned.rejection);
        const planId = planned.value.plan_id;
        const started = lifecycle.startType(planId);
        if (!started.ok) return rejectionToResponse(started.rejection);
        const plan = lifecycle.getTypePlanner().getPlan(planId);
        const schedule = lifecycle.getTypePlanner().getSchedule(planId);
        if (plan === null || schedule === null) {
          return safeFailure("INVALID_REQUEST", "type plan is not projectable in its current state");
        }
        const status = lifecycle.getTypePlanner().getStatus(planId);
        if (status === "completed") {
          // Empty-content no-op: no frames exist, settle immediately.
          const settled = lifecycle.completeType(planId);
          if (!settled.ok) return rejectionToResponse(settled.rejection);
          const document = snapshotDocument(plan.document_id);
          if (document === null) {
            return safeFailure("RESOURCE_LIMIT", "editor document projection exceeds the 64 KiB display bound: explicit reset or a smaller document is required, never truncation");
          }
          const value: EditorRunValue = {
            session_id: live.session_id,
            generation: live.generation,
            operation_id,
            action_type: actionType,
            plan_id: planId,
            completed: true,
            frames: [],
            document,
            journal_seq: tombstoneSeq(operation_id),
            detail: "type no-op completed with exact bytes and zero frames",
          };
          const bounded = checkInFlight(value);
          if (bounded !== null) return rejectionToResponse(bounded);
          return { ok: true, run: deepFreeze(value) };
        }
        const frames = buildTypeFrames(live.session_id, live.generation, plan, schedule);
        tracked.set(planId, { operationId: operation_id, planId, documentId: plan.document_id, kind: "type", frameCount: frames.length, prevDueUs: 0, expectedNext: 0, completed: false, journalSeq: null });
        const document = snapshotDocument(plan.document_id);
        if (document === null) {
          tracked.delete(planId);
          releaseReservation(operation_id);
          return safeFailure("RESOURCE_LIMIT", "editor document projection exceeds the 64 KiB display bound: explicit reset or a smaller document is required, never truncation");
        }
        const value: EditorRunValue = {
          session_id: live.session_id,
          generation: live.generation,
          operation_id,
          action_type: actionType,
          plan_id: planId,
          completed: false,
          frames,
          document,
          journal_seq: null,
          detail: "type planned with trusted presentation frames: acknowledge each frame exactly once",
        };
        const bounded = checkInFlight(value);
        if (bounded !== null) {
          tracked.delete(planId);
          releaseReservation(operation_id);
          return rejectionToResponse(bounded);
        }
        return { ok: true, run: deepFreeze(value) };
      }

      if (actionType === "replace_code") {
        const planned = lifecycle.planReplace(admission);
        if (!planned.ok) return rejectionToResponse(planned.rejection);
        const planId = planned.value.plan_id;
        const started = lifecycle.startReplace(planId);
        if (!started.ok) return rejectionToResponse(started.rejection);
        const plan = lifecycle.getReplacePlanner().getPlan(planId);
        const visual = lifecycle.getReplacePlanner().getVisualPlan(planId);
        if (plan === null || visual === null) {
          return safeFailure("INVALID_REQUEST", "replace plan is not projectable in its current state");
        }
        const status = lifecycle.getReplacePlanner().getStatus(planId);
        if (status === "completed" || visual.step_count === 0) {
          // Unchanged-replacement no-op: zero visual steps, settle immediately.
          const settled = lifecycle.completeReplace(planId);
          if (!settled.ok) return rejectionToResponse(settled.rejection);
          const document = snapshotDocument(plan.document_id);
          if (document === null) {
            return safeFailure("RESOURCE_LIMIT", "editor document projection exceeds the 64 KiB display bound: explicit reset or a smaller document is required, never truncation");
          }
          const value: EditorRunValue = {
            session_id: live.session_id,
            generation: live.generation,
            operation_id,
            action_type: actionType,
            plan_id: planId,
            completed: true,
            frames: [],
            document,
            journal_seq: tombstoneSeq(operation_id),
            detail: "replace no-op completed with exact bytes and zero frames",
          };
          const bounded = checkInFlight(value);
          if (bounded !== null) return rejectionToResponse(bounded);
          return { ok: true, run: deepFreeze(value) };
        }
        const session = lifecycle.getSession();
        const buffered = session.registry.getBufferContent(plan.document_id);
        if (!buffered.ok) return rejectionToResponse(buffered.rejection);
        const frames = buildReplaceFrames(live.session_id, live.generation, plan, visual, buffered.value);
        tracked.set(planId, { operationId: operation_id, planId, documentId: plan.document_id, kind: "replace", frameCount: frames.length, prevDueUs: 0, expectedNext: 0, completed: false, journalSeq: null });
        const document = snapshotDocument(plan.document_id);
        if (document === null) {
          tracked.delete(planId);
          releaseReservation(operation_id);
          return safeFailure("RESOURCE_LIMIT", "editor document projection exceeds the 64 KiB display bound: explicit reset or a smaller document is required, never truncation");
        }
        const value: EditorRunValue = {
          session_id: live.session_id,
          generation: live.generation,
          operation_id,
          action_type: actionType,
          plan_id: planId,
          completed: false,
          frames,
          document,
          journal_seq: null,
          detail: "replace planned with trusted visual steps: acknowledge each step exactly once",
        };
        const bounded = checkInFlight(value);
        if (bounded !== null) {
          tracked.delete(planId);
          releaseReservation(operation_id);
          return rejectionToResponse(bounded);
        }
        return { ok: true, run: deepFreeze(value) };
      }

      return safeFailure("INVALID_REQUEST", `editor run admits reviewed editor operations only (got '${actionType}')`);
    },

    cancelOperation(request: unknown): EditorInvokeResponse {
      const parsed = CancelEditorOperationRequestSchema.safeParse(request);
      if (!parsed.success) {
        return safeFailure("INVALID_REQUEST", `editor cancel failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const { session_id, generation, operation_id } = parsed.data;
      syncGeneration();
      const fenced = fenceRequest(session_id, generation);
      if (fenced !== null) return rejectionToResponse(fenced);
      const outcome = lifecycle.cancelOperation(request);
      if (!outcome.ok) return rejectionToResponse(outcome.rejection);
      const tomb = outcome.value;
      const live = liveDescriptor();
      return {
        ok: true,
        cancel: deepFreeze({
          session_id: live.session_id,
          generation: live.generation,
          operation_id: tomb.operation_id,
          action_type: tomb.action_type,
          kind: tomb.kind,
          request_id: tomb.request_id,
          journal_seq: tomb.journal_seq,
        }),
      };
    },

    getSnapshot(request: unknown): EditorInvokeResponse {
      const parsed = GetEditorSnapshotRequestSchema.safeParse(request);
      if (!parsed.success) {
        return safeFailure("INVALID_REQUEST", `editor snapshot failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const { session_id, generation, after_seq } = parsed.data;
      syncGeneration();
      const fenced = fenceRequest(session_id, generation);
      if (fenced !== null) return rejectionToResponse(fenced);
      const live = liveDescriptor();
      const session = lifecycle.getSession();
      const documents: EditorDocumentSnapshot[] = [];
      for (const descriptor of session.registry.listDocuments()) {
        const snapshot = snapshotDocument(descriptor.document_id);
        if (snapshot === null) {
          return safeFailure("RESOURCE_LIMIT", "editor document projection exceeds the 64 KiB display bound: explicit reset or a smaller document is required, never truncation");
        }
        documents.push(snapshot);
      }
      const page = lifecycle.snapshot(after_seq);
      const value: EditorSnapshotPage = {
        session_id: live.session_id,
        generation: live.generation,
        documents,
        events: [...page.events],
        page_end_seq: page.page_end_seq,
        journal_high_seq: page.journal_high_seq,
        reset: page.reset,
      };
      const bounded = checkInFlight(value);
      if (bounded !== null) return rejectionToResponse(bounded);
      return { ok: true, page: deepFreeze(value) };
    },

    async acknowledge(request: unknown): Promise<EditorInvokeResponse> {
      const parsed = AcknowledgePresentationRequestSchema.safeParse(request);
      if (!parsed.success) {
        return safeFailure("INVALID_REQUEST", `editor acknowledgement failed strict identifier-only validation (${parsed.error.issues[0]?.message ?? "unknown issue"})`);
      }
      const { session_id, generation, operation_id, plan_id, chunk_seq } = parsed.data;
      syncGeneration();
      const fenced = fenceRequest(session_id, generation);
      if (fenced !== null) return rejectionToResponse(fenced);
      const live = liveDescriptor();

      const entry = tracked.get(plan_id);
      if (entry === undefined) {
        // Unknown plan: converge idempotently when the operation already
        // settled (duplicate ack after completion), else reject with zero
        // mutation. Acknowledgements can never create authority.
        const seq = tombstoneSeq(operation_id);
        if (seq !== null) {
          const document = snapshotDocumentOfOperation(operation_id);
          return {
            ok: true,
            ack: deepFreeze({
              session_id: live.session_id,
              generation: live.generation,
              operation_id,
              plan_id,
              chunk_seq,
              expected_next: chunk_seq + 1,
              completed: true,
              duplicate: true,
              document,
              journal_seq: seq,
            }),
          };
        }
        return safeFailure("INVALID_REQUEST", "unknown presentation plan: acknowledgements reference main-issued plans only");
      }
      if (entry.operationId !== operation_id) {
        return safeFailure("INVALID_REQUEST", "presentation acknowledgement binds the wrong operation: stale or forged receipts fence with zero progress");
      }
      if (entry.completed) {
        const document = snapshotDocument(entry.documentId);
        return {
          ok: true,
          ack: deepFreeze({
            session_id: live.session_id,
            generation: live.generation,
            operation_id,
            plan_id,
            chunk_seq,
            expected_next: entry.expectedNext,
            completed: true,
            duplicate: true,
            document,
            journal_seq: entry.journalSeq,
          }),
        };
      }
      if (chunk_seq < entry.expectedNext) {
        const document = snapshotDocument(entry.documentId);
        return {
          ok: true,
          ack: deepFreeze({
            session_id: live.session_id,
            generation: live.generation,
            operation_id,
            plan_id,
            chunk_seq,
            expected_next: entry.expectedNext,
            completed: false,
            duplicate: true,
            document,
            journal_seq: null,
          }),
        };
      }
      if (chunk_seq > entry.expectedNext) {
        return safeFailure("INVALID_REQUEST", `presentation gap at ${entry.expectedNext}: expected frame ${entry.expectedNext} before ${chunk_seq}; resync through the bounded snapshot with zero skipped progress`);
      }

      const isFinal = chunk_seq === entry.frameCount - 1;
      if (entry.kind === "type") {
        if (isFinal) {
          // The final acknowledgement settles through the lifecycle
          // completion path: exactly one B1 installation, exactly one
          // journal terminal, exactly one tombstone.
          const settled = lifecycle.completeType(plan_id);
          if (!settled.ok) return rejectionToResponse(settled.rejection);
          entry.completed = true;
          entry.expectedNext = entry.frameCount;
          const seq = tombstoneSeq(operation_id);
          entry.journalSeq = seq;
          const document = snapshotDocument(entry.documentId);
          return {
            ok: true,
            ack: deepFreeze({
              session_id: live.session_id,
              generation: live.generation,
              operation_id,
              plan_id,
              chunk_seq,
              expected_next: entry.frameCount,
              completed: true,
              duplicate: false,
              document,
              journal_seq: seq,
            }),
          };
        }
        const plan = lifecycle.getTypePlanner().getPlan(plan_id);
        const schedule = lifecycle.getTypePlanner().getSchedule(plan_id);
        if (plan === null || schedule === null) {
          return safeFailure("INVALID_REQUEST", "type plan is not advanceable in its current state");
        }
        const group = schedule.groups[chunk_seq];
        if (group === undefined) {
          return safeFailure("INVALID_REQUEST", "presentation acknowledgement names no trusted frame: receipts advance main-issued frames only");
        }
        const delta = group.due_us - entry.prevDueUs;
        const advanced = lifecycle.advanceType(plan_id, delta);
        if (!advanced.ok) return rejectionToResponse(advanced.rejection);
        entry.prevDueUs = group.due_us;
        entry.expectedNext += 1;
        const document = snapshotDocument(entry.documentId);
        return {
          ok: true,
          ack: deepFreeze({
            session_id: live.session_id,
            generation: live.generation,
            operation_id,
            plan_id,
            chunk_seq,
            expected_next: entry.expectedNext,
            completed: false,
            duplicate: false,
            document,
            journal_seq: null,
          }),
        };
      }

      // Replace presentation: one step per acknowledgement.
      if (isFinal) {
        const settled = lifecycle.completeReplace(plan_id);
        if (!settled.ok) return rejectionToResponse(settled.rejection);
        entry.completed = true;
        entry.expectedNext = entry.frameCount;
        const seq = tombstoneSeq(operation_id);
        entry.journalSeq = seq;
        const document = snapshotDocument(entry.documentId);
        return {
          ok: true,
          ack: deepFreeze({
            session_id: live.session_id,
            generation: live.generation,
            operation_id,
            plan_id,
            chunk_seq,
            expected_next: entry.frameCount,
            completed: true,
            duplicate: false,
            document,
            journal_seq: seq,
          }),
        };
      }
      const advanced = lifecycle.advanceReplace(plan_id, 1);
      if (!advanced.ok) return rejectionToResponse(advanced.rejection);
      entry.expectedNext += 1;
      const document = snapshotDocument(entry.documentId);
      return {
        ok: true,
        ack: deepFreeze({
          session_id: live.session_id,
          generation: live.generation,
          operation_id,
          plan_id,
          chunk_seq,
          expected_next: entry.expectedNext,
          completed: false,
          duplicate: false,
          document,
          journal_seq: null,
        }),
      };
    },

    subscribe(listener: (event: EditorSaveEvent) => void): { unsubscribe: () => void } {
      return lifecycle.subscribe(listener);
    },
  };

  return driver;
}
