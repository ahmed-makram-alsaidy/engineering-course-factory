// Visual proof helper — P8.9 Real Electron End-to-End Visual Proof (main-process side only).
//
// Canonical architecture: docs/P8-DESIGN-SPEC.md task P8.9
// ("Real Electron End-to-End Visual Proof"; owned scope "apps/teaching-ide/electron/smoke-p8.ts,
// docs/evidence/P8/P8.9/"; PASS gate "Programmatic PNG validation at 1600x900, 1280x720,
// and record-safe mode") plus Section 25 ("Teaching IDE Desktop Integration & Safe Renderer IPC"),
// Section 31.1 ("Canonical Reference Lesson Fixture"), and ADR-0013 ("Runtime Orchestration Boundary").
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module owns ONLY the main-authorized safe-fixture identity, operation IDs,
//     port binding, and helper utilities for --smoke-p8. The fixture itself
//     (fixtures/compiled-lessons/smoke-p8.json) is compiled through the canonical P3
//     compiler from synthetic source only (apps/teaching-ide/fixtures/sources/smoke-p8.yaml;
//     never hand-authored executable IR, never production curriculum).
//   - Ordinary --smoke, --smoke-terminal, --smoke-p615, and --smoke-p7 are untouched;
//     this helper is never consulted on those paths.
//   - Execution stays owned by @course-factory/runtime-orchestrator behind LessonRuntime
//     and RuntimeHost over the 6 identifier-only invoke channels and 1 push channel.
//   - Presentation stays owned by Teaching IDE UI panes (Monaco Editor, TerminalPane, BrowserPane)
//     reflecting trusted runtime events (runtime:event) and snapshots (runtime:getSnapshot).
//   - P8.10 (final gate) is NOT started here; P9 screen recording is NOT started.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SMOKE_P8_FIXTURE_ID = "smoke-p8";
export const SMOKE_P8_LESSON_ID = "C01-L001";
export const SMOKE_P8_COURSE_ID = "C01";
export const SMOKE_P8_FIXTURE_PORT = 3000;
export const SMOKE_P8_AUTHORED_ORIGIN = `http://127.0.0.1:${SMOKE_P8_FIXTURE_PORT}`;

export const SMOKE_P8_REVIEW_NOTE = "P8.9 visual proof: canonical reference multi-engine lesson, reviewed main-only";

/** Step IDs from the canonical reference lesson. */
export const SMOKE_P8_STEPS = {
  narrationIntro: "C01-L001-S001-B001",
  fileCreate: "C01-L001-S001-B002",
  typeCode: "C01-L001-S001-B003",
  fileSave: "C01-L001-S001-B004",
  terminalCheck: "C01-L001-S001-B005",
  terminalServer: "C01-L001-S001-B006",
  waitPort: "C01-L001-S001-B007",
  browserOpen: "C01-L001-S001-B008",
  browserFill: "C01-L001-S001-B009",
  browserClick: "C01-L001-S001-B010",
  browserAssert: "C01-L001-S001-B011",
  terminalStop: "C01-L001-S001-B012",
  pauseWait: "C01-L001-S001-B013",
  narrationOutro: "C01-L001-S001-B014",
} as const;

/** True when the main process was launched for P8.9 visual proof. */
export function isSmokeP8Argv(argv: readonly string[]): boolean {
  return argv.includes("--smoke-p8");
}

/** Renderer query parameters for visual proof (distinct from ?smoke=1, ?smoke-p7=1, etc.). */
export function smokeP8RendererQuery(): Record<string, string> {
  return { "smoke-p8": "1" };
}

export interface SmokeP8Fixture {
  readonly fixtureId: string;
  readonly lessonId: string;
  readonly courseId: string;
  readonly port: number;
}

export const SMOKE_P8_FIXTURE: SmokeP8Fixture = {
  fixtureId: SMOKE_P8_FIXTURE_ID,
  lessonId: SMOKE_P8_LESSON_ID,
  courseId: SMOKE_P8_COURSE_ID,
  port: SMOKE_P8_FIXTURE_PORT,
};

/**
 * Read the bundled smoke-p8 fixture file (main-only filesystem access,
 * same directory as the other bundled fixtures). Returns raw parsed JSON.
 */
export function readSmokeP8FixtureFile(appRoot: string): unknown {
  const path = join(appRoot, "fixtures", "compiled-lessons", `${SMOKE_P8_FIXTURE_ID}.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as unknown;
}

/** Step ids derived from validated IR. */
export function smokeP8StepIdsOf(compiledLesson: unknown): string[] {
  const ids: string[] = [];
  const scenes = (compiledLesson as {
    scenes?: Array<{
      steps?: Array<{
        step_id?: unknown;
      }>;
    }>;
  })?.scenes;
  if (!Array.isArray(scenes)) return ids;
  for (const scene of scenes) {
    for (const step of scene.steps ?? []) {
      if (typeof step.step_id === "string") {
        ids.push(step.step_id);
      }
    }
  }
  return ids;
}

/** Main-side facts collected during the smoke scenario for verification against renderer report. */
export interface SmokeP8Facts {
  sessionId: string | null;
  generation: number;
  resetSessionId: string | null;
  resetGeneration: number;
  editorCompleted: boolean;
  terminalCompleted: boolean;
  waitCompleted: boolean;
  browserCompleted: boolean;
  pausedSettled: boolean;
  resumedContinued: boolean;
  lessonCompleted: boolean;
  resetCompleted: boolean;
  journalHighSeq: number;
  cleanResourcesConfirmed: boolean;
}
