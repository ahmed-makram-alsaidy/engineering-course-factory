// P9.2 Deterministic Fake Capture Driver — test double, never evidence.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md task P9.2 (test double) and
// ADR-0014. Implements the fixed CaptureDriver surface deterministically for
// state/lifecycle/bounds/fencing tests. Produces tiny synthetic metadata
// only (no pixel bytes, no disk, no windows). A fake green run proves the
// session logic; real WGC support is proven only by the native proof run.

import {
  CAPTURE_FRAME_POOL_SIZE,
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
} from "./capture-format.ts";
import type { NativeCapability } from "./capture-capability.ts";
import {
  CaptureBackendError,
  type AcquireOk,
  type CaptureDriver,
  type NativeErrorCode,
  type NativeItemInfo,
  type NativeStartParams,
  type NativeStopInfo,
  type NativeStats,
  type RawNativeFrame,
} from "./capture-driver.ts";
import type { TrustedWindowRef } from "./trusted-source.ts";

export type FakeScriptStep =
  | { kind: "frame"; timestampUs?: number; width?: number; height?: number; digest?: string }
  | { kind: "empty" }
  | { kind: "source-lost" }
  | { kind: "geometry-changed"; width: number; height: number }
  | { kind: "throw"; code: NativeErrorCode; message: string }
  | { kind: "throw-raw"; message: string };

export interface FakeDriverOptions {
  capability?: Partial<NativeCapability>;
  itemWidth?: number;
  itemHeight?: number;
  script?: FakeScriptStep[];
  defaultFrames?: number;
  openThrow?: { code: NativeErrorCode; message: string } | { raw: string };
}

const CANONICAL_CAPABILITY: NativeCapability = {
  backend: "wgc-window",
  wgc_supported: true,
  create_for_window_supported: true,
  d3d11_available: true,
  d3d_adapter: "hardware",
  cursor_disable_supported: true,
  border_disable_supported: true,
  os_build: 26200,
};

function fnvDigest(seed: number): string {
  let hash = seed >>> 0;
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    hash = (Math.imul(hash, 16777619) ^ (seed + i)) >>> 0;
    out += "0123456789abcdef"[hash & 0xf]!;
  }
  return out;
}

/**
 * Deterministic fake capture driver. Serves a programmed script of acquire
 * results; unscripted acquires yield synthetic canonical frames (bounded by
 * `defaultFrames`, then `empty`). All state transitions are synchronous and
 * fully deterministic under a caller-supplied clock.
 */
export class FakeCaptureDriver implements CaptureDriver {
  readonly driverName = "fake-wgc";
  private readonly capability: NativeCapability;
  private readonly itemWidth: number;
  private readonly itemHeight: number;
  private readonly script: FakeScriptStep[];
  private readonly defaultFrames: number;

  private opened = false;
  private started = false;
  private closed = false;
  private generation = 0;
  private framesCaptured = 0;
  private framesDelivered = 0;
  private scriptIndex = 0;
  private syntheticIndex = 0;
  private startParams: NativeStartParams | null = null;
  private readonly openThrow: FakeDriverOptions["openThrow"];

  closeCalls = 0;
  stopCalls = 0;

  constructor(options: FakeDriverOptions = {}) {
    this.capability = { ...CANONICAL_CAPABILITY, ...(options.capability ?? {}) };
    this.itemWidth = options.itemWidth ?? CAPTURE_WIDTH;
    this.itemHeight = options.itemHeight ?? CAPTURE_HEIGHT;
    this.script = [...(options.script ?? [])];
    this.defaultFrames = options.defaultFrames ?? 0;
    this.openThrow = options.openThrow;
  }

  probe(): NativeCapability {
    return { ...this.capability };
  }

  open(ref: TrustedWindowRef, params: { ownerPid: number }): NativeItemInfo {
    void params;
    if (this.openThrow !== undefined) {
      if ("raw" in this.openThrow) {
        throw new Error(this.openThrow.raw);
      }
      throw new CaptureBackendError(
        this.openThrow.code,
        this.openThrow.message,
      );
    }
    if (this.closed) {
      throw new CaptureBackendError("ALREADY_CLOSED", "driver is closed");
    }
    if (ref.windowHandle <= 0n) {
      throw new CaptureBackendError("INVALID_SOURCE", "window handle is null");
    }
    if (ref.windowHandle === 0xdeadn) {
      throw new CaptureBackendError("SOURCE_DESTROYED", "window no longer exists");
    }
    if (ref.ownerPid !== 4242) {
      throw new CaptureBackendError("WRONG_OWNER", "window belongs to an unexpected owner");
    }
    this.opened = true;
    this.generation += 1;
    return {
      generation: this.generation,
      itemWidth: this.itemWidth,
      itemHeight: this.itemHeight,
    };
  }

  start(params: NativeStartParams): void {
    if (this.closed) {
      throw new CaptureBackendError("ALREADY_CLOSED", "driver is closed");
    }
    if (!this.opened) {
      throw new CaptureBackendError("NOT_STARTED", "driver is not opened");
    }
    if (this.started) {
      throw new CaptureBackendError("ALREADY_STARTED", "driver already started");
    }
    if (
      params.expectedWidth !== CAPTURE_WIDTH ||
      params.expectedHeight !== CAPTURE_HEIGHT
    ) {
      throw new CaptureBackendError(
        "GEOMETRY_MISMATCH",
        "unexpected geometry for the canonical take",
      );
    }
    if (
      params.poolSize < 8 ||
      params.poolSize > 32 ||
      params.poolSize !== CAPTURE_FRAME_POOL_SIZE
    ) {
      throw new CaptureBackendError("INVALID_SOURCE", "pool size out of contract");
    }
    if (params.cursorHidden !== true) {
      throw new CaptureBackendError("INVALID_SOURCE", "cursor must stay hidden");
    }
    this.startParams = params;
    this.started = true;
  }

  acquire(options: { digest: boolean }): AcquireOk {
    if (this.closed || !this.started) {
      return { status: "ended" };
    }
    if (this.scriptIndex < this.script.length) {
      const step = this.script[this.scriptIndex]!;
      this.scriptIndex += 1;
      return this.serveStep(step, options.digest);
    }
    if (this.syntheticIndex < this.defaultFrames) {
      const index = this.syntheticIndex;
      this.syntheticIndex += 1;
      return { status: "frame", frame: this.syntheticFrame(index, options.digest) };
    }
    return { status: "empty" };
  }

  stop(): NativeStopInfo {
    this.stopCalls += 1;
    this.started = false;
    return {
      framesCaptured: this.framesCaptured,
      framesDelivered: this.framesDelivered,
    };
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
    this.started = false;
    this.opened = false;
  }

  stats(): NativeStats {
    return {
      generation: this.generation,
      state: this.closed
        ? "closed"
        : this.started
          ? "started"
          : this.opened
            ? "opened"
            : "idle",
      framesCaptured: this.framesCaptured,
      framesDelivered: this.framesDelivered,
      cursorHidden: true,
      borderSuppressed: this.startParams?.borderSuppressed ?? false,
      d3dAdapter: this.capability.d3d_adapter,
    };
  }

  private serveStep(step: FakeScriptStep, digest: boolean): AcquireOk {
    switch (step.kind) {
      case "frame": {
        const index = this.syntheticIndex;
        this.syntheticIndex += 1;
        return { status: "frame", frame: this.syntheticFrame(index, digest, step) };
      }
      case "empty":
        return { status: "empty" };
      case "source-lost":
        return { status: "source-lost" };
      case "geometry-changed":
        return {
          status: "geometry-changed",
          observedWidth: step.width,
          observedHeight: step.height,
        };
      case "throw":
        throw new CaptureBackendError(step.code, step.message);
      case "throw-raw":
        throw new Error(step.message);
    }
  }

  private syntheticFrame(
    index: number,
    digest: boolean,
    step?: { timestampUs?: number; width?: number; height?: number; digest?: string },
  ): RawNativeFrame {
    this.framesCaptured += 1;
    this.framesDelivered += 1;
    const width = step?.width ?? CAPTURE_WIDTH;
    const height = step?.height ?? CAPTURE_HEIGHT;
    const strideBytes = width * 4;
    return {
      captureTimestampUs: step?.timestampUs ?? (1_000_000 + index * 33_334),
      width,
      height,
      strideBytes,
      byteLength: strideBytes * height,
      ...(digest || step?.digest !== undefined
        ? { contentDigestFnv1a64: step?.digest ?? fnvDigest(index + 1) }
        : {}),
    };
  }
}
