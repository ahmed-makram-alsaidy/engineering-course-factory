// Public surface of @course-factory/terminal-engine.
//
// P5.1: contracts only — the runtime protocol and the abstract
// ExecutionProvider types. The guest supervisor (container/*) is deliberately
// NOT exported here: it is a separate guest-only build entry, never imported
// by Windows host code.

export * from "./protocol.ts";
export * from "./admission.ts";
// P5.3: trusted workspace resolution + environment policy (no execution).
export * from "./workspace.ts";
export * from "./environment.ts";
// P5.5: trusted runtime process registry (logical ownership only — no PID/PGID
// in any exported snapshot shape).
export * from "./registry.ts";
// P5.6: trusted main-owned runtime journal (seq/monotonic stamping, chunk-
// spanning redaction before storage, bounds, per-process transcripts, bounded
// replay pages) and the replay synchronization feed.
export * from "./journal.ts";
export * from "./events.ts";
// P5.10: canonical process-output wait primitive (admitted observation only;
// full wait scheduling/UI execution stays P8).
export * from "./output-wait.ts";
// P5.7: canonical foreground completion state machine (actual/expected exit,
// host-owned deadline, bounded drain, descendant policy, one final result).
export * from "./foreground.ts";
export { loadRuntimeImageIdentity, ImageLockIdentitySchema } from "./runtime-config.ts";
export { buildBridgeNetworkName, SANDBOX_BRIDGE_POLICY } from "./providers/docker-policy.ts";
export { ADMISSION_POLICY, JOURNAL_POLICY, FOREGROUND_POLICY, WAIT_POLICY, EXECUTION_POLICY, IPC_POLICY } from "./policy.ts";
export type {
  AdmittedSession,
  CleanupResult,
  Disposable,
  ExecutionProvider,
  ProviderEvent,
  ProviderSession,
  StartReceipt,
  StopOutcome,
  StopResult,
} from "./providers/execution-provider.ts";
