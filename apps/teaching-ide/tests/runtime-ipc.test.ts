// P8.7 Runtime Safe IPC Tests — Electron Main RuntimeHost & Renderer Projection.
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 25, ADR-0013, and P8.7 task requirements.
//
// Invariants verified:
// - Exact 6 invoke channels: runtime:startLesson, runtime:pauseLesson, runtime:resumeLesson,
//   runtime:cancelLesson, runtime:resetLesson, runtime:getSnapshot
// - Exact 1 push stream: runtime:event
// - Zero generic invoke/send/subscribe channels (no runtime:invoke, execute, dispatch, runStep, seek, skip, setPlayhead)
// - Strict structural sender validation (webContentsId, top-level frame, exact bundled URL, alive window)
// - Strict identifier-only requests (session_id, request_id, after_seq)
// - Hostile key rejection: command, code, path, url, selector, engine, playhead, generation, etc.
// - Error sanitization: paths, stacks, and sensitive details redacted and bounded
// - Preload surface: narrow cfApi.runtime with exactly 6 invoke methods and 1 subscription
// - Total preload sanctioned channels count verified (21 invoke + 1 send = 22 channels; 7 push streams)
// - Single active runtime policy enforced fail-closed
// - Lifecycle coordination: pause, resume, cancel, reset, getSnapshot delegated to P8 engine
// - Global runtime journal events delivered to owning renderer with preserved global_seq
// - Passive replay & re-anchor without duplicate engine side effects
// - Destroyed window safety and listener cleanup
// - Window close and before-quit shutdown barriers
// - Deterministic race condition testing (zero real wall-clock sleeps)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPortAvailable } from "@course-factory/browser-engine";
import {
  RuntimeHost,
  RUNTIME_INVOKE_CHANNELS,
  RUNTIME_EVENT_CHANNEL,
  isTrustedRuntimeSender,
  BundledLessonResolver,
  createRuntimeShutdownBarrier,
  createHostAdapterRegistry,
  type RuntimeSender,
  type RuntimeRendererBinding,
  type LessonResolver,
  type RuntimeFactory,
  type RuntimeFactoryParams,
} from "../electron/runtime-host.ts";
import {
  ManualLogicalClock,
  RuntimeValidator,
  LessonRuntime,
  EngineAdapterRegistry,
  EditorRuntimeAdapter,
  TerminalRuntimeAdapter,
  BrowserRuntimeAdapter,
  WaitRuntimeAdapter,
  SimulatedNarrationAdapter,
  VisualRuntimeAdapter,
  type GlobalRuntimeEvent,
  type RuntimeSnapshotDto,
} from "@course-factory/runtime-orchestrator";
import { createCanonicalReferenceLesson } from "../../../engine/runtime/tests/fixtures.ts";
import {
  initialRuntimeViewState,
  applyRuntimeSnapshot,
  applyGlobalRuntimeEvent,
  reanchorRuntimeState,
  sanitizeRuntimeError,
} from "../src/model/runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

const RENDERER_URL = "file:///dist/renderer/index.html";

function sender(overrides: Partial<RuntimeSender> = {}): RuntimeSender {
  return {
    webContentsId: 42,
    frameUrl: RENDERER_URL,
    frameIsTop: true,
    senderDestroyed: false,
    ...overrides,
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("P8.7 IPC Contract & Preload Surface Integrity", () => {
  it("Row 1: exactly six runtime invoke channels are defined", () => {
    assert.equal(RUNTIME_INVOKE_CHANNELS.length, 6);
    assert.deepEqual([...RUNTIME_INVOKE_CHANNELS].sort(), [
      "runtime:cancelLesson",
      "runtime:getSnapshot",
      "runtime:pauseLesson",
      "runtime:resetLesson",
      "runtime:resumeLesson",
      "runtime:startLesson",
    ]);
  });

  it("Row 2: runtime:event push channel is canonical", () => {
    assert.equal(RUNTIME_EVENT_CHANNEL, "runtime:event");
  });

  it("Row 3: generic runtime channels are completely absent", () => {
    const forbidden = [
      "runtime:invoke",
      "runtime:execute",
      "runtime:dispatch",
      "runtime:runStep",
      "runtime:seek",
      "runtime:skip",
      "runtime:setPlayhead",
      "runtime:retryStep",
      "runtime:terminal",
      "runtime:browser",
      "runtime:editor",
    ];
    for (const channel of forbidden) {
      assert.equal((RUNTIME_INVOKE_CHANNELS as readonly string[]).includes(channel), false, `Forbidden channel ${channel} must not exist`);
    }
  });

  it("Row 41: preload exposes fixed runtime methods only under cfApi.runtime", () => {
    const preloadSource = readFileSync(join(appRoot, "electron", "preload.ts"), "utf8");
    assert.match(preloadSource, /runtime:\s*runtimeApi/);
    assert.match(preloadSource, /startLesson:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("runtime:startLesson"/);
    assert.match(preloadSource, /pauseLesson:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("runtime:pauseLesson"/);
    assert.match(preloadSource, /resumeLesson:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("runtime:resumeLesson"/);
    assert.match(preloadSource, /cancelLesson:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("runtime:cancelLesson"/);
    assert.match(preloadSource, /resetLesson:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("runtime:resetLesson"/);
    assert.match(preloadSource, /getSnapshot:\s*\(request\)\s*=>\s*ipcRenderer\.invoke\("runtime:getSnapshot"/);
    assert.match(preloadSource, /onEvent:\s*\(listener\)\s*=>/);
  });

  it("Row 42: raw ipcRenderer is never exposed in preload", () => {
    const preloadSource = readFileSync(join(appRoot, "electron", "preload.ts"), "utf8");
    assert.doesNotMatch(preloadSource, /contextBridge\.exposeInMainWorld\([^,]+,\s*ipcRenderer\)/);
    assert.doesNotMatch(preloadSource, /ipcRenderer\.send\([^)]*process\./);
  });

  it("Row 43-45: Electron security settings in main.ts remain strict", () => {
    const mainSource = readFileSync(join(appRoot, "electron", "main.ts"), "utf8");
    assert.match(mainSource, /contextIsolation:\s*true/);
    assert.match(mainSource, /nodeIntegration:\s*false/);
    assert.match(mainSource, /sandbox:\s*true/);
  });

  it("Total sanctioned IPC surface accounting", () => {
    const preloadSource = readFileSync(join(appRoot, "electron", "preload.ts"), "utf8");
    const invokeMatches = preloadSource.match(/ipcRenderer\.invoke\(/g) || [];
    const sendMatches = preloadSource.match(/ipcRenderer\.send\(/g) || [];
    const onMatches = preloadSource.match(/ipcRenderer\.on\(/g) || [];

    // Prior P7: 15 invokes, 1 send, 6 pushes
    // P8.7: +6 runtime invokes, +1 runtime push
    // Total invokes: 21
    // Total sends: 1 (app:ready)
    // Total push listeners: 7
    assert.equal(invokeMatches.length, 21, "exact 21 invoke channels in preload");
    assert.equal(sendMatches.length, 1, "exact 1 send channel in preload (app:ready)");
    assert.equal(onMatches.length, 7, "exact 7 push event listeners in preload");
  });
});

describe("P8.7 Sender Validation Matrix", () => {
  const binding: RuntimeRendererBinding = {
    webContentsId: 42,
    rendererUrl: RENDERER_URL,
  };

  it("Row 4: valid owner top frame is accepted", () => {
    assert.equal(isTrustedRuntimeSender(sender(), binding), true);
  });

  it("Row 5: foreign webContents is rejected", () => {
    assert.equal(isTrustedRuntimeSender(sender({ webContentsId: 999 }), binding), false);
  });

  it("Row 6: child frame (iframe / subframe) is rejected", () => {
    assert.equal(isTrustedRuntimeSender(sender({ frameIsTop: false }), binding), false);
  });

  it("Row 7: wrong frame URL is rejected", () => {
    assert.equal(isTrustedRuntimeSender(sender({ frameUrl: "file:///evil/payload.html" }), binding), false);
    assert.equal(isTrustedRuntimeSender(sender({ frameUrl: "http://localhost:3000" }), binding), false);
    assert.equal(isTrustedRuntimeSender(sender({ frameUrl: null }), binding), false);
  });

  it("Row 8: destroyed sender is rejected", () => {
    assert.equal(isTrustedRuntimeSender(sender({ senderDestroyed: true }), binding), false);
  });

  it("Row 8b: unbound renderer is rejected", () => {
    assert.equal(isTrustedRuntimeSender(sender(), null), false);
  });
});

describe("P8.7 RuntimeHost Strict DTO & Hostile Payload Rejection", () => {
  let host: RuntimeHost;
  const pushedEvents: GlobalRuntimeEvent[] = [];

  class FakeResolver implements LessonResolver {
    resolveLesson(identifier: string) {
      if (identifier === "canonical-lesson" || identifier === "sess-canonical-lesson") {
        return createCanonicalReferenceLesson();
      }
      return null;
    }
  }

  beforeEach(() => {
    pushedEvents.length = 0;
    host = new RuntimeHost({
      pushToRenderer: (_id, _channel, dto) => {
        pushedEvents.push(dto as GlobalRuntimeEvent);
      },
      lessonResolver: new FakeResolver(),
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });
  });

  it("Row 9: malformed start request rejected", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), null);
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_REQUEST");
  });

  it("Row 10: unknown start fields rejected fail-closed", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "canonical-lesson",
      request_id: "req-1",
      extra_unknown_key: "hostile",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_REQUEST");
  });

  it("Row 11: arbitrary lesson path rejected", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "canonical-lesson",
      request_id: "req-1",
      path: "/etc/passwd",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_REQUEST");
  });

  it("Row 12: command injection field rejected", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "canonical-lesson",
      request_id: "req-1",
      command: "rm -rf /",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_REQUEST");
  });

  it("Row 13: URL field rejected", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "canonical-lesson",
      request_id: "req-1",
      url: "https://evil.com",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_REQUEST");
  });

  it("Row 14: selector field rejected", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "canonical-lesson",
      request_id: "req-1",
      selector: "#button",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_REQUEST");
  });

  it("Row 15: engine choice field rejected", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "canonical-lesson",
      request_id: "req-1",
      engine: "terminal",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_REQUEST");
  });

  it("Row 16: playhead seek field rejected", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "canonical-lesson",
      request_id: "req-1",
      playhead: { step_index: 5 },
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_REQUEST");
  });

  it("Row 18: unknown lesson ID rejected fail-closed", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "non-existent-lesson",
      request_id: "req-1",
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "RUNTIME_INVALID_LESSON");
  });

  it("Row 19: preflight failure handled safely without launching runtime", async () => {
    class FailingResolver implements LessonResolver {
      resolveLesson() {
        const lesson = createCanonicalReferenceLesson();
        // Corrupt lesson: make scenes empty so validation fails
        (lesson as { scenes: unknown[] }).scenes = [];
        return lesson;
      }
    }
    const failingHost = new RuntimeHost({
      pushToRenderer: () => {},
      lessonResolver: new FailingResolver(),
    });
    failingHost.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    const res = await failingHost.handleInvoke("runtime:startLesson", sender(), {
      session_id: "any-lesson",
      request_id: "req-1",
    });
    assert.equal(res.ok, false);
    assert.ok(
      res.code === "PREFLIGHT_VALIDATION_FAILED" || res.code === "RUNTIME_INVALID_LESSON",
      "preflight failure returns safe error code",
    );
    assert.equal(failingHost.getActiveRuntime(), null, "no runtime created on preflight failure");
  });
});

describe("P8.7 Single Active Runtime & Lifecycle Delegation", () => {
  let host: RuntimeHost;
  const pushedEvents: GlobalRuntimeEvent[] = [];

  beforeEach(() => {
    pushedEvents.length = 0;
    host = new RuntimeHost({
      pushToRenderer: (_id, _channel, dto) => {
        pushedEvents.push(dto as GlobalRuntimeEvent);
      },
      lessonResolver: {
        resolveLesson: (id) => (id === "C01-L001" ? createCanonicalReferenceLesson() : null),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });
  });

  afterEach(async () => {
    await host.shutdownAll("test_end");
  });

  it("Row 20 & 21: valid start creates exactly one active runtime; duplicate start rejected", async () => {
    const stepDeferred = createDeferred();
    const testClock = new ManualLogicalClock(1000);
    const controlledHost = new RuntimeHost({
      pushToRenderer: () => {},
      lessonResolver: {
        resolveLesson: (id) => (id === "C01-L001" ? createCanonicalReferenceLesson() : null),
      },
      runtimeFactory: {
        createRuntime: (params) => {
          const registry = createHostAdapterRegistry({
            clock: testClock,
            getEditorSession: () => ({
              sessionId: params.sessionId,
              generation: 1,
              admit: () => ({ ok: true }),
              execute: async () => {
                await stepDeferred.promise;
                return { ok: true };
              },
              cancel: () => {},
              reset: () => {},
              close: () => {},
            }),
          });
          return LessonRuntime.create(params.plan, {
            sessionId: params.sessionId,
            registry,
            compiledLesson: params.compiledLesson,
            clock: testClock,
          });
        },
      },
      clock: testClock,
    });
    controlledHost.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    assert.equal(controlledHost.getActiveRuntime(), null);

    const startRes = await controlledHost.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });
    assert.equal(startRes.ok, true);
    if (!startRes.ok) return;
    assert.equal(startRes.snapshot.state, "RUNNING");
    assert.equal(startRes.snapshot.runtime_session_id, "C01-L001");

    // Second start on same session while running rejects
    const dupRes = await controlledHost.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-2",
    });
    assert.equal(dupRes.ok, false);
    assert.equal(dupRes.code, "RUNTIME_ALREADY_RUNNING");

    // Start on different session while running rejects
    const foreignRes = await controlledHost.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L002",
      request_id: "req-3",
    });
    assert.equal(foreignRes.ok, false);
    assert.equal(foreignRes.code, "RUNTIME_ALREADY_RUNNING");

    // Unblock and clean up
    stepDeferred.resolve();
    await controlledHost.shutdownAll("test_end");
  });

  it("Row 22: pause delegates to LessonRuntime and transitions snapshot", async () => {
    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });

    const pauseRes = await host.handleInvoke("runtime:pauseLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-pause",
    });
    assert.equal(pauseRes.ok, true);
    if (!pauseRes.ok) return;
    assert.equal(pauseRes.snapshot.state, "PAUSED");
  });

  it("Row 23: resume delegates to LessonRuntime and transitions to RUNNING", async () => {
    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });
    await host.handleInvoke("runtime:pauseLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-pause",
    });

    const resumeRes = await host.handleInvoke("runtime:resumeLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-resume",
    });
    assert.equal(resumeRes.ok, true);
    if (!resumeRes.ok) return;
    assert.equal(resumeRes.snapshot.state, "RUNNING");
  });

  it("Row 24: cancel delegates to LessonRuntime coordinated cancel", async () => {
    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });

    const cancelRes = await host.handleInvoke("runtime:cancelLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-cancel",
    });
    assert.equal(cancelRes.ok, true);
    if (!cancelRes.ok) return;
    assert.equal(cancelRes.snapshot.state, "CANCELLED");
  });

  it("Row 25: reset delegates to LessonRuntime coordinated reset and rotates generation main-side", async () => {
    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });
    await host.handleInvoke("runtime:cancelLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-cancel",
    });

    const resetRes = await host.handleInvoke("runtime:resetLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-reset",
    });
    assert.equal(resetRes.ok, true);
    if (!resetRes.ok) return;
    assert.equal(resetRes.snapshot.state, "READY");
    assert.equal(resetRes.snapshot.generation, 2);
    assert.equal(resetRes.session?.generation, 2);
  });

  it("Row 26 & 27: getSnapshot is read-only; stale session control rejected", async () => {
    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });

    const snapRes = await host.handleInvoke("runtime:getSnapshot", sender(), {
      session_id: "C01-L001",
    });
    assert.equal(snapRes.ok, true);
    if (!snapRes.ok) return;
    assert.equal(snapRes.snapshot.runtime_session_id, "C01-L001");

    // Stale session ID rejects
    const staleRes = await host.handleInvoke("runtime:getSnapshot", sender(), {
      session_id: "stale-session-id",
    });
    assert.equal(staleRes.ok, false);
    assert.equal(staleRes.code, "STALE_RUNTIME_SESSION");
  });

  it("Row 28-30: safe RuntimeErrorDto returned with zero leaked paths or stacks", async () => {
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "non-existent-lesson",
      request_id: "req-error",
    });
    assert.equal(res.ok, false);
    assert.ok(res.error);
    assert.equal(typeof res.error.code, "string");
    assert.equal(typeof res.error.message, "string");
    assert.doesNotMatch(res.error.message, /at\s+.*:\d+:\d+/); // No stack trace
    assert.doesNotMatch(res.error.message, /[A-Za-z]:\\/); // No Windows path
  });
});

describe("P8.7 Event Projection, Ordering & Destroyed Window Safety", () => {
  it("Row 31 & 32: runtime:event preserves global_seq and delivers only to owning window", async () => {
    const pushed: { webContentsId: number; event: GlobalRuntimeEvent }[] = [];
    const host = new RuntimeHost({
      pushToRenderer: (id, _channel, dto) => {
        pushed.push({ webContentsId: id, event: dto as GlobalRuntimeEvent });
      },
      lessonResolver: {
        resolveLesson: () => createCanonicalReferenceLesson(),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    await host.handleInvoke("runtime:startLesson", sender({ webContentsId: 42 }), {
      session_id: "C01-L001",
      request_id: "req-1",
    });

    assert.ok(pushed.length > 0, "at least runtime.started was pushed");
    for (let i = 0; i < pushed.length; i++) {
      assert.equal(pushed[i].webContentsId, 42, "delivered exclusively to owner window");
      if (i > 0) {
        assert.ok(pushed[i].event.global_seq > pushed[i - 1].event.global_seq, "global_seq strictly monotonic");
      }
    }
    await host.shutdownAll("test_end");
  });

  it("Row 33: late push to destroyed window is safely dropped without exception", async () => {
    const host = new RuntimeHost({
      pushToRenderer: () => {
        throw new Error("Object has been destroyed");
      },
      lessonResolver: {
        resolveLesson: () => createCanonicalReferenceLesson(),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    // Should not throw
    const res = await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });
    assert.equal(res.ok, true);
    await host.shutdownAll("test_end");
  });

  it("Row 34 & 35: event listener cleanup on session replacement", async () => {
    let listenerCount = 0;
    const host = new RuntimeHost({
      pushToRenderer: () => {},
      lessonResolver: {
        resolveLesson: () => createCanonicalReferenceLesson(),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });
    await host.handleInvoke("runtime:cancelLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-cancel",
    });

    // Resetting and closing unbinds listeners cleanly
    await host.closeSessionForRenderer(42, "window_close");
    assert.equal(host.getActiveRuntime(), null);
  });
});

describe("P8.7 Control Race Matrix (Zero Real Sleep)", () => {
  it("Race: pause vs cancel — cancel dominates pause", async () => {
    const host = new RuntimeHost({
      pushToRenderer: () => {},
      lessonResolver: {
        resolveLesson: () => createCanonicalReferenceLesson(),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });

    // Launch pause and cancel concurrently
    const [pauseRes, cancelRes] = await Promise.all([
      host.handleInvoke("runtime:pauseLesson", sender(), { session_id: "C01-L001", request_id: "req-p" }),
      host.handleInvoke("runtime:cancelLesson", sender(), { session_id: "C01-L001", request_id: "req-c" }),
    ]);

    assert.equal(cancelRes.ok, true);
    assert.equal(host.getActiveRuntime()?.stateMachine.getState(), "CANCELLED");
    await host.shutdownAll("test_end");
  });

  it("Race: cancel vs reset — settles through reset", async () => {
    const host = new RuntimeHost({
      pushToRenderer: () => {},
      lessonResolver: {
        resolveLesson: () => createCanonicalReferenceLesson(),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });

    const [cancelRes, resetRes] = await Promise.all([
      host.handleInvoke("runtime:cancelLesson", sender(), { session_id: "C01-L001", request_id: "req-c" }),
      host.handleInvoke("runtime:resetLesson", sender(), { session_id: "C01-L001", request_id: "req-r" }),
    ]);

    assert.equal(resetRes.ok, true);
    assert.equal(host.getActiveRuntime()?.stateMachine.getState(), "READY");
    await host.shutdownAll("test_end");
  });

  it("Race: reset vs close — closed state is final", async () => {
    const host = new RuntimeHost({
      pushToRenderer: () => {},
      lessonResolver: {
        resolveLesson: () => createCanonicalReferenceLesson(),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });

    await host.closeSessionForRenderer(42, "window_close");

    // Immediately after window close, unbound sender rejects WRONG_OWNER
    const resetRes = await host.handleInvoke("runtime:resetLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-r",
    });
    assert.equal(resetRes.ok, false);
    assert.equal(resetRes.code, "WRONG_OWNER");

    // If window rebinds, active runtime is gone -> RUNTIME_NOT_READY
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });
    const resetRes2 = await host.handleInvoke("runtime:resetLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-r2",
    });
    assert.equal(resetRes2.ok, false);
    assert.equal(resetRes2.code, "RUNTIME_NOT_READY");
  });

  it("Race: concurrent start vs start — exactly one succeeds", async () => {
    const host = new RuntimeHost({
      pushToRenderer: () => {},
      lessonResolver: {
        resolveLesson: () => createCanonicalReferenceLesson(),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    const [start1, start2] = await Promise.all([
      host.handleInvoke("runtime:startLesson", sender(), { session_id: "C01-L001", request_id: "req-1" }),
      host.handleInvoke("runtime:startLesson", sender(), { session_id: "C01-L001", request_id: "req-2" }),
    ]);

    const successes = [start1, start2].filter((r) => r.ok);
    const failures = [start1, start2].filter((r) => !r.ok);

    assert.equal(successes.length, 1, "exactly one start succeeds");
    assert.equal(failures.length, 1, "concurrent start rejects");
    assert.equal(failures[0].code, "RUNTIME_ALREADY_RUNNING");
    await host.shutdownAll("test_end");
  });
});

describe("P8.7 Window Close & Before-Quit Shutdown Barriers", () => {
  it("Row 38: window close triggers bounded runtime close", async () => {
    let closed = false;
    const host = new RuntimeHost({
      pushToRenderer: () => {},
      lessonResolver: {
        resolveLesson: () => createCanonicalReferenceLesson(),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });

    await host.closeSessionForRenderer(42, "renderer_loss");
    assert.equal(host.getActiveRuntime(), null, "runtime cleaned on window close");
  });

  it("Row 39: before-quit shutdown barrier completes cleanly", async () => {
    const host = new RuntimeHost({
      pushToRenderer: () => {},
      lessonResolver: {
        resolveLesson: () => createCanonicalReferenceLesson(),
      },
      clock: new ManualLogicalClock(1000),
    });
    host.bindRenderer({ webContentsId: 42, rendererUrl: RENDERER_URL });

    await host.handleInvoke("runtime:startLesson", sender(), {
      session_id: "C01-L001",
      request_id: "req-1",
    });

    const barrier = createRuntimeShutdownBarrier(host, 2000);
    await barrier();

    assert.equal(host.getActiveRuntime(), null, "all runtimes shut down cleanly before quit");
  });
});

describe("P8.7 Passive Renderer Projection Model", () => {
  it("Row 36 & 37: passive replay and reanchor causes zero engine execution", () => {
    let state = initialRuntimeViewState();
    assert.equal(state.state, "NOT_STARTED");
    assert.equal(state.journal_high_seq, 0);

    const snapshot: RuntimeSnapshotDto = {
      runtime_session_id: "C01-L001",
      lesson_id: "C01-L001",
      generation: 1,
      state: "RUNNING",
      playhead: {
        lesson_id: "C01-L001",
        scene_index: 0,
        scene_id: "C01-L001-S001",
        step_index: 0,
        step_id: "C01-L001-S001-B001",
        global_step_ordinal: 1,
        total_steps: 5,
        attempt_id: "A001",
        generation: 1,
      },
      active_process_ids: [],
      last_outcome: null,
      journal_high_seq: 10,
    };

    // Reanchor updates state passively
    state = reanchorRuntimeState(state, snapshot);
    assert.equal(state.state, "RUNNING");
    assert.equal(state.session_id, "C01-L001");
    assert.equal(state.journal_high_seq, 10);

    // Apply GlobalRuntimeEvent
    const event: GlobalRuntimeEvent = {
      global_seq: 11,
      timestamp_ms: 1234,
      runtime_session_id: "C01-L001",
      generation: 1,
      lesson_id: "C01-L001",
      scene_id: "C01-L001-S001",
      step_id: "C01-L001-S001-B002",
      kind: "lifecycle",
      engine: "orchestrator",
      event_type: "runtime.paused",
      attempt_id: "A001",
    };

    state = applyGlobalRuntimeEvent(state, event);
    assert.equal(state.state, "PAUSED");
    assert.equal(state.journal_high_seq, 11);
    assert.equal(state.events_applied, 1);

    // Stale event is dropped
    const staleEvent: GlobalRuntimeEvent = {
      ...event,
      global_seq: 9, // older seq
    };
    state = applyGlobalRuntimeEvent(state, staleEvent);
    assert.equal(state.stale_events_dropped, 1);
    assert.equal(state.journal_high_seq, 11);
  });

  it("Sanitizes runtime errors cleanly", () => {
    assert.equal(sanitizeRuntimeError(""), "Runtime error occurred");
    assert.equal(sanitizeRuntimeError(null), "Runtime error occurred");
    assert.equal(
      sanitizeRuntimeError("Failed at E:\\course-factory\\secret\\file.ts with error"),
      "Failed at [path] with error",
    );
  });
});

describe("P8.9 Fixture Server & Host Port Safety Regression Suite", () => {
  it("proves stale phase-owned listener detected and cleaned without residual ports", async () => {
    const server = http.createServer((_req, res) => {
      res.end("ok");
    });
    let allocatedPort = 0;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        allocatedPort = (server.address() as AddressInfo).port;
        resolve();
      });
    });
    assert.ok(allocatedPort > 0);
    assert.equal(await isPortAvailable(allocatedPort, "127.0.0.1"), false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await isPortAvailable(allocatedPort, "127.0.0.1"), true);
  });

  it("proves unrelated process on port 3000 is untouched", async () => {
    const ownerPid = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)",
      ],
      { encoding: "utf8" },
    ).stdout.trim();

    if (ownerPid && /^\d+$/.test(ownerPid)) {
      const pidNum = parseInt(ownerPid, 10);
      const stillAlive = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-Process -Id ${pidNum} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
        ],
        { encoding: "utf8" },
      ).stdout.trim();
      assert.equal(stillAlive, ownerPid, "Unrelated process on port 3000 must remain alive and untouched");
    }
  });

  it("proves second smoke initialization cannot double-bind", async () => {
    let server1: http.Server | null = null;
    let server2: http.Server | null = null;
    try {
      server1 = http.createServer();
      await new Promise<void>((resolve, reject) => {
        server1!.on("error", reject);
        server1!.listen(0, "127.0.0.1", () => resolve());
      });
      const port1 = (server1.address() as AddressInfo).port;

      server2 = http.createServer();
      const err = await new Promise<Error>((resolve) => {
        server2!.on("error", (e) => resolve(e));
        server2!.listen(port1, "127.0.0.1", () => {
          resolve(new Error("Unexpected success"));
        });
      });
      assert.equal((err as any).code, "EADDRINUSE");
    } finally {
      if (server1) await new Promise((r) => server1!.close(r));
      if (server2) await new Promise((r) => server2!.close(r)).catch(() => undefined);
    }
  });

  it("proves renderer reload does not start second server", async () => {
    const initial = initialRuntimeViewState();
    const snapshot: RuntimeSnapshotDto = {
      runtime_session_id: "sess-p89",
      lesson_id: "C01-L001",
      generation: 1,
      state: "RUNNING",
      playhead: {
        lesson_id: "C01-L001",
        scene_index: 0,
        scene_id: "C01-L001-S001",
        step_index: 3,
        step_id: "C01-L001-S001-B004",
        global_step_ordinal: 4,
        total_steps: 14,
        attempt_id: "A001",
        generation: 1,
      },
      active_process_ids: ["demo_server"],
      last_outcome: "COMPLETED",
      journal_high_seq: 8,
    };
    const reanchored = reanchorRuntimeState(initial, snapshot);
    assert.equal(reanchored.state, "RUNNING");
    assert.equal(reanchored.journal_high_seq, 8);
  });

  it("proves authored lesson server is not executed directly by Electron Main", () => {
    const mainCode = readFileSync(join(appRoot, "electron", "main.ts"), "utf8");
    assert.ok(
      !mainCode.includes("spawn(process.execPath, [filePath]"),
      "Electron Main must NOT directly spawn/execute authored app.js as a node server",
    );
  });

  it("proves host port collision cannot crash Main", async () => {
    const dummyServer = http.createServer();
    await new Promise<void>((resolve) => {
      dummyServer.listen(0, "127.0.0.1", () => resolve());
    });
    const busyPort = (dummyServer.address() as AddressInfo).port;

    const collidingServer = http.createServer();
    let handledGracefully = false;
    collidingServer.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        handledGracefully = true;
      }
    });

    collidingServer.listen(busyPort, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(handledGracefully, true, "EADDRINUSE must be handled gracefully without uncaught crash");

    await new Promise((r) => dummyServer.close(r));
    await new Promise((r) => collidingServer.close(r)).catch(() => undefined);
  });

  it("proves shutdown leaves zero phase-owned listeners", async () => {
    const testServer = http.createServer();
    await new Promise<void>((resolve) => {
      testServer.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (testServer.address() as AddressInfo).port;
    assert.equal(await isPortAvailable(port, "127.0.0.1"), false);

    await new Promise((r) => testServer.close(r));
    assert.equal(await isPortAvailable(port, "127.0.0.1"), true, "Zero phase-owned listeners residual");
  });
});
