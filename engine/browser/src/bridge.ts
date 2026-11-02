// P7.2 Localhost Bridge Coordinator — lifecycle, origin binding, and readiness polling.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md sections 11 & 12, and task P7.2.
//
// Bridges background container dev servers to the browser automation runtime:
// - Validates ReviewedPortCapabilityV1 main-side before establishing any bridge.
// - Obtains dynamic ephemeral host port reservations via PortManager.
// - Launches LoopbackReverseProxy to map authored origin to allocated container port.
// - Polls port readiness deterministically (wait until: port interop).
// - Exposes safe, bounded BrowserOriginBinding descriptors.
// - Enforces session/generation fencing and synchronous reset/close teardown barriers.

import http from "node:http";
import net from "node:net";
import { PortManager, type PortReservation } from "./port-manager.ts";
import { startLoopbackReverseProxy, type LoopbackReverseProxyInstance } from "./proxy.ts";
import {
  ReviewedPortCapabilityV1Schema,
  type ReviewedPortCapabilityV1,
} from "./policy.ts";
import { PORT_POLL_INTERVAL_MS } from "./protocol.ts";

export interface BrowserOriginBinding {
  readonly capability_id: string;
  readonly session_id: string;
  readonly generation: number;
  readonly authored_origin: string;
  readonly bridge_origin: string;
  readonly guest_port: number;
  readonly host_port: number;
  readonly proxy_listen_port?: number;
  readonly status: "active" | "retired";
}

/**
 * Deterministically polls a loopback port until it accepts TCP/HTTP connections or times out.
 */
export async function waitForPortReadiness(
  port: number,
  timeoutMs = 10_000,
  pollIntervalMs = PORT_POLL_INTERVAL_MS,
  host = "127.0.0.1",
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const isReady = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port, timeout: 1000 }, () => {
        socket.destroy();
        resolve(true);
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (isReady) {
      return true;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
  }

  throw new Error(`[PORT_UNAVAILABLE] Port ${port} on ${host} failed to accept connections within ${timeoutMs}ms`);
}

/**
 * Localhost bridge coordinator managing port capabilities, reverse proxies, and origin bindings.
 */
export class LocalhostBridgeCoordinator {
  private portManager = new PortManager();
  private activeProxies = new Map<string, LoopbackReverseProxyInstance>();
  private activeBindings = new Map<string, BrowserOriginBinding>();
  private currentSessionId: string | null = null;
  private currentGeneration: number | null = null;
  private disposed = false;

  constructor(session_id?: string, generation?: number) {
    if (session_id) this.currentSessionId = session_id;
    if (generation) this.currentGeneration = generation;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Activates the bridge for a reviewed port capability and mapped container host port.
   */
  async activateBridge(
    capability: ReviewedPortCapabilityV1,
    allocatedContainerPort: number,
    options: { preferredListenPort?: number; launchProxy?: boolean } = {},
  ): Promise<BrowserOriginBinding> {
    if (this.disposed) {
      throw new Error("LocalhostBridgeCoordinator has been disposed");
    }

    ReviewedPortCapabilityV1Schema.parse(capability);

    // Fencing checks
    if (this.currentSessionId && capability.session_id !== this.currentSessionId) {
      throw new Error(`[STALE_SESSION] Capability session '${capability.session_id}' does not match active session '${this.currentSessionId}'`);
    }
    if (this.currentGeneration && capability.generation !== this.currentGeneration) {
      throw new Error(`[STALE_GENERATION] Capability generation ${capability.generation} does not match active generation ${this.currentGeneration}`);
    }

    if (this.activeBindings.has(capability.capability_id)) {
      throw new Error(`Bridge for capability '${capability.capability_id}' is already active`);
    }

    let proxyInstance: LoopbackReverseProxyInstance | undefined;
    let bridgeOrigin = `http://127.0.0.1:${allocatedContainerPort}`;
    let proxyListenPort: number | undefined;

    const shouldLaunchProxy = options.launchProxy ?? true;
    if (shouldLaunchProxy) {
      // Attempt to listen on the authored port (e.g. 3000), or allocate an ephemeral listen port if busy
      proxyInstance = await startLoopbackReverseProxy({
        listenPort: options.preferredListenPort ?? capability.guest_port,
        targetPort: allocatedContainerPort,
        fallbackToEphemeral: true,
      });

      this.activeProxies.set(capability.capability_id, proxyInstance);
      bridgeOrigin = proxyInstance.listenOrigin;
      proxyListenPort = proxyInstance.listenPort;
    }

    const binding: BrowserOriginBinding = {
      capability_id: capability.capability_id,
      session_id: capability.session_id,
      generation: capability.generation,
      authored_origin: capability.reviewed_origin,
      bridge_origin: bridgeOrigin,
      guest_port: capability.guest_port,
      host_port: allocatedContainerPort,
      ...(proxyListenPort ? { proxy_listen_port: proxyListenPort } : {}),
      status: "active",
    };

    this.activeBindings.set(capability.capability_id, binding);
    return binding;
  }

  /**
   * Retires an active bridge and shuts down its reverse proxy.
   */
  async retireBridge(capability_id: string): Promise<boolean> {
    const proxy = this.activeProxies.get(capability_id);
    if (proxy) {
      await proxy.close();
      this.activeProxies.delete(capability_id);
    }

    const binding = this.activeBindings.get(capability_id);
    if (binding) {
      this.activeBindings.set(capability_id, { ...binding, status: "retired" });
      this.activeBindings.delete(capability_id);
      await this.portManager.releaseReservation(capability_id);
      return true;
    }

    return false;
  }

  /**
   * Retrieves an active origin binding by capability ID.
   */
  getBinding(capability_id: string): BrowserOriginBinding | undefined {
    return this.activeBindings.get(capability_id);
  }

  /**
   * Returns all currently active origin bindings.
   */
  getActiveBindings(): ReadonlyMap<string, BrowserOriginBinding> {
    return new Map(this.activeBindings);
  }

  /**
   * Synchronously and cleanly resets the bridge coordinator for a new generation.
   */
  async reset(new_generation: number): Promise<void> {
    // Close all proxies
    for (const [id, proxy] of Array.from(this.activeProxies.entries())) {
      await proxy.close();
    }
    this.activeProxies.clear();
    this.activeBindings.clear();

    if (this.currentSessionId) {
      await this.portManager.releaseAllForSession(this.currentSessionId);
    }

    this.currentGeneration = new_generation;
  }

  /**
   * Closes and disposes the coordinator, confirming clean teardown of all listeners.
   */
  async close(): Promise<void> {
    this.disposed = true;
    for (const [id, proxy] of Array.from(this.activeProxies.entries())) {
      await proxy.close();
    }
    this.activeProxies.clear();
    this.activeBindings.clear();
    await this.portManager.dispose();
  }
}
