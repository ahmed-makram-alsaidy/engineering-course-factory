// P8.3 Time Model & Deterministic Logical Clock Abstraction
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 26 & Section 8.3,
// and docs/adr/ADR-0013-runtime-orchestration-boundary.md.
//
// Provides:
// 1. Pluggable Clock interface
// 2. SystemMonotonicClock wrapping performance.now() and host timers
// 3. ManualLogicalClock for fully deterministic, zero-sleep testing
// 4. SuspendableTimer primitive supporting pause/resume elapsed time mechanics
// Zero external engine execution, zero Date.now() dependencies for sequencing.

import { RuntimeError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Constants & Bounds
// ---------------------------------------------------------------------------

/** Maximum allowable timer delay in milliseconds (~24.8 days, 32-bit signed int limit). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Maximum iteration count for ManualLogicalClock loop to guard against infinite timer storms. */
export const MAX_CLOCK_ITERATIONS = 100_000;

// ---------------------------------------------------------------------------
// Clock Interfaces
// ---------------------------------------------------------------------------

/** Opaque, main-owned, deterministic timer handle. */
export interface TimerHandle {
  readonly id: number;
}

/** Canonical Clock interface for Course Factory runtime orchestration. */
export interface Clock {
  /** Returns monotonic elapsed milliseconds. */
  now(): number;

  /**
   * Schedules a callback to fire after timeoutMs.
   * Rejects NaN, Infinity, negative durations, and values exceeding MAX_TIMER_DELAY_MS.
   */
  setTimeout(handler: () => void, timeoutMs: number): TimerHandle;

  /** Cancels a scheduled timer. Idempotent and safe. */
  clearTimeout(handle: TimerHandle): void;
}

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

export function validateTimeoutMs(timeoutMs: number): void {
  if (typeof timeoutMs !== "number" || Number.isNaN(timeoutMs)) {
    throw new RuntimeError({
      code: "INVALID_REQUEST",
      message: "Timer delay must be a valid number (got NaN or non-number)",
    });
  }
  if (!Number.isFinite(timeoutMs)) {
    throw new RuntimeError({
      code: "INVALID_REQUEST",
      message: "Timer delay must be a finite number (got Infinity)",
    });
  }
  if (timeoutMs < 0) {
    throw new RuntimeError({
      code: "INVALID_REQUEST",
      message: `Timer delay cannot be negative (got ${timeoutMs} ms)`,
    });
  }
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RuntimeError({
      code: "INVALID_REQUEST",
      message: `Timer delay exceeds maximum allowed limit of ${MAX_TIMER_DELAY_MS} ms (got ${timeoutMs} ms)`,
    });
  }
}

// ---------------------------------------------------------------------------
// Production Clock: SystemMonotonicClock
// ---------------------------------------------------------------------------

/**
 * Production clock wrapping performance.now() and host setTimeout/clearTimeout.
 * Strictly monotonic host time. Never uses Date.now() for sequencing.
 */
export class SystemMonotonicClock implements Clock {
  private nextHandleId = 1;
  private readonly activeTimers = new Map<number, NodeJS.Timeout>();
  private readonly baseline: number;

  constructor() {
    this.baseline = performance.now();
  }

  now(): number {
    return performance.now() - this.baseline;
  }

  setTimeout(handler: () => void, timeoutMs: number): TimerHandle {
    validateTimeoutMs(timeoutMs);

    const handleId = this.nextHandleId++;
    const nodeTimer = globalThis.setTimeout(() => {
      this.activeTimers.delete(handleId);
      try {
        handler();
      } catch (err) {
        // Uncaught exceptions in timer callbacks are logged or rethrown
        console.error("[SystemMonotonicClock] Uncaught error in timer handler:", err);
      }
    }, timeoutMs);

    this.activeTimers.set(handleId, nodeTimer);
    return Object.freeze({ id: handleId });
  }

  clearTimeout(handle: TimerHandle): void {
    if (!handle || typeof handle.id !== "number") {
      return;
    }
    const nodeTimer = this.activeTimers.get(handle.id);
    if (nodeTimer !== undefined) {
      globalThis.clearTimeout(nodeTimer);
      this.activeTimers.delete(handle.id);
    }
  }

  /** Disposes all active timers. */
  dispose(): void {
    for (const nodeTimer of this.activeTimers.values()) {
      globalThis.clearTimeout(nodeTimer);
    }
    this.activeTimers.clear();
  }
}

// ---------------------------------------------------------------------------
// Test Clock: ManualLogicalClock
// ---------------------------------------------------------------------------

interface ScheduledLogicalTimer {
  readonly id: number;
  readonly deadline: number;
  readonly registrationSeq: number;
  readonly handler: () => void;
  cancelled: boolean;
}

/**
 * Deterministic test clock supporting manual time advancement and synchronous timer execution.
 * Guarantees exact deadline ordering with FIFO tie-breaking for equal deadlines.
 * Zero real sleeps.
 */
export class ManualLogicalClock implements Clock {
  private currentTime: number;
  private nextHandleId = 1;
  private nextRegistrationSeq = 1;
  private timers: ScheduledLogicalTimer[] = [];

  constructor(initialTimeMs = 0) {
    validateTimeoutMs(initialTimeMs);
    this.currentTime = initialTimeMs;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout(handler: () => void, timeoutMs: number): TimerHandle {
    validateTimeoutMs(timeoutMs);

    const handleId = this.nextHandleId++;
    const registrationSeq = this.nextRegistrationSeq++;
    const deadline = this.currentTime + timeoutMs;

    const entry: ScheduledLogicalTimer = {
      id: handleId,
      deadline,
      registrationSeq,
      handler,
      cancelled: false,
    };

    // Insert into sorted position: primary key = deadline, secondary key = registrationSeq
    this.insertSorted(entry);

    return Object.freeze({ id: handleId });
  }

  clearTimeout(handle: TimerHandle): void {
    if (!handle || typeof handle.id !== "number") {
      return;
    }
    const index = this.timers.findIndex((t) => t.id === handle.id);
    if (index !== -1) {
      this.timers[index]!.cancelled = true;
      this.timers.splice(index, 1);
    }
  }

  /**
   * Advances logical time by ms and executes any timers whose deadline arrives
   * in strictly deterministic order.
   */
  advanceBy(ms: number): number {
    if (typeof ms !== "number" || Number.isNaN(ms)) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: "advanceBy requires a valid number (got NaN or non-number)",
      });
    }
    if (!Number.isFinite(ms)) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: "advanceBy requires a finite number (got Infinity)",
      });
    }
    if (ms < 0) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `advanceBy cannot accept negative milliseconds (got ${ms})`,
      });
    }

    const targetTime = this.currentTime + ms;
    let iterations = 0;

    while (this.timers.length > 0) {
      const nextTimer = this.timers[0]!;
      if (nextTimer.deadline > targetTime) {
        break;
      }

      if (++iterations > MAX_CLOCK_ITERATIONS) {
        throw new RuntimeError({
          code: "INVALID_REQUEST",
          message: `Timer storm detected: exceeded ${MAX_CLOCK_ITERATIONS} iterations during clock advance`,
        });
      }

      // Pop the next timer
      this.timers.shift();

      // Advance clock to timer's deadline
      this.currentTime = nextTimer.deadline;

      if (!nextTimer.cancelled) {
        nextTimer.handler();
      }
    }

    // Advance clock to target time if no more timers or remaining time
    this.currentTime = targetTime;
    return this.currentTime;
  }

  /** Advances logical time to the specified absolute timestamp. */
  advanceTo(targetMs: number): number {
    validateTimeoutMs(targetMs);
    if (targetMs < this.currentTime) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `advanceTo target (${targetMs} ms) cannot be before current time (${this.currentTime} ms)`,
      });
    }
    return this.advanceBy(targetMs - this.currentTime);
  }

  /**
   * Runs the next scheduled timer by advancing time to its deadline.
   * Returns true if a timer was executed, false if queue is empty.
   */
  runNext(): boolean {
    while (this.timers.length > 0) {
      const nextTimer = this.timers.shift()!;
      this.currentTime = nextTimer.deadline;
      if (!nextTimer.cancelled) {
        nextTimer.handler();
        return true;
      }
    }
    return false;
  }

  /**
   * Runs all timers currently due at or before the current clock time.
   * Does not advance logical clock. Returns count of executed timers.
   */
  runPendingTimers(): number {
    let executed = 0;
    let iterations = 0;

    while (this.timers.length > 0 && this.timers[0]!.deadline <= this.currentTime) {
      if (++iterations > MAX_CLOCK_ITERATIONS) {
        throw new RuntimeError({
          code: "INVALID_REQUEST",
          message: `Timer storm detected: exceeded ${MAX_CLOCK_ITERATIONS} iterations during runPendingTimers`,
        });
      }

      const nextTimer = this.timers.shift()!;
      if (!nextTimer.cancelled) {
        nextTimer.handler();
        executed++;
      }
    }
    return executed;
  }

  /**
   * Flushes and executes all remaining queued timers in deadline order.
   * Advances time to the last timer's deadline. Returns count of executed timers.
   */
  flush(): number {
    let executed = 0;
    let iterations = 0;

    while (this.timers.length > 0) {
      if (++iterations > MAX_CLOCK_ITERATIONS) {
        throw new RuntimeError({
          code: "INVALID_REQUEST",
          message: `Timer storm detected: exceeded ${MAX_CLOCK_ITERATIONS} iterations during flush`,
        });
      }

      const nextTimer = this.timers.shift()!;
      this.currentTime = nextTimer.deadline;
      if (!nextTimer.cancelled) {
        nextTimer.handler();
        executed++;
      }
    }
    return executed;
  }

  /** Returns number of active pending scheduled timers. */
  getPendingTimerCount(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  private insertSorted(entry: ScheduledLogicalTimer): void {
    let low = 0;
    let high = this.timers.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const current = this.timers[mid]!;

      if (
        entry.deadline < current.deadline ||
        (entry.deadline === current.deadline && entry.registrationSeq < current.registrationSeq)
      ) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }
    this.timers.splice(low, 0, entry);
  }
}

// ---------------------------------------------------------------------------
// SuspendableTimer: Pause-Compatible Deterministic Wait Primitive
// ---------------------------------------------------------------------------

export type SuspendableTimerState = "IDLE" | "RUNNING" | "PAUSED" | "COMPLETED" | "CANCELLED";

/**
 * Suspendable timer abstraction supporting pause/suspend/resume mechanics.
 * When suspended during PAUSE, elapsed time is frozen and the remaining duration
 * is re-armed when resumed.
 */
export class SuspendableTimer {
  private readonly clock: Clock;
  private readonly totalDurationMs: number;
  private readonly onComplete: () => void;

  private state: SuspendableTimerState = "IDLE";
  private remainingMs: number;
  private lastStartedAtMs = 0;
  private activeHandle: TimerHandle | null = null;

  constructor(clock: Clock, durationMs: number, onComplete: () => void) {
    validateTimeoutMs(durationMs);
    if (typeof onComplete !== "function") {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: "SuspendableTimer requires a valid onComplete callback function",
      });
    }
    this.clock = clock;
    this.totalDurationMs = durationMs;
    this.remainingMs = durationMs;
    this.onComplete = onComplete;
  }

  getState(): SuspendableTimerState {
    return this.state;
  }

  getTotalDurationMs(): number {
    return this.totalDurationMs;
  }

  getRemainingMs(): number {
    if (this.state === "IDLE") {
      return this.totalDurationMs;
    }
    if (this.state === "PAUSED") {
      return this.remainingMs;
    }
    if (this.state === "RUNNING") {
      const elapsed = this.clock.now() - this.lastStartedAtMs;
      return Math.max(0, this.remainingMs - elapsed);
    }
    return 0; // COMPLETED or CANCELLED
  }

  start(): void {
    if (this.state !== "IDLE") {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Cannot start SuspendableTimer in state '${this.state}' (must be 'IDLE')`,
      });
    }

    this.state = "RUNNING";
    this.lastStartedAtMs = this.clock.now();

    if (this.remainingMs === 0) {
      // 0-duration timer completes synchronously on clock tick
      this.activeHandle = this.clock.setTimeout(() => {
        this.complete();
      }, 0);
    } else {
      this.activeHandle = this.clock.setTimeout(() => {
        this.complete();
      }, this.remainingMs);
    }
  }

  suspend(): void {
    if (this.state === "PAUSED") {
      // Idempotent
      return;
    }
    if (this.state !== "RUNNING") {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Cannot suspend SuspendableTimer in state '${this.state}' (must be 'RUNNING')`,
      });
    }

    const elapsed = this.clock.now() - this.lastStartedAtMs;
    this.remainingMs = Math.max(0, this.remainingMs - elapsed);

    if (this.activeHandle !== null) {
      this.clock.clearTimeout(this.activeHandle);
      this.activeHandle = null;
    }

    this.state = "PAUSED";
  }

  resume(): void {
    if (this.state === "RUNNING") {
      // Idempotent
      return;
    }
    if (this.state !== "PAUSED") {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Cannot resume SuspendableTimer in state '${this.state}' (must be 'PAUSED')`,
      });
    }

    this.state = "RUNNING";
    this.lastStartedAtMs = this.clock.now();

    if (this.remainingMs === 0) {
      this.activeHandle = this.clock.setTimeout(() => {
        this.complete();
      }, 0);
    } else {
      this.activeHandle = this.clock.setTimeout(() => {
        this.complete();
      }, this.remainingMs);
    }
  }

  cancel(): void {
    if (this.state === "CANCELLED" || this.state === "COMPLETED") {
      return;
    }

    if (this.activeHandle !== null) {
      this.clock.clearTimeout(this.activeHandle);
      this.activeHandle = null;
    }

    this.state = "CANCELLED";
  }

  dispose(): void {
    this.cancel();
  }

  private complete(): void {
    if (this.state !== "RUNNING") {
      return;
    }
    this.state = "COMPLETED";
    this.remainingMs = 0;
    this.activeHandle = null;
    this.onComplete();
  }
}
