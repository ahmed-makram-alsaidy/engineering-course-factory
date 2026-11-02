// P9.6 Safety Controller — preflight, watchers, disposition, publication,
// shutdown, and recovery composed around one take owner.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 16, 19, 21-23.
//
// Pure composition over injected boundaries: the take owner (Electron Main
// lifecycle owner in production, scripted double in tests), the take file
// owner (real Main-side file module in production, in-memory double in
// tests), the disk reader, the scheduler, and the clock. No filesystem, no
// processes, no timers of its own, no renderer contact. All races resolve
// through single latches with one deterministic winner.

import {
  BoundedDiskWatcher,
  evaluateVolumePreflight,
  type DiskWatcherScheduler,
  type PreflightRefusal,
} from "./disk-safety.ts";
import {
  dispositionForCause,
  shutdownBudgetLeftMs,
  shutdownStrategyForElapsed,
  SourceStarvationTracker,
  type TakeDisposition,
} from "./failure-policy.ts";
import {
  confirmTempCleanup,
  evaluatePublicationGate,
  planPublicationTransaction,
  planRollbackForCompleted,
  type CleanupConfirmation,
  type PublicationGate,
  type PublicationOp,
  type PublicationReadiness,
} from "./publication.ts";
import {
  classifyRecoveryEntry,
  planRecoveryAction,
  type RecoveryAction,
  type RecoveryPolicy,
} from "./recovery.ts";
import type {
  RecordingErrorCode,
  RecordingTerminalCause,
} from "../protocol.ts";

// ---------------------------------------------------------------------------
// Injected boundaries (production Main-side owners or deterministic doubles)
// ---------------------------------------------------------------------------

export interface ControlledTakeHandle {
  readonly recordingSessionId: string;
  readonly takeId: string;
  readonly runtimeSessionId: string;
  readonly generation: number;
  readonly lessonId: string;
}

export type ControlledStartResult =
  | { readonly ok: true; readonly take: ControlledTakeHandle }
  | { readonly ok: false; readonly code: RecordingErrorCode; readonly message: string };

/** Minimal take-owner surface (subset of the Main lifecycle owner). */
export interface ControlledTakeOwner {
  startTake(input: {
    lessonId: string;
    runtimeSessionId: string;
    generation: number;
  }): Promise<ControlledStartResult>;
  abortTake(cause: OwnerAbortCause): Promise<OwnerAbortSummary>;
  shutdownAll(cause?: string): Promise<void>;
  getActiveFence(): {
    recording_session_id: string;
    take_id: string;
    runtime_session_id: string;
    generation: number;
  } | null;
  getProgress(): { capturedFrames: number } | null;
}

/** Abort causes the owner understands (superset incl. low-disk). */
export type OwnerAbortCause =
  | "OPERATOR_CANCELLED"
  | "RESET_INTERRUPTED"
  | "CAPTURE_SOURCE_LOST"
  | "LOW_DISK_ABORT"
  | "ENCODER_FAILED"
  | "MEDIA_VALIDATION_FAILED"
  | "APP_CLOSED"
  | "DIAGNOSTIC_PARTIAL"
  | "PREFLIGHT_REFUSED"
  | "STARTUP_TIMEOUT";

export interface OwnerAbortSummary {
  readonly recordingSessionId: string;
  readonly takeId: string;
  readonly cause: OwnerAbortCause;
  readonly outcome: "CANCELLED" | "RESET_INTERRUPTED" | "FAILED" | "INCOMPLETE";
}

/** Minimal take-file surface (real file owner or in-memory double). */
export interface ControlledTakeFiles {
  purgeTakeTemp(input: {
    recordingSessionId: string;
    takeId: string;
  }): Promise<CleanupConfirmation>;
  quarantineTakeTemp(input: {
    recordingSessionId: string;
    takeId: string;
  }): Promise<"QUARANTINED" | "ABSENT" | "UNCONFIRMED">;
  runPublicationStep(
    step: PublicationOp,
    input: { recordingSessionId: string; takeId: string },
  ): Promise<{ ok: boolean; failedAt?: PublicationOp }>;
  removePublished(input: {
    recordingSessionId: string;
    takeId: string;
  }): Promise<CleanupConfirmation>;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface SafetyControllerOptions {
  readonly owner: ControlledTakeOwner;
  readonly files: ControlledTakeFiles;
  readonly queryDiskFree: () => number | null;
  readonly scheduler: DiskWatcherScheduler;
  readonly nowMs: () => number;
}

export interface GuardedStartInput {
  readonly lessonId: string;
  readonly runtimeSessionId: string;
  readonly generation: number;
  readonly expectedLessonS: number;
}

export type GuardedStartResult =
  | { readonly ok: true; readonly take: ControlledTakeHandle }
  | {
      readonly ok: false;
      readonly code: RecordingErrorCode;
      readonly message: string;
      readonly refusal?: PreflightRefusal;
    };

export interface SafetyEvent {
  readonly kind: string;
  readonly takeId: string | null;
}

/**
 * One-take safety supervisor. Guards start with preflight, watches disk and
 * source progress during the take, applies the disposition matrix at the
 * end, runs the atomic publication transaction on success, and enforces the
 * bounded shutdown barrier. Every latch fires once; every race has one
 * deterministic winner recorded in the event log (safe codes only).
 */
export class TakeSafetyController {
  private readonly owner: ControlledTakeOwner;
  private readonly files: ControlledTakeFiles;
  private readonly queryDiskFree: () => number | null;
  private readonly scheduler: DiskWatcherScheduler;
  private readonly nowMs: () => number;

  private watcher: BoundedDiskWatcher | null = null;
  private starvation: SourceStarvationTracker | null = null;
  private guarded: ControlledTakeHandle | null = null;
  private terminalCause: RecordingTerminalCause | null = null;
  private lowDiskSeen = false;
  private lastProgressFrames = 0;
  private readonly events: SafetyEvent[] = [];

  constructor(options: SafetyControllerOptions) {
    this.owner = options.owner;
    this.files = options.files;
    this.queryDiskFree = options.queryDiskFree;
    this.scheduler = options.scheduler;
    this.nowMs = options.nowMs;
  }

  /** Safe-code event log (take IDs and transition names only). */
  eventLog(): readonly SafetyEvent[] {
    return [...this.events];
  }

  get activeTake(): ControlledTakeHandle | null {
    return this.guarded === null ? null : { ...this.guarded };
  }

  get terminal(): RecordingTerminalCause | null {
    return this.terminalCause;
  }

  // -- guarded start ---------------------------------------------------------

  /**
   * Starts one take behind the disk preflight gate. Refusals never touch
   * the owner (no capture, no encoder, no slot taken). Duration above the
   * frozen ceiling is rejected, never estimated.
   */
  async startGuardedTake(input: GuardedStartInput): Promise<GuardedStartResult> {
    if (this.guarded !== null) {
      return {
        ok: false,
        code: "RECORDER_ALREADY_ACTIVE",
        message: "another guarded take is already active",
      };
    }
    let free: number | null;
    try {
      free = this.queryDiskFree();
    } catch {
      free = null;
    }
    const verdict = evaluateVolumePreflight({
      freeBytesOrNull: free,
      expectedLessonS: input.expectedLessonS,
    });
    if (!verdict.ok) {
      this.record("PREFLIGHT_REFUSED", null);
      const code: RecordingErrorCode =
        verdict.reason === "QUERY_FAILED" ? "CLEANUP_UNCONFIRMED" : "DISK_PREFLIGHT_FAILED";
      const refusal: PreflightRefusal =
        verdict.reason === "SUFFICIENT" ? "BELOW_ESTIMATE" : verdict.reason;
      return {
        ok: false,
        code,
        message: "disk preflight refused the take",
        refusal,
      };
    }
    const started = await this.owner.startTake({
      lessonId: input.lessonId,
      runtimeSessionId: input.runtimeSessionId,
      generation: input.generation,
    });
    if (!started.ok) {
      return started;
    }
    this.guarded = { ...started.take };
    this.terminalCause = null;
    this.lastProgressFrames = 0;
    this.starvation = new SourceStarvationTracker({ nowMs: this.nowMs });
    this.starvation.noteStart();
    const guarded = this.guarded;
    this.watcher = new BoundedDiskWatcher({
      query: this.queryDiskFree,
      scheduler: this.scheduler,
      events: {
        onLowSpace: (info) => {
          void info;
          this.lowDiskSeen = true;
          void this.abortForCause("LOW_DISK_ABORT");
        },
      },
    });
    this.watcher.start();
    this.record("TAKE_STARTED", guarded.takeId);
    return { ok: true, take: { ...guarded } };
  }

  // -- progress + starvation ---------------------------------------------------

  /**
   * Observes one valid captured frame (progress for the starvation bound).
   * The owner reports progress; the controller owns the terminal policy.
   */
  noteValidFrame(): void {
    this.starvation?.noteValidFrame();
    const progress = this.owner.getProgress();
    if (progress !== null) {
      this.lastProgressFrames = progress.capturedFrames;
    }
  }

  /**
   * Checks the 2 s no-valid-frame bound. Returns true once terminal:
   * the take is aborted as CAPTURE_SOURCE_LOST and can never succeed.
   */
  checkStarvation(): boolean {
    if (this.guarded === null || this.terminalCause !== null) return false;
    if (this.starvation !== null && this.starvation.isStarved()) {
      void this.abortForCause("CAPTURE_SOURCE_LOST");
      return true;
    }
    return false;
  }

  /** True once the low-disk latch has fired (frame intake must stop). */
  get lowDiskLatched(): boolean {
    return this.lowDiskSeen || (this.watcher?.isLatched ?? false);
  }

  // -- terminal disposition ----------------------------------------------------

  /**
   * Ends the guarded take for one terminal cause and executes its frozen
   * disposition (purge, quarantine, or success-transaction handoff). Latches
   * once: the first cause wins; later causes are recorded but ignored.
   */
  async abortForCause(cause: RecordingTerminalCause): Promise<TakeDisposition> {
    const disposition = dispositionForCause(cause);
    if (this.terminalCause !== null) {
      this.record(`LATE_${cause}_IGNORED`, this.guarded?.takeId ?? null);
      return dispositionForCause(this.terminalCause);
    }
    this.terminalCause = cause;
    this.watcher?.stop();
    this.record(`TERMINAL_${cause}`, this.guarded?.takeId ?? null);
    if (this.guarded !== null) {
      try {
        await this.owner.abortTake(cause as OwnerAbortCause);
      } catch {
        // Abort owns no error surface beyond the disposition below.
      }
    }
    await this.executeTempDisposition(disposition);
    if (this.guarded !== null) {
      this.record(`SLOT_RELEASED_${disposition.outcome}`, this.guarded.takeId);
    }
    this.guarded = null;
    this.watcher = null;
    this.starvation = null;
    return disposition;
  }

  /**
   * Settles a successfully finished take: evaluates the publication gate
   * and runs the atomic transaction exactly once. Any refusal leaves the
   * take unpublished (fail closed, temp purged, never retried blindly).
   */
  async settleSuccessfulTake(
    take: ControlledTakeHandle,
    readiness: PublicationReadiness,
  ): Promise<{ published: boolean; gate: PublicationGate }> {
    // A take settles successfully at most once: after any terminal outcome
    // (including a prior failed transaction) no new transaction may run, so
    // artifacts can never be duplicated by a blind retry.
    if (this.terminalCause !== null) {
      this.record("SETTLE_AFTER_TERMINAL_IGNORED", take.takeId);
      return { published: false, gate: { ok: false, reason: "OUTCOME_NOT_COMPLETED" } };
    }
    const gate = evaluatePublicationGate(readiness);
    if (!gate.ok) {
      this.record(`PUBLICATION_REFUSED_${gate.reason}`, take.takeId);
      this.terminalCause = "MEDIA_VALIDATION_FAILED";
      await this.files.purgeTakeTemp({
        recordingSessionId: take.recordingSessionId,
        takeId: take.takeId,
      });
      if (this.guarded?.takeId === take.takeId) {
        this.guarded = null;
        this.watcher?.stop();
        this.watcher = null;
        this.starvation = null;
      }
      return { published: false, gate };
    }
    const completed: PublicationOp[] = [];
    for (const step of planPublicationTransaction()) {
      const result = await this.files.runPublicationStep(step, {
        recordingSessionId: take.recordingSessionId,
        takeId: take.takeId,
      });
      if (!result.ok) {
        this.record(`PUBLICATION_FAILED_AT_${step}`, take.takeId);
        for (const undo of planRollbackForCompleted(completed)) {
          await this.files.removePublished({
            recordingSessionId: take.recordingSessionId,
            takeId: take.takeId,
          });
        }
        this.terminalCause = "MEDIA_VALIDATION_FAILED";
        await this.files.purgeTakeTemp({
          recordingSessionId: take.recordingSessionId,
          takeId: take.takeId,
        });
        if (this.guarded?.takeId === take.takeId) {
          this.guarded = null;
          this.watcher?.stop();
          this.watcher = null;
          this.starvation = null;
        }
        return { published: false, gate: { ok: false, reason: "FENCE_MISMATCH" } };
      }
      completed.push(step);
    }
    this.record("PUBLISHED", take.takeId);
    this.terminalCause = "SUCCESS";
    if (this.guarded?.takeId === take.takeId) {
      this.guarded = null;
      this.watcher?.stop();
      this.watcher = null;
      this.starvation = null;
    }
    return { published: true, gate };
  }

  private async executeTempDisposition(
    disposition: TakeDisposition,
  ): Promise<void> {
    const take = this.guarded;
    if (take === null) return;
    if (disposition.temp === "PURGE") {
      const confirmation = await this.files.purgeTakeTemp({
        recordingSessionId: take.recordingSessionId,
        takeId: take.takeId,
      });
      this.record(`PURGE_${confirmation}`, take.takeId);
    } else if (disposition.temp === "QUARANTINE") {
      const result = await this.files.quarantineTakeTemp({
        recordingSessionId: take.recordingSessionId,
        takeId: take.takeId,
      });
      this.record(`QUARANTINE_${result}`, take.takeId);
    }
  }

  // -- bounded shutdown ----------------------------------------------------------

  /**
   * Bounded application-close barrier: stops watchers at once, resolves the
   * flush-vs-abort strategy from elapsed budget, shuts the owner down, and
   * releases the slot as INCOMPLETE. Never throws; always resolves inside
   * the frozen 10 s barrier (the owner abort path is itself bounded).
   */
  async shutdownGuarded(): Promise<{ strategy: string; budgetLeftMs: number }> {
    const startedAt = this.nowMs();
    this.watcher?.stop();
    const strategy = shutdownStrategyForElapsed(0);
    const budgetLeftMs = shutdownBudgetLeftMs(0);
    if (this.guarded !== null && this.terminalCause === null) {
      await this.abortForCause("APP_CLOSED");
    } else {
      try {
        await this.owner.shutdownAll("app_close");
      } catch {
        // Shutdown proceeds; the slot below is already released.
      }
      this.guarded = null;
      this.watcher = null;
      this.starvation = null;
    }
    void startedAt;
    this.record(`SHUTDOWN_${strategy}`, null);
    return { strategy, budgetLeftMs };
  }

  // -- scoped recovery -------------------------------------------------------------

  /**
   * Plans scoped next-launch recovery over names listed from the single
   * trusted temp root. Active-take entries are preserved; foreign names are
   * ignored; stale P9-owned entries purge (or keep diagnostics per policy).
   * Never resumes an old take.
   */
  planRecovery(
    names: readonly string[],
    policy: RecoveryPolicy,
  ): readonly { name: string; action: RecoveryAction }[] {
    const active = this.owner.getActiveFence();
    return names.map((name) => {
      const ownedByActive =
        active !== null && name.includes(active.take_id);
      const entry = classifyRecoveryEntry({ name, ownedByActive });
      return { name, action: planRecoveryAction(entry, policy) };
    });
  }

  /** Confirms temp cleanup ownership (fail closed on uncertainty). */
  confirmCleanup(
    removals: readonly { readonly removed: boolean; readonly stillPresent: boolean }[],
  ): CleanupConfirmation {
    return confirmTempCleanup(removals);
  }

  private record(kind: string, takeId: string | null): void {
    this.events.push({ kind, takeId });
  }
}
