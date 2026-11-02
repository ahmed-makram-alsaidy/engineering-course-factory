// Shared P5.3 workspace test fixtures.
//
// All host paths are synthetic per-test temp directories (os.tmpdir()); no
// machine path is ever hard-coded. Grants are hand-built synthetic objects
// that satisfy ExecutionGrantSchema — resolveGrantWorkspace re-validates them
// (that re-validation IS part of what is being tested), so bypassing the
// admission service here is intentional and safe: nothing executes.

import { after } from "node:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionGrant } from "../src/admission.ts";

const createdRoots: string[] = [];

/** Fresh physical temp directory (realpath-canonical for the workspace root). */
export function tempRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  createdRoots.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GRANT_BASE: ExecutionGrant = {
  kind: "execution_grant",
  grant_version: 1,
  session_id: "sess-p53-0001",
  generation: 1,
  request_id: "req-p53-0001",
  attempt_id: "att-p53-0001",
  operation_id: "op-p53-0001",
  operation_type: "terminal_run",
  mode: "foreground",
  course_id: "course-p53",
  lesson_id: "p53-lesson",
  scene_id: "scene-p53-01",
  beat_id: "beat-p53-01",
  process_id: null,
  command: "echo ok",
  cwd: null,
  timeout_ms: 60000,
  expected_exit_code: 0,
};

/** Synthetic schema-valid grant with targeted overrides. */
export function makeGrant(overrides: Partial<ExecutionGrant> = {}): ExecutionGrant {
  return { ...GRANT_BASE, ...overrides };
}

export const LESSON_ID = GRANT_BASE.lesson_id;
export const SESSION_ID = GRANT_BASE.session_id;
