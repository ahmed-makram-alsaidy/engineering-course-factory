// P8.1 Source Safety and Architectural Boundary Test
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 2 & 29.
// Proves that @course-factory/runtime-orchestrator in P8.1 is contract-only:
// zero Electron imports, zero Playwright, zero Docker, zero child_process,
// zero generic IPC, zero execution engines, zero P8.2+ scope.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(__dirname, "..", "src");

function getAllSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...getAllSourceFiles(full));
    } else if (full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("P8.1: Source Safety & Architectural Boundaries", () => {
  const sourceFiles = getAllSourceFiles(srcDir);

  it("source directory contains only expected P8.1 files (and P8.2-P8.6)", () => {
    assert.ok(sourceFiles.length > 0);
    const basenames = sourceFiles.map((f) => f.split(/[\\/]/).pop());
    // P8.1, P8.2, P8.3, P8.4, P8.5, and P8.6 owned files
    for (const name of basenames) {
      assert.ok(
        [
          "index.ts",
          "protocol.ts",
          "errors.ts",
          "validator.ts",
          "clock.ts",
          "state-machine.ts",
          "playhead.ts",
          // P8.4 adapters
          "adapter.ts",
          "editor-adapter.ts",
          "terminal-adapter.ts",
          "browser-adapter.ts",
          "wait-adapter.ts",
          "narration-adapter.ts",
          "visual-adapter.ts",
          "registry.ts",
          // P8.5 orchestrator core & global journal
          "journal.ts",
          "process-ledger.ts",
          "runtime.ts",
          // P8.6 lifecycle coordination
          "lifecycle-coordination.ts",
        ].includes(name!),
        `Unexpected source file in P8.1-P8.6: ${name}`
      );
    }
  });

  it("no forbidden imports in runtime-orchestrator source", () => {
    const forbiddenPatterns = [
      /\bfrom\s+["']electron["']/,
      /\bfrom\s+["']playwright["']/,
      /\bfrom\s+["']playwright-core["']/,
      /\bfrom\s+["']node:child_process["']/,
      /\bfrom\s+["']child_process["']/,
      /\bfrom\s+["']node-pty["']/,
      /\bfrom\s+["']monaco-editor["']/,
      /\bpage\.evaluate\b/,
      /\bchild_process\.spawn\b/,
      /\bexec\s*\(/,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /\bipcMain\b/,
      /\bipcRenderer\b/,
    ];

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.ok(
          !pattern.test(content),
          `File ${file} contains forbidden pattern ${pattern}`
        );
      }
    }
  });

  it("package.json contains no heavyweight execution dependencies", () => {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    assert.equal(deps["electron"], undefined);
    assert.equal(deps["playwright"], undefined);
    assert.equal(deps["playwright-core"], undefined);
    assert.equal(deps["node-pty"], undefined);
  });

  it("P8.3+ scope is properly scoped in repository (P8.3-P8.10 owned files present, P9 absent)", () => {
    const pkgRoot = join(__dirname, "..");
    const repoRoot = join(pkgRoot, "..", "..");

    // P8.3 files present
    assert.ok(readdirSync(srcDir).includes("state-machine.ts"), "P8.3 state-machine.ts must be present");
    assert.ok(readdirSync(srcDir).includes("playhead.ts"), "P8.3 playhead.ts must be present");
    assert.ok(readdirSync(srcDir).includes("clock.ts"), "P8.3 clock.ts must be present");

    // P8.4 adapters present
    assert.ok(readdirSync(srcDir).includes("adapters"), "P8.4 adapters/ must be present");

    // P8.5 files present
    assert.ok(readdirSync(srcDir).includes("journal.ts"), "P8.5 journal.ts must be present");
    assert.ok(readdirSync(srcDir).includes("process-ledger.ts"), "P8.5 process-ledger.ts must be present");
    assert.ok(readdirSync(srcDir).includes("runtime.ts"), "P8.5 runtime.ts must be present");

    // P8.6 files present
    assert.ok(readdirSync(srcDir).includes("lifecycle-coordination.ts"), "P8.6 lifecycle-coordination.ts must be present");

    // P8.7 files present
    const ideElectronDir = join(repoRoot, "apps", "teaching-ide", "electron");
    assert.ok(readdirSync(ideElectronDir).includes("runtime-host.ts"), "P8.7 runtime-host.ts must be present");

    // P8.8 files present
    const runtimeTestsDir = join(pkgRoot, "tests");
    assert.ok(readdirSync(runtimeTestsDir).includes("matrix.test.ts"), "P8.8 matrix.test.ts must be present");

    // Final P8 scope is marker-verified. P9 remains strictly absent.
    assert.ok(readdirSync(ideElectronDir).includes("smoke-p8.ts"), "P8.9 smoke-p8.ts must be present");
    assert.match(
      readFileSync(join(ideElectronDir, "smoke-p8.ts"), "utf8"),
      /SMOKE_P8_FIXTURE_ID/,
      "P8.9 smoke-p8.ts must retain its canonical fixture marker",
    );
    const scriptsDir = join(repoRoot, "scripts");
    assert.ok(readdirSync(scriptsDir).includes("validate-p8-9.sh"), "P8.9 validate-p8-9.sh must be present");
    assert.match(
      readFileSync(join(scriptsDir, "validate-p8-9.sh"), "utf8"),
      /P8\.9 VALIDATION - Real Electron End-to-End Visual Proof/,
      "P8.9 gate must retain its canonical marker",
    );
    assert.ok(readdirSync(scriptsDir).includes("validate-p8.sh"), "P8.10 validate-p8.sh must be present");
    assert.match(
      readFileSync(join(scriptsDir, "validate-p8.sh"), "utf8"),
      /P8\.10 VALIDATION - Final P8 Gate & Architecture Review/,
      "P8.10 gate must retain its canonical marker",
    );
    assert.ok(readdirSync(scriptsDir).includes("audit-p8.mjs"), "P8.10 audit-p8.mjs must be present");
    assert.match(
      readFileSync(join(scriptsDir, "audit-p8.mjs"), "utf8"),
      /P8 FINAL ARCHITECTURE & SECURITY AUDIT \(P8\.10\)/,
      "P8.10 audit must retain its canonical marker",
    );
    assert.ok(!readdirSync(scriptsDir).includes("validate-p9.sh"), "P9 validate-p9.sh must be absent");
  });
});
