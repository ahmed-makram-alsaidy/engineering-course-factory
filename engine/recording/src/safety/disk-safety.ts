// P9.6 Disk Safety — volume-aware preflight + bounded runtime watcher.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 19, 21 and
// docs/adr/ADR-0014-screen-recording-boundary.md (disk-safety policy).
//
// Pure policy only: every function takes explicit inputs and returns a
// verdict. No filesystem access, no process state, no timers of its own.
// Callers supply measured free bytes taken on the volume that actually owns
// the take temp dir (never an assumed drive), plus an injected scheduler so
// unit runs stay deterministic with zero sleeps.
//
// The watcher is operational safety only: it never derives video time and
// never retries writes. Once low space latches, scheduling stops and the
// owner performs one bounded cleanup.

import {
  CEILING_BYTES_PER_SECOND,
  DISK_POLL_INTERVAL_MS,
  LOW_SPACE_ABORT_BYTES,
  MAX_BILLABLE_LESSON_S,
  PREFLIGHT_ESTIMATE_MULTIPLIER,
  PREFLIGHT_MIN_FREE_BYTES,
  checkDiskPreflight,
  estimateFinalBytes,
} from "../disk-budget.ts";
import { MAX_TAKE_DURATION_S } from "../protocol.ts";

// ---------------------------------------------------------------------------
// Frozen P9.6 re-exports (single definition of truth stays in P9.1 modules)
// ---------------------------------------------------------------------------

export const SAFETY_POLL_MS = DISK_POLL_INTERVAL_MS;
export const SAFETY_LOW_SPACE_BYTES = LOW_SPACE_ABORT_BYTES;
export const SAFETY_PREFLIGHT_FLOOR_BYTES = PREFLIGHT_MIN_FREE_BYTES;
export const SAFETY_MAX_TAKE_S = MAX_TAKE_DURATION_S;
export const SAFETY_MAX_BILLABLE_S = MAX_BILLABLE_LESSON_S;

// ---------------------------------------------------------------------------
// Conservative size estimator (bounded, deterministic, no fake precision)
// ---------------------------------------------------------------------------

/**
 * Conservative final-size estimate for one take:
 * `min(expectedLessonS, 1800) x 2.0 MB/s`.
 *
 * The expected duration must itself be bounded: anything above the frozen
 * take ceiling (30 min + 2 s tail) is rejected instead of estimated, so the
 * estimator can never approve an unbounded recording duration.
 */
export function estimateTakeFinalBytes(expectedLessonS: number): number {
  if (!Number.isFinite(expectedLessonS) || expectedLessonS < 0) {
    throw new Error("[DISK_BUDGET_INVALID] expected lesson seconds must be >= 0");
  }
  if (expectedLessonS > MAX_TAKE_DURATION_S) {
    throw new Error(
      `[DISK_BUDGET_INVALID] expected duration exceeds take ceiling ${MAX_TAKE_DURATION_S}s`,
    );
  }
  return estimateFinalBytes(expectedLessonS);
}

/** Required free bytes for preflight: max(2 GiB, estimate x 3). */
export function requiredTakeFreeBytes(expectedLessonS: number): number {
  const estimated = estimateTakeFinalBytes(expectedLessonS);
  return Math.max(
    PREFLIGHT_MIN_FREE_BYTES,
    estimated * PREFLIGHT_ESTIMATE_MULTIPLIER,
  );
}

// ---------------------------------------------------------------------------
// Volume-aware preflight (fail closed on uncertainty)
// ---------------------------------------------------------------------------

export type PreflightRefusal =
  | "BELOW_FLOOR"
  | "BELOW_ESTIMATE"
  | "QUERY_FAILED"
  | "DURATION_REJECTED";

export interface VolumePreflightInput {
  /**
   * Measured free bytes on the volume that owns the take temp dir, or null
   * when the query failed or is otherwise uncertain. Null fails closed:
   * space is never assumed safe.
   */
  readonly freeBytesOrNull: number | null;
  readonly expectedLessonS: number;
}

export interface VolumePreflightVerdict {
  readonly ok: boolean;
  readonly reason: "SUFFICIENT" | PreflightRefusal;
  readonly freeBytes: number | null;
  readonly requiredBytes: number;
  readonly estimatedFinalBytes: number;
  /** Conservative ceiling rate that produced the estimate (evidence only). */
  readonly ceilingBytesPerSecond: number;
}

/**
 * Refuse-to-start gate. Evaluated with the free-space reading of the real
 * temp volume before any encoder or capture resource is created.
 */
export function evaluateVolumePreflight(
  input: VolumePreflightInput,
): VolumePreflightVerdict {
  const expected = input.expectedLessonS;
  if (!Number.isFinite(expected) || expected < 0 || expected > MAX_TAKE_DURATION_S) {
    return {
      ok: false,
      reason: "DURATION_REJECTED",
      freeBytes: input.freeBytesOrNull,
      requiredBytes: PREFLIGHT_MIN_FREE_BYTES,
      estimatedFinalBytes: 0,
      ceilingBytesPerSecond: CEILING_BYTES_PER_SECOND,
    };
  }
  const estimated = estimateFinalBytes(expected);
  const required = Math.max(
    PREFLIGHT_MIN_FREE_BYTES,
    estimated * PREFLIGHT_ESTIMATE_MULTIPLIER,
  );
  if (input.freeBytesOrNull === null) {
    return {
      ok: false,
      reason: "QUERY_FAILED",
      freeBytes: null,
      requiredBytes: required,
      estimatedFinalBytes: estimated,
      ceilingBytesPerSecond: CEILING_BYTES_PER_SECOND,
    };
  }
  const verdict = checkDiskPreflight({
    free_bytes: input.freeBytesOrNull,
    expected_lesson_s: expected,
  });
  return {
    ok: verdict.ok,
    reason: verdict.reason,
    freeBytes: input.freeBytesOrNull,
    requiredBytes: required,
    estimatedFinalBytes: estimated,
    ceilingBytesPerSecond: CEILING_BYTES_PER_SECOND,
  };
}

// ---------------------------------------------------------------------------
// Runtime low-space predicate (1 GiB abort, never wait for ENOSPC)
// ---------------------------------------------------------------------------

/**
 * True when the take must stop now: free space dropped below 1 GiB.
 * A null/uncertain reading fails closed (true): the owner stops instead of
 * assuming space is safe.
 */
export function mustAbortTakeForDisk(freeBytesOrNull: number | null): boolean {
  if (freeBytesOrNull === null) return true;
  if (!Number.isInteger(freeBytesOrNull) || freeBytesOrNull < 0) return true;
  return freeBytesOrNull < LOW_SPACE_ABORT_BYTES;
}

// ---------------------------------------------------------------------------
// Bounded disk watcher (injected scheduler, latches once, no retry loop)
// ---------------------------------------------------------------------------

export type LowSpaceReason = "LOW_SPACE" | "QUERY_FAILED";

export interface DiskWatcherScheduler {
  schedule(fn: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}

export interface DiskWatcherEvents {
  onLowSpace(info: { freeBytes: number | null; reason: LowSpaceReason }): void;
}

/**
 * Periodic free-space guard for one active take. Cadence is bounded
 * (default 5 s); the callback owns stopping acquisition. After the first
 * low-space latch the watcher stops itself: no further polls, no write
 * retries, no diagnostic copies, no giant logs — one bounded cleanup only.
 * Repeated low-space conditions are idempotent (exactly one event).
 */
export class BoundedDiskWatcher {
  private readonly query: () => number | null;
  private readonly scheduler: DiskWatcherScheduler;
  private readonly events: DiskWatcherEvents;
  private readonly pollMs: number;

  private timer: unknown | null = null;
  private latched = false;
  private polls = 0;
  private running = false;

  constructor(input: {
    query: () => number | null;
    scheduler: DiskWatcherScheduler;
    events: DiskWatcherEvents;
    pollMs?: number;
  }) {
    if (input.pollMs !== undefined && (!Number.isInteger(input.pollMs) || input.pollMs <= 0)) {
      throw new Error("[DISK_BUDGET_INVALID] poll interval must be a positive integer");
    }
    this.query = input.query;
    this.scheduler = input.scheduler;
    this.events = input.events;
    this.pollMs = input.pollMs ?? DISK_POLL_INTERVAL_MS;
  }

  /** Starts periodic polling. Idempotent; exactly one live timer at a time. */
  start(): void {
    if (this.running || this.latched) return;
    this.running = true;
    this.arm();
  }

  /** Stops polling. Idempotent; safe to call after latch or twice. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      try {
        this.scheduler.cancel(this.timer);
      } catch {
        // Timer release is best-effort; the latch owns correctness.
      }
      this.timer = null;
    }
  }

  /** One synchronous poll: used by the scheduler and directly by tests. */
  pollOnce(): void {
    if (this.latched) return;
    this.polls += 1;
    let free: number | null;
    try {
      free = this.query();
    } catch {
      free = null;
    }
    if (free === null || !Number.isInteger(free) || free < 0) {
      this.latch(null, "QUERY_FAILED");
      return;
    }
    if (free < LOW_SPACE_ABORT_BYTES) {
      this.latch(free, "LOW_SPACE");
    }
  }

  get isLatched(): boolean {
    return this.latched;
  }

  get pollCount(): number {
    return this.polls;
  }

  get isRunning(): boolean {
    return this.running && !this.latched;
  }

  private arm(): void {
    if (!this.running || this.latched) return;
    if (this.timer !== null) {
      try {
        this.scheduler.cancel(this.timer);
      } catch {
        // Best-effort; re-arm below.
      }
      this.timer = null;
    }
    this.timer = this.scheduler.schedule(() => {
      this.timer = null;
      this.pollOnce();
      if (!this.latched) {
        this.arm();
      }
    }, this.pollMs);
  }

  private latch(freeBytes: number | null, reason: LowSpaceReason): void {
    if (this.latched) return;
    this.latched = true;
    this.stop();
    this.events.onLowSpace({ freeBytes, reason });
  }
}
