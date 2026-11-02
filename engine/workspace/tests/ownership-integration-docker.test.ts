// P6.5 Ownership integration gate — REAL Windows + Docker composition proof.
//
// Canonical task: P6-DESIGN-SPEC section 22, P6.5 Ownership integration gate
// (PASS "Real writer exclusion, handoff scan, watcher visibility and failure
// cleanup"). Canonical authority: P6-DESIGN-SPEC section 26, ADR-0011.
//
// Proves end-to-end on the real platform that the three independently-passing
// layers operate as ONE fail-closed ownership system on exactly the same
// authoritative workspace leaf:
//
//   ReviewedWorkspacePolicy -> WorkspaceCoordinator -> DockerAccessEpochProvider
//   (mount enforcement) + WindowsFileAdapter (host publication)
//
// TEST 1  editor-owned host publish via the coordinator lease succeeds.
// TEST 2  EDITOR_OWNED + live RO watcher: host publish succeeds, guest write denied.
// TEST 3  RO watcher observes the exact committed bytes within the bound.
// TEST 4  terminal RW acquisition blocks until the RO observer retires.
// TEST 5  terminal RW modifies the shared workspace (Docker -> host coherence).
// TEST 6  host adapter write during TERMINAL_OWNED fails with zero mutation.
// TEST 7  RW retirement (daemon-confirmed through the coordinator barrier)
//         precedes editor resume.
// TEST 8  old editor lease after the epoch transition cannot publish.
// TEST 9  old terminal epoch cannot prepare: stale rejection, zero action.
// TEST 10 terminal external change causes stale editor preimage conflict.
// TEST 11 large atomic host publication: RO watcher sees only complete bytes.
// TEST 12 reset with live composed resources revokes, removes, confirms.
// TEST 13 close retires the epoch container; late callbacks stay harmless.
// TEST 14 HOLD (unconfirmed retirement) fences both writer paths.
//
// Every resource is prefixed cf-p65- under temp/P6.5/ownership-docker.
// Cleanup is ownership-scoped (live handles first, then the cf-p65- name
// sweep); no global prune ever. These tests FAIL (never skip) when the daemon
// or the pinned image is unavailable — the P6.5 gate requires the real proof.
//
// No typing, no scheduler, no Monaco, no semantic editor operations, no UI.
// Controlled publication uses coordinator-issued editor leases only, as an
// internal integration harness (never a semantic save, never renderer input).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerAccessEpochProvider, type EpochHandle } from "../../terminal/src/providers/docker-epochs.ts";
import {
  computeSeedManifestDigest,
  createReviewedWorkspacePolicy,
  createSeedManifest,
  sha256Hex,
} from "../src/policy.ts";
import {
  checkPermitAcquisition,
  type WorkspaceExecutionPermit,
} from "../src/protocol.ts";
import {
  createWorkspaceCoordinator,
  type EditorLease,
  type SharedWorkspaceCoordinator,
  type TerminalLease,
} from "../src/coordinator.ts";
import {
  openWindowsFileAdapter,
  type AdapterAuthority,
  type WindowsFileAdapter,
} from "../src/file-adapter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.5", "ownership-docker");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const PINNED_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const INSTALLATION_ID = "cf-p65-installation";
const SUFFIX = randomBytes(3).toString("hex");
const TEST_RUN_ID = `cf-p65-run-${SUFFIX}`;

const OP_RO = "op-p65-ro";
const OP_RO2 = "op-p65-ro2";
const OP_RO3 = "op-p65-ro3";
const OP_RO4 = "op-p65-ro4";
const OP_RW = "op-p65-rw";
const OP_RW2 = "op-p65-rw2";
const OP_RW3 = "op-p65-rw3";

function proof(message: string): void {
  console.log(`P6.5 PROOF: ${message}`);
}

function resolveDockerExe(): string {
  const configured = process.env["CF_P65_DOCKER_EXE"];
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

function daemonOk(): boolean {
  const r = docker("version", "--format", "{{.Server.Version}}");
  return r.status === 0 && r.stdout.trim().length > 0;
}

function baseImageOk(): boolean {
  const r = docker("image", "inspect", PINNED_IMAGE, "--format", "{{.Id}}");
  return r.status === 0 && /^sha256:[0-9a-f]{64}$/.test(r.stdout.trim());
}

function ownedContainerNames(): string[] {
  const r = docker("ps", "-aq", "--no-trunc", "--filter", "name=cf-p65-");
  return (r.stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
}

function ensureConfigContext(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ls = docker("--config", CONFIG_DIR, "context", "ls");
  if ((ls.stdout ?? "").includes("desktop-linux")) return;
  const created = docker(
    "--config", CONFIG_DIR, "context", "create",
    "desktop-linux",
    "--docker", "host=npipe:////./pipe/dockerDesktopLinuxEngine",
    "--description", "course-factory p6.5 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
}

interface ComposedFixture {
  coord: SharedWorkspaceCoordinator;
  editorCapability: { kind: "editor_capability"; leaseId: string };
  terminalCapability: { kind: "terminal_capability"; leaseId: string };
  epochCapability: { kind: "epoch_capability"; leaseId: string };
  leaf: string;
  staging: string;
  adapter: WindowsFileAdapter;
  provider: DockerAccessEpochProvider;
  bridge: { realHandle: EpochHandle | null };
}

let fixtureSeq = 0;

function openFixture(ops: readonly string[]): ComposedFixture {
  fixtureSeq += 1;
  const seed = createSeedManifest([]);
  assert.equal(seed.ok, true);
  if (!seed.ok) throw new Error("unreachable");
  const access: Record<string, "read_only" | "read_write"> = {};
  for (const op of ops) access[op] = op === OP_RW || op === OP_RW2 || op === OP_RW3 ? "read_write" : "read_only";
  const policy = createReviewedWorkspacePolicy(
    {
      course_id: "c01",
      lesson_id: "l01",
      lesson_compiled_digest: sha256Hex(`p65-compiled-${SUFFIX}-${fixtureSeq}`),
      seed_manifest_digest: computeSeedManifestDigest(seed.value),
      sandbox_policy_digest: sha256Hex("p65-sandbox-policy"),
      terminal_access: access,
      reviewed_by: "reviewer",
      review_note: "p6.5 real integration",
    },
    ops,
  );
  assert.equal(policy.ok, true);
  if (!policy.ok) throw new Error("unreachable");
  const provider = new DockerAccessEpochProvider({
    cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR },
    imageReference: PINNED_IMAGE,
    installationId: INSTALLATION_ID,
  });
  const bridge: { realHandle: EpochHandle | null } = { realHandle: null };
  const coord = createWorkspaceCoordinator({
    // Integration seam (test harness only, never a second authority): the
    // coordinator stays the sole ownership authority; retirement through the
    // coordinator barrier delegates to the REAL provider so editor authority
    // can resume only after daemon-confirmed container absence.
    provider: {
      prepare: () => Promise.resolve("confirmed" as const),
      retire: (cause: string) => {
        const live = bridge.realHandle;
        if (live === null) return Promise.resolve("confirmed" as const);
        return provider.retireEpoch(live, cause).then(
          (outcome) => {
            if (outcome.cleanup === "confirmed") bridge.realHandle = null;
            return outcome.cleanup;
          },
          () => "unconfirmed" as const,
        );
      },
    },
  });
  const opened = coord.openCombinedSession({ validatedIr: {}, reviewedPolicy: policy.value, seedManifest: seed.value });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  const d = opened.value.descriptor;
  const leaf = join(TEST_ROOT, `cf-p65-leaf-${SUFFIX}-${fixtureSeq}`);
  const staging = join(TEST_ROOT, `cf-p65-staging-${SUFFIX}-${fixtureSeq}`);
  mkdirSync(leaf, { recursive: true });
  mkdirSync(staging, { recursive: true });
  const bound = openWindowsFileAdapter({
    sessionId: d.sessionId,
    generation: d.generation,
    workspaceId: d.workspaceId,
    leafHostPath: leaf,
    stagingHostPath: staging,
  });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error("unreachable");
  return {
    coord,
    editorCapability: opened.value.editorCapability,
    terminalCapability: opened.value.terminalCapability,
    epochCapability: opened.value.epochCapability,
    leaf,
    staging,
    adapter: bound.value,
    provider,
    bridge,
  };
}

function authority(fixture: ComposedFixture, lease: EditorLease): AdapterAuthority {
  const d = fixture.coord.describe();
  const live = fixture.coord.getLiveFacts();
  return { lease, ownership: d.ownership, liveEpoch: d.epoch, revokedLeaseIds: [...live.revoked_lease_ids] };
}

async function editorPublish(
  fixture: ComposedFixture,
  portablePath: string,
  content: string,
  mode: "create" | "replace",
  expected: { exists: boolean; digest: string | null },
  editTag: string,
): Promise<string> {
  const admitted = await fixture.coord.runEditorOperation(fixture.editorCapability, editTag, `req-p65-${editTag}-${SUFFIX}`);
  assert.equal(admitted.ok, true, `editor reserves for ${portablePath}`);
  if (!admitted.ok) throw new Error("unreachable");
  const outcome = await fixture.adapter.publishDocument(authority(fixture, admitted.value.lease), {
    portablePath,
    content,
    mode,
    expected,
  });
  assert.equal(outcome.ok, true, `host publish succeeds for ${portablePath}`);
  if (outcome.ok !== true) throw new Error(`publish rejected (host publish must succeed for ${portablePath})`);
  assert.equal(fixture.coord.releaseEditor(admitted.value.lease).ok, true);
  return outcome.value.digest;
}

async function prepareReal(fixture: ComposedFixture, permit: WorkspaceExecutionPermit, purpose: string): Promise<EpochHandle> {
  const handle = await fixture.provider.prepareEpoch({
    sessionId: permit.session_id,
    generation: permit.generation,
    epoch: permit.epoch,
    access: permit.access,
    leafHostPath: fixture.leaf,
    leaseId: permit.lease_id,
    policyDigest: permit.policy_digest,
    containerName: `cf-p65-${purpose}-${SUFFIX}`,
    testRunId: TEST_RUN_ID,
  });
  fixture.bridge.realHandle = handle;
  return handle;
}

async function guestReadWithinBound(handle: EpochHandle, provider: DockerAccessEpochProvider, rel: string, expected: string, boundMs = 5000): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  for (;;) {
    const read = await provider.readEpochFile(handle, rel);
    if (read.exitCode === 0 && read.stdout === expected) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

let sharedFixture: ComposedFixture;

before(async () => {
  assert.equal(daemonOk(), true, "P6.5 requires a reachable Docker daemon (no fake PASS)");
  assert.equal(baseImageOk(), true, "P6.5 requires the pinned base image locally");
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  ensureConfigContext();
  sharedFixture = openFixture([OP_RO, OP_RO2, OP_RO3, OP_RO4, OP_RW, OP_RW2, OP_RW3]);
  proof(`SETUP session leaf ready, owned=${JSON.stringify(ownedContainerNames())}`);
});

after(async () => {
  for (const id of ownedContainerNames()) docker("rm", "--force", id);
  rmSync(TEST_ROOT, { recursive: true, force: true });
  const remaining = ownedContainerNames();
  console.log(`P6.5 PROOF: CLEANUP remaining cf-p65 containers: [${remaining.join(",")}]`);
  assert.deepEqual(remaining, []);
});

describe("P6.5 real ownership integration (Windows + Docker)", () => {
  let fixture: ComposedFixture;
  let roHandle: EpochHandle;
  let rwHandle: EpochHandle;
  let rwLease: TerminalLease;
  let preHandoffEditorLease: EditorLease;
  let digestN: string;

  before(() => {
    fixture = sharedFixture;
  });

  it("TEST 1 editor-owned host publish succeeds through the coordinator lease", async () => {
    assert.equal(fixture.coord.describe().ownership, "EDITOR_OWNED");
    const digest = await editorPublish(fixture, "lesson.txt", "host bytes one\n", "create", { exists: false, digest: null }, "edit-p65-t1");
    assert.equal(readFileSync(join(fixture.leaf, "lesson.txt"), "utf8"), "host bytes one\n");
    assert.equal(readdirSync(fixture.staging).length, 0, "no staging residue");
    void digest;
    proof("TEST 1 editor-owned host publish succeeds");
  });

  it("TEST 2 EDITOR_OWNED plus live RO watcher: host publish succeeds, guest write denied", async () => {
    const admitted = await fixture.coord.runTerminalOperation(fixture.terminalCapability, OP_RO, `req-p65-ro-${SUFFIX}`);
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    roHandle = await prepareReal(fixture, admitted.value.permit, "ro");
    assert.equal(fixture.coord.describe().ownership, "EDITOR_OWNED");
    await editorPublish(fixture, "watched.txt", "watched bytes v1\n", "create", { exists: false, digest: null }, "edit-p65-t2");
    const denied = await fixture.provider.attemptEpochWrite(roHandle, "evil.txt", "nope");
    assert.notEqual(denied.exitCode, 0, "TEST 2 RO denial: guest write must fail");
    assert.equal(existsSync(join(fixture.leaf, "evil.txt")), false, "no guest bytes land on the host leaf");
    proof("TEST 2 EDITOR_OWNED + RO watcher: host publish succeeds, guest write denied");
  });

  it("TEST 3 RO watcher observes the exact committed bytes within the bound", async () => {
    assert.equal(await guestReadWithinBound(roHandle, fixture.provider, "watched.txt", "watched bytes v1\n"), true);
    proof("TEST 3 RO watcher observes exact committed bytes");
  });

  it("P6.5 sandbox intact on the composed epochs (P5 guarantees preserved)", async () => {
    const raw = docker("inspect", roHandle.containerId);
    assert.equal(raw.status, 0);
    const doc = JSON.parse(raw.stdout) as Array<Record<string, unknown>>;
    const hostConfig = doc[0]?.["HostConfig"] as Record<string, unknown>;
    const config = doc[0]?.["Config"] as Record<string, unknown>;
    const mounts = doc[0]?.["Mounts"] as Array<Record<string, unknown>>;
    assert.equal(config?.["User"], "1000:1000");
    assert.equal(hostConfig?.["NetworkMode"], "none");
    assert.equal(hostConfig?.["ReadonlyRootfs"], true);
    assert.equal(hostConfig?.["Privileged"], false);
    assert.equal(mounts.length, 1, "exactly one bind: the shared leaf at /workspace");
    assert.equal(mounts[0]?.["Destination"], "/workspace");
    assert.equal(mounts[0]?.["RW"], false, "SANDBOX composed RO epoch binds /workspace readonly");
    const env = (config?.["Env"] as string[]) ?? [];
    assert.ok(env.includes("HOME=/tmp/cf-home"), "scratch HOME under /tmp, never under /workspace");
    proof("SANDBOX composed RO epoch: User=1000:1000 NetworkMode=none ReadonlyRootfs=true RW=false binds=1");
  });

  it("TEST 4 terminal RW acquisition blocks until the RO observer retires", async () => {
    const blocked = await fixture.coord.runTerminalOperation(fixture.terminalCapability, OP_RW, `req-p65-rw-blocked-${SUFFIX}`);
    assert.equal(blocked.ok, false, "RW must wait while the RO observer lives");
    if (!blocked.ok) assert.equal(blocked.rejection.code, "WORKSPACE_BUSY");
    const stopped = await fixture.coord.stopTerminal(fixture.terminalCapability, OP_RO, `req-p65-stop-ro-${SUFFIX}`);
    assert.equal(stopped.ok, true);
    const retired = await fixture.provider.retireEpoch(roHandle, "ro_to_rw");
    assert.equal(retired.cleanup, "confirmed");
    fixture.bridge.realHandle = null;
    assert.equal(docker("inspect", roHandle.containerId).status !== 0, true, "old container absence is daemon-confirmed");
    const epochBefore = fixture.coord.describe().epoch;
    const admitted = await fixture.coord.runTerminalOperation(fixture.terminalCapability, OP_RW, `req-p65-rw-${SUFFIX}`);
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    assert.equal(admitted.value.descriptor.epoch, epochBefore + 1, "RW handoff advances the container epoch");
    assert.equal(fixture.coord.describe().ownership, "TERMINAL_OWNED");
    rwLease = admitted.value.lease as TerminalLease;
    rwHandle = await prepareReal(fixture, admitted.value.permit, "rw");
    assert.notEqual(rwHandle.containerId, roHandle.containerId, "new epoch means a new runtime identity");
    const rwRaw = docker("inspect", rwHandle.containerId);
    assert.equal(rwRaw.status, 0);
    const rwDoc = JSON.parse(rwRaw.stdout) as Array<Record<string, unknown>>;
    const rwMounts = rwDoc[0]?.["Mounts"] as Array<Record<string, unknown>>;
    assert.equal(rwMounts.length, 1);
    assert.equal(rwMounts[0]?.["RW"], true, "SANDBOX composed RW epoch binds /workspace writable");
    proof("SANDBOX composed RW epoch: RW=true binds=1");
    await assert.rejects(fixture.provider.readEpochFile(roHandle, "watched.txt"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    proof("TEST 4 RW acquisition blocks until RO retires; epoch advances with recreation");
  });

  it("TEST 5 terminal RW modifies the shared workspace (Docker to host coherence)", async () => {
    // Keep one pre-handoff editor lease to prove staleness later (no publish with it here).
    const ed = await fixture.coord.runEditorOperation(fixture.editorCapability, "edit-p65-stale-src", `req-p65-stale-src-${SUFFIX}`);
    assert.equal(ed.ok, false, "editor cannot reserve while RW owns the leaf");
    const wrote = await fixture.provider.attemptEpochWrite(rwHandle, "terminal-output.txt", "terminal bytes one");
    assert.equal(wrote.exitCode, 0, `RW guest write must succeed: ${wrote.stderr}`);
    assert.equal(readFileSync(join(fixture.leaf, "terminal-output.txt"), "utf8"), "terminal bytes one");
    // Host to Docker coherence: the RW container reads the earlier host publication.
    const read = await fixture.provider.readEpochFile(rwHandle, "lesson.txt");
    assert.equal(read.exitCode, 0);
    assert.equal(read.stdout, "host bytes one\n");
    proof("TEST 5 terminal RW modifies the shared workspace byte-exact");
  });

  it("TEST 6 host adapter write during TERMINAL_OWNED fails with zero mutation", async () => {
    const before = readFileSync(join(fixture.leaf, "lesson.txt"), "utf8");
    const early = await fixture.coord.runEditorOperation(fixture.editorCapability, "edit-p65-early", `req-p65-early-${SUFFIX}`);
    assert.equal(early.ok, false, "editor reservation is denied under RW authority");
    if (!early.ok) assert.equal(early.rejection.code, "WORKSPACE_BUSY");
    // A pre-handoff editor lease presented with current live facts fences stale before mutation.
    const staleLease = {
      kind: "editor_lease",
      leaseId: `lease-p65-prehandoff-${SUFFIX}`,
      sessionId: fixture.coord.describe().sessionId,
      generation: fixture.coord.describe().generation,
      workspaceId: fixture.coord.describe().workspaceId,
      epoch: fixture.coord.describe().epoch - 1,
      operationId: "edit-p65-pre",
      requestId: `req-p65-pre-${SUFFIX}`,
    } as EditorLease;
    const d = fixture.coord.describe();
    const live = fixture.coord.getLiveFacts();
    const denied = await fixture.adapter.publishDocument(
      { lease: staleLease, ownership: d.ownership, liveEpoch: d.epoch, revokedLeaseIds: [...live.revoked_lease_ids] },
      { portablePath: "lesson.txt", content: "host overwrite\n", mode: "replace", expected: { exists: true, digest: sha256Hex(before) } },
    );
    assert.equal(denied.ok, false, "host publication is denied while the terminal owns the leaf");
    assert.equal(readFileSync(join(fixture.leaf, "lesson.txt"), "utf8"), before, "zero mutation");
    proof("TEST 6 host write during RW fails zero-mutation");
  });

  it("TEST 7 daemon-confirmed RW retirement precedes editor resume", async () => {
    const rwId = rwHandle.containerId;
    const released = await fixture.coord.releaseTerminal(rwLease);
    assert.equal(released.ok, true, "coordinator release retires the REAL container through the barrier");
    if (!released.ok) throw new Error("unreachable");
    assert.equal(released.value.ownership, "EDITOR_OWNED");
    assert.equal(docker("inspect", rwId).status !== 0, true, "RW container absence is daemon-confirmed before editor resumes");
    assert.equal(fixture.provider.liveEpoch(), null);
    await editorPublish(fixture, "after-rw.txt", "editor resumed\n", "create", { exists: false, digest: null }, "edit-p65-t7");
    await assert.rejects(fixture.provider.readEpochFile(rwHandle, "lesson.txt"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    proof("TEST 7 confirmed retirement precedes editor resume");
  });

  it("TEST 8 old editor lease after the epoch transition cannot publish", async () => {
    const ed = await fixture.coord.runTerminalOperation(fixture.terminalCapability, OP_RO2, `req-p65-ro2-${SUFFIX}`);
    void ed;
    // Capture a live editor lease at the current epoch, then force an epoch transition.
    const live = await fixture.coord.runEditorOperation(fixture.editorCapability, "edit-p65-t8", `req-p65-t8-${SUFFIX}`);
    assert.equal(live.ok, true);
    if (!live.ok) throw new Error("unreachable");
    preHandoffEditorLease = live.value.lease;
    assert.equal(fixture.coord.releaseEditor(preHandoffEditorLease).ok, true);
    const epochBefore = fixture.coord.describe().epoch;
    // Epoch transition via a full RW handoff: stop the RO peer first (canonical order).
    const stopped = await fixture.coord.stopTerminal(fixture.terminalCapability, OP_RO2, `req-p65-stop-ro2-${SUFFIX}`);
    assert.equal(stopped.ok, true);
    const admitted = await fixture.coord.runTerminalOperation(fixture.terminalCapability, OP_RW2, `req-p65-rw2-${SUFFIX}`);
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const rw2Handle = await prepareReal(fixture, admitted.value.permit, "rw2");
    const released = await fixture.coord.releaseTerminal(admitted.value.lease as TerminalLease);
    assert.equal(released.ok, true);
    assert.ok(fixture.coord.describe().epoch > epochBefore, "epoch advanced across the second RW handoff");
    void rw2Handle;
    const attempt = await fixture.adapter.publishDocument(authority(fixture, preHandoffEditorLease), {
      portablePath: "after-rw.txt",
      content: "stale write\n",
      mode: "replace",
      expected: { exists: true, digest: sha256Hex("editor resumed\n") },
    });
    assert.equal(attempt.ok, false, "stale editor lease cannot publish after the transition");
    if (!attempt.ok) assert.ok(["STALE_EPOCH", "WORKSPACE_REVOKED"].includes(attempt.rejection.code));
    assert.equal(readFileSync(join(fixture.leaf, "after-rw.txt"), "utf8"), "editor resumed\n", "zero file mutation");
    proof("TEST 8 old editor lease cannot publish after the transition");
  });

  it("TEST 9 old terminal epoch cannot prepare: stale rejection with zero action", async () => {
    const admitted = await fixture.coord.runTerminalOperation(fixture.terminalCapability, OP_RO3, `req-p65-ro3-${SUFFIX}`);
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const liveHandle = await prepareReal(fixture, admitted.value.permit, "ro3");
    const before = ownedContainerNames().sort();
    // A preparation naming the retired RO epoch fences while the live epoch owns the provider.
    await assert.rejects(
      fixture.provider.prepareEpoch({
        sessionId: roHandle.sessionId,
        generation: roHandle.generation,
        epoch: roHandle.epoch,
        access: "read_only",
        leafHostPath: fixture.leaf,
        leaseId: `lease-p65-stale-${SUFFIX}`,
        policyDigest: admitted.value.permit.policy_digest,
        containerName: `cf-p65-stale-${SUFFIX}`,
        testRunId: TEST_RUN_ID,
      }),
      (error: unknown) => ["WORKSPACE_BUSY", "STALE_EPOCH"].includes(codeOf(error)),
    );
    assert.deepEqual(ownedContainerNames().sort(), before, "stale preparation starts zero containers");
    // Coordinator-level fencing agrees: the retired permit is stale against live facts.
    const liveFacts = fixture.coord.getLiveFacts();
    const stalePermit: WorkspaceExecutionPermit = {
      kind: "workspace_execution_permit",
      permit_version: 1,
      session_id: liveFacts.session_id,
      generation: liveFacts.generation,
      workspace_id: liveFacts.workspace_id,
      epoch: liveFacts.epoch - 1,
      access: "read_only",
      operation_id: OP_RO,
      policy_digest: liveFacts.policy_digest,
      lease_id: `lease-p65-stale-${SUFFIX}`,
    };
    const check = checkPermitAcquisition(stalePermit, liveFacts);
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.rejection.code, "STALE_EPOCH");
    const retired = await fixture.provider.retireEpoch(liveHandle, "test9");
    assert.equal(retired.cleanup, "confirmed");
    fixture.bridge.realHandle = null;
    assert.equal((await fixture.coord.stopTerminal(fixture.terminalCapability, OP_RO3, `req-p65-stop-ro3-${SUFFIX}`)).ok, true);
    proof("TEST 9 old terminal epoch cannot prepare");
  });

  it("TEST 10 terminal external change causes stale editor preimage conflict", async () => {
    const admitted = await fixture.coord.runEditorOperation(fixture.editorCapability, "edit-p65-t10", `req-p65-t10-${SUFFIX}`);
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const created = await fixture.adapter.publishDocument(authority(fixture, admitted.value.lease), {
      portablePath: "doc.txt",
      content: "revision N\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(created.ok, true);
    if (!created.ok) throw new Error("unreachable");
    digestN = created.value.digest;
    assert.equal(fixture.coord.releaseEditor(admitted.value.lease).ok, true);
    // Editor relinquishes; terminal RW legitimately modifies the shared file.
    const rwAdmitted = await fixture.coord.runTerminalOperation(fixture.terminalCapability, OP_RW3, `req-p65-rw-t10-${SUFFIX}`);
    assert.equal(rwAdmitted.ok, true);
    if (!rwAdmitted.ok) throw new Error("unreachable");
    const rwNHandle = await prepareReal(fixture, rwAdmitted.value.permit, "rw-t10");
    const wrote = await fixture.provider.attemptEpochWrite(rwNHandle, "doc.txt", "revision M from terminal");
    assert.equal(wrote.exitCode, 0);
    assert.equal((await fixture.coord.releaseTerminal(rwAdmitted.value.lease as TerminalLease)).ok, true);
    assert.equal(readFileSync(join(fixture.leaf, "doc.txt"), "utf8"), "revision M from terminal");
    // Editor reacquires and attempts publication based on stale preimage N.
    const ed2 = await fixture.coord.runEditorOperation(fixture.editorCapability, "edit-p65-t10b", `req-p65-t10b-${SUFFIX}`);
    assert.equal(ed2.ok, true);
    if (!ed2.ok) throw new Error("unreachable");
    const stale = await fixture.adapter.publishDocument(authority(fixture, ed2.value.lease), {
      portablePath: "doc.txt",
      content: "stale editor overwrite\n",
      mode: "replace",
      expected: { exists: true, digest: digestN },
    });
    assert.equal(stale.ok, false, "stale preimage must conflict, never silently overwrite");
    if (!stale.ok) assert.equal(stale.rejection.code, "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(readFileSync(join(fixture.leaf, "doc.txt"), "utf8"), "revision M from terminal");
    assert.equal(fixture.coord.releaseEditor(ed2.value.lease).ok, true);
    proof("TEST 10 terminal change causes stale preimage conflict");
  });

  it("TEST 11 large atomic host publication shows only complete bytes to the RO watcher", async () => {
    const admitted = await fixture.coord.runTerminalOperation(fixture.terminalCapability, OP_RO4, `req-p65-ro-atom-${SUFFIX}`);
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const watcher = await prepareReal(fixture, admitted.value.permit, "ro-atom");
    const contentA = `${"a".repeat(128 * 1024)}\n`;
    const contentB = `${"b".repeat(64 * 1024)}\n`;
    const seedDigest = await editorPublish(fixture, "big.txt", contentA, "create", { exists: false, digest: null }, "edit-p65-big");
    void seedDigest;
    const guest = spawn(
      DOCKER_EXE,
      ["exec", watcher.containerName, "sh", "-c", "for i in $(seq 1 30); do cat /workspace/big.txt; printf '\\n---P65-BLOCK---\\n'; done"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let guestOut = "";
    guest.stdout.on("data", (chunk: Buffer) => {
      guestOut += chunk.toString("utf8");
    });
    const guestDone = new Promise<number | null>((resolvePromise) => {
      guest.on("close", (code: number | null) => resolvePromise(code));
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    for (let round = 0; round < 4; round += 1) {
      const next = round % 2 === 0 ? contentB : contentA;
      const reader = await fixture.coord.runEditorOperation(fixture.editorCapability, `edit-p65-big-${round}`, `req-p65-big-${round}-${SUFFIX}`);
      assert.equal(reader.ok, true);
      if (!reader.ok) throw new Error("unreachable");
      const current = await fixture.adapter.readDocument(authority(fixture, reader.value.lease), "big.txt");
      assert.equal(current.ok, true);
      if (!current.ok) throw new Error("unreachable");
      const outcome = await fixture.adapter.publishDocument(authority(fixture, reader.value.lease), {
        portablePath: "big.txt",
        content: next,
        mode: "replace",
        expected: { exists: true, digest: current.value.digest },
      });
      assert.equal(outcome.ok, true, `round ${round} must publish`);
      assert.equal(fixture.coord.releaseEditor(reader.value.lease).ok, true);
    }
    const guestCode = await guestDone;
    assert.equal(guestCode, 0, "guest read loop must complete");
    const blocks = guestOut.split("---P65-BLOCK---").map((b) => b.replace(/\n$/, "")).filter((b) => b.length > 0);
    assert.ok(blocks.length > 0, "the watcher must have observed committed files");
    for (const block of blocks) {
      const body = block.startsWith("\n") ? block.slice(1) : block;
      assert.ok(body === contentA || body === contentB, `watcher sees only complete old/new bytes (block len ${body.length})`);
    }
    // Staging never appears inside the guest-visible leaf.
    assert.ok(!readdirSync(fixture.leaf).some((entry) => entry.startsWith("cf-p64-stage-") || entry.startsWith("cf-p65-stage-")));
    const retired = await fixture.provider.retireEpoch(watcher, "atom_done");
    assert.equal(retired.cleanup, "confirmed");
    fixture.bridge.realHandle = null;
    assert.equal((await fixture.coord.stopTerminal(fixture.terminalCapability, OP_RO4, `req-p65-stop-atom-${SUFFIX}`)).ok, true);
    proof("TEST 11 atomic publication: watcher sees only complete old/new bytes");
  });

  it("P6.5 journal correlation and renderer boundary hold on the real path", async () => {
    const events = fixture.coord.listEvents(0).map((e) => e.type);
    for (const expected of ["workspace.writer.acquired", "workspace.writer.released", "workspace.epoch.started", "workspace.epoch.retired"]) {
      assert.ok(events.includes(expected), `journal carries ${expected}`);
    }
    const snapshot = fixture.coord.getCombinedSnapshot(fixture.coord.describe() as never, 0);
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) throw new Error("unreachable");
    const serialized = JSON.stringify(snapshot.value);
    assert.ok(!serialized.includes(fixture.leaf), "snapshot carries no host leaf path");
    assert.ok(!serialized.includes("cf-p65-ro-") && !serialized.includes("cf-p65-rw-"), "snapshot carries no runtime container names");
    const before = ownedContainerNames().sort();
    await assert.rejects(
      fixture.provider.prepareEpoch({
        sessionId: fixture.coord.describe().sessionId,
        generation: fixture.coord.describe().generation,
        epoch: 1,
        access: "read_only",
        leafHostPath: fixture.leaf,
        leaseId: `lease-p65-hostile-${SUFFIX}`,
        policyDigest: "d".repeat(64),
        containerName: `cf-p65-hostile-${SUFFIX}`,
        testRunId: TEST_RUN_ID,
        env: { HOME: "/tmp/evil" },
      }),
      (error: unknown) => codeOf(error) === "INVALID_REQUEST",
    );
    assert.deepEqual(ownedContainerNames().sort(), before, "hostile extras take zero provider action");
    proof("journal correlation without leakage; renderer authority absent");
  });
});

describe("P6.5 real reset, close and HOLD (composed resources)", () => {
  it("TEST 12 reset with a live RO observer revokes, removes, confirms and reseeds", async () => {
    const fresh = openFixture([OP_RO, OP_RW]);
    const admitted = await fresh.coord.runTerminalOperation(fresh.terminalCapability, OP_RO, `req-p65-reset-ro-${SUFFIX}`);
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const live = await prepareReal(fresh, admitted.value.permit, "reset-ro");
    const liveId = live.containerId;
    const oldSession = fresh.coord.describe().sessionId;
    const reset = await fresh.coord.resetCombinedSession(fresh.coord.describe() as never, `req-p65-reset-${SUFFIX}`);
    assert.equal(reset.ok, true, "reset latches while the observer lives and retires it through the barrier");
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.descriptor.generation, 2, "reset exposes the next generation");
    assert.notEqual(reset.value.descriptor.sessionId, oldSession, "reset rotates the session identity");
    assert.equal(docker("inspect", liveId).status !== 0, true, "observer absence is daemon-confirmed");
    assert.equal(fresh.provider.liveEpoch(), null);
    const staleAttempt = await fresh.coord.runTerminalOperation(fresh.terminalCapability, OP_RW, `req-p65-reset-rw-${SUFFIX}`);
    assert.equal(staleAttempt.ok, false, "revoked pre-reset authority must not acquire");
    await assert.rejects(fresh.provider.readEpochFile(live, "lesson.txt"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    // New generation publishes through a fresh binding (canonical fresh leaf).
    const d = reset.value.descriptor;
    const leaf2 = join(TEST_ROOT, `cf-p65-leaf-${SUFFIX}-reset2`);
    const staging2 = join(TEST_ROOT, `cf-p65-staging-${SUFFIX}-reset2`);
    mkdirSync(leaf2, { recursive: true });
    mkdirSync(staging2, { recursive: true });
    const bound2 = openWindowsFileAdapter({ sessionId: d.sessionId, generation: d.generation, workspaceId: d.workspaceId, leafHostPath: leaf2, stagingHostPath: staging2 });
    assert.equal(bound2.ok, true);
    if (!bound2.ok) throw new Error("unreachable");
    const ed = await fresh.coord.runEditorOperation(reset.value.editorCapability, "edit-p65-reset", `req-p65-reset-ed-${SUFFIX}`);
    assert.equal(ed.ok, true, "new generation acquires editor authority");
    if (!ed.ok) throw new Error("unreachable");
    const lf = fresh.coord.getLiveFacts();
    const published = await bound2.value.publishDocument(
      { lease: ed.value.lease, ownership: fresh.coord.describe().ownership, liveEpoch: fresh.coord.describe().epoch, revokedLeaseIds: [...lf.revoked_lease_ids] },
      { portablePath: "reseeded.txt", content: "fresh generation\n", mode: "create", expected: { exists: false, digest: null } },
    );
    assert.equal(published.ok, true);
    assert.equal(fresh.coord.releaseEditor(ed.value.lease).ok, true);
    assert.equal((await fresh.coord.closeCombinedSession(reset.value.descriptor as never, `req-p65-reset-close-${SUFFIX}`)).ok, true);
    rmSync(fresh.leaf, { recursive: true, force: true });
    rmSync(fresh.staging, { recursive: true, force: true });
    rmSync(leaf2, { recursive: true, force: true });
    rmSync(staging2, { recursive: true, force: true });
    proof("TEST 12 reset revokes, removes, confirms and reseeds");
  });

  it("TEST 13 close retires the epoch container and late callbacks stay harmless", async () => {
    const fresh = openFixture([OP_RO]);
    const admitted = await fresh.coord.runTerminalOperation(fresh.terminalCapability, OP_RO, `req-p65-close-ro-${SUFFIX}`);
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    const live = await prepareReal(fresh, admitted.value.permit, "close-ro");
    const closed = await fresh.coord.closeCombinedSession(fresh.coord.describe() as never, `req-p65-close-${SUFFIX}`);
    assert.equal(closed.ok, true);
    // Coordinator close latches; the composed barrier retires the real container (stashed handle).
    const outcome = await fresh.provider.closeProvider(live);
    assert.equal(outcome.cleanup, "confirmed");
    assert.equal(fresh.provider.liveEpoch(), null);
    const late = fresh.provider.onLateContainerEvent({ containerId: live.containerId, epoch: live.epoch, generation: live.generation });
    assert.equal(late.fenced, true, "late callbacks after close cannot reopen authority");
    const lateAttempt = await fresh.coord.runTerminalOperation(fresh.terminalCapability, OP_RO, `req-p65-close-late-${SUFFIX}`);
    assert.equal(lateAttempt.ok, false, "closed authority must not acquire");
    rmSync(fresh.leaf, { recursive: true, force: true });
    rmSync(fresh.staging, { recursive: true, force: true });
    proof("TEST 13 close retires the container; late callbacks harmless");
  });

  it("TEST 14 HOLD on unconfirmed retirement fences both writer paths", async () => {
    const fresh = openFixture([OP_RW]);
    const admitted = await fresh.coord.runTerminalOperation(fresh.terminalCapability, OP_RW, `req-p65-hold-rw-${SUFFIX}`);
    assert.equal(admitted.ok, true);
    if (!admitted.ok) throw new Error("unreachable");
    await prepareReal(fresh, admitted.value.permit, "hold-rw");
    fresh.provider.diagnosticsForceUnconfirmedRetire = true;
    const released = await fresh.coord.releaseTerminal(admitted.value.lease as TerminalLease);
    assert.equal(released.ok, false, "unconfirmed retirement holds instead of releasing");
    if (!released.ok) assert.equal(released.rejection.code, "CLEANUP_UNCONFIRMED");
    assert.equal(fresh.coord.describe().ownership, "HOLD");
    assert.equal(fresh.provider.isHeld(), true);
    const editor = await fresh.coord.runEditorOperation(fresh.editorCapability, "edit-p65-hold", `req-p65-hold-ed-${SUFFIX}`);
    assert.equal(editor.ok, false, "HOLD denies editor acquisition");
    const terminal = await fresh.coord.runTerminalOperation(fresh.terminalCapability, OP_RW, `req-p65-hold-rw2-${SUFFIX}`);
    assert.equal(terminal.ok, false, "HOLD denies terminal acquisition");
    const d = fresh.coord.describe();
    const lf = fresh.coord.getLiveFacts();
    const forged: AdapterAuthority = {
      lease: {
        kind: "editor_lease",
        leaseId: `lease-p65-hold-${SUFFIX}`,
        sessionId: d.sessionId,
        generation: d.generation,
        workspaceId: d.workspaceId,
        epoch: d.epoch,
        operationId: "edit-p65-hold",
        requestId: `req-p65-hold-${SUFFIX}`,
      },
      ownership: "HOLD",
      liveEpoch: d.epoch,
      revokedLeaseIds: [...lf.revoked_lease_ids],
    };
    const hosted = await fresh.adapter.publishDocument(forged, {
      portablePath: "hold.txt",
      content: "x\n",
      mode: "create",
      expected: { exists: false, digest: null },
    });
    assert.equal(hosted.ok, false, "HOLD fences the file adapter");
    assert.equal(existsSync(join(fresh.leaf, "hold.txt")), false);
    await assert.rejects(
      fresh.provider.prepareEpoch({
        sessionId: d.sessionId,
        generation: d.generation,
        epoch: d.epoch + 1,
        access: "read_write",
        leafHostPath: fresh.leaf,
        leaseId: `lease-p65-hold-next-${SUFFIX}`,
        policyDigest: lf.policy_digest,
        containerName: `cf-p65-hold-next-${SUFFIX}`,
        testRunId: TEST_RUN_ID,
      }),
      (error: unknown) => codeOf(error) === "CLEANUP_UNCONFIRMED",
    );
    // Recovery: confirmed retirement through the reset barrier exposes a new generation.
    fresh.provider.diagnosticsForceUnconfirmedRetire = false;
    const reset = await fresh.coord.resetCombinedSession(d as never, `req-p65-hold-reset-${SUFFIX}`);
    assert.equal(reset.ok, true, "confirmed retirement through reset recovers from HOLD");
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.descriptor.generation, 2);
    assert.equal((await fresh.coord.closeCombinedSession(reset.value.descriptor as never, `req-p65-hold-close-${SUFFIX}`)).ok, true);
    rmSync(fresh.leaf, { recursive: true, force: true });
    rmSync(fresh.staging, { recursive: true, force: true });
    proof("TEST 14 HOLD fences both paths; reset recovers after confirmed cleanup");
  });
});
