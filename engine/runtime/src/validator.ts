// P8.2 Pre-Run Static & Dependency Validator
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 11 & Section 12, and ADR-0013.
// Preflight static analysis verifying IR validity, identity integrity, DAG consistency,
// background process lifecycles, port/browser alignment, workspace paths, and engine capabilities
// BEFORE runtime transitions to READY.
// ZERO engine side effects: zero child_process, zero Docker, zero Chromium, zero fs mutation.

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ActionType,
  type EngineFamily,
  type StepKind,
  routeStepToEngineFamily,
  EngineFamilySchema,
  StepKindSchema,
  ActionTypeSchema,
  LessonIdSchema,
  CourseIdSchema,
  SceneIdSchema,
  StepIdSchema,
  ProcessIdSchema,
} from "./protocol.ts";
import {
  type RuntimeErrorDto,
  RuntimeErrorDtoSchema,
  type RuntimeErrorCode,
  sanitizeErrorMessage,
} from "./errors.ts";
import {
  type CompiledLesson,
  type CompiledStep,
  validateCompiledLesson,
  COMPILED_IR_VERSION,
} from "@course-factory/lesson-compiler/ir";
import { FilePath } from "@course-factory/shared-types";

// ---------------------------------------------------------------------------
// Validator Bounds & Diagnostic Codes
// ---------------------------------------------------------------------------

export const MAX_VALIDATION_ERRORS = 50;
export const MAX_WAIT_DURATION_SECONDS = 3600;
export const MAX_PAUSE_SECONDS = 300;
export const MAX_WAIT_TIMEOUT_SECONDS = 300;

export const VALIDATOR_DIAGNOSTIC_CODES = [
  "ERR_VAL_IR_INVALID",
  "ERR_VAL_DUPLICATE_OPERATION_ID",
  "ERR_VAL_ORPHAN_PROCESS_REFERENCE",
  "ERR_VAL_UNREACHABLE_PORT",
  "ERR_VAL_UNCONFINED_PATH",
  "ERR_VAL_CAPABILITY_UNAVAILABLE",
  "ERR_VAL_UNOPENED_FILE",
  "ERR_VAL_UNKNOWN_FILE",
] as const;
export type ValidatorDiagnosticCode = (typeof VALIDATOR_DIAGNOSTIC_CODES)[number];

// ---------------------------------------------------------------------------
// Host Capability Descriptor
// ---------------------------------------------------------------------------

export const HostCapabilityDescriptorSchema = z.strictObject({
  editorAvailable: z.boolean(),
  terminalAvailable: z.boolean(),
  browserAvailable: z.boolean(),
  waitAvailable: z.boolean().optional(),
  narrationAvailable: z.boolean().optional(),
  visualAvailable: z.boolean().optional(),
  chromiumPath: z.string().optional(),
  dockerAvailable: z.boolean().optional(),
  workspaceRoot: z.string().optional(),
});
export type HostCapabilityDescriptor = z.infer<typeof HostCapabilityDescriptorSchema>;

export const DEFAULT_HOST_CAPABILITIES: HostCapabilityDescriptor = Object.freeze({
  editorAvailable: true,
  terminalAvailable: true,
  browserAvailable: true,
  waitAvailable: true,
  narrationAvailable: true,
  visualAvailable: true,
});

// ---------------------------------------------------------------------------
// Seed Manifest Metadata (Optional Reviewed Seed Config)
// ---------------------------------------------------------------------------

export interface SeedManifestEntry {
  readonly portable_path: string;
  readonly kind: "regular_file" | "directory";
  readonly byte_length?: number;
  readonly sha256?: string | null;
}

export interface RuntimeValidationConfig {
  readonly seedManifest?: readonly SeedManifestEntry[];
  readonly allowedFixtureOrigins?: readonly string[];
}

// ---------------------------------------------------------------------------
// Validated Runtime Plan (Immutable Output Contract)
// ---------------------------------------------------------------------------

export interface ValidatedStepPlan {
  readonly step_id: string;
  readonly scene_id: string;
  readonly scene_index: number;
  readonly step_index: number;
  readonly global_step_ordinal: number;
  readonly kind: StepKind;
  readonly engine: EngineFamily;
  readonly action_type?: ActionType;
  readonly dependencies: readonly string[];
}

export const ValidatedStepPlanSchema = z.strictObject({
  step_id: StepIdSchema,
  scene_id: SceneIdSchema,
  scene_index: z.number().int().min(0),
  step_index: z.number().int().min(0),
  global_step_ordinal: z.number().int().min(1),
  kind: StepKindSchema,
  engine: EngineFamilySchema,
  action_type: ActionTypeSchema.optional(),
  dependencies: z.array(StepIdSchema),
});

export interface ValidatedProcessPlan {
  readonly process_id: string;
  readonly producer_step_id: string;
  readonly stopped_step_id?: string;
  readonly guest_ports: readonly number[];
  readonly lifetime: "TERMINATED_IN_LESSON" | "LIVES_UNTIL_COMPLETION";
}

export const ValidatedProcessPlanSchema = z.strictObject({
  process_id: ProcessIdSchema,
  producer_step_id: StepIdSchema,
  stopped_step_id: StepIdSchema.optional(),
  guest_ports: z.array(z.number().int().min(1).max(65535)),
  lifetime: z.enum(["TERMINATED_IN_LESSON", "LIVES_UNTIL_COMPLETION"]),
});

export interface ValidatedRuntimePlan {
  readonly lesson_id: string;
  readonly course_id: string;
  readonly title: string;
  readonly compiled_ir_digest: string;
  readonly plan_digest: string;
  readonly total_steps: number;
  readonly capabilities_required: readonly EngineFamily[];
  readonly ordered_steps: readonly ValidatedStepPlan[];
  readonly background_processes: readonly ValidatedProcessPlan[];
  readonly completion_cleanup_processes: readonly string[];
}

export const ValidatedRuntimePlanSchema = z.strictObject({
  lesson_id: LessonIdSchema,
  course_id: CourseIdSchema,
  title: z.string().min(1),
  compiled_ir_digest: z.string().regex(/^[0-9a-f]{64}$/),
  plan_digest: z.string().regex(/^[0-9a-f]{64}$/),
  total_steps: z.number().int().min(1),
  capabilities_required: z.array(EngineFamilySchema),
  ordered_steps: z.array(ValidatedStepPlanSchema),
  background_processes: z.array(ValidatedProcessPlanSchema),
  completion_cleanup_processes: z.array(ProcessIdSchema),
});

export interface ValidationReport {
  readonly ok: boolean;
  readonly plan: ValidatedRuntimePlan | null;
  readonly errors: readonly RuntimeErrorDto[];
}

// ---------------------------------------------------------------------------
// Deterministic Canonical JSON & Hash Helper (Local, Pure)
// ---------------------------------------------------------------------------

function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep) as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted as T;
  }
  return value;
}

function computeDigest(data: unknown): string {
  const json = JSON.stringify(sortKeysDeep(data));
  return createHash("sha256").update(json, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Pure Workspace Path Safety Validator (P6/P8 Confinement Rule)
// ---------------------------------------------------------------------------

const RESERVED_DEVICE_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export function validateProjectRelativePath(value: string): { ok: true } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "path is empty" };
  }
  if (/^[A-Za-z]:/.test(value)) {
    return { ok: false, reason: "drive letters are not allowed (absolute Windows path)" };
  }
  if (value.startsWith("//") || value.startsWith("\\\\")) {
    return { ok: false, reason: "UNC prefixes are not allowed" };
  }
  if (value.includes("\\")) {
    return { ok: false, reason: "backslashes are not allowed (use '/')" };
  }
  if (value.startsWith("/")) {
    return { ok: false, reason: "leading '/' is not allowed (must be project-relative)" };
  }
  if (value.includes(":") || value.toLowerCase().includes("::$")) {
    return { ok: false, reason: "drive or ADS separators are not allowed" };
  }
  if (value.includes("\0")) {
    return { ok: false, reason: "NUL characters are not allowed" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return { ok: false, reason: "control characters are not allowed" };
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return { ok: false, reason: "empty segments (double or trailing slashes) are not allowed" };
  }
  if (segments.includes("..") || segments.includes(".")) {
    return { ok: false, reason: "dot or traversal segments ('.' or '..') are not allowed" };
  }
  for (const segment of segments) {
    if (segment.endsWith(" ") || segment.endsWith(".")) {
      return { ok: false, reason: `segment '${segment}' must not end with a space or dot` };
    }
    const basename = segment.split(".")[0].toLowerCase();
    if (RESERVED_DEVICE_BASENAMES.has(basename)) {
      return { ok: false, reason: `segment '${segment}' is a reserved Windows device name` };
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-./]*$/.test(value)) {
    return { ok: false, reason: "characters outside [A-Za-z0-9_-./] are not allowed" };
  }

  // Also enforce shared-types FilePath schema
  const fpCheck = FilePath.safeParse(value);
  if (!fpCheck.success) {
    return { ok: false, reason: fpCheck.error.issues[0]?.message ?? "invalid path" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pure Browser Origin & URL Validator
// ---------------------------------------------------------------------------

export function validateBrowserOrigin(
  urlString: string,
  allowedOrigins: readonly string[],
): { ok: true; url: URL; canonicalOrigin: string } | { ok: false; code: string; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return {
      ok: false,
      code: "INVALID_URL",
      message: `URL '${urlString}' is not a parseable URL`,
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "INVALID_SCHEME",
      message: `Only http/https URLs are allowed (got '${parsed.protocol}')`,
    };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      code: "URL_CREDENTIALS_FORBIDDEN",
      message: "URLs with embedded credentials are not allowed",
    };
  }

  const canonicalOrigin = `${parsed.protocol}//${parsed.host}`.toLowerCase();
  const normalizedAllowed = allowedOrigins.map((o) => o.toLowerCase());

  if (!normalizedAllowed.includes(canonicalOrigin)) {
    return {
      ok: false,
      code: "ORIGIN_NOT_REVIEWED",
      message: `Origin '${canonicalOrigin}' not declared in reviewed browser origins`,
    };
  }

  return { ok: true, url: parsed, canonicalOrigin };
}

// ---------------------------------------------------------------------------
// Error Collector Helper
// ---------------------------------------------------------------------------

class ErrorCollector {
  private readonly errors: RuntimeErrorDto[] = [];

  add(code: RuntimeErrorCode, message: string, stepId?: string): void {
    if (this.errors.length >= MAX_VALIDATION_ERRORS) {
      return;
    }
    const sanitizedMsg = sanitizeErrorMessage(message);
    const dto: RuntimeErrorDto = {
      code,
      message: sanitizedMsg,
      retry: "NOT_RETRYABLE",
      request_id: null,
      step_id: stepId,
    };
    // Validate that DTO matches schema
    const validated = RuntimeErrorDtoSchema.parse(dto);
    this.errors.push(validated);
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  getErrors(): readonly RuntimeErrorDto[] {
    return Object.freeze([...this.errors]);
  }
}

// ---------------------------------------------------------------------------
// Canonical Pre-Run Lesson Validator Function
// ---------------------------------------------------------------------------

export function validateLesson(
  input: unknown,
  hostCapabilities: HostCapabilityDescriptor = DEFAULT_HOST_CAPABILITIES,
  config: RuntimeValidationConfig = {},
): ValidationReport {
  const collector = new ErrorCollector();

  // -------------------------------------------------------------------------
  // Stage 1: Protocol / IR Compatibility & Basic Parsing
  // -------------------------------------------------------------------------
  if (input === null || typeof input !== "object") {
    collector.add("RUNTIME_INVALID_LESSON", "[ERR_VAL_IR_INVALID] Input must be a valid non-null object");
    return { ok: false, plan: null, errors: collector.getErrors() };
  }

  const raw = input as Record<string, unknown>;
  if (raw["compiled_ir_version"] !== COMPILED_IR_VERSION) {
    collector.add(
      "RUNTIME_INVALID_LESSON",
      `[ERR_VAL_IR_INVALID] Unsupported compiled IR version '${raw["compiled_ir_version"]}' (expected '${COMPILED_IR_VERSION}')`,
    );
    return { ok: false, plan: null, errors: collector.getErrors() };
  }

  const parseResult = validateCompiledLesson(input);
  if (!parseResult.ok || !parseResult.ir) {
    for (const issue of parseResult.issues) {
      if (issue.message.includes("INVALID_PROJECT_RELATIVE_PATH") || issue.message.includes("..")) {
        collector.add(
          "PREFLIGHT_VALIDATION_FAILED",
          `[ERR_VAL_UNCONFINED_PATH] Invalid workspace path at '${issue.path}': ${issue.message}`,
        );
      } else {
        collector.add(
          "RUNTIME_INVALID_LESSON",
          `[ERR_VAL_IR_INVALID] Schema issue at '${issue.path}': ${issue.message}`,
        );
      }
      if (collector.hasErrors() && collector.getErrors().length >= MAX_VALIDATION_ERRORS) {
        break;
      }
    }
    return { ok: false, plan: null, errors: collector.getErrors() };
  }

  const ir: CompiledLesson = parseResult.ir;

  // -------------------------------------------------------------------------
  // Stage 2: Identity Integrity & Source Digest
  // -------------------------------------------------------------------------
  if (!ir.source || !ir.source.hash || typeof ir.source.hash.value !== "string") {
    collector.add("RUNTIME_INVALID_LESSON", "[ERR_VAL_IR_INVALID] Source hash is missing or malformed");
  } else {
    if (ir.source.hash.algorithm !== "sha256") {
      collector.add(
        "RUNTIME_INVALID_LESSON",
        `[ERR_VAL_IR_INVALID] Source hash algorithm must be 'sha256' (got '${ir.source.hash.algorithm}')`,
      );
    }
    if (ir.source.hash.canonicalization !== "canonical-json-v1") {
      collector.add(
        "RUNTIME_INVALID_LESSON",
        `[ERR_VAL_IR_INVALID] Source hash canonicalization must be 'canonical-json-v1' (got '${ir.source.hash.canonicalization}')`,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(ir.source.hash.value)) {
      collector.add(
        "RUNTIME_INVALID_LESSON",
        `[ERR_VAL_IR_INVALID] Source hash value must be 64-char lowercase hex`,
      );
    }
  }

  const courseId = ir.lesson.course_id;
  const lessonId = ir.lesson.lesson_id;

  if (!courseId || !/^C\d{2}$/.test(courseId)) {
    collector.add("RUNTIME_INVALID_LESSON", `[ERR_VAL_IR_INVALID] Malformed course_id '${courseId}'`);
  }
  if (!lessonId || !/^C\d{2}-L\d{3}$/.test(lessonId)) {
    collector.add("RUNTIME_INVALID_LESSON", `[ERR_VAL_IR_INVALID] Malformed lesson_id '${lessonId}'`);
  }
  if (courseId && lessonId && !lessonId.startsWith(`${courseId}-`)) {
    collector.add(
      "RUNTIME_INVALID_LESSON",
      `[ERR_VAL_IR_INVALID] lesson_id '${lessonId}' does not match course_id '${courseId}'`,
    );
  }

  // -------------------------------------------------------------------------
  // Stage 3: Scene & Step Ordering, Ordinal Continuity, Unique IDs
  // -------------------------------------------------------------------------
  const seenSceneIds = new Set<string>();
  const seenStepIds = new Set<string>();
  const allOrderedSteps: Array<{
    step: CompiledStep;
    sceneId: string;
    sceneIndex: number;
    stepIndex: number;
    globalStepOrdinal: number;
  }> = [];

  let expectedGlobalOrdinal = 1;

  for (let sceneIndex = 0; sceneIndex < ir.scenes.length; sceneIndex++) {
    const scene = ir.scenes[sceneIndex]!;
    const expectedSceneOrdinal = sceneIndex + 1;

    if (seenSceneIds.has(scene.scene_id)) {
      collector.add(
        "DUPLICATE_OPERATION",
        `[ERR_VAL_DUPLICATE_OPERATION_ID] Duplicate scene_id '${scene.scene_id}'`,
      );
    } else {
      seenSceneIds.add(scene.scene_id);
    }

    if (scene.ordinal !== expectedSceneOrdinal) {
      collector.add(
        "RUNTIME_INVALID_LESSON",
        `[ORDINAL_INTEGRITY] Scene '${scene.scene_id}' ordinal (${scene.ordinal}) must equal expected index (${expectedSceneOrdinal})`,
      );
    }

    if (lessonId && !scene.scene_id.startsWith(`${lessonId}-S`)) {
      collector.add(
        "RUNTIME_INVALID_LESSON",
        `[ERR_VAL_IR_INVALID] scene_id '${scene.scene_id}' does not match lesson_id '${lessonId}'`,
      );
    }

    for (let stepIndex = 0; stepIndex < scene.steps.length; stepIndex++) {
      const step = scene.steps[stepIndex]!;
      const expectedStepOrdinal = stepIndex + 1;

      if (seenStepIds.has(step.step_id)) {
        collector.add(
          "DUPLICATE_OPERATION",
          `[ERR_VAL_DUPLICATE_OPERATION_ID] Duplicate step_id '${step.step_id}' found in scene '${scene.scene_id}'`,
          step.step_id,
        );
      } else {
        seenStepIds.add(step.step_id);
      }

      if (step.ordinal !== expectedStepOrdinal) {
        collector.add(
          "RUNTIME_INVALID_LESSON",
          `[ORDINAL_INTEGRITY] Step '${step.step_id}' ordinal (${step.ordinal}) must equal expected position (${expectedStepOrdinal})`,
          step.step_id,
        );
      }

      if (step.derived) {
        if (!step.step_id.startsWith(`${scene.scene_id}-STEP`)) {
          collector.add(
            "RUNTIME_INVALID_LESSON",
            `[ERR_VAL_IR_INVALID] Derived step_id '${step.step_id}' does not match scene '${scene.scene_id}'`,
            step.step_id,
          );
        }
      } else {
        if (!step.step_id.startsWith(`${scene.scene_id}-`)) {
          collector.add(
            "RUNTIME_INVALID_LESSON",
            `[ERR_VAL_IR_INVALID] Authored step_id '${step.step_id}' does not match scene '${scene.scene_id}'`,
            step.step_id,
          );
        }
      }

      allOrderedSteps.push({
        step,
        sceneId: scene.scene_id,
        sceneIndex,
        stepIndex,
        globalStepOrdinal: expectedGlobalOrdinal++,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Stage 4: Action Routing Verification
  // -------------------------------------------------------------------------
  const requiredEngineFamilies = new Set<EngineFamily>();

  for (const { step } of allOrderedSteps) {
    try {
      let actionType: ActionType | undefined;
      let waitCondition: "duration" | "port" | "process_output" | undefined;
      const stepKind: StepKind = step.kind === "operation" ? "action" : step.kind;

      if (step.kind === "operation") {
        actionType = step.operation.type as ActionType;
        if (actionType === "wait") {
          const waitParams = step.operation.parameters as { until?: unknown };
          waitCondition = waitParams.until as "duration" | "port" | "process_output" | undefined;
        }
      }

      const family = routeStepToEngineFamily(stepKind, actionType, waitCondition);
      requiredEngineFamilies.add(family);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      collector.add("UNSUPPORTED_ACTION_TYPE", `[UNSUPPORTED_ACTION_TYPE] ${msg}`, step.step_id);
    }
  }

  // -------------------------------------------------------------------------
  // Stage 5: Workspace Path Confinement & Document Lifecycle Order
  // -------------------------------------------------------------------------
  const openedOrCreatedFiles = new Set<string>();
  const seedFiles = new Set<string>();

  if (config.seedManifest) {
    for (const entry of config.seedManifest) {
      seedFiles.add(entry.portable_path);
      openedOrCreatedFiles.add(entry.portable_path);
    }
  }

  for (const { step } of allOrderedSteps) {
    if (step.kind !== "operation") continue;
    const op = step.operation;
    const params = op.parameters as Record<string, unknown>;

    // 1. Path confinement check
    const checkPath = (pathVal: unknown, contextDesc: string) => {
      if (typeof pathVal !== "string") return;
      const res = validateProjectRelativePath(pathVal);
      if (!res.ok) {
        collector.add(
          "PREFLIGHT_VALIDATION_FAILED",
          `[ERR_VAL_UNCONFINED_PATH] Invalid workspace path in ${contextDesc}: '${pathVal}' (${res.reason})`,
          step.step_id,
        );
      }
    };

    if (op.type === "file_open" || op.type === "file_create" || op.type === "type_code" ||
        op.type === "replace_code" || op.type === "file_save" || op.type === "highlight") {
      checkPath(params["path"], `${op.type}.path`);
    }
    if (op.type === "terminal_run" && params["cwd"] !== undefined) {
      checkPath(params["cwd"], "terminal_run.cwd");
    }

    // 2. Document lifecycle ordering
    const filePath = typeof params["path"] === "string" ? params["path"] : undefined;

    if (filePath) {
      if (op.type === "file_create") {
        openedOrCreatedFiles.add(filePath);
      } else if (op.type === "file_open") {
        if (config.seedManifest && !seedFiles.has(filePath) && !openedOrCreatedFiles.has(filePath)) {
          collector.add(
            "DEPENDENCY_NOT_MET",
            `[ERR_VAL_UNKNOWN_FILE] File '${filePath}' opened by file_open does not exist in seed manifest or prior create`,
            step.step_id,
          );
        }
        openedOrCreatedFiles.add(filePath);
      } else if (op.type === "type_code" || op.type === "replace_code" || op.type === "file_save") {
        if (!openedOrCreatedFiles.has(filePath)) {
          collector.add(
            "DEPENDENCY_NOT_MET",
            `[ERR_VAL_UNOPENED_FILE] File '${filePath}' targeted by '${op.type}' must be opened or created earlier in lesson`,
            step.step_id,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 6 & 7: Process DAG, Process References, and Port Readiness
  // -------------------------------------------------------------------------
  // Pre-scan all background terminal runs across the lesson
  const allProducers = new Map<string, { stepId: string; globalOrdinal: number; sceneId: string }>();
  const duplicateProcessIds = new Set<string>();

  for (const { step, sceneId, globalStepOrdinal } of allOrderedSteps) {
    if (step.kind === "operation" && step.operation.type === "terminal_run") {
      const p = step.operation.parameters as { mode?: string; process_id?: string };
      if (p.mode === "background" && p.process_id) {
        if (allProducers.has(p.process_id)) {
          duplicateProcessIds.add(p.process_id);
          collector.add(
            "DUPLICATE_OPERATION",
            `[NO_DUPLICATE_PROCESS_IDS] Background process '${p.process_id}' is defined more than once in lesson`,
            step.step_id,
          );
        } else {
          allProducers.set(p.process_id, {
            stepId: step.step_id,
            globalOrdinal: globalStepOrdinal,
            sceneId,
          });
        }
      }
    }
  }

  // Linear progression tracking
  const activeProcesses = new Map<string, { producerStepId: string; producerOrdinal: number }>();
  const stoppedProcesses = new Map<string, { stoppedStepId: string; stoppedOrdinal: number }>();
  const confirmedReadyPorts = new Set<number>();
  const portReadyAtOrdinal = new Map<number, number>();
  const processGuestPorts = new Map<string, Set<number>>();
  const stepDependencyMap = new Map<string, Set<string>>();

  for (const { step } of allOrderedSteps) {
    stepDependencyMap.set(step.step_id, new Set());
  }

  for (const { step, globalStepOrdinal } of allOrderedSteps) {
    if (step.kind !== "operation") continue;
    const op = step.operation;
    const params = op.parameters as Record<string, unknown>;

    if (op.type === "terminal_run" && params["mode"] === "background") {
      const procId = params["process_id"] as string;
      if (procId && !duplicateProcessIds.has(procId)) {
        activeProcesses.set(procId, { producerStepId: step.step_id, producerOrdinal: globalStepOrdinal });
        if (!processGuestPorts.has(procId)) {
          processGuestPorts.set(procId, new Set());
        }
      }
    } else if (op.type === "terminal_stop") {
      const procId = params["process_id"] as string;
      if (!procId) {
        collector.add(
          "PREFLIGHT_VALIDATION_FAILED",
          `[ERR_VAL_ORPHAN_PROCESS_REFERENCE] terminal_stop missing required process_id`,
          step.step_id,
        );
      } else if (!allProducers.has(procId)) {
        collector.add(
          "DEPENDENCY_NOT_MET",
          `[ERR_VAL_ORPHAN_PROCESS_REFERENCE] terminal_stop references unknown process '${procId}'`,
          step.step_id,
        );
      } else {
        const prod = allProducers.get(procId)!;
        if (prod.globalOrdinal > globalStepOrdinal) {
          collector.add(
            "DEPENDENCY_NOT_MET",
            `[ERR_VAL_ORPHAN_PROCESS_REFERENCE] terminal_stop references future process '${procId}' (producer step '${prod.stepId}' appears later)`,
            step.step_id,
          );
        } else if (stoppedProcesses.has(procId)) {
          collector.add(
            "DEPENDENCY_NOT_MET",
            `[ERR_VAL_ORPHAN_PROCESS_REFERENCE] Process '${procId}' was already stopped at step '${stoppedProcesses.get(procId)!.stoppedStepId}'`,
            step.step_id,
          );
        } else {
          // Valid stop of an active process
          activeProcesses.delete(procId);
          stoppedProcesses.set(procId, { stoppedStepId: step.step_id, stoppedOrdinal: globalStepOrdinal });
          stepDependencyMap.get(step.step_id)?.add(prod.stepId);
        }
      }
    } else if (op.type === "wait") {
      const until = params["until"] as string;

      if (until === "process_output") {
        const procId = params["process_id"] as string;
        if (!procId) {
          collector.add(
            "PREFLIGHT_VALIDATION_FAILED",
            `[ERR_VAL_ORPHAN_PROCESS_REFERENCE] wait until: process_output missing required process_id`,
            step.step_id,
          );
        } else if (!allProducers.has(procId)) {
          collector.add(
            "DEPENDENCY_NOT_MET",
            `[ERR_VAL_ORPHAN_PROCESS_REFERENCE] wait until: process_output references unknown process '${procId}'`,
            step.step_id,
          );
        } else {
          const prod = allProducers.get(procId)!;
          if (prod.globalOrdinal > globalStepOrdinal) {
            collector.add(
              "DEPENDENCY_NOT_MET",
              `[ERR_VAL_ORPHAN_PROCESS_REFERENCE] wait until: process_output references future process '${procId}' (producer step '${prod.stepId}' appears later)`,
              step.step_id,
            );
          } else if (stoppedProcesses.has(procId)) {
            collector.add(
              "DEPENDENCY_NOT_MET",
              `[ERR_VAL_ORPHAN_PROCESS_REFERENCE] wait until: process_output references already-stopped process '${procId}'`,
              step.step_id,
            );
          } else {
            stepDependencyMap.get(step.step_id)?.add(prod.stepId);
          }
        }
      } else if (until === "port") {
        const port = params["port"] as number;
        if (typeof port !== "number" || port < 1 || port > 65535) {
          collector.add(
            "PREFLIGHT_VALIDATION_FAILED",
            `[ERR_VAL_UNREACHABLE_PORT] wait until: port requires valid port number 1..65535`,
            step.step_id,
          );
        } else {
          // Must have at least one active background process preceding the wait
          if (activeProcesses.size === 0) {
            collector.add(
              "DEPENDENCY_NOT_MET",
              `[ERR_VAL_UNREACHABLE_PORT] wait until: port ${port} requires an active background terminal process launching the service`,
              step.step_id,
            );
          } else {
            confirmedReadyPorts.add(port);
            portReadyAtOrdinal.set(port, globalStepOrdinal);
            // Associate port with all currently active background processes
            for (const [pId, info] of activeProcesses.entries()) {
              processGuestPorts.get(pId)?.add(port);
              stepDependencyMap.get(step.step_id)?.add(info.producerStepId);
            }
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 8: Browser Action Prerequisites & Local Service Graph
  // -------------------------------------------------------------------------
  let hasBrowserOpened = false;
  let browserOpenStepId: string | null = null;
  const allowedOrigins = [
    ...(ir.resources.browser_origins || []),
    ...(config.allowedFixtureOrigins || []),
  ];

  for (const { step, globalStepOrdinal } of allOrderedSteps) {
    if (step.kind !== "operation") continue;
    const op = step.operation;
    const params = op.parameters as Record<string, unknown>;

    if (op.type === "browser_open") {
      const urlStr = params["url"] as string;
      const urlCheck = validateBrowserOrigin(urlStr, allowedOrigins);

      if (!urlCheck.ok) {
        collector.add("PREFLIGHT_VALIDATION_FAILED", `[ORIGIN_NOT_REVIEWED] ${urlCheck.message}`, step.step_id);
      } else {
        const { url } = urlCheck;
        const isLocalHost =
          url.hostname === "localhost" ||
          url.hostname === "127.0.0.1" ||
          url.hostname === "::1" ||
          url.hostname === "[::1]";

        if (isLocalHost) {
          const targetPort = url.port ? parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
          const readyAtOrdinal = portReadyAtOrdinal.get(targetPort);
          if (readyAtOrdinal === undefined || readyAtOrdinal > globalStepOrdinal) {
            collector.add(
              "DEPENDENCY_NOT_MET",
              `[ERR_VAL_UNREACHABLE_PORT] Browser navigation to local service '${url.origin}' requires prior background terminal server and port readiness wait for port ${targetPort}`,
              step.step_id,
            );
          }
        }
      }

      hasBrowserOpened = true;
      browserOpenStepId = step.step_id;
    } else if (
      op.type === "browser_fill" ||
      op.type === "browser_click" ||
      op.type === "browser_press" ||
      op.type === "browser_refresh" ||
      op.type === "browser_wait" ||
      op.type === "browser_assert"
    ) {
      if (!hasBrowserOpened || !browserOpenStepId) {
        collector.add(
          "DEPENDENCY_NOT_MET",
          `[BROWSER_PAGE_NOT_READY] Browser action '${op.type}' requires prior 'browser_open' navigation`,
          step.step_id,
        );
      } else {
        stepDependencyMap.get(step.step_id)?.add(browserOpenStepId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 9: Engine Capabilities Availability
  // -------------------------------------------------------------------------
  if (requiredEngineFamilies.has("editor") && !hostCapabilities.editorAvailable) {
    collector.add(
      "ENGINE_UNAVAILABLE",
      `[ERR_VAL_CAPABILITY_UNAVAILABLE] Editor capability is unavailable on host but required by lesson`,
    );
  }
  if (requiredEngineFamilies.has("terminal") && !hostCapabilities.terminalAvailable) {
    collector.add(
      "ENGINE_UNAVAILABLE",
      `[ERR_VAL_CAPABILITY_UNAVAILABLE] Terminal capability is unavailable on host but required by lesson`,
    );
  }
  if (requiredEngineFamilies.has("browser") && !hostCapabilities.browserAvailable) {
    collector.add(
      "ENGINE_UNAVAILABLE",
      `[ERR_VAL_CAPABILITY_UNAVAILABLE] Browser capability is unavailable on host but required by lesson`,
    );
  }
  if (requiredEngineFamilies.has("narration") && hostCapabilities.narrationAvailable === false) {
    collector.add(
      "ENGINE_UNAVAILABLE",
      `[ERR_VAL_CAPABILITY_UNAVAILABLE] Narration capability is unavailable on host but required by lesson`,
    );
  }
  if (requiredEngineFamilies.has("visual") && hostCapabilities.visualAvailable === false) {
    collector.add(
      "ENGINE_UNAVAILABLE",
      `[ERR_VAL_CAPABILITY_UNAVAILABLE] Visual capability is unavailable on host but required by lesson`,
    );
  }
  if (requiredEngineFamilies.has("wait") && hostCapabilities.waitAvailable === false) {
    collector.add(
      "ENGINE_UNAVAILABLE",
      `[ERR_VAL_CAPABILITY_UNAVAILABLE] Wait capability is unavailable on host but required by lesson`,
    );
  }

  // -------------------------------------------------------------------------
  // Stage 10: Wait Durations, Pause Bounds, and Concurrency
  // -------------------------------------------------------------------------
  for (const { step } of allOrderedSteps) {
    if (step.kind === "pause") {
      if (typeof step.seconds !== "number" || step.seconds <= 0 || step.seconds > MAX_PAUSE_SECONDS) {
        collector.add(
          "PREFLIGHT_VALIDATION_FAILED",
          `[INVALID_DURATION] Pause duration must be 1..${MAX_PAUSE_SECONDS} seconds (got ${step.seconds})`,
          step.step_id,
        );
      }
    } else if (step.kind === "operation") {
      const op = step.operation;
      const params = op.parameters as Record<string, unknown>;

      if (op.type === "wait") {
        const until = params["until"] as string;
        if (until === "duration") {
          const secs = params["seconds"] as number;
          if (typeof secs !== "number" || secs <= 0 || secs > MAX_WAIT_DURATION_SECONDS) {
            collector.add(
              "PREFLIGHT_VALIDATION_FAILED",
              `[INVALID_DURATION] Wait duration must be 1..${MAX_WAIT_DURATION_SECONDS} seconds (got ${secs})`,
              step.step_id,
            );
          }
        } else if (until === "port" || until === "process_output") {
          const timeout = params["timeout_seconds"] as number;
          if (typeof timeout !== "number" || timeout <= 0 || timeout > MAX_WAIT_TIMEOUT_SECONDS) {
            collector.add(
              "PREFLIGHT_VALIDATION_FAILED",
              `[INVALID_DURATION] Wait timeout must be 1..${MAX_WAIT_TIMEOUT_SECONDS} seconds (got ${timeout})`,
              step.step_id,
            );
          }
        }
      } else if (op.type === "browser_wait") {
        const timeout = params["timeout_seconds"] as number;
        if (typeof timeout !== "number" || timeout <= 0 || timeout > MAX_WAIT_TIMEOUT_SECONDS) {
          collector.add(
            "PREFLIGHT_VALIDATION_FAILED",
            `[INVALID_DURATION] Browser wait timeout must be 1..${MAX_WAIT_TIMEOUT_SECONDS} seconds (got ${timeout})`,
            step.step_id,
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Stage 11: Dependency Cycle Verification & Deterministic Plan Generation
  // -------------------------------------------------------------------------
  // Check for dependency cycles using standard 3-color DFS (represented as numbers for erasableSyntaxOnly)
  const DFS_WHITE = 0;
  const DFS_GRAY = 1;
  const DFS_BLACK = 2;
  const colors = new Map<string, number>();
  for (const { step } of allOrderedSteps) {
    colors.set(step.step_id, DFS_WHITE);
  }

  function detectCycle(u: string): boolean {
    colors.set(u, DFS_GRAY);
    const deps = stepDependencyMap.get(u) ?? new Set();
    for (const v of deps) {
      const c = colors.get(v) ?? DFS_WHITE;
      if (c === DFS_GRAY) {
        return true; // back edge found
      }
      if (c === DFS_WHITE && detectCycle(v)) {
        return true;
      }
    }
    colors.set(u, DFS_BLACK);
    return false;
  }

  for (const { step } of allOrderedSteps) {
    if (colors.get(step.step_id) === DFS_WHITE) {
      if (detectCycle(step.step_id)) {
        collector.add(
          "DEPENDENCY_NOT_MET",
          `[DEPENDENCY_CYCLE_DETECTED] Cyclic dependency detected in execution steps`,
          step.step_id,
        );
        break;
      }
    }
  }

  // If any errors collected, return structured failure report
  if (collector.hasErrors()) {
    return {
      ok: false,
      plan: null,
      errors: collector.getErrors(),
    };
  }

  // Build immutable ValidatedRuntimePlan
  const validatedStepPlans: ValidatedStepPlan[] = allOrderedSteps.map(({ step, sceneId, sceneIndex, stepIndex, globalStepOrdinal }) => {
    let actionType: ActionType | undefined;
    let waitCondition: "duration" | "port" | "process_output" | undefined;
    const stepKind: StepKind = step.kind === "operation" ? "action" : step.kind;

    if (step.kind === "operation") {
      actionType = step.operation.type as ActionType;
      if (actionType === "wait") {
        const p = step.operation.parameters as { until?: unknown };
        waitCondition = p.until as "duration" | "port" | "process_output" | undefined;
      }
    }

    const engine = routeStepToEngineFamily(stepKind, actionType, waitCondition);
    const deps = Array.from(stepDependencyMap.get(step.step_id) || []).sort();

    return Object.freeze({
      step_id: step.step_id,
      scene_id: sceneId,
      scene_index: sceneIndex,
      step_index: stepIndex,
      global_step_ordinal: globalStepOrdinal,
      kind: stepKind,
      engine,
      action_type: actionType,
      dependencies: Object.freeze(deps),
    });
  });

  const backgroundProcesses: ValidatedProcessPlan[] = Array.from(allProducers.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([procId, info]) => {
      const stopped = stoppedProcesses.get(procId);
      const ports = Array.from(processGuestPorts.get(procId) || []).sort((a, b) => a - b);
      return Object.freeze({
        process_id: procId,
        producer_step_id: info.stepId,
        stopped_step_id: stopped?.stoppedStepId,
        guest_ports: Object.freeze(ports),
        lifetime: stopped ? ("TERMINATED_IN_LESSON" as const) : ("LIVES_UNTIL_COMPLETION" as const),
      });
    });

  const completionCleanup = Array.from(activeProcesses.keys()).sort();

  // Compute deterministic plan digest
  const basePlan = {
    lesson_id: lessonId,
    course_id: courseId,
    title: ir.lesson.title,
    compiled_ir_digest: ir.source.hash.value,
    total_steps: allOrderedSteps.length,
    capabilities_required: Array.from(requiredEngineFamilies).sort(),
    ordered_steps: validatedStepPlans,
    background_processes: backgroundProcesses,
    completion_cleanup_processes: completionCleanup,
  };

  const planDigest = computeDigest(basePlan);

  const finalPlan: ValidatedRuntimePlan = Object.freeze({
    ...basePlan,
    plan_digest: planDigest,
    capabilities_required: Object.freeze(basePlan.capabilities_required),
    ordered_steps: Object.freeze(validatedStepPlans),
    background_processes: Object.freeze(backgroundProcesses),
    completion_cleanup_processes: Object.freeze(completionCleanup),
  });

  // Verify plan conforms to ValidatedRuntimePlanSchema
  ValidatedRuntimePlanSchema.parse(finalPlan);

  return {
    ok: true,
    plan: finalPlan,
    errors: Object.freeze([]),
  };
}

// ---------------------------------------------------------------------------
// Canonical RuntimeValidator Class
// ---------------------------------------------------------------------------

export class RuntimeValidator {
  private readonly capabilities: HostCapabilityDescriptor;
  private readonly config: RuntimeValidationConfig;

  constructor(
    capabilities: HostCapabilityDescriptor = DEFAULT_HOST_CAPABILITIES,
    config: RuntimeValidationConfig = {},
  ) {
    this.capabilities = HostCapabilityDescriptorSchema.parse(capabilities);
    this.config = config;
  }

  validate(ir: unknown): ValidationReport {
    return validateLesson(ir, this.capabilities, this.config);
  }
}
