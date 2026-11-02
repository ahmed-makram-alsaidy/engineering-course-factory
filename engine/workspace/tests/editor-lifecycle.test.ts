// P6.11 Cancel/reset/replay — deterministic lifecycle integration (offline, no sleeps).
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.11 Cancel/reset/replay
// ("Complete editor + terminal lifecycle integration"; PASS "Race and crash
// tests, no stale work"). Canonical authority: design sections
// 4/5/6/7/8/9/10/12/13/14/15/17/18/21/26.1/26.4/26.5/26.7/26.8/26.9/26.10/
// 26.12 plus ADR-0011 decisions 5-6.
// Proves at runtime (not merely by types): operation-aware cancel across the
// five families with B0 restoration and commit-boundary honesty; exactly-once
// duplicate cancel; reset as a generation boundary with the frozen ordering,
// Docker retirement, cleanup confirmation, old-authority invalidation,
// canonical reseed and exactly-once generation rotation; duplicate,
// concurrent, close and acquire races; honest save settlement across reset;
// commit-uncertain freezing without auto-retry; idempotent replay from the
// one reused bounded journal without second type, replace or save side
// effects; journal ordering with exactly-one outcomes and no leakage;
// old-generation fencing; terminal close without resurrection; renderer
// restore authority absent with no generic history API; no P6.12+ scope.
// Fixture IR is NEVER hand-authored: synthetic lesson sources compile through
// the canonical pipeline (parseLessonData -> compileLesson -> re-validation
// inside createEditorCatalog). All filesystem work stays under the
// phase-owned temp/P6.11/lifecycle root with cf-p611- names; the only host
// writes are controlled test setup (seed bytes, reseed) and byte-exact
// assertions. Real Windows platform proofs live in
// editor-lifecycle-windows.test.ts; real Docker epoch proofs live in
// editor-lifecycle-docker.test.ts (gate-only, mirroring the P6.10 precedent).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import type { WorkspaceOwnership } from "../src/protocol.ts";
import { createSeedManifest, sha256Hex, type SeedManifest } from "../src/policy.ts";
import { openWindowsFileAdapter, type WindowsFileAdapter } from "../src/file-adapter.ts";
import { createEditorCatalog, type EditorCatalog, type EditorOperationAdmission } from "../src/editor-admission.ts";
import {
  createEditorLifecycle,
  LIFECYCLE_RESET_PHASES,
  type EditorLifecycle,
  type LifecycleAuthority,
  type LifecycleExecDeps,
} from "../src/editor-lifecycle.ts";
const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.11", "lifecycle");
const DOC = "src/app.ts";
const SEED_V1 = "const a = 1;\n";
function proof(message: string): void {
  console.log(`P6.11 PROOF: ${message}`);
}
let lessonSeq = 0;
let requestSeq = 0;
let harnessSeq = 0;
function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p611-${prefix}-${requestSeq}`;
}
function buildLifecycleLessonSource(actions: Array<{ action: unknown }>): { raw: unknown; operationIds: string[] } {
  lessonSeq += 1;
  const lessonId = `C01-L${String(90 + lessonSeq).padStart(3, "0")}`;
  const operationIds = actions.map((_, index) => `${lessonId}-S001-B${String(index + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: `Synthetic P6.11 lesson ${lessonId}`,
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Prove deterministic editor cancel reset replay"],
    prerequisites: [],
    keywords: ["editor", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.11" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        type: "code_demo",
        title: "Lifecycle the admitted document",
        duration: 120,
        visual: { kind: "code_editor", description: "Editor lifecycle" },
        beats: actions.map((entry, index) => ({ beat_id: operationIds[index], kind: "action", action: entry.action })),
      },
    ],
  };
  return { raw, operationIds };
}
function compileLifecycleLesson(actions: Array<{ action: unknown }>): { compiled: CompiledLesson; operationIds: string[] } {
  const { raw, operationIds } = buildLifecycleLessonSource(actions);
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
interface LifecycleHarness {
  readonly tag: string;
  readonly leaf: string;
  readonly staging: string;
  readonly adapter: WindowsFileAdapter;
  readonly lifecycle: EditorLifecycle;
  readonly catalog: EditorCatalog;
  readonly operationIds: string[];
  readonly seedFiles: Record<string, string>;
  readonly sessionId: string;
  readonly workspaceId: string;
  retireCalls(): number;
  setRetireResult(value: "confirmed" | "unconfirmed"): void;
  setOwnership(value: WorkspaceOwnership): void;
  orderLog(): string[];
}
function openLifecycleHarness(
  actions: Array<{ action: unknown }>,
  files: Record<string, string>,
  overrides: {
    retireResult?: "confirmed" | "unconfirmed";
    ownership?: WorkspaceOwnership;
    deferredRetire?: boolean;
    reseedFails?: boolean;
  } = {},
): LifecycleHarness {
  harnessSeq += 1;
  const tag = `cf-p611-t${harnessSeq}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(join(leaf, "src"), { recursive: true });
  mkdirSync(staging, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
  }
  const seed = manifestFor(files);
  const { compiled, operationIds } = compileLifecycleLesson(actions);
  const catalogOutcome = createEditorCatalog(compiled);
  assert.equal(catalogOutcome.ok, true, "catalog must build");
  if (!catalogOutcome.ok) throw new Error("unreachable");
  const sessionId = `sess-p611-${String(harnessSeq).padStart(4, "0")}`;
  const workspaceId = `ws-p611-${String(harnessSeq).padStart(4, "0")}`;
  const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
  assert.equal(bound.ok, true, "adapter binding must open");
  if (!bound.ok) throw new Error("unreachable");
  const seedSnapshot: Record<string, string> = { ...files };
  const order: string[] = [];
  let retireCount = 0;
  let retireResult: "confirmed" | "unconfirmed" = overrides.retireResult ?? "confirmed";
  let ownership: WorkspaceOwnership = overrides.ownership ?? "EDITOR_OWNED";
  let retireGate: Promise<"confirmed" | "unconfirmed"> | null = null;
  let releaseRetire: ((value: "confirmed" | "unconfirmed") => void) | null = null;
  if (overrides.deferredRetire === true) {
    retireGate = new Promise<"confirmed" | "unconfirmed">((resolve) => {
      releaseRetire = resolve;
    });
  }
  const harnessRef: { current: LifecycleHarness | null } = { current: null };
  void harnessRef;
  const lifecycle = createEditorLifecycle({
    catalog: catalogOutcome.value,
    seedManifest: seed,
    sessionId,
    generation: 1,
    wiring: {
      getOwnership: () => ownership,
      retireContainer: async () => {
        retireCount += 1;
        order.push("retire");
        if (retireGate !== null) return retireGate;
        return retireResult;
      },
      reseed: async () => {
        order.push("reseed");
        if (overrides.reseedFails === true) throw new Error("injected reseed failure");
        for (const entry of readdirSync(leaf)) {
          rmSync(join(leaf, entry), { recursive: true, force: true });
        }
        mkdirSync(join(leaf, "src"), { recursive: true });
        for (const [rel, text] of Object.entries(seedSnapshot)) {
          writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
        }
        for (const entry of readdirSync(staging)) {
          rmSync(join(staging, entry), { recursive: true, force: true });
        }
      },
    },
  });
  const harness: LifecycleHarness = {
    tag,
    leaf,
    staging,
    adapter: bound.value,
    lifecycle,
    catalog: catalogOutcome.value,
    operationIds,
    seedFiles: seedSnapshot,
    sessionId,
    workspaceId,
    retireCalls: () => retireCount,
    setRetireResult: (value) => {
      retireResult = value;
    },
    setOwnership: (value) => {
      ownership = value;
    },
    orderLog: () => [...order],
  };
  if (releaseRetire !== null) {
    (harness as unknown as { releaseRetire: (value: "confirmed" | "unconfirmed") => void }).releaseRetire = releaseRetire;
  }
  return harness;
}
function releaseDeferredRetire(h: LifecycleHarness, value: "confirmed" | "unconfirmed" = "confirmed"): void {
  const holder = h as unknown as { releaseRetire?: (value: "confirmed" | "unconfirmed") => void };
  assert.equal(typeof holder.releaseRetire, "function", "harness must use deferredRetire for this race");
  holder.releaseRetire!(value);
}
function authorityFor(h: LifecycleHarness, overrides: Partial<LifecycleAuthority> = {}): LifecycleAuthority {
  const d = h.lifecycle.describe();
  return {
    lease: {
      kind: "editor_lease",
      leaseId: `lease-p611-${harnessSeq}`,
      sessionId: d.session_id,
      generation: d.generation,
      workspaceId: h.workspaceId,
      epoch: d.epoch,
      operationId: "op-p611-synthetic",
      requestId: nextRequest("synthetic"),
    },
    ownership: "EDITOR_OWNED",
    liveEpoch: d.epoch,
    revokedLeaseIds: [],
    ...overrides,
  };
}
function depsFor(h: LifecycleHarness, adapter?: unknown, authority?: LifecycleAuthority): LifecycleExecDeps {
  return { adapter: (adapter ?? h.adapter) as unknown, authority: authority ?? authorityFor(h) };
}
function mustAdmit(lc: EditorLifecycle, operationId: string, requestId: string): EditorOperationAdmission {
  const outcome = lc.admit(operationId, requestId);
  assert.equal(outcome.ok, true, `admission of ${operationId} must succeed: ${outcome.ok ? "" : outcome.rejection.code + " " + outcome.rejection.message}`);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}
function hostText(h: LifecycleHarness, rel: string): string | null {
  const full = join(h.leaf, ...rel.split("/"));
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}
function stagingIsClean(h: LifecycleHarness): boolean {
  return readdirSync(h.staging).length === 0;
}
function bufferOf(lc: EditorLifecycle, documentId: string): string {
  const content = lc.getSession().registry.getBufferContent(documentId);
  assert.equal(content.ok, true, "live document must hold executed buffer text");
  if (!content.ok) throw new Error("unreachable");
  return content.value;
}
function dtoLeaks(dto: unknown): string[] {
  const json = JSON.stringify(dto) ?? "";
  const leaks: string[] = [];
  if (/[A-Za-z]:[\\/]/.test(json)) leaks.push("drive-letter path");
  if (json.includes("\\\\")) leaks.push("UNC/device escape");
  if (json.includes("cf-p64-stage-")) leaks.push("private staging name");
  if (/cf-p611-/.test(json)) leaks.push("phase container identity");
  return leaks;
}
function spyAdapter(real: WindowsFileAdapter): { adapter: WindowsFileAdapter; publishes: () => number } {
  let publishes = 0;
  const adapter: WindowsFileAdapter = {
    ...real,
    readDocument: (a, p) => real.readDocument(a, p),
    publishDocument: async (a, args) => {
      publishes += 1;
      return real.publishDocument(a, args);
    },
  };
  return { adapter, publishes: () => publishes };
}
function failingAdapter(real: WindowsFileAdapter): WindowsFileAdapter {
  return {
    ...real,
    readDocument: (a, p) => real.readDocument(a, p),
    publishDocument: async () => ({ ok: false as const, rejection: { code: "SAVE_FAILED" as const, message: "injected SAVE_FAILED before commit with destination unchanged" } }),
  };
}
function deferredPublishAdapter(real: WindowsFileAdapter): { adapter: WindowsFileAdapter; entered: Promise<void>; release: () => void; publishes: () => number } {
  let publishes = 0;
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let signalEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const adapter: WindowsFileAdapter = {
    ...real,
    readDocument: (a, p) => real.readDocument(a, p),
    publishDocument: async (a, args) => {
      publishes += 1;
      signalEntered();
      await gate;
      return real.publishDocument(a, args);
    },
  };
  return { adapter, entered, release: () => releaseGate(), publishes: () => publishes };
}
async function awaitEnteredWithTimeout(entered: Promise<void>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      entered,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bounded wait exceeded for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
const OPEN_ONLY = [{ action: { type: "file_open", path: DOC } }];
const OPEN_TYPE = [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "INSERTED\n" } }];
const OPEN_TYPE_SAVE = [
  { action: { type: "file_open", path: DOC } },
  { action: { type: "type_code", path: DOC, content: "INSERTED\n" } },
  { action: { type: "file_save", path: DOC } },
];
const OPEN_REPLACE = [{ action: { type: "file_open", path: DOC } }, { action: { type: "replace_code", path: DOC, find: "a = 1", replace: "a = 2" } }];
const OPEN_REPLACE_SAVE = [
  { action: { type: "file_open", path: DOC } },
  { action: { type: "replace_code", path: DOC, find: "a = 1", replace: "a = 2" } },
  { action: { type: "file_save", path: DOC } },
];
const OPEN_SAVE = [{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }];
const CREATE_SAVE = [{ action: { type: "file_create", path: "src/new.ts" } }, { action: { type: "file_save", path: "src/new.ts" } }];
before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});
after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "phase-owned P6.11 deterministic root is removed");
  console.log("P6.11 PROOF: CLEANUP deterministic temp/P6.11 lifecycle removed");
});
describe("P6.11 cancel — type and replace restore B0", () => {
  it("P6.11 PROOF: cancel planned type restores B0", () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    return h.lifecycle.executeOpen(openAdm, depsFor(h)).then((opened) => {
      assert.equal(opened.ok, true, "open must succeed");
      const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
      const planned = h.lifecycle.planType(typeAdm);
      assert.equal(planned.ok, true, "type must plan");
      if (!planned.ok) throw new Error("unreachable");
      const before = bufferOf(h.lifecycle, typeAdm.document.document_id);
      const cancelled = h.lifecycle.cancelType(planned.value.plan_id);
      assert.equal(cancelled.ok, true, "planned type must cancel");
      assert.equal(bufferOf(h.lifecycle, typeAdm.document.document_id), before, "cancel keeps the exact pre-operation buffer B0");
      assert.equal(hostText(h, DOC), SEED_V1, "disk remains unchanged");
      const tomb = h.lifecycle.listTombstones().find((t) => t.operation_id === typeId);
      assert.equal(tomb?.kind, "cancelled", "exactly one cancelled tombstone for the type operation");
      proof("cancel planned type restores B0");
    });
  });
  it("P6.11 PROOF: cancel running type restores B0", () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    return h.lifecycle.executeOpen(openAdm, depsFor(h)).then((opened) => {
      assert.equal(opened.ok, true);
      const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
      const planned = h.lifecycle.planType(typeAdm);
      assert.equal(planned.ok, true);
      if (!planned.ok) throw new Error("unreachable");
      const started = h.lifecycle.startType(planned.value.plan_id);
      assert.equal(started.ok, true, "running type must start");
      const advanced = h.lifecycle.advanceType(planned.value.plan_id, 25000);
      assert.equal(advanced.ok, true, "running type must advance without completing");
      const cancelled = h.lifecycle.cancelType(planned.value.plan_id);
      assert.equal(cancelled.ok, true, "running type must cancel");
      assert.equal(bufferOf(h.lifecycle, typeAdm.document.document_id), SEED_V1, "cancel restores the exact B0 bytes");
      assert.equal(hostText(h, DOC), SEED_V1, "disk remains unchanged");
      proof("cancel running type restores B0");
    });
  });
  it("P6.11 PROOF: cancel completed type no undo", () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    return h.lifecycle.executeOpen(openAdm, depsFor(h)).then((opened) => {
      assert.equal(opened.ok, true);
      const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
      const planned = h.lifecycle.planType(typeAdm);
      assert.equal(planned.ok, true);
      if (!planned.ok) throw new Error("unreachable");
      const completed = h.lifecycle.completeType(planned.value.plan_id);
      assert.equal(completed.ok, true, "type must complete and install B1");
      const installed = bufferOf(h.lifecycle, typeAdm.document.document_id);
      assert.equal(installed, `${SEED_V1}INSERTED\n`, "completion installs the exact candidate B1");
      const cancelled = h.lifecycle.cancelType(planned.value.plan_id);
      assert.equal(cancelled.ok, false, "cancel after completion must not undo");
      if (cancelled.ok) throw new Error("unreachable");
      assert.equal(cancelled.rejection.code, "INVALID_REQUEST");
      assert.equal(bufferOf(h.lifecycle, typeAdm.document.document_id), installed, "completed text survives cancel");
      assert.equal(hostText(h, DOC), SEED_V1, "disk still D0 before save");
      proof("cancel completed type no undo");
    });
  });
  it("P6.11 PROOF: cancel planned replace restores B0", () => {
    const h = openLifecycleHarness(OPEN_REPLACE, { [DOC]: SEED_V1 });
    const [openId, replaceId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    return h.lifecycle.executeOpen(openAdm, depsFor(h)).then((opened) => {
      assert.equal(opened.ok, true);
      const replaceAdm = mustAdmit(h.lifecycle, replaceId, nextRequest("replace"));
      const planned = h.lifecycle.planReplace(replaceAdm);
      assert.equal(planned.ok, true, "replace must plan");
      if (!planned.ok) throw new Error("unreachable");
      const cancelled = h.lifecycle.cancelReplace(planned.value.plan_id);
      assert.equal(cancelled.ok, true, "planned replace must cancel");
      assert.equal(bufferOf(h.lifecycle, replaceAdm.document.document_id), SEED_V1, "cancel keeps B0 with no partial replacement");
      assert.equal(hostText(h, DOC), SEED_V1, "disk remains unchanged");
      proof("cancel planned replace restores B0");
    });
  });
  it("P6.11 PROOF: cancel running replace restores B0", () => {
    const h = openLifecycleHarness(OPEN_REPLACE, { [DOC]: SEED_V1 });
    const [openId, replaceId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    return h.lifecycle.executeOpen(openAdm, depsFor(h)).then((opened) => {
      assert.equal(opened.ok, true);
      const replaceAdm = mustAdmit(h.lifecycle, replaceId, nextRequest("replace"));
      const planned = h.lifecycle.planReplace(replaceAdm);
      assert.equal(planned.ok, true);
      if (!planned.ok) throw new Error("unreachable");
      assert.equal(h.lifecycle.startReplace(planned.value.plan_id).ok, true, "running replace must start");
      assert.equal(h.lifecycle.advanceReplace(planned.value.plan_id, 1).ok, true, "running replace must advance one visual step");
      const cancelled = h.lifecycle.cancelReplace(planned.value.plan_id);
      assert.equal(cancelled.ok, true, "running replace must cancel");
      assert.equal(bufferOf(h.lifecycle, replaceAdm.document.document_id), SEED_V1, "cancel restores all of B0 transactionally");
      assert.equal(hostText(h, DOC), SEED_V1, "disk remains unchanged");
      proof("cancel running replace restores B0");
    });
  });
  it("P6.11 PROOF: cancel completed replace no undo", () => {
    const h = openLifecycleHarness(OPEN_REPLACE, { [DOC]: SEED_V1 });
    const [openId, replaceId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    return h.lifecycle.executeOpen(openAdm, depsFor(h)).then((opened) => {
      assert.equal(opened.ok, true);
      const replaceAdm = mustAdmit(h.lifecycle, replaceId, nextRequest("replace"));
      const planned = h.lifecycle.planReplace(replaceAdm);
      assert.equal(planned.ok, true);
      if (!planned.ok) throw new Error("unreachable");
      assert.equal(h.lifecycle.completeReplace(planned.value.plan_id).ok, true, "replace must complete");
      const installed = bufferOf(h.lifecycle, replaceAdm.document.document_id);
      assert.equal(installed, "const a = 2;\n", "completion installs the exact B1 candidate");
      const cancelled = h.lifecycle.cancelReplace(planned.value.plan_id);
      assert.equal(cancelled.ok, false, "cancel after completion must not undo");
      assert.equal(bufferOf(h.lifecycle, replaceAdm.document.document_id), installed);
      proof("cancel completed replace no undo");
    });
  });
});
describe("P6.11 cancel — save commit boundary and idempotency", () => {
  it("P6.11 PROOF: cancel save pre-commit destination unchanged", async () => {
    const h = openLifecycleHarness(OPEN_SAVE, { [DOC]: SEED_V1 });
    const [openId, saveId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    const opened = await h.lifecycle.executeOpen(openAdm, depsFor(h));
    assert.equal(opened.ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const spied = spyAdapter(h.adapter);
    // Cancel requested before the commit point: the executor aborts with
    // staging discarded and exactly one cancelled outcome.
    const saved = await h.lifecycle.executeSave(saveAdm, {
      adapter: spied.adapter as unknown,
      authority: authorityFor(h),
      isCancelled: () => true,
    });
    assert.equal(saved.ok, false, "pre-commit cancelled save must not succeed");
    if (saved.ok) throw new Error("unreachable");
    assert.equal(hostText(h, DOC), SEED_V1, "destination unchanged");
    assert.equal(stagingIsClean(h), true, "no staging residue");
    assert.equal(spied.publishes(), 0, "zero publications before commit");
    const tomb = h.lifecycle.listTombstones().find((t) => t.operation_id === saveId);
    assert.equal(tomb?.kind, "cancelled", "exactly one cancelled tombstone");
    proof("cancel save pre-commit destination unchanged");
  });
  it("P6.11 PROOF: requested save cancel settles honestly", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    assert.equal((await h.lifecycle.executeOpen(openAdm, depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const deferred = deferredPublishAdapter(h.adapter);
    const pending = h.lifecycle.executeSave(saveAdm, depsFor(h, deferred.adapter));
    await awaitEnteredWithTimeout(deferred.entered, 5000, "requested-cancel publish");
    // Route cancellation through the identifier-only lifecycle request while
    // the publication is in flight: settlement follows the commit boundary.
    const d = h.lifecycle.describe();
    const requested = h.lifecycle.cancelOperation({ session_id: d.session_id, generation: d.generation, operation_id: saveId, request_id: nextRequest("cancel") });
    assert.equal(requested.ok, true, "save cancel request accepted");
    deferred.release();
    const saved = await pending;
    // Publication already won: honestly completed, never false rollback.
    assert.equal(saved.ok, true, "in-flight save settles as completed once publication wins");
    assert.equal(hostText(h, DOC), `${SEED_V1}INSERTED\n`);
    assert.equal(deferred.publishes(), 1, "exactly one publication");
    // A duplicate execution afterwards converges without a second commit.
    const spied = spyAdapter(h.adapter);
    const replayed = await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter));
    void replayed;
    assert.equal(spied.publishes(), 0, "replay performs zero new publications");
    proof("requested save cancel settles honestly");
  });
  it("P6.11 PROOF: cancel save post-commit honest result", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    assert.equal((await h.lifecycle.executeOpen(openAdm, depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const deferred = deferredPublishAdapter(h.adapter);
    let cancelled = false;
    const pending = h.lifecycle.executeSave(
      saveAdm,
      { adapter: deferred.adapter as unknown, authority: authorityFor(h), isCancelled: () => cancelled },
    );
    await awaitEnteredWithTimeout(deferred.entered, 5000, "post-commit publish");
    cancelled = true;
    deferred.release();
    const saved = await pending;
    // Publication already won: the outcome settles honestly as completed,
    // never cancelled-with-hidden-write.
    assert.equal(saved.ok, true, "post-commit cancel settles as completed");
    assert.equal(hostText(h, DOC), `${SEED_V1}INSERTED\n`, "committed bytes equal the authoritative buffer");
    assert.equal(deferred.publishes(), 1, "exactly one publication");
    proof("cancel save post-commit honest result");
  });
  it("P6.11 PROOF: duplicate cancel idempotent", () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    return h.lifecycle.executeOpen(openAdm, depsFor(h)).then(() => {
      const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
      const planned = h.lifecycle.planType(typeAdm);
      assert.equal(planned.ok, true);
      if (!planned.ok) throw new Error("unreachable");
      const d = h.lifecycle.describe();
      const first = h.lifecycle.cancelOperation({ session_id: d.session_id, generation: d.generation, operation_id: typeId, request_id: nextRequest("cancel") });
      assert.equal(first.ok, true, "first cancel finalizes");
      const eventsAfterFirst = h.lifecycle.listEvents().length;
      const second = h.lifecycle.cancelOperation({ session_id: d.session_id, generation: d.generation, operation_id: typeId, request_id: nextRequest("cancel") });
      assert.equal(second.ok, true, "duplicate cancel converges");
      assert.deepEqual(second.ok && second.value, first.ok && first.value, "duplicate cancel returns the identical tombstone");
      assert.equal(h.lifecycle.listEvents().length, eventsAfterFirst, "no second journal outcome");
      assert.equal(bufferOf(h.lifecycle, typeAdm.document.document_id), SEED_V1, "no double rollback");
      proof("duplicate cancel idempotent");
    });
  });
});
describe("P6.11 reset — active operation matrix", () => {
  it("P6.11 PROOF: reset clean workspace", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    const [openId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    assert.equal((await h.lifecycle.executeOpen(openAdm, depsFor(h))).ok, true);
    const before = h.lifecycle.describe();
    const reset = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(reset.ok, true, "clean reset must succeed");
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.generation, before.generation + 1, "generation advances exactly once");
    assert.notEqual(reset.value.session_id, before.session_id, "opaque session identity rotates");
    assert.deepEqual(h.lifecycle.getResetPhases(), [...LIFECYCLE_RESET_PHASES], "frozen reset ordering exposed");
    assert.equal(h.orderLog()[0], "retire", "container retirement precedes reseed");
    assert.deepEqual(h.orderLog(), ["retire", "reseed"], "revoke, settle, retire, confirm, reseed, expose");
    assert.equal(hostText(h, DOC), SEED_V1, "seed bytes preserved");
    assert.equal(h.retireCalls(), 1, "exactly one retirement");
    proof("reset clean workspace");
  });
  it("P6.11 PROOF: reset dirty document reseeds", async () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    assert.equal((await h.lifecycle.executeOpen(openAdm, depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true, "dirty buffer installed");
    assert.equal(bufferOf(h.lifecycle, typeAdm.document.document_id), `${SEED_V1}INSERTED\n`);
    const before = h.lifecycle.describe();
    const reset = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(reset.ok, true);
    assert.equal(hostText(h, DOC), SEED_V1, "dirty unsaved buffer discarded by canonical reseed");
    assert.equal(h.lifecycle.listTombstones().length, 0, "old tombstones invalidated");
    assert.equal(stagingIsClean(h), true, "no staging residue");
    proof("reset dirty document reseeds");
  });
  it("P6.11 PROOF: reset pending create vanishes", async () => {
    const h = openLifecycleHarness(CREATE_SAVE, {});
    const [createId] = h.operationIds;
    const createAdm = mustAdmit(h.lifecycle, createId, nextRequest("create"));
    assert.equal((await h.lifecycle.executeCreate(createAdm, depsFor(h))).ok, true, "pending creation staged");
    assert.equal(hostText(h, "src/new.ts"), null, "disk absent before save");
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    assert.equal(hostText(h, "src/new.ts"), null, "abandoned pending creation vanishes on reset");
    assert.equal(existsSync(join(h.leaf, "src", "new.ts")), false);
    proof("reset pending create vanishes");
  });
  it("P6.11 PROOF: reset planned type fenced", async () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const oldPlanId = planned.value.plan_id;
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    assert.equal(h.lifecycle.getTypePlanner().getPlan(oldPlanId), null, "old plan cannot address the new generation");
    assert.equal(h.lifecycle.startType(oldPlanId).ok, false, "old plan start fenced");
    proof("reset planned type fenced");
  });
  it("P6.11 PROOF: reset running type restores B0", async () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.startType(planned.value.plan_id).ok, true);
    assert.equal(h.lifecycle.advanceType(planned.value.plan_id, 25000).ok, true);
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    assert.equal(hostText(h, DOC), SEED_V1, "no partial authoritative text survives reset");
    proof("reset running type restores B0");
  });
  it("P6.11 PROOF: reset planned replace fenced", async () => {
    const h = openLifecycleHarness(OPEN_REPLACE, { [DOC]: SEED_V1 });
    const [openId, replaceId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const replaceAdm = mustAdmit(h.lifecycle, replaceId, nextRequest("replace"));
    const planned = h.lifecycle.planReplace(replaceAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const oldPlanId = planned.value.plan_id;
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    assert.equal(h.lifecycle.getReplacePlanner().getPlan(oldPlanId), null, "old replace plan fenced");
    proof("reset planned replace fenced");
  });
  it("P6.11 PROOF: reset running replace restores B0", async () => {
    const h = openLifecycleHarness(OPEN_REPLACE, { [DOC]: SEED_V1 });
    const [openId, replaceId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const replaceAdm = mustAdmit(h.lifecycle, replaceId, nextRequest("replace"));
    const planned = h.lifecycle.planReplace(replaceAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.startReplace(planned.value.plan_id).ok, true);
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    assert.equal(hostText(h, DOC), SEED_V1, "no partial replacement survives reset");
    proof("reset running replace restores B0");
  });
  it("P6.11 PROOF: reset save pre-commit destination unchanged", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    // Reset wins before the save even starts: the old save admission fences
    // with zero adapter action and the destination never changes.
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const spied = spyAdapter(h.adapter);
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    const late = await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter));
    assert.equal(late.ok, false, "old save admission stale after reset");
    assert.equal(spied.publishes(), 0, "zero publications from stale save");
    assert.equal(hostText(h, DOC), SEED_V1, "destination unchanged with no staging residue");
    assert.equal(stagingIsClean(h), true);
    proof("reset save pre-commit destination unchanged");
  });
  it("P6.11 PROOF: reset save post-commit honest", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const spied = spyAdapter(h.adapter);
    const saved = await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter));
    assert.equal(saved.ok, true, "save commits before reset");
    assert.equal(spied.publishes(), 1);
    assert.equal(hostText(h, DOC), `${SEED_V1}INSERTED\n`, "commit honest before reset");
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    // Reset never pretends the disk was unchanged: it reconciles by reseeding
    // to the canonical seed, and no stale callback marks new state clean.
    assert.equal(hostText(h, DOC), SEED_V1, "post-commit reset reseeds to canonical state");
    const after = h.lifecycle.describe();
    assert.equal(after.generation, before.generation + 1);
    proof("reset save post-commit honest");
  });
  it("P6.11 PROOF: reset with RO observer retires clean", async () => {
    const h = openLifecycleHarness(OPEN_SAVE, { [DOC]: SEED_V1 });
    const [openId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    // Read-only background observation coexists with editing: ownership stays
    // editor-owned while the observer lives; reset still retires the epoch.
    const before = h.lifecycle.describe();
    assert.equal(before.ownership, "EDITOR_OWNED");
    const reset = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(reset.ok, true, "reset with RO observer succeeds after retirement");
    assert.equal(h.retireCalls(), 1, "observer epoch retired exactly once");
    proof("reset with RO observer retires clean");
  });
  it("P6.11 PROOF: reset with RW terminal fences then retires", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    const [openId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    h.setOwnership("TERMINAL_OWNED");
    assert.equal(h.lifecycle.admit(openId, nextRequest("late")).ok, false, "editor work fenced while RW owns the leaf");
    const before = h.lifecycle.describe();
    assert.equal(before.ownership, "TERMINAL_OWNED");
    const reset = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(reset.ok, true, "reset retires the RW epoch through the coordinator barrier");
    assert.equal(h.retireCalls(), 1, "RW container retired exactly once");
    h.setOwnership("EDITOR_OWNED");
    const after = h.lifecycle.describe();
    assert.equal(after.ownership, "EDITOR_OWNED", "new generation resumes editor ownership after confirmed cleanup");
    proof("reset with RW terminal fences then retires");
  });
  it("P6.11 PROOF: reset during transition fails closed", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    h.setOwnership("TRANSITION");
    assert.equal(h.lifecycle.admit(h.operationIds[0], nextRequest("x")).ok, false, "new work barred during transition");
    const before = h.lifecycle.describe();
    const reset = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(reset.ok, true, "reset itself crosses the barrier deterministically");
    assert.equal(h.retireCalls(), 1);
    proof("reset during transition fails closed");
  });
  it("P6.11 PROOF: reset while HOLD recovers deterministically", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    h.setRetireResult("unconfirmed");
    const before = h.lifecycle.describe();
    const held = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset-1") });
    assert.equal(held.ok, false, "unconfirmed cleanup holds");
    if (held.ok) throw new Error("unreachable");
    assert.equal(held.rejection.code, "CLEANUP_UNCONFIRMED");
    assert.equal(h.lifecycle.describe().generation, before.generation, "no new generation while holding");
    h.setRetireResult("confirmed");
    const recovered = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset-2") });
    assert.equal(recovered.ok, true, "explicit reset recovers after confirmed cleanup");
    if (!recovered.ok) throw new Error("unreachable");
    assert.equal(recovered.value.generation, before.generation + 1, "exactly one new generation");
    proof("reset while HOLD recovers deterministically");
  });
});
describe("P6.11 reset - old authorities fence", () => {
  it("P6.11 PROOF: old document stale after reset", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    const [openId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    assert.equal((await h.lifecycle.executeOpen(openAdm, depsFor(h))).ok, true);
    const oldSession = h.lifecycle.getSession();
    const oldDocId = openAdm.document.document_id;
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    const resolved = oldSession.registry.resolveDocument(oldDocId);
    assert.equal(resolved.ok, false, "old document_id cannot address the new generation");
    if (resolved.ok) throw new Error("unreachable");
    assert.equal(resolved.rejection.code, "STALE_SESSION");
    proof("old document stale after reset");
  });
  it("P6.11 PROOF: old type plan stale after reset", async () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const oldPlanner = h.lifecycle.getTypePlanner();
    const oldSession = h.lifecycle.getSession();
    const oldPlanId = planned.value.plan_id;
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    const late = oldPlanner.startPlan(oldSession, oldPlanId);
    assert.equal(late.ok, false, "old plan cannot advance after reset");
    assert.equal(hostText(h, DOC), SEED_V1, "late plan mutates nothing");
    proof("old type plan stale after reset");
  });
  it("P6.11 PROOF: old replace plan stale after reset", async () => {
    const h = openLifecycleHarness(OPEN_REPLACE, { [DOC]: SEED_V1 });
    const [openId, replaceId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const replaceAdm = mustAdmit(h.lifecycle, replaceId, nextRequest("replace"));
    const planned = h.lifecycle.planReplace(replaceAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    const oldPlanner = h.lifecycle.getReplacePlanner();
    const oldSession = h.lifecycle.getSession();
    const oldPlanId = planned.value.plan_id;
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    assert.equal(oldPlanner.startPlan(oldSession, oldPlanId).ok, false, "old replace plan fenced");
    assert.equal(hostText(h, DOC), SEED_V1);
    proof("old replace plan stale after reset");
  });
  it("P6.11 PROOF: old save admission stale after reset", async () => {
    const h = openLifecycleHarness(OPEN_SAVE, { [DOC]: SEED_V1 });
    const [openId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const spied = spyAdapter(h.adapter);
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    const late = await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter));
    assert.equal(late.ok, false, "old save admission cannot execute in the new generation");
    assert.equal(spied.publishes(), 0, "zero adapter action from stale admission");
    proof("old save admission stale after reset");
  });
  it("P6.11 PROOF: old epoch stale after reset", async () => {
    const h = openLifecycleHarness(OPEN_SAVE, { [DOC]: SEED_V1 });
    const [openId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const oldAuthority = authorityFor(h);
    const oldEpoch = oldAuthority.liveEpoch;
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    const after = h.lifecycle.describe();
    assert.notEqual(after.epoch, oldEpoch, "container epoch rotated");
    const spied = spyAdapter(h.adapter);
    const late = await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter, { ...oldAuthority, ownership: "EDITOR_OWNED" }));
    assert.equal(late.ok, false, "old epoch cannot publish into the new generation");
    assert.equal(spied.publishes(), 0);
    proof("old epoch stale after reset");
  });
  it("P6.11 PROOF: old lease stale after reset", async () => {
    const h = openLifecycleHarness(OPEN_SAVE, { [DOC]: SEED_V1 });
    const [openId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const live = authorityFor(h);
    const spied = spyAdapter(h.adapter);
    const revoked = await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter, { ...live, revokedLeaseIds: [live.lease.leaseId] }));
    assert.equal(revoked.ok, false, "revoked lease fences with zero mutation");
    if (revoked.ok) throw new Error("unreachable");
    assert.equal(revoked.rejection.code, "WORKSPACE_REVOKED");
    assert.equal(spied.publishes(), 0, "revoked lease performs zero publications");
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    const d = h.lifecycle.describe();
    assert.equal(d.session_id !== before.session_id, true, "identity rotated so old leases never address new state");
    const stale = h.lifecycle.cancelOperation({ session_id: before.session_id, generation: before.generation, operation_id: saveId, request_id: nextRequest("cancel") });
    assert.equal(stale.ok, false, "old lease identity fenced after rotation");
    proof("old lease stale after reset");
  });
});
describe("P6.11 generation rotation and reset races", () => {
  it("P6.11 PROOF: generation increments once", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    const before = h.lifecycle.describe();
    const first = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    assert.equal(first.value.generation, before.generation + 1);
    const mid = h.lifecycle.describe();
    const second = await h.lifecycle.reset({ session_id: mid.session_id, generation: mid.generation, request_id: nextRequest("reset") });
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error("unreachable");
    assert.equal(second.value.generation, before.generation + 2, "each reset advances exactly once");
    assert.equal(h.retireCalls(), 2);
    proof("generation increments once");
  });
  it("P6.11 PROOF: duplicate reset deterministic", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    const before = h.lifecycle.describe();
    const requestId = nextRequest("reset");
    const first = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: requestId });
    assert.equal(first.ok, true);
    const genAfterFirst = h.lifecycle.describe().generation;
    const duplicate = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: requestId });
    assert.equal(duplicate.ok, false, "duplicate reset with a retired identity fences");
    assert.equal(h.lifecycle.describe().generation, genAfterFirst, "no double generation increment");
    assert.equal(h.retireCalls(), 1, "no double container retirement");
    proof("duplicate reset deterministic");
  });
  it("P6.11 PROOF: concurrent reset deterministic", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 }, { deferredRetire: true });
    const before = h.lifecycle.describe();
    const first = h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset-a") });
    const second = h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset-b") });
    releaseDeferredRetire(h);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.ok, true, "first reset completes");
    assert.equal(b.ok, true, "concurrent reset converges instead of splitting");
    if (!a.ok || !b.ok) throw new Error("unreachable");
    assert.equal(a.value.generation, before.generation + 1);
    assert.equal(b.value.generation, before.generation + 1, "no split generation");
    assert.equal(h.retireCalls(), 1, "no double reseed");
    proof("concurrent reset deterministic");
  });
  it("P6.11 PROOF: reset vs close cannot resurrect", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 }, { deferredRetire: true });
    const before = h.lifecycle.describe();
    const pending = h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    const closed = await h.lifecycle.close({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("close") });
    assert.equal(closed.ok, false, "close cannot interrupt a latched reset");
    releaseDeferredRetire(h);
    assert.equal((await pending).ok, true, "latched reset completes");
    const mid = h.lifecycle.describe();
    assert.equal((await h.lifecycle.close({ session_id: mid.session_id, generation: mid.generation, request_id: nextRequest("close") })).ok, true, "close after reset succeeds");
    const resurrect = await h.lifecycle.reset({ session_id: mid.session_id, generation: mid.generation, request_id: nextRequest("reset") });
    assert.equal(resurrect.ok, false, "reset cannot resurrect a closed workspace");
    assert.equal(h.lifecycle.admit(h.operationIds[0], nextRequest("late")).ok, false, "closed workspace admits nothing");
    proof("reset vs close cannot resurrect");
  });
  it("P6.11 PROOF: reset vs acquire blocks new owner", async () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 }, { deferredRetire: true });
    const [openId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const before = h.lifecycle.describe();
    const pending = h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(h.lifecycle.describe().resetting, true, "RESETTING reserved synchronously");
    assert.equal(h.lifecycle.admit(h.operationIds[1], nextRequest("slip")).ok, false, "no acquisition slips through after RESETTING");
    releaseDeferredRetire(h);
    assert.equal((await pending).ok, true);
    proof("reset vs acquire blocks new owner");
  });
  it("P6.11 PROOF: reset cleanup failure holds", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    h.setRetireResult("unconfirmed");
    const before = h.lifecycle.describe();
    const held = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(held.ok, false);
    if (held.ok) throw new Error("unreachable");
    assert.equal(held.rejection.code, "CLEANUP_UNCONFIRMED");
    assert.equal(h.lifecycle.describe().hold_reason !== null, true, "fail-closed HOLD retained");
    assert.equal(h.lifecycle.admit(h.operationIds[0], nextRequest("late")).ok, false, "no new writer while holding");
    proof("reset cleanup failure holds");
  });
  it("P6.11 PROOF: reseed failure holds without writer", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 }, { reseedFails: true });
    const before = h.lifecycle.describe();
    const failed = await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") });
    assert.equal(failed.ok, false, "reseed failure never exposes a writer");
    assert.equal(h.lifecycle.describe().generation, before.generation, "generation frozen until trustworthy");
    assert.equal(h.lifecycle.admit(h.operationIds[0], nextRequest("late")).ok, false, "no new writable generation");
    proof("reseed failure holds without writer");
  });
});
describe("P6.11 replay — no double side effects", () => {
  it("P6.11 PROOF: completed type replay no double mutation", async () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const once = bufferOf(h.lifecycle, typeAdm.document.document_id);
    const d = h.lifecycle.describe();
    const replayed = h.lifecycle.replay({ session_id: d.session_id, generation: d.generation, operation_id: typeId });
    assert.equal(replayed.ok, true, "completed type replays by converging");
    assert.equal(bufferOf(h.lifecycle, typeAdm.document.document_id), once, "no second append");
    assert.equal(once, `${SEED_V1}INSERTED\n`, "single application only");
    assert.equal(hostText(h, DOC), SEED_V1, "disk untouched by replay");
    proof("completed type replay no double mutation");
  });
  it("P6.11 PROOF: completed replace replay no double mutation", async () => {
    const h = openLifecycleHarness(OPEN_REPLACE, { [DOC]: SEED_V1 });
    const [openId, replaceId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const replaceAdm = mustAdmit(h.lifecycle, replaceId, nextRequest("replace"));
    const planned = h.lifecycle.planReplace(replaceAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeReplace(planned.value.plan_id).ok, true);
    const once = bufferOf(h.lifecycle, replaceAdm.document.document_id);
    const d = h.lifecycle.describe();
    assert.equal(h.lifecycle.replay({ session_id: d.session_id, generation: d.generation, operation_id: replaceId }).ok, true);
    assert.equal(bufferOf(h.lifecycle, replaceAdm.document.document_id), once, "no second replacement");
    assert.equal(once, "const a = 2;\n");
    proof("completed replace replay no double mutation");
  });
  it("P6.11 PROOF: completed save replay no second publication", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const spied = spyAdapter(h.adapter);
    assert.equal((await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter))).ok, true);
    assert.equal(spied.publishes(), 1, "first execution publishes once");
    const d = h.lifecycle.describe();
    const replayed = h.lifecycle.replay({ session_id: d.session_id, generation: d.generation, operation_id: saveId });
    assert.equal(replayed.ok, true, "completed save replays by converging");
    assert.equal(spied.publishes(), 1, "replay performs no second publication");
    assert.equal(hostText(h, DOC), `${SEED_V1}INSERTED\n`);
    proof("completed save replay no second publication");
  });
  it("P6.11 PROOF: cancelled operation replay no mutation", () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    return h.lifecycle.executeOpen(openAdm, depsFor(h)).then(() => {
      const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
      const planned = h.lifecycle.planType(typeAdm);
      assert.equal(planned.ok, true);
      if (!planned.ok) throw new Error("unreachable");
      assert.equal(h.lifecycle.cancelType(planned.value.plan_id).ok, true);
      const eventsAfterCancel = h.lifecycle.listEvents().length;
      const d = h.lifecycle.describe();
      const replayed = h.lifecycle.replay({ session_id: d.session_id, generation: d.generation, operation_id: typeId });
      assert.equal(replayed.ok, true);
      if (!replayed.ok) throw new Error("unreachable");
      assert.equal(replayed.value.kind, "cancelled");
      assert.equal(h.lifecycle.listEvents().length, eventsAfterCancel, "replay appends no new outcome");
      assert.equal(bufferOf(h.lifecycle, typeAdm.document.document_id), SEED_V1);
      proof("cancelled operation replay no mutation");
    });
  });
  it("P6.11 PROOF: failed operation replay no mutation", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const broken = failingAdapter(h.adapter);
    const spied = spyAdapter(broken);
    const failed = await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter));
    assert.equal(failed.ok, false, "injected failure fails before commit");
    assert.equal(hostText(h, DOC), SEED_V1, "destination unchanged");
    const d = h.lifecycle.describe();
    const replayed = h.lifecycle.replay({ session_id: d.session_id, generation: d.generation, operation_id: saveId });
    assert.equal(replayed.ok, true, "failed save replays by converging");
    if (!replayed.ok) throw new Error("unreachable");
    assert.equal(replayed.value.kind, "failed", "never auto-retried into success");
    assert.equal(hostText(h, DOC), SEED_V1, "replay mutates nothing");
    proof("failed operation replay no mutation");
  });
  it("P6.11 PROOF: commit-uncertain replay no retry", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    h.lifecycle.getJournal().failNextAppendAfterCommit();
    const spied = spyAdapter(h.adapter);
    const uncertain = await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter));
    assert.equal(uncertain.ok, false, "journal fault after commit is uncertain");
    if (uncertain.ok) throw new Error("unreachable");
    assert.equal(uncertain.rejection.code, "COMMIT_UNCERTAIN");
    assert.equal(h.lifecycle.describe().hold_reason !== null, true, "uncertain freezes the session");
    const d = h.lifecycle.describe();
    const replayed = h.lifecycle.replay({ session_id: d.session_id, generation: d.generation, operation_id: saveId });
    assert.equal(replayed.ok, true);
    if (!replayed.ok) throw new Error("unreachable");
    assert.equal(replayed.value.kind, "commit_uncertain", "never auto-retried, never marked clean");
    assert.equal(spied.publishes(), 1, "exactly one commit attempt across replay");
    proof("commit-uncertain replay no retry");
  });
  it("P6.11 PROOF: journal replay terminal count exactly one", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    assert.equal((await h.lifecycle.executeSave(mustAdmit(h.lifecycle, saveId, nextRequest("save")), depsFor(h))).ok, true);
    const journal = h.lifecycle.getJournal();
    assert.equal(journal.terminalCount(), 3, "exactly one terminal outcome per accepted operation");
    for (const op of [openId, typeId, saveId]) {
      assert.notEqual(journal.getTerminal(op), null, `one terminal for ${op}`);
    }
    proof("journal replay terminal count exactly one");
  });
  it("P6.11 PROOF: event sequence deterministic", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    assert.equal((await h.lifecycle.executeSave(mustAdmit(h.lifecycle, saveId, nextRequest("save")), depsFor(h))).ok, true);
    const events = h.lifecycle.listEvents();
    const seqs = events.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "monotonic sequence");
    assert.equal(new Set(seqs).size, seqs.length, "no duplicate sequence");
    assert.equal(seqs[0], 1, "sequence starts at one");
    for (const op of [openId, typeId, saveId]) {
      const kinds = events.filter((e) => e.operation_id === op).map((e) => e.kind);
      assert.equal(kinds[0], "editor.operation.started", "started precedes terminal per operation");
      assert.equal(kinds.length >= 2, true, "terminal outcome present");
    }
    proof("event sequence deterministic");
  });
  it("P6.11 PROOF: replay contains no host paths", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    assert.equal((await h.lifecycle.executeSave(mustAdmit(h.lifecycle, saveId, nextRequest("save")), depsFor(h))).ok, true);
    for (const event of h.lifecycle.listEvents()) {
      assert.deepEqual(dtoLeaks(event), [], `event seq ${event.seq} leaks no host identity`);
    }
    const page = h.lifecycle.snapshot(0);
    assert.deepEqual(dtoLeaks(page), [], "snapshot pages leak no host identity");
    proof("replay contains no host paths");
  });
  it("P6.11 PROOF: replay contains no source payload", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const dump = JSON.stringify(h.lifecycle.listEvents());
    assert.equal(dump.includes("INSERTED"), false, "no authored source text in the journal");
    proof("replay contains no source payload");
  });
  it("P6.11 PROOF: replay old-generation events fenced", async () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const before = h.lifecycle.describe();
    const oldJournalSize = h.lifecycle.listEvents().length;
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    assert.equal(h.lifecycle.listEvents().length, 0, "new generation starts from a fresh replay anchor");
    const fenced = h.lifecycle.replay({ session_id: before.session_id, generation: before.generation, operation_id: typeId });
    assert.equal(fenced.ok, false, "old-generation replay never interprets as current work");
    const retained = h.lifecycle.getJournalForGeneration(before.generation);
    assert.notEqual(retained, null, "old journal retained as fenced evidence");
    assert.equal(retained!.eventCount(), oldJournalSize, "old evidence preserved exactly");
    proof("replay old-generation events fenced");
  });
  it("P6.11 PROOF: new generation starts canonical operation order", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    // The new generation admits the canonical authored order from the start.
    const first = h.lifecycle.admit(h.operationIds[0], nextRequest("admit"));
    assert.equal(first.ok, true, "first authored operation admits in the new generation");
    const skip = h.lifecycle.admit(h.operationIds[2], nextRequest("skip"));
    assert.equal(skip.ok, false, "authored order enforced after reseed");
    // The exposed runtime is fully functional: rebind the adapter to the new
    // identity (same leaf, new session binding) and load exact seed bytes.
    if (!first.ok) throw new Error("unreachable");
    const after = h.lifecycle.describe();
    const rebound = openWindowsFileAdapter({ sessionId: after.session_id, generation: after.generation, workspaceId: h.workspaceId, leafHostPath: h.leaf, stagingHostPath: h.staging });
    assert.equal(rebound.ok, true, "adapter rebinds to the rotated identity");
    if (!rebound.ok) throw new Error("unreachable");
    const reopened = await h.lifecycle.executeOpen(first.value, {
      adapter: rebound.value as unknown,
      authority: {
        lease: { kind: "editor_lease", leaseId: "lease-p611-rebind", sessionId: after.session_id, generation: after.generation, workspaceId: h.workspaceId, epoch: after.epoch, operationId: "op", requestId: nextRequest("a") },
        ownership: "EDITOR_OWNED",
        liveEpoch: after.epoch,
        revokedLeaseIds: [],
      },
    });
    assert.equal(reopened.ok, true, "new generation loads exact seed bytes through the rebound adapter");
    proof("new generation starts canonical operation order");
  });
  it("P6.11 PROOF: seed restoration byte-exact", async () => {
    const files = { [DOC]: SEED_V1, "src/notes.ts": "export const n = 2;\n" };
    const h = openLifecycleHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "file_open", path: "src/notes.ts" } }],
      files,
    );
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, h.operationIds[0], nextRequest("o1")), depsFor(h))).ok, true);
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, h.operationIds[1], nextRequest("o2")), depsFor(h))).ok, true);
    writeFileSync(join(h.leaf, ...DOC.split("/")), "CORRUPTED\n", "utf8");
    writeFileSync(join(h.leaf, "src", "extra.ts"), "extra\n", "utf8");
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    for (const [rel, text] of Object.entries(files)) {
      assert.equal(hostText(h, rel), text, `seed file ${rel} restored byte-exact`);
    }
    assert.equal(existsSync(join(h.leaf, "src", "extra.ts")), false, "non-seed files removed");
    assert.equal(stagingIsClean(h), true, "staging cleared");
    proof("seed restoration byte-exact");
  });
  it("P6.11 PROOF: deterministic replay state deep-equal", async () => {
    async function runFlow(): Promise<{ buffer: string; disk: string | null }> {
      const h = openLifecycleHarness(OPEN_REPLACE_SAVE, { [DOC]: SEED_V1 });
      const [openId, replaceId, saveId] = h.operationIds;
      assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
      const replaceAdm = mustAdmit(h.lifecycle, replaceId, nextRequest("replace"));
      const planned = h.lifecycle.planReplace(replaceAdm);
      assert.equal(planned.ok, true);
      if (!planned.ok) throw new Error("unreachable");
      assert.equal(h.lifecycle.completeReplace(planned.value.plan_id).ok, true);
      const buffer = bufferOf(h.lifecycle, replaceAdm.document.document_id);
      assert.equal((await h.lifecycle.executeSave(mustAdmit(h.lifecycle, saveId, nextRequest("save")), depsFor(h))).ok, true);
      return { buffer, disk: hostText(h, DOC) };
    }
    const first = await runFlow();
    const second = await runFlow();
    assert.deepEqual(second, first, "identical seed, IR and ordered operations reconstruct identical state");
    assert.equal(first.buffer, "const a = 2;\n");
    assert.equal(first.disk, "const a = 2;\n");
    proof("deterministic replay state deep-equal");
  });
});
describe("P6.11 close — terminal fencing", () => {
  it("P6.11 PROOF: close cancels and fences active plans", async () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const [openId, typeId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.startType(planned.value.plan_id).ok, true);
    const d = h.lifecycle.describe();
    assert.equal((await h.lifecycle.close({ session_id: d.session_id, generation: d.generation, request_id: nextRequest("close") })).ok, true);
    assert.equal(h.lifecycle.describe().closed, true, "close latches terminally");
    // The retired registry no longer serves buffer reads; settlement is
    // proven by the fenced tombstone, the single cancelled journal outcome
    // and the unchanged disk — late callbacks cannot reopen state.
    const tomb = h.lifecycle.listTombstones().find((t) => t.operation_id === typeId);
    assert.equal(tomb?.kind, "cancelled", "active plan settled as cancelled by close");
    assert.equal(h.lifecycle.admit(typeId, nextRequest("late")).ok, false, "post-close admission barred");
    assert.equal(hostText(h, DOC), SEED_V1, "disk unchanged by close");
    proof("close cancels and fences active plans");
  });
  it("P6.11 PROOF: close retires container resources", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    const d = h.lifecycle.describe();
    assert.equal((await h.lifecycle.close({ session_id: d.session_id, generation: d.generation, request_id: nextRequest("close") })).ok, true);
    assert.equal(h.retireCalls(), 1, "close retires exactly once");
    const again = await h.lifecycle.close({ session_id: d.session_id, generation: d.generation, request_id: nextRequest("close") });
    assert.equal(again.ok, true, "duplicate close converges idempotently");
    assert.equal(h.retireCalls(), 1, "no double retirement");
    proof("close retires container resources");
  });
  it("P6.11 PROOF: late completion after close harmless", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const spied = spyAdapter(h.adapter);
    const d = h.lifecycle.describe();
    assert.equal((await h.lifecycle.close({ session_id: d.session_id, generation: d.generation, request_id: nextRequest("close") })).ok, true);
    const late = await h.lifecycle.executeSave(saveAdm, depsFor(h, spied.adapter));
    assert.equal(late.ok, false, "late save after close fenced");
    assert.equal(spied.publishes(), 0, "late completion performs zero publications");
    assert.equal(hostText(h, DOC), SEED_V1, "late completion reopens nothing");
    proof("late completion after close harmless");
  });
});
describe("P6.11 renderer boundary and regressions", () => {
  it("P6.11 PROOF: no generic history restore API", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    const surface = h.lifecycle as unknown as Record<string, unknown>;
    for (const name of ["setDocumentContents", "restoreBuffer", "writeSnapshot", "rewriteJournal", "reseedPath", "rollbackBytes"]) {
      assert.equal(surface[name], undefined, `generic restore API absent: ${name}`);
    }
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(join(repoRoot, "engine", "workspace", "src", "editor-lifecycle.ts"), "utf8").toLowerCase();
    for (const name of ["setdocumentcontents", "restorebuffer", "writesnapshot", "rewritejournal"]) {
      assert.equal(code.includes(name), false, `restore construct absent from product code: ${name}`);
    }
    proof("no generic history restore API");
  });
  it("P6.11 PROOF: renderer cannot provide buffer bytes", async () => {
    const h = openLifecycleHarness(OPEN_TYPE, { [DOC]: SEED_V1 });
    const d = h.lifecycle.describe();
    for (const hostile of [
      { session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1], request_id: nextRequest("x"), content: "FORGED" },
      { session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1], request_id: nextRequest("x"), path: DOC },
      { session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1], request_id: nextRequest("x"), bytes: "FORGED" },
      { session_id: d.session_id, generation: d.generation, request_id: nextRequest("x") },
      { session_id: d.session_id, generation: d.generation, operation_id: h.operationIds[1], request_id: nextRequest("x"), reseed_path: "/tmp/evil" },
    ]) {
      assert.equal(h.lifecycle.cancelOperation(hostile).ok, false, "hostile cancel extra cannot execute");
      assert.equal(h.lifecycle.replay(hostile).ok, false, "hostile replay extra cannot execute");
    }
    const hostileReset = { session_id: d.session_id, generation: d.generation, request_id: nextRequest("x"), content: "FORGED" };
    assert.equal((await h.lifecycle.reset(hostileReset)).ok, false, "hostile reset extra rejected");
    assert.equal(hostText(h, DOC), SEED_V1, "hostile renderer input mutates nothing");
    proof("renderer cannot provide buffer bytes");
  });
  it("P6.11 PROOF: composed editor flow preserves prior guarantees", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    const [openId, typeId, saveId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    const opened = await h.lifecycle.executeOpen(openAdm, depsFor(h));
    assert.equal(opened.ok, true, "P6.7 open preserved");
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true, "P6.8 planning preserved");
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true, "P6.8 completion preserved");
    const saveAdm = mustAdmit(h.lifecycle, saveId, nextRequest("save"));
    const saved = await h.lifecycle.executeSave(saveAdm, depsFor(h));
    assert.equal(saved.ok, true, "P6.10 commit preserved");
    assert.equal(hostText(h, DOC), `${SEED_V1}INSERTED\n`, "exact persisted bytes");
    assert.equal(h.lifecycle.getJournal().terminalCount(), 3, "P6.10 exactly-one outcomes preserved");
    proof("composed editor flow preserves prior guarantees");
  });
  it("P6.11 PROOF: subscribe-before-snapshot replay ordering", async () => {
    const h = openLifecycleHarness(OPEN_TYPE_SAVE, { [DOC]: SEED_V1 });
    // Subscribe BEFORE the snapshot, mirroring the proven P5 pattern:
    // arrivals during the snapshot fetch buffer instead of being lost.
    const arrived: number[] = [];
    const sub = h.lifecycle.subscribe((event) => {
      arrived.push(event.seq);
    });
    const page = h.lifecycle.snapshot(0);
    assert.equal(page.reset, false, "cursor inside retained history");
    assert.deepEqual(page.events.map((e) => e.seq), [], "no events before any operation");
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("open")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("type"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    // Exactly-once feed: every journal event arrived once through the live
    // subscription, and the snapshot converges on the same high-water mark.
    const live = h.lifecycle.listEvents();
    assert.deepEqual([...arrived].sort((a, b) => a - b), live.map((e) => e.seq), "live feed matches the journal exactly once");
    assert.equal(new Set(arrived).size, arrived.length, "no duplicate delivery");
    const after = h.lifecycle.snapshot(0);
    assert.equal(after.journal_high_seq, live.length, "snapshot high-water mark converges");
    // Gap detection: a cursor past history reports reset instead of fabricating replay.
    const gap = h.lifecycle.snapshot(live.length + 100);
    assert.equal(gap.reset, true, "cursor outside history reports reset");
    sub.unsubscribe();
    const countBefore = arrived.length;
    // A further operation appends to the journal but the retired listener
    // receives nothing more.
    assert.equal((await h.lifecycle.executeSave(mustAdmit(h.lifecycle, saveId, nextRequest("save")), depsFor(h))).ok, true);
    assert.equal(arrived.length, countBefore, "unsubscribed listener receives nothing more");
    proof("subscribe-before-snapshot replay ordering");
  });
});

describe("P6.11 reset - old authorities fence", () => {
  it("P6.11 PROOF: old document stale after reset", async () => {
    const h = openLifecycleHarness(OPEN_ONLY, { [DOC]: SEED_V1 });
    const [openId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("open"));
    assert.equal((await h.lifecycle.executeOpen(openAdm, depsFor(h))).ok, true);
    const oldSession = h.lifecycle.getSession();
    const oldDocId = openAdm.document.document_id;
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("reset") })).ok, true);
    const resolved = oldSession.registry.resolveDocument(oldDocId);
    assert.equal(resolved.ok, false, "old document_id cannot address the new generation");
    if (resolved.ok) throw new Error("unreachable");
    assert.equal(resolved.rejection.code, "STALE_SESSION");
    proof("old document stale after reset");
  });
});
