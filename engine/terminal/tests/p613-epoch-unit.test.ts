// P6.13 terminal interoperability — DETERMINISTIC provider unit tests (no
// Docker daemon). Covers the narrow P6.13 extension beside the untouched
// P6.3/P6.5 semantics: the cf-p613- ownership prefix allowlist and the
// fixed-transport runEpochScript proof path (guest `node` over a validated
// workspace-relative script, no command/env/cwd/stdin input). Real Docker
// behavior lives in the workspace gate-only Docker suite.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerAccessEpochProvider } from "../src/providers/docker-epochs.ts";
import type { DockerInvokeOptions, DockerInvocationResult } from "../src/providers/docker-cli.ts";

const PINNED_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const INSTALLATION_ID = "cf-p613-unit-installation";
const SESSION_ID = "sess-p613-unit";
const POLICY_DIGEST = "b".repeat(64);

const CLI_CONFIG = {
  dockerExe: "docker-unit-fake",
  context: "desktop-linux",
  configDir: joinUnit("docker-config"),
};

function joinUnit(part: string): string {
  return ["unit", part].join("/");
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
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

interface FakeContainer {
  id: string;
  access: "read_only" | "read_write";
  running: boolean;
  removed: boolean;
}

function createFakeDaemon(scripts: Map<string, { exit: number; out: string }>) {
  const calls: string[][] = [];
  const containers = new Map<string, FakeContainer>();
  let seq = 0;

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
          "com.course-factory.session": SESSION_ID,
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
          Source: ensureLeaf(),
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
      const id = seq.toString(16).padStart(64, "c");
      const mountArg = argv[argv.indexOf("--mount") + 1] ?? "";
      containers.set(id, {
        id,
        access: mountArg.includes(",readonly") ? "read_only" : "read_write",
        running: false,
        removed: false,
      });
      return fakeResult({ stdoutText: `${id}\n` });
    }
    if (verb === "inspect") {
      const container = containers.get(argv[1] ?? "");
      if (container === undefined || container.removed) {
        return { ...fakeResult({ stderrText: "Error: No such container" }), exitCode: 1 };
      }
      if (argv.includes("--format")) return fakeResult({ stdoutText: container.running ? "true\n" : "false\n" });
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
      if (guest[0] === "node" && typeof guest[1] === "string" && guest[1].startsWith("/workspace/")) {
        const rel = guest[1].slice("/workspace/".length);
        const script = scripts.get(rel);
        if (script === undefined) {
          return { ...fakeResult({ stderrText: `node: ${rel}: No such file` }), exitCode: 1 };
        }
        return { ...fakeResult({ stdoutText: script.out }), exitCode: script.exit };
      }
      return { ...fakeResult({ stderrText: "unsupported guest probe" }), exitCode: 1 };
    }
    if (verb === "stop" || verb === "rm") {
      const container = containers.get(argv[argv.length - 1] ?? "");
      if (container !== undefined) {
        if (verb === "stop") container.running = false;
        else {
          container.removed = true;
          container.running = false;
        }
      }
      return fakeResult({ stdoutText: `${argv[argv.length - 1]}\n` });
    }
    return { ...fakeResult({ stderrText: `unsupported verb ${verb}` }), exitCode: 1 };
  }

  return { invoke, calls };
}

function validArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    generation: 1,
    epoch: 1,
    access: "read_only",
    leafHostPath: ensureLeaf(),
    leaseId: "lease-p613-1",
    policyDigest: POLICY_DIGEST,
    containerName: "cf-p613-unit-ro",
    testRunId: "cf-p613-unit-run",
    ...over,
  };
}

const UNIT_LEAF = join(tmpdir(), "cf-p613-unit-leaf");

function ensureLeaf(): string {
  mkdirSync(UNIT_LEAF, { recursive: true });
  return UNIT_LEAF;
}

function makeProvider(daemon: ReturnType<typeof createFakeDaemon>): DockerAccessEpochProvider {
  return new DockerAccessEpochProvider({
    cli: CLI_CONFIG,
    imageReference: PINNED_IMAGE,
    installationId: INSTALLATION_ID,
    diagnosticsDockerInvoke: daemon.invoke,
  });
}

describe("P6.13 epoch prefix allowlist", () => {
  it("P6.13 PROOF: cf-p613- names prepare; foreign prefixes reject with zero action", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-allow", containerName: "cf-p613-unit-ro" }));
    assert.equal(handle.containerName, "cf-p613-unit-ro");
    await provider.retireEpoch(handle, "test");
    const before = daemon.calls.length;
    await assert.rejects(provider.prepareEpoch(validArgs({ leaseId: "lease-deny", containerName: "cf-evil-ro" })), (error: unknown) => codeOf(error) === "INVALID_REQUEST");
    await assert.rejects(provider.prepareEpoch(validArgs({ leaseId: "lease-deny2", containerName: "cf-p613-unit-ro", testRunId: "other-run" })), (error: unknown) => codeOf(error) === "INVALID_REQUEST");
    assert.equal(daemon.calls.length, before, "rejected names cause zero Docker action");
    console.log("P6.13 PROOF: cf-p613- allowlisted, foreign prefixes fenced");
  });

  it("P6.13 PROOF: legacy cf-p63- and cf-p65- prefixes stay accepted", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    for (const [name, lease] of [["cf-p63-unit-ro", "lease-63"], ["cf-p65-unit-ro", "lease-65"]] as const) {
      const handle = await provider.prepareEpoch(validArgs({ leaseId: lease, containerName: name, testRunId: name.replace(/unit-ro$/, "unit-run") }));
      assert.ok(handle.containerId.length > 0);
      await provider.retireEpoch(handle, "test");
    }
    console.log("P6.13 PROOF: legacy prefixes preserved");
  });
});

describe("P6.13 runEpochScript fixed transport", () => {
  it("P6.13 PROOF: script runs through the fixed node argv with actual exit/stdout", async () => {
    const daemon = createFakeDaemon(new Map([["src/app.js", { exit: 0, out: "OLD\n" }]]));
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-run", containerName: "cf-p613-unit-run" }));
    const ran = await provider.runEpochScript(handle, "src/app.js");
    assert.equal(ran.exitCode, 0);
    assert.equal(ran.stdout, "OLD\n");
    const execCalls = daemon.calls.filter((argv) => argv[0] === "exec");
    assert.equal(execCalls.length, 1);
    assert.deepEqual(execCalls[0]?.slice(2), ["node", "/workspace/src/app.js"]);
    await provider.retireEpoch(handle, "test");
    console.log("P6.13 PROOF: fixed node transport carries actual exit/stdout");
  });

  it("P6.13 PROOF: missing scripts report guest exit without host action", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-missing", containerName: "cf-p613-unit-missing" }));
    const ran = await provider.runEpochScript(handle, "src/absent.js");
    assert.equal(ran.exitCode, 1);
    await provider.retireEpoch(handle, "test");
    console.log("P6.13 PROOF: absent scripts fail inside the guest");
  });

  it("P6.13 PROOF: non-script paths and escapes reject with zero Docker action", async () => {
    const daemon = createFakeDaemon(new Map());
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-guard", containerName: "cf-p613-unit-guard" }));
    const before = daemon.calls.length;
    for (const bad of ["src/app.txt", "../outside.js", "/abs.js", "", "a\\b.js", "src/has:colon.js"]) {
      await assert.rejects(provider.runEpochScript(handle, bad), (error: unknown) => codeOf(error) === "INVALID_REQUEST", bad);
    }
    assert.equal(daemon.calls.length, before, "rejected script paths cause zero Docker action");
    await provider.retireEpoch(handle, "test");
    console.log("P6.13 PROOF: script path guard is total");
  });

  it("P6.13 PROOF: stale handles fence runEpochScript with zero action", async () => {
    const daemon = createFakeDaemon(new Map([["src/app.js", { exit: 0, out: "OLD\n" }]]));
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-stale", containerName: "cf-p613-unit-stale" }));
    await provider.retireEpoch(handle, "test");
    const before = daemon.calls.length;
    await assert.rejects(provider.runEpochScript(handle, "src/app.js"), (error: unknown) => codeOf(error) === "STALE_EPOCH");
    assert.equal(daemon.calls.length, before, "stale runs cause zero Docker action");
    console.log("P6.13 PROOF: retired epochs cannot run");
  });

  it("P6.13 PROOF: no command, env, cwd or shell input exists on the run path", async () => {
    const daemon = createFakeDaemon(new Map([["src/app.js", { exit: 0, out: "OLD\n" }]]));
    const provider = makeProvider(daemon);
    const handle = await provider.prepareEpoch(validArgs({ leaseId: "lease-shape", containerName: "cf-p613-unit-shape" }));
    // The method arity is exactly (handle, relPath): no third input exists.
    assert.equal(provider.runEpochScript.length, 2);
    await provider.runEpochScript(handle, "src/app.js");
    const execArgv = daemon.calls.filter((argv) => argv[0] === "exec")[0] ?? [];
    assert.ok(!execArgv.includes("sh") && !execArgv.includes("-c"), "no shell interprets the run");
    await provider.retireEpoch(handle, "test");
    console.log("P6.13 PROOF: run path is identifier-only with a fixed guest argv");
  });
});
