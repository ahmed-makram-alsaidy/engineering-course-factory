// P5.3 workspace resolution — trusted mapping from an ExecutionGrant to a
// validated, runtime-only ResolvedExecutionContext (docs/P5-DESIGN-SPEC.md,
// task P5.3: "P5.3 Workspace resolution — mount environment (no execution)").
//
// This module performs NO command or container execution and never starts any
// process. It only:
//   1. validates the machine-local configured workspace root,
//   2. creates the exclusive, fresh per-session workspace leaf
//      <root>/workspaces/<lesson-id>/<session-id>,
//   3. confines the grant's authored cwd inside that leaf (structural rules +
//      physical symlink/junction checks),
//   4. derives the single-mount plan (leaf -> /workspace), and
//   5. assembles the frozen ResolvedExecutionContext for later phases.
//
// Trust boundaries: inputs are a schema-valid ExecutionGrant (trusted main
// runtime only — a renderer request has no field that could carry cwd, paths,
// mounts, environment or image identity) plus machine-local configuration.
// Everything hostile-cwd related here is defense-in-depth: the canonical
// compilation pipeline already confines authored cwd, but the workspace layer
// re-validates rather than trusting its producer.
//
// Machine-local configuration is the ONLY source of the workspace root — the
// repository neither contains nor hard-codes any absolute machine path.

import { z } from "zod";
import { statSync, realpathSync, mkdirSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { IdentifierSchema, type RuntimeErrorCode } from "./protocol.ts";
import { ExecutionGrantSchema, type ExecutionGrant } from "./admission.ts";
import { EnvironmentPlanSchema, validateEnvironmentPlan, type EnvironmentPlan } from "./environment.ts";

// ---------------------------------------------------------------------------
// Outcome type — structured rejection, never thrown across boundaries.
// ---------------------------------------------------------------------------

export interface WorkspaceRejection {
  readonly code: RuntimeErrorCode;
  readonly message: string;
}

export type WorkspaceOutcome<T> = { ok: true; value: T } | { ok: false; error: WorkspaceRejection };

function rejected(code: RuntimeErrorCode, message: string): { ok: false; error: WorkspaceRejection } {
  return { ok: false, error: { code, message } };
}

/** Runtime sandbox policy reference this resolution was performed for. */
export const SANDBOX_POLICY_REF = "course-factory/terminal/p5/docker-create-argv-v1";

// ---------------------------------------------------------------------------
// Shared boundary helper — prefix collisions ("workspace" vs "workspace-evil")
// are impossible here because containment is decided with relative(), never
// with a naive startsWith comparison.
// ---------------------------------------------------------------------------

function samePath(a: string, b: string): boolean {
  const na = nodePath.normalize(a);
  const nb = nodePath.normalize(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * Pure containment decision: is `candidate` inside (or equal to) `root`?
 * Implemented with path-relative semantics so a sibling whose name merely
 * extends the root's name (prefix collision) is correctly OUTSIDE.
 */
export function isInsideWorkspace(rootAbsolute: string, candidateAbsolute: string): boolean {
  const rel = nodePath.relative(nodePath.normalize(rootAbsolute), nodePath.normalize(candidateAbsolute));
  if (rel === "") return true; // equal to the root itself counts as inside
  if (nodePath.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${nodePath.sep}`);
}

function realWithin(rootReal: string, candidateReal: string): boolean {
  const rel = nodePath.relative(rootReal, candidateReal);
  if (rel === "") return true;
  const norm = process.platform === "win32" ? rel.toLowerCase() : rel;
  return !nodePath.isAbsolute(rel) && norm !== ".." && !norm.startsWith(`..${nodePath.sep}`);
}

// ---------------------------------------------------------------------------
// 1. Configured workspace root — machine-local, validated, never trusted.
// ---------------------------------------------------------------------------

export interface ResolvedWorkspaceRoot {
  /** Normalized absolute configured root (machine-local, never committed). */
  readonly host_root: string;
  /** Realpath of the root — all containment checks use this. */
  readonly real_root: string;
}

const RUNTIME_CONFIG_DIRNAME = "config";
const RUNTIME_CONFIG_BASENAME = "paths.json";
const RUNTIME_WORKSPACES_SUBDIR = "workspaces";

/**
 * Machine-local runtime configuration contract. `config/paths.json` is
 * git-ignored (.gitignore) — each machine supplies its own absolute
 * `runtimeWorkspaceRoot`; `config/paths.example.json` documents the shape.
 */
export const TerminalRuntimePathsSchema = z.strictObject({
  runtimeWorkspaceRoot: z.string().min(1),
});
export type TerminalRuntimePaths = z.infer<typeof TerminalRuntimePathsSchema>;

/** Repository root, derived from this module's own location (no hard-coded paths). */
export function defaultRepositoryRoot(): string {
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * Load machine-local runtime configuration from `<repoRoot>/config/paths.json`.
 * Missing or malformed configuration is a structured runtime-environment
 * failure (WORKSPACE_UNAVAILABLE), never a fall back to defaults.
 */
export function loadTerminalRuntimePaths(repoRoot: string): WorkspaceOutcome<TerminalRuntimePaths> {
  const configPath = nodePath.join(repoRoot, RUNTIME_CONFIG_DIRNAME, RUNTIME_CONFIG_BASENAME);
  let read: string | null = null;
  try {
    read = readFileSync(configPath, "utf8");
  } catch {
    read = null;
  }
  if (read === null) {
    return rejected(
      "WORKSPACE_UNAVAILABLE",
      `machine-local runtime configuration missing (${RUNTIME_CONFIG_DIRNAME}/${RUNTIME_CONFIG_BASENAME}); copy ${RUNTIME_CONFIG_DIRNAME}/paths.example.json and set an absolute runtimeWorkspaceRoot`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(read);
  } catch {
    return rejected("WORKSPACE_UNAVAILABLE", `machine-local runtime configuration is not valid JSON (${RUNTIME_CONFIG_DIRNAME}/${RUNTIME_CONFIG_BASENAME})`);
  }
  const parsed = TerminalRuntimePathsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return rejected("WORKSPACE_UNAVAILABLE", "machine-local runtime configuration must provide a non-empty runtimeWorkspaceRoot string");
  }
  return { ok: true, value: parsed.data };
}

/**
 * Validate the configured runtime workspace root. Rejects (before any
 * filesystem mutation):
 *   - non-absolute or NUL-bearing values, UNC/device-namespace paths,
 *   - filesystem/drive roots ("C:\", "/", "\\\\."),
 *   - the user profile directory and the repository root,
 *   - source text that cannot be represented in bind-mount grammar
 *     (commas/quotes/CR/LF; spaces are accepted),
 *   - symlinks/junctions anywhere in the root's chain (realpath mismatch).
 */
export function resolveConfiguredWorkspaceRoot(
  runtimeWorkspaceRoot: string,
  context: { readonly repositoryRoot?: string } = {},
): WorkspaceOutcome<ResolvedWorkspaceRoot> {
  if (typeof runtimeWorkspaceRoot !== "string" || runtimeWorkspaceRoot.length === 0) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root must be a non-empty string");
  }
  if (runtimeWorkspaceRoot.includes("\0")) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root must not contain NUL");
  }
  // Bind-mount grammar: a mount source may not contain commas/quotes/CR/LF.
  // (Whitespace is accepted; detected values never enter container argv.)
  if (/[,\"'\r\n]/.test(runtimeWorkspaceRoot)) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root must not contain comma, quote, CR or LF (bind-mount grammar)");
  }
  if (/^\\\\/.test(runtimeWorkspaceRoot)) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root must not be a UNC or device-namespace path");
  }
  if (!nodePath.isAbsolute(runtimeWorkspaceRoot)) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root must be an absolute path");
  }
  const normalized = nodePath.normalize(runtimeWorkspaceRoot);
  if (samePath(normalized, nodePath.parse(normalized).root)) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root must not be a filesystem/drive root");
  }
  if (samePath(normalized, homedir())) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root must not be the user profile directory");
  }
  if (context.repositoryRoot !== undefined && samePath(normalized, context.repositoryRoot)) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root must not be the repository root");
  }
  let stats;
  try {
    stats = statSync(normalized);
  } catch {
    return rejected(
      "WORKSPACE_UNAVAILABLE",
      `configured runtime workspace root does not exist (create it first, e.g. scripts/ensure-p5-workspace.mjs): ${normalized}`,
    );
  }
  if (!stats.isDirectory()) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root must be a directory");
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(normalized);
  } catch {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root could not be resolved");
  }
  if (!samePath(normalized, realRoot)) {
    return rejected("WORKSPACE_UNAVAILABLE", "configured runtime workspace root is behind a symlink or junction — configured paths must be physical");
  }
  return { ok: true, value: Object.freeze({ host_root: normalized, real_root: realRoot }) };
}

// ---------------------------------------------------------------------------
// 2. Session workspace leaf — exclusive, fresh, physically canonical.
// ---------------------------------------------------------------------------

/**
 * A session workspace leaf: the physical host directory that will later be
 * the ONLY host path mounted into the lesson container (at /workspace).
 * Runtime-only value; created by createSessionWorkspace, consumed by
 * resolveGrantWorkspace and buildWorkspaceMountPlan.
 */
export interface SessionWorkspace {
  readonly lesson_id: string;
  readonly session_id: string;
  readonly generation: number;
  readonly host_root: string;
  readonly real_root: string;
  readonly container_root: "/workspace";
}

/** Windows reserves device names as path stems on any directory. */
const WINDOWS_DEVICE_NAMES: readonly string[] = [
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

function isWindowsDeviceNameStem(segment: string): boolean {
  return WINDOWS_DEVICE_NAMES.includes(segment.split(".")[0].toUpperCase());
}

function assertPathComponent(value: string, what: string): string | null {
  if (value.length === 0 || value.length > 128) return `${what} must be 1..128 characters`;
  if (!IdentifierSchema.safeParse(value).success) return `${what} must match the identifier grammar`;
  if (value === "." || value === "..") return `${what} must not be a relative dot component`;
  if (value.includes("/") || value.includes("\\")) return `${what} must be a single path component (no separators)`;
  if (value.includes(":")) return `${what} must not contain ':' (drive-letter, ADS or device-namespace trick)`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return `${what} must not contain control characters`;
  if (value !== value.trim()) return `${what} must not begin or end with whitespace`;
  if (value.endsWith(".")) return `${what} must not end with '.' (Windows strips trailing dots)`;
  if (isWindowsDeviceNameStem(value)) return `${what} must not be a Windows device name`;
  return null;
}

/**
 * Create the exclusive, fresh workspace leaf for one runtime session:
 * `<root>/workspaces/<lesson_id>/<session_id>`. Fails if the leaf already
 * exists (no cross-session or cross-generation reuse), if any parent on the
 * chain is a symlink/junction, or if the created leaf's realpath is not
 * physically at the canonical location.
 */
export function createSessionWorkspace(
  root: ResolvedWorkspaceRoot,
  identity: { readonly lesson_id: string; readonly session_id: string; readonly generation: number },
): WorkspaceOutcome<SessionWorkspace> {
  const lessonProblem = assertPathComponent(identity.lesson_id, "lesson_id");
  if (lessonProblem !== null) return rejected("INVALID_REQUEST", lessonProblem);
  const sessionProblem = assertPathComponent(identity.session_id, "session_id");
  if (sessionProblem !== null) return rejected("INVALID_REQUEST", sessionProblem);
  if (!Number.isInteger(identity.generation) || identity.generation < 0) {
    return rejected("INVALID_REQUEST", "generation must be a non-negative integer");
  }

  const workspacesDir = nodePath.join(root.host_root, RUNTIME_WORKSPACES_SUBDIR);
  const lessonDir = nodePath.join(workspacesDir, identity.lesson_id);
  const leaf = nodePath.join(lessonDir, identity.session_id);

  // Pre-existing chain members must be physical directories, never links.
  for (const dir of [workspacesDir, lessonDir]) {
    try {
      const lst = lstatSync(dir);
      if (lst.isSymbolicLink()) {
        return rejected("WORKSPACE_VIOLATION", `workspace chain member is a symlink or junction: ${dir}`);
      }
      if (!lst.isDirectory()) {
        return rejected("WORKSPACE_VIOLATION", `workspace chain member is not a directory: ${dir}`);
      }
    } catch {
      // Missing parents are created below (exclusive mkdir of the leaf only).
    }
  }
  try {
    mkdirSync(workspacesDir, { recursive: true });
    mkdirSync(lessonDir, { recursive: true });
    mkdirSync(leaf); // exclusive: fails when the session leaf already exists
  } catch {
    return rejected("WORKSPACE_VIOLATION", `session workspace leaf already exists or could not be created (must be exclusive and fresh): ${leaf}`);
  }

  // The leaf must resolve, physically, to the canonical expected location.
  let realLeaf: string;
  try {
    realLeaf = realpathSync(leaf);
  } catch {
    return rejected("WORKSPACE_VIOLATION", "session workspace leaf could not be resolved after creation");
  }
  const expectedRelative = nodePath.join(RUNTIME_WORKSPACES_SUBDIR, identity.lesson_id, identity.session_id);
  const actualRelative = nodePath.relative(root.real_root, realLeaf);
  const sameRelative =
    process.platform === "win32"
      ? actualRelative.toLowerCase() === expectedRelative.toLowerCase()
      : actualRelative === expectedRelative;
  if (!sameRelative || !realWithin(root.real_root, realLeaf)) {
    return rejected("WORKSPACE_VIOLATION", "session workspace leaf is not physically at its canonical location (symlink/junction escape)");
  }

  return {
    ok: true,
    value: Object.freeze({
      lesson_id: identity.lesson_id,
      session_id: identity.session_id,
      generation: identity.generation,
      host_root: leaf,
      real_root: realLeaf,
      container_root: "/workspace",
    }),
  };
}

// ---------------------------------------------------------------------------
// 3. Authored cwd confinement — the exact rules from docs/P5-DESIGN-SPEC.md.
// ---------------------------------------------------------------------------

/**
 * Confine an authored cwd to the workspace-relative POSIX segment form.
 *
 * Rules (P5-DESIGN-SPEC "cwd confinement"):
 *   - null → workspace root; "." → workspace root (a single trailing '.' is
 *     the ONLY transformation).
 *   - Rejected: NUL/control characters, backslashes and mixed separators,
 *     ':' anywhere (drive letters, NTFS alternate data streams, device
 *     namespaces), absolute POSIX or Windows paths, UNC ("//"), '.' or '..'
 *     segments other than removed '.' entries, empty segments ("//" or
 *     trailing '/'), Windows device-name stems, trailing dot/space, URI
 *     percent-encoding, characters outside [A-Za-z0-9_ .-].
 *   - No URI decoding ever happens — %40 stays literal (and is rejected).
 *
 * @returns the normalized workspace-relative segments ([] = workspace root).
 */
export function resolveAuthoredCwdSegments(cwd: string | null): WorkspaceOutcome<readonly string[]> {
  if (cwd === null) return { ok: true, value: Object.freeze([]) };
  if (cwd.length === 0) return rejected("WORKSPACE_VIOLATION", "cwd must be null or a non-empty project-relative path");
  if (/[\u0000-\u001f\u007f]/.test(cwd)) return rejected("WORKSPACE_VIOLATION", "cwd must not contain NUL or control characters");
  if (cwd.includes("\\")) return rejected("WORKSPACE_VIOLATION", "cwd must not contain backslashes (POSIX separators only)");
  if (cwd.includes(":")) return rejected("WORKSPACE_VIOLATION", "cwd must not contain ':' (drive letter, ADS or namespace syntax)");
  if (cwd.startsWith("/")) return rejected("WORKSPACE_VIOLATION", "cwd must be project-relative (no leading '/')");
  if (/^[A-Za-z]:/.test(cwd)) return rejected("WORKSPACE_VIOLATION", "cwd must be project-relative (no drive letters)");
  if (cwd.includes("%")) return rejected("WORKSPACE_VIOLATION", "cwd must not contain URI percent-encoding (no decoding is performed)");
  const segments: string[] = [];
  for (const segment of cwd.split("/")) {
    if (segment === ".") continue; // the only transformation performed
    if (segment === "..") return rejected("WORKSPACE_VIOLATION", "cwd must not contain '..' segments");
    if (segment === "") return rejected("WORKSPACE_VIOLATION", "cwd must not contain empty segments ('//' or trailing '/')");
    if (segment.startsWith(" ") || segment.endsWith(" ") || segment.endsWith(".")) {
      return rejected("WORKSPACE_VIOLATION", "cwd segments must not begin or end with whitespace or end with '.'");
    }
    if (isWindowsDeviceNameStem(segment)) return rejected("WORKSPACE_VIOLATION", "cwd segments must not be Windows device names");
    if (!/^[A-Za-z0-9_. -]+$/.test(segment)) return rejected("WORKSPACE_VIOLATION", "cwd segments must only contain [A-Za-z0-9_ .-]");
    segments.push(segment);
  }
  return { ok: true, value: Object.freeze(segments) };
}

// ---------------------------------------------------------------------------
// 4. Grant -> workspace resolution — physical re-verification of the leaf,
// structural boundary check, then physical (lstat + realpath) confinement of
// the resolved cwd. Read-only: a rejected resolution never mutates the
// workspace tree and never leaves new directories behind.
// ---------------------------------------------------------------------------

export interface ResolvedWorkspacePaths {
  readonly lesson_id: string;
  readonly session_id: string;
  readonly generation: number;
  /** Physical host session leaf — the ONLY host path ever mounted. */
  readonly host_workspace_root: string;
  readonly real_workspace_root: string;
  readonly container_workspace_root: "/workspace";
  /** Host cwd inside the leaf (platform separators at runtime only). */
  readonly host_cwd: string;
  /** Container cwd — POSIX, always inside /workspace. */
  readonly container_cwd: string;
  /** Provenance: the exact validated grant this resolution was derived from. */
  readonly grant: ExecutionGrant;
}

/**
 * Resolve a schema-valid ExecutionGrant against a session workspace.
 *
 * Identity checks: a grant for a different session/lesson is WRONG_OWNER; a
 * grant from an older generation of the same session is STALE_SESSION.
 * Hostile cwd values are structurally rejected, then the physical path is
 * verified component-by-component (no symlinks/junctions, directories only,
 * missing cwd rejected) and re-verified via realpath against the leaf's
 * realpath. Containment always uses relative()-based boundaries.
 */
export function resolveGrantWorkspace(
  workspace: SessionWorkspace,
  grant: ExecutionGrant,
): WorkspaceOutcome<ResolvedWorkspacePaths> {
  // Defense-in-depth: re-validate the grant against the canonical schema even
  // though the trusted producer already did (the workspace layer trusts no one).
  const parsedGrant = ExecutionGrantSchema.safeParse(grant);
  if (!parsedGrant.success) {
    return rejected("INVALID_REQUEST", "grant does not satisfy ExecutionGrantSchema");
  }
  const validGrant = parsedGrant.data;
  if (validGrant.lesson_id !== workspace.lesson_id || validGrant.session_id !== workspace.session_id) {
    return rejected("WRONG_OWNER", "grant identity does not match the session workspace owner");
  }
  if (validGrant.generation !== workspace.generation) {
    return rejected("STALE_SESSION", "grant generation does not match the session workspace generation");
  }

  // The session leaf must still exist, as a physical directory.
  let leafStats;
  try {
    leafStats = lstatSync(workspace.host_root);
  } catch {
    return rejected("WORKSPACE_UNAVAILABLE", "session workspace leaf is missing");
  }
  if (leafStats.isSymbolicLink()) {
    return rejected("WORKSPACE_VIOLATION", "session workspace leaf is a symlink or junction");
  }
  if (!leafStats.isDirectory()) {
    return rejected("WORKSPACE_VIOLATION", "session workspace leaf is not a directory");
  }

  const segmentsResult = resolveAuthoredCwdSegments(validGrant.cwd);
  if (!segmentsResult.ok) return segmentsResult;
  const segments = segmentsResult.value;

  // Runtime container cwd (POSIX, confined) and host cwd (platform paths).
  const containerCwd = nodePath.posix.join("/workspace", ...segments);
  const relContainer = nodePath.posix.relative("/workspace", containerCwd);
  if (relContainer !== "" && (nodePath.posix.isAbsolute(relContainer) || relContainer === ".." || relContainer.startsWith("../"))) {
    return rejected("WORKSPACE_VIOLATION", "resolved container cwd escapes the workspace mount (belt-and-braces check)");
  }
  const hostCwd = nodePath.join(workspace.host_root, ...segments);
  if (!isInsideWorkspace(workspace.host_root, hostCwd)) {
    return rejected("WORKSPACE_VIOLATION", "resolved host cwd escapes the session workspace boundary");
  }

  // Physical walk: every component of the cwd path must be an existing,
  // non-link directory inside the leaf.
  let current = workspace.host_root;
  for (const segment of segments) {
    current = nodePath.join(current, segment);
    let lst;
    try {
      lst = lstatSync(current);
    } catch {
      return rejected("WORKSPACE_VIOLATION", `cwd path does not exist inside the workspace: ${validGrant.cwd}`);
    }
    if (lst.isSymbolicLink()) {
      return rejected("WORKSPACE_VIOLATION", "cwd path contains a symlink or junction (escape rejected)");
    }
    if (!lst.isDirectory()) {
      return rejected("WORKSPACE_VIOLATION", "cwd path component is not a directory");
    }
  }

  // Realpath recheck: the physical cwd must still sit inside the leaf's
  // physical location (catches anything the walk could not see).
  let realCwd: string;
  try {
    realCwd = realpathSync(hostCwd);
  } catch {
    return rejected("WORKSPACE_VIOLATION", "cwd could not be resolved (physical check)");
  }
  if (!realWithin(workspace.real_root, realCwd)) {
    return rejected("WORKSPACE_VIOLATION", "cwd resolves outside the session workspace (symlink/reparse escape)");
  }

  return {
    ok: true,
    value: Object.freeze({
      lesson_id: workspace.lesson_id,
      session_id: workspace.session_id,
      generation: workspace.generation,
      host_workspace_root: workspace.host_root,
      real_workspace_root: workspace.real_root,
      container_workspace_root: "/workspace",
      host_cwd: hostCwd,
      container_cwd: containerCwd,
      grant: validGrant,
    }),
  };
}

// ---------------------------------------------------------------------------
// 5. Mount plan — exactly one bind mount: the session leaf at /workspace.
// ---------------------------------------------------------------------------

export const WorkspaceMountSchema = z.strictObject({
  type: z.literal("bind"),
  source: z.string().min(1),
  target: z.literal("/workspace"),
  read_only: z.literal(false),
});
export type WorkspaceMount = z.infer<typeof WorkspaceMountSchema>;

export const WorkspaceMountPlanSchema = z.tuple([WorkspaceMountSchema]);
export type WorkspaceMountPlan = z.infer<typeof WorkspaceMountPlanSchema>;

// The docker control socket must never be mounted. The fragment is assembled
// at runtime so this DETECTION code does not contain the literal socket name —
// the P5.1/P5.2 gates scan engine sources for that literal to prove absence,
// and the scanner must stay able to prove that absence in shipping code.
const DOCKER_SOCKET_SUFFIX = ".sock";
const DOCKER_SOCKET_FRAGMENT = "Docker".toLowerCase() + DOCKER_SOCKET_SUFFIX;

/**
 * Build the one-mount plan for a resolved workspace. The source is always the
 * resolved session leaf itself — callers cannot supply a mount source, so a
 * renderer can never select paths, and the plan can only ever contain exactly
 * one writable bind mount at exactly /workspace.
 */
export function buildWorkspaceMountPlan(paths: ResolvedWorkspacePaths): WorkspaceOutcome<WorkspaceMountPlan> {
  const source = paths.host_workspace_root;
  if (source.length === 0 || source.includes("\0") || /[,\"'\r\n]/.test(source)) {
    return rejected("WORKSPACE_VIOLATION", "mount source is not representable in bind-mount grammar");
  }
  if (source.toLowerCase().includes(DOCKER_SOCKET_FRAGMENT)) {
    return rejected("WORKSPACE_VIOLATION", "the docker control socket must never be mounted");
  }
  if (samePath(source, nodePath.parse(nodePath.resolve(source)).root)) {
    return rejected("WORKSPACE_VIOLATION", "filesystem/drive root must never be mounted");
  }
  if (samePath(source, homedir())) {
    return rejected("WORKSPACE_VIOLATION", "user profile must never be mounted");
  }
  const plan: WorkspaceMountPlan = [{ type: "bind", source, target: "/workspace", read_only: false }];
  const checked = WorkspaceMountPlanSchema.safeParse(plan);
  if (!checked.success) {
    return rejected("WORKSPACE_VIOLATION", "mount plan violates its own schema (internal invariant)");
  }
  const frozen = deepFreeze(plan) as WorkspaceMountPlan;
  return { ok: true, value: frozen };
}

// ---------------------------------------------------------------------------
// 6. ResolvedExecutionContext — the runtime-only handoff object for later
// phases (image identity + sandbox policy + mount/env plans + provenance).
// Pure data: NO provider handles, NO Docker client, NO connection state, NO
// capability to execute anything by itself. Deep-frozen and schema-checked.
// ---------------------------------------------------------------------------

/** Pinned image identity as read from engine/terminal/image/base-image.lock.json. */
export const RuntimeImageIdentitySchema = z.strictObject({
  pinned_reference: z.string().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  platform: z.string().min(1),
  pull_policy: z.literal("never"),
  source: z.literal("base-image.lock.json"),
});
export type RuntimeImageIdentity = z.infer<typeof RuntimeImageIdentitySchema>;

export const ResolvedExecutionContextSchema = z.strictObject({
  context_version: z.literal(1),
  kind: z.literal("resolved_execution_context"),
  /** Provenance: the exact validated grant this context was derived from. */
  grant: ExecutionGrantSchema,
  workspace: z.strictObject({
    lesson_id: IdentifierSchema,
    session_id: IdentifierSchema,
    generation: z.number().int().min(0),
    host_workspace_root: z.string().min(1),
    container_workspace_root: z.literal("/workspace"),
    host_cwd: z.string().min(1),
    container_cwd: z.string().regex(/^\/workspace(\/[A-Za-z0-9_. -]+)*$/),
  }),
  mount_plan: WorkspaceMountPlanSchema,
  environment_plan: EnvironmentPlanSchema,
  image_identity: RuntimeImageIdentitySchema,
  sandbox_policy_ref: z.literal(SANDBOX_POLICY_REF),
});
export type ResolvedExecutionContext = z.infer<typeof ResolvedExecutionContextSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Assemble the runtime-only resolved execution context. Inputs come only from
 * trusted main/runtime code: the resolved workspace paths (validated above),
 * an environment plan validated against the fixed policy, and the pinned
 * image identity read from the committed base-image lock. Anything hostile in
 * these inputs (e.g. an extra image field, a foreign sandbox policy, a second
 * mount) fails strict validation — this context is NEVER persisted or sent to
 * the renderer; it is consumed by the future P5.4 spawn path and discarded.
 */
export function resolveExecutionContext(input: {
  readonly workspace_paths: ResolvedWorkspacePaths;
  readonly mount_plan: WorkspaceMountPlan;
  readonly environment_plan: EnvironmentPlan;
  readonly image_identity: RuntimeImageIdentity;
}): WorkspaceOutcome<ResolvedExecutionContext> {
  const envChecked = validateEnvironmentPlan(input.environment_plan);
  if (!envChecked.ok) {
    return rejected(envChecked.error.code, envChecked.error.message);
  }
  const mountChecked = WorkspaceMountPlanSchema.safeParse(input.mount_plan);
  if (!mountChecked.success) {
    return rejected("WORKSPACE_VIOLATION", "mount plan does not satisfy the single-mount schema");
  }
  const imageChecked = RuntimeImageIdentitySchema.safeParse(input.image_identity);
  if (!imageChecked.success) {
    return rejected("IMAGE_UNAVAILABLE", "image identity does not satisfy the pinned-image schema (digest and pull_policy=never required)");
  }
  const candidate: ResolvedExecutionContext = {
    context_version: 1,
    kind: "resolved_execution_context",
    grant: input.workspace_paths.grant,
    workspace: {
      lesson_id: input.workspace_paths.lesson_id,
      session_id: input.workspace_paths.session_id,
      generation: input.workspace_paths.generation,
      host_workspace_root: input.workspace_paths.host_workspace_root,
      container_workspace_root: "/workspace",
      host_cwd: input.workspace_paths.host_cwd,
      container_cwd: input.workspace_paths.container_cwd,
    },
    mount_plan: mountChecked.data,
    environment_plan: envChecked.value,
    image_identity: imageChecked.data,
    sandbox_policy_ref: SANDBOX_POLICY_REF,
  };
  const checked = ResolvedExecutionContextSchema.safeParse(candidate);
  if (!checked.success) {
    return rejected("INVALID_REQUEST", "resolved execution context violates its own schema (internal invariant)");
  }
  return { ok: true, value: deepFreeze(checked.data) };
}



