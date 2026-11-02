// P5.4 Docker sandbox policy — the canonical, provider-owned runtime policy
// for session containers (docs/P5-DESIGN-SPEC.md, "DockerSandboxProvider",
// "Container Security Policy", "Runtime Image Strategy"). Pure constants and
// pure helpers; no I/O, no process access.
//
// These values are TRUSTED PROVIDER POLICY. The renderer, lesson source,
// compiled IR and ExecutionGrant cannot override them: a renderer request has
// no field that could carry any of them, the grant schema has no docker/shape
// fields, and the provider re-validates everything it consumes (see docker.ts).
// The only runtime input is the trusted machine config supplying the
// executable/context/private-config directory and the digest-pinned runtime
// image reference.
//
// Canonical values (design task table P5.4 "container lifecycle":
// create/inspect/attach/frames/rollback; P5.0 probe). All sandbox mechanics
// live here once, so no literal is duplicated across modules.

/** Canonical provider policy (one module of truth). */
export const SANDBOX_POLICY = Object.freeze({
  /** Docker platform requested for every session container (design: linux/amd64). */
  platform: "linux/amd64",
  /** Pull policy for every container: never — missing images fail closed. */
  pull_policy: "never",
  /** Container control-plane flags (docker create options). */
  container: Object.freeze({
    /** Non-root guest uid:gid (official node image user, probe-verified in P5.0). */
    user: "1000:1000",
    /** Deterministic guest hostname (machine-independent). */
    hostname: "cf-runtime",
    /** Outer network: none (no NAT, no published ports — P7 owns browser). */
    network: "none",
    /** Private IPC namespace (design: no default IPC in guest). */
    ipc: "private",
    /** Drop ALL capabilities. */
    cap_drop: "ALL",
    /** No privilege escalation. */
    security_opt: "no-new-privileges=true",
    /** Read-only root filesystem. */
    read_only: true,
    /** docker-init as pid 1 (supervisor runs as its child). */
    init: true,
    /** Never restart. */
    restart: "no",
    /** Process ceiling (design 128). */
    pids_limit: 128,
    /** Memory/swap limits. */
    memory: "512m",
    memory_swap: "512m",
    /** CPU cap. */
    cpus: "1.0",
    /** /dev/shm size. */
    shm_size: "16m",
    /** Bounded private /tmp tmpfs. */
    tmpfs_target: "/tmp",
    tmpfs_options: "rw,noexec,nosuid,nodev,size=67108864,mode=1777",
    /** Graceful stop first. */
    stop_signal: "SIGTERM",
    /** Bounded stop grace; container teardown is authoritative cleanup. */
    stop_timeout_seconds: 5,
    /** No engine logging for session containers. */
    log_driver: "none",
  }),
  /** The single writable workspace bind (design: "exactly one writable bind"). */
  mount: Object.freeze({ container_target: "/workspace" }),
  /** Guest command interpreter (design §7 - `/bin/sh -c` form, guest-side only). */
  guest: Object.freeze({
    shell: "/bin/sh",
    /** `-c` final-command form (no login profile, per design). */
    shell_run_flag: "-c",
  }),
  /** Canonical labels for ownership + cleanup/reconciliation (never prune). */
  labels: Object.freeze({
    owner: "com.course-factory.owner",
    owner_value: "terminal-engine",
    phase: "com.course-factory.phase",
    phase_value: "P5",
    installation: "com.course-factory.installation",
    session: "com.course-factory.session",
    test_run: "com.course-factory.test-run",
  }),
  /** Runtime-only container names (never canonical lesson identity). */
  naming: Object.freeze({
    prefix: "cf",
    separator: "-",
    max_name_bytes: 96,
  }),
  /** Numeric resource byte limits (one place; used by inspect checks). */
  bytes: Object.freeze({
    memory: 512 * 1024 * 1024,
    memory_swap: 512 * 1024 * 1024,
    shm_size: 16 * 1024 * 1024,
    tmpfs_size: 64 * 1024 * 1024,
    nano_cpus: 1_000_000_000,
  }),
});

/** A container name part may only contain [a-z0-9._-] after sanitization. */
export const SAFE_NAME_PART_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Sanitize one identifier so it can be embedded in a runtime container name.
 * Lowercases, replaces unsafe runs, trims separators, and bounds length. The
 * result is runtime-only (never canonical lesson identity).
 */
export function shapeNamePart(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, SANDBOX_POLICY.naming.max_name_bytes);
}

/** Build the runtime-only container name: cf-<lesson-part>-<runtime-part>. */
export function buildContainerName(lessonId: string, runtimeToken: string): string {
  const lessonPart = shapeNamePart(lessonId);
  const runPart = shapeNamePart(runtimeToken);
  const name = `${SANDBOX_POLICY.naming.prefix}${SANDBOX_POLICY.naming.separator}${lessonPart}${SANDBOX_POLICY.naming.separator}${runPart}`;
  if (!SAFE_NAME_PART_PATTERN.test(lessonPart) || !SAFE_NAME_PART_PATTERN.test(runPart)) {
    throw new Error("container name part failed shape validation");
  }
  return name.slice(0, SANDBOX_POLICY.naming.max_name_bytes);
}

/**
 * A trusted runtime image reference MUST already embed the sha256 digest
 * (never a bare moving tag). Accepted forms:
 *   - `name@sha256:<hex>`  (digest reference)
 *   - `sha256:<hex>`       (content-addressed reference)
 * Bare tags (`node:24`, `cf-terminal-engine-runtime:latest`) are rejected.
 */
export const DOCKER_IMAGE_REFERENCE_PATTERN = /^(?:[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@)?sha256:[0-9a-f]{64}$/;
export function isPinnedImageReference(reference: string | null | undefined): boolean {
  return typeof reference === "string" && reference.length > 0 && DOCKER_IMAGE_REFERENCE_PATTERN.test(reference);
}

/**
 * P7.2 / P8.9 reviewed bridge policy for dev-server container execution.
 * Standard P5 workloads stay --network none with zero published ports.
 * Opt-in container bridge is strictly bound to loopback 127.0.0.1, denies
 * container-to-container communication (icc=false), denies external masquerade
 * (ip_masquerade=false), and forces guest DNS to 127.0.0.1 to block WAN egress.
 */
export const SANDBOX_BRIDGE_POLICY = Object.freeze({
  icc: "false",
  ip_masquerade: "false",
  dns: "127.0.0.1",
  loopback_bind_ip: "127.0.0.1",
  prefix: "cf-bridge",
  max_network_name_bytes: 64,
});

/** Build the runtime-only isolated bridge network name: cf-bridge-<session-part>. */
export function buildBridgeNetworkName(sessionId: string): string {
  const sessionPart = shapeNamePart(sessionId);
  if (!SAFE_NAME_PART_PATTERN.test(sessionPart)) {
    throw new Error("bridge network name part failed shape validation");
  }
  return `${SANDBOX_BRIDGE_POLICY.prefix}-${sessionPart}`.slice(0, SANDBOX_BRIDGE_POLICY.max_network_name_bytes);
}

/**
 * Host path fragments that must never appear as the single mounted workspace
 * source (Docker socket, Desktop/Documents/AppData, drive roots are handled
 * separately via the mounted-path containment checks in docker.ts — the
 * provider only accepts the trusted P5.3 leaf).
 */
export const FORBIDDEN_MOUNT_SOURCE_FRAGMENTS = Object.freeze([
  "\docker.sock",
  "/docker.sock",
  "\Desktop",
  "/Desktop",
  "\Documents",
  "/Documents",
  "\AppData",
  "/AppData",
] as readonly string[]);
