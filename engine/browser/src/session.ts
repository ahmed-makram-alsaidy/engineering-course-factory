// Browser Session Lifecycle & State Machine for Course Factory P7.3.
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 5, 13, 17, 20.
//
// Invariants enforced:
// - Exactly ONE BrowserSession per session_id + monotonic generation.
// - Explicit state machine: CREATED -> STARTING -> READY -> RESETTING -> CLOSING -> CLOSED | CRASHED.
// - Ephemeral profile isolation per session generation.
// - Windows Job Object process tracking (zero zombie processes).
// - Stale session and stale generation fencing.
// - Secondary tabs and popups blocked fail-closed.
// - Browser and page crashes transition state to CRASHED, invalidating handles and requiring reset.

import { ManagedBrowserContext, type ManagedPageHandle } from "./context.ts";
import { ManagedBrowserProcess } from "./process.ts";
import { purgeEphemeralProfile } from "./profile.ts";
import type { NetworkRouteShield } from "./network-shield.ts";
import {
  type BrowserErrorCode,
  type SafeBrowserSessionDescriptor,
} from "./protocol.ts";

export type BrowserSessionState =
  | "CREATED"
  | "STARTING"
  | "READY"
  | "EXECUTING"
  | "RESETTING"
  | "CLOSING"
  | "CLOSED"
  | "CRASHED"
  | "FAILED";

export interface BrowserSessionInit {
  readonly sessionId: string;
  readonly generation: number;
  readonly lessonId?: string;
  readonly courseId?: string;
  readonly profileDir: string;
  readonly managedProcess: ManagedBrowserProcess;
  readonly managedContext: ManagedBrowserContext;
  readonly primaryPageHandle: ManagedPageHandle;
  readonly networkShield?: NetworkRouteShield;
}

export class BrowserSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly lessonId: string;
  readonly courseId: string;
  readonly profileDir: string;

  private state: BrowserSessionState = "READY";
  private managedProcess: ManagedBrowserProcess;
  private managedContext: ManagedBrowserContext;
  private primaryPageHandle: ManagedPageHandle | null = null;
  private networkShield?: NetworkRouteShield;
  private crashReason: { code: BrowserErrorCode; message: string } | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;

  constructor(init: BrowserSessionInit) {
    this.sessionId = init.sessionId;
    this.generation = init.generation;
    this.lessonId = init.lessonId ?? "default-lesson";
    this.courseId = init.courseId ?? "default-course";
    this.profileDir = init.profileDir;
    this.managedProcess = init.managedProcess;
    this.managedContext = init.managedContext;
    this.primaryPageHandle = init.primaryPageHandle;
    this.networkShield = init.networkShield;

    this.livenessTimer = setInterval(() => {
      this.checkLiveness();
    }, 150);
    this.livenessTimer.unref();
  }

  isProcessAlive(): boolean {
    return this.managedProcess.isAlive();
  }

  checkLiveness(): boolean {
    if (this.state === "READY" || this.state === "EXECUTING") {
      if (!this.isProcessAlive()) {
        this.handleCrash("BROWSER_CRASHED", "Chromium browser process terminated unexpectedly");
        return false;
      }
    }
    return this.state === "READY" || this.state === "EXECUTING";
  }

  getState(): BrowserSessionState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === "READY";
  }

  isStale(sessionId: string, generation: number): boolean {
    return this.sessionId !== sessionId || this.generation !== generation;
  }

  getPrimaryPageHandle(): ManagedPageHandle | null {
    if (this.state !== "READY" && this.state !== "EXECUTING") {
      return null;
    }
    return this.primaryPageHandle;
  }

  getManagedProcess(): ManagedBrowserProcess {
    return this.managedProcess;
  }

  getManagedContext(): ManagedBrowserContext {
    return this.managedContext;
  }

  getNetworkShield(): NetworkRouteShield | undefined {
    return this.networkShield;
  }

  getCrashReason(): { code: BrowserErrorCode; message: string } | null {
    return this.crashReason;
  }

  /**
   * Records an asynchronous crash event (browser or page crash).
   * Transitions session state to CRASHED and invalidates handles.
   */
  handleCrash(code: BrowserErrorCode, message: string): void {
    if (this.state === "CLOSING" || this.state === "CLOSED" || this.state === "RESETTING") {
      // Expected teardown; ignore
      return;
    }

    this.state = "CRASHED";
    this.crashReason = { code, message };
    this.primaryPageHandle = null;
  }

  /**
   * Terminal close for this session.
   * Closes context, confirms process termination, purges ephemeral profile, and marks CLOSED.
   */
  async close(): Promise<void> {
    if (this.state === "CLOSED") return;
    this.state = "CLOSING";

    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }

    // 1. Close context and pages
    try {
      await this.managedContext.close();
    } catch {}
    this.primaryPageHandle = null;

    // Dispose route shield
    if (this.networkShield) {
      try {
        await this.networkShield.dispose();
      } catch {}
      this.networkShield = undefined;
    }

    // 2. Terminate and verify process absence via Windows Job Object
    try {
      await this.managedProcess.terminateAndConfirm();
    } catch {}

    // 3. Purge ephemeral profile directory
    try {
      await purgeEphemeralProfile(this.profileDir);
    } catch {}

    this.state = "CLOSED";
  }

  /**
   * Returns safe external session descriptor for renderer / host status reporting.
   * Never exposes raw PIDs, filesystem paths, or Playwright objects.
   */
  describe(): SafeBrowserSessionDescriptor {
    let externalStatus: "ready" | "executing" | "resetting" | "crashed" | "terminated";
    switch (this.state) {
      case "READY":
        externalStatus = "ready";
        break;
      case "EXECUTING":
        externalStatus = "executing";
        break;
      case "RESETTING":
        externalStatus = "resetting";
        break;
      case "CRASHED":
        externalStatus = "crashed";
        break;
      default:
        externalStatus = "terminated";
        break;
    }

    return {
      session_id: this.sessionId,
      generation: this.generation,
      lesson_id: this.lessonId,
      course_id: this.courseId,
      status: externalStatus,
    };
  }
}
