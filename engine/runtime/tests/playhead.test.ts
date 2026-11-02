// P8.3 Playhead Cursor & Attempt Identity Unit Tests
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 7 & Section 15,
// and docs/adr/ADR-0013-runtime-orchestration-boundary.md.
//
// Tests playhead initialization from ValidatedRuntimePlan,
// proof-authorized single-step advancement, scene boundary crossing,
// end-of-plan semantics, attempt identity progression, and stale fencing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RuntimeError } from "../src/errors.ts";
import {
  PlayheadCursor,
  formatAttemptId,
  parseAttemptNumber,
  type StepCompletionCommitProof,
} from "../src/playhead.ts";
import { PlayheadDtoSchema } from "../src/protocol.ts";
import { validateLesson, type ValidatedRuntimePlan } from "../src/validator.ts";
import { createCanonicalReferenceLesson } from "./fixtures.ts";

/** Helper to build a canonical single-scene validated plan (14 steps). */
function createCanonicalValidatedPlan(): ValidatedRuntimePlan {
  const lesson = createCanonicalReferenceLesson();
  const report = validateLesson(lesson);
  assert.equal(report.ok, true, `Validation failed: ${JSON.stringify(report.errors)}`);
  assert.ok(report.plan !== null);
  return report.plan;
}

/** Helper to build a validated multi-scene plan (Scene 1: 7 steps, Scene 2: 7 steps, total 14 steps). */
function createMultiSceneValidatedPlan(): ValidatedRuntimePlan {
  const lesson = createCanonicalReferenceLesson();
  const s1Steps = lesson.scenes[0]!.steps.slice(0, 7); // steps 1-7
  const s2Steps = lesson.scenes[0]!.steps.slice(7);    // steps 8-14

  lesson.scenes[0]!.steps = s1Steps;

  lesson.scenes.push({
    scene_id: "C01-L001-S002",
    ordinal: 2,
    type: "code_demo",
    title: "Scene 2: Browser and Teardown",
    duration_seconds: 150,
    narration_form: "beats",
    visual: { kind: "browser", description: "Browser scene" },
    on_screen_text: [],
    blocks: [],
    assets: [],
    steps: s2Steps.map((s, idx) => ({
      ...s,
      step_id: s.step_id.replace("-S001-", "-S002-"),
      ordinal: idx + 1,
      source_ref: {
        ...s.source_ref,
        scene_id: "C01-L001-S002",
        scene_ordinal: 2,
        beat_id: s.source_ref.beat_id?.replace("-S001-", "-S002-") ?? null,
      },
    })),
  });

  const report = validateLesson(lesson);
  assert.equal(report.ok, true, `Validation failed: ${JSON.stringify(report.errors)}`);
  assert.ok(report.plan !== null);
  return report.plan;
}

describe("P8.3: Playhead Cursor & Attempt Identity", () => {
  describe("Attempt Identity Helpers", () => {
    it("formats integer attempt number to canonical AttemptId", () => {
      assert.equal(formatAttemptId(1), "A001");
      assert.equal(formatAttemptId(2), "A002");
      assert.equal(formatAttemptId(12), "A012");
      assert.equal(formatAttemptId(123), "A123");
    });

    it("rejects non-positive integer attempt numbers", () => {
      assert.throws(() => formatAttemptId(0), (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST");
      assert.throws(() => formatAttemptId(-1), (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST");
      assert.throws(() => formatAttemptId(1.5), (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST");
    });

    it("parses canonical AttemptId to integer attempt number", () => {
      assert.equal(parseAttemptNumber("A001"), 1);
      assert.equal(parseAttemptNumber("A002"), 2);
      assert.equal(parseAttemptNumber("A042"), 42);
    });

    it("parse rejects invalid attempt strings", () => {
      assert.throws(() => parseAttemptNumber("B001"));
      assert.throws(() => parseAttemptNumber("A01"));
    });
  });

  describe("Playhead Initialization from ValidatedRuntimePlan", () => {
    it("initializes cursor at first step of plan", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);

      assert.equal(playhead.getLessonId(), "C01-L001");
      assert.equal(playhead.getGeneration(), 1);
      assert.equal(playhead.getAttemptId(), "A001");
      assert.equal(playhead.isAtEnd(), false);
      assert.equal(playhead.getRemainingStepsCount(), 14);

      const snap = playhead.getSnapshot();
      assert.equal(snap.lesson_id, "C01-L001");
      assert.equal(snap.scene_index, 0);
      assert.equal(snap.scene_id, "C01-L001-S001");
      assert.equal(snap.step_index, 0);
      assert.equal(snap.step_id, "C01-L001-S001-B001");
      assert.equal(snap.global_step_ordinal, 1);
      assert.equal(snap.total_steps, 14);
      assert.equal(snap.attempt_id, "A001");
      assert.equal(snap.generation, 1);

      // Verifies conformance to PlayheadDtoSchema
      PlayheadDtoSchema.parse(snap);
    });

    it("rejects null or invalid plans fail-closed", () => {
      assert.throws(
        () => PlayheadCursor.createFromPlan(null as any),
        (err: unknown) => err instanceof RuntimeError && err.code === "RUNTIME_INVALID_LESSON"
      );

      assert.throws(
        () => PlayheadCursor.createFromPlan({ ordered_steps: [] } as any),
        (err: unknown) => err instanceof RuntimeError && err.code === "RUNTIME_INVALID_LESSON"
      );
    });
  });

  describe("Attempt Identity Rules & SAFE_TO_RETRY", () => {
    it("initial attempt is A001 and increments only on SAFE_TO_RETRY", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);

      assert.equal(playhead.getAttemptId(), "A001");

      const attempt2 = playhead.nextAttempt({ retry: "SAFE_TO_RETRY" });
      assert.equal(attempt2, "A002");
      assert.equal(playhead.getAttemptId(), "A002");

      const attempt3 = playhead.nextAttempt({ retry: "SAFE_TO_RETRY" });
      assert.equal(attempt3, "A003");
      assert.equal(playhead.getAttemptId(), "A003");
    });

    it("rejects attempt increment for UNCERTAIN_DO_NOT_RETRY", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);

      assert.throws(
        () => playhead.nextAttempt({ retry: "UNCERTAIN_DO_NOT_RETRY" }),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
      assert.equal(playhead.getAttemptId(), "A001");
    });

    it("rejects attempt increment for NOT_RETRYABLE", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);

      assert.throws(
        () => playhead.nextAttempt({ retry: "NOT_RETRYABLE" }),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
    });

    it("rejects attempt increment for REQUIRES_RESET", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);

      assert.throws(
        () => playhead.nextAttempt({ retry: "REQUIRES_RESET" }),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
    });

    it("isStaleAttempt identifies previous attempts as stale", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);

      assert.equal(playhead.isStaleAttempt("A001"), false);
      playhead.nextAttempt({ retry: "SAFE_TO_RETRY" });

      assert.equal(playhead.isStaleAttempt("A001"), true);
      assert.equal(playhead.isStaleAttempt("A002"), false);
    });

    it("fenceAttempt throws STALE_GENERATION on stale attempt", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);
      playhead.nextAttempt({ retry: "SAFE_TO_RETRY" });

      assert.throws(
        () => playhead.fenceAttempt("A001"),
        (err: unknown) => err instanceof RuntimeError && err.code === "STALE_GENERATION"
      );
      assert.doesNotThrow(() => playhead.fenceAttempt("A002"));
    });
  });

  describe("Proof-Authorized Advancement & Scene Crossing", () => {
    it("advances strictly after committed COMPLETED proof", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);

      const firstStep = plan.ordered_steps[0]!;
      const proof1: StepCompletionCommitProof = {
        lesson_id: plan.lesson_id,
        scene_id: firstStep.scene_id,
        step_id: firstStep.step_id,
        global_step_ordinal: firstStep.global_step_ordinal,
        attempt_id: "A001",
        generation: 1,
        status: "COMPLETED",
        journal_seq: 1,
        committed: true,
      };

      const res = playhead.advance(proof1);
      assert.equal(res.advanced, true);
      assert.equal(res.endOfPlan, false);
      assert.equal(res.playhead.global_step_ordinal, 2);
      assert.equal(res.playhead.step_id, plan.ordered_steps[1]!.step_id);
      assert.equal(res.playhead.step_index, 1);
      assert.equal(res.playhead.scene_index, 0);
    });

    it("correctly crosses scene boundary from Scene 1 step 7 to Scene 2 step 1", () => {
      const plan = createMultiSceneValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);

      // Advance through Scene 1 (steps 1 through 7)
      for (let i = 0; i < 6; i++) {
        const step = plan.ordered_steps[i]!;
        playhead.advance({
          lesson_id: plan.lesson_id,
          scene_id: step.scene_id,
          step_id: step.step_id,
          global_step_ordinal: step.global_step_ordinal,
          attempt_id: "A001",
          generation: 1,
          status: "COMPLETED",
          journal_seq: i + 1,
          committed: true,
        });
      }

      // Now at Step 7 (last step of Scene 1, index 6)
      const atStep7 = playhead.getSnapshot();
      assert.equal(atStep7.scene_index, 0);
      assert.equal(atStep7.step_index, 6);
      assert.equal(atStep7.global_step_ordinal, 7);

      // Advance step 7 -> crosses scene boundary to Scene 2, step 1!
      const step7 = plan.ordered_steps[6]!;
      const res = playhead.advance({
        lesson_id: plan.lesson_id,
        scene_id: step7.scene_id,
        step_id: step7.step_id,
        global_step_ordinal: step7.global_step_ordinal,
        attempt_id: "A001",
        generation: 1,
        status: "COMPLETED",
        journal_seq: 7,
        committed: true,
      });

      assert.equal(res.advanced, true);
      assert.equal(res.endOfPlan, false);
      // New position is Scene 2, Step 1 (global ordinal 8)
      assert.equal(res.playhead.scene_index, 1);
      assert.equal(res.playhead.scene_id, "C01-L001-S002");
      assert.equal(res.playhead.step_index, 0);
      assert.equal(res.playhead.global_step_ordinal, 8);
      assert.equal(res.playhead.attempt_id, "A001"); // reset for new step
    });

    it("final step completion marks endOfPlan and prevents further advance", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);

      // Advance all 14 steps
      for (let i = 0; i < plan.total_steps; i++) {
        const step = plan.ordered_steps[i]!;
        const res = playhead.advance({
          lesson_id: plan.lesson_id,
          scene_id: step.scene_id,
          step_id: step.step_id,
          global_step_ordinal: step.global_step_ordinal,
          attempt_id: "A001",
          generation: 1,
          status: "COMPLETED",
          journal_seq: i + 1,
          committed: true,
        });

        if (i === plan.total_steps - 1) {
          assert.equal(res.advanced, true);
          assert.equal(res.endOfPlan, true);
        } else {
          assert.equal(res.advanced, true);
          assert.equal(res.endOfPlan, false);
        }
      }

      assert.equal(playhead.isAtEnd(), true);
      assert.equal(playhead.getRemainingStepsCount(), 0);
      assert.equal(playhead.getSnapshot().global_step_ordinal, 14);

      // Attempting further advance returns endOfPlan: true, advanced: false
      const lastStep = plan.ordered_steps[plan.total_steps - 1]!;
      const overRes = playhead.advance({
        lesson_id: plan.lesson_id,
        scene_id: lastStep.scene_id,
        step_id: lastStep.step_id,
        global_step_ordinal: lastStep.global_step_ordinal,
        attempt_id: "A001",
        generation: 1,
        status: "COMPLETED",
        journal_seq: 100,
        committed: true,
      });
      assert.equal(overRes.advanced, false);
      assert.equal(overRes.endOfPlan, true);
    });
  });

  describe("Proof Rejection & Fail-Closed Invariants", () => {
    it("rejects proof with uncommitted flag", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);
      const firstStep = plan.ordered_steps[0]!;

      assert.throws(
        () =>
          playhead.advance({
            lesson_id: plan.lesson_id,
            scene_id: firstStep.scene_id,
            step_id: firstStep.step_id,
            global_step_ordinal: firstStep.global_step_ordinal,
            attempt_id: "A001",
            generation: 1,
            status: "COMPLETED",
            journal_seq: 1,
            committed: false as any,
          }),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
      assert.equal(playhead.getSnapshot().global_step_ordinal, 1);
    });

    it("rejects proof with non-COMPLETED status", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);
      const firstStep = plan.ordered_steps[0]!;

      assert.throws(
        () =>
          playhead.advance({
            lesson_id: plan.lesson_id,
            scene_id: firstStep.scene_id,
            step_id: firstStep.step_id,
            global_step_ordinal: firstStep.global_step_ordinal,
            attempt_id: "A001",
            generation: 1,
            status: "FAILED" as any,
            journal_seq: 1,
            committed: true,
          }),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
    });

    it("rejects proof with stale generation", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan, { generation: 2 });
      const firstStep = plan.ordered_steps[0]!;

      assert.throws(
        () =>
          playhead.advance({
            lesson_id: plan.lesson_id,
            scene_id: firstStep.scene_id,
            step_id: firstStep.step_id,
            global_step_ordinal: firstStep.global_step_ordinal,
            attempt_id: "A001",
            generation: 1, // stale!
            status: "COMPLETED",
            journal_seq: 1,
            committed: true,
          }),
        (err: unknown) => err instanceof RuntimeError && err.code === "STALE_GENERATION"
      );
    });

    it("rejects proof with stale attempt after attempt increment", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);
      const firstStep = plan.ordered_steps[0]!;
      // Increment attempt to A002
      playhead.nextAttempt({ retry: "SAFE_TO_RETRY" });

      // Late arrival proof from A001
      assert.throws(
        () =>
          playhead.advance({
            lesson_id: plan.lesson_id,
            scene_id: firstStep.scene_id,
            step_id: firstStep.step_id,
            global_step_ordinal: firstStep.global_step_ordinal,
            attempt_id: "A001", // stale attempt!
            generation: 1,
            status: "COMPLETED",
            journal_seq: 1,
            committed: true,
          }),
        (err: unknown) => err instanceof RuntimeError && err.code === "STALE_GENERATION"
      );
      assert.equal(playhead.getSnapshot().global_step_ordinal, 1);
    });

    it("rejects proof targeting wrong step or out-of-order step", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);
      const secondStep = plan.ordered_steps[1]!;

      assert.throws(
        () =>
          playhead.advance({
            lesson_id: plan.lesson_id,
            scene_id: secondStep.scene_id,
            step_id: secondStep.step_id, // step 2 instead of 1!
            global_step_ordinal: secondStep.global_step_ordinal,
            attempt_id: "A001",
            generation: 1,
            status: "COMPLETED",
            journal_seq: 1,
            committed: true,
          }),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
    });

    it("rejects duplicate completion with same or lower journal_seq", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);
      const firstStep = plan.ordered_steps[0]!;
      const secondStep = plan.ordered_steps[1]!;

      playhead.advance({
        lesson_id: plan.lesson_id,
        scene_id: firstStep.scene_id,
        step_id: firstStep.step_id,
        global_step_ordinal: firstStep.global_step_ordinal,
        attempt_id: "A001",
        generation: 1,
        status: "COMPLETED",
        journal_seq: 10,
        committed: true,
      });

      // Next step with lower journal_seq: rejected
      assert.throws(
        () =>
          playhead.advance({
            lesson_id: plan.lesson_id,
            scene_id: secondStep.scene_id,
            step_id: secondStep.step_id,
            global_step_ordinal: secondStep.global_step_ordinal,
            attempt_id: "A001",
            generation: 1,
            status: "COMPLETED",
            journal_seq: 10, // duplicate or non-increasing!
            committed: true,
          }),
        (err: unknown) => err instanceof RuntimeError && err.code === "DUPLICATE_OPERATION"
      );
    });
  });

  describe("Reset for New Generation", () => {
    it("resets playhead cursor back to start for new generation", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan);
      const firstStep = plan.ordered_steps[0]!;

      // Advance one step
      playhead.advance({
        lesson_id: plan.lesson_id,
        scene_id: firstStep.scene_id,
        step_id: firstStep.step_id,
        global_step_ordinal: firstStep.global_step_ordinal,
        attempt_id: "A001",
        generation: 1,
        status: "COMPLETED",
        journal_seq: 1,
        committed: true,
      });
      assert.equal(playhead.getSnapshot().global_step_ordinal, 2);

      // Reset for generation 2
      playhead.reset(2);
      assert.equal(playhead.getGeneration(), 2);
      assert.equal(playhead.getAttemptId(), "A001");
      assert.equal(playhead.isAtEnd(), false);
      assert.equal(playhead.getSnapshot().global_step_ordinal, 1);
    });

    it("reset rejects non-greater generation", () => {
      const plan = createCanonicalValidatedPlan();
      const playhead = PlayheadCursor.createFromPlan(plan, { generation: 2 });

      assert.throws(
        () => playhead.reset(2),
        (err: unknown) => err instanceof RuntimeError && err.code === "STALE_GENERATION"
      );
      assert.throws(
        () => playhead.reset(1),
        (err: unknown) => err instanceof RuntimeError && err.code === "STALE_GENERATION"
      );
    });
  });
});
