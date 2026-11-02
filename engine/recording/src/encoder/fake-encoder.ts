// P9.3 Deterministic Fake Encoder — scriptable test double, never evidence.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md task P9.3 (test double).
// Implements the narrow InternalEncoderSession surface deterministically:
// frame validation, fence enforcement, bounded pending queue with
// drop-oldest accounting, scriptable faults (startup failure, nonzero exit,
// flush timeout, validation failure, abort race), and honest statistics. A
// fake green run proves owner logic; real encoder support is proven only by
// the bounded FFmpeg proofs in scripts/ (P9.3 gate). No processes, no disk,
// no clock: durations report 0 and every fault resolves immediately.

import {
  ENCODER_QUEUE_CAP_FRAMES,
  assertConfinedTempTarget,
  initialEncoderRunStats,
  type EncoderAbortResult,
  type EncoderFinishResult,
  type EncoderPrepareTarget,
  type EncoderRunStats,
  type EncoderWriteResult,
  type InternalEncoderSession,
} from "./encoder-interface.ts";
import {
  classifyPacing,
  ptsForEncodeIndex,
  validateEncoderFrame,
  type EncoderFrameExpectation,
  type EncoderFrameInput,
} from "./encoder-frames.ts";
import type { EncoderDescriptor } from "../encoder-profile.ts";
import { sha256HexOfBytes } from "./media-validation.ts";
import {
  sanitizeRecordingMessage,
  type TakeFence,
} from "../protocol.ts";

export interface FakeEncoderFaults {
  /** Fail start() with ENCODER_START_FAILED. */
  readonly failOnStart?: boolean;
  /** Finish with this nonzero process exit code. */
  readonly exitCode?: number;
  /** Fail finish() with a flush timeout instead of completing. */
  readonly flushTimeout?: boolean;
  /** Force media validation FAIL at finish(). */
  readonly validationFails?: boolean;
  /** Digest reported at finish (default: hash of accepted count). */
  readonly digestHex?: string;
}

export interface FakeEncoderSessionOptions {
  readonly fence: TakeFence;
  readonly takeId: string;
  readonly faults?: FakeEncoderFaults;
  readonly manualDrain?: boolean;
}

/**
 * Deterministic fake encoder session. Accepts validated frames into a
 * bounded in-memory pending queue (drop-oldest, 12 entries, metadata +
 * byte-length accounting only — payload bytes are not retained beyond a
 * bounded digest so the fake itself cannot explode memory).
 */
export class FakeEncoderSession implements InternalEncoderSession {
  private readonly fence: TakeFence;
  private readonly takeId: string;
  private readonly faults: FakeEncoderFaults;
  private readonly manualDrain: boolean;

  private prepared = false;
  private started = false;
  private finished = false;
  private aborted = false;
  private closed = false;
  private descriptor: EncoderDescriptor | null = null;

  private lastFrameSeq = 0;
  private lastDigest: string | undefined;
  private submitted = 0;
  private accepted = 0;
  private dropped = 0;
  private coalesced = 0;
  private piped = 0;
  private pipedFiller = 0;
  private pipedDup = 0;
  private readonly pendingItems: Array<{ isFiller: boolean; isDup: boolean }> = [];
  private pending = 0;
  private peakPending = 0;
  private lastPts = 0;
  private exitCode: number | null = null;
  private validationVerdict: "PASS" | "FAIL" | null = null;
  private mediaDigest: string | null = null;
  private mediaSize = 0;

  constructor(options: FakeEncoderSessionOptions) {
    this.fence = { ...options.fence };
    this.takeId = options.takeId;
    this.faults = options.faults ?? {};
    this.manualDrain = options.manualDrain ?? false;
  }

  async prepare(target: {
    tempRoot: string;
    recordingSessionId: string;
    takeId: string;
  }): Promise<EncoderPrepareTarget> {
    this.assertUsable("prepare");
    if (this.prepared) {
      throw new Error("[INVALID_REQUEST] encoder already prepared");
    }
    if (
      target.recordingSessionId !== this.fence.recording_session_id ||
      target.takeId !== this.takeId
    ) {
      throw new Error("[STALE_SESSION] prepare target fence mismatch");
    }
    assertConfinedTempTarget(target.tempRoot, target.recordingSessionId, target.takeId);
    this.prepared = true;
    return { dir: "<fake-dir>", partialFileName: "screen.partial.mp4" };
  }

  async start(descriptor: EncoderDescriptor): Promise<void> {
    this.assertUsable("start");
    if (!this.prepared) {
      throw new Error("[INVALID_REQUEST] encoder must be prepared before start");
    }
    if (this.started) {
      throw new Error("[INVALID_REQUEST] encoder already started");
    }
    if (this.faults.failOnStart === true) {
      throw new Error("[ENCODER_START_FAILED] fake encoder refused to start");
    }
    this.descriptor = descriptor;
    this.started = true;
  }

  async writeFrame(frame: unknown): Promise<EncoderWriteResult> {
    this.assertUsable("writeFrame");
    if (!this.started || this.finished || this.aborted) {
      return {
        accepted: false,
        code: "INVALID_REQUEST",
        message: sanitizeRecordingMessage("encoder is not accepting frames"),
      };
    }
    const candidate = frame as Omit<EncoderFrameInput, "bytes"> & {
      bytes: Uint8Array;
    };
    const expectation: EncoderFrameExpectation = {
      ...this.fence,
      take_id: this.takeId,
      lastFrameSeq: this.lastFrameSeq,
    };
    const verdict = validateEncoderFrame(candidate, expectation, this.accepted);
    if (!verdict.ok) {
      return { accepted: false, code: verdict.code, message: verdict.message };
    }
    this.submitted += 1;
    this.lastFrameSeq = candidate.frame_seq;
    this.accepted += 1;
    this.lastPts = verdict.pts_us;
    const isFiller = verdict.isFiller === true || candidate.filler === true;
    const isDup =
      !isFiller &&
      classifyPacing(candidate.content_digest_fnv1a64, this.lastDigest) ===
        "coalesce-duplicate";
    if (isDup) {
      this.coalesced += 1;
    }
    this.lastDigest = candidate.content_digest_fnv1a64;
    this.pendingItems.push({ isFiller, isDup });
    if (this.manualDrain) {
      while (this.pendingItems.length > ENCODER_QUEUE_CAP_FRAMES) {
        this.pendingItems.shift();
        this.dropped += 1;
      }
      this.pending = this.pendingItems.length;
      if (this.pending > this.peakPending) {
        this.peakPending = this.pending;
      }
    } else {
      this.peakPending = Math.max(this.peakPending, 1);
      this.drainPending();
    }
    return { accepted: true, encode_seq: verdict.encodeIndex, pts_us: verdict.pts_us };
  }

  /** Drains the fake pending queue (test hook modeling instant encode). */
  drainForTest(): number {
    const drained = this.pendingItems.length;
    this.drainPending();
    return drained;
  }

  private drainPending(): void {
    for (const item of this.pendingItems) {
      this.piped += 1;
      if (item.isFiller) {
        this.pipedFiller += 1;
      } else if (item.isDup) {
        this.pipedDup += 1;
      }
    }
    this.pendingItems.length = 0;
    this.pending = 0;
  }

  async finish(): Promise<EncoderFinishResult> {
    this.assertUsable("finish");
    if (!this.started) {
      throw new Error("[INVALID_REQUEST] encoder was never started");
    }
    if (this.finished) {
      throw new Error("[INVALID_REQUEST] encoder already finished");
    }
    if (this.aborted) {
      throw new Error("[INVALID_REQUEST] encoder was aborted");
    }
    if (this.faults.flushTimeout === true) {
      throw new Error("[ENCODER_TIMEOUT] fake encoder flush timed out");
    }
    const exitCode = this.faults.exitCode ?? 0;
    this.exitCode = exitCode;
    if (exitCode !== 0) {
      throw new Error(`[ENCODER_FAILED] fake encoder exited with code ${exitCode}`);
    }
    if (this.accepted === 0) {
      throw new Error("[MEDIA_VALIDATION_FAILED] fake encoder has zero frames");
    }
    this.drainPending();
    this.finished = true;
    this.validationVerdict = this.faults.validationFails === true ? "FAIL" : "PASS";
    if (this.validationVerdict === "FAIL") {
      throw new Error("[MEDIA_VALIDATION_FAILED] fake media validation failed");
    }
    this.mediaDigest =
      this.faults.digestHex ?? sha256HexOfBytes(new Uint8Array([this.accepted & 0xff]));
    this.mediaSize = this.accepted * 48_000;
    return {
      stats: this.getStats(),
      media_digest: this.mediaDigest,
      media_size_bytes: this.mediaSize,
      validation_verdict: "PASS",
      media_frame_count: this.piped,
    };
  }

  async abort(reason: string): Promise<EncoderAbortResult> {
    if (this.closed) {
      return {
        aborted: true,
        exitObserved: true,
        tempRemoved: true,
        stats: this.getStats(),
      };
    }
    if (this.finished) {
      return {
        aborted: false,
        exitObserved: true,
        tempRemoved: false,
        stats: this.getStats(),
      };
    }
    void reason;
    this.aborted = true;
    this.pendingItems.length = 0;
    this.pending = 0;
    return {
      aborted: true,
      exitObserved: true,
      tempRemoved: true,
      stats: this.getStats(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.pendingItems.length = 0;
    this.pending = 0;
    this.closed = true;
  }

  getStats(): EncoderRunStats {
    const base = initialEncoderRunStats();
    return {
      ...base,
      state: this.closed
        ? "CLOSED"
        : this.aborted
          ? "ABORTING"
          : this.finished
            ? "COMPLETED"
            : this.started
              ? "ENCODING"
              : this.prepared
                ? "READY"
                : "CREATED",
      family: this.descriptor?.family ?? null,
      profile: this.descriptor?.profile ?? null,
      fallback_used: this.descriptor?.fallback_used ?? false,
      submitted_frames: this.submitted,
      accepted_frames: this.accepted,
      dropped_frames: this.dropped,
      coalesced_frames: this.coalesced,
      piped_frames: this.piped,
      piped_filler_frames: this.pipedFiller,
      piped_dup_frames: this.pipedDup,
      pending_frames: this.pending,
      peak_pending_frames: this.peakPending,
      peak_pending_bytes: this.peakPending * 8_294_400,
      last_pts_us: this.lastPts,
      exit_code: this.exitCode,
      validation_verdict: this.validationVerdict,
      media_digest: this.mediaDigest,
      media_size_bytes: this.mediaSize,
      elapsed_ms: 0,
    };
  }

  private assertUsable(op: string): void {
    if (this.closed) {
      throw new Error(`[INVALID_REQUEST] encoder is closed (${op})`);
    }
  }
}

/** Pure temp-target confinement check shared with the real owner. */
export { assertConfinedTempTarget } from "./encoder-interface.ts";

/** PTS helper re-export for owner/tests (single canonical definition). */
export function fakePtsForEncodeIndex(encodeIndex: number): number {
  return ptsForEncodeIndex(encodeIndex);
}
