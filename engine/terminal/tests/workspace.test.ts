// P5.3 workspace resolution tests — trusted configured-root validation,
// exclusive session-leaf creation, authored-cwd confinement, and grant ->
// workspace resolution (identity, physical containment, no-mutation).
// Nothing here executes anything; every assertion is resolution-only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePath from "node:path";
import {
  createSessionWorkspace,
  defaultRepositoryRoot,
  isInsideWorkspace,
  loadTerminalRuntimePaths,
  resolveAuthoredCwdSegments,
  resolveConfiguredWorkspaceRoot,
  resolveGrantWorkspace,
} from "../src/workspace.ts";
import { makeGrant, tempRoot, LESSON_ID, SESSION_ID } from "./workspace-fixtures.ts";

/** One fully set-up workspace context bound to a fresh temp root. */
function freshContext(generation = 1) {
  const rootResult = resolveConfiguredWorkspaceRoot(tempRoot("cf-p53-root-"));
  assert.equal(rootResult.ok, true);
  if (!rootResult.ok) throw new Error("unreachable");
  const leafResult = createSessionWorkspace(rootResult.value, { lesson_id: LESSON_ID, session_id: SESSION_ID, generation });
  assert.equal(leafResult.ok, true);
  if (!leafResult.ok) throw new Error("unreachable");
  return { root: rootResult.value, leaf: leafResult.value };
}

/** Deterministic recursive listing (sorted relative paths) for no-mutation checks. */
function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      out.push(`${childRel}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) walk(nodePath.join(dir, entry.name), childRel);
    }
  };
  walk(root, "");
  return out.sort();
}

describe("P5.3 machine-local runtime configuration", () => {
  it("rejects a missing config/paths.json with WORKSPACE_UNAVAILABLE (never a fallback)", () => {
    const fakeRepo = tempRoot("cf-p53-norepo-");
    const result = loadTerminalRuntimePaths(fakeRepo);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_UNAVAILABLE");
  });

  it("rejects malformed JSON and wrong shapes with WORKSPACE_UNAVAILABLE", () => {
    const bad = tempRoot("cf-p53-badcfg-");
    mkdirSync(nodePath.join(bad, "config"));
    writeFileSync(nodePath.join(bad, "config", "paths.json"), "{ not json");
    assert.equal(loadTerminalRuntimePaths(bad).ok, false);

    const wrong = tempRoot("cf-p53-wrongcfg-");
    mkdirSync(nodePath.join(wrong, "config"));
    writeFileSync(nodePath.join(wrong, "config", "paths.json"), JSON.stringify({ runtimeWorkspaceRoot: "" }));
    assert.equal(loadTerminalRuntimePaths(wrong).ok, false);

    const extra = tempRoot("cf-p53-extracfg-");
    mkdirSync(nodePath.join(extra, "config"));
    writeFileSync(
      nodePath.join(extra, "config", "paths.json"),
      JSON.stringify({ runtimeWorkspaceRoot: "x", sneaky_root: "/elsewhere" }),
    );
    assert.equal(loadTerminalRuntimePaths(extra).ok, false, "strict schema must reject unknown keys");
  });

  it("loads a valid config with exactly one non-empty runtimeWorkspaceRoot", () => {
    const good = tempRoot("cf-p53-goodcfg-");
    mkdirSync(nodePath.join(good, "config"));
    const rootDir = mkdtempSync(join(tmpdir(), "cf-p53-wsroot-"));
    writeFileSync(nodePath.join(good, "config", "paths.json"), JSON.stringify({ runtimeWorkspaceRoot: rootDir }));
    const result = loadTerminalRuntimePaths(good);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.runtimeWorkspaceRoot, rootDir);
    rmSync(rootDir, { recursive: true, force: true });
  });
});
describe("P5.3 configured workspace root validation", () => {
  it("accepts a real physical directory and reports identical host/real roots", () => {
    const dir = tempRoot("cf-p53-okroot-");
    const result = resolveConfiguredWorkspaceRoot(dir);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.host_root, dir);
      assert.equal(result.value.real_root, dir);
    }
  });

  it("rejects non-absolute, NUL-bearing, UNC/device-namespace, and bind-grammar-hostile values", () => {
    for (const [value, why] of [
      ["relative/root", "relative path"],
      ["no\\0NUL", "NUL"],
      ["\\\\server\\share", "UNC path"],
      ["\\\\.\\pipe\\evil", "device namespace"],
      ["comma,root", "comma (bind-mount grammar)"],
      ['quo"te', "quote (bind-mount grammar)"],
      ["line\r\nbreak", "CR/LF (bind-mount grammar)"],
    ] as const) {
      const result = resolveConfiguredWorkspaceRoot(value);
      assert.equal(result.ok, false, `${why} must be rejected`);
      if (result.ok) return;
      assert.equal(result.error.code, "WORKSPACE_UNAVAILABLE", why);
    }
  });

  it("rejects the filesystem/drive root", () => {
    const result = resolveConfiguredWorkspaceRoot(nodePath.parse(process.cwd()).root);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_UNAVAILABLE");
  });

  it("rejects the user profile directory", () => {
    const result = resolveConfiguredWorkspaceRoot(homedir());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_UNAVAILABLE");
  });

  it("rejects the repository root when the repository root context is supplied", () => {
    const repoRoot = defaultRepositoryRoot();
    const result = resolveConfiguredWorkspaceRoot(repoRoot, { repositoryRoot: repoRoot });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_UNAVAILABLE");
  });

  it("rejects paths that do not exist and paths that are files", () => {
    const missing = nodePath.join(tempRoot("cf-p53-holder-"), "does-not-exist");
    const missingResult = resolveConfiguredWorkspaceRoot(missing);
    assert.equal(missingResult.ok, false);
    assert.equal(existsSync(missing), false, "rejection must not create the missing path");

    const holder = tempRoot("cf-p53-fileroot-");
    const file = nodePath.join(holder, "just-a-file");
    writeFileSync(file, "x");
    const fileResult = resolveConfiguredWorkspaceRoot(file);
    assert.equal(fileResult.ok, false);
    if (fileResult.ok) return;
    assert.equal(fileResult.error.code, "WORKSPACE_UNAVAILABLE");
  });

  it("rejects a root behind a symlink or junction (physical-path requirement)", () => {
    const holder = tempRoot("cf-p53-jroot-");
    const real = nodePath.join(holder, "real-dir");
    mkdirSync(real);
    const link = nodePath.join(holder, "link-dir");
    symlinkSync(real, link, "junction");
    const result = resolveConfiguredWorkspaceRoot(link);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_UNAVAILABLE");
  });
});

describe("P5.3 session workspace leaf creation", () => {
  it("creates the exclusive fresh leaf workspaces/<lesson-id>/<session-id>", () => {
    const { leaf } = freshContext();
    assert.equal(leaf.container_root, "/workspace");
    assert.equal(existsSync(leaf.host_root), true);
    assert.equal(nodePath.basename(nodePath.dirname(leaf.host_root)), LESSON_ID);
    assert.equal(nodePath.basename(nodePath.dirname(nodePath.dirname(leaf.host_root))), "workspaces");
  });

  it("refuses reuse: a second creation for the same identity fails (exclusive/fresh)", () => {
    const { root } = freshContext();
    const again = createSessionWorkspace(root, { lesson_id: LESSON_ID, session_id: SESSION_ID, generation: 1 });
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.error.code, "WORKSPACE_VIOLATION");
    // A different generation of the same session is also reuse.
    const otherGen = createSessionWorkspace(root, { lesson_id: LESSON_ID, session_id: SESSION_ID, generation: 2 });
    assert.equal(otherGen.ok, false);
  });

  it("rejects hostile identity components before touching the filesystem", () => {
    const holder = tempRoot("cf-p53-idhostile-");
    const rootResult = resolveConfiguredWorkspaceRoot(holder);
    assert.equal(rootResult.ok, true);
    if (!rootResult.ok) return;
    const root = rootResult.value;
    const before = existsSync(nodePath.join(holder, "workspaces"));
    for (const bad of ["..", "a/b", "a\\b", "NUL", "CON", "with:colon", ".", "trail.", "x".repeat(129)]) {
      const result = createSessionWorkspace(root, { lesson_id: LESSON_ID, session_id: bad, generation: 1 });
      assert.equal(result.ok, false, `session_id ${JSON.stringify(bad)} must be rejected`);
      if (result.ok) return;
      assert.equal(result.error.code, "INVALID_REQUEST");
    }
    assert.equal(existsSync(nodePath.join(holder, "workspaces")), before);
  });

  it("rejects a symlinked/junctioned member of the workspace chain", () => {
    const holder = tempRoot("cf-p53-chainlink-");
    mkdirSync(nodePath.join(holder, "elsewhere"));
    mkdirSync(nodePath.join(holder, "workspaces"));
    const lessonDir = nodePath.join(holder, "workspaces", LESSON_ID);
    symlinkSync(nodePath.join(holder, "elsewhere"), lessonDir, "junction");
    const rootResult = resolveConfiguredWorkspaceRoot(holder);
    assert.equal(rootResult.ok, true);
    if (!rootResult.ok) return;
    const result = createSessionWorkspace(rootResult.value, { lesson_id: LESSON_ID, session_id: SESSION_ID, generation: 1 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_VIOLATION");
  });

  it("leaf creation is generation-stamped and distinct identities get distinct leaves", () => {
    const { root, leaf } = freshContext(3);
    const next = createSessionWorkspace(root, { lesson_id: LESSON_ID, session_id: "sess-p53-0002", generation: 4 });
    assert.equal(next.ok, true);
    if (next.ok) {
      assert.notEqual(next.value.host_root, leaf.host_root);
      assert.equal(next.value.generation, 4);
    }
    assert.equal(leaf.generation, 3);
  });
});

describe("P5.3 authored-cwd confinement", () => {
  it("maps null and '.' to the workspace root (the ONLY transformation)", () => {
    assert.deepEqual(resolveAuthoredCwdSegments(null), { ok: true, value: [] });
    const dot = resolveAuthoredCwdSegments(".");
    assert.equal(dot.ok, true);
    if (dot.ok) assert.deepEqual([...dot.value], []);
  });

  it("accepts plain POSIX segments inside the allowed charset", () => {
    const result = resolveAuthoredCwdSegments("docs/notes/final_dir");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual([...result.value], ["docs", "notes", "final_dir"]);
    const spaced = resolveAuthoredCwdSegments("my dir");
    assert.equal(spaced.ok, true, "inner spaces are inside the charset");
  });

  it("rejects every traversal and smuggling shape from the design rule list", () => {
    const hostile = [
      "..",
      "../escape",
      "a/../b",
      "a//b",
      "a/",
      "/absolute",
      "C:/windows",
      "a\\b",
      "%2e%2e",
      "%61",
      "CON",
      "nul.",
      "sub.",
      "sub ",
      " sub",
      "with:colon",
      "bad#name",
      "tab\tsep",
    ];
    for (const cwd of hostile) {
      const result = resolveAuthoredCwdSegments(cwd);
      assert.equal(result.ok, false, `cwd ${JSON.stringify(cwd)} must be rejected`);
      if (result.ok) return;
      assert.equal(result.error.code, "WORKSPACE_VIOLATION", cwd);
    }
  });
});

describe("P5.3 grant -> workspace resolution", () => {
  it("resolves a matching grant and separates portable vs runtime paths", () => {
    const { leaf } = freshContext();
    mkdirSync(nodePath.join(leaf.host_root, "src"));
    const result = resolveGrantWorkspace(leaf, makeGrant({ cwd: "src" }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.container_cwd, "/workspace/src");
      assert.equal(result.value.container_workspace_root, "/workspace");
      assert.equal(result.value.host_cwd, nodePath.join(leaf.host_root, "src"));
      if (process.platform === "win32") {
        assert.ok(result.value.host_cwd.includes("\\"), "host cwd uses platform separators");
      }
      assert.ok(!result.value.container_cwd.includes("\\"), "container cwd stays POSIX");
    }
  });

  it("enforces provenance identity: WRONG_OWNER for foreign sessions, STALE_SESSION for old generations", () => {
    const { leaf } = freshContext();
    const foreign = resolveGrantWorkspace(
      leaf,
      makeGrant({ session_id: "sess-other", lesson_id: "other-lesson" }),
    );
    assert.equal(foreign.ok, false);
    if (foreign.ok) return;
    assert.equal(foreign.error.code, "WRONG_OWNER");

    const stale = resolveGrantWorkspace(leaf, makeGrant({ generation: 99 }));
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.error.code, "STALE_SESSION");

    const notAGrant = resolveGrantWorkspace(leaf, { ...makeGrant(), command: "" } as never);
    assert.equal(notAGrant.ok, false, "grants that fail the schema are re-rejected (defense-in-depth)");
  });

  it("rejects traversal-shaped and missing cwd against the physical leaf without mutating it", () => {
    const { leaf } = freshContext();
    mkdirSync(nodePath.join(leaf.host_root, "src"));
    const snapshotBefore = JSON.stringify(listTree(leaf.host_root));
    for (const cwd of ["..", "../escape", "src/missing/deeper", "%2e%2e"]) {
      const result = resolveGrantWorkspace(leaf, makeGrant({ cwd }));
      assert.equal(result.ok, false, `hostile cwd ${cwd} must be rejected`);
      if (result.ok) return;
      assert.equal(result.error.code, "WORKSPACE_VIOLATION", `${cwd}: got ${(result as { error: { code: string } }).error.code}`);
    }
    assert.equal(JSON.stringify(listTree(leaf.host_root)), snapshotBefore, "rejections must not mutate the workspace tree");
  });

  it("rejects a symlink/junction inside the cwd chain (escape attempt)", () => {
    const { leaf } = freshContext();
    const outside = mkdtempSync(join(tmpdir(), "cf-p53-outside-"));
    mkdirSync(nodePath.join(leaf.host_root, "src"));
    symlinkSync(outside, nodePath.join(leaf.host_root, "src", "link"), "junction");
    const result = resolveGrantWorkspace(leaf, makeGrant({ cwd: "src/link" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_VIOLATION");
    rmSync(outside, { recursive: true, force: true });
  });

  it("containment never uses naive prefix matching (sibling-name collisions stay outside)", () => {
    const { leaf } = freshContext();
    assert.equal(isInsideWorkspace(leaf.host_root, `${leaf.host_root}-evil`), false);
    assert.equal(isInsideWorkspace(leaf.host_root, `${leaf.host_root}x`), false);
    assert.equal(isInsideWorkspace(leaf.host_root, leaf.host_root), true);
  });

  it("re-resolution requires the physical leaf to still exist (no dangling reuse)", () => {
    const { leaf } = freshContext();
    const ghost = { ...leaf, host_root: nodePath.join(leaf.host_root, "removed") };
    const result = resolveGrantWorkspace(ghost, makeGrant());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_UNAVAILABLE");
  });

  it("a swapped-in symlink session leaf is rejected at resolution time", () => {
    const { leaf } = freshContext();
    const outside = mkdtempSync(join(tmpdir(), "cf-p53-leafswap-"));
    rmSync(leaf.host_root, { recursive: true, force: true });
    symlinkSync(outside, leaf.host_root, "junction");
    const result = resolveGrantWorkspace(leaf, makeGrant());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_VIOLATION");
    rmSync(outside, { recursive: true, force: true });
  });
});

