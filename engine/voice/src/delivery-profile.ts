// P10.8 Production Delivery Profiles & Voice Configurations
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8, 30 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Immutable, version-controlled, non-secret delivery profiles for natural-language
// steered TTS (Google Gemini TTS).
//
// Guaranteed invariants:
// - Approved intent: authentic Cairo colloquial Egyptian Arabic, relaxed, confident,
//   conversational peer-mentor tone, natural English technical terminology, suitable
//   for long programming lessons.
// - Delivery prompt prefix is version-controlled non-secret configuration.
// - Any future audio-affecting wording alteration creates a new delivery profile / version,
//   which naturally produces a new acoustic cache identity.
// - Secret credentials NEVER participate in delivery profiles or cache identity.

import { z } from "zod";
import { sha256Hex } from "./canonical.ts";
import {
  MAX_DESCRIPTION_LENGTH,
  Sha256HexSchema,
  VoiceIdentifierSchema,
  type VoiceProfile,
  VoiceProfileSchema,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Delivery Profile Schema (Strict, Non-Secret, Content-Affecting)
// ---------------------------------------------------------------------------

export const DeliveryProfileSchema = z.strictObject({
  delivery_profile_id: VoiceIdentifierSchema,
  version: z.string().regex(/^\d+\.\d+$/),
  description: z.string().min(1).max(MAX_DESCRIPTION_LENGTH),
  prompt_prefix: z.string().min(1),
  prompt_digest: Sha256HexSchema,
});
export type DeliveryProfile = z.infer<typeof DeliveryProfileSchema>;

// ---------------------------------------------------------------------------
// Approved Production Delivery Profile: egyptian-technical-instructor-v1
// ---------------------------------------------------------------------------

export const APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_PROFILE_ID =
  "egyptian-technical-instructor-v1" as const;

export const APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_VERSION = "1.0" as const;

/**
 * Exact tested and human-approved prompt semantics from P10.8 audition G4.
 * Authentic Cairo colloquial Egyptian Arabic technical instructor peer-mentor tone.
 */
export const EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_PREFIX =
  "Audio Profile: Young Egyptian male technical instructor speaking in natural Cairo colloquial Egyptian Arabic. " +
  "Very relaxed, confident, conversational peer-mentor tone.\n" +
  "Director's Notes:\n" +
  "- Speak strictly as a young Egyptian male technical instructor beside the learner.\n" +
  "- Emphasize authentic Cairo Egyptian colloquial phrasing and inflection. Avoid any formal Modern Standard Arabic (Fus-ha) intonation unless strictly written in the text.\n" +
  "- Deliver the script with natural rhythm, conversational pauses between thoughts, and seamless integration of English technical keywords.\n" +
  "- Zero theatricality, zero news-broadcaster cadence, zero robotic pauses.\n" +
  "- Do not add long sentence-final silences.\n" +
  "- Keep pacing engaging and natural for a programming screencast.\n" +
  "- Deliver the transcript text exactly without altering words.\n\n" +
  "Transcript:\n";

export const EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_DIGEST = sha256Hex(
  EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_PREFIX,
);

export const EGYPTIAN_TECHNICAL_INSTRUCTOR_DELIVERY_PROFILE: DeliveryProfile =
  DeliveryProfileSchema.parse({
    delivery_profile_id: APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_PROFILE_ID,
    version: APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_VERSION,
    description:
      "Authentic Egyptian technical instructor delivery profile (Cairo colloquial, relaxed, peer-mentor tone)",
    prompt_prefix: EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_PREFIX,
    prompt_digest: EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_DIGEST,
  });

// ---------------------------------------------------------------------------
// Delivery Profile Registry (Fail-Closed, Main/Server-Side Only)
// ---------------------------------------------------------------------------

const DELIVERY_PROFILES = new Map<string, DeliveryProfile>([
  [APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_PROFILE_ID, EGYPTIAN_TECHNICAL_INSTRUCTOR_DELIVERY_PROFILE],
]);

/**
 * Resolves an approved DeliveryProfile by identifier.
 * Fails closed if the delivery profile is unknown.
 */
export function resolveDeliveryProfile(deliveryProfileId: string): DeliveryProfile {
  const profile = DELIVERY_PROFILES.get(deliveryProfileId);
  if (!profile) {
    throw new Error(
      `[DELIVERY_PROFILE_UNKNOWN] Delivery profile '${deliveryProfileId}' is not registered.`,
    );
  }
  return profile;
}

/**
 * Registers an approved DeliveryProfile in the registry.
 */
export function registerDeliveryProfile(profile: DeliveryProfile): void {
  const validated = DeliveryProfileSchema.parse(profile);
  DELIVERY_PROFILES.set(validated.delivery_profile_id, validated);
}

/**
 * Returns list of currently registered delivery profile IDs.
 */
export function getRegisteredDeliveryProfileIds(): readonly string[] {
  return Object.freeze(Array.from(DELIVERY_PROFILES.keys()));
}

/**
 * Builds the complete prompt text for natural-language steered TTS by combining
 * the immutable delivery profile prefix with the transcript text.
 */
export function buildDeliveryPromptText(deliveryProfileId: string, transcript: string): string {
  const profile = resolveDeliveryProfile(deliveryProfileId);
  return `${profile.prompt_prefix}${transcript}`;
}

// ---------------------------------------------------------------------------
// Approved Production Voice Profiles
// ---------------------------------------------------------------------------

/**
 * Primary Production Instructor Voice Profile:
 * Charon (male, steady, informative) + gemini-3.1-flash-tts-preview + egyptian-technical-instructor-v1
 */
export const GEMINI_PRIMARY_INSTRUCTOR_PROFILE: VoiceProfile = VoiceProfileSchema.parse({
  profile_id: "gemini-ar-eg-charon-instructor",
  locale: "ar-EG",
  gender: "male",
  description: "Primary Egyptian technical instructor (Gemini Charon with approved Egyptian direction)",
  provider_family: "gemini",
  provider_voice_id: "Charon",
  provider_model: "gemini-3.1-flash-tts-preview",
  rate: 1.0,
  pitch: 0.0,
  normalization_policy: "standard-v1",
  delivery_profile_id: APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_PROFILE_ID,
  delivery_prompt_version: APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_VERSION,
  delivery_prompt_digest: EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_DIGEST,
});

/**
 * Secondary Selectable Instructor Voice Profile:
 * Puck (male, lively, conversational) + gemini-3.1-flash-tts-preview + egyptian-technical-instructor-v1
 * Distinct profile identity, stable instructor persona per course.
 */
export const GEMINI_SECONDARY_INSTRUCTOR_PROFILE: VoiceProfile = VoiceProfileSchema.parse({
  profile_id: "gemini-ar-eg-puck-instructor",
  locale: "ar-EG",
  gender: "male",
  description: "Secondary Egyptian technical instructor (Gemini Puck with approved Egyptian direction)",
  provider_family: "gemini",
  provider_voice_id: "Puck",
  provider_model: "gemini-3.1-flash-tts-preview",
  rate: 1.0,
  pitch: 0.0,
  normalization_policy: "standard-v1",
  delivery_profile_id: APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_PROFILE_ID,
  delivery_prompt_version: APPROVED_EGYPTIAN_INSTRUCTOR_DELIVERY_VERSION,
  delivery_prompt_digest: EGYPTIAN_TECHNICAL_INSTRUCTOR_V1_PROMPT_DIGEST,
});

/**
 * Retained Fallback Voice Profile:
 * Azure Speech Shakir (technical fallback retained; human primary selection not approved).
 */
export const AZURE_FALLBACK_INSTRUCTOR_PROFILE: VoiceProfile = VoiceProfileSchema.parse({
  profile_id: "azure-ar-eg-shakir-instructor",
  locale: "ar-EG",
  gender: "male",
  description: "Azure Egyptian technical instructor (technical fallback / compatibility provider)",
  provider_family: "azure",
  provider_voice_id: "ar-EG-ShakirNeural",
  provider_model: "neural",
  rate: 1.0,
  pitch: 0.0,
  normalization_policy: "standard-v1",
});
