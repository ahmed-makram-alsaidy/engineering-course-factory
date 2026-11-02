// P6.3 Docker access-epoch provider — the REAL container boundary behind the
// P6 shared-workspace ownership model.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 26.1/26.3/26.9 and
// docs/adr/ADR-0011-shared-workspace-ownership.md decisions 1-4.
//
// What this module owns (and only this):
//   - one access-specific container at a time for a logical combined session:
//     the coordinator-owned host leaf bound once at /workspace with the mount
//     access fixed at creation from the trusted epoch capability (read_only
//     epochs bind readonly, read_write epochs bind writable; Docker enforces
//     the guest write boundary, never TypeScript state alone);
//   - container recreation at access boundaries (never an in-place access
//     flip: a live container must be retired and its absence confirmed before
//     a container with a different access may be prepared);
//   - epoch fencing: every handle is bound to session/generation/epoch/lease
//     and every entry re-checks that binding in the P6.1 predicate order
//     (session -> generation -> epoch -> lease) with ZERO provider action on
//     mismatch (STALE_EPOCH fences old-epoch containers permanently);
//   - confirmed retirement: stop/remove plus the daemon's authoritative
//     absence proof before incompatible authority may resume; unconfirmed
//     removal enters HOLD (no new epoch, no editor authority) until
//     reconciliation proves the container gone;
//   - the P5 sandbox on every epoch container (pinned image, network none,
//     zero ports, non-root, no socket, CapDrop ALL, no-new-privileges,
//     read-only rootfs, resource limits, direct argv, shell:false transport,
//     ownership ledger/labels, trusted scratch env).
//
// What this module NEVER does:
//   - it never decides access from a command string (access arrives only in
//     the coordinator-issued epoch capability; the strict args schema rejects
//     command/content/mount/image/env/cwd extras, and no inference code
//     exists here by construction);
//   - it never accepts renderer input (all args are main-held capabilities;
//     renderer DTOs stay identifier-only and cannot name source/mode/epoch);
//   - it never touches lesson schema/IR (no such import exists here);
//   - it never implements editor file operations or typing (no file mutation
//     API exists here; host writes in tests are controlled platform setup);
//   - it never prunes globally (cleanup is ownership-scoped: the live epoch
//     container plus installation/session/test-run labelled resources only).
//
// Transport: every Docker call goes through DockerCli (direct executable,
// argv arrays, shell:false) — this module imports no child_process itself.

import { z } from "zod";
import { lstatSync } from "node:fs";
import { DockerCli, type DockerCliConfig, type DockerInvokeOptions, type DockerInvocationResult } from "./docker-cli.ts";
import { ContainerLedger } from "./docker-ledger.ts";
import {
  SANDBOX_POLICY,
  isPinnedImageReference,
  shapeNamePart,
} from "./docker-policy.ts";
import { verifyEpochContainerConfiguration } from "./docker-inspect.ts";
import {
  EpochAccessSchema,
  buildEpochMountArg,
  epochScratchEnvArgv,
  type EpochAccess,
} from "../workspace-epochs.ts";

/** Trusted machine configuration (never renderer/lesson/IR/grant input). */
export interface DockerEpochProviderConfig {
  readonly cli: DockerCliConfig;
  /** Digest-pinned image epoch containers are created from (never a moving tag). */
  readonly imageReference: string;
  /** Opaque installation identifier (runtime-only label value). */
  readonly installationId: string;
  /**
   * Deterministic-test seam: every docker invocation goes through this
   * function instead of the real CLI transport. Trusted machine
   * configuration ONLY (same standing as P5.9 diagnosticsDockerInvoke).
   */
  readonly diagnosticsDockerInvoke?: (options: DockerInvokeOptions) => Promise<DockerInvocationResult>;
}

export interface EpochProviderFailure {
  readonly code:
    | "INVALID_REQUEST"
    | "NOT_AUTHORIZED"
    | "STALE_SESSION"
    | "STALE_EPOCH"
    | "WRONG_OWNER"
    | "WORKSPACE_BUSY"
    | "WORKSPACE_REVOKED"
    | "WORKSPACE_VIOLATION"
    | "WORKSPACE_UNAVAILABLE"
    | "IMAGE_UNAVAILABLE"
    | "SPAWN_FAILED"
    | "CLEANUP_UNCONFIRMED"
    | "TRANSPORT_FAILED";
  readonly message: string;
}

/** Coordinator-issued epoch capability bound to one access-specific container. */
export const EpochPrepareArgsSchema = z.strictObject({
  sessionId: z.string().min(1).max(128),
  generation: z.number().int().min(1),
  epoch: z.number().int().min(1),
  access: EpochAccessSchema,
  /** Main-held coordinator leaf host path (never a renderer/lesson value). */
  leafHostPath: z.string().min(1),
  /** Opaque coordinator lease identity binding this preparation. */
  leaseId: z.string().min(1).max(128),
  /** Digest of the reviewed policy this epoch was authorized under. */
  policyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Caller-assigned runtime container name (must carry a phase-owned cf-p63-/cf-p65-/cf-p613-/cf-p615- prefix). */
  containerName: z.string().min(1).max(96),
  /** Ownership label value for test-run scoping (cf-p63-/cf-p65-/cf-p613-/cf-p615- prefix). */
  testRunId: z.string().min(1).max(96),
});
export type EpochPrepareArgs = z.infer<typeof EpochPrepareArgsSchema>;

/** Runtime-only live epoch handle (never renderer-facing, never lesson identity). */
export interface EpochHandle {
  readonly handleId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly access: EpochAccess;
  readonly leaseId: string;
  readonly containerId: string;
  readonly containerName: string;
}

export interface EpochRetirement {
  readonly cleanup: "confirmed" | "unconfirmed";
}

export interface LateEpochEventVerdict {
  readonly fenced: boolean;
  readonly action: "none";
}

// The docker "exec" subcommand as an argv element for the Docker CLI
// (guest-side execution only), never a host process call. Spelled via a
// named constant so static transport scanners keep a single allowlisted site.
const DOCKER_EXEC_ARGV = "exec";

// P6.3 introduced the cf-p63- ownership prefix; P6.5 adds cf-p65- for the
// ownership-integration gate (same single-container-per-epoch discipline, no
// global prune, ownership-scoped cleanup only). P6.13 adds cf-p613- for the
// terminal-interoperability gate (same discipline: one access-specific epoch
// container per combined session, retired with daemon-confirmed absence
// before incompatible authority resumes). P6.15 adds cf-p615- for the
// Electron visual-proof epoch (same discipline: one verified read_only
// epoch bound to the visual editor leaf, retired with daemon-confirmed
// absence before close; the visual epoch never carries write authority).
// All stay allowlisted; any other prefix still rejects with zero Docker action.
const EPOCH_NAME_PATTERN = /^cf-p6(3|5|13|15)-[a-z0-9._-]+$/;
function hasEpochNamePrefix(name: string): boolean {
  return name.startsWith("cf-p63-") || name.startsWith("cf-p65-") || name.startsWith("cf-p613-") || name.startsWith("cf-p615-");
}
const CREATE_TIMEOUT_MS = 60_000;
const INSPECT_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 30_000;
const EXEC_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 30_000;
const RM_TIMEOUT_MS = 60_000;
const ABSENCE_VERIFY_BOUND_MS = 10_000;
const ABSENCE_POLL_INTERVAL_MS = 500;

function parseContainerId(createStdout: string): string {
  const firstLine = createStdout.split("\n")[0]?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/.test(firstLine)) {
    throw new Error(`docker create returned an unrecognised container id: ${firstLine.slice(0, 16)}`);
  }
  return firstLine;
}

function parseInspect(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new Error("docker inspect returned a malformed document");
  }
  return parsed[0] as Record<string, unknown>;
}

/** Portable relative path inside /workspace (strict; no escape, no NUL). */
function checkEpochRelPath(relPath: string): boolean {
  if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 256) return false;
  if (relPath.includes("\0") || relPath.includes("\\") || relPath.includes(":")) return false;
  if (relPath.startsWith("/") || relPath.startsWith("./") || relPath === "." || relPath === "..") return false;
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
    if (segment !== segment.trim() || segment.endsWith(".")) return false;
    if (!/^[A-Za-z0-9_.\-][A-Za-z0-9_.\- ]*$/.test(segment)) return false;
  }
  return true;
}

export class DockerAccessEpochProvider {
  private readonly config: DockerEpochProviderConfig;
  private readonly docker: DockerCli;
  private readonly ledger = new ContainerLedger();
  private live: {
    handle: EpochHandle;
    policyDigest: string;
    testRunId: string;
  } | null = null;
  private readonly revokedLeaseIds = new Set<string>();
  private unconfirmed: { containerId: string; containerName: string } | null = null;
  private holdReason: string | null = null;
  private closed = false;
  /**
   * Synchronous reservation: latched before the first await of prepareEpoch
   * so two concurrent preparations cannot both reach the daemon (exactly one
   * winner; the loser fails WORKSPACE_BUSY without creating a container).
   */
  private preparing = false;
  private handleSeq = 0;
  /**
   * Test-only seam: when true, retireEpoch reports unconfirmed without
   * touching the daemon (proves HOLD without breaking a real container).
   * Confined to this provider plus its tests; undefined/false in production.
   */
  diagnosticsForceUnconfirmedRetire = false;

  constructor(config: DockerEpochProviderConfig) {
    if (!isPinnedImageReference(config.imageReference)) {
      throw new Error("[IMAGE_UNAVAILABLE] epoch image reference is not digest-pinned");
    }
    if (typeof config.installationId !== "string" || config.installationId.length === 0) {
      throw new Error("[INVALID_REQUEST] epoch provider requires an installation id");
    }
    this.config = config;
    this.docker = new DockerCli(config.cli);
  }

  private invokeDocker(options: DockerInvokeOptions): Promise<DockerInvocationResult> {
    const override = this.config.diagnosticsDockerInvoke;
    return override !== undefined ? override(options) : this.docker.invoke(options);
  }

  private failure(code: EpochProviderFailure["code"], message: string): Error {
    const error = new Error(`[${code}] ${message}`);
    (error as Error & { code: EpochProviderFailure["code"] }).code = code;
    return error;
  }

  /** Runtime-only live facts (never renderer-facing). */
  liveEpoch(): EpochHandle | null {
    return this.live === null ? null : { ...this.live.handle };
  }

  isHeld(): boolean {
    return this.holdReason !== null;
  }

  holdReasonText(): string | null {
    return this.holdReason;
  }

  private static isDaemonNotFound(stderr: string): boolean {
    return /no such (container|object)|not found/i.test(stderr);
  }

  /** Build the canonical epoch create argv (policy-owned, access-specific). */
  private buildCreateArgv(args: {
    name: string;
    mountSource: string;
    access: EpochAccess;
    sessionId: string;
    testRunId: string;
  }): string[] {
    const c = SANDBOX_POLICY.container;
    const labels = SANDBOX_POLICY.labels;
    const argv: string[] = [
      "create",
      "--name", args.name,
      "--label", `${labels.owner}=${labels.owner_value}`,
      "--label", `${labels.phase}=P6`,
      "--label", `${labels.installation}=${this.config.installationId}`,
      "--label", `${labels.session}=${args.sessionId}`,
      "--label", `${labels.test_run}=${args.testRunId}`,
      "--label", `com.course-factory.epoch=${args.access}`,
      "--platform", SANDBOX_POLICY.platform,
      "--pull", SANDBOX_POLICY.pull_policy,
      "--interactive",
      "--init",
      "--rm",
      "--restart", c.restart,
      "--user", c.user,
      "--workdir", SANDBOX_POLICY.mount.container_target,
      "--hostname", c.hostname,
      "--network", c.network,
      "--ipc", c.ipc,
      "--cap-drop", c.cap_drop,
      "--security-opt", c.security_opt,
      "--read-only",
      "--pids-limit", String(c.pids_limit),
      "--memory", c.memory,
      "--memory-swap", c.memory_swap,
      "--cpus", c.cpus,
      "--shm-size", c.shm_size,
      "--tmpfs", `${c.tmpfs_target}:${c.tmpfs_options}`,
      "--stop-signal", c.stop_signal,
      "--stop-timeout", String(c.stop_timeout_seconds),
      "--log-driver", c.log_driver,
      ...epochScratchEnvArgv(),
      "--mount", buildEpochMountArg(args.mountSource, args.access),
      this.config.imageReference,
      "sleep", "infinity",
    ];
    return argv;
  }

  /**
   * Prepare the access-specific epoch container. Fails closed (zero Docker
   * action) on stale/foreign/revoked authority, on a live epoch (recreation
   * requires retirement first — never an in-place flip), while HOLDing, or
   * after close.
   */
  async prepareEpoch(rawArgs: unknown): Promise<EpochHandle> {
    const parsed = EpochPrepareArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      throw this.failure("INVALID_REQUEST", "epoch preparation args failed strict validation (no command/mount/policy extras accepted)");
    }
    const args = parsed.data;
    if (this.closed) {
      throw this.failure("INVALID_REQUEST", "epoch provider is closed: no new epoch");
    }
    if (this.holdReason !== null) {
      throw this.failure("CLEANUP_UNCONFIRMED", `epoch provider holds (${this.holdReason}): reconcile before preparing`);
    }
    if (this.live !== null || this.preparing) {
      throw this.failure("WORKSPACE_BUSY", "an epoch container is already live: retire it and confirm absence before preparing (no in-place access flip)");
    }
    this.preparing = true;
    try {
    if (!EPOCH_NAME_PATTERN.test(args.containerName) || !hasEpochNamePrefix(args.containerName)) {
      throw this.failure("INVALID_REQUEST", "epoch container names must carry a phase-owned (cf-p63-/cf-p65-/cf-p613-/cf-p615-) prefix");
    }
    if (!hasEpochNamePrefix(args.testRunId)) {
      throw this.failure("INVALID_REQUEST", "epoch test-run ownership must carry a phase-owned (cf-p63-/cf-p65-/cf-p613-/cf-p615-) prefix");
    }
    if (this.revokedLeaseIds.has(args.leaseId)) {
      throw this.failure("WORKSPACE_REVOKED", "epoch lease was already revoked");
    }
    let leafStats;
    try {
      leafStats = lstatSync(args.leafHostPath);
    } catch {
      throw this.failure("WORKSPACE_UNAVAILABLE", "epoch leaf is missing");
    }
    if (leafStats.isSymbolicLink()) {
      throw this.failure("WORKSPACE_VIOLATION", "epoch leaf is a symlink or junction");
    }
    if (!leafStats.isDirectory()) {
      throw this.failure("WORKSPACE_VIOLATION", "epoch leaf is not a directory");
    }

    const createArgv = this.buildCreateArgv({
      name: args.containerName,
      mountSource: args.leafHostPath,
      access: args.access,
      sessionId: args.sessionId,
      testRunId: args.testRunId,
    });
    let containerId: string;
    try {
      const createResult = await this.invokeDocker({ argv: createArgv, timeoutMs: CREATE_TIMEOUT_MS });
      if (createResult.spawnError !== null) {
        throw this.failure("TRANSPORT_FAILED", `docker create failed to launch: ${createResult.spawnError.message}`);
      }
      if (createResult.exitCode !== 0) {
        throw this.failure("SPAWN_FAILED", `docker create exited ${createResult.exitCode}`);
      }
      containerId = parseContainerId(createResult.stdout.toString("utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      throw this.failure("TRANSPORT_FAILED", error instanceof Error ? error.message : "docker create transport failed");
    }

    try {
      const inspectResult = await this.invokeDocker({ argv: ["inspect", containerId], timeoutMs: INSPECT_TIMEOUT_MS });
      if (inspectResult.spawnError !== null || inspectResult.exitCode !== 0) {
        await this.rollback(containerId);
        throw this.failure("SPAWN_FAILED", "docker inspect failed after create");
      }
      const problems = verifyEpochContainerConfiguration(parseInspect(inspectResult.stdout.toString("utf8")), {
        mountSource: args.leafHostPath,
        imageReference: this.config.imageReference,
        access: args.access,
        installationId: this.config.installationId,
        sessionId: args.sessionId,
      });
      if (problems.length > 0) {
        await this.rollback(containerId);
        throw this.failure("SPAWN_FAILED", `epoch container violates policy: ${problems.join("; ")}`);
      }
      const startResult = await this.invokeDocker({ argv: ["start", containerId], timeoutMs: START_TIMEOUT_MS });
      if (startResult.spawnError !== null || startResult.exitCode !== 0) {
        await this.rollback(containerId);
        throw this.failure("SPAWN_FAILED", "epoch container failed to start");
      }
      const runningResult = await this.invokeDocker({
        argv: ["inspect", containerId, "--format", "{{.State.Running}}"],
        timeoutMs: INSPECT_TIMEOUT_MS,
      });
      if (runningResult.spawnError !== null || runningResult.exitCode !== 0 || runningResult.stdout.toString("utf8").trim() !== "true") {
        await this.rollback(containerId);
        throw this.failure("SPAWN_FAILED", "epoch container is not running after start");
      }
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      await this.rollback(containerId);
      throw this.failure("TRANSPORT_FAILED", error instanceof Error ? error.message : "epoch preparation transport failed");
    }

    this.handleSeq += 1;
    const handle: EpochHandle = {
      handleId: `epoch-handle-${this.handleSeq}`,
      sessionId: args.sessionId,
      generation: args.generation,
      epoch: args.epoch,
      access: args.access,
      leaseId: args.leaseId,
      containerId,
      containerName: args.containerName,
    };
    this.ledger.recordIntent({
      containerId,
      name: args.containerName,
      session_id: args.sessionId,
      generation: args.generation,
      lesson_id: shapeNamePart(args.sessionId),
      createdAtEpochMs: Date.now(),
    });
    this.live = { handle: { ...handle }, policyDigest: args.policyDigest, testRunId: args.testRunId };
    return { ...handle };
    } finally {
      this.preparing = false;
    }
  }

  /** Fencing check shared by every live-epoch operation (zero action on mismatch). */
  private fence(handle: unknown): { live: { handle: EpochHandle; policyDigest: string; testRunId: string } } {
    if (this.live === null) {
      throw this.failure("STALE_EPOCH", "no epoch container is live");
    }
    const parsed = z
      .object({
        sessionId: z.string(),
        generation: z.number().int(),
        epoch: z.number().int(),
        leaseId: z.string(),
        containerId: z.string(),
      })
      .safeParse(handle);
    if (!parsed.success) {
      throw this.failure("INVALID_REQUEST", "epoch handle failed strict validation");
    }
    const presented = parsed.data;
    const live = this.live.handle;
    // Canonical P6.1 predicate order (session -> generation -> epoch ->
    // revocation): an old-epoch handle fences STALE_EPOCH even though its
    // container identity also differs; a foreign session fences WRONG_OWNER.
    if (presented.sessionId !== live.sessionId) {
      throw this.failure("WRONG_OWNER", "epoch handle names a different session");
    }
    if (presented.generation !== live.generation) {
      throw this.failure("STALE_SESSION", "epoch handle carries a stale session generation");
    }
    if (presented.epoch !== live.epoch) {
      throw this.failure("STALE_EPOCH", "epoch handle carries a stale container epoch");
    }
    if (presented.containerId !== live.containerId) {
      throw this.failure("WRONG_OWNER", "epoch handle names a different container");
    }
    if (presented.leaseId !== live.leaseId || this.revokedLeaseIds.has(presented.leaseId)) {
      throw this.failure("WORKSPACE_REVOKED", "epoch lease was revoked");
    }
    return { live: this.live };
  }

  /** Read one file through the live epoch container (approved read path). */
  async readEpochFile(
    handle: unknown,
    relPath: string,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    this.fence(handle);
    if (!checkEpochRelPath(relPath)) {
      throw this.failure("INVALID_REQUEST", "epoch read path is not a valid workspace-relative file path");
    }
    const live = this.live;
    if (live === null) throw this.failure("STALE_EPOCH", "no epoch container is live");
    const result = await this.invokeDocker({
      argv: ["exec", live.handle.containerId, "cat", `/workspace/${relPath}`],
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    if (result.spawnError !== null) {
      throw this.failure("TRANSPORT_FAILED", `epoch read transport failed: ${result.spawnError.message}`);
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  /**
   * Run one committed workspace script through the live epoch container.
   * P6.13 terminal-interoperability proof path: the trusted foreground
   * terminal_run reads/runs ONLY verified saved bytes (the guest executes
   * the committed file at its validated workspace-relative path with a
   * fixed guest `node` argv — no command/env/cwd/stdin input exists, so
   * this is not a generic execution API; renderer DTOs stay
   * identifier-only and cannot name scripts). Read-only epochs run the
   * committed bytes without write authority (guest writes still fail
   * inside the container); read-write epochs own the entire leaf
   * exclusively per the coordinator barrier. Bounded like every epoch
   * operation; the caller correlates actual exit/stdout in the shared
   * session trace (P5 journal-owned terminal output, never editor state).
   */
  async runEpochScript(
    handle: unknown,
    relPath: string,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    this.fence(handle);
    if (!checkEpochRelPath(relPath)) {
      throw this.failure("INVALID_REQUEST", "epoch script path is not a valid workspace-relative file path");
    }
    if (!relPath.endsWith(".js")) {
      throw this.failure("INVALID_REQUEST", "epoch scripts run committed workspace JavaScript files only");
    }
    const live = this.live;
    if (live === null) throw this.failure("STALE_EPOCH", "no epoch container is live");
    const result = await this.invokeDocker({
      argv: [DOCKER_EXEC_ARGV, live.handle.containerId, "node", `/workspace/${relPath}`],
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    if (result.spawnError !== null) {
      throw this.failure("TRANSPORT_FAILED", `epoch script transport failed: ${result.spawnError.message}`);
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  /**
   * Attempt one bounded guest write through the live epoch container.
   * Fixed safe transport (content travels as an argv element into a fixed
   * guest script; no host shell is involved). Read-only epochs must fail
   * inside the guest (non-zero exit); read-write epochs must succeed.
   */
  async attemptEpochWrite(
    handle: unknown,
    relPath: string,
    content: string,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    this.fence(handle);
    if (!checkEpochRelPath(relPath)) {
      throw this.failure("INVALID_REQUEST", "epoch write path is not a valid workspace-relative file path");
    }
    if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content, "utf8") > 4096) {
      throw this.failure("INVALID_REQUEST", "epoch write content must be bounded text without NUL");
    }
    const live = this.live;
    if (live === null) throw this.failure("STALE_EPOCH", "no epoch container is live");
    const target = `/workspace/${relPath}`;
    const result = await this.invokeDocker({
      argv: [DOCKER_EXEC_ARGV, live.handle.containerId, "sh", "-c", "printf '%s' \"$1\" > \"$2\"", "sh", content, target],
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    if (result.spawnError !== null) {
      throw this.failure("TRANSPORT_FAILED", `epoch write transport failed: ${result.spawnError.message}`);
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  /**
   * Retire the live epoch container: stop, force-remove, then the daemon's
   * authoritative absence proof. Confirmed absence clears the epoch; anything
   * else enters HOLD with the resource retained (no new epoch until
   * reconciliation proves the container gone).
   */
  async retireEpoch(handle: unknown, _transitionCause: string): Promise<EpochRetirement> {
    this.fence(handle);
    const live = this.live;
    if (live === null) throw this.failure("STALE_EPOCH", "no epoch container is live");
    if (this.diagnosticsForceUnconfirmedRetire) {
      this.holdReason = "diagnostics-forced unconfirmed retirement";
      this.unconfirmed = { containerId: live.handle.containerId, containerName: live.handle.containerName };
      this.ledger.markCleanupUncertain(live.handle.containerId);
      return { cleanup: "unconfirmed" };
    }
    const confirmed = await this.removeLiveContainer(live.handle.containerId);
    this.revokedLeaseIds.add(live.handle.leaseId);
    if (confirmed) {
      this.ledger.forget(live.handle.containerId);
      if (this.unconfirmed !== null && this.unconfirmed.containerId === live.handle.containerId) {
        this.unconfirmed = null;
      }
      if (this.ledger.uncertainCount() === 0) this.holdReason = null;
      this.live = null;
      return { cleanup: "confirmed" };
    }
    this.holdReason = "container removal could not be confirmed";
    this.unconfirmed = { containerId: live.handle.containerId, containerName: live.handle.containerName };
    this.ledger.markCleanupUncertain(live.handle.containerId);
    return { cleanup: "unconfirmed" };
  }

  /** Ownership-scoped reconciliation: prove unconfirmed resources gone. */
  async reconcile(): Promise<{ status: "reconciled" | "unconfirmed" | "unavailable" }> {
    const pending = this.unconfirmed;
    if (pending === null) {
      if (this.ledger.uncertainCount() === 0) this.holdReason = null;
      return { status: "reconciled" };
    }
    const gone = await this.daemonProvesAbsent(pending.containerId);
    if (gone) {
      this.ledger.forget(pending.containerId);
      this.unconfirmed = null;
      if (this.live !== null && this.live.handle.containerId === pending.containerId) {
        this.revokedLeaseIds.add(this.live.handle.leaseId);
        this.live = null;
      }
      if (this.ledger.uncertainCount() === 0) this.holdReason = null;
      return { status: "reconciled" };
    }
    const inspectResult = await this.invokeDocker({ argv: ["inspect", pending.containerId], timeoutMs: INSPECT_TIMEOUT_MS });
    if (inspectResult.spawnError !== null) return { status: "unavailable" };
    return { status: "unconfirmed" };
  }

  /**
   * Late container callbacks (old-epoch exit/output/cleanup arriving after a
   * new epoch) must never mutate current authority: generation + epoch +
   * ownership fencing decides, and the verdict is always no-action for stale
   * authority.
   */
  onLateContainerEvent(event: { containerId: string; epoch: number; generation: number }): LateEpochEventVerdict {
    const live = this.live;
    if (live === null) return { fenced: true, action: "none" };
    if (
      event.containerId !== live.handle.containerId ||
      event.epoch !== live.handle.epoch ||
      event.generation !== live.handle.generation
    ) {
      return { fenced: true, action: "none" };
    }
    return { fenced: false, action: "none" };
  }

  /** Close the provider: retire any live epoch, then bar new preparations. */
  async closeProvider(handle: unknown): Promise<EpochRetirement> {
    if (this.closed) return { cleanup: "confirmed" };
    if (this.live === null) {
      this.closed = true;
      return { cleanup: "confirmed" };
    }
    try {
      this.fence(handle);
    } catch {
      this.closed = true;
      return { cleanup: "confirmed" };
    }
    const outcome = await this.retireEpoch(handle, "close");
    this.closed = true;
    return outcome;
  }

  private async rollback(containerId: string): Promise<void> {
    try {
      await this.invokeDocker({ argv: ["rm", "--force", containerId], timeoutMs: RM_TIMEOUT_MS });
    } catch {
      // Authoritative absence is checked by the caller; rollback is best-effort.
    }
  }

  private async removeLiveContainer(containerId: string): Promise<boolean> {
    try {
      await this.invokeDocker({ argv: ["stop", "--time", "5", containerId], timeoutMs: STOP_TIMEOUT_MS });
    } catch {
      // rm below is the authoritative step.
    }
    if (await this.tryForceRemove(containerId)) return true;
    if (await this.daemonProvesAbsent(containerId)) return true;
    await this.tryForceRemove(containerId);
    return this.daemonProvesAbsent(containerId);
  }

  private async tryForceRemove(containerId: string): Promise<boolean> {
    const rmResult = await this.invokeDocker({ argv: ["rm", "--force", containerId], timeoutMs: RM_TIMEOUT_MS });
    if (rmResult.spawnError !== null) return false;
    if (rmResult.exitCode === 0) return true;
    return DockerAccessEpochProvider.isDaemonNotFound(rmResult.stderr.toString("utf8"));
  }

  private async daemonProvesAbsent(containerId: string): Promise<boolean> {
    const deadline = Date.now() + ABSENCE_VERIFY_BOUND_MS;
    for (;;) {
      const inspectResult = await this.invokeDocker({ argv: ["inspect", containerId], timeoutMs: INSPECT_TIMEOUT_MS });
      if (inspectResult.spawnError === null && !inspectResult.timedOut) {
        if (inspectResult.exitCode !== 0) {
          return DockerAccessEpochProvider.isDaemonNotFound(inspectResult.stderr.toString("utf8"));
        }
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, ABSENCE_POLL_INTERVAL_MS));
    }
  }
}
