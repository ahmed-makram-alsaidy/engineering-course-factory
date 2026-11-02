// P5.3 resolved-execution-context tests — the end-to-end resolution chain
// (configured root -> session leaf -> grant workspace -> mount plan ->
// environment plan -> image identity -> frozen context). Asserts provenance,
// deep freeze, single-mount grammar, portable-vs-runtime path separation and
// the total absence of execution machinery. No container or process is ever
// created by this suite.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePath from "node:path";
import {
  SANDBOX_POLICY_REF,
  ResolvedExecutionContextSchema,
  buildWorkspaceMountPlan,
  createSessionWorkspace,
  loadRuntimeImageIdentity,
  resolveConfiguredWorkspaceRoot,
  resolveEnvironmentPlan,
  resolveExecutionContext,
  resolveGrantWorkspace,
} from "../src/index.ts";
import { defaultRepositoryRoot } from "../src/runtime-config.ts";
import { makeGrant, tempRoot, LESSON_ID, SESSION_ID } from "./workspace-fixtures.ts";

const SYNTHETIC_HOST_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({
  TZ: "UTC",
  NO_COLOR: "1",
  PATH: "C:\\Windows\\system32",
  GITHUB_TOKEN: "synthetic-token",
});

/** Deterministic recursive listing (sorted relative paths) for no-mutation checks. */
function readdirRecursive(root: string): string[] {
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

/** Full happy-path resolution against a fresh synthetic root. */
function resolveFull(cwd: string | null = null) {
  const rootResult = resolveConfiguredWorkspaceRoot(tempRoot("cf-p53-ctxroot-"));
  assert.equal(rootResult.ok, true);
  if (!rootResult.ok) throw new Error("unreachable");
  const leafResult = createSessionWorkspace(rootResult.value, { lesson_id: LESSON_ID, session_id: SESSION_ID, generation: 1 });
  assert.equal(leafResult.ok, true);
  if (!leafResult.ok) throw new Error("unreachable");
  if (cwd !== null) mkdirSync(nodePath.join(leafResult.value.host_root, cwd), { recursive: true });
  const pathsResult = resolveGrantWorkspace(leafResult.value, makeGrant({ cwd }));
  assert.equal(pathsResult.ok, true);
  if (!pathsResult.ok) throw new Error("unreachable");
  const mountResult = buildWorkspaceMountPlan(pathsResult.value);
  assert.equal(mountResult.ok, true);
  if (!mountResult.ok) throw new Error("unreachable");
  const envResult = resolveEnvironmentPlan(SYNTHETIC_HOST_ENV, ["TZ", "NO_COLOR"]);
  assert.equal(envResult.ok, true);
  if (!envResult.ok) throw new Error("unreachable");
  const imageResult = loadRuntimeImageIdentity(defaultRepositoryRoot());
  assert.equal(imageResult.ok, true);
  if (!imageResult.ok) throw new Error("unreachable");
  return resolveExecutionContext({
    workspace_paths: pathsResult.value,
    mount_plan: mountResult.value,
    environment_plan: envResult.value,
    image_identity: imageResult.value,
  });
}
describe("P5.3 resolved execution context", () => {
  it("assembles the full context end-to-end with exact provenance", () => {
    const result = resolveFull("src");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const context = result.value;
    assert.equal(context.context_version, 1);
    assert.equal(context.kind, "resolved_execution_context");
    assert.equal(context.sandbox_policy_ref, SANDBOX_POLICY_REF);
    assert.deepEqual(context.grant, makeGrant({ cwd: "src" }), "the context carries the exact validated grant");
    assert.equal(context.workspace.lesson_id, LESSON_ID);
    assert.equal(context.workspace.session_id, SESSION_ID);
    assert.equal(context.workspace.generation, 1);
    assert.equal(context.workspace.container_workspace_root, "/workspace");
    assert.equal(context.workspace.container_cwd, "/workspace/src");
  });

  it("the mount plan is exactly one writable bind of the session leaf at /workspace", () => {
    const result = resolveFull();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const plan = result.value.mount_plan;
    assert.equal(plan.length, 1, "strictly one mount — no second bind can exist");
    const [mount] = plan;
    assert.ok(mount);
    assert.equal(mount.type, "bind");
    assert.equal(mount.target, "/workspace");
    assert.equal(mount.read_only, false);
    assert.equal(mount.source, result.value.workspace.host_workspace_root, "the ONLY source is the session leaf");
  });

  it("portable (container) and runtime (host) views stay strictly separated", () => {
    const result = resolveFull("docs/notes");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const context = result.value;
    assert.ok(context.workspace.container_cwd.startsWith("/workspace/"));
    assert.ok(!context.workspace.container_cwd.includes("\\"), "container cwd is pure POSIX");
    assert.ok(!/[A-Za-z]:/.test(context.workspace.container_cwd), "no drive letters in the container view");
    assert.ok(!context.workspace.host_cwd.startsWith("/workspace"), "the host view is a real host path");
    assert.equal(context.workspace.host_cwd, nodePath.join(context.workspace.host_workspace_root, "docs", "notes"));
    const parsed = ResolvedExecutionContextSchema.parse(JSON.parse(JSON.stringify(context)));
    assert.deepEqual(parsed, context, "the context survives its own schema round-trip");
  });

  it("the context is deeply frozen and carries no functions (no provider handles)", () => {
    const result = resolveFull();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const context: unknown = result.value;
    const seen: unknown[] = [context];
    while (seen.length > 0) {
      const item = seen.pop();
      assert.ok(Object.isFrozen(item), "every nested object is frozen");
      for (const value of Object.values(item as Record<string, unknown>)) {
        assert.notEqual(typeof value, "function", "no function values — no execution handles");
        if (value !== null && typeof value === "object") seen.push(value);
      }
    }
    assert.throws(() => {
      (result.value.workspace as { session_id: string }).session_id = "tampered";
    }, TypeError);
  });

  it("rejects a smuggled environment plan with ENVIRONMENT_POLICY_VIOLATION", () => {
    const rootResult = resolveConfiguredWorkspaceRoot(tempRoot("cf-p53-envrej-"));
    assert.equal(rootResult.ok, true);
    if (!rootResult.ok) return;
    const leafResult = createSessionWorkspace(rootResult.value, { lesson_id: LESSON_ID, session_id: SESSION_ID, generation: 1 });
    assert.equal(leafResult.ok, true);
    if (!leafResult.ok) return;
    const pathsResult = resolveGrantWorkspace(leafResult.value, makeGrant());
    assert.equal(pathsResult.ok, true);
    if (!pathsResult.ok) return;
    const mountResult = buildWorkspaceMountPlan(pathsResult.value);
    assert.equal(mountResult.ok, true);
    if (!mountResult.ok) return;
    const imageResult = loadRuntimeImageIdentity(defaultRepositoryRoot());
    assert.equal(imageResult.ok, true);
    if (!imageResult.ok) return;
    const badPlan = {
      environment_policy_version: 1,
      base: { HOME: "/workspace/.home", LANG: "C.UTF-8" },
      host_forwarded: [{ name: "PATH", value: SYNTHETIC_HOST_ENV.PATH, source: "host_allowlist" }],
    } as never;
    const result = resolveExecutionContext({
      workspace_paths: pathsResult.value,
      mount_plan: mountResult.value,
      environment_plan: badPlan,
      image_identity: imageResult.value,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "ENVIRONMENT_POLICY_VIOLATION");
  });

  it("rejects non-pinned image identity (IMAGE_UNAVAILABLE) and extra mounts (WORKSPACE_VIOLATION)", () => {
    const rootResult = resolveConfiguredWorkspaceRoot(tempRoot("cf-p53-imgrej-"));
    assert.equal(rootResult.ok, true);
    if (!rootResult.ok) return;
    const leafResult = createSessionWorkspace(rootResult.value, { lesson_id: LESSON_ID, session_id: SESSION_ID, generation: 1 });
    assert.equal(leafResult.ok, true);
    if (!leafResult.ok) return;
    const pathsResult = resolveGrantWorkspace(leafResult.value, makeGrant());
    assert.equal(pathsResult.ok, true);
    if (!pathsResult.ok) return;
    const mountResult = buildWorkspaceMountPlan(pathsResult.value);
    assert.equal(mountResult.ok, true);
    if (!mountResult.ok) return;
    const envResult = resolveEnvironmentPlan(SYNTHETIC_HOST_ENV, ["TZ"]);
    assert.equal(envResult.ok, true);
    if (!envResult.ok) return;
    const imageResult = loadRuntimeImageIdentity(defaultRepositoryRoot());
    assert.equal(imageResult.ok, true);
    if (!imageResult.ok) return;

    const movingTag = {
      pinned_reference: "node:latest",
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      platform: "linux/amd64",
      pull_policy: "always",
      source: "base-image.lock.json",
    } as never;
    const imageRejection = resolveExecutionContext({
      workspace_paths: pathsResult.value,
      mount_plan: mountResult.value,
      environment_plan: envResult.value,
      image_identity: movingTag,
    });
    assert.equal(imageRejection.ok, false);
    if (imageRejection.ok) return;
    assert.equal(imageRejection.error.code, "IMAGE_UNAVAILABLE", "a moving tag can never become a runtime identity");

    const extraRoot = mkdtempSync(join(tmpdir(), "cf-p53-extra-"));
    const secondMount = { type: "bind", source: extraRoot, target: "/workspace", read_only: false };
    const mountRejection = resolveExecutionContext({
      workspace_paths: pathsResult.value,
      mount_plan: [mountResult.value[0], secondMount] as never,
      environment_plan: envResult.value,
      image_identity: imageResult.value,
    });
    assert.equal(mountRejection.ok, false, "a second bind mount must fail strict validation");
    if (mountRejection.ok) return;
    assert.equal(mountRejection.error.code, "WORKSPACE_VIOLATION");
    rmSync(extraRoot, { recursive: true, force: true });
  });

  it("hostile re-resolution attempts leave the workspace and context untouched", () => {
    const rootResult = resolveConfiguredWorkspaceRoot(tempRoot("cf-p53-nomut-"));
    assert.equal(rootResult.ok, true);
    if (!rootResult.ok) return;
    const leafResult = createSessionWorkspace(rootResult.value, { lesson_id: LESSON_ID, session_id: SESSION_ID, generation: 1 });
    assert.equal(leafResult.ok, true);
    if (!leafResult.ok) return;
    const pathsResult = resolveGrantWorkspace(leafResult.value, makeGrant());
    assert.equal(pathsResult.ok, true);
    if (!pathsResult.ok) return;

    const before = readdirRecursive(leafResult.value.host_root);
    const hostileAttempts = [
      resolveGrantWorkspace(leafResult.value, makeGrant({ cwd: "../escape" })),
      resolveGrantWorkspace(leafResult.value, makeGrant({ cwd: "missing/dir" })),
      resolveGrantWorkspace(leafResult.value, makeGrant({ session_id: "sess-other" })),
    ];
    for (const attempt of hostileAttempts) assert.equal(attempt.ok, false);
    const after = readdirRecursive(leafResult.value.host_root);
    assert.deepEqual(after, before, "rejected resolutions never mutate the workspace tree");

    // The earlier successful resolution still validates; nothing decayed.
    assert.equal(buildWorkspaceMountPlan(pathsResult.value).ok, true);
  });

  it("an external junction placed inside the resolved cwd is caught (physical re-verification)", () => {
    const rootResult = resolveConfiguredWorkspaceRoot(tempRoot("cf-p53-phys-"));
    assert.equal(rootResult.ok, true);
    if (!rootResult.ok) return;
    const leafResult = createSessionWorkspace(rootResult.value, { lesson_id: LESSON_ID, session_id: SESSION_ID, generation: 1 });
    assert.equal(leafResult.ok, true);
    if (!leafResult.ok) return;
    mkdirSync(nodePath.join(leafResult.value.host_root, "proj"));
    const outside = mkdtempSync(join(tmpdir(), "cf-p53-phys-out-"));
    symlinkSync(outside, nodePath.join(leafResult.value.host_root, "proj", "escape"), "junction");
    const result = resolveGrantWorkspace(leafResult.value, makeGrant({ cwd: "proj/escape" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKSPACE_VIOLATION");
    rmSync(outside, { recursive: true, force: true });
  });
});

