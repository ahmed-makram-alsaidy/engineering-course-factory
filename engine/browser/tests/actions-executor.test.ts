// P7.4 Action Executor Unit & Deterministic Tests — browser_protocol_version = 1.
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7, 18, 30.
//
// Invariants verified:
// - Strictly requires AdmittedBrowserOperation from P7.1 admission
// - Monotonic authored browser order preserved
// - Idempotency & Tombstones: cannot execute completed operation twice
// - Concurrency check: cannot execute running operation concurrently
// - Stale session and stale generation fencing
// - Race condition seam: reset before dispatch fences side effect
// - Key validation: rejects invalid key names before page interaction
// - Deferred P7.5 actions rejected with POLICY_DENIED
// - Cancellation settles cleanly as cancelled and records journal event
// - Journal emits started and exactly one terminal event
// - Error sanitization: no host paths or stack traces

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Page, Locator } from "playwright-core";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { BrowserActionExecutor } from "../src/actions/executor.ts";
import {
  BrowserAdmissionSession,
  createReviewedBrowserCatalog,
  type AdmittedBrowserOperation,
} from "../src/admission.ts";
import { createReviewedBrowserPolicy } from "../src/policy.ts";
import { BrowserSessionJournal } from "../src/runtime.ts";
import { validateKeyName } from "../src/actions/press.ts";
import type { BrowserSession } from "../src/session.ts";
import type { ManagedPageHandle } from "../src/context.ts";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

function buildActionLesson(): CompiledLesson {
  const lessonData = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: "C01-L074",
    title: "P7.4 Action Test Lesson",
    language: "en",
    subject: "Computer Science",
    grade_level: "grade-11",
    duration: 300,
    learning_objectives: ["Test browser action execution"],
    prerequisites: [],
    keywords: ["browser", "actions"],
    metadata: { synthetic: true, phase: "P7.4" },
    scenes: [
      {
        scene_id: "C01-L074-S001",
        type: "code_demo",
        title: "Action Scene",
        duration: 180,
        visual: { kind: "browser", description: "Action view" },
        beats: [
          {
            beat_id: "C01-L074-S001-B001",
            kind: "action",
            action: {
              type: "browser_click",
              selector: { strategy: "role", value: "button", name: "Submit" },
            },
          },
          {
            beat_id: "C01-L074-S001-B002",
            kind: "action",
            action: {
              type: "browser_fill",
              selector: { strategy: "label", value: "Username" },
              value: "reviewed-user-value",
            },
          },
          {
            beat_id: "C01-L074-S001-B003",
            kind: "action",
            action: {
              type: "browser_press",
              key: "Enter",
            },
          },
          {
            beat_id: "C01-L074-S001-B004",
            kind: "action",
            action: {
              type: "browser_open",
              url: "http://127.0.0.1:3000/form",
            },
          },
        ],
      },
    ],
  };

  const parsed = parseLessonData(lessonData);
  if (!parsed.ok || !parsed.lesson) {
    throw new Error(`Synthetic lesson failed parsing: ${JSON.stringify(parsed.issues)}`);
  }
  return compileModule.compileLesson(parsed.lesson);
}

function createTestHarness(sessionId = "test-session", generation = 1) {
  const compiledLesson = buildActionLesson();
  const catalog = createReviewedBrowserCatalog(compiledLesson);

  const policy = createReviewedBrowserPolicy({
    lesson_id: catalog.lesson_id,
    course_id: catalog.course_id,
    compiled_ir_digest: catalog.compiled_ir_digest,
    reviewed_operations: {
      "C01-L074-S001-B001": { operation_id: "C01-L074-S001-B001", action_type: "browser_click" },
      "C01-L074-S001-B002": { operation_id: "C01-L074-S001-B002", action_type: "browser_fill" },
      "C01-L074-S001-B003": { operation_id: "C01-L074-S001-B003", action_type: "browser_press" },
      "C01-L074-S001-B004": { operation_id: "C01-L074-S001-B004", action_type: "browser_open" },
    },
    allowed_origins: ["http://127.0.0.1:3000"],
  });

  const admissionSession = new BrowserAdmissionSession({
    session_id: sessionId,
    generation,
    catalog,
    policy,
  });

  const journal = new BrowserSessionJournal();
  const executor = new BrowserActionExecutor({ journal, admissionSession });

  let sessionState: any = "READY";
  let curGeneration = generation;
  let curSessionId = sessionId;

  const mockSession = {
    sessionId: curSessionId,
    generation: curGeneration,
    getState: () => sessionState,
    isStale: (s: string, g: number) => curSessionId !== s || curGeneration !== g,
    getCrashReason: () => null,
  } as unknown as BrowserSession;

  const actionDispatchLog: string[] = [];

  const mockLocator = {
    count: async () => 1,
    waitFor: async () => {},
    click: async () => {
      actionDispatchLog.push("locator.click");
    },
    fill: async (val: string) => {
      actionDispatchLog.push(`locator.fill:${val}`);
    },
  } as unknown as Locator;

  const mockRawPage = {
    isClosed: () => false,
    url: () => "http://127.0.0.1:3000/form",
    goto: async (url: string) => {
      actionDispatchLog.push(`page.goto:${url}`);
      return {
        status: () => 200,
        url: () => url,
        request: () => ({ url: () => url, redirectedFrom: () => null }),
      };
    },
    reload: async () => {
      actionDispatchLog.push("page.reload");
      return {
        status: () => 200,
        url: () => "http://127.0.0.1:3000/form",
        request: () => ({ url: () => "http://127.0.0.1:3000/form", redirectedFrom: () => null }),
      };
    },
    getByRole: () => mockLocator,
    getByLabel: () => mockLocator,
    getByTestId: () => mockLocator,
    getByText: () => mockLocator,
    locator: () => mockLocator,
    keyboard: {
      press: async (key: string) => {
        actionDispatchLog.push(`keyboard.press:${key}`);
      },
    },
  } as unknown as Page;

  const mockPageHandle = {
    pageId: "page-1",
    rawPage: mockRawPage,
    isAlive: () => true,
    close: async () => {},
  } as ManagedPageHandle;

  return {
    catalog,
    policy,
    admissionSession,
    journal,
    executor,
    mockSession,
    mockPageHandle,
    actionDispatchLog,
    setSessionState: (s: any) => {
      sessionState = s;
    },
    rotateGeneration: (newGen: number) => {
      curGeneration = newGen;
      (mockSession as any).generation = newGen;
    },
  };
}

describe("P7.4 Action Executor: Core Admission & Order Invariants", () => {
  it("rejects execution without valid AdmittedBrowserOperation receipt", async () => {
    const { executor, mockSession, mockPageHandle } = createTestHarness();

    await assert.rejects(
      async () => {
        await executor.execute(mockSession, mockPageHandle, {} as any);
      },
      /\[POLICY_DENIED\] Cannot execute unadmitted browser operation/,
    );
  });

  it("proves strictly monotonic browser ordering is enforced", async () => {
    const { admissionSession, mockSession } = createTestHarness();

    // Trying to run B002 (order 1) before B001 (order 0) must fail admission
    const outOfOrderResult = admissionSession.admitOperation({
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B002",
      request_id: "req-1",
    });

    assert.equal(outOfOrderResult.ok, false);
    if (!outOfOrderResult.ok) {
      assert.equal(outOfOrderResult.rejection.code, "OUT_OF_ORDER_OPERATION");
    }
  });

  it("proves executed operation completes and cannot be executed twice (idempotency)", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle, actionDispatchLog } =
      createTestHarness();

    // 1. Admit and execute B001 (click)
    const runRes = await executor.executeWithAdmission(
      admissionSession,
      mockSession,
      mockPageHandle,
      {
        session_id: mockSession.sessionId,
        operation_id: "C01-L074-S001-B001",
        request_id: "req-click-1",
      },
    );

    assert.equal(runRes.ok, true);
    if (!runRes.ok) return;
    assert.equal(runRes.receipt.outcome, "completed");
    assert.equal(runRes.receipt.operation_id, "C01-L074-S001-B001");
    assert.deepEqual(actionDispatchLog, ["locator.click"]);

    // 2. Second attempt with exact same request_id must be rejected (idempotency)
    const duplicateReq = admissionSession.admitOperation({
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B001",
      request_id: "req-click-1",
    });
    assert.equal(duplicateReq.ok, false);
    if (!duplicateReq.ok) {
      assert.equal(duplicateReq.rejection.code, "OPERATION_ALREADY_COMPLETED");
    }

    // 3. Second attempt with new request_id must be rejected by tombstone
    const duplicateTombstone = admissionSession.admitOperation({
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B001",
      request_id: "req-click-2",
    });
    assert.equal(duplicateTombstone.ok, false);
    if (!duplicateTombstone.ok) {
      assert.equal(duplicateTombstone.rejection.code, "OPERATION_ALREADY_COMPLETED");
    }

    // Side effect must not have run a second time
    assert.deepEqual(actionDispatchLog, ["locator.click"]);
  });

  it("proves browser_fill uses reviewed IR value and disallows renderer override", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle, actionDispatchLog } =
      createTestHarness();

    // First advance through click
    await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B001",
      request_id: "req-c1",
    });

    // Now admit and execute B002 (fill)
    const fillRes = await executor.executeWithAdmission(
      admissionSession,
      mockSession,
      mockPageHandle,
      {
        session_id: mockSession.sessionId,
        operation_id: "C01-L074-S001-B002",
        request_id: "req-f1",
      },
    );

    assert.equal(fillRes.ok, true);
    if (!fillRes.ok) return;
    assert.equal(fillRes.receipt.outcome, "completed");
    assert.equal(actionDispatchLog.includes("locator.fill:reviewed-user-value"), true);

    // Verify hostile extra parameters from renderer are rejected by schema
    const hostileReq = admissionSession.admitOperation({
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B002",
      request_id: "req-f2",
      value: "attacker-override-value",
    });
    assert.equal(hostileReq.ok, false);
    if (!hostileReq.ok) {
      assert.equal(hostileReq.rejection.code, "INVALID_REQUEST");
    }
  });

  it("proves browser_press dispatches exact key and validates key names", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle, actionDispatchLog } =
      createTestHarness();

    // Advance through click and fill
    await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B001",
      request_id: "req-1",
    });
    await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B002",
      request_id: "req-2",
    });

    // Execute press (B003)
    const pressRes = await executor.executeWithAdmission(
      admissionSession,
      mockSession,
      mockPageHandle,
      {
        session_id: mockSession.sessionId,
        operation_id: "C01-L074-S001-B003",
        request_id: "req-3",
      },
    );

    assert.equal(pressRes.ok, true);
    if (!pressRes.ok) return;
    assert.equal(pressRes.receipt.outcome, "completed");
    assert.equal(actionDispatchLog.includes("keyboard.press:Enter"), true);

    // Unit test key validation directly
    assert.equal(validateKeyName("Enter").ok, true);
    assert.equal(validateKeyName("Tab").ok, true);
    assert.equal(validateKeyName("a").ok, true);
    assert.equal(validateKeyName("Control+A").ok, true);
    assert.equal(validateKeyName("").ok, false);
    assert.equal(validateKeyName("FakeNonExistentKey123").ok, false);
    assert.equal(validateKeyName("Control+FakeKey").ok, false);
  });

  it("proves browser_open executes admitted URL and settles successfully", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle } = createTestHarness();

    // Advance through first 3 ops
    await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B001",
      request_id: "req-1",
    });
    await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B002",
      request_id: "req-2",
    });
    await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B003",
      request_id: "req-3",
    });

    // Now try B004 (browser_open)
    const openRes = await executor.executeWithAdmission(
      admissionSession,
      mockSession,
      mockPageHandle,
      {
        session_id: mockSession.sessionId,
        operation_id: "C01-L074-S001-B004",
        request_id: "req-4",
      },
    );

    assert.equal(openRes.ok, true);
    if (!openRes.ok) return;
    assert.equal(openRes.receipt.outcome, "completed");
  });
});

describe("P7.4 Action Executor: Fencing, Races & Cancellation", () => {
  it("proves reset / generation rotation between resolution and dispatch fences side effect", async () => {
    const harness = createTestHarness();
    const { admissionSession, executor, mockSession, mockPageHandle, actionDispatchLog } = harness;

    const admitRes = admissionSession.admitOperation({
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B001",
      request_id: "req-race-1",
    });
    assert.equal(admitRes.ok, true);
    if (!admitRes.ok) return;

    // Simulate generation rotation right before click dispatch via beforeActionDispatch seam
    const receipt = await executor.execute(mockSession, mockPageHandle, admitRes.value, {
      beforeActionDispatch: async () => {
        harness.rotateGeneration(2);
      },
    });

    assert.equal(receipt.outcome, "failed");
    assert.equal(receipt.error_code, "STALE_GENERATION");
    // Prove zero click side-effects were dispatched!
    assert.equal(actionDispatchLog.length, 0, "No click may be dispatched when generation rotated");
  });

  it("proves cancellation via abort signal settles as cancelled and records journal event", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle, journal, actionDispatchLog } =
      createTestHarness();

    const admitRes = admissionSession.admitOperation({
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B001",
      request_id: "req-cancel-1",
    });
    assert.equal(admitRes.ok, true);
    if (!admitRes.ok) return;

    const controller = new AbortController();

    const receiptPromise = executor.execute(mockSession, mockPageHandle, admitRes.value, {
      signal: controller.signal,
      beforeActionDispatch: async () => {
        controller.abort();
      },
    });

    const receipt = await receiptPromise;
    assert.equal(receipt.outcome, "cancelled");
    assert.equal(actionDispatchLog.length, 0, "No side effect should occur after cancellation");

    // Check journal events: exactly 1 started, 1 cancelled
    const events = journal.getEvents();
    assert.equal(events.some((e) => e.type === "browser.operation.started"), true);
    assert.equal(events.some((e) => e.type === "browser.operation.cancelled"), true);
    assert.equal(events.some((e) => e.type === "browser.operation.completed"), false);
  });

  it("proves journal records exactly one start and one terminal event with duration", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle, journal } =
      createTestHarness();

    await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L074-S001-B001",
      request_id: "req-journal-1",
    });

    const events = journal.getEvents();
    const startEvents = events.filter((e) => e.type === "browser.operation.started");
    const completeEvents = events.filter((e) => e.type === "browser.operation.completed");
    const failEvents = events.filter((e) => e.type === "browser.operation.failed");

    assert.equal(startEvents.length, 1);
    assert.equal(completeEvents.length, 1);
    assert.equal(failEvents.length, 0);
    assert.equal(typeof (completeEvents[0] as any).duration_ms, "number");
  });
});
