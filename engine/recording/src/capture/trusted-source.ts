// P9.2 Trusted Capture Source Registry — Main-side window identity seam.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 4-6 and
// docs/adr/ADR-0014-screen-recording-boundary.md (threats T3, T10).
// The Teaching IDE window identity is resolved on the trusted Main side and
// referenced thereafter by an opaque token. The renderer can neither mint
// tokens nor supply raw window identity: tokens are unguessable opaque
// identifiers, raw handles never enter any public DTO (proven by the P9.1
// hostile-field matrix), and resolution validates liveness on every use.
//
// This module holds no Electron import: the future Electron owner mints the
// native reference from its owned window and issues a token here. P9.2 owns
// the seam, not the Electron wiring (P9.5 scope).

import { CaptureSourceTokenSchema } from "../protocol.ts";

/**
 * Trusted native window reference. Constructible only through
 * `issueTrustedSource` on the Main side. The handle is a bigint so 64-bit
 * window values cross the JS boundary exactly; it never serializes into
 * manifests, anchors, snapshots, logs, or renderer payloads.
 */
export interface TrustedWindowRef {
  readonly windowHandle: bigint;
  readonly ownerPid: number;
}

export interface IssuedCaptureSource {
  readonly token: string;
  readonly windowHandle: bigint;
  readonly ownerPid: number;
}

/** Error thrown when a token cannot be resolved to a live trusted source. */
export class UnknownCaptureSourceError extends Error {
  readonly code = "INVALID_IDENTITY" as const;
  constructor(token: string) {
    super(
      `[INVALID_IDENTITY] unknown or revoked capture source token '${sanitizeToken(token)}'`,
    );
    this.name = "UnknownCaptureSourceError";
  }
}

function sanitizeToken(token: string): string {
  if (typeof token !== "string") {
    return "[invalid token]";
  }
  const trimmed = token.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)) {
    return trimmed;
  }
  return "[invalid token]";
}

function makeToken(): string {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let entropy = "";
  // 32 chars from a non-crypto PRNG is sufficient for an in-memory,
  // single-process opaque handle (uniqueness, not a security capability:
  // the trust boundary is the Main-side module, not token secrecy).
  for (let i = 0; i < 32; i += 1) {
    entropy += chars[Math.floor(Math.random() * chars.length)];
  }
  return `wsrc-${entropy}`;
}

/**
 * Main-side registry binding opaque tokens to trusted window references.
 * One registry per Main owner; entries are revoked on stop/close/reset.
 */
export class TrustedCaptureSourceRegistry {
  private readonly entries = new Map<
    string,
    { ref: TrustedWindowRef; revoked: boolean }
  >();

  /** Issues an opaque token for a Main-resolved window reference. */
  issue(ref: TrustedWindowRef): IssuedCaptureSource {
    if (typeof ref.windowHandle !== "bigint" || ref.windowHandle <= 0n) {
      throw new UnknownCaptureSourceError("[invalid window reference]");
    }
    if (!Number.isInteger(ref.ownerPid) || ref.ownerPid <= 0) {
      throw new UnknownCaptureSourceError("[invalid window reference]");
    }
    const token = makeToken();
    CaptureSourceTokenSchema.parse(token);
    this.entries.set(token, {
      ref: { windowHandle: ref.windowHandle, ownerPid: ref.ownerPid },
      revoked: false,
    });
    return { token, windowHandle: ref.windowHandle, ownerPid: ref.ownerPid };
  }

  /** Resolves a token to its trusted reference (throws when unknown). */
  resolve(token: string): TrustedWindowRef {
    const entry =
      typeof token === "string" ? this.entries.get(token) : undefined;
    if (entry === undefined || entry.revoked) {
      throw new UnknownCaptureSourceError(token);
    }
    return entry.ref;
  }

  /** Revokes one token; indeterminate tokens are ignored deterministically. */
  revoke(token: string): void {
    const entry =
      typeof token === "string" ? this.entries.get(token) : undefined;
    if (entry !== undefined) {
      entry.revoked = true;
      this.entries.delete(token);
    }
  }

  /** Revokes every token (barrier/reset path). */
  revokeAll(): void {
    this.entries.clear();
  }

  /** Number of live (unrevoked) tokens. */
  get liveCount(): number {
    return this.entries.size;
  }
}
