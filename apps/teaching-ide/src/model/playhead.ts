// Playhead — the non-executing navigation model over a compiled lesson.
// Moving the playhead changes UI state only; it can never perform an
// operation. All movements clamp deterministically at both ends.

import type { CompiledLesson, CompiledScene, CompiledStep } from "./ir.ts";

export interface PlayheadState {
  readonly sceneIndex: number;
  readonly stepIndex: number;
}

export function playheadStart(): PlayheadState {
  return { sceneIndex: 0, stepIndex: 0 };
}

export function currentScene(lesson: CompiledLesson, state: PlayheadState): CompiledScene {
  return lesson.scenes[Math.min(state.sceneIndex, lesson.scenes.length - 1)];
}

export function currentStep(lesson: CompiledLesson, state: PlayheadState): CompiledStep {
  const scene = currentScene(lesson, state);
  return scene.steps[Math.min(state.stepIndex, scene.steps.length - 1)];
}

/** Next step; crosses into the next scene at scene end. Clamped at lesson end. */
export function playheadNext(lesson: CompiledLesson, state: PlayheadState): PlayheadState {
  const scene = currentScene(lesson, state);
  if (state.stepIndex + 1 < scene.steps.length) {
    return { sceneIndex: state.sceneIndex, stepIndex: state.stepIndex + 1 };
  }
  if (state.sceneIndex + 1 < lesson.scenes.length) {
    return { sceneIndex: state.sceneIndex + 1, stepIndex: 0 };
  }
  return state;
}

/** Previous step; crosses back into the previous scene at scene start. */
export function playheadPrevious(lesson: CompiledLesson, state: PlayheadState): PlayheadState {
  if (state.stepIndex > 0) {
    return { sceneIndex: state.sceneIndex, stepIndex: state.stepIndex - 1 };
  }
  if (state.sceneIndex > 0) {
    const previous = lesson.scenes[state.sceneIndex - 1];
    return { sceneIndex: state.sceneIndex - 1, stepIndex: previous.steps.length - 1 };
  }
  return state;
}

export function goToScene(lesson: CompiledLesson, sceneIndex: number): PlayheadState {
  const clamped = Math.max(0, Math.min(sceneIndex, lesson.scenes.length - 1));
  return { sceneIndex: clamped, stepIndex: 0 };
}

export function goToStep(lesson: CompiledLesson, sceneIndex: number, stepIndex: number): PlayheadState {
  const clampedScene = Math.max(0, Math.min(sceneIndex, lesson.scenes.length - 1));
  const steps = lesson.scenes[clampedScene].steps.length;
  return { sceneIndex: clampedScene, stepIndex: Math.max(0, Math.min(stepIndex, steps - 1)) };
}

/** Deterministic position label, e.g. "S001 · step 3/14". */
export function playheadLabel(lesson: CompiledLesson, state: PlayheadState): string {
  const scene = currentScene(lesson, state);
  return `${scene.scene_id} · step ${state.stepIndex + 1}/${scene.steps.length}`;
}
