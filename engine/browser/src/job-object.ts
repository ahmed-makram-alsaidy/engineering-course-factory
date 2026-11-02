// Windows Job Object Management & Process Safety for Course Factory P7.3.
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 19.
//
// Establishes trusted OS child process tracking via Windows Job Objects configured
// with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000).
//
// Core guarantees:
// - All Chromium processes belonging to a BrowserSession are placed inside one owned Job Object.
// - On supervisor exit, parent crash, or job handle closure, Windows kernel automatically
//   terminates all owned Chromium processes.
// - Process ledger tracks only session-owned PIDs.
// - Indiscriminate process termination (taskkill /IM chrome.exe) is STRICTLY FORBIDDEN.
// - Unrelated operator browser processes remain untouched.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_CLOSE_TIMEOUT_MS } from "./protocol.ts";

const here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

function findRepoRoot(): string {
  let curr = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(curr, "engine")) && existsSync(join(curr, "packages"))) {
      return curr;
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return resolve(process.cwd());
}

const calculatedRepoRoot = findRepoRoot();

function findJobHostSource(): string {
  const candidates = [
    join(here, "job-host.cs"),
    join(calculatedRepoRoot, "engine", "browser", "src", "job-host.cs"),
    resolve(process.cwd(), "engine", "browser", "src", "job-host.cs"),
  ];
  return candidates.find((c) => existsSync(c)) ?? join(calculatedRepoRoot, "engine", "browser", "src", "job-host.cs");
}

function findJobHostExe(): string {
  const candidates = [
    join(packageRoot, "bin", "job-host.exe"),
    join(calculatedRepoRoot, "engine", "browser", "bin", "job-host.exe"),
    resolve(process.cwd(), "engine", "browser", "bin", "job-host.exe"),
  ];
  return candidates.find((c) => existsSync(c)) ?? join(calculatedRepoRoot, "engine", "browser", "bin", "job-host.exe");
}

const CSC_PATH = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const JOB_HOST_SOURCE = findJobHostSource();
const JOB_HOST_EXE = findJobHostExe();
const JOB_HOST_DIR = dirname(JOB_HOST_EXE);

/**
 * Ensures the Windows JobHost executable is compiled and ready.
 * Idempotent: compiles via csc.exe only if missing or out-of-date.
 */
export function ensureJobHostExecutable(): string {
  if (process.platform !== "win32") {
    return "";
  }

  if (existsSync(JOB_HOST_EXE)) {
    return JOB_HOST_EXE;
  }

  if (!existsSync(JOB_HOST_DIR)) {
    mkdirSync(JOB_HOST_DIR, { recursive: true });
  }

  if (!existsSync(CSC_PATH)) {
    throw new Error(`[JOB_OBJECT_INIT_FAILED] Microsoft C# compiler not found at ${CSC_PATH}`);
  }

  const result = spawnSync(CSC_PATH, [
    "/nologo",
    "/target:exe",
    `/out:${JOB_HOST_EXE}`,
    JOB_HOST_SOURCE,
  ], { encoding: "utf8" });

  if (result.status !== 0 || !existsSync(JOB_HOST_EXE)) {
    throw new Error(
      `[JOB_OBJECT_INIT_FAILED] Failed to compile Windows JobHost helper: ${result.stderr || result.stdout}`,
    );
  }

  return JOB_HOST_EXE;
}

export interface ProcessLedgerEntry {
  readonly session_id: string;
  readonly generation: number;
  readonly root_pid: number;
  readonly job_name: string;
  readonly state: "CREATED" | "RUNNING" | "TERMINATING" | "TERMINATED";
  readonly created_at_ms: number;
}

export class WindowsJobObject {
  private supervisor: ChildProcess | null = null;
  private stdoutBuffer = "";
  private isClosed = false;
  readonly jobName: string;
  private rootPid: number | null = null;
  private sessionId: string;
  private generation: number;
  private state: "CREATED" | "RUNNING" | "TERMINATING" | "TERMINATED" = "CREATED";
  private createdAt: number;

  constructor(sessionId: string, generation: number, jobNamePrefix = "cf-browser") {
    this.sessionId = sessionId;
    this.generation = generation;
    this.createdAt = Date.now();
    this.jobName = `${jobNamePrefix}-${sessionId}-${generation}`;
  }

  getLedgerEntry(): ProcessLedgerEntry {
    return {
      session_id: this.sessionId,
      generation: this.generation,
      root_pid: this.rootPid ?? 0,
      job_name: this.jobName,
      state: this.state,
      created_at_ms: this.createdAt,
    };
  }

  /**
   * Initializes the Job Object supervisor process and creates the Windows Job.
   */
  async init(): Promise<void> {
    if (process.platform !== "win32") {
      this.state = "RUNNING";
      return;
    }

    const exePath = ensureJobHostExecutable();
    this.supervisor = spawn(exePath, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.supervisor.unref();

    this.supervisor.stdout?.setEncoding("utf8");
    this.supervisor.stdout?.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
    });

    this.supervisor.on("error", (err) => {
      // Supervisor error
      this.isClosed = true;
      this.state = "TERMINATED";
    });

    this.supervisor.on("exit", () => {
      this.isClosed = true;
      this.state = "TERMINATED";
    });

    const response = await this.sendCommand(`CREATE ${this.jobName}`);
    if (!response.startsWith("OK")) {
      throw new Error(`[JOB_OBJECT_CREATE_FAILED] Failed to create Job Object: ${response}`);
    }

    this.state = "RUNNING";
  }

  /**
   * Assigns a Chromium process PID to this Job Object.
   */
  async assignProcess(pid: number): Promise<void> {
    this.rootPid = pid;
    if (process.platform !== "win32" || !this.supervisor || this.isClosed) {
      return;
    }

    const response = await this.sendCommand(`ASSIGN ${pid}`);
    if (!response.startsWith("OK")) {
      throw new Error(`[JOB_OBJECT_ASSIGN_FAILED] Failed to assign PID ${pid} to Job Object: ${response}`);
    }
  }

  /**
   * Queries all PIDs currently assigned to this Job Object by the Windows kernel.
   */
  async queryPids(): Promise<number[]> {
    if (process.platform !== "win32" || !this.supervisor || this.isClosed) {
      return this.rootPid ? [this.rootPid] : [];
    }

    const response = await this.sendCommand("QUERY_PIDS");
    if (!response.startsWith("OK")) {
      return this.rootPid ? [this.rootPid] : [];
    }

    const payload = response.replace(/^OK\s*/, "").trim();
    if (payload.length === 0) {
      return [];
    }

    return payload
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  /**
   * Explicitly terminates all processes inside this Job Object.
   */
  async terminateJob(): Promise<void> {
    this.state = "TERMINATING";
    if (process.platform !== "win32" || !this.supervisor || this.isClosed) {
      if (this.rootPid) {
        try {
          process.kill(this.rootPid, "SIGKILL");
        } catch {}
      }
      this.state = "TERMINATED";
      return;
    }

    try {
      await this.sendCommand("TERMINATE");
    } catch {}
    this.state = "TERMINATED";
  }

  /**
   * Closes the Job Object handle and terminates the supervisor helper.
   */
  async close(): Promise<void> {
    if (this.isClosed) return;
    this.state = "TERMINATING";

    if (this.supervisor && !this.supervisor.killed) {
      try {
        await this.sendCommand("CLOSE", 500);
      } catch {}
      try {
        this.supervisor.stdin?.end();
      } catch {}
      this.supervisor.kill();
      this.supervisor = null;
    }

    this.isClosed = true;
    this.state = "TERMINATED";
  }

  /**
   * Bounded verification barrier checking that specific tracked PIDs are no longer running.
   * Never scans by image name (no taskkill /IM chrome.exe).
   */
  static async verifyAbsence(pids: number[], timeoutMs = PAGE_CLOSE_TIMEOUT_MS): Promise<boolean> {
    const start = Date.now();
    const uniquePids = [...new Set(pids)].filter((p) => p > 0);

    while (Date.now() - start < timeoutMs) {
      const surviving = uniquePids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true; // Still exists
        } catch {
          return false; // Absent
        }
      });

      if (surviving.length === 0) {
        return true;
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    return false;
  }

  private sendCommand(cmd: string, timeoutMs = 3000): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (!this.supervisor || this.supervisor.killed || !this.supervisor.stdin) {
        rejectPromise(new Error("Supervisor process is not available"));
        return;
      }

      const prevLen = this.stdoutBuffer.length;
      let timer: NodeJS.Timeout;

      const checkInterval = setInterval(() => {
        const fresh = this.stdoutBuffer.slice(prevLen);
        const newlineIdx = fresh.indexOf("\n");
        if (newlineIdx !== -1) {
          clearInterval(checkInterval);
          clearTimeout(timer);
          resolvePromise(fresh.slice(0, newlineIdx).trim());
        }
      }, 10);

      timer = setTimeout(() => {
        clearInterval(checkInterval);
        rejectPromise(new Error(`Timed out waiting for response to '${cmd}'`));
      }, timeoutMs);

      try {
        this.supervisor.stdin.write(cmd + "\n");
      } catch (err) {
        clearInterval(checkInterval);
        clearTimeout(timer);
        rejectPromise(err);
      }
    });
  }
}
