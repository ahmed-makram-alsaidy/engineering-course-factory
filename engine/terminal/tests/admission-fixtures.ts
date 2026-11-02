// Shared P5.2 admission test fixtures: synthetic lessons compiled through the
// CANONICAL pipeline (parseLessonData -> compileLesson -> createLessonCatalog's
// validateCompiledLesson). Never hand-authored IR.
//
// Note: the compile subpath is imported through a runtime specifier because
// engine/compiler/src/compile.ts carries a pre-existing strict-TypeScript
// issue that P4/P5.1 already keep out of strict typecheck (canonical clean
// subpaths are used instead). Repairing it is out of P5.2 scope — documented
// in docs/P5-IMPLEMENTATION.md as pre-existing technical debt.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { Lesson } from "@course-factory/shared-types/schema";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import {
  createAdmissionService,
  type AdmissionService,
  type AdmissionSession,
  type LessonCatalog,
} from "../src/admission.ts";
import type { RuntimeSessionIdentity } from "../src/protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));
const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: Lesson) => CompiledLesson;
};

export const MIXED_LESSON = "p52-terminal-mixed.json";
export const COMMAND_PROFILE_LESSON = "p52-command-profile.json";

export function compileFixture(name: string): CompiledLesson {
  const raw: unknown = JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));
  return compileFromData(raw, name);
}

export function compileFromData(raw: unknown, label = "(memory)"): CompiledLesson {
  const parsed = parseLessonData(raw);
  if (!parsed.ok || parsed.lesson === undefined) {
    throw new Error(`lesson ${label} failed canonical source validation: ${JSON.stringify(parsed.issues)}`);
  }
  return compileModule.compileLesson(parsed.lesson);
}

export interface AdmissionFixture {
  service: AdmissionService;
  session: AdmissionSession;
  catalog: LessonCatalog;
  identity: RuntimeSessionIdentity;
}

function open(name: string, executionAuthorized: boolean): AdmissionFixture {
  const service = createAdmissionService();
  const catalogResult = service.installLesson(compileFixture(name));
  if (!catalogResult.ok) throw new Error(`catalog rejected fixture ${name}: ${catalogResult.rejection.message}`);
  const session = service.openSession(catalogResult.value, { executionAuthorized });
  if (!session.ok) throw new Error(`session open failed: ${session.rejection.message}`);
  return { service, session: session.value, catalog: catalogResult.value, identity: session.value.identity };
}

/** Install a fixture lesson and open one execution-authorized session. */
export function authorizedSession(name: string): AdmissionFixture {
  return open(name, true);
}

/** Same, but inspection-only (P4-fixture-like: no execution grants). */
export function inspectionSession(name: string): AdmissionFixture {
  return open(name, false);
}

export const FOREGROUND_OP = "C01-L052-S001-B002";
export const BROWSER_OP = "C01-L052-S001-B003";
export const TYPE_CODE_OP = "C01-L052-S001-B004";
export const BACKGROUND_OP = "C01-L052-S002-B001";
export const WAIT_OP = "C01-L052-S003-B001";
export const STOP_OP = "C01-L052-S003-B002";
export const SENTINEL_OP = "C01-L053-S001-B001";
export const NUL_COMMAND_OP = "C01-L053-S001-B002";
export const OVERSIZED_TIMEOUT_OP = "C01-L053-S001-B003";
export const SLOT_RELEASE_OP = "C01-L053-S001-B004";

export function boundRun(identity: RuntimeSessionIdentity, operationId: string, requestId?: string) {
  return { session_id: identity.session_id, operation_id: operationId, request_id: requestId ?? `req-${operationId.slice(-4)}` };
}

export function boundStop(identity: RuntimeSessionIdentity, processId: string, requestId = "req-stop") {
  return { session_id: identity.session_id, process_id: processId, request_id: requestId };
}
