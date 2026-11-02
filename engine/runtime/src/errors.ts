// P8.1 Runtime Error Taxonomy & Safe Error DTOs
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 21 & Section 29, and ADR-0013.
// This module defines the stable error taxonomy, safe error DTOs, and error sanitization.
// Zero engine execution, zero side effects.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Error Bounds Constants
// ---------------------------------------------------------------------------

export const MAX_ERROR_MESSAGE_LENGTH = 512;

// ---------------------------------------------------------------------------
// Runtime Error Codes (Closed Taxonomy)
// ---------------------------------------------------------------------------

export const RUNTIME_ERROR_CODES = [
  "RUNTIME_INVALID_LESSON",
  "RUNTIME_NOT_READY",
  "RUNTIME_ALREADY_RUNNING",
  "RUNTIME_PAUSED",
  "RUNTIME_IN_HOLD",
  "INVALID_STATE_TRANSITION",
  "PREFLIGHT_VALIDATION_FAILED",
  "ENGINE_UNAVAILABLE",
  "ENGINE_DISPATCH_FAILED",
  "ENGINE_OUTCOME_UNCERTAIN",
  "DEPENDENCY_NOT_MET",
  "STALE_RUNTIME_SESSION",
  "STALE_GENERATION",
  "DUPLICATE_OPERATION",
  "RESET_FAILED",
  "CLEANUP_UNCONFIRMED",
  "OPERATION_CANCELLED",
  "UNSUPPORTED_ACTION_TYPE",
  "INVALID_REQUEST",
] as const;

export const RuntimeErrorCodeSchema = z.enum(RUNTIME_ERROR_CODES);
export type RuntimeErrorCode = z.infer<typeof RuntimeErrorCodeSchema>;

// ---------------------------------------------------------------------------
// Retry Categories
// ---------------------------------------------------------------------------

export const RETRY_CATEGORIES = [
  "SAFE_TO_RETRY",
  "NOT_RETRYABLE",
  "REQUIRES_RESET",
  "UNCERTAIN_DO_NOT_RETRY",
] as const;

export const RetryCategorySchema = z.enum(RETRY_CATEGORIES);
export type RetryCategory = z.infer<typeof RetryCategorySchema>;

// ---------------------------------------------------------------------------
// Message Sanitization Helper
// ---------------------------------------------------------------------------

/**
 * Sanitizes an error message before including in public DTOs or journal events.
 * Redacts Windows and POSIX machine paths, strips stack traces, and caps length.
 */
export function sanitizeErrorMessage(message: string): string {
  if (typeof message !== "string") {
    return "[sanitized error]";
  }
  let clean = message;

  // Strip stack trace frames: lines starting with 'at ...'
  clean = clean.replace(/(?:\r?\n|^)\s*at\s+[^\n]*\([^)]+\)/g, " ");
  clean = clean.replace(/\r?\n\s*at\s+.*(?:\r?\n|$)/g, " ");

  // Redact Windows absolute paths: e.g. E:\course-factory\... or C:/Users/...
  clean = clean.replace(/[A-Za-z]:[\\/][^\s"'`)]*/g, "[path]");

  // Redact UNC paths: \\server\share\...
  clean = clean.replace(/\\\\[^\s"'`)]*/g, "[path]");

  // Redact POSIX absolute paths: /home/user/repo/...
  clean = clean.replace(/(^|[\s("'])(\/[\w.-]+(\/[\w.-]+)+)/g, "$1[path]");

  // Collapse multiple whitespace
  clean = clean.replace(/\s+/g, " ").trim();

  // Bounded length
  if (clean.length > MAX_ERROR_MESSAGE_LENGTH) {
    clean = clean.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3) + "...";
  }

  return clean || "[sanitized error]";
}

// ---------------------------------------------------------------------------
// Safe Runtime Error DTO (Public / IPC / Journal Safe)
// ---------------------------------------------------------------------------

export const RuntimeErrorDtoSchema = z
  .strictObject({
    code: RuntimeErrorCodeSchema,
    message: z.string().min(1).max(MAX_ERROR_MESSAGE_LENGTH),
    retry: RetryCategorySchema,
    request_id: z.string().min(1).max(128).nullable(),
    step_id: z.string().min(1).max(128).optional(),
  })
  .superRefine((err, ctx) => {
    // Invariant: UNCERTAIN outcomes must map to UNCERTAIN_DO_NOT_RETRY
    if (err.code === "ENGINE_OUTCOME_UNCERTAIN" || err.code === "CLEANUP_UNCONFIRMED") {
      if (err.retry !== "UNCERTAIN_DO_NOT_RETRY") {
        ctx.addIssue({
          code: "custom",
          path: ["retry"],
          message: `Error code '${err.code}' must have retry category 'UNCERTAIN_DO_NOT_RETRY' (got '${err.retry}')`,
        });
      }
    }
  });

export type RuntimeErrorDto = z.infer<typeof RuntimeErrorDtoSchema>;

// ---------------------------------------------------------------------------
// RuntimeError Class (Internal Orchestrator Exception)
// ---------------------------------------------------------------------------

export interface RuntimeErrorOptions {
  code: RuntimeErrorCode;
  message: string;
  retry?: RetryCategory;
  requestId?: string | null;
  stepId?: string;
  cause?: unknown;
}

/**
 * Trusted internal error class for Course Factory runtime orchestrator.
 * Stores internal cause for debugging while exposing sanitized DTOs via toDto().
 */
export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retry: RetryCategory;
  readonly requestId: string | null;
  readonly stepId?: string;
  override readonly cause?: unknown;

  constructor(options: RuntimeErrorOptions) {
    const cleanMessage = sanitizeErrorMessage(options.message);
    super(`[${options.code}] ${cleanMessage}`);
    this.name = "RuntimeError";
    this.code = options.code;
    this.retry = options.retry ?? defaultRetryForCode(options.code);
    this.requestId = options.requestId ?? null;
    this.stepId = options.stepId;
    this.cause = options.cause;
    Object.setPrototypeOf(this, RuntimeError.prototype);
  }

  toDto(): RuntimeErrorDto {
    const rawMessage = this.message.replace(/^\[[A-Z_]+\]\s*/, "");
    return {
      code: this.code,
      message: sanitizeErrorMessage(rawMessage),
      retry: this.retry,
      request_id: this.requestId,
      step_id: this.stepId,
    };
  }
}

/**
 * Returns default safe retry classification for each error code.
 */
export function defaultRetryForCode(code: RuntimeErrorCode): RetryCategory {
  switch (code) {
    case "ENGINE_OUTCOME_UNCERTAIN":
    case "CLEANUP_UNCONFIRMED":
    case "RUNTIME_IN_HOLD":
      return "UNCERTAIN_DO_NOT_RETRY";

    case "RESET_FAILED":
    case "STALE_RUNTIME_SESSION":
    case "STALE_GENERATION":
      return "REQUIRES_RESET";

    case "RUNTIME_INVALID_LESSON":
    case "RUNTIME_NOT_READY":
    case "RUNTIME_ALREADY_RUNNING":
    case "RUNTIME_PAUSED":
    case "INVALID_STATE_TRANSITION":
    case "PREFLIGHT_VALIDATION_FAILED":
    case "ENGINE_UNAVAILABLE":
    case "ENGINE_DISPATCH_FAILED":
    case "DEPENDENCY_NOT_MET":
    case "DUPLICATE_OPERATION":
    case "OPERATION_CANCELLED":
    case "UNSUPPORTED_ACTION_TYPE":
    case "INVALID_REQUEST":
    default:
      return "NOT_RETRYABLE";
  }
}
