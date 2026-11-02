// P5.2 admission tests — catalog cross-checks, grants, lifecycle, stop/cancel/
// reset admission. Security/hostility tests live in admission-security.test.ts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { ADMISSION_POLICY } from "../src/policy.ts";
import { createAdmissionService, createLessonCatalog } from "../src/admission.ts";
import {
  authorizedSession,
  BACKGROUND_OP,
  boundRun,
  boundStop,
  BROWSER_OP,
  COMMAND_PROFILE_LESSON,
  compileFixture,
  compileFromData,
  FOREGROUND_OP,
  inspectionSession,
  MIXED_LESSON,
  OVERSIZED_TIMEOUT_OP,
  SENTINEL_OP,
  SLOT_RELEASE_OP,
  STOP_OP,
  TYPE_CODE_OP,
} from "./admission-fixtures.ts";

describe("P5.2 lesson catalog", () => {
  it("builds from the canonical compile pipeline with a deterministic compiled-byte digest", () => {
    const a = createLessonCatalog(compileFixture(MIXED_LESSON));
    const b = createLessonCatalog(compileFixture(MIXED_LESSON));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    if (a.ok && b.ok) {
      assert.match(a.value.lesson_compiled_digest, /^[0-9a-f]{64}$/);
      assert.equal(a.value.lesson_compiled_digest, b.value.lesson_compiled_digest, "same IR -> same compiled-byte digest");
      assert.equal(a.value.course_id, "C01");
      assert.equal(a.value.lesson_id, "C01-L052");
    }
  });

  it("indexes every compiled operation by its step id (operation_id := step_id)", () => {
    const { catalog } = authorizedSession(MIXED_LESSON);
    assert.deepEqual([...catalog.operations.keys()].sort(), [
      "C01-L052-S001-B002",
      "C01-L052-S001-B003",
      "C01-L052-S001-B004",
      "C01-L052-S002-B001",
      "C01-L052-S003-B001",
      "C01-L052-S003-B002",
    ]);
    assert.deepEqual([...catalog.processes.keys()], ["dev-server"]);
  });

  it("operation ids must be unique lesson-wide: a forged cross-scene id collision cannot resolve deterministically", () => {
    // Source-level beat ids carry their scene prefix, so a collision can only
    // be constructed by forging the compiled IR — exactly what admission must
    // reject (the compiled IR schema itself does not enforce lesson-wide
    // operation-id uniqueness).
    const base = compileFixture(MIXED_LESSON);
    const forged: CompiledLesson = {
      ...base,
      scenes: base.scenes.map((scene) =>
        scene.scene_id !== "C01-L052-S003"
          ? scene
          : {
              ...scene,
              steps: scene.steps.map((step) =>
                step.kind === "operation" && step.operation.parameters.type === "terminal_stop"
                  ? {
                      ...step,
                      step_id: "C01-L052-S002-B001",
                      source_ref: { ...step.source_ref, beat_id: "C01-L052-S002-B001" },
                    }
                  : step,
              ),
            },
      ),
    };
    const result = createLessonCatalog(forged);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.rejection.code, "IR_RUNTIME_INCONSISTENT");
      assert.match(result.rejection.message, /not unique/);
    }
  });

  it("rejects forged IR (inventory/reference inconsistencies) with IR_RUNTIME_INCONSISTENT and no repair", () => {
    const base = compileFixture(MIXED_LESSON);
    const forgeries: [string, CompiledLesson][] = [
      ["missing inventory entry", { ...base, processes: base.processes.slice(1) }],
      [
        "inventory command disagreement",
        { ...base, processes: base.processes.map((p) => (p.process_id === "dev-server" ? { ...p, command: "node evil.js" } : p)) },
      ],
      [
        "inventory started_in disagreement",
        {
          ...base,
          processes: base.processes.map((p) =>
            p.process_id === "dev-server" ? { ...p, started_in: { ...p.started_in, beat_id: "C01-L052-S002-B002" } } : p,
          ),
        },
      ],
      [
        "duplicate inventory process id",
        { ...base, processes: [...base.processes, { ...base.processes[0], output_waits: [] }] },
      ],
      [
        "stop reference does not agree with definition",
        {
          ...base,
          scenes: base.scenes.map((scene) =>
            scene.scene_id !== "C01-L052-S003"
              ? scene
              : {
                  ...scene,
                  steps: scene.steps.map((step) =>
                    step.kind === "operation" && step.operation.parameters.type === "terminal_stop"
                      ? {
                          ...step,
                          operation: {
                            ...step.operation,
                            references: { process: { process_id: "dev-server", defined_in: { scene_id: "C01-L052-S001", beat_id: "C01-L052-S001-B002" } } },
                          },
                        }
                      : step,
                  ),
                },
          ),
        },
      ],
    ];
    for (const [label, forged] of forgeries) {
      const result = createLessonCatalog(forged);
      assert.equal(result.ok, false, label);
      if (!result.ok) {
        assert.equal(result.rejection.code, "IR_RUNTIME_INCONSISTENT", label);
      }
    }
  });

  it("rejects IR that fails canonical validation with IR_INVALID", () => {
    const base = compileFixture(MIXED_LESSON);
    const broken = { ...base, compiled_ir_version: "9.9" } as unknown as CompiledLesson;
    const result = createLessonCatalog(broken);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "IR_INVALID");
  });
});

describe("P5.2 execution grants", () => {
  it("a valid foreground terminal_run resolves to an immutable grant", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const result = service.admitRunOperation(identity, boundRun(identity, FOREGROUND_OP));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const grant = result.value;
    assert.equal(grant.kind, "execution_grant");
    if (grant.kind !== "execution_grant") return;
    assert.equal(grant.operation_type, "terminal_run");
    assert.equal(grant.mode, "foreground");
    assert.equal(grant.command, "node --version", "exact authored command preserved");
    assert.equal(grant.cwd, "scripts", "project-relative cwd preserved");
    assert.equal(grant.timeout_ms, 30_000, "authored timeout preserved");
    assert.equal(grant.expected_exit_code, 0, "authored expected exit preserved");
    assert.equal(grant.process_id, null, "foreground process_id is null");
    assert.equal(grant.operation_id, FOREGROUND_OP);
    assert.equal(grant.attempt_id, "att-000001");
    assert.deepEqual(
      { course: grant.course_id, lesson: grant.lesson_id, scene: grant.scene_id, beat: grant.beat_id },
      { course: "C01", lesson: "C01-L052", scene: "C01-L052-S001", beat: "C01-L052-S001-B002" },
      "provenance preserved",
    );
    assert.equal(Object.isFrozen(grant), true, "grant is deeply frozen");
  });

  it("a background terminal_run preserves the authored logical process_id and drops foreground-only fields", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const result = service.admitRunOperation(identity, boundRun(identity, BACKGROUND_OP, "req-bg"));
    assert.equal(result.ok, true);
    if (!result.ok || result.value.kind !== "execution_grant") return assert.fail("expected a grant");
    const grant = result.value;
    assert.equal(grant.mode, "background");
    assert.equal(grant.process_id, "dev-server", "logical process id comes from the compiled IR");
    assert.equal(grant.command, "node server.js");
    assert.equal(grant.cwd, "app");
    assert.equal(grant.timeout_ms, null, "background has no foreground timeout");
    assert.equal(grant.expected_exit_code, null, "background has no expected exit");
  });

  it("foreground defaults apply only when the lesson authors none (60 s timeout, expected 0)", () => {
    const { service, identity } = authorizedSession(COMMAND_PROFILE_LESSON);
    const result = service.admitRunOperation(identity, boundRun(identity, "C01-L053-S001-B001", "req-sentinel"));
    assert.equal(result.ok, true);
    if (!result.ok || result.value.kind !== "execution_grant") return assert.fail("expected a grant");
    assert.equal(result.value.timeout_ms, ADMISSION_POLICY.foreground_timeout_default_ms);
    assert.equal(result.value.expected_exit_code, 0);
    assert.equal(result.value.command, "echo COURSE_FACTORY_P52_SENTINEL > p52-sentinel.txt");
  });

  it("one foreground at a time: a second foreground is rejected while the slot is held", () => {
    const { service, identity } = authorizedSession(COMMAND_PROFILE_LESSON);
    assert.equal(service.admitRunOperation(identity, boundRun(identity, "C01-L053-S001-B001", "req-1")).ok, true);
    const second = service.admitRunOperation(identity, boundRun(identity, OVERSIZED_TIMEOUT_OP, "req-2"));
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.rejection.code, "DUPLICATE_START");
      assert.match(second.rejection.message, /one foreground at a time/);
    }
  });

  it("the runtime completion transition frees the foreground slot; reruns stay prohibited (one attempt per operation)", () => {
    const { service, session, identity } = authorizedSession(COMMAND_PROFILE_LESSON);
    assert.equal(service.admitRunOperation(identity, boundRun(identity, SENTINEL_OP, "req-1")).ok, true);
    const busy = service.admitRunOperation(identity, boundRun(identity, SLOT_RELEASE_OP, "req-2"));
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.rejection.code, "DUPLICATE_START", "slot still held");
    assert.equal(session.recordForegroundCompletion(SENTINEL_OP, "att-000001", "PASS").ok, true);
    const after = service.admitRunOperation(identity, boundRun(identity, SLOT_RELEASE_OP, "req-3"));
    assert.equal(after.ok, true, "the freed slot admits the next foreground operation");
    const rerun = service.admitRunOperation(identity, boundRun(identity, SENTINEL_OP, "req-4"));
    assert.equal(rerun.ok, false);
    if (!rerun.ok) assert.equal(rerun.rejection.code, "DUPLICATE_START", "completed operations cannot run again");
    assert.equal(session.recordForegroundCompletion(SENTINEL_OP, "att-000001", "PASS").ok, false, "completion is not repeatable");
    assert.equal(session.recordForegroundCompletion(SLOT_RELEASE_OP, "att-000002", "PASS").ok, true);
  });

  it("terminal_stop admission resolves the trusted target without stopping anything", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    // defined-but-unstarted: the authored stop is rejected before the process ever ran
    const early = service.admitRunOperation(identity, boundRun(identity, STOP_OP, "req-early-stop"));
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.rejection.code, "PROCESS_NOT_STARTED");
    // start the background process, then the authored stop resolves
    assert.equal(service.admitRunOperation(identity, boundRun(identity, BACKGROUND_OP, "req-bg")).ok, true);
    const stop = service.admitRunOperation(identity, boundRun(identity, STOP_OP, "req-stop"));
    assert.equal(stop.ok, true);
    if (!stop.ok || stop.value.kind !== "stop_admission") return assert.fail("expected a stop admission");
    const stopAdmission = stop.value;
    assert.equal(stopAdmission.origin, "authored_operation");
    assert.equal(stopAdmission.operation_id, STOP_OP);
    assert.deepEqual(stopAdmission.target, {
      process_id: "dev-server",
      defined_in: { scene_id: "C01-L052-S002", beat_id: "C01-L052-S002-B001" },
    });
    assert.equal(Object.isFrozen(stopAdmission), true);
  });

  it("operator stopProcess resolves the same trusted target through the narrow request shape", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    assert.equal(service.admitRunOperation(identity, boundRun(identity, BACKGROUND_OP, "req-bg")).ok, true);
    const stop = service.admitStopProcess(identity, boundStop(identity, "dev-server"));
    assert.equal(stop.ok, true);
    if (!stop.ok || stop.value.kind !== "stop_admission") return assert.fail("expected a stop admission");
    assert.equal(stop.value.origin, "operator_request");
    assert.equal(stop.value.operation_id, null, "operator stops are not lesson operations");
    assert.equal(stop.value.attempt_id, null);
    assert.equal(stop.value.target.process_id, "dev-server");
  });

  it("resetRuntime starts a new generation: stale identities fail safely and definitions may run again", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    assert.equal(service.admitRunOperation(identity, boundRun(identity, BACKGROUND_OP, "req-bg")).ok, true);
    const reset = service.resetRuntime(identity, { session_id: identity.session_id, request_id: "req-reset" });
    assert.equal(reset.ok, true);
    if (!reset.ok) return;
    assert.equal(reset.value.session_id, identity.session_id);
    assert.equal(reset.value.generation, identity.generation + 1);
    const stale = service.admitRunOperation(identity, boundRun(identity, BACKGROUND_OP, "req-stale"));
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "STALE_SESSION");
    const fresh = service.admitRunOperation(reset.value, boundRun(reset.value, BACKGROUND_OP, "req-fresh"));
    assert.equal(fresh.ok, true, "only reset reuses a definition, in a new generation");
    if (fresh.ok && fresh.value.kind === "execution_grant") {
      assert.equal(fresh.value.generation, 2);
      assert.equal(fresh.value.attempt_id, "att-000002", "attempt ids stay unique across generations of a session");
    }
  });

  it("attempt ids are deterministic across identical services", () => {
    const a = authorizedSession(MIXED_LESSON);
    const b = authorizedSession(MIXED_LESSON);
    const ra = a.service.admitRunOperation(a.identity, boundRun(a.identity, FOREGROUND_OP));
    const rb = b.service.admitRunOperation(b.identity, boundRun(b.identity, FOREGROUND_OP));
    if (ra.ok && rb.ok && ra.value.kind === "execution_grant" && rb.value.kind === "execution_grant") {
      assert.equal(ra.value.attempt_id, rb.value.attempt_id);
      assert.equal(ra.value.session_id, rb.value.session_id, "deterministic default session ids");
    } else {
      assert.fail("both admissions should have succeeded");
    }
  });
});

describe("P5.2 lifecycle and eligibility rejections", () => {
  it("unknown operation ids are rejected (no fuzzy lookup, no synthesis)", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const result = service.admitRunOperation(identity, { session_id: identity.session_id, operation_id: "C01-L052-S999-B999", request_id: "req-u" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "INVALID_REQUEST");
    // a narration beat is not an operation either
    const narration = service.admitRunOperation(identity, { session_id: identity.session_id, operation_id: "C01-L052-S001-B001", request_id: "req-n" });
    assert.equal(narration.ok, false);
    if (!narration.ok) assert.equal(narration.rejection.code, "INVALID_REQUEST");
  });

  it("wrong-engine operations are rejected explicitly", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    for (const [op, label] of [
      [BROWSER_OP, "browser_open"],
      [TYPE_CODE_OP, "type_code"],
    ] as const) {
      const result = service.admitRunOperation(identity, boundRun(identity, op, `req-${label}`));
      assert.equal(result.ok, false, label);
      if (!result.ok) {
        assert.equal(result.rejection.code, "UNSUPPORTED_PHASE", label);
        assert.match(result.rejection.message, /terminal runtime does not execute/);
      }
    }
    // P5.10: wait until=process_output is the internal admitted observation
    // primitive (trusted WaitAdmission), not a wrong-engine operation. It is
    // covered by the P5.10 output-wait suite; duration/port waits stay
    // UNSUPPORTED_PHASE (no TCP workflow, no wait scheduling in P5).
  });

  it("duplicate start of the same operation is rejected regardless of request id", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    assert.equal(service.admitRunOperation(identity, boundRun(identity, FOREGROUND_OP, "req-1")).ok, true);
    const again = service.admitRunOperation(identity, boundRun(identity, FOREGROUND_OP, "req-2"));
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.rejection.code, "DUPLICATE_START");
  });

  it("stale generation, unknown session and disposed session all fail safely", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const stale = service.admitRunOperation(
      { session_id: identity.session_id, generation: identity.generation + 7 },
      boundRun(identity, FOREGROUND_OP),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.rejection.code, "STALE_SESSION");

    const unknown = service.admitRunOperation(
      { session_id: "sess-nope", generation: 1 },
      { session_id: "sess-nope", operation_id: FOREGROUND_OP, request_id: "req-u" },
    );
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.rejection.code, "STALE_SESSION");

    assert.equal(service.disposeSession(identity).ok, true);
    const disposed = service.admitRunOperation(identity, boundRun(identity, FOREGROUND_OP));
    assert.equal(disposed.ok, false);
    if (!disposed.ok) assert.equal(disposed.rejection.code, "STALE_SESSION");
    assert.equal(service.resolveSession(identity), null);
  });

  it("inspection-only sessions never receive grants (P4 fixtures stay inspection-only)", () => {
    const { service, identity } = inspectionSession(MIXED_LESSON);
    const result = service.admitRunOperation(identity, boundRun(identity, FOREGROUND_OP));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "NOT_AUTHORIZED");
  });

  it("cancellation resolves only the active foreground reservation", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const nothing = service.admitCancelOperation(identity, { session_id: identity.session_id, operation_id: FOREGROUND_OP, request_id: "req-c0" });
    assert.equal(nothing.ok, false, "nothing reserved yet");
    assert.equal(service.admitRunOperation(identity, boundRun(identity, FOREGROUND_OP, "req-run")).ok, true);
    const ok = service.admitCancelOperation(identity, { session_id: identity.session_id, operation_id: FOREGROUND_OP, request_id: "req-c1" });
    assert.equal(ok.ok, true);
    if (ok.ok && ok.value.kind === "cancel_admission") {
      assert.equal(ok.value.operation_id, FOREGROUND_OP);
      assert.equal(ok.value.attempt_id, "att-000001");
      assert.equal(ok.value.beat_id, FOREGROUND_OP);
      assert.equal(Object.isFrozen(ok.value), true);
    }
    const other = service.admitCancelOperation(identity, { session_id: identity.session_id, operation_id: BACKGROUND_OP, request_id: "req-c2" });
    assert.equal(other.ok, false, "background processes are stopped, not cancelled");
    if (!other.ok) assert.equal(other.rejection.code, "INVALID_REQUEST");
  });

  it("stop of an unknown logical process is rejected with the canonical code", () => {
    const { service, identity } = authorizedSession(MIXED_LESSON);
    const result = service.admitStopProcess(identity, boundStop(identity, "ghost-process"));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.rejection.code, "INVALID_PROCESS_REFERENCE");
  });

  it("authored timeout above the design maximum is rejected before any provider sees it", () => {
    const { service, identity } = authorizedSession(COMMAND_PROFILE_LESSON);
    const result = service.admitRunOperation(identity, boundRun(identity, OVERSIZED_TIMEOUT_OP, "req-timeout"));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.rejection.code, "INVALID_REQUEST");
      assert.match(result.rejection.message, /3600/);
    }
  });
});
