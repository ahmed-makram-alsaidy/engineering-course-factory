// P10.3 Speaker Resolver Unit Tests
//
// Tests logical speaker resolution, VoiceProfile configuration validation,
// default profile fallbacks, and strict locale compatibility enforcement.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type VoiceProfile,
  type VoiceProfileConfig,
  resolveSpeaker,
  validateLocaleCompatibility,
  validateVoiceProfileConfig,
  VoicePlannerError,
} from "../src/index.ts";

describe("speaker-resolver: configuration validation (fail-closed)", () => {
  const validProfileAr: VoiceProfile = {
    profile_id: "ar-instructor-primary",
    locale: "ar-EG",
    gender: "male",
    description: "Primary Egyptian Arabic instructor",
    provider_family: "fake",
    provider_voice_id: "cairo-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    style: "instructional",
    normalization_policy: "standard-v1",
  };

  const validProfileEn: VoiceProfile = {
    profile_id: "en-instructor-primary",
    locale: "en-US",
    gender: "male",
    description: "Primary English instructor",
    provider_family: "fake",
    provider_voice_id: "boston-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    style: "instructional",
    normalization_policy: "standard-v1",
  };

  it("accepts a valid configuration", () => {
    const config: VoiceProfileConfig = {
      profiles: [validProfileAr, validProfileEn],
      speaker_mappings: [
        { speaker: "instructor_ar", profile_id: "ar-instructor-primary" },
        { speaker: "instructor_en", profile_id: "en-instructor-primary" },
      ],
      default_profile_id: "ar-instructor-primary",
    };

    const validated = validateVoiceProfileConfig(config);
    assert.equal(validated.profiles.length, 2);
    assert.equal(validated.speaker_mappings.length, 2);
    assert.equal(validated.default_profile_id, "ar-instructor-primary");
  });

  it("rejects configuration with duplicate profile_id", () => {
    const config = {
      profiles: [validProfileAr, { ...validProfileAr }],
      speaker_mappings: [],
    };

    assert.throws(
      () => validateVoiceProfileConfig(config),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /Duplicate profile_id/);
        return true;
      },
    );
  });

  it("rejects configuration with duplicate speaker mappings", () => {
    const config = {
      profiles: [validProfileAr],
      speaker_mappings: [
        { speaker: "instructor", profile_id: "ar-instructor-primary" },
        { speaker: "instructor", profile_id: "ar-instructor-primary" },
      ],
    };

    assert.throws(
      () => validateVoiceProfileConfig(config),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /Duplicate speaker mapping/);
        return true;
      },
    );
  });

  it("rejects speaker mapping to nonexistent profile_id", () => {
    const config = {
      profiles: [validProfileAr],
      speaker_mappings: [
        { speaker: "instructor", profile_id: "non-existent-profile" },
      ],
    };

    assert.throws(
      () => validateVoiceProfileConfig(config),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /maps to non-existent profile_id/);
        return true;
      },
    );
  });

  it("rejects invalid default_profile_id not present in profiles", () => {
    const config = {
      profiles: [validProfileAr],
      speaker_mappings: [],
      default_profile_id: "missing-default-profile",
    };

    assert.throws(
      () => validateVoiceProfileConfig(config),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /Default profile_id 'missing-default-profile' does not exist/);
        return true;
      },
    );
  });
});

describe("speaker-resolver: speaker resolution logic", () => {
  const profileArEg: VoiceProfile = {
    profile_id: "ar-eg-prof",
    locale: "ar-EG",
    gender: "male",
    description: "Egyptian Arabic profile",
    provider_family: "fake",
    provider_voice_id: "cairo-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const profileArSa: VoiceProfile = {
    profile_id: "ar-sa-prof",
    locale: "ar-SA",
    gender: "female",
    description: "Saudi Arabic profile",
    provider_family: "fake",
    provider_voice_id: "riyadh-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const profileEnUs: VoiceProfile = {
    profile_id: "en-us-prof",
    locale: "en-US",
    gender: "female",
    description: "US English profile",
    provider_family: "fake",
    provider_voice_id: "boston-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const profileEnGb: VoiceProfile = {
    profile_id: "en-gb-prof",
    locale: "en-GB",
    gender: "male",
    description: "GB English profile",
    provider_family: "fake",
    provider_voice_id: "london-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    normalization_policy: "standard-v1",
  };

  const config: VoiceProfileConfig = {
    profiles: [profileArEg, profileArSa, profileEnUs, profileEnGb],
    speaker_mappings: [
      { speaker: "cairo_instructor", profile_id: "ar-eg-prof" },
      { speaker: "riyadh_instructor", profile_id: "ar-sa-prof" },
      { speaker: "us_instructor", profile_id: "en-us-prof" },
      { speaker: "gb_instructor", profile_id: "en-gb-prof" },
    ],
    default_profile_id: "ar-eg-prof",
  };

  it("resolves explicit logical speaker persona to mapped VoiceProfile", () => {
    const resolved = resolveSpeaker("cairo_instructor", "ar", config);
    assert.equal(resolved.profile_id, "ar-eg-prof");
    assert.equal(resolved.locale, "ar-EG");
  });

  it("fails closed with UNSUPPORTED_VOICE when logical speaker is unknown", () => {
    assert.throws(
      () => resolveSpeaker("unknown_speaker", "ar", config),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "UNSUPPORTED_VOICE");
        assert.match(err.message, /Unknown logical speaker 'unknown_speaker'/);
        return true;
      },
    );
  });

  it("resolves default profile when speaker is undefined", () => {
    const resolved = resolveSpeaker(undefined, "ar", config);
    assert.equal(resolved.profile_id, "ar-eg-prof");
    assert.equal(resolved.locale, "ar-EG");
  });

  it("fails closed with CONFIG_INVALID when speaker is undefined and no default profile exists", () => {
    const configWithoutDefault: VoiceProfileConfig = {
      profiles: [profileArEg],
      speaker_mappings: [{ speaker: "cairo_instructor", profile_id: "ar-eg-prof" }],
    };

    assert.throws(
      () => resolveSpeaker(undefined, "ar", configWithoutDefault),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /no default_profile_id is configured/);
        return true;
      },
    );
  });
});

describe("speaker-resolver: locale compatibility and mismatch enforcement", () => {
  it("permits ar IR with ar-EG profile", () => {
    assert.doesNotThrow(() => validateLocaleCompatibility("ar", "ar-EG"));
  });

  it("permits ar IR with ar-SA profile", () => {
    assert.doesNotThrow(() => validateLocaleCompatibility("ar", "ar-SA"));
  });

  it("rejects ar IR with en-US profile (UNSUPPORTED_LOCALE)", () => {
    assert.throws(
      () => validateLocaleCompatibility("ar", "en-US"),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "UNSUPPORTED_LOCALE");
        assert.match(err.message, /Locale mismatch/);
        return true;
      },
    );
  });

  it("permits en IR with en-US profile", () => {
    assert.doesNotThrow(() => validateLocaleCompatibility("en", "en-US"));
  });

  it("permits en IR with en-GB profile", () => {
    assert.doesNotThrow(() => validateLocaleCompatibility("en", "en-GB"));
  });

  it("rejects en IR with ar-EG profile (UNSUPPORTED_LOCALE)", () => {
    assert.throws(
      () => validateLocaleCompatibility("en", "ar-EG"),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "UNSUPPORTED_LOCALE");
        assert.match(err.message, /Locale mismatch/);
        return true;
      },
    );
  });

  it("rejects en IR with ar-SA profile (UNSUPPORTED_LOCALE)", () => {
    assert.throws(
      () => validateLocaleCompatibility("en", "ar-SA"),
      (err: unknown) => {
        assert.ok(err instanceof VoicePlannerError);
        assert.equal(err.code, "UNSUPPORTED_LOCALE");
        assert.match(err.message, /Locale mismatch/);
        return true;
      },
    );
  });
});
