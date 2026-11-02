// P9.6 Atomic Publication — success gate + transaction plan + rollback.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 15, 20, 22 and the
// P9.1 manifest invariants (RecordingManifestSchema).
//
// Pure policy only: decides whether a take may publish, plans the ordered
// rename transaction, and plans rollback for partial failure. No filesystem,
// no processes, no timers. The Main-side file owner executes the plan with
// real renames; this module keeps the ordering, fencing, and fail-closed
// uncertainty rules deterministic and unit-testable.
//
// Publication strategy: temporary validated artifacts become final only via
// same-volume atomic renames in a fixed order (media, manifest, anchors),
// followed by a set verification. If any rename fails, completed renames
// are rolled back so no set can ever appear fully published. The manifest
// acts as the commit marker: a final set without a matching manifest is
// never treated as complete.

import { MAX_TAKE_DURATION_US } from "../protocol.ts";

// ---------------------------------------------------------------------------
// Success publication invariant (all must hold, else NOT PUBLISHED)
// ---------------------------------------------------------------------------

export interface PublicationReadiness {
  /** Runtime/take outcome is COMPLETED/SUCCESS. */
  readonly outcomeCompleted: boolean;
  /** Encoder flush succeeded (exit 0, intake drained). */
  readonly encoderFlushOk: boolean;
  /** Media validation verdict is PASS. */
  readonly mediaValidationPass: boolean;
  /** Encoded frame count is greater than zero. */
  readonly frameCount: number;
  /** Validated media frame count from ffprobe (nb_frames). */
  readonly mediaFrameCount?: number | null;
  /** Manifest schema version string. Defaults to "1.1" when omitted. */
  readonly manifestVersion?: string;
  /** Native captured frame count. */
  readonly capturedFrameCount?: number;
  /** Take duration in microseconds (valid, nonzero, within ceiling). */
  readonly durationUs: number;
  /** Timeline/anchors are valid (no TIMELINE_INVALID latch). */
  readonly timelineValid: boolean;
  /** Anchor sidecar parses and matches the fence. */
  readonly anchorsValid: boolean;
  /** Manifest parses against the frozen schema. */
  readonly manifestValid: boolean;
  /** SHA-256 digest of the final media bytes is present. */
  readonly digestPresent: boolean;
  /** Disk is still safe (post-take recheck passed). */
  readonly diskStillSafe: boolean;
  /** Media, manifest, and anchors share one fence (no mixed takes). */
  readonly sameFence: boolean;
}

export type PublicationRefusal =
  | "OUTCOME_NOT_COMPLETED"
  | "ENCODER_FLUSH_FAILED"
  | "MEDIA_VALIDATION_FAILED"
  | "ZERO_FRAMES"
  | "DURATION_INVALID"
  | "TIMELINE_INVALID"
  | "ANCHORS_INVALID"
  | "MANIFEST_INVALID"
  | "DIGEST_MISSING"
  | "DISK_UNSAFE"
  | "FENCE_MISMATCH"
  | "MANIFEST_VERSION_STALE"
  | "MEDIA_COUNT_UNAVAILABLE"
  | "MANIFEST_MEDIA_MISMATCH"
  | "DURATION_SLOTS_MISMATCH"
  | "FIRST_FRAME_ABSENT";

export type PublicationGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PublicationRefusal };

/**
 * Evaluates the success publication invariant in canonical order and
 * returns the first refusal. Every condition must succeed; any failure
 * means NOT PUBLISHED (fail closed, single deterministic reason).
 */
export function evaluatePublicationGate(
  input: PublicationReadiness,
): PublicationGate {
  if (!input.outcomeCompleted) return { ok: false, reason: "OUTCOME_NOT_COMPLETED" };
  if (!input.encoderFlushOk) return { ok: false, reason: "ENCODER_FLUSH_FAILED" };
  if (!input.mediaValidationPass) return { ok: false, reason: "MEDIA_VALIDATION_FAILED" };
  if (!Number.isInteger(input.frameCount) || input.frameCount <= 0) {
    return { ok: false, reason: "ZERO_FRAMES" };
  }
  if (
    !Number.isInteger(input.durationUs) ||
    input.durationUs <= 0 ||
    input.durationUs > MAX_TAKE_DURATION_US
  ) {
    return { ok: false, reason: "DURATION_INVALID" };
  }
  if (!input.timelineValid) return { ok: false, reason: "TIMELINE_INVALID" };
  if (!input.anchorsValid) return { ok: false, reason: "ANCHORS_INVALID" };
  if (!input.manifestValid) return { ok: false, reason: "MANIFEST_INVALID" };
  if (!input.digestPresent) return { ok: false, reason: "DIGEST_MISSING" };
  if (!input.diskStillSafe) return { ok: false, reason: "DISK_UNSAFE" };
  if (!input.sameFence) return { ok: false, reason: "FENCE_MISMATCH" };

  // (P1) Manifest version must be current (1.1).
  if (input.manifestVersion !== undefined && input.manifestVersion !== "1.1") {
    return { ok: false, reason: "MANIFEST_VERSION_STALE" };
  }

  // (P4) Captured frame count must be >= 1 (readiness contract: no take without real content).
  if (input.capturedFrameCount !== undefined && input.capturedFrameCount < 1) {
    return { ok: false, reason: "FIRST_FRAME_ABSENT" };
  }

  // (P2) Manifest encoded count must reconcile with validated ffprobe media frame count.
  if (input.mediaFrameCount !== undefined) {
    if (
      input.mediaFrameCount === null ||
      input.mediaFrameCount <= 0 ||
      !Number.isInteger(input.mediaFrameCount)
    ) {
      return { ok: false, reason: "MEDIA_COUNT_UNAVAILABLE" };
    }
    if (input.frameCount !== input.mediaFrameCount) {
      return { ok: false, reason: "MANIFEST_MEDIA_MISMATCH" };
    }
  }

  // (P3) Duration must be consistent with CFR slots (within ±2 s tolerance).
  const expectedCfrUs = Math.floor(((input.frameCount - 1) * 1_000_000) / 30);
  if (Math.abs(input.durationUs - expectedCfrUs) > 2_000_000) {
    return { ok: false, reason: "DURATION_SLOTS_MISMATCH" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Transaction plan (fixed order, single attempt, rollback on partial)
// ---------------------------------------------------------------------------

export type PublicationOp =
  | "WRITE_MANIFEST_TEMP"
  | "WRITE_ANCHORS_TEMP"
  | "RENAME_MEDIA"
  | "RENAME_MANIFEST"
  | "RENAME_ANCHORS"
  | "VERIFY_SET"
  | "CLEANUP_STAGING";

/**
 * Fixed transaction order. Staging writes land beside the partial media;
 * final names appear only through renames, media first so the digest the
 * manifest commits to already names existing bytes; the manifest rename is
 * the commit marker; anchors follow; verification proves the complete set;
 * staging cleanup runs last and never affects the verdict.
 */
export function planPublicationTransaction(): readonly PublicationOp[] {
  return [
    "WRITE_MANIFEST_TEMP",
    "WRITE_ANCHORS_TEMP",
    "RENAME_MEDIA",
    "RENAME_MANIFEST",
    "RENAME_ANCHORS",
    "VERIFY_SET",
    "CLEANUP_STAGING",
  ];
}

/**
 * Rollback for a transaction that failed partway: removes every final the
 * failed run created (reverse order), so the delivery root can never hold
 * a set that looks complete. Staging temps are purged best-effort after.
 * Rollback runs once; its own uncertainty is reported, never retried blindly
 * (no duplicate publication attempts).
 */
export function planRollbackForCompleted(
  completed: readonly PublicationOp[],
): readonly PublicationOp[] {
  const undo: PublicationOp[] = [];
  if (completed.includes("RENAME_ANCHORS")) undo.push("RENAME_ANCHORS");
  if (completed.includes("RENAME_MANIFEST")) undo.push("RENAME_MANIFEST");
  if (completed.includes("RENAME_MEDIA")) undo.push("RENAME_MEDIA");
  return undo;
}

// ---------------------------------------------------------------------------
// Cleanup confirmation (CLEANUP_UNCONFIRMED fails closed)
// ---------------------------------------------------------------------------

export type CleanupConfirmation = "CONFIRMED" | "UNCONFIRMED";

/**
 * Confirms temp removal ownership: every expected removal must report gone
 * with nothing still present. Any surviving artifact, or any removal whose
 * outcome cannot be proven, yields UNCONFIRMED — the caller must report
 * CLEANUP_UNCONFIRMED (UNCERTAIN_DO_NOT_RETRY) and must not claim
 * CLOSED/PUBLISHED success.
 */
export function confirmTempCleanup(
  removals: readonly { readonly removed: boolean; readonly stillPresent: boolean }[],
): CleanupConfirmation {
  for (const removal of removals) {
    if (!removal.removed || removal.stillPresent) return "UNCONFIRMED";
  }
  return "CONFIRMED";
}
