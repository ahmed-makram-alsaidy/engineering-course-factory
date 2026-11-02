// P5.5 trusted runtime process registry (canonical task "Registry/groups":
// "Atomic reservation/tombstones/guest groups/races").
//
// The registry is the HOST-side owner of logical process lifecycle for one
// runtime session:
//   - logical ownership: the authored logical process_id is the ONLY identity
//     here; runtime PID/PGID are stored for internal targeting but never
//     appear in any event, result or renderer-facing value (they exist only
//     in this module and the guest supervisor's private frames);
//   - duplicate-start prevention: reserve() is a synchronous, atomic
//     transition ("reserve before awaits") — a second reserve of the same
//     logical process while any entry is alive (STARTING/RUNNING/STOPPING)
//     rejects DUPLICATE_START; after EXITED the tombstone retains ownership so
//     a restart within the same generation also rejects (design: "Duplicate
//     fails regardless of request ID", "Only reset reuses definition in a new
//     generation");
//   - lifecycle state: the canonical P5.1 vocabulary STARTING / RUNNING /
//     STOPPING / EXITED / DISPOSED with an explicit legal-transition map —
//     races (stop during STARTING, exit during STOPPING, duplicate exit
//     frames, late output after exit) resolve through explicit state checks,
//     never sleeps;
//   - stop targeting / cleanup targeting / session disposal.
//
// Pure state machine: no I/O, no timers, no frames. The provider (docker.ts)
// translates supervisor frames into registry transitions and registry state
// into events.

import type { Identifier, ProcessState } from "./protocol.ts";

export interface ProcessReservation {
  readonly process_id: Identifier;
  readonly operation_id: Identifier;
  readonly attempt_id: Identifier;
}

export interface ProcessExitFacts {
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stopped: boolean;
  readonly forced: boolean;
}

export interface RegistryEntry {
  readonly process_id: Identifier;
  readonly operation_id: Identifier;
  readonly attempt_id: Identifier;
  state: ProcessState;
  /**
   * P5.7: true for runtime-internal reservations (the foreground group's
   * guest key) that must never surface in the renderer-safe snapshot — the
   * foreground operation's canonical event identity is process_id null.
   */
  hidden: boolean;
  /** Runtime-only OS values; never leave the trusted host boundary. */
  pid: number | null;
  pgid: number | null;
  /** Latched: a stop request arrived while the process was still STARTING. */
  stopLatched: boolean;
  exit_code: number | null;
  signal: string | null;
  forced: boolean;
  startedAtMs: number | null;
  endedAtMs: number | null;
  output_bytes: { stdout: number; stderr: number };
}

export type ReserveResult = { ok: true; entry: RegistryEntry } | { ok: false; code: "DUPLICATE_START" };

/** Legal lifecycle transitions (explicit state machine, no implicit drift). */
const LEGAL_TRANSITIONS: Readonly<Record<ProcessState, readonly ProcessState[]>> = Object.freeze({
  STARTING: ["RUNNING", "STOPPING", "EXITED", "DISPOSED"],
  RUNNING: ["STOPPING", "EXITED", "DISPOSED"],
  STOPPING: ["EXITED", "DISPOSED"],
  EXITED: ["DISPOSED"],
  DISPOSED: [],
});

export class ProcessRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  readonly session_id: Identifier;
  readonly generation: number;

  constructor(session_id: Identifier, generation: number) {
    this.session_id = session_id;
    this.generation = generation;
  }

  /**
   * Atomically reserve the one ownership slot of a logical process. Synchronous
   * call: the provider must reserve before its first await. A tombstoned
   * (EXITED/DISPOSED) process also rejects — ownership is per generation.
   * `options.hidden` marks a runtime-internal reservation (foreground guest
   * key) that is excluded from the renderer-safe snapshot.
   */
  reserve(reservation: ProcessReservation, options?: { hidden?: boolean }): ReserveResult {
    const existing = this.entries.get(reservation.process_id);
    if (existing !== undefined && existing.state !== "DISPOSED") {
      // Any non-disposed entry — including an exited tombstone — owns the id.
      return { ok: false, code: "DUPLICATE_START" };
    }
    const entry: RegistryEntry = {
      process_id: reservation.process_id,
      operation_id: reservation.operation_id,
      attempt_id: reservation.attempt_id,
      state: "STARTING",
      hidden: options?.hidden ?? false,
      pid: null,
      pgid: null,
      stopLatched: false,
      exit_code: null,
      signal: null,
      forced: false,
      startedAtMs: null,
      endedAtMs: null,
      output_bytes: { stdout: 0, stderr: 0 },
    };
    this.entries.set(reservation.process_id, entry);
    return { ok: true, entry };
  }

  get(processId: string): Readonly<RegistryEntry> | null {
    return this.entries.get(processId) ?? null;
  }

  isKnown(processId: string): boolean {
    return this.entries.has(processId);
  }

  /** Authoritative guest ack arrived: STARTING -> RUNNING (records runtime PIDs privately). */
  markStarted(processId: string, pid: number, pgid: number, nowMs: number): boolean {
    return this.transition(processId, "RUNNING", (entry) => {
      entry.pid = pid;
      entry.pgid = pgid;
      entry.startedAtMs = nowMs;
    });
  }

  /** A stop request was observed while STARTING; latched until the ack arrives. */
  latchStop(processId: string): boolean {
    const entry = this.entries.get(processId);
    if (entry === undefined || entry.state !== "STARTING") return false;
    entry.stopLatched = true;
    return true;
  }

  /** STOPPING (stop initiated against a live process). Idempotent. */
  markStopping(processId: string): boolean {
    const entry = this.entries.get(processId);
    if (entry !== undefined && entry.state === "STOPPING") return true;
    return this.transition(processId, "STOPPING");
  }

  /**
   * Terminal death (natural or stopped). Idempotent: only the FIRST death
   * fact for a process is accepted (duplicate guest exit frames and a race
   * between stop and natural exit cannot corrupt the record); `stopped`
   * wins over a concurrent natural exit only if it arrives first — the
   * design's stop/natural-exit race resolves to whichever death is
   * confirmed first, and the second confirmation is ignored.
   */
  markExited(processId: string, facts: ProcessExitFacts, nowMs: number): boolean {
    const entry = this.entries.get(processId);
    if (entry === undefined) return false;
    if (entry.state !== "STARTING" && entry.state !== "RUNNING" && entry.state !== "STOPPING") return false;
    entry.state = "EXITED";
    entry.exit_code = facts.exit_code;
    entry.signal = facts.signal;
    entry.forced = facts.forced;
    entry.endedAtMs = nowMs;
    return true;
  }

  /** Can output still be accepted for this process (RUNNING/STARTING/STOPPING)? */
  acceptOutput(processId: string): boolean {
    const entry = this.entries.get(processId);
    if (entry === undefined) return false;
    return entry.state === "RUNNING" || entry.state === "STARTING" || entry.state === "STOPPING";
  }

  recordOutputBytes(processId: string, stream: "stdout" | "stderr", bytes: number): void {
    const entry = this.entries.get(processId);
    if (entry === undefined) return;
    entry.output_bytes[stream] += bytes;
  }

  /** Is a live (non-terminal) stop target available for this id? */
  isLive(processId: string): boolean {
    const entry = this.entries.get(processId);
    return entry !== undefined && (entry.state === "STARTING" || entry.state === "RUNNING");
  }

  /** Entries that still need cleanup on session close/reset (never tombstones). */
  liveEntries(): readonly RegistryEntry[] {
    return [...this.entries.values()].filter(
      (entry) => entry.state === "STARTING" || entry.state === "RUNNING" || entry.state === "STOPPING",
    );
  }

  /** Session disposal: every entry -> DISPOSED (idempotent). */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.state !== "DISPOSED") entry.state = "DISPOSED";
    }
  }

  /** Dispose one entry (e.g. a reservation that failed validation before spawn). */
  disposeOne(processId: string): boolean {
    const entry = this.entries.get(processId);
    if (entry === undefined || entry.state === "DISPOSED") return false;
    entry.state = "DISPOSED";
    return true;
  }

  /** Registry empty of live entries (cleanup target check). */
  allDisposedOrExited(): boolean {
    return this.liveEntries().length === 0;
  }

  /**
   * Renderer-safe snapshot: logical identity + lifecycle only. Runtime
   * PID/PGID are deliberately absent from the snapshot type, and
   * runtime-internal (hidden) reservations — the foreground group's guest
   * key — never surface (the foreground canonical identity is process_id
   * null in events).
   */
  snapshot(): ReadonlyArray<{
    process_id: Identifier;
    operation_id: Identifier;
    attempt_id: Identifier;
    state: ProcessState;
    forced: boolean;
    exit_code: number | null;
    signal: string | null;
  }> {
    return [...this.entries.values()]
      .filter((entry) => !entry.hidden)
      .map((entry) => ({
        process_id: entry.process_id,
        operation_id: entry.operation_id,
        attempt_id: entry.attempt_id,
        state: entry.state,
        forced: entry.forced,
        exit_code: entry.exit_code,
        signal: entry.signal,
      }));
  }

  private transition(processId: string, to: ProcessState, mutate?: (entry: RegistryEntry) => void): boolean {
    const entry = this.entries.get(processId);
    if (entry === undefined) return false;
    if (!LEGAL_TRANSITIONS[entry.state].includes(to)) return false;
    mutate?.(entry);
    entry.state = to;
    return true;
  }
}
