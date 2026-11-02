// P5.15 close-lifecycle repair (found by the final visual runs, not by mocks:
// an uncaught "TypeError: Object has been destroyed" from main touched a
// BrowserWindow/webContents after destruction, raising Electron's Error
// dialog and stalling quit).
//
// Rules encoded here (design "Stop / Cleanup": teardown is authoritative and
// must never crash the host):
//   - capture webContents ids ONLY while the window is alive (creation/bind);
//   - never dereference window.webContents inside "closed" or after destroy;
//   - guard every BrowserWindow/webContents touch with isDestroyed() checks;
//   - finish each smoke lifecycle exactly once (late callbacks are no-ops);
//   - cancel pending timers/pollers on close;
//   - teardown is idempotent.
//
// This module imports NOTHING (no electron import): it speaks structural
// interfaces so node --test suites can reproduce the destruction race with
// fakes whose webContents getter throws exactly like Electron's.

/** Minimal structural surface used by the lifecycle helpers. */
export interface LifecycleWebContents {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
}

/** Minimal structural surface of a tearing-down window. */
export interface LifecycleWindow {
  readonly webContents: LifecycleWebContents;
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): void;
  on(event: "closed", listener: () => void): void;
  close(): void;
  getBounds(): { x: number; y: number; width: number; height: number };
}

/** True only when the handle may still be touched (never throws). */
export function isWindowUsable(window: LifecycleWindow | null | undefined): boolean {
  try {
    return window !== null && window !== undefined && !window.isDestroyed();
  } catch {
    return false;
  }
}

/**
 * Read the webContents id. Call ONLY while the window is alive (creation or
 * bind time). The id is a plain number and stays valid for owner binding
 * after the window is gone.
 */
export function captureWebContentsId(window: LifecycleWindow): number {
  return window.webContents.id;
}

/**
 * Attach the post-close teardown WITHOUT retaining a destroy-sensitive
 * path: the listener closes over the creation-time id only and never touches
 * window.webContents (which throws once the native object is destroyed).
 */
export function attachWindowClosedTeardown(
  window: LifecycleWindow,
  webContentsId: number,
  onClosed: (webContentsId: number) => void,
): void {
  window.once("closed", () => {
    onClosed(webContentsId);
  });
}

/**
 * Find the live owner window by webContents id. Destroyed windows (whose
 * webContents getter throws, exactly like Electron post-destruction) are
 * skipped — never dereferenced — and a throwing candidate can never break
 * the search.
 */
export function findWindowByWebContentsId(
  windows: readonly LifecycleWindow[],
  webContentsId: number,
): LifecycleWindow | undefined {
  for (const candidate of windows) {
    try {
      if (candidate.isDestroyed()) continue;
      if (candidate.webContents.id === webContentsId) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Push a DTO only when the target window is still alive (never throws). */
export function safeSendToWindow(
  window: LifecycleWindow | undefined,
  channel: string,
  dto: unknown,
): boolean {
  try {
    if (!isWindowUsable(window)) return false;
    window!.webContents.send(channel, dto);
    return true;
  } catch {
    return false;
  }
}

/** Close only when alive; a throwing close is swallowed (quit proceeds). */
export function safeCloseWindow(window: LifecycleWindow | null | undefined): void {
  try {
    if (!isWindowUsable(window)) return;
    window!.close();
  } catch {
    // A close racing destruction must never crash the host.
  }
}

/** Read bounds only when alive; null after destruction (never throws). */
export function safeGetWindowBounds(
  window: LifecycleWindow | null | undefined,
): { x: number; y: number; width: number; height: number } | null {
  try {
    if (!isWindowUsable(window)) return null;
    return window!.getBounds();
  } catch {
    return null;
  }
}

/** First call wins (true); every later call is a no-op (false). */
export function createFinishOnce(): () => boolean {
  let finished = false;
  return () => {
    if (finished) return false;
    finished = true;
    return true;
  };
}
