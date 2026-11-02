// Fixture-driven tests: every committed fixture must behave as its name and
// registration below declare. Adding a fixture without registering an
// expectation for it fails the suite — no silent fixtures.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLessonSource } from "../src/validate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const validDir = join(here, "..", "fixtures", "valid");
const invalidDir = join(here, "..", "fixtures", "invalid");

// Expected failure reason for every invalid fixture (file -> predicate).
// The validator emits machine tokens on `code` (stripped from the message),
// so reasons are asserted via `code`, message fragment, or both.
const invalidExpectations: Record<string, { pathIncludes: string; messageIncludes?: string; code?: string }> = {
  "bad-lesson-id.yaml": { pathIncludes: "lesson_id", code: "LESSON_ID_COURSE_MISMATCH" },
  "bad-scene-id.yaml": { pathIncludes: "scenes[0].scene_id", code: "SCENE_ID_PARENT_MISMATCH" },
  "absolute-asset-path.yaml": { pathIncludes: "scenes[0].assets[0].asset_id", code: "ASSET_REF_NOT_PROJECT_RELATIVE" },
  "unsupported-language.yaml": { pathIncludes: "language", messageIncludes: "mixed" },
  "missing-required-field.yaml": { pathIncludes: "title", code: "invalid_type" },
  "duplicate-scene-id.yaml": { pathIncludes: "scenes[1].scene_id", code: "DUPLICATE_SCENE_ID" },
  "invalid-duration.yaml": { pathIncludes: "duration", code: "invalid_type" },
  // P2A execution contract fixtures
  "p2a-duplicate-beat-id.yaml": { pathIncludes: "scenes[0].beats[1].beat_id", code: "DUPLICATE_BEAT_ID" },
  "p2a-beat-parent-mismatch.yaml": { pathIncludes: "scenes[0].beats[0].beat_id", code: "BEAT_ID_PARENT_MISMATCH" },
  "p2a-absolute-file-path.yaml": { pathIncludes: "scenes[0].beats[1].action.path", code: "INVALID_PROJECT_RELATIVE_PATH" },
  "p2a-parent-traversal-path.yaml": { pathIncludes: "scenes[0].beats[1].action.path", code: "INVALID_PROJECT_RELATIVE_PATH" },
  "p2a-background-without-process-id.yaml": { pathIncludes: "scenes[0].beats[1].action.process_id", code: "BACKGROUND_PROCESS_ID_REQUIRED" },
  "p2a-terminal-stop-invalid-id.yaml": { pathIncludes: "scenes[0].beats[1].action.process_id", code: "INVALID_PROCESS_ID" },
  "p2a-unknown-action-type.yaml": { pathIncludes: "scenes[0].beats[1].action.type", code: "invalid_union" },
  "p2a-malformed-browser-selector.yaml": { pathIncludes: "scenes[0].beats[1].action.selector.strategy", code: "INVALID_BROWSER_SELECTOR" },
  "p2a-missing-action-field.yaml": { pathIncludes: "scenes[0].beats[1].action.command", code: "invalid_type" },
  "p2a-stop-unknown-process.yaml": { pathIncludes: "scenes[0].beats[1].action.process_id", code: "UNKNOWN_PROCESS_REFERENCE" },
  "p2a-code-demo-without-beats.yaml": { pathIncludes: "scenes[0].beats", code: "CODE_DEMO_REQUIRES_BEATS" },
  "p2a-narration-and-beats.yaml": { pathIncludes: "scenes[0].narration", code: "NARRATION_BEATS_MUTUALLY_EXCLUSIVE" },
};

const validFiles = readdirSync(validDir).filter((f) => f.endsWith(".yaml"));
const invalidFiles = readdirSync(invalidDir).filter((f) => f.endsWith(".yaml"));

describe("fixtures: valid lessons pass validation", () => {
  for (const file of validFiles) {
    it(`valid fixture: ${file}`, () => {
      const source = readFileSync(join(validDir, file), "utf8");
      const result = validateLessonSource(source, file);
      assert.equal(result.ok, true, `${file} should be VALID:\n${JSON.stringify(result.issues, null, 2)}`);
    });
  }

  it("registers at least the three required language variants", () => {
    for (const required of ["ar-lesson.yaml", "en-lesson.yaml", "mixed-lesson.yaml"]) {
      assert.ok(validFiles.includes(required), `missing required valid fixture: ${required}`);
    }
  });
});

describe("fixtures: invalid lessons fail for the correct reason", () => {
  it("every invalid fixture has a registered expectation", () => {
    const unregistered = invalidFiles.filter((f) => !(f in invalidExpectations));
    assert.deepEqual(unregistered, [], "invalid fixtures without expectations");
  });

  for (const file of invalidFiles) {
    it(`invalid fixture: ${file}`, () => {
      const expectation = invalidExpectations[file];
      assert.ok(expectation, `no expectation registered for ${file}`);
      const source = readFileSync(join(invalidDir, file), "utf8");
      const result = validateLessonSource(source, file);
      assert.equal(result.ok, false, `${file} should be INVALID but passed validation`);
      assert.ok(result.issues.length > 0, `${file} failed without any issue`);
      const matching = result.issues.find(
        (issue) =>
          issue.path.includes(expectation.pathIncludes) &&
          (expectation.messageIncludes === undefined || issue.message.includes(expectation.messageIncludes)) &&
          (expectation.code === undefined || issue.code === expectation.code),
      );
      assert.ok(
        matching,
        `${file} did not fail for the expected reason (${expectation.pathIncludes}). Got: ${JSON.stringify(result.issues, null, 2)}`,
      );
    });
  }
});

describe("fixtures: no machine-specific state", () => {
  // These invalid fixtures deliberately contain a machine path to test the
  // validator; they are the ONLY ones allowed to.
  const intentionalPathFixtures = new Set(["absolute-asset-path.yaml", "p2a-absolute-file-path.yaml"]);

  it("valid fixtures contain no absolute Windows paths", () => {
    for (const file of validFiles) {
      const source = readFileSync(join(validDir, file), "utf8");
      assert.equal(/[A-Za-z]:\\/.test(source), false, `${file} contains an absolute Windows path`);
    }
  });

  it("only the intentional invalid fixtures contain an absolute Windows path", () => {
    for (const file of invalidFiles) {
      const source = readFileSync(join(invalidDir, file), "utf8");
      const hasAbsolutePath = /[A-Za-z]:\\/.test(source);
      if (intentionalPathFixtures.has(file)) {
        assert.equal(hasAbsolutePath, true, `${file} must keep its deliberate absolute path`);
      } else {
        assert.equal(hasAbsolutePath, false, `${file} contains an absolute Windows path`);
      }
    }
  });

  it("fixtures contain no usernames, secrets, or API-key material", () => {
    const forbidden = ["Ahmed", "api_key", "apikey", "password", "token", "secret"];
    for (const dir of [validDir, invalidDir]) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
        const source = readFileSync(join(dir, file), "utf8");
        for (const word of forbidden) {
          assert.equal(
            source.toLowerCase().includes(word.toLowerCase()),
            false,
            `${file} contains forbidden machine-specific material: '${word}'`,
          );
        }
      }
    }
  });
});
