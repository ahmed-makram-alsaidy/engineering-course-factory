// P5.6 main runtime journal (canonical task "Output/journal": "events/journal/
// protocol/tests — UTF-8 streams/seq/replay/redaction/limits — PASS: bounded
// coherent trace, diagnostic separation").
//
// The journal is the TRUSTED MAIN-OWNED authoritative event record for ONE
// runtime session (session_id + generation). It is the only component that
// assigns the strictly increasing main-journal `seq` and the host receipt
// `monotonic_ms` (design: "Each event has session_id/generation, strictly
// increasing main-journal seq, monotonic_ms …"). Providers emit translated
// events WITHOUT those stamps; the journal validates, stamps, stores and
// re-emits immutable (frozen) events to its subscribers.
//
// Security / correctness properties (design-exact):
//   - Redaction BEFORE disk/IPC: registered secret literals (trusted machine
//     configuration or synthetic test secrets; renderer/lesson/grant input can
//     never register one) are removed from process.output text before the
//     event is stored, snapshotted or re-emitted. A raw duplicate is never
//     written anywhere. Chunk-spanning secrets are handled by a bounded raw
//     holdback (≤ maxSecretBytes-1 bytes) that is flushed before the process's
//     terminal event, so a secret split across consecutive output frames can
//     never leak its raw bytes through an earlier chunk.
//   - Coherent trace invariants: "Started precedes buffered output" (a
//     process.output event is rejected unless its process was started in this
//     journal); "One immutable final operation result" (a second
//     operation.completed for the same operation/attempt is rejected); the
//     runtime.* / operation.* provenance rules are enforced by the protocol
//     schema itself.
//   - Diagnostic separation: runtime.* session events (provider/Docker
//     diagnostics) carry null operation provenance by contract and are stored
//     as their own event types — they can never become lesson stderr or blend
//     into a process transcript.
//   - Identity fencing: only events of THIS journal's (session_id, generation)
//     are accepted; anything else rejects STALE_SESSION (old-generation output
//     can never enter a new session's journal).
//   - Bounds ("Limits: … 16 MiB journal/session … Reserve lifecycle/error
//     capacity"): output events are refused once the session budget minus the
//     lifecycle reserve would overflow (LOG_BACKPRESSURE); non-output
//     (lifecycle/error) events may use the full session budget; if even the
//     reserved capacity cannot fit an event the journal seals itself and every
//     later ingest is loudly rejected (no silent drops, no unbounded memory).
//     Per-process decoded output is belt-and-braces bounded at 1 MiB
//     (OUTPUT_LIMIT) exactly like the guest-side bound.
//   - Per-process transcripts and the global journal are kept separately;
//     stdout and stderr are never blended.
//
// Pure state: no I/O, no timers, no provider/Docker knowledge. The injected
// clock makes replay/bounds tests deterministic. stream_offset values remain
// RAW guest-stream byte offsets (monotonic per stream); a redacted span
// collapses bytes, so the next emission's offset advances by the removed raw
// byte count — offsets stay honest to the raw stream, never to the redacted
// text.

import {
  RUNTIME_EVENT_VERSION,
  ProviderEventSchema,
  RuntimeEventSchema,
  SNAPSHOT_PAGE_MAX_BYTES,
  SNAPSHOT_PAGE_MAX_EVENTS,
  TerminalSnapshotPageSchema,
  type Identifier,
  type OutputStream,
  type RuntimeEvent,
  type RuntimeEventType,
  type TerminalSnapshotPage,
} from "./protocol.ts";
import { JOURNAL_POLICY } from "./policy.ts";
import type { Disposable } from "./providers/execution-provider.ts";

// ---------------------------------------------------------------------------
// Rejection codes — every journal rejection is a canonical error code; a
// rejected event is NEVER silently dropped: the caller (trusted main) owns the
// mapped teardown/fail-closed behavior.
// ---------------------------------------------------------------------------

export type JournalRejectionCode =
  | "STALE_SESSION"
  | "INVALID_REQUEST"
  | "PROTOCOL_FAILED"
  | "OUTPUT_LIMIT"
  | "LOG_BACKPRESSURE";

export type JournalIngestResult =
  | { ok: true; event: RuntimeEvent | null }
  | { ok: false; code: JournalRejectionCode; message: string };

export interface SessionJournalStatus {
  readonly high_seq: number;
  readonly event_count: number;
  readonly journal_bytes: number;
  readonly sealed: { code: JournalRejectionCode; message: string } | null;
}

export interface ProcessTranscript {
  readonly process_id: Identifier | null;
  /** Per-stream text, exactly as redacted/stored — stdout and stderr are never blended. */
  readonly stdout: string;
  readonly stderr: string;
  /** Raw per-stream byte offsets of each stored chunk (monotonic per stream). */
  readonly stdout_offsets: readonly number[];
  readonly stderr_offsets: readonly number[];
}

const FOREGROUND_HOLD_KEY = "\u0000foreground";

/** Hold key for a process identity (the foreground operation's null process_id shares one reserved key). */
function holdKey(processId: Identifier | null): string {
  return processId === null ? FOREGROUND_HOLD_KEY : processId;
}

const SESSION_OUTPUT_TYPES: ReadonlySet<RuntimeEventType> = new Set<RuntimeEventType>(["process.output"]);
/** Terminal/lifecycle events that trigger the holdback flush for their process. */
const PROCESS_FLUSH_TYPES: ReadonlySet<RuntimeEventType> = new Set<RuntimeEventType>([
  "process.exited",
  "process.stopped",
  "process.failed",
]);

// ---------------------------------------------------------------------------
// Redaction — case-sensitive literal matching over the raw per-stream text.
// ---------------------------------------------------------------------------

type Span = { readonly start: number; readonly end: number };

/**
 * Longest-match-at-position, leftmost scan: at any offset the LONGEST
 * registered secret wins, so a secret that is a suffix-extension of another
 * can never leave its tail raw. Spans are non-overlapping (greedy).
 */
function findSecretSpans(text: string, secrets: readonly string[]): Span[] {
  const spans: Span[] = [];
  let i = 0;
  outer: while (i < text.length) {
    for (const secret of secrets) {
      if (text.startsWith(secret, i)) {
        spans.push({ start: i, end: i + secret.length });
        i += secret.length;
        continue outer;
      }
    }
    i += 1;
  }
  return spans;
}

function redactSpans(text: string, spans: readonly Span[]): string {
  if (spans.length === 0) return text;
  let out = text;
  for (let k = spans.length - 1; k >= 0; k -= 1) {
    const span = spans[k]!;
    out = out.slice(0, span.start) + JOURNAL_POLICY.redaction_marker + out.slice(span.end);
  }
  return out;
}

/** Per-(process, stream) raw holdback state. */
interface StreamHold {
  carry: string;
  /** Raw byte offset of carry's first byte within the raw guest stream. */
  carryOffset: number;
  hasCarry: boolean;
}

interface ProcessHold {
  readonly   process_id: Identifier;
  provenance: {
    operation_id: Identifier | null;
    attempt_id: Identifier | null;
    course_id: Identifier | null;
    lesson_id: Identifier | null;
    scene_id: Identifier | null;
    beat_id: Identifier | null;
  } | null;
  readonly streams: { stdout: StreamHold; stderr: StreamHold };
  raw_output_bytes: number;
}

function freshHold(): StreamHold {
  return { carry: "", carryOffset: 0, hasCarry: false };
}

// ---------------------------------------------------------------------------
// SessionJournal
// ---------------------------------------------------------------------------

export interface SessionJournalOptions {
  readonly session_id: Identifier;
  readonly generation: number;
  /** Injected monotonic host clock (defaults to Date.now); used for deterministic tests. */
  readonly nowMs?: () => number;
  /**
   * Trusted redaction secrets (machine configuration / synthetic test
   * secrets). NEVER renderer/lesson/IR/grant input: no such path exists.
   */
  readonly secrets?: readonly string[];
}

export class SessionJournal {
  readonly session_id: Identifier;
  readonly generation: number;

  private readonly events: RuntimeEvent[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly startedProcesses = new Set<string>();
  private readonly completedOperations = new Set<string>();
  private readonly processOutputBytes = new Map<string, number>();
  private readonly holds = new Map<string, ProcessHold>();
  private readonly secrets: readonly string[];
  private readonly maxSecretChars: number;
  private readonly nowMs: () => number;
  private journalBytes = 0;
  private highSeq = 0;
  private sealed: { code: JournalRejectionCode; message: string } | null = null;

  constructor(options: SessionJournalOptions) {
    this.session_id = options.session_id;
    this.generation = options.generation;
    this.nowMs = options.nowMs ?? Date.now;
    const seen = new Set<string>();
    const collected: string[] = [];
    for (const secret of options.secrets ?? []) {
      if (typeof secret !== "string" || secret.length === 0) {
        throw new Error("a registered redaction secret must be a non-empty string");
      }
      if (secret.length > JOURNAL_POLICY.secret_max_chars) {
        throw new Error(`a registered redaction secret exceeds the ${JOURNAL_POLICY.secret_max_chars}-char bound`);
      }
      if (secret === JOURNAL_POLICY.redaction_marker) {
        throw new Error("the redaction marker itself cannot be registered as a secret");
      }
      if (!seen.has(secret)) {
        seen.add(secret);
        collected.push(secret);
      }
    }
    // Longest first so the scan above can rely on "longest match at position".
    this.secrets = collected.sort((a, b) => b.length - a.length);
    this.maxSecretChars = this.secrets.reduce((max, secret) => Math.max(max, secret.length), 0);
  }

  // -- ingestion ------------------------------------------------------------

  /**
   * Ingest one provider-translated event (no seq/monotonic stamps yet).
   * Validates, redacts (before storage), stamps, stores, and notifies
   * subscribers — in that order, so subscribers and snapshots only ever see
   * redacted, stamped, immutable events.
   */
  ingest(providerEvent: unknown): JournalIngestResult {
    if (this.sealed !== null) {
      return { ok: false, code: this.sealed.code, message: `journal is sealed: ${this.sealed.message}` };
    }
    const shape = ProviderEventSchema.safeParse(providerEvent);
    if (!shape.success) {
      const issue = shape.error.issues[0];
      return {
        ok: false,
        code: "PROTOCOL_FAILED",
        message: `provider event failed runtime-protocol validation: ${issue?.message ?? "unknown issue"}`,
      };
    }
    const candidate = shape.data;
    if (candidate.session_id !== this.session_id || candidate.generation !== this.generation) {
      return {
        ok: false,
        code: "STALE_SESSION",
        message: `event identity (${candidate.session_id}#${candidate.generation}) does not match this journal (${this.session_id}#${this.generation})`,
      };
    }
    if (candidate.type === "process.output") {
      const payload = candidate.payload as { stream: OutputStream; text: string; stream_offset: number };
      if (payload.text.length === 0) {
        return { ok: false, code: "PROTOCOL_FAILED", message: "empty output chunk is not a coherent event" };
      }
      if (!this.startedProcesses.has(holdKey(candidate.process_id))) {
        // Design: "Started precedes buffered output." Output for a never-
        // started process is an incoherent trace, not a late frame.
        return {
          ok: false,
          code: "PROTOCOL_FAILED",
          message: `output for process '${String(candidate.process_id)}' arrived before its process.started event`,
        };
      }
      const priorBytes = this.processOutputBytes.get(holdKey(candidate.process_id)) ?? 0;
      const chunkBytes = Buffer.byteLength(payload.text, "utf8");
      if (priorBytes + chunkBytes > JOURNAL_POLICY.per_process_output_bytes) {
        return {
          ok: false,
          code: "OUTPUT_LIMIT",
          message: `process '${String(candidate.process_id)}' exceeded the ${JOURNAL_POLICY.per_process_output_bytes}-byte decoded output bound`,
        };
      }
    }
    if (candidate.type === "operation.completed") {
      const key = `${candidate.operation_id}\u0000${candidate.attempt_id}`;
      if (this.completedOperations.has(key)) {
        return {
          ok: false,
          code: "PROTOCOL_FAILED",
          message: `a final result for ${candidate.operation_id}/${candidate.attempt_id} was already recorded (one immutable result per operation)`,
        };
      }
    }

    // Redact BEFORE storage/IPC. Output chunks pass through the per-stream
    // raw holdback; the stored event carries the redacted emission.
    if (candidate.type === "process.output") {
      const payload = candidate.payload as { stream: OutputStream; text: string; stream_offset: number };
      const hold = this.holdFor(holdKey(candidate.process_id!), candidate);
      hold.raw_output_bytes += Buffer.byteLength(payload.text, "utf8");
      this.processOutputBytes.set(holdKey(candidate.process_id!), hold.raw_output_bytes);
      const pushed = this.pushThroughHold(hold.streams[payload.stream], payload.text, payload.stream_offset);
      if (pushed.status === "rejected") return pushed.rejection;
      if (pushed.emitted === null) {
        // Fully held back (bounded): nothing to store yet; the tail is flushed
        // before the process's terminal event. Nothing was dropped.
        return { ok: true, event: null };
      }
      const event = this.stampAndStore({
        ...candidate,
        payload: { stream: payload.stream, text: pushed.emitted.text, stream_offset: pushed.emitted.stream_offset },
      });
      if (!event.ok) return event;
      return { ok: true, event: event.event };
    }

    // Terminal/lifecycle events flush their process's held raw tail FIRST so
    // the transcript ends with the final (redacted) output before the death
    // fact; session-terminal events flush every hold. The foreground
    // operation's null event identity flushes its reserved hold key (P5.7:
    // held foreground output can never appear after its terminal event or
    // final result).
    if (PROCESS_FLUSH_TYPES.has(candidate.type)) {
      const flushError = this.flushProcess(holdKey(candidate.process_id));
      if (flushError !== null) return flushError;
    }
    if (candidate.type === "runtime.failed" || candidate.type === "runtime.closed") {
      const flushError = this.flushAllHolds();
      if (flushError !== null) return flushError;
    }

    if (candidate.type === "process.started") {
      if (candidate.process_id !== null) {
        this.startedProcesses.add(candidate.process_id);
        this.holdFor(holdKey(candidate.process_id), candidate);
      } else {
        // A new foreground run reuses the null-process hold key; flush any
        // residue from a previous (e.g. cancelled) run first.
        const flushError = this.flushProcess(FOREGROUND_HOLD_KEY);
        if (flushError !== null) return flushError;
        this.startedProcesses.add(FOREGROUND_HOLD_KEY);
        this.holdFor(FOREGROUND_HOLD_KEY, candidate);
      }
    }
    if (candidate.type === "operation.completed") {
      this.completedOperations.add(`${candidate.operation_id}\u0000${candidate.attempt_id}`);
    }

    const event = this.stampAndStore(candidate);
    if (!event.ok) return event;
    return { ok: true, event: event.event };
  }

  /** Subscribe to stamped, redacted, immutable journal events. */
  subscribe(listener: (event: RuntimeEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  // -- replay ----------------------------------------------------------------

  /** Bounded replay page after a cursor (design: "Snapshot 256 events/256 KiB"). */
  snapshot(afterSeq: number): TerminalSnapshotPage {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new TypeError("after_seq must be a non-negative integer");
    }
    const reset = afterSeq > this.highSeq;
    const page: RuntimeEvent[] = [];
    let pageBytes = 0;
    let pageEndSeq = reset ? this.highSeq : afterSeq;
    if (!reset) {
      for (const event of this.events) {
        if (event.seq <= afterSeq) continue;
        const size = Buffer.byteLength(JSON.stringify(event), "utf8");
        if (page.length > 0 && (page.length >= SNAPSHOT_PAGE_MAX_EVENTS || pageBytes + size > SNAPSHOT_PAGE_MAX_BYTES)) break;
        // The first event is always included (the page must make progress).
        page.push(event);
        pageBytes += size;
        pageEndSeq = event.seq;
        if (page.length >= SNAPSHOT_PAGE_MAX_EVENTS || pageBytes >= SNAPSHOT_PAGE_MAX_BYTES) break;
      }
    }
    return TerminalSnapshotPageSchema.parse({
      runtime_event_version: RUNTIME_EVENT_VERSION,
      session_id: this.session_id,
      generation: this.generation,
      after_seq: afterSeq,
      page_end_seq: pageEndSeq,
      journal_high_seq: this.highSeq,
      reset,
      events: page,
    });
  }

  /** Per-process transcript derived from stored events (per-stream, never blended). The foreground process is addressed by its null event identity. */
  transcript(processId: Identifier | null): ProcessTranscript {
    const queryKey = holdKey(processId);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutOffsets: number[] = [];
    const stderrOffsets: number[] = [];
    for (const event of this.events) {
      if (event.type !== "process.output" || holdKey(event.process_id) !== queryKey) continue;
      const payload = event.payload as { stream: OutputStream; text: string; stream_offset: number };
      if (payload.stream === "stdout") {
        stdout.push(payload.text);
        stdoutOffsets.push(payload.stream_offset);
      } else {
        stderr.push(payload.text);
        stderrOffsets.push(payload.stream_offset);
      }
    }
    return {
      process_id: processId,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      stdout_offsets: stdoutOffsets,
      stderr_offsets: stderrOffsets,
    };
  }

  status(): SessionJournalStatus {
    return {
      high_seq: this.highSeq,
      event_count: this.events.length,
      journal_bytes: this.journalBytes,
      sealed: this.sealed,
    };
  }

  /** Number of processes with unflushed holdback (diagnostics/tests). */
  pendingHolds(): number {
    let count = 0;
    for (const hold of this.holds.values()) {
      if (hold.streams.stdout.hasCarry || hold.streams.stderr.hasCarry) count += 1;
    }
    return count;
  }

  // -- internals -------------------------------------------------------------

  private holdFor(processId: string, candidate: { operation_id: Identifier | null; attempt_id: Identifier | null; course_id: Identifier | null; lesson_id: Identifier | null; scene_id: Identifier | null; beat_id: Identifier | null }): ProcessHold {
    const key = processId;
    let hold = this.holds.get(key);
    if (hold === undefined) {
      hold = {
        process_id: key,
        provenance: null,
        streams: { stdout: freshHold(), stderr: freshHold() },
        raw_output_bytes: 0,
      };
      this.holds.set(key, hold);
    }
    if (hold.provenance === null) {
      hold.provenance = {
        operation_id: candidate.operation_id,
        attempt_id: candidate.attempt_id,
        course_id: candidate.course_id,
        lesson_id: candidate.lesson_id,
        scene_id: candidate.scene_id,
        beat_id: candidate.beat_id,
      };
    }
    return hold;
  }

  /**
   * Push a raw chunk through the holdback and redaction. Emits at most one
   * redacted chunk; returns a rejection when the emission would break the
   * journal's output budget (LOG_BACKPRESSURE), else the emission (null when
   * everything was held back).
   */
  private pushThroughHold(
    streamHold: StreamHold,
    text: string,
    streamOffset: number,
  ): { status: "ok"; emitted: { text: string; stream_offset: number } | null } | { status: "rejected"; rejection: Extract<JournalIngestResult, { ok: false }> } {
    if (this.secrets.length === 0) {
      const rejection = this.budgetRejectOrEmit(text, streamOffset);
      if (rejection !== null) return { status: "rejected", rejection };
      return { status: "ok", emitted: { text, stream_offset: streamOffset } };
    }
    const combined = streamHold.hasCarry ? streamHold.carry + text : text;
    const combinedOffset = streamHold.hasCarry ? streamHold.carryOffset : streamOffset;
    // Streaming-match rule: emit everything EXCEPT the longest suffix of the
    // combined raw text that is a PROPER prefix of some registered secret.
    // That suffix is exactly the material a future chunk could complete into
    // an occurrence, so a chunk-spanning secret can never leak its raw bytes
    // through an earlier emission — and ordinary output without any partial
    // match is never delayed.
    let hold = 0;
    const maxHold = Math.min(combined.length, this.maxSecretChars - 1);
    for (let k = maxHold; k >= 1; k -= 1) {
      const suffix = combined.slice(combined.length - k);
      if (this.secrets.some((secret) => secret.startsWith(suffix))) {
        hold = k;
        break;
      }
    }
    const emitIdx = combined.length - hold;
    // An occurrence crossing the emission boundary must not be split raw:
    // move the boundary back to its start (fixpoint over all matches).
    const spans = findSecretSpans(combined, this.secrets);
    let effective = emitIdx;
    for (;;) {
      const crossing = spans.find((span) => span.start < effective && span.end > effective);
      if (crossing === undefined) break;
      effective = crossing.start;
    }
    const emittedRaw = combined.slice(0, effective);
    const within = spans.filter((span) => span.start < effective && span.end <= effective);
    const emittedText = within.length > 0 ? redactSpans(emittedRaw, within) : emittedRaw;
    if (emittedText.length > 0) {
      const rejection = this.budgetRejectOrEmit(emittedText, combinedOffset);
      if (rejection !== null) return { status: "rejected", rejection };
    }
    const consumedBytes = Buffer.byteLength(emittedRaw, "utf8");
    const rest = combined.slice(effective);
    if (rest.length > 0) {
      streamHold.carry = rest;
      streamHold.carryOffset = combinedOffset + consumedBytes;
      streamHold.hasCarry = true;
    } else {
      streamHold.carry = "";
      streamHold.hasCarry = false;
    }
    return { status: "ok", emitted: emittedText.length > 0 ? { text: emittedText, stream_offset: combinedOffset } : null };
  }

  private budgetRejectOrEmit(
    text: string,
    streamOffset: number,
  ): Extract<JournalIngestResult, { ok: false }> | null {
    if (text.length === 0) return null;
    // Bounded pre-flight: the emission is stored through stampAndStore, whose
    // budget check is authoritative; this early check keeps output inside the
    // reserved budget BEFORE the hold machinery produces the event.
    const projected = this.journalBytes + 1024 + Buffer.byteLength(text, "utf8");
    if (projected > JOURNAL_POLICY.session_limit_bytes - JOURNAL_POLICY.lifecycle_reserve_bytes) {
      return {
        ok: false,
        code: "LOG_BACKPRESSURE",
        message: "journal output budget exhausted (lifecycle/error reserve protected)",
      };
    }
    return null;
  }

  /** Flush one process's held raw tail as redacted output events (before its death fact). */
  private flushProcess(processId: string): Extract<JournalIngestResult, { ok: false }> | null {
    const hold = this.holds.get(processId);
    if (hold === undefined) return null;
    const provenance = hold.provenance;
    if (provenance === null) return null;
    for (const stream of ["stdout", "stderr"] as const) {
      const streamHold = hold.streams[stream];
      if (!streamHold.hasCarry || streamHold.carry.length === 0) continue;
      const text = redactSpans(streamHold.carry, findSecretSpans(streamHold.carry, this.secrets));
      const offset = streamHold.carryOffset;
      streamHold.carry = "";
      streamHold.hasCarry = false;
      if (text.length === 0) continue;
      const event = this.stampAndStore({
        runtime_event_version: RUNTIME_EVENT_VERSION,
        session_id: this.session_id,
        generation: this.generation,
        operation_id: provenance.operation_id,
        attempt_id: provenance.attempt_id,
        course_id: provenance.course_id,
        lesson_id: provenance.lesson_id,
        scene_id: provenance.scene_id,
        beat_id: provenance.beat_id,
        process_id: processId === FOREGROUND_HOLD_KEY ? null : processId,
        type: "process.output",
        payload: { stream, text, stream_offset: offset },
      });
      if (!event.ok) return event;
    }
    return null;
  }

  private flushAllHolds(): Extract<JournalIngestResult, { ok: false }> | null {
    for (const processId of [...this.holds.keys()]) {
      const rejection = this.flushProcess(processId);
      if (rejection !== null) return rejection;
    }
    return null;
  }

  /** Stamp, validate as a full runtime event, bound-check, store, freeze, notify. */
  private stampAndStore(candidate: Omit<RuntimeEvent, "seq" | "monotonic_ms">): Extract<JournalIngestResult, { ok: true }> | { ok: false; code: JournalRejectionCode; message: string } {
    const stamped = {
      ...candidate,
      seq: this.highSeq + 1,
      monotonic_ms: this.nowMs(),
    };
    // Full canonical validation (payload schema per type + provenance) — the
    // single authority; the stamped event is only stored when it parses.
    const checked = RuntimeEventSchema.safeParse(stamped);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      return { ok: false, code: "PROTOCOL_FAILED", message: `stamped event failed validation: ${issue?.message ?? "unknown issue"}` };
    }
    const event = checked.data;
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    const isOutputEvent = event.type === "process.output";
    const limit = isOutputEvent
      ? JOURNAL_POLICY.session_limit_bytes - JOURNAL_POLICY.lifecycle_reserve_bytes
      : JOURNAL_POLICY.session_limit_bytes;
    if (this.journalBytes + size > limit) {
      if (!isOutputEvent) {
        // Even the reserved lifecycle/error capacity cannot fit this event:
        // seal the journal (every later ingest is loudly rejected).
        this.sealed = { code: "LOG_BACKPRESSURE", message: "journal session bound exhausted" };
      }
      return { ok: false, code: "LOG_BACKPRESSURE", message: isOutputEvent ? "journal output budget exhausted" : "journal session bound exhausted" };
    }
    this.highSeq = event.seq;
    this.journalBytes += size;
    this.events.push(event);
    const frozen = deepFreeze(event);
    for (const listener of this.listeners) {
      try { listener(frozen); } catch { /* a misbehaving subscriber must never break the journal */ }
    }
    return { ok: true, event: frozen };
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
