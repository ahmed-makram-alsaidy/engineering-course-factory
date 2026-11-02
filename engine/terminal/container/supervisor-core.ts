// Supervisor core — pure state machine for the hello/init/lease scaffold
// (P5.1) plus the P5.5 post-init control dispatch. No I/O, no timers of its
// own, no process access: the host adapter (supervisor.ts) drives it with
// monotonic times, writes the frames it produces, and executes the control
// dispatches it returns through the guest process table. This split keeps
// every lease/heartbeat/handshake/dispatch behavior unit-testable with
// injected times, deterministically.
//
// Lease discipline (design "Container Lifecycle"): the guest monotonic 15 s
// lease starts at boot and is renewed ONLY by valid host traffic of the
// correct generation. P5.5 valid host traffic = init (first), heartbeat,
// start_process, stop_process, shutdown. Expiry (and any malformed/unknown
// frame) emits an error frame and requests exit within the 5 s deadline.

import {
  HostFrameSchema,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_TIMING,
  type GuestFrame,
  type InitFrame,
  type ShutdownFrame,
  type StartProcessFrame,
  type StopProcessFrame,
} from "./protocol.ts";

export type SupervisorPhase = "awaiting-init" | "ready" | "closing" | "failed" | "expired";

/** Guest runtime identity injected by the adapter (kept out of the pure core). */
export interface SupervisorRuntimeInfo {
  node_major: number;
  node_version: string;
}

/** A control dispatch the adapter must execute (pure core never touches processes). */
export type SupervisorDispatch =
  | { kind: "start_process"; frame: StartProcessFrame }
  | { kind: "stop_process"; frame: StopProcessFrame }
  | { kind: "shutdown"; frame: ShutdownFrame };

/** Everything one core call decided; the adapter applies it. */
export interface SupervisorTransition {
  /** Outbound guest frames, in emission order. */
  frames: GuestFrame[];
  phase: SupervisorPhase;
  /** Guest monotonic lease deadline; null once the supervisor has failed/expired. */
  lease_deadline_ms: number | null;
  /** Next guest monotonic heartbeat due time; null once failed/expired or pre-init. */
  next_heartbeat_ms: number | null;
  /** True when the adapter must exit the guest process (within the 5 s deadline). */
  exit_requested: boolean;
  /** Control action(s) the adapter must execute (start/stop/shutdown). */
  dispatches: SupervisorDispatch[];
}

export class SupervisorCore {
  private phase: SupervisorPhase = "awaiting-init";
  private seq = 0;
  private lease_deadline_ms: number | null = null;
  private next_heartbeat_ms: number | null = null;
  private frozen: { session_id: string; generation: number; image_digest: string } | null = null;
  private lastHostSeq = 0;
  private readonly runtimeInfo: SupervisorRuntimeInfo;

  constructor(runtimeInfo: SupervisorRuntimeInfo) {
    this.runtimeInfo = runtimeInfo;
  }

  /** Frozen init configuration; null until a valid init was acknowledged. */
  get session(): Readonly<{ session_id: string; generation: number; image_digest: string }> | null {
    return this.frozen;
  }

  get currentPhase(): SupervisorPhase {
    return this.phase;
  }

  /**
   * Allocate the next guest->host frame sequence number. Shared by the core
   * and the process table so every guest frame stays strictly increasing.
   */
  allocateSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Boot the supervisor: emit hello and start the lease clock (deadline anchored at boot). */
  boot(nowMs: number): SupervisorTransition {
    this.lease_deadline_ms = nowMs + SUPERVISOR_TIMING.lease_ms;
    const hello: GuestFrame = {
      type: "hello",
      seq: this.allocateSeq(),
      supervisor_protocol_version: SUPERVISOR_PROTOCOL_VERSION,
      node_major: this.runtimeInfo.node_major,
      node_version: this.runtimeInfo.node_version,
    };
    return this.transition([hello]);
  }

  /**
   * Offer one raw host frame (already byte-limit-checked by the adapter).
   * Anything malformed, unexpected, out-of-sequence or arriving after a
   * terminal phase is a protocol failure: error frame + exit request. A valid
   * init freezes and acknowledges the session and renews the lease. Post-init
   * P5.5 control frames (heartbeat/start_process/stop_process/shutdown)
   * renew the lease and are returned as dispatches for the adapter.
   */
  handleHostFrame(raw: unknown, nowMs: number): SupervisorTransition {
    if (this.phase === "failed" || this.phase === "expired") return this.transition([]);
    const parsed = HostFrameSchema.safeParse(raw);
    if (!parsed.success) {
      return this.fail("PROTOCOL_FAILED", "malformed or unexpected host frame", nowMs);
    }
    const frame = parsed.data;
    // Host->guest sequence discipline: strictly increasing per direction.
    if (frame.seq <= this.lastHostSeq) {
      return this.fail("PROTOCOL_FAILED", `host frame seq ${frame.seq} is not strictly increasing`, nowMs);
    }
    this.lastHostSeq = frame.seq;
    if (this.phase === "closing") {
      // After shutdown only the shutdown path speaks; ignore stragglers.
      return this.transition([]);
    }
    if (this.phase === "awaiting-init") {
      if (frame.type !== "init") {
        return this.fail("PROTOCOL_FAILED", `expected init, received ${frame.type}`, nowMs);
      }
      const init = frame as InitFrame;
      this.frozen = {
        session_id: init.session_id,
        generation: init.generation,
        image_digest: init.image_digest,
      };
      this.phase = "ready";
      // Valid, correct-generation host traffic renews the lease and starts
      // the heartbeat cadence (session frames need the frozen identity).
      this.lease_deadline_ms = nowMs + SUPERVISOR_TIMING.lease_ms;
      this.next_heartbeat_ms = nowMs + SUPERVISOR_TIMING.heartbeat_interval_ms;
      const ack: GuestFrame = {
        type: "init_ack",
        seq: this.allocateSeq(),
        session_id: this.frozen.session_id,
        generation: this.frozen.generation,
        image_digest: this.frozen.image_digest,
      };
      return this.transition([ack]);
    }
    // -- ready phase: P5.5 control frames -------------------------------------
    if (frame.type === "heartbeat") {
      // Lease renewal: valid host traffic of the frozen session.
      this.lease_deadline_ms = nowMs + SUPERVISOR_TIMING.lease_ms;
      return this.transition([]);
    }
    this.lease_deadline_ms = nowMs + SUPERVISOR_TIMING.lease_ms;
    if (frame.type === "start_process") {
      return { ...this.transition([]), dispatches: [{ kind: "start_process", frame }] };
    }
    if (frame.type === "stop_process") {
      return { ...this.transition([]), dispatches: [{ kind: "stop_process", frame }] };
    }
    if (frame.type === "shutdown") {
      this.phase = "closing";
      this.next_heartbeat_ms = null;
      return { ...this.transition([]), dispatches: [{ kind: "shutdown", frame }] };
    }
    return this.fail("PROTOCOL_FAILED", `unexpected host frame ${frame.type} after init`, nowMs);
  }

  /** Advance time: emit due heartbeats (post-init) and enforce the lease deadline. */
  advance(nowMs: number): SupervisorTransition {
    if (this.phase === "failed" || this.phase === "expired") return this.transition([]);
    const frames: GuestFrame[] = [];
    let emitted = 0;
    while (this.next_heartbeat_ms !== null && this.next_heartbeat_ms <= nowMs && emitted < 64) {
      frames.push({
        type: "heartbeat",
        seq: this.allocateSeq(),
        session_id: this.frozen?.session_id ?? "",
        generation: this.frozen?.generation ?? 0,
        monotonic_ms: Math.floor(nowMs),
      });
      this.next_heartbeat_ms += SUPERVISOR_TIMING.heartbeat_interval_ms;
      emitted += 1;
    }
    if (this.lease_deadline_ms !== null && nowMs >= this.lease_deadline_ms && this.phase !== "closing") {
      // Missing init / no valid host traffic within the lease: stop and exit
      // within the 5 s deadline even if the host never speaks again.
      this.phase = "expired";
      this.lease_deadline_ms = null;
      this.next_heartbeat_ms = null;
      return {
        frames: [
          ...frames,
          {
            type: "error",
            seq: this.allocateSeq(),
            session_id: this.frozen?.session_id ?? null,
            generation: this.frozen?.generation ?? null,
            code: "LEASE_EXPIRED",
            message: "guest lease expired without valid host traffic",
          },
        ],
        phase: this.phase,
        lease_deadline_ms: null,
        next_heartbeat_ms: null,
        exit_requested: true,
        dispatches: [],
      };
    }
    return this.transition(frames);
  }

  /**
   * Host pipe reached EOF: the adapter stops all managed groups (force) and
   * exits promptly (within the 5 s deadline). No error frame is emitted —
   * the reader on the other side is gone.
   */
  notifyEof(): SupervisorTransition {
    if (this.phase === "failed" || this.phase === "expired") return this.transition([]);
    return {
      frames: [],
      phase: this.phase,
      lease_deadline_ms: this.lease_deadline_ms,
      next_heartbeat_ms: this.next_heartbeat_ms,
      exit_requested: true,
      dispatches: [],
    };
  }

  private fail(code: string, message: string, _nowMs: number): SupervisorTransition {
    this.phase = "failed";
    this.lease_deadline_ms = null;
    this.next_heartbeat_ms = null;
    const error: GuestFrame = {
      type: "error",
      seq: this.allocateSeq(),
      session_id: this.frozen?.session_id ?? null,
      generation: this.frozen?.generation ?? null,
      code,
      message,
    };
    return { frames: [error], phase: this.phase, lease_deadline_ms: null, next_heartbeat_ms: null, exit_requested: true, dispatches: [] };
  }

  private transition(frames: GuestFrame[]): SupervisorTransition {
    return {
      frames,
      phase: this.phase,
      lease_deadline_ms: this.lease_deadline_ms,
      next_heartbeat_ms: this.next_heartbeat_ms,
      exit_requested: false,
      dispatches: [],
    };
  }
}
