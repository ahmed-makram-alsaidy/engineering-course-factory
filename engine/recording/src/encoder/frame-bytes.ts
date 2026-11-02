// P9.3 CPU Frame Byte Sources — trusted Main-side pixel suppliers.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 6, 12 (rawvideo pipe;
// "pixel bytes stay GPU-resident until the P9.3 encoder readback") and
// docs/adr/ADR-0014-screen-recording-boundary.md (window-scoped capture).
//
// The P9.2 session carries metadata only. This module defines the minimum
// internal bridge the encoder needs: a trusted Main-side byte source per
// validated frame. Two implementations: the native readback adapter (real
// captured bytes via the additive P9.3 addon seam — Main-side only, never
// renderer-visible) and the deterministic synthetic source (fixture bytes
// for unit tests and bounded profile proofs). No D3D pointer, COM handle,
// HWND, or PID crosses this boundary.

import {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
} from "../capture/capture-format.ts";
import { generateFixtureFrame } from "./frame-fixture.ts";
import type { EncoderFrameInput } from "./encoder-frames.ts";

/**
 * Trusted CPU byte supplier. Returns tightly packed BGRA bytes
 * (width*4 rows) for a validated frame, or null when bytes are unavailable
 * (the owner then fails closed — it never invents pixels).
 */
export interface CpuFrameBytesSource {
  readonly sourceName: string;
  readFrameBytes(
    frame: Omit<EncoderFrameInput, "bytes">,
  ): Uint8Array | null;
}

/** Optional additive native surface (absent on builds without the seam). */
export interface NativeReadbackSurface {
  armByteRetention(): void;
  readbackFrame(timestampUs: bigint): {
    width: number;
    height: number;
    bytes: Uint8Array;
  };
}

/**
 * Type guard for the additive readback surface. Operates on unknown so the
 * frozen 7-operation CaptureDriver surface is never widened: readback is a
 * separate optional capability, not an 8th driver operation.
 */
export function asReadbackSurface(candidate: unknown): NativeReadbackSurface | null {
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  if (
    typeof record["armByteRetention"] === "function" &&
    typeof record["readbackFrame"] === "function"
  ) {
    return candidate as NativeReadbackSurface;
  }
  return null;
}

/**
 * Native readback adapter: serves real captured bytes retained by the
 * Main-side addon, matched by capture timestamp (exact per-frame
 * provenance under burst drains). Rejects geometry drift and short buffers
 * fail-closed.
 */
export class NativeReadbackAdapter implements CpuFrameBytesSource {
  readonly sourceName = "native-readback";
  private readonly surface: NativeReadbackSurface;

  constructor(surface: NativeReadbackSurface) {
    this.surface = surface;
  }

  arm(): void {
    this.surface.armByteRetention();
  }

  readFrameBytes(
    frame: Omit<EncoderFrameInput, "bytes">,
  ): Uint8Array | null {
    let result: { width: number; height: number; bytes: Uint8Array };
    try {
      result = this.surface.readbackFrame(BigInt(frame.capture_timestamp_us));
    } catch {
      return null;
    }
    if (result.width !== frame.width || result.height !== frame.height) {
      return null;
    }
    if (
      result.width !== CAPTURE_WIDTH ||
      result.height !== CAPTURE_HEIGHT ||
      result.bytes.length !== CAPTURE_WIDTH * CAPTURE_HEIGHT * 4
    ) {
      return null;
    }
    return result.bytes;
  }
}

/**
 * Deterministic synthetic source: fixture bytes keyed by frame_seq. Used by
 * unit tests and by the bounded NVENC/libx264 profile proofs. Never evidence
 * for real capture support (the WGC integration proof uses the native
 * adapter over a real session).
 */
export class SyntheticBytesSource implements CpuFrameBytesSource {
  readonly sourceName = "synthetic-fixture";
  private readonly salt: number;

  constructor(salt = 0) {
    this.salt = salt;
  }

  readFrameBytes(
    frame: Omit<EncoderFrameInput, "bytes">,
  ): Uint8Array | null {
    if (frame.width !== CAPTURE_WIDTH || frame.height !== CAPTURE_HEIGHT) {
      return null;
    }
    return generateFixtureFrame(frame.frame_seq + this.salt);
  }
}
