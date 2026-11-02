// P5.10 process-output waits (canonical task "Output waits": "output-wait/
// tests — Early/spanning per-stream/abort/deadline/exit — PASS: No lost
// markers/TCP workflow").
//
// Internal admitted observation primitive (design "Process-output waits /
// readiness"): `waitForProcessOutput(admittedWait, abortSignal)` observes the
// emitted text of ONE background process for a trusted literal readiness
// marker. It is NOT renderer-facing: there is no renderer predicate/text
// field anywhere — the literal, the target and the deadline come exclusively
// from the trusted WaitAdmission (admission.ts), which itself derives only
// from the canonical validated CompiledLesson IR. Full wait scheduling/UI
// execution stays P8; this module is the observation primitive P5 tests
// exercise.
//
// Canonical semantics (design-exact):
//   - Pre-index literal case-sensitive strings (max 4096 chars, WAIT_POLICY);
//     the literal is indexed once at waiter creation, never per chunk.
//   - Register at background spawn so early READY isn't lost: the waiter
//     subscribes BEFORE reading history, buffers arrivals during the history
//     check, then drains — the same subscribe-before-snapshot discipline as
//     the P5.6 replay feed. Already-journaled output is checked first, so a
//     marker printed between spawn and waiter creation is still observed.
//   - Match each stdout/stderr independently, never concatenating a
//     half-marker from each stream; either stream can satisfy the wait.
//   - Incremental ANSI/OSC stripping + CRLF normalization over the decoded
//     text, chunk-spanning detection, and the match sequence/stream retained
//     in the result. This observes emitted text, not the final rendered
//     screen (no xterm/viewport concepts).
//   - Already matched on a live process resolves immediately; an already-dead
//     target rejects PROCESS_EXITED at creation (dead wins even when history
//     holds the marker — readiness of a dead process is meaningless; a death
//     AFTER a successful observation is the lifetime's separate failure, not
//     this waiter's claim).
//   - Match/deadline/abort/exit settle exactly once and remove all listeners
//     (unsubscribe, clear the deadline timer, detach the abort listener).
//   - No TCP workflow: this module contains no socket, fetch, port probe or
//     network import; duration/port waits stay UNSUPPORTED_PHASE at admission.
//
// Journal integration: the waiter READS journaled RuntimeEvents (seq-ordered,
// redacted, immutable) and never writes. Every runtime event it observes has
// already flowed through SessionJournal (one authoritative seq stream,
// monotonic ordering, pre-storage redaction, bounded memory). The retained
// match seq is the journal seq of the completing output event.
//
// Pure observation: no I/O, no timers of its own (injected), no
// child_process/Docker/network, no provider mutation. Deterministic with fake
// timers/subscriptions; real Docker integration wires provider events through
// a SessionJournal into this primitive.

import { WaitAdmissionSchema, type WaitAdmission } from "./admission.ts";
import {
  type Disposable,
} from "./providers/execution-provider.ts";
import {
  type OutputStream,
  type RuntimeEvent,
  type RuntimeErrorCode,
} from "./protocol.ts";
import { WAIT_POLICY } from "./policy.ts";

// ---------------------------------------------------------------------------
// Result / error shapes
// ---------------------------------------------------------------------------

/** Successful observation: the trusted literal was emitted on one stream. */
export interface WaitMatch {
  readonly process_id: string;
  readonly stream: OutputStream;
  /** Journal seq of the completing output event (authoritative ordering). */
  readonly seq: number;
  readonly operation_id: string;
  readonly attempt_id: string;
}

/** Waiter settlement failure: a canonical reject/fail/skipped code, never a native stack. */
export class OutputWaitError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "OutputWaitError";
    this.code = code;
  }
}

/** Injected timers (real setTimeout/clearTimeout in production; fake in tests). */
export interface OutputWaitTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: OutputWaitTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Observation dependencies (all injected; nothing global, nothing renderer-facing). */
export interface OutputWaitOptions {
  /**
   * Live subscription to the authoritative journal (must be the same journal
   * getHistory reads). Established BEFORE the history check so no marker is
   * lost between spawn and waiter creation.
   */
  readonly subscribe: (listener: (event: RuntimeEvent) => void) => Disposable;
  /** Already-journaled events in seq order (e.g. journal.snapshot(0).events). */
  readonly getHistory: () => readonly RuntimeEvent[];
  /** Current liveness of the target process (registry/journal truth at creation). */
  readonly isLive: () => boolean;
  /** Operator cancellation (AbortSignal); abort settles CANCELLED. */
  readonly signal?: AbortSignal | null;
  readonly timers?: OutputWaitTimers;
}

// ---------------------------------------------------------------------------
// Output normalization: incremental ANSI/OSC stripping + CRLF normalization
// ---------------------------------------------------------------------------

const ESC = "\u001b";
const BEL = "\u0007";

/**
 * Normalize an authored readiness literal the same way output is normalized
 * for CRLF (CRLF/CR -> LF). The literal itself is never ANSI-stripped: it is
 * matched against stripped output as-is (authored READY carries no escapes).
 */
export function normalizeWaitLiteral(literal: string): string {
  return literal.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Per-stream incremental decoding state (ANSI carry + CR carry + search tail). */
interface StreamState {
  /** Incomplete ANSI escape held from the previous chunk (raw). */
  ansiCarry: string;
  /** Previous stripped chunk ended with a held CR (possible split CRLF). */
  pendingCR: boolean;
  /** Normalized tail retained for chunk-spanning search (<= marker.length - 1). */
  tail: string;
}

function freshStreamState(): StreamState {
  return { ansiCarry: "", pendingCR: false, tail: "" };
}

/**
 * Strip ANSI escapes incrementally. Handles CSI (ESC [ ... final), OSC
 * (ESC ] ... BEL/ESC \), and generic ESC sequences; an escape split across
 * chunks is held in `carry` and never emitted as text. Returns the stripped
 * text plus the new carry.
 */
function stripAnsiIncremental(input: string, carry: string): { text: string; carry: string } {
  const raw = carry + input;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch !== ESC) {
      out += ch;
      i += 1;
      continue;
    }
    // ESC at end with no following char: incomplete, hold for next chunk.
    if (i + 1 >= raw.length) {
      return { text: out, carry: raw.slice(i) };
    }
    const next = raw[i + 1]!;
    // OSC: ESC ] ... (BEL | ESC \)
    if (next === "]") {
      let j = i + 2;
      let closed = false;
      while (j < raw.length) {
        if (raw[j] === BEL) {
          j += 1;
          closed = true;
          break;
        }
        if (raw[j] === ESC && j + 1 < raw.length && raw[j + 1] === "\\") {
          j += 2;
          closed = true;
          break;
        }
        // ESC at the very end without its backslash: incomplete OSC.
        if (raw[j] === ESC && j + 1 >= raw.length) {
          break;
        }
        j += 1;
      }
      if (!closed) {
        return { text: out, carry: raw.slice(i) };
      }
      i = j;
      continue;
    }
    // CSI: ESC [ params intermediates final(0x40-0x7E)
    if (next === "[") {
      let j = i + 2;
      // Params 0x30-0x3F
      while (j < raw.length) {
        const code = raw.charCodeAt(j);
        if (code >= 0x30 && code <= 0x3f) j += 1;
        else break;
      }
      // Intermediates 0x20-0x2F
      while (j < raw.length) {
        const code = raw.charCodeAt(j);
        if (code >= 0x20 && code <= 0x2f) j += 1;
        else break;
      }
      if (j >= raw.length) {
        return { text: out, carry: raw.slice(i) };
      }
      const finalCode = raw.charCodeAt(j);
      if (finalCode >= 0x40 && finalCode <= 0x7e) {
        i = j + 1;
        continue;
      }
      // ESC [ followed by a non-sequence char: treat ESC [ as consumed escape
      // prefix is wrong; instead emit nothing for the ESC and re-scan. The
      // conservative choice (fail-safe for matching) is to drop the bare ESC
      // and continue after it — a bare ESC can never be part of a readiness
      // literal (literals cannot contain ESC: IR text is printable, and NUL
      // is rejected; ESC in output is control, not content).
      i += 1;
      continue;
    }
    // Generic ESC sequence: ESC + optional intermediates (0x20-0x2F) + final (0x30-0x7E).
    let j = i + 1;
    while (j < raw.length) {
      const code = raw.charCodeAt(j);
      if (code >= 0x20 && code <= 0x2f) j += 1;
      else break;
    }
    if (j >= raw.length) {
      return { text: out, carry: raw.slice(i) };
    }
    const finalCode = raw.charCodeAt(j);
    if (finalCode >= 0x30 && finalCode <= 0x7e) {
      i = j + 1;
      continue;
    }
    // Non-sequence byte after ESC: drop the bare ESC, keep scanning.
    i += 1;
  }
  return { text: out, carry: "" };
}

/**
 * Normalize CRLF incrementally over stripped text. `pendingCR` holds a
 * trailing CR from the previous chunk (a split CRLF's first half). Returns
 * the normalized text plus the new pendingCR.
 */
function normalizeCrlfIncremental(input: string, pendingCR: boolean): { text: string; pendingCR: boolean } {
  let prefix = "";
  let work = input;
  if (pendingCR) {
    // The held CR becomes one LF; a leading LF completes a split CRLF pair.
    prefix = "\n";
    if (work.startsWith("\n")) work = work.slice(1);
    pendingCR = false;
  }
  let trailing = false;
  if (work.endsWith("\r")) {
    work = work.slice(0, -1);
    trailing = true;
  }
  const normalized = work.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return { text: prefix + normalized, pendingCR: trailing };
}

/**
 * Feed one raw output chunk through the stream's incremental pipeline and
 * test for the marker. Updates the stream state (carry/pendingCR/tail).
 * Returns the normalized new text (for debugging) and whether the marker
 * completes in (tail + normalized).
 */
function feedChunk(state: StreamState, rawText: string, marker: string): { matched: boolean; normalized: string } {
  const stripped = stripAnsiIncremental(rawText, state.ansiCarry);
  state.ansiCarry = stripped.carry;
  const crlf = normalizeCrlfIncremental(stripped.text, state.pendingCR);
  state.pendingCR = crlf.pendingCR;
  const searchText = state.tail + crlf.text;
  const matched = marker.length > 0 && searchText.includes(marker);
  if (!matched) {
    state.tail = marker.length <= 1 ? "" : searchText.slice(Math.max(0, searchText.length - (marker.length - 1)));
  }
  return { matched, normalized: crlf.text };
}

/** Flush a held trailing CR as one LF at stream end (lone CR is a newline). */
function flushStream(state: StreamState, marker: string): boolean {
  if (!state.pendingCR) return false;
  state.pendingCR = false;
  const searchText = state.tail + "\n";
  return marker.length > 0 && searchText.includes(marker);
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

/** Terminal event kinds that end a wait with PROCESS_EXITED (no marker can arrive). */
function isTargetTerminal(event: RuntimeEvent, targetProcessId: string): boolean {
  if (event.process_id === targetProcessId) {
    switch (event.type) {
      case "process.exited":
      case "process.stopped":
      case "process.failed":
      case "operation.completed":
        return true;
      default:
        break;
    }
  }
  // Session-terminal events end every wait in the session.
  if (event.type === "runtime.closing" || event.type === "runtime.closed" || event.type === "runtime.failed") {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The primitive
// ---------------------------------------------------------------------------

/**
 * Observe one background process's emitted text for the trusted readiness
 * literal. Resolves with the match (stream + journal seq) or rejects with a
 * canonical OutputWaitError (PROCESS_EXITED / TIMEOUT / CANCELLED /
 * INVALID_REQUEST). Settles exactly once and removes every listener.
 *
 * Callers MUST create the waiter at (or immediately after) background spawn:
 * the waiter subscribes before reading history, so early output is never
 * lost. Later death of the process after a successful match is the
 * lifetime's separate failure (BACKGROUND_EXITED_EARLY etc.), never a
 * revision of this waiter's result.
 */
export function waitForProcessOutput(wait: WaitAdmission, options: OutputWaitOptions): Promise<WaitMatch> {
  const timers = options.timers ?? REAL_TIMERS;
  return new Promise<WaitMatch>((resolve, reject) => {
    // -- trusted admission check (defense-in-depth; admission is authoritative) --
    const checked = WaitAdmissionSchema.safeParse(wait);
    if (!checked.success) {
      reject(new OutputWaitError("INVALID_REQUEST", "wait admission failed strict validation"));
      return;
    }
    const admitted = checked.data;
    if (admitted.text.includes("\0")) {
      reject(new OutputWaitError("INVALID_REQUEST", "readiness literal contains NUL"));
      return;
    }
    if (admitted.text.length > WAIT_POLICY.max_text_chars) {
      reject(new OutputWaitError("INVALID_REQUEST", `readiness text exceeds the ${WAIT_POLICY.max_text_chars}-char bound`));
      return;
    }
    if (admitted.timeout_ms <= 0 || admitted.timeout_ms > WAIT_POLICY.max_timeout_ms) {
      reject(new OutputWaitError("INVALID_REQUEST", "wait deadline is outside the admitted bound"));
      return;
    }
    const marker = normalizeWaitLiteral(admitted.text);
    if (marker.length === 0) {
      reject(new OutputWaitError("INVALID_REQUEST", "readiness literal is empty after normalization"));
      return;
    }
    const target = admitted.target.process_id;

    const states: Record<OutputStream, StreamState> = {
      stdout: freshStreamState(),
      stderr: freshStreamState(),
    };

    let settled = false;
    let subscription: Disposable | null = null;
    let timer: unknown = null;
    const buffered: RuntimeEvent[] = [];
    let historyDone = false;

    const cleanup = (): void => {
      if (subscription !== null) {
        subscription.dispose();
        subscription = null;
      }
      if (timer !== null) {
        timers.clear(timer);
        timer = null;
      }
      options.signal?.removeEventListener?.("abort", onAbort);
    };

    const settleMatch = (stream: OutputStream, seq: number): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        process_id: target,
        stream,
        seq,
        operation_id: admitted.operation_id,
        attempt_id: admitted.attempt_id,
      });
    };

    const settleError = (code: RuntimeErrorCode, message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new OutputWaitError(code, message));
    };

    const onAbort = (): void => {
      settleError("CANCELLED", `wait for '${target}' was aborted`);
    };

    const onTimeout = (): void => {
      timer = null;
      settleError("TIMEOUT", `wait for '${target}' exceeded its ${admitted.timeout_ms} ms deadline`);
    };

    /** Feed one journaled output event through its stream matcher. */
    const feedOutputEvent = (event: RuntimeEvent): boolean => {
      if (event.type !== "process.output") return false;
      if (event.process_id !== target) return false;
      if (event.session_id !== admitted.session_id || event.generation !== admitted.generation) return false;
      const payload = event.payload as { stream: OutputStream; text: string; stream_offset: number };
      if (payload.stream !== "stdout" && payload.stream !== "stderr") return false;
      const fed = feedChunk(states[payload.stream], payload.text, marker);
      return fed.matched;
    };

    /** Live arrival handler (after history is drained, processes directly). */
    const onLiveEvent = (event: RuntimeEvent): void => {
      if (settled) return;
      if (!historyDone) {
        buffered.push(event);
        return;
      }
      if (event.type === "process.output") {
        if (feedOutputEvent(event)) {
          settleMatch((event.payload as { stream: OutputStream }).stream, event.seq);
        }
        return;
      }
      if (isTargetTerminal(event, target)) {
        // Flush a held split-CRLF tail once: output ordered before the
        // terminal event still counts (causal output -> terminal ordering).
        for (const stream of ["stdout", "stderr"] as const) {
          if (flushStream(states[stream], marker)) {
            settleMatch(stream, event.seq);
            return;
          }
        }
        settleError("PROCESS_EXITED", `process '${target}' ended before its readiness marker was observed`);
      }
    };

    // -- abort wiring (before any async work) --
    if (options.signal?.aborted === true) {
      reject(new OutputWaitError("CANCELLED", `wait for '${target}' was aborted`));
      return;
    }
    options.signal?.addEventListener?.("abort", onAbort, { once: true });

    // -- subscribe BEFORE history (no lost markers) --
    try {
      subscription = options.subscribe(onLiveEvent);
    } catch (error) {
      options.signal?.removeEventListener?.("abort", onAbort);
      reject(new OutputWaitError("INVALID_REQUEST", `wait subscription failed: ${error instanceof Error ? error.message : "unknown"}`));
      return;
    }

    // -- already dead wins over history (spec: "already dead -> PROCESS_EXITED") --
    let live: boolean;
    try {
      live = options.isLive();
    } catch {
      live = false;
    }
    if (!live) {
      settleError("PROCESS_EXITED", `process '${target}' is already dead`);
      return;
    }

    // -- history check (seq order; per-stream independent, chunk-spanning) --
    let history: readonly RuntimeEvent[];
    try {
      history = options.getHistory();
    } catch (error) {
      settleError("INVALID_REQUEST", `wait history unavailable: ${error instanceof Error ? error.message : "unknown"}`);
      return;
    }
    const ordered = [...history].sort((a, b) => a.seq - b.seq);
    for (const event of ordered) {
      if (settled) return;
      if (event.type !== "process.output") continue;
      if (feedOutputEvent(event)) {
        settleMatch((event.payload as { stream: OutputStream }).stream, event.seq);
        return;
      }
    }
    if (settled) return;

    // -- drain arrivals buffered during the history check (in arrival order) --
    historyDone = true;
    for (const event of buffered.splice(0)) {
      if (settled) return;
      if (event.type === "process.output") {
        if (feedOutputEvent(event)) {
          settleMatch((event.payload as { stream: OutputStream }).stream, event.seq);
          return;
        }
        continue;
      }
      if (isTargetTerminal(event, target)) {
        for (const stream of ["stdout", "stderr"] as const) {
          if (flushStream(states[stream], marker)) {
            settleMatch(stream, event.seq);
            return;
          }
        }
        settleError("PROCESS_EXITED", `process '${target}' ended before its readiness marker was observed`);
        return;
      }
    }
    if (settled) return;

    // -- arm the trusted deadline (main/runtime-owned; never renderer/guest input) --
    timer = timers.set(onTimeout, admitted.timeout_ms);
  });
}
