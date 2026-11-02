// P10.6 Host Credential Authority & Secret Store
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 9, 28 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 4, 11.
//
// Privileged Main-side credential resolution:
// - Resolves credentials exclusively for backend provider adapters.
// - Sources: System environment variables and local git-ignored config file.
// - Automatically registers all resolved secret values with SecretRedactor.
// - Strictly zero enumeration: NO listAllSecrets(), NO dumpConfig(), NO raw env map.
// - Rejects invalid key identifiers (path traversal, shell injection prevention).

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { type VoiceSecretQuery, type VoiceSecretResolver } from "../src/credential-types.ts";
import { defaultSecretRedactor, SecretRedactor } from "../src/redactor.ts";
import { type ProviderIdentity, VoiceProviderError } from "../src/provider-interface.ts";

function providerIdentityFor(family: string): ProviderIdentity {
  return {
    provider_family: family || "unknown",
    provider_model: "none",
    provider_voice_id: "none",
  };
}

export interface VoiceCredentialStoreOptions {
  /** Optional custom secret redactor. Defaults to defaultSecretRedactor. */
  readonly redactor?: SecretRedactor;
  /** Optional custom environment map (defaults to process.env). */
  readonly env?: Record<string, string | undefined>;
  /** Optional custom path to git-ignored credentials config file. */
  readonly configFilePath?: string;
  /** Optional in-memory override secrets for offline tests: Map<family, Map<key, secret>>. */
  readonly testSecrets?: Map<string, Map<string, string>>;
}

const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export class VoiceCredentialStore implements VoiceSecretResolver {
  private readonly redactor: SecretRedactor;
  private readonly env: Record<string, string | undefined>;
  private readonly configFilePath?: string;
  private readonly testSecrets?: Map<string, Map<string, string>>;
  private fileConfigCache?: Record<string, Record<string, string>> | null;

  constructor(options?: VoiceCredentialStoreOptions) {
    this.redactor = options?.redactor ?? defaultSecretRedactor;
    this.env = options?.env ?? process.env;
    this.configFilePath = options?.configFilePath;
    this.testSecrets = options?.testSecrets;
  }

  /**
   * Resolves a specific secret by provider family and key name.
   * If found, registers the secret value with the redactor and returns it.
   * If not found, returns null.
   */
  async resolveSecret(query: VoiceSecretQuery): Promise<string | null> {
    return this.resolveSecretSync(query);
  }

  /** Synchronous resolution helper. */
  resolveSecretSync(query: VoiceSecretQuery): string | null {
    this.validateQuery(query);

    const { provider_family, secret_key } = query;

    // 1. Check test secrets (if configured)
    if (this.testSecrets) {
      const familyMap = this.testSecrets.get(provider_family);
      if (familyMap && familyMap.has(secret_key)) {
        const val = familyMap.get(secret_key)!;
        this.redactor.registerSecret(val);
        return val;
      }
    }

    // 2. Check environment variables
    // Preferred pattern: COURSE_FACTORY_TTS_<FAMILY>_<KEY>
    // Fallback pattern:  <FAMILY>_<KEY>
    const normalizedFamily = provider_family.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    const normalizedKey = secret_key.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();

    const envCandidates = [
      `COURSE_FACTORY_TTS_${normalizedFamily}_${normalizedKey}`,
      `${normalizedFamily}_${normalizedKey}`,
    ];

    for (const envKey of envCandidates) {
      const val = this.env[envKey];
      if (val !== undefined && val.trim().length > 0) {
        const secretVal = val.trim();
        this.redactor.registerSecret(secretVal);
        return secretVal;
      }
    }

    // 3. Check git-ignored machine config file (if specified or default exists)
    const fileSecret = this.resolveFromFile(provider_family, secret_key);
    if (fileSecret !== null) {
      this.redactor.registerSecret(fileSecret);
      return fileSecret;
    }

    return null;
  }

  /**
   * Checks whether a secret is present without returning the secret value.
   */
  async hasSecret(query: VoiceSecretQuery): Promise<boolean> {
    const val = this.resolveSecretSync(query);
    return val !== null;
  }

  private validateQuery(query: VoiceSecretQuery): void {
    if (!query || typeof query !== "object") {
      throw new VoiceProviderError({
        code: "CONFIG_INVALID",
        message: "Secret query must be an object",
        provider_identity: providerIdentityFor("unknown"),
      });
    }

    if (!query.provider_family || !SAFE_IDENTIFIER_REGEX.test(query.provider_family)) {
      throw new VoiceProviderError({
        code: "CONFIG_INVALID",
        message: `Invalid provider family identifier for secret resolution: '${query.provider_family}'`,
        provider_identity: providerIdentityFor(query.provider_family || "unknown"),
      });
    }

    if (!query.secret_key || !SAFE_IDENTIFIER_REGEX.test(query.secret_key)) {
      throw new VoiceProviderError({
        code: "CONFIG_INVALID",
        message: `Invalid secret key identifier for secret resolution: '${query.secret_key}'`,
        provider_identity: providerIdentityFor(query.provider_family),
      });
    }
  }

  private resolveFromFile(family: string, key: string): string | null {
    if (this.fileConfigCache === undefined) {
      this.loadFileConfig();
    }

    if (!this.fileConfigCache) {
      return null;
    }

    const familyConfig = this.fileConfigCache[family];
    if (!familyConfig || typeof familyConfig !== "object") {
      return null;
    }

    const val = familyConfig[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }

    return null;
  }

  private loadFileConfig(): void {
    const configPath = this.configFilePath ?? this.resolveDefaultConfigPath();
    if (!configPath || !existsSync(configPath)) {
      this.fileConfigCache = null;
      return;
    }

    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Credentials config root must be an object");
      }
      this.fileConfigCache = parsed as Record<string, Record<string, string>>;
    } catch (err) {
      this.fileConfigCache = null;
      throw new VoiceProviderError({
        code: "CONFIG_INVALID",
        message: `Failed to read voice credentials configuration: ${err instanceof Error ? err.message : String(err)}`,
        provider_identity: providerIdentityFor("unknown"),
        cause: err,
      });
    }
  }

  private resolveDefaultConfigPath(): string | null {
    // E:\course-factory\config\voice-credentials.json
    try {
      const candidate = resolve(process.cwd(), "config", "voice-credentials.json");
      return candidate;
    } catch {
      return null;
    }
  }
}
