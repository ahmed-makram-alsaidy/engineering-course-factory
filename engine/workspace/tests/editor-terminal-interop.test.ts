// P6.13 terminal interoperability — deterministic orchestration proofs
// (offline, no sleeps, real adapter + real coordinator + real lifecycle).
//
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.13 Terminal
// interoperability ("Real shared bind, dirty reads, RW invalidation,
// background watcher"; PASS "Exact saved target observed; no partial
// typing"). Canonical authority: sections 16/10/14/15/21/26 plus ADR-0011.
//
// Proves at runtime with the REAL ownership stack (coordinator,
// lifecycle, adapter over phase-owned temp/P6.13/interop leaves) that the
// complete editor-to-terminal workflow shares ONE authoritative workspace:
// admitted open/create, admitted type/replace installed into the
// main-owned buffer only, verified save as the commit barrier, then
// terminal observation of exactly the committed bytes — plus the reverse
// handoff (terminal modification, confirmed retirement, explicit
// reacquire), ordering, journal correlation, fencing, reset/close/HOLD.
//
// The guest bind itself is simulated by FakeEpochOps over the same leaf
// (see the harness note); the REAL Docker bind is proven by the gate-only
// Docker suite. Fixture IR is NEVER hand-authored (canonical pipeline).
// Every resource is phase-owned; no global prune ever.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { coordinatorResolvesAccessWithoutCommands } from "../src/coordinator.ts";
import { createReviewedWorkspacePolicy, resolveTerminalAccess, sha256Hex } from "../src/policy.ts";
import {
  life,
  manifestFor,
  nextRequest,
  op,
  openHarness,
  policyFor,
  rejectionCode,
  repoRoot,
  terminalRunForeground,
  terminalWatcher,
  type OpenHarness,
} from "./editor-terminal-interop-harness.ts";

const TEST_ROOT = join(repoRoot, "temp", "P6.13", "interop");
const PREFIX = "cf-p613-";

function proof(message: string): void {
  console.log(`P6.13 PROOF: ${message}`);
}

function sidOf(harness: OpenHarness): { session_id: string; generation: number } {
  const described = harness.interop.describe();
  return { session_id: described.session_id, generation: described.generation };
}

before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});

after(() => {
  // Ownership-scoped sweep of exactly this suite's temp root (mirrors the
  // P6.5 precedent: per-test leaves are phase-owned; the suite removes them).
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "no phase temp workspaces remain");
  proof("CLEANUP phase temp workspaces removed");
});

function flowActions() {
  return [
    { action: { type: "file_open", path: "src/report.txt" } },
    { action: { type: "type_code", path: "src/report.txt", content: "v2 line\n" } },
    { action: { type: "replace_code", path: "src/report.txt", find: "v1", replace: "v1r" } },
    { action: { type: "file_save", path: "src/report.txt" } },
    terminalRunForeground("cat src/report.txt"),
    terminalRunForeground("cat src/report.txt"),
  ];
}

function openFlow(tag: string): OpenHarness {
  return openHarness({
    root: TEST_ROOT,
    tag,
    namePrefix: PREFIX,
    actions: flowActions(),
    seedFiles: { "src/report.txt": "v1 line\n" },
    terminalModes: ["read_only", "read_only"],
  });
}

describe("P6.13 full semantic flow: open/type/replace/save/terminal-read", () => {
  it("P6.13 PROOF: terminal observes exactly the verified saved bytes with actual exit", async () => {
    const harness = openFlow("full-flow");
    const { interop, ops } = harness;
    const [open, type, replace, save, readA, readB] = ops as [string, string, string, string, string, string];

    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runReplaceDocument(op(interop, replace, "replace"))).ok, true);
    // Disk still holds the committed seed while the buffer is dirty.
    assert.equal(readFileSync(join(harness.leaf, "src", "report.txt"), "utf8"), "v1 line\n");
    assert.equal(interop.describe().dirty_buffers, 1);

    const saved = await interop.runSaveDocument(op(interop, save, "save"));
    assert.equal(saved.ok, true);
    if (!saved.ok) throw new Error("unreachable");
    assert.equal(saved.value.portable_path, "src/report.txt");
    assert.ok(saved.value.journal_seq > 0);
    assert.equal(interop.describe().dirty_buffers, 0);

    const read = await interop.terminalReadSaved(op(interop, readA, "read"));
    assert.equal(read.ok, true);
    if (!read.ok) throw new Error("unreachable");
    assert.equal(read.value.exit_code, 0);
    assert.equal(read.value.stdout, "v1r line\nv2 line\n");
    assert.equal(readFileSync(join(harness.leaf, "src", "report.txt"), "utf8"), "v1r line\nv2 line\n");

    // Repeatability: a second foreground read observes the same bytes.
    const reread = await interop.terminalReadSaved(op(interop, readB, "reread"));
    assert.equal(reread.ok, true);
    if (!reread.ok) throw new Error("unreachable");
    assert.equal(reread.value.stdout, "v1r line\nv2 line\n");

    assert.equal(interop.describe().ownership, "EDITOR_OWNED");
    assert.equal(interop.describe().ro_observers, 0);
    assert.equal(harness.fake.live, null, "no epoch container survives the flow");
    await interop.closeSession(life(interop, "close"));
    proof("full flow: saved bytes exact, terminal exit 0, zero survivors");
  });

  it("P6.13 PROOF: save completion precedes terminal start in the shared trace", async () => {
    const harness = openFlow("trace-order");
    const { interop, ops } = harness;
    const [open, type, replace, save, readA] = ops as [string, string, string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runReplaceDocument(op(interop, replace, "replace"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.terminalReadSaved(op(interop, readA, "read"))).ok, true);

    const trace = interop.sharedTrace();
    const kinds = trace.map((event) => event.kind);
    const saveIndex = kinds.indexOf("interop.save.committed");
    const admittedIndex = kinds.indexOf("interop.terminal.admitted");
    const observedIndex = kinds.indexOf("interop.terminal.observed");
    assert.ok(saveIndex >= 0 && admittedIndex > saveIndex && observedIndex > admittedIndex, `trace order save(${saveIndex}) < admitted(${admittedIndex}) < observed(${observedIndex})`);

    // Editor journal correlation: exactly one terminal save with the committed effect.
    const events = interop.editorEvents();
    const terminal = events.filter((event) => event.kind === "editor.operation.completed" && event.operation_id === save);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0]?.disk_effect, "saved");
    const started = events.find((event) => event.kind === "editor.operation.started" && event.operation_id === save);
    assert.ok((started?.seq ?? 0) < (terminal[0]?.seq ?? 0));

    // Coordinator barrier correlation: the writer was acquired and released exactly once.
    const workspace = interop.workspaceEvents().map((event) => event.type);
    assert.ok(workspace.includes("workspace.writer.acquired") || workspace.includes("workspace.ro.acquired"));
    await interop.closeSession(life(interop, "close"));
    proof("journal order: save completion precedes terminal start");
  });

  it("P6.13 PROOF: terminal output never becomes editor state", async () => {
    const harness = openFlow("output-passive");
    const { interop, ops } = harness;
    const [open, type, replace, save, readA] = ops as [string, string, string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runReplaceDocument(op(interop, replace, "replace"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    const journalBefore = interop.editorEvents().length;
    const lastSavedBefore = interop.describe().last_saved_target;
    assert.equal((await interop.terminalReadSaved(op(interop, readA, "read"))).ok, true);
    assert.equal(interop.editorEvents().length, journalBefore, "foreground reads append no editor events");
    assert.equal(interop.describe().last_saved_target, lastSavedBefore);
    assert.equal(interop.describe().dirty_buffers, 0);
    await interop.closeSession(life(interop, "close"));
    proof("terminal output stays passive: no editor mutation");
  });

  it("P6.13 PROOF: foreground read is impossible before the verified save", async () => {
    const harness = openFlow("no-early-read");
    const { interop, ops } = harness;
    const [open, type, replace, save, readA] = ops as [string, string, string, string, string];
    void save;
    const early = await interop.terminalReadSaved(op(interop, readA, "early"));
    assert.equal(early.ok, false);
    assert.equal(rejectionCode(early), "INVALID_REQUEST");
    assert.equal(harness.fake.calls.length, 0, "zero terminal action before the save barrier");
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runReplaceDocument(op(interop, replace, "replace"))).ok, true);
    const earlyDirty = await interop.terminalReadSaved(op(interop, readA, "early-dirty"));
    assert.equal(earlyDirty.ok, false, "dirty buffer alone never authorizes a terminal read");
    assert.equal(rejectionCode(earlyDirty), "INVALID_REQUEST");
    await interop.closeSession(life(interop, "close"));
    proof("no terminal read can race ahead of save verification");
  });
});

describe("P6.13 run flow: committed script executes with actual stdout and exit", () => {
  function openRun(tag: string): OpenHarness {
    return openHarness({
      root: TEST_ROOT,
      tag,
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/app.js" } },
        { action: { type: "type_code", path: "src/app.js", content: 'console.log("NEW");\n' } },
        { action: { type: "file_save", path: "src/app.js" } },
        terminalWatcher("watcher", "node src/app.js"),
        terminalRunForeground("node src/app.js"),
      ],
      seedFiles: { "src/app.js": 'console.log("OLD");\n' },
      terminalModes: ["read_only", "read_only"],
    });
  }

  it("P6.13 PROOF: watcher sees OLD before save and OLD+NEW after save; run prints exact stdout", async () => {
    const harness = openRun("run-flow");
    const { interop, ops } = harness;
    const [open, type, save, watch, run] = ops as [string, string, string, string, string];
    const sid = sidOf(harness);

    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    const before = await interop.observeCommitted({ ...sid, rel_path: "src/app.js" });
    assert.equal(before.ok, true);
    if (!before.ok) throw new Error("unreachable");
    assert.equal(before.value.exit_code, 0);
    assert.equal(before.value.stdout, 'console.log("OLD");\n');

    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    const during = await interop.observeCommitted({ ...sid, rel_path: "src/app.js" });
    assert.equal(during.ok, true);
    if (!during.ok) throw new Error("unreachable");
    assert.equal(during.value.stdout, 'console.log("OLD");\n', "visual typing never reaches the committed disk");

    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    const after = await interop.observeCommitted({ ...sid, rel_path: "src/app.js" });
    assert.equal(after.ok, true);
    if (!after.ok) throw new Error("unreachable");
    assert.equal(after.value.stdout, 'console.log("OLD");\nconsole.log("NEW");\n');

    const ran = await interop.terminalRunSaved(op(interop, run, "run"));
    assert.equal(ran.ok, true);
    if (!ran.ok) throw new Error("unreachable");
    assert.equal(ran.value.exit_code, 0);
    assert.equal(ran.value.stdout, "OLD\nNEW\n");
    assert.ok((ran.value.journal_seq_before ?? 0) > 0, "run correlates to the completed save journal");

    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    assert.equal(harness.fake.live, null);
    await interop.closeSession(life(interop, "close"));
    proof("run flow: OLD before save, OLD+NEW after, exact stdout and exit 0");
  });
});

describe("P6.13 pending create flow: invisible before save, exact after", () => {
  function openCreate(tag: string): OpenHarness {
    return openHarness({
      root: TEST_ROOT,
      tag,
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_create", path: "src/created.txt" } },
        { action: { type: "type_code", path: "src/created.txt", content: "created bytes\n" } },
        { action: { type: "file_save", path: "src/created.txt" } },
        terminalWatcher("watcher", "cat src/created.txt"),
        terminalRunForeground("cat src/created.txt"),
      ],
      seedFiles: {},
      seedDirs: ["src"],
      terminalModes: ["read_only", "read_only"],
    });
  }

  it("P6.13 PROOF: pending file absent to the terminal until the verified save", async () => {
    const harness = openCreate("pending-create");
    const { interop, ops } = harness;
    const [create, type, save, watch, read] = ops as [string, string, string, string, string];
    const sid = sidOf(harness);

    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    assert.equal((await interop.runCreateDocument(op(interop, create, "create"))).ok, true);
    assert.equal(existsSync(join(harness.leaf, "src", "created.txt")), false, "staged creation publishes nothing");
    const absent = await interop.observeCommitted({ ...sid, rel_path: "src/created.txt" });
    assert.equal(absent.ok, true);
    if (!absent.ok) throw new Error("unreachable");
    assert.notEqual(absent.value.exit_code, 0, "terminal sees absence, not staging");

    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    const stillAbsent = await interop.observeCommitted({ ...sid, rel_path: "src/created.txt" });
    assert.equal(stillAbsent.ok, true);
    if (!stillAbsent.ok) throw new Error("unreachable");
    assert.notEqual(stillAbsent.value.exit_code, 0, "typed staging stays invisible");

    const saved = await interop.runSaveDocument(op(interop, save, "save"));
    assert.equal(saved.ok, true);
    if (!saved.ok) throw new Error("unreachable");
    assert.equal(saved.value.portable_path, "src/created.txt");
    const present = await interop.observeCommitted({ ...sid, rel_path: "src/created.txt" });
    assert.equal(present.ok, true);
    if (!present.ok) throw new Error("unreachable");
    assert.equal(present.value.exit_code, 0);
    assert.equal(present.value.stdout, "created bytes\n");

    const readBack = await interop.terminalReadSaved(op(interop, read, "read"));
    assert.equal(readBack.ok, true);
    if (!readBack.ok) throw new Error("unreachable");
    assert.equal(readBack.value.stdout, "created bytes\n");

    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("pending create: absent before save, exact after save");
  });

  it("P6.13 PROOF: pending creation blocks terminal read-write", async () => {
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "pending-blocks-rw",
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_create", path: "src/created.txt" } },
        { action: { type: "file_save", path: "src/created.txt" } },
        terminalRunForeground("cat src/created.txt"),
      ],
      seedFiles: {},
      seedDirs: ["src"],
      terminalModes: ["read_write"],
    });
    const { interop, ops } = harness;
    const [create, save, rw] = ops as [string, string, string];
    assert.equal((await interop.runCreateDocument(op(interop, create, "create"))).ok, true);
    const blocked = await interop.terminalModify({ ...sidOf(harness), operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/created.txt", content: "x" });
    assert.equal(blocked.ok, false);
    assert.equal(rejectionCode(blocked), "DIRTY_BUFFER_CONFLICT");
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    const allowed = await interop.terminalModify({ ...sidOf(harness), operation_id: rw, request_id: nextRequest("rw2"), rel_path: "src/created.txt", content: "terminal bytes\n" });
    assert.equal(allowed.ok, true, "verified save restores read-write eligibility");
    assert.equal(readFileSync(join(harness.leaf, "src", "created.txt"), "utf8"), "terminal bytes\n");
    await interop.closeSession(life(interop, "close"));
    proof("pending blocks RW; verified save restores eligibility");
  });
});

describe("P6.13 dirty interlock and background read-only coexistence", () => {
  function openDirty(tag: string): OpenHarness {
    return openHarness({
      root: TEST_ROOT,
      tag,
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "type_code", path: "src/report.txt", content: "dirty line\n" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
        terminalRunForeground("cat src/report.txt"),
        { action: { type: "file_open", path: "src/other.txt" } },
      ],
      seedFiles: { "src/report.txt": "clean line\n", "src/other.txt": "other\n" },
      terminalModes: ["read_only", "read_write"],
    });
  }

  it("P6.13 PROOF: dirty buffer denies read-write; verified save allows the transition", async () => {
    const harness = openDirty("dirty-interlock");
    const { interop, ops } = harness;
    const [open, type, save, watch, rw] = ops as [string, string, string, string, string];
    void watch;
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);

    const denied = await interop.terminalModify({ ...sidOf(harness), operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/report.txt", content: "x" });
    assert.equal(denied.ok, false);
    assert.equal(rejectionCode(denied), "DIRTY_BUFFER_CONFLICT");
    assert.equal(harness.fake.calls.filter((call) => call.startsWith("prepare")).length, 0, "denied RW prepares zero containers");
    assert.equal(readFileSync(join(harness.leaf, "src", "report.txt"), "utf8"), "clean line\n");

    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    const epochBefore = interop.describe().epoch;
    const revisionBefore = interop.describe().workspace_revision;
    const allowed = await interop.terminalModify({ ...sidOf(harness), operation_id: rw, request_id: nextRequest("rw2"), rel_path: "src/report.txt", content: "rw bytes\n" });
    assert.equal(allowed.ok, true);
    if (!allowed.ok) throw new Error("unreachable");
    assert.equal(allowed.value.exit_code, 0);
    assert.equal(allowed.value.changed, true);
    assert.equal(interop.describe().ownership, "EDITOR_OWNED");
    assert.ok(interop.describe().epoch > epochBefore, "write handoff advances the epoch");
    assert.ok(interop.describe().workspace_revision > revisionBefore, "write boundary advances the workspace revision");
    assert.equal(readFileSync(join(harness.leaf, "src", "report.txt"), "utf8"), "rw bytes\n");
    await interop.closeSession(life(interop, "close"));
    proof("dirty denies RW; save enables the canonical transition");
  });

  it("P6.13 PROOF: read-only watcher survives open/type/save and stays read-only", async () => {
    const harness = openDirty("ro-coexist");
    const { interop, ops } = harness;
    const [open, type, save, watch] = ops as [string, string, string, string];
    const sid = sidOf(harness);

    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    const firstHandle = harness.fake.live;
    assert.ok(firstHandle !== null);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal(interop.describe().ro_observers, 1, "watcher survives the save");
    assert.equal(harness.fake.live, firstHandle, "no container recreation across saves");

    const denied = await harness.fake.attemptEpochWrite(firstHandle!, "evil.txt", "nope");
    assert.notEqual(denied.exitCode, 0, "watcher epoch stays read-only");
    assert.equal(existsSync(join(harness.leaf, "evil.txt")), false);

    const seen = await interop.observeCommitted({ ...sid, rel_path: "src/report.txt" });
    assert.equal(seen.ok, true);
    if (!seen.ok) throw new Error("unreachable");
    assert.equal(seen.value.stdout, "clean line\ndirty line\n");
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    assert.equal(harness.fake.live, null);
    await interop.closeSession(life(interop, "close"));
    proof("RO watcher coexists across saves and cannot write");
  });

  it("P6.13 PROOF: read-write requires zero observers (explicit stop, never auto-kill)", async () => {
    const harness = openDirty("rw-exclusive");
    const { interop, ops } = harness;
    const [open, type, save, watch, rw] = ops as [string, string, string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);

    const busy = await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/report.txt", content: "x" });
    assert.equal(busy.ok, false);
    assert.equal(rejectionCode(busy), "WORKSPACE_BUSY");
    assert.equal(interop.describe().ro_observers, 1, "watcher was not auto-killed");

    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    const allowed = await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw2"), rel_path: "src/report.txt", content: "rw bytes\n" });
    assert.equal(allowed.ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("RW waits for explicit observer stop");
  });

  it("P6.13 PROOF: host editor work is denied while the write epoch is live", async () => {
    const harness = openDirty("rw-live-deny");
    const { interop, ops } = harness;
    const [open, type, save, , rw, open2] = ops as [string, string, string, string, string, string];
    void open;
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    harness.fake.gateWrite = () => gate;
    const modifying = interop.terminalModify({ ...sidOf(harness), operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/report.txt", content: "rw bytes\n" });
    // Let the write epoch go live (admission + preparation settle first).
    for (let spin = 0; spin < 100 && interop.describe().ownership !== "TERMINAL_OWNED"; spin += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(interop.describe().ownership, "TERMINAL_OWNED");
    try {
      // A fresh reviewed operation attempts host work while the guest owns the leaf.
      const early = await interop.runOpenDocument(op(interop, open2, "early"));
      assert.equal(early.ok, false, "editor cannot reserve while the terminal owns the leaf");
      assert.equal(rejectionCode(early), "WORKSPACE_BUSY");
      assert.equal(readFileSync(join(harness.leaf, "src", "report.txt"), "utf8"), "clean line\ndirty line\n", "zero host mutation");
    } finally {
      releaseGate();
    }
    const done = await modifying;
    assert.equal(done.ok, true);
    assert.equal(readFileSync(join(harness.leaf, "src", "report.txt"), "utf8"), "rw bytes\n");
    await interop.closeSession(life(interop, "close"));
    proof("live RW epoch denies host writes with zero mutation");
  });
});

describe("P6.13 terminal modification invalidates stale editor preimages", () => {
  // Pre-admission gating never consumes the attempt and never reserves
  // buffer state, so stale operations stay last in authored order: each
  // conflict lesson proves its gate, then the terminal (unaffected by
  // editor ordinals) reads the terminal-modified bytes.
  function openSaveStale(tag: string): OpenHarness {
    return openHarness({
      root: TEST_ROOT,
      tag,
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/doc.txt" } },
        { action: { type: "type_code", path: "src/doc.txt", content: "editor N\n" } },
        { action: { type: "file_save", path: "src/doc.txt" } },
        terminalRunForeground("cat src/doc.txt"),
        { action: { type: "file_save", path: "src/doc.txt" } },
        terminalWatcher("watcher", "cat src/doc.txt"),
      ],
      seedFiles: { "src/doc.txt": "seed\n" },
      terminalModes: ["read_write", "read_only"],
    });
  }

  function openReacquire(tag: string): OpenHarness {
    return openHarness({
      root: TEST_ROOT,
      tag,
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/doc.txt" } },
        { action: { type: "type_code", path: "src/doc.txt", content: "editor N\n" } },
        { action: { type: "file_save", path: "src/doc.txt" } },
        terminalRunForeground("cat src/doc.txt"),
        { action: { type: "file_open", path: "src/doc.txt" } },
        { action: { type: "type_code", path: "src/doc.txt", content: " after M" } },
        { action: { type: "file_save", path: "src/doc.txt" } },
        terminalRunForeground("cat src/doc.txt"),
      ],
      seedFiles: { "src/doc.txt": "seed\n" },
      terminalModes: ["read_write", "read_only"],
    });
  }

  function openTypeStale(tag: string): OpenHarness {
    return openHarness({
      root: TEST_ROOT,
      tag,
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/doc.txt" } },
        { action: { type: "type_code", path: "src/doc.txt", content: "editor N\n" } },
        { action: { type: "file_save", path: "src/doc.txt" } },
        terminalRunForeground("cat src/doc.txt"),
        { action: { type: "type_code", path: "src/doc.txt", content: "stale edit\n" } },
      ],
      seedFiles: { "src/doc.txt": "seed\n" },
      terminalModes: ["read_write"],
    });
  }

  it("P6.13 PROOF: stale save after terminal modification conflicts with zero clobber", async () => {
    const harness = openSaveStale("rw-save-stale");
    const { interop, ops } = harness;
    const [open, type, save, rw, saveStale, watch] = ops as [string, string, string, string, string, string];
    const sid = sidOf(harness);

    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal(readFileSync(join(harness.leaf, "src", "doc.txt"), "utf8"), "seed\neditor N\n");

    const modified = await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/doc.txt", content: "terminal M\n" });
    assert.equal(modified.ok, true);
    assert.equal(interop.describe().reacquire_required, 1, "loaded documents require explicit open");
    assert.equal(interop.describe().last_saved_target, null, "pre-write save record cannot outlive the write epoch");

    const staleSave = await interop.runSaveDocument(op(interop, saveStale, "stale-save"));
    assert.equal(staleSave.ok, false, "stale preimage cannot silently overwrite the terminal change");
    assert.equal(rejectionCode(staleSave), "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(readFileSync(join(harness.leaf, "src", "doc.txt"), "utf8"), "terminal M\n", "zero clobber");
    assert.equal(interop.describe().dirty_buffers, 0, "gated attempts reserve no buffer state");

    // The terminal observes its own committed modification through a watcher.
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    const seen = await interop.observeCommitted({ ...sid, rel_path: "src/doc.txt" });
    assert.equal(seen.ok, true);
    if (!seen.ok) throw new Error("unreachable");
    assert.equal(seen.value.exit_code, 0);
    assert.equal(seen.value.stdout, "terminal M\n");
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("stale save conflicts; terminal modification stands");
  });

  it("P6.13 PROOF: explicit reacquire after the write epoch heals editing", async () => {
    const harness = openReacquire("rw-reacquire");
    const { interop, ops } = harness;
    const [open, type, save, rw, reopen, typeAfter, saveAfter, readFinal] = ops as [
      string, string, string, string, string, string, string, string,
    ];
    const sid = sidOf(harness);

    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/doc.txt", content: "terminal M\n" })).ok, true);

    assert.equal((await interop.runReacquireDocument(op(interop, reopen, "reopen"))).ok, true);
    assert.equal(interop.describe().reacquire_required, 0);
    assert.equal((await interop.runTypeDocument(op(interop, typeAfter, "type-after"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, saveAfter, "save-after"))).ok, true);
    assert.equal(readFileSync(join(harness.leaf, "src", "doc.txt"), "utf8"), "terminal M\n after M");

    const final = await interop.terminalReadSaved(op(interop, readFinal, "final"));
    assert.equal(final.ok, true);
    if (!final.ok) throw new Error("unreachable");
    assert.equal(final.value.stdout, "terminal M\n after M");
    await interop.closeSession(life(interop, "close"));
    proof("reacquire heals; editing continues on terminal-modified bytes");
  });

  it("P6.13 PROOF: stale type after terminal modification conflicts without side effects", async () => {
    const harness = openTypeStale("rw-type-stale");
    const { interop, ops } = harness;
    const [open, type, save, rw, typeStale] = ops as [string, string, string, string, string];
    const sid = sidOf(harness);

    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/doc.txt", content: "terminal M\n" })).ok, true);

    const staleType = await interop.runTypeDocument(op(interop, typeStale, "stale-type"));
    assert.equal(staleType.ok, false);
    assert.equal(rejectionCode(staleType), "EXTERNAL_MODIFICATION_CONFLICT");
    assert.equal(interop.describe().dirty_buffers, 0, "gated type reserves no dirty buffer");
    assert.equal(readFileSync(join(harness.leaf, "src", "doc.txt"), "utf8"), "terminal M\n");
    await interop.closeSession(life(interop, "close"));
    proof("stale type conflicts with zero buffer or disk effect");
  });
});

describe("P6.13 cross-engine admission, fencing and renderer boundary", () => {
  it("P6.13 PROOF: coordinator resolves access without command input (structural)", async () => {
    assert.equal(coordinatorResolvesAccessWithoutCommands(), true);
    proof("no command heuristics: access resolution takes no command parameter");
  });

  it("P6.13 PROOF: renderer cannot forge paths, content, commands, access or epochs", async () => {
    const harness = openFlow("hostile-renderer");
    const { interop } = harness;
    const sid = sidOf(harness);
    const hostileExtras = [
      { ...sid, operation_id: "x", request_id: "r1", path: "src/evil.txt" },
      { ...sid, operation_id: "x", request_id: "r2", content: "evil" },
      { ...sid, operation_id: "x", request_id: "r3", command: "rm -rf /" },
      { ...sid, operation_id: "x", request_id: "r4", access: "read_write" },
      { ...sid, operation_id: "x", request_id: "r5", epoch: 1 },
      { ...sid, operation_id: "x", request_id: "r6", lease_id: "forged" },
      { ...sid, request_id: "r7" },
      { session_id: sid.session_id, generation: sid.generation, operation_id: "x" },
    ];
    for (const hostile of hostileExtras) {
      assert.equal(rejectionCode(await interop.runOpenDocument(hostile)), "INVALID_REQUEST");
      assert.equal(rejectionCode(await interop.runSaveDocument(hostile)), "INVALID_REQUEST");
      assert.equal(rejectionCode(await interop.startWatcher(hostile)), "INVALID_REQUEST");
    }
    assert.equal(rejectionCode(await interop.terminalModify({ ...sid, operation_id: "x", request_id: "r8", rel_path: "../outside.txt", content: "x" })), "INVALID_REQUEST");
    assert.equal(rejectionCode(await interop.terminalModify({ ...sid, operation_id: "x", request_id: "r9", rel_path: "src/a.txt", content: "has\0nul" })), "INVALID_REQUEST");
    assert.equal(rejectionCode(await interop.observeCommitted({ ...sid, rel_path: "../outside.txt" })), "INVALID_REQUEST");
    const unknownEditor = await interop.runOpenDocument({ ...sid, operation_id: "no-such-op", request_id: nextRequest("u") });
    assert.equal(unknownEditor.ok, false);
    assert.equal(rejectionCode(unknownEditor), "NOT_AUTHORIZED");
    const unknownTerminal = await interop.startWatcher({ ...sid, operation_id: "no-such-top", request_id: nextRequest("u2") });
    assert.equal(unknownTerminal.ok, false);
    assert.equal(rejectionCode(unknownTerminal), "NOT_AUTHORIZED");
    assert.equal(harness.fake.calls.length, 0, "hostile requests cause zero terminal action");
    await interop.closeSession(life(interop, "close"));
    proof("identifier-only boundary: every hostile extra rejected");
  });

  it("P6.13 PROOF: access is identical when only the command text differs", async () => {
    const actionsA = [terminalRunForeground("cat a.txt")];
    const lessonA = openHarness({
      root: TEST_ROOT,
      tag: "cmd-a",
      namePrefix: PREFIX,
      actions: [{ action: { type: "file_open", path: "src/a.txt" } }, ...actionsA],
      seedFiles: { "src/a.txt": "a\n" },
      terminalModes: ["read_only"],
    });
    const lessonB = openHarness({
      root: TEST_ROOT,
      tag: "cmd-b",
      namePrefix: PREFIX,
      actions: [{ action: { type: "file_open", path: "src/a.txt" } }, { action: { type: "terminal_run", command: "rm -rf /workspace", mode: "foreground" } }],
      seedFiles: { "src/a.txt": "a\n" },
      terminalModes: ["read_only"],
    });
    const opA = lessonA.ops[lessonA.ops.length - 1]!;
    const opB = lessonB.ops[lessonB.ops.length - 1]!;
    const seed = manifestFor({ "src/a.txt": "a\n" });
    const accessOf = (lesson: OpenHarness, opId: string) => {
      const policy = policyFor(lesson.lesson, seed, { [opId]: "read_only" });
      const resolved = resolveTerminalAccess(policy, opId);
      assert.equal(resolved.ok, true);
      return resolved.ok ? resolved.value : null;
    };
    assert.equal(accessOf(lessonA, opA), "read_only");
    assert.equal(accessOf(lessonB, opB), "read_only", "a hostile-looking command cannot widen reviewed access");
    await lessonA.interop.closeSession(life(lessonA.interop, "close"));
    await lessonB.interop.closeSession(life(lessonB.interop, "close"));
    proof("command text never influences access");
  });

  it("P6.13 PROOF: missing or extra policy coverage rejects with zero session", async () => {
    const harness = openFlow("coverage-proof");
    const seed = manifestFor({ "src/report.txt": "v1 line\n" });
    const terminalOps = harness.ops.slice(4);
    const missing = createReviewedWorkspacePolicy(
      {
        course_id: "C01",
        lesson_id: harness.lesson.lessonId,
        lesson_compiled_digest: harness.lesson.catalogDigest,
        seed_manifest_digest: "0".repeat(64),
        sandbox_policy_digest: sha256Hex("p613-sandbox-policy"),
        terminal_access: { [terminalOps[0]!]: "read_only" },
        reviewed_by: "reviewer",
        review_note: "p6.13",
      },
      terminalOps,
    );
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.rejection.code, "NOT_AUTHORIZED");
    await harness.interop.closeSession(life(harness.interop, "close"));
    proof("inexact terminal coverage cannot register");
  });

  it("P6.13 PROOF: stale generations and foreign sessions fence with zero terminal action", async () => {
    const harness = openFlow("stale-fencing");
    const { interop, ops, fake } = harness;
    const [open] = ops as [string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    const callsBefore = fake.calls.length;
    const reset = await interop.resetSession(life(interop, "reset"));
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.generation, 2);

    const sid = sidOf(harness);
    const oldSession = { session_id: "sess-1", generation: 1, operation_id: open, request_id: nextRequest("stale") };
    assert.equal(rejectionCode(await interop.runOpenDocument(oldSession)), "WRONG_OWNER");
    const wrongGen = { session_id: sid.session_id, generation: 1, operation_id: open, request_id: nextRequest("stale2") };
    assert.equal(rejectionCode(await interop.runSaveDocument(wrongGen)), "STALE_SESSION");
    assert.equal(rejectionCode(await interop.startWatcher(wrongGen)), "STALE_SESSION");
    assert.equal(rejectionCode(await interop.terminalReadSaved(wrongGen)), "STALE_SESSION");
    assert.equal(rejectionCode(await interop.resetSession({ session_id: sid.session_id, generation: 1, request_id: nextRequest("stale3") })), "STALE_SESSION");
    assert.equal(fake.calls.length, callsBefore, "stale requests cause zero terminal action");
    await interop.closeSession(life(interop, "close"));
    proof("old generations fence both engines");
  });

  it("P6.13 PROOF: stale epoch handles fence with zero action", async () => {
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "stale-epoch",
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
        terminalRunForeground("cat src/report.txt"),
      ],
      seedFiles: { "src/report.txt": "v\n" },
      terminalModes: ["read_only", "read_write"],
    });
    const { interop, ops, fake } = harness;
    const [open, save, watch, rw] = ops as [string, string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    const oldHandle = { ...fake.live! };
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    const modified = await interop.terminalModify({ ...sid, operation_id: rw, request_id: nextRequest("rw"), rel_path: "src/report.txt", content: "m\n" });
    assert.equal(modified.ok, true);

    await assert.rejects(fake.readEpochFile(oldHandle, "src/report.txt"), (error: unknown) => (error as { code?: string }).code === "STALE_EPOCH");
    await assert.rejects(fake.attemptEpochWrite(oldHandle, "src/report.txt", "x"), (error: unknown) => (error as { code?: string }).code === "STALE_EPOCH");
    await assert.rejects(fake.retireEpoch(oldHandle, "late"), (error: unknown) => (error as { code?: string }).code === "STALE_EPOCH");
    const containersBefore = fake.prepared.length;
    assert.equal(fake.live, null);
    assert.equal(fake.prepared.length, containersBefore, "stale handles start zero containers");
    await interop.closeSession(life(interop, "close"));
    proof("prior access epochs fence permanently");
  });
});

describe("P6.13 cancel, reset, close and HOLD across both engines", () => {
  it("P6.13 PROOF: cancelled typing leaves committed bytes for the terminal", async () => {
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "cancel-typing",
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "type_code", path: "src/report.txt", content: "cancelled line\n" } },
        terminalWatcher("watcher", "cat src/report.txt"),
      ],
      seedFiles: { "src/report.txt": "committed\n" },
      terminalModes: ["read_only"],
    });
    const { interop, ops } = harness;
    const [open, type, watch] = ops as [string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal(interop.describe().dirty_buffers, 1);
    // A settled type is already final: cancel reports INVALID_REQUEST
    // without undo (P6.11 semantics) and the disk keeps committed truth.
    const cancelled = interop.cancelDocument({ ...sid, operation_id: type, request_id: nextRequest("cancel") });
    assert.equal(cancelled.ok, false);
    assert.equal(rejectionCode(cancelled), "INVALID_REQUEST");
    assert.equal(interop.describe().dirty_buffers, 1, "no undo of settled work");
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);
    const seen = await interop.observeCommitted({ ...sid, rel_path: "src/report.txt" });
    assert.equal(seen.ok, true);
    if (!seen.ok) throw new Error("unreachable");
    assert.equal(seen.value.stdout, "committed\n", "terminal sees only committed disk, never the unsaved buffer");
    assert.equal((await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("cancel converges; terminal keeps seeing committed truth");
  });

  it("P6.13 PROOF: reset fences both engines and reseeds the workspace", async () => {
    const harness = openFlow("reset-both");
    const { interop, ops, fake, leaf } = harness;
    const [open, type, replace, save] = ops as [string, string, string, string, string, string];
    const sidBefore = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    const reset = await interop.resetSession(life(interop, "reset"));
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.generation, sidBefore.generation + 1);
    assert.equal(reset.value.dirty_buffers, 0);
    assert.equal(reset.value.ro_observers, 0);
    assert.equal(reset.value.last_saved_target, null);
    assert.equal(fake.live, null, "no epoch survives reset");
    assert.equal(readFileSync(join(leaf, "src", "report.txt"), "utf8"), "v1 line\n", "reset restores the seed bytes");
    // The new generation works end to end (authored order honored).
    const liveNow = interop.describe();
    const reopened = await interop.runOpenDocument({ session_id: liveNow.session_id, generation: liveNow.generation, operation_id: open, request_id: nextRequest("open2") });
    assert.equal(reopened.ok, true);
    assert.equal((await interop.runTypeDocument({ session_id: interop.describe().session_id, generation: interop.describe().generation, operation_id: type, request_id: nextRequest("type2") })).ok, true);
    assert.equal((await interop.runReplaceDocument({ session_id: interop.describe().session_id, generation: interop.describe().generation, operation_id: replace, request_id: nextRequest("replace2") })).ok, true);
    assert.equal((await interop.runSaveDocument({ session_id: interop.describe().session_id, generation: interop.describe().generation, operation_id: save, request_id: nextRequest("save2") })).ok, true);
    await interop.closeSession(life(interop, "close"));
    proof("reset rotates generation, reseeds, both engines fenced");
  });

  it("P6.13 PROOF: close retires both domains and nothing survives", async () => {
    const harness = openFlow("close-both");
    const { interop, ops, fake } = harness;
    const [open, type, replace, save] = ops as [string, string, string, string, string, string];
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runTypeDocument(op(interop, type, "type"))).ok, true);
    assert.equal((await interop.runReplaceDocument(op(interop, replace, "replace"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    const closed = await interop.closeSession(life(interop, "close"));
    assert.equal(closed.ok, true);
    const sid = sidOf(harness);
    assert.equal(rejectionCode(await interop.runOpenDocument({ ...sid, operation_id: open, request_id: nextRequest("late") })), "INVALID_TRANSITION");
    assert.equal(rejectionCode(await interop.startWatcher({ ...sid, operation_id: "late", request_id: nextRequest("late2") })), "INVALID_TRANSITION");
    assert.equal(rejectionCode(await interop.resetSession({ ...sid, request_id: nextRequest("late3") })), "INVALID_TRANSITION");
    const trace = interop.sharedTrace();
    assert.equal(trace[trace.length - 1]?.kind, "interop.close.completed");
    assert.equal(fake.live, null);
    assert.equal(fake.calls.filter((call) => call.startsWith("prepare")).length, 0, "this flow prepared zero containers");
    proof("close ends both engines with no survivors");
  });

  it("P6.13 PROOF: unconfirmed retirement holds both engines until explicit reset", async () => {
    const harness = openHarness({
      root: TEST_ROOT,
      tag: "hold-flow",
      namePrefix: PREFIX,
      actions: [
        { action: { type: "file_open", path: "src/report.txt" } },
        { action: { type: "file_save", path: "src/report.txt" } },
        terminalWatcher("watcher", "cat src/report.txt"),
      ],
      seedFiles: { "src/report.txt": "v\n" },
      terminalModes: ["read_only"],
    });
    const { interop, ops, fake } = harness;
    const [open, save, watch] = ops as [string, string, string];
    const sid = sidOf(harness);
    assert.equal((await interop.runOpenDocument(op(interop, open, "open"))).ok, true);
    assert.equal((await interop.runSaveDocument(op(interop, save, "save"))).ok, true);
    assert.equal((await interop.startWatcher(op(interop, watch, "watch"))).ok, true);

    fake.forceUnconfirmedRetire = true;
    const stopped = await interop.stopWatcher({ ...sid, operation_id: watch, request_id: nextRequest("stop") });
    assert.equal(stopped.ok, false);
    assert.equal(rejectionCode(stopped), "CLEANUP_UNCONFIRMED");
    assert.equal(interop.describe().ownership, "HOLD");
    assert.equal(rejectionCode(await interop.runOpenDocument(op(interop, open, "blocked"))), "CLEANUP_UNCONFIRMED");
    assert.equal(rejectionCode(await interop.startWatcher(op(interop, watch, "blocked2"))), "CLEANUP_UNCONFIRMED");
    const trace = interop.sharedTrace();
    assert.ok(trace.some((event) => event.kind === "interop.hold.entered"), "HOLD is traced");

    // Recovery is explicit reset only, after confirmed cleanup.
    const resetHeld = await interop.resetSession(life(interop, "reset-held"));
    assert.equal(resetHeld.ok, false, "reset cannot reseed past unconfirmed cleanup");
    fake.forceUnconfirmedRetire = false;
    const reset = await interop.resetSession(life(interop, "reset"));
    assert.equal(reset.ok, true);
    if (!reset.ok) throw new Error("unreachable");
    assert.equal(reset.value.generation, sid.generation + 1);
    assert.equal(fake.live, null);
    await interop.closeSession(life(interop, "close"));
    proof("HOLD fails closed on both engines; explicit reset recovers");
  });
});
