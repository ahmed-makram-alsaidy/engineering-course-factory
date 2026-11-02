// Terminal panel — P5.12 Passive UI over the existing xterm display surface.
//
// Canonical architecture: docs/P5-DESIGN-SPEC.md, task P5.12 "Passive UI"
// (DTO/bridge in; App/TerminalPane/model/CSS/tests owned; Run/stop/reset/
// clear/replay/stdin-disabled behavior; PASS: Real output, navigation inert)
// plus "Teaching IDE Integration", "Replay and display synchronization",
// "Record Safe Mode" and "Error Model" sections.
//
// OWNERSHIP (design-exact, no phase creep):
//   - This pane CONSUMES structured runtime events from the trusted
//     SessionJournal/TerminalHost path (five identifier-only IPC methods +
//     preload-local onEvent). It never synthesizes canonical runtime events,
//     never executes, never opens navigation, clipboard, title, or links.
//   - The xterm surface stays display-only: disableStdin is true and no input
//     handler is attached (no onData forwarding; child stdin stays closed).
//   - Run sends identifiers only (session_id/operation_id/request_id) for the
//     playhead's granted not-yet-run terminal operation; no selection
//     execution exists. Authored stops run through Run; safety stops use the
//     Stop (background) / Cancel (foreground) buttons. Starts stay disabled
//     during teardown/reset until removal.
//   - Replay: subscribe BEFORE the snapshot read; buffer arrivals; apply pages
//     at the cursor, then newer live events. Duplicates ignored, gaps counted
//     and ignored, reset pages re-anchor. Remount/session-switch replays the
//     correct generation. Stale owner events are ignored by the model.
//   - Per-process transcripts stay separate (stdout/stderr never blended);
//     display lines carry an explicit [operation/process stream] prefix.
//   - Clear is display-only (xterm clear + display-line drop; logs, processes,
//     readiness and badges are retained).
//   - Record Safe Mode shows /workspace-relative labels and synthetic IDs
//     only — never host paths, container IDs, or diagnostics.
//   - Errors render as short UI-safe messages from the structured code only.
import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { compileOperationDescriptor } from "../model/operation-display.ts";
import type { CompiledStep } from "../model/ir.ts";
import type { SafeSessionDescriptor } from "../model/bridge.ts";
import {
  applyTerminalRuntimeEvent,
  applyTerminalSnapshotPage,
  clearTerminalDisplay,
  createTerminalRequestId,
  formatTerminalCwdForDisplay,
  initialTerminalRuntimeView,
  isTerminalRunEligible,
  summarizeTerminalResultForBadge,
  terminalUiSafeError,
  type TerminalRuntimeView,
} from "../model/terminal-runtime.ts";
import type { RuntimeEvent } from "@course-factory/terminal-engine";

interface Props {
  currentStep: CompiledStep | null;
  highlighted: boolean;
  onXtermReady(): void;
  /** Safe session facts from lesson:load (identifiers + digest only). Null while unavailable. */
  session?: SafeSessionDescriptor | null;
  /** Execution authorization for the open lesson (catalog-reviewed only). */
  executionAuthorized?: boolean;
  /** Recording Safe Mode: hide dev-only detail, keep /workspace labels. */
  recordingSafe?: boolean;
  /** Main updates the descriptor after reset (new generation). */
  onSessionUpdated?(session: SafeSessionDescriptor): void;
  /**
   * P6.15 visual-proof observations (main-pushed REAL terminal bytes only).
   * Rendered verbatim into xterm as display lines with a [p615 <phase>]
   * prefix. The bytes originate from actual Docker-epoch execution against
   * the verified saved leaf — never fixture text. Production runs pass none.
   */
  p615Observations?: readonly P615Observation[];
}

/**
 * One REAL terminal observation pushed by main during --smoke-p615 runs
 * (display data only: bounded stdout of actual guest execution, no host
 * paths, no container identity).
 */
export interface P615Observation {
  readonly smokeP615: true;
  readonly seq: number;
  readonly phase: "before-save" | "denied-write" | "after-save" | "run";
  readonly target: string;
  readonly exit_code: number | null;
  readonly stdout: string;
}

declare global {
  interface Window {
    __cfSmokeP615?: boolean;
    __cfSmokeP615RenderedSeqs?: number[];
  }
}

const BANNER = [
  "Course Factory — Teaching IDE \x1b[36m(passive terminal)\x1b[0m",
  "Structured runtime output appears below. Keystrokes are never sent.",
  "",
].join("\r\n");

function cwdOf(step: CompiledStep | null): string {
  if (step?.kind !== "operation") return "/workspace";
  const params = step.operation.parameters as Record<string, unknown>;
  const raw = params.cwd;
  if (typeof raw !== "string" || raw.length === 0) return "/workspace";
  return formatTerminalCwdForDisplay(raw);
}

export function TerminalPane(props: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const readyRef = useRef(false);
  const session = props.session ?? null;
  const executionAuthorized = props.executionAuthorized ?? session?.execution_authorized ?? false;
  const recordingSafe = props.recordingSafe ?? false;

  const [view, setView] = useState<TerminalRuntimeView>(() =>
    initialTerminalRuntimeView({
      session_id: session?.session_id ?? "no-session",
      generation: session?.generation ?? 1,
    }),
  );
  const [busy, setBusy] = useState<"idle" | "running" | "cancelling" | "resetting">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedOp, setSelectedOp] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const lastWrittenSeqRef = useRef(0);
  const lastMetaRef = useRef<string | null>(null);

  // Reset the derived view when the owned session identity changes
  // (lesson switch / reset generation). Replay below re-anchors from the
  // journal; stale-generation events stay ignored by the model.
  const sessionKey = session === null ? "no-session" : `${session.session_id}:${session.generation}`;
  useEffect(() => {
    if (session === null) {
      setView(initialTerminalRuntimeView({ session_id: "no-session", generation: 1 }));
    } else {
      setView(initialTerminalRuntimeView({ session_id: session.session_id, generation: session.generation }));
    }
    setSelectedOp(null);
    setNotice(null);
    setBusy("idle");
    lastWrittenSeqRef.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // xterm surface: created once, display-only (stdin disabled, no input path).
  useEffect(() => {
    if (!hostRef.current || termRef.current) return;
    const terminal = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      theme: {
        background: "#10151b",
        foreground: "#d9e0e7",
        cursor: "#3fb59a",
        selectionBackground: "#2c5c52",
        black: "#10151b",
        green: "#58b56b",
        yellow: "#d7a94c",
        red: "#e06c6c",
        cyan: "#3fb59a",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    terminal.write(BANNER);
    termRef.current = terminal;
    fitRef.current = fit;
    if (!readyRef.current) {
      readyRef.current = true;
      props.onXtermReady();
    }
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(hostRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trusted subscription + bounded replay: subscribe BEFORE the snapshot read,
  // buffer arrivals during page reads, apply pages at the cursor, then live.
  useEffect(() => {
    const api = window.cfApi?.terminal;
    if (!api || !session) return;
    let disposed = false;
    const buffered: RuntimeEvent[] = [];
    let live = false;
    const applyBuffered = (): void => {
      if (buffered.length === 0) return;
      const pending = buffered.splice(0, buffered.length);
      setView((prev) => {
        let next = prev;
        for (const event of pending) next = applyTerminalRuntimeEvent(next, event);
        return next;
      });
    };
    const unsubscribe = api.onEvent((event: RuntimeEvent) => {
      if (disposed) return;
      if (!live) {
        if (buffered.length < 1024) buffered.push(event);
        return;
      }
      setView((prev) => applyTerminalRuntimeEvent(prev, event));
    });
    const replay = async (): Promise<void> => {
      try {
        let cursor = 0;
        for (let pages = 0; pages < 8; pages += 1) {
          if (disposed) return;
          const response = await api.getSnapshot({ session_id: session.session_id, after_seq: cursor });
          if (disposed) return;
          if (!response.ok) break;
          const page = response.page;
          // Generation fence: a reset moved the session; stop replaying here.
          if (page.generation !== session.generation || page.session_id !== session.session_id) break;
          setView((prev) => applyTerminalSnapshotPage(prev, page));
          if (page.events.length === 0 || page.page_end_seq >= page.journal_high_seq) {
            cursor = page.page_end_seq;
            break;
          }
          cursor = page.page_end_seq;
        }
        if (disposed) return;
        live = true;
        applyBuffered();
      } catch {
        if (!disposed) setNotice("Replay unavailable — live output continues.");
      }
    };
    void replay();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [sessionKey]);

  // Render new trusted display lines to xterm (write callback observed).
  // P5.14 visual smoke: when the smoke-terminal flag is set, each write
  // callback records its journal seq so the renderer can prove the same seq
  // the journal authorized was actually rendered (screenshot/boolean alone is
  // insufficient per design). Ordinary runs record nothing.
  useEffect(() => {
    const terminal = termRef.current;
    if (!terminal) return;
    const lines = view.displayLines.filter((line) => line.seq > lastWrittenSeqRef.current);
    if (lines.length === 0) return;
    lastWrittenSeqRef.current = lines[lines.length - 1].seq;
    const visible =
      selectedOp === null ? lines : lines.filter((line) => line.text.includes(`[${selectedOp}`) || line.text.startsWith("[session]"));
    for (const line of visible) {
      const seq = line.seq;
      terminal.write(`${line.text}\r\n`, () => {
        try {
          const flagged = (window as unknown as { __cfSmokeTerminal?: boolean }).__cfSmokeTerminal === true;
          if (flagged) {
            const holder = window as unknown as { __cfSmokeTerminalRenderedSeqs?: number[] };
            const arr = (holder.__cfSmokeTerminalRenderedSeqs ??= []);
            arr.push(seq);
          }
        } catch {
          // Never break rendering for smoke bookkeeping.
        }
      });
    }
  }, [view.displayLines, selectedOp]);

  // P6.15 visual-proof observations: main-pushed REAL terminal bytes
  // rendered verbatim into xterm with a [p615 <phase>] prefix. Each write
  // callback records its observation seq (when the smoke flag is set) so
  // the renderer proves the actual execution bytes were rendered —
  // screenshot/boolean alone is insufficient per design. Ordinary runs
  // receive no observations and record nothing.
  const lastP615SeqRef = useRef(0);
  const p615Observations = props.p615Observations ?? [];
  useEffect(() => {
    const terminal = termRef.current;
    if (!terminal) return;
    const pending = p615Observations.filter((observation) => observation.seq > lastP615SeqRef.current);
    if (pending.length === 0) return;
    lastP615SeqRef.current = pending[pending.length - 1].seq;
    for (const observation of pending) {
      const seq = observation.seq;
      const header = `[p615 ${observation.phase} ${observation.target} exit=${observation.exit_code ?? "?"}]`;
      terminal.write(`${header}\r\n${observation.stdout.replace(/\n/g, "\r\n")}`, () => {
        try {
          if (window.__cfSmokeP615 === true) {
            const arr = (window.__cfSmokeP615RenderedSeqs ??= []);
            arr.push(seq);
          }
        } catch {
          // Never break rendering for smoke bookkeeping.
        }
      });
    }
  }, [p615Observations]);

  // Playhead metadata line (trusted IR display data, never an execution).
  useEffect(() => {
    const step = props.currentStep;
    if (step?.kind !== "operation" || step.operation.family !== "terminal") return;
    const descriptor = compileOperationDescriptor(step.operation);
    const meta = descriptor.meta.map(([key, value]) => `${key}: ${value}`).join("  ·  ");
    if (meta === lastMetaRef.current) return;
    lastMetaRef.current = meta;
    termRef.current?.write(`\x1b[2m[${step.step_id}]\x1b[0m \x1b[36m${descriptor.title}\x1b[0m  ${meta}\r\n`, () => undefined);
  }, [props.currentStep]);

  const descriptor = useMemo(() => {
    const step = props.currentStep;
    if (step?.kind !== "operation") return null;
    return compileOperationDescriptor(step.operation);
  }, [props.currentStep]);

  const eligible = isTerminalRunEligible({ step: props.currentStep, view, executionAuthorized });
  const runningOps = useMemo(
    () => Object.values(view.operations).filter((op) => op.status === "RUNNING" && !op.completed),
    [view.operations],
  );
  const backgroundRunning = runningOps.find((op) => op.process_id !== null) ?? null;
  const foregroundRunning = runningOps.find((op) => op.process_id === null) ?? null;
  const currentOpView =
    props.currentStep?.kind === "operation" ? (view.operations[props.currentStep.step_id] ?? null) : null;
  const badge = currentOpView ? summarizeTerminalResultForBadge(currentOpView) : null;

  const runCurrent = async (): Promise<void> => {
    const api = window.cfApi?.terminal;
    if (!api || !session || props.currentStep?.kind !== "operation") return;
    setBusy("running");
    setNotice(null);
    try {
      const response = await api.runOperation({
        session_id: session.session_id,
        operation_id: props.currentStep.step_id,
        request_id: createTerminalRequestId(),
      });
      if (!response.ok) {
        setNotice(terminalUiSafeError(response.code, response.message));
      }
    } catch {
      setNotice("Run failed to reach the runtime.");
    } finally {
      setBusy("idle");
    }
  };

  const stopBackground = async (): Promise<void> => {
    const api = window.cfApi?.terminal;
    if (!api || !session || !backgroundRunning?.process_id) return;
    setBusy("cancelling");
    try {
      const response = await api.stopProcess({
        session_id: session.session_id,
        process_id: backgroundRunning.process_id,
        request_id: createTerminalRequestId(),
      });
      if (!response.ok) {
        setNotice(terminalUiSafeError(response.code, response.message));
      }
    } finally {
      setBusy("idle");
    }
  };

  const cancelForeground = async (): Promise<void> => {
    const api = window.cfApi?.terminal;
    if (!api || !session || !foregroundRunning) return;
    setBusy("cancelling");
    try {
      const response = await api.cancelOperation({
        session_id: session.session_id,
        operation_id: foregroundRunning.operation_id,
        request_id: createTerminalRequestId(),
      });
      if (!response.ok) {
        setNotice(terminalUiSafeError(response.code, response.message));
      }
    } finally {
      setBusy("idle");
    }
  };

  const resetRuntime = async (): Promise<void> => {
    const api = window.cfApi?.terminal;
    if (!api || !session) return;
    setBusy("resetting");
    try {
      const response = await api.resetRuntime({ session_id: session.session_id, request_id: createTerminalRequestId() });
      if (response.ok) {
        props.onSessionUpdated?.(response.session);
      } else {
        setNotice(terminalUiSafeError(response.code, response.message));
      }
    } finally {
      setBusy("idle");
    }
  };

  const clearDisplay = (): void => {
    // Display-only: xterm clear + display-line drop; transcripts and badges stay.
    termRef.current?.clear();
    termRef.current?.write(BANNER, () => undefined);
    lastWrittenSeqRef.current = view.appliedSeq;
    setView((prev) => clearTerminalDisplay(prev));
  };

  const cwdLabel = cwdOf(props.currentStep);
  const opIds = useMemo(() => Object.keys(view.operations), [view.operations]);

  return (
    <div className={`terminal-wrap ${props.highlighted ? "highlight" : ""}`}>
      <div className="terminal-controls" role="toolbar" aria-label="Terminal runtime controls">
        <button className="ui accent" disabled={!eligible || busy !== "idle"} onClick={() => void runCurrent()} title="Run the playhead terminal operation (identifiers only)">
          Run
        </button>
        <button className="ui" disabled={!backgroundRunning || busy !== "idle"} onClick={() => void stopBackground()} title="Stop the running background process">
          Stop
        </button>
        <button className="ui" disabled={!foregroundRunning || busy !== "idle"} onClick={() => void cancelForeground()} title="Cancel the running foreground operation">
          Cancel
        </button>
        <button className="ui" disabled={!session || busy === "resetting"} onClick={() => void resetRuntime()} title="Reset the runtime (new generation)">
          Reset
        </button>
        <button className="ui" onClick={clearDisplay} title="Clear the display (logs and results are retained)">
          Clear
        </button>
        {badge && (
          <span className={`chip terminal-badge terminal-badge-${badge.split(" ")[0].toLowerCase()}`} title="Live result from trusted runtime events">
            {badge}
          </span>
        )}
        {!executionAuthorized && session && <span className="chip">inspection only</span>}
        {view.tearingDown && !view.closed && <span className="chip">closing — starts disabled</span>}
        {recordingSafe && <span className="chip record-safe-on">record-safe</span>}
      </div>
      {descriptor && (
        <div className="terminal-meta">
          <span className="terminal-meta-command" title="Trusted display metadata (never typed)">
            {descriptor.title}
          </span>
          <span className="terminal-meta-cwd" title="Workspace-relative working directory">
            {cwdLabel}
          </span>
          {!recordingSafe && session && (
            <span className="terminal-meta-session" title="Synthetic session identity">
              {session.session_id} · gen {session.generation}
            </span>
          )}
          {recordingSafe && session && <span className="terminal-meta-session">gen {session.generation}</span>}
        </div>
      )}
      {opIds.length > 1 && (
        <div className="terminal-process-picker" role="tablist" aria-label="Per-process transcript selector">
          <button className={`ui ${selectedOp === null ? "active" : ""}`} onClick={() => setSelectedOp(null)}>
            All
          </button>
          {opIds.map((id) => (
            <button key={id} className={`ui ${selectedOp === id ? "active" : ""}`} onClick={() => setSelectedOp(id)} title={`Show only ${id}`}>
              {id}
            </button>
          ))}
        </div>
      )}
      {(notice ?? view.errorMessage) && (
        <div className="terminal-error" role="status">
          {notice ?? view.errorMessage}
        </div>
      )}
      <div className="xterm-host" ref={hostRef} />
    </div>
  );
}
