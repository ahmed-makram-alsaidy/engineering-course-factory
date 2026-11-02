// P9.6 Disk Safety — preflight gate + runtime low-space abort.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Section 21 (Disk Safety).
// Covers the unit matrix DISK PREFLIGHT (1-8) and LOW SPACE (9-17):
// deterministic, zero sleeps, injected disk reader, no real disk fill.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BoundedDiskWatcher,
  evaluateVolumePreflight,
  estimateTakeFinalBytes,
  mustAbortTakeForDisk,
  requiredTakeFreeBytes,
  SAFETY_LOW_SPACE_BYTES,
  SAFETY_MAX_TAKE_S,
  SAFETY_PREFLIGHT_FLOOR_BYTES,
} from "../src/safety/disk-safety.ts";
import {
  CEILING_BYTES_PER_SECOND,
  DISK_POLL_INTERVAL_MS,
  LOW_SPACE_ABORT_BYTES,
  MAX_BILLABLE_LESSON_S,
  PREFLIGHT_ESTIMATE_MULTIPLIER,
  PREFLIGHT_MIN_FREE_BYTES,
} from "../src/disk-budget.ts";
import { MAX_TAKE_DURATION_S } from "../src/protocol.ts";
import { TakeSafetyController } from "../src/safety/controller.ts";
import {
  FakeDiskReader,
  GIB,
  ManualSafetyClock,
  ManualSafetyScheduler,
  controllerOptions,
  guardedInput,
} from "./safety-helpers.ts";

const TEN_MIN_S = 600;

describe("P9.6: disk preflight gate (canonical budget formula)", () => {
  it("enough space accepted for a ten-minute take", () => {
    const verdict = evaluateVolumePreflight({
      freeBytesOrNull: 20 * GIB,
      expectedLessonS: TEN_MIN_S,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, "SUFFICIENT");
  });

  it("below 2 GiB refused regardless of a tiny estimate", () => {
    const verdict = evaluateVolumePreflight({
      freeBytesOrNull: PREFLIGHT_MIN_FREE_BYTES - 1,
      expectedLessonS: 1,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "BELOW_FLOOR");
  });

  it("estimate-times-three dominates for a long take", () => {
    // 1800 s x 2.0 MB/s = 3.6 GB estimate; x3 = 10.8 GB required.
    const required = requiredTakeFreeBytes(1800);
    assert.equal(required, 1800 * 2_000_000 * 3);
    const verdict = evaluateVolumePreflight({
      freeBytesOrNull: required - 1,
      expectedLessonS: 1800,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "BELOW_ESTIMATE");
    const ok = evaluateVolumePreflight({
      freeBytesOrNull: required,
      expectedLessonS: 1800,
    });
    assert.equal(ok.ok, true);
  });

  it("2 GiB floor dominates for a short take", () => {
    // 60 s x 2.0 MB/s = 120 MB; x3 = 360 MB < 2 GiB floor.
    const required = requiredTakeFreeBytes(60);
    assert.equal(required, PREFLIGHT_MIN_FREE_BYTES);
    assert.equal(SAFETY_PREFLIGHT_FLOOR_BYTES, 2_147_483_648);
  });

  it("free-space query failure refused fail-closed (never assume safe)", () => {
    const verdict = evaluateVolumePreflight({
      freeBytesOrNull: null,
      expectedLessonS: TEN_MIN_S,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "QUERY_FAILED");
  });

  it("max duration estimate uses the 30-minute billable cap", () => {
    assert.equal(MAX_BILLABLE_LESSON_S, 1800);
    assert.equal(estimateTakeFinalBytes(1800), 1800 * CEILING_BYTES_PER_SECOND);
    // Beyond billable but within the take ceiling clamps to the cap.
    assert.equal(estimateTakeFinalBytes(1801), 1800 * CEILING_BYTES_PER_SECOND);
    assert.equal(estimateTakeFinalBytes(1802), 1800 * CEILING_BYTES_PER_SECOND);
  });

  it("duration beyond the take ceiling rejected, never estimated", () => {
    assert.equal(SAFETY_MAX_TAKE_S, 1802);
    assert.equal(MAX_TAKE_DURATION_S, 1802);
    assert.throws(() => estimateTakeFinalBytes(1803), /take ceiling/);
    const verdict = evaluateVolumePreflight({
      freeBytesOrNull: 100 * GIB,
      expectedLessonS: 7200,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "DURATION_REJECTED");
  });

  it("preflight formula is max(2 GiB, estimate x 3) with the frozen rate", () => {
    assert.equal(CEILING_BYTES_PER_SECOND, 2_000_000);
    assert.equal(PREFLIGHT_ESTIMATE_MULTIPLIER, 3);
    assert.equal(PREFLIGHT_MIN_FREE_BYTES, 2_147_483_648);
    assert.equal(requiredTakeFreeBytes(600), Math.max(2_147_483_648, 600 * 2_000_000 * 3));
  });
});

describe("P9.6: runtime low-space abort (1 GiB, before ENOSPC)", () => {
  it("runtime space healthy well above the threshold", () => {
    assert.equal(LOW_SPACE_ABORT_BYTES, 1_073_741_824);
    assert.equal(SAFETY_LOW_SPACE_BYTES, 1_073_741_824);
    assert.equal(mustAbortTakeForDisk(2 * GIB), false);
  });

  it("crossing the 1 GiB threshold aborts", () => {
    assert.equal(mustAbortTakeForDisk(LOW_SPACE_ABORT_BYTES - 1), true);
    assert.equal(mustAbortTakeForDisk(0), true);
  });

  it("uncertain disk reading aborts fail-closed", () => {
    assert.equal(mustAbortTakeForDisk(null), true);
    assert.equal(mustAbortTakeForDisk(-1), true);
    assert.equal(mustAbortTakeForDisk(Number.NaN), true);
  });

  it("low-space watcher latches once and stops scheduling", async () => {
    const disk = new FakeDiskReader(20 * GIB);
    const scheduler = new ManualSafetyScheduler();
    let events = 0;
    const watcher = new BoundedDiskWatcher({
      query: () => disk.query(),
      scheduler,
      events: { onLowSpace: () => { events += 1; } },
    });
    watcher.start();
    watcher.pollOnce();
    assert.equal(events, 0);
    assert.equal(watcher.isLatched, false);
    disk.freeBytesOrNull = LOW_SPACE_ABORT_BYTES - 1;
    watcher.pollOnce();
    assert.equal(events, 1);
    assert.equal(watcher.isLatched, true);
    // Repeated polls after the latch are idempotent: no second event.
    watcher.pollOnce();
    watcher.pollOnce();
    assert.equal(events, 1);
  });

  it("watcher stops its timer on latch (no exhaustion loop)", () => {
    const disk = new FakeDiskReader(LOW_SPACE_ABORT_BYTES - 1);
    const scheduler = new ManualSafetyScheduler();
    const watcher = new BoundedDiskWatcher({
      query: () => disk.query(),
      scheduler,
      events: { onLowSpace: () => undefined },
    });
    watcher.start();
    assert.equal(scheduler.pendingCount, 1);
    watcher.pollOnce();
    assert.equal(watcher.isLatched, true);
    assert.equal(scheduler.pendingCount, 0);
    assert.equal(watcher.isRunning, false);
  });

  it("query failure latches fail-closed with QUERY_FAILED", () => {
    const disk = new FakeDiskReader(20 * GIB);
    disk.throwOnQuery = true;
    const scheduler = new ManualSafetyScheduler();
    let reason: string | null = null;
    const watcher = new BoundedDiskWatcher({
      query: () => disk.query(),
      scheduler,
      events: { onLowSpace: (info) => { reason = info.reason; } },
    });
    watcher.pollOnce();
    assert.equal(watcher.isLatched, true);
    assert.equal(reason, "QUERY_FAILED");
  });

  it("guarded start refuses without touching the owner on low disk", async () => {
    const { options, owner, disk } = controllerOptions();
    disk.freeBytesOrNull = GIB - 1;
    const controller = new TakeSafetyController(options);
    const result = await controller.startGuardedTake(guardedInput());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "DISK_PREFLIGHT_FAILED");
      assert.equal(result.refusal, "BELOW_FLOOR");
    }
    assert.equal(owner.takeCounter, 0);
    assert.equal(owner.active, null);
  });

  it("guarded start refuses fail-closed on disk query failure", async () => {
    const { options, owner, disk } = controllerOptions();
    disk.throwOnQuery = true;
    const controller = new TakeSafetyController(options);
    const result = await controller.startGuardedTake(guardedInput());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "CLEANUP_UNCONFIRMED");
      assert.equal(result.refusal, "QUERY_FAILED");
    }
    assert.equal(owner.active, null);
  });

  it("low-space during an active take aborts INCOMPLETE with purge", async () => {
    const { options, owner, files, disk, scheduler } = controllerOptions();
    const controller = new TakeSafetyController(options);
    const started = await controller.startGuardedTake(guardedInput());
    assert.equal(started.ok, true);
    disk.freeBytesOrNull = LOW_SPACE_ABORT_BYTES - 1;
    // Drive the watcher through its scheduler (deterministic, no sleeps).
    scheduler.runAll();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    assert.equal(owner.active, null);
    assert.deepEqual(owner.abortCalls, ["LOW_DISK_ABORT"]);
    assert.equal(files.purged.length, 1);
    assert.equal(files.quarantined.length, 0);
    assert.equal(controller.terminal, "LOW_DISK_ABORT");
    assert.equal(controller.lowDiskLatched, true);
  });

  it("disk watcher uses the bounded 5 s cadence", () => {
    assert.equal(DISK_POLL_INTERVAL_MS, 5_000);
    const clock = new ManualSafetyClock();
    void clock;
    const scheduler = new ManualSafetyScheduler();
    const disk = new FakeDiskReader(20 * GIB);
    const watcher = new BoundedDiskWatcher({
      query: () => disk.query(),
      scheduler,
      events: { onLowSpace: () => undefined },
      pollMs: DISK_POLL_INTERVAL_MS,
    });
    watcher.start();
    assert.equal(scheduler.pendingCount, 1);
    watcher.stop();
    assert.equal(scheduler.pendingCount, 0);
  });
});
