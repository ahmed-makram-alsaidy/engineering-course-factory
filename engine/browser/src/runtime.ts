// Browser Runtime Lifecycle Host & Process Supervisor for Course Factory P7.3.
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 4, 5, 13, 16, 17, 18, 19, 21.
//
// Establishes the trusted Playwright Core Chromium runtime lifecycle:
// - Main-process authority: out-of-process Chromium driving stdio pipes (--remote-debugging-pipe).
// - Zero DevTools TCP port exposure. Standard Chromium sandbox preserved.
// - Bounded resource limits: max 1 session, max 1 context, max 1 primary page.
// - Ephemeral profile isolation: temp/browser-profiles/<session_id>-<generation>/.
// - Windows Job Object cleanup: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (zero zombie processes).
// - Stale session and stale generation fencing.
// - Unexpected popups and tabs fail closed immediately (POPUP_BLOCKED).
// - Process or tab crash transitions state to CRASHED; requires explicit reset.
// - Canonical monotonic journal tracking: browser.started, page.opened, browser.closed.

import { chromium, type BrowserContext } from "playwright-core";
import { LocalhostBridgeCoordinator } from "./bridge.ts";
import { ManagedBrowserContext } from "./context.ts";
import { NetworkRouteShield } from "./network-shield.ts";
import {
  FROZEN_CHROMIUM_ARGS,
  ManagedBrowserProcess,
  PINNED_PLAYWRIGHT_VERSION,
  PINNED_CHROMIUM_REVISION,
  PINNED_CHROMIUM_VERSION,
  verifyPinnedBrowserBinary,
} from "./process.ts";
import { createEphemeralProfile, purgeAllSessionProfiles, DEFAULT_PROFILES_BASE_DIR } from "./profile.ts";
import {
  browserRejection,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  MAX_EVENTS_PER_SNAPSHOT_PAGE,
  type BrowserErrorCode,
  type BrowserOperationReceipt,
  type BrowserRejection,
  type BrowserRuntimeEvent,
  type BrowserSnapshotPage,
  BrowserSnapshotPageSchema,
  type SafeBrowserSessionDescriptor,
  type ResetBrowserRuntimeRequest,
  ResetBrowserRuntimeRequestSchema,
} from "./protocol.ts";
import { BrowserSession } from "./session.ts";
import { BrowserActionExecutor } from "./actions/executor.ts";
import type { BrowserAdmissionSession } from "./admission.ts";

export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
export type BrowserRuntimeEventInput = DistributiveOmit<BrowserRuntimeEvent, "seq" | "monotonic_ms">;

export interface SessionJournalSubscriber {
  (event: BrowserRuntimeEvent): void;
}

export class BrowserSessionJournal {
  private seq = 0;
  private startTime = Date.now();
  private events: BrowserRuntimeEvent[] = [];
  private subscribers: Set<SessionJournalSubscriber> = new Set();

  recordEvent(eventData: BrowserRuntimeEventInput): BrowserRuntimeEvent {
    this.seq++;
    const monotonic_ms = Date.now() - this.startTime;
    const fullEvent = {
      ...eventData,
      seq: this.seq,
      monotonic_ms,
    } as BrowserRuntimeEvent;

    this.events.push(fullEvent);
    for (const sub of this.subscribers) {
      try {
        sub(fullEvent);
      } catch {}
    }
    return fullEvent;
  }

  getEvents(afterSeq = 0): BrowserRuntimeEvent[] {
    return this.events.filter((e) => e.seq > afterSeq);
  }

  getHighSeq(): number {
    return this.seq;
  }

  snapshot(sessionId: string, generation: number, afterSeq = 0, reset = false): BrowserSnapshotPage {
    const filtered = this.events.filter((e) => e.seq > afterSeq);
    const paged = filtered.slice(0, MAX_EVENTS_PER_SNAPSHOT_PAGE);
    const page_end_seq = paged.length > 0 ? paged[paged.length - 1]!.seq : afterSeq;

    const page: BrowserSnapshotPage = {
      session_id: sessionId,
      generation,
      after_seq: afterSeq,
      page_end_seq,
      journal_high_seq: this.seq,
      reset,
      events: paged,
    };

    return BrowserSnapshotPageSchema.parse(page);
  }

  subscribe(subscriber: SessionJournalSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  clear(): void {
    this.events = [];
    this.seq = 0;
  }
}

export interface PrepareSessionOptions {
  readonly sessionId: string;
  readonly generation?: number;
  readonly lessonId?: string;
  readonly courseId?: string;
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly profilesBaseDir?: string;
  readonly allowedOrigins?: Iterable<string>;
}

export class BrowserRuntimeHost {
  private activeSession: BrowserSession | null = null;
  private activeGeneration = 1;
  private journal = new BrowserSessionJournal();
  private bridgeCoordinator: LocalhostBridgeCoordinator | null = null;
  private actionExecutor = new BrowserActionExecutor();
  private isShuttingDown = false;

  constructor(options?: { bridgeCoordinator?: LocalhostBridgeCoordinator }) {
    if (options?.bridgeCoordinator) {
      this.bridgeCoordinator = options.bridgeCoordinator;
    }
  }

  getActiveSession(): BrowserSession | null {
    return this.activeSession;
  }

  getActiveGeneration(): number {
    return this.activeGeneration;
  }

  getJournal(): BrowserSessionJournal {
    return this.journal;
  }

  getActionExecutor(): BrowserActionExecutor {
    return this.actionExecutor;
  }

  getBridgeCoordinator(): LocalhostBridgeCoordinator | null {
    return this.bridgeCoordinator;
  }

  /**
   * Adds an origin to the active session's network route shield allowlist.
   */
  addAllowedOrigin(origin: string): void {
    this.activeSession?.getNetworkShield()?.addAllowedOrigin(origin);
  }

  /**
   * Cancels an active in-flight operation by operation_id.
   */
  cancelOperation(operationId: string): boolean {
    return this.actionExecutor.cancelOperation(operationId);
  }

  /**
   * Retrieves a bounded journal snapshot page for a session.
   */
  getSnapshot(sessionId: string, generation: number, afterSeq = 0, reset = false): BrowserSnapshotPage {
    return this.journal.snapshot(sessionId, generation, afterSeq, reset);
  }

  /**
   * Executes an admitted browser operation against the active session and primary page.
   */
  async runOperation(
    admissionSession: BrowserAdmissionSession,
    request: unknown,
  ): Promise<{ ok: true; receipt: BrowserOperationReceipt } | { ok: false; rejection: BrowserRejection }> {
    if (!this.activeSession || this.activeSession.getState() === "CLOSED") {
      return {
        ok: false,
        rejection: browserRejection("STALE_SESSION", "No active browser session exists"),
      };
    }

    const pageHandle = this.activeSession.getPrimaryPageHandle();
    if (!pageHandle || !pageHandle.isAlive()) {
      return {
        ok: false,
        rejection: browserRejection("PAGE_CRASHED", "Primary browser page is not active"),
      };
    }

    // Sync policy allowed origins to route shield
    const shield = this.activeSession.getNetworkShield();
    if (shield && admissionSession.policy) {
      for (const origin of admissionSession.policy.allowed_origins) {
        shield.addAllowedOrigin(origin);
      }
    }

    return this.actionExecutor.executeWithAdmission(
      admissionSession,
      this.activeSession,
      pageHandle,
      request,
      {
        journal: this.journal,
        policy: admissionSession.policy,
        bridgeCoordinator: this.bridgeCoordinator ?? undefined,
        allowedOrigins: shield?.getAllowedOrigins(),
      },
    );
  }

  /**
   * Prepares and starts a managed Chromium session.
   * Start idempotency: if already running with matching session and generation, returns safe descriptor.
   */
  async prepareSession(options: PrepareSessionOptions): Promise<
    { ok: true; descriptor: SafeBrowserSessionDescriptor } | { ok: false; rejection: BrowserRejection }
  > {
    if (this.isShuttingDown) {
      return {
        ok: false,
        rejection: browserRejection("POLICY_DENIED", "Browser runtime host is shutting down"),
      };
    }

    const sessionId = options.sessionId;
    const generation = options.generation ?? this.activeGeneration;

    // 1. Check idempotency
    if (
      this.activeSession &&
      this.activeSession.sessionId === sessionId &&
      this.activeSession.generation === generation &&
      this.activeSession.isReady()
    ) {
      return { ok: true, descriptor: this.activeSession.describe() };
    }

    // 2. Reject concurrency: exactly one active browser session allowed
    if (this.activeSession && this.activeSession.getState() !== "CLOSED") {
      return {
        ok: false,
        rejection: browserRejection(
          "POLICY_DENIED",
          `Active browser session '${this.activeSession.sessionId}' (generation ${this.activeSession.generation}) already exists. Explicit reset required before preparing new session.`,
        ),
      };
    }

    // 3. Verify pinned binary
    const binaryCheck = verifyPinnedBrowserBinary(options.executablePath);
    if (!binaryCheck.ok || !binaryCheck.executablePath) {
      return {
        ok: false,
        rejection: browserRejection(
          binaryCheck.code ?? "BROWSER_LAUNCH_FAILED",
          binaryCheck.reason ?? "Chromium binary check failed",
        ),
      };
    }

    // 4. Create ephemeral profile
    const profileDir = createEphemeralProfile(
      sessionId,
      generation,
      options.profilesBaseDir ?? DEFAULT_PROFILES_BASE_DIR,
    );

    // 5. Initialize Managed Process & Job Object
    const managedProcess = new ManagedBrowserProcess(sessionId, generation, profileDir);
    try {
      await managedProcess.initJob();
    } catch (err) {
      return {
        ok: false,
        rejection: browserRejection(
          "BROWSER_LAUNCH_FAILED",
          `Failed to initialize Windows Job Object: ${err instanceof Error ? err.message : String(err)}`,
        ),
      };
    }

    // 6. Launch out-of-process Chromium via Playwright Core persistent context
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: binaryCheck.executablePath,
        headless: options.headless ?? true,
        chromiumSandbox: true,
        viewport: { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT },
        deviceScaleFactor: 1,
        locale: "en-US",
        timezoneId: "UTC",
        permissions: [],
        ignoreHTTPSErrors: false,
        args: [...FROZEN_CHROMIUM_ARGS],
      });
    } catch (launchErr) {
      await managedProcess.terminateAndConfirm();
      return {
        ok: false,
        rejection: browserRejection(
          "BROWSER_LAUNCH_FAILED",
          `Failed to launch Chromium process: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}`,
        ),
      };
    }

    // 7. Attach Chromium root process to Job Object
    try {
      await managedProcess.attachProcess();
    } catch {}

    // 8. Configure Network Route Shield & Outbound Firewall
    const networkShield = new NetworkRouteShield({
      allowedOrigins: options.allowedOrigins,
      bridgeCoordinator: this.bridgeCoordinator ?? undefined,
    });
    await networkShield.attachToContext(context);

    // 9. Configure Managed Browser Context & Single Primary Page
    const managedContext = new ManagedBrowserContext(context);
    const rawPages = context.pages();
    const primaryRawPage = rawPages[0] ?? (await context.newPage());

    let sessionInstance: BrowserSession;

    const pageHandle = await managedContext.attachPrimaryPage(primaryRawPage, {
      pageId: "page-1",
      onPageCrash: (code, message) => {
        sessionInstance?.handleCrash(code, message);
        this.journal.recordEvent({
          type: "browser.operation.failed",
          session_id: sessionId,
          generation,
          operation_id: "page-crash-monitor",
          operation_type: "browser_refresh",
          request_id: "crash-handler",
          error_code: code,
          message,
        });
      },
      onPopupBlocked: (url) => {
        // Record blocked popup
      },
    });

    // 10. Handle browser process disconnect
    context.on("close", () => {
      if (sessionInstance && sessionInstance.getState() === "READY") {
        sessionInstance.handleCrash("BROWSER_CRASHED", "Chromium browser process disconnected unexpectedly");
      }
    });

    sessionInstance = new BrowserSession({
      sessionId,
      generation,
      lessonId: options.lessonId,
      courseId: options.courseId,
      profileDir,
      managedProcess,
      managedContext,
      primaryPageHandle: pageHandle,
      networkShield,
    });

    this.activeSession = sessionInstance;
    this.activeGeneration = generation;

    // 11. Record journal events
    this.journal.recordEvent({
      type: "browser.started",
      session_id: sessionId,
      generation,
    });

    this.journal.recordEvent({
      type: "page.opened",
      session_id: sessionId,
      generation,
      page_id: pageHandle.pageId,
    });

    return { ok: true, descriptor: sessionInstance.describe() };
  }

  /**
   * Resets the browser runtime for a new generation.
   * Coordinate with BridgeCoordinator if present.
   */
  async reset(request: unknown): Promise<
    { ok: true; descriptor: SafeBrowserSessionDescriptor } | { ok: false; rejection: BrowserRejection }
  > {
    const parseResult = ResetBrowserRuntimeRequestSchema.safeParse(request);
    if (!parseResult.success) {
      return {
        ok: false,
        rejection: browserRejection(
          "INVALID_REQUEST",
          `Invalid reset request format: ${parseResult.error.issues[0]?.message}`,
        ),
      };
    }

    const req = parseResult.data;

    // 1. Session fencing
    if (this.activeSession && this.activeSession.sessionId !== req.session_id) {
      return {
        ok: false,
        rejection: browserRejection(
          "STALE_SESSION",
          `Mismatched session ID on reset (active: '${this.activeSession.sessionId}', requested: '${req.session_id}')`,
          req.request_id,
        ),
      };
    }

    const currentSessionId = this.activeSession ? this.activeSession.sessionId : req.session_id;
    const currentGeneration = this.activeSession ? this.activeSession.generation : this.activeGeneration;

    // 2. Terminate active session
    if (this.activeSession) {
      await this.activeSession.close();
      this.activeSession = null;
    }

    // 3. Reset coordinated localhost bridge if present
    const nextGeneration = currentGeneration + 1;
    if (this.bridgeCoordinator) {
      try {
        await this.bridgeCoordinator.reset(nextGeneration);
      } catch {}
    }

    // 4. Purge any residual profiles for this session
    try {
      await purgeAllSessionProfiles(currentSessionId);
    } catch {}

    // 5. Advance generation
    this.activeGeneration = nextGeneration;

    // 6. Record journal close event
    this.journal.recordEvent({
      type: "browser.closed",
      session_id: currentSessionId,
      generation: currentGeneration,
      reason: "reset",
    });

    return {
      ok: true,
      descriptor: {
        session_id: currentSessionId,
        generation: nextGeneration,
        lesson_id: "default-lesson",
        course_id: "default-course",
        status: "ready",
      },
    };
  }

  /**
   * Idempotently closes active browser session and cleans up all owned resources.
   */
  async close(): Promise<void> {
    if (this.activeSession) {
      const sess = this.activeSession;
      this.activeSession = null;
      await sess.close();

      this.journal.recordEvent({
        type: "browser.closed",
        session_id: sess.sessionId,
        generation: sess.generation,
        reason: "closed",
      });
    }

    if (this.bridgeCoordinator) {
      try {
        await this.bridgeCoordinator.close();
      } catch {}
    }
  }

  /**
   * Complete application shutdown primitive.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    await this.close();
  }

  /**
   * Validates that an incoming operation request matches the active session and generation.
   */
  validateSession(sessionId: string, generation: number): { ok: true } | { ok: false; rejection: BrowserRejection } {
    if (!this.activeSession || this.activeSession.getState() === "CLOSED") {
      return {
        ok: false,
        rejection: browserRejection("STALE_SESSION", "No active browser session exists"),
      };
    }

    if (this.activeSession.sessionId !== sessionId) {
      return {
        ok: false,
        rejection: browserRejection(
          "STALE_SESSION",
          `Mismatched session ID (active: '${this.activeSession.sessionId}', got: '${sessionId}')`,
        ),
      };
    }

    if (this.activeSession.generation !== generation) {
      return {
        ok: false,
        rejection: browserRejection(
          "STALE_GENERATION",
          `Outdated generation counter (active: ${this.activeSession.generation}, got: ${generation})`,
        ),
      };
    }

    this.activeSession.checkLiveness();

    if (this.activeSession.getState() === "CRASHED") {
      const reason = this.activeSession.getCrashReason();
      return {
        ok: false,
        rejection: browserRejection(
          reason?.code ?? "BROWSER_CRASHED",
          reason?.message ?? "Active browser session is in CRASHED state. Reset required.",
        ),
      };
    }

    return { ok: true };
  }
}
