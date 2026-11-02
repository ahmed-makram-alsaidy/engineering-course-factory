// P7.2 Host-Side Loopback Reverse Proxy — collision-free origin translation.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md section 11 & 12, and task P7.2.
//
// Proxies HTTP traffic between the authored lesson origin (e.g. http://localhost:3000)
// and the dynamically allocated ephemeral container port (e.g. 127.0.0.1:52143):
// - Strictly binds 127.0.0.1 (IPv4 loopback). Rejects wildcard 0.0.0.0 or LAN binding.
// - Strictly targets 127.0.0.1. Rejects arbitrary internet or LAN routing.
// - Tightly bound to a single reviewed container endpoint (no localhost port scanning).
// - Preserves Host header so virtual hosts / dev servers work as authored.
// - Graceful error handling: returns 502 Bad Gateway if the guest server is offline/crashing.
// - Bounded connection timeouts and deterministic close barrier.

import http from "node:http";
import type { AddressInfo } from "node:net";

export const PROXY_DEFAULT_TIMEOUT_MS = 10_000;

export interface LoopbackReverseProxyOptions {
  listenPort?: number;
  targetPort: number;
  listenHost?: string;
  targetHost?: string;
  timeoutMs?: number;
  fallbackToEphemeral?: boolean;
}

export interface LoopbackReverseProxyInstance {
  readonly server: http.Server;
  readonly listenPort: number;
  readonly targetPort: number;
  readonly listenOrigin: string;
  readonly targetOrigin: string;
  close(): Promise<void>;
}

/**
 * Starts a host-side loopback reverse proxy translating between listenPort and targetPort on 127.0.0.1.
 */
export async function startLoopbackReverseProxy(
  options: LoopbackReverseProxyOptions,
): Promise<LoopbackReverseProxyInstance> {
  const listenHost = options.listenHost ?? "127.0.0.1";
  if (listenHost !== "127.0.0.1") {
    throw new Error(`Reverse proxy must listen on 127.0.0.1 loopback only (requested: '${listenHost}')`);
  }

  const targetHost = options.targetHost ?? "127.0.0.1";
  if (targetHost !== "127.0.0.1") {
    throw new Error(`Reverse proxy target must be 127.0.0.1 loopback only (requested: '${targetHost}')`);
  }

  const targetPort = options.targetPort;
  if (!targetPort || targetPort < 1 || targetPort > 65535) {
    throw new Error(`Invalid target port '${targetPort}' for reverse proxy`);
  }

  const listenPort = options.listenPort ?? 0;
  const timeoutMs = options.timeoutMs ?? PROXY_DEFAULT_TIMEOUT_MS;

  const server = http.createServer((clientReq, clientRes) => {
    // Strip hop-by-hop headers per RFC 7230
    const forwardHeaders: http.OutgoingHttpHeaders = { ...clientReq.headers };
    delete forwardHeaders["connection"];
    delete forwardHeaders["keep-alive"];
    delete forwardHeaders["proxy-connection"];
    delete forwardHeaders["proxy-authenticate"];
    delete forwardHeaders["proxy-authorization"];
    delete forwardHeaders["te"];
    delete forwardHeaders["trailer"];
    delete forwardHeaders["transfer-encoding"];
    delete forwardHeaders["upgrade"];

    forwardHeaders["host"] = `${targetHost}:${targetPort}`;
    forwardHeaders["x-forwarded-for"] = "127.0.0.1";
    forwardHeaders["x-forwarded-proto"] = "http";
    forwardHeaders["x-forwarded-host"] = clientReq.headers.host ?? `127.0.0.1:${listenPort}`;

    const targetReq = http.request(
      {
        host: targetHost,
        port: targetPort,
        path: clientReq.url,
        method: clientReq.method,
        headers: forwardHeaders,
        timeout: timeoutMs,
      },
      (targetRes) => {
        clientRes.writeHead(targetRes.statusCode ?? 502, targetRes.headers);
        targetRes.pipe(clientRes);
      },
    );

    targetReq.on("timeout", () => {
      targetReq.destroy(new Error("Target request timed out"));
    });

    targetReq.on("error", (err) => {
      if (!clientRes.headersSent) {
        const errorBody = JSON.stringify({
          error: "BAD_GATEWAY",
          target_port: targetPort,
          message: `Target container dev server unavailable: ${err.message}`,
        });
        clientRes.writeHead(502, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(errorBody, "utf8"),
          "Cache-Control": "no-store",
        });
        clientRes.end(errorBody);
      } else {
        clientRes.end();
      }
    });

    // Forward body or end request if no body (GET/HEAD)
    if (clientReq.method === "GET" || clientReq.method === "HEAD" || clientReq.complete) {
      targetReq.end();
    } else {
      clientReq.pipe(targetReq);
    }

    // Abort target request if client aborts
    clientReq.on("close", () => {
      if (!clientRes.writableEnded) {
        targetReq.destroy();
      }
    });
  });

  server.setTimeout(timeoutMs);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => {
      server.off("error", onError);
      if (options.fallbackToEphemeral && (err as { code?: string })?.code === "EADDRINUSE" && listenPort !== 0) {
        server.on("error", reject);
        server.listen(0, listenHost, () => {
          server.off("error", reject);
          resolve();
        });
        return;
      }
      reject(err);
    };
    server.on("error", onError);
    server.listen(listenPort, listenHost, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const allocatedListenPort = address.port;
  const listenOrigin = `http://127.0.0.1:${allocatedListenPort}`;
  const targetOrigin = `http://127.0.0.1:${targetPort}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      server.closeAllConnections?.();
    });
  };

  return {
    server,
    listenPort: allocatedListenPort,
    targetPort,
    listenOrigin,
    targetOrigin,
    close,
  };
}
