// P9.3 Post-Encode Media Validation — structured ffprobe verification,
// faststart placement check, and streaming SHA-256 digest.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Section 22 (Atomic Publication
// & Media Validation) and P9.1 RecordingManifest 1.0 (media check names).
//
// All verification operates on structured data: ffprobe JSON (never
// human-readable text scraping), MP4 box headers (moov-before-mdat order),
// and chunked hashing (never whole-file buffering). Filesystem reads live in
// the Main-side owner; this module exposes pure verification plus an
// abstract byte-range reader so faststart/digest logic is unit-testable over
// in-memory bytes with zero disk.

import { createHash } from "node:crypto";
import {
  MEDIA_CHECK_NAMES,
  type MediaCheckName,
  type MediaCheckResult,
} from "../manifest.ts";
import {
  RECORDING_FPS,
  RECORDING_HEIGHT,
  RECORDING_WIDTH,
} from "../encoder-profile.ts";

// ---------------------------------------------------------------------------
// FFprobe JSON Verification
// ---------------------------------------------------------------------------

export interface MediaValidationExpectation {
  readonly width: 1920;
  readonly height: 1080;
  readonly fps: 30;
  /** Expected take duration from encoder accounting, seconds. */
  readonly expectedDurationS: number;
  /** Preflight ceiling for the final file, bytes. */
  readonly sizeCeilingBytes: number;
  /** Actual temp file size, bytes. */
  readonly actualSizeBytes: number;
}

export interface MediaValidationOutcome {
  readonly verdict: "PASS" | "FAIL";
  readonly checks: MediaCheckResult[];
}

/** Minimal structural view of `ffprobe -show_format -show_streams`. */
export interface FfprobeFormatView {
  readonly format_name?: string;
  readonly duration?: string;
  readonly size?: string;
}

export interface FfprobeStreamView {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly avg_frame_rate?: string;
  readonly pix_fmt?: string;
  readonly nb_frames?: string;
  readonly duration?: string;
}

export interface FfprobePacketView {
  readonly pts?: number;
  readonly dts?: number;
  readonly stream_index?: number;
}

export interface FfprobeDocView {
  readonly format?: FfprobeFormatView;
  readonly streams?: FfprobeStreamView[];
  readonly packets?: FfprobePacketView[];
}

function check(name: MediaCheckName, passed: boolean): MediaCheckResult {
  return { check: name, passed };
}

/** Parses an "N/D" rational frame rate into a float, or null. */
export function parseFrameRate(rate: string | undefined): number | null {
  if (typeof rate !== "string") {
    return null;
  }
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(rate.trim());
  if (match === null) {
    return null;
  }
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return null;
  }
  return num / den;
}

/**
 * Verifies structured ffprobe output against the canonical 1080p30/H.264/
 * yuv420p/MP4 contract. Check order and names match the P9.1 manifest
 * MEDIA_CHECK_NAMES vocabulary exactly.
 */
export function verifyMediaJson(
  doc: FfprobeDocView,
  expectation: MediaValidationExpectation,
): MediaValidationOutcome {
  const checks: MediaCheckResult[] = [];
  const formatName = doc.format?.format_name ?? "";
  const containerOk =
    formatName.split(",").some((part) => part.trim() === "mp4") ||
    formatName.split(",").some((part) => part.trim() === "mov");
  checks.push(check("container_readable", containerOk && doc.format !== undefined));

  const videoStreams = (doc.streams ?? []).filter((s) => s.codec_type === "video");
  const audioStreams = (doc.streams ?? []).filter((s) => s.codec_type === "audio");
  const primary = videoStreams[0];
  // Silent-video + single-program invariants (design Section 14): exactly
  // one video stream, zero audio streams, yuv420p exactly — folded into the
  // codec verdict so the frozen 8-check vocabulary is preserved.
  const programOk =
    videoStreams.length === 1 &&
    audioStreams.length === 0 &&
    primary?.pix_fmt === "yuv420p";
  checks.push(
    check(
      "codec_h264",
      programOk && primary?.codec_name === "h264",
    ),
  );
  checks.push(
    check(
      "resolution_1920x1080",
      primary?.width === RECORDING_WIDTH && primary?.height === RECORDING_HEIGHT,
    ),
  );
  const fps = parseFrameRate(primary?.avg_frame_rate);
  checks.push(
    check(
      "fps_approx_30",
      fps !== null && Math.abs(fps - RECORDING_FPS) <= 1,
    ),
  );
  const durationS = Number(doc.format?.duration);
  const durationOk =
    Number.isFinite(durationS) &&
    durationS > 0 &&
    Math.abs(durationS - expectation.expectedDurationS) <= 2;
  checks.push(check("duration_within_tolerance", durationOk));
  const nbFramesRaw = primary?.nb_frames;
  const nbFrames = nbFramesRaw === undefined ? Number.NaN : Number(nbFramesRaw);
  // An explicit zero frame count always fails, even when duration parses.
  const explicitZeroFrames = Number.isFinite(nbFrames) && nbFrames === 0;
  const frameCountOk =
    !explicitZeroFrames &&
    ((Number.isFinite(nbFrames) && nbFrames > 0) ||
      (durationOk && audioStreams.length === 0 && videoStreams.length >= 1));
  checks.push(check("nonzero_frames", frameCountOk));
  checks.push(check("pts_monotonic", verifyPacketsMonotonic(doc.packets)));
  const sizeOk =
    expectation.actualSizeBytes > 0 &&
    expectation.actualSizeBytes <= expectation.sizeCeilingBytes;
  checks.push(check("size_within_ceiling", sizeOk));

  const verdict = checks.every((c) => c.passed) ? "PASS" : "FAIL";
  assertCheckVocabulary(checks);
  return { verdict, checks };
}

/**
 * Extracts and validates the media frame count from the primary video stream.
 * Returns a positive safe integer if present and valid; null otherwise.
 */
export function parseMediaFrameCount(doc: FfprobeDocView): number | null {
  const videoStreams = (doc.streams ?? []).filter((s) => s.codec_type === "video");
  const primary = videoStreams[0];
  const raw = primary?.nb_frames;
  if (typeof raw !== "string") {
    return null;
  }
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0 || !Number.isSafeInteger(n)) {
    return null;
  }
  return n;
}

/**
 * Verifies packet timing sanity in file (decode) order. H.264 uses B-frame
 * reordering, so packet PTS is NOT monotonic in file order by design (proven
 * on the pinned rig: 0, 4096, 2048, 1024, ...). The correct monotonic
 * signal is DTS (decode timeline), which must be non-decreasing; packets
 * without a finite DTS fall back to PTS. Negative starting DTS (encoder
 * delay / edit list) is normal and allowed.
 */
export function verifyPacketsMonotonic(
  packets: FfprobePacketView[] | undefined,
): boolean {
  if (packets === undefined || packets.length === 0) {
    return true;
  }
  let last: number | null = null;
  let observed = 0;
  for (const packet of packets.slice(0, 600)) {
    const dts = packet.dts;
    const pts = packet.pts;
    const stamp =
      typeof dts === "number" && Number.isFinite(dts)
        ? dts
        : typeof pts === "number" && Number.isFinite(pts)
          ? pts
          : null;
    if (stamp === null) {
      continue;
    }
    observed += 1;
    if (last !== null && stamp < last) {
      return false;
    }
    last = stamp;
  }
  return observed > 0 || packets.length === 0;
}

function assertCheckVocabulary(checks: MediaCheckResult[]): void {
  const names = checks.map((c) => c.check).sort();
  const expected = [...MEDIA_CHECK_NAMES].sort();
  if (names.length !== expected.length || !names.every((n, i) => n === expected[i])) {
    throw new Error("[MEDIA_VALIDATION_INVALID] check vocabulary drifted");
  }
}

// ---------------------------------------------------------------------------
// Faststart Verification (moov before mdat, via abstract byte ranges)
// ---------------------------------------------------------------------------

/** Abstract async byte-range reader (file-backed in the owner). */
export type ByteRangeReader = (
  offset: number,
  length: number,
) => Promise<Uint8Array>;

/**
 * Verifies MP4 faststart placement: the `moov` box must precede the first
 * `mdat` box. Reads box headers sequentially from offset 0 (bounded: stops
 * after 8 MiB or 64 boxes). Pure over the reader: unit tests inject memory.
 */
export async function verifyFaststartMoovFirst(
  read: ByteRangeReader,
): Promise<boolean> {
  const SCAN_LIMIT = 8 * 1024 * 1024;
  const MAX_BOXES = 64;
  let offset = 0;
  for (let i = 0; i < MAX_BOXES; i += 1) {
    if (offset + 8 > SCAN_LIMIT) {
      return false;
    }
    const header = await read(offset, 8);
    if (header.length < 8) {
      return false;
    }
    const size =
      header[0]! * 0x1000000 + header[1]! * 0x10000 + header[2]! * 0x100 + header[3]!;
    const type = String.fromCharCode(header[4]!, header[5]!, header[6]!, header[7]!);
    if (type === "moov") {
      return true;
    }
    if (type === "mdat") {
      return false;
    }
    if (!Number.isInteger(size) || size < 8) {
      // size==1 (largesize) / size==0 (to-EOF): unsupported placement.
      return false;
    }
    offset += size;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Streaming SHA-256 Digest (chunked; never whole-file buffering)
// ---------------------------------------------------------------------------

/** Incremental lowercase-hex SHA-256 over caller-supplied chunks. */
export class StreamingDigest {
  private readonly hash = createHash("sha256");
  private bytes = 0;
  private finalized: { hex: string; bytes: number } | null = null;

  update(chunk: Uint8Array): void {
    if (this.finalized !== null) {
      throw new Error("[DIGEST_INVALID] digest already finalized");
    }
    this.hash.update(chunk);
    this.bytes += chunk.length;
  }

  /** Finalizes and returns the lowercase canonical hex digest. */
  digest(): { hex: string; bytes: number } {
    if (this.finalized === null) {
      const hex = this.hash.digest("hex");
      if (!/^[0-9a-f]{64}$/.test(hex)) {
        throw new Error("[DIGEST_INVALID] non-canonical digest output");
      }
      this.finalized = { hex, bytes: this.bytes };
    }
    return this.finalized;
  }
}

/** One-shot helper for small buffers (tests/evidence scaffolding). */
export function sha256HexOfBytes(bytes: Uint8Array): string {
  const digest = new StreamingDigest();
  digest.update(bytes);
  return digest.digest().hex;
}
