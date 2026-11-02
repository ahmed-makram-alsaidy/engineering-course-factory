// P9.3 Trusted Tool Resolution — pinned FFmpeg/FFprobe discovery.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 7, 12 (fixed
// executable resolved Main-side at preflight from config/paths.json;
// PATH-name resolution allowed only as a lookup step whose result is pinned
// before spawn) and ADR-0005 (central path configuration, no hard-coded
// locations in code).
//
// Main-side only (filesystem access). Resolves absolute pinned tool paths
// plus the P9 temp root. Never accepts paths from any caller-controlled
// channel: inputs are the machine-local config file and the process PATH,
// both Main-side facts. Returns absolute paths for spawn; version strings
// and descriptors exposed elsewhere carry versions only, never paths.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedTools {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly source: "config-absolute" | "path-search" | "sibling";
}

export interface TrustedRoots {
  readonly repoRoot: string;
  readonly tempRoot: string;
}

/** Repository root derived from this module's location (no hard-coding). */
export function repoRootFromHere(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..");
}

/** Reads the machine-local path configuration (git-ignored). Never throws. */
export function readPathConfig(configPath: string): Record<string, unknown> {
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

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile() && existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Manual PATH search for a tool file name (no process spawned for lookup).
 * Returns the first absolute candidate that exists as a file, else null.
 */
export function searchPathForTool(fileName: string): string | null {
  const pathEnv = process.env["PATH"] ?? process.env["Path"] ?? "";
  const fileNames =
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
    for (const name of fileNames) {
      const candidate = join(trimmed, name);
      if (isAbsolute(candidate) && isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** Resolves one tool: config absolute path wins, else PATH search. */
function resolveOneTool(
  configValue: unknown,
  defaultName: string,
): { path: string | null; fromConfig: boolean } {
  if (typeof configValue === "string" && configValue.length > 0) {
    if (isAbsolute(configValue) && isExecutableFile(configValue)) {
      return { path: configValue, fromConfig: true };
    }
    const searched = searchPathForTool(configValue);
    if (searched !== null) {
      return { path: searched, fromConfig: true };
    }
    if (isAbsolute(configValue)) {
      return { path: null, fromConfig: true };
    }
  }
  return { path: searchPathForTool(defaultName), fromConfig: false };
}

/**
 * Resolves pinned absolute FFmpeg/FFprobe paths. The ffprobe companion
 * falls back to the ffmpeg sibling directory (fixed trusted companion).
 * Throws path-free errors when a tool cannot be pinned.
 */
export function resolvePinnedTools(options?: {
  configPath?: string;
}): ResolvedTools {
  const repoRoot = repoRootFromHere();
  const configPath = options?.configPath ?? join(repoRoot, "config", "paths.json");
  const config = readPathConfig(configPath);

  const ffmpeg = resolveOneTool(config["ffmpegPath"], "ffmpeg");
  if (ffmpeg.path === null) {
    throw new Error("[ENCODER_UNAVAILABLE] ffmpeg executable cannot be pinned");
  }
  let ffprobePath: string | null = null;
  let source: ResolvedTools["source"] = ffmpeg.fromConfig ? "config-absolute" : "path-search";
  const ffprobe = resolveOneTool(config["ffprobePath"], "ffprobe");
  if (ffprobe.path !== null) {
    ffprobePath = ffprobe.path;
    if (!ffmpeg.fromConfig && !ffprobe.fromConfig) {
      source = "path-search";
    } else {
      source = "config-absolute";
    }
  } else {
    const sibling = join(dirname(ffmpeg.path), "ffprobe.exe");
    if (isExecutableFile(sibling)) {
      ffprobePath = sibling;
      source = "sibling";
    }
  }
  if (ffprobePath === null) {
    throw new Error("[ENCODER_UNAVAILABLE] ffprobe executable cannot be pinned");
  }
  return { ffmpeg: ffmpeg.path, ffprobe: ffprobePath, source };
}

/**
 * Resolves trusted roots: tempRoot from machine config when absolute and
 * present, else <repoRoot>/temp. Never a caller-supplied media path.
 */
export function resolveTrustedRoots(options?: {
  configPath?: string;
}): TrustedRoots {
  const repoRoot = repoRootFromHere();
  const configPath = options?.configPath ?? join(repoRoot, "config", "paths.json");
  const config = readPathConfig(configPath);
  const configured = config["tempRoot"];
  if (
    typeof configured === "string" &&
    configured.length > 0 &&
    isAbsolute(configured) &&
    !configured.includes("..")
  ) {
    return { repoRoot, tempRoot: configured };
  }
  return { repoRoot, tempRoot: join(repoRoot, "temp") };
}
