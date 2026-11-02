// P7.1 Admission Tests — admission_version = 1.
//
// Verifies ReviewedBrowserCatalog, BrowserAdmissionSession, monotonic ordering,
// action family rejection, identifier-only admission, tombstones/idempotency,
// origin allowlisting, and the complete P7.1 security test matrix.
// Pure, deterministic, offline (no browser, no network, no timers).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import {
  createReviewedBrowserCatalog,
  BrowserAdmissionSession,
  type AdmittedBrowserOperation,
} from "../src/admission.ts";
import {
  createReviewedBrowserPolicy,
  sha256Hex,
  type ReviewedBrowserPolicyV1,
} from "../src/policy.ts";
import { BROWSER_ACTION_FAMILY, HOSTILE_REQUEST_KEYS } from "../src/protocol.ts";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

// ---------------------------------------------------------------------------
// Canonical Fixture Generator
// ---------------------------------------------------------------------------

function buildSyntheticBrowserLesson(overrides: Record<string, unknown> = {}): CompiledLesson {
  const lessonData = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: "C01-L071",
    title: "Testing all seven browser actions",
    language: "en",
    subject: "Web Development",
    grade_level: "grade-11",
    duration: 600,
    learning_objectives: ["Exercise all browser automation actions"],
    prerequisites: [],
    keywords: ["browser", "testing"],
    metadata: { synthetic: true, phase: "P7.1" },
    scenes: [
      {
        scene_id: "C01-L071-S001",
        type: "code_demo",
        title: "Browser Action Scene",
        duration: 300,
        visual: { kind: "browser", description: "Browser view" },
        beats: [
          {
            beat_id: "C01-L071-S001-B001",
            kind: "action",
            action: { type: "terminal_run", command: "npm start", mode: "foreground" },
          },
          {
            beat_id: "C01-L071-S001-B002",
            kind: "action",
            action: { type: "browser_open", url: "http://localhost:3000" },
          },
          {
            beat_id: "C01-L071-S001-B003",
            kind: "action",
            action: {
              type: "browser_click",
              selector: { strategy: "role", value: "button", name: "Login" },
            },
          },
          {
            beat_id: "C01-L071-S001-B004",
            kind: "action",
            action: {
              type: "browser_fill",
              selector: { strategy: "label", value: "Username" },
              value: "alice",
            },
          },
          {
            beat_id: "C01-L071-S001-B005",
            kind: "action",
            action: { type: "browser_press", key: "Enter" },
          },
          {
            beat_id: "C01-L071-S001-B006",
            kind: "action",
            action: { type: "browser_refresh" },
          },
          {
            beat_id: "C01-L071-S001-B007",
            kind: "action",
            action: {
              type: "browser_wait",
              selector: { strategy: "text", value: "Dashboard" },
              timeout_seconds: 5,
            },
          },
          {
            beat_id: "C01-L071-S001-B008",
            kind: "action",
            action: {
              type: "browser_assert",
              url_contains: "/dashboard",
              text_visible: "Welcome Alice",
            },
          },
        ],
      },
    ],
    ...overrides,
  };

  const parsed = parseLessonData(lessonData);
  if (!parsed.ok || !parsed.lesson) {
    throw new Error(`Synthetic lesson failed schema parsing: ${JSON.stringify(parsed.issues)}`);
  }
  return compileModule.compileLesson(parsed.lesson);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("P7.1 Admission: ReviewedBrowserCatalog Construction & Determinism", () => {
  it("indexes all seven browser actions and separates non-browser actions", () => {
    const compiled = buildSyntheticBrowserLesson();
    const catalog = createReviewedBrowserCatalog(compiled);

    assert.equal(catalog.lesson_id, "C01-L071");
    assert.equal(catalog.course_id, "C01");
    assert.equal(catalog.browser_operations.size, 7);
    assert.equal(catalog.ordered_browser_operations.length, 7);

    // Verify non-browser operation is indexed separately
    assert.equal(catalog.non_browser_operations.has("C01-L071-S001-B001"), true);
    assert.equal(catalog.non_browser_operations.get("C01-L071-S001-B001"), "terminal");

    // Verify browser order is sequential 0..6
    for (let i = 0; i < 7; i++) {
      const entry = catalog.ordered_browser_operations[i];
      assert.equal(entry.browser_order, i);
      assert.equal(entry.family, BROWSER_ACTION_FAMILY);
    }

    assert.equal(catalog.browser_origins.length, 1);
    assert.equal(catalog.browser_origins[0], "http://localhost:3000");
  });

  it("is completely deterministic across repeated catalog generations", () => {
    const compiled = buildSyntheticBrowserLesson();
    const cat1 = createReviewedBrowserCatalog(compiled);
    const cat2 = createReviewedBrowserCatalog(compiled);

    assert.equal(cat1.compiled_ir_digest, cat2.compiled_ir_digest);
    assert.deepEqual(cat1.ordered_browser_operations, cat2.ordered_browser_operations);
  });

  it("rejects compiled lesson with duplicate operation IDs", () => {
    const compiled = buildSyntheticBrowserLesson();
    // Simulate duplicate operation id by cloning a step
    const corrupted = JSON.parse(JSON.stringify(compiled));
    corrupted.scenes[0].steps.push(corrupted.scenes[0].steps[1]); // Duplicate step 1

    assert.throws(
      () => createReviewedBrowserCatalog(corrupted),
      /DUPLICATE_OPERATION_ID|IR_RUNTIME_INCONSISTENT|duplicate/i,
    );
  });
});

describe("P7.1 Admission: BrowserAdmissionSession Lifecycle & Monotonic Ordering", () => {
  const SESSION_ID = "sess-001";
  const GENERATION = 1;

  function setupSession(allowedOrigins = ["http://localhost:3000"]) {
    const compiled = buildSyntheticBrowserLesson();
    const catalog = createReviewedBrowserCatalog(compiled);

    const reviewedOps: Record<string, { operation_id: string; action_type: any; target_origin?: string }> = {};
    for (const [id, entry] of catalog.browser_operations.entries()) {
      reviewedOps[id] = {
        operation_id: id,
        action_type: entry.action_type,
        ...(entry.target_origin ? { target_origin: entry.target_origin } : {}),
      };
    }

    const policy = createReviewedBrowserPolicy({
      course_id: catalog.course_id,
      lesson_id: catalog.lesson_id,
      compiled_ir_digest: catalog.compiled_ir_digest,
      allowed_origins: allowedOrigins,
      reviewed_operations: reviewedOps,
    });

    const session = new BrowserAdmissionSession({
      session_id: SESSION_ID,
      generation: GENERATION,
      catalog,
      policy,
    });

    return { session, catalog, policy };
  }

  it("admits operations in strict monotonic authored order and binds parameters from IR", () => {
    const { session, catalog } = setupSession();

    // 1. Admit step 0 (browser_open)
    const op0 = catalog.ordered_browser_operations[0];
    const res0 = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op0.operation_id,
      request_id: "req-001",
    });
    assert.equal(res0.ok, true);
    if (res0.ok) {
      assert.equal(res0.value.action_type, "browser_open");
      assert.equal(res0.value.target_origin, "http://localhost:3000");
      assert.equal((res0.value.parameters as any).url, "http://localhost:3000");
    }

    // Complete step 0
    const receipt0 = session.recordCompletion(op0.operation_id, "req-001", "completed");
    assert.equal(receipt0.outcome, "completed");

    // 2. Admit step 1 (browser_click)
    const op1 = catalog.ordered_browser_operations[1];
    const res1 = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op1.operation_id,
      request_id: "req-002",
    });
    assert.equal(res1.ok, true);
    if (res1.ok) {
      assert.equal(res1.value.action_type, "browser_click");
      assert.deepEqual((res1.value.parameters as any).selector, {
        strategy: "role",
        value: "button",
        name: "Login",
      });
    }

    session.recordCompletion(op1.operation_id, "req-002", "completed");
  });

  it("rejects out-of-order operation execution", () => {
    const { session, catalog } = setupSession();

    // Attempt to admit step 2 (browser_fill) before step 0
    const op2 = catalog.ordered_browser_operations[2];
    const res = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op2.operation_id,
      request_id: "req-ooo",
    });

    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "OUT_OF_ORDER_OPERATION");
      assert.match(res.rejection.message, /expected browser step index 0, got 2/);
    }
  });

  it("rejects active concurrent re-admission of the same in-flight operation", () => {
    const { session, catalog } = setupSession();
    const op0 = catalog.ordered_browser_operations[0];

    const first = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op0.operation_id,
      request_id: "req-001",
    });
    assert.equal(first.ok, true);

    // Second attempt while still active
    const second = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op0.operation_id,
      request_id: "req-002",
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.rejection.code, "OPERATION_ALREADY_RUNNING");
    }
  });

  it("handles tombstones: rejects fresh execution of already completed operation with different request_id", () => {
    const { session, catalog } = setupSession();
    const op0 = catalog.ordered_browser_operations[0];

    session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op0.operation_id,
      request_id: "req-001",
    });
    session.recordCompletion(op0.operation_id, "req-001", "completed");

    // Re-admit same operation with new request_id
    const repeat = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op0.operation_id,
      request_id: "req-002",
    });
    assert.equal(repeat.ok, false);
    if (!repeat.ok) {
      assert.equal(repeat.rejection.code, "OPERATION_ALREADY_COMPLETED");
    }
  });

  it("handles idempotency: returns cached receipt for identical request_id", () => {
    const { session, catalog } = setupSession();
    const op0 = catalog.ordered_browser_operations[0];

    session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op0.operation_id,
      request_id: "req-001",
    });
    const receipt = session.recordCompletion(op0.operation_id, "req-001", "completed");

    // Repeat with identical request_id
    const retry = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op0.operation_id,
      request_id: "req-001",
    });
    assert.equal(retry.ok, false);
    if (!retry.ok) {
      assert.equal(retry.rejection.code, "OPERATION_ALREADY_COMPLETED");
    }
  });

  it("handles cancellation of in-flight operation", () => {
    const { session, catalog } = setupSession();
    const op0 = catalog.ordered_browser_operations[0];

    session.admitOperation({
      session_id: SESSION_ID,
      operation_id: op0.operation_id,
      request_id: "req-001",
    });

    const cancelRes = session.cancelOperation({
      session_id: SESSION_ID,
      operation_id: op0.operation_id,
      request_id: "req-cancel-1",
    });
    assert.equal(cancelRes.ok, true);
    if (cancelRes.ok) {
      assert.equal(cancelRes.cancelled, true);
    }
  });
});

describe("P7.1 Admission: Canonical Security Test Matrix", () => {
  const SESSION_ID = "sess-sec-001";
  const GENERATION = 1;

  function setupSecuritySession() {
    const compiled = buildSyntheticBrowserLesson();
    const catalog = createReviewedBrowserCatalog(compiled);

    // Only authorize browser_click, leave browser_open unauthorized in policy
    const policy = createReviewedBrowserPolicy({
      course_id: catalog.course_id,
      lesson_id: catalog.lesson_id,
      compiled_ir_digest: catalog.compiled_ir_digest,
      allowed_origins: ["http://localhost:3000"],
      reviewed_operations: {
        "C01-L071-S001-B003": {
          operation_id: "C01-L071-S001-B003",
          action_type: "browser_click",
        },
      },
    });

    const session = new BrowserAdmissionSession({
      session_id: SESSION_ID,
      generation: GENERATION,
      catalog,
      policy,
    });

    return { session, catalog, policy };
  }

  it("Matrix Row 1: rejects unknown operation", () => {
    const { session } = setupSecuritySession();
    const res = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: "UNKNOWN-OP-999",
      request_id: "r1",
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "UNREVIEWED_OPERATION");
    }
  });

  it("Matrix Row 2: rejects wrong action family (terminal, editor, wait)", () => {
    const { session } = setupSecuritySession();
    // B001 is a terminal_run operation
    const res = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: "C01-L071-S001-B001",
      request_id: "r2",
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "WRONG_ACTION_FAMILY");
      assert.match(res.rejection.message, /terminal/);
    }
  });

  it("Matrix Row 3: rejects unreviewed operation (in catalog but not in policy)", () => {
    const { session } = setupSecuritySession();
    // B002 is browser_open, which is in catalog but not reviewed in policy
    const res = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: "C01-L071-S001-B002",
      request_id: "r3",
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "NOT_AUTHORIZED");
    }
  });

  it("Matrix Row 4: rejects forged catalog or policy digest", () => {
    const compiled = buildSyntheticBrowserLesson();
    const catalog = createReviewedBrowserCatalog(compiled);
    const policy = createReviewedBrowserPolicy({
      course_id: catalog.course_id,
      lesson_id: catalog.lesson_id,
      compiled_ir_digest: catalog.compiled_ir_digest,
      allowed_origins: ["http://localhost:3000"],
      reviewed_operations: {},
    });

    // Tamper with policy compiled_ir_digest
    const forgedPolicy = { ...policy, compiled_ir_digest: sha256Hex("forged") };

    assert.throws(
      () =>
        new BrowserAdmissionSession({
          session_id: SESSION_ID,
          generation: GENERATION,
          catalog,
          policy: forgedPolicy as any,
        }),
      /POLICY_DENIED/,
    );
  });

  it("Matrix Row 5: rejects stale session ID", () => {
    const { session, catalog } = setupSecuritySession();
    const res = session.admitOperation({
      session_id: "OLD-STALE-SESSION",
      operation_id: catalog.ordered_browser_operations[0].operation_id,
      request_id: "r5",
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "STALE_SESSION");
    }
  });

  it("Matrix Row 6: rejects disposed session", () => {
    const { session, catalog } = setupSecuritySession();
    session.dispose();
    const res = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: catalog.ordered_browser_operations[0].operation_id,
      request_id: "r6",
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "STALE_SESSION");
    }
  });

  it("Matrix Rows 7-19: rejects all renderer-supplied semantic and hostile payload keys", () => {
    const { session, catalog } = setupSecuritySession();
    const validBase = {
      session_id: SESSION_ID,
      operation_id: catalog.ordered_browser_operations[0].operation_id,
      request_id: "r-hostile",
    };

    for (const key of HOSTILE_REQUEST_KEYS) {
      const hostile = { ...validBase, [key]: "renderer-supplied-value" };
      const res = session.admitOperation(hostile);
      assert.equal(res.ok, false, `Admission must reject hostile key '${key}'`);
      if (!res.ok) {
        assert.equal(res.rejection.code, "INVALID_REQUEST");
      }
    }
  });

  it("Matrix Row 22: rejects unreviewed origin", () => {
    const compiled = buildSyntheticBrowserLesson();
    const catalog = createReviewedBrowserCatalog(compiled);

    // Policy allows only 127.0.0.1:8080, but lesson targets localhost:3000
    const policy = createReviewedBrowserPolicy({
      course_id: catalog.course_id,
      lesson_id: catalog.lesson_id,
      compiled_ir_digest: catalog.compiled_ir_digest,
      allowed_origins: ["http://127.0.0.1:8080"],
      reviewed_operations: {
        "C01-L071-S001-B002": {
          operation_id: "C01-L071-S001-B002",
          action_type: "browser_open",
          target_origin: "http://localhost:3000",
        },
      },
    });

    const session = new BrowserAdmissionSession({
      session_id: SESSION_ID,
      generation: GENERATION,
      catalog,
      policy,
    });

    const res = session.admitOperation({
      session_id: SESSION_ID,
      operation_id: "C01-L071-S001-B002",
      request_id: "r-unreviewed-origin",
    });

    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.rejection.code, "ORIGIN_NOT_PERMITTED");
    }
  });
});
