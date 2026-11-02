// P5.4 Docker CLI transport — the ONLY product module allowed to import
// `node:child_process` (docs/P5-DESIGN-SPEC.md, "Transport"; task P5.4).
//
// Boundaries:
//   - spawns the configured Docker executable DIRECTLY with argv arrays
//     (shell:false, windowsHide, no cmd/PowerShell/batch, no exec() strings,
//     no concatenated command lines). Authored command strings never reach a
//     host shell: they travel as a single argv element and are interpreted
//     only by the guest shell inside the sandbox container.
//   - every invocation prepends `--config <privateRuntimeConfigDir>` before
//     `--context <fixedLocalLinuxContext>` (canonical global prefix).
//   - host environment is NOT inherited wholesale; only a minimal explicit
//     client environment is constructed (executable directory as PATH and
//     SystemRoot on Windows for process bootstrap).
//   - bounded stdout/stderr capture, bounded command timeout, cancellation,
//     structured diagnostics. Never a renderer-facing runDocker() API — this
//     module is trusted runtime-side only and not part of the public index.
//
// The transport builds no Docker semantics itself: argv is supplied by the
// provider (docker.ts) from trusted policy and the resolved execution
// context.

import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";

export interface DockerCliConfig {
  /** Absolute path of the Docker executable (machine config, never renderer/cwd). */
  readonly dockerExe: string;
  /** Fixed local Linux CLI context (e.g. "desktop-linux"). */
  readonly context: string;
  /** Private minimal host-side Docker config directory (--config). */
  readonly configDir: string;
  /** Optional trusted machine-config additions to the minimal client env (never secrets). */
  readonly clientEnv?: Readonly<Record<string, string>>;
}

export interface DockerInvocationResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /** Node-level spawn failure (executable missing/not runnable). */
  readonly spawnError: Error | null;
}

export interface DockerInvokeOptions {
  readonly argv: readonly string[];
  readonly timeoutMs?: number;
  /** Per-stream capture ceiling; larger output is truncated (never unbounded). */
  readonly maxStreamBytes?: number;
  readonly signal?: AbortSignal;
}

export interface DockerSpawnHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: number | undefined;
  kill(): void;
  readonly exit: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
}

const DEFAULT_MAX_STREAM_BYTES = 1_048_576;

/** Minimal explicit client environment (never process.env wholesale). */
function buildClientEnv(config: DockerCliConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(config.dockerExe),
  };
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
  }
  if (config.clientEnv !== undefined) {
    for (const [name, value] of Object.entries(config.clientEnv)) env[name] = value;
  }
  return env;
}
interface BoundedCollector {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
  push(chunk: Buffer): void;
  result(): Buffer;
}

/** Capture a stream's bytes while honoring a per-stream ceiling (never unbounded). */
function makeBoundedCollector(maxBytes: number): BoundedCollector {
  const collector: BoundedCollector = {
    chunks: [],
    bytes: 0,
    truncated: false,
    push(chunk: Buffer) {
      if (collector.bytes >= maxBytes) {
        collector.truncated = true;
        return;
      }
      const space = maxBytes - collector.bytes;
      const slice = space >= chunk.length ? chunk : chunk.subarray(0, space);
      collector.chunks.push(Buffer.from(slice));
      collector.bytes += slice.length;
      if (slice.length < chunk.length) collector.truncated = true;
    },
    result() {
      return Buffer.concat(collector.chunks, collector.bytes);
    },
  };
  return collector;
}

export class DockerCli {
  private readonly configValue: Readonly<DockerCliConfig>;

  constructor(config: DockerCliConfig) {
    this.configValue = Object.freeze({ ...config });
  }

  get config(): Readonly<DockerCliConfig> {
    return this.configValue;
  }

  /** Canonical global prefix prepended to every command argv. */
  private globalArgs(): readonly string[] {
    return ["--config", this.configValue.configDir, "--context", this.configValue.context];
  }

  /** Spawn the executable directly (no shell) with the complete argv. */
  private spawnRaw(argv: readonly string[]): ChildProcess {
    return spawn(this.configValue.dockerExe, argv, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildClientEnv(this.configValue),
    });
  }

  /**
   * Run one CLI command to completion (bounded). Never rejects for command
   * exit codes; exit/signal/spawn-failure are returned in the result. The
   * wall-clock deadline and abort signal kill the CLI process directly —
   * never via a host shell. Used for create/inspect/stop/rm and the bounded
   * foreground exec probe.
   */
  invoke(options: DockerInvokeOptions): Promise<DockerInvocationResult> {
    const maxBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
    const argv = [...this.globalArgs(), ...options.argv];
    const startedAt = Date.now();
    const child = this.spawnRaw(argv);
    const stdout = makeBoundedCollector(maxBytes);
    const stderr = makeBoundedCollector(maxBytes);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let timedOut = false;
    let cancelled = false;
    let spawnError: Error | null = null;

    return new Promise<DockerInvocationResult>((resolvePromise) => {
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        const signal = options.signal;
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        resolvePromise({
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout: stdout.result(),
          stderr: stderr.result(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs: Date.now() - startedAt,
          timedOut,
          cancelled,
          spawnError,
        });
      };
      const onAbort = () => {
        cancelled = true;
        child.kill();
        setTimeout(settle, 60);
      };
      const onTimeout = () => {
        timedOut = true;
        child.kill();
        setTimeout(settle, 60);
      };
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(onTimeout, options.timeoutMs);
      }
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort);
        }
      }
      child.on("error", (error) => {
        spawnError = error;
      });
      child.on("close", () => settle());
    });
  }

  /**
   * Start a long-lived CLI process (e.g. the attach connection) and return a
   * handle. Callers drive streams and must kill the handle on teardown.
   */
  spawnStream(argv: readonly string[]): DockerSpawnHandle {
    const child = this.spawnRaw([...this.globalArgs(), ...argv]);
    const exit = new Promise<{ readonly exitCode: number | null; readonly signal: string | null }>((resolvePromise) => {
      child.on("close", (exitCode, signal) => resolvePromise({ exitCode, signal }));
    });
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      pid: child.pid,
      kill: () => child.kill(),
      exit,
    };
  }
}