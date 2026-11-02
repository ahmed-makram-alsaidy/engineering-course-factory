// Lesson Compiler CLI.
//
//   node engine/compiler/src/cli.ts <lesson.yaml|.yml|.json> [--out <path>]
//   npm run compile:lesson -- <lesson> [--out <path>]
//
// Exit codes:
//   0 = compiled successfully
//   1 = invalid or unreadable lesson source (canonical validation failed)
//   2 = usage error
//   3 = compiler internal failure (compilation threw, or the output failed its
//       own IR contract validation — a compiler bug, never a source problem)
//   4 = output write failure
//
// The CLI compiles. It never acts on lesson content: authored commands are not
// run, browsers are not opened, ports are not probed, and files described by
// lesson actions are not created. Lesson execution instructions are data.
//
// Output: UTF-8 JSON, canonical key order, 2-space indent, trailing newline.
// Default output location: <repoRoot>/runtime/compiled/<lesson_id>/compiled-lesson.json
// (--out overrides it and takes an explicit destination).

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseLessonFile } from "@course-factory/shared-types";
import { compileLesson } from "./compile.ts";
import { serializeCompiledLesson } from "./canonical.ts";
import { validateCompiledLesson } from "./ir.ts";
import { COMPILED_IR_VERSION, COMPILER_VERSION } from "./version.ts";
import { defaultOutputPath, findRepositoryRoot } from "./paths.ts";

const USAGE = "usage: node engine/compiler/src/cli.ts <path/to/lesson.yaml|.yml|.json> [--out <path>]";

function fail(exitCode: number, ...messages: string[]): never {
  for (const message of messages) console.error(message);
  process.exit(exitCode);
}

function printIssues(prefix: string, issues: { path: string; code: string; message: string }[]): void {
  console.error(prefix);
  for (const issue of issues) {
    console.error(`  - path:   ${issue.path}`);
    console.error(`    code:   ${issue.code}`);
    console.error(`    reason: ${issue.message}`);
  }
}

function parseArgs(argv: string[]): { input: string; out?: string } {
  const positional: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      if (i + 1 >= argv.length) fail(2, USAGE, "error: --out requires a path argument");
      out = argv[++i];
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg.startsWith("--")) {
      fail(2, USAGE, `error: unknown option '${arg}'`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) fail(2, USAGE, `error: expected exactly one lesson file, got ${positional.length}`);
  return { input: positional[0], out };
}

function main(): void {
  const { input, out } = parseArgs(process.argv.slice(2));

  // 1) Canonical source validation — the single lesson-validation authority.
  const parsed = parseLessonFile(input);
  if (!parsed.ok) {
    printIssues(`${input}: INVALID`, parsed.issues);
    process.exit(1);
  }

  // 2) Pure compilation.
  let compiled: ReturnType<typeof compileLesson>;
  try {
    compiled = compileLesson(parsed.lesson);
  } catch (error) {
    fail(3, `compiler internal failure while compiling '${input}': ${error instanceof Error ? error.message : String(error)}`);
  }

  // 3) Output self-validation — refuse to ever write an IR that breaks its own contract.
  const irCheck = validateCompiledLesson(compiled);
  if (!irCheck.ok) {
    printIssues("COMPILER BUG: the compiled output failed its own IR contract validation — refusing to write.", irCheck.issues);
    process.exit(3);
  }

  // 4) Write (default: generated-artifacts area; --out: explicit destination).
  const outPath = out !== undefined ? resolve(out) : defaultOutputPath(findRepositoryRoot(), compiled.lesson.lesson_id);
  try {
    if (existsSync(outPath) && statSync(outPath).isDirectory()) {
      throw new Error("output path is an existing directory");
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serializeCompiledLesson(compiled), "utf8");
  } catch (error) {
    fail(4, `output write failure for '${outPath}': ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`${compiled.lesson.lesson_id}: compiled -> ${outPath}`);
  console.log(`  ir ${COMPILED_IR_VERSION} / compiler ${COMPILER_VERSION} / source sha256 ${compiled.source.hash.value}`);
}

main();
