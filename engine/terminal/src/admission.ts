// P5 admission — the trusted layer between identifier-only renderer requests
// and future execution providers (docs/P5-DESIGN-SPEC.md, "Security Boundary"
// and "IR Integration"; task P5.2).
//
// THE CENTRAL SECURITY PROPERTY: the renderer never supplies the command that
// will execute. A renderer request identifies an already-authored compiled
// operation; trusted admission resolves that identifier against the canonical
// validated CompiledLesson IR, confirms eligibility, checks runtime lifecycle
// state, and derives an immutable ExecutionGrant. Future execution code may
// obtain command/cwd/mode/timeout/exit semantics ONLY through a grant.
//
// Boundaries enforced here:
//   - requests are the exact P5.1 identifier-only schemas (strict keys —
//     command/env/cwd/image/mount/stdin fields cannot parse);
//   - the IR is re-validated by the canonical P3 authority, deep-frozen, and
//     cross-checked (unique hierarchical ids, provenance/order, process
//     inventory and reference agreement) — forged or inconsistent IR is
//     rejected IR_RUNTIME_INCONSISTENT, never repaired;
//   - grants bind the exact authored command/cwd/process metadata from IR —
//     admission is authorization/translation only and never executes;
//   - session identity carries the generation: stale generation, unknown,
//     disposed, or non-runtime-authorized sessions are rejected STALE_SESSION
//     / NOT_AUTHORIZED before any provider could see work;
//   - grants are portable: authored cwd stays project-relative POSIX; host
//     resolution belongs to the workspace task (P5.3).
//
// P5.2 owns a non-executing admission state abstraction only: reservations,
// one-attempt-per-operation, foreground/background occupancy and logical
// process mappings. No process is spawned, stopped, or awaited here; provider
// lifecycle and atomic start races are P5.5+.

import { z } from "zod";
import {
  validateCompiledLesson,
  type CompiledLesson,
  type CompiledOperation,
  type CompiledProcess,
} from "@course-factory/lesson-compiler/ir";
// The compiler package's canonical serialization is the single authority for
// the compiled-byte digest. Imported relatively (not via the package index)
// so admission does not pull unrelated compiler implementation files into
// strict typecheck — see docs/P5-IMPLEMENTATION.md (pre-existing debt note).
import { serializeCompiledLesson, sha256Hex } from "../../compiler/src/canonical.ts";
import { ADMISSION_POLICY, WAIT_POLICY } from "./policy.ts";
import {
  CancelOperationRequestSchema,
  IdentifierSchema,
  ResetRuntimeRequestSchema,
  RunOperationRequestSchema,
  RuntimeSessionIdentitySchema,
  StopProcessRequestSchema,
  type OperationOutcome,
  type RuntimeErrorCode,
  type RuntimeSessionIdentity,
} from "./protocol.ts";

type RunOperationRequest = z.infer<typeof RunOperationRequestSchema>;
type StopProcessRequest = z.infer<typeof StopProcessRequestSchema>;
type CancelOperationRequest = z.infer<typeof CancelOperationRequestSchema>;
type ResetRuntimeRequest = z.infer<typeof ResetRuntimeRequestSchema>;

/** Fields shared by every renderer terminal request (design IPC table). */
interface CommonRequestFields {
  session_id: string;
  request_id: string;
}

// ---------------------------------------------------------------------------
// Admission results — rejections are structured, using the P5.1 error
// taxonomy. No second error system.
// ---------------------------------------------------------------------------

export interface AdmissionRejection {
  readonly code: RuntimeErrorCode;
  readonly message: string;
  readonly request_id: string | null;
}

export type AdmissionOutcome<T> = { ok: true; value: T } | { ok: false; rejection: AdmissionRejection };

function rejected(code: RuntimeErrorCode, message: string, request_id: string | null = null): { ok: false; rejection: AdmissionRejection } {
  return { ok: false, rejection: { code, message, request_id } };
}

// ---------------------------------------------------------------------------
// Grant DTOs — the only trusted objects through which future execution code
// may obtain command/cwd/mode/timeout/exit semantics. Runtime-validated with
// the existing Zod, deeply frozen, portable (no host paths).
// ---------------------------------------------------------------------------

export const EXECUTION_GRANT_VERSION = 1;

export const ExecutionGrantSchema = z.strictObject({
  kind: z.literal("execution_grant"),
  grant_version: z.literal(EXECUTION_GRANT_VERSION),
  session_id: IdentifierSchema,
  generation: z.number().int().min(1),
  request_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  operation_id: IdentifierSchema,
  operation_type: z.literal("terminal_run"),
  mode: z.enum(["foreground", "background"]),
  course_id: IdentifierSchema,
  lesson_id: IdentifierSchema,
  scene_id: IdentifierSchema,
  beat_id: IdentifierSchema,
  /** Authored logical process id (background); null for foreground. Renderer-invisible, IR-derived. */
  process_id: IdentifierSchema.nullable(),
  /** The exact authored validated command — preserved unchanged, never rewritten or requoted. */
  command: z.string().min(1),
  /** Authored project-relative POSIX cwd, or null (workspace root at runtime). Never a host path. */
  cwd: z.string().min(1).nullable(),
  /** Foreground only: authored or default 60 s; null for background ("no foreground expected/timeout"). */
  timeout_ms: z.number().int().positive().nullable(),
  /** Foreground only: authored or default 0; null for background. */
  expected_exit_code: z.number().int().min(0).nullable(),
});
export type ExecutionGrant = z.infer<typeof ExecutionGrantSchema>;

export const StopAdmissionSchema = z.strictObject({
  kind: z.literal("stop_admission"),
  grant_version: z.literal(EXECUTION_GRANT_VERSION),
  session_id: IdentifierSchema,
  generation: z.number().int().min(1),
  request_id: IdentifierSchema,
  /** authored_operation = a runOperation of a compiled terminal_stop; operator_request = stopProcess. */
  origin: z.enum(["authored_operation", "operator_request"]),
  /** The compiled terminal_stop operation identity, when admitted through runOperation. */
  operation_id: IdentifierSchema.nullable(),
  attempt_id: IdentifierSchema.nullable(),
  scene_id: IdentifierSchema.nullable(),
  beat_id: IdentifierSchema.nullable(),
  /** Trusted logical target resolved from the compiled IR — never renderer-supplied content. */
  target: z.strictObject({
    process_id: IdentifierSchema,
    defined_in: z.strictObject({ scene_id: IdentifierSchema, beat_id: IdentifierSchema }),
  }),
});
export type StopAdmission = z.infer<typeof StopAdmissionSchema>;

export const CancelAdmissionSchema = z.strictObject({
  kind: z.literal("cancel_admission"),
  grant_version: z.literal(EXECUTION_GRANT_VERSION),
  session_id: IdentifierSchema,
  generation: z.number().int().min(1),
  request_id: IdentifierSchema,
  operation_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  scene_id: IdentifierSchema,
  beat_id: IdentifierSchema,
});
export type CancelAdmission = z.infer<typeof CancelAdmissionSchema>;

/**
 * P5.10 trusted wait admission (design "Process-output waits / readiness":
 * "Internal waitForProcessOutput(admittedWait, abortSignal), no renderer
 * predicate/text"). The ONLY object through which output-wait code may obtain
 * the readiness literal, the target process and the deadline. Derived
 * exclusively from the canonical validated CompiledLesson IR: the literal
 * text, the logical target and the timeout come from the authored
 * wait-until-process_output operation, never from renderer/lesson/grant
 * free-form input. Strict, deep-frozen, portable (no host paths).
 */
export const WaitAdmissionSchema = z.strictObject({
  kind: z.literal("wait_admission"),
  grant_version: z.literal(EXECUTION_GRANT_VERSION),
  session_id: IdentifierSchema,
  generation: z.number().int().min(1),
  request_id: IdentifierSchema,
  operation_id: IdentifierSchema,
  attempt_id: IdentifierSchema,
  course_id: IdentifierSchema,
  lesson_id: IdentifierSchema,
  scene_id: IdentifierSchema,
  beat_id: IdentifierSchema,
  /** Trusted logical target resolved from the compiled IR — never renderer-supplied content. */
  target: z.strictObject({
    process_id: IdentifierSchema,
    defined_in: z.strictObject({ scene_id: IdentifierSchema, beat_id: IdentifierSchema }),
  }),
  /** The exact authored readiness literal (case-sensitive, 1–4096 chars) — preserved unchanged. */
  text: z.string().min(1).max(4096),
  /** Trusted wait deadline (authored timeout_seconds × 1000, bounded to the wait ceiling). */
  timeout_ms: z.number().int().positive(),
});
export type WaitAdmission = z.infer<typeof WaitAdmissionSchema>;

/** What admitRunOperation may return: a run grant, a stop admission, or (P5.10) a wait admission. */
export type RunAdmission = ExecutionGrant | StopAdmission | WaitAdmission;

// ---------------------------------------------------------------------------
// Lesson catalog — the immutable, cross-checked index admission resolves
// against. Built ONLY from a CompiledLesson that the canonical P3 authority
// re-validates here ("canonical validateCompiledLesson then copy/freeze/
// index"). The catalog never confers execution authorization by itself;
// that decision is main's (executionAuthorized at session open), so P4
// inspection fixtures stay inspection-only.
// ---------------------------------------------------------------------------

export interface OperationIndexEntry {
  readonly operation_id: string;
  readonly scene_id: string;
  readonly beat_id: string;
  readonly scene_ordinal: number;
  readonly step_ordinal: number;
  readonly operation: CompiledOperation;
}

export interface ProcessDefinitionEntry {
  readonly process_id: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly defined_in: { readonly scene_id: string; readonly beat_id: string };
  readonly defining_operation_id: string;
}

export interface LessonCatalog {
  /** sha256 over the canonical compiled bytes ("canonical compiled-byte digest") — not the source.hash signature. */
  readonly lesson_compiled_digest: string;
  readonly course_id: string;
  readonly lesson_id: string;
  readonly operations: ReadonlyMap<string, OperationIndexEntry>;
  readonly processes: ReadonlyMap<string, ProcessDefinitionEntry>;
}

type FlatStep = { sceneId: string; sceneOrdinal: number; stepOrdinal: number; step: CompiledLesson["scenes"][number]["steps"][number] };

function flattenOrderedOperations(ir: CompiledLesson): FlatStep[] {
  const ordered: FlatStep[] = [];
  ir.scenes.forEach((scene, sceneIndex) => {
    scene.steps.forEach((step, stepIndex) => {
      ordered.push({ sceneId: scene.scene_id, sceneOrdinal: sceneIndex + 1, stepOrdinal: stepIndex + 1, step });
    });
  });
  return ordered;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build the immutable catalog. Accepts a CompiledLesson (typed); the canonical
 * validator re-validates it anyway and the catalog works on the parsed copy —
 * raw unknown objects are never trusted. Cross-checks reject inconsistent IR
 * with IR_RUNTIME_INCONSISTENT and never repair it.
 */
export function createLessonCatalog(ir: CompiledLesson): AdmissionOutcome<LessonCatalog> {
  const validated = validateCompiledLesson(ir);
  if (!validated.ok || validated.ir === undefined) {
    return rejected("IR_INVALID", "compiled lesson failed canonical validation");
  }
  const parsed: CompiledLesson = validated.ir;

  if (Buffer.byteLength(serializeCompiledLesson(parsed), "utf8") > ADMISSION_POLICY.max_ir_bytes) {
    return rejected("IR_INVALID", "compiled IR exceeds the 1 MiB limit");
  }

  // -- order / uniqueness / provenance cross-checks ---------------------------
  const seenSceneIds = new Set<string>();
  for (const [index, scene] of parsed.scenes.entries()) {
    if (seenSceneIds.has(scene.scene_id)) {
      return rejected("IR_RUNTIME_INCONSISTENT", `duplicate scene id '${scene.scene_id}'`);
    }
    seenSceneIds.add(scene.scene_id);
    if (scene.ordinal !== index + 1) {
      return rejected("IR_RUNTIME_INCONSISTENT", `scene '${scene.scene_id}' ordinal ${scene.ordinal} does not match authored position ${index + 1}`);
    }
    for (const [stepIndex, step] of scene.steps.entries()) {
      if (step.ordinal !== stepIndex + 1) {
        return rejected("IR_RUNTIME_INCONSISTENT", `step '${step.step_id}' ordinal ${step.ordinal} does not match authored position ${stepIndex + 1}`);
      }
      if (step.source_ref.scene_id !== scene.scene_id) {
        return rejected("IR_RUNTIME_INCONSISTENT", `step '${step.step_id}' provenance scene '${step.source_ref.scene_id}' does not match containing scene '${scene.scene_id}'`);
      }
    }
  }

  // -- operation index (operation_id := step_id, no IR mutation) ---------------
  const operations = new Map<string, OperationIndexEntry>();
  for (const flat of flattenOrderedOperations(parsed)) {
    if (flat.step.kind !== "operation") continue;
    if (flat.step.source_ref.beat_id === null) {
      return rejected("IR_RUNTIME_INCONSISTENT", `operation step '${flat.step.step_id}' has no beat provenance; operations are authored beats`);
    }
    const operationId = flat.step.step_id;
    if (operations.has(operationId)) {
      return rejected("IR_RUNTIME_INCONSISTENT", `operation id '${operationId}' is not unique across the lesson; requests could not resolve to exactly one operation`);
    }
    operations.set(operationId, deepFreeze({
      operation_id: operationId,
      scene_id: flat.sceneId,
      beat_id: flat.step.source_ref.beat_id,
      scene_ordinal: flat.sceneOrdinal,
      step_ordinal: flat.stepOrdinal,
      operation: flat.step.operation,
    }));
  }

  // -- process inventory agreement ---------------------------------------------
  const inventory = new Map<string, CompiledProcess>();
  for (const process of parsed.processes) {
    if (inventory.has(process.process_id)) {
      return rejected("IR_RUNTIME_INCONSISTENT", `process inventory has duplicate process_id '${process.process_id}'`);
    }
    inventory.set(process.process_id, process);
  }

  const processEntries = new Map<string, ProcessDefinitionEntry>();
  for (const flat of flattenOrderedOperations(parsed)) {
    if (flat.step.kind !== "operation") continue;
    const parameters = flat.step.operation.parameters;
    if (parameters.type !== "terminal_run" || parameters.mode !== "background") continue;
    const processId = parameters.process_id;
    if (processId === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `background terminal_run '${flat.step.step_id}' has no logical process id`);
    }
    const record = inventory.get(processId);
    if (record === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `background terminal_run '${flat.step.step_id}' defines process '${processId}' without an inventory entry`);
    }
    if (record.started_in.scene_id !== flat.sceneId || record.started_in.beat_id !== flat.step.source_ref.beat_id) {
      return rejected("IR_RUNTIME_INCONSISTENT", `process '${processId}' inventory started_in does not agree with its defining operation '${flat.step.step_id}'`);
    }
    if (record.command !== parameters.command) {
      return rejected("IR_RUNTIME_INCONSISTENT", `process '${processId}' inventory command does not agree with the defining operation's authored command`);
    }
    if ((record.cwd ?? null) !== (parameters.cwd ?? null)) {
      return rejected("IR_RUNTIME_INCONSISTENT", `process '${processId}' inventory cwd does not agree with the defining operation`);
    }
    processEntries.set(processId, deepFreeze({
      process_id: processId,
      command: record.command,
      cwd: record.cwd ?? null,
      defined_in: { scene_id: record.started_in.scene_id, beat_id: record.started_in.beat_id },
      defining_operation_id: flat.step.step_id,
    }));
  }
  for (const [processId, record] of inventory) {
    if (!processEntries.has(processId)) {
      return rejected("IR_RUNTIME_INCONSISTENT", `process inventory entry '${processId}' has no defining background terminal_run operation`);
    }
    if (record.stopped_in !== undefined) {
      const stopEntry = operations.get(record.stopped_in.beat_id);
      if (stopEntry === undefined || stopEntry.operation.parameters.type !== "terminal_stop" || stopEntry.operation.parameters.process_id !== processId) {
        return rejected("IR_RUNTIME_INCONSISTENT", `process '${processId}' inventory stopped_in does not agree with a terminal_stop operation`);
      }
    }
  }

  // -- terminal_stop references agree on the definition, strictly later --------
  for (const entry of operations.values()) {
    const parameters = entry.operation.parameters;
    if (parameters.type !== "terminal_stop") continue;
    const reference = entry.operation.references?.process;
    if (reference === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `terminal_stop '${entry.operation_id}' has no process reference`);
    }
    if (parameters.process_id !== reference.process_id) {
      return rejected("IR_RUNTIME_INCONSISTENT", `terminal_stop '${entry.operation_id}' parameters and references disagree on the process id`);
    }
    const definition = processEntries.get(reference.process_id);
    if (definition === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `terminal_stop '${entry.operation_id}' references unknown process '${reference.process_id}'`);
    }
    if (reference.defined_in.scene_id !== definition.defined_in.scene_id || reference.defined_in.beat_id !== definition.defined_in.beat_id) {
      return rejected("IR_RUNTIME_INCONSISTENT", `terminal_stop '${entry.operation_id}' references do not agree with the definition of process '${reference.process_id}'`);
    }
    const definitionEntry = operations.get(definition.defining_operation_id);
    if (definitionEntry === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `definition of process '${reference.process_id}' is not indexed`);
    }
    const stopIsLater =
      entry.scene_ordinal > definitionEntry.scene_ordinal ||
      (entry.scene_ordinal === definitionEntry.scene_ordinal && entry.step_ordinal > definitionEntry.step_ordinal);
    if (!stopIsLater) {
      return rejected("IR_RUNTIME_INCONSISTENT", `terminal_stop '${entry.operation_id}' does not follow the definition of process '${reference.process_id}'`);
    }
  }

  // -- P5.10: process_output wait references agree on the definition, strictly
  //    later; the authored literal/timeout agree with the process inventory --
  // Duration/port waits carry no process reference and stay valid IR here
  // (they are rejected UNSUPPORTED_PHASE at admission, never executed).
  for (const entry of operations.values()) {
    const parameters = entry.operation.parameters;
    if (parameters.type !== "wait" || parameters.until !== "process_output") continue;
    const reference = entry.operation.references?.process;
    if (reference === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `wait '${entry.operation_id}' has no process reference`);
    }
    if (parameters.process_id !== reference.process_id) {
      return rejected("IR_RUNTIME_INCONSISTENT", `wait '${entry.operation_id}' parameters and references disagree on the process id`);
    }
    const definition = processEntries.get(reference.process_id);
    if (definition === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `wait '${entry.operation_id}' references unknown process '${reference.process_id}'`);
    }
    if (reference.defined_in.scene_id !== definition.defined_in.scene_id || reference.defined_in.beat_id !== definition.defined_in.beat_id) {
      return rejected("IR_RUNTIME_INCONSISTENT", `wait '${entry.operation_id}' references do not agree with the definition of process '${reference.process_id}'`);
    }
    const definitionEntry = operations.get(definition.defining_operation_id);
    if (definitionEntry === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `definition of process '${reference.process_id}' is not indexed`);
    }
    const waitIsLater =
      entry.scene_ordinal > definitionEntry.scene_ordinal ||
      (entry.scene_ordinal === definitionEntry.scene_ordinal && entry.step_ordinal > definitionEntry.step_ordinal);
    if (!waitIsLater) {
      return rejected("IR_RUNTIME_INCONSISTENT", `wait '${entry.operation_id}' does not follow the definition of process '${reference.process_id}'`);
    }
    // The authored literal/timeout must agree with the compiled process
    // inventory's output_waits record (forged text/timeout cannot smuggle a
    // different readiness condition past the catalog).
    const inventoryRecord = inventory.get(reference.process_id);
    const inventoryWait = inventoryRecord?.output_waits.find(
      (candidate) =>
        candidate.scene_id === entry.scene_id &&
        candidate.beat_id === entry.operation_id &&
        candidate.text === parameters.text &&
        candidate.timeout_seconds === parameters.timeout_seconds,
    );
    if (inventoryWait === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `wait '${entry.operation_id}' does not agree with the process inventory output_waits of '${reference.process_id}'`);
    }
  }

  return {
    ok: true,
    value: deepFreeze({
      lesson_compiled_digest: sha256Hex(serializeCompiledLesson(parsed)),
      course_id: parsed.lesson.course_id,
      lesson_id: parsed.lesson.lesson_id,
      operations,
      processes: processEntries,
    }),
  };
}

// ---------------------------------------------------------------------------
// Admission sessions — the non-executing runtime state admission checks
// before any provider could receive work.
// ---------------------------------------------------------------------------

interface AttemptRecord {
  attempt_id: string;
  kind: "run" | "stop" | "wait";
  mode: "foreground" | "background" | null;
  process_id: string | null;
  scene_id: string;
  beat_id: string;
  status: "reserved" | "completed";
  outcome: OperationOutcome | null;
}

export interface AdmissionSessionInfo {
  readonly session_id: string;
  readonly generation: number;
  readonly course_id: string;
  readonly lesson_id: string;
  readonly lesson_compiled_digest: string;
  readonly execution_authorized: boolean;
}

export interface AdmissionSession {
  readonly identity: RuntimeSessionIdentity;
  readonly catalog: LessonCatalog;
  readonly executionAuthorized: boolean;
  /** Safe session/lesson facts for loadLesson-style surfaces: identifiers and the compiled digest only — no paths, no commands. */
  info(): AdmissionSessionInfo;
  /** Trusted internal transition (future runtime): a foreground reservation reached its immutable result. */
  recordForegroundCompletion(operationId: string, attemptId: string, outcome: OperationOutcome): AdmissionOutcome<null>;
  /**
   * P5.5: trusted internal transition — a background reservation reached its
   * immutable result (natural exit / stop / failure). Releases the background
   * occupancy mapping; the per-operation attempt tombstone stays, so the
   * definition still cannot run twice in one generation (only reset reuses it).
   */
  recordBackgroundCompletion(processId: string, operationId: string, attemptId: string, outcome: OperationOutcome): AdmissionOutcome<null>;
  dispose(): void;
}

export interface OpenSessionOptions {
  /** Engine-supplied session identity part; deterministic default when omitted (runtime-only, never lesson identity). */
  readonly session_id?: string;
  /** Main-only decision. P4 inspection fixtures stay inspection-only; only reviewed synthetic P5 fixtures run. */
  readonly executionAuthorized: boolean;
}

export interface AdmissionService {
  installLesson(ir: CompiledLesson): AdmissionOutcome<LessonCatalog>;
  openSession(catalog: LessonCatalog, options: OpenSessionOptions): AdmissionOutcome<AdmissionSession>;
  /** Current active session for an identity, or null (unknown/disposed/superseded generation). */
  resolveSession(identity: RuntimeSessionIdentity): AdmissionSession | null;
  admitRunOperation(identity: RuntimeSessionIdentity, request: RunOperationRequest): AdmissionOutcome<RunAdmission>;
  admitStopProcess(identity: RuntimeSessionIdentity, request: StopProcessRequest): AdmissionOutcome<StopAdmission>;
  admitCancelOperation(identity: RuntimeSessionIdentity, request: CancelOperationRequest): AdmissionOutcome<CancelAdmission>;
  resetRuntime(identity: RuntimeSessionIdentity, request: ResetRuntimeRequest): AdmissionOutcome<RuntimeSessionIdentity>;
  disposeSession(identity: RuntimeSessionIdentity): AdmissionOutcome<null>;
}

interface SessionState {
  identity: RuntimeSessionIdentity;
  catalog: LessonCatalog;
  executionAuthorized: boolean;
  status: "active" | "disposed";
  nextAttemptNumber: number;
  attempts: Map<string, AttemptRecord>;
  foregroundOperationId: string | null;
  backgroundProcesses: Map<string, { operation_id: string; attempt_id: string }>;
}

const ID_PAD = 6;

function padded(n: number): string {
  return String(n).padStart(ID_PAD, "0");
}

export function createAdmissionService(): AdmissionService {
  let nextSessionNumber = 0;
  /** session_id -> current state (generation lives in the identity). */
  const sessions = new Map<string, SessionState>();

  function resolveChecked(identity: RuntimeSessionIdentity): AdmissionOutcome<SessionState> {
    const parsedIdentity = RuntimeSessionIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return rejected("STALE_SESSION", "trusted session identity failed validation");
    }
    const state = sessions.get(parsedIdentity.data.session_id);
    if (state === undefined || state.status !== "active") {
      return rejected("STALE_SESSION", "unknown, disposed, or superseded session");
    }
    if (state.identity.generation !== parsedIdentity.data.generation) {
      return rejected(
        "STALE_SESSION",
        `stale generation: session '${identity.session_id}' is at generation ${state.identity.generation}, request carries ${identity.generation}`,
      );
    }
    return { ok: true, value: state };
  }

  function parseRequest<S extends z.ZodType<CommonRequestFields>>(
    schema: S,
    identity: RuntimeSessionIdentity,
    request: unknown,
  ): AdmissionOutcome<z.infer<S>> {
    const parsed = schema.safeParse(request);
    if (!parsed.success) {
      return rejected("INVALID_REQUEST", "request failed strict validation (identifier-only fields)", requestIdOf(request));
    }
    if (parsed.data.session_id !== identity.session_id) {
      return rejected("INVALID_REQUEST", "request names a different session than the trusted identity", parsed.data.request_id);
    }
    return { ok: true, value: parsed.data };
  }

  const service: AdmissionService = {
    installLesson(ir: CompiledLesson): AdmissionOutcome<LessonCatalog> {
      return createLessonCatalog(ir);
    },

    openSession(catalog: LessonCatalog, options: OpenSessionOptions): AdmissionOutcome<AdmissionSession> {
      nextSessionNumber += 1;
      const sessionId = options.session_id ?? `sess-${padded(nextSessionNumber)}`;
      const existing = sessions.get(sessionId);
      if (existing !== undefined && existing.status === "active") {
        nextSessionNumber -= 1;
        return rejected("INVALID_REQUEST", `session id '${sessionId}' is already active`);
      }
      const state: SessionState = {
        identity: deepFreeze({ session_id: sessionId, generation: 1 }),
        catalog,
        executionAuthorized: options.executionAuthorized,
        status: "active",
        nextAttemptNumber: 0,
        attempts: new Map(),
        foregroundOperationId: null,
        backgroundProcesses: new Map(),
      };
      sessions.set(sessionId, state);
      return { ok: true, value: makeSessionHandle(state) };
    },

    resolveSession(identity: RuntimeSessionIdentity): AdmissionSession | null {
      const session = resolveChecked(identity);
      return session.ok ? makeSessionHandle(session.value) : null;
    },

    admitRunOperation(identity, request) {
      const session = resolveChecked(identity);
      if (!session.ok) return session;
      const parsedRequest = parseRequest(RunOperationRequestSchema, identity, request);
      if (!parsedRequest.ok) return parsedRequest;
      return admitRunOnState(session.value, parsedRequest.value);
    },

    admitStopProcess(identity, request) {
      const session = resolveChecked(identity);
      if (!session.ok) return session;
      const parsedRequest = parseRequest(StopProcessRequestSchema, identity, request);
      if (!parsedRequest.ok) return parsedRequest;
      return admitStopOnState(session.value, parsedRequest.value.request_id, {
        origin: "operator_request",
        operation_id: null,
        scene_id: null,
        beat_id: null,
        processId: parsedRequest.value.process_id,
      });
    },

    admitCancelOperation(identity, request) {
      const session = resolveChecked(identity);
      if (!session.ok) return session;
      const parsedRequest = parseRequest(CancelOperationRequestSchema, identity, request);
      if (!parsedRequest.ok) return parsedRequest;
      return admitCancelOnState(session.value, parsedRequest.value);
    },

    resetRuntime(identity, request) {
      const session = resolveChecked(identity);
      if (!session.ok) return session;
      const state = session.value;
      const parsedRequest = parseRequest(ResetRuntimeRequestSchema, identity, request);
      if (!parsedRequest.ok) return parsedRequest;
      // Revoke every reservation of this generation; provider teardown is the
      // close path's job (P5.4/P5.9) — admission only moves trusted state.
      state.attempts.clear();
      state.foregroundOperationId = null;
      state.backgroundProcesses.clear();
      const nextIdentity: RuntimeSessionIdentity = deepFreeze({
        session_id: state.identity.session_id,
        generation: state.identity.generation + 1,
      });
      const nextState: SessionState = { ...state, identity: nextIdentity };
      sessions.set(nextIdentity.session_id, nextState);
      return { ok: true, value: nextIdentity };
    },

    disposeSession(identity) {
      const session = resolveChecked(identity);
      if (!session.ok) return session;
      const state = session.value;
      state.status = "disposed";
      state.attempts.clear();
      state.foregroundOperationId = null;
      state.backgroundProcesses.clear();
      return { ok: true, value: null };
    },
  };

  function makeSessionHandle(state: SessionState): AdmissionSession {
    return {
      identity: state.identity,
      catalog: state.catalog,
      executionAuthorized: state.executionAuthorized,
      info(): AdmissionSessionInfo {
        return {
          session_id: state.identity.session_id,
          generation: state.identity.generation,
          course_id: state.catalog.course_id,
          lesson_id: state.catalog.lesson_id,
          lesson_compiled_digest: state.catalog.lesson_compiled_digest,
          execution_authorized: state.executionAuthorized,
        };
      },
      recordForegroundCompletion(operationId: string, attemptId: string, outcome: OperationOutcome): AdmissionOutcome<null> {
        const record = state.attempts.get(operationId);
        if (record === undefined || record.attempt_id !== attemptId || record.kind !== "run" || record.mode !== "foreground") {
          return rejected("INVALID_REQUEST", `no foreground reservation '${operationId}/${attemptId}' to complete`);
        }
        if (state.foregroundOperationId !== operationId) {
          return rejected("INVALID_REQUEST", `foreground slot is not held by '${operationId}'`);
        }
        record.status = "completed";
        record.outcome = outcome;
        state.foregroundOperationId = null;
        return { ok: true, value: null };
      },
      recordBackgroundCompletion(processId: string, operationId: string, attemptId: string, outcome: OperationOutcome): AdmissionOutcome<null> {
        const record = state.attempts.get(operationId);
        if (record === undefined || record.attempt_id !== attemptId || record.kind !== "run" || record.mode !== "background" || record.process_id !== processId) {
          return rejected("INVALID_REQUEST", `no background reservation '${operationId}/${attemptId}' for process '${processId}' to complete`);
        }
        if (record.status === "completed") {
          return rejected("DUPLICATE_START", `background attempt '${operationId}/${attemptId}' already completed`);
        }
        record.status = "completed";
        record.outcome = outcome;
        // Release the occupancy mapping; the attempt tombstone (one attempt
        // per operation per generation) stays.
        const mapping = state.backgroundProcesses.get(processId);
        if (mapping !== undefined && mapping.attempt_id === attemptId) state.backgroundProcesses.delete(processId);
        return { ok: true, value: null };
      },
      dispose(): void {
        state.status = "disposed";
        state.attempts.clear();
        state.foregroundOperationId = null;
        state.backgroundProcesses.clear();
      },
    };
  }

  return service;
}

function requestIdOf(request: unknown): string | null {
  if (request !== null && typeof request === "object" && "request_id" in request) {
    const value = (request as { request_id: unknown }).request_id;
    if (typeof value === "string") return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-state admission (session lookup and request validation already done)
// ---------------------------------------------------------------------------

function admitRunOnState(state: SessionState, request: RunOperationRequest): AdmissionOutcome<RunAdmission> {
  if (!state.executionAuthorized) {
    return rejected("NOT_AUTHORIZED", "session is inspection-only: no execution grants are issued", request.request_id);
  }
  const entry = state.catalog.operations.get(request.operation_id);
  if (entry === undefined) {
    return rejected("INVALID_REQUEST", `unknown operation '${request.operation_id}' in lesson '${state.catalog.lesson_id}'`, request.request_id);
  }
  if (state.attempts.has(entry.operation_id)) {
    return rejected("DUPLICATE_START", `operation '${entry.operation_id}' already has its one attempt in generation ${state.identity.generation}`, request.request_id);
  }

  const parameters = entry.operation.parameters;
  if (parameters.type === "terminal_run") {
    return admitTerminalRun(state, entry, parameters, request);
  }
  if (parameters.type === "terminal_stop") {
    return admitStopOnState(state, request.request_id, {
      origin: "authored_operation",
      operation_id: entry.operation_id,
      scene_id: entry.scene_id,
      beat_id: entry.beat_id,
      processId: parameters.process_id,
    });
  }
  if (parameters.type === "wait") {
    // P5.10: process_output waits are the internal admitted observation
    // primitive (trusted WaitAdmission -> waitForProcessOutput). Duration and
    // port waits belong to later engines: no TCP probe and no wait scheduling
    // exist in P5 (design "Future PortReadinessProvider interface can be
    // declared, no P5 TCP probe implementation"; "full wait scheduling/UI
    // execution stays P8").
    if (parameters.until === "process_output") {
      return admitProcessOutputWait(state, entry, parameters, request);
    }
    return rejected("UNSUPPORTED_PHASE", `operation '${entry.operation_id}' has type 'wait until=${parameters.until}', which this terminal runtime does not execute`, request.request_id);
  }
  // Every other family belongs to a later runtime engine.
  return rejected("UNSUPPORTED_PHASE", `operation '${entry.operation_id}' has type '${parameters.type}', which this terminal runtime does not execute`, request.request_id);
}

function admitTerminalRun(
  state: SessionState,
  entry: OperationIndexEntry,
  parameters: Extract<CompiledOperation["parameters"], { type: "terminal_run" }>,
  request: RunOperationRequest,
): AdmissionOutcome<RunAdmission> {
  // Command profile: NUL and oversized commands are runtime policy, rejected
  // before any provider could see them. Content is otherwise preserved exactly.
  const command = parameters.command;
  if (command.includes("\0")) {
    return rejected("UNSUPPORTED_COMMAND_PROFILE", "command contains NUL", request.request_id);
  }
  if (Buffer.byteLength(command, "utf8") > ADMISSION_POLICY.max_command_bytes) {
    return rejected("UNSUPPORTED_COMMAND_PROFILE", "command exceeds the 16 KiB runtime profile limit", request.request_id);
  }

  const attemptId = `att-${padded(state.nextAttemptNumber + 1)}`;
  let grant: ExecutionGrant;

  if (parameters.mode === "foreground") {
    if (state.foregroundOperationId !== null) {
      return rejected("DUPLICATE_START", `foreground operation '${state.foregroundOperationId}' is still reserved; one foreground at a time`, request.request_id);
    }
    const timeoutSeconds = parameters.timeout_seconds ?? ADMISSION_POLICY.foreground_timeout_default_ms / 1000;
    const timeoutMs = timeoutSeconds * 1000;
    if (timeoutMs > ADMISSION_POLICY.foreground_timeout_max_ms) {
      return rejected("INVALID_REQUEST", `authored timeout ${timeoutSeconds}s exceeds the 3600 s maximum`, request.request_id);
    }
    grant = {
      kind: "execution_grant",
      grant_version: EXECUTION_GRANT_VERSION,
      session_id: state.identity.session_id,
      generation: state.identity.generation,
      request_id: request.request_id,
      attempt_id: attemptId,
      operation_id: entry.operation_id,
      operation_type: "terminal_run",
      mode: "foreground",
      course_id: state.catalog.course_id,
      lesson_id: state.catalog.lesson_id,
      scene_id: entry.scene_id,
      beat_id: entry.beat_id,
      process_id: null,
      command,
      cwd: parameters.cwd ?? null,
      timeout_ms: timeoutMs,
      expected_exit_code: parameters.expected_exit_code ?? 0,
    };
  } else {
    const processId = parameters.process_id;
    if (processId === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `background terminal_run '${entry.operation_id}' has no logical process id`, request.request_id);
    }
    const definition = state.catalog.processes.get(processId);
    if (definition === undefined) {
      return rejected("IR_RUNTIME_INCONSISTENT", `background terminal_run '${entry.operation_id}' defines process '${processId}' without an inventory entry`, request.request_id);
    }
    if (state.backgroundProcesses.has(processId)) {
      return rejected("DUPLICATE_START", `logical process '${processId}' is already owned by operation '${state.backgroundProcesses.get(processId)?.operation_id}'`, request.request_id);
    }
    if (state.backgroundProcesses.size >= ADMISSION_POLICY.max_concurrent_backgrounds) {
      return rejected("INVALID_REQUEST", `session already holds ${ADMISSION_POLICY.max_concurrent_backgrounds} background processes (design maximum)`, request.request_id);
    }
    grant = {
      kind: "execution_grant",
      grant_version: EXECUTION_GRANT_VERSION,
      session_id: state.identity.session_id,
      generation: state.identity.generation,
      request_id: request.request_id,
      attempt_id: attemptId,
      operation_id: entry.operation_id,
      operation_type: "terminal_run",
      mode: "background",
      course_id: state.catalog.course_id,
      lesson_id: state.catalog.lesson_id,
      scene_id: entry.scene_id,
      beat_id: entry.beat_id,
      process_id: processId,
      command,
      cwd: parameters.cwd ?? null,
      timeout_ms: null,
      expected_exit_code: null,
    };
  }

  const validatedGrant = ExecutionGrantSchema.safeParse(grant);
  if (!validatedGrant.success) {
    // A grant that cannot satisfy its own schema is an admission bug: fail
    // closed and roll the reservation back.
    return rejected("INVALID_REQUEST", "internal: generated grant failed its own schema", request.request_id);
  }
  // Reservation happens only after the grant is fully valid ("reserve before
  // awaits"); the immutable grant is handed out frozen.
  state.nextAttemptNumber += 1;
  state.attempts.set(entry.operation_id, {
    attempt_id: attemptId,
    kind: "run",
    mode: grant.mode,
    process_id: grant.process_id,
    scene_id: entry.scene_id,
    beat_id: entry.beat_id,
    status: "reserved",
    outcome: null,
  });
  if (grant.mode === "foreground") {
    state.foregroundOperationId = entry.operation_id;
  } else if (grant.process_id !== null) {
    state.backgroundProcesses.set(grant.process_id, { operation_id: entry.operation_id, attempt_id: attemptId });
  }
  return { ok: true, value: deepFreeze(validatedGrant.data) };
}

interface StopResolution {
  origin: "authored_operation" | "operator_request";
  operation_id: string | null;
  scene_id: string | null;
  beat_id: string | null;
  processId: string;
}

/**
 * P5.10 process_output wait admission (design "Process-output waits /
 * readiness" + "IR Integration": "wait process_output — Internal admitted
 * observation primitive").
 *
 * The renderer never supplies the readiness literal, the target or the
 * deadline: all three come exclusively from the canonical validated
 * CompiledLesson IR (operation parameters + references + inventory). The
 * wait observes a DEFINED background process — it deliberately does NOT
 * require the process to be started, so the caller can register the wait at
 * background spawn time and no early READY marker is lost. Liveness (already
 * dead -> PROCESS_EXITED) is the waiter primitive's runtime check, not an
 * admission gate. Waits occupy no foreground/background execution slot; they
 * consume only their one operation attempt per generation (only reset reuses
 * a definition).
 */
function admitProcessOutputWait(
  state: SessionState,
  entry: OperationIndexEntry,
  parameters: Extract<CompiledOperation["parameters"], { type: "wait" }>,
  request: RunOperationRequest,
): AdmissionOutcome<RunAdmission> {
  if (parameters.until !== "process_output") {
    return rejected("UNSUPPORTED_PHASE", `operation '${entry.operation_id}' has type 'wait until=${parameters.until}', which this terminal runtime does not execute`, request.request_id);
  }
  const processId = parameters.process_id;
  const text = parameters.text;
  const timeoutSeconds = parameters.timeout_seconds;
  if (processId === undefined || text === undefined || timeoutSeconds === undefined) {
    return rejected("INVALID_REQUEST", `wait '${entry.operation_id}' is missing its process_output fields (process_id/text/timeout_seconds)`, request.request_id);
  }
  // Runtime policy on the literal: case-sensitive whole literal, 1–4096
  // chars, no NUL. Content is otherwise preserved exactly (no rewriting).
  if (text.length === 0 || text.includes("\0")) {
    return rejected("INVALID_REQUEST", `wait '${entry.operation_id}' carries an empty or NUL-containing readiness literal`, request.request_id);
  }
  if (text.length > WAIT_POLICY.max_text_chars) {
    return rejected("INVALID_REQUEST", `wait '${entry.operation_id}' readiness text exceeds the ${WAIT_POLICY.max_text_chars}-char bound`, request.request_id);
  }
  const timeoutMs = timeoutSeconds * 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return rejected("INVALID_REQUEST", `wait '${entry.operation_id}' carries an invalid timeout`, request.request_id);
  }
  if (timeoutMs > WAIT_POLICY.max_timeout_ms) {
    return rejected("INVALID_REQUEST", `authored wait timeout ${timeoutSeconds}s exceeds the 3600 s maximum`, request.request_id);
  }
  const definition = state.catalog.processes.get(processId);
  if (definition === undefined) {
    return rejected("INVALID_PROCESS_REFERENCE", `wait '${entry.operation_id}' references unknown logical process '${processId}'`, request.request_id);
  }
  const reference = entry.operation.references?.process;
  if (reference === undefined) {
    return rejected("IR_RUNTIME_INCONSISTENT", `wait '${entry.operation_id}' has no process reference`, request.request_id);
  }
  if (reference.process_id !== processId) {
    return rejected("IR_RUNTIME_INCONSISTENT", `wait '${entry.operation_id}' parameters and references disagree on the process id`, request.request_id);
  }
  if (reference.defined_in.scene_id !== definition.defined_in.scene_id || reference.defined_in.beat_id !== definition.defined_in.beat_id) {
    return rejected("IR_RUNTIME_INCONSISTENT", `wait '${entry.operation_id}' references do not agree with the definition of process '${processId}'`, request.request_id);
  }
  const attemptId = `att-${padded(state.nextAttemptNumber + 1)}`;
  const waitAdmission: WaitAdmission = {
    kind: "wait_admission",
    grant_version: EXECUTION_GRANT_VERSION,
    session_id: state.identity.session_id,
    generation: state.identity.generation,
    request_id: request.request_id,
    operation_id: entry.operation_id,
    attempt_id: attemptId,
    course_id: state.catalog.course_id,
    lesson_id: state.catalog.lesson_id,
    scene_id: entry.scene_id,
    beat_id: entry.beat_id,
    target: {
      process_id: processId,
      defined_in: definition.defined_in,
    },
    text,
    timeout_ms: timeoutMs,
  };
  const validated = WaitAdmissionSchema.safeParse(waitAdmission);
  if (!validated.success) {
    return rejected("INVALID_REQUEST", "internal: generated wait admission failed its own schema", request.request_id);
  }
  // One attempt per operation per generation ("reserve before awaits"); the
  // immutable admission is handed out frozen. Waits hold no execution slot.
  state.nextAttemptNumber += 1;
  state.attempts.set(entry.operation_id, {
    attempt_id: attemptId,
    kind: "wait",
    mode: null,
    process_id: processId,
    scene_id: entry.scene_id,
    beat_id: entry.beat_id,
    status: "reserved",
    outcome: null,
  });
  return { ok: true, value: deepFreeze(validated.data) };
}

function admitStopOnState(state: SessionState, requestId: string, resolution: StopResolution): AdmissionOutcome<StopAdmission> {
  const definition = state.catalog.processes.get(resolution.processId);
  if (definition === undefined) {
    return rejected("INVALID_PROCESS_REFERENCE", `unknown logical process '${resolution.processId}'`, requestId);
  }
  const mapping = state.backgroundProcesses.get(resolution.processId);
  if (mapping === undefined) {
    return rejected("PROCESS_NOT_STARTED", `logical process '${resolution.processId}' is defined but was never started in this generation`, requestId);
  }
  const stopAdmission: StopAdmission = {
    kind: "stop_admission",
    grant_version: EXECUTION_GRANT_VERSION,
    session_id: state.identity.session_id,
    generation: state.identity.generation,
    request_id: requestId,
    origin: resolution.origin,
    operation_id: resolution.operation_id,
    attempt_id: resolution.operation_id === null ? null : `att-${padded(state.nextAttemptNumber + 1)}`,
    scene_id: resolution.scene_id,
    beat_id: resolution.beat_id,
    target: {
      process_id: resolution.processId,
      defined_in: definition.defined_in,
    },
  };
  const validated = StopAdmissionSchema.safeParse(stopAdmission);
  if (!validated.success) {
    return rejected("INVALID_REQUEST", "internal: generated stop admission failed its own schema", requestId);
  }
  if (resolution.operation_id !== null) {
    // An authored stop consumes its one attempt like any operation; operator
    // stops are not lesson operations and carry no attempt.
    state.nextAttemptNumber += 1;
    state.attempts.set(resolution.operation_id, {
      attempt_id: validated.data.attempt_id ?? "",
      kind: "stop",
      mode: null,
      process_id: resolution.processId,
      scene_id: resolution.scene_id ?? "",
      beat_id: resolution.beat_id ?? "",
      status: "reserved",
      outcome: null,
    });
  }
  return { ok: true, value: deepFreeze(validated.data) };
}

function admitCancelOnState(state: SessionState, request: CancelOperationRequest): AdmissionOutcome<CancelAdmission> {
  const record = state.attempts.get(request.operation_id);
  if (record === undefined || record.kind !== "run" || record.mode !== "foreground" || state.foregroundOperationId !== request.operation_id) {
    return rejected("INVALID_REQUEST", `no cancellable foreground operation '${request.operation_id}'`, request.request_id);
  }
  const cancelAdmission: CancelAdmission = {
    kind: "cancel_admission",
    grant_version: EXECUTION_GRANT_VERSION,
    session_id: state.identity.session_id,
    generation: state.identity.generation,
    request_id: request.request_id,
    operation_id: request.operation_id,
    attempt_id: record.attempt_id,
    scene_id: record.scene_id,
    beat_id: record.beat_id,
  };
  const validated = CancelAdmissionSchema.safeParse(cancelAdmission);
  if (!validated.success) {
    return rejected("INVALID_REQUEST", "internal: generated cancel admission failed its own schema", request.request_id);
  }
  return { ok: true, value: deepFreeze(validated.data) };
}
