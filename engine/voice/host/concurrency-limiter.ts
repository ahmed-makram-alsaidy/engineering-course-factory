// P10.6 Global and Per-Provider Concurrency Limiter
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 29.4 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 8, 9.
//
// Operational Policies:
// - Global concurrency ceiling: Maximum 4 active synthesis operations.
// - Per-provider concurrency ceiling: Default maximum 2 active operations (configurable <= global limit).
// - Provider network/synthesis operation consumes a slot.
// - Cache check, normalization, validation and timeline binding do NOT consume provider synthesis slots.
// - Bounded FIFO waiting queue (default maximum 128 waiters).
// - Queue saturation fails closed with PROVIDER_UNAVAILABLE.
// - Cancellation while queued removes waiter immediately, releases no slot, and executes 0 provider calls.
// - Slot release is idempotent.

import { type ProviderIdentity, VoiceProviderError } from "../src/provider-interface.ts";

export const MAX_GLOBAL_CONCURRENCY = 4;
export const DEFAULT_PER_PROVIDER_CONCURRENCY = 2;
export const DEFAULT_MAX_QUEUE_CAPACITY = 128;

function providerIdentityFor(family: string): ProviderIdentity {
  return {
    provider_family: family || "system",
    provider_model: "none",
    provider_voice_id: "none",
  };
}

export interface ConcurrencyLimiterOptions {
  /** Maximum global concurrent operations across all providers (default: 4). */
  readonly maxGlobalConcurrency?: number;
  /** Default per-provider concurrency limit (default: 2). */
  readonly defaultPerProviderConcurrency?: number;
  /** Custom per-provider concurrency limits (family -> limit). Cannot exceed maxGlobalConcurrency. */
  readonly providerLimits?: Record<string, number>;
  /** Maximum waiting queue capacity (default: 128). */
  readonly maxQueueCapacity?: number;
}

export interface ConcurrencySlot {
  readonly providerFamily: string;
  release(): void;
}

interface QueuedWaiter {
  readonly providerFamily: string;
  readonly signal?: AbortSignal;
  readonly resolve: (slot: ConcurrencySlot) => void;
  readonly reject: (error: unknown) => void;
  cleanupAbortListener?: () => void;
}

export class ConcurrencyLimiter {
  readonly maxGlobal: number;
  readonly defaultPerProvider: number;
  readonly providerLimits: Readonly<Record<string, number>>;
  readonly maxQueueCapacity: number;

  private activeGlobalCount = 0;
  private readonly activePerProvider = new Map<string, number>();
  private readonly queue: QueuedWaiter[] = [];

  constructor(options?: ConcurrencyLimiterOptions) {
    this.maxGlobal = options?.maxGlobalConcurrency ?? MAX_GLOBAL_CONCURRENCY;
    this.defaultPerProvider = options?.defaultPerProviderConcurrency ?? DEFAULT_PER_PROVIDER_CONCURRENCY;
    this.providerLimits = Object.freeze({ ...(options?.providerLimits ?? {}) });
    this.maxQueueCapacity = options?.maxQueueCapacity ?? DEFAULT_MAX_QUEUE_CAPACITY;

    // Validate limits
    if (this.maxGlobal <= 0) {
      throw new Error(`Global concurrency limit must be positive: ${this.maxGlobal}`);
    }
    for (const [family, limit] of Object.entries(this.providerLimits)) {
      if (limit > this.maxGlobal) {
        throw new Error(
          `Provider '${family}' limit (${limit}) cannot exceed global concurrency limit (${this.maxGlobal})`,
        );
      }
    }
  }

  get activeGlobal(): number {
    return this.activeGlobalCount;
  }

  getActiveForProvider(family: string): number {
    return this.activePerProvider.get(family) ?? 0;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Acquires a concurrency slot for the given provider family.
   * If slots are available, resolves immediately.
   * If saturated, enqueues in FIFO order.
   * If queue is full, throws PROVIDER_UNAVAILABLE.
   * If signal is aborted before acquisition, removes waiter and throws CANCELLED.
   */
  async acquire(providerFamily: string, signal?: AbortSignal): Promise<ConcurrencySlot> {
    if (signal?.aborted) {
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: "Operation cancelled before acquiring concurrency slot",
        provider_identity: providerIdentityFor(providerFamily),
      });
    }

    const providerLimit = this.getLimitForProvider(providerFamily);
    const activeProvider = this.getActiveForProvider(providerFamily);

    // Can we acquire immediately?
    if (this.activeGlobalCount < this.maxGlobal && activeProvider < providerLimit) {
      this.activeGlobalCount++;
      this.activePerProvider.set(providerFamily, activeProvider + 1);
      return this.createSlot(providerFamily);
    }

    // Must queue: check capacity first
    if (this.queue.length >= this.maxQueueCapacity) {
      throw new VoiceProviderError({
        code: "PROVIDER_UNAVAILABLE",
        message: `Provider concurrency queue capacity exceeded (${this.maxQueueCapacity})`,
        provider_identity: providerIdentityFor(providerFamily),
      });
    }

    // Enqueue waiter
    return new Promise<ConcurrencySlot>((resolve, reject) => {
      let waiter: QueuedWaiter;

      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
        if (waiter.cleanupAbortListener) {
          waiter.cleanupAbortListener();
        }
        reject(
          new VoiceProviderError({
            code: "CANCELLED",
            message: "Operation cancelled while waiting in concurrency queue",
            provider_identity: providerIdentityFor(providerFamily),
          }),
        );
      };

      waiter = {
        providerFamily,
        signal,
        resolve,
        reject,
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanupAbortListener = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }

      this.queue.push(waiter);
    });
  }

  getLimitForProvider(family: string): number {
    const configured = this.providerLimits[family];
    if (configured !== undefined) {
      return Math.min(configured, this.maxGlobal);
    }
    return Math.min(this.defaultPerProvider, this.maxGlobal);
  }

  /**
   * Releases an acquired slot and drains eligible waiters in FIFO order.
   */
  private releaseSlot(providerFamily: string): void {
    if (this.activeGlobalCount > 0) {
      this.activeGlobalCount--;
    }
    const current = this.getActiveForProvider(providerFamily);
    if (current > 0) {
      this.activePerProvider.set(providerFamily, current - 1);
    }

    this.drainQueue();
  }

  /**
   * Creates a ConcurrencySlot with idempotent release.
   */
  private createSlot(providerFamily: string): ConcurrencySlot {
    let released = false;
    return {
      providerFamily,
      release: () => {
        if (!released) {
          released = true;
          this.releaseSlot(providerFamily);
        }
      },
    };
  }

  /**
   * Drains the FIFO queue by granting slots to the earliest eligible waiters.
   */
  private drainQueue(): void {
    if (this.queue.length === 0 || this.activeGlobalCount >= this.maxGlobal) {
      return;
    }

    for (let i = 0; i < this.queue.length; i++) {
      const waiter = this.queue[i];

      // Check if waiter was cancelled in the meantime
      if (waiter.signal?.aborted) {
        this.queue.splice(i, 1);
        i--;
        if (waiter.cleanupAbortListener) {
          waiter.cleanupAbortListener();
        }
        waiter.reject(
          new VoiceProviderError({
            code: "CANCELLED",
            message: "Operation cancelled while in concurrency queue",
            provider_identity: providerIdentityFor(waiter.providerFamily),
          }),
        );
        continue;
      }

      const limit = this.getLimitForProvider(waiter.providerFamily);
      const active = this.getActiveForProvider(waiter.providerFamily);

      if (this.activeGlobalCount < this.maxGlobal && active < limit) {
        // Remove from queue
        this.queue.splice(i, 1);
        i--;

        if (waiter.cleanupAbortListener) {
          waiter.cleanupAbortListener();
        }

        this.activeGlobalCount++;
        this.activePerProvider.set(waiter.providerFamily, active + 1);
        waiter.resolve(this.createSlot(waiter.providerFamily));

        if (this.activeGlobalCount >= this.maxGlobal) {
          break;
        }
      }
    }
  }

  /**
   * Clears the entire waiting queue, rejecting all waiters with CANCELLED.
   * Used during graceful shutdown or subsystem reset.
   */
  clearQueue(reason = "Subsystem shutting down or reset"): void {
    const waiters = this.queue.splice(0, this.queue.length);
    for (const waiter of waiters) {
      if (waiter.cleanupAbortListener) {
        waiter.cleanupAbortListener();
      }
      waiter.reject(
        new VoiceProviderError({
          code: "CANCELLED",
          message: `Concurrency wait cancelled: ${reason}`,
          provider_identity: providerIdentityFor(waiter.providerFamily),
        }),
      );
    }
  }
}
