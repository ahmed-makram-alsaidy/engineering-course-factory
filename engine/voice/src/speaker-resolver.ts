// P10.3 Voice Profile & Speaker Resolver
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 17 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 2.
//
// Deterministic resolution of logical authored speaker identifiers to concrete VoiceProfile records.
// Offline, configuration-owned, fail-closed.
// Zero dynamic imports, zero provider calls, zero renderer authority.

import { z } from "zod";
import {
  type SupportedLocale,
  type VoiceIdentifier,
  VoiceIdentifierSchema,
  type VoiceProfile,
  VoiceProfileSchema,
} from "./protocol.ts";
import { VoicePlannerError } from "./text-normalizer.ts";

// ---------------------------------------------------------------------------
// Schemas for Speaker Mapping & Profile Configuration
// ---------------------------------------------------------------------------

export const SpeakerMappingSchema = z.strictObject({
  speaker: VoiceIdentifierSchema,
  profile_id: VoiceIdentifierSchema,
});
export type SpeakerMapping = z.infer<typeof SpeakerMappingSchema>;

export const VoiceProfileConfigSchema = z.strictObject({
  profiles: z.array(VoiceProfileSchema).min(1),
  speaker_mappings: z.array(SpeakerMappingSchema).default([]),
  default_profile_id: VoiceIdentifierSchema.optional(),
  default_profiles: z
    .strictObject({
      ar: VoiceIdentifierSchema.optional(),
      en: VoiceIdentifierSchema.optional(),
    })
    .optional(),
});
export type VoiceProfileConfig = z.infer<typeof VoiceProfileConfigSchema>;
export type VoiceProfileConfigInput = z.input<typeof VoiceProfileConfigSchema>;

// ---------------------------------------------------------------------------
// Configuration Validator (Fail-Closed)
// ---------------------------------------------------------------------------

/**
 * Validates a VoiceProfileConfig ensuring:
 * - No duplicate profile_ids
 * - No duplicate speakers in speaker_mappings
 * - Every mapped profile_id exists in profiles
 * - default_profile_id, if provided, exists in profiles
 */
export function validateVoiceProfileConfig(rawConfig: unknown): VoiceProfileConfig {
  const parseResult = VoiceProfileConfigSchema.safeParse(rawConfig);
  if (!parseResult.success) {
    throw new VoicePlannerError({
      code: "CONFIG_INVALID",
      message: `Invalid voice profile configuration: ${parseResult.error.message}`,
    });
  }

  const config = parseResult.data;

  // 1. Check duplicate profile IDs
  const profileIds = new Set<string>();
  for (const p of config.profiles) {
    if (profileIds.has(p.profile_id)) {
      throw new VoicePlannerError({
        code: "CONFIG_INVALID",
        message: `Duplicate profile_id detected in configuration: '${p.profile_id}'`,
      });
    }
    profileIds.add(p.profile_id);
  }

  // 2. Check duplicate speaker mappings and valid targets
  const speakers = new Set<string>();
  for (const m of config.speaker_mappings) {
    if (speakers.has(m.speaker)) {
      throw new VoicePlannerError({
        code: "CONFIG_INVALID",
        message: `Duplicate speaker mapping detected in configuration: '${m.speaker}'`,
      });
    }
    speakers.add(m.speaker);

    if (!profileIds.has(m.profile_id)) {
      throw new VoicePlannerError({
        code: "CONFIG_INVALID",
        message: `Speaker '${m.speaker}' maps to non-existent profile_id '${m.profile_id}'`,
      });
    }
  }

  // 3. Check default profiles exist if specified
  if (config.default_profile_id !== undefined && !profileIds.has(config.default_profile_id)) {
    throw new VoicePlannerError({
      code: "CONFIG_INVALID",
      message: `Default profile_id '${config.default_profile_id}' does not exist in profiles`,
    });
  }

  if (config.default_profiles?.ar !== undefined && !profileIds.has(config.default_profiles.ar)) {
    throw new VoicePlannerError({
      code: "CONFIG_INVALID",
      message: `Default Arabic profile_id '${config.default_profiles.ar}' does not exist in profiles`,
    });
  }

  if (config.default_profiles?.en !== undefined && !profileIds.has(config.default_profiles.en)) {
    throw new VoicePlannerError({
      code: "CONFIG_INVALID",
      message: `Default English profile_id '${config.default_profiles.en}' does not exist in profiles`,
    });
  }

  return config;
}

// ---------------------------------------------------------------------------
// Speaker Resolution Logic
// ---------------------------------------------------------------------------

/**
 * Resolves a logical speaker persona and lesson language to an authorized VoiceProfile.
 *
 * Rules:
 * - Explicit speaker must match a mapping; unknown speaker fails closed (UNSUPPORTED_VOICE).
 * - Omitted speaker uses language-specific default_profiles[lessonLanguage] or default_profile_id;
 *   missing default fails closed (CONFIG_INVALID).
 * - Target profile locale must be compatible with the lesson language:
 *   - 'ar' -> requires 'ar-EG' or 'ar-SA' (ar-* family)
 *   - 'en' -> requires 'en-US' or 'en-GB' (en-* family)
 *   - Cross-language mismatch fails closed (UNSUPPORTED_LOCALE).
 */
export function resolveSpeaker(
  speaker: string | undefined,
  lessonLanguage: "ar" | "en",
  configInput: VoiceProfileConfig,
): VoiceProfile {
  const config = validateVoiceProfileConfig(configInput);

  let targetProfileId: string;

  if (speaker !== undefined) {
    const mapping = config.speaker_mappings.find((m) => m.speaker === speaker);
    if (!mapping) {
      throw new VoicePlannerError({
        code: "UNSUPPORTED_VOICE",
        message: `Unknown logical speaker '${speaker}'. No voice profile mapping configured.`,
      });
    }
    targetProfileId = mapping.profile_id;
  } else {
    const langSpecificDefault = config.default_profiles?.[lessonLanguage];
    if (langSpecificDefault !== undefined) {
      targetProfileId = langSpecificDefault;
    } else if (config.default_profile_id !== undefined) {
      targetProfileId = config.default_profile_id;
    } else {
      throw new VoicePlannerError({
        code: "CONFIG_INVALID",
        message: "Narration step does not specify a speaker and no default_profile_id is configured.",
      });
    }
  }

  const profile = config.profiles.find((p) => p.profile_id === targetProfileId);
  if (!profile) {
    throw new VoicePlannerError({
      code: "CONFIG_INVALID",
      message: `Resolved profile_id '${targetProfileId}' not found in configuration profiles.`,
    });
  }

  // Locale compatibility check
  validateLocaleCompatibility(lessonLanguage, profile.locale);

  return profile;
}

/**
 * Validates that an IR language and a VoiceProfile locale are compatible.
 */
export function validateLocaleCompatibility(
  language: "ar" | "en",
  locale: SupportedLocale,
): void {
  if (language === "ar") {
    if (!locale.startsWith("ar-")) {
      throw new VoicePlannerError({
        code: "UNSUPPORTED_LOCALE",
        message: `Locale mismatch: lesson language is 'ar', but profile locale is '${locale}'. Expected ar-* profile.`,
      });
    }
  } else if (language === "en") {
    if (!locale.startsWith("en-")) {
      throw new VoicePlannerError({
        code: "UNSUPPORTED_LOCALE",
        message: `Locale mismatch: lesson language is 'en', but profile locale is '${locale}'. Expected en-* profile.`,
      });
    }
  }
}
