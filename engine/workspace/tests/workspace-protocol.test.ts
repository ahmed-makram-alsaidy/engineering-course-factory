// P6.1 shared workspace protocol tests — ownership, epochs, permits,
// renderer boundary, reset ordering, buffer/disk revisions, error model.
//
// Proves the frozen P6.0 model structurally: exclusive writers, reviewed
// access only, stale fencing, fail-closed transitions, strict schemas,
// portable identities. Pure, offline, deterministic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AcknowledgePresentationRequestSchema,
  BufferDescriptorSchema,
  CancelEditorOperationRequestSchema,
  checkPermitAcquisition,
  checkTerminalRWPreconditions,
  ContainerEpochSchema,
  FileDiskRecordSchema,
  GetEditorSnapshotRequestSchema,
  isDirtyBuffer,
  isLegalOwnershipTransition,
  isStaleEpoch,
  isStaleGeneration,
  isValidOwnershipAccess,
  isValidResetPrefix,
  isCompleteResetSequence,
  allowsBackgroundObservation,
  allowsEditorWrite,
  allowsTerminalWrite,
  nextEpochNumber,
  ownershipWriter,
  RESET_PHASE_ORDER,
  RunEditorOperationRequestSchema,
  WorkspaceErrorCodeSchema,
  WorkspaceExecutionPermitSchema,
  WorkspaceIdentitySchema,
  WorkspaceOwnershipSchema,
  WorkspaceSnapshotSchema,
  WORKSPACE_ERROR_CATEGORY,
  WORKSPACE_PROTOCOL_VERSION,
  type LiveWorkspaceFacts,
  type ResetPhase,
  type WorkspaceExecutionPermit,
} from "../src/protocol.ts";
import { sha256Hex } from "../src/policy.ts";

const SESSION = "sess-000001";
const WORKSPACE = "ws-000001";
const LEASE = "lease-000001";
const POLICY_DIGEST = sha256Hex("p61-policy");
const FILE_DIGEST = sha256Hex("p61-file-bytes");

function makePermit(overrides: Partial<WorkspaceExecutionPermit> = {}): WorkspaceExecutionPermit {
  return {
    kind: "workspace_execution_permit",
    permit_version: 1,
    session_id: SESSION,
    generation: 1,
    workspace_id: WORKSPACE,
    epoch: 1,
    access: "read_only",
    operation_id: "C01-L001-S001-B001",
    policy_digest: POLICY_DIGEST,
    lease_id: LEASE,
    ...overrides,
  };
}

function makeLive(overrides: Partial<LiveWorkspaceFacts> = {}): LiveWorkspaceFacts {
  return {
    session_id: SESSION,
    generation: 1,
    workspace_id: WORKSPACE,
    epoch: 1,
    policy_digest: POLICY_DIGEST,
    revoked_lease_ids: [],
    ...overrides,
  };
}

describe("P6.1 exclusive writer periods (no dual-writer state exists)", () => {
  it("each ownership state admits exactly one writer or none", () => {
    assert.equal(ownershipWriter("EDITOR_OWNED"), "editor_adapter");
    assert.equal(ownershipWriter("TERMINAL_OWNED"), "terminal_rw");
    for (const state of ["TRANSITION", "RESETTING", "CLOSING", "HOLD"] as const) {
      assert.equal(ownershipWriter(state), "none", state);
    }
  });

  it("editor write and terminal read-write can never coexist in any valid state", () => {
    for (const state of WorkspaceOwnershipSchema.options) {
      assert.equal(
        allowsEditorWrite(state) && allowsTerminalWrite(state),
        false,
        `dual writers in ${state}`,
      );
    }
  });

  it("direct editor/terminal ownership hops are illegal (access changes cross TRANSITION)", () => {
    assert.equal(isLegalOwnershipTransition("EDITOR_OWNED", "TRANSITION"), true);
    assert.equal(isLegalOwnershipTransition("EDITOR_OWNED", "TERMINAL_OWNED"), false);
    assert.equal(isLegalOwnershipTransition("TERMINAL_OWNED", "TRANSITION"), true);
    assert.equal(isLegalOwnershipTransition("TERMINAL_OWNED", "EDITOR_OWNED"), false);
    assert.equal(isLegalOwnershipTransition("TRANSITION", "TERMINAL_OWNED"), true);
    assert.equal(isLegalOwnershipTransition("TRANSITION", "EDITOR_OWNED"), true);
  });

  it("HOLD never returns directly to owned states (recovery uses the reset barrier)", () => {
    assert.equal(isLegalOwnershipTransition("HOLD", "EDITOR_OWNED"), false);
    assert.equal(isLegalOwnershipTransition("HOLD", "TERMINAL_OWNED"), false);
    assert.equal(isLegalOwnershipTransition("HOLD", "TRANSITION"), false);
    assert.equal(isLegalOwnershipTransition("HOLD", "RESETTING"), true);
    assert.equal(isLegalOwnershipTransition("RESETTING", "EDITOR_OWNED"), false);
    assert.equal(isLegalOwnershipTransition("CLOSING", "HOLD"), true);
    assert.equal(isLegalOwnershipTransition("CLOSING", "TERMINAL_OWNED"), false);
  });
});

describe("P6.1 background read-only coexistence and terminal exclusivity", () => {
  it("editor writer plus approved background observation is representable", () => {
    assert.equal(allowsEditorWrite("EDITOR_OWNED"), true);
    assert.equal(allowsBackgroundObservation("EDITOR_OWNED"), true);
    assert.equal(isValidOwnershipAccess("EDITOR_OWNED", "read_only"), true);
    assert.equal(isValidOwnershipAccess("EDITOR_OWNED", null), true);
  });

  it("a read-write bind can never coexist with editor ownership", () => {
    assert.equal(isValidOwnershipAccess("EDITOR_OWNED", "read_write"), false);
    assert.equal(isValidOwnershipAccess("TERMINAL_OWNED", "read_write"), true);
    assert.equal(isValidOwnershipAccess("TERMINAL_OWNED", "read_only"), false);
    assert.equal(isValidOwnershipAccess("TERMINAL_OWNED", null), false);
  });

  it("terminal read-write admission requires a clean exclusive editor-owned state", () => {
    const clean = {
      ownership: "EDITOR_OWNED" as const,
      dirty_buffer_count: 0,
      pending_creation_count: 0,
      active_terminal_peers: 0,
      save_active: false,
    };
    assert.deepEqual(checkTerminalRWPreconditions(clean), { ok: true });
    assert.deepEqual(checkTerminalRWPreconditions({ ...clean, dirty_buffer_count: 1 }), {
      ok: false,
      code: "DIRTY_BUFFER_CONFLICT",
    });
    assert.deepEqual(checkTerminalRWPreconditions({ ...clean, pending_creation_count: 1 }), {
      ok: false,
      code: "DIRTY_BUFFER_CONFLICT",
    });
    assert.deepEqual(checkTerminalRWPreconditions({ ...clean, active_terminal_peers: 1 }), {
      ok: false,
      code: "WORKSPACE_BUSY",
    });
    assert.deepEqual(checkTerminalRWPreconditions({ ...clean, save_active: true }), {
      ok: false,
      code: "WORKSPACE_BUSY",
    });
    assert.deepEqual(checkTerminalRWPreconditions({ ...clean, ownership: "TERMINAL_OWNED" }), {
      ok: false,
      code: "INVALID_TRANSITION",
    });
    assert.deepEqual(checkTerminalRWPreconditions({ ...clean, ownership: "TRANSITION" }), {
      ok: false,
      code: "INVALID_TRANSITION",
    });
  });
});

describe("P6.1 container epochs and generations fence stale work", () => {
  it("epochs are monotonic and stale epochs (old or future) reject", () => {
    assert.equal(nextEpochNumber(1), 2);
    assert.equal(isStaleEpoch(3, 3), false);
    assert.equal(isStaleEpoch(3, 2), true);
    assert.equal(isStaleEpoch(3, 4), true);
    assert.equal(isStaleGeneration(2, 2), false);
    assert.equal(isStaleGeneration(2, 1), true);
  });

  it("epoch DTOs are strict, main-owned and renderer-unselectable", () => {
    const epoch = {
      workspace_protocol_version: WORKSPACE_PROTOCOL_VERSION,
      session_id: SESSION,
      generation: 1,
      epoch: 1,
      access: "read_only",
      lease_id: LEASE,
    } as const;
    assert.equal(ContainerEpochSchema.safeParse(epoch).success, true);
    assert.equal(ContainerEpochSchema.safeParse({ ...epoch, epoch: 0 }).success, false);
    assert.equal(ContainerEpochSchema.safeParse({ ...epoch, unexpected: 1 }).success, false);
    for (const rendererSchema of [
      RunEditorOperationRequestSchema,
      CancelEditorOperationRequestSchema,
      GetEditorSnapshotRequestSchema,
      AcknowledgePresentationRequestSchema,
    ]) {
      assert.equal("epoch" in rendererSchema.shape, false, "renderer must not select an epoch");
      assert.equal("lease_id" in rendererSchema.shape, false, "renderer must not hold a lease");
    }
  });
});

describe("P6.1 permit acquisition fencing (stale, revoked and foreign permits reject)", () => {
  it("a live permit acquires", () => {
    assert.deepEqual(checkPermitAcquisition(makePermit(), makeLive()), { ok: true });
  });

  it("an old session generation rejects STALE_SESSION", () => {
    const result = checkPermitAcquisition(makePermit({ generation: 1 }), makeLive({ generation: 2 }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "STALE_SESSION");
  });

  it("an old container epoch rejects STALE_EPOCH", () => {
    const result = checkPermitAcquisition(makePermit({ epoch: 1 }), makeLive({ epoch: 2 }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "STALE_EPOCH");
  });

  it("a revoked lease cannot acquire (WORKSPACE_REVOKED)", () => {
    const result = checkPermitAcquisition(makePermit(), makeLive({ revoked_lease_ids: [LEASE] }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "WORKSPACE_REVOKED");
  });

  it("a foreign session or workspace rejects WRONG_OWNER", () => {
    const foreignSession = checkPermitAcquisition(makePermit({ session_id: "sess-999999" }), makeLive());
    assert.equal(foreignSession.ok, false);
    if (!foreignSession.ok) assert.equal(foreignSession.rejection.code, "WRONG_OWNER");
    const foreignWorkspace = checkPermitAcquisition(makePermit({ workspace_id: "ws-999999" }), makeLive());
    assert.equal(foreignWorkspace.ok, false);
    if (!foreignWorkspace.ok) assert.equal(foreignWorkspace.rejection.code, "WRONG_OWNER");
  });

  it("policy drift rejects NOT_AUTHORIZED (no silent rebind)", () => {
    const result = checkPermitAcquisition(makePermit(), makeLive({ policy_digest: sha256Hex("other-policy") }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "NOT_AUTHORIZED");
  });

  it("permits are strict and carry no path, content or capability selectors", () => {
    const permit = makePermit();
    assert.deepEqual(Object.keys(WorkspaceExecutionPermitSchema.shape).sort(), [
      "access",
      "epoch",
      "generation",
      "kind",
      "lease_id",
      "operation_id",
      "permit_version",
      "policy_digest",
      "session_id",
      "workspace_id",
    ]);
    assert.equal(WorkspaceExecutionPermitSchema.safeParse({ ...permit, extra: 1 }).success, false);
  });
});

describe("P6.1 renderer must not choose access (strict identifier-only DTOs)", () => {
  const rendererSchemas = {
    runEditorOperation: RunEditorOperationRequestSchema,
    cancelEditorOperation: CancelEditorOperationRequestSchema,
    getEditorSnapshot: GetEditorSnapshotRequestSchema,
    acknowledgePresentation: AcknowledgePresentationRequestSchema,
  } as const;

  const HOSTILE_ACCESS_FIELDS: [string, unknown][] = [
    ["workspaceAccess", "read_write"],
    ["readOnly", false],
    ["readWrite", true],
    ["accessMode", "read_write"],
    ["mountMode", "rw"],
    ["filesystemMode", "read-write"],
    ["writer", "terminal"],
    ["ownership", "TERMINAL_OWNED"],
    ["containerMode", "privileged"],
  ];

  const HOSTILE_CONTENT_FIELDS: [string, unknown][] = [
    ["path", "src/a.ts"],
    ["hostPath", "E:\\course-factory\\x"],
    ["workspaceRoot", "E:\\course-factory"],
    ["content", "const x = 1;"],
    ["code", "rm -rf /workspace"],
    ["command", "npm test"],
    ["env", { PATH: "/evil" }],
    ["policy_digest", POLICY_DIGEST],
    ["epoch", 1],
    ["lease_id", LEASE],
  ];

  function baseFor(name: keyof typeof rendererSchemas): Record<string, unknown> {
    const base = { session_id: SESSION, generation: 1, request_id: "req-000001" };
    if (name === "getEditorSnapshot") return { session_id: SESSION, generation: 1, after_seq: 0 };
    if (name === "acknowledgePresentation") {
      return { session_id: SESSION, generation: 1, operation_id: "C01-L001-S001-B001", plan_id: "plan-1", chunk_seq: 0 };
    }
    return { ...base, operation_id: "C01-L001-S001-B001" };
  }

  it("renderer request shapes are exactly the identifier-only fields", () => {
    assert.deepEqual(Object.keys(RunEditorOperationRequestSchema.shape).sort(), [
      "generation",
      "operation_id",
      "request_id",
      "session_id",
    ]);
    assert.deepEqual(Object.keys(CancelEditorOperationRequestSchema.shape).sort(), [
      "generation",
      "operation_id",
      "request_id",
      "session_id",
    ]);
    assert.deepEqual(Object.keys(GetEditorSnapshotRequestSchema.shape).sort(), ["after_seq", "generation", "session_id"]);
    assert.deepEqual(Object.keys(AcknowledgePresentationRequestSchema.shape).sort(), [
      "chunk_seq",
      "generation",
      "operation_id",
      "plan_id",
      "session_id",
    ]);
  });

  it("hostile access-mode fields reject on every renderer request", () => {
    for (const [name, schema] of Object.entries(rendererSchemas)) {
      for (const [field, value] of HOSTILE_ACCESS_FIELDS) {
        const parsed = schema.safeParse({ ...baseFor(name as keyof typeof rendererSchemas), [field]: value });
        assert.equal(parsed.success, false, `${name} must reject '${field}'`);
      }
    }
  });

  it("renderer cannot submit host paths, file content or policy/epoch authority", () => {
    for (const [name, schema] of Object.entries(rendererSchemas)) {
      for (const [field, value] of HOSTILE_CONTENT_FIELDS) {
        const parsed = schema.safeParse({ ...baseFor(name as keyof typeof rendererSchemas), [field]: value });
        assert.equal(parsed.success, false, `${name} must reject '${field}'`);
      }
    }
  });
});

describe("P6.1 reset and close barrier ordering is representable", () => {
  const full = [...RESET_PHASE_ORDER] as ResetPhase[];

  it("exact prefixes validate and only the full barrier completes", () => {
    assert.equal(isValidResetPrefix([]), true);
    assert.equal(isValidResetPrefix(full.slice(0, 3)), true);
    assert.equal(isValidResetPrefix(full), true);
    assert.equal(isCompleteResetSequence(full), true);
    assert.equal(isCompleteResetSequence(full.slice(0, 5)), false);
  });

  it("skipped, reordered or repeated phases reject", () => {
    assert.equal(isValidResetPrefix(["REVOKE", "STOP_REMOVE_CONTAINER"] as ResetPhase[]), false);
    assert.equal(isValidResetPrefix(["STOP_REMOVE_CONTAINER", "REVOKE"] as ResetPhase[]), false);
    assert.equal(isValidResetPrefix(["REVOKE", "REVOKE"] as ResetPhase[]), false);
    assert.equal(isValidResetPrefix(["EXPOSE_NEW_GENERATION"] as ResetPhase[]), false);
  });

  it("the frozen order matches the canonical barrier", () => {
    assert.deepEqual([...RESET_PHASE_ORDER], [
      "REVOKE",
      "SETTLE_SAVE_CANCEL",
      "STOP_REMOVE_CONTAINER",
      "CONFIRM_CLEANUP",
      "DISCARD_RESEED",
      "EXPOSE_NEW_GENERATION",
    ]);
  });
});

describe("P6.1 disk revisions, buffer state and portable identity", () => {
  it("present and absent disk records validate; inconsistent mixes reject", () => {
    const present = {
      portable_path: "src/a.ts",
      disk_revision: 2,
      exists: true,
      digest: FILE_DIGEST,
      byte_length: 12,
      file_identity: "file-000001",
      observed_workspace_revision: 4,
    };
    assert.equal(FileDiskRecordSchema.safeParse(present).success, true);
    const absent = {
      portable_path: "src/new.ts",
      disk_revision: 0,
      exists: false,
      digest: null,
      byte_length: 0,
      file_identity: null,
      observed_workspace_revision: 4,
    };
    assert.equal(FileDiskRecordSchema.safeParse(absent).success, true);
    assert.equal(FileDiskRecordSchema.safeParse({ ...absent, digest: FILE_DIGEST }).success, false);
    assert.equal(FileDiskRecordSchema.safeParse({ ...present, digest: null }).success, false);
  });

  it("dirty means the working document differs from disk or is pending creation", () => {
    const dirty = BufferDescriptorSchema.parse({
      portable_path: "src/a.ts",
      base_disk_revision: 2,
      base_digest: FILE_DIGEST,
      base_exists: true,
      buffer_revision: 3,
      dirty: true,
      generation: 1,
    });
    const clean = BufferDescriptorSchema.parse({ ...dirty, buffer_revision: 2, dirty: false });
    assert.equal(isDirtyBuffer(dirty), true);
    assert.equal(isDirtyBuffer(clean), false);
  });

  it("portable paths reject host, traversal and device shapes", () => {
    for (const hostile of [
      "E:\\course-factory\\x",
      "C:/temp/a.ts",
      "/absolute/a.ts",
      "../escape.ts",
      "a\\b.ts",
      "src/../x.ts",
      "CON",
      "src/AUX.ts",
      "trailingdot./a.ts",
      "nul.txt",
      "a:b.ts",
      "",
    ]) {
      const record = {
        portable_path: hostile,
        disk_revision: 0,
        exists: false,
        digest: null,
        byte_length: 0,
        file_identity: null,
        observed_workspace_revision: 0,
      };
      assert.equal(FileDiskRecordSchema.safeParse(record).success, false, `'${hostile}' must reject`);
    }
    assert.equal(
      FileDiskRecordSchema.safeParse({
        portable_path: "src/a.ts",
        disk_revision: 0,
        exists: false,
        digest: null,
        byte_length: 0,
        file_identity: null,
        observed_workspace_revision: 0,
      }).success,
      true,
    );
  });

  it("workspace identity and snapshots are portable (no host absolute paths)", () => {
    const identity = WorkspaceIdentitySchema.parse({
      workspace_protocol_version: WORKSPACE_PROTOCOL_VERSION,
      course_id: "C01",
      lesson_id: "C01-L001",
      session_id: SESSION,
      generation: 1,
      workspace_id: WORKSPACE,
      workspace_revision: 0,
    });
    const snapshot = WorkspaceSnapshotSchema.parse({
      workspace_protocol_version: WORKSPACE_PROTOCOL_VERSION,
      session_id: SESSION,
      generation: 1,
      workspace_revision: 3,
      ownership: "EDITOR_OWNED",
      epoch: 1,
      epoch_access: "read_only",
      open_documents: [{ portable_path: "src/a.ts", disk_revision: 2, buffer_revision: 2, dirty: false }],
    });
    const serialized = JSON.stringify([identity, snapshot]);
    assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(serialized, /\\\\/);
    assert.doesNotMatch(serialized, /course-factory/);
  });
});

describe("P6.1 workspace/editor error model (new protocol codes, one category each)", () => {
  it("carries the canonical code set including fencing and conflict codes", () => {
    for (const code of [
      "INVALID_REQUEST",
      "NOT_AUTHORIZED",
      "STALE_SESSION",
      "STALE_EPOCH",
      "WRONG_OWNER",
      "UNSUPPORTED_PHASE",
      "RESOURCE_LIMIT",
      "FILE_NOT_FOUND",
      "FILE_EXISTS",
      "INVALID_LOCATION",
      "FIND_NOT_FOUND",
      "OCCURRENCE_MISMATCH",
      "UNSUPPORTED_TEXT_PROFILE",
      "DISK_CONFLICT",
      "WORKSPACE_VIOLATION",
      "WORKSPACE_BUSY",
      "WORKSPACE_REVOKED",
      "DIRTY_BUFFER_CONFLICT",
      "EXTERNAL_MODIFICATION_CONFLICT",
      "INVALID_TRANSITION",
      "SAVE_FAILED",
      "COMMIT_UNCERTAIN",
      "CLEANUP_UNCONFIRMED",
    ] as const) {
      assert.ok(WorkspaceErrorCodeSchema.options.includes(code), code);
      assert.ok(WORKSPACE_ERROR_CATEGORY[code] !== undefined, code);
    }
    assert.equal(WorkspaceErrorCodeSchema.safeParse("EXECUTION_BY_RENDERER").success, false);
  });

  it("spot-checks the frozen categories", () => {
    assert.equal(WORKSPACE_ERROR_CATEGORY["DIRTY_BUFFER_CONFLICT"], "reject");
    assert.equal(WORKSPACE_ERROR_CATEGORY["WORKSPACE_BUSY"], "reject");
    assert.equal(WORKSPACE_ERROR_CATEGORY["STALE_EPOCH"], "reject");
    assert.equal(WORKSPACE_ERROR_CATEGORY["WORKSPACE_REVOKED"], "reject");
    assert.equal(WORKSPACE_ERROR_CATEGORY["EXTERNAL_MODIFICATION_CONFLICT"], "hold");
    assert.equal(WORKSPACE_ERROR_CATEGORY["COMMIT_UNCERTAIN"], "hold");
    assert.equal(WORKSPACE_ERROR_CATEGORY["CLEANUP_UNCONFIRMED"], "hold");
    assert.equal(WORKSPACE_ERROR_CATEGORY["SAVE_FAILED"], "fail");
  });

  it("ownership is exactly the six frozen states", () => {
    assert.deepEqual([...WorkspaceOwnershipSchema.options].sort(), [
      "CLOSING",
      "EDITOR_OWNED",
      "HOLD",
      "RESETTING",
      "TERMINAL_OWNED",
      "TRANSITION",
    ]);
  });
});
