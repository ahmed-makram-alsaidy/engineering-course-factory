// P9.3 encoder policy surface (re-exported by the package index).
//
// Canonical authority: docs/P9-DESIGN-SPEC.md task P9.3. Pure Main-side
// policy: process contract, fixed argv, frame ingest validation, media
// verification, deterministic fake, synthetic fixtures, byte sources.
// Zero processes, zero filesystem, zero wall clock in this directory.

export * from "./encoder-interface.ts";
export * from "./encoder-argv.ts";
export * from "./encoder-frames.ts";
export * from "./media-validation.ts";
export * from "./fake-encoder.ts";
export * from "./frame-fixture.ts";
export * from "./frame-bytes.ts";
