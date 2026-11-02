// P5.2 admission security tests — the renderer can never supply command
// content, the command profile is enforced, admission executes nothing
// (sentinel), nothing is mutated, and grants stay portable.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { ADMISSION_POLICY } from "../src/policy.ts";
import { ExecutionGrantSchema, createAdmissionService } from "../src/admission.ts";
import {
  authorizedSession,
  BACKGROUND_OP,
  boundRun,
  boundStop,
  COMMAND_PROFILE_LESSON,
  compileFixture,
  compileFromData,
  FOREGROUND_OP,
  MIXED_LESSON,
  NUL_COMMAND_OP,
  SENTINEL_OP,
} from "./admission-fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

/** Fields a hostile renderer might inject to regain execution control. */
const HOSTILE_FIELDS: [string, unknown][] = [
  ["command", "rm -rf /workspace"],
  ["cwd", "E:\\course-factory"],
  ["env", { PATH: "/evil" }],
  ["image", "evil:latest"],
  ["mounts", [{ source: "C:\\", target: "/host" }]],
  ["stdin", "piped"],
  ["shell", "powershell"],
  ["args", ["--privileged"]],
  ["container", "attacker-container"],
  ["network", "host"],
  ["user", "root"],
];

describe("P5.2 renderer trust boundary", () => {
  it("request schemas reject every hostile execution field before resolution", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    for (const [field, value] of HOSTILE_FIELDS) {
      const hostile = { ...boundRun(identity, FOREGROUND_OP, "req-h"), [field]: value };
      const result = service.admitRunOperation(identity, hostile as never);
      assert.equal(result.ok, false, `field "${field}" must be rejected`);
      if (!result.ok) {
        assert.equal(result.rejection.code, "INVALID_REQUEST", field);
        assert.match(result.rejection.message, /strict validation/, field);
      }
    }
    for (const [field, value] of HOSTILE_FIELDS) {
      const hostile = { ...boundStop(identity, "dev-server", "req-h"), [field]: value };
      const result = service.admitStopProcess(identity, hostile as never);
      assert.equal(result.ok, false, `stopProcess field "${field}" must be rejected`);
    }
  });

  it("the renderer cannot override the command: grants carry exactly the compiled IR command", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const a = service.admitRunOperation(identity, boundRun(identity, BACKGROUND_OP, "req-a"));
    assert.equal(a.ok, true);
    // identical operation, different request id — the command is byte-identical
    const { service: s2, identity: id2 } = authorizedSession(MIXED_LESSON);
    const b = s2.admitRunOperation(id2, boundRun(id2, BACKGROUND_OP, "req-b"));
    if (a.ok && b.ok && a.value.kind === "execution_grant" && b.value.kind === "execution_grant") {
      assert.equal(a.value.command, b.value.command);
      assert.equal(a.value.command, "node server.js", "exact authored command");
      assert.notEqual(a.value.request_id, b.value.request_id, "only the correlation id differs");
    } else {
      assert.fail("both admissions should have succeeded");
    }
  });

  it("the grant schema structurally excludes renderer-relevant execution policy", () => {
    const keys = Object.keys(ExecutionGrantSchema.shape).sort();
    assert.deepEqual(keys, [
      "attempt_id",
      "beat_id",
      "command",
      "course_id",
      "cwd",
      "expected_exit_code",
      "generation",
      "grant_version",
      "kind",
      "lesson_id",
      "mode",
      "operation_id",
      "operation_type",
      "process_id",
      "request_id",
      "scene_id",
      "session_id",
      "timeout_ms",
    ]);
    for (const banned of ["env", "image", "mounts", "user", "memory", "cpus", "pids", "network", "container", "shell", "stdin", "capabilities"]) {
      assert.equal(banned in ExecutionGrantSchema.shape, false, `grants must not carry "${banned}"`);
    }
  });

  it("environment cannot be injected: admission has no env input anywhere in the grant", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const result = service.admitRunOperation(identity, {
      ...boundRun(identity, FOREGROUND_OP, "req-env"),
      env: { NODE_OPTIONS: "--require pwn.js" },
    } as never);
    assert.equal(result.ok, false);
  });
});

describe("P5.2 command profile", () => {
  it("NUL commands are rejected as runtime policy (UNSUPPORTED_COMMAND_PROFILE)", () => {
    const { service, identity } = authorizedSession(COMMAND_PROFILE_LESSON);
    const result = service.admitRunOperation(identity, boundRun(identity, NUL_COMMAND_OP, "req-nul"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "UNSUPPORTED_COMMAND_PROFILE");
  });

  it("commands above 16 KiB UTF-8 are rejected as runtime policy", () => {
    const oversized = compileFromData({
      schema_version: "1.1",
      course_id: "C01",
      lesson_id: "C01-L055",
      title: "Oversized command fixture (synthetic P5)",
      language: "en",
      subject: "Programming",
      grade_level: "grade-10",
      duration: 60,
      learning_objectives: ["Prove the 16 KiB command profile limit"],
      prerequisites: [],
      keywords: [],
      metadata: { synthetic_fixture: true },
      scenes: [
        {
          scene_id: "C01-L055-S001",
          type: "code_demo",
          title: "Oversized",
          duration: 60,
          visual: { kind: "terminal", description: "x" },
          beats: [
            {
              beat_id: "C01-L055-S001-B001",
              kind: "action",
              action: { type: "terminal_run", command: `echo ${"a".repeat(ADMISSION_POLICY.max_command_bytes + 1)}`, mode: "foreground" },
            },
          ],
        },
      ],
    });
    const service = createAdmissionService();
    const catalog = service.installLesson(oversized);
    assert.equal(catalog.ok, true);
    if (!catalog.ok) return;
    const session = service.openSession(catalog.value, { executionAuthorized: true });
    assert.equal(session.ok, true);
    if (!session.ok) return;
    const result = service.admitRunOperation(session.value.identity, {
      session_id: session.value.identity.session_id,
      operation_id: "C01-L055-S001-B001",
      request_id: "req-big",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "UNSUPPORTED_COMMAND_PROFILE");
  });
});

describe("P5.2 admission is authorization/translation only", () => {
  it("the sentinel command is granted byte-exact but NEVER executed: no sentinel file appears", () => {
    const scratch = mkdtempSync(join(tmpdir(), "p52-sentinel-"));
    try {
      const { service, identity } = authorizedSession(COMMAND_PROFILE_LESSON);
      const result = service.admitRunOperation(identity, boundRun(identity, SENTINEL_OP, "req-sentinel"));
      assert.equal(result.ok, true, "admission must succeed");
      if (!result.ok || result.value.kind !== "execution_grant") return;
      assert.equal(
        result.value.command,
        "echo COURSE_FACTORY_P52_SENTINEL > p52-sentinel.txt",
        "grant carries the exact command that would create the sentinel",
      );
      assert.equal(existsSync(join(scratch, "p52-sentinel.txt")), false, "sentinel absent in scratch cwd");
      assert.equal(existsSync(join(repoRoot, "p52-sentinel.txt")), false, "sentinel absent in repository root");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("admission never mutates the compiled IR, the operation, or the protocol request", () => {
    const ir: CompiledLesson = compileFixture(MIXED_LESSON);
    const snapshot = JSON.stringify(ir);
    deepFreeze(ir);

    const service = createAdmissionService();
    const catalog = service.installLesson(ir);
    assert.equal(catalog.ok, true);
    if (!catalog.ok) return;
    const session = service.openSession(catalog.value, { executionAuthorized: true });
    assert.equal(session.ok, true);
    if (!session.ok) return;
    const identity = session.value.identity;

    const request = deepFreeze(boundRun(identity, FOREGROUND_OP, "req-m1"));
    assert.equal(service.admitRunOperation(identity, request).ok, true);
    const bgRequest = deepFreeze(boundRun(identity, BACKGROUND_OP, "req-m2"));
    assert.equal(service.admitRunOperation(identity, bgRequest).ok, true);
    const stopRequest = deepFreeze(boundStop(identity, "dev-server", "req-m3"));
    assert.equal(service.admitStopProcess(identity, stopRequest).ok, true);
    const cancelRequest = deepFreeze({ session_id: identity.session_id, operation_id: FOREGROUND_OP, request_id: "req-m4" });
    assert.equal(service.admitCancelOperation(identity, cancelRequest).ok, true);
    const resetRequest = deepFreeze({ session_id: identity.session_id, request_id: "req-m5" });
    assert.equal(service.resetRuntime(identity, resetRequest).ok, true);

    assert.equal(JSON.stringify(ir), snapshot, "compiled IR byte-identical after full admission flow");
    assert.equal(JSON.stringify(request), JSON.stringify(boundRun({ session_id: identity.session_id, generation: 1 }, FOREGROUND_OP, "req-m1")), "request untouched");
    for (const entry of catalog.value.operations.values()) {
      assert.equal(Object.isFrozen(entry), true, "catalog entries are frozen");
      assert.equal(Object.isFrozen(entry.operation), true, "catalog operations are frozen");
    }
  });

  it("grants are portable: no machine paths leak into any issued grant or admission DTO", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const issued: unknown[] = [];
    const fg = service.admitRunOperation(identity, boundRun(identity, FOREGROUND_OP, "req-p1"));
    if (fg.ok) issued.push(fg.value);
    const bg = service.admitRunOperation(identity, boundRun(identity, BACKGROUND_OP, "req-p2"));
    if (bg.ok) issued.push(bg.value);
    const stop = service.admitStopProcess(identity, boundStop(identity, "dev-server", "req-p3"));
    if (stop.ok) issued.push(stop.value);
    const cancel = service.admitCancelOperation(identity, { session_id: identity.session_id, operation_id: FOREGROUND_OP, request_id: "req-p4" });
    if (cancel.ok) issued.push(cancel.value);
    assert.ok(issued.length >= 3, "expected several DTOs");
    const dump = JSON.stringify(issued);
    for (const [label, pattern] of [
      ["drive letter", /[A-Za-z]:[\\/]/],
      ["backslash path", /\\\\/],
      ["repository path", /course-factory/i],
      ["unix home", /\/home\/|\/Users\//],
      ["appdata", /AppData/i],
    ] as const) {
      assert.doesNotMatch(dump, pattern, `no ${label} in grants`);
    }
  });

  it("the compiled IR the service consumed equals a fresh compile of the same source (no drift)", () => {
    const { catalog } = authorizedSession(MIXED_LESSON);
    const service = createAdmissionService();
    const again = service.installLesson(compileFixture(MIXED_LESSON));
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.value.lesson_compiled_digest, catalog.lesson_compiled_digest);
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
