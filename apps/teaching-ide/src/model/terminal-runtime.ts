// Passive terminal runtime model — P5.12 Passive UI (renderer-side view state).
//
// Canonical architecture: docs/P5-DESIGN-SPEC.md, task P5.12 "Passive UI"
// (Inputs: DTO/bridge; Files: App/TerminalPane/model/CSS/tests; Behavior:
// Run/stop/reset/clear/replay/stdin disabled; PASS: Real output, navigation
// inert) plus the "Teaching IDE Integration", "Replay and display
// synchronization", "Record Safe Mode" and "Error Model" sections.
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module is PURE UI state: it derives the renderer's display view
//     ONLY from canonical trusted snapshots/events (SessionJournal via the
//     five identifier-only IPC methods + preload-local onEvent). It never
//     synthesizes canonical runtime events, never executes, never touches the
//     network, the filesystem, processes, Docker, or Electron.
//   - Type-only engine protocol imports (design: "type-only protocol okay").
//     No runtime engine code, no Electron import, no node: import, no xterm
//     import. The xterm wiring lives in TerminalPane; this module only decides
//     WHAT to display.
//   - The runtime engine remains authoritative: UI state is never reconstructed
//     optimistically from button clicks. Run/Stop/Reset only SEND identifier
//     requests; the view changes only when trusted events arrive.
//   - Stale owner events (wrong session_id/generation) are ignored. Duplicates
//     (seq <= applied) are ignored exactly once. Replay gaps are counted and
//     ignored (never silently healed). A reset page re-anchors the cursor.
//   - Per-process transcripts are kept separately (stdout/stderr never
//     blended). Display lines carry an explicit process/stream prefix so
//     unrelated streams are never confused on one screen.
//   - Clear is display-only: it drops display lines, never logs, processes,
//     readiness, or result badges.
//   - Record Safe Mode: labels use /workspace-relative paths and synthetic IDs
//     only — never host storage paths, container IDs, or PIDs (which never
//     appear in the protocol at all).
//   - Errors map to UI-safe short messages from the structured code only.
//     Raw Docker diagnostics never reach the renderer (diagnostic separation).

import type {
  RuntimeEvent,
  TerminalSnapshotPage,
  RuntimeErrorCode,
  FinalOperationOutcome,
} from "@course-factory/terminal-engine";
import type { SafeSessionDescriptor } from "@course-factory/terminal-engine/terminal-host";
import type { CompiledStep } from "./ir.ts";

export type { SafeSessionDescriptor };

/** Bounded display memory (renderer display truncation only; the journal stays authoritative). */
export const TERMINAL_DISPLAY_MAX_LINES = 500;
export const TERMINAL_DISPLAY_MAX_BYTES_PER_PROCESS = 65_536;
export const TERMINAL_SAFE_MESSAGE_MAX_CHARS = 240;

/** UI-safe per-operation lifecycle derived from trusted events only. */
export type TerminalOperationStatus = "PENDING" | "RUNNING" | "PASS" | "HOLD" | "FAIL" | "SKIPPED";

export interface TerminalProcessTranscript {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly outputBytes: number;
}

export interface TerminalOperationView {
  readonly operation_id: string;
  /** Authored logical process id; null for foreground operations. */
  readonly process_id: string | null;
  readonly status: TerminalOperationStatus;
  /** Latched reason code; null on clean PASS or while running. */
  readonly reason: RuntimeErrorCode | null;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly forced: boolean;
  readonly started: boolean;
  readonly completed: boolean;
  readonly transcript: TerminalProcessTranscript;
}

export interface TerminalDisplayLine {
  readonly seq: number;
  /** Already prefixed, sanitized, single-screen line (never raw HTML). */
  readonly text: string;
}

export interface TerminalRuntimeView {
  readonly session_id: string;
  readonly generation: number;
  /** Highest journal seq applied (replay cursor). */
  readonly appliedSeq: number;
  /** True after runtime.closing / runtime.failed: new starts are disabled until removal. */
  readonly tearingDown: boolean;
  readonly closed: boolean;
  readonly closeCleanup: "confirmed" | "unconfirmed" | null;
  /** operation_id -> view (insertion ordered by first sight). */
  readonly operations: Readonly<Record<string, TerminalOperationView>>;
  readonly displayLines: readonly TerminalDisplayLine[];
  /** UI-safe error banner (short, no paths/diagnostics) or null. */
  readonly errorMessage: string | null;
  /** Counters for diagnostics (display only, never execution). */
  readonly gaps: number;
  readonly resets: number;
  readonly ignoredStale: number;
  readonly ignoredDuplicates: number;
}

function emptyTranscript(): TerminalProcessTranscript {
  return { stdout: "", stderr: "", truncated: false, outputBytes: 0 };
}

function emptyOperation(operation_id: string, process_id: string | null): TerminalOperationView {
  return {
    operation_id,
    process_id,
    status: "PENDING",
    reason: null,
    exit_code: null,
    signal: null,
    forced: false,
    started: false,
    completed: false,
    transcript: emptyTranscript(),
  };
}

export function initialTerminalRuntimeView(session: { session_id: string; generation: number }): TerminalRuntimeView {
  return {
    session_id: session.session_id,
    generation: session.generation,
    appliedSeq: 0,
    tearingDown: false,
    closed: false,
    closeCleanup: null,
    operations: {},
    displayLines: [],
    errorMessage: null,
    gaps: 0,
    resets: 0,
    ignoredStale: 0,
    ignoredDuplicates: 0,
  };
}

/**
 * Strip terminal side-effect sequences for safe xterm display: remove OSC
 * sequences (clipboard/title/hyperlink: ESC ] ... BEL / ESC \) and C1 OSC
 * (0x9D ... BEL), drop NUL bytes, and keep printable/ANSI color content.
 * Output is rendered through xterm.write (never as HTML), so no markup can
 * execute; this stripping removes the control side effects the design bans.
 */
export function sanitizeTerminalOutputForDisplay(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    // NUL: drop (never display).
    if (ch === 0) {
      i += 1;
      continue;
    }
    // ESC ] (OSC): skip until BEL or ESC \.
    if (ch === 0x1b && i + 1 < text.length && text.charCodeAt(i + 1) === 0x5d) {
      i += 2;
      while (i < text.length) {
        const c = text.charCodeAt(i);
        if (c === 0x07) {
          i += 1;
          break;
        }
        if (c === 0x1b && i + 1 < text.length && text.charCodeAt(i + 1) === 0x5c) {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    // C1 OSC 0x9D: skip until BEL.
    if (ch === 0x9d) {
      i += 1;
      while (i < text.length && text.charCodeAt(i) !== 0x07) i += 1;
      if (i < text.length) i += 1;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** Map a structured canonical error code to a short UI-safe message (no diagnostics, no paths). */
export function terminalUiSafeError(code: RuntimeErrorCode | string, fallback: string | null = null): string {
  const mapped: Record<string, string> = {
    INVALID_REQUEST: "Invalid request — nothing started.",
    WRONG_OWNER: "Not the session owner — nothing started.",
    STALE_SESSION: "Session changed — replay the current session.",
    DUPLICATE_START: "Already started — see the live result.",
    INVALID_PROCESS_REFERENCE: "Unknown process — nothing stopped.",
    PROCESS_NOT_STARTED: "Process has not started yet.",
    PROCESS_EXITED: "Process already exited.",
    IR_INVALID: "Lesson failed validation — inspection only.",
    IR_RUNTIME_INCONSISTENT: "Lesson is inconsistent — inspection only.",
    NOT_AUTHORIZED: "Inspection only — this lesson is not reviewed for execution.",
    DOCKER_UNAVAILABLE: "Runtime unavailable — try again later.",
    WRONG_BACKEND: "Runtime backend unavailable — try again later.",
    STORAGE_UNVERIFIED: "Runtime storage unverified — try again later.",
    IMAGE_UNAVAILABLE: "Runtime image unavailable — try again later.",
    WORKSPACE_VIOLATION: "Workspace policy blocked the start.",
    UNSUPPORTED_COMMAND_PROFILE: "Command profile unsupported — blocked before start.",
    WORKSPACE_UNAVAILABLE: "Workspace unavailable — try again later.",
    ENVIRONMENT_POLICY_VIOLATION: "Environment policy blocked the start.",
    SPAWN_FAILED: "Process failed to start.",
    EXIT_CODE_MISMATCH: "Command exited with an unexpected code.",
    TIMEOUT: "Command timed out.",
    OUTPUT_LIMIT: "Output limit exceeded.",
    LOG_BACKPRESSURE: "Log budget exceeded.",
    TRANSPORT_FAILED: "Runtime connection lost.",
    PROTOCOL_FAILED: "Runtime protocol error.",
    LEASE_EXPIRED: "Runtime lease expired.",
    BACKGROUND_EXITED_EARLY: "Background process exited early.",
    UNEXPECTED_DESCENDANTS: "Unexpected child processes — session closed.",
    CANCELLED: "Cancelled.",
    CLEANUP_UNCONFIRMED: "Cleanup unconfirmed — no new runs until reconciled.",
    UNSUPPORTED_PHASE: "Not supported in this phase.",
  };
  const hit = mapped[String(code)];
  if (hit !== undefined) return hit;
  if (fallback !== null && fallback.length > 0) return truncateUiText(fallback);
  return "Runtime error — see the result badge.";
}

function truncateUiText(text: string): string {
  if (text.length <= TERMINAL_SAFE_MESSAGE_MAX_CHARS) return text;
  return `${text.slice(0, TERMINAL_SAFE_MESSAGE_MAX_CHARS)}…`;
}

/** Record-safe workspace label: always /workspace-relative, never a host path. */
export function formatTerminalCwdForDisplay(cwd: string | null | undefined): string {
  if (cwd === null || cwd === undefined || cwd === "" || cwd === ".") return "/workspace";
  const cleaned = String(cwd).replace(/\\/g, "/");
  if (cleaned.startsWith("/workspace")) return cleaned;
  const stripped = cleaned.replace(/^\/+/, "");
  return `/workspace/${stripped}`;
}

/** Short synthetic identity label (record-safe: synthetic IDs only). */
export function formatTerminalIdentityForDisplay(session: { session_id: string; generation: number }): string {
  return `session ${session.session_id} · gen ${session.generation}`;
}

function operationKeyOf(event: RuntimeEvent): string | null {
  return event.operation_id;
}

function processLabelOf(event: RuntimeEvent): string {
  if (event.process_id !== null) return event.process_id;
  return "fg";
}

function pushLine(
  view: TerminalRuntimeView,
  seq: number,
  text: string,
): readonly TerminalDisplayLine[] {
  const next = [...view.displayLines, { seq, text }];
  if (next.length > TERMINAL_DISPLAY_MAX_LINES) {
    return next.slice(next.length - TERMINAL_DISPLAY_MAX_LINES);
  }
  return next;
}

function getOrCreateOperation(
  operations: Record<string, TerminalOperationView>,
  operation_id: string,
  process_id: string | null,
): TerminalOperationView {
  const existing = operations[operation_id];
  if (existing !== undefined) return existing;
  const created = emptyOperation(operation_id, process_id);
  operations[operation_id] = created;
  return created;
}

function appendTranscript(
  op: TerminalOperationView,
  stream: "stdout" | "stderr",
  text: string,
): TerminalOperationView {
  const current = stream === "stdout" ? op.transcript.stdout : op.transcript.stderr;
  const other = stream === "stdout" ? op.transcript.stderr : op.transcript.stdout;
  const nextText = current + text;
  const nextBytes = op.transcript.outputBytes + text.length;
  const over = nextText.length > TERMINAL_DISPLAY_MAX_BYTES_PER_PROCESS;
  const kept = over ? nextText.slice(nextText.length - TERMINAL_DISPLAY_MAX_BYTES_PER_PROCESS) : nextText;
  const transcript: TerminalProcessTranscript =
    stream === "stdout"
      ? { stdout: kept, stderr: other, truncated: op.transcript.truncated || over, outputBytes: nextBytes }
      : { stdout: other, stderr: kept, truncated: op.transcript.truncated || over, outputBytes: nextBytes };
  return { ...op, transcript };
}

/**
 * Apply one trusted journal event to the view. Stale sessions/generations and
 * duplicates are ignored (counters only). Gaps are counted and ignored —
 * newer events still apply (design: "Ignore duplicates/replay gaps").
 */
export function applyTerminalRuntimeEvent(view: TerminalRuntimeView, event: RuntimeEvent): TerminalRuntimeView {
  if (event.session_id !== view.session_id || event.generation !== view.generation) {
    return { ...view, ignoredStale: view.ignoredStale + 1 };
  }
  if (event.seq <= view.appliedSeq) {
    return { ...view, ignoredDuplicates: view.ignoredDuplicates + 1 };
  }
  const gap = event.seq > view.appliedSeq + 1;
  let next: TerminalRuntimeView = {
    ...view,
    appliedSeq: event.seq,
    gaps: gap ? view.gaps + 1 : view.gaps,
  };
  const ops: Record<string, TerminalOperationView> = { ...next.operations };
  const opKey = operationKeyOf(event);

  switch (event.type) {
    case "operation.accepted": {
      if (opKey === null) return next;
      const op = getOrCreateOperation(ops, opKey, event.process_id);
      ops[opKey] = { ...op, process_id: op.process_id ?? event.process_id, status: "RUNNING" };
      next = { ...next, operations: ops, displayLines: pushLine(next, event.seq, `[${opKey}] accepted`) };
      break;
    }
    case "process.started": {
      if (opKey === null) return next;
      const op = getOrCreateOperation(ops, opKey, event.process_id);
      ops[opKey] = { ...op, process_id: op.process_id ?? event.process_id, status: "RUNNING", started: true };
      next = { ...next, operations: ops, displayLines: pushLine(next, event.seq, `[${opKey}/${processLabelOf(event)}] started`) };
      break;
    }
    case "process.output": {
      if (opKey === null) return next;
      const payload = event.payload as { stream?: unknown; text?: unknown };
      const stream = payload.stream === "stderr" ? "stderr" : "stdout";
      const raw = typeof payload.text === "string" ? payload.text : "";
      const clean = sanitizeTerminalOutputForDisplay(raw);
      const op = getOrCreateOperation(ops, opKey, event.process_id);
      const updated: TerminalOperationView =
        op.started || op.status === "RUNNING"
          ? appendTranscript({ ...op, started: true, status: "RUNNING" }, stream, clean)
          : appendTranscript(op, stream, clean);
      ops[opKey] = updated;
      // Per-process prefix keeps unrelated streams distinct on one screen.
      const prefix = `[${opKey}/${processLabelOf(event)} ${stream}]`;
      const firstLine = clean.split(/\r?\n/)[0] ?? "";
      next = { ...next, operations: ops, displayLines: pushLine(next, event.seq, `${prefix} ${firstLine}`) };
      break;
    }
    case "process.timeout": {
      if (opKey === null) return next;
      const op = getOrCreateOperation(ops, opKey, event.process_id);
      ops[opKey] = { ...op, status: "RUNNING" };
      next = { ...next, operations: ops, displayLines: pushLine(next, event.seq, `[${opKey}] timeout`) };
      break;
    }
    case "process.stopping": {
      if (opKey === null) return next;
      const op = getOrCreateOperation(ops, opKey, event.process_id);
      ops[opKey] = { ...op, status: "RUNNING" };
      next = { ...next, operations: ops, displayLines: pushLine(next, event.seq, `[${opKey}] stopping`) };
      break;
    }
    case "process.exited": {
      if (opKey === null) return next;
      const payload = event.payload as { exit_code?: unknown; signal?: unknown };
      const op = getOrCreateOperation(ops, opKey, event.process_id);
      ops[opKey] = {
        ...op,
        exit_code: typeof payload.exit_code === "number" ? payload.exit_code : null,
        signal: typeof payload.signal === "string" ? payload.signal : null,
      };
      const code = typeof payload.exit_code === "number" ? `exit ${payload.exit_code}` : "signalled";
      next = { ...next, operations: ops, displayLines: pushLine(next, event.seq, `[${opKey}] exited ${code}`) };
      break;
    }
    case "process.stopped": {
      if (opKey === null) return next;
      const payload = event.payload as { forced?: unknown; exit_code?: unknown; signal?: unknown };
      const op = getOrCreateOperation(ops, opKey, event.process_id);
      ops[opKey] = {
        ...op,
        forced: payload.forced === true,
        exit_code: typeof payload.exit_code === "number" ? payload.exit_code : op.exit_code,
        signal: typeof payload.signal === "string" ? payload.signal : op.signal,
      };
      next = { ...next, operations: ops, displayLines: pushLine(next, event.seq, `[${opKey}] stopped`) };
      break;
    }
    case "process.failed": {
      const payload = event.payload as { code?: unknown; message?: unknown };
      const code = typeof payload.code === "string" ? payload.code : "PROTOCOL_FAILED";
      const safe = terminalUiSafeError(code);
      if (opKey !== null) {
        const op = getOrCreateOperation(ops, opKey, event.process_id);
        ops[opKey] = { ...op, status: "FAIL", reason: code as RuntimeErrorCode };
        next = { ...next, operations: ops, errorMessage: safe, displayLines: pushLine(next, event.seq, `[${opKey}] failed — ${safe}`) };
      } else {
        next = { ...next, errorMessage: safe, displayLines: pushLine(next, event.seq, `[session] failed — ${safe}`) };
      }
      break;
    }
    case "operation.completed": {
      if (opKey === null) return next;
      const payload = event.payload as {
        outcome?: unknown;
        reason?: unknown;
        exit_code?: unknown;
        forced?: unknown;
      };
      const op = getOrCreateOperation(ops, opKey, event.process_id);
      const outcome = payload.outcome as FinalOperationOutcome;
      const reason = (payload.reason ?? null) as RuntimeErrorCode | null;
      const status: TerminalOperationStatus = outcome;
      const safe = reason === null ? null : terminalUiSafeError(reason);
      ops[opKey] = {
        ...op,
        status,
        reason,
        exit_code: typeof payload.exit_code === "number" ? payload.exit_code : op.exit_code,
        forced: payload.forced === true,
        completed: true,
      };
      const badge = summarizeTerminalResultForBadge({ ...op, status, reason });
      next = {
        ...next,
        operations: ops,
        errorMessage: status === "PASS" || status === "SKIPPED" ? next.errorMessage : (safe ?? next.errorMessage),
        displayLines: pushLine(next, event.seq, `[${opKey}] ${badge}`),
      };
      break;
    }
    case "runtime.closing": {
      next = { ...next, tearingDown: true, displayLines: pushLine(next, event.seq, "[session] closing — new starts disabled") };
      break;
    }
    case "runtime.closed": {
      const payload = event.payload as { cleanup_status?: unknown };
      next = {
        ...next,
        tearingDown: true,
        closed: true,
        closeCleanup: payload.cleanup_status === "unconfirmed" ? "unconfirmed" : "confirmed",
        displayLines: pushLine(next, event.seq, "[session] closed"),
      };
      break;
    }
    case "runtime.failed": {
      const payload = event.payload as { code?: unknown };
      const code = typeof payload.code === "string" ? payload.code : "TRANSPORT_FAILED";
      next = {
        ...next,
        tearingDown: true,
        closed: true,
        errorMessage: terminalUiSafeError(code),
        displayLines: pushLine(next, event.seq, `[session] failed — ${terminalUiSafeError(code)}`),
      };
      break;
    }
  }
  return next;
}

/** Apply a bounded snapshot page (ordered). Reset pages re-anchor the cursor. */
export function applyTerminalSnapshotPage(
  view: TerminalRuntimeView,
  page: TerminalSnapshotPage,
): TerminalRuntimeView {
  if (page.session_id !== view.session_id || page.generation !== view.generation) {
    return { ...view, ignoredStale: view.ignoredStale + 1 };
  }
  let next = view;
  if (page.reset) {
    // Cursor outside retained history: reset the display cursor to the
    // page's after_seq anchor, reapply the retained tail, and count the
    // reset (design: "explicit snapshot-reset if cursor outside history").
    let forced: TerminalRuntimeView = { ...next, appliedSeq: page.after_seq, resets: next.resets + 1, displayLines: [] };
    for (const event of page.events) {
      forced = applyTerminalRuntimeEvent(forced, event);
    }
    return forced;
  }
  for (const event of page.events) {
    next = applyTerminalRuntimeEvent(next, event);
  }
  return next;
}

/** Clear is display-only: drop display lines, keep logs/processes/badges. */
export function clearTerminalDisplay(view: TerminalRuntimeView): TerminalRuntimeView {
  return { ...view, displayLines: [] };
}

/** Per-process transcript for the xterm surface (stdout/stderr kept separate upstream). */
export function selectTerminalTranscript(view: TerminalRuntimeView, operation_id: string): TerminalProcessTranscript | null {
  return view.operations[operation_id]?.transcript ?? null;
}

/** UI-safe result badge for one operation (trusted outcome only). */
export function summarizeTerminalResultForBadge(op: Pick<TerminalOperationView, "status" | "reason" | "exit_code" | "forced">): string {
  switch (op.status) {
    case "PENDING":
      return "PENDING";
    case "RUNNING":
      return "RUNNING";
    case "PASS":
      return op.forced ? "PASS · forced" : "PASS";
    case "SKIPPED":
      return "SKIPPED · cancelled";
    case "HOLD":
      return op.reason === null ? "HOLD" : `HOLD · ${op.reason}`;
    case "FAIL": {
      const reason = op.reason === null ? "failed" : op.reason;
      const code = op.exit_code === null ? "" : ` · exit ${op.exit_code}`;
      return `FAIL · ${reason}${code}`;
    }
  }
}

/**
 * Run eligibility (design: "Run granted not-yet-run terminal operation only;
 * no selection execution"). True only when the playhead step is a terminal
 * family operation, the session is authorized and alive, and the operation
 * has no completed attempt in this generation. Navigation alone never enables
 * execution.
 */
export function isTerminalRunEligible(input: {
  step: CompiledStep | null;
  view: TerminalRuntimeView;
  executionAuthorized: boolean;
}): boolean {
  const { step, view, executionAuthorized } = input;
  if (!executionAuthorized) return false;
  if (view.tearingDown || view.closed) return false;
  if (step === null || step.kind !== "operation") return false;
  if (step.operation.family !== "terminal") return false;
  if (step.operation.type !== "terminal_run" && step.operation.type !== "terminal_stop") return false;
  const existing = view.operations[step.step_id];
  if (existing !== undefined && existing.completed) return false;
  return true;
}

/** Create an identifier-only request_id (1–128 chars, no execution content). */
let terminalRequestCounter = 0;
export function createTerminalRequestId(): string {
  terminalRequestCounter += 1;
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `term-req-${Date.now().toString(36)}-${terminalRequestCounter.toString(36)}-${rand}`;
}
