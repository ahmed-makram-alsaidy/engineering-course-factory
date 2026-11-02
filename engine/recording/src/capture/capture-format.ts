// P9.2 Capture Frame Format — frozen intermediate pixel contract.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 6, 9-11 and
// docs/adr/ADR-0014-screen-recording-boundary.md (Window-Scoped WGC Capture).
// Freezes the WGC/D3D interop pixel format, the internal frame metadata
// envelope, frame-pool bounds, and queue bounds for the native backend.
// In-memory frames only: this module performs zero disk writes, owns zero
// processes, and exposes zero native pointers publicly.

import { z } from "zod";
import {
  RECORDING_HEIGHT,
  RECORDING_WIDTH,
} from "../encoder-profile.ts";
import { FRAME_SEQ_INITIAL, FrameSeqSchema } from "../timeline.ts";
import { MicrosecondSchema, TakeFenceSchema } from "../protocol.ts";

// ---------------------------------------------------------------------------
// Intermediate Pixel Format (frozen: BGRA8 for WGC/D3D interop)
// ---------------------------------------------------------------------------

/**
 * Frozen intermediate pixel format: BGRA8 (B8G8R8A8_UNORM), the native
 * WGC/D3D11 frame-pool format. Conversion to the encoder pixel input is
 * P9.3 scope; P9.2 never converts, never scales, never encodes.
 */
export const CAPTURE_PIXEL_FORMAT = "bgra8" as const;

export const CapturePixelFormatSchema = z.literal(CAPTURE_PIXEL_FORMAT);
export type CapturePixelFormat = z.infer<typeof CapturePixelFormatSchema>;

/** Bytes per pixel for BGRA8. */
export const CAPTURE_BYTES_PER_PIXEL = 4;

/** Canonical capture geometry: 1920x1080, 1:1, no scaling. */
export const CAPTURE_WIDTH = RECORDING_WIDTH;
export const CAPTURE_HEIGHT = RECORDING_HEIGHT;

/** Byte size of one canonical 1080p BGRA8 frame (~7.91 MiB). */
export const CAPTURE_FRAME_BYTES_1080P =
  CAPTURE_WIDTH * CAPTURE_HEIGHT * CAPTURE_BYTES_PER_PIXEL;

/** Upper dimension bound: frames larger than 8K UHD are rejected. */
export const MAX_CAPTURE_WIDTH = 7680;
export const MAX_CAPTURE_HEIGHT = 4320;

// ---------------------------------------------------------------------------
// Frame Pool & Queue Bounds (P9-DESIGN-SPEC Section 19: 8-32 frames)
// ---------------------------------------------------------------------------

/**
 * Native WGC frame-pool size: 12 Direct3D11 buffers.
 * Memory math: 12 x 8,294,400 B = 99,532,800 B (~94.9 MiB), within the
 * frozen <= 96 MiB target and far below the 256 MiB worst-case ceiling.
 */
export const CAPTURE_FRAME_POOL_SIZE = 12;

/**
 * Main-side pending-frame queue cap: 12 entries. Entries hold metadata
 * only; pixel bytes stay GPU-resident until the P9.3 encoder readback, so
 * the queue adds no retained frame memory beyond the pool.
 */
export const CAPTURE_QUEUE_CAP = 12;

/** Maximum retained native frame memory in bytes (pool bound). */
export const MAX_RETAINED_FRAME_BYTES =
  CAPTURE_FRAME_POOL_SIZE * CAPTURE_FRAME_BYTES_1080P;

/** Maximum pending metadata entries (queue bound). */
export const MAX_PENDING_FRAMES = CAPTURE_QUEUE_CAP;

/** Returns the worst-case retained frame memory for a pool of N frames. */
export function retainedFrameBytes(poolSize: number): number {
  return poolSize * CAPTURE_FRAME_BYTES_1080P;
}

/** True when the canonical geometry matches exactly (no scaling allowed). */
export function isCanonicalGeometry(width: number, height: number): boolean {
  return width === CAPTURE_WIDTH && height === CAPTURE_HEIGHT;
}

// ---------------------------------------------------------------------------
// Internal Capture Frame Metadata (trusted Main-side envelope, no pointers)
// ---------------------------------------------------------------------------

/**
 * Internal frame representation consumed by the future P9.3 encoder owner.
 * Carries sequencing, trusted internal timing, geometry, format, and
 * fencing — never a native pointer, COM handle, HWND, or PID. Pixel bytes
 * remain GPU-resident; optional digests prove content without moving bytes.
 *
 * Timestamp semantics (frozen): `capture_timestamp_us` is the raw internal
 * capture-clock reading in microseconds (WGC compositor domain). It is
 * monotonic within a session but is NOT the P8 timeline: P9.4 performs the
 * explicit epoch mapping. No wall clock, no Date ordering.
 */
export const CaptureFrameSchema = z.strictObject({
  frame_seq: FrameSeqSchema,
  capture_timestamp_us: MicrosecondSchema,
  capture_clock_epoch: z.string().min(1).max(128),
  width: z.number().int().min(1).max(MAX_CAPTURE_WIDTH),
  height: z.number().int().min(1).max(MAX_CAPTURE_HEIGHT),
  pixel_format: CapturePixelFormatSchema,
  stride_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  byte_length: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  recording_session_id: TakeFenceSchema.shape.recording_session_id,
  runtime_session_id: TakeFenceSchema.shape.runtime_session_id,
  generation: TakeFenceSchema.shape.generation,
  content_digest_fnv1a64: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
});

export type CaptureFrame = z.infer<typeof CaptureFrameSchema>;

/** Canonical first frame sequence value (P9.1 contract: starts at 1). */
export const CAPTURE_FRAME_SEQ_INITIAL = FRAME_SEQ_INITIAL;

/**
 * Validates frame byte/stride coherence: stride must cover the row and the
 * buffer must cover all rows. Pure helper; no I/O.
 */
export function isCoherentFrameLayout(frame: {
  width: number;
  height: number;
  stride_bytes: number;
  byte_length: number;
}): boolean {
  const minStride = frame.width * CAPTURE_BYTES_PER_PIXEL;
  if (!Number.isInteger(frame.stride_bytes) || frame.stride_bytes < minStride) {
    return false;
  }
  if (
    !Number.isInteger(frame.byte_length) ||
    frame.byte_length < frame.stride_bytes * (frame.height - 1) + minStride
  ) {
    return false;
  }
  return true;
}
