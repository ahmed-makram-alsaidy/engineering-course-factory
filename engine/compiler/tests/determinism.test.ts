// P3 determinism tests — the HARD requirement. Same compiler version +
// semantically identical source => byte-identical output. Verified by
// re-compiling and comparing bytes and SHA-256.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonSource } from "@course-factory/shared-types";
import { compileLesson } from "../src/compile.ts";
import { serializeCompiledLesson, sha256Hex } from "../src/canonical.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sharedValid = join(here, "..", "..", "..", "packages", "shared-types", "fixtures", "valid");
const localFixtures = join(here, "fixtures");

function compileFile(dir: string, file: string): string {
  const parsed = parseLessonSource(readFileSync(join(dir, file), "utf8"), file);
  assert.equal(parsed.ok, true, `${file} must be valid: ${JSON.stringify(parsed.issues, null, 2)}`);
  return serializeCompiledLesson(compileLesson(parsed.lesson));
}

const validFixtures = readdirSync(sharedValid).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));

describe("determinism: compile twice, compare bytes", () => {
  for (const file of validFixtures) {
    it(`${file}: two compilations are byte-identical`, () => {
      const first = compileFile(sharedValid, file);
      const second = compileFile(sharedValid, file);
      assert.equal(first, second);
      assert.equal(sha256Hex(first), sha256Hex(second));
    });
  }

  it("p3-side-effect-safety.yaml: two compilations are byte-identical", () => {
    const first = compileFile(localFixtures, "p3-side-effect-safety.yaml");
    const second = compileFile(localFixtures, "p3-side-effect-safety.yaml");
    assert.equal(first, second);
  });
});

describe("determinism: semantic equivalence across encodings and key order", () => {
  const encodings = [
    ["yaml (canonical P2A fixture)", join(sharedValid, "p2a-terminal-foreground.yaml")],
    ["yml extension", join(localFixtures, "p3-terminal-foreground.yml")],
    ["json", join(localFixtures, "p3-terminal-foreground.json")],
    ["yaml with reordered object keys", join(localFixtures, "p3-terminal-foreground-reordered.yaml")],
  ] as const;

  it("the same lesson in four encodings compiles to byte-identical output", () => {
    const outputs = encodings.map(([label, path]) => {
      const parsed = parseLessonSource(readFileSync(path, "utf8"), label);
      assert.equal(parsed.ok, true, `${label} must be valid: ${JSON.stringify(parsed.issues, null, 2)}`);
      return { label, bytes: serializeCompiledLesson(compileLesson(parsed.lesson)) };
    });
    for (const { label, bytes } of outputs) {
      assert.equal(bytes, outputs[0].bytes, `${label} diverged from the canonical encoding`);
    }
    // and the source hash inside the output is identical too (already implied
    // by byte-identity, asserted explicitly because it is a documented promise)
    const ir = JSON.parse(outputs[0].bytes);
    assert.equal(ir.source.hash.value, JSON.parse(outputs[1].bytes).source.hash.value);
  });

  it("the serialization is canonical (re-parsing and re-serializing is a fixed point)", () => {
    const bytes = compileFile(sharedValid, "p2a-dev-server.yaml");
    const reparsed = JSON.parse(bytes);
    assert.equal(serializeCompiledLesson(reparsed), bytes);
  });
});

describe("determinism: golden contract", () => {
  it("compiling p2a-terminal-foreground.yaml reproduces the committed golden file byte-for-byte", () => {
    const golden = readFileSync(join(here, "golden", "C01-L011-compiled-lesson.json"), "utf8");
    assert.equal(compileFile(sharedValid, "p2a-terminal-foreground.yaml"), golden);
  });

  it("the golden file documents the compiler/IR versions it was produced with", () => {
    const golden = JSON.parse(readFileSync(join(here, "golden", "C01-L011-compiled-lesson.json"), "utf8"));
    assert.equal(golden.compiled_ir_version, "1.0");
    assert.equal(golden.compiler.version, "0.1.0");
    assert.equal(golden.compiler.name, "course-factory-lesson-compiler");
  });
});
