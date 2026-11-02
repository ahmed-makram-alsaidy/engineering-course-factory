// Course Factory — Canonical Lesson Schema v1.0 (Zod validation authority)
// This module is THE single source of truth for lesson.yaml validation.
// All other representations (types, JSON Schema exports, other-language models)
// must be derived from here — never hand-maintained in parallel.
//
// Extension rule: unknown fields are ERRORS (strict objects). To extend the
// schema, add fields and bump `schema_version` (migration tooling comes later).

import { z } from "zod";

export const SCHEMA_VERSION = "1.1";

// ---------------------------------------------------------------------------
// Identifiers (deterministic, P1 naming conventions)
// ---------------------------------------------------------------------------

/** Course identifier, e.g. C01 */
export const COURSE_ID_PATTERN = /^C\d{2}$/;
/** Lesson identifier, e.g. C01-L003 */
export const LESSON_ID_PATTERN = /^C\d{2}-L\d{3}$/;
/** Scene identifier, e.g. C01-L003-S014 (full form; parent consistency is checked cross-field) */
export const SCENE_ID_PATTERN = /^C\d{2}-L\d{3}-S\d{3}$/;
/** Beat (ordered production step) identifier, e.g. C01-L003-S014-B001 */
export const BEAT_ID_PATTERN = /^C\d{2}-L\d{3}-S\d{3}-B\d{3}$/;
/** Logical background process identifier, e.g. dev_server */
export const PROCESS_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// ---------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------
// Lesson-level language: ar | en | mixed
// Leaf-level language (a narration utterance, an on-screen text element):
//   ar | en only — a single utterance/element is never "mixed"; in mixed
//   lessons every leaf MUST declare its language explicitly.
// Text direction is DERIVED (ar => rtl, en => ltr), never stored.

export const LessonLanguage = z.enum(["ar", "en", "mixed"]);
export const LeafLanguage = z.enum(["ar", "en"]);
export type LessonLanguageValue = z.infer<typeof LessonLanguage>;
export type LeafLanguageValue = z.infer<typeof LeafLanguage>;

// ---------------------------------------------------------------------------
// Scene types (controlled enum)
// ---------------------------------------------------------------------------
// code_demo is included deliberately: real executable coding demonstrations are
// a core product requirement of Course Factory (P5/P6 pipeline stages).

export const SCENE_TYPES = [
  "intro",
  "explanation",
  "example",
  "code_demo",
  "question",
  "answer",
  "summary",
  "transition",
  "outro",
] as const;
export const SceneType = z.enum(SCENE_TYPES);
export type SceneTypeValue = (typeof SCENE_TYPES)[number];

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------
// Canonical representation: an integer number of SECONDS. Strings like
// "2 minutes" or "00:02:00" are invalid and rejected.

export const DurationSeconds = z
  .number({ message: "duration must be a number of seconds (integer > 0)" })
  .int("duration must be an integer number of seconds")
  .positive("duration must be a positive number of seconds");

// ---------------------------------------------------------------------------
// Asset references
// ---------------------------------------------------------------------------
// Assets are referenced by logical project-relative POSIX-style paths or IDs.
// ABSOLUTE PATHS ARE FORBIDDEN: no drive letters, no backslashes, no leading
// "/", no ".." segments. Machine paths are resolved via config/paths.json.

export const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;

/** Shared project-relative path safety checks (assets AND authored file paths). */
function projectRelativePathProblems(value: string): string[] {
  const problems: string[] = [];
  if (value.includes("\\")) problems.push("backslashes are not allowed (use '/')");
  if (/^[A-Za-z]:/.test(value)) problems.push("drive letters are not allowed (absolute path)");
  if (value.startsWith("/")) problems.push("leading '/' is not allowed (must be project-relative)");
  if (value.split("/").includes("..")) problems.push("'..' segments are not allowed");
  if (!ASSET_ID_PATTERN.test(value)) problems.push("characters outside [A-Za-z0-9_-./] are not allowed");
  if (value.length === 0) problems.push("empty path");
  return problems;
}

export const AssetId = z
  .string()
  .superRefine((value, ctx) => {
    const problems = projectRelativePathProblems(value);
    if (problems.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `[ASSET_REF_NOT_PROJECT_RELATIVE] '${value}' is not a valid project-relative asset reference: ${problems.join("; ")}`,
      });
    }
  });

/** Lesson-authored file paths (file/editor actions) — same machine-independence rule as assets. */
export const FilePath = z
  .string()
  .superRefine((value, ctx) => {
    const problems = projectRelativePathProblems(value);
    if (problems.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `[INVALID_PROJECT_RELATIVE_PATH] '${value}' is not a valid project-relative path: ${problems.join("; ")}`,
      });
    }
  });

// ---------------------------------------------------------------------------
// Scene sub-models
// ---------------------------------------------------------------------------

export const NarrationSchema = z.strictObject({
  text: z.string().min(1, "narration text must not be empty"),
  language: LeafLanguage.optional(),
  speaker: z.string().min(1).optional(),
  delivery: z.enum(["neutral", "enthusiastic", "calm", "serious"]).optional(),
  pause_before: z.number().int().min(0).optional(),
  pause_after: z.number().int().min(0).optional(),
});
export type Narration = z.infer<typeof NarrationSchema>;

export const ON_SCREEN_TEXT_ROLES = ["title", "caption", "highlight", "code", "formula", "note"] as const;
export const OnScreenTextSchema = z.strictObject({
  role: z.enum(ON_SCREEN_TEXT_ROLES),
  text: z.string().min(1),
  language: LeafLanguage.optional(),
  emphasis: z.enum(["none", "subtle", "strong"]).optional(),
});
export type OnScreenText = z.infer<typeof OnScreenTextSchema>;

// Visual INTENT — describes WHAT to show, never renderer coordinates,
// never Unreal/Blender implementation details.
export const VISUAL_KINDS = [
  "fullscreen_text",
  "diagram",
  "code_editor",
  "terminal",
  "browser",
  "animation",
  "instructor_closeup",
  "studio_wide",
  "image",
  "none",
] as const;
export const VisualSchema = z.strictObject({
  kind: z.enum(VISUAL_KINDS),
  description: z.string().min(1, "visual description must not be empty"),
  subject: z.string().min(1).optional(),
});
export type Visual = z.infer<typeof VisualSchema>;

export const AudioSchema = z.strictObject({
  music: z.string().min(1).optional(),
  sfx: z.array(z.string().min(1)).optional(),
});
export type Audio = z.infer<typeof AudioSchema>;

export const TransitionKind = z.enum(["cut", "fade", "slide"]);
export const TransitionsSchema = z
  .strictObject({
    in: TransitionKind.optional(),
    in_duration_seconds: z.number().int().min(0).optional(),
    out: TransitionKind.optional(),
    out_duration_seconds: z.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.in_duration_seconds !== undefined && value.in === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["in_duration_seconds"],
        message: "[TRANSITION_DURATION_WITHOUT_TYPE] in_duration_seconds requires 'in' to be set",
      });
    }
    if (value.out_duration_seconds !== undefined && value.out === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["out_duration_seconds"],
        message: "[TRANSITION_DURATION_WITHOUT_TYPE] out_duration_seconds requires 'out' to be set",
      });
    }
  });
export type Transitions = z.infer<typeof TransitionsSchema>;

export const InteractionSchema = z
  .strictObject({
    kind: z.enum(["multiple_choice", "true_false", "short_answer"]),
    prompt: z.string().min(1),
    choices: z.array(z.string().min(1)).min(2).optional(),
    correct_answer: z.union([z.string().min(1), z.boolean()]),
    explanation: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "multiple_choice") {
      if (value.choices === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["choices"],
          message: "[CHOICES_REQUIRED_FOR_MULTIPLE_CHOICE] multiple_choice interaction requires 'choices'",
        });
      } else if (typeof value.correct_answer === "string" && !value.choices.includes(value.correct_answer)) {
        ctx.addIssue({
          code: "custom",
          path: ["correct_answer"],
          message: "[CORRECT_ANSWER_NOT_IN_CHOICES] multiple_choice correct_answer must be one of 'choices'",
        });
      }
    }
    if (value.kind === "true_false" && typeof value.correct_answer !== "boolean") {
      ctx.addIssue({
        code: "custom",
        path: ["correct_answer"],
        message: "[TRUE_FALSE_REQUIRES_BOOLEAN_ANSWER] true_false correct_answer must be true or false",
      });
    }
    if (value.kind === "short_answer" && typeof value.correct_answer !== "string") {
      ctx.addIssue({
        code: "custom",
        path: ["correct_answer"],
        message: "[SHORT_ANSWER_REQUIRES_STRING_ANSWER] short_answer correct_answer must be a string",
      });
    }
  });
export type Interaction = z.infer<typeof InteractionSchema>;

// Structured content blocks: code / math carry semantic content that later
// stages (typing engine, terminal engine, renderer) consume — never flattened
// into prose.
export const ContentBlockSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("code"),
    language: z.string().min(1),
    source: z.string(),
    filename: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("math"),
    notation: z.enum(["latex", "asciimath"]),
    source: z.string().min(1),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const ASSET_TYPES = ["image", "audio", "video", "model", "data"] as const;
export const AssetRefSchema = z.strictObject({
  asset_id: AssetId,
  type: z.enum(ASSET_TYPES).optional(),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

// ---------------------------------------------------------------------------
// EXECUTION CONTRACT (P2A) — explicit, ordered production steps
// ---------------------------------------------------------------------------
// The author specifies WHAT happens and in WHAT order. The compiler (P3) may
// validate/normalize/resolve references but must NEVER invent, infer, or
// reorder actions. Runtime phases (P4-P8) execute exactly these instructions.

export const ProcessId = z
  .string()
  .superRefine((value, ctx) => {
    if (!PROCESS_ID_PATTERN.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: `[INVALID_PROCESS_ID] '${value}' is not a valid logical process identifier (expected [A-Za-z] followed by letters/digits/_/- , max 64 chars, e.g. 'dev_server')`,
      });
    }
  });

// --- Browser selectors: semantic, never pixel coordinates ---

export const BROWSER_SELECTOR_STRATEGIES = ["role", "label", "test_id", "text", "css"] as const;
export const BrowserSelector = z
  .strictObject({
    strategy: z.string().min(1),
    value: z.string().min(1),
    /** Accessible name, only meaningful for role selectors */
    name: z.string().min(1).optional(),
  })
  .superRefine((selector, ctx) => {
    if (!(BROWSER_SELECTOR_STRATEGIES as readonly string[]).includes(selector.strategy)) {
      ctx.addIssue({
        code: "custom",
        path: ["strategy"],
        message: `[INVALID_BROWSER_SELECTOR] unknown selector strategy '${selector.strategy}' (expected one of: ${BROWSER_SELECTOR_STRATEGIES.join(", ")})`,
      });
    }
    if (selector.name !== undefined && selector.strategy !== "role") {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: `[INVALID_BROWSER_SELECTOR] 'name' is only meaningful with strategy 'role' (got '${selector.strategy}')`,
      });
    }
  });

export type BrowserSelectorValue = z.infer<typeof BrowserSelector>;

// --- Actions (discriminated union on `type`) ---

const FileOpenAction = z.strictObject({ type: z.literal("file_open"), path: FilePath });
const FileCreateAction = z.strictObject({
  type: z.literal("file_create"),
  path: FilePath,
  /** Optional initial content; omitted when code will be typed in afterward */
  content: z.string().optional(),
});
const TypeCodeAction = z.strictObject({
  type: z.literal("type_code"),
  path: FilePath,
  content: z.string(),
  /** Optional logical insertion target: 1-based line number (append when omitted) */
  at_line: z.number().int().min(1).optional(),
});
const ReplaceCodeAction = z.strictObject({
  type: z.literal("replace_code"),
  path: FilePath,
  /** Exact text to replace — no fuzzy/similarity semantics */
  find: z.string().min(1),
  replace: z.string(),
  /** Expected number of occurrences (default 1) — determinism guard */
  occurrences: z.number().int().min(1).optional(),
});
const FileSaveAction = z.strictObject({ type: z.literal("file_save"), path: FilePath });

const TerminalRunAction = z
  .strictObject({
    type: z.literal("terminal_run"),
    command: z.string().min(1),
    /** Optional project-relative working directory */
    cwd: FilePath.optional(),
    mode: z.enum(["foreground", "background"]),
    /** REQUIRED for background: logical process id later actions can reference */
    process_id: ProcessId.optional(),
    /** Foreground only: give up after N seconds */
    timeout_seconds: z.number().int().positive().optional(),
    /** Foreground only: expected exit code (default 0 documented) */
    expected_exit_code: z.number().int().min(0).optional(),
  })
  .superRefine((action, ctx) => {
    if (action.mode === "background") {
      if (action.process_id === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["process_id"],
          message: "[BACKGROUND_PROCESS_ID_REQUIRED] background terminal_run requires a logical 'process_id' that later actions can reference",
        });
      }
      if (action.timeout_seconds !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["timeout_seconds"],
          message: "[TIMEOUT_FOREGROUND_ONLY] timeout_seconds applies to foreground commands only (background processes keep running)",
        });
      }
      if (action.expected_exit_code !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["expected_exit_code"],
          message: "[EXPECTED_EXIT_CODE_FOREGROUND_ONLY] expected_exit_code applies to foreground commands only",
        });
      }
    } else if (action.process_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["process_id"],
        message: "[PROCESS_ID_ONLY_FOR_BACKGROUND] foreground commands do not create referenceable processes; use mode 'background'",
      });
    }
  });

const TerminalStopAction = z.strictObject({
  type: z.literal("terminal_stop"),
  process_id: ProcessId,
});

/** Readiness/waiting — contract only, no network checks implemented in P2A. */
export const WaitAction = z
  .strictObject({
    type: z.literal("wait"),
    until: z.enum(["duration", "port", "process_output"]),
    /** until=duration */
    seconds: z.number().int().positive().optional(),
    /** until=port */
    port: z.number().int().min(1).max(65535).optional(),
    host: z.string().min(1).optional(),
    /** until=process_output */
    process_id: ProcessId.optional(),
    text: z.string().min(1).optional(),
    timeout_seconds: z.number().int().positive().optional(),
  })
  .superRefine((wait, ctx) => {
    const requireFields = (fields: [string, unknown][], hint: string) => {
      for (const [field, value] of fields) {
        if (value === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `[WAIT_FIELDS_REQUIRED] wait until='${wait.until}' requires '${field}' (${hint})`,
          });
        }
      }
    };
    if (wait.until === "duration") {
      requireFields([["seconds", wait.seconds]], "fixed wait length in integer seconds");
    }
    if (wait.until === "port") {
      requireFields(
        [
          ["port", wait.port],
          ["timeout_seconds", wait.timeout_seconds],
        ],
        "wait until a TCP port accepts connections",
      );
    }
    if (wait.until === "process_output") {
      requireFields(
        [
          ["process_id", wait.process_id],
          ["text", wait.text],
          ["timeout_seconds", wait.timeout_seconds],
        ],
        "wait until a background process prints the given output text",
      );
    }
  });

const BrowserOpenAction = z
  .strictObject({ type: z.literal("browser_open"), url: z.string().min(1) })
  .superRefine((action, ctx) => {
    let url: URL;
    try {
      url = new URL(action.url);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: `[INVALID_URL] '${action.url}' is not a parseable URL`,
      });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: `[INVALID_URL] only http/https URLs are allowed (got '${url.protocol}')`,
      });
    }
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "[URL_CREDENTIALS_FORBIDDEN] URLs with embedded credentials are not allowed in lesson files",
      });
    }
  });

const BrowserClickAction = z.strictObject({ type: z.literal("browser_click"), selector: BrowserSelector });
const BrowserFillAction = z.strictObject({ type: z.literal("browser_fill"), selector: BrowserSelector, value: z.string() });
const BrowserPressAction = z.strictObject({ type: z.literal("browser_press"), key: z.string().min(1) });
const BrowserRefreshAction = z.strictObject({ type: z.literal("browser_refresh") });
const BrowserWaitAction = z
  .strictObject({
    type: z.literal("browser_wait"),
    selector: BrowserSelector.optional(),
    text: z.string().min(1).optional(),
    timeout_seconds: z.number().int().positive(),
  })
  .superRefine((action, ctx) => {
    if (action.selector === undefined && action.text === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "[BROWSER_WAIT_FIELDS_REQUIRED] browser_wait requires a 'selector' or 'text' condition",
      });
    }
  });

const BrowserAssertAction = z
  .strictObject({
    type: z.literal("browser_assert"),
    url_contains: z.string().min(1).optional(),
    selector: BrowserSelector.optional(),
    selector_text: z.string().min(1).optional(),
    text_visible: z.string().min(1).optional(),
  })
  .superRefine((action, ctx) => {
    if (
      action.url_contains === undefined &&
      action.selector === undefined &&
      action.selector_text === undefined &&
      action.text_visible === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "[ASSERTION_FIELD_REQUIRED] browser_assert requires at least one assertion field (url_contains, selector, selector_text, text_visible)",
      });
    }
    if (action.selector_text !== undefined && action.selector === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "[SELECTOR_TEXT_REQUIRES_SELECTOR] selector_text requires a 'selector' to read text from",
      });
    }
  });

/** Semantic instructional highlighting — file/line/range, never pixel rectangles. */
const HighlightAction = z
  .strictObject({
    type: z.literal("highlight"),
    path: FilePath,
    line: z.number().int().min(1).optional(),
    line_end: z.number().int().min(1).optional(),
  })
  .superRefine((action, ctx) => {
    if (action.line_end !== undefined && action.line === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["line_end"],
        message: "[HIGHLIGHT_RANGE_INVALID] line_end requires 'line' to be set",
      });
    }
    if (action.line !== undefined && action.line_end !== undefined && action.line_end < action.line) {
      ctx.addIssue({
        code: "custom",
        path: ["line_end"],
        message: `[HIGHLIGHT_RANGE_INVALID] line_end (${action.line_end}) is before line (${action.line})`,
      });
    }
  });

export const ACTION_TYPES = [
  "file_open",
  "file_create",
  "type_code",
  "replace_code",
  "file_save",
  "terminal_run",
  "terminal_stop",
  "wait",
  "browser_open",
  "browser_click",
  "browser_fill",
  "browser_press",
  "browser_refresh",
  "browser_wait",
  "browser_assert",
  "highlight",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ActionSchema = z.discriminatedUnion("type", [
  FileOpenAction,
  FileCreateAction,
  TypeCodeAction,
  ReplaceCodeAction,
  FileSaveAction,
  TerminalRunAction,
  TerminalStopAction,
  WaitAction,
  BrowserOpenAction,
  BrowserClickAction,
  BrowserFillAction,
  BrowserPressAction,
  BrowserRefreshAction,
  BrowserWaitAction,
  BrowserAssertAction,
  HighlightAction,
]);
export type Action = z.infer<typeof ActionSchema>;

// --- Beats: the ordered production sequence of a scene ---

export const BeatId = z
  .string()
  .superRefine((value, ctx) => {
    if (!BEAT_ID_PATTERN.test(value)) {
      ctx.addIssue({
        code: "custom",
        message: `[BEAT_ID_MALFORMED] '${value}' is not a valid beat id (expected Cnn-Lnnn-Snnn-Bnnn, e.g. C01-L003-S014-B001)`,
      });
    }
  });

export const BeatsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("narration"), beat_id: BeatId, narration: NarrationSchema }),
  z.strictObject({ kind: z.literal("action"), beat_id: BeatId, action: ActionSchema }),
  z.strictObject({ kind: z.literal("pause"), beat_id: BeatId, seconds: z.number().int().positive() }),
]);
export type Beat = z.infer<typeof BeatsSchema>;

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export const SceneSchema = z.strictObject({
  scene_id: z.string().regex(SCENE_ID_PATTERN, "scene_id must have the form Cnn-Lnnn-Snnn (e.g. C01-L003-S014)"),
  type: SceneType,
  title: z.string().min(1),
  duration: DurationSeconds,
  /**
   * Simple scenes: single narration (plays once). Mutually exclusive with
   * `beats` — there is never a second competing narration source.
   */
  narration: NarrationSchema.optional(),
  /**
   * Ordered production sequence: narration/action/pause beats in exact
   * authored order. Required for code_demo scenes (deterministic execution).
   */
  beats: z.array(BeatsSchema).default([]),
  on_screen_text: z.array(OnScreenTextSchema).default([]),
  visual: VisualSchema,
  audio: AudioSchema.optional(),
  transitions: TransitionsSchema.optional(),
  interaction: InteractionSchema.optional(),
  blocks: z.array(ContentBlockSchema).default([]),
  assets: z.array(AssetRefSchema).default([]),
  alt_text: z.string().min(1).optional(),
  notes: z.string().optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

// ---------------------------------------------------------------------------
// Lesson (root document)
// ---------------------------------------------------------------------------

export const MetadataSchema = z.record(
  z.string().min(1),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);
export type Metadata = z.infer<typeof MetadataSchema>;

export const LessonSchema = z
  .strictObject({
    schema_version: z.literal(SCHEMA_VERSION, {
      message: `schema_version must be the literal string "${SCHEMA_VERSION}"`,
    }),
    course_id: z.string().regex(COURSE_ID_PATTERN, "course_id must have the form Cnn (e.g. C01)"),
    lesson_id: z.string().regex(LESSON_ID_PATTERN, "lesson_id must have the form Cnn-Lnnn (e.g. C01-L003)"),
    title: z.string().min(1, "title is required and must not be empty"),
    language: LessonLanguage,
    subject: z.string().min(1),
    grade_level: z.string().min(1),
    duration: DurationSeconds,
    learning_objectives: z.array(z.string().min(1)).min(1, "at least one learning objective is required"),
    prerequisites: z.array(z.string().min(1)),
    keywords: z.array(z.string().min(1)),
    scenes: z.array(SceneSchema).min(1, "a lesson needs at least one scene"),
    metadata: MetadataSchema.default({}),
    // optional educational navigation metadata
    unit: z.string().min(1).optional(),
    chapter: z.string().min(1).optional(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  })
  .superRefine((lesson, ctx) => {
    // 1) lesson_id must belong to course_id
    if (!lesson.lesson_id.startsWith(`${lesson.course_id}-L`)) {
      ctx.addIssue({
        code: "custom",
        path: ["lesson_id"],
        message: `[LESSON_ID_COURSE_MISMATCH] lesson_id '${lesson.lesson_id}' does not belong to course_id '${lesson.course_id}' (expected prefix '${lesson.course_id}-Lnnn')`,
      });
    }

    // 2) scene_id uniqueness
    const seen = new Map<string, number>();
    lesson.scenes.forEach((scene, index) => {
      const firstAt = seen.get(scene.scene_id);
      if (firstAt !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", index, "scene_id"],
          message: `[DUPLICATE_SCENE_ID] scene_id '${scene.scene_id}' already used by scenes[${firstAt}]`,
        });
      } else {
        seen.set(scene.scene_id, index);
      }
    });

    // 3) scene_id parent consistency: each scene belongs to this lesson
    lesson.scenes.forEach((scene, index) => {
      if (!scene.scene_id.startsWith(`${lesson.lesson_id}-S`)) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", index, "scene_id"],
          message: `[SCENE_ID_PARENT_MISMATCH] scene_id '${scene.scene_id}' does not belong to lesson_id '${lesson.lesson_id}' (expected prefix '${lesson.lesson_id}-Snnn')`,
        });
      }
    });

    // 4) language rules for mixed lessons: every leaf must declare ar | en
    if (lesson.language === "mixed") {
      lesson.scenes.forEach((scene, sceneIndex) => {
        if (scene.narration?.language === undefined && scene.beats.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", sceneIndex, "narration", "language"],
            message: "[NARRATION_LANGUAGE_REQUIRED_IN_MIXED] narration.language is required in mixed-language lessons",
          });
        }
        scene.beats.forEach((beat, beatIndex) => {
          if (beat.kind === "narration" && beat.narration.language === undefined) {
            ctx.addIssue({
              code: "custom",
              path: ["scenes", sceneIndex, "beats", beatIndex, "narration", "language"],
              message: "[NARRATION_LANGUAGE_REQUIRED_IN_MIXED] narration.language is required in mixed-language lessons",
            });
          }
        });
        scene.on_screen_text.forEach((text, textIndex) => {
          if (text.language === undefined) {
            ctx.addIssue({
              code: "custom",
              path: ["scenes", sceneIndex, "on_screen_text", textIndex, "language"],
              message: "[ON_SCREEN_TEXT_LANGUAGE_REQUIRED_IN_MIXED] on_screen_text.language is required in mixed-language lessons",
            });
          }
        });
      });
    }

    // 5) question scenes must carry an interaction model
    lesson.scenes.forEach((scene, index) => {
      if (scene.type === "question" && scene.interaction === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", index, "interaction"],
          message: "[QUESTION_SCENE_REQUIRES_INTERACTION] scenes of type 'question' must define an 'interaction' object",
        });
      }
    });

    // ---------------------------------------------------------------
    // 6) EXECUTION CONTRACT rules (P2A)
    // ---------------------------------------------------------------
    lesson.scenes.forEach((scene, sceneIndex) => {
      const hasBeats = scene.beats.length > 0;

      // narration and beats are mutually exclusive (no duplicated narration source)
      if (scene.narration !== undefined && hasBeats) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", sceneIndex, "narration"],
          message: "[NARRATION_BEATS_MUTUALLY_EXCLUSIVE] a scene has EITHER a single top-level narration OR an ordered beats sequence — never both (the beats sequence would duplicate the narration source)",
        });
      }
      // a scene must narrate somehow
      if (scene.narration === undefined && !hasBeats) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", sceneIndex, "narration"],
          message: "[NARRATION_REQUIRED_WITHOUT_BEATS] a scene without beats must define a top-level narration",
        });
      }

      // code_demo scenes must be deterministic: ordered beats with at least one action
      if (scene.type === "code_demo") {
        if (!hasBeats) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", sceneIndex, "beats"],
            message: "[CODE_DEMO_REQUIRES_BEATS] code_demo scenes must define an ordered beats sequence with at least one action beat (execution must be authored, never inferred)",
          });
        } else if (!scene.beats.some((beat) => beat.kind === "action")) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", sceneIndex, "beats"],
            message: "[CODE_DEMO_REQUIRES_BEATS] code_demo beats must contain at least one action beat",
          });
        }
      }

      // beat id parent consistency + uniqueness within the scene
      const seenBeats = new Map<string, number>();
      scene.beats.forEach((beat, beatIndex) => {
        if (!beat.beat_id.startsWith(`${scene.scene_id}-B`)) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", sceneIndex, "beats", beatIndex, "beat_id"],
            message: `[BEAT_ID_PARENT_MISMATCH] beat_id '${beat.beat_id}' does not belong to scene_id '${scene.scene_id}' (expected prefix '${scene.scene_id}-Bnnn')`,
          });
        }
        const firstAt = seenBeats.get(beat.beat_id);
        if (firstAt !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", sceneIndex, "beats", beatIndex, "beat_id"],
            message: `[DUPLICATE_BEAT_ID] beat_id '${beat.beat_id}' already used by beats[${firstAt}] of this scene`,
          });
        } else {
          seenBeats.set(beat.beat_id, beatIndex);
        }
      });
    });

    // background process contract: ids unique, references resolve to an
    // EARLIER definition in flattened lesson order
    const processDefinitionOrder = new Map<string, number>();
    let globalBeatIndex = 0;
    interface BeatRef {
      sceneIndex: number;
      beatIndex: number;
      order: number;
    }
    const processReferences: { process_id: string; at: BeatRef }[] = [];
    lesson.scenes.forEach((scene, sceneIndex) => {
      scene.beats.forEach((beat, beatIndex) => {
        const order = globalBeatIndex++;
        if (beat.kind === "action" && beat.action.type === "terminal_run" && beat.action.mode === "background") {
          const process_id = beat.action.process_id;
          if (process_id !== undefined) {
            if (processDefinitionOrder.has(process_id)) {
              ctx.addIssue({
                code: "custom",
                path: ["scenes", sceneIndex, "beats", beatIndex, "action", "process_id"],
                message: `[DUPLICATE_PROCESS_ID] background process_id '${process_id}' is already defined by an earlier beat (each logical process is defined once per lesson)`,
              });
            } else {
              processDefinitionOrder.set(process_id, order);
            }
          }
        }
        if (beat.kind === "action" && beat.action.type === "terminal_stop") {
          // terminal_stop carries a REQUIRED process_id, so it is a string here
          processReferences.push({ process_id: beat.action.process_id, at: { sceneIndex, beatIndex, order } });
        } else if (
          beat.kind === "action" &&
          beat.action.type === "wait" &&
          beat.action.until === "process_output" &&
          beat.action.process_id !== undefined
        ) {
          processReferences.push({ process_id: beat.action.process_id, at: { sceneIndex, beatIndex, order } });
        }
      });
    });
    for (const reference of processReferences) {
      const definedAt = processDefinitionOrder.get(reference.process_id);
      if (definedAt === undefined || definedAt >= reference.at.order) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", reference.at.sceneIndex, "beats", reference.at.beatIndex, "action", "process_id"],
          message: `[UNKNOWN_PROCESS_REFERENCE] process_id '${reference.process_id}' is not defined by an earlier background terminal_run in this lesson (processes must be started before they are stopped or awaited)`,
        });
      }
    }
  });

export type Lesson = z.infer<typeof LessonSchema>;

// ---------------------------------------------------------------------------
// Validation issue shape (stable, human-readable contract)
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  /** Dotted path into the document, e.g. `scenes[3].scene_id`, or `(root)` */
  path: string;
  /** Machine-readable code: a schema token (e.g. DUPLICATE_SCENE_ID) or a Zod code */
  code: string;
  /** Human-readable, actionable message */
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return "(root)";
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += out === "" ? String(segment) : `.${String(segment)}`;
    }
  }
  return out;
}
