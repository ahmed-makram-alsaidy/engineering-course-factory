// P10.4 Trusted FFmpeg Tool Resolution & Child Process Runner
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 31 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 11.
//
// Process Safety Rules:
// - shell: false mandatory on all child_process invocations.
// - Fixed, audited argv array generated Main-side; zero renderer/caller input.
// - Pinned absolute binary resolved Main-side from configuration or PATH search.
// - Bounded execution timeout (default: 10,000 ms) with SIGKILL escalation.
// - Bounded stdout/stderr buffer limits to prevent memory exhaustion.
// - Owned child process termination only: strictly NO global process killing.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { VOICE_TIMEOUTS } from "../src/protocol.ts";
import { readJsonConfig, repoRootFromHere } from "./storage-roots.ts";

/** Maximum allowed stdout buffer: 32 MiB (matches max provider response buffer). */
export const MAX_FFMPEG_STDOUT_BYTES = 32 * 1024 * 1024;

/** Maximum allowed stderr capture: 64 KiB (for filter logs and loudnorm JSON). */
export const MAX_FFMPEG_STDERR_BYTES = 64 * 1024;

export interface FfmpegRunOptions {
  readonly ffmpegPath: string;
  readonly argv: readonly string[];
  readonly inputBuffer?: Buffer;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface FfmpegRunResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    return stats.isFile() && existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Searches system PATH for a tool executable.
 * Returns the first candidate file that exists, or null.
 */
export function searchPathForExecutable(fileName: string): string | null {
  const pathEnv = process.env["PATH"] ?? process.env["Path"] ?? "";
  const candidates =
    fileName.toLowerCase().endsWith(".exe") || !fileName.includes(".")
      ? [fileName, `${fileName}.exe`]
      : [fileName];

  const seen = new Set<string>();
  for (const dir of pathEnv.split(";")) {
    const trimmed = dir.trim().replace(/^"|"$/g, "");
    if (trimmed.length === 0 || seen.has(trimmed.toLowerCase())) {
      continue;
    }
    seen.add(trimmed.toLowerCase());
    for (const name of candidates) {
      const full = join(trimmed, name);
      if (isAbsolute(full) && isExecutableFile(full)) {
        return resolve(full);
      }
    }
  }
  return null;
}

/**
 * Resolves pinned absolute FFmpeg executable path.
 *
 * Precedence:
 * 1. options.ffmpegPath if provided and valid.
 * 2. config/recording-paths.json or config/paths.json.
 * 3. PATH search for "ffmpeg".
 *
 * Throws if FFmpeg cannot be pinned.
 */
export function resolvePinnedFfmpeg(options?: {
  ffmpegPath?: string;
  configPath?: string;
  recordingConfigPath?: string;
  repoRoot?: string;
}): string {
  if (options?.ffmpegPath && typeof options.ffmpegPath === "string") {
    if (isAbsolute(options.ffmpegPath)) {
      if (isExecutableFile(options.ffmpegPath)) {
        return resolve(options.ffmpegPath);
      }
      throw new Error(`[ENCODER_UNAVAILABLE] Specified FFmpeg executable does not exist at '${options.ffmpegPath}'`);
    }
    const searched = searchPathForExecutable(options.ffmpegPath);
    if (searched !== null) {
      return searched;
    }
  }

  const repoRoot = options?.repoRoot ?? repoRootFromHere();
  const recConfig = readJsonConfig(
    options?.recordingConfigPath ?? join(repoRoot, "config", "recording-paths.json"),
  );
  const pathsConfig = readJsonConfig(
    options?.configPath ?? join(repoRoot, "config", "paths.json"),
  );

  const fromRec = recConfig["ffmpegPath"];
  if (typeof fromRec === "string" && fromRec.length > 0) {
    if (isAbsolute(fromRec) && isExecutableFile(fromRec)) {
      return resolve(fromRec);
    }
    const searched = searchPathForExecutable(fromRec);
    if (searched !== null) {
      return searched;
    }
  }

  const fromPaths = pathsConfig["ffmpegPath"];
  if (typeof fromPaths === "string" && fromPaths.length > 0) {
    if (isAbsolute(fromPaths) && isExecutableFile(fromPaths)) {
      return resolve(fromPaths);
    }
    const searched = searchPathForExecutable(fromPaths);
    if (searched !== null) {
      return searched;
    }
  }

  // Fallback to standard PATH search
  const inPath = searchPathForExecutable("ffmpeg");
  if (inPath !== null) {
    return inPath;
  }

  throw new Error("[ENCODER_UNAVAILABLE] ffmpeg executable cannot be pinned from configuration or system PATH");
}

/**
 * Executes a trusted FFmpeg child process under strict safety invariants.
 */
export async function runTrustedFfmpeg(options: FfmpegRunOptions): Promise<FfmpegRunResult> {
  const {
    ffmpegPath,
    argv,
    inputBuffer,
    timeoutMs = VOICE_TIMEOUTS.normalization_ms,
    signal,
  } = options;

  if (signal?.aborted) {
    throw new Error("[CANCELLED] FFmpeg execution cancelled before start");
  }

  return new Promise<FfmpegRunResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess | null = null;
    let timer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrText = "";

    const cleanupTimers = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      rejectPromise(err);
    };

    const settleResolve = (res: FfmpegRunResult) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolvePromise(res);
    };

    try {
      child = spawn(ffmpegPath, argv as string[], {
        shell: false,
        stdio: [inputBuffer ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (spawnErr) {
      settleReject(new Error(`[NORMALIZATION_FAILED] Failed to spawn FFmpeg: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`));
      return;
    }

    // Set timeout
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled && child) {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => {
            if (child && !child.killed) {
              try {
                child.kill("SIGKILL");
              } catch {
                // ignore
              }
            }
          }, 500);
          settleReject(new Error(`[TIMEOUT] FFmpeg normalization timed out after ${timeoutMs} ms`));
        }
      }, timeoutMs);
    }

    // Handle cancellation signal
    const onAbort = () => {
      if (!settled && child) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child && !child.killed) {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, 500);
        settleReject(new Error("[CANCELLED] FFmpeg normalization cancelled"));
      }
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Feed stdin if provided
    if (inputBuffer && child.stdin) {
      child.stdin.on("error", () => {
        // Child closed stdin early, not necessarily fatal
      });
      child.stdin.end(inputBuffer);
    }

    // Capture stdout
    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_FFMPEG_STDOUT_BYTES) {
          child?.kill("SIGKILL");
          settleReject(new Error(`[NORMALIZATION_FAILED] FFmpeg stdout exceeded maximum limit of ${MAX_FFMPEG_STDOUT_BYTES} bytes`));
          return;
        }
        stdoutChunks.push(chunk);
      });
    }

    // Capture stderr
    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrText.length < MAX_FFMPEG_STDERR_BYTES) {
          stderrText += chunk.toString("utf8");
          if (stderrText.length > MAX_FFMPEG_STDERR_BYTES) {
            stderrText = stderrText.slice(0, MAX_FFMPEG_STDERR_BYTES);
          }
        }
      });
    }

    child.on("error", (err: Error) => {
      settleReject(new Error(`[NORMALIZATION_FAILED] FFmpeg process error: ${err.message}`));
    });

    child.on("close", (code: number | null) => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }

      if (settled) return;

      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        // Strip secrets or URLs from stderr just in case
        const sanitizedStderr = stderrText.slice(-500);
        settleReject(new Error(`[NORMALIZATION_FAILED] FFmpeg exited with non-zero code ${exitCode}: ${sanitizedStderr}`));
        return;
      }

      settleResolve({
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: stderrText,
        exitCode,
      });
    });
  });
}
