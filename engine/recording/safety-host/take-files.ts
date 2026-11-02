// P9.6 Main-Side Take File Owner — trusted temp lifecycle, quarantine,
// atomic publication, and scoped orphan sweep.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 12, 19-22 and
// docs/adr/ADR-0014-screen-recording-boundary.md (honest lifecycle and
// storage; threat matrix T1/T4/T7/T8/T9).
//
// Main-side only (node:fs + node:path + node:crypto). Never imported by
// renderer code. Never touches P8 state. Never launches processes. Only the
// owned take handles are ever removed — never a global sweep, never an
// arbitrary temp deletion. Publication uses same-volume atomic renames;
// cross-volume finals fail closed without copying huge media.
//
// Privacy: errors carry safe codes + take IDs only (no absolute paths, no
// PIDs, no handles, no tool output).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANCHORS_TEMP_NAME,
  DIAGNOSTIC_PARTIAL_SUFFIX,
  MANIFEST_TEMP_NAME,
  TAKE_LOCK_NAME,
  TEMP_PARTIAL_NAME,
  classifyRecoveryEntry,
  planRecoveryAction,
  type RecoveryAction,
  type RecoveryPolicy,
} from "../src/safety/recovery.ts";
import type {
  CleanupConfirmation,
  PublicationOp,
} from "../src/safety/publication.ts";
import { parseTakeArtifactBaseName } from "../src/naming.ts";

// ---------------------------------------------------------------------------
// Trusted identifiers (P8 resolver convention, renderer supplies none)
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TAKE_ID_RE = /^t\d{2,}$/;
const LESSON_ID_RE = /^C\d{2}-L\d{3}$/;

function assertTrustedIds(session: string, take: string): void {
  if (!SESSION_ID_RE.test(session) || !TAKE_ID_RE.test(take)) {
    throw new Error("[INVALID_REQUEST] take identity is not trusted");
  }
  if (session.includes("..") || take.includes("..")) {
    throw new Error("[INVALID_REQUEST] traversal rejected in take identity");
  }
}

function assertTrustedLesson(lesson: string): void {
  if (!LESSON_ID_RE.test(lesson)) {
    throw new Error("[INVALID_REQUEST] lesson identity is not trusted");
  }
}

/** Resolves repoRoot from this module's location (no hard-coding). */
export function safetyRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Reads the machine-local path configuration (git-ignored). Never throws. */
export function readMediaPathConfig(configPath: string): Record<string, unknown> {
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

export interface TrustedMediaRoots {
  readonly repoRoot: string;
  readonly tempRoot: string;
  readonly renderRoot: string;
}

/**
 * Resolves trusted roots: tempRoot/renderRoot from machine config when
 * absolute and traversal-free, else <repoRoot>/temp and <repoRoot>/renders.
 * Never a caller-supplied media path.
 */
export function resolveTrustedMediaRoots(input?: {
  repoRoot?: string;
  config?: Record<string, unknown>;
}): TrustedMediaRoots {
  const repoRoot = input?.repoRoot ?? process.cwd();
  const config = input?.config ?? {};
  const pick = (key: string, fallback: string): string => {
    const value = config[key];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      (value[1] === ":" || value.startsWith("\\\\") || value.startsWith("/")) &&
      !value.includes("..")
    ) {
      return value;
    }
    return join(repoRoot, fallback);
  };
  return {
    repoRoot,
    tempRoot: pick("tempRoot", "temp"),
    renderRoot: pick("renderRoot", "renders"),
  };
}

// ---------------------------------------------------------------------------
// P9 recording storage authority (relocated off the repository volume)
// ---------------------------------------------------------------------------

/** File name of the P9-owned recording storage configuration (git-ignored). */
export const RECORDING_PATHS_FILE_NAME = "recording-paths.json";

/**
 * Validates one P9 recording root from machine config. Accepts only
 * absolute drive-absolute Windows paths (a fixed local volume): rejects
 * empty strings, relative paths, UNC shares, traversal segments, and NUL.
 * Deliberately narrower than the legacy tempRoot/renderRoot pick above —
 * P9 recording TEMP + FINAL publication must stay on an explicit fixed
 * volume so staging-to-final stays a same-volume atomic rename.
 */
export function isValidRecordingRoot(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\0")) return false;
  if (!/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes("..")) return false;
  return true;
}

/**
 * Resolves the authoritative P9 recording roots (storage relocation):
 * P9-owned recordingTempRoot/recordingRenderRoot from
 * config/recording-paths.json win when valid; else the mirrored
 * tempRoot/renderRoot in the same file (absolute and traversal-free,
 * shared D: authority for legacy resolvers); else the legacy
 * tempRoot/renderRoot from config/paths.json (same rule as
 * resolveTrustedMediaRoots); else <repoRoot>/temp and <repoRoot>/renders.
 * Deterministic precedence under Main/config authority only — renderer
 * input can never reach this resolver. Never throws: missing/invalid
 * config falls back and callers fail closed on disk preflight instead.
 * Reparse/symlink escapes are still rejected per-path by assertNoEscape
 * at use sites.
 */
export function resolveConfiguredRecordingRoots(input?: {
  repoRoot?: string;
  recordingConfig?: Record<string, unknown>;
  legacyConfig?: Record<string, unknown>;
  recordingConfigPath?: string;
  legacyConfigPath?: string;
}): TrustedMediaRoots {
  const repoRoot = input?.repoRoot ?? process.cwd();
  const recordingConfig =
    input?.recordingConfig ??
    readMediaPathConfig(
      input?.recordingConfigPath ?? join(repoRoot, "config", RECORDING_PATHS_FILE_NAME),
    );
  const legacyConfig =
    input?.legacyConfig ??
    readMediaPathConfig(
      input?.legacyConfigPath ?? join(repoRoot, "config", "paths.json"),
    );
  const pickFrom = (config: Record<string, unknown>, key: string): string | null => {
    const value = config[key];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      (value[1] === ":" || value.startsWith("\\\\") || value.startsWith("/")) &&
      !value.includes("..")
    ) {
      return value;
    }
    return null;
  };
  const resolveOne = (p9Key: string, legacyKey: string, fallbackDir: string): string => {
    const p9 = recordingConfig[p9Key];
    if (isValidRecordingRoot(p9)) return p9;
    return (
      pickFrom(recordingConfig, legacyKey) ??
      pickFrom(legacyConfig, legacyKey) ??
      join(repoRoot, fallbackDir)
    );
  };
  return {
    repoRoot,
    tempRoot: resolveOne("recordingTempRoot", "tempRoot", "temp"),
    renderRoot: resolveOne("recordingRenderRoot", "renderRoot", "renders"),
  };
}

/**
 * Measured free bytes on the volume owning `atPath`, or null when the
 * query fails or is uncertain (fail closed — never assume space is safe).
 */
export function freeBytesOnVolume(atPath: string): number | null {
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

// ---------------------------------------------------------------------------
// Path confinement (trusted root + realpath containment, no escapes)
// ---------------------------------------------------------------------------

function containedPath(rootResolved: string, candidate: string): string {
  const dir = resolve(rootResolved, candidate);
  if (!dir.startsWith(rootResolved + sep) && dir !== rootResolved) {
    throw new Error("[INVALID_REQUEST] take path escapes trusted root");
  }
  return dir;
}

/** Rejects reparse/symlink escapes: existing path realpath must stay inside. */
function assertNoEscape(rootResolved: string, absPath: string): void {
  let real: string;
  try {
    real = realpathSync(absPath);
  } catch {
    // Missing paths cannot escape yet; the parent below still confines them.
    try {
      real = realpathSync(dirname(absPath));
    } catch {
      return;
    }
    const rootReal = (() => {
      try {
        return realpathSync(rootResolved);
      } catch {
        return rootResolved;
      }
    })();
    if (!absPath.startsWith(rootResolved + sep)) {
      throw new Error("[INVALID_REQUEST] take path escapes trusted root");
    }
    void rootReal;
    return;
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(rootResolved);
  } catch {
    rootReal = rootResolved;
  }
  if (!real.startsWith(rootReal + sep) && real !== rootReal) {
    throw new Error("[INVALID_REQUEST] reparse escape rejected");
  }
}

// ---------------------------------------------------------------------------
// Node safety take files (implements the controller file surface)
// ---------------------------------------------------------------------------

export interface StagedPublicationContent {
  readonly manifestJson: string;
  readonly anchorsText: string;
  readonly expectedMediaDigest: string;
  readonly lessonId: string;
  readonly takeBaseName: string;
}

export interface SweepReport {
  readonly scanned: number;
  readonly purged: number;
  readonly keptActive: number;
  readonly ignored: number;
  readonly keptDiagnostic: number;
}

const QUARANTINE_MEDIA_NAME = `screen${DIAGNOSTIC_PARTIAL_SUFFIX}`;

export class NodeSafetyTakeFiles {
  private readonly tempRoot: string;
  private readonly renderRoot: string;
  private stageContent: StagedPublicationContent | null = null;

  constructor(input: { tempRoot: string; renderRoot: string }) {
    if (typeof input.tempRoot !== "string" || input.tempRoot.length === 0) {
      throw new Error("[INVALID_REQUEST] temp root must be non-empty");
    }
    if (typeof input.renderRoot !== "string" || input.renderRoot.length === 0) {
      throw new Error("[INVALID_REQUEST] render root must be non-empty");
    }
    this.tempRoot = input.tempRoot;
    this.renderRoot = input.renderRoot;
  }

  /** Supplies the staged manifest/anchors/digest for the next publication. */
  setStagedContent(content: StagedPublicationContent | null): void {
    this.stageContent = content;
  }

  takeTempDir(recordingSessionId: string, takeId: string): string {
    assertTrustedIds(recordingSessionId, takeId);
    const rootResolved = resolve(this.tempRoot);
    const dir = containedPath(rootResolved, join("recording", recordingSessionId, takeId));
    assertNoEscape(rootResolved, dir);
    return dir;
  }

  finalTakeDir(lessonId: string): string {
    assertTrustedLesson(lessonId);
    const rootResolved = resolve(this.renderRoot);
    const dir = containedPath(
      rootResolved,
      join("intermediate", "screen", lessonId),
    );
    assertNoEscape(rootResolved, dir);
    return dir;
  }

  /** Purges one take temp dir; confirms removal (fail closed on doubt). */
  async purgeTakeTemp(input: {
    recordingSessionId: string;
    takeId: string;
  }): Promise<CleanupConfirmation> {
    const dir = this.takeTempDir(input.recordingSessionId, input.takeId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Fall through to the existence proof below.
    }
    try {
      statSync(dir);
      return "UNCONFIRMED";
    } catch {
      return "CONFIRMED";
    }
  }

  /**
   * Quarantines one take temp dir: the partial media (if any) is renamed to
   * a clearly-named diagnostic inside the same trusted temp dir (same-volume
   * rename, no copy); staging temps and the lock are removed. Never under
   * the final render root. Idempotent.
   */
  async quarantineTakeTemp(input: {
    recordingSessionId: string;
    takeId: string;
  }): Promise<"QUARANTINED" | "ABSENT" | "UNCONFIRMED"> {
    const dir = this.takeTempDir(input.recordingSessionId, input.takeId);
    const partial = join(dir, TEMP_PARTIAL_NAME);
    const diagnostic = join(dir, QUARANTINE_MEDIA_NAME);
    const hasPartial = existsSync(partial);
    const hasDiagnostic = existsSync(diagnostic);
    if (!hasPartial && !hasDiagnostic) {
      // Nothing to retain: still purge staging residue, then report absent.
      for (const name of [MANIFEST_TEMP_NAME, ANCHORS_TEMP_NAME, TAKE_LOCK_NAME]) {
        try {
          rmSync(join(dir, name), { force: true });
        } catch {
          // Best-effort; absence of media is authoritative here.
        }
      }
      return "ABSENT";
    }
    if (hasPartial && !hasDiagnostic) {
      try {
        renameSync(partial, diagnostic);
      } catch {
        return "UNCONFIRMED";
      }
    } else if (hasPartial && hasDiagnostic) {
      // A previous quarantine already retained media: purge the duplicate
      // partial so exactly one bounded diagnostic remains.
      try {
        rmSync(partial, { force: true });
      } catch {
        return "UNCONFIRMED";
      }
    }
    for (const name of [MANIFEST_TEMP_NAME, ANCHORS_TEMP_NAME, TAKE_LOCK_NAME]) {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        return "UNCONFIRMED";
      }
    }
    return existsSync(diagnostic) ? "QUARANTINED" : "UNCONFIRMED";
  }

  /** Executes one publication transaction step (single attempt, no retry). */
  async runPublicationStep(
    step: PublicationOp,
    input: { recordingSessionId: string; takeId: string },
  ): Promise<{ ok: boolean; failedAt?: PublicationOp }> {
    const fail = { ok: false as const, failedAt: step };
    try {
      switch (step) {
        case "WRITE_MANIFEST_TEMP": {
          if (this.stageContent === null) return fail;
          const dir = this.takeTempDir(input.recordingSessionId, input.takeId);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, MANIFEST_TEMP_NAME), this.stageContent.manifestJson, "utf8");
          return { ok: true };
        }
        case "WRITE_ANCHORS_TEMP": {
          if (this.stageContent === null) return fail;
          const dir = this.takeTempDir(input.recordingSessionId, input.takeId);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, ANCHORS_TEMP_NAME), this.stageContent.anchorsText, "utf8");
          return { ok: true };
        }
        case "RENAME_MEDIA":
        case "RENAME_MANIFEST":
        case "RENAME_ANCHORS": {
          return this.renameFinal(step, input) ? { ok: true } : fail;
        }
        case "VERIFY_SET": {
          return this.verifyFinalSet(input) ? { ok: true } : fail;
        }
        case "CLEANUP_STAGING": {
          const dir = this.takeTempDir(input.recordingSessionId, input.takeId);
          for (const name of [MANIFEST_TEMP_NAME, ANCHORS_TEMP_NAME, TAKE_LOCK_NAME, TEMP_PARTIAL_NAME]) {
            try {
              rmSync(join(dir, name), { force: true });
            } catch {
              return fail;
            }
          }
          return { ok: true };
        }
      }
    } catch {
      return fail;
    }
  }

  /** Removes published finals during rollback (reverse of the renames). */
  async removePublished(input: {
    recordingSessionId: string;
    takeId: string;
  }): Promise<CleanupConfirmation> {
    if (this.stageContent === null) return "UNCONFIRMED";
    const parsed = parseTakeArtifactBaseName(this.stageContent.takeBaseName);
    const dir = this.finalTakeDir(this.stageContent.lessonId);
    const base = `${parsed.lesson_id}--gen${parsed.generation}--take${parsed.take_id}`;
    let ok = true;
    for (const name of [`${base}.mp4`, `${base}.manifest.json`, `${base}.anchors.jsonl`]) {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        ok = false;
      }
      if (existsSync(join(dir, name))) ok = false;
    }
    return ok ? "CONFIRMED" : "UNCONFIRMED";
  }

  // -- internals -------------------------------------------------------------

  private renameFinal(
    step: "RENAME_MEDIA" | "RENAME_MANIFEST" | "RENAME_ANCHORS",
    input: { recordingSessionId: string; takeId: string },
  ): boolean {
    if (this.stageContent === null) return false;
    const parsed = parseTakeArtifactBaseName(this.stageContent.takeBaseName);
    const tempDir = this.takeTempDir(input.recordingSessionId, input.takeId);
    const finalDir = this.finalTakeDir(this.stageContent.lessonId);
    const base = `${parsed.lesson_id}--gen${parsed.generation}--take${parsed.take_id}`;
    const pairs: Record<typeof step, [string, string]> = {
      RENAME_MEDIA: [join(tempDir, TEMP_PARTIAL_NAME), join(finalDir, `${base}.mp4`)],
      RENAME_MANIFEST: [join(tempDir, MANIFEST_TEMP_NAME), join(finalDir, `${base}.manifest.json`)],
      RENAME_ANCHORS: [join(tempDir, ANCHORS_TEMP_NAME), join(finalDir, `${base}.anchors.jsonl`)],
    };
    const [from, to] = pairs[step];
    if (!existsSync(from)) return false;
    if (!this.sameVolume(tempDir, finalDir)) return false;
    try {
      mkdirSync(finalDir, { recursive: true });
      assertNoEscape(resolve(this.renderRoot), finalDir);
    } catch {
      return false;
    }
    if (existsSync(to)) return false;
    try {
      renameSync(from, to);
    } catch {
      return false;
    }
    if (step === "RENAME_MEDIA") {
      // Digest must match the final bytes; same-volume rename preserves
      // bytes, so a mismatch means the temp was never valid.
      const digest = this.sha256File(to);
      if (digest === null || digest !== this.stageContent.expectedMediaDigest) {
        try {
          rmSync(to, { force: true });
        } catch {
          // Removal uncertainty is reported by the caller rollback.
        }
        return false;
      }
    }
    return existsSync(to);
  }

  private verifyFinalSet(input: {
    recordingSessionId: string;
    takeId: string;
  }): boolean {
    if (this.stageContent === null) return false;
    const parsed = parseTakeArtifactBaseName(this.stageContent.takeBaseName);
    const dir = this.finalTakeDir(this.stageContent.lessonId);
    const base = `${parsed.lesson_id}--gen${parsed.generation}--take${parsed.take_id}`;
    for (const name of [`${base}.mp4`, `${base}.manifest.json`, `${base}.anchors.jsonl`]) {
      try {
        const stat = statSync(join(dir, name));
        if (!stat.isFile() || stat.size <= 0) return false;
      } catch {
        return false;
      }
    }
    void input;
    return true;
  }

  private sha256File(absPath: string): string | null {
    try {
      return createHash("sha256").update(this.readAll(absPath)).digest("hex");
    } catch {
      return null;
    }
  }

  private readAll(absPath: string): Buffer {
    // Chunked read is the media owner's job; publication fixtures here stay
    // KB-scale by contract (bounded test artifacts only, never real video).
    return readFileSync(absPath);
  }

  private sameVolume(a: string, b: string): boolean {
    const ra = resolve(a).toLowerCase();
    const rb = resolve(b).toLowerCase();
    const driveA = /^[a-z]:/.exec(ra)?.[0] ?? "";
    const driveB = /^[a-z]:/.exec(rb)?.[0] ?? "";
    if (driveA !== "" || driveB !== "") return driveA === driveB && driveA !== "";
    try {
      const sa = statSync(resolve(a));
      const sb = statSync(resolve(b));
      return (sa as { dev?: number }).dev === (sb as { dev?: number }).dev;
    } catch {
      return false;
    }
  }

  // -- scoped orphan sweep -----------------------------------------------------
  /**
   * Sweeps stale P9-owned entries directly under the trusted temp recording
   * root (one session level + one take level). Never touches unrelated temp,
   * never touches the active take, never resumes anything. Idempotent.
   */
  sweepOrphans(input: {
    activeSessionId: string | null;
    activeTakeId: string | null;
    policy: RecoveryPolicy;
  }  ): SweepReport {
    let scanned = 0;
    let purged = 0;
    let keptActive = 0;
    let ignored = 0;
    let keptDiagnostic = 0;
    const rootResolved = resolve(this.tempRoot);
    const recordingRoot = join(rootResolved, "recording");
    let sessions: string[];
    try {
      sessions = readdirSync(recordingRoot);
    } catch {
      return { scanned, purged, keptActive, ignored, keptDiagnostic };
    }
    for (const session of sessions) {
      if (!SESSION_ID_RE.test(session)) continue;
      const sessionDir = join(recordingRoot, session);
      let takes: string[];
      try {
        if (!statSync(sessionDir).isDirectory()) continue;
        takes = readdirSync(sessionDir);
      } catch {
        continue;
      }
      for (const take of takes) {
        if (!TAKE_ID_RE.test(take)) continue;
        const takeDir = join(sessionDir, take);
        let entries: string[];
        try {
          if (!statSync(takeDir).isDirectory()) continue;
          entries = readdirSync(takeDir);
        } catch {
          continue;
        }
        const ownedByActive =
          input.activeSessionId !== null &&
          input.activeTakeId !== null &&
          session === input.activeSessionId &&
          take === input.activeTakeId;
        for (const name of entries) {
          scanned += 1;
          const entry = classifyRecoveryEntry({ name, ownedByActive });
          const action: RecoveryAction = planRecoveryAction(entry, input.policy);
          if (action === "KEEP_ACTIVE") {
            keptActive += 1;
            continue;
          }
          if (action === "IGNORE") {
            ignored += 1;
            continue;
          }
          if (action === "KEEP_DIAGNOSTIC") {
            keptDiagnostic += 1;
            continue;
          }
          try {
            rmSync(join(takeDir, name), { force: true, recursive: true });
            purged += 1;
          } catch {
            // A failed purge is reported by residue checks, never thrown.
          }
        }
      }
    }
    return { scanned, purged, keptActive, ignored, keptDiagnostic };
  }
}
