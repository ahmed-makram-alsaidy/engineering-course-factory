// Passive runtime orchestrator model — P8.7 Teaching IDE Runtime Projection.
// Canonical architecture: docs/P8-DESIGN-SPEC.md Section 25, ADR-0013.
//
// OWNERSHIP (design-exact, no phase creep):
//   - Pure UI state: derives the renderer's display view ONLY from canonical trusted
//     snapshots (runtime:getSnapshot) and trusted journal events (runtime:event).
//   - Zero execution authority: never advances playhead, never changes state machine,
//     never rotates generation, never chooses adapters, never modifies process ledger.
//   - Type-only engine protocol imports. No runtime engine code, no Electron import,
//     no node: import, no child_process / Playwright import.
//   - Session and generation fencing: stale events (wrong session_id or older generation)
//     are dropped fail-closed.
//   - Monotonic sequence fencing: duplicate or out-of-order events (global_seq <= journal_high_seq)
//     are dropped fail-closed.
//   - Event Replay / Reanchor: on startup or reload, renderer subscribes first,
//     then fetches snapshot to reanchor without dropping events or causing duplicate side effects.
//   - Errors map to UI-safe short messages from structured codes only.

import type {
  GlobalRuntimeEvent,
  RuntimeSnapshotDto,
  PlayheadDto,
  RuntimeState,
  TerminalStatus,
} from "@course-factory/runtime-orchestrator";

export type {
  GlobalRuntimeEvent,
  RuntimeSnapshotDto,
  PlayheadDto,
  RuntimeState,
  TerminalStatus,
};

export const MAX_SAFE_RUNTIME_ERROR_LENGTH = 120;

export interface RuntimeViewState {
  readonly session_id: string | null;
  readonly lesson_id: string | null;
  readonly generation: number;
  readonly state: RuntimeState | "NOT_STARTED";
  readonly playhead: PlayheadDto | null;
  readonly active_process_ids: readonly string[];
  readonly last_outcome: TerminalStatus | null;
  readonly journal_high_seq: number;
  readonly latest_event: GlobalRuntimeEvent | null;
  readonly subscription_active: boolean;
  readonly error_message: string | null;
  readonly events_received: number;
  readonly events_applied: number;
  readonly stale_events_dropped: number;
}

export function initialRuntimeViewState(): RuntimeViewState {
  return {
    session_id: null,
    lesson_id: null,
    generation: 0,
    state: "NOT_STARTED",
    playhead: null,
    active_process_ids: [],
    last_outcome: null,
    journal_high_seq: 0,
    latest_event: null,
    subscription_active: false,
    error_message: null,
    events_received: 0,
    events_applied: 0,
    stale_events_dropped: 0,
  };
}

/** Redacts local drive letters, UNC paths, and limits length to 120 characters. */
export function sanitizeRuntimeError(rawMessage: string | null | undefined): string {
  if (!rawMessage) return "Runtime error occurred";
  let cleaned = rawMessage
    .replace(/[A-Za-z]:[\\/][^\s"'`]*/g, "[path]")
    .replace(/\/home\/[^\s"'`]*/g, "[path]")
    .replace(/\\\\[^\s"'`]*/g, "[path]");
  if (cleaned.length > MAX_SAFE_RUNTIME_ERROR_LENGTH) {
    cleaned = cleaned.slice(0, MAX_SAFE_RUNTIME_ERROR_LENGTH) + "...";
  }
  return cleaned;
}

/**
 * Re-anchors the renderer runtime state from a trusted snapshot.
 * Passive only: zero engine execution.
 */
export function applyRuntimeSnapshot(
  state: RuntimeViewState,
  snapshot: RuntimeSnapshotDto,
): RuntimeViewState {
  if (!snapshot || typeof snapshot !== "object") {
    return state;
  }

  return {
    ...state,
    session_id: snapshot.runtime_session_id,
    lesson_id: snapshot.lesson_id,
    generation: snapshot.generation,
    state: snapshot.state,
    playhead: snapshot.playhead,
    active_process_ids: Object.freeze([...snapshot.active_process_ids]),
    last_outcome: snapshot.last_outcome,
    journal_high_seq: Math.max(state.journal_high_seq, snapshot.journal_high_seq),
    error_message: null,
  };
}

/**
 * Applies a trusted GlobalRuntimeEvent to the passive runtime view state.
 * Enforces session fencing, generation fencing, and monotonic global_seq order.
 */
export function applyGlobalRuntimeEvent(
  state: RuntimeViewState,
  event: GlobalRuntimeEvent,
): RuntimeViewState {
  const eventsReceived = state.events_received + 1;

  if (!event || typeof event !== "object") {
    return {
      ...state,
      events_received: eventsReceived,
      stale_events_dropped: state.stale_events_dropped + 1,
    };
  }

  // 1. Session fencing: ignore event if session does not match
  if (state.session_id !== null && event.runtime_session_id !== state.session_id) {
    return {
      ...state,
      events_received: eventsReceived,
      stale_events_dropped: state.stale_events_dropped + 1,
    };
  }

  // 2. Generation fencing: ignore events from older generation
  if (state.generation > 0 && event.generation < state.generation) {
    return {
      ...state,
      events_received: eventsReceived,
      stale_events_dropped: state.stale_events_dropped + 1,
    };
  }

  // 3. Monotonic sequence fencing: drop duplicate or backwards seq within same generation
  if (
    state.generation > 0 &&
    event.generation === state.generation &&
    event.global_seq <= state.journal_high_seq
  ) {
    return {
      ...state,
      events_received: eventsReceived,
      stale_events_dropped: state.stale_events_dropped + 1,
    };
  }

  // 4. Derive state transitions purely passively from lifecycle events
  let nextState = state.state;
  let nextOutcome = state.last_outcome;

  if (event.kind === "lifecycle") {
    switch (event.event_type) {
      case "runtime.started":
        nextState = "RUNNING";
        break;
      case "runtime.paused":
        nextState = "PAUSED";
        break;
      case "runtime.resumed":
        nextState = "RUNNING";
        break;
      case "runtime.cancelling":
        nextState = "CANCELLING";
        break;
      case "runtime.cancelled":
        nextState = "CANCELLED";
        break;
      case "runtime.resetting":
        nextState = "RESETTING";
        break;
      case "runtime.reset":
        nextState = "READY";
        break;
      case "runtime.completed":
        nextState = "COMPLETED";
        break;
      case "runtime.closing":
        nextState = "CLOSING";
        break;
      case "runtime.closed":
        nextState = "CLOSED";
        break;
    }
  }

  if (event.outcome) {
    nextOutcome = event.outcome;
    if (event.outcome === "FAILED") {
      nextState = "FAILED";
    } else if (event.outcome === "UNCERTAIN") {
      nextState = "HOLD";
    }
  }

  return {
    ...state,
    session_id: state.session_id ?? event.runtime_session_id,
    lesson_id: state.lesson_id ?? event.lesson_id,
    generation: Math.max(state.generation, event.generation),
    state: nextState,
    last_outcome: nextOutcome,
    journal_high_seq: event.global_seq,
    latest_event: event,
    events_received: eventsReceived,
    events_applied: state.events_applied + 1,
  };
}

/**
 * Re-anchors renderer state after establishing subscription.
 * Idempotent, passive, safe against gaps.
 */
export function reanchorRuntimeState(
  current: RuntimeViewState,
  snapshot: RuntimeSnapshotDto,
): RuntimeViewState {
  return applyRuntimeSnapshot(current, snapshot);
}
