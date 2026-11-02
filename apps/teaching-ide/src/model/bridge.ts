// Typing for the preload bridge (window.cfApi). The renderer has NO Node
// access; these functions are its entire contact surface with the host.
//
// P4 baseline (preserved): getMeta / loadLesson / reportReady.
// P5.11 Safe IPC addition: cfApi.terminal — exactly the five identifier-only
// invoke methods plus the preload-local onEvent subscription. Type-only
// engine imports (design: "type-only protocol okay"); no runtime engine code,
// no Electron import, no fs/child_process/Docker/PTY surface in the renderer.
// P6.12 Safe IPC addition: cfApi.editor — exactly the four identifier-only
// invoke methods (runOperation, cancelOperation, getSnapshot,
// acknowledgePresentation) plus the preload-local onEvent/onPresentation
// subscriptions. Payloads are opaque identifier-only unknowns here; main
// enforces strict shapes. No editor reset channel exists (shared owner).
import type { CompiledLesson } from "../model/ir.ts";
import type { IrIssue } from "../model/ir.ts";
import type {
  RuntimeEvent,
  TerminalSnapshotPage,
  StartReceipt,
  StopResult,
} from "@course-factory/terminal-engine";
import type { SafeSessionDescriptor } from "@course-factory/terminal-engine/terminal-host";
import type {
  BrowserRuntimeEvent,
  BrowserVisualFrame,
  BrowserSnapshotPage,
  SafeBrowserSessionDescriptor,
} from "@course-factory/browser-engine";
import type {
  GlobalRuntimeEvent,
  RuntimeSnapshotDto,
  SafeRuntimeSessionDescriptor,
  RuntimeErrorDto,
} from "@course-factory/runtime-orchestrator";

export type { SafeSessionDescriptor, SafeBrowserSessionDescriptor, SafeRuntimeSessionDescriptor };

export interface AppMeta {
  name: string;
  version: string;
  irLoadedFrom: string;
}

export type LessonLoadResponse =
  | {
      ok: true;
      issues: [];
      ir: CompiledLesson;
      terminal?: SafeSessionDescriptor;
      editor?: SafeEditorSessionDescriptor;
      browser?: SafeBrowserSessionDescriptor;
      terminalError?: TerminalErrorDetails;
      editorError?: TerminalErrorDetails;
      browserError?: TerminalErrorDetails;
      runtime?: SafeRuntimeSessionDescriptor;
      runtimeError?: RuntimeErrorDetails;
    }
  | { ok: false; issues: IrIssue[] };

export interface TerminalErrorDetails {
  code: string;
  message: string;
}

export type TerminalError = { ok: false; code: string; message: string };

export interface TerminalBridgeApi {
  runOperation(request: { session_id: string; operation_id: string; request_id: string }): Promise<
    { ok: true; receipt: StartReceipt } | TerminalError
  >;
  stopProcess(request: { session_id: string; process_id: string; request_id: string }): Promise<
    { ok: true; stop: StopResult } | TerminalError
  >;
  cancelOperation(request: { session_id: string; operation_id: string; request_id: string }): Promise<
    { ok: true; stop: StopResult } | TerminalError
  >;
  resetRuntime(request: { session_id: string; request_id: string }): Promise<
    { ok: true; session: SafeSessionDescriptor } | TerminalError
  >;
  getSnapshot(request: { session_id: string; after_seq: number }): Promise<
    { ok: true; page: TerminalSnapshotPage } | TerminalError
  >;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
}

export interface CfApi {
  getMeta(): Promise<AppMeta>;
  loadLesson(fixtureId: string): Promise<LessonLoadResponse>;
  reportReady(report: unknown): void;
  terminal: TerminalBridgeApi;
  editor: EditorBridgeApi;
  browser: BrowserBridgeApi;
  runtime: RuntimeBridgeApi;
  /**
   * P6.15 visual-proof display-data subscription (main-to-renderer ONLY).
   * Bounded REAL terminal-observation DTOs pushed by main during
   * --smoke-p615 runs. No invoke surface: the renderer cannot request,
   * shape or replay observations. Production runs never push here.
   */
  onP615Observation(listener: (observation: unknown) => void): () => void;
}

export interface RuntimeErrorDetails {
  code: string;
  message: string;
  error?: RuntimeErrorDto;
}

export type RuntimeError = { ok: false; code: string; message: string; error?: RuntimeErrorDto };

/**
 * P8.7 narrow runtime surface: exactly six identifier-only invoke methods
 * plus one preload-local subscription.
 */
export interface RuntimeBridgeApi {
  startLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeError>;
  pauseLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeError>;
  resumeLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeError>;
  cancelLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeError>;
  resetLesson(request: {
    session_id: string;
    request_id: string;
  }): Promise<{ ok: true; session: SafeRuntimeSessionDescriptor; snapshot: RuntimeSnapshotDto } | RuntimeError>;
  getSnapshot(request: {
    session_id: string;
    after_seq?: number;
  }): Promise<{ ok: true; snapshot: RuntimeSnapshotDto } | RuntimeError>;
  onEvent(listener: (event: GlobalRuntimeEvent) => void): () => void;
}

export interface BrowserErrorDetails {
  code: string;
  message: string;
}

export type BrowserError = { ok: false; code: string; message: string };

/**
 * P7.6 narrow browser surface: exactly four identifier-only invoke methods
 * plus two preload-local subscriptions.
 */
export interface BrowserBridgeApi {
  runOperation(request: { session_id: string; operation_id: string; request_id: string }): Promise<
    { ok: true; receipt: unknown } | BrowserError
  >;
  cancelOperation(request: { session_id: string; operation_id: string; request_id: string }): Promise<
    { ok: true; cancelled: boolean } | BrowserError
  >;
  resetRuntime(request: { session_id: string; request_id: string }): Promise<
    { ok: true; session: SafeBrowserSessionDescriptor } | BrowserError
  >;
  getSnapshot(request: { session_id: string; after_seq: number }): Promise<
    { ok: true; page: BrowserSnapshotPage } | BrowserError
  >;
  onEvent(listener: (event: BrowserRuntimeEvent) => void): () => void;
  onFrame(listener: (frame: BrowserVisualFrame) => void): () => void;
}

/** Safe editor session facts from lesson:load (identifiers only). Null while unavailable. */
export interface SafeEditorSessionDescriptor {
  session_id: string;
  generation: number;
}

/**
 * P6.12 narrow editor surface: exactly four identifier-only invoke methods
 * plus two preload-local subscriptions. Payloads are opaque unknowns here
 * (identifiers and one safe cursor only); main enforces strict shapes and
 * returns renderer-safe DTOs. There is deliberately no method that accepts
 * renderer text, paths, positions, timing or revision authority.
 */
export interface EditorBridgeApi {
  runOperation(request: unknown): Promise<unknown>;
  cancelOperation(request: unknown): Promise<unknown>;
  getSnapshot(request: unknown): Promise<unknown>;
  acknowledgePresentation(request: unknown): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
  onPresentation(listener: (frame: unknown) => void): () => void;
}

declare global {
  interface Window {
    /** Present only when running inside the Electron host. */
    cfApi?: CfApi;
  }
}

export {};
