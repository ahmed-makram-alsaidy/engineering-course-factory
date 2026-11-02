// P5.8 REAL Docker integration — canonical BACKGROUND execution ("Start/
// lifetime distinction/IDs/early exit"; PASS "Independent stable mappings/
// streams"), proven end-to-end against the actual local Docker daemon:
//
//   canonical admission (compiled synthetic fixture -> catalog -> session ->
//   grants) -> trusted workspace leaf -> DockerSandboxProvider -> live
//   session container -> guest supervisor process groups -> background
//   lifetime state machine -> canonical terminal traces.
//
// Every resource is prefixed cf-p58- (installation label cf-p58-installation)
// under the repository's ignored temp root; production course content is
// untouched. Tests are skipped (never silently passed) only when the daemon
// or the supervisor runtime image is unavailable — the P5.8 gate REQUIRES a
// real run and fails otherwise. Every test's finally/after removes only its
// own owned containers (never a global prune).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSandboxProvider, type DockerProviderConfig } from "../src/providers/docker.ts";
import type { AdmittedSession, ProviderEvent, ProviderSession } from "../src/providers/execution-provider.ts";
import type { ExecutionGrant } from "../src/admission.ts";
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
const TEST_ROOT = join(repoRoot, "temp", "P5.8");
const WS_ROOT = join(TEST_ROOT, "workspaces-root");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5.8";
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_BASE_DIGEST = PINNED_BASE.split("@")[1]!;
const INSTALLATION_ID = "cf-p58-installation";
const INSTALL_LABEL = "com.course-factory.installation";
const LESSON_ID = "C01-L058";

function resolveDockerExe(): string {
  const configured = process.env.CF_P58_DOCKER_EXE ?? process.env.CF_P54_DOCKER_EXE;
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
  const configured = process.env.CF_P58_RUNTIME_IMAGE;
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
    "--description", "course-factory p5.8 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

// -- synthetic lesson scripts (seeded into the session leaf; guest-only) ------

const STREAM_TAGS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"] as const;

function streamScript(tag: string): string {
  return [
    `console.log('P58_${tag}_READY');`,
    "let n = 0;",
    "const t = setInterval(() => {",
    "  n += 1;",
    "  const w = require('node:fs').writeSync;",
    "  w(1, `P58_" + tag + "_OUT_${n}\\n`);",
    "  w(2, `P58_" + tag + "_ERR_${n}\\n`);",
    "  if (n >= 200) clearInterval(t);",
    "}, 150);",
    "setTimeout(() => process.exit(0), 25000);",
  ].join("\n");
}

const SCRIPTS: Record<string, string> = {
  "p58_stream_alpha.js": streamScript("ALPHA"),
  "p58_stream_bravo.js": streamScript("BRAVO"),
  "p58_stream_charlie.js": streamScript("CHARLIE"),
  "p58_stream_delta.js": streamScript("DELTA"),
  "p58_graceful.js": [
    "process.on('SIGINT', () => { console.log('P58_TERM_RECEIVED'); setTimeout(() => process.exit(0), 100); });",
    "process.on('SIGTERM', () => { console.log('P58_TERM_RECEIVED'); setTimeout(() => process.exit(0), 100); });",
    "console.log('P58_GRACEFUL_READY');",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 25000);",
  ].join("\n"),
  "p58_stubborn.js": [
    "process.on('SIGINT', () => { /* ignores the graceful signal */ });",
    "process.on('SIGTERM', () => { /* ignores the graceful signal */ });",
    "console.log('P58_STUBBORN_READY');",
    "setInterval(() => {}, 500);",
    "setTimeout(() => process.exit(0), 25000);",
  ].join("\n"),
  "p58_quick_exit.js": [
    "console.log('P58_EXIT_SOON');",
    "setTimeout(() => process.exit(0), 400);",
  ].join("\n"),
  "p58_long_run.js": [
    "console.log('P58_LONG_READY');",
    "let i = 0;",
    "const t = setInterval(() => { i += 1; console.log('P58_LONG_TICK_' + i); }, 250);",
    "setTimeout(() => process.exit(0), 25000);",
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

function lessonSource(ops: readonly OpSpec[]): unknown {
  const beats = ops.map((op) => ({
    beat_id: op.op_id,
    kind: "action",
    action: {
      type: "terminal_run",
      command: op.command,
      mode: "background",
      process_id: op.process_id,
      ...(op.cwd !== undefined ? { cwd: op.cwd } : {}),
    },
  }));
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: LESSON_ID,
    title: "P5.8 synthetic background lifetime lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Background lifetime distinctions in the P5 sandbox"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p58"],
    metadata: { synthetic_fixture: true, phase: "P5.8" },
    scenes: [
      {
        scene_id: `${LESSON_ID}-S001`,
        type: "code_demo",
        title: "Background lifetimes",
        duration: 120,
        visual: { kind: "terminal", description: "synthetic" },
        beats,
      },
    ],
  };
}

function makeProvider(ceilingMs?: number): DockerSandboxProvider {
  const config: DockerProviderConfig = {
    cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR, clientEnv: {} },
    imageReference: RUNTIME_IMAGE_REF!,
    installationId: INSTALLATION_ID,
  };
  if (ceilingMs !== undefined) {
    // Diagnostics-only session-ceiling override (trusted machine config; lets
    // the real integration suite prove the 30-minute session ceiling
    // end-to-end without waiting 30 minutes).
    (config as { diagnosticsSessionCeilingMs?: number }).diagnosticsSessionCeilingMs = ceilingMs;
  }
  return new DockerSandboxProvider(config);
}

interface TimedEvent {
  readonly event: ProviderEvent;
  readonly at: number;
}

interface P58Fixture {
  readonly provider: DockerSandboxProvider;
  readonly session: ProviderSession;
  readonly events: TimedEvent[];
  readonly grants: ReadonlyMap<string, ExecutionGrant>;
  readonly identity: RuntimeSessionIdentity;
  readonly service: AdmissionService;
  readonly admissionSession: AdmissionSession;
  readonly leafPath: string;
  readonly primaryGrant: ExecutionGrant;
  waitForEvent(type: ProviderEvent["type"], predicate: ((event: ProviderEvent) => boolean) | null, timeoutMs: number): Promise<ProviderEvent>;
  outputs(processId?: string): { stdout: string; stderr: string };
  snapshot(): ReturnType<DockerSandboxProvider["processSnapshot"]>;
  /** Index of the runtime.closed event (for no-event-after-closed assertions). */
  closedIndex(): number;
  dispose(): Promise<void>;
}

async function openSessionFixture(args: {
  ops: readonly OpSpec[];
  ceilingMs?: number;
  sessionId?: string;
}): Promise<P58Fixture> {
  const sessionId = args.sessionId ?? `sess-p58-${randomBytes(4).toString("hex")}`;
  const raw = lessonSource(args.ops);
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

  const provider = makeProvider(args.ceilingMs);
  const admittedSession: AdmittedSession = {
    session_id: sessionId,
    generation: identity.generation,
    resolvedContext: context.value,
    grants: [...grants.values()],
  };
  const session = await provider.prepare(admittedSession);
  const events: TimedEvent[] = [];
  const subscription = provider.events(session, (event) => events.push({ event, at: Date.now() }));

  const fixture: P58Fixture = {
    provider,
    session,
    events,
    grants,
    identity,
    service,
    admissionSession: opened.value,
    leafPath: leaf.value.host_root,
    primaryGrant,
    async waitForEvent(type, predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = [...events].reverse().find(({ event }) => {
          if (event.type !== type) return false;
          return predicate === null || predicate(event);
        });
        if (found !== undefined) return found.event;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    },
    outputs(processId) {
      let stdout = "";
      let stderr = "";
      for (const { event } of events) {
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
    closedIndex() {
      return events.findIndex(({ event }) => event.type === "runtime.closed");
    },
    async dispose() {
      subscription.dispose();
      await provider.close(session, "lesson_end");
      try { rmSync(leaf.value.host_root, { recursive: true, force: true }); } catch { /* explicit below */ }
    },
  };
  return fixture;
}

async function eventually(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms: ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function opId(index: number): string {
  return `C01-L058-S001-B00${index}`;
}

/** Assert no event of any kind follows the session's runtime.closed event. */
function assertNothingAfterClosed(fx: P58Fixture): void {
  const closed = fx.closedIndex();
  assert.ok(closed >= 0, "the session closed");
  assert.equal(fx.events.length, closed + 1, "no event after runtime.closed");
}

// -----------------------------------------------------------------------------

describe("P5.8 real Docker background lifetime integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(WS_ROOT, { recursive: true });
    ensureConfigContext();
  });

  after(() => {
    for (const id of containerIdsForInstallation()) docker("rm", "--force", id);
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("independent stable mappings/streams: four concurrent background lifetimes keep exclusive per-ID streams and prompt STARTED receipts", async () => {
    const fx = await openSessionFixture({
      ops: [1, 2, 3, 4].map((index) => ({
        op_id: opId(index),
        command: `node p58_stream_${["alpha", "bravo", "charlie", "delta"][index - 1]!}.js`,
        process_id: `proc_${index}`,
      })),
    });
    try {
      // Four concurrent starts (the admission cap); every receipt resolves
      // while its lifetime continues (start/lifetime distinction).
      const receiptAt = new Map<string, number>();
      for (let index = 1; index <= 4; index++) {
        const grant = fx.grants.get(opId(index))!;
        const receipt = await fx.provider.start(fx.session, grant.operation_id, grant.attempt_id);
        assert.equal(receipt.process_id, `proc_${index}`);
        assert.equal(receipt.result, undefined, "background receipts carry no result (event-driven lifetimes)");
        receiptAt.set(`proc_${index}`, Date.now());
      }
      assert.equal(fx.snapshot().filter((p) => p.state === "RUNNING").length, 4, "all four lifetimes RUNNING");
      assert.equal(containerIdsForInstallation().length, 1, "one container shares all session operations");

      // Independent stable streams: each id produces its OWN tagged output on
      // BOTH streams; no cross-contamination; per-stream order is preserved.
      await eventually(() =>
        STREAM_TAGS.every((_, i) => {
          const out = fx.outputs(`proc_${i + 1}`);
          return (out.stdout.match(/OUT_(\d+)/g) ?? []).length >= 3 && (out.stderr.match(/ERR_(\d+)/g) ?? []).length >= 3;
        }), 15_000, "each lifetime produced tagged stdout AND stderr");
      for (let index = 1; index <= 4; index++) {
        const tag = STREAM_TAGS[index - 1]!;
        const out = fx.outputs(`proc_${index}`);
        assert.ok(out.stdout.includes(`P58_${tag}_OUT_`), `lifetime ${index} stdout carries its own tag`);
        assert.ok(out.stderr.includes(`P58_${tag}_ERR_`), `lifetime ${index} stderr carries its own tag`);
        for (const other of STREAM_TAGS) {
          if (other === tag) continue;
          assert.ok(!out.stdout.includes(`P58_${other}_`), `no cross-contamination of ${other} into lifetime ${index} stdout`);
          assert.ok(!out.stderr.includes(`P58_${other}_`), `no cross-contamination of ${other} into lifetime ${index} stderr`);
        }
        // Per-stream arrival order is strictly increasing (per-stream byte order).
        for (const stream of ["stdout", "stderr"] as const) {
          const numbers: number[] = [];
          for (const { event } of fx.events) {
            if (event.type !== "process.output" || event.process_id !== `proc_${index}`) continue;
            const payload = event.payload as { stream: string; text: string };
            if (payload.stream !== stream) continue;
            for (const match of payload.text.matchAll(/_(?:OUT|ERR)_(\d+)/g)) numbers.push(Number(match[1]));
          }
          assert.ok(numbers.length >= 3, `lifetime ${index} ${stream} has numbered output`);
          for (let k = 1; k < numbers.length; k++) {
            assert.ok(numbers[k]! > numbers[k - 1]!, `lifetime ${index} ${stream} per-stream order preserved`);
          }
        }
        // Output continues after the receipt (the receipt is not a readiness/
        // completion claim — the lifetime kept streaming afterwards).
        const laterOutput = fx.events.some(({ event, at }) =>
          event.type === "process.output" && event.process_id === `proc_${index}` && at > receiptAt.get(`proc_${index}`)!);
        assert.ok(laterOutput, `lifetime ${index} kept streaming after its STARTED receipt`);
      }

      // Graceful stop of one lifetime; the others keep streaming; the
      // session (and its container) stays alive.
      const grantA = fx.grants.get(opId(1))!;
      const stopResult = await fx.provider.stop(fx.session, "proc_1", "authored_stop");
      assert.equal(stopResult.outcome, "stopped");
      assert.equal(stopResult.forced, false, "graceful stop is not forced");
      const completed = await fx.waitForEvent("operation.completed", (e) => e.process_id === "proc_1", 10_000);
      assert.equal((completed.payload as { outcome: string; reason: string | null }).outcome, "PASS", "the authored stop PASSes the lifetime");
      assert.equal((completed.payload as { reason: string | null }).reason, null);
      const ticksBefore = (fx.outputs("proc_2").stdout.match(/OUT_(\d+)/g) ?? []).length;
      await eventually(() => (fx.outputs("proc_2").stdout.match(/OUT_(\d+)/g) ?? []).length > ticksBefore, 10_000,
        "sibling lifetime keeps streaming after the authored stop");
      assert.equal(fx.snapshot().find((p) => p.process_id === "proc_2")?.state, "RUNNING");
    } finally {
      await fx.dispose();
    }
  });

  it("authored stop can PASS forced=true after confirmed death (SIGINT-ignoring group, bounded)", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: opId(1), command: "node p58_stubborn.js", process_id: "stubborn_proc" }],
    });
    try {
      await fx.provider.start(fx.session, opId(1), fx.grants.get(opId(1))!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P58_STUBBORN_READY"), 10_000);
      const t0 = Date.now();
      const stopResult = await fx.provider.stop(fx.session, "stubborn_proc", "authored_stop");
      const elapsedMs = Date.now() - t0;
      assert.equal(stopResult.outcome, "stopped");
      assert.equal(stopResult.forced, true, "the SIGKILL fallback was required and reported");
      assert.ok(elapsedMs < 12_000, `force stop bounded (${elapsedMs} ms)`);
      const completed = await fx.waitForEvent("operation.completed", null, 10_000);
      assert.equal((completed.payload as { outcome: string; forced: boolean }).outcome, "PASS", "authored stop PASSes after confirmed death");
      assert.equal((completed.payload as { forced: boolean }).forced, true);
      const stopped = await fx.waitForEvent("process.stopped", null, 10_000);
      assert.equal((stopped.payload as { forced: boolean }).forced, true);
      assert.ok(fx.events.findIndex((e) => e.event.type === "process.stopped") < fx.events.findIndex((e) => e.event.type === "operation.completed"),
        "process.stopped precedes the final result");
    } finally {
      await fx.dispose();
    }
  });

  it("operator stop finalizes the lifetime SKIPPED/CANCELLED with a null exit code", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: opId(1), command: "node p58_graceful.js", process_id: "graceful_proc" }],
    });
    try {
      await fx.provider.start(fx.session, opId(1), fx.grants.get(opId(1))!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P58_GRACEFUL_READY"), 10_000);
      const stopResult = await fx.provider.stop(fx.session, "graceful_proc", "operator_stop");
      assert.equal(stopResult.outcome, "stopped");
      assert.equal(stopResult.forced, false);
      const completed = await fx.waitForEvent("operation.completed", null, 10_000);
      assert.equal((completed.payload as { outcome: string }).outcome, "SKIPPED", "operator stop is not an authored completion");
      assert.equal((completed.payload as { reason: string | null }).reason, "CANCELLED");
      assert.equal((completed.payload as { exit_code: number | null }).exit_code, null, "no invented exit code");
      // The session stays alive after a confirmed stop.
      assert.equal(containerIdsForInstallation().length, 1);
    } finally {
      await fx.dispose();
    }
  });

  it("early exit while a sibling runs: one immutable FAIL/BACKGROUND_EXITED_EARLY result, session fails and closes, STARTED facts retained", async () => {
    const fx = await openSessionFixture({
      ops: [
        { op_id: opId(1), command: "node p58_quick_exit.js", process_id: "short_lived" },
        { op_id: opId(2), command: "node p58_long_run.js", process_id: "sibling" },
      ],
    });
    try {
      await fx.provider.start(fx.session, opId(1), fx.grants.get(opId(1))!.attempt_id);
      await fx.provider.start(fx.session, opId(2), fx.grants.get(opId(2))!.attempt_id);
      const exited = await fx.waitForEvent("process.exited", (e) => e.process_id === "short_lived", 10_000);
      assert.equal((exited.payload as { exit_code: number | null }).exit_code, 0, "the TRUE exit code (0 is still an early exit)");
      const failed = await fx.waitForEvent("process.failed", null, 10_000);
      assert.equal((failed.payload as { code: string }).code, "BACKGROUND_EXITED_EARLY");
      const completion = await fx.waitForEvent("operation.completed", null, 10_000);
      assert.equal((completion.payload as { outcome: string; reason: string | null; exit_code: number | null }).outcome, "FAIL");
      assert.equal((completion.payload as { reason: string | null }).reason, "BACKGROUND_EXITED_EARLY");
      assert.equal((completion.payload as { exit_code: number | null }).exit_code, 0);
      await fx.waitForEvent("runtime.failed", (e) => (e.payload as { code: string }).code === "BACKGROUND_EXITED_EARLY", 15_000);
      const closed = await fx.waitForEvent("runtime.closed", null, 20_000);
      assert.equal((closed.payload as { cleanup_status: string }).cleanup_status, "confirmed");
      assertNothingAfterClosed(fx);
      // STARTED facts retained: both lifetimes started before the terminal trace.
      const startedIds = fx.events.filter(({ event }) => event.type === "process.started").map(({ event }) => event.process_id);
      assert.deepEqual(startedIds.sort(), ["short_lived", "sibling"], "historical STARTED facts retained");
      // No final result was published for the interrupted sibling (session
      // closing is not a per-operation outcome).
      const siblingCompleted = fx.events.filter(({ event }) =>
        event.type === "operation.completed" && event.process_id === "sibling");
      assert.equal(siblingCompleted.length, 0, "no final result for the lifetime the session closing interrupted");
      await eventually(() => containerIdsForInstallation().length === 0, 20_000, "container teardown after the early exit");
      // Admission tombstone: the completion is recorded, the occupancy
      // mapping is released, and the one-attempt-per-generation tombstone
      // still rejects a same-generation restart.
      const grant = fx.grants.get(opId(1))!;
      const recorded = fx.admissionSession.recordBackgroundCompletion("short_lived", grant.operation_id, grant.attempt_id, "FAIL");
      assert.equal(recorded.ok, true, `background completion recorded: ${recorded.ok ? "" : recorded.rejection.message}`);
      const restart = fx.service.admitRunOperation(fx.identity, {
        session_id: fx.identity.session_id,
        operation_id: grant.operation_id,
        request_id: "req-restart",
      });
      assert.equal(restart.ok, false);
      assert.ok(!restart.ok && restart.rejection.code === "DUPLICATE_START", "no restart policy in the same generation");
    } finally {
      try { await fx.dispose(); } catch { /* the failed session already tore itself down */ }
    }
  });

  it("session ceiling: the session closes with cause session_expiry, the active lifetime gets no final result, cleanup confirmed", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: opId(1), command: "node p58_long_run.js", process_id: "dev_server" }],
      ceilingMs: 4_000,
    });
    try {
      await fx.provider.start(fx.session, opId(1), fx.grants.get(opId(1))!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P58_LONG_READY"), 10_000);
      const closing = await fx.waitForEvent("runtime.closing", (e) => (e.payload as { cause: string }).cause === "session_expiry", 12_000);
      assert.ok(closing, "the session ceiling closes the session (cause session_expiry)");
      const closed = await fx.waitForEvent("runtime.closed", null, 20_000);
      assert.equal((closed.payload as { cleanup_status: string }).cleanup_status, "confirmed");
      assertNothingAfterClosed(fx);
      const completed = fx.events.filter(({ event }) => event.type === "operation.completed");
      assert.equal(completed.length, 0, "the ceiling is not a per-operation outcome (no final result)");
      await eventually(() => containerIdsForInstallation().length === 0, 20_000, "ceiling cleanup removes the container");
    } finally {
      try { await fx.dispose(); } catch { /* the session already closed itself */ }
    }
  });

  it("idempotent close after the ceiling: close() returns the real cleanup status and stays quiet", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: opId(1), command: "node p58_long_run.js", process_id: "dev_server" }],
      ceilingMs: 3_000,
    });
    try {
      await fx.provider.start(fx.session, opId(1), fx.grants.get(opId(1))!.attempt_id);
      await fx.waitForEvent("runtime.closed", null, 20_000);
      const eventsAtClose = fx.events.length;
      const cleanup = await fx.provider.close(fx.session, "app_close");
      assert.equal(cleanup.cleanup_status, "confirmed", "idempotent close returns the real cleanup status");
      assert.equal(cleanup.cause, "app_close");
      assert.equal(fx.events.length, eventsAtClose, "no new event after the session already closed");
      await eventually(() => containerIdsForInstallation().length === 0, 20_000, "no owned container remains");
    } finally {
      try { await fx.dispose(); } catch { /* the session already closed itself */ }
    }
  });
});
