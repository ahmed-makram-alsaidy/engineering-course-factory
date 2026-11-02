// P3 source-hash tests — deterministic identity of semantic source content.
// Documented strategy (canonical-json-v1): SHA-256 over the compact canonical
// JSON encoding (recursively key-sorted) of the schema-VALIDATED lesson
// document (defaults applied). Never hashed: file name, machine path, mtime.
// Equivalent formatting (comments, key order, quoting) does not change the
// hash; any authored content change does.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonSource } from "@course-factory/shared-types";
import { compileLesson } from "../src/compile.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sharedValid = join(here, "..", "..", "..", "packages", "shared-types", "fixtures", "valid");

function compiledHashOf(source: string, name: string): string {
  const parsed = parseLessonSource(source, name);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.issues, null, 2));
  return compileLesson(parsed.lesson).source.hash.value;
}

const originalSource = readFileSync(join(sharedValid, "p2a-terminal-foreground.yaml"), "utf8");

describe("source hash", () => {
  it("is a 64-character lowercase hex sha256", () => {
    const hash = compiledHashOf(originalSource, "original");
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("is stable across repeated parses of the same source", () => {
    assert.equal(compiledHashOf(originalSource, "a"), compiledHashOf(originalSource, "b"));
  });

  it("ignores comments, key order, and quoting style (semantically identical source)", () => {
    const reformatted = `# a brand new comment that was not there before
duration: 240
schema_version: "1.1"
keywords: ["terminal", "node"]   # trailing comment
prerequisites: []
learning_objectives:
- 'Run a terminal command and read its output'
grade_level: "grade-10"
subject: Programming
language: en
title: 'Checking the Node version'
lesson_id: C01-L011
course_id: C01
metadata: { amendment: "P2A", synthetic_fixture: true }
scenes:
- scene_id: C01-L011-S001
  type: code_demo
  title: 'Running node --version'
  duration: 120
  visual: { kind: terminal, description: "Terminal with the version command and its output" }
  beats:
  - beat_id: C01-L011-S001-B001
    kind: narration
    narration: { text: "Before anything else, let me confirm which Node version this machine runs." }
  - beat_id: C01-L011-S001-B002
    kind: action
    action: { type: terminal_run, command: "node --version", mode: foreground, timeout_seconds: 30, expected_exit_code: 0 }
  - beat_id: C01-L011-S001-B003
    kind: narration
    narration: { text: "The output shows the version number; any code other than zero would mean a problem." }
- scene_id: C01-L011-S002
  type: explanation
  title: "Foreground vs background commands"
  duration: 120
  narration: { text: "A foreground command finishes before we continue; a long-running server needs background mode instead." }
  visual: { kind: diagram, description: "Two lanes: foreground command completes, background process keeps running" }
`;
    assert.equal(compiledHashOf(reformatted, "reformatted"), compiledHashOf(originalSource, "original"));
  });  it("changes when meaningful source content changes", () => {
    const changed = originalSource.replace(
      "Before anything else, let me confirm which Node version this machine runs.",
      "Before anything else, let me confirm which Node version this machine runs today.",
    );
    assert.notEqual(compiledHashOf(changed, "changed"), compiledHashOf(originalSource, "original"));

    const newKeyword = originalSource.replace('keywords:\n  - "terminal"\n  - "node"', 'keywords:\n  - "terminal"\n  - "nodejs"');
    assert.notEqual(compiledHashOf(newKeyword, "keyword"), compiledHashOf(originalSource, "original"));
  });

  it("is independent of the file name and location (hash is recorded in output, path is not)", () => {
    // same content parsed under two different names yields the same hash;
    // the compiled output contains neither name
    const hashA = compiledHashOf(originalSource, "courses/C01/lessons/L011/lesson.yaml");
    const hashB = compiledHashOf(originalSource, "some/other/place/v42/renamed.yaml");
    assert.equal(hashA, hashB);
    const parsed = parseLessonSource(originalSource, "original");
    assert.ok(parsed.ok);
    const serialized = JSON.stringify(compileLesson(parsed.lesson));
    assert.ok(!serialized.includes("lesson.yaml"));
    assert.ok(!serialized.includes("renamed.yaml"));
  });
});
