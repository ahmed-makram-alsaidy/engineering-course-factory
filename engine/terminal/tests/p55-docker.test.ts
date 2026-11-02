// P5.5 REAL Docker integration â€” process ownership, background execution,
// guest process groups, lease/heartbeat and stop/cleanup semantics, proven
// end-to-end against the actual local Docker daemon:
//
//   canonical admission (compiled synthetic fixture -> catalog -> session ->
//   grants) -> trusted workspace leaf -> DockerSandboxProvider -> live
//   session container -> guest supervisor process groups.
//
// Every resource is prefixed cf-p55- (installation label cf-p55-installation)
// under the repository's ignored temp root; production course content is
// untouched. Tests are skipped (never silently passed) only when the daemon
// or the supervisor runtime image is unavailable â€” the P5.5 gate REQUIRES a
// real run and fails otherwise. Every test's finally/after removes only its
// own owned containers (never a global prune).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSandboxProvider, type DockerProviderConfig } from "../src/providers/docker.ts";
import type { AdmittedSession, ProviderEvent, ProviderSession } from "../src/providers/execution-provider.ts";
import type { ExecutionGrant, StopAdmission } from "../src/admission.ts";
import {
  createAdmissionService,
  type AdmissionService,
  type AdmissionSession,
} from "../src/admission.ts";
import type { RuntimeSessionIdentity } from "../src/protocol.ts";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
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
const TEST_ROOT = join(repoRoot, "temp", "P5.5");
const WS_ROOT = join(TEST_ROOT, "workspaces-root");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5.5";
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_BASE_DIGEST = PINNED_BASE.split("@")[1]!;
const INSTALLATION_ID = "cf-p55-installation";
const OWNER_LABEL = "com.course-factory.owner";
const INSTALL_LABEL = "com.course-factory.installation";
const LESSON_ID = "C01-L055";

function resolveDockerExe(): string {
  const configured = process.env.CF_P55_DOCKER_EXE ?? process.env.CF_P54_DOCKER_EXE;
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
  const configured = process.env.CF_P55_RUNTIME_IMAGE;
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
    "--description", "course-factory p5.5 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

// -- synthetic lesson scripts (seeded into the session leaf; guest-only) ------

const SCRIPTS: Record<string, string> = {
  "tick_server.js": [
    "console.log('P55_STARTED');",
    "let i = 0;",
    "const t = setInterval(() => { i += 1; console.log('P55_TICK_' + i); }, 250);",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
  "interleave.js": [
    "const w = (fd, s) => require('node:fs').writeSync(fd, s);",
    "let n = 0;",
    "const t = setInterval(() => {",
    "  n += 1;",
    "  w(1, 'P55_OUT_A' + n + '\\n');",
    "  w(2, 'P55_ERR_B' + n + '\\n');",
    "  if (n >= 4) { clearInterval(t); }",
    "}, 200);",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
  "graceful.js": [
    "process.on('SIGINT', () => { console.log('P55_TERM_RECEIVED'); setTimeout(() => process.exit(0), 100); });",
    "process.on('SIGTERM', () => { console.log('P55_TERM_RECEIVED'); setTimeout(() => process.exit(0), 100); });",
    "console.log('P55_GRACEFUL_READY');",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
  "stubborn.js": [
    "process.on('SIGINT', () => { /* ignores the graceful signal */ });",
    "process.on('SIGTERM', () => { /* ignores the graceful signal */ });",
    "console.log('P55_FORCE_TARGET');",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
  "tree.js": [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['tree_child.js'], { stdio: 'ignore' });",
    "console.log('P55_TREE_PARENT');",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
  "tree_child.js": [
    "const { spawn } = require('node:child_process');",
    "const grand = spawn(process.execPath, ['tree_grandchild.js'], { stdio: 'ignore' });",
    "console.log('P55_TREE_CHILD');",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
  "tree_grandchild.js": [
    "console.log('P55_TREE_GRANDCHILD');",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
  "quick_exit.js": [
    "console.log('P55_EXIT_SOON');",
    "setTimeout(() => process.exit(3), 400);",
  ].join("\n"),
  "long_run.js": [
    "console.log('P55_LONG_READY');",
    "let i = 0;",
    "const t = setInterval(() => { i += 1; console.log('P55_LONG_TICK_' + i); }, 250);",
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
  readonly process_id: string;
  readonly cwd?: string | null;
}
interface StopOpSpec {
  readonly op_id: string;
  readonly process_id: string;
}

function lessonSource(ops: readonly OpSpec[], stopOps: readonly StopOpSpec[]): unknown {
  const beats: Array<{ beat_id: string; kind: string; action?: unknown; narration?: unknown }> = [];
  for (const op of ops) {
    beats.push({
      beat_id: op.op_id,
      kind: "action",
      action: {
        type: "terminal_run",
        command: op.command,
        mode: "background",
        process_id: op.process_id,
        ...(op.cwd !== undefined ? { cwd: op.cwd } : {}),
      },
    });
  }
  for (const stop of stopOps) {
    beats.push({ beat_id: stop.op_id, kind: "action", action: { type: "terminal_stop", process_id: stop.process_id } });
  }
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: LESSON_ID,
    title: "P5.5 synthetic background ownership lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Background process ownership in the P5 sandbox"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p55"],
    metadata: { synthetic_fixture: true, phase: "P5.5" },
    scenes: [
      {
        scene_id: `${LESSON_ID}-S001`,
        type: "code_demo",
        title: "Background processes and stops",
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

interface P55Fixture {
  readonly provider: DockerSandboxProvider;
  readonly session: ProviderSession;
  readonly events: ProviderEvent[];
  readonly grants: ReadonlyMap<string, ExecutionGrant>;
  readonly stopAdmissions: ReadonlyMap<string, StopAdmission>;
  readonly identity: RuntimeSessionIdentity;
  readonly service: AdmissionService;
  readonly admissionSession: AdmissionSession;
  readonly leafPath: string;
  readonly wsRoot: ResolvedWorkspaceRoot;
  readonly primaryGrant: ExecutionGrant;
  /** Bounded event wait (deterministic poll, no sleeps in the assertion logic). */
  waitForEvent(type: ProviderEvent["type"], predicate: ((event: ProviderEvent) => boolean) | null, timeoutMs: number): Promise<ProviderEvent>;
  outputs(processId?: string): { stdout: string; stderr: string };
  snapshot(): ReturnType<DockerSandboxProvider["processSnapshot"]>;
  dispose(): Promise<void>;
}

async function openSessionFixture(args: {
  ops: readonly OpSpec[];
  stopOps?: readonly StopOpSpec[];
  seedFiles?: boolean;
  sessionId?: string;
}): Promise<P55Fixture> {
  const sessionId = args.sessionId ?? `sess-p55-${randomBytes(4).toString("hex")}`;
  const raw = lessonSource(args.ops, args.stopOps ?? []);
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

  const grants = new Map<string, ExecutionGrant>();
  const stopAdmissions = new Map<string, StopAdmission>();
  for (const op of args.ops) {
    const admitted = service.admitRunOperation(identity, {
      session_id: sessionId,
      operation_id: op.op_id,
      request_id: `req-${op.op_id}`,
    });
    if (!admitted.ok) throw new Error(`admission rejected ${op.op_id}: ${admitted.rejection.message}`);
    if (admitted.value.kind !== "execution_grant") throw new Error(`expected an execution grant for ${op.op_id}`);
    grants.set(op.op_id, admitted.value);
  }
  for (const stop of args.stopOps ?? []) {
    const admitted = service.admitRunOperation(identity, {
      session_id: sessionId,
      operation_id: stop.op_id,
      request_id: `req-${stop.op_id}`,
    });
    if (!admitted.ok) throw new Error(`stop admission rejected ${stop.op_id}: ${admitted.rejection.message}`);
    if (admitted.value.kind !== "stop_admission") throw new Error(`expected a stop admission for ${stop.op_id}`);
    stopAdmissions.set(stop.op_id, admitted.value);
  }

  const root = resolveConfiguredWorkspaceRoot(WS_ROOT);
  if (!root.ok) throw new Error("workspace root resolution failed");
  const leaf = createSessionWorkspace(root.value, {
    lesson_id: LESSON_ID,
    session_id: sessionId,
    generation: identity.generation,
  });
  if (!leaf.ok) throw new Error(`session workspace failed: ${leaf.error.message}`);
  if (args.seedFiles !== false) {
    for (const [name, content] of Object.entries(SCRIPTS)) {
      writeFileSync(join(leaf.value.host_root, name), content, "utf8");
    }
  }

  const primaryGrant = grants.values().next().value;
  if (primaryGrant === undefined) throw new Error("fixture has no background grant");
  const paths = resolveGrantWorkspace(leaf.value, primaryGrant);
  if (!paths.ok) throw new Error(`grant workspace failed: ${paths.error.message}`);
  const mountPlan = buildWorkspaceMountPlan(paths.value);
  if (!mountPlan.ok) throw new Error(`mount plan failed: ${mountPlan.error.message}`);
  const env = resolveEnvironmentPlan(Object.freeze({ TZ: "UTC", OPENAI_API_KEY: "DO_NOT_LEAK" }), ["TZ"]);
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
    grants: [...grants.values()],
  };
  const session = await provider.prepare(admittedSession);
  const events: ProviderEvent[] = [];
  const subscription = provider.events(session, (event) => events.push(event));

  const fixture: P55Fixture = {
    provider,
    session,
    events,
    grants,
    stopAdmissions,
    identity,
    service,
    admissionSession: opened.value,
    leafPath: leaf.value.host_root,
    wsRoot: root.value,
    primaryGrant,
    async waitForEvent(type, predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = [...events].reverse().find((event) => {
          if (event.type !== type) return false;
          return predicate === null || predicate(event);
        });
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    },
    outputs(processId) {
      let stdout = "";
      let stderr = "";
      for (const event of events) {
        if (event.type !== "process.output") continue;
        if (processId !== undefined && event.process_id !== processId) continue;
        const payload = event.payload as { stream: string; text: string };
        if (payload.stream === "stdout") stdout += payload.text;
        else stderr += payload.text;
      }
      return { stdout, stderr };
    },
    snapshot() {
      return provider.processSnapshot(session);
    },
    async dispose() {
      subscription.dispose();
      await provider.close(session, "lesson_end");
      try { rmSync(leaf.value.host_root, { recursive: true, force: true }); } catch { /* explicit below */ }
    },
  };
  return fixture;
}

/** Operator-level in-guest /proc probe (test diagnostics only, never product code). */
function probeProcesses(containerId: string): Array<{ pid: number; ppid: number; pgid: number; cmd: string }> {
  const script = [
    "const fs=require('node:fs');",
    "const out=[];",
    "for (const p of fs.readdirSync('/proc')) {",
    "  if (!/^[0-9]+$/.test(p)) continue;",
    "  let stat=''; try { stat=fs.readFileSync('/proc/'+p+'/stat','utf8'); } catch (e) { continue; }",
    "  const i=stat.indexOf(') ');",
    "  if (i<0) continue;",
    "  const fields=stat.slice(i+2).split(' ');",
    "  let cmd=''; try { cmd=fs.readFileSync('/proc/'+p+'/cmdline','utf8'); } catch (e) {}",
    "  out.push({pid:Number(p),ppid:Number(fields[1]),pgid:Number(fields[2]),cmd:cmd.split(String.fromCharCode(0)).filter(function(s){return s.length>0}).join(' ')});",
    "}",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");
  const r = docker("exec", containerId, "node", "-e", script);
  if (r.status !== 0) throw new Error(`guest probe failed: ${r.stderr.slice(0, 200)}`);
  return JSON.parse(r.stdout) as Array<{ pid: number; ppid: number; pgid: number; cmd: string }>;
}


function isNodeProc(p: { cmd: string }): boolean {
  return p.cmd.split(" ")[0]!.endsWith("node");
}
function liveSessionContainer(): string | null {
  const ids = containerIdsForInstallation();
  if (ids.length === 0) return null;
  const r = docker("inspect", ids[0]!, "--format", "{{.State.Running}}");
  if (r.status !== 0) return null;
  return r.stdout.trim() === "true" ? ids[0]! : null;
}

async function eventually(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms: ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

// -----------------------------------------------------------------------------

describe("P5.5 real Docker background ownership integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(WS_ROOT, { recursive: true });
    ensureConfigContext();
  });

  after(() => {
    for (const id of containerIdsForInstallation()) docker("rm", "--force", id);
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("background start returns while the process lives; output continues; registry RUNNING; guest group real", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node tick_server.js", process_id: "dev_server" }],
    });
    try {
      const startedAt = Date.now();
      const receipt = await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      assert.equal(receipt.process_id, "dev_server", "logical identity only");
      const startReturnMs = Date.now() - startedAt;
      assert.equal(fx.snapshot()[0]?.state, "RUNNING", "registry claims RUNNING after the guest ack");
      // Output continues AFTER start returned.
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P55_TICK_2"), 10_000);
      const out = fx.outputs("dev_server");
      assert.match(out.stdout, /P55_STARTED/);
      assert.match(out.stdout, /P55_TICK_1/);
      for (const event of fx.events.filter((e) => e.type === "process.output")) {
        assert.equal(event.process_id, "dev_server", "output events carry the logical process id");
      }
      // The start receipt resolved while the process is still alive.
      assert.ok(startReturnMs < 8000, `start returned in ${startReturnMs} ms`);
      const containerId = liveSessionContainer();
      assert.ok(containerId, "the session container is still alive while the process runs");
      // REAL guest process group: the managed command tree runs inside ONE
      // supervisor-created process group (the shell wrapper is the group
      // leader; the node command and any descendants share its pgid).
      const processes = probeProcesses(containerId!);
      const managed = processes.filter((p) => isNodeProc(p) && p.cmd.includes("tick_server.js"));
      assert.equal(managed.length, 1, "exactly one managed process exists in the guest");
      const wrappers = processes.filter((p) => p.cmd.startsWith("/bin/sh") && p.cmd.includes("tick_server.js"));
      assert.equal(wrappers.length, 1, "the authored command runs under the guest shell inside the group");
      assert.equal(managed[0]!.pgid, wrappers[0]!.pgid, "the command shares the supervisor-created process group");
      assert.ok(managed[0]!.pgid > 1, "the group is a dedicated guest process group (not the init group)");
      assert.notEqual(managed[0]!.ppid, 0);
      const stopResult = await fx.provider.stop(fx.session, "dev_server", "operator_stop");
      assert.equal(stopResult.outcome, "stopped");
    } finally {
      await fx.dispose();
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives the session");
  });

  it("interleaved stdout/stderr preserve per-stream order (no false global ordering claim)", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node interleave.js", process_id: "interleaved" }],
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      await eventually(() => {
        const { stdout, stderr } = fx.outputs("interleaved");
        return stdout.includes("P55_OUT_A4") && stderr.includes("P55_ERR_B4");
      }, 10_000, "interleaved output complete");
      const stdoutEvents = fx.events.filter((e) => e.type === "process.output" && (e.payload as { stream: string }).stream === "stdout");
      const stderrEvents = fx.events.filter((e) => e.type === "process.output" && (e.payload as { stream: string }).stream === "stderr");
      assert.deepEqual(
        stdoutEvents.map((e) => (e.payload as { text: string }).text.trim()),
        ["P55_OUT_A1", "P55_OUT_A2", "P55_OUT_A3", "P55_OUT_A4"],
        "stdout order preserved",
      );
      assert.deepEqual(
        stderrEvents.map((e) => (e.payload as { text: string }).text.trim()),
        ["P55_ERR_B1", "P55_ERR_B2", "P55_ERR_B3", "P55_ERR_B4"],
        "stderr order preserved independently",
      );
      const offsets = stdoutEvents.map((e) => (e.payload as { stream_offset: number }).stream_offset);
      assert.deepEqual(offsets, offsets.slice().sort((a, b) => a - b), "stdout stream offsets strictly increase");
      await fx.provider.stop(fx.session, "interleaved", "operator_stop");
    } finally {
      await fx.dispose();
    }
  });

  it("graceful stop: canonical signal observed, exit 0, ownership released, session container reused", async () => {
    const fx = await openSessionFixture({
      ops: [
        { op_id: "C01-L055-S001-B001", command: "node graceful.js", process_id: "graceful_proc" },
        { op_id: "C01-L055-S001-B002", command: "node tick_server.js", process_id: "worker" },
      ],
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P55_GRACEFUL_READY"), 10_000);
      const stopResult = await fx.provider.stop(fx.session, "graceful_proc", "authored_stop");
      assert.equal(stopResult.outcome, "stopped");
      assert.equal(stopResult.forced, false, "graceful stop is not forced");
      const stopped = await fx.waitForEvent("process.stopped", null, 10_000);
      assert.equal((stopped.payload as { forced: boolean }).forced, false);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P55_TERM_RECEIVED"), 10_000);
      const out = fx.outputs("graceful_proc");
      assert.match(out.stdout, /P55_TERM_RECEIVED/);
      const snapshot = fx.snapshot().find((p) => p.process_id === "graceful_proc");
      assert.ok(snapshot && (snapshot.state === "EXITED" || snapshot.state === "DISPOSED"), "ownership released");
      // Canonical signal semantics (design: "Signal -> null code/signal, no
      // invented 0/137"): the managed process died from the group signal;
      // the graceful handler's own exit is proven by P55_TERM_RECEIVED.
      assert.equal(snapshot?.exit_code, null);
      const stoppedPayload = stopped.payload as { forced: boolean; signal: string | null };
      assert.equal(stoppedPayload.signal, "SIGINT", "the canonical graceful signal was applied");
      // Session container reuse (design: one container shares all session
      // operations): a second background process runs in the SAME session
      // container after the stop.
      const reused = await fx.provider.start(fx.session, "C01-L055-S001-B002", fx.grants.get("C01-L055-S001-B002")!.attempt_id);
      assert.equal(reused.process_id, "worker");
      await fx.waitForEvent("process.output", (e) => e.process_id === "worker" && (e.payload as { text: string }).text.includes("P55_STARTED"), 10_000);
      await fx.provider.stop(fx.session, "worker", "operator_stop");
    } finally {
      await fx.dispose();
    }
  });

  it("force stop: a SIGINT-ignoring group is SIGKILLed after the grace (forced, bounded, dead)", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node stubborn.js", process_id: "stubborn_proc" }],
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P55_FORCE_TARGET"), 10_000);
      const containerId = liveSessionContainer();
      assert.ok(containerId);
      assert.equal(probeProcesses(containerId!).filter((p) => isNodeProc(p) && p.cmd.includes("stubborn.js")).length, 1, "process alive before stop");
      const t0 = Date.now();
      const stopResult = await fx.provider.stop(fx.session, "stubborn_proc", "operator_stop");
      const elapsedMs = Date.now() - t0;
      assert.equal(stopResult.outcome, "stopped");
      assert.equal(stopResult.forced, true, "the design force fallback is identified");
      assert.ok(elapsedMs < 10_000, `force stop bounded (${elapsedMs} ms), no infinite wait`);
      const stopped = await fx.waitForEvent("process.stopped", null, 10_000);
      assert.equal((stopped.payload as { forced: boolean }).forced, true);
      const stillAlive = liveSessionContainer();
      if (stillAlive !== null) {
        assert.equal(probeProcesses(stillAlive).filter((p) => isNodeProc(p) && p.cmd.includes("stubborn.js")).length, 0, "the process group is dead");
      }
    } finally {
      await fx.dispose();
    }
  });

  it("process tree cleanup: parent, child and grandchild all die with the logical stop", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node tree.js", process_id: "tree_root" }],
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      const containerId = liveSessionContainer();
      assert.ok(containerId);
      await eventually(() => {
        const procs = probeProcesses(containerId!);
        return (
          procs.filter((p) => isNodeProc(p) && p.cmd.includes("tree.js")).length === 1 &&
          procs.filter((p) => isNodeProc(p) && p.cmd.includes("tree_child.js")).length === 1 &&
          procs.filter((p) => isNodeProc(p) && p.cmd.includes("tree_grandchild.js")).length === 1
        );
      }, 10_000, "parent, child and grandchild all alive");
      // All three are in the SAME process group (no detached escape).
      const group = probeProcesses(containerId!).filter((p) => isNodeProc(p) && p.cmd.includes("tree"));
      const pgids = new Set(group.map((p) => p.pgid));
      assert.equal(pgids.size, 1, "parent/child/grandchild share one controlled process group");
      const stopResult = await fx.provider.stop(fx.session, "tree_root", "authored_stop");
      assert.equal(stopResult.outcome, "stopped");
      const after = liveSessionContainer();
      if (after !== null) {
        const remaining = probeProcesses(after).filter((p) => isNodeProc(p) && p.cmd.includes("tree"));
        assert.equal(remaining.length, 0, `no tree descendant survives (found ${remaining.map((p) => p.cmd).join(", ")})`);
      }
    } finally {
      await fx.dispose();
    }
  });

  it("natural exit: true exit code captured, canonical BACKGROUND_EXITED_EARLY, session fails and closes", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node quick_exit.js", process_id: "short_lived" }],
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      const exited = await fx.waitForEvent("process.exited", null, 10_000);
      assert.equal((exited.payload as { exit_code: number | null }).exit_code, 3, "the true exit code");
      const failed = await fx.waitForEvent("process.failed", null, 10_000);
      assert.equal((failed.payload as { code: string }).code, "BACKGROUND_EXITED_EARLY");
      const completion = await fx.waitForEvent("operation.completed", null, 10_000);
      assert.equal((completion.payload as { outcome: string; reason: string | null }).outcome, "FAIL");
      assert.equal((completion.payload as { reason: string | null }).reason, "BACKGROUND_EXITED_EARLY");
      await fx.waitForEvent("runtime.failed", (e) => (e.payload as { code: string }).code === "BACKGROUND_EXITED_EARLY", 15_000);
      const closed = await fx.waitForEvent("runtime.closed", null, 20_000);
      assert.equal((closed.payload as { cleanup_status: string }).cleanup_status, "confirmed");
      await eventually(() => containerIdsForInstallation().length === 0, 20_000, "container teardown after natural exit");
      // Historical STARTED retained: the process.exited event (with the true
      // code) is the registry's terminal record; the session closed itself,
      // so the provider session is no longer addressable.
      assert.equal(exited.process_id, "short_lived");
      // Reservation release + tombstone: the trusted admission records the
      // background completion (occupancy released), and the one-attempt-per-
      // generation tombstone still rejects a same-generation restart.
      const completed = fx.admissionSession.recordBackgroundCompletion("short_lived", "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id, "FAIL");
      assert.equal(completed.ok, true, `background completion recorded: ${completed.ok ? "" : completed.rejection.message}`);
      const releasedStop = fx.service.admitStopProcess(fx.identity, { session_id: fx.identity.session_id, process_id: "short_lived", request_id: "req-after-exit" });
      assert.equal(releasedStop.ok, false);
      assert.ok(!releasedStop.ok && releasedStop.rejection.code === "PROCESS_NOT_STARTED", "the occupancy mapping was released");
      const readmit = fx.service.admitRunOperation(fx.identity, {
        session_id: fx.identity.session_id,
        operation_id: "C01-L055-S001-B001",
        request_id: "req-restart",
      });
      assert.equal(readmit.ok, false);
      assert.ok(!readmit.ok && readmit.rejection.code === "DUPLICATE_START");
    } finally {
      try { await fx.dispose(); } catch { /* the session already failed and closed itself */ }
    }
  });

  it("duplicate start: a second concurrent start of one process is rejected with zero double spawn", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node long_run.js", process_id: "dev_server" }],
    });
    try {
      const grant = fx.grants.get("C01-L055-S001-B001")!;
      const results = await Promise.allSettled([
        fx.provider.start(fx.session, grant.operation_id, grant.attempt_id),
        fx.provider.start(fx.session, grant.operation_id, grant.attempt_id),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one start wins");
      assert.equal(rejected.length, 1);
      const error = (rejected[0] as PromiseRejectedResult).reason as Error & { code?: string };
      assert.equal(error.code, "DUPLICATE_START");
      const startedEvents = fx.events.filter((e) => e.type === "process.started");
      assert.equal(startedEvents.length, 1, "no second registry entry / no second process.started");
      const containerId = liveSessionContainer();
      assert.ok(containerId);
      assert.equal(probeProcesses(containerId!).filter((p) => isNodeProc(p) && p.cmd.includes("long_run.js")).length, 1, "only one real process exists");
      await fx.provider.stop(fx.session, "dev_server", "operator_stop");
    } finally {
      await fx.dispose();
    }
  });

  it("session close: every managed process dies, the container is removed, nothing owned remains", async () => {
    const fx = await openSessionFixture({
      ops: [
        { op_id: "C01-L055-S001-B001", command: "node long_run.js", process_id: "dev_server" },
        { op_id: "C01-L055-S001-B002", command: "node tick_server.js", process_id: "worker" },
      ],
    });
    try {
      const grantA = fx.grants.get("C01-L055-S001-B001")!;
      const grantB = fx.grants.get("C01-L055-S001-B002")!;
      await fx.provider.start(fx.session, grantA.operation_id, grantA.attempt_id);
      await fx.provider.start(fx.session, grantB.operation_id, grantB.attempt_id);
      assert.equal(fx.snapshot().filter((p) => p.state === "RUNNING").length, 2);
      assert.equal(containerIdsForInstallation().length, 1);
      const cleanup = await fx.provider.close(fx.session, "app_close");
      assert.equal(cleanup.cleanup_status, "confirmed");
      await eventually(() => containerIdsForInstallation().length === 0, 20_000, "container removed on close");
    } finally {
      try { await fx.dispose(); } catch { /* close already removed the leaf/session */ }
    }
  });

  it("lease/heartbeat healthy path: a session lives far beyond one lease while heartbeats renew it", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node long_run.js", process_id: "dev_server" }],
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      // 18 s > the 15 s guest lease: only continuous 2 s heartbeat renewal
      // keeps the container (and the managed process) alive this long.
      await eventually(() => fx.outputs("dev_server").stdout.includes("P55_LONG_TICK_60"), 25_000, "15 s of live output (> one lease)");
      const containerId = liveSessionContainer();
      assert.ok(containerId, "container alive beyond the lease window (healthy lease path)");
      assert.equal(fx.snapshot()[0]?.state, "RUNNING");
      const stopResult = await fx.provider.stop(fx.session, "dev_server", "operator_stop");
      assert.equal(stopResult.outcome, "stopped");
    } finally {
      await fx.dispose();
    }
  });

  it("lease loss: without renewal the guest fail-safe stops the groups and the container is torn down", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node long_run.js", process_id: "dev_server" }],
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P55_LONG_READY"), 10_000);
      // Simulate loss of the host control channel (stop renewing; the pipe
      // stays open â€” the real lease path, not an EOF).
      fx.provider.suspendLeaseRenewal(fx.session);
      const failed = await fx.waitForEvent("runtime.failed", (e) => (e.payload as { code: string }).code === "LEASE_EXPIRED", 25_000);
      assert.ok(failed, "the guest lease expiry fails the session");
      const closed = await fx.waitForEvent("runtime.closed", null, 20_000);
      assert.equal((closed.payload as { cleanup_status: string }).cleanup_status, "confirmed");
      await eventually(() => containerIdsForInstallation().length === 0, 20_000, "lease-loss cleanup removes the container");
    } finally {
      try { await fx.dispose(); } catch { /* the failed session already tore itself down */ }
    }
  });

  it("stale generation: old-generation requests reject STALE_SESSION, the old container is gone, and the definition runs only in the new generation", async () => {
    const sessionId = `sess-p55-${randomBytes(4).toString("hex")}`;
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node long_run.js", process_id: "dev_server" }],
      sessionId,
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      assert.equal(fx.snapshot()[0]?.state, "RUNNING");
      // Reset: admission bumps the generation.
      const reset = fx.service.resetRuntime(fx.identity, { session_id: sessionId, request_id: "req-reset" });
      assert.equal(reset.ok, true);
      const gen2Identity = reset.ok ? reset.value : null;
      assert.ok(gen2Identity && gen2Identity.generation === fx.identity.generation + 1);
      // Stale-generation requests (old identity) are rejected before any provider work.
      const staleIdentity = { session_id: sessionId, generation: fx.identity.generation };
      const staleStop = fx.service.admitStopProcess(staleIdentity, { session_id: sessionId, process_id: "dev_server", request_id: "req-stale-stop" });
      assert.equal(staleStop.ok, false);
      assert.ok(!staleStop.ok && staleStop.rejection.code === "STALE_SESSION", "stale stop rejected");
      const staleStart = fx.service.admitRunOperation(staleIdentity, { session_id: sessionId, operation_id: "C01-L055-S001-B001", request_id: "req-stale-start" });
      assert.equal(staleStart.ok, false);
      assert.ok(!staleStart.ok && staleStart.rejection.code === "STALE_SESSION", "stale start rejected");
      // The old generation's provider session is closed: its container (and
      // its process) must be gone.
      await fx.dispose();
      await eventually(() => containerIdsForInstallation().length === 0, 20_000, "old-generation container removed");

      // The definition runs again ONLY in the new generation (fresh leaf).
      const readmit = fx.service.admitRunOperation(gen2Identity!, {
        session_id: sessionId,
        operation_id: "C01-L055-S001-B001",
        request_id: "req-gen2",
      });
      assert.equal(readmit.ok, true, "the definition is reusable in the new generation");
      const gen2Grant = readmit.ok && readmit.value.kind === "execution_grant" ? readmit.value : null;
      assert.ok(gen2Grant && gen2Grant.generation === gen2Identity!.generation);
      const gen2Leaf = createSessionWorkspace(fx.wsRoot, {
        lesson_id: LESSON_ID,
        session_id: sessionId,
        generation: gen2Identity!.generation,
      });
      assert.ok(gen2Leaf.ok, `gen2 leaf failed: ${gen2Leaf.ok ? "" : gen2Leaf.error.message}`);
      if (!gen2Leaf.ok) return;
      for (const [name, content] of Object.entries(SCRIPTS)) {
        writeFileSync(join(gen2Leaf.value.host_root, name), content, "utf8");
      }
      const paths = resolveGrantWorkspace(gen2Leaf.value, gen2Grant!);
      assert.ok(paths.ok, "gen2 grant workspace resolved");
      if (!paths.ok) return;
      const mountPlan = buildWorkspaceMountPlan(paths.value);
      assert.ok(mountPlan.ok, "gen2 mount plan");
      if (!mountPlan.ok) return;
      const env = resolveEnvironmentPlan(Object.freeze({ TZ: "UTC" }), ["TZ"]);
      assert.ok(env.ok, "gen2 env plan");
      if (!env.ok) return;
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
      assert.ok(context.ok, "gen2 context resolved");
      if (!context.ok) return;
      const gen2Session = await fx.provider.prepare({
        session_id: sessionId,
        generation: gen2Identity!.generation,
        resolvedContext: context.value,
        grants: [gen2Grant!],
      });
      const gen2Events: ProviderEvent[] = [];
      const gen2Sub = fx.provider.events(gen2Session, (e) => gen2Events.push(e));
      try {
        const receipt = await fx.provider.start(gen2Session, "C01-L055-S001-B001", gen2Grant!.attempt_id);
        assert.equal(receipt.process_id, "dev_server");
        await eventually(() => {
          const outputs = gen2Events
            .filter((e) => e.type === "process.output" && e.process_id === "dev_server")
            .map((e) => (e.payload as { text: string }).text)
            .join("");
          return outputs.includes("P55_LONG_READY");
        }, 10_000, "gen2 process output");
        await fx.provider.stop(gen2Session, "dev_server", "operator_stop");
      } finally {
        gen2Sub.dispose();
        await fx.provider.close(gen2Session, "lesson_end");
        try { rmSync(gen2Leaf.value.host_root, { recursive: true, force: true }); } catch { /* after() covers */ }
      }
    } finally {
      try { await fx.dispose(); } catch { /* already disposed above */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container remains");
  });

  it("stop unknown process rejects INVALID_PROCESS_REFERENCE with no guest signal; stop of a stopped tombstone is already_exited", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node graceful.js", process_id: "graceful_proc" }],
    });
    try {
      await assert.rejects(
        fx.provider.stop(fx.session, "unknown_process", "operator_stop"),
        (error: Error & { code?: string }) => error.code === "INVALID_PROCESS_REFERENCE",
      );
      const containerId = liveSessionContainer();
      assert.ok(containerId, "the container survives the rejected stop");
      const grant = fx.grants.get("C01-L055-S001-B001")!;
      await fx.provider.start(fx.session, grant.operation_id, grant.attempt_id);
      const first = await fx.provider.stop(fx.session, "graceful_proc", "operator_stop");
      assert.equal(first.outcome, "stopped");
      const second = await fx.provider.stop(fx.session, "graceful_proc", "operator_stop");
      assert.equal(second.outcome, "already_exited", "repeat stop returns the existing result, no second signal");
      const stoppingEvents = fx.events.filter((e) => e.type === "process.stopping");
      assert.equal(stoppingEvents.length, 1, "no second stop flow ran");
    } finally {
      await fx.dispose();
    }
  });

  it("authored terminal_stop via admission resolves the trusted target and stops the running group", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node graceful.js", process_id: "graceful_proc" }],
      stopOps: [{ op_id: "C01-L055-S001-B002", process_id: "graceful_proc" }],
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P55_GRACEFUL_READY"), 10_000);
      // The compiled terminal_stop resolves through trusted state only:
      const stopAdmission = fx.stopAdmissions.get("C01-L055-S001-B002");
      assert.ok(stopAdmission, "the authored stop was admitted against the definition");
      assert.equal(stopAdmission.target.process_id, "graceful_proc");
      const result = await fx.provider.stop(fx.session, stopAdmission.target.process_id, "authored_stop");
      assert.equal(result.outcome, "stopped");
      assert.equal(result.forced, false);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P55_TERM_RECEIVED"), 10_000);
    } finally {
      await fx.dispose();
    }
  });

  it("background output never flows from a stale generation into a new session (close-before-reset discipline)", async () => {
    // Closing the old generation's provider session ends its output stream:
    // no late output may appear after the session is closed.
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L055-S001-B001", command: "node long_run.js", process_id: "dev_server" }],
    });
    try {
      await fx.provider.start(fx.session, "C01-L055-S001-B001", fx.grants.get("C01-L055-S001-B001")!.attempt_id);
      await fx.waitForEvent("process.output", null, 10_000);
      await fx.dispose();
      const countAtClose = fx.events.length;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      assert.equal(fx.events.length, countAtClose, "no late output events after session close");
    } finally {
      try { await fx.dispose(); } catch { /* already disposed above */ }
    }
  });
});

describe("P5.5 daemon-free guarantees (no Docker required)", () => {
  it("no node-pty / browser / typing machinery is referenced anywhere in the P5.5 additions", () => {
    const sources = [
      "../src/registry.ts",
      "../src/providers/docker.ts",
      "../container/process-groups.ts",
      "../container/supervisor.ts",
      "../container/protocol.ts",
    ];
    for (const rel of sources) {
      const code = readFileSync(join(here, rel), "utf8");
      assert.equal(/\bnode-pty\b|playwright|puppeteer|xterm|type_code|selenium/.test(code), false, `${rel} is free of PTY/browser/typing machinery`);
    }
  });

  it("the guest process table never touches the host filesystem or network builtins", () => {
    const code = readFileSync(join(here, "../container/process-groups.ts"), "utf8");
    for (const builtin of ["node:fs", "node:net", "node:http", "node:child_process"]) {
      assert.equal(code.includes(builtin), false, `process-groups.ts must not import ${builtin}`);
    }
  });
});
