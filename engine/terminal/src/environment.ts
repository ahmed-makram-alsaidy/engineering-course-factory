// P5.3 environment policy — the trusted, explicit allowlist that decides WHAT
// environment a future lesson process may receive (docs/P5-DESIGN-SPEC.md,
// task P5.3 "guest/client allowlists").
//
// Core rule: the host environment is NEVER inherited wholesale. Lesson
// processes receive:
//   1. a fixed minimal deterministic base environment (below), and
//   2. at most the explicitly configured, explicitly named, non-secret host
//      variables listed in allowed_host_names — nothing else.
//
// The host and the Docker image are DIFFERENT trust domains. PATH is provided
// by the pinned runtime image (the host PATH is never forwarded — Windows
// paths inside a Linux container would be both broken and a machine-path
// leak). TERM and NODE_ENV are deliberately not set ("only if needed later").
//
// Renderer/lesson influence: NONE. A renderer request has no field that could
// carry an environment request (strict identifier-only schemas), and compiled
// IR has no authored environment contract — none is invented here. The only
// input is trusted main/runtime configuration naming variables from the fixed
// allowlist. Values are looked up from the host environment supplied by
// trusted runtime code (never scanned from secrets-bearing sources).
//
// Redaction: environment values are runtime-only. For logs/diagnostics use
// describeEnvironmentPlan(), which reports variable names, source category and
// redaction status — never values.

import { z } from "zod";
import { type RuntimeErrorCode } from "./protocol.ts";

export const ENVIRONMENT_POLICY_VERSION = 1;

export const ENVIRONMENT_POLICY = Object.freeze({
  /** Fixed deterministic base environment (image-independent, non-secret). */
  base_environment: Object.freeze({
    /** Writable HOME inside the workspace leaf (the image rootfs is read-only). */
    HOME: "/workspace/.home",
    /** Deterministic locale. */
    LANG: "C.UTF-8",
  } as Readonly<Record<string, string>>),
  /**
   * The complete set of host variable names P5 permits forwarding. No wildcard
   * inheritance exists; every forwarded variable must be one of these names.
   */
  allowed_host_names: Object.freeze(["LC_ALL", "TZ", "NO_COLOR"] as readonly string[]),
  /**
   * Defense-in-depth: fragments that must never appear in any permitted
   * environment variable name (secret/credential/authentication classes).
   * The allowlist above already excludes them; this blocks future policy
   * edits from reintroducing them unnoticed.
   */
  forbidden_name_fragments: Object.freeze([
    "KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "CREDENTIAL",
    "AWS_",
    "AZURE_",
    "GCP_",
    "OPENAI",
    "GITHUB",
    "GIT_",
    "SSH",
    "DOCKER",
    "COOKIE",
    "AUTH",
    "BEARER",
    "CI_",
  ] as readonly string[]),
});

/** Environment variable name shape: POSIX-conventional, no shell metachars. */
export const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export type EnvName = z.infer<typeof EnvNameSchema>;

export const HostEnvEntrySchema = z.strictObject({
  name: EnvNameSchema,
  value: z.string().min(1),
  /** Provenance category — names may be logged, values may not. */
  source: z.literal("host_allowlist"),
});
export type HostEnvEntry = z.infer<typeof HostEnvEntrySchema>;

export const EnvironmentPlanSchema = z.strictObject({
  environment_policy_version: z.literal(ENVIRONMENT_POLICY_VERSION),
  base: z.record(z.string(), z.string()),
  host_forwarded: z.array(HostEnvEntrySchema),
});
export type EnvironmentPlan = z.infer<typeof EnvironmentPlanSchema>;

/**
 * Resolve the trusted environment plan.
 *
 * @param hostEnv the host environment as supplied by trusted runtime code
 *   (tests inject synthetic variables; nothing is read from the real machine
 *   inside this module).
 * @param requestedHostNames the explicitly configured host variables to
 *   forward. Every name must be in the fixed allowlist; anything else —
 *   including anything secret-shaped — is rejected, never silently dropped.
 */
export function resolveEnvironmentPlan(
  hostEnv: Readonly<Record<string, string | undefined>>,
  requestedHostNames: readonly string[] = [],
): EnvironmentOutcome<EnvironmentPlan> {
  const seen = new Set<string>();
  const host_forwarded: HostEnvEntry[] = [];
  for (const name of requestedHostNames) {
    const shape = EnvNameSchema.safeParse(name);
    if (!shape.success) {
      return envRejected("ENVIRONMENT_POLICY_VIOLATION", `environment name '${name}' is not a permitted variable name`);
    }
    if (!ENVIRONMENT_POLICY.allowed_host_names.includes(name)) {
      return envRejected("ENVIRONMENT_POLICY_VIOLATION", `environment variable '${name}' is not on the fixed host allowlist`);
    }
    if (nameIsForbidden(name)) {
      return envRejected("ENVIRONMENT_POLICY_VIOLATION", `environment variable '${name}' matches a forbidden secret/credential class`);
    }
    if (seen.has(name)) {
      return envRejected("ENVIRONMENT_POLICY_VIOLATION", `environment variable '${name}' was requested more than once`);
    }
    seen.add(name);
    const value = hostEnv[name];
    if (value === undefined || value === "") continue;
    host_forwarded.push({ name, value, source: "host_allowlist" });
  }
  const plan: EnvironmentPlan = {
    environment_policy_version: ENVIRONMENT_POLICY_VERSION,
    base: { ...ENVIRONMENT_POLICY.base_environment },
    host_forwarded,
  };
  return { ok: true, value: deepFreeze(plan) };
}

/** Validate a plan against the fixed policy (defense-in-depth for callers that receive a plan object). */
export function validateEnvironmentPlan(candidate: unknown): EnvironmentOutcome<EnvironmentPlan> {
  const parsed = EnvironmentPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    return envRejected("ENVIRONMENT_POLICY_VIOLATION", "object does not satisfy the environment plan schema");
  }
  const plan = parsed.data;
  const baseNames = Object.keys(plan.base).sort();
  const expectedBaseNames = Object.keys(ENVIRONMENT_POLICY.base_environment).sort();
  if (JSON.stringify(baseNames) !== JSON.stringify(expectedBaseNames)) {
    return envRejected("ENVIRONMENT_POLICY_VIOLATION", "plan base environment does not match the fixed policy base");
  }
  for (const [name, value] of Object.entries(plan.base)) {
    if (ENVIRONMENT_POLICY.base_environment[name] !== value) {
      return envRejected("ENVIRONMENT_POLICY_VIOLATION", `plan base value for '${name}' does not match the fixed policy`);
    }
  }
  for (const entry of plan.host_forwarded) {
    if (!ENVIRONMENT_POLICY.allowed_host_names.includes(entry.name) || nameIsForbidden(entry.name)) {
      return envRejected("ENVIRONMENT_POLICY_VIOLATION", `plan forwards non-allowlisted variable '${entry.name}'`);
    }
  }
  if (plan.host_forwarded.length > ENVIRONMENT_POLICY.allowed_host_names.length) {
    return envRejected("ENVIRONMENT_POLICY_VIOLATION", "plan forwards more host variables than the allowlist permits");
  }
  return { ok: true, value: deepFreeze(plan) };
}

/**
 * Log/diagnostic view of a plan: variable names, source category and
 * redaction status only — NEVER values. This is the only sanctioned way to
 * surface an environment plan in evidence or logs.
 */
export function describeEnvironmentPlan(plan: EnvironmentPlan): {
  readonly base_names: readonly string[];
  readonly host_forwarded: readonly { readonly name: string; readonly source: string; readonly value: "redacted" }[];
  readonly values_redacted: true;
} {
  return {
    base_names: Object.keys(plan.base).sort(),
    host_forwarded: plan.host_forwarded.map((entry) => ({ name: entry.name, source: entry.source, value: "redacted" as const })),
    values_redacted: true,
  };
}

export interface EnvironmentRejection {
  readonly code: RuntimeErrorCode;
  readonly message: string;
}

export type EnvironmentOutcome<T> = { ok: true; value: T } | { ok: false; error: EnvironmentRejection };

function envRejected(code: RuntimeErrorCode, message: string): { ok: false; error: EnvironmentRejection } {
  return { ok: false, error: { code, message } };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function nameIsForbidden(name: string): boolean {
  const upper = name.toUpperCase();
  return ENVIRONMENT_POLICY.forbidden_name_fragments.some((fragment) => upper.includes(fragment));
}
