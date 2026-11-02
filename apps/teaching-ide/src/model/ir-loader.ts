// Runtime IR validation — Electron-main/test-side only (imports the canonical
// compiler package, which is a Node context; the renderer never bundles this).
// Validation is delegated to the CANONICAL P3 authority; the IR schema is
// never duplicated.

import { validateCompiledLesson } from "@course-factory/lesson-compiler/ir";
import type { CompiledLesson } from "./ir.ts";
import type { IrLoadResult } from "./ir.ts";

/** Validate raw (parsed) compiled-lesson data through the canonical authority. */
export function loadCompiledLessonData(data: unknown): IrLoadResult {
  const result = validateCompiledLesson(data);
  if (!result.ok) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, issues: [], ir: result.ir };
}

export type { CompiledLesson };
