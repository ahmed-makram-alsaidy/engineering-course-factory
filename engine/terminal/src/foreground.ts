// P5.7 foreground completion state machine (canonical task "Foreground":
// "runtime/supervisor/tests — Actual exit/expected/deadline/drain/descendants").
//
// Pure, deterministic decision layer for ONE foreground operation attempt.
// The DockerSandboxProvider owns the transport (guest supervisor frames) and
// the trusted registry/journal boundaries; THIS module owns the completion
// semantics exactly as the design's "Foreground Execution" section defines
// them:
//
//   - The ACTUAL exit code is the guest-reported code, preserved as-is; the
//     EXPECTED exit code comes only from the trusted ExecutionGrant.
//     PASS is exactly `actual === expected` — never a hard-coded exit 0.
//   - Deadline ownership is main/runtime-side: the run arms the trusted
//     deadline (bounded to the admission policy) after the authoritative
//     start ack. "Exit observed before deadline wins; at/after TIMEOUT";
//     "late matching exit can't undo timeout". No synthetic exit code is
//     ever invented for a signal/deadline termination (exit_code stays null;
//     the real kill signal is preserved separately where defined).
//   - One immutable final result: every terminal path finalizes exactly once
//     (guarded); a duplicate or stale terminal report can never emit a
//     second operation.completed.
//   - Drain ordering: after the guest's terminal frame the run waits the
//     canonical bounded drain window, letting in-flight output land BEFORE
//     the terminal event and the final result are emitted. The canonical
//     order is process output -> drain complete -> terminal event ->
//     final result — never a normal output event after the final result.
//   - Descendants: a natural direct-command exit while owned descendants
//     survive is classified FAIL/UNEXPECTED_DESCENDANTS (the guest kills and
//     verifies the residual group first and reports it); an operation NEVER
//     PASSes while owned descendants remain.
//   - Failure distinctions follow the canonical taxonomy: lesson exit
//     mismatch (EXIT_CODE_MISMATCH) is distinct from transport failure
//     (TRANSPORT_FAILED), guest/supervisor failure (PROTOCOL_FAILED /
//     supervisor frames), deadline expiry (TIMEOUT) and cancellation
//     (CANCELLED -> SKIPPED).
//
// No I/O, no timers of its own: clocks/timers are injected, terminal reports
// arrive as explicit method calls, and all side effects (event emission,
// registry transition, stop frame, teardown, result delivery) are expressed
// through injected callbacks. This keeps every deadline/race behavior
// unit-testable with a deterministic fake clock.

import type { ExecutionGrant } from "./admission.ts";
import type { ProcessExitFacts } from "./registry.ts";
import {
  OperationResultSchema,
  RUNTIME_EVENT_VERSION,
  type FinalOperationOutcome,
  type OperationResult,
  type RuntimeErrorCode,
  type RuntimeEventType,
  type StopCause,
} from "./protocol.ts";

/** Terminal classification of one foreground attempt. */
export type ForegroundLatch =
  | { kind: "exit"; exit_code: number | null; signal: string | null; duration_ms: number }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "descendants"; exit_code: number | null; signal: string | null; duration_ms: number }
  | { kind: "output-limit"; exit_code: number | null; signal: string | null; duration_ms: number | null }
  | { kind: "spawn-failed"; message: string };

/** Injected timers (host setTimeout/clearTimeout in production; fake in tests). */
export interface ForegroundTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Side effects the provider executes on the run's behalf (no I/O here). */
export interface ForegroundRunCallbacks {
  /** Emit one translated runtime event (the provider wraps it into the envelope). */
  emitEvent(type: RuntimeEventType, payload: unknown): void;
  /** Registry transition to EXITED with the final death facts. */
  markExited(facts: ProcessExitFacts): void;
  /** Send the guest stop frame for this foreground group. */
  sendStop(): void;
  /** Request session teardown (latched cause retained; container is the authority). */
  teardown(code: RuntimeErrorCode, message: string): void;
  /** Deliver the one immutable final result (resolves the awaiting start). */
  onFinalized(result: OperationResult): void;
  /** The session closed/failed before the run could settle (rejects the awaiting start). */
  onAborted(code: RuntimeErrorCode, message: string): void;
  /** Current decoded output byte counters of the foreground group (stdout+stderr). */
  outputBytes(): number;
}

export interface ForegroundRunOptions {
  readonly grant: ExecutionGrant;
  readonly callbacks: ForegroundRunCallbacks;
  readonly timers: ForegroundTimers;
  readonly nowMs: () => number;
  /** Canonical bounded drain window (FOREGROUND_POLICY.drain_window_ms). */
  readonly drainWindowMs: number;
  /** Bounded stop-confirmation window (grace + verification + margin). */
  readonly stopConfirmTimeoutMs: number;
  /** Trusted foreground deadline (admission-bounded; main/runtime-owned). */
  readonly deadlineMs: number;
}

type Phase = "starting" | "running" | "latched" | "draining" | "done";

/**
 * One foreground attempt's completion state machine. All methods are
 * synchronous transitions; guest frames and timers arrive through the
 * injected calls below.
 */
export class ForegroundRun {
  private phase: Phase = "starting";
  private latch: ForegroundLatch | null = null;
  private finalized = false;
  private aborted = false;
  /** Latched stop path (timeout/cancel) waiting for the guest confirmation. */
  private stopCause: StopCause | null = null;
  /** Facts recorded from the stop path's confirmation frame. */
  private stoppedFacts: { forced: boolean; exit_code: number | null; signal: string | null; duration_ms: number } | null = null;
  /** A late process_failed classification that upgrades a plain natural exit. */
  private pendingDescendantClassification = false;
  private cancelPending = false;
  private deadlineTimer: unknown = null;
  private confirmTimer: unknown = null;
  private drainTimer: unknown = null;
  private cancelWaiters: Array<(result: "settled") => void> = [];
  private readonly options: ForegroundRunOptions;

  constructor(options: ForegroundRunOptions) {
    this.options = options;
  }

  /** The trusted deadline (main/runtime-owned; never renderer/guest input). */
  get deadline(): number {
    return this.options.deadlineMs;
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  // -- lifecycle transitions ---------------------------------------------------

  /**
   * The authoritative guest start acknowledgment arrived: the deadline is
   * armed NOW (deadline before spawn; startup bounded by the deadline). A
   * cancellation that raced the start is dispatched at this point.
   */
  onAck(): void {
    if (this.phase !== "starting" || this.aborted || this.finalized) return;
    this.phase = "running";
    this.deadlineTimer = this.options.timers.set(() => this.onDeadline(), this.options.deadlineMs);
    if (this.cancelPending) {
      this.cancelPending = false;
      this.beginStop("operation_cancelled", "cancelled");
    }
  }

  /** The trusted deadline expired (host-side timer; never guest input). */
  onDeadline(): void {
    this.deadlineTimer = null;
    if (this.phase !== "running" || this.finalized || this.aborted) return;
    // Canonical order: timeout -> stopping -> final output -> stopped -> completed.
    this.phase = "latched";
    this.stopCause = "timeout";
    this.latch = { kind: "timeout" };
    this.disarmDeadline();
    this.options.callbacks.emitEvent("process.timeout", { timeout_ms: this.options.deadlineMs });
    this.options.callbacks.emitEvent("process.stopping", { cause: "timeout" });
    this.options.callbacks.sendStop();
    this.armConfirm();
  }

  /** Guest natural-exit frame (whole group verified dead guest-side before it is sent). */
  onExitFrame(exitCode: number | null, signal: string | null, durationMs: number): void {
    if (this.finalized || this.aborted) return;
    if (this.phase === "running") {
      // Exit observed before the deadline wins: disarm the deadline and
      // enter the bounded drain window before the terminal event/result.
      this.disarmDeadline();
      this.latch = { kind: "exit", exit_code: exitCode, signal, duration_ms: durationMs };
      if (this.pendingDescendantClassification) {
        this.pendingDescendantClassification = false;
        this.latch = { kind: "descendants", exit_code: exitCode, signal, duration_ms: durationMs };
      }
      this.beginDrain();
      return;
    }
    // A late exit after the deadline/cancel was latched cannot undo it
    // (design: "Late matching exit can't undo timeout"). The fact is
    // recorded; the latched classification stands.
  }

  /** Guest stopped-frame (the confirmed death of a latched stop path). */
  onStoppedFrame(forced: boolean, exitCode: number | null, signal: string | null, durationMs: number): void {
    if (this.finalized || this.aborted) return;
    if (this.phase !== "latched" || this.stopCause === null) return;
    this.stoppedFacts = { forced, exit_code: exitCode, signal, duration_ms: durationMs };
    this.disarmConfirm();
    this.beginDrain();
  }

  /**
   * Guest UNEXPECTED_DESCENDANTS classification (the residual group was
   * force-killed and verified dead before the frame was sent).
   */
  onDescendantFailure(): void {
    if (this.finalized || this.aborted) return;
    if (this.phase === "running") {
      // The guest always reports the exit fact first; remember the upgrade.
      this.pendingDescendantClassification = true;
      return;
    }
    if (this.phase === "draining" && this.latch?.kind === "exit") {
      this.latch = {
        kind: "descendants",
        exit_code: this.latch.exit_code,
        signal: this.latch.signal,
        duration_ms: this.latch.duration_ms,
      };
    }
    // A latched timeout/cancel stop legitimately force-kills the whole
    // group; a descendant report there changes nothing.
  }

  /** Guest OUTPUT_LIMIT failure (the guest already killed the group). */
  onOutputLimitFailure(): void {
    if (this.finalized || this.aborted) return;
    if (this.phase !== "running") return;
    this.disarmDeadline();
    this.latch = { kind: "output-limit", exit_code: null, signal: null, duration_ms: null };
    this.phase = "latched";
    // The guest's kill is confirmed through the stopped frame (cause is the
    // bound, not a deadline/cancel).
    this.stopCause = "session_closing";
    this.armConfirm();
  }

  /** Bounded stop-confirmation window expired without a guest confirmation. */
  onConfirmExpired(): void {
    this.confirmTimer = null;
    if (this.phase !== "latched" || this.finalized || this.aborted) return;
    // Uncertain group: finalize with the latched cause and an UNCONFIRMED
    // cleanup, then request the teardown (the container is the authority).
    this.finalize("unconfirmed");
  }

  /**
   * Guest ALREADY_EXITED during a latched deadline/cancel stop: the group
   * was already reaped when the stop frame arrived, so the death is
   * confirmed (the late exit cannot undo the latched classification).
   */
  onAlreadyExited(): void {
    if (this.finalized || this.aborted) return;
    if (this.phase !== "latched") return;
    this.disarmConfirm();
    this.beginDrain();
  }

  /** The guest start acknowledgment never arrived within the bounded window. */
  onSpawnFailed(message: string): void {
    if (this.phase !== "starting" || this.finalized || this.aborted) return;
    this.disarmAll();
    this.latch = { kind: "spawn-failed", message };
    this.finalize("confirmed");
  }

  /**
   * Operator/authored cancellation of the active (or starting) foreground
   * operation. Targets the trusted operation identity only — no arbitrary
   * PID, no renderer signal selection. Resolves when the run settled.
   */
  cancel(): Promise<"settled"> {
    if (this.phase === "running") {
      this.beginStop("operation_cancelled", "cancelled");
    } else if (this.phase === "starting") {
      this.cancelPending = true;
      this.latch = { kind: "cancelled" };
    }
    return new Promise<"settled">((resolve) => {
      if (this.finalized || this.aborted) resolve("settled");
      else this.cancelWaiters.push(resolve);
    });
  }

  /** Session close/failure while the run is active: no final result is published. */
  sessionClosing(code: RuntimeErrorCode, message: string): void {
    if (this.finalized || this.aborted) return;
    this.aborted = true;
    this.disarmAll();
    this.phase = "done";
    for (const waiter of this.cancelWaiters.splice(0)) waiter("settled");
    this.options.callbacks.onAborted(code, message);
  }

  /** Settle a still-pending cancellation wait (session teardown paths). */
  private settleCancelWaiters(): void {
    for (const waiter of this.cancelWaiters.splice(0)) waiter("settled");
  }

  // -- internals ----------------------------------------------------------------

  /** Latch a cancellation and start the bounded guest group stop. */
  private beginStop(cause: StopCause, kind: "timeout" | "cancelled"): void {
    this.phase = "latched";
    this.stopCause = cause;
    this.latch = kind === "timeout" ? { kind: "timeout" } : { kind: "cancelled" };
    this.disarmDeadline();
    this.options.callbacks.emitEvent("process.stopping", { cause });
    this.options.callbacks.sendStop();
    this.armConfirm();
  }

  private armConfirm(): void {
    this.disarmConfirm();
    this.confirmTimer = this.options.timers.set(() => this.onConfirmExpired(), this.options.stopConfirmTimeoutMs);
  }

  private disarmConfirm(): void {
    if (this.confirmTimer !== null) {
      this.options.timers.clear(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  private disarmDeadline(): void {
    if (this.deadlineTimer !== null) {
      this.options.timers.clear(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  private beginDrain(): void {
    this.phase = "draining";
    this.disarmDrain();
    this.drainTimer = this.options.timers.set(() => {
      this.drainTimer = null;
      this.finalize("confirmed");
    }, this.options.drainWindowMs);
  }

  private disarmDrain(): void {
    if (this.drainTimer !== null) {
      this.options.timers.clear(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private disarmAll(): void {
    this.disarmDeadline();
    this.disarmConfirm();
    this.disarmDrain();
  }

  /** The one immutable final result (guarded: exactly once). */
  private finalize(cleanupStatus: "confirmed" | "unconfirmed"): void {
    if (this.finalized || this.aborted) return;
    this.finalized = true;
    this.disarmAll();
    this.phase = "done";
    const latch = this.latch ?? { kind: "exit", exit_code: null, signal: null, duration_ms: 0 } as const;
    const grant = this.options.grant;
    const expected = grant.expected_exit_code;

    let outcome: FinalOperationOutcome;
    let reason: RuntimeErrorCode | null;
    let exitCode: number | null;
    let signal: string | null;
    let forced: boolean;
    let terminalEvent: { type: RuntimeEventType; payload: unknown } | null;
    let durationMs: number | null;
    let truncated = false;
    let teardown: { code: RuntimeErrorCode; message: string } | null = null;

    switch (latch.kind) {
      case "exit": {
        durationMs = latch.duration_ms;
        exitCode = latch.exit_code;
        signal = latch.signal;
        forced = false;
        const matches = expected === null || exitCode === expected;
        if (matches) {
          outcome = "PASS";
          reason = null;
        } else {
          outcome = "FAIL";
          reason = "EXIT_CODE_MISMATCH";
        }
        terminalEvent = { type: "process.exited", payload: { exit_code: latch.exit_code, signal: latch.signal, duration_ms: latch.duration_ms } };
        if (!matches) teardown = { code: "EXIT_CODE_MISMATCH", message: `foreground command exited ${String(exitCode)}; the granted expectation was ${String(expected)}` };
        break;
      }
      case "timeout": {
        outcome = "FAIL";
        reason = "TIMEOUT";
        exitCode = null; // no invented/synthetic exit code for a deadline termination
        signal = this.stoppedFacts?.signal ?? null;
        forced = true;
        durationMs = this.stoppedFacts?.duration_ms ?? null;
        terminalEvent = this.stoppedFacts === null ? null : {
          type: "process.stopped",
          payload: { cause: "timeout", forced: this.stoppedFacts.forced, exit_code: this.stoppedFacts.exit_code, signal: this.stoppedFacts.signal },
        };
        teardown = { code: "TIMEOUT", message: `the trusted foreground deadline (${String(this.options.deadlineMs)} ms) expired` };
        break;
      }
      case "cancelled": {
        outcome = "SKIPPED";
        reason = "CANCELLED";
        exitCode = null;
        signal = this.stoppedFacts?.signal ?? null;
        forced = true;
        durationMs = this.stoppedFacts?.duration_ms ?? null;
        terminalEvent = this.stoppedFacts === null ? null : {
          type: "process.stopped",
          payload: { cause: "operation_cancelled", forced: this.stoppedFacts.forced, exit_code: this.stoppedFacts.exit_code, signal: this.stoppedFacts.signal },
        };
        break; // SKIPPED/CANCELLED with confirmed cleanup — no session teardown
      }
      case "descendants": {
        outcome = "FAIL";
        reason = "UNEXPECTED_DESCENDANTS";
        exitCode = latch.exit_code;
        signal = latch.signal;
        forced = true;
        durationMs = latch.duration_ms;
        terminalEvent = { type: "process.exited", payload: { exit_code: latch.exit_code, signal: latch.signal, duration_ms: latch.duration_ms } };
        teardown = { code: "UNEXPECTED_DESCENDANTS", message: "owned guest descendants survived the direct foreground command's exit" };
        break;
      }
      case "output-limit": {
        outcome = "FAIL";
        reason = "OUTPUT_LIMIT";
        exitCode = null;
        signal = this.stoppedFacts?.signal ?? null;
        forced = true;
        durationMs = this.stoppedFacts?.duration_ms ?? null;
        truncated = true;
        terminalEvent = this.stoppedFacts === null ? null : {
          type: "process.stopped",
          payload: { cause: "session_closing", forced: this.stoppedFacts.forced, exit_code: this.stoppedFacts.exit_code, signal: this.stoppedFacts.signal },
        };
        teardown = { code: "OUTPUT_LIMIT", message: "the foreground command exceeded the decoded output bound" };
        break;
      }
      case "spawn-failed": {
        outcome = "FAIL";
        reason = "SPAWN_FAILED";
        exitCode = null;
        signal = null;
        forced = false;
        durationMs = null;
        // Spawn failure: accepted -> failed -> completed (no invented start/exit).
        this.options.callbacks.emitEvent("process.failed", { code: "SPAWN_FAILED", message: latch.message });
        terminalEvent = null;
        teardown = { code: "SPAWN_FAILED", message: latch.message };
        break;
      }
    }

    // Registry death fact (spawn-failed never started: the provider disposes
    // the reservation instead).
    if (latch.kind !== "spawn-failed") {
      this.options.callbacks.markExited({
        exit_code: exitCode,
        signal,
        stopped: terminalEvent?.type === "process.stopped",
        forced,
      });
    }
    if (terminalEvent !== null) this.options.callbacks.emitEvent(terminalEvent.type, terminalEvent.payload);
    this.options.callbacks.emitEvent("operation.completed", { outcome, reason, exit_code: exitCode, forced });

    const duration = durationMs === null ? 0 : Math.max(0, Math.floor(durationMs));
    const result: OperationResult = OperationResultSchema.parse({
      runtime_event_version: RUNTIME_EVENT_VERSION,
      session_id: grant.session_id,
      generation: grant.generation,
      operation_id: grant.operation_id,
      attempt_id: grant.attempt_id,
      course_id: grant.course_id,
      lesson_id: grant.lesson_id,
      scene_id: grant.scene_id,
      beat_id: grant.beat_id,
      process_id: grant.process_id,
      state: latch.kind === "spawn-failed" ? "DISPOSED" : "EXITED",
      reason,
      // Guest monotonic labels; the origin of the guest monotonic clock for
      // these labels is the process start itself (started 0, ended duration).
      started_ms: latch.kind === "spawn-failed" ? null : 0,
      ended_ms: latch.kind === "spawn-failed" ? null : duration,
      duration_ms: duration,
      exit_code: exitCode,
      signal,
      expected_exit_code: expected,
      timeout_ms: grant.timeout_ms,
      forced,
      cleanup_status: cleanupStatus,
      stdout_ref: opaqueRef("so", grant.operation_id, grant.attempt_id),
      stderr_ref: opaqueRef("se", grant.operation_id, grant.attempt_id),
      output_bytes: this.options.callbacks.outputBytes(),
      truncated,
    });
    this.options.callbacks.onFinalized(result);
    this.settleCancelWaiters();
    if (teardown !== null) {
      this.options.callbacks.teardown(teardown.code, teardown.message);
    }
  }
}

/** Sanitize an identifier into an opaque journal reference token (no paths). */
function opaqueRef(prefix: string, operationId: string, attemptId: string): string {
  const sanitize = (value: string): string =>
    value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 48).replace(/^[.-]+/, "") || "id";
  return `${prefix}-${sanitize(operationId)}-${sanitize(attemptId)}`;
}
