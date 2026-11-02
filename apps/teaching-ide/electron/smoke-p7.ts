// Visual proof helper — P7.9 Real Electron Visual Proof (main-process side only).
//
// Canonical architecture: docs/P7-DESIGN-SPEC.md task P7.9
// ("Real Electron visual proof"; owned scope "apps/teaching-ide/electron/smoke-p7.ts,
// visual smoke harness, evidence logs"; PASS gate "Validated PNG images; correlated
// journal JSON proof; clean exit") plus section 22 ("Visual Surface: Teaching IDE
// Integration & BrowserPane"), section 24 ("Record Safe Mode & Privacy Guarantees"),
// section 29 ("Deterministic Test Strategy & Fixture Server Architecture"), and
// ADR-0012 ("Browser Automation Boundary and Execution Engine").
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module owns ONLY the main-authorized safe-fixture identity, operation IDs,
//     port binding, and helper utilities for --smoke-p7. The fixture itself
//     (fixtures/compiled-lessons/smoke-p7.json) is compiled through the canonical P3
//     compiler from synthetic source only (apps/teaching-ide/fixtures/sources/smoke-p7.yaml;
//     never hand-authored executable IR, never production curriculum).
//   - Ordinary --smoke, --smoke-terminal, and --smoke-p615 are untouched; this helper
//     is never consulted on those paths.
//   - Browser execution stays owned by @course-factory/browser-engine behind BrowserHost
//     over the four identifier-only browser channels (untouched).
//   - Presentation stays owned by BrowserPane displaying bounded pushed visual frames
//     (browser:frame) and trusted journal events (browser:event).
//   - P7.10 (final gate) is NOT started here; P8 cross-engine orchestration is NOT started.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SMOKE_P7_FIXTURE_ID = "smoke-p7";
export const SMOKE_P7_LESSON_ID = "C01-L709";
export const SMOKE_P7_COURSE_ID = "C01";
export const SMOKE_P7_FIXTURE_PORT = 39077;
export const SMOKE_P7_AUTHORED_ORIGIN = `http://127.0.0.1:${SMOKE_P7_FIXTURE_PORT}`;

export const SMOKE_P7_OPEN_OP_ID = "C01-L709-S001-B001";
export const SMOKE_P7_FILL_OP_ID = "C01-L709-S001-B002";
export const SMOKE_P7_PRESS_OP_ID = "C01-L709-S001-B003";
export const SMOKE_P7_CLICK_OP_ID = "C01-L709-S001-B004";
export const SMOKE_P7_WAIT_OP_ID = "C01-L709-S001-B005";
export const SMOKE_P7_ASSERT_OP_ID = "C01-L709-S001-B006";
export const SMOKE_P7_REFRESH_OP_ID = "C01-L709-S001-B007";
export const SMOKE_P7_ASSERT_RESET_OP_ID = "C01-L709-S001-B008";

export const SMOKE_P7_REVIEW_NOTE = "P7.9 visual proof: synthetic tiny fixture, reviewed main-only";

/** True when the main process was launched for P7.9 visual proof. */
export function isSmokeP7Argv(argv: readonly string[]): boolean {
  return argv.includes("--smoke-p7");
}

/** Renderer query parameters for visual proof (distinct from ?smoke=1, ?smoke-terminal=1, ?smoke-p615=1). */
export function smokeP7RendererQuery(): Record<string, string> {
  return { "smoke-p7": "1" };
}

export interface SmokeP7Fixture {
  readonly fixtureId: string;
  readonly lessonId: string;
  readonly courseId: string;
  readonly port: number;
  readonly openOpId: string;
  readonly fillOpId: string;
  readonly pressOpId: string;
  readonly clickOpId: string;
  readonly waitOpId: string;
  readonly assertOpId: string;
  readonly refreshOpId: string;
  readonly assertResetOpId: string;
}

export const SMOKE_P7_FIXTURE: SmokeP7Fixture = {
  fixtureId: SMOKE_P7_FIXTURE_ID,
  lessonId: SMOKE_P7_LESSON_ID,
  courseId: SMOKE_P7_COURSE_ID,
  port: SMOKE_P7_FIXTURE_PORT,
  openOpId: SMOKE_P7_OPEN_OP_ID,
  fillOpId: SMOKE_P7_FILL_OP_ID,
  pressOpId: SMOKE_P7_PRESS_OP_ID,
  clickOpId: SMOKE_P7_CLICK_OP_ID,
  waitOpId: SMOKE_P7_WAIT_OP_ID,
  assertOpId: SMOKE_P7_ASSERT_OP_ID,
  refreshOpId: SMOKE_P7_REFRESH_OP_ID,
  assertResetOpId: SMOKE_P7_ASSERT_RESET_OP_ID,
};

/**
 * Read the bundled smoke-p7 fixture file (main-only filesystem access,
 * same directory as the other bundled fixtures). Returns raw parsed JSON.
 */
export function readSmokeP7FixtureFile(appRoot: string): unknown {
  const path = join(appRoot, "fixtures", "compiled-lessons", `${SMOKE_P7_FIXTURE_ID}.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as unknown;
}

/** Browser operation ids derived from validated IR. */
export function smokeP7BrowserOpIdsOf(compiledLesson: unknown): string[] {
  const ids: string[] = [];
  const scenes = (compiledLesson as {
    scenes?: Array<{
      steps?: Array<{
        step_id?: unknown;
        kind?: unknown;
        operation?: { family?: unknown; type?: unknown };
      }>;
    }>;
  })?.scenes;
  if (!Array.isArray(scenes)) return ids;
  for (const scene of scenes) {
    for (const step of scene.steps ?? []) {
      if (
        step.kind === "operation" &&
        step.operation?.family === "browser" &&
        typeof step.step_id === "string"
      ) {
        ids.push(step.step_id);
      }
    }
  }
  return ids.sort();
}

/** Main-side facts collected during the smoke scenario for verification against renderer report. */
export interface SmokeP7Facts {
  sessionId: string | null;
  generation: number;
  resetSessionId: string | null;
  resetGeneration: number;
  openCompleted: boolean;
  fillCompleted: boolean;
  pressCompleted: boolean;
  clickCompleted: boolean;
  waitCompleted: boolean;
  assertCompleted: boolean;
  refreshCompleted: boolean;
  assertResetCompleted: boolean;
  resetCompleted: boolean;
  framesCaptured: number;
  initialFrameReceived: boolean;
  latestFrameSeq: number;
  journalHighSeq: number;
  cleanProfileConfirmed: boolean;
}
