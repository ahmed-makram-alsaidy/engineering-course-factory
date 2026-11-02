// Guest process groups — the supervisor-side process table (canonical P5.5
// task "Registry/groups": "guest groups"). Owns the GUEST-side lifecycle of
// managed processes: one controlled POSIX process group per logical process,
// graceful stop (SIGINT per design "Stop / Cleanup"), 2 s grace, SIGKILL
// fallback, 3 s death/drain verification, per-process output bounds (1 MiB
// decoded), bounded writer queue and incremental UTF-8 decoding.
//
// P5.7 foreground completion policy (design "Foreground Execution"): the
// direct command's exit is only PART of completion. For a foreground group
// ("Parent exit isn't tree cleanup"), a close whose process group is still
// alive means owned descendants (children/grandchildren) survived: the
// supervisor force-kills the residual group, VERIFIES its death, and only
// then reports process_exit (the true direct-child code) followed by
// process_failed UNEXPECTED_DESCENDANTS — the host classifies
// FAIL/UNEXPECTED_DESCENDANTS and tears the session down. A clean foreground
// exit is reported only once the whole group is gone, so any exit frame the
// host receives implies "all owned descendants are actually gone".
//
// The table is engine-pure except for the injected GuestSpawn: the guest
// adapter (supervisor.ts) supplies the real `child_process.spawn` binding
// (detached -> the child is its own process-group leader, pgid == pid), and
// unit tests supply a deterministic fake. No direct process access lives in
// this module; timers and the monotonic clock are injected.

import {
  SUPERVISOR_FRAME_LIMITS,
  type GuestFrame,
  type ProcessFailedFrame,
  type ProcessOutputFrame,
  type StartProcessFrame,
} from "./protocol.ts";

/**
 * Fixed guest command environment (design "Environment Policy": the
 * supervisor reconstructs the command env; no image/supervisor env spread,
 * no host inheritance).
 */
export const GUEST_COMMAND_ENV_BASE = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/workspace/.home",
  TMPDIR: "/workspace/.tmp",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "dumb",
} as const);

/** Design output bound: "1 MiB decoded output/process". */
export const GUEST_OUTPUT_PROCESS_LIMIT_BYTES = 1_048_576;

/** Design "Stop / Cleanup": "SIGINT guest group; 2000 ms grace; SIGKILL; 3000 ms death/drain verification." */
export const STOP_GRACE_MS = 2_000;
export const STOP_VERIFY_MS = 3_000;

/** Design "Limits": "1 MiB pending writer queue ... sustained blockage initiates cleanup". */
export const GUEST_WRITER_QUEUE_LIMIT_BYTES = 1_048_576;

/** Grace given to full shutdown before the adapter must exit (within the 5 s deadline). */
export const SHUTDOWN_ACK_DEADLINE_MS = 4_000;

export interface GuestSpawnedProcess {
  readonly pid: number;
  readonly pgid: number;
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  /**
   * DIRECT process death (the OS exit fact). Fires immediately when the
   * direct child dies — unlike onClose, which additionally waits for the
   * stdio pipes to drain (and therefore for any descendant that inherited
   * them). P5.7 uses this for the foreground descendant policy.
   */
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  /** Fired after exit AND stdio close (pipes drained). */
  onClose(listener: (code: number | null, signal: string | null) => void): void;
  signalGroup(signal: "SIGINT" | "SIGKILL"): void;
  /** True while ANY member of this process group is still alive (signal 0 probe). */
  groupAlive(): boolean;
}

/** The single process-creation seam — injected so this module stays pure. */
export type GuestSpawn = (args: { command: string; cwd: string; env: Record<string, string> }) => GuestSpawnedProcess;

export interface GuestTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ProcessTableDeps {
  spawn: GuestSpawn;
  now(): number;
  /** Allocate the next guest->host frame sequence number (shared monotonic counter). */
  seq(): number;
  emit(frame: GuestFrame): void;
  timer: GuestTimer;
  /**
   * P5.9 group-escape inventory (design "Stop / Cleanup": "Stop registered
   * group; inventory guest processes against init/supervisor/active groups.
   * Unknown/escaped live descendant or ambiguity -> full teardown"). The
   * adapter enumerates the POSIX process groups currently alive on the guest;
   * `null` means the inventory itself failed (ambiguity, fail closed).
   */
  inventoryGroups(done: (result: { readonly pgids: readonly number[]; readonly selfPgid: number | null } | null) => void): void;
}

export type GuestProcessState = "STARTING" | "RUNNING" | "STOPPING" | "EXITED";

interface ProcessEntry {
  process_id: string;
  attempt_id: string;
  /** P5.7 execution mode (frame mode; absent frames are background — P5.5). */
  mode: "background" | "foreground";
  state: GuestProcessState;
  child: GuestSpawnedProcess;
  pid: number;
  pgid: number;
  startedAtMs: number;
  outputBytes: number;
  /** Latched stop request received before the process_started ack was sent. */
  stopLatched: boolean;
  stopInitiated: boolean;
  forced: boolean;
  gracefulSignalSent: boolean;
  killTimer: unknown | null;
  verifyTimer: unknown | null;
  exitCode: number | null;
  exitSignal: string | null;
  /** Set when a process_failed frame was emitted (no further close report). */
  failedReported: boolean;
  /** Death/drain verification state (stopped processes only). */
  groupDrained: boolean;
  /** P5.7: owned descendants survived the direct command's exit (foreground). */
  residualDescendants: boolean;
  /** P5.7: the direct child's OS exit fact (recorded at the direct exit event). */
  directExit: { code: number | null; signal: string | null } | null;
  pendingExit: { code: number | null; signal: string | null } | null;
  groupTimers: unknown[];
}

type Utf8Decoder = { write(buffer: Uint8Array): string; end(): string };

export interface GuestDecoderFactory {
  /** Incremental UTF-8 decoder that never splits a multibyte sequence across chunks. */
  create(): Utf8Decoder;
}

/**
 * Guest process table. One controlled process group per logical process_id.
 * All methods are synchronous state transitions; async guest events (output,
 * exit, timers) arrive through the injected callbacks.
 */
export class GuestProcessTable {
  private readonly deps: ProcessTableDeps;
  private readonly processes = new Map<string, ProcessEntry>();
  /** Tombstones: every process_id ever started (duplicate defense, guest side). */
  private readonly known = new Set<string>();
  private decoderFactory: GuestDecoderFactory | null = null;
  private shutdownActive = false;
  private shutdownComplete: ((ackEmitted: boolean) => void) | null = null;

  constructor(deps: ProcessTableDeps) {
    this.deps = deps;
  }

  /** Register the decoder factory (the adapter supplies node:string_decoder). */
  useDecoderFactory(factory: GuestDecoderFactory): void {
    this.decoderFactory = factory;
  }

  get size(): number {
    return this.processes.size;
  }

  /**
   * Start a managed process group. Validations are guest-side re-checks of
   * what the trusted host already validated (defense-in-depth): unknown
   * duplicate logical ids, NUL, dot segments in cwd.
   */
  start(frame: StartProcessFrame): void {
    if (this.known.has(frame.process_id)) {
      // The host registry prevents duplicates; a guest-side duplicate is a
      // protocol violation (fail closed, host tears down).
      this.fail("DUPLICATE_START", `process '${frame.process_id}' already exists on this guest`);
      return;
    }
    if (frame.command.includes("\0")) {
      this.fail("PROTOCOL_FAILED", "start_process command contains NUL");
      return;
    }
    const cwd = frame.cwd ?? "/workspace";
    if (!this.validGuestCwd(cwd)) {
      this.fail("PROTOCOL_FAILED", `start_process cwd rejected: ${cwd}`);
      return;
    }
    const env: Record<string, string> = { ...GUEST_COMMAND_ENV_BASE };
    for (const entry of frame.env) env[entry.name] = entry.value;

    let child: GuestSpawnedProcess;
    try {
      child = this.deps.spawn({ command: frame.command, cwd, env });
    } catch (error) {
      this.fail("SPAWN_FAILED", `guest spawn failed: ${error instanceof Error ? error.message : "unknown"}`);
      return;
    }
    const entry: ProcessEntry = {
      process_id: frame.process_id,
      attempt_id: frame.attempt_id,
      mode: frame.mode ?? "background",
      state: "RUNNING",
      child,
      pid: child.pid,
      pgid: child.pgid,
      startedAtMs: this.deps.now(),
      outputBytes: 0,
      stopLatched: false,
      stopInitiated: false,
      forced: false,
      gracefulSignalSent: false,
      killTimer: null,
      verifyTimer: null,
      exitCode: null,
      exitSignal: null,
      failedReported: false,
      groupDrained: false,
      residualDescendants: false,
      directExit: null,
      pendingExit: null,
      groupTimers: [],
    };
    this.processes.set(frame.process_id, entry);
    this.known.add(frame.process_id);

    this.wire(entry, "stdout", child);
    this.wire(entry, "stderr", child);

    // P5.7: the DIRECT death fact arrives before the (possibly much later)
    // pipe drain; the foreground descendant policy keys off it.
    child.onExit((code, signal) => this.handleDirectExit(entry, code, signal));
    child.onClose((code, signal) => this.handleClose(entry, code, signal));

    this.deps.emit({
      type: "process_started",
      seq: this.deps.seq(),
      process_id: entry.process_id,
      attempt_id: entry.attempt_id,
      pid: entry.pid,
      pgid: entry.pgid,
    });

    if (entry.stopLatched) this.initiateStop(entry);
  }

  /** Gracefully stop one managed group (SIGINT -> 2 s grace -> SIGKILL -> verify). */
  stop(processId: string): void {
    const entry = this.processes.get(processId);
    if (entry === undefined) {
      if (this.known.has(processId)) {
        // Already exited and reaped: tell the host (its registry keeps the
        // authoritative tombstone; no signal is sent to anyone).
        this.deps.emit({ type: "error", seq: this.deps.seq(), session_id: null, generation: null, code: "ALREADY_EXITED", message: `process '${processId}' already exited` });
      } else {
        this.fail("INVALID_PROCESS_REFERENCE", `unknown process '${processId}'`);
      }
      return;
    }
    if (entry.stopInitiated) return;
    this.initiateStop(entry);
  }

  /** Stop every managed group (shutdown / EOF / lease loss). */
  stopAll(force: boolean): void {
    for (const entry of [...this.processes.values()]) {
      if (force) {
        this.kill(entry);
      } else if (!entry.stopInitiated) {
        entry.stopLatched = true;
        this.initiateStop(entry);
      }
    }
  }

  /** All groups dead (or none were alive)? */
  allExited(): boolean {
    return this.processes.size === 0;
  }

  /**
   * Bounded shutdown used by the supervisor's shutdown path: initiate the
   * graceful stop of every group, emit shutdown_ack when all groups have
   * died OR at the deadline (force-kill first), then hand the exit request
   * to the adapter.
   */
  requestShutdown(onComplete: (ackEmitted: boolean) => void): void {
    if (this.shutdownActive) return;
    this.shutdownActive = true;
    this.shutdownComplete = onComplete;
    this.stopAll(false);
    this.deps.timer.set(() => {
      if (!this.shutdownActive) return;
      this.stopAll(true);
      this.emitShutdownAck();
    }, SHUTDOWN_ACK_DEADLINE_MS);
  }

  // -- internals ---------------------------------------------------------------

  private validGuestCwd(cwd: string): boolean {
    if (cwd === "/workspace") return true;
    if (!cwd.startsWith("/workspace/")) return false;
    const rest = cwd.slice("/workspace/".length);
    if (rest.length === 0) return false;
    for (const segment of rest.split("/")) {
      if (segment === "" || segment === "." || segment === "..") return false;
    }
    return true;
  }

  private initiateStop(entry: ProcessEntry): void {
    if (entry.stopInitiated) return;
    entry.stopInitiated = true;
    entry.state = "STOPPING";
    entry.gracefulSignalSent = true;
    entry.child.signalGroup("SIGINT");
    entry.killTimer = this.deps.timer.set(() => {
      entry.killTimer = null;
      if (this.processes.has(entry.process_id)) this.kill(entry);
    }, STOP_GRACE_MS);
  }

  private kill(entry: ProcessEntry): void {
    if (!this.processes.has(entry.process_id)) return;
    if (entry.forced) return; // SIGKILL already applied (idempotent)
    entry.forced = true;
    entry.child.signalGroup("SIGKILL");
    if (entry.verifyTimer === null) {
      // Design "3000 ms death/drain verification": if the group still does
      // not die, the host observes the missing confirmation and tears the
      // container down (uncertain group -> full teardown).
      entry.verifyTimer = this.deps.timer.set(() => {
        entry.verifyTimer = null;
        if (this.processes.has(entry.process_id)) {
          this.fail("STOP_VERIFY_FAILED", `process group '${entry.process_id}' did not die within the verification window`);
        }
      }, STOP_VERIFY_MS);
    }
  }

  /**
   * P5.7: the direct child died. For a foreground group whose descendants
   * are still alive, the residual policy starts HERE (the pipe drain may
   * take much longer when descendants inherited the stdio pipes): the group
   * is force-killed so its members stop writing and the pipes drain, and
   * the verified report is emitted from the subsequent close handler.
   */
  private handleDirectExit(entry: ProcessEntry, code: number | null, signal: string | null): void {
    if (!this.processes.has(entry.process_id)) return;
    entry.directExit = { code, signal };
    if (entry.mode === "foreground" && !entry.stopInitiated && entry.child.groupAlive()) {
      entry.stopInitiated = true; // a racing stop frame must not double-signal
      entry.residualDescendants = true;
      entry.child.signalGroup("SIGKILL");
    }
  }

  private handleClose(entry: ProcessEntry, code: number | null, signal: string | null): void {
    if (!this.processes.has(entry.process_id)) return;
    const facts = entry.directExit ?? { code, signal };
    const durationMs = Math.max(0, Math.floor(this.deps.now() - entry.startedAtMs));
    if (entry.killTimer !== null) {
      this.deps.timer.clear(entry.killTimer);
      entry.killTimer = null;
    }
    if (entry.verifyTimer !== null) {
      this.deps.timer.clear(entry.verifyTimer);
      entry.verifyTimer = null;
    }
    if (entry.residualDescendants && !entry.groupDrained) {
      // P5.7: the residual flow started at the direct exit (owned
      // descendants survived); the pipe has now drained. Verify the WHOLE
      // group's death (bounded) before the residual report.
      entry.groupDrained = true;
      entry.pendingExit = facts;
      this.awaitResidualDeath(entry, durationMs);
      return;
    }
    if (entry.stopInitiated && !entry.groupDrained) {
      // Death/drain verification (design "Stop / Cleanup"): the direct child
      // exited, but group descendants may survive (a shell wrapper dying on
      // the graceful signal while the real command keeps running). The stop
      // is confirmed only when the WHOLE group is gone; lingering members
      // receive the force fallback. Parent exit is never tree cleanup.
      entry.groupDrained = true;
      entry.pendingExit = facts;
      this.awaitGroupDeath(entry, durationMs);
      return;
    }
    if (entry.mode === "foreground" && !entry.stopInitiated && entry.child.groupAlive()) {
      // P5.7 foreground descendant policy (design "Foreground Execution"):
      // the direct command exited on its own, but OWNED descendants are
      // still alive after the pipes drained. The group is force-killed and
      // its death verified BEFORE any report; the classification is
      // process_failed UNEXPECTED_DESCENDANTS (host:
      // FAIL/UNEXPECTED_DESCENDANTS + full teardown).
      entry.stopInitiated = true;
      entry.groupDrained = true;
      entry.residualDescendants = true;
      entry.pendingExit = facts;
      this.awaitResidualDeath(entry, durationMs);
      return;
    }
    if (entry.stopInitiated) {
      // P5.9: a stop is confirmed only after the whole group is dead AND the
      // guest process inventory discloses no escaped/unknown group (design
      // "Stop / Cleanup"). Setsid/daemonized descendants are invisible to the
      // group probe, so the inventory is the authoritative gate.
      this.confirmStopThenFinish(entry, facts, durationMs);
      return;
    }
    this.finishExit(entry, facts.code, facts.signal, durationMs, false);
  }

  /**
   * P5.7: force-kill the residual foreground group and verify its death
   * (bounded poll, 100 ms cadence, STOP_VERIFY_MS bound) before reporting
   * the exit + UNEXPECTED_DESCENDANTS classification. A group that will not
   * die inside the bound is a session-level failure (error frame; the host
   * tears the container down — the final cleanup authority).
   */
  private awaitResidualDeath(entry: ProcessEntry, durationMs: number): void {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const handle of entry.groupTimers) this.deps.timer.clear(handle);
      entry.groupTimers = [];
      if (!this.processes.has(entry.process_id)) return;
      if (entry.child.groupAlive()) {
        // Uncertain group inside a foreground completion: fail closed (the
        // container teardown is the authority over any escapee).
        this.processes.delete(entry.process_id);
        this.fail("STOP_VERIFY_FAILED", `foreground process group '${entry.process_id}' retained live members beyond the verification window`);
        return;
      }
      this.finishExit(entry, entry.pendingExit?.code ?? null, entry.pendingExit?.signal ?? null, durationMs, true);
    };
    const poll = () => {
      if (done || !this.processes.has(entry.process_id)) return;
      if (!entry.child.groupAlive()) {
        finish();
        return;
      }
      // Keep the force fallback applied on every poll (idempotent; covers a
      // member that was spawned between the first kill and its poll).
      entry.child.signalGroup("SIGKILL");
      entry.groupTimers.push(this.deps.timer.set(poll, 100));
    };
    // The first force signal is applied immediately at entry into the wait.
    entry.child.signalGroup("SIGKILL");
    entry.groupTimers.push(this.deps.timer.set(finish, STOP_VERIFY_MS));
    poll();
  }

  private awaitGroupDeath(entry: ProcessEntry, durationMs: number): void {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const handle of entry.groupTimers) this.deps.timer.clear(handle);
      entry.groupTimers = [];
      // P5.9: the whole registered group is dead; the stop is confirmed only
      // after the escape inventory also comes back clean.
      this.confirmStopThenFinish(entry, entry.pendingExit ?? { code: null, signal: null }, durationMs);
    };
    entry.groupTimers.push(this.deps.timer.set(finish, STOP_GRACE_MS + STOP_VERIFY_MS));
    const poll = () => {
      if (done || !this.processes.has(entry.process_id)) return;
      if (!entry.child.groupAlive()) {
        finish();
        return;
      }
      // Residual group members: force fallback (idempotent).
      this.kill(entry);
      entry.groupTimers.push(this.deps.timer.set(poll, 100));
    };
    poll();
  }

  /**
   * P5.9 group-escape gate (design "Stop / Cleanup": "inventory guest
   * processes against init/supervisor/active groups. Unknown/escaped live
   * descendant or ambiguity -> full teardown"). The registered group is
   * verified dead; a live process group outside {container init, the
   * supervisor itself, the inventory probe, any table entry} is an ESCAPED
   * descendant: the stop is NOT confirmed as clean — the classification is
   * process_failed UNEXPECTED_DESCENDANTS (host: FAIL + full container
   * teardown, the authority over any escapee). An inventory failure is
   * treated as ambiguity and classified the same way (fail closed).
   */
  private confirmStopThenFinish(
    entry: ProcessEntry,
    facts: { code: number | null; signal: string | null },
    durationMs: number,
  ): void {
    this.deps.inventoryGroups((result) => {
      if (!this.processes.has(entry.process_id)) return; // disposed meanwhile
      if (result === null || result.selfPgid === null) {
        this.classifyEscape(entry, "the guest process inventory failed (ambiguity)");
        return;
      }
      const known = new Set<number>([1, result.selfPgid]);
      for (const live of this.processes.values()) {
        known.add(live.pgid);
        known.add(live.pid);
      }
      const escaped = result.pgids.filter((pgid) => !known.has(pgid));
      if (escaped.length > 0) {
        this.classifyEscape(entry, `${escaped.length} escaped process group(s) remain outside the managed groups`);
        return;
      }
      this.finishExit(entry, facts.code, facts.signal, durationMs, true);
    });
  }

  /** Report an escaped/ambiguous stop as a guest failure classification. */
  private classifyEscape(entry: ProcessEntry, detail: string): void {
    this.processes.delete(entry.process_id);
    entry.failedReported = true;
    this.deps.emit({
      type: "process_failed",
      seq: this.deps.seq(),
      process_id: entry.process_id,
      code: "UNEXPECTED_DESCENDANTS",
      message: `stop of '${entry.process_id}' confirmed the registered group dead but ${detail}; container teardown is the authority`,
    });
    if (this.shutdownActive && this.processes.size === 0) this.emitShutdownAck();
  }

  private finishExit(
    entry: ProcessEntry,
    code: number | null,
    signal: string | null,
    durationMs: number,
    stopped: boolean,
  ): void {
    if (!this.processes.has(entry.process_id)) return;
    this.processes.delete(entry.process_id);
    if (entry.residualDescendants) {
      // P5.7: the whole group was verified dead (direct command exited while
      // owned descendants survived). The TRUE direct-child exit fact first,
      // then the canonical UNEXPECTED_DESCENDANTS classification.
      this.deps.emit({
        type: "process_exit",
        seq: this.deps.seq(),
        process_id: entry.process_id,
        exit_code: code,
        signal,
        duration_ms: durationMs,
      });
      this.deps.emit({
        type: "process_failed",
        seq: this.deps.seq(),
        process_id: entry.process_id,
        code: "UNEXPECTED_DESCENDANTS",
        message: `foreground group '${entry.process_id}' retained live descendants after the direct command exited; the group was force-killed and verified dead`,
      });
    } else if (!entry.failedReported) {
      if (stopped) {
        this.deps.emit({
          type: "process_stopped",
          seq: this.deps.seq(),
          process_id: entry.process_id,
          forced: entry.forced,
          exit_code: code,
          signal: entry.forced ? (signal ?? "SIGKILL") : signal,
          duration_ms: durationMs,
        });
      } else {
        this.deps.emit({
          type: "process_exit",
          seq: this.deps.seq(),
          process_id: entry.process_id,
          exit_code: code,
          signal,
          duration_ms: durationMs,
        });
      }
    }
    if (this.shutdownActive && this.processes.size === 0) this.emitShutdownAck();
  }

  private emitShutdownAck(): void {
    if (!this.shutdownActive) return;
    this.shutdownActive = false;
    this.deps.emit({ type: "shutdown_ack", seq: this.deps.seq() });
    const complete = this.shutdownComplete;
    this.shutdownComplete = null;
    complete?.(true);
  }

  private wire(entry: ProcessEntry, stream: "stdout" | "stderr", child: GuestSpawnedProcess): void {
    const decoder = this.decoderFactory?.create() ?? this.fallbackDecoder();
    let offset = 0;
    const listener = (chunk: Buffer) => {
      const text = decoder.write(chunk);
      this.deliver(entry, stream, text, offset);
      offset += chunk.length;
    };
    if (stream === "stdout") child.onStdout(listener);
    else child.onStderr(listener);
  }

  private deliver(entry: ProcessEntry, stream: "stdout" | "stderr", text: string, offset: number): void {
    if (text.length === 0 || entry.failedReported) return;
    const bytes = Buffer.byteLength(text, "utf8");
    entry.outputBytes += bytes;
    if (entry.outputBytes > GUEST_OUTPUT_PROCESS_LIMIT_BYTES) {
      this.failProcess(entry, "OUTPUT_LIMIT", "per-process decoded output exceeded 1 MiB");
      return;
    }
    // Split to the output frame payload bound (16 KiB per frame) without
    // splitting UTF-16 surrogate pairs (the text is already fully decoded).
    for (let index = 0; index < text.length; index += SUPERVISOR_FRAME_LIMITS.output_payload_max_bytes) {
      const slice = text.slice(index, index + SUPERVISOR_FRAME_LIMITS.output_payload_max_bytes);
      const frame: ProcessOutputFrame = {
        type: "process_output",
        seq: this.deps.seq(),
        process_id: entry.process_id,
        stream,
        text: slice,
        stream_offset: offset + index,
      };
      this.deps.emit(frame);
    }
  }

  private failProcess(entry: ProcessEntry, code: ProcessFailedFrame["code"], message: string): void {
    if (entry.failedReported) return;
    entry.failedReported = true;
    this.kill(entry);
    this.deps.emit({
      type: "process_failed",
      seq: this.deps.seq(),
      process_id: entry.process_id,
      code,
      message,
    });
  }

  /** Session-level protocol failure: error frame; the adapter exits fail-closed. */
  private fail(code: string, message: string): void {
    this.deps.emit({ type: "error", seq: this.deps.seq(), session_id: null, generation: null, code, message });
  }

  /** Minimal stateful UTF-8 decoder used when no factory was registered. */
  private fallbackDecoder(): Utf8Decoder {
    let pending: Buffer | null = null;
    return {
      write: (buffer: Uint8Array) => {
        let input = Buffer.from(buffer);
        if (pending !== null) {
          input = Buffer.concat([pending, input]);
          pending = null;
        }
        // Avoid splitting a multi-byte sequence: peel the trailing
        // incomplete sequence (leading byte + its continuation bytes).
        let end = input.length;
        for (let i = 0; i < 3 && i < input.length; i++) {
          const byte = input[input.length - 1 - i]!;
          if ((byte & 0xc0) !== 0x80) {
            const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
            if (width > i + 1) {
              const keep = input.length - 1 - i;
              pending = Buffer.from(input.subarray(keep));
              end = keep;
            }
            break;
          }
        }
        return input.subarray(0, end).toString("utf8");
      },
      end: () => {
        if (pending === null) return "";
        const text = pending.toString("utf8");
        pending = null;
        return text;
      },
    };
  }
}
