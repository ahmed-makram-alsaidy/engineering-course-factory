// P4 model tests — file tree, editor tabs, playhead navigation, operation
// descriptors, recording-safe mode. Pure, deterministic, offline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTree, flattenTree, fileLanguage, type WorkspaceManifest } from "../src/model/workspace.ts";
import { initialEditorState, openFile, closeTab, setActive, setUserBuffer, bufferOf } from "../src/model/editor.ts";
import { goToScene, goToStep, playheadNext, playheadPrevious, playheadStart, currentScene, currentStep, playheadLabel } from "../src/model/playhead.ts";
import { compileOperationDescriptor, NOT_EXECUTED_NOTE } from "../src/model/operation-display.ts";
import { initialSafeModeState, panelVisibility, setRecordingSafe } from "../src/model/safe-mode.ts";
import { sceneLabel, stepLabel, flattenSteps } from "../src/model/ir.ts";
import { loadCompiledLessonData } from "../src/model/ir-loader.ts";
import type { CompiledLesson } from "../src/model/ir.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures", "compiled-lessons");

function loadFixture(name: string): CompiledLesson {
  const result = loadCompiledLessonData(JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8")));
  assert.equal(result.ok, true, `${name} must load: ${JSON.stringify(result.issues, null, 2)}`);
  return result.ir as CompiledLesson;
}

const manifest: WorkspaceManifest = {
  rootLabel: "demo-node-app",
  files: [
    { path: "package.json", language: "json", content: "{}" },
    { path: "src/server.ts", language: "typescript", content: "const x = 1;\n" },
    { path: "src/routes.ts", language: "typescript", content: "const r = 2;\n" },
    { path: "public/index.html", language: "html", content: "<html></html>\n" },
    { path: "README.md", language: "markdown", content: "# demo\n" },
  ],
};

describe("model: file tree", () => {
  it("builds a nested tree with deterministic ordering (dirs first, then alphabetical)", () => {
    const tree = buildTree(manifest);
    assert.equal(tree.name, "demo-node-app");
    assert.deepEqual(
      tree.children?.map((child) => `${child.kind}:${child.name}`),
      ["dir:public", "dir:src", "file:README.md", "file:package.json"],
    );
    const src = tree.children?.find((child) => child.name === "src");
    assert.deepEqual(
      src?.children?.map((child) => child.name),
      ["routes.ts", "server.ts"],
    );
  });

  it("derives editor languages from file extensions", () => {
    assert.equal(fileLanguage("src/server.ts"), "typescript");
    assert.equal(fileLanguage("app.js"), "javascript");
    assert.equal(fileLanguage("data.json"), "json");
    assert.equal(fileLanguage("index.html"), "html");
    assert.equal(fileLanguage("styles.css"), "css");
    assert.equal(fileLanguage("server.py"), "python");
    assert.equal(fileLanguage("notes.txt"), "plaintext");
  });

  it("flattens the tree depth-first with collapsed directories honored", () => {
    const tree = buildTree(manifest);
    const all = flattenTree(tree, new Set());
    assert.equal(all.length, 1 + 2 + 2 + 1 + 2); // root + 2 dirs + 2 root files + 1 public file + 2 src files
    const collapsed = flattenTree(tree, new Set(["src"]));
    assert.equal(collapsed.length, 1 + 2 + 2 + 1); // src not expanded
  });
});

describe("model: editor tabs and active file", () => {
  it("opens files, focuses duplicates, and tracks dirty state from user typing only", () => {
    let state = openFile(initialEditorState, "src/server.ts", "const x = 1;\n");
    assert.deepEqual([...state.open], ["src/server.ts"]);
    assert.equal(state.active, "src/server.ts");
    state = openFile(state, "src/server.ts", "const x = 1;\n");
    assert.equal(state.open.length, 1, "duplicate open focuses instead of duplicating");
    state = openFile(state, "README.md", "# demo\n");
    assert.deepEqual([...state.open], ["src/server.ts", "README.md"]);
    assert.equal(state.dirty.length, 0, "opening never dirties a file");
    state = setUserBuffer(state, "src/server.ts", "const x = 2;\n");
    assert.deepEqual([...state.dirty], ["src/server.ts"]);
    assert.equal(bufferOf(state, "src/server.ts"), "const x = 2;\n");
  });

  it("closes tabs and activates the neighbouring tab", () => {
    let state = openFile(initialEditorState, "a.ts", "a");
    state = openFile(state, "b.ts", "b");
    state = openFile(state, "c.ts", "c");
    state = setActive(state, "b.ts");
    state = closeTab(state, "b.ts");
    assert.equal(state.active, "c.ts", "right neighbour becomes active");
    state = closeTab(state, "c.ts");
    assert.equal(state.active, "a.ts", "falls back to the left neighbour");
    state = closeTab(state, "a.ts");
    assert.equal(state.active, null);
    assert.deepEqual([...state.open], []);
    // buffers are retained so reopening restores content
    assert.equal(bufferOf(state, "a.ts"), "a");
  });

  it("ignores user buffers for files that are not open", () => {
    const state = setUserBuffer(openFile(initialEditorState, "a.ts", "a"), "ghost.ts", "x");
    assert.equal(bufferOf(state, "ghost.ts"), undefined);
    assert.equal(state.dirty.length, 0);
  });
});

describe("model: playhead navigation (non-executing)", () => {
  const lesson = loadFixture("dev-server");

  it("starts at the first step and clamps at both ends", () => {
    const start = playheadStart();
    assert.deepEqual(start, { sceneIndex: 0, stepIndex: 0 });
    assert.equal(playheadPrevious(lesson, start), start, "previous at lesson start is a no-op");
    let state = playheadStart();
    let guard = 0;
    let next = playheadNext(lesson, state);
    while (next !== state && guard < 1000) {
      state = next;
      next = playheadNext(lesson, state);
      guard += 1;
    }
    const lastScene = lesson.scenes[lesson.scenes.length - 1];
    assert.equal(state.sceneIndex, lesson.scenes.length - 1);
    assert.equal(state.stepIndex, lastScene.steps.length - 1, "walk reaches the final authored step");
    assert.equal(playheadNext(lesson, state), state, "next at lesson end is a no-op");
  });

  it("crosses scene boundaries in both directions", () => {
    const lesson2 = loadFixture("editor-typing"); // 3 scenes
    const scene2Start = goToScene(lesson2, 1);
    const before = playheadPrevious(lesson2, scene2Start);
    assert.equal(before.sceneIndex, 0, "crossing back lands on the previous scene");
    assert.equal(before.stepIndex, lesson2.scenes[0].steps.length - 1);
    const forward = playheadNext(lesson2, { sceneIndex: 0, stepIndex: lesson2.scenes[0].steps.length - 1 });
    assert.equal(forward.sceneIndex, 1);
    assert.equal(forward.stepIndex, 0);
  });

  it("goToScene/goToStep clamp and label deterministically", () => {
    assert.equal(goToScene(lesson, -5).sceneIndex, 0);
    assert.equal(goToScene(lesson, 99).sceneIndex, lesson.scenes.length - 1);
    const step = goToStep(lesson, 0, 999);
    assert.equal(step.stepIndex, lesson.scenes[0].steps.length - 1);
    assert.match(playheadLabel(lesson, step), /^C01-L012-S001 · step 14\/14$/);
  });

  it("exposes scene/step summaries for the UI", () => {
    const scene = currentScene(lesson, playheadStart());
    const step = currentStep(lesson, playheadStart());
    assert.match(sceneLabel(scene), /^1\. /);
    assert.ok(stepLabel(step).includes("narration"));
    assert.equal(flattenSteps(lesson).length, lesson.scenes.reduce((sum, s) => sum + s.steps.length, 0));
  });
});

describe("model: operation descriptors are display metadata only", () => {
  const lesson = loadFixture("dev-server");

  function findOperation(fixtureLesson: CompiledLesson, type: string) {
    const entry = flattenSteps(fixtureLesson).find(
      (candidate) => candidate.step.kind === "operation" && candidate.step.operation.type === type,
    );
    assert.ok(entry && entry.step.kind === "operation", `expected a ${type} operation in the fixture`);
    return compileOperationDescriptor(entry.step.operation);
  }

  it("describes terminal_run with command data and a not-executed note", () => {
    const descriptor = findOperation(lesson, "terminal_run");
    assert.equal(descriptor.panel, "terminal");
    assert.ok(descriptor.title.includes("background"));
    assert.equal(descriptor.meta.find(([key]) => key === "command")?.[1], "npm run dev");
  });

  it("describes browser_open with the URL as data and panel=browser", () => {
    const descriptor = findOperation(lesson, "browser_open");
    assert.equal(descriptor.panel, "browser");
    assert.equal(descriptor.meta.find(([key]) => key === "url")?.[1], "http://localhost:3000");
  });

  it("describes type_code with a payload note and never types it", () => {
    const descriptor = findOperation(loadFixture("editor-typing"), "type_code");
    assert.equal(descriptor.panel, "editor");
    const payload = descriptor.meta.find(([key]) => key === "payload");
    assert.ok(payload?.[1].includes("never typed"));
  });
});

describe("model: recording-safe mode", () => {
  it("hides development surfaces when enabled and restores them when disabled", () => {
    const on = setRecordingSafe(initialSafeModeState, true);
    assert.deepEqual(panelVisibility(on), { inspector: false, fixtureSelector: false, devBadge: false });
    const off = setRecordingSafe(on, false);
    assert.deepEqual(panelVisibility(off), { inspector: true, fixtureSelector: true, devBadge: true });
  });

  it("recording-safe mode hides dev panels even when devPanels are enabled by default", () => {
    const on = { ...initialSafeModeState, recordingSafe: true, devPanels: true };
    assert.equal(panelVisibility(on).inspector, false);
  });
});
