// P7.4 Semantic Selector Resolution Unit & Deterministic Tests — browser_protocol_version = 1.
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 8 and Section 17.
//
// Invariants verified:
// - Exact mapping to Playwright locators for all 5 strategies: role, label, test_id, text, css
// - Role selector preserves exactness and accessible name
// - Disallow non-standard Playwright pseudo-engines or XPath prefixes in CSS selectors
// - Strict match rule:
//   - 0 matches -> SELECTOR_NOT_FOUND
//   - >1 matches -> SELECTOR_AMBIGUOUS
//   - Exactly 1 match -> success
// - Zero heuristics: absolutely no first(), last(), nth(), or fuzzy fallback

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Page, Locator } from "playwright-core";
import {
  resolveLocator,
  resolveStrictSelector,
  validateCssSelectorForAction,
} from "../src/selectors.ts";
import type { BrowserSelector } from "../src/protocol.ts";

// Minimal mock Page to test mapping and strategy translation
function createMockPage(record: { calls: string[] }): Page {
  const mockLocator = {
    count: async () => 1,
    waitFor: async () => {},
  } as unknown as Locator;

  return {
    getByRole: (role: any, options: any) => {
      record.calls.push(`getByRole:${role}:${JSON.stringify(options)}`);
      return mockLocator;
    },
    getByLabel: (text: any, options: any) => {
      record.calls.push(`getByLabel:${text}:${JSON.stringify(options)}`);
      return mockLocator;
    },
    getByTestId: (testId: any) => {
      record.calls.push(`getByTestId:${testId}`);
      return mockLocator;
    },
    getByText: (text: any, options: any) => {
      record.calls.push(`getByText:${text}:${JSON.stringify(options)}`);
      return mockLocator;
    },
    locator: (selector: any) => {
      record.calls.push(`locator:${selector}`);
      return mockLocator;
    },
  } as unknown as Page;
}

describe("P7.4 Selectors: Strategy Mapping to Playwright Locators", () => {
  it("proves role selector maps with exact: true and optional accessible name", () => {
    const record = { calls: [] as string[] };
    const page = createMockPage(record);

    // 1. Role with accessible name
    const selWithName: BrowserSelector = {
      strategy: "role",
      value: "button",
      name: "Submit Registration",
    };
    resolveLocator(page, selWithName);
    assert.deepEqual(record.calls, [
      `getByRole:button:{"name":"Submit Registration","exact":true}`,
    ]);

    // 2. Role without accessible name
    record.calls = [];
    const selWithoutName: BrowserSelector = {
      strategy: "role",
      value: "textbox",
    };
    resolveLocator(page, selWithoutName);
    assert.deepEqual(record.calls, [
      `getByRole:textbox:{"exact":true}`,
    ]);
  });

  it("proves label selector maps with exact: true", () => {
    const record = { calls: [] as string[] };
    const page = createMockPage(record);

    const sel: BrowserSelector = {
      strategy: "label",
      value: "Username",
    };
    resolveLocator(page, sel);
    assert.deepEqual(record.calls, [
      `getByLabel:Username:{"exact":true}`,
    ]);
  });

  it("proves test_id selector maps via getByTestId", () => {
    const record = { calls: [] as string[] };
    const page = createMockPage(record);

    const sel: BrowserSelector = {
      strategy: "test_id",
      value: "submit-btn",
    };
    resolveLocator(page, sel);
    assert.deepEqual(record.calls, [
      `getByTestId:submit-btn`,
    ]);
  });

  it("proves text selector maps with exact: true", () => {
    const record = { calls: [] as string[] };
    const page = createMockPage(record);

    const sel: BrowserSelector = {
      strategy: "text",
      value: "Welcome to Course Factory",
    };
    resolveLocator(page, sel);
    assert.deepEqual(record.calls, [
      `getByText:Welcome to Course Factory:{"exact":true}`,
    ]);
  });

  it("proves css selector maps to page.locator after validation", () => {
    const record = { calls: [] as string[] };
    const page = createMockPage(record);

    const sel: BrowserSelector = {
      strategy: "css",
      value: "button.submit-primary[type='submit']",
    };
    resolveLocator(page, sel);
    assert.deepEqual(record.calls, [
      `locator:button.submit-primary[type='submit']`,
    ]);
  });

  it("rejects non-standard Playwright pseudo-selectors and XPath in CSS strategy", () => {
    const forbiddenCssPatterns = [
      "xpath=//button",
      "//button[@id='submit']",
      "text=Click Here",
      "id=submit-btn",
      "role=button",
      "button:has-text('Click')",
      "div >> span",
      "pierce/div",
    ];

    for (const pattern of forbiddenCssPatterns) {
      const check = validateCssSelectorForAction(pattern);
      assert.equal(check.ok, false, `Pattern '${pattern}' must be rejected`);

      const sel: BrowserSelector = { strategy: "css", value: pattern };
      const record = { calls: [] as string[] };
      const page = createMockPage(record);

      assert.throws(
        () => resolveLocator(page, sel),
        /\[INVALID_BROWSER_SELECTOR\]/,
      );
    }
  });

  it("rejects unknown selector strategy fail-closed", () => {
    const record = { calls: [] as string[] };
    const page = createMockPage(record);

    const sel = {
      strategy: "xpath",
      value: "//div",
    } as unknown as BrowserSelector;

    assert.throws(
      () => resolveLocator(page, sel),
      /\[INVALID_BROWSER_SELECTOR\] Unsupported selector strategy 'xpath'/,
    );
  });
});

describe("P7.4 Selectors: Strict Ambiguity Resolution Logic", () => {
  it("proves exactly 1 match resolves successfully without waiting", async () => {
    let waitForCalled = false;
    const mockLocator = {
      count: async () => 1,
      waitFor: async () => {
        waitForCalled = true;
      },
    } as unknown as Locator;

    const page = {
      getByTestId: () => mockLocator,
    } as unknown as Page;

    const res = await resolveStrictSelector(page, {
      strategy: "test_id",
      value: "unique-element",
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.matchCount, 1);
    assert.equal(waitForCalled, false, "Immediate count=1 should not require waitFor");
  });

  it("proves immediate >1 matches fails closed as SELECTOR_AMBIGUOUS without side effect", async () => {
    let waitForCalled = false;
    const mockLocator = {
      count: async () => 3,
      waitFor: async () => {
        waitForCalled = true;
      },
    } as unknown as Locator;

    const page = {
      getByTestId: () => mockLocator,
    } as unknown as Page;

    const res = await resolveStrictSelector(page, {
      strategy: "test_id",
      value: "duplicate-elements",
    });

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.errorCode, "SELECTOR_AMBIGUOUS");
    assert.equal(res.matchCount, 3);
    assert.match(res.message, /matched 3 elements/);
    assert.equal(waitForCalled, false, "Immediate >1 matches must not wait");
  });

  it("proves count=0 waits bounded time and returns SELECTOR_NOT_FOUND if still 0", async () => {
    let waitCalls = 0;
    const mockLocator = {
      count: async () => 0,
      waitFor: async () => {
        waitCalls++;
        throw new Error("locator.waitFor: Timeout 100ms exceeded.");
      },
    } as unknown as Locator;

    const page = {
      getByRole: () => mockLocator,
    } as unknown as Page;

    const res = await resolveStrictSelector(
      page,
      { strategy: "role", value: "button", name: "Missing" },
      100,
    );

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.errorCode, "SELECTOR_NOT_FOUND");
    assert.equal(res.matchCount, 0);
    assert.equal(waitCalls, 1);
  });

  it("proves count=0 transitioning to count=1 after wait succeeds", async () => {
    let countCall = 0;
    const mockLocator = {
      count: async () => {
        countCall++;
        return countCall === 1 ? 0 : 1;
      },
      waitFor: async () => {
        // Simulates element attaching during wait
      },
    } as unknown as Locator;

    const page = {
      getByText: () => mockLocator,
    } as unknown as Page;

    const res = await resolveStrictSelector(
      page,
      { strategy: "text", value: "Appeared Later" },
      500,
    );

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.matchCount, 1);
  });

  it("proves count=0 transitioning to count>1 after wait fails as SELECTOR_AMBIGUOUS", async () => {
    let countCall = 0;
    const mockLocator = {
      count: async () => {
        countCall++;
        return countCall === 1 ? 0 : 2;
      },
      waitFor: async () => {},
    } as unknown as Locator;

    const page = {
      getByText: () => mockLocator,
    } as unknown as Page;

    const res = await resolveStrictSelector(
      page,
      { strategy: "text", value: "Two Appeared Later" },
      500,
    );

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.errorCode, "SELECTOR_AMBIGUOUS");
    assert.equal(res.matchCount, 2);
  });

  it("proves strict mode violation thrown by Playwright maps to SELECTOR_AMBIGUOUS", async () => {
    const mockLocator = {
      count: async () => 0,
      waitFor: async () => {
        throw new Error("locator.waitFor: Error: strict mode violation: locator('button') resolved to 2 elements");
      },
    } as unknown as Locator;

    const page = {
      getByRole: () => mockLocator,
    } as unknown as Page;

    const res = await resolveStrictSelector(
      page,
      { strategy: "role", value: "button" },
      500,
    );

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.errorCode, "SELECTOR_AMBIGUOUS");
    assert.match(res.message, /strict mode violation/i);
  });

  it("proves cancellation signal aborts resolution cleanly with OPERATION_CANCELLED", async () => {
    const controller = new AbortController();
    controller.abort();

    const mockLocator = {
      count: async () => 1,
      waitFor: async () => {},
    } as unknown as Locator;

    const page = {
      getByTestId: () => mockLocator,
    } as unknown as Page;

    const res = await resolveStrictSelector(
      page,
      { strategy: "test_id", value: "any" },
      500,
      controller.signal,
    );

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.errorCode, "OPERATION_CANCELLED");
  });
});
