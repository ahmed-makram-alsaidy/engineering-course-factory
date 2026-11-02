// P9.2 capture backend surface (re-exported by the package index).
//
// Canonical authority: docs/P9-DESIGN-SPEC.md task P9.2. Internal
// Main-side seam: frame format, capability probe, trusted source registry,
// fixed driver boundary, take-bound session, deterministic fake, and the
// Main-side native loader. Public P9.1 protocol/manifest schemas unchanged.

export * from "./capture-format.ts";
export * from "./capture-capability.ts";
export * from "./trusted-source.ts";
export * from "./capture-driver.ts";
export * from "./wgc-session.ts";
export * from "./fake-driver.ts";
export * from "./native-loader.ts";
