// P5.6 replay synchronization (canonical task "Output/journal": design
// "Replay and display synchronization"): "Subscribe before snapshot; buffer
// arrivals, apply snapshot at snapshot_seq, then newer events. Ignore
// duplicates/replay gaps. Bounded pages and explicit snapshot-reset if cursor
// outside history."
//
// The feed is a pure main-side state machine over a bounded-page journal
// (SessionJournal.snapshot) plus a live subscription. Deterministic, no I/O,
// no timers, no UI knowledge (the xterm wiring is P5.12; this module is the
// ordered replay engine main/renderer code will sit on).
//
// Guarantees:
//   - the live subscription is established BEFORE the first snapshot fetch,
//     and arrivals during snapshot fetches are buffered (bounded) instead of
//     lost;
//   - events are delivered in strictly increasing journal-seq order, exactly
//     once: duplicates (seq <= applied) are ignored, never re-delivered;
//   - a replay gap (applied+1 missing) is reported through onGap and then
//     ignored (design: "Ignore duplicates/replay gaps") — a gap never blocks
//     newer events from being applied;
//   - a page with reset=true (cursor outside retained history) reports
//     onReset and re-anchors the cursor at the page's page_end_seq.

import type { Disposable } from "./providers/execution-provider.ts";
import type { RuntimeEvent, TerminalSnapshotPage } from "./protocol.ts";

export interface EventFeedGap {
  /** Expected seq (first missing) and the seq of the first event after the hole. */
  readonly from: number;
  readonly to: number;
}

export interface RuntimeEventFeedOptions {
  /** Bounded-page fetch from the authoritative journal (e.g. SessionJournal.snapshot). */
  readonly snapshot: (afterSeq: number) => TerminalSnapshotPage | Promise<TerminalSnapshotPage>;
  /** Live subscription to the authoritative journal. MUST be the same source the snapshot reads. */
  readonly subscribe: (listener: (event: RuntimeEvent) => void) => Disposable;
  /** Deliver a journal event exactly once, in strictly increasing seq order. */
  readonly onEvent: (event: RuntimeEvent) => void;
  /** Optional: a replay gap was detected (holes are ignored, never re-fetched silently). */
  readonly onGap?: (gap: EventFeedGap) => void;
  /** Optional: the cursor was outside retained history; the view must be reset. */
  readonly onReset?: (page: TerminalSnapshotPage) => void;
  /** Bounded arrivals buffer during snapshot fetches (default 1024). */
  readonly bufferLimit?: number;
}

export interface RuntimeEventFeed {
  /** Subscribe, then apply the snapshot; resolves after the initial replay. */
  start(): Promise<void>;
  /** Unsubscribe and drop the buffer. Idempotent. */
  stop(): void;
  /** Highest journal seq applied to the consumer so far. */
  readonly appliedSeq: number;
  /** True between start() and stop(). */
  readonly active: boolean;
}

export function createRuntimeEventFeed(options: RuntimeEventFeedOptions): RuntimeEventFeed {
  const bufferLimit = options.bufferLimit ?? 1024;
  let subscription: Disposable | null = null;
  let applied = 0;
  let active = false;
  let buffer: RuntimeEvent[] = [];
  let live = false;
  let overflowing = false;

  function deliver(event: RuntimeEvent): void {
    if (event.seq <= applied) return; // duplicate: ignore, never re-deliver
    if (event.seq > applied + 1) {
      options.onGap?.({ from: applied + 1, to: event.seq - 1 });
      // Design: gaps are ignored (not re-fetched silently); newer events apply.
    }
    applied = event.seq;
    options.onEvent(event);
  }

  function onArrival(event: RuntimeEvent): void {
    if (!active) return;
    if (live) {
      deliver(event);
      return;
    }
    if (buffer.length >= bufferLimit) {
      overflowing = true;
      return;
    }
    buffer.push(event);
  }

  function applyPage(page: TerminalSnapshotPage): void {
    if (page.reset) {
      options.onReset?.(page);
      // The cursor was outside retained history: re-anchor at the page's
      // high-water mark before applying the (possibly empty) page.
      if (page.page_end_seq > applied) applied = page.page_end_seq;
    }
    for (const event of page.events) deliver(event);
  }

  async function synchronize(): Promise<void> {
    // Subscribe BEFORE the snapshot fetch; buffer everything that arrives
    // while the page is being read.
    subscription = options.subscribe(onArrival);
    for (;;) {
      overflowing = false;
      const page = await options.snapshot(applied);
      applyPage(page);
      const arrivals = buffer;
      buffer = [];
      for (const event of arrivals) deliver(event);
      if (!overflowing) {
        live = true;
        return;
      }
      // The arrivals buffer overflowed while we synchronized: re-synchronize
      // from the applied cursor (bounded pages make this exact).
    }
  }

  return {
    async start(): Promise<void> {
      if (active) throw new Error("event feed already started");
      active = true;
      await synchronize();
    },
    stop(): void {
      if (subscription !== null) {
        subscription.dispose();
        subscription = null;
      }
      buffer = [];
      live = false;
      active = false;
    },
    get appliedSeq(): number {
      return applied;
    },
    get active(): boolean {
      return active;
    },
  };
}
