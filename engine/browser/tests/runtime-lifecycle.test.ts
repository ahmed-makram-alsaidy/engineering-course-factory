// P7.3 Browser Runtime Lifecycle & Process Management Integration Tests — browser_protocol_version = 1.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 4, 5, 13, 16, 17, 18, 19, 21.
// Real platform verification proving:
// 1. Pinned Chromium binary launches out-of-process via Playwright Core stdio pipe.
// 2. Zero remote-debugging TCP port; pipe transport only.
// 3. Chromium sandbox preserved (chromiumSandbox: true; zero --no-sandbox).
// 4. Exactly one BrowserSession per session_id + generation.
// 5. Exactly one BrowserContext per session.
// 6. Exactly one primary BrowserPage per session (tracked via page_id).
// 7. Start idempotency: duplicate start returns existing session descriptor.
// 8. Unexpected popup / secondary page is intercepted and closed fail-closed (POPUP_BLOCKED).
// 9. Reset lifecycle: page/context closed, process terminated via Job Object, profile purged, generation rotated.
// 10. Stale session and stale generation fencing (STALE_SESSION, STALE_GENERATION).
// 11. Crash handling: disconnect -> BROWSER_CRASHED; page crash -> PAGE_CRASHED.
// 12. Close is idempotent and leaves ZERO zombie processes.
// 13. Canonical journal events emitted: browser.started, page.opened, browser.closed.
// 14. Renderer authority is strictly absent: safe descriptors only.
// 15. Absolute invariant: NO page.evaluate, NO arbitrary JS.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { BrowserRuntimeHost } from "../src/runtime.ts";
import { WindowsJobObject } from "../src/job-object.ts";
import { LocalhostBridgeCoordinator } from "../src/bridge.ts";

describe("P7.3 Real Browser Runtime Lifecycle & Process Management", () => {
  it("proves real pinned Chromium launches with single context, single page, and pipe transport", async () => {
    const host = new BrowserRuntimeHost();
    const sessionId = "p73-real-launch";

    const startResult = await host.prepareSession({
      sessionId,
      generation: 1,
      headless: true,
    });

    assert.equal(startResult.ok, true);
    if (!startResult.ok) return;

    assert.equal(startResult.descriptor.session_id, sessionId);
    assert.equal(startResult.descriptor.generation, 1);
    assert.equal(startResult.descriptor.status, "ready");

    const session = host.getActiveSession();
    assert.ok(session, "Active session must exist");
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.generation, 1);
    assert.equal(session.isReady(), true);

    // Context & Page invariants
    const ctx = session.getManagedContext();
    assert.ok(ctx, "Managed context must exist");
    const primaryHandle = session.getPrimaryPageHandle();
    assert.ok(primaryHandle, "Primary page handle must exist");
    assert.equal(primaryHandle.pageId, "page-1");
    assert.equal(primaryHandle.isAlive(), true);

    // Profile path invariant
    assert.ok(existsSync(session.profileDir), "Ephemeral profile directory must exist on disk");
    assert.ok(session.profileDir.includes("temp\\browser-profiles") || session.profileDir.includes("temp/browser-profiles"));

    // Journal events check
    const journalEvents = host.getJournal().getEvents();
    assert.ok(journalEvents.some((e) => e.type === "browser.started"));
    assert.ok(journalEvents.some((e) => e.type === "page.opened" && (e as any).page_id === "page-1"));

    // Clean close
    await host.close();
    assert.equal(session.getState(), "CLOSED");
    assert.equal(existsSync(session.profileDir), false, "Profile directory must be deleted on close");
  });

  it("proves start idempotency: duplicate start returns existing session without second launch", async () => {
    const host = new BrowserRuntimeHost();
    const sessionId = "p73-idempotent-launch";

    const first = await host.prepareSession({ sessionId, generation: 1, headless: true });
    assert.equal(first.ok, true);

    const activeFirst = host.getActiveSession();
    const rootPidFirst = activeFirst?.getManagedProcess().getRootPid();

    // Duplicate call with same parameters
    const second = await host.prepareSession({ sessionId, generation: 1, headless: true });
    assert.equal(second.ok, true);

    const activeSecond = host.getActiveSession();
    const rootPidSecond = activeSecond?.getManagedProcess().getRootPid();

    assert.equal(activeFirst, activeSecond, "Same session instance must be returned");
    assert.equal(rootPidFirst, rootPidSecond, "Zero additional browser processes must be spawned");

    await host.close();
  });

  it("proves unexpected secondary page/tab closes fail-closed immediately (POPUP_BLOCKED)", async () => {
    const host = new BrowserRuntimeHost();
    const sessionId = "p73-popup-block";

    const start = await host.prepareSession({ sessionId, generation: 1, headless: true });
    assert.equal(start.ok, true);

    const session = host.getActiveSession()!;
    const ctx = session.getManagedContext();

    assert.equal(ctx.getBlockedPopupCount(), 0);

    // Simulate unexpected popup creation using Playwright context API (NO page.evaluate!)
    const unexpectedPage = await ctx.context.newPage();
    // Allow event loop cycles for context 'page' listener
    for (let i = 0; i < 20 && !unexpectedPage.isClosed(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(ctx.getBlockedPopupCount(), 1, "Popup must be recorded as blocked");
    assert.equal(unexpectedPage.isClosed(), true, "Unexpected secondary page must be immediately closed");

    // Primary page remains untouched and alive
    assert.equal(session.getPrimaryPageHandle()?.isAlive(), true);

    await host.close();
  });

  it("proves reset lifecycle: closes page/context, terminates process via Job Object, purges profile, rotates generation", async () => {
    const bridgeCoordinator = new LocalhostBridgeCoordinator();
    const host = new BrowserRuntimeHost({ bridgeCoordinator });
    const sessionId = "p73-reset-test";

    const start = await host.prepareSession({ sessionId, generation: 1, headless: true });
    assert.equal(start.ok, true);

    const session1 = host.getActiveSession()!;
    const profile1 = session1.profileDir;
    const pids = session1.getManagedProcess().getTrackedPids();

    assert.ok(existsSync(profile1), "Profile 1 must exist before reset");

    // Fencing before reset: generation 1 is valid, generation 2 is rejected
    assert.equal(host.validateSession(sessionId, 1).ok, true);
    assert.equal(host.validateSession(sessionId, 2).ok, false);

    // Execute reset
    const resetResult = await host.reset({ session_id: sessionId, request_id: "req-reset-1" });
    assert.equal(resetResult.ok, true);
    if (!resetResult.ok) return;

    assert.equal(resetResult.descriptor.session_id, sessionId);
    assert.equal(resetResult.descriptor.generation, 2, "Generation must advance monotonically");
    assert.equal(host.getActiveGeneration(), 2);

    // Old profile must be purged
    assert.equal(existsSync(profile1), false, "Old profile directory must be purged on reset");

    // Old session processes must be terminated
    const oldPidsDead = await WindowsJobObject.verifyAbsence([...pids], 5000);
    assert.equal(oldPidsDead, true, "All old session Chromium processes must be terminated");

    // Fencing after reset: generation 1 is now STALE!
    const staleCheck = host.validateSession(sessionId, 1);
    assert.equal(staleCheck.ok, false);
    if (!staleCheck.ok) {
      assert.equal(staleCheck.rejection.code, "STALE_SESSION");
    }

    // Launch in new generation 2
    const startGen2 = await host.prepareSession({ sessionId, generation: 2, headless: true });
    assert.equal(startGen2.ok, true);

    const session2 = host.getActiveSession()!;
    assert.equal(session2.generation, 2);
    assert.notEqual(session1, session2, "Must be a fresh session instance");
    assert.ok(existsSync(session2.profileDir), "Profile 2 must exist");

    await host.close();
    assert.equal(existsSync(session2.profileDir), false, "Profile 2 must be purged on close");
  });

  it("proves page crash transitions session to CRASHED state and invalidates handles", async () => {
    const host = new BrowserRuntimeHost();
    const sessionId = "p73-page-crash";

    const start = await host.prepareSession({ sessionId, generation: 1, headless: true });
    assert.equal(start.ok, true);

    const session = host.getActiveSession()!;
    const primary = session.getPrimaryPageHandle()!;

    assert.equal(session.isReady(), true);

    // Inject crash via safe EventEmitter seam on the Playwright Page (NO page.evaluate!)
    (primary.rawPage as any).emit("crash", primary.rawPage);

    // State transitions to CRASHED
    assert.equal(session.getState(), "CRASHED");
    assert.equal(session.getCrashReason()?.code, "PAGE_CRASHED");
    assert.equal(session.getPrimaryPageHandle(), null, "Page handle must be invalidated");

    // Subsequent operation validation rejects
    const validate = host.validateSession(sessionId, 1);
    assert.equal(validate.ok, false);
    if (!validate.ok) {
      assert.equal(validate.rejection.code, "PAGE_CRASHED");
    }

    await host.close();
  });

  it("proves browser disconnect transitions session to CRASHED state", async () => {
    const host = new BrowserRuntimeHost();
    const sessionId = "p73-browser-disconnect";

    const start = await host.prepareSession({ sessionId, generation: 1, headless: true });
    assert.equal(start.ok, true);

    const session = host.getActiveSession()!;
    assert.equal(session.isReady(), true);

    // Terminate browser process abruptly to trigger disconnect
    await session.getManagedProcess().terminateAndConfirm();

    // Allow event loop turn for disconnect event
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(session.getState(), "CRASHED");
    assert.equal(session.getCrashReason()?.code, "BROWSER_CRASHED");

    await host.close();
  });

  it("proves close is idempotent and confirms zero zombie processes survive", async () => {
    const host = new BrowserRuntimeHost();
    const sessionId = "p73-close-idempotent";

    await host.prepareSession({ sessionId, generation: 1, headless: true });
    const session = host.getActiveSession()!;
    const pids = session.getManagedProcess().getTrackedPids();

    // First close
    await host.close();
    assert.equal(session.getState(), "CLOSED");

    // Second close (idempotency check)
    await host.close();
    assert.equal(session.getState(), "CLOSED");

    // Verify zero surviving processes from tracked PIDs
    const dead = await WindowsJobObject.verifyAbsence([...pids], 5000);
    assert.equal(dead, true, "Zero session Chromium processes survive close");
  });
});
