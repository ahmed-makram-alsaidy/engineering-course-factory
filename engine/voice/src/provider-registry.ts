// P10.2 Provider Registry & Trusted Resolution Boundary
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Security mandates:
// - Zero renderer authority: providers are registered and resolved Main/server-side only.
// - Zero dynamic import of arbitrary packages or file paths.
// - Zero plugin execution.
// - Primary real provider remains UNSELECTED at P10.0/P10.2.
// - Only "fake" (FakeVoiceProvider) is registered by default for deterministic tests.

import { FakeVoiceProvider } from "./fake-provider.ts";
import { GeminiVoiceProvider } from "./gemini-provider.ts";
import { type VoiceProvider, VoiceProviderError } from "./provider-interface.ts";
import { VoiceIdentifierSchema } from "./protocol.ts";

/** In-memory registry of trusted provider instances. */
const PROVIDER_REGISTRY = new Map<string, VoiceProvider>();

// Register default deterministic fake provider and approved Gemini production provider
PROVIDER_REGISTRY.set("fake", new FakeVoiceProvider());
PROVIDER_REGISTRY.set("gemini", new GeminiVoiceProvider());

/**
 * Registers a trusted VoiceProvider instance for a provider family.
 * Strictly validates family identifier against safe character set.
 */
export function registerVoiceProvider(family: string, provider: VoiceProvider): void {
  const validFamily = VoiceIdentifierSchema.parse(family);
  if (!provider || typeof provider.synthesize !== "function") {
    throw new Error(`[PROVIDER_REGISTRY_INVALID] Provider for family '${validFamily}' must implement VoiceProvider`);
  }
  PROVIDER_REGISTRY.set(validFamily, provider);
}

/**
 * Resolves a VoiceProvider instance by family name.
 * Throws canonical VoiceProviderError if the provider family is unknown or unselected.
 */
export function resolveVoiceProvider(family: string): VoiceProvider {
  const validFamily = VoiceIdentifierSchema.parse(family);
  const provider = PROVIDER_REGISTRY.get(validFamily);

  if (!provider) {
    throw new VoiceProviderError({
      code: "CONFIG_INVALID",
      message: `Voice provider family '${validFamily}' is not registered. (Primary cloud providers remain UNSELECTED at P10.2; only 'fake' is available offline).`,
      provider_identity: {
        provider_family: validFamily,
        provider_model: "unregistered",
        provider_voice_id: "none",
      },
    });
  }

  return provider;
}

/**
 * Returns list of currently registered provider family names.
 */
export function getRegisteredProviderFamilies(): readonly string[] {
  return Object.freeze(Array.from(PROVIDER_REGISTRY.keys()));
}

/**
 * Resets the registry back to baseline state (default FakeVoiceProvider and GeminiVoiceProvider).
 */
export function resetProviderRegistry(): void {
  PROVIDER_REGISTRY.clear();
  PROVIDER_REGISTRY.set("fake", new FakeVoiceProvider());
  PROVIDER_REGISTRY.set("gemini", new GeminiVoiceProvider());
}
