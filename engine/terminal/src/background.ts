// P5.8 background lifetime state machine (canonical task "Background":
// "Start/lifetime distinction/IDs/early exit"; PASS condition "Independent
// stable mappings/streams").
//
// Pure, deterministic decision layer for ONE background operation lifetime.
// The DockerSandboxProvider owns the transport (guest supervisor frames), the
// registry transitions and the trusted journal boundaries; THIS module owns
// the canonical lifetime semantics exactly as the design defines them
// ("Background Execution", "Process Model", "Output Event Contract"):
//
//   - Start/lifetime distinction. The start completes early at the
//     authoritative guest acknowledgment; the latched STARTED fact is
//     immutable ("Background start completes early; lifetime exit is a later
//     process/session event, never rewritten start outcome"). The lifetime's
//     terminal events arrive later and can never rewrite the start outcome.
//   - Stop completion. A background lifetime stopped through the canonical
//     bounded group stop finalizes when the guest confirms the WHOLE group's
//     death: an AUTHORED stop can PASS with forced=true after confirmed death
//     (design "Stop / Cleanup": "Authored stop can PASS forced=true"); an
//     operator stop / cancellation ends SKIPPED/CANCELLED ("Operator cancel
//     SKIPPED/CANCELLED"). The forced flag reports whether the SIGKILL
//     fallback was required (graceful stops are forced=false).
//   - Early exit. An unstopped background exit — including exit 0 — is
//     canonical FAIL/BACKGROUND_EXITED_EARLY with the TRUE exit code; the
//     session fails and closes ("early natural exit including 0 fails/closes
//     session, historical STARTED retained"). No restart policy exists in P5.
//   - Guest failure classifications. A guest process_failed frame for a
//     background id (OUTPUT_LIMIT et al.) finalizes FAIL/<code> and requests
//     the session teardown (the container is the cleanup authority).
//   - One immutable final result. Every terminal path finalizes exactly once
//     (guarded); duplicate/late terminal frames can never emit a second
//     operation.completed. Results are EVENT-DRIVEN for background
//     operations (the receipt stays the STARTED fact; "Accepted receipts
//     prompt, final results event-driven").
//   - Session closing. A lifetime interrupted by session close/failure/
//     ceiling publishes NO final result (no event may follow the session's
//     terminal trace). The session ceiling itself (30 minutes, design
//     "Container Lifecycle") is session-owned and provider-armed; it reaches
//     background lifetimes through sessionClosing — "Lease/session ceiling
//     apply, no authored foreground timeout".
//
// No I/O, no timers of its own: terminal reports arrive as explicit method
// calls and all side effects (event emission, teardown request) are expressed
// through injected callbacks. Every terminal/race behavior is unit-testable
// with deterministic inputs.

import type { ExecutionGrant } from "./admission.ts";
import {
  type FinalOperationOutcome,
  type RuntimeErrorCode,
  type RuntimeEventType,
  type StopCause,
} from "./protocol.ts";

/**
 * Canonical outcome mapping for a CONFIRMED background stop
 * (design "Stop / Cleanup" + error model): authored stop PASS; operator
 * stop / cancellation SKIPPED/CANCELLED; a deadline stop cannot occur for a
 * background lifetime (no authored foreground timeout) but is kept as a
 * defensive FAIL/TIMEOUT mapping so no unknown cause can ever PASS silently.
 */
export function backgroundStopOutcome(cause: StopCause): {
  outcome: FinalOperationOutcome;
  reason: RuntimeErrorCode | null;
} {
  switch (cause) {
    case "authored_stop":
      return { outcome: "PASS", reason: null };
    case "timeout":
      return { outcome: "FAIL", reason: "TIMEOUT" };
    // operator_stop / operation_cancelled / session_closing: operator- or
    // session-initiated termination without a lesson-authored completion.
    default:
      return { outcome: "SKIPPED", reason: "CANCELLED" };
  }
}

/** Side effects the provider executes on the lifetime's behalf (no I/O here). */
export interface BackgroundRunCallbacks {
  /** Emit one translated runtime event (the provider wraps it into the envelope). */
  emitEvent(type: RuntimeEventType, payload: unknown): void;
  /** Request session teardown (latched cause retained; container is the authority). */
  teardown(code: RuntimeErrorCode, message: string): void;
}

export interface BackgroundRunOptions {
  readonly grant: ExecutionGrant;
  readonly callbacks: BackgroundRunCallbacks;
}

type Phase = "starting" | "running" | "done";

/**
 * One background operation's lifetime state machine. All methods are
 * synchronous transitions; guest frames arrive through the injected calls
 * below (the provider has already applied the authoritative registry
 * transitions — the machine owns the event trace and finalization only).
 */
export class BackgroundRun {
  private phase: Phase = "starting";
  private finalized = false;
  private aborted = false;
  private readonly options: BackgroundRunOptions;

  constructor(options: BackgroundRunOptions) {
    this.options = options;
  }

  /**
   * The authoritative guest start acknowledgment arrived: the immutable
   * STARTED fact is latched. Later lifetime events can never rewrite it
   * (the receipt outcome is never rewritten).
   */
  onStarted(): void {
    if (this.phase !== "starting" || this.aborted || this.finalized) return;
    this.phase = "running";
  }

  /**
   * A CONFIRMED stop: the guest reported the whole group dead (SIGINT grace,
   * SIGKILL fallback, death/drain verification guest-side). The provider has
   * already recorded the registry death facts. Emits process.stopped and the
   * one immutable final result (authored stop PASSes; operator stop is
   * SKIPPED/CANCELLED). No session teardown — a confirmed stop leaves the
   * session (and its container) alive for further operations.
   */
  onStoppedFrame(cause: StopCause, stopped: { forced: boolean; exit_code: number | null; signal: string | null }): void {
    if (this.finalized || this.aborted || this.phase === "starting") return;
    this.finalize(() => {
      this.options.callbacks.emitEvent("process.stopped", {
        cause,
        forced: stopped.forced,
        exit_code: stopped.exit_code,
        signal: stopped.signal,
      });
      const { outcome, reason } = backgroundStopOutcome(cause);
      this.options.callbacks.emitEvent("operation.completed", {
        outcome,
        reason,
        exit_code: stopped.exit_code,
        forced: stopped.forced,
      });
    });
  }

  /**
   * An UNSTOPPED (natural) exit — including exit 0. The provider has already
   * emitted the true death fact (process.exited) and settled stop waiters.
   * Canonical classification: FAIL/BACKGROUND_EXITED_EARLY with the true
   * code, then session fail/close ("fails/closes session").
   */
  onEarlyExit(exitCode: number | null, signal: string | null): void {
    if (this.finalized || this.aborted || this.phase === "starting") return;
    this.finalize(() => {
      this.options.callbacks.emitEvent("process.failed", {
        code: "BACKGROUND_EXITED_EARLY",
        message: `background process '${this.options.grant.process_id ?? "unknown"}' exited on its own with code ${exitCode ?? "null"}`,
      });
      this.options.callbacks.emitEvent("operation.completed", {
        outcome: "FAIL",
        reason: "BACKGROUND_EXITED_EARLY",
        exit_code: exitCode,
        forced: false,
      });
      this.options.callbacks.teardown(
        "BACKGROUND_EXITED_EARLY",
        `background process '${this.options.grant.process_id ?? "unknown"}' exited naturally`,
      );
    });
  }

  /**
   * A guest process_failed classification for this background id
   * (OUTPUT_LIMIT et al. — the guest already killed the group). FAIL/<code>,
   * then session fail/close.
   */
  onFailedFrame(code: RuntimeErrorCode, message: string): void {
    if (this.finalized || this.aborted || this.phase === "starting") return;
    this.finalize(() => {
      this.options.callbacks.emitEvent("process.failed", { code, message });
      this.options.callbacks.emitEvent("operation.completed", {
        outcome: "FAIL",
        reason: code,
        exit_code: null,
        forced: true,
      });
      this.options.callbacks.teardown(code, message);
    });
  }

  /** Session close/failure/ceiling while the lifetime is active: no final result. */
  sessionClosing(): void {
    if (this.finalized || this.aborted) return;
    this.aborted = true;
    this.phase = "done";
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  /** The one immutable final trace (guarded: exactly once). */
  private finalize(emit: () => void): void {
    if (this.finalized || this.aborted) return;
    this.finalized = true;
    this.phase = "done";
    emit();
  }
}
