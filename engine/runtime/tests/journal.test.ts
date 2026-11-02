// P8.5 Global Runtime Journal Tests
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 16 & Section 28, and ADR-0013.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeJournal } from "../src/journal.ts";
import { ManualLogicalClock } from "../src/clock.ts";
import {
  MAX_JOURNAL_PAGE_BYTES,
  MAX_JOURNAL_PAGE_EVENTS,
  type GlobalRuntimeEvent,
} from "../src/protocol.ts";
import { RuntimeError } from "../src/errors.ts";

describe("P8.5: Global Runtime Journal Core", () => {
  it("assigns strictly increasing monotonic global_seq starting from 1", () => {
    const clock = new ManualLogicalClock(1000);
    const journal = new RuntimeJournal({ sessionId: "sess-01", clock });

    assert.equal(journal.getHighSeq(), 0);
    assert.equal(journal.getEventCount(), 0);

    const e1 = journal.commit({
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B001",
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.started",
      attempt_id: "A001",
    });

    clock.advanceBy(100);

    const e2 = journal.commit({
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B001",
      kind: "action",
      engine: "editor",
      event_type: "runtime.step.started",
      attempt_id: "A001",
    });

    clock.advanceBy(50);

    const e3 = journal.commit({
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B001",
      kind: "action",
      engine: "editor",
      event_type: "runtime.step.completed",
      attempt_id: "A001",
      outcome: "COMPLETED",
      domain_ref: { engine: "editor", domain_seq: 1 },
    });

    assert.equal(e1.global_seq, 1);
    assert.equal(e1.timestamp_ms, 1000);

    assert.equal(e2.global_seq, 2);
    assert.equal(e2.timestamp_ms, 1100);

    assert.equal(e3.global_seq, 3);
    assert.equal(e3.timestamp_ms, 1150);

    assert.equal(journal.getHighSeq(), 3);
    assert.equal(journal.getEventCount(), 3);
    assert.ok(journal.getTotalBytes() > 0);
  });

  it("stores domain journal reference without semantic payload duplication", () => {
    const journal = new RuntimeJournal({ sessionId: "sess-01" });

    const event = journal.commit({
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B002",
      kind: "action",
      engine: "terminal",
      event_type: "runtime.step.completed",
      attempt_id: "A001",
      domain_ref: {
        engine: "terminal",
        domain_seq: 42,
      },
      outcome: "COMPLETED",
      message: "Command succeeded with exit code 0",
    });

    assert.deepEqual(event.domain_ref, {
      engine: "terminal",
      domain_seq: 42,
    });
    assert.equal(event.outcome, "COMPLETED");

    // Semantic payload absent: no command, selector, or code properties exist
    assert.equal((event as any).command, undefined);
    assert.equal((event as any).selector, undefined);
    assert.equal((event as any).code_text, undefined);
    assert.equal((event as any).url, undefined);
  });

  it("sanitizes error messages in committed events", () => {
    const journal = new RuntimeJournal({ sessionId: "sess-01" });

    const event = journal.commit({
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B003",
      kind: "action",
      engine: "editor",
      event_type: "runtime.step.failed",
      attempt_id: "A001",
      outcome: "FAILED",
      message: "Failed to open E:\\course-factory\\secret\\app.js\n    at Object.run (/repo/src/index.js:10:5)",
    });

    assert.ok(!event.message?.includes("E:\\course-factory"));
    assert.ok(!event.message?.includes("at Object.run"));
    assert.ok(event.message?.includes("[path]"));
  });

  it("bounded snapshot pagination enforces MAX_JOURNAL_PAGE_EVENTS (256)", () => {
    const journal = new RuntimeJournal({ sessionId: "sess-01" });

    // Commit 300 events
    for (let i = 1; i <= 300; i++) {
      journal.commit({
        lesson_id: "C01-L001",
        scene_id: "C01-L001-S001",
        step_id: "C01-L001-S001-B001",
        kind: "action",
        engine: "terminal",
        event_type: "runtime.step.started",
        attempt_id: "A001",
      });
    }

    assert.equal(journal.getHighSeq(), 300);

    // Page 1: afterSeq = 0
    const page1 = journal.getSnapshotPage({ afterSeq: 0 });
    assert.equal(page1.events.length, MAX_JOURNAL_PAGE_EVENTS);
    assert.equal(page1.events[0].global_seq, 1);
    assert.equal(page1.events[page1.events.length - 1].global_seq, 256);
    assert.equal(page1.has_more, true);
    assert.equal(page1.high_seq, 300);

    // Page 2: afterSeq = 256
    const page2 = journal.getSnapshotPage({ afterSeq: 256 });
    assert.equal(page2.events.length, 44); // 300 - 256 = 44
    assert.equal(page2.events[0].global_seq, 257);
    assert.equal(page2.events[page2.events.length - 1].global_seq, 300);
    assert.equal(page2.has_more, false);
  });

  it("bounded snapshot pagination enforces byte size limit", () => {
    const journal = new RuntimeJournal({ sessionId: "sess-01" });

    for (let i = 1; i <= 20; i++) {
      journal.commit({
        lesson_id: "C01-L001",
        scene_id: "C01-L001-S001",
        step_id: "C01-L001-S001-B001",
        kind: "action",
        engine: "editor",
        event_type: "runtime.step.completed",
        attempt_id: "A001",
        outcome: "COMPLETED",
        message: "Status message with padding to test byte paging ".repeat(5),
      });
    }

    // Request with small byte limit (e.g. 1000 bytes)
    const page = journal.getSnapshotPage({ afterSeq: 0, maxBytes: 1000 });
    assert.ok(page.events.length > 0);
    assert.ok(page.events.length < 20);
    assert.equal(page.has_more, true);
  });

  it("enforces session byte budget fail-closed", () => {
    // Budget capped at 1000 bytes for testing
    const journal = new RuntimeJournal({
      sessionId: "sess-budget-01",
      maxSessionBytes: 1000,
    });

    let commits = 0;
    assert.throws(
      () => {
        while (commits < 20) {
          journal.commit({
            lesson_id: "C01-L001",
            scene_id: "C01-L001-S001",
            step_id: "C01-L001-S001-B001",
            kind: "action",
            engine: "editor",
            event_type: "runtime.step.started",
            attempt_id: "A001",
            message: "Testing byte budget limit enforcement in journal",
          });
          commits++;
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "CLEANUP_UNCONFIRMED");
        assert.equal(err.retry, "UNCERTAIN_DO_NOT_RETRY");
        return true;
      },
    );

    assert.ok(commits > 0);
    assert.ok(journal.getTotalBytes() <= 1000);
  });

  it("passive replay is read-only and deterministic", () => {
    const journal = new RuntimeJournal({ sessionId: "sess-replay-01" });

    journal.commit({
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B001",
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.started",
      attempt_id: "A001",
    });

    journal.commit({
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B001",
      kind: "action",
      engine: "editor",
      event_type: "runtime.step.completed",
      attempt_id: "A001",
      outcome: "COMPLETED",
    });

    // Multiple snapshots produce identical results
    const page1 = journal.getSnapshotPage();
    const page2 = journal.getSnapshotPage();
    const all = journal.getAllEvents();

    assert.deepEqual(page1, page2);
    assert.equal(all.length, 2);
    assert.equal(journal.getEvent(1)?.global_seq, 1);
    assert.equal(journal.getEvent(2)?.global_seq, 2);
    assert.equal(journal.getEvent(999), undefined);
  });

  it("notifies registered event listeners synchronously", () => {
    const journal = new RuntimeJournal({ sessionId: "sess-listener-01" });
    const received: GlobalRuntimeEvent[] = [];

    const unsubscribe = journal.onEvent((e) => {
      received.push(e);
    });

    journal.commit({
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B001",
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.started",
      attempt_id: "A001",
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].global_seq, 1);

    unsubscribe();

    journal.commit({
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B001",
      kind: "action",
      engine: "browser",
      event_type: "runtime.step.started",
      attempt_id: "A001",
    });

    // No new event after unsubscribe
    assert.equal(received.length, 1);
  });

  it("rejects commits to sealed journal", () => {
    const journal = new RuntimeJournal({ sessionId: "sess-seal-01" });
    journal.seal();
    assert.equal(journal.isSealed(), true);

    assert.throws(
      () =>
        journal.commit({
          lesson_id: "C01-L001",
          scene_id: "C01-L001-S001",
          step_id: "C01-L001-S001-B001",
          kind: "lifecycle",
          engine: "orchestrator",
          event_type: "runtime.started",
          attempt_id: "A001",
        }),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal(err.code, "INVALID_REQUEST");
        return true;
      },
    );
  });
});
