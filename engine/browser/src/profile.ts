// Ephemeral Browser Profile Management for Course Factory P7.3.
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 13.
//
// Establishes isolated incognito storage for each lesson session generation:
// - Profiles live strictly under project temp directory:
//     temp/browser-profiles/<session_id>-<generation>/
// - Never touches operator's real Chrome/Edge profiles or %LOCALAPPDATA%.
// - Purged completely on session close, reset, crash, or application shutdown.
// - Bounded retries handle Windows file-unlock latencies after process termination.
// - Failure to purge profile fails closed.

import { existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

export const DEFAULT_PROFILES_BASE_DIR = join(findRepoRoot(), "temp", "browser-profiles");

/**
 * Returns the canonical absolute path for a session generation's ephemeral profile.
 */
export function getCanonicalProfileDir(
  sessionId: string,
  generation: number,
  baseDir = DEFAULT_PROFILES_BASE_DIR,
): string {
  // Sanitize session identifier to ensure no directory traversal
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(baseDir, `${safeSession}-${generation}`);
}

/**
 * Creates a clean ephemeral profile directory.
 */
export function createEphemeralProfile(
  sessionId: string,
  generation: number,
  baseDir = DEFAULT_PROFILES_BASE_DIR,
): string {
  const profileDir = getCanonicalProfileDir(sessionId, generation, baseDir);
  if (existsSync(profileDir)) {
    // If a residue exists from an aborted run, wipe it first
    rmSync(profileDir, { recursive: true, force: true });
  }
  mkdirSync(profileDir, { recursive: true });
  return profileDir;
}

/**
 * Purges an ephemeral profile directory with bounded retries.
 * On Windows, processes terminated abruptly may hold kernel file locks for 50-200ms.
 * Returns true on confirmed absence, false if removal failed.
 */
export async function purgeEphemeralProfile(profileDir: string, maxAttempts = 15, delayMs = 100): Promise<boolean> {
  if (!existsSync(profileDir)) {
    return true;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
      if (!existsSync(profileDir)) {
        return true;
      }
    } catch {
      // transient lock; retry
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }

  return !existsSync(profileDir);
}

/**
 * Purges all ephemeral profiles matching a specific session ID across all generations.
 */
export async function purgeAllSessionProfiles(sessionId: string, baseDir = DEFAULT_PROFILES_BASE_DIR): Promise<void> {
  if (!existsSync(baseDir)) {
    return;
  }

  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const prefix = `${safeSession}-`;

  const entries = readdirSync(baseDir);
  for (const entry of entries) {
    if (entry.startsWith(prefix) || entry === safeSession) {
      await purgeEphemeralProfile(join(baseDir, entry));
    }
  }
}
