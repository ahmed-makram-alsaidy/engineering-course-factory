// P5.3 environment policy tests — the fixed allowlist policy, deterministic
// base, synthetic secret-leak resistance, plan validation, and redaction.
// Host environments here are SYNTHETIC objects; nothing reads the real
// machine environment and nothing executes.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ENVIRONMENT_POLICY,
  ENVIRONMENT_POLICY_VERSION,
  describeEnvironmentPlan,
  resolveEnvironmentPlan,
  validateEnvironmentPlan,
  type EnvironmentPlan,
} from "../src/environment.ts";

/** Synthetic host environment loaded with plausible-looking secrets. */
const HOSTILE_HOST_ENV: Readonly<Record<string, string | undefined>> = Object.freeze({
  TZ: "UTC",
  NO_COLOR: "1",
  LC_ALL: "C.UTF-8",
  PATH: "C:\\Windows\\system32;C:\\Windows",
  AWS_SECRET_ACCESS_KEY: "synthetic-aws-secret",
  GITHUB_TOKEN: "synthetic-github-token",
  OPENAI_API_KEY: "synthetic-openai-key",
  DOCKER_HOST: "tcp://127.0.0.1:2375",
  NODE_ENV: "production",
  SSH_AUTH_SOCK: "/tmp/agent.sock",
});

describe("P5.3 environment policy", () => {
  it("carries exactly the fixed policy: deterministic base + 3-name host allowlist", () => {
    assert.equal(ENVIRONMENT_POLICY_VERSION, 1);
    assert.deepEqual({ ...ENVIRONMENT_POLICY.base_environment }, { HOME: "/workspace/.home", LANG: "C.UTF-8" });
    assert.deepEqual([...ENVIRONMENT_POLICY.allowed_host_names], ["LC_ALL", "TZ", "NO_COLOR"]);
  });

  it("never inherits the host environment wholesale (only base + explicitly requested names)", () => {
    const result = resolveEnvironmentPlan(HOSTILE_HOST_ENV, ["NO_COLOR"]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual({ ...result.value.base }, { HOME: "/workspace/.home", LANG: "C.UTF-8" });
    assert.equal(result.value.host_forwarded.length, 1);
    assert.equal(result.value.host_forwarded[0]?.name, "NO_COLOR");
    assert.equal(result.value.host_forwarded[0]?.source, "host_allowlist");
    const serialized = JSON.stringify(result.value);
    for (const leaked of ["PATH", "AWS_", "GITHUB", "OPENAI", "DOCKER", "NODE_ENV", "SSH", "synthetic"]) {
      assert.ok(!serialized.includes(leaked), `plan must not contain ${leaked}`);
    }
  });

  it("skips allowlisted names whose host value is missing or empty", () => {
    const result = resolveEnvironmentPlan({ TZ: "", NO_COLOR: undefined }, ["TZ", "NO_COLOR", "LC_ALL"]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.host_forwarded, []);
  });

  it("rejects non-allowlisted and secret-shaped requests (never silently dropped)", () => {
    for (const name of ["PATH", "NODE_ENV", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "DOCKER_HOST", "HOME_OVERRIDE"]) {
      const result = resolveEnvironmentPlan(HOSTILE_HOST_ENV, [name]);
      assert.equal(result.ok, false, `${name} must be rejected`);
      if (result.ok) return;
      assert.equal(result.error.code, "ENVIRONMENT_POLICY_VIOLATION", name);
    }
  });

  it("rejects malformed names and duplicates", () => {
    const weird = resolveEnvironmentPlan(HOSTILE_HOST_ENV, ["NO-COLOR"]);
    assert.equal(weird.ok, false);
    const dup = resolveEnvironmentPlan(HOSTILE_HOST_ENV, ["TZ", "TZ"]);
    assert.equal(dup.ok, false);
    if (dup.ok) return;
    assert.equal(dup.error.code, "ENVIRONMENT_POLICY_VIOLATION");
  });

  it("validates plan objects: fixed base, allowlisted forwards, schema shape", () => {
    const good = resolveEnvironmentPlan(HOSTILE_HOST_ENV, ["LC_ALL", "NO_COLOR"]);
    assert.equal(good.ok, true);
    if (!good.ok) return;
    const validated = validateEnvironmentPlan(good.value);
    assert.equal(validated.ok, true);

    const extraBase: EnvironmentPlan = {
      ...good.value,
      base: { ...good.value.base, NODE_ENV: "production" },
    };
    const smuggledBase = validateEnvironmentPlan(extraBase);
    assert.equal(smuggledBase.ok, false, "base environment is fixed — no extra keys");

    const wrongValue: EnvironmentPlan = {
      ...good.value,
      base: { ...good.value.base, HOME: "/mnt/host-home" },
    };
    assert.equal(validateEnvironmentPlan(wrongValue).ok, false);

    const foreignForward: EnvironmentPlan = {
      ...good.value,
      host_forwarded: [...good.value.host_forwarded, { name: "GITHUB_TOKEN", value: "x", source: "host_allowlist" }],
    };
    const smuggledForward = validateEnvironmentPlan(foreignForward);
    assert.equal(smuggledForward.ok, false, "secret-shaped forwards are rejected");
    if (smuggledForward.ok) return;
    assert.equal(smuggledForward.error.code, "ENVIRONMENT_POLICY_VIOLATION");

    assert.equal(validateEnvironmentPlan({ kind: "not a plan" }).ok, false);
    assert.equal(validateEnvironmentPlan(null).ok, false);
  });

  it("describes plans for logs with values REDACTED, names only", () => {
    const planResult = resolveEnvironmentPlan(HOSTILE_HOST_ENV, ["TZ", "NO_COLOR"]);
    assert.equal(planResult.ok, true);
    if (!planResult.ok) return;
    const description = describeEnvironmentPlan(planResult.value);
    assert.equal(description.values_redacted, true);
    assert.deepEqual([...description.base_names], ["HOME", "LANG"]);
    for (const entry of description.host_forwarded) {
      assert.equal(entry.value, "redacted");
      assert.equal(entry.source, "host_allowlist");
      assert.ok(["TZ", "NO_COLOR"].includes(entry.name));
    }
    const serialized = JSON.stringify(description);
    assert.ok(!serialized.includes("UTC"), "real values must not appear in the description");
  });

  it("resolved plans are deeply frozen (runtime-only, no post-hoc edits)", () => {
    const result = resolveEnvironmentPlan(HOSTILE_HOST_ENV, ["TZ"]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(Object.isFrozen(result.value));
    assert.ok(Object.isFrozen(result.value.base));
    assert.ok(Object.isFrozen(result.value.host_forwarded));
  });
});
