// @course-factory/recording
//
// Canonical authority: docs/P9-DESIGN-SPEC.md and docs/adr/ADR-0014-screen-recording-boundary.md.
// P9 Screen Recording Subsystem contract (P9.1) + capture (P9.2) +
// encoder policy (P9.3) + runtime timeline integration (P9.4).
// P9.4 core stays platform-neutral: no capture, no FFmpeg spawn,
// no Electron, no filesystem writes, no P8 imports.
// P9.6 safety policy (pure; the real file owner lives in safety-host/).

export * from "./protocol.ts";
export * from "./manifest.ts";
export * from "./timeline.ts";
export * from "./timeline-clock.ts";
export * from "./timeline-coordinator.ts";
export * from "./timeline-writer.ts";
export * from "./encoder-profile.ts";
export * from "./disk-budget.ts";
export * from "./naming.ts";
export * from "./capture/index.ts";
export * from "./encoder/index.ts";
export * from "./safety/index.ts";
