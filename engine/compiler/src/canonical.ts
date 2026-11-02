// Deterministic canonical JSON — the single serialization strategy for the
// compiled IR, used for BOTH the source hash and the output file.
//
// canonical-json-v1:
//   - object keys are sorted recursively (JavaScript default string order,
//     i.e. strict UTF-16 code-unit order — key order in the authored source is
//     never semantic)
//   - array order is preserved (arrays carry authored sequence — never sorted)
//   - strings, numbers, booleans and null encode as plain JSON
//
// The source hash hashes the compact form; the output file uses the same
// canonical object with 2-space indentation and a trailing newline. Two
// semantically identical lesson sources therefore produce byte-identical
// compiled files regardless of authored key order, comments, or quoting.

import { createHash } from "node:crypto";

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

/** Compact canonical JSON (used for hashing). */
export function canonicalJsonV1(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/** Canonical file serialization: 2-space indent, trailing newline, UTF-8, LF. */
export function serializeCompiledLesson(compiled: unknown): string {
  return JSON.stringify(sortKeysDeep(compiled), null, 2) + "\n";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic hash of the canonical semantic source content (see docs/P3-LESSON-COMPILER.md). */
export function sourceHash(lesson: unknown): { algorithm: "sha256"; canonicalization: "canonical-json-v1"; value: string } {
  return { algorithm: "sha256", canonicalization: "canonical-json-v1", value: sha256Hex(canonicalJsonV1(lesson)) };
}
