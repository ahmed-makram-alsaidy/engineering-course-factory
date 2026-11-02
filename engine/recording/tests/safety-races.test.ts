// P9.6 Race Matrix — deterministic, zero sleeps.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md task P9.6 (race matrix).
// Twelve races, each with one deterministic winner/outcome, driven through
// the controller with scripted doubles and the manual scheduler.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TakeSafetyController } from "../src/safety/controller.ts";
import { LOW_SPACE_ABORT_BYTES } from "../src/disk-budget.ts";
import {
  controllerOptions,
  guardedInput,
} from "./safety-helpers.ts";

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function healthyEvidence() {
  return {
    outcomeCompleted: true,
    encoderFlushOk: true,
    mediaValidationPass: true,
    frameCount: 300,
    durationUs: 10_000_000,
    timelineValid: true,
    anchorsValid: true,
    manifestValid: true,
    digestPresent: true,
    diskStillSafe: true,
    sameFence: true,
  };
}

describe("P9.6: race matrix (one deterministic winner each)", () => {
  it("low-space vs completion: low-space wins, no publication", async () => {
    const { options, owner, files, disk, scheduler } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    disk.freeBytesOrNull = LOW_SPACE_ABORT_BYTES - 1;
    scheduler.runAll();
    await flushMicrotasks();
    // Completion settlement after the terminal latch is ignored.
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
    assert.deepEqual(owner.abortCalls, ["LOW_DISK_ABORT"]);
    assert.equal(files.publishedSteps.length, 0);
  });

  it("low-space vs cancel: first latch wins, single cleanup", async () => {
    const { options, owner, files, disk, scheduler } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    disk.freeBytesOrNull = LOW_SPACE_ABORT_BYTES - 1;
    scheduler.runAll();
    await flushMicrotasks();
    await controller.abortForCause("OPERATOR_CANCELLED");
    await flushMicrotasks();
    assert.deepEqual(owner.abortCalls, ["LOW_DISK_ABORT"]);
    assert.equal(files.purged.length, 1);
    assert.equal(controller.terminal, "LOW_DISK_ABORT");
  });

  it("low-space vs reset: first latch wins, never continued", async () => {
    const { options, owner, files, disk, scheduler } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    disk.freeBytesOrNull = LOW_SPACE_ABORT_BYTES - 1;
    scheduler.runAll();
    await flushMicrotasks();
    await controller.abortForCause("RESET_INTERRUPTED");
    assert.deepEqual(owner.abortCalls, ["LOW_DISK_ABORT"]);
    assert.equal(files.purged.length, 1);
  });

  it("low-space vs app shutdown: single INCOMPLETE outcome", async () => {
    const { options, owner, disk, scheduler } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    disk.freeBytesOrNull = LOW_SPACE_ABORT_BYTES - 1;
    scheduler.runAll();
    await flushMicrotasks();
    await controller.shutdownGuarded();
    await flushMicrotasks();
    assert.deepEqual(owner.abortCalls, ["LOW_DISK_ABORT"]);
    assert.equal(controller.terminal, "LOW_DISK_ABORT");
  });

  it("completion vs source loss: source loss wins, no success", async () => {
    const { options, owner, clock } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    clock.advance(2000);
    assert.equal(controller.checkStarvation(), true);
    await flushMicrotasks();
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
    assert.deepEqual(owner.abortCalls, ["CAPTURE_SOURCE_LOST"]);
  });

  it("completion vs encoder failure: encoder failure wins", async () => {
    const { options, owner, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await controller.abortForCause("ENCODER_FAILED");
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
    assert.deepEqual(owner.abortCalls, ["ENCODER_FAILED"]);
    assert.equal(files.quarantined.length, 1);
  });

  it("publication vs shutdown: shutdown supersedes, single outcome", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.shutdownGuarded();
    await flushMicrotasks();
    assert.deepEqual(owner.abortCalls, ["APP_CLOSED"]);
    assert.equal(controller.terminal, "APP_CLOSED");
  });

  it("publication vs low disk: disk-unsafe evidence cannot publish", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const result = await controller.settleSuccessfulTake(started.take, {
      ...healthyEvidence(),
      diskStillSafe: false,
    });
    assert.equal(result.published, false);
    assert.equal(files.publishedSteps.length, 0);
  });

  it("cancel vs quarantine: cancel purges, never quarantines", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const disposition = await controller.abortForCause("OPERATOR_CANCELLED");
    assert.equal(disposition.temp, "PURGE");
    assert.equal(files.quarantined.length, 0);
    assert.equal(files.purged.length, 1);
  });

  it("reset vs publication: reset take cannot settle successfully", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await controller.abortForCause("RESET_INTERRUPTED");
    const result = await controller.settleSuccessfulTake(started.take, healthyEvidence());
    assert.equal(result.published, false);
  });

  it("orphan recovery vs active take: active entries kept", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    // Directory-level ownership (proven by the file owner) keeps the live
    // take dir; name-level planning alone never deletes.
    const plan = controller.planRecovery(["screen.partial.mp4"], { staleDisposition: "PURGE" });
    assert.equal(plan.length, 1);
    assert.equal(controller.activeTake?.takeId, started.take.takeId);
  });

  it("cleanup failure vs new take: uncertainty never blocks a new take", async () => {
    const { options, files } = controllerOptions();
    files.failPurge = true;
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput({ generation: 1 }));
    await controller.abortForCause("OPERATOR_CANCELLED");
    const kinds = controller.eventLog().map((event) => event.kind);
    assert.ok(kinds.includes("PURGE_UNCONFIRMED"));
    files.failPurge = false;
    const second = await controller.startGuardedTake(guardedInput({ generation: 1 }));
    assert.equal(second.ok, true);
  });
});
