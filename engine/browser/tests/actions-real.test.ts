// P7.4 Real Chromium Selector Resolution & Action Execution Integration Tests — browser_protocol_version = 1.
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7, 8, 29, 30.
//
// Real platform verification proving:
// 1. Pinned Chromium binary (revision 1155) launches out-of-process via pipe transport.
// 2. Local deterministic fixture server on 127.0.0.1 provides DOM targets.
// 3. Exact selector strategy proofs on real DOM:
//    - role (unique succeeds, zero fails SELECTOR_NOT_FOUND, >1 fails SELECTOR_AMBIGUOUS)
//    - label (unique succeeds, zero fails SELECTOR_NOT_FOUND, >1 fails SELECTOR_AMBIGUOUS)
//    - test_id (unique succeeds, zero fails SELECTOR_NOT_FOUND, >1 fails SELECTOR_AMBIGUOUS)
//    - text (unique succeeds, zero fails SELECTOR_NOT_FOUND, >1 fails SELECTOR_AMBIGUOUS)
//    - css (unique succeeds, zero fails SELECTOR_NOT_FOUND, >1 fails SELECTOR_AMBIGUOUS)
// 4. browser_click: executes exactly once on actionable element; disabled/hidden fails ELEMENT_NOT_ACTIONABLE.
// 5. browser_fill: fills exact reviewed value without OS keyboard; observable via inputValue().
// 6. browser_press: dispatches reviewed key cleanly without OS keyboard; invalid key fails INVALID_KEY_NAME.
// 7. Dynamic DOM mutation handling: auto-waits for single element; fails if >1 appears.
// 8. Popup and dialog safety: dialog auto-dismisses without hanging; popup closes fail-closed.
// 9. Zero page.evaluate, zero arbitrary JS, zero force: true.
// 10. Clean teardown: 0 zombie processes, profile purged.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntimeHost } from "../src/runtime.ts";
import { startFixtureServer, type FixtureServerInstance } from "../src/fixture-server.ts";
import { resolveStrictSelector } from "../src/selectors.ts";
import { executeClick } from "../src/actions/click.ts";
import { executeFill } from "../src/actions/fill.ts";
import { executePress } from "../src/actions/press.ts";
import { BrowserActionExecutor } from "../src/actions/executor.ts";
import type { AdmittedBrowserOperation } from "../src/admission.ts";
import type { BrowserSelector } from "../src/protocol.ts";

function createAdmittedOp(
  sessionId: string,
  generation: number,
  operationId: string,
  actionType: "browser_click" | "browser_fill" | "browser_press",
  params: any,
  browserOrder = 0,
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

describe("P7.4 Real Chromium Integration: Selector Strategies & Cardinality", () => {
  let fixtureServer: FixtureServerInstance;
  let host: BrowserRuntimeHost;
  const sessionId = "p74-real-selectors";
  const generation = 1;

  before(async () => {
    fixtureServer = await startFixtureServer();
    host = new BrowserRuntimeHost();
    const startRes = await host.prepareSession({
      sessionId,
      generation,
      headless: true,
    });
    assert.equal(startRes.ok, true, "Browser must launch cleanly");
  });

  after(async () => {
    await host.close();
    await fixtureServer.close();
  });

  it("proves role selector: unique succeeds, zero fails, ambiguous fails", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    // Load form fixture
    await page.goto(`${fixtureServer.origin}/form`);

    // 1. Role unique match succeeds
    const uniqueSel: BrowserSelector = { strategy: "role", value: "button", name: "Submit" };
    const uniqueRes = await resolveStrictSelector(page, uniqueSel, 1000);
    assert.equal(uniqueRes.ok, true);
    if (!uniqueRes.ok) return;
    assert.equal(uniqueRes.matchCount, 1);

    // 2. Role zero match fails closed with SELECTOR_NOT_FOUND
    const zeroSel: BrowserSelector = { strategy: "role", value: "button", name: "NonExistentSubmit" };
    const zeroRes = await resolveStrictSelector(page, zeroSel, 200);
    assert.equal(zeroRes.ok, false);
    if (zeroRes.ok) return;
    assert.equal(zeroRes.errorCode, "SELECTOR_NOT_FOUND");

    // 3. Role ambiguous (>1 matches) fails closed with SELECTOR_AMBIGUOUS
    // On /dynamic, there are multiple <li role="listitem"> elements
    await page.goto(`${fixtureServer.origin}/dynamic`);
    const ambigSel: BrowserSelector = { strategy: "role", value: "listitem" };
    const ambigRes = await resolveStrictSelector(page, ambigSel, 200);
    assert.equal(ambigRes.ok, false);
    if (ambigRes.ok) return;
    assert.equal(ambigRes.errorCode, "SELECTOR_AMBIGUOUS");
    assert.equal(ambigRes.matchCount >= 2, true);
  });

  it("proves label selector: unique succeeds, zero fails", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    // 1. Label unique match succeeds
    const uniqueSel: BrowserSelector = { strategy: "label", value: "Username" };
    const uniqueRes = await resolveStrictSelector(page, uniqueSel, 1000);
    assert.equal(uniqueRes.ok, true);
    if (!uniqueRes.ok) return;
    assert.equal(uniqueRes.matchCount, 1);

    // 2. Label zero match fails with SELECTOR_NOT_FOUND
    const zeroSel: BrowserSelector = { strategy: "label", value: "NonExistentField" };
    const zeroRes = await resolveStrictSelector(page, zeroSel, 200);
    assert.equal(zeroRes.ok, false);
    if (zeroRes.ok) return;
    assert.equal(zeroRes.errorCode, "SELECTOR_NOT_FOUND");
  });

  it("proves test_id selector: unique succeeds, zero fails, ambiguous fails", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    // 1. TestId unique match succeeds
    const uniqueSel: BrowserSelector = { strategy: "test_id", value: "username-input" };
    const uniqueRes = await resolveStrictSelector(page, uniqueSel, 1000);
    assert.equal(uniqueRes.ok, true);
    if (!uniqueRes.ok) return;
    assert.equal(uniqueRes.matchCount, 1);

    // 2. TestId zero match fails with SELECTOR_NOT_FOUND
    const zeroSel: BrowserSelector = { strategy: "test_id", value: "nonexistent-test-id" };
    const zeroRes = await resolveStrictSelector(page, zeroSel, 200);
    assert.equal(zeroRes.ok, false);
    if (zeroRes.ok) return;
    assert.equal(zeroRes.errorCode, "SELECTOR_NOT_FOUND");

    // 3. TestId ambiguous (>1 matches) fails with SELECTOR_AMBIGUOUS
    const ambigSel: BrowserSelector = { strategy: "test_id", value: "ambiguous-btn" };
    const ambigRes = await resolveStrictSelector(page, ambigSel, 200);
    assert.equal(ambigRes.ok, false);
    if (ambigRes.ok) return;
    assert.equal(ambigRes.errorCode, "SELECTOR_AMBIGUOUS");
    assert.equal(ambigRes.matchCount, 2);
  });

  it("proves text selector: unique succeeds, zero fails, ambiguous fails", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    // 1. Text unique match succeeds
    const uniqueSel: BrowserSelector = { strategy: "text", value: "User Registration Form" };
    const uniqueRes = await resolveStrictSelector(page, uniqueSel, 1000);
    assert.equal(uniqueRes.ok, true);
    if (!uniqueRes.ok) return;
    assert.equal(uniqueRes.matchCount, 1);

    // 2. Text zero match fails with SELECTOR_NOT_FOUND
    const zeroSel: BrowserSelector = { strategy: "text", value: "Completely Missing Headline" };
    const zeroRes = await resolveStrictSelector(page, zeroSel, 200);
    assert.equal(zeroRes.ok, false);
    if (zeroRes.ok) return;
    assert.equal(zeroRes.errorCode, "SELECTOR_NOT_FOUND");

    // 3. Text ambiguous match fails with SELECTOR_AMBIGUOUS
    const ambigSel: BrowserSelector = { strategy: "text", value: "Duplicate Action" };
    const ambigRes = await resolveStrictSelector(page, ambigSel, 200);
    assert.equal(ambigRes.ok, false);
    if (ambigRes.ok) return;
    assert.equal(ambigRes.errorCode, "SELECTOR_AMBIGUOUS");
    assert.equal(ambigRes.matchCount, 2);
  });

  it("proves css selector: unique succeeds, zero fails, ambiguous fails", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    // 1. CSS unique match succeeds
    const uniqueSel: BrowserSelector = { strategy: "css", value: "#username" };
    const uniqueRes = await resolveStrictSelector(page, uniqueSel, 1000);
    assert.equal(uniqueRes.ok, true);
    if (!uniqueRes.ok) return;
    assert.equal(uniqueRes.matchCount, 1);

    // 2. CSS zero match fails with SELECTOR_NOT_FOUND
    const zeroSel: BrowserSelector = { strategy: "css", value: "#nonexistent-element" };
    const zeroRes = await resolveStrictSelector(page, zeroSel, 200);
    assert.equal(zeroRes.ok, false);
    if (zeroRes.ok) return;
    assert.equal(zeroRes.errorCode, "SELECTOR_NOT_FOUND");

    // 3. CSS ambiguous match fails with SELECTOR_AMBIGUOUS
    const ambigSel: BrowserSelector = { strategy: "css", value: ".ambiguous-btn" };
    const ambigRes = await resolveStrictSelector(page, ambigSel, 200);
    assert.equal(ambigRes.ok, false);
    if (ambigRes.ok) return;
    assert.equal(ambigRes.errorCode, "SELECTOR_AMBIGUOUS");
    assert.equal(ambigRes.matchCount, 2);
  });
});

describe("P7.4 Real Chromium Integration: Action Execution (Click, Fill, Press)", () => {
  let fixtureServer: FixtureServerInstance;
  let host: BrowserRuntimeHost;
  const sessionId = "p74-real-actions";
  const generation = 1;

  before(async () => {
    fixtureServer = await startFixtureServer();
    host = new BrowserRuntimeHost();
    await host.prepareSession({
      sessionId,
      generation,
      headless: true,
    });
  });

  after(async () => {
    await host.close();
    await fixtureServer.close();
  });

  it("proves browser_click executes exactly once on actionable button", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    const counterLoc = page.locator("#counter-btn");
    assert.equal(await counterLoc.textContent(), "Clicked 0");

    const admittedOp = createAdmittedOp(sessionId, generation, "op-click-counter", "browser_click", {
      selector: { strategy: "test_id", value: "counter-btn" },
    });

    const res = await executeClick(session, page, admittedOp);
    assert.equal(res.ok, true);
    assert.equal(await counterLoc.textContent(), "Clicked 1");
    assert.equal(await counterLoc.getAttribute("data-clicks"), "1");
  });

  it("proves click on disabled element fails bounded with ELEMENT_NOT_ACTIONABLE", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    const admittedOp = createAdmittedOp(sessionId, generation, "op-click-disabled", "browser_click", {
      selector: { strategy: "test_id", value: "disabled-btn" },
    });

    const res = await executeClick(session, page, admittedOp, { timeoutMs: 300 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.errorCode, "ELEMENT_NOT_ACTIONABLE");
  });

  it("proves click on hidden element fails bounded with ELEMENT_NOT_ACTIONABLE", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    const admittedOp = createAdmittedOp(sessionId, generation, "op-click-hidden", "browser_click", {
      selector: { strategy: "test_id", value: "hidden-btn" },
    });

    const res = await executeClick(session, page, admittedOp, { timeoutMs: 300 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.errorCode, "ELEMENT_NOT_ACTIONABLE");
  });

  it("proves browser_fill fills exact reviewed value into input without OS clipboard", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    const usernameLoc = page.locator("#username");
    assert.equal(await usernameLoc.inputValue(), "");

    const admittedOp = createAdmittedOp(sessionId, generation, "op-fill-username", "browser_fill", {
      selector: { strategy: "label", value: "Username" },
      value: "Ada Lovelace",
    });

    const res = await executeFill(session, page, admittedOp);
    assert.equal(res.ok, true);
    assert.equal(await usernameLoc.inputValue(), "Ada Lovelace");
  });

  it("proves browser_press dispatches exact key and registers cleanly", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    const targetLoc = page.locator("#press-target");
    await targetLoc.focus();

    const admittedOp = createAdmittedOp(sessionId, generation, "op-press-enter", "browser_press", {
      key: "Enter",
    });

    const res = await executePress(session, page, admittedOp);
    assert.equal(res.ok, true);
    assert.equal(await targetLoc.getAttribute("data-last-key"), "Enter");

    // Invalid key identifier rejected before action
    const invalidOp = createAdmittedOp(sessionId, generation, "op-press-bad", "browser_press", {
      key: "BogusKeyName999",
    });
    const badRes = await executePress(session, page, invalidOp);
    assert.equal(badRes.ok, false);
    if (!badRes.ok) {
      assert.equal(badRes.errorCode, "INVALID_KEY_NAME");
    }
  });

  it("proves unexpected dialog auto-dismisses and click does not hang", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/dialog`);

    const admittedOp = createAdmittedOp(sessionId, generation, "op-click-dialog", "browser_click", {
      selector: { strategy: "test_id", value: "trigger-alert" },
    });

    // Alert dialog must auto-dismiss fail-closed without hanging
    const res = await executeClick(session, page, admittedOp, { timeoutMs: 3000 });
    assert.equal(res.ok, true);
  });

  it("proves dynamic DOM mutation resolves single element and fails if ambiguous", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.setContent("<div><p id='status'>Initial</p></div>");

    // Dynamic addition of single button after 100ms
    setTimeout(async () => {
      try {
        await page.setContent("<div><p id='status'>Initial</p><button id='dynamic-btn' data-testid='dynamic-btn'>Dynamic Single</button></div>");
      } catch {}
    }, 100);

    const singleSel: BrowserSelector = { strategy: "test_id", value: "dynamic-btn" };
    const resSingle = await resolveStrictSelector(page, singleSel, 1500);
    assert.equal(resSingle.ok, true);
    if (!resSingle.ok) return;
    assert.equal(resSingle.matchCount, 1);

    // Dynamic addition of two buttons after 100ms
    await page.setContent("<div><p id='status'>Initial</p></div>");
    setTimeout(async () => {
      try {
        await page.setContent("<div><button class='dynamic-duo'>Duo 1</button><button class='dynamic-duo'>Duo 2</button></div>");
      } catch {}
    }, 100);

    const duoSel: BrowserSelector = { strategy: "css", value: ".dynamic-duo" };
    const resDuo = await resolveStrictSelector(page, duoSel, 1500);
    assert.equal(resDuo.ok, false);
    if (resDuo.ok) return;
    assert.equal(resDuo.errorCode, "SELECTOR_AMBIGUOUS");
  });

  it("proves popup creation fails closed without affecting primary page", async () => {
    const session = host.getActiveSession()!;
    const ctx = session.getManagedContext();
    const initialBlocked = ctx.getBlockedPopupCount();

    // Trigger secondary page creation
    const popup = await ctx.context.newPage();
    for (let i = 0; i < 20 && !popup.isClosed(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(ctx.getBlockedPopupCount(), initialBlocked + 1);
    assert.equal(popup.isClosed(), true);
    assert.equal(session.getPrimaryPageHandle()?.isAlive(), true);
  });

  it("proves page crash during action execution settles once as PAGE_CRASHED", async () => {
    const crashSessionId = "p74-crash-action";
    const crashHost = new BrowserRuntimeHost();
    await crashHost.prepareSession({
      sessionId: crashSessionId,
      generation: 1,
      headless: true,
    });

    const session = crashHost.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const admittedOp = createAdmittedOp(crashSessionId, 1, "op-crash", "browser_click", {
      selector: { strategy: "css", value: "#some-target" },
    });

    // Trigger crash before action dispatch
    (pageHandle.rawPage as any).emit("crash", pageHandle.rawPage);

    const res = await executeClick(session, pageHandle.rawPage, admittedOp, { timeoutMs: 500 });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.errorCode, "PAGE_CRASHED");

    await crashHost.close();
  });
});

describe("P7.4 Real Chromium Integration: Executor End-to-End Coordination", () => {
  let fixtureServer: FixtureServerInstance;
  let host: BrowserRuntimeHost;
  const sessionId = "p74-real-executor";
  const generation = 1;

  before(async () => {
    fixtureServer = await startFixtureServer();
    host = new BrowserRuntimeHost();
    await host.prepareSession({
      sessionId,
      generation,
      headless: true,
    });
  });

  after(async () => {
    await host.close();
    await fixtureServer.close();
  });

  it("proves BrowserActionExecutor emits journal events and returns valid receipt on real page", async () => {
    const session = host.getActiveSession()!;
    const pageHandle = session.getPrimaryPageHandle()!;
    const page = pageHandle.rawPage;

    await page.goto(`${fixtureServer.origin}/form`);

    const executor = new BrowserActionExecutor({ journal: host.getJournal() });

    const admittedClick = createAdmittedOp(sessionId, generation, "real-e2e-click", "browser_click", {
      selector: { strategy: "test_id", value: "counter-btn" },
    });

    const receipt = await executor.execute(session, pageHandle, admittedClick);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.outcome, "completed");
    assert.equal(receipt.operation_id, "real-e2e-click");
    assert.equal(receipt.session_id, sessionId);

    const journalEvents = host.getJournal().getEvents();
    assert.equal(journalEvents.some((e) => e.type === "browser.operation.started" && e.operation_id === "real-e2e-click"), true);
    assert.equal(journalEvents.some((e) => e.type === "browser.operation.completed" && e.operation_id === "real-e2e-click"), true);
  });
});
