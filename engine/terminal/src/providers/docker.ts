// P5.4/P5.5 DockerSandboxProvider — the concrete ExecutionProvider behind the
// abstract ExecutionProvider seam (docs/P5-DESIGN-SPEC.md, "DockerSandboxProvider";
// tasks P5.4 "Argv create/inspect/attach/frames/rollback" and P5.5
// "Registry/groups"). This is the only P5 product module allowed to invoke
// Docker and to own the trusted supervisor control channel.
//
// Trust boundaries — the provider consumes ONLY:
//   - a trusted AdmittedSession carrying a trusted ResolvedExecutionContext
//     (exact grant + workspace + mount + environment + image) and the frozen
//     admitted grant map, and
//   - trusted machine configuration (Docker executable / context / private
//     config dir / runtime image reference).
// It NEVER accepts arbitrary renderer command strings: every command that
// runs comes byte-for-byte from a granted operation, and it runs only inside
// the session container, interpreted only by the guest.
//
// P5.5 additions (process ownership / background execution):
//   - background starts go through the guest supervisor's controlled process
//     groups (start_process frame). The start is considered STARTED only on
//     the authoritative guest process_started acknowledgment; the registry
//     claims RUNNING at that same acknowledgment and never earlier.
//   - logical process ownership: the registry (src/registry.ts) owns the
//     lifecycle of every managed background process; duplicate starts reject
//     DUPLICATE_START atomically (reserve before awaits); exited tombstones
//     keep ownership for the generation.
//   - OS PID/PGID arrive only in the supervisor's private frames and are
//     stored runtime-only; they never appear in events or results.
//   - stop: SIGINT to the guest process group (design "Stop / Cleanup"), 2 s
//     grace, SIGKILL fallback, 3 s death/drain verification, all applied
//     guest-side; the host awaits the bounded confirmation and tears the
//     container down when a group's death cannot be confirmed.
//   - lease/heartbeat: the host renews the guest 15 s lease with 2 s
//     heartbeat frames; an independent watchdog fails the session on 15 s of
//     guest silence. Container teardown remains the final cleanup authority.
//   - natural background exit is canonical BACKGROUND_EXITED_EARLY: the
//     registry transitions to EXITED with the true code, the session fails
//     and closes (design: "early natural exit including 0 fails/closes
//     session, historical STARTED retained"). No restart policy exists.
//
// P5.7 foreground execution (canonical task "Foreground"): foreground
// operations run through the SAME controlled guest process groups (one
// attached supervisor connection; the docker-exec probe of P5.4 is
// superseded). The ForegroundRun state machine (src/foreground.ts) owns the
// canonical completion semantics:
//   - the ACTUAL exit code is the guest's true process_exit code, preserved
//     separately from the grant's trusted EXPECTED exit code (PASS is exactly
//     actual === expected — actual 7 / expected 7 PASSes, actual 7 /
//     expected 0 FAILs with the true code);
//   - the deadline is armed host-side (main/runtime-owned; renderer/guest
//     cannot set or override it) only after the authoritative start ack;
//     "exit observed before deadline wins; at/after TIMEOUT", and no exit
//     code is ever invented for a deadline/signal termination;
//   - a canonical bounded drain window separates the guest's terminal frame
//     from the terminal event + final result, so all in-flight output is
//     journaled first (output -> drain -> terminal event -> final result);
//   - foreground completion requires the WHOLE guest group to be gone: the
//     supervisor verifies/kills residual descendants and classifies them
//     (process_failed UNEXPECTED_DESCENDANTS -> FAIL + full teardown); an
//     operation never PASSes while owned descendants remain;
//   - cancellation targets the trusted operation identity only (no arbitrary
//     PID, no renderer signal selection) and ends SKIPPED/CANCELLED;
//   - failure distinctions follow the canonical taxonomy (exit mismatch /
//     transport / supervisor / deadline / sandbox-gone), never flattened.

import {
  type Disposable,
  type ExecutionProvider,
  type ProviderEvent,
  type ProviderSession,
  type StartReceipt,
  type StopResult,
  type AdmittedSession,
  type CleanupResult,
  type SessionBridgeOptions,
} from "./execution-provider.ts";
import {
  RUNTIME_EVENT_VERSION,
  type CloseCause,
  type Identifier,
  type OperationResult,
  type RuntimeErrorCode,
  type StopCause,
} from "../protocol.ts";
import type { ExecutionGrant } from "../admission.ts";
import { ExecutionGrantSchema } from "../admission.ts";
import { ADMISSION_POLICY, EXECUTION_POLICY, FOREGROUND_POLICY } from "../policy.ts";
import { ForegroundRun, type ForegroundRunCallbacks } from "../foreground.ts";
import { BackgroundRun } from "../background.ts";
import { ProcessRegistry, type RegistryEntry } from "../registry.ts";
import type { ResolvedExecutionContext } from "../workspace.ts";
import { resolveAuthoredCwdSegments } from "../workspace.ts";
import { validateEnvironmentPlan } from "../environment.ts";
import {
  SANDBOX_POLICY,
  SANDBOX_BRIDGE_POLICY,
  buildContainerName,
  isPinnedImageReference,
  shapeNamePart,
  FORBIDDEN_MOUNT_SOURCE_FRAGMENTS,
} from "./docker-policy.ts";
import { DockerCli, type DockerCliConfig, type DockerInvokeOptions, type DockerInvocationResult, type DockerSpawnHandle } from "./docker-cli.ts";
import { ContainerLedger } from "./docker-ledger.ts";
import { verifyContainerConfiguration } from "./docker-inspect.ts";
import {
  GuestFrameSchema,
  HelloFrameSchema,
  InitFrameSchema,
  InitAckFrameSchema,
  SUPERVISOR_FRAME_LIMITS,
  SUPERVISOR_TIMING,
  type GuestFrame,
  type HelloFrame,
  type InitFrame,
  type InitAckFrame,
  type ProcessStartedFrame,
  type ProcessStoppedFrame,
  type ShutdownFrame,
  type StartProcessFrame,
  type StopProcessFrame,
  GUEST_ENV_FORWARDABLE,
} from "../../container/protocol.ts";
import { STOP_GRACE_MS, STOP_VERIFY_MS } from "../../container/process-groups.ts";

/** Trusted machine configuration for the provider (never renderer/lesson/IR/grant input). */
export interface DockerProviderConfig {
  /** Docker CLI transport configuration (executable / context / private config dir). */
  readonly cli: DockerCliConfig;
  /**
   * Immutable RUNTIME image reference containers are created from (never a
   * moving tag). This is the content-addressed supervisor runtime image built
   * from the digest-pinned base (`image/base-image.lock.json` + Dockerfile +
   * guest bundle) — the base alone cannot run the supervisor. The reference is
   * a `sha256:<hex>` content address or a `name@sha256:<hex>` digest reference;
   * bare tags are rejected. Supplied by trusted machine configuration, never by
   * renderer/lesson/IR/grant input.
   */
  readonly imageReference: string;
  /** Opaque installation identifier (runtime-only label value, never personal data). */
  readonly installationId: string;
  /**
   * P5.8 diagnostics-only override of the canonical session ceiling
   * (design "Container Lifecycle": "Session ceiling 30 minutes"; the
   * canonical value lives in EXECUTION_POLICY.session_ceiling_ms). Trusted
   * machine configuration ONLY — never renderer/lesson/IR/grant input, never
   * part of the ExecutionProvider contract, never renderer-facing; it exists
   * so the real integration suite can prove the ceiling end-to-end without
   * waiting 30 minutes. Undefined in production configuration.
   */
  readonly diagnosticsSessionCeilingMs?: number;
  /**
   * P5.9 diagnostics-only seam for DETERMINISTIC reconciliation tests: when
   * present, every reconcile/list/remove invocation goes through this
   * function instead of the real CLI transport. Trusted machine configuration
   * ONLY — never renderer/lesson/IR/grant input, never part of the
   * ExecutionProvider contract, never renderer-facing (same standing as
   * P5.5's `suspendLeaseRenewal` and P5.8's `diagnosticsSessionCeilingMs`).
   * Undefined in production configuration.
   */
  readonly diagnosticsDockerInvoke?: (options: DockerInvokeOptions) => Promise<DockerInvocationResult>;
}

/** P5.9: one reconciled owned container (launch/daemon-outage reconciliation). */
export interface ReconciledContainer {
  readonly container_id: string;
  readonly name: string | null;
  readonly session_id: string | null;
  readonly outcome: "removed" | "unconfirmed";
}

/** P5.9 reconciliation report (exact owner/phase/installation label scope). */
export interface ReconciliationReport {
  /** "unavailable" = the daemon/transport could not be reached (ledger preserved). */
  readonly status: "reconciled" | "unavailable";
  readonly scanned: number;
  readonly reconciled: readonly ReconciledContainer[];
  readonly unconfirmed: readonly ReconciledContainer[];
}

/** Why a prepare/start failed, mapped to the canonical error model. */
export interface ProviderFailure {
  readonly code: RuntimeErrorCode;
  readonly message: string;
}

/** Renderer-safe process snapshot entry (logical identity only — no PID/PGID). */
export interface ProcessSnapshotEntry {
  readonly process_id: Identifier;
  readonly operation_id: Identifier;
  readonly attempt_id: Identifier;
  readonly state: string;
  readonly forced: boolean;
  readonly exit_code: number | null;
  readonly signal: string | null;
}

interface DockerSessionRecord {
  containerId: string;
  containerName: string;
  context: ResolvedExecutionContext;
  attachHandle: DockerSpawnHandle | null;
  listeners: Set<(event: ProviderEvent) => void>;
  imageReference: string;
  closed: boolean;
  /** Watchdog arm/disarm; attaches a bounded error guard around the attach CLI. */
  watchdog: { arm(): void; disarm(): void };
  // -- P5.5 process ownership / lease state --------------------------------
  /** Trusted admitted grant map (operation_id -> grant). */
  grants: Map<string, ExecutionGrant>;
  registry: ProcessRegistry;
  pump: GuestFramePump | null;
  handshakeComplete: boolean;
  hostSeq: number;
  lastGuestFrameAtMs: number;
  heartbeatTimer: NodeJS.Timeout | null;
  heartbeatSuspended: boolean;
  leaseWatchdogTimer: NodeJS.Timeout | null;
  failing: boolean;
  pendingStarts: Map<
    string,
    { resolve: (frame: ProcessStartedFrame) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | null }
  >;
  pendingStops: Map<
    string,
    {
      cause: StopCause;
      settle: (outcome: { stopped: ProcessStoppedFrame | null; alreadyExited: boolean }) => void;
      outcome: Promise<{ stopped: ProcessStoppedFrame | null; alreadyExited: boolean }>;
      timer: NodeJS.Timeout | null;
    }
  >;
  shutdownWaiter: { resolve: () => void; timer: NodeJS.Timeout | null } | null;
  // -- P5.7 foreground execution --------------------------------------------
  /** The one active foreground run (admission: at most one foreground/session). */
  foregroundRun: ForegroundRunController | null;
  // -- P5.8 background lifetimes ---------------------------------------------
  /**
   * Active background lifetime machines keyed by logical process id. Each
   * owns the canonical terminal trace of its lifetime (confirmed stop /
   * early exit / guest failure) exactly once; session close/failure/ceiling
   * aborts them (no final result after the session's terminal trace).
   */
  backgroundRuns: Map<string, BackgroundRun>;
  /** P5.8 session ceiling timer (design "Session ceiling 30 minutes"). */
  ceilingTimer: NodeJS.Timeout | null;
  /** In-flight failure teardown; close() barriers on it (idempotent close). */
  teardownPromise?: Promise<void>;
  cleanupStatus?: "confirmed" | "unconfirmed";
  /** P7.2 / P8.9 opt-in reviewed bridge options for dev-server loopback networking. */
  bridgeOptions?: SessionBridgeOptions;
}

/** Supervisor hello/init handshake timeout. */
const HELLO_TIMEOUT_MS = 15_000;
const INIT_TIMEOUT_MS = 15_000;
/** Grace before stop/rm during failed-prepare cleanup (docker-init SIGTERM). */
const CLEANUP_GRACE_MS = 4_000;
/** P5.5: bounded wait for the authoritative guest process_started ack. */
const START_ACK_TIMEOUT_MS = 10_000;
/** P5.5: stop confirmation bound = design grace + verification + margin. */
const STOP_CONFIRM_TIMEOUT_MS = STOP_GRACE_MS + STOP_VERIFY_MS + 1_000;
/** P5.5: bounded wait for the guest shutdown ack (guest deadline is 4 s). */
const SHUTDOWN_ACK_TIMEOUT_MS = 5_000;
/** P5.5 watchdog cadence (lease loss detection is independent of the heartbeat). */
const LEASE_WATCHDOG_CHECK_MS = 1_000;
/** P5.9: bounded poll for the authoritative removal listing (mid-removal race). */
const ABSENCE_VERIFY_BOUND_MS = 10_000;
const ABSENCE_POLL_INTERVAL_MS = 500;

/** Forwardable env entries for a start_process frame (host allowlist values only). */
function environmentForwards(plan: ResolvedExecutionContext["environment_plan"]): StartProcessFrame["env"] {
  return plan.host_forwarded
    .filter((entry) => (GUEST_ENV_FORWARDABLE as readonly string[]).includes(entry.name))
    .map((entry) => ({ name: entry.name as (typeof GUEST_ENV_FORWARDABLE)[number], value: entry.value }));
}

/** Container-relative cwd for a grant (pure POSIX below /workspace). */
function containerCwdForGrant(grant: ExecutionGrant): string {
  const segments = resolveAuthoredCwdSegments(grant.cwd);
  if (!segments.ok) return SANDBOX_POLICY.mount.container_target;
  if (segments.value.length === 0) return SANDBOX_POLICY.mount.container_target;
  return `${SANDBOX_POLICY.mount.container_target}/${segments.value.join("/")}`;
}

/** Build the canonical "docker create" argv from policy + trusted context. */
function buildCreateArgv(args: {
  name: string;
  imageReference: string;
  mountSource: string;
  sessionId: string;
  installationId: string;
  testRunId?: string;
  bridge?: SessionBridgeOptions;
}): string[] {
  const c = SANDBOX_POLICY.container;
  const labels = SANDBOX_POLICY.labels;
  const argv = [
    "create",
    "--name", args.name,
    "--label", `${labels.owner}=${labels.owner_value}`,
    "--label", `${labels.phase}=${labels.phase_value}`,
    "--label", `${labels.installation}=${args.installationId}`,
    "--label", `${labels.session}=${args.sessionId}`,
  ];
  if (args.testRunId !== undefined && args.testRunId !== "") {
    argv.push("--label", `${labels.test_run}=${args.testRunId}`);
  }
  argv.push(
    "--platform", SANDBOX_POLICY.platform,
    "--pull", SANDBOX_POLICY.pull_policy,
    "--interactive",
    "--init",
    "--rm",
    "--restart", c.restart,
    "--user", c.user,
    "--workdir", SANDBOX_POLICY.mount.container_target,
    "--hostname", c.hostname,
  );
  if (args.bridge !== undefined) {
    argv.push(
      "--network", args.bridge.networkName,
      "--dns", SANDBOX_BRIDGE_POLICY.dns,
      "-p", `${SANDBOX_BRIDGE_POLICY.loopback_bind_ip}:${args.bridge.hostPort}:${args.bridge.guestPort}`,
    );
  } else {
    argv.push("--network", c.network);
  }
  argv.push(
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
    "--mount", `type=bind,source=${args.mountSource},target=${SANDBOX_POLICY.mount.container_target}`,
    args.imageReference,
  );
  return argv;
}

/** Parse the 64-hex container id printed by "docker create". */
function parseContainerId(createStdout: string): string {
  const firstLine = createStdout.split("\n")[0]?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/.test(firstLine)) {
    throw new Error(`docker create returned an unrecognised container id: ${firstLine.slice(0, 16)}`);
  }
  return firstLine;
}

/** Parse a "docker inspect" JSON document (array of one element). */
function parseInspect(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new Error("docker inspect returned a malformed document");
  }
  return parsed[0] as Record<string, unknown>;
}

interface FrameSource {
  on(event: string, listener: (chunk: Buffer) => void): void;
  off(event: string, listener: (chunk: Buffer) => void): void;
}

/**
 * P5.5 guest frame pump: continuous line-buffered reader over the attached
 * CLI stdout. Parses/validates every guest frame (strict schemas + strictly
 * increasing per-direction seq), resolves handshake waiters, and dispatches
 * post-handshake frames to the session handler. Malformed/oversized frames
 * fail closed (session teardown), never truncation.
 */
class GuestFramePump {
  private buffer = "";
  private lastSeq = 0;
  private readonly source: FrameSource;
  private readonly handlers: {
    onFrame: (frame: GuestFrame) => void;
    onInvalid: (reason: string) => void;
  };
  private readonly waiters: Array<{
    predicate: (frame: GuestFrame) => boolean;
    resolve: (frame: GuestFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout | null;
  }> = [];

  constructor(
    source: FrameSource,
    handlers: {
      onFrame: (frame: GuestFrame) => void;
      onInvalid: (reason: string) => void;
    },
  ) {
    this.source = source;
    this.handlers = handlers;
  }

  start(): void {
    this.source.on("data", this.onData);
  }

  stop(): void {
    this.source.off("data", this.onData);
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.reject(new Error("frame pump stopped"));
    }
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.length === 0) continue;
      this.accept(line);
    }
  };

  private accept(line: string): void {
    if (Buffer.byteLength(line, "utf8") > SUPERVISOR_FRAME_LIMITS.frame_max_bytes) {
      this.handlers.onInvalid("oversized guest frame");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.handlers.onInvalid("malformed guest frame JSON");
      return;
    }
    const checked = GuestFrameSchema.safeParse(parsed);
    if (!checked.success) {
      this.handlers.onInvalid("schema-invalid guest frame");
      return;
    }
    const frame = checked.data;
    // Per-direction sequence discipline: strictly increasing.
    if (frame.seq <= this.lastSeq) {
      this.handlers.onInvalid(`guest frame seq ${frame.seq} is not strictly increasing`);
      return;
    }
    this.lastSeq = frame.seq;
    const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex >= 0) {
      const waiter = this.waiters.splice(waiterIndex, 1)[0]!;
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.handlers.onFrame(frame);
  }

  /** Await the next frame matching the predicate (bounded; handshake use). */
  waitFor(predicate: (frame: GuestFrame) => boolean, timeoutMs: number, timeoutReason: string): Promise<GuestFrame> {
    return new Promise<GuestFrame>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: null as NodeJS.Timeout | null,
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(timeoutReason));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

async function writeFrame(stdin: { write: (data: string) => boolean }, frame: unknown): Promise<void> {
  const serialized = JSON.stringify(frame) + "\n";
  stdin.write(serialized);
}

/**
 * P5.7: one foreground attempt wired to the provider boundaries. The pure
 * ForegroundRun owns the completion semantics; this controller translates
 * its decisions into provider envelopes, registry transitions, guest stop
 * frames and teardown requests, and delivers the one immutable result to the
 * awaiting start().
 */
class ForegroundRunController {
  readonly guestKey: string;
  readonly grant: ExecutionGrant;
  private readonly run: ForegroundRun;
  private readonly record: DockerSessionRecord;
  private readonly provider: DockerSandboxProvider;
  private settled: OperationResult | null = null;
  private settledPromise: Promise<OperationResult>;

  constructor(record: DockerSessionRecord, provider: DockerSandboxProvider, grant: ExecutionGrant, guestKey: string, deadlineMs: number) {
    this.record = record;
    this.provider = provider;
    this.grant = grant;
    this.guestKey = guestKey;
    const callbacks: ForegroundRunCallbacks = {
      emitEvent: (type, payload) => {
        this.provider.emit(this.record, this.provider.envelopeForForeground(this.record, grant, type, payload));
      },
      markExited: (facts) => {
        record.registry.markExited(guestKey, facts, Date.now());
      },
      sendStop: () => {
        record.registry.markStopping(guestKey);
        provider.sendStopFrame(record, guestKey);
      },
      teardown: (code, message) => {
        void provider.failSession(record, code, message);
      },
      onFinalized: (result) => {
        this.settled = result;
        this.resolveSettled(result);
      },
      onAborted: (code, message) => {
        this.settleFailure(new Error(`[${code}] ${message}`));
      },
      outputBytes: () => {
        const entry = record.registry.get(guestKey);
        if (entry === null) return 0;
        return entry.output_bytes.stdout + entry.output_bytes.stderr;
      },
    };
    this.run = new ForegroundRun({
      grant,
      callbacks,
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as NodeJS.Timeout) },
      nowMs: () => Date.now(),
      drainWindowMs: FOREGROUND_POLICY.drain_window_ms,
      stopConfirmTimeoutMs: STOP_CONFIRM_TIMEOUT_MS,
      deadlineMs,
    });
    this.settledPromise = new Promise<OperationResult>((resolve, reject) => {
      this.resolveSettled = resolve;
      this.settleFailure = reject;
    });
  }

  private resolveSettled!: (result: OperationResult) => void;
  private settleFailure!: (error: Error) => void;

  get run_(): ForegroundRun {
    return this.run;
  }

  /** Resolves with the one immutable final result (or rejects on close/abort). */
  get completion(): Promise<OperationResult> {
    return this.settledPromise;
  }

  get finalResult(): OperationResult | null {
    return this.settled;
  }

  // Frame/ack/stop/cancel routing (delegations to the pure run).
  onAck(): void {
    this.run.onAck();
  }
  onExitFrame(exitCode: number | null, signal: string | null, durationMs: number): void {
    this.run.onExitFrame(exitCode, signal, durationMs);
  }
  onStoppedFrame(forced: boolean, exitCode: number | null, signal: string | null, durationMs: number): void {
    this.run.onStoppedFrame(forced, exitCode, signal, durationMs);
  }
  onAlreadyExited(): void {
    this.run.onAlreadyExited();
  }
  onDescendantFailure(): void {
    this.run.onDescendantFailure();
  }
  onOutputLimitFailure(): void {
    this.run.onOutputLimitFailure();
  }
  onSpawnFailed(message: string): void {
    this.run.onSpawnFailed(message);
  }
  cancel(): Promise<"settled"> {
    return this.run.cancel();
  }
  sessionClosing(code: RuntimeErrorCode, message: string): void {
    this.run.sessionClosing(code, message);
  }
}

export class DockerSandboxProvider implements ExecutionProvider {
  private readonly config: DockerProviderConfig;
  private readonly docker: DockerCli;
  private readonly ledger: ContainerLedger;
  private readonly sessions = new Map<ProviderSession, DockerSessionRecord>();
  /** Sessions already torn down (failSession); close() stays idempotent for them. */
  private readonly closedSessions = new Map<ProviderSession, DockerSessionRecord>();
  // -- P5.9 crash/teardown reconciliation -----------------------------------
  /**
   * A cleanup could not be confirmed (daemon outage / transport failure).
   * New sessions are BLOCKED (design: "Daemon outage -> preserve
   * ledger/workspace, CLEANUP_UNCONFIRMED/HOLD, block new sessions until
   * reconciliation") until reconcileRecordedSessions() proves the owned
   * containers gone.
   */
  private reconciliationRequired = false;
  /** "On launch reconcile exact recorded sessions" runs once per instance. */
  private launchReconcileDone = false;

  constructor(config: DockerProviderConfig) {
    this.config = config;
    this.docker = new DockerCli(config.cli);
    this.ledger = new ContainerLedger();
  }

  /** Diagnostics seam (deterministic tests) for reconcile invocations. */
  private invokeDocker(options: DockerInvokeOptions): Promise<DockerInvocationResult> {
    const override = this.config.diagnosticsDockerInvoke;
    return override !== undefined ? override(options) : this.docker.invoke(options);
  }

  private resolveSession(session: ProviderSession): DockerSessionRecord {
    const record = this.sessions.get(session);
    if (record === undefined) {
      throw this.failure("NOT_AUTHORIZED", "unknown provider session");
    }
    return record;
  }

  /** Resolve an active session, or one already torn down by a failure (idempotent close). */
  private resolveSessionOrClosed(session: ProviderSession): DockerSessionRecord {
    return this.sessions.get(session) ?? this.closedSessions.get(session) ?? this.resolveSession(session);
  }

  private failure(code: RuntimeErrorCode, message: string): Error {
    const error = new Error(`[${code}] ${message}`);
    (error as Error & { code: RuntimeErrorCode }).code = code;
    return error;
  }

  /** Emit one translated event to the session's listeners (P5.7 controller is same-module). */
  emit(record: DockerSessionRecord, event: ProviderEvent): void {
    for (const listener of record.listeners) {
      try { listener(event); } catch { /* a misbehaving listener must never break the provider */ }
    }
  }

  private envelope(
    record: DockerSessionRecord,
    grant: ExecutionGrant,
    type: ProviderEvent["type"],
    payload: ProviderEvent["payload"],
    operationId: string | null,
    attemptId: string | null,
    processId: string | null,
  ): ProviderEvent {
    return {
      runtime_event_version: RUNTIME_EVENT_VERSION,
      session_id: grant.session_id, generation: grant.generation,
      operation_id: operationId, attempt_id: attemptId,
      course_id: grant.course_id, lesson_id: grant.lesson_id,
      scene_id: grant.scene_id, beat_id: grant.beat_id, process_id: processId,
      type, payload,
    };
  }

  private sessionEnvelope(
    record: DockerSessionRecord,
    type: ProviderEvent["type"],
    payload: ProviderEvent["payload"],
  ): ProviderEvent {
    const grant = record.context.grant;
    return this.envelope(record, grant, type, payload, null, null, null);
  }

  /** Resolve the trusted grant for a start request (admitted map is the only source). */
  private grantForStart(record: DockerSessionRecord, operationId: Identifier, attemptId: Identifier): ExecutionGrant {
    const fromMap = record.grants.get(operationId);
    if (fromMap !== undefined) {
      if (fromMap.attempt_id !== attemptId) {
        throw this.failure("INVALID_REQUEST", "attempt does not match the admitted grant");
      }
      return fromMap;
    }
    const primary = record.context.grant;
    if (primary.operation_id === operationId && primary.attempt_id === attemptId) return primary;
    throw this.failure("INVALID_REQUEST", "operation/attempt does not match any admitted grant");
  }

  /** Validate the trusted inputs; throw a structured ProviderFailure if unsafe. */
  private validateInput(input: AdmittedSession): ResolvedExecutionContext {
    const context = input.resolvedContext;
    if (context === undefined) {
      throw this.failure("NOT_AUTHORIZED", "admitted session carries no resolved execution context");
    }
    const grant = context.grant;
    if (grant.session_id !== input.session_id || grant.generation !== input.generation) {
      throw this.failure("STALE_SESSION", "resolved context does not match the admitted session identity");
    }
    for (const candidate of input.grants ?? [grant]) {
      if (candidate.session_id !== input.session_id || candidate.generation !== input.generation) {
        throw this.failure("STALE_SESSION", "an admitted grant does not match the admitted session identity");
      }
    }
    if (!isPinnedImageReference(context.image_identity.pinned_reference)) {
      throw this.failure("IMAGE_UNAVAILABLE", "runtime image reference is not digest-pinned");
    }
    // The container is created from the trusted config RUNTIME image (the
    // content-addressed supervisor image built from the pinned base), never
    // from the base itself. Both must be pinned: the config reference is
    // immutable machine configuration, never renderer/lesson/IR/grant input.
    if (!isPinnedImageReference(this.config.imageReference)) {
      throw this.failure("IMAGE_UNAVAILABLE", "configured runtime image reference is not digest-pinned");
    }
    const envCheck = validateEnvironmentPlan(context.environment_plan);
    if (!envCheck.ok) {
      throw this.failure("ENVIRONMENT_POLICY_VIOLATION", envCheck.error.message);
    }
    const mount = context.mount_plan[0];
    if (mount === undefined || context.mount_plan.length !== 1) {
      throw this.failure("WORKSPACE_VIOLATION", "mount plan must declare exactly one mount");
    }
    if (mount.target !== SANDBOX_POLICY.mount.container_target) {
      throw this.failure("WORKSPACE_VIOLATION", "mount target must be exactly /workspace");
    }
    if (FORBIDDEN_MOUNT_SOURCE_FRAGMENTS.some((fragment) => mount.source.includes(fragment))) {
      throw this.failure("WORKSPACE_VIOLATION", "mount source uses a forbidden path fragment");
    }
    return context;
  }

  async prepare(input: AdmittedSession): Promise<ProviderSession> {
    // P5.9: block new sessions until reconciliation proves the previously
    // unconfirmed cleanup gone (design "Daemon outage -> preserve
    // ledger/workspace, CLEANUP_UNCONFIRMED/HOLD, block new sessions until
    // reconciliation"). Trusted launch behavior: the FIRST prepare of an
    // instance also runs the launch reconciliation ("On launch reconcile
    // exact recorded sessions matching owner/phase/installation labels").
    if (this.reconciliationRequired) {
      throw this.failure("CLEANUP_UNCONFIRMED", "a previous cleanup could not be confirmed; reconcile owned sessions before starting new ones");
    }
    if (!this.launchReconcileDone) {
      this.launchReconcileDone = true;
      const report = await this.reconcileRecordedSessions();
      if (report.unconfirmed.length > 0) {
        throw this.failure("CLEANUP_UNCONFIRMED", "launch reconciliation could not confirm removal of owned leftover containers");
      }
    }
    const record = await this.doPrepare(input);
    const session = record as unknown as ProviderSession;
    this.sessions.set(session, record);
    return session;
  }

  async start(session: ProviderSession, operationId: Identifier, attemptId: Identifier): Promise<StartReceipt> {
    const record = this.resolveSession(session);
    if (record.closed) throw this.failure("NOT_AUTHORIZED", "session is closed");
    if (record.failing) throw this.failure("NOT_AUTHORIZED", "session has failed and is closing");
    const grant = this.grantForStart(record, operationId, attemptId);
    if (grant.command.length === 0) {
      throw this.failure("UNSUPPORTED_COMMAND_PROFILE", "granted command is empty");
    }
    if (grant.mode === "background") {
      return this.startBackground(record, grant);
    }
    if (grant.mode !== "foreground") {
      throw this.failure("UNSUPPORTED_PHASE", `unsupported grant mode`);
    }
    return this.startForeground(record, grant);
  }

  /**
   * P5.7 foreground start: supervisor-owned execution in a controlled guest
   * process group with the canonical completion semantics (actual/expected
   * exit, host-owned deadline, bounded drain, descendant policy). Resolves
   * with the one immutable final result of the attempt.
   */
  private async startForeground(record: DockerSessionRecord, grant: ExecutionGrant): Promise<StartReceipt> {
    if (record.foregroundRun !== null) {
      throw this.failure("DUPLICATE_START", "a foreground operation is already active in this session");
    }
    if (grant.timeout_ms === null) {
      throw this.failure("INVALID_REQUEST", "a foreground grant must carry a trusted deadline");
    }
    // Trusted, admission-bounded deadline (main/runtime-owned).
    const deadlineMs = Math.min(Math.max(grant.timeout_ms, 1), ADMISSION_POLICY.foreground_timeout_max_ms);
    // Runtime-internal guest key for the foreground group (the canonical
    // event identity stays process_id null). A collision with an authored
    // logical id cannot start (the registry rejects it — fail closed).
    const guestKey = `fg-${grant.attempt_id}`;
    if (guestKey.length > 128) {
      throw this.failure("INVALID_REQUEST", "foreground guest key exceeds the identifier bound");
    }
    const reserved = record.registry.reserve(
      { process_id: guestKey, operation_id: grant.operation_id, attempt_id: grant.attempt_id },
      { hidden: true },
    );
    if (!reserved.ok) {
      throw this.failure("DUPLICATE_START", `the foreground guest key '${guestKey}' is already owned in this generation`);
    }
    // Workspace/env resolution BEFORE any guest dispatch (zero spawn on
    // rejection; nothing is emitted for an invalid foreground grant).
    const cwdSegments = resolveAuthoredCwdSegments(grant.cwd);
    if (!cwdSegments.ok) {
      record.registry.disposeOne(guestKey);
      throw this.failure("WORKSPACE_VIOLATION", "foreground grant cwd failed workspace resolution");
    }

    const controller = new ForegroundRunController(record, this, grant, guestKey, deadlineMs);
    record.foregroundRun = controller;
    this.emit(record, this.envelope(record, grant, "operation.accepted", {}, grant.operation_id, grant.attempt_id, grant.process_id));
    const handle = record.attachHandle;
    if (handle === null) {
      record.foregroundRun = null;
      record.registry.disposeOne(guestKey);
      controller.sessionClosing("TRANSPORT_FAILED", "no supervisor control channel");
      throw this.failure("TRANSPORT_FAILED", "no supervisor control channel");
    }
    const frame: StartProcessFrame = {
      type: "start_process",
      seq: this.nextHostSeq(record),
      process_id: guestKey,
      attempt_id: grant.attempt_id,
      command: grant.command,
      cwd: containerCwdForGrant(grant),
      env: environmentForwards(record.context.environment_plan),
      mode: "foreground",
    };
    // Bounded start acknowledgment ("startup max 10 seconds bounded by
    // deadline"): STARTED only on the authoritative guest ack.
    try {
      await new Promise<ProcessStartedFrame>((resolve, reject) => {
        const ackBound = Math.min(FOREGROUND_POLICY.startup_ack_max_ms, deadlineMs);
        let timer: NodeJS.Timeout | null = setTimeout(() => {
          timer = null;
          record.pendingStarts.delete(guestKey);
          controller.onSpawnFailed(`timed out waiting for the guest start acknowledgment of '${guestKey}'`);
          reject(this.failure("SPAWN_FAILED", `timed out waiting for the guest start acknowledgment of '${guestKey}'`));
        }, ackBound);
        record.pendingStarts.set(guestKey, {
          resolve: (frame) => {
            if (timer !== null) { clearTimeout(timer); timer = null; }
            resolve(frame);
          },
          reject: (error) => {
            if (timer !== null) { clearTimeout(timer); timer = null; }
            reject(error);
          },
          timer,
        });
        writeFrame(handle.stdin, frame).catch(() => {
          const pending = record.pendingStarts.get(guestKey);
          record.pendingStarts.delete(guestKey);
          controller.onSpawnFailed("failed to write the start frame to the supervisor");
          pending?.reject(this.failure("TRANSPORT_FAILED", "failed to write the start frame to the supervisor"));
        });
      });
    } catch (error) {
      record.foregroundRun = null;
      record.registry.disposeOne(guestKey);
      await this.failSession(record, "SPAWN_FAILED", `foreground start failed: ${error instanceof Error ? error.message : "unknown"}`);
      throw error;
    }
    try {
      const result = await controller.completion;
      return {
        session_id: grant.session_id,
        generation: grant.generation,
        operation_id: grant.operation_id,
        attempt_id: grant.attempt_id,
        process_id: grant.process_id,
        result,
      };
    } finally {
      if (record.foregroundRun === controller) record.foregroundRun = null;
    }
  }

  /** P5.5 background start: reserve -> dispatch to the guest supervisor -> ack -> RUNNING. */
  private async startBackground(record: DockerSessionRecord, grant: ExecutionGrant): Promise<StartReceipt> {
    const processId = grant.process_id;
    if (processId === null) {
      throw this.failure("IR_RUNTIME_INCONSISTENT", "background grant has no logical process id");
    }
    // Trusted admission reservation check + atomic registry reservation
    // ("reserve before awaits"). The admitted grant map IS the admission
    // reservation; the registry makes the duplicate race impossible.
    const reserved = record.registry.reserve({
      process_id: processId,
      operation_id: grant.operation_id,
      attempt_id: grant.attempt_id,
    });
    if (!reserved.ok) {
      throw this.failure("DUPLICATE_START", `logical process '${processId}' is already owned in this generation`);
    }
    this.emit(record, this.envelope(record, grant, "operation.accepted", {}, grant.operation_id, grant.attempt_id, processId));

    const cwdSegments = resolveAuthoredCwdSegments(grant.cwd);
    if (!cwdSegments.ok) {
      record.registry.disposeOne(processId);
      throw this.failure("WORKSPACE_VIOLATION", "background grant cwd failed workspace resolution");
    }
    const handle = record.attachHandle;
    if (handle === null) {
      record.registry.disposeOne(processId);
      throw this.failure("TRANSPORT_FAILED", "no supervisor control channel");
    }
    const frame: StartProcessFrame = {
      type: "start_process",
      seq: this.nextHostSeq(record),
      process_id: processId,
      attempt_id: grant.attempt_id,
      command: grant.command,
      cwd: containerCwdForGrant(grant),
      env: environmentForwards(record.context.environment_plan),
    };

    // STARTED = the authoritative guest acknowledgment (design: "The registry
    // must not claim RUNNING until the guest confirms process creation").
    try {
      await new Promise<ProcessStartedFrame>((resolve, reject) => {
        let timer: NodeJS.Timeout | null = setTimeout(() => {
          timer = null;
          record.pendingStarts.delete(processId);
          reject(this.failure("SPAWN_FAILED", `timed out waiting for the guest start acknowledgment of '${processId}'`));
        }, START_ACK_TIMEOUT_MS);
        record.pendingStarts.set(processId, {
          resolve: (frame) => {
            if (timer !== null) { clearTimeout(timer); timer = null; }
            resolve(frame);
          },
          reject: (error) => {
            if (timer !== null) { clearTimeout(timer); timer = null; }
            reject(error);
          },
          timer,
        });
        writeFrame(handle.stdin, frame).catch(() => {
          const pending = record.pendingStarts.get(processId);
          record.pendingStarts.delete(processId);
          pending?.reject(this.failure("TRANSPORT_FAILED", "failed to write the start frame to the supervisor"));
        });
      });
    } catch (error) {
      record.registry.disposeOne(processId);
      await this.failSession(record, "SPAWN_FAILED", `background start of '${processId}' failed: ${error instanceof Error ? error.message : "unknown"}`);
      throw error;
    }
    // P5.8: the authoritative ack latches the immutable STARTED fact; the
    // lifetime machine owns the canonical terminal trace from here on
    // (confirmed stop / early exit / guest failure — exactly one final
    // result, event-driven; the receipt itself stays the STARTED fact and is
    // never rewritten by a later lifetime event).
    const lifetime = new BackgroundRun({
      grant,
      callbacks: {
        emitEvent: (type, payload) => {
          this.emit(record, this.envelope(record, grant, type, payload, grant.operation_id, grant.attempt_id, processId));
        },
        teardown: (code, message) => {
          void this.failSession(record, code, message);
        },
      },
    });
    lifetime.onStarted();
    record.backgroundRuns.set(processId, lifetime);
    return {
      session_id: grant.session_id,
      generation: grant.generation,
      operation_id: grant.operation_id,
      attempt_id: grant.attempt_id,
      process_id: processId,
    };
  }

  /** Create, inspect-verify, and establish the sandbox. */
  private async doPrepare(input: AdmittedSession): Promise<DockerSessionRecord> {
    const context = this.validateInput(input);
    const grant = context.grant;
    // Container image: the trusted config RUNTIME image (content-addressed
    // supervisor image built from the pinned base). The context's
    // image_identity records the pinned BASE the runtime image was built from
    // (lock provenance); it is not itself runnable as a supervisor.
    const imageReference = this.config.imageReference;
    const mount = context.mount_plan[0];
    const containerName = buildContainerName(grant.lesson_id, grant.session_id);

    if (input.bridge) {
      const netCreateArgv = [
        "network", "create",
        "-d", "bridge",
        "-o", `com.docker.network.bridge.enable_icc=${SANDBOX_BRIDGE_POLICY.icc}`,
        "-o", `com.docker.network.bridge.enable_ip_masquerade=${SANDBOX_BRIDGE_POLICY.ip_masquerade}`,
        "--label", `${SANDBOX_POLICY.labels.owner}=${SANDBOX_POLICY.labels.owner_value}`,
        "--label", `${SANDBOX_POLICY.labels.phase}=${SANDBOX_POLICY.labels.phase_value}`,
        "--label", `${SANDBOX_POLICY.labels.installation}=${this.config.installationId}`,
        "--label", `${SANDBOX_POLICY.labels.session}=${grant.session_id}`,
        input.bridge.networkName,
      ];
      try {
        await this.docker.invoke({ argv: netCreateArgv, timeoutMs: 15_000 });
      } catch {
        // Ignored if already exists
      }
    }

    const createArgv = buildCreateArgv({
      name: containerName, imageReference, mountSource: mount.source,
      sessionId: grant.session_id, installationId: this.config.installationId,
      bridge: input.bridge,
    });
    const createResult = await this.docker.invoke({ argv: createArgv, timeoutMs: 60_000 });
    if (createResult.spawnError !== null) {
      if (input.bridge) {
        try { await this.docker.invoke({ argv: ["network", "rm", input.bridge.networkName], timeoutMs: 15_000 }); } catch {}
      }
      throw this.failure("DOCKER_UNAVAILABLE", `docker create failed to launch: ${createResult.spawnError.message}`);
    }
    if (createResult.exitCode !== 0) {
      if (input.bridge) {
        try { await this.docker.invoke({ argv: ["network", "rm", input.bridge.networkName], timeoutMs: 15_000 }); } catch {}
      }
      throw this.failure("SPAWN_FAILED", `docker create exited ${createResult.exitCode}`);
    }
    const containerId = parseContainerId(createResult.stdout.toString("utf8"));

    const inspectResult = await this.docker.invoke({ argv: ["inspect", containerId], timeoutMs: 30_000 });
    if (inspectResult.exitCode !== 0) {
      await this.rollback(containerId);
      if (input.bridge) {
        try { await this.docker.invoke({ argv: ["network", "rm", input.bridge.networkName], timeoutMs: 15_000 }); } catch {}
      }
      throw this.failure("SPAWN_FAILED", "docker inspect failed after create");
    }
    const inspectDoc = parseInspect(inspectResult.stdout.toString("utf8"));
    const problems = verifyContainerConfiguration(inspectDoc, {
      mountSource: mount.source,
      imageReference,
      bridge: input.bridge,
    });
    if (problems.length > 0) {
      await this.rollback(containerId);
      if (input.bridge) {
        try { await this.docker.invoke({ argv: ["network", "rm", input.bridge.networkName], timeoutMs: 15_000 }); } catch {}
      }
      throw this.failure("SPAWN_FAILED", `container configuration violates policy: ${problems.join("; ")}`);
    }
    const attachHandle = this.docker.spawnStream(["start", "--attach", "--interactive", containerId]);
    // P5.9 crash robustness (design "Container Lifecycle"): a transport death
    // (main/helper loss, a container removed by reconciliation, a daemon
    // outage) must fail the SESSION closed — never crash the host process.
    // The CLI exit promise is the authoritative death detector; these no-op
    // listeners only keep the streams' late EPIPE/error events from becoming
    // uncaught host exceptions.
    for (const stream of [attachHandle.stdin, attachHandle.stdout, attachHandle.stderr] as const) {
      stream.on("error", () => { /* transport death is detected via the attach CLI exit */ });
    }
    const record: DockerSessionRecord = {
      containerId, containerName, context, attachHandle, listeners: new Set(),
      imageReference, closed: false,
      bridgeOptions: input.bridge,
      watchdog: { arm: () => {}, disarm: () => {} },
      grants: new Map(),
      registry: new ProcessRegistry(grant.session_id, grant.generation),
      pump: null,
      handshakeComplete: false,
      hostSeq: 0,
      lastGuestFrameAtMs: Date.now(),
      heartbeatTimer: null,
      heartbeatSuspended: false,
      leaseWatchdogTimer: null,
      failing: false,
      pendingStarts: new Map(),
      pendingStops: new Map(),
      shutdownWaiter: null,
      foregroundRun: null,
      backgroundRuns: new Map(),
      ceilingTimer: null,
    };
    for (const candidate of input.grants ?? [grant]) {
      record.grants.set(candidate.operation_id, candidate);
    }
    record.grants.set(grant.operation_id, grant);
    record.pump = new GuestFramePump(attachHandle.stdout, {
      onFrame: (frame) => this.handleGuestFrame(record, frame),
      onInvalid: (reason) => {
        void this.failSession(record, "PROTOCOL_FAILED", `supervisor protocol failure: ${reason}`);
      },
    });
    record.pump.start();
    // Container failure detection: an attach CLI death while the session is
    // alive is a transport failure (bounded cleanup follows).
    void attachHandle.exit.then((result) => {
      if (!record.closed && !record.failing && (result.exitCode !== null || result.signal !== null)) {
        void this.failSession(record, "TRANSPORT_FAILED", "the supervisor control channel closed unexpectedly");
      }
    }).catch(() => { /* pump stop / teardown paths */ });
    try {
      await this.handshake(record);
    } catch (error) {
      record.pump.stop();
      record.closed = true;
      await this.cleanupFailedPrepare(record);
      throw error;
    }
    record.handshakeComplete = true;
    record.lastGuestFrameAtMs = Date.now();
    // Host-side lease renewal + loss detection (design "Container Lifecycle").
    record.heartbeatTimer = setInterval(() => {
      if (record.closed || record.failing || record.heartbeatSuspended) return;
      const handle = record.attachHandle;
      if (handle === null) return;
      const frame = { type: "heartbeat", seq: this.nextHostSeq(record), session_id: grant.session_id, generation: grant.generation };
      writeFrame(handle.stdin, frame).catch(() => {
        void this.failSession(record, "TRANSPORT_FAILED", "failed to write the heartbeat frame to the supervisor");
      });
    }, SUPERVISOR_TIMING.heartbeat_interval_ms);
    record.leaseWatchdogTimer = setInterval(() => {
      if (record.closed || record.failing) return;
      const silentForMs = Date.now() - record.lastGuestFrameAtMs;
      if (silentForMs > SUPERVISOR_TIMING.lease_ms) {
        void this.failSession(record, "LEASE_EXPIRED", `no supervisor frame for ${silentForMs} ms (lease ${SUPERVISOR_TIMING.lease_ms} ms)`);
      }
    }, LEASE_WATCHDOG_CHECK_MS);
    // P5.8 session ceiling (design "Container Lifecycle": "Session ceiling 30
    // minutes"; the Background Execution section applies it to background
    // lifetimes: "Lease/session ceiling apply"). Host-owned; the canonical
    // duration lives in EXECUTION_POLICY (the diagnostics-only config
    // override exists solely for the real integration suite). At expiry the
    // session takes the canonical close path with cause session_expiry.
    const ceilingMs = Math.max(1, this.config.diagnosticsSessionCeilingMs ?? EXECUTION_POLICY.session_ceiling_ms);
    record.ceilingTimer = setTimeout(() => {
      record.ceilingTimer = null;
      if (!record.closed && !record.failing) {
        void this.close(record as unknown as ProviderSession, "session_expiry");
      }
    }, ceilingMs);
    // Only after the attach stream started and the supervisor handshake
    // succeeded may the container leave this function (no pre-start leak).
    this.ledger.recordIntent({
      containerId, name: containerName, session_id: grant.session_id,
      generation: grant.generation, lesson_id: grant.lesson_id, createdAtEpochMs: Date.now(),
    });
    return record;
  }

  /** Cleanup path for a prepare that failed after attach: stop + remove the container. */
  private async cleanupFailedPrepare(record: DockerSessionRecord): Promise<void> {
    // The attach stream may still hold the container "started". Kill the CLI,
    // give the daemon a bounded moment to deliver SIGTERM via docker-init, then
    // remove with --force as the authoritative teardown. Container names are
    // provider-owned (cf-<lesson>-<session>); only this container is touched.
    if (record.attachHandle !== null) {
      try { record.attachHandle.kill(); } catch { /* best effort */ }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, CLEANUP_GRACE_MS));
    try {
      await this.docker.invoke({ argv: ["stop", "--time", String(SANDBOX_POLICY.container.stop_timeout_seconds), record.containerId], timeoutMs: 20_000 });
    } catch { /* daemon will report no-such-container on rm if already gone */ }
    try {
      await this.docker.invoke({ argv: ["rm", "--force", record.containerId], timeoutMs: 30_000 });
    } catch {
      // --rm may already have removed it (authoritative "No such container").
    }
  }

  /** Supervisor hello/init handshake (bounded, via the shared frame pump). */
  private async handshake(record: DockerSessionRecord): Promise<void> {
    const handle = record.attachHandle;
    const pump = record.pump;
    if (handle === null || pump === null) throw this.failure("SPAWN_FAILED", "no attach handle for handshake");
    let helloRaw: GuestFrame;
    try {
      helloRaw = await pump.waitFor((frame) => frame.type === "hello", HELLO_TIMEOUT_MS, "timed out waiting for supervisor hello frame");
    } catch (error) {
      throw this.failure("PROTOCOL_FAILED", error instanceof Error ? error.message : "hello handshake failed");
    }
    const hello = HelloFrameSchema.parse(helloRaw) as HelloFrame;
    if (hello.supervisor_protocol_version !== 1) {
      throw this.failure("PROTOCOL_FAILED", "supervisor protocol version mismatch");
    }
    const grant = record.context.grant;
    const initFrame: InitFrame = {
      type: "init", seq: this.nextHostSeq(record), session_id: grant.session_id, generation: grant.generation,
      image_digest: record.context.image_identity.digest,
    };
    try { await writeFrame(handle.stdin, initFrame); }
    catch { throw this.failure("PROTOCOL_FAILED", "failed to write init frame to supervisor"); }
    let ackRaw: GuestFrame;
    try {
      ackRaw = await pump.waitFor((frame) => frame.type === "init_ack", INIT_TIMEOUT_MS, "timed out waiting for supervisor init_ack frame");
    } catch (error) {
      throw this.failure("PROTOCOL_FAILED", error instanceof Error ? error.message : "init_ack handshake failed");
    }
    const ack = InitAckFrameSchema.parse(ackRaw) as InitAckFrame;
    if (ack.image_digest !== initFrame.image_digest) {
      throw this.failure("PROTOCOL_FAILED", "supervisor acknowledged a different image digest");
    }
  }

  /** Bounded rollback of a partially created container (provider-owned only). */
  private async rollback(containerId: string): Promise<void> {
    await this.docker.invoke({ argv: ["rm", "--force", containerId], timeoutMs: 60_000 });
  }

  private nextHostSeq(record: DockerSessionRecord): number {
    record.hostSeq += 1;
    return record.hostSeq;
  }

  // ---------------------------------------------------------------------------
  // Guest frame handling (P5.5): authoritative acks, output, exits, stops.
  // ---------------------------------------------------------------------------

  private handleGuestFrame(record: DockerSessionRecord, frame: GuestFrame): void {
    record.lastGuestFrameAtMs = Date.now();
    if (frame.type === "hello" || frame.type === "init_ack") return; // handshake-only frames
    if (!record.handshakeComplete) return; // pre-handshake frames other than hello/init_ack are ignored
    switch (frame.type) {
      case "heartbeat":
        return; // lease renewal signal only
      case "process_started":
        this.handleProcessStarted(record, frame);
        return;
      case "process_output":
        this.handleProcessOutput(record, frame);
        return;
      case "process_exit":
        this.handleProcessExit(record, frame);
        return;
      case "process_stopped":
        this.handleProcessStopped(record, frame);
        return;
      case "process_failed": {
        // P5.7: the active foreground run owns its terminal classification
        // (UNEXPECTED_DESCENDANTS / OUTPUT_LIMIT) — the run produces the one
        // final result BEFORE any session teardown.
        if (record.foregroundRun?.guestKey === frame.process_id) {
          const grantFg = record.foregroundRun.grant;
          this.emit(record, this.envelope(record, grantFg, "process.failed",
            { code: frame.code, message: frame.message }, grantFg.operation_id, grantFg.attempt_id, grantFg.process_id));
          if (frame.code === "UNEXPECTED_DESCENDANTS") {
            record.foregroundRun.onDescendantFailure();
          } else if (frame.code === "OUTPUT_LIMIT") {
            record.foregroundRun.onOutputLimitFailure();
          }
          return;
        }
        const entry = record.registry.get(frame.process_id);
        const grant = entry !== null ? this.grantById(record, entry.operation_id) : null;
        const lifetime = grant !== null ? record.backgroundRuns.get(frame.process_id) : undefined;
        if (lifetime !== undefined && !record.closed && !record.failing) {
          // P5.8: the lifetime machine owns the canonical terminal trace of a
          // guest failure classification for a background id
          // (process.failed <code> -> operation.completed FAIL/<code> ->
          // session fail/close), exactly once (a duplicate frame no-ops).
          lifetime.onFailedFrame(frame.code, frame.message);
          return;
        }
        if (grant !== null) {
          this.emit(record, this.envelope(record, grant, "process.failed",
            { code: frame.code, message: frame.message }, grant.operation_id, grant.attempt_id, frame.process_id));
        }
        void this.failSession(record, frame.code === "OUTPUT_LIMIT" ? "OUTPUT_LIMIT" : "PROTOCOL_FAILED", `process '${frame.process_id}' failed: ${frame.message}`);
        return;
      }
      case "error": {
        if (frame.code === "LEASE_EXPIRED") {
          void this.failSession(record, "LEASE_EXPIRED", frame.message);
        } else if (frame.code === "LOG_BACKPRESSURE") {
          void this.failSession(record, "LOG_BACKPRESSURE", frame.message);
        } else if (frame.code === "ALREADY_EXITED") {
          // The host registry is authoritative — but a latched foreground
          // stop whose group already exited (the stop frame raced the
          // reaper) is confirmed death: finalize through the drain.
          record.foregroundRun?.onAlreadyExited();
        } else {
          void this.failSession(record, "PROTOCOL_FAILED", `guest error: ${frame.code}: ${frame.message}`);
        }
        return;
      }
      case "shutdown_ack": {
        const waiter = record.shutdownWaiter;
        if (waiter !== null) {
          record.shutdownWaiter = null;
          if (waiter.timer !== null) clearTimeout(waiter.timer);
          waiter.resolve();
        }
        return;
      }
    }
  }

  private grantById(record: DockerSessionRecord, operationId: string): ExecutionGrant | null {
    return record.grants.get(operationId) ?? (record.context.grant.operation_id === operationId ? record.context.grant : null);
  }

  private handleProcessStarted(record: DockerSessionRecord, frame: ProcessStartedFrame): void {
    const entry = record.registry.get(frame.process_id);
    const isForeground = record.foregroundRun?.guestKey === frame.process_id;
    if (entry === null) return; // late/unknown ack: registry is authoritative
    if (entry.state === "STARTING") {
      record.registry.markStarted(frame.process_id, frame.pid, frame.pgid, Date.now());
      const grant = this.grantById(record, entry.operation_id);
      if (grant !== null) {
        // Foreground canonical identity: process_id null in every event.
        this.emit(record, this.envelope(record, grant, "process.started", {}, grant.operation_id, grant.attempt_id, grant.process_id));
      }
      if (isForeground) record.foregroundRun?.onAck();
    }
    const pending = record.pendingStarts.get(frame.process_id);
    if (pending !== undefined) {
      record.pendingStarts.delete(frame.process_id);
      pending.resolve(frame);
    }
    if (entry.stopLatched && entry.state === "RUNNING") {
      // A stop that raced the start: dispatch the guest stop now that the
      // group exists (the awaiting stop() resolves through the same
      // pendingStops entry).
      const existing = record.pendingStops.get(frame.process_id);
      if (existing !== undefined) {
        record.registry.markStopping(frame.process_id);
        this.sendStopFrame(record, frame.process_id);
        if (existing.timer !== null) clearTimeout(existing.timer);
        existing.timer = setTimeout(() => {
          record.pendingStops.delete(frame.process_id);
          existing.settle({ stopped: null, alreadyExited: false });
        }, STOP_CONFIRM_TIMEOUT_MS);
      }
    }
  }

  private handleProcessOutput(record: DockerSessionRecord, frame: Extract<GuestFrame, { type: "process_output" }>): void {
    const entry = record.registry.get(frame.process_id);
    if (entry === null || !record.registry.acceptOutput(frame.process_id)) {
      return; // late output after exit / unknown process: dropped, never reordered or re-emitted
    }
    record.registry.recordOutputBytes(frame.process_id, frame.stream, Buffer.byteLength(frame.text, "utf8"));
    if (entry.output_bytes.stdout + entry.output_bytes.stderr > 1_048_576) {
      // Belt-and-braces: the guest enforces this bound; a violation is a
      // provider-side OUTPUT_LIMIT (teardown, no silent growth). For the
      // foreground run the canonical OUTPUT_LIMIT classification + result
      // is produced by the run itself; otherwise the session fails directly.
      if (record.foregroundRun?.guestKey === frame.process_id) {
        record.foregroundRun.onOutputLimitFailure();
      } else {
        const lifetime = record.backgroundRuns.get(frame.process_id);
        if (lifetime !== undefined && !record.closed && !record.failing) {
          // P5.8: the lifetime machine owns the canonical terminal trace
          // (exactly one FAIL/OUTPUT_LIMIT result before the teardown).
          lifetime.onFailedFrame("OUTPUT_LIMIT", `process '${frame.process_id}' exceeded the decoded output bound`);
        } else {
          void this.failSession(record, "OUTPUT_LIMIT", `process '${frame.process_id}' exceeded the decoded output bound`);
        }
      }
      return;
    }
    const grant = this.grantById(record, entry.operation_id);
    if (grant === null) return;
    // Foreground canonical identity: process_id null in every event.
    const isForeground = record.foregroundRun?.guestKey === frame.process_id;
    this.emit(record, this.envelope(record, grant, "process.output",
      { stream: frame.stream, text: frame.text, stream_offset: frame.stream_offset },
      grant.operation_id, grant.attempt_id, isForeground ? grant.process_id : frame.process_id));
  }

  private handleProcessExit(record: DockerSessionRecord, frame: Extract<GuestFrame, { type: "process_exit" }>): void {
    // P5.7 foreground: the terminal frame enters the bounded drain window;
    // the ForegroundRun owns the terminal event, the final result and the
    // registry transition (output -> drain -> terminal event -> result).
    if (record.foregroundRun?.guestKey === frame.process_id) {
      record.foregroundRun.onExitFrame(frame.exit_code, frame.signal, frame.duration_ms);
      return;
    }
    const entry = record.registry.get(frame.process_id);
    if (entry === null) return;
    const accepted = record.registry.markExited(
      frame.process_id,
      { exit_code: frame.exit_code, signal: frame.signal, stopped: false, forced: false },
      Date.now(),
    );
    if (!accepted) return; // duplicate exit frame: idempotent, never a second event
    const grant = this.grantById(record, entry.operation_id);
    if (grant !== null) {
      this.emit(record, this.envelope(record, grant, "process.exited",
        { exit_code: frame.exit_code, signal: frame.signal, duration_ms: frame.duration_ms },
        grant.operation_id, grant.attempt_id, frame.process_id));
    }
    // Stop-vs-natural-exit race: whoever is confirmed first owns the record;
    // an awaiting stop resolves as already-exited (no further signal).
    const pending = record.pendingStops.get(frame.process_id);
    if (pending !== undefined) {
      record.pendingStops.delete(frame.process_id);
      pending.settle({ stopped: null, alreadyExited: true });
    }
    // Natural (unstopped) background exit: canonical BACKGROUND_EXITED_EARLY.
    // The session fails and closes; the historical STARTED fact stays in the
    // registry tombstone. No restart policy exists in P5.
    if (grant !== null) {
      const lifetime = record.backgroundRuns.get(frame.process_id);
      if (lifetime !== undefined && !record.closed && !record.failing) {
        // P5.8: the lifetime machine owns the canonical terminal trace
        // (process.failed BACKGROUND_EXITED_EARLY -> operation.completed
        // FAIL with the true code -> session fail/close), exactly once.
        lifetime.onEarlyExit(frame.exit_code, frame.signal);
      } else {
        // Session already closing/failed: the legacy terminal trace without
        // a machine result (the machine was aborted; no event may follow
        // the session's terminal trace).
        this.emit(record, this.envelope(record, grant, "process.failed",
          { code: "BACKGROUND_EXITED_EARLY", message: `background process '${frame.process_id}' exited on its own with code ${frame.exit_code ?? "null"}` },
          grant.operation_id, grant.attempt_id, frame.process_id));
        this.emit(record, this.envelope(record, grant, "operation.completed",
          { outcome: "FAIL", reason: "BACKGROUND_EXITED_EARLY", exit_code: frame.exit_code, forced: false },
          grant.operation_id, grant.attempt_id, frame.process_id));
      }
    }
    // Session fail/close (machine branch: requested through the machine's
    // teardown; legacy branch: direct). failSession latches, so exactly one
    // teardown runs.
    void this.failSession(record, "BACKGROUND_EXITED_EARLY", `background process '${frame.process_id}' exited naturally`);
  }

  private handleProcessStopped(record: DockerSessionRecord, frame: ProcessStoppedFrame): void {
    // P5.7 foreground: the confirmed death of a latched deadline/cancel stop
    // path enters the bounded drain window; the ForegroundRun owns the
    // terminal event + final result (canonical TIMEOUT/SKIPPED outcomes,
    // never a fake exit code).
    if (record.foregroundRun?.guestKey === frame.process_id) {
      record.foregroundRun.onStoppedFrame(frame.forced, frame.exit_code, frame.signal, frame.duration_ms);
      return;
    }
    const entry = record.registry.get(frame.process_id);
    const pending = record.pendingStops.get(frame.process_id);
    if (entry !== null) {
      const accepted = record.registry.markExited(
        frame.process_id,
        { exit_code: frame.exit_code, signal: frame.signal, stopped: true, forced: frame.forced },
        Date.now(),
      );
      if (accepted) {
        const grant = this.grantById(record, entry.operation_id);
        if (grant !== null) {
          const lifetime = record.backgroundRuns.get(frame.process_id);
          if (lifetime !== undefined && !record.closed && !record.failing) {
            // P5.8: the lifetime machine owns the canonical terminal trace of
            // a CONFIRMED background stop (process.stopped -> one immutable
            // operation.completed; authored stop PASSes, operator stop is
            // SKIPPED/CANCELLED) — exactly once.
            lifetime.onStoppedFrame(pending?.cause ?? "operator_stop", {
              forced: frame.forced,
              exit_code: frame.exit_code,
              signal: frame.signal,
            });
          } else {
            // Session already closing/failed: the legacy terminal trace
            // without a machine result.
            this.emit(record, this.envelope(record, grant, "process.stopped",
              { cause: pending?.cause ?? "operator_stop", forced: frame.forced, exit_code: frame.exit_code, signal: frame.signal },
              grant.operation_id, grant.attempt_id, frame.process_id));
          }
        }
      }
    }
    if (pending !== undefined) {
      record.pendingStops.delete(frame.process_id);
      pending.settle({ stopped: frame, alreadyExited: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Stop / cancel / close / failure
  // ---------------------------------------------------------------------------

  async stop(session: ProviderSession, processId: Identifier, cause: StopCause): Promise<StopResult> {
    const record = this.resolveSession(session);
    if (record.closed) throw this.failure("NOT_AUTHORIZED", "session is closed");
    const entry = record.registry.get(processId);
    if (entry === null) {
      // Unknown logical process: canonical rejection, NO guest signal.
      throw this.failure("INVALID_PROCESS_REFERENCE", `unknown logical process '${processId}'`);
    }
    if (entry.state === "EXITED" || entry.state === "DISPOSED") {
      // Repeat stop of a tombstoned process: existing result, no signal.
      return {
        session_id: record.context.grant.session_id,
        generation: record.context.grant.generation,
        process_id: processId,
        outcome: "already_exited",
        forced: entry.forced,
      };
    }
    // A repeat stop while a stop is already in flight returns the same result
    // (no second signal): await the pending confirmation.
    const pending = record.pendingStops.get(processId) ?? this.beginStop(record, entry, cause, processId);
    const outcome = await pending.outcome;
    record.pendingStops.delete(processId);
    if (outcome.alreadyExited) {
      const current = record.registry.get(processId);
      return {
        session_id: record.context.grant.session_id,
        generation: record.context.grant.generation,
        process_id: processId,
        outcome: "already_exited",
        forced: current?.forced ?? false,
      };
    }
    if (outcome.stopped === null) {
      // Death could not be confirmed within the bounded window: uncertain
      // group -> entire container teardown (design "Stop / Cleanup").
      await this.failSession(record, "TRANSPORT_FAILED", `stop of '${processId}' could not be confirmed; container teardown is the authority`);
      return {
        session_id: record.context.grant.session_id,
        generation: record.context.grant.generation,
        process_id: processId,
        outcome: "stopped",
        forced: true,
      };
    }
    const current = record.registry.get(processId);
    return {
      session_id: record.context.grant.session_id,
      generation: record.context.grant.generation,
      process_id: processId,
      outcome: "stopped",
      forced: current?.forced ?? outcome.stopped.forced,
    };
  }

  /** Register the stop flow for a live process. */
  private beginStop(
    record: DockerSessionRecord,
    entry: RegistryEntry,
    cause: StopCause,
    processId: string,
  ): DockerSessionRecord["pendingStops"] extends Map<string, infer P> ? P : never {
    const grant = this.grantById(record, entry.operation_id);
    if (grant !== null) {
      this.emit(record, this.envelope(record, grant, "process.stopping", { cause }, grant.operation_id, grant.attempt_id, processId));
    }
    if (entry.state === "STARTING") {
      // Stop raced the start: latch only — the guest stop frame is dispatched
      // when the authoritative start ack arrives (no stop for an unspawned
      // group can ever be sent).
      record.registry.latchStop(processId);
    } else if (entry.state === "RUNNING") {
      record.registry.markStopping(processId);
      this.sendStopFrame(record, processId);
    }
    let settle!: (outcome: { stopped: ProcessStoppedFrame | null; alreadyExited: boolean }) => void;
    const outcome = new Promise<{ stopped: ProcessStoppedFrame | null; alreadyExited: boolean }>((resolve) => {
      settle = resolve;
    });
    const pending = {
      cause,
      settle,
      outcome,
      timer: setTimeout(() => {
        record.pendingStops.delete(processId);
        settle({ stopped: null, alreadyExited: false });
      }, entry.state === "STARTING" ? START_ACK_TIMEOUT_MS + STOP_CONFIRM_TIMEOUT_MS : STOP_CONFIRM_TIMEOUT_MS) as NodeJS.Timeout,
    };
    record.pendingStops.set(processId, pending);
    return pending;
  }

  /**
   * P5.7 foreground cancellation: targets the trusted operation identity
   * only (no arbitrary PID, no renderer signal selection). The guest group
   * is stopped through the canonical bounded path and the run finalizes
   * SKIPPED/CANCELLED with a null exit code.
   */
  async cancel(session: ProviderSession, operationId: Identifier): Promise<StopResult> {
    const record = this.resolveSession(session);
    const grant = record.context.grant;
    if (grant.operation_id !== operationId) throw this.failure("INVALID_REQUEST", "operation id does not match the granted operation");
    const run = record.foregroundRun;
    if (run === null || run.grant.operation_id !== operationId) {
      return { session_id: grant.session_id, generation: grant.generation, process_id: grant.process_id, outcome: "already_exited", forced: false };
    }
    await run.cancel();
    return { session_id: grant.session_id, generation: grant.generation, process_id: grant.process_id, outcome: "stopped", forced: true };
  }

  events(session: ProviderSession, listener: (event: ProviderEvent) => void): Disposable {
    const record = this.resolveSession(session);
    record.listeners.add(listener);
    return { dispose: () => record.listeners.delete(listener) };
  }

  async close(session: ProviderSession, cause: CloseCause): Promise<CleanupResult> {
    const record = this.resolveSessionOrClosed(session);
    const grant = record.context.grant;
    if (record.closed) {
      // Idempotent close: barrier on an in-flight failure teardown so the
      // caller only returns after the container absence is settled.
      if (record.teardownPromise !== undefined) await record.teardownPromise;
      return { session_id: grant.session_id, generation: grant.generation, cleanup_status: record.cleanupStatus ?? "confirmed", cause };
    }
    record.closed = true;
    this.stopTimers(record);
    // P5.7: a foreground run interrupted by the session close never publishes
    // a final result (the awaiting start rejects; no event may follow close).
    record.foregroundRun?.sessionClosing("NOT_AUTHORIZED", "the session closed while the foreground operation was active");
    // P5.8: active background lifetimes publish no final result either (the
    // session's close — reset/switch/end/ceiling/expiry — is not a
    // per-operation outcome).
    for (const lifetime of record.backgroundRuns.values()) lifetime.sessionClosing();
    if (!record.failing) {
      this.emit(record, this.sessionEnvelope(record, "runtime.closing", { cause }));
    }
    // Bounded guest shutdown: stop every managed group, then ack (or the
    // attach CLI dies first — either bounds the wait).
    const handle = record.attachHandle;
    if (handle !== null && record.failing === false) {
      const shutdownFrame: ShutdownFrame = { type: "shutdown", seq: this.nextHostSeq(record) };
      const acked = await new Promise<boolean>((resolve) => {
        const waiter = { resolve: () => resolve(true), timer: null as NodeJS.Timeout | null };
        waiter.timer = setTimeout(() => resolve(false), SHUTDOWN_ACK_TIMEOUT_MS);
        record.shutdownWaiter = waiter;
        writeFrame(handle.stdin, shutdownFrame).catch(() => resolve(false));
      });
      if (!acked) {
        try { handle.kill(); } catch { /* best effort */ }
      }
    }
    if (record.attachHandle !== null) {
      try { record.attachHandle.kill(); } catch { /* best effort */ }
    }
    record.registry.disposeAll();
    const cleanupStatus = await this.removeContainer(record);
    record.pump?.stop();
    this.emit(record, this.sessionEnvelope(record, "runtime.closed", { cleanup_status: cleanupStatus }));
    this.sessions.delete(session);
    // P5.8: close is idempotent by contract — a close after the session's own
    // close (e.g. the session ceiling fired first) still resolves the record
    // and returns the REAL cleanup status instead of rejecting.
    this.closedSessions.set(session, record);
    record.cleanupStatus = cleanupStatus;
    return { session_id: grant.session_id, generation: grant.generation, cleanup_status: cleanupStatus, cause };
  }

  /**
   * Session-level failure (lease loss / transport death / protocol failure /
   * natural background exit): latch the failure, emit runtime.failed, and
   * tear the session down. Container teardown remains the final authority.
   */
  /**
   * Session-level failure (lease loss / transport death / protocol failure /
   * timeout / unexpected descendants / output limit): latch the failure,
   * emit runtime.failed, and tear the session down. Container teardown
   * remains the final authority. (P5.7: also invoked by the foreground run's
   * teardown request, after its one final result.)
   */
  async failSession(record: DockerSessionRecord, code: RuntimeErrorCode, message: string): Promise<void> {
    if (record.failing || record.closed) return;
    record.failing = true;
    this.stopTimers(record);
    // P5.7: an active foreground run must not publish a final result into a
    // failing/closing session (its awaited start rejects instead).
    record.foregroundRun?.sessionClosing(code, message);
    // P5.8: active background lifetimes publish no final result either (the
    // session's failure is not a per-operation outcome).
    for (const lifetime of record.backgroundRuns.values()) lifetime.sessionClosing();
    this.emit(record, this.sessionEnvelope(record, "runtime.failed", { code, message }));
    // Reject start waiters; resolve stop waiters via teardown.
    for (const [processId, pending] of [...record.pendingStarts]) {
      record.pendingStarts.delete(processId);
      pending.reject(this.failure(code, message));
    }
    for (const [processId, pending] of [...record.pendingStops]) {
      record.pendingStops.delete(processId);
      pending.settle({ stopped: null, alreadyExited: false });
    }
    if (record.attachHandle !== null) {
      try { record.attachHandle.kill(); } catch { /* best effort */ }
    }
    record.registry.disposeAll();
    record.closed = true;
    const teardown = (async () => {
      const cleanupStatus = await this.removeContainer(record);
      record.pump?.stop();
      this.emit(record, this.sessionEnvelope(record, "runtime.closed", { cleanup_status: cleanupStatus }));
      this.sessions.delete(record as unknown as ProviderSession);
      this.closedSessions.set(record as unknown as ProviderSession, record);
      record.cleanupStatus = cleanupStatus;
    })();
    record.teardownPromise = teardown;
    await teardown;
  }

  private stopTimers(record: DockerSessionRecord): void {
    if (record.heartbeatTimer !== null) { clearInterval(record.heartbeatTimer); record.heartbeatTimer = null; }
    if (record.leaseWatchdogTimer !== null) { clearInterval(record.leaseWatchdogTimer); record.leaseWatchdogTimer = null; }
    if (record.ceilingTimer !== null) { clearTimeout(record.ceilingTimer); record.ceilingTimer = null; }
  }

  /**
   * Authoritative removal (P5.4 + P5.9): docker stop (grace) + rm --force,
   * then the daemon's authoritative listing as the removal proof. Design
   * "Container Lifecycle": "Exact not-found/responding authoritative listing
   * proves removal; connection error doesn't." A lost/timed-out rm answer
   * under a loaded daemon is NOT uncertainty when the daemon can still prove
   * the container gone: after a failed/lost rm the provider asks the daemon
   * directly (docker inspect -> exact not-found = confirmed), retries the
   * force removal once if the container still exists, and only a real
   * transport failure (the daemon unreachable during verification) leaves
   * cleanup unconfirmed.
   */
  private async removeContainer(record: DockerSessionRecord): Promise<"confirmed" | "unconfirmed"> {
    this.ledger.setState(record.containerId, "CLOSING");
    try {
      await this.docker.invoke({ argv: ["stop", "--time", String(SANDBOX_POLICY.container.stop_timeout_seconds), record.containerId], timeoutMs: 30_000 });
    } catch { /* rm below is the authoritative step */ }
    let removed = await this.tryForceRemove(record.containerId);
    if (!removed) {
      removed = await this.daemonProvesAbsent(record.containerId);
      if (!removed) {
        // The container may still exist: one more bounded force removal,
        // then a final authoritative verification.
        await this.tryForceRemove(record.containerId);
        removed = await this.daemonProvesAbsent(record.containerId);
      }
    }
    if (removed) {
      this.ledger.forget(record.containerId);
      this.ledger.setState(record.containerId, "REMOVED");
      if (record.bridgeOptions?.networkName) {
        try {
          await this.invokeDocker({ argv: ["network", "rm", record.bridgeOptions.networkName], timeoutMs: 15_000 });
        } catch {
          // Best effort network removal
        }
      }
      return "confirmed";
    }
    // P5.9: uncertainty stays visible (design "Daemon outage -> preserve
    // ledger/workspace, CLEANUP_UNCONFIRMED/HOLD"). The ledger entry is
    // KEPT (HOLD_CLEANUP) and new sessions are blocked until
    // reconcileRecordedSessions() proves the container gone.
    this.ledger.markCleanupUncertain(record.containerId);
    this.reconciliationRequired = true;
    return "unconfirmed";
  }

  /**
   * The daemon's exact not-found answer IS authoritative removal evidence
   * (design "Exact not-found/responding authoritative listing proves
   * removal"). Docker spells it "No such container" (rm), "no such object"
   * (inspect) or "not found" depending on command and version; all are the
   * same authoritative answer.
   */
  private static isDaemonNotFound(stderr: string): boolean {
    return /no such (container|object)|not found/i.test(stderr);
  }

  /** One bounded "docker rm --force"; exact not-found counts as removed. */
  private async tryForceRemove(containerId: string): Promise<boolean> {
    const rmResult = await this.invokeDocker({ argv: ["rm", "--force", containerId], timeoutMs: 60_000 });
    if (rmResult.spawnError !== null) return false;
    if (rmResult.exitCode === 0) return true;
    return DockerSandboxProvider.isDaemonNotFound(rmResult.stderr.toString("utf8"));
  }

  /**
   * The daemon's exact not-found answer IS authoritative removal evidence
   * (design). Two answers must be waited out with a BOUNDED poll, never
   * treated as permanent uncertainty:
   *   - a mid-removal container ("--rm" auto-removal racing the rm) still
   *     lists as present and rejects a concurrent rm with "already in
   *     progress" — the listing is polled until the daemon reports the
   *     exact not-found;
   *   - a lost/timed-out listing query is retried until the bound.
   * Only a real daemon/transport failure (or the bound expiring) keeps the
   * question open (uncertainty stays visible, fail closed).
   */
  private async daemonProvesAbsent(containerId: string): Promise<boolean> {
    const deadline = Date.now() + ABSENCE_VERIFY_BOUND_MS;
    for (;;) {
      const inspectResult = await this.invokeDocker({ argv: ["inspect", containerId], timeoutMs: 30_000 });
      if (inspectResult.spawnError === null && !inspectResult.timedOut) {
        if (inspectResult.exitCode !== 0) {
          return DockerSandboxProvider.isDaemonNotFound(inspectResult.stderr.toString("utf8"));
        }
        // exitCode 0: the daemon still lists the container — but a container
        // whose removal is already in progress may still appear here; the
        // bounded poll below waits for the authoritative not-found.
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, ABSENCE_POLL_INTERVAL_MS));
    }
  }

  /**
   * P5.9 reconciliation (design "Container Lifecycle": "On launch reconcile
   * exact recorded sessions matching owner/phase/installation labels. No
   * global prune or broad cf-* deletion."). Lists ONLY containers carrying
   * the exact owner/phase/installation label triple and removes them; the
   * daemon's exact not-found counts as authoritative removal. A daemon/transport
   * outage preserves the ledger and reports "unavailable" (uncertainty stays
   * visible; never a silent success). Unconfirmed leftovers keep new sessions
   * blocked (see prepare).
   */
  async reconcileRecordedSessions(): Promise<ReconciliationReport> {
    const labels = SANDBOX_POLICY.labels;
    const psResult = await this.invokeDocker({
      argv: [
        "ps", "-a",
        "--filter", `label=${labels.owner}=${labels.owner_value}`,
        "--filter", `label=${labels.phase}=${labels.phase_value}`,
        "--filter", `label=${labels.installation}=${this.config.installationId}`,
        "--format", "{{.ID}}",
      ],
      timeoutMs: 20_000,
    });
    if (psResult.spawnError !== null || psResult.exitCode !== 0) {
      return { status: "unavailable", scanned: 0, reconciled: [], unconfirmed: [] };
    }
    const ids = psResult.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{12,64}$/.test(line));
    const reconciled: ReconciledContainer[] = [];
    const unconfirmed: ReconciledContainer[] = [];
    for (const containerId of ids) {
      const entry = this.ledger.get(containerId);
      const name = entry?.name ?? null;
      const session_id = entry?.session_id ?? null;
      // Same authoritative semantics as removeContainer: a lost rm answer is
      // not uncertainty when the daemon's exact not-found proves the
      // container gone; only a real transport failure stays unconfirmed.
      let removed = await this.tryForceRemove(containerId);
      if (!removed) removed = await this.daemonProvesAbsent(containerId);
      if (removed) {
        this.ledger.forget(containerId);
        reconciled.push({ container_id: containerId, name, session_id, outcome: "removed" });
      } else {
        this.ledger.markCleanupUncertain(containerId);
        this.reconciliationRequired = true;
        unconfirmed.push({ container_id: containerId, name, session_id, outcome: "unconfirmed" });
      }
    }
    if (unconfirmed.length === 0 && this.ledger.uncertainCount() === 0) {
      this.reconciliationRequired = false;
    }
    return { status: "reconciled", scanned: ids.length, reconciled, unconfirmed };
  }

  // -- P5.7 internal facade for the ForegroundRunController (same module; the
  //    controller is part of this provider's implementation) -------------------

  /** Foreground run event emission (canonical process_id null). */
  envelopeForForeground(
    record: DockerSessionRecord,
    grant: ExecutionGrant,
    type: ProviderEvent["type"],
    payload: ProviderEvent["payload"],
  ): ProviderEvent {
    return this.envelope(record, grant, type, payload, grant.operation_id, grant.attempt_id, grant.process_id);
  }

  /** Send the guest stop frame (SIGINT group; grace/force applied guest-side). */
  sendStopFrame(record: DockerSessionRecord, processId: string): void {
    const handle = record.attachHandle;
    if (handle === null) return;
    const frame: StopProcessFrame = { type: "stop_process", seq: this.nextHostSeq(record), process_id: processId };
    writeFrame(handle.stdin, frame).catch(() => {
      void this.failSession(record, "TRANSPORT_FAILED", "failed to write the stop frame to the supervisor");
    });
  }

  // -- P5.5 diagnostics (never renderer-facing, never part of the contract) ----

  /**
   * Renderer-safe snapshot of the session's logical process registry
   * (identity + lifecycle only; runtime PID/PGID never leave this boundary).
   */
  processSnapshot(session: ProviderSession): readonly ProcessSnapshotEntry[] {
    const record = this.resolveSession(session);
    return record.registry.snapshot();
  }

  /**
   * P5.11 main-only seam for the safe-IPC host: register newly admitted
   * execution grants on a prepared session (incremental admission after the
   * lazy first prepare). Trusted main/runtime input ONLY — never
   * renderer/lesson/IR free-form input (every grant is schema-validated and
   * identity-checked here; a forged grant fails closed). Never part of the
   * ExecutionProvider contract; never renderer-facing. Idempotent for the
   * same operation/attempt; a conflicting attempt for a known operation
   * rejects DUPLICATE_START without overwriting the ledger.
   */
  registerAdmittedGrants(session: ProviderSession, grants: readonly ExecutionGrant[]): void {
    const record = this.resolveSession(session);
    if (record.closed) throw this.failure("NOT_AUTHORIZED", "session is closed");
    if (record.failing) throw this.failure("NOT_AUTHORIZED", "session has failed and is closing");
    for (const grant of grants) {
      const parsed = ExecutionGrantSchema.safeParse(grant);
      if (!parsed.success) {
        throw this.failure("INVALID_REQUEST", "admitted grant failed strict validation");
      }
      if (grant.session_id !== record.context.grant.session_id || grant.generation !== record.context.grant.generation) {
        throw this.failure("STALE_SESSION", "admitted grant does not match the prepared session identity");
      }
      const existing = record.grants.get(grant.operation_id);
      if (existing !== undefined) {
        if (existing.attempt_id !== grant.attempt_id) {
          throw this.failure("DUPLICATE_START", `operation '${grant.operation_id}' is already admitted in this generation`);
        }
        continue;
      }
      record.grants.set(grant.operation_id, grant);
    }
  }

  /**
   * Internal diagnostics-only seam for lease-loss integration tests: suspend
   * the host's heartbeat renewal so the guest lease can expire for real.
   * Never part of the ExecutionProvider contract; never renderer-facing.
   */
  suspendLeaseRenewal(session: ProviderSession): void {
    const record = this.resolveSession(session);
    record.heartbeatSuspended = true;
  }

  resumeLeaseRenewal(session: ProviderSession): void {
    const record = this.resolveSession(session);
    record.heartbeatSuspended = false;
  }

  /**
   * P5.9 diagnostics-only seam for REAL integration tests of the helper-loss
   * path (design "App/helper failure": "CLI death ... -> bounded removal"):
   * kills the attached supervisor CLI exactly as an external death would.
   * Never part of the ExecutionProvider contract; never renderer-facing.
   */
  diagnosticsSeverTransport(session: ProviderSession): void {
    const record = this.resolveSession(session);
    const handle = record.attachHandle;
    if (handle === null) return;
    try { handle.kill(); } catch { /* best effort */ }
  }

  /**
   * P5.9 diagnostics-only seam for REAL integration tests of the MAIN-LOSS
   * path (design "Main crash closes pipe; delayed EOF/surviving helper
   * covered by lease"): closes ONLY the host->guest stdin pipe (the guest
   * sees EOF and its fail-safe stops every group and exits within the 5 s
   * deadline) without killing the attach CLI. Combined with
   * suspendLeaseRenewal this simulates a dead main with a surviving helper.
   * Never part of the ExecutionProvider contract; never renderer-facing.
   */
  diagnosticsCloseStdin(session: ProviderSession): void {
    const record = this.resolveSession(session);
    const handle = record.attachHandle;
    if (handle === null) return;
    try { handle.stdin.end(); } catch { /* best effort */ }
  }
}
