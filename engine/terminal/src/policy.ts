// P5 admission policy — design-mandated runtime policy constants
// (docs/P5-DESIGN-SPEC.md). Pure constants; no behavior. Execution policy
// (resource limits, sandbox options) remains provider/main-owned and is NOT
// renderer- or curriculum-configurable.

export const ADMISSION_POLICY = Object.freeze({
  /** Foreground timeout when the lesson authors none ("timeout 60 seconds"). */
  foreground_timeout_default_ms: 60_000,
  /** Foreground timeout ceiling; higher authored values are rejected ("max 3600 seconds"). */
  foreground_timeout_max_ms: 3_600_000,
  /** Session concurrency shape: one foreground operation at a time, at most four background processes. */
  max_concurrent_backgrounds: 4,
  /** Command profile: NUL and commands above 16 KiB UTF-8 are rejected as runtime policy. */
  max_command_bytes: 16_384,
  /** Canonical IR size limit ("Limit IR to 1 MiB"). */
  max_ir_bytes: 1_048_576,
} as const);

/**
 * P5.6 journal / output-event policy (design "Output Event Contract" limits
 * and "Replay and display synchronization"). Pure constants; no behavior.
 */
export const JOURNAL_POLICY = Object.freeze({
  /** Journal bound per session: "16 MiB journal/session". Overflow is LOG_BACKPRESSURE (teardown), never a silent drop. */
  session_limit_bytes: 16_777_216,
  /** Headroom reserved for lifecycle/error events when the output budget is exhausted ("Reserve lifecycle/error capacity"). */
  lifecycle_reserve_bytes: 65_536,
  /** Host-side decoded output bound per process (mirror of the guest-enforced 1 MiB). */
  per_process_output_bytes: 1_048_576,
  /** Snapshot page bounds: at most 256 events / 256 KiB per page. */
  snapshot_max_events: 256,
  snapshot_max_bytes: 262_144,
  /** Redaction: a registered secret literal is a case-sensitive whole literal of at most 4096 chars. */
  secret_max_chars: 4096,
  /** Marker replacing every redacted span (never itself registrable as a secret). */
  redaction_marker: "[REDACTED]",
} as const);

/**
 * P5.8 background execution / session lifetime policy (design "Background
 * Execution": "Lease/session ceiling apply, no authored foreground timeout"
 * and "Container Lifecycle": "Session ceiling 30 minutes"). Pure constants;
 * the ceiling is ALWAYS main/runtime-side (renderer/guest cannot set,
 * extend or override it); a background lifetime has no authored timeout.
 */
export const EXECUTION_POLICY = Object.freeze({
  /** Canonical session ceiling: a runtime session (and every background lifetime in it) is bounded to 30 minutes. */
  session_ceiling_ms: 1_800_000,
} as const);

/**
 * P5.10 process-output wait policy (design "Process-output waits /
 * readiness": "Pre-index literal case-sensitive strings (max 4096 chars);
 * register at background spawn so early READY isn't lost. Match each
 * stdout/stderr independently, never concatenate half-marker from each.
 * Either stream can satisfy. Incremental ANSI/OSC stripping/CRLF
 * normalization, chunk-spanning text, retain match sequence/stream.").
 * Pure constants; the deadline itself is ALWAYS main/runtime-side (the
 * trusted WaitAdmission carries the authored timeout; renderer and guest
 * cannot set, extend or override it).
 */
export const WAIT_POLICY = Object.freeze({
  /** Readiness literal bound: a case-sensitive whole literal of at most 4096 chars. */
  max_text_chars: 4096,
  /** Wait deadline ceiling; higher authored values are rejected (same 3600 s ceiling as foreground). */
  max_timeout_ms: 3_600_000,
} as const);

/**
 * P5.11 safe-IPC policy (design "Security Boundary": "Bound receipt/
 * subscription storage; 10 requests/sec/window with cancellation safety
 * route" and "Snapshot 256 events/256 KiB"). Pure constants; the window, the
 * bounds and the bypass are ALWAYS main/runtime-side (renderer and guest
 * cannot set, extend or override them). Cancellation (cancelOperation) and
 * read-only replay (getSnapshot, subscriptions) are never rate-limited: the
 * safety route stays open under load.
 */
export const IPC_POLICY = Object.freeze({
  /** Sliding rate window for mutating terminal requests (run/stop/reset). */
  rate_window_ms: 1_000,
  /** Maximum mutating requests per window per session. */
  rate_max_requests: 10,
  /** Bound on cached request-id receipts per session (oldest evicted; the admission ledger stays authoritative). */
  max_receipts_per_session: 256,
  /** Bound on live journal subscriptions per session. */
  max_subscriptions_per_session: 32,
} as const);

/**
 * P5.7 foreground execution policy (design "Foreground Execution": "deadline
 * before spawn, startup max 10 seconds bounded by deadline", the canonical
 * bounded drain window, and the bounded stop-confirmation window). Pure
 * constants; the deadline itself is ALWAYS main/runtime-side (renderer and
 * guest cannot set, extend or override it).
 */
export const FOREGROUND_POLICY = Object.freeze({
  /** Bounded guest start acknowledgment: "startup max 10 seconds bounded by deadline". */
  startup_ack_max_ms: 10_000,
  /**
   * Canonical bounded drain window: after the guest's terminal frame, the
   * host keeps accepting in-flight output for this long before emitting the
   * terminal event and the final result (ordering: process output -> drain
   * complete -> final terminal event/result; never a late normal output
   * event after the final result).
   */
  drain_window_ms: 500,
} as const);
