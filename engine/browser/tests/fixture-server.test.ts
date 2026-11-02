// P7.2 Fixture Server Tests — deterministic test server for browser automation.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md section 29 and task P7.2.
// Verifies all fixture server endpoints, bounded request processing, and clean disposal.
// Pure, deterministic, offline (no browser, no WAN networking).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  FIXTURE_SERVER_MAX_BODY_BYTES,
  startFixtureServer,
  type FixtureServerInstance,
} from "../src/fixture-server.ts";

function fetchText(url: string, options: http.RequestOptions = {}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
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
    req.end();
  });
}

function postData(url: string, payload: string | Buffer): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text: data });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("P7.2 Fixture Server: Lifecycle & Loopback Binding", () => {
  it("starts and binds strictly to 127.0.0.1 on an ephemeral port", async () => {
    const server = await startFixtureServer();
    try {
      assert.equal(server.host, "127.0.0.1");
      assert.equal(server.port > 1024, true);
      assert.equal(server.origin, `http://127.0.0.1:${server.port}`);
    } finally {
      await server.close();
    }
  });

  it("rejects non-loopback host binding fail-closed", async () => {
    await assert.rejects(
      async () => {
        await startFixtureServer({ host: "0.0.0.0" });
      },
      /must bind to 127.0.0.1 loopback only/,
    );
  });

  it("closes idempotently without errors", async () => {
    const server = await startFixtureServer();
    await server.close();
    // Second close must not throw
    await assert.doesNotReject(async () => {
      await server.close();
    });
  });
});

describe("P7.2 Fixture Server: Routes & Endpoints", () => {
  let server: FixtureServerInstance;

  it("starts fixture server instance for route testing", async () => {
    server = await startFixtureServer();
  });

  it("serves root HTML with welcome message and nosniff header", async () => {
    const res = await fetchText(`${server.origin}/`);
    assert.equal(res.status, 200);
    assert.match(res.text, /Course Factory Test Fixture/);
    assert.match(res.text, /Deterministic test server ready/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });

  it("serves accessible form page with roles and data-testid attributes", async () => {
    const res = await fetchText(`${server.origin}/form`);
    assert.equal(res.status, 200);
    assert.match(res.text, /role="form"/);
    assert.match(res.text, /data-testid="username-input"/);
    assert.match(res.text, /data-testid="submit-btn"/);
  });

  it("serves dynamic dashboard page with heading and badges", async () => {
    const res = await fetchText(`${server.origin}/dynamic`);
    assert.equal(res.status, 200);
    assert.match(res.text, /role="heading"/);
    assert.match(res.text, /data-testid="status-badge"/);
  });

  it("serves dialog trigger page", async () => {
    const res = await fetchText(`${server.origin}/dialog`);
    assert.equal(res.status, 200);
    assert.match(res.text, /data-testid="trigger-alert"/);
  });

  it("returns explicit status codes via /status/:code", async () => {
    const codes = [200, 201, 301, 400, 403, 404, 500];
    for (const code of codes) {
      const res = await fetchText(`${server.origin}/status/${code}`);
      assert.equal(res.status, code);
      const json = JSON.parse(res.text);
      assert.equal(json.status, code);
    }
  });

  it("handles 302 redirect safely without open redirect vulnerability", async () => {
    // Relative path redirect
    const res1 = await fetchText(`${server.origin}/redirect?target=/dynamic`, { method: "GET" });
    assert.equal(res1.status, 302);
    assert.equal(res1.headers["location"], "/dynamic");

    // Open redirect attempt to evil.com must be neutralized to /
    const res2 = await fetchText(`${server.origin}/redirect?target=https://evil.com`, { method: "GET" });
    assert.equal(res2.status, 302);
    assert.equal(res2.headers["location"], "/");
  });

  it("handles slow endpoint with bounded delay", async () => {
    const start = Date.now();
    const res = await fetchText(`${server.origin}/slow?delay_ms=100`);
    const elapsed = Date.now() - start;
    assert.equal(res.status, 200);
    assert.equal(elapsed >= 80, true);
  });

  it("serves JSON api endpoint", async () => {
    const res = await fetchText(`${server.origin}/api/hello`);
    assert.equal(res.status, 200);
    const json = JSON.parse(res.text);
    assert.equal(json.ok, true);
    assert.equal(json.message, "hello");
  });

  it("accepts bounded POST payload and rejects payload exceeding 64 KiB", async () => {
    // Valid bounded payload (1 KiB)
    const validData = "A".repeat(1024);
    const resValid = await postData(`${server.origin}/api/submit`, validData);
    assert.equal(resValid.status, 200);
    const json = JSON.parse(resValid.text);
    assert.equal(json.bytes_received, 1024);

    // Oversized payload (> 64 KiB)
    const oversized = Buffer.alloc(FIXTURE_SERVER_MAX_BODY_BYTES + 1024, "X");
    const resOversized = await postData(`${server.origin}/api/submit`, oversized).catch((err) => {
      // Socket destruction on payload too large is also valid
      return { status: 413, text: err.message };
    });
    assert.equal(resOversized.status === 413 || resOversized.text.includes("PAYLOAD_TOO_LARGE"), true);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetchText(`${server.origin}/nonexistent-path`);
    assert.equal(res.status, 404);
    const json = JSON.parse(res.text);
    assert.equal(json.error, "NOT_FOUND");
  });

  it("closes fixture server cleanly", async () => {
    await server.close();
  });
});
