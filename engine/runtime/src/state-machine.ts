// P8.3 Runtime State Machine
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 6 & Section 14,
// and docs/adr/ADR-0013-runtime-orchestration-boundary.md.
//
// Manages:
// 1. 13 closed runtime states
// 2. Canonical legal state transitions table (fail-closed)
// 3. Generation and session identity fencing
// 4. Immutable state snapshots
// 5. Injected monotonic clock timestamping
// Zero engine execution, zero side effects.

import {
  type Clock,
  SystemMonotonicClock,
} from "./clock.ts";
import { RuntimeError } from "./errors.ts";
import {
  GenerationSchema,
  RuntimeSessionIdSchema,
  RuntimeStateSchema,
  type Generation,
  type RuntimeSessionId,
  type RuntimeState,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Canonical Legal Transitions Table (Frozen from P8-DESIGN-SPEC Section 6)
// ---------------------------------------------------------------------------

/**
 * Closed table of legal state transitions.
 * Any transition not explicitly enumerated here is strictly illegal and fails closed
 * with INVALID_STATE_TRANSITION.
 */
const TRANSITION_MAP: Record<RuntimeState, readonly RuntimeState[]> = {
  CREATED: ["VALIDATING", "RESETTING", "CLOSING"],
  VALIDATING: ["READY", "FAILED", "RESETTING", "CLOSING"],
  READY: ["RUNNING", "RESETTING", "CLOSING"],
  RUNNING: ["PAUSED", "CANCELLING", "COMPLETED", "FAILED", "HOLD", "RESETTING", "CLOSING"],
  PAUSED: ["RUNNING", "CANCELLING", "RESETTING", "CLOSING"],
  CANCELLING: ["CANCELLED", "HOLD", "RESETTING", "CLOSING"],
  CANCELLED: ["RESETTING", "CLOSING"],
  RESETTING: ["READY", "HOLD", "CLOSING"],
  COMPLETED: ["RESETTING", "CLOSING"],
  FAILED: ["RESETTING", "CLOSING"],
  HOLD: ["RESETTING", "CLOSING"],
  CLOSING: ["CLOSED"],
  CLOSED: [],
};

export const LEGAL_RUNTIME_STATE_TRANSITIONS: Readonly<Record<RuntimeState, readonly RuntimeState[]>> =
  Object.freeze(TRANSITION_MAP);

/** Checks if a state transition from `from` to `to` is legally permitted. */
export function isLegalStateTransition(from: RuntimeState, to: RuntimeState): boolean {
  const allowed = LEGAL_RUNTIME_STATE_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

// ---------------------------------------------------------------------------
// Snapshot & Transition Metadata DTOs
// ---------------------------------------------------------------------------

export interface RuntimeStateSnapshot {
  readonly state: RuntimeState;
  readonly sessionId: string;
  readonly generation: number;
  readonly isTerminal: boolean;
  readonly isExecutionTerminal: boolean;
  readonly timestampMs: number;
}

export interface TransitionRecord {
  readonly from: RuntimeState;
  readonly to: RuntimeState;
  readonly timestampMs: number;
  readonly reason?: string;
}

export interface TransitionOptions {
  readonly expectedSessionId?: string;
  readonly expectedGeneration?: number;
  readonly reason?: string;
}

export interface RuntimeStateMachineOptions {
  readonly sessionId: string;
  readonly generation?: number;
  readonly initialState?: RuntimeState;
  readonly clock?: Clock;
}

// ---------------------------------------------------------------------------
// RuntimeStateMachine Class
// ---------------------------------------------------------------------------

export class RuntimeStateMachine {
  private readonly sessionId: RuntimeSessionId;
  private generation: Generation;
  private state: RuntimeState;
  private readonly clock: Clock;
  private lastTransition: TransitionRecord | null = null;

  constructor(options: RuntimeStateMachineOptions) {
    this.sessionId = RuntimeSessionIdSchema.parse(options.sessionId);
    this.generation = GenerationSchema.parse(options.generation ?? 1);
    this.state = RuntimeStateSchema.parse(options.initialState ?? "CREATED");
    this.clock = options.clock ?? new SystemMonotonicClock();
  }

  getState(): RuntimeState {
    return this.state;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getGeneration(): number {
    return this.generation;
  }

  getLastTransition(): TransitionRecord | null {
    return this.lastTransition ? Object.freeze({ ...this.lastTransition }) : null;
  }

  /**
   * Returns true if the state is terminal for the runtime instance (CLOSED).
   * No further transitions or resets are possible.
   */
  isTerminalForInstance(): boolean {
    return this.state === "CLOSED";
  }

  /**
   * Returns true if the state represents terminal execution for the current lesson/generation
   * (COMPLETED, FAILED, CANCELLED, HOLD, CLOSED). Execution is halted until reset or close.
   */
  isTerminalForLessonExecution(): boolean {
    return (
      this.state === "COMPLETED" ||
      this.state === "FAILED" ||
      this.state === "CANCELLED" ||
      this.state === "HOLD" ||
      this.state === "CLOSED"
    );
  }

  /** True if lesson is actively executing steps. */
  isRunning(): boolean {
    return this.state === "RUNNING";
  }

  /** True if lesson execution is paused at a clean beat boundary. */
  isPaused(): boolean {
    return this.state === "PAUSED";
  }

  /** True if runtime is halted in the HOLD safety state. */
  isInHold(): boolean {
    return this.state === "HOLD";
  }

  /** True if runtime has been permanently closed. */
  isClosed(): boolean {
    return this.state === "CLOSED";
  }

  /** Checks if a proposed transition to target is legal from the current state. */
  canTransitionTo(target: RuntimeState): boolean {
    return isLegalStateTransition(this.state, target);
  }

  /**
   * Enforces that an incoming session ID matches this state machine's session.
   * Throws STALE_RUNTIME_SESSION if mismatched.
   */
  fenceSession(sessionId: string): void {
    if (sessionId !== this.sessionId) {
      throw new RuntimeError({
        code: "STALE_RUNTIME_SESSION",
        message: `Stale runtime session: expected '${this.sessionId}', got '${sessionId}'`,
      });
    }
  }

  /**
   * Enforces that an incoming generation matches this state machine's generation.
   * Throws STALE_GENERATION if mismatched.
   */
  fenceGeneration(generation: number): void {
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
      throw new RuntimeError({
        code: "STALE_GENERATION",
        message: `Invalid generation number: must be an integer >= 1 (got ${generation})`,
      });
    }
    if (generation !== this.generation) {
      throw new RuntimeError({
        code: "STALE_GENERATION",
        message: `Stale generation: expected ${this.generation}, got ${generation}`,
      });
    }
  }

  /**
   * Transitions the runtime state to target state.
   * Fails closed if the transition is illegal, throwing INVALID_STATE_TRANSITION.
   * Validates optional session and generation fencing.
   */
  transition(target: RuntimeState, options?: TransitionOptions): RuntimeStateSnapshot {
    // 1. Session fencing
    if (options?.expectedSessionId !== undefined) {
      this.fenceSession(options.expectedSessionId);
    }

    // 2. Generation fencing
    if (options?.expectedGeneration !== undefined) {
      this.fenceGeneration(options.expectedGeneration);
    }

    // 3. Transition legality check
    if (!isLegalStateTransition(this.state, target)) {
      throw new RuntimeError({
        code: "INVALID_STATE_TRANSITION",
        message: `Cannot transition from '${this.state}' to '${target}'${
          options?.reason ? `: ${options.reason}` : ""
        }`,
      });
    }

    const timestampMs = this.clock.now();
    const from = this.state;
    this.state = target;

    this.lastTransition = {
      from,
      to: target,
      timestampMs,
      reason: options?.reason,
    };

    return this.getSnapshot();
  }

  /**
   * Rotates generation to the next monotonic integer during coordinated reset.
   * May only be called while in RESETTING state.
   */
  rotateGeneration(newGeneration?: number): number {
    if (this.state !== "RESETTING") {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Cannot rotate generation in state '${this.state}' (must be 'RESETTING')`,
      });
    }

    const nextGen = newGeneration ?? this.generation + 1;
    if (typeof nextGen !== "number" || !Number.isInteger(nextGen) || nextGen <= this.generation) {
      throw new RuntimeError({
        code: "STALE_GENERATION",
        message: `Next generation must be an integer strictly greater than ${this.generation} (got ${nextGen})`,
      });
    }

    this.generation = GenerationSchema.parse(nextGen);
    return this.generation;
  }

  /** Returns an immutable, frozen snapshot of the state machine. */
  getSnapshot(): RuntimeStateSnapshot {
    return Object.freeze({
      state: this.state,
      sessionId: this.sessionId,
      generation: this.generation,
      isTerminal: this.isTerminalForInstance(),
      isExecutionTerminal: this.isTerminalForLessonExecution(),
      timestampMs: this.clock.now(),
    });
  }
}
