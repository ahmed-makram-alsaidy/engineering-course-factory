// P9.6 Atomic Publication — success gate + transaction + rollback.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 15, 20, 22 and the
// P9.1 manifest invariants. Covers the unit matrix SUCCESS PUBLICATION
// (18-29) and PUBLICATION FAILURES (30-35): deterministic, zero sleeps.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  confirmTempCleanup,
  evaluatePublicationGate,
  planPublicationTransaction,
  planRollbackForCompleted,
  type PublicationReadiness,
} from "../src/safety/publication.ts";
import { TakeSafetyController } from "../src/safety/controller.ts";
import { controllerOptions, guardedInput } from "./safety-helpers.ts";

function healthyReadiness(overrides?: Partial<PublicationReadiness>): PublicationReadiness {
  return {
    outcomeCompleted: true,
    encoderFlushOk: true,
    mediaValidationPass: true,
    frameCount: 900,
    mediaFrameCount: 900,
    manifestVersion: "1.1",
    capturedFrameCount: 900,
    durationUs: 30_000_000,
    timelineValid: true,
    anchorsValid: true,
    manifestValid: true,
    digestPresent: true,
    diskStillSafe: true,
    sameFence: true,
    ...overrides,
  };
}

describe("P9.6: success publication invariant (all must hold)", () => {
  it("validated success can publish", () => {
    assert.deepEqual(evaluatePublicationGate(healthyReadiness()), { ok: true });
  });

  it("invalid media cannot publish", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ mediaValidationPass: false }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "MEDIA_VALIDATION_FAILED");
  });

  it("invalid timeline cannot publish", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ timelineValid: false }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "TIMELINE_INVALID");
  });

  it("zero frames cannot publish", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ frameCount: 0 }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "ZERO_FRAMES");
  });

  it("missing digest cannot publish", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ digestPresent: false }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "DIGEST_MISSING");
  });

  it("manifest invalid cannot publish", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ manifestValid: false }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "MANIFEST_INVALID");
  });

  it("sidecar invalid cannot publish", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ anchorsValid: false }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "ANCHORS_INVALID");
  });

  it("disk unsafe cannot publish even when media is perfect", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ diskStillSafe: false }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "DISK_UNSAFE");
  });

  it("non-completed outcome cannot publish", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ outcomeCompleted: false }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "OUTCOME_NOT_COMPLETED");
  });

  it("failed encoder flush cannot publish", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ encoderFlushOk: false }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "ENCODER_FLUSH_FAILED");
  });

  it("fence mismatch across media/manifest/anchors cannot publish", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ sameFence: false }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "FENCE_MISMATCH");
  });

  it("zero or over-ceiling duration cannot publish", () => {
    assert.equal(evaluatePublicationGate(healthyReadiness({ durationUs: 0 })).ok, false);
    assert.equal(
      evaluatePublicationGate(healthyReadiness({ durationUs: 1_802_000_001 })).ok,
      false,
    );
    assert.equal(
      evaluatePublicationGate(healthyReadiness({
        durationUs: 1_802_000_000,
        frameCount: 54_061,
        mediaFrameCount: 54_061,
        capturedFrameCount: 54_061,
      })).ok,
      true,
    );
  });

  it("stale manifest version cannot publish (P1)", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ manifestVersion: "1.0" }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "MANIFEST_VERSION_STALE");
  });

  it("missing or mismatched media frame count cannot publish (P2)", () => {
    const missing = evaluatePublicationGate(healthyReadiness({ mediaFrameCount: null }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "MEDIA_COUNT_UNAVAILABLE");

    const mismatch = evaluatePublicationGate(healthyReadiness({ frameCount: 900, mediaFrameCount: 899 }));
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.reason, "MANIFEST_MEDIA_MISMATCH");
  });

  it("duration inconsistent with CFR slots cannot publish (P3)", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ frameCount: 900, durationUs: 60_000_000 }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "DURATION_SLOTS_MISMATCH");
  });

  it("captured zero frames cannot publish (P4)", () => {
    const gate = evaluatePublicationGate(healthyReadiness({ capturedFrameCount: 0 }));
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.reason, "FIRST_FRAME_ABSENT");
  });

  it("transaction order is stage, media, manifest, anchors, verify, cleanup", () => {
    assert.deepEqual(planPublicationTransaction(), [
      "WRITE_MANIFEST_TEMP",
      "WRITE_ANCHORS_TEMP",
      "RENAME_MEDIA",
      "RENAME_MANIFEST",
      "RENAME_ANCHORS",
      "VERIFY_SET",
      "CLEANUP_STAGING",
    ]);
  });

  it("settled success with healthy evidence publishes exactly once", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const result = await controller.settleSuccessfulTake(started.take, healthyReadiness());
    assert.equal(result.published, true);
    assert.deepEqual(result.gate, { ok: true });
    assert.deepEqual(files.publishedSteps, planPublicationTransaction());
    assert.equal(controller.terminal, "SUCCESS");
  });

  it("settled success with bad evidence never publishes and purges temp", async () => {
    const { options, files } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const result = await controller.settleSuccessfulTake(
      started.take,
      healthyReadiness({ frameCount: 0 }),
    );
    assert.equal(result.published, false);
    assert.equal(files.publishedSteps.length, 0);
    assert.equal(files.purged.length, 1);
  });
});

describe("P9.6: publication failures roll back (no false complete set)", () => {
  it("media rename failure never publishes", async () => {
    const { options, files } = controllerOptions();
    files.stepFaults = { RENAME_MEDIA: true };
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const result = await controller.settleSuccessfulTake(started.take, healthyReadiness());
    assert.equal(result.published, false);
    assert.equal(files.removedPublished, 0);
    assert.equal(files.purged.length, 1);
  });

  it("manifest rename failure rolls back the renamed media", async () => {
    const { options, files } = controllerOptions();
    files.stepFaults = { RENAME_MANIFEST: true };
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const result = await controller.settleSuccessfulTake(started.take, healthyReadiness());
    assert.equal(result.published, false);
    // Rollback removed the already-renamed media: no false complete set.
    assert.ok(files.removedPublished >= 1);
    assert.equal(files.purged.length, 1);
  });

  it("anchor rename failure rolls back media and manifest", async () => {
    const { options, files } = controllerOptions();
    files.stepFaults = { RENAME_ANCHORS: true };
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const result = await controller.settleSuccessfulTake(started.take, healthyReadiness());
    assert.equal(result.published, false);
    assert.ok(files.removedPublished >= 1);
  });

  it("rollback plan inverts the completed prefix in reverse", () => {
    assert.deepEqual(planRollbackForCompleted(["WRITE_MANIFEST_TEMP"]), []);
    assert.deepEqual(planRollbackForCompleted([
      "WRITE_MANIFEST_TEMP",
      "WRITE_ANCHORS_TEMP",
      "RENAME_MEDIA",
    ]), ["RENAME_MEDIA"]);
    assert.deepEqual(planRollbackForCompleted([
      "WRITE_MANIFEST_TEMP",
      "WRITE_ANCHORS_TEMP",
      "RENAME_MEDIA",
      "RENAME_MANIFEST",
    ]), ["RENAME_MANIFEST", "RENAME_MEDIA"]);
  });

  it("cleanup uncertainty fails closed (never claim published)", () => {
    assert.equal(confirmTempCleanup([{ removed: true, stillPresent: false }]), "CONFIRMED");
    assert.equal(confirmTempCleanup([{ removed: true, stillPresent: true }]), "UNCONFIRMED");
    assert.equal(confirmTempCleanup([{ removed: false, stillPresent: false }]), "UNCONFIRMED");
    assert.equal(confirmTempCleanup([]), "CONFIRMED");
  });

  it("no duplicate retry publication after a failed transaction", async () => {
    const { options, files } = controllerOptions();
    files.stepFaults = { RENAME_MEDIA: true };
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const first = await controller.settleSuccessfulTake(started.take, healthyReadiness());
    assert.equal(first.published, false);
    const stepsAfterFirst = files.publishedSteps.length;
    const purgesAfterFirst = files.purged.length;
    // A second settlement over the same take is ignored: no new renames,
    // no new purges, no duplicate finals.
    const second = await controller.settleSuccessfulTake(started.take, healthyReadiness());
    assert.equal(second.published, false);
    assert.equal(files.publishedSteps.length, stepsAfterFirst);
    assert.equal(files.purged.length, purgesAfterFirst);
  });
});
