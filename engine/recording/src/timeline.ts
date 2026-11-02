// P9.1 Recording Timeline Anchors & Sidecar Contract.
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 8-9, 14, 16, 19 and
// ADR-0014 (Shared Monotonic Time). Defines the RecordingTimeline anchor
// schema (exact design field names), ordering invariants, frame-sequence
// rules, drop accounting, one-frame-interval step-boundary contract, and
// the <take>.anchors.jsonl serialization contract (in-memory helpers only;
// P9.3/P9.4 own physical lifecycle). No capture, no clock implementation.

import { z } from "zod";
import {
  GlobalStepOrdinalSchema,
  RecordingGenerationSchema,
  RecordingGlobalSeqSchema,
  RecordingRuntimeSessionIdSchema,
  RecordingSceneIdSchema,
  RecordingSessionIdSchema,
  RecordingStepIdSchema,
  RuntimeMonotonicMsSchema,
  TakeDurationUsSchema,
  TakeIdSchema,
  matchesTakeFence,
  type TakeFence,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Bounds (P9-DESIGN-SPEC Sections 14, 19)
// ---------------------------------------------------------------------------

/** Anchors sidecar ceiling: <= 5 MiB per take. */
export const MAX_SIDECAR_BYTES = 5_242_880;

/** Per-line bound: one anchor line must fit in 4 KiB (actual ~250 B). */
export const MAX_ANCHOR_LINE_BYTES = 4_096;

/** Frame interval at 30 FPS, ceilinged to whole microseconds. */
export const FRAME_INTERVAL_US = 33_334;

/** Canonical frame_seq initial value (P7 visual-sequence precedent: 1). */
export const FRAME_SEQ_INITIAL = 1;

// ---------------------------------------------------------------------------
// Engine Family Mirror (P8 GlobalRuntimeEvent `engine` domain, local copy)
// ---------------------------------------------------------------------------

export const RECORDING_ENGINE_FAMILIES = [
  "orchestrator",
  "editor",
  "terminal",
  "browser",
  "wait",
  "narration",
  "visual",
] as const;

export const RecordingEngineFamilySchema = z.enum(RECORDING_ENGINE_FAMILIES);
export type RecordingEngineFamily = z.infer<typeof RecordingEngineFamilySchema>;

// ---------------------------------------------------------------------------
// Recording Timeline Anchor (exact P9-DESIGN-SPEC Sections 14-15 envelope)
// ---------------------------------------------------------------------------

/**
 * One ordered anchor correlating recording time with the trusted P8 journal.
 * Design-exact correlation core: video_time_us, runtime_monotonic_ms (P8
 * journal ms domain), global_seq, scene_id, step_id, engine, event_type —
 * plus the fencing envelope (recording/take/runtime session + generation)
 * and global_step_ordinal. No semantic payload, no paths, no handles.
 */
export const RecordingTimelineAnchorSchema = z.strictObject({
  recording_session_id: RecordingSessionIdSchema,
  take_id: TakeIdSchema,
  runtime_session_id: RecordingRuntimeSessionIdSchema,
  generation: RecordingGenerationSchema,
  video_time_us: TakeDurationUsSchema,
  runtime_monotonic_ms: RuntimeMonotonicMsSchema,
  global_seq: RecordingGlobalSeqSchema,
  scene_id: RecordingSceneIdSchema,
  step_id: RecordingStepIdSchema,
  global_step_ordinal: GlobalStepOrdinalSchema,
  engine: RecordingEngineFamilySchema,
  event_type: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
});

export type RecordingTimelineAnchor = z.infer<
  typeof RecordingTimelineAnchorSchema
>;

// ---------------------------------------------------------------------------
// Frame Sequence & Drop Accounting (P9-DESIGN-SPEC Sections 9, 11)
// ---------------------------------------------------------------------------

/**
 * Frame sequence rules (frozen): starts at FRAME_SEQ_INITIAL (1), strictly
 * monotonic, no duplicates, no sequence reuse — dropped frames are
 * represented by counters/records, never by reusing a sequence number.
 */
export const FrameSeqSchema = z
  .number()
  .int()
  .min(FRAME_SEQ_INITIAL)
  .max(Number.MAX_SAFE_INTEGER);
export type FrameSeq = z.infer<typeof FrameSeqSchema>;

/**
 * Historical P9.1 FrameCounters 1.0 schema (read-only historical).
 * Frozen comment retained for audit:
 * encoded frames are bounded by captured + coalesced (duplicate markers repeat PTS without a new pixel buffer).
 */
export const FrameCounters10Schema = z
  .strictObject({
    captured_frame_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    encoded_frame_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    dropped_frame_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    coalesced_frame_count: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((c, ctx) => {
    if (c.dropped_frame_count > c.captured_frame_count) {
      ctx.addIssue({
        code: "custom",
        path: ["dropped_frame_count"],
        message: "dropped frames cannot exceed captured frames",
      });
    }
    if (c.coalesced_frame_count > c.captured_frame_count) {
      ctx.addIssue({
        code: "custom",
        path: ["coalesced_frame_count"],
        message: "coalesced frames cannot exceed captured frames",
      });
    }
    if (c.encoded_frame_count > c.captured_frame_count + c.coalesced_frame_count) {
      ctx.addIssue({
        code: "custom",
        path: ["encoded_frame_count"],
        message: "encoded frames cannot exceed captured + coalesced frames",
      });
    }
  });

export type FrameCounters10 = z.infer<typeof FrameCounters10Schema>;

/**
 * FrameCounters 1.1 schema (current contract per P9.1 Corrective Addendum).
 * Adds explicit filler_frame_count. Restores encoded to actual media/output truth.
 * Invariants I1-I6 per docs/P9.1-FRAMECOUNTERS-ADDENDUM.md.
 */
export const FrameCounters11Schema = z
  .strictObject({
    captured_frame_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    encoded_frame_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    dropped_frame_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    coalesced_frame_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    filler_frame_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .superRefine((c, ctx) => {
    // (I1) filler <= encoded
    if (c.filler_frame_count > c.encoded_frame_count) {
      ctx.addIssue({
        code: "custom",
        path: ["filler_frame_count"],
        message: "filler frames cannot exceed encoded frames",
      });
    }
    // (I2) coalesced <= encoded
    if (c.coalesced_frame_count > c.encoded_frame_count) {
      ctx.addIssue({
        code: "custom",
        path: ["coalesced_frame_count"],
        message: "coalesced frames cannot exceed encoded frames",
      });
    }
    // (I3) coalesced + filler <= encoded
    if (c.coalesced_frame_count + c.filler_frame_count > c.encoded_frame_count) {
      ctx.addIssue({
        code: "custom",
        path: ["coalesced_frame_count"],
        message: "coalesced + filler frames cannot exceed encoded frames",
      });
    }
    // (I4) encoded <= captured + filler
    if (c.encoded_frame_count > c.captured_frame_count + c.filler_frame_count) {
      ctx.addIssue({
        code: "custom",
        path: ["encoded_frame_count"],
        message: "encoded frames cannot exceed captured + filler frames",
      });
    }
    // (I5) dropped + encoded >= captured + filler
    if (c.dropped_frame_count + c.encoded_frame_count < c.captured_frame_count + c.filler_frame_count) {
      ctx.addIssue({
        code: "custom",
        path: ["dropped_frame_count"],
        message: "dropped + encoded frames must account for captured + filler frames",
      });
    }
    // (I6) coalesced <= captured
    if (c.coalesced_frame_count > c.captured_frame_count) {
      ctx.addIssue({
        code: "custom",
        path: ["coalesced_frame_count"],
        message: "coalesced frames cannot exceed captured frames",
      });
    }
  });

export type FrameCounters11 = z.infer<typeof FrameCounters11Schema>;

/** Current FrameCounters schema is 1.1. */
export const FrameCountersSchema = FrameCounters11Schema;
export type FrameCounters = FrameCounters11;

// ---------------------------------------------------------------------------
// Step-Boundary Frame-Interval Contract (P9-DESIGN-SPEC Section 14 seam)
// ---------------------------------------------------------------------------

/**
 * Contract helper (not runtime enforcement): at 30 FPS every step boundary
 * must be representable within one video frame interval (33,334 us).
 * P9.4 implements correlation against this contract.
 */
export function isWithinOneFrameInterval(deltaUs: number): boolean {
  return (
    Number.isInteger(deltaUs) && deltaUs >= 0 && deltaUs <= FRAME_INTERVAL_US
  );
}

// ---------------------------------------------------------------------------
// Anchor Batch Ordering Validation (pure; duplicate/stale anchors fail)
// ---------------------------------------------------------------------------

export interface AnchorBatchCheck {
  ok: boolean;
  errors: string[];
  anchor_count: number;
}

/**
 * Validates one ordered anchor batch for a single take:
 * - every record parses as RecordingTimelineAnchor (unknown keys rejected)
 * - video_time_us monotonic non-decreasing (design Section 9 PTS policy)
 * - global_seq strictly increasing
 * - (video_time_us, global_seq) unique: duplicates rejected
 * - generation + all three session ids constant within the take
 * - optional fence: every record must match the expected take fence
 *   (stale-generation records fail here; P9.4 enforces at commit time)
 */
export function checkAnchorBatchOrdering(
  records: unknown[],
  expectedTake?: TakeFence,
): AnchorBatchCheck {
  const errors: string[] = [];
  const parsed: RecordingTimelineAnchor[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const result = RecordingTimelineAnchorSchema.safeParse(records[i]);
    if (!result.success) {
      errors.push(`anchor[${i}]: invalid (${result.error.issues.length} issue(s))`);
      continue;
    }
    parsed.push(result.data);
  }
  if (parsed.length > 0) {
    const first = parsed[0]!;
    for (let i = 1; i < parsed.length; i += 1) {
      const prev = parsed[i - 1]!;
      const cur = parsed[i]!;
      if (cur.video_time_us < prev.video_time_us) {
        errors.push(
          `anchor[${i}]: video_time_us decreased (${prev.video_time_us} -> ${cur.video_time_us})`,
        );
      }
      if (cur.global_seq <= prev.global_seq) {
        errors.push(
          `anchor[${i}]: global_seq not strictly increasing (${prev.global_seq} -> ${cur.global_seq})`,
        );
      }
      if (
        cur.video_time_us === prev.video_time_us &&
        cur.global_seq === prev.global_seq
      ) {
        errors.push(`anchor[${i}]: duplicate anchor (time, seq) pair`);
      }
      for (const field of [
        "recording_session_id",
        "take_id",
        "runtime_session_id",
        "generation",
      ] as const) {
        if (cur[field] !== first[field]) {
          errors.push(
            `anchor[${i}]: ${field} changed within one take (${String(first[field])} -> ${String(cur[field])})`,
          );
        }
      }
    }
    if (expectedTake !== undefined) {
      for (let i = 0; i < parsed.length; i += 1) {
        if (!matchesTakeFence(parsed[i]!, expectedTake)) {
          errors.push(`anchor[${i}]: stale-take fence mismatch`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, anchor_count: parsed.length };
}

// ---------------------------------------------------------------------------
// Anchors Sidecar JSONL Contract (<take>.anchors.jsonl, in-memory helpers)
// ---------------------------------------------------------------------------

/**
 * Canonical JSONL serialization: sorted-keys compact JSON per line + LF.
 * Each line is independently valid; UTF-8; LF line endings; no BOM;
 * no arbitrary extra keys (strictObject); line bound enforced.
 */
export function serializeAnchorLine(anchor: RecordingTimelineAnchor): string {
  const parsed = RecordingTimelineAnchorSchema.parse(anchor);
  const line = JSON.stringify(sortKeysDeep(parsed));
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_ANCHOR_LINE_BYTES) {
    throw new Error(
      `[ANCHOR_LINE_TOO_LARGE] anchor line is ${bytes} bytes (max ${MAX_ANCHOR_LINE_BYTES})`,
    );
  }
  return `${line}\n`;
}

/** Parses one sidecar line: strict schema, no BOM, LF-terminated content. */
export function parseAnchorLine(line: string): RecordingTimelineAnchor {
  if (line.startsWith("\uFEFF")) {
    throw new Error("[ANCHOR_BOM_REJECTED] sidecar lines must not start with BOM");
  }
  if (line.includes("\r")) {
    throw new Error("[ANCHOR_CRLF_REJECTED] sidecar uses LF line endings only");
  }
  const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (trimmed.length === 0) {
    throw new Error("[ANCHOR_EMPTY_LINE] sidecar must not contain blank lines");
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_ANCHOR_LINE_BYTES) {
    throw new Error(
      `[ANCHOR_LINE_TOO_LARGE] sidecar line exceeds ${MAX_ANCHOR_LINE_BYTES} bytes`,
    );
  }
  return RecordingTimelineAnchorSchema.parse(JSON.parse(trimmed));
}

export interface SidecarCheck {
  ok: boolean;
  errors: string[];
  anchor_count: number;
  bytes: number;
}

/**
 * Validates serialized sidecar text: total <= 5 MiB, LF-only, no BOM, no
 * blank lines, every line a valid anchor, batch ordering holds. No file
 * writes: operates on in-memory text only.
 */
export function validateSidecarText(
  text: string,
  expectedTake?: TakeFence,
): SidecarCheck {
  const errors: string[] = [];
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SIDECAR_BYTES) {
    errors.push(
      `sidecar is ${bytes} bytes (max ${MAX_SIDECAR_BYTES})`,
    );
    return { ok: false, errors, anchor_count: 0, bytes };
  }
  if (text.startsWith("\uFEFF")) {
    errors.push("sidecar must not start with BOM");
  }
  if (text.includes("\r")) {
    errors.push("sidecar must use LF line endings only");
  }
  const records: unknown[] = [];
  if (text.length > 0) {
    const lines = text.split("\n");
    const hasTrailingNewline = text.endsWith("\n");
    const body = hasTrailingNewline ? lines.slice(0, -1) : lines;
    for (let i = 0; i < body.length; i += 1) {
      const raw = body[i]!;
      if (raw.length === 0) {
        errors.push(`sidecar line ${i}: blank line rejected`);
        continue;
      }
      try {
        records.push(JSON.parse(raw));
      } catch {
        errors.push(`sidecar line ${i}: invalid JSON`);
      }
    }
  }
  const batch = checkAnchorBatchOrdering(records, expectedTake);
  return {
    ok: errors.length === 0 && batch.ok,
    errors: [...errors, ...batch.errors],
    anchor_count: batch.anchor_count,
    bytes,
  };
}

/** Minimal local sorted-keys canonicalization (canonical-json-v1 mirror). */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep) as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted as T;
  }
  return value;
}

