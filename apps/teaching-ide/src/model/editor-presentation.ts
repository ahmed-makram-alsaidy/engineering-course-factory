// Editor presentation model — pure read-only projection of main-owned editor state.
//
// Canonical architecture: docs/P6-DESIGN-SPEC.md section 15 (renderer applies
// trusted ranges via direct model edits, never keyboard synthesis; virtual
// URIs carry no host paths; guarded listeners; model disposal on reset) plus
// sections 4/5/6 (main buffer is authoritative unsaved state, Monaco is a
// disposable projection, disk is committed state), 11 (bounded batches, late
// frames catch up, never drop or duplicate), 12 (UTF-16 positions), 14
// (monotonic seq, duplicate/gap handling, subscribe-before-snapshot) and 17
// (Record Safe Mode: lesson-relative paths only).
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module is PURE (no Monaco import, no Electron import, no Node
//     import, no network, no timers): it decides NOTHING semantic. It tracks
//     which trusted snapshots and frames are current, applies frame text at
//     trusted offsets into a display string, and mints identifier-only
//     acknowledgement receipts. The main process remains the sole authority
//     for bytes, revisions, dirty truth and outcomes.
//   - Dirty truth arrives ONLY through document snapshots (main-owned). Monaco
//     change events never mark clean or dirty here and never unlock terminal
//     execution; the terminal interlock reads main state (P6.13 wires it live).
//   - Renderer text is display state only: there is deliberately no function
//     that sends display text back to main. Acknowledgements carry session,
//     generation, document, operation, plan and sequence identifiers only.
//   - One projection model per logical document, keyed by the main-issued
//     document_id. Windows case aliases collapse through the lesson-relative
//     canonical key (lowercase portable path): a second document_id for an
//     already-projected key is ignored as a stale alias, never a second
//     writable authority.
//   - Event ordering mirrors the proven P5 pattern: duplicate seq ignored,
//     gaps counted with a resync request (the bounded snapshot re-anchors),
//     stale generations ignored, reset/re-anchor on a new generation.

/** Minimal structural shape of a trusted document snapshot (main-issued). */
export interface ProjectionDocumentSnapshot {
  readonly session_id: string;
  readonly generation: number;
  readonly document_id: string;
  readonly portable_path: string;
  readonly disk_revision: number;
  readonly buffer_revision: number;
  readonly dirty: boolean;
  readonly pending_creation: boolean;
  readonly has_content: boolean;
  readonly content: string;
}

/** Minimal structural shape of a trusted presentation frame (main-issued). */
export type ProjectionFrame =
  | {
      readonly kind: "type_chunk";
      readonly session_id: string;
      readonly generation: number;
      readonly document_id: string;
      readonly operation_id: string;
      readonly plan_id: string;
      readonly chunk_seq: number;
      readonly chunk_count: number;
      readonly text: string;
      readonly start_utf16: number;
    }
  | {
      readonly kind: "replace_step";
      readonly session_id: string;
      readonly generation: number;
      readonly document_id: string;
      readonly operation_id: string;
      readonly plan_id: string;
      readonly step_seq: number;
      readonly step_count: number;
      readonly step_kind: "highlight" | "remove" | "insert";
      readonly adjusted_start_utf16: number;
      readonly adjusted_end_utf16: number;
      readonly text: string;
    };

/** Minimal structural shape of a trusted journal event (main-issued). */
export interface ProjectionEvent {
  readonly seq: number;
  readonly session_id: string;
  readonly generation: number;
  readonly operation_id: string;
  readonly kind: string;
}

/** Identifier-only acknowledgement receipt (the ONLY thing sent back). */
export interface PresentationReceipt {
  readonly session_id: string;
  readonly generation: number;
  readonly document_id: string;
  readonly operation_id: string;
  readonly plan_id: string;
  readonly chunk_seq: number;
}

export interface ProjectedDocument {
  readonly document_id: string;
  readonly portable_path: string;
  readonly displayPath: string;
  readonly disk_revision: number;
  readonly buffer_revision: number;
  readonly dirty: boolean;
  readonly pending_creation: boolean;
  /** Current display text (projection of the main-owned buffer). */
  readonly text: string;
}

export interface EditorProjectionState {
  readonly session_id: string;
  readonly generation: number;
  readonly documents: Readonly<Record<string, ProjectedDocument>>;
  /** Canonical lesson-relative key (lowercase path) -> document_id. */
  readonly aliasIndex: Readonly<Record<string, string>>;
  /** Highest journal seq applied (duplicate/gap detection). */
  readonly appliedSeq: number;
  /** Next expected frame seq per plan (duplicate/gap detection). */
  readonly expectedFrame: Readonly<Record<string, number>>;
  /** Completed plan ids (late frames ignored, never re-applied). */
  readonly completedPlans: readonly string[];
  /** True when a gap was observed and a snapshot resync is required. */
  readonly needsResync: boolean;
  readonly gapCount: number;
  readonly duplicateCount: number;
  readonly staleCount: number;
}

export function canonicalProjectionKey(portablePath: string): string {
  return portablePath.toLowerCase();
}

export function createEditorProjectionState(sessionId: string, generation: number): EditorProjectionState {
  return {
    session_id: sessionId,
    generation,
    documents: {},
    aliasIndex: {},
    appliedSeq: 0,
    expectedFrame: {},
    completedPlans: [],
    needsResync: false,
    gapCount: 0,
    duplicateCount: 0,
    staleCount: 0,
  };
}

function isCurrentFrame(state: EditorProjectionState, frame: ProjectionFrame): boolean {
  return frame.session_id === state.session_id && frame.generation === state.generation;
}

/**
 * Project one trusted document snapshot: create or refresh the single model
 * for its logical document. A snapshot for an already-projected canonical
 * key under a DIFFERENT document_id is a stale alias and is ignored (the
 * existing model stays authoritative for display).
 */
export function applyEditorDocumentSnapshot(
  state: EditorProjectionState,
  snapshot: ProjectionDocumentSnapshot,
): EditorProjectionState {
  if (snapshot.session_id !== state.session_id || snapshot.generation !== state.generation) {
    return { ...state, staleCount: state.staleCount + 1 };
  }
  const key = canonicalProjectionKey(snapshot.portable_path);
  const knownId = state.aliasIndex[key];
  if (knownId !== undefined && knownId !== snapshot.document_id) {
    // Stale case alias: never a second model for one logical document.
    return { ...state, staleCount: state.staleCount + 1 };
  }
  const text = snapshot.has_content ? snapshot.content : (state.documents[snapshot.document_id]?.text ?? "");
  const document: ProjectedDocument = {
    document_id: snapshot.document_id,
    portable_path: snapshot.portable_path,
    displayPath: snapshot.portable_path,
    disk_revision: snapshot.disk_revision,
    buffer_revision: snapshot.buffer_revision,
    dirty: snapshot.dirty,
    pending_creation: snapshot.pending_creation,
    text,
  };
  return {
    ...state,
    documents: { ...state.documents, [snapshot.document_id]: document },
    aliasIndex: { ...state.aliasIndex, [key]: snapshot.document_id },
    needsResync: false,
  };
}

function frameSeqOf(frame: ProjectionFrame): number {
  return frame.kind === "type_chunk" ? frame.chunk_seq : frame.step_seq;
}

function frameCountOf(frame: ProjectionFrame): number {
  return frame.kind === "type_chunk" ? frame.chunk_count : frame.step_count;
}

/**
 * Apply one trusted presentation frame exactly once, in order, to the
 * display projection. Returns the next state plus the identifier-only
 * receipt to send back, or a null receipt when the frame was fenced
 * (stale generation, duplicate, gap, completed plan, unknown document).
 */
export function applyEditorPresentationFrame(
  state: EditorProjectionState,
  frame: ProjectionFrame,
): { state: EditorProjectionState; receipt: PresentationReceipt | null; fenced: "stale" | "duplicate" | "gap" | "completed" | "unknown-document" | null } {
  if (!isCurrentFrame(state, frame)) {
    return { state: { ...state, staleCount: state.staleCount + 1 }, receipt: null, fenced: "stale" };
  }
  if (state.completedPlans.includes(frame.plan_id)) {
    return { state: { ...state, duplicateCount: state.duplicateCount + 1 }, receipt: null, fenced: "completed" };
  }
  const seq = frameSeqOf(frame);
  const expected = state.expectedFrame[frame.plan_id] ?? 0;
  if (seq < expected) {
    return { state: { ...state, duplicateCount: state.duplicateCount + 1 }, receipt: null, fenced: "duplicate" };
  }
  if (seq > expected) {
    return { state: { ...state, needsResync: true, gapCount: state.gapCount + 1 }, receipt: null, fenced: "gap" };
  }
  const current = state.documents[frame.document_id];
  if (current === undefined) {
    return { state: { ...state, needsResync: true, gapCount: state.gapCount + 1 }, receipt: null, fenced: "unknown-document" };
  }
  let text = current.text;
  if (frame.kind === "type_chunk") {
    text = text.slice(0, frame.start_utf16) + frame.text + text.slice(frame.start_utf16);
  } else if (frame.step_kind === "remove") {
    text = text.slice(0, frame.adjusted_start_utf16) + text.slice(frame.adjusted_end_utf16);
  } else if (frame.step_kind === "insert") {
    text = text.slice(0, frame.adjusted_start_utf16) + frame.text + text.slice(frame.adjusted_start_utf16);
  }
  // highlight steps select only: display text is unchanged.
  const completed = seq + 1 >= frameCountOf(frame) && frameCountOf(frame) > 0;
  // A zero-frame plan completes without frames; acks never arrive for it.
  void completed;
  return {
    state: {
      ...state,
      documents: { ...state.documents, [frame.document_id]: { ...current, text } },
      expectedFrame: { ...state.expectedFrame, [frame.plan_id]: expected + 1 },
    },
    receipt: {
      session_id: frame.session_id,
      generation: frame.generation,
      document_id: frame.document_id,
      operation_id: frame.operation_id,
      plan_id: frame.plan_id,
      chunk_seq: seq,
    },
    fenced: null,
  };
}

/** Mark one plan presentation-complete (called when main confirms completion). */
export function markPlanPresentationComplete(state: EditorProjectionState, planId: string): EditorProjectionState {
  if (state.completedPlans.includes(planId)) return state;
  return { ...state, completedPlans: [...state.completedPlans, planId] };
}

/**
 * Apply one trusted journal event with P5 ordering: duplicates ignored,
 * gaps counted with a resync request, stale generations ignored, and a new
 * generation re-anchors (documents/frames reset; the snapshot re-projects).
 */
export function applyEditorProjectionEvent(
  state: EditorProjectionState,
  event: ProjectionEvent,
): EditorProjectionState {
  if (event.session_id !== state.session_id || event.generation !== state.generation) {
    return { ...state, staleCount: state.staleCount + 1 };
  }
  if (event.seq <= state.appliedSeq) {
    return { ...state, duplicateCount: state.duplicateCount + 1 };
  }
  if (event.seq > state.appliedSeq + 1) {
    return { ...state, appliedSeq: event.seq, needsResync: true, gapCount: state.gapCount + 1 };
  }
  return { ...state, appliedSeq: event.seq };
}

/** Re-anchor on a new generation: old models/frames can never leak forward. */
export function reanchorEditorProjection(state: EditorProjectionState, sessionId: string, generation: number): EditorProjectionState {
  if (sessionId === state.session_id && generation === state.generation) return state;
  return createEditorProjectionState(sessionId, generation);
}

/** Main-owned dirty truth for one projected document (never Monaco-derived). */
export function projectionDirtyOf(state: EditorProjectionState, documentId: string): boolean | null {
  return state.documents[documentId]?.dirty ?? null;
}

/** Lesson-relative display identity (Record Safe Mode by construction). */
export function projectionDisplayPath(portablePath: string): string {
  return portablePath;
}

/** Generation/document-scoped virtual model URI (host paths absent by construction). */
export function projectionModelUri(generation: number, documentId: string): string {
  return `cf-editor://${generation}/${encodeURIComponent(documentId)}`;
}

// ---------------------------------------------------------------------------
// UTF-16 geometry — the same LF line model the engine plans against, so
// tests can assert renderer application equals main buffers exactly.
// Offsets and columns are UTF-16 code units, exactly as Monaco addresses.
// ---------------------------------------------------------------------------

export function projectionLineColumn(text: string, offsetUtf16: number): { line: number; column_utf16: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offsetUtf16; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column_utf16: offsetUtf16 - lineStart + 1 };
}

export function projectionOffsetFromLineColumn(text: string, line: number, columnUtf16: number): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) {
    offset += (lines[index] ?? "").length + 1;
  }
  return offset + columnUtf16 - 1;
}
