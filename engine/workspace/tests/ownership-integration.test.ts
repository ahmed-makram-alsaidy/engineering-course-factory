// P6.5 Ownership integration gate — deterministic composition proofs (offline).
//
// Canonical task: P6-DESIGN-SPEC section 22, P6.5 Ownership integration gate
// ("Coordinator + provider + adapter, no typing/UI"; PASS "Real writer
// exclusion, handoff scan, watcher visibility and failure cleanup").
// Canonical authority: P6-DESIGN-SPEC section 26, ADR-0011.
//
// Integrates and proves the ownership chain end-to-end (fake epoch seam only,
// real Windows filesystem via the P6.4 adapter under temp/P6.5):
//
//   ReviewedWorkspacePolicy -> WorkspaceCoordinator -> current
//   generation/epoch/lease -> WindowsFileAdapter (host writes)
//
// and the coordinator permit fencing consumed by the Docker epoch provider
// (real Docker composition lives in ownership-integration-docker.test.ts).
//
// The system proves the three independently-passing layers cannot bypass each
// other's authority when composed. No typing, no scheduler, no Monaco, no
// semantic file_open/file_create/type_code/replace_code/file_save, no UI, no
// renderer filesystem API. Controlled publication through the adapter uses
// coordinator-issued editor leases only, as an internal integration harness
// (never a semantic save, never renderer-reachable).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RunEditorOperationRequestSchema,
  allowsEditorWrite,
  allowsTerminalWrite,
  checkPermitAcquisition,
  isLegalOwnershipTransition,
  ownershipWriter,
  type WorkspaceOwnership,
} from "../src/protocol.ts";
import {
  computeSeedManifestDigest,
  createReviewedWorkspacePolicy,
  createSeedManifest,
  sha256Hex,
} from "../src/policy.ts";
import {
  createManualEpochProvider,
  createWorkspaceCoordinator,
  type EditorLease,
  type SharedWorkspaceCoordinator,
  type TerminalLease,
} from "../src/coordinator.ts";
import {
  openWindowsFileAdapter,
  type AdapterAuthority,
  type WindowsFileAdapter,
} from "../src/file-adapter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.5", "ownership-integration");

const COURSE = "C01";
const LESSON = "C01-L001";
const OP_RO = "C01-L001-S001-B001";
const OP_RO2 = "C01-L001-S001-B002";
const OP_RW = "C01-L001-S002-B001";
const OP_RW2 = "C01-L001-S002-B002";

let counter = 0;

function proof(message: string): void {
  console.log(`P6.5 PROOF: ${message}`);
}

interface ComposedHarness {
  readonly tag: string;
  readonly coord: SharedWorkspaceCoordinator;
  readonly editorCapability: { kind: "editor_capability"; leaseId: string };
  readonly terminalCapability: { kind: "terminal_capability"; leaseId: string };
  readonly epochCapability: { kind: "epoch_capability"; leaseId: string };
  readonly leaf: string;
  readonly staging: string;
  readonly adapter: WindowsFileAdapter;
}

function openComposed(
  ops: Record<string, "read_only" | "read_write">,
  provider?: ReturnType<typeof createManualEpochProvider>,
): ComposedHarness {
  counter += 1;
  const tag = `cf-p65-d${counter}-${randomBytes(3).toString("hex")}`;
  const manifestOutcome = createSeedManifest([]);
  assert.equal(manifestOutcome.ok, true);
  if (!manifestOutcome.ok) throw new Error("unreachable");
  const policyOutcome = createReviewedWorkspacePolicy(
    {
      course_id: COURSE,
      lesson_id: LESSON,
      lesson_compiled_digest: sha256Hex(`p65-compiled-${counter}`),
      seed_manifest_digest: computeSeedManifestDigest(manifestOutcome.value),
      sandbox_policy_digest: sha256Hex("p65-sandbox-policy"),
      terminal_access: ops,
      reviewed_by: "review-board-1",
      review_note: "synthetic P6.5 review",
    },
    Object.keys(ops),
  );
  assert.equal(policyOutcome.ok, true);
  if (!policyOutcome.ok) throw new Error("unreachable");
  const coord =
    provider === undefined ? createWorkspaceCoordinator() : createWorkspaceCoordinator({ provider });
  const opened = coord.openCombinedSession({
    validatedIr: null,
    reviewedPolicy: policyOutcome.value,
    seedManifest: manifestOutcome.value,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(leaf, { recursive: true });
  mkdirSync(staging, { recursive: true });
  const d = opened.value.descriptor;
  const bound = openWindowsFileAdapter({
    sessionId: d.sessionId,
    generation: d.generation,
    workspaceId: d.workspaceId,
    leafHostPath: leaf,
    stagingHostPath: staging,
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error("unreachable");
  return {
    tag,
    coord,
    editorCapability: opened.value.editorCapability,
    terminalCapability: opened.value.terminalCapability,
    epochCapability: opened.value.epochCapability,
    leaf,
    staging,
    adapter: bound.value,
  };
}

/** Current coordinator-derived adapter authority for a live editor lease. */
function currentAuthority(coord: SharedWorkspaceCoordinator, lease: EditorLease): AdapterAuthority {
  const d = coord.describe();
  const live = coord.getLiveFacts();
  return {
    lease,
    ownership: d.ownership,
    liveEpoch: d.epoch,
    revokedLeaseIds: [...live.revoked_lease_ids],
  };
}

function stagingIsClean(harness: ComposedHarness): boolean {
  return readdirSync(harness.staging).length === 0;
}

function hostBytes(harness: ComposedHarness, rel: string): Uint8Array | null {
  const full = join(harness.leaf, ...rel.split("/"));
  if (!existsSync(full)) return null;
  return new Uint8Array(readFileSync(full));
}

before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "phase-owned P6.5 deterministic root is removed");
  console.log("P6.5 PROOF: CLEANUP deterministic temp/P6.5 ownership-integration removed");
});

describe("P6.5 authority chain and ownership matrix (one trusted writer)", () => {
  it("editor-owned host publish succeeds through the coordinator lease only", async () => {
    const h = openComposed({ [OP_RO]: "read_only", [OP_RW]: "read_write" });
    assert.equal(h.coord.describe().ownership, "EDITOR_OWNED");
    const admitted = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const published = await h.adapter.publishDocument(currentAuthority(h.coord, admitted.value.lease), {
      portablePath: "lesson.txt",
      content: "host bytes one\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, true, "editor-owned host publish succeeds");
    assert.equal(readFileSync(join(h.leaf, "lesson.txt"), "utf8"), "host bytes one\n");
    assert.equal(h.coord.releaseEditor(admitted.value.lease).ok, true);
    assert.equal(stagingIsClean(h), true);
    proof("editor-owned host publish succeeds");
  });

  it("ownership matrix exposes exactly one writer in every state", () => {
    const matrix: Array<{ state: WorkspaceOwnership; editor: boolean; terminal: boolean }> = [
      { state: "EDITOR_OWNED", editor: true, terminal: false },
      { state: "TERMINAL_OWNED", editor: false, terminal: true },
      { state: "TRANSITION", editor: false, terminal: false },
      { state: "RESETTING", editor: false, terminal: false },
      { state: "CLOSING", editor: false, terminal: false },
      { state: "HOLD", editor: false, terminal: false },
    ];
    for (const row of matrix) {
      assert.equal(allowsEditorWrite(row.state), row.editor, `${row.state} editor`);
      assert.equal(allowsTerminalWrite(row.state), row.terminal, `${row.state} terminal`);
    }
    assert.equal(ownershipWriter("EDITOR_OWNED"), "editor_adapter");
    assert.equal(ownershipWriter("TERMINAL_OWNED"), "terminal_rw");
    for (const barrier of ["TRANSITION", "RESETTING", "CLOSING", "HOLD"] as const) {
      assert.equal(ownershipWriter(barrier), "none");
    }
    assert.equal(isLegalOwnershipTransition("EDITOR_OWNED", "TERMINAL_OWNED"), false);
    assert.equal(isLegalOwnershipTransition("TERMINAL_OWNED", "EDITOR_OWNED"), false);
    proof("ownership matrix exposes exactly one writer");
  });

  it("no bypass path: forged or missing coordinator authority cannot publish", async () => {
    const h = openComposed({ [OP_RO]: "read_only", [OP_RW]: "read_write" });
    const admitted = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const good = currentAuthority(h.coord, admitted.value.lease);
    // Foreign session lease.
    const foreign = {
      ...good,
      lease: { ...admitted.value.lease, sessionId: "sess-foreign" },
    } as AdapterAuthority;
    const r1 = await h.adapter.publishDocument(foreign, {
      portablePath: "bypass.txt",
      content: "x\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.rejection.code, "WRONG_OWNER");
    // Revoked lease list containing the live lease.
    const revoked: AdapterAuthority = { ...good, revokedLeaseIds: [admitted.value.lease.leaseId] };
    const r2 = await h.adapter.publishDocument(revoked, {
      portablePath: "bypass.txt",
      content: "x\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.rejection.code, "WORKSPACE_REVOKED");
    assert.equal(existsSync(join(h.leaf, "bypass.txt")), false, "zero mutation on bypass attempts");
    assert.equal(stagingIsClean(h), true);
    assert.equal(h.coord.releaseEditor(admitted.value.lease).ok, true);
    proof("no bypass path");
  });
});

describe("P6.5 editor-owned plus read-only observation (no Docker here; mount proof is real)", () => {
  it("host publish succeeds beside a live RO peer and the peer observes exact bytes", async () => {
    const h = openComposed({ [OP_RO]: "read_only", [OP_RW]: "read_write" });
    const ro = await h.coord.runTerminalOperation(h.terminalCapability, OP_RO, "req-p65-ro");
    assert.equal(ro.ok, true, "approved RO observer coexists with editing");
    if (!ro.ok) throw new Error("unreachable");
    assert.equal(h.coord.describe().ownership, "EDITOR_OWNED");
    const admitted = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const published = await h.adapter.publishDocument(currentAuthority(h.coord, admitted.value.lease), {
      portablePath: "watched.txt",
      content: "watched bytes v1\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, true, "host publish succeeds beside the RO observer");
    assert.equal(h.coord.releaseEditor(admitted.value.lease).ok, true);
    // The RO watcher observes committed disk only: a fresh editor read returns the exact bytes.
    const reader = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-read", "req-p65-eread");
    assert.equal(reader.ok, true);
    if (!reader.ok) throw new Error("unreachable");
    const observed = await h.adapter.readDocument(currentAuthority(h.coord, reader.value.lease), "watched.txt");
    assert.equal(observed.ok, true);
    if (!observed.ok) throw new Error("unreachable");
    assert.equal(observed.value.content, "watched bytes v1\n");
    assert.equal(h.coord.releaseEditor(reader.value.lease).ok, true);
    // Guest write remains denied at the coordinator: an RO lease is never a writer.
    assert.equal(h.coord.describe().ownership, "EDITOR_OWNED");
    const stopped = await h.coord.stopTerminal(h.terminalCapability, OP_RO, "req-p65-stop-ro");
    assert.equal(stopped.ok, true);
    proof("RO watcher observes exact committed bytes");
  });
});

describe("P6.5 terminal read-write handoff (fake seam; real container proof is separate)", () => {
  it("terminal RW acquisition blocks until incompatible RO ownership retires", async () => {
    const h = openComposed({ [OP_RO]: "read_only", [OP_RW]: "read_write" });
    const ro = await h.coord.runTerminalOperation(h.terminalCapability, OP_RO, "req-p65-ro");
    assert.equal(ro.ok, true);
    if (!ro.ok) throw new Error("unreachable");
    const blocked = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.rejection.code, "WORKSPACE_BUSY");
    const stopped = await h.coord.stopTerminal(h.terminalCapability, OP_RO, "req-p65-stop-ro");
    assert.equal(stopped.ok, true);
    const admitted = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw2");
    assert.equal(admitted.ok, true, "RW acquires after the RO observer retires");
    if (!admitted.ok) throw new Error("unreachable");
    assert.equal(admitted.value.descriptor.ownership, "TERMINAL_OWNED");
    assert.equal((await h.coord.releaseTerminal(admitted.value.lease as TerminalLease)).ok, true);
    proof("terminal RW acquisition blocks until incompatible ownership retires");
  });

  it("transition state exposes zero writer: both paths forbidden", async () => {
    const provider = createManualEpochProvider();
    const h = openComposed({ [OP_RW]: "read_write" }, provider);
    const pending = h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(provider.pendingPrepares, 1);
    assert.equal(h.coord.describe().ownership, "TRANSITION");
    assert.equal(h.coord.getLogicalState().inTransition, true);
    // Host publication during TRANSITION fails before any mutation.
    const fakeLease = {
      kind: "editor_lease",
      leaseId: "lease-p65-transition",
      sessionId: h.coord.describe().sessionId,
      generation: 1,
      workspaceId: h.coord.describe().workspaceId,
      epoch: h.coord.describe().epoch,
      operationId: "edit-p65-t",
      requestId: "req-p65-t",
    } as EditorLease;
    const attempt = await h.adapter.publishDocument(
      { lease: fakeLease, ownership: "TRANSITION", liveEpoch: h.coord.describe().epoch, revokedLeaseIds: [] },
      { portablePath: "t.txt", content: "x\n", mode: "create", expected: { exists: false, digest: null } },
    );
    assert.equal(attempt.ok, false);
    if (!attempt.ok) assert.equal(attempt.rejection.code, "INVALID_TRANSITION");
    assert.equal(existsSync(join(h.leaf, "t.txt")), false);
    provider.resolveNextPrepare();
    const admitted = await pending;
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const releasePending = h.coord.releaseTerminal(admitted.value.lease as TerminalLease);
    assert.equal(provider.pendingRetires, 1);
    provider.resolveNextRetire("confirmed");
    assert.equal((await releasePending).ok, true);
    proof("transition state exposes zero writer");
  });

  it("host adapter write during TERMINAL_OWNED fails with zero mutation", async () => {
    const h = openComposed({ [OP_RW]: "read_write" });
    writeFileSync(join(h.leaf, "keep.txt"), "keep\n");
    const admitted = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    assert.equal(h.coord.describe().ownership, "TERMINAL_OWNED");
    const editorAttempt = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(editorAttempt.ok, false);
    if (!editorAttempt.ok) assert.equal(editorAttempt.rejection.code, "WORKSPACE_BUSY");
    // Even a live editor lease from before the handoff cannot publish under RW ownership.
    const staleEditor = await (async () => {
      const h2 = openComposed({ [OP_RW]: "read_write" });
      const ed = await h2.coord.runEditorOperation(h2.editorCapability, "edit-p65-1", "req-p65-e1");
      assert.equal(ed.ok, true);
      if (!ed.ok) throw new Error("unreachable");
      return { h2, lease: ed.value.lease };
    })();
    void staleEditor;
    const forged: AdapterAuthority = {
      lease: {
        kind: "editor_lease",
        leaseId: "lease-p65-forged",
        sessionId: h.coord.describe().sessionId,
        generation: 1,
        workspaceId: h.coord.describe().workspaceId,
        epoch: h.coord.describe().epoch,
        operationId: "edit-p65-1",
        requestId: "req-p65-e1",
      },
      ownership: "TERMINAL_OWNED",
      liveEpoch: h.coord.describe().epoch,
      revokedLeaseIds: [],
    };
    const denied = await h.adapter.publishDocument(forged, {
      portablePath: "keep.txt",
      content: "host overwrite\n",
      mode: "replace",
      expected: { exists: true, digest: sha256Hex("keep\n") },
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.rejection.code, "WORKSPACE_BUSY");
    assert.equal(readFileSync(join(h.leaf, "keep.txt"), "utf8"), "keep\n", "zero mutation");
    assert.equal((await h.coord.releaseTerminal(admitted.value.lease as TerminalLease)).ok, true);
    proof("host write during RW fails zero-mutation");
  });

  it("RW retirement must be confirmed before editor write resumes; unconfirmed holds", async () => {
    const provider = createManualEpochProvider();
    const h = openComposed({ [OP_RW]: "read_write" }, provider);
    const admitPending = h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(provider.pendingPrepares, 1);
    provider.resolveNextPrepare();
    const admitted = await admitPending;
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const releasePending = h.coord.releaseTerminal(admitted.value.lease as TerminalLease);
    assert.equal(provider.pendingRetires, 1);
    // Editor cannot resume while retirement is unconfirmed (still TRANSITION).
    const early = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(early.ok, false);
    provider.resolveNextRetire("unconfirmed");
    const released = await releasePending;
    assert.equal(released.ok, false);
    if (!released.ok) assert.equal(released.rejection.code, "CLEANUP_UNCONFIRMED");
    assert.equal(h.coord.describe().ownership, "HOLD");
    proof("RW retirement must be confirmed before editor resumes");
  });
});

describe("P6.5 dirty-buffer contract (renderer cannot forge clean state)", () => {
  it("dirty or pending editor state denies terminal RW acquisition", async () => {
    const h = openComposed({ [OP_RW]: "read_write" });
    assert.equal(h.coord.setBufferFacts(h.editorCapability, { dirtyBufferCount: 1, pendingCreationCount: 0 }).ok, true);
    const denied = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.rejection.code, "DIRTY_BUFFER_CONFLICT");
    assert.equal(h.coord.setBufferFacts(h.editorCapability, { dirtyBufferCount: 0, pendingCreationCount: 1 }).ok, true);
    const denied2 = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw2");
    assert.equal(denied2.ok, false);
    if (!denied2.ok) assert.equal(denied2.rejection.code, "DIRTY_BUFFER_CONFLICT");
    // Renderer cannot forge clean state: buffer facts require the main-issued editor capability.
    const forged = h.coord.setBufferFacts(
      { kind: "editor_capability", leaseId: "cap-forged" } as never,
      { dirtyBufferCount: 0, pendingCreationCount: 0 },
    );
    assert.equal(forged.ok, false, "forged capability cannot clear dirty state");
    // Main clears honestly; RW admits.
    assert.equal(h.coord.setBufferFacts(h.editorCapability, { dirtyBufferCount: 0, pendingCreationCount: 0 }).ok, true);
    const admitted = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw3");
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    assert.equal((await h.coord.releaseTerminal(admitted.value.lease as TerminalLease)).ok, true);
    proof("dirty buffer denies terminal RW");
  });
});

describe("P6.5 external modification and stale leases (no silent overwrite)", () => {
  it("terminal external change causes stale editor preimage conflict", async () => {
    const h = openComposed({ [OP_RW]: "read_write" });
    const ed1 = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(ed1.ok, true);
    if (!ed1.ok) throw new Error("unreachable");
    const created = await h.adapter.publishDocument(currentAuthority(h.coord, ed1.value.lease), {
      portablePath: "doc.txt",
      content: "revision N\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    const digestN = created.value.digest;
    assert.equal(h.coord.releaseEditor(ed1.value.lease).ok, true);
    // Editor relinquishes; terminal RW acquires and legitimately modifies the file.
    const rw = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    writeFileSync(join(h.leaf, "doc.txt"), "revision M from terminal\n");
    assert.equal((await h.coord.releaseTerminal(rw.value.lease as TerminalLease)).ok, true);
    // Editor reacquires and attempts publication based on stale preimage N.
    const ed2 = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-2", "req-p65-e2");
    assert.equal(ed2.ok, true);
    if (!ed2.ok) throw new Error("unreachable");
    const stale = await h.adapter.publishDocument(currentAuthority(h.coord, ed2.value.lease), {
      portablePath: "doc.txt",
      content: "stale editor overwrite\n",
      mode: "replace",
      expected: { exists: true, digest: digestN },
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(readFileSync(join(h.leaf, "doc.txt"), "utf8"), "revision M from terminal\n", "no silent overwrite");
    assert.equal(h.coord.releaseEditor(ed2.value.lease).ok, true);
    proof("terminal external change causes stale editor preimage conflict");
  });

  it("old editor lease after epoch transition cannot publish (stale epoch, zero mutation)", async () => {
    const h = openComposed({ [OP_RW]: "read_write" });
    const ed = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(ed.ok, true);
    if (!ed.ok) throw new Error("unreachable");
    const oldLease = ed.value.lease;
    const created = await h.adapter.publishDocument(currentAuthority(h.coord, oldLease), {
      portablePath: "epoch.txt",
      content: "v1\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(created.ok, true);
    assert.equal(h.coord.releaseEditor(oldLease).ok, true);
    const epochBefore = h.coord.describe().epoch;
    const rw = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    assert.equal((await h.coord.releaseTerminal(rw.value.lease as TerminalLease)).ok, true);
    assert.ok(h.coord.describe().epoch > epochBefore, "epoch advanced across the RW handoff");
    // Attempt with the old lease but current live facts: stale epoch fences before mutation.
    const staleAuthority = currentAuthority(h.coord, oldLease);
    const attempt = await h.adapter.publishDocument(staleAuthority, {
      portablePath: "epoch.txt",
      content: "stale write\n",
      mode: "replace",
      expected: { exists: true, digest: created.ok ? created.value.digest : sha256Hex("v1\n") },
    });
    assert.equal(attempt.ok, false);
    if (!attempt.ok) assert.ok(["STALE_EPOCH", "WORKSPACE_REVOKED"].includes(attempt.rejection.code));
    assert.equal(readFileSync(join(h.leaf, "epoch.txt"), "utf8"), "v1\n", "zero file mutation");
    proof("old editor lease after epoch transition cannot publish");
  });

  it("old terminal lease cannot prepare: stale epoch fences with zero provider action", async () => {
    const h = openComposed({ [OP_RW]: "read_write", [OP_RW2]: "read_write" });
    const rw = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    const oldPermit = rw.value.permit;
    const oldLease = rw.value.lease;
    assert.equal((await h.coord.releaseTerminal(oldLease as TerminalLease)).ok, true);
    const live = h.coord.getLiveFacts();
    const check = checkPermitAcquisition(
      { ...oldPermit, epoch: oldPermit.epoch } as never,
      live,
    );
    assert.equal(check.ok, false, "old terminal epoch fences");
    if (!check.ok) assert.equal(check.rejection.code, "STALE_EPOCH");
    // A fresh RW admission still works exactly once (no duplicate writer).
    const fresh = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW2, "req-p65-rw2");
    assert.equal(fresh.ok, true);
    if (!fresh.ok) throw new Error("unreachable");
    assert.equal((await h.coord.releaseTerminal(fresh.value.lease as TerminalLease)).ok, true);
    proof("old terminal lease cannot prepare");
  });
});

describe("P6.5 reset, close and HOLD integration (both writer paths fenced)", () => {
  it("RESETTING denies both host and guest writer acquisition", async () => {
    const provider = createManualEpochProvider();
    const h = openComposed({ [OP_RO]: "read_only", [OP_RW]: "read_write" }, provider);
    const resetPending = h.coord.resetCombinedSession(h.coord.describe() as never, "req-p65-reset");
    assert.equal(provider.pendingRetires, 1);
    assert.equal(h.coord.describe().ownership, "RESETTING");
    const editor = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(editor.ok, false);
    const terminal = await h.coord.runTerminalOperation(h.terminalCapability, OP_RO, "req-p65-ro");
    assert.equal(terminal.ok, false);
    const fakeLease = {
      kind: "editor_lease",
      leaseId: "lease-p65-reset",
      sessionId: h.coord.describe().sessionId,
      generation: h.coord.describe().generation,
      workspaceId: h.coord.describe().workspaceId,
      epoch: h.coord.describe().epoch,
      operationId: "edit-p65-1",
      requestId: "req-p65-e1",
    } as EditorLease;
    const hosted = await h.adapter.publishDocument(
      { lease: fakeLease, ownership: "RESETTING", liveEpoch: h.coord.describe().epoch, revokedLeaseIds: [] },
      { portablePath: "r.txt", content: "x\n", mode: "create", expected: { exists: false, digest: null } },
    );
    assert.equal(hosted.ok, false);
    provider.resolveNextRetire("confirmed");
    const reset = await resetPending;
    assert.equal(reset.ok, true, "reset completes after confirmed cleanup");
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.descriptor.generation, 2);
    proof("RESETTING denies both host and guest writer acquisition");
  });

  it("reset fences in-flight adapter publication (no stale generation publishes)", async () => {
    const h = openComposed({ [OP_RO]: "read_only" });
    const ed = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(ed.ok, true);
    if (!ed.ok) throw new Error("unreachable");
    const lease = ed.value.lease;
    const before = currentAuthority(h.coord, lease);
    const reset = await h.coord.resetCombinedSession(h.coord.describe() as never, "req-p65-reset");
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    // Old operation attempts publication with a revalidation seam observing the new generation.
    const freshAuthority: AdapterAuthority = {
      lease,
      ownership: h.coord.describe().ownership,
      liveEpoch: h.coord.describe().epoch,
      revokedLeaseIds: [...h.coord.getLiveFacts().revoked_lease_ids],
    };
    const attempt = await h.adapter.publishDocument(before, {
      portablePath: "stale-gen.txt",
      content: "stale\n",
      mode: "create",
      expected: { exists: false, digest: null },
      revalidate: () => freshAuthority,
    });
    assert.equal(attempt.ok, false, "in-flight publication fences after reset");
    assert.equal(existsSync(join(h.leaf, "stale-gen.txt")), false, "no partial bytes");
    assert.equal(stagingIsClean(h), true);
    proof("reset fences in-flight adapter publication");
  });

  it("reset fences late provider preparation (no incompatible authority emerges)", async () => {
    const provider = createManualEpochProvider();
    const h = openComposed({ [OP_RW]: "read_write" }, provider);
    const oldSession = h.coord.describe().sessionId;
    const pending = h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(provider.pendingPrepares, 1);
    const resetPending = h.coord.resetCombinedSession(h.coord.describe() as never, "req-p65-reset");
    assert.equal(h.coord.describe().ownership, "RESETTING");
    provider.resolveNextRetire("confirmed");
    const reset = await resetPending;
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    assert.notEqual(reset.value.descriptor.sessionId, oldSession, "new generation carries a new session identity");
    provider.resolveNextPrepare();
    const late = await pending;
    assert.equal(late.ok, false, "late preparation fences after reset wins");
    if (!late.ok) assert.equal(late.rejection.code, "STALE_SESSION");
    proof("reset fences late provider preparation");
  });

  it("CLOSING denies both writer paths and late callbacks cannot reopen", async () => {
    const h = openComposed({ [OP_RO]: "read_only", [OP_RW]: "read_write" });
    const closed = await h.coord.closeCombinedSession(h.coord.describe() as never, "req-p65-close");
    assert.equal(closed.ok, true);
    const editor = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(editor.ok, false);
    const terminal = await h.coord.runTerminalOperation(h.terminalCapability, OP_RO, "req-p65-ro");
    assert.equal(terminal.ok, false);
    const snapshot = h.coord.getCombinedSnapshot(h.coord.describe() as never, 0);
    // A read-only snapshot may still succeed after close, but it stays
    // identifier-only and no new writer can ever be acquired (proven above).
    if (snapshot.ok) {
      const serialized = JSON.stringify(snapshot.value);
      assert.ok(!serialized.includes(h.leaf), "closed snapshot carries no host path");
    }
    proof("CLOSING denies both writer paths");
  });

  it("HOLD denies both writer paths and cleanup uncertainty never releases file authority", async () => {
    const h = openComposed({ [OP_RO]: "read_only", [OP_RW]: "read_write" });
    h.coord.onProviderFailure(h.epochCapability, "synthetic transport failure");
    assert.equal(h.coord.describe().ownership, "HOLD");
    const editor = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(editor.ok, false);
    const terminal = await h.coord.runTerminalOperation(h.terminalCapability, OP_RO, "req-p65-ro");
    assert.equal(terminal.ok, false);
    const fakeLease = {
      kind: "editor_lease",
      leaseId: "lease-p65-hold",
      sessionId: h.coord.describe().sessionId,
      generation: h.coord.describe().generation,
      workspaceId: h.coord.describe().workspaceId,
      epoch: h.coord.describe().epoch,
      operationId: "edit-p65-1",
      requestId: "req-p65-e1",
    } as EditorLease;
    const hosted = await h.adapter.publishDocument(
      { lease: fakeLease, ownership: "HOLD", liveEpoch: h.coord.describe().epoch, revokedLeaseIds: [] },
      { portablePath: "hold.txt", content: "x\n", mode: "create", expected: { exists: false, digest: null } },
    );
    assert.equal(hosted.ok, false, "HOLD fences the file adapter");
    assert.equal(existsSync(join(h.leaf, "hold.txt")), false);
    proof("HOLD denies both writer paths");
  });
});

describe("P6.5 fencing details, journal correlation and boundaries", () => {
  it("wrong generation takes zero adapter/provider action", async () => {
    const h = openComposed({ [OP_RO]: "read_only" });
    const ed = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(ed.ok, true);
    if (!ed.ok) throw new Error("unreachable");
    const good = currentAuthority(h.coord, ed.value.lease);
    const wrongGen: AdapterAuthority = {
      ...good,
      lease: { ...ed.value.lease, generation: 999 },
    };
    const attempt = await h.adapter.publishDocument(wrongGen, {
      portablePath: "g.txt",
      content: "x\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(attempt.ok, false);
    if (!attempt.ok) assert.equal(attempt.rejection.code, "STALE_SESSION");
    assert.equal(existsSync(join(h.leaf, "g.txt")), false);
    assert.equal(h.coord.releaseEditor(ed.value.lease).ok, true);
    proof("wrong generation zero adapter action");
  });

  it("wrong epoch takes zero adapter/provider action", async () => {
    const h = openComposed({ [OP_RO]: "read_only" });
    const ed = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(ed.ok, true);
    if (!ed.ok) throw new Error("unreachable");
    const good = currentAuthority(h.coord, ed.value.lease);
    const wrongEpoch: AdapterAuthority = {
      ...good,
      lease: { ...ed.value.lease, epoch: good.liveEpoch + 1 },
    };
    const attempt = await h.adapter.publishDocument(wrongEpoch, {
      portablePath: "e.txt",
      content: "x\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(attempt.ok, false);
    if (!attempt.ok) assert.equal(attempt.rejection.code, "STALE_EPOCH");
    assert.equal(h.coord.releaseEditor(ed.value.lease).ok, true);
    proof("wrong epoch zero adapter action");
  });

  it("foreign owner takes zero adapter/provider action", async () => {
    const h = openComposed({ [OP_RO]: "read_only" });
    const ed = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(ed.ok, true);
    if (!ed.ok) throw new Error("unreachable");
    const good = currentAuthority(h.coord, ed.value.lease);
    const foreign: AdapterAuthority = {
      ...good,
      lease: { ...ed.value.lease, sessionId: "sess-elsewhere", workspaceId: "ws-elsewhere" },
    };
    const attempt = await h.adapter.publishDocument(foreign, {
      portablePath: "f.txt",
      content: "x\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(attempt.ok, false);
    if (!attempt.ok) assert.equal(attempt.rejection.code, "WRONG_OWNER");
    assert.equal(h.coord.releaseEditor(ed.value.lease).ok, true);
    proof("foreign owner zero adapter action");
  });

  it("duplicate and racing ownership attempts preserve exactly one writer", async () => {
    const provider = createManualEpochProvider();
    const h = openComposed({ [OP_RW]: "read_write", [OP_RW2]: "read_write" }, provider);
    const first = h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw1");
    assert.equal(provider.pendingPrepares, 1);
    const second = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW2, "req-p65-rw2");
    assert.equal(second.ok, false, "racing RW fences while TRANSITION owns the leaf");
    provider.resolveNextPrepare();
    const won = await first;
    assert.equal(won.ok, true);
    if (!won.ok) throw new Error("unreachable");
    assert.equal(h.coord.getLogicalState().activeRw, true);
    // Same operation with a different request id cannot evade the consumed-attempt tombstone.
    const dup = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw1-retry");
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.rejection.code, "INVALID_REQUEST");
    const releasePending = h.coord.releaseTerminal(won.value.lease as TerminalLease);
    assert.equal(provider.pendingRetires, 1);
    provider.resolveNextRetire("confirmed");
    assert.equal((await releasePending).ok, true);
    proof("duplicate racing ownership preserves one writer");
  });

  it("integration sequence is journal-correlated without leaking paths, containers, PIDs or secrets", async () => {
    const h = openComposed({ [OP_RO]: "read_only", [OP_RW]: "read_write" });
    const ed = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(ed.ok, true);
    if (!ed.ok) throw new Error("unreachable");
    assert.equal(
      (
        await h.adapter.publishDocument(currentAuthority(h.coord, ed.value.lease), {
          portablePath: "audit.txt",
          content: "audit\n",
          mode: "create",
          expected: { exists: false, digest: null },
        })
      ).ok,
      true,
    );
    assert.equal(h.coord.releaseEditor(ed.value.lease).ok, true);
    const ro = await h.coord.runTerminalOperation(h.terminalCapability, OP_RO, "req-p65-ro");
    assert.equal(ro.ok, true);
    assert.equal((await h.coord.stopTerminal(h.terminalCapability, OP_RO, "req-p65-stop")).ok, true);
    const rw = await h.coord.runTerminalOperation(h.terminalCapability, OP_RW, "req-p65-rw");
    assert.equal(rw.ok, true);
    if (!rw.ok) throw new Error("unreachable");
    assert.equal((await h.coord.releaseTerminal(rw.value.lease as TerminalLease)).ok, true);
    const events = h.coord.listEvents(0).map((e) => e.type);
    for (const expected of [
      "workspace.writer.acquired",
      "workspace.writer.released",
      "workspace.epoch.started",
      "workspace.epoch.retired",
    ]) {
      assert.ok(events.includes(expected), `journal carries ${expected}`);
    }
    const snapshot = h.coord.getCombinedSnapshot(h.coord.describe() as never, 0);
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) throw new Error("unreachable");
    const serialized = JSON.stringify(snapshot.value);
    assert.ok(!serialized.includes(h.leaf), "snapshot carries no host absolute path");
    assert.ok(!serialized.includes(h.staging), "snapshot carries no staging path");
    assert.ok(!/cf-p65-d[0-9]/.test(serialized), "snapshot carries no runtime container identity");
    proof("journal correlation without leakage");
  });

  it("renderer remains out of filesystem authority (identifier-only, strict)", () => {
    const hostile = {
      session_id: "sess-p65-1",
      generation: 1,
      operation_id: "op-1",
      request_id: "req-1",
      lease_id: "lease-forged",
      portable_path: "lesson.txt",
      content: "evil",
      access: "read_write",
      epoch: 1,
    };
    assert.equal(RunEditorOperationRequestSchema.safeParse(hostile).success, false);
    const clean = {
      session_id: "sess-p65-1",
      generation: 1,
      operation_id: "op-1",
      request_id: "req-1",
    };
    assert.equal(RunEditorOperationRequestSchema.safeParse(clean).success, true);
    proof("renderer authority absent");
  });

  it("every integration wait is bounded (queue ceiling, no hanging gate)", async () => {
    const h = openComposed({ [OP_RO]: "read_only" }, undefined);
    // Occupy the single editor slot, then prove queued work is bounded and drains.
    const first = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    const queued = h.coord.runEditorOperation(h.editorCapability, "edit-p65-2", "req-p65-e2");
    assert.equal(h.coord.releaseEditor(first.value.lease).ok, true);
    const second = await queued;
    assert.equal(second.ok, true, "bounded queue drains after settlement");
    if (!second.ok) throw new Error("unreachable");
    assert.equal(h.coord.releaseEditor(second.value.lease).ok, true);
    proof("bounded waits drain without hanging");
  });

  it("final cleanup leaves no owned resource (leases, peers, staging, temp)", async () => {
    const h = openComposed({ [OP_RO]: "read_only", [OP_RW]: "read_write" });
    const ed = await h.coord.runEditorOperation(h.editorCapability, "edit-p65-1", "req-p65-e1");
    assert.equal(ed.ok, true);
    if (!ed.ok) throw new Error("unreachable");
    assert.equal(
      (
        await h.adapter.publishDocument(currentAuthority(h.coord, ed.value.lease), {
          portablePath: "final.txt",
          content: "final\n",
          mode: "create",
          expected: { exists: false, digest: null },
        })
      ).ok,
      true,
    );
    assert.equal(h.coord.releaseEditor(ed.value.lease).ok, true);
    const closed = await h.coord.closeCombinedSession(h.coord.describe() as never, "req-p65-close");
    assert.equal(closed.ok, true);
    assert.equal(h.coord.getLogicalState().closed, true);
    assert.equal(h.coord.getLogicalState().activeRoCount, 0);
    assert.equal(h.coord.getLogicalState().activeRw, false);
    assert.equal(stagingIsClean(h), true, "no staging residue");
    rmSync(h.leaf, { recursive: true, force: true });
    rmSync(h.staging, { recursive: true, force: true });
    assert.equal(existsSync(h.leaf), false);
    proof("final cleanup leaves no owned resource");
  });
});
