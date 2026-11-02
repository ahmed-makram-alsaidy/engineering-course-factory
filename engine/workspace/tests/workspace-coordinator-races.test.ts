// P6.2 coordinator race tests — atomic reservation behind the barrier.
//
// Every race here is synchronized deterministically: synchronous
// reservation before the first await decides the winner, and manual
// provider doubles hold TRANSITION open without timers or sleeps. No
// arbitrary delays appear anywhere; wall-clock timing cannot change the
// asserted outcomes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeSeedManifestDigest,
  createReviewedWorkspacePolicy,
  createSeedManifest,
  sha256Hex,
} from "../src/policy.ts";
import {
  createManualEpochProvider,
  createWorkspaceCoordinator,
} from "../src/coordinator.ts";

const COURSE = "C01";
const LESSON = "C01-L001";
const OP_RO_A = "C01-L001-S001-B001";
const OP_RW = "C01-L001-S002-B001";
const OP_RW_2 = "C01-L001-S002-B002";

function openHarness(provider?: ReturnType<typeof createManualEpochProvider>) {
  const manifestOutcome = createSeedManifest([]);
  assert.equal(manifestOutcome.ok, true);
  if (!manifestOutcome.ok) throw new Error("unreachable");
  const policyOutcome = createReviewedWorkspacePolicy(
    {
      course_id: COURSE,
      lesson_id: LESSON,
      lesson_compiled_digest: sha256Hex("p62-compiled-bytes"),
      seed_manifest_digest: computeSeedManifestDigest(manifestOutcome.value),
      sandbox_policy_digest: sha256Hex("p62-sandbox-policy"),
      terminal_access: { [OP_RO_A]: "read_only", [OP_RW]: "read_write", [OP_RW_2]: "read_write" },
      reviewed_by: "review-board-1",
      review_note: "synthetic P6.2 race review",
    },
    [OP_RO_A, OP_RW, OP_RW_2],
  );
  assert.equal(policyOutcome.ok, true);
  if (!policyOutcome.ok) throw new Error("unreachable");
  const coord = createWorkspaceCoordinator(provider === undefined ? {} : { provider });
  const opened = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: manifestOutcome.value });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  return { coord, ...opened.value };
}

describe("P6.2 race: editor acquire vs terminal read-write acquire has exactly one winner", () => {
  it("the editor reserves first, so the racing read-write start rejects promptly", async () => {
    const { coord, editorCapability, terminalCapability } = openHarness();
    const editorPromise = coord.runEditorOperation(editorCapability, "edit-op-1", "req-edit-1");
    const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, false);
    if (!rw.ok) assert.equal(rw.rejection.code, "WORKSPACE_BUSY");
    const editor = await editorPromise;
    assert.equal(editor.ok, true);
    if (!editor.ok) throw new Error("unreachable");
    assert.equal(coord.releaseEditor(editor.value.lease).ok, true);
    const rwAfter = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-2");
    assert.equal(rwAfter.ok, true);
    if (!rwAfter.ok) throw new Error("unreachable");
    assert.equal(rwAfter.value.descriptor.ownership, "TERMINAL_OWNED");
    assert.equal((await coord.releaseTerminal(rwAfter.value.lease)).ok, true);
  });

  it("the read-write transition reserves first, so the editor rejects without slipping in", async () => {
    const provider = createManualEpochProvider();
    const { coord, editorCapability, terminalCapability } = openHarness(provider);
    const rwPromise = coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(provider.pendingPrepares, 1);
    const editor = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-edit-1");
    assert.equal(editor.ok, false);
    if (!editor.ok) assert.equal(editor.rejection.code, "INVALID_TRANSITION");
    provider.resolveNextPrepare();
    const rw = await rwPromise;
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    const releasePromise = coord.releaseTerminal(rw.value.lease);
    assert.equal(provider.pendingRetires, 1);
    provider.resolveNextRetire("confirmed");
    assert.equal((await releasePromise).ok, true);
  });
});

describe("P6.2 race: terminal read-write vs terminal read-write admits a single writer", () => {
  it("concurrent read-write starts produce one terminal owner and one rejection", async () => {
    const provider = createManualEpochProvider();
    const { coord, terminalCapability } = openHarness(provider);
    const first = coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(provider.pendingPrepares, 1);
    const second = await coord.runTerminalOperation(terminalCapability, OP_RW_2, "req-rw-2");
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.rejection.code, "INVALID_TRANSITION");
    provider.resolveNextPrepare();
    const winner = await first;
    assert.equal(winner.ok, true);
    if (!winner.ok) throw new Error("unreachable");
    assert.equal(coord.getLogicalState().activeRw, true);
    const releasePromise = coord.releaseTerminal(winner.value.lease);
    assert.equal(provider.pendingRetires, 1);
    provider.resolveNextRetire("confirmed");
    assert.equal((await releasePromise).ok, true);
  });
});

describe("P6.2 race: acquire vs reset and acquire vs close", () => {
  it("reset revokes the racing acquire: the acquire fences while reset completes", async () => {
    const provider = createManualEpochProvider();
    const { coord, descriptor, terminalCapability } = openHarness(provider);
    const rwPromise = coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(provider.pendingPrepares, 1);
    const resetPromise = coord.resetCombinedSession(descriptor, "req-reset-1");
    assert.equal(provider.pendingRetires, 1);
    provider.resolveNextRetire("confirmed");
    const reset = await resetPromise;
    assert.equal(reset.ok, true);
    provider.resolveNextPrepare();
    const late = await rwPromise;
    assert.equal(late.ok, false);
    if (!late.ok) assert.ok(late.rejection.code === "STALE_SESSION" || late.rejection.code === "INVALID_TRANSITION");
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.descriptor.generation, 2);
    assert.equal(reset.value.descriptor.ownership, "EDITOR_OWNED");
  });

  it("close revokes the racing acquire and stays closed after the late completion", async () => {
    const provider = createManualEpochProvider();
    const { coord, descriptor, editorCapability, terminalCapability } = openHarness(provider);
    const rwPromise = coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(provider.pendingPrepares, 1);
    const closePromise = coord.closeCombinedSession(descriptor, "req-close-1");
    assert.equal(provider.pendingRetires, 1);
    provider.resolveNextRetire("confirmed");
    assert.equal((await closePromise).ok, true);
    provider.resolveNextPrepare();
    const late = await rwPromise;
    assert.equal(late.ok, false);
    assert.equal(coord.getLogicalState().closed, true);
    const after = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(after.ok, false);
  });
});

describe("P6.2 race: revocation vs acquire and release vs reset", () => {
  it("revocation wins: a lease revoked by provider failure cannot release or act", async () => {
    const { coord, editorCapability, epochCapability } = openHarness();
    const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(edit.ok, true);
    if (!edit.ok) throw new Error("unreachable");
    coord.onProviderFailure(epochCapability, "transport_lost");
    assert.equal(coord.describe().ownership, "HOLD");
    const release = coord.releaseEditor(edit.value.lease);
    assert.equal(release.ok, false);
    if (!release.ok) {
      assert.ok(release.rejection.code === "WORKSPACE_REVOKED" || release.rejection.code === "STALE_SESSION" || release.rejection.code === "INVALID_TRANSITION");
    }
    const acquire = await coord.runEditorOperation(editorCapability, "edit-op-2", "req-2");
    assert.equal(acquire.ok, false);
  });

  it("release vs reset: the reset latch wins and the old release fences stale", async () => {
    const { coord, descriptor, editorCapability } = openHarness();
    const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(edit.ok, true);
    if (!edit.ok) throw new Error("unreachable");
    const reset = await coord.resetCombinedSession(descriptor, "req-reset-1");
    assert.equal(reset.ok, true);
    const release = coord.releaseEditor(edit.value.lease);
    assert.equal(release.ok, false);
    if (!release.ok) assert.equal(release.rejection.code, "STALE_SESSION");
  });

  it("duplicate release loses deterministically: the second release always rejects", async () => {
    const { coord, editorCapability } = openHarness();
    const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(edit.ok, true);
    if (!edit.ok) throw new Error("unreachable");
    assert.equal(coord.releaseEditor(edit.value.lease).ok, true);
    const again = coord.releaseEditor(edit.value.lease);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.rejection.code, "WORKSPACE_REVOKED");
  });

  it("stale completion after a transition cannot publish ownership", async () => {
    const provider = createManualEpochProvider();
    const { coord, terminalCapability } = openHarness(provider);
    const first = coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(provider.pendingPrepares, 1);
    provider.resolveNextPrepare();
    const admitted = await first;
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const staleLease = { ...admitted.value.lease };
    const releasePromise = coord.releaseTerminal(admitted.value.lease);
    assert.equal(provider.pendingRetires, 1);
    provider.resolveNextRetire("confirmed");
    assert.equal((await releasePromise).ok, true);
    const stale = await coord.releaseTerminal(staleLease);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.ok(stale.rejection.code === "WORKSPACE_REVOKED" || stale.rejection.code === "STALE_EPOCH");
    assert.equal(coord.describe().ownership, "EDITOR_OWNED");
  });
});
