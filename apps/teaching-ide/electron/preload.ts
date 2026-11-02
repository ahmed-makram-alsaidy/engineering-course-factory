// Preload bridge — the renderer's ENTIRE access to the outside world.
//
// P4 baseline (preserved): getMeta / loadLesson / reportReady.
// P5.11 Safe IPC addition (design "Security Boundary" table): cfApi.terminal
// with exactly five identifier-only invoke methods (runOperation, stopProcess,
// cancelOperation, resetRuntime, getSnapshot) plus the preload-local onEvent
// subscription (copied DTO + unsubscribe; no IPC payload, no Electron event).
// P6.12 Safe IPC addition (design section 15, cfApi.editor): exactly four
// identifier-only invoke methods (runOperation, cancelOperation, getSnapshot,
// acknowledgePresentation) plus the preload-local onEvent/onPresentation
// subscriptions (copied DTOs + unsubscribe). There is deliberately NO editor
// reset channel: reset routes through the shared lifecycle owner (P6.13+).
//
// The renderer NEVER supplies paths, source text, find/replace literals,
// timing policy, save bytes, revisions, roots or access modes: every editor
// payload is identifiers (and one safe replay cursor) only — enforced by the
// engine's strict schemas in main, not by this forwarder.
// No fs, no child_process, no shell, no process, no Docker, no PTY, no
// generic invoke/send/execute channel is exposed. Type-only protocol imports
// are the only engine contact here (design: "type-only protocol okay").

import { contextBridge, ipcRenderer } from "electron";
import type {
  RuntimeEvent,
  TerminalSnapshotPage,
} from "@course-factory/terminal-engine";
import type { StartReceipt, StopResult } from "@course-factory/terminal-engine";
import type { SafeSessionDescriptor } from "@course-factory/terminal-engine/terminal-host";
import type {
  BrowserOperationReceipt,
  BrowserRuntimeEvent,
  BrowserSnapshotPage,
  SafeBrowserSessionDescriptor,
} from "@course-factory/browser-engine";
import type {
  GlobalRuntimeEvent,
  RuntimeSnapshotDto,
  SafeRuntimeSessionDescriptor,
  RuntimeErrorDto,
} from "@course-factory/runtime-orchestrator";

export interface TerminalInvokeError {
  ok: false;
  code: string;
  message: string;
}

export interface TerminalApi {
  runOperation(request: { session_id: string; operation_id: string; request_id: string }): Promise<
    { ok: true; receipt: StartReceipt } | TerminalInvokeError
  >;
  stopProcess(request: { session_id: string; process_id: string; request_id: string }): Promise<
    { ok: true; stop: StopResult } | TerminalInvokeError
  >;
  cancelOperation(request: { session_id: string; operation_id: string; request_id: string }): Promise<
    { ok: true; stop: StopResult } | TerminalInvokeError
  >;
  resetRuntime(request: { session_id: string; request_id: string }): Promise<
    { ok: true; session: SafeSessionDescriptor } | TerminalInvokeError
  >;
  getSnapshot(request: { session_id: string; after_seq: number }): Promise<
    { ok: true; page: TerminalSnapshotPage } | TerminalInvokeError
  >;
  /**
   * Preload-local event subscription: copied journal DTOs pushed by main over
   * the terminal:event channel. Returns an unsubscribe function. No IPC
   * payload, no Electron event object leaks to the renderer.
   */
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
}

const terminalApi: TerminalApi = {
  runOperation: (request) => ipcRenderer.invoke("terminal:runOperation", request),
  stopProcess: (request) => ipcRenderer.invoke("terminal:stopProcess", request),
  cancelOperation: (request) => ipcRenderer.invoke("terminal:cancelOperation", request),
  resetRuntime: (request) => ipcRenderer.invoke("terminal:resetRuntime", request),
  getSnapshot: (request) => ipcRenderer.invoke("terminal:getSnapshot", request),
  onEvent: (listener) => {
    const wrapped = (_event: unknown, dto: unknown) => {
      listener(structuredClone(dto) as RuntimeEvent);
    };
    ipcRenderer.on("terminal:event", wrapped);
    return () => {
      ipcRenderer.removeListener("terminal:event", wrapped);
    };
  },
};

export interface EditorInvokeError {
  ok: false;
  code: string;
  message: string;
}

/**
 * P6.12 narrow editor surface: exactly four identifier-only invoke methods
 * plus two preload-local subscriptions. Payloads are opaque unknowns here
 * (identifiers and one safe cursor only); main enforces strict shapes.
 * Acknowledgements are identifier-only receipts; renderer text can never
 * flow back through this bridge by construction (no such method exists).
 */
export interface EditorApi {
  runOperation(request: unknown): Promise<unknown>;
  cancelOperation(request: unknown): Promise<unknown>;
  getSnapshot(request: unknown): Promise<unknown>;
  acknowledgePresentation(request: unknown): Promise<unknown>;
  /**
   * Preload-local journal subscription: copied event DTOs pushed by main
   * over the editor:event channel. Returns an unsubscribe function.
   */
  onEvent(listener: (event: unknown) => void): () => void;
  /**
   * Preload-local presentation subscription: copied trusted frames pushed
   * by main over the editor:presentation channel. Returns an unsubscribe
   * function. Frames are display data only, never execution authority.
   */
  onPresentation(listener: (frame: unknown) => void): () => void;
}

const editorApi: EditorApi = {
  runOperation: (request) => ipcRenderer.invoke("editor:runOperation", request),
  cancelOperation: (request) => ipcRenderer.invoke("editor:cancelOperation", request),
  getSnapshot: (request) => ipcRenderer.invoke("editor:getSnapshot", request),
  acknowledgePresentation: (request) => ipcRenderer.invoke("editor:acknowledgePresentation", request),
  onEvent: (listener) => {
    const wrapped = (_event: unknown, dto: unknown) => {
      listener(structuredClone(dto) as unknown);
    };
    ipcRenderer.on("editor:event", wrapped);
    return () => {
      ipcRenderer.removeListener("editor:event", wrapped);
    };
  },
  onPresentation: (listener) => {
    const wrapped = (_event: unknown, dto: unknown) => {
      listener(structuredClone(dto) as unknown);
    };
    ipcRenderer.on("editor:presentation", wrapped);
    return () => {
      ipcRenderer.removeListener("editor:presentation", wrapped);
    };
  },
};

export interface BrowserInvokeError {
  ok: false;
  code: string;
  message: string;
}

/**
 * P7.6 narrow browser surface: exactly four identifier-only invoke methods
 * plus two preload-local subscriptions. Payloads are identifiers only;
 * main resolves parameters from reviewed compiled IR.
 */
export interface BrowserApi {
  runOperation(request: {
    session_id: string;
    operation_id: string;
    request_id: string;
  }): Promise<{ ok: true; receipt: BrowserOperationReceipt } | BrowserInvokeError>;
  cancelOperation(request: {
    session_id: string;
    operation_id: string;
    request_id: string;
  }): Promise<{ ok: true; cancelled: boolean } | BrowserInvokeError>;
  getSnapshot(request: {
    session_id: string;
    after_seq: number;
  }): Promise<{ ok: true; page: BrowserSnapshotPage } | BrowserInvokeError>;
  resetRuntime(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; session: SafeBrowserSessionDescriptor } | BrowserInvokeError>;
  /**
   * Preload-local journal subscription: copied event DTOs pushed by main
   * over the browser:event channel. Returns an unsubscribe function.
   */
  onEvent(listener: (event: BrowserRuntimeEvent) => void): () => void;
  /**
   * Preload-local frame subscription: copied visual frames pushed
   * by main over the browser:frame channel. Returns an unsubscribe function.
   */
  onFrame(listener: (frame: unknown) => void): () => void;
}

const browserApi: BrowserApi = {
  runOperation: (request) => ipcRenderer.invoke("browser:runOperation", request),
  cancelOperation: (request) => ipcRenderer.invoke("browser:cancelOperation", request),
  getSnapshot: (request) => ipcRenderer.invoke("browser:getSnapshot", request),
  resetRuntime: (request) => ipcRenderer.invoke("browser:resetRuntime", request),
  onEvent: (listener) => {
    const wrapped = (_event: unknown, dto: unknown) => {
      listener(structuredClone(dto) as BrowserRuntimeEvent);
    };
    ipcRenderer.on("browser:event", wrapped);
    return () => {
      ipcRenderer.removeListener("browser:event", wrapped);
    };
  },
  onFrame: (listener) => {
    const wrapped = (_event: unknown, dto: unknown) => {
      listener(structuredClone(dto) as unknown);
    };
    ipcRenderer.on("browser:frame", wrapped);
    return () => {
      ipcRenderer.removeListener("browser:frame", wrapped);
    };
  },
};

export interface RuntimeInvokeError {
  ok: false;
  code: string;
  message: string;
  error?: RuntimeErrorDto;
}

/**
 * P8.7 narrow runtime surface: exactly six identifier-only invoke methods
 * plus one preload-local subscription. Payloads are identifiers only;
 * main resolves parameters from reviewed compiled IR and ValidatedRuntimePlan.
 */
export interface RuntimeApi {
  startLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeInvokeError>;
  pauseLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeInvokeError>;
  resumeLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeInvokeError>;
  cancelLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeInvokeError>;
  resetLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; session: SafeRuntimeSessionDescriptor; snapshot: RuntimeSnapshotDto } | RuntimeInvokeError>;
  getSnapshot(request: {
    session_id: string;
    after_seq?: number;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeInvokeError>;
  /**
   * Preload-local journal subscription: copied event DTOs pushed by main
   * over the runtime:event channel. Returns an unsubscribe function.
   */
  onEvent(listener: (event: GlobalRuntimeEvent) => void): () => void;
}

const runtimeApi: RuntimeApi = {
  startLesson: (request) => ipcRenderer.invoke("runtime:startLesson", request),
  pauseLesson: (request) => ipcRenderer.invoke("runtime:pauseLesson", request),
  resumeLesson: (request) => ipcRenderer.invoke("runtime:resumeLesson", request),
  cancelLesson: (request) => ipcRenderer.invoke("runtime:cancelLesson", request),
  resetLesson: (request) => ipcRenderer.invoke("runtime:resetLesson", request),
  getSnapshot: (request) => ipcRenderer.invoke("runtime:getSnapshot", request),
  onEvent: (listener) => {
    const wrapped = (_event: unknown, dto: unknown) => {
      listener(structuredClone(dto) as GlobalRuntimeEvent);
    };
    ipcRenderer.on("runtime:event", wrapped);
    return () => {
      ipcRenderer.removeListener("runtime:event", wrapped);
    };
  },
};

const api = {
  getMeta: () => ipcRenderer.invoke("app:getMeta"),
  loadLesson: (fixtureId: string) => ipcRenderer.invoke("lesson:load", fixtureId),
  reportReady: (report: unknown) => ipcRenderer.send("app:ready", report),
  terminal: terminalApi,
  editor: editorApi,
  browser: browserApi,
  runtime: runtimeApi,
  /**
   * P6.15 visual-proof display-data subscription (main-to-renderer ONLY).
   * Carries bounded REAL terminal-observation DTOs pushed by main over the
   * p615:observation channel during --smoke-p615 runs. There is deliberately
   * NO invoke surface here: the renderer cannot request, shape or replay
   * observations — it only renders main-pushed bytes. Production (non-smoke)
   * runs never push on this channel. Returns an unsubscribe function.
   */
  onP615Observation: (listener: (observation: unknown) => void): (() => void) => {
    const wrapped = (_event: unknown, dto: unknown) => {
      listener(structuredClone(dto) as unknown);
    };
    ipcRenderer.on("p615:observation", wrapped);
    return () => {
      ipcRenderer.removeListener("p615:observation", wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("cfApi", api);

export type CfApi = typeof api;
