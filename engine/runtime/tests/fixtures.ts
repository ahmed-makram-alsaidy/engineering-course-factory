// Canonical P8 Reference Lesson and Failure Fixtures
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 31.1 & 31.2.
// Provides pure deterministic fixture builders for multi-engine preflight validation tests.

import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";

/**
 * Builds the canonical Phase P8 reference lesson exercising every engine domain
 * in realistic production sequence (P8-DESIGN-SPEC Section 31.1):
 * 1. narration: "Welcome to the Course Factory full-stack demo."
 * 2. file_create: "src/app.js"
 * 3. type_code: insert server code into "src/app.js"
 * 4. file_save: commit "src/app.js" to disk
 * 5. terminal_run (foreground): "node --check src/app.js"
 * 6. terminal_run (background): "node src/app.js" (process_id: "demo_server")
 * 7. wait (until: port 3000, timeout 10)
 * 8. browser_open: "http://localhost:3000"
 * 9. browser_fill: username-input
 * 10. browser_click: Submit button
 * 11. browser_assert: greeting text visible
 * 12. terminal_stop: "demo_server"
 * 13. pause: 2 seconds
 * 14. narration: "The full-stack demo completed successfully."
 */
export function createCanonicalReferenceLesson(): CompiledLesson {
  return {
    compiled_ir_version: "1.0",
    compiler: {
      name: "course-factory-lesson-compiler",
      version: "0.1.0",
    },
    source: {
      schema_version: "1.1",
      hash: {
        algorithm: "sha256",
        canonicalization: "canonical-json-v1",
        value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    },
    lesson: {
      course_id: "C01",
      lesson_id: "C01-L001",
      title: "P8 Reference Full-Stack Multi-Engine Demo",
      language: "en",
      direction: "ltr",
      subject: "Full-Stack Development",
      grade_level: "grade-12",
      duration_seconds: 300,
      learning_objectives: ["Build and test an end-to-end full-stack app across all engines"],
      prerequisites: [],
      keywords: ["editor", "terminal", "browser", "multi-engine"],
      metadata: { phase: "P8", synthetic: true },
    },
    capabilities: {
      terminal: true,
      browser: true,
      editor: true,
      voice: true,
    },
    resources: {
      paths: ["src/app.js"],
      assets: [],
      browser_origins: ["http://localhost:3000"],
    },
    processes: [
      {
        process_id: "demo_server",
        command: "node src/app.js",
        cwd: "src",
        started_in: {
          scene_id: "C01-L001-S001",
          beat_id: "C01-L001-S001-B006",
          scene_ordinal: 1,
          step_ordinal: 6,
        },
        stopped_in: {
          scene_id: "C01-L001-S001",
          beat_id: "C01-L001-S001-B012",
        },
        output_waits: [],
      },
    ],
    scenes: [
      {
        scene_id: "C01-L001-S001",
        ordinal: 1,
        type: "code_demo",
        title: "Full-Stack End-to-End Rehearsal",
        duration_seconds: 300,
        narration_form: "beats",
        visual: {
          kind: "code_editor",
          description: "Full-stack code demo with editor, terminal, and browser",
        },
        on_screen_text: [],
        blocks: [],
        assets: [],
        steps: [
          // Step 1: Narration intro
          {
            step_id: "C01-L001-S001-B001",
            ordinal: 1,
            derived: false,
            kind: "narration",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B001",
              form: "authored_beat",
            },
            narration: {
              text: "Welcome to the Course Factory full-stack demo.",
              language: "en",
              direction: "ltr",
            },
          },
          // Step 2: file_create src/app.js
          {
            step_id: "C01-L001-S001-B002",
            ordinal: 2,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B002",
              form: "authored_beat",
            },
            operation: {
              type: "file_create",
              family: "file",
              parameters: {
                type: "file_create",
                path: "src/app.js",
              },
            },
          },
          // Step 3: type_code into src/app.js
          {
            step_id: "C01-L001-S001-B003",
            ordinal: 3,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B003",
              form: "authored_beat",
            },
            operation: {
              type: "type_code",
              family: "editor",
              parameters: {
                type: "type_code",
                path: "src/app.js",
                content: `const http = require("http");
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(\`<!DOCTYPE html>
<html>
<body>
  <form id="user-form">
    <input data-testid="username-input" id="username" />
    <button role="button" name="Submit" type="button" onclick="document.getElementById('greeting').innerText='Welcome ' + document.getElementById('username').value">Submit</button>
  </form>
  <div data-testid="greeting" id="greeting"></div>
</body>
</html>\`);
});
server.listen(3000);`,
              },
            },
          },
          // Step 4: file_save src/app.js
          {
            step_id: "C01-L001-S001-B004",
            ordinal: 4,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B004",
              form: "authored_beat",
            },
            operation: {
              type: "file_save",
              family: "editor",
              parameters: {
                type: "file_save",
                path: "src/app.js",
              },
            },
          },
          // Step 5: terminal_run foreground syntax check
          {
            step_id: "C01-L001-S001-B005",
            ordinal: 5,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B005",
              form: "authored_beat",
            },
            operation: {
              type: "terminal_run",
              family: "terminal",
              parameters: {
                type: "terminal_run",
                command: "node --check src/app.js",
                mode: "foreground",
                expected_exit_code: 0,
                timeout_seconds: 15,
              },
            },
          },
          // Step 6: terminal_run background dev server
          {
            step_id: "C01-L001-S001-B006",
            ordinal: 6,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B006",
              form: "authored_beat",
            },
            operation: {
              type: "terminal_run",
              family: "terminal",
              parameters: {
                type: "terminal_run",
                command: "node src/app.js",
                mode: "background",
                process_id: "demo_server",
              },
            },
          },
          // Step 7: wait until port 3000
          {
            step_id: "C01-L001-S001-B007",
            ordinal: 7,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B007",
              form: "authored_beat",
            },
            operation: {
              type: "wait",
              family: "wait",
              parameters: {
                type: "wait",
                until: "port",
                port: 3000,
                timeout_seconds: 10,
              },
            },
          },
          // Step 8: browser_open http://localhost:3000
          {
            step_id: "C01-L001-S001-B008",
            ordinal: 8,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B008",
              form: "authored_beat",
            },
            operation: {
              type: "browser_open",
              family: "browser",
              parameters: {
                type: "browser_open",
                url: "http://localhost:3000",
              },
            },
          },
          // Step 9: browser_fill username-input
          {
            step_id: "C01-L001-S001-B009",
            ordinal: 9,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B009",
              form: "authored_beat",
            },
            operation: {
              type: "browser_fill",
              family: "browser",
              parameters: {
                type: "browser_fill",
                selector: { strategy: "test_id", value: "username-input" },
                value: "student",
              },
            },
          },
          // Step 10: browser_click Submit
          {
            step_id: "C01-L001-S001-B010",
            ordinal: 10,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B010",
              form: "authored_beat",
            },
            operation: {
              type: "browser_click",
              family: "browser",
              parameters: {
                type: "browser_click",
                selector: { strategy: "role", value: "button", name: "Submit" },
              },
            },
          },
          // Step 11: browser_assert greeting
          {
            step_id: "C01-L001-S001-B011",
            ordinal: 11,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B011",
              form: "authored_beat",
            },
            operation: {
              type: "browser_assert",
              family: "browser",
              parameters: {
                type: "browser_assert",
                selector: { strategy: "test_id", value: "greeting" },
                text_visible: "Welcome student",
              },
            },
          },
          // Step 12: terminal_stop demo_server
          {
            step_id: "C01-L001-S001-B012",
            ordinal: 12,
            derived: false,
            kind: "operation",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B012",
              form: "authored_beat",
            },
            operation: {
              type: "terminal_stop",
              family: "terminal",
              parameters: {
                type: "terminal_stop",
                process_id: "demo_server",
              },
            },
          },
          // Step 13: pause 2 seconds
          {
            step_id: "C01-L001-S001-B013",
            ordinal: 13,
            derived: false,
            kind: "pause",
            seconds: 2,
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B013",
              form: "authored_beat",
            },
          },
          // Step 14: narration conclusion
          {
            step_id: "C01-L001-S001-B014",
            ordinal: 14,
            derived: false,
            kind: "narration",
            source_ref: {
              scene_id: "C01-L001-S001",
              scene_ordinal: 1,
              beat_id: "C01-L001-S001-B014",
              form: "authored_beat",
            },
            narration: {
              text: "The full-stack demo completed successfully.",
              language: "en",
              direction: "ltr",
            },
          },
        ],
      },
    ],
  };
}

/**
 * Creates an invalid fixture where terminal_stop references an unstarted process_id.
 */
export function createOrphanProcessLesson(): CompiledLesson {
  const lesson = createCanonicalReferenceLesson();
  // Change terminal_stop to reference non-existent process
  const stopStep = lesson.scenes[0]!.steps.find((s) => s.step_id === "C01-L001-S001-B012");
  if (stopStep && stopStep.kind === "operation") {
    (stopStep.operation.parameters as any).process_id = "nonexistent_server";
  }
  return lesson;
}

/**
 * Creates an invalid fixture where browser_open navigates before wait until: port.
 */
export function createPrematureBrowserLesson(): CompiledLesson {
  const lesson = createCanonicalReferenceLesson();
  // Swap step 7 (wait port) and step 8 (browser_open)
  const steps = lesson.scenes[0]!.steps;
  const s7 = steps[6]!;
  const s8 = steps[7]!;

  // Swap their contents but keep ordinals and IDs
  steps[6] = { ...s8, step_id: s7.step_id, ordinal: 7, source_ref: { ...s8.source_ref, beat_id: s7.step_id } };
  steps[7] = { ...s7, step_id: s8.step_id, ordinal: 8, source_ref: { ...s7.source_ref, beat_id: s8.step_id } };

  return lesson;
}

/**
 * Creates an invalid fixture where type_code targets a file never created or opened.
 */
export function createUnopenedFileLesson(): CompiledLesson {
  const lesson = createCanonicalReferenceLesson();
  const typeStep = lesson.scenes[0]!.steps.find((s) => s.step_id === "C01-L001-S001-B003");
  if (typeStep && typeStep.kind === "operation") {
    (typeStep.operation.parameters as any).path = "src/other_file.js";
  }
  return lesson;
}

/**
 * Creates an invalid fixture where a file path contains traversal segments.
 */
export function createUnconfinedPathLesson(): CompiledLesson {
  const lesson = createCanonicalReferenceLesson();
  const createStep = lesson.scenes[0]!.steps.find((s) => s.step_id === "C01-L001-S001-B002");
  if (createStep && createStep.kind === "operation") {
    (createStep.operation.parameters as any).path = "../secrets.txt";
  }
  return lesson;
}

/**
 * Creates an invalid fixture where two steps share the same step_id.
 */
export function createDuplicateStepIdLesson(): CompiledLesson {
  const lesson = createCanonicalReferenceLesson();
  const steps = lesson.scenes[0]!.steps;
  // Make step 2 share step 1's ID
  steps[1] = {
    ...steps[1]!,
    step_id: steps[0]!.step_id,
    source_ref: {
      ...steps[1]!.source_ref,
      beat_id: steps[0]!.step_id,
    },
  };
  return lesson;
}
