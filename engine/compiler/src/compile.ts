// The Lesson Compiler — pure transformation from a validated lesson document
// to the compiled lesson IR.
//
// THE COMPILER COMPILES. IT DOES NOT AUTHOR AND IT DOES NOT EXECUTE.
//
// This module is deterministic, offline, and side-effect free:
//   - narration text, code, commands, URLs, selectors, paths are DATA —
//     preserved exactly, never executed, rewritten, translated, or "fixed"
//   - authored scene order and beat order are preserved exactly; ordinals are
//     derived metadata, never a renumbering of authored ids
//   - derived metadata (direction, action families, capabilities, resource
//     inventory, process records, references) is computed structurally from
//     explicit source content only — never inferred from narration or code,
//     and commands are never parsed
//   - the input object is never mutated; the returned object shares no
//     structure with it
//
// Preconditions: `lesson` must be a schema-validated lesson document (defaults
// applied) as returned by parseLessonData/parseLessonSource from
// @course-factory/shared-types — the single lesson-validation authority.

import type {
  Action,
  Beat,
  LeafLanguageValue,
  Lesson,
  Narration,
  Scene,
} from "@course-factory/shared-types";
import { COMPILED_IR_VERSION, COMPILER_NAME, COMPILER_VERSION } from "./version.ts";
import { sourceHash } from "./canonical.ts";
import type {
  ActionFamilyValue,
  CompiledLesson,
  CompiledLessonMetadata,
  CompiledNarration,
  CompiledOnScreenText,
  CompiledOperation,
  CompiledProcess,
  CompiledScene,
  CompiledStep,
  SourceRef,
} from "./ir.ts";

// ---------------------------------------------------------------------------
// Derived action family — classification only, from the explicit action type.
// Never behavior, never inferred from narration or code blocks.
// ---------------------------------------------------------------------------

const ACTION_FAMILY: Record<Action["type"], ActionFamilyValue> = {
  file_open: "editor",
  file_create: "file",
  type_code: "editor",
  replace_code: "editor",
  file_save: "editor",
  terminal_run: "terminal",
  terminal_stop: "terminal",
  wait: "wait",
  browser_open: "browser",
  browser_click: "browser",
  browser_fill: "browser",
  browser_press: "browser",
  browser_refresh: "browser",
  browser_wait: "browser",
  browser_assert: "browser",
  highlight: "visual",
};

const EDITOR_CAPABILITY_ACTIONS: ReadonlySet<Action["type"]> = new Set([
  "file_open",
  "file_create",
  "type_code",
  "replace_code",
  "file_save",
  "highlight",
]);

function internalError(message: string): never {
  throw new Error(`lesson compiler internal error: ${message}`);
}

// ---------------------------------------------------------------------------
// Language / direction derivation (ar => rtl, en => ltr; derived, never stored)
// ---------------------------------------------------------------------------

function directionOf(language: LeafLanguageValue): "rtl" | "ltr" {
  return language === "ar" ? "rtl" : "ltr";
}

/**
 * Effective leaf language: the authored leaf language, else the lesson
 * language. Mixed lessons declare every leaf explicitly (enforced by the
 * canonical schema), so an undefined leaf language there is impossible.
 */
function resolveLeafLanguage(
  leaf: LeafLanguageValue | undefined,
  lessonLanguage: Lesson["language"],
  where: string,
): LeafLanguageValue {
  if (leaf !== undefined) return leaf;
  if (lessonLanguage === "mixed") {
    internalError(`${where} has no leaf language in a mixed lesson (canonical validation must have rejected this source)`);
  }
  return lessonLanguage;
}

function compileNarration(narration: Narration, lessonLanguage: Lesson["language"], where: string): CompiledNarration {
  const language = resolveLeafLanguage(narration.language, lessonLanguage, where);
  const compiled: CompiledNarration = {
    text: narration.text,
    language,
    direction: directionOf(language),
  };
  if (narration.speaker !== undefined) compiled.speaker = narration.speaker;
  if (narration.delivery !== undefined) compiled.delivery = narration.delivery;
  if (narration.pause_before !== undefined) compiled.pause_before = narration.pause_before;
  if (narration.pause_after !== undefined) compiled.pause_after = narration.pause_after;
  return compiled;
}

function compileOnScreenText(text: Scene["on_screen_text"][number], lessonLanguage: Lesson["language"], where: string): CompiledOnScreenText {
  const language = resolveLeafLanguage(text.language, lessonLanguage, where);
  const compiled: CompiledOnScreenText = {
    role: text.role,
    text: text.text,
    language,
    direction: directionOf(language),
  };
  if (text.emphasis !== undefined) compiled.emphasis = text.emphasis;
  return compiled;
}

// ---------------------------------------------------------------------------
// Background process records — derived from explicit source only.
// ---------------------------------------------------------------------------

interface ProcessRecord {
  process_id: string;
  command: string;
  cwd?: string;
  started_in: { scene_id: string; beat_id: string; scene_ordinal: number; step_ordinal: number };
  stopped_in?: { scene_id: string; beat_id: string };
  output_waits: { scene_id: string; beat_id: string; text: string; timeout_seconds: number }[];
}

/** The process id a compiled action references, if any (stop / output-wait). */
function referencedProcessId(action: Action): string | undefined {
  if (action.type === "terminal_stop") return action.process_id;
  if (action.type === "wait" && action.until === "process_output") return action.process_id;
  return undefined;
}

// ---------------------------------------------------------------------------
// Beat / operation compilation
// ---------------------------------------------------------------------------

interface CompileSceneContext {
  lesson: Lesson;
  processes: Map<string, ProcessRecord>;
}

function compileOperation(
  action: Action,
  scene: Scene,
  beatId: string,
  context: CompileSceneContext,
): CompiledOperation {
  const operation: CompiledOperation = {
    type: action.type,
    family: ACTION_FAMILY[action.type],
    parameters: action,
  };

  const processId = referencedProcessId(action);
  if (processId !== undefined) {
    const record = context.processes.get(processId);
    if (record === undefined) {
      internalError(`process '${processId}' is referenced before definition (canonical validation must have rejected this source)`);
    }
    operation.references = {
      process: {
        process_id: processId,
        defined_in: { scene_id: record.started_in.scene_id, beat_id: record.started_in.beat_id },
      },
    };
    if (action.type === "terminal_stop") {
      record.stopped_in = { scene_id: scene.scene_id, beat_id: beatId };
    } else if (action.type === "wait" && action.until === "process_output") {
      record.output_waits.push({
        scene_id: scene.scene_id,
        beat_id: beatId,
        text: action.text,
        timeout_seconds: action.timeout_seconds,
      });
    }
  }

  return operation;
}

function compileBeat(beat: Beat, index: number, scene: Scene, sceneOrdinal: number, context: CompileSceneContext): CompiledStep {
  const ordinal = index + 1;
  const source_ref: SourceRef = {
    scene_id: scene.scene_id,
    scene_ordinal: sceneOrdinal,
    beat_id: beat.beat_id,
    form: "authored_beat",
  };
  if (beat.kind === "narration") {
    return {
      kind: "narration",
      step_id: beat.beat_id,
      ordinal,
      derived: false,
      narration: compileNarration(beat.narration, context.lesson.language, `${scene.scene_id} beat ${beat.beat_id}`),
      source_ref,
    };
  }
  if (beat.kind === "pause") {
    return { kind: "pause", step_id: beat.beat_id, ordinal, derived: false, seconds: beat.seconds, source_ref };
  }
  return {
    kind: "operation",
    step_id: beat.beat_id,
    ordinal,
    derived: false,
    operation: compileOperation(beat.action, scene, beat.beat_id, context),
    source_ref,
  };
}

/**
 * Non-beat scenes keep their single top-level narration as ONE derived
 * narration step — clearly marked `derived`, addressed by a deterministic
 * `<scene_id>-STEPnnn` id that can never be mistaken for an authored beat id.
 * No execution beats are ever invented for such scenes.
 */
function compileSceneNarrationStep(scene: Scene, sceneOrdinal: number, context: CompileSceneContext): CompiledStep {
  if (scene.narration === undefined) {
    internalError(`scene ${scene.scene_id} has neither beats nor narration (canonical validation must have rejected this source)`);
  }
  return {
    kind: "narration",
    step_id: `${scene.scene_id}-STEP001`,
    ordinal: 1,
    derived: true,
    narration: compileNarration(scene.narration, context.lesson.language, `${scene.scene_id} narration`),
    source_ref: { scene_id: scene.scene_id, scene_ordinal: sceneOrdinal, beat_id: null, form: "scene_narration" },
  };
}

function compileScene(scene: Scene, sceneIndex: number, context: CompileSceneContext): CompiledScene {
  const ordinal = sceneIndex + 1;
  const hasBeats = scene.beats.length > 0;

  const compiled: CompiledScene = {
    scene_id: scene.scene_id,
    ordinal,
    type: scene.type,
    title: scene.title,
    duration_seconds: scene.duration,
    narration_form: hasBeats ? "beats" : "single_narration",
    visual: scene.visual,
    steps: hasBeats
      ? scene.beats.map((beat, index) => compileBeat(beat, index, scene, ordinal, context))
      : [compileSceneNarrationStep(scene, ordinal, context)],
    on_screen_text: scene.on_screen_text.map((text, index) =>
      compileOnScreenText(text, context.lesson.language, `${scene.scene_id} on_screen_text[${index}]`),
    ),
    blocks: scene.blocks,
    assets: scene.assets,
  };
  if (scene.interaction !== undefined) compiled.interaction = scene.interaction;
  if (scene.audio !== undefined) compiled.audio = scene.audio;
  if (scene.transitions !== undefined) compiled.transitions = scene.transitions;
  if (scene.alt_text !== undefined) compiled.alt_text = scene.alt_text;
  if (scene.notes !== undefined) compiled.notes = scene.notes;
  return compiled;
}

// ---------------------------------------------------------------------------
// Derived lesson-level metadata
// ---------------------------------------------------------------------------

function collectOperations(scenes: CompiledScene[]): CompiledOperation[] {
  const operations: CompiledOperation[] = [];
  for (const scene of scenes) {
    for (const step of scene.steps) {
      if (step.kind === "operation") operations.push(step.operation);
    }
  }
  return operations;
}

function deriveCapabilities(operations: CompiledOperation[], steps: CompiledStep[]): CompiledLesson["capabilities"] {
  const types = new Set(operations.map((operation) => operation.type));
  return {
    terminal: types.has("terminal_run") || types.has("terminal_stop"),
    browser: [...types].some((type) => type.startsWith("browser_")),
    editor: [...types].some((type) => EDITOR_CAPABILITY_ACTIONS.has(type as Action["type"])),
    voice: steps.some((step) => step.kind === "narration"),
  };
}

/**
 * Deterministic inventory of explicitly referenced resources, from structured
 * action fields only. Commands are never parsed; nothing is resolved against
 * the machine filesystem; nothing external is scanned.
 */
function deriveResources(scenes: CompiledScene[]): CompiledLesson["resources"] {
  const paths = new Set<string>();
  const assets = new Set<string>();
  const origins = new Set<string>();
  for (const scene of scenes) {
    for (const asset of scene.assets) assets.add(asset.asset_id);
    for (const step of scene.steps) {
      if (step.kind !== "operation") continue;
      const action: Action = step.operation.parameters;
      switch (action.type) {
        case "file_open":
        case "file_create":
        case "type_code":
        case "replace_code":
        case "file_save":
        case "highlight":
          paths.add(action.path);
          break;
        case "terminal_run":
          if (action.cwd !== undefined) paths.add(action.cwd);
          break;
        case "browser_open":
          origins.add(new URL(action.url).origin);
          break;
        default:
          break;
      }
    }
  }
  return { paths: [...paths].sort(), assets: [...assets].sort(), browser_origins: [...origins].sort() };
}

function compileMetadata(metadata: Lesson["metadata"]): Lesson["metadata"] {
  const sorted: Lesson["metadata"] = {};
  for (const key of Object.keys(metadata).sort()) sorted[key] = metadata[key];
  return sorted;
}

function compileLessonMetadata(lesson: Lesson): CompiledLessonMetadata {
  const compiled: CompiledLessonMetadata = {
    course_id: lesson.course_id,
    lesson_id: lesson.lesson_id,
    title: lesson.title,
    language: lesson.language,
    direction: lesson.language === "ar" ? "rtl" : lesson.language === "en" ? "ltr" : null,
    subject: lesson.subject,
    grade_level: lesson.grade_level,
    duration_seconds: lesson.duration,
    learning_objectives: [...lesson.learning_objectives],
    prerequisites: [...lesson.prerequisites],
    keywords: [...lesson.keywords],
    metadata: compileMetadata(lesson.metadata),
  };
  if (lesson.unit !== undefined) compiled.unit = lesson.unit;
  if (lesson.chapter !== undefined) compiled.chapter = lesson.chapter;
  if (lesson.difficulty !== undefined) compiled.difficulty = lesson.difficulty;
  return compiled;
}

function compileProcessRecords(processes: Map<string, ProcessRecord>): CompiledProcess[] {
  const compiled: CompiledProcess[] = [];
  for (const record of processes.values()) {
    const process: CompiledProcess = {
      process_id: record.process_id,
      command: record.command,
      started_in: { ...record.started_in },
      output_waits: record.output_waits.map((wait) => ({ ...wait })),
    };
    if (record.cwd !== undefined) process.cwd = record.cwd;
    if (record.stopped_in !== undefined) process.stopped_in = { ...record.stopped_in };
    compiled.push(process);
  }
  return compiled;
}

// ---------------------------------------------------------------------------
// The compiler entry point
// ---------------------------------------------------------------------------

export function compileLesson(lesson: Lesson): CompiledLesson {
  // Pass 1: collect background process definitions in authored order. The
  // canonical schema guarantees each logical id is defined exactly once and
  // that every reference resolves to an EARLIER definition.
  const processes = new Map<string, ProcessRecord>();
  lesson.scenes.forEach((scene, sceneIndex) => {
    scene.beats.forEach((beat, beatIndex) => {
      if (beat.kind === "action" && beat.action.type === "terminal_run" && beat.action.mode === "background") {
        if (beat.action.process_id === undefined) {
          internalError(`background terminal_run at ${scene.scene_id}/${beat.beat_id} has no process_id (canonical validation must have rejected this source)`);
        }
        const record: ProcessRecord = {
          process_id: beat.action.process_id,
          command: beat.action.command,
          started_in: {
            scene_id: scene.scene_id,
            beat_id: beat.beat_id,
            scene_ordinal: sceneIndex + 1,
            step_ordinal: beatIndex + 1,
          },
          output_waits: [],
        };
        if (beat.action.cwd !== undefined) record.cwd = beat.action.cwd;
        processes.set(record.process_id, record);
      }
    });
  });

  const context: CompileSceneContext = { lesson, processes };
  const scenes = lesson.scenes.map((scene, sceneIndex) => compileScene(scene, sceneIndex, context));

  const compiled: CompiledLesson = {
    compiled_ir_version: COMPILED_IR_VERSION,
    compiler: { name: COMPILER_NAME, version: COMPILER_VERSION },
    source: {
      schema_version: lesson.schema_version,
      hash: sourceHash(lesson),
    },
    lesson: compileLessonMetadata(lesson),
    capabilities: deriveCapabilities(collectOperations(scenes), scenes.flatMap((scene) => scene.steps)),
    resources: deriveResources(scenes),
    processes: compileProcessRecords(processes),
    scenes,
  };

  // The compiled object shares no structure with the input: mutating one can
  // never affect the other. Compile behaves as a pure transformation.
  return structuredClone(compiled);
}
