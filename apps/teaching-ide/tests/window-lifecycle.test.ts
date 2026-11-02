// P5.15 close-lifecycle regression tests — deterministic, no Electron launch,
// no Docker. Reproduces the exact race that raised Electron's Error dialog
// during the final visual runs: result observed -> window closes/teardown
// begins -> a delayed callback fires and touches window.webContents after the
// native object is destroyed ("TypeError: Object has been destroyed").
//
// Expected after the repair: no throw, no destroyed access, exactly-one
// finish, deterministic hold-open lifecycle, cleanup still completes. The
// fakes mimic Electron precisely: once destroyed, the webContents GETTER
// itself throws (not just send/close).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachWindowClosedTeardown,
  captureWebContentsId,
  createFinishOnce,
  findWindowByWebContentsId,
  safeCloseWindow,
  safeGetWindowBounds,
  safeSendToWindow,
  type LifecycleWindow,
} from "../electron/window-lifecycle.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Fake window whose webContents getter throws once destroyed (Electron-exact). */
function makeWindow(id: number): LifecycleWindow & {
  destroy(): void;
  fireClosed(): void;
  closeCalls: number;
  sent: Array<{ channel: string; dto: unknown }>;
  getterCallsAfterDestroy: number;
} {
  let destroyed = false;
  const closedListeners: Array<() => void> = [];
  const fake = {
    closeCalls: 0,
    sent: [] as Array<{ channel: string; dto: unknown }>,
    getterCallsAfterDestroy: 0,
    get webContents() {
      if (destroyed) {
        fake.getterCallsAfterDestroy += 1;
        throw new TypeError("Object has been destroyed");
      }
      return {
        id,
        send(channel: string, dto: unknown) {
          fake.sent.push({ channel, dto });
        },
      };
    },
    isDestroyed() {
      return destroyed;
    },
    once(_event: "closed", listener: () => void) {
      closedListeners.push(listener);
    },
    on(_event: "closed", listener: () => void) {
      closedListeners.push(listener);
    },
    close() {
      fake.closeCalls += 1;
      if (destroyed) throw new TypeError("Object has been destroyed");
      destroyed = true;
      for (const listener of closedListeners.splice(0)) listener();
    },
    getBounds() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return { x: 0, y: 0, width: 1600, height: 900 };
    },
    destroy() {
      destroyed = true;
    },
    fireClosed() {
      for (const listener of closedListeners.splice(0)) listener();
    },
  };
  return fake;
}

describe("window-lifecycle close race (P5.15)", () => {
  it("closed teardown uses the creation-time id and never touches destroyed webContents", () => {
    const win = makeWindow(7);
    const captured = captureWebContentsId(win);
    assert.equal(captured, 7);
    const closedIds: number[] = [];
    const unbound: number[] = [];
    attachWindowClosedTeardown(win, captured, (id) => {
      closedIds.push(id);
      unbound.push(id);
    });
    // Native destruction happens first (Electron-exact); the listener runs after.
    win.destroy();
    assert.doesNotThrow(() => win.fireClosed());
    assert.deepEqual(closedIds, [7]);
    assert.deepEqual(unbound, [7]);
    assert.equal(win.getterCallsAfterDestroy, 0);
  });

  it("result observed -> close begins -> delayed timeout callback is a no-op (exactly-one finish)", () => {
    const win = makeWindow(11);
    const captured = captureWebContentsId(win);
    const prints: unknown[] = [];
    const closedCleanups: number[] = [];
    const finishOnce = createFinishOnce();
    attachWindowClosedTeardown(win, captured, (id) => {
      closedCleanups.push(id);
    });
    // Success path finishes first (result observed, hold-open scheduled).
    const finish = (result: unknown): void => {
      if (!finishOnce()) return;
      prints.push(result);
    };
    finish({ ok: true });
    // Window closes; teardown begins with the captured id.
    win.destroy();
    assert.doesNotThrow(() => win.fireClosed());
    assert.deepEqual(closedCleanups, [11]);
    // A delayed TIMEOUT callback fires after close: must not re-finish,
    // must not throw, must not touch the destroyed window.
    assert.doesNotThrow(() => finish({ ok: false, code: "TIMEOUT" }));
    assert.equal(prints.length, 1);
    assert.deepEqual(prints[0], { ok: true });
    // Post-close window touches stay silent.
    assert.doesNotThrow(() => safeCloseWindow(win));
    assert.equal(safeGetWindowBounds(win), null);
    assert.equal(win.getterCallsAfterDestroy, 0);
    assert.equal(win.closeCalls, 0);
  });

  it("findWindowByWebContentsId skips destroyed windows without dereferencing them", () => {
    const dead1 = makeWindow(1);
    dead1.destroy();
    const live = makeWindow(2);
    const dead3 = makeWindow(3);
    dead3.destroy();
    const found = findWindowByWebContentsId([dead1, live, dead3], 2);
    assert.equal(found, live);
    assert.equal(dead1.getterCallsAfterDestroy, 0);
    assert.equal(dead3.getterCallsAfterDestroy, 0);
    assert.equal(findWindowByWebContentsId([dead1, dead3], 2), undefined);
    assert.equal(findWindowByWebContentsId([], 2), undefined);
  });

  it("createFinishOnce latches exactly one finish", () => {
    const once = createFinishOnce();
    assert.equal(once(), true);
    assert.equal(once(), false);
    assert.equal(once(), false);
  });

  it("safeCloseWindow closes live windows once and never throws", () => {
    const live = makeWindow(5);
    // Closing fires the closed listeners (teardown) exactly like Electron.
    let closedCount = 0;
    live.once("closed", () => {
      closedCount += 1;
    });
    assert.doesNotThrow(() => safeCloseWindow(live));
    assert.equal(live.closeCalls, 1);
    assert.equal(closedCount, 1);
    const dead = makeWindow(6);
    dead.destroy();
    assert.doesNotThrow(() => safeCloseWindow(dead));
    assert.equal(dead.closeCalls, 0);
    assert.doesNotThrow(() => safeCloseWindow(null));
    assert.doesNotThrow(() => safeCloseWindow(undefined));
  });

  it("safeSendToWindow delivers only to live windows and never throws", () => {
    const live = makeWindow(9);
    assert.equal(safeSendToWindow(live, "terminal:event", { seq: 1 }), true);
    assert.deepEqual(live.sent, [{ channel: "terminal:event", dto: { seq: 1 } }]);
    const dead = makeWindow(10);
    dead.destroy();
    assert.equal(safeSendToWindow(dead, "terminal:event", { seq: 2 }), false);
    assert.equal(dead.getterCallsAfterDestroy, 0);
    assert.equal(safeSendToWindow(undefined, "terminal:event", {}), false);
  });

  it("safeGetWindowBounds reads live bounds and nulls after destruction", () => {
    const live = makeWindow(12);
    assert.deepEqual(safeGetWindowBounds(live), { x: 0, y: 0, width: 1600, height: 900 });
    const dead = makeWindow(13);
    dead.destroy();
    assert.equal(safeGetWindowBounds(dead), null);
    assert.equal(safeGetWindowBounds(null), null);
  });

  it("main.ts closed/IPC paths carry no destroy-sensitive webContents access", () => {
    const main = readFileSync(join(here, "..", "electron", "main.ts"), "utf8");
    // The repaired helpers must own every destruction-adjacent touch.
    for (const name of [
      "attachWindowClosedTeardown",
      "createFinishOnce",
      "findWindowByWebContentsId",
      "safeCloseWindow",
      "safeGetWindowBounds",
      "safeSendToWindow",
    ]) {
      assert.ok(main.includes(name), `main.ts must use ${name}`);
    }
    // No direct webContents identity/send reads remain in main wiring: the
    // creation-time capture and the guarded helpers own them instead.
    assert.ok(!main.includes("window.webContents.id"), "main.ts must not read window.webContents.id (capture the id while alive)");
    assert.ok(!main.includes("candidate.webContents"), "main.ts must not dereference candidate.webContents (helpers skip destroyed windows)");
    assert.ok(!main.includes("window.webContents.send"), "main.ts must not send via window.webContents (use the guarded helper)");
  });
});
