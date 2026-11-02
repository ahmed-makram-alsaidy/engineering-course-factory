// P7.1 Reviewed Browser Policy — policy_version = 1.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md and docs/adr/ADR-0012-browser-automation-boundary.md.
//
// Main-owned reviewed browser policy model and port capability contract.
// Zero renderer authority: the renderer cannot choose or override policy, allowed origins,
// or port bindings. All facts derive from immutable compiled IR and trusted main-side review.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BROWSER_ACTION_TYPES,
  BrowserErrorCodeSchema,
  BrowserIdentifierSchema,
  browserRejection,
  canonicalizeOrigin,
  Sha256HexSchema,
  validateBrowserUrl,
  type BrowserActionType,
  type BrowserRejection,
} from "./protocol.ts";

export const BROWSER_POLICY_VERSION = 1;

// ---------------------------------------------------------------------------
// Reviewed Port Capability Contract (P7-DESIGN-SPEC Section 11 & 12)
// ---------------------------------------------------------------------------

/**
 * Main-only port capability contract for bridging dev server background processes
 * to local browser automation without opening arbitrary workstation ports.
 * Structural invariant: contains NO host port, host bind address, Docker flags, or network mode.
 */
export const ReviewedPortCapabilityV1Schema = z.strictObject({
  kind: z.literal("reviewed_port_capability"),
  capability_version: z.literal(1),
  capability_id: BrowserIdentifierSchema,
  lesson_id: BrowserIdentifierSchema,
  session_id: BrowserIdentifierSchema,
  generation: z.number().int().min(1),
  background_process_id: BrowserIdentifierSchema,
  guest_port: z.number().int().min(1).max(65535),
  reviewed_origin: z.string().min(1),
  policy_version: z.literal(1),
  policy_digest: Sha256HexSchema,
});
export type ReviewedPortCapabilityV1 = z.infer<typeof ReviewedPortCapabilityV1Schema>;

// ---------------------------------------------------------------------------
// Reviewed Browser Operation Record
// ---------------------------------------------------------------------------

export const ReviewedOperationRecordSchema = z.strictObject({
  operation_id: BrowserIdentifierSchema,
  action_type: z.enum(BROWSER_ACTION_TYPES),
  target_origin: z.string().min(1).optional(),
});
export type ReviewedOperationRecord = z.infer<typeof ReviewedOperationRecordSchema>;

// ---------------------------------------------------------------------------
// Reviewed Browser Policy Model
// ---------------------------------------------------------------------------

export const ReviewedBrowserPolicyV1Schema = z.strictObject({
  kind: z.literal("reviewed_browser_policy"),
  policy_version: z.literal(1),
  course_id: BrowserIdentifierSchema,
  lesson_id: BrowserIdentifierSchema,
  compiled_ir_digest: Sha256HexSchema,
  allowed_origins: z.array(z.string().min(1)),
  reviewed_operations: z.record(BrowserIdentifierSchema, ReviewedOperationRecordSchema),
  port_capabilities: z.array(ReviewedPortCapabilityV1Schema),
  policy_digest: Sha256HexSchema,
});
export type ReviewedBrowserPolicyV1 = z.infer<typeof ReviewedBrowserPolicyV1Schema>;

// ---------------------------------------------------------------------------
// Pure Deterministic Hashing & Canonicalization
// ---------------------------------------------------------------------------

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep) as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted as T;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function computePolicyDigest(
  policyWithoutDigest: Omit<ReviewedBrowserPolicyV1, "policy_digest">,
): string {
  return sha256Hex(canonicalJson(policyWithoutDigest));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Policy Creation & Verification
// ---------------------------------------------------------------------------

export interface CreateReviewedBrowserPolicyInput {
  course_id: string;
  lesson_id: string;
  compiled_ir_digest: string;
  allowed_origins: string[];
  reviewed_operations: Record<string, { operation_id: string; action_type: BrowserActionType; target_origin?: string }>;
  port_capabilities?: ReviewedPortCapabilityV1[];
}

/**
 * Creates an immutable, digest-bound ReviewedBrowserPolicyV1.
 * Canonicalizes all allowed origins, validates operations, and binds the policy digest.
 */
export function createReviewedBrowserPolicy(input: CreateReviewedBrowserPolicyInput): ReviewedBrowserPolicyV1 {
  const canonicalOrigins = Array.from(
    new Set(
      input.allowed_origins.map((origin) => {
        const validated = validateBrowserUrl(origin);
        if (!validated.ok) {
          throw new Error(`Invalid allowed origin in policy creation: ${validated.message}`);
        }
        return validated.canonicalOrigin;
      }),
    ),
  ).sort();

  const sortedOps: Record<string, ReviewedOperationRecord> = {};
  for (const opId of Object.keys(input.reviewed_operations).sort()) {
    const op = input.reviewed_operations[opId];
    sortedOps[opId] = {
      operation_id: op.operation_id,
      action_type: op.action_type,
      ...(op.target_origin ? { target_origin: canonicalizeOrigin(op.target_origin) } : {}),
    };
  }

  const portCapabilities = (input.port_capabilities ?? []).slice().sort((a, b) =>
    a.capability_id.localeCompare(b.capability_id),
  );

  const policyPayload: Omit<ReviewedBrowserPolicyV1, "policy_digest"> = {
    kind: "reviewed_browser_policy",
    policy_version: 1,
    course_id: input.course_id,
    lesson_id: input.lesson_id,
    compiled_ir_digest: input.compiled_ir_digest,
    allowed_origins: canonicalOrigins,
    reviewed_operations: sortedOps,
    port_capabilities: portCapabilities,
  };

  const policy_digest = computePolicyDigest(policyPayload);

  const policy: ReviewedBrowserPolicyV1 = {
    ...policyPayload,
    policy_digest,
  };

  ReviewedBrowserPolicyV1Schema.parse(policy);
  return deepFreeze(policy);
}

/**
 * Verifies that a policy object is structurally sound, matches expected lesson & compiled IR digests,
 * and has not been tampered with.
 */
export function verifyReviewedBrowserPolicy(
  policy: unknown,
  expectedCompiledDigest: string,
  expectedLessonId: string,
): { ok: true; policy: ReviewedBrowserPolicyV1 } | { ok: false; rejection: BrowserRejection } {
  const parsed = ReviewedBrowserPolicyV1Schema.safeParse(policy);
  if (!parsed.success) {
    return {
      ok: false,
      rejection: browserRejection(
        "INVALID_REQUEST",
        `Reviewed browser policy schema validation failed: ${parsed.error.issues[0]?.message}`,
      ),
    };
  }

  const p = parsed.data;
  if (p.lesson_id !== expectedLessonId) {
    return {
      ok: false,
      rejection: browserRejection(
        "POLICY_DENIED",
        `Policy lesson mismatch (policy: '${p.lesson_id}', expected: '${expectedLessonId}')`,
      ),
    };
  }

  if (p.compiled_ir_digest !== expectedCompiledDigest) {
    return {
      ok: false,
      rejection: browserRejection(
        "POLICY_DENIED",
        `Policy compiled IR digest mismatch (policy: '${p.compiled_ir_digest}', expected: '${expectedCompiledDigest}')`,
      ),
    };
  }

  const { policy_digest: recordedDigest, ...withoutDigest } = p;
  const computed = computePolicyDigest(withoutDigest);
  if (computed !== recordedDigest) {
    return {
      ok: false,
      rejection: browserRejection("POLICY_DENIED", "Policy digest mismatch: policy has been tampered with"),
    };
  }

  return { ok: true, policy: p };
}

/**
 * Checks if a target URL or origin string belongs to the policy's allowed origins.
 * Pure parsed URL / origin semantics only — strictly NO naive startsWith string matching.
 */
export function isOriginAllowed(policy: ReviewedBrowserPolicyV1, targetUrlOrOrigin: string): boolean {
  let canonicalTarget: string;
  try {
    canonicalTarget = canonicalizeOrigin(targetUrlOrOrigin);
  } catch {
    return false;
  }
  return policy.allowed_origins.includes(canonicalTarget);
}
