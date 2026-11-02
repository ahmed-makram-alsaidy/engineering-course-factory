// P7.4 & P7.5 Canonical Trusted Browser Action Executor
// Canonical authority: docs/P7-DESIGN-SPEC.md Section 7, Section 18, Section 30.
//
// Invariants enforced:
// - Strictly accepts AdmittedBrowserOperation from P7.1 admission; never accepts raw renderer payloads.
// - Zero semantic parameters accepted from renderer (no click(selector) or fill(value) APIs).
// - Preserves strictly monotonic authored browser order.
// - Protects against double execution: tombstones and idempotency prevent duplicate side effects.
// - Fencing: rejects stale session, stale generation, crashed session, closed page.
// - Dispatches exact owned actions: browser_click, browser_fill, browser_press, browser_open, browser_refresh, browser_wait, browser_assert.
// - Journaling: emits browser.operation.started and exactly ONE terminal event (completed, failed, cancelled).
// - Error sanitization: zero stack traces, zero host paths, max 512 chars.
// - Returns canonical BrowserOperationReceipt.

import type { ManagedPageHandle } from "../context.ts";
import type { BrowserAdmissionSession, AdmittedBrowserOperation } from "../admission.ts";
import {
  type BrowserErrorCode,
  type BrowserOperationOutcome,
  type BrowserOperationReceipt,
  type BrowserRejection,
  browserRejection,
  BrowserOperationReceiptSchema,
} from "../protocol.ts";
import type { BrowserSessionJournal } from "../runtime.ts";
import type { BrowserSession } from "../session.ts";
import type { LocalhostBridgeCoordinator } from "../bridge.ts";
import type { ReviewedBrowserPolicyV1 } from "../policy.ts";
import { executeClick, type ActionExecutionResult, type ExecuteActionOptions } from "./click.ts";
import { executeFill } from "./fill.ts";
import { executePress } from "./press.ts";
import { executeOpen } from "./open.ts";
import { executeRefresh } from "./refresh.ts";
import { executeWait } from "./wait.ts";
import { executeAssert } from "./assert.ts";

export interface BrowserActionExecutorOptions {
  readonly journal?: BrowserSessionJournal;
  readonly admissionSession?: BrowserAdmissionSession;
  readonly policy?: ReviewedBrowserPolicyV1;
  readonly bridgeCoordinator?: LocalhostBridgeCoordinator;
  readonly allowedOrigins?: Iterable<string>;
}

export interface ExecutorRunOptions extends ExecuteActionOptions {
  readonly journal?: BrowserSessionJournal;
  readonly admissionSession?: BrowserAdmissionSession;
  readonly policy?: ReviewedBrowserPolicyV1;
  readonly bridgeCoordinator?: LocalhostBridgeCoordinator;
  readonly allowedOrigins?: Iterable<string>;
}

export class BrowserActionExecutor {
  private defaultJournal?: BrowserSessionJournal;
  private defaultAdmissionSession?: BrowserAdmissionSession;
  private defaultPolicy?: ReviewedBrowserPolicyV1;
  private defaultBridgeCoordinator?: LocalhostBridgeCoordinator;
  private defaultAllowedOrigins?: Iterable<string>;
  private activeCancellations = new Map<string, AbortController>();

  constructor(options?: BrowserActionExecutorOptions) {
    this.defaultJournal = options?.journal;
    this.defaultAdmissionSession = options?.admissionSession;
    this.defaultPolicy = options?.policy;
    this.defaultBridgeCoordinator = options?.bridgeCoordinator;
    this.defaultAllowedOrigins = options?.allowedOrigins;
  }

  /**
   * Cancels an in-flight operation by operation_id.
   */
  cancelOperation(operation_id: string): boolean {
    const controller = this.activeCancellations.get(operation_id);
    if (controller) {
      controller.abort();
      this.activeCancellations.delete(operation_id);
      return true;
    }
    return false;
  }

  /**
   * Executes an admitted browser action against the managed session and page.
   * Emits journal events and records terminal completion in admission session.
   */
  async execute(
    session: BrowserSession,
    pageHandle: ManagedPageHandle,
    admitted: AdmittedBrowserOperation,
    options?: ExecutorRunOptions,
  ): Promise<BrowserOperationReceipt> {
    const journal = options?.journal ?? this.defaultJournal;
    const admissionSession = options?.admissionSession ?? this.defaultAdmissionSession;
    const startMs = Date.now();

    // 1. Invariant: verify admission receipt
    if (!admitted || admitted.kind !== "browser_admission" || admitted.admission_version !== 1) {
      throw new Error("[POLICY_DENIED] Cannot execute unadmitted browser operation");
    }

    // 2. Cancellation setup
    const abortController = new AbortController();
    this.activeCancellations.set(admitted.operation_id, abortController);

    // If a caller signal was provided, forward its abort
    if (options?.signal) {
      options.signal.addEventListener("abort", () => {
        abortController.abort();
      });
    }

    const mergedOptions: ExecuteActionOptions = {
      timeoutMs: options?.timeoutMs,
      signal: abortController.signal,
      beforeActionDispatch: options?.beforeActionDispatch,
    };

    // 3. Emit browser.operation.started event
    journal?.recordEvent({
      type: "browser.operation.started",
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: admitted.operation_id,
      operation_type: admitted.action_type,
      request_id: admitted.request_id,
    });

    let executionResult: ActionExecutionResult;
    let terminalOutcome: BrowserOperationOutcome;
    let terminalErrorCode: BrowserErrorCode | undefined;
    let terminalMessage: string | undefined;

    try {
      // 4. Dispatch based on canonical action type
      switch (admitted.action_type) {
        case "browser_click": {
          executionResult = await executeClick(
            session,
            pageHandle.rawPage,
            admitted,
            mergedOptions,
          );
          break;
        }

        case "browser_fill": {
          executionResult = await executeFill(
            session,
            pageHandle.rawPage,
            admitted,
            mergedOptions,
          );
          break;
        }

        case "browser_press": {
          executionResult = await executePress(
            session,
            pageHandle.rawPage,
            admitted,
            mergedOptions,
          );
          break;
        }

        case "browser_open": {
          executionResult = await executeOpen(
            session,
            pageHandle.rawPage,
            admitted,
            {
              ...mergedOptions,
              policy: options?.policy ?? this.defaultPolicy ?? admissionSession?.policy,
              bridgeCoordinator: options?.bridgeCoordinator ?? this.defaultBridgeCoordinator,
              journal,
              allowedOrigins: options?.allowedOrigins ?? this.defaultAllowedOrigins,
            },
          );
          break;
        }

        case "browser_refresh": {
          executionResult = await executeRefresh(
            session,
            pageHandle.rawPage,
            admitted,
            {
              ...mergedOptions,
              journal,
            },
          );
          break;
        }

        case "browser_wait": {
          executionResult = await executeWait(
            session,
            pageHandle.rawPage,
            admitted,
            mergedOptions,
          );
          break;
        }

        case "browser_assert": {
          executionResult = await executeAssert(
            session,
            pageHandle.rawPage,
            admitted,
            mergedOptions,
          );
          break;
        }

        default: {
          executionResult = {
            ok: false,
            errorCode: "INVALID_REQUEST",
            message: `Unsupported browser action type: '${admitted.action_type}'`,
          };
          break;
        }
      }

      // 5. Determine terminal outcome
      if (executionResult.ok) {
        terminalOutcome = "completed";
      } else if (executionResult.errorCode === "OPERATION_CANCELLED" || abortController.signal.aborted) {
        terminalOutcome = "cancelled";
        terminalErrorCode = "OPERATION_CANCELLED";
        terminalMessage = executionResult.message;
      } else {
        terminalOutcome = "failed";
        terminalErrorCode = executionResult.errorCode;
        terminalMessage = executionResult.message;
      }
    } catch (unexpectedErr) {
      terminalOutcome = "failed";
      terminalErrorCode = "PAGE_CRASHED";
      terminalMessage = unexpectedErr instanceof Error ? unexpectedErr.message.slice(0, 512) : "Unexpected action failure";
    } finally {
      this.activeCancellations.delete(admitted.operation_id);
    }

    const duration_ms = Date.now() - startMs;

    // 6. Emit terminal journal event
    if (terminalOutcome === "completed") {
      journal?.recordEvent({
        type: "browser.operation.completed",
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: admitted.operation_id,
        operation_type: admitted.action_type,
        request_id: admitted.request_id,
        duration_ms,
      });
    } else if (terminalOutcome === "cancelled") {
      journal?.recordEvent({
        type: "browser.operation.cancelled",
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: admitted.operation_id,
        operation_type: admitted.action_type,
        request_id: admitted.request_id,
      });
    } else {
      journal?.recordEvent({
        type: "browser.operation.failed",
        session_id: session.sessionId,
        generation: session.generation,
        operation_id: admitted.operation_id,
        operation_type: admitted.action_type,
        request_id: admitted.request_id,
        error_code: terminalErrorCode ?? "ELEMENT_NOT_ACTIONABLE",
        message: terminalMessage ?? "Operation failed",
      });
    }

    // 7. Settle receipt and update admission session tombstones
    if (admissionSession) {
      return admissionSession.recordCompletion(
        admitted.operation_id,
        admitted.request_id,
        terminalOutcome,
        { duration_ms, ...(terminalMessage ? { message: terminalMessage } : {}) },
        terminalErrorCode,
      );
    }

    // Fallback receipt if running outside admission session
    const receipt: BrowserOperationReceipt = {
      ok: true,
      session_id: session.sessionId,
      generation: session.generation,
      operation_id: admitted.operation_id,
      request_id: admitted.request_id,
      outcome: terminalOutcome,
      monotonic_ms: Date.now(),
      ...(terminalErrorCode ? { error_code: terminalErrorCode } : {}),
      details: { duration_ms, ...(terminalMessage ? { message: terminalMessage } : {}) },
    };

    return BrowserOperationReceiptSchema.parse(receipt);
  }

  /**
   * High-level entry point: admits an operation from an identifier-only request and executes it.
   */
  async executeWithAdmission(
    admissionSession: BrowserAdmissionSession,
    session: BrowserSession,
    pageHandle: ManagedPageHandle,
    request: unknown,
    options?: ExecutorRunOptions,
  ): Promise<{ ok: true; receipt: BrowserOperationReceipt } | { ok: false; rejection: BrowserRejection }> {
    const admission = admissionSession.admitOperation(request);
    if (!admission.ok) {
      return { ok: false, rejection: admission.rejection };
    }

    const receipt = await this.execute(session, pageHandle, admission.value, {
      ...options,
      admissionSession,
      journal: options?.journal ?? this.defaultJournal,
    });

    return { ok: true, receipt };
  }
}
