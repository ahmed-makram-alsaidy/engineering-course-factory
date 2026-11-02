// P8.3 Runtime State Machine Exhaustive Unit Tests
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 6 & Section 14,
// and docs/adr/ADR-0013-runtime-orchestration-boundary.md.
//
// Tests all 13 states, every legal transition, all illegal transitions,
// generation/session fencing, snapshot immutability, and terminal classification.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManualLogicalClock } from "../src/clock.ts";
import { RuntimeError } from "../src/errors.ts";
import { RUNTIME_STATES, type RuntimeState } from "../src/protocol.ts";
import {
  RuntimeStateMachine,
  LEGAL_RUNTIME_STATE_TRANSITIONS,
  isLegalStateTransition,
} from "../src/state-machine.ts";

describe("P8.3: Runtime State Machine", () => {
  const defaultSessionId = "sess-p83-test-001";

  describe("13 States Vocabulary & Invariants", () => {
    it("contains exactly the 13 canonical frozen states", () => {
      assert.equal(RUNTIME_STATES.length, 13);
      const expected: RuntimeState[] = [
        "CREATED",
        "VALIDATING",
        "READY",
        "RUNNING",
        "PAUSED",
        "CANCELLING",
        "CANCELLED",
        "RESETTING",
        "COMPLETED",
        "FAILED",
        "HOLD",
        "CLOSING",
        "CLOSED",
      ];
      assert.deepEqual([...RUNTIME_STATES], expected);
    });

    it("begins in CREATED initial state by default", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId });
      assert.equal(sm.getState(), "CREATED");
      assert.equal(sm.getGeneration(), 1);
      assert.equal(sm.getSessionId(), defaultSessionId);
      assert.equal(sm.isTerminalForInstance(), false);
      assert.equal(sm.isTerminalForLessonExecution(), false);
    });

    it("allows specifying valid initial state", () => {
      const sm = new RuntimeStateMachine({
        sessionId: defaultSessionId,
        initialState: "READY",
        generation: 2,
      });
      assert.equal(sm.getState(), "READY");
      assert.equal(sm.getGeneration(), 2);
    });
  });

  describe("Legal State Transitions Table Completeness", () => {
    it("every legal transition listed in table succeeds", () => {
      for (const fromState of RUNTIME_STATES) {
        const allowedTargets = LEGAL_RUNTIME_STATE_TRANSITIONS[fromState];
        for (const targetState of allowedTargets) {
          const sm = new RuntimeStateMachine({
            sessionId: defaultSessionId,
            initialState: fromState,
          });

          assert.equal(
            sm.canTransitionTo(targetState),
            true,
            `Expected canTransitionTo('${targetState}') from '${fromState}' to be true`
          );

          const snap = sm.transition(targetState, { reason: `Testing ${fromState}->${targetState}` });
          assert.equal(snap.state, targetState);
          assert.equal(sm.getState(), targetState);
        }
      }
    });

    it("every illegal transition rejects with INVALID_STATE_TRANSITION", () => {
      for (const fromState of RUNTIME_STATES) {
        const allowedTargets = new Set(LEGAL_RUNTIME_STATE_TRANSITIONS[fromState]);
        for (const candidateTarget of RUNTIME_STATES) {
          if (!allowedTargets.has(candidateTarget)) {
            assert.equal(
              isLegalStateTransition(fromState, candidateTarget),
              false,
              `Transition from '${fromState}' to '${candidateTarget}' must be illegal`
            );

            const sm = new RuntimeStateMachine({
              sessionId: defaultSessionId,
              initialState: fromState,
            });

            assert.equal(
              sm.canTransitionTo(candidateTarget),
              false,
              `canTransitionTo('${candidateTarget}') from '${fromState}' must be false`
            );

            assert.throws(
              () => sm.transition(candidateTarget),
              (err: unknown) => {
                assert.ok(err instanceof RuntimeError);
                assert.equal(err.code, "INVALID_STATE_TRANSITION");
                assert.ok(err.message.includes(`Cannot transition from '${fromState}' to '${candidateTarget}'`));
                return true;
              }
            );

            // State remains untouched
            assert.equal(sm.getState(), fromState);
          }
        }
      }
    });

    it("duplicate same-state transition is strictly illegal and fails closed", () => {
      for (const state of RUNTIME_STATES) {
        const sm = new RuntimeStateMachine({
          sessionId: defaultSessionId,
          initialState: state,
        });

        assert.equal(sm.canTransitionTo(state), false);
        assert.throws(
          () => sm.transition(state),
          (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_STATE_TRANSITION"
        );
      }
    });
  });

  describe("Canonical State Transition Scenarios", () => {
    it("CREATED -> VALIDATING -> READY -> RUNNING lifecycle", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId });
      assert.equal(sm.getState(), "CREATED");

      sm.transition("VALIDATING");
      assert.equal(sm.getState(), "VALIDATING");

      sm.transition("READY");
      assert.equal(sm.getState(), "READY");

      sm.transition("RUNNING");
      assert.equal(sm.getState(), "RUNNING");
      assert.equal(sm.isRunning(), true);
    });

    it("CREATED cannot jump directly to RUNNING", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId });
      assert.throws(
        () => sm.transition("RUNNING"),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_STATE_TRANSITION"
      );
    });

    it("VALIDATING canonical failures transition to FAILED", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "VALIDATING" });
      sm.transition("FAILED");
      assert.equal(sm.getState(), "FAILED");
      assert.equal(sm.isTerminalForLessonExecution(), true);
    });

    it("RUNNING -> PAUSED -> RUNNING cycle", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "RUNNING" });
      sm.transition("PAUSED");
      assert.equal(sm.isPaused(), true);

      sm.transition("RUNNING");
      assert.equal(sm.isRunning(), true);
    });

    it("PAUSED -> CANCELLING -> CANCELLED cycle", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "PAUSED" });
      sm.transition("CANCELLING");
      assert.equal(sm.getState(), "CANCELLING");

      sm.transition("CANCELLED");
      assert.equal(sm.getState(), "CANCELLED");
      assert.equal(sm.isTerminalForLessonExecution(), true);
    });

    it("RUNNING -> CANCELLING -> CANCELLED cycle", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "RUNNING" });
      sm.transition("CANCELLING");
      sm.transition("CANCELLED");
      assert.equal(sm.getState(), "CANCELLED");
    });

    it("RUNNING -> COMPLETED marks execution terminal but allows reset", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "RUNNING" });
      sm.transition("COMPLETED");
      assert.equal(sm.getState(), "COMPLETED");
      assert.equal(sm.isTerminalForLessonExecution(), true);
      assert.equal(sm.isTerminalForInstance(), false);

      sm.transition("RESETTING");
      assert.equal(sm.getState(), "RESETTING");
      sm.transition("READY");
      assert.equal(sm.getState(), "READY");
    });

    it("RUNNING -> FAILED marks execution terminal and allows reset", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "RUNNING" });
      sm.transition("FAILED");
      assert.equal(sm.getState(), "FAILED");
      assert.equal(sm.isTerminalForLessonExecution(), true);

      sm.transition("RESETTING");
      assert.equal(sm.getState(), "RESETTING");
    });

    it("RUNNING -> HOLD represents first-class safety halt", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "RUNNING" });
      sm.transition("HOLD", { reason: "COMMIT_UNCERTAIN during NTFS publication" });
      assert.equal(sm.isInHold(), true);
      assert.equal(sm.isTerminalForLessonExecution(), true);

      // HOLD cannot resume or jump to READY
      assert.throws(
        () => sm.transition("RUNNING"),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_STATE_TRANSITION"
      );
      assert.throws(
        () => sm.transition("READY"),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_STATE_TRANSITION"
      );
      assert.throws(
        () => sm.transition("FAILED"),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_STATE_TRANSITION"
      );

      // Only canonical reset or close paths exist from HOLD
      assert.equal(sm.canTransitionTo("RESETTING"), true);
      assert.equal(sm.canTransitionTo("CLOSING"), true);
    });

    it("RESETTING teardown failure transitions to HOLD", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "RESETTING" });
      sm.transition("HOLD", { reason: "CLEANUP_UNCONFIRMED: container lingering" });
      assert.equal(sm.getState(), "HOLD");
    });

    it("CLOSED is truly final with zero outgoing transitions", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "CLOSING" });
      sm.transition("CLOSED");
      assert.equal(sm.isClosed(), true);
      assert.equal(sm.isTerminalForInstance(), true);
      assert.equal(sm.isTerminalForLessonExecution(), true);

      for (const target of RUNTIME_STATES) {
        assert.equal(sm.canTransitionTo(target), false);
        assert.throws(
          () => sm.transition(target),
          (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_STATE_TRANSITION"
        );
      }
    });
  });

  describe("Session & Generation Fencing", () => {
    it("rejects transition when expected session ID does not match", () => {
      const sm = new RuntimeStateMachine({ sessionId: "sess-valid-001", initialState: "READY" });

      assert.throws(
        () => sm.transition("RUNNING", { expectedSessionId: "sess-different-002" }),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "STALE_RUNTIME_SESSION");
          return true;
        }
      );
      assert.equal(sm.getState(), "READY");
    });

    it("accepts transition when expected session ID matches", () => {
      const sm = new RuntimeStateMachine({ sessionId: "sess-valid-001", initialState: "READY" });
      sm.transition("RUNNING", { expectedSessionId: "sess-valid-001" });
      assert.equal(sm.getState(), "RUNNING");
    });

    it("rejects transition when expected generation does not match", () => {
      const sm = new RuntimeStateMachine({
        sessionId: defaultSessionId,
        initialState: "READY",
        generation: 3,
      });

      assert.throws(
        () => sm.transition("RUNNING", { expectedGeneration: 2 }),
        (err: unknown) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, "STALE_GENERATION");
          return true;
        }
      );
      assert.equal(sm.getState(), "READY");
    });

    it("rotateGeneration advances generation only in RESETTING state", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "RUNNING", generation: 1 });

      // In RUNNING state: cannot rotate generation
      assert.throws(
        () => sm.rotateGeneration(),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );

      sm.transition("RESETTING");
      const nextGen = sm.rotateGeneration();
      assert.equal(nextGen, 2);
      assert.equal(sm.getGeneration(), 2);

      // Rotate with explicit valid number
      const explicitGen = sm.rotateGeneration(5);
      assert.equal(explicitGen, 5);
      assert.equal(sm.getGeneration(), 5);

      // Reject non-greater generation
      assert.throws(
        () => sm.rotateGeneration(5),
        (err: unknown) => err instanceof RuntimeError && err.code === "STALE_GENERATION"
      );
      assert.throws(
        () => sm.rotateGeneration(3),
        (err: unknown) => err instanceof RuntimeError && err.code === "STALE_GENERATION"
      );
    });
  });

  describe("Snapshot Immutability & Clock Timestamping", () => {
    it("uses injected clock to record deterministic transition timestamps", () => {
      const clock = new ManualLogicalClock(500);
      const sm = new RuntimeStateMachine({
        sessionId: defaultSessionId,
        initialState: "READY",
        clock,
      });

      clock.advanceBy(200); // clock is 700
      const snap = sm.transition("RUNNING");
      assert.equal(snap.timestampMs, 700);

      const last = sm.getLastTransition();
      assert.ok(last !== null);
      assert.equal(last.from, "READY");
      assert.equal(last.to, "RUNNING");
      assert.equal(last.timestampMs, 700);
    });

    it("snapshots are immutable frozen objects", () => {
      const sm = new RuntimeStateMachine({ sessionId: defaultSessionId, initialState: "READY" });
      const snap = sm.getSnapshot();
      assert.equal(Object.isFrozen(snap), true);

      assert.throws(() => {
        (snap as any).state = "FAILED";
      });
    });
  });
});
