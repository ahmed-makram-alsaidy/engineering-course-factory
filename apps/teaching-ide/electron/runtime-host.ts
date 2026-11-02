// Electron lesson runtime IPC host — P8.7 Safe IPC wiring (main-process side).
//
// Canonical architecture: docs/P8-DESIGN-SPEC.md Section 25, ADR-0013.
//
// OWNERSHIP (design-exact, no phase creep):
//   - This module is the ONLY place that touches Electron IPC for the runtime
//     orchestrator: exactly the six identifier-only invoke channels
//     (runtime:startLesson, runtime:pauseLesson, runtime:resumeLesson,
//     runtime:cancelLesson, runtime:resetLesson, runtime:getSnapshot)
//     plus the one main-to-renderer push channel (runtime:event).
//     No generic invoke/send/execute, no command/code/path/URL/selector channel exists.
//   - Every invoke validates its sender structurally (stored owning
//     webContents id + top-level sender frame + exact bundled renderer URL).
//     Other frames, other windows, stale owners, and navigations are denied
//     with WRONG_OWNER / STALE_RUNTIME_SESSION before reaching the engine.
//   - Execution itself is owned by @course-factory/runtime-orchestrator
//     (LessonRuntime + ValidatedRuntimePlan + RuntimeValidator + LifecycleCoordinator).
//     Renderer NEVER supplies commands, code, selectors, URLs, file paths,
//     playhead coordinates, engine choices, or adapter options.
//     All semantics resolve main-side from reviewed compiled lessons.
//   - Single active runtime: exactly one active lesson runtime slot per
//     workstation / Teaching IDE instance.
//   - Shutdown barrier: coordinates clean P8.6 teardown in reverse dependency
//     order (Browser -> Terminal -> Workspace -> Seal Journal -> CLOSED) before
//     app quit.
//   - Testability: nothing in this module imports Electron at value level.
//     The invoke dispatcher (RuntimeHost.handleInvoke) takes a structural sender
//     so unit tests exercise sender validation without launching Electron.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { loadCompiledLessonData } from "../src/model/ir-loader.ts";
import {
  LessonRuntime,
  type LessonRuntimeOptions,
  RuntimeValidator,
  type ValidatedRuntimePlan,
  type GlobalRuntimeEvent,
  type RuntimeSnapshotDto,
  type SafeRuntimeSessionDescriptor,
  StartLessonRequestSchema,
  PauseLessonRequestSchema,
  ResumeLessonRequestSchema,
  CancelLessonRequestSchema,
  ResetLessonRequestSchema,
  GetRuntimeSnapshotRequestSchema,
  type StartLessonRequest,
  type PauseLessonRequest,
  type ResumeLessonRequest,
  type CancelLessonRequest,
  type ResetLessonRequest,
  type GetRuntimeSnapshotRequest,
  type RuntimeErrorDto,
  RuntimeError,
  sanitizeErrorMessage,
  type Clock,
  SystemMonotonicClock,
  EditorRuntimeAdapter,
  TerminalRuntimeAdapter,
  BrowserRuntimeAdapter,
  WaitRuntimeAdapter,
  SimulatedNarrationAdapter,
  VisualRuntimeAdapter,
  EngineAdapterRegistry,
  type EditorDomainSession,
  type TerminalDomainSession,
  type BrowserDomainSession,
} from "@course-factory/runtime-orchestrator";

export type {
  EditorDomainSession,
  TerminalDomainSession,
  BrowserDomainSession,
};

// ---------------------------------------------------------------------------
// Canonical Channel Constants
// ---------------------------------------------------------------------------

export const RUNTIME_INVOKE_CHANNELS = [
  "runtime:startLesson",
  "runtime:pauseLesson",
  "runtime:resumeLesson",
  "runtime:cancelLesson",
  "runtime:resetLesson",
  "runtime:getSnapshot",
] as const;

export type RuntimeInvokeChannel = (typeof RUNTIME_INVOKE_CHANNELS)[number];

export const RUNTIME_EVENT_CHANNEL = "runtime:event" as const;

// ---------------------------------------------------------------------------
// Structural Sender Facts & Validation
// ---------------------------------------------------------------------------

/** Structural sender facts mapped from Electron's IpcMainInvokeEvent in main.ts. */
export interface RuntimeSender {
  /** Owning webContents id (event.sender.id). */
  readonly webContentsId: number;
  /** senderFrame.url at invoke time (exact bundled renderer URL expected). */
  readonly frameUrl: string | null;
  /** True when senderFrame is the top-level frame (no iframe/guest). */
  readonly frameIsTop: boolean;
  /** True when the sender webContents is destroyed. */
  readonly senderDestroyed: boolean;
}

/** What main remembers about a renderer's window. */
export interface RuntimeRendererBinding {
  readonly webContentsId: number;
  readonly rendererUrl: string;
}

/**
 * Structural sender validation.
 * Checks stored webContents id, top-level sender frame, and exact bundled renderer URL.
 * Denies other frames, other windows, stale owners, navigations, and destroyed senders.
 */
export function isTrustedRuntimeSender(
  sender: RuntimeSender,
  binding: RuntimeRendererBinding | null,
): boolean {
  if (binding === null) return false;
  if (sender.senderDestroyed) return false;
  if (sender.webContentsId !== binding.webContentsId) return false;
  if (!sender.frameIsTop) return false;
  if (sender.frameUrl === null) return false;
  if (sender.frameUrl !== binding.rendererUrl) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Lesson Resolver Interface & Bundled Resolver
// ---------------------------------------------------------------------------

export interface LessonResolver {
  resolveLesson(identifier: string): Promise<CompiledLesson | null> | (CompiledLesson | null);
}

/**
 * Production resolver: loads lessons strictly from bundled fixtures directory.
 * Fails closed on path traversal, invalid characters, or corrupted JSON/IR.
 */
export class BundledLessonResolver implements LessonResolver {
  private readonly fixturesDir: string;

  constructor(fixturesDir: string) {
    this.fixturesDir = fixturesDir;
  }

  async resolveLesson(identifier: string): Promise<CompiledLesson | null> {
    if (typeof identifier !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identifier)) {
      return null;
    }
    if (identifier.includes("..") || identifier.includes("/") || identifier.includes("\\")) {
      return null;
    }

    // 1. Direct fixture match by identifier.json
    const directPath = join(this.fixturesDir, `${identifier}.json`);
    if (existsSync(directPath)) {
      try {
        const raw = readFileSync(directPath, "utf8");
        const data = JSON.parse(raw);
        const loaded = loadCompiledLessonData(data);
        if (loaded.ok && loaded.ir) {
          return loaded.ir;
        }
      } catch {
        return null;
      }
    }

    // 2. Scan directory to match ir.lesson.lesson_id
    try {
      const files = readdirSync(this.fixturesDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = readFileSync(join(this.fixturesDir, file), "utf8");
          const data = JSON.parse(raw);
          const loaded = loadCompiledLessonData(data);
          if (loaded.ok && loaded.ir && loaded.ir.lesson.lesson_id === identifier) {
            return loaded.ir;
          }
        } catch {
          continue;
        }
      }
    } catch {
      return null;
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime Factory Seam & Host Adapters
// ---------------------------------------------------------------------------

export interface HostAdapterProviders {
  readonly getEditorSession?: () => EditorDomainSession | null;
  readonly getTerminalSession?: () => TerminalDomainSession | null;
  readonly getBrowserSession?: () => BrowserDomainSession | null;
  readonly getWaitPortReadinessProvider?: () => ((port: number, timeoutMs?: number, pollIntervalMs?: number, host?: string) => Promise<boolean>) | undefined;
  readonly clock?: Clock;
  readonly barrierTimeoutMs?: number;
}

export function createHostAdapterRegistry(providers: HostAdapterProviders = {}): EngineAdapterRegistry {
  const clock = providers.clock ?? new SystemMonotonicClock();
  const editor = new EditorRuntimeAdapter({ getSession: providers.getEditorSession, clock });
  const terminal = new TerminalRuntimeAdapter({ getSession: providers.getTerminalSession, clock });
  const browser = new BrowserRuntimeAdapter({ getSession: providers.getBrowserSession, clock });
  const wait = new WaitRuntimeAdapter({
    clock,
    portReadinessProvider: providers.getWaitPortReadinessProvider
      ? (port, timeoutMs, pollIntervalMs, host) => {
          const fn = providers.getWaitPortReadinessProvider!();
          if (!fn) throw new Error("Port readiness provider is unavailable");
          return fn(port, timeoutMs, pollIntervalMs, host);
        }
      : undefined,
  });
  const narration = new SimulatedNarrationAdapter({ clock });
  const visual = new VisualRuntimeAdapter({ clock });
  return new EngineAdapterRegistry({ editor, terminal, browser, wait, narration, visual });
}

export interface RuntimeFactoryParams {
  readonly sessionId: string;
  readonly compiledLesson: CompiledLesson;
  readonly plan: ValidatedRuntimePlan;
  readonly clock?: Clock;
  readonly barrierTimeoutMs?: number;
}

export interface RuntimeFactory {
  createRuntime(params: RuntimeFactoryParams): Promise<LessonRuntime> | LessonRuntime;
}

export class DefaultRuntimeFactory implements RuntimeFactory {
  private readonly providers: HostAdapterProviders;

  constructor(providers: HostAdapterProviders = {}) {
    this.providers = providers;
  }

  createRuntime(params: RuntimeFactoryParams): LessonRuntime {
    const clock = params.clock ?? this.providers.clock ?? new SystemMonotonicClock();
    const registry = createHostAdapterRegistry({ ...this.providers, clock });
    return LessonRuntime.create(params.plan, {
      sessionId: params.sessionId,
      registry,
      compiledLesson: params.compiledLesson,
      clock,
      barrierTimeoutMs: params.barrierTimeoutMs ?? this.providers.barrierTimeoutMs ?? 15_000,
    });
  }
}

// ---------------------------------------------------------------------------
// Response Types
// ---------------------------------------------------------------------------

export interface RuntimeInvokeError {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly error: RuntimeErrorDto;
}

export type RuntimeInvokeResponse =
  | { readonly ok: true; readonly snapshot: RuntimeSnapshotDto; readonly session?: SafeRuntimeSessionDescriptor }
  | RuntimeInvokeError;

function failure(code: string, rawMessage: string, requestId: string | null = null): RuntimeInvokeError {
  const message = sanitizeErrorMessage(rawMessage);
  const errDto: RuntimeErrorDto = {
    code: (code as RuntimeErrorDto["code"]) || "INVALID_REQUEST",
    message,
    retry: "NOT_RETRYABLE",
    request_id: requestId,
  };
  return { ok: false, code, message, error: errDto };
}

// ---------------------------------------------------------------------------
// RuntimeHost Implementation
// ---------------------------------------------------------------------------

export interface RuntimeHostOptions {
  readonly pushToRenderer: (webContentsId: number, channel: string, dto: unknown) => void;
  readonly lessonResolver?: LessonResolver;
  readonly runtimeFactory?: RuntimeFactory;
  readonly validator?: RuntimeValidator;
  readonly clock?: Clock;
  readonly defaultFixturesDir?: string;
}

export class RuntimeHost {
  private readonly pushToRenderer: (webContentsId: number, channel: string, dto: unknown) => void;
  private readonly lessonResolver: LessonResolver;
  private readonly runtimeFactory: RuntimeFactory;
  private readonly validator: RuntimeValidator;
  private readonly clock: Clock;

  private readonly bindings: Map<number, RuntimeRendererBinding> = new Map();

  // Single active lesson runtime slot
  private activeRuntime: LessonRuntime | null = null;
  private activeSessionId: string | null = null;
  private owningWebContentsId: number | null = null;
  private unsubscribeJournal: (() => void) | null = null;

  // Prepared session cache (e.g. from lesson:load)
  private preparedLesson: {
    sessionId: string;
    compiledLesson: CompiledLesson;
    plan: ValidatedRuntimePlan;
    webContentsId: number;
  } | null = null;

  private startInFlight = false;
  private closeInFlight = false;

  constructor(options: RuntimeHostOptions) {
    this.pushToRenderer = options.pushToRenderer;
    this.lessonResolver =
      options.lessonResolver ??
      new BundledLessonResolver(options.defaultFixturesDir ?? join(__dirname, "..", "..", "fixtures", "compiled-lessons"));
    this.runtimeFactory = options.runtimeFactory ?? new DefaultRuntimeFactory();
    this.validator = options.validator ?? new RuntimeValidator();
    this.clock = options.clock ?? new SystemMonotonicClock();
  }

  // -------------------------------------------------------------------------
  // Renderer Window Bindings
  // -------------------------------------------------------------------------

  bindRenderer(binding: RuntimeRendererBinding): void {
    this.bindings.set(binding.webContentsId, binding);
  }

  unbindRenderer(webContentsId: number): void {
    this.bindings.delete(webContentsId);
    if (this.owningWebContentsId === webContentsId) {
      this.owningWebContentsId = null;
    }
    if (this.preparedLesson?.webContentsId === webContentsId) {
      this.preparedLesson = null;
    }
  }

  /**
   * Prepares a session when a lesson is loaded (e.g. by lesson:load).
   * Validates compiled lesson main-side and prepares plan before start.
   */
  async prepareSessionForRenderer(input: {
    webContentsId: number;
    rendererUrl: string;
    compiledLesson: CompiledLesson;
    lessonId: string;
  }): Promise<{ ok: true; session: SafeRuntimeSessionDescriptor } | { ok: false; code: string; message: string; error: RuntimeErrorDto }> {
    const binding = this.bindings.get(input.webContentsId);
    if (!binding) {
      return failure("WRONG_OWNER", "renderer window is not bound");
    }

    // Run preflight validator
    const report = this.validator.validate(input.compiledLesson);
    if (!report.ok || !report.plan) {
      const firstErr = report.errors[0];
      return failure(
        firstErr?.code ?? "PREFLIGHT_VALIDATION_FAILED",
        firstErr?.message ?? "Lesson preflight validation failed",
      );
    }

    const sessionId = `sess-${input.lessonId}`;
    this.preparedLesson = {
      sessionId,
      compiledLesson: input.compiledLesson,
      plan: report.plan,
      webContentsId: input.webContentsId,
    };

    const sessionDescriptor: SafeRuntimeSessionDescriptor = {
      session_id: sessionId,
      lesson_id: input.compiledLesson.lesson.lesson_id,
      generation: 1,
      state: "READY",
      created_at_ms: this.clock.now(),
    };

    return { ok: true, session: sessionDescriptor };
  }

  // -------------------------------------------------------------------------
  // IPC Dispatcher
  // -------------------------------------------------------------------------

  async handleInvoke(
    channel: string,
    sender: RuntimeSender,
    payload: unknown,
  ): Promise<RuntimeInvokeResponse> {
    // 1. Sender validation
    const binding = this.bindings.get(sender.webContentsId) ?? null;
    if (!isTrustedRuntimeSender(sender, binding)) {
      return failure("WRONG_OWNER", "runtime sender is not the bound session owner");
    }

    // 2. Window ownership check
    if (this.owningWebContentsId !== null && this.owningWebContentsId !== sender.webContentsId) {
      return failure("WRONG_OWNER", "active runtime is owned by another window");
    }

    // 3. Channel dispatch
    try {
      switch (channel) {
        case "runtime:startLesson":
          return await this.handleStartLesson(sender, payload);
        case "runtime:pauseLesson":
          return await this.handlePauseLesson(sender, payload);
        case "runtime:resumeLesson":
          return await this.handleResumeLesson(sender, payload);
        case "runtime:cancelLesson":
          return await this.handleCancelLesson(sender, payload);
        case "runtime:resetLesson":
          return await this.handleResetLesson(sender, payload);
        case "runtime:getSnapshot":
          return await this.handleGetSnapshot(sender, payload);
        default:
          return failure("UNKNOWN_CHANNEL", `Unknown runtime channel: ${channel}`);
      }
    } catch (err) {
      if (err instanceof RuntimeError) {
        const dto = err.toDto();
        return { ok: false, code: dto.code, message: dto.message, error: dto };
      }
      const raw = err instanceof Error ? err.message : String(err);
      return failure("INVALID_REQUEST", raw);
    }
  }

  // -------------------------------------------------------------------------
  // Channel Handlers
  // -------------------------------------------------------------------------

  private async handleStartLesson(
    sender: RuntimeSender,
    payload: unknown,
  ): Promise<RuntimeInvokeResponse> {
    const parse = StartLessonRequestSchema.safeParse(payload);
    if (!parse.success) {
      return failure("INVALID_REQUEST", parse.error.issues[0]?.message ?? "Invalid start request");
    }
    const req: StartLessonRequest = parse.data;

    if (this.startInFlight) {
      return failure("RUNTIME_ALREADY_RUNNING", "Lesson start is already in flight", req.request_id);
    }

    // Check existing active runtime state
    if (this.activeRuntime !== null) {
      const state = this.activeRuntime.stateMachine.getState();

      if (this.activeRuntime.runtimeSessionId === req.session_id) {
        if (state === "RUNNING") {
          return failure("RUNTIME_ALREADY_RUNNING", "Lesson execution is already running", req.request_id);
        }
        if (state === "PAUSED") {
          return failure("RUNTIME_PAUSED", "Lesson execution is paused; call resumeLesson", req.request_id);
        }
        if (state === "HOLD") {
          return failure("RUNTIME_IN_HOLD", "Lesson runtime is halted in HOLD state", req.request_id);
        }
        if (state === "COMPLETED" || state === "CLOSED") {
          return failure("INVALID_STATE_TRANSITION", `Cannot start lesson from state '${state}'`, req.request_id);
        }
        if (state === "READY") {
          this.startInFlight = true;
          try {
            const execPromise = this.activeRuntime.start();
            execPromise.catch(() => {
              // Background execution unhandled rejection boundary
            });
            return { ok: true, snapshot: this.activeRuntime.getSnapshot() };
          } finally {
            this.startInFlight = false;
          }
        }
      } else {
        // Different session ID: if active runtime is in flight, reject replacement
        if (state === "RUNNING" || state === "PAUSED" || state === "CANCELLING" || state === "RESETTING" || state === "HOLD") {
          return failure("RUNTIME_ALREADY_RUNNING", "Another lesson runtime is currently active", req.request_id);
        }
        // If completed or closed, retire previous session
        await this.closeActiveRuntime("session_replacement");
      }
    }

    // Creating a fresh runtime
    this.startInFlight = true;
    try {
      let compiledLesson: CompiledLesson | null = null;
      let plan: ValidatedRuntimePlan | null = null;

      // Check prepared session first
      if (this.preparedLesson && (this.preparedLesson.sessionId === req.session_id || this.preparedLesson.compiledLesson.lesson.lesson_id === req.session_id)) {
        compiledLesson = this.preparedLesson.compiledLesson;
        plan = this.preparedLesson.plan;
      } else {
        // Resolve lesson main-side via LessonResolver
        compiledLesson = await this.lessonResolver.resolveLesson(req.session_id);
        if (!compiledLesson) {
          return failure("RUNTIME_INVALID_LESSON", "Unknown or unauthorized lesson identifier", req.request_id);
        }
        const report = this.validator.validate(compiledLesson);
        if (!report.ok || !report.plan) {
          const firstErr = report.errors[0];
          return failure(
            firstErr?.code ?? "PREFLIGHT_VALIDATION_FAILED",
            firstErr?.message ?? "Lesson preflight validation failed",
            req.request_id,
          );
        }
        plan = report.plan;
      }

      // Create runtime instance via main-owned factory
      const runtime = await this.runtimeFactory.createRuntime({
        sessionId: req.session_id,
        compiledLesson,
        plan,
        clock: this.clock,
      });

      // Clear any previous subscriptions
      this.unsubscribeJournal?.();

      // Subscribe to Global Journal push stream
      this.unsubscribeJournal = runtime.journal.onEvent((event: GlobalRuntimeEvent) => {
        try {
          if (this.owningWebContentsId !== null) {
            this.pushToRenderer(this.owningWebContentsId, RUNTIME_EVENT_CHANNEL, event);
          }
        } catch {
          // Late pushes to destroyed windows dropped safely without exceptions
        }
      });

      this.activeRuntime = runtime;
      this.activeSessionId = req.session_id;
      this.owningWebContentsId = sender.webContentsId;

      // Start execution in background (runtime.start synchronously checks state,
      // transitions to RUNNING, and commits runtime.started before runLoop starts)
      const executionPromise = runtime.start();
      executionPromise.catch(() => {
        // Background unhandled rejection boundary
      });

      const snapshot = runtime.getSnapshot();
      return { ok: true, snapshot };
    } finally {
      this.startInFlight = false;
    }
  }

  private async handlePauseLesson(
    sender: RuntimeSender,
    payload: unknown,
  ): Promise<RuntimeInvokeResponse> {
    const parse = PauseLessonRequestSchema.safeParse(payload);
    if (!parse.success) {
      return failure("INVALID_REQUEST", parse.error.issues[0]?.message ?? "Invalid pause request");
    }
    const req: PauseLessonRequest = parse.data;

    if (!this.activeRuntime) {
      return failure("RUNTIME_NOT_READY", "No active runtime session", req.request_id);
    }
    if (this.activeRuntime.runtimeSessionId !== req.session_id) {
      return failure("STALE_RUNTIME_SESSION", "Session ID does not match active runtime session", req.request_id);
    }

    await this.activeRuntime.pause();
    return { ok: true, snapshot: this.activeRuntime.getSnapshot() };
  }

  private async handleResumeLesson(
    sender: RuntimeSender,
    payload: unknown,
  ): Promise<RuntimeInvokeResponse> {
    const parse = ResumeLessonRequestSchema.safeParse(payload);
    if (!parse.success) {
      return failure("INVALID_REQUEST", parse.error.issues[0]?.message ?? "Invalid resume request");
    }
    const req: ResumeLessonRequest = parse.data;

    if (!this.activeRuntime) {
      return failure("RUNTIME_NOT_READY", "No active runtime session", req.request_id);
    }
    if (this.activeRuntime.runtimeSessionId !== req.session_id) {
      return failure("STALE_RUNTIME_SESSION", "Session ID does not match active runtime session", req.request_id);
    }

    await this.activeRuntime.resume();
    return { ok: true, snapshot: this.activeRuntime.getSnapshot() };
  }

  private async handleCancelLesson(
    sender: RuntimeSender,
    payload: unknown,
  ): Promise<RuntimeInvokeResponse> {
    const parse = CancelLessonRequestSchema.safeParse(payload);
    if (!parse.success) {
      return failure("INVALID_REQUEST", parse.error.issues[0]?.message ?? "Invalid cancel request");
    }
    const req: CancelLessonRequest = parse.data;

    if (!this.activeRuntime) {
      return failure("RUNTIME_NOT_READY", "No active runtime session", req.request_id);
    }
    if (this.activeRuntime.runtimeSessionId !== req.session_id) {
      return failure("STALE_RUNTIME_SESSION", "Session ID does not match active runtime session", req.request_id);
    }

    await this.activeRuntime.cancel();
    return { ok: true, snapshot: this.activeRuntime.getSnapshot() };
  }

  private async handleResetLesson(
    sender: RuntimeSender,
    payload: unknown,
  ): Promise<RuntimeInvokeResponse> {
    const parse = ResetLessonRequestSchema.safeParse(payload);
    if (!parse.success) {
      return failure("INVALID_REQUEST", parse.error.issues[0]?.message ?? "Invalid reset request");
    }
    const req: ResetLessonRequest = parse.data;

    if (!this.activeRuntime) {
      return failure("RUNTIME_NOT_READY", "No active runtime session", req.request_id);
    }
    if (this.activeRuntime.runtimeSessionId !== req.session_id) {
      return failure("STALE_RUNTIME_SESSION", "Session ID does not match active runtime session", req.request_id);
    }

    await this.activeRuntime.reset();

    const descriptor: SafeRuntimeSessionDescriptor = {
      session_id: this.activeRuntime.runtimeSessionId,
      lesson_id: this.activeRuntime.lessonId,
      generation: this.activeRuntime.stateMachine.getGeneration(),
      state: "READY",
      created_at_ms: this.clock.now(),
    };

    return {
      ok: true,
      session: descriptor,
      snapshot: this.activeRuntime.getSnapshot(),
    };
  }

  private async handleGetSnapshot(
    sender: RuntimeSender,
    payload: unknown,
  ): Promise<RuntimeInvokeResponse> {
    const parse = GetRuntimeSnapshotRequestSchema.safeParse(payload);
    if (!parse.success) {
      return failure("INVALID_REQUEST", parse.error.issues[0]?.message ?? "Invalid snapshot request");
    }
    const req: GetRuntimeSnapshotRequest = parse.data;

    if (!this.activeRuntime) {
      if (
        this.preparedLesson &&
        (this.preparedLesson.sessionId === req.session_id ||
          this.preparedLesson.compiledLesson.lesson.lesson_id === req.session_id)
      ) {
        return {
          ok: true,
          snapshot: {
            runtime_session_id: this.preparedLesson.sessionId,
            lesson_id: this.preparedLesson.compiledLesson.lesson.lesson_id,
            generation: 1,
            state: "READY",
            playhead: {
              lesson_id: this.preparedLesson.compiledLesson.lesson.lesson_id,
              scene_index: 0,
              scene_id: this.preparedLesson.compiledLesson.scenes[0]?.scene_id ?? "",
              step_index: 0,
              step_id: this.preparedLesson.compiledLesson.scenes[0]?.steps[0]?.step_id ?? "",
              global_step_ordinal: 1,
              total_steps: this.preparedLesson.plan.total_steps,
              attempt_id: "A001",
              generation: 1,
            },
            active_process_ids: [],
            last_outcome: null,
            journal_high_seq: 0,
          },
        };
      }
      return failure("RUNTIME_NOT_READY", "No active runtime session");
    }
    if (this.activeRuntime.runtimeSessionId !== req.session_id) {
      return failure("STALE_RUNTIME_SESSION", "Session ID does not match active runtime session");
    }

    return { ok: true, snapshot: this.activeRuntime.getSnapshot() };
  }

  // -------------------------------------------------------------------------
  // Lifecycle, Window Close, App Teardown
  // -------------------------------------------------------------------------

  async closeSessionForRenderer(webContentsId: number, _cause = "renderer_loss"): Promise<void> {
    if (this.owningWebContentsId === webContentsId) {
      await this.closeActiveRuntime(_cause);
    }
    this.unbindRenderer(webContentsId);
  }

  async shutdownAll(_cause = "app_close"): Promise<void> {
    await this.closeActiveRuntime(_cause);
    this.bindings.clear();
  }

  private async closeActiveRuntime(_cause: string): Promise<void> {
    if (this.closeInFlight) return;
    this.closeInFlight = true;
    try {
      this.unsubscribeJournal?.();
      this.unsubscribeJournal = null;

      if (this.activeRuntime !== null) {
        try {
          await this.activeRuntime.close();
        } catch {
          // Bounded close failure boundary
        }
        this.activeRuntime = null;
        this.activeSessionId = null;
        this.owningWebContentsId = null;
      }
    } finally {
      this.closeInFlight = false;
    }
  }

  // Diagnostics / inspection only (never exposed over IPC)
  getActiveRuntime(): LessonRuntime | null {
    return this.activeRuntime;
  }
}

export function createRuntimeShutdownBarrier(
  host: RuntimeHost,
  timeoutMs = 10_000,
): () => Promise<void> {
  return async () => {
    await Promise.race([
      host.shutdownAll("app_close"),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  };
}
