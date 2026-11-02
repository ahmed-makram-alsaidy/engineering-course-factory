// P9.6 safety test doubles — deterministic, zero sleeps.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md task P9.6 (fault injection
// without filling disks or launching processes). Shared by all P9.6 safety
// suites: manual scheduler/clock, scriptable disk reader, scriptable take
// owner, in-memory take files with per-operation fault injection.

import type {
  ControlledTakeFiles,
  ControlledTakeHandle,
  ControlledTakeOwner,
  GuardedStartInput,
  OwnerAbortCause,
  OwnerAbortSummary,
  SafetyControllerOptions,
  ControlledStartResult,
} from "../src/safety/controller.ts";
import type { CleanupConfirmation } from "../src/safety/publication.ts";
import type { DiskWatcherScheduler } from "../src/safety/disk-safety.ts";
import type { PublicationOp } from "../src/safety/publication.ts";
import type { RecordingErrorCode } from "../src/protocol.ts";

// ---------------------------------------------------------------------------
// Manual scheduler (pacing only; video time stays encoder-PTS truth)
// ---------------------------------------------------------------------------

export interface ManualTimer {
  readonly id: number;
  readonly fn: () => void;
  cancelled: boolean;
}

export class ManualSafetyScheduler implements DiskWatcherScheduler {
  private nextId = 1;
  readonly timers = new Map<number, ManualTimer>();

  schedule(fn: () => void, _ms: number): unknown {
    void _ms;
    const id = this.nextId++;
    this.timers.set(id, { id, fn, cancelled: false });
    return id;
  }

  cancel(timer: unknown): void {
    const entry = this.timers.get(timer as number);
    if (entry !== undefined) entry.cancelled = true;
  }

  get pendingCount(): number {
    let count = 0;
    for (const entry of this.timers.values()) {
      if (!entry.cancelled) count += 1;
    }
    return count;
  }

  runAll(): void {
    for (const entry of [...this.timers.values()]) {
      if (!entry.cancelled) {
        entry.cancelled = true;
        entry.fn();
      }
    }
  }

  runOne(): boolean {
    for (const entry of [...this.timers.values()]) {
      if (!entry.cancelled) {
        entry.cancelled = true;
        entry.fn();
        return true;
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manual clock (monotonic ms; tests advance it explicitly)
// ---------------------------------------------------------------------------

export class ManualSafetyClock {
  private ms: number;
  constructor(startMs = 1_000_000) {
    this.ms = startMs;
  }
  now(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

// ---------------------------------------------------------------------------
// Scriptable disk reader (free bytes or uncertain; never fills a disk)
// ---------------------------------------------------------------------------

export class FakeDiskReader {
  freeBytesOrNull: number | null;
  throwOnQuery = false;
  queryCalls = 0;

  constructor(freeBytesOrNull: number | null) {
    this.freeBytesOrNull = freeBytesOrNull;
  }

  query(): number | null {
    this.queryCalls += 1;
    if (this.throwOnQuery) throw new Error("[DISK_QUERY_FAILED] injected");
    return this.freeBytesOrNull;
  }
}

// ---------------------------------------------------------------------------
// Scriptable take owner (subset of the Main lifecycle owner)
// ---------------------------------------------------------------------------

export class FakeTakeOwner implements ControlledTakeOwner {
  takeCounter = 0;
  active: ControlledTakeHandle | null = null;
  abortCalls: OwnerAbortCause[] = [];
  shutdownCalls: string[] = [];
  progressFrames = 0;
  refuseStartWith: ControlledStartResult | null = null;
  throwOnAbort = false;

  async startTake(input: {
    lessonId: string;
    runtimeSessionId: string;
    generation: number;
  }): Promise<ControlledStartResult> {
    if (this.refuseStartWith !== null) return this.refuseStartWith;
    if (this.active !== null) {
      const err: ControlledStartResult = {
        ok: false,
        code: "RECORDER_ALREADY_ACTIVE" as RecordingErrorCode,
        message: "another take is active",
      };
      return err;
    }
    this.takeCounter += 1;
    const n = Math.min(this.takeCounter, 99);
    this.active = {
      recordingSessionId: `rec-safety-${String(n).padStart(3, "0")}`,
      takeId: `t${String(n).padStart(2, "0")}`,
      runtimeSessionId: input.runtimeSessionId,
      generation: input.generation,
      lessonId: input.lessonId,
    };
    return { ok: true, take: { ...this.active } };
  }

  async abortTake(cause: OwnerAbortCause): Promise<OwnerAbortSummary> {
    this.abortCalls.push(cause);
    if (this.throwOnAbort) throw new Error("[ABORT_FAILED] injected");
    const take = this.active;
    if (take === null) {
      throw new Error("[INVALID_REQUEST] no active take");
    }
    this.active = null;
    const outcome =
      cause === "OPERATOR_CANCELLED"
        ? ("CANCELLED" as const)
        : cause === "RESET_INTERRUPTED"
          ? ("RESET_INTERRUPTED" as const)
          : cause === "PREFLIGHT_REFUSED" ||
              cause === "STARTUP_TIMEOUT" ||
              cause === "APP_CLOSED" ||
              cause === "LOW_DISK_ABORT"
            ? ("INCOMPLETE" as const)
            : ("FAILED" as const);
    return {
      recordingSessionId: take.recordingSessionId,
      takeId: take.takeId,
      cause,
      outcome,
    };
  }

  async shutdownAll(cause = "app_close"): Promise<void> {
    this.shutdownCalls.push(cause);
    this.active = null;
  }

  getActiveFence(): {
    recording_session_id: string;
    take_id: string;
    runtime_session_id: string;
    generation: number;
  } | null {
    if (this.active === null) return null;
    return {
      recording_session_id: this.active.recordingSessionId,
      take_id: this.active.takeId,
      runtime_session_id: this.active.runtimeSessionId,
      generation: this.active.generation,
    };
  }

  getProgress(): { capturedFrames: number } | null {
    if (this.active === null) return null;
    return { capturedFrames: this.progressFrames };
  }
}

// ---------------------------------------------------------------------------
// In-memory take files with per-operation fault injection
// ---------------------------------------------------------------------------

export type FilesFaults = Partial<Record<PublicationOp, boolean>>;

export class FakeTakeFiles implements ControlledTakeFiles {
  purged: { recordingSessionId: string; takeId: string }[] = [];
  quarantined: { recordingSessionId: string; takeId: string }[] = [];
  publishedSteps: PublicationOp[] = [];
  removedPublished = 0;
  purgeConfirmations: CleanupConfirmation[] = [];
  quarantineResults: ("QUARANTINED" | "ABSENT" | "UNCONFIRMED")[] = [];
  stepFaults: FilesFaults = {};
  failPurge = false;
  failQuarantine = false;
  nextQuarantine: "QUARANTINED" | "ABSENT" | "UNCONFIRMED" | null = null;

  async purgeTakeTemp(input: {
    recordingSessionId: string;
    takeId: string;
  }): Promise<CleanupConfirmation> {
    this.purged.push({ ...input });
    if (this.failPurge) return "UNCONFIRMED";
    return "CONFIRMED";
  }

  async quarantineTakeTemp(input: {
    recordingSessionId: string;
    takeId: string;
  }): Promise<"QUARANTINED" | "ABSENT" | "UNCONFIRMED"> {
    this.quarantined.push({ ...input });
    if (this.failQuarantine) return "UNCONFIRMED";
    if (this.nextQuarantine !== null) {
      const result = this.nextQuarantine;
      this.quarantineResults.push(result);
      return result;
    }
    const result = "QUARANTINED" as const;
    this.quarantineResults.push(result);
    return result;
  }

  async runPublicationStep(
    step: PublicationOp,
    input: { recordingSessionId: string; takeId: string },
  ): Promise<{ ok: boolean; failedAt?: PublicationOp }> {
    void input;
    if (this.stepFaults[step] === true) {
      return { ok: false, failedAt: step };
    }
    this.publishedSteps.push(step);
    return { ok: true };
  }

  async removePublished(input: {
    recordingSessionId: string;
    takeId: string;
  }): Promise<CleanupConfirmation> {
    void input;
    this.removedPublished += 1;
    return "CONFIRMED";
  }
}

// ---------------------------------------------------------------------------
// Canonical builders
// ---------------------------------------------------------------------------

export const GIB = 1_073_741_824;

export function guardedInput(overrides?: Partial<GuardedStartInput>): GuardedStartInput {
  return {
    lessonId: "C01-L001",
    runtimeSessionId: "sess-safety-001",
    generation: 1,
    expectedLessonS: 600,
    ...overrides,
  };
}

export function controllerOptions(overrides?: Partial<SafetyControllerOptions>): {
  options: SafetyControllerOptions;
  owner: FakeTakeOwner;
  files: FakeTakeFiles;
  disk: FakeDiskReader;
  scheduler: ManualSafetyScheduler;
  clock: ManualSafetyClock;
} {
  const owner = new FakeTakeOwner();
  const files = new FakeTakeFiles();
  const disk = new FakeDiskReader(20 * GIB);
  const scheduler = new ManualSafetyScheduler();
  const clock = new ManualSafetyClock();
  const options: SafetyControllerOptions = {
    owner,
    files,
    queryDiskFree: () => disk.query(),
    scheduler,
    nowMs: () => clock.now(),
    ...overrides,
  };
  return { options, owner, files, disk, scheduler, clock };
}
