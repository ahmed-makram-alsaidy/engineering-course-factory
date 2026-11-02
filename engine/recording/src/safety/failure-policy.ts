// P9.6 Failure Disposition — honest take outcomes for every abort path.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 16, 19, 21-23 and
// docs/adr/ADR-0014-screen-recording-boundary.md (honest lifecycle).
//
// Pure policy only: maps each frozen terminal cause to its outcome bucket,
// publication target, and temp disposition. No filesystem, no processes, no
// timers, no renderer contact. The lifecycle owner executes the disposition;
// this module decides it deterministically.

import { NO_VALID_FRAME_MS } from "../capture/wgc-session.ts";
import {
  ENCODER_FLUSH_TIMEOUT_MS,
  RECORDER_SHUTDOWN_BARRIER_MS,
} from "../disk-budget.ts";
import {
  TERMINAL_CAUSE_TO_OUTCOME,
  type PublicationStatus,
  type RecordingOutcome,
  type RecordingTerminalCause,
} from "../protocol.ts";

// ---------------------------------------------------------------------------
// Frozen P9.6 bounds (single truth stays in P9.1/P9.2 owners)
// ---------------------------------------------------------------------------

/** Capture starvation bound: 2 s without a valid frame ends the take. */
export const SAFETY_STARVATION_MS = NO_VALID_FRAME_MS;

/** Application shutdown barrier: recorder work must finish inside 10 s. */
export const SAFETY_SHUTDOWN_BARRIER_MS = RECORDER_SHUTDOWN_BARRIER_MS;

/** Encoder flush bound: 30 s in isolation, always capped by shutdown. */
export const SAFETY_ENCODER_FLUSH_MS = ENCODER_FLUSH_TIMEOUT_MS;

// ---------------------------------------------------------------------------
// Take disposition matrix (frozen)
// ---------------------------------------------------------------------------

export type TempDisposition = "PURGE" | "QUARANTINE" | "PUBLISH_VIA_TRANSACTION";

export interface TakeDisposition {
  /** Frozen outcome bucket for the terminal cause. */
  readonly outcome: RecordingOutcome;
  /** Publication target: only SUCCESS may aim at PUBLISHED. */
  readonly publication: PublicationStatus;
  /** Final temp-take disposition executed by the owner. */
  readonly temp: TempDisposition;
  /** Whether a quarantined diagnostic partial is retained (TEMP only). */
  readonly retainDiagnostic: boolean;
  /** Whether the success publication transaction may run at all. */
  readonly mayPublish: boolean;
}

/**
 * Frozen disposition for every terminal cause.
 *
 * - SUCCESS alone may publish, and only through the atomic transaction.
 * - CANCELLED purges with no digest and no quarantine (operator intent).
 * - RESET_INTERRUPTED purges and never continues the take (new take needed).
 * - FAILED outcomes (capture loss, encoder, validation, diagnostic) retain
 *   one bounded diagnostic partial quarantined under TEMP, never published.
 * - INCOMPLETE outcomes (low disk, app close, preflight, startup) purge temp
 *   with no diagnostic copy (low-disk especially must not write more).
 */
export function dispositionForCause(
  cause: RecordingTerminalCause,
): TakeDisposition {
  const outcome = TERMINAL_CAUSE_TO_OUTCOME[cause];
  switch (cause) {
    case "SUCCESS":
      return {
        outcome,
        publication: "PUBLISHED",
        temp: "PUBLISH_VIA_TRANSACTION",
        retainDiagnostic: false,
        mayPublish: true,
      };
    case "OPERATOR_CANCELLED":
      return {
        outcome,
        publication: "PURGED",
        temp: "PURGE",
        retainDiagnostic: false,
        mayPublish: false,
      };
    case "RESET_INTERRUPTED":
      return {
        outcome,
        publication: "NOT_CREATED",
        temp: "PURGE",
        retainDiagnostic: false,
        mayPublish: false,
      };
    case "CAPTURE_SOURCE_LOST":
    case "ENCODER_FAILED":
    case "MEDIA_VALIDATION_FAILED":
    case "DIAGNOSTIC_PARTIAL":
      return {
        outcome,
        publication: "QUARANTINED",
        temp: "QUARANTINE",
        retainDiagnostic: true,
        mayPublish: false,
      };
    case "LOW_DISK_ABORT":
    case "APP_CLOSED":
    case "PREFLIGHT_REFUSED":
    case "STARTUP_TIMEOUT":
      return {
        outcome,
        publication: "NOT_CREATED",
        temp: "PURGE",
        retainDiagnostic: false,
        mayPublish: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Capture starvation tracker (2 s fail-closed, injected clock, no sleeps)
// ---------------------------------------------------------------------------

/**
 * Tracks valid-frame progress for one take. The capture session owns frame
 * acceptance; this tracker owns the lifecycle policy: no valid frame for
 * 2 s or more is terminal (CAPTURE_SOURCE_LOST). Grace inside the window is
 * allowed (a single slow tick is not failure); at or beyond the bound the
 * take can never succeed — black-video PASS is impossible by construction.
 */
export class SourceStarvationTracker {
  private readonly nowMs: () => number;
  private readonly starvationMs: number;
  private baselineMs: number | null = null;

  constructor(input: { nowMs: () => number; starvationMs?: number }) {
    if (input.starvationMs !== undefined) {
      if (!Number.isInteger(input.starvationMs) || input.starvationMs <= 0) {
        throw new Error("[TIMELINE_INVALID] starvation bound must be a positive integer");
      }
      this.starvationMs = input.starvationMs;
    } else {
      this.starvationMs = NO_VALID_FRAME_MS;
    }
    this.nowMs = input.nowMs;
  }

  /** Marks take start / acquisition start (progress baseline). */
  noteStart(): void {
    this.baselineMs = this.nowMs();
  }

  /** Marks one valid captured frame (progress). */
  noteValidFrame(): void {
    this.baselineMs = this.nowMs();
  }

  /** Milliseconds since last progress, or null before start. */
  starvedForMs(): number | null {
    if (this.baselineMs === null) return null;
    return Math.max(0, this.nowMs() - this.baselineMs);
  }

  /** True once the no-valid-frame bound is reached (terminal). */
  isStarved(): boolean {
    const starved = this.starvedForMs();
    if (starved === null) return false;
    return starved >= this.starvationMs;
  }
}

// ---------------------------------------------------------------------------
// Bounded shutdown plan (10 s barrier caps the 30 s flush)
// ---------------------------------------------------------------------------

export type ShutdownStrategy = "FLUSH_WITHIN_BUDGET" | "ABORT_OWNED";

/**
 * Resolves the shutdown strategy from elapsed barrier time. A graceful
 * flush is attempted only while barrier budget remains; once the budget is
 * spent the owned encoder is aborted without waiting. The 30 s encoder
 * flush therefore can never violate the 10 s application barrier: the flush
 * attempt is capped by the remaining budget, then owned abort takes over.
 * Only the owned handle is ever signalled — never a global sweep.
 */
export function shutdownStrategyForElapsed(elapsedMs: number): ShutdownStrategy {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "ABORT_OWNED";
  return elapsedMs < RECORDER_SHUTDOWN_BARRIER_MS
    ? "FLUSH_WITHIN_BUDGET"
    : "ABORT_OWNED";
}

/** Remaining barrier budget in ms (floor 0, never negative). */
export function shutdownBudgetLeftMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  return Math.max(0, RECORDER_SHUTDOWN_BARRIER_MS - Math.floor(elapsedMs));
}
