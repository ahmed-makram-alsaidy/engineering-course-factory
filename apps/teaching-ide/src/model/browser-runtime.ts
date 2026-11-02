// Passive browser runtime model — P7.7 Teaching IDE BrowserPane Presentation & Frame Streaming.
// Canonical architecture: docs/P7-DESIGN-SPEC.md Sections 6.2, 22.1, ADR-0012.
//
// OWNERSHIP (design-exact, no phase creep):
//   - Pure UI state: derives the renderer's display view ONLY from canonical trusted
//     frames (browser:frame) and trusted journal events (browser:event).
//   - Zero automation authority: never initiates navigation, never synthesizes clicks,
//     never forwards coordinates, never executes scripts.
//   - Type-only engine protocol imports. No runtime engine code, no Electron import,
//     no node: import, no Playwright import.
//   - Stale owner frames/events (wrong session_id/generation) are ignored.
//   - Duplicate frames (frame_seq <= lastFrame.frame_seq) are ignored fail-closed.
//   - Oversized frames (> 2 MiB) or malformed dimensions are rejected fail-closed.
//   - Bounded memory: object URLs are revoked immediately when replaced or cleared.
//   - Record Safe Mode: hides dynamic reverse proxy ports, host paths, and internals.
//   - Errors map to UI-safe short messages from structured codes only.

import type {
  BrowserRuntimeEvent,
  BrowserVisualFrame,
  BrowserSnapshotPage,
  BrowserActionType,
  SafeBrowserSessionDescriptor,
} from "@course-factory/browser-engine";

export const MAX_FRAME_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MiB bound
export const MAX_SAFE_URL_LENGTH = 512;
export const MAX_SAFE_ERROR_LENGTH = 120;

export type BrowserStatus = "NOT_STARTED" | "READY" | "RUNNING" | "CRASHED" | "CLOSED";
export type BrowserBadgeStatus = "PENDING" | "RUNNING" | "PASS" | "FAIL" | "CANCELLED";

export interface BrowserOperationBadge {
  readonly operation_id: string;
  readonly action_type: BrowserActionType;
  readonly status: BrowserBadgeStatus;
  readonly label: string;
}

export interface BrowserFrameDisplay {
  readonly frame_seq: number;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly objectUrl: string;
  readonly timestamp_ms: number;
}

export interface BrowserFrameStats {
  readonly framesReceived: number;
  readonly framesApplied: number;
  readonly staleFramesDropped: number;
  readonly duplicateFramesDropped: number;
  readonly invalidFramesDropped: number;
}

export interface BrowserViewState {
  readonly session_id: string | null;
  readonly generation: number;
  readonly status: BrowserStatus;
  readonly activeUrl: string;
  readonly activeBadge: BrowserOperationBadge | null;
  readonly lastFrame: BrowserFrameDisplay | null;
  readonly errorMessage: string | null;
  readonly stats: BrowserFrameStats;
  readonly highestJournalSeq: number;
}

export function initialBrowserViewState(): BrowserViewState {
  return {
    session_id: null,
    generation: 0,
    status: "NOT_STARTED",
    activeUrl: "about:blank",
    activeBadge: null,
    lastFrame: null,
    errorMessage: null,
    stats: {
      framesReceived: 0,
      framesApplied: 0,
      staleFramesDropped: 0,
      duplicateFramesDropped: 0,
      invalidFramesDropped: 0,
    },
    highestJournalSeq: 0,
  };
}

/** Redacts local drive letters, paths, and limits length to 120 characters. */
export function sanitizeBrowserError(rawMessage: string | null | undefined): string {
  if (!rawMessage) return "Browser error occurred";
  let cleaned = rawMessage
    .replace(/[A-Za-z]:[\\/][^\s"'`]*/g, "[path]")
    .replace(/\/home\/[^\s"'`]*/g, "[path]")
    .replace(/\\\\[^\s"'`]*/g, "[path]");
  if (cleaned.length > MAX_SAFE_ERROR_LENGTH) {
    cleaned = cleaned.slice(0, MAX_SAFE_ERROR_LENGTH) + "...";
  }
  return cleaned;
}

/** Sanitizes logical URLs for safe presentation; never leaks dynamic proxy ports or credentials. */
export function sanitizeLogicalUrl(rawUrl: string | null | undefined, recordingSafe = false): string {
  if (!rawUrl || rawUrl.trim() === "") return "about:blank";
  try {
    const parsed = new URL(rawUrl);
    parsed.username = "";
    parsed.password = "";

    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      parsed.hostname = "localhost";
      const portNum = parseInt(parsed.port, 10);
      if (recordingSafe || (![80, 443, 3000, 5173, 8080].includes(portNum) && portNum >= 1024)) {
        parsed.port = "";
      }
    }

    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|key|secret|auth|pwd|password|session/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }

    let result = parsed.toString();
    if (result.endsWith("/") && parsed.pathname === "/" && !parsed.search && !parsed.hash) {
      result = result.slice(0, -1);
    }
    if (result.length > MAX_SAFE_URL_LENGTH) {
      result = result.slice(0, MAX_SAFE_URL_LENGTH);
    }
    return result;
  } catch {
    return "about:blank";
  }
}

export function actionBadgeLabel(actionType: BrowserActionType): string {
  switch (actionType) {
    case "browser_open":
      return "Opening...";
    case "browser_click":
      return "Clicking...";
    case "browser_fill":
      return "Filling...";
    case "browser_press":
      return "Pressing...";
    case "browser_refresh":
      return "Refreshing...";
    case "browser_wait":
      return "Waiting...";
    case "browser_assert":
      return "Asserting...";
    default:
      return "Executing...";
  }
}

/**
 * Validates a received frame payload against canonical bounds.
 */
export function isValidVisualFrame(raw: unknown): raw is BrowserVisualFrame {
  if (typeof raw !== "object" || raw === null) return false;
  const f = raw as Record<string, unknown>;
  if (typeof f.session_id !== "string" || f.session_id.length === 0 || f.session_id.length > 128) return false;
  if (typeof f.generation !== "number" || f.generation < 1 || !Number.isInteger(f.generation)) return false;
  if (typeof f.frame_seq !== "number" || f.frame_seq < 1 || !Number.isInteger(f.frame_seq)) return false;
  if (typeof f.width !== "number" || f.width < 1 || f.width > 3840) return false;
  if (typeof f.height !== "number" || f.height < 1 || f.height > 2160) return false;
  if (f.format !== "jpeg" && f.format !== "png" && f.format !== "webp") return false;
  if (typeof f.data !== "string" || f.data.length === 0 || f.data.length > MAX_FRAME_PAYLOAD_BYTES) return false;
  return true;
}

/**
 * Converts a base64 frame string to an object URL or data URI, revoking the old URL if provided.
 */
function createFrameDisplayUrl(
  frame: BrowserVisualFrame,
  createObjectUrl?: (blob: Blob) => string,
): string {
  if (typeof createObjectUrl === "function" && typeof atob === "function" && typeof Blob === "function") {
    try {
      const mime = `image/${frame.format}`;
      const binary = atob(frame.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mime });
      return createObjectUrl(blob);
    } catch {
      // Fall back to data URI
    }
  }
  return `data:image/${frame.format};base64,${frame.data}`;
}

/**
 * Applies a visual frame to the view state with validation, fencing, sequence checks,
 * and prompt object URL revocation.
 */
export function applyBrowserVisualFrame(
  state: BrowserViewState,
  rawFrame: unknown,
  createObjectUrl?: (blob: Blob) => string,
  revokeObjectUrl?: (url: string) => void,
): BrowserViewState {
  const stats = { ...state.stats, framesReceived: state.stats.framesReceived + 1 };

  if (!isValidVisualFrame(rawFrame)) {
    return {
      ...state,
      stats: { ...stats, invalidFramesDropped: stats.invalidFramesDropped + 1 },
    };
  }

  const frame = rawFrame;

  // Session fencing: ignore frame if session does not match
  if (state.session_id !== null && frame.session_id !== state.session_id) {
    return {
      ...state,
      stats: { ...stats, staleFramesDropped: stats.staleFramesDropped + 1 },
    };
  }

  // Generation fencing: ignore frame if generation does not match
  if (state.generation > 0 && frame.generation !== state.generation) {
    return {
      ...state,
      stats: { ...stats, staleFramesDropped: stats.staleFramesDropped + 1 },
    };
  }

  // Sequence fencing: reject duplicate or backwards frame seq
  if (state.lastFrame !== null && frame.frame_seq <= state.lastFrame.frame_seq) {
    return {
      ...state,
      stats: { ...stats, duplicateFramesDropped: stats.duplicateFramesDropped + 1 },
    };
  }

  // Revoke old object URL promptly
  if (state.lastFrame?.objectUrl && typeof revokeObjectUrl === "function") {
    if (state.lastFrame.objectUrl.startsWith("blob:")) {
      try {
        revokeObjectUrl(state.lastFrame.objectUrl);
      } catch {}
    }
  }

  const objectUrl = createFrameDisplayUrl(frame, createObjectUrl);

  const lastFrame: BrowserFrameDisplay = {
    frame_seq: frame.frame_seq,
    width: frame.width,
    height: frame.height,
    format: frame.format,
    objectUrl,
    timestamp_ms: frame.monotonic_ms,
  };

  return {
    ...state,
    session_id: state.session_id ?? frame.session_id,
    generation: state.generation > 0 ? state.generation : frame.generation,
    status: state.status === "NOT_STARTED" ? "READY" : state.status,
    lastFrame,
    stats: {
      ...stats,
      framesApplied: stats.framesApplied + 1,
    },
  };
}

/**
 * Applies a trusted browser journal event to the view state.
 */
export function applyBrowserRuntimeEvent(
  state: BrowserViewState,
  event: BrowserRuntimeEvent,
  recordingSafe = false,
): BrowserViewState {
  // Session & generation fencing
  if (state.session_id !== null && event.session_id !== state.session_id) {
    return state;
  }
  if (state.generation > 0 && event.generation !== state.generation) {
    return state;
  }

  const highestJournalSeq = Math.max(state.highestJournalSeq, event.seq);

  switch (event.type) {
    case "browser.started":
      return {
        ...state,
        session_id: event.session_id,
        generation: event.generation,
        status: "READY",
        highestJournalSeq,
      };

    case "page.opened":
      return {
        ...state,
        status: "READY",
        highestJournalSeq,
      };

    case "browser.operation.started":
      return {
        ...state,
        status: "RUNNING",
        activeBadge: {
          operation_id: event.operation_id,
          action_type: event.operation_type,
          status: "RUNNING",
          label: actionBadgeLabel(event.operation_type),
        },
        highestJournalSeq,
      };

    case "browser.navigation.completed":
      return {
        ...state,
        activeUrl: sanitizeLogicalUrl(event.url, recordingSafe),
        highestJournalSeq,
      };

    case "browser.operation.completed":
      return {
        ...state,
        status: "READY",
        activeBadge: state.activeBadge
          ? { ...state.activeBadge, status: "PASS", label: `${state.activeBadge.label.replace("...", "")} Done` }
          : null,
        highestJournalSeq,
      };

    case "browser.operation.failed": {
      const isCrash = event.error_code === "PAGE_CRASHED" || event.error_code === "BROWSER_CRASHED";
      return {
        ...state,
        status: isCrash ? "CRASHED" : "READY",
        errorMessage: sanitizeBrowserError(event.message),
        activeBadge: state.activeBadge
          ? { ...state.activeBadge, status: "FAIL", label: `${state.activeBadge.label.replace("...", "")} Failed` }
          : null,
        highestJournalSeq,
      };
    }

    case "browser.operation.cancelled":
      return {
        ...state,
        status: "READY",
        activeBadge: state.activeBadge
          ? { ...state.activeBadge, status: "CANCELLED", label: `${state.activeBadge.label.replace("...", "")} Cancelled` }
          : null,
        highestJournalSeq,
      };

    case "browser.closed":
      return {
        ...state,
        status: "CLOSED",
        activeBadge: null,
        highestJournalSeq,
      };

    default:
      return state;
  }
}

/**
 * Re-anchors session identity after reset or lesson switch, revoking old frame resources.
 */
export function reanchorBrowserSession(
  state: BrowserViewState,
  newSession: SafeBrowserSessionDescriptor,
  revokeObjectUrl?: (url: string) => void,
): BrowserViewState {
  if (state.lastFrame?.objectUrl && typeof revokeObjectUrl === "function") {
    if (state.lastFrame.objectUrl.startsWith("blob:")) {
      try {
        revokeObjectUrl(state.lastFrame.objectUrl);
      } catch {}
    }
  }

  return {
    ...initialBrowserViewState(),
    session_id: newSession.session_id,
    generation: newSession.generation,
    status: "READY",
    stats: { ...state.stats },
  };
}

/**
 * Clears display state and releases object URL resources completely.
 */
export function clearBrowserVisualState(
  state: BrowserViewState,
  revokeObjectUrl?: (url: string) => void,
): BrowserViewState {
  if (state.lastFrame?.objectUrl && typeof revokeObjectUrl === "function") {
    if (state.lastFrame.objectUrl.startsWith("blob:")) {
      try {
        revokeObjectUrl(state.lastFrame.objectUrl);
      } catch {}
    }
  }

  return {
    ...initialBrowserViewState(),
    stats: { ...state.stats },
  };
}

let requestIdCounter = 0;
/** Generates a deterministic identifier-only request ID. */
export function createBrowserRequestId(): string {
  requestIdCounter++;
  return `req-brow-${Date.now().toString(36)}-${requestIdCounter}`;
}
