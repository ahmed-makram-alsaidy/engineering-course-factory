// P8.3 Deterministic Logical Clock & Suspendable Timer Unit & Race Tests
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 26 & Section 8.3.
// Guarantees:
// 1. ManualLogicalClock is 100% deterministic with zero real sleeps.
// 2. Strict deadline ordering with FIFO tie-breaking for equal deadlines.
// 3. SuspendableTimer pause/resume semantics are mathematically exact.
// 4. Zero nondeterminism, zero timing flakiness.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ManualLogicalClock,
  SystemMonotonicClock,
  SuspendableTimer,
  validateTimeoutMs,
  MAX_TIMER_DELAY_MS,
  type Clock,
} from "../src/clock.ts";
import { RuntimeError } from "../src/errors.ts";

describe("P8.3: Logical Clock & Suspendable Timer", () => {
  describe("Validation & Bounds", () => {
    it("accepts valid timeout values", () => {
      assert.doesNotThrow(() => validateTimeoutMs(0));
      assert.doesNotThrow(() => validateTimeoutMs(100));
      assert.doesNotThrow(() => validateTimeoutMs(MAX_TIMER_DELAY_MS));
    });

    it("rejects NaN timeout", () => {
      assert.throws(
        () => validateTimeoutMs(NaN),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
    });

    it("rejects Infinity timeout", () => {
      assert.throws(
        () => validateTimeoutMs(Infinity),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
    });

    it("rejects negative timeout", () => {
      assert.throws(
        () => validateTimeoutMs(-1),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
    });

    it("rejects timeout exceeding MAX_TIMER_DELAY_MS", () => {
      assert.throws(
        () => validateTimeoutMs(MAX_TIMER_DELAY_MS + 1),
        (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST"
      );
    });
  });

  describe("ManualLogicalClock", () => {
    it("begins at canonical initial time", () => {
      const clock = new ManualLogicalClock();
      assert.equal(clock.now(), 0);

      const offsetClock = new ManualLogicalClock(500);
      assert.equal(offsetClock.now(), 500);
    });

    it("now() is strictly deterministic and advances only on instruction", () => {
      const clock = new ManualLogicalClock(1000);
      assert.equal(clock.now(), 1000);
      assert.equal(clock.now(), 1000);
      clock.advanceBy(250);
      assert.equal(clock.now(), 1250);
    });

    it("rejects negative or invalid advanceBy amounts", () => {
      const clock = new ManualLogicalClock();
      assert.throws(() => clock.advanceBy(-10), (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST");
      assert.throws(() => clock.advanceBy(NaN), (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST");
      assert.throws(() => clock.advanceBy(Infinity), (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST");
    });

    it("timer before due time does not fire", () => {
      const clock = new ManualLogicalClock(0);
      let fired = false;
      clock.setTimeout(() => {
        fired = true;
      }, 100);

      clock.advanceBy(99);
      assert.equal(fired, false);
      assert.equal(clock.now(), 99);
    });

    it("timer at due time fires exactly once", () => {
      const clock = new ManualLogicalClock(0);
      let fireCount = 0;
      clock.setTimeout(() => {
        fireCount++;
      }, 100);

      clock.advanceBy(100);
      assert.equal(fireCount, 1);
      assert.equal(clock.now(), 100);

      clock.advanceBy(500);
      assert.equal(fireCount, 1);
    });

    it("multiple timers order strictly by deadline", () => {
      const clock = new ManualLogicalClock(0);
      const executionOrder: string[] = [];

      clock.setTimeout(() => executionOrder.push("T300"), 300);
      clock.setTimeout(() => executionOrder.push("T100"), 100);
      clock.setTimeout(() => executionOrder.push("T200"), 200);

      clock.advanceBy(500);
      assert.deepEqual(executionOrder, ["T100", "T200", "T300"]);
    });

    it("equal deadline order is deterministic with FIFO tie-breaking", () => {
      const clock = new ManualLogicalClock(0);
      const executionOrder: string[] = [];

      clock.setTimeout(() => executionOrder.push("first"), 100);
      clock.setTimeout(() => executionOrder.push("second"), 100);
      clock.setTimeout(() => executionOrder.push("third"), 100);

      clock.advanceBy(100);
      assert.deepEqual(executionOrder, ["first", "second", "third"]);
    });

    it("clearTimeout prevents callback execution", () => {
      const clock = new ManualLogicalClock(0);
      let fired = false;
      const handle = clock.setTimeout(() => {
        fired = true;
      }, 100);

      clock.advanceBy(50);
      clock.clearTimeout(handle);
      clock.advanceBy(100);

      assert.equal(fired, false);
    });

    it("clearTimeout is safe and idempotent", () => {
      const clock = new ManualLogicalClock(0);
      const handle = clock.setTimeout(() => {}, 100);
      assert.doesNotThrow(() => clock.clearTimeout(handle));
      assert.doesNotThrow(() => clock.clearTimeout(handle));
      assert.doesNotThrow(() => clock.clearTimeout({ id: 999999 }));
    });

    it("nested future timers execute at their scheduled logical deadlines", () => {
      const clock = new ManualLogicalClock(0);
      const trace: string[] = [];

      clock.setTimeout(() => {
        trace.push("parent @ " + clock.now());
        clock.setTimeout(() => {
          trace.push("child @ " + clock.now());
        }, 50);
      }, 100);

      clock.advanceBy(100);
      assert.deepEqual(trace, ["parent @ 100"]);

      clock.advanceBy(49);
      assert.deepEqual(trace, ["parent @ 100"]);

      clock.advanceBy(1);
      assert.deepEqual(trace, ["parent @ 100", "child @ 150"]);
    });

    it("zero-duration timers execute within the current logical tick", () => {
      const clock = new ManualLogicalClock(0);
      const trace: string[] = [];

      clock.setTimeout(() => {
        trace.push("step 1");
        clock.setTimeout(() => {
          trace.push("step 2");
        }, 0);
      }, 0);

      clock.advanceBy(0);
      assert.deepEqual(trace, ["step 1", "step 2"]);
      assert.equal(clock.now(), 0);
    });

    it("runNext executes the next single earliest timer", () => {
      const clock = new ManualLogicalClock(0);
      const trace: string[] = [];

      clock.setTimeout(() => trace.push("T1"), 50);
      clock.setTimeout(() => trace.push("T2"), 150);

      const ranFirst = clock.runNext();
      assert.equal(ranFirst, true);
      assert.equal(clock.now(), 50);
      assert.deepEqual(trace, ["T1"]);

      const ranSecond = clock.runNext();
      assert.equal(ranSecond, true);
      assert.equal(clock.now(), 150);
      assert.deepEqual(trace, ["T1", "T2"]);

      const ranThird = clock.runNext();
      assert.equal(ranThird, false);
    });

    it("advanceTo advances to exact target timestamp", () => {
      const clock = new ManualLogicalClock(100);
      let fired = false;
      clock.setTimeout(() => {
        fired = true;
      }, 50);

      clock.advanceTo(150);
      assert.equal(clock.now(), 150);
      assert.equal(fired, true);

      assert.throws(() => clock.advanceTo(140), (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST");
    });

    it("flush executes all remaining timers in order", () => {
      const clock = new ManualLogicalClock(0);
      const trace: number[] = [];

      clock.setTimeout(() => trace.push(1), 10);
      clock.setTimeout(() => trace.push(2), 20);
      clock.setTimeout(() => trace.push(3), 30);

      const executed = clock.flush();
      assert.equal(executed, 3);
      assert.deepEqual(trace, [1, 2, 3]);
      assert.equal(clock.now(), 30);
    });

    it("timer handle returned is an opaque object with numeric id", () => {
      const clock = new ManualLogicalClock(0);
      const handle = clock.setTimeout(() => {}, 10);
      assert.equal(typeof handle.id, "number");
      assert.ok(handle.id >= 1);
      assert.equal(Object.isFrozen(handle), true);
    });
  });

  describe("SystemMonotonicClock", () => {
    it("now() is non-decreasing monotonic time", () => {
      const clock = new SystemMonotonicClock();
      const t1 = clock.now();
      const t2 = clock.now();
      assert.ok(t2 >= t1);
      assert.ok(t1 >= 0);
      clock.dispose();
    });

    it("setTimeout and clearTimeout work on host system clock", async () => {
      const clock = new SystemMonotonicClock();
      let fired = false;
      const handle = clock.setTimeout(() => {
        fired = true;
      }, 5);

      clock.clearTimeout(handle);
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(fired, false);
      clock.dispose();
    });
  });

  describe("SuspendableTimer", () => {
    it("starts with full remaining duration", () => {
      const clock = new ManualLogicalClock(0);
      const timer = new SuspendableTimer(clock, 5000, () => {});
      assert.equal(timer.getState(), "IDLE");
      assert.equal(timer.getTotalDurationMs(), 5000);
      assert.equal(timer.getRemainingMs(), 5000);
    });

    it("remaining duration decreases with logical time while running", () => {
      const clock = new ManualLogicalClock(0);
      const timer = new SuspendableTimer(clock, 5000, () => {});
      timer.start();
      assert.equal(timer.getState(), "RUNNING");

      clock.advanceBy(2000);
      assert.equal(timer.getRemainingMs(), 3000);

      clock.advanceBy(1500);
      assert.equal(timer.getRemainingMs(), 1500);
    });

    it("suspend freezes remaining duration and logical clock may advance during suspension", () => {
      const clock = new ManualLogicalClock(0);
      let completed = false;
      const timer = new SuspendableTimer(clock, 10000, () => {
        completed = true;
      });

      timer.start();
      clock.advanceBy(3000);
      assert.equal(timer.getRemainingMs(), 7000);

      // Suspend
      timer.suspend();
      assert.equal(timer.getState(), "PAUSED");
      assert.equal(timer.getRemainingMs(), 7000);

      // 5 minutes (300,000 ms) pass in wall time / logical clock
      clock.advanceBy(300000);
      assert.equal(timer.getRemainingMs(), 7000);
      assert.equal(completed, false);

      // Resume
      timer.resume();
      assert.equal(timer.getState(), "RUNNING");
      assert.equal(timer.getRemainingMs(), 7000);

      // Advance by 6999 ms — not yet completed
      clock.advanceBy(6999);
      assert.equal(completed, false);
      assert.equal(timer.getRemainingMs(), 1);

      // Advance final 1 ms
      clock.advanceBy(1);
      assert.equal(completed, true);
      assert.equal(timer.getState(), "COMPLETED");
      assert.equal(timer.getRemainingMs(), 0);
    });

    it("repeated suspend is idempotent", () => {
      const clock = new ManualLogicalClock(0);
      const timer = new SuspendableTimer(clock, 5000, () => {});
      timer.start();
      clock.advanceBy(1000);
      timer.suspend();
      assert.doesNotThrow(() => timer.suspend());
      assert.equal(timer.getState(), "PAUSED");
      assert.equal(timer.getRemainingMs(), 4000);
    });

    it("cancel stops completion and sets state to CANCELLED", () => {
      const clock = new ManualLogicalClock(0);
      let completed = false;
      const timer = new SuspendableTimer(clock, 5000, () => {
        completed = true;
      });

      timer.start();
      clock.advanceBy(2000);
      timer.cancel();

      assert.equal(timer.getState(), "CANCELLED");
      assert.equal(timer.getRemainingMs(), 0);

      clock.advanceBy(10000);
      assert.equal(completed, false);
    });

    it("completion fires callback exactly once", () => {
      const clock = new ManualLogicalClock(0);
      let fireCount = 0;
      const timer = new SuspendableTimer(clock, 1000, () => {
        fireCount++;
      });

      timer.start();
      clock.advanceBy(1000);
      assert.equal(fireCount, 1);
      assert.equal(timer.getState(), "COMPLETED");

      clock.advanceBy(5000);
      assert.equal(fireCount, 1);
    });

    it("resume after completion throws fail-closed", () => {
      const clock = new ManualLogicalClock(0);
      const timer = new SuspendableTimer(clock, 1000, () => {});
      timer.start();
      clock.advanceBy(1000);

      assert.equal(timer.getState(), "COMPLETED");
      assert.throws(() => timer.resume(), (err: unknown) => err instanceof RuntimeError && err.code === "INVALID_REQUEST");
    });

    it("dispose cancels active timer safely", () => {
      const clock = new ManualLogicalClock(0);
      let completed = false;
      const timer = new SuspendableTimer(clock, 1000, () => {
        completed = true;
      });
      timer.start();
      timer.dispose();
      clock.advanceBy(2000);
      assert.equal(completed, false);
      assert.equal(timer.getState(), "CANCELLED");
    });

    it("zero-duration SuspendableTimer completes on tick", () => {
      const clock = new ManualLogicalClock(0);
      let completed = false;
      const timer = new SuspendableTimer(clock, 0, () => {
        completed = true;
      });
      timer.start();
      assert.equal(completed, false);
      clock.advanceBy(0);
      assert.equal(completed, true);
      assert.equal(timer.getState(), "COMPLETED");
    });
  });

  describe("Deterministic Race Testing (Zero Real Sleep)", () => {
    it("simulates pause at exact timer deadline without firing twice", () => {
      const clock = new ManualLogicalClock(0);
      let fired = false;
      const timer = new SuspendableTimer(clock, 1000, () => {
        fired = true;
      });

      timer.start();
      // Advance right up to deadline
      clock.advanceBy(999);
      assert.equal(fired, false);
      assert.equal(timer.getRemainingMs(), 1);

      // Pause at 999 ms
      timer.suspend();
      assert.equal(timer.getRemainingMs(), 1);

      // Pass time while paused
      clock.advanceBy(5000);
      assert.equal(fired, false);

      // Resume
      timer.resume();
      assert.equal(fired, false);

      // Final 1 ms ticks
      clock.advanceBy(1);
      assert.equal(fired, true);
    });

    it("cancel before callback queue fires prevents callback", () => {
      const clock = new ManualLogicalClock(0);
      let fired = false;
      const handle = clock.setTimeout(() => {
        fired = true;
      }, 500);

      clock.advanceBy(499);
      clock.clearTimeout(handle);
      clock.advanceBy(1);
      assert.equal(fired, false);
    });

    it("interleaved timers maintain strict deterministic queue ordering", () => {
      const clock = new ManualLogicalClock(0);
      const trace: number[] = [];

      clock.setTimeout(() => {
        trace.push(1);
        clock.setTimeout(() => trace.push(3), 20);
      }, 10);

      clock.setTimeout(() => {
        trace.push(2);
      }, 15);

      clock.advanceBy(50);
      // Timeline:
      // at 10: timer 1 runs, schedules timer 3 at 10 + 20 = 30
      // at 15: timer 2 runs
      // at 30: timer 3 runs
      assert.deepEqual(trace, [1, 2, 3]);
    });
  });
});
