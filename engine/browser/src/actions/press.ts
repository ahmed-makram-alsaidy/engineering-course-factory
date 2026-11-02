// P7.4 Browser Press Action Execution
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7.4.
//
// Invariants enforced:
// - Key identifier comes SOLELY from reviewed Compiled IR; renderer cannot supply it.
// - Key identifier is strictly validated before page interaction (rejects unknown/malformed keys).
// - Dispatches page.keyboard.press(admittedKey, { delay: KEY_PRESS_DELAY_MS }).
// - Visual realism delay: KEY_PRESS_DELAY_MS (25ms) per design spec.
// - Zero OS-level keyboard automation (no robotjs, nut.js, SendKeys).
// - Session and generation fencing checked before press dispatch.
// - Sanitized errors: zero stack traces, zero host paths, max 512 chars.

import type { Page } from "playwright-core";
import type { AdmittedBrowserOperation } from "../admission.ts";
import { KEY_PRESS_DELAY_MS, type BrowserErrorCode } from "../protocol.ts";
import type { BrowserSession } from "../session.ts";
import type { ActionExecutionResult, ExecuteActionOptions } from "./click.ts";

/**
 * Validates a key identifier against known safe key names or single printable characters.
 */
export function validateKeyName(key: string): { ok: true } | { ok: false; reason: string } {
  if (typeof key !== "string" || key.trim().length === 0) {
    return { ok: false, reason: "Key identifier cannot be empty" };
  }

  // Reject control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) {
    return { ok: false, reason: "Key identifier contains control characters" };
  }

  // Common valid multi-char keys (Playwright supported)
  const allowedSpecialKeys = new Set([
    "Enter",
    "Tab",
    "Backspace",
    "Escape",
    "Delete",
    "Insert",
    "Space",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "CapsLock",
    "NumLock",
    "ScrollLock",
    "Shift",
    "Control",
    "Alt",
    "Meta",
    "ContextMenu",
    "F1",
    "F2",
    "F3",
    "F4",
    "F5",
    "F6",
    "F7",
    "F8",
    "F9",
    "F10",
    "F11",
    "F12",
  ]);

  // Single characters (e.g. 'a', '1', '$', etc.) are always valid
  if (key.length === 1) {
    return { ok: true };
  }

  // Key combinations: e.g. "Control+A", "Shift+Enter"
  const parts = key.split("+");
  if (parts.length > 1) {
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length === 1) continue;
      if (!allowedSpecialKeys.has(trimmed)) {
        return { ok: false, reason: `Unknown key component in combination: '${trimmed}'` };
      }
    }
    return { ok: true };
  }

  if (allowedSpecialKeys.has(key)) {
    return { ok: true };
  }

  return { ok: false, reason: `Unrecognized key identifier '${key}'` };
}

export async function executePress(
  session: BrowserSession,
  page: Page,
  admitted: AdmittedBrowserOperation,
  options?: ExecuteActionOptions,
): Promise<ActionExecutionResult> {
  const startMs = Date.now();

  if (admitted.action_type !== "browser_press") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `executePress called with non-press action type '${admitted.action_type}'`,
    };
  }

  const params = admitted.parameters;
  if (params.type !== "browser_press") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: "Invalid parameters for browser_press: expected type 'browser_press'",
    };
  }

  const key = params.key;

  // 1. Key validation
  const keyCheck = validateKeyName(key);
  if (!keyCheck.ok) {
    return {
      ok: false,
      errorCode: "INVALID_KEY_NAME",
      message: `Invalid key name '${key}': ${keyCheck.reason}`,
    };
  }

  // 2. Session & Generation fencing check
  if (session.isStale(admitted.session_id, admitted.generation)) {
    return {
      ok: false,
      errorCode: "STALE_SESSION",
      message: `Session or generation mismatch (admitted: ${admitted.session_id} gen ${admitted.generation}, active: ${session.sessionId} gen ${session.generation})`,
    };
  }

  if (session.getState() === "CRASHED") {
    const reason = session.getCrashReason();
    return {
      ok: false,
      errorCode: reason?.code ?? "BROWSER_CRASHED",
      message: reason?.message ?? "Browser session is in CRASHED state",
    };
  }

  if (session.getState() !== "READY" && session.getState() !== "EXECUTING") {
    return {
      ok: false,
      errorCode: "STALE_SESSION",
      message: `Session is in state '${session.getState()}', not READY`,
    };
  }

  if (page.isClosed()) {
    return {
      ok: false,
      errorCode: "PAGE_CRASHED",
      message: "Target primary page is closed",
    };
  }

  // 3. Race & Fencing check before side-effect dispatch
  if (options?.beforeActionDispatch) {
    await options.beforeActionDispatch();
  }

  if (session.isStale(admitted.session_id, admitted.generation)) {
    return {
      ok: false,
      errorCode: "STALE_GENERATION",
      message: "Session or generation rotated before press dispatch; side effect fenced",
    };
  }

  if (session.getState() !== "READY" && session.getState() !== "EXECUTING") {
    return {
      ok: false,
      errorCode: "STALE_SESSION",
      message: `Session state transitioned to '${session.getState()}' before press dispatch; side effect fenced`,
    };
  }

  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled before press dispatch",
    };
  }

  // 4. Key press dispatch
  try {
    await page.keyboard.press(key, {
      delay: KEY_PRESS_DELAY_MS,
    });
  } catch (pressErr: unknown) {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        errorCode: "OPERATION_CANCELLED",
        message: "Operation cancelled during key press",
      };
    }

    const rawMsg = pressErr instanceof Error ? pressErr.message : String(pressErr);

    if (rawMsg.includes("Unknown key")) {
      return {
        ok: false,
        errorCode: "INVALID_KEY_NAME",
        message: `Unknown key identifier '${key}'`,
      };
    }

    if (
      rawMsg.includes("Target page, context or browser has been closed") ||
      rawMsg.includes("Target closed") ||
      page.isClosed()
    ) {
      return {
        ok: false,
        errorCode: "PAGE_CRASHED",
        message: "Page closed or crashed during key press",
      };
    }

    return {
      ok: false,
      errorCode: "ELEMENT_NOT_ACTIONABLE",
      message: rawMsg.split(/\r?\n/)[0]?.slice(0, 512) || "Key press failed",
    };
  }

  const duration_ms = Date.now() - startMs;
  return {
    ok: true,
    duration_ms,
  };
}
