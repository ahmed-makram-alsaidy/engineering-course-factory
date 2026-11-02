// P8.5 Background Process Lifecycle Ledger
//
// Canonical authority: docs/P8-DESIGN-SPEC.md Section 22 & ADR-0013.
// In-memory logical orchestration metadata tracking background process lifecycles.
// Does NOT replace P5 process supervisor or Docker runtime.
// Pure metadata, identifier-only, fail-closed dependency gates.

import {
  type ProcessId,
  type ProcessLifecycleEntryDto,
  type ProcessLifecycleState,
  ProcessIdSchema,
  ProcessLifecycleEntryDtoSchema,
} from "./protocol.ts";
import { RuntimeError } from "./errors.ts";
import type { ValidatedProcessPlan } from "./validator.ts";

export interface ProcessRecord {
  readonly process_id: string;
  readonly producer_step_id: string;
  readonly stopped_step_id?: string;
  readonly guest_ports: readonly number[];
  readonly lifetime: "TERMINATED_IN_LESSON" | "LIVES_UNTIL_COMPLETION";
  generation: number;
  state: ProcessLifecycleState;
  exitedEarly: boolean;
}

export class ProcessLifecycleLedger {
  private readonly records: Map<string, ProcessRecord> = new Map();
  private readonly stepToProcessId: Map<string, string> = new Map();

  constructor(plans?: readonly ValidatedProcessPlan[], generation = 1) {
    if (plans) {
      for (const p of plans) {
        ProcessIdSchema.parse(p.process_id);
        const record: ProcessRecord = {
          process_id: p.process_id,
          producer_step_id: p.producer_step_id,
          stopped_step_id: p.stopped_step_id,
          guest_ports: Object.freeze([...p.guest_ports]),
          lifetime: p.lifetime,
          generation,
          state: "REGISTERED",
          exitedEarly: false,
        };
        this.records.set(p.process_id, record);
        this.stepToProcessId.set(p.producer_step_id, p.process_id);
      }
    }
  }

  hasProcess(processId: string): boolean {
    return this.records.has(processId);
  }

  getProcess(processId: string): Readonly<ProcessRecord> | undefined {
    const rec = this.records.get(processId);
    return rec ? Object.freeze({ ...rec }) : undefined;
  }

  getProcessByProducerStep(stepId: string): Readonly<ProcessRecord> | undefined {
    const processId = this.stepToProcessId.get(stepId);
    if (!processId) return undefined;
    return this.getProcess(processId);
  }

  /**
   * Marks a background process as active (RUNNING) upon confirmed completion of terminal_run.
   */
  markActive(processId: string, startedStepId: string, generation: number): void {
    const record = this.records.get(processId);
    if (!record) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Cannot activate un-registered background process '${processId}'`,
        stepId: startedStepId,
      });
    }

    record.state = "RUNNING";
    record.generation = generation;
    record.exitedEarly = false;
  }

  /**
   * Marks a background process as in the process of stopping upon dispatch of terminal_stop.
   */
  markStopping(processId: string, stepId: string): void {
    const record = this.records.get(processId);
    if (!record) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Cannot stop un-registered background process '${processId}'`,
        stepId,
      });
    }

    record.state = "STOPPING";
  }

  /**
   * Marks a background process as cleanly retired upon confirmed completion of terminal_stop
   * or lesson completion cleanup.
   */
  markRetired(processId: string, stoppedStepId?: string): void {
    const record = this.records.get(processId);
    if (!record) {
      throw new RuntimeError({
        code: "INVALID_REQUEST",
        message: `Cannot retire un-registered background process '${processId}'`,
        stepId: stoppedStepId,
      });
    }

    record.state = "RETIRED";
  }

  /**
   * Records that a process exited prematurely / unexpectedly.
   * Subsequent steps depending on this process will fail the dependency gate.
   */
  markExitedEarly(processId: string): void {
    const record = this.records.get(processId);
    if (record) {
      record.state = "STOPPED";
      record.exitedEarly = true;
    }
  }

  /**
   * Returns true if the process is actively running or spawned.
   */
  isLive(processId: string): boolean {
    const record = this.records.get(processId);
    if (!record) return false;
    return (record.state === "RUNNING" || record.state === "SPAWNED") && !record.exitedEarly;
  }

  /**
   * Returns list of currently active process identifiers.
   */
  getActiveProcessIds(): readonly string[] {
    const active: string[] = [];
    for (const [id, rec] of this.records) {
      if ((rec.state === "RUNNING" || rec.state === "SPAWNED") && !rec.exitedEarly) {
        active.push(id);
      }
    }
    return Object.freeze(active);
  }

  /**
   * Pre-dispatch dependency gate:
   * Verifies that any background process created by a prerequisite step in dependencies
   * is still live and healthy.
   * Fails closed with DEPENDENCY_NOT_MET if a required process is absent or exited early.
   */
  verifyDependencies(stepId: string, dependencies: readonly string[]): void {
    for (const depStepId of dependencies) {
      const processId = this.stepToProcessId.get(depStepId);
      if (processId) {
        const record = this.records.get(processId);
        if (!record || record.state !== "RUNNING" || record.exitedEarly) {
          throw new RuntimeError({
            code: "DEPENDENCY_NOT_MET",
            message: `Required background process '${processId}' (spawned in '${depStepId}') is not active (state: ${record?.state ?? "ABSENT"}, exitedEarly: ${record?.exitedEarly ?? false})`,
            stepId,
          });
        }
      }
    }
  }

  /**
   * Returns process IDs that still require completion cleanup.
   */
  getProcessesRequiringCompletionCleanup(): readonly string[] {
    const unretired: string[] = [];
    for (const [id, rec] of this.records) {
      if (rec.lifetime === "LIVES_UNTIL_COMPLETION" && rec.state !== "RETIRED") {
        unretired.push(id);
      }
    }
    return Object.freeze(unretired);
  }

  /**
   * Resets the ledger for a new generation epoch.
   * Clears old records and reinitializes with validated plans.
   */
  reset(plans?: readonly ValidatedProcessPlan[], generation = 1): void {
    this.records.clear();
    this.stepToProcessId.clear();
    if (plans) {
      for (const p of plans) {
        ProcessIdSchema.parse(p.process_id);
        const record: ProcessRecord = {
          process_id: p.process_id,
          producer_step_id: p.producer_step_id,
          stopped_step_id: p.stopped_step_id,
          guest_ports: Object.freeze([...p.guest_ports]),
          lifetime: p.lifetime,
          generation,
          state: "REGISTERED",
          exitedEarly: false,
        };
        this.records.set(p.process_id, record);
        this.stepToProcessId.set(p.producer_step_id, p.process_id);
      }
    }
  }

  /**
   * Retires all live background processes during session cancel/reset/close.
   */
  retireAll(): void {
    for (const record of this.records.values()) {
      if (record.state === "RUNNING" || record.state === "SPAWNED" || record.state === "STOPPING") {
        record.state = "RETIRED";
      }
    }
  }

  /**
   * Returns snapshot DTOs of all tracked processes.
   */
  getAllEntries(): readonly ProcessLifecycleEntryDto[] {
    const entries: ProcessLifecycleEntryDto[] = [];
    for (const [id, rec] of this.records) {
      const dto: ProcessLifecycleEntryDto = {
        process_id: id,
        started_step_id: rec.producer_step_id,
        stopped_step_id: rec.stopped_step_id,
        state: rec.state,
      };
      ProcessLifecycleEntryDtoSchema.parse(dto);
      entries.push(Object.freeze(dto));
    }
    return Object.freeze(entries);
  }
}
