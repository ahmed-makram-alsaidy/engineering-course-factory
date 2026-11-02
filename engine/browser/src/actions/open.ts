// P7.5 Browser Open Action Execution
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7.1, Section 9, Section 10.
//
// Invariants enforced:
// - Execution ONLY from reviewed admitted IR; renderer provides zero URL authority.
// - URL protocol validated strictly: http: or https: only.
// - Embedded credentials strictly forbidden.
// - Origin checked against reviewed allowlist, active bridge, or local fixture.
// - Target origin validated before navigation and revalidated on every redirect hop.
// - Maximum redirect hops strictly bounded (MAX_REDIRECT_HOPS = 10).
// - Navigation bounded by NAVIGATION_TIMEOUT_MS (30,000 ms).
// - Success requires HTTP status < 400 AND document load event.
// - HTTP status >= 400 fails deterministically with HTTP_ERROR_STATUS.
// - Route shield active throughout navigation: unreviewed requests aborted.
// - Emits browser.navigation.completed journal event.
// - Sanitized errors: zero stack traces, zero host paths, max 512 chars.

import type { Page, Response } from "playwright-core";
import type { AdmittedBrowserOperation } from "../admission.ts";
import type { LocalhostBridgeCoordinator } from "../bridge.ts";
import { isLocalFixtureServer } from "../fixture-server.ts";
import type { ReviewedBrowserPolicyV1 } from "../policy.ts";
import {
  canonicalizeOrigin,
  MAX_REDIRECT_HOPS,
  NAVIGATION_TIMEOUT_MS,
  validateBrowserUrl,
  type BrowserErrorCode,
} from "../protocol.ts";
import type { BrowserSessionJournal } from "../runtime.ts";
import type { BrowserSession } from "../session.ts";
import type { ActionExecutionResult, ExecuteActionOptions } from "./click.ts";

export interface ExecuteOpenOptions extends ExecuteActionOptions {
  readonly policy?: ReviewedBrowserPolicyV1;
  readonly bridgeCoordinator?: LocalhostBridgeCoordinator;
  readonly journal?: BrowserSessionJournal;
  readonly allowedOrigins?: Iterable<string>;
}

function sanitizeErrorMessage(rawMessage: string, fallback: string): string {
  const firstLine = rawMessage.split(/\r?\n/)[0] ?? fallback;
  const sanitized = firstLine
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[path]")
    .replace(/\/[\w.-]+(\/[\w.-]+)+/g, "[path]")
    .trim();
  return sanitized.slice(0, 512) || fallback;
}

/**
 * Checks if a canonical origin is permitted under current policy, bridge, or custom allowlist.
 */
export function isOriginPermitted(
  canonicalOrigin: string,
  options?: {
    policy?: ReviewedBrowserPolicyV1;
    bridgeCoordinator?: LocalhostBridgeCoordinator;
    allowedOrigins?: Iterable<string>;
  },
): boolean {
  // Allow local test fixture server (P7-DESIGN-SPEC Section 10.2)
  if (isLocalFixtureServer(canonicalOrigin)) {
    return true;
  }

  // Check policy allowed origins
  if (options?.policy?.allowed_origins.includes(canonicalOrigin)) {
    return true;
  }

  // Check custom allowed origins (e.g. fixture server)
  if (options?.allowedOrigins) {
    for (const allowed of options.allowedOrigins) {
      try {
        if (canonicalizeOrigin(allowed) === canonicalOrigin) {
          return true;
        }
      } catch {}
    }
  }

  // Check active bridge bindings
  if (options?.bridgeCoordinator) {
    const bindings = options.bridgeCoordinator.getActiveBindings();
    for (const binding of bindings.values()) {
      if (binding.status !== "active") continue;
      try {
        if (canonicalizeOrigin(binding.authored_origin) === canonicalOrigin) return true;
        if (canonicalizeOrigin(binding.bridge_origin) === canonicalOrigin) return true;
      } catch {}
    }
  }

  return false;
}

export async function executeOpen(
  session: BrowserSession,
  page: Page,
  admitted: AdmittedBrowserOperation,
  options?: ExecuteOpenOptions,
): Promise<ActionExecutionResult> {
  const startMs = Date.now();
  const timeoutMs = options?.timeoutMs ?? NAVIGATION_TIMEOUT_MS;

  if (admitted.action_type !== "browser_open") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `executeOpen called with non-open action type '${admitted.action_type}'`,
    };
  }

  const params = admitted.parameters;
  if (params.type !== "browser_open" || typeof params.url !== "string") {
    return {
      ok: false,
      errorCode: "INVALID_REQUEST",
      message: `Invalid parameters for browser_open: expected type 'browser_open' with url`,
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

  // 2. Canonical URL validation
  const urlCheck = validateBrowserUrl(params.url);
  if (!urlCheck.ok) {
    return {
      ok: false,
      errorCode: urlCheck.code,
      message: urlCheck.message,
    };
  }

  // 3. Origin policy check
  if (!isOriginPermitted(urlCheck.canonicalOrigin, options)) {
    return {
      ok: false,
      errorCode: "ORIGIN_NOT_PERMITTED",
      message: `Navigation target origin '${urlCheck.canonicalOrigin}' is not permitted by reviewed policy`,
    };
  }

  // 4. Pre-dispatch fencing seam & cancellation check
  if (options?.beforeActionDispatch) {
    await options.beforeActionDispatch();
  }

  if (session.isStale(admitted.session_id, admitted.generation)) {
    return {
      ok: false,
      errorCode: "STALE_GENERATION",
      message: "Session or generation rotated before navigation dispatch; side effect fenced",
    };
  }

  if (session.getState() !== "READY" && session.getState() !== "EXECUTING") {
    return {
      ok: false,
      errorCode: "STALE_SESSION",
      message: `Session state transitioned to '${session.getState()}' before navigation dispatch; side effect fenced`,
    };
  }

  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled before navigation dispatch",
    };
  }

  // 5. Navigation dispatch
  const elapsedMs = Date.now() - startMs;
  const remainingTimeoutMs = Math.max(100, timeoutMs - elapsedMs);

  let targetUrl = params.url;
  if (options?.bridgeCoordinator) {
    const bindings = options.bridgeCoordinator.getActiveBindings();
    for (const binding of bindings.values()) {
      if (binding.status === "active" && canonicalizeOrigin(binding.authored_origin) === urlCheck.canonicalOrigin) {
        if (binding.bridge_origin !== binding.authored_origin) {
          const u = new URL(params.url);
          targetUrl = new URL(u.pathname + u.search + u.hash, binding.bridge_origin).toString();
        }
        break;
      }
    }
  }

  let response: Response | null = null;
  try {
    response = await page.goto(targetUrl, {
      waitUntil: "load",
      timeout: remainingTimeoutMs,
    });
  } catch (navErr: unknown) {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        errorCode: "OPERATION_CANCELLED",
        message: "Operation cancelled during navigation",
      };
    }

    if (page.isClosed()) {
      return {
        ok: false,
        errorCode: "PAGE_CRASHED",
        message: "Page closed or crashed during navigation",
      };
    }

    const rawMsg = navErr instanceof Error ? navErr.message : String(navErr);

    if (rawMsg.includes("Timeout") || rawMsg.includes("timeout")) {
      return {
        ok: false,
        errorCode: "NAVIGATION_TIMEOUT",
        message: sanitizeErrorMessage(rawMsg, "Navigation timed out waiting for load event"),
      };
    }

    if (
      rawMsg.includes("net::ERR_BLOCKED_BY_CLIENT") ||
      rawMsg.includes("net::ERR_ACCESS_DENIED") ||
      rawMsg.includes("accessdenied")
    ) {
      return {
        ok: false,
        errorCode: "ORIGIN_NOT_PERMITTED",
        message: "Navigation destination was blocked by network route shield",
      };
    }

    return {
      ok: false,
      errorCode: "NAVIGATION_FAILED",
      message: sanitizeErrorMessage(rawMsg, "Navigation failed to complete"),
    };
  }

  // 6. Post-navigation checks: cancellation and page closure
  if (options?.signal?.aborted) {
    return {
      ok: false,
      errorCode: "OPERATION_CANCELLED",
      message: "Operation cancelled during navigation",
    };
  }

  if (page.isClosed()) {
    return {
      ok: false,
      errorCode: "PAGE_CRASHED",
      message: "Page closed or crashed after navigation",
    };
  }

  // 7. Redirect chain validation & bounds
  if (response) {
    let redirectCount = 0;
    let req = response.request();
    const chainUrls: string[] = [req.url()];

    while (req.redirectedFrom()) {
      redirectCount++;
      req = req.redirectedFrom()!;
      chainUrls.push(req.url());
    }

    if (redirectCount > MAX_REDIRECT_HOPS) {
      return {
        ok: false,
        errorCode: "TOO_MANY_REDIRECTS",
        message: `Navigation exceeded maximum redirect limit of ${MAX_REDIRECT_HOPS} hops (followed ${redirectCount})`,
      };
    }

    // Every intermediate redirect destination must be in the reviewed allowlist
    for (const chainUrl of chainUrls) {
      const parsedChain = validateBrowserUrl(chainUrl);
      if (!parsedChain.ok) {
        return {
          ok: false,
          errorCode: parsedChain.code,
          message: `Redirect destination rejected: ${parsedChain.message}`,
        };
      }
      if (!isOriginPermitted(parsedChain.canonicalOrigin, options)) {
        return {
          ok: false,
          errorCode: "ORIGIN_NOT_PERMITTED",
          message: `Redirect to unreviewed origin '${parsedChain.canonicalOrigin}' blocked fail-closed`,
        };
      }
    }

    // 8. HTTP status validation: HTTP >= 400 is an operation failure
    const status = response.status();
    if (status >= 400) {
      return {
        ok: false,
        errorCode: "HTTP_ERROR_STATUS",
        message: `HTTP navigation returned error status ${status}`,
      };
    }
  }

  // 9. Final origin validation on settled page URL
  try {
    const finalOrigin = canonicalizeOrigin(page.url());
    if (!isOriginPermitted(finalOrigin, options)) {
      return {
        ok: false,
        errorCode: "ORIGIN_NOT_PERMITTED",
        message: `Page settled on unreviewed origin '${finalOrigin}'`,
      };
    }
  } catch {
    return {
      ok: false,
      errorCode: "NAVIGATION_FAILED",
      message: "Could not canonicalize settled page URL",
    };
  }

  // 10. Record journal event
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
