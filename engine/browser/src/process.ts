// Browser Process Launcher, Version Lock & Process Ledger for Course Factory P7.3.
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 4, 19, 25.
//
// Governs out-of-process Chromium execution:
// - Pinned Playwright Core 1.50.1 with Chromium build 1155 (133.0.6943.16).
// - Binary storage located strictly on E:\course-factory\bin\browsers.
// - Out-of-process launch with stdio pipe transport (--remote-debugging-pipe).
// - Zero DevTools TCP port exposure (no 9222, no remote-debugging-port).
// - Preserves Chromium sandbox (chromiumSandbox: true, zero --no-sandbox).
// - Discovers session-owned root Chromium PID and binds to Windows Job Object.
// - Zero indiscriminate process killing (never taskkill /IM chrome.exe).

import { existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WindowsJobObject, type ProcessLedgerEntry } from "./job-object.ts";
import { PAGE_CLOSE_TIMEOUT_MS, type BrowserErrorCode } from "./protocol.ts";

const here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

export const PINNED_PLAYWRIGHT_VERSION = "1.50.1";
export const PINNED_CHROMIUM_REVISION = "1155";
export const PINNED_CHROMIUM_VERSION = "133.0.6943.16";

function resolveDefaultBrowsersPath(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const candidate = join(repoRoot, "bin", "browsers");
  if (existsSync(candidate)) return candidate;
  let curr = here;
  for (let i = 0; i < 6; i++) {
    const check = join(curr, "bin", "browsers");
    if (existsSync(check)) return check;
    curr = dirname(curr);
  }
  return candidate;
}

export const DEFAULT_BROWSERS_PATH = resolveDefaultBrowsersPath();
export const PINNED_CHROMIUM_EXE_PATH = join(
  DEFAULT_BROWSERS_PATH,
  `chromium-${PINNED_CHROMIUM_REVISION}`,
  "chrome-win",
  "chrome.exe",
);

/**
 * Reviewed frozen launch arguments for Chromium.
 */
export const FROZEN_CHROMIUM_ARGS = [
  "--js-flags=--max-old-space-size=512",
  "--disable-extensions",
  "--disable-dev-tools",
] as const;

/**
 * Forbidden Chromium flags that must never appear in launch parameters.
 */
export const FORBIDDEN_CHROMIUM_FLAGS = [
  "--no-sandbox",
  "--remote-debugging-port",
  "--disable-web-security",
  "--allow-file-access-from-files",
  "--disable-features=IsolateOrigins",
  "--site-per-process=0",
] as const;

export interface BinaryVerificationResult {
  readonly ok: boolean;
  readonly executablePath?: string;
  readonly code?: BrowserErrorCode;
  readonly reason?: string;
}

/**
 * Verifies that the exact pinned Chromium binary is provisioned on disk.
 * Fails closed immediately if missing. Never falls back to developer Chrome or Edge.
 */
export function verifyPinnedBrowserBinary(customExePath?: string): BinaryVerificationResult {
  const browsersDir = (process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH))
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : resolveDefaultBrowsersPath();
  const exePath = customExePath ?? (existsSync(PINNED_CHROMIUM_EXE_PATH)
    ? PINNED_CHROMIUM_EXE_PATH
    : join(browsersDir, `chromium-${PINNED_CHROMIUM_REVISION}`, "chrome-win", "chrome.exe"));

  if (!existsSync(exePath)) {
    return {
      ok: false,
      code: "BROWSER_LAUNCH_FAILED",
      reason: `[BROWSER_BINARY_MISSING] Pinned Chromium binary not found at '${exePath}'. Run 'npm run provision:browser' before starting lesson runtime.`,
    };
  }

  return { ok: true, executablePath: exePath };
}

/**
 * Validates an array of launch arguments to guarantee no forbidden flags are present.
 */
export function validateChromiumArgs(args: readonly string[]): { ok: true } | { ok: false; violation: string } {
  for (const arg of args) {
    for (const forbidden of FORBIDDEN_CHROMIUM_FLAGS) {
      if (arg === forbidden || arg.startsWith(`${forbidden}=`)) {
        return { ok: false, violation: `Forbidden Chromium argument detected: '${arg}'` };
      }
    }
  }
  return { ok: true };
}

/**
 * Discovers the session-owned root Chromium PID spawned by this Node process.
 * Matches parent PID to process.pid and verifies the command line contains the unique session profile path.
 */
export function discoverRootChromiumPid(profilePath: string): number | null {
  if (process.platform !== "win32") {
    return null;
  }

  try {
    const dirName = profilePath.split(/[\\/]/).pop();
    if (!dirName) return null;
    const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} and (Name = 'chrome.exe' or Name = 'chromium.exe')" | Where-Object { $_.CommandLine -like "*${dirName}*" } | Select-Object -ExpandProperty ProcessId`;
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 10000,
    }).trim();

    if (!out) return null;
    const pid = parseInt(out.split(/\r?\n/)[0]?.trim() ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Session-owned process manager that links Playwright to Windows Job Objects.
 */
export class ManagedBrowserProcess {
  readonly sessionId: string;
  readonly generation: number;
  readonly profilePath: string;
  private jobObject: WindowsJobObject;
  private rootPid: number | null = null;
  private trackedPids: number[] = [];

  constructor(sessionId: string, generation: number, profilePath: string) {
    this.sessionId = sessionId;
    this.generation = generation;
    this.profilePath = profilePath;
    this.jobObject = new WindowsJobObject(sessionId, generation);
  }

  async initJob(): Promise<void> {
    await this.jobObject.init();
  }

  async attachProcess(pid?: number | null): Promise<void> {
    const discoveredPid = pid ?? discoverRootChromiumPid(this.profilePath);
    if (discoveredPid) {
      this.rootPid = discoveredPid;
      this.trackedPids.push(discoveredPid);
      await this.jobObject.assignProcess(discoveredPid);
      const allPids = await this.jobObject.queryPids();
      this.trackedPids = [...new Set([...this.trackedPids, ...allPids])];
    }
  }

  getRootPid(): number | null {
    return this.rootPid;
  }

  isAlive(): boolean {
    if (!this.rootPid) return true;
    try {
      process.kill(this.rootPid, 0);
      return true;
    } catch {
      return false;
    }
  }

  getTrackedPids(): readonly number[] {
    return this.trackedPids;
  }

  getLedger(): ProcessLedgerEntry {
    return this.jobObject.getLedgerEntry();
  }

  /**
   * Bounded termination of this session's process tree:
   * 1. If processes are still alive, terminates the Job Object.
   * 2. Polls up to PAGE_CLOSE_TIMEOUT_MS to confirm absence.
   * 3. Closes the Job Object handle.
   */
  async terminateAndConfirm(timeoutMs = PAGE_CLOSE_TIMEOUT_MS): Promise<boolean> {
    // Refresh tracked PIDs from Job Object
    try {
      const activePids = await this.jobObject.queryPids();
      this.trackedPids = [...new Set([...this.trackedPids, ...activePids])];
    } catch {}

    // Hard terminate Job Object to ensure any stuck process dies
    try {
      await this.jobObject.terminateJob();
    } catch {}

    // Verify all owned PIDs are dead
    const dead = await WindowsJobObject.verifyAbsence(this.trackedPids, timeoutMs);

    // Close Job handle
    try {
      await this.jobObject.close();
    } catch {}

    return dead;
  }
}
