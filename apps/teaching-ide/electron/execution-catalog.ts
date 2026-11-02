// Execution catalog — the main-only reviewed-lesson registry for P5.11 Safe IPC.
//
// Canonical architecture: docs/P5-DESIGN-SPEC.md ("Security Boundary":
// "Canonical compiled-byte digest binds allowed operations, seed/image
// digests/policy in main-only reviewed catalog. Existing P4 fixtures
// inspection-only; only P5 synthetic fixtures get grants").
//
// OWNERSHIP (P5.11, no phase creep):
//   - This module decides executionAuthorized for TerminalHost.openSession.
//     P4 bundled fixtures are NEVER registered here and stay inspection-only
//     (runOperation -> NOT_AUTHORIZED, zero spawn). Only lessons explicitly
//     registered through registerReviewedLesson (main-only, trusted review:
//     invoked scripts/package bytes reviewed, seeds rechecked, no install
//     hooks) become execution-authorized. There is deliberately NO renderer
//     input to this module: no IPC, no Electron import, no filesystem, no
//     child_process, no network.
//   - The compiled-byte digest (canonical serialization, not the source.hash
//     signature) binds the registration: isExecutionAuthorized requires the
//     live lesson's digest to equal the registered digest, so a swapped or
//     edited lesson cannot inherit a grant.
//   - Passive UI (P5.12), wait scheduling (P8) and curriculum work are NOT
//     started here.

import type { CompiledLesson } from "../src/model/ir.ts";

export interface ReviewedLessonRecord {
  readonly lesson_id: string;
  readonly course_id: string;
  readonly lesson_compiled_digest: string;
  readonly reviewed_note: string;
}

const records = new Map<string, ReviewedLessonRecord>();

/**
 * Register one reviewed lesson as execution-authorized (main-only).
 * The digest binds the exact reviewed bytes; any byte change needs a new
 * review. Re-registering the same lesson_id with a DIFFERENT digest replaces
 * the record (new review); with the SAME digest it is idempotent.
 */
export function registerReviewedLesson(input: {
  lesson_id: string;
  course_id: string;
  lesson_compiled_digest: string;
  reviewed_note: string;
}): ReviewedLessonRecord {
  if (typeof input.lesson_id !== "string" || input.lesson_id.length === 0 || input.lesson_id.length > 128) {
    throw new TypeError("reviewed lesson_id must be 1..128 characters");
  }
  if (typeof input.lesson_compiled_digest !== "string" || input.lesson_compiled_digest.length === 0) {
    throw new TypeError("reviewed lesson_compiled_digest must be a non-empty string");
  }
  const record: ReviewedLessonRecord = {
    lesson_id: input.lesson_id,
    course_id: input.course_id,
    lesson_compiled_digest: input.lesson_compiled_digest,
    reviewed_note: input.reviewed_note,
  };
  records.set(input.lesson_id, record);
  return record;
}

/** True only when the lesson was reviewed AND the live digest matches the registered digest. */
export function isExecutionAuthorized(lessonId: string, liveCompiledDigest: string): boolean {
  const record = records.get(lessonId);
  if (record === undefined) return false;
  return record.lesson_compiled_digest === liveCompiledDigest;
}

/** Remove one registration (main-only; used by tests and lesson withdrawal). */
export function unregisterReviewedLesson(lessonId: string): void {
  records.delete(lessonId);
}

/** Clear all registrations (main-only; tests only). */
export function clearReviewedLessons(): void {
  records.clear();
}

/** Snapshot of registrations (main diagnostics only; never sent to the renderer). */
export function listReviewedLessons(): readonly ReviewedLessonRecord[] {
  return [...records.values()];
}

export type { CompiledLesson as ReviewedCompiledLesson };
