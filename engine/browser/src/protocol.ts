// P7.1 Browser Automation Protocol — browser_protocol_version = 1.
//
// Main-owned coordination and admission vocabulary for browser automation in Course Factory.
// Canonical authority: docs/P7-DESIGN-SPEC.md and docs/adr/ADR-0012-browser-automation-boundary.md.
//
// This module is contract-only: pure Zod schemas, deterministic constants, URL/origin canonicalization,
// error taxonomy, and identifier-only DTOs.
// Zero behavior, zero browser processes, zero network sockets, zero child_process calls.
//
// The central trust boundary:
// - Renderer is an untrusted presentation layer with ZERO automation authority.
// - Renderer requests carry session/generation/operation/request identifiers ONLY.
// - All browser action semantics (URL, selector, value, key, timeout) are resolved
//   exclusively main-side from validated Compiled IR.
// - No arbitrary JavaScript evaluation is supported or allowed.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Protocol Version
// ---------------------------------------------------------------------------

export const BROWSER_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Canonical Timing & Bounds Constants (P7-DESIGN-SPEC Section 16 & 25)
// ---------------------------------------------------------------------------

/** Action execution timeout (click, fill, press) in milliseconds. */
export const ACTION_TIMEOUT_MS = 10_000;

/** Navigation and reload timeout in milliseconds. */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/** Browser startup timeout in milliseconds. */
export const BROWSER_STARTUP_TIMEOUT_MS = 15_000;

/** Page and context close timeout in milliseconds. */
export const PAGE_CLOSE_TIMEOUT_MS = 5_000;

/** Maximum allowable authored wait timeout in milliseconds (120 seconds). */
export const MAX_WAIT_TIMEOUT_MS = 120_000;

/** Visual realism delay for key press in milliseconds. */
export const KEY_PRESS_DELAY_MS = 25;

/** Polling interval for readiness in milliseconds. */
export const PORT_POLL_INTERVAL_MS = 250;

/** Maximum byte size for compiled lesson IR during admission (1 MiB). */
export const BROWSER_ADMISSION_MAX_IR_BYTES = 1_048_576;

/** Maximum number of browser operations indexed per lesson. */
export const BROWSER_ADMISSION_MAX_OPERATIONS = 10_000;

/** Maximum number of journal events returned in a single snapshot page. */
export const MAX_EVENTS_PER_SNAPSHOT_PAGE = 256;

/** Maximum allowed automatic HTTP redirects before aborting. */
export const MAX_REDIRECT_HOPS = 10;

/** Maximum character length for journal event messages and diagnostics. */
export const MAX_JOURNAL_MESSAGE_LENGTH = 512;

/** Standard 16:9 recording resolution width. */
export const DEFAULT_VIEWPORT_WIDTH = 1280;

/** Standard 16:9 recording resolution height. */
export const DEFAULT_VIEWPORT_HEIGHT = 720;

// ---------------------------------------------------------------------------
// Identifiers & Handles
// ---------------------------------------------------------------------------

/** Canonical identifier schema: 1-128 chars alphanumeric and common delimiters. */
export const BrowserIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export type BrowserIdentifier = z.infer<typeof BrowserIdentifierSchema>;

/** Lowercase hex SHA-256 digest string (64 characters). */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256HexSchema>;

/** Opaque handle for runtime session instances and leases. */
export const OpaqueHandleSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export type OpaqueHandle = z.infer<typeof OpaqueHandleSchema>;

// ---------------------------------------------------------------------------
// Canonical Browser Action Types & Family
// ---------------------------------------------------------------------------

export const BROWSER_ACTION_TYPES = [
  "browser_open",
  "browser_click",
  "browser_fill",
  "browser_press",
  "browser_refresh",
  "browser_wait",
  "browser_assert",
] as const;

export type BrowserActionType = (typeof BROWSER_ACTION_TYPES)[number];

export function isBrowserActionType(value: string): value is BrowserActionType {
  return (BROWSER_ACTION_TYPES as readonly string[]).includes(value);
}

/** Canonical action family in Compiled IR. */
export const BROWSER_ACTION_FAMILY = "browser";

// ---------------------------------------------------------------------------
// Selector Strategies & Validation
// ---------------------------------------------------------------------------

export const BROWSER_SELECTOR_STRATEGIES = ["role", "label", "test_id", "text", "css"] as const;
export type BrowserSelectorStrategy = (typeof BROWSER_SELECTOR_STRATEGIES)[number];

export function isBrowserSelectorStrategy(value: string): value is BrowserSelectorStrategy {
  return (BROWSER_SELECTOR_STRATEGIES as readonly string[]).includes(value);
}

/**
 * Pure deterministic validation for CSS selectors.
 * Rejects control characters, NUL bytes, inline script tags, and javascript execution vectors.
 */
export function validateCssSelector(value: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "CSS selector cannot be empty or whitespace only" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { ok: false, reason: "CSS selector contains control characters or NUL bytes" };
  }
  const lower = trimmed.toLowerCase();
  if (
    lower.includes("javascript:") ||
    lower.includes("expression(") ||
    lower.includes("-moz-binding") ||
    lower.includes("<script")
  ) {
    return { ok: false, reason: "CSS selector contains forbidden script execution sequences" };
  }
  return { ok: true };
}

export const BrowserSelectorSchema = z
  .strictObject({
    strategy: z.string().min(1),
    value: z.string().min(1),
    /** Accessible name, only meaningful for role selectors. */
    name: z.string().min(1).optional(),
  })
  .superRefine((sel, ctx) => {
    if (!isBrowserSelectorStrategy(sel.strategy)) {
      ctx.addIssue({
        code: "custom",
        path: ["strategy"],
        message: `[INVALID_BROWSER_SELECTOR] unknown selector strategy '${sel.strategy}' (expected one of: ${BROWSER_SELECTOR_STRATEGIES.join(", ")})`,
      });
      return;
    }
    if (sel.name !== undefined && sel.strategy !== "role") {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: `[INVALID_BROWSER_SELECTOR] 'name' is only meaningful with strategy 'role' (got '${sel.strategy}')`,
      });
    }
    if (sel.strategy === "css") {
      const check = validateCssSelector(sel.value);
      if (!check.ok) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: `[INVALID_BROWSER_SELECTOR] invalid CSS selector: ${check.reason}`,
        });
      }
    }
  });

export type BrowserSelector = z.infer<typeof BrowserSelectorSchema>;

// ---------------------------------------------------------------------------
// URL & Origin Policy & Canonicalization
// ---------------------------------------------------------------------------

export const ALLOWED_URL_SCHEMES = ["http:", "https:"] as const;
export type AllowedUrlScheme = (typeof ALLOWED_URL_SCHEMES)[number];

export const FORBIDDEN_URL_SCHEMES = [
  "file:",
  "javascript:",
  "data:",
  "chrome:",
  "devtools:",
  "about:",
  "blob:",
] as const;

/**
 * Validates a browser URL deterministically against canonical policy.
 * Only http: and https: schemes are permitted.
 * Embedded credentials (username/password) are strictly forbidden.
 */
export function validateBrowserUrl(
  urlString: string,
): { ok: true; url: URL; canonicalOrigin: string } | { ok: false; code: BrowserErrorCode; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, code: "INVALID_URL", message: `URL '${urlString}' is not a parseable URL` };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "INVALID_SCHEME",
      message: `Only http/https URLs are allowed (got '${parsed.protocol}')`,
    };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      code: "URL_CREDENTIALS_FORBIDDEN",
      message: "URLs with embedded credentials are not allowed",
    };
  }

  const canonicalOrigin = canonicalizeOrigin(urlString);
  return { ok: true, url: parsed, canonicalOrigin };
}

/**
 * Extracts and canonicalizes the WHATWG origin from a URL or origin string.
 * Normalizes scheme and host to lowercase, drops default ports (80 for http, 443 for https),
 * preserves IPv6 bracketed formatting (e.g. http://[::1]:3000), and rejects naive string matching.
 */
export function canonicalizeOrigin(urlString: string): string {
  const parsed = new URL(urlString);
  return parsed.origin;
}

// ---------------------------------------------------------------------------
// Error Taxonomy (P7-DESIGN-SPEC Section 17)
// ---------------------------------------------------------------------------

export const BROWSER_ERROR_CODES = [
  // Protocol & Admission errors
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

  // Runtime & Execution errors
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
] as const;

export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number];
export const BrowserErrorCodeSchema = z.enum(BROWSER_ERROR_CODES);

export const BrowserRejectionSchema = z.strictObject({
  code: BrowserErrorCodeSchema,
  message: z.string().min(1).max(MAX_JOURNAL_MESSAGE_LENGTH),
  request_id: BrowserIdentifierSchema.nullable().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type BrowserRejection = z.infer<typeof BrowserRejectionSchema>;

export function browserRejection(
  code: BrowserErrorCode,
  message: string,
  request_id: string | null = null,
  details?: Record<string, unknown>,
): BrowserRejection {
  return {
    code,
    message: message.slice(0, MAX_JOURNAL_MESSAGE_LENGTH),
    request_id,
    ...(details ? { details } : {}),
  };
}

// ---------------------------------------------------------------------------
// Strict Identifier-Only Renderer Requests (P7-DESIGN-SPEC Section 6)
// ---------------------------------------------------------------------------

export const RunBrowserOperationRequestSchema = z.strictObject({
  session_id: BrowserIdentifierSchema,
  operation_id: BrowserIdentifierSchema,
  request_id: BrowserIdentifierSchema,
});
export type RunBrowserOperationRequest = z.infer<typeof RunBrowserOperationRequestSchema>;

export const CancelBrowserOperationRequestSchema = z.strictObject({
  session_id: BrowserIdentifierSchema,
  operation_id: BrowserIdentifierSchema,
  request_id: BrowserIdentifierSchema,
});
export type CancelBrowserOperationRequest = z.infer<typeof CancelBrowserOperationRequestSchema>;

export const GetBrowserSnapshotRequestSchema = z.strictObject({
  session_id: BrowserIdentifierSchema,
  after_seq: z.number().int().min(0),
});
export type GetBrowserSnapshotRequest = z.infer<typeof GetBrowserSnapshotRequestSchema>;

export const ResetBrowserRuntimeRequestSchema = z.strictObject({
  session_id: BrowserIdentifierSchema,
  request_id: BrowserIdentifierSchema,
});
export type ResetBrowserRuntimeRequest = z.infer<typeof ResetBrowserRuntimeRequestSchema>;

/**
 * Hostile extra property names that must never be accepted from renderer requests.
 */
export const HOSTILE_REQUEST_KEYS = [
  "url",
  "href",
  "selector",
  "css",
  "text",
  "value",
  "fill",
  "key",
  "javascript",
  "script",
  "html",
  "cookie",
  "cookies",
  "headers",
  "authorization",
  "downloadPath",
  "uploadPath",
  "filePath",
  "hostPath",
  "port",
  "hostPort",
  "bindAddress",
  "chromiumArgs",
  "browserFlags",
  "executablePath",
  "profilePath",
  "proxy",
  "networkMode",
] as const;

// ---------------------------------------------------------------------------
// Operation Outcome, Receipts & Descriptors
// ---------------------------------------------------------------------------

export const BrowserOperationOutcomeSchema = z.enum(["completed", "failed", "cancelled"]);
export type BrowserOperationOutcome = z.infer<typeof BrowserOperationOutcomeSchema>;

export const BrowserOperationReceiptSchema = z.strictObject({
  ok: z.literal(true),
  session_id: BrowserIdentifierSchema,
  generation: z.number().int().min(1),
  operation_id: BrowserIdentifierSchema,
  request_id: BrowserIdentifierSchema,
  outcome: BrowserOperationOutcomeSchema,
  monotonic_ms: z.number().nonnegative(),
  error_code: BrowserErrorCodeSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type BrowserOperationReceipt = z.infer<typeof BrowserOperationReceiptSchema>;

export const SafeBrowserSessionDescriptorSchema = z.strictObject({
  session_id: BrowserIdentifierSchema,
  generation: z.number().int().min(1),
  lesson_id: BrowserIdentifierSchema,
  course_id: BrowserIdentifierSchema,
  status: z.enum(["ready", "executing", "resetting", "crashed", "terminated"]),
});
export type SafeBrowserSessionDescriptor = z.infer<typeof SafeBrowserSessionDescriptorSchema>;

// ---------------------------------------------------------------------------
// Journal Event DTOs (P7-DESIGN-SPEC Section 21)
// ---------------------------------------------------------------------------

const BaseEventFields = {
  seq: z.number().int().min(1),
  monotonic_ms: z.number().nonnegative(),
  session_id: BrowserIdentifierSchema,
  generation: z.number().int().min(1),
};

export const BrowserStartedEventSchema = z.strictObject({
  type: z.literal("browser.started"),
  ...BaseEventFields,
});

export const PageOpenedEventSchema = z.strictObject({
  type: z.literal("page.opened"),
  ...BaseEventFields,
  page_id: BrowserIdentifierSchema,
});

export const BrowserOperationStartedEventSchema = z.strictObject({
  type: z.literal("browser.operation.started"),
  ...BaseEventFields,
  operation_id: BrowserIdentifierSchema,
  operation_type: z.enum(BROWSER_ACTION_TYPES),
  request_id: BrowserIdentifierSchema,
});

export const BrowserNavigationCompletedEventSchema = z.strictObject({
  type: z.literal("browser.navigation.completed"),
  ...BaseEventFields,
  operation_id: BrowserIdentifierSchema,
  url: z.string().min(1),
  status_code: z.number().int(),
});

export const BrowserOperationCompletedEventSchema = z.strictObject({
  type: z.literal("browser.operation.completed"),
  ...BaseEventFields,
  operation_id: BrowserIdentifierSchema,
  operation_type: z.enum(BROWSER_ACTION_TYPES),
  request_id: BrowserIdentifierSchema,
  duration_ms: z.number().nonnegative(),
});

export const BrowserOperationFailedEventSchema = z.strictObject({
  type: z.literal("browser.operation.failed"),
  ...BaseEventFields,
  operation_id: BrowserIdentifierSchema,
  operation_type: z.enum(BROWSER_ACTION_TYPES),
  request_id: BrowserIdentifierSchema,
  error_code: BrowserErrorCodeSchema,
  message: z.string().min(1).max(MAX_JOURNAL_MESSAGE_LENGTH),
});

export const BrowserOperationCancelledEventSchema = z.strictObject({
  type: z.literal("browser.operation.cancelled"),
  ...BaseEventFields,
  operation_id: BrowserIdentifierSchema,
  operation_type: z.enum(BROWSER_ACTION_TYPES),
  request_id: BrowserIdentifierSchema,
});

export const BrowserClosedEventSchema = z.strictObject({
  type: z.literal("browser.closed"),
  ...BaseEventFields,
  reason: z.string().min(1).max(MAX_JOURNAL_MESSAGE_LENGTH).optional(),
});

export const BrowserRuntimeEventSchema = z.discriminatedUnion("type", [
  BrowserStartedEventSchema,
  PageOpenedEventSchema,
  BrowserOperationStartedEventSchema,
  BrowserNavigationCompletedEventSchema,
  BrowserOperationCompletedEventSchema,
  BrowserOperationFailedEventSchema,
  BrowserOperationCancelledEventSchema,
  BrowserClosedEventSchema,
]);
export type BrowserRuntimeEvent = z.infer<typeof BrowserRuntimeEventSchema>;

export const BrowserSnapshotPageSchema = z.strictObject({
  session_id: BrowserIdentifierSchema,
  generation: z.number().int().min(1),
  after_seq: z.number().int().min(0),
  page_end_seq: z.number().int().min(0),
  journal_high_seq: z.number().int().min(0),
  reset: z.boolean(),
  events: z.array(BrowserRuntimeEventSchema).max(MAX_EVENTS_PER_SNAPSHOT_PAGE),
});
export type BrowserSnapshotPage = z.infer<typeof BrowserSnapshotPageSchema>;

// ---------------------------------------------------------------------------
// Canonical IPC Channels & Frame Contract (P7-DESIGN-SPEC Section 6.2, ADR-0012)
// ---------------------------------------------------------------------------

export const BROWSER_INVOKE_CHANNELS = Object.freeze([
  "browser:runOperation",
  "browser:cancelOperation",
  "browser:getSnapshot",
  "browser:resetRuntime",
] as const);
export type BrowserInvokeChannel = (typeof BROWSER_INVOKE_CHANNELS)[number];

export const BROWSER_EVENT_CHANNEL = "browser:event";
export const BROWSER_FRAME_CHANNEL = "browser:frame";

export const BROWSER_FRAME_FORMATS = ["jpeg", "webp", "png"] as const;
export type BrowserFrameFormat = (typeof BROWSER_FRAME_FORMATS)[number];

export const MAX_FRAME_DATA_BYTES = 2 * 1024 * 1024; // 2 MiB bound

export const BrowserVisualFrameSchema = z.strictObject({
  session_id: BrowserIdentifierSchema,
  generation: z.number().int().min(1),
  frame_seq: z.number().int().min(1),
  monotonic_ms: z.number().nonnegative(),
  width: z.number().int().min(1).max(3840),
  height: z.number().int().min(1).max(2160),
  format: z.enum(BROWSER_FRAME_FORMATS),
  data: z.string().max(MAX_FRAME_DATA_BYTES),
});
export type BrowserVisualFrame = z.infer<typeof BrowserVisualFrameSchema>;

