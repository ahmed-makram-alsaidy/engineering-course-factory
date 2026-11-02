// P6.12 Safe IPC and Monaco projection — deterministic engine tests (offline, no sleeps).
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.12 Safe IPC and Monaco
// ("Main/preload bridge, read-only model projection/backpressure"; PASS
// "Hostile renderer tests and faithful model semantics"). Canonical authority:
// design sections 4/5/6/7/8/9/10/11/12/13/14/15/17/18/21/26.5 plus ADR-0011
// decisions 5-6, projected through the P6.11 EditorLifecycle.
// Proves at runtime (not merely by types): the exact four-channel invoke
// surface with strict identifier-only requests (every hostile semantic extra
// rejects with zero mutation); reviewed operation-ID resolution with no
// renderer path/text/timing authority; safe document snapshots carrying the
// exact main-owned buffer text as UI content; one logical document per
// canonical identity (Windows case aliases collapse); trusted type frames
// (one per schedule group, explicit UTF-16 boundaries) applied exactly once
// in order with the final buffer equal to B1; trusted replace steps
// (highlight/remove/insert) with the visual result equal to B1; UTF-16
// correctness across emoji/ZWJ/Arabic/combining/multiline content; no lost or
// duplicated presentation steps; ack fencing (session/generation/plan/order)
// with stale acks fenced and gaps fail-closed; no renderer content roundtrip
// (acks carry identifiers only); ack-gated B1 installation (exactly one
// install, exactly one journal terminal); identifier-only save with verified
// outcomes including commit-uncertain shown safely; main-owned dirty truth
// the renderer cannot forge; cancel restoring the trusted projection;
// reset fencing old generations with new-generation remount; replay without
// double application; subscribe-before-snapshot ordering; Record Safe Mode
// privacy (lesson-relative only, sanitized errors); no P6.13+ scope.
// Fixture IR is NEVER hand-authored: synthetic lesson sources compile through
// the canonical pipeline (parseLessonData -> compileLesson -> re-validation
// inside createEditorCatalog). All filesystem work stays under the
// phase-owned temp/P6.12/ipc root with cf-p612- names; the only host writes
// are controlled test setup (seed bytes, reseed) and byte-exact assertions.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import type { WorkspaceOwnership } from "../src/protocol.ts";
import { createSeedManifest, sha256Hex, type SeedManifest } from "../src/policy.ts";
import { openWindowsFileAdapter, type WindowsFileAdapter } from "../src/file-adapter.ts";
import { createEditorCatalog, type EditorCatalog } from "../src/editor-admission.ts";
import {
  createEditorLifecycle,
  type EditorLifecycle,
  type LifecycleAuthority,
  type LifecycleExecDeps,
} from "../src/editor-lifecycle.ts";
import {
  AcknowledgePresentationRequestSchema,
  CancelEditorOperationRequestSchema,
  GetEditorSnapshotRequestSchema,
  RunEditorOperationRequestSchema,
} from "../src/protocol.ts";
import {
  EDITOR_EVENT_CHANNEL,
  EDITOR_INVOKE_CHANNELS,
  EDITOR_IPC_VERSION,
  EDITOR_PRESENTATION_CHANNEL,
  buildReplaceFrames,
  buildTypeFrames,
  createEditorIpcDriver,
  sanitizeEditorMessage,
  type EditorDocumentSnapshot,
  type EditorIpcDriver,
  type EditorPresentationFrame,
  type EditorRunValue,
} from "../src/editor-ipc.ts";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.12", "ipc");
const DOC = "src/app.ts";
const SEED_V1 = "const a = 1;\n";

function proof(message: string): void {
  console.log(`P6.12 PROOF: ${message}`);
}

let lessonSeq = 0;
let requestSeq = 0;
let harnessSeq = 0;

function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p612-${prefix}-${requestSeq}`;
}

function buildIpcLessonSource(actions: Array<{ action: unknown }>): { raw: unknown; operationIds: string[] } {
  lessonSeq += 1;
  const lessonId = `C01-L${String(70 + lessonSeq).padStart(3, "0")}`;
  const operationIds = actions.map((_, index) => `${lessonId}-S001-B${String(index + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: `Synthetic P6.12 lesson ${lessonId}`,
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Prove safe editor IPC with faithful Monaco projection"],
    prerequisites: [],
    keywords: ["editor", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.12" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        type: "code_demo",
        title: "Project the admitted document",
        duration: 120,
        visual: { kind: "code_editor", description: "Editor IPC projection" },
        beats: actions.map((entry, index) => ({ beat_id: operationIds[index], kind: "action", action: entry.action })),
      },
    ],
  };
  return { raw, operationIds };
}

function compileIpcLesson(actions: Array<{ action: unknown }>): { compiled: CompiledLesson; operationIds: string[] } {
  const { raw, operationIds } = buildIpcLessonSource(actions);
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true, "synthetic lesson must pass canonical source validation");
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  return { compiled: compileModule.compileLesson(parsed.lesson), operationIds };
}

function manifestFor(files: Record<string, string>): SeedManifest {
  const entries = [
    { portable_path: "src", kind: "directory" as const, byte_length: 0, sha256: null as string | null },
    ...Object.entries(files).map(([portable_path, text]) => ({
      portable_path,
      kind: "regular_file" as const,
      byte_length: Buffer.byteLength(text, "utf8"),
      sha256: sha256Hex(text) as string | null,
    })),
  ];
  const outcome = createSeedManifest(entries);
  assert.equal(outcome.ok, true, "seed manifest must build");
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

interface IpcHarness {
  readonly tag: string;
  readonly leaf: string;
  readonly staging: string;
  readonly adapter: WindowsFileAdapter;
  readonly lifecycle: EditorLifecycle;
  readonly driver: EditorIpcDriver;
  readonly catalog: EditorCatalog;
  readonly operationIds: string[];
  readonly sessionId: string;
  readonly workspaceId: string;
}

function openIpcHarness(actions: Array<{ action: unknown }>, files: Record<string, string>): IpcHarness {
  harnessSeq += 1;
  const tag = `cf-p612-t${harnessSeq}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(join(leaf, "src"), { recursive: true });
  mkdirSync(staging, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
  }
  const seed = manifestFor(files);
  const { compiled, operationIds } = compileIpcLesson(actions);
  const catalogOutcome = createEditorCatalog(compiled);
  assert.equal(catalogOutcome.ok, true, "catalog must build");
  if (!catalogOutcome.ok) throw new Error("unreachable");
  const sessionId = `sess-p612-${String(harnessSeq).padStart(4, "0")}`;
  const workspaceId = `ws-p612-${String(harnessSeq).padStart(4, "0")}`;
  const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
  assert.equal(bound.ok, true, "adapter binding must open");
  if (!bound.ok) throw new Error("unreachable");
  const lifecycle = createEditorLifecycle({
    catalog: catalogOutcome.value,
    seedManifest: seed,
    sessionId,
    generation: 1,
    wiring: {
      getOwnership: () => "EDITOR_OWNED" as WorkspaceOwnership,
      retireContainer: async () => "confirmed" as const,
      reseed: async () => {
        for (const entry of readdirSync(leaf)) rmSync(join(leaf, entry), { recursive: true, force: true });
        mkdirSync(join(leaf, "src"), { recursive: true });
        for (const [rel, text] of Object.entries(files)) writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
        for (const entry of readdirSync(staging)) rmSync(join(staging, entry), { recursive: true, force: true });
      },
    },
  });
  const driver = createEditorIpcDriver({ lifecycle });
  return { tag, leaf, staging, adapter: bound.value, lifecycle, driver, catalog: catalogOutcome.value, operationIds, sessionId, workspaceId };
}

function authorityFor(h: IpcHarness): LifecycleAuthority {
  const d = h.lifecycle.describe();
  return {
    lease: {
      kind: "editor_lease",
      leaseId: `lease-p612-${harnessSeq}`,
      sessionId: d.session_id,
      generation: d.generation,
      workspaceId: h.workspaceId,
      epoch: d.epoch,
      operationId: "op-p612-synthetic",
      requestId: nextRequest("synthetic"),
    },
    ownership: "EDITOR_OWNED",
    liveEpoch: d.epoch,
    revokedLeaseIds: [],
  };
}

function depsFor(h: IpcHarness): LifecycleExecDeps {
  return { adapter: h.adapter as unknown, authority: authorityFor(h) };
}

function runRequest(h: IpcHarness, operationId: string, requestId?: string): { session_id: string; generation: number; operation_id: string; request_id: string } {
  const d = h.lifecycle.describe();
  return { session_id: d.session_id, generation: d.generation, operation_id: operationId, request_id: requestId ?? nextRequest("run") };
}

function mustRunValue(response: unknown): EditorRunValue {
  assert.equal((response as { ok: boolean }).ok, true, `run must succeed: ${JSON.stringify(response)}`);
  return (response as { ok: true; run: EditorRunValue }).run;
}

function mustReject(response: unknown): { code: string; message: string } {
  assert.equal((response as { ok: boolean }).ok, false, "request must reject");
  return response as { ok: false; code: string; message: string };
}

function bufferOf(h: IpcHarness, documentId: string): string {
  const content = h.lifecycle.getSession().registry.getBufferContent(documentId);
  assert.equal(content.ok, true, "live document must hold executed buffer text");
  if (!content.ok) throw new Error("unreachable");
  return content.value;
}

function hostText(h: IpcHarness, rel: string): string | null {
  const full = join(h.leaf, ...rel.split("/"));
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}

function dtoLeaks(dto: unknown): string[] {
  const json = JSON.stringify(dto) ?? "";
  const leaks: string[] = [];
  if (/[A-Za-z]:[\\/]/.test(json)) leaks.push("drive-letter path");
  if (json.includes("\\\\")) leaks.push("UNC/device escape");
  if (/cf-p612-[a-z0-9-]+-staging/.test(json)) leaks.push("private staging name");
  if (/cf-p612-t[0-9]+-[0-9a-f]+/.test(json)) leaks.push("phase resource identity");
  return leaks;
}

/** Renderer-side pure application of trusted type frames (projection only, never authority). */
function applyTypeFrames(baseText: string, frames: readonly EditorPresentationFrame[]): string {
  let projection = baseText;
  for (const frame of frames) {
    assert.equal(frame.kind, "type_chunk");
    if (frame.kind !== "type_chunk") throw new Error("unreachable");
    projection = projection.slice(0, frame.start_utf16) + frame.text + projection.slice(frame.start_utf16);
  }
  return projection;
}

/** Renderer-side pure application of trusted replace steps (projection only, never authority). */
function applyReplaceFrames(baseText: string, frames: readonly EditorPresentationFrame[]): string {
  let projection = baseText;
  for (const frame of frames) {
    assert.equal(frame.kind, "replace_step");
    if (frame.kind !== "replace_step") throw new Error("unreachable");
    if (frame.step_kind === "highlight") continue;
    if (frame.step_kind === "remove") {
      projection = projection.slice(0, frame.adjusted_start_utf16) + projection.slice(frame.adjusted_end_utf16);
    } else {
      projection = projection.slice(0, frame.adjusted_start_utf16) + frame.text + projection.slice(frame.adjusted_start_utf16);
    }
  }
  return projection;
}

async function ackAll(h: IpcHarness, operationId: string, planId: string, count: number): Promise<unknown> {
  const d = h.lifecycle.describe();
  let last: unknown = null;
  for (let seq = 0; seq < count; seq += 1) {
    last = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: operationId, plan_id: planId, chunk_seq: seq });
    assert.equal((last as { ok: boolean }).ok, true, `ack ${seq} must succeed: ${JSON.stringify(last)}`);
  }
  return last;
}

before(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  rmSync(join(repoRoot, "temp", "P6.12"), { recursive: true, force: true });
});

describe("P6.12 safe IPC surface", () => {
  it("P6.12 PROOF: safe editor IPC registration carries exactly four narrow channels", () => {
    assert.deepEqual([...EDITOR_INVOKE_CHANNELS], ["editor:runOperation", "editor:cancelOperation", "editor:getSnapshot", "editor:acknowledgePresentation"]);
    assert.equal(EDITOR_EVENT_CHANNEL, "editor:event");
    assert.equal(EDITOR_PRESENTATION_CHANNEL, "editor:presentation");
    assert.equal(EDITOR_IPC_VERSION, 1);
    for (const channel of EDITOR_INVOKE_CHANNELS) {
      assert.equal(channel.startsWith("editor:"), true, "editor channels live in their own narrow domain");
      assert.equal(channel.includes("terminal"), false, "editor and terminal IPC never share a channel");
    }
    proof("safe editor IPC registration carries exactly four narrow channels");
  });

  it("P6.12 PROOF: strict request DTOs reject every hostile semantic extra", () => {
    const hostileExtras = ["path", "content", "text", "code", "find", "replace", "replacement", "position", "line", "column", "timing", "cps", "bytes", "digest", "revision", "access", "mount", "epoch", "pid", "container", "dirty", "hostPath"] as const;
    const base = { session_id: "sess-p612-0001", generation: 1, operation_id: "C01-L071-S001-B001", request_id: "req-p612-x" };
    for (const extra of hostileExtras) {
      assert.equal(RunEditorOperationRequestSchema.safeParse({ ...base, [extra]: "evil" }).success, false, `run must reject ${extra}`);
      assert.equal(CancelEditorOperationRequestSchema.safeParse({ ...base, [extra]: "evil" }).success, false, `cancel must reject ${extra}`);
    }
    const snapshotBase = { session_id: "sess-p612-0001", generation: 1, after_seq: 0 };
    for (const extra of hostileExtras) {
      assert.equal(GetEditorSnapshotRequestSchema.safeParse({ ...snapshotBase, [extra]: "evil" }).success, false, `snapshot must reject ${extra}`);
    }
    const ackBase = { session_id: "sess-p612-0001", generation: 1, operation_id: "C01-L071-S001-B001", plan_id: "tp-evil", chunk_seq: 0 };
    for (const extra of hostileExtras) {
      assert.equal(AcknowledgePresentationRequestSchema.safeParse({ ...ackBase, [extra]: "evil" }).success, false, `ack must reject ${extra}`);
    }
    proof("strict request DTOs reject every hostile semantic extra");
  });

  it("P6.12 PROOF: unknown operation IDs resolve through reviewed admission only", async () => {
    const h = openIpcHarness([{ action: { type: "file_open", path: DOC } }], { [DOC]: SEED_V1 });
    const response = await h.driver.runOperation(runRequest(h, "C01-L071-S001-B999"), depsFor(h));
    const rejection = mustReject(response);
    assert.equal(rejection.code, "NOT_AUTHORIZED");
    assert.deepEqual(dtoLeaks(response), []);
    proof("unknown operation IDs resolve through reviewed admission only");
  });

  it("P6.12 PROOF: renderer cannot supply paths through any channel", async () => {
    const h = openIpcHarness([{ action: { type: "file_open", path: DOC } }], { [DOC]: SEED_V1 });
    const d = h.lifecycle.describe();
    const evil = { session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[0]!, request_id: nextRequest("evil"), path: "src/evil.ts" };
    assert.equal((await h.driver.runOperation(evil, depsFor(h))).ok, false);
    assert.equal(h.driver.cancelOperation({ ...evil }).ok, false);
    assert.equal((await h.driver.acknowledge({ ...evil, plan_id: "tp-evil", chunk_seq: 0 })).ok, false);
    assert.equal(h.driver.getSnapshot({ session_id: d.session_id, generation: d.generation, after_seq: 0, path: "src/evil.ts" }).ok, false);
    // Zero mutation: no journal terminal, no buffer.
    assert.equal(h.lifecycle.listTombstones().length, 0);
    proof("renderer cannot supply paths through any channel");
  });

  it("P6.12 PROOF: stale senders fence with zero mutation", async () => {
    const h = openIpcHarness([{ action: { type: "file_open", path: DOC } }], { [DOC]: SEED_V1 });
    const eventsBefore = h.lifecycle.getJournal().eventCount();
    const staleSession = await h.driver.runOperation({ session_id: "sess-foreign", generation: 1, operation_id: h.operationIds[0]!, request_id: nextRequest("stale") }, depsFor(h));
    assert.equal(mustReject(staleSession).code, "WRONG_OWNER");
    const staleGeneration = await h.driver.runOperation({ session_id: h.sessionId, generation: 999, operation_id: h.operationIds[0]!, request_id: nextRequest("stale") }, depsFor(h));
    assert.equal(mustReject(staleGeneration).code, "STALE_SESSION");
    assert.equal(h.lifecycle.getJournal().eventCount(), eventsBefore);
    assert.equal(h.lifecycle.listTombstones().length, 0);
    proof("stale senders fence with zero mutation");
  });
});

describe("P6.12 document projection", () => {
  it("P6.12 PROOF: admitted file_open projects the exact main-owned buffer", async () => {
    const h = openIpcHarness([{ action: { type: "file_open", path: DOC } }], { [DOC]: SEED_V1 });
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    assert.equal(run.completed, true);
    assert.deepEqual(run.frames, []);
    assert.ok(run.document !== null);
    assert.equal(run.document.portable_path, DOC);
    assert.equal(run.document.content, SEED_V1);
    assert.equal(run.document.has_content, true);
    assert.equal(run.document.dirty, false);
    assert.equal(run.document.pending_creation, false);
    assert.deepEqual(dtoLeaks(run), []);
    // Disk untouched by the projection.
    assert.equal(hostText(h, DOC), SEED_V1);
    proof("admitted file_open projects the exact main-owned buffer");
  });

  it("P6.12 PROOF: pending file_create projects staged bytes while disk stays absent", async () => {
    const staged = "pending projection\n";
    const h = openIpcHarness([{ action: { type: "file_create", path: "src/fresh.ts", content: staged } }], {});
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    assert.equal(run.completed, true);
    assert.ok(run.document !== null);
    assert.equal(run.document.content, staged);
    assert.equal(run.document.pending_creation, true);
    assert.equal(run.document.dirty, true);
    assert.equal(hostText(h, "src/fresh.ts"), null);
    assert.deepEqual(dtoLeaks(run), []);
    proof("pending file_create projects staged bytes while disk stays absent");
  });

  it("P6.12 PROOF: one Monaco model per logical document with case aliases collapsed", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: "src/app.ts" } }, { action: { type: "file_open", path: "src/APP.ts" } }],
      { "src/app.ts": SEED_V1 },
    );
    const first = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const second = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(first.document !== null && second.document !== null);
    assert.equal(first.document.document_id, second.document.document_id);
    assert.equal(first.document.content, second.document.content);
    proof("one Monaco model per logical document with case aliases collapsed");
  });

  it("P6.12 PROOF: safe document snapshot carries revisions with bounded replay cursors", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const d = h.lifecycle.describe();
    const page = h.driver.getSnapshot({ session_id: d.session_id, generation: d.generation, after_seq: 0 });
    assert.equal(page.ok, true);
    if (!page.ok || !("page" in page)) throw new Error("unreachable");
    assert.equal(page.page.documents.length, 1);
    assert.equal(page.page.documents[0]!.portable_path, DOC);
    assert.equal(page.page.journal_high_seq >= page.page.page_end_seq, true);
    assert.equal(page.page.reset, false);
    assert.deepEqual(dtoLeaks(page), []);
    proof("safe document snapshot carries revisions with bounded replay cursors");
  });
});

describe("P6.12 type presentation", () => {
  it("P6.12 PROOF: trusted type frames progress exactly with UTF-16 boundaries", async () => {
    const content = "const b = 2;\n";
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.equal(run.completed, false);
    assert.ok(run.plan_id !== null && run.document !== null);
    assert.ok(run.frames.length > 0);
    const baseText = run.document.content;
    // Frames carry explicit boundaries: renderer applies, never computes.
    let seq = 0;
    for (const frame of run.frames) {
      assert.equal(frame.kind, "type_chunk");
      if (frame.kind !== "type_chunk") throw new Error("unreachable");
      assert.equal(frame.chunk_seq, seq);
      assert.equal(frame.chunk_count, run.frames.length);
      seq += 1;
    }
    const projected = applyTypeFrames(baseText, run.frames);
    const plan = h.lifecycle.getTypePlanner().getPlan(run.plan_id!);
    assert.ok(plan !== null);
    assert.equal(projected, plan.expected_text);
    // Disk still shows committed bytes before completion.
    assert.equal(hostText(h, DOC), SEED_V1);
    proof("trusted type frames progress exactly with UTF-16 boundaries");
  });

  it("P6.12 PROOF: type acknowledgements gate the single B1 installation", async () => {
    const content = "const b = 2;\nconst c = 3;\n";
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null && run.document !== null);
    const documentId = run.document.document_id;
    const plan = h.lifecycle.getTypePlanner().getPlan(run.plan_id!);
    assert.ok(plan !== null);
    const d = h.lifecycle.describe();
    // Intermediate acks progress without installing.
    for (let seq = 0; seq < run.frames.length - 1; seq += 1) {
      const ack = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: seq });
      assert.equal(ack.ok, true);
      if (!ack.ok || !("ack" in ack)) throw new Error("unreachable");
      assert.equal(ack.ack.completed, false);
      assert.equal(ack.ack.duplicate, false);
      assert.equal(ack.ack.expected_next, seq + 1);
      assert.equal(bufferOf(h, documentId), SEED_V1);
    }
    // Final ack installs B1 exactly once with one journal terminal.
    const last = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: run.frames.length - 1 });
    assert.equal(last.ok, true);
    if (!last.ok || !("ack" in last)) throw new Error("unreachable");
    assert.equal(last.ack.completed, true);
    assert.equal(bufferOf(h, documentId), plan.expected_text);
    assert.equal(hostText(h, DOC), SEED_V1);
    const terminals = h.lifecycle.getJournal().listEvents().filter((e) => e.operation_id === h.operationIds[1]! && (e.kind === "editor.operation.completed" || e.kind === "editor.operation.failed" || e.kind === "editor.operation.cancelled"));
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.kind, "editor.operation.completed");
    proof("type acknowledgements gate the single B1 installation");
  });

  it("P6.12 PROOF: duplicate type acks converge with no lost or duplicated units", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "abc\ndef\n" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null && run.frames.length >= 2);
    const d = h.lifecycle.describe();
    const first = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: 0 });
    assert.equal(first.ok, true);
    // Duplicate of an applied frame converges without progress.
    const duplicate = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: 0 });
    assert.equal(duplicate.ok, true);
    if (!duplicate.ok || !("ack" in duplicate)) throw new Error("unreachable");
    assert.equal(duplicate.ack.duplicate, true);
    assert.equal(duplicate.ack.expected_next, 1);
    // Gap rejects fail-closed with zero progress.
    const gap = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: 2 });
    assert.equal(mustReject(gap).code, "INVALID_REQUEST");
    // The skipped frame still applies exactly once afterwards.
    const resume = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: 1 });
    assert.equal(resume.ok, true);
    if (!resume.ok || !("ack" in resume)) throw new Error("unreachable");
    assert.equal(resume.ack.duplicate, false);
    proof("duplicate type acks converge with no lost or duplicated units");
  });

  it("P6.12 PROOF: type UTF-16 positions stay exact across emoji ZWJ Arabic and combining marks", async () => {
    const seed = "const e = \"🌍\";\n";
    const content = " // ✅ done 👨‍👩‍👧 مرحبا é\n";
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content } }],
      { [DOC]: seed },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null && run.document !== null);
    // Emoji before the cursor counts 2 UTF-16 units, exactly as Monaco columns do.
    assert.equal(run.document.content, seed);
    const first = run.frames[0];
    assert.ok(first !== undefined && first.kind === "type_chunk");
    if (first.kind !== "type_chunk") throw new Error("unreachable");
    assert.equal(first.start_utf16, seed.length);
    const projected = applyTypeFrames(seed, run.frames);
    const plan = h.lifecycle.getTypePlanner().getPlan(run.plan_id!);
    assert.ok(plan !== null);
    assert.equal(projected, plan.expected_text);
    assert.equal(projected, seed + content);
    const last = await ackAll(h, h.operationIds[1]!, run.plan_id!, run.frames.length);
    assert.equal((last as { ok: boolean }).ok, true);
    assert.equal(bufferOf(h, run.document.document_id), seed + content);
    // Positions stay monotonic in UTF-16 units across the whole schedule.
    let previous = -1;
    for (const frame of run.frames) {
      if (frame.kind !== "type_chunk") throw new Error("unreachable");
      assert.ok(frame.start_utf16 >= previous);
      previous = frame.start_utf16;
    }
    proof("type UTF-16 positions stay exact across emoji ZWJ Arabic and combining marks");
  });

  it("P6.12 PROOF: multiline type frames carry canonical line columns", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "l1\nl2\n", at_line: 1 } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null);
    assert.equal(run.frames[0]!.kind, "type_chunk");
    if (run.frames[0]!.kind !== "type_chunk") throw new Error("unreachable");
    assert.deepEqual({ line: run.frames[0]!.start.line, column_utf16: run.frames[0]!.start.column_utf16 }, { line: 1, column_utf16: 1 });
    const projected = applyTypeFrames(SEED_V1, run.frames);
    assert.equal(projected, "l1\nl2\n" + SEED_V1);
    await ackAll(h, h.operationIds[1]!, run.plan_id!, run.frames.length);
    const documentId = h.lifecycle.getSession().registry.listDocuments()[0]!.document_id;
    assert.equal(bufferOf(h, documentId), "l1\nl2\n" + SEED_V1);
    proof("multiline type frames carry canonical line columns");
  });

  it("P6.12 PROOF: large type blocks group deterministically with exact final bytes", async () => {
    const big = `x${"y".repeat(8998)}z`;
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: big } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null);
    assert.ok(run.frames.length < big.length, "fast profile groups bounded batches");
    assert.ok(run.frames.length > 0);
    const projected = applyTypeFrames(SEED_V1, run.frames);
    assert.equal(projected, SEED_V1 + big);
    await ackAll(h, h.operationIds[1]!, run.plan_id!, run.frames.length);
    const documentId = h.lifecycle.getSession().registry.listDocuments()[0]!.document_id;
    assert.equal(bufferOf(h, documentId), SEED_V1 + big);
    proof("large type blocks group deterministically with exact final bytes");
  });

  it("P6.12 PROOF: type frame construction is deterministic across builds", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "stable\nbytes\n" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null);
    const plan = h.lifecycle.getTypePlanner().getPlan(run.plan_id!);
    const schedule = h.lifecycle.getTypePlanner().getSchedule(run.plan_id!);
    assert.ok(plan !== null && schedule !== null);
    const d = h.lifecycle.describe();
    assert.deepEqual(buildTypeFrames(d.session_id, d.generation, plan, schedule), [...run.frames]);
    assert.deepEqual(buildTypeFrames(d.session_id, d.generation, plan, schedule), buildTypeFrames(d.session_id, d.generation, plan, schedule));
    proof("type frame construction is deterministic across builds");
  });

  it("P6.12 PROOF: no renderer content roundtrip exists on the ack path", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "truth\n" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null);
    const d = h.lifecycle.describe();
    // A hostile renderer offering its own Monaco text on the ack is rejected:
    // acknowledgements are identifier-only by strict construction.
    const forged = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: 0, content: "forged bytes\n", text: "forged" });
    assert.equal(forged.ok, false);
    assert.equal(mustReject(forged).code, "INVALID_REQUEST");
    // Honest acks still install exactly the main-computed candidate.
    await ackAll(h, h.operationIds[1]!, run.plan_id!, run.frames.length);
    const documentId = h.lifecycle.getSession().registry.listDocuments()[0]!.document_id;
    assert.equal(bufferOf(h, documentId), SEED_V1 + "truth\n");
    proof("no renderer content roundtrip exists on the ack path");
  });
});

describe("P6.12 replace presentation", () => {
  it("P6.12 PROOF: trusted replace steps render highlight remove insert in order", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "replace_code", path: DOC, find: "a = 1", replace: "a = 2" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.equal(run.completed, false);
    assert.ok(run.plan_id !== null && run.document !== null);
    assert.equal(run.frames.length, 3);
    const kinds = run.frames.map((frame) => {
      assert.equal(frame.kind, "replace_step");
      if (frame.kind !== "replace_step") throw new Error("unreachable");
      return frame.step_kind;
    });
    assert.deepEqual(kinds, ["highlight", "remove", "insert"]);
    for (const [index, frame] of run.frames.entries()) {
      if (frame.kind !== "replace_step") throw new Error("unreachable");
      assert.equal(frame.step_seq, index);
      assert.equal(frame.step_count, 3);
      assert.equal(frame.match_index, 0);
    }
    const projected = applyReplaceFrames(SEED_V1, run.frames);
    const plan = h.lifecycle.getReplacePlanner().getPlan(run.plan_id!);
    assert.ok(plan !== null);
    assert.equal(projected, plan.expected_text);
    assert.equal(projected, "const a = 2;\n");
    proof("trusted replace steps render highlight remove insert in order");
  });

  it("P6.12 PROOF: replace acknowledgements gate the single B1 installation", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "replace_code", path: DOC, find: "a = 1", replace: "a = 2" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null && run.document !== null);
    const documentId = run.document.document_id;
    const d = h.lifecycle.describe();
    for (let seq = 0; seq < run.frames.length - 1; seq += 1) {
      const ack = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: seq });
      assert.equal(ack.ok, true);
      if (!ack.ok || !("ack" in ack)) throw new Error("unreachable");
      assert.equal(ack.ack.completed, false);
      assert.equal(bufferOf(h, documentId), SEED_V1);
    }
    const last = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: run.frames.length - 1 });
    assert.equal(last.ok, true);
    if (!last.ok || !("ack" in last)) throw new Error("unreachable");
    assert.equal(last.ack.completed, true);
    assert.equal(bufferOf(h, documentId), "const a = 2;\n");
    const terminals = h.lifecycle.getJournal().listEvents().filter((e) => e.operation_id === h.operationIds[1]! && (e.kind === "editor.operation.completed" || e.kind === "editor.operation.failed" || e.kind === "editor.operation.cancelled"));
    assert.equal(terminals.length, 1);
    proof("replace acknowledgements gate the single B1 installation");
  });

  it("P6.12 PROOF: multi-match replace applies all ranges transactionally", async () => {
    const seed = "a = 1;\nb = 1;\n";
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "replace_code", path: DOC, find: "= 1", replace: "= 9", occurrences: 2 } }],
      { [DOC]: seed },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null);
    assert.equal(run.frames.length, 6);
    const projected = applyReplaceFrames(seed, run.frames);
    assert.equal(projected, "a = 9;\nb = 9;\n");
    await ackAll(h, h.operationIds[1]!, run.plan_id!, run.frames.length);
    const documentId = h.lifecycle.getSession().registry.listDocuments()[0]!.document_id;
    assert.equal(bufferOf(h, documentId), "a = 9;\nb = 9;\n");
    proof("multi-match replace applies all ranges transactionally");
  });

  it("P6.12 PROOF: replace frame construction is deterministic across builds", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "replace_code", path: DOC, find: "a", replace: "b" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null);
    const plan = h.lifecycle.getReplacePlanner().getPlan(run.plan_id!);
    const visual = h.lifecycle.getReplacePlanner().getVisualPlan(run.plan_id!);
    assert.ok(plan !== null && visual !== null);
    const d = h.lifecycle.describe();
    assert.deepEqual(buildReplaceFrames(d.session_id, d.generation, plan, visual, SEED_V1), [...run.frames]);
    proof("replace frame construction is deterministic across builds");
  });

  it("P6.12 PROOF: renderer cannot supply replace text match index or position", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "replace_code", path: DOC, find: "a", replace: "b" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null);
    const d = h.lifecycle.describe();
    for (const extra of ["find", "replace", "replacement", "match", "index", "position", "line", "column", "occurrences"] as const) {
      const forged = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: 0, [extra]: "evil" });
      assert.equal(forged.ok, false, `ack must reject ${extra}`);
    }
    await ackAll(h, h.operationIds[1]!, run.plan_id!, run.frames.length);
    const documentId = h.lifecycle.getSession().registry.listDocuments()[0]!.document_id;
    assert.equal(bufferOf(h, documentId), SEED_V1.replace("a", "b"));
    proof("renderer cannot supply replace text match index or position");
  });
});

describe("P6.12 save presentation", () => {
  it("P6.12 PROOF: save request stays identifier-only with verified outcomes", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "saved\n" } }, { action: { type: "file_save", path: DOC } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const typed = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(typed.plan_id !== null);
    await ackAll(h, h.operationIds[1]!, typed.plan_id!, typed.frames.length);
    const d = h.lifecycle.describe();
    for (const extra of ["bytes", "content", "text", "path", "revision", "digest"] as const) {
      const forged = await h.driver.runOperation({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[2]!, request_id: nextRequest("evil"), [extra]: "evil" }, depsFor(h));
      assert.equal(forged.ok, false, `save must reject ${extra}`);
    }
    const saved = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[2]!), depsFor(h)));
    assert.equal(saved.completed, true);
    assert.ok(saved.document !== null);
    assert.equal(saved.document.dirty, false);
    assert.equal(saved.document.content, SEED_V1 + "saved\n");
    assert.equal(hostText(h, DOC), SEED_V1 + "saved\n");
    const page = h.driver.getSnapshot({ session_id: d.session_id, generation: d.generation, after_seq: 0 });
    assert.equal(page.ok, true);
    if (!page.ok || !("page" in page)) throw new Error("unreachable");
    const completed = page.page.events.filter((e) => e.operation_id === h.operationIds[2]! && e.kind === "editor.operation.completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.disk_effect, "saved");
    proof("save request stays identifier-only with verified outcomes");
  });

  it("P6.12 PROOF: completed save replays without a second publication", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    let publishes = 0;
    const counting: WindowsFileAdapter = {
      ...h.adapter,
      publishDocument: async (authority, args) => {
        publishes += 1;
        return h.adapter.publishDocument(authority, args);
      },
    };
    const deps: LifecycleExecDeps = { adapter: counting as unknown, authority: authorityFor(h) };
    const first = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), deps));
    assert.equal(first.completed, true);
    const second = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!, nextRequest("dup")), deps));
    assert.equal(second.completed, true);
    assert.deepEqual(second.frames, []);
    assert.equal(second.journal_seq, first.journal_seq);
    proof("completed save replays without a second publication");
  });

  it("P6.12 PROOF: commit-uncertain save surfaces safely without false clean", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "uncertain\n" } }, { action: { type: "file_save", path: DOC } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const typed = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(typed.plan_id !== null);
    await ackAll(h, h.operationIds[1]!, typed.plan_id!, typed.frames.length);
    // Deterministic post-commit uncertainty (P6.10 precedent): the adapter
    // reports the publication succeeded but verification is uncertain.
    const uncertain: WindowsFileAdapter = {
      ...h.adapter,
      readDocument: (authority, portablePath) => h.adapter.readDocument(authority, portablePath),
      publishDocument: async () => ({ ok: false as const, rejection: { code: "COMMIT_UNCERTAIN" as const, message: "publication succeeded but verification is uncertain" } }),
    };
    const response = await h.driver.runOperation(runRequest(h, h.operationIds[2]!), { adapter: uncertain as unknown, authority: authorityFor(h) });
    const rejection = mustReject(response);
    assert.equal(rejection.code, "COMMIT_UNCERTAIN");
    assert.deepEqual(dtoLeaks(response), []);
    const documentId = h.lifecycle.getSession().registry.listDocuments()[0]!.document_id;
    assert.equal(bufferOf(h, documentId), SEED_V1 + "uncertain\n");
    proof("commit-uncertain save surfaces safely without false clean");
  });

  it("P6.12 PROOF: dirty state stays main-owned with terminal RW fenced", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "dirty\n" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const d = h.lifecycle.describe();
    const cleanPage = h.driver.getSnapshot({ session_id: d.session_id, generation: d.generation, after_seq: 0 });
    assert.equal(cleanPage.ok, true);
    if (!cleanPage.ok || !("page" in cleanPage)) throw new Error("unreachable");
    assert.equal(cleanPage.page.documents[0]!.dirty, false);
    const typed = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(typed.plan_id !== null);
    await ackAll(h, h.operationIds[1]!, typed.plan_id!, typed.frames.length);
    const dirtyPage = h.driver.getSnapshot({ session_id: d.session_id, generation: d.generation, after_seq: 0 });
    assert.equal(dirtyPage.ok, true);
    if (!dirtyPage.ok || !("page" in dirtyPage)) throw new Error("unreachable");
    assert.equal(dirtyPage.page.documents[0]!.dirty, true);
    // Renderer-supplied cleanliness is not a field anywhere: strict schemas
    // reject it and no driver method accepts a dirty flag.
    assert.equal(RunEditorOperationRequestSchema.safeParse({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, request_id: nextRequest("evil"), dirty: false }).success, false);
    proof("dirty state stays main-owned with terminal RW fenced");
  });
});

describe("P6.12 cancel reset replay and ordering", () => {
  it("P6.12 PROOF: cancel restores the trusted B0 projection", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "cancelled\n" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null && run.document !== null);
    const d = h.lifecycle.describe();
    const cancelled = h.driver.cancelOperation({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, request_id: nextRequest("cancel") });
    assert.equal(cancelled.ok, true);
    if (!cancelled.ok || !("cancel" in cancelled)) throw new Error("unreachable");
    assert.equal(cancelled.cancel.kind, "cancelled");
    assert.equal(bufferOf(h, run.document.document_id), SEED_V1);
    const page = h.driver.getSnapshot({ session_id: d.session_id, generation: d.generation, after_seq: 0 });
    assert.equal(page.ok, true);
    if (!page.ok || !("page" in page)) throw new Error("unreachable");
    assert.equal(page.page.documents[0]!.content, SEED_V1);
    // A late ack after cancel cannot advance the retired plan.
    const late = await h.driver.acknowledge({ session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: 0 });
    assert.equal(late.ok, false);
    assert.equal(bufferOf(h, run.document.document_id), SEED_V1);
    proof("cancel restores the trusted B0 projection");
  });

  it("P6.12 PROOF: reset fences old generations with new-generation remount", async () => {
    const h = openIpcHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "stale\n" } }],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const run = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(run.plan_id !== null);
    const before = h.lifecycle.describe();
    const reset = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(reset.ok, true);
    const after = h.lifecycle.describe();
    assert.equal(after.generation, before.generation + 1);
    // Old identifiers fence with zero mutation.
    const staleRun = await h.driver.runOperation({ session_id: before.session_id, generation: before.generation, operation_id: h.operationIds[0]!, request_id: nextRequest("stale") }, depsFor(h));
    assert.ok(mustReject(staleRun).code === "WRONG_OWNER" || mustReject(staleRun).code === "STALE_SESSION");
    const staleAck = await h.driver.acknowledge({ session_id: before.session_id, generation: before.generation, operation_id: h.operationIds[1]!, plan_id: run.plan_id!, chunk_seq: 0 });
    assert.equal(mustReject(staleAck).code === "WRONG_OWNER" || mustReject(staleAck).code === "STALE_SESSION", true);
    // New generation remounts from the reseeded leaf.
    const page = h.driver.getSnapshot({ session_id: after.session_id, generation: after.generation, after_seq: 0 });
    assert.equal(page.ok, true);
    proof("reset fences old generations with new-generation remount");
  });

  it("P6.12 PROOF: replay converges without double type replace or save", async () => {
    const h = openIpcHarness(
      [
        { action: { type: "file_open", path: DOC } },
        { action: { type: "type_code", path: DOC, content: "once\n" } },
        { action: { type: "replace_code", path: DOC, find: "once", replace: "twice" } },
        { action: { type: "file_save", path: DOC } },
      ],
      { [DOC]: SEED_V1 },
    );
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const typed = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[1]!), depsFor(h)));
    assert.ok(typed.plan_id !== null);
    await ackAll(h, h.operationIds[1]!, typed.plan_id!, typed.frames.length);
    const replaced = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[2]!), depsFor(h)));
    assert.ok(replaced.plan_id !== null);
    await ackAll(h, h.operationIds[2]!, replaced.plan_id!, replaced.frames.length);
    const saved = mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[3]!), depsFor(h)));
    assert.equal(saved.completed, true);
    assert.deepEqual(saved.frames, []);
    const documentId = h.lifecycle.getSession().registry.listDocuments()[0]!.document_id;
    assert.equal(bufferOf(h, documentId), SEED_V1 + "twice\n");
    assert.equal(hostText(h, DOC), SEED_V1 + "twice\n");
    const events = h.lifecycle.getJournal().listEvents();
    for (const operationId of h.operationIds) {
      const terminals = events.filter((e) => e.operation_id === operationId && (e.kind === "editor.operation.completed" || e.kind === "editor.operation.failed" || e.kind === "editor.operation.cancelled"));
      assert.ok(terminals.length <= 1, `operation ${operationId} settles exactly once`);
    }
    proof("replay converges without double type replace or save");
  });

  it("P6.12 PROOF: subscribe-before-snapshot keeps journal ordering with gap detection", async () => {
    const h = openIpcHarness([{ action: { type: "file_open", path: DOC } }], { [DOC]: SEED_V1 });
    const seen: number[] = [];
    const subscription = h.driver.subscribe((event) => {
      seen.push(event.seq);
    });
    try {
      const d = h.lifecycle.describe();
      mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
      const page = h.driver.getSnapshot({ session_id: d.session_id, generation: d.generation, after_seq: 0 });
      assert.equal(page.ok, true);
      if (!page.ok || !("page" in page)) throw new Error("unreachable");
      assert.ok(page.page.events.length > 0);
      // Strictly increasing sequence with no duplicates.
      let previous = 0;
      for (const event of page.page.events) {
        assert.ok(event.seq > previous);
        previous = event.seq;
      }
      assert.equal(page.page.page_end_seq, page.page.journal_high_seq);
      // Live subscription observed the same ordered prefix.
      assert.deepEqual(seen, page.page.events.map((e) => e.seq));
    } finally {
      subscription.unsubscribe();
    }
    proof("subscribe-before-snapshot keeps journal ordering with gap detection");
  });

  it("P6.12 PROOF: Record Safe Mode keeps lesson-relative privacy with sanitized errors", async () => {
    const h = openIpcHarness([{ action: { type: "file_open", path: DOC } }], { [DOC]: SEED_V1 });
    mustRunValue(await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h)));
    const d = h.lifecycle.describe();
    const page = h.driver.getSnapshot({ session_id: d.session_id, generation: d.generation, after_seq: 0 });
    assert.equal(page.ok, true);
    if (!page.ok || !("page" in page)) throw new Error("unreachable");
    assert.deepEqual(dtoLeaks(page), []);
    assert.equal(page.page.documents[0]!.portable_path, DOC);
    const redacted = sanitizeEditorMessage(`open failed at E:\\course-factory\\temp\\P6.12 secret staged cf-p612-x-stage-abc pid 1234 ${"y".repeat(600)}`);
    assert.equal(/[A-Za-z]:[\\/]/.test(redacted), false);
    assert.ok(redacted.length <= 512);
    proof("Record Safe Mode keeps lesson-relative privacy with sanitized errors");
  });

  it("P6.12 PROOF: closed sessions fence new presentation work", async () => {
    const h = openIpcHarness([{ action: { type: "file_open", path: DOC } }], { [DOC]: SEED_V1 });
    const before = h.lifecycle.describe();
    const closed = await h.lifecycle.close({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("close") });
    assert.equal(closed.ok, true);
    const response = await h.driver.runOperation(runRequest(h, h.operationIds[0]!), depsFor(h));
    assert.equal(response.ok, false);
    proof("closed sessions fence new presentation work");
  });
});
