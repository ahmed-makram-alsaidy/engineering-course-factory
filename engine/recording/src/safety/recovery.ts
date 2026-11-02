// P9.6 Crash / Restart Recovery — scoped orphan detection + idempotent plan.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 12, 19 (crash
// recovery: next launch cleans orphan partials only inside the recording
// temp dir, never broad temp deletion).
//
// Pure policy only: classifies directory names found under the canonical
// P9 recording temp root and plans one deterministic action per entry. No
// filesystem, no processes. The Main-side sweeper lists the single trusted
// directory, feeds names here, and executes the returned plan.
//
// Safety rules enforced here:
// - Only P9-owned file shapes are ever actionable; anything else is FOREIGN
//   and ignored (never deleted because a name contains "partial").
// - Entries belonging to the currently active take are kept, never touched.
// - Recovery never resumes: no old encoder is restarted, no MP4 is appended
//   to, no generation or take is continued. A new recording is a new take.
// - Running recovery twice plans the same actions (idempotent).

// ---------------------------------------------------------------------------
// Owned file shapes (exact names; the take dir adds the fence)
// ---------------------------------------------------------------------------

/** Canonical temp partial media produced by the encoder owner. */
export const TEMP_PARTIAL_NAME = "screen.partial.mp4";

/** Quarantined diagnostic partial (TEMP only, clearly named, not output). */
export const DIAGNOSTIC_PARTIAL_SUFFIX = ".diagnostic.partial.mp4";

/** Staged manifest temp (never a final name before validation). */
export const MANIFEST_TEMP_NAME = "manifest.partial.json";

/** Staged anchors temp (never a final name before validation). */
export const ANCHORS_TEMP_NAME = "anchors.partial.jsonl";

/** Take ownership marker (bounded, trusted, removed on confirmed cleanup). */
export const TAKE_LOCK_NAME = "take.lock";

/** Final delivery names use the take base; these must never appear in temp. */
const FINAL_MEDIA_SUFFIX = ".mp4";
const FINAL_MANIFEST_SUFFIX = ".manifest.json";
const FINAL_ANCHORS_SUFFIX = ".anchors.jsonl";

export type OrphanKind =
  | "PARTIAL"
  | "DIAGNOSTIC"
  | "MANIFEST_TEMP"
  | "ANCHORS_TEMP"
  | "LOCK"
  | "FOREIGN";

export interface OrphanEntry {
  readonly name: string;
  readonly kind: OrphanKind;
  /** True when the entry belongs to the currently active take (keep). */
  readonly ownedByActive: boolean;
}

/**
 * Classifies one directory entry by exact P9-owned shape. Ownership comes
 * from the caller matching the entry's take dir against the active fence;
 * a bare filename alone never proves ownership.
 */
export function classifyRecoveryEntry(input: {
  name: string;
  ownedByActive: boolean;
}): OrphanEntry {
  const { name, ownedByActive } = input;
  if (name === TEMP_PARTIAL_NAME) {
    return { name, kind: "PARTIAL", ownedByActive };
  }
  if (name === MANIFEST_TEMP_NAME) {
    return { name, kind: "MANIFEST_TEMP", ownedByActive };
  }
  if (name === ANCHORS_TEMP_NAME) {
    return { name, kind: "ANCHORS_TEMP", ownedByActive };
  }
  if (name === TAKE_LOCK_NAME) {
    return { name, kind: "LOCK", ownedByActive };
  }
  if (
    name.endsWith(DIAGNOSTIC_PARTIAL_SUFFIX) &&
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\")
  ) {
    return { name, kind: "DIAGNOSTIC", ownedByActive };
  }
  // Final delivery names must never be trusted inside temp: treat as
  // foreign (a stray final-looking file is evidence, not output).
  if (
    name.endsWith(FINAL_MANIFEST_SUFFIX) ||
    name.endsWith(FINAL_ANCHORS_SUFFIX) ||
    (name.endsWith(FINAL_MEDIA_SUFFIX) &&
      !name.endsWith(".partial.mp4") &&
      !name.endsWith(DIAGNOSTIC_PARTIAL_SUFFIX))
  ) {
    return { name, kind: "FOREIGN", ownedByActive };
  }
  return { name, kind: "FOREIGN", ownedByActive };
}

export type RecoveryAction = "PURGE" | "KEEP_DIAGNOSTIC" | "IGNORE" | "KEEP_ACTIVE";

export interface RecoveryPolicy {
  /**
   * Disposition for stale (non-active) orphan entries: purge them, or keep
   * recognized diagnostics as incomplete evidence. Diagnostics are never
   * resumed and never published.
   */
  readonly staleDisposition: "PURGE" | "KEEP_DIAGNOSTIC";
}

/**
 * Plans one deterministic action per entry. Active-take entries are always
 * kept; foreign entries are always ignored; stale P9-owned entries follow
 * the policy. The plan contains no resume operation by construction.
 */
export function planRecoveryAction(
  entry: OrphanEntry,
  policy: RecoveryPolicy,
): RecoveryAction {
  if (entry.ownedByActive) return "KEEP_ACTIVE";
  switch (entry.kind) {
    case "FOREIGN":
      return "IGNORE";
    case "DIAGNOSTIC":
      return policy.staleDisposition === "KEEP_DIAGNOSTIC"
        ? "KEEP_DIAGNOSTIC"
        : "PURGE";
    case "PARTIAL":
    case "MANIFEST_TEMP":
    case "ANCHORS_TEMP":
    case "LOCK":
      return "PURGE";
  }
}

/**
 * True when re-running recovery over the same entries yields the same plan
 * (the planner is a pure function of entry + policy, so repeats agree).
 */
export function plansMatch(
  first: readonly RecoveryAction[],
  second: readonly RecoveryAction[],
): boolean {
  if (first.length !== second.length) return false;
  for (let i = 0; i < first.length; i += 1) {
    if (first[i] !== second[i]) return false;
  }
  return true;
}
