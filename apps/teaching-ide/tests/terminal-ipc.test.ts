// P5.11 Safe IPC IDE tests — deterministic, no Electron launch, no Docker.
// Proves sender validation, the exact five-channel surface, owner binding and
// serialized switches, the reviewed-catalog authorization gate, preload/bridge
// shape, main-process sandbox/shutdown invariants and response privacy —
// using the REAL engine TerminalHost with a fake provider and temp roots.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalHost } from "@course-factory/terminal-engine/terminal-host";
import type {
  AdmittedSession,
  CleanupResult,
  Disposable,
  ExecutionProvider,
  ProviderEvent,
  ProviderSession,
  StartReceipt,
  StopResult,
} from "@course-factory/terminal-engine";
import type { ExecutionGrant } from "@course-factory/terminal-engine";
import type { CloseCause } from "@course-factory/terminal-engine";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import {
  TerminalIpcHost,
  TERMINAL_INVOKE_CHANNELS,
  TERMINAL_EVENT_CHANNEL,
  isTrustedTerminalSender,
  type TerminalSender,
} from "../electron/terminal-host.ts";
import {
  registerReviewedLesson,
  isExecutionAuthorized,
  unregisterReviewedLesson,
  clearReviewedLessons,
} from "../electron/execution-catalog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_DIGEST = PINNED_BASE.split("@")[1]!;

// -- fake provider (never executes; records calls) -----------------------------

class FakeProvider implements ExecutionProvider {
  startCalls = 0;
  stopCalls = 0;
  private nextSession = 0;
  private sessions = new Map<ProviderSession, { session_id: string; generation: number }>();
  private grants: ExecutionGrant[] = [];
  private listeners = new Set<(event: ProviderEvent) => void>();

  async prepare(input: AdmittedSession): Promise<ProviderSession> {
    this.nextSession += 1;
    const session = { id: this.nextSession } as unknown as ProviderSession;
    this.sessions.set(session, { session_id: input.session_id, generation: input.generation });
    for (const grant of input.grants ?? []) this.grants.push(grant);
    return session;
  }

  async start(session: ProviderSession, operationId: string, attemptId: string): Promise<StartReceipt> {
    this.startCalls += 1;
    const info = this.sessions.get(session);
    const grant = this.grants.find((g) => g.operation_id === operationId);
    return {
      session_id: info?.session_id ?? "sess-unknown",
      generation: info?.generation ?? 1,
      operation_id: operationId,
      attempt_id: attemptId,
      process_id: grant?.process_id ?? null,
    };
  }

  async stop(session: ProviderSession, processId: string, _cause: string): Promise<StopResult> {
    void _cause;
    this.stopCalls += 1;
    const info = this.sessions.get(session);
    return { session_id: info?.session_id ?? "s", generation: info?.generation ?? 1, process_id: processId, outcome: "stopped", forced: false };
  }

  async cancel(session: ProviderSession, _operationId: string): Promise<StopResult> {
    void _operationId;
    const info = this.sessions.get(session);
    return { session_id: info?.session_id ?? "s", generation: info?.generation ?? 1, process_id: null, outcome: "stopped", forced: false };
  }

  events(_session: ProviderSession, listener: (event: ProviderEvent) => void): Disposable {
    void _session;
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  async close(session: ProviderSession, cause: CloseCause): Promise<CleanupResult> {
    const info = this.sessions.get(session);
    this.sessions.delete(session);
    return { session_id: info?.session_id ?? "s", generation: info?.generation ?? 1, cleanup_status: "confirmed", cause };
  }

  registerAdmittedGrants(_session: ProviderSession, grants: readonly ExecutionGrant[]): void {
    void _session;
    for (const grant of grants) {
      if (!this.grants.some((g) => g.operation_id === grant.operation_id)) this.grants.push(grant);
    }
  }
}

// -- harness --------------------------------------------------------------------

const roots: string[] = [];

function makeIpcHost() {
  const root = mkdtempSync(join(tmpdir(), "cf-p511-ipc-"));
  roots.push(root);
  const fake = new FakeProvider();
  const engineHost = new TerminalHost({
    workspaceRoot: root,
    imageIdentity: {
      pinned_reference: PINNED_BASE,
      digest: PINNED_DIGEST,
      platform: "linux/amd64",
      pull_policy: "never",
      source: "base-image.lock.json",
    },
    createProvider: () => fake,
    hostEnv: {},
    forwardEnvNames: [],
  });
  const pushed: Array<{ webContentsId: number; channel: string; dto: unknown }> = [];
  const ipcHost = new TerminalIpcHost({
    host: engineHost,
    pushToRenderer: (webContentsId, channel, dto) => pushed.push({ webContentsId, channel, dto }),
  });
  return { engineHost, fake, pushed, ipcHost, root };
}

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: never) => CompiledLesson;
};
const { parseLessonData } = await import("@course-factory/shared-types/validate");

function syntheticLesson(lessonId: string): CompiledLesson {
  const raw = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: "P5.11 IPC synthetic lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 60,
    learning_objectives: ["IPC wiring"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p511", "ipc"],
    metadata: { synthetic_fixture: true, phase: "P5.11" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        type: "code_demo",
        title: "IPC",
        duration: 60,
        visual: { kind: "terminal", description: "synthetic" },
        beats: [
          {
            beat_id: `${lessonId}-S001-B001`,
            kind: "action",
            action: { type: "terminal_run", command: "echo ipc-proof", mode: "foreground", timeout_seconds: 30, expected_exit_code: 0 },
          },
        ],
      },
    ],
  };
  const parsed = parseLessonData(raw);
  if (!parsed.ok || parsed.lesson === undefined) throw new Error(`synthetic lesson invalid: ${JSON.stringify(parsed.issues)}`);
  return compileModule.compileLesson(parsed.lesson as never);
}

function sender(overrides: Partial<TerminalSender> = {}): TerminalSender {
  return {
    webContentsId: 11,
    frameUrl: "file:///renderer/index.html",
    frameIsTop: true,
    senderDestroyed: false,
    ...overrides,
  };
}

after(() => {
  clearReviewedLessons();
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// -- tests ----------------------------------------------------------------------

describe("P5.11 IPC: sender validation denies forgery", () => {
  it("trusted top-level exact-URL owner passes; everything else fails", () => {
    const binding = { webContentsId: 11, rendererUrl: "file:///renderer/index.html" };
    assert.equal(isTrustedTerminalSender(sender(), binding), true);
    assert.equal(isTrustedTerminalSender(sender({ webContentsId: 12 }), binding), false, "other window");
    assert.equal(isTrustedTerminalSender(sender({ frameIsTop: false }), binding), false, "iframe/guest frame");
    assert.equal(isTrustedTerminalSender(sender({ frameUrl: "file:///renderer/other.html" }), binding), false, "navigation");
    assert.equal(isTrustedTerminalSender(sender({ frameUrl: null }), binding), false, "missing frame");
    assert.equal(isTrustedTerminalSender(sender({ senderDestroyed: true }), binding), false, "destroyed sender");
    assert.equal(isTrustedTerminalSender(sender(), null), false, "unbound renderer");
  });
});

describe("P5.11 IPC: exact five-channel surface, no generic execution channel", () => {
  it("the invoke surface is exactly the five design channels", () => {
    assert.deepEqual([...TERMINAL_INVOKE_CHANNELS].sort(), [
      "terminal:cancelOperation",
      "terminal:getSnapshot",
      "terminal:resetRuntime",
      "terminal:runOperation",
      "terminal:stopProcess",
    ]);
    assert.equal(TERMINAL_EVENT_CHANNEL, "terminal:event");
    for (const banned of ["terminal:execute", "terminal:exec", "terminal:spawn", "terminal:shell", "terminal:stdin", "terminal:resize", "terminal:docker", "terminal:env", "terminal:mount"]) {
      assert.equal((TERMINAL_INVOKE_CHANNELS as readonly string[]).includes(banned), false, `no ${banned} channel may exist`);
    }
  });
});

describe("P5.11 IPC: owner binding, serialized switches and identifier-only dispatch", () => {
  it("openSessionForRenderer binds the owner; only the owner can invoke", async () => {
    const { ipcHost } = makeIpcHost();
    const lessonId = "C01-L901";
    const ir = syntheticLesson(lessonId);
    clearReviewedLessons();
    registerReviewedLesson({ lesson_id: lessonId, course_id: "C01", lesson_compiled_digest: "digest-ipc-1", reviewed_note: "test review" });
    ipcHost.bindRenderer({ webContentsId: 21, rendererUrl: "file:///renderer/index.html" });
    ipcHost.bindRenderer({ webContentsId: 22, rendererUrl: "file:///renderer/index.html" });
    const opened = await ipcHost.openSessionForRenderer({
      webContentsId: 21,
      rendererUrl: "file:///renderer/index.html",
      compiledLesson: ir,
      lessonCompiledDigest: "digest-ipc-1",
      lessonId,
    });
    assert.equal(opened.ok, true);
    const sessionId = (opened as { ok: true; session: { session_id: string } }).session.session_id;
    // The descriptor carries identifiers and the digest only — no private IDs/paths.
    const serialized = JSON.stringify((opened as { ok: true; session: unknown }).session);
    assert.doesNotMatch(serialized, /containerId|host_root|workspaceRoot|[A-Za-z]:\\/);
    // Owner invokes over the exact top-level URL.
    const run = await ipcHost.handleInvoke("terminal:runOperation", sender({ webContentsId: 21 }), {
      session_id: sessionId,
      operation_id: `${lessonId}-S001-B001`,
      request_id: "req-ipc-1",
    });
    assert.equal(run.ok, true);
    // Another window is not the owner.
    const foreign = await ipcHost.handleInvoke("terminal:runOperation", sender({ webContentsId: 22 }), {
      session_id: sessionId,
      operation_id: `${lessonId}-S001-B001`,
      request_id: "req-ipc-2",
    });
    assert.equal(foreign.ok, false);
    assert.equal((foreign as { ok: false; code: string }).code, "WRONG_OWNER");
    // Navigated URL is denied even for the owner id.
    const navigated = await ipcHost.handleInvoke(
      "terminal:getSnapshot",
      sender({ webContentsId: 21, frameUrl: "file:///evil/index.html" }),
      { session_id: sessionId, after_seq: 0 },
    );
    assert.equal((navigated as { ok: false; code: string }).code, "WRONG_OWNER");
    // Unknown channels never reach the engine.
    const unknown = await ipcHost.handleInvoke("terminal:execute", sender({ webContentsId: 21 }), { session_id: sessionId });
    assert.equal((unknown as { ok: false; code: string }).code, "INVALID_REQUEST");
    // Hostile command fields are rejected identifier-side.
    const hostile = await ipcHost.handleInvoke("terminal:runOperation", sender({ webContentsId: 21 }), {
      session_id: sessionId,
      operation_id: `${lessonId}-S001-B001`,
      request_id: "req-ipc-hostile",
      command: "rm -rf /",
    });
    assert.equal((hostile as { ok: false; code: string }).code, "INVALID_REQUEST");
    await ipcHost.closeSessionForRenderer(21, "lesson_end");
  });

  it("lesson switches serialize: the previous session is revoked before the new one opens", async () => {
    const { ipcHost } = makeIpcHost();
    ipcHost.bindRenderer({ webContentsId: 31, rendererUrl: "file:///renderer/index.html" });
    const firstIr = syntheticLesson("C01-L902");
    const first = await ipcHost.openSessionForRenderer({
      webContentsId: 31,
      rendererUrl: "file:///renderer/index.html",
      compiledLesson: firstIr,
      lessonCompiledDigest: "digest-a",
      lessonId: "C01-L902",
    });
    assert.equal(first.ok, true);
    const firstId = (first as { ok: true; session: { session_id: string } }).session.session_id;
    const secondIr = syntheticLesson("C01-L903");
    const second = await ipcHost.openSessionForRenderer({
      webContentsId: 31,
      rendererUrl: "file:///renderer/index.html",
      compiledLesson: secondIr,
      lessonCompiledDigest: "digest-b",
      lessonId: "C01-L903",
    });
    assert.equal(second.ok, true);
    // The previous session is revoked and cleaned: it answers STALE_SESSION.
    const stale = await ipcHost.handleInvoke("terminal:getSnapshot", sender({ webContentsId: 31 }), {
      session_id: firstId,
      after_seq: 0,
    });
    assert.equal((stale as { ok: false; code: string }).code, "STALE_SESSION");
    await ipcHost.closeSessionForRenderer(31, "lesson_end");
  });

  it("reset keeps the same owner; close revokes; shutdown closes all", async () => {
    const { ipcHost } = makeIpcHost();
    ipcHost.bindRenderer({ webContentsId: 41, rendererUrl: "file:///renderer/index.html" });
    clearReviewedLessons();
    registerReviewedLesson({ lesson_id: "C01-L904", course_id: "C01", lesson_compiled_digest: "digest-c", reviewed_note: "test review" });
    const ir = syntheticLesson("C01-L904");
    const opened = await ipcHost.openSessionForRenderer({
      webContentsId: 41,
      rendererUrl: "file:///renderer/index.html",
      compiledLesson: ir,
      lessonCompiledDigest: "digest-c",
      lessonId: "C01-L904",
    });
    const sessionId = (opened as { ok: true; session: { session_id: string } }).session.session_id;
    const reset = await ipcHost.handleInvoke("terminal:resetRuntime", sender({ webContentsId: 41 }), {
      session_id: sessionId,
      request_id: "req-ipc-reset",
    });
    assert.equal(reset.ok, true);
    const afterReset = await ipcHost.handleInvoke("terminal:getSnapshot", sender({ webContentsId: 41 }), {
      session_id: sessionId,
      after_seq: 0,
    });
    assert.equal(afterReset.ok, true);
    await ipcHost.closeSessionForRenderer(41, "lesson_end");
    const afterClose = await ipcHost.handleInvoke("terminal:getSnapshot", sender({ webContentsId: 41 }), {
      session_id: sessionId,
      after_seq: 0,
    });
    // Closed sessions keep bounded replay (journal retained) — revoked for runs.
    assert.equal(afterClose.ok, true);
    const rerun = await ipcHost.handleInvoke("terminal:runOperation", sender({ webContentsId: 41 }), {
      session_id: sessionId,
      operation_id: "C01-L904-S001-B001",
      request_id: "req-ipc-rerun",
    });
    assert.equal((rerun as { ok: false; code: string }).code, "STALE_SESSION");
    const shutdown = await ipcHost.shutdownAll("app_close");
    assert.ok(Array.isArray(shutdown));
  });
});

describe("P5.11 IPC: reviewed execution catalog gates authorization", () => {
  it("unregistered lessons stay inspection-only; digest-bound registration authorizes", () => {
    clearReviewedLessons();
    assert.equal(isExecutionAuthorized("C01-L900", "digest-x"), false);
    registerReviewedLesson({ lesson_id: "C01-L900", course_id: "C01", lesson_compiled_digest: "digest-x", reviewed_note: "synthetic review" });
    assert.equal(isExecutionAuthorized("C01-L900", "digest-x"), true);
    assert.equal(isExecutionAuthorized("C01-L900", "digest-y"), false, "swapped bytes never inherit a grant");
    assert.equal(isExecutionAuthorized("C01-L899", "digest-x"), false);
    unregisterReviewedLesson("C01-L900");
    assert.equal(isExecutionAuthorized("C01-L900", "digest-x"), false);
  });

  it("inspection-only IPC sessions reject runs with NOT_AUTHORIZED and zero provider starts", async () => {
    const { ipcHost, fake } = makeIpcHost();
    clearReviewedLessons();
    ipcHost.bindRenderer({ webContentsId: 51, rendererUrl: "file:///renderer/index.html" });
    const ir = syntheticLesson("C01-L905");
    const opened = await ipcHost.openSessionForRenderer({
      webContentsId: 51,
      rendererUrl: "file:///renderer/index.html",
      compiledLesson: ir,
      lessonCompiledDigest: "digest-unreviewed",
      lessonId: "C01-L905",
    });
    assert.equal(opened.ok, true);
    const sessionId = (opened as { ok: true; session: { session_id: string } }).session.session_id;
    const run = await ipcHost.handleInvoke("terminal:runOperation", sender({ webContentsId: 51 }), {
      session_id: sessionId,
      operation_id: "C01-L905-S001-B001",
      request_id: "req-ipc-noauth",
    });
    assert.equal((run as { ok: false; code: string }).code, "NOT_AUTHORIZED");
    assert.equal(fake.startCalls, 0);
    await ipcHost.closeSessionForRenderer(51, "lesson_end");
  });
});

describe("P5.11 IPC: preload, bridge and main static boundaries", () => {
  function strip(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  it("preload exposes exactly the P4 functions plus the five terminal methods and onEvent", () => {
    const code = strip(readFileSync(join(appRoot, "electron", "preload.ts"), "utf8"));
    for (const name of ["getMeta", "loadLesson", "reportReady", "runOperation", "stopProcess", "cancelOperation", "resetRuntime", "getSnapshot", "onEvent"]) {
      assert.match(code, new RegExp(name), `preload must expose ${name}`);
    }
    assert.equal(code.match(/contextBridge\.exposeInMainWorld/g)?.length, 1, "exactly one bridge object");
    assert.doesNotMatch(code, /child_process/);
    assert.doesNotMatch(code, /node:fs/);
    assert.doesNotMatch(code, /from\s+["']electron["']\s*;\s*import.*BrowserWindow/);
    for (const banned of ["terminal:execute", "terminal:exec", "terminal:spawn", "terminal:shell", "terminal:stdin", "terminal:resize", "terminal:docker"]) {
      assert.equal(code.includes(`"${banned}"`), false, `no ${banned} channel in preload`);
    }
  });

  it("main keeps the sandbox, denies navigation/opening and barriers shutdown", () => {
    const code = readFileSync(join(appRoot, "electron", "main.ts"), "utf8");
    assert.match(code, /contextIsolation:\s*true/);
    assert.match(code, /nodeIntegration:\s*false/);
    assert.match(code, /sandbox:\s*true/);
    assert.match(code, /will-navigate/);
    assert.match(code, /setWindowOpenHandler/);
    assert.match(code, /before-quit/);
    assert.match(code, /shutdownAll/);
    // The shutdown barrier itself never bypasses via app.exit: quit proceeds
    // only after the barrier (the pre-existing smoke reporter below keeps its
    // own app.exit, out of P5.11 scope).
    const quitIndex = code.indexOf("before-quit");
    const quitBlock = strip(code).slice(quitIndex, quitIndex + 1200);
    assert.doesNotMatch(quitBlock, /app\.exit/);
    // The five terminal channels are registered through the allowlist — no
    // hardcoded extra terminal: channel exists.
    const channels = [...code.matchAll(/"(terminal:[A-Za-z]+)"/g)].map((m) => m[1]);
    for (const channel of channels) {
      assert.ok(
        ["terminal:runOperation", "terminal:stopProcess", "terminal:cancelOperation", "terminal:resetRuntime", "terminal:getSnapshot", "terminal:event"].includes(channel),
        `unexpected terminal channel ${channel}`,
      );
    }
  });

  it("reportReady stays diagnostics-only and cannot authorize execution", () => {
    const code = strip(readFileSync(join(appRoot, "electron", "main.ts"), "utf8"));
    const readyIndex = code.indexOf("app:ready");
    assert.ok(readyIndex >= 0);
    const readyBlock = code.slice(readyIndex, readyIndex + 800);
    assert.doesNotMatch(readyBlock, /openSession|registerReviewedLesson|TerminalHost|NOT_AUTHORIZED|operation\.completed/);
  });

  it("renderer bridge carries the terminal surface type-only (no Electron/node imports)", () => {
    const code = strip(readFileSync(join(appRoot, "src", "model", "bridge.ts"), "utf8"));
    for (const name of ["runOperation", "stopProcess", "cancelOperation", "resetRuntime", "getSnapshot", "onEvent"]) {
      assert.match(code, new RegExp(name), `bridge must type ${name}`);
    }
    assert.doesNotMatch(code, /from\s+["']electron["']/);
    assert.doesNotMatch(code, /from\s+["']node:/);
  });
});
