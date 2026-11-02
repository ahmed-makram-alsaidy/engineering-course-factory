// P7.5 Network Route Shield & Outbound Request Interception
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 10 & Task P7.5.
//
// Application-level network firewall installed via Playwright route interception.
// Invariants enforced:
// - Default deny: all outbound network requests outside reviewed policy fail closed.
// - WAN access blocked: public internet domains and IP addresses are aborted.
// - Localhost scanning blocked: unreviewed loopback ports on 127.0.0.1 or localhost are aborted.
// - LAN scanning blocked: private network ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16) are aborted.
// - Scheme filtering: non-http(s) schemes (file:, data:, javascript:, chrome:, etc.) are aborted.
// - Credentials filtering: URLs with embedded credentials are aborted.
// - Bridge translation: transparently rewrites authored local origins to allocated bridge proxies when necessary.
// - Deterministic: all blocked requests are tracked in an immutable diagnostic ledger.

import type { BrowserContext, Page, Route } from "playwright-core";
import type { LocalhostBridgeCoordinator } from "./bridge.ts";
import { isLocalFixtureServer } from "./fixture-server.ts";
import { canonicalizeOrigin, validateBrowserUrl } from "./protocol.ts";

export interface BlockedRequestRecord {
  readonly url: string;
  readonly origin: string;
  readonly method: string;
  readonly resourceType: string;
  readonly reason: string;
  readonly timestamp: number;
}

export interface NetworkRouteShieldOptions {
  readonly allowedOrigins?: Iterable<string>;
  readonly bridgeCoordinator?: LocalhostBridgeCoordinator;
  readonly onBlockedRequest?: (record: BlockedRequestRecord) => void;
}

/**
 * Checks if a hostname falls within private non-loopback network ranges or special-use addresses.
 */
export function isPrivateOrLocalhostScan(hostname: string, port: string, allowedOrigins: ReadonlySet<string>): boolean {
  const host = hostname.toLowerCase();

  // Loopback checks: 127.0.0.1 or localhost or ::1
  if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") {
    const defaultPort = "80"; // http default
    const effectivePort = port || defaultPort;
    const originHttp = `http://${host}:${effectivePort}`;
    const originHttps = `https://${host}:${effectivePort}`;
    const originHttpCanonical = canonicalizeOrigin(originHttp);
    const originHttpsCanonical = canonicalizeOrigin(originHttps);

    const isLoopbackAllowed =
      allowedOrigins.has(originHttpCanonical) ||
      allowedOrigins.has(originHttpsCanonical) ||
      allowedOrigins.has(`http://127.0.0.1:${effectivePort}`) ||
      allowedOrigins.has(`http://localhost:${effectivePort}`);

    return !isLoopbackAllowed;
  }

  // IPv4 private address ranges:
  // 10.0.0.0/8
  // 172.16.0.0/12
  // 192.168.0.0/16
  // 169.254.0.0/16 (link-local)
  const ipv4Parts = host.split(".").map((p) => parseInt(p, 10));
  if (ipv4Parts.length === 4 && ipv4Parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
    const [b0, b1] = ipv4Parts;
    if (b0 === 10) return true;
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    if (b0 === 192 && b1 === 168) return true;
    if (b0 === 169 && b1 === 254) return true;
    if (b0 === 0) return true; // 0.0.0.0/8
  }

  return false;
}

export class NetworkRouteShield {
  private allowedOrigins = new Set<string>();
  private bridgeCoordinator?: LocalhostBridgeCoordinator;
  private onBlockedRequest?: (record: BlockedRequestRecord) => void;
  private blockedLedger: BlockedRequestRecord[] = [];
  private activeContext: BrowserContext | null = null;
  private activePage: Page | null = null;
  private isDisposed = false;

  constructor(options?: NetworkRouteShieldOptions) {
    if (options?.allowedOrigins) {
      for (const origin of options.allowedOrigins) {
        this.addAllowedOrigin(origin);
      }
    }
    this.bridgeCoordinator = options?.bridgeCoordinator;
    this.onBlockedRequest = options?.onBlockedRequest;
  }

  /**
   * Adds an origin to the trusted allowlist after canonicalization.
   */
  addAllowedOrigin(originOrUrl: string): void {
    const validated = validateBrowserUrl(originOrUrl);
    if (validated.ok) {
      this.allowedOrigins.add(validated.canonicalOrigin);
    } else {
      try {
        const canonical = canonicalizeOrigin(originOrUrl);
        this.allowedOrigins.add(canonical);
      } catch {}
    }
  }

  /**
   * Removes an origin from the allowlist.
   */
  removeAllowedOrigin(originOrUrl: string): void {
    try {
      const canonical = canonicalizeOrigin(originOrUrl);
      this.allowedOrigins.delete(canonical);
    } catch {}
  }

  /**
   * Returns a copy of the current allowed origins set.
   */
  getAllowedOrigins(): string[] {
    return Array.from(this.allowedOrigins).sort();
  }

  /**
   * Evaluates whether a target URL is permitted under the shield's policy.
   */
  isRequestAllowed(urlString: string): { allowed: true; translatedUrl?: string } | { allowed: false; reason: string } {
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch {
      return { allowed: false, reason: "INVALID_URL" };
    }

    // 1. Allowed schemes
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { allowed: false, reason: `INVALID_SCHEME (${parsed.protocol})` };
    }

    // 2. Embedded credentials
    if (parsed.username !== "" || parsed.password !== "") {
      return { allowed: false, reason: "URL_CREDENTIALS_FORBIDDEN" };
    }

    // 3. Active local test fixture server (P7-DESIGN-SPEC Section 10.2)
    if (isLocalFixtureServer(parsed)) {
      return { allowed: true };
    }

    const canonicalOrigin = parsed.origin;

    // 4. Direct allowlist match
    if (this.allowedOrigins.has(canonicalOrigin)) {
      return { allowed: true };
    }

    // 4. Bridge bindings match and translation
    if (this.bridgeCoordinator) {
      const bindings = this.bridgeCoordinator.getActiveBindings();
      for (const binding of bindings.values()) {
        if (binding.status !== "active") continue;

        // Matches authored origin (e.g. http://localhost:3000)
        if (canonicalOrigin === canonicalizeOrigin(binding.authored_origin)) {
          // If the bridge proxy listens on a different ephemeral port, translate URL
          if (binding.proxy_listen_port && binding.bridge_origin !== binding.authored_origin) {
            const translatedUrl = new URL(parsed.pathname + parsed.search + parsed.hash, binding.bridge_origin).toString();
            return { allowed: true, translatedUrl };
          }
          return { allowed: true };
        }

        // Matches bridge proxy origin directly (e.g. http://127.0.0.1:52143)
        if (canonicalOrigin === canonicalizeOrigin(binding.bridge_origin)) {
          return { allowed: true };
        }
      }
    }

    // 5. Check if it is an unreviewed localhost port scan
    if (isPrivateOrLocalhostScan(parsed.hostname, parsed.port, this.allowedOrigins)) {
      return { allowed: false, reason: `UNAUTHORIZED_LOOPBACK_OR_PRIVATE_NET (${parsed.hostname}:${parsed.port || "80"})` };
    }

    // 6. External WAN or unauthorized origin
    return { allowed: false, reason: `ORIGIN_NOT_PERMITTED (${canonicalOrigin})` };
  }

  /**
   * Installs route interception on a BrowserContext.
   */
  async attachToContext(context: BrowserContext): Promise<void> {
    if (this.isDisposed) throw new Error("NetworkRouteShield is disposed");
    this.activeContext = context;

    await context.route("**/*", async (route: Route) => {
      await this.handleRoute(route);
    });
  }

  /**
   * Installs route interception on an individual Page.
   */
  async attachToPage(page: Page): Promise<void> {
    if (this.isDisposed) throw new Error("NetworkRouteShield is disposed");
    this.activePage = page;

    await page.route("**/*", async (route: Route) => {
      await this.handleRoute(route);
    });
  }

  /**
   * Internal route handler.
   */
  private async handleRoute(route: Route): Promise<void> {
    const request = route.request();
    const urlString = request.url();

    const decision = this.isRequestAllowed(urlString);
    if (decision.allowed) {
      try {
        if (decision.translatedUrl) {
          await route.continue({ url: decision.translatedUrl });
        } else {
          await route.continue();
        }
      } catch {}
      return;
    }

    // Request is blocked fail-closed
    let origin = "unknown";
    try {
      origin = new URL(urlString).origin;
    } catch {}

    const record: BlockedRequestRecord = {
      url: urlString,
      origin,
      method: request.method(),
      resourceType: request.resourceType(),
      reason: decision.reason,
      timestamp: Date.now(),
    };

    this.blockedLedger.push(record);
    this.onBlockedRequest?.(record);

    try {
      await route.abort("accessdenied");
    } catch {}
  }

  /**
   * Returns a copy of all blocked request records.
   */
  getBlockedRequests(): ReadonlyArray<BlockedRequestRecord> {
    return [...this.blockedLedger];
  }

  /**
   * Cleans up the shield.
   */
  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    if (this.activeContext) {
      try {
        await this.activeContext.unrouteAll({ behavior: "ignoreErrors" });
      } catch {}
      this.activeContext = null;
    }

    if (this.activePage) {
      try {
        await this.activePage.unrouteAll({ behavior: "ignoreErrors" });
      } catch {}
      this.activePage = null;
    }

    this.blockedLedger = [];
  }
}
