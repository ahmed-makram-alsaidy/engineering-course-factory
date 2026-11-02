// P6.1 reviewed workspace policy — the main-only digest-bound access manifest.
//
// Canonical authority: docs/P6-DESIGN-SPEC.md section 26.2 and
// docs/adr/ADR-0011-shared-workspace-ownership.md decision 4.
//
// Access is reviewed policy, never command inference: a strict version-1
// manifest binds the exact compiled digest, the seed manifest digest, the
// runtime sandbox policy digest and one read_only/read_write entry for EVERY
// terminal_run operation. Missing, extra or mismatched entries reject;
// the renderer cannot choose access; lesson source and compiled IR stay
// unchanged. Changing IR, seed bytes or any access entry invalidates
// authorization (NOT_AUTHORIZED, zero mutation).
//
// This module is policy-only: pure Zod schemas plus pure create/verify/
// resolve helpers. Zero I/O, zero container work, zero editor mutation. The
// only builtin import is node:crypto for digest binding (no fs, no process,
// no network, no Docker). Product source never examines command strings:
// resolution takes (policy, operationId) only — there is structurally no
// command parameter to infer from.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PortablePathSchema,
  Sha256HexSchema,
  TerminalWorkspaceAccessSchema,
  WorkspaceIdentifierSchema,
  type TerminalWorkspaceAccess,
  type WorkspaceOutcome,
  type WorkspaceRejection,
} from "./protocol.ts";

function rejected(code: WorkspaceRejection["code"], message: string): { ok: false; rejection: WorkspaceRejection } {
  return { ok: false, rejection: { code, message } };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Canonical serialization and digests (deterministic, no machine state).
// ---------------------------------------------------------------------------

/** Recursively sort object keys (UTF-16 code-unit order); arrays keep order. */
export function sortKeysDeep<T>(value: T): T {
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

/** Compact canonical JSON used for every digest binding. */
export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** SHA-256 hex over UTF-8 text. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Seed manifest — reviewed regular seed files. Sorted portable entries;
// an empty manifest is explicit (zero entries, still digest-bound).
// ---------------------------------------------------------------------------

export const SEED_MANIFEST_VERSION = 1;

export const SeedEntryKindSchema = z.enum(["directory", "regular_file"]);
export type SeedEntryKind = z.infer<typeof SeedEntryKindSchema>;

export const SeedManifestEntrySchema = z
  .strictObject({
    portable_path: PortablePathSchema,
    kind: SeedEntryKindSchema,
    byte_length: z.number().int().min(0),
    /** Byte digest for regular files; null exactly for directories. */
    sha256: Sha256HexSchema.nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.kind === "directory" && (entry.byte_length !== 0 || entry.sha256 !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "[SEED_ENTRY_INCONSISTENT] a directory entry must carry zero length and null digest",
      });
    }
    if (entry.kind === "regular_file" && entry.sha256 === null) {
      ctx.addIssue({
        code: "custom",
        message: "[SEED_ENTRY_INCONSISTENT] a regular file entry must carry its byte digest",
      });
    }
  });
export type SeedManifestEntry = z.infer<typeof SeedManifestEntrySchema>;

export const SeedManifestSchema = z
  .strictObject({
    manifest_version: z.literal(SEED_MANIFEST_VERSION),
    entries: z.array(SeedManifestEntrySchema).max(256),
  })
  .superRefine((manifest, ctx) => {
    const paths = manifest.entries.map((entry) => entry.portable_path);
    const sorted = [...paths].sort();
    for (const [index, path] of paths.entries()) {
      if (path !== sorted[index]) {
        ctx.addIssue({
          code: "custom",
          message: "[SEED_MANIFEST_ORDER] entries must be sorted by portable path",
        });
        return;
      }
    }
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: "custom",
        message: "[SEED_MANIFEST_DUPLICATE] entries must carry unique portable paths",
      });
    }
  });
export type SeedManifest = z.infer<typeof SeedManifestSchema>;

/** Sort, validate and freeze raw seed entries (empty input is an explicit empty manifest). */
export function createSeedManifest(entries: readonly SeedManifestEntry[]): WorkspaceOutcome<SeedManifest> {
  const sorted = [...entries].sort((a, b) => (a.portable_path < b.portable_path ? -1 : a.portable_path > b.portable_path ? 1 : 0));
  const parsed = SeedManifestSchema.safeParse({ manifest_version: SEED_MANIFEST_VERSION, entries: sorted });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return rejected("INVALID_REQUEST", `seed manifest rejected: ${first?.message ?? "unknown issue"}`);
  }
  return { ok: true, value: deepFreeze(parsed.data) };
}

/** Digest binding a seed manifest (canonical serialization of its entries). */
export function computeSeedManifestDigest(manifest: SeedManifest): string {
  return sha256Hex(canonicalJsonV1({ manifest_version: manifest.manifest_version, entries: manifest.entries }));
}

// ---------------------------------------------------------------------------
// ReviewedWorkspacePolicyV1 — the trusted access manifest.
// ---------------------------------------------------------------------------

export const REVIEWED_WORKSPACE_POLICY_VERSION = 1;

const ReviewedPolicyBodySchema = z.strictObject({
  policy_version: z.literal(REVIEWED_WORKSPACE_POLICY_VERSION),
  course_id: WorkspaceIdentifierSchema,
  lesson_id: WorkspaceIdentifierSchema,
  lesson_compiled_digest: Sha256HexSchema,
  seed_manifest_digest: Sha256HexSchema,
  /** Binds the combined runtime sandbox/file policy (one reviewed digest). */
  sandbox_policy_digest: Sha256HexSchema,
  /** Exact map terminal_access[operation_id] = read_only | read_write. */
  terminal_access: z.record(WorkspaceIdentifierSchema, TerminalWorkspaceAccessSchema),
  reviewed_by: WorkspaceIdentifierSchema,
  review_note: z.string().min(1).max(1024),
});

export const ReviewedWorkspacePolicySchema = ReviewedPolicyBodySchema.extend({
  /** Computed over the canonical serialization of all effective fields above. */
  policy_digest: Sha256HexSchema,
});
export type ReviewedWorkspacePolicy = z.infer<typeof ReviewedWorkspacePolicySchema>;

export interface ReviewPolicyInput {
  readonly course_id: string;
  readonly lesson_id: string;
  readonly lesson_compiled_digest: string;
  readonly seed_manifest_digest: string;
  readonly sandbox_policy_digest: string;
  readonly terminal_access: Readonly<Record<string, TerminalWorkspaceAccess>>;
  readonly reviewed_by: string;
  readonly review_note: string;
}

/** Canonical serialization of the effective policy fields (the digest preimage). */
export function canonicalPolicySerialization(input: ReviewPolicyInput): string {
  return canonicalJsonV1({
    course_id: input.course_id,
    lesson_id: input.lesson_id,
    lesson_compiled_digest: input.lesson_compiled_digest,
    policy_version: REVIEWED_WORKSPACE_POLICY_VERSION,
    review_note: input.review_note,
    reviewed_by: input.reviewed_by,
    sandbox_policy_digest: input.sandbox_policy_digest,
    seed_manifest_digest: input.seed_manifest_digest,
    terminal_access: input.terminal_access,
  });
}

/** Digest binding every effective policy field. */
export function computePolicyDigest(input: ReviewPolicyInput): string {
  return sha256Hex(canonicalPolicySerialization(input));
}

/** Sorted reviewed operation ids of a policy. */
export function terminalOperationIds(policy: ReviewedWorkspacePolicy): readonly string[] {
  return Object.freeze([...Object.keys(policy.terminal_access).sort()]);
}

function coverageProblems(
  terminalAccess: Readonly<Record<string, TerminalWorkspaceAccess>>,
  expectedTerminalOperationIds: readonly string[],
): { missing: string[]; extra: string[] } {
  const expected = new Set(expectedTerminalOperationIds);
  const provided = new Set(Object.keys(terminalAccess));
  const missing = [...expected].filter((id) => !provided.has(id)).sort();
  const extra = [...provided].filter((id) => !expected.has(id)).sort();
  return { missing, extra };
}

/**
 * Create the reviewed policy (main-only registration). The caller supplies
 * the terminal_run operation ids derived from the canonical validated IR;
 * coverage must be exact — no missing, no extra ids — or registration
 * rejects NOT_AUTHORIZED with zero mutation. The returned policy is deeply
 * frozen: review cannot be edited in place, only replaced by a new review.
 */
export function createReviewedWorkspacePolicy(
  input: ReviewPolicyInput,
  expectedTerminalOperationIds: readonly string[],
): WorkspaceOutcome<ReviewedWorkspacePolicy> {
  const body = ReviewedPolicyBodySchema.safeParse({
    policy_version: REVIEWED_WORKSPACE_POLICY_VERSION,
    course_id: input.course_id,
    lesson_id: input.lesson_id,
    lesson_compiled_digest: input.lesson_compiled_digest,
    seed_manifest_digest: input.seed_manifest_digest,
    sandbox_policy_digest: input.sandbox_policy_digest,
    terminal_access: { ...input.terminal_access },
    reviewed_by: input.reviewed_by,
    review_note: input.review_note,
  });
  if (!body.success) {
    const first = body.error.issues[0];
    return rejected("INVALID_REQUEST", `reviewed policy rejected: ${first?.message ?? "unknown issue"}`);
  }
  const { missing, extra } = coverageProblems(body.data.terminal_access, expectedTerminalOperationIds);
  if (missing.length > 0 || extra.length > 0) {
    const details: string[] = [];
    if (missing.length > 0) details.push(`missing access for terminal_run operations: ${missing.join(", ")}`);
    if (extra.length > 0) details.push(`access for unknown operations: ${extra.join(", ")}`);
    return rejected("NOT_AUTHORIZED", `reviewed policy does not cover exactly the lesson terminal_run set (${details.join("; ")})`);
  }
  const policy_digest = computePolicyDigest(input);
  const parsed = ReviewedWorkspacePolicySchema.safeParse({ ...body.data, policy_digest });
  if (!parsed.success) {
    return rejected("INVALID_REQUEST", "internal: generated policy failed its own schema");
  }
  return { ok: true, value: deepFreeze(parsed.data) };
}

export interface PolicyExpectations {
  readonly expectedTerminalOperationIds?: readonly string[];
  readonly expectedCompiledDigest?: string;
  readonly expectedSeedManifestDigest?: string;
  readonly expectedCourseId?: string;
  readonly expectedLessonId?: string;
}

/**
 * Revalidate a policy and its bindings (registration/session-open path).
 * Recomputes the digest over the presented effective fields: any tampering
 * with IR digests, seed/sandbox digests, access entries, review identity
 * or note invalidates authorization (NOT_AUTHORIZED). Optional expectations
 * additionally bind the live lesson bytes and the terminal_run set.
 */
export function verifyReviewedWorkspacePolicy(
  policy: unknown,
  expectations: PolicyExpectations = {},
): WorkspaceOutcome<ReviewedWorkspacePolicy> {
  const parsed = ReviewedWorkspacePolicySchema.safeParse(policy);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return rejected("INVALID_REQUEST", `reviewed policy rejected: ${first?.message ?? "unknown issue"}`);
  }
  const value = parsed.data;
  const recomputed = computePolicyDigest({
    course_id: value.course_id,
    lesson_id: value.lesson_id,
    lesson_compiled_digest: value.lesson_compiled_digest,
    seed_manifest_digest: value.seed_manifest_digest,
    sandbox_policy_digest: value.sandbox_policy_digest,
    terminal_access: value.terminal_access,
    reviewed_by: value.reviewed_by,
    review_note: value.review_note,
  });
  if (recomputed !== value.policy_digest) {
    return rejected("NOT_AUTHORIZED", "reviewed policy digest mismatch: the review does not bind these fields");
  }
  if (expectations.expectedCourseId !== undefined && value.course_id !== expectations.expectedCourseId) {
    return rejected("NOT_AUTHORIZED", "reviewed policy binds a different course");
  }
  if (expectations.expectedLessonId !== undefined && value.lesson_id !== expectations.expectedLessonId) {
    return rejected("NOT_AUTHORIZED", "reviewed policy binds a different lesson");
  }
  if (expectations.expectedCompiledDigest !== undefined && value.lesson_compiled_digest !== expectations.expectedCompiledDigest) {
    return rejected("NOT_AUTHORIZED", "reviewed policy binds different compiled IR bytes");
  }
  if (expectations.expectedSeedManifestDigest !== undefined && value.seed_manifest_digest !== expectations.expectedSeedManifestDigest) {
    return rejected("NOT_AUTHORIZED", "reviewed policy binds a different seed manifest");
  }
  if (expectations.expectedTerminalOperationIds !== undefined) {
    const { missing, extra } = coverageProblems(value.terminal_access, expectations.expectedTerminalOperationIds);
    if (missing.length > 0 || extra.length > 0) {
      return rejected("NOT_AUTHORIZED", "reviewed policy does not cover exactly the live terminal_run set");
    }
  }
  return { ok: true, value: deepFreeze(value) };
}

/**
 * Resolve the trusted access capability for one reviewed operation.
 *
 * Deterministic and structural: the ONLY inputs are the verified policy and
 * the operation id. There is no command parameter — access can never be
 * inferred from command strings, only read from the digest-bound review.
 * Unknown operations (not covered by the review) reject NOT_AUTHORIZED.
 */
export function resolveTerminalAccess(
  policy: ReviewedWorkspacePolicy,
  operationId: string,
): WorkspaceOutcome<TerminalWorkspaceAccess> {
  if (typeof operationId !== "string" || operationId.length < 1 || operationId.length > 128) {
    return rejected("INVALID_REQUEST", "operation id must be 1..128 characters");
  }
  const verified = verifyReviewedWorkspacePolicy(policy);
  if (!verified.ok) return verified as { ok: false; rejection: WorkspaceRejection };
  const access = verified.value.terminal_access[operationId];
  if (access === undefined) {
    return rejected("NOT_AUTHORIZED", `operation '${operationId}' is not covered by the reviewed access policy`);
  }
  return { ok: true, value: access };
}
