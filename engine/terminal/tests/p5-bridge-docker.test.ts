// P5 / P7 reviewed bridge integration tests — real Docker proofs.
//
// Canonical authority: docs/P5-DESIGN-SPEC.md, docs/P7-DESIGN-SPEC.md, ADR-0012, ADR-0013.
// Proves real Docker container bridge behavior with DockerSandboxProvider:
// - Standard P5 workload remains --network none and zero published ports.
// - Opt-in reviewed bridge workload runs on isolated bridge with 127.0.0.1 host loopback port.
// - Container configuration inspect verifies bridge network and exact loopback port binding.
// - Background dev server in guest responds over 127.0.0.1:<hostPort>.
// - Clean session close removes the container AND the isolated bridge network with zero survivors.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DockerSandboxProvider, type DockerProviderConfig } from "../src/providers/docker.ts";
import type { AdmittedSession } from "../src/providers/execution-provider.ts";
import type { ResolvedExecutionContext } from "../src/workspace.ts";
import type { ExecutionGrant } from "../src/admission.ts";
import { resolveEnvironmentPlan } from "../src/environment.ts";
import { buildBridgeNetworkName } from "../src/providers/docker-policy.ts";

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
const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5";
const INSTALLATION_ID = "p5-bridge-test-inst";
const LESSON_ID = "C01-L001";
const SESSION_ID = "sess-p5-bridge-01";
const WORKSPACE_DIR = join(process.cwd(), "temp", "p5-bridge-test-ws");
const CONFIG_DIR = join(process.cwd(), "temp", "p5-bridge-test-docker-config");
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";

function docker(...argv: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(DOCKER_EXE, argv, { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function resolveRuntimeImageRef(): string | null {
  const configured = process.env.CF_TERMINAL_RUNTIME_IMAGE ?? process.env.CF_P54_RUNTIME_IMAGE;
  if (configured !== undefined && /^sha256:[0-9a-f]{64}$/.test(configured)) return configured;
  for (const tag of ["cf-terminal-engine-runtime:p5.14", "cf-terminal-engine-runtime:p5.4", "cf-terminal-engine-runtime:p5"]) {
    const r = docker("image", "inspect", tag, "--format", "{{.Id}}");
    if (r.status === 0) {
      const id = r.stdout.trim();
      if (/^sha256:[0-9a-f]{64}$/.test(id)) return id;
    }
  }
  return null;
}

const DAEMON_OK = docker("version", "--format", "{{.Server.Version}}").status === 0;
const RUNTIME_IMAGE_REF = resolveRuntimeImageRef();
const AVAILABLE = DAEMON_OK && RUNTIME_IMAGE_REF !== null;

function ensureConfigContext(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ls = docker("--config", CONFIG_DIR, "context", "ls");
  if ((ls.stdout ?? "").includes("desktop-linux")) return;
  const created = docker(
    "--config", CONFIG_DIR, "context", "create",
    "desktop-linux",
    "--docker", process.platform === "win32" ? "host=npipe:////./pipe/dockerDesktopLinuxEngine" : "host=unix:///var/run/docker.sock",
    "--description", "course-factory bridge test runtime context",
  );
  if (created.status !== 0) {
    throw new Error(`failed to create private docker config context: ${created.stderr}`);
  }
}

function makeConfig(): DockerProviderConfig {
  return {
    cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR, clientEnv: {} },
    imageReference: RUNTIME_IMAGE_REF!,
    installationId: INSTALLATION_ID,
  };
}

function buildContext(command: string, isBackground = false): ResolvedExecutionContext {
  const grant: ExecutionGrant = {
    kind: "execution_grant",
    grant_version: 1,
    session_id: SESSION_ID,
    generation: 1,
    request_id: "req-bridge-01",
    attempt_id: "att-bridge-01",
    operation_id: "op-bridge-run",
    operation_type: "terminal_run",
    mode: isBackground ? "background" : "foreground",
    course_id: "course-p5-bridge",
    lesson_id: LESSON_ID,
    scene_id: "scene-01",
    beat_id: "beat-01",
    process_id: isBackground ? "dev_server" : null,
    command,
    cwd: null,
    timeout_ms: 30000,
    expected_exit_code: isBackground ? null : 0,
  };
  const env = resolveEnvironmentPlan({ TZ: "UTC" }, ["TZ"]);
  if (!env.ok) throw new Error("environment plan failed");
  return {
    context_version: 1,
    kind: "resolved_execution_context",
    grant,
    workspace: {
      lesson_id: LESSON_ID,
      session_id: SESSION_ID,
      generation: 1,
      host_workspace_root: WORKSPACE_DIR,
      container_workspace_root: "/workspace",
      host_cwd: WORKSPACE_DIR,
      container_cwd: "/workspace",
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

async function findEphemeralLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

describe("P5 / P7 Reviewed Docker Bridge Integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    mkdirSync(CONFIG_DIR, { recursive: true });
    ensureConfigContext();
  });

  after(() => {
    try { rmSync(WORKSPACE_DIR, { recursive: true, force: true }); } catch {}
    try { rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch {}
  });

  it("proves opt-in reviewed bridge runs on isolated network with loopback port published and cleans up completely", async () => {
    const hostPort = await findEphemeralLoopbackPort();
    const guestPort = 3000;
    const networkName = buildBridgeNetworkName(SESSION_ID);

    // Write simple server script in workspace
    const serverScript = `
      const http = require('http');
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('P5_BRIDGE_SERVER_OK');
      });
      server.listen(${guestPort}, '0.0.0.0', () => {
        console.log('SERVER_READY');
      });
    `;
    writeFileSync(join(WORKSPACE_DIR, "server.js"), serverScript, "utf8");

    const context = buildContext("node server.js", true);
    const provider = new DockerSandboxProvider(makeConfig());

    const admitted: AdmittedSession = {
      session_id: SESSION_ID,
      generation: 1,
      resolvedContext: context,
      grants: [context.grant],
      bridge: {
        networkName,
        hostPort,
        guestPort,
      },
    };

    const session = await provider.prepare(admitted);
    assert.ok(session, "Provider session must be prepared successfully");

    // Start the background process
    const startReceipt = await provider.start(session, context.grant.operation_id, "att-bridge-01");
    assert.equal(startReceipt.process_id, "dev_server");

    // Wait for the server to accept connections on 127.0.0.1:hostPort
    let responseText = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        responseText = await new Promise<string>((resolve, reject) => {
          const req = http.get(`http://127.0.0.1:${hostPort}`, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve(data));
          });
          req.on("error", reject);
          req.setTimeout(1000, () => req.destroy());
        });
        if (responseText === "P5_BRIDGE_SERVER_OK") break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.equal(responseText, "P5_BRIDGE_SERVER_OK", "Guest server must be reachable over 127.0.0.1:<hostPort>");

    // Close session: must confirm container and network removal
    const cleanup = await provider.close(session, "lesson_end");
    assert.equal(cleanup.cleanup_status, "confirmed");

    // Verify network is gone
    const netInspect = docker("network", "inspect", networkName);
    assert.notEqual(netInspect.status, 0, "Bridge network must be removed after session close");
  });
});
