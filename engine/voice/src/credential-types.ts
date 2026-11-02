// P10.6 Trusted Credential Authority Types
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 9, 28 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 4, 11.
//
// Boundary Rules:
// - Main/backend process only.
// - Zero renderer access or IPC exposure.
// - Zero secrets inside VoiceProfile, NarrationPlan, VoiceManifest, VoiceTimeline, or CacheKey.
// - Exact single-key queries only (no listAllSecrets() or dumpConfig()).

export interface VoiceSecretQuery {
  /** Target provider family (e.g. 'fake', 'openai', 'elevenlabs', 'azure'). */
  readonly provider_family: string;
  /** Secret key name (e.g. 'api_key', 'subscription_key', 'client_secret'). */
  readonly secret_key: string;
}

export interface VoiceSecretResolver {
  /**
   * Resolves a secret for a specific provider family and key.
   * Returns null if the secret is not configured.
   */
  resolveSecret(query: VoiceSecretQuery): Promise<string | null> | string | null;

  /**
   * Checks whether a secret is configured without returning its value.
   */
  hasSecret(query: VoiceSecretQuery): Promise<boolean> | boolean;
}
