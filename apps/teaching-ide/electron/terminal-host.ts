// Electron terminal IPC host — P5.11 Safe IPC wiring (main-process side).
//
// Canonical architecture: docs/P5-DESIGN-SPEC.md, task P5.11 "Safe IPC"
// (main/host/preload/bridge/tests; IDs/senders/sandbox/shutdown barrier;
// PASS: No arbitrary command/Docker renderer capability).
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module is the ONLY place that touches Electron IPC for the
//     terminal: exactly the five identifier-only invoke channels
//     (terminal:runOperation / stopProcess / cancelOperation / resetRuntime /
//     getSnapshot) plus the main-to-renderer event push (terminal:event).
//     No generic invoke/send/execute/stdin/resize/Docker/env/cwd/image/mount
//     channel exists here or anywhere else (gate-enumerated).
//   - Every invoke validates its sender structurally (stored owning
//     webContents id + top-level sender frame + exact bundled renderer URL).
//     Other frames, other windows, stale owners, navigations and window
//     openings are denied with WRONG_OWNER/STALE_SESSION before the engine
//     ever sees work. The sandbox stays intact (contextIsolation on,
//     nodeIntegration off, sandbox on, strict CSP — verified by the existing
//     safety suite, untouched here).
//   - Execution itself is owned by @course-factory/terminal-engine's
//     TerminalHost (identifier-only requests in, trusted grants out). This
//     module never sees commands, PIDs, Docker argv, signals, mount sources,
//     host paths, env values, image selection or shell selection.
//   - loadLesson integration: switches serialize — the previous session owned
//     by a renderer is revoked and cleaned (awaited removal) before the new
//     session opens. loadLesson returns the terminal descriptor additively
//     ({ session_id, generation } only — no private IDs/paths/container IDs).
//   - reportReady stays diagnostics-only (never authorizes, never PASSes).
//   - Shutdown barrier: installTerminalShutdownBarrier awaits
//     host.shutdownAll before quit; no app.exit bypass.
//   - Passive UI (P5.12: App/TerminalPane/model/CSS), wait scheduling (P8),
//     PTY, browser, typing and curriculum are NOT started here.
//
// TESTABILITY: nothing in this module imports Electron at the top level.
// The invoke dispatcher (TerminalIpcHost.handleInvoke) takes a structural
// sender ({ webContentsId, frameUrl, frameIsTop }) so unit tests exercise
// sender validation without launching Electron. main.ts passes the real
// ipcMain/event objects through a 10-line adapter.

import type {
  CloseCause,
  TerminalSnapshotPage,
} from "@course-factory/terminal-engine";
import type {
  StartReceipt,
  StopResult,
} from "@course-factory/terminal-engine";
import type { TerminalHost, SafeSessionDescriptor } from "@course-factory/terminal-engine/terminal-host";
import { isExecutionAuthorized } from "./execution-catalog.ts";

/** The five and only five renderer-to-main terminal invoke channels. */
export const TERMINAL_INVOKE_CHANNELS = Object.freeze([
  "terminal:runOperation",
  "terminal:stopProcess",
  "terminal:cancelOperation",
  "terminal:resetRuntime",
  "terminal:getSnapshot",
] as const);

export type TerminalInvokeChannel = (typeof TERMINAL_INVOKE_CHANNELS)[number];

/** Main-to-renderer event push channel (copied DTOs only; the renderer filters by session_id). */
export const TERMINAL_EVENT_CHANNEL = "terminal:event";

/** Structural sender facts (mapped from Electron's IpcMainInvokeEvent in main.ts). */
export interface TerminalSender {
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
export interface RendererBinding {
  readonly webContentsId: number;
  readonly rendererUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Sender validation (design "Check stored webContents/top-level senderFrame/
 * exact bundled URL; deny other frames/windows/stale owners/navigation/window
 * opening"). Pure, deterministic, unit-tested with fake senders.
 */
export function isTrustedTerminalSender(sender: TerminalSender, binding: RendererBinding | null): boolean {
  if (binding === null) return false;
  if (sender.senderDestroyed) return false;
  if (sender.webContentsId !== binding.webContentsId) return false;
  if (!sender.frameIsTop) return false;
  if (sender.frameUrl === null) return false;
  if (sender.frameUrl !== binding.rendererUrl) return false;
  return true;
}

export interface TerminalIpcHostOptions {
  /** Engine host (already constructed with trusted machine config). */
  readonly host: TerminalHost;
  /** Deliver a copied event DTO to one renderer (main.ts: owner webContents.send). */
  readonly pushToRenderer: (webContentsId: number, channel: string, dto: unknown) => void;
}

interface SessionOwnership {
  webContentsId: number;
  rendererUrl: string;
}

/** Renderer-safe invoke response (never stacks, paths, container IDs or PIDs). */
export type TerminalInvokeResponse =
  | { ok: true; receipt: StartReceipt }
  | { ok: true; stop: StopResult }
  | { ok: true; session: SafeSessionDescriptor }
  | { ok: true; page: TerminalSnapshotPage }
  | { ok: false; code: string; message: string };

function failure(code: string, message: string): TerminalInvokeResponse {
  return { ok: false, code, message };
}

/**
 * The invoke dispatcher: channel + structural sender + unknown payload in,
 * renderer-safe DTO out. No Electron import; no command/Docker surface.
 */
export class TerminalIpcHost {
  private readonly host: TerminalHost;
  private readonly pushToRenderer: (webContentsId: number, channel: string, dto: unknown) => void;
  /** session_id -> owning renderer (bound at openSessionForRenderer). */
  private readonly owners = new Map<string, SessionOwnership>();
  /** webContentsId -> binding (bound at window creation / loadLesson). */
  private readonly bindings = new Map<number, RendererBinding>();
  /** webContentsId -> currently owned session (for serialized switches). */
  private readonly currentSession = new Map<number, string>();

  constructor(options: TerminalIpcHostOptions) {
    this.host = options.host;
    this.pushToRenderer = options.pushToRenderer;
  }

  /** Return the underlying TerminalHost instance for internal domain session wiring. */
  getHost(): TerminalHost {
    return this.host;
  }

  /** Bind (or rebind) a renderer's window facts (main.ts: at window creation). */
  bindRenderer(binding: RendererBinding): void {
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
   * Open (or switch) the runtime session for a renderer after its lesson
   * loaded and validated. Serializes switches: the renderer's previous
   * session — if any — is revoked and cleaned (awaited removal) before the
   * new session opens. Returns the SAFE descriptor only (no private IDs).
   */
  async openSessionForRenderer(input: {
    webContentsId: number;
    rendererUrl: string;
    compiledLesson: Parameters<TerminalHost["openSession"]>[0];
    lessonCompiledDigest: string;
    lessonId: string;
  }): Promise<{ ok: true; session: SafeSessionDescriptor } | { ok: false; code: string; message: string }> {
    const binding = this.bindings.get(input.webContentsId);
    if (binding === undefined) {
      return { ok: false, code: "WRONG_OWNER", message: "renderer window is not bound" };
    }
    const previous = this.currentSession.get(input.webContentsId);
    if (previous !== undefined) {
      await this.host.closeSession(previous, "lesson_switch");
      this.owners.delete(previous);
      this.currentSession.delete(input.webContentsId);
    }
    const authorized = isExecutionAuthorized(input.lessonId, input.lessonCompiledDigest);
    const opened = this.host.openSession(input.compiledLesson, { executionAuthorized: authorized });
    if (!opened.ok) {
      return { ok: false, code: opened.rejection.code, message: opened.rejection.message };
    }
    const session = opened.value;
    this.owners.set(session.session_id, { webContentsId: input.webContentsId, rendererUrl: input.rendererUrl });
    this.currentSession.set(input.webContentsId, session.session_id);
    try {
      this.host.subscribe(session.session_id, (event) => {
        const owner = this.owners.get(session.session_id);
        if (owner === undefined) return;
        this.pushToRenderer(owner.webContentsId, TERMINAL_EVENT_CHANNEL, event);
      });
    } catch {
      // Subscription bound exceeded: the session stays usable via polling
      // (getSnapshot); live push is best-effort.
    }
    return { ok: true, session };
  }

  /**
   * Revoke and clean the session a renderer owns (reset/switch/end/renderer
   * loss). Ownership is KEPT so the living renderer retains bounded replay
   * (getSnapshot) over the retained journal; runs are revoked (STALE_SESSION)
   * by the engine. Switches delete the old owner explicitly; window close
   * sweeps via unbindRenderer.
   */
  async closeSessionForRenderer(webContentsId: number, cause: CloseCause): Promise<void> {
    const sessionId = this.currentSession.get(webContentsId);
    if (sessionId === undefined) return;
    await this.host.closeSession(sessionId, cause);
    this.currentSession.delete(webContentsId);
  }

  /** Dispatch one invoke (main.ts adapter validates the channel is one of the five). */
  async handleInvoke(channel: string, sender: TerminalSender, payload: unknown): Promise<TerminalInvokeResponse> {
    if ((TERMINAL_INVOKE_CHANNELS as readonly string[]).includes(channel) === false) {
      return failure("INVALID_REQUEST", "unknown terminal channel");
    }
    const sessionId = sessionIdOf(payload);
    if (sessionId === null) {
      // getSnapshot carries session_id too; every terminal payload does.
      // A payload without one is malformed by construction.
      if (channel === "terminal:getSnapshot" && isRecord(payload) === false) {
        return failure("INVALID_REQUEST", "getSnapshot failed strict validation");
      }
      return failure("INVALID_REQUEST", "terminal request must carry its session_id");
    }
    const owner = this.owners.get(sessionId);
    if (owner === undefined) {
      return failure("STALE_SESSION", "unknown or closed session");
    }
    const binding = this.bindings.get(sender.webContentsId) ?? null;
    // The sender must be the bound owner AND arrive over the exact top-level
    // bundled URL recorded for that session (navigation/window-opening deny).
    const sessionBinding: RendererBinding = { webContentsId: owner.webContentsId, rendererUrl: owner.rendererUrl };
    void binding;
    if (isTrustedTerminalSender(sender, sessionBinding) === false) {
      return failure("WRONG_OWNER", "terminal sender is not the bound session owner");
    }
    switch (channel as TerminalInvokeChannel) {
      case "terminal:runOperation": {
        const result = await this.host.handleRunOperation(payload);
        if (!result.ok) return failure(result.rejection.code, result.rejection.message);
        return { ok: true, receipt: result.value };
      }
      case "terminal:stopProcess": {
        const result = await this.host.handleStopProcess(payload);
        if (!result.ok) return failure(result.rejection.code, result.rejection.message);
        return { ok: true, stop: result.value };
      }
      case "terminal:cancelOperation": {
        const result = await this.host.handleCancelOperation(payload);
        if (!result.ok) return failure(result.rejection.code, result.rejection.message);
        return { ok: true, stop: result.value };
      }
      case "terminal:resetRuntime": {
        const result = await this.host.handleResetRuntime(payload);
        if (!result.ok) return failure(result.rejection.code, result.rejection.message);
        // Generation moved: keep the same owner on the same session_id.
        return { ok: true, session: result.value };
      }
      case "terminal:getSnapshot": {
        const result = this.host.handleGetSnapshot(payload);
        if (!result.ok) return failure(result.rejection.code, result.rejection.message);
        return { ok: true, page: result.value };
      }
    }
  }

  /** Shutdown barrier: closes every hosted session (idempotent). No new sessions afterwards. */
  async shutdownAll(cause: "reset" | "lesson_switch" | "lesson_end" | "renderer_loss" | "app_close" | "failure" | "timeout" | "session_expiry"): Promise<readonly { session_id: string }[]> {
    const results = await this.host.shutdownAll(cause);
    return results.map((r) => ({ session_id: r.session_id }));
  }
}

function sessionIdOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const value = payload["session_id"];
  return typeof value === "string" ? value : null;
}

/**
 * Shutdown barrier installer (design "App before-quit/window-close and smoke
 * await same barrier, no app.exit bypass"). main.ts calls this once; the
 * returned function awaits host.shutdownAll with a bounded wait.
 */
export function createShutdownBarrier(host: TerminalHost, timeoutMs = 10_000): () => Promise<readonly { session_id: string }[]> {
  return async () => {
    const done = host.shutdownAll("app_close");
    const bounded = new Promise<readonly { session_id: string }[]>((resolve) => {
      const timer = setTimeout(() => resolve([]), timeoutMs);
      void done.then(
        (results) => {
          clearTimeout(timer);
          resolve(results.map((r) => ({ session_id: (r as { session_id?: string }).session_id ?? "" })));
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
