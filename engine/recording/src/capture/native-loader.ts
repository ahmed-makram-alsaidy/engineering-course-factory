// P9.2 Native Addon Loader — Main-side-only N-API binding seam.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Section 4.1 (native capture
// host loaded Main-side only, never bundled to the renderer) and ADR-0014
// (zero renderer media authority). Resolves the compiled `wgc_capture`
// addon next to this package and validates its fixed narrow surface before
// handing it to the session. A missing build is a soft capability fact
// (`loaded:false`), never an exception: unit runs and hosts without a
// compiler still typecheck and run deterministically.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NativeCapabilitySchema, type NativeCapability } from "./capture-capability.ts";
import {
  CaptureBackendError,
  RawNativeFrameSchema,
  hasFixedDriverSurface,
  type AcquireOk,
  type CaptureDriver,
  type NativeErrorCode,
  type NativeItemInfo,
  type NativeStartParams,
  type NativeStats,
  type NativeStopInfo,
  type RawNativeFrame,
} from "./capture-driver.ts";
import type { TrustedWindowRef } from "./trusted-source.ts";

const ADDON_RELATIVE_PATHS = [
  join("..", "..", "native", "wgc", "build", "Release", "wgc_capture.node"),
  join("..", "..", "native", "wgc", "build", "Debug", "wgc_capture.node"),
];

interface AddonEnvelopeOk {
  ok: true;
}

interface AddonEnvelopeFail {
  ok: false;
  code: NativeErrorCode;
  message: string;
}

type AddonEnvelope = AddonEnvelopeOk | AddonEnvelopeFail;

function throwOnFail(envelope: AddonEnvelope, fallback: NativeErrorCode): void {
  if (envelope.ok !== true) {
    const failed = envelope as AddonEnvelopeFail;
    throw new CaptureBackendError(failed.code ?? fallback, failed.message ?? "capture operation failed");
  }
}

interface RawAddon {
  probe: () => NativeCapability;
  open: (args: {
    windowHandle: bigint;
    ownerPid: number;
  }) => (NativeItemInfo & AddonEnvelopeOk) | AddonEnvelopeFail;
  start: (args: NativeStartParams) => AddonEnvelope;
  acquire: (args: { digest: boolean }) => ({ status: AcquireOk["status"]; frame?: Record<string, unknown>; observedWidth?: number; observedHeight?: number } & AddonEnvelopeOk) | AddonEnvelopeFail;
  stop: () => ({ framesCaptured: number | bigint; framesDelivered: number | bigint } & AddonEnvelopeOk) | AddonEnvelopeFail;
  close: () => AddonEnvelope;
  stats: () => {
    generation: number;
    state: string;
    framesCaptured: number | bigint;
    framesDelivered: number | bigint;
    cursorHidden: boolean;
    borderSuppressed: boolean;
    d3dAdapter: string;
  };
  // P9.3 additive readback seam (optional; absent on older builds).
  armRetention?: () => AddonEnvelope;
  readback?: (args: { timestampUs: bigint }) => AddonEnvelope & {
    width?: unknown;
    height?: unknown;
    bytes?: unknown;
  };
}

/** Validated retained-frame payload from the additive readback seam. */
export interface NativeReadbackFrame {
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
}

/** Native-backed driver: thin validation wrapper over the addon surface. */
export class NativeWgcDriver implements CaptureDriver {
  readonly driverName = "wgc-native";
  private readonly addon: RawAddon;

  constructor(addon: unknown) {
    if (!isRawAddonSurface(addon)) {
      throw new Error(
        "[INVALID_REQUEST] native addon surface failed validation",
      );
    }
    this.addon = addon;
  }

  probe(): NativeCapability {
    return NativeCapabilitySchema.parse(this.addon.probe());
  }

  open(
    ref: TrustedWindowRef,
    params: { ownerPid: number },
  ): NativeItemInfo {
    const result = this.addon.open({
      windowHandle: ref.windowHandle,
      ownerPid: params.ownerPid,
    });
    throwOnFail(result, "CAPTURE_FAILED");
    const ok = result as NativeItemInfo & AddonEnvelopeOk;
    return { generation: ok.generation, itemWidth: ok.itemWidth, itemHeight: ok.itemHeight };
  }

  start(params: NativeStartParams): void {
    throwOnFail(this.addon.start(params), "CAPTURE_FAILED");
  }

  acquire(options: { digest: boolean }): AcquireOk {
    const result = this.addon.acquire(options);
    throwOnFail(result, "CAPTURE_FAILED");
    const ok = result as { status: AcquireOk["status"]; frame?: Record<string, unknown>; observedWidth?: number; observedHeight?: number } & AddonEnvelopeOk;
    if (ok.status === "frame") {
      return { status: "frame", frame: normalizeRawFrame(ok.frame) };
    }
    if (ok.status === "geometry-changed") {
      return {
        status: "geometry-changed",
        observedWidth: toSafeInt(ok.observedWidth),
        observedHeight: toSafeInt(ok.observedHeight),
      };
    }
    return { status: ok.status };
  }

  stop(): NativeStopInfo {
    const result = this.addon.stop();
    throwOnFail(result, "CAPTURE_FAILED");
    const ok = result as { framesCaptured: number | bigint; framesDelivered: number | bigint } & AddonEnvelopeOk;
    return {
      framesCaptured: toSafeCount(ok.framesCaptured),
      framesDelivered: toSafeCount(ok.framesDelivered),
    };
  }

  close(): void {
    throwOnFail(this.addon.close(), "CAPTURE_FAILED");
  }

  stats(): NativeStats {
    const raw = this.addon.stats();
    return {
      generation: toSafeInt(raw.generation),
      state: typeof raw.state === "string" ? raw.state.slice(0, 32) : "unknown",
      framesCaptured: toSafeCount(raw.framesCaptured),
      framesDelivered: toSafeCount(raw.framesDelivered),
      cursorHidden: raw.cursorHidden === true,
      borderSuppressed: raw.borderSuppressed === true,
      d3dAdapter: typeof raw.d3dAdapter === "string" ? raw.d3dAdapter.slice(0, 32) : "unknown",
    };
  }

  /**
   * P9.3 additive seam: true when the loaded addon exposes the byte
   * retention surface. Feature-detected per method; older builds report
   * false and the encoder falls back to closed failure (never invented
   * pixels).
   */
  supportsReadback(): boolean {
    return (
      typeof this.addon.armRetention === "function" &&
      typeof this.addon.readback === "function"
    );
  }

  /** Arms one-frame byte retention for the next digest-mapped acquires. */
  armByteRetention(): void {
    if (typeof this.addon.armRetention !== "function") {
      throw new CaptureBackendError("CAPTURE_FAILED", "readback seam unavailable");
    }
    throwOnFail(this.addon.armRetention(), "CAPTURE_FAILED");
  }

  /**
   * Copies the retained frame bytes for one capture timestamp (tightly
   * packed rows). Throws a typed backend error when nothing is retained
   * for that timestamp or the payload is incoherent.
   */
  readbackFrame(timestampUs: bigint): NativeReadbackFrame {
    if (typeof this.addon.readback !== "function") {
      throw new CaptureBackendError("CAPTURE_FAILED", "readback seam unavailable");
    }
    const result = this.addon.readback({ timestampUs });
    throwOnFail(result, "CAPTURE_FAILED");
    const width = result.width;
    const height = result.height;
    const bytes = result.bytes;
    if (
      typeof width !== "number" ||
      typeof height !== "number" ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 7680 ||
      height > 4320
    ) {
      throw new CaptureBackendError("CAPTURE_FAILED", "retained frame dims out of range");
    }
    if (!(bytes instanceof Uint8Array) || bytes.length !== width * height * 4) {
      throw new CaptureBackendError("CAPTURE_FAILED", "retained frame bytes incoherent");
    }
    return { width, height, bytes };
  }
}

function toSafeInt(value: unknown): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isInteger(numeric) || numeric < 0) {
    throw new CaptureBackendError("CAPTURE_FAILED", "native value out of range");
  }
  return numeric;
}

function toSafeCount(value: number | bigint): number {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > Number.MAX_SAFE_INTEGER) {
    throw new CaptureBackendError("CAPTURE_FAILED", "native counter out of range");
  }
  return numeric;
}

function normalizeRawFrame(frame: Record<string, unknown> | undefined): RawNativeFrame {
  if (frame === undefined || frame === null || typeof frame !== "object") {
    throw new CaptureBackendError("CAPTURE_FAILED", "native frame missing");
  }
  const timestamp = (frame as { captureTimestampUs?: number | bigint }).captureTimestampUs;
  const numericTimestamp = typeof timestamp === "bigint" ? Number(timestamp) : timestamp;
  const candidate = {
    captureTimestampUs: numericTimestamp,
    width: (frame as { width?: unknown }).width,
    height: (frame as { height?: unknown }).height,
    strideBytes: (frame as { strideBytes?: unknown }).strideBytes,
    byteLength: (frame as { byteLength?: unknown }).byteLength,
    ...((frame as { contentDigestFnv1a64?: unknown }).contentDigestFnv1a64 === undefined
      ? {}
      : { contentDigestFnv1a64: (frame as { contentDigestFnv1a64?: unknown }).contentDigestFnv1a64 }),
  };
  return RawNativeFrameSchema.parse(candidate);
}

function isRawAddonSurface(candidate: unknown): candidate is RawAddon {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  for (const key of [
    "probe",
    "open",
    "start",
    "acquire",
    "stop",
    "close",
    "stats",
  ]) {
    if (typeof record[key] !== "function") {
      return false;
    }
  }
  return true;
}

export type NativeLoadResult =
  | { loaded: true; driver: NativeWgcDriver; path: string }
  | { loaded: false; reason: string };

/**
 * Loads the Main-side native addon when built. Never throws for a missing
 * or invalid binary: callers receive `{ loaded:false }` and fall back to
 * capability HOLD or the deterministic fake (tests). Main-side only: this
 * module must never be bundled or imported by renderer code.
 */
export function loadNativeWgcAddon(): NativeLoadResult {
  let baseDir: string;
  try {
    baseDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return { loaded: false, reason: "module base directory unavailable" };
  }
  const require = createRequire(import.meta.url);
  for (const relative of ADDON_RELATIVE_PATHS) {
    const full = join(baseDir, relative);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const candidate: unknown = require(full);
      if (!hasFixedDriverSurface(candidate) && !isRawAddonSurface(candidate)) {
        return {
          loaded: false,
          reason: "native addon surface failed validation",
        };
      }
      return {
        loaded: true,
        driver: new NativeWgcDriver(candidate),
        path: full,
      };
    } catch (failure) {
      const code =
        failure !== null && typeof failure === "object" && "code" in failure
          ? String((failure as { code: unknown }).code)
          : "";
      if (code === "MODULE_NOT_FOUND") {
        continue;
      }
      return {
        loaded: false,
        reason:
          failure instanceof Error
            ? failure.message.slice(0, 200)
            : "native addon failed to load",
      };
    }
  }
  return { loaded: false, reason: "native addon not built" };
}
