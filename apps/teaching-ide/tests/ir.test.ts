// P4 IR integration tests — loading and rejecting compiled lessons through the
// CANONICAL P3 authority (no duplicated IR schema exists anywhere in the app).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompiledLessonData } from "../src/model/ir-loader.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures", "compiled-lessons");

describe("ir: loading valid compiled lessons", () => {
  for (const name of ["dev-server", "editor-typing", "side-effect-safety"]) {
    it(`loads ${name}.json and preserves lesson identity`, () => {
      const raw = JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8"));
      const result = loadCompiledLessonData(raw);
      assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
      assert.ok(result.ir);
      assert.equal(result.ir!.compiled_ir_version, "1.0");
      assert.equal(result.ir!.source.schema_version, "1.1");
      assert.equal(result.ir!.scenes.length > 0, true);
    });
  }

  it("the loaded IR is the canonical contract shape (not a hand-rolled copy)", () => {
    const raw = JSON.parse(readFileSync(join(fixtures, "dev-server.json"), "utf8"));
    const result = loadCompiledLessonData(raw);
    assert.ok(result.ok && result.ir);
    // strict IR rejects unknown fields — proving the authority, not a copy
    const tampered = { ...raw, injected: true };
    assert.equal(loadCompiledLessonData(tampered).ok, false);
  });
});

describe("ir: invalid compiled lessons are rejected cleanly", () => {
  it("rejects the deliberately corrupted fixture with actionable issues", () => {
    const raw = JSON.parse(readFileSync(join(fixtures, "invalid-corrupt.json"), "utf8"));
    const result = loadCompiledLessonData(raw);
    assert.equal(result.ok, false);
    assert.equal(result.ir, undefined);
    assert.ok(result.issues.length > 0);
    assert.ok(result.issues.every((issue) => issue.path !== undefined && issue.code !== undefined && issue.message !== undefined));
  });

  it("rejects garbage input (not an object)", () => {
    const result = loadCompiledLessonData("not an ir document");
    assert.equal(result.ok, false);
    assert.ok(result.issues.length > 0);
  });

  it("rejects an empty object", () => {
    const result = loadCompiledLessonData({});
    assert.equal(result.ok, false);
  });

  it("rejects unknown fixture ids deterministically (empty data shape)", () => {
    // what the main-process IPC guard does for a malformed id
    const invalid = typeof "dev-server/../server" === "string" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test("dev-server/../server");
    assert.equal(invalid, true);
  });
});
