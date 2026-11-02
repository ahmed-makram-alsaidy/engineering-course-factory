// Visual proof helper — P6.15 Electron visual proof (main-process side only).
//
// Canonical architecture: docs/P6-DESIGN-SPEC.md task P6.15
// ("Electron visual proof"; owned scope "Built product and trusted fixture";
// PASS gate "Six visual/interoperability/reset proofs and privacy") plus
// section 20 ("Real Electron validation": main-authorized tiny reviewed
// fixture compiled by canonical tooling with bound seed/policy digests;
// real built Electron via the existing screenshot harness pattern, no
// Playwright; six demonstrations (1) seeded file opens, (2) at least two
// intermediate partial-code frames, (3) exact final Monaco buffer,
// (4) save/readback exact bytes, (5) subsequent real P5 command reads/runs
// those bytes, (6) reset verifies seed and clears pending edits; main
// evidence correlates operation/attempt/generation/plan/disk hashes;
// renderer diagnostics compare but never authorize PASS; inspected PNGs at
// 1600x900 and 1280x720 plus Record Safe Mode; window-close regression;
// no host-path leakage; actual command exit; zero owned containers after
// close; no recording implementation).
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module owns ONLY the main-authorized safe-fixture identity, the
//     reviewed seed bytes/digests and the reviewed workspace-policy binding
//     for --smoke-p615. The fixture itself
//     (fixtures/compiled-lessons/smoke-p615.json) is compiled through the
//     canonical P3 pipeline from synthetic source only (never hand-authored
//     executable IR, never production curriculum); the seed file
//     (fixtures/p615-seed/app.js) carries the reviewed initial bytes.
//   - Ordinary --smoke stays navigation-only and --smoke-terminal stays
//     terminal-only: this helper is never consulted on those paths, and no
//     smoke-p615 registration occurs there.
//   - Editor execution stays owned by the P6.11 EditorLifecycle behind the
//     P6.12 ack-gated presentation driver over the four identifier-only
//     editor channels (untouched). Terminal observation stays owned by the
//     REAL DockerAccessEpochProvider (P6.3 access epochs, read_only, same
//     sandbox argv/inspect as the P6.13 matrix) bound to the SAME editor
//     session leaf — never a second workspace, never a copyback. This module
//     never sees renderer paths/content, never synthesizes journal events,
//     never injects stdout.
//   - Renderer contact for the terminal phase is one BOUNDED main-to-renderer
//     display-data push (p615:observation: seq/phase/target/exit/stdout of
//     REAL observations only). It carries no invoke surface, no authority,
//     no host paths, no container identity; the renderer cannot request,
//     shape or replay it. Editor contact stays exactly the four
//     identifier-only invokes plus the two preload-local subscriptions.
//   - No Electron import, no child_process, no network, no PTY, no browser
//     automation, no SendKeys/keystroke injection. No new editor semantics,
//     no P6.16 final-gate work, no recording/Unreal.
//   - P6.16 (final gate) is NOT started here.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SMOKE_P615_FIXTURE_ID = "smoke-p615";
export const SMOKE_P615_LESSON_ID = "C01-L615";
export const SMOKE_P615_COURSE_ID = "C01";
export const SMOKE_P615_SEED_PATH = "app.js";
export const SMOKE_P615_OPEN_OPERATION_ID = "C01-L615-S001-B001";
export const SMOKE_P615_TYPE_OPERATION_ID = "C01-L615-S001-B003";
export const SMOKE_P615_SAVE_OPERATION_ID = "C01-L615-S001-B004";
export const SMOKE_P615_TERMINAL_OPERATION_ID = "C01-L615-S001-B005";
export const SMOKE_P615_DIRTY_OPERATION_ID = "C01-L615-S001-B007";

/** Reviewed seed bytes (must equal fixtures/p615-seed/app.js exactly). */
export const SMOKE_P615_SEED_TEXT = 'console.log("P6_SEED");\n';
/** Authored append for the saved type_code (must equal the fixture IR exactly). */
export const SMOKE_P615_TYPED_TEXT = 'console.log("P6_TYPED");\n';
/** Authored append for the intentionally-unsaved second type_code. */
export const SMOKE_P615_DIRTY_TEXT = 'console.log("P6_DIRTY");\n';
/** Trusted final buffer after the saved type (B1 = seed + typed). */
export const SMOKE_P615_B1_TEXT = SMOKE_P615_SEED_TEXT + SMOKE_P615_TYPED_TEXT;
/** Expected guest `node app.js` stdout over the SAVED bytes (exit 0). */
export const SMOKE_P615_RUN_STDOUT = "P6_SEED\nP6_TYPED\n";

/** Reviewed sandbox binding label for the smoke policy (digest preimage, never a path). */
export const SMOKE_P615_SANDBOX_LABEL = "p615-sandbox-policy";
export const SMOKE_P615_REVIEWED_BY = "p615-review";
export const SMOKE_P615_REVIEW_NOTE = "P6.15 visual proof: synthetic tiny fixture, reviewed main-only";

/** Phase-owned Docker ownership prefix for the visual epoch (no global prune). */
export const SMOKE_P615_CONTAINER_PREFIX = "cf-p615-";
export const SMOKE_P615_INSTALLATION_ID = "cf-p615-installation";
export const SMOKE_P615_TEST_RUN_ID = "cf-p615-visual";

/** Main-to-renderer display-data push for REAL terminal observations (no invoke surface). */
export const P615_OBSERVATION_CHANNEL = "p615:observation";

/** True when the main process was launched for P6.15 visual proof (distinct from --smoke/--smoke-terminal). */
export function isSmokeP615Argv(argv: readonly string[]): boolean {
  return argv.includes("--smoke-p615");
}

/** Renderer query for visual proof (distinct from ?smoke=1 and ?smoke-terminal=1). */
export function smokeP615RendererQuery(): Record<string, string> {
  return { "smoke-p615": "1" };
}

export interface SmokeP615Fixture {
  readonly fixtureId: string;
  readonly lessonId: string;
  readonly openOperationId: string;
  readonly typeOperationId: string;
  readonly saveOperationId: string;
  readonly terminalOperationId: string;
  readonly dirtyOperationId: string;
}

/** The single main-authorized safe fixture identity (no bytes here, only identity). */
export const SMOKE_P615_FIXTURE: SmokeP615Fixture = {
  fixtureId: SMOKE_P615_FIXTURE_ID,
  lessonId: SMOKE_P615_LESSON_ID,
  openOperationId: SMOKE_P615_OPEN_OPERATION_ID,
  typeOperationId: SMOKE_P615_TYPE_OPERATION_ID,
  saveOperationId: SMOKE_P615_SAVE_OPERATION_ID,
  terminalOperationId: SMOKE_P615_TERMINAL_OPERATION_ID,
  dirtyOperationId: SMOKE_P615_DIRTY_OPERATION_ID,
};

/**
 * Read the reviewed seed file (main-only filesystem access, fixture-owned
 * directory beside the compiled fixtures). Returns raw text for the caller
 * to bind through createSeedManifest + leaf seeding + byte verification —
 * this helper never authorizes execution itself.
 */
export function readSmokeP615SeedFile(appRoot: string): string {
  const path = join(appRoot, "fixtures", "p615-seed", "app.js");
  return readFileSync(path, "utf8");
}

/**
 * Read the bundled smoke-p615 fixture file (main-only filesystem access,
 * same directory as the other bundled fixtures). Returns the raw parsed JSON
 * for the caller to validate through the canonical P3 authority
 * (loadCompiledLessonData) — this helper never validates IR itself.
 */
export function readSmokeP615FixtureFile(appRoot: string): unknown {
  const path = join(appRoot, "fixtures", "compiled-lessons", `${SMOKE_P615_FIXTURE_ID}.json`);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as unknown;
}

/** Terminal_run operation ids derived from validated IR (coverage authority, never hardcoded drift). */
export function smokeP615TerminalIdsOf(compiledLesson: unknown): string[] {
  const ids: string[] = [];
  const lesson = (compiledLesson as { scenes?: Array<{ steps?: Array<{ step_id?: unknown; kind?: unknown; operation?: { type?: unknown } }> }> }).scenes;
  if (!Array.isArray(lesson)) return ids;
  for (const scene of lesson) {
    for (const step of scene.steps ?? []) {
      if (step.kind === "operation" && step.operation?.type === "terminal_run" && typeof step.step_id === "string") {
        ids.push(step.step_id);
      }
    }
  }
  return ids.sort();
}

/** Display-data DTO for one REAL terminal observation (bounded, lesson-relative, no host identity). */
export interface SmokeP615ObservationDto {
  readonly smokeP615: true;
  readonly seq: number;
  readonly phase: "before-save" | "denied-write" | "after-save" | "run";
  readonly target: string;
  readonly exit_code: number | null;
  readonly stdout: string;
}
