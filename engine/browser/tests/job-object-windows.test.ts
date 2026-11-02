// P7.3 Windows Job Object & Process Management Tests — browser_protocol_version = 1.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 19.
// Proves on real Windows platform:
// 1. Windows Job Object initialization with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
// 2. Child process tracking via Windows kernel.
// 3. Process ledger records session, generation, and root PID.
// 4. Closing the Job Object terminates child processes automatically.
// 5. Explicit termination kills assigned processes cleanly.
// 6. Unrelated processes are STRICTLY untouched (no indiscriminate killing).
// 7. Bounded verification barrier confirms absence with zero survivors.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  ensureJobHostExecutable,
  WindowsJobObject,
} from "../src/job-object.ts";

describe("P7.3 Real Windows Job Object & Process Safety", () => {
  it("proves Windows JobHost helper compiles and exists", () => {
    if (process.platform !== "win32") return;
    const exe = ensureJobHostExecutable();
    assert.ok(existsSync(exe), `JobHost executable should exist at ${exe}`);
  });

  it("creates a Windows Job Object with KILL_ON_JOB_CLOSE and tracks process ledger", async () => {
    if (process.platform !== "win32") return;

    const job = new WindowsJobObject("test-session-1", 1);
    await job.init();

    const ledger = job.getLedgerEntry();
    assert.equal(ledger.session_id, "test-session-1");
    assert.equal(ledger.generation, 1);
    assert.equal(ledger.state, "RUNNING");
    assert.ok(ledger.job_name.includes("test-session-1-1"));

    await job.close();
    assert.equal(job.getLedgerEntry().state, "TERMINATED");
  });

  it("proves child processes die when Job Object closes, while unrelated processes remain untouched", async () => {
    if (process.platform !== "win32") return;

    // 1. Spawn a target child process that will be assigned to the Job Object
    const assignedTarget = spawn("cmd.exe", ["/c", "ping", "127.0.0.1", "-n", "30"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const targetPid = assignedTarget.pid!;
    assert.ok(targetPid > 0, "Target process must have valid PID");

    // 2. Spawn an UNRELATED process that is NOT in the Job Object
    const unrelatedTarget = spawn("cmd.exe", ["/c", "ping", "127.0.0.1", "-n", "30"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const unrelatedPid = unrelatedTarget.pid!;
    assert.ok(unrelatedPid > 0, "Unrelated process must have valid PID");

    // 3. Create Job and assign only the target process
    const job = new WindowsJobObject("test-session-safety", 1);
    await job.init();
    await job.assignProcess(targetPid);

    // Verify both are currently alive
    assert.doesNotThrow(() => process.kill(targetPid, 0), "Assigned target should be alive");
    assert.doesNotThrow(() => process.kill(unrelatedPid, 0), "Unrelated target should be alive");

    // Query PIDs in the Job Object
    const jobPids = await job.queryPids();
    assert.ok(jobPids.includes(targetPid), "Job Object must include assigned target PID");
    assert.ok(!jobPids.includes(unrelatedPid), "Job Object must NOT include unrelated PID");

    // 4. Close the Job Object (triggers KILL_ON_JOB_CLOSE in Windows kernel)
    await job.close();

    // 5. Verify assigned target process is dead
    const targetDead = await WindowsJobObject.verifyAbsence([targetPid], 5000);
    assert.equal(targetDead, true, "Assigned process must be terminated when Job Object closes");

    // 6. PROOF: Unrelated process MUST STILL BE ALIVE!
    let unrelatedStillAlive = false;
    try {
      process.kill(unrelatedPid, 0);
      unrelatedStillAlive = true;
    } catch {}
    assert.equal(unrelatedStillAlive, true, "Unrelated process MUST NOT be killed by Job Object closure");

    // Clean up unrelated test process cleanly
    try {
      process.kill(unrelatedPid, "SIGTERM");
    } catch {}
  });

  it("proves explicit terminateJob cleanly terminates assigned processes", async () => {
    if (process.platform !== "win32") return;

    const target = spawn("cmd.exe", ["/c", "ping", "127.0.0.1", "-n", "30"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const pid = target.pid!;

    const job = new WindowsJobObject("test-session-term", 1);
    await job.init();
    await job.assignProcess(pid);

    assert.doesNotThrow(() => process.kill(pid, 0));

    await job.terminateJob();

    const dead = await WindowsJobObject.verifyAbsence([pid], 5000);
    assert.equal(dead, true, "Assigned process must be dead after terminateJob");

    await job.close();
  });
});
