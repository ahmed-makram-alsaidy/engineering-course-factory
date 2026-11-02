// P9.2 Capture Driver Boundary — fixed typed native/JS bridge contract.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 4, 6, 19 and
// docs/adr/ADR-0014-screen-recording-boundary.md (narrow Main-only surface).
// Defines the ONLY interface the session uses to talk to a capture backend
// (real native addon or deterministic fake). The surface is fixed and typed:
// probe / open / start / acquire / stop / close / stats. There is no window
// discovery, no desktop or monitor capture, no coordinate capture, and no
// raw handle output on this boundary.

import { z } from "zod";
import type { NativeCapability } from "./capture-capability.ts";
import type { TrustedWindowRef } from "./trusted-source.ts";

// ---------------------------------------------------------------------------
// Driver Parameters (trusted Main-side values only)
// ---------------------------------------------------------------------------

export const NativeOpenParamsSchema = z.strictObject({
  ownerPid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

export type NativeOpenParams = z.infer<typeof NativeOpenParamsSchema>;

export const NativeStartParamsSchema = z.strictObject({
  expectedWidth: z.number().int().min(1).max(7680),
  expectedHeight: z.number().int().min(1).max(4320),
  poolSize: z.number().int().min(8).max(32),
  cursorHidden: z.literal(true),
  borderSuppressed: z.boolean(),
});

export type NativeStartParams = z.infer<typeof NativeStartParamsSchema>;

// ---------------------------------------------------------------------------
// Acquire Results (pull model: the owner drains the pool at 30 Hz)
// ---------------------------------------------------------------------------

/** Raw native frame payload: metadata only, bytes stay GPU-resident. */
export const RawNativeFrameSchema = z.strictObject({
  captureTimestampUs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  width: z.number().int(),
  height: z.number().int(),
  strideBytes: z.number().int(),
  byteLength: z.number().int(),
  contentDigestFnv1a64: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
});

export type RawNativeFrame = z.infer<typeof RawNativeFrameSchema>;

export const ACQUIRE_STATUSES = [
  "frame",
  "empty",
  "source-lost",
  "geometry-changed",
  "ended",
] as const;

export const AcquireStatusSchema = z.enum(ACQUIRE_STATUSES);
export type AcquireStatus = z.infer<typeof AcquireStatusSchema>;

export interface AcquireOk {
  readonly status: AcquireStatus;
  readonly frame?: RawNativeFrame;
  readonly observedWidth?: number;
  readonly observedHeight?: number;
}

export interface NativeItemInfo {
  readonly generation: number;
  readonly itemWidth: number;
  readonly itemHeight: number;
}

export interface NativeStopInfo {
  readonly framesCaptured: number;
  readonly framesDelivered: number;
}

export interface NativeStats {
  readonly generation: number;
  readonly state: string;
  readonly framesCaptured: number;
  readonly framesDelivered: number;
  readonly cursorHidden: boolean;
  readonly borderSuppressed: boolean;
  readonly d3dAdapter: string;
}

// ---------------------------------------------------------------------------
// Backend Errors (raw native failures never cross this boundary verbatim)
// ---------------------------------------------------------------------------

/** Machine codes the native side may report (bounded vocabulary). */
export const NATIVE_ERROR_CODES = [
  "INVALID_SOURCE",
  "SOURCE_DESTROYED",
  "WRONG_OWNER",
  "GEOMETRY_MISMATCH",
  "WGC_UNSUPPORTED",
  "DEVICE_LOST",
  "CAPTURE_FAILED",
  "ALREADY_STARTED",
  "NOT_STARTED",
  "ALREADY_CLOSED",
] as const;

export type NativeErrorCode = (typeof NATIVE_ERROR_CODES)[number];

/** Error raised by drivers for typed native/backend failures. */
export class CaptureBackendError extends Error {
  readonly nativeCode: NativeErrorCode;
  constructor(nativeCode: NativeErrorCode, message: string) {
    super(message);
    this.name = "CaptureBackendError";
    this.nativeCode = nativeCode;
  }
}

// ---------------------------------------------------------------------------
// CaptureDriver: the fixed narrow backend interface
// ---------------------------------------------------------------------------

/**
 * Fixed capture-driver interface. Implemented by the native addon wrapper
 * and by the deterministic fake. Exactly seven operations; anything else
 * (window search, desktop capture, monitor capture, coordinate capture,
 * encoder control) is structurally impossible through this type.
 */
export interface CaptureDriver {
  readonly driverName: string;
  probe(): NativeCapability;
  open(ref: TrustedWindowRef, params: NativeOpenParams): NativeItemInfo;
  start(params: NativeStartParams): void;
  acquire(options: { digest: boolean }): AcquireOk;
  stop(): NativeStopInfo;
  close(): void;
  stats(): NativeStats;
}

/** Exact driver surface keys: guards against scope creep by construction. */
export const CAPTURE_DRIVER_METHODS = [
  "probe",
  "open",
  "start",
  "acquire",
  "stop",
  "close",
  "stats",
] as const;

/** True when an object exposes exactly the fixed driver surface. */
export function hasFixedDriverSurface(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record["driverName"] !== "string") {
    return false;
  }
  for (const method of CAPTURE_DRIVER_METHODS) {
    if (typeof record[method] !== "function") {
      return false;
    }
  }
  return true;
}
