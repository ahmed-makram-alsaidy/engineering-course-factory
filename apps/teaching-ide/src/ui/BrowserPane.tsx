// Browser panel — P7.7 Teaching IDE BrowserPane Presentation & Frame Streaming.
// Canonical architecture: docs/P7-DESIGN-SPEC.md Sections 6.2, 22.1, ADR-0012.
//
// OWNERSHIP (design-exact, no phase creep):
//   - Passive visual presentation ONLY: renders main-pushed visual frames (browser:frame)
//     and derives UI status from trusted journal events (browser:event).
//   - Absolute non-authority:
//       * NO interactive URL typing or user navigation (read-only URL display only).
//       * NO coordinate click or mouse event forwarding to the browser runtime.
//       * NO keyboard input forwarding.
//       * NO iframe embedding to lesson URLs; NO webview usage.
//       * NO arbitrary JavaScript evaluation.
//   - Generation & session fencing: frames from old sessions or generations are discarded.
//   - Memory bounded: object URLs are revoked promptly when new frames arrive or on unmount.
//   - Record Safe Mode: dynamic ports, host paths, and dev inspection tools are hidden.

import { useEffect, useRef, useState } from "react";
import type { CompiledStep } from "../model/ir.ts";
import type { SafeBrowserSessionDescriptor } from "../model/bridge.ts";
import {
  initialBrowserViewState,
  applyBrowserVisualFrame,
  applyBrowserRuntimeEvent,
  reanchorBrowserSession,
  clearBrowserVisualState,
  sanitizeLogicalUrl,
  createBrowserRequestId,
  type BrowserViewState,
} from "../model/browser-runtime.ts";

interface Props {
  /** Active safe browser session from loadLesson or resetRuntime. */
  session?: SafeBrowserSessionDescriptor | null;
  /** Current playhead step for operation badge correlation. */
  currentStep?: CompiledStep | null;
  /** Whether the browser pane tab is highlighted by the playhead. */
  highlighted?: boolean;
  /** Recording Safe Mode flag. */
  recordingSafe?: boolean;
  /** Callback when main rotates generation or updates descriptor. */
  onSessionUpdated?: (session: SafeBrowserSessionDescriptor) => void;
  /** Authored URL from step metadata (fallback display). */
  metadataUrl?: string | null;
  /** Static preview HTML fallback for backward compatibility. */
  previewHtml?: string;
}

export function BrowserPane(props: Props): React.JSX.Element {
  const [view, setView] = useState<BrowserViewState>(initialBrowserViewState);
  const [busy, setBusy] = useState<"idle" | "running" | "cancelling">("idle");
  const [notice, setNotice] = useState<string | null>(null);

  const viewRef = useRef<BrowserViewState>(view);
  viewRef.current = view;

  // Session re-anchor on prop change
  useEffect(() => {
    if (props.session) {
      setView((prev) =>
        reanchorBrowserSession(
          prev,
          props.session!,
          (url) => URL.revokeObjectURL(url),
        ),
      );
    } else {
      setView((prev) =>
        clearBrowserVisualState(prev, (url) => URL.revokeObjectURL(url)),
      );
    }
  }, [props.session?.session_id, props.session?.generation]);

  // Subscribe to browser:event and browser:frame streams
  useEffect(() => {
    const api = window.cfApi?.browser;
    if (!api || !props.session) return;

    const unsubscribeEvents = api.onEvent((event) => {
      setView((prev) => applyBrowserRuntimeEvent(prev, event, props.recordingSafe));
    });

    const unsubscribeFrames = api.onFrame((rawFrame) => {
      setView((prev) =>
        applyBrowserVisualFrame(
          prev,
          rawFrame,
          (blob) => URL.createObjectURL(blob),
          (url) => URL.revokeObjectURL(url),
        ),
      );
    });

    // Replay snapshot on mount to sync existing session state
    void api
      .getSnapshot({ session_id: props.session.session_id, after_seq: 0 })
      .then((res) => {
        if (res.ok && res.page.events.length > 0) {
          setView((prev) => {
            let next = prev;
            for (const ev of res.page.events) {
              next = applyBrowserRuntimeEvent(next, ev, props.recordingSafe);
            }
            return next;
          });
        }
      })
      .catch(() => {});

    return () => {
      unsubscribeEvents();
      unsubscribeFrames();
      // Revoke any active blob URL on unmount
      if (viewRef.current.lastFrame?.objectUrl) {
        if (viewRef.current.lastFrame.objectUrl.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(viewRef.current.lastFrame.objectUrl);
          } catch {}
        }
      }
    };
  }, [props.session?.session_id, props.session?.generation, props.recordingSafe]);

  const displayUrl =
    view.activeUrl !== "about:blank"
      ? view.activeUrl
      : sanitizeLogicalUrl(props.metadataUrl, props.recordingSafe);

  const isBrowserOperation =
    props.currentStep?.kind === "operation" &&
    props.currentStep.operation.family === "browser";

  const runCurrent = async (): Promise<void> => {
    const api = window.cfApi?.browser;
    if (!api || !props.session || !isBrowserOperation || props.currentStep?.kind !== "operation") return;
    setBusy("running");
    setNotice(null);
    try {
      const response = await api.runOperation({
        session_id: props.session.session_id,
        operation_id: props.currentStep.step_id,
        request_id: createBrowserRequestId(),
      });
      if (!response.ok) {
        setNotice(response.message);
      }
    } catch {
      setNotice("Run failed to reach browser runtime.");
    } finally {
      setBusy("idle");
    }
  };

  const cancelCurrent = async (): Promise<void> => {
    const api = window.cfApi?.browser;
    if (!api || !props.session || !isBrowserOperation || props.currentStep?.kind !== "operation") return;
    setBusy("cancelling");
    try {
      await api.cancelOperation({
        session_id: props.session.session_id,
        operation_id: props.currentStep.step_id,
        request_id: createBrowserRequestId(),
      });
    } catch {
      setNotice("Cancel failed to reach browser runtime.");
    } finally {
      setBusy("idle");
    }
  };

  const statusLabel =
    view.status === "CRASHED"
      ? "Crashed"
      : view.status === "CLOSED"
      ? "Closed"
      : view.activeBadge
      ? view.activeBadge.label
      : view.status === "READY"
      ? "Ready"
      : view.status === "RUNNING"
      ? "Running"
      : "Inactive";

  return (
    <div
      className="browser-pane-container"
      role="region"
      aria-label="Browser Presentation Panel"
      style={props.highlighted ? { outline: "1px solid var(--accent-dim)", outlineOffset: "-1px" } : undefined}
    >
      {/* Top read-only toolbar */}
      <div className="browser-toolbar">
        <div className="browser-status-badge" role="status" aria-live="polite" data-status={view.status.toLowerCase()}>
          <span className={`status-dot dot-${view.status.toLowerCase()}`} />
          <span className="status-text">{statusLabel}</span>
        </div>

        <div className="browser-url-bar" role="textbox" aria-readonly="true" aria-label="Browser Address Bar" title={displayUrl}>
          <span className="url-lock-icon" aria-hidden="true">🔒</span>
          <span className="url-text">{displayUrl}</span>
          <span className="url-readonly-tag">read-only</span>
        </div>

        {isBrowserOperation && (
          <div className="browser-actions">
            <button
              className="ui primary"
              onClick={() => void runCurrent()}
              disabled={busy !== "idle" || view.status === "CRASHED" || view.status === "CLOSED"}
            >
              {busy === "running" ? "Running..." : "Run Step"}
            </button>
            {busy === "running" && (
              <button className="ui" onClick={() => void cancelCurrent()}>
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      {notice && (
        <div className="browser-notice-bar" role="alert">
          <span>{notice}</span>
          <button className="ui small" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {/* Presentation visual surface */}
      <div className="browser-viewport">
        {view.status === "CRASHED" ? (
          <div className="browser-crashed-overlay" role="alert">
            <div className="crashed-icon" aria-hidden="true">⚠️</div>
            <div className="crashed-title">Browser Process Terminated</div>
            <div className="crashed-desc">
              {view.errorMessage || "The browser page or process crashed unexpectedly. Reset runtime to continue."}
            </div>
          </div>
        ) : view.lastFrame ? (
          <div className="browser-frame-wrap">
            <img
              src={view.lastFrame.objectUrl}
              alt="Browser View"
              className="browser-frame-img"
              draggable={false}
              width={view.lastFrame.width}
              height={view.lastFrame.height}
            />
          </div>
        ) : (
          <div className="browser-empty-state">
            <div className="empty-icon" aria-hidden="true">🌐</div>
            <div className="empty-title">
              {props.session ? "Browser Session Ready" : "Browser Inactive"}
            </div>
            <div className="empty-desc">
              {props.session
                ? "Awaiting visual frame stream from browser host..."
                : "No active browser session. Load a lesson to initialize."}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
