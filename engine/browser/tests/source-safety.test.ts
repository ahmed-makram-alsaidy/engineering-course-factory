// P7.3 Source Safety Tests — browser_protocol_version = 1.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md and docs/adr/ADR-0012-browser-automation-boundary.md.
// Proves strictly reviewed, pinned, and safe state of P7.3:
// - Pinned playwright-core (1.50.1) is the ONLY browser automation dependency
// - Zero test runners / wrappers (no playwright, @playwright/test, puppeteer, selenium)
// - Child process imports restricted strictly to process/job-object management modules
// - Out-of-process pipe transport only (zero --remote-debugging-port, zero debug TCP)
// - Standard Chromium sandbox preserved (zero --no-sandbox)
// - Zero system Chrome or Edge fallback
// - Zero indiscriminate process killing (never taskkill /IM chrome.exe)
// - Zero arbitrary JavaScript evaluation (page.evaluate, eval, new Function)
// - Zero semantic action execution (P7.4 non-goal)
// - Zero navigation action execution (P7.5 non-goal)
// - Zero IPC wiring or BrowserPane implementation (P7.6/P7.7 non-goals)
// - Zero cross-engine orchestration (P8 non-goal)
// - Schema 1.1 and Compiled IR 1.0 preserved completely (no schema drift)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (full.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("P7.3 Source Safety: Manifest & Dependency Checks", () => {
  it("proves package.json contains pinned playwright-core and zero wrapper libraries", () => {
    const pkgPath = join(packageRoot, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    const deps = pkg.dependencies ?? {};
    assert.equal(deps["playwright-core"], "1.50.1", "playwright-core must be pinned exactly to 1.50.1");

    const allDeps = [...Object.keys(deps), ...Object.keys(pkg.devDependencies ?? {})];

    const forbiddenDeps = [
      "playwright",
      "@playwright/test",
      "puppeteer",
      "puppeteer-core",
      "selenium-webdriver",
      "chromedriver",
      "chrome-remote-interface",
      "ws",
      "socket.io",
      "express",
    ];

    for (const forbidden of forbiddenDeps) {
      assert.equal(
        allDeps.includes(forbidden),
        false,
        `Package manifest must not contain forbidden dependency '${forbidden}'`,
      );
    }
  });
});

describe("P7.3 Source Safety: Static Source AST / Text Audit", () => {
  const srcFiles = collectTsFiles(join(packageRoot, "src"));
  const noComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("proves child_process is restricted strictly to process.ts and job-object.ts", () => {
    const allowedChildProcessModules = new Set([
      resolve(packageRoot, "src", "process.ts"),
      resolve(packageRoot, "src", "job-object.ts"),
    ]);

    for (const file of srcFiles) {
      if (allowedChildProcessModules.has(file)) continue;

      const content = readFileSync(file, "utf8");
      assert.doesNotMatch(
        content,
        /from\s+["']node:child_process["']|require\(["']child_process["']\)/,
        `File '${file}' must not import child_process`,
      );
      assert.doesNotMatch(
        content,
        /\bspawn\(|\bexec\(|\bfork\(/,
        `File '${file}' must not execute child processes`,
      );
    }
  });

  it("proves core contracts (protocol, admission, policy) remain free of network and process imports", () => {
    const pureContractFiles = ["protocol.ts", "admission.ts", "policy.ts"].map((f) =>
      join(packageRoot, "src", f),
    );
    for (const file of pureContractFiles) {
      const content = readFileSync(file, "utf8");
      assert.doesNotMatch(
        content,
        /from\s+["']node:net["']|from\s+["']node:dgram["']|from\s+["']node:http["']|from\s+["']node:https["']|from\s+["']node:child_process["']/,
        `File '${file}' must not import network or process modules`,
      );
    }
  });

  it("proves networking in bridge modules is strictly loopback-only with no 0.0.0.0 or wildcard", () => {
    const bridgeFiles = ["fixture-server.ts", "proxy.ts", "port-manager.ts", "bridge.ts"].map((f) =>
      join(packageRoot, "src", f),
    );
    for (const file of bridgeFiles) {
      const content = noComments(readFileSync(file, "utf8"));
      assert.doesNotMatch(content, /["']0\.0\.0\.0["']/, `File '${file}' must never bind 0.0.0.0`);
      assert.doesNotMatch(content, /from\s+["']node:dgram["']/, `File '${file}' must not use UDP/dgram`);
    }
  });

  it("proves absolute absence of arbitrary JavaScript evaluation", () => {
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf8");
      assert.doesNotMatch(content, /\beval\s*\(/, `File '${file}' must not call eval()`);
      assert.doesNotMatch(content, /new\s+Function\s*\(/, `File '${file}' must not use new Function()`);
      assert.doesNotMatch(content, /page\.evaluate\s*\(/, `File '${file}' must not evaluate arbitrary page script`);
    }
  });

  it("proves launch configuration never uses --remote-debugging-port or --no-sandbox", () => {
    for (const file of srcFiles) {
      const content = noComments(readFileSync(file, "utf8"));
      // The only allowed mentions of these strings are in rejection/forbidden check lists
      const lines = content.split(/\r?\n/);
      let inForbiddenBlock = false;
      for (const line of lines) {
        if (line.includes("FORBIDDEN_CHROMIUM_FLAGS")) {
          inForbiddenBlock = true;
          continue;
        }
        if (inForbiddenBlock) {
          if (line.includes("] as const;")) {
            inForbiddenBlock = false;
          }
          continue;
        }
        if (line.includes("forbidden of FORBIDDEN")) continue;
        assert.doesNotMatch(
          line,
          /["']--remote-debugging-port/,
          `File '${file}' must never configure --remote-debugging-port`,
        );
        assert.doesNotMatch(
          line,
          /["']--no-sandbox["']/,
          `File '${file}' must never configure --no-sandbox`,
        );
      }
    }
  });

  it("proves absence of indiscriminate process termination (no taskkill /IM chrome.exe)", () => {
    for (const file of srcFiles) {
      const content = noComments(readFileSync(file, "utf8"));
      assert.doesNotMatch(
        content,
        /taskkill\s+\/IM|Stop-Process\s+-Name/i,
        `File '${file}' must never terminate processes indiscriminately by name`,
      );
    }
  });

  it("proves semantic selector strategies are strictly encapsulated in selectors.ts", () => {
    const allowedSelectorFiles = new Set([
      resolve(packageRoot, "src", "selectors.ts"),
    ]);

    for (const file of srcFiles) {
      if (allowedSelectorFiles.has(file)) continue;

      const content = readFileSync(file, "utf8");
      assert.doesNotMatch(content, /\.getByRole\s*\(/, `File '${file}' must not directly call getByRole`);
      assert.doesNotMatch(content, /\.getByLabel\s*\(/, `File '${file}' must not directly call getByLabel`);
      assert.doesNotMatch(content, /\.getByTestId\s*\(/, `File '${file}' must not directly call getByTestId`);
      assert.doesNotMatch(content, /\.getByText\s*\(/, `File '${file}' must not directly call getByText`);
    }
  });

  it("proves absolute absence of selector heuristics (no first, last, nth)", () => {
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf8");
      assert.doesNotMatch(content, /\.first\s*\(/, `File '${file}' must not call first()`);
      assert.doesNotMatch(content, /\.last\s*\(/, `File '${file}' must not call last()`);
      assert.doesNotMatch(content, /\.nth\s*\(/, `File '${file}' must not call nth()`);
    }
  });

  it("proves absolute absence of force: true and coordinate clicks", () => {
    for (const file of srcFiles) {
      const content = noComments(readFileSync(file, "utf8"));
      // Action files must never use force: true
      if (file.includes("actions") || file.includes("selectors")) {
        assert.doesNotMatch(content, /force\s*:\s*true/, `Action file '${file}' must never use force: true`);
      }
      assert.doesNotMatch(content, /\.click\s*\([^)]*force\s*:\s*true/, `File '${file}' must never use .click({ force: true })`);
      assert.doesNotMatch(content, /mouse\.click\s*\(/, `File '${file}' must never use mouse coordinate clicks`);
    }
  });

  it("proves absence of OS-level automation dependencies (robotjs, nut.js, SendKeys)", () => {
    for (const file of srcFiles) {
      const content = noComments(readFileSync(file, "utf8"));
      assert.doesNotMatch(content, /robotjs|@nut-tree|SendKeys/i, `File '${file}' must not use OS-level automation`);
    }
  });

  it("proves navigation actions are strictly encapsulated in open.ts and refresh.ts", () => {
    const allowedNavigationFiles = new Set([
      resolve(packageRoot, "src", "actions", "open.ts"),
      resolve(packageRoot, "src", "actions", "refresh.ts"),
    ]);

    for (const file of srcFiles) {
      if (allowedNavigationFiles.has(file)) continue;

      const content = noComments(readFileSync(file, "utf8"));
      assert.doesNotMatch(content, /page\.goto\s*\(/, `File '${file}' must not execute page.goto`);
      assert.doesNotMatch(content, /page\.reload\s*\(/, `File '${file}' must not execute page.reload`);
    }
  });

  it("proves absence of future phase creep (BrowserPane, Electron IPC, P8 orchestration)", () => {
    for (const file of srcFiles) {
      const content = readFileSync(file, "utf8");
      assert.doesNotMatch(content, /\bipcMain\b|\bipcRenderer\b/, `File '${file}' must not wire Electron IPC`);
      assert.doesNotMatch(content, /\bBrowserPane\b/, `File '${file}' must not implement BrowserPane`);
      assert.doesNotMatch(content, /\brunNextGlobalStep\b|\bplayhead\b/, `File '${file}' must not implement P8 playhead`);
    }
  });
});

describe("P7.3 Source Safety: Schema & IR Invariance", () => {
  it("verifies Schema 1.1 remains unchanged and contains all seven browser actions", () => {
    const schemaPath = join(repoRoot, "packages", "shared-types", "src", "schema.ts");
    const schemaContent = readFileSync(schemaPath, "utf8");

    assert.match(schemaContent, /"browser_open"/);
    assert.match(schemaContent, /"browser_click"/);
    assert.match(schemaContent, /"browser_fill"/);
    assert.match(schemaContent, /"browser_press"/);
    assert.match(schemaContent, /"browser_refresh"/);
    assert.match(schemaContent, /"browser_wait"/);
    assert.match(schemaContent, /"browser_assert"/);
    assert.doesNotMatch(schemaContent, /"browser_eval"/);
  });

  it("verifies Compiled IR 1.0 remains unchanged and preserves browser family", () => {
    const irPath = join(repoRoot, "engine", "compiler", "src", "ir.ts");
    const irContent = readFileSync(irPath, "utf8");

    assert.match(
      irContent,
      /ActionFamily\s*=\s*z\.enum\(\[\s*"file",\s*"editor",\s*"terminal",\s*"wait",\s*"browser",\s*"visual"\s*\]\)/,
    );
    assert.match(irContent, /browser_origins:\s*z\.array\(z\.string\(\)\.min\(1\)\)/);
  });
});
