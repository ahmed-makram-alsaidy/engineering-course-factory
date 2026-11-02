// Compiled Lesson IR — the compiler OUTPUT contract (version 1.0).
//
// This is NOT the lesson source schema. The source schema (schema_version
// "1.1", Zod authority in @course-factory/shared-types) defines what authors
// write; THIS file defines what the compiler emits for runtime components
// (P4+). The two versions evolve independently and must never be conflated:
// `compiled_ir_version: "1.0"` here, `schema_version: "1.1"` there.
//
// Boundary rules encoded by this contract:
//   - authored content (narration text, code, commands, URLs, selectors) is
//     preserved EXACTLY — it is data, never executed, rewritten, or inferred
//   - authored scene/beat order is preserved exactly; `ordinal` fields are
//     derived, 1-based metadata and never a renumbering of authored ids
//   - every step carries provenance back to its source location
//   - derived metadata (direction, families, capabilities, inventories,
//     references) is computed structurally from explicit source content only
//
// Full documentation: docs/P3-LESSON-COMPILER.md and ADR-0008.

import { z } from "zod";
import {
  ActionSchema,
  AssetRefSchema,
  AudioSchema,
  ContentBlockSchema,
  InteractionSchema,
  ON_SCREEN_TEXT_ROLES,
  SCENE_TYPES,
  TransitionsSchema,
  VisualSchema,
  formatZodIssues,
} from "@course-factory/shared-types";
import { COMPILED_IR_VERSION, COMPILER_NAME, COMPILER_VERSION } from "./version.ts";

export { COMPILED_IR_VERSION, COMPILER_NAME, COMPILER_VERSION };

// ---------------------------------------------------------------------------
// Text direction — derived, never stored in the source, never authored.
// ---------------------------------------------------------------------------

export const Direction = z.enum(["rtl", "ltr"]);
export type DirectionValue = z.infer<typeof Direction>;

// ---------------------------------------------------------------------------
// Provenance — every compiled step traces back to its authored location.
// Absolute machine paths are never stored; identity is by authored id.
// ---------------------------------------------------------------------------

export const SourceRefSchema = z.strictObject({
  scene_id: z.string().min(1),
  /** 1-based authored scene position in lesson order (derived metadata). */
  scene_ordinal: z.number().int().min(1),
  /** Authored beat id; null for the derived scene-narration step. */
  beat_id: z.string().nullable(),
  /** How this compiled step came to exist. */
  form: z.enum(["authored_beat", "scene_narration"]),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

// ---------------------------------------------------------------------------
// Narration — text preserved exactly; language resolved, direction derived.
// ---------------------------------------------------------------------------

export const CompiledNarrationSchema = z.strictObject({
  /** Authored narration text — preserved exactly, never rewritten. */
  text: z.string().min(1),
  /** Resolved leaf language: authored leaf language, else the lesson language. */
  language: z.enum(["ar", "en"]),
  /** Derived from language: ar => rtl, en => ltr. */
  direction: Direction,
  speaker: z.string().min(1).optional(),
  delivery: z.enum(["neutral", "enthusiastic", "calm", "serious"]).optional(),
  pause_before: z.number().int().min(0).optional(),
  pause_after: z.number().int().min(0).optional(),
});
export type CompiledNarration = z.infer<typeof CompiledNarrationSchema>;

export const CompiledOnScreenTextSchema = z.strictObject({
  role: z.enum(ON_SCREEN_TEXT_ROLES),
  /** Authored text — preserved exactly. */
  text: z.string().min(1),
  /** Resolved leaf language (as for narration). */
  language: z.enum(["ar", "en"]),
  /** Derived from language. */
  direction: Direction,
  emphasis: z.enum(["none", "subtle", "strong"]).optional(),
});
export type CompiledOnScreenText = z.infer<typeof CompiledOnScreenTextSchema>;

// ---------------------------------------------------------------------------
// Operations — one authored action beat maps to exactly one compiled operation.
// ---------------------------------------------------------------------------

/** Derived structural family of an action (classification only — never behavior). */
export const ActionFamily = z.enum(["file", "editor", "terminal", "wait", "browser", "visual"]);
export type ActionFamilyValue = z.infer<typeof ActionFamily>;

export const ProcessDefinitionRefSchema = z.strictObject({
  scene_id: z.string().min(1),
  beat_id: z.string().min(1),
});
export type ProcessDefinitionRef = z.infer<typeof ProcessDefinitionRefSchema>;

/** Derived logical reference metadata. Never an OS pid; no process exists at compile time. */
export const CompiledOperationReferencesSchema = z.strictObject({
  process: z.strictObject({
    process_id: z.string().min(1),
    /** Where the referenced process was defined (earlier background terminal_run). */
    defined_in: ProcessDefinitionRefSchema,
  }),
});
export type CompiledOperationReferences = z.infer<typeof CompiledOperationReferencesSchema>;

export const CompiledOperationSchema = z
  .strictObject({
    /** Exact authored action type — preserved, never renamed or invented. */
    type: z.string().min(1),
    /** Derived structural family (see ActionFamily). */
    family: ActionFamily,
    /**
     * The validated authored action, preserved verbatim including its `type`
     * field. Runtimes read parameters; they never re-parse YAML.
     */
    parameters: ActionSchema,
    /** Derived logical references (present on terminal_stop / wait until=process_output). */
    references: CompiledOperationReferencesSchema.optional(),
  })
  .superRefine((operation, ctx) => {
    const parameters = operation.parameters as { type?: unknown };
    if (parameters.type !== operation.type) {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: "[IR_OPERATION_TYPE_MISMATCH] operation.type must equal parameters.type",
      });
    }
  });
export type CompiledOperation = z.infer<typeof CompiledOperationSchema>;

// ---------------------------------------------------------------------------
// Steps — the uniform, unambiguous ordered sequence of a scene.
// ---------------------------------------------------------------------------

const StepFields = {
  /**
   * Step address: for authored steps the authored beat_id itself; for the
   * compiler-synthesized scene-narration step a derived `<scene_id>-STEPnnn`
   * id — clearly marked derived, never shaped like an authored beat id.
   */
  step_id: z.string().min(1),
  /** 1-based authored position within the scene's steps (derived metadata). */
  ordinal: z.number().int().min(1),
  /** True only for compiler-synthesized steps; false for authored beats. */
  derived: z.boolean(),
  source_ref: SourceRefSchema,
};

export const CompiledStepSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({ kind: z.literal("narration"), ...StepFields, narration: CompiledNarrationSchema })
    .superRefine((step, ctx) => {
      const synthesized = step.source_ref.form === "scene_narration";
      if (step.derived !== synthesized) {
        ctx.addIssue({
          code: "custom",
          message:
            "[IR_STEP_DERIVATION_MISMATCH] the derived flag must match source_ref.form (scene_narration steps are derived; authored_beat steps are not)",
        });
        return;
      }
      if (synthesized) {
        if (!step.step_id.startsWith(`${step.source_ref.scene_id}-STEP`)) {
          ctx.addIssue({
            code: "custom",
            path: ["step_id"],
            message:
              "[IR_DERIVED_STEP_ID_MALFORMED] derived step ids must have the form '<scene_id>-STEPnnn' — they are compiler-internal addresses, never authored beat ids",
          });
        }
      } else if (step.step_id !== step.source_ref.beat_id) {
        ctx.addIssue({
          code: "custom",
          path: ["step_id"],
          message: "[IR_STEP_ID_MISMATCH] authored steps keep their authored beat id as step_id",
        });
      }
    }),
  z
    .strictObject({ kind: z.literal("pause"), ...StepFields, derived: z.literal(false), seconds: z.number().int().positive() })
    .superRefine((step, ctx) => {
      if (step.source_ref.form !== "authored_beat" || step.step_id !== step.source_ref.beat_id) {
        ctx.addIssue({
          code: "custom",
          message: "[IR_STEP_ID_MISMATCH] pause steps are always authored beats addressed by their beat id",
        });
      }
    }),
  z
    .strictObject({ kind: z.literal("operation"), ...StepFields, derived: z.literal(false), operation: CompiledOperationSchema })
    .superRefine((step, ctx) => {
      if (step.source_ref.form !== "authored_beat" || step.step_id !== step.source_ref.beat_id) {
        ctx.addIssue({
          code: "custom",
          message: "[IR_STEP_ID_MISMATCH] operation steps are always authored beats addressed by their beat id",
        });
      }
    }),
]);
export type CompiledStep = z.infer<typeof CompiledStepSchema>;

// ---------------------------------------------------------------------------
// Scenes — authored order preserved exactly.
// ---------------------------------------------------------------------------

export const CompiledSceneSchema = z.strictObject({
  scene_id: z.string().min(1),
  /** 1-based authored scene position in lesson order (derived metadata). */
  ordinal: z.number().int().min(1),
  type: z.enum(SCENE_TYPES),
  title: z.string().min(1),
  /** Authored scene duration, integer seconds. */
  duration_seconds: z.number().int().positive(),
  /** Provenance of the scene's narration: authored beats sequence, or the single top-level narration. */
  narration_form: z.enum(["beats", "single_narration"]),
  /** Authored visual intent — preserved verbatim (WHAT to show, never coordinates). */
  visual: VisualSchema,
  /** Authored order, exactly. Never sorted, grouped, or optimized. */
  steps: z.array(CompiledStepSchema).min(1),
  on_screen_text: z.array(CompiledOnScreenTextSchema),
  /** Authored content blocks (code/math) — code text preserved exactly. */
  blocks: z.array(ContentBlockSchema),
  assets: z.array(AssetRefSchema),
  interaction: InteractionSchema.optional(),
  audio: AudioSchema.optional(),
  transitions: TransitionsSchema.optional(),
  alt_text: z.string().min(1).optional(),
  notes: z.string().optional(),
});
export type CompiledScene = z.infer<typeof CompiledSceneSchema>;

// ---------------------------------------------------------------------------
// Background process inventory — derived from explicit source only. No process
// is started, awaited, probed, or stopped at compile time; these are records.
// ---------------------------------------------------------------------------

export const CompiledProcessWaitSchema = z.strictObject({
  scene_id: z.string().min(1),
  beat_id: z.string().min(1),
  /** Authored readiness text — preserved exactly. */
  text: z.string().min(1),
  timeout_seconds: z.number().int().positive(),
});
export type CompiledProcessWait = z.infer<typeof CompiledProcessWaitSchema>;

export const CompiledProcessSchema = z.strictObject({
  process_id: z.string().min(1),
  /** Authored command — data only. */
  command: z.string().min(1),
  /** Authored project-relative working directory. */
  cwd: z.string().min(1).optional(),
  started_in: z.strictObject({
    scene_id: z.string().min(1),
    beat_id: z.string().min(1),
    scene_ordinal: z.number().int().min(1),
    step_ordinal: z.number().int().min(1),
  }),
  /** Where the process is explicitly stopped (terminal_stop), when authored. */
  stopped_in: ProcessDefinitionRefSchema.optional(),
  /** Explicit process_output readiness waits, in authored order. */
  output_waits: z.array(CompiledProcessWaitSchema),
});
export type CompiledProcess = z.infer<typeof CompiledProcessSchema>;

// ---------------------------------------------------------------------------
// Source identity
// ---------------------------------------------------------------------------

export const SourceHashSchema = z.strictObject({
  algorithm: z.literal("sha256"),
  /** Canonicalization applied before hashing (see src/canonical.ts). */
  canonicalization: z.literal("canonical-json-v1"),
  value: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SourceHash = z.infer<typeof SourceHashSchema>;

// ---------------------------------------------------------------------------
// Lesson-level compiled metadata
// ---------------------------------------------------------------------------

export const CompiledLessonMetadataSchema = z.strictObject({
  course_id: z.string().min(1),
  lesson_id: z.string().min(1),
  title: z.string().min(1),
  language: z.enum(["ar", "en", "mixed"]),
  /** Derived from the lesson language (ar => rtl, en => ltr); null when mixed — mixed lessons carry per-leaf language + direction. */
  direction: Direction.nullable(),
  subject: z.string().min(1),
  grade_level: z.string().min(1),
  /** Authored lesson duration, integer seconds. */
  duration_seconds: z.number().int().positive(),
  learning_objectives: z.array(z.string().min(1)),
  prerequisites: z.array(z.string().min(1)),
  keywords: z.array(z.string().min(1)),
  /** Authored metadata preserved; keys canonically sorted (key order is not semantic). */
  metadata: z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
  unit: z.string().min(1).optional(),
  chapter: z.string().min(1).optional(),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
});
export type CompiledLessonMetadata = z.infer<typeof CompiledLessonMetadataSchema>;

/** Derived capability requirements — structural actions only, never narration wording. */
export const CompiledCapabilitiesSchema = z.strictObject({
  terminal: z.boolean(),
  browser: z.boolean(),
  editor: z.boolean(),
  voice: z.boolean(),
});
export type CompiledCapabilities = z.infer<typeof CompiledCapabilitiesSchema>;

/** Deterministic inventory of explicitly referenced resources (never resolved to the machine filesystem). */
export const CompiledResourcesSchema = z.strictObject({
  /** Explicit project-relative paths from structured action fields (file targets, working directories). Commands are never parsed. */
  paths: z.array(z.string().min(1)),
  /** Authored asset references. */
  assets: z.array(z.string().min(1)),
  /** Origins (protocol + host + port) of authored browser_open URLs. */
  browser_origins: z.array(z.string().min(1)),
});
export type CompiledResources = z.infer<typeof CompiledResourcesSchema>;

// ---------------------------------------------------------------------------
// Root document
// ---------------------------------------------------------------------------

export const CompiledLessonSchema = z.strictObject({
  compiled_ir_version: z.literal(COMPILED_IR_VERSION),
  compiler: z.strictObject({ name: z.literal(COMPILER_NAME), version: z.literal(COMPILER_VERSION) }),
  source: z.strictObject({
    /** Canonical lesson schema version this document was compiled from. */
    schema_version: z.string().min(1),
    /** Deterministic hash of the canonical semantic source content. */
    hash: SourceHashSchema,
  }),
  lesson: CompiledLessonMetadataSchema,
  capabilities: CompiledCapabilitiesSchema,
  resources: CompiledResourcesSchema,
  /** Background processes in authored definition order. */
  processes: z.array(CompiledProcessSchema),
  /** Authored scene order, exactly. */
  scenes: z.array(CompiledSceneSchema).min(1),
});
export type CompiledLesson = z.infer<typeof CompiledLessonSchema>;

// ---------------------------------------------------------------------------
// Output self-validation — a compiler that emits an invalid IR is a broken
// compiler; the CLI refuses to write such output (exit code 3).
// ---------------------------------------------------------------------------

export interface IrValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface IrValidationResult {
  ok: boolean;
  issues: IrValidationIssue[];
  /** The parsed, schema-normalized IR — present only when ok. (Additive in P4.) */
  ir?: CompiledLesson;
}

export function validateCompiledLesson(value: unknown): IrValidationResult {
  const result = CompiledLessonSchema.safeParse(value);
  if (result.success) {
    return { ok: true, issues: [], ir: result.data };
  }
  return { ok: false, issues: formatZodIssues(result.error) };
}
