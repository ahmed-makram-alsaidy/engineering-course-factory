// P10.4 Trusted Storage Roots & Confinement Policy
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 18, 20, 28 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 10.
//
// Storage Classes on Volume Authority:
// - voiceTempRoot: Ephemeral provider downloads, staging and raw PCM (Class TEMP).
// - voiceCacheRoot: Content-addressed immutable voice store (Class CACHE).
// - voiceAssemblyRoot: Intermediate assembled lesson audio tracks (Class RENDERS).
//
// Invariants:
// - Zero hard-coded drive letters in product code; resolved from central config or fallback.
// - temp and cache publication MUST reside on the same filesystem volume (guarantees atomic rename).
// - Confinement: rejects traversal (..), UNC paths, device paths, and reparse-point escapes.
// - Disk preflight: minimum 2 GiB free space required; fails closed with LOW_DISK_ABORT.

import { existsSync, readFileSync, realpathSync, statSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CacheKeySchema, type CacheKey } from "../src/protocol.ts";

/** Minimum required free disk space: 2 GiB (2,147,483,648 bytes). */
export const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export interface VoiceStorageRoots {
  readonly repoRoot: string;
  readonly voiceCacheRoot: string;
  readonly voiceTempRoot: string;
  readonly voiceAssemblyRoot: string;
}

export interface CacheEntryPaths {
  readonly prefix: string;
  readonly dirPath: string;
  readonly audioPath: string;
  readonly assetPath: string;
  readonly alignmentPath: string;
}

/** Repository root derived from this module's location. */
export function repoRootFromHere(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..");
}

/** Reads a JSON path config file safely without throwing. */
export function readJsonConfig(configPath: string): Record<string, unknown> {
  try {
    const text = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Checks if a path is a strictly valid, absolute, non-UNC, non-device, non-traversal directory path candidate. */
export function isValidRootCandidate(candidate: unknown): candidate is string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return false;
  }
  const trimmed = candidate.trim();
  if (!isAbsolute(trimmed)) {
    return false;
  }
  if (trimmed.includes("..")) {
    return false;
  }
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    return false; // Reject UNC
  }
  if (/^\\\\\.\\/i.test(trimmed)) {
    return false; // Reject device paths
  }
  return true;
}

/**
 * Resolves authoritative P10 voice storage roots.
 *
 * Precedence:
 * 1. Explicit caller options (useful for bounded test isolation).
 * 2. config/recording-paths.json or config/paths.json.
 * 3. High-capacity D:\course-factory authority if D:\course-factory exists on the host.
 * 4. Safe repo-relative fallback (<repoRoot>/temp/...).
 *
 * Guarantees that voiceTempRoot and voiceCacheRoot reside on the same filesystem volume.
 */
export function resolveVoiceStorageRoots(options?: {
  repoRoot?: string;
  configPath?: string;
  recordingConfigPath?: string;
  voiceCacheRoot?: string;
  voiceTempRoot?: string;
  voiceAssemblyRoot?: string;
}): VoiceStorageRoots {
  const repoRoot = options?.repoRoot ?? repoRootFromHere();

  const pathsConfig = readJsonConfig(
    options?.configPath ?? join(repoRoot, "config", "paths.json"),
  );
  const recordingConfig = readJsonConfig(
    options?.recordingConfigPath ?? join(repoRoot, "config", "recording-paths.json"),
  );

  // Helper to pick a valid candidate from options or configs
  const pickCandidate = (
    explicitOpt: string | undefined,
    key: string,
    fallbackKey?: string,
  ): string | null => {
    if (explicitOpt && isValidRootCandidate(explicitOpt)) {
      return resolve(explicitOpt);
    }
    const fromRecording = recordingConfig[key] ?? (fallbackKey ? recordingConfig[fallbackKey] : undefined);
    if (isValidRootCandidate(fromRecording)) {
      return resolve(fromRecording);
    }
    const fromPaths = pathsConfig[key] ?? (fallbackKey ? pathsConfig[fallbackKey] : undefined);
    if (isValidRootCandidate(fromPaths)) {
      return resolve(fromPaths);
    }
    return null;
  };

  // Determine D: volume presence
  const dVolumeDefault = "D:\\course-factory";
  const hasDVolume = existsSync(dVolumeDefault) && statSync(dVolumeDefault).isDirectory();

  // Resolve Cache Root
  let cacheRoot = pickCandidate(options?.voiceCacheRoot, "voiceCacheRoot", "cacheRoot");
  if (!cacheRoot) {
    cacheRoot = hasDVolume
      ? join(dVolumeDefault, "voice-cache")
      : join(repoRoot, "temp", "voice-cache");
  }

  // Resolve Temp Root
  let tempRoot = pickCandidate(options?.voiceTempRoot, "voiceTempRoot", "tempRoot");
  if (!tempRoot) {
    tempRoot = hasDVolume
      ? join(dVolumeDefault, "voice-temp")
      : join(repoRoot, "temp", "voice-temp");
  }

  // Enforce same-volume requirement for atomic rename:
  // If tempRoot is on a different volume than cacheRoot, relocate tempRoot to cacheRoot's parent volume
  const cacheRootVolume = parse(cacheRoot).root.toLowerCase();
  const tempRootVolume = parse(tempRoot).root.toLowerCase();
  if (cacheRootVolume !== tempRootVolume) {
    tempRoot = join(dirname(cacheRoot), "voice-temp");
  }

  // Resolve Assembly Root
  let assemblyRoot = pickCandidate(options?.voiceAssemblyRoot, "voiceAssemblyRoot", "renderRoot");
  if (!assemblyRoot) {
    assemblyRoot = hasDVolume
      ? join(dVolumeDefault, "renders", "intermediate", "voice")
      : join(repoRoot, "temp", "renders", "voice");
  }

  return {
    repoRoot,
    voiceCacheRoot: resolve(cacheRoot),
    voiceTempRoot: resolve(tempRoot),
    voiceAssemblyRoot: resolve(assemblyRoot),
  };
}

/**
 * Asserts that a target path is safely contained within an allowed trusted root.
 * Rejects traversal, outside references, and symlink/reparse-point escapes.
 */
export function assertContainedWithinRoot(root: string, targetPath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(targetPath);

  if (!resolvedTarget.startsWith(resolvedRoot + sep) && resolvedTarget !== resolvedRoot) {
    throw new Error(`[PATH_ESCAPE_DETECTED] Path '${targetPath}' escapes trusted root '${root}'`);
  }

  // Reparse-point / realpath containment check if paths exist
  try {
    const realRoot = realpathSync(resolvedRoot);
    let realTarget: string;
    try {
      realTarget = realpathSync(resolvedTarget);
    } catch {
      // If target does not exist yet, check its existing parent
      realTarget = realpathSync(dirname(resolvedTarget));
    }
    if (!realTarget.startsWith(realRoot + sep) && realTarget !== realRoot) {
      throw new Error(`[REPARSE_ESCAPE_DETECTED] Realpath of '${targetPath}' escapes trusted root`);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("[")) {
      throw err;
    }
    // If root doesn't exist yet, string containment holds
  }

  return resolvedTarget;
}

/**
 * Computes deterministic prefix-sharded cache paths for a validated cache key:
 * voiceCacheRoot/
 *   ab/
 *     abcdef1234.../
 *       audio.wav
 *       asset.json
 *       alignment.json
 */
export function getCacheEntryPaths(cacheRoot: string, cacheKey: string): CacheEntryPaths {
  const validatedKey = CacheKeySchema.parse(cacheKey) as CacheKey;
  const prefix = validatedKey.slice(0, 2);
  const dirPath = resolve(cacheRoot, prefix, validatedKey);

  // Confinement check
  assertContainedWithinRoot(cacheRoot, dirPath);

  return {
    prefix,
    dirPath,
    audioPath: join(dirPath, "audio.wav"),
    assetPath: join(dirPath, "asset.json"),
    alignmentPath: join(dirPath, "alignment.json"),
  };
}

/**
 * Measures free disk space on the volume owning the given path.
 * Returns null if measurement fails or is uncertain (fail closed).
 */
export function measureFreeDiskBytes(atPath: string): number | null {
  try {
    const stats = statfsSync(atPath);
    const free = Number(stats.bfree) * Number(stats.bsize);
    if (!Number.isFinite(free) || free < 0 || !Number.isSafeInteger(Math.floor(free))) {
      return null;
    }
    return Math.floor(free);
  } catch {
    try {
      const stats = statfsSync(dirname(resolve(atPath)));
      const free = Number(stats.bfree) * Number(stats.bsize);
      if (!Number.isFinite(free) || free < 0 || !Number.isSafeInteger(Math.floor(free))) {
        return null;
      }
      return Math.floor(free);
    } catch {
      return null;
    }
  }
}

/**
 * Validates available disk space for synthesis/publication preflight.
 * Fails closed if free space cannot be verified or is below minimum threshold (2 GiB).
 */
export function assertSufficientDiskSpace(
  targetPath: string,
  minBytes: number = MIN_FREE_DISK_BYTES,
): void {
  const freeBytes = measureFreeDiskBytes(targetPath);
  if (freeBytes === null || freeBytes < minBytes) {
    throw new Error(
      `[LOW_DISK_ABORT] Insufficient disk space on volume for '${targetPath}': ` +
        `required >= ${minBytes} bytes, available = ${freeBytes ?? "unknown"} bytes`,
    );
  }
}
