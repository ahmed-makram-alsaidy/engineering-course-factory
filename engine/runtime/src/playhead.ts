// P8.3 Playhead Cursor & Attempt Identity
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 7 & Section 15,
// and docs/adr/ADR-0013-runtime-orchestration-boundary.md.
//
// Manages:
// 1. Playhead cursor initialized exclusively from ValidatedRuntimePlan
// 2. Proof-authorized advancement strictly AFTER engine COMPLETED and journal commit
// 3. Main-owned attempt identity and SAFE_TO_RETRY retry increment rules
// 4. Stale attempt and generation fencing
// 5. Scene boundary crossing and end-of-plan semantics
// Zero speculative advancement, zero renderer-driven cursor seeking.

import { RuntimeError, type RetryCategory } from "./errors.ts";
import {
  AttemptIdSchema,
  GenerationSchema,
  PlayheadDtoSchema,
  type AttemptId,
  type Generation,
  type PlayheadDto,
} from "./protocol.ts";
import type { ValidatedRuntimePlan, ValidatedStepPlan } from "./validator.ts";

// ---------------------------------------------------------------------------
// Attempt Formatting & Parsing Helpers
// ---------------------------------------------------------------------------

/** Formats integer attempt number into canonical AttemptId ("A001", "A002", etc.). */
export function formatAttemptId(attemptNumber: number): AttemptId {
  if (typeof attemptNumber !== "number" || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new RuntimeError({
      code: "INVALID_REQUEST",
      message: `Attempt number must be an integer >= 1 (got ${attemptNumber})`,
    });
  }
  const formatted = `A${String(attemptNumber).padStart(3, "0")}`;
  return AttemptIdSchema.parse(formatted);
}

/** Parses canonical AttemptId ("A001") to integer attempt number (1). */
export function parseAttemptNumber(attemptId: string): number {
  AttemptIdSchema.parse(attemptId);
  return parseInt(attemptId.slice(1), 10);
}

// ---------------------------------------------------------------------------
// Advancement Authorization Proof Interface
// ---------------------------------------------------------------------------

/**
 * Proof required to authorize playhead advancement.
 * The playhead advances strictly AFTER owning engine returns COMPLETED
 * and the event is committed to Global Journal.
 */
export interface StepCompletionCommitProof {
  readonly lesson_id: string;
  readonly scene_id: string;
  readonly step_id: string;
  readonly global_step_ordinal: number;
  readonly attempt_id: string;
  readonly generation: number;
  readonly status: "COMPLETED";
  readonly journal_seq: number;
  readonly committed: true;
}

export interface PlayheadAdvanceResult {
  readonly advanced: boolean;
  readonly endOfPlan: boolean;
  readonly playhead: PlayheadDto;
}

export interface PlayheadCursorOptions {
  readonly generation?: number;
  readonly initialAttemptId?: string;
}

// ---------------------------------------------------------------------------
// PlayheadCursor Class
// ---------------------------------------------------------------------------

export class PlayheadCursor {
  private readonly plan: ValidatedRuntimePlan;
  private currentStepPlanIndex = 0;
  private currentGeneration: Generation;
  private currentAttemptNumber = 1;
  private currentAttemptId: AttemptId;
  private isCompleted = false;
  private lastCommittedJournalSeq = 0;

  private constructor(plan: ValidatedRuntimePlan, options?: PlayheadCursorOptions) {
    this.plan = plan;
    this.currentGeneration = GenerationSchema.parse(options?.generation ?? 1);
    if (options?.initialAttemptId) {
      this.currentAttemptId = AttemptIdSchema.parse(options.initialAttemptId);
      this.currentAttemptNumber = parseAttemptNumber(this.currentAttemptId);
    } else {
      this.currentAttemptId = formatAttemptId(1);
      this.currentAttemptNumber = 1;
    }
  }

  /**
   * Initializes a new PlayheadCursor exclusively from a ValidatedRuntimePlan.
   * Rejects plans without executable steps fail-closed.
   */
  static createFromPlan(plan: ValidatedRuntimePlan, options?: PlayheadCursorOptions): PlayheadCursor {
    if (!plan || typeof plan !== "object") {
      throw new RuntimeError({
        code: "RUNTIME_INVALID_LESSON",
        message: "Cannot create PlayheadCursor: plan is null or not an object",
      });
    }

    if (!Array.isArray(plan.ordered_steps) || plan.ordered_steps.length === 0) {
      throw new RuntimeError({
        code: "RUNTIME_INVALID_LESSON",
        message: "Cannot create PlayheadCursor: plan contains zero ordered steps",
      });
    }

    if (plan.total_steps !== plan.ordered_steps.length) {
      throw new RuntimeError({
        code: "RUNTIME_INVALID_LESSON",
        message: `Plan total_steps (${plan.total_steps}) does not match ordered_steps length (${plan.ordered_steps.length})`,
      });
    }

    return new PlayheadCursor(plan, options);
  }

  /** Returns current validated step metadata. */
  getCurrentStep(): ValidatedStepPlan {
    return this.plan.ordered_steps[this.currentStepPlanIndex]!;
  }

  /** Returns immutable validated runtime plan reference. */
  getPlan(): ValidatedRuntimePlan {
    return this.plan;
  }

  /** Returns current lesson ID. */
  getLessonId(): string {
    return this.plan.lesson_id;
  }

  /** Returns current generation epoch. */
  getGeneration(): number {
    return this.currentGeneration;
  }

  /** Returns current attempt identifier. */
  getAttemptId(): AttemptId {
    return this.currentAttemptId;
  }

  /** Returns true if all steps in the plan have been executed and completed. */
  isAtEnd(): boolean {
    return this.isCompleted;
  }

  /** Returns remaining unexecuted steps count. */
  getRemainingStepsCount(): number {
    if (this.isCompleted) {
      return 0;
    }
    return this.plan.ordered_steps.length - this.currentStepPlanIndex;
  }

  /**
   * Checks if an incoming attempt ID is stale (older than current active attempt).
   */
  isStaleAttempt(attemptId: string): boolean {
    return attemptId !== this.currentAttemptId;
  }

  /**
   * Enforces that an incoming attempt matches the current active attempt.
   * Throws STALE_GENERATION if mismatched.
   */
  fenceAttempt(attemptId: string): void {
    if (attemptId !== this.currentAttemptId) {
      throw new RuntimeError({
        code: "STALE_GENERATION",
        message: `Stale attempt: expected '${this.currentAttemptId}', got '${attemptId}'`,
      });
    }
  }

  /**
   * Enforces that an incoming generation matches the current active generation.
   * Throws STALE_GENERATION if mismatched.
   */
  fenceGeneration(generation: number): void {
    if (generation !== this.currentGeneration) {
      throw new RuntimeError({
        code: "STALE_GENERATION",
        message: `Stale generation: expected ${this.currentGeneration}, got ${generation}`,
      });
    }
  }

  /**
   * Advances the attempt identity for the current step.
   * STRICTLY PERMITTED ONLY for SAFE_TO_RETRY outcomes.
   * Rejects UNCERTAIN, NOT_RETRYABLE, and REQUIRES_RESET fail-closed.
   */
  nextAttempt(reason: { retry: RetryCategory }): AttemptId {
    if (reason.retry !== "SAFE_TO_RETRY") {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Cannot increment attempt for retry category '${reason.retry}' (only 'SAFE_TO_RETRY' is permitted)`,
      });
    }

    if (this.isCompleted) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: "Cannot increment attempt on a completed playhead",
      });
    }

    this.currentAttemptNumber++;
    this.currentAttemptId = formatAttemptId(this.currentAttemptNumber);
    return this.currentAttemptId;
  }

  /**
   * Authorizes and executes playhead advancement by exactly one step.
   * Advances strictly AFTER engine COMPLETED and journal commit proof.
   * Rejects stale attempts, stale generations, wrong steps, and uncommitted proofs.
   */
  advance(proof: StepCompletionCommitProof): PlayheadAdvanceResult {
    // 1. Guard against advancing beyond end of plan
    if (this.isCompleted) {
      return {
        advanced: false,
        endOfPlan: true,
        playhead: this.getSnapshot(),
      };
    }

    // 2. Validate proof commitment flag
    if (!proof || proof.committed !== true) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: "Playhead advancement requires committed=true proof authorization",
      });
    }

    // 3. Validate proof status is strictly COMPLETED
    if (proof.status !== "COMPLETED") {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Playhead advancement requires status 'COMPLETED' (got '${proof.status}')`,
      });
    }

    // 4. Validate lesson ID
    if (proof.lesson_id !== this.plan.lesson_id) {
      throw new RuntimeError({
        code: "RUNTIME_INVALID_LESSON",
        message: `Proof lesson_id '${proof.lesson_id}' does not match plan lesson_id '${this.plan.lesson_id}'`,
      });
    }

    // 5. Generation fencing
    if (proof.generation !== this.currentGeneration) {
      throw new RuntimeError({
        code: "STALE_GENERATION",
        message: `Proof generation ${proof.generation} does not match current playhead generation ${this.currentGeneration}`,
      });
    }

    // 6. Attempt fencing
    if (proof.attempt_id !== this.currentAttemptId) {
      throw new RuntimeError({
        code: "STALE_GENERATION",
        message: `Proof attempt '${proof.attempt_id}' does not match current active attempt '${this.currentAttemptId}'`,
      });
    }

    // 7. Verify proof matches current playhead step exactly
    const currentStep = this.plan.ordered_steps[this.currentStepPlanIndex]!;
    if (
      proof.step_id !== currentStep.step_id ||
      proof.scene_id !== currentStep.scene_id ||
      proof.global_step_ordinal !== currentStep.global_step_ordinal
    ) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Proof coordinates (scene=${proof.scene_id}, step=${proof.step_id}, ordinal=${proof.global_step_ordinal}) do not match current playhead position (scene=${currentStep.scene_id}, step=${currentStep.step_id}, ordinal=${currentStep.global_step_ordinal})`,
      });
    }

    // 8. Verify positive journal sequence
    if (typeof proof.journal_seq !== "number" || proof.journal_seq < 1) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Proof requires positive journal sequence number (got ${proof.journal_seq})`,
      });
    }

    // 9. Idempotency guard: prevent duplicate advancement with the same or older journal sequence
    if (proof.journal_seq <= this.lastCommittedJournalSeq) {
      throw new RuntimeError({
        code: "DUPLICATE_OPERATION",
        message: `Proof journal_seq ${proof.journal_seq} is not greater than last committed seq ${this.lastCommittedJournalSeq}`,
      });
    }

    // Record committed journal sequence
    this.lastCommittedJournalSeq = proof.journal_seq;

    // Check if this was the final step of the lesson
    if (this.currentStepPlanIndex === this.plan.ordered_steps.length - 1) {
      // Reached the end of the lesson plan
      this.isCompleted = true;
      return {
        advanced: true,
        endOfPlan: true,
        playhead: this.getSnapshot(),
      };
    }

    // Advance to next step (handles scene crossing transparently from ordered plan)
    this.currentStepPlanIndex++;
    // Reset attempt for new step
    this.currentAttemptNumber = 1;
    this.currentAttemptId = formatAttemptId(1);

    return {
      advanced: true,
      endOfPlan: false,
      playhead: this.getSnapshot(),
    };
  }

  /**
   * Resets the playhead cursor back to step 0 for a new generation.
   * Can only be called with a strictly greater generation integer.
   */
  reset(nextGeneration?: number): void {
    const nextGen = nextGeneration ?? this.currentGeneration + 1;
    if (typeof nextGen !== "number" || !Number.isInteger(nextGen) || nextGen <= this.currentGeneration) {
      throw new RuntimeError({
        code: "STALE_GENERATION",
        message: `Next generation must be an integer strictly greater than ${this.currentGeneration} (got ${nextGen})`,
      });
    }

    this.currentGeneration = GenerationSchema.parse(nextGen);
    this.currentStepPlanIndex = 0;
    this.currentAttemptNumber = 1;
    this.currentAttemptId = formatAttemptId(1);
    this.isCompleted = false;
    this.lastCommittedJournalSeq = 0;
  }

  /** Returns an immutable, frozen PlayheadDto snapshot adhering to PlayheadDtoSchema. */
  getSnapshot(): PlayheadDto {
    const currentStep = this.plan.ordered_steps[this.currentStepPlanIndex]!;
    const dto: PlayheadDto = {
      lesson_id: this.plan.lesson_id,
      scene_index: currentStep.scene_index,
      scene_id: currentStep.scene_id,
      step_index: currentStep.step_index,
      step_id: currentStep.step_id,
      global_step_ordinal: currentStep.global_step_ordinal,
      total_steps: this.plan.total_steps,
      attempt_id: this.currentAttemptId,
      generation: this.currentGeneration,
    };

    PlayheadDtoSchema.parse(dto);
    return Object.freeze(dto);
  }
}
