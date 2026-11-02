// Editor pane: tabs + Monaco. Content changes ONLY through explicit user
// typing in inspection mode. Lesson playback never writes into the editor
// through keystrokes (P6 owns typing): in P6.12 playback mode the pane
// projects main-owned document snapshots and trusted presentation frames
// through direct model edits and reports identifier-only receipts.
import { useEffect, useMemo, useRef } from "react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import type { EditorTabsState } from "../model/editor.ts";

// Local, offline worker wiring — Monaco never touches a CDN.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
        return new cssWorker();
      case "html":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

monaco.editor.defineTheme("cf-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#10151b",
    "editor.foreground": "#d9e0e7",
    "editorLineNumber.foreground": "#5a6570",
    "editorLineNumber.activeForeground": "#97a3b0",
    "editor.selectionBackground": "#2c5c52",
    "editor.lineHighlightBackground": "#171d25",
    "editorCursor.foreground": "#3fb59a",
    "editorIndentGuide.background1": "#1e2630",
    "editorGutter.background": "#10151b",
    "minimap.background": "#10151b",
  },
});

interface Props {
  state: EditorTabsState;
  contentOf(path: string): string;
  languageOf(path: string): string;
  fontSize: number;
  onSelectTab(path: string): void;
  onCloseTab(path: string): void;
  onUserInput(path: string, content: string): void;
  onMonacoReady(): void;
  onMonacoFailed(message: string): void;
  /**
   * P6.12 trusted playback projection (absent in inspection mode). When
   * present the pane is read-only: Monaco models project main-owned buffer
   * text and trusted frames, dirty truth comes from main flags, and every
   * applied frame yields one identifier-only receipt through onPlaybackAck.
   * Renderer text is display state only and is never sent back.
   */
  playback?: EditorPlaybackProjection;
  onPlaybackAck?: (receipt: PlaybackFrameReceipt) => void;
  onPlaybackTab?: (documentId: string) => void;
  /**
   * P6.15 visual-proof readback (renderer-internal, display state only).
   * Called with the live Monaco model text after snapshot projection and
   * after each applied trusted frame. It is diagnostics only: the text is
   * never sent back through IPC (acknowledgements stay identifier-only).
   * Production runs leave this unset.
   */
  onPlaybackModelText?: (documentId: string, text: string) => void;
  /** Language for trusted playback models (lesson-relative path in, language id out). */
  languageOfPlayback?: (portablePath: string) => string;
}

/**
 * One main-owned document for display (identifiers + lesson-relative path
 * + exact buffer text as UI content + main-owned flags). No host paths.
 */
export interface PlaybackDocument {
  readonly document_id: string;
  readonly portable_path: string;
  readonly content: string;
  readonly dirty: boolean;
  readonly pending_creation: boolean;
}

/**
 * One trusted presentation frame (display data only). Positions are UTF-16
 * line/column pairs resolved main-side; the renderer never recomputes
 * matching, offsets or timing from authored content.
 */
export interface PlaybackFrame {
  readonly kind: "type_chunk" | "replace_step";
  readonly session_id: string;
  readonly generation: number;
  readonly document_id: string;
  readonly operation_id: string;
  readonly plan_id: string;
  /** chunk_seq for type frames, step_seq for replace steps. */
  readonly seq: number;
  readonly step_kind?: "highlight" | "remove" | "insert";
  readonly text: string;
  readonly start: { line: number; column_utf16: number };
  readonly end: { line: number; column_utf16: number };
}

export interface EditorPlaybackProjection {
  readonly session_id: string;
  readonly generation: number;
  readonly documents: readonly PlaybackDocument[];
  /** Trusted frames in main-issued order (applied exactly once each). */
  readonly frames: readonly PlaybackFrame[];
  readonly activeDocumentId: string | null;
  readonly recordingSafe: boolean;
}

/** Identifier-only presentation receipt (the ONLY thing sent back). */
export interface PlaybackFrameReceipt {
  readonly session_id: string;
  readonly generation: number;
  readonly document_id: string;
  readonly operation_id: string;
  readonly plan_id: string;
  readonly chunk_seq: number;
}

/** Generation/document-scoped virtual model URI (host paths absent by construction). */
export function playbackModelUri(generation: number, documentId: string, sessionId?: string): string {
  if (sessionId) return `cf-editor://${encodeURIComponent(sessionId)}/${generation}/${encodeURIComponent(documentId)}`;
  return `cf-editor://${generation}/${encodeURIComponent(documentId)}`;
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export function EditorPane(props: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const readyReportedRef = useRef(false);
  const failedRef = useRef(false);

  const active = props.state.active;
  const activeContent = active !== undefined && active !== null ? props.contentOf(active) : "";

  // Create the editor once.
  useEffect(() => {
    if (!hostRef.current || editorRef.current) return;
    try {
      editorRef.current = monaco.editor.create(hostRef.current, {
        theme: "cf-dark",
        fontSize: props.fontSize,
        fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
        minimap: { enabled: false },
        lineNumbers: "on",
        renderWhitespace: "boundary",
        scrollBeyondLastLine: false,
        automaticLayout: false,
        fixedOverflowWidgets: true,
        wordWrap: "off",
        tabSize: 2,
      });
      if (!readyReportedRef.current) {
        readyReportedRef.current = true;
        props.onMonacoReady();
      }
    } catch (error) {
      if (!failedRef.current) {
        failedRef.current = true;
        props.onMonacoFailed(error instanceof Error ? error.message : String(error));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep fontSize in sync.
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: props.fontSize });
  }, [props.fontSize]);

  // Switch models when the active file changes (inspection mode only; the
  // playback effect below owns the model while a trusted session projects).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || active === null || props.playback !== undefined) return;
    const uri = monaco.Uri.parse(`inmemory:///${active}`);
    let model = monaco.editor.getModel(uri) ?? modelsRef.current.get(active) ?? null;
    if (!model || model.isDisposed()) {
      const created = monaco.editor.createModel(activeContent, props.languageOf(active), uri);
      modelsRef.current.set(active, created);
      created.onDidChangeContent(() => props.onUserInput(active, created.getValue()));
      model = created;
    }
    if (editor.getModel() !== model) editor.setModel(model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, props.playback]);

  // -- P6.12 trusted playback projection ------------------------------------
  // Monaco is a disposable projection of main-owned buffers: models are
  // keyed by main-issued document_id under generation-scoped virtual URIs
  // (host paths absent), snapshots re-anchor exact text, trusted frames
  // apply once each through direct model edits (never keystrokes), and every
  // applied frame yields one identifier-only receipt. Renderer text is
  // display state only and is never sent back.
  const playback = props.playback ?? null;
  const playbackKey = playback === null ? "inspection" : `${playback.session_id}:${playback.generation}`;
  const playbackModelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const appliedFrameSeqRef = useRef(new Map<string, number>());

  // Generation/session rotation disposes stale models and receipts: old
  // Monaco state must never survive as current authority. Detach the model
  // from the editor first so Monaco does not hold a disposed reference.
  useEffect(() => {
    if (editorRef.current) {
      try {
        editorRef.current.setModel(null);
      } catch {
        // Detach races unmount; model disposal below still runs.
      }
    }
    for (const model of playbackModelsRef.current.values()) {
      try {
        model.dispose();
      } catch {
        // Disposal races unmount; the map is still cleared below.
      }
    }
    playbackModelsRef.current.clear();
    appliedFrameSeqRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackKey]);

  // Playback input authority: read-only with no typing, paste, drop, undo,
  // formatting or code actions. Inspection mode keeps the historical
  // editable surface untouched.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (playback === null) {
      editor.updateOptions({
        readOnly: false,
        quickSuggestions: true,
        suggestOnTriggerCharacters: true,
        codeLens: true,
        formatOnType: false,
        formatOnPaste: false,
        autoClosingBrackets: "languageDefined",
        autoClosingQuotes: "languageDefined",
        acceptSuggestionOnEnter: "on",
      });
      return;
    }
    editor.updateOptions({
      readOnly: true,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      codeLens: false,
      formatOnType: false,
      formatOnPaste: false,
      autoClosingBrackets: "never",
      autoClosingQuotes: "never",
      acceptSuggestionOnEnter: "off",
      tabCompletion: "off",
      parameterHints: { enabled: false },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback === null, playbackKey]);

  // Project snapshots: create the one model per logical document and
  // re-anchor exact text when main publishes a newer buffer (open, cancel
  // restore, reset reseed, verified save). Text equality guards against
  // clobbering incrementally applied frames on unrelated re-renders.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || playback === null) return;
    const seen = new Set<string>();
    const knownKeys = new Map<string, string>();
    for (const [id, model] of playbackModelsRef.current) {
      if (model.isDisposed()) {
        playbackModelsRef.current.delete(id);
        continue;
      }
      seen.add(id);
    }
    for (const document of playback.documents) {
      const canonicalKey = document.portable_path.toLowerCase();
      const aliasOwner = knownKeys.get(canonicalKey);
      if (aliasOwner !== undefined && aliasOwner !== document.document_id) continue;
      knownKeys.set(canonicalKey, document.document_id);
      let model = playbackModelsRef.current.get(document.document_id) ?? null;
      if (!model || model.isDisposed()) {
        const uri = monaco.Uri.parse(playbackModelUri(playback.generation, document.document_id, playback.session_id));
        const existing = monaco.editor.getModel(uri);
        if (existing && !existing.isDisposed()) {
          model = existing;
        } else {
          model = monaco.editor.createModel(document.content, props.languageOfPlayback?.(document.portable_path) ?? "plaintext", uri);
        }
        playbackModelsRef.current.set(document.document_id, model);
      }
      // Guarded listener: playback content changes are display-only and are
      // never forwarded as semantic input (no onUserInput wiring here).
      if (model.getValue() !== document.content) {
        try {
          model.setValue(document.content);
        } catch {
          // A disposal racing the sync leaves the next snapshot to re-anchor.
        }
      }
      // P6.15 visual-proof readback: live Monaco text for checkpoint
      // diagnostics (display state only, never IPC authority).
      try {
        props.onPlaybackModelText?.(document.document_id, model.getValue());
      } catch {
        // Diagnostics must never break projection.
      }
    }
    // Dispose models for documents main no longer projects.
    for (const id of [...playbackModelsRef.current.keys()]) {
      if (!seen.has(id) && !playback.documents.some((document) => document.document_id === id)) {
        try {
          playbackModelsRef.current.get(id)?.dispose();
        } catch {
          // Best-effort.
        }
        playbackModelsRef.current.delete(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback?.documents, playbackKey]);

  // Apply trusted frames exactly once each, in main-issued order, through
  // direct model edits. Highlight selects only; remove/insert splice exact
  // trusted ranges. Stale generations, duplicates and gaps never mutate.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || playback === null) return;
    for (const frame of playback.frames) {
      if (frame.session_id !== playback.session_id || frame.generation !== playback.generation) continue;
      const expected = appliedFrameSeqRef.current.get(frame.plan_id) ?? 0;
      if (frame.seq < expected) continue;
      if (frame.seq > expected) continue;
      const model = playbackModelsRef.current.get(frame.document_id) ?? null;
      if (!model || model.isDisposed()) continue;
      try {
        if (frame.kind === "type_chunk") {
          model.pushEditOperations([], [{ range: new monaco.Range(frame.start.line, frame.start.column_utf16, frame.start.line, frame.start.column_utf16), text: frame.text }], () => null);
        } else if (frame.step_kind === "remove") {
          model.pushEditOperations([], [{ range: new monaco.Range(frame.start.line, frame.start.column_utf16, frame.end.line, frame.end.column_utf16), text: "" }], () => null);
        } else if (frame.step_kind === "insert") {
          model.pushEditOperations([], [{ range: new monaco.Range(frame.start.line, frame.start.column_utf16, frame.start.line, frame.start.column_utf16), text: frame.text }], () => null);
        } else if (editor.getModel() === model) {
          editor.setSelections([new monaco.Selection(frame.start.line, frame.start.column_utf16, frame.end.line, frame.end.column_utf16)]);
        }
      } catch {
        continue;
      }
      appliedFrameSeqRef.current.set(frame.plan_id, expected + 1);
      // P6.15 visual-proof readback: live Monaco text after the applied
      // frame (display state only, never IPC authority).
      try {
        props.onPlaybackModelText?.(frame.document_id, model.getValue());
      } catch {
        // Diagnostics must never break projection or acknowledgement.
      }
      try {
        props.onPlaybackAck?.({
          session_id: frame.session_id,
          generation: frame.generation,
          document_id: frame.document_id,
          operation_id: frame.operation_id,
          plan_id: frame.plan_id,
          chunk_seq: frame.seq,
        });
      } catch {
        // Ack delivery failures never roll back an applied frame; main
        // treats a missing ack as withheld progress (fail-closed), and the
        // next snapshot re-anchors the projection.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback?.frames, playbackKey]);

  // Focus the main-selected document without ever choosing open targets.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || playback === null || playback.activeDocumentId === null) return;
    const model = playbackModelsRef.current.get(playback.activeDocumentId) ?? null;
    if (model && !model.isDisposed() && editor.getModel() !== model) editor.setModel(model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback?.activeDocumentId, playback?.documents, playbackKey]);

  // Layout on resize.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => editorRef.current?.layout());
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const tabItems = useMemo(() => props.state.open.map((path) => ({ path, label: basename(path), dirty: props.state.dirty.includes(path) })), [props.state]);

  // Playback tabs project main-owned identity: lesson-relative labels with
  // main-owned dirty dots. No host paths, no close affordance (models are
  // session-owned; reset disposes them through the generation effect).
  const playbackTabs = useMemo(() => {
    if (playback === null) return null;
    const seen = new Set<string>();
    const tabs: { id: string; label: string; title: string; dirty: boolean; pending: boolean }[] = [];
    for (const document of playback.documents) {
      const key = document.portable_path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tabs.push({ id: document.document_id, label: basename(document.portable_path), title: document.portable_path, dirty: document.dirty, pending: document.pending_creation });
    }
    return tabs;
  }, [playback]);

  return (
    <section className="panel" aria-label="Editor">
      <div className="tabs">
        {playbackTabs !== null && playbackTabs.length === 0 && <div className="tab" style={{ cursor: "default" }}>no file open</div>}
        {playbackTabs !== null && playbackTabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${playback?.activeDocumentId === tab.id ? "active" : ""}`}
            onClick={() => props.onPlaybackTab?.(tab.id)}
            title={tab.title}
          >
            <span>
              {tab.label}
              {tab.pending ? " +" : ""}
              {tab.dirty ? " ●" : ""}
            </span>
          </div>
        ))}
        {playbackTabs === null && tabItems.length === 0 && <div className="tab" style={{ cursor: "default" }}>no file open</div>}
        {playbackTabs === null && tabItems.map((tab) => (
          <div
            key={tab.path}
            className={`tab ${tab.path === active ? "active" : ""}`}
            onClick={() => props.onSelectTab(tab.path)}
            title={tab.path}
          >
            <span>
              {tab.label}
              {tab.dirty ? " ●" : ""}
            </span>
            <button className="close" onClick={(event) => { event.stopPropagation(); props.onCloseTab(tab.path); }} aria-label={`Close ${tab.label}`}>
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="panel-body editor-host">
        <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      </div>
    </section>
  );
}
