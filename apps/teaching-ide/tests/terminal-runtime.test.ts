// P5.12 Passive UI tests — deterministic, no Electron launch, no Docker.
//
// Proves the renderer-side passive model (src/model/terminal-runtime.ts) and
// the TerminalPane/App static boundaries: trusted snapshots/events only, no
// optimistic lifecycle, stale/duplicate/gap/reset semantics, per-process
// transcripts, display-only Clear, stdin-disabled xterm, identifier-only IPC,
// record-safe labels, UI-safe errors, run eligibility, and no phase creep.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyTerminalRuntimeEvent,
  applyTerminalSnapshotPage,
  clearTerminalDisplay,
  createTerminalRequestId,
  formatTerminalCwdForDisplay,
  formatTerminalIdentityForDisplay,
  initialTerminalRuntimeView,
  isTerminalRunEligible,
  sanitizeTerminalOutputForDisplay,
  selectTerminalTranscript,
  summarizeTerminalResultForBadge,
  terminalUiSafeError,
  TERMINAL_DISPLAY_MAX_LINES,
} from "../src/model/terminal-runtime.ts";
import type { RuntimeEvent, TerminalSnapshotPage } from "@course-factory/terminal-engine";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");

let seqCounter = 0;
function makeEvent(overrides: Partial<RuntimeEvent> & { type: RuntimeEvent["type"] }): RuntimeEvent {
  seqCounter += 1;
  return {
    runtime_event_version: 1,
    session_id: "sess-p512",
    generation: 1,
    seq: seqCounter,
    monotonic_ms: seqCounter * 10,
    operation_id: "C01-L900-S001-B001",
    attempt_id: "att-1",
    course_id: "C01",
    lesson_id: "C01-L900",
    scene_id: "C01-L900-S001",
    beat_id: "C01-L900-S001-B001",
    process_id: null,
    payload: {},
    ...overrides,
  } as RuntimeEvent;
}

function resetSeq(): void {
  seqCounter = 0;
}

function terminalStep(stepId: string, type = "terminal_run"): never {
  return {
    kind: "operation",
    step_id: stepId,
    operation: { type, family: "terminal", parameters: { command: "echo hi", mode: "foreground" } },
  } as never;
}

describe("P5.12 model: trusted event application and badges", () => {
  it("builds a coherent foreground trace with the live badge", () => {
    resetSeq();
    let view = initialTerminalRuntimeView({ session_id: "sess-p512", generation: 1 });
    view = applyTerminalRuntimeEvent(view, makeEvent({ type: "operation.accepted", payload: {} }));
    view = applyTerminalRuntimeEvent(view, makeEvent({ type: "process.started", payload: {} }));
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "process.output", payload: { stream: "stdout", text: "P512_OK\n", stream_offset: 0 } }),
    );
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "process.exited", payload: { exit_code: 0, signal: null, duration_ms: 12 } }),
    );
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "operation.completed", payload: { outcome: "PASS", reason: null, exit_code: 0, forced: false } }),
    );
    const op = view.operations["C01-L900-S001-B001"];
    assert.ok(op);
    assert.equal(op.status, "PASS");
    assert.equal(op.completed, true);
    assert.match(op.transcript.stdout, /P512_OK/);
    assert.equal(summarizeTerminalResultForBadge(op), "PASS");
    assert.equal(view.appliedSeq, 5);
    assert.ok(view.displayLines.length >= 4);
  });

  it("marks unexpected exits FAIL with the true code", () => {
    resetSeq();
    let view = initialTerminalRuntimeView({ session_id: "sess-p512", generation: 1 });
    view = applyTerminalRuntimeEvent(view, makeEvent({ type: "operation.accepted", payload: {} }));
    view = applyTerminalRuntimeEvent(view, makeEvent({ type: "process.started", payload: {} }));
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "process.exited", payload: { exit_code: 7, signal: null, duration_ms: 5 } }),
    );
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "operation.completed", payload: { outcome: "FAIL", reason: "EXIT_CODE_MISMATCH", exit_code: 7, forced: false } }),
    );
    const op = view.operations["C01-L900-S001-B001"];
    assert.equal(op.status, "FAIL");
    assert.equal(op.exit_code, 7);
    assert.match(summarizeTerminalResultForBadge(op), /EXIT_CODE_MISMATCH/);
    assert.match(summarizeTerminalResultForBadge(op), /exit 7/);
  });

  it("keeps per-process transcripts separate with explicit prefixes", () => {
    resetSeq();
    let view = initialTerminalRuntimeView({ session_id: "sess-p512", generation: 1 });
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "operation.accepted", operation_id: "op-A", process_id: "proc-a", payload: {} }),
    );
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "process.started", operation_id: "op-A", process_id: "proc-a", payload: {} }),
    );
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({
        type: "process.output",
        operation_id: "op-A",
        process_id: "proc-a",
        payload: { stream: "stdout", text: "AAA", stream_offset: 0 },
      }),
    );
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "operation.accepted", operation_id: "op-B", process_id: "proc-b", payload: {} }),
    );
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "process.started", operation_id: "op-B", process_id: "proc-b", payload: {} }),
    );
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({
        type: "process.output",
        operation_id: "op-B",
        process_id: "proc-b",
        payload: { stream: "stderr", text: "BBB", stream_offset: 0 },
      }),
    );
    assert.equal(view.operations["op-A"].transcript.stdout, "AAA");
    assert.equal(view.operations["op-A"].transcript.stderr, "");
    assert.equal(view.operations["op-B"].transcript.stderr, "BBB");
    assert.equal(view.operations["op-B"].transcript.stdout, "");
    assert.equal(selectTerminalTranscript(view, "op-A")?.stdout, "AAA");
    const texts = view.displayLines.map((l) => l.text).join("\n");
    assert.match(texts, /op-A\/proc-a stdout/);
    assert.match(texts, /op-B\/proc-b stderr/);
  });
});

describe("P5.12 model: stale, duplicate, gap, reset and teardown fences", () => {
  it("ignores stale sessions/generations and duplicates; counts gaps", () => {
    resetSeq();
    let view = initialTerminalRuntimeView({ session_id: "sess-p512", generation: 1 });
    view = applyTerminalRuntimeEvent(view, makeEvent({ type: "operation.accepted", payload: {} }));
    const afterFirst = view.appliedSeq;
    // Duplicate seq: ignored.
    const dup = makeEvent({ type: "process.started", payload: {} });
    (dup as { seq: number }).seq = afterFirst;
    view = applyTerminalRuntimeEvent(view, dup);
    assert.equal(view.ignoredDuplicates, 1);
    // Stale session: ignored.
    view = applyTerminalRuntimeEvent(view, makeEvent({ type: "process.started", session_id: "other", payload: {} }));
    assert.equal(view.ignoredStale, 1);
    // Stale generation: ignored.
    view = applyTerminalRuntimeEvent(view, makeEvent({ type: "process.started", generation: 2, payload: {} }));
    assert.equal(view.ignoredStale, 2);
    // Gap: seq jump still applies and counts the hole (never blocks newer).
    resetSeq();
    seqCounter = 10;
    const before = view.gaps;
    view = applyTerminalRuntimeEvent(view, makeEvent({ type: "process.started", payload: {} }));
    assert.equal(view.gaps, before + 1);
  });

  it("reset pages re-anchor the cursor; teardown disables runs", () => {
    resetSeq();
    let view = initialTerminalRuntimeView({ session_id: "sess-p512", generation: 1 });
    const page: TerminalSnapshotPage = {
      runtime_event_version: 1,
      session_id: "sess-p512",
      generation: 1,
      after_seq: 99,
      page_end_seq: 99,
      journal_high_seq: 99,
      reset: true,
      events: [],
    };
    view = applyTerminalSnapshotPage(view, page);
    assert.equal(view.resets, 1);
    assert.equal(view.appliedSeq, 99);
    // Stale page ignored.
    view = applyTerminalSnapshotPage(view, { ...page, session_id: "other" });
    assert.equal(view.ignoredStale, 1);
    // Teardown: closing then closed.
    resetSeq();
    let live = initialTerminalRuntimeView({ session_id: "sess-p512", generation: 1 });
    live = applyTerminalRuntimeEvent(live, makeEvent({ type: "runtime.closing", operation_id: null, attempt_id: null, course_id: null, lesson_id: null, scene_id: null, beat_id: null, payload: { cause: "reset" } }));
    assert.equal(live.tearingDown, true);
    assert.equal(isTerminalRunEligible({ step: terminalStep("C01-L900-S001-B001"), view: live, executionAuthorized: true }), false);
    live = applyTerminalRuntimeEvent(live, makeEvent({ type: "runtime.closed", operation_id: null, attempt_id: null, course_id: null, lesson_id: null, scene_id: null, beat_id: null, payload: { cleanup_status: "confirmed" } }));
    assert.equal(live.closed, true);
    assert.equal(live.closeCleanup, "confirmed");
  });

  it("Clear drops display lines only; transcripts and badges stay", () => {
    resetSeq();
    let view = initialTerminalRuntimeView({ session_id: "sess-p512", generation: 1 });
    view = applyTerminalRuntimeEvent(view, makeEvent({ type: "operation.accepted", payload: {} }));
    view = applyTerminalRuntimeEvent(
      view,
      makeEvent({ type: "operation.completed", payload: { outcome: "PASS", reason: null, exit_code: 0, forced: false } }),
    );
    assert.ok(view.displayLines.length > 0);
    const cleared = clearTerminalDisplay(view);
    assert.equal(cleared.displayLines.length, 0);
    assert.equal(cleared.operations["C01-L900-S001-B001"].status, "PASS");
    assert.equal(cleared.appliedSeq, view.appliedSeq);
  });

  it("bounds display lines to the newest window", () => {
    resetSeq();
    let view = initialTerminalRuntimeView({ session_id: "sess-p512", generation: 1 });
    for (let i = 0; i < TERMINAL_DISPLAY_MAX_LINES + 50; i += 1) {
      view = applyTerminalRuntimeEvent(view, makeEvent({ type: "operation.accepted", operation_id: `op-${i}`, payload: {} }));
    }
    assert.ok(view.displayLines.length <= TERMINAL_DISPLAY_MAX_LINES);
  });
});

describe("P5.12 model: sanitization, record-safe labels, UI-safe errors", () => {
  it("strips OSC clipboard/title sequences and NUL; keeps text", () => {
    assert.equal(sanitizeTerminalOutputForDisplay("hello\x1b]52;c;xyz\x07world"), "helloworld");
    assert.equal(sanitizeTerminalOutputForDisplay("a\x00b"), "ab");
    assert.equal(sanitizeTerminalOutputForDisplay("plain \x1b[32mgreen\x1b[0m"), "plain \x1b[32mgreen\x1b[0m");
  });

  it("formats workspace labels record-safe (never a host path)", () => {
    assert.equal(formatTerminalCwdForDisplay(null), "/workspace");
    assert.equal(formatTerminalCwdForDisplay("."), "/workspace");
    assert.equal(formatTerminalCwdForDisplay("sub/dir"), "/workspace/sub/dir");
    assert.equal(formatTerminalCwdForDisplay("/workspace/sub"), "/workspace/sub");
    for (const label of [formatTerminalCwdForDisplay("sub"), formatTerminalIdentityForDisplay({ session_id: "s1", generation: 2 })]) {
      assert.doesNotMatch(label, /[A-Za-z]:\\/);
      assert.doesNotMatch(label, /containerId|host_root/i);
    }
  });

  it("maps structured codes to short UI-safe messages (no diagnostics)", () => {
    assert.equal(terminalUiSafeError("EXIT_CODE_MISMATCH"), "Command exited with an unexpected code.");
    assert.equal(terminalUiSafeError("TIMEOUT"), "Command timed out.");
    assert.equal(terminalUiSafeError("NOT_AUTHORIZED"), "Inspection only — this lesson is not reviewed for execution.");
    assert.equal(terminalUiSafeError("STALE_SESSION"), "Session changed — replay the current session.");
    const msg = terminalUiSafeError("TRANSPORT_FAILED");
    assert.ok(msg.length > 0 && msg.length <= 240);
    assert.doesNotMatch(msg, /[A-Za-z]:\\/);
    assert.doesNotMatch(msg, /var\/run\/docker\.sock/);
  });

  it("creates identifier-only request ids (1..128 chars)", () => {
    for (let i = 0; i < 5; i += 1) {
      const id = createTerminalRequestId();
      assert.ok(id.length >= 1 && id.length <= 128);
      assert.match(id, /^[A-Za-z0-9._-]+$/);
    }
  });
});

describe("P5.12 model: run eligibility (navigation inert, grants only)", () => {
  it("enables Run only for uncompleted terminal ops in a live authorized session", () => {
    resetSeq();
    const live = initialTerminalRuntimeView({ session_id: "sess-p512", generation: 1 });
    assert.equal(isTerminalRunEligible({ step: terminalStep("op-1"), view: live, executionAuthorized: true }), true);
    assert.equal(isTerminalRunEligible({ step: terminalStep("op-1"), view: live, executionAuthorized: false }), false, "inspection-only");
    assert.equal(
      isTerminalRunEligible({
        step: { kind: "operation", step_id: "op-x", operation: { type: "browser_open", family: "browser", parameters: {} } } as never,
        view: live,
        executionAuthorized: true,
      }),
      false,
      "browser navigation never enables Run",
    );
    assert.equal(isTerminalRunEligible({ step: null, view: live, executionAuthorized: true }), false);
    // Completed in this generation: no rerun.
    let done = applyTerminalRuntimeEvent(live, makeEvent({ type: "operation.accepted", operation_id: "op-1", payload: {} }));
    done = applyTerminalRuntimeEvent(done, makeEvent({ type: "operation.completed", operation_id: "op-1", payload: { outcome: "PASS", reason: null, exit_code: 0, forced: false } }));
    assert.equal(isTerminalRunEligible({ step: terminalStep("op-1"), view: done, executionAuthorized: true }), false);
    // terminal_stop via Run is eligible (authored stop path).
    assert.equal(isTerminalRunEligible({ step: terminalStep("op-s", "terminal_stop"), view: live, executionAuthorized: true }), true);
  });
});

describe("P5.12 static boundaries: TerminalPane/App/preload stay passive and narrow", () => {
  function strip(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  it("TerminalPane keeps xterm stdin disabled with no input forwarding", () => {
    const code = strip(readFileSync(join(appRoot, "src", "ui", "TerminalPane.tsx"), "utf8"));
    assert.match(code, /disableStdin:\s*true/);
    assert.doesNotMatch(code, /\.onData\s*\(/);
    assert.doesNotMatch(code, /send\s*\(\s*["']terminal:stdin/);
    assert.doesNotMatch(code, /dangerouslySetInnerHTML/);
    assert.doesNotMatch(code, /from\s+["']electron["']/);
    assert.doesNotMatch(code, /from\s+["']node:/);
    assert.doesNotMatch(code, /child_process/);
    assert.doesNotMatch(code, /node-pty/);
  });

  it("TerminalPane sends identifiers only (no command/env/cwd/image/mount/shell)", () => {
    const code = strip(readFileSync(join(appRoot, "src", "ui", "TerminalPane.tsx"), "utf8"));
    for (const method of ["runOperation", "stopProcess", "cancelOperation", "resetRuntime", "getSnapshot", "onEvent"]) {
      assert.match(code, new RegExp(method), `pane must use ${method}`);
    }
    // No renderer-constructed execution content: the pane never builds a
    // payload key that could carry command content.
    for (const banned of ["command:", "command :", "cwd:", "env:", "image:", "mount:", "shell:"]) {
      assert.equal(code.includes(banned), false, `no ${banned} payload key in the pane`);
    }
    assert.doesNotMatch(code, /terminal:execute|terminal:exec|terminal:spawn|terminal:shell|terminal:stdin|terminal:resize|terminal:docker/);
  });

  it("App wires the safe session with a generation-keyed remount and record-safe; navigation stays inert", () => {
    const code = strip(readFileSync(join(appRoot, "src", "App.tsx"), "utf8"));
    assert.match(code, /terminalSession/);
    assert.match(code, /session_id.*generation|generation.*session_id/);
    assert.match(code, /recordingSafe/);
    // Navigation handlers never invoke terminal execution directly.
    assert.doesNotMatch(code, /playheadNext.*runOperation|runOperation.*playhead/);
    // P5.14 owns the single visual-smoke auto-Run (identifiers only, gated by
    // isSmokeTerminalMode on the main-authorized safe fixture).
    // P6.15 owns exactly five identifier-only editor runOperation call sites
    // (gated by isSmokeP615Mode on the reviewed smoke fixture: seeded open,
    // saved type, verified save, intentionally-unsaved second type, reseed
    // open). No other App path may call runOperation: navigation stays
    // inert. Count actual call sites (`.runOperation(`), not diagnostic
    // strings mentioning the name.
    const runSites = code.match(/\.runOperation\s*\(/g) ?? [];
    assert.equal(runSites.length, 6, "App calls runOperation exactly six times (1 terminal smoke + 5 editor visual-proof)");
    const terminalRuns = code.match(/terminal\.runOperation\s*\(/g) ?? [];
    assert.equal(terminalRuns.length, 1, "terminal auto-Run stays single (P5.14 harness only)");
    const editorRuns = code.match(/editorApi\.runOperation\s*\(/g) ?? [];
    assert.equal(editorRuns.length, 5, "editor visual-proof runs exactly the five reviewed operations (P6.15 harness only)");
    assert.match(code, /isSmokeTerminalMode/);
    assert.match(code, /SMOKE_TERMINAL_OPERATION_ID/);
    assert.match(code, /isSmokeP615Mode/);
    for (const banned of ["command:", "cwd:", "env:", "image:", "mount:", "shell:"]) {
      assert.equal(code.includes(banned), false, `no ${banned} payload key in App`);
    }
  });

  it("renderer model imports engine types only (no runtime/engine/node surface)", () => {
    const code = strip(readFileSync(join(appRoot, "src", "model", "terminal-runtime.ts"), "utf8"));
    assert.match(code, /@course-factory\/terminal-engine/);
    assert.doesNotMatch(code, /from\s+["']electron["']/);
    assert.doesNotMatch(code, /from\s+["']node:/);
    assert.doesNotMatch(code, /child_process/);
    assert.doesNotMatch(code, /node-pty/);
    assert.doesNotMatch(code, /WebSocket/);
  });

  it("preload still exposes exactly the five methods plus onEvent (no widening)", () => {
    const code = strip(readFileSync(join(appRoot, "electron", "preload.ts"), "utf8"));
    for (const name of ["runOperation", "stopProcess", "cancelOperation", "resetRuntime", "getSnapshot", "onEvent"]) {
      assert.match(code, new RegExp(name));
    }
    assert.doesNotMatch(code, /child_process/);
    assert.doesNotMatch(code, /node:fs/);
  });

  it("no P5.15 scope leaked into the passive UI (smoke-terminal harness is P5.14-owned, no scheduler)", () => {
    const pane = strip(readFileSync(join(appRoot, "src", "ui", "TerminalPane.tsx"), "utf8"));
    const model = strip(readFileSync(join(appRoot, "src", "model", "terminal-runtime.ts"), "utf8"));
    const app = strip(readFileSync(join(appRoot, "src", "App.tsx"), "utf8"));
    // P5.14 owns the visual-smoke harness in App (identifiers-only auto-Run +
    // xterm callback proof) and TerminalPane (write-callback seq recording).
    // The passive model stays pure (no smoke harness); wait scheduling (P8),
    // PTY and P5.15 gate artifacts stay out everywhere.
    assert.match(app, /smoke-terminal/);
    assert.match(pane, /__cfSmokeTerminal/);
    assert.doesNotMatch(model, /smoke-terminal|SmokeTerminal/);
    for (const entry of [["TerminalPane", pane], ["terminal-runtime", model], ["App", app]] as const) {
      const code = entry[1];
      assert.doesNotMatch(code, /waitForProcessOutput|PortReadiness/);
      assert.doesNotMatch(code, /node-pty|PtyExecutionAdapter/);
      assert.doesNotMatch(code, /validate-p5\.mjs|ADR-0010|P5-REAL-TERMINAL/);
    }
    // The harness never widens execution: identifiers only, stdin still
    // disabled, no input forwarding.
    assert.doesNotMatch(pane, /\.onData\s*\(/);
    assert.match(pane, /disableStdin/);
  });
});
