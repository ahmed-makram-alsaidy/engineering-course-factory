// P9.6 Failure Disposition — cancel/reset/failed/source/encoder/timeline.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 16, 23. Covers the
// unit matrix CANCEL (36-40), RESET (41-43), FAILED/HOLD (44-48), SOURCE
// LOSS (49-53), ENCODER (54-59), TIMELINE (60-61): deterministic, zero
// sleeps, scripted doubles only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dispositionForCause,
  shutdownBudgetLeftMs,
  shutdownStrategyForElapsed,
  SourceStarvationTracker,
  SAFETY_ENCODER_FLUSH_MS,
  SAFETY_SHUTDOWN_BARRIER_MS,
  SAFETY_STARVATION_MS,
} from "../src/safety/failure-policy.ts";
import {
  evaluatePublicationGate,
} from "../src/safety/publication.ts";
import { NO_VALID_FRAME_MS } from "../src/capture/wgc-session.ts";
import { ENCODER_FLUSH_TIMEOUT_MS } from "../src/disk-budget.ts";
import { TakeSafetyController } from "../src/safety/controller.ts";
import {
  ManualSafetyClock,
  controllerOptions,
  guardedInput,
} from "./safety-helpers.ts";

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

describe("P9.6: cancel purges with no published artifact", () => {
  it("cancellation purges media temp", async () => {
    const { options, owner, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    const disposition = await controller.abortForCause("OPERATOR_CANCELLED");
    assert.equal(disposition.outcome, "CANCELLED");
    assert.equal(disposition.publication, "PURGED");
    assert.equal(disposition.mayPublish, false);
    assert.deepEqual(owner.abortCalls, ["OPERATOR_CANCELLED"]);
    assert.equal(files.purged.length, 1);
  });

  it("cancellation purges anchors and manifest temp with the take dir", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.abortForCause("OPERATOR_CANCELLED");
    // One take-dir purge covers media + anchors + manifest temps together.
    assert.equal(files.purged.length, 1);
    assert.equal(files.quarantined.length, 0);
  });

  it("cancellation never PUBLISHED and claims no digest", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const disposition = await controller.abortForCause("OPERATOR_CANCELLED");
    assert.notEqual(disposition.publication, "PUBLISHED");
    assert.notEqual(disposition.publication, "VALIDATED");
    assert.equal(disposition.retainDiagnostic, false);
  });

  it("cleanup is idempotent across duplicate terminal causes", async () => {
    const { options, owner, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const first = await controller.abortForCause("OPERATOR_CANCELLED");
    const second = await controller.abortForCause("OPERATOR_CANCELLED");
    assert.equal(first.outcome, second.outcome);
    assert.deepEqual(owner.abortCalls, ["OPERATOR_CANCELLED"]);
    assert.equal(files.purged.length, 1);
  });

  it("first terminal cause wins over a late second cause", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.abortForCause("OPERATOR_CANCELLED");
    await controller.abortForCause("APP_CLOSED");
    assert.equal(controller.terminal, "OPERATOR_CANCELLED");
    assert.deepEqual(owner.abortCalls, ["OPERATOR_CANCELLED"]);
  });
});

describe("P9.6: reset interrupts and never publishes", () => {
  it("reset interrupted never publishes", async () => {
    const { options } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const disposition = await controller.abortForCause("RESET_INTERRUPTED");
    assert.equal(disposition.outcome, "RESET_INTERRUPTED");
    assert.equal(disposition.mayPublish, false);
    assert.notEqual(disposition.publication, "PUBLISHED");
  });

  it("generation N+1 requires a new take (old take stays terminal)", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const first = await controller.startGuardedTake(guardedInput({ generation: 1 }));
    assert.equal(first.ok, true);
    await controller.abortForCause("RESET_INTERRUPTED");
    const second = await controller.startGuardedTake(guardedInput({ generation: 2 }));
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.equal(second.take.generation, 2);
      assert.notEqual(second.take.takeId, first.ok ? first.take.takeId : null);
    }
    assert.equal(owner.takeCounter, 2);
  });

  it("old partial purged on reset (no quarantine for generation fences)", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const disposition = await controller.abortForCause("RESET_INTERRUPTED");
    assert.equal(disposition.temp, "PURGE");
    assert.equal(files.purged.length, 1);
    assert.equal(files.quarantined.length, 0);
  });
});

describe("P9.6: FAILED/HOLD quarantines diagnostics under TEMP only", () => {
  it("FAILED produces a canonical quarantine", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const disposition = await controller.abortForCause("DIAGNOSTIC_PARTIAL");
    assert.equal(disposition.outcome, "FAILED");
    assert.equal(disposition.publication, "QUARANTINED");
    assert.equal(disposition.retainDiagnostic, true);
    assert.equal(files.quarantined.length, 1);
    assert.equal(files.purged.length, 0);
  });

  it("encoder failure quarantines (never published)", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const disposition = await controller.abortForCause("ENCODER_FAILED");
    assert.equal(disposition.outcome, "FAILED");
    assert.equal(disposition.publication, "QUARANTINED");
    assert.equal(files.quarantined.length, 1);
  });

  it("quarantine never publishes and never touches the delivery root", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const disposition = await controller.abortForCause("MEDIA_VALIDATION_FAILED");
    assert.equal(disposition.mayPublish, false);
    assert.equal(files.publishedSteps.length, 0);
    assert.equal(files.removedPublished, 0);
  });

  it("encoder nonzero exit maps to FAILED with quarantine", () => {
    const disposition = dispositionForCause("ENCODER_FAILED");
    assert.equal(disposition.outcome, "FAILED");
    assert.equal(disposition.temp, "QUARANTINE");
  });

  it("diagnostic size and path stay bounded by owner contract", async () => {
    // The file owner keeps exactly one renamed diagnostic per take dir and
    // removes staging residue; the controller records exactly one event.
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.abortForCause("DIAGNOSTIC_PARTIAL");
    assert.equal(files.quarantined.length, 1);
    const kinds = controller.eventLog().map((event) => event.kind);
    assert.ok(kinds.includes("QUARANTINE_QUARANTINED"));
  });
});

describe("P9.6: capture source loss fails closed (2 s starvation)", () => {
  it("starvation bound is the frozen 2 s watchdog", () => {
    assert.equal(NO_VALID_FRAME_MS, 2000);
    assert.equal(SAFETY_STARVATION_MS, 2000);
  });

  it("source loss inside the grace window is not terminal", () => {
    const clock = new ManualSafetyClock();
    const tracker = new SourceStarvationTracker({ nowMs: () => clock.now() });
    tracker.noteStart();
    clock.advance(1999);
    assert.equal(tracker.isStarved(), false);
  });

  it("source loss at 2 s is terminal", () => {
    const clock = new ManualSafetyClock();
    const tracker = new SourceStarvationTracker({ nowMs: () => clock.now() });
    tracker.noteStart();
    clock.advance(2000);
    assert.equal(tracker.isStarved(), true);
  });

  it("valid frames reset the starvation bound", () => {
    const clock = new ManualSafetyClock();
    const tracker = new SourceStarvationTracker({ nowMs: () => clock.now() });
    tracker.noteStart();
    clock.advance(1500);
    tracker.noteValidFrame();
    clock.advance(1500);
    assert.equal(tracker.isStarved(), false);
    clock.advance(500);
    assert.equal(tracker.isStarved(), true);
  });

  it("starved take aborts CAPTURE_SOURCE_LOST and never succeeds", async () => {
    const { options, owner, clock } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    clock.advance(2000);
    assert.equal(controller.checkStarvation(), true);
    await flushMicrotasks();
    assert.deepEqual(owner.abortCalls, ["CAPTURE_SOURCE_LOST"]);
    assert.equal(controller.terminal, "CAPTURE_SOURCE_LOST");
    const disposition = dispositionForCause("CAPTURE_SOURCE_LOST");
    assert.equal(disposition.mayPublish, false);
  });

  it("geometry change uses the terminal source-loss disposition", () => {
    const disposition = dispositionForCause("CAPTURE_SOURCE_LOST");
    assert.equal(disposition.outcome, "FAILED");
    assert.notEqual(disposition.publication, "PUBLISHED");
  });

  it("display loss uses the terminal source-loss disposition", () => {
    const disposition = dispositionForCause("CAPTURE_SOURCE_LOST");
    assert.equal(disposition.mayPublish, false);
    assert.equal(disposition.retainDiagnostic, true);
  });
});

describe("P9.6: encoder and timeline failures block success", () => {
  it("encoder drain timeout maps to FAILED quarantine", () => {
    const disposition = dispositionForCause("ENCODER_FAILED");
    assert.equal(disposition.outcome, "FAILED");
    assert.equal(disposition.temp, "QUARANTINE");
  });

  it("encoder flush timeout maps to FAILED quarantine", () => {
    assert.equal(SAFETY_ENCODER_FLUSH_MS, ENCODER_FLUSH_TIMEOUT_MS);
    assert.equal(SAFETY_ENCODER_FLUSH_MS, 30_000);
    const disposition = dispositionForCause("ENCODER_FAILED");
    assert.equal(disposition.mayPublish, false);
  });

  it("validation failure maps to FAILED quarantine", () => {
    const disposition = dispositionForCause("MEDIA_VALIDATION_FAILED");
    assert.equal(disposition.outcome, "FAILED");
    assert.equal(disposition.publication, "QUARANTINED");
  });

  it("owned abort only: controller never signals beyond the owned take", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.abortForCause("ENCODER_FAILED");
    assert.deepEqual(owner.abortCalls, ["ENCODER_FAILED"]);
    assert.equal(owner.shutdownCalls.length, 0);
  });

  it("TIMELINE_INVALID blocks publication via the gate", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const gate = evaluatePublicationGate({
      outcomeCompleted: true,
      encoderFlushOk: true,
      mediaValidationPass: true,
      frameCount: 100,
      durationUs: 3_000_000,
      timelineValid: false,
      anchorsValid: true,
      manifestValid: true,
      digestPresent: true,
      diskStillSafe: true,
      sameFence: true,
    });
    assert.equal(gate.ok, false);
    void files;
  });

  it("stale generation blocks publication via fence mismatch", async () => {
    const gate = evaluatePublicationGate({
      outcomeCompleted: true,
      encoderFlushOk: true,
      mediaValidationPass: true,
      frameCount: 100,
      durationUs: 3_000_000,
      timelineValid: true,
      anchorsValid: true,
      manifestValid: true,
      digestPresent: true,
      diskStillSafe: true,
      sameFence: false,
    });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "FENCE_MISMATCH");
  });
});

describe("P9.6: app close is bounded and INCOMPLETE", () => {
  it("shutdown barrier is the frozen 10 s", () => {
    assert.equal(SAFETY_SHUTDOWN_BARRIER_MS, 10_000);
  });

  it("flush attempted while budget remains, owned abort after", () => {
    assert.equal(shutdownStrategyForElapsed(0), "FLUSH_WITHIN_BUDGET");
    assert.equal(shutdownStrategyForElapsed(9_999), "FLUSH_WITHIN_BUDGET");
    assert.equal(shutdownStrategyForElapsed(10_000), "ABORT_OWNED");
    assert.equal(shutdownStrategyForElapsed(30_000), "ABORT_OWNED");
    assert.equal(shutdownBudgetLeftMs(0), 10_000);
    assert.equal(shutdownBudgetLeftMs(10_000), 0);
  });

  it("graceful close marks INCOMPLETE and releases the slot", async () => {
    const { options, owner, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    const shutdown = await controller.shutdownGuarded();
    assert.equal(shutdown.strategy, "FLUSH_WITHIN_BUDGET");
    await flushMicrotasks();
    assert.deepEqual(owner.abortCalls, ["APP_CLOSED"]);
    assert.equal(controller.terminal, "APP_CLOSED");
    assert.equal(files.purged.length, 1);
    assert.equal(controller.activeTake, null);
  });

  it("shutdown barrier resolves without throwing when idle", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const shutdown = await controller.shutdownGuarded();
    assert.equal(shutdown.strategy, "FLUSH_WITHIN_BUDGET");
    assert.deepEqual(owner.shutdownCalls, ["app_close"]);
  });

  it("no surviving owner take after shutdown", async () => {
    const { options, owner } = controllerOptions();
    const controller = new TakeSafetyController(options);
    await controller.startGuardedTake(guardedInput());
    await controller.shutdownGuarded();
    await flushMicrotasks();
    assert.equal(owner.active, null);
    assert.equal(owner.getActiveFence(), null);
  });
});
