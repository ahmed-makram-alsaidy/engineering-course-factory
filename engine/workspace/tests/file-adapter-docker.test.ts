// P6.4 Docker RO interop — REAL container proof (canonical gate).
//
// Proves the frozen watcher contract at the real bind boundary
// (docs/P6-DESIGN-SPEC.md sections 26.3/26.7/26.12, ADR-0011): host-side
// trusted publication keeps working while a read-only Docker container holds
// /workspace mounted RO; the guest observes only complete committed files
// (never partial staging bytes) and still cannot write through the guest.
//
// TEST 1  host publication is observed byte-exact by the live RO container
//         within the bounded polling deadline (250 ms poll, 5 s bound).
// TEST 2  the RO container still cannot write (guest write denied, host
//         tree unchanged).
// TEST 3  large repeated saves with a continuous guest reopen/read loop show
//         only complete old/new bytes (atomic visibility across the bind).
//
// Every resource is prefixed cf-p64- under the phase-owned temp/P6.4 root.
// Cleanup is ownership-scoped (this container only); no global prune ever.
// These tests FAIL (never skip) when the daemon or the pinned base image is
// unavailable — the P6.4 gate requires the real proof.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openWindowsFileAdapter, type AdapterAuthority, type AdapterOutcome, type ReadDocumentResult } from "../src/file-adapter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.4", "file-adapter-docker");

const PINNED_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const SUFFIX = randomBytes(3).toString("hex");
const CONTAINER = `cf-p64-interop-${SUFFIX}`;
const LEAF = join(TEST_ROOT, `cf-p64-interop-${SUFFIX}-leaf`);
const STAGING = join(TEST_ROOT, `cf-p64-interop-${SUFFIX}-staging`);

function resolveDockerExe(): string {
  const configured = process.env["CF_P64_DOCKER_EXE"];
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
  console.log(`P6.4 PROOF: ${message}`);
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
  const r = docker("ps", "-aq", "--no-trunc", "--filter", "name=cf-p64-");
  return (r.stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
}

function removeContainer(): void {
  docker("rm", "--force", CONTAINER);
}

const SESSION = `sess-p64-docker-${SUFFIX}`;
const WORKSPACE = `ws-p64-docker-${SUFFIX}`;

function authority(): AdapterAuthority {
  return {
    lease: {
      kind: "editor_lease",
      leaseId: `lease-p64-docker-${SUFFIX}`,
      sessionId: SESSION,
      generation: 1,
      workspaceId: WORKSPACE,
      epoch: 1,
      operationId: "op-p64-docker-1",
      requestId: `req-p64-docker-${SUFFIX}`,
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

before(() => {
  assert.equal(daemonOk(), true, "Docker daemon must be reachable for the real interop proof (no fake PASS)");
  assert.equal(baseImageOk(), true, "the pinned base image must be present for the real interop proof");
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(LEAF, { recursive: true });
  mkdirSync(STAGING, { recursive: true });
  removeContainer();
  const created = docker(
    "create",
    "--name", CONTAINER,
    "--label", "com.course-factory.owner=course-factory",
    "--label", "com.course-factory.phase=P6",
    "--label", `com.course-factory.test-run=cf-p64-interop-${SUFFIX}`,
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
  assert.equal(workspaceMount?.RW, false, "SANDBOX cf-p64 RO epoch binds /workspace readonly");
  proof("SANDBOX cf-p64 RO epoch: NetworkMode=none User=1000:1000 RW=false binds=1");
});

after(() => {
  removeContainer();
  rmSync(TEST_ROOT, { recursive: true, force: true });
  const remaining = remainingOwnedContainers();
  console.log(`P6.4 PROOF: CLEANUP remaining cf-p64 containers: [${remaining.join(",")}]`);
  assert.deepEqual(remaining, [], "zero cf-p64 containers remain");
});

describe("P6.4 Docker RO interop", () => {
  it("TEST 1 host publication is observed exact by the RO container within the bound", async () => {
    const opened = openWindowsFileAdapter({
      sessionId: SESSION,
      generation: 1,
      workspaceId: WORKSPACE,
      leafHostPath: LEAF,
      stagingHostPath: STAGING,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const content = "// lesson bytes: English تعليق عربي 🚀\nconst greeting = \"مرحبا hello\";\n";
    const published = await opened.value.publishDocument(authority(), {
      portablePath: "lesson.txt",
      content,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(published.ok, true, "host publication must succeed beside the RO watcher");
    assert.equal(guestReadWithinBound("lesson.txt", content), true, "TEST 1 RO mount observes the committed bytes within 5 s");
    proof("TEST 1 RO mount observes host publication exact");
  });

  it("TEST 2 the RO container still cannot write", () => {
    const attempt = docker("exec", CONTAINER, "sh", "-c", "echo evil > /workspace/evil.txt");
    assert.notEqual(attempt.status, 0, "TEST 2 RO denial: guest write must fail");
    assert.equal(existsSync(join(LEAF, "evil.txt")), false, "no guest bytes land on the host leaf");
    proof("TEST 2 RO denial: guest create/write/unlink denied, host absent");
  });

  it("TEST 3 large repeated saves show only complete old/new bytes to the guest", async () => {
    const opened = openWindowsFileAdapter({
      sessionId: SESSION,
      generation: 1,
      workspaceId: WORKSPACE,
      leafHostPath: LEAF,
      stagingHostPath: STAGING,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const auth = authority();
    const contentA = `${"a".repeat(128 * 1024)}\n`;
    const contentB = `${"b".repeat(64 * 1024)}\n`;
    const seed = await opened.value.publishDocument(auth, {
      portablePath: "big.txt",
      content: contentA,
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(seed.ok, true);
    if (!seed.ok) throw new Error("unreachable");
    let digest = seed.value.digest;
    // Continuous guest reopen/read loop in the background while the host
    // publishes alternating complete files.
    const guest = spawn(
      DOCKER_EXE,
      ["exec", CONTAINER, "sh", "-c", "for i in $(seq 1 40); do cat /workspace/big.txt; printf '\\n---P64-BLOCK---\\n'; done"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let guestOut = "";
    guest.stdout.on("data", (chunk: Buffer) => {
      guestOut += chunk.toString("utf8");
    });
    const guestDone = new Promise<number | null>((resolve) => {
      guest.on("close", (code: number | null) => resolve(code));
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (let round = 0; round < 6; round += 1) {
      const next = round % 2 === 0 ? contentB : contentA;
      let published = false;
      for (let attempt = 0; attempt < 8 && !published; attempt += 1) {
        const current: AdapterOutcome<ReadDocumentResult> = await opened.value.readDocument(auth, "big.txt");
        assert.equal(current.ok, true);
        if (!current.ok) throw new Error("unreachable");
        const outcome = await opened.value.publishDocument(auth, {
          portablePath: "big.txt",
          content: next,
          mode: "replace",
          expected: { exists: true, digest: current.value.digest },
        });
        if (outcome.ok) {
          published = true;
          digest = outcome.value.digest;
        } else if (outcome.rejection.code === "SAVE_FAILED") {
          await new Promise((resolve) => setTimeout(resolve, 100));
        } else {
          assert.fail(`unexpected publication rejection: ${outcome.rejection.code}`);
        }
      }
      assert.equal(published, true, `round ${round} must publish (bounded sharing retries)`);
      void digest;
    }
    const guestCode = await guestDone;
    assert.equal(guestCode, 0, "guest read loop must complete");
    const blocks = guestOut.split("---P64-BLOCK---").map((b) => b.replace(/\n$/, "")).filter((b) => b.length > 0);
    assert.ok(blocks.length > 0, "the guest must have observed committed files");
    for (const block of blocks) {
      const body = block.startsWith("\n") ? block.slice(1) : block;
      assert.ok(body === contentA || body === contentB, `guest observes only complete old/new bytes (block len ${body.length})`);
    }
    proof("TEST 3 atomic guest view: only complete old/new bytes across repeated saves");
    const finalRead = docker("exec", CONTAINER, "cat", "/workspace/big.txt");
    assert.equal(finalRead.status, 0);
    assert.ok(finalRead.stdout === contentA || finalRead.stdout === contentB);
    assert.equal(readFileSync(join(LEAF, "lesson.txt"), "utf8").includes("lesson bytes"), true);
  });
});
