// P9.1 Canonical Requested Profile & Encoder Descriptor.
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 10-13 and ADR-0014
// (Deterministic Media Contract). Freezes the requested 1080p30/H.264
// profile and separates it from the actual selected encoder descriptor so
// NVENC->libx264 fallback is always visible in the manifest, never silent.
// Probing/execution is P9.3 scope; this module is types + frozen constants.

import { z } from "zod";
import { PrivacySafeTextSchema } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Canonical Requested Profile (frozen values, P9-DESIGN-SPEC Section 11)
// ---------------------------------------------------------------------------

export const RECORDING_WIDTH = 1920;
export const RECORDING_HEIGHT = 1080;
export const RECORDING_FPS = 30;
export const RECORDING_CODEC = "h264";
export const RECORDING_CONTAINER = "mp4";
export const RECORDING_PIX_FMT = "yuv420p";
export const RECORDING_FASTSTART = true;
export const RECORDING_GOP = 60;
/** Bitrate cap: 12 Mbps. */
export const RECORDING_MAXRATE_BPS = 12_000_000;
/** Decoder buffer: 24 Mbit. */
export const RECORDING_BUFSIZE_BITS = 24_000_000;
/** NVENC primary: preset p4, CQ 23, rc=vbr (proven on pinned rig). */
export const NVENC_PRESET = "p4";
export const NVENC_CQ = 23;
export const NVENC_RC = "vbr";
/** libx264 deterministic software fallback: preset veryfast, CRF 21. */
export const X264_PRESET = "veryfast";
export const X264_CRF = 21;
/** P9 output is silent video: no audio track (P10 owns voice). */
export const RECORDING_AUDIO_PRESENT = false;
/** Reserved P10 audio slot: 48 kHz expectation, anchor sync basis. */
export const P10_EXPECTED_SAMPLE_RATE_HZ = 48_000;
/** Canonical cursor policy: hidden cursor. */
export const CURSOR_CAPTURE_ENABLED = false;
/** Canonical geometry contract (exact match required, no renderer choice). */
export const RecordingGeometrySchema = z.strictObject({
  width: z.literal(RECORDING_WIDTH),
  height: z.literal(RECORDING_HEIGHT),
});
export type RecordingGeometry = z.infer<typeof RecordingGeometrySchema>;

/** Frozen requested recording profile: the ONLY canonical take profile. */
export const RequestedRecordingProfileSchema = z.strictObject({
  profile_id: z.literal("rec-1080p30-h264-v1"),
  width: z.literal(RECORDING_WIDTH),
  height: z.literal(RECORDING_HEIGHT),
  fps: z.literal(RECORDING_FPS),
  codec: z.literal(RECORDING_CODEC),
  container: z.literal(RECORDING_CONTAINER),
  pix_fmt: z.literal(RECORDING_PIX_FMT),
  faststart: z.literal(true),
  gop: z.literal(RECORDING_GOP),
  maxrate_bps: z.literal(RECORDING_MAXRATE_BPS),
  bufsize_bits: z.literal(RECORDING_BUFSIZE_BITS),
  nvenc_preset: z.literal(NVENC_PRESET),
  nvenc_cq: z.literal(NVENC_CQ),
  nvenc_rc: z.literal(NVENC_RC),
  x264_preset: z.literal(X264_PRESET),
  x264_crf: z.literal(X264_CRF),
  audio_present: z.literal(false),
  cursor_capture: z.literal(false),
  sdr: z.literal(true),
});
export type RequestedRecordingProfile = z.infer<
  typeof RequestedRecordingProfileSchema
>;

/** The single canonical requested profile object. */
export const CANONICAL_REQUESTED_PROFILE: RequestedRecordingProfile = {
  profile_id: "rec-1080p30-h264-v1",
  width: 1920,
  height: 1080,
  fps: 30,
  codec: "h264",
  container: "mp4",
  pix_fmt: "yuv420p",
  faststart: true,
  gop: 60,
  maxrate_bps: 12_000_000,
  bufsize_bits: 24_000_000,
  nvenc_preset: "p4",
  nvenc_cq: 23,
  nvenc_rc: "vbr",
  x264_preset: "veryfast",
  x264_crf: 21,
  audio_present: false,
  cursor_capture: false,
  sdr: true,
};

/** Reserved P10 audio seam: metadata only, no audio generation. */
export const ReservedAudioSlotSchema = z.strictObject({
  present: z.literal(false),
  expected_codec: z.literal("aac"),
  sample_rate: z.literal(P10_EXPECTED_SAMPLE_RATE_HZ),
  sync_basis: z.literal("video_time_us anchors"),
});
export type ReservedAudioSlot = z.infer<typeof ReservedAudioSlotSchema>;

export const RESERVED_AUDIO_SLOT: ReservedAudioSlot = {
  present: false,
  expected_codec: "aac",
  sample_rate: 48_000,
  sync_basis: "video_time_us anchors",
};

// ---------------------------------------------------------------------------
// Actual Encoder Descriptor (requested profile vs selected encoder)
// ---------------------------------------------------------------------------

/** Approved encoder profile versions (frozen; extended only by design). */
export const ENCODER_PROFILE_VERSION = "1.0";

export const ENCODER_FAMILIES = ["NVENC", "LIBX264"] as const;
export const EncoderFamilySchema = z.enum(ENCODER_FAMILIES);
export type EncoderFamily = z.infer<typeof EncoderFamilySchema>;

export const ENCODER_PROFILE_NAMES = [
  "nvenc-p4-cq23",
  "libx264-veryfast-crf21",
] as const;
export const EncoderProfileNameSchema = z.enum(ENCODER_PROFILE_NAMES);
export type EncoderProfileName = z.infer<typeof EncoderProfileNameSchema>;

/** Bounded reasons for using the software fallback (never silent). */
export const ENCODER_FALLBACK_REASONS = [
  "NVENC_ENCODER_MISSING",
  "NVENC_SELF_TEST_FAILED",
  "NVENC_CONTEXT_UNAVAILABLE",
] as const;
export const EncoderFallbackReasonSchema = z.enum(ENCODER_FALLBACK_REASONS);
export type EncoderFallbackReason = z.infer<
  typeof EncoderFallbackReasonSchema
>;

/**
 * Actual selected encoder. `fallback_used` makes NVENC->libx264 selection
 * visible in the manifest. No executable path, no argv (structurally absent).
 */
export const EncoderDescriptorSchema = z
  .strictObject({
    family: EncoderFamilySchema,
    profile: EncoderProfileNameSchema,
    profile_version: z.literal(ENCODER_PROFILE_VERSION),
    fallback_used: z.boolean(),
    fallback_reason: EncoderFallbackReasonSchema.optional(),
    encoder_version: PrivacySafeTextSchema,
  })
  .superRefine((enc, ctx) => {
    // Invariant 1: family and profile name must agree.
    if (enc.family === "NVENC" && enc.profile !== "nvenc-p4-cq23") {
      ctx.addIssue({
        code: "custom",
        path: ["profile"],
        message: "NVENC family must use profile 'nvenc-p4-cq23'",
      });
    }
    if (enc.family === "LIBX264" && enc.profile !== "libx264-veryfast-crf21") {
      ctx.addIssue({
        code: "custom",
        path: ["profile"],
        message: "LIBX264 family must use profile 'libx264-veryfast-crf21'",
      });
    }
    // Invariant 2: NVENC selection is never a fallback.
    if (enc.family === "NVENC" && enc.fallback_used) {
      ctx.addIssue({
        code: "custom",
        path: ["fallback_used"],
        message: "NVENC selection must not be marked as fallback",
      });
    }
    if (enc.family === "NVENC" && enc.fallback_reason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fallback_reason"],
        message: "NVENC selection must not carry a fallback reason",
      });
    }
    // Invariant 3: fallback flag and reason must agree (no silent fallback).
    if (enc.fallback_used && enc.fallback_reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fallback_reason"],
        message: "fallback_used=true requires an explicit fallback_reason",
      });
    }
    if (!enc.fallback_used && enc.fallback_reason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["fallback_reason"],
        message: "fallback_reason requires fallback_used=true",
      });
    }
  });

export type EncoderDescriptor = z.infer<typeof EncoderDescriptorSchema>;

// ---------------------------------------------------------------------------
// Backpressure Policy Descriptor (bounded queue, drop-oldest + accounting)
// ---------------------------------------------------------------------------

/**
 * Backpressure contract descriptor. Queue capacity is frozen to the design
 * 8-32 frame window; the per-minute drop-ceiling VALUE is P9.2-owned (field
 * present here so future validation has a stable shape; P9.1 freezes no
 * number for it).
 */
export const BackpressurePolicySchema = z.strictObject({
  queue_capacity_frames: z.number().int().min(8).max(32),
  overflow_policy: z.literal("drop-oldest"),
  max_queue_bytes: z.number().int().min(1).max(268_435_456),
  drop_ceiling_per_minute: z.number().int().min(1),
  drop_ceiling_exceeded: z.boolean(),
});
export type BackpressurePolicy = z.infer<typeof BackpressurePolicySchema>;
