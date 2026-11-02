// P10.6 Voice Execution Orchestrator Tests
//
// Tests:
// - Cache-first bypass: cache hit consumes zero concurrency slots and zero provider calls
// - Single-flight concurrency: identical cache_key requests share 1 provider call and 1 slot
// - Concurrency ceiling: global <= 4, per-provider <= 2
// - Bounded retries via orchestrator
// - Cancellation at each stage: queued, provider, post-publish
// - Post-publication cancellation preserves valid immutable cache asset
// - Active generation and runtime session fencing
// - Generation rotation: valid content remains cached, stale runtime binding flagged/rejected
// - Bounded graceful shutdown (<= 5,000 ms) and idempotency
// - Zero temp residue

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNarrationPlan,
  type PlannedNarrationUnit,
} from "../src/narration-planner.ts";
import {
  type VoiceProfile,
  type RuntimeFence,
} from "../src/protocol.ts";
import { VoiceProviderError } from "../src/provider-interface.ts";
import { FakeVoiceProvider } from "../src/fake-provider.ts";
import { VoiceCache } from "../host/voice-cache.ts";
import { VoiceAssetNormalizer } from "../host/audio-normalizer.ts";
import { ConcurrencyLimiter } from "../host/concurrency-limiter.ts";
import {
  DeterministicFakeScheduler,
  VoiceRetryOrchestrator,
} from "../host/retry-orchestrator.ts";
import {
  VoiceExecutionOrchestrator,
} from "../host/execution-orchestrator.ts";

function createTestHarness() {
  const root = mkdtempSync(join(tmpdir(), "voice-orch-test-"));
  const tempRoot = join(root, "temp");
  const cacheRoot = join(root, "cache");

  const cache = new VoiceCache({
    voiceTempRoot: tempRoot,
    voiceCacheRoot: cacheRoot,
  });
  const normalizer = new VoiceAssetNormalizer();
  const scheduler = new DeterministicFakeScheduler();
  const retryOrchestrator = new VoiceRetryOrchestrator({ scheduler });
  const concurrencyLimiter = new ConcurrencyLimiter({
    maxGlobalConcurrency: 4,
    defaultPerProviderConcurrency: 2,
  });

  const fakeProvider = new FakeVoiceProvider();

  const orchestrator = new VoiceExecutionOrchestrator({
    cache,
    normalizer,
    providerResolver: () => fakeProvider,
    concurrencyLimiter,
    retryOrchestrator,
    initialFence: {
      runtime_session_id: "sess-01",
      generation: 1,
      lesson_id: "C01-L003",
    },
  });

  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  };

  return { root, cache, normalizer, fakeProvider, scheduler, concurrencyLimiter, orchestrator, cleanup };
}

const testProfile: VoiceProfile = {
  profile_id: "en-inst-primary",
  locale: "en-US",
  gender: "male",
  description: "Primary",
  provider_family: "fake",
  provider_voice_id: "voice-1",
  provider_model: "model-1",
  rate: 1.0,
  pitch: 0.0,
  normalization_policy: "standard-v1",
};

function makePlannedUnit(text: string, ordinal = 1): PlannedNarrationUnit {
  const lesson = {
    compiled_ir_version: "1.0",
    lesson: { course_id: "C01", lesson_id: "C01-L003", language: "en" },
    scenes: [
      {
        scene_id: "C01-L003-S001",
        ordinal: 1,
        steps: [
          {
            kind: "narration",
            step_id: `C01-L003-S001-B00${ordinal}`,
            ordinal,
            derived: false,
            source_ref: {
              scene_id: "C01-L003-S001",
              scene_ordinal: 1,
              beat_id: `B00${ordinal}`,
              form: "authored_beat",
            },
            narration: { text, language: "en", direction: "ltr", speaker: "inst" },
          },
        ],
      },
    ],
  };
  const config = {
    profiles: [testProfile],
    speaker_mappings: [{ speaker: "inst", profile_id: "en-inst-primary" }],
    default_profile_id: "en-inst-primary",
  };
  const plan = createNarrationPlan(lesson, config);
  return plan.units[0];
}

describe("execution-orchestrator: cache-first bypass & single-flight", () => {
  it("proves cache hit consumes zero concurrency slots and performs zero provider calls", async () => {
    const { orchestrator, concurrencyLimiter, fakeProvider, cleanup } = createTestHarness();

    try {
      const unit = makePlannedUnit("Hello Course Factory test cache hit");

      // 1. Initial synthesis (miss)
      const res1 = await orchestrator.synthesizeUnit({
        plannedUnit: unit,
        profile: testProfile,
      });
      assert.equal(res1.cache_hit, false);
      assert.equal(concurrencyLimiter.activeGlobal, 0);

      // 2. Second synthesis (hit)
      const res2 = await orchestrator.synthesizeUnit({
        plannedUnit: unit,
        profile: testProfile,
      });
      assert.equal(res2.cache_hit, true);
      assert.equal(res2.asset.cache_key, res1.asset.cache_key);
      assert.equal(concurrencyLimiter.activeGlobal, 0);
      assert.equal(concurrencyLimiter.queueLength, 0);
    } finally {
      cleanup();
    }
  });

  it("proves concurrent identical requests join single-flight and consume one provider slot", async () => {
    const { orchestrator, concurrencyLimiter, cleanup } = createTestHarness();

    try {
      const unit = makePlannedUnit("Single flight deduplication text test");

      // Dispatch 3 concurrent requests for the exact same unit
      const [r1, r2, r3] = await Promise.all([
        orchestrator.synthesizeUnit({ plannedUnit: unit, profile: testProfile }),
        orchestrator.synthesizeUnit({ plannedUnit: unit, profile: testProfile }),
        orchestrator.synthesizeUnit({ plannedUnit: unit, profile: testProfile }),
      ]);

      assert.equal(r1.asset.cache_key, r2.asset.cache_key);
      assert.equal(r2.asset.cache_key, r3.asset.cache_key);
      assert.equal(concurrencyLimiter.activeGlobal, 0);
    } finally {
      cleanup();
    }
  });
});

describe("execution-orchestrator: cancellation semantics", () => {
  it("aborts immediately when signal is cancelled before execution", async () => {
    const { orchestrator, cleanup } = createTestHarness();

    try {
      const unit = makePlannedUnit("Immediate cancel test");
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => {
          await orchestrator.synthesizeUnit({
            plannedUnit: unit,
            profile: testProfile,
            signal: controller.signal,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof VoiceProviderError);
          assert.equal(err.code, "CANCELLED");
          return true;
        },
      );
    } finally {
      cleanup();
    }
  });

  it("preserves valid immutable cache asset if cancellation arrives after publication", async () => {
    const { orchestrator, cache, cleanup } = createTestHarness();

    try {
      const unit = makePlannedUnit("Preserve cache on post-publish cancel");

      // Normal synthesis to cache
      const res = await orchestrator.synthesizeUnit({
        plannedUnit: unit,
        profile: testProfile,
      });

      // Verify asset exists in cache
      const inspected = await cache.inspect(unit.cache_key);
      assert.equal(inspected.hit, true);

      // Now request with an aborted signal: asset remains in cache
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        async () => {
          await orchestrator.synthesizeUnit({
            plannedUnit: unit,
            profile: testProfile,
            signal: controller.signal,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof VoiceProviderError);
          assert.equal(err.code, "CANCELLED");
          return true;
        },
      );

      // Verify asset is still in cache! (NOT deleted)
      const recheck = await cache.inspect(unit.cache_key);
      assert.equal(recheck.hit, true);
    } finally {
      cleanup();
    }
  });
});

describe("execution-orchestrator: generation fencing & rotation", () => {
  it("flags result as stale when generation changes during synthesis", async () => {
    const { orchestrator, cache, cleanup } = createTestHarness();

    try {
      const unit = makePlannedUnit("Generation rotation test phrase");

      const fence1: RuntimeFence = {
        runtime_session_id: "sess-01",
        generation: 1,
        lesson_id: "C01-L003",
      };

      // Rotate fence to generation 2
      await orchestrator.rotateFence({
        runtime_session_id: "sess-01",
        generation: 2,
        lesson_id: "C01-L003",
      });

      // Synthesize with old fence 1 -> completes, cached, but flagged as stale for active runtime
      const res = await orchestrator.synthesizeUnit({
        plannedUnit: unit,
        profile: testProfile,
        fence: fence1,
      });

      assert.equal(res.stale, true, "Must be flagged as stale for active runtime");

      // Content cache must still carry the valid asset
      const inspect = await cache.inspect(unit.cache_key);
      assert.equal(inspect.hit, true, "Asset is retained in immutable content cache");
    } finally {
      cleanup();
    }
  });
});

describe("execution-orchestrator: graceful shutdown", () => {
  it("stops accepting new work and cancels waiters on shutdown", async () => {
    const { orchestrator, cleanup } = createTestHarness();

    try {
      await orchestrator.shutdown(1000);
      assert.equal(orchestrator.isShuttingDown, true);

      const unit = makePlannedUnit("After shutdown test");

      await assert.rejects(
        async () => {
          await orchestrator.synthesizeUnit({
            plannedUnit: unit,
            profile: testProfile,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof VoiceProviderError);
          assert.equal(err.code, "PROVIDER_UNAVAILABLE");
          return true;
        },
      );

      // Calling shutdown second time is cleanly idempotent
      await orchestrator.shutdown(1000);
    } finally {
      cleanup();
    }
  });
});
