// @course-factory/runtime-orchestrator
//
// Canonical authority: docs/P8-DESIGN-SPEC.md and docs/adr/ADR-0013-runtime-orchestration-boundary.md.
// P8 Runtime Validator & Multi-Engine Orchestrator.

export * from "./errors.ts";
export * from "./protocol.ts";
export * from "./validator.ts";
export * from "./clock.ts";
export * from "./state-machine.ts";
export * from "./playhead.ts";
export * from "./adapters/index.ts";
export * from "./journal.ts";
export * from "./process-ledger.ts";
export * from "./runtime.ts";
export * from "./lifecycle-coordination.ts";
