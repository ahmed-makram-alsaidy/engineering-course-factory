// P2A execution contract tests — ordered beats, explicit actions, background
// processes, readiness waits, browser selectors, path safety, versioning.
// Deterministic and offline. Nothing is executed — this is schema validation only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateLessonData } from "../src/validate.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";

function baseLesson(): Record<string, unknown> {
  return {
    schema_version: SCHEMA_VERSION,
    course_id: "C01",
    lesson_id: "C01-L040",
    title: "Execution contract test lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["objective one"],
    prerequisites: [],
    keywords: ["test"],
    metadata: {},
    scenes: [
      {
        scene_id: "C01-L040-S001",
        type: "example",
        title: "Beats scene",
        duration: 120,
        visual: { kind: "code_editor", description: "Editor" },
        beats: [
          { beat_id: "C01-L040-S001-B001", kind: "narration", narration: { text: "Watch." } },
          { beat_id: "C01-L040-S001-B002", kind: "action", action: { type: "file_create", path: "app.js" } },
          { beat_id: "C01-L040-S001-B003", kind: "pause", seconds: 2 },
        ],
      },
      {
        scene_id: "C01-L040-S002",
        type: "summary",
        title: "Plain scene",
        duration: 60,
        narration: { text: "Done." },
        visual: { kind: "none", description: "No visual" },
      },
    ],
  };
}

function codes(result: { issues: { code: string; path: string; message: string }[] }): string[] {
  return result.issues.map((i) => i.code);
}

function paths(result: { issues: { code: string; path: string; message: string }[] }): string[] {
  return result.issues.map((i) => i.path);
}

function edit(base: Record<string, unknown>, mutate: (lesson: Record<string, unknown>) => void): unknown {
  const clone = structuredClone(base);
  mutate(clone);
  return clone;
}

function assertIssue(result: { issues: { code: string; path: string; message: string }[] }, token: string, pathFragment?: string): void {
  const issue = result.issues.find((i) => i.code === token && (pathFragment === undefined || i.path.includes(pathFragment)));
  assert.ok(issue, `expected issue ${token} (${pathFragment ?? "any path"}), got: ${JSON.stringify(result.issues, null, 2)}`);
}

describe("execution: schema version behavior", () => {
  it(`accepts schema_version ${SCHEMA_VERSION}`, () => {
    const result = validateLessonData(baseLesson());
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });

  it("rejects schema_version 1.0 documents (deliberate version bump, see ADR-0007)", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.schema_version = "1.0"; }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("schema_version"));
  });
});

describe("execution: ordered beats and narration contract", () => {
  it("accepts an ordered narration/action/pause sequence", () => {
    const result = validateLessonData(baseLesson());
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });

  it("rejects a scene with BOTH top-level narration and beats", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].narration = { text: "duplicate source" };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "NARRATION_BEATS_MUTUALLY_EXCLUSIVE", "scenes[0].narration");
  });

  it("requires narration when a scene has no beats", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      const scene = (l.scenes as Record<string, unknown>[])[1];
      delete scene.narration;
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "NARRATION_REQUIRED_WITHOUT_BEATS", "scenes[1].narration");
  });

  it("requires beats (with an action) on every code_demo scene", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      const scene = (l.scenes as Record<string, unknown>[])[0];
      scene.type = "code_demo";
      delete scene.beats; // beats emptied -> code_demo has no authored execution
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "CODE_DEMO_REQUIRES_BEATS", "scenes[0].beats");
  });

  it("rejects a code_demo whose beats contain no action beat", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].type = "code_demo";
      (l.scenes as Record<string, unknown>[])[0].beats = [
        { beat_id: "C01-L040-S001-B001", kind: "narration", narration: { text: "only talking" } },
      ];
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "CODE_DEMO_REQUIRES_BEATS", "scenes[0].beats");
  });

  it("requires narration language in beats of mixed lessons", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.language = "mixed"; }));
    assert.equal(result.ok, false);
    assertIssue(result, "NARRATION_LANGUAGE_REQUIRED_IN_MIXED", "scenes[0].beats[0].narration.language");
  });
});

describe("execution: beat identifier rules", () => {
  it("rejects beat ids that do not belong to their scene", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[0].beat_id = "C01-L040-S002-B001";
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "BEAT_ID_PARENT_MISMATCH", "scenes[0].beats[0].beat_id");
  });

  it("rejects malformed beat ids", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[0].beat_id = "beat-1";
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "BEAT_ID_MALFORMED", "scenes[0].beats[0].beat_id");
  });

  it("rejects duplicate beat ids within a scene", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].beat_id = "C01-L040-S001-B001";
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "DUPLICATE_BEAT_ID", "scenes[0].beats[1].beat_id");
  });
});

describe("execution: file/editor actions", () => {
  const badPaths: [string, string][] = [
    ["E:\\demo\\app.js", "windows absolute"],
    ["C:/temp/a.png", "drive letter"],
    ["/usr/local/x", "leading slash"],
    ["../outside.js", "parent traversal"],
    ["src\\x.js", "backslash"],
  ];
  for (const [bad, label] of badPaths) {
    it(`rejects ${label} file path in type_code`, () => {
      const result = validateLessonData(edit(baseLesson(), (l) => {
        (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "type_code", path: bad, content: "x" };
      }));
      assert.equal(result.ok, false);
      assertIssue(result, "INVALID_PROJECT_RELATIVE_PATH", "scenes[0].beats[1].action.path");
    });
  }

  it("requires content in type_code", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "type_code", path: "app.js" };
    }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("scenes[0].beats[1].action.content"));
  });

  it("rejects an inverted highlight range", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "highlight", path: "app.js", line: 5, line_end: 2 };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "HIGHLIGHT_RANGE_INVALID");
  });

  it("rejects line_end without line in highlight", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "highlight", path: "app.js", line_end: 4 };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "HIGHLIGHT_RANGE_INVALID");
  });
});

describe("execution: terminal and background process contract", () => {
  it("requires process_id for background terminal_run", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "terminal_run", command: "npm run dev", mode: "background" };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "BACKGROUND_PROCESS_ID_REQUIRED", "scenes[0].beats[1].action.process_id");
  });

  it("forbids process_id on foreground commands", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = {
        type: "terminal_run", command: "node --version", mode: "foreground", process_id: "oops",
      };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "PROCESS_ID_ONLY_FOR_BACKGROUND");
  });

  it("rejects invalid process id shapes everywhere", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = {
        type: "terminal_run", command: "npm run dev", mode: "background", process_id: "dev server",
      };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "INVALID_PROCESS_ID");
  });

  it("rejects duplicate background process ids across the lesson", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = {
        type: "terminal_run", command: "npm run dev", mode: "background", process_id: "dev_server",
      };
      (l.scenes as Record<string, unknown>[])[1].beats = [
        {
          beat_id: "C01-L040-S002-B001",
          kind: "action",
          action: { type: "terminal_run", command: "npm run dev", mode: "background", process_id: "dev_server" },
        },
      ];
      delete (l.scenes as Record<string, unknown>[])[1].narration;
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "DUPLICATE_PROCESS_ID", "scenes[1].beats[0].action.process_id");
  });

  it("accepts terminal_stop that references an earlier background process", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[1].beats = [
        { beat_id: "C01-L040-S002-B001", kind: "action", action: { type: "terminal_stop", process_id: "dev_server" } },
      ];
      delete (l.scenes as Record<string, unknown>[])[1].narration;
      // start the process in the FIRST scene so the reference resolves forward-of-definition
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = {
        type: "terminal_run", command: "npm run dev", mode: "background", process_id: "dev_server",
      };
    }));
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });

  it("rejects terminal_stop referencing a process defined later or never", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "terminal_stop", process_id: "ghost_server" };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "UNKNOWN_PROCESS_REFERENCE", "scenes[0].beats[1].action.process_id");
  });
});

describe("execution: readiness wait contract", () => {
  it("requires seconds for wait until=duration", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "wait", until: "duration" };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "WAIT_FIELDS_REQUIRED", "scenes[0].beats[1].action.seconds");
  });

  it("requires port and timeout for wait until=port", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "wait", until: "port", port: 3000 };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "WAIT_FIELDS_REQUIRED", "scenes[0].beats[1].action.timeout_seconds");
  });

  it("requires process_id, text and timeout for wait until=process_output", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "wait", until: "process_output" };
    }));
    assert.equal(result.ok, false);
    const waitIssues = result.issues.filter((i) => i.code === "WAIT_FIELDS_REQUIRED");
    assert.equal(waitIssues.length >= 3, true, JSON.stringify(result.issues, null, 2));
  });

  it("rejects a port outside 1-65535", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = {
        type: "wait", until: "port", port: 99999, timeout_seconds: 10,
      };
    }));
    assert.equal(result.ok, false);
  });
});

describe("execution: browser contract", () => {
  it("accepts a localhost dev URL", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "browser_open", url: "http://localhost:3000" };
    }));
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });

  it("rejects non-http(s) URLs", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "browser_open", url: "ftp://example.com/file" };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "INVALID_URL", "scenes[0].beats[1].action.url");
  });

  it("rejects URLs with embedded credentials", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "browser_open", url: "http://user:pass@localhost:3000" };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "URL_CREDENTIALS_FORBIDDEN", "scenes[0].beats[1].action.url");
  });

  it("rejects unknown selector strategies", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = {
        type: "browser_click", selector: { strategy: "pixels", value: "412,733" },
      };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "INVALID_BROWSER_SELECTOR", "scenes[0].beats[1].action.selector.strategy");
  });

  it("rejects 'name' on non-role selectors", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = {
        type: "browser_click", selector: { strategy: "text", value: "Submit", name: "Submit" },
      };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "INVALID_BROWSER_SELECTOR");
  });

  it("requires a condition for browser_wait", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "browser_wait", timeout_seconds: 5 };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "BROWSER_WAIT_FIELDS_REQUIRED");
  });

  it("requires at least one assertion field for browser_assert", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "browser_assert" };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "ASSERTION_FIELD_REQUIRED");
  });

  it("requires a selector for selector_text assertions", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "browser_assert", selector_text: "Welcome" };
    }));
    assert.equal(result.ok, false);
    assertIssue(result, "SELECTOR_TEXT_REQUIRES_SELECTOR");
  });
});

describe("execution: action discriminator union", () => {
  it("rejects unknown action types with the full canonical list", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].beats[1].action = { type: "render_hologram", target: "desk" };
    }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).some((p) => p.includes("scenes[0].beats[1].action.type")), JSON.stringify(result.issues));
    assert.ok(codes(result).some((c) => c === "invalid_union"), JSON.stringify(result.issues));
  });

  it("keeps every canonical action type constructible (union exhaustiveness)", () => {
    const actionTypes = [
      { type: "file_open", path: "app.js" },
      { type: "file_create", path: "app.js" },
      { type: "type_code", path: "app.js", content: "x" },
      { type: "replace_code", path: "app.js", find: "x", replace: "y" },
      { type: "file_save", path: "app.js" },
      { type: "terminal_run", command: "node --version", mode: "foreground" },
      { type: "terminal_stop", process_id: "x1" },
      { type: "wait", until: "duration", seconds: 5 },
      { type: "browser_open", url: "http://localhost:3000" },
      { type: "browser_click", selector: { strategy: "role", value: "button", name: "Save" } },
      { type: "browser_fill", selector: { strategy: "test_id", value: "q" }, value: "hi" },
      { type: "browser_press", key: "Enter" },
      { type: "browser_refresh" },
      { type: "browser_wait", text: "ready", timeout_seconds: 5 },
      { type: "browser_assert", url_contains: "localhost" },
      { type: "highlight", path: "app.js", line: 1 },
    ];
    const lesson = baseLesson() as Record<string, unknown>;
    const scenes = lesson.scenes as Record<string, unknown>[];
    scenes[0].beats = actionTypes.map((action, index) => ({
      beat_id: `C01-L040-S001-B${String(index + 1).padStart(3, "0")}`,
      kind: "action",
      action,
    }));
    scenes[0].duration = Math.max(60, actionTypes.length * 5);
    const result = validateLessonData(lesson);
    // terminal_stop references process 'x1' which is never started — that is the
    // ONLY expected issue; every other action must parse structurally.
    const unexpected = result.issues.filter(
      (i) => !(i.code === "UNKNOWN_PROCESS_REFERENCE" && i.message.includes("'x1'")),
    );
    assert.equal(unexpected.length, 0, JSON.stringify(unexpected, null, 2));
  });
});
