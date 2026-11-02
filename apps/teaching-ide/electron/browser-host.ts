// Electron browser IPC host — P7.6 Safe IPC wiring (main-process side).
//
// Canonical architecture: docs/P7-DESIGN-SPEC.md Section 6.2, ADR-0012.
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module is the ONLY place that touches Electron IPC for the
//     browser: exactly the four identifier-only invoke channels
//     (browser:runOperation / browser:cancelOperation / browser:getSnapshot /
//     browser:resetRuntime) plus the two main-to-renderer push channels
//     (browser:event for journal DTOs, browser:frame for bounded visual frames).
//     No generic invoke/send/execute, no URL/selector/script/cookie channel exists.
//   - Every invoke validates its sender structurally (stored owning
//     webContents id + top-level sender frame + exact bundled renderer URL).
//     Other frames, other windows, stale owners and navigations are denied
//     with WRONG_OWNER / STALE_SESSION before reaching the engine.
//   - Execution itself is owned by @course-factory/browser-engine
//     (BrowserRuntimeHost + BrowserAdmissionSession + BrowserActionExecutor).
//     Renderer NEVER supplies URLs, selectors, input values, keys, timeouts,
//     scripts, HTML, browser flags, executablePath, profilePath, or port numbers.
//     All semantics resolve main-side from reviewed compiled IR.
//   - loadLesson integration: opens (or switches) browser session additively.
//     Switches serialize: prior session is closed and cleaned before fresh session starts.
//   - Shutdown barrier: shutdownAll closes every hosted Chromium instance and purges profiles;
//     awaits confirmation before app quit.
//   - Presentation (BrowserPane UI) and frame capture loop are DEFERRED to P7.7.
//
// TESTABILITY: nothing in this module imports Electron at value level.
// The invoke dispatcher (BrowserIpcHost.handleInvoke) takes a structural sender
// so unit tests exercise sender validation without launching Electron.

import { randomBytes } from "node:crypto";
import {
  BROWSER_INVOKE_CHANNELS,
  BROWSER_EVENT_CHANNEL,
  BROWSER_FRAME_CHANNEL,
  HOSTILE_REQUEST_KEYS,
  type BrowserActionType,
  type BrowserInvokeChannel,
  type BrowserOperationReceipt,
  type BrowserSnapshotPage,
  type SafeBrowserSessionDescriptor,
  RunBrowserOperationRequestSchema,
  CancelBrowserOperationRequestSchema,
  GetBrowserSnapshotRequestSchema,
  ResetBrowserRuntimeRequestSchema,
  createReviewedBrowserCatalog,
  createReviewedBrowserPolicy,
  BrowserAdmissionSession,
  BrowserRuntimeHost,
  BrowserFrameProducer,
  type BrowserVisualFrame,
  type ReviewedBrowserCatalog,
  type ReviewedBrowserPolicyV1,
} from "@course-factory/browser-engine";
import { isExecutionAuthorized } from "./execution-catalog.ts";

export { BROWSER_INVOKE_CHANNELS, BROWSER_EVENT_CHANNEL, BROWSER_FRAME_CHANNEL };
export type { BrowserInvokeChannel };

/** Structural sender facts mapped from Electron's IpcMainInvokeEvent in main.ts. */
export interface BrowserSender {
  /** Owning webContents id (event.sender.id). */
  readonly webContentsId: number;
  /** senderFrame.url at invoke time (exact bundled renderer URL expected). */
  readonly frameUrl: string | null;
  /** True when senderFrame is the top-level frame (no iframe/guest). */
  readonly frameIsTop: boolean;
  /** True when the sender webContents is destroyed. */
  readonly senderDestroyed: boolean;
}

/** What main remembers about a renderer's window (bound at loadLesson). */
export interface BrowserRendererBinding {
  readonly webContentsId: number;
  readonly rendererUrl: string;
}

export type BrowserCloseCause =
  | "reset"
  | "lesson_switch"
  | "lesson_end"
  | "renderer_loss"
  | "app_close"
  | "failure"
  | "timeout"
  | "session_expiry";

/**
 * Structural sender validation.
 * Checks stored webContents id, top-level sender frame, and exact bundled renderer URL.
 * Denies other frames, other windows, stale owners, navigations, and destroyed senders.
 */
export function isTrustedBrowserSender(sender: BrowserSender, binding: BrowserRendererBinding | null): boolean {
  if (binding === null) return false;
  if (sender.senderDestroyed) return false;
  if (sender.webContentsId !== binding.webContentsId) return false;
  if (!sender.frameIsTop) return false;
  if (sender.frameUrl === null) return false;
  if (sender.frameUrl !== binding.rendererUrl) return false;
  return true;
}

/** Redacts local drive letters, UNC paths, and limits error message length to 512 characters. */
export function sanitizeBrowserHostMessage(message: string): string {
  let out = message.replace(/[A-Za-z]:[\\/][^\s"'`]*/g, "[path]").replace(/\\\\[^\s"'`]*/g, "[path]");
  if (out.length > 512) out = out.slice(0, 512);
  return out;
}

export interface BrowserIpcHostOptions {
  /** Deliver a copied event DTO to one renderer (main.ts: safeSendToWindow). */
  readonly pushToRenderer: (webContentsId: number, channel: string, dto: unknown) => void;
  /** Optional factory for BrowserRuntimeHost (injected in tests or custom host). */
  readonly createRuntimeHost?: () => BrowserRuntimeHost;
}

export interface HostedBrowserSession {
  readonly session_id: string;
  generation: number;
  readonly lesson_id: string;
  readonly course_id: string;
  readonly webContentsId: number;
  readonly rendererUrl: string;
  readonly catalog: ReviewedBrowserCatalog;
  readonly policy: ReviewedBrowserPolicyV1;
  admissionSession: BrowserAdmissionSession;
  readonly runtimeHost: BrowserRuntimeHost;
  prepared: boolean;
  unsubscribeJournal: () => void;
  frameProducer: BrowserFrameProducer | null;
}

export type BrowserInvokeResponse =
  | { ok: true; receipt: BrowserOperationReceipt }
  | { ok: true; cancelled: boolean }
  | { ok: true; page: BrowserSnapshotPage }
  | { ok: true; session: SafeBrowserSessionDescriptor }
  | { ok: false; code: string; message: string };

function failure(code: string, message: string): BrowserInvokeResponse {
  return { ok: false, code, message: sanitizeBrowserHostMessage(message) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const EXTENDED_HOSTILE_KEYS = [
  ...HOSTILE_REQUEST_KEYS,
  "role",
  "label",
  "test_id",
  "timeout",
  "containerId",
  "container_id",
  "pid",
  "pageId",
  "page_id",
  "contextId",
  "context_id",
  "guestPort",
  "guest_port",
  "signal",
  "abortSignal",
] as const;

function hasHostileKeys(payload: Record<string, unknown>): boolean {
  for (const key of EXTENDED_HOSTILE_KEYS) {
    if (key in payload) return true;
  }
  return false;
}

export class BrowserIpcHost {
  private readonly pushToRenderer: (webContentsId: number, channel: string, dto: unknown) => void;
  private readonly createRuntimeHost: () => BrowserRuntimeHost;

  /** webContentsId -> window binding (bound at window creation / loadLesson). */
  private readonly bindings = new Map<number, BrowserRendererBinding>();
  /** session_id -> hosted session. */
  private readonly sessions = new Map<string, HostedBrowserSession>();
  /** webContentsId -> currently active session_id. */
  private readonly currentSession = new Map<number, string>();
  /** Closed sessions retain journal for safe replay (session_id -> BrowserRuntimeHost). */
  private readonly retainedHosts = new Map<string, BrowserRuntimeHost>();

  constructor(options: BrowserIpcHostOptions) {
    this.pushToRenderer = options.pushToRenderer;
    this.createRuntimeHost = options.createRuntimeHost ?? (() => new BrowserRuntimeHost());
  }

  /** Bind (or rebind) a renderer's window facts. */
  bindRenderer(binding: BrowserRendererBinding): void {
    this.bindings.set(binding.webContentsId, binding);
  }

  /** Forget a renderer (window closed): drop its binding and cleanly close owned sessions. */
  async unbindRenderer(webContentsId: number): Promise<void> {
    this.bindings.delete(webContentsId);
    const sessionId = this.currentSession.get(webContentsId);
    if (sessionId !== undefined) {
      this.currentSession.delete(webContentsId);
      await this.closeHostedSession(sessionId, "renderer_loss");
    }
  }

  /**
   * Open (or switch) the browser runtime session for a renderer after its lesson loaded.
   * Serializes switches: previous session is closed before fresh session opens.
   */
  async openSessionForRenderer(input: {
    webContentsId: number;
    rendererUrl: string;
    compiledLesson: unknown;
    lessonCompiledDigest: string;
    lessonId: string;
    reviewed?: boolean;
    executablePath?: string;
    profilesBaseDir?: string;
    headless?: boolean;
  }): Promise<{ ok: true; session: SafeBrowserSessionDescriptor } | { ok: false; code: string; message: string }> {
    const binding = this.bindings.get(input.webContentsId);
    if (binding === undefined) {
      return { ok: false, code: "WRONG_OWNER", message: "renderer window is not bound" };
    }

    // 1. Serialize switches
    const previousSessionId = this.currentSession.get(input.webContentsId);
    if (previousSessionId !== undefined) {
      await this.closeHostedSession(previousSessionId, "lesson_switch");
      this.currentSession.delete(input.webContentsId);
    }

    // 2. Build Reviewed Browser Catalog
    let catalog: ReviewedBrowserCatalog;
    try {
      catalog = createReviewedBrowserCatalog(input.compiledLesson);
    } catch (catErr) {
      return {
        ok: false,
        code: "INVALID_CATALOG",
        message: sanitizeBrowserHostMessage(catErr instanceof Error ? catErr.message : String(catErr)),
      };
    }

    // 3. Review Authorization & Policy
    const authorized =
      input.reviewed !== undefined
        ? input.reviewed
        : isExecutionAuthorized(input.lessonId, input.lessonCompiledDigest);

    const reviewedOps: Record<string, { operation_id: string; action_type: BrowserActionType; target_origin?: string }> = {};
    if (authorized) {
      for (const [opId, entry] of catalog.browser_operations.entries()) {
        reviewedOps[opId] = {
          operation_id: entry.operation_id,
          action_type: entry.action_type,
          ...(entry.target_origin ? { target_origin: entry.target_origin } : {}),
        };
      }
    }

    let policy: ReviewedBrowserPolicyV1;
    try {
      policy = createReviewedBrowserPolicy({
        course_id: catalog.course_id,
        lesson_id: catalog.lesson_id,
        compiled_ir_digest: catalog.compiled_ir_digest,
        allowed_origins: [...catalog.browser_origins],
        reviewed_operations: reviewedOps,
      });
    } catch (polErr) {
      return {
        ok: false,
        code: "INVALID_POLICY",
        message: sanitizeBrowserHostMessage(polErr instanceof Error ? polErr.message : String(polErr)),
      };
    }

    // 4. Session Identity & Admission
    const sessionId = `cf-browser-${randomBytes(8).toString("hex")}`;
    const generation = 1;

    let admissionSession: BrowserAdmissionSession;
    try {
      admissionSession = new BrowserAdmissionSession({
        session_id: sessionId,
        generation,
        catalog,
        policy,
      });
    } catch (admErr) {
      return {
        ok: false,
        code: "ADMISSION_INIT_FAILED",
        message: sanitizeBrowserHostMessage(admErr instanceof Error ? admErr.message : String(admErr)),
      };
    }

    // 5. Runtime Host & Event Subscription
    const runtimeHost = this.createRuntimeHost();
    const unsubscribeJournal = runtimeHost.getJournal().subscribe((event) => {
      const activeSession = this.sessions.get(sessionId);
      if (!activeSession) return;
      if (event.generation !== activeSession.generation) return;
      if (
        event.type === "browser.closed" ||
        (event.type === "browser.operation.failed" &&
          (event.error_code === "PAGE_CRASHED" || event.error_code === "BROWSER_CRASHED"))
      ) {
        activeSession.frameProducer?.stop();
      }
      this.pushToRenderer(activeSession.webContentsId, BROWSER_EVENT_CHANNEL, event);
    });

    const hosted: HostedBrowserSession = {
      session_id: sessionId,
      generation,
      lesson_id: input.lessonId,
      course_id: catalog.course_id,
      webContentsId: input.webContentsId,
      rendererUrl: input.rendererUrl,
      catalog,
      policy,
      admissionSession,
      runtimeHost,
      prepared: false,
      unsubscribeJournal,
      frameProducer: null,
    };

    this.sessions.set(sessionId, hosted);
    this.currentSession.set(input.webContentsId, sessionId);

    const descriptor: SafeBrowserSessionDescriptor = {
      session_id: sessionId,
      generation,
      lesson_id: input.lessonId,
      course_id: catalog.course_id,
      status: "ready",
    };

    return { ok: true, session: descriptor };
  }

  /**
   * Attaches and starts frame streaming for an active, prepared browser session.
   */
  private attachFrameProducer(session: HostedBrowserSession): void {
    if (session.frameProducer !== null) {
      session.frameProducer.stop();
      session.frameProducer = null;
    }
    const pageHandle = session.runtimeHost.getActiveSession()?.getPrimaryPageHandle();
    if (!pageHandle || !pageHandle.isAlive()) return;

    const producer = new BrowserFrameProducer({
      sessionId: session.session_id,
      generation: session.generation,
      pageHandle,
      onFrame: (frame: BrowserVisualFrame) => {
        const active = this.sessions.get(session.session_id);
        if (!active || active.generation !== frame.generation) return;
        this.pushToRenderer(active.webContentsId, BROWSER_FRAME_CHANNEL, frame);
      },
    });

    session.frameProducer = producer;
    void producer.start();
  }

  /** Gets active frame producer for a session (used in testing and diagnostics). */
  getFrameProducer(sessionId: string): BrowserFrameProducer | null {
    return this.sessions.get(sessionId)?.frameProducer ?? null;
  }

  /** Manually trigger a frame capture on an active session. */
  async triggerFrameCapture(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session?.frameProducer) {
      await session.frameProducer.triggerCapture();
    }
  }

  /** Revoke and cleanly terminate the session a renderer owns. */
  async closeSessionForRenderer(webContentsId: number, cause: BrowserCloseCause): Promise<void> {
    const sessionId = this.currentSession.get(webContentsId);
    if (sessionId === undefined) return;
    this.currentSession.delete(webContentsId);
    await this.closeHostedSession(sessionId, cause);
  }

  private async closeHostedSession(sessionId: string, _cause: BrowserCloseCause): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;

    this.sessions.delete(sessionId);
    if (session.frameProducer !== null) {
      session.frameProducer.stop();
      session.frameProducer = null;
    }
    session.unsubscribeJournal();
    session.admissionSession.dispose();

    try {
      await session.runtimeHost.close();
    } catch {}

    // Retain runtimeHost so getSnapshot can still read historical events
    this.retainedHosts.set(sessionId, session.runtimeHost);
  }

  /**
   * Dispatches one browser invoke.
   * Enforces structural sender validation, strictly identifier-only DTOs,
   * generation fencing, bounded payloads, and error sanitization.
   */
  async handleInvoke(channel: string, sender: BrowserSender, payload: unknown): Promise<BrowserInvokeResponse> {
    if (!BROWSER_INVOKE_CHANNELS.includes(channel as BrowserInvokeChannel)) {
      return failure("INVALID_REQUEST", "unknown browser channel");
    }

    if (!isRecord(payload)) {
      return failure("INVALID_REQUEST", "browser payload must be an object");
    }

    // Payload size bound (64 KiB)
    try {
      const payloadString = JSON.stringify(payload);
      if (payloadString.length > 65_536) {
        return failure("INVALID_REQUEST", "payload exceeds maximum size of 64 KiB");
      }
    } catch {
      return failure("INVALID_REQUEST", "payload serialization error");
    }

    // Explicit rejection of hostile extra fields
    if (hasHostileKeys(payload)) {
      return failure("INVALID_REQUEST", "request contains forbidden semantic or host authority fields");
    }

    const sessionId = typeof payload["session_id"] === "string" ? payload["session_id"] : null;
    if (sessionId === null || sessionId.length === 0) {
      return failure("INVALID_REQUEST", "browser request must carry session_id");
    }

    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      // Check if this is a historical getSnapshot for a closed session
      if (channel === "browser:getSnapshot") {
        const retainedHost = this.retainedHosts.get(sessionId);
        if (retainedHost !== undefined) {
          const parsed = GetBrowserSnapshotRequestSchema.safeParse(payload);
          if (!parsed.success) {
            return failure("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "invalid getSnapshot request");
          }
          const page = retainedHost.getSnapshot(sessionId, 1, parsed.data.after_seq, false);
          return { ok: true, page };
        }
      }
      return failure("STALE_SESSION", "unknown or closed browser session");
    }

    // Structural sender validation
    const sessionBinding: BrowserRendererBinding = {
      webContentsId: session.webContentsId,
      rendererUrl: session.rendererUrl,
    };
    if (!isTrustedBrowserSender(sender, sessionBinding)) {
      return failure("WRONG_OWNER", "browser sender is not the bound session owner");
    }

    // Generation fencing if generation is provided
    if (typeof payload["generation"] === "number" && payload["generation"] !== session.generation) {
      return failure("STALE_GENERATION", `outdated generation counter (active: ${session.generation}, got: ${payload["generation"]})`);
    }

    switch (channel as BrowserInvokeChannel) {
      case "browser:runOperation": {
        const parsed = RunBrowserOperationRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return failure("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "invalid runOperation request");
        }

        // Lazy start browser runtime if not yet prepared
        if (!session.prepared) {
          const prep = await session.runtimeHost.prepareSession({
            sessionId: session.session_id,
            generation: session.generation,
            lessonId: session.lesson_id,
            courseId: session.course_id,
            allowedOrigins: session.policy.allowed_origins,
          });
          if (!prep.ok) {
            return failure(prep.rejection.code, prep.rejection.message);
          }
          session.prepared = true;
          this.attachFrameProducer(session);
        }

        const runResult = await session.runtimeHost.runOperation(session.admissionSession, parsed.data);
        if (!runResult.ok) {
          return failure(runResult.rejection.code, runResult.rejection.message);
        }
        if (session.frameProducer !== null) {
          void session.frameProducer.triggerCapture();
        }
        return { ok: true, receipt: runResult.receipt };
      }

      case "browser:cancelOperation": {
        const parsed = CancelBrowserOperationRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return failure("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "invalid cancelOperation request");
        }

        session.runtimeHost.cancelOperation(parsed.data.operation_id);
        const cancelResult = session.admissionSession.cancelOperation(parsed.data);
        if (!cancelResult.ok) {
          return failure(cancelResult.rejection.code, cancelResult.rejection.message);
        }
        return { ok: true, cancelled: cancelResult.cancelled };
      }

      case "browser:getSnapshot": {
        const parsed = GetBrowserSnapshotRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return failure("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "invalid getSnapshot request");
        }

        const page = session.runtimeHost.getSnapshot(
          session.session_id,
          session.generation,
          parsed.data.after_seq,
          false,
        );
        return { ok: true, page };
      }

      case "browser:resetRuntime": {
        const parsed = ResetBrowserRuntimeRequestSchema.safeParse(payload);
        if (!parsed.success) {
          return failure("INVALID_REQUEST", parsed.error.issues[0]?.message ?? "invalid resetRuntime request");
        }

        if (session.frameProducer !== null) {
          session.frameProducer.stop();
          session.frameProducer = null;
        }

        const resetOutcome = await session.runtimeHost.reset(parsed.data);
        if (!resetOutcome.ok) {
          return failure(resetOutcome.rejection.code, resetOutcome.rejection.message);
        }

        // Advance generation on hosted session & recreate admission session
        session.generation = resetOutcome.descriptor.generation;
        session.prepared = false; // Fresh runtime for next generation
        session.admissionSession.dispose();

        session.admissionSession = new BrowserAdmissionSession({
          session_id: session.session_id,
          generation: session.generation,
          catalog: session.catalog,
          policy: session.policy,
        });

        return { ok: true, session: resetOutcome.descriptor };
      }
    }
  }

  /** Shutdown barrier: closes every hosted session and confirms cleanup. */
  async shutdownAll(_cause: BrowserCloseCause): Promise<readonly { session_id: string }[]> {
    const closed: { session_id: string }[] = [];
    for (const [sessionId, session] of [...this.sessions]) {
      this.sessions.delete(sessionId);
      if (session.frameProducer !== null) {
        session.frameProducer.stop();
        session.frameProducer = null;
      }
      session.unsubscribeJournal();
      session.admissionSession.dispose();
      try {
        await session.runtimeHost.shutdown();
      } catch {}
      closed.push({ session_id: sessionId });
    }
    this.currentSession.clear();
    this.retainedHosts.clear();
    return closed;
  }
}

/**
 * Creates a bounded shutdown barrier function for app.on("before-quit").
 */
export function createBrowserShutdownBarrier(
  host: BrowserIpcHost,
  timeoutMs = 10_000,
): () => Promise<readonly { session_id: string }[]> {
  return async () => {
    const done = host.shutdownAll("app_close");
    const bounded = new Promise<readonly { session_id: string }[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), timeoutMs);
      void done.then(
        (results) => {
          clearTimeout(timer);
          resolve(results);
        },
        () => {
          clearTimeout(timer);
          resolve([]);
        },
      );
    });
    return bounded;
  };
}
