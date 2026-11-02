// P7.1 Trusted Browser Admission — admission_version = 1.
//
// Canonical authority: docs/P7-DESIGN-SPEC.md and docs/adr/ADR-0012-browser-automation-boundary.md.
//
// The trusted bridge between identifier-only renderer requests and future browser execution.
// THE CENTRAL TRUST BOUNDARY:
// - Renderer supplies identifiers ONLY: session_id, operation_id, request_id.
// - All execution semantics (URL, selector, value, key, timeout) are resolved
//   exclusively main-side from validated CompiledLesson IR.
// - Non-browser action types and foreign action families (terminal, editor, wait, file)
//   are rejected immediately with WRONG_ACTION_FAMILY.
// - Session and generation fencing protects against stale calls.
// - Deterministic tombstones prevent duplicate fresh side-effects within a generation.
// - Authed browser operations must execute in strictly monotonic authored order.

import {
  validateCompiledLesson,
  type CompiledLesson,
  type CompiledOperation,
} from "@course-factory/lesson-compiler/ir";
import { serializeCompiledLesson, sha256Hex } from "../../compiler/src/canonical.ts";
import {
  isOriginAllowed,
  verifyReviewedBrowserPolicy,
  type ReviewedBrowserPolicyV1,
} from "./policy.ts";
import {
  BROWSER_ACTION_FAMILY,
  BROWSER_ACTION_TYPES,
  BROWSER_ADMISSION_MAX_IR_BYTES,
  BROWSER_ADMISSION_MAX_OPERATIONS,
  BrowserErrorCodeSchema,
  BrowserOperationReceiptSchema,
  BrowserSelectorSchema,
  browserRejection,
  canonicalizeOrigin,
  isBrowserActionType,
  RunBrowserOperationRequestSchema,
  CancelBrowserOperationRequestSchema,
  validateBrowserUrl,
  type BrowserActionType,
  type BrowserErrorCode,
  type BrowserOperationReceipt,
  type BrowserRejection,
  type BrowserSelector,
  type RunBrowserOperationRequest,
  type CancelBrowserOperationRequest,
} from "./protocol.ts";

export const BROWSER_ADMISSION_VERSION = 1;

// ---------------------------------------------------------------------------
// Parameters & Catalog Entry Types
// ---------------------------------------------------------------------------

export type BrowserActionParameters =
  | { type: "browser_open"; url: string }
  | { type: "browser_click"; selector: BrowserSelector }
  | { type: "browser_fill"; selector: BrowserSelector; value: string }
  | { type: "browser_press"; key: string }
  | { type: "browser_refresh" }
  | { type: "browser_wait"; selector?: BrowserSelector; text?: string; timeout_seconds: number }
  | {
      type: "browser_assert";
      url_contains?: string;
      selector?: BrowserSelector;
      selector_text?: string;
      text_visible?: string;
    };

export interface BrowserOperationCatalogEntry {
  readonly operation_id: string;
  readonly action_type: BrowserActionType;
  readonly family: typeof BROWSER_ACTION_FAMILY;
  readonly scene_id: string;
  readonly scene_ordinal: number;
  readonly beat_id: string;
  readonly step_ordinal: number;
  readonly browser_order: number;
  readonly parameters: BrowserActionParameters;
  readonly target_origin?: string;
}

export interface ReviewedBrowserCatalog {
  readonly lesson_id: string;
  readonly course_id: string;
  readonly compiled_ir_digest: string;
  readonly browser_operations: ReadonlyMap<string, BrowserOperationCatalogEntry>;
  readonly ordered_browser_operations: readonly BrowserOperationCatalogEntry[];
  readonly non_browser_operations: ReadonlyMap<string, string>;
  readonly browser_origins: readonly string[];
}

export interface AdmittedBrowserOperation {
  readonly kind: "browser_admission";
  readonly admission_version: 1;
  readonly session_id: string;
  readonly generation: number;
  readonly request_id: string;
  readonly operation_id: string;
  readonly action_type: BrowserActionType;
  readonly parameters: BrowserActionParameters;
  readonly browser_order: number;
  readonly admitted_at_ms: number;
  readonly target_origin?: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Catalog Creation (Pure, Deterministic, Validated)
// ---------------------------------------------------------------------------

/**
 * Creates an immutable, digest-bound ReviewedBrowserCatalog from compiled lesson IR.
 * Re-validates the IR against the canonical compiler authority, indexes all operations,
 * validates parameter structures, and guarantees unambiguous unique operation IDs.
 */
export function createReviewedBrowserCatalog(compiledLesson: unknown): ReviewedBrowserCatalog {
  const validated = validateCompiledLesson(compiledLesson);
  if (!validated.ok || validated.ir === undefined) {
    throw new Error("[INVALID_REQUEST] Compiled lesson failed canonical validation");
  }
  const lesson: CompiledLesson = validated.ir;
  const serialized = serializeCompiledLesson(lesson);
  if (Buffer.byteLength(serialized, "utf8") > BROWSER_ADMISSION_MAX_IR_BYTES) {
    throw new Error(
      `Compiled lesson exceeds maximum IR byte size of ${BROWSER_ADMISSION_MAX_IR_BYTES} bytes`,
    );
  }

  const compiled_ir_digest = sha256Hex(serialized);
  const browserOpsMap = new Map<string, BrowserOperationCatalogEntry>();
  const orderedOps: BrowserOperationCatalogEntry[] = [];
  const nonBrowserOpsMap = new Map<string, string>();
  const seenOperationIds = new Set<string>();

  let browserOrderCounter = 0;

  for (const scene of lesson.scenes) {
    for (const step of scene.steps) {
      if (step.kind !== "operation") continue;
      const opId = step.step_id;

      if (seenOperationIds.has(opId)) {
        throw new Error(`[DUPLICATE_OPERATION_ID] Duplicate operation ID '${opId}' found in compiled lesson`);
      }
      seenOperationIds.add(opId);

      const op = step.operation;
      if (op.family === BROWSER_ACTION_FAMILY) {
        if (!isBrowserActionType(op.type)) {
          throw new Error(
            `[INVALID_REQUEST] Operation '${opId}' has browser family but unknown action type '${op.type}'`,
          );
        }

        const actionType = op.type as BrowserActionType;
        const rawParams = op.parameters as Record<string, unknown>;

        let targetOrigin: string | undefined;

        switch (actionType) {
          case "browser_open": {
            const urlVal = validateBrowserUrl(String(rawParams.url ?? ""));
            if (!urlVal.ok) {
              throw new Error(`[INVALID_REQUEST] Operation '${opId}' has invalid browser_open url: ${urlVal.message}`);
            }
            targetOrigin = urlVal.canonicalOrigin;
            break;
          }
          case "browser_click":
          case "browser_fill": {
            BrowserSelectorSchema.parse(rawParams.selector);
            break;
          }
          case "browser_press": {
            if (typeof rawParams.key !== "string" || rawParams.key.trim().length === 0) {
              throw new Error(`[INVALID_KEY_NAME] Operation '${opId}' has empty or non-string key`);
            }
            break;
          }
          case "browser_refresh": {
            break;
          }
          case "browser_wait": {
            if (rawParams.selector === undefined && rawParams.text === undefined) {
              throw new Error(`[BROWSER_WAIT_FIELDS_REQUIRED] Operation '${opId}' requires 'selector' or 'text'`);
            }
            if (rawParams.selector !== undefined) {
              BrowserSelectorSchema.parse(rawParams.selector);
            }
            break;
          }
          case "browser_assert": {
            if (
              rawParams.url_contains === undefined &&
              rawParams.selector === undefined &&
              rawParams.selector_text === undefined &&
              rawParams.text_visible === undefined
            ) {
              throw new Error(`[ASSERTION_FIELD_REQUIRED] Operation '${opId}' requires at least one assertion condition`);
            }
            if (rawParams.selector_text !== undefined && rawParams.selector === undefined) {
              throw new Error(`[SELECTOR_TEXT_REQUIRES_SELECTOR] Operation '${opId}' selector_text requires selector`);
            }
            if (rawParams.selector !== undefined) {
              BrowserSelectorSchema.parse(rawParams.selector);
            }
            break;
          }
        }

        const entry: BrowserOperationCatalogEntry = {
          operation_id: opId,
          action_type: actionType,
          family: BROWSER_ACTION_FAMILY,
          scene_id: scene.scene_id,
          scene_ordinal: step.source_ref.scene_ordinal,
          beat_id: step.source_ref.beat_id ?? opId,
          step_ordinal: step.ordinal,
          browser_order: browserOrderCounter++,
          parameters: rawParams as BrowserActionParameters,
          ...(targetOrigin ? { target_origin: targetOrigin } : {}),
        };

        browserOpsMap.set(opId, entry);
        orderedOps.push(entry);
      } else {
        nonBrowserOpsMap.set(opId, op.family);
      }
    }
  }

  if (browserOpsMap.size > BROWSER_ADMISSION_MAX_OPERATIONS) {
    throw new Error(
      `Compiled lesson exceeds maximum allowable browser operations (${BROWSER_ADMISSION_MAX_OPERATIONS})`,
    );
  }

  const catalog: ReviewedBrowserCatalog = {
    lesson_id: lesson.lesson.lesson_id,
    course_id: lesson.lesson.course_id,
    compiled_ir_digest,
    browser_operations: browserOpsMap,
    ordered_browser_operations: orderedOps,
    non_browser_operations: nonBrowserOpsMap,
    browser_origins: lesson.resources.browser_origins.map(canonicalizeOrigin),
  };

  return deepFreeze(catalog);
}

// ---------------------------------------------------------------------------
// Browser Admission Session
// ---------------------------------------------------------------------------

export interface AdmissionSessionOptions {
  session_id: string;
  generation: number;
  catalog: ReviewedBrowserCatalog;
  policy: ReviewedBrowserPolicyV1;
}

export class BrowserAdmissionSession {
  readonly session_id: string;
  readonly generation: number;
  readonly catalog: ReviewedBrowserCatalog;
  readonly policy: ReviewedBrowserPolicyV1;

  private nextExpectedOrder = 0;
  private activeOperations = new Map<string, { operation_id: string; request_id: string }>();
  private tombstones = new Map<string, BrowserOperationReceipt>();
  private completedReceipts = new Map<string, BrowserOperationReceipt>();
  private disposed = false;

  constructor(options: AdmissionSessionOptions) {
    this.session_id = options.session_id;
    this.generation = options.generation;
    this.catalog = options.catalog;
    this.policy = options.policy;

    const verification = verifyReviewedBrowserPolicy(
      this.policy,
      this.catalog.compiled_ir_digest,
      this.catalog.lesson_id,
    );
    if (!verification.ok) {
      throw new Error(
        `[${verification.rejection.code}] Policy verification failed at session admission initialization: ${verification.rejection.message}`,
      );
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.activeOperations.clear();
  }

  /**
   * Admits a browser operation for execution.
   * Performs all canonical admission checks:
   * 1. Session active & generation current.
   * 2. Strict identifier-only request structure (no hostile payload keys).
   * 3. Idempotency & tombstone convergence.
   * 4. Operation exists in reviewed catalog and belongs to browser family.
   * 5. Strict monotonic authored browser order.
   * 6. Main review policy allows the operation and origin.
   */
  admitOperation(
    request: unknown,
  ): { ok: true; value: AdmittedBrowserOperation } | { ok: false; rejection: BrowserRejection } {
    if (this.disposed) {
      return { ok: false, rejection: browserRejection("STALE_SESSION", "Session has been disposed") };
    }

    const parseResult = RunBrowserOperationRequestSchema.safeParse(request);
    if (!parseResult.success) {
      return {
        ok: false,
        rejection: browserRejection(
          "INVALID_REQUEST",
          `Invalid runOperation request format: ${parseResult.error.issues[0]?.message}`,
        ),
      };
    }

    const req = parseResult.data;

    if (req.session_id !== this.session_id) {
      return {
        ok: false,
        rejection: browserRejection(
          "STALE_SESSION",
          `Mismatched session ID (expected: '${this.session_id}', got: '${req.session_id}')`,
          req.request_id,
        ),
      };
    }

    // Idempotency: exact request_id cached receipt
    if (this.completedReceipts.has(req.request_id)) {
      return {
        ok: false,
        rejection: browserRejection(
          "OPERATION_ALREADY_COMPLETED",
          `Request '${req.request_id}' has already completed`,
          req.request_id,
        ),
      };
    }

    // Tombstone check: operation already completed in this generation with a different request_id
    if (this.tombstones.has(req.operation_id)) {
      return {
        ok: false,
        rejection: browserRejection(
          "OPERATION_ALREADY_COMPLETED",
          `Operation '${req.operation_id}' has already terminally executed in generation ${this.generation}`,
          req.request_id,
        ),
      };
    }

    // Concurrency check
    if (this.activeOperations.has(req.operation_id)) {
      return {
        ok: false,
        rejection: browserRejection(
          "OPERATION_ALREADY_RUNNING",
          `Operation '${req.operation_id}' is currently active`,
          req.request_id,
        ),
      };
    }

    // Catalog lookup
    const entry = this.catalog.browser_operations.get(req.operation_id);
    if (!entry) {
      const nonBrowserFamily = this.catalog.non_browser_operations.get(req.operation_id);
      if (nonBrowserFamily) {
        return {
          ok: false,
          rejection: browserRejection(
            "WRONG_ACTION_FAMILY",
            `Operation '${req.operation_id}' belongs to action family '${nonBrowserFamily}', not '${BROWSER_ACTION_FAMILY}'`,
            req.request_id,
          ),
        };
      }
      return {
        ok: false,
        rejection: browserRejection(
          "UNREVIEWED_OPERATION",
          `Operation '${req.operation_id}' is not present in reviewed lesson catalog`,
          req.request_id,
        ),
      };
    }

    // Ordering check: operations must execute in authored browser sequence
    if (entry.browser_order !== this.nextExpectedOrder) {
      return {
        ok: false,
        rejection: browserRejection(
          "OUT_OF_ORDER_OPERATION",
          `Operation '${req.operation_id}' is out of order: expected browser step index ${this.nextExpectedOrder}, got ${entry.browser_order}`,
          req.request_id,
        ),
      };
    }

    // Review policy check
    const reviewedRecord = this.policy.reviewed_operations[req.operation_id];
    if (!reviewedRecord) {
      return {
        ok: false,
        rejection: browserRejection(
          "NOT_AUTHORIZED",
          `Operation '${req.operation_id}' has not been authorized in the reviewed policy`,
          req.request_id,
        ),
      };
    }

    if (entry.action_type === "browser_open") {
      if (!entry.target_origin || !isOriginAllowed(this.policy, entry.target_origin)) {
        return {
          ok: false,
          rejection: browserRejection(
            "ORIGIN_NOT_PERMITTED",
            `Target origin '${entry.target_origin ?? "unknown"}' is not allowed by reviewed browser policy`,
            req.request_id,
          ),
        };
      }
    }

    // Grant admission
    this.activeOperations.set(req.operation_id, {
      operation_id: req.operation_id,
      request_id: req.request_id,
    });

    const admission: AdmittedBrowserOperation = {
      kind: "browser_admission",
      admission_version: 1,
      session_id: this.session_id,
      generation: this.generation,
      request_id: req.request_id,
      operation_id: req.operation_id,
      action_type: entry.action_type,
      parameters: entry.parameters,
      browser_order: entry.browser_order,
      admitted_at_ms: Date.now(),
      ...(entry.target_origin ? { target_origin: entry.target_origin } : {}),
    };

    return { ok: true, value: deepFreeze(admission) };
  }

  /**
   * Settles an active admitted operation, recording its terminal receipt into tombstones
   * and advancing the monotonic browser ordering cursor.
   */
  recordCompletion(
    operation_id: string,
    request_id: string,
    outcome: "completed" | "failed" | "cancelled",
    details?: Record<string, unknown>,
    error_code?: BrowserErrorCode,
  ): BrowserOperationReceipt {
    const active = this.activeOperations.get(operation_id);
    if (!active || active.request_id !== request_id) {
      throw new Error(`Cannot complete operation '${operation_id}': not active with request_id '${request_id}'`);
    }

    this.activeOperations.delete(operation_id);

    const receipt: BrowserOperationReceipt = {
      ok: true,
      session_id: this.session_id,
      generation: this.generation,
      operation_id,
      request_id,
      outcome,
      monotonic_ms: Date.now(),
      ...(error_code ? { error_code } : {}),
      ...(details ? { details } : {}),
    };

    BrowserOperationReceiptSchema.parse(receipt);
    const frozenReceipt = deepFreeze(receipt);

    this.tombstones.set(operation_id, frozenReceipt);
    this.completedReceipts.set(request_id, frozenReceipt);

    if (outcome === "completed") {
      this.nextExpectedOrder++;
    }

    return frozenReceipt;
  }

  /**
   * Identifier-only cancellation of an in-flight browser operation.
   */
  cancelOperation(
    request: unknown,
  ): { ok: true; cancelled: boolean } | { ok: false; rejection: BrowserRejection } {
    if (this.disposed) {
      return { ok: false, rejection: browserRejection("STALE_SESSION", "Session has been disposed") };
    }

    const parseResult = CancelBrowserOperationRequestSchema.safeParse(request);
    if (!parseResult.success) {
      return {
        ok: false,
        rejection: browserRejection(
          "INVALID_REQUEST",
          `Invalid cancelOperation request format: ${parseResult.error.issues[0]?.message}`,
        ),
      };
    }

    const req = parseResult.data;
    if (req.session_id !== this.session_id) {
      return {
        ok: false,
        rejection: browserRejection(
          "STALE_SESSION",
          `Mismatched session ID (expected: '${this.session_id}', got: '${req.session_id}')`,
          req.request_id,
        ),
      };
    }

    const active = this.activeOperations.get(req.operation_id);
    if (!active) {
      // If already cancelled or completed, report cancelled: false
      return { ok: true, cancelled: false };
    }

    this.recordCompletion(req.operation_id, active.request_id, "cancelled");
    return { ok: true, cancelled: true };
  }
}
