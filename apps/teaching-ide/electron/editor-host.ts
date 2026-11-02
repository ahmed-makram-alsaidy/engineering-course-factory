// Electron editor IPC host — P6.12 Safe IPC wiring (main-process side).
//
// Canonical architecture: docs/P6-DESIGN-SPEC.md section 15 (proposed
// cfApi.editor: runOperation/cancelOperation/getSnapshot/
// acknowledgePresentation with strict identifier-only DTOs; onEvent/
// onPresentation as preload-local subscriptions; reset routes through the
// shared lifecycle owner, never an independent editor reset) plus sections
// 4/5/6 (renderer is not semantic authority; Monaco is not disk authority)
// and the proven P5.11 IPC pattern (sender binding, ownership, shutdown
// barrier, lifecycle-safe event push).
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module is the ONLY place that touches Electron IPC for the
//     editor: exactly the four identifier-only invoke channels
//     (editor:runOperation / cancelOperation / getSnapshot /
//     acknowledgePresentation) plus the two main-to-renderer pushes
//     (editor:event for journal DTOs, editor:presentation for trusted
//     frames). There is deliberately NO editor reset channel: reset routes
//     through the shared lifecycle owner (P6.13+), never an independent
//     editor reset that leaves P5 alive. No generic invoke/send/execute,
//     no path/content/timing/revision channel exists here or anywhere else.
//   - Every invoke validates its sender structurally (stored owning
//     webContents id + top-level sender frame + exact bundled renderer URL).
//     Other frames, other windows, stale owners and navigations are denied
//     with WRONG_OWNER/STALE_SESSION before the engine ever sees work.
//   - Execution itself is owned by the P6.11 EditorLifecycle behind the
//     P6.12 ack-gated presentation driver (identifier-only requests in,
//     trusted snapshots/frames out). This module never sees paths, source
//     text, find/replace literals, timing policy, save bytes, digests,
//     revisions, host paths, leases or adapter handles: the per-session
//     execution dependencies arrive through the injected main-owned factory
//     and are forwarded opaquely to the driver.
//   - Presentation frames produced by a successful run are re-emitted over
//     editor:presentation (best-effort, bounded) so renderers using the
//     subscribe-before-snapshot pattern observe frames even if they missed
//     the invoke response. Frame bytes always come from the driver, never
//     from renderer input.
//   - Event push uses the hardened window-lifecycle helpers (never touch a
//     destroyed window/webContents; P5.15 repair preserved).
//   - Terminal IPC and editor IPC remain separate narrow domains: no
//     combined channel, no shared owner map, no privilege mixing.
//
// TESTABILITY: nothing in this module imports Electron or the workspace
// engine at value level. The invoke dispatcher takes a structural sender so
// unit tests exercise sender validation without launching Electron, and the
// session factory plus event push are injected so tests drive the boundary
// with fake drivers. main.ts passes the real ipcMain/event objects and the
// real P6 lifecycle-backed factory through a thin adapter.

import type { CloseCause } from "@course-factory/terminal-engine";

/** The four and only four renderer-to-main editor invoke channels. */
export const EDITOR_INVOKE_CHANNELS = Object.freeze([
  "editor:runOperation",
  "editor:cancelOperation",
  "editor:getSnapshot",
  "editor:acknowledgePresentation",
] as const);

export type EditorInvokeChannel = (typeof EDITOR_INVOKE_CHANNELS)[number];

/** Main-to-renderer trusted event push (copied journal DTOs only). */
export const EDITOR_EVENT_CHANNEL = "editor:event";

/** Main-to-renderer trusted presentation push (bounded frames only). */
export const EDITOR_PRESENTATION_CHANNEL = "editor:presentation";

/** Structural sender facts (mapped from Electron's IpcMainInvokeEvent in main.ts). */
export interface EditorSender {
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
export interface EditorRendererBinding {
  readonly webContentsId: number;
  readonly rendererUrl: string;
}

/** Safe editor session descriptor for the renderer (identifiers only). */
export interface SafeEditorSessionDescriptor {
  readonly session_id: string;
  readonly generation: number;
}

/**
 * Structural presentation driver (the real P6.12 driver in main; fakes in
 * tests). Requests are identifier-only unknowns in, renderer-safe DTOs out.
 */
export interface EditorDriverLike {
  describe(): { session_id: string; generation: number };
  runOperation(request: unknown, deps?: unknown): Promise<unknown>;
  cancelOperation(request: unknown): unknown;
  getSnapshot(request: unknown): unknown;
  acknowledge(request: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): { unsubscribe: () => void };
}

export interface EditorSessionFactoryInput {
  readonly webContentsId: number;
  readonly rendererUrl: string;
  readonly compiledLesson: unknown;
  readonly lessonCompiledDigest: string;
  readonly lessonId: string;
  readonly reviewed: boolean;
}

export interface EditorOpenedSession {
  /** Ack-gated presentation driver for this session generation scope. */
  readonly driver: EditorDriverLike;
  /** Main-held execution dependencies (adapter + lease), forwarded opaquely. */
  readonly execDeps: unknown;
  /** Safe descriptor shared with the renderer (identifiers only). */
  readonly session: SafeEditorSessionDescriptor;
  /** Revoke, settle, retire and remove everything owned by this session. */
  readonly cleanup: (cause: CloseCause) => Promise<void>;
}

export interface EditorIpcHostOptions {
  /** Main-owned session factory (leaf/adapter/lifecycle/driver in main.ts). */
  readonly openSession: (input: EditorSessionFactoryInput) => Promise<
    | { ok: true; opened: EditorOpenedSession }
    | { ok: false; code: string; message: string }
  >;
  /** Deliver a copied DTO to one renderer (main.ts: owner webContents.send). */
  readonly pushToRenderer: (webContentsId: number, channel: string, dto: unknown) => void;
}

interface SessionOwnership {
  webContentsId: number;
  rendererUrl: string;
}

interface HostedSession {
  driver: EditorDriverLike;
  execDeps: unknown;
  cleanup: (cause: CloseCause) => Promise<void>;
  unsubscribe: () => void;
}

/** Renderer-safe invoke response (identifiers/revisions/flags only, never stacks or paths). */
export type EditorInvokeResponse = { ok: true; value: unknown } | { ok: false; code: string; message: string };

function failure(code: string, message: string): EditorInvokeResponse {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Sender validation (P5.11 pattern reused: stored webContents, top-level
 * senderFrame, exact bundled URL; deny other frames/windows/stale owners).
 * Pure, deterministic, unit-tested with fake senders.
 */
export function isTrustedEditorSender(sender: EditorSender, binding: EditorRendererBinding | null): boolean {
  if (binding === null) return false;
  if (sender.senderDestroyed) return false;
  if (sender.webContentsId !== binding.webContentsId) return false;
  if (!sender.frameIsTop) return false;
  if (sender.frameUrl === null) return false;
  if (sender.frameUrl !== binding.rendererUrl) return false;
  return true;
}

/**
 * The invoke dispatcher: channel + structural sender + unknown payload in,
 * renderer-safe DTO out. No Electron import; no path/content/timing surface.
 */
export class EditorIpcHost {
  private readonly openSessionFactory: EditorIpcHostOptions["openSession"];
  private readonly pushToRenderer: (webContentsId: number, channel: string, dto: unknown) => void;
  /** session_id -> owning renderer (bound at openSessionForRenderer). */
  private readonly owners = new Map<string, SessionOwnership>();
  /** webContentsId -> binding (bound at window creation / lesson load). */
  private readonly bindings = new Map<number, EditorRendererBinding>();
  /** webContentsId -> currently owned session (for serialized switches). */
  private readonly currentSession = new Map<number, string>();
  /** session_id -> hosted runtime (driver + main-held deps + cleanup). */
  private readonly sessions = new Map<string, HostedSession>();

  constructor(options: EditorIpcHostOptions) {
    this.openSessionFactory = options.openSession;
    this.pushToRenderer = options.pushToRenderer;
  }

  /** Bind (or rebind) a renderer's window facts (main.ts: at window creation). */
  bindRenderer(binding: EditorRendererBinding): void {
    this.bindings.set(binding.webContentsId, binding);
  }

  /** Forget a renderer (window closed): drop its binding and any ownership it held. */
  unbindRenderer(webContentsId: number): void {
    this.bindings.delete(webContentsId);
    for (const [sessionId, owner] of [...this.owners]) {
      if (owner.webContentsId === webContentsId) this.owners.delete(sessionId);
    }
    if (this.currentSession.get(webContentsId) !== undefined) this.currentSession.delete(webContentsId);
  }

  /**
   * Open (or switch) the editor session for a renderer after its lesson
   * loaded and validated. Serializes switches: the renderer's previous
   * session — if any — is revoked and cleaned before the new session opens.
   * Returns the SAFE descriptor only (session_id + generation).
   */
  async openSessionForRenderer(input: {
    webContentsId: number;
    rendererUrl: string;
    compiledLesson: unknown;
    lessonCompiledDigest: string;
    lessonId: string;
    reviewed: boolean;
  }): Promise<{ ok: true; session: SafeEditorSessionDescriptor } | { ok: false; code: string; message: string }> {
    const binding = this.bindings.get(input.webContentsId);
    if (binding === undefined) {
      return { ok: false, code: "WRONG_OWNER", message: "renderer window is not bound" };
    }
    const previous = this.currentSession.get(input.webContentsId);
    if (previous !== undefined) {
      const hosted = this.sessions.get(previous);
      if (hosted !== undefined) {
        try {
          hosted.unsubscribe();
        } catch {
          // Unsubscribe is best-effort; cleanup below still runs.
        }
        try {
          await hosted.cleanup("lesson_switch");
        } catch {
          // Cleanup failures are retained main-side; the switch still
          // proceeds to a fresh session (the old leaf is never reused).
        }
        this.sessions.delete(previous);
      }
      this.owners.delete(previous);
      this.currentSession.delete(input.webContentsId);
    }
    let opened: EditorOpenedSession;
    try {
      const result = await this.openSessionFactory({
        webContentsId: input.webContentsId,
        rendererUrl: input.rendererUrl,
        compiledLesson: input.compiledLesson,
        lessonCompiledDigest: input.lessonCompiledDigest,
        lessonId: input.lessonId,
        reviewed: input.reviewed,
      });
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      opened = result.opened;
    } catch {
      return { ok: false, code: "WORKSPACE_UNAVAILABLE", message: "editor session is unavailable" };
    }
    const session = opened.session;
    this.owners.set(session.session_id, { webContentsId: input.webContentsId, rendererUrl: input.rendererUrl });
    this.currentSession.set(input.webContentsId, session.session_id);
    const hosted: HostedSession = { driver: opened.driver, execDeps: opened.execDeps, cleanup: opened.cleanup, unsubscribe: () => undefined };
    try {
      const subscription = opened.driver.subscribe((event) => {
        const owner = this.owners.get(session.session_id);
        if (owner === undefined) return;
        this.pushToRenderer(owner.webContentsId, EDITOR_EVENT_CHANNEL, event);
      });
      hosted.unsubscribe = subscription.unsubscribe;
    } catch {
      // Subscription bound exceeded: the session stays usable via polling
      // (getSnapshot); live push is best-effort.
    }
    this.sessions.set(session.session_id, hosted);
    return { ok: true, session };
  }

  /**
   * Revoke and clean the session a renderer owns (switch/end/renderer loss).
   * The live runtime is dropped first so late invokes fence promptly as
   * STALE_SESSION; ownership records are retained only to keep that verdict
   * stable (closed vs unknown). No replay survives close: journal replay
   * happens pre-close through getSnapshot, and reseeding belongs to the
   * shared lifecycle owner (P6.13+). Switches delete the old owner
   * explicitly; window close sweeps via unbindRenderer.
   */
  async closeSessionForRenderer(webContentsId: number, cause: CloseCause): Promise<void> {
    const sessionId = this.currentSession.get(webContentsId);
    if (sessionId === undefined) return;
    const hosted = this.sessions.get(sessionId);
    // Drop the live runtime first so late invokes fence promptly.
    this.sessions.delete(sessionId);
    this.currentSession.delete(webContentsId);
    if (hosted === undefined) return;
    try {
      hosted.unsubscribe();
    } catch {
      // Best-effort.
    }
    try {
      await hosted.cleanup(cause);
    } catch {
      // Cleanup failures are retained main-side; close still proceeds.
    }
  }

  /** Dispatch one invoke (main.ts adapter validates the channel is one of the four). */
  async handleInvoke(channel: string, sender: EditorSender, payload: unknown): Promise<EditorInvokeResponse> {
    if ((EDITOR_INVOKE_CHANNELS as readonly string[]).includes(channel) === false) {
      return failure("INVALID_REQUEST", "unknown editor channel");
    }
    const sessionId = sessionIdOf(payload);
    if (sessionId === null) {
      return failure("INVALID_REQUEST", "editor request must carry its session_id");
    }
    const owner = this.owners.get(sessionId);
    if (owner === undefined) {
      return failure("STALE_SESSION", "unknown or closed session");
    }
    const sessionBinding: EditorRendererBinding = { webContentsId: owner.webContentsId, rendererUrl: owner.rendererUrl };
    if (isTrustedEditorSender(sender, sessionBinding) === false) {
      return failure("WRONG_OWNER", "editor sender is not the bound session owner");
    }
    const hosted = this.sessions.get(sessionId);
    if (hosted === undefined) {
      return failure("STALE_SESSION", "editor session is closed: bounded replay only");
    }
    try {
      switch (channel as EditorInvokeChannel) {
        case "editor:runOperation": {
          const response = (await hosted.driver.runOperation(payload, hosted.execDeps)) as
            | { ok: true; run: { frames?: unknown } }
            | { ok: false; code: string; message: string };
          if (response.ok) {
            // Re-emit trusted frames for subscribe-before-snapshot renderers
            // (best-effort, bounded, driver bytes only — never renderer input).
            this.pushPresentationFrames(sessionId, response);
          }
          return { ok: true, value: response };
        }
        case "editor:cancelOperation": {
          const response = hosted.driver.cancelOperation(payload) as unknown;
          return { ok: true, value: response };
        }
        case "editor:getSnapshot": {
          const response = hosted.driver.getSnapshot(payload) as unknown;
          return { ok: true, value: response };
        }
        case "editor:acknowledgePresentation": {
          const response = (await hosted.driver.acknowledge(payload)) as unknown;
          return { ok: true, value: response };
        }
      }
    } catch {
      // Defense in depth: engine failures are structured rejections; an
      // unexpected throw can never leak a stack, path or internal detail.
      return failure("WORKSPACE_UNAVAILABLE", "editor runtime failed safely");
    }
  }

  /** Push trusted presentation frames after a successful run (best-effort). */
  private pushPresentationFrames(sessionId: string, response: { ok: true; run: { frames?: unknown } }): void {
    const owner = this.owners.get(sessionId);
    if (owner === undefined) return;
    const frames = response.run.frames;
    if (!Array.isArray(frames) || frames.length === 0) return;
    try {
      this.pushToRenderer(owner.webContentsId, EDITOR_PRESENTATION_CHANNEL, {
        session_id: sessionId,
        frames,
      });
    } catch {
      // Live push is best-effort; the invoke response already carries frames.
    }
  }

  /** Shutdown barrier: closes every hosted session (idempotent). */
  async shutdownAll(cause: CloseCause): Promise<readonly { session_id: string }[]> {
    const closed: { session_id: string }[] = [];
    for (const [sessionId, hosted] of [...this.sessions]) {
      try {
        hosted.unsubscribe();
      } catch {
        // Best-effort.
      }
      try {
        await hosted.cleanup(cause);
      } catch {
        // Retain-and-continue: every session still gets its cleanup attempt.
      }
      this.sessions.delete(sessionId);
      closed.push({ session_id: sessionId });
    }
    return closed;
  }
}

function sessionIdOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const value = payload["session_id"];
  return typeof value === "string" ? value : null;
}
