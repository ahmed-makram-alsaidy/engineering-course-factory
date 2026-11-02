// P5.6 replay synchronization — deterministic unit tests for the design's
// replay contract ("Subscribe before snapshot; buffer arrivals, apply snapshot
// at snapshot_seq, then newer events. Ignore duplicates/replay gaps. Bounded
// pages and explicit snapshot-reset if cursor outside history.").

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeEventFeed } from "../src/events.ts";
import type { Disposable } from "../src/providers/execution-provider.ts";
import type { RuntimeEvent, TerminalSnapshotPage } from "../src/protocol.ts";

// -- deterministic fake journal ----------------------------------------------

class FakeJournal {
  readonly recorded: RuntimeEvent[] = [];
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private seqCounter = 0;

  /** Synthesize a journal event; synchronously notifies live subscribers. */
  emit(type: RuntimeEvent["type"], payload: unknown = {}): RuntimeEvent {
    this.seqCounter += 1;
    const event = {
      runtime_event_version: 1,
      session_id: "sess-feed",
      generation: 1,
      seq: this.seqCounter,
      monotonic_ms: this.seqCounter * 10,
      operation_id: null,
      attempt_id: null,
      course_id: null,
      lesson_id: null,
      scene_id: null,
      beat_id: null,
      process_id: null,
      type,
      payload,
    } as RuntimeEvent;
    this.recorded.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: (event: RuntimeEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The journal's snapshot(afterSeq): a bounded, strictly ordered page. */
  snapshot(afterSeq: number, highOverride?: number): TerminalSnapshotPage {
    const high = highOverride ?? this.seqCounter;
    const events = this.recorded.filter((event) => event.seq > afterSeq).slice(0, 256);
    return {
      runtime_event_version: 1,
      session_id: "sess-feed",
      generation: 1,
      after_seq: afterSeq,
      page_end_seq: events.length > 0 ? events[events.length - 1]!.seq : high,
      journal_high_seq: high,
      reset: afterSeq > high,
      events,
    };
  }
}

function makeHarness(options: { bufferLimit?: number } = {}) {
  const journal = new FakeJournal();
  const delivered: RuntimeEvent[] = [];
  const gaps: Array<{ from: number; to: number }> = [];
  let resets = 0;
  let races: Array<() => void> = [];
  const feed = createRuntimeEventFeed({
    snapshot: (afterSeq: number) => {
      for (const race of races.splice(0)) race();
      return journal.snapshot(afterSeq);
    },
    subscribe: (listener) => journal.subscribe(listener),
    onEvent: (event) => delivered.push(event),
    onGap: (gap) => gaps.push(gap),
    onReset: () => {
      resets += 1;
    },
    ...(options.bufferLimit !== undefined ? { bufferLimit: options.bufferLimit } : {}),
  });
  return {
    journal,
    feed,
    delivered,
    gaps,
    get resets() {
      return resets;
    },
    raceDuringSnapshot(events: Array<() => void>): void {
      races = events;
    },
    start: () => feed.start(),
  };
}

describe("P5.6 replay feed: subscribe before snapshot", () => {
  it("buffers live arrivals that race the snapshot fetch and delivers each exactly once in seq order", async () => {
    const h = makeHarness();
    h.raceDuringSnapshot([
      () => h.journal.emit("runtime.closing", { cause: "lesson_end" }),
      () => h.journal.emit("runtime.closed", { cleanup_status: "confirmed" }),
    ]);
    await h.start();
    assert.deepEqual(h.delivered.map((e) => e.seq), [1, 2], "nothing lost, nothing duplicated");
    assert.equal(h.feed.appliedSeq, 2);
    assert.deepEqual(h.gaps, []);
    assert.equal(h.resets, 0);
  });

  it("delivers pre-snapshot journal content first, then newer arrivals; page/buffer overlap is de-duplicated", async () => {
    const h = makeHarness();
    h.journal.emit("runtime.closing", { cause: "lesson_end" }); // seq 1
    h.journal.emit("runtime.closed", { cleanup_status: "confirmed" }); // seq 2
    // Live arrivals during the fetch (buffered). The page is built AFTER the
    // race, so it also contains seq 3/4 — the buffered copies are duplicates.
    h.raceDuringSnapshot([
      () => h.journal.emit("runtime.failed", { code: "TIMEOUT", message: "live during fetch" }),
      () => h.journal.emit("runtime.closing", { cause: "app_close" }),
    ]);
    await h.start();
    assert.deepEqual(h.delivered.map((e) => e.seq), [1, 2, 3, 4], "exactly-once delivery in seq order (no duplicate 3/4)");
    assert.equal(h.feed.appliedSeq, 4);
  });

  it("reports replay gaps and still applies the newer events (gaps are ignored, never silently healed)", async () => {
    const journal = new FakeJournal();
    const delivered: RuntimeEvent[] = [];
    const gaps: Array<{ from: number; to: number }> = [];
    journal.emit("runtime.closing", { cause: "lesson_end" }); // seq 1
    journal.emit("runtime.closed", { cleanup_status: "confirmed" }); // seq 2 (lost)
    journal.emit("runtime.failed", { code: "CANCELLED", message: "also lost" }); // seq 3 (lost)
    const feed = createRuntimeEventFeed({
      // A page that deliberately omits the lost seq 2/3 while claiming high 3.
      snapshot: () => ({
        runtime_event_version: 1,
        session_id: "sess-feed",
        generation: 1,
        after_seq: 0,
        page_end_seq: 1,
        journal_high_seq: 3,
        reset: false,
        events: [journal.recorded[0]!],
      }),
      subscribe: (listener) => journal.subscribe(listener),
      onEvent: (event) => delivered.push(event),
      onGap: (gap) => gaps.push(gap),
    });
    await feed.start();
    journal.emit("runtime.closed", { cleanup_status: "unconfirmed" }); // seq 4
    assert.deepEqual(delivered.map((e) => e.seq), [1, 4], "the newer event is applied despite the hole");
    assert.deepEqual(gaps, [{ from: 2, to: 3 }], "the gap was reported, not silently healed");
  });

  it("reports an explicit snapshot-reset when the cursor is outside retained history", async () => {
    const journal = new FakeJournal();
    let resetSeen = false;
    const feed = createRuntimeEventFeed({
      // A stale future cursor (e.g. from a superseded generation): the page is
      // a reset page that re-anchors the consumer at page_end_seq.
      snapshot: (afterSeq) => ({
        runtime_event_version: 1,
        session_id: "sess-feed",
        generation: 1,
        after_seq: afterSeq,
        page_end_seq: 7,
        journal_high_seq: 7,
        reset: true,
        events: [],
      }),
      subscribe: (listener) => journal.subscribe(listener),
      onEvent: () => {},
      onReset: () => {
        resetSeen = true;
      },
    });
    await feed.start();
    assert.equal(resetSeen, true, "the reset was reported to the consumer");
    assert.equal(feed.appliedSeq, 7, "the cursor re-anchored at the page's page_end_seq");
  });

  it("re-synchronizes when the arrivals buffer overflows during a snapshot fetch", async () => {
    const h = makeHarness({ bufferLimit: 2 });
    const bursts: Array<() => void> = [];
    for (let i = 0; i < 5; i += 1) bursts.push(() => h.journal.emit("runtime.closing", { cause: "lesson_end" }));
    h.raceDuringSnapshot(bursts);
    await h.start();
    assert.deepEqual(h.delivered.map((e) => e.seq), [1, 2, 3, 4, 5], "the overflow triggered a re-snapshot that delivered everything exactly once");
    assert.deepEqual(h.gaps, [], "re-synchronization closes the hole instead of reporting a gap");
    assert.equal(h.feed.appliedSeq, 5);
  });

  it("stop() unsubscribes; later events are not delivered", async () => {
    const h = makeHarness();
    h.journal.emit("runtime.closing", { cause: "lesson_end" });
    await h.start();
    h.feed.stop();
    h.journal.emit("runtime.closed", { cleanup_status: "confirmed" });
    assert.equal(h.delivered.length, 1, "no delivery after stop");
    assert.equal(h.feed.active, false);
  });
});
