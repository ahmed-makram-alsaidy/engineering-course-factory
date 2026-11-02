// P10.1 Content-Addressable Cache Identity & Key Derivation
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 18 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Defines the exact deterministic inputs for the voice asset cache key:
//   cache_key = SHA-256(canonical_json(CacheIdentityPayload))
//
// Strictly excludes:
//   lesson_id, scene_id, step_id, runtime_session_id, generation, take_id,
//   wall-clock timestamps, and local machine paths.
//
// This guarantees that identical spoken phrases with identical voice profile
// and normalization versions share the exact same cache artifact across all
// lessons, takes, and courses.

import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { resolveDeliveryProfile } from "./delivery-profile.ts";
import {
  AUDIO_NORMALIZATION_VERSION,
  AudioNormalizationVersionSchema,
  type CacheKey,
  CacheKeySchema,
  MAX_AUTHORED_TEXT_LENGTH,
  Sha256HexSchema,
  SupportedLocaleSchema,
  TEXT_NORMALIZATION_VERSION,
  TextNormalizationVersionSchema,
  VOICE_CONTRACT_VERSION,
  VOICE_CONTRACT_VERSION_1_1,
  VoiceContractVersionSchema,
  VoiceIdentifierSchema,
  type VoiceProfile,
  type VoiceUnitId,
  VoiceUnitIdSchema,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Cache Identity Payload Schemas (Strict Content-Addressable Envelopes)
// ---------------------------------------------------------------------------

/**
 * Frozen P10.1 CacheIdentityPayload v1 schema.
 * Represents audio identity for standard providers without natural-language steering.
 */
export const CacheIdentityPayloadV1Schema = z.strictObject({
  normalized_text: z.string().min(1).max(MAX_AUTHORED_TEXT_LENGTH),
  locale: SupportedLocaleSchema,
  voice_profile_id: VoiceIdentifierSchema,
  provider_family: VoiceIdentifierSchema,
  provider_model: VoiceIdentifierSchema,
  provider_voice_id: VoiceIdentifierSchema,
  rate: z.number().min(0.5).max(2.0),
  pitch: z.number().min(-12.0).max(12.0),
  style: z.string().nullable(),
  text_normalization_version: TextNormalizationVersionSchema.default(TEXT_NORMALIZATION_VERSION),
  audio_normalization_version: AudioNormalizationVersionSchema.default(AUDIO_NORMALIZATION_VERSION),
  voice_contract_version: VoiceContractVersionSchema.default(VOICE_CONTRACT_VERSION),
});
export type CacheIdentityPayloadV1 = z.infer<typeof CacheIdentityPayloadV1Schema>;

/**
 * Additive P10.8 CacheIdentityPayload v1.1 schema.
 * Binds natural-language delivery profile, prompt version, and prompt template digest
 * directly into the acoustic cache identity for generative models (e.g. Gemini TTS).
 */
export const CacheIdentityPayloadV1_1Schema = z.strictObject({
  normalized_text: z.string().min(1).max(MAX_AUTHORED_TEXT_LENGTH),
  locale: SupportedLocaleSchema,
  voice_profile_id: VoiceIdentifierSchema,
  provider_family: VoiceIdentifierSchema,
  provider_model: VoiceIdentifierSchema,
  provider_voice_id: VoiceIdentifierSchema,
  rate: z.number().min(0.5).max(2.0),
  pitch: z.number().min(-12.0).max(12.0),
  style: z.string().nullable(),
  delivery_profile_id: VoiceIdentifierSchema,
  delivery_prompt_version: z.string().regex(/^\d+\.\d+$/),
  delivery_prompt_digest: Sha256HexSchema,
  text_normalization_version: TextNormalizationVersionSchema.default(TEXT_NORMALIZATION_VERSION),
  audio_normalization_version: AudioNormalizationVersionSchema.default(AUDIO_NORMALIZATION_VERSION),
  voice_contract_version: VoiceContractVersionSchema.default(VOICE_CONTRACT_VERSION_1_1),
});
export type CacheIdentityPayloadV1_1 = z.infer<typeof CacheIdentityPayloadV1_1Schema>;

/**
 * Union schema supporting both frozen v1.0 and additive v1.1 acoustic identities.
 */
export const CacheIdentityPayloadSchema = z.union([
  CacheIdentityPayloadV1_1Schema,
  CacheIdentityPayloadV1Schema,
]);
export type CacheIdentityPayload = z.infer<typeof CacheIdentityPayloadSchema>;

// ---------------------------------------------------------------------------
// Pure Helpers
// ---------------------------------------------------------------------------

/**
 * Builds and validates a CacheIdentityPayload from normalized text and a VoiceProfile.
 * If the profile specifies a delivery_profile_id, builds a v1.1 identity binding
 * the immutable prompt template digest into the cache key; otherwise builds a v1.0 identity.
 */
export function createCacheIdentityPayload(
  normalizedText: string,
  profile: VoiceProfile,
): CacheIdentityPayload {
  if (profile.delivery_profile_id) {
    let promptVersion = profile.delivery_prompt_version;
    let promptDigest = profile.delivery_prompt_digest;

    if (!promptVersion || !promptDigest) {
      const delivery = resolveDeliveryProfile(profile.delivery_profile_id);
      promptVersion = promptVersion ?? delivery.version;
      promptDigest = promptDigest ?? delivery.prompt_digest;
    }

    return CacheIdentityPayloadV1_1Schema.parse({
      normalized_text: normalizedText,
      locale: profile.locale,
      voice_profile_id: profile.profile_id,
      provider_family: profile.provider_family,
      provider_model: profile.provider_model,
      provider_voice_id: profile.provider_voice_id,
      rate: profile.rate,
      pitch: profile.pitch,
      style: profile.style ?? null,
      delivery_profile_id: profile.delivery_profile_id,
      delivery_prompt_version: promptVersion,
      delivery_prompt_digest: promptDigest,
      text_normalization_version: TEXT_NORMALIZATION_VERSION,
      audio_normalization_version: AUDIO_NORMALIZATION_VERSION,
      voice_contract_version: VOICE_CONTRACT_VERSION_1_1,
    });
  }

  return CacheIdentityPayloadV1Schema.parse({
    normalized_text: normalizedText,
    locale: profile.locale,
    voice_profile_id: profile.profile_id,
    provider_family: profile.provider_family,
    provider_model: profile.provider_model,
    provider_voice_id: profile.provider_voice_id,
    rate: profile.rate,
    pitch: profile.pitch,
    style: profile.style ?? null,
    text_normalization_version: TEXT_NORMALIZATION_VERSION,
    audio_normalization_version: AUDIO_NORMALIZATION_VERSION,
    voice_contract_version: VOICE_CONTRACT_VERSION,
  });
}

/**
 * Derives the canonical 64-character lowercase hexadecimal SHA-256 cache key
 * from a validated CacheIdentityPayload.
 */
export function deriveCacheKey(payload: CacheIdentityPayload): CacheKey {
  const validated = CacheIdentityPayloadSchema.parse(payload);
  const json = canonicalJson(validated);
  const hash = sha256Hex(json);
  return CacheKeySchema.parse(hash);
}

/**
 * Derives a deterministic VoiceUnitId identifying authored placement within a lesson.
 * Distinct from CacheKey: VoiceUnitId identifies placement; CacheKey identifies content.
 */
export function deriveVoiceUnitId(
  lessonId: string,
  stepId: string,
  ordinal: number,
): VoiceUnitId {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(
      `[VOICE_UNIT_ID_INVALID] ordinal must be a positive integer, received: ${ordinal}`,
    );
  }
  const formattedOrdinal = String(ordinal).padStart(3, "0");
  const rawId = `vu-${lessonId}-${stepId}-${formattedOrdinal}`;
  return VoiceUnitIdSchema.parse(rawId);
}
