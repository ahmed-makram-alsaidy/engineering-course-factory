// P7.5 Network Route Shield Unit Tests
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 10 & Task P7.5.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NetworkRouteShield, isPrivateOrLocalhostScan } from "../src/network-shield.ts";
import { LocalhostBridgeCoordinator } from "../src/bridge.ts";
import { registerFixtureOrigin, unregisterFixtureOrigin } from "../src/fixture-server.ts";
import type { ReviewedPortCapabilityV1 } from "../src/policy.ts";

describe("P7.5 Network Route Shield: Security Invariants & Policy Enforcement", () => {
  it("allows reviewed local origin explicitly present in allowlist", () => {
    const shield = new NetworkRouteShield({
      allowedOrigins: ["http://127.0.0.1:3000"],
    });

    const check = shield.isRequestAllowed("http://127.0.0.1:3000/dashboard");
    assert.equal(check.allowed, true);
  });

  it("denies public WAN origins fail-closed", () => {
    const shield = new NetworkRouteShield({
      allowedOrigins: ["http://127.0.0.1:3000"],
    });

    const googleCheck = shield.isRequestAllowed("https://google.com/search?q=test");
    assert.equal(googleCheck.allowed, false);
    assert.match(googleCheck.reason, /ORIGIN_NOT_PERMITTED/);

    const exampleCheck = shield.isRequestAllowed("https://example.com/api");
    assert.equal(exampleCheck.allowed, false);
    assert.match(exampleCheck.reason, /ORIGIN_NOT_PERMITTED/);
  });

  it("denies unreviewed arbitrary localhost ports to prevent localhost scanning", () => {
    const shield = new NetworkRouteShield({
      allowedOrigins: ["http://127.0.0.1:3000"],
    });

    // Attempt to probe PostgreSQL port 5432
    const pgCheck = shield.isRequestAllowed("http://127.0.0.1:5432/status");
    assert.equal(pgCheck.allowed, false);
    assert.match(pgCheck.reason, /UNAUTHORIZED_LOOPBACK_OR_PRIVATE_NET/);

    // Attempt to probe SSH port 22 on localhost
    const sshCheck = shield.isRequestAllowed("http://localhost:22/");
    assert.equal(sshCheck.allowed, false);
    assert.match(sshCheck.reason, /UNAUTHORIZED_LOOPBACK_OR_PRIVATE_NET/);

    // Attempt to probe random high port 8080
    const devCheck = shield.isRequestAllowed("http://127.0.0.1:8080/metrics");
    assert.equal(devCheck.allowed, false);
    assert.match(devCheck.reason, /UNAUTHORIZED_LOOPBACK_OR_PRIVATE_NET/);
  });

  it("denies private LAN ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)", () => {
    const shield = new NetworkRouteShield({
      allowedOrigins: ["http://127.0.0.1:3000"],
    });

    assert.equal(shield.isRequestAllowed("http://10.0.0.1:8080/").allowed, false);
    assert.equal(shield.isRequestAllowed("http://172.16.0.5:3000/").allowed, false);
    assert.equal(shield.isRequestAllowed("http://192.168.1.1:80/").allowed, false);
    assert.equal(shield.isRequestAllowed("http://169.254.169.254/latest/meta-data").allowed, false);
  });

  it("denies forbidden URL schemes (file:, data:, javascript:, chrome:)", () => {
    const shield = new NetworkRouteShield({
      allowedOrigins: ["http://127.0.0.1:3000"],
    });

    assert.equal(shield.isRequestAllowed("file:///C:/Windows/win.ini").allowed, false);
    assert.equal(shield.isRequestAllowed("data:text/html,<h1>test</h1>").allowed, false);
    assert.equal(shield.isRequestAllowed("javascript:alert(1)").allowed, false);
    assert.equal(shield.isRequestAllowed("chrome://settings").allowed, false);
  });

  it("denies URLs with embedded credentials", () => {
    const shield = new NetworkRouteShield({
      allowedOrigins: ["http://127.0.0.1:3000"],
    });

    const credCheck = shield.isRequestAllowed("http://admin:secret@127.0.0.1:3000/admin");
    assert.equal(credCheck.allowed, false);
    assert.equal(credCheck.reason, "URL_CREDENTIALS_FORBIDDEN");
  });

  it("allows active local test fixture server automatically", () => {
    const fixtureOrigin = "http://127.0.0.1:54999";
    registerFixtureOrigin(fixtureOrigin);

    try {
      const shield = new NetworkRouteShield({
        allowedOrigins: ["http://127.0.0.1:3000"],
      });

      const check = shield.isRequestAllowed(`${fixtureOrigin}/form`);
      assert.equal(check.allowed, true);
    } finally {
      unregisterFixtureOrigin(fixtureOrigin);
    }
  });

  it("supports dynamic addition and removal of allowed origins", () => {
    const shield = new NetworkRouteShield();
    assert.equal(shield.isRequestAllowed("http://127.0.0.1:4000/").allowed, false);

    shield.addAllowedOrigin("http://127.0.0.1:4000");
    assert.equal(shield.isRequestAllowed("http://127.0.0.1:4000/api").allowed, true);

    shield.removeAllowedOrigin("http://127.0.0.1:4000");
    assert.equal(shield.isRequestAllowed("http://127.0.0.1:4000/api").allowed, false);
  });

  it("supports bridge coordinator origin matching and ephemeral port translation", async () => {
    const coordinator = new LocalhostBridgeCoordinator("sess-test", 1);

    const capability: ReviewedPortCapabilityV1 = {
      kind: "reviewed_port_capability",
      capability_version: 1,
      capability_id: "cap-bridge-1",
      lesson_id: "L01",
      session_id: "sess-test",
      generation: 1,
      background_process_id: "proc-1",
      guest_port: 3000,
      reviewed_origin: "http://localhost:3000",
      policy_version: 1,
      policy_digest: "a".repeat(64),
    };

    // Activate bridge with preferred listen port occupied, assigning ephemeral listen port
    await coordinator.activateBridge(capability, 52143, {
      preferredListenPort: 52144,
      launchProxy: false,
    });

    const shield = new NetworkRouteShield({
      bridgeCoordinator: coordinator,
    });

    // Authored origin should be allowed
    const check = shield.isRequestAllowed("http://localhost:3000/app");
    assert.equal(check.allowed, true);

    await coordinator.close();
  });
});
