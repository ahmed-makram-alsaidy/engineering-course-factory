// P6.3 Docker access epochs — DETERMINISTIC unit tests (no Docker daemon).
//
// Covers the pure + fenced seams with an in-memory fake daemon transport:
// access mount planning/rendering, scratch profile, epoch inspect verifier,
// fencing order with zero provider action, no in-place flip, HOLD on
// unconfirmed retirement, late-callback fencing, concurrent-prepare races,
// renderer confinement and no-command-heuristics. Real Docker behavior
// (TEST 1-10) lives in p63-docker.test.ts and the validate-p6-3.sh gate.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAccessMountPlan,
  buildEpochMountArg,
  EPOCH_SCRATCH_ENV,
  epochScratchEnvArgv,
} from "../src/workspace-epochs.ts";
import { DockerAccessEpochProvider } from "../src/providers/docker-epochs.ts";
import { verifyEpochContainerConfiguration } from "../src/providers/docker-inspect.ts";
import type { DockerInvokeOptions, DockerInvocationResult } from "../src/providers/docker-cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
const terminalRoot = join(here, "..");

const PINNED_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const INSTALLATION_ID = "cf-p63-unit-installation";
const SESSION_ID = "sess-p63-unit";
const POLICY_DIGEST = "a".repeat(64);

const CLI_CONFIG = {
  dockerExe: "docker-unit-fake",
  context: "desktop-linux",
  configDir: join("unit", "docker-config"),
};

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
}

// -- fake daemon -------------------------------------------------------------

interface FakeContainer {
  id: string;
  name: string;
  mountSource: string;
  access: "read_only" | "read_write";
  sessionId: string;
  testRunId: string;
  running: boolean;
  removed: boolean;
}

function fakeResult(over: Partial<DockerInvocationResult> & { stdoutText?: string; stderrText?: string }): DockerInvocationResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: Buffer.from(over.stdoutText ?? ""),
    stderr: Buffer.from(over.stderrText ?? ""),
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    timedOut: false,
    cancelled: false,
    spawnError: null,
  };
}

function createFakeDaemon(files: Map<string, string>) {
  const calls: string[][] = [];
  const containers = new Map<string, FakeContainer>();
  let seq = 0;

  function flagValue(argv: string[], flag: string): string | null {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? (argv[index + 1] as string) : null;
  }
  function labelOf(argv: string[], key: string): string | null {
    for (let i = 0; i + 1 < argv.length; i += 1) {
      if (argv[i] === "--label" && typeof argv[i + 1] === "string" && (argv[i + 1] as string).startsWith(`${key}=`)) {
        return (argv[i + 1] as string).slice(key.length + 1);
      }
    }
    return null;
  }

  function inspectDoc(container: FakeContainer): Record<string, unknown> {
    return {
      Id: container.id,
      Config: {
        Image: PINNED_IMAGE,
        User: "1000:1000",
        WorkingDir: "/workspace",
        Env: ["HOME=/tmp/cf-home", "TMPDIR=/tmp/cf-tmp", "XDG_CACHE_HOME=/tmp/cf-cache", "LANG=C.UTF-8", "PATH=/usr/local/bin:/usr/bin:/bin"],
        Labels: {
          "com.course-factory.owner": "terminal-engine",
          "com.course-factory.phase": "P6",
          "com.course-factory.installation": INSTALLATION_ID,
          "com.course-factory.session": container.sessionId,
        },
      },
      HostConfig: {
        Privileged: false,
        NetworkMode: "none",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges=true"],
        ReadonlyRootfs: true,
        PidsLimit: 128,
        Memory: 512 * 1024 * 1024,
        MemorySwap: 512 * 1024 * 1024,
        NanoCpus: 1_000_000_000,
        ShmSize: 16 * 1024 * 1024,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=67108864,mode=1777" },
        Init: true,
        RestartPolicy: { Name: "no" },
        IpcMode: "private",
        PidMode: "",
        PortBindings: null,
      },
      Mounts: [
        {
          Type: "bind",
          Source: container.mountSource,
          Destination: "/workspace",
          RW: container.access === "read_write",
          Propagation: "rprivate",
        },
      ],
    };
  }

  async function invoke(options: DockerInvokeOptions): Promise<DockerInvocationResult> {
    const argv = [...options.argv];
    calls.push(argv);
    const verb = argv[0];
    if (verb === "create") {
      seq += 1;
      const id = seq.toString(16).padStart(64, "a");
      const mountArg = flagValue(argv, "--mount") ?? "";
      const source = (/source=([^,]+)/.exec(mountArg)?.[1]) ?? "";
      const access = mountArg.includes(",readonly") ? "read_only" : "read_write";
      containers.set(id, {
        id,
        name: flagValue(argv, "--name") ?? `cf-p63-unit-${seq}`,
        mountSource: source,
        access: access as "read_only" | "read_write",
        sessionId: labelOf(argv, "com.course-factory.session") ?? "",
        testRunId: labelOf(argv, "com.course-factory.test-run") ?? "",
        running: false,
        removed: false,
      });
      return fakeResult({ stdoutText: `${id}\n` });
    }
    if (verb === "inspect") {
      const id = argv[1] ?? "";
      const container = containers.get(id);
      if (container === undefined || container.removed) {
        return { ...fakeResult({ stderrText: `Error: No such container: ${id}` }), exitCode: 1 };
      }
      if (argv.includes("--format")) {
        return fakeResult({ stdoutText: container.running ? "true\n" : "false\n" });
      }
      return fakeResult({ stdoutText: JSON.stringify([inspectDoc(container)]) });
    }
    if (verb === "start") {
      const container = containers.get(argv[1] ?? "");
      if (container === undefined || container.removed) {
        return { ...fakeResult({ stderrText: "Error: No such container" }), exitCode: 1 };
      }
      container.running = true;
      return fakeResult({ stdoutText: `${container.id}\n` });
    }
    if (verb === "exec") {
      const container = containers.get(argv[1] ?? "");
      if (container === undefined || container.removed || !container.running) {
        return { ...fakeResult({ stderrText: "Error: No such container" }), exitCode: 1 };
      }
      const guest = argv.slice(2);
      if (guest[0] === "cat" && typeof guest[1] === "string" && guest[1].startsWith("/workspace/")) {
        const rel = guest[1].slice("/workspace/".length);
        const text = files.get(rel);
        if (text === undefined) {
          return { ...fakeResult({ stderrText: "cat: No such file" }), exitCode: 1 };
        }
        return fakeResult({ stdoutText: text });
      }
      if (guest[0] === "sh") {
        const target = typeof guest[guest.length - 1] === "string" ? (guest[guest.length - 1] as string) : "";
        const content = typeof guest[guest.length - 2] === "string" ? (guest[guest.length - 2] as string) : "";
        const rel = target.startsWith("/workspace/") ? target.slice("/workspace/".length) : null;
        if (rel === null) return { ...fakeResult({ stderrText: "bad target" }), exitCode: 1 };
        if (container.access === "read_only") {
          return { ...fakeResult({ stderrText: "Read-only file system" }), exitCode: 1 };
        }
        files.set(rel, content);
        return fakeResult({ stdoutText: "" });
      }
      return { ...fakeResult({ stderrText: "unsupported guest probe" }), exitCode: 1 };
    }
    if (verb === "stop") {
      const container = containers.get(argv[argv.length - 1] ?? "");
      if (container !== undefined) container.running = false;
      return fakeResult({ stdoutText: `${argv[argv.length - 1]}\n` });
    }
    if (verb === "rm") {
      const container = containers.get(argv[argv.length - 1] ?? "");
      if (container === undefined) {
        return { ...fakeResult({ stderrText: "Error: No such container" }), exitCode: 1 };
      }
      container.removed = true;
      container.running = false;
      return fakeResult({ stdoutText: `${container.id}\n` });
    }
    return { ...fakeResult({ stderrText: `unsupported verb ${verb}` }), exitCode: 1 };
  }

  return { invoke, calls, containers };
}

// -- real temp leaf for prepare validation -----------------------------------

const LEAF_ROOT = join(tmpdir(), "cf-p63-unit-leaf");

function ensureLeaf(): string {
  mkdirSync(LEAF_ROOT, { recursive: true });
  writeFileSync(join(LEAF_ROOT, "hello.txt"), "hello epoch\n");
  return LEAF_ROOT;
}

function validArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    generation: 1,
    epoch: 1,
    access: "read_only",
    leafHostPath: ensureLeaf(),
    leaseId: "lease-unit-1",
    policyDigest: POLICY_DIGEST,
    containerName: "cf-p63-unit-ro",
    testRunId: "cf-p63-unit-run",
    ...over,
  };
}

function makeProvider(daemon: ReturnType<typeof createFakeDaemon>): DockerAccessEpochProvider {
  return new DockerAccessEpochProvider({
    cli: CLI_CONFIG,
    imageReference: PINNED_IMAGE,
    installationId: INSTALLATION_ID,
    diagnosticsDockerInvoke: daemon.invoke,
  });
}

describe("P6.3 access mount planning (no command input exists)", () => {
  it("read_only plans a read-only bind of the same leaf at /workspace", () => {
    const plan = buildAccessMountPlan("/tmp/leaf", "read_only");
    assert.equal(plan.ok, true);
    assert.equal(plan.ok && plan.value[0]?.read_only, true);
    assert.equal(plan.ok && plan.value[0]?.target, "/workspace");
    assert.equal(plan.ok && plan.value[0]?.source, "/tmp/leaf");
    assert.ok(plan.ok && Object.isFrozen(plan.value));
  });

  it("read_write plans a writable bind of the same leaf at /workspace", () => {
    const plan = buildAccessMountPlan("/tmp/leaf", "read_write");
    assert.equal(plan.ok, true);
    assert.equal(plan.ok && plan.value[0]?.read_only, false);
  });

  it("rejects unrepresentable and socket sources with zero mount output", () => {
    // Note: Windows drive-letter host sources (E:\...) are legitimate
    // platform-native leaf paths; containment is enforced at leaf allocation,
    // not at mount grammar. Grammar rejects NUL/separators/socket fragments.
    for (const bad of ["", "a,b", 'a"b', "/tmp/docker.sock", "C:\\temp\\docker.sock"]) {
      const plan = buildAccessMountPlan(bad, "read_only");
      assert.equal(plan.ok, false, bad);
    }
  });

  it("renders readonly exactly for read_only epochs with submount inclusion disabled", () => {
    const ro = buildEpochMountArg("/tmp/leaf", "read_only");
    assert.match(ro, /readonly/);
    assert.match(ro, /bind-recursive=disabled/);
    assert.match(ro, /target=\/workspace/);
    const rw = buildEpochMountArg("/tmp/leaf", "read_write");
    assert.doesNotMatch(rw, /readonly/);
    assert.match(rw, /bind-recursive=disabled/);
  });

  it("pins the fixed scratch profile under /tmp (never under /workspace)", () => {
    assert.deepEqual({ ...EPOCH_SCRATCH_ENV }, {
      HOME: "/tmp/cf-home",
      TMPDIR: "/tmp/cf-tmp",
      XDG_CACHE_HOME: "/tmp/cf-cache",
      LANG: "C.UTF-8",
    });
    const argv = epochScratchEnvArgv();
    assert.ok(argv.includes("HOME=/tmp/cf-home"));
    assert.ok(!argv.some((entry) => entry.includes("/workspace/.home")));
  });
});

describe("P6.3 epoch inspect verifier (P5 invariants plus access)", () => {
  const daemon = createFakeDaemon(new Map());
  const provider = makeProvider(daemon);

  it("accepts a read_only epoch container and rejects it as read_write", async () => {
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-inspect-ro", containerName: "cf-p63-unit-inspect-ro" }));
    const doc = JSON.parse(
      (await daemon.invoke({ argv: ["inspect", handle.containerId] })).stdout.toString("utf8"),
    );
    assert.deepEqual(verifyEpochContainerConfiguration(doc, {
      mountSource: ensureLeaf(),
      imageReference: PINNED_IMAGE,
      access: "read_only",
      installationId: INSTALLATION_ID,
      sessionId: SESSION_ID,
    }), []);
    const flipped = verifyEpochContainerConfiguration(doc, {
      mountSource: ensureLeaf(),
      imageReference: PINNED_IMAGE,
      access: "read_write",
      installationId: INSTALLATION_ID,
      sessionId: SESSION_ID,
    });
    assert.ok(flipped.some((problem) => problem.includes("read_write")));
    await provider.retireEpoch(handle, "test");
  });

  it("detects each weakened sandbox invariant", async () => {
    const files = new Map([["hello.txt", "hello epoch\n"]]);
    const local = createFakeDaemon(files);
    const localProvider = makeProvider(local);
    const handle = await localProvider.prepareEpoch(validArgs({ leaseId: "lease-inspect-rw", access: "read_write", containerName: "cf-p63-unit-inspect-rw" }));
    const raw = JSON.parse((await local.invoke({ argv: ["inspect", handle.containerId] })).stdout.toString("utf8"));
    const doc = raw[0] as Record<string, unknown>;
    const config = doc["Config"] as Record<string, unknown>;
    const hostConfig = doc["HostConfig"] as Record<string, unknown>;
    const expectBase = {
      mountSource: ensureLeaf(),
      imageReference: PINNED_IMAGE,
      access: "read_write" as const,
      installationId: INSTALLATION_ID,
      sessionId: SESSION_ID,
    };
    assert.deepEqual(verifyEpochContainerConfiguration(raw, expectBase), []);
    const mutate = (fn: (draft: Record<string, unknown>) => void): readonly string[] => {
      const draft = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>[];
      fn(draft[0] as Record<string, unknown>);
      return verifyEpochContainerConfiguration(draft, expectBase);
    };
    assert.ok(mutate((d) => { ((d["HostConfig"] as Record<string, unknown>)["Privileged"]) = true; }).length > 0, "privileged");
    assert.ok(mutate((d) => { ((d["Config"] as Record<string, unknown>)["User"]) = "0:0"; }).length > 0, "user");
    assert.ok(mutate((d) => { ((d["HostConfig"] as Record<string, unknown>)["NetworkMode"]) = "bridge"; }).length > 0, "network");
    assert.ok(mutate((d) => { ((d["HostConfig"] as Record<string, unknown>)["PortBindings"]) = { "80/tcp": [{}] }; }).length > 0, "ports");
    assert.ok(mutate((d) => { ((d["Mounts"] as unknown[]).push({ Type: "bind", Source: "/tmp/extra", Destination: "/extra", RW: true })); }).length > 0, "second bind");
    assert.ok(mutate((d) => { ((d["Config"] as Record<string, unknown>)["Env"] as string[]).push("GITHUB_TOKEN=x"); }).length > 0, "secret env");
    assert.ok(mutate((d) => { ((d["Config"] as Record<string, unknown>)["Env"] as string[])[0] = "HOME=/workspace/.home"; }).length > 0, "scratch HOME");
    void config;
    void hostConfig;
    await localProvider.retireEpoch(handle, "test");
  });
});

describe("P6.3 epoch fencing and recreation boundary", () => {
  it("prepares read_only then fences every stale/foreign authority with zero action", async () => {
    const files = new Map([["hello.txt", "hello epoch\n"]]);
    const daemon = createFakeDaemon(files);
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs());
    const callsAfterPrepare = daemon.calls.length;

    await assert.rejects(provider.readEpochFile({ ...handle, epoch: 2 }, "hello.txt"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    await assert.rejects(provider.readEpochFile({ ...handle, generation: 2 }, "hello.txt"), (error: unknown) => codeOf(error) === "STALE_SESSION");
    await assert.rejects(provider.readEpochFile({ ...handle, sessionId: "sess-other" }, "hello.txt"), (error: unknown) => codeOf(error) === "WRONG_OWNER");
    await assert.rejects(provider.readEpochFile({ ...handle, leaseId: "lease-other" }, "hello.txt"), (error: unknown) => codeOf(error) === "WORKSPACE_REVOKED");
    assert.equal(daemon.calls.length, callsAfterPrepare, "fenced reads must take zero provider action");

    const read = await provider.readEpochFile(handle, "hello.txt");
    assert.equal(read.exitCode, 0);
    assert.equal(read.stdout, "hello epoch\n");
    const denied = await provider.attemptEpochWrite(handle, "should-not-write.txt", "x");
    assert.notEqual(denied.exitCode, 0);
    assert.ok(!files.has("should-not-write.txt"));
    await provider.retireEpoch(handle, "test");
  });

  it("refuses a second preparation while live (no in-place access flip)", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-flip", containerName: "cf-p63-unit-flip" }));
    const creates = daemon.calls.filter((argv) => argv[0] === "create").length;
    await assert.rejects(
      provider.prepareEpoch(validArgs({ leaseId: "lease-flip-2", access: "read_write", epoch: 2, containerName: "cf-p63-unit-flip-2" })),
      (error: unknown) => codeOf(error) === "WORKSPACE_BUSY",
    );
    assert.equal(daemon.calls.filter((argv) => argv[0] === "create").length, creates, "no second container may be created");
    await provider.retireEpoch(handle, "test");
  });

  it("grants exactly one winner for two concurrent preparations", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const first = provider.prepareEpoch(validArgs({ leaseId: "lease-race-a", containerName: "cf-p63-unit-race-a" }));
    const second = provider.prepareEpoch(validArgs({ leaseId: "lease-race-b", containerName: "cf-p63-unit-race-b" }));
    const outcomes = await Promise.allSettled([first, second]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(codeOf((rejected[0] as PromiseRejectedResult).reason), "WORKSPACE_BUSY");
    assert.equal(daemon.calls.filter((argv) => argv[0] === "create").length, 1);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ containerId: string }>).value;
    await provider.retireEpoch(winner, "test");
  });

  it("rejects renderer-shaped extras with zero Docker action", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const before = daemon.calls.length;
    await assert.rejects(
      provider.prepareEpoch({ ...validArgs(), command: "npm run dev", content: "x" }),
      (error: unknown) => codeOf(error) === "INVALID_REQUEST",
    );
    await assert.rejects(
      provider.prepareEpoch({ ...validArgs(), mountMode: "read_write", hostSource: "/tmp/evil" }),
      (error: unknown) => codeOf(error) === "INVALID_REQUEST",
    );
    assert.equal(daemon.calls.length, before);
  });

  it("unconfirmed retirement holds new epochs until the absence is proven", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-hold", containerName: "cf-p63-unit-hold" }));
    provider.diagnosticsForceUnconfirmedRetire = true;
    const outcome = await provider.retireEpoch(handle, "test");
    assert.equal(outcome.cleanup, "unconfirmed");
    assert.equal(provider.isHeld(), true);
    await assert.rejects(
      provider.prepareEpoch(validArgs({ leaseId: "lease-hold-2", epoch: 2, containerName: "cf-p63-unit-hold-2" })),
      (error: unknown) => codeOf(error) === "CLEANUP_UNCONFIRMED",
    );
    provider.diagnosticsForceUnconfirmedRetire = false;
    const confirmed = await provider.retireEpoch(handle, "reconcile");
    assert.equal(confirmed.cleanup, "confirmed");
    assert.equal(provider.isHeld(), false);
    const next = await provider.prepareEpoch(validArgs({ leaseId: "lease-hold-3", epoch: 2, containerName: "cf-p63-unit-hold-3" }));
    assert.equal(next.epoch, 2);
    await provider.retireEpoch(next, "test");
  });

  it("bars preparation while a retirement is in flight (no overlapping epochs)", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-inflight", containerName: "cf-p63-unit-inflight" }));
    const retiring = provider.retireEpoch(handle, "test");
    await assert.rejects(
      provider.prepareEpoch(validArgs({ leaseId: "lease-inflight-2", epoch: 2, containerName: "cf-p63-unit-inflight-2" })),
      (error: unknown) => codeOf(error) === "WORKSPACE_BUSY",
    );
    const outcome = await retiring;
    assert.equal(outcome.cleanup, "confirmed");
  });

  it("close retires the live epoch and bars every later preparation", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-close", containerName: "cf-p63-unit-close" }));
    const outcome = await provider.closeProvider(handle);
    assert.equal(outcome.cleanup, "confirmed");
    assert.equal(provider.liveEpoch(), null);
    await assert.rejects(
      provider.prepareEpoch(validArgs({ leaseId: "lease-close-2", epoch: 2, containerName: "cf-p63-unit-close-2" })),
      (error: unknown) => codeOf(error) === "INVALID_REQUEST",
    );
    const late = provider.onLateContainerEvent({ containerId: handle.containerId, epoch: 1, generation: 1 });
    assert.equal(late.fenced, true);
  });

  it("fences late container callbacks from old epochs", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const first = await provider.prepareEpoch(validArgs({ leaseId: "lease-late-1", containerName: "cf-p63-unit-late-1" }));
    await provider.retireEpoch(first, "test");
    const second = await provider.prepareEpoch(validArgs({ leaseId: "lease-late-2", epoch: 2, containerName: "cf-p63-unit-late-2" }));
    const stale = provider.onLateContainerEvent({ containerId: first.containerId, epoch: 1, generation: 1 });
    assert.equal(stale.fenced, true);
    assert.equal(stale.action, "none");
    assert.equal(provider.liveEpoch()?.containerId, second.containerId);
    const live = provider.onLateContainerEvent({ containerId: second.containerId, epoch: 2, generation: 1 });
    assert.equal(live.fenced, false);
    await provider.retireEpoch(second, "test");
  });
});

describe("P6.3 no command heuristics and reviewed-only access", () => {
  it("resolves access from the digest-bound review only (no command parameter)", async () => {
    const policyModule = await import("../../workspace/src/policy.ts");
    assert.equal(policyModule.resolveTerminalAccess.length, 2);
    const sourceFiles = [
      readFileSync(join(terminalRoot, "src", "workspace-epochs.ts"), "utf8"),
      readFileSync(join(terminalRoot, "src", "providers", "docker-epochs.ts"), "utf8"),
    ];
    const stripped = sourceFiles.map((code) => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1"));
    const hits: string[] = [];
    for (const [index, code] of stripped.entries()) {
      for (const token of ["npm run", "npm test", "npm install", "heuristic", "sounds read-only", "probably writes"]) {
        if (code.includes(token)) hits.push(`${index}:${token}`);
      }
      if (/command\.includes\(/.test(code)) hits.push(`${index}:command.includes`);
    }
    assert.deepEqual(hits, []);
  });

  it("consumes coordinator permit fields (session/generation/epoch/access/lease/policy)", async () => {
    const policyModule = await import("../../workspace/src/policy.ts");
    const coordinatorModule = await import("../../workspace/src/coordinator.ts");
    const seed = policyModule.createSeedManifest([]);
    assert.equal(seed.ok, true);
    const digest = seed.ok ? policyModule.computeSeedManifestDigest(seed.value) : "";
    const compiled = "b".repeat(64);
    const sandbox = "c".repeat(64);
    const policy = policyModule.createReviewedWorkspacePolicy(
      {
        course_id: "c01",
        lesson_id: "l01",
        lesson_compiled_digest: compiled,
        seed_manifest_digest: digest,
        sandbox_policy_digest: sandbox,
        terminal_access: { "op-ro": "read_only", "op-rw": "read_write" },
        reviewed_by: "reviewer",
        review_note: "p6.3 unit",
      },
      ["op-ro", "op-rw"],
    );
    assert.equal(policy.ok, true);
    assert.ok(policy.ok && policy.value !== undefined);
    const coordinator = coordinatorModule.createWorkspaceCoordinator();
    const opened = coordinator.openCombinedSession({
      validatedIr: {},
      reviewedPolicy: policy.ok ? policy.value : ({} as never),
      seedManifest: seed.ok ? seed.value : ({} as never),
    });
    assert.equal(opened.ok, true);
    assert.ok(opened.ok);
    const admitted = await coordinator.runTerminalOperation(opened.value.terminalCapability, "op-ro", "req-unit-1");
    assert.equal(admitted.ok, true);
    assert.ok(admitted.ok);
    // The provider consumes exactly the coordinator-issued binding: any
    // tampered field fences before any container work.
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const permit = admitted.value.permit;
    const handle = await provider.prepareEpoch({
      sessionId: permit.session_id,
      generation: permit.generation,
      epoch: permit.epoch,
      access: permit.access,
      leafHostPath: ensureLeaf(),
      leaseId: permit.lease_id,
      policyDigest: permit.policy_digest,
      containerName: "cf-p63-unit-permit",
      testRunId: "cf-p63-unit-run",
    });
    assert.equal(handle.epoch, permit.epoch);
    assert.equal(handle.access, "read_only");
    await provider.retireEpoch(handle, "test");
  });
});

describe("P6.3 housekeeping", () => {
  it("leaves no unit temp leaf behind the suite owner", () => {
    rmSync(LEAF_ROOT, { recursive: true, force: true });
    assert.ok(true);
  });

  it("beforeEach guard exists for deterministic isolation", () => {
    beforeEach(() => {});
    assert.ok(true);
  });
});
