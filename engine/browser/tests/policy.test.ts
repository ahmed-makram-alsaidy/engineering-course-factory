// P7.1 Policy Tests — policy_version = 1.
//
// Verifies ReviewedBrowserPolicyV1, ReviewedPortCapabilityV1, deterministic origin validation,
// tampering detection, and strict main-only ownership (no renderer authority).
// Pure, deterministic, offline.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_POLICY_VERSION,
  createReviewedBrowserPolicy,
  isOriginAllowed,
  ReviewedBrowserPolicyV1Schema,
  ReviewedPortCapabilityV1Schema,
  sha256Hex,
  verifyReviewedBrowserPolicy,
  type ReviewedBrowserPolicyV1,
  type ReviewedPortCapabilityV1,
} from "../src/policy.ts";

describe("P7.1 Policy: ReviewedPortCapabilityV1", () => {
  const validCapability: ReviewedPortCapabilityV1 = {
    kind: "reviewed_port_capability",
    capability_version: 1,
    capability_id: "cap-port-3000",
    lesson_id: "C01-L001",
    session_id: "sess-001",
    generation: 1,
    background_process_id: "dev_server",
    guest_port: 3000,
    reviewed_origin: "http://localhost:3000",
    policy_version: 1,
    policy_digest: sha256Hex("dummy-policy-digest"),
  };

  it("accepts valid main-only port capability contract", () => {
    const res = ReviewedPortCapabilityV1Schema.parse(validCapability);
    assert.deepEqual(res, validCapability);
    assert.equal(BROWSER_POLICY_VERSION, 1);
  });

  it("rejects hostile fields: hostPort, bindAddress, dockerFlags, networkMode", () => {
    const forbiddenKeys = ["hostPort", "bindAddress", "dockerFlags", "networkMode", "publishPort"];
    for (const key of forbiddenKeys) {
      const hostile = { ...validCapability, [key]: "unauthorized-value" };
      const check = ReviewedPortCapabilityV1Schema.safeParse(hostile);
      assert.equal(check.success, false, `ReviewedPortCapabilityV1 must reject hostile key '${key}'`);
    }
  });

  it("validates port range [1-65535]", () => {
    assert.equal(ReviewedPortCapabilityV1Schema.safeParse({ ...validCapability, guest_port: 0 }).success, false);
    assert.equal(ReviewedPortCapabilityV1Schema.safeParse({ ...validCapability, guest_port: 65536 }).success, false);
    assert.equal(ReviewedPortCapabilityV1Schema.safeParse({ ...validCapability, guest_port: -1 }).success, false);
    assert.equal(ReviewedPortCapabilityV1Schema.safeParse({ ...validCapability, guest_port: 3000 }).success, true);
  });
});

describe("P7.1 Policy: ReviewedBrowserPolicyV1 Creation & Integrity", () => {
  const COMPILED_DIGEST = sha256Hex("compiled-lesson-bytes");
  const LESSON_ID = "C01-L001";
  const COURSE_ID = "C01";

  function makeSamplePolicy(): ReviewedBrowserPolicyV1 {
    return createReviewedBrowserPolicy({
      course_id: COURSE_ID,
      lesson_id: LESSON_ID,
      compiled_ir_digest: COMPILED_DIGEST,
      allowed_origins: ["http://localhost:3000", "https://api.example.com"],
      reviewed_operations: {
        "op-open-1": { operation_id: "op-open-1", action_type: "browser_open", target_origin: "http://localhost:3000" },
        "op-click-1": { operation_id: "op-click-1", action_type: "browser_click" },
      },
      port_capabilities: [
        {
          kind: "reviewed_port_capability",
          capability_version: 1,
          capability_id: "cap-port-3000",
          lesson_id: LESSON_ID,
          session_id: "sess-001",
          generation: 1,
          background_process_id: "dev_server",
          guest_port: 3000,
          reviewed_origin: "http://localhost:3000",
          policy_version: 1,
          policy_digest: COMPILED_DIGEST,
        },
      ],
    });
  }

  it("creates an immutable, digest-bound policy", () => {
    const policy = makeSamplePolicy();
    assert.equal(policy.kind, "reviewed_browser_policy");
    assert.equal(policy.policy_version, 1);
    assert.equal(policy.lesson_id, LESSON_ID);
    assert.equal(policy.compiled_ir_digest, COMPILED_DIGEST);
    assert.equal(typeof policy.policy_digest, "string");
    assert.equal(policy.policy_digest.length, 64);

    // Deep freeze check
    assert.throws(() => {
      (policy as any).lesson_id = "modified";
    });
  });

  it("verifies clean policy against matching facts", () => {
    const policy = makeSamplePolicy();
    const res = verifyReviewedBrowserPolicy(policy, COMPILED_DIGEST, LESSON_ID);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.policy.lesson_id, LESSON_ID);
    }
  });

  it("rejects policy on lesson mismatch", () => {
    const policy = makeSamplePolicy();
    const res = verifyReviewedBrowserPolicy(policy, COMPILED_DIGEST, "DIFFERENT-LESSON");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "POLICY_DENIED");
    }
  });

  it("rejects policy on compiled IR digest mismatch", () => {
    const policy = makeSamplePolicy();
    const res = verifyReviewedBrowserPolicy(policy, sha256Hex("different-digest"), LESSON_ID);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "POLICY_DENIED");
    }
  });

  it("rejects tampered policy where digest does not match content", () => {
    const policy = makeSamplePolicy();
    // Tamper with allowed_origins
    const tampered = {
      ...policy,
      allowed_origins: [...policy.allowed_origins, "http://evil.com"],
    };
    const res = verifyReviewedBrowserPolicy(tampered, COMPILED_DIGEST, LESSON_ID);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "POLICY_DENIED");
      assert.match(res.rejection.message, /tampered/);
    }
  });
});

describe("P7.1 Policy: Deterministic Origin Allowlisting", () => {
  const policy = createReviewedBrowserPolicy({
    course_id: "C01",
    lesson_id: "C01-L001",
    compiled_ir_digest: sha256Hex("ir"),
    allowed_origins: ["http://localhost:3000", "https://api.example.com", "http://127.0.0.1:8080"],
    reviewed_operations: {},
  });

  it("allows exact match and URLs matching allowed origins", () => {
    assert.equal(isOriginAllowed(policy, "http://localhost:3000"), true);
    assert.equal(isOriginAllowed(policy, "http://localhost:3000/app/page.html?query=1"), true);
    assert.equal(isOriginAllowed(policy, "https://api.example.com/v1/users"), true);
    assert.equal(isOriginAllowed(policy, "http://127.0.0.1:8080/"), true);
  });

  it("rejects unreviewed ports on loopback", () => {
    assert.equal(isOriginAllowed(policy, "http://localhost:3001"), false);
    assert.equal(isOriginAllowed(policy, "http://localhost:80"), false);
    assert.equal(isOriginAllowed(policy, "http://127.0.0.1:8081"), false);
  });

  it("rejects scheme changes (https vs http)", () => {
    assert.equal(isOriginAllowed(policy, "https://localhost:3000"), false);
    assert.equal(isOriginAllowed(policy, "http://api.example.com"), false);
  });

  it("strictly prevents naive startsWith bypass attacks", () => {
    // Malicious domains trying to prefix-match "http://localhost"
    assert.equal(isOriginAllowed(policy, "http://localhost.evil.com:3000"), false);
    assert.equal(isOriginAllowed(policy, "http://localhost:3000.attacker.com"), false);
    assert.equal(isOriginAllowed(policy, "http://localhost:3000@evil.com"), false);
  });

  it("rejects malformed or invalid URL strings gracefully", () => {
    assert.equal(isOriginAllowed(policy, "not-a-url"), false);
    assert.equal(isOriginAllowed(policy, ""), false);
    assert.equal(isOriginAllowed(policy, "ftp://localhost:3000"), false);
  });
});
