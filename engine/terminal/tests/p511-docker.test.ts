// P5.11 REAL Docker integration — Safe IPC host end-to-end against the
// actual local Docker daemon:
//
//   synthetic lesson (canonical compile) -> TerminalHost.openSession ->
//   handleRunOperation/handleStopProcess/handleResetRuntime/handleGetSnapshot
//   (identifier-only) -> DockerSandboxProvider -> live session container ->
//   guest supervisor groups -> SessionJournal (authoritative seq) -> receipts,
//   snapshots, completions.
//
// Proves the renderer boundary holds on the REAL path: real guest output and
// true exits flow back through identifier-only receipts, while hostile
// renderer payloads (command/env/cwd/image/mount fields) are rejected with
// zero owned containers. Every resource is prefixed cf-p511- (installation
// label cf-p511-installation) under the repository's ignored temp root.
// Tests are skipped (never silently passed) only when the daemon or the
// supervisor runtime image is unavailable — the P5.11 gate REQUIRES a real
// run and fails otherwise. Every test's finally removes only its own owned
// containers (never a global prune).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSandboxProvider } from "../src/providers/docker.ts";
import { TerminalHost, type SafeSessionDescriptor } from "../src/providers/terminal-host.ts";
import type { StartReceipt } from "../src/providers/execution-provider.ts";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P5.11");
const WS_ROOT = join(TEST_ROOT, "workspaces-root");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5.11";
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_BASE_DIGEST = PINNED_BASE.split("@")[1]!;
const INSTALLATION_ID = "cf-p511-installation";
const INSTALL_LABEL = "com.course-factory.installation";
const LESSON_ID = "C01-L511";

function resolveDockerExe(): string {
  const configured = process.env.CF_P511_DOCKER_EXE ?? process.env.CF_P54_DOCKER_EXE;
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
  const result = spawnSync(DOCKER_EXE, argv, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function containerIdsForInstallation(): string[] {
  const r = docker("ps", "-aq", "--filter", `label=${INSTALL_LABEL}=${INSTALLATION_ID}`);
  return (r.stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
}

function daemonOk(): boolean {
  const r = docker("version", "--format", "{{.Server.Version}}");
  return r.status === 0 && r.stdout.trim().length > 0;
}

function resolveRuntimeImageRef(): string | null {
  const configured = process.env.CF_P511_RUNTIME_IMAGE;
  if (configured !== undefined && /^sha256:[0-9a-f]{64}$/.test(configured)) return configured;
  const r = docker("image", "inspect", RUNTIME_IMAGE_TAG, "--format", "{{.Id}}");
  if (r.status === 0) {
    const id = r.stdout.trim();
    if (/^sha256:[0-9a-f]{64}$/.test(id)) return id;
  }
  return null;
}

const DAEMON_OK = daemonOk();
const RUNTIME_IMAGE_REF = resolveRuntimeImageRef();
const AVAILABLE = DAEMON_OK && RUNTIME_IMAGE_REF !== null;

function ensureConfigContext(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ls = docker("--config", CONFIG_DIR, "context", "ls");
  if ((ls.stdout ?? "").includes("desktop-linux")) return;
  const created = docker(
    "--config", CONFIG_DIR, "context", "create",
    "desktop-linux",
    "--docker", "host=npipe:////./pipe/dockerDesktopLinuxEngine",
    "--description", "course-factory p5.11 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

// -- synthetic lessons (canonical compile; never hand-authored IR) --------------

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: never) => CompiledLesson;
};
const { parseLessonData } = await import("@course-factory/shared-types/validate");

function foregroundLesson(): unknown {
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: LESSON_ID,
    title: "P5.11 synthetic safe-IPC lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Safe IPC from identifiers to real guest execution"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p511"],
    metadata: { synthetic_fixture: true, phase: "P5.11" },
    scenes: [
      {
        scene_id: `${LESSON_ID}-S001`,
        type: "code_demo",
        title: "Foreground through the host",
        duration: 120,
        visual: { kind: "terminal", description: "synthetic" },
        beats: [
          {
            beat_id: `${LESSON_ID}-S001-B001`,
            kind: "action",
            action: {
              type: "terminal_run",
              command: "node -e \"console.log('P511_OK')\"",
              mode: "foreground",
              timeout_seconds: 60,
              expected_exit_code: 0,
            },
          },
          {
            beat_id: `${LESSON_ID}-S001-B002`,
            kind: "action",
            action: {
              type: "terminal_run",
              command: "node -e \"process.exit(7)\"",
              mode: "foreground",
              timeout_seconds: 60,
              expected_exit_code: 7,
            },
          },
        ],
      },
    ],
  };
}

function backgroundLesson(processId: string): unknown {
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: LESSON_ID,
    title: "P5.11 synthetic background lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Background lifetimes through the safe host"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p511", "background"],
    metadata: { synthetic_fixture: true, phase: "P5.11" },
    scenes: [
      {
        scene_id: `${LESSON_ID}-S002`,
        type: "code_demo",
        title: "Background through the host",
        duration: 120,
        visual: { kind: "terminal", description: "synthetic" },
        beats: [
          {
            beat_id: `${LESSON_ID}-S002-B001`,
            kind: "action",
            action: {
              type: "terminal_run",
              command: "node -e \"console.log('P511_BG_READY'); setInterval(()=>console.log('P511_BG_TICK'),300)\"",
              mode: "background",
              process_id: processId,
            },
          },
        ],
      },
    ],
  };
}

function compileSource(source: unknown): CompiledLesson {
  const parsed = parseLessonData(source);
  if (!parsed.ok || parsed.lesson === undefined) {
    throw new Error(`synthetic lesson failed source validation: ${JSON.stringify(parsed.issues)}`);
  }
  return compileModule.compileLesson(parsed.lesson as never);
}

function makeHost(): TerminalHost {
  return new TerminalHost({
    workspaceRoot: WS_ROOT,
    imageIdentity: {
      pinned_reference: PINNED_BASE,
      digest: PINNED_BASE_DIGEST,
      platform: "linux/amd64",
      pull_policy: "never",
      source: "base-image.lock.json",
    },
    hostEnv: {},
    forwardEnvNames: [],
    createProvider: () =>
      new DockerSandboxProvider({
        cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR, clientEnv: {} },
        imageReference: RUNTIME_IMAGE_REF!,
        installationId: INSTALLATION_ID,
      }),
  });
}

function uid(prefix: string): string {
  return `${prefix}-p511-${randomBytes(4).toString("hex")}`;
}

function unwrap<T>(outcome: { ok: true; value: T } | { ok: false; rejection: { code: string; message: string } }, label: string): T {
  if (!outcome.ok) throw new Error(`${label} rejected: ${(outcome as { ok: false; rejection: { code: string; message: string } }).rejection.code} ${(outcome as { ok: false; rejection: { message: string } }).rejection.message}`);
  return (outcome as { ok: true; value: T }).value;
}

async function waitForSnapshotText(host: TerminalHost, sessionId: string, marker: RegExp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = host.handleGetSnapshot({ session_id: sessionId, after_seq: 0 });
    if (page.ok && marker.test(JSON.stringify(page.value))) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for snapshot marker ${marker}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

// -----------------------------------------------------------------------------

describe("P5.11 real Docker safe-IPC integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(WS_ROOT, { recursive: true });
    ensureConfigContext();
  });

  after(() => {
    for (const id of containerIdsForInstallation()) docker("rm", "--force", id);
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("foreground success through the safe host: real guest output, true exit 0, PASS result", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    const opened = unwrap(host.openSession(compileSource(foregroundLesson()), { session_id: sessionId, executionAuthorized: true }), "openSession");
    assert.equal(opened.session_id, sessionId);
    try {
      const receipt = unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B001`,
        request_id: "req-p511-fg-1",
      }), "runOperation") as StartReceipt;
      assert.equal(receipt.operation_id, `${LESSON_ID}-S001-B001`);
      assert.equal(receipt.process_id, null);
      assert.ok(receipt.result !== undefined, "foreground receipts carry the final DTO");
      assert.equal(receipt.result.exit_code, 0);
      assert.equal(receipt.result.reason, null);
      await waitForSnapshotText(host, sessionId, /P511_OK/, 60_000);
    } finally {
      await host.closeSession(sessionId, "lesson_end");
    }
  });

  it("sequential foregrounds through one host session: actual 7 with expected 7 PASSes", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    unwrap(host.openSession(compileSource(foregroundLesson()), { session_id: sessionId, executionAuthorized: true }), "openSession");
    try {
      const first = unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B001`,
        request_id: "req-p511-seq-1",
      }), "first run") as StartReceipt;
      assert.equal(first.result?.exit_code, 0);
      const second = unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B002`,
        request_id: "req-p511-seq-2",
      }), "second run") as StartReceipt;
      assert.equal(second.result?.exit_code, 7);
      assert.equal(second.result?.expected_exit_code, 7);
      assert.equal(second.result?.reason, null);
    } finally {
      await host.closeSession(sessionId, "lesson_end");
    }
  });

  it("background start vs lifetime through the host: result-free receipt, live output, operator stop", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    const processId = `p511-bg-${randomBytes(3).toString("hex")}`;
    const ir = compileSource(backgroundLesson(processId));
    unwrap(host.openSession(ir, { session_id: sessionId, executionAuthorized: true }), "openSession");
    try {
      const receipt = unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S002-B001`,
        request_id: "req-p511-bg-1",
      }), "background run") as StartReceipt;
      assert.equal(receipt.process_id, processId);
      assert.equal(receipt.result, undefined, "background receipts stay result-free (lifetime is event-driven)");
      await waitForSnapshotText(host, sessionId, /P511_BG_READY/, 60_000);
      const stopped = unwrap(await host.handleStopProcess({
        session_id: sessionId,
        process_id: processId,
        request_id: "req-p511-bg-stop",
      }), "operator stop");
      assert.equal(stopped.outcome, "stopped");
      // The session stays alive after a confirmed stop (bounded replay works).
      const page = host.handleGetSnapshot({ session_id: sessionId, after_seq: 0 });
      assert.equal(page.ok, true);
    } finally {
      await host.closeSession(sessionId, "lesson_end");
    }
  });

  it("hostile renderer payloads never reach Docker: INVALID_REQUEST with zero owned containers", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    unwrap(host.openSession(compileSource(foregroundLesson()), { session_id: sessionId, executionAuthorized: true }), "openSession");
    try {
      for (const [index, extra] of [
        { command: "node -e \"process.exit(0)\"" },
        { env: { EVIL: "1" } },
        { cwd: "/etc" },
        { image: "ubuntu:latest" },
        { mount: "/:/host" },
        { shell: true },
        { stdin: "evil" },
      ].entries()) {
        const hostile = {
          session_id: sessionId,
          operation_id: `${LESSON_ID}-S001-B001`,
          request_id: `req-p511-hostile-${index}`,
          ...extra,
        };
        const result = await host.handleRunOperation(hostile);
        assert.equal(result.ok, false, `hostile payload ${index} must be rejected`);
        assert.equal((result as { ok: false; rejection: { code: string } }).rejection.code, "INVALID_REQUEST");
      }
      assert.deepEqual(containerIdsForInstallation(), [], "zero owned containers after every hostile rejection");
    } finally {
      await host.closeSession(sessionId, "lesson_end");
    }
  });

  it("inspection-only sessions cannot execute through the host (P4 fixtures stay inert)", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    unwrap(host.openSession(compileSource(foregroundLesson()), { session_id: sessionId, executionAuthorized: false }), "openSession");
    try {
      const result = await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B001`,
        request_id: "req-p511-insp",
      });
      assert.equal(result.ok, false);
      assert.equal((result as { ok: false; rejection: { code: string } }).rejection.code, "NOT_AUTHORIZED");
      assert.deepEqual(containerIdsForInstallation(), [], "zero owned containers for inspection-only runs");
    } finally {
      await host.closeSession(sessionId, "lesson_end");
    }
  });

  it("reset through the host bumps the generation and reruns definitions", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    const firstGen = unwrap(host.openSession(compileSource(foregroundLesson()), { session_id: sessionId, executionAuthorized: true }), "openSession") as SafeSessionDescriptor;
    assert.equal(firstGen.generation, 1);
    try {
      const first = unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B001`,
        request_id: "req-p511-rst-1",
      }), "first run") as StartReceipt;
      assert.equal(first.result?.exit_code, 0);
      const reset = unwrap(await host.handleResetRuntime({ session_id: sessionId, request_id: "req-p511-rst" }), "reset") as SafeSessionDescriptor;
      assert.equal(reset.generation, 2);
      const rerun = unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B001`,
        request_id: "req-p511-rst-2",
      }), "rerun after reset") as StartReceipt;
      assert.equal(rerun.result?.exit_code, 0);
      await waitForSnapshotText(host, sessionId, /P511_OK/, 60_000);
    } finally {
      await host.closeSession(sessionId, "lesson_end");
    }
  });

  it("host responses carry no private host paths, container IDs or PIDs", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    unwrap(host.openSession(compileSource(foregroundLesson()), { session_id: sessionId, executionAuthorized: true }), "openSession");
    try {
      const receipt = unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B001`,
        request_id: "req-p511-priv",
      }), "run") as StartReceipt;
      const page = unwrap(host.handleGetSnapshot({ session_id: sessionId, after_seq: 0 }), "snapshot");
      const serialized = JSON.stringify({ receipt, page });
      assert.doesNotMatch(serialized, /[A-Za-z]:\\/);
      assert.doesNotMatch(serialized, /containerId/);
      assert.doesNotMatch(serialized, /docker\.sock/);
      assert.doesNotMatch(serialized, /\bpgid\b/i);
    } finally {
      await host.closeSession(sessionId, "lesson_end");
    }
  });

  it("cleanup: zero cf-p511-owned containers remain", () => {
    assert.deepEqual(containerIdsForInstallation(), [], "no owned survivors after the integration suite");
  });
});
