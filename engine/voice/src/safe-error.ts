// P10.6 Safe Error Serialization & Sanitization
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 9, 28, 29 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 4, 11.
//
// Responsibilities:
// - Produce structured, privacy-safe, evidence-ready error representations.
// - Enforce strict 1024-character message ceiling (prevent multi-MB error dumps).
// - Scrub exact resolved secrets, bearer tokens, passwords, and signed URLs.
// - Strip all stack traces, host paths, internal file descriptors, and env maps.
// - Deterministic JSON serialization.

import {
  type VoiceFailureCode,
  type VoiceRetryClassification,
  classifyVoiceFailureCode,
} from "./protocol.ts";
import { type ProviderIdentity, VoiceProviderError } from "./provider-interface.ts";
import { defaultSecretRedactor, SecretRedactor } from "./redactor.ts";

/** Maximum safe message length to prevent log flooding or memory blowup. */
export const MAX_SAFE_ERROR_MESSAGE_LENGTH = 1024;

/**
 * Privacy-safe, evidence-ready structured representation of a voice operational failure.
 * Guarantees absence of secrets, auth headers, raw HTTP bodies, host paths, and stack traces.
 */
export interface SafeVoiceError {
  readonly code: VoiceFailureCode;
  readonly retry_classification: VoiceRetryClassification;
  readonly message: string;
  readonly provider_family?: string;
  readonly provider_model?: string;
  readonly provider_voice_id?: string;
  readonly retry_after_ms?: number;
  readonly request_id?: string;
}

export interface ToSafeVoiceErrorOptions {
  readonly fallbackIdentity?: ProviderIdentity;
  readonly requestId?: string;
  readonly redactor?: SecretRedactor;
}

/**
 * Converts any caught error into a canonical SafeVoiceError.
 */
export function toSafeVoiceError(
  err: unknown,
  options?: ToSafeVoiceErrorOptions,
): SafeVoiceError {
  const redactor = options?.redactor ?? defaultSecretRedactor;
  let code: VoiceFailureCode = "SYNTHESIS_FAILED";
  let rawMessage = "Unknown voice error";
  let providerIdentity: ProviderIdentity | undefined = options?.fallbackIdentity;
  let retryAfterMs: number | undefined;

  if (err instanceof VoiceProviderError) {
    code = err.code;
    rawMessage = err.message;
    providerIdentity = err.provider_identity ?? options?.fallbackIdentity;
    retryAfterMs = err.retry_after_ms;
  } else if (err instanceof Error) {
    rawMessage = err.message;
    // Check if error message contains a known failure code prefix like [CONFIG_INVALID]
    const match = rawMessage.match(/\[([A-Z_]+)\]/);
    if (match) {
      const candidate = match[1] as VoiceFailureCode;
      try {
        classifyVoiceFailureCode(candidate);
        code = candidate;
      } catch {
        // Not a standard VoiceFailureCode, keep fallback
      }
    }
  } else if (typeof err === "string") {
    rawMessage = err;
  }

  // 1. Redact all registered secrets and pattern-based secrets
  let safeMessage = redactor.redact(rawMessage);

  // 2. Strip any stack-trace-like remnants (e.g. at ... lines)
  safeMessage = safeMessage
    .split("\n")
    .filter((line) => !/^\s*at\s+.*(?:\.js|\.ts|\.mjs|\.cjs|\()/i.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  // 3. Bound message length
  if (safeMessage.length > MAX_SAFE_ERROR_MESSAGE_LENGTH) {
    safeMessage = safeMessage.slice(0, MAX_SAFE_ERROR_MESSAGE_LENGTH - 3) + "...";
  }

  const classification = classifyVoiceFailureCode(code);

  const safeError: SafeVoiceError = {
    code,
    retry_classification: classification,
    message: safeMessage,
    ...(providerIdentity?.provider_family ? { provider_family: providerIdentity.provider_family } : {}),
    ...(providerIdentity?.provider_model ? { provider_model: providerIdentity.provider_model } : {}),
    ...(providerIdentity?.provider_voice_id ? { provider_voice_id: providerIdentity.provider_voice_id } : {}),
    ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
    ...(options?.requestId ? { request_id: options.requestId } : {}),
  };

  return Object.freeze(safeError);
}

/**
 * Serializes a SafeVoiceError to deterministic JSON string.
 */
export function serializeSafeVoiceError(safeError: SafeVoiceError): string {
  return JSON.stringify({
    code: safeError.code,
    retry_classification: safeError.retry_classification,
    message: safeError.message,
    ...(safeError.provider_family ? { provider_family: safeError.provider_family } : {}),
    ...(safeError.provider_model ? { provider_model: safeError.provider_model } : {}),
    ...(safeError.provider_voice_id ? { provider_voice_id: safeError.provider_voice_id } : {}),
    ...(safeError.retry_after_ms !== undefined ? { retry_after_ms: safeError.retry_after_ms } : {}),
    ...(safeError.request_id ? { request_id: safeError.request_id } : {}),
  });
}
