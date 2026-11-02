// P3 error tests — the compiler refuses invalid input with actionable
// diagnostics, distinguishes failure classes by exit code, and never writes
// output on failure. CLI behavior is exercised by spawning the real CLI.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonSource } from "@course-factory/shared-types";
import { compileLesson } from "../src/compile.ts";
import { validateCompiledLesson } from "../src/ir.ts";
import type { CompiledLesson } from "../src/ir.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli.ts");
const sharedFixtures = join(here, "..", "..", "..", "packages", "shared-types", "fixtures");
const workspaceTemp = mkdtempSync(join(tmpdir(), "p3-errors-"));

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliRun {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("errors: usage (exit 2)", () => {
  it("no arguments prints usage and exits 2", () => {
    const run = runCli([]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /usage:/);
  });

  it("an unknown option exits 2", () => {
    const run = runCli(["some.yaml", "--execute"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown option/);
  });

  it("--out without a value exits 2", () => {
    const run = runCli(["some.yaml", "--out"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--out requires a path/);
  });

  it("more than one lesson file exits 2", () => {
    const run = runCli(["a.yaml", "b.yaml"]);
    assert.equal(run.status, 2);
  });
});

describe("errors: source validation failures (exit 1, canonical diagnostics, no output)", () => {
  const cases: [string, string, RegExp][] = [
    ["missing required field", "invalid/missing-required-field.yaml", /invalid_type/],
    ["unsupported schema version", "invalid/missing-required-field.yaml", /INVALID/],
    ["duplicate scene id (hierarchy violation)", "invalid/duplicate-scene-id.yaml", /DUPLICATE_SCENE_ID/],
    ["invalid action type", "invalid/p2a-unknown-action-type.yaml", /invalid_union/],
    ["absolute machine path in an action", "invalid/p2a-absolute-file-path.yaml", /INVALID_PROJECT_RELATIVE_PATH/],
    ["code_demo without beats", "invalid/p2a-code-demo-without-beats.yaml", /CODE_DEMO_REQUIRES_BEATS/],
  ];

  for (const [label, fixture, diagnostic] of cases) {
    it(`${label}: exit 1 with actionable diagnostics`, () => {
      const out = join(workspaceTemp, "should-never-be-written.json");
      const run = runCli([join(sharedFixtures, fixture), "--out", out]);
      assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stderr}`);
      assert.match(run.stderr, /INVALID/);
      assert.match(run.stderr, diagnostic);
      assert.equal(existsSync(out), false, "no compiled output may be produced from invalid source");
    });
  }

  it("a schema_version 1.0 document is rejected, not upgraded", () => {
    const source = readFileSync(join(sharedFixtures, "valid", "p2a-terminal-foreground.yaml"), "utf8");
    const downgraded = source.replace('schema_version: "1.1"', 'schema_version: "1.0"');
    const result = parseLessonSource(downgraded, "downgraded");
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.path.includes("schema_version")));
  });

  it("a nonexistent file exits 1 with FILE_READ_ERROR", () => {
    const run = runCli([join(workspaceTemp, "does-not-exist.yaml")]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /FILE_READ_ERROR/);
  });
});

describe("errors: output write failure (exit 4)", () => {
  it("an existing directory as --out exits 4 without crashing", () => {
    const dir = join(workspaceTemp, "out-is-a-directory");
    mkdirSync(dir, { recursive: true });
    const run = runCli([join(sharedFixtures, "valid", "p2a-terminal-foreground.yaml"), "--out", dir]);
    assert.equal(run.status, 4, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /output write failure/);
  });
});

describe("errors: the compiler validates its own output (internal-failure guard)", () => {
  const parsed = parseLessonSource(readFileSync(join(sharedFixtures, "valid", "p2a-terminal-foreground.yaml"), "utf8"), "ok");
  assert.ok(parsed.ok);
  const good = compileLesson(parsed.lesson);
  it("a healthy compiled IR validates", () => {
    assert.equal(validateCompiledLesson(good).ok, true);
  });

  it("a wrong IR version is rejected", () => {
    const bad = structuredClone(good);
    (bad as { compiled_ir_version: string }).compiled_ir_version = "9.9";
    const result = validateCompiledLesson(bad);
    assert.equal(result.ok, false);
  });

  it("an unknown top-level field is rejected (strict IR)", () => {
    const bad: Record<string, unknown> = structuredClone(good);
    bad.executed_actions = [];
    const result = validateCompiledLesson(bad);
    assert.equal(result.ok, false);
  });

  it("an operation whose type disagrees with its parameters is rejected", () => {
    const bad: CompiledLesson = structuredClone(good);
    const step = bad.scenes[0].steps[1];
    assert.ok(step.kind === "operation");
    step.operation.type = "file_open";
    const result = validateCompiledLesson(bad);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "IR_OPERATION_TYPE_MISMATCH"));
  });

  it("a derived step carrying a fake authored-beat id is rejected", () => {
    const bad: CompiledLesson = structuredClone(good);
    const step = bad.scenes[1].steps[0];
    assert.ok(step.kind === "narration");
    assert.equal(step.derived, true);
    step.step_id = "C01-L011-S002-B001"; // impersonating an authored beat id
    const result = validateCompiledLesson(bad);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "IR_DERIVED_STEP_ID_MALFORMED"));
  });

  it("a scene_narration step flagged as non-derived is rejected", () => {
    const bad: CompiledLesson = structuredClone(good);
    const step = bad.scenes[1].steps[0];
    assert.ok(step.kind === "narration");
    (step as { derived: boolean }).derived = false;
    const result = validateCompiledLesson(bad);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.code === "IR_STEP_DERIVATION_MISMATCH"));
  });

  it("a machine path smuggled into the IR shape is rejected (wrong hash encoding)", () => {
    const bad: CompiledLesson = structuredClone(good);
    bad.source.hash.value = "E:\\course-factory";
    const result = validateCompiledLesson(bad);
    assert.equal(result.ok, false);
  });
});

// keep the workspace temp dir for debugging on failure; remove on success is
// unnecessary (OS temp) — but avoid unbounded growth in repeated local runs:
process.on("exit", () => {
  try {
    rmSync(workspaceTemp, { recursive: true, force: true });
  } catch {
    // best effort cleanup of a throwaway OS-temp directory
  }
});
