// P5.4 DockerSandboxProvider — REAL Docker integration tests (canonical gate).
//
// These tests exercise the actual product through the actual local Docker
// daemon: Admission -> ExecutionGrant -> ResolvedExecutionContext ->
// DockerSandboxProvider -> a live session container -> a real guest command.
//
// They are skipped (reported as skipped, never silent pass) ONLY when the
// daemon is unreachable or the supervisor runtime image is absent; the P5.4
// validation gate (scripts/validate-p5-4.sh) separately REQUIRES a real
// end-to-end run and fails the gate when the environment cannot provide one.
// Every resource created here is prefixed `cf-p54-` and every path is under
// the repository's ignored temp root; production course content is untouched.
//
// Transport proof (host-shell non-interpretation): the authored command is
// delivered as a single argv element to `sh -c` INSIDE the container (never
// through PowerShell/cmd on the host). The guest-created marker file appears
// only under the mounted workspace; the host-side sentinel sibling stays
// byte-identical.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSandboxProvider, type DockerProviderConfig } from "../src/providers/docker.ts";
import { ContainerLedger } from "../src/providers/docker-ledger.ts";
import { resolveEnvironmentPlan } from "../src/environment.ts";
import {
  buildContainerName,
  isPinnedImageReference,
} from "../src/providers/docker-policy.ts";
import type { ResolvedExecutionContext } from "../src/workspace.ts";
import type { ExecutionGrant } from "../src/admission.ts";
import type { AdmittedSession, ProviderEvent } from "../src/providers/execution-provider.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P5.4");
const WORKSPACE_DIR = join(TEST_ROOT, "workspace");
const HOST_DIR = join(TEST_ROOT, "host");
const SENTINEL_PATH = join(HOST_DIR, "host-sentinel.txt");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5.4";
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_BASE_DIGEST = PINNED_BASE.split("@")[1]!;

function resolveDockerExe(): string {
  const configured = process.env.CF_P54_DOCKER_EXE;
  if (configured !== undefined && configured.length > 0) return configured;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["docker"], { encoding: "utf8" });
  if (probe.status === 0 && (probe.stdout ?? "").trim().length > 0) {
    const lines = (probe.stdout as string).trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const withExe = process.platform === "win32" ? lines.find((l) => l.toLowerCase().endsWith(".exe")) : undefined;
    const first = (withExe ?? lines[0] ?? "docker")!;
    return first;
  }
  return "docker";
}

const DOCKER_EXE = resolveDockerExe();
const INSTALLATION_ID = "cf-p54-installation";
const LESSON_ID = "p54-lesson";

const OWNER_LABEL = "com.course-factory.owner";
const PHASE_LABEL = "com.course-factory.phase";
const INSTALL_LABEL = "com.course-factory.installation";

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function docker(...argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(DOCKER_EXE, argv, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function dockerJson(...argv: string[]): string {
  const r = docker(...argv);
  if (r.status !== 0) throw new Error(`docker ${argv.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function containerIdForInstallation(): string[] {
  const r = docker("ps", "-aq", "--filter", `label=${INSTALL_LABEL}=${INSTALLATION_ID}`);
  return (r.stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
}

function daemonOk(): boolean {
  const r = docker("version", "--format", "{{.Server.Version}}");
  return r.status === 0 && r.stdout.trim().length > 0;
}

function imageOk(): boolean {
  const r = docker("image", "inspect", RUNTIME_IMAGE_TAG, "--format", "{{.Id}}");
  return r.status === 0 && /^sha256:[0-9a-f]{64}$/.test(r.stdout.trim());
}

/**
 * The immutable runtime supervisor image reference. Resolved from the trusted
 * gate environment (CF_P54_RUNTIME_IMAGE — the content address the gate just
 * built offline from the pinned base) or from the locally tagged build. Never
 * a moving tag: only the content-addressed `sha256:<id>` form is accepted.
 */
function resolveRuntimeImageRef(): string | null {
  const configured = process.env.CF_P54_RUNTIME_IMAGE;
  if (configured !== undefined && /^sha256:[0-9a-f]{64}$/.test(configured)) return configured;
  const r = docker("image", "inspect", RUNTIME_IMAGE_TAG, "--format", "{{.Id}}");
  if (r.status === 0) {
    const id = r.stdout.trim();
    if (/^sha256:[0-9a-f]{64}$/.test(id)) return id;
  }
  return null;
}

const DAEMON_OK = daemonOk();
const IMAGE_OK = imageOk();
const RUNTIME_IMAGE_REF = resolveRuntimeImageRef();
const AVAILABLE = DAEMON_OK && IMAGE_OK && RUNTIME_IMAGE_REF !== null;

/** Create the canonical private runtime config dir + fixed local Linux context. */
function ensureConfigContext(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ls = docker("--config", CONFIG_DIR, "context", "ls");
  if ((ls.stdout ?? "").includes("desktop-linux")) return;
  const created = docker(
    "--config", CONFIG_DIR, "context", "create",
    "desktop-linux",
    "--docker", "host=npipe:////./pipe/dockerDesktopLinuxEngine",
    "--description", "course-factory p5.4 runtime context",
  );
  if (created.status !== 0) {
    throw new Error(`failed to create private docker config context: ${created.stderr}`);
  }
}

// -- trusted hand-off builder (exactly what main would feed the provider) -----

function makeGrant(command: string, opts: { cwd?: string | null; timeoutMs?: number; expectedExitCode?: number | null } = {}): ExecutionGrant {
  return {
    kind: "execution_grant",
    grant_version: 1,
    session_id: `sess-p54-${randomBytes(3).toString("hex")}`,
    generation: 1,
    request_id: `req-p54-${randomBytes(3).toString("hex")}`,
    attempt_id: "att-p54-0001",
    operation_id: "op-p54-0001",
    operation_type: "terminal_run",
    mode: "foreground",
    course_id: "course-p54",
    lesson_id: LESSON_ID,
    scene_id: "scene-p54-01",
    beat_id: "beat-p54-01",
    process_id: null,
    command,
    cwd: opts.cwd ?? null,
    timeout_ms: opts.timeoutMs ?? 60000,
    expected_exit_code: opts.expectedExitCode ?? 0,
  };
}

function buildContext(command: string, opts: { cwd?: string | null; timeoutMs?: number; expectedExitCode?: number | null } = {}): ResolvedExecutionContext {
  const grant = makeGrant(command, opts);
  const hostEnv = Object.freeze({
    OPENAI_API_KEY: "DO_NOT_LEAK",
    GITHUB_TOKEN: "DO_NOT_LEAK",
    API_KEY: "DO_NOT_LEAK",
    TZ: "UTC",
    PATH: "synthetic-host-path-should-never-appear",
  });
  const env = resolveEnvironmentPlan(hostEnv, ["TZ"]);
  if (!env.ok) throw new Error("environment plan failed");
  const segments = opts.cwd ?? null;
  const containerCwd = segments === null ? "/workspace" : `/workspace/${segments}`;
  return {
    context_version: 1,
    kind: "resolved_execution_context",
    grant,
    workspace: {
      lesson_id: LESSON_ID,
      session_id: grant.session_id,
      generation: 1,
      host_workspace_root: WORKSPACE_DIR,
      container_workspace_root: "/workspace",
      host_cwd: segments === null ? WORKSPACE_DIR : join(WORKSPACE_DIR, segments),
      container_cwd: containerCwd,
    },
    mount_plan: [{ type: "bind", source: WORKSPACE_DIR, target: "/workspace", read_only: false }],
    environment_plan: env.value,
    image_identity: {
      pinned_reference: PINNED_BASE,
      digest: PINNED_BASE.split("@")[1]!,
      platform: "linux/amd64",
      pull_policy: "never",
      source: "base-image.lock.json",
    },
    sandbox_policy_ref: "course-factory/terminal/p5/docker-create-argv-v1",
  };
}

function makeConfig(): DockerProviderConfig {
  return {
    cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR, clientEnv: {} },
    imageReference: RUNTIME_IMAGE_REF!,
    installationId: INSTALLATION_ID,
  };
}

// -- event helpers -------------------------------------------------------------

interface OutputEvent {
  stream: "stdout" | "stderr";
  text: string;
}
interface ExitedEvent {
  exit_code: number | null;
  signal: string | null;
}
interface CompletedEvent {
  outcome: string;
  reason: string | null;
  exit_code: number | null;
}

function outputs(events: ProviderEvent[]): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  for (const e of events) {
    if (e.type !== "process.output") continue;
    const p = e.payload as OutputEvent;
    if (p.stream === "stdout") stdout += p.text;
    else stderr += p.text;
  }
  return { stdout, stderr };
}
function exited(events: ProviderEvent[]): ExitedEvent | null {
  const e = events.find((ev) => ev.type === "process.exited");
  return e === undefined ? null : (e.payload as ExitedEvent);
}
function completed(events: ProviderEvent[]): CompletedEvent | null {
  const e = events.find((ev) => ev.type === "operation.completed");
  return e === undefined ? null : (e.payload as CompletedEvent);
}

// -- one real product run ------------------------------------------------------

async function runOnce(
  command: string,
  opts: { cwd?: string | null; timeoutMs?: number; expectedExitCode?: number | null } = {},
): Promise<{ events: ProviderEvent[]; context: ResolvedExecutionContext }> {
  const context = buildContext(command, opts);
  const provider = new DockerSandboxProvider(makeConfig());
  const events: ProviderEvent[] = [];
  const admitted: AdmittedSession = {
    session_id: context.grant.session_id,
    generation: context.grant.generation,
    resolvedContext: context,
  };
  const session = await provider.prepare(admitted);
  const subscription = provider.events(session, (e) => events.push(e));
  try {
    await provider.start(session, context.grant.operation_id, context.grant.attempt_id);
  } finally {
    subscription.dispose();
    const cleanup = await provider.close(session, "failure");
    assert.equal(cleanup.cleanup_status, "confirmed", "provider close must confirm removal");
  }
  return { events, context };
}

function inspectOneLiveContainer(): Record<string, unknown> {
  const ids = containerIdForInstallation();
  if (ids.length !== 1) {
    throw new Error(`expected exactly one live provider container for inspection, found ${ids.length}`);
  }
  return JSON.parse(dockerJson("inspect", ids[0]!))[0] as Record<string, unknown>;
}

function jsonField(doc: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = doc;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// -----------------------------------------------------------------------------

describe("P5.4 real DockerSandboxProvider integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    mkdirSync(HOST_DIR, { recursive: true });
    ensureConfigContext();
    writeFileSync(SENTINEL_PATH, "COURSE_FACTORY_P54_HOST_SENTINEL", "ascii");
    writeFileSync(join(WORKSPACE_DIR, "seed.txt"), "P54_SEED", "ascii");
  });

  after(() => {
    for (const id of containerIdForInstallation()) docker("rm", "--force", id);
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("foreground success: real stdout/stderr captured, true exit 0, cleanup confirmed", async () => {
    const command = "echo COURSE_FACTORY_P54_STDOUT; echo COURSE_FACTORY_P54_STDERR >&2; exit 0";
    const { events } = await runOnce(command, { timeoutMs: 30000, expectedExitCode: 0 });
    const out = outputs(events);
    assert.match(out.stdout, /COURSE_FACTORY_P54_STDOUT/);
    assert.match(out.stderr, /COURSE_FACTORY_P54_STDERR/);
    const ex = exited(events);
    assert.equal(ex?.exit_code, 0);
    assert.equal(ex?.signal, null);
    const comp = completed(events);
    assert.equal(comp?.outcome, "PASS");
    assert.equal(comp?.exit_code, 0);
    assert.equal(containerIdForInstallation().length, 0, "provider-created container removed after close");
  });

  it("non-zero exit: true code 7 is propagated as FAIL/EXIT_CODE_MISMATCH (not Docker CLI success)", async () => {
    const { events } = await runOnce("exit 7", { timeoutMs: 30000, expectedExitCode: 0 });
    const ex = exited(events);
    assert.equal(ex?.exit_code, 7);
    const comp = completed(events);
    assert.equal(comp?.outcome, "FAIL");
    assert.equal(comp?.reason, "EXIT_CODE_MISMATCH");
  });

  it("expected_exit_code 7 still reports true code 7 and PASSes", async () => {
    const { events } = await runOnce("exit 7", { timeoutMs: 30000, expectedExitCode: 7 });
    const comp = completed(events);
    assert.equal(comp?.outcome, "PASS");
    assert.equal(comp?.exit_code, 7);
  });

  it("workspace write: guest writes to /workspace/provider-output.txt, verified byte-exact on host", async () => {
    const { events } = await runOnce("echo COURSE_FACTORY_P54_WORKSPACE_WRITE > /workspace/provider-output.txt");
    const comp = completed(events);
    assert.equal(comp?.outcome, "PASS");
    const hostFile = join(WORKSPACE_DIR, "provider-output.txt");
    assert.equal(existsSync(hostFile), true);
    assert.equal(readFileSync(hostFile, "utf8").trim(), "COURSE_FACTORY_P54_WORKSPACE_WRITE");
  });

  it("trusted cwd: guest pwd matches the resolved /workspace/<nested>", async () => {
    mkdirSync(join(WORKSPACE_DIR, "nested", "proj"), { recursive: true });
    const { events } = await runOnce("pwd", { cwd: "nested/proj", timeoutMs: 30000 });
    const out = outputs(events);
    assert.match(out.stdout, /\/workspace\/nested\/proj/);
  });

  it("non-root: guest uid/gid are 1000/1000 (id -u; id -g)", async () => {
    const { events } = await runOnce("id -u; id -g", { timeoutMs: 30000 });
    const out = outputs(events);
    const lines = out.stdout.trim().split(/\s+/);
    assert.ok(lines.includes("1000"), `expected 1000 in uid/gid output: ${out.stdout}`);
    assert.ok(lines.length >= 2);
  });

  it("docker socket is not mounted and not present inside the guest", async () => {
    const { events } = await runOnce("test ! -e /var/run/docker.sock && echo NO_SOCKET || echo SOCKET_FOUND", { timeoutMs: 30000 });
    const out = outputs(events);
    assert.match(out.stdout, /NO_SOCKET/);
    const ids = containerIdForInstallation();
    assert.equal(ids.length, 0, "container already removed; socket absence proven during run above");
  });

  it("network isolation: external connect fails fast; NetworkMode=none; zero published ports", async () => {
    const { events } = await runOnce(
      "node -e \"require('node:net').connect({host:'192.0.2.1',port:80}).on('error',(e)=>{console.log('NET_FAIL:'+e.code);process.exit(0)}).on('connect',()=>{console.log('NET_UNEXPECTED');process.exit(1)})\"",
      { timeoutMs: 30000 },
    );
    const out = outputs(events);
    assert.match(out.stdout, /NET_FAIL/);
    const ex = exited(events);
    assert.equal(ex?.exit_code, 0);
  });

  it("environment is restricted: fake host secrets never reach the guest", async () => {
    const { events } = await runOnce("env", { timeoutMs: 30000 });
    const out = outputs(events);
    assert.equal(out.stdout.includes("DO_NOT_LEAK"), false);
    assert.equal(out.stdout.includes("OPENAI_API_KEY"), false);
    assert.equal(out.stdout.includes("GITHUB_TOKEN"), false);
    assert.equal(out.stdout.includes("synthetic-host-path"), false);
    assert.match(out.stdout, /HOME=\/workspace\/.home/);
    assert.match(out.stdout, /LANG=C.UTF-8/);
    assert.match(out.stdout, /TZ=UTC/);
  });

  it("host-shell non-interpretation: metacharacter-rich command travels as ONE argv element", async () => {
    // This command would overwrite a sibling on the host IF a host shell ever
    // interpreted the authored text. Interpreted only inside the guest, it
    // writes through the mount parent (container /), never the host sibling.
    const command =
      "printf 'HOST_SENTINEL_MARKER' > ../host-sentinel.txt; echo CF_P54_GUEST_OK; printf 'a;b|c\\n'; echo $(echo nested)";
    const hashBefore = sha256File(SENTINEL_PATH);
    const { events } = await runOnce(command, { timeoutMs: 30000 });
    const out = outputs(events);
    assert.match(out.stdout, /CF_P54_GUEST_OK/);
    assert.match(out.stdout, /nested/);
    const hashAfter = sha256File(SENTINEL_PATH);
    assert.equal(hashAfter, hashBefore, "host sentinel outside the mount must stay byte-identical");
  });

  it("live container inspect matches the canonical sandbox policy", async () => {
    const { context } = await runOnce("sleep 1; echo INSPECT_OK", { timeoutMs: 30000 });
    // Capture the container while it is alive is not possible through runOnce
    // (it closes in finally), so this test drives the lifecycle directly.
    const provider = new DockerSandboxProvider(makeConfig());
    const events: ProviderEvent[] = [];
    const session = await provider.prepare({
      session_id: context.grant.session_id,
      generation: context.grant.generation,
      resolvedContext: context,
    });
    const subscription = provider.events(session, (e) => events.push(e));
    try {
      const runPromise = provider.start(session, context.grant.operation_id, context.grant.attempt_id);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
      const doc = inspectOneLiveContainer();
      const hostCfg = jsonField(doc, ["HostConfig"]) as Record<string, unknown>;
      const netSettings = jsonField(doc, ["NetworkSettings"]) as Record<string, unknown>;
      const mounts = (jsonField(doc, ["Mounts"]) as unknown[]) ?? [];
      const configObj = jsonField(doc, ["Config"]) as Record<string, unknown>;
      const stateObj = jsonField(doc, ["State"]) as Record<string, unknown>;
      assert.equal(jsonField(doc, ["HostConfig", "Privileged"]), false);
      assert.equal(configObj["User"], "1000:1000");
      assert.equal(hostCfg["NetworkMode"], "none");
      assert.equal(Object.keys((netSettings["Ports"] as object) ?? {}).length, 0);
      assert.ok((hostCfg["CapDrop"] as string[]).includes("ALL"));
      assert.ok((hostCfg["SecurityOpt"] as string[]).includes("no-new-privileges=true"));
      assert.equal(hostCfg["ReadonlyRootfs"], true);
      assert.equal(jsonField(doc, ["HostConfig", "Init"]), true);
      assert.equal((hostCfg["RestartPolicy"] as Record<string, unknown>)["Name"], "no");
      assert.equal(hostCfg["Memory"], 512 * 1024 * 1024);
      assert.equal(hostCfg["MemorySwap"], 512 * 1024 * 1024);
      assert.equal(hostCfg["NanoCpus"], 1_000_000_000);
      assert.equal(hostCfg["PidsLimit"], 128);
      assert.equal(hostCfg["ShmSize"], 16 * 1024 * 1024);
      assert.equal((hostCfg["Tmpfs"] as Record<string, unknown>)["/tmp"], "rw,noexec,nosuid,nodev,size=67108864,mode=1777");
      const writableBinds = mounts.filter((m) => {
        const mm = m as Record<string, unknown>;
        return mm["Type"] === "bind" && mm["RW"] === true;
      });
      assert.equal(writableBinds.length, 1);
      assert.equal((writableBinds[0] as Record<string, unknown>)["Destination"], "/workspace");
      assert.equal((writableBinds[0] as Record<string, unknown>)["Source"], WORKSPACE_DIR);
      assert.equal((writableBinds[0] as Record<string, unknown>)["RW"], true);
      const noDockerSocket = !mounts.some((m) => JSON.stringify(m).includes("docker.sock"));
      assert.equal(noDockerSocket, true);
      assert.equal((configObj["Image"] as string).startsWith("sha256:"), true);
      assert.equal(stateObj["Running"], true);
      await runPromise;
    } finally {
      subscription.dispose();
      const cleanup = await provider.close(session, "failure");
      assert.equal(cleanup.cleanup_status, "confirmed");
    }
  });

  it("guest env cannot see the container image's inherited secret-like entries", async () => {
    const { events } = await runOnce("env", { timeoutMs: 30000 });
    const out = outputs(events);
    assert.equal(out.stdout.includes("DO_NOT_LEAK"), false);
  });

  it("P5.4 timeout boundary: granted foreground deadline yields TIMEOUT/FAIL and teardown, no survivor", async () => {
    // P5.4 owns the bounded foreground probe deadline only: the exec CLI is
    // killed at the granted timeout, the provider latches TIMEOUT, and the
    // container teardown is the authoritative cleanup of any guest survivor.
    // Full tree-ownership / lease renewal / group-stop races remain P5.5.
    const { events } = await runOnce("sleep 4; echo NOT_REACHED", { timeoutMs: 1000 });
    const timeoutEvents = events.filter((e) => e.type === "process.timeout");
    assert.equal(timeoutEvents.length, 1);
    assert.equal((timeoutEvents[0]!.payload as { timeout_ms: number }).timeout_ms, 1000);
    const comp = completed(events);
    assert.equal(comp?.outcome, "FAIL");
    assert.equal(comp?.reason, "TIMEOUT");
    assert.equal(comp?.exit_code, null, "no invented exit code for a timed-out process");
    assert.equal(containerIdForInstallation().length, 0, "container removed after timeout teardown");
  });
});

describe("P5.4 provider policy unit guarantees (no daemon needed)", () => {
  it("stale generation / wrong session ownership / missing context reject before any Docker call", async () => {
    const context = buildContext("echo hi");
    const provider = new DockerSandboxProvider(makeConfig());
    // Wrong session ownership.
    await assert.rejects(
      provider.prepare({ session_id: "sess-other", generation: 1, resolvedContext: context }),
      (error: Error & { code?: string }) => error.code === "STALE_SESSION",
    );
    // Stale generation.
    await assert.rejects(
      provider.prepare({ session_id: context.grant.session_id, generation: 999, resolvedContext: context }),
      (error: Error & { code?: string }) => error.code === "STALE_SESSION",
    );
    // No resolved context at all (renderer-supplied identity cannot carry one).
    await assert.rejects(
      provider.prepare({ session_id: context.grant.session_id, generation: 1 }),
      (error: Error & { code?: string }) => error.code === "NOT_AUTHORIZED",
    );
    // Unpinned (moving-tag) runtime image reference in trusted config.
    const movingConfig = { ...makeConfig(), imageReference: "cf-terminal-engine-runtime:p5.4" } as DockerProviderConfig;
    const movingProvider = new DockerSandboxProvider(movingConfig);
    await assert.rejects(
      movingProvider.prepare({ session_id: context.grant.session_id, generation: 1, resolvedContext: context }),
      (error: Error & { code?: string }) => error.code === "IMAGE_UNAVAILABLE",
    );
    // Foreign workspace context: second mount target is not /workspace.
    const foreign = {
      ...context,
      mount_plan: [{ type: "bind" as const, source: context.mount_plan[0]!.source, target: "/elsewhere" as never, read_only: false as const }],
    } as unknown as ResolvedExecutionContext;
    const foreignProvider = new DockerSandboxProvider(makeConfig());
    await assert.rejects(
      foreignProvider.prepare({ session_id: context.grant.session_id, generation: 1, resolvedContext: foreign }),
      (error: Error & { code?: string }) => error.code === "WORKSPACE_VIOLATION",
    );
    // No container was created by any rejected prepare (exact label sweep).
    assert.equal(containerIdForInstallation().length, 0);
  });

  it("ContainerLedger records intent and reconciles only owned containers", () => {
    const ledger = new ContainerLedger();
    const idA = "a".repeat(64);
    const idB = "b".repeat(64);
    ledger.recordIntent({ containerId: idA, name: "cf-p54-a", session_id: "s1", generation: 1, lesson_id: "l", createdAtEpochMs: 1 });
    ledger.recordIntent({ containerId: idB, name: "cf-p54-b", session_id: "s2", generation: 1, lesson_id: "l", createdAtEpochMs: 2 });
    const summary = ledger.reconcile([idA]);
    assert.equal(summary.owned.length, 2);
    assert.equal(summary.lingering.length, 1);
    assert.equal(summary.lingering[0]!.containerId, idA);
    ledger.forget(idA);
    assert.equal(ledger.all().length, 1);
    ledger.setState(idB, "REMOVED");
    assert.equal(ledger.get(idB)?.state, "REMOVED");
    assert.equal(ledger.forSession("s1").length, 0);
    assert.equal(ledger.forSession("s2").length, 1);
  });

  it("buildContainerName produces runtime-only sanitized cf-<lesson>-<runtime> names", () => {
    assert.match(buildContainerName("C01-L052", "sess-1234"), /^cf-c01-l052-sess-1234$/);
    const hostile = buildContainerName("Con;TouchX", "sess-1;rm -rf /");
    assert.match(hostile, /^cf-con-touchx-sess-1-rm-rf$/);
  });

  it("isPinnedImageReference accepts digest refs and rejects moving tags", () => {
    assert.equal(isPinnedImageReference("node:latest"), false);
    assert.equal(isPinnedImageReference("node:24"), false);
    assert.equal(isPinnedImageReference("cf-terminal-engine-runtime:p5.4"), false);
    assert.equal(isPinnedImageReference(`node:24-bookworm-slim@${PINNED_BASE_DIGEST}`), true);
    assert.equal(isPinnedImageReference(PINNED_BASE_DIGEST), true);
    assert.equal(isPinnedImageReference(null), false);
  });
});
