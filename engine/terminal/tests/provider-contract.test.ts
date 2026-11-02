// P5.1 ExecutionProvider contract tests — the contract is types only: no
// implementation, no runtime exports, and no Docker/provider source exists
// yet in P5.1.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as providerModule from "../src/providers/execution-provider.ts";
import * as indexModule from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const providerSourcePath = join(here, "..", "src", "providers", "execution-provider.ts");

describe("ExecutionProvider contract", () => {
  it("is types only: importing the module yields an empty runtime namespace", () => {
    assert.deepEqual(Object.keys(providerModule), [], "the provider contract must not carry executable exports");
  });

  it("the public index exports the contract types without implementation", () => {
    const runtimeKeys = Object.keys(indexModule).filter(
      (key) => key.startsWith("ExecutionProvider") || key === "DockerSandboxProvider" || key === "AdmittedSession" || key === "ProviderSession",
    );
    assert.deepEqual(runtimeKeys, [], "no provider implementation may be exported");
  });

  it("the interface references exactly the six design operations", () => {
    const source = readFileSync(providerSourcePath, "utf8");
    const interfaceBody = source.slice(source.indexOf("export interface ExecutionProvider"));
    for (const method of ["prepare", "start", "stop", "cancel", "events", "close"]) {
      assert.match(interfaceBody, new RegExp(`\\b${method}\\s*\\(`), `contract method ${method}`);
    }
    const methods = [...interfaceBody.matchAll(/^\s{2}\w+\(/gm)].map((m) => m[0].trim());
    assert.equal(methods.length, 6, `exactly six contract methods, found: ${methods.length}`);
  });

  it("the DockerSandboxProvider arrives in P5.4 (provider module is now present)", () => {
    // P5.1 shipped the ExecutionProvider interface only (no implementation).
    // P5.4 materializes the single sanctioned concrete provider: the Docker
    // sandbox transport. The contract test above still verifies the interface
    // itself is pure; here we assert the P5.4 arrival milestone.
    assert.equal(existsSync(join(here, "..", "src", "providers", "docker.ts")), true);
    assert.equal(existsSync(join(here, "..", "src", "providers", "docker-cli.ts")), true);
    const source = readFileSync(providerSourcePath, "utf8");
    assert.doesNotMatch(source, /\bclass\s+\w*Provider\b/, "no concrete provider class is exported from the contract module");
  });
});
