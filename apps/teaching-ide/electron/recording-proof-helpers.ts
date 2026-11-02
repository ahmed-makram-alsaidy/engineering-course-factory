// P9.8 proof helpers — pure, deterministic, Electron-free.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md task P9.8.
// OWNERSHIP (proof-only, no phase creep):
//   - This module owns ONLY pure proof computations shared between the
//     headed proof entry (recording-proof.ts, Electron Main) and the
//     deterministic unit tests (tests/recording-proof.test.ts). It imports
//     nothing from Electron, never touches the filesystem/processes, and
//     never sees host paths, PIDs, HWNDs, or ports.
//   - The renderer can never reach this module (no IPC, no preload surface).
//   - Production files are never imported for behavior here beyond frozen
//     numeric contracts repeated as literals with provenance comments.

// ---------------------------------------------------------------------------
// Frozen numeric contracts (literals mirror the frozen product constants)
// ---------------------------------------------------------------------------

/** Canonical take geometry (capture-format.ts CAPTURE_WIDTH/HEIGHT). */
export const P98_WIDTH = 1920;
/** Canonical take geometry (capture-format.ts CAPTURE_WIDTH/HEIGHT). */
export const P98_HEIGHT = 1080;
/** Canonical frame rate numerator (timeline-clock.ts FPS_NUMERATOR). */
export const P98_FPS_NUMERATOR = 30;
/** Canonical frame rate denominator (timeline-clock.ts FPS_DENOMINATOR). */
export const P98_FPS_DENOMINATOR = 1;
/** Single-frame error bound in microseconds (MAX_FRAME_INTERVAL_US). */
export const P98_MAX_FRAME_INTERVAL_US = 33_334;
/** Canonical post-runtime tail in milliseconds (protocol.ts RECORDING_TAIL_MS). */
export const P98_TAIL_MS = 2_000;
/** Recording temp floor: 12 GiB on the configured volume. */
export const P98_DISK_FLOOR_BYTES = 12_884_901_888;
/** C: hold floor: 4 GiB. */
export const P98_C_FLOOR_BYTES = 4_294_967_296;

// ---------------------------------------------------------------------------
// Proof argv parsing (pure)
// ---------------------------------------------------------------------------

export interface P98Argv {
  readonly proof: boolean;
  readonly smokeP615: boolean;
  readonly recordSafe: boolean;
  readonly windowSize: { width: number; height: number } | null;
}

const WINDOW_SIZE_RE = /^--window-size=(\d{3,5})x(\d{3,5})$/;

/** Parses proof-relevant argv flags without side effects. */
export function parseP98Argv(argv: readonly string[]): P98Argv {
  let windowSize: { width: number; height: number } | null = null;
  for (const arg of argv) {
    const match = arg.match(WINDOW_SIZE_RE);
    if (match) {
      windowSize = { width: Number(match[1]), height: Number(match[2]) };
    }
  }
  return {
    proof: argv.includes("--proof-p98"),
    smokeP615: argv.includes("--smoke-p615"),
    recordSafe: argv.includes("--record-safe"),
    windowSize,
  };
}

/** True only for the canonical proof invocation (explicit + safe + 1080p). */
export function isCanonicalP98Invocation(parsed: P98Argv): boolean {
  return (
    parsed.proof &&
    parsed.smokeP615 &&
    parsed.recordSafe &&
    parsed.windowSize !== null &&
    parsed.windowSize.width === P98_WIDTH &&
    parsed.windowSize.height === P98_HEIGHT
  );
}

// ---------------------------------------------------------------------------
// Exact rational 30/1 CFR helpers (mirror timeline-clock.ts, integer math)
// ---------------------------------------------------------------------------

/** Exact video time for zero-based frame index i: floor(i * 1e6 / 30). */
export function p98VideoTimeForFrameIndex(i: number): number {
  return Math.floor((i * 1_000_000) / 30);
}

/** Exact frame index for elapsed microseconds: floor(t * 30 / 1e6). */
export function p98FrameIndexForElapsedUs(tUs: number): number {
  return Math.floor((tUs * 30) / 1_000_000);
}

/**
 * Mapping error for one anchor: elapsed (event time since take start,
 * from the anchor's runtime_monotonic_ms) minus the anchor video time.
 * Under the canonical preceding-frame policy this lies in (-33334, 0];
 * the absolute value must stay below one frame interval.
 */
export function p98AnchorMappingErrorUs(args: {
  anchorRuntimeMs: number;
  takeStartRuntimeMs: number;
  anchorVideoTimeUs: number;
}): number {
  const elapsedUs = Math.round((args.anchorRuntimeMs - args.takeStartRuntimeMs) * 1000);
  return elapsedUs - args.anchorVideoTimeUs;
}

// ---------------------------------------------------------------------------
// Safe evidence scrubbing (pure)
// ---------------------------------------------------------------------------

const WINDOWS_PATH_RE = /[A-Za-z]:[\\/][^\s"'`]*|\\\\[^\s"'`]*/g;
const USER_HOME_RE = /\/home\/[^\s"'`/]+|\/Users\/[^\s"'`/]+/g;

/**
 * Redacts host paths from a diagnostics string for privacy-safe evidence.
 * Never throws; returns "[scrubbed]" when input is not a string.
 */
export function scrubP98EvidenceText(value: unknown): string {
  if (typeof value !== "string") return "[scrubbed]";
  let out = value.replace(WINDOWS_PATH_RE, "[path]").replace(USER_HOME_RE, "[path]");
  if (out.length > 2048) out = out.slice(0, 2048);
  return out;
}

/**
 * True when a log line carries no forbidden proof-external identity:
 * no drive-absolute path, no UNC path, no HWND-looking 64-bit hex handle,
 * no argv dump. Drive letters alone (e.g. "D:") are allowed.
 */
export function isP98SafeLogLine(line: string): boolean {
  if (/[A-Za-z]:[\\/]/.test(line)) return false;
  if (/\\\\[A-Za-z0-9]/.test(line)) return false;
  if (/\bHWND\b/i.test(line)) return false;
  if (/\bpid\s*[:=]\s*\d+/i.test(line)) return false;
  if (/0x[0-9a-fA-F]{8,}/.test(line)) return false;
  if (/--ffmpeg|--ffprobe|ffmpeg\.exe/i.test(line)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Frame-diversity helpers (pure, over framemd5-style digest lists)
// ---------------------------------------------------------------------------

/** Counts distinct frame digests (case-insensitive, trimmed). */
export function countDistinctP98Frames(digests: readonly string[]): number {
  const seen = new Set<string>();
  for (const digest of digests) {
    const normalized = digest.trim().toLowerCase();
    if (normalized.length > 0) seen.add(normalized);
  }
  return seen.size;
}

/**
 * True when decoded frames prove non-frozen content: at least three
 * distinct digests across the take (progression, not a still image).
 */
export function passesP98DiversityGate(digests: readonly string[]): boolean {
  return countDistinctP98Frames(digests) >= 3;
}

/** Population variance of a byte sample (0 for empty input). */
export function p98ByteVariance(sample: Uint8Array): number {
  if (sample.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < sample.length; i += 1) sum += sample[i]!;
  const mean = sum / sample.length;
  let squared = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const delta = sample[i]! - mean;
    squared += delta * delta;
  }
  return squared / sample.length;
}

// ---------------------------------------------------------------------------
// Manifest 1.1 verbatim frame mapping (read/assert only; no projection)
// ---------------------------------------------------------------------------
//
// Canonical authority: P9.1 FrameCounters Corrective Addendum. Settlement
// values map verbatim into the Manifest 1.1 FrameCounters. Proof harness
// does not project, recalculate, or manufacture accounting.

export interface P98SettlementCounts {
  readonly capturedFrames: number;
  readonly encodedFrames: number;
  readonly droppedFrames: number;
  readonly coalescedFrames: number;
  readonly fillerFrames: number;
}

export interface P98ManifestFrames {
  readonly captured_frame_count: number;
  readonly encoded_frame_count: number;
  readonly dropped_frame_count: number;
  readonly coalesced_frame_count: number;
  readonly filler_frame_count: number;
}

/** Verbatim Manifest 1.1 FrameCounters mapping from settlement truth (no projection). */
export function p98VerbatimManifestFrames(input: P98SettlementCounts): P98ManifestFrames {
  return {
    captured_frame_count: input.capturedFrames,
    encoded_frame_count: input.encodedFrames,
    dropped_frame_count: input.droppedFrames,
    coalesced_frame_count: input.coalescedFrames,
    filler_frame_count: input.fillerFrames,
  };
}

// ---------------------------------------------------------------------------
// framemd5 visual-proof parsing (pure, over ffmpeg framemd5 stdout)
// ---------------------------------------------------------------------------
//
// ffmpeg `-f framemd5` prints one comma-separated line per decoded video
// frame ending with the per-frame MD5 of decoded pixels, plus `#` comment
// lines. This parser extracts the terminal MD5 token of every non-comment
// line (lowercased, 32-hex validated); unparseable lines are ignored so a
// truncated stream fails the diversity gate instead of throwing.

const FRAMEMD5_HEX_RE = /^[0-9a-f]{32}$/;

/** Extracts per-frame decoded-pixel MD5s from ffmpeg framemd5 stdout. */
export function parseP98Framemd5(stdout: string): string[] {
  const digests: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    const parts = line.split(",");
    const tail = (parts[parts.length - 1] ?? "").trim().toLowerCase();
    if (FRAMEMD5_HEX_RE.test(tail)) digests.push(tail);
  }
  return digests;
}

/** Counts frame-to-frame transitions (adjacent MD5 differs). */
export function countP98FrameTransitions(digests: readonly string[]): number {
  let transitions = 0;
  for (let i = 1; i < digests.length; i += 1) {
    if (digests[i] !== digests[i - 1]) transitions += 1;
  }
  return transitions;
}
