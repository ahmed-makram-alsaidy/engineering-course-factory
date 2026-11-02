// P9.3 Fixed Encoder Argument Builder — closed argv construction.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 7, 11-12 and
// docs/adr/ADR-0014-screen-recording-boundary.md (threat T2: renderer
// injects FFmpeg args — mitigated by a frozen profile table, Main-computed
// variables only, spawn uses shell disabled).
//
// Every argv is derived ENTIRELY from frozen P9.1 profile constants plus a
// closed family selector and Main-validated integers. There is no free-form
// `extraArgs`, no string interpolation of untrusted text, no shell
// construction. The ONLY per-take variables are width/height/fps (validated
// against the canonical constants) and the internally-resolved output path.

import { z } from "zod";
import {
  CANONICAL_REQUESTED_PROFILE,
  NVENC_CQ,
  NVENC_PRESET,
  NVENC_RC,
  RECORDING_BUFSIZE_BITS,
  RECORDING_FPS,
  RECORDING_HEIGHT,
  RECORDING_MAXRATE_BPS,
  RECORDING_WIDTH,
  X264_CRF,
  X264_PRESET,
  type EncoderFamily,
} from "../encoder-profile.ts";

// ---------------------------------------------------------------------------
// Closed Selector & Validated Numerics
// ---------------------------------------------------------------------------

/** The only accepted encoder selector: an approved frozen family. */
export const EncoderArgvFamilySchema = z.enum(["NVENC", "LIBX264"]);
export type EncoderArgvFamily = z.infer<typeof EncoderArgvFamilySchema>;

/** Canonical geometry numerics: exactly 1920x1080 @ 30, nothing else. */
const CanonicalEncodeGeometrySchema = z.strictObject({
  width: z.literal(RECORDING_WIDTH),
  height: z.literal(RECORDING_HEIGHT),
  fps: z.literal(RECORDING_FPS),
});

export interface CanonicalEncodeGeometry {
  readonly width: 1920;
  readonly height: 1080;
  readonly fps: 30;
}

/** Parses + freezes caller-supplied numerics to the canonical constants. */
export function parseCanonicalEncodeGeometry(value: unknown): CanonicalEncodeGeometry {
  return CanonicalEncodeGeometrySchema.parse(value);
}

// ---------------------------------------------------------------------------
// Frozen Token Tables (derived from P9.1 constants, never from callers)
// ---------------------------------------------------------------------------

const INPUT_PIXEL_FORMAT = "bgra" as const;
const OUTPUT_FORMAT_FILTER = "format=yuv420p" as const;
const OUTPUT_FASTSTART = "+faststart" as const;

/** Bitrate cap rendering: 12 Mbps -> "12M" (frozen formatting). */
function renderMaxrate(): string {
  return `${Math.floor(RECORDING_MAXRATE_BPS / 1_000_000)}M`;
}

/** Decoder buffer rendering: 24 Mbit -> "24M" (frozen formatting). */
function renderBufsize(): string {
  return `${Math.floor(RECORDING_BUFSIZE_BITS / 1_000_000)}M`;
}

// ---------------------------------------------------------------------------
// Fixed FFmpeg Encode Argv
// ---------------------------------------------------------------------------

export interface EncodeArgvInput {
  readonly family: EncoderFamily;
  readonly geometry: CanonicalEncodeGeometry;
  /** Internally-resolved absolute temp output path (validated by the owner). */
  readonly outputPath: string;
}

/**
 * Builds the fixed encode argv for one approved family. The output path is
 * accepted as an opaque validated string and appended as the FINAL argv
 * element only — it can never become a flag, a filter, or a second output.
 */
export function buildEncodeArgv(input: EncodeArgvInput): readonly string[] {
  const family = EncoderArgvFamilySchema.parse(input.family);
  const geometry = parseCanonicalEncodeGeometry(input.geometry);
  if (typeof input.outputPath !== "string" || input.outputPath.length === 0) {
    throw new Error("[ENCODER_ARGV_INVALID] output path must be non-empty");
  }
  if (input.outputPath.length > 32_768) {
    throw new Error("[ENCODER_ARGV_INVALID] output path exceeds bound");
  }
  const videoSize = `${geometry.width}x${geometry.height}`;
  const framerate = `${geometry.fps}`;
  const profile = CANONICAL_REQUESTED_PROFILE;

  const head: string[] = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-f",
    "rawvideo",
    "-pixel_format",
    INPUT_PIXEL_FORMAT,
    "-video_size",
    videoSize,
    "-framerate",
    framerate,
    "-i",
    "pipe:0",
  ];
  const tail: string[] = [
    "-vf",
    OUTPUT_FORMAT_FILTER,
    "-g",
    `${profile.gop}`,
    "-r",
    framerate,
    "-maxrate",
    renderMaxrate(),
    "-bufsize",
    renderBufsize(),
    "-movflags",
    OUTPUT_FASTSTART,
    "-an",
    input.outputPath,
  ];
  if (family === "NVENC") {
    return [
      ...head,
      "-c:v",
      "h264_nvenc",
      "-preset",
      NVENC_PRESET,
      "-rc",
      NVENC_RC,
      "-cq",
      `${NVENC_CQ}`,
      ...tail,
    ];
  }
  return [
    ...head,
    "-c:v",
    "libx264",
    "-preset",
    X264_PRESET,
    "-crf",
    `${X264_CRF}`,
    ...tail,
  ];
}

/** Sentinel check: every encode argv ends with exactly one output path. */
export function encodeArgvOutputPath(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new Error("[ENCODER_ARGV_INVALID] argv must not be empty");
  }
  return argv[argv.length - 1]!;
}

// ---------------------------------------------------------------------------
// Fixed Self-Test Probe Argv (bounded synthetic input, E: temp output only)
// ---------------------------------------------------------------------------

export interface ProbeArgvInput {
  readonly family: EncoderFamily;
  /** Internally-resolved absolute temp probe output path. */
  readonly outputPath: string;
}

/**
 * Bounded real-encode probe: 1 s of in-memory testsrc at 320x180/10fps.
 * Fixed lavfi graph (Main-owned constant); callers cannot alter the filter,
 * duration, size, or rate. Output is a throwaway probe file, never a take.
 */
export function buildProbeArgv(input: ProbeArgvInput): readonly string[] {
  const family = EncoderArgvFamilySchema.parse(input.family);
  if (typeof input.outputPath !== "string" || input.outputPath.length === 0) {
    throw new Error("[ENCODER_ARGV_INVALID] probe output must be non-empty");
  }
  const head: string[] = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=320x180:rate=10:duration=1",
    "-t",
    "1",
  ];
  const tail: string[] = [
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-movflags",
    OUTPUT_FASTSTART,
    input.outputPath,
  ];
  if (family === "NVENC") {
    return [...head, "-c:v", "h264_nvenc", "-preset", NVENC_PRESET, ...tail];
  }
  return [...head, "-c:v", "libx264", "-preset", X264_PRESET, ...tail];
}

// ---------------------------------------------------------------------------
// Fixed FFprobe Validation Argv (structured JSON only)
// ---------------------------------------------------------------------------

/**
 * Fixed media-verification invocation: JSON format+stream listing plus a
 * bounded packet walk for PTS monotonicity. No caller-controlled flags.
 */
export function buildFfprobeArgv(outputPath: string): readonly string[] {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error("[ENCODER_ARGV_INVALID] ffprobe target must be non-empty");
  }
  return [
    "-hide_banner",
    "-v",
    "error",
    "-show_format",
    "-show_streams",
    "-show_packets",
    "-read_intervals",
    "%+#60",
    "-print_format",
    "json",
    outputPath,
  ];
}

/** Exact argv equality helper for audit tests (order-sensitive). */
export function argvEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Encoder Listing Pre-filter (owns the frozen codec-token literals)
// ---------------------------------------------------------------------------

/**
 * Fast pre-filter over `ffmpeg -encoders` text. The listing alone never
 * authorizes an encoder (a bounded real self-test encode decides); it only
 * distinguishes "missing" from "candidate for self-test". Lives here — the
 * single module that owns frozen codec tokens — so the token ban stays
 * enforceable everywhere else.
 */
export function parseEncoderList(text: string): {
  nvencListed: boolean;
  libx264Listed: boolean;
} {
  const normalized = typeof text === "string" ? text : "";
  return {
    nvencListed: /(^|\s)h264_nvenc(\s|$)/m.test(normalized),
    libx264Listed: /(^|\s)libx264(\s|$)/m.test(normalized),
  };
}
