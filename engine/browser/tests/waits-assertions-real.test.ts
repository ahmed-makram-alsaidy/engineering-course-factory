// P7.5 Real Chromium Integration: Bounded Waits & Exact Assertions Matrix
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7.6, 7.7, 16 & Task P7.5.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeHost } from "../src/runtime.ts";
import { startFixtureServer, type FixtureServerInstance } from "../src/fixture-server.ts";
import { executeWait } from "../src/actions/wait.ts";
import { executeAssert } from "../src/actions/assert.ts";
import { waitForPortReadiness } from "../src/bridge.ts";
import type { AdmittedBrowserOperation } from "../src/admission.ts";

function createAdmittedOp(
  sessionId: string,
  generation: number,
  operationId: string,
  actionType: "browser_wait" | "browser_assert",
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

describe("P7.5 Real Chromium Integration: Bounded Waits (browser_wait)", () => {
  let fixtureServer: FixtureServerInstance;
  let host: BrowserRuntimeHost;
  const sessionId = "p75-real-waits";
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

  it("proves visible element wait succeeds when element is already present", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-wait-1", "browser_wait", {
      selector: { strategy: "role", value: "button", name: "Submit" },
      timeout_seconds: 3,
    });

    const result = await executeWait(session, pageHandle.rawPage, admitted);
    assert.equal(result.ok, true);
  });

  it("proves missing element wait times out bounded with SELECTOR_NOT_FOUND", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-wait-missing", "browser_wait", {
      selector: { strategy: "test_id", value: "completely-nonexistent-element" },
      timeout_seconds: 1,
    });

    // Override timeoutMs to 300ms for fast test execution
    const result = await executeWait(session, pageHandle.rawPage, admitted, { timeoutMs: 300 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "SELECTOR_NOT_FOUND");
  });

  it("proves dynamic element wait succeeds when element appears asynchronously", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    // Navigate to page that adds #delayed-box after 150ms
    await pageHandle.rawPage.goto(`${fixtureServer.origin}/dynamic-delayed?delay_ms=150`);

    const admitted = createAdmittedOp(sessionId, generation, "op-wait-dynamic", "browser_wait", {
      selector: { strategy: "test_id", value: "delayed-box" },
      timeout_seconds: 5,
    });

    const result = await executeWait(session, pageHandle.rawPage, admitted);
    assert.equal(result.ok, true);
  });

  it("proves text-only wait succeeds when text is present", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/`);

    const admitted = createAdmittedOp(sessionId, generation, "op-wait-text", "browser_wait", {
      text: "Course Factory Test Fixture",
      timeout_seconds: 3,
    });

    const result = await executeWait(session, pageHandle.rawPage, admitted);
    assert.equal(result.ok, true);
  });

  it("proves text-only wait times out bounded with SELECTOR_NOT_FOUND when text is missing", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/`);

    const admitted = createAdmittedOp(sessionId, generation, "op-wait-text-missing", "browser_wait", {
      text: "Text That Does Not Exist Anywhere",
      timeout_seconds: 1,
    });

    const result = await executeWait(session, pageHandle.rawPage, admitted, { timeoutMs: 300 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "SELECTOR_NOT_FOUND");
  });

  it("proves ambiguous selector wait fails closed with SELECTOR_AMBIGUOUS", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-wait-ambig", "browser_wait", {
      selector: { strategy: "test_id", value: "ambiguous-btn" },
      timeout_seconds: 2,
    });

    const result = await executeWait(session, pageHandle.rawPage, admitted, { timeoutMs: 300 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "SELECTOR_AMBIGUOUS");
  });

  it("proves wait cancellation via AbortSignal aborts promptly with OPERATION_CANCELLED", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const admitted = createAdmittedOp(sessionId, generation, "op-wait-cancel", "browser_wait", {
      selector: { strategy: "test_id", value: "nonexistent-item" },
      timeout_seconds: 10,
    });

    const result = await executeWait(session, pageHandle.rawPage, admitted, {
      signal: controller.signal,
      timeoutMs: 5000,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "OPERATION_CANCELLED");
  });

  it("proves port wait readiness provider detects listening port and times out on offline port", async () => {
    // Port readiness check against live fixture server
    const isReady = await waitForPortReadiness(fixtureServer.port, 2000, 100);
    assert.equal(isReady, true);

    // Port readiness check against closed ephemeral port times out
    await assert.rejects(
      async () => {
        await waitForPortReadiness(59998, 400, 100);
      },
      /PORT_UNAVAILABLE/,
    );
  });
});

describe("P7.5 Real Chromium Integration: Exact Assertions (browser_assert)", () => {
  let fixtureServer: FixtureServerInstance;
  let host: BrowserRuntimeHost;
  const sessionId = "p75-real-asserts";
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

  it("proves positive assertion with all matching fields passes cleanly", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-assert-all-pass", "browser_assert", {
      url_contains: "/form",
      selector: { strategy: "role", value: "button", name: "Submit" },
      selector_text: "Submit",
      text_visible: "User Registration Form",
    });

    const result = await executeAssert(session, pageHandle.rawPage, admitted);
    assert.equal(result.ok, true);
  });

  it("proves url_contains mismatch fails deterministically with ASSERTION_FAILED", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-assert-url-fail", "browser_assert", {
      url_contains: "/nonexistent-path",
    });

    const result = await executeAssert(session, pageHandle.rawPage, admitted);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "ASSERTION_FAILED");
    assert.match(result.message, /URL to contain/);
  });

  it("proves selector resolution failure fails deterministically with ASSERTION_FAILED", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-assert-sel-fail", "browser_assert", {
      selector: { strategy: "test_id", value: "nonexistent-widget" },
    });

    const result = await executeAssert(session, pageHandle.rawPage, admitted, { timeoutMs: 200 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "ASSERTION_FAILED");
  });

  it("proves ambiguous selector in assertion fails closed with SELECTOR_AMBIGUOUS", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-assert-ambig", "browser_assert", {
      selector: { strategy: "test_id", value: "ambiguous-btn" },
    });

    const result = await executeAssert(session, pageHandle.rawPage, admitted, { timeoutMs: 200 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "SELECTOR_AMBIGUOUS");
  });

  it("proves selector_text mismatch fails deterministically with ASSERTION_FAILED", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-assert-text-mismatch", "browser_assert", {
      selector: { strategy: "role", value: "button", name: "Submit" },
      selector_text: "Wrong Text That Does Not Match",
    });

    const result = await executeAssert(session, pageHandle.rawPage, admitted);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "ASSERTION_FAILED");
    assert.match(result.message, /expected text/);
  });

  it("proves text_visible failure when text is missing fails with ASSERTION_FAILED", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const admitted = createAdmittedOp(sessionId, generation, "op-assert-text-vis-fail", "browser_assert", {
      text_visible: "Text Not On Form",
    });

    const result = await executeAssert(session, pageHandle.rawPage, admitted);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "ASSERTION_FAILED");
    assert.match(result.message, /was not found on page/);
  });

  it("proves assertion executes deterministically with zero DOM mutation", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    await pageHandle.rawPage.goto(`${fixtureServer.origin}/form`);

    const counterSelector = { strategy: "test_id" as const, value: "counter-btn" };
    const initialText = await pageHandle.rawPage.getByTestId("counter-btn").textContent();

    // Assert that counter-btn has initial text
    const admitted = createAdmittedOp(sessionId, generation, "op-assert-no-mutate", "browser_assert", {
      selector: counterSelector,
      selector_text: initialText!,
    });

    const result = await executeAssert(session, pageHandle.rawPage, admitted);
    assert.equal(result.ok, true);

    // Verify text is identical and zero clicks or modifications occurred
    const postText = await pageHandle.rawPage.getByTestId("counter-btn").textContent();
    assert.equal(postText, initialText);
  });

  it("proves assertion requires at least one field fail-closed", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-assert-empty", "browser_assert", {});
    const result = await executeAssert(session, pageHandle.rawPage, admitted);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "ASSERTION_FIELD_REQUIRED");
  });

  it("proves selector_text without selector fails with SELECTOR_TEXT_REQUIRES_SELECTOR", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;

    const admitted = createAdmittedOp(sessionId, generation, "op-assert-text-no-sel", "browser_assert", {
      selector_text: "Some Text",
    });

    const result = await executeAssert(session, pageHandle.rawPage, admitted);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errorCode, "SELECTOR_TEXT_REQUIRES_SELECTOR");
  });
});
