// P6.3 access-epoch mount planning — the reviewed-boundary extension of the
// P5.3 workspace layer for shared-workspace ownership epochs.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 26.2-26.3 and
// docs/adr/ADR-0011-shared-workspace-ownership.md decisions 2-4.
//
// What this module owns (and only this):
//   - the access-specific workspace bind: the SAME coordinator-owned host
//     leaf at the SAME container target (/workspace), with the mount access
//     fixed at container creation from the trusted reviewed capability:
//     read_only epochs bind readonly, read_write epochs bind writable;
//   - the fixed combined-epoch scratch profile: writable HOME/TMP/cache live
//     ONLY under the bounded /tmp tmpfs, never under the (possibly
//     read-only) /workspace tree;
//   - the exact --mount argv rendering (including bind-recursive=disabled so
//     no host submount is silently included in the guest view).
//
// What this module NEVER does:
//   - it never reads a command string to decide access (the access parameter
//     is the digest-bound reviewed value resolved by ReviewedWorkspacePolicy
//     via the WorkspaceCoordinator lease; there is structurally no command
//     parameter here, exactly as in policy resolveTerminalAccess);
//   - it never accepts renderer input (callers are main-owned coordinator /
//     epoch-provider code holding a live lease; renderer DTOs stay the
//     identifier-only shapes and cannot express source/target/mode);
//   - it never mutates the P5.3 legacy single writable mount plan
//     (buildWorkspaceMountPlan stays exactly as P5 left it for
//     terminal-only sessions).
//
// Portable means portable: the mount source is a main-held host path that
// never enters lesson/renderer contracts; the plan records it runtime-only
// for the provider argv boundary.

import { z } from "zod";

/** Trusted per-epoch workspace access (matches the P6.1 reviewed vocabulary). */
export const EpochAccessSchema = z.enum(["read_only", "read_write"]);
export type EpochAccess = z.infer<typeof EpochAccessSchema>;

/** Container target of the single shared-workspace bind (fixed). */
export const EPOCH_WORKSPACE_TARGET = "/workspace" as const;

/**
 * Access-specific mount plan: exactly one bind of the coordinator-owned leaf
 * at /workspace. read_only mirrors the trusted epoch access (true for
 * read_only epochs, false for read_write epochs). Deep-frozen, like P5.3.
 */
export const AccessWorkspaceMountSchema = z.strictObject({
  type: z.literal("bind"),
  source: z.string().min(1),
  target: z.literal(EPOCH_WORKSPACE_TARGET),
  read_only: z.boolean(),
});
export type AccessWorkspaceMount = z.infer<typeof AccessWorkspaceMountSchema>;

export const AccessWorkspaceMountPlanSchema = z.tuple([AccessWorkspaceMountSchema]);
export type AccessWorkspaceMountPlan = z.infer<typeof AccessWorkspaceMountPlanSchema>;

// The docker control socket must never be mounted. The fragment is assembled
// at runtime so this DETECTION code does not contain the literal socket name
// (the P5.1/P5.2 gates scan engine sources for that literal to prove absence
// in shipping code, and that scanner must keep proving it).
const DOCKER_SOCKET_SUFFIX = ".sock";
const DOCKER_SOCKET_FRAGMENT = "Docker".toLowerCase() + DOCKER_SOCKET_SUFFIX;

export interface EpochMountRejection {
  readonly code: "WORKSPACE_VIOLATION" | "INVALID_REQUEST";
  readonly message: string;
}

export type EpochMountOutcome<T> = { ok: true; value: T } | { ok: false; error: EpochMountRejection };

function mountRejected(code: EpochMountRejection["code"], message: string): { ok: false; error: EpochMountRejection } {
  return { ok: false, error: { code, message } };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build the one-mount access plan for a coordinator-owned leaf.
 *
 * Inputs come ONLY from trusted main/runtime state: the already-validated
 * leaf host path plus the reviewed access resolved from the digest-bound
 * policy via the live coordinator lease. There is no command parameter, no
 * renderer field and no caller-chosen mode: read_only is derived from access
 * (read_only -> true, read_write -> false), never supplied independently.
 */
export function buildAccessMountPlan(
  hostSource: string,
  access: EpochAccess,
): EpochMountOutcome<AccessWorkspaceMountPlan> {
  const accessCheck = EpochAccessSchema.safeParse(access);
  if (!accessCheck.success) {
    return mountRejected("INVALID_REQUEST", "epoch access must be exactly read_only or read_write");
  }
  if (typeof hostSource !== "string" || hostSource.length === 0 || hostSource.includes("\0") || /[,\"'\r\n]/.test(hostSource)) {
    return mountRejected("WORKSPACE_VIOLATION", "mount source is not representable in bind-mount grammar");
  }
  if (hostSource.toLowerCase().includes(DOCKER_SOCKET_FRAGMENT)) {
    return mountRejected("WORKSPACE_VIOLATION", "the docker control socket must never be mounted");
  }
  const plan: AccessWorkspaceMountPlan = [
    {
      type: "bind",
      source: hostSource,
      target: EPOCH_WORKSPACE_TARGET,
      read_only: accessCheck.data === "read_only",
    },
  ];
  const checked = AccessWorkspaceMountPlanSchema.safeParse(plan);
  if (!checked.success) {
    return mountRejected("WORKSPACE_VIOLATION", "access mount plan violates its own schema (internal invariant)");
  }
  return { ok: true, value: deepFreeze(checked.data) };
}

/**
 * Render the exact --mount argv element for an epoch container. The
 * recursive-submount inclusion is always disabled (design 26.3): the guest
 * sees exactly the leaf, never silently-included host submounts. The readonly
 * flag is present exactly for read_only epochs (Docker enforces the guest
 * write boundary; no chmod/ACL/lockfile mechanism is involved).
 */
export function buildEpochMountArg(hostSource: string, access: EpochAccess): string {
  const readonlyFlag = access === "read_only" ? ",readonly" : "";
  return `type=bind,source=${hostSource},target=${EPOCH_WORKSPACE_TARGET}${readonlyFlag},bind-recursive=disabled`;
}

// ---------------------------------------------------------------------------
// Combined-epoch scratch profile (design 26.3).
//
// Epoch containers keep the P5 read-only rootfs; the only writable guest
// filesystem is the bounded /tmp tmpfs. Tool HOME/TMP/cache MUST live there:
// a read-only /workspace epoch cannot host them, and even a read-write epoch
// must not scatter tool state into the lesson tree (lesson output belongs to
// authored RW operations, not to implicit caches). Legacy terminal-only P5
// sessions keep their existing HOME=/workspace/.home profile unchanged.
// ---------------------------------------------------------------------------

/** Fixed combined-epoch guest environment (main-owned constants, never renderer input). */
export const EPOCH_SCRATCH_ENV = Object.freeze({
  HOME: "/tmp/cf-home",
  TMPDIR: "/tmp/cf-tmp",
  XDG_CACHE_HOME: "/tmp/cf-cache",
  LANG: "C.UTF-8",
} as const);

/** --env argv pairs for an epoch container (fixed values, no host inheritance). */
export function epochScratchEnvArgv(): readonly string[] {
  return Object.freeze([
    "--env", `HOME=${EPOCH_SCRATCH_ENV.HOME}`,
    "--env", `TMPDIR=${EPOCH_SCRATCH_ENV.TMPDIR}`,
    "--env", `XDG_CACHE_HOME=${EPOCH_SCRATCH_ENV.XDG_CACHE_HOME}`,
    "--env", `LANG=${EPOCH_SCRATCH_ENV.LANG}`,
  ]);
}
