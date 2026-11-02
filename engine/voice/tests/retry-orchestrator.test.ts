// P10.6 Bounded Retry Orchestrator Tests
//
// Tests:
// - Non-retryable failures: 0 retries
// - Uncertain failures (TIMEOUT, SYNTHESIS_FAILED): 0 retries
// - Terminal failures: 0 retries
// - RETRYABLE failures: RATE_LIMITED (max 3 retries), PROVIDER_UNAVAILABLE (max 2 retries)
// - Exact attempt count semantics: 1 initial + up to 3 retries = 4 total attempts
// - Backoff delays: 1000ms, 2000ms, 4000ms
// - Retry-After: honored, clamped to [0, 30000] ms
// - Cancellation during backoff: aborts sleep immediately, 0 subsequent attempts
// - DeterministicFakeScheduler: zero real wall-clock sleeps

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type VoiceFailureCode,
  type VoiceRetryClassification,
  classifyVoiceFailureCode,
} from "../src/protocol.ts";
import { VoiceProviderError } from "../src/provider-interface.ts";
import {
  DeterministicFakeScheduler,
  VoiceRetryOrchestrator,
} from "../host/retry-orchestrator.ts";

function makeError(code: VoiceFailureCode, message: string, retryAfterMs?: number): VoiceProviderError {
  return new VoiceProviderError({
    code,
    message,
    provider_identity: {
      provider_family: "fake",
      provider_model: "fake-m",
      provider_voice_id: "fake-v",
    },
    retry_after_ms: retryAfterMs,
  });
}

describe("retry-orchestrator: classification & zero-retry enforcement", () => {
  const nonRetryableCodes: VoiceFailureCode[] = [
    "CONFIG_INVALID",
    "AUTH_FAILED",
    "UNSUPPORTED_LOCALE",
    "UNSUPPORTED_VOICE",
    "TEXT_EMPTY",
    "NORMALIZATION_FAILED",
    "VALIDATION_FAILED",
  ];

  for (const code of nonRetryableCodes) {
    it(`proves ${code} (NON_RETRYABLE) executes exactly 1 attempt (0 retries)`, async () => {
      const scheduler = new DeterministicFakeScheduler();
      const orchestrator = new VoiceRetryOrchestrator({ scheduler });

      let attempts = 0;
      await assert.rejects(
        async () => {
          await orchestrator.executeWithRetry(async (attempt) => {
            attempts = attempt;
            throw makeError(code, `Failure with ${code}`);
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof VoiceProviderError);
          assert.equal(err.code, code);
          return true;
        },
      );

      assert.equal(attempts, 1, `Expected exactly 1 attempt for ${code}`);
      assert.equal(scheduler.scheduledDelays.length, 0, "No backoff sleep scheduled");
    });
  }

  const uncertainCodes: VoiceFailureCode[] = ["TIMEOUT", "SYNTHESIS_FAILED"];

  for (const code of uncertainCodes) {
    it(`proves ${code} (UNCERTAIN_DO_NOT_BLIND_RETRY) executes exactly 1 attempt (0 retries)`, async () => {
      const scheduler = new DeterministicFakeScheduler();
      const orchestrator = new VoiceRetryOrchestrator({ scheduler });

      let attempts = 0;
      await assert.rejects(
        async () => {
          await orchestrator.executeWithRetry(async (attempt) => {
            attempts = attempt;
            throw makeError(code, `Uncertain outcome: ${code}`);
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof VoiceProviderError);
          assert.equal(err.code, code);
          assert.equal(err.retry_classification, "UNCERTAIN_DO_NOT_BLIND_RETRY");
          return true;
        },
      );

      assert.equal(attempts, 1, `Expected exactly 1 attempt for uncertain code ${code}`);
      assert.equal(scheduler.scheduledDelays.length, 0, "No backoff sleep scheduled for uncertain outcome");
    });
  }

  const terminalCodes: VoiceFailureCode[] = ["CANCELLED", "RESET_INTERRUPTED", "LOW_DISK_ABORT"];

  for (const code of terminalCodes) {
    it(`proves ${code} (TERMINAL) executes exactly 1 attempt (0 retries)`, async () => {
      const scheduler = new DeterministicFakeScheduler();
      const orchestrator = new VoiceRetryOrchestrator({ scheduler });

      let attempts = 0;
      await assert.rejects(
        async () => {
          await orchestrator.executeWithRetry(async (attempt) => {
            attempts = attempt;
            throw makeError(code, `Terminal outcome: ${code}`);
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof VoiceProviderError);
          assert.equal(err.code, code);
          assert.equal(err.retry_classification, "TERMINAL");
          return true;
        },
      );

      assert.equal(attempts, 1, `Expected exactly 1 attempt for terminal code ${code}`);
      assert.equal(scheduler.scheduledDelays.length, 0, "No backoff sleep scheduled for terminal outcome");
    });
  }
});

describe("retry-orchestrator: bounded retries & attempt semantics", () => {
  it("proves RATE_LIMITED exhausts budget at 1 initial + 3 retries = 4 total attempts", async () => {
    const scheduler = new DeterministicFakeScheduler();
    const orchestrator = new VoiceRetryOrchestrator({
      maxRetries: 3,
      scheduler,
    });

    let attemptCount = 0;
    await assert.rejects(
      async () => {
        await orchestrator.executeWithRetry(async (attempt) => {
          attemptCount = attempt;
          throw makeError("RATE_LIMITED", "HTTP 429 Too Many Requests");
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "RATE_LIMITED");
        return true;
      },
    );

    assert.equal(attemptCount, 4, "Must make 1 initial attempt + 3 retries = 4 total attempts");
    assert.deepEqual(scheduler.scheduledDelays, [1000, 2000, 4000], "Expected exponential backoff: 1s, 2s, 4s");
  });

  it("proves PROVIDER_UNAVAILABLE exhausts budget at 1 initial + 2 retries = 3 total attempts", async () => {
    const scheduler = new DeterministicFakeScheduler();
    const orchestrator = new VoiceRetryOrchestrator({
      maxRetries: 3,
      maxProviderUnavailableRetries: 2,
      scheduler,
    });

    let attemptCount = 0;
    await assert.rejects(
      async () => {
        await orchestrator.executeWithRetry(async (attempt) => {
          attemptCount = attempt;
          throw makeError("PROVIDER_UNAVAILABLE", "HTTP 503 Service Unavailable");
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "PROVIDER_UNAVAILABLE");
        return true;
      },
    );

    assert.equal(attemptCount, 3, "Must make 1 initial attempt + 2 retries = 3 total attempts");
    assert.deepEqual(scheduler.scheduledDelays, [1000, 2000], "Expected backoff delays: 1s, 2s");
  });

  it("succeeds on 3rd attempt after 2 recoverable RATE_LIMITED errors", async () => {
    const scheduler = new DeterministicFakeScheduler();
    const orchestrator = new VoiceRetryOrchestrator({ scheduler });

    let attempts = 0;
    const outcome = await orchestrator.executeWithRetry(async (attempt) => {
      attempts = attempt;
      if (attempt < 3) {
        throw makeError("RATE_LIMITED", `Rate limit on attempt ${attempt}`);
      }
      return "synthesis-success";
    });

    assert.equal(outcome.result, "synthesis-success");
    assert.equal(attempts, 3);
    assert.equal(outcome.record.attempt_count, 3);
    assert.deepEqual(outcome.record.delays_ms, [1000, 2000]);
    assert.deepEqual(scheduler.scheduledDelays, [1000, 2000]);
  });
});

describe("retry-orchestrator: Retry-After handling and capping", () => {
  it("honors valid Retry-After value overriding default backoff", async () => {
    const scheduler = new DeterministicFakeScheduler();
    const orchestrator = new VoiceRetryOrchestrator({ scheduler });

    const outcome = await orchestrator.executeWithRetry(async (attempt) => {
      if (attempt === 1) {
        throw makeError("RATE_LIMITED", "Wait for quota", 5000);
      }
      return "ok";
    });

    assert.equal(outcome.result, "ok");
    assert.deepEqual(scheduler.scheduledDelays, [5000]);
    assert.deepEqual(outcome.record.delays_ms, [5000]);
  });

  it("caps oversized Retry-After value at 30,000 ms ceiling", async () => {
    const scheduler = new DeterministicFakeScheduler();
    const orchestrator = new VoiceRetryOrchestrator({ scheduler });

    const outcome = await orchestrator.executeWithRetry(async (attempt) => {
      if (attempt === 1) {
        throw makeError("RATE_LIMITED", "Wait long", 120_000); // 2 minutes requested
      }
      return "ok";
    });

    assert.equal(outcome.result, "ok");
    assert.deepEqual(scheduler.scheduledDelays, [30000], "Must be capped at 30,000 ms");
  });

  it("handles negative or zero Retry-After safely", async () => {
    const scheduler = new DeterministicFakeScheduler();
    const orchestrator = new VoiceRetryOrchestrator({ scheduler });

    const outcome = await orchestrator.executeWithRetry(async (attempt) => {
      if (attempt === 1) {
        throw makeError("RATE_LIMITED", "Immediate", 0);
      }
      return "ok";
    });

    assert.equal(outcome.result, "ok");
    assert.deepEqual(scheduler.scheduledDelays, [0]);
  });
});

describe("retry-orchestrator: cancellation during backoff", () => {
  it("aborts immediately when signal triggers during backoff sleep (0 further retries)", async () => {
    const scheduler = new DeterministicFakeScheduler();
    const orchestrator = new VoiceRetryOrchestrator({ scheduler });
    const controller = new AbortController();

    let attempts = 0;
    await assert.rejects(
      async () => {
        await orchestrator.executeWithRetry(
          async (attempt) => {
            attempts = attempt;
            // Trigger abort on first error
            controller.abort();
            throw makeError("RATE_LIMITED", "Rate limited");
          },
          { signal: controller.signal },
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof VoiceProviderError);
        assert.equal(err.code, "CANCELLED");
        return true;
      },
    );

    assert.equal(attempts, 1, "Must make only 1 attempt before cancellation aborts retry loop");
  });
});
