// P5.7 REAL Docker integration — canonical foreground completion semantics
// over the real guest supervisor:
//
//   canonical admission (compiled synthetic fixture -> catalog -> session ->
//   one foreground execution grant) -> trusted workspace leaf ->
//   DockerSandboxProvider -> live session container -> guest supervisor
//   process group -> provider events -> SessionJournal.
//
// Proven against the real daemon (Engine 29.7.2, linux/amd64):
//   - true actual/expected exit matrix (actual 0/expected 0 PASS; actual 7 /
//     expected 7 PASS; actual 7 / expected 0 FAIL with the TRUE code) in the
//     final result AND the journal;
//   - the trusted host-owned deadline (TIMEOUT, bounded group termination,
//     no invented exit code, all descendants gone, teardown);
//   - the bounded drain window (all output emitted before termination is
//     journaled before the terminal event and the final result);
//   - the descendant policy (parent exits, child/grandchild alive ->
//     FAIL/UNEXPECTED_DESCENDANTS, full teardown, no leak);
//   - OUTPUT_LIMIT (managed termination, no runaway memory, one result);
//   - foreground cancellation (SKIPPED/CANCELLED, trusted identity only);
//   - session close during an active foreground run (no final result, no
//     late output, stale ownership rejected).
//
// Every resource is prefixed cf-p57- (installation label cf-p57-installation)
// under the repository's ignored temp root. Tests are skipped (never silently
// passed) only when the daemon or the supervisor runtime image is unavailable
// — the P5.7 gate REQUIRES a real run and fails otherwise. Every test's
// finally/after removes only its own owned containers (never a global prune).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSandboxProvider, type DockerProviderConfig } from "../src/providers/docker.ts";
import type { AdmittedSession, ProviderEvent, ProviderSession } from "../src/providers/execution-provider.ts";
import type { ExecutionGrant } from "../src/admission.ts";
import { createAdmissionService, type AdmissionService, type AdmissionSession } from "../src/admission.ts";
import type { RuntimeSessionIdentity, RuntimeEvent } from "../src/protocol.ts";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { SessionJournal } from "../src/journal.ts";
import {
  resolveConfiguredWorkspaceRoot,
  createSessionWorkspace,
  resolveGrantWorkspace,
  buildWorkspaceMountPlan,
  resolveExecutionContext,
  type ResolvedWorkspaceRoot,
} from "../src/workspace.ts";
import { resolveEnvironmentPlan } from "../src/environment.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P5.7");
const WS_ROOT = join(TEST_ROOT, "workspaces-root");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5.7";
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_BASE_DIGEST = PINNED_BASE.split("@")[1]!;
const INSTALLATION_ID = "cf-p57-installation";
const INSTALL_LABEL = "com.course-factory.installation";
const LESSON_ID = "C01-L057";

function resolveDockerExe(): string {
  const configured = process.env.CF_P57_DOCKER_EXE ?? process.env.CF_P56_DOCKER_EXE ?? process.env.CF_P55_DOCKER_EXE ?? process.env.CF_P54_DOCKER_EXE;
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
  const configured = process.env.CF_P57_RUNTIME_IMAGE ?? process.env.CF_P56_RUNTIME_IMAGE ?? process.env.CF_P55_RUNTIME_IMAGE ?? process.env.CF_P54_RUNTIME_IMAGE;
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
    "--description", "course-factory p5.7 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

// -- synthetic guest scripts (seeded into the session leaf; guest-only) --------

const SCRIPTS: Record<string, string> = {
  "drain_tail.js": [
    "const fs = require('node:fs');",
    "fs.writeSync(1, 'P57_OUT_HEAD\\n');",
    "fs.writeSync(2, 'P57_ERR_HEAD\\n');",
    "setTimeout(() => {",
    "  fs.writeSync(1, 'P57_OUT_TAIL\\n');",
    "  fs.writeSync(2, 'P57_ERR_TAIL\\n');",
    "  process.exit(0);",
    "}, 300);",
  ].join("\n"),
  "parent.js": [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "fs.writeSync(1, 'P57_PARENT_ALIVE\\n');",
    "const child = spawn('node', ['child.js'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "setTimeout(() => { fs.writeSync(1, 'P57_PARENT_EXIT\\n'); process.exit(0); }, 200);",
  ].join("\n"),
  "child.js": [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "fs.writeSync(1, 'P57_CHILD_ALIVE\\n');",
    "const grand = spawn('node', ['grandchild.js'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    "setTimeout(() => {}, 25000);",
  ].join("\n"),
  "grandchild.js": [
    "const fs = require('node:fs');",
    "fs.writeSync(1, 'P57_GRANDCHILD_ALIVE\\n');",
    "setTimeout(() => {}, 25000);",
  ].join("\n"),
  "flood.js": [
    "const fs = require('node:fs');",
    "const chunk = Buffer.alloc(64 * 1024, 0x61).toString('ascii') + '\\n';",
    "let total = 0;",
    "const t = setInterval(() => {",
    "  fs.writeSync(1, chunk);",
    "  total += chunk.length;",
    "  if (total > 1024 * 1024) { clearInterval(t); }",
    "}, 20);",
  ].join("\n"),
  "sleep_long.js": [
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
};

// -- canonical admission -> grants ----------------------------------------------

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: never) => CompiledLesson;
};
const { parseLessonData } = await import("@course-factory/shared-types/validate");

interface OpSpec {
  readonly op_id: string;
  readonly command: string;
  readonly timeout_seconds?: number;
  readonly expected_exit_code?: number;
}

function lessonSource(ops: readonly OpSpec[]): unknown {
  const beats = ops.map((op, index) => {
    const action: Record<string, unknown> = {
      type: "terminal_run",
      command: op.command,
      mode: "foreground",
      timeout_seconds: op.timeout_seconds ?? 30,
      expected_exit_code: op.expected_exit_code ?? 0,
    };
    if (index !== 0) action.cwd = "scripts";
    return {
      beat_id: op.op_id,
      kind: "action",
      action,
    };
  });
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: LESSON_ID,
    title: "P5.7 synthetic foreground lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Canonical foreground completion semantics inside the P5 sandbox"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p57", "foreground"],
    metadata: { synthetic_fixture: true, phase: "P5.7" },
    scenes: [
      {
        scene_id: `${LESSON_ID}-S001`,
        type: "code_demo",
        title: "Supervisor-owned foreground command",
        duration: 120,
        visual: { kind: "terminal", description: "synthetic" },
        beats,
      },
    ],
  };
}

function makeProvider(): DockerSandboxProvider {
  return new DockerSandboxProvider({
    cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR, clientEnv: {} },
    imageReference: RUNTIME_IMAGE_REF!,
    installationId: INSTALLATION_ID,
  });
}

interface P57Fixture {
  readonly provider: DockerSandboxProvider;
  readonly session: ProviderSession;
  readonly journal: SessionJournal;
  readonly journalSeen: RuntimeEvent[];
  readonly journalRejections: Array<{ code: string; message: string }>;
  readonly grant: ExecutionGrant;
  readonly identity: RuntimeSessionIdentity;
  readonly service: AdmissionService;
  readonly admissionSession: AdmissionSession;
  readonly leafPath: string;
  waitForJournalEvent(type: RuntimeEvent["type"], predicate: ((event: RuntimeEvent) => boolean) | null, timeoutMs: number): Promise<RuntimeEvent>;
  dispose(): Promise<void>;
}

async function openSessionFixture(args: {
  op: OpSpec;
  sessionId?: string;
}): Promise<P57Fixture> {
  const ops = [args.op];
  const sessionId = args.sessionId ?? `sess-p57-${randomBytes(4).toString("hex")}`;
  const raw = lessonSource(ops);
  const parsed = parseLessonData(raw);
  if (!parsed.ok || parsed.lesson === undefined) {
    throw new Error(`synthetic lesson failed source validation: ${JSON.stringify(parsed.issues)}`);
  }
  const ir = compileModule.compileLesson(parsed.lesson as never);
  const service = createAdmissionService();
  const catalogResult = service.installLesson(ir);
  if (!catalogResult.ok) throw new Error(`catalog rejected fixture: ${catalogResult.rejection.message}`);
  const opened = service.openSession(catalogResult.value, { session_id: sessionId, executionAuthorized: true });
  if (!opened.ok) throw new Error(`session open failed: ${opened.rejection.message}`);
  const identity = opened.value.identity;

  const admitted = service.admitRunOperation(identity, {
    session_id: sessionId,
    operation_id: args.op.op_id,
    request_id: `req-${args.op.op_id}`,
  });
  if (!admitted.ok) throw new Error(`admission rejected ${args.op.op_id}: ${admitted.rejection.message}`);
  if (admitted.value.kind !== "execution_grant") throw new Error(`expected an execution grant for ${args.op.op_id}`);
  const grant: ExecutionGrant = admitted.value;

  const root = resolveConfiguredWorkspaceRoot(WS_ROOT);
  if (!root.ok) throw new Error("workspace root resolution failed");
  const leaf = createSessionWorkspace(root.value, {
    lesson_id: LESSON_ID,
    session_id: sessionId,
    generation: identity.generation,
  });
  if (!leaf.ok) throw new Error(`session workspace failed: ${leaf.error.message}`);
  for (const [name, content] of Object.entries(SCRIPTS)) {
    writeFileSync(join(leaf.value.host_root, name), content, "utf8");
  }

  const paths = resolveGrantWorkspace(leaf.value, grant);
  if (!paths.ok) throw new Error(`grant workspace failed: ${paths.error.message}`);
  const mountPlan = buildWorkspaceMountPlan(paths.value);
  if (!mountPlan.ok) throw new Error(`mount plan failed: ${mountPlan.error.message}`);
  const env = resolveEnvironmentPlan(Object.freeze({ TZ: "UTC" }), ["TZ"]);
  if (!env.ok) throw new Error("environment plan failed");
  const context = resolveExecutionContext({
    workspace_paths: paths.value,
    mount_plan: mountPlan.value,
    environment_plan: env.value,
    image_identity: {
      pinned_reference: PINNED_BASE,
      digest: PINNED_BASE_DIGEST,
      platform: "linux/amd64",
      pull_policy: "never",
      source: "base-image.lock.json",
    },
  });
  if (!context.ok) throw new Error(`execution context failed: ${context.error.message}`);

  const provider = makeProvider();
  const admittedSession: AdmittedSession = {
    session_id: sessionId,
    generation: identity.generation,
    resolvedContext: context.value,
    grants: [grant],
  };
  const session = await provider.prepare(admittedSession);

  const journal = new SessionJournal({
    session_id: sessionId,
    generation: identity.generation,
  });
  const journalSeen: RuntimeEvent[] = [];
  journal.subscribe((event) => journalSeen.push(event));
  const journalRejections: Array<{ code: string; message: string }> = [];
  const providerSubscription = provider.events(session, (event: ProviderEvent) => {
    const result = journal.ingest(event);
    if (!result.ok) journalRejections.push({ code: result.code, message: result.message });
  });

  const fixture: P57Fixture = {
    provider,
    session,
    journal,
    journalSeen,
    journalRejections,
    grant,
    identity,
    service,
    admissionSession: opened.value,
    leafPath: leaf.value.host_root,
    async waitForJournalEvent(type, predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = [...journalSeen].reverse().find((event) => {
          if (event.type !== type) return false;
          return predicate === null || predicate(event);
        });
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    },
    async dispose() {
      await provider.close(session, "lesson_end");
      providerSubscription.dispose();
      try { rmSync(leaf.value.host_root, { recursive: true, force: true }); } catch { /* explicit below */ }
    },
  };
  return fixture;
}

/** Common end-of-test journal coherence assertions. */
function assertJournalCoherent(fx: P57Fixture): void {
  assert.deepEqual(fx.journalRejections, [], "the journal accepted every provider event");
  const seqs = fx.journalSeen.map((e) => e.seq);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), "journal seq is strictly consecutive");
  const stamps = fx.journalSeen.map((e) => e.monotonic_ms);
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), "monotonic_ms never regresses");
  const completions = fx.journalSeen.filter((e) => e.type === "operation.completed");
  assert.equal(completions.length, 1, "exactly one final result");
  assert.equal(fx.journalSeen[fx.journalSeen.length - 1]!.type, "runtime.closed", "runtime.closed closes the trace");
  // Foreground canonical identity: every operation event carries process_id null.
  for (const event of fx.journalSeen.filter((e) => !e.type.startsWith("runtime."))) {
    assert.equal(event.process_id, null, "foreground events use the canonical null process identity");
  }
}

/**
 * Await the session's closing trace (failure teardowns emit runtime.failed
 * -> runtime.closed asynchronously) BEFORE unsubscribing the journal, then
 * dispose. Teardown tests must use this so the closing trace is journaled.
 */
async function disposeAfterClosed(fx: P57Fixture): Promise<void> {
  try {
    await fx.waitForJournalEvent("runtime.closed", null, 20_000);
  } finally {
    await fx.dispose();
  }
}

function outputEvents(fx: P57Fixture): Array<{ stream: string; text: string; stream_offset: number }> {
  return fx.journalSeen
    .filter((e) => e.type === "process.output")
    .map((e) => e.payload as { stream: string; text: string; stream_offset: number });
}

function transcript(fx: P57Fixture, stream: "stdout" | "stderr"): string {
  return outputEvents(fx).filter((o) => o.stream === stream).map((o) => o.text).join("");
}

// -----------------------------------------------------------------------------

describe("P5.7 real Docker foreground integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(WS_ROOT, { recursive: true });
    ensureConfigContext();
  });

  after(() => {
    for (const id of containerIdsForInstallation()) docker("rm", "--force", id);
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("actual 0 / expected 0 -> PASS: true values in the final result AND the journal; stdout/stderr preserved", async () => {
    const fx = await openSessionFixture({
      op: { op_id: `${LESSON_ID}-S001-B001`, command: "node drain_tail.js" },
    });
    try {
      const receipt = await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const result = receipt.result;
      assert.ok(result !== undefined, "the foreground receipt carries the canonical final result");
      assert.equal(result.exit_code, 0);
      assert.equal(result.expected_exit_code, 0);
      assert.equal(result.reason, null);
      assert.equal(result.state, "EXITED");
      assert.equal(result.forced, false);
      assert.equal(result.cleanup_status, "confirmed");
      assert.ok(result.stdout_ref !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result.stdout_ref));
      assert.ok(result.stderr_ref !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result.stderr_ref));
      assert.ok(result.output_bytes > 0);
      assert.equal(result.truncated, false);
      await fx.dispose();

      assertJournalCoherent(fx);
      const completed = fx.journalSeen.find((e) => e.type === "operation.completed")!;
      assert.deepEqual(completed.payload, { outcome: "PASS", reason: null, exit_code: 0, forced: false });
      const exited = fx.journalSeen.find((e) => e.type === "process.exited");
      assert.ok(exited !== undefined);
      assert.equal((exited.payload as { exit_code: number }).exit_code, 0, "the true exit code is journaled");
      assert.equal(transcript(fx, "stdout").includes("P57_OUT_HEAD"), true);
      assert.equal(transcript(fx, "stderr").includes("P57_ERR_HEAD"), true);
    } finally {
      try { await fx.dispose(); } catch { /* already disposed */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("actual 7 / expected 7 -> PASS with the true code (never a hard-coded exit 0)", async () => {
    const fx = await openSessionFixture({
      op: { op_id: `${LESSON_ID}-S001-B001`, command: "node -e \"process.exit(7)\"", expected_exit_code: 7 },
    });
    try {
      const receipt = await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const result = receipt.result!;
      assert.equal(result.exit_code, 7);
      assert.equal(result.expected_exit_code, 7);
      assert.equal(result.reason, null);
      assert.equal(result.state, "EXITED");
      assert.equal(result.forced, false);
      await fx.dispose();
      assertJournalCoherent(fx);
      const completed = fx.journalSeen.find((e) => e.type === "operation.completed")!;
      assert.deepEqual(completed.payload, { outcome: "PASS", reason: null, exit_code: 7, forced: false });
      const exited = fx.journalSeen.find((e) => e.type === "process.exited");
      assert.ok(exited !== undefined);
      assert.equal((exited.payload as { exit_code: number }).exit_code, 7);
    } finally {
      try { await fx.dispose(); } catch { /* already disposed */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("actual 7 / expected 0 -> FAIL/EXIT_CODE_MISMATCH with the true code in result and journal", async () => {
    const fx = await openSessionFixture({
      op: { op_id: `${LESSON_ID}-S001-B001`, command: "node -e \"process.exit(7)\"" },
    });
    try {
      const receipt = await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const result = receipt.result!;
      assert.equal(result.exit_code, 7);
      assert.equal(result.expected_exit_code, 0);
      assert.equal(result.reason, "EXIT_CODE_MISMATCH");
      await disposeAfterClosed(fx);
      assertJournalCoherent(fx);
      const completed = fx.journalSeen.find((e) => e.type === "operation.completed")!;
      assert.deepEqual(completed.payload, { outcome: "FAIL", reason: "EXIT_CODE_MISMATCH", exit_code: 7, forced: false });
      // Canonical failure distinction: the true lesson exit — never a
      // transport/supervisor failure code.
      assert.equal(fx.journalSeen.some((e) => e.type === "runtime.failed" && (e.payload as { code: string }).code === "EXIT_CODE_MISMATCH"), true);
    } finally {
      try { await fx.dispose(); } catch { /* disposed above */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("trusted deadline: TIMEOUT, bounded group termination, no fake exit code, teardown", async () => {
    const fx = await openSessionFixture({
      op: { op_id: `${LESSON_ID}-S001-B001`, command: "node sleep_long.js", timeout_seconds: 1 },
    });
    try {
      const receipt = await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const result = receipt.result!;
      assert.equal(result.reason, "TIMEOUT");
      assert.equal(result.exit_code, null, "no invented/synthetic exit code for a deadline termination");
      assert.equal(result.forced, true);
      assert.equal(result.timeout_ms, 1_000);
      await disposeAfterClosed(fx);
      assertJournalCoherent(fx);
      const order = fx.journalSeen.map((e) => e.type);
      assert.ok(order.includes("process.timeout"), "the canonical timeout event was journaled");
      assert.ok(order.includes("process.stopping"), "the canonical stopping event was journaled");
      const timeoutIndex = order.indexOf("process.timeout");
      const stoppingIndex = order.indexOf("process.stopping");
      const completedIndex = order.indexOf("operation.completed");
      assert.ok(timeoutIndex < stoppingIndex && stoppingIndex < completedIndex, "timeout -> stopping -> completed ordering");
      const completed = fx.journalSeen.find((e) => e.type === "operation.completed")!;
      assert.equal((completed.payload as { exit_code: number | null }).exit_code, null);
      // Container teardown is the authority: no owned container survives and
      // no guest descendant can outlive it.
      assert.equal(containerIdsForInstallation().length, 0, "timeout tears the session container down");
    } finally {
      try { await fx.dispose(); } catch { /* disposed above */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("output drain: all pre-termination output is journaled before the terminal event and the final result", async () => {
    const fx = await openSessionFixture({
      op: { op_id: `${LESSON_ID}-S001-B001`, command: "node drain_tail.js" },
    });
    try {
      await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      await fx.dispose();
      assertJournalCoherent(fx);
      const order = fx.journalSeen.map((e) => e.type);
      const lastOutputIndex = order.lastIndexOf("process.output");
      const exitedIndex = order.indexOf("process.exited");
      const completedIndex = order.indexOf("operation.completed");
      assert.ok(lastOutputIndex !== -1, "output was journaled");
      assert.ok(lastOutputIndex < exitedIndex, "output precedes the terminal exit event");
      assert.ok(exitedIndex < completedIndex, "the terminal event precedes the final result");
      // stdout AND stderr preserved, per stream, offsets monotonic.
      assert.equal(transcript(fx, "stdout").includes("P57_OUT_TAIL"), true, "the final stdout line is captured before the result");
      assert.equal(transcript(fx, "stderr").includes("P57_ERR_TAIL"), true, "the final stderr line is captured before the result");
      const offsets = outputEvents(fx).filter((o) => o.stream === "stdout").map((o) => o.stream_offset);
      assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
      // No normal output after the final result.
      assert.equal(order.lastIndexOf("process.output") < completedIndex, true, "no output event after the final result");
    } finally {
      try { await fx.dispose(); } catch { /* disposed above */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("descendant survival: parent exits, child/grandchild alive -> FAIL/UNEXPECTED_DESCENDANTS, full teardown, no leak", async () => {
    const fx = await openSessionFixture({
      op: { op_id: `${LESSON_ID}-S001-B001`, command: "node parent.js" },
    });
    try {
      const receipt = await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const result = receipt.result!;
      assert.equal(result.reason, "UNEXPECTED_DESCENDANTS");
      assert.equal(result.exit_code, 0, "the direct command's true exit fact is preserved");
      assert.equal(result.forced, true);
      await disposeAfterClosed(fx);
      assertJournalCoherent(fx);
      // The classification arrives only after the guest verified the whole
      // group dead, and the final result follows it — never a PASS with
      // surviving owned descendants.
      const failedEvent = fx.journalSeen.find(
        (e) => e.type === "process.failed" && (e.payload as { code: string }).code === "UNEXPECTED_DESCENDANTS",
      );
      assert.ok(failedEvent !== undefined, "the canonical UNEXPECTED_DESCENDANTS classification was journaled");
      const order = fx.journalSeen.map((e) => e.seq);
      assert.ok(failedEvent.seq < order[order.length - 1]!, "the classification precedes the session close");
      const completedIndex = fx.journalSeen.findIndex((e) => e.type === "operation.completed");
      assert.ok(failedEvent.seq < fx.journalSeen[completedIndex]!.seq, "classification -> final result ordering");
      // Full teardown: the container (the authority over any escapee) is gone.
      assert.equal(containerIdsForInstallation().length, 0, "full teardown after unexpected descendants");
    } finally {
      try { await fx.dispose(); } catch { /* disposed above */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("output limit: OUTPUT_LIMIT classification, managed termination, bounded memory, one result", async () => {
    const fx = await openSessionFixture({
      op: { op_id: `${LESSON_ID}-S001-B001`, command: "node flood.js", timeout_seconds: 30 },
    });
    try {
      const receipt = await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const result = receipt.result!;
      assert.equal(result.reason, "OUTPUT_LIMIT");
      assert.equal(result.exit_code, null);
      assert.equal(result.truncated, true);
      assert.equal(result.forced, true);
      await disposeAfterClosed(fx);
      assertJournalCoherent(fx);
      // No runaway journal growth: the per-process bound held.
      const status = fx.journal.status();
      assert.ok(status.journal_bytes < 2_000_000, `journal stayed bounded (${status.journal_bytes} bytes)`);
    } finally {
      try { await fx.dispose(); } catch { /* disposed above */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("cancellation: SKIPPED/CANCELLED with a null exit code and a dead group (trusted identity only)", async () => {
    const fx = await openSessionFixture({
      op: { op_id: `${LESSON_ID}-S001-B001`, command: "node sleep_long.js", timeout_seconds: 30 },
    });
    try {
      const started = fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      await fx.waitForJournalEvent("process.started", null, 15_000);
      const stopResult = await fx.provider.cancel(fx.session, fx.grant.operation_id);
      assert.equal(stopResult.outcome, "stopped");
      const receipt = await started;
      const result = receipt.result!;
      assert.equal(result.reason, "CANCELLED");
      assert.equal(result.exit_code, null);
      await fx.dispose();
      assertJournalCoherent(fx);
      const completed = fx.journalSeen.find((e) => e.type === "operation.completed")!;
      assert.deepEqual(completed.payload, { outcome: "SKIPPED", reason: "CANCELLED", exit_code: null, forced: true });
    } finally {
      try { await fx.dispose(); } catch { /* disposed above */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("session close during an active foreground run: no final result, no event after runtime.closed", async () => {
    const fx = await openSessionFixture({
      op: { op_id: `${LESSON_ID}-S001-B001`, command: "node sleep_long.js", timeout_seconds: 30 },
    });
    try {
      const started = fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      await fx.waitForJournalEvent("process.started", null, 15_000);
      started.catch(() => { /* the awaiting start rejects on close — canonical */ });
      const cleanup = await fx.provider.close(fx.session, "app_close");
      assert.equal(cleanup.cleanup_status, "confirmed");
      await fx.waitForJournalEvent("runtime.closed", null, 20_000);
      const closedAt = fx.journalSeen.length;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
      assert.equal(fx.journalSeen.length, closedAt, "no stale-generation output/result after runtime.closed");
      assert.equal(fx.journalSeen.filter((e) => e.type === "operation.completed").length, 0, "the interrupted run published no final result");
      // A stale start against the closed session rejects.
      await assert.rejects(
        fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id),
        (error: Error & { code?: string }) => error.code === "NOT_AUTHORIZED",
      );
    } finally {
      try { await fx.dispose(); } catch { /* close already removed the session */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });
});

describe("P5.7 daemon-free guarantees (no Docker required)", () => {
  it("the foreground state machine imports no execution machinery (fs/network/child_process/Docker)", () => {
    const code = readFileSync(join(here, "../src/foreground.ts"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of ["node:fs", "node:net", "node:child_process", "node:http", "docker", "node-pty", "spawn("]) {
      assert.equal(code.includes(forbidden), false, `src/foreground.ts must not reference ${forbidden}`);
    }
  });
});
