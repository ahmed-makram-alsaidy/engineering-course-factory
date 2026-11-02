// IR adapter types — the Teaching IDE's single touch point with the
// compiled-lesson contract. This module is TYPE-ONLY and renderer-safe: the
// canonical IR schema is never duplicated here, and no runtime code from the
// compiler package is bundled into the renderer.
//
// Runtime VALIDATION lives in src/model/ir-loader.ts (used by the Electron
// main process and tests) and delegates to the canonical P3 authority
// (@course-factory/lesson-compiler/ir).

import type { CompiledOperation, CompiledScene, CompiledStep, CompiledLesson } from "@course-factory/lesson-compiler/ir";

export type { CompiledLesson, CompiledOperation, CompiledScene, CompiledStep };

export interface IrIssue {
  path: string;
  code: string;
  message: string;
}

export interface IrLoadResult {
  ok: boolean;
  issues: IrIssue[];
  ir?: CompiledLesson;
}

/** All steps of a lesson flattened in authored order (for playhead ranges). */
export function flattenSteps(
  ir: CompiledLesson,
): { scene: CompiledScene; step: CompiledStep; sceneIndex: number; stepIndex: number }[] {
  const flat: { scene: CompiledScene; step: CompiledStep; sceneIndex: number; stepIndex: number }[] = [];
  ir.scenes.forEach((scene, sceneIndex) => {
    scene.steps.forEach((step, stepIndex) => {
      flat.push({ scene, step, sceneIndex, stepIndex });
    });
  });
  return flat;
}

/** One-line summary of a scene for lists and status bars. */
export function sceneLabel(scene: CompiledScene): string {
  return `${scene.ordinal}. ${scene.title} (${scene.type})`;
}

/** One-line summary of a step for lists and status bars. */
export function stepLabel(step: CompiledStep): string {
  const prefix = step.derived ? `${step.step_id} (derived)` : step.step_id;
  switch (step.kind) {
    case "narration":
      return `${prefix} · narration`;
    case "pause":
      return `${prefix} · pause ${step.seconds}s`;
    case "operation":
      return `${prefix} · ${step.operation.type}`;
  }
}
