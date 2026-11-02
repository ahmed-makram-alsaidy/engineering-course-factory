// ExecutionProvider contract — the abstract provider seam of the P5 Terminal
// Engine, exactly as specified in docs/P5-DESIGN-SPEC.md ("ExecutionProvider
// contract"). ExecutionProvider is extensible; DockerSandboxProvider alone is
// implemented in P5 (transport task P5.4). WindowsTrustedProvider,
// RemoteSandboxProvider and a future PtyExecutionAdapter remain design names.
//
// P5.1 scope: this module is TYPES ONLY. It contains no implementation, no
// host machinery, no Docker access and no runtime exports — importing it
// yields an empty runtime namespace (asserted by tests). AdmittedSession is
// constructed only by Electron main (full admission shape arrives with P5.2);
// ProviderSession is opaque and hides host paths/container IDs/handles;
// StartReceipt means ownership/start, not completion or readiness.

import type {
  CloseCause,
  Identifier,
  OperationResult,
  RuntimeEvent,
  StopCause,
} from "../protocol.ts";
import type { ResolvedExecutionContext } from "../workspace.ts";
import type { ExecutionGrant } from "../admission.ts";

/** Handle returned by {@link ExecutionProvider.events}; unsubscribes the listener. */
export interface Disposable {
  dispose(): void;
}

/**
 * P7.2 / P8.9 reviewed bridge configuration for container dev servers.
 * Opt-in only; standard workloads leave bridge undefined (--network none, 0 published ports).
 */
export interface SessionBridgeOptions {
  readonly networkName: string;
  readonly hostPort: number;
  readonly guestPort: number;
}

/**
 * Trusted, immutable admission output constructed ONLY by main. Contains the
 * pinned runtime image identity, the frozen granted operations, relative
 * paths, reviewed seed and policy. Extended by admission (P5.2); providers
 * must treat it as read-only trusted input.
 *
 * P5.4 extension: `resolvedContext` carries the trusted resolved execution
 * context (exact grant + workspace + mount + environment + image). The
 * DockerSandboxProvider requires it; absence is NOT_AUTHORIZED.
 */
export interface AdmittedSession {
  readonly session_id: Identifier;
  readonly generation: number;
  /** P5.4: trusted resolved execution context (grant/workspace/mount/env/image). */
  readonly resolvedContext?: ResolvedExecutionContext;
  /**
   * P5.5: the session's frozen granted operations (the design's
   * "already-admitted map"). Constructed ONLY by trusted admission; the
   * provider resolves each start request against this map and never accepts
   * command/cwd/process metadata from any other source. The first entry (or
   * the entry matching resolvedContext.grant) is the primary context grant.
   */
  readonly grants?: readonly ExecutionGrant[];
  /** P7.2 / P8.9 opt-in reviewed bridge options. */
  readonly bridge?: SessionBridgeOptions;
}

declare const providerSessionBrand: unique symbol;
/**
 * Opaque provider-owned session handle. Hides host paths, container IDs and
 * OS handles from callers; only the provider that created it can interpret it.
 */
export interface ProviderSession {
  readonly [providerSessionBrand]: true;
}

/** Proof of ownership/start for one attempt — never a completion or readiness signal. */
export interface StartReceipt {
  readonly session_id: Identifier;
  readonly generation: number;
  readonly operation_id: Identifier;
  readonly attempt_id: Identifier;
  /** Authored logical process id; null for foreground operations. */
  readonly process_id: Identifier | null;
  /**
   * P5.7: the canonical immutable final result of a FOREGROUND attempt.
   * Foreground start is a completion await (the provider resolves when the
   * operation settled), so the receipt carries the design's Foreground
   * Execution DTO: true actual/expected exit, outcome/reason, deadline and
   * duration labels, cleanup status and opaque output refs. Background
   * starts resolve at the authoritative start ack and carry no result here
   * (their lifetime is event-driven, never rewritten).
   */
  readonly result?: OperationResult;
}

/** Outcome of a stop request against one logical process. */
export type StopOutcome = "stopped" | "already_exited";

export interface StopResult {
  readonly session_id: Identifier;
  readonly generation: number;
  /** Logical process the stop addressed; null when an operation-level cancel returned it. */
  readonly process_id: Identifier | null;
  readonly outcome: StopOutcome;
  readonly forced: boolean;
}

/** Result of closing a runtime session. Idempotent close succeeds only after container absence is confirmed by a responding daemon. */
export interface CleanupResult {
  readonly session_id: Identifier;
  readonly generation: number;
  readonly cleanup_status: "confirmed" | "unconfirmed";
  readonly cause: CloseCause;
}

/**
 * Provider-level event: a translated runtime event WITHOUT the main-journal
 * `seq` and host receipt `monotonic_ms`. Main stamps both when it journals
 * the event (main owns the authoritative journal); the provider owns only
 * translation order and per-stream offsets inside payloads.
 */
export type ProviderEvent = Omit<RuntimeEvent, "seq" | "monotonic_ms">;

export interface ExecutionProvider {
  /** Admit a trusted session into provider-managed resources (no authored work is run). */
  prepare(input: AdmittedSession): Promise<ProviderSession>;
  /** Start one granted operation attempt. Resolves with ownership/start, not completion. */
  start(session: ProviderSession, operationId: Identifier, attemptId: Identifier): Promise<StartReceipt>;
  /** Stop one logical process for the given cause (authored stop or operator Stop). */
  stop(session: ProviderSession, processId: Identifier, cause: StopCause): Promise<StopResult>;
  /** Cancel a foreground/starting operation. */
  cancel(session: ProviderSession, operationId: Identifier): Promise<StopResult>;
  /** Subscribe to translated provider events (before journaling). */
  events(session: ProviderSession, listener: (event: ProviderEvent) => void): Disposable;
  /** Close/teardown the session. Idempotent; unconfirmed cleanup is a HOLD, never silent success. */
  close(session: ProviderSession, cause: CloseCause): Promise<CleanupResult>;
}
