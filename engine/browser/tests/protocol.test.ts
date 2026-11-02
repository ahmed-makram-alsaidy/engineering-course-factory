// P7.1 Protocol Tests — browser_protocol_version = 1.
//
// Verifies all canonical protocol constants, action types, selector schemas,
// URL & origin policies, strict identifier-only DTOs, journal event schemas, and error taxonomy.
// Pure, deterministic, offline (no browser, no network, no timers).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_TIMEOUT_MS,
  BROWSER_ACTION_FAMILY,
  BROWSER_ACTION_TYPES,
  BROWSER_ADMISSION_MAX_IR_BYTES,
  BROWSER_ADMISSION_MAX_OPERATIONS,
  BROWSER_ERROR_CODES,
  BROWSER_PROTOCOL_VERSION,
  BROWSER_SELECTOR_STRATEGIES,
  BROWSER_STARTUP_TIMEOUT_MS,
  BrowserErrorCodeSchema,
  BrowserOperationOutcomeSchema,
  BrowserOperationReceiptSchema,
  BrowserRejectionSchema,
  BrowserRuntimeEventSchema,
  BrowserSelectorSchema,
  BrowserSnapshotPageSchema,
  CancelBrowserOperationRequestSchema,
  canonicalizeOrigin,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  FORBIDDEN_URL_SCHEMES,
  GetBrowserSnapshotRequestSchema,
  HOSTILE_REQUEST_KEYS,
  isBrowserActionType,
  isBrowserSelectorStrategy,
  KEY_PRESS_DELAY_MS,
  MAX_EVENTS_PER_SNAPSHOT_PAGE,
  MAX_JOURNAL_MESSAGE_LENGTH,
  MAX_REDIRECT_HOPS,
  MAX_WAIT_TIMEOUT_MS,
  NAVIGATION_TIMEOUT_MS,
  PAGE_CLOSE_TIMEOUT_MS,
  PORT_POLL_INTERVAL_MS,
  ResetBrowserRuntimeRequestSchema,
  RunBrowserOperationRequestSchema,
  SafeBrowserSessionDescriptorSchema,
  validateBrowserUrl,
  validateCssSelector,
  type BrowserActionType,
} from "../src/protocol.ts";

describe("P7.1 Protocol: Canonical Browser Action Enumeration & Constants", () => {
  it("defines exactly the seven canonical browser actions", () => {
    const expected = [
      "browser_open",
      "browser_click",
      "browser_fill",
      "browser_press",
      "browser_refresh",
      "browser_wait",
      "browser_assert",
    ];
    assert.deepEqual([...BROWSER_ACTION_TYPES], expected);
    assert.equal(BROWSER_ACTION_TYPES.length, 7);

    for (const action of expected) {
      assert.equal(isBrowserActionType(action), true);
    }
    assert.equal(isBrowserActionType("terminal_run"), false);
    assert.equal(isBrowserActionType("type_code"), false);
    assert.equal(isBrowserActionType("wait"), false);
    assert.equal(isBrowserActionType("browser_eval"), false);
  });

  it("enforces canonical browser action family", () => {
    assert.equal(BROWSER_ACTION_FAMILY, "browser");
  });

  it("exposes canonical timing constants matching design spec", () => {
    assert.equal(BROWSER_PROTOCOL_VERSION, 1);
    assert.equal(ACTION_TIMEOUT_MS, 10_000);
    assert.equal(NAVIGATION_TIMEOUT_MS, 30_000);
    assert.equal(BROWSER_STARTUP_TIMEOUT_MS, 15_000);
    assert.equal(PAGE_CLOSE_TIMEOUT_MS, 5_000);
    assert.equal(MAX_WAIT_TIMEOUT_MS, 120_000);
    assert.equal(KEY_PRESS_DELAY_MS, 25);
    assert.equal(PORT_POLL_INTERVAL_MS, 250);
    assert.equal(BROWSER_ADMISSION_MAX_IR_BYTES, 1_048_576);
    assert.equal(BROWSER_ADMISSION_MAX_OPERATIONS, 10_000);
    assert.equal(MAX_EVENTS_PER_SNAPSHOT_PAGE, 256);
    assert.equal(MAX_REDIRECT_HOPS, 10);
    assert.equal(MAX_JOURNAL_MESSAGE_LENGTH, 512);
    assert.equal(DEFAULT_VIEWPORT_WIDTH, 1280);
    assert.equal(DEFAULT_VIEWPORT_HEIGHT, 720);
  });
});

describe("P7.1 Protocol: Selector Protocol & Validation", () => {
  it("supports exactly the five canonical selector strategies", () => {
    const expected = ["role", "label", "test_id", "text", "css"];
    assert.deepEqual([...BROWSER_SELECTOR_STRATEGIES], expected);
    for (const s of expected) {
      assert.equal(isBrowserSelectorStrategy(s), true);
    }
    assert.equal(isBrowserSelectorStrategy("xpath"), false);
    assert.equal(isBrowserSelectorStrategy("id"), false);
    assert.equal(isBrowserSelectorStrategy("tag"), false);
  });

  it("accepts valid selector configurations across all strategies", () => {
    assert.doesNotThrow(() => {
      BrowserSelectorSchema.parse({ strategy: "role", value: "button", name: "Submit" });
      BrowserSelectorSchema.parse({ strategy: "role", value: "link" });
      BrowserSelectorSchema.parse({ strategy: "label", value: "Username" });
      BrowserSelectorSchema.parse({ strategy: "test_id", value: "submit-btn" });
      BrowserSelectorSchema.parse({ strategy: "text", value: "Welcome to Course Factory" });
      BrowserSelectorSchema.parse({ strategy: "css", value: ".btn-primary" });
    });
  });

  it("rejects 'name' property on non-role strategies", () => {
    const nonRoleStrategies = ["label", "test_id", "text", "css"] as const;
    for (const strat of nonRoleStrategies) {
      const res = BrowserSelectorSchema.safeParse({ strategy: strat, value: "test", name: "Forbidden" });
      assert.equal(res.success, false, `Strategy '${strat}' must not accept 'name'`);
    }
  });

  it("rejects unknown or malformed selector strategies", () => {
    assert.equal(BrowserSelectorSchema.safeParse({ strategy: "xpath", value: "//button" }).success, false);
    assert.equal(BrowserSelectorSchema.safeParse({ strategy: "", value: "button" }).success, false);
    assert.equal(BrowserSelectorSchema.safeParse({ strategy: "role", value: "" }).success, false);
  });

  it("validates CSS selector profile against script and injection patterns", () => {
    assert.equal(validateCssSelector(".btn-primary").ok, true);
    assert.equal(validateCssSelector("#main-content > div.item").ok, true);
    assert.equal(validateCssSelector("").ok, false);
    assert.equal(validateCssSelector("   ").ok, false);
    assert.equal(validateCssSelector("button\0").ok, false);
    assert.equal(validateCssSelector("a[href='javascript:alert(1)']").ok, false);
    assert.equal(validateCssSelector("div { behavior: expression(alert(1)) }").ok, false);
    assert.equal(validateCssSelector("div<script>").ok, false);
  });
});

describe("P7.1 Protocol: Pure URL and Origin Policy", () => {
  it("validates allowed schemes (http: and https:) and extracts canonical origin", () => {
    const r1 = validateBrowserUrl("http://localhost:3000/app/index.html");
    assert.equal(r1.ok, true);
    if (r1.ok) {
      assert.equal(r1.canonicalOrigin, "http://localhost:3000");
    }

    const r2 = validateBrowserUrl("https://example.com/api");
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.canonicalOrigin, "https://example.com");
    }
  });

  it("rejects forbidden URL schemes fail-closed", () => {
    const forbiddenUrls = [
      "file:///C:/secrets.txt",
      "javascript:alert(1)",
      "data:text/html,<h1>PWN</h1>",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "about:blank",
      "blob:http://localhost:3000/some-guid",
      "custom-scheme://test",
    ];

    for (const url of forbiddenUrls) {
      const res = validateBrowserUrl(url);
      assert.equal(res.ok, false, `URL '${url}' must be rejected`);
      if (!res.ok) {
        assert.equal(res.code, "INVALID_SCHEME");
      }
    }
  });

  it("rejects URLs with embedded credentials", () => {
    const credentialUrls = [
      "http://admin:secret@localhost:3000",
      "https://user:password@example.com/login",
      "http://operator@127.0.0.1:8080",
    ];

    for (const url of credentialUrls) {
      const res = validateBrowserUrl(url);
      assert.equal(res.ok, false, `URL '${url}' with credentials must be rejected`);
      if (!res.ok) {
        assert.equal(res.code, "URL_CREDENTIALS_FORBIDDEN");
      }
    }
  });

  it("rejects malformed unparseable URLs", () => {
    const malformed = ["not a url", "http://", "://broken", ""];
    for (const url of malformed) {
      const res = validateBrowserUrl(url);
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.code, "INVALID_URL");
      }
    }
  });

  it("canonicalizes origins correctly with default port normalization and IPv6 handling", () => {
    // Standard default ports are dropped by WHATWG standard
    assert.equal(canonicalizeOrigin("http://localhost:80/path"), "http://localhost");
    assert.equal(canonicalizeOrigin("https://example.com:443/test"), "https://example.com");
    assert.equal(canonicalizeOrigin("HTTP://LOCALHOST:3000"), "http://localhost:3000");
    assert.equal(canonicalizeOrigin("http://127.0.0.1:52143/"), "http://127.0.0.1:52143");
    assert.equal(canonicalizeOrigin("http://[::1]:3000/app"), "http://[::1]:3000");

    // Origin comparison is strict parsed equality, never naive prefix matching
    const o1 = canonicalizeOrigin("http://localhost:3000");
    const o2 = canonicalizeOrigin("http://localhost:3000/path/sub");
    assert.equal(o1, o2);

    const o3 = canonicalizeOrigin("http://localhost:3001");
    assert.notEqual(o1, o3);
  });
});

describe("P7.1 Protocol: Strict Identifier-Only Renderer Request DTOs", () => {
  const validRunReq = {
    session_id: "sess-001",
    operation_id: "C01-L001-S001-B001",
    request_id: "req-001",
  };

  it("accepts valid identifier-only runOperation requests", () => {
    const res = RunBrowserOperationRequestSchema.parse(validRunReq);
    assert.deepEqual(res, validRunReq);
  });

  it("rejects every hostile extra payload key on runOperation", () => {
    for (const hostileKey of HOSTILE_REQUEST_KEYS) {
      const payload = {
        ...validRunReq,
        [hostileKey]: "malicious-input",
      };
      const check = RunBrowserOperationRequestSchema.safeParse(payload);
      assert.equal(check.success, false, `runOperation must reject hostile key '${hostileKey}'`);
    }
  });

  it("accepts valid identifier-only cancelOperation requests and rejects hostile keys", () => {
    const validCancel = {
      session_id: "sess-001",
      operation_id: "C01-L001-S001-B001",
      request_id: "req-cancel-01",
    };
    assert.doesNotThrow(() => CancelBrowserOperationRequestSchema.parse(validCancel));

    for (const hostileKey of HOSTILE_REQUEST_KEYS) {
      const bad = { ...validCancel, [hostileKey]: "exploit" };
      assert.equal(CancelBrowserOperationRequestSchema.safeParse(bad).success, false);
    }
  });

  it("accepts valid snapshot requests and rejects hostile keys", () => {
    const validSnap = { session_id: "sess-001", after_seq: 0 };
    assert.doesNotThrow(() => GetBrowserSnapshotRequestSchema.parse(validSnap));
    assert.equal(GetBrowserSnapshotRequestSchema.safeParse({ ...validSnap, url: "http://bad" }).success, false);
    assert.equal(GetBrowserSnapshotRequestSchema.safeParse({ session_id: "s", after_seq: -1 }).success, false);
  });

  it("accepts valid reset requests and rejects hostile keys", () => {
    const validReset = { session_id: "sess-001", request_id: "req-reset-01" };
    assert.doesNotThrow(() => ResetBrowserRuntimeRequestSchema.parse(validReset));
    assert.equal(ResetBrowserRuntimeRequestSchema.safeParse({ ...validReset, chromiumArgs: ["--no-sandbox"] }).success, false);
  });
});

describe("P7.1 Protocol: Safe Descriptors, Receipts & Journal Event DTOs", () => {
  it("validates BrowserOperationReceipt structure", () => {
    const receipt = {
      ok: true as const,
      session_id: "sess-001",
      generation: 1,
      operation_id: "C01-L001-S001-B001",
      request_id: "req-001",
      outcome: "completed" as const,
      monotonic_ms: 123456.78,
    };
    assert.doesNotThrow(() => BrowserOperationReceiptSchema.parse(receipt));
  });

  it("validates SafeBrowserSessionDescriptor structure", () => {
    const desc = {
      session_id: "sess-001",
      generation: 1,
      lesson_id: "C01-L001",
      course_id: "C01",
      status: "ready" as const,
    };
    assert.doesNotThrow(() => SafeBrowserSessionDescriptorSchema.parse(desc));
  });

  it("validates all eight canonical browser journal events", () => {
    const events = [
      { type: "browser.started", seq: 1, monotonic_ms: 100, session_id: "s1", generation: 1 },
      { type: "page.opened", seq: 2, monotonic_ms: 150, session_id: "s1", generation: 1, page_id: "page-1" },
      {
        type: "browser.operation.started",
        seq: 3,
        monotonic_ms: 200,
        session_id: "s1",
        generation: 1,
        operation_id: "op-1",
        operation_type: "browser_open",
        request_id: "r-1",
      },
      {
        type: "browser.navigation.completed",
        seq: 4,
        monotonic_ms: 400,
        session_id: "s1",
        generation: 1,
        operation_id: "op-1",
        url: "http://localhost:3000",
        status_code: 200,
      },
      {
        type: "browser.operation.completed",
        seq: 5,
        monotonic_ms: 450,
        session_id: "s1",
        generation: 1,
        operation_id: "op-1",
        operation_type: "browser_open",
        request_id: "r-1",
        duration_ms: 250,
      },
      {
        type: "browser.operation.failed",
        seq: 6,
        monotonic_ms: 500,
        session_id: "s1",
        generation: 1,
        operation_id: "op-2",
        operation_type: "browser_click",
        request_id: "r-2",
        error_code: "SELECTOR_NOT_FOUND",
        message: "No element matching selector",
      },
      {
        type: "browser.operation.cancelled",
        seq: 7,
        monotonic_ms: 600,
        session_id: "s1",
        generation: 1,
        operation_id: "op-3",
        operation_type: "browser_wait",
        request_id: "r-3",
      },
      { type: "browser.closed", seq: 8, monotonic_ms: 700, session_id: "s1", generation: 1, reason: "session_reset" },
    ];

    for (const ev of events) {
      assert.doesNotThrow(() => BrowserRuntimeEventSchema.parse(ev), `Event '${ev.type}' must validate`);
    }
  });

  it("validates BrowserSnapshotPage DTO", () => {
    const page = {
      session_id: "sess-001",
      generation: 1,
      after_seq: 0,
      page_end_seq: 2,
      journal_high_seq: 2,
      reset: false,
      events: [
        { type: "browser.started", seq: 1, monotonic_ms: 100, session_id: "sess-001", generation: 1 },
        { type: "page.opened", seq: 2, monotonic_ms: 150, session_id: "sess-001", generation: 1, page_id: "p1" },
      ],
    };
    assert.doesNotThrow(() => BrowserSnapshotPageSchema.parse(page));
  });
});

describe("P7.1 Protocol: Error Taxonomy Completeness", () => {
  it("contains all canonical error codes defined by P7 design spec", () => {
    const expectedCodes = [
      "INVALID_REQUEST",
      "NOT_AUTHORIZED",
      "STALE_SESSION",
      "STALE_GENERATION",
      "UNREVIEWED_OPERATION",
      "WRONG_ACTION_FAMILY",
      "DUPLICATE_OPERATION_ID",
      "OUT_OF_ORDER_OPERATION",
      "OPERATION_ALREADY_COMPLETED",
      "OPERATION_ALREADY_RUNNING",
      "OPERATION_CANCELLED",
      "INVALID_URL",
      "INVALID_SCHEME",
      "URL_CREDENTIALS_FORBIDDEN",
      "ORIGIN_NOT_PERMITTED",
      "INVALID_BROWSER_SELECTOR",
      "INVALID_KEY_NAME",
      "ASSERTION_FIELD_REQUIRED",
      "BROWSER_WAIT_FIELDS_REQUIRED",
      "SELECTOR_TEXT_REQUIRES_SELECTOR",
      "POLICY_DENIED",
      "POPUP_BLOCKED",
      "BROWSER_LAUNCH_FAILED",
      "BROWSER_CRASHED",
      "PAGE_CRASHED",
      "NAVIGATION_TIMEOUT",
      "NAVIGATION_FAILED",
      "HTTP_ERROR_STATUS",
      "SELECTOR_NOT_FOUND",
      "SELECTOR_AMBIGUOUS",
      "ELEMENT_NOT_ACTIONABLE",
      "ASSERTION_FAILED",
      "PORT_UNAVAILABLE",
      "TOO_MANY_REDIRECTS",
    ];

    assert.equal(BROWSER_ERROR_CODES.length, expectedCodes.length);
    for (const code of expectedCodes) {
      assert.equal(BrowserErrorCodeSchema.safeParse(code).success, true, `Code '${code}' must be in taxonomy`);
    }

    assert.equal(BrowserErrorCodeSchema.safeParse("UNKNOWN_CODE").success, false);
  });
});
