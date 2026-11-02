// P10.6 Global and Per-Provider Concurrency Limiter Tests
//
// Tests:
// - Global ceiling <= 4
// - Per-provider ceiling <= 2
// - Lower per-provider limit (e.g. 1) honored
// - Limit cannot exceed global ceiling
// - Bounded FIFO waiting queue
// - Queue saturation fails closed with PROVIDER_UNAVAILABLE
// - Cancellation while queued removes waiter immediately (0 provider calls)
// - Idempotent slot release
// - Queue drainage order (FIFO)
// - clearQueue rejects all pending waiters

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VoiceProviderError } from "../src/provider-interface.ts";
import {
  ConcurrencyLimiter,
  DEFAULT_PER_PROVIDER_CONCURRENCY,
  MAX_GLOBAL_CONCURRENCY,
} from "../host/concurrency-limiter.ts";

describe("concurrency-limiter: limits and bounds", () => {
  it("freezes default global (4) and per-provider (2) concurrency bounds", () => {
    const limiter = new ConcurrencyLimiter();
    assert.equal(limiter.maxGlobal, 4);
    assert.equal(limiter.defaultPerProvider, 2);
    assert.equal(MAX_GLOBAL_CONCURRENCY, 4);
    assert.equal(DEFAULT_PER_PROVIDER_CONCURRENCY, 2);
  });

  it("enforces per-provider ceiling of 2 when global capacity allows 4", async () => {
    const limiter = new ConcurrencyLimiter({
      maxGlobalConcurrency: 4,
      defaultPerProviderConcurrency: 2,
    });

    const slot1 = await limiter.acquire("fake");
    const slot2 = await limiter.acquire("fake");

    assert.equal(limiter.activeGlobal, 2);
    assert.equal(limiter.getActiveForProvider("fake"), 2);

    // 3rd acquire for 'fake' should queue even though global has 2 free slots
    let thirdResolved = false;
    const thirdPromise = limiter.acquire("fake").then((s) => {
      thirdResolved = true;
      return s;
    });

    assert.equal(thirdResolved, false);
    assert.equal(limiter.queueLength, 1);

    // Releasing slot1 should grant thirdPromise
    slot1.release();
    const slot3 = await thirdPromise;
    assert.equal(thirdResolved, true);
    assert.equal(limiter.getActiveForProvider("fake"), 2);

    slot2.release();
    slot3.release();
    assert.equal(limiter.activeGlobal, 0);
    assert.equal(limiter.getActiveForProvider("fake"), 0);
  });

  it("enforces global ceiling of 4 across multiple providers", async () => {
    const limiter = new ConcurrencyLimiter({
      maxGlobalConcurrency: 4,
      defaultPerProviderConcurrency: 2,
    });

    const slotA1 = await limiter.acquire("providerA");
    const slotA2 = await limiter.acquire("providerA");
    const slotB1 = await limiter.acquire("providerB");
    const slotB2 = await limiter.acquire("providerB");

    assert.equal(limiter.activeGlobal, 4);

    // 5th acquire for providerC should queue because global is saturated at 4
    let cResolved = false;
    const slotCPromise = limiter.acquire("providerC").then((s) => {
      cResolved = true;
      return s;
    });

    assert.equal(cResolved, false);
    assert.equal(limiter.queueLength, 1);

    slotA1.release();
    const slotC = await slotCPromise;
    assert.equal(cResolved, true);
    assert.equal(limiter.activeGlobal, 4);

    slotA2.release();
    slotB1.release();
    slotB2.release();
    slotC.release();
    assert.equal(limiter.activeGlobal, 0);
  });

  it("honors custom lower per-provider limit (e.g. 1)", async () => {
    const limiter = new ConcurrencyLimiter({
      maxGlobalConcurrency: 4,
      defaultPerProviderConcurrency: 2,
      providerLimits: { restricted: 1 },
    });

    const slot1 = await limiter.acquire("restricted");
    assert.equal(limiter.getActiveForProvider("restricted"), 1);

    let secondResolved = false;
    const secondPromise = limiter.acquire("restricted").then((s) => {
      secondResolved = true;
      return s;
    });

    assert.equal(secondResolved, false);
    assert.equal(limiter.queueLength, 1);

    slot1.release();
    const slot2 = await secondPromise;
    assert.equal(secondResolved, true);
    slot2.release();
  });

  it("rejects per-provider limit that exceeds global ceiling at construction", () => {
    assert.throws(
      () =>
        new ConcurrencyLimiter({
          maxGlobalConcurrency: 4,
          providerLimits: { invalid: 5 },
        }),
      /cannot exceed global concurrency limit/,
    );
  });
});

describe("concurrency-limiter: queue bounds & FIFO fairness", () => {
  it("fails closed with PROVIDER_UNAVAILABLE when queue capacity is exceeded", async () => {
    const limiter = new ConcurrencyLimiter({
      maxGlobalConcurrency: 1,
      defaultPerProviderConcurrency: 1,
      maxQueueCapacity: 2,
    });

    const activeSlot = await limiter.acquire("fake");

    // Queue up to capacity (2)
    const p1 = limiter.acquire("fake");
    const p2 = limiter.acquire("fake");
    assert.equal(limiter.queueLength, 2);

    // Exceed capacity -> must throw PROVIDER_UNAVAILABLE
    await assert.rejects(
      async () => {
        await limiter.acquire("fake");
      },
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "PROVIDER_UNAVAILABLE");
        assert.match(err.message, /queue capacity exceeded/i);
        return true;
      },
    );

    // Clean up
    activeSlot.release();
    const s1 = await p1;
    s1.release();
    const s2 = await p2;
    s2.release();
  });

  it("drains queue in deterministic FIFO order", async () => {
    const limiter = new ConcurrencyLimiter({
      maxGlobalConcurrency: 1,
      defaultPerProviderConcurrency: 1,
    });

    const activeSlot = await limiter.acquire("p1");
    const order: number[] = [];

    const w1 = limiter.acquire("p1").then((s) => {
      order.push(1);
      s.release();
    });
    const w2 = limiter.acquire("p1").then((s) => {
      order.push(2);
      s.release();
    });
    const w3 = limiter.acquire("p1").then((s) => {
      order.push(3);
      s.release();
    });

    activeSlot.release();
    await Promise.all([w1, w2, w3]);

    assert.deepEqual(order, [1, 2, 3], "Must resolve in exact FIFO arrival order");
  });
});

describe("concurrency-limiter: cancellation & idempotency", () => {
  it("removes waiter from queue immediately when cancelled while waiting", async () => {
    const limiter = new ConcurrencyLimiter({
      maxGlobalConcurrency: 1,
      defaultPerProviderConcurrency: 1,
    });

    const activeSlot = await limiter.acquire("fake");
    const controller = new AbortController();

    const waiterPromise = limiter.acquire("fake", controller.signal);
    assert.equal(limiter.queueLength, 1);

    // Abort while queued
    controller.abort();

    await assert.rejects(
      async () => {
        await waiterPromise;
      },
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "CANCELLED");
        return true;
      },
    );

    assert.equal(limiter.queueLength, 0, "Waiter must be removed from queue");
    activeSlot.release();
    assert.equal(limiter.activeGlobal, 0);
  });

  it("proves slot.release() is cleanly idempotent", async () => {
    const limiter = new ConcurrencyLimiter({
      maxGlobalConcurrency: 2,
      defaultPerProviderConcurrency: 2,
    });

    const slot = await limiter.acquire("fake");
    assert.equal(limiter.activeGlobal, 1);

    slot.release();
    assert.equal(limiter.activeGlobal, 0);

    // Multiple calls to release do not decrement counter below zero
    slot.release();
    slot.release();
    assert.equal(limiter.activeGlobal, 0);
  });

  it("clearQueue cancels all pending waiters with CANCELLED", async () => {
    const limiter = new ConcurrencyLimiter({
      maxGlobalConcurrency: 1,
      defaultPerProviderConcurrency: 1,
    });

    const activeSlot = await limiter.acquire("fake");

    const w1 = limiter.acquire("fake");
    const w2 = limiter.acquire("fake");
    assert.equal(limiter.queueLength, 2);

    limiter.clearQueue("Test shutdown");
    assert.equal(limiter.queueLength, 0);

    for (const p of [w1, w2]) {
      await assert.rejects(
        async () => {
          await p;
        },
        (err: unknown) => {
          assert.ok(err instanceof VoiceProviderError);
          assert.equal(err.code, "CANCELLED");
          return true;
        },
      );
    }

    activeSlot.release();
  });
});
