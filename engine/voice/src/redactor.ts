// P10.6 Centralized Secret Redaction
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 9, 28, 29 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 4, 11.
//
// Responsibilities:
// - Register exact resolved secret values dynamically for operational redaction.
// - Redact Authorization headers, Bearer tokens, API keys, client secrets, and passwords.
// - Sanitize URLs (stripping embedded userinfo and signature/secret query parameters).
// - Enforce zero leak of credential bytes into logs, errors, or evidence files.
// - Pure TypeScript module (zero network, zero filesystem, zero P8/P9 imports).

export class SecretRedactor {
  private readonly registeredSecrets = new Set<string>();

  /**
   * Registers an exact resolved secret value for lifetime redaction.
   * Ignores empty or trivially short strings (< 4 characters) to prevent false-positive masking.
   */
  registerSecret(secret: string | null | undefined): void {
    if (!secret || typeof secret !== "string") {
      return;
    }
    const trimmed = secret.trim();
    if (trimmed.length >= 4) {
      this.registeredSecrets.add(trimmed);
    }
  }

  /**
   * Clears all registered secret values (for testing or lifecycle teardown).
   */
  clear(): void {
    this.registeredSecrets.clear();
  }

  /**
   * Number of registered exact secrets.
   */
  get size(): number {
    return this.registeredSecrets.size;
  }

  /**
   * Redacts sensitive secrets, tokens, headers, and registered secret values from text.
   */
  redact(text: string): string {
    if (!text || typeof text !== "string") {
      return text;
    }

    let result = text;

    // 1. Redact exact registered secrets first, ordered longest first to avoid partial replacements
    if (this.registeredSecrets.size > 0) {
      const sortedSecrets = Array.from(this.registeredSecrets).sort((a, b) => b.length - a.length);
      for (const secret of sortedSecrets) {
        if (result.includes(secret)) {
          result = result.split(secret).join("[REDACTED]");
        }
      }
    }

    // 2. Redact Authorization headers
    result = result.replace(/Authorization:\s*(Bearer\s+)?[^\r\n,;]+/gi, "Authorization: [REDACTED]");

    // 3. Redact Bearer tokens
    result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");

    // 4. Redact common credential fields in key-value / JSON / query string patterns
    // e.g. api_key=..., apiKey: "...", "secret": "...", etc.
    result = result.replace(
      /(["']?(?:api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|private[_-]?key|sig|signature)["']?\s*[:=]\s*["']?)([^"'\s,;&]+)(["']?)/gi,
      "$1[REDACTED]$3",
    );

    // 5. Sanitize embedded URLs with user credentials
    result = result.replace(/(https?:\/\/)([^:\/\s]+):([^@\/\s]+)@/gi, "$1[REDACTED]@");

    // 6. Normalize any [REDACTED_SECRET] / [REDACTED_URL] tokens from legacy provider messages
    result = result.replace(/\[REDACTED_SECRET\]/g, "[REDACTED]");
    result = result.replace(/\[REDACTED_URL\]/g, "[REDACTED]");

    return result;
  }

  /**
   * Sanitizes a URL string:
   * - Redacts userinfo (username / password).
   * - Redacts sensitive query parameters (key, api_key, sig, token, secret, etc.).
   */
  sanitizeUrl(urlString: string): string {
    if (!urlString || typeof urlString !== "string") {
      return urlString;
    }

    try {
      const parsed = new URL(urlString);
      if (parsed.username || parsed.password) {
        parsed.username = "[REDACTED]";
        parsed.password = "";
      }

      const sensitiveParamPatterns = [
        /^api[_-]?key$/i,
        /^key$/i,
        /^token$/i,
        /^secret$/i,
        /^sig$/i,
        /^signature$/i,
        /^auth$/i,
        /^se$/i, // Azure SAS signed expiry / signature
        /^sp$/i,
        /^sv$/i,
        /^x-amz-/i, // AWS SigV4 query auth
      ];

      const keysToRedact: string[] = [];
      parsed.searchParams.forEach((_val, key) => {
        if (sensitiveParamPatterns.some((pat) => pat.test(key))) {
          keysToRedact.push(key);
        }
      });

      for (const key of keysToRedact) {
        parsed.searchParams.set(key, "[REDACTED]");
      }

      return parsed.toString().replace(/%5BREDACTED%5D/g, "[REDACTED]");
    } catch {
      // Fallback to pattern-based redaction if not a valid URL object
      return this.redact(urlString);
    }
  }
}

/** Global default secret redactor instance for operational logging and errors. */
export const defaultSecretRedactor = new SecretRedactor();

/**
 * Convenience helper to redact secrets from text using the default redactor.
 */
export function redactSecrets(text: string, redactor: SecretRedactor = defaultSecretRedactor): string {
  return redactor.redact(text);
}

/**
 * Convenience helper to sanitize a URL using the default redactor.
 */
export function sanitizeUrl(url: string, redactor: SecretRedactor = defaultSecretRedactor): string {
  return redactor.sanitizeUrl(url);
}
