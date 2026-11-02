// P10.6 Bounded Retry Orchestration & Backoff Scheduler
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 28, 29 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 8, 9.
//
// Operational Policies:
// - Provider adapters remain single-attempt: 1 attempt -> 1 result/failure. Zero hidden retry loops.
// - NON_RETRYABLE: 0 retries (fail closed immediately).
// - UNCERTAIN_DO_NOT_BLIND_RETRY: 0 automatic retries (TIMEOUT, SYNTHESIS_FAILED).
// - TERMINAL: 0 retries (CANCELLED, RESET_INTERRUPTED, LOW_DISK_ABORT).
// - RETRYABLE: Bounded retries only (RATE_LIMITED, PROVIDER_UNAVAILABLE, CACHE_CORRUPT).
// - Attempt semantics: 1 initial attempt + up to maxRetries retry attempts.
// - Backoff sequence: [1000, 2000, 4000] ms.
// - Retry-After: Honored for RATE_LIMITED, clamped to [0, 30,000] ms.
// - Cancellation during backoff: Aborts immediately, 0 subsequent attempts.
// - Injectable BackoffScheduler: Zero real sleeps in deterministic unit tests.

import {
  type VoiceFailureCode,
  type VoiceRetryClassification,
  classifyVoiceFailureCode,
} from "../src/protocol.ts";
import { type ProviderIdentity, VoiceProviderError } from "../src/provider-interface.ts";

export const MAX_RETRY_AFTER_MS = 30_000;
export const DEFAULT_BACKOFF_DELAYS_MS = [1_000, 2_000, 4_000] as const;
export const DEFAULT_MAX_RETRIES = 3;

const DEFAULT_SYSTEM_IDENTITY: ProviderIdentity = {
  provider_family: "system",
  provider_model: "none",
  provider_voice_id: "none",
};

const DEFAULT_FAKE_IDENTITY: ProviderIdentity = {
  provider_family: "fake",
  provider_model: "none",
  provider_voice_id: "none",
};

/**
 * Abstraction for backoff sleep scheduling.
 * Production implementation uses timers; test implementation uses deterministic fake clock.
 */
export interface BackoffScheduler {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}

/**
 * Production backoff scheduler using real Node.js timers and AbortSignal listeners.
 */
export class DefaultBackoffScheduler implements BackoffScheduler {
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: "Operation cancelled before backoff sleep",
        provider_identity: DEFAULT_SYSTEM_IDENTITY,
      });
    }

    if (ms <= 0) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const abortHandler = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        reject(
          new VoiceProviderError({
            code: "CANCELLED",
            message: "Backoff wait aborted by signal",
            provider_identity: DEFAULT_SYSTEM_IDENTITY,
          }),
        );
      };

      timer = setTimeout(() => {
        timer = null;
        signal?.removeEventListener("abort", abortHandler);
        resolve();
      }, ms);

      signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }

  now(): number {
    return Date.now();
  }
}

/**
 * Deterministic fake scheduler for offline tests with ZERO real sleep delay.
 */
export class DeterministicFakeScheduler implements BackoffScheduler {
  readonly scheduledDelays: number[] = [];
  private currentTime: number;

  constructor(initialTime = 0) {
    this.currentTime = initialTime;
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new VoiceProviderError({
        code: "CANCELLED",
        message: "Operation cancelled before fake backoff sleep",
        provider_identity: DEFAULT_FAKE_IDENTITY,
      });
    }

    const effectiveMs = Math.max(0, ms);
    this.scheduledDelays.push(effectiveMs);
    this.currentTime += effectiveMs;

    // Resolve immediately without real wall-clock delay
    return Promise.resolve();
  }

  now(): number {
    return this.currentTime;
  }
}

export interface RetryPolicyConfig {
  /** Maximum number of retry attempts after initial attempt (default: 3). */
  readonly maxRetries?: number;
  /** Maximum retries specifically for PROVIDER_UNAVAILABLE (default: 2). */
  readonly maxProviderUnavailableRetries?: number;
  /** Backoff delay sequence in milliseconds (default: [1000, 2000, 4000]). */
  readonly backoffDelaysMs?: readonly number[];
  /** Maximum cap for Retry-After wait in milliseconds (default: 30,000). */
  readonly maxRetryAfterMs?: number;
  /** Pluggable clock scheduler (default: DefaultBackoffScheduler). */
  readonly scheduler?: BackoffScheduler;
}

export interface RetryExecutionRecord {
  /** Total number of attempts made (1 initial + retries). */
  attempt_count: number;
  /** List of backoff delays waited in milliseconds before each retry. */
  delays_ms: number[];
  /** Final failure code if operation failed. */
  final_code?: VoiceFailureCode;
  /** Retry classification of final failure. */
  classification?: VoiceRetryClassification;
}

export interface ExecuteWithRetryResult<T> {
  readonly result: T;
  readonly record: RetryExecutionRecord;
}

/**
 * Bounded Retry Orchestrator executing provider operations with anti-blind-retry semantics.
 */
export class VoiceRetryOrchestrator {
  private readonly maxRetries: number;
  private readonly maxProviderUnavailableRetries: number;
  private readonly backoffDelaysMs: readonly number[];
  private readonly maxRetryAfterMs: number;
  readonly scheduler: BackoffScheduler;

  constructor(config?: RetryPolicyConfig) {
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxProviderUnavailableRetries = config?.maxProviderUnavailableRetries ?? 2;
    this.backoffDelaysMs = config?.backoffDelaysMs ?? DEFAULT_BACKOFF_DELAYS_MS;
    this.maxRetryAfterMs = config?.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
    this.scheduler = config?.scheduler ?? new DefaultBackoffScheduler();
  }

  /**
   * Executes an operation with bounded retry orchestration.
   *
   * Attempt semantics:
   * - attempt 1 = initial attempt
   * - attempt 2 = retry 1
   * - attempt 3 = retry 2
   * - attempt 4 = retry 3 (when maxRetries = 3)
   */
  async executeWithRetry<T>(
    operation: (attempt: number) => Promise<T>,
    options?: {
      signal?: AbortSignal;
      fallbackIdentity?: ProviderIdentity;
      onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
    },
  ): Promise<ExecuteWithRetryResult<T>> {
    const signal = options?.signal;
    const fallbackIdentity = options?.fallbackIdentity ?? DEFAULT_SYSTEM_IDENTITY;

    const record: RetryExecutionRecord = {
      attempt_count: 0,
      delays_ms: [],
    };

    while (true) {
      if (signal?.aborted) {
        throw new VoiceProviderError({
          code: "CANCELLED",
          message: "Operation cancelled before execution attempt",
          provider_identity: fallbackIdentity,
        });
      }

      record.attempt_count++;
      const currentAttempt = record.attempt_count;

      try {
        const result = await operation(currentAttempt);
        return { result, record };
      } catch (err: unknown) {
        let code: VoiceFailureCode = "SYNTHESIS_FAILED";
        let retryAfterMs: number | undefined;

        if (err instanceof VoiceProviderError) {
          code = err.code;
          retryAfterMs = err.retry_after_ms;
        } else if (signal?.aborted) {
          code = "CANCELLED";
        }

        const classification = classifyVoiceFailureCode(code);
        record.final_code = code;
        record.classification = classification;

        // Determine retry eligibility
        if (classification !== "RETRYABLE") {
          // NON_RETRYABLE, UNCERTAIN_DO_NOT_BLIND_RETRY, and TERMINAL: 0 automatic retries
          throw err;
        }

        // Determine specific max retries for this failure code
        let codeMaxRetries = this.maxRetries;
        if (code === "PROVIDER_UNAVAILABLE") {
          codeMaxRetries = Math.min(this.maxRetries, this.maxProviderUnavailableRetries);
        } else if (code === "CACHE_CORRUPT") {
          codeMaxRetries = 1;
        }

        const retryIndex = currentAttempt - 1; // 0 for 1st retry
        if (retryIndex >= codeMaxRetries) {
          // Retry budget exhausted
          throw err;
        }

        // Calculate delay
        let delayMs: number;
        if (code === "RATE_LIMITED" && retryAfterMs !== undefined && !Number.isNaN(retryAfterMs)) {
          // Honor Retry-After, clamped to [0, maxRetryAfterMs]
          delayMs = Math.max(0, Math.min(this.maxRetryAfterMs, Math.floor(retryAfterMs)));
        } else {
          const delayIndex = Math.min(retryIndex, this.backoffDelaysMs.length - 1);
          delayMs = this.backoffDelaysMs[delayIndex];
        }

        record.delays_ms.push(delayMs);

        if (options?.onRetry) {
          options.onRetry(err, currentAttempt, delayMs);
        }

        // Wait bounded delay (respects cancellation)
        await this.scheduler.sleep(delayMs, signal);
      }
    }
  }
}
