// P7.4 Semantic Selector Resolution & Strict Ambiguity Policy
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 8, 17 and docs/adr/ADR-0012-browser-automation-boundary.md.
//
// Invariants enforced:
// - Exact mapping to Playwright accessibility and semantic locators:
//   - role: page.getByRole(value, { name, exact: true })
//   - label: page.getByLabel(value, { exact: true })
//   - test_id: page.getByTestId(value)
//   - text: page.getByText(value, { exact: true })
//   - css: page.locator(value) (reviewed standard CSS only)
// - Strict Ambiguity Rule:
//   - 0 matches within timeout -> SELECTOR_NOT_FOUND
//   - >1 matches -> SELECTOR_AMBIGUOUS
//   - Exactly 1 match -> eligible for actionability checks
// - Zero heuristics: absolutely no first(), last(), nth(), fuzzy matching, or automatic fallback.
// - Strict count before action: ambiguity ruled out before any side effect is performed.
// - Disallow non-standard Playwright selector engine prefixes (xpath, text=, pierce, etc.).

import type { Locator, Page } from "playwright-core";
import {
  ACTION_TIMEOUT_MS,
  validateCssSelector,
  type BrowserErrorCode,
  type BrowserSelector,
} from "./protocol.ts";

export interface SelectorResolutionSuccess {
  readonly ok: true;
  readonly locator: Locator;
  readonly matchCount: 1;
}

export interface SelectorResolutionFailure {
  readonly ok: false;
  readonly locator?: Locator;
  readonly matchCount: number;
  readonly errorCode: BrowserErrorCode;
  readonly message: string;
}

export type SelectorResolutionResult = SelectorResolutionSuccess | SelectorResolutionFailure;

/**
 * Validates a CSS selector specifically for action execution.
 * Enforces standard CSS and rejects Playwright-specific engines, xpath, or pierce syntax.
 */
export function validateCssSelectorForAction(value: string): { ok: true } | { ok: false; reason: string } {
  const baseCheck = validateCssSelector(value);
  if (!baseCheck.ok) {
    return baseCheck;
  }

  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();

  if (
    lower.startsWith("xpath=") ||
    lower.startsWith("//") ||
    lower.startsWith("text=") ||
    lower.startsWith("id=") ||
    lower.startsWith("role=") ||
    lower.includes("has-text(") ||
    lower.includes(">>") ||
    lower.includes("pierce/")
  ) {
    return {
      ok: false,
      reason: "CSS selector cannot contain XPath, text engine, or pierce pseudo-syntax",
    };
  }

  return { ok: true };
}

/**
 * Maps a canonical BrowserSelector directly to a trusted Playwright Locator.
 * Strictly preserves exactness and ARIA roles. Never applies fallback heuristics.
 */
export function resolveLocator(page: Page, selector: BrowserSelector): Locator {
  switch (selector.strategy) {
    case "role": {
      // Playwright getByRole uses W3C ARIA accessibility tree
      if (selector.name !== undefined) {
        return page.getByRole(selector.value as any, {
          name: selector.name,
          exact: true,
        });
      }
      return page.getByRole(selector.value as any, {
        exact: true,
      });
    }

    case "label": {
      // Matches associated <label> text or aria-label
      return page.getByLabel(selector.value, {
        exact: true,
      });
    }

    case "test_id": {
      // Matches configured data-testid attribute
      return page.getByTestId(selector.value);
    }

    case "text": {
      // Exact substring/text matching
      return page.getByText(selector.value, {
        exact: true,
      });
    }

    case "css": {
      const check = validateCssSelectorForAction(selector.value);
      if (!check.ok) {
        throw new Error(`[INVALID_BROWSER_SELECTOR] ${check.reason}`);
      }
      return page.locator(selector.value);
    }

    default: {
      const unknownStrategy = (selector as any).strategy;
      throw new Error(
        `[INVALID_BROWSER_SELECTOR] Unsupported selector strategy '${unknownStrategy}'`,
      );
    }
  }
}

/**
 * Resolves a locator and verifies strict cardinality:
 * - 0 matches -> SELECTOR_NOT_FOUND
 * - >1 matches -> SELECTOR_AMBIGUOUS
 * - Exactly 1 match -> returns success with locator
 *
 * Checks immediate DOM count, and if zero, waits up to timeoutMs for the element
 * to attach with strict: true.
 */
export async function resolveStrictSelector(
  page: Page,
  selector: BrowserSelector,
  timeoutMs: number = ACTION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<SelectorResolutionResult> {
  let locator: Locator;
  try {
    locator = resolveLocator(page, selector);
  } catch (err) {
    return {
      ok: false,
      matchCount: 0,
      errorCode: "INVALID_BROWSER_SELECTOR",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (signal?.aborted) {
    return {
      ok: false,
      locator,
      matchCount: 0,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled before selector resolution",
    };
  }

  // 1. Initial count check
  let initialCount: number;
  try {
    initialCount = await locator.count();
  } catch (countErr) {
    return {
      ok: false,
      locator,
      matchCount: 0,
      errorCode: "PAGE_CRASHED",
      message: `Failed to inspect DOM: ${countErr instanceof Error ? countErr.message : String(countErr)}`,
    };
  }

  if (initialCount > 1) {
    return {
      ok: false,
      locator,
      matchCount: initialCount,
      errorCode: "SELECTOR_AMBIGUOUS",
      message: `Selector matched ${initialCount} elements (strict mode requires exactly 1)`,
    };
  }

  if (initialCount === 1) {
    return {
      ok: true,
      locator,
      matchCount: 1,
    };
  }

  // 2. Element not yet in DOM: wait bounded time for element to attach
  if (timeoutMs <= 0) {
    return {
      ok: false,
      locator,
      matchCount: 0,
      errorCode: "SELECTOR_NOT_FOUND",
      message: "Selector did not match any elements",
    };
  }

  try {
    await locator.waitFor({
      state: "attached",
      timeout: timeoutMs,
    });
  } catch (waitErr: unknown) {
    if (signal?.aborted) {
      return {
        ok: false,
        locator,
        matchCount: 0,
        errorCode: "OPERATION_CANCELLED",
        message: "Operation cancelled during selector resolution",
      };
    }

    const errMsg = waitErr instanceof Error ? waitErr.message : String(waitErr);

    if (errMsg.includes("strict mode violation")) {
      const lateCount = await locator.count().catch(() => 2);
      return {
        ok: false,
        locator,
        matchCount: Math.max(lateCount, 2),
        errorCode: "SELECTOR_AMBIGUOUS",
        message: "Strict mode violation: selector resolved to multiple elements",
      };
    }

    const postWaitCount = await locator.count().catch(() => 0);
    if (postWaitCount === 0) {
      return {
        ok: false,
        locator,
        matchCount: 0,
        errorCode: "SELECTOR_NOT_FOUND",
        message: `Selector did not match any elements within ${timeoutMs}ms`,
      };
    }

    if (postWaitCount > 1) {
      return {
        ok: false,
        locator,
        matchCount: postWaitCount,
        errorCode: "SELECTOR_AMBIGUOUS",
        message: `Selector matched ${postWaitCount} elements after wait (strict mode requires exactly 1)`,
      };
    }
  }

  // 3. Final cardinality verification
  let finalCount: number;
  try {
    finalCount = await locator.count();
  } catch (finalErr) {
    return {
      ok: false,
      locator,
      matchCount: 0,
      errorCode: "PAGE_CRASHED",
      message: `Failed to verify final locator count: ${finalErr instanceof Error ? finalErr.message : String(finalErr)}`,
    };
  }

  if (finalCount === 0) {
    return {
      ok: false,
      locator,
      matchCount: 0,
      errorCode: "SELECTOR_NOT_FOUND",
      message: `Selector did not match any elements within ${timeoutMs}ms`,
    };
  }

  if (finalCount > 1) {
    return {
      ok: false,
      locator,
      matchCount: finalCount,
      errorCode: "SELECTOR_AMBIGUOUS",
      message: `Selector matched ${finalCount} elements (strict mode requires exactly 1)`,
    };
  }

  return {
    ok: true,
    locator,
    matchCount: 1,
  };
}
