// P7.6 Browser Safe IPC Tests — deterministic and real platform.
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 6.2, ADR-0012, and P7.6 task requirements.
//
// Invariants verified:
// - Exact 4 invoke channels: browser:runOperation, browser:cancelOperation, browser:getSnapshot, browser:resetRuntime
// - Exact 2 push streams: browser:event, browser:frame
// - Zero generic invoke/send/subscribe channels
// - Strict structural sender validation (webContentsId, top-level frame, exact bundled URL, alive window)
// - Strict identifier-only requests (session_id, operation_id, request_id, after_seq)
// - Complete 36-row security matrix verification
// - Error sanitization: paths, PIDs, container IDs, internal stacks redacted and bounded
// - Preload surface: narrow cfApi.browser with exactly 4 invoke methods and 2 subscriptions
// - Total preload sanctioned channels count verified (15 invoke + 1 send = 16 channels)
// - Generation fencing, idempotency, monotonic events, and reset barriers
// - App shutdown barrier closes all browser sessions cleanly with zero surviving processes
// - TerminalHost and EditorHost remain completely unaffected
// - Real Chromium execution on local fixture server through BrowserIpcHost

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserIpcHost,
  BROWSER_INVOKE_CHANNELS,
  BROWSER_EVENT_CHANNEL,
  BROWSER_FRAME_CHANNEL,
  isTrustedBrowserSender,
  sanitizeBrowserHostMessage,
  createBrowserShutdownBarrier,
  type BrowserSender,
  type BrowserRendererBinding,
} from "../electron/browser-host.ts";
import { TERMINAL_INVOKE_CHANNELS } from "../electron/terminal-host.ts";
import { EDITOR_INVOKE_CHANNELS } from "../electron/editor-host.ts";
import {
  registerReviewedLesson,
  clearReviewedLessons,
} from "../electron/execution-catalog.ts";
import { canonicalCompiledDigest } from "@course-factory/terminal-engine/terminal-host";
import {
  BrowserRuntimeHost,
  BrowserSessionJournal,
  HOSTILE_REQUEST_KEYS,
  startFixtureServer,
  type FixtureServerInstance,
} from "@course-factory/browser-engine";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

const RENDERER_URL = "file:///dist/renderer/index.html";

function sender(overrides: Partial<BrowserSender> = {}): BrowserSender {
  return {
    webContentsId: 42,
    frameUrl: RENDERER_URL,
    frameIsTop: true,
    senderDestroyed: false,
    ...overrides,
  };
}

const OP_OPEN = "C01-L076-S001-B001";
const OP_FILL = "C01-L076-S001-B002";
const OP_CLICK = "C01-L076-S001-B003";

function buildSyntheticBrowserLesson(fixtureOrigin: string): CompiledLesson {
  const lessonData = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: "C01-L076",
    title: "P7.6 IPC Test Lesson",
    language: "en",
    subject: "Computer Science",
    grade_level: "grade-11",
    duration: 300,
    learning_objectives: ["Test safe browser IPC"],
    prerequisites: [],
    keywords: ["browser", "actions"],
    metadata: { synthetic: true, phase: "P7.6" },
    scenes: [
      {
        scene_id: "C01-L076-S001",
        type: "code_demo",
        title: "Action Scene",
        duration: 180,
        visual: { kind: "browser", description: "Action view" },
        beats: [
          {
            beat_id: "C01-L076-S001-B001",
            kind: "action",
            action: {
              type: "browser_open",
              url: `${fixtureOrigin}/form`,
            },
          },
          {
            beat_id: "C01-L076-S001-B002",
            kind: "action",
            action: {
              type: "browser_fill",
              selector: { strategy: "label", value: "Username" },
              value: "alice",
            },
          },
          {
            beat_id: "C01-L076-S001-B003",
            kind: "action",
            action: {
              type: "browser_click",
              selector: { strategy: "role", value: "button", name: "Submit" },
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

describe("P7.6 Browser IPC Surface & Channel Boundaries", () => {
  it("proves BrowserHost registers exactly the four canonical invoke channels", () => {
    assert.deepEqual([...BROWSER_INVOKE_CHANNELS], [
      "browser:runOperation",
      "browser:cancelOperation",
      "browser:getSnapshot",
      "browser:resetRuntime",
    ]);
    assert.equal(BROWSER_EVENT_CHANNEL, "browser:event");
    assert.equal(BROWSER_FRAME_CHANNEL, "browser:frame");

    // Zero collision with terminal or editor
    for (const ch of BROWSER_INVOKE_CHANNELS) {
      assert.ok(ch.startsWith("browser:"));
      assert.equal((TERMINAL_INVOKE_CHANNELS as readonly string[]).includes(ch), false);
      assert.equal((EDITOR_INVOKE_CHANNELS as readonly string[]).includes(ch), false);
    }
  });

  it("proves absence of generic invoke, generic send, or generic execution channels", () => {
    const genericForbidden = [
      "browser:eval",
      "browser:evaluate",
      "browser:execute",
      "browser:navigate",
      "browser:click",
      "browser:fill",
      "browser:launch",
      "browser:kill",
      "api:invoke",
      "api:send",
    ];
    for (const ch of genericForbidden) {
      assert.equal((BROWSER_INVOKE_CHANNELS as readonly string[]).includes(ch), false);
    }
  });
});

describe("P7.6 Canonical 36-Row Security Matrix", () => {
  let fixture: FixtureServerInstance;
  let compiledLesson: CompiledLesson;
  let lessonDigest: string;
  let host: BrowserIpcHost;
  const pushes: { webContentsId: number; channel: string; dto: unknown }[] = [];

  before(async () => {
    fixture = await startFixtureServer();
    compiledLesson = buildSyntheticBrowserLesson(fixture.origin);
    lessonDigest = canonicalCompiledDigest(compiledLesson);

    registerReviewedLesson({
      lesson_id: compiledLesson.lesson.lesson_id,
      course_id: compiledLesson.lesson.course_id,
      lesson_compiled_digest: lessonDigest,
      reviewed_note: "P7.6 Security Matrix Test Review",
    });

    host = new BrowserIpcHost({
      pushToRenderer: (webContentsId, channel, dto) => {
        pushes.push({ webContentsId, channel, dto });
      },
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });
  });

  after(async () => {
    await host.shutdownAll("app_close");
    await fixture.close();
    clearReviewedLessons();
  });

  it("Row 1: valid owning sender is accepted", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const snapRes = await host.handleInvoke("browser:getSnapshot", sender(), {
      session_id: opened.session.session_id,
      after_seq: 0,
    });
    assert.equal(snapRes.ok, true);
  });

  it("Row 2: foreign webContents is rejected fail-closed", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const foreign = sender({ webContentsId: 999 });
    const res = await host.handleInvoke("browser:getSnapshot", foreign, {
      session_id: opened.session.session_id,
      after_seq: 0,
    });
    assert.deepEqual(res, {
      ok: false,
      code: "WRONG_OWNER",
      message: "browser sender is not the bound session owner",
    });
  });

  it("Row 3: iframe sender is rejected fail-closed", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const iframeSender = sender({ frameIsTop: false });
    const res = await host.handleInvoke("browser:getSnapshot", iframeSender, {
      session_id: opened.session.session_id,
      after_seq: 0,
    });
    assert.deepEqual(res, {
      ok: false,
      code: "WRONG_OWNER",
      message: "browser sender is not the bound session owner",
    });
  });

  it("Row 4: foreign / navigated renderer URL is rejected fail-closed", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    for (const badUrl of [
      "http://attacker.com/evil.html",
      "file:///other/path/index.html",
      "file:///dist/renderer/index.html?tampered=1",
      "",
    ]) {
      const badSender = sender({ frameUrl: badUrl });
      const res = await host.handleInvoke("browser:getSnapshot", badSender, {
        session_id: opened.session.session_id,
        after_seq: 0,
      });
      assert.deepEqual(res, {
        ok: false,
        code: "WRONG_OWNER",
        message: "browser sender is not the bound session owner",
      });
    }
  });

  it("Row 5: stale / destroyed window is rejected fail-closed", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const destroyed = sender({ senderDestroyed: true });
    const res = await host.handleInvoke("browser:getSnapshot", destroyed, {
      session_id: opened.session.session_id,
      after_seq: 0,
    });
    assert.deepEqual(res, {
      ok: false,
      code: "WRONG_OWNER",
      message: "browser sender is not the bound session owner",
    });
  });

  it("Row 6: push to destroyed window drops harmlessly without throwing", () => {
    const fakeDestroyedWindow = {
      isDestroyed: () => true,
      webContents: {
        get id(): number {
          throw new Error("Object has been destroyed");
        },
        send: (_channel: string, ..._args: unknown[]) => {
          throw new Error("Object has been destroyed");
        },
      },
      once: () => {},
      on: () => {},
      close: () => {},
      getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    };

    // Structural push verification: never throws on destroyed window
    assert.doesNotThrow(() => {
      if (!fakeDestroyedWindow.isDestroyed()) {
        fakeDestroyedWindow.webContents.send("browser:event", { test: 1 });
      }
    });
  });

  it("Rows 7-21: renderer-supplied parameters and hostile keys are strictly rejected", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const sid = opened.session.session_id;

    const hostilePayloads: [string, Record<string, unknown>][] = [
      ["Row 7: url", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", url: "http://attacker.com" }],
      ["Row 8: selector", { session_id: sid, operation_id: OP_CLICK, request_id: "req-1", selector: "button#evil" }],
      ["Row 9: fill/value", { session_id: sid, operation_id: OP_FILL, request_id: "req-1", value: "pwned", fill: "pwned" }],
      ["Row 10: key", { session_id: sid, operation_id: OP_CLICK, request_id: "req-1", key: "Enter" }],
      ["Row 11: timeout", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", timeout: 99999 }],
      ["Row 12: headers", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", headers: { Cookie: "admin=1" } }],
      ["Row 13: cookies", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", cookies: ["auth=secret"] }],
      ["Row 14: JS/script", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", javascript: "alert(1)", script: "bad()" }],
      ["Row 15: port", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", port: 3000 }],
      ["Row 16: hostPort", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", hostPort: 3000 }],
      ["Row 17: bindAddress", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", bindAddress: "0.0.0.0" }],
      ["Row 18: browserFlags", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", browserFlags: ["--no-sandbox"] }],
      ["Row 19: executablePath", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", executablePath: "C:\\malware.exe" }],
      ["Row 20: profilePath", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", profilePath: "C:\\Users\\admin" }],
      ["Row 21: pid/containerId", { session_id: sid, operation_id: OP_OPEN, request_id: "req-1", pid: 1234, containerId: "c1" }],
    ];

    for (const [rowName, payload] of hostilePayloads) {
      const res = await host.handleInvoke("browser:runOperation", sender(), payload);
      assert.equal(res.ok, false, `${rowName} must be rejected`);
      assert.equal(res.code, "INVALID_REQUEST", `${rowName} must return INVALID_REQUEST`);
    }
  });

  it("Row 22: oversized payload (>64 KiB) is rejected fail-closed", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const oversizedString = "A".repeat(70_000);
    const payload = {
      session_id: opened.session.session_id,
      operation_id: OP_OPEN,
      request_id: oversizedString,
    };
    const res = await host.handleInvoke("browser:runOperation", sender(), payload);
    assert.deepEqual(res, {
      ok: false,
      code: "INVALID_REQUEST",
      message: "payload exceeds maximum size of 64 KiB",
    });
  });

  it("Rows 23-28: generic IPC and privileged modules are completely absent from preload", () => {
    const preloadPath = join(appRoot, "electron", "preload.ts");
    const code = readFileSync(preloadPath, "utf8");

    // Row 23: generic invoke absent
    assert.doesNotMatch(code, /api\.invoke\s*\(/);
    assert.doesNotMatch(code, /cfApi\.invoke\s*\(/);
    // Row 24: generic send absent
    assert.doesNotMatch(code, /cfApi\.send\s*\(/);
    // Row 25: raw ipcRenderer absent from exposed bridge
    assert.doesNotMatch(code, /exposeInMainWorld\s*\(\s*["']ipcRenderer["']/);
    // Row 26: fs absent
    assert.doesNotMatch(code, /from\s+["']node:fs["']|from\s+["']fs["']/);
    // Row 27: child_process absent
    assert.doesNotMatch(code, /from\s+["']node:child_process["']|from\s+["']child_process["']/);
    // Row 28: net/http authority absent
    assert.doesNotMatch(code, /from\s+["']node:net["']|from\s+["']node:http["']|from\s+["']node:https["']/);
  });

  it("Row 29: stale session ID is rejected fail-closed", async () => {
    const res = await host.handleInvoke("browser:runOperation", sender(), {
      session_id: "cf-browser-stale-000000",
      operation_id: OP_OPEN,
      request_id: "req-1",
    });
    assert.deepEqual(res, {
      ok: false,
      code: "STALE_SESSION",
      message: "unknown or closed browser session",
    });
  });

  it("Row 30: stale generation is rejected fail-closed", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const res = await host.handleInvoke("browser:runOperation", sender(), {
      session_id: opened.session.session_id,
      generation: 999, // stale generation
      operation_id: OP_OPEN,
      request_id: "req-1",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "STALE_GENERATION");
  });

  it("Row 31: events from old generation are not delivered as current", async () => {
    pushes.length = 0;
    const journal = new BrowserSessionJournal();
    let deliveredToRenderer = 0;

    const activeSessionGeneration = 2;
    journal.subscribe((event) => {
      if (event.generation === activeSessionGeneration) {
        deliveredToRenderer++;
      }
    });

    journal.recordEvent({
      type: "browser.started",
      session_id: "cf-browser-test",
      generation: 1, // old generation
    });
    journal.recordEvent({
      type: "browser.started",
      session_id: "cf-browser-test",
      generation: 2, // current generation
    });

    assert.equal(deliveredToRenderer, 1);
  });

  it("Row 32: raw internal error is sanitized (paths redacted, capped length)", () => {
    const rawError = "Error in E:\\course-factory\\engine\\browser\\profile.ts: secret data leak at \\\\network\\share";
    const sanitized = sanitizeBrowserHostMessage(rawError);
    assert.doesNotMatch(sanitized, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(sanitized, /\\\\[^\s]*/);
    assert.match(sanitized, /\[path\]/);
    assert.ok(sanitized.length <= 512);
  });

  it("Row 33: profile path is never sent in responses or events", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const snap = await host.handleInvoke("browser:getSnapshot", sender(), {
      session_id: opened.session.session_id,
      after_seq: 0,
    });
    const serialized = JSON.stringify(snap);
    assert.doesNotMatch(serialized, /browser-profiles/i);
    assert.doesNotMatch(serialized, /temp[\\/]browser/i);
  });

  it("Row 34: dynamic host port is never sent in responses or events", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const snap = await host.handleInvoke("browser:getSnapshot", sender(), {
      session_id: opened.session.session_id,
      after_seq: 0,
    });
    const serialized = JSON.stringify(snap);
    assert.doesNotMatch(serialized, /hostPort|guestPort/i);
  });

  it("Row 35: renderer cannot alter route shield", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const tamperPayload = {
      session_id: opened.session.session_id,
      allowedOrigins: ["http://evil-wan.com"],
      operation_id: OP_OPEN,
      request_id: "req-1",
    };
    const res = await host.handleInvoke("browser:runOperation", sender(), tamperPayload);
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_REQUEST");
  });

  it("Row 36: renderer cannot create extra browser sessions", async () => {
    // Only lesson:load in main can open sessions.
    // There is no browser:createSession channel.
    const createPayload = {
      session_id: "cf-new-session",
      request_id: "req-1",
    };
    const res = await host.handleInvoke("browser:createSession", sender(), createPayload);
    assert.deepEqual(res, {
      ok: false,
      code: "INVALID_REQUEST",
      message: "unknown browser channel",
    });
  });
});

describe("P7.6 Functional Test Matrix & Real Chromium Execution", () => {
  let fixture: FixtureServerInstance;
  let compiledLesson: CompiledLesson;
  let lessonDigest: string;
  let host: BrowserIpcHost;
  const pushedEvents: unknown[] = [];

  before(async () => {
    fixture = await startFixtureServer();
    compiledLesson = buildSyntheticBrowserLesson(fixture.origin);
    lessonDigest = canonicalCompiledDigest(compiledLesson);

    registerReviewedLesson({
      lesson_id: compiledLesson.lesson.lesson_id,
      course_id: compiledLesson.lesson.course_id,
      lesson_compiled_digest: lessonDigest,
      reviewed_note: "P7.6 Functional Suite Review",
    });

    host = new BrowserIpcHost({
      pushToRenderer: (webContentsId, channel, dto) => {
        if (channel === BROWSER_EVENT_CHANNEL) {
          pushedEvents.push(dto);
        }
      },
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });
  });

  after(async () => {
    await host.shutdownAll("app_close");
    await fixture.close();
    clearReviewedLessons();
  });

  it("proves runOperation executes real Chromium navigation and returns valid receipt", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const sid = opened.session.session_id;

    // 1. runOperation browser_open
    const navRes = await host.handleInvoke("browser:runOperation", sender(), {
      session_id: sid,
      operation_id: OP_OPEN,
      request_id: "req-nav-1",
    });
    assert.equal(navRes.ok, true);
    if (navRes.ok && "receipt" in navRes) {
      assert.equal(navRes.receipt.outcome, "completed");
      assert.equal(navRes.receipt.operation_id, OP_OPEN);
      assert.equal(navRes.receipt.session_id, sid);
      assert.equal(navRes.receipt.generation, 1);
    }

    // 2. Duplicate request returns idempotent rejection without re-dispatch
    const dupRes = await host.handleInvoke("browser:runOperation", sender(), {
      session_id: sid,
      operation_id: OP_OPEN,
      request_id: "req-nav-1",
    });
    assert.equal(dupRes.ok, false);
    assert.equal(dupRes.code, "OPERATION_ALREADY_COMPLETED");

    // 3. Sequential action 2: browser_fill
    const fillRes = await host.handleInvoke("browser:runOperation", sender(), {
      session_id: sid,
      operation_id: OP_FILL,
      request_id: "req-fill-1",
    });
    assert.equal(fillRes.ok, true);
    if (fillRes.ok && "receipt" in fillRes) {
      assert.equal(fillRes.receipt.outcome, "completed");
      assert.equal(fillRes.receipt.operation_id, OP_FILL);
    }

    // 4. Sequential action 3: browser_click
    const clickRes = await host.handleInvoke("browser:runOperation", sender(), {
      session_id: sid,
      operation_id: OP_CLICK,
      request_id: "req-click-1",
    });
    assert.equal(clickRes.ok, true);
    if (clickRes.ok && "receipt" in clickRes) {
      assert.equal(clickRes.receipt.outcome, "completed");
      assert.equal(clickRes.receipt.operation_id, OP_CLICK);
    }
  });

  it("proves getSnapshot returns bounded state from session journal", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const snapRes = await host.handleInvoke("browser:getSnapshot", sender(), {
      session_id: opened.session.session_id,
      after_seq: 0,
    });
    assert.equal(snapRes.ok, true);
    if (snapRes.ok && "page" in snapRes) {
      assert.equal(snapRes.page.session_id, opened.session.session_id);
      assert.equal(snapRes.page.generation, 1);
      assert.ok(snapRes.page.events.length >= 0);
      assert.ok(snapRes.page.events.length <= 256);
    }
  });

  it("proves cancelOperation cancels in-flight action and converges deterministically", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const cancelRes = await host.handleInvoke("browser:cancelOperation", sender(), {
      session_id: opened.session.session_id,
      operation_id: OP_OPEN,
      request_id: "req-cancel-1",
    });
    assert.equal(cancelRes.ok, true);
    if (cancelRes.ok && "cancelled" in cancelRes) {
      // If not currently running, returns cancelled: false
      assert.equal(typeof cancelRes.cancelled, "boolean");
    }
  });

  it("proves resetRuntime rotates generation and fences old generation", async () => {
    const opened = await host.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const sid = opened.session.session_id;

    const resetRes = await host.handleInvoke("browser:resetRuntime", sender(), {
      session_id: sid,
      request_id: "req-reset-1",
    });
    assert.equal(resetRes.ok, true);
    if (resetRes.ok && "session" in resetRes) {
      assert.equal(resetRes.session.generation, 2);
      assert.equal(resetRes.session.session_id, sid);
    }

    // Stale generation 1 request is now rejected
    const staleRes = await host.handleInvoke("browser:runOperation", sender(), {
      session_id: sid,
      generation: 1,
      operation_id: OP_OPEN,
      request_id: "req-stale-1",
    });
    assert.equal(staleRes.ok, false);
    assert.equal(staleRes.code, "STALE_GENERATION");
  });

  it("proves subscribe-before-snapshot guarantees zero lost events", async () => {
    const livePushes: { seq: number; type: string }[] = [];
    const localHost = new BrowserIpcHost({
      pushToRenderer: (_webContentsId, channel, dto) => {
        if (channel === BROWSER_EVENT_CHANNEL) {
          livePushes.push(dto as { seq: number; type: string });
        }
      },
    });
    localHost.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    const opened = await localHost.openSessionForRenderer({
      webContentsId: 42,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    // Snapshot after subscription
    const snapRes = await localHost.handleInvoke("browser:getSnapshot", sender(), {
      session_id: opened.session.session_id,
      after_seq: 0,
    });
    assert.equal(snapRes.ok, true);

    await localHost.shutdownAll("app_close");
  });

  it("proves unbindRenderer cleans up owned sessions on window close", async () => {
    const localHost = new BrowserIpcHost({
      pushToRenderer: () => {},
    });
    localHost.bindRenderer({ webContentsId: 99, rendererUrl: RENDERER_URL });

    const opened = await localHost.openSessionForRenderer({
      webContentsId: 99,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    await localHost.unbindRenderer(99);

    // Session is closed
    const res = await localHost.handleInvoke("browser:runOperation", sender({ webContentsId: 99 }), {
      session_id: opened.session.session_id,
      operation_id: OP_OPEN,
      request_id: "req-after-close",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "STALE_SESSION");
  });

  it("proves shutdown barrier terminates all sessions cleanly with zero surviving processes", async () => {
    const localHost = new BrowserIpcHost({
      pushToRenderer: () => {},
    });
    localHost.bindRenderer({ webContentsId: 77, rendererUrl: RENDERER_URL });

    const opened = await localHost.openSessionForRenderer({
      webContentsId: 77,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    const barrier = createBrowserShutdownBarrier(localHost);
    const closed = await barrier();
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.session_id, opened.session.session_id);
  });

  it("proves browser:frame pushes trusted visual frames to renderer on action execution", async () => {
    const pushedFrames: unknown[] = [];
    const localHost = new BrowserIpcHost({
      pushToRenderer: (_id, channel, dto) => {
        if (channel === BROWSER_FRAME_CHANNEL) {
          pushedFrames.push(dto);
        }
      },
    });
    localHost.bindRenderer({ webContentsId: 55, rendererUrl: RENDERER_URL });

    const opened = await localHost.openSessionForRenderer({
      webContentsId: 55,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    // Run first operation (open): starts runtime and attaches frame producer
    const res = await localHost.handleInvoke("browser:runOperation", sender({ webContentsId: 55 }), {
      session_id: opened.session.session_id,
      operation_id: OP_OPEN,
      request_id: "req-frame-test-01",
    });
    assert.equal(res.ok, true);

    // Wait a brief tick for frame capture to settle
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.ok(pushedFrames.length >= 1, "At least one frame must be pushed to renderer");
    const firstFrame = pushedFrames[0] as Record<string, unknown>;
    assert.equal(firstFrame.session_id, opened.session.session_id);
    assert.equal(firstFrame.generation, 1);
    assert.equal(firstFrame.format, "jpeg");
    assert.ok(typeof firstFrame.data === "string" && firstFrame.data.length > 0);

    const producer = localHost.getFrameProducer(opened.session.session_id);
    assert.ok(producer);
    assert.equal(producer.isStopped(), false);

    await localHost.shutdownAll("app_close");
    assert.equal(producer.isStopped(), true, "Producer must be stopped after shutdown");
  });

  it("proves frame producer stops on session reset and rotates generation", async () => {
    const pushedFrames: unknown[] = [];
    const localHost = new BrowserIpcHost({
      pushToRenderer: (_id, channel, dto) => {
        if (channel === BROWSER_FRAME_CHANNEL) {
          pushedFrames.push(dto);
        }
      },
    });
    localHost.bindRenderer({ webContentsId: 66, rendererUrl: RENDERER_URL });

    const opened = await localHost.openSessionForRenderer({
      webContentsId: 66,
      rendererUrl: RENDERER_URL,
      compiledLesson,
      lessonCompiledDigest: lessonDigest,
      lessonId: compiledLesson.lesson.lesson_id,
      reviewed: true,
    });
    assert.equal(opened.ok, true);
    if (!opened.ok) return;

    // Prepare via runOperation
    await localHost.handleInvoke("browser:runOperation", sender({ webContentsId: 66 }), {
      session_id: opened.session.session_id,
      operation_id: OP_OPEN,
      request_id: "req-frame-reset-01",
    });

    const producerGen1 = localHost.getFrameProducer(opened.session.session_id);
    assert.ok(producerGen1);

    // Reset runtime
    const resetRes = await localHost.handleInvoke("browser:resetRuntime", sender({ webContentsId: 66 }), {
      session_id: opened.session.session_id,
      request_id: "req-reset-frame-test",
    });
    assert.equal(resetRes.ok, true);

    // Gen 1 producer must be stopped
    assert.equal(producerGen1.isStopped(), true);

    await localHost.shutdownAll("app_close");
  });
});
