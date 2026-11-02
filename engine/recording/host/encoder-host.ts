// P9.3 Main-Side Encoder Process Owner — the SOLE media child_process owner.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 7, 11-13, 19, 21-22
// and docs/adr/ADR-0014-screen-recording-boundary.md (Main-owned media
// boundary, threat T2/T6: fixed argv + shell:false, bounded terminate of the
// owned process only).
//
// This module (with tool-resolution.ts) is the ONLY place in the repository
// that spawns FFmpeg/FFprobe for recording. Audited by
// scripts/validate-p9-3.sh: exactly one spawn call site, shell:false,
// fixed argv from src/encoder policy only, no renderer-controlled values,
// no global process kill (only the owned handle is ever signalled).
//
// Main-side only: filesystem + child_process. Never imported by renderer
// code. Temporary output stays under the trusted P9 temp root (E:); C: is
// never used for frame, media, or tool temp.

import { spawn as nodeSpawn } from "node:child_process";
import { createReadStream, promises as fsp } from "node:fs";
import { join, resolve, sep, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  ENCODER_DRAIN_TIMEOUT_MS,
  ENCODER_EXIT_TIMEOUT_MS,
  ENCODER_PROBE_TIMEOUT_MS,
  ENCODER_QUEUE_CAP_FRAMES,
  ENCODER_STARTUP_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  MAX_ENCODER_QUEUE_BYTES,
  MAX_STDERR_TAIL_BYTES,
  P93_FLUSH_TIMEOUT_MS,
  TEMP_PARTIAL_FILE_NAME,
  assertConfinedTempTarget,
  initialEncoderRunStats,
  parseEncoderDescriptor,
  parseToolVersion,
  selectEncoderFamily,
  type EncoderFinishResult,
  type EncoderProbeStatus,
  type EncoderRunStats,
  type EncoderWriteResult,
  type InternalEncoderSession,
  type RawEncoderProbe,
  type ToolCapability,
} from "../src/encoder/encoder-interface.ts";
import {
  buildEncodeArgv,
  buildFfprobeArgv,
  buildProbeArgv,
  parseEncoderList,
} from "../src/encoder/encoder-argv.ts";
import {
  classifyPacing,
  packTightRows,
  validateEncoderFrame,
  type EncoderFrameInput,
} from "../src/encoder/encoder-frames.ts";
import {
  StreamingDigest,
  parseMediaFrameCount,
  verifyFaststartMoovFirst,
  verifyMediaJson,
} from "../src/encoder/media-validation.ts";
import { requiredFreeBytes } from "../src/disk-budget.ts";
import {
  RECORDING_HEIGHT,
  RECORDING_WIDTH,
  type EncoderDescriptor,
} from "../src/encoder-profile.ts";
import {
  RecordingSessionIdSchema,
  TakeIdSchema,
  sanitizeRecordingMessage,
  toRecordingErrorDto,
  type RecordingErrorCode,
  type TakeFence,
} from "../src/protocol.ts";

// ---------------------------------------------------------------------------
// Owned Process Abstraction (real spawn default, injectable fake for tests)
// ---------------------------------------------------------------------------

/** Minimal owned-process surface: exactly what the owner drives. */
export interface OwnedProcess {
  readonly stdin: Writable | null;
  readonly stderr: Readable | null;
  once(event: string, listener: (...args: Array<unknown>) => void): unknown;
  removeListener(event: string, listener: (...args: Array<unknown>) => void): unknown;
  kill(signal?: number | NodeJS.Signals): boolean;
  readonly exitCode: number | null;
  readonly killed: boolean;
}

export interface SpawnOptions {
  readonly shell: false;
  readonly stdio: readonly ["pipe", "pipe" | "ignore", "pipe"];
  readonly windowsHide: boolean;
}

export type SpawnFn = (
  exe: string,
  argv: readonly string[],
  options: SpawnOptions,
) => OwnedProcess;

/** The single sanctioned spawn call site for recording media processes. */
export const defaultSpawn: SpawnFn = (exe, argv, options) =>
  nodeSpawn(exe, [...argv], {
    shell: options.shell,
    stdio: [...options.stdio] as ["pipe", "pipe" | "ignore", "pipe"],
    windowsHide: options.windowsHide,
  }) as unknown as OwnedProcess;

/** Temporary partial file name: single canonical definition lives in policy. */
export const PARTIAL_FILE_NAME = TEMP_PARTIAL_FILE_NAME;

/** Bounded stdout cap for probe/validation invocations (4 MiB). */
export const MAX_TOOL_STDOUT_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Bounded Tool Runner (probes + ffprobe validation)
// ---------------------------------------------------------------------------

export interface BoundedRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderrTail: string;
}

export async function runBoundedTool(
  spawnFn: SpawnFn,
  exe: string,
  argv: readonly string[],
  timeoutMs: number,
  captureStdout = false,
): Promise<BoundedRunResult> {
  const child = spawnFn(exe, argv, {
    shell: false,
    stdio: ["pipe", captureStdout ? "pipe" : "ignore", "pipe"],
    windowsHide: true,
  });
  // Bounded tools never receive stdin; close it immediately when present.
  try {
    child.stdin?.end();
  } catch {
    // Best effort; the bounded wait below still applies.
  }
  let stdout = "";
  let stdoutBytes = 0;
  let stdoutOverflow = false;
  let stderrTail = "";
  const stderr = child.stderr;
  if (stderr !== null) {
    stderr.on("data", (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk);
      stderrTail = (stderrTail + text).slice(-MAX_STDERR_TAIL_BYTES);
    });
  }
  const exitPromise = new Promise<number | null>((resolve) => {
    const onExit = (...args: Array<unknown>): void => {
      const code = args[0];
      resolve(typeof code === "number" ? code : null);
    };
    child.once("exit", onExit);
    child.once("error", () => resolve(null));
  });
  let stdoutDone: Promise<void> = Promise.resolve();
  if (captureStdout) {
    const out = (child as unknown as { stdout?: Readable | null }).stdout;
    if (out !== null && out !== undefined) {
      out.on("data", (chunk: unknown) => {
        const text = Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
        if (!stdoutOverflow) {
          stdout += text;
          stdoutBytes += Buffer.byteLength(text, "utf8");
          if (stdoutBytes > MAX_TOOL_STDOUT_BYTES) {
            stdoutOverflow = true;
            try {
              child.kill();
            } catch {
              // Owned handle only; wait below still bounds the run.
            }
          }
        }
      });
      stdoutDone = new Promise<void>((resolve) => {
        out.on("end", () => resolve());
        out.on("close", () => resolve());
        out.on("error", () => resolve());
      });
    }
  }
  const timeoutPromise = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  });
  const winner = await Promise.race([
    exitPromise.then((code) => ({ kind: "exit" as const, code })),
    timeoutPromise.then(() => ({ kind: "timeout" as const, code: null })),
  ]);
  if (winner.kind === "timeout") {
    try {
      child.kill();
    } catch {
      // Owned handle only.
    }
    // Bounded post-kill grace: a hung tool must not wedge the owner.
    const graceMs = Math.min(5_000, Math.max(timeoutMs, 50));
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), graceMs);
        const unref = (timer as unknown as { unref?: () => void }).unref;
        if (typeof unref === "function") {
          unref.call(timer);
        }
      }),
    ]);
    return { exitCode: null, stdout, stderrTail };
  }
  if (captureStdout) {
    // Exit may precede the final stdout flush; drain it (bounded) so JSON
    // evidence is never truncated by the race.
    await Promise.race([
      stdoutDone,
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 5_000);
        const unref = (timer as unknown as { unref?: () => void }).unref;
        if (typeof unref === "function") {
          unref.call(timer);
        }
      }),
    ]);
  }
  return { exitCode: winner.code, stdout, stderrTail };
}

// ---------------------------------------------------------------------------
// Encoder Capability Probe (versions + real self-test encodes)
// ---------------------------------------------------------------------------

export interface EncoderPreflight {
  readonly capability: ToolCapability;
  readonly descriptor: EncoderDescriptor | null;
  readonly selectionError: "ENCODER_UNAVAILABLE" | null;
}

function statusForProbe(probe: RawEncoderProbe): EncoderProbeStatus {
  if (probe.listed && probe.selfTest === "pass") {
    return "available";
  }
  if (!probe.listed) {
    return "missing";
  }
  return "self-test-failed";
}

function isContextFailure(stderrTail: string): boolean {
  return /no capable|cuda|nvenc|initializeencoder|device/i.test(stderrTail);
}

/**
 * Main-side preflight: tool versions, encoder listing, and one bounded REAL
 * self-test encode per family. Probe outputs land in `probeDir` (E: temp)
 * under fixed names and are removed afterwards. Never throws for an
 * unhealthy toolchain: failure is data (capability + selectionError).
 */
export async function probeEncoderTools(input: {
  ffmpeg: string;
  ffprobe: string;
  probeDir: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}): Promise<EncoderPreflight> {
  const spawnFn = input.spawnFn ?? defaultSpawn;
  const timeoutMs = input.timeoutMs ?? ENCODER_PROBE_TIMEOUT_MS;
  await fsp.mkdir(input.probeDir, { recursive: true });

  const ffmpegVersionRun = await runBoundedTool(
    spawnFn,
    input.ffmpeg,
    ["-version"],
    timeoutMs,
    true,
  );
  const ffprobeVersionRun = await runBoundedTool(
    spawnFn,
    input.ffprobe,
    ["-version"],
    timeoutMs,
    true,
  );
  const ffmpegVersion = parseToolVersion(
    ffmpegVersionRun.stdout.split("\n")[0] ?? "",
    "ffmpeg",
  );
  const ffprobeVersion = parseToolVersion(
    ffprobeVersionRun.stdout.split("\n")[0] ?? "",
    "ffprobe",
  );
  if (ffmpegVersion === null || ffprobeVersion === null) {
    const capability: ToolCapability = {
      ffmpeg_version: ffmpegVersion ?? "unknown",
      ffprobe_version: ffprobeVersion ?? "unknown",
      nvenc: "missing",
      libx264: "missing",
    };
    return { capability, descriptor: null, selectionError: "ENCODER_UNAVAILABLE" };
  }

  const encodersRun = await runBoundedTool(
    spawnFn,
    input.ffmpeg,
    ["-hide_banner", "-encoders"],
    timeoutMs,
    true,
  );
  const listed = parseEncoderList(encodersRun.stdout);

  const selfTest = async (family: "NVENC" | "LIBX264"): Promise<RawEncoderProbe> => {
    const isNvenc = family === "NVENC";
    const familyListed = isNvenc ? listed.nvencListed : listed.libx264Listed;
    if (!familyListed) {
      return { listed: false, selfTest: "fail" };
    }
    const probePath = join(
      input.probeDir,
      isNvenc ? "probe-nvenc.mp4" : "probe-x264.mp4",
    );
    const run = await runBoundedTool(
      spawnFn,
      input.ffmpeg,
      [...buildProbeArgv({ family, outputPath: probePath })],
      timeoutMs,
    );
    let size = 0;
    try {
      size = (await fsp.stat(probePath)).size;
    } catch {
      size = 0;
    }
    try {
      await fsp.unlink(probePath);
    } catch {
      // Best-effort probe cleanup.
    }
    if (run.exitCode === 0 && size > 0) {
      return { listed: true, selfTest: "pass" };
    }
    return {
      listed: true,
      selfTest: "fail",
      contextUnavailable: isContextFailure(run.stderrTail),
    };
  };

  const nvencProbe = await selfTest("NVENC");
  const x264Probe = await selfTest("LIBX264");
  const capability: ToolCapability = {
    ffmpeg_version: ffmpegVersion,
    ffprobe_version: ffprobeVersion,
    nvenc: statusForProbe(nvencProbe),
    libx264: statusForProbe(x264Probe),
  };
  const selection = selectEncoderFamily(nvencProbe, x264Probe);
  if (!selection.ok) {
    return { capability, descriptor: null, selectionError: "ENCODER_UNAVAILABLE" };
  }
  return {
    capability,
    descriptor: { ...selection.descriptor, encoder_version: ffmpegVersion },
    selectionError: null,
  };
}

// ---------------------------------------------------------------------------
// Sanitized Owner Error
// ---------------------------------------------------------------------------

/** Owner error carrying a renderer/log-safe DTO (raw stderr never crosses). */
export class EncoderHostError extends Error {
  readonly dto: ReturnType<typeof toRecordingErrorDto>;
  constructor(
    code: RecordingErrorCode,
    message: string,
    fence?: TakeFence & { take_id: string },
    phase: "PREFLIGHT" | "ENCODING" | "VALIDATION" | "CLEANUP" = "ENCODING",
  ) {
    super(`[${code}] ${sanitizeRecordingMessage(message)}`);
    this.name = "EncoderHostError";
    this.dto = toRecordingErrorDto({
      code,
      message,
      ...(fence === undefined
        ? {}
        : {
            recording_session_id: fence.recording_session_id,
            take_id: fence.take_id,
          }),
      phase,
    });
  }
}

// ---------------------------------------------------------------------------
// Small Async Helpers (all waits bounded)
// ---------------------------------------------------------------------------

function boundedWait<T>(
  task: Promise<T>,
  ms: number,
  makeError: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") {
      unref.call(timer);
    }
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}

async function sha256File(absPath: string): Promise<{ hex: string; size: number }> {
  const stat = await fsp.stat(absPath);
  const digest = new StreamingDigest();
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath, { highWaterMark: 1024 * 1024 });
    stream.on("data", (chunk: Buffer | string) => {
      digest.update(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
    });
    stream.on("end", () => resolve());
    stream.on("error", (error: unknown) => reject(error));
  });
  return { hex: digest.digest().hex, size: stat.size };
}

async function readFileRange(
  absPath: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const handle = await fsp.open(absPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Encoder Host Session (real process owner)
// ---------------------------------------------------------------------------

export interface EncoderHostSessionOptions {
  readonly fence: TakeFence;
  readonly takeId: string;
  readonly tools: { readonly ffmpeg: string; readonly ffprobe: string };
  readonly spawnFn?: SpawnFn;
  readonly nowMs?: () => number;
  readonly timeouts?: {
    readonly startupMs?: number;
    readonly drainMs?: number;
    readonly flushMs?: number;
    readonly exitMs?: number;
    readonly ffprobeMs?: number;
  };
}

interface PendingItem {
  readonly buffer: Uint8Array;
  readonly encodeSeq: number;
  readonly ptsUs: number;
  readonly isFiller: boolean;
  readonly isDup: boolean;
}

/**
 * Main-side encoder session: owns ONE FFmpeg child process, its stdin
 * rawvideo pipe, and its temporary partial MP4. States follow
 * EncoderProcessState. Only the owned handle is ever signalled; there is no
 * global process sweep anywhere in this module.
 */
export class EncoderHostSession implements InternalEncoderSession {
  private readonly fence: TakeFence;
  private readonly takeId: string;
  private readonly tools: { readonly ffmpeg: string; readonly ffprobe: string };
  private readonly spawnFn: SpawnFn;
  private readonly nowMs: () => number;
  private readonly timeouts: {
    readonly startupMs: number;
    readonly drainMs: number;
    readonly flushMs: number;
    readonly exitMs: number;
    readonly ffprobeMs: number;
  };
  private readonly birthMs: number;

  private state: "CREATED" | "READY" | "ENCODING" | "FLUSHING" | "VALIDATING" | "COMPLETED" | "FAILED" | "ABORTING" | "CLOSED" = "CREATED";
  private descriptor: EncoderDescriptor | null = null;
  private proc: OwnedProcess | null = null;
  private partialAbs: string | null = null;
  private intakeOpen = false;
  private expectingExit = false;
  private failure: { code: RecordingErrorCode; message: string } | null = null;
  private stderrTail = "";
  private exitCode: number | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly queue: PendingItem[] = [];
  private queuedBytes = 0;
  private submitted = 0;
  private accepted = 0;
  private dropped = 0;
  private coalesced = 0;
  private piped = 0;
  private pipedFiller = 0;
  private pipedDup = 0;
  private lastSeq = 0;
  private lastPts = 0;
  private lastDigest: string | undefined;
  private peakPending = 0;
  private peakBytes = 0;
  private validationVerdict: "PASS" | "FAIL" | null = null;
  private mediaDigest: string | null = null;
  private mediaSize = 0;
  private pumpTail: Promise<void> = Promise.resolve();

  constructor(options: EncoderHostSessionOptions) {
    this.fence = { ...options.fence };
    this.takeId = options.takeId;
    this.tools = { ...options.tools };
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.timeouts = {
      startupMs: options.timeouts?.startupMs ?? ENCODER_STARTUP_TIMEOUT_MS,
      drainMs: options.timeouts?.drainMs ?? ENCODER_DRAIN_TIMEOUT_MS,
      flushMs: options.timeouts?.flushMs ?? P93_FLUSH_TIMEOUT_MS,
      exitMs: options.timeouts?.exitMs ?? ENCODER_EXIT_TIMEOUT_MS,
      ffprobeMs: options.timeouts?.ffprobeMs ?? FFPROBE_TIMEOUT_MS,
    };
    this.birthMs = this.nowMs();
  }

  private fenceWithTake(): TakeFence & { take_id: string } {
    return { ...this.fence, take_id: this.takeId };
  }

  private fail(code: RecordingErrorCode, message: string): void {
    if (
      this.state === "COMPLETED" ||
      this.state === "FAILED" ||
      this.state === "CLOSED"
    ) {
      return;
    }
    this.failure = { code, message: sanitizeRecordingMessage(message) };
    if (this.state !== "ABORTING") {
      this.state = "FAILED";
    }
    this.intakeOpen = false;
    this.disarmStartup();
    try {
      this.proc?.stdin?.destroy();
    } catch {
      // Owned pipe only; finish/abort observe the failure below.
    }
  }

  private killOwned(): void {
    try {
      this.proc?.kill();
    } catch {
      // Owned handle only; exit observation below still bounds the wait.
    }
  }

  private disarmStartup(): void {
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  // -- prepare ------------------------------------------------------------

  async prepare(target: {
    tempRoot: string;
    recordingSessionId: string;
    takeId: string;
  }): Promise<{ dir: string; partialFileName: string }> {
    if (this.state !== "CREATED") {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "encoder prepare is single-shot",
        this.fenceWithTake(),
        "PREFLIGHT",
      );
    }
    if (
      target.recordingSessionId !== this.fence.recording_session_id ||
      target.takeId !== this.takeId
    ) {
      throw new EncoderHostError(
        "STALE_SESSION",
        "prepare target fence mismatch",
        this.fenceWithTake(),
        "PREFLIGHT",
      );
    }
    RecordingSessionIdSchema.parse(target.recordingSessionId);
    TakeIdSchema.parse(target.takeId);
    if (!isAbsolute(target.tempRoot)) {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "temp root must be absolute",
        this.fenceWithTake(),
        "PREFLIGHT",
      );
    }
    assertConfinedTempTarget(
      target.tempRoot,
      target.recordingSessionId,
      target.takeId,
    );
    const rootResolved = resolve(target.tempRoot);
    const dir = resolve(
      rootResolved,
      "recording",
      target.recordingSessionId,
      target.takeId,
    );
    if (dir !== join(rootResolved, "recording", target.recordingSessionId, target.takeId)) {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "temp target failed containment",
        this.fenceWithTake(),
        "PREFLIGHT",
      );
    }
    if (!dir.startsWith(rootResolved + sep)) {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "temp target escapes trusted root",
        this.fenceWithTake(),
        "PREFLIGHT",
      );
    }
    await fsp.mkdir(dir, { recursive: true });
    this.partialAbs = join(dir, TEMP_PARTIAL_FILE_NAME);
    return { dir, partialFileName: TEMP_PARTIAL_FILE_NAME };
  }

  // -- start --------------------------------------------------------------

  async start(descriptor: EncoderDescriptor): Promise<void> {
    if (this.state === "CLOSED") {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "encoder is closed",
        this.fenceWithTake(),
      );
    }
    if (this.state !== "CREATED") {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "encoder start is single-shot",
        this.fenceWithTake(),
      );
    }
    if (this.partialAbs === null) {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "encoder must be prepared before start",
        this.fenceWithTake(),
      );
    }
    let parsed: EncoderDescriptor;
    try {
      parsed = parseEncoderDescriptor(descriptor);
    } catch {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "encoder descriptor failed validation",
        this.fenceWithTake(),
      );
    }
    const argv = buildEncodeArgv({
      family: parsed.family,
      geometry: { width: RECORDING_WIDTH, height: RECORDING_HEIGHT, fps: 30 },
      outputPath: this.partialAbs,
    });
    let child: OwnedProcess;
    try {
      child = this.spawnFn(this.tools.ffmpeg, argv, {
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      this.fail("ENCODER_START_FAILED", "encoder process failed to spawn");
      throw new EncoderHostError(
        "ENCODER_START_FAILED",
        "encoder process failed to spawn",
        this.fenceWithTake(),
      );
    }
    this.proc = child;
    this.descriptor = parsed;
    const stderr = child.stderr;
    if (stderr !== null) {
      stderr.on("data", (chunk: unknown) => {
        const text = Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
        this.stderrTail = (this.stderrTail + text).slice(-MAX_STDERR_TAIL_BYTES);
      });
    }
    child.once("error", (...args: Array<unknown>) => {
      void args;
      if (this.state === "READY") {
        this.fail("ENCODER_START_FAILED", "encoder process reported an error");
      } else if (!this.expectingExit) {
        this.fail("ENCODER_FAILED", "encoder process reported an error");
      }
    });
    child.once("exit", (...args: Array<unknown>) => {
      const code = args[0];
      this.exitCode = typeof code === "number" ? code : null;
      if (!this.expectingExit && (this.state === "READY" || this.state === "ENCODING" || this.state === "FLUSHING")) {
        this.fail(
          "ENCODER_FAILED",
          `encoder process exited early with code ${this.exitCode ?? "unknown"}`,
        );
      }
    });
    if (child.exitCode !== null) {
      this.fail("ENCODER_START_FAILED", "encoder process exited at spawn");
      throw new EncoderHostError(
        "ENCODER_START_FAILED",
        "encoder process exited at spawn",
        this.fenceWithTake(),
      );
    }
    this.state = "READY";
    this.intakeOpen = true;
    const timer = setTimeout(() => {
      if (this.state === "READY") {
        this.fail(
          "ENCODER_TIMEOUT",
          "encoder startup bound elapsed with no accepted frames",
        );
        this.killOwned();
      }
    }, this.timeouts.startupMs);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") {
      unref.call(timer);
    }
    this.startupTimer = timer;
  }

  // -- writeFrame ----------------------------------------------------------

  async writeFrame(frame: unknown): Promise<EncoderWriteResult> {
    if (this.state === "CLOSED") {
      return {
        accepted: false,
        code: "INVALID_REQUEST",
        message: "encoder is closed",
      };
    }
    if (!this.intakeOpen || (this.state !== "READY" && this.state !== "ENCODING")) {
      return {
        accepted: false,
        code: "INVALID_REQUEST",
        message: "encoder is not accepting frames",
      };
    }
    if (this.failure !== null) {
      return {
        accepted: false,
        code: this.failure.code,
        message: this.failure.message,
      };
    }
    const candidate = frame as Omit<EncoderFrameInput, "bytes"> & {
      bytes: Uint8Array;
    };
    const verdict = validateEncoderFrame(
      candidate,
      { ...this.fence, take_id: this.takeId, lastFrameSeq: this.lastSeq },
      this.accepted,
    );
    if (!verdict.ok) {
      return { accepted: false, code: verdict.code, message: verdict.message };
    }
    // Submitted counts validation-passing frames only (accepted +
    // queue-dropped); schema/fence rejects are reported, never tallied.
    this.submitted += 1;
    this.accepted += 1;
    this.lastSeq = candidate.frame_seq;
    this.lastPts = verdict.pts_us;
    const isFiller = verdict.isFiller === true || candidate.filler === true;
    const isDup =
      !isFiller &&
      classifyPacing(candidate.content_digest_fnv1a64, this.lastDigest) ===
        "coalesce-duplicate";
    if (isDup) {
      this.coalesced += 1;
    }
    this.lastDigest = candidate.content_digest_fnv1a64;
    const packed = packTightRows(
      candidate.bytes,
      candidate.width,
      candidate.height,
      candidate.stride_bytes,
    );
    this.queue.push({
      buffer: packed,
      encodeSeq: this.accepted,
      ptsUs: verdict.pts_us,
      isFiller,
      isDup,
    });
    this.queuedBytes += packed.length;
    while (this.queue.length > ENCODER_QUEUE_CAP_FRAMES) {
      const droppedItem = this.queue.shift();
      if (droppedItem !== undefined) {
        this.queuedBytes -= droppedItem.buffer.length;
      }
      this.dropped += 1;
    }
    // Second bound (bytes, not just count): never retain beyond the frozen
    // 96 MiB ceiling even if a future frame geometry ever admitted padding.
    while (this.queue.length > 0 && this.queuedBytes > MAX_ENCODER_QUEUE_BYTES) {
      const droppedItem = this.queue.shift();
      if (droppedItem !== undefined) {
        this.queuedBytes -= droppedItem.buffer.length;
      }
      this.dropped += 1;
    }
    // Peaks describe retained pressure AFTER overflow discipline.
    if (this.queue.length > this.peakPending) {
      this.peakPending = this.queue.length;
    }
    if (this.queuedBytes > this.peakBytes) {
      this.peakBytes = this.queuedBytes;
    }
    if (this.state === "READY") {
      this.state = "ENCODING";
      this.disarmStartup();
    }
    const pumpRun = this.pumpTail.then(() => this.pumpNow());
    this.pumpTail = pumpRun.catch(() => undefined);
    await this.pumpTail;
    const pumpFailure = this.failure as {
      code: RecordingErrorCode;
      message: string;
    } | null;
    if (pumpFailure !== null) {
      return {
        accepted: false,
        code: pumpFailure.code,
        message: pumpFailure.message,
      };
    }
    return { accepted: true, encode_seq: this.accepted, pts_us: verdict.pts_us };
  }

  private async pumpNow(): Promise<void> {
    while (
      this.queue.length > 0 &&
      this.failure === null &&
      this.proc?.stdin !== null &&
      this.proc?.stdin !== undefined
    ) {
      // Dequeue first: Writable.write() buffers the chunk regardless of its
      // boolean return (false only means "wait for drain before more").
      // Retrying the same item after drain would duplicate bytes on the pipe.
      const item = this.queue.shift()!;
      this.queuedBytes -= item.buffer.length;
      this.piped += 1;
      if (item.isFiller) {
        this.pipedFiller += 1;
      } else if (item.isDup) {
        this.pipedDup += 1;
      }
      const stdin = this.proc.stdin;
      let wrote = false;
      try {
        wrote = stdin.write(item.buffer);
      } catch {
        this.fail("ENCODER_FAILED", "encoder stdin write threw");
        this.killOwned();
        throw new Error("[ENCODER_FAILED] stdin write threw");
      }
      if (!wrote) {
        await this.waitDrain();
      }
    }
  }

  private waitDrain(): Promise<void> {
    const stdin = this.proc?.stdin;
    if (stdin === null || stdin === undefined) {
      this.fail("ENCODER_FAILED", "encoder stdin vanished under backpressure");
      return Promise.reject(new Error("[ENCODER_FAILED] stdin vanished"));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.fail("ENCODER_TIMEOUT", "encoder stdin drain timed out");
        this.killOwned();
        reject(new Error("[ENCODER_TIMEOUT] stdin drain timed out"));
      }, this.timeouts.drainMs);
      const unref = (timer as unknown as { unref?: () => void }).unref;
      if (typeof unref === "function") {
        unref.call(timer);
      }
      const cleanup = (): void => {
        clearTimeout(timer);
        stdin.removeListener("drain", onDrain);
        stdin.removeListener("error", onError);
        stdin.removeListener("close", onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (...args: Array<unknown>): void => {
        void args;
        cleanup();
        this.fail("ENCODER_FAILED", "encoder stdin errored under backpressure");
        reject(new Error("[ENCODER_FAILED] stdin error"));
      };
      const onClose = (): void => {
        cleanup();
        this.fail("ENCODER_FAILED", "encoder stdin closed under backpressure");
        reject(new Error("[ENCODER_FAILED] stdin closed"));
      };
      stdin.once("drain", onDrain);
      stdin.once("error", onError);
      stdin.once("close", onClose);
    });
  }

  // -- finish ---------------------------------------------------------------

  async finish(): Promise<EncoderFinishResult> {
    if (this.state === "CLOSED") {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "encoder is closed",
        this.fenceWithTake(),
      );
    }
    if (this.state !== "READY" && this.state !== "ENCODING") {
      if (this.failure !== null) {
        throw new EncoderHostError(
          this.failure.code,
          this.failure.message,
          this.fenceWithTake(),
        );
      }
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "encoder finish requires an active session",
        this.fenceWithTake(),
      );
    }
    if (this.partialAbs === null || this.proc === null) {
      throw new EncoderHostError(
        "INVALID_REQUEST",
        "encoder finish requires a started session",
        this.fenceWithTake(),
      );
    }
    if (this.accepted === 0) {
      await this.terminateOwned();
      await this.removePartialBestEffort();
      this.state = "FAILED";
      throw new EncoderHostError(
        "MEDIA_VALIDATION_FAILED",
        "encoder accepted zero frames",
        this.fenceWithTake(),
        "VALIDATION",
      );
    }
    this.state = "FLUSHING";
    this.intakeOpen = false;
    this.disarmStartup();
    try {
      await boundedWait(this.pumpTail, this.timeouts.flushMs, () => {
        this.fail("ENCODER_TIMEOUT", "encoder flush timed out");
        this.killOwned();
        return new EncoderHostError(
          "ENCODER_TIMEOUT",
          "encoder flush timed out",
          this.fenceWithTake(),
        );
      });
    } catch (error) {
      if (error instanceof EncoderHostError) {
        throw error;
      }
      throw new EncoderHostError(
        "ENCODER_TIMEOUT",
        "encoder flush timed out",
        this.fenceWithTake(),
      );
    }
    if (this.failure !== null) {
      throw new EncoderHostError(
        this.failure.code,
        this.failure.message,
        this.fenceWithTake(),
      );
    }
    this.expectingExit = true;
    try {
      this.proc.stdin?.end();
    } catch {
      // End-of-stdin is best effort; exit observation below decides.
    }
    const exitCode = await this.waitExit();
    if (exitCode === null) {
      this.killOwned();
      await this.waitExit();
      this.state = "FAILED";
      throw new EncoderHostError(
        "ENCODER_TIMEOUT",
        "encoder process did not exit after flush",
        this.fenceWithTake(),
      );
    }
    this.exitCode = exitCode;
    if (exitCode !== 0) {
      this.state = "FAILED";
      throw new EncoderHostError(
        "ENCODER_FAILED",
        `encoder process exited with code ${exitCode}: ${this.stderrTail.slice(-512)}`,
        this.fenceWithTake(),
      );
    }
    let size = 0;
    try {
      size = (await fsp.stat(this.partialAbs)).size;
    } catch {
      size = 0;
    }
    if (size <= 0) {
      this.state = "FAILED";
      throw new EncoderHostError(
        "ENCODER_FAILED",
        "encoder produced no output",
        this.fenceWithTake(),
      );
    }
    this.state = "VALIDATING";
    const expectedDurationS = this.piped / 30;
    const ffprobeRun = await runBoundedTool(
      this.spawnFn,
      this.tools.ffprobe,
      [...buildFfprobeArgv(this.partialAbs)],
      this.timeouts.ffprobeMs,
      true,
    );
    if (ffprobeRun.exitCode !== 0) {
      this.state = "FAILED";
      throw new EncoderHostError(
        "MEDIA_VALIDATION_FAILED",
        "media probe invocation failed",
        this.fenceWithTake(),
        "VALIDATION",
      );
    }
    let doc: unknown = null;
    try {
      doc = JSON.parse(ffprobeRun.stdout) as unknown;
    } catch {
      doc = null;
    }
    if (doc === null || typeof doc !== "object") {
      this.state = "FAILED";
      throw new EncoderHostError(
        "MEDIA_VALIDATION_FAILED",
        "media probe output unreadable",
        this.fenceWithTake(),
        "VALIDATION",
      );
    }
    const outcome = verifyMediaJson(doc as Parameters<typeof verifyMediaJson>[0], {
      width: RECORDING_WIDTH,
      height: RECORDING_HEIGHT,
      fps: 30,
      expectedDurationS,
      sizeCeilingBytes: requiredFreeBytes(expectedDurationS),
      actualSizeBytes: size,
    });
    if (outcome.verdict !== "PASS") {
      this.state = "FAILED";
      const failed = outcome.checks
        .filter((c) => !c.passed)
        .map((c) => c.check)
        .join(",");
      throw new EncoderHostError(
        "MEDIA_VALIDATION_FAILED",
        `media checks failed: ${failed}`,
        this.fenceWithTake(),
        "VALIDATION",
      );
    }
    const partialAbs = this.partialAbs;
    let moovFirst = false;
    try {
      moovFirst = await verifyFaststartMoovFirst((offset, length) =>
        readFileRange(partialAbs, offset, length),
      );
    } catch {
      moovFirst = false;
    }
    if (!moovFirst) {
      this.state = "FAILED";
      throw new EncoderHostError(
        "MEDIA_VALIDATION_FAILED",
        "faststart placement check failed",
        this.fenceWithTake(),
        "VALIDATION",
      );
    }
    let digestHex = "";
    try {
      digestHex = (await sha256File(partialAbs)).hex;
    } catch {
      this.state = "FAILED";
      throw new EncoderHostError(
        "MEDIA_VALIDATION_FAILED",
        "media digest failed",
        this.fenceWithTake(),
        "VALIDATION",
      );
    }
    const mediaFrameCount = parseMediaFrameCount(doc as Parameters<typeof verifyMediaJson>[0]);
    this.validationVerdict = "PASS";
    this.mediaDigest = digestHex;
    this.mediaSize = size;
    this.state = "COMPLETED";
    return {
      stats: this.getStats(),
      media_digest: digestHex,
      media_size_bytes: size,
      validation_verdict: "PASS",
      media_frame_count: mediaFrameCount,
    };
  }

  private waitExit(): Promise<number | null> {
    if (this.proc === null) {
      return Promise.resolve(this.exitCode);
    }
    if (this.proc.exitCode !== null) {
      return Promise.resolve(this.proc.exitCode);
    }
    const proc = this.proc;
    const task = new Promise<number | null>((resolve) => {
      const onExit = (...args: Array<unknown>): void => {
        const code = args[0];
        resolve(typeof code === "number" ? code : null);
      };
      proc.once("exit", onExit);
      proc.once("error", () => resolve(null));
    });
    return boundedWait(task, this.timeouts.exitMs, () => {
      return new Error("[ENCODER_TIMEOUT] process exit timed out");
    }).catch(() => null);
  }

  private async terminateOwned(): Promise<boolean> {
    this.expectingExit = true;
    try {
      this.proc?.stdin?.destroy();
    } catch {
      // Owned pipe only.
    }
    this.killOwned();
    const code = await this.waitExit();
    if (code === null) {
      try {
        this.proc?.kill(9);
      } catch {
        // Owned handle only.
      }
      const second = await this.waitExit();
      return second !== null;
    }
    return true;
  }

  private async removePartialBestEffort(): Promise<boolean> {
    if (this.partialAbs === null) {
      return true;
    }
    try {
      await fsp.unlink(this.partialAbs);
      return true;
    } catch {
      try {
        await fsp.stat(this.partialAbs);
        return false;
      } catch {
        return true;
      }
    }
  }

  // -- abort / close / stats ---------------------------------------------------

  async abort(reason: string): Promise<{
    aborted: boolean;
    exitObserved: boolean;
    tempRemoved: boolean;
    stats: EncoderRunStats;
  }> {
    void sanitizeRecordingMessage(reason);
    if (this.state === "CLOSED") {
      return {
        aborted: true,
        exitObserved: this.exitCode !== null,
        tempRemoved: true,
        stats: this.getStats(),
      };
    }
    if (this.state === "COMPLETED") {
      return {
        aborted: false,
        exitObserved: true,
        tempRemoved: false,
        stats: this.getStats(),
      };
    }
    this.intakeOpen = false;
    this.disarmStartup();
    if (this.state !== "FAILED") {
      this.state = "ABORTING";
    }
    const exitObserved = await this.terminateOwned();
    let tempRemoved = true;
    if (this.partialAbs !== null) {
      try {
        await fsp.unlink(this.partialAbs);
        tempRemoved = true;
      } catch {
        try {
          const stat = await fsp.stat(this.partialAbs);
          void stat;
          tempRemoved = false;
        } catch {
          tempRemoved = true;
        }
      }
    }
    this.queue.length = 0;
    this.queuedBytes = 0;
    return { aborted: true, exitObserved, tempRemoved, stats: this.getStats() };
  }

  async close(): Promise<void> {
    if (this.state === "CLOSED") {
      return;
    }
    this.disarmStartup();
    this.intakeOpen = false;
    if (
      this.state === "READY" ||
      this.state === "ENCODING" ||
      this.state === "FLUSHING" ||
      this.state === "VALIDATING" ||
      this.state === "ABORTING" ||
      this.state === "FAILED"
    ) {
      await this.terminateOwned();
    }
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.proc = null;
    this.state = "CLOSED";
  }

  getStats(): EncoderRunStats {
    return {
      state:
        this.state === "CREATED"
          ? "CREATED"
          : this.state === "READY"
            ? "READY"
            : this.state === "ENCODING"
              ? "ENCODING"
              : this.state === "FLUSHING"
                ? "FLUSHING"
                : this.state === "VALIDATING"
                  ? "VALIDATING"
                  : this.state === "COMPLETED"
                    ? "COMPLETED"
                    : this.state === "FAILED"
                      ? "FAILED"
                      : this.state === "ABORTING"
                        ? "ABORTING"
                        : "CLOSED",
      family: this.descriptor?.family ?? null,
      profile: this.descriptor?.profile ?? null,
      fallback_used: this.descriptor?.fallback_used ?? false,
      submitted_frames: this.submitted,
      accepted_frames: this.accepted,
      dropped_frames: this.dropped,
      coalesced_frames: this.coalesced,
      piped_frames: this.piped,
      piped_filler_frames: this.pipedFiller,
      piped_dup_frames: this.pipedDup,
      pending_frames: this.queue.length,
      peak_pending_frames: this.peakPending,
      peak_pending_bytes: this.peakBytes,
      last_pts_us: this.lastPts,
      exit_code: this.exitCode,
      validation_verdict: this.validationVerdict,
      media_digest: this.mediaDigest,
      media_size_bytes: this.mediaSize,
      elapsed_ms: Math.max(0, Math.floor(this.nowMs() - this.birthMs)),
    };
  }
}
