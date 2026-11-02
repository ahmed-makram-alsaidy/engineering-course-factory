// P10.3 Narration Planner
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 5, 6, 17, 18 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 2, 3, 8.
//
// Deterministic offline planner:
// Compiled IR 1.0 -> NarrationPlan containing PlannedNarrationUnits.
//
// Strictly decoupled from runtime execution:
// - Zero provider SDK calls
// - Zero network activity
// - Zero audio generation or WAV creation
// - Zero cache filesystem writes
// - Zero volatile session/take ID pollution
// - Canonical pause sample planning (exact 48,000 samples/sec integer math)

import { z } from "zod";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { AUDIO_SAMPLE_RATE_HZ } from "./audio-clock.ts";
import {
  createCacheIdentityPayload,
  deriveCacheKey,
  deriveVoiceUnitId,
} from "./cache-identity.ts";
import {
  type CacheKey,
  CacheKeySchema,
  type CourseId,
  CourseIdSchema,
  DeliveryToneSchema,
  type LessonId,
  LessonIdSchema,
  type NarrationUnit,
  NarrationUnitSchema,
  SceneIdSchema,
  type Sha256Hex,
  Sha256HexSchema,
  type SupportedLocale,
  SupportedLocaleSchema,
  type SynthesisRequest,
  SynthesisRequestSchema,
  TEXT_NORMALIZATION_VERSION,
  type TextNormalizationVersion,
  TextNormalizationVersionSchema,
  VOICE_CONTRACT_VERSION,
  VOICE_CONTRACT_VERSION_1_1,
  type VoiceContractVersion,
  VoiceContractVersionSchema,
  type VoiceIdentifier,
  VoiceIdentifierSchema,
  type VoiceProfile,
  VoiceProfileSchema,
  type VoiceUnitId,
  VoiceUnitIdSchema,
} from "./protocol.ts";
import {
  type NormalizationResult,
  NormalizationResultSchema,
  VoicePlannerError,
  normalizeNarrationText,
} from "./text-normalizer.ts";
import {
  type VoiceProfileConfig,
  resolveSpeaker,
  validateVoiceProfileConfig,
} from "./speaker-resolver.ts";

// ---------------------------------------------------------------------------
// Compiled IR Input Schemas (Structural, Self-Contained)
// ---------------------------------------------------------------------------

export const CompiledNarrationStepInputSchema = z.strictObject({
  kind: z.literal("narration"),
  step_id: VoiceIdentifierSchema,
  ordinal: z.number().int().positive(),
  derived: z.boolean(),
  source_ref: z.strictObject({
    scene_id: SceneIdSchema,
    scene_ordinal: z.number().int().positive(),
    beat_id: z.string().nullable(),
    form: z.enum(["authored_beat", "scene_narration"]),
  }),
  narration: z.strictObject({
    text: z.string().min(1),
    language: z.enum(["ar", "en"]),
    direction: z.enum(["rtl", "ltr"]),
    speaker: z.string().min(1).optional(),
    delivery: DeliveryToneSchema.optional(),
    pause_before: z.number().int().nonnegative().optional(),
    pause_after: z.number().int().nonnegative().optional(),
  }),
});
export type CompiledNarrationStepInput = z.infer<typeof CompiledNarrationStepInputSchema>;

export const CompiledStepAnyInputSchema = z.union([
  CompiledNarrationStepInputSchema,
  z
    .object({
      kind: z.string().refine((k) => k !== "narration"),
      step_id: z.string().min(1),
      ordinal: z.number().int().positive(),
    })
    .passthrough(),
]);

export const CompiledSceneInputSchema = z
  .object({
    scene_id: SceneIdSchema,
    ordinal: z.number().int().positive(),
    steps: z.array(CompiledStepAnyInputSchema).min(1),
  })
  .passthrough();
export type CompiledSceneInput = z.infer<typeof CompiledSceneInputSchema>;

export const CompiledLessonInputSchema = z
  .object({
    compiled_ir_version: z.string().min(1),
    lesson: z
      .object({
        lesson_id: LessonIdSchema,
        course_id: CourseIdSchema,
        language: z.enum(["ar", "en", "mixed"]),
      })
      .passthrough(),
    scenes: z.array(CompiledSceneInputSchema).min(1),
  })
  .passthrough();
export type CompiledLessonInput = z.infer<typeof CompiledLessonInputSchema>;

// ---------------------------------------------------------------------------
// Planned Narration Unit Contract
// ---------------------------------------------------------------------------

export const PlannedNarrationUnitSchema = z.strictObject({
  voice_unit_id: VoiceUnitIdSchema,
  unit: NarrationUnitSchema,
  normalized_text: z.string().min(1),
  locale: SupportedLocaleSchema,
  voice_profile_id: VoiceIdentifierSchema,
  cache_key: CacheKeySchema,
  pause_before_samples: z.number().int().nonnegative(),
  pause_after_samples: z.number().int().nonnegative(),
  normalization: NormalizationResultSchema,
});
export type PlannedNarrationUnit = z.infer<typeof PlannedNarrationUnitSchema>;

// ---------------------------------------------------------------------------
// Lesson Narration Plan Contract
// ---------------------------------------------------------------------------

export const NarrationPlanSchema = z.strictObject({
  lesson_id: LessonIdSchema,
  course_id: CourseIdSchema,
  text_normalization_version: TextNormalizationVersionSchema,
  voice_contract_version: VoiceContractVersionSchema,
  total_units: z.number().int().nonnegative(),
  units: z.array(PlannedNarrationUnitSchema),
  plan_digest: Sha256HexSchema,
});
export type NarrationPlan = z.infer<typeof NarrationPlanSchema>;

// ---------------------------------------------------------------------------
// Plan Digest Calculation (Pure, Deterministic)
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic SHA-256 digest over the canonical facts of a NarrationPlan.
 * Excludes volatile execution metadata.
 */
export function computePlanDigest(
  lessonId: string,
  courseId: string,
  textNormVersion: string,
  voiceContractVersion: string,
  units: readonly PlannedNarrationUnit[],
): Sha256Hex {
  const digestPayload = {
    lesson_id: lessonId,
    course_id: courseId,
    text_normalization_version: textNormVersion,
    voice_contract_version: voiceContractVersion,
    total_units: units.length,
    units: units.map((u) => ({
      voice_unit_id: u.voice_unit_id,
      cache_key: u.cache_key,
      pause_before_samples: u.pause_before_samples,
      pause_after_samples: u.pause_after_samples,
      normalized_text: u.normalized_text,
      locale: u.locale,
      voice_profile_id: u.voice_profile_id,
    })),
  };
  return sha256Hex(canonicalJson(digestPayload));
}

// ---------------------------------------------------------------------------
// Main Planning Function
// ---------------------------------------------------------------------------

/**
 * Creates a deterministic NarrationPlan from a compiled lesson IR and voice profile config.
 *
 * Algorithm:
 * 1. Validates compiled lesson input and voice profile configuration.
 * 2. Traverses scenes and steps in exact authored order.
 * 3. Filters step.kind === "narration", ignoring non-narration steps.
 * 4. Assigns sequential 1-based narration_ordinal.
 * 5. Resolves logical speaker persona to VoiceProfile (fail-closed).
 * 6. Applies deterministic text normalizer (NFC, whitespace, punctuation, glossary, number expansion).
 * 7. Derives stable VoiceUnitId (placement identity).
 * 8. Derives content-addressed CacheKey (acoustic identity).
 * 9. Computes exact sample-domain pause plan (48,000 samples per second, integer math).
 * 10. Computes canonical SHA-256 plan digest.
 */
export function createNarrationPlan(
  rawLesson: unknown,
  rawConfig: unknown,
): NarrationPlan {
  // 1. Validate inputs
  const lessonParsed = CompiledLessonInputSchema.safeParse(rawLesson);
  if (!lessonParsed.success) {
    throw new VoicePlannerError({
      code: "VALIDATION_FAILED",
      message: `Invalid compiled lesson IR: ${lessonParsed.error.message}`,
    });
  }
  const lesson = lessonParsed.data;
  const config = validateVoiceProfileConfig(rawConfig);

  const lessonId = lesson.lesson.lesson_id;
  const courseId = lesson.lesson.course_id;
  const plannedUnits: PlannedNarrationUnit[] = [];

  let narrationOrdinal = 0;
  const seenVoiceUnitIds = new Set<string>();

  // 2. Traversal: scenes in exact authored order
  for (const scene of lesson.scenes) {
    // Steps in exact authored order
    for (const step of scene.steps) {
      // Filter narration steps only
      if (step.kind !== "narration") {
        continue;
      }

      const narrationStep = step as CompiledNarrationStepInput;
      narrationOrdinal++;

      // Logical speaker & locale resolution
      const authoredNarration = narrationStep.narration;
      const profile = resolveSpeaker(
        authoredNarration.speaker,
        authoredNarration.language,
        config,
      );

      // Stable VoiceUnitId (placement identity)
      const voice_unit_id = deriveVoiceUnitId(lessonId, narrationStep.step_id, narrationOrdinal);
      if (seenVoiceUnitIds.has(voice_unit_id)) {
        throw new VoicePlannerError({
          code: "VALIDATION_FAILED",
          message: `Duplicate VoiceUnitId generated during planning: '${voice_unit_id}'`,
        });
      }
      seenVoiceUnitIds.add(voice_unit_id);

      // Deterministic text normalization
      const normalization = normalizeNarrationText(
        authoredNarration.text,
        profile.locale,
      );
      const normalized_text = normalization.normalized_text;

      // Content-addressed CacheKey (acoustic identity)
      const cachePayload = createCacheIdentityPayload(normalized_text, profile);
      const cache_key = deriveCacheKey(cachePayload);

      // Exact sample-domain pause plan (safe integer arithmetic)
      const pauseBeforeSec = authoredNarration.pause_before ?? 0;
      const pauseAfterSec = authoredNarration.pause_after ?? 0;
      const pause_before_samples = pauseBeforeSec * AUDIO_SAMPLE_RATE_HZ;
      const pause_after_samples = pauseAfterSec * AUDIO_SAMPLE_RATE_HZ;

      // Authored NarrationUnit contract (authored_text preserved byte-for-byte)
      const unit = NarrationUnitSchema.parse({
        lesson_id: lessonId,
        scene_id: scene.scene_id,
        step_id: narrationStep.step_id,
        narration_ordinal: narrationOrdinal,
        locale: profile.locale,
        authored_text: authoredNarration.text,
        voice_profile_id: profile.profile_id,
        normalization_version: TEXT_NORMALIZATION_VERSION,
        speaker: authoredNarration.speaker,
        delivery: authoredNarration.delivery,
        pause_before_seconds: authoredNarration.pause_before,
        pause_after_seconds: authoredNarration.pause_after,
      });

      const plannedUnit = PlannedNarrationUnitSchema.parse({
        voice_unit_id,
        unit,
        normalized_text,
        locale: profile.locale,
        voice_profile_id: profile.profile_id,
        cache_key,
        pause_before_samples,
        pause_after_samples,
        normalization,
      });

      plannedUnits.push(plannedUnit);
    }
  }

  // 3. Compute deterministic plan digest
  const hasDeliveryProfile = config.profiles.some((p) => p.delivery_profile_id !== undefined);
  const planContractVersion = hasDeliveryProfile
    ? VOICE_CONTRACT_VERSION_1_1
    : VOICE_CONTRACT_VERSION;

  const plan_digest = computePlanDigest(
    lessonId,
    courseId,
    TEXT_NORMALIZATION_VERSION,
    planContractVersion,
    plannedUnits,
  );

  return NarrationPlanSchema.parse({
    lesson_id: lessonId,
    course_id: courseId,
    text_normalization_version: TEXT_NORMALIZATION_VERSION,
    voice_contract_version: planContractVersion,
    total_units: plannedUnits.length,
    units: plannedUnits,
    plan_digest,
  });
}

// ---------------------------------------------------------------------------
// Synthesis Request Preparation Pure Helper
// ---------------------------------------------------------------------------

/**
 * Pure function converting a PlannedNarrationUnit and VoiceProfile into a SynthesisRequest envelope.
 * Caller provides explicit requestId (execution-owned, not planning-owned).
 */
export function createPlannedSynthesisRequest(
  plannedUnit: PlannedNarrationUnit,
  profile: VoiceProfile,
  requestId: string,
): SynthesisRequest {
  VoiceProfileSchema.parse(profile);
  return SynthesisRequestSchema.parse({
    request_id: requestId,
    cache_key: plannedUnit.cache_key,
    normalized_text: plannedUnit.normalized_text,
    locale: plannedUnit.locale,
    voice_profile: profile,
    request_alignment: true,
  });
}
