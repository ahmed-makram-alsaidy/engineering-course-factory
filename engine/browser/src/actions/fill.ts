// P7.4 Browser Fill Action Execution
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7.3 and Section 8.
//
// Invariants enforced:
// - Value is sourced SOLELY from reviewed Compiled IR; renderer cannot supply or override it.
// - Sensitive fill payload is NEVER logged into journals, diagnostics, or error strings.
// - Strict selector resolution: 0 -> SELECTOR_NOT_FOUND, >1 -> SELECTOR_AMBIGUOUS.
// - Built-in Playwright actionability enforced: visible, editable, enabled.
// - Session and generation fencing checked before resolution AND before fill dispatch.
// - Strict mode violation during fill dispatch caught and mapped to SELECTOR_AMBIGUOUS.
// - Sanitized errors: zero stack traces, zero host paths, max 512 chars.

import type { Page } from "playwright-core";
import type { AdmittedBrowserOperation } from "../admission.ts";
import { ACTION_TIMEOUT_MS } from "../protocol.ts";
import { resolveStrictSelector } from "../selectors.ts";
import type { BrowserSession } from "../session.ts";
import type { ActionExecutionResult, ExecuteActionOptions } from "./click.ts";

/**
 * Sanitizes an error message, stripping any sensitive values or paths.
 */
function sanitizeFillErrorMessage(rawMessage: string, fallback: string): string {
  const firstLine = rawMessage.split(/\r?\n/)[0] ?? fallback;
  const sanitized = firstLine
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/\/[\w.-]+(\/[\w.-]+)+/g, "[path]")
    .trim();
  return sanitized.slice(0, 512) || fallback;
}

export async function executeFill(
  session: BrowserSession,
  page: Page,
  admitted: AdmittedBrowserOperation,
  options?: ExecuteActionOptions,
): Promise<ActionExecutionResult> {
  const startMs = Date.now();
  const timeoutMs = options?.timeoutMs ?? ACTION_TIMEOUT_MS;

  if (admitted.action_type !== "browser_fill") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `executeFill called with non-fill action type '${admitted.action_type}'`,
    };
  }

  const params = admitted.parameters;
  if (params.type !== "browser_fill") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: "Invalid parameters for browser_fill: expected type 'browser_fill'",
    };
  }

  const fillValue = params.value;

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

  // 2. Strict selector resolution
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
      message: "Session or generation rotated before fill dispatch; side effect fenced",
    };
  }

  if (session.getState() !== "READY" && session.getState() !== "EXECUTING") {
    return {
      ok: false,
      errorCode: "STALE_SESSION",
      message: `Session state transitioned to '${session.getState()}' before fill dispatch; side effect fenced`,
    };
  }

  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled before fill dispatch",
    };
  }

  // 4. Fill dispatch
  const elapsedMs = Date.now() - startMs;
  const remainingTimeoutMs = Math.max(100, timeoutMs - elapsedMs);

  try {
    await locator.fill(fillValue, {
      timeout: remainingTimeoutMs,
    });
  } catch (fillErr: unknown) {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        errorCode: "OPERATION_CANCELLED",
        message: "Operation cancelled during fill execution",
      };
    }

    const rawMsg = fillErr instanceof Error ? fillErr.message : String(fillErr);

    // Strict mode violation
    if (rawMsg.includes("strict mode violation")) {
      return {
        ok: false,
        errorCode: "SELECTOR_AMBIGUOUS",
        message: "Strict mode violation: selector resolved to multiple elements during fill",
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
        message: "Page closed or crashed during fill execution",
      };
    }

    // Non-editable, disabled, or readonly element
    if (
      rawMsg.includes("element is not enabled") ||
      rawMsg.includes("element is disabled") ||
      rawMsg.includes("Cannot fill input of type") ||
      rawMsg.includes("Element is not an <input>") ||
      rawMsg.includes("readonly")
    ) {
      return {
        ok: false,
        errorCode: "ELEMENT_NOT_ACTIONABLE",
        message: "Target element is not editable or disabled and cannot be filled",
      };
    }

    // Hidden or detached
    if (rawMsg.includes("element is not visible") || rawMsg.includes("hidden")) {
      return {
        ok: false,
        errorCode: "ELEMENT_NOT_ACTIONABLE",
        message: "Target element is not visible and cannot be filled",
      };
    }

    // Timeout: classify by count
    const postCount = await locator.count().catch(() => 0);
    if (postCount === 0) {
      return {
        ok: false,
        errorCode: "SELECTOR_NOT_FOUND",
        message: sanitizeFillErrorMessage(rawMsg, "Target element not found within action timeout"),
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
      message: sanitizeFillErrorMessage(rawMsg, "Target element was not actionable within timeout"),
    };
  }

  const duration_ms = Date.now() - startMs;
  return {
    ok: true,
    duration_ms,
  };
}
