// P9.2 WGC Capture Session — Main-side take-bound frame acquisition owner.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 6, 9, 16, 19, 23 and
// docs/adr/ADR-0014-screen-recording-boundary.md (observation tier, threats
// T3/T5/T10). Owns one take's capture lifecycle over a fixed CaptureDriver:
// trusted open, canonical geometry enforcement, 30 Hz pull draining,
// strictly increasing frame_seq from 1, monotonic internal timestamps,
// bounded metadata queue with drop-oldest accounting, source-loss and
// geometry-change latches, 2 s no-valid-frame watchdog state, generation
// fencing, deterministic stop/close, and sanitized errors.
//
// This module never encodes, never writes frames to disk, never touches the
// network, and never imports Electron, filesystem, or process facilities.

import {
  CAPTURE_FRAME_POOL_SIZE,
  CAPTURE_FRAME_SEQ_INITIAL,
  CAPTURE_HEIGHT,
  CAPTURE_QUEUE_CAP,
  CAPTURE_WIDTH,
  CaptureFrameSchema,
  isCanonicalGeometry,
  isCoherentFrameLayout,
  MAX_CAPTURE_HEIGHT,
  MAX_CAPTURE_WIDTH,
  type CaptureFrame,
} from "./capture-format.ts";
import {
  evaluateCaptureCapability,
  type NativeCapability,
} from "./capture-capability.ts";
import {
  CaptureBackendError,
  type AcquireOk,
  type CaptureDriver,
  type NativeErrorCode,
} from "./capture-driver.ts";
import {
  sanitizeRecordingMessage,
  toRecordingErrorDto,
  type RecordingErrorCode,
  type RecordingErrorDto,
  type RecordingPhase,
  type TakeFence,
} from "../protocol.ts";
import { FrameSeqSchema } from "../timeline.ts";
import type {
  IssuedCaptureSource,
  TrustedCaptureSourceRegistry,
  TrustedWindowRef,
} from "./trusted-source.ts";

// ---------------------------------------------------------------------------
// Bounds & Policy Constants (frozen)
// ---------------------------------------------------------------------------

/** No-valid-frame detection window: 2 s (P9-DESIGN-SPEC Section 23). */
export const NO_VALID_FRAME_MS = 2_000;

/** Upper bound on native frames drained per pump call (misbehaving-driver). */
export const MAX_DRAIN_PER_PUMP = 64;

/** Native-to-protocol error mapping (bounded; raw text never forwarded). */
export const NATIVE_TO_RECORDING_ERROR: Record<
  NativeErrorCode,
  { code: RecordingErrorCode; phase: RecordingPhase }
> = {
  INVALID_SOURCE: { code: "INVALID_IDENTITY", phase: "PREFLIGHT" },
  SOURCE_DESTROYED: { code: "CAPTURE_SOURCE_LOST", phase: "ACQUISITION" },
  WRONG_OWNER: { code: "INVALID_IDENTITY", phase: "PREFLIGHT" },
  GEOMETRY_MISMATCH: { code: "WINDOW_GEOMETRY_MISMATCH", phase: "PREFLIGHT" },
  WGC_UNSUPPORTED: { code: "CAPTURE_SOURCE_LOST", phase: "PREFLIGHT" },
  DEVICE_LOST: { code: "CAPTURE_SOURCE_LOST", phase: "ACQUISITION" },
  CAPTURE_FAILED: { code: "CAPTURE_SOURCE_LOST", phase: "ACQUISITION" },
  ALREADY_STARTED: { code: "RECORDER_ALREADY_ACTIVE", phase: "ACQUISITION" },
  NOT_STARTED: { code: "INVALID_REQUEST", phase: "ACQUISITION" },
  ALREADY_CLOSED: { code: "INVALID_REQUEST", phase: "CLEANUP" },
};

export type CaptureSessionState =
  | "idle"
  | "opened"
  | "started"
  | "stopped"
  | "closed";

export interface GeometryChangeInfo {
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly observedWidth: number;
  readonly observedHeight: number;
}

export interface WatchdogState {
  readonly lastValidFrameMs: number | null;
  readonly starvedMs: number | null;
  readonly starved: boolean;
}

export interface CaptureSessionStats {
  readonly state: CaptureSessionState;
  readonly nextFrameSeq: number;
  readonly capturedFrames: number;
  readonly acceptedFrames: number;
  readonly droppedFrames: number;
  readonly pendingFrames: number;
  readonly sourceLost: boolean;
  readonly geometryChanged: boolean;
  readonly deviceLost: boolean;
  readonly cursorHidden: boolean;
  readonly borderSuppressed: boolean;
  readonly degradedAdapter: boolean;
  readonly itemWidth: number | null;
  readonly itemHeight: number | null;
}

/** Sanitized session error carrying a renderer/log-safe DTO. */
export class RecordingCaptureError extends Error {
  readonly dto: RecordingErrorDto;
  constructor(dto: RecordingErrorDto) {
    super(`[${dto.code}] ${dto.message}`);
    this.name = "RecordingCaptureError";
    this.dto = dto;
  }
}

export interface WgcSessionOptions {
  readonly fence: TakeFence;
  readonly takeId: string;
  readonly driver: CaptureDriver;
  readonly registry: TrustedCaptureSourceRegistry;
  readonly token: string;
  readonly nowMs?: () => number;
}

// One active capture session per workstation (P9-DESIGN-SPEC Section 19).
const ACTIVE_SESSIONS = new Set<WgcCaptureSession>();

/** Number of currently active (started) sessions — observability only. */
export function activeCaptureSessionCount(): number {
  return ACTIVE_SESSIONS.size;
}

function errorDto(
  code: RecordingErrorCode,
  message: string,
  fence: TakeFence & { take_id: string },
  phase: RecordingPhase,
): RecordingErrorDto {
  return toRecordingErrorDto({
    code,
    message: sanitizeRecordingMessage(message),
    recording_session_id: fence.recording_session_id,
    take_id: fence.take_id,
    phase,
  });
}

function mapDriverFailure(
  failure: unknown,
  fence: TakeFence & { take_id: string },
  fallbackPhase: RecordingPhase,
): RecordingCaptureError {
  if (failure instanceof CaptureBackendError) {
    const mapped = NATIVE_TO_RECORDING_ERROR[failure.nativeCode];
    return new RecordingCaptureError(
      errorDto(mapped.code, failure.message, fence, mapped.phase),
    );
  }
  // Untyped native failures never cross the boundary verbatim: a fixed
  // message replaces raw text (which may carry COM internals, paths, or
  // stacks). Typed failures above keep their short static messages, which
  // are additionally passed through the privacy sanitizer.
  return new RecordingCaptureError(
    errorDto(
      "CAPTURE_SOURCE_LOST",
      "capture backend reported an untyped failure",
      fence,
      fallbackPhase,
    ),
  );
}

/**
 * Take-bound WGC capture session. Pull model: the owner calls `pump()` at
 * 30 Hz; the session drains the native pool, validates, sequences, and
 * queues metadata-only entries for the future encoder consumer.
 */
export class WgcCaptureSession {
  private readonly fence: TakeFence & { take_id: string };
  private readonly driver: CaptureDriver;
  private readonly registry: TrustedCaptureSourceRegistry;
  private readonly token: string;
  private readonly nowMs: () => number;

  private state: CaptureSessionState = "idle";
  private issued: IssuedCaptureSource | null = null;
  private nativeGeneration = 0;
  private fenceEpoch = 0;
  private capability: NativeCapability | null = null;
  private degradedAdapter = false;

  private nextFrameSeq: number = CAPTURE_FRAME_SEQ_INITIAL;
  private lastTimestampUs: number | null = null;
  private readonly queue: CaptureFrame[] = [];

  private capturedFrames = 0;
  private acceptedFrames = 0;
  private droppedFrames = 0;

  private sourceLost = false;
  private geometryChanged: GeometryChangeInfo | null = null;
  private deviceLost = false;

  private lastValidFrameMs: number | null = null;
  private readonly captureClockEpoch: string;

  private onSourceLost: (() => void) | null = null;
  private onGeometryChanged: ((info: GeometryChangeInfo) => void) | null =
    null;

  private static epochCounter = 0;

  constructor(options: WgcSessionOptions) {
    this.fence = { ...options.fence, take_id: options.takeId };
    this.driver = options.driver;
    this.registry = options.registry;
    this.token = options.token;
    this.nowMs = options.nowMs ?? (() => performance.now());
    WgcCaptureSession.epochCounter += 1;
    this.captureClockEpoch = `cap-epoch-${WgcCaptureSession.epochCounter}`;
  }

  // -- lifecycle -----------------------------------------------------------

  /** Resolves the trusted source, probes capability, opens the WGC item. */
  open(): { itemWidth: number; itemHeight: number } {
    if (this.state === "closed") {
      throw new RecordingCaptureError(
        errorDto(
          "INVALID_REQUEST",
          "capture session is closed",
          this.fence,
          "PREFLIGHT",
        ),
      );
    }
    if (this.state !== "idle") {
      throw new RecordingCaptureError(
        errorDto(
          "INVALID_REQUEST",
          "capture session is already opened",
          this.fence,
          "PREFLIGHT",
        ),
      );
    }
    let ref: TrustedWindowRef;
    try {
      ref = this.registry.resolve(this.token);
    } catch {
      throw new RecordingCaptureError(
        errorDto(
          "INVALID_IDENTITY",
          "unknown or revoked capture source",
          this.fence,
          "PREFLIGHT",
        ),
      );
    }
    const capability = this.driver.probe();
    const verdict = evaluateCaptureCapability(capability);
    if (!verdict.usable) {
      throw new RecordingCaptureError(
        errorDto(
          "INVALID_REQUEST",
          `capture host cannot take the canonical take: ${verdict.holdReasons.join("; ")}`,
          this.fence,
          "PREFLIGHT",
        ),
      );
    }
    this.capability = capability;
    this.degradedAdapter = verdict.degradedAdapter;
    let info: { generation: number; itemWidth: number; itemHeight: number };
    try {
      info = this.driver.open(ref, { ownerPid: ref.ownerPid });
    } catch (failure) {
      throw mapDriverFailure(failure, this.fence, "PREFLIGHT");
    }
    if (!isCanonicalGeometry(info.itemWidth, info.itemHeight)) {
      try {
        this.driver.close();
      } catch {
        // Best-effort release after preflight refusal; the DTO below is
        // authoritative for the caller.
      }
      throw new RecordingCaptureError(
        errorDto(
          "WINDOW_GEOMETRY_MISMATCH",
          `capture source is ${info.itemWidth}x${info.itemHeight}; canonical take requires ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}`,
          this.fence,
          "PREFLIGHT",
        ),
      );
    }
    this.issued = { token: this.token, windowHandle: ref.windowHandle, ownerPid: ref.ownerPid };
    this.nativeGeneration = info.generation;
    this.state = "opened";
    return { itemWidth: info.itemWidth, itemHeight: info.itemHeight };
  }

  /** Starts frame acquisition (exactly once per open). */
  start(): void {
    if (this.state === "closed") {
      throw new RecordingCaptureError(
        errorDto(
          "INVALID_REQUEST",
          "capture session is closed",
          this.fence,
          "ACQUISITION",
        ),
      );
    }
    if (this.state === "started") {
      throw new RecordingCaptureError(
        errorDto(
          "RECORDER_ALREADY_ACTIVE",
          "capture session is already started",
          this.fence,
          "ACQUISITION",
        ),
      );
    }
    if (this.state !== "opened") {
      throw new RecordingCaptureError(
        errorDto(
          "INVALID_REQUEST",
          "capture session must be opened before start",
          this.fence,
          "ACQUISITION",
        ),
      );
    }
    if (ACTIVE_SESSIONS.size > 0) {
      throw new RecordingCaptureError(
        errorDto(
          "RECORDER_ALREADY_ACTIVE",
          "another capture session is already active on this workstation",
          this.fence,
          "ACQUISITION",
        ),
      );
    }
    try {
      this.driver.start({
        expectedWidth: CAPTURE_WIDTH,
        expectedHeight: CAPTURE_HEIGHT,
        poolSize: CAPTURE_FRAME_POOL_SIZE,
        cursorHidden: true,
        borderSuppressed: this.capability?.border_disable_supported ?? false,
      });
    } catch (failure) {
      throw mapDriverFailure(failure, this.fence, "ACQUISITION");
    }
    this.state = "started";
    ACTIVE_SESSIONS.add(this);
  }

  /**
   * Drains newly arrived native frames into the bounded queue. Returns the
   * number of frames accepted. Late drains after stop/close/source-loss or
   * geometry hold accept nothing (generation-fenced).
   */
  pump(options: { digest: boolean } = { digest: false }): number {
    if (this.state !== "started") {
      return 0;
    }
    const epoch = this.fenceEpoch;
    let accepted = 0;
    for (let i = 0; i < MAX_DRAIN_PER_PUMP; i += 1) {
      if (this.sourceLost || this.geometryChanged !== null) {
        return accepted;
      }
      let result: AcquireOk;
      try {
        result = this.driver.acquire({ digest: options.digest });
      } catch (failure) {
        this.onDriverFailure(failure);
        return accepted;
      }
      if (epoch !== this.fenceEpoch || this.state !== "started") {
        return accepted;
      }
      if (result.status === "empty") {
        return accepted;
      }
      if (result.status === "ended") {
        return accepted;
      }
      if (result.status === "source-lost") {
        this.latchSourceLost();
        return accepted;
      }
      if (result.status === "geometry-changed") {
        this.latchGeometryChanged(
          result.observedWidth ?? CAPTURE_WIDTH,
          result.observedHeight ?? CAPTURE_HEIGHT,
        );
        return accepted;
      }
      if (result.status === "frame" && result.frame !== undefined) {
        if (this.acceptFrame(result.frame)) {
          accepted += 1;
        }
        continue;
      }
      return accepted;
    }
    return accepted;
  }

  /** Removes and returns the oldest queued frame, if any. */
  take(): CaptureFrame | undefined {
    return this.queue.shift();
  }

  /** Number of queued (accepted, unconsumed) frames. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Stops acquisition: no new frames accepted afterwards, owned references
   * drained, listeners unsubscribed. Idempotent after the first stop.
   */
  stop(): { acceptedFrames: number; droppedFrames: number } {
    if (this.state === "closed") {
      return {
        acceptedFrames: this.acceptedFrames,
        droppedFrames: this.droppedFrames,
      };
    }
    if (this.state === "stopped") {
      return {
        acceptedFrames: this.acceptedFrames,
        droppedFrames: this.droppedFrames,
      };
    }
    this.fenceEpoch += 1;
    this.onSourceLost = null;
    this.onGeometryChanged = null;
    ACTIVE_SESSIONS.delete(this);
    if (this.state === "started") {
      try {
        this.driver.stop();
      } catch {
        // Stop is best-effort release; close() below owns final cleanup and
        // latched flags preserve observability for the owner.
      }
      this.state = "stopped";
    }
    return {
      acceptedFrames: this.acceptedFrames,
      droppedFrames: this.droppedFrames,
    };
  }

  /**
   * Releases every owned resource. Idempotent; after close the session can
   * never be resurrected (open/start/pump/take fail or drain safely).
   */
  close(): void {
    if (this.state === "closed") {
      return;
    }
    this.fenceEpoch += 1;
    this.onSourceLost = null;
    this.onGeometryChanged = null;
    ACTIVE_SESSIONS.delete(this);
    this.queue.length = 0;
    try {
      this.driver.close();
    } catch {
      // Close owns no error surface: release-what-exists is complete when
      // the driver reference is dropped and the token revoked below.
    }
    this.registry.revoke(this.token);
    this.state = "closed";
  }

  // -- event subscription (single Main-side listener, session-bound) --------

  onSourceClosed(listener: () => void): void {
    this.onSourceLost = listener;
  }

  onGeometryChange(listener: (info: GeometryChangeInfo) => void): void {
    this.onGeometryChanged = listener;
  }

  // -- observability (safe fields only) -------------------------------------

  stats(): CaptureSessionStats {
    return {
      state: this.state,
      nextFrameSeq: this.nextFrameSeq,
      capturedFrames: this.capturedFrames,
      acceptedFrames: this.acceptedFrames,
      droppedFrames: this.droppedFrames,
      pendingFrames: this.queue.length,
      sourceLost: this.sourceLost,
      geometryChanged: this.geometryChanged !== null,
      deviceLost: this.deviceLost,
      cursorHidden: true,
      borderSuppressed:
        this.capability?.border_disable_supported ?? false,
      degradedAdapter: this.degradedAdapter,
      itemWidth: this.issued === null ? null : CAPTURE_WIDTH,
      itemHeight: this.issued === null ? null : CAPTURE_HEIGHT,
    };
  }

  /** Watchdog state for the future 2 s no-valid-frame policy (P9.6 owns it). */
  watchdogState(nowMs?: number): WatchdogState {
    const now = nowMs ?? this.nowMs();
    if (this.lastValidFrameMs === null) {
      return { lastValidFrameMs: null, starvedMs: null, starved: false };
    }
    const starvedMs = Math.max(0, now - this.lastValidFrameMs);
    return {
      lastValidFrameMs: this.lastValidFrameMs,
      starvedMs,
      starved: starvedMs >= NO_VALID_FRAME_MS,
    };
  }

  // -- internals ------------------------------------------------------------

  private acceptFrame(raw: {
    captureTimestampUs: number;
    width: number;
    height: number;
    strideBytes: number;
    byteLength: number;
    contentDigestFnv1a64?: string;
  }): boolean {
    this.capturedFrames += 1;
    if (
      !Number.isInteger(raw.width) ||
      !Number.isInteger(raw.height) ||
      raw.width <= 0 ||
      raw.height <= 0
    ) {
      this.droppedFrames += 1;
      return false;
    }
    if (raw.width > MAX_CAPTURE_WIDTH || raw.height > MAX_CAPTURE_HEIGHT) {
      this.droppedFrames += 1;
      return false;
    }
    if (!isCanonicalGeometry(raw.width, raw.height)) {
      this.latchGeometryChanged(raw.width, raw.height);
      return false;
    }
    if (
      !isCoherentFrameLayout({
        width: raw.width,
        height: raw.height,
        stride_bytes: raw.strideBytes,
        byte_length: raw.byteLength,
      })
    ) {
      this.droppedFrames += 1;
      return false;
    }
    if (
      this.lastTimestampUs !== null &&
      raw.captureTimestampUs < this.lastTimestampUs
    ) {
      this.droppedFrames += 1;
      return false;
    }
    const frameSeq = this.nextFrameSeq;
    FrameSeqSchema.parse(frameSeq);
    const candidate = {
      frame_seq: frameSeq,
      capture_timestamp_us: raw.captureTimestampUs,
      capture_clock_epoch: this.captureClockEpoch,
      width: raw.width,
      height: raw.height,
      pixel_format: "bgra8",
      stride_bytes: raw.strideBytes,
      byte_length: raw.byteLength,
      recording_session_id: this.fence.recording_session_id,
      runtime_session_id: this.fence.runtime_session_id,
      generation: this.fence.generation,
      ...(raw.contentDigestFnv1a64 === undefined
        ? {}
        : { content_digest_fnv1a64: raw.contentDigestFnv1a64 }),
    };
    const parsed = CaptureFrameSchema.safeParse(candidate);
    if (!parsed.success) {
      this.droppedFrames += 1;
      return false;
    }
    this.nextFrameSeq += 1;
    this.lastTimestampUs = raw.captureTimestampUs;
    this.lastValidFrameMs = this.nowMs();
    this.acceptedFrames += 1;
    this.queue.push(parsed.data);
    while (this.queue.length > CAPTURE_QUEUE_CAP) {
      this.queue.shift();
      this.droppedFrames += 1;
    }
    return true;
  }

  private latchSourceLost(): void {
    if (this.sourceLost) {
      return;
    }
    this.sourceLost = true;
    const listener = this.onSourceLost;
    this.onSourceLost = null;
    if (listener !== null) {
      listener();
    }
  }

  private latchGeometryChanged(
    observedWidth: number,
    observedHeight: number,
  ): void {
    if (this.geometryChanged !== null) {
      return;
    }
    const info: GeometryChangeInfo = {
      expectedWidth: CAPTURE_WIDTH,
      expectedHeight: CAPTURE_HEIGHT,
      observedWidth,
      observedHeight,
    };
    this.geometryChanged = info;
    const listener = this.onGeometryChanged;
    this.onGeometryChanged = null;
    if (listener !== null) {
      listener(info);
    }
  }

  private onDriverFailure(failure: unknown): void {
    if (failure instanceof CaptureBackendError) {
      if (failure.nativeCode === "DEVICE_LOST") {
        this.deviceLost = true;
      }
      if (
        failure.nativeCode === "SOURCE_DESTROYED" ||
        failure.nativeCode === "CAPTURE_FAILED"
      ) {
        this.latchSourceLost();
        return;
      }
      if (failure.nativeCode === "GEOMETRY_MISMATCH") {
        this.latchGeometryChanged(CAPTURE_WIDTH, CAPTURE_HEIGHT);
        return;
      }
    }
    this.latchSourceLost();
  }
}
