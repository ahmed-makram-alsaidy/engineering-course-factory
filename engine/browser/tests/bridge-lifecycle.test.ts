// P7.2 Localhost Bridge Coordinator Tests — lifecycle, fencing, and readiness polling.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md sections 11 & 12, and task P7.2.
// Verifies bridge coordinator activation, origin binding, session fencing, reset barrier, and disposal.
// Pure, deterministic, offline (loopback only, no WAN networking).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  LocalhostBridgeCoordinator,
  waitForPortReadiness,
} from "../src/bridge.ts";
import { startFixtureServer, type FixtureServerInstance } from "../src/fixture-server.ts";
import { allocateEphemeralLoopbackPort } from "../src/port-manager.ts";
import { sha256Hex, type ReviewedPortCapabilityV1 } from "../src/policy.ts";

function fetchText(url: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
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
}

function makeCapability(overrides: Partial<ReviewedPortCapabilityV1> = {}): ReviewedPortCapabilityV1 {
  return {
    kind: "reviewed_port_capability",
    capability_version: 1,
    capability_id: "cap-port-3000",
    lesson_id: "C01-L001",
    session_id: "sess-001",
    generation: 1,
    background_process_id: "dev_server",
    guest_port: 3000,
    reviewed_origin: "http://localhost:3000",
    policy_version: 1,
    policy_digest: sha256Hex("dummy-policy"),
    ...overrides,
  };
}

describe("P7.2 Bridge: Port Readiness Polling", () => {
  it("detects port readiness quickly when target server is listening", async () => {
    const server = await startFixtureServer();
    try {
      const isReady = await waitForPortReadiness(server.port, 3000, 50);
      assert.equal(isReady, true);
    } finally {
      await server.close();
    }
  });

  it("times out with PORT_UNAVAILABLE when target port is offline", async () => {
    const offlinePort = await allocateEphemeralLoopbackPort();
    await assert.rejects(
      async () => {
        await waitForPortReadiness(offlinePort, 300, 50);
      },
      /\[PORT_UNAVAILABLE\]/,
    );
  });
});

describe("P7.2 Bridge Coordinator: Activation & Origin Binding", () => {
  let targetServer: FixtureServerInstance;
  let coordinator: LocalhostBridgeCoordinator;

  it("activates bridge for valid ReviewedPortCapabilityV1", async () => {
    targetServer = await startFixtureServer();
    coordinator = new LocalhostBridgeCoordinator("sess-001", 1);

    const cap = makeCapability();
    const binding = await coordinator.activateBridge(cap, targetServer.port);

    assert.equal(binding.capability_id, "cap-port-3000");
    assert.equal(binding.session_id, "sess-001");
    assert.equal(binding.generation, 1);
    assert.equal(binding.authored_origin, "http://localhost:3000");
    assert.equal(binding.guest_port, 3000);
    assert.equal(binding.host_port, targetServer.port);
    assert.equal(binding.status, "active");

    // Verify proxy forwards to target server
    const res = await fetchText(`${binding.bridge_origin}/`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Course Factory Test Fixture/);
  });

  it("retrieves active binding from coordinator", () => {
    const binding = coordinator.getBinding("cap-port-3000");
    assert.notEqual(binding, undefined);
    assert.equal(binding?.status, "active");
  });

  it("rejects duplicate activation of the same capability", async () => {
    const cap = makeCapability();
    await assert.rejects(
      async () => {
        await coordinator.activateBridge(cap, targetServer.port);
      },
      /is already active/,
    );
  });

  it("retires bridge cleanly and closes reverse proxy", async () => {
    const binding = coordinator.getBinding("cap-port-3000");
    assert.notEqual(binding, undefined);
    const bridgeUrl = binding?.bridge_origin;

    const retired = await coordinator.retireBridge("cap-port-3000");
    assert.equal(retired, true);
    assert.equal(coordinator.getBinding("cap-port-3000"), undefined);

    // Verify proxy is closed
    if (bridgeUrl) {
      await assert.rejects(
        async () => {
          await fetchText(`${bridgeUrl}/`);
        },
        /ECONNREFUSED|ECONNRESET/,
      );
    }
  });

  it("closes target server", async () => {
    await coordinator.close();
    await targetServer.close();
  });
});

describe("P7.2 Bridge Coordinator: Session & Generation Fencing", () => {
  it("rejects capability with stale session ID", async () => {
    const coordinator = new LocalhostBridgeCoordinator("sess-active", 1);
    const staleSessionCap = makeCapability({ session_id: "sess-old" });

    await assert.rejects(
      async () => {
        await coordinator.activateBridge(staleSessionCap, 3000);
      },
      /\[STALE_SESSION\]/,
    );
    await coordinator.close();
  });

  it("rejects capability with stale generation", async () => {
    const coordinator = new LocalhostBridgeCoordinator("sess-active", 2);
    const staleGenCap = makeCapability({ session_id: "sess-active", generation: 1 });

    await assert.rejects(
      async () => {
        await coordinator.activateBridge(staleGenCap, 3000);
      },
      /\[STALE_GENERATION\]/,
    );
    await coordinator.close();
  });

  it("reset invalidates active proxies and advances generation", async () => {
    const targetServer = await startFixtureServer();
    const coordinator = new LocalhostBridgeCoordinator("sess-reset", 1);

    try {
      const cap = makeCapability({ session_id: "sess-reset", generation: 1 });
      const binding = await coordinator.activateBridge(cap, targetServer.port);
      assert.equal(binding.status, "active");

      // Reset to generation 2
      await coordinator.reset(2);

      assert.equal(coordinator.getActiveBindings().size, 0);

      // Attempting to activate with generation 1 now fails
      await assert.rejects(
        async () => {
          await coordinator.activateBridge(cap, targetServer.port);
        },
        /\[STALE_GENERATION\]/,
      );

      // Activating with generation 2 succeeds
      const capGen2 = makeCapability({ session_id: "sess-reset", generation: 2 });
      const newBinding = await coordinator.activateBridge(capGen2, targetServer.port);
      assert.equal(newBinding.generation, 2);
      assert.equal(newBinding.status, "active");
    } finally {
      await coordinator.close();
      await targetServer.close();
    }
  });

  it("close disposes coordinator completely", async () => {
    const coordinator = new LocalhostBridgeCoordinator("sess-close", 1);
    await coordinator.close();
    assert.equal(coordinator.isDisposed(), true);

    await assert.rejects(
      async () => {
        await coordinator.activateBridge(makeCapability({ session_id: "sess-close", generation: 1 }), 3000);
      },
      /has been disposed/,
    );
  });
});
