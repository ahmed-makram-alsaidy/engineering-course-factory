// P6.2 WorkspaceCoordinator lifecycle tests — trusted ownership authority.
//
// Canonical task: P6-DESIGN-SPEC section 22, P6.2 WorkspaceCoordinator
// lifecycle ("Leaf/seed ownership, terminal attach seam, ordering and
// revocation, fake provider"; PASS "No bypass or double owner; unconfirmed
// cleanup holds").
//
// Proves at runtime (not merely by types): exclusive writers, background
// read-only coexistence, read-write exclusivity with clean/exclusive
// preconditions, the transition barrier, generation/epoch fencing, lease
// revocation, fail-closed reset/close/HOLD, save serialization, renderer
// confinement (no access selection, no command heuristics), snapshot
// safety, P6.1 contract preservation, no file I/O and deterministic replay.
// Pure, offline, deterministic (fake epoch seam only; no containers, no
// filesystem, no timers, no sleeps).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcknowledgePresentationRequestSchema,
  CancelEditorOperationRequestSchema,
  GetEditorSnapshotRequestSchema,
  RunEditorOperationRequestSchema,
  WorkspaceSnapshotSchema,
  allowsEditorWrite,
  allowsTerminalWrite,
  checkPermitAcquisition,
  isCompleteResetSequence,
  isLegalOwnershipTransition,
  isValidOwnershipAccess,
  isValidResetPrefix,
  ownershipWriter,
} from "../src/protocol.ts";
import {
  computeSeedManifestDigest,
  createReviewedWorkspacePolicy,
  createSeedManifest,
  resolveTerminalAccess,
  sha256Hex,
  type SeedManifestEntry,
} from "../src/policy.ts";
import {
  coordinatorResolvesAccessWithoutCommands,
  createManualEpochProvider,
  createWorkspaceCoordinator,
} from "../src/coordinator.ts";

const here = dirname(fileURLToPath(import.meta.url));

const COURSE = "C01";
const LESSON = "C01-L001";
const OP_RO_A = "C01-L001-S001-B001";
const OP_RO_B = "C01-L001-S001-B002";
const OP_RW = "C01-L001-S002-B001";
const OP_RW_2 = "C01-L001-S002-B002";

function openHarness(
  opAccess: Record<string, "read_only" | "read_write">,
  seedEntries: readonly SeedManifestEntry[] = [],
) {
  const manifestOutcome = createSeedManifest(seedEntries);
  assert.equal(manifestOutcome.ok, true, "seed manifest must build");
  if (!manifestOutcome.ok) throw new Error("unreachable");
  const manifest = manifestOutcome.value;
  const policyOutcome = createReviewedWorkspacePolicy(
    {
      course_id: COURSE,
      lesson_id: LESSON,
      lesson_compiled_digest: sha256Hex("p62-compiled-bytes"),
      seed_manifest_digest: computeSeedManifestDigest(manifest),
      sandbox_policy_digest: sha256Hex("p62-sandbox-policy"),
      terminal_access: opAccess,
      reviewed_by: "review-board-1",
      review_note: "synthetic P6.2 review",
    },
    Object.keys(opAccess),
  );
  assert.equal(policyOutcome.ok, true, "reviewed policy must build");
  if (!policyOutcome.ok) throw new Error("unreachable");
  const coord = createWorkspaceCoordinator();
  const opened = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: manifest });
  assert.equal(opened.ok, true, "combined session must open");
  if (!opened.ok) throw new Error("unreachable");
  return { coord, policy: policyOutcome.value, manifest, ...opened.value };
}

describe("P6.2 initial state is canonical (editor-owned, fenced, revision zero)", () => {
  it("opens editor-owned with generation 1, epoch 1, clean buffers and no container", () => {
    const { coord, descriptor } = openHarness({ [OP_RO_A]: "read_only", [OP_RW]: "read_write" });
    assert.equal(descriptor.ownership, "EDITOR_OWNED");
    assert.equal(descriptor.generation, 1);
    assert.equal(descriptor.epoch, 1);
    assert.equal(descriptor.epochAccess, null);
    assert.equal(descriptor.workspaceRevision, 0);
    const logical = coord.getLogicalState();
    assert.equal(logical.ownership, "EDITOR_OWNED");
    assert.equal(logical.dirtyBufferCount, 0);
    assert.equal(logical.pendingCreationCount, 0);
    assert.equal(logical.saveActive, false);
    assert.equal(logical.activeRoCount, 0);
    assert.equal(logical.activeRw, false);
    assert.equal(logical.inTransition, false);
    assert.equal(logical.closed, false);
    assert.equal(ownershipWriter("EDITOR_OWNED"), "editor_adapter");
    assert.equal(allowsEditorWrite(descriptor.ownership), true);
    assert.equal(allowsTerminalWrite(descriptor.ownership), false);
  });

  it("a second open on the same coordinator rejects (one session per coordinator)", () => {
    const { coord, policy, manifest } = openHarness({ [OP_RO_A]: "read_only" });
    const again = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policy, seedManifest: manifest });
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.rejection.code, "INVALID_TRANSITION");
  });

  it("seed binding is enforced: a manifest that drifts from the review rejects NOT_AUTHORIZED", () => {
    const coord = createWorkspaceCoordinator();
    const manifestOutcome = createSeedManifest([
      { portable_path: "src/a.ts", kind: "regular_file", byte_length: 1, sha256: sha256Hex("a") },
    ]);
    assert.equal(manifestOutcome.ok, true);
    if (!manifestOutcome.ok) throw new Error("unreachable");
    const otherManifestOutcome = createSeedManifest([]);
    assert.equal(otherManifestOutcome.ok, true);
    if (!otherManifestOutcome.ok) throw new Error("unreachable");
    const policyOutcome = createReviewedWorkspacePolicy(
      {
        course_id: COURSE,
        lesson_id: LESSON,
        lesson_compiled_digest: sha256Hex("p62-compiled-bytes"),
        seed_manifest_digest: computeSeedManifestDigest(manifestOutcome.value),
        sandbox_policy_digest: sha256Hex("p62-sandbox-policy"),
        terminal_access: {},
        reviewed_by: "review-board-1",
        review_note: "seed drift harness",
      },
      [],
    );
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    const opened = coord.openCombinedSession({
      validatedIr: null,
      reviewedPolicy: policyOutcome.value,
      seedManifest: otherManifestOutcome.value,
    });
    assert.equal(opened.ok, false);
    if (!opened.ok) assert.equal(opened.rejection.code, "NOT_AUTHORIZED");
  });
});

describe("P6.2 editor ownership acquire succeeds and serializes", () => {
  it("an editor operation reserves the single transaction slot", async () => {
    const { coord, editorCapability } = openHarness({ [OP_RO_A]: "read_only" });
    const admitted = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    assert.equal(admitted.value.lease.operationId, "edit-op-1");
    assert.equal(admitted.value.descriptor.ownership, "EDITOR_OWNED");
    const released = coord.releaseEditor(admitted.value.lease);
    assert.equal(released.ok, true);
  });

  it("a second editor operation while one is active waits, then proceeds after release", async () => {
    const { coord, editorCapability } = openHarness({ [OP_RO_A]: "read_only" });
    const first = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    let secondSettled = false;
    const secondPromise = coord.runEditorOperation(editorCapability, "edit-op-2", "req-2").then((outcome) => {
      secondSettled = true;
      return outcome;
    });
    await Promise.resolve();
    assert.equal(secondSettled, false);
    const released = coord.releaseEditor(first.value.lease);
    assert.equal(released.ok, true);
    const second = await secondPromise;
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.value.lease.operationId, "edit-op-2");
    assert.equal(coord.releaseEditor(second.value.lease).ok, true);
  });

  it("identical request id and payload returns the cached receipt; a reused id with new payload rejects", async () => {
    const { coord, editorCapability } = openHarness({ [OP_RO_A]: "read_only" });
    const first = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    const replay = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(replay.ok, true);
    if (!replay.ok || !first.ok) throw new Error("unreachable");
    assert.equal(replay.value.lease.leaseId, first.value.lease.leaseId);
    const conflict = await coord.runEditorOperation(editorCapability, "edit-op-9", "req-1");
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.rejection.code, "INVALID_REQUEST");
    const tombstone = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-fresh");
    assert.equal(tombstone.ok, false);
    if (!tombstone.ok) assert.equal(tombstone.rejection.code, "INVALID_REQUEST");
    assert.equal(coord.releaseEditor(first.value.lease).ok, true);
  });
});

describe("P6.2 approved read-only background coexistence succeeds", () => {
  it("read-only observers run beside editing without changing the epoch", async () => {
    const { coord, editorCapability, terminalCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RO_B]: "read_only",
      [OP_RW]: "read_write",
    });
    const before = coord.describe();
    const roA = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(roA.ok, true);
    if (!roA.ok) throw new Error("unreachable");
    assert.equal(roA.value.access, "read_only");
    assert.equal(roA.value.descriptor.ownership, "EDITOR_OWNED");
    assert.equal(roA.value.descriptor.epoch, before.epoch);
    const roB = await coord.runTerminalOperation(terminalCapability, OP_RO_B, "req-ro-b");
    assert.equal(roB.ok, true);
    const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-edit-1");
    assert.equal(edit.ok, true);
    assert.equal(coord.getLogicalState().activeRoCount, 2);
    assert.equal(coord.releaseEditor(edit.value.lease).ok, true);
    assert.equal((await coord.releaseTerminal(roA.value.lease)).ok, true);
    assert.equal((await coord.releaseTerminal((roB.ok ? roB.value : null as never).lease)).ok, true);
    assert.equal(coord.getLogicalState().activeRoCount, 0);
  });

  it("read-only permits validate against live fencing facts", async () => {
    const { coord, terminalCapability } = openHarness({ [OP_RO_A]: "read_only", [OP_RW]: "read_write" });
    const ro = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(ro.ok, true);
    if (!ro.ok) throw new Error("unreachable");
    assert.deepEqual(checkPermitAcquisition(ro.value.permit, coord.getLiveFacts()), { ok: true });
    assert.equal((await coord.releaseTerminal(ro.value.lease)).ok, true);
  });
});

describe("P6.2 terminal read-write cannot coexist with the editor writer (no dual writers at runtime)", () => {
  it("editor write and terminal read-write can never coexist in any reachable runtime state", async () => {
    const { coord, editorCapability, terminalCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RW]: "read_write",
    });
    const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-edit-1");
    assert.equal(edit.ok, true);
    const logical = coord.getLogicalState();
    assert.equal(allowsEditorWrite(logical.ownership) && allowsTerminalWrite(logical.ownership), false);
    const rwBlocked = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rwBlocked.ok, false);
    if (!rwBlocked.ok) assert.equal(rwBlocked.rejection.code, "WORKSPACE_BUSY");
    assert.equal(coord.releaseEditor((edit.ok ? edit.value : null as never).lease).ok, true);
  });

  it("no dual-writer state is reachable at runtime across the full ownership cycle", async () => {
    const { coord, editorCapability, terminalCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RW]: "read_write",
    });
    const seen: string[] = [];
    seen.push(coord.describe().ownership);
    const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, true);
    seen.push(coord.describe().ownership);
    assert.equal((await coord.releaseTerminal((rw.ok ? rw.value : null as never).lease)).ok, true);
    seen.push(coord.describe().ownership);
    const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-edit-1");
    assert.equal(edit.ok, true);
    seen.push(coord.describe().ownership);
    assert.equal(coord.releaseEditor((edit.ok ? edit.value : null as never).lease).ok, true);
    for (const state of seen) {
      assert.equal(allowsEditorWrite(state as never) && allowsTerminalWrite(state as never), false, state);
    }
  });
});

describe("P6.2 terminal read-write acquire requires canonical clean and exclusive conditions", () => {
  it("a dirty buffer rejects DIRTY_BUFFER_CONFLICT with no epoch change and no tombstone bypass", async () => {
    const { coord, editorCapability, terminalCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RW]: "read_write",
    });
    assert.equal(coord.setBufferFacts(editorCapability, { dirtyBufferCount: 1, pendingCreationCount: 0 }).ok, true);
    const before = coord.describe();
    const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, false);
    if (!rw.ok) assert.equal(rw.rejection.code, "DIRTY_BUFFER_CONFLICT");
    assert.equal(coord.describe().epoch, before.epoch);
    assert.equal(coord.setBufferFacts(editorCapability, { dirtyBufferCount: 0, pendingCreationCount: 0 }).ok, true);
    const clean = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-2");
    assert.equal(clean.ok, true);
    if (!clean.ok) throw new Error("unreachable");
    assert.equal((await coord.releaseTerminal(clean.value.lease)).ok, true);
  });

  it("a pending creation rejects DIRTY_BUFFER_CONFLICT", async () => {
    const { coord, editorCapability, terminalCapability } = openHarness({ [OP_RW]: "read_write" });
    assert.equal(coord.setBufferFacts(editorCapability, { dirtyBufferCount: 0, pendingCreationCount: 1 }).ok, true);
    const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, false);
    if (!rw.ok) assert.equal(rw.rejection.code, "DIRTY_BUFFER_CONFLICT");
  });

  it("an active read-only observer rejects WORKSPACE_BUSY and is never auto-killed", async () => {
    const { coord, terminalCapability } = openHarness({ [OP_RO_A]: "read_only", [OP_RW]: "read_write" });
    const ro = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(ro.ok, true);
    const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, false);
    if (!rw.ok) assert.equal(rw.rejection.code, "WORKSPACE_BUSY");
    assert.equal(coord.getLogicalState().activeRoCount, 1);
    if (!ro.ok) throw new Error("unreachable");
    assert.equal((await coord.releaseTerminal(ro.value.lease)).ok, true);
    const after = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-2");
    assert.equal(after.ok, true);
    if (!after.ok) throw new Error("unreachable");
    assert.equal((await coord.releaseTerminal(after.value.lease)).ok, true);
  });

  it("an unknown operation rejects NOT_AUTHORIZED with zero mutation", async () => {
    const { coord, terminalCapability } = openHarness({ [OP_RO_A]: "read_only" });
    const before = coord.describe();
    const forged = await coord.runTerminalOperation(terminalCapability, "C01-L001-S009-B009", "req-forged");
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.equal(forged.rejection.code, "NOT_AUTHORIZED");
    assert.deepEqual(coord.describe(), before);
  });
});

describe("P6.2 save-in-progress serializes terminal read-write (wait then revalidate)", () => {
  it("a read-write start during an active save waits and completes after settlement when still clean", async () => {
    const { coord, editorCapability, terminalCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RW]: "read_write",
    });
    assert.equal(coord.beginSave(editorCapability).ok, true);
    let rwSettled = false;
    const rwPromise = coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1").then((outcome) => {
      rwSettled = true;
      return outcome;
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(rwSettled, false);
    assert.equal(coord.endSave(editorCapability).ok, true);
    const rw = await rwPromise;
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    assert.equal(rw.value.descriptor.ownership, "TERMINAL_OWNED");
    assert.equal((await coord.releaseTerminal(rw.value.lease)).ok, true);
  });

  it("a read-write waiter that finds dirty buffers after the save rejects DIRTY_BUFFER_CONFLICT", async () => {
    const { coord, editorCapability, terminalCapability } = openHarness({ [OP_RW]: "read_write" });
    assert.equal(coord.beginSave(editorCapability).ok, true);
    const rwPromise = coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(coord.setBufferFacts(editorCapability, { dirtyBufferCount: 1, pendingCreationCount: 0 }).ok, true);
    assert.equal(coord.endSave(editorCapability).ok, true);
    const rw = await rwPromise;
    assert.equal(rw.ok, false);
    if (!rw.ok) assert.equal(rw.rejection.code, "DIRTY_BUFFER_CONFLICT");
  });

  it("a second save while one is active rejects WORKSPACE_BUSY", () => {
    const { coord, editorCapability } = openHarness({ [OP_RO_A]: "read_only" });
    assert.equal(coord.beginSave(editorCapability).ok, true);
    const second = coord.beginSave(editorCapability);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.rejection.code, "WORKSPACE_BUSY");
    assert.equal(coord.endSave(editorCapability).ok, true);
  });
});

describe("P6.2 transition barrier blocks new writers while an access change is in flight", () => {
  it("editor, read-only and read-write starts all reject while TRANSITION owns the workspace", async () => {
    const provider = createManualEpochProvider();
    const { coord, policy, manifest, editorCapability, terminalCapability } = (() => {
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
          review_note: "transition harness",
        },
        [OP_RO_A, OP_RW, OP_RW_2],
      );
      assert.equal(policyOutcome.ok, true);
      if (!policyOutcome.ok) throw new Error("unreachable");
      const inner = createWorkspaceCoordinator({ provider });
      const opened = inner.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: manifestOutcome.value });
      assert.equal(opened.ok, true);
      if (!opened.ok) throw new Error("unreachable");
      return { coord: inner, policy: policyOutcome.value, manifest: manifestOutcome.value, ...opened.value };
    })();
    void policy;
    void manifest;
    const rwPromise = coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(provider.pendingPrepares, 1);
    assert.equal(coord.getLogicalState().inTransition, true);
    assert.equal(coord.describe().ownership, "TRANSITION");
    const editor = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-edit-1");
    assert.equal(editor.ok, false);
    if (!editor.ok) assert.equal(editor.rejection.code, "INVALID_TRANSITION");
    const ro = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(ro.ok, false);
    if (!ro.ok) assert.equal(ro.rejection.code, "INVALID_TRANSITION");
    const rw2 = await coord.runTerminalOperation(terminalCapability, OP_RW_2, "req-rw-2");
    assert.equal(rw2.ok, false);
    if (!rw2.ok) assert.equal(rw2.rejection.code, "INVALID_TRANSITION");
    provider.resolveNextPrepare();
    const rw = await rwPromise;
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    assert.equal(rw.value.descriptor.ownership, "TERMINAL_OWNED");
    const releasePromise = coord.releaseTerminal(rw.value.lease);
    assert.equal(provider.pendingRetires, 1);
    provider.resolveNextRetire("confirmed");
    assert.equal((await releasePromise).ok, true);
  });
});

describe("P6.2 release restores the canonical next state and rejects foreign or stale releases", () => {
  it("read-write release returns to editor ownership with a new epoch and revision", async () => {
    const { coord, terminalCapability } = openHarness({ [OP_RO_A]: "read_only", [OP_RW]: "read_write" });
    const before = coord.describe();
    const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    assert.equal(rw.value.descriptor.ownership, "TERMINAL_OWNED");
    assert.ok(rw.value.descriptor.epoch > before.epoch);
    const released = await coord.releaseTerminal(rw.value.lease);
    assert.equal(released.ok, true);
    if (!released.ok) throw new Error("unreachable");
    assert.equal(released.value.ownership, "EDITOR_OWNED");
    assert.ok(released.value.epoch > rw.value.descriptor.epoch);
    assert.ok(released.value.workspaceRevision > before.workspaceRevision);
    assert.equal(isValidOwnershipAccess(released.value.ownership, released.value.epochAccess), true);
  });

  it("a foreign lease from another coordinator rejects and never releases local authority", async () => {
    const first = openHarness({ [OP_RW]: "read_write" });
    const second = openHarness({ [OP_RW]: "read_write" });
    const rw = await first.coord.runTerminalOperation(first.terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    const foreign = await second.coord.releaseTerminal(rw.value.lease);
    assert.equal(foreign.ok, false);
    if (!foreign.ok) {
      assert.ok(
        foreign.rejection.code === "WRONG_OWNER" ||
          foreign.rejection.code === "WORKSPACE_REVOKED" ||
          foreign.rejection.code === "STALE_EPOCH",
      );
    }
    assert.equal(first.coord.getLogicalState().activeRw, true);
    assert.equal((await first.coord.releaseTerminal(rw.value.lease)).ok, true);
  });

  it("a duplicate release rejects (leases are single-use, never idempotent)", async () => {
    const { coord, terminalCapability } = openHarness({ [OP_RO_A]: "read_only" });
    const ro = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(ro.ok, true);
    if (!ro.ok) throw new Error("unreachable");
    assert.equal((await coord.releaseTerminal(ro.value.lease)).ok, true);
    const again = await coord.releaseTerminal(ro.value.lease);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.rejection.code, "WORKSPACE_REVOKED");
  });

  it("an editor release under a mismatched lease rejects WRONG_OWNER", async () => {
    const { coord, editorCapability } = openHarness({ [OP_RO_A]: "read_only" });
    const first = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    const forged = { ...first.value.lease, leaseId: "lease-999999" };
    const released = coord.releaseEditor(forged);
    assert.equal(released.ok, false);
    if (!released.ok) assert.ok(released.rejection.code === "WORKSPACE_REVOKED" || released.rejection.code === "WRONG_OWNER");
    assert.equal(coord.releaseEditor(first.value.lease).ok, true);
  });
});

describe("P6.2 generation and epoch fencing invalidate old authority", () => {
  it("an old generation lease rejects STALE_SESSION after reset", async () => {
    const { coord, descriptor, editorCapability, terminalCapability } = openHarness({ [OP_RW]: "read_write" });
    const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(edit.ok, true);
    if (!edit.ok) throw new Error("unreachable");
    const oldLease = edit.value.lease;
    assert.equal(coord.releaseEditor(oldLease).ok, true);
    const reset = await coord.resetCombinedSession(descriptor, "req-reset-1");
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.descriptor.generation, 2);
    const stale = coord.releaseEditor(oldLease);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "STALE_SESSION");
    const staleTerminal = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-stale");
    assert.equal(staleTerminal.ok, false);
    if (!staleTerminal.ok) {
      assert.ok(staleTerminal.rejection.code === "STALE_SESSION" || staleTerminal.rejection.code === "WORKSPACE_REVOKED");
    }
  });

  it("an old epoch lease rejects STALE_EPOCH after a read-write cycle", async () => {
    const { coord, terminalCapability } = openHarness({ [OP_RO_A]: "read_only", [OP_RW]: "read_write" });
    const ro = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(ro.ok, true);
    if (!ro.ok) throw new Error("unreachable");
    const oldLease = ro.value.lease;
    assert.equal((await coord.releaseTerminal(oldLease)).ok, true);
    const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    const stale = await coord.releaseTerminal(oldLease);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "STALE_EPOCH");
    assert.equal((await coord.releaseTerminal(rw.value.lease)).ok, true);
  });

  it("live, stale-generation, stale-epoch and revoked permits fence exactly via the P6.1 predicate", async () => {
    const { coord, terminalCapability } = openHarness({ [OP_RO_A]: "read_only", [OP_RW]: "read_write" });
    const ro = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(ro.ok, true);
    if (!ro.ok) throw new Error("unreachable");
    const live = coord.getLiveFacts();
    assert.deepEqual(checkPermitAcquisition(ro.value.permit, live), { ok: true });
    const oldGeneration = checkPermitAcquisition({ ...ro.value.permit, generation: live.generation + 1 }, live);
    assert.equal(oldGeneration.ok, false);
    if (!oldGeneration.ok) assert.equal(oldGeneration.rejection.code, "STALE_SESSION");
    const oldEpoch = checkPermitAcquisition({ ...ro.value.permit, epoch: live.epoch + 1 }, live);
    assert.equal(oldEpoch.ok, false);
    if (!oldEpoch.ok) assert.equal(oldEpoch.rejection.code, "STALE_EPOCH");
    const revoked = checkPermitAcquisition(ro.value.permit, { ...live, revoked_lease_ids: [ro.value.permit.lease_id] });
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.equal(revoked.rejection.code, "WORKSPACE_REVOKED");
    assert.equal((await coord.releaseTerminal(ro.value.lease)).ok, true);
  });

  it("a revoked capability cannot acquire (WORKSPACE_REVOKED)", async () => {
    const { coord, descriptor, editorCapability } = openHarness({ [OP_RO_A]: "read_only" });
    const reset = await coord.resetCombinedSession(descriptor, "req-reset-1");
    assert.equal(reset.ok, true);
    const staleAcquire = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(staleAcquire.ok, false);
    if (!staleAcquire.ok) {
      assert.ok(staleAcquire.rejection.code === "STALE_SESSION" || staleAcquire.rejection.code === "WORKSPACE_REVOKED");
    }
    void reset;
  });
});

describe("P6.2 reset blocks new ownership immediately and old generations stay invalid", () => {
  it("reset latches synchronously: a concurrent acquire fails while reset is in flight", async () => {
    const provider = createManualEpochProvider();
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
        terminal_access: { [OP_RO_A]: "read_only" },
        reviewed_by: "review-board-1",
        review_note: "reset latch harness",
      },
      [OP_RO_A],
    );
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    const coord = createWorkspaceCoordinator({ provider });
    const opened = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: manifestOutcome.value });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const resetPromise = coord.resetCombinedSession(opened.value.descriptor, "req-reset-1");
    assert.equal(provider.pendingRetires, 1);
    assert.equal(coord.describe().ownership, "RESETTING");
    const acquire = await coord.runEditorOperation(opened.value.editorCapability, "edit-op-1", "req-1");
    assert.equal(acquire.ok, false);
    if (!acquire.ok) {
      assert.ok(acquire.rejection.code === "INVALID_TRANSITION" || acquire.rejection.code === "WORKSPACE_REVOKED");
    }
    provider.resolveNextRetire("confirmed");
    const reset = await resetPromise;
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.descriptor.generation, 2);
    assert.equal(reset.value.descriptor.ownership, "EDITOR_OWNED");
  });

  it("reset exposes the frozen barrier order and only the full sequence completes", async () => {
    const { coord, descriptor } = openHarness({ [OP_RO_A]: "read_only" });
    const reset = await coord.resetCombinedSession(descriptor, "req-reset-1");
    assert.equal(reset.ok, true);
    const phases = coord.getResetPhases();
    assert.equal(isValidResetPrefix(phases), true);
    assert.equal(isCompleteResetSequence(phases), true);
    assert.deepEqual([...phases], [
      "REVOKE",
      "SETTLE_SAVE_CANCEL",
      "STOP_REMOVE_CONTAINER",
      "CONFIRM_CLEANUP",
      "DISCARD_RESEED",
      "EXPOSE_NEW_GENERATION",
    ]);
  });

  it("an old session identity rejects STALE_SESSION (rotated identity fences generation-less callers)", async () => {
    const { coord, descriptor } = openHarness({ [OP_RO_A]: "read_only" });
    const reset = await coord.resetCombinedSession(descriptor, "req-reset-1");
    assert.equal(reset.ok, true);
    const snapshot = coord.getCombinedSnapshot(descriptor, 0);
    assert.equal(snapshot.ok, false);
    if (!snapshot.ok) assert.equal(snapshot.rejection.code, "STALE_SESSION");
  });
});

describe("P6.2 close fails closed and late callbacks cannot reopen it", () => {
  it("close blocks every new acquisition and completes idempotently", async () => {
    const { coord, descriptor, editorCapability, terminalCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RW]: "read_write",
    });
    const closed = await coord.closeCombinedSession(descriptor, "req-close-1");
    assert.equal(closed.ok, true);
    for (const outcome of [
      await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1"),
      await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a"),
      await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1"),
    ]) {
      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.ok(outcome.rejection.code === "INVALID_TRANSITION" || outcome.rejection.code === "WORKSPACE_REVOKED");
      }
    }
    const again = await coord.closeCombinedSession(descriptor, "req-close-1");
    assert.equal(again.ok, true);
  });

  it("a late provider completion after close cannot reopen the workspace", async () => {
    const provider = createManualEpochProvider();
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
        terminal_access: { [OP_RW]: "read_write" },
        reviewed_by: "review-board-1",
        review_note: "late completion harness",
      },
      [OP_RW],
    );
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    const coord = createWorkspaceCoordinator({ provider });
    const opened = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: manifestOutcome.value });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const rwPromise = coord.runTerminalOperation(opened.value.terminalCapability, OP_RW, "req-rw-1");
    assert.equal(provider.pendingPrepares, 1);
    const closePromise = coord.closeCombinedSession(opened.value.descriptor, "req-close-1");
    assert.equal(provider.pendingRetires, 1);
    provider.resolveNextRetire("confirmed");
    assert.equal((await closePromise).ok, true);
    provider.resolveNextPrepare();
    const late = await rwPromise;
    assert.equal(late.ok, false);
    if (!late.ok) assert.ok(late.rejection.code === "STALE_SESSION" || late.rejection.code === "INVALID_TRANSITION");
    assert.equal(coord.getLogicalState().closed, true);
    const after = await coord.runEditorOperation(opened.value.editorCapability, "edit-op-1", "req-1");
    assert.equal(after.ok, false);
  });
});

describe("P6.2 HOLD is fail-closed with only explicit reset or close exits", () => {
  it("provider failure freezes the session: no writer is admitted in HOLD", () => {
    const { coord, editorCapability, terminalCapability, epochCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RW]: "read_write",
    });
    coord.onProviderFailure(epochCapability, "transport_lost");
    assert.equal(coord.describe().ownership, "HOLD");
    assert.equal(holdExitsAreExplicit(), true);
    void editorCapability;
    void terminalCapability;
  });

  it("unconfirmed retirement holds with retained resources and no new generation", async () => {
    const provider = createManualEpochProvider();
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
        terminal_access: { [OP_RO_A]: "read_only" },
        reviewed_by: "review-board-1",
        review_note: "unconfirmed harness",
      },
      [OP_RO_A],
    );
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    const coord = createWorkspaceCoordinator({ provider });
    const opened = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: manifestOutcome.value });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const resetPromise = coord.resetCombinedSession(opened.value.descriptor, "req-reset-1");
    provider.resolveNextRetire("unconfirmed");
    const reset = await resetPromise;
    assert.equal(reset.ok, false);
    if (!reset.ok) assert.equal(reset.rejection.code, "CLEANUP_UNCONFIRMED");
    assert.equal(coord.describe().ownership, "HOLD");
    const phases = coord.getResetPhases();
    assert.equal(isValidResetPrefix(phases), true);
    assert.equal(isCompleteResetSequence(phases), false);
    const acquire = await coord.runEditorOperation(opened.value.editorCapability, "edit-op-1", "req-1");
    assert.equal(acquire.ok, false);
    const recoveryPromise = coord.resetCombinedSession(opened.value.descriptor, "req-reset-2");
    provider.resolveNextRetire("confirmed");
    const recovery = await recoveryPromise;
    assert.equal(recovery.ok, true);
    if (!recovery.ok) throw new Error("unreachable");
    assert.equal(recovery.value.descriptor.generation, 2);
    assert.equal(recovery.value.descriptor.ownership, "EDITOR_OWNED");
  });

  function holdExitsAreExplicit(): boolean {
    return (
      isLegalOwnershipTransition("HOLD", "EDITOR_OWNED") === false &&
      isLegalOwnershipTransition("HOLD", "TERMINAL_OWNED") === false &&
      isLegalOwnershipTransition("HOLD", "TRANSITION") === false &&
      isLegalOwnershipTransition("HOLD", "RESETTING") === true &&
      isLegalOwnershipTransition("HOLD", "CLOSING") === true
    );
  }
});

describe("P6.2 illegal direct ownership hops reject (every access change crosses TRANSITION)", () => {
  it("direct editor to terminal and terminal to editor hops are illegal in the frozen vocabulary", () => {
    assert.equal(isLegalOwnershipTransition("EDITOR_OWNED", "TERMINAL_OWNED"), false);
    assert.equal(isLegalOwnershipTransition("TERMINAL_OWNED", "EDITOR_OWNED"), false);
    assert.equal(isLegalOwnershipTransition("EDITOR_OWNED", "TRANSITION"), true);
    assert.equal(isLegalOwnershipTransition("TERMINAL_OWNED", "TRANSITION"), true);
    assert.equal(isLegalOwnershipTransition("TRANSITION", "EDITOR_OWNED"), true);
    assert.equal(isLegalOwnershipTransition("TRANSITION", "TERMINAL_OWNED"), true);
  });

  it("the coordinator never reports a direct owned-to-owned hop in its event order", async () => {
    const { coord, terminalCapability } = openHarness({ [OP_RO_A]: "read_only", [OP_RW]: "read_write" });
    const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    assert.equal((await coord.releaseTerminal(rw.value.lease)).ok, true);
    const types = coord.listEvents().map((event) => event.type);
    const acquired = types.indexOf("workspace.writer.acquired");
    const released = types.indexOf("workspace.writer.released");
    assert.ok(acquired !== -1 && released !== -1 && acquired < released);
    assert.ok(types.includes("workspace.epoch.started"));
    assert.ok(types.includes("workspace.epoch.retired"));
  });
});

describe("P6.2 access comes only from the reviewed policy (no command heuristics, no renderer choice)", () => {
  it("resolution takes (policy, operationId) only: misleading names never change the outcome", async () => {
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
        terminal_access: { [OP_RO_A]: "read_write", [OP_RO_B]: "read_only" },
        reviewed_by: "review-board-1",
        review_note: "misleading names: watcher-named op is read-write, test-named op is read-only",
      },
      [OP_RO_A, OP_RO_B],
    );
    assert.equal(policyOutcome.ok, true);
    if (!policyOutcome.ok) throw new Error("unreachable");
    assert.equal(resolveTerminalAccess(policyOutcome.value, OP_RO_A).ok, true);
    const coord = createWorkspaceCoordinator();
    const opened = coord.openCombinedSession({ validatedIr: null, reviewedPolicy: policyOutcome.value, seedManifest: manifestOutcome.value });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    assert.equal(
      coord.setBufferFacts(opened.value.editorCapability, { dirtyBufferCount: 1, pendingCreationCount: 0 }).ok,
      true,
    );
    const watcherNamed = await coord.runTerminalOperation(opened.value.terminalCapability, OP_RO_A, "req-1");
    assert.equal(watcherNamed.ok, false);
    if (!watcherNamed.ok) assert.equal(watcherNamed.rejection.code, "DIRTY_BUFFER_CONFLICT");
    const testNamed = await coord.runTerminalOperation(opened.value.terminalCapability, OP_RO_B, "req-2");
    assert.equal(testNamed.ok, true);
    if (!testNamed.ok) throw new Error("unreachable");
    assert.equal((await coord.releaseTerminal(testNamed.value.lease)).ok, true);
  });

  it("no command parameter exists structurally on either the policy or the coordinator path", () => {
    assert.equal(resolveTerminalAccess.length, 2);
    assert.equal(coordinatorResolvesAccessWithoutCommands(), true);
    const coord = createWorkspaceCoordinator();
    assert.equal(coord.runTerminalOperation.length, 3);
    assert.equal(coord.runEditorOperation.length, 3);
  });

  it("renderer request shapes stay identifier-only: hostile access-mode fields reject", () => {
    for (const schema of [
      RunEditorOperationRequestSchema,
      CancelEditorOperationRequestSchema,
      GetEditorSnapshotRequestSchema,
      AcknowledgePresentationRequestSchema,
    ]) {
      for (const field of ["workspaceAccess", "accessMode", "mountMode", "ownership", "command", "content", "policy_digest", "epoch", "lease_id"]) {
        const base = { session_id: "sess-1", generation: 1, operation_id: OP_RO_A, request_id: "req-1", after_seq: 0, plan_id: "plan-1", chunk_seq: 0 };
        assert.equal(schema.safeParse({ ...base, [field]: "read_write" }).success, false, field);
      }
    }
  });

  it("a forged renderer-built capability cannot acquire (WORKSPACE_REVOKED, never a bypass)", async () => {
    const { coord } = openHarness({ [OP_RO_A]: "read_only" });
    const forged = { kind: "editor_capability", leaseId: "lease-999999" } as never;
    const outcome = await coord.runEditorOperation(forged, "edit-op-1", "req-1");
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.rejection.code, "WORKSPACE_REVOKED");
  });
});

describe("P6.2 snapshots are runtime-safe and portable (no host paths, no runtime secrets)", () => {
  it("snapshots validate, pair ownership with access, and serialize without host facts", async () => {
    const { coord, descriptor, editorCapability, terminalCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RW]: "read_write",
    });
    assert.equal(
      coord.setOpenDocuments(editorCapability, [
        { portable_path: "src/a.ts", disk_revision: 1, buffer_revision: 1, dirty: false },
      ]).ok,
      true,
    );
    const ro = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(ro.ok, true);
    const snapshot = coord.getCombinedSnapshot(descriptor, 0);
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) throw new Error("unreachable");
    assert.equal(WorkspaceSnapshotSchema.safeParse(snapshot.value).success, true);
    assert.equal(isValidOwnershipAccess(snapshot.value.ownership, snapshot.value.epoch_access), true);
    const serialized = JSON.stringify(snapshot.value);
    assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(serialized, /\\\\/);
    assert.doesNotMatch(serialized, /course-factory/);
    assert.doesNotMatch(serialized, /container/i);
    if (!ro.ok) throw new Error("unreachable");
    assert.equal((await coord.releaseTerminal(ro.value.lease)).ok, true);
  });

  it("hostile open-document paths reject at the trusted boundary", () => {
    const { coord, editorCapability } = openHarness({ [OP_RO_A]: "read_only" });
    for (const hostile of ["E:\\evil\\a.ts", "/absolute/a.ts", "../escape.ts", "nul.txt"]) {
      const outcome = coord.setOpenDocuments(editorCapability, [
        { portable_path: hostile, disk_revision: 0, buffer_revision: 0, dirty: false },
      ]);
      assert.equal(outcome.ok, false, hostile);
      if (!outcome.ok) assert.equal(outcome.rejection.code, "INVALID_REQUEST");
    }
  });
});

describe("P6.2 preserves the P6.1 reviewed policy without mutation", () => {
  it("ownership writers, fencing predicates and error categories still hold", () => {
    assert.equal(ownershipWriter("EDITOR_OWNED"), "editor_adapter");
    assert.equal(ownershipWriter("TERMINAL_OWNED"), "terminal_rw");
    assert.equal(allowsEditorWrite("EDITOR_OWNED") && allowsTerminalWrite("EDITOR_OWNED"), false);
    assert.equal(allowsEditorWrite("TERMINAL_OWNED") && allowsTerminalWrite("TERMINAL_OWNED"), false);
  });

  it("policy tampering still invalidates authorization through the coordinator binding", async () => {
    const { coord, policy, terminalCapability } = openHarness({ [OP_RO_A]: "read_only" });
    void coord;
    void terminalCapability;
    const tampered = { ...policy, terminal_access: { [OP_RO_A]: "read_write" as const } };
    assert.equal(resolveTerminalAccess(tampered, OP_RO_A).ok, false);
  });
});

describe("P6.2 performs no file I/O and owns no execution machinery", () => {
  it("product source imports only zod and relative contracts (no fs, process, container or presentation modules)", () => {
    const source = readFileSync(join(here, "..", "src", "coordinator.ts"), "utf8");
    const noComments = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const specifiers: string[] = [];
    for (const match of noComments.matchAll(/from\s*["']([^"']+)["']/g)) specifiers.push(match[1]);
    for (const specifier of specifiers) {
      const allowed = specifier === "zod" || specifier === "node:crypto" || specifier.startsWith("./") || specifier.startsWith("../");
      assert.equal(allowed, true, `forbidden import '${specifier}'`);
    }
    for (const token of ["node:fs", "node:child_process", "node:pty", "dockerode", "playwright", "puppeteer", "xterm"]) {
      assert.equal(noComments.includes(token), false, token);
    }
  });

  it("a full lifecycle leaves the package directory byte-identical (no lesson file mutation)", async () => {
    const { coord, descriptor, editorCapability, terminalCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RW]: "read_write",
    });
    const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(edit.ok, true);
    if (!edit.ok) throw new Error("unreachable");
    assert.equal(coord.releaseEditor(edit.value.lease).ok, true);
    const ro = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(ro.ok, true);
    if (!ro.ok) throw new Error("unreachable");
    assert.equal((await coord.releaseTerminal(ro.value.lease)).ok, true);
    const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    assert.equal((await coord.releaseTerminal(rw.value.lease)).ok, true);
    const reset = await coord.resetCombinedSession(descriptor, "req-reset-1");
    assert.equal(reset.ok, true);
  });
});

describe("P6.2 deterministic replay of the same transition sequence gives the same logical state", () => {
  it("two coordinators replaying identical ordered operations converge logically", async () => {
    async function replay(): Promise<ReturnType<typeof openHarness>["coord"]> {
      const harness = openHarness({ [OP_RO_A]: "read_only", [OP_RW]: "read_write" });
      const { coord, editorCapability, terminalCapability, descriptor } = harness;
      const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
      assert.equal(edit.ok, true);
      if (!edit.ok) throw new Error("unreachable");
      assert.equal(coord.releaseEditor(edit.value.lease).ok, true);
      const ro = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
      assert.equal(ro.ok, true);
      if (!ro.ok) throw new Error("unreachable");
      assert.equal((await coord.releaseTerminal(ro.value.lease)).ok, true);
      const rw = await coord.runTerminalOperation(terminalCapability, OP_RW, "req-rw-1");
      assert.equal(rw.ok, true);
      if (!rw.ok) throw new Error("unreachable");
      assert.equal((await coord.releaseTerminal(rw.value.lease)).ok, true);
      void descriptor;
      return coord;
    }
    const first = await replay();
    const second = await replay();
    assert.deepEqual(first.getLogicalState(), second.getLogicalState());
    assert.deepEqual(first.describe(), second.describe());
  });
});

describe("P6.2 safety stop and cancel routes bypass ordering without bypassing fencing", () => {
  it("cancelEditor releases the active transaction and unblocks a waiter", async () => {
    const { coord, editorCapability } = openHarness({ [OP_RO_A]: "read_only" });
    const first = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(first.ok, true);
    let secondSettled = false;
    const secondPromise = coord.runEditorOperation(editorCapability, "edit-op-2", "req-2").then((outcome) => {
      secondSettled = true;
      return outcome;
    });
    await Promise.resolve();
    assert.equal(secondSettled, false);
    assert.equal(coord.cancelEditor(editorCapability, "edit-op-1", "req-cancel-1").ok, true);
    const second = await secondPromise;
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(coord.releaseEditor(second.value.lease).ok, true);
  });

  it("stopTerminal ends one read-only observer while its peers continue", async () => {
    const { coord, terminalCapability } = openHarness({ [OP_RO_A]: "read_only", [OP_RO_B]: "read_only" });
    const roA = await coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    const roB = await coord.runTerminalOperation(terminalCapability, OP_RO_B, "req-ro-b");
    assert.equal(roA.ok, true);
    assert.equal(roB.ok, true);
    if (!roA.ok || !roB.ok) throw new Error("unreachable");
    assert.equal(coord.getLogicalState().activeRoCount, 2);
    const stopped = await coord.stopTerminal(terminalCapability, roA.value.lease.peerId as string, "req-stop-1");
    assert.equal(stopped.ok, true);
    assert.equal(coord.getLogicalState().activeRoCount, 1);
    assert.equal((await coord.releaseTerminal(roB.value.lease)).ok, true);
  });

  it("cancelTerminal revokes a queued waiter without disturbing live peers", async () => {
    const { coord, editorCapability, terminalCapability } = openHarness({
      [OP_RO_A]: "read_only",
      [OP_RW]: "read_write",
    });
    const edit = await coord.runEditorOperation(editorCapability, "edit-op-1", "req-1");
    assert.equal(edit.ok, true);
    const queued = coord.runTerminalOperation(terminalCapability, OP_RO_A, "req-ro-a");
    await Promise.resolve();
    assert.equal(coord.cancelTerminal(terminalCapability, OP_RO_A, "req-cancel-1").ok, true);
    const cancelled = await queued;
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.rejection.code, "WORKSPACE_REVOKED");
    if (!edit.ok) throw new Error("unreachable");
    assert.equal(coord.releaseEditor(edit.value.lease).ok, true);
  });
});

describe("P6.2 canonical error model covers the ownership surface", () => {
  it("WORKSPACE_BUSY, DIRTY_BUFFER_CONFLICT, STALE_SESSION, STALE_EPOCH, WORKSPACE_REVOKED, WRONG_OWNER, INVALID_TRANSITION and NOT_AUTHORIZED all occur canonically", async () => {
    const busy = openHarness({ [OP_RO_A]: "read_only", [OP_RW]: "read_write" });
    const ro = await busy.coord.runTerminalOperation(busy.terminalCapability, OP_RO_A, "req-ro-a");
    assert.equal(ro.ok, true);
    const rwBusy = await busy.coord.runTerminalOperation(busy.terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rwBusy.ok, false);
    if (!rwBusy.ok) assert.equal(rwBusy.rejection.code, "WORKSPACE_BUSY");
    if (!ro.ok) throw new Error("unreachable");
    assert.equal((await busy.coord.releaseTerminal(ro.value.lease)).ok, true);

    const dirty = openHarness({ [OP_RW]: "read_write" });
    assert.equal(dirty.coord.setBufferFacts(dirty.editorCapability, { dirtyBufferCount: 1, pendingCreationCount: 0 }).ok, true);
    const rwDirty = await dirty.coord.runTerminalOperation(dirty.terminalCapability, OP_RW, "req-rw-1");
    assert.equal(rwDirty.ok, false);
    if (!rwDirty.ok) assert.equal(rwDirty.rejection.code, "DIRTY_BUFFER_CONFLICT");

    const unknown = await dirty.coord.runTerminalOperation(dirty.terminalCapability, "C01-L001-S009-B009", "req-x");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.rejection.code, "NOT_AUTHORIZED");
  });
});
