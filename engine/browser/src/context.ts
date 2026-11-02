// Browser Context Configuration, Single Primary Page & Lifecycle Listeners for Course Factory P7.3.
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 5, 13, 15, 20.
//
// Invariants enforced:
// - Exactly ONE ephemeral BrowserContext per BrowserSession.
// - Exactly ONE primary BrowserPage per session (tracked via opaque page_id).
// - Default deny permissions (no camera, mic, geolocation, notifications, clipboard).
// - Secondary tabs and popups FAIL CLOSED: immediately closed with POPUP_BLOCKED recorded.
// - Unexpected dialogs (alert/confirm/prompt) auto-dismiss fail-closed to prevent automation hangs.
// - Tab crashes (page.on('crash')) trigger PAGE_CRASHED and invalidate page handle.

import type { BrowserContext, Page, Dialog } from "playwright-core";
import {
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  type BrowserErrorCode,
} from "./protocol.ts";

export interface ManagedPageOptions {
  readonly pageId: string;
  readonly onPageCrash: (code: BrowserErrorCode, message: string) => void;
  readonly onPopupBlocked: (url?: string) => void;
  readonly onDialogDismissed?: (type: string, message: string) => void;
}

export interface ManagedPageHandle {
  readonly pageId: string;
  readonly rawPage: Page;
  isAlive(): boolean;
  close(): Promise<void>;
}

export class ManagedBrowserContext {
  readonly context: BrowserContext;
  private primaryPageHandle: ManagedPageHandle | null = null;
  private blockedPopupCount = 0;
  private isDisposed = false;

  constructor(context: BrowserContext) {
    this.context = context;
  }

  /**
   * Configures and binds the single primary page for this session.
   * Attaches popup, dialog, and crash listeners.
   */
  async attachPrimaryPage(rawPage: Page, options: ManagedPageOptions): Promise<ManagedPageHandle> {
    if (this.primaryPageHandle) {
      throw new Error("[DUPLICATE_PRIMARY_PAGE] Context already has an active primary page");
    }

    let isPageAlive = true;

    // 1. Crash handler
    rawPage.on("crash", () => {
      isPageAlive = false;
      options.onPageCrash("PAGE_CRASHED", "Page renderer process crashed unexpectedly");
    });

    // 2. Dialog auto-dismiss (fail-closed)
    rawPage.on("dialog", async (dialog: Dialog) => {
      try {
        const type = dialog.type();
        const msg = dialog.message();
        await dialog.dismiss();
        options.onDialogDismissed?.(type, msg);
      } catch {}
    });

    // 3. Popup interceptor on page
    rawPage.on("popup", async (popup: Page) => {
      this.blockedPopupCount++;
      try {
        const url = popup.url();
        await popup.close();
        options.onPopupBlocked(url);
      } catch {}
    });

    // 4. Secondary page interceptor on context (catches any target="_blank" or window.open)
    this.context.on("page", async (extraPage: Page) => {
      if (extraPage !== rawPage) {
        this.blockedPopupCount++;
        try {
          const url = extraPage.url();
          await extraPage.close();
          options.onPopupBlocked(url);
        } catch {}
      }
    });

    const handle: ManagedPageHandle = {
      pageId: options.pageId,
      rawPage,
      isAlive: () => isPageAlive && !rawPage.isClosed(),
      close: async () => {
        if (!rawPage.isClosed()) {
          try {
            await rawPage.close();
          } catch {}
        }
        isPageAlive = false;
      },
    };

    this.primaryPageHandle = handle;
    return handle;
  }

  getPrimaryPage(): ManagedPageHandle | null {
    return this.primaryPageHandle;
  }

  getBlockedPopupCount(): number {
    return this.blockedPopupCount;
  }

  async close(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.primaryPageHandle) {
      await this.primaryPageHandle.close();
      this.primaryPageHandle = null;
    }

    try {
      await Promise.race([
        this.context.close(),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    } catch {}
  }
}
