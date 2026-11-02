// P7.5 Browser Action Executor: Full 7-Action Coordination, Journal & Ordering Tests
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7, 18, 21 & Task P7.5.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { BrowserActionExecutor } from "../src/actions/executor.ts";
import {
  BrowserAdmissionSession,
  createReviewedBrowserCatalog,
} from "../src/admission.ts";
import { createReviewedBrowserPolicy } from "../src/policy.ts";
import { BrowserSessionJournal } from "../src/runtime.ts";
import type { BrowserSession } from "../src/session.ts";
import type { ManagedPageHandle } from "../src/context.ts";
import type { Locator, Page } from "playwright-core";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

function buildFullLesson(): CompiledLesson {
  const lessonData = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: "C01-L075",
    title: "P7.5 Action Coordination Test Lesson",
    language: "en",
    subject: "Computer Science",
    grade_level: "grade-11",
    duration: 300,
    learning_objectives: ["Test full 7 browser action execution"],
    prerequisites: [],
    keywords: ["browser", "actions"],
    metadata: { synthetic: true, phase: "P7.5" },
    scenes: [
      {
        scene_id: "C01-L075-S001",
        type: "code_demo",
        title: "Full 7 Actions Scene",
        duration: 180,
        visual: { kind: "browser", description: "Action view" },
        beats: [
          {
            beat_id: "C01-L075-S001-B001",
            kind: "action",
            action: {
              type: "browser_open",
              url: "http://127.0.0.1:3000/form",
            },
          },
          {
            beat_id: "C01-L075-S001-B002",
            kind: "action",
            action: {
              type: "browser_fill",
              selector: { strategy: "label", value: "Username" },
              value: "student_one",
            },
          },
          {
            beat_id: "C01-L075-S001-B003",
            kind: "action",
            action: {
              type: "browser_click",
              selector: { strategy: "role", value: "button", name: "Submit" },
            },
          },
          {
            beat_id: "C01-L075-S001-B004",
            kind: "action",
            action: {
              type: "browser_press",
              key: "Tab",
            },
          },
          {
            beat_id: "C01-L075-S001-B005",
            kind: "action",
            action: {
              type: "browser_wait",
              selector: { strategy: "role", value: "button", name: "Submit" },
              timeout_seconds: 5,
            },
          },
          {
            beat_id: "C01-L075-S001-B006",
            kind: "action",
            action: {
              type: "browser_assert",
              url_contains: "/form",
            },
          },
          {
            beat_id: "C01-L075-S001-B007",
            kind: "action",
            action: {
              type: "browser_refresh",
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

function createTestHarness(sessionId = "sess-full-7", generation = 1) {
  const compiledLesson = buildFullLesson();
  const catalog = createReviewedBrowserCatalog(compiledLesson);

  const policy = createReviewedBrowserPolicy({
    lesson_id: catalog.lesson_id,
    course_id: catalog.course_id,
    compiled_ir_digest: catalog.compiled_ir_digest,
    reviewed_operations: {
      "C01-L075-S001-B001": { operation_id: "C01-L075-S001-B001", action_type: "browser_open" },
      "C01-L075-S001-B002": { operation_id: "C01-L075-S001-B002", action_type: "browser_fill" },
      "C01-L075-S001-B003": { operation_id: "C01-L075-S001-B003", action_type: "browser_click" },
      "C01-L075-S001-B004": { operation_id: "C01-L075-S001-B004", action_type: "browser_press" },
      "C01-L075-S001-B005": { operation_id: "C01-L075-S001-B005", action_type: "browser_wait" },
      "C01-L075-S001-B006": { operation_id: "C01-L075-S001-B006", action_type: "browser_assert" },
      "C01-L075-S001-B007": { operation_id: "C01-L075-S001-B007", action_type: "browser_refresh" },
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
    isVisible: async () => true,
    textContent: async () => "Submit",
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
  };
}

describe("P7.5 Action Executor: Complete 7-Action Progression & Journaling", () => {
  it("proves sequential execution of all 7 browser actions in strict monotonic order", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle, journal, actionDispatchLog } =
      createTestHarness();

    const ops = [
      { id: "C01-L075-S001-B001", type: "browser_open" },
      { id: "C01-L075-S001-B002", type: "browser_fill" },
      { id: "C01-L075-S001-B003", type: "browser_click" },
      { id: "C01-L075-S001-B004", type: "browser_press" },
      { id: "C01-L075-S001-B005", type: "browser_wait" },
      { id: "C01-L075-S001-B006", type: "browser_assert" },
      { id: "C01-L075-S001-B007", type: "browser_refresh" },
    ];

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const res = await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
        session_id: mockSession.sessionId,
        operation_id: op.id,
        request_id: `req-${i + 1}`,
      });

      assert.equal(res.ok, true);
      if (!res.ok) return;
      assert.equal(res.receipt.outcome, "completed");
      assert.equal(res.receipt.operation_id, op.id);
    }

    // Verify action dispatch sequence
    assert.deepEqual(actionDispatchLog, [
      "page.goto:http://127.0.0.1:3000/form",
      "locator.fill:student_one",
      "locator.click",
      "keyboard.press:Tab",
      "page.reload",
    ]);

    // Verify journal events
    const events = journal.getEvents();
    assert.equal(events.length >= 14, true);

    // Filter started and completed events
    const started = events.filter((e) => e.type === "browser.operation.started");
    const completed = events.filter((e) => e.type === "browser.operation.completed");
    const navCompleted = events.filter((e) => e.type === "browser.navigation.completed");

    assert.equal(started.length, 7);
    assert.equal(completed.length, 7);
    // browser_open and browser_refresh both emit browser.navigation.completed
    assert.equal(navCompleted.length, 2);
  });

  it("proves out-of-order operation execution is rejected across the 7 actions", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle } = createTestHarness();

    // Trying to run B003 (click) before B001 (open)
    const res = await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L075-S001-B003",
      request_id: "req-ooo-1",
    });

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.rejection.code, "OUT_OF_ORDER_OPERATION");
  });

  it("proves duplicate request_id returns idempotent rejection without re-dispatch", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle, actionDispatchLog } = createTestHarness();

    // First run of B001
    const res1 = await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L075-S001-B001",
      request_id: "req-dup-1",
    });
    assert.equal(res1.ok, true);

    const initialDispatchCount = actionDispatchLog.length;

    // Duplicate run with identical request_id
    const res2 = await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L075-S001-B001",
      request_id: "req-dup-1",
    });
    assert.equal(res2.ok, false);
    if (!res2.ok) {
      assert.equal(res2.rejection.code, "OPERATION_ALREADY_COMPLETED");
    }

    // No secondary side-effect
    assert.equal(actionDispatchLog.length, initialDispatchCount);
  });

  it("proves completed operation with new request_id is rejected by tombstone", async () => {
    const { admissionSession, executor, mockSession, mockPageHandle } = createTestHarness();

    await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L075-S001-B001",
      request_id: "req-fresh-1",
    });

    // Attempt to re-run with fresh request_id
    const res2 = await executor.executeWithAdmission(admissionSession, mockSession, mockPageHandle, {
      session_id: mockSession.sessionId,
      operation_id: "C01-L075-S001-B001",
      request_id: "req-fresh-2",
    });

    assert.equal(res2.ok, false);
    if (res2.ok) return;
    assert.equal(res2.rejection.code, "OPERATION_ALREADY_COMPLETED");
  });
});
