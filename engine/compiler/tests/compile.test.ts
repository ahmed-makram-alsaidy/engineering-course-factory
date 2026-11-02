// P3 compilation tests — content preservation, ordering, normalization,
// provenance, capabilities, resource inventory, direction derivation.
// Deterministic and offline: nothing authored is ever executed here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonSource, type Lesson } from "@course-factory/shared-types";
import { compileLesson } from "../src/compile.ts";
import { validateCompiledLesson } from "../src/ir.ts";
import type { CompiledLesson, CompiledOperation } from "../src/ir.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sharedFixtures = join(here, "..", "..", "..", "packages", "shared-types", "fixtures");
const localFixtures = join(here, "fixtures");

function compileFixture(dir: string, file: string): { source: string; lesson: Lesson; compiled: CompiledLesson } {
  const source = readFileSync(join(dir, file), "utf8");
  const parsed = parseLessonSource(source, file);
  assert.equal(parsed.ok, true, `${file} must be valid:\n${JSON.stringify(parsed.issues, null, 2)}`);
  return { source, lesson: parsed.lesson as Lesson, compiled: compileLesson(parsed.lesson as Lesson) };
}

function operationsOf(compiled: CompiledLesson): CompiledOperation[] {
  return compiled.scenes.flatMap((scene) => scene.steps.filter((step) => step.kind === "operation").map((step) => step.operation));
}

describe("compile: source identity", () => {
  it("records the compiled IR version, compiler version, and source schema version separately", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/en-lesson.yaml");
    assert.equal(compiled.compiled_ir_version, "1.0");
    assert.equal(compiled.compiler.version, "0.1.0");
    assert.equal(compiled.compiler.name, "course-factory-lesson-compiler");
    assert.equal(compiled.source.schema_version, "1.1");
  });

  it("the compiled IR passes its own contract validation", () => {
    for (const [dir, file] of [
      [sharedFixtures, "valid/ar-lesson.yaml"],
      [sharedFixtures, "valid/en-lesson.yaml"],
      [sharedFixtures, "valid/mixed-lesson.yaml"],
      [sharedFixtures, "valid/p2a-dev-server.yaml"],
      [sharedFixtures, "valid/p2a-editor-typing.yaml"],
      [sharedFixtures, "valid/p2a-file-lifecycle.yaml"],
      [sharedFixtures, "valid/p2a-narration-action-order.yaml"],
      [sharedFixtures, "valid/p2a-terminal-foreground.yaml"],
      [localFixtures, "p3-side-effect-safety.yaml"],
    ] as const) {
      const { compiled } = compileFixture(dir, file);
      const check = validateCompiledLesson(compiled);
      assert.equal(check.ok, true, `${file}: ${JSON.stringify(check.issues, null, 2)}`);
    }
  });
});

describe("compile: content preservation (authored text is data)", () => {
  it("preserves Arabic narration text exactly and derives rtl", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/ar-lesson.yaml");
    assert.equal(compiled.lesson.language, "ar");
    assert.equal(compiled.lesson.direction, "rtl");
    const intro = compiled.scenes[0];
    assert.equal(intro.narration_form, "single_narration");
    const step = intro.steps[0];
    assert.equal(step.derived, true);
    assert.equal(step.source_ref.form, "scene_narration");
    assert.equal(
      step.kind === "narration" && step.narration.text,
      "أهلاً بك في أول درس من دورة بايثون. اليوم سنتعرف على المتغيرات وأهميتها.",
    );
    if (step.kind !== "narration") return assert.fail("expected narration step");
    assert.equal(step.narration.language, "ar");
    assert.equal(step.narration.direction, "rtl");
  });

  it("preserves the authored English narration text exactly", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/en-lesson.yaml");
    const questionScene = compiled.scenes[3];
    assert.equal(
      questionScene.steps[0].kind === "narration" && questionScene.steps[0].narration.text,
      "How many lines will this loop print if we change range to range(3)?",
    );
  });

  it("preserves authored code text byte-for-byte (no formatting, no correction)", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/ar-lesson.yaml");
    const typeCode = operationsOf(compiled).find((op) => op.type === "type_code");
    assert.ok(typeCode, "expected a type_code operation");
    const expected = `name = "أحمد"\nprint(f"مرحباً {name}")\n`;
    assert.equal(typeCode.parameters.type === "type_code" && typeCode.parameters.content, expected);
  });

  it("preserves the authored terminal command and its mode/timeout/exit-code parameters verbatim", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-terminal-foreground.yaml");
    const run = operationsOf(compiled).find((op) => op.type === "terminal_run");
    assert.deepEqual(run?.parameters, {
      type: "terminal_run",
      command: "node --version",
      mode: "foreground",
      timeout_seconds: 30,
      expected_exit_code: 0,
    });
  });

  it("preserves browser URLs and structured selectors as inert data", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-dev-server.yaml");
    const ops = operationsOf(compiled);
    const open = ops.find((op) => op.type === "browser_open");
    assert.equal(open?.parameters.type === "browser_open" && open.parameters.url, "http://localhost:3000");
    const fill = ops.find((op) => op.type === "browser_fill");
    assert.deepEqual(fill?.parameters.type === "browser_fill" && fill.parameters.selector, {
      strategy: "test_id",
      value: "task-input",
    });
    assert.equal(fill?.parameters.type === "browser_fill" && fill.parameters.value, "buy milk");
  });

  it("preserves exact find/replace semantics including the occurrences guard", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-file-lifecycle.yaml");
    const replaces = operationsOf(compiled).filter((op) => op.type === "replace_code");
    assert.equal(replaces.length, 2);
    const withGuard = replaces[1];
    assert.equal(withGuard.parameters.type === "replace_code" && withGuard.parameters.occurrences, 1);
    assert.equal(
      withGuard.parameters.type === "replace_code" && withGuard.parameters.find,
      "const PORT = process.env.PORT || 3000;",
    );
  });

  it("preserves validated project-relative paths without resolving them to the machine", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/ar-lesson.yaml");
    const serialized = JSON.stringify(compiled);
    assert.ok(serialized.includes("first_variable.py"));
    assert.doesNotMatch(serialized, /\b[A-Za-z]:[\\/]/);
    assert.ok(!serialized.includes("E:"));
  });

  it("preserves the interaction model and authored metadata", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/en-lesson.yaml");
    const questionScene = compiled.scenes[3];
    assert.deepEqual(questionScene.interaction, {
      kind: "multiple_choice",
      prompt: "How many lines does the loop print with range(3)?",
      choices: ["2", "3", "4", "5"],
      correct_answer: "3",
      explanation: "range(3) produces 0, 1, 2 - one print per number.",
    });
  });
});

describe("compile: ordering is preserved exactly", () => {
  it("preserves scene order and adds 1-based ordinals without renumbering ids", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/en-lesson.yaml");
    assert.deepEqual(
      compiled.scenes.map((scene) => [scene.ordinal, scene.scene_id]),
      [
        [1, "C01-L002-S001"],
        [2, "C01-L002-S002"],
        [3, "C01-L002-S003"],
        [4, "C01-L002-S004"],
        [5, "C01-L002-S005"],
      ],
    );
  });

  it("preserves authored beat order and beat ids, with ordinals as separate derived metadata", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-narration-action-order.yaml");
    const scene = compiled.scenes[0];
    assert.deepEqual(
      scene.steps.map((step) => [step.ordinal, step.kind, step.step_id]),
      [
        [1, "narration", "C01-L013-S001-B001"],
        [2, "operation", "C01-L013-S001-B002"],
        [3, "narration", "C01-L013-S001-B003"],
        [4, "pause", "C01-L013-S001-B004"],
        [5, "operation", "C01-L013-S001-B005"],
        [6, "narration", "C01-L013-S001-B006"],
      ],
    );
    // beat ids are the authored ones; ordinals are separate derived numbers
    const operation = scene.steps[1];
    assert.equal(operation.kind === "operation" && operation.operation.type, "terminal_run");
  });

  it("does not group, sort, or optimize scenes of different types", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/en-lesson.yaml");
    assert.deepEqual(
      compiled.scenes.map((scene) => scene.type),
      ["intro", "explanation", "code_demo", "question", "summary"],
    );
  });

  it("simple scenes keep one derived narration step, never invented execution beats", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/ar-lesson.yaml");
    const explanation = compiled.scenes[1];
    assert.equal(explanation.narration_form, "single_narration");
    assert.equal(explanation.steps.length, 1);
    assert.equal(explanation.steps[0].kind, "narration");
    assert.equal(explanation.steps[0].derived, true);
    assert.equal(explanation.steps[0].step_id, "C01-L001-S002-STEP001");
    assert.equal(explanation.steps[0].source_ref.beat_id, null);
  });

  it("beat scenes map one authored action beat to exactly one compiled operation", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-editor-typing.yaml");
    const scene = compiled.scenes[1];
    assert.equal(scene.steps.length, 7);
    const operations = scene.steps.filter((step) => step.kind === "operation");
    assert.equal(operations.length, 4); // file_create, type_code, file_save, highlight
    assert.deepEqual(
      operations.map((step) => (step.kind === "operation" ? step.operation.parameters.type : null)),
      ["file_create", "type_code", "file_save", "highlight"],
    );
  });
});

describe("compile: normalization and provenance", () => {
  it("classifies derived action families", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-editor-typing.yaml");
    const families = operationsOf(compiled).map((op) => [op.type, op.family]);
    assert.deepEqual(families, [
      ["file_create", "file"],
      ["type_code", "editor"],
      ["file_save", "editor"],
      ["highlight", "visual"],
    ]);
    const { compiled: terminal } = compileFixture(sharedFixtures, "valid/p2a-dev-server.yaml");
    const waitOp = operationsOf(terminal).find((op) => op.type === "wait");
    assert.equal(waitOp?.family, "wait");
    const browserOps = operationsOf(terminal).filter((op) => op.family === "browser");
    assert.equal(browserOps.length, 6);
  });

  it("resolves logical process references to the authored definition point, never an OS pid", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-file-lifecycle.yaml");
    const stop = operationsOf(compiled).find((op) => op.type === "terminal_stop");
    assert.deepEqual(stop?.references, {
      process: { process_id: "demo_server", defined_in: { scene_id: "C01-L014-S001", beat_id: "C01-L014-S001-B007" } },
    });
    const serialized = JSON.stringify(compiled);
    assert.ok(!/\bpid\b/i.test(serialized));
    assert.ok(!/\bos\./.test(serialized));
  });

  it("records background processes in authored definition order with stops and output waits", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-file-lifecycle.yaml");
    assert.deepEqual(compiled.processes, [
      {
        process_id: "demo_server",
        command: "node server.js",
        started_in: { scene_id: "C01-L014-S001", beat_id: "C01-L014-S001-B007", scene_ordinal: 1, step_ordinal: 7 },
        stopped_in: { scene_id: "C01-L014-S001", beat_id: "C01-L014-S001-B010" },
        output_waits: [
          { scene_id: "C01-L014-S001", beat_id: "C01-L014-S001-B008", text: "Listening on port", timeout_seconds: 30 },
        ],
      },
    ]);
  });

  it("carries full provenance on every step (scene, ordinal, beat, form)", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-dev-server.yaml");
    for (const scene of compiled.scenes) {
      for (const step of scene.steps) {
        assert.equal(step.source_ref.scene_id, scene.scene_id);
        assert.equal(step.source_ref.scene_ordinal, scene.ordinal);
        if (step.derived) {
          assert.equal(step.source_ref.form, "scene_narration");
          assert.equal(step.source_ref.beat_id, null);
        } else {
          assert.equal(step.source_ref.form, "authored_beat");
          assert.equal(step.step_id, step.source_ref.beat_id);
        }
      }
    }
  });
});

describe("compile: derived capabilities and resources", () => {
  it("derives capabilities from structural actions only", () => {
    const terminal = compileFixture(sharedFixtures, "valid/p2a-terminal-foreground.yaml").compiled;
    assert.deepEqual(terminal.capabilities, { terminal: true, browser: false, editor: false, voice: true });

    const devServer = compileFixture(sharedFixtures, "valid/p2a-dev-server.yaml").compiled;
    assert.deepEqual(devServer.capabilities, { terminal: true, browser: true, editor: false, voice: true });

    const editor = compileFixture(sharedFixtures, "valid/p2a-editor-typing.yaml").compiled;
    assert.deepEqual(editor.capabilities, { terminal: false, browser: false, editor: true, voice: true });
  });

  it("never derives capabilities from narration wording", () => {
    // p2a-terminal-foreground narrates ABOUT terminal commands; the editor-typing
    // lesson's narration mentions typing — capabilities follow actions only.
    const { compiled } = compileFixture(sharedFixtures, "valid/p2a-terminal-foreground.yaml");
    assert.equal(compiled.capabilities.browser, false);
    assert.equal(compiled.capabilities.editor, false);
  });

  it("inventories explicit paths, assets, and browser origins deterministically", () => {
    const devServer = compileFixture(sharedFixtures, "valid/p2a-dev-server.yaml").compiled;
    assert.deepEqual(devServer.resources, {
      paths: ["demo-project"],
      assets: [],
      browser_origins: ["http://localhost:3000"],
    });

    const mixed = compileFixture(sharedFixtures, "valid/mixed-lesson.yaml").compiled;
    assert.deepEqual(mixed.resources.assets, ["assets/diagrams/algorithm-flow.svg"]);
    assert.deepEqual(mixed.resources.paths, []);
  });
});

describe("compile: language and direction derivation", () => {
  it("mixed lessons get per-leaf language and direction; lesson direction is null", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/mixed-lesson.yaml");
    assert.equal(compiled.lesson.direction, null);
    const intro = compiled.scenes[0];
    const narration = intro.steps[0];
    assert.ok(narration.kind === "narration");
    assert.equal(narration.narration.language, "ar");
    assert.equal(narration.narration.direction, "rtl");
    assert.equal(intro.on_screen_text[0].language, "ar");
    assert.equal(intro.on_screen_text[0].direction, "rtl");
    assert.equal(intro.on_screen_text[1].language, "en");
    assert.equal(intro.on_screen_text[1].direction, "ltr");
  });

  it("non-mixed lessons resolve undeclared leaf languages from the lesson language", () => {
    const { compiled } = compileFixture(sharedFixtures, "valid/en-lesson.yaml");
    const narration = compiled.scenes[0].steps[0];
    assert.ok(narration.kind === "narration");
    assert.equal(narration.narration.language, "en");
    assert.equal(narration.narration.direction, "ltr");
    // on-screen text omitted language in the source; it is resolved, not lost
    assert.equal(compiled.scenes[0].on_screen_text[0].language, "en");
    assert.equal(compiled.scenes[0].on_screen_text[0].direction, "ltr");
  });
});
