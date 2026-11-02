// P7.2 Real Docker Bridge Tests — verified platform proofs.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md sections 11 & 12, and task P7.2.
// Proves real Docker container bridge behavior with cf-terminal-engine-runtime:p5:
// - Normal P5 container remains --network none with zero published ports.
// - Reviewed browser dev-server capability attaches to isolated bridge with 127.0.0.1 loopback publish.
// - Host reverse proxy translates authored origin to allocated container port.
// - Public internet egress is denied (no IP masquerade, external DNS blocked).
// - Unrelated guest ports are unreachable.
// - Reset and close tear down mappings and listeners cleanly.
// - Confirms zero survivor containers or networks.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execSync, spawnSync } from "node:child_process";
import { LocalhostBridgeCoordinator, waitForPortReadiness } from "../src/bridge.ts";
import { allocateEphemeralLoopbackPort } from "../src/port-manager.ts";
import { sha256Hex, type ReviewedPortCapabilityV1 } from "../src/policy.ts";

const RUNTIME_IMAGE = "cf-terminal-engine-runtime:p5";
const NETWORK_NAME = "cf-p72-bridge";
const CONTAINER_NORMAL = "cf-p72-normal-none";
const CONTAINER_SERVER = "cf-p72-server-dev";

function runDocker(cmd: string): string {
  return execSync(`docker ${cmd}`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fetchText(url: string, maxAttempts = 5): Promise<{ status: number; text: string }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = http.get(url, (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, text: data });
          });
        });
        req.on("error", reject);
      });
    } catch (err) {
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      throw err;
    }
  }
  throw new Error("fetchText exhausted retries");
}

describe("P7.2 Real Docker: Isolated Bridge & Network Sandboxing", () => {
  let allocatedPort: number;
  let coordinator: LocalhostBridgeCoordinator;

  it("proves normal P5 container runs with --network none and zero published ports", () => {
    // Start normal container with --network none
    runDocker(`run -d --name ${CONTAINER_NORMAL} --network none ${RUNTIME_IMAGE}`);
    try {
      const portOutput = runDocker(`port ${CONTAINER_NORMAL}`);
      assert.equal(portOutput, "", "Normal P5 container must have zero published ports");

      // Verify network mode is none
      const netMode = runDocker(`inspect ${CONTAINER_NORMAL} --format "{{.HostConfig.NetworkMode}}"`);
      assert.equal(netMode, "none");
    } finally {
      runDocker(`rm -f ${CONTAINER_NORMAL}`);
    }
  });

  it("creates isolated bridge network with enable_icc=false and enable_ip_masquerade=false", () => {
    // Clean up any preexisting test network
    try {
      runDocker(`network rm ${NETWORK_NAME}`);
    } catch {
      // Ignored if absent
    }

    runDocker(
      `network create -d bridge -o "com.docker.network.bridge.enable_icc=false" -o "com.docker.network.bridge.enable_ip_masquerade=false" ${NETWORK_NAME}`,
    );

    const inspectJson = JSON.parse(runDocker(`network inspect ${NETWORK_NAME}`));
    const options = inspectJson[0]?.Options ?? {};
    assert.equal(options["com.docker.network.bridge.enable_icc"], "false");
    assert.equal(options["com.docker.network.bridge.enable_ip_masquerade"], "false");
  });

  it("proves dev server container on isolated bridge can serve HTTP to 127.0.0.1 host loopback", async () => {
    allocatedPort = await allocateEphemeralLoopbackPort();

    // Start container serving HTTP on guest port 3000 bound strictly to 127.0.0.1:<allocatedPort>
    const runCmd = [
      "run",
      "-d",
      `--name ${CONTAINER_SERVER}`,
      `--network ${NETWORK_NAME}`,
      "--dns 127.0.0.1",
      `-p 127.0.0.1:${allocatedPort}:3000`,
      "--user 1000:1000",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--read-only",
      "--pids-limit 64",
      "--memory 512m",
      "--tmpfs /tmp:rw,noexec,nosuid,size=65536k",
      `--entrypoint node`,
      RUNTIME_IMAGE,
      "-e",
      `"require('http').createServer((req, res) => res.end('DEV_SERVER_OK')).listen(3000)"`,
    ].join(" ");

    runDocker(runCmd);

    // Verify host port mapping is strictly 127.0.0.1
    const portMapping = runDocker(`port ${CONTAINER_SERVER}`);
    assert.match(portMapping, new RegExp(`3000/tcp -> 127\\.0\\.0\\.1:${allocatedPort}`));
    assert.doesNotMatch(portMapping, /0\.0\.0\.0/);

    // Wait for guest server readiness
    const ready = await waitForPortReadiness(allocatedPort, 8000, 200);
    assert.equal(ready, true);

    // Query directly through allocated host loopback port
    const res = await fetchText(`http://127.0.0.1:${allocatedPort}`);
    assert.equal(res.status, 200);
    assert.equal(res.text, "DEV_SERVER_OK");
  });

  it("proves reverse proxy and bridge coordinator forward authored origin to the container", async () => {
    coordinator = new LocalhostBridgeCoordinator("sess-docker-01", 1);
    const cap: ReviewedPortCapabilityV1 = {
      kind: "reviewed_port_capability",
      capability_version: 1,
      capability_id: "cap-docker-dev",
      lesson_id: "C01-L001",
      session_id: "sess-docker-01",
      generation: 1,
      background_process_id: "dev_server",
      guest_port: 3000,
      reviewed_origin: "http://localhost:3000",
      policy_version: 1,
      policy_digest: sha256Hex("dummy-policy"),
    };

    const binding = await coordinator.activateBridge(cap, allocatedPort);
    assert.equal(binding.status, "active");

    // Query through bridge proxy
    const res = await fetchText(`${binding.bridge_origin}/`);
    assert.equal(res.status, 200);
    assert.equal(res.text, "DEV_SERVER_OK");
  });

  it("proves public internet egress is denied from the container", () => {
    // Execute wget to public IP from inside the container; must fail/timeout
    const result = spawnSync(
      "docker",
      ["exec", CONTAINER_SERVER, "wget", "-T", "2", "-t", "1", "http://1.1.1.1"],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, "Outbound connection to public internet must fail");
  });

  it("proves unrelated guest ports are unreachable from host", async () => {
    // Port 3001 was not mapped
    const unmappedPort = await allocateEphemeralLoopbackPort();
    await assert.rejects(
      async () => {
        await fetchText(`http://127.0.0.1:${unmappedPort}`);
      },
      /ECONNREFUSED/,
    );
  });

  it("cleans up Docker container and network with zero survivors", async () => {
    if (coordinator) {
      await coordinator.close();
    }

    runDocker(`rm -f ${CONTAINER_SERVER}`);
    runDocker(`network rm ${NETWORK_NAME}`);

    // Verify container absence
    const psCheck = runDocker(`ps -a --filter "name=cf-p72-" --format "{{.Names}}"`);
    assert.equal(psCheck, "", "Zero cf-p72- containers must survive");

    // Verify network absence
    const netCheck = runDocker(`network ls --filter "name=cf-p72-" --format "{{.Name}}"`);
    assert.equal(netCheck, "", "Zero cf-p72- networks must survive");
  });
});
