// P9.1 Disk Budget: footprint estimator + preflight/low-space policy.
//
// Canonical authority: P9-DESIGN-SPEC.md Section 21 (Disk Safety).
// Pure math only: every function takes explicit byte/second inputs and
// returns a verdict. No filesystem access, no process state — the
// RecordingHost (P9.5/P9.6) supplies measured free bytes at the call site.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Frozen Policy Constants (P9-DESIGN-SPEC Section 21)
// ---------------------------------------------------------------------------

/** Conservative ceiling encode rate for desktop content: 2.0 MB/s. */
export const CEILING_BYTES_PER_SECOND = 2_000_000;

/** Preflight floor: refuse below 2 GiB regardless of estimate. */
export const PREFLIGHT_MIN_FREE_BYTES = 2_147_483_648;

/** Estimate multiplier: budget 3x the estimated final. */
export const PREFLIGHT_ESTIMATE_MULTIPLIER = 3;

/** Runtime low-space abort threshold: 1 GiB free. */
export const LOW_SPACE_ABORT_BYTES = 1_073_741_824;

/** Free-space poll cadence during acquisition: every 5 s. */
export const DISK_POLL_INTERVAL_MS = 5_000;

/** Acquisition startup timeout: first frame within 15 s. */
export const ACQUISITION_STARTUP_TIMEOUT_MS = 15_000;

/** Recorder shutdown barrier: 10 s (P8 barrier pattern). */
export const RECORDER_SHUTDOWN_BARRIER_MS = 10_000;

/** Encoder flush timeout before scoped terminate: 30 s. */
export const ENCODER_FLUSH_TIMEOUT_MS = 30_000;

/** Max billable lesson seconds for estimates (P8 session ceiling 30 min). */
export const MAX_BILLABLE_LESSON_S = 1_800;

/** Bounded post-record tail: 2 s. */
export const RECORDING_TAIL_S = 2;

// ---------------------------------------------------------------------------
// Estimator (P9-DESIGN-SPEC Section 3 footprint model)
// ---------------------------------------------------------------------------

/**
 * Conservative final-size estimate:
 * estimated_final = min(expected_lesson_s, 1800) x 2.0 MB/s.
 * Peak temp ~= final + sidecar + logs + manifest draft (2x final budget).
 */
export function estimateFinalBytes(expectedLessonS: number): number {
  if (!Number.isFinite(expectedLessonS) || expectedLessonS < 0) {
    throw new Error("[DISK_BUDGET_INVALID] expected lesson seconds must be >= 0");
  }
  const billable = Math.min(Math.floor(expectedLessonS), MAX_BILLABLE_LESSON_S);
  return billable * CEILING_BYTES_PER_SECOND;
}

/** Required free bytes for preflight: max(2 GiB, estimated_final x 3). */
export function requiredFreeBytes(expectedLessonS: number): number {
  const estimated = estimateFinalBytes(expectedLessonS);
  return Math.max(PREFLIGHT_MIN_FREE_BYTES, estimated * PREFLIGHT_ESTIMATE_MULTIPLIER);
}

export const DiskPreflightInputSchema = z.strictObject({
  free_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expected_lesson_s: z.number().min(0).max(7_200),
});
export type DiskPreflightInput = z.infer<typeof DiskPreflightInputSchema>;

export interface DiskPreflightVerdict {
  ok: boolean;
  reason: "SUFFICIENT" | "BELOW_FLOOR" | "BELOW_ESTIMATE";
  free_bytes: number;
  required_bytes: number;
  estimated_final_bytes: number;
}

/** Refuse-to-start gate, evaluated Main-side before encoder spawn. */
export function checkDiskPreflight(input: DiskPreflightInput): DiskPreflightVerdict {
  const parsed = DiskPreflightInputSchema.parse(input);
  const estimated = estimateFinalBytes(parsed.expected_lesson_s);
  const required = requiredFreeBytes(parsed.expected_lesson_s);
  if (parsed.free_bytes < PREFLIGHT_MIN_FREE_BYTES) {
    return {
      ok: false,
      reason: "BELOW_FLOOR",
      free_bytes: parsed.free_bytes,
      required_bytes: required,
      estimated_final_bytes: estimated,
    };
  }
  if (parsed.free_bytes < required) {
    return {
      ok: false,
      reason: "BELOW_ESTIMATE",
      free_bytes: parsed.free_bytes,
      required_bytes: required,
      estimated_final_bytes: estimated,
    };
  }
  return {
    ok: true,
    reason: "SUFFICIENT",
    free_bytes: parsed.free_bytes,
    required_bytes: required,
    estimated_final_bytes: estimated,
  };
}

/** Runtime monitor predicate: abort the take at 1 GiB free. */
export function shouldAbortOnLowSpace(freeBytes: number): boolean {
  if (!Number.isInteger(freeBytes) || freeBytes < 0) {
    throw new Error("[DISK_BUDGET_INVALID] free bytes must be an integer >= 0");
  }
  return freeBytes < LOW_SPACE_ABORT_BYTES;
}
