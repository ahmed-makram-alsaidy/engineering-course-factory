// P9.3 Encoder Frame Ingest — trusted frame validation, PTS mapping,
// pacing policy, and drop/coalesce accounting.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 9-11, 16, 19 and
// docs/adr/ADR-0014-screen-recording-boundary.md (threats T5/T10: stale
// generation frames, window substitution).
//
// Every frame entering the rawvideo pipe is checked for session/take/
// generation fencing, canonical geometry, BGRA8 format, byte-length
// coherence, and strictly increasing frame sequence. Timing derives from
// normalized capture ordering only: encode index n (1-based, zero-based
// frame index i = n-1) maps to floor(i x 1,000,000 / 30) us on the exact
// rational 30/1 CFR timeline (matching the FFmpeg -framerate 30 / -r 30
// media clock). No wall clock, no Date reads, no runtime-event mapping
// (P9.4 scope).

import { z } from "zod";
import {
  CAPTURE_BYTES_PER_PIXEL,
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  isCoherentFrameLayout,
} from "../capture/capture-format.ts";
import {
  sanitizeRecordingMessage,
  toRecordingErrorDto,
  type RecordingErrorCode,
  type TakeFence,
} from "../protocol.ts";

// ---------------------------------------------------------------------------
// Encoder Frame Input (trusted Main-side envelope + CPU bytes)
// ---------------------------------------------------------------------------

/**
 * One frame offered to the encoder. Metadata mirrors the P9.2 CaptureFrame
 * contract; `bytes` is the CPU BGRA buffer supplied by a trusted Main-side
 * byte source (native readback seam or deterministic fixture source).
 * `stride_bytes` may exceed `width x 4` (native row pitch); the owner packs
 * tight rows before piping. Renderer bytes can never arrive here: there is
 * no renderer path to this interface.
 */
export const EncoderFrameInputSchema = z.strictObject({
  frame_seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  capture_timestamp_us: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  width: z.number().int().min(1).max(7680),
  height: z.number().int().min(1).max(4320),
  pixel_format: z.literal("bgra8"),
  stride_bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  recording_session_id: z.string().min(1).max(128),
  take_id: z.string().min(3).max(32),
  runtime_session_id: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  content_digest_fnv1a64: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  filler: z.boolean().optional(),
});

export type EncoderFrameInput = z.infer<typeof EncoderFrameInputSchema> & {
  readonly bytes: Uint8Array;
};

/** Minimum tight byte size for canonical 1080p BGRA8. */
export const ENCODER_TIGHT_FRAME_BYTES =
  CAPTURE_WIDTH * CAPTURE_HEIGHT * CAPTURE_BYTES_PER_PIXEL;

/** Packs one stride-padded BGRA buffer into tight width*4 rows. */
export function packTightRows(
  bytes: Uint8Array,
  width: number,
  height: number,
  strideBytes: number,
): Uint8Array {
  const rowBytes = width * CAPTURE_BYTES_PER_PIXEL;
  if (strideBytes === rowBytes) {
    return bytes.slice(0, rowBytes * height);
  }
  const out = new Uint8Array(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    out.set(bytes.subarray(row * strideBytes, row * strideBytes + rowBytes), row * rowBytes);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frame Validation
// ---------------------------------------------------------------------------

export interface EncoderFrameExpectation extends TakeFence {
  readonly take_id: string;
  /** Highest frame_seq accepted so far (strictly increasing required). */
  readonly lastFrameSeq: number;
}

export interface EncoderFrameAccept {
  readonly ok: true;
  readonly encodeIndex: number;
  readonly pts_us: number;
  readonly isFiller: boolean;
}

export interface EncoderFrameReject {
  readonly ok: false;
  readonly code: RecordingErrorCode;
  readonly message: string;
}

export type EncoderFrameVerdict = EncoderFrameAccept | EncoderFrameReject;

function reject(
  code: RecordingErrorCode,
  message: string,
): EncoderFrameReject {
  return { ok: false, code, message: sanitizeRecordingMessage(message) };
}

/**
 * Validates one candidate frame against the take fence and canonical media
 * contract. Pure: no I/O, no clock. `acceptedSoFar` is the count of frames
 * already accepted (drives the encode index + PTS assignment).
 */
export function validateEncoderFrame(
  frame: Omit<EncoderFrameInput, "bytes"> & { bytes: Uint8Array },
  expectation: EncoderFrameExpectation,
  acceptedSoFar: number,
): EncoderFrameVerdict {
  const parsed = EncoderFrameInputSchema.safeParse(stripBytes(frame));
  if (!parsed.success) {
    return reject("INVALID_REQUEST", "frame envelope failed schema validation");
  }
  const f = parsed.data;
  if (
    f.recording_session_id !== expectation.recording_session_id ||
    f.runtime_session_id !== expectation.runtime_session_id ||
    f.take_id !== expectation.take_id
  ) {
    return reject("STALE_SESSION", "frame take fence mismatch");
  }
  if (f.generation !== expectation.generation) {
    return reject("STALE_GENERATION", "frame generation is stale for this take");
  }
  if (f.width !== CAPTURE_WIDTH || f.height !== CAPTURE_HEIGHT) {
    return reject(
      "WINDOW_GEOMETRY_MISMATCH",
      `frame geometry is ${f.width}x${f.height}; canonical take requires ${CAPTURE_WIDTH}x${CAPTURE_HEIGHT}`,
    );
  }
  if (
    !isCoherentFrameLayout({
      width: f.width,
      height: f.height,
      stride_bytes: f.stride_bytes,
      byte_length: frame.bytes.length,
    })
  ) {
    return reject("INVALID_REQUEST", "frame byte layout incoherent");
  }
  const minBytes =
    f.stride_bytes * (f.height - 1) + f.width * CAPTURE_BYTES_PER_PIXEL;
  if (frame.bytes.length < minBytes) {
    return reject("INVALID_REQUEST", "frame payload shorter than stride layout");
  }
  if (f.frame_seq <= expectation.lastFrameSeq) {
    return reject(
      "INVALID_REQUEST",
      `frame_seq ${f.frame_seq} is not after ${expectation.lastFrameSeq}`,
    );
  }
  const encodeIndex = acceptedSoFar + 1;
  return {
    ok: true,
    encodeIndex,
    pts_us: ptsForEncodeIndex(encodeIndex),
    isFiller: f.filler === true,
  };
}

function stripBytes(frame: {
  bytes: Uint8Array;
}): Record<string, unknown> {
  const { bytes: _dropped, ...rest } = frame as Record<string, unknown> & {
    bytes: Uint8Array;
  };
  void _dropped;
  return rest;
}

// ---------------------------------------------------------------------------
// PTS Mapping (canonical 30 FPS CFR timeline)
// ---------------------------------------------------------------------------

/**
 * Canonical PTS: encode index n (1-based acceptance order, zero-based
 * frame index i = n-1) maps to floor(i x 1,000,000 / 30) us on the exact
 * rational 30/1 CFR timeline — the same timeline the FFmpeg `-framerate 30`
 * / `-r 30` media clock produces. Monotonic by construction; derived from
 * trusted capture ordering, never from a wall clock. Systematic CFR drift
 * relative to the exact rational timeline is 0 us. (33,334 us remains only
 * the maximum single-frame correlation error bound, never a per-frame step.)
 */
export function ptsForEncodeIndex(encodeIndex: number): number {
  if (!Number.isInteger(encodeIndex) || encodeIndex < 1) {
    throw new Error("[ENCODER_PTS_INVALID] encode index must be >= 1");
  }
  return Math.floor(((encodeIndex - 1) * 1_000_000) / 30);
}

// ---------------------------------------------------------------------------
// Pacing Policy (deterministic; arrival order only)
// ---------------------------------------------------------------------------

export const PACING_VERDICTS = ["accept", "coalesce-duplicate"] as const;
export type PacingVerdict = (typeof PACING_VERDICTS)[number];

/**
 * Deterministic pacing classification for an accepted frame given the
 * previously accepted content digest. Static captures are valid video:
 * identical consecutive digests are still written (CFR continuity) but
 * counted as coalesced so P10 can hold narration over stills. Dropped
 * frames are represented by counters, never by PTS warps.
 */
export function classifyPacing(
  digest: string | undefined,
  previousDigest: string | undefined,
): PacingVerdict {
  if (
    digest !== undefined &&
    previousDigest !== undefined &&
    digest === previousDigest
  ) {
    return "coalesce-duplicate";
  }
  return "accept";
}

// ---------------------------------------------------------------------------
// Error DTO Helper
// ---------------------------------------------------------------------------

/** Builds a sanitized encoder error DTO bound to the take fence. */
export function encoderErrorDto(input: {
  code: RecordingErrorCode;
  message: string;
  recording_session_id?: string;
  take_id?: string;
}): ReturnType<typeof toRecordingErrorDto> {
  return toRecordingErrorDto({
    code: input.code,
    message: input.message,
    ...(input.recording_session_id === undefined
      ? {}
      : { recording_session_id: input.recording_session_id }),
    ...(input.take_id === undefined ? {} : { take_id: input.take_id }),
    phase: "ENCODING",
  });
}
