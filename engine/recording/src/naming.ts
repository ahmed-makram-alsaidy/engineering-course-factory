// P9.1 Deterministic Artifact Naming.
//
// Canonical authority: P9-DESIGN-SPEC.md Section 20 (Temp / Final Storage &
// Naming). Main-computed, deterministic, traversal-proof artifact names.
// The renderer supplies no filenames. Pure string logic; no filesystem.

import { z } from "zod";
import {
  RecordingGenerationSchema,
  RecordingLessonIdSchema,
  TakeIdSchema,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Take Artifact Base Name: <lesson_id>--gen<generation>--take<take_id>
// ---------------------------------------------------------------------------

export const TakeNamingInputSchema = z.strictObject({
  lesson_id: RecordingLessonIdSchema,
  generation: RecordingGenerationSchema,
  take_id: TakeIdSchema,
});
export type TakeNamingInput = z.infer<typeof TakeNamingInputSchema>;

/** Builds e.g. `C01-L003--gen1--taket01` (no extension, no directories). */
export function buildTakeArtifactBaseName(input: TakeNamingInput): string {
  const parsed = TakeNamingInputSchema.parse(input);
  return `${parsed.lesson_id}--gen${parsed.generation}--take${parsed.take_id}`;
}

/** Formats a take counter as `t01`, `t02`, ... (minimum two digits). */
export function formatTakeId(takeNumber: number): string {
  if (!Number.isInteger(takeNumber) || takeNumber < 1 || takeNumber > 9999) {
    throw new Error("[NAMING_INVALID] take number must be an integer 1..9999");
  }
  return `t${String(takeNumber).padStart(2, "0")}`;
}

const TAKE_BASENAME_PATTERN =
  /^(C\d{2}-L\d{3})--gen([1-9]\d*)--take(t\d{2,})$/;

export interface ParsedTakeArtifactBaseName {
  lesson_id: string;
  generation: number;
  take_id: string;
}

/** Parses a base name back into components; rejects traversal/hostile names. */
export function parseTakeArtifactBaseName(
  baseName: string,
): ParsedTakeArtifactBaseName {
  if (typeof baseName !== "string") {
    throw new Error("[NAMING_INVALID] base name must be a string");
  }
  const match = TAKE_BASENAME_PATTERN.exec(baseName);
  if (match === null) {
    throw new Error(`[NAMING_INVALID] malformed take base name '${baseName}'`);
  }
  return {
    lesson_id: match[1]!,
    generation: Number.parseInt(match[2]!, 10),
    take_id: match[3]!,
  };
}

// ---------------------------------------------------------------------------
// Artifact File Names (relative names only; roots resolve via paths.json)
// ---------------------------------------------------------------------------

/** Final screen-video artifact name: `<base>.mp4`. */
export function takeVideoFileName(baseName: string): string {
  const parsed = parseTakeArtifactBaseName(baseName);
  return `${parsed.lesson_id}--gen${parsed.generation}--take${parsed.take_id}.mp4`;
}

/** Manifest artifact name: `<base>.manifest.json`. */
export function takeManifestFileName(baseName: string): string {
  const parsed = parseTakeArtifactBaseName(baseName);
  return `${parsed.lesson_id}--gen${parsed.generation}--take${parsed.take_id}.manifest.json`;
}

/** Anchors sidecar name: `<base>.anchors.jsonl`. */
export function takeAnchorsFileName(baseName: string): string {
  const parsed = parseTakeArtifactBaseName(baseName);
  return `${parsed.lesson_id}--gen${parsed.generation}--take${parsed.take_id}.anchors.jsonl`;
}

/** Temp partial name (TEMP class only): `<base>.partial.mp4`. */
export function takePartialFileName(baseName: string): string {
  const parsed = parseTakeArtifactBaseName(baseName);
  return `${parsed.lesson_id}--gen${parsed.generation}--take${parsed.take_id}.partial.mp4`;
}

/** Quarantined diagnostic partial (TEMP only): `<base>.diagnostic.partial.mp4`. */
export function takeDiagnosticPartialFileName(baseName: string): string {
  const parsed = parseTakeArtifactBaseName(baseName);
  return `${parsed.lesson_id}--gen${parsed.generation}--take${parsed.take_id}.diagnostic.partial.mp4`;
}
