// P9.6 Safety — public seam for disk/failure/lifecycle policy.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 16, 19, 21-23.
// Pure policy + composition only (no filesystem, no processes, no timers of
// its own, no renderer contact). The Main-side file owner lives beside the
// media owner and executes the plans decided here.

export {
  BoundedDiskWatcher,
  evaluateVolumePreflight,
  estimateTakeFinalBytes,
  mustAbortTakeForDisk,
  requiredTakeFreeBytes,
  SAFETY_LOW_SPACE_BYTES,
  SAFETY_MAX_BILLABLE_S,
  SAFETY_MAX_TAKE_S,
  SAFETY_POLL_MS,
  SAFETY_PREFLIGHT_FLOOR_BYTES,
  type DiskWatcherScheduler,
  type LowSpaceReason,
  type PreflightRefusal,
  type VolumePreflightInput,
  type VolumePreflightVerdict,
} from "./disk-safety.ts";
export {
  dispositionForCause,
  shutdownBudgetLeftMs,
  shutdownStrategyForElapsed,
  SourceStarvationTracker,
  SAFETY_ENCODER_FLUSH_MS,
  SAFETY_SHUTDOWN_BARRIER_MS,
  SAFETY_STARVATION_MS,
  type ShutdownStrategy,
  type TakeDisposition,
  type TempDisposition,
} from "./failure-policy.ts";
export {
  confirmTempCleanup,
  evaluatePublicationGate,
  planPublicationTransaction,
  planRollbackForCompleted,
  type CleanupConfirmation,
  type PublicationGate,
  type PublicationOp,
  type PublicationReadiness,
  type PublicationRefusal,
} from "./publication.ts";
export {
  ANCHORS_TEMP_NAME,
  DIAGNOSTIC_PARTIAL_SUFFIX,
  MANIFEST_TEMP_NAME,
  TAKE_LOCK_NAME,
  TEMP_PARTIAL_NAME,
  classifyRecoveryEntry,
  planRecoveryAction,
  plansMatch,
  type OrphanEntry,
  type OrphanKind,
  type RecoveryAction,
  type RecoveryPolicy,
} from "./recovery.ts";
export {
  TakeSafetyController,
  type ControlledTakeFiles,
  type ControlledTakeHandle,
  type ControlledTakeOwner,
  type GuardedStartInput,
  type GuardedStartResult,
  type OwnerAbortCause,
  type OwnerAbortSummary,
  type SafetyControllerOptions,
  type SafetyEvent,
} from "./controller.ts";
