// P9.3 Encoder Process Contract — internal owner states, bounds, timeouts,
// capability descriptors, encoder selection, and run statistics.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 11-13, 19, 21 and
// docs/adr/ADR-0014-screen-recording-boundary.md (Deterministic Media
// Contract, Main-owned media boundary).
//
// This module is pure policy: frozen constants, closed-vocabulary types,
// capability normalization, and deterministic encoder selection. It owns
// zero processes, zero filesystem access, zero wall-clock reads, and zero
// renderer-facing surface. Process execution lives in the Main-side owner
// under engine/recording/host/ (P9.3 scope), audited by scripts/validate-p9-3.sh.

import { z } from "zod";
import { ENCODER_FLUSH_TIMEOUT_MS } from "../disk-budget.ts";
import {
  EncoderDescriptorSchema,
  type EncoderDescriptor,
  type EncoderFallbackReason,
} from "../encoder-profile.ts";
import {
  RECORDING_FPS,
  RECORDING_HEIGHT,
  RECORDING_WIDTH,
} from "../encoder-profile.ts";
import type { RecordingErrorCode } from "../protocol.ts";

// ---------------------------------------------------------------------------
// Internal Encoder Process States (P9.3 owner lifecycle; NOT RecordingState)
// ---------------------------------------------------------------------------

/**
 * Owner-side encoder process states. These describe the Main-side FFmpeg
 * ownership lifecycle only and never enter the RecordingManifest: the P9.1
 * RecordingState schema is frozen and untouched.
 */
export const ENCODER_PROCESS_STATES = [
  "CREATED",
  "PROBING",
  "READY",
  "ENCODING",
  "FLUSHING",
  "VALIDATING",
  "COMPLETED",
  "FAILED",
  "ABORTING",
  "CLOSED",
] as const;

export const EncoderProcessStateSchema = z.enum(ENCODER_PROCESS_STATES);
export type EncoderProcessState = z.infer<typeof EncoderProcessStateSchema>;

// ---------------------------------------------------------------------------
// Frozen Bounds & Timeouts
// ---------------------------------------------------------------------------

/** Encoder-side pending-frame cap: 12 frames (~94.9 MiB at 1080p BGRA). */
export const ENCODER_QUEUE_CAP_FRAMES = 12;

/** Byte size of one canonical 1080p BGRA frame. */
export const ENCODER_FRAME_BYTES_1080P =
  RECORDING_WIDTH * RECORDING_HEIGHT * 4;

/** Maximum retained encoder-side pending bytes (12 x ~8 MiB, <= 96 MiB). */
export const MAX_ENCODER_QUEUE_BYTES =
  ENCODER_QUEUE_CAP_FRAMES * ENCODER_FRAME_BYTES_1080P;

/** Capability probe bound: each self-test encode must finish inside this. */
export const ENCODER_PROBE_TIMEOUT_MS = 30_000;

/** Spawn-to-ready bound: the owned process must accept frames inside this. */
export const ENCODER_STARTUP_TIMEOUT_MS = 15_000;

/** Backpressure bound: a stalled stdin drain fails the take after this. */
export const ENCODER_DRAIN_TIMEOUT_MS = 5_000;

/** Process-exit bound after stdin close / terminate request. */
export const ENCODER_EXIT_TIMEOUT_MS = 10_000;

/** Post-encode media verification bound (one bounded ffprobe invocation). */
export const FFPROBE_TIMEOUT_MS = 15_000;

/** Re-exported flush bound (P9-DESIGN-SPEC Section 19: 30 s, P9.1-owned). */
export const P93_FLUSH_TIMEOUT_MS = ENCODER_FLUSH_TIMEOUT_MS;

/** Bounded stderr diagnostic tail retained for sanitized evidence (8 KiB). */
export const MAX_STDERR_TAIL_BYTES = 8_192;

/** Bounded stdout capture (the encoder must not chatter on stdout). */
export const MAX_STDOUT_TAIL_BYTES = 4_096;

/** Canonical frames per second (P9.1 frozen; repeated here for PTS math). */
export const P93_FPS = RECORDING_FPS;

// ---------------------------------------------------------------------------
// Tool Capability Descriptor (privacy-safe: versions only, never paths)
// ---------------------------------------------------------------------------

export const ENCODER_PROBE_STATUSES = [
  "available",
  "missing",
  "self-test-failed",
] as const;

export const EncoderProbeStatusSchema = z.enum(ENCODER_PROBE_STATUSES);
export type EncoderProbeStatus = z.infer<typeof EncoderProbeStatusSchema>;

/**
 * Privacy-safe capability record. Carries tool versions and per-encoder
 * probe outcomes only. Absolute executable paths, PIDs, command lines, and
 * environment facts are structurally absent by construction.
 */
export const ToolCapabilitySchema = z.strictObject({
  ffmpeg_version: z.string().min(1).max(128),
  ffprobe_version: z.string().min(1).max(128),
  nvenc: EncoderProbeStatusSchema,
  libx264: EncoderProbeStatusSchema,
});
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;

/**
 * Parses `ffmpeg -version` / `ffprobe -version` first-line output into a
 * bare version token (e.g. "8.1.1-full_build-www.gyan.dev"). Operates on one
 * line: callers split multi-line banners first. A trailing CR (CRLF tool
 * output) is tolerated; any other control character rejects the banner.
 */
export function parseToolVersion(firstLine: string, tool: "ffmpeg" | "ffprobe"): string | null {
  if (typeof firstLine !== "string") {
    return null;
  }
  const line = firstLine.split("\n", 1)[0]!.replace(/\r$/, "").trim();
  const pattern =
    tool === "ffmpeg" ? /^ffmpeg version (\S+)/ : /^ffprobe version (\S+)/;
  const match = pattern.exec(line);
  if (match === null) {
    return null;
  }
  const version = match[1]!;
  if (version.length > 128 || /[\u0000-\u001F\u007F]/.test(version)) {
    return null;
  }
  return version;
}

// ---------------------------------------------------------------------------
// Encoder Selection (NVENC primary, explicit libx264 fallback, else fail)
// ---------------------------------------------------------------------------

export interface RawEncoderProbe {
  readonly listed: boolean;
  readonly selfTest: "pass" | "fail";
  readonly contextUnavailable?: boolean;
}

export type EncoderSelection =
  | {
      readonly ok: true;
      readonly descriptor: Omit<EncoderDescriptor, "encoder_version">;
    }
  | { readonly ok: false; readonly code: "ENCODER_UNAVAILABLE" };

function nvencFallbackReason(probe: RawEncoderProbe): EncoderFallbackReason {
  if (!probe.listed) {
    return "NVENC_ENCODER_MISSING";
  }
  if (probe.contextUnavailable === true) {
    return "NVENC_CONTEXT_UNAVAILABLE";
  }
  return "NVENC_SELF_TEST_FAILED";
}

/**
 * Closed encoder selection. NVENC is chosen only when listed AND its bounded
 * real self-test passed. Otherwise libx264 is chosen with an explicit
 * fallback reason when ITS self-test passed. Otherwise the take fails with
 * ENCODER_UNAVAILABLE. Fallback is never silent: the reason is part of the
 * returned descriptor and lands in the manifest verbatim.
 */
export function selectEncoderFamily(
  nvenc: RawEncoderProbe,
  libx264: RawEncoderProbe,
): EncoderSelection {
  if (nvenc.listed && nvenc.selfTest === "pass") {
    return {
      ok: true,
      descriptor: {
        family: "NVENC",
        profile: "nvenc-p4-cq23",
        profile_version: "1.0",
        fallback_used: false,
      },
    };
  }
  if (libx264.listed && libx264.selfTest === "pass") {
    return {
      ok: true,
      descriptor: {
        family: "LIBX264",
        profile: "libx264-veryfast-crf21",
        profile_version: "1.0",
        fallback_used: true,
        fallback_reason: nvencFallbackReason(nvenc),
      },
    };
  }
  return { ok: false, code: "ENCODER_UNAVAILABLE" };
}

/** Validates a fully populated encoder descriptor (incl. version string). */
export function parseEncoderDescriptor(value: unknown): EncoderDescriptor {
  return EncoderDescriptorSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Internal Encoder Session Interface (trusted Main-side only)
// ---------------------------------------------------------------------------

/** Trusted temporary artifact target issued by prepare(). */
export interface EncoderPrepareTarget {
  readonly dir: string;
  readonly partialFileName: string;
}

export interface EncoderWriteAccepted {
  readonly accepted: true;
  readonly encode_seq: number;
  readonly pts_us: number;
}

export interface EncoderWriteRejected {
  readonly accepted: false;
  readonly code: RecordingErrorCode;
  readonly message: string;
}

export type EncoderWriteResult = EncoderWriteAccepted | EncoderWriteRejected;

export interface EncoderFinishResult {
  readonly stats: EncoderRunStats;
  readonly media_digest: string;
  readonly media_size_bytes: number;
  readonly validation_verdict: "PASS" | "FAIL";
  readonly media_frame_count: number | null;
}

export interface EncoderAbortResult {
  readonly aborted: boolean;
  readonly exitObserved: boolean;
  readonly tempRemoved: boolean;
  readonly stats: EncoderRunStats;
}

/**
 * Narrow trusted internal encoder interface. Implemented by the deterministic
 * fake (unit tests) and the Main-side process owner (real proofs). Never
 * exposed to the renderer: no executable, no argv, no paths cross this
 * boundary except the internally-resolved temporary target from prepare().
 */
export interface InternalEncoderSession {
  prepare(target: {
    tempRoot: string;
    recordingSessionId: string;
    takeId: string;
  }): Promise<EncoderPrepareTarget>;
  start(descriptor: EncoderDescriptor): Promise<void>;
  writeFrame(frame: unknown): Promise<EncoderWriteResult>;
  finish(): Promise<EncoderFinishResult>;
  abort(reason: string): Promise<EncoderAbortResult>;
  close(): Promise<void>;
  getStats(): EncoderRunStats;
}

// ---------------------------------------------------------------------------
// Run Statistics (safe fields only; no paths, no PIDs, no command lines)
// ---------------------------------------------------------------------------

export const EncoderRunStatsSchema = z.strictObject({
  state: EncoderProcessStateSchema,
  family: z.enum(["NVENC", "LIBX264"]).nullable(),
  profile: z.enum(["nvenc-p4-cq23", "libx264-veryfast-crf21"]).nullable(),
  fallback_used: z.boolean(),
  submitted_frames: z.number().int().min(0),
  accepted_frames: z.number().int().min(0),
  dropped_frames: z.number().int().min(0),
  coalesced_frames: z.number().int().min(0),
  piped_frames: z.number().int().min(0),
  piped_filler_frames: z.number().int().min(0),
  piped_dup_frames: z.number().int().min(0),
  pending_frames: z.number().int().min(0),
  peak_pending_frames: z.number().int().min(0),
  peak_pending_bytes: z.number().int().min(0),
  last_pts_us: z.number().int().min(0),
  exit_code: z.number().int().nullable(),
  validation_verdict: z.enum(["PASS", "FAIL"]).nullable(),
  media_digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  media_size_bytes: z.number().int().min(0),
  elapsed_ms: z.number().int().min(0),
});

export type EncoderRunStats = z.infer<typeof EncoderRunStatsSchema>;

/** Initial statistics for a freshly constructed (CREATED) session. */
export function initialEncoderRunStats(): EncoderRunStats {
  return {
    state: "CREATED",
    family: null,
    profile: null,
    fallback_used: false,
    submitted_frames: 0,
    accepted_frames: 0,
    dropped_frames: 0,
    coalesced_frames: 0,
    piped_frames: 0,
    piped_filler_frames: 0,
    piped_dup_frames: 0,
    pending_frames: 0,
    peak_pending_frames: 0,
    peak_pending_bytes: 0,
    last_pts_us: 0,
    exit_code: null,
    validation_verdict: null,
    media_digest: null,
    media_size_bytes: 0,
    elapsed_ms: 0,
  };
}

// ---------------------------------------------------------------------------
// Temporary Target Confinement (pure; shared by fake and real owner)
// ---------------------------------------------------------------------------

/** Fixed temporary partial file name (never caller-controlled). */
export const TEMP_PARTIAL_FILE_NAME = "screen.partial.mp4";

/**
 * Pure temp-target confinement check. Accepts only trusted identifier-shaped
 * components and a traversal-free root; returns the canonical relative
 * target `tempRoot/recording/<session>/<take>`. Absolute resolution and the
 * startsWith containment proof are the filesystem owner's job (host/).
 */
export function assertConfinedTempTarget(
  tempRoot: string,
  recordingSessionId: string,
  takeId: string,
): string {
  if (typeof tempRoot !== "string" || tempRoot.length === 0) {
    throw new Error("[INVALID_REQUEST] temp root must be non-empty");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(recordingSessionId)) {
    throw new Error("[INVALID_REQUEST] recording session id is not trusted");
  }
  if (!/^t\d{2,}$/.test(takeId)) {
    throw new Error("[INVALID_REQUEST] take id is not trusted");
  }
  if (
    recordingSessionId.includes("..") ||
    takeId.includes("..") ||
    tempRoot.includes("..")
  ) {
    throw new Error("[INVALID_REQUEST] traversal rejected in temp target");
  }
  return `${tempRoot}/recording/${recordingSessionId}/${takeId}`;
}
