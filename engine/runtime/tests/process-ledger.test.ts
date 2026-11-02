// P8.5 Background Process Lifecycle Ledger Tests
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 22 & ADR-0013.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProcessLifecycleLedger } from "../src/process-ledger.ts";
import { RuntimeError } from "../src/errors.ts";
import type { ValidatedProcessPlan } from "../src/validator.ts";

describe("P8.5: Process Lifecycle Ledger", () => {
  const samplePlans: ValidatedProcessPlan[] = [
    {
      process_id: "demo_server",
      producer_step_id: "step-bg-start",
      stopped_step_id: "step-term-stop",
      guest_ports: [3000],
      lifetime: "TERMINATED_IN_LESSON",
    },
    {
      process_id: "worker_daemon",
      producer_step_id: "step-worker-start",
      guest_ports: [],
      lifetime: "LIVES_UNTIL_COMPLETION",
    },
  ];

  it("initializes background processes in REGISTERED state", () => {
    const ledger = new ProcessLifecycleLedger(samplePlans, 1);

    assert.equal(ledger.hasProcess("demo_server"), true);
    assert.equal(ledger.hasProcess("worker_daemon"), true);
    assert.equal(ledger.hasProcess("unknown_proc"), false);

    const p1 = ledger.getProcess("demo_server");
    assert.equal(p1?.state, "REGISTERED");
    assert.equal(p1?.producer_step_id, "step-bg-start");
    assert.equal(p1?.stopped_step_id, "step-term-stop");
    assert.deepEqual(p1?.guest_ports, [3000]);

    assert.equal(ledger.isLive("demo_server"), false);
    assert.deepEqual(ledger.getActiveProcessIds(), []);
  });

  it("tracks lifecycle transitions: REGISTERED -> RUNNING -> STOPPING -> RETIRED", () => {
    const ledger = new ProcessLifecycleLedger(samplePlans, 1);

    // 1. Confirm start -> markActive
    ledger.markActive("demo_server", "step-bg-start", 1);
    assert.equal(ledger.getProcess("demo_server")?.state, "RUNNING");
    assert.equal(ledger.isLive("demo_server"), true);
    assert.deepEqual(ledger.getActiveProcessIds(), ["demo_server"]);

    // 2. Dispatch stop -> markStopping
    ledger.markStopping("demo_server", "step-term-stop");
    assert.equal(ledger.getProcess("demo_server")?.state, "STOPPING");

    // 3. Confirm stop -> markRetired
    ledger.markRetired("demo_server", "step-term-stop");
    assert.equal(ledger.getProcess("demo_server")?.state, "RETIRED");
    assert.equal(ledger.isLive("demo_server"), false);
    assert.deepEqual(ledger.getActiveProcessIds(), []);
  });

  it("dependency gate succeeds when prerequisite process is RUNNING", () => {
    const ledger = new ProcessLifecycleLedger(samplePlans, 1);
    ledger.markActive("demo_server", "step-bg-start", 1);

    // Consumer step depends on step-bg-start
    assert.doesNotThrow(() => {
      ledger.verifyDependencies("step-browser-open", ["step-bg-start"]);
    });
  });

  it("dependency gate fails closed with DEPENDENCY_NOT_MET if process exited early", () => {
    const ledger = new ProcessLifecycleLedger(samplePlans, 1);
    ledger.markActive("demo_server", "step-bg-start", 1);

    // Simulate unexpected crash/exit
    ledger.markExitedEarly("demo_server");
    assert.equal(ledger.isLive("demo_server"), false);

    assert.throws(
      () => {
        ledger.verifyDependencies("step-browser-open", ["step-bg-start"]);
      },
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "DEPENDENCY_NOT_MET");
        return true;
      },
    );
  });

  it("dependency gate fails closed if prerequisite process was never activated", () => {
    const ledger = new ProcessLifecycleLedger(samplePlans, 1);
    // Still in REGISTERED state, not RUNNING

    assert.throws(
      () => {
        ledger.verifyDependencies("step-browser-open", ["step-bg-start"]);
      },
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "DEPENDENCY_NOT_MET");
        return true;
      },
    );
  });

  it("identifies processes requiring lesson completion cleanup", () => {
    const ledger = new ProcessLifecycleLedger(samplePlans, 1);
    ledger.markActive("demo_server", "step-bg-start", 1);
    ledger.markActive("worker_daemon", "step-worker-start", 1);

    // demo_server is terminated in lesson; worker_daemon lives until completion
    ledger.markRetired("demo_server", "step-term-stop");

    const unretired = ledger.getProcessesRequiringCompletionCleanup();
    assert.deepEqual(unretired, ["worker_daemon"]);

    ledger.markRetired("worker_daemon");
    assert.deepEqual(ledger.getProcessesRequiringCompletionCleanup(), []);
  });

  it("exports safe DTO snapshots conforming to ProcessLifecycleEntryDtoSchema", () => {
    const ledger = new ProcessLifecycleLedger(samplePlans, 1);
    ledger.markActive("demo_server", "step-bg-start", 1);

    const entries = ledger.getAllEntries();
    assert.equal(entries.length, 2);

    const demo = entries.find((e) => e.process_id === "demo_server");
    assert.ok(demo);
    assert.equal(demo?.state, "RUNNING");
    assert.equal(demo?.started_step_id, "step-bg-start");
    assert.equal(demo?.stopped_step_id, "step-term-stop");
  });
});
