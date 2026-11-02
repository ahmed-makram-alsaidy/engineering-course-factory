// P7.2 Port Manager & Reverse Proxy Tests — real Windows host loopback tests.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md sections 11 & 12, and task P7.2.
// Verifies dynamic port allocation, collision fallback, loopback binding, and reverse proxying.
// Pure, deterministic, offline (loopback only, no WAN networking).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  allocateEphemeralLoopbackPort,
  isPortAvailable,
  PortManager,
} from "../src/port-manager.ts";
import { startLoopbackReverseProxy, type LoopbackReverseProxyInstance } from "../src/proxy.ts";
import { startFixtureServer, type FixtureServerInstance } from "../src/fixture-server.ts";
import { sha256Hex, type ReviewedPortCapabilityV1 } from "../src/policy.ts";

function fetchThroughProxy(url: string): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, text: data, headers: res.headers });
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

describe("P7.2 Port Manager: Ephemeral Loopback Allocation", () => {
  it("allocates a valid dynamic ephemeral port in range [1024, 65535]", async () => {
    const port = await allocateEphemeralLoopbackPort();
    assert.equal(typeof port, "number");
    assert.equal(port >= 1024 && port <= 65535, true);
  });

  it("detects port availability accurately on 127.0.0.1", async () => {
    const freePort = await allocateEphemeralLoopbackPort();
    const isFree = await isPortAvailable(freePort, "127.0.0.1");
    assert.equal(isFree, true);

    // Bind a temporary server on that port
    const srv = await startFixtureServer({ port: freePort });
    try {
      const isOccupied = await isPortAvailable(freePort, "127.0.0.1");
      assert.equal(isOccupied, false);
    } finally {
      await srv.close();
    }
  });

  it("rejects port availability probe on non-loopback host", async () => {
    await assert.rejects(
      async () => {
        await isPortAvailable(3000, "0.0.0.0");
      },
      /only allowed on loopback 127.0.0.1/,
    );
  });
});

describe("P7.2 Port Manager: Reservation Ledger & Collision Handling", () => {
  it("reserves ephemeral port for reviewed capability bound to 127.0.0.1", async () => {
    const pm = new PortManager();
    try {
      const cap = makeCapability();
      const { reservation, release } = await pm.reservePort(cap);

      assert.equal(reservation.capability_id, "cap-port-3000");
      assert.equal(reservation.session_id, "sess-001");
      assert.equal(reservation.guest_port, 3000);
      assert.equal(reservation.bind_address, "127.0.0.1");
      assert.equal(reservation.allocated_host_port >= 1024, true);

      await release();
      assert.equal(pm.getActiveReservations().size, 0);
    } finally {
      await pm.dispose();
    }
  });

  it("handles port collisions by allocating ephemeral fallback", async () => {
    const pm = new PortManager();
    // Start a server on a specific ephemeral port to force collision
    const collisionPort = await allocateEphemeralLoopbackPort();
    const blockingServer = await startFixtureServer({ port: collisionPort });

    try {
      const cap = makeCapability({ capability_id: "cap-collision-test" });
      // Request preferred port that is currently occupied
      const { reservation, release } = await pm.reservePort(cap, collisionPort);

      // Must NOT be the occupied collisionPort!
      assert.notEqual(reservation.allocated_host_port, collisionPort);
      assert.equal(reservation.allocated_host_port >= 1024, true);

      await release();
    } finally {
      await blockingServer.close();
      await pm.dispose();
    }
  });

  it("rejects duplicate reservation for the same capability ID", async () => {
    const pm = new PortManager();
    try {
      const cap = makeCapability();
      await pm.reservePort(cap);

      await assert.rejects(
        async () => {
          await pm.reservePort(cap);
        },
        /already has an active reservation/,
      );
    } finally {
      await pm.dispose();
    }
  });

  it("releases all reservations for a session on reset/close", async () => {
    const pm = new PortManager();
    try {
      await pm.reservePort(makeCapability({ capability_id: "cap-1", session_id: "sess-A" }));
      await pm.reservePort(makeCapability({ capability_id: "cap-2", session_id: "sess-A" }));
      await pm.reservePort(makeCapability({ capability_id: "cap-3", session_id: "sess-B" }));

      assert.equal(pm.getActiveReservations().size, 3);
      const releasedCount = await pm.releaseAllForSession("sess-A");
      assert.equal(releasedCount, 2);
      assert.equal(pm.getActiveReservations().size, 1);
      assert.equal(pm.getActiveReservations().has("cap-3"), true);
    } finally {
      await pm.dispose();
    }
  });
});

describe("P7.2 Reverse Proxy: Real Windows Host Loopback Forwarding", () => {
  let targetServer: FixtureServerInstance;
  let proxy: LoopbackReverseProxyInstance;

  it("proxies HTTP requests from proxy port to target server on loopback", async () => {
    targetServer = await startFixtureServer();
    proxy = await startLoopbackReverseProxy({
      targetPort: targetServer.port,
    });

    assert.equal(proxy.listenOrigin.startsWith("http://127.0.0.1:"), true);
    assert.equal(proxy.targetOrigin, targetServer.origin);

    // Request through proxy to target root
    const res = await fetchThroughProxy(`${proxy.listenOrigin}/`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Course Factory Test Fixture/);

    // Request through proxy to target JSON endpoint
    const apiRes = await fetchThroughProxy(`${proxy.listenOrigin}/api/hello`);
    assert.equal(apiRes.status, 200);
    const json = JSON.parse(apiRes.text);
    assert.equal(json.ok, true);
    assert.equal(json.message, "hello");
  });

  it("returns 502 Bad Gateway with deterministic diagnostic when target server is offline", async () => {
    const unusedPort = await allocateEphemeralLoopbackPort();
    const offlineProxy = await startLoopbackReverseProxy({
      targetPort: unusedPort,
    });

    try {
      const res = await fetchThroughProxy(`${offlineProxy.listenOrigin}/api/hello`);
      assert.equal(res.status, 502);
      const json = JSON.parse(res.text);
      assert.equal(json.error, "BAD_GATEWAY");
      assert.equal(json.target_port, unusedPort);
    } finally {
      await offlineProxy.close();
    }
  });

  it("rejects non-loopback listen or target host fail-closed", async () => {
    await assert.rejects(
      async () => {
        await startLoopbackReverseProxy({ listenHost: "0.0.0.0", targetPort: 3000 });
      },
      /must listen on 127.0.0.1 loopback only/,
    );

    await assert.rejects(
      async () => {
        await startLoopbackReverseProxy({ targetHost: "192.168.1.1", targetPort: 3000 });
      },
      /must be 127.0.0.1 loopback only/,
    );
  });

  it("falls back to ephemeral port when preferred port is occupied and fallbackToEphemeral is true", async () => {
    const blockingServer = await startFixtureServer();
    const busyPort = blockingServer.port;
    const fallbackProxy = await startLoopbackReverseProxy({
      listenPort: busyPort,
      targetPort: blockingServer.port,
      fallbackToEphemeral: true,
    });
    try {
      assert.notEqual(fallbackProxy.listenPort, busyPort);
      assert.equal(fallbackProxy.listenPort >= 1024, true);
    } finally {
      await fallbackProxy.close();
      await blockingServer.close();
    }
  });

  it("closes cleanly and releases proxy socket", async () => {
    await proxy.close();
    await targetServer.close();
  });
});
