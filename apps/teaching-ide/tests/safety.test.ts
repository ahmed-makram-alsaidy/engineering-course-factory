// P4 safety tests — the strict non-execution boundary for the Teaching IDE.
//
// 1. Sentinel proof: navigating the FULL side-effect lesson (terminal_run that
//    would create a file, browser_open that would fetch, type_code payload)
//    through the playhead + descriptors leaves no sentinel file, no network
//    construct, and no editor mutation.
// 2. Static boundary: app source (renderer + electron main + preload) contains
//    no shell/PTY/browser-automation constructs; only the main process may
//    touch node:fs (bundled fixtures only).
// 3. No machine-specific data in any fixture.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCompiledLessonData } from "../src/model/ir-loader.ts";
import { compileOperationDescriptor } from "../src/model/operation-display.ts";
import { openFile, initialEditorState, bufferOf } from "../src/model/editor.ts";
import { playheadNext, playheadStart, currentStep } from "../src/model/playhead.ts";
import type { CompiledLesson } from "../src/model/ir.ts";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const fixturesDir = join(appRoot, "fixtures");
const SENTINEL = "p3-sentinel-ran.tmp";

function sentinelExists(): boolean {
  return [process.cwd(), appRoot, tmpdir()].some((dir) => existsSync(join(dir, SENTINEL)));
}

describe("safety: walking the side-effect lesson performs nothing", () => {
  const raw = JSON.parse(readFileSync(join(fixturesDir, "compiled-lessons", "side-effect-safety.json"), "utf8"));
  const loaded = loadCompiledLessonData(raw);
  assert.ok(loaded.ok);
  const lesson: CompiledLesson = loaded.ir!;

  it("precondition: sentinel does not exist before navigation", () => {
    assert.equal(sentinelExists(), false);
  });

  it("navigating every step mutates UI state only: no sentinel, editor untouched", () => {
    // the editor is opened as the app does (static content)
    let editor = openFile(initialEditorState, "src/server.ts", "const x = 1;\n");
    const buffersBefore = JSON.stringify(editor.buffers);

    let state = playheadStart();
    let guard = 0;
    const seenOperations: string[] = [];
    for (;;) {
      const step = currentStep(lesson, state);
      if (step.kind === "operation") {
        seenOperations.push(step.operation.type);
        // what the UI does with an operation: build a descriptor, nothing else
        const descriptor = compileOperationDescriptor(step.operation);
        assert.ok(descriptor.title.length > 0);
      }
      const next = playheadNext(lesson, state);
      if (next === state || guard++ > 1000) break;
      state = next;
    }
    assert.ok(seenOperations.includes("terminal_run"), "walked past terminal_run");
    assert.ok(seenOperations.includes("browser_open"), "walked past browser_open");

    assert.equal(JSON.stringify(editor.buffers), buffersBefore, "type_code must never modify editor content");
    assert.equal(sentinelExists(), false, "terminal_run was executed!");
  });

  it("authored command and URL survive as DATA in the loaded IR", () => {
    const serialized = JSON.stringify(lesson);
    assert.match(serialized, /require\('node:fs'\)\.writeFileSync\('p3-sentinel-ran\.tmp', 'executed'\)/);
    assert.match(serialized, /http:\/\/localhost:59999\/p3-should-never-be-fetched/);
  });
});

describe("safety: static non-execution boundary of app source", () => {
  const FORBIDDEN = /child_process|node-pty|\bpty\b|playwright|puppeteer|\bfetch\s*\(|XMLHttpRequest|WebSocket|execSync|spawnSync|\beval\s*\(|new\s+Function/;

  function sourceFiles(): [string, string][] {
    const files: [string, string][] = [];
    for (const dir of ["src", "electron"]) {
      const collect = (relative: string): void => {
        const absolute = join(appRoot, relative);
        for (const entry of readdirSync(absolute, { withFileTypes: true })) {
          if (entry.isDirectory()) collect(join(relative, entry.name));
          else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push([join(relative, entry.name), readFileSync(absolute + "/" + entry.name, "utf8")]);
        }
      };
      collect(dir);
    }
    return files;
  }

  it("no shell/PTY/browser-automation/evaluation construct exists in app source", () => {
    for (const [name, code] of sourceFiles()) {
      const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      // P5.14 allowlist (found by real visual smoke, not mocks): the trusted
      // main process bootstraps the minimal private Docker config context
      // (fixed desktop-linux argv, no shell) so the production provider can
      // run. No renderer input reaches it; the renderer stays spawn-free.
      const normalized = name.replace(/\\/g, "/");
      if (normalized === "electron/main.ts") {
        const withoutBootstrap = stripped
          .replace(/import\s*\{[^}]*spawnSync[^}]*\}\s*from\s*["']node:child_process["']/g, "")
          .replace(/spawnSync\s*\([\s\S]*?context[\s\S]*?\)/g, "");
        assert.doesNotMatch(withoutBootstrap, FORBIDDEN, `${name} contains a forbidden execution construct outside the context bootstrap`);
        assert.match(stripped, /desktop-linux/);
        assert.doesNotMatch(stripped, /shell\s*:\s*true/);
        assert.doesNotMatch(stripped, /\bexecSync\s*\(|\beval\s*\(|new\s+Function/);
      } else if (normalized === "electron/recording-proof.ts") {
        // P9.8 allowlist (proof-only Main entry, same trust as the main.ts
        // bootstrap): exactly the four Docker machine-config spawnSync
        // calls (docker-exe lookup, private desktop-linux context
        // ensure, p615 image-inspect probe). No renderer input reaches
        // them; the proof renderer stays spawn-free. Closed set: any
        // fifth call site fails this test.
        const calls = stripped.match(/spawnSync\s*\(/g) ?? [];
        assert.equal(calls.length, 4, "recording-proof.ts spawnSync closed set must stay exactly four Docker machine-config calls");
        const withoutProofSpawn = stripped
          .replace(/import\s*\{[^}]*spawnSync[^}]*\}\s*from\s*["']node:child_process["']/g, "")
          .replace(/spawnSync\s*\(/g, "dockerCallRemoved(");
        assert.doesNotMatch(withoutProofSpawn, FORBIDDEN, `${name} contains a forbidden execution construct outside the four Docker calls`);
        assert.match(stripped, /desktop-linux/);
        assert.doesNotMatch(stripped, /shell\s*:\s*true/);
        assert.doesNotMatch(stripped, /\bexecSync\s*\(|\beval\s*\(|new\s+Function/);
      } else {
        assert.doesNotMatch(stripped, FORBIDDEN, `${name} contains a forbidden execution construct`);
      }
    }
  });

  it("only the electron main process imports node:fs; node:child_process is main-only for the context bootstrap", () => {
    for (const [name, code] of sourceFiles()) {
      const importsNodeFs = /from\s+["']node:fs["']/.test(code);
      if (importsNodeFs) {
        assert.ok(name.startsWith("electron"), `node:fs is only allowed in the main process (found in ${name})`);
      }
      const normalized = name.replace(/\\/g, "/");
      const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      if (normalized === "electron/main.ts") {
        // P5.14: main-only spawnSync for the fixed private-context bootstrap.
        if (/from\s+["']node:child_process["']/.test(code)) {
          assert.match(stripped, /spawnSync/);
          assert.doesNotMatch(stripped, /\bexec\s*\(|\bexecSync\s*\(|\bexecFile\s*\(.*shell/);
        }
      } else if (normalized === "electron/recording-proof.ts") {
        // P9.8: proof-only Main entry carries the same closed spawnSync set
        // (four Docker machine-config calls); nothing else may import it.
        if (/from\s+["']node:child_process["']/.test(code)) {
          assert.match(stripped, /spawnSync/);
          assert.doesNotMatch(stripped, /\bexec\s*\(|\bexecSync\s*\(|\bexecFile\s*\(.*shell/);
        }
      } else {
        assert.doesNotMatch(stripped, /from\s+["']node:child_process["']/);
      }
    }
  });

  it("the renderer bridge exposes exactly the sanctioned functions (P4 three + P5.11 identifier-only terminal)", () => {
    // P5.11 amendment: the bridge is the three P4 functions plus cfApi.terminal
    // (exactly the five identifier-only invoke methods + preload-local onEvent).
    // P6.12 amendment: plus cfApi.editor (exactly the four identifier-only
    // invoke methods runOperation/cancelOperation/getSnapshot/
    // acknowledgePresentation + preload-local onEvent/onPresentation). No
    // editor reset channel exists (shared lifecycle owner); no generic
    // invoke/send/execute channel exists. No other surface exists;
    // privileged imports stay forbidden.
    // P7.6 amendment: plus cfApi.browser (exactly the four identifier-only
    // invoke methods runOperation/cancelOperation/getSnapshot/resetRuntime
    // plus preload-local onEvent/onFrame).
    const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const preload = strip(readFileSync(join(appRoot, "electron", "preload.ts"), "utf8"));
    assert.match(preload, /getMeta/);
    assert.match(preload, /loadLesson/);
    assert.match(preload, /reportReady/);
    for (const name of ["runOperation", "stopProcess", "cancelOperation", "resetRuntime", "getSnapshot", "onEvent"]) {
      assert.match(preload, new RegExp(name), `P5.11 bridge must expose ${name}`);
    }
    for (const name of ["acknowledgePresentation", "onPresentation"]) {
      assert.match(preload, new RegExp(name), `P6.12 bridge must expose ${name}`);
    }
    for (const name of ["onFrame"]) {
      assert.match(preload, new RegExp(name), `P7.6 bridge must expose ${name}`);
    }
    for (const name of ["startLesson", "pauseLesson", "resumeLesson", "cancelLesson"]) {
      assert.match(preload, new RegExp(name), `P8.7 bridge must expose ${name}`);
    }
    assert.match(preload, /runtime:\s*runtimeApi/);
    assert.equal(preload.match(/contextBridge\.exposeInMainWorld/g)?.length, 1, "exactly one bridge object");
    assert.doesNotMatch(preload, /child_process|node:fs|shell|process\./);
    assert.doesNotMatch(preload, /editor:reset/);
    assert.equal(preload.match(/ipcRenderer\.invoke\("terminal:/g)?.length, 5, "exactly five terminal invokes");
    assert.equal(preload.match(/ipcRenderer\.invoke\("editor:/g)?.length, 4, "exactly four editor invokes");
    assert.equal(preload.match(/ipcRenderer\.invoke\("browser:/g)?.length, 4, "exactly four browser invokes");
    assert.equal(preload.match(/ipcRenderer\.invoke\("runtime:/g)?.length, 6, "exactly six runtime invokes");
  });

  it("the electron main window disables Node in the renderer", () => {
    const main = readFileSync(join(appRoot, "electron", "main.ts"), "utf8");
    assert.match(main, /contextIsolation:\s*true/);
    assert.match(main, /nodeIntegration:\s*false/);
    assert.match(main, /sandbox:\s*true/);
  });
});

describe("safety: no machine-specific data in fixtures", () => {
  function fixtureFiles(): [string, string][] {
    const files: [string, string][] = [];
    const collect = (relative: string): void => {
      const absolute = join(fixturesDir, relative);
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        if (entry.isDirectory()) collect(join(relative, entry.name));
        else files.push([join("fixtures", relative, entry.name), readFileSync(absolute + "/" + entry.name, "utf8")]);
      }
    };
    collect("");
    return files;
  }

  it("fixtures contain no machine paths, usernames, hostnames, or secrets", () => {
    const patterns: [RegExp, string][] = [
      [/\b[A-Za-z]:[\\/]/, "drive-letter path"],
      [/\/home\//, "unix home"],
      [/\/Users\//, "macOS users"],
      [/Users\\/, "windows users"],
      [/AppData/i, "AppData"],
      [/node_modules/, "node_modules"],
      [/file:\/\//, "file URL"],
      [/Ahmed/i, "personal name"],
      [/api[_-]?key/i, "api key material"],
      [/token/i, "token material"],
    ];
    for (const [name, content] of fixtureFiles()) {
      for (const [pattern, label] of patterns) {
        assert.doesNotMatch(content, pattern, `${name} leaked ${label}`);
      }
    }
  });
});
