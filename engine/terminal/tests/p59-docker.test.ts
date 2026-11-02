// P5.9 REAL Docker integration — canonical STOP/CRASH/TEARDOWN ("SIGINT/KILL,
// fallback remove, main/helper loss/reconciliation"; PASS condition "No owned
// container/descendant survivors"), proven end-to-end against the actual
// local Docker daemon:
//
//   canonical admission (compiled synthetic fixture -> catalog -> session ->
//   grants) -> trusted workspace leaf -> DockerSandboxProvider -> live
//   session container -> guest supervisor process groups -> stop/crash
//   semantics -> reconciliation.
//
// Covered here (the SIGINT/SIGKILL group semantics themselves are canonical
// P5.5 evidence, re-proven by the chained gate):
//   - group escape: a setsid/daemonized descendant that survives a stop is
//     never accepted as a clean stop — the classification is
//     UNEXPECTED_DESCENDANTS and the whole container is torn down (the final
//     authority over any escapee); a streaming PEER lifetime is explicitly
//     cancelled (no final result after the session's terminal trace).
//   - helper loss: the attached supervisor CLI dying while a background
//     lifetime streams is a transport failure with bounded removal.
//   - main loss: the host->guest pipe closing with renewal suspended (dead
//     main, surviving helper) is covered by the guest fail-safe (EOF stops
//     every group and exits within the 5 s deadline) and/or the lease —
//     bounded removal either way.
//   - daemon outage: reconciliation against an unreachable endpoint reports
//     an explicit "unavailable" status (ledger preserved, never a silent
//     success) and does not produce a false CLEANUP_UNCONFIRMED block.
//   - launch reconciliation: removes EXACTLY the abandoned owned container
//     (owner/phase/installation label scope), never a global prune; zero
//     owned resources remain.
//
// Every resource is prefixed cf-p59- (installation label cf-p59-installation)
// under the repository's ignored temp root; production course content is
// untouched. Tests are skipped (never silently passed) only when the daemon
// or the supervisor runtime image is unavailable — the P5.9 gate REQUIRES a
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
} from "../src/workspace.ts";
import { resolveEnvironmentPlan } from "../src/environment.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P5.9");
const WS_ROOT = join(TEST_ROOT, "workspaces-root");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");
const OUTAGE_CONFIG_DIR = join(TEST_ROOT, "docker-config-outage");
const OUTAGE_CONTEXT = "cf-p59-unreachable";

const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5.9";
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_BASE_DIGEST = PINNED_BASE.split("@")[1]!;
const INSTALLATION_ID = "cf-p59-installation";
const INSTALL_LABEL = "com.course-factory.installation";
const LESSON_ID = "C01-L059";

function resolveDockerExe(): string {
  const configured = process.env.CF_P59_DOCKER_EXE ?? process.env.CF_P54_DOCKER_EXE;
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
  const configured = process.env.CF_P59_RUNTIME_IMAGE;
  if (configured !== undefined && /^sha256:[0-9a-f]{64}$/.test(configured)) return configured;
  for (const tag of [RUNTIME_IMAGE_TAG, "cf-terminal-engine-runtime:p5.8"]) {
    const r = docker("image", "inspect", tag, "--format", "{{.Id}}");
    if (r.status === 0) {
      const id = r.stdout.trim();
      if (/^sha256:[0-9a-f]{64}$/.test(id)) return id;
    }
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
    "--description", "course-factory p5.9 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

// -- synthetic guest scripts ---------------------------------------------------

const P59_STREAM = [
  "console.log('P59_PEER_READY');",
  "let i = 0;",
  "const t = setInterval(() => { i += 1; console.log('P59_PEER_TICK_' + i); }, 200);",
  "setTimeout(() => process.exit(0), 25000);",
].join("\n");

const SCRIPTS: Record<string, string> = { "p59_stream.js": P59_STREAM };

/** A background command that daemonizes a setsid descendant and keeps the managed group alive. */
const ESCAPE_COMMAND =
  "setsid sh -c 'sleep 25' >/dev/null 2>&1 & echo P59_ESCAPE_READY; sleep 25";

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
    },
  }));
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: LESSON_ID,
    title: "P5.9 synthetic stop/crash/teardown lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Stop, crash and teardown semantics in the P5 sandbox"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p59"],
    metadata: { synthetic_fixture: true, phase: "P5.9" },
    scenes: [
      {
        scene_id: `${LESSON_ID}-S001`,
        type: "code_demo",
        title: "Stop / crash / teardown",
        duration: 120,
        visual: { kind: "terminal", description: "synthetic" },
        beats,
      },
    ],
  };
}

function makeProvider(outageContext: string | null = null): DockerSandboxProvider {
  const config: DockerProviderConfig = {
    cli: {
      dockerExe: DOCKER_EXE,
      context: outageContext ?? "desktop-linux",
      configDir: outageContext !== null ? OUTAGE_CONFIG_DIR : CONFIG_DIR,
      clientEnv: {},
    },
    imageReference: RUNTIME_IMAGE_REF!,
    installationId: INSTALLATION_ID,
  };
  return new DockerSandboxProvider(config);
}

interface TimedEvent {
  readonly event: ProviderEvent;
  readonly at: number;
}

interface P59Fixture {
  readonly provider: DockerSandboxProvider;
  readonly session: ProviderSession;
  readonly events: TimedEvent[];
  readonly grants: ReadonlyMap<string, ExecutionGrant>;
  readonly identity: RuntimeSessionIdentity;
  readonly leafPath: string;
  readonly sessionId: string;
  waitForEvent(type: ProviderEvent["type"], predicate: ((event: ProviderEvent) => boolean) | null, timeoutMs: number): Promise<ProviderEvent>;
  outputs(processId?: string): { stdout: string; stderr: string };
  closedIndex(): number;
  dispose(): Promise<void>;
}

async function openSessionFixture(args: { ops: readonly OpSpec[] }): Promise<P59Fixture> {
  const sessionId = `sess-p59-${randomBytes(4).toString("hex")}`;
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
    grants: [...grants.values()],
  };
  const session = await provider.prepare(admittedSession);
  const events: TimedEvent[] = [];
  const subscription = provider.events(session, (event) => events.push({ event, at: Date.now() }));

  const fixture: P59Fixture = {
    provider,
    session,
    events,
    grants,
    identity,
    leafPath: leaf.value.host_root,
    sessionId,
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
    closedIndex() {
      return events.findIndex(({ event }) => event.type === "runtime.closed");
    },
    async dispose() {
      subscription.dispose();
      try { await provider.close(session, "lesson_end"); } catch { /* teardown already resolved it */ }
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
  return `C01-L059-S001-B00${index}`;
}

function payloadOf(event: ProviderEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

/** Assert no event of any kind follows the session's runtime.closed event. */
function assertNothingAfterClosed(fx: P59Fixture): void {
  const closed = fx.closedIndex();
  assert.ok(closed >= 0, "the session closed");
  assert.equal(fx.events.length, closed + 1, "no event after runtime.closed");
  const closedPayload = payloadOf(fx.events[closed]!.event);
  assert.equal(closedPayload.cleanup_status, "confirmed", "cleanup confirmed");
}

// -----------------------------------------------------------------------------

describe("P5.9 real Docker stop/crash/teardown integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(WS_ROOT, { recursive: true });
    mkdirSync(OUTAGE_CONFIG_DIR, { recursive: true });
    ensureConfigContext();
  });

  after(() => {
    for (const id of containerIdsForInstallation()) docker("rm", "--force", id);
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("group escape: a setsid descendant surviving a stop forces full-container teardown; the peer is cancelled; no survivor", async () => {
    const fx = await openSessionFixture({
      ops: [
        { op_id: opId(1), command: ESCAPE_COMMAND, process_id: "escape_proc" },
        { op_id: opId(2), command: "node p59_stream.js", process_id: "peer_proc" },
      ],
    });
    const startedAt = Date.now();
    try {
      await fx.provider.start(fx.session, opId(1), fx.grants.get(opId(1))!.attempt_id);
      await fx.provider.start(fx.session, opId(2), fx.grants.get(opId(2))!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P59_ESCAPE_READY"), 10_000);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P59_PEER_READY"), 10_000);
      assert.equal(containerIdsForInstallation().length, 1, "one container shares the session");

      const stopStartedAt = Date.now();
      const stopResult = await fx.provider.stop(fx.session, "escape_proc", "operator_stop");
      assert.equal(stopResult.outcome, "stopped", "the stop resolves (container teardown is the authority over the escape)");

      // The escape is disclosed: the lifetime never PASSes a clean stop.
      const completed = await fx.waitForEvent("operation.completed", (e) => e.process_id === "escape_proc", 20_000);
      assert.equal((completed.payload as { outcome: string }).outcome, "FAIL");
      assert.equal((completed.payload as { reason: string | null }).reason, "UNEXPECTED_DESCENDANTS");

      // The session fails and closes; cleanup is confirmed; the container
      // (the final authority over the escapee) is gone.
      await fx.waitForEvent("runtime.failed", null, 10_000);
      await fx.waitForEvent("runtime.closed", null, 15_000);
      assertNothingAfterClosed(fx);

      // Explicit peer cancellation: the streaming sibling is aborted with the
      // session (no final result of any kind after the session's terminal
      // trace — the ceiling/closing rule).
      assert.equal(
        fx.events.some(({ event }) => event.type === "operation.completed" && event.process_id === "peer_proc"),
        false,
        "the interrupted peer lifetime publishes no final result",
      );

      // Bounded removal BEFORE the escaped sleep's own 25 s self-expiry: the
      // survivor was killed by the container teardown, not by natural death.
      const elapsedMs = Date.now() - startedAt;
      await eventually(() => containerIdsForInstallation().length === 0, 20_000, "owned container removed");
      assert.ok(elapsedMs < 22_000, `teardown completed in ${elapsedMs} ms, well before the escaped sleep's 25 s self-expiry`);
      const stopElapsedMs = Date.now() - stopStartedAt;
      assert.ok(stopElapsedMs < 20_000, `stop-to-removal bounded (${stopElapsedMs} ms)`);
    } finally {
      await fx.dispose();
    }
  });

  it("helper loss: the attached supervisor CLI dying yields TRANSPORT_FAILED and bounded removal; no survivor", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: opId(1), command: "node p59_stream.js", process_id: "solo_proc" }],
    });
    try {
      await fx.provider.start(fx.session, opId(1), fx.grants.get(opId(1))!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P59_PEER_READY"), 10_000);
      const lossStartedAt = Date.now();

      fx.provider.diagnosticsSeverTransport(fx.session);

      const failed = await fx.waitForEvent("runtime.failed", null, 15_000);
      assert.equal((failed.payload as { code: string }).code, "TRANSPORT_FAILED");
      await fx.waitForEvent("runtime.closed", null, 15_000);
      assertNothingAfterClosed(fx);
      await eventually(() => containerIdsForInstallation().length === 0, 15_000, "owned container removed");
      const elapsedMs = Date.now() - lossStartedAt;
      assert.ok(elapsedMs < 15_000, `helper loss removal bounded (${elapsedMs} ms)`);
    } finally {
      await fx.dispose();
    }
  });

  it("main loss: pipe close with renewal suspended lets the guest fail-safe stop everything; bounded removal; no survivor", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: opId(1), command: "node p59_stream.js", process_id: "solo_proc" }],
    });
    try {
      await fx.provider.start(fx.session, opId(1), fx.grants.get(opId(1))!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P59_PEER_READY"), 10_000);
      const lossStartedAt = Date.now();

      // A dead main: no more heartbeats, and the host->guest pipe closes.
      fx.provider.suspendLeaseRenewal(fx.session);
      fx.provider.diagnosticsCloseStdin(fx.session);

      await fx.waitForEvent("runtime.closed", null, 20_000);
      assertNothingAfterClosed(fx);
      await eventually(() => containerIdsForInstallation().length === 0, 15_000, "owned container removed");
      const elapsedMs = Date.now() - lossStartedAt;
      // The guest's EOF fail-safe deadline is 5 s; even with the host's own
      // teardown racing, the removal is bounded well under the lease.
      assert.ok(elapsedMs < 20_000, `main-loss removal bounded (${elapsedMs} ms)`);
    } finally {
      await fx.dispose();
    }
  });

  it("daemon outage: reconciliation reports an explicit unavailable status and never blocks with a false CLEANUP_UNCONFIRMED", async () => {
    // A REAL failing Docker invocation: an unreachable (nonexistent) context
    // in a private test-owned config directory.
    const provider = makeProvider(OUTAGE_CONTEXT);
    const report = await provider.reconcileRecordedSessions();
    assert.equal(report.status, "unavailable");
    assert.equal(report.scanned, 0);
    assert.equal(report.reconciled.length, 0);
    assert.equal(report.unconfirmed.length, 0);

    // The outage is not an unconfirmed cleanup: prepare proceeds past the
    // launch reconcile and fails on its own merits (the unreachable
    // endpoint), never with CLEANUP_UNCONFIRMED.
    let prepareError: unknown = null;
    try {
      await provider.prepare({
        session_id: "sess-p59-outage",
        generation: 1,
        resolvedContext: undefined,
      } as unknown as AdmittedSession);
    } catch (error) {
      prepareError = error;
    }
    assert.ok(prepareError !== null, "prepare rejects against the unreachable endpoint");
    const code = (prepareError as Error & { code?: string }).code ?? "";
    assert.notEqual(code, "CLEANUP_UNCONFIRMED", "an outage must not masquerade as an unconfirmed cleanup");
    assert.equal(containerIdsForInstallation().length, 0, "no container was created by the outage probe");
  });

  it("launch reconciliation removes exactly the abandoned owned container (label-scoped; zero owned resources remain)", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: opId(1), command: "node p59_stream.js", process_id: "solo_proc" }],
    });
    let abandonedId: string | null = null;
    let reconciledBy: DockerSandboxProvider | null = null;
    try {
      await fx.provider.start(fx.session, opId(1), fx.grants.get(opId(1))!.attempt_id);
      await fx.waitForEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P59_PEER_READY"), 10_000);
      const ids = containerIdsForInstallation();
      assert.equal(ids.length, 1, "one owned container is live");
      abandonedId = ids[0]!;

      // Simulate the loss of the owning main: a NEW provider instance (same
      // installation identity) reconciles at launch. The abandoned container
      // is discovered ONLY through its exact owner/phase/installation labels.
      reconciledBy = makeProvider();
      const report = await reconciledBy.reconcileRecordedSessions();
      assert.equal(report.status, "reconciled");
      assert.deepEqual(report.reconciled.map((e) => e.container_id), [abandonedId],
        "exactly the abandoned owned container was reconciled (the label-scoped ps listing matched only it — no unrelated container was ever listed)");
      assert.equal(report.unconfirmed.length, 0);
      assert.equal(containerIdsForInstallation().length, 0, "zero owned containers remain");
    } finally {
      // The abandoned session's own provider: its attach CLI died with the
      // container; the idempotent close returns the REAL cleanup status.
      try {
        if (fx !== undefined) await fx.dispose();
      } catch { /* the teardown already resolved the session */ }
      // A reconciliation provider owns no sessions; nothing to clean.
      void reconciledBy;
      for (const id of containerIdsForInstallation()) docker("rm", "--force", id);
      void abandonedId;
    }
  });
});
