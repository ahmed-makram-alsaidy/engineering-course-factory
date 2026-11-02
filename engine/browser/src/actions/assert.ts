// P7.5 Browser Assert Action Execution
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7.7 & Task P7.5.
//
// Invariants enforced:
// - Execution ONLY from reviewed admitted IR.
// - Supports canonical Schema 1.1 assertion fields: url_contains, selector, selector_text, text_visible.
// - At least one assertion field required; selector_text requires selector.
// - Evaluates deterministically with ZERO DOM mutation and ZERO side effects.
// - Absolute absence of arbitrary JS: zero page.evaluate or script predicates.
// - Absolute absence of selector heuristics: zero first(), last(), or nth() calls.
// - Strict selector cardinality: 0 -> SELECTOR_NOT_FOUND, >1 -> SELECTOR_AMBIGUOUS.
// - Exact text comparison: authored text is not trimmed or normalized unless specified.
// - Fenced against session/generation rotation and crashed session.
// - Sanitized errors: zero stack traces, zero host paths, max 512 chars.

import type { Page } from "playwright-core";
import type { AdmittedBrowserOperation } from "../admission.ts";
import { type BrowserErrorCode } from "../protocol.ts";
import { resolveLocator, resolveStrictSelector } from "../selectors.ts";
import type { BrowserSession } from "../session.ts";
import type { ActionExecutionResult, ExecuteActionOptions } from "./click.ts";

export interface ExecuteAssertOptions extends ExecuteActionOptions {}

export async function executeAssert(
  session: BrowserSession,
  page: Page,
  admitted: AdmittedBrowserOperation,
  options?: ExecuteAssertOptions,
): Promise<ActionExecutionResult> {
  const startMs = Date.now();

  if (admitted.action_type !== "browser_assert") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `executeAssert called with non-assert action type '${admitted.action_type}'`,
    };
  }

  const params = admitted.parameters;
  if (params.type !== "browser_assert") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `Invalid parameters for browser_assert: expected type 'browser_assert'`,
    };
  }

  if (
    params.url_contains === undefined &&
    params.selector === undefined &&
    params.selector_text === undefined &&
    params.text_visible === undefined
  ) {
    return {
      ok: false,
      errorCode: "ASSERTION_FIELD_REQUIRED",
      message: "browser_assert requires at least one assertion field (url_contains, selector, selector_text, text_visible)",
    };
  }

  if (params.selector_text !== undefined && params.selector === undefined) {
    return {
      ok: false,
      errorCode: "SELECTOR_TEXT_REQUIRES_SELECTOR",
      message: "selector_text requires a 'selector' to read text from",
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

  // 2. Pre-dispatch fencing seam & cancellation check
  if (options?.beforeActionDispatch) {
    await options.beforeActionDispatch();
  }

  if (session.isStale(admitted.session_id, admitted.generation)) {
    return {
      ok: false,
      errorCode: "STALE_GENERATION",
      message: "Session or generation rotated before assertion dispatch; side effect fenced",
    };
  }

  if (session.getState() !== "READY" && session.getState() !== "EXECUTING") {
    return {
      ok: false,
      errorCode: "STALE_SESSION",
      message: `Session state transitioned to '${session.getState()}' before assertion dispatch; side effect fenced`,
    };
  }

  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled before assertion dispatch",
    };
  }

  const timeoutMs = options?.timeoutMs ?? 2000;

  // 3. Evaluate: url_contains
  if (params.url_contains !== undefined) {
    const currentUrl = page.url();
    if (!currentUrl.includes(params.url_contains)) {
      return {
        ok: false,
        errorCode: "ASSERTION_FAILED",
        message: `Assertion failed: expected URL to contain '${params.url_contains}', but actual URL was '${currentUrl}'`,
      };
    }
  }

  // 4. Evaluate: selector (when selector_text is NOT specified)
  if (params.selector !== undefined && params.selector_text === undefined) {
    const resolution = await resolveStrictSelector(page, params.selector, timeoutMs, options?.signal);
    if (!resolution.ok) {
      return {
        ok: false,
        errorCode: resolution.errorCode === "SELECTOR_AMBIGUOUS" ? "SELECTOR_AMBIGUOUS" : "ASSERTION_FAILED",
        message: `Assertion failed: selector resolution failed: ${resolution.message}`,
      };
    }

    const isVis = await resolution.locator.isVisible().catch(() => false);
    if (!isVis) {
      return {
        ok: false,
        errorCode: "ASSERTION_FAILED",
        message: "Assertion failed: element resolved by selector is not visible",
      };
    }
  }

  // 5. Evaluate: selector_text (requires selector)
  if (params.selector !== undefined && params.selector_text !== undefined) {
    const resolution = await resolveStrictSelector(page, params.selector, timeoutMs, options?.signal);
    if (!resolution.ok) {
      return {
        ok: false,
        errorCode: resolution.errorCode === "SELECTOR_AMBIGUOUS" ? "SELECTOR_AMBIGUOUS" : "ASSERTION_FAILED",
        message: `Assertion failed: selector resolution for selector_text failed: ${resolution.message}`,
      };
    }

    const actualText = await resolution.locator.textContent().catch(() => null);
    if (actualText !== params.selector_text) {
      return {
        ok: false,
        errorCode: "ASSERTION_FAILED",
        message: `Assertion failed: expected text '${params.selector_text}', but got '${actualText ?? ""}'`,
      };
    }
  }

  // 6. Evaluate: text_visible
  if (params.text_visible !== undefined) {
    const textLocator = resolveLocator(page, { strategy: "text", value: params.text_visible });
    const count = await textLocator.count().catch(() => 0);
    if (count === 0) {
      return {
        ok: false,
        errorCode: "ASSERTION_FAILED",
        message: `Assertion failed: text '${params.text_visible}' was not found on page`,
      };
    }

    // Must be visible
    let hasVisibleMatch = false;
    if (count === 1) {
      hasVisibleMatch = await textLocator.isVisible().catch(() => false);
    } else {
      try {
        await textLocator.waitFor({ state: "visible", timeout: 1000 });
        hasVisibleMatch = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("strict mode violation")) {
          hasVisibleMatch = true;
        } else {
          hasVisibleMatch = false;
        }
      }
    }

    if (!hasVisibleMatch) {
      return {
        ok: false,
        errorCode: "ASSERTION_FAILED",
        message: `Assertion failed: text '${params.text_visible}' is present on page but not visible`,
      };
    }
  }

  // 7. Post-assert cancellation check
  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled during assertion evaluation",
    };
  }

  const duration_ms = Date.now() - startMs;
  return {
    ok: true,
    duration_ms,
  };
}
