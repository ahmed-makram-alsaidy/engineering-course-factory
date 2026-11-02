// P7.5 Real Chromium Integration: Navigation, Redirects & HTTP Status Matrix
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7.1, 7.5, 9, 10 & Task P7.5.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeHost } from "../src/runtime.ts";
import { startFixtureServer, type FixtureServerInstance } from "../src/fixture-server.ts";
import { executeOpen } from "../src/actions/open.ts";
import { executeRefresh } from "../src/actions/refresh.ts";
import type { AdmittedBrowserOperation } from "../src/admission.ts";
import { createReviewedBrowserPolicy } from "../src/policy.ts";

function createAdmittedOp(
  sessionId: string,
  generation: number,
  operationId: string,
  actionType: "browser_open" | "browser_refresh",
  params: any,
  browserOrder = 1,
): AdmittedBrowserOperation {
  return {
    kind: "browser_admission",
    admission_version: 1,
    session_id: sessionId,
    generation,
    request_id: `req-${operationId}`,
    operation_id: operationId,
    action_type: actionType,
    parameters: {
      type: actionType,
      ...params,
    },
    browser_order: browserOrder,
    admitted_at_ms: Date.now(),
  };
}

describe("P7.5 Real Chromium Integration: Navigation Matrix (browser_open)", () => {
  let fixtureServer: FixtureServerInstance;
  let host: BrowserRuntimeHost;
  const sessionId = "p75-real-nav";
  const generation = 1;

  before(async () => {
    fixtureServer = await startFixtureServer();
    host = new BrowserRuntimeHost();
    const startRes = await host.prepareSession({
      sessionId,
      generation,
      headless: true,
      allowedOrigins: [fixtureServer.origin],
    });
    assert.equal(startRes.ok, true, "Browser must launch cleanly");
  });

  after(async () => {
    await host.close();
    await fixtureServer.close();
  });

  it("proves reviewed origin navigation succeeds with 200 OK and load event", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-200", "browser_open", {
      url: `${fixtureServer.origin}/`,
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, true);
    assert.equal(pageHandle.rawPage.url(), `${fixtureServer.origin}/`);
  });

  it("proves unreviewed origin navigation is blocked fail-closed", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-unreviewed", "browser_open", {
      url: "http://127.0.0.1:59999/secret",
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "ORIGIN_NOT_PERMITTED");
  });

  it("proves invalid URL scheme is rejected fail-closed", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-scheme", "browser_open", {
      url: "javascript:alert(1)",
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "INVALID_SCHEME");
  });

  it("proves embedded credentials in URL are rejected fail-closed", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const parsed = new URL(fixtureServer.origin);
    const credUrl = `http://admin:pass@${parsed.host}/`;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-creds", "browser_open", {
      url: credUrl,
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "URL_CREDENTIALS_FORBIDDEN");
  });

  it("proves multi-hop redirect within allowed origin succeeds (hops <= 10)", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-redirect-ok", "browser_open", {
      url: `${fixtureServer.origin}/redirect-chain?hops=3&target=/form`,
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, true);
    assert.match(pageHandle.rawPage.url(), /\/form$/);
  });

  it("proves redirect to unreviewed origin is blocked fail-closed", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-redirect-unreviewed", "browser_open", {
      url: `${fixtureServer.origin}/redirect-external?target=https://example.com/blocked`,
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "ORIGIN_NOT_PERMITTED");
  });

  it("proves exceeding maximum redirect limit (>10 hops) aborts with TOO_MANY_REDIRECTS", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-redirect-limit", "browser_open", {
      url: `${fixtureServer.origin}/redirect-chain?hops=12&target=/form`,
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "TOO_MANY_REDIRECTS");
  });

  it("proves HTTP 404 status returns deterministic HTTP_ERROR_STATUS failure", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-404", "browser_open", {
      url: `${fixtureServer.origin}/status/404`,
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "HTTP_ERROR_STATUS");
    assert.match(result.message, /404/);
  });

  it("proves HTTP 500 status returns deterministic HTTP_ERROR_STATUS failure", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-500", "browser_open", {
      url: `${fixtureServer.origin}/status/500`,
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "HTTP_ERROR_STATUS");
    assert.match(result.message, /500/);
  });

  it("proves navigation cancellation via AbortSignal aborts cleanly", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-cancel", "browser_open", {
      url: `${fixtureServer.origin}/`,
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      signal: controller.signal,
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "OPERATION_CANCELLED");
  });

  it("proves reset / generation rotation fences navigation before dispatch", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-nav-fenced", "browser_open", {
      url: `${fixtureServer.origin}/`,
    });

    const result = await executeOpen(session, pageHandle.rawPage, admitted, {
      beforeActionDispatch: async () => {
        // Rotate generation before dispatch
        (session as any).generation = generation + 1;
      },
      allowedOrigins: [fixtureServer.origin],
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "STALE_GENERATION");

    // Restore generation
    (session as any).generation = generation;
  });
});

describe("P7.5 Real Chromium Integration: Refresh Semantics (browser_refresh)", () => {
  let fixtureServer: FixtureServerInstance;
  let host: BrowserRuntimeHost;
  const sessionId = "p75-real-refresh";
  const generation = 1;

  before(async () => {
    fixtureServer = await startFixtureServer();
    host = new BrowserRuntimeHost();
    const startRes = await host.prepareSession({
      sessionId,
      generation,
      headless: true,
      allowedOrigins: [fixtureServer.origin],
    });
    assert.equal(startRes.ok, true, "Browser must launch cleanly");
  });

  after(async () => {
    await host.close();
    await fixtureServer.close();
  });

  it("proves browser_refresh on valid navigated page succeeds with 200 OK", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    // Navigate to form first
    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-refresh-1", "browser_refresh", {});
    const result = await executeRefresh(session, pageHandle.rawPage, admitted);

    assert.equal(result.ok, true);
    assert.match(pageHandle.rawPage.url(), /\/form$/);
  });

  it("proves browser_refresh on 500 error page returns HTTP_ERROR_STATUS", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    // Navigate to status 500
    try {
      await pageHandle.rawPage.goto(`${fixtureServer.origin}/status/500`);
    } catch {}

    const admitted = createAdmittedOp(sessionId, generation, "op-refresh-500", "browser_refresh", {});
    const result = await executeRefresh(session, pageHandle.rawPage, admitted);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "HTTP_ERROR_STATUS");
  });

  it("proves refresh cancellation via AbortSignal aborts with OPERATION_CANCELLED", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/`);

    const controller = new AbortController();
    controller.abort();

    const admitted = createAdmittedOp(sessionId, generation, "op-refresh-cancel", "browser_refresh", {});
    const result = await executeRefresh(session, pageHandle.rawPage, admitted, {
      signal: controller.signal,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "OPERATION_CANCELLED");
  });
});
