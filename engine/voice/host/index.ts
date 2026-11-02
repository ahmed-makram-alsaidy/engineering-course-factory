// P10.4 Voice Host Modules Public API
//
// Canonical authority: docs/P10-DESIGN-SPEC.md and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Privileged Main-side host runtime:
// - Trusted storage root resolution & disk preflight
// - Pinned FFmpeg resolution & safe process execution
// - Canonical 11-point voice asset validator
// - 7-stage audio normalization & EBU R128 loudness mastering pipeline
// - Content-addressed immutable cache & atomic publisher
// - Synthesis orchestration service with cache-first and single-flight semantics

export * from "./storage-roots.ts";
export * from "./normalizer-process.ts";
export * from "./asset-validator.ts";
export * from "./audio-normalizer.ts";
export * from "./voice-cache.ts";
export * from "./synthesis-service.ts";
export * from "./timeline-publisher.ts";
export * from "./credential-store.ts";
export * from "./retry-orchestrator.ts";
export * from "./concurrency-limiter.ts";
export * from "./execution-orchestrator.ts";
