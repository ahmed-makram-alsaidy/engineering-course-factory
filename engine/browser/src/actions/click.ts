// P7.4 Browser Click Action Execution
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7.2 and Section 8.
//
// Invariants enforced:
// - Selector resolved strictly: 0 -> SELECTOR_NOT_FOUND, >1 -> SELECTOR_AMBIGUOUS.
// - Strict count before action: ambiguity ruled out before click dispatch.
// - Built-in Playwright actionability enforced: visible, stable, enabled, receives events.
// - Zero force: true; no bypass of actionability.
// - Session and generation fencing checked before resolution AND before click dispatch.
// - Strict mode violation during click dispatch caught and mapped to SELECTOR_AMBIGUOUS.
// - Sanitized errors: zero stack traces, zero host paths, max 512 chars.

import type { Page } from "playwright-core";
import type { AdmittedBrowserOperation } from "../admission.ts";
import { ACTION_TIMEOUT_MS, type BrowserErrorCode } from "../protocol.ts";
import { resolveStrictSelector } from "../selectors.ts";
import type { BrowserSession } from "../session.ts";

export interface ExecuteActionOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Test seam to simulate reset/race condition between resolution and side-effect dispatch. */
  readonly beforeActionDispatch?: () => Promise<void>;
}

export interface ActionExecutionSuccess {
  readonly ok: true;
  readonly duration_ms: number;
}

export interface ActionExecutionFailure {
  readonly ok: false;
  readonly errorCode: BrowserErrorCode;
  readonly message: string;
}

export type ActionExecutionResult = ActionExecutionSuccess | ActionExecutionFailure;

/**
 * Sanitizes an error message into a safe, bounded diagnostic string.
 */
function sanitizeErrorMessage(rawMessage: string, fallback: string): string {
  const firstLine = rawMessage.split(/\r?\n/)[0] ?? fallback;
  // Remove host paths (e.g. E:\... or C:\...)
  const sanitized = firstLine
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/\/[\w.-]+(\/[\w.-]+)+/g, "[path]")
    .trim();
  return sanitized.slice(0, 512) || fallback;
}

export async function executeClick(
  session: BrowserSession,
  page: Page,
  admitted: AdmittedBrowserOperation,
  options?: ExecuteActionOptions,
): Promise<ActionExecutionResult> {
  const startMs = Date.now();
  const timeoutMs = options?.timeoutMs ?? ACTION_TIMEOUT_MS;

  if (admitted.action_type !== "browser_click") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `executeClick called with non-click action type '${admitted.action_type}'`,
    };
  }

  const params = admitted.parameters;
  if (params.type !== "browser_click") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `Invalid parameters for browser_click: expected type 'browser_click'`,
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

  // 2. Strict selector resolution (cardinality check)
  const resolution = await resolveStrictSelector(
    page,
    params.selector,
    timeoutMs,
    options?.signal,
  );

  if (!resolution.ok) {
    return {
      ok: false,
      errorCode: resolution.errorCode,
      message: resolution.message,
    };
  }

  const locator = resolution.locator;

  // 3. Race & Fencing check before side-effect dispatch
  if (options?.beforeActionDispatch) {
    await options.beforeActionDispatch();
  }

  if (session.isStale(admitted.session_id, admitted.generation)) {
    return {
      ok: false,
      errorCode: "STALE_GENERATION",
      message: "Session or generation rotated before click dispatch; side effect fenced",
    };
  }

  if (session.getState() !== "READY" && session.getState() !== "EXECUTING") {
    return {
      ok: false,
      errorCode: "STALE_SESSION",
      message: `Session state transitioned to '${session.getState()}' before click dispatch; side effect fenced`,
    };
  }

  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled before click dispatch",
    };
  }

  // 4. Click dispatch with strict Playwright actionability
  const elapsedMs = Date.now() - startMs;
  const remainingTimeoutMs = Math.max(100, timeoutMs - elapsedMs);

  try {
    await locator.click({
      timeout: remainingTimeoutMs,
    });
  } catch (clickErr: unknown) {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        errorCode: "OPERATION_CANCELLED",
        message: "Operation cancelled during click execution",
      };
    }

    const rawMsg = clickErr instanceof Error ? clickErr.message : String(clickErr);

    // Strict mode violation during dispatch
    if (rawMsg.includes("strict mode violation")) {
      return {
        ok: false,
        errorCode: "SELECTOR_AMBIGUOUS",
        message: "Strict mode violation: selector resolved to multiple elements during click",
      };
    }

    // Page or browser closed
    if (
      rawMsg.includes("Target page, context or browser has been closed") ||
      rawMsg.includes("Target closed") ||
      page.isClosed()
    ) {
      return {
        ok: false,
        errorCode: "PAGE_CRASHED",
        message: "Page closed or crashed during click execution",
      };
    }

    // Disabled element
    if (rawMsg.includes("element is not enabled") || rawMsg.includes("element is disabled")) {
      return {
        ok: false,
        errorCode: "ELEMENT_NOT_ACTIONABLE",
        message: "Target element is disabled and cannot receive click",
      };
    }

    // Hidden or detached element
    if (rawMsg.includes("element is not visible") || rawMsg.includes("hidden")) {
      return {
        ok: false,
        errorCode: "ELEMENT_NOT_ACTIONABLE",
        message: "Target element is not visible and cannot receive click",
      };
    }

    // Timeout: inspect current count to classify precisely
    const postCount = await locator.count().catch(() => 0);
    if (postCount === 0) {
      return {
        ok: false,
        errorCode: "SELECTOR_NOT_FOUND",
        message: sanitizeErrorMessage(rawMsg, "Target element not found within action timeout"),
      };
    }
    if (postCount > 1) {
      return {
        ok: false,
        errorCode: "SELECTOR_AMBIGUOUS",
        message: `Selector matched ${postCount} elements (strict mode requires exactly 1)`,
      };
    }

    return {
      ok: false,
      errorCode: "ELEMENT_NOT_ACTIONABLE",
      message: sanitizeErrorMessage(rawMsg, "Target element was not actionable within timeout"),
    };
  }

  const duration_ms = Date.now() - startMs;
  return {
    ok: true,
    duration_ms,
  };
}
