// P6.12 editor presentation IDE tests — pure renderer projection model.
// No Electron launch, no Monaco, no Docker: the projection state machine
// (document identity, frame ordering, event ordering, ack receipts, UTF-16
// geometry, Record Safe Mode) is proven deterministically against the
// trusted shapes the main-owned driver issues.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyEditorDocumentSnapshot,
  applyEditorPresentationFrame,
  applyEditorProjectionEvent,
  canonicalProjectionKey,
  createEditorProjectionState,
  markPlanPresentationComplete,
  projectionDirtyOf,
  projectionDisplayPath,
  projectionLineColumn,
  projectionModelUri,
  projectionOffsetFromLineColumn,
  reanchorEditorProjection,
  type ProjectionFrame,
} from "../src/model/editor-presentation.ts";

function proof(message: string): void {
  console.log(`P6.12 PROOF: ${message}`);
}

const SESSION = "ed-sess-1";
const GEN = 1;
const DOC = "doc-1";
const OP = "C01-L071-S001-B002";
const PLAN = "tp-0123456789abcdef0123456789abcdef";

function snapshot(overrides: Record<string, unknown> = {}): Parameters<typeof applyEditorDocumentSnapshot>[1] {
  return {
    session_id: SESSION,
    generation: GEN,
    document_id: DOC,
    portable_path: "src/app.ts",
    disk_revision: 0,
    buffer_revision: 0,
    dirty: false,
    pending_creation: false,
    has_content: true,
    content: "const a = 1;\n",
    ...overrides,
  };
}

function typeFrame(seq: number, text: string, startUtf16: number, count = 3): ProjectionFrame {
  return {
    kind: "type_chunk",
    session_id: SESSION,
    generation: GEN,
    document_id: DOC,
    operation_id: OP,
    plan_id: PLAN,
    chunk_seq: seq,
    chunk_count: count,
    text,
    start_utf16: startUtf16,
  };
}

function replaceFrame(seq: number, stepKind: "highlight" | "remove" | "insert", start: number, end: number, text = ""): ProjectionFrame {
  return {
    kind: "replace_step",
    session_id: SESSION,
    generation: GEN,
    document_id: DOC,
    operation_id: OP,
    plan_id: PLAN,
    step_seq: seq,
    step_count: 3,
    step_kind: stepKind,
    adjusted_start_utf16: start,
    adjusted_end_utf16: end,
    text,
  };
}

describe("P6.12 renderer document projection", () => {
  it("P6.12 PROOF: one Monaco model per logical document with case aliases collapsed", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    state = applyEditorDocumentSnapshot(state, snapshot());
    assert.equal(state.documents[DOC]?.text, "const a = 1;\n");
    // Same logical document under a case alias with the same id refreshes.
    state = applyEditorDocumentSnapshot(state, snapshot({ portable_path: "src/APP.ts" }));
    assert.equal(Object.keys(state.documents).length, 1);
    // A DIFFERENT document_id for the same canonical key is a stale alias:
    // never a second model.
    const before = state;
    state = applyEditorDocumentSnapshot(state, snapshot({ document_id: "doc-2", portable_path: "src/APP.ts" }));
    assert.equal(Object.keys(state.documents).length, 1);
    assert.equal(state.documents[DOC]?.text, "const a = 1;\n");
    assert.equal(state.staleCount, before.staleCount + 1);
    assert.equal(canonicalProjectionKey("src/APP.ts"), canonicalProjectionKey("src/app.ts"));
    proof("one Monaco model per logical document with case aliases collapsed");
  });

  it("P6.12 PROOF: stale generation snapshots never alter the current model", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    state = applyEditorDocumentSnapshot(state, snapshot());
    const before = state.documents[DOC]?.text;
    state = applyEditorDocumentSnapshot(state, snapshot({ generation: GEN + 1, content: "stale\n" }));
    assert.equal(state.documents[DOC]?.text, before);
    state = applyEditorDocumentSnapshot(state, snapshot({ session_id: "ed-foreign", content: "stale\n" }));
    assert.equal(state.documents[DOC]?.text, before);
    proof("stale generation snapshots never alter the current model");
  });

  it("P6.12 PROOF: dirty truth arrives main-owned, never Monaco-derived", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    assert.equal(projectionDirtyOf(state, DOC), null);
    state = applyEditorDocumentSnapshot(state, snapshot({ dirty: false }));
    assert.equal(projectionDirtyOf(state, DOC), false);
    state = applyEditorDocumentSnapshot(state, snapshot({ dirty: true, buffer_revision: 1 }));
    assert.equal(projectionDirtyOf(state, DOC), true);
    proof("dirty truth arrives main-owned, never Monaco-derived");
  });

  it("P6.12 PROOF: Record Safe Mode keeps lesson-relative identity with virtual URIs", () => {
    assert.equal(projectionDisplayPath("src/app.ts"), "src/app.ts");
    const uri = projectionModelUri(3, DOC);
    assert.equal(uri, "cf-editor://3/doc-1");
    assert.ok(uri.startsWith("cf-editor://"), "virtual scheme, never a host path");
    assert.doesNotMatch(uri, /^[A-Za-z]:[\\/]/);
    assert.doesNotMatch(uri, /\\/);
    assert.ok(uri.includes("3"), "generation-scoped");
    assert.ok(uri.includes(DOC), "document-scoped");
    proof("Record Safe Mode keeps lesson-relative identity with virtual URIs");
  });
});

describe("P6.12 renderer frame application", () => {
  it("P6.12 PROOF: trusted type frames apply exactly once in order with identifier-only receipts", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    state = applyEditorDocumentSnapshot(state, snapshot());
    const base = "const a = 1;\n";
    const first = applyEditorPresentationFrame(state, typeFrame(0, "const", base.length));
    assert.equal(first.fenced, null);
    assert.deepEqual(first.receipt, { session_id: SESSION, generation: GEN, document_id: DOC, operation_id: OP, plan_id: PLAN, chunk_seq: 0 });
    // Receipts carry identifiers only: no text, position or timing field.
    assert.deepEqual(Object.keys(first.receipt!).sort(), ["chunk_seq", "document_id", "generation", "operation_id", "plan_id", "session_id"]);
    state = first.state;
    const second = applyEditorPresentationFrame(state, typeFrame(1, " b", base.length + 5));
    assert.equal(second.fenced, null);
    state = second.state;
    const third = applyEditorPresentationFrame(state, typeFrame(2, " = 2;", base.length + 7));
    assert.equal(third.fenced, null);
    state = third.state;
    assert.equal(state.documents[DOC]?.text, "const a = 1;\nconst b = 2;");
    proof("trusted type frames apply exactly once in order with identifier-only receipts");
  });

  it("P6.12 PROOF: duplicate type frames converge with gap resync requests", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    state = applyEditorDocumentSnapshot(state, snapshot());
    const applied = applyEditorPresentationFrame(state, typeFrame(0, "x", 13));
    assert.equal(applied.fenced, null);
    state = applied.state;
    const duplicate = applyEditorPresentationFrame(state, typeFrame(0, "x", 13));
    assert.equal(duplicate.fenced, "duplicate");
    assert.equal(duplicate.receipt, null);
    assert.equal(duplicate.state.documents[DOC]?.text, "const a = 1;\nx");
    const gap = applyEditorPresentationFrame(state, typeFrame(2, "z", 14));
    assert.equal(gap.fenced, "gap");
    assert.equal(gap.receipt, null);
    assert.equal(gap.state.needsResync, true);
    assert.equal(gap.state.documents[DOC]?.text, "const a = 1;\nx");
    proof("duplicate type frames converge with gap resync requests");
  });

  it("P6.12 PROOF: stale generation frames never mutate the current model", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    state = applyEditorDocumentSnapshot(state, snapshot());
    const stale = applyEditorPresentationFrame(state, { ...typeFrame(0, "evil", 0), generation: GEN + 1 });
    assert.equal(stale.fenced, "stale");
    assert.equal(stale.receipt, null);
    assert.equal(stale.state.documents[DOC]?.text, "const a = 1;\n");
    proof("stale generation frames never mutate the current model");
  });

  it("P6.12 PROOF: trusted replace steps render highlight remove insert with B1 equality", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    state = applyEditorDocumentSnapshot(state, snapshot());
    const highlight = applyEditorPresentationFrame(state, replaceFrame(0, "highlight", 6, 11));
    assert.equal(highlight.fenced, null);
    assert.ok(highlight.receipt !== null);
    // Highlight selects only: display text unchanged, receipt still minted.
    assert.equal(highlight.state.documents[DOC]?.text, "const a = 1;\n");
    const removed = applyEditorPresentationFrame(highlight.state, replaceFrame(1, "remove", 6, 11));
    assert.equal(removed.fenced, null);
    assert.equal(removed.state.documents[DOC]?.text, "const ;\n");
    const inserted = applyEditorPresentationFrame(removed.state, replaceFrame(2, "insert", 6, 6, "a = 2"));
    assert.equal(inserted.fenced, null);
    assert.equal(inserted.state.documents[DOC]?.text, "const a = 2;\n");
    proof("trusted replace steps render highlight remove insert with B1 equality");
  });

  it("P6.12 PROOF: completed plans ignore late frames without re-application", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    state = applyEditorDocumentSnapshot(state, snapshot());
    state = markPlanPresentationComplete(state, PLAN);
    const late = applyEditorPresentationFrame(state, typeFrame(0, "evil", 0));
    assert.equal(late.fenced, "completed");
    assert.equal(late.state.documents[DOC]?.text, "const a = 1;\n");
    proof("completed plans ignore late frames without re-application");
  });

  it("P6.12 PROOF: renderer UTF-16 application stays exact across emoji and ZWJ", () => {
    const seed = "const e = \"🌍\";\n";
    let state = createEditorProjectionState(SESSION, GEN);
    state = applyEditorDocumentSnapshot(state, snapshot({ content: seed }));
    // Emoji counts 2 UTF-16 units: insertion at exact EOF offset.
    const applied = applyEditorPresentationFrame(state, typeFrame(0, "✅", seed.length, 1));
    assert.equal(applied.fenced, null);
    assert.equal(applied.state.documents[DOC]?.text, `${seed}✅`);
    const zwj = "👨‍👩‍👧";
    const second = applyEditorPresentationFrame(applied.state, { ...typeFrame(0, zwj, `${seed}✅`.length, 1), plan_id: `${PLAN}-2` });
    assert.equal(second.fenced, null);
    assert.equal(second.state.documents[DOC]?.text, `${seed}✅${zwj}`);
    proof("renderer UTF-16 application stays exact across emoji and ZWJ");
  });
});

describe("P6.12 renderer event ordering", () => {
  it("P6.12 PROOF: journal duplicates ignored with gaps counted and stale fenced", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    const event = (seq: number, generation = GEN, session = SESSION): Parameters<typeof applyEditorProjectionEvent>[1] => ({ seq, session_id: session, generation, operation_id: OP, kind: "editor.operation.started" });
    state = applyEditorProjectionEvent(state, event(1));
    assert.equal(state.appliedSeq, 1);
    const duplicate = applyEditorProjectionEvent(state, event(1));
    assert.equal(duplicate.appliedSeq, 1);
    assert.equal(duplicate.duplicateCount, 1);
    const gap = applyEditorProjectionEvent(state, event(3));
    assert.equal(gap.appliedSeq, 3);
    assert.equal(gap.needsResync, true);
    assert.equal(gap.gapCount, 1);
    state = gap;
    const stale = applyEditorProjectionEvent(state, event(4, GEN + 1));
    assert.equal(stale.appliedSeq, 3);
    assert.equal(stale.staleCount, 1);
    proof("journal duplicates ignored with gaps counted and stale fenced");
  });

  it("P6.12 PROOF: generation rotation re-anchors without leaking old models", () => {
    let state = createEditorProjectionState(SESSION, GEN);
    state = applyEditorDocumentSnapshot(state, snapshot());
    state = applyEditorPresentationFrame(state, typeFrame(0, "x", 13)).state;
    const next = reanchorEditorProjection(state, "ed-sess-2", GEN + 1);
    assert.deepEqual(Object.keys(next.documents), []);
    assert.equal(next.appliedSeq, 0);
    assert.equal(next.session_id, "ed-sess-2");
    assert.equal(next.generation, GEN + 1);
    assert.equal(reanchorEditorProjection(next, "ed-sess-2", GEN + 1), next);
    proof("generation rotation re-anchors without leaking old models");
  });
});

describe("P6.12 renderer UTF-16 geometry", () => {
  it("P6.12 PROOF: line columns match Monaco UTF-16 semantics exactly", () => {
    assert.deepEqual(projectionLineColumn("a\nb", 0), { line: 1, column_utf16: 1 });
    assert.deepEqual(projectionLineColumn("a\nb", 2), { line: 2, column_utf16: 1 });
    // Surrogate pairs before the offset count 2, exactly as Monaco columns do.
    assert.deepEqual(projectionLineColumn("🌍\nx", 3), { line: 2, column_utf16: 1 });
    assert.deepEqual(projectionLineColumn("a\n", 2), { line: 2, column_utf16: 1 });
    assert.equal(projectionOffsetFromLineColumn("a\nb", 2, 1), 2);
    assert.equal(projectionOffsetFromLineColumn("🌍\nx", 2, 1), 3);
    // Round-trip across Arabic, combining marks and multiline content.
    const text = "مرحبا é\nline2 🌍 end\n";
    for (let offset = 0; offset <= text.length; offset += 1) {
      const position = projectionLineColumn(text, offset);
      assert.equal(projectionOffsetFromLineColumn(text, position.line, position.column_utf16), offset);
    }
    proof("line columns match Monaco UTF-16 semantics exactly");
  });
});
