// P6.3 Docker access epochs — REAL Docker integration tests (canonical gate).
//
// Proves the P6 shared-workspace ownership model at the real container
// boundary (docs/P6-DESIGN-SPEC.md sections 26.1/26.3/26.9, ADR-0011):
// access mode is enforced by the Docker mount, never by TypeScript state
// alone. The WorkspaceCoordinator decides ownership/epochs (reviewed policy
// only, no command inference); DockerAccessEpochProvider enforces one
// access-specific container at a time with fencing, confirmed retirement
// and HOLD on uncertainty.
//
// TEST 1  real read-only mount (inspect RW=false; guest read ok, write EROFS)
// TEST 2  real read-write mount (inspect RW=true; guest write lands byte-exact)
// TEST 3  editor + approved RO watcher coexistence (no dual writer)
// TEST 4  host publication visible to the live RO watcher (bounded poll)
// TEST 5  RO -> RW requires real recreation with epoch advance + fencing
// TEST 6  RW -> editor waits for confirmed cleanup (exclusivity both ways)
// TEST 7  unconfirmed cleanup holds (no new epoch, fail closed)
// TEST 8  stale epoch handles fence with zero provider action
// TEST 9  reset with an active container (revoke/remove/confirm/invalidate)
// TEST 10 close removes the access container; late callbacks harmless
//
// Every resource is prefixed cf-p63- (installation label
// cf-p63-installation) under the repository's ignored temp root. Cleanup is
// ownership-scoped (installation label + live handles); no global prune ever.
// These tests FAIL (never silently skip) when the daemon or the pinned base
// image is unavailable — the P6.3 gate requires the real proof.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerAccessEpochProvider, type EpochHandle } from "../src/providers/docker-epochs.ts";
import { verifyEpochContainerConfiguration } from "../src/providers/docker-inspect.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.3");
const LEAF_ROOT = join(TEST_ROOT, "workspaces");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const PINNED_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const INSTALLATION_ID = "cf-p63-installation";
const INSTALL_LABEL = "com.course-factory.installation";

function resolveDockerExe(): string {
  const configured = process.env.CF_P63_DOCKER_EXE ?? process.env.CF_P54_DOCKER_EXE;
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
const SUFFIX = randomBytes(3).toString("hex");

function docker(...argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(DOCKER_EXE, argv, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function ownedContainerIds(): string[] {
  // --no-trunc: this daemon abbreviates -q output to 12 chars; ownership
  // assertions compare full 64-hex container identities.
  const r = docker("ps", "-aq", "--no-trunc", "--filter", `label=${INSTALL_LABEL}=${INSTALLATION_ID}`);
  return (r.stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
}

function inspectDoc(containerId: string): Record<string, unknown>[] {
  const r = docker("inspect", containerId);
  if (r.status !== 0) throw new Error(`docker inspect failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, unknown>[];
}

function containerRunning(containerId: string): boolean {
  const r = docker("inspect", containerId, "--format", "{{.State.Running}}");
  return r.status === 0 && r.stdout.trim() === "true";
}

function daemonOk(): boolean {
  const r = docker("version", "--format", "{{.Server.Version}}");
  return r.status === 0 && r.stdout.trim().length > 0;
}

function baseImageOk(): boolean {
  const r = docker("image", "inspect", PINNED_IMAGE, "--format", "{{.Id}}");
  return r.status === 0 && /^sha256:[0-9a-f]{64}$/.test(r.stdout.trim());
}

function ensureConfigContext(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ls = docker("--config", CONFIG_DIR, "context", "ls");
  if ((ls.stdout ?? "").includes("desktop-linux")) return;
  const created = docker(
    "--config", CONFIG_DIR, "context", "create",
    "desktop-linux",
    "--docker", "host=npipe:////./pipe/dockerDesktopLinuxEngine",
    "--description", "course-factory p6.3 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
}

function proof(message: string): void {
  console.log(`P6.3 PROOF: ${message}`);
}

// -- coordinator + reviewed policy (relative imports stay test-only) ----------

type CoordinatorModule = typeof import("../../workspace/src/coordinator.ts");
type PolicyModule = typeof import("../../workspace/src/policy.ts");

let coordinatorModule: CoordinatorModule;
let policyModule: PolicyModule;

interface Fixture {
  coordinator: CoordinatorModule["createWorkspaceCoordinator"] extends (...args: never[]) => infer R ? R : never;
  editorCapability: { kind: "editor_capability"; leaseId: string };
  terminalCapability: { kind: "terminal_capability"; leaseId: string };
  epochCapability: { kind: "epoch_capability"; leaseId: string };
  descriptor: { sessionId: string; generation: number; workspaceId: string; workspaceRevision: number; ownership: string; epoch: number; epochAccess: string | null };
  leaf: string;
}

const OP_RO = "op-p63-ro";
const OP_RW = "op-p63-rw";
const OP_RO2 = "op-p63-ro2";
const OP_RO3 = "op-p63-ro3";

async function openFixture(ops: readonly string[]): Promise<Fixture> {
  const seed = policyModule.createSeedManifest([]);
  assert.equal(seed.ok, true);
  assert.ok(seed.ok);
  const seedDigest = policyModule.computeSeedManifestDigest(seed.value);
  const access: Record<string, "read_only" | "read_write"> = {};
  for (const op of ops) access[op] = op === OP_RW ? "read_write" : "read_only";
  const policy = policyModule.createReviewedWorkspacePolicy(
    {
      course_id: "c01",
      lesson_id: "l01",
      lesson_compiled_digest: "b".repeat(64),
      seed_manifest_digest: seedDigest,
      sandbox_policy_digest: "c".repeat(64),
      terminal_access: access,
      reviewed_by: "reviewer",
      review_note: "p6.3 real docker",
    },
    ops,
  );
  assert.equal(policy.ok, true);
  assert.ok(policy.ok);
  const coordinator = coordinatorModule.createWorkspaceCoordinator();
  const opened = coordinator.openCombinedSession({ validatedIr: {}, reviewedPolicy: policy.value, seedManifest: seed.value });
  assert.equal(opened.ok, true);
  assert.ok(opened.ok);
  const leaf = join(LEAF_ROOT, opened.value.descriptor.sessionId);
  mkdirSync(leaf, { recursive: true });
  writeFileSync(join(leaf, "hello.txt"), "hello epoch\n");
  return {
    coordinator,
    editorCapability: opened.value.editorCapability,
    terminalCapability: opened.value.terminalCapability,
    epochCapability: opened.value.epochCapability,
    descriptor: opened.value.descriptor as Fixture["descriptor"],
    leaf,
  };
}

function makeProvider(): DockerAccessEpochProvider {
  return new DockerAccessEpochProvider({
    cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR },
    imageReference: PINNED_IMAGE,
    installationId: INSTALLATION_ID,
  });
}

/** Sandbox invariants + access for one live epoch container (P5 preserved, access epoch-specific). */
function checkSandbox(handle: EpochHandle, leaf: string, sessionId: string): void {
  const doc = inspectDoc(handle.containerId);
  const problems = verifyEpochContainerConfiguration(doc, {
    mountSource: leaf,
    imageReference: PINNED_IMAGE,
    access: handle.access,
    installationId: INSTALLATION_ID,
    sessionId,
  });
  assert.deepEqual(problems, [], `sandbox violations for ${handle.containerName}`);
  const mounts = (doc[0] as Record<string, unknown>)["Mounts"] as Array<Record<string, unknown>>;
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0]?.["Destination"], "/workspace");
  assert.equal(mounts[0]?.["RW"], handle.access === "read_write");
  const config = (doc[0] as Record<string, unknown>)["Config"] as Record<string, unknown>;
  const env = config["Env"] as string[];
  assert.ok(env.includes("HOME=/tmp/cf-home"), "scratch HOME under /tmp");
  assert.ok(!env.some((entry) => entry.includes("/workspace/.home")), "no legacy workspace HOME in epoch containers");
  const hostConfig = (doc[0] as Record<string, unknown>)["HostConfig"] as Record<string, unknown>;
  assert.equal(hostConfig["Privileged"], false);
  assert.equal(config["User"], "1000:1000");
  assert.equal(hostConfig["NetworkMode"], "none");
  assert.equal(hostConfig["ReadonlyRootfs"], true);
  proof(`SANDBOX ${handle.containerName}: Privileged=false User=1000:1000 NetworkMode=none ReadonlyRootfs=true RW=${String(mounts[0]?.["RW"])} binds=1`);
}

describe("P6.3 Docker access epochs — real platform proof", () => {
  let fixture: Fixture;
  let provider: DockerAccessEpochProvider;
  let roHandle: EpochHandle;
  let roLease: { kind: string; leaseId: string; sessionId: string; generation: number; workspaceId: string; epoch: number; access: string; operationId: string; requestId: string; peerId: string | null };
  let rwHandle: EpochHandle;
  let rwLease: { kind: string; leaseId: string; sessionId: string; generation: number; workspaceId: string; epoch: number; access: string; operationId: string; requestId: string; peerId: string | null };
  let roEpoch = 0;
  let rwEpoch = 0;

  before(async () => {
    assert.equal(daemonOk(), true, "P6.3 requires a reachable Docker daemon (no fake PASS)");
    assert.equal(baseImageOk(), true, "P6.3 requires the pinned base image locally");
    ensureConfigContext();
    coordinatorModule = await import("../../workspace/src/coordinator.ts");
    policyModule = await import("../../workspace/src/policy.ts");
    mkdirSync(LEAF_ROOT, { recursive: true });
    fixture = await openFixture([OP_RO, OP_RW, OP_RO2, OP_RO3]);
    provider = makeProvider();
    proof(`SETUP session=${fixture.descriptor.sessionId} leaf ready, owned=${JSON.stringify(ownedContainerIds())}`);
  });

  after(async () => {
    // Ownership-scoped sweep only: live handles first, then any straggler
    // carrying this run's installation label. Never a global prune.
    for (const id of ownedContainerIds()) {
      docker("rm", "--force", id);
    }
    const remaining = ownedContainerIds();
    console.log(`P6.3 PROOF: CLEANUP remaining cf-p63 containers: ${JSON.stringify(remaining)}`);
    assert.deepEqual(remaining, []);
  });

  it("TEST 1 — real read-only mount denies guest writes", async () => {
    const admitted = await fixture.coordinator.runTerminalOperation(fixture.terminalCapability, OP_RO, "req-p63-ro");
    assert.equal(admitted.ok, true);
    assert.ok(admitted.ok);
    roLease = admitted.value.lease as unknown as typeof roLease;
    roEpoch = admitted.value.descriptor.epoch;
    roHandle = await provider.prepareEpoch({
      sessionId: admitted.value.permit.session_id,
      generation: admitted.value.permit.generation,
      epoch: admitted.value.permit.epoch,
      access: admitted.value.permit.access,
      leafHostPath: fixture.leaf,
      leaseId: admitted.value.permit.lease_id,
      policyDigest: admitted.value.permit.policy_digest,
      containerName: `cf-p63-t1-ro-${SUFFIX}`,
      testRunId: `cf-p63-run-${SUFFIX}`,
    });
    checkSandbox(roHandle, fixture.leaf, fixture.descriptor.sessionId);
    const read = await provider.readEpochFile(roHandle, "hello.txt");
    assert.equal(read.exitCode, 0);
    assert.equal(read.stdout, "hello epoch\n");
    const denied = await provider.attemptEpochWrite(roHandle, "should-not-write.txt", "nope");
    assert.notEqual(denied.exitCode, 0, "RO guest write must fail inside the container");
    assert.equal(existsSync(join(fixture.leaf, "should-not-write.txt")), false, "host file must not appear");
    proof(`TEST 1 RO mount: container=${roHandle.containerName} RW=false read=ok write=denied(exit ${String(denied.exitCode)})`);
  });

  it("TEST 3 — editor owns the workspace beside the approved RO watcher", async () => {
    assert.equal(fixture.coordinator.describe().ownership, "EDITOR_OWNED");
    assert.equal(containerRunning(roHandle.containerId), true);
    const editor = await fixture.coordinator.runEditorOperation(fixture.editorCapability, "edit-p63-1", "req-p63-edit-1");
    assert.equal(editor.ok, true, "editor reserves beside the RO observer");
    if (editor.ok) fixture.coordinator.releaseEditor(editor.value.lease);
    const read = await provider.readEpochFile(roHandle, "hello.txt");
    assert.equal(read.exitCode, 0);
    const denied = await provider.attemptEpochWrite(roHandle, "watcher-write.txt", "x");
    assert.notEqual(denied.exitCode, 0);
    assert.equal(fixture.coordinator.describe().ownership, "EDITOR_OWNED");
    proof("TEST 3 EDITOR_OWNED + RO watcher: editor reserves, watcher alive, read ok, write denied, no dual writer");
  });

  it("TEST 4 — host publication becomes visible to the RO watcher", async () => {
    writeFileSync(join(fixture.leaf, "hello.txt"), "hello epoch\npublished-line\n");
    const deadline = Date.now() + 10_000;
    let observed = "";
    for (;;) {
      const read = await provider.readEpochFile(roHandle, "hello.txt");
      assert.equal(read.exitCode, 0);
      observed = read.stdout;
      if (observed === "hello epoch\npublished-line\n") break;
      assert.ok(Date.now() < deadline, `watcher never observed the committed bytes (last: ${JSON.stringify(observed)})`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    assert.equal(observed, "hello epoch\npublished-line\n");
    proof("TEST 4 host publication: RO watcher reopened the complete committed bytes within the bound");
  });

  it("TEST 5 — RO to RW requires real recreation with epoch advance", async () => {
    const oldId = roHandle.containerId;
    const before = await fixture.coordinator.runTerminalOperation(fixture.terminalCapability, OP_RW, "req-p63-rw");
    assert.equal(before.ok, false, "RW must wait while the RO observer lives");
    assert.ok(!before.ok && before.rejection.code === "WORKSPACE_BUSY");
    const stopped = await fixture.coordinator.stopTerminal(fixture.terminalCapability, OP_RO, "req-p63-stop-ro");
    assert.equal(stopped.ok, true);
    const retired = await provider.retireEpoch(roHandle, "ro_to_rw");
    assert.equal(retired.cleanup, "confirmed");
    assert.equal(docker("inspect", oldId).status !== 0, true, "old container absence must be daemon-confirmed");
    const admitted = await fixture.coordinator.runTerminalOperation(fixture.terminalCapability, OP_RW, "req-p63-rw-2");
    assert.equal(admitted.ok, true);
    assert.ok(admitted.ok);
    rwLease = admitted.value.lease as unknown as typeof rwLease;
    rwEpoch = admitted.value.descriptor.epoch;
    assert.equal(rwEpoch, roEpoch + 1, "RW handoff advances the container epoch");
    rwHandle = await provider.prepareEpoch({
      sessionId: admitted.value.permit.session_id,
      generation: admitted.value.permit.generation,
      epoch: admitted.value.permit.epoch,
      access: admitted.value.permit.access,
      leafHostPath: fixture.leaf,
      leaseId: admitted.value.permit.lease_id,
      policyDigest: admitted.value.permit.policy_digest,
      containerName: `cf-p63-t5-rw-${SUFFIX}`,
      testRunId: `cf-p63-run-${SUFFIX}`,
    });
    assert.notEqual(rwHandle.containerId, oldId, "new epoch means a new runtime identity");
    checkSandbox(rwHandle, fixture.leaf, fixture.descriptor.sessionId);
    await assert.rejects(provider.readEpochFile(roHandle, "hello.txt"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    proof(`TEST 5 RO->RW recreation: old removed+absent, epoch ${roEpoch}->${rwEpoch}, new=${rwHandle.containerName} RW=true, stale fenced`);
  });

  it("TEST 2 — real read-write mount lands exact bytes on the host", async () => {
    const content = "rw-exact-bytes-1234";
    const wrote = await provider.attemptEpochWrite(rwHandle, "rw-proof.txt", content);
    assert.equal(wrote.exitCode, 0, `RW guest write must succeed: ${wrote.stderr}`);
    assert.equal(readFileSync(join(fixture.leaf, "rw-proof.txt"), "utf8"), content);
    proof("TEST 2 RW mount: inspect RW=true, guest write exit 0, host bytes exact");
  });

  it("TEST 6 — RW to editor waits for confirmed cleanup", async () => {
    const early = await fixture.coordinator.runEditorOperation(fixture.editorCapability, "edit-p63-2", "req-p63-edit-2");
    assert.equal(early.ok, false, "editor must not resume while RW owns the leaf");
    assert.ok(!early.ok && early.rejection.code === "WORKSPACE_BUSY");
    const retired = await provider.retireEpoch(rwHandle, "rw_to_editor");
    assert.equal(retired.cleanup, "confirmed");
    assert.equal(docker("inspect", rwHandle.containerId).status !== 0, true);
    const released = await fixture.coordinator.releaseTerminal(rwLease as never);
    assert.equal(released.ok, true);
    assert.equal(fixture.coordinator.describe().ownership, "EDITOR_OWNED");
    const editor = await fixture.coordinator.runEditorOperation(fixture.editorCapability, "edit-p63-3", "req-p63-edit-3");
    assert.equal(editor.ok, true, "editor resumes only after confirmed RW cleanup");
    if (editor.ok) fixture.coordinator.releaseEditor(editor.value.lease);
    await assert.rejects(provider.readEpochFile(rwHandle, "hello.txt"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    proof("TEST 6 RW->EDITOR: early editor rejected, RW removed+absent, editor resumed, stale RW fenced");
  });

  it("TEST 8 — stale epoch handles take zero provider action", async () => {
    const admitted = await fixture.coordinator.runTerminalOperation(fixture.terminalCapability, OP_RO2, "req-p63-ro2");
    assert.equal(admitted.ok, true);
    assert.ok(admitted.ok);
    const live = await provider.prepareEpoch({
      sessionId: admitted.value.permit.session_id,
      generation: admitted.value.permit.generation,
      epoch: admitted.value.permit.epoch,
      access: admitted.value.permit.access,
      leafHostPath: fixture.leaf,
      leaseId: admitted.value.permit.lease_id,
      policyDigest: admitted.value.permit.policy_digest,
      containerName: `cf-p63-t8-ro-${SUFFIX}`,
      testRunId: `cf-p63-run-${SUFFIX}`,
    });
    const liveId = live.containerId;
    const before = ownedContainerIds().sort();
    await assert.rejects(provider.readEpochFile(roHandle, "hello.txt"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    await assert.rejects(provider.readEpochFile(rwHandle, "hello.txt"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    const late = provider.onLateContainerEvent({ containerId: roHandle.containerId, epoch: roEpoch, generation: 1 });
    assert.equal(late.fenced, true);
    assert.deepEqual(ownedContainerIds().sort(), before, "stale authority must not start/stop any container");
    assert.equal(containerRunning(liveId), true);
    const retired = await provider.retireEpoch(live, "test8");
    assert.equal(retired.cleanup, "confirmed");
    const stopped = await fixture.coordinator.stopTerminal(fixture.terminalCapability, OP_RO2, "req-p63-stop-ro2");
    assert.equal(stopped.ok, true);
    proof("TEST 8 STALE_EPOCH: old leases fence with zero provider action; live epoch untouched");
  });

  it("TEST 7 — unconfirmed cleanup holds new epochs", async () => {
    const admitted = await fixture.coordinator.runTerminalOperation(fixture.terminalCapability, OP_RO3, "req-p63-ro3");
    assert.equal(admitted.ok, true);
    assert.ok(admitted.ok);
    const live = await provider.prepareEpoch({
      sessionId: admitted.value.permit.session_id,
      generation: admitted.value.permit.generation,
      epoch: admitted.value.permit.epoch,
      access: admitted.value.permit.access,
      leafHostPath: fixture.leaf,
      leaseId: admitted.value.permit.lease_id,
      policyDigest: admitted.value.permit.policy_digest,
      containerName: `cf-p63-t7-ro-${SUFFIX}`,
      testRunId: `cf-p63-run-${SUFFIX}`,
    });
    provider.diagnosticsForceUnconfirmedRetire = true;
    const outcome = await provider.retireEpoch(live, "test7");
    assert.equal(outcome.cleanup, "unconfirmed");
    assert.equal(provider.isHeld(), true);
    await assert.rejects(
      provider.prepareEpoch({
        sessionId: admitted.value.permit.session_id,
        generation: admitted.value.permit.generation,
        epoch: admitted.value.permit.epoch + 1,
        access: "read_only",
        leafHostPath: fixture.leaf,
        leaseId: "lease-p63-hold-next",
        policyDigest: admitted.value.permit.policy_digest,
        containerName: `cf-p63-t7-next-${SUFFIX}`,
        testRunId: `cf-p63-run-${SUFFIX}`,
      }),
      (error: unknown) => codeOf(error) === "CLEANUP_UNCONFIRMED",
    );
    assert.ok(ownedContainerIds().includes(live.containerId), "unconfirmed resource is retained, not dropped");
    provider.diagnosticsForceUnconfirmedRetire = false;
    const confirmed = await provider.retireEpoch(live, "reconcile");
    assert.equal(confirmed.cleanup, "confirmed");
    assert.equal(provider.isHeld(), false);
    const stopped = await fixture.coordinator.stopTerminal(fixture.terminalCapability, OP_RO3, "req-p63-stop-ro3");
    assert.equal(stopped.ok, true);
    proof("TEST 7 HOLD: unconfirmed retire blocks new epochs with the resource retained; confirmed retire releases");
  });

  it("TEST 9 — reset with an active container revokes, removes and invalidates", async () => {
    const fresh = await openFixture([OP_RO, OP_RW, OP_RO2, OP_RO3]);
    const freshProvider = makeProvider();
    const admitted = await fresh.coordinator.runTerminalOperation(fresh.terminalCapability, OP_RO, "req-p63-reset-ro");
    assert.equal(admitted.ok, true);
    assert.ok(admitted.ok);
    const live = await freshProvider.prepareEpoch({
      sessionId: admitted.value.permit.session_id,
      generation: admitted.value.permit.generation,
      epoch: admitted.value.permit.epoch,
      access: admitted.value.permit.access,
      leafHostPath: fresh.leaf,
      leaseId: admitted.value.permit.lease_id,
      policyDigest: admitted.value.permit.policy_digest,
      containerName: `cf-p63-t9-ro-${SUFFIX}`,
      testRunId: `cf-p63-run-${SUFFIX}`,
    });
    const reset = await fresh.coordinator.resetCombinedSession(
      { ...fresh.descriptor, ownership: fresh.coordinator.describe().ownership } as never,
      "req-p63-reset",
    );
    assert.equal(reset.ok, true, "reset latches while the container lives");
    const staleAttempt = await fresh.coordinator.runTerminalOperation(fresh.terminalCapability, OP_RW, "req-p63-reset-rw");
    assert.equal(staleAttempt.ok, false, "revoked pre-reset authority must not acquire");
    assert.ok(!staleAttempt.ok && ["WORKSPACE_REVOKED", "STALE_SESSION"].includes(staleAttempt.rejection.code));
    const retired = await freshProvider.retireEpoch(live, "reset");
    assert.equal(retired.cleanup, "confirmed");
    assert.equal(freshProvider.liveEpoch(), null);
    await assert.rejects(freshProvider.readEpochFile(live, "hello.txt"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    assert.ok(reset.ok);
    assert.equal(reset.value.descriptor.generation, 2, "reset exposes the next generation");
    assert.equal(freshProvider.isHeld(), false);
    const closed = await fresh.coordinator.closeCombinedSession(reset.value.descriptor as never, "req-p63-reset-close");
    assert.equal(closed.ok, true);
    rmSync(fresh.leaf, { recursive: true, force: true });
    proof("TEST 9 RESET: authority revoked, container removed+confirmed, old epoch/session invalid, fresh generation exposed");
  });

  it("TEST 10 — close removes the access container and late callbacks stay harmless", async () => {
    const fresh = await openFixture([OP_RO]);
    const freshProvider = makeProvider();
    const admitted = await fresh.coordinator.runTerminalOperation(fresh.terminalCapability, OP_RO, "req-p63-close-ro");
    assert.equal(admitted.ok, true);
    assert.ok(admitted.ok);
    const live = await freshProvider.prepareEpoch({
      sessionId: admitted.value.permit.session_id,
      generation: admitted.value.permit.generation,
      epoch: admitted.value.permit.epoch,
      access: admitted.value.permit.access,
      leafHostPath: fresh.leaf,
      leaseId: admitted.value.permit.lease_id,
      policyDigest: admitted.value.permit.policy_digest,
      containerName: `cf-p63-t10-ro-${SUFFIX}`,
      testRunId: `cf-p63-run-${SUFFIX}`,
    });
    const closed = await fresh.coordinator.closeCombinedSession(
      { ...fresh.descriptor, ownership: fresh.coordinator.describe().ownership } as never,
      "req-p63-close",
    );
    assert.equal(closed.ok, true);
    const outcome = await freshProvider.closeProvider(live);
    assert.equal(outcome.cleanup, "confirmed");
    assert.equal(freshProvider.liveEpoch(), null);
    const late = freshProvider.onLateContainerEvent({ containerId: live.containerId, epoch: live.epoch, generation: live.generation });
    assert.equal(late.fenced, true, "late callbacks after close cannot reopen authority");
    assert.equal(freshProvider.liveEpoch(), null);
    const lateAttempt = await fresh.coordinator.runTerminalOperation(fresh.terminalCapability, OP_RO, "req-p63-close-late");
    assert.equal(lateAttempt.ok, false, "closed authority must not acquire");
    assert.ok(!lateAttempt.ok && ["WORKSPACE_REVOKED", "STALE_SESSION", "INVALID_TRANSITION"].includes(lateAttempt.rejection.code));
    rmSync(fresh.leaf, { recursive: true, force: true });
    proof("TEST 10 CLOSE: container gone, coordinator closed, late callback harmless");
  });

  it("P6.3 renderer and environment boundary holds on the real path", async () => {
    // Snapshots stay identifier-only (no host paths, no container ids).
    const snapshot = fixture.coordinator.getCombinedSnapshot(
      { ...fixture.descriptor, ownership: fixture.coordinator.describe().ownership } as never,
      0,
    );
    assert.equal(snapshot.ok, true);
    assert.ok(snapshot.ok);
    const serialized = JSON.stringify(snapshot.value);
    assert.ok(!serialized.includes(fixture.leaf), "snapshot must not leak the host leaf");
    assert.ok(!serialized.includes("cf-p63-t1-ro"), "snapshot must not leak runtime container names");
    // Env/mount extras ride no renderer path: the strict epoch args schema
    // rejects them with zero Docker action on the REAL provider too.
    const before = ownedContainerIds().sort();
    await assert.rejects(
      provider.prepareEpoch({
        sessionId: fixture.descriptor.sessionId,
        generation: fixture.descriptor.generation,
        epoch: 99,
        access: "read_only",
        leafHostPath: fixture.leaf,
        leaseId: "lease-p63-hostile",
        policyDigest: "d".repeat(64),
        containerName: `cf-p63-hostile-${SUFFIX}`,
        testRunId: `cf-p63-run-${SUFFIX}`,
        env: { HOME: "/tmp/evil" },
      }),
      (error: unknown) => codeOf(error) === "INVALID_REQUEST",
    );
    assert.deepEqual(ownedContainerIds().sort(), before);
    proof("RENDERER/ENV: snapshot identifier-only; env/mount extras reject with zero containers");
  });
});
