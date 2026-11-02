// P6.7 Docker RO interop — REAL container proof (canonical gate only).
//
// Proves the frozen watcher contract at the real bind boundary for executed
// documents (docs/P6-DESIGN-SPEC.md sections 10/26.3/26.7/26.12, ADR-0011):
// an admitted file_open exposes exactly the committed bytes a read-only
// Docker container reads from /workspace, while an executed pending
// file_create stays invisible on disk (the guest observes absence) and the
// guest still cannot write through the RO bind.
//
// TEST 1  executed open == bytes the live RO container reads (bounded poll).
// TEST 2  pending create invisible to the guest; guest writes denied, host
//         absent and unchanged.
//
// Every resource is prefixed cf-p67- under the phase-owned temp/P6.7 root.
// Cleanup is ownership-scoped (this container only); no global prune ever.
// These tests FAIL (never skip) when the daemon or the pinned base image is
// unavailable — the P6.7 gate requires the real proof.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { createSeedManifest, sha256Hex } from "../src/policy.ts";
import { openWindowsFileAdapter, type AdapterAuthority } from "../src/file-adapter.ts";
import { admitEditorOperation, createEditorCatalog, openEditorSession } from "../src/editor-admission.ts";
import { executeAdmittedFileCreate, executeAdmittedFileOpen } from "../src/editor-open-create.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.7", "open-create-docker");

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

const PINNED_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const SUFFIX = randomBytes(3).toString("hex");
const CONTAINER = `cf-p67-interop-${SUFFIX}`;
const LEAF = join(TEST_ROOT, `cf-p67-interop-${SUFFIX}-leaf`);
const STAGING = join(TEST_ROOT, `cf-p67-interop-${SUFFIX}-staging`);

const A_OPEN = "C01-L061-S001-B001";
const A_CREATE = "C01-L061-S002-B001";
const SEEN_TEXT = "// lesson bytes: English تعليق عربي 🚀\nconst greeting = \"مرحبا hello\";\n";

function resolveDockerExe(): string {
  const configured = process.env["CF_P67_DOCKER_EXE"];
  if (configured !== undefined && configured.length > 0) return configured;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["docker"], { encoding: "utf8" });
  if (probe.status === 0 && (probe.stdout ?? "").trim().length > 0) {
    const lines = (probe.stdout as string).trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const withExe = process.platform === "win32" ? lines.find((l) => l.toLowerCase().endsWith(".exe")) : undefined;
    return (withExe ?? lines[0] ?? "docker")!;
  }
  return "docker";
}

const DOCKER_EXE = resolveDockerExe();

function docker(...argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(DOCKER_EXE, argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function proof(message: string): void {
  console.log(`P6.7 PROOF: ${message}`);
}

function daemonOk(): boolean {
  const r = docker("version", "--format", "{{.Server.Version}}");
  return r.status === 0 && r.stdout.trim().length > 0;
}

function baseImageOk(): boolean {
  const r = docker("image", "inspect", PINNED_IMAGE, "--format", "{{.Id}}");
  return r.status === 0 && /^sha256:[0-9a-f]{64}$/.test(r.stdout.trim());
}

function remainingOwnedContainers(): string[] {
  const r = docker("ps", "-aq", "--no-trunc", "--filter", "name=cf-p67-");
  return (r.stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
}

function removeContainer(): void {
  docker("rm", "--force", CONTAINER);
}

const SESSION = `sess-p67-docker-${SUFFIX}`;
const WORKSPACE = `ws-p67-docker-${SUFFIX}`;

function authority(): AdapterAuthority {
  return {
    lease: {
      kind: "editor_lease",
      leaseId: `lease-p67-docker-${SUFFIX}`,
      sessionId: SESSION,
      generation: 1,
      workspaceId: WORKSPACE,
      epoch: 1,
      operationId: "op-p67-docker-1",
      requestId: `req-p67-docker-${SUFFIX}`,
    },
    ownership: "EDITOR_OWNED",
    liveEpoch: 1,
    revokedLeaseIds: [],
  };
}

function guestRead(relPath: string): { status: number | null; stdout: string; stderr: string } {
  return docker("exec", CONTAINER, "cat", `/workspace/${relPath}`);
}

function guestReadWithinBound(relPath: string, expected: string): boolean {
  const deadline = Date.now() + 5000;
  for (;;) {
    const r = guestRead(relPath);
    if (r.status === 0 && r.stdout === expected) return true;
    if (Date.now() > deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

let requestSeq = 0;
function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p67-docker-${prefix}-${requestSeq}-${SUFFIX}`;
}

async function openExecutedSession(): Promise<void> {
  const raw: unknown = JSON.parse(readFileSync(join(here, "fixtures", "p67-open-create.json"), "utf8"));
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  const catalogOutcome = createEditorCatalog(compileModule.compileLesson(parsed.lesson));
  assert.equal(catalogOutcome.ok, true);
  if (!catalogOutcome.ok) throw new Error("unreachable");
  const seedOutcome = createSeedManifest([
    { portable_path: "src", kind: "directory", byte_length: 0, sha256: null },
    {
      portable_path: "src/alpha.ts",
      kind: "regular_file",
      byte_length: Buffer.byteLength(SEEN_TEXT, "utf8"),
      sha256: sha256Hex(SEEN_TEXT),
    },
  ]);
  assert.equal(seedOutcome.ok, true);
  if (!seedOutcome.ok) throw new Error("unreachable");
  const sessionOutcome = openEditorSession({
    catalog: catalogOutcome.value,
    sessionId: SESSION,
    generation: 1,
    seedManifest: seedOutcome.value,
    reviewed: true,
  });
  assert.equal(sessionOutcome.ok, true);
  if (!sessionOutcome.ok) throw new Error("unreachable");
  const session = sessionOutcome.value;
  const bound = openWindowsFileAdapter({
    sessionId: SESSION,
    generation: 1,
    workspaceId: WORKSPACE,
    leafHostPath: LEAF,
    stagingHostPath: STAGING,
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error("unreachable");
  const openAdmission = admitEditorOperation(session, {
    session_id: SESSION,
    generation: 1,
    operation_id: A_OPEN,
    request_id: nextRequest("open"),
  });
  assert.equal(openAdmission.ok, true);
  if (!openAdmission.ok) throw new Error("unreachable");
  const opened = await executeAdmittedFileOpen(session, openAdmission.value, {
    adapter: bound.value,
    authority: authority(),
  });
  assert.equal(opened.ok, true, "executed open must succeed beside the RO watcher");
  if (!opened.ok) throw new Error("unreachable");
  assert.equal(opened.value.content, SEEN_TEXT);
  const createAdmission = admitEditorOperation(session, {
    session_id: SESSION,
    generation: 1,
    operation_id: A_CREATE,
    request_id: nextRequest("create"),
  });
  assert.equal(createAdmission.ok, true);
  if (!createAdmission.ok) throw new Error("unreachable");
  const created = await executeAdmittedFileCreate(session, createAdmission.value, {
    adapter: bound.value,
    authority: authority(),
  });
  assert.equal(created.ok, true, "pending create must stage beside the RO watcher");
  if (!created.ok) throw new Error("unreachable");
  assert.equal(existsSync(join(LEAF, "src", "beta.ts")), false, "pending create stays off disk");
}

before(() => {
  assert.equal(daemonOk(), true, "Docker daemon must be reachable for the real interop proof (no fake PASS)");
  assert.equal(baseImageOk(), true, "the pinned base image must be present for the real interop proof");
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(join(LEAF, "src"), { recursive: true });
  mkdirSync(STAGING, { recursive: true });
  writeFileSync(join(LEAF, "src", "alpha.ts"), SEEN_TEXT, "utf8");
  removeContainer();
  const created = docker(
    "create",
    "--name", CONTAINER,
    "--label", "com.course-factory.owner=course-factory",
    "--label", "com.course-factory.phase=P6",
    "--label", `com.course-factory.test-run=cf-p67-interop-${SUFFIX}`,
    "--platform", "linux/amd64",
    "--pull", "never",
    "--user", "1000:1000",
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--mount", `type=bind,source=${LEAF},target=/workspace,readonly,bind-recursive=disabled`,
    PINNED_IMAGE,
    "sleep", "infinity",
  );
  assert.equal(created.status, 0, `RO epoch container must be created: ${created.stderr}`);
  const started = docker("start", CONTAINER);
  assert.equal(started.status, 0, `RO epoch container must start: ${started.stderr}`);
  const running = docker("inspect", CONTAINER, "--format", "{{.State.Running}}");
  assert.equal(running.stdout.trim(), "true", "RO epoch container must be running");
  const inspectRaw = docker("inspect", CONTAINER);
  assert.equal(inspectRaw.status, 0);
  const doc = JSON.parse(inspectRaw.stdout) as Array<{ Mounts?: Array<{ Destination?: string; RW?: boolean }> }>;
  const mounts = doc[0]?.Mounts ?? [];
  const workspaceMount = mounts.find((m) => m.Destination === "/workspace");
  assert.equal(mounts.length, 1, "SANDBOX cf-p67 RO epoch carries exactly one bind");
  assert.equal(workspaceMount?.RW, false, "SANDBOX cf-p67 RO epoch binds /workspace readonly");
  proof("SANDBOX cf-p67 RO epoch: NetworkMode=none User=1000:1000 RW=false binds=1");
});

after(() => {
  removeContainer();
  rmSync(TEST_ROOT, { recursive: true, force: true });
  const remaining = remainingOwnedContainers();
  console.log(`P6.7 PROOF: CLEANUP remaining cf-p67 containers: [${remaining.join(",")}]`);
  assert.deepEqual(remaining, [], "zero cf-p67 containers remain");
});

describe("P6.7 Docker RO interop", () => {
  it("TEST 1 executed open equals the bytes the RO container reads", async () => {
    await openExecutedSession();
    assert.equal(
      guestReadWithinBound("src/alpha.ts", SEEN_TEXT),
      true,
      "TEST 1 RO mount observes the executed open bytes within 5 s",
    );
    proof("TEST 1 executed open observed exact by the RO container");
  });

  it("TEST 2 pending create stays invisible; the RO container still cannot write", async () => {
    await openExecutedSession();
    const missing = guestRead("src/beta.ts");
    assert.notEqual(missing.status, 0, "TEST 2 pending create is absent inside the guest before save");
    assert.equal(existsSync(join(LEAF, "src", "beta.ts")), false, "pending create is absent on the host leaf");
    const attempt = docker("exec", CONTAINER, "sh", "-c", "echo evil > /workspace/evil.txt");
    assert.notEqual(attempt.status, 0, "TEST 2 RO denial: guest write must fail");
    assert.equal(existsSync(join(LEAF, "evil.txt")), false, "no guest bytes land on the host leaf");
    proof("TEST 2 pending create invisible; RO denial holds beside executed documents");
  });
});
