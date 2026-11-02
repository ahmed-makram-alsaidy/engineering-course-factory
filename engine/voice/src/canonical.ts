// P10.1 Deterministic Canonical Serialization & SHA-256 Digest
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 18 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Establishes reproducible UTF-8 serialization for cache keys, digests,
// and manifests. Key ordering is strictly sorted (UTF-16 code-unit order),
// array sequences are preserved verbatim, and undefined values are omitted.

import { createHash } from "node:crypto";

/**
 * Recursively sorts all keys in an object hierarchy in UTF-16 code-unit order.
 * Array element order is strictly preserved.
 */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep) as T;
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(source).sort();
    for (const key of keys) {
      const val = source[key];
      if (val !== undefined) {
        sorted[key] = sortKeysDeep(val);
      }
    }
    return sorted as T;
  }
  return value;
}

/**
 * Deterministic compact canonical JSON string (used for cryptographic hashing).
 * Object keys are sorted recursively; no arbitrary whitespace.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * Pretty-printed canonical JSON (2-space indent, trailing newline).
 */
export function canonicalJsonPretty(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

/**
 * Computes standard lowercase 64-character SHA-256 hexadecimal digest.
 */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
