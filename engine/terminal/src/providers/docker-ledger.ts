// P5.4 container ownership ledger — runtime-only bookkeeping that lets the
// provider reconcile what it created and clean up only its own containers
// (docs/P5-DESIGN-SPEC.md, "Container Lifecycle"; task P5.4 "ledger").
//
// The ledger records intent BEFORE create (so a crash between intent and the
// daemon's actual container can still be reconciled) and the resulting
// container id/name. It is the authoritative source for "which containers
// does this provider own" — cleanup never prunes globally and never touches
// containers the provider did not create. No I/O: the provider feeds it.

import type { ContainerLifecycleState } from "../protocol.ts";

export interface LedgerEntry {
  readonly containerId: string;
  readonly name: string;
  readonly session_id: string;
  readonly generation: number;
  readonly lesson_id: string;
  readonly createdAtEpochMs: number;
  state: ContainerLifecycleState;
}

export interface ReconciliationSummary {
  readonly owned: readonly LedgerEntry[];
  readonly lingering: readonly LedgerEntry[];
}

/**
 * In-memory ownership ledger. One ephemeral container per runtime session:
 * Session A never reuses Session B's container, and a stale generation never
 * gains access to a newer container. The provider is the only writer.
 */
export class ContainerLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  /** Record intent to create a container (before the daemon call). */
  recordIntent(entry: Omit<LedgerEntry, "state">): LedgerEntry {
    const full: LedgerEntry = { ...entry, state: "ALLOCATING" };
    this.entries.set(entry.containerId, full);
    return full;
  }

  setState(containerId: string, state: ContainerLifecycleState): void {
    const entry = this.entries.get(containerId);
    if (entry === undefined) return;
    entry.state = state;
  }

  get(containerId: string): LedgerEntry | undefined {
    return this.entries.get(containerId);
  }

  /** All entries owned by this provider (for reconciliation). */
  all(): readonly LedgerEntry[] {
    return [...this.entries.values()];
  }

  /** Entries for one session (used for per-session cleanup). */
  forSession(session_id: string): readonly LedgerEntry[] {
    return this.all().filter((entry) => entry.session_id === session_id);
  }

  /**
   * P5.9: a removal could not be confirmed (daemon outage / transport
   * failure). The entry is KEPT (design "Daemon outage -> preserve ledger")
   * and marked HOLD_CLEANUP until reconciliation proves the container gone.
   */
  markCleanupUncertain(containerId: string): void {
    this.setState(containerId, "HOLD_CLEANUP");
  }

  /** P5.9: entries whose removal is still unconfirmed (HOLD_CLEANUP). */
  uncertainCount(): number {
    return this.all().filter((entry) => entry.state === "HOLD_CLEANUP").length;
  }

  /** Remove a successfully removed container from the bookkeeping. */
  forget(containerId: string): void {
    this.entries.delete(containerId);
  }

  /**
   * Reconcile against the set of container ids the daemon actually reports.
   * Returns owned entries split into still-present (lingering) vs already
   * gone. Lingering containers are the provider's cleanup responsibility.
   */
  reconcile(liveContainerIds: readonly string[]): ReconciliationSummary {
    const live = new Set(liveContainerIds);
    const owned = this.all();
    const lingering = owned.filter((entry) => live.has(entry.containerId));
    return { owned, lingering };
  }
}