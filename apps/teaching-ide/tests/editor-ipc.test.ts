// P6.12 editor IPC IDE tests — deterministic, no Electron launch, no Docker.
// Proves sender validation, the exact four-channel surface, owner binding and
// serialized switches, fake-driver routing with bounded presentation push,
// lifecycle-safe subscription handling, preload/bridge narrowness and the
// main-process registration/shutdown invariants — mirroring the P5.11
// terminal-ipc suite for the separate editor domain.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EditorIpcHost,
  EDITOR_EVENT_CHANNEL,
  EDITOR_INVOKE_CHANNELS,
  EDITOR_PRESENTATION_CHANNEL,
  isTrustedEditorSender,
  type EditorDriverLike,
  type EditorSender,
} from "../electron/editor-host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

function proof(message: string): void {
  console.log(`P6.12 PROOF: ${message}`);
}

const RENDERER_URL = "file:///dist/renderer/index.html";

function sender(overrides: Partial<EditorSender> = {}): EditorSender {
  return { webContentsId: 7, frameUrl: RENDERER_URL, frameIsTop: true, senderDestroyed: false, ...overrides };
}

// -- fake driver (never touches disk; records routing) ------------------------

class FakeEditorDriver implements EditorDriverLike {
  runs: { request: unknown; deps: unknown }[] = [];
  cancels: unknown[] = [];
  snapshots: unknown[] = [];
  acks: unknown[] = [];
  nextRun: unknown = { ok: true, run: { frames: [] } };
  throwOn: string | null = null;
  private listeners = new Set<(event: unknown) => void>();

  describe(): { session_id: string; generation: number } {
    return { session_id: "ed-sess-1", generation: 1 };
  }

  async runOperation(request: unknown, deps?: unknown): Promise<unknown> {
    this.runs.push({ request, deps });
    if (this.throwOn === "run") throw new Error("injected driver failure E:\\secret\\leak");
    return this.nextRun;
  }

  cancelOperation(request: unknown): unknown {
    this.cancels.push(request);
    if (this.throwOn === "cancel") throw new Error("injected driver failure");
    return { ok: true, cancel: { operation_id: "op-1", kind: "cancelled" } };
  }

  getSnapshot(request: unknown): unknown {
    this.snapshots.push(request);
    if (this.throwOn === "snapshot") throw new Error("injected driver failure");
    return { ok: true, page: { documents: [], events: [] } };
  }

  async acknowledge(request: unknown): Promise<unknown> {
    this.acks.push(request);
    if (this.throwOn === "ack") throw new Error("injected driver failure");
    return { ok: true, ack: { completed: false } };
  }

  subscribe(listener: (event: unknown) => void): { unsubscribe: () => void } {
    this.listeners.add(listener);
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  emit(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

interface FakeSession {
  driver: FakeEditorDriver;
  cleanups: string[];
}

function makeIpcHost(factory?: (driver: FakeEditorDriver) => void): { host: EditorIpcHost; sessions: FakeSession[]; pushes: { webContentsId: number; channel: string; dto: unknown }[] } {
  const sessions: FakeSession[] = [];
  const pushes: { webContentsId: number; channel: string; dto: unknown }[] = [];
  let seq = 0;
  const host = new EditorIpcHost({
    openSession: async (input) => {
      seq += 1;
      const driver = new FakeEditorDriver();
      const record: FakeSession = { driver, cleanups: [] };
      sessions.push(record);
      factory?.(driver);
      void input;
      return {
        ok: true,
        opened: {
          driver,
          execDeps: { factory: "main-held" },
          session: { session_id: `ed-sess-${seq}`, generation: 1 },
          cleanup: async () => {
            record.cleanups.push("cleaned");
          },
        },
      };
    },
    pushToRenderer: (webContentsId, channel, dto) => {
      pushes.push({ webContentsId, channel, dto });
    },
  });
  return { host, sessions, pushes };
}

async function openBoundSession(host: EditorIpcHost, webContentsId = 7): Promise<{ session_id: string; generation: number }> {
  host.bindRenderer({ webContentsId, rendererUrl: RENDERER_URL });
  const opened = await host.openSessionForRenderer({
    webContentsId,
    rendererUrl: RENDERER_URL,
    compiledLesson: {},
    lessonCompiledDigest: "0".repeat(64),
    lessonId: "C01-L071",
    reviewed: true,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error("unreachable");
  return opened.session;
}

describe("P6.12 editor IPC surface", () => {
  it("P6.12 PROOF: editor IPC carries exactly four narrow channels", () => {
    assert.deepEqual([...EDITOR_INVOKE_CHANNELS], ["editor:runOperation", "editor:cancelOperation", "editor:getSnapshot", "editor:acknowledgePresentation"]);
    assert.equal(EDITOR_EVENT_CHANNEL, "editor:event");
    assert.equal(EDITOR_PRESENTATION_CHANNEL, "editor:presentation");
    for (const channel of EDITOR_INVOKE_CHANNELS) {
      assert.equal(channel.startsWith("editor:"), true);
      assert.equal(channel.includes("terminal"), false, "editor and terminal IPC never share a channel");
      assert.ok(!channel.includes("reset"), "no independent editor reset channel exists");
    }
    proof("editor IPC carries exactly four narrow channels");
  });

  it("P6.12 PROOF: editor sender validation fences foreign frames and windows", () => {
    const binding = { webContentsId: 7, rendererUrl: RENDERER_URL };
    assert.equal(isTrustedEditorSender(sender(), binding), true);
    assert.equal(isTrustedEditorSender(sender(), null), false);
    assert.equal(isTrustedEditorSender(sender({ webContentsId: 8 }), binding), false);
    assert.equal(isTrustedEditorSender(sender({ frameIsTop: false }), binding), false);
    assert.equal(isTrustedEditorSender(sender({ frameUrl: null }), binding), false);
    assert.equal(isTrustedEditorSender(sender({ frameUrl: "file:///evil.html" }), binding), false);
    assert.equal(isTrustedEditorSender(sender({ senderDestroyed: true }), binding), false);
    proof("editor sender validation fences foreign frames and windows");
  });

  it("P6.12 PROOF: unknown channels and ownerless payloads reject before the engine", async () => {
    const { host } = makeIpcHost();
    const session = await openBoundSession(host);
    assert.deepEqual(await host.handleInvoke("editor:reset", sender(), { session_id: session.session_id }), { ok: false, code: "INVALID_REQUEST", message: "unknown editor channel" });
    assert.deepEqual(await host.handleInvoke("terminal:runOperation", sender(), { session_id: session.session_id }), { ok: false, code: "INVALID_REQUEST", message: "unknown editor channel" });
    assert.deepEqual(await host.handleInvoke("editor:runOperation", sender(), { operation_id: "op" }), { ok: false, code: "INVALID_REQUEST", message: "editor request must carry its session_id" });
    assert.deepEqual(await host.handleInvoke("editor:runOperation", sender(), { session_id: "ed-unknown" }), { ok: false, code: "STALE_SESSION", message: "unknown or closed session" });
    proof("unknown channels and ownerless payloads reject before the engine");
  });

  it("P6.12 PROOF: foreign senders never reach the editor engine", async () => {
    const { host, sessions } = makeIpcHost();
    const session = await openBoundSession(host);
    const payload = { session_id: session.session_id, generation: 1, operation_id: "op-1", request_id: "req-1" };
    for (const bad of [sender({ webContentsId: 9 }), sender({ frameIsTop: false }), sender({ frameUrl: "file:///evil.html" }), sender({ senderDestroyed: true })]) {
      const response = await host.handleInvoke("editor:runOperation", bad, payload);
      assert.deepEqual(response, { ok: false, code: "WRONG_OWNER", message: "editor sender is not the bound session owner" });
    }
    assert.equal(sessions[0]!.driver.runs.length, 0);
    proof("foreign senders never reach the editor engine");
  });

  it("P6.12 PROOF: run routes identifiers with main-held deps and pushes trusted frames", async () => {
    const { host, sessions, pushes } = makeIpcHost((driver) => {
      driver.nextRun = { ok: true, run: { frames: [{ kind: "type_chunk", chunk_seq: 0 }] } };
    });
    const session = await openBoundSession(host);
    const payload = { session_id: session.session_id, generation: 1, operation_id: "op-1", request_id: "req-1" };
    const response = await host.handleInvoke("editor:runOperation", sender(), payload);
    assert.equal(response.ok, true);
    assert.equal(sessions[0]!.driver.runs.length, 1);
    assert.deepEqual((sessions[0]!.driver.runs[0] as { request: unknown }).request, payload);
    assert.deepEqual((sessions[0]!.driver.runs[0] as { deps: unknown }).deps, { factory: "main-held" });
    const framePush = pushes.find((push) => push.channel === EDITOR_PRESENTATION_CHANNEL);
    assert.ok(framePush !== undefined, "trusted frames re-emit over the presentation channel");
    assert.equal(framePush.webContentsId, 7);
    proof("run routes identifiers with main-held deps and pushes trusted frames");
  });

  it("P6.12 PROOF: cancel snapshot and ack route without frame pushes", async () => {
    const { host, sessions, pushes } = makeIpcHost();
    const session = await openBoundSession(host);
    const cancel = await host.handleInvoke("editor:cancelOperation", sender(), { session_id: session.session_id, generation: 1, operation_id: "op-1", request_id: "req-2" });
    assert.equal(cancel.ok, true);
    const snapshot = await host.handleInvoke("editor:getSnapshot", sender(), { session_id: session.session_id, generation: 1, after_seq: 0 });
    assert.equal(snapshot.ok, true);
    const ack = await host.handleInvoke("editor:acknowledgePresentation", sender(), { session_id: session.session_id, generation: 1, operation_id: "op-1", plan_id: "tp-1", chunk_seq: 0 });
    assert.equal(ack.ok, true);
    assert.equal(sessions[0]!.driver.cancels.length, 1);
    assert.equal(sessions[0]!.driver.snapshots.length, 1);
    assert.equal(sessions[0]!.driver.acks.length, 1);
    assert.equal(pushes.filter((push) => push.channel === EDITOR_PRESENTATION_CHANNEL).length, 0);
    proof("cancel snapshot and ack route without frame pushes");
  });

  it("P6.12 PROOF: driver failures surface safely without stacks or paths", async () => {
    const { host } = makeIpcHost((driver) => {
      driver.throwOn = "run";
    });
    const session = await openBoundSession(host);
    const response = await host.handleInvoke("editor:runOperation", sender(), { session_id: session.session_id, generation: 1, operation_id: "op-1", request_id: "req-1" });
    assert.deepEqual(response, { ok: false, code: "WORKSPACE_UNAVAILABLE", message: "editor runtime failed safely" });
    proof("driver failures surface safely without stacks or paths");
  });

  it("P6.12 PROOF: lesson switches serialize with old-session cleanup", async () => {
    const { host, sessions } = makeIpcHost();
    const first = await openBoundSession(host);
    const second = await openBoundSession(host);
    assert.notEqual(first.session_id, second.session_id);
    assert.deepEqual(sessions[0]!.cleanups, ["cleaned"]);
    assert.equal(sessions.length, 2);
    // The old session is revoked: its invokes fence as stale.
    const stale = await host.handleInvoke("editor:getSnapshot", sender(), { session_id: first.session_id, generation: 1, after_seq: 0 });
    assert.deepEqual(stale, { ok: false, code: "STALE_SESSION", message: "unknown or closed session" });
    proof("lesson switches serialize with old-session cleanup");
  });

  it("P6.12 PROOF: journal events push lifecycle-safe with unsubscribe on close", async () => {
    const { host, sessions, pushes } = makeIpcHost();
    const session = await openBoundSession(host);
    sessions[1 - 1]!.driver.emit({ seq: 1, kind: "editor.operation.started" });
    const eventPush = pushes.find((push) => push.channel === EDITOR_EVENT_CHANNEL);
    assert.ok(eventPush !== undefined, "journal events push over the event channel");
    assert.equal(eventPush.webContentsId, 7);
    await host.closeSessionForRenderer(7, "lesson_end");
    assert.deepEqual(sessions[0]!.cleanups, ["cleaned"]);
    assert.equal(sessions[0]!.driver.listenerCount(), 0);
    // Late events after close push nowhere.
    const pushesBefore = pushes.length;
    sessions[0]!.driver.emit({ seq: 2, kind: "editor.operation.completed" });
    assert.equal(pushes.length, pushesBefore);
    // Closed sessions fence new work.
    const fenced = await host.handleInvoke("editor:runOperation", sender(), { session_id: session.session_id, generation: 1, operation_id: "op-1", request_id: "req-9" });
    assert.deepEqual(fenced, { ok: false, code: "STALE_SESSION", message: "editor session is closed: bounded replay only" });
    // Unknown windows close harmlessly.
    await host.closeSessionForRenderer(999, "renderer_loss");
    proof("journal events push lifecycle-safe with unsubscribe on close");
  });

  it("P6.12 PROOF: factory failures stay additive with safe codes", async () => {
    const host = new EditorIpcHost({
      openSession: async () => ({ ok: false, code: "WORKSPACE_UNAVAILABLE", message: "editor seed is unavailable" }),
      pushToRenderer: () => undefined,
    });
    host.bindRenderer({ webContentsId: 7, rendererUrl: RENDERER_URL });
    const rejected = await host.openSessionForRenderer({ webContentsId: 7, rendererUrl: RENDERER_URL, compiledLesson: {}, lessonCompiledDigest: "0".repeat(64), lessonId: "C01-L071", reviewed: true });
    assert.deepEqual(rejected, { ok: false, code: "WORKSPACE_UNAVAILABLE", message: "editor seed is unavailable" });
    const throwing = new EditorIpcHost({
      openSession: async () => {
        throw new Error("boom E:\\secret");
      },
      pushToRenderer: () => undefined,
    });
    throwing.bindRenderer({ webContentsId: 7, rendererUrl: RENDERER_URL });
    const held = await throwing.openSessionForRenderer({ webContentsId: 7, rendererUrl: RENDERER_URL, compiledLesson: {}, lessonCompiledDigest: "0".repeat(64), lessonId: "C01-L071", reviewed: true });
    assert.deepEqual(held, { ok: false, code: "WORKSPACE_UNAVAILABLE", message: "editor session is unavailable" });
    const unbound = new EditorIpcHost({ openSession: async () => { throw new Error("unreachable"); }, pushToRenderer: () => undefined });
    const denied = await unbound.openSessionForRenderer({ webContentsId: 7, rendererUrl: RENDERER_URL, compiledLesson: {}, lessonCompiledDigest: "0".repeat(64), lessonId: "C01-L071", reviewed: true });
    assert.deepEqual(denied, { ok: false, code: "WRONG_OWNER", message: "renderer window is not bound" });
    proof("factory failures stay additive with safe codes");
  });

  it("P6.12 PROOF: shutdown closes every session exactly once", async () => {
    const { host, sessions } = makeIpcHost();
    await openBoundSession(host, 7);
    await openBoundSession(host, 8);
    const closed = await host.shutdownAll("app_close");
    assert.equal(closed.length, 2);
    assert.deepEqual(sessions[0]!.cleanups, ["cleaned"]);
    assert.deepEqual(sessions[1]!.cleanups, ["cleaned"]);
    const again = await host.shutdownAll("app_close");
    assert.deepEqual(again, []);
    proof("shutdown closes every session exactly once");
  });
});

describe("P6.12 preload and main registration", () => {
  it("P6.12 PROOF: preload exposes exactly the narrow editor surface", () => {
    const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const preload = strip(readFileSync(join(appRoot, "electron", "preload.ts"), "utf8"));
    assert.match(preload, /editor:\s*editorApi/);
    for (const channel of ["editor:runOperation", "editor:cancelOperation", "editor:getSnapshot", "editor:acknowledgePresentation", "editor:event", "editor:presentation"]) {
      assert.match(preload, new RegExp(channel.replace(/:/g, ":")), `preload must wire ${channel}`);
    }
    assert.doesNotMatch(preload, /editor:reset/);
    // No privileged exposure: the bridge forwards unknowns, never Node.
    assert.doesNotMatch(preload, /child_process|node:fs|node-pty|Docker|workspace adapter/);
    assert.doesNotMatch(preload, /ipcRenderer\.invoke\(\s*[a-zA-Z]/, "no generic invoke with a variable channel");
    assert.equal(preload.match(/onPresentation/g)?.length, 2, "onPresentation subscription plus wiring");
    proof("preload exposes exactly the narrow editor surface");
  });

  it("P6.12 PROOF: main registers four editor channels with the shared shutdown barrier", () => {
    const main = readFileSync(join(appRoot, "electron", "main.ts"), "utf8");
    assert.match(main, /EDITOR_INVOKE_CHANNELS/);
    assert.match(main, /editorIpcHost\.handleInvoke/);
    assert.match(main, /editorIpcHost\.bindRenderer/);
    assert.match(main, /await editorHost\.shutdownAll\("app_close"\)/);
    assert.match(main, /editorIpcHost\.openSessionForRenderer/);
    assert.doesNotMatch(main, /"editor:reset"/);
    assert.doesNotMatch(main, /editor:runCode|editor:writeFile|editor:applyEdit/);
    proof("main registers four editor channels with the shared shutdown barrier");
  });

  it("P6.12 PROOF: Monaco projection stays read-only with virtual URIs and identifier-only acks", () => {
    // Positive wiring asserts run against the raw source: the comment
    // stripper would eat the :// in virtual URIs, so negatives (which need
    // stripping to avoid comment false-positives) are checked separately.
    const raw = readFileSync(join(appRoot, "src", "ui", "EditorPane.tsx"), "utf8");
    assert.match(raw, /cf-editor:\/\//);
    assert.match(raw, /readOnly:\s*true/);
    assert.match(raw, /pushEditOperations/);
    assert.match(raw, /onPlaybackAck/);
    // Inspection mode keeps its exact historical surface.
    assert.match(raw, /inmemory:\/\//);
    assert.match(raw, /onUserInput/);
    const strip = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const pane = strip(raw);
    // No generic edit authority and no Monaco text roundtrip exist: the only
    // content listener in the file is the historical inspection one (user
    // typing); playback models carry no listener and acks flow via props.
    assert.doesNotMatch(pane, /setDocumentText|replaceAll|saveContents|SendKeys|robot/i);
    assert.doesNotMatch(pane, /window\.cfApi/);
    assert.equal(pane.match(/onDidChangeContent/g)?.length, 1, "only the inspection listener reads model text");
    proof("Monaco projection stays read-only with virtual URIs and identifier-only acks");
  });
});
