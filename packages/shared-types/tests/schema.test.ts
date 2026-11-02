// Schema unit tests — build minimal lessons in code and mutate them.
// Deterministic and offline by design.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateLessonData } from "../src/validate.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";

function baseLesson(): Record<string, unknown> {
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: "C01-L001",
    title: "Unit test lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 120,
    learning_objectives: ["objective one"],
    prerequisites: [],
    keywords: ["test"],
    metadata: { synthetic: true, tags: ["unit"] },
    scenes: [
      {
        scene_id: "C01-L001-S001",
        type: "intro",
        title: "Intro scene",
        duration: 120,
        narration: { text: "Hello world." },
        visual: { kind: "none", description: "No visual" },
        assets: [{ asset_id: "assets/graphics/test.svg", type: "image" }],
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

describe("schema: parsing and required fields", () => {
  it(`accepts a minimal valid lesson (schema ${SCHEMA_VERSION})`, () => {
    const result = validateLessonData(baseLesson());
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });

  it("applies documented defaults for optional arrays and metadata", () => {
    const lesson = baseLesson();
    delete lesson.metadata;
    const scene = (lesson.scenes as Record<string, unknown>[])[0];
    delete scene.assets;
    const result = validateLessonData(lesson);
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });

  it("rejects a wrong schema_version", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.schema_version = "0.9"; }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("schema_version"));
  });

  it("rejects a missing required top-level field", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { delete l.title; }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("title"));
  });

  it("rejects unknown top-level fields (strict schema catches typos)", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.titles = "typo"; }));
    assert.equal(result.ok, false);
  });

  it("rejects unknown scene fields (strict schema catches typos)", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].visul = "typo";
    }));
    assert.equal(result.ok, false);
  });

  it("rejects an empty scenes array", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.scenes = []; }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("scenes"));
  });
});

describe("schema: language model", () => {
  it("rejects a lesson language outside ar|en|mixed", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.language = "fr"; }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("language"));
  });

  it("requires narration.language in every scene of a mixed lesson", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.language = "mixed"; }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("NARRATION_LANGUAGE_REQUIRED_IN_MIXED"));
    assert.ok(paths(result).includes("scenes[0].narration.language"));
  });

  it("accepts a mixed lesson whose leaves all declare ar or en", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      l.language = "mixed";
      (l.scenes as Record<string, unknown>[])[0].narration = { text: "مرحباً", language: "ar" };
    }));
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });

  it("rejects 'mixed' as a leaf narration language", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].narration = { text: "x", language: "mixed" };
    }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("scenes[0].narration.language"));
  });
});

describe("schema: duration representation", () => {
  it("rejects a duration string like '2 minutes'", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.duration = "2 minutes"; }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("duration"));
  });

  it("rejects zero and negative durations", () => {
    for (const bad of [0, -30]) {
      const result = validateLessonData(edit(baseLesson(), (l) => { l.duration = bad; }));
      assert.equal(result.ok, false, `duration=${bad}`);
      assert.ok(paths(result).includes("duration"));
    }
  });

  it("rejects non-integer durations (90.5)", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.duration = 90.5; }));
    assert.equal(result.ok, false);
  });

  it("rejects a scene duration string", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].duration = "one minute";
    }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("scenes[0].duration"));
  });
});

describe("schema: identifier hierarchy", () => {
  it("rejects lesson_id that does not belong to course_id", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => { l.lesson_id = "C02-L001"; }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("LESSON_ID_COURSE_MISMATCH"));
    assert.ok(paths(result).includes("lesson_id"));
  });

  it("rejects scene_id that does not belong to lesson_id", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].scene_id = "C02-L001-S004";
    }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("SCENE_ID_PARENT_MISMATCH"));
    assert.ok(paths(result).includes("scenes[0].scene_id"));
  });

  it("rejects malformed scene ids", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].scene_id = "scene-1";
    }));
    assert.equal(result.ok, false);
    assert.ok(paths(result).includes("scenes[0].scene_id"));
  });

  it("rejects duplicate scene ids", () => {
    const scene = () => ({
      scene_id: "C01-L001-S001",
      type: "intro",
      title: "Scene",
      duration: 10,
      narration: { text: "x" },
      visual: { kind: "none", description: "No visual" },
    });
    const result = validateLessonData(edit(baseLesson(), (l) => { l.scenes = [scene(), scene()]; }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("DUPLICATE_SCENE_ID"));
    assert.ok(paths(result).includes("scenes[1].scene_id"));
  });
});

describe("schema: asset reference safety", () => {
  const badRefs: [string, string][] = [
    ["E:\\course-factory\\assets\\a.svg", "windows absolute path"],
    ["C:/temp/a.png", "drive-letter path"],
    ["/etc/assets/a.png", "leading slash"],
    ["../secrets/a.yaml", "parent traversal"],
    ["assets/graphics/my pic.svg", "space character"],
    ["assets\\x.svg", "backslash"],
  ];

  for (const [ref, label] of badRefs) {
    it(`rejects ${label}: ${ref}`, () => {
      const result = validateLessonData(edit(baseLesson(), (l) => {
        (l.scenes as Record<string, unknown>[])[0].assets = [{ asset_id: ref }];
      }));
      assert.equal(result.ok, false, `expected rejection for ${ref}`);
      assert.ok(codes(result).includes("ASSET_REF_NOT_PROJECT_RELATIVE"), JSON.stringify(result.issues));
      assert.ok(paths(result).includes("scenes[0].assets[0].asset_id"));
    });
  }

  it("accepts project-relative POSIX-style asset references", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].assets = [
        { asset_id: "assets/graphics/loop-diagram.svg", type: "image" },
        { asset_id: "assets/audio/click-01.wav", type: "audio" },
      ];
    }));
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });
});

describe("schema: interaction model", () => {
  const questionScene = (interaction: unknown) => ({
    scene_id: "C01-L001-S002",
    type: "question",
    title: "Quick check",
    duration: 30,
    narration: { text: "Answer this." },
    visual: { kind: "fullscreen_text", description: "Question on screen" },
    interaction,
  });

  it("requires an interaction object on question-type scenes", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[]).push(questionScene(undefined));
    }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("QUESTION_SCENE_REQUIRES_INTERACTION"));
  });

  it("requires choices for multiple_choice interactions", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[]).push(
        questionScene({ kind: "multiple_choice", prompt: "Pick", correct_answer: "A" }),
      );
    }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("CHOICES_REQUIRED_FOR_MULTIPLE_CHOICE"));
  });

  it("requires correct_answer to be one of the choices", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[]).push(
        questionScene({ kind: "multiple_choice", prompt: "Pick", choices: ["A", "B"], correct_answer: "C" }),
      );
    }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("CORRECT_ANSWER_NOT_IN_CHOICES"));
  });

  it("requires a boolean answer for true_false", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[]).push(
        questionScene({ kind: "true_false", prompt: "True?", correct_answer: "true" }),
      );
    }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("TRUE_FALSE_REQUIRES_BOOLEAN_ANSWER"));
  });

  it("requires a string answer for short_answer", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[]).push(
        questionScene({ kind: "short_answer", prompt: "Why?", correct_answer: true }),
      );
    }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("SHORT_ANSWER_REQUIRES_STRING_ANSWER"));
  });

  it("accepts a well-formed multiple_choice interaction", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[]).push(
        questionScene({ kind: "multiple_choice", prompt: "Pick", choices: ["A", "B"], correct_answer: "A" }),
      );
    }));
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });
});

describe("schema: transitions and content blocks", () => {
  it("rejects a transition duration without a transition kind", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].transitions = { in_duration_seconds: 2 };
    }));
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("TRANSITION_DURATION_WITHOUT_TYPE"));
  });

  it("rejects unknown content block kinds", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].blocks = [{ kind: "hologram", source: "x" }];
    }));
    assert.equal(result.ok, false);
  });

  it("accepts code and math content blocks", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      (l.scenes as Record<string, unknown>[])[0].blocks = [
        { kind: "code", language: "python", source: "print(1)" },
        { kind: "math", notation: "latex", source: "E = mc^2" },
      ];
    }));
    assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  });

  it("rejects metadata values that are nested objects", () => {
    const result = validateLessonData(edit(baseLesson(), (l) => {
      l.metadata = { nested: { deep: true } };
    }));
    assert.equal(result.ok, false);
  });
});
