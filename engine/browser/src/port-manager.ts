// P7.2 Port Manager — dynamic ephemeral host loopback port allocation & collision handling.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md sections 11 & 12, and task P7.2.
//
// Manages dynamic ephemeral host loopback ports for bridging background container dev servers:
// - Strictly binds 127.0.0.1 (IPv4 loopback). Zero 0.0.0.0, zero wildcard, zero LAN adapters.
// - Obtains OS-assigned high ephemeral ports dynamically (1024-65535).
// - Tracks reservations bound to ReviewedPortCapabilityV1, session_id, and generation.
// - Rejects renderer-chosen host ports or unreviewed port allocations.
// - Provides deterministic cleanup and collision recovery.

import net from "node:net";
import {
  ReviewedPortCapabilityV1Schema,
  type ReviewedPortCapabilityV1,
} from "./policy.ts";

export interface PortReservation {
  readonly capability_id: string;
  readonly session_id: string;
  readonly generation: number;
  readonly background_process_id: string;
  readonly guest_port: number;
  readonly allocated_host_port: number;
  readonly bind_address: "127.0.0.1";
  readonly reserved_at_ms: number;
}

/**
 * Finds and allocates a dynamic, unused ephemeral port on 127.0.0.1.
 * Relies on the OS kernel's ephemeral port allocator by binding port 0.
 */
export async function allocateEphemeralLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on("error", (err) => {
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

/**
 * Checks whether a specific port on the loopback interface is currently available for binding.
 */
export async function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  if (host !== "127.0.0.1") {
    throw new Error(`Port availability check only allowed on loopback 127.0.0.1 (got '${host}')`);
  }
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();

    server.on("error", () => {
      resolve(false);
    });

    server.listen(port, host, () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Trusted Port Manager overseeing host port reservations for browser automation sessions.
 */
export class PortManager {
  private activeReservations = new Map<string, PortReservation>();
  private disposed = false;

  /**
   * Reserves an ephemeral host loopback port for a verified ReviewedPortCapabilityV1.
   * If a preferred host port is supplied (e.g. attempting to match the authored port on host),
   * it verifies availability and binds it only if free; otherwise allocates an ephemeral port.
   */
  async reservePort(
    capability: ReviewedPortCapabilityV1,
    preferredHostPort?: number,
  ): Promise<{ reservation: PortReservation; release: () => Promise<void> }> {
    if (this.disposed) {
      throw new Error("PortManager has been disposed");
    }

    ReviewedPortCapabilityV1Schema.parse(capability);

    if (this.activeReservations.has(capability.capability_id)) {
      throw new Error(`Port capability '${capability.capability_id}' already has an active reservation`);
    }

    let allocatedPort: number;

    if (preferredHostPort !== undefined && preferredHostPort >= 1024 && preferredHostPort <= 65535) {
      const available = await isPortAvailable(preferredHostPort, "127.0.0.1");
      if (available) {
        allocatedPort = preferredHostPort;
      } else {
        // Fallback to dynamic ephemeral allocation on collision
        allocatedPort = await allocateEphemeralLoopbackPort();
      }
    } else {
      allocatedPort = await allocateEphemeralLoopbackPort();
    }

    const reservation: PortReservation = {
      capability_id: capability.capability_id,
      session_id: capability.session_id,
      generation: capability.generation,
      background_process_id: capability.background_process_id,
      guest_port: capability.guest_port,
      allocated_host_port: allocatedPort,
      bind_address: "127.0.0.1",
      reserved_at_ms: Date.now(),
    };

    this.activeReservations.set(capability.capability_id, reservation);

    const release = async (): Promise<void> => {
      await this.releaseReservation(capability.capability_id);
    };

    return { reservation, release };
  }

  /**
   * Releases an active port reservation by capability ID.
   */
  async releaseReservation(capability_id: string): Promise<boolean> {
    return this.activeReservations.delete(capability_id);
  }

  /**
   * Releases all port reservations owned by a specific session ID (e.g. on session reset or close).
   */
  async releaseAllForSession(session_id: string): Promise<number> {
    let count = 0;
    for (const [id, res] of Array.from(this.activeReservations.entries())) {
      if (res.session_id === session_id) {
        this.activeReservations.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Returns a snapshot of all currently active port reservations.
   */
  getActiveReservations(): ReadonlyMap<string, PortReservation> {
    return new Map(this.activeReservations);
  }

  /**
   * Disposes the port manager and clears all active reservations.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.activeReservations.clear();
  }
}
