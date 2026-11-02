// P7.5 Browser Refresh Action Execution
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7.5 & Task P7.5.
//
// Invariants enforced:
// - Execution ONLY from reviewed admitted IR.
// - Page must have been previously navigated (cannot reload about:blank).
// - Fenced against session/generation rotation and crashed session.
// - Bounded by NAVIGATION_TIMEOUT_MS (30,000 ms).
// - Success requires HTTP status < 400 AND document load event.
// - HTTP status >= 400 fails deterministically with HTTP_ERROR_STATUS.
// - Emits browser.navigation.completed journal event.
// - Sanitized errors: zero stack traces, zero host paths, max 512 chars.

import type { Page, Response } from "playwright-core";
import type { AdmittedBrowserOperation } from "../admission.ts";
import { NAVIGATION_TIMEOUT_MS } from "../protocol.ts";
import type { BrowserSessionJournal } from "../runtime.ts";
import type { BrowserSession } from "../session.ts";
import type { ActionExecutionResult, ExecuteActionOptions } from "./click.ts";

export interface ExecuteRefreshOptions extends ExecuteActionOptions {
  readonly journal?: BrowserSessionJournal;
}

function sanitizeErrorMessage(rawMessage: string, fallback: string): string {
  const firstLine = rawMessage.split(/\r?\n/)[0] ?? fallback;
  const sanitized = firstLine
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/\/[\w.-]+(\/[\w.-]+)+/g, "[path]")
    .trim();
  return sanitized.slice(0, 512) || fallback;
}

export async function executeRefresh(
  session: BrowserSession,
  page: Page,
  admitted: AdmittedBrowserOperation,
  options?: ExecuteRefreshOptions,
): Promise<ActionExecutionResult> {
  const startMs = Date.now();
  const timeoutMs = options?.timeoutMs ?? NAVIGATION_TIMEOUT_MS;

  if (admitted.action_type !== "browser_refresh") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `executeRefresh called with non-refresh action type '${admitted.action_type}'`,
    };
  }

  // 1. Session & Generation fencing check
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

  // 2. Precondition check: page must have been navigated
  const currentUrl = page.url();
  if (!currentUrl || currentUrl === "about:blank") {
    return {
      ok: false,
      errorCode: "NAVIGATION_FAILED",
      message: "Cannot refresh page: page has not been navigated to a valid URL yet",
    };
  }

  // 3. Pre-dispatch fencing seam & cancellation check
  if (options?.beforeActionDispatch) {
    await options.beforeActionDispatch();
  }

  if (session.isStale(admitted.session_id, admitted.generation)) {
    return {
      ok: false,
      errorCode: "STALE_GENERATION",
      message: "Session or generation rotated before reload dispatch; side effect fenced",
    };
  }

  if (session.getState() !== "READY" && session.getState() !== "EXECUTING") {
    return {
      ok: false,
      errorCode: "STALE_SESSION",
      message: `Session state transitioned to '${session.getState()}' before reload dispatch; side effect fenced`,
    };
  }

  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled before reload dispatch",
    };
  }

  // 4. Reload dispatch
  const elapsedMs = Date.now() - startMs;
  const remainingTimeoutMs = Math.max(100, timeoutMs - elapsedMs);

  let response: Response | null = null;
  try {
    response = await page.reload({
      waitUntil: "load",
      timeout: remainingTimeoutMs,
    });
  } catch (reloadErr: unknown) {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        errorCode: "OPERATION_CANCELLED",
        message: "Operation cancelled during reload",
      };
    }

    if (page.isClosed()) {
      return {
        ok: false,
        errorCode: "PAGE_CRASHED",
        message: "Page closed or crashed during reload",
      };
    }

    const rawMsg = reloadErr instanceof Error ? reloadErr.message : String(reloadErr);

    if (rawMsg.includes("Timeout") || rawMsg.includes("timeout")) {
      return {
        ok: false,
        errorCode: "NAVIGATION_TIMEOUT",
        message: sanitizeErrorMessage(rawMsg, "Reload timed out waiting for load event"),
      };
    }

    return {
      ok: false,
      errorCode: "NAVIGATION_FAILED",
      message: sanitizeErrorMessage(rawMsg, "Reload failed to complete"),
    };
  }

  // 5. Post-reload checks
  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled during reload",
    };
  }

  if (page.isClosed()) {
    return {
      ok: false,
      errorCode: "PAGE_CRASHED",
      message: "Page closed or crashed after reload",
    };
  }

  // 6. HTTP status validation
  if (response) {
    const status = response.status();
    if (status >= 400) {
      return {
        ok: false,
        errorCode: "HTTP_ERROR_STATUS",
        message: `HTTP reload returned error status ${status}`,
      };
    }
  }

  // 7. Record journal event
  const finalStatus = response ? response.status() : 200;
  options?.journal?.recordEvent({
    type: "browser.navigation.completed",
    session_id: session.sessionId,
    generation: session.generation,
    operation_id: admitted.operation_id,
    url: page.url(),
    status_code: finalStatus,
  });

  const duration_ms = Date.now() - startMs;
  return {
    ok: true,
    duration_ms,
  };
}
