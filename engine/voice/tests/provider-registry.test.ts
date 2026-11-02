// P10.2 Provider Registry & Trusted Resolution Tests
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8 and
// docs/adr/ADR-0015-voice-generation-boundary.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FakeVoiceProvider,
  type VoiceProvider,
  VoiceProviderError,
  getRegisteredProviderFamilies,
  registerVoiceProvider,
  resetProviderRegistry,
  resolveVoiceProvider,
} from "../src/index.ts";

describe("provider-registry: registration & trusted resolution", () => {
  it("resolves built-in 'fake' family to FakeVoiceProvider by default", () => {
    const provider = resolveVoiceProvider("fake");
    assert.ok(provider instanceof FakeVoiceProvider);
    assert.equal(provider.family, "fake");
  });

  it("lists 'fake' in registered provider families", () => {
    const families = getRegisteredProviderFamilies();
    assert.ok(families.includes("fake"));
  });

  it("rejects unselected cloud providers (openai, elevenlabs, azure) with CONFIG_INVALID", () => {
    const unselectedFamilies = ["openai", "elevenlabs", "azure", "google", "edge"];

    for (const family of unselectedFamilies) {
      assert.throws(
        () => resolveVoiceProvider(family),
        (err: VoiceProviderError) => {
          assert.equal(err.code, "CONFIG_INVALID");
          assert.equal(err.retry_classification, "NON_RETRYABLE");
          assert.match(err.message, /UNSELECTED/);
          return true;
        },
      );
    }
  });

  it("rejects non-identifier family strings (path traversal, malicious input)", () => {
    const hostileInputs = [
      "../evil",
      "/etc/passwd",
      "openai; rm -rf /",
      "",
      "   ",
      "@scope/package",
    ];

    for (const input of hostileInputs) {
      assert.throws(() => resolveVoiceProvider(input));
    }
  });

  it("supports registering custom mock provider for testing", () => {
    resetProviderRegistry();
    const mockProvider: VoiceProvider = {
      family: "test-mock",
      async probeCapabilities() {
        return {
          provider_family: "test-mock",
          supported_locales: ["en-US"],
          alignment_support: "none",
          supports_word_alignment: false,
          supports_phoneme_alignment: false,
          supports_cancellation: true,
          supports_idempotency_key: true,
          max_characters_per_request: 500,
          sample_rates: [48000],
          channels: [1],
          output_formats: ["wav"],
          supports_rate_control: false,
          supports_pitch_control: false,
          supports_style_control: false,
        };
      },
      async synthesize() {
        throw new Error("mock");
      },
      async cancel() {},
    };

    registerVoiceProvider("test-mock", mockProvider);
    assert.ok(getRegisteredProviderFamilies().includes("test-mock"));
    const resolved = resolveVoiceProvider("test-mock");
    assert.equal(resolved.family, "test-mock");

    // Clean reset back to default
    resetProviderRegistry();
    assert.equal(getRegisteredProviderFamilies().includes("test-mock"), false);
    assert.ok(getRegisteredProviderFamilies().includes("fake"));
    assert.ok(getRegisteredProviderFamilies().includes("gemini"));
  });

  it("resolves promoted 'gemini' production family to GeminiVoiceProvider by default", () => {
    const provider = resolveVoiceProvider("gemini");
    assert.equal(provider.family, "gemini");
    assert.equal(typeof provider.synthesize, "function");
    assert.equal(typeof provider.probeCapabilities, "function");
    assert.equal(typeof provider.cancel, "function");
    assert.ok(getRegisteredProviderFamilies().includes("gemini"));
  });
});
