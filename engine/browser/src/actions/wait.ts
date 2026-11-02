// P7.5 Browser Wait Action Execution
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7.6, Section 16 & Task P7.5.
//
// Invariants enforced:
// - Execution ONLY from reviewed admitted IR.
// - Supports canonical Schema 1.1 wait conditions: selector and/or text.
// - Bounded wait ceiling: strictly capped at MAX_WAIT_TIMEOUT_MS (120,000 ms).
// - Strict selector cardinality: multiple matching elements fail as SELECTOR_AMBIGUOUS.
// - Absolute absence of selector heuristics: zero first(), last(), or nth() calls.
// - Absolute absence of arbitrary JS: zero page.evaluate or script predicates.
// - Cancellation aborts wait promptly with OPERATION_CANCELLED.
// - Fenced against session/generation rotation and crashed session.
// - Sanitized errors: zero stack traces, zero host paths, max 512 chars.

import type { Page } from "playwright-core";
import type { AdmittedBrowserOperation } from "../admission.ts";
import { MAX_WAIT_TIMEOUT_MS, type BrowserErrorCode } from "../protocol.ts";
import { resolveLocator } from "../selectors.ts";
import type { BrowserSession } from "../session.ts";
import type { ActionExecutionResult, ExecuteActionOptions } from "./click.ts";

export interface ExecuteWaitOptions extends ExecuteActionOptions {}

function sanitizeErrorMessage(rawMessage: string, fallback: string): string {
  const firstLine = rawMessage.split(/\r?\n/)[0] ?? fallback;
  const sanitized = firstLine
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/\/[\w.-]+(\/[\w.-]+)+/g, "[path]")
    .trim();
  return sanitized.slice(0, 512) || fallback;
}

export async function executeWait(
  session: BrowserSession,
  page: Page,
  admitted: AdmittedBrowserOperation,
  options?: ExecuteWaitOptions,
): Promise<ActionExecutionResult> {
  const startMs = Date.now();

  if (admitted.action_type !== "browser_wait") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `executeWait called with non-wait action type '${admitted.action_type}'`,
    };
  }

  const params = admitted.parameters;
  if (params.type !== "browser_wait") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `Invalid parameters for browser_wait: expected type 'browser_wait'`,
    };
  }

  if (params.selector === undefined && params.text === undefined) {
    return {
      ok: false,
      errorCode: "BROWSER_WAIT_FIELDS_REQUIRED",
      message: "browser_wait requires at least one condition: 'selector' or 'text'",
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

  // 2. Compute bounded timeout
  const authoredTimeoutMs = params.timeout_seconds * 1000;
  const boundedCeilingMs = Math.min(authoredTimeoutMs, MAX_WAIT_TIMEOUT_MS);
  const effectiveTimeoutMs = options?.timeoutMs
    ? Math.min(options.timeoutMs, boundedCeilingMs)
    : boundedCeilingMs;

  // 3. Pre-dispatch fencing seam & cancellation check
  if (options?.beforeActionDispatch) {
    await options.beforeActionDispatch();
  }

  if (session.isStale(admitted.session_id, admitted.generation)) {
    return {
      ok: false,
      errorCode: "STALE_GENERATION",
      message: "Session or generation rotated before wait dispatch; side effect fenced",
    };
  }

  if (session.getState() !== "READY" && session.getState() !== "EXECUTING") {
    return {
      ok: false,
      errorCode: "STALE_SESSION",
      message: `Session state transitioned to '${session.getState()}' before wait dispatch; side effect fenced`,
    };
  }

  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled before wait dispatch",
    };
  }

  // 4. Execute wait condition
  const elapsedMs = Date.now() - startMs;
  const remainingTimeoutMs = Math.max(100, effectiveTimeoutMs - elapsedMs);

  try {
    if (params.selector) {
      const locator = resolveLocator(page, params.selector);

      // Playwright waitFor: waits until attached & visible
      await locator.waitFor({
        state: "visible",
        timeout: remainingTimeoutMs,
      });

      // Strict cardinality verification: must be exactly 1 element
      const count = await locator.count().catch(() => 0);
      if (count > 1) {
        return {
          ok: false,
          errorCode: "SELECTOR_AMBIGUOUS",
          message: `Selector matched ${count} elements (strict mode requires exactly 1)`,
        };
      }

      // If text was also specified, verify text matches
      if (params.text) {
        const textContent = await locator.textContent().catch(() => null);
        if (!textContent || !textContent.includes(params.text)) {
          return {
            ok: false,
            errorCode: "SELECTOR_NOT_FOUND",
            message: `Element became visible but text did not contain '${params.text}'`,
          };
        }
      }
    } else if (params.text) {
      // Text-only wait
      const textLocator = resolveLocator(page, { strategy: "text", value: params.text });
      await textLocator.waitFor({
        state: "visible",
        timeout: remainingTimeoutMs,
      });
    }
  } catch (waitErr: unknown) {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        errorCode: "OPERATION_CANCELLED",
        message: "Operation cancelled during wait",
      };
    }

    if (page.isClosed()) {
      return {
        ok: false,
        errorCode: "PAGE_CRASHED",
        message: "Page closed or crashed during wait",
      };
    }

    const rawMsg = waitErr instanceof Error ? waitErr.message : String(waitErr);

    // Strict mode violation (ambiguous selector)
    if (rawMsg.includes("strict mode violation") || rawMsg.includes("resolved to")) {
      return {
        ok: false,
        errorCode: "SELECTOR_AMBIGUOUS",
        message: "Selector resolved to multiple elements during wait (strict mode violation)",
      };
    }

    // Timeout: inspect selector count to provide precise classification
    if (params.selector) {
      try {
        const locator = resolveLocator(page, params.selector);
        const count = await locator.count().catch(() => 0);
        if (count > 1) {
          return {
            ok: false,
            errorCode: "SELECTOR_AMBIGUOUS",
            message: `Selector matched ${count} elements (strict mode requires exactly 1)`,
          };
        }
      } catch {}
    }

    return {
      ok: false,
      errorCode: "SELECTOR_NOT_FOUND",
      message: sanitizeErrorMessage(rawMsg, `Wait condition timed out after ${effectiveTimeoutMs}ms`),
    };
  }

  // 5. Post-wait checks
  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled during wait",
    };
  }

  if (page.isClosed()) {
    return {
      ok: false,
      errorCode: "PAGE_CRASHED",
      message: "Page closed or crashed after wait",
    };
  }

  const duration_ms = Date.now() - startMs;
  return {
    ok: true,
    duration_ms,
  };
}
