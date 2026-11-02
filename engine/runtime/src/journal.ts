// P8.5 Global Runtime Journal
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 16 & Section 28, and ADR-0013.
// Manages:
// 1. Monotonic global sequence numbering (global_seq = 1, 2, 3...)
// 2. Strict bounded storage (16 MiB session limit, 256 events/page, 256 KiB/page)
// 3. Normalized event ingestion conforming strictly to GlobalRuntimeEventSchema
// 4. Domain journal reference correlation without semantic payload duplication
// 5. Passive, read-only event snapshot pagination
// 6. Zero engine adapter invocation during replay
// Zero Electron, zero child_process, zero side effects.

import {
  type DomainJournalReference,
  type EngineFamily,
  type GlobalRuntimeEvent,
  type TerminalStatus,
  GlobalRuntimeEventSchema,
  MAX_JOURNAL_PAGE_BYTES,
  MAX_JOURNAL_PAGE_EVENTS,
  MAX_JOURNAL_SESSION_BYTES,
} from "./protocol.ts";
import { RuntimeError, sanitizeErrorMessage } from "./errors.ts";
import { type Clock, SystemMonotonicClock } from "./clock.ts";

// ---------------------------------------------------------------------------
// Journal Types & Draft Interfaces
// ---------------------------------------------------------------------------

export interface GlobalRuntimeEventDraft {
  readonly runtime_session_id?: string;
  readonly generation?: number;
  readonly lesson_id: string;
  readonly scene_id: string;
  readonly step_id: string;
  readonly kind: "narration" | "action" | "pause" | "lifecycle";
  readonly engine: EngineFamily;
  readonly event_type: string;
  readonly attempt_id: string;
  readonly domain_ref?: DomainJournalReference;
  readonly outcome?: TerminalStatus;
  readonly message?: string;
}

export interface JournalSnapshotPage {
  readonly events: readonly GlobalRuntimeEvent[];
  readonly high_seq: number;
  readonly has_more: boolean;
  readonly total_events: number;
  readonly total_bytes: number;
}

export interface JournalSnapshotOptions {
  readonly afterSeq?: number;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
}

export interface RuntimeJournalOptions {
  readonly sessionId: string;
  readonly generation?: number;
  readonly maxSessionBytes?: number;
  readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// RuntimeJournal Implementation
// ---------------------------------------------------------------------------

export class RuntimeJournal {
  private readonly sessionId: string;
  private readonly defaultGeneration: number;
  private readonly maxSessionBytes: number;
  private readonly clock: Clock;

  private nextSeq = 1;
  private totalBytes = 0;
  private sealed = false;
  private readonly events: GlobalRuntimeEvent[] = [];
  private readonly listeners: Set<(event: GlobalRuntimeEvent) => void> = new Set();

  constructor(options: RuntimeJournalOptions) {
    if (!options.sessionId) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: "RuntimeJournal requires a non-empty sessionId",
      });
    }
    this.sessionId = options.sessionId;
    this.defaultGeneration = options.generation ?? 1;
    this.maxSessionBytes = options.maxSessionBytes ?? MAX_JOURNAL_SESSION_BYTES;
    this.clock = options.clock ?? new SystemMonotonicClock();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getHighSeq(): number {
    return this.events.length > 0 ? this.events[this.events.length - 1].global_seq : 0;
  }

  getTotalBytes(): number {
    return this.totalBytes;
  }

  getEventCount(): number {
    return this.events.length;
  }

  isSealed(): boolean {
    return this.sealed;
  }

  /**
   * Commits a new runtime event to the global journal.
   * Assigns strictly monotonic global_seq (1, 2, 3...) and monotonic timestamp.
   * Enforces session byte budget and validates event schema.
   * Fails closed if session byte budget is exceeded or journal is sealed.
   */
  commit(draft: GlobalRuntimeEventDraft): GlobalRuntimeEvent {
    if (this.sealed) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: "Cannot commit event to sealed RuntimeJournal",
      });
    }

    const assignedSeq = this.nextSeq;
    const timestampMs = Math.round(this.clock.now());

    const candidate: GlobalRuntimeEvent = {
      global_seq: assignedSeq,
      timestamp_ms: timestampMs,
      runtime_session_id: draft.runtime_session_id ?? this.sessionId,
      generation: draft.generation ?? this.defaultGeneration,
      lesson_id: draft.lesson_id,
      scene_id: draft.scene_id,
      step_id: draft.step_id,
      kind: draft.kind,
      engine: draft.engine,
      event_type: draft.event_type,
      attempt_id: draft.attempt_id,
      domain_ref: draft.domain_ref,
      outcome: draft.outcome,
      message: draft.message !== undefined ? sanitizeErrorMessage(draft.message) : undefined,
    };

    // Schema validation fail-closed
    const parsedEvent = GlobalRuntimeEventSchema.parse(candidate);

    // Compute byte length of the canonical event
    const eventJson = JSON.stringify(parsedEvent);
    const eventBytes = Buffer.byteLength(eventJson, "utf8");

    // Session budget enforcement (16 MiB default)
    if (this.totalBytes + eventBytes > this.maxSessionBytes) {
      throw new RuntimeError({
        code: "CLEANUP_UNCONFIRMED",
        message: `Journal session byte budget exceeded: adding ${eventBytes} bytes would exceed limit of ${this.maxSessionBytes} bytes (current ${this.totalBytes})`,
        retry: "UNCERTAIN_DO_NOT_RETRY",
      });
    }

    // Monotonic counter advances strictly on successful accept
    this.nextSeq++;
    this.totalBytes += eventBytes;

    const frozenEvent = Object.freeze(parsedEvent);
    this.events.push(frozenEvent);

    // Synchronously notify registered event stream listeners
    for (const listener of this.listeners) {
      try {
        listener(frozenEvent);
      } catch {
        // Presentation listeners must not fail the journal commit
      }
    }

    return frozenEvent;
  }

  /**
   * Returns a bounded snapshot page of committed events.
   * Strictly read-only: does not mutate journal state, does not execute any engine.
   * Enforces canonical page bounds (default 256 events, max 256 KiB).
   */
  getSnapshotPage(options?: JournalSnapshotOptions): JournalSnapshotPage {
    const afterSeq = options?.afterSeq ?? 0;
    const maxEvents = Math.min(options?.maxEvents ?? MAX_JOURNAL_PAGE_EVENTS, MAX_JOURNAL_PAGE_EVENTS);
    const maxBytes = Math.min(options?.maxBytes ?? MAX_JOURNAL_PAGE_BYTES, MAX_JOURNAL_PAGE_BYTES);

    const pageEvents: GlobalRuntimeEvent[] = [];
    let accumulatedBytes = 0;
    let lastIncludedSeq = afterSeq;

    // Find the starting index using binary search or simple scan
    let startIndex = 0;
    if (afterSeq > 0) {
      // Find first event with global_seq > afterSeq
      const idx = this.events.findIndex((e) => e.global_seq > afterSeq);
      startIndex = idx === -1 ? this.events.length : idx;
    }

    for (let i = startIndex; i < this.events.length; i++) {
      if (pageEvents.length >= maxEvents) {
        break;
      }
      const event = this.events[i];
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");

      if (pageEvents.length > 0 && accumulatedBytes + eventBytes > maxBytes) {
        break;
      }

      pageEvents.push(event);
      accumulatedBytes += eventBytes;
      lastIncludedSeq = event.global_seq;
    }

    const hasMore = this.events.some((e) => e.global_seq > lastIncludedSeq);

    return Object.freeze({
      events: Object.freeze(pageEvents),
      high_seq: this.getHighSeq(),
      has_more: hasMore,
      total_events: this.events.length,
      total_bytes: this.totalBytes,
    });
  }

  /**
   * Retrieves a single event by its global sequence number.
   */
  getEvent(seq: number): GlobalRuntimeEvent | undefined {
    if (seq < 1 || seq > this.events.length) {
      return undefined;
    }
    // Direct index access since global_seq is contiguous 1..N
    const candidate = this.events[seq - 1];
    if (candidate && candidate.global_seq === seq) {
      return candidate;
    }
    return this.events.find((e) => e.global_seq === seq);
  }

  /**
   * Returns an immutable shallow array copy of all committed events.
   * Passive, read-only.
   */
  getAllEvents(): readonly GlobalRuntimeEvent[] {
    return Object.freeze([...this.events]);
  }

  /**
   * Subscribes to new events committed to this journal.
   * Returns an unsubscribe function.
   */
  onEvent(listener: (event: GlobalRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Seals the journal against future commits.
   */
  seal(): void {
    this.sealed = true;
  }
}
