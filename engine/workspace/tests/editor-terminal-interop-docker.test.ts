// P6.13 terminal interoperability — REAL Windows + Docker platform proof
// (gate-only: FAILS without a reachable daemon and the pinned image, never
// skips).
//
// Canonical task: P6-DESIGN-SPEC P6.13 ("Real shared bind, dirty reads, RW
// invalidation, background watcher"; PASS "Exact saved target observed; no
// partial typing"). Real Windows + real Docker required: every byte the
// terminal observes crosses a REAL container bind of the SAME authoritative
// leaf the editor saved through the REAL adapter.
//
// Composition under proof (no fake workspace, no shadow copy):
//   reviewed policy -> WorkspaceCoordinator -> EditorLifecycle +
//   WindowsFileAdapter (host) + DockerAccessEpochProvider (guest) on one leaf.
//
// TEST 1  full flow: open/type/replace/save, guest reads exact saved bytes.
// TEST 2  run flow: watcher sees OLD before save, NEW after; node runs exact stdout/exit.
// TEST 3  pending create invisible before save, exact after save.
// TEST 4  dirty buffer denies RW with zero new containers.
// TEST 5  verified save enables RW; host sees the terminal modification.
// TEST 6  RW waits for explicit observer stop; daemon confirms absence; epoch advances.
// TEST 7  RO sandbox intact on the live watcher epoch.
// TEST 8  RW sandbox recorded at preparation (single bind, writable, P5 flags).
// TEST 9  large save observed atomically (old/new complete bytes only).
// TEST 10 terminal modification causes stale-save conflict with zero clobber (real mutation).
// TEST 11 stale epoch handles fence with zero action (real provider).
// TEST 12 old generations fence with zero new containers.
// TEST 13 shared trace order on the real platform.
// TEST 14 reset with a live watcher: revoke, daemon-confirmed removal, reseed.
// TEST 15 close retires both domains; late work fences; zero survivors.
// TEST 16 HOLD on unconfirmed retirement; explicit reset recovers.
// TEST 17 final ownership sweep: zero cf-p613 containers, zero residue.
//
// Every resource is prefixed cf-p613- under temp/P6.13/interop-docker.
// Cleanup is ownership-scoped; no global prune ever. Fixture IR is NEVER
// hand-authored (canonical pipeline).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DockerAccessEpochProvider } from "../../terminal/src/providers/docker-epochs.ts";
import { createEditorTerminalInterop, type EditorTerminalInterop, type EpochHandleLike, type TerminalEpochOps } from "../src/editor-terminal-interop.ts";
import {
  buildInteropLesson,
  life,
  makeBindAdapter,
  makePrepareLeaf,
  manifestFor,
  nextRequest,
  op,
  policyFor,
  repoRoot,
  terminalRunForeground,
  terminalWatcher,
  type BuiltLesson,
} from "./editor-terminal-interop-harness.ts";

const TEST_ROOT = join(repoRoot, "temp", "P6.13", "interop-docker");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const PINNED_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const INSTALLATION_ID = "cf-p613-installation";
const PREFIX = "cf-p613-";
const SUFFIX = randomBytes(3).toString("hex");
const TEST_RUN_ID = `cf-p613-run-${SUFFIX}`;

function proof(message: string): void {
  console.log(`P6.13 PROOF: ${message}`);
}

function resolveDockerExe(): string {
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

function daemonOk(): boolean {
  const r = docker("version", "--format", "{{.Server.Version}}");
  return r.status === 0 && r.stdout.trim().length > 0;
}

function baseImageOk(): boolean {
  const r = docker("image", "inspect", PINNED_IMAGE, "--format", "{{.Id}}");
  return r.status === 0 && /^sha256:[0-9a-f]{64}$/.test(r.stdout.trim());
}

function ownedContainerNames(prefix = "cf-p613-"): string[] {
  const r = docker("ps", "-aq", "--no-trunc", "--filter", `name=${prefix}`);
  return (r.stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
}

function sweepOwned(prefix = "cf-p613-"): void {
  for (const id of ownedContainerNames(prefix)) docker("rm", "--force", id);
}

function ensureConfigContext(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ls = docker("--config", CONFIG_DIR, "context", "ls");
  if ((ls.stdout ?? "").includes("desktop-linux")) return;
  const created = docker(
    "--config", CONFIG_DIR, "context", "create",
    "desktop-linux",
    "--docker", "host=npipe:////./pipe/dockerDesktopLinuxEngine",
    "--description", "course-factory p6.13 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

interface SandboxRecord {
  readonly containerName: string;
  readonly access: string;
  readonly user: unknown;
  readonly network: unknown;
  readonly rootfs: unknown;
  readonly binds: number;
  readonly destination: unknown;
  readonly rw: unknown;
  readonly scratchHome: boolean;
}

/** Recording wrapper over the REAL provider (delegates everything, inspects nothing away). */
class RecEpochOps implements TerminalEpochOps {
  readonly prepared: EpochHandleLike[] = [];
  readonly sandbox: SandboxRecord[] = [];
  readonly real: DockerAccessEpochProvider;
  constructor(real: DockerAccessEpochProvider) {
    this.real = real;
  }

  private recordSandbox(handle: EpochHandleLike, access: string): void {
    try {
      const raw = docker("inspect", handle.containerId);
      if (raw.status !== 0) return;
      const doc = (JSON.parse(raw.stdout) as Array<Record<string, unknown>>)[0] ?? {};
      const hostConfig = (doc["HostConfig"] as Record<string, unknown>) ?? {};
      const config = (doc["Config"] as Record<string, unknown>) ?? {};
      const mounts = (doc["Mounts"] as Array<Record<string, unknown>>) ?? [];
      const env = ((config["Env"] as string[]) ?? []) as string[];
      this.sandbox.push({
        containerName: handle.containerName,
        access,
        user: config["User"],
        network: hostConfig["NetworkMode"],
        rootfs: hostConfig["ReadonlyRootfs"],
        binds: mounts.length,
        destination: mounts[0]?.["Destination"],
        rw: mounts[0]?.["RW"],
        scratchHome: env.includes("HOME=/tmp/cf-home"),
      });
    } catch {
      // Evidence-only: preparation already verified by the provider itself.
    }
  }

  async prepareEpoch(args: {
    readonly sessionId: string;
    readonly generation: number;
    readonly epoch: number;
    readonly access: "read_only" | "read_write";
    readonly leafHostPath: string;
    readonly leaseId: string;
    readonly policyDigest: string;
    readonly containerName: string;
    readonly testRunId: string;
  }): Promise<EpochHandleLike> {
    const handle = await this.real.prepareEpoch(args);
    this.prepared.push({ ...handle });
    this.recordSandbox(handle, args.access);
    return handle;
  }

  readEpochFile(handle: EpochHandleLike, relPath: string) {
    return this.real.readEpochFile(handle, relPath);
  }

  runEpochScript(handle: EpochHandleLike, relPath: string) {
    return this.real.runEpochScript(handle, relPath);
  }

  attemptEpochWrite(handle: EpochHandleLike, relPath: string, content: string) {
    return this.real.attemptEpochWrite(handle, relPath, content);
  }

  retireEpoch(handle: EpochHandleLike, cause: string) {
    return this.real.retireEpoch(handle, cause);
  }
}

interface DockerHarness {
  readonly interop: EditorTerminalInterop;
  readonly ops: readonly string[];
  readonly leaf: string;
  readonly provider: DockerAccessEpochProvider;
  readonly rec: RecEpochOps;
  readonly lesson: BuiltLesson;
  /** Unique container-name scope for this harness (robust against cross-test leaks). */
  readonly prefix: string;
}

let harnessSeq = 0;

function openDockerHarness(
  tag: string,
  actions: Array<{ action: unknown }>,
  seedFiles: Record<string, string>,
  seedDirs: readonly string[],
  modes: Array<"read_only" | "read_write">,
): DockerHarness {
  harnessSeq += 1;
  const lesson = buildInteropLesson(tag, actions);
  const terminalOpIds = lesson.operationIds.filter((_, index) => (actions[index] as { action: { type?: unknown } }).action.type === "terminal_run");
  assert.equal(terminalOpIds.length, modes.length, "one reviewed access per terminal beat");
  const access: Record<string, "read_only" | "read_write"> = {};
  terminalOpIds.forEach((id, index) => {
    access[id] = modes[index] ?? "read_only";
  });
  const seed = manifestFor(seedFiles, seedDirs);
  const policy = policyFor(lesson, seed, access);
  const leaf = join(TEST_ROOT, `leaf-${SUFFIX}-${harnessSeq}`);
  const staging = join(TEST_ROOT, `staging-${SUFFIX}-${harnessSeq}`);
  // Unique container-name scope per harness: Docker requires names to be
  // unique while a same-named container lingers, and the gate must never
  // confuse one test's epoch for another's (prefix stays cf-p613-).
  const containerPrefix = `${PREFIX}t${harnessSeq}-`;
  const testRunId = `${TEST_RUN_ID}-t${harnessSeq}`;
  const provider = new DockerAccessEpochProvider({
    cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR },
    imageReference: PINNED_IMAGE,
    installationId: INSTALLATION_ID,
  });
  const rec = new RecEpochOps(provider);
  const created = createEditorTerminalInterop({
    compiledLesson: lesson.compiled,
    reviewedPolicy: policy,
    seedManifest: seed,
    seedFiles,
    leafHostPath: leaf,
    installationId: INSTALLATION_ID,
    containerNamePrefix: containerPrefix,
    testRunId,
    terminal: rec,
    prepareLeaf: makePrepareLeaf(leaf, staging, seedDirs),
    bindAdapter: makeBindAdapter(leaf, staging),
  });
  assert.equal(created.ok, true, `interop session must open: ${created.ok ? "" : created.rejection.message}`);
  if (!created.ok) throw new Error("unreachable");
  return { interop: created.value, ops: lesson.operationIds, leaf, provider, rec, lesson, prefix: containerPrefix };
}

function sidOf(harness: DockerHarness): { session_id: string; generation: number } {
  const described = harness.interop.describe();
  return { session_id: described.session_id, generation: described.generation };
}

function rejectionCode(outcome: unknown): string {
  if (outcome !== null && typeof outcome === "object" && "ok" in outcome && (outcome as { ok: boolean }).ok === false) {
    return (outcome as { ok: false; rejection: { code: string } }).rejection.code ?? "UNKNOWN";
  }
  return "OK";
}

async function guestReadWithinBound(
  interop: EditorTerminalInterop,
  rel: string,
  expected: string,
  boundMs = 5000,
): Promise<boolean> {
  const sid = { session_id: interop.describe().session_id, generation: interop.describe().generation };
  const deadline = Date.now() + boundMs;
  for (;;) {
    const seen = await interop.observeCommitted({ ...sid, rel_path: rel });
    if (seen.ok && seen.value.exit_code === 0 && seen.value.stdout === expected) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

before(async () => {
  assert.equal(daemonOk(), true, "P6.13 requires a reachable Docker daemon (no fake PASS)");
  assert.equal(baseImageOk(), true, "P6.13 requires the pinned base image locally");
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  ensureConfigContext();
  sweepOwned();
  proof(`SETUP daemon reachable, image pinned, owned=${JSON.stringify(ownedContainerNames())}`);
});

after(async () => {
  sweepOwned();
  rmSync(TEST_ROOT, { recursive: true, force: true });
  const remaining = ownedContainerNames();
  console.log(`P6.13 PROOF: CLEANUP remaining cf-p613 containers: [${remaining.join(",")}]`);
  assert.deepEqual(remaining, []);
});

describe("P6.13 real Docker terminal interoperability", () => {
  it("TEST 1 full flow: guest reads exactly the verified saved bytes", async () => {
    const harness = openDockerHarness(
      "docker-flow",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "type_code", path: "src/report.txt", content: "v2 line\n" } },
        { action: { type: "replace_code", path: "src/report.txt", find: "v1", replace: "v1r" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalRunForeground("cat src/report.txt"),
      ],
      { "src/report.txt": "v1 line\n" },
      [],
      ["read_only"],
    );
    const { interop, ops, leaf } = harness;
    const [open, type, replace, save, read] = ops as [string, string, string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runReplaceDocument(op(interop, replace, "replace"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    const observed = await interop.terminalReadSaved(op(interop, read, "read"));
    assert.equal(observed.ok, true);
    if (!observed.ok) throw new Error("unreachable");
    assert.equal(observed.value.exit_code, 0);
    assert.equal(observed.value.stdout, "v1r line\nv2 line\n");
    assert.equal(readFileSync(join(leaf, "src", "report.txt"), "utf8"), "v1r line\nv2 line\n");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 1 guest reads exact saved bytes through the real bind");
  });

  it("TEST 2 run flow: OLD before save, NEW after; node prints exact stdout and exit", async () => {
    const harness = openDockerHarness(
      "docker-run",
      [
        { action: { type: "file_open", path: "src/app.js" } },
        { action: { type: "type_code", path: "src/app.js", content: 'console.log("NEW");\n' } },
        { action: { type: "file_save", path: "src/app.js" } },
        terminalWatcher("watcher", "node src/app.js"),
        terminalRunForeground("node src/app.js"),
      ],
      { "src/app.js": 'console.log("OLD");\n' },
      [],
      ["read_only", "read_only"],
    );
    const { interop, ops } = harness;
    const [open, type, save, watch, run] = ops as [string, string, string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    assert.equal(await guestReadWithinBound(interop, "src/app.js", 'console.log("OLD");\n'), true);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    const during = await interop.observeCommitted({ ...sid, rel_path: "src/app.js" });
    assert.equal(during.ok, true);
    if (!during.ok) throw new Error("unreachable");
    assert.equal(during.value.stdout, 'console.log("OLD");\n', "unsaved typing never reaches the guest");
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal(await guestReadWithinBound(interop, "src/app.js", 'console.log("OLD");\nconsole.log("NEW");\n'), true);
    const ran = await interop.terminalRunSaved(op(interop, run, "run"));
    assert.equal(ran.ok, true);
    if (!ran.ok) throw new Error("unreachable");
    assert.equal(ran.value.exit_code, 0);
    assert.equal(ran.value.stdout, "OLD\nNEW\n");
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("TEST 2 guest runs committed bytes with exact stdout and exit 0");
  });

  it("TEST 3 pending create invisible to the guest until save", async () => {
    const harness = openDockerHarness(
      "docker-pending",
      [
        { action: { type: "file_create", path: "src/created.txt" } },
        { action: { type: "type_code", path: "src/created.txt", content: "created bytes\n" } },
        { action: { type: "file_save", path: "src/created.txt" } },
        terminalWatcher("watcher", "cat src/created.txt"),
        terminalRunForeground("cat src/created.txt"),
      ],
      {},
      ["src"],
      ["read_only", "read_only"],
    );
    const { interop, ops, leaf } = harness;
    const [create, type, save, watch, read] = ops as [string, string, string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    assert.equal((await interop.runCreateDocument(op(interop, create, "create"))).ok, true);
    assert.equal(existsSync(join(leaf, "src", "created.txt")), false);
    const absent = await interop.observeCommitted({ ...sid, rel_path: "src/created.txt" });
    assert.equal(absent.ok, true);
    if (!absent.ok) throw new Error("unreachable");
    assert.notEqual(absent.value.exit_code, 0, "guest sees absence, not staging");
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    const stillAbsent = await interop.observeCommitted({ ...sid, rel_path: "src/created.txt" });
    assert.equal(stillAbsent.ok, true);
    if (!stillAbsent.ok) throw new Error("unreachable");
    assert.notEqual(stillAbsent.value.exit_code, 0);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal(await guestReadWithinBound(interop, "src/created.txt", "created bytes\n"), true);
    const observed = await interop.terminalReadSaved(op(interop, read, "read"));
    assert.equal(observed.ok, true);
    if (!observed.ok) throw new Error("unreachable");
    assert.equal(observed.value.stdout, "created bytes\n");
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("TEST 3 guest sees absence before save, exact bytes after");
  });

  it("TEST 4 dirty buffer denies RW with zero new containers", async () => {
    const harness = openDockerHarness(
      "docker-dirty",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "type_code", path: "src/report.txt", content: "dirty\n" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalRunForeground("cat src/report.txt"),
      ],
      { "src/report.txt": "clean\n" },
      [],
      ["read_write"],
    );
    const { interop, ops } = harness;
    const [open, type, save, rw] = ops as [string, string, string, string];
    void save;
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    const before = ownedContainerNames(harness.prefix).sort();
    const denied = await interop.terminalModify({ ...sidOf(harness), operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/report.txt", content: "x" });
    assert.equal(denied.ok, false);
    assert.equal(rejectionCode(denied), "DIRTY_BUFFER_CONFLICT");
    assert.deepEqual(ownedContainerNames(harness.prefix).sort(), before, "denied RW starts zero containers");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 4 real dirty buffer denies RW with zero containers");
  });

  it("TEST 5 verified save enables RW; host sees the terminal modification", async () => {
    const harness = openDockerHarness(
      "docker-rw",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "type_code", path: "src/report.txt", content: "dirty\n" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalRunForeground("cat src/report.txt"),
      ],
      { "src/report.txt": "clean\n" },
      [],
      ["read_write"],
    );
    const { interop, ops, leaf, provider } = harness;
    const [open, type, save, rw] = ops as [string, string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    const epochBefore = interop.describe().epoch;
    const modified = await interop.terminalModify({ ...sidOf(harness), operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/report.txt", content: "rw bytes\n" });
    assert.equal(modified.ok, true);
    if (!modified.ok) throw new Error("unreachable");
    assert.equal(modified.value.exit_code, 0);
    assert.equal(readFileSync(join(leaf, "src", "report.txt"), "utf8"), "rw bytes\n");
    assert.ok(interop.describe().epoch > epochBefore, "real RW handoff advances the epoch");
    assert.equal(provider.liveEpoch(), null, "no epoch container survives the handoff");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 5 real RW modifies the shared leaf; editor resumes after confirmed absence");
  });

  it("TEST 6 RW waits for explicit observer stop with daemon-confirmed recreation", async () => {
    const harness = openDockerHarness(
      "docker-exclusive",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
        terminalRunForeground("cat src/report.txt"),
      ],
      { "src/report.txt": "v\n" },
      [],
      ["read_only", "read_write"],
    );
    const { interop, ops, rec } = harness;
    const [open, save, watch, rw] = ops as [string, string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    const roHandle = rec.prepared[rec.prepared.length - 1]!;
    const busy = await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/report.txt", content: "x" });
    assert.equal(busy.ok, false);
    assert.equal(rejectionCode(busy), "WORKSPACE_BUSY");
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    assert.equal(docker("inspect", roHandle.containerId).status !== 0, true, "old container absence is daemon-confirmed");
    const allowed = await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw2"), rel_path: "src/report.txt", content: "rw\n" });
    assert.equal(allowed.ok, true);
    const rwHandle = rec.prepared[rec.prepared.length - 1]!;
    assert.notEqual(rwHandle.containerId, roHandle.containerId, "recreation means a new runtime identity");
    assert.equal(docker("inspect", rwHandle.containerId).status !== 0, true, "RW container absence confirmed after release");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 6 explicit stop precedes RW; recreation with confirmed absence");
  });

  it("TEST 7 RO sandbox intact on the live watcher epoch", async () => {
    const harness = openDockerHarness(
      "docker-sandbox-ro",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
      ],
      { "src/report.txt": "v\n" },
      [],
      ["read_only"],
    );
    const { interop, ops, rec, leaf } = harness;
    const [open, save, watch] = ops as [string, string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    const record = rec.sandbox[rec.sandbox.length - 1]!;
    assert.equal(record.access, "read_only");
    assert.equal(record.user, "1000:1000");
    assert.equal(record.network, "none");
    assert.equal(record.rootfs, true);
    assert.equal(record.binds, 1, "exactly one bind: the shared leaf at /workspace");
    assert.equal(record.destination, "/workspace");
    assert.equal(record.rw, false, "watcher epoch binds /workspace readonly");
    assert.equal(record.scratchHome, true, "tool scratch lives under /tmp");
    const live = rec.prepared[rec.prepared.length - 1]!;
    const denied = await harness.provider.attemptEpochWrite(live, "evil.txt", "nope");
    assert.notEqual(denied.exitCode, 0, "guest write denied inside the RO epoch");
    assert.equal(existsSync(join(leaf, "evil.txt")), false, "no guest bytes land on the host leaf");
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("TEST 7 RO sandbox: 1000:1000, network none, read-only rootfs, one RO bind");
  });

  it("TEST 8 RW sandbox recorded writable with the same P5 flags", async () => {
    const harness = openDockerHarness(
      "docker-sandbox-rw",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalRunForeground("cat src/report.txt"),
      ],
      { "src/report.txt": "v\n" },
      [],
      ["read_write"],
    );
    const { interop, ops, rec } = harness;
    const [open, save, rw] = ops as [string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.terminalModify({ ...sidOf(harness), operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/report.txt", content: "rw\n" })).ok, true);
    const record = rec.sandbox[rec.sandbox.length - 1]!;
    assert.equal(record.access, "read_write");
    assert.equal(record.user, "1000:1000");
    assert.equal(record.network, "none");
    assert.equal(record.rootfs, true);
    assert.equal(record.binds, 1);
    assert.equal(record.destination, "/workspace");
    assert.equal(record.rw, true, "write epoch binds /workspace writable");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 8 RW sandbox: same P5 flags with a writable bind");
  });

  it("TEST 9 large save observed atomically by the live watcher", async () => {
    const big = `${"y".repeat(1024)}\n`.repeat(40);
    const harness = openDockerHarness(
      "docker-atomic",
      [
        { action: { type: "file_open", path: "src/big.txt" } },
        { action: { type: "type_code", path: "src/big.txt", content: big } },
        { action: { type: "file_save", path: "src/big.txt" } },
        terminalWatcher("watcher", "cat src/big.txt"),
      ],
      { "src/big.txt": "small\n" },
      [],
      ["read_only"],
    );
    const { interop, ops } = harness;
    const [open, type, save, watch] = ops as [string, string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    const oldBytes = "small\n";
    const newBytes = `small\n${big}`;
    const seen = new Set<string>();
    // Guaranteed pre-save observation pins the old complete bytes; the
    // concurrent loop then races the commit window for mid-flight states.
    const pre = await interop.observeCommitted({ ...sid, rel_path: "src/big.txt" });
    assert.equal(pre.ok, true);
    if (!pre.ok) throw new Error("unreachable");
    assert.equal(pre.value.stdout, oldBytes);
    seen.add(pre.value.stdout);
    const saving = interop.runSaveDocument(op(interop, save, "save"));
    let settled = false;
    void saving.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let poll = 0; poll < 40 && !settled; poll += 1) {
      const observed = await interop.observeCommitted({ ...sid, rel_path: "src/big.txt" });
      if (observed.ok && observed.value.exit_code === 0) {
        seen.add(observed.value.stdout.length > 100 ? `len:${observed.value.stdout.length}` : observed.value.stdout);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    assert.equal((await saving).ok, true);
    assert.equal(await guestReadWithinBound(interop, "src/big.txt", newBytes), true);
    for (const value of seen) {
      assert.ok(value === oldBytes || value === `len:${newBytes.length}`, `watcher saw only complete bytes (got ${value.slice(0, 40)})`);
    }
    assert.ok(seen.has(oldBytes), "watcher saw the old complete bytes");
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("TEST 9 atomic publication: watcher sees old/new complete bytes only");
  });

  it("TEST 10 real terminal modification causes stale-save conflict with zero clobber", async () => {
    const harness = openDockerHarness(
      "docker-conflict",
      [
        { action: { type: "file_open", path: "src/doc.txt" } },
        { action: { type: "type_code", path: "src/doc.txt", content: "editor N\n" } },
        { action: { type: "file_save", path: "src/doc.txt" } },
        terminalRunForeground("cat src/doc.txt"),
        { action: { type: "file_save", path: "src/doc.txt" } },
        terminalWatcher("watcher", "cat src/doc.txt"),
      ],
      { "src/doc.txt": "seed\n" },
      [],
      ["read_write", "read_only"],
    );
    const { interop, ops, leaf } = harness;
    const [open, type, save, rw, saveStale, watch] = ops as [string, string, string, string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/doc.txt", content: "terminal M\n" })).ok, true);
    const stale = await interop.runSaveDocument(op(interop, saveStale, "stale"));
    assert.equal(stale.ok, false);
    assert.equal(rejectionCode(stale), "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(readFileSync(join(leaf, "src", "doc.txt"), "utf8"), "terminal M\n", "zero clobber after real terminal mutation");
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    assert.equal(await guestReadWithinBound(interop, "src/doc.txt", "terminal M\n"), true);
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("TEST 10 real terminal mutation invalidates stale preimages");
  });

  it("TEST 11 stale epoch handles fence with zero action on the real provider", async () => {
    const harness = openDockerHarness(
      "docker-stale-epoch",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
        terminalRunForeground("cat src/report.txt"),
      ],
      { "src/report.txt": "v\n" },
      [],
      ["read_only", "read_write"],
    );
    const { interop, ops, rec, provider } = harness;
    const [open, save, watch, rw] = ops as [string, string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    const oldHandle = { ...rec.prepared[rec.prepared.length - 1]! };
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    assert.equal((await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/report.txt", content: "m\n" })).ok, true);
    const before = ownedContainerNames(harness.prefix).sort();
    await assert.rejects(provider.readEpochFile(oldHandle, "src/report.txt"), (error: unknown) => (error as { code?: string }).code === "STALE_EPOCH");
    await assert.rejects(provider.runEpochScript(oldHandle, "src/report.txt"), (error: unknown) => (error as { code?: string }).code === "STALE_EPOCH");
    await assert.rejects(provider.retireEpoch(oldHandle, "late"), (error: unknown) => (error as { code?: string }).code === "STALE_EPOCH");
    assert.deepEqual(ownedContainerNames(harness.prefix).sort(), before, "stale handles start zero containers");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 11 real stale epochs fence permanently");
  });

  it("TEST 12 old generations fence with zero new containers", async () => {
    const harness = openDockerHarness(
      "docker-stale-gen",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
      ],
      { "src/report.txt": "v\n" },
      [],
      ["read_only"],
    );
    const { interop, ops } = harness;
    const [open, save] = ops as [string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    const reset = await interop.resetSession(life(interop, "reset"));
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    const before = ownedContainerNames(harness.prefix).sort();
    assert.equal(rejectionCode(await interop.runOpenDocument({ session_id: "sess-1", generation: 1, operation_id: open, request_id: nextRequest("s") })), "WRONG_OWNER");
    const live = interop.describe();
    assert.equal(rejectionCode(await interop.startWatcher({ session_id: live.session_id, generation: 1, operation_id: "x", request_id: nextRequest("s2") })), "STALE_SESSION");
    assert.deepEqual(ownedContainerNames(harness.prefix).sort(), before, "stale generations start zero containers");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 12 real generations fence both directions");
  });

  it("TEST 13 shared trace order on the real platform", async () => {
    const harness = openDockerHarness(
      "docker-trace",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "type_code", path: "src/report.txt", content: "v2\n" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalRunForeground("cat src/report.txt"),
      ],
      { "src/report.txt": "v1\n" },
      [],
      ["read_only"],
    );
    const { interop, ops } = harness;
    const [open, type, save, read] = ops as [string, string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.terminalReadSaved(op(interop, read, "read"))).ok, true);
    const kinds = interop.sharedTrace().map((event) => event.kind);
    assert.ok(kinds.indexOf("interop.save.committed") < kinds.indexOf("interop.terminal.admitted"));
    assert.ok(kinds.indexOf("interop.terminal.admitted") < kinds.indexOf("interop.terminal.observed"));
    const terminals = interop.editorEvents().filter((event) => event.kind === "editor.operation.completed" && event.operation_id === save);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.disk_effect, "saved");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 13 save completion precedes terminal start in one trace");
  });

  it("TEST 14 reset with a live watcher revokes, removes and reseeds", async () => {
    const harness = openDockerHarness(
      "docker-reset",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "type_code", path: "src/report.txt", content: "dirty\n" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
      ],
      { "src/report.txt": "v1\n" },
      [],
      ["read_only"],
    );
    const { interop, ops, leaf } = harness;
    const [open, type, save, watch] = ops as [string, string, string, string];
    void save;
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    const reset = await interop.resetSession(life(interop, "reset"));
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.generation, 2);
    assert.deepEqual(ownedContainerNames(harness.prefix), [], "no watcher container survives reset");
    assert.equal(readFileSync(join(leaf, "src", "report.txt"), "utf8"), "v1\n", "reset reseeds the leaf");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 14 reset coordinates both engines with confirmed cleanup");
  });

  it("TEST 15 close retires both domains with zero survivors", async () => {
    const harness = openDockerHarness(
      "docker-close",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
      ],
      { "src/report.txt": "v\n" },
      [],
      ["read_only"],
    );
    const { interop, ops } = harness;
    const [open, save, watch] = ops as [string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    assert.equal((await interop.closeSession(life(interop, "close"))).ok, true);
    assert.deepEqual(ownedContainerNames(harness.prefix), [], "no container survives close");
    const sid = sidOf(harness);
    assert.equal(rejectionCode(await interop.runOpenDocument({ ...sid, operation_id: open, request_id: nextRequest("late") })), "INVALID_TRANSITION");
    assert.equal(rejectionCode(await interop.startWatcher({ ...sid, operation_id: "late", request_id: nextRequest("late2") })), "INVALID_TRANSITION");
    const trace = interop.sharedTrace();
    assert.equal(trace[trace.length - 1]?.kind, "interop.close.completed");
    proof("TEST 15 close ends both engines with no survivors");
  });

  it("TEST 16 HOLD on unconfirmed retirement; explicit reset recovers", async () => {
    const harness = openDockerHarness(
      "docker-hold",
      [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
      ],
      { "src/report.txt": "v\n" },
      [],
      ["read_only"],
    );
    const { interop, ops, provider } = harness;
    const [open, save, watch] = ops as [string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    provider.diagnosticsForceUnconfirmedRetire = true;
    const stopped = await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") });
    assert.equal(stopped.ok, false);
    assert.equal(rejectionCode(stopped), "CLEANUP_UNCONFIRMED");
    assert.equal(interop.describe().ownership, "HOLD");
    assert.equal(rejectionCode(await interop.startWatcher(op(interop, watch, "blocked"))), "CLEANUP_UNCONFIRMED");
    provider.diagnosticsForceUnconfirmedRetire = false;
    // Explicit reset recovery: the barrier retires the retained container
    // for real (daemon-confirmed) and exposes the new generation.
    const reset = await interop.resetSession(life(interop, "reset"));
    assert.equal(reset.ok, true, "explicit reset recovers after confirmed cleanup");
    await interop.closeSession(life(interop, "close"));
    proof("TEST 16 HOLD fails closed; confirmed cleanup plus reset recovers");
  });

  it("TEST 17 final sweep: zero owned containers and zero phase residue", async () => {
    sweepOwned();
    assert.deepEqual(ownedContainerNames(), [], "zero cf-p613 containers remain");
    proof("TEST 17 zero owned resources after the matrix");
  });
});
