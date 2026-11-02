// P6.1 reviewed access policy tests — the digest-bound main-only manifest.
//
// Proves: exact per-operation coverage, digest binding, tamper rejection,
// determinism, immutability, seed binding, no command inference, real-IR
// compatibility, and no source/IR change. Pure, offline, deterministic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionSchema } from "@course-factory/shared-types";
import {
  validateCompiledLesson,
  CompiledOperationSchema,
  type CompiledLesson,
} from "@course-factory/lesson-compiler/ir";
import {
  ReviewedWorkspacePolicySchema,
  computePolicyDigest,
  createReviewedWorkspacePolicy,
  createSeedManifest,
  computeSeedManifestDigest,
  resolveTerminalAccess,
  terminalOperationIds,
  verifyReviewedWorkspacePolicy,
  sha256Hex,
  type ReviewPolicyInput,
} from "../src/policy.ts";

const here = dirname(fileURLToPath(import.meta.url));

const COURSE = "C01";
const LESSON = "C01-L001";
const OP_DEV = "C01-L001-S001-B001";
const OP_TEST = "C01-L001-S001-B002";
const OP_BUILD = "C01-L001-S002-B001";

const COMPILED_DIGEST = sha256Hex("p61-synthetic-compiled-bytes");
const SEED_DIGEST = sha256Hex("p61-synthetic-seed-manifest");
const SANDBOX_DIGEST = sha256Hex("p61-synthetic-sandbox-policy");

function makeInput(overrides: Partial<ReviewPolicyInput> = {}): ReviewPolicyInput {
  return {
    course_id: COURSE,
    lesson_id: LESSON,
    lesson_compiled_digest: COMPILED_DIGEST,
    seed_manifest_digest: SEED_DIGEST,
    sandbox_policy_digest: SANDBOX_DIGEST,
    terminal_access: { [OP_DEV]: "read_only", [OP_TEST]: "read_write", [OP_BUILD]: "read_only" },
    reviewed_by: "review-board-1",
    review_note: "synthetic P6.1 review: dev watcher RO, test RW, build RO",
    ...overrides,
  };
}

const ALL_OPS = [OP_DEV, OP_TEST, OP_BUILD] as const;

function makePolicy(overrides: Partial<ReviewPolicyInput> = {}, expected: readonly string[] = [...ALL_OPS]) {
  const result = createReviewedWorkspacePolicy(makeInput(overrides), expected);
  assert.equal(result.ok, true, `policy creation must succeed: ${result.ok ? "" : result.rejection.message}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

describe("P6.1 reviewed operation maps to trusted access capability", () => {
  it("each reviewed operation resolves to exactly its reviewed access", () => {
    const policy = makePolicy();
    for (const [operationId, access] of Object.entries(makeInput().terminal_access)) {
      const resolved = resolveTerminalAccess(policy, operationId);
      assert.equal(resolved.ok, true, operationId);
      if (resolved.ok) assert.equal(resolved.value, access, operationId);
    }
  });

  it("resolution is deterministic across identical policies", () => {
    const first = makePolicy();
    const second = makePolicy();
    assert.equal(first.policy_digest, second.policy_digest);
    for (const operationId of ALL_OPS) {
      const a = resolveTerminalAccess(first, operationId);
      const b = resolveTerminalAccess(second, operationId);
      assert.deepEqual(a, b);
    }
  });

  it("terminalOperationIds lists exactly the reviewed set, sorted", () => {
    assert.deepEqual([...terminalOperationIds(makePolicy())], [...ALL_OPS].sort());
  });
});

describe("P6.1 exact coverage: missing/forged access rejects", () => {
  it("a missing terminal_run entry rejects NOT_AUTHORIZED at creation", () => {
    const result = createReviewedWorkspacePolicy(
      makeInput({ terminal_access: { [OP_DEV]: "read_only", [OP_TEST]: "read_write" } }),
      [...ALL_OPS],
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.rejection.code, "NOT_AUTHORIZED");
      assert.match(result.rejection.message, /C01-L001-S002-B001/);
    }
  });

  it("an extra unknown operation entry rejects NOT_AUTHORIZED at creation", () => {
    const result = createReviewedWorkspacePolicy(
      makeInput({ terminal_access: { [OP_DEV]: "read_only", [OP_TEST]: "read_write", [OP_BUILD]: "read_only", ["C01-L001-S009-B009"]: "read_write" } }),
      [...ALL_OPS],
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.rejection.code, "NOT_AUTHORIZED");
      assert.match(result.rejection.message, /C01-L001-S009-B009/);
    }
  });

  it("an empty lesson (no terminal_run) takes an explicit empty map", () => {
    const result = createReviewedWorkspacePolicy(makeInput({ terminal_access: {} }), []);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(terminalOperationIds(result.value), []);
  });

  it("resolving an operation outside the review rejects NOT_AUTHORIZED (forged access cannot be acquired)", () => {
    const policy = makePolicy();
    const resolved = resolveTerminalAccess(policy, "C01-L001-S009-B009");
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.rejection.code, "NOT_AUTHORIZED");
  });

  it("a malformed operation id rejects INVALID_REQUEST before lookup", () => {
    const policy = makePolicy();
    assert.equal(resolveTerminalAccess(policy, "").ok, false);
    const bad = resolveTerminalAccess(policy, "");
    if (!bad.ok) assert.equal(bad.rejection.code, "INVALID_REQUEST");
  });
});

describe("P6.1 digest binding: tampering invalidates authorization", () => {
  it("a flipped access entry invalidates the digest (verify + resolve reject)", () => {
    const policy = makePolicy();
    const tampered = { ...policy, terminal_access: { ...policy.terminal_access, [OP_DEV]: "read_write" as const } };
    const verified = verifyReviewedWorkspacePolicy(tampered);
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.rejection.code, "NOT_AUTHORIZED");
    const resolved = resolveTerminalAccess(tampered, OP_DEV);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.rejection.code, "NOT_AUTHORIZED");
  });

  it("a swapped compiled digest fails the live-bytes expectation", () => {
    const policy = makePolicy();
    const verified = verifyReviewedWorkspacePolicy(policy, { expectedCompiledDigest: sha256Hex("other-bytes") });
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.rejection.code, "NOT_AUTHORIZED");
  });

  it("a swapped seed digest fails the seed expectation", () => {
    const policy = makePolicy();
    const verified = verifyReviewedWorkspacePolicy(policy, { expectedSeedManifestDigest: sha256Hex("other-seed") });
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.rejection.code, "NOT_AUTHORIZED");
  });

  it("a policy bound to another lesson or course does not authorize this one", () => {
    const policy = makePolicy();
    for (const expectations of [{ expectedLessonId: "C01-L002" }, { expectedCourseId: "C02" }]) {
      const verified = verifyReviewedWorkspacePolicy(policy, expectations);
      assert.equal(verified.ok, false, JSON.stringify(expectations));
      if (!verified.ok) assert.equal(verified.rejection.code, "NOT_AUTHORIZED");
    }
  });

  it("verify re-checks live terminal_run coverage (lesson drift rejects)", () => {
    const policy = makePolicy();
    const verified = verifyReviewedWorkspacePolicy(policy, { expectedTerminalOperationIds: [OP_DEV, OP_TEST] });
    assert.equal(verified.ok, false);
    if (!verified.ok) assert.equal(verified.rejection.code, "NOT_AUTHORIZED");
  });
});

describe("P6.1 no command-string heuristic determines policy", () => {
  it("misleading commands resolve exactly per review, never per name", () => {
    // Deliberately backwards from any name-based guess: the dev-sounding
    // watcher is read-write here, the test-sounding command is read-only.
    const policy = makePolicy({
      terminal_access: { [OP_DEV]: "read_write", [OP_TEST]: "read_only", [OP_BUILD]: "read_only" },
      review_note: "synthetic P6.1 review with misleading command names",
    });
    const dev = resolveTerminalAccess(policy, OP_DEV);
    const test = resolveTerminalAccess(policy, OP_TEST);
    assert.equal(dev.ok && dev.value, "read_write");
    assert.equal(test.ok && test.value, "read_only");
  });

  it("resolution takes (policy, operationId) only — no command parameter exists structurally", () => {
    assert.equal(resolveTerminalAccess.length, 2);
    const source = resolveTerminalAccess.toString();
    assert.doesNotMatch(source, /command/);
  });

  it("policy creation input carries no command field (strict schema would reject it)", () => {
    const hostile = { ...makeInput(), command: "npm run dev" };
    const parsed = ReviewedWorkspacePolicySchema.safeParse({ ...hostile, policy_digest: computePolicyDigest(makeInput()) });
    assert.equal(parsed.success, false);
  });
});

describe("P6.1 seed manifest binding", () => {
  it("entries sort deterministically and the digest is stable", () => {
    const first = createSeedManifest([
      { portable_path: "src/b.ts", kind: "regular_file", byte_length: 3, sha256: sha256Hex("b") },
      { portable_path: "src/a.ts", kind: "regular_file", byte_length: 3, sha256: sha256Hex("a") },
      { portable_path: "src", kind: "directory", byte_length: 0, sha256: null },
    ]);
    const second = createSeedManifest([
      { portable_path: "src", kind: "directory", byte_length: 0, sha256: null },
      { portable_path: "src/a.ts", kind: "regular_file", byte_length: 3, sha256: sha256Hex("a") },
      { portable_path: "src/b.ts", kind: "regular_file", byte_length: 3, sha256: sha256Hex("b") },
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.deepEqual(first.value.entries.map((entry) => entry.portable_path), ["src", "src/a.ts", "src/b.ts"]);
      assert.equal(computeSeedManifestDigest(first.value), computeSeedManifestDigest(second.value));
    }
  });

  it("an empty manifest is explicit and digest-bound", () => {
    const created = createSeedManifest([]);
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.deepEqual(created.value.entries, []);
      assert.match(computeSeedManifestDigest(created.value), /^[0-9a-f]{64}$/);
    }
  });

  it("duplicate portable paths reject", () => {
    const created = createSeedManifest([
      { portable_path: "src/a.ts", kind: "regular_file", byte_length: 1, sha256: sha256Hex("a") },
      { portable_path: "src/a.ts", kind: "regular_file", byte_length: 1, sha256: sha256Hex("a") },
    ]);
    assert.equal(created.ok, false);
  });

  it("a file entry without a digest and a directory with bytes both reject", () => {
    const noDigest = createSeedManifest([
      { portable_path: "src/a.ts", kind: "regular_file", byte_length: 1, sha256: null },
    ]);
    assert.equal(noDigest.ok, false);
    const dirBytes = createSeedManifest([{ portable_path: "src", kind: "directory", byte_length: 8, sha256: null }]);
    assert.equal(dirBytes.ok, false);
  });
});

describe("P6.1 real-IR compatibility (no migration, no schema change)", () => {
  const compiledPath = join(here, "..", "..", "..", "apps", "teaching-ide", "fixtures", "compiled-lessons", "side-effect-safety.json");

  function loadTerminalRunIds(): { lesson: CompiledLesson; ids: string[] } {
    const raw: unknown = JSON.parse(readFileSync(compiledPath, "utf8"));
    const validated = validateCompiledLesson(raw);
    assert.equal(validated.ok, true, "canonical teaching-ide fixture must validate");
    if (!validated.ok || validated.ir === undefined) throw new Error("fixture failed canonical validation");
    const lesson = validated.ir;
    const ids: string[] = [];
    for (const scene of lesson.scenes) {
      for (const step of scene.steps) {
        if (step.kind === "operation" && step.operation.parameters.type === "terminal_run") ids.push(step.step_id);
      }
    }
    assert.ok(ids.length >= 1, "fixture must contain at least one terminal_run");
    return { lesson, ids };
  }

  it("reviewed policy covers the real compiled terminal_run set with no fixture migration", () => {
    const { lesson, ids } = loadTerminalRunIds();
    const access: Record<string, "read_only" | "read_write"> = {};
    for (const id of ids) access[id] = "read_only";
    const created = createReviewedWorkspacePolicy(
      makeInput({
        course_id: lesson.lesson.course_id,
        lesson_id: lesson.lesson.lesson_id,
        terminal_access: access,
        review_note: "synthetic P6.1 review over the canonical side-effect fixture",
      }),
      ids,
    );
    assert.equal(created.ok, true);
    if (created.ok) {
      for (const id of ids) {
        const resolved = resolveTerminalAccess(created.value, id);
        assert.equal(resolved.ok && resolved.value, "read_only", id);
      }
    }
  });

  it("lesson source schema still rejects access-injection fields (NO schema change)", () => {
    const base = { type: "terminal_run", command: "node --version", mode: "foreground" } as const;
    for (const field of ["workspace_access", "read_only", "read_write", "editor_write"]) {
      const parsed = ActionSchema.safeParse({ ...base, [field]: "read_only" });
      assert.equal(parsed.success, false, `source schema must reject '${field}'`);
    }
    const editorBase = { type: "type_code", path: "src/a.ts", content: "x" } as const;
    for (const field of ["workspace_access", "read_only", "read_write", "editor_write"]) {
      const parsed = ActionSchema.safeParse({ ...editorBase, [field]: "read_write" });
      assert.equal(parsed.success, false, `source schema must reject '${field}' on editor actions`);
    }
  });

  it("compiled IR still rejects access-injection fields (NO IR change)", () => {
    const operation = {
      type: "terminal_run",
      family: "terminal",
      parameters: { type: "terminal_run", command: "node --version", mode: "foreground" },
    } as const;
    for (const field of ["workspace_access", "read_only", "read_write", "editor_write"]) {
      const parsed = CompiledOperationSchema.safeParse({ ...operation, [field]: "read_only" });
      assert.equal(parsed.success, false, `compiled IR must reject '${field}'`);
    }
  });
});

describe("P6.1 policy output immutable and strict", () => {
  it("created policies are deeply frozen (review cannot be edited in place)", () => {
    const policy = makePolicy();
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.terminal_access), true);
    assert.throws(() => {
      (policy as unknown as Record<string, unknown>)["review_note"] = "forged";
    });
  });

  it("policy, permit and manifest schemas reject unknown keys", () => {
    const policy = makePolicy();
    const withExtra = { ...policy, conjectured_field: "x" };
    assert.equal(ReviewedWorkspacePolicySchema.safeParse(withExtra).success, false);
  });
});
