// P5.10 REAL Docker integration — canonical process-output waits ("Early/
// spanning per-stream/abort/deadline/exit"; PASS "No lost markers/TCP
// workflow"), proven end-to-end against the actual local Docker daemon:
//
//   canonical admission (compiled synthetic fixture -> catalog -> session ->
//   background grant + trusted WaitAdmission) -> trusted workspace leaf ->
//   DockerSandboxProvider -> live session container -> guest supervisor
//   process groups -> provider events -> SessionJournal (authoritative seq) ->
//   waitForProcessOutput (early/spanning per-stream matching, deadline, abort,
//   exit).
//
// Every resource is prefixed cf-p510- (installation label
// cf-p510-installation) under the repository's ignored temp root; production
// course content is untouched. Tests are skipped (never silently passed) only
// when the daemon or the supervisor runtime image is unavailable — the P5.10
// gate REQUIRES a real run and fails otherwise. Every test's finally/after
// removes only its own owned containers (never a global prune).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSandboxProvider, type DockerProviderConfig } from "../src/providers/docker.ts";
import type { AdmittedSession, ProviderEvent, ProviderSession } from "../src/providers/execution-provider.ts";
import type { ExecutionGrant, WaitAdmission } from "../src/admission.ts";
import { createAdmissionService } from "../src/admission.ts";
import type { RuntimeEvent, RuntimeSessionIdentity } from "../src/protocol.ts";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import {
  resolveConfiguredWorkspaceRoot,
  createSessionWorkspace,
  resolveGrantWorkspace,
  buildWorkspaceMountPlan,
  resolveExecutionContext,
} from "../src/workspace.ts";
import { resolveEnvironmentPlan } from "../src/environment.ts";
import { SessionJournal } from "../src/journal.ts";
import { waitForProcessOutput, OutputWaitError } from "../src/output-wait.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P5.10");
const WS_ROOT = join(TEST_ROOT, "workspaces-root");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5.10";
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_BASE_DIGEST = PINNED_BASE.split("@")[1]!;
const INSTALLATION_ID = "cf-p510-installation";
const INSTALL_LABEL = "com.course-factory.installation";
const LESSON_ID = "C01-L510";

function resolveDockerExe(): string {
  const configured = process.env.CF_P510_DOCKER_EXE ?? process.env.CF_P54_DOCKER_EXE;
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
  const configured = process.env.CF_P510_RUNTIME_IMAGE;
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
    "--description", "course-factory p5.10 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

// -- synthetic guest scripts (seeded into the session leaf; guest-only) ------

const SCRIPTS: Record<string, string> = {
  "p510_ready.js": [
    "console.log('P510_BOOT');",
    "setTimeout(() => console.log('P510_READY'), 300);",
    "let n = 0;",
    "setInterval(() => { n += 1; console.log('P510_TICK_' + n); }, 400);",
    "setTimeout(() => process.exit(0), 25000);",
  ].join("\n"),
  "p510_split.js": [
    "process.stdout.write('P51');",
    "setTimeout(() => process.stdout.write('0_SPLIT\\n'), 200);",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 25000);",
  ].join("\n"),
  "p510_stderr.js": [
    "console.log('P510_NOISE_STDOUT');",
    "setTimeout(() => { require('node:fs').writeSync(2, 'P510_ERR_READY\\n'); }, 300);",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 25000);",
  ].join("\n"),
  "p510_ansi.js": [
    "setTimeout(() => console.log('\\u001b[32mP510_ANSI\\u001b[0m'), 300);",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 25000);",
  ].join("\n"),
  "p510_crlf.js": [
    "setTimeout(() => process.stdout.write('P510_A\\r\\nP510_B\\n'), 300);",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 25000);",
  ].join("\n"),
  "p510_silent.js": [
    "console.log('P510_SILENT_BOOT');",
    "setInterval(() => { console.log('P510_SILENT_TICK'); }, 400);",
    "setTimeout(() => process.exit(0), 25000);",
  ].join("\n"),
  "p510_quick_exit.js": [
    "console.log('P510_EXIT_SOON');",
    "setTimeout(() => process.exit(0), 300);",
  ].join("\n"),
};

// -- canonical admission -> grants + waits ------------------------------------

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: never) => CompiledLesson;
};
const { parseLessonData } = await import("@course-factory/shared-types/validate");

interface P510Spec {
  readonly bg_op_id: string;
  readonly wait_op_id: string;
  readonly command: string;
  readonly process_id: string;
  readonly wait_text: string;
  readonly wait_timeout_seconds: number;
}

function lessonSource(spec: P510Spec): unknown {
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: LESSON_ID,
    title: "P5.10 synthetic output-wait lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Process-output readiness waits in the P5 sandbox"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p510"],
    metadata: { synthetic_fixture: true, phase: "P5.10" },
    scenes: [
      {
        scene_id: `${LESSON_ID}-S001`,
        type: "code_demo",
        title: "Output waits",
        duration: 120,
        visual: { kind: "terminal", description: "synthetic" },
        beats: [
          {
            beat_id: spec.bg_op_id,
            kind: "action",
            action: {
              type: "terminal_run",
              command: spec.command,
              mode: "background",
              process_id: spec.process_id,
            },
          },
          {
            beat_id: spec.wait_op_id,
            kind: "action",
            action: {
              type: "wait",
              until: "process_output",
              process_id: spec.process_id,
              text: spec.wait_text,
              timeout_seconds: spec.wait_timeout_seconds,
            },
          },
        ],
      },
    ],
  };
}

function makeProvider(): DockerSandboxProvider {
  const config: DockerProviderConfig = {
    cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR, clientEnv: {} },
    imageReference: RUNTIME_IMAGE_REF!,
    installationId: INSTALLATION_ID,
  };
  return new DockerSandboxProvider(config);
}

interface P510Fixture {
  readonly provider: DockerSandboxProvider;
  readonly session: ProviderSession;
  readonly journal: SessionJournal;
  readonly journalEvents: RuntimeEvent[];
  readonly grant: ExecutionGrant;
  readonly wait: WaitAdmission;
  readonly identity: RuntimeSessionIdentity;
  readonly leafPath: string;
  isTargetLive(): boolean;
  waitForJournal(type: RuntimeEvent["type"], timeoutMs: number): Promise<RuntimeEvent>;
  dispose(): Promise<void>;
}

async function openP510Fixture(spec: P510Spec, sessionId: string): Promise<P510Fixture> {
  const raw = lessonSource(spec);
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

  const bgAdmitted = service.admitRunOperation(identity, {
    session_id: sessionId,
    operation_id: spec.bg_op_id,
    request_id: `req-${spec.bg_op_id}`,
  });
  if (!bgAdmitted.ok || bgAdmitted.value.kind !== "execution_grant") {
    throw new Error(`background admission failed: ${bgAdmitted.ok ? "wrong kind" : bgAdmitted.rejection.message}`);
  }
  const grant = bgAdmitted.value;
  const waitAdmitted = service.admitRunOperation(identity, {
    session_id: sessionId,
    operation_id: spec.wait_op_id,
    request_id: `req-${spec.wait_op_id}`,
  });
  if (!waitAdmitted.ok || waitAdmitted.value.kind !== "wait_admission") {
    throw new Error(`wait admission failed: ${waitAdmitted.ok ? "wrong kind" : waitAdmitted.rejection.message}`);
  }
  const wait = waitAdmitted.value;

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
  const journal = new SessionJournal({ session_id: sessionId, generation: identity.generation });
  const journalEvents: RuntimeEvent[] = [];
  const subscription = journal.subscribe((event) => journalEvents.push(event));
  provider.events(session, (event: ProviderEvent) => {
    journal.ingest(event);
  });

  const fixture: P510Fixture = {
    provider,
    session,
    journal,
    journalEvents,
    grant,
    wait,
    identity,
    leafPath: leaf.value.host_root,
    isTargetLive: () => {
      const entry = provider.processSnapshot(session).find((p) => p.process_id === spec.process_id);
      return entry !== undefined && (entry.state === "STARTING" || entry.state === "RUNNING" || entry.state === "STOPPING");
    },
    async waitForJournal(type, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = [...journalEvents].reverse().find((event) => event.type === type);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for journal ${type}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    },
    async dispose() {
      subscription.dispose();
      try {
        await provider.close(session, "lesson_end");
      } catch { /* already closed by a failure path; cleanup below is authoritative */ }
      try { rmSync(leaf.value.host_root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
  return fixture;
}

function uid(prefix: string): string {
  return `${prefix}-p510-${randomBytes(4).toString("hex")}`;
}

function observe(fx: P510Fixture, signal?: AbortSignal) {
  return waitForProcessOutput(fx.wait, {
    subscribe: (listener) => fx.journal.subscribe(listener),
    getHistory: () => fx.journal.snapshot(0).events,
    isLive: () => fx.isTargetLive(),
    signal: signal ?? null,
  });
}

// -----------------------------------------------------------------------------

describe("P5.10 real Docker output-wait integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(WS_ROOT, { recursive: true });
    ensureConfigContext();
  });

  after(() => {
    for (const id of containerIdsForInstallation()) docker("rm", "--force", id);
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("early READY is not lost: waiter registered at spawn observes the marker through the journal with its seq/stream", async () => {
    const sessionId = uid("sess");
    const fx = await openP510Fixture({
      bg_op_id: `${LESSON_ID}-S001-B101`,
      wait_op_id: `${LESSON_ID}-S001-B102`,
      command: "node p510_ready.js",
      process_id: "p510-srv",
      wait_text: "P510_READY",
      wait_timeout_seconds: 20,
    }, sessionId);
    try {
      // Register the wait AT spawn: start the background and observe
      // concurrently, exactly as a lesson runner would (no sleep between).
      const startPromise = fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const matchPromise = observe(fx);
      const [receipt, match] = await Promise.all([startPromise, matchPromise]);
      assert.equal(receipt.process_id, "p510-srv");
      assert.equal(match.process_id, "p510-srv");
      assert.equal(match.stream, "stdout");
      assert.ok(match.seq >= 1, "the match retains its journal seq");
      const journalMatch = fx.journalEvents.find((event) => event.seq === match.seq);
      assert.ok(journalMatch !== undefined, "the retained seq addresses a real journal event");
      assert.equal(journalMatch.type, "process.output");
      assert.match((journalMatch.payload as { text: string }).text, /P510_READY/);
      // Journal invariants hold around the observation: strictly increasing
      // seq and a coherent per-process transcript containing the marker.
      const seqs = fx.journalEvents.map((event) => event.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
      assert.match(fx.journal.transcript("p510-srv").stdout, /P510_READY/);
    } finally {
      await fx.dispose();
    }
  });

  it("chunk-spanning marker across real guest writes matches on the completing event", async () => {
    const sessionId = uid("sess");
    const fx = await openP510Fixture({
      bg_op_id: `${LESSON_ID}-S001-B111`,
      wait_op_id: `${LESSON_ID}-S001-B112`,
      command: "node p510_split.js",
      process_id: "p510-split",
      wait_text: "P510_SPLIT",
      wait_timeout_seconds: 20,
    }, sessionId);
    try {
      await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const match = await observe(fx);
      assert.equal(match.stream, "stdout");
      assert.match(fx.journal.transcript("p510-split").stdout, /P510_SPLIT/);
    } finally {
      await fx.dispose();
    }
  });

  it("stderr marker satisfies the wait and retains its stream (stdout noise never completes it)", async () => {
    const sessionId = uid("sess");
    const fx = await openP510Fixture({
      bg_op_id: `${LESSON_ID}-S001-B121`,
      wait_op_id: `${LESSON_ID}-S001-B122`,
      command: "node p510_stderr.js",
      process_id: "p510-err",
      wait_text: "P510_ERR_READY",
      wait_timeout_seconds: 20,
    }, sessionId);
    try {
      await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const match = await observe(fx);
      assert.equal(match.stream, "stderr", "either stream can satisfy; the match retains its stream");
      assert.match(fx.journal.transcript("p510-err").stderr, /P510_ERR_READY/);
    } finally {
      await fx.dispose();
    }
  });

  it("ANSI-wrapped marker matches over real guest pipes (incremental stripping)", async () => {
    const sessionId = uid("sess");
    const fx = await openP510Fixture({
      bg_op_id: `${LESSON_ID}-S001-B131`,
      wait_op_id: `${LESSON_ID}-S001-B132`,
      command: "node p510_ansi.js",
      process_id: "p510-ansi",
      wait_text: "P510_ANSI",
      wait_timeout_seconds: 20,
    }, sessionId);
    try {
      await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const match = await observe(fx);
      assert.equal(match.stream, "stdout");
    } finally {
      await fx.dispose();
    }
  });

  it("CRLF marker normalizes over real guest pipes (output CRLF satisfies an LF literal)", async () => {
    const sessionId = uid("sess");
    const fx = await openP510Fixture({
      bg_op_id: `${LESSON_ID}-S001-B141`,
      wait_op_id: `${LESSON_ID}-S001-B142`,
      command: "node p510_crlf.js",
      process_id: "p510-crlf",
      wait_text: "P510_A\nP510_B",
      wait_timeout_seconds: 20,
    }, sessionId);
    try {
      await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const match = await observe(fx);
      assert.equal(match.stream, "stdout");
    } finally {
      await fx.dispose();
    }
  });

  it("deadline: silence settles TIMEOUT with no session teardown (observation only)", async () => {
    const sessionId = uid("sess");
    const fx = await openP510Fixture({
      bg_op_id: `${LESSON_ID}-S001-B151`,
      wait_op_id: `${LESSON_ID}-S001-B152`,
      command: "node p510_silent.js",
      process_id: "p510-silent",
      wait_text: "P510_NEVER_PRINTED",
      wait_timeout_seconds: 2,
    }, sessionId);
    try {
      await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      try {
        await observe(fx);
        assert.fail("silence must settle TIMEOUT, not match");
      } catch (error) {
        assert.ok(error instanceof OutputWaitError);
        assert.equal(error.code, "TIMEOUT");
      }
      // The waiter's deadline is observation-only: the background lifetime is
      // untouched and the session stays alive for further operations.
      assert.equal(fx.isTargetLive(), true, "the deadline tears down nothing");
    } finally {
      await fx.dispose();
    }
  });

  it("exit without marker settles PROCESS_EXITED and the session fails/closes per background semantics", async () => {
    const sessionId = uid("sess");
    const fx = await openP510Fixture({
      bg_op_id: `${LESSON_ID}-S001-B161`,
      wait_op_id: `${LESSON_ID}-S001-B162`,
      command: "node p510_quick_exit.js",
      process_id: "p510-quick",
      wait_text: "P510_NEVER_PRINTED",
      wait_timeout_seconds: 20,
    }, sessionId);
    try {
      await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      try {
        await observe(fx);
        assert.fail("an exit without marker must settle PROCESS_EXITED");
      } catch (error) {
        assert.ok(error instanceof OutputWaitError);
        assert.equal(error.code, "PROCESS_EXITED");
      }
      // Canonical background early-exit semantics still apply (the waiter's
      // exit report is observation; the lifetime fails/closes the session).
      const closed = await fx.waitForJournal("runtime.closed", 15000);
      assert.equal((closed.payload as { cleanup_status: string }).cleanup_status, "confirmed");
      const closedIndex = fx.journalEvents.findIndex((event) => event.type === "runtime.closed");
      assert.equal(fx.journalEvents.length, closedIndex + 1, "no event after runtime.closed");
    } finally {
      await fx.dispose();
    }
  });

  it("already-dead target rejects PROCESS_EXITED immediately (no full-deadline wait)", async () => {
    const sessionId = uid("sess");
    const fx = await openP510Fixture({
      bg_op_id: `${LESSON_ID}-S001-B171`,
      wait_op_id: `${LESSON_ID}-S001-B172`,
      command: "node p510_quick_exit.js",
      process_id: "p510-dead",
      wait_text: "P510_NEVER_PRINTED",
      wait_timeout_seconds: 20,
    }, sessionId);
    try {
      await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      // Wait for the natural death to land in the journal first.
      const deadline = Date.now() + 15000;
      for (;;) {
        if (!fx.isTargetLive()) break;
        if (Date.now() > deadline) throw new Error("background did not exit");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      const started = Date.now();
      try {
        await observe(fx);
        assert.fail("an already-dead target must reject immediately");
      } catch (error) {
        assert.ok(error instanceof OutputWaitError);
        assert.equal(error.code, "PROCESS_EXITED");
      }
      assert.ok(Date.now() - started < 2000, "no full-deadline wait for a dead process");
    } finally {
      await fx.dispose();
    }
  });

  it("abort settles CANCELLED without tearing down the session", async () => {
    const sessionId = uid("sess");
    const fx = await openP510Fixture({
      bg_op_id: `${LESSON_ID}-S001-B181`,
      wait_op_id: `${LESSON_ID}-S001-B182`,
      command: "node p510_ready.js",
      process_id: "p510-abort",
      wait_text: "P510_NEVER_PRINTED",
      wait_timeout_seconds: 20,
    }, sessionId);
    try {
      await fx.provider.start(fx.session, fx.grant.operation_id, fx.grant.attempt_id);
      const controller = new AbortController();
      const pending = observe(fx, controller.signal);
      pending.catch(() => { /* asserted below */ });
      controller.abort();
      try {
        await pending;
        assert.fail("an aborted wait must settle CANCELLED");
      } catch (error) {
        assert.ok(error instanceof OutputWaitError);
        assert.equal(error.code, "CANCELLED");
      }
      assert.equal(fx.isTargetLive(), true, "abort tears down nothing");
    } finally {
      await fx.dispose();
    }
  });
});
