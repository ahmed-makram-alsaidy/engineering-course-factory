// P3 safety tests — the strict non-execution boundary.
//
// 1. Sentinel proof: the authored terminal command in the side-effect fixture
//    WOULD create a file if it were ever run. Compilation (direct and via CLI)
//    must leave no sentinel file anywhere.
// 2. Static boundary: compiler source imports only declared modules and never
//    reaches for processes, network, browsers, or evaluation.
// 3. Portability: no compiled output contains machine paths.
// 4. Purity: compilation never mutates (or depends on mutation of) the input.
// 5. Identity sync: COMPILER_VERSION matches package.json.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonSource, type Lesson } from "@course-factory/shared-types";
import { compileLesson } from "../src/compile.ts";
import { serializeCompiledLesson } from "../src/canonical.ts";
import { COMPILER_VERSION } from "../src/version.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const srcDir = join(packageRoot, "src");
const cliPath = join(join(packageRoot, "src"), "cli.ts");
const sharedFixtures = join(here, "..", "..", "..", "packages", "shared-types", "fixtures");
const localFixtures = join(here, "fixtures");
const SENTINEL = "p3-sentinel-ran.tmp";

function compileFixture(dir: string, file: string): string {
  const parsed = parseLessonSource(readFileSync(join(dir, file), "utf8"), file);
  assert.equal(parsed.ok, true, `${file}: ${JSON.stringify(parsed.issues, null, 2)}`);
  return serializeCompiledLesson(compileLesson(parsed.lesson as Lesson));
}

function sentinelExists(): boolean {
  return [process.cwd(), packageRoot, tmpdir()].some((dir) => existsSync(join(dir, SENTINEL)));
}

describe("safety: authored execution stays data (sentinel proof)", () => {
  it("compiling the side-effect fixture in-process creates no sentinel file", () => {
    assert.equal(sentinelExists(), false, "precondition: sentinel must not pre-exist");
    const serialized = compileFixture(localFixtures, "p3-side-effect-safety.yaml");
    // the command and URL survive as text — proof they are data
    assert.match(serialized, /writeFileSync\('p3-sentinel-ran\.tmp', 'executed'\)/);
    assert.match(serialized, /http:\/\/localhost:59999\/p3-should-never-be-fetched/);
    assert.equal(sentinelExists(), false, "compilation executed the authored command!");
  });

  it("compiling via the CLI creates no sentinel file and opens no browser", () => {
    const out = join(mkdtempSync(join(tmpdir(), "p3-safety-")), "compiled.json");
    const run = spawnSync(process.execPath, [cliPath, join(localFixtures, "p3-side-effect-safety.yaml"), "--out", out], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(out), true);
    assert.equal(sentinelExists(), false, "the CLI executed an authored command!");
    rmSync(dirname(out), { recursive: true, force: true });
  });
});

describe("safety: static import/call boundary of compiler source", () => {
  const ALLOWED_NODE_MODULES = ["node:fs", "node:path", "node:url", "node:crypto"];
  const ALLOWED_PACKAGES = ["zod", "@course-factory/shared-types"];
  const FORBIDDEN_CALLS =
    /child_process|node:http|node:https|node:net|node:dns|node:tls|playwright|puppeteer|electron|node-pty|\bfetch\s*\(|\bspawn\s*\(|\bexec\s*\(|\bexecSync\s*\(|\bspawnSync\s*\(|\beval\s*\(|new\s+Function\s*\(|XMLHttpRequest|WebSocket/;

  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  const sourceFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

  it("every compiler source file imports only declared, non-executing modules", () => {
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(join(srcDir, file), "utf8"));
      const imports = [...code.matchAll(/(?:^|\n)\s*import[^"']*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const specifier of imports) {
        if (specifier.startsWith("node:")) {
          assert.ok(
            ALLOWED_NODE_MODULES.includes(specifier),
            `${file} imports forbidden module ${specifier} (allowed: ${ALLOWED_NODE_MODULES.join(", ")})`,
          );
        } else if (specifier.startsWith(".")) {
          // relative module — fine by construction
        } else {
          assert.ok(
            ALLOWED_PACKAGES.includes(specifier),
            `${file} imports unexpected package ${specifier} (allowed: ${ALLOWED_PACKAGES.join(", ")})`,
          );
        }
      }
    }
  });

  it("no compiler source file reaches for execution, network, browsers, or evaluation", () => {
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(join(srcDir, file), "utf8"));
      assert.doesNotMatch(code, FORBIDDEN_CALLS, `${file} contains a forbidden execution/network/browser construct`);
    }
  });
});

describe("safety: no machine paths leak into compiled output", () => {
  const LEAK_PATTERNS: [RegExp, string][] = [
    // \b keeps URL schemes like "http://" from matching (the letter before the
    // colon in a scheme is always preceded by another word character)
    [/\b[A-Za-z]:[\\/]/, "drive-letter path"],
    [/\/home\//, "unix home path"],
    [/\/Users\//, "macOS users path"],
    [/Users\\/, "windows users path"],
    [/AppData/i, "AppData path"],
    [/node_modules/, "node_modules path"],
    [/file:\/\//, "file URL"],
    [/\/e\/course-factory/, "git-bash repository path"],
    [/\\e\\course-factory/, "windows repository path"],
  ];

  const fixtures: [string, string][] = [
    ...readdirSync(join(sharedFixtures, "valid"))
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => [join(sharedFixtures, "valid"), f] as [string, string]),
    ...readdirSync(localFixtures)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".json"))
      .map((f) => [localFixtures, f] as [string, string]),
  ];

  for (const [dir, file] of fixtures) {
    it(`${file}: compiled output is portable`, () => {
      const serialized = compileFixture(dir, file);
      for (const [pattern, label] of LEAK_PATTERNS) {
        assert.doesNotMatch(serialized, pattern, `${file} leaked a ${label}`);
      }
    });
  }

  it("the committed golden file is portable too", () => {
    const golden = readFileSync(join(here, "golden", "C01-L011-compiled-lesson.json"), "utf8");
    for (const [pattern, label] of LEAK_PATTERNS) {
      assert.doesNotMatch(golden, pattern, `golden file leaked a ${label}`);
    }
  });
});

describe("safety: compilation is a pure transformation (no source mutation)", () => {
  it("deep-frozen input compiles to the same result; the input object is untouched", () => {
    const parsed = parseLessonSource(readFileSync(join(sharedFixtures, "valid", "en-lesson.yaml"), "utf8"), "en");
    assert.ok(parsed.ok);
    const before = structuredClone(parsed.lesson);

    function deepFreeze<T>(value: T): T {
      if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
        Object.freeze(value);
      }
      return value;
    }
    const frozen = deepFreeze(structuredClone(parsed.lesson));

    const fromFrozen = compileLesson(frozen as Lesson);
    const fromOriginal = compileLesson(parsed.lesson as Lesson);
    assert.deepEqual(fromFrozen, fromOriginal, "compilation must not depend on mutating the input");
    assert.deepEqual(parsed.lesson, before, "the parsed source object must be unchanged after compilation");
  });

  it("the returned compiled object shares no structure with the input", () => {
    const parsed = parseLessonSource(readFileSync(join(sharedFixtures, "valid", "ar-lesson.yaml"), "utf8"), "ar");
    assert.ok(parsed.ok);
    const compiled = compileLesson(parsed.lesson as Lesson);
    compiled.scenes[0].title = "MUTATED";
    compiled.lesson.title = "MUTATED";
    const again = compileLesson(parsed.lesson as Lesson);
    assert.notEqual(again.scenes[0].title, "MUTATED");
    assert.notEqual(again.lesson.title, "MUTATED");
  });
});

describe("safety: compiler identity sync", () => {
  it("COMPILER_VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(pkg.version, COMPILER_VERSION);
    assert.equal(pkg.name, "@course-factory/lesson-compiler");
  });
});
