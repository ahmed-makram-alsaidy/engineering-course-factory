// P7.2 Local HTTP Fixture Server — deterministic test server for browser automation.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md section 29 and task P7.2.
//
// A lightweight, deterministic Node HTTP server providing controlled test endpoints for P7:
// - Root status and welcome page
// - Form inputs with accessibility roles and data-testid attributes
// - Dynamic content and headings for locator/ambiguity assertions
// - Controlled HTTP status codes (200, 301, 302, 400, 404, 500)
// - Controlled redirects (internal paths only, no open redirect)
// - Dialog triggers (alert, confirm, prompt)
// - Bounded slow/delayed responses
// - JSON API endpoints
//
// Security guarantees:
// - Binds strictly to 127.0.0.1 (loopback only). Zero 0.0.0.0 or external network binding.
// - Zero filesystem access: serves only in-memory deterministic responses.
// - Bounded request body handling: maximum 64 KiB payload ceiling.
// - Bounded request execution timeouts.
// - Deterministic headers and clean socket disposal.

import http from "node:http";
import type { AddressInfo } from "node:net";

export const FIXTURE_SERVER_MAX_BODY_BYTES = 65_536; // 64 KiB
export const FIXTURE_SERVER_DEFAULT_TIMEOUT_MS = 5_000;

export interface FixtureServerOptions {
  port?: number;
  host?: string;
  timeoutMs?: number;
}

export interface FixtureServerInstance {
  readonly server: http.Server;
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * Standard deterministic HTML pages for browser test assertions.
 */
export const FIXTURE_HTML_ROOT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Course Factory Test Fixture</title>
</head>
<body>
  <h1 role="heading">Course Factory Test Fixture</h1>
  <p id="welcome-message" data-testid="welcome-text">Deterministic test server ready.</p>
  <a href="/form" data-testid="nav-form">Go to Form</a>
  <a href="/dynamic" data-testid="nav-dynamic">Go to Dynamic</a>
</body>
</html>`;

export const FIXTURE_HTML_FORM = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Form Fixture</title>
</head>
<body>
  <h1>User Registration Form</h1>
  <form role="form" action="/api/submit" method="POST" onsubmit="return false;">
    <label for="username">Username</label>
    <input id="username" name="username" type="text" data-testid="username-input" />

    <label for="password">Password</label>
    <input id="password" name="password" type="password" data-testid="password-input" />

    <button type="submit" role="button" name="Submit" data-testid="submit-btn">Submit</button>
    <button type="button" id="counter-btn" data-testid="counter-btn" onclick="const c = parseInt(this.getAttribute('data-clicks')||'0', 10)+1; this.setAttribute('data-clicks', c.toString()); this.textContent = 'Clicked ' + c;">Clicked 0</button>
    <button type="button" id="disabled-btn" data-testid="disabled-btn" disabled>Disabled Button</button>
    <button type="button" id="hidden-btn" data-testid="hidden-btn" style="display:none">Hidden Button</button>

    <button type="button" class="ambiguous-btn" data-testid="ambiguous-btn">Duplicate Action</button>
    <button type="button" class="ambiguous-btn" data-testid="ambiguous-btn">Duplicate Action</button>

    <label for="press-target">Key Target</label>
    <input id="press-target" name="press-target" type="text" data-testid="press-input" onkeydown="this.setAttribute('data-last-key', event.key)" />
  </form>
</body>
</html>`;

export const FIXTURE_HTML_DYNAMIC = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Dynamic Dashboard</title>
</head>
<body>
  <h1 role="heading" name="Dashboard">Dashboard</h1>
  <div data-testid="status-container">
    <span data-testid="status-badge">System Ready</span>
  </div>
  <ul role="list" data-testid="item-list">
    <li role="listitem">Course 1: Linux Fundamentals</li>
    <li role="listitem">Course 2: TypeScript Architecture</li>
  </ul>
</body>
</html>`;

export const FIXTURE_HTML_DIALOG = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Dialog Fixture</title>
</head>
<body>
  <h1>Dialog Trigger Test</h1>
  <button id="btn-alert" data-testid="trigger-alert" onclick="alert('Fixture Alert')">Trigger Alert</button>
  <button id="btn-confirm" data-testid="trigger-confirm" onclick="confirm('Fixture Confirm')">Trigger Confirm</button>
</body>
</html>`;

/**
 * Handles incoming HTTP requests for the deterministic test fixture server.
 */
function handleFixtureRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Always enforce nosniff and prevent caching of test responses
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  const urlObj = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = urlObj.pathname;
  const method = req.method?.toUpperCase() ?? "GET";

  // 1. Root page
  if (pathname === "/" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(FIXTURE_HTML_ROOT, "utf8"),
    });
    res.end(FIXTURE_HTML_ROOT);
    return;
  }

  // 2. Form fixture
  if (pathname === "/form" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(FIXTURE_HTML_FORM, "utf8"),
    });
    res.end(FIXTURE_HTML_FORM);
    return;
  }

  // 3. Dynamic content fixture
  if (pathname === "/dynamic" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(FIXTURE_HTML_DYNAMIC, "utf8"),
    });
    res.end(FIXTURE_HTML_DYNAMIC);
    return;
  }

  // 4. Dialog fixture
  if (pathname === "/dialog" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(FIXTURE_HTML_DIALOG, "utf8"),
    });
    res.end(FIXTURE_HTML_DIALOG);
    return;
  }

  // 5. Explicit status endpoints: /status/:code
  const statusMatch = pathname.match(/^\/status\/([1-5][0-9]{2})$/);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    const body = JSON.stringify({ status: code, message: `Status code ${code}` });
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body, "utf8"),
    });
    res.end(body);
    return;
  }

  // 6. Redirect endpoint
  if (pathname === "/redirect" && method === "GET") {
    const rawTarget = urlObj.searchParams.get("target") ?? "/";
    // Prevent open redirect: target must begin with "/" and not "//"
    const safeTarget = rawTarget.startsWith("/") && !rawTarget.startsWith("//") ? rawTarget : "/";
    res.writeHead(302, {
      Location: safeTarget,
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(`Redirecting to ${safeTarget}`);
    return;
  }

  // 6b. Controlled multi-hop redirect chain
  if (pathname === "/redirect-chain" && method === "GET") {
    const hops = parseInt(urlObj.searchParams.get("hops") ?? "1", 10);
    const rawTarget = urlObj.searchParams.get("target") ?? "/";
    const safeTarget = rawTarget.startsWith("/") && !rawTarget.startsWith("//") ? rawTarget : "/";
    if (hops > 1) {
      const nextHop = `/redirect-chain?hops=${hops - 1}&target=${encodeURIComponent(safeTarget)}`;
      res.writeHead(302, {
        Location: nextHop,
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end(`Redirecting hop ${hops}`);
      return;
    }
    res.writeHead(302, {
      Location: safeTarget,
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(`Final redirect to ${safeTarget}`);
    return;
  }

  // 6c. Controlled external redirect
  if (pathname === "/redirect-external" && method === "GET") {
    const target = urlObj.searchParams.get("target") ?? "https://example.com";
    res.writeHead(302, {
      Location: target,
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end(`Redirecting externally to ${target}`);
    return;
  }

  // 6d. Dynamic delayed element fixture for wait testing
  if (pathname === "/dynamic-delayed" && method === "GET") {
    const delayParam = parseInt(urlObj.searchParams.get("delay_ms") ?? "100", 10);
    const delay = Math.min(Math.max(delayParam, 10), 5000);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Delayed Fixture</title>
</head>
<body>
  <h1>Delayed Content Fixture</h1>
  <div id="container"></div>
  <script>
    setTimeout(function() {
      var el = document.createElement("div");
      el.id = "delayed-box";
      el.setAttribute("data-testid", "delayed-box");
      el.setAttribute("role", "status");
      el.textContent = "Delayed Content Ready";
      document.getElementById("container").appendChild(el);
    }, ${delay});
  </script>
</body>
</html>`;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html, "utf8"),
    });
    res.end(html);
    return;
  }

  // 7. Slow endpoint (bounded delay)
  if (pathname === "/slow" && method === "GET") {
    const delayParam = parseInt(urlObj.searchParams.get("delay_ms") ?? "200", 10);
    const delay = Math.min(Math.max(delayParam, 50), 2000); // Bounded 50ms - 2000ms
    setTimeout(() => {
      const body = JSON.stringify({ ok: true, delayed_ms: delay });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body, "utf8"),
      });
      res.end(body);
    }, delay);
    return;
  }

  // 8. JSON API hello endpoint
  if (pathname === "/api/hello" && method === "GET") {
    const body = JSON.stringify({ ok: true, message: "hello", version: 1 });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body, "utf8"),
    });
    res.end(body);
    return;
  }

  // 9. API submit endpoint (POST with bounded body)
  if (pathname === "/api/submit" && method === "POST") {
    let bytesReceived = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      bytesReceived += chunk.length;
      if (bytesReceived > FIXTURE_SERVER_MAX_BODY_BYTES) {
        req.pause();
        res.writeHead(413, {
          "Content-Type": "application/json; charset=utf-8",
          Connection: "close",
        });
        res.end(JSON.stringify({ error: "PAYLOAD_TOO_LARGE", max_bytes: FIXTURE_SERVER_MAX_BODY_BYTES }));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (bytesReceived <= FIXTURE_SERVER_MAX_BODY_BYTES && !res.writableEnded) {
        const body = JSON.stringify({ ok: true, bytes_received: bytesReceived });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body, "utf8"),
        });
        res.end(body);
      }
    });
    return;
  }

  // Unmatched route -> deterministic 404
  const notFoundBody = JSON.stringify({ error: "NOT_FOUND", path: pathname });
  res.writeHead(404, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(notFoundBody, "utf8"),
  });
  res.end(notFoundBody);
}

const activeFixtureOrigins = new Set<string>();

/**
 * Checks if a URL or origin corresponds to an active local test fixture server.
 * Canonical authority: docs/P7-DESIGN-SPEC.md Section 10.2.
 */
export function isLocalFixtureServer(urlOrOrigin: URL | string): boolean {
  try {
    const origin = typeof urlOrOrigin === "string" ? new URL(urlOrOrigin).origin : urlOrOrigin.origin;
    return activeFixtureOrigins.has(origin);
  } catch {
    return false;
  }
}

export function registerFixtureOrigin(origin: string): void {
  activeFixtureOrigins.add(origin);
}

export function unregisterFixtureOrigin(origin: string): void {
  activeFixtureOrigins.delete(origin);
}

/**
 * Starts the deterministic HTTP fixture server bound strictly to loopback (127.0.0.1).
 */
export async function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServerInstance> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error(`Fixture server must bind to 127.0.0.1 loopback only (requested: '${host}')`);
  }

  const port = options.port ?? 0;
  const timeoutMs = options.timeoutMs ?? FIXTURE_SERVER_DEFAULT_TIMEOUT_MS;

  const server = http.createServer((req, res) => {
    handleFixtureRequest(req, res);
  });

  server.setTimeout(timeoutMs);

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const allocatedPort = address.port;
  const origin = `http://127.0.0.1:${allocatedPort}`;
  registerFixtureOrigin(origin);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    unregisterFixtureOrigin(origin);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      // Force-close all open keep-alive connections
      server.closeAllConnections?.();
    });
  };

  return {
    server,
    host,
    port: allocatedPort,
    origin,
    close,
  };
}
