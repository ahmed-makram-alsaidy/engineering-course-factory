// P10 Voice Subsystem Public API
//
// Canonical authority: docs/P10-DESIGN-SPEC.md and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Exports the canonical Voice Protocol v1, VoiceManifest 1.0, audio clock helpers,
// cache identity contracts, failure taxonomy, provider abstraction interface,
// deterministic WAV encoding, FakeVoiceProvider, and provider registry.

export * from "./audio-clock.ts";
export * from "./canonical.ts";
export * from "./protocol.ts";
export * from "./cache-identity.ts";
export * from "./manifest.ts";
export * from "./wav.ts";
export * from "./provider-interface.ts";
export * from "./fake-provider.ts";
export * from "./provider-registry.ts";
export * from "./technical-glossary.ts";
export * from "./text-normalizer.ts";
export * from "./speaker-resolver.ts";
export * from "./narration-planner.ts";
export * from "./timeline.ts";
export * from "./redactor.ts";
export * from "./safe-error.ts";
export * from "./credential-types.ts";
export * from "./azure-provider.ts";
export * from "./elevenlabs-provider.ts";
export * from "./gemini-provider.ts";
export * from "./delivery-profile.ts";
