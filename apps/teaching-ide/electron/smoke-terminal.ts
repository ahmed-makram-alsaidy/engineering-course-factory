// Visual smoke helper — P5.14 Visual smoke (main-process side only).
//
// Canonical architecture: docs/P5-DESIGN-SPEC.md, task P5.14 "Visual smoke"
// (Inputs: Built app/image/fixture; Files: Smoke/evidence; Behavior: Real
// output/exit inspected/privacy/teardown; PASS: Correlated main/renderer/PNG
// evidence) plus the "Real visual smoke" section.
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module owns ONLY the main-authorized safe-fixture identity and its
//     reviewed registration for --smoke-terminal. The fixture itself
//     (fixtures/compiled-lessons/smoke-terminal.json) is compiled through the
//     canonical P3 pipeline from synthetic source only (never hand-authored
//     executable IR, never production curriculum).
//   - Ordinary --smoke stays navigation-only: this helper is never consulted
//     on that path, and no smoke-terminal registration occurs there.
//   - Execution itself stays owned by @course-factory/terminal-engine's
//     TerminalHost via the five identifier-only IPC channels (P5.11 wiring,
//     untouched). This module never sees commands, PIDs, Docker argv, signals,
//     mount sources, host paths, env values, image selection or shell
//     selection beyond the fixture's trusted bytes.
//   - No Electron import, no child_process, no network, no PTY, no browser
//     automation. The renderer contact is identifiers only (lesson:load +
//     terminal channels, as in production).
//   - P5.15 (validator/ADR/report), wait scheduling (P8), PTY, typing,
//     recording and curriculum are NOT started here.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SMOKE_TERMINAL_FIXTURE_ID = "smoke-terminal";
export const SMOKE_TERMINAL_LESSON_ID = "C01-L514";
export const SMOKE_TERMINAL_OPERATION_ID = "C01-L514-S001-B001";
export const SMOKE_TERMINAL_EXPECTED_MARKER = "P5_OK";
export const SMOKE_TERMINAL_EXPECTED_EXIT_CODE = 0;

/** True when the main process was launched for visual smoke (distinct from --smoke). */
export function isSmokeTerminalArgv(argv: readonly string[]): boolean {
  return argv.includes("--smoke-terminal");
}

/** Renderer query for visual smoke (distinct from ?smoke=1, which stays navigation-only). */
export function smokeTerminalRendererQuery(): Record<string, string> {
  return { "smoke-terminal": "1" };
}

export interface SmokeTerminalFixture {
  readonly fixtureId: string;
  readonly lessonId: string;
  readonly operationId: string;
  readonly expectedMarker: string;
  readonly expectedExitCode: number;
}

/** The single main-authorized safe fixture identity (no bytes here, only identity). */
export const SMOKE_TERMINAL_FIXTURE: SmokeTerminalFixture = {
  fixtureId: SMOKE_TERMINAL_FIXTURE_ID,
  lessonId: SMOKE_TERMINAL_LESSON_ID,
  operationId: SMOKE_TERMINAL_OPERATION_ID,
  expectedMarker: SMOKE_TERMINAL_EXPECTED_MARKER,
  expectedExitCode: SMOKE_TERMINAL_EXPECTED_EXIT_CODE,
};

/**
 * Read the bundled smoke-terminal fixture file (main-only filesystem access,
 * same directory as the other bundled fixtures). Returns the raw parsed JSON
 * for the caller to validate through the canonical P3 authority
 * (loadCompiledLessonData) — this helper never validates IR itself.
 */
export function readSmokeTerminalFixtureFile(appRoot: string): unknown {
  const path = join(appRoot, "fixtures", "compiled-lessons", `${SMOKE_TERMINAL_FIXTURE_ID}.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as unknown;
}
