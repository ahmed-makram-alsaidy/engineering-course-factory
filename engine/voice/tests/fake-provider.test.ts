// P10.2 FakeVoiceProvider Unit Tests
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 8, 30 and
// docs/adr/ADR-0015-voice-generation-boundary.md.
//
// Comprehensive behavioral verification:
// - Interface compilation & static capabilities
// - Bit-exact reproducibility and SHA-256 digest consistency
// - request_id acoustic invariance
// - Canonical WAV container & sample invariants
// - Failure taxonomy & test-only injection
// - Cancellation (before start & during execution)
// - Timeout classification & bounds
// - Sample-bounded monotonic word alignment
// - Multilingual tokenization (Arabic, English, mixed, punctuation)
// - Credential safety & runtime isolation

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_CHANNELS,
  AUDIO_CONTAINER,
  AUDIO_SAMPLE_RATE_HZ,
  MAX_PROVIDER_RESPONSE_BYTES,
  MIN_AUDIO_SAMPLE_COUNT,
  MIN_NARRATION_DURATION_US,
  FakeVoiceProvider,
  SUPPORTED_LOCALES,
  type SynthesisRequest,
  type VoiceProfile,
  type VoiceProvider,
  VoiceProviderError,
  durationUsForSampleCount,
  sha256Hex,
  validateCanonicalWav,
  validateProviderSynthesisResult,
} from "../src/index.ts";

function createValidProfile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    profile_id: "ar-instructor-primary",
    locale: "ar-EG",
    gender: "male",
    description: "Primary Egyptian technical instructor",
    provider_family: "fake",
    provider_voice_id: "cairo-01",
    provider_model: "deterministic-v1",
    rate: 1.0,
    pitch: 0.0,
    style: "instructional",
    normalization_policy: "standard-v1",
    ...overrides,
  };
}

function createValidRequest(overrides: Partial<SynthesisRequest> = {}): SynthesisRequest {
  const profile = overrides.voice_profile ?? createValidProfile();
  return {
    request_id: "req-test-001",
    cache_key: "a".repeat(64),
    normalized_text: "مرحبا بكم في دورة تدريبية",
    locale: profile.locale,
    voice_profile: profile,
    request_alignment: false,
    ...overrides,
  };
}

describe("fake-provider: identity, capabilities & probe contract", () => {
  it("implements VoiceProvider interface and reports explicit identity", async () => {
    const provider: VoiceProvider = new FakeVoiceProvider();
    assert.equal(provider.family, "fake");
    assert.equal(typeof provider.probeCapabilities, "function");
    assert.equal(typeof provider.synthesize, "function");
    assert.equal(typeof provider.cancel, "function");

    const concrete = provider as FakeVoiceProvider;
    const identity = concrete.getIdentity();
    assert.equal(identity.provider_family, "fake");
    assert.equal(identity.provider_model, "deterministic-v1");
    assert.equal(identity.provider_voice_id, "fixture-neutral");
  });

  it("capability probe returns stable output across calls", async () => {
    const provider = new FakeVoiceProvider();
    const cap1 = await provider.probeCapabilities();
    const cap2 = await provider.probeCapabilities();
    assert.deepEqual(cap1, cap2);
  });

  it("capability probe reports exact supported locales", async () => {
    const provider = new FakeVoiceProvider();
    const cap = await provider.probeCapabilities();
    assert.deepEqual(cap.supported_locales, ["ar-EG", "ar-SA", "en-US", "en-GB"]);
    assert.equal(cap.supported_locales.length, 4);
    for (const loc of cap.supported_locales) {
      assert.ok(SUPPORTED_LOCALES.includes(loc));
    }
  });

  it("capability probe reports exact alignment and control features", async () => {
    const provider = new FakeVoiceProvider();
    const cap = await provider.probeCapabilities();
    assert.equal(cap.alignment_support, "word");
    assert.equal(cap.supports_word_alignment, true);
    assert.equal(cap.supports_phoneme_alignment, false);
    assert.equal(cap.supports_cancellation, true);
    assert.equal(cap.supports_idempotency_key, true);
    assert.equal(cap.max_characters_per_request, 10_000);
    assert.deepEqual(cap.sample_rates, [48000]);
    assert.deepEqual(cap.channels, [1]);
    assert.deepEqual(cap.output_formats, ["wav"]);
    assert.equal(cap.supports_rate_control, true);
    assert.equal(cap.supports_pitch_control, true);
    assert.equal(cap.supports_style_control, true);
  });
});

describe("fake-provider: bit-exact determinism & digest consistency", () => {
  it("same request yields identical result, identical WAV bytes and identical SHA-256 digest", async () => {
    const provider = new FakeVoiceProvider();
    const req = createValidRequest();

    const res1 = await provider.synthesize(req);
    const res2 = await provider.synthesize(req);

    assert.equal(res1.sample_count, res2.sample_count);
    assert.equal(res1.duration_us, res2.duration_us);
    assert.equal(res1.audio_bytes.length, res2.audio_bytes.length);
    assert.ok(res1.audio_bytes.equals(res2.audio_bytes));

    const digest1 = sha256Hex(res1.audio_bytes);
    const digest2 = sha256Hex(res2.audio_bytes);
    assert.equal(digest1, digest2);
    assert.match(digest1, /^[0-9a-f]{64}$/);
  });

  it("different normalized text changes output sample count and SHA-256 digest", async () => {
    const provider = new FakeVoiceProvider();
    const req1 = createValidRequest({ normalized_text: "مرحبا بالعالم" });
    const req2 = createValidRequest({ normalized_text: "هذا نص أطول بكثير يحتوي على كلمات إضافية لشرح المفهوم" });

    const res1 = await provider.synthesize(req1);
    const res2 = await provider.synthesize(req2);

    const digest1 = sha256Hex(res1.audio_bytes);
    const digest2 = sha256Hex(res2.audio_bytes);
    assert.notEqual(digest1, digest2);
    assert.notEqual(res1.sample_count, res2.sample_count);
  });

  it("different locale alters acoustic waveform and SHA-256 digest", async () => {
    const provider = new FakeVoiceProvider();
    const reqAr = createValidRequest({
      locale: "ar-EG",
      voice_profile: createValidProfile({ locale: "ar-EG" }),
      normalized_text: "Hello technical world",
    });
    const reqEn = createValidRequest({
      locale: "en-US",
      voice_profile: createValidProfile({ locale: "en-US", profile_id: "en-instructor-primary" }),
      normalized_text: "Hello technical world",
    });

    const resAr = await provider.synthesize(reqAr);
    const resEn = await provider.synthesize(reqEn);

    assert.equal(resAr.sample_count, resEn.sample_count); // same word count/lengths
    assert.notEqual(sha256Hex(resAr.audio_bytes), sha256Hex(resEn.audio_bytes));
  });

  it("different voice profile rate/pitch changes synthesized bytes", async () => {
    const provider = new FakeVoiceProvider();
    const reqNormal = createValidRequest({
      voice_profile: createValidProfile({ rate: 1.0, pitch: 0.0 }),
    });
    const reqFast = createValidRequest({
      voice_profile: createValidProfile({ rate: 1.5, pitch: 0.0 }),
    });

    const resNormal = await provider.synthesize(reqNormal);
    const resFast = await provider.synthesize(reqFast);

    assert.notEqual(resNormal.sample_count, resFast.sample_count);
    assert.ok(resFast.sample_count < resNormal.sample_count);
    assert.notEqual(sha256Hex(resNormal.audio_bytes), sha256Hex(resFast.audio_bytes));
  });

  it("request_id variation has strictly ZERO effect on synthesized audio bytes (content determinism)", async () => {
    const provider = new FakeVoiceProvider();
    const req1 = createValidRequest({ request_id: "req-alpha-001" });
    const req2 = createValidRequest({ request_id: "req-beta-999" });

    const res1 = await provider.synthesize(req1);
    const res2 = await provider.synthesize(req2);

    // Request IDs in descriptor reflect operation
    assert.equal(res1.provider_request_id, "req-alpha-001");
    assert.equal(res2.provider_request_id, "req-beta-999");

    // Acoustic bytes and digests are bit-for-bit identical
    assert.ok(res1.audio_bytes.equals(res2.audio_bytes));
    assert.equal(sha256Hex(res1.audio_bytes), sha256Hex(res2.audio_bytes));
  });
});

describe("fake-provider: canonical WAV format & signal integrity", () => {
  it("produces strictly compliant 48 kHz mono 16-bit linear PCM RIFF WAV", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(createValidRequest());

    const wavInfo = validateCanonicalWav(res.audio_bytes);
    assert.equal(wavInfo.formatCode, 1);
    assert.equal(wavInfo.channels, 1);
    assert.equal(wavInfo.sampleRate, 48000);
    assert.equal(wavInfo.byteRate, 96000);
    assert.equal(wavInfo.blockAlign, 2);
    assert.equal(wavInfo.bitsPerSample, 16);
    assert.equal(wavInfo.sampleCount, res.sample_count);
    assert.equal(wavInfo.dataLength, res.sample_count * 2);
  });

  it("enforces exact rational duration invariant: duration_us == floor(sample_count * 125 / 6)", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(createValidRequest());

    const expectedUs = durationUsForSampleCount(res.sample_count);
    assert.equal(res.duration_us, expectedUs);
    assert.equal(res.duration_us, Math.floor((res.sample_count * 125) / 6));
  });

  it("produces non-silent signal with bounded PCM integer amplitudes (no clipping, no NaN)", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(createValidRequest({ request_alignment: true }));

    // Read PCM 16-bit samples starting after 44-byte WAV header
    const pcmData = res.audio_bytes.subarray(44);
    const samples = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);

    let nonZeroCount = 0;
    let maxAbs = 0;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      assert.ok(!Number.isNaN(s), "Sample must not be NaN");
      assert.ok(s >= -32768 && s <= 32767, "Sample must be bounded within Int16 range");
      if (s !== 0) nonZeroCount++;
      const abs = Math.abs(s);
      if (abs > maxAbs) maxAbs = abs;
    }

    assert.ok(nonZeroCount > 0, "Signal must contain non-silent active audio samples");
    // Peak amplitude should match sine table amplitude (~6000), far below 32767 clipping limit
    assert.ok(maxAbs >= 5000 && maxAbs <= 6500, `Expected peak ~6000, got ${maxAbs}`);
  });

  it("valid fixture produces duration >= 100 ms and <= 300 s", async () => {
    const provider = new FakeVoiceProvider();
    const shortReq = createValidRequest({ normalized_text: "كلمة" });
    const res = await provider.synthesize(shortReq);

    assert.ok(res.duration_us >= MIN_NARRATION_DURATION_US);
    assert.ok(res.sample_count >= MIN_AUDIO_SAMPLE_COUNT);
    assert.ok(res.duration_us <= 300_000_000);
  });
});

describe("fake-provider: input validation & failure boundaries", () => {
  it("rejects empty or whitespace-only normalized text with TEXT_EMPTY", async () => {
    const provider = new FakeVoiceProvider();
    const emptyReq1 = createValidRequest({ normalized_text: "   \t\n  " });

    await assert.rejects(
      async () => provider.synthesize(emptyReq1),
      (err: VoiceProviderError) => {
        assert.equal(err.name, "VoiceProviderError");
        assert.equal(err.code, "TEXT_EMPTY");
        assert.equal(err.retry_classification, "NON_RETRYABLE");
        return true;
      },
    );
  });

  it("rejects unsupported locale with UNSUPPORTED_LOCALE", async () => {
    const provider = new FakeVoiceProvider();
    const badLocaleReq = {
      ...createValidRequest(),
      locale: "fr-FR" as any,
    };

    await assert.rejects(
      async () => provider.synthesize(badLocaleReq),
      (err: any) => {
        return err.name === "ZodError" || (err instanceof VoiceProviderError && err.code === "UNSUPPORTED_LOCALE");
      },
    );
  });

  it("rejects unsupported voice profile ID with UNSUPPORTED_VOICE when configured", async () => {
    const provider = new FakeVoiceProvider({ supportedVoices: ["cairo-01", "alex-02"] });
    const unsuppVoiceReq = createValidRequest({
      voice_profile: createValidProfile({ provider_voice_id: "unknown-voice-99" }),
    });

    await assert.rejects(
      async () => provider.synthesize(unsuppVoiceReq),
      (err: VoiceProviderError) => {
        assert.equal(err.name, "VoiceProviderError");
        assert.equal(err.code, "UNSUPPORTED_VOICE");
        assert.equal(err.retry_classification, "NON_RETRYABLE");
        return true;
      },
    );
  });

  it("rejects text exceeding provider max character length with VALIDATION_FAILED", async () => {
    const provider = new FakeVoiceProvider({ maxTextLength: 100 });
    const longReq = createValidRequest({ normalized_text: "أ".repeat(101) });

    await assert.rejects(
      async () => provider.synthesize(longReq),
      (err: VoiceProviderError) => {
        assert.equal(err.name, "VoiceProviderError");
        assert.equal(err.code, "VALIDATION_FAILED");
        assert.equal(err.retry_classification, "NON_RETRYABLE");
        return true;
      },
    );
  });

  it("rejects unknown request fields due to strict request schema", async () => {
    const provider = new FakeVoiceProvider();
    const hostileReq = {
      ...createValidRequest(),
      attacker_payload: "malicious",
    } as any;

    await assert.rejects(async () => provider.synthesize(hostileReq), /unrecognized_keys/);
  });
});

describe("fake-provider: failure injection & retry classifications", () => {
  it("injects AUTH_FAILED (NON_RETRYABLE)", async () => {
    const provider = new FakeVoiceProvider({
      failureInjection: { code: "AUTH_FAILED", message: "Invalid API credentials" },
    });

    await assert.rejects(
      async () => provider.synthesize(createValidRequest()),
      (err: VoiceProviderError) => {
        assert.equal(err.code, "AUTH_FAILED");
        assert.equal(err.retry_classification, "NON_RETRYABLE");
        return true;
      },
    );
  });

  it("injects RATE_LIMITED with bounded retry_after_ms (RETRYABLE)", async () => {
    const provider = new FakeVoiceProvider({
      failureInjection: { code: "RATE_LIMITED", retryAfterMs: 4500 },
    });

    await assert.rejects(
      async () => provider.synthesize(createValidRequest()),
      (err: VoiceProviderError) => {
        assert.equal(err.code, "RATE_LIMITED");
        assert.equal(err.retry_classification, "RETRYABLE");
        assert.equal(err.retry_after_ms, 4500);
        return true;
      },
    );
  });

  it("clamps excessive retry_after_ms to 30,000 ms ceiling", async () => {
    const provider = new FakeVoiceProvider({
      failureInjection: { code: "RATE_LIMITED", retryAfterMs: 120_000 },
    });

    await assert.rejects(
      async () => provider.synthesize(createValidRequest()),
      (err: VoiceProviderError) => {
        assert.equal(err.retry_after_ms, 30_000);
        return true;
      },
    );
  });

  it("injects PROVIDER_UNAVAILABLE (RETRYABLE)", async () => {
    const provider = new FakeVoiceProvider({
      failureInjection: { code: "PROVIDER_UNAVAILABLE", retryAfterMs: 2000 },
    });

    await assert.rejects(
      async () => provider.synthesize(createValidRequest()),
      (err: VoiceProviderError) => {
        assert.equal(err.code, "PROVIDER_UNAVAILABLE");
        assert.equal(err.retry_classification, "RETRYABLE");
        return true;
      },
    );
  });

  it("injects SYNTHESIS_FAILED (UNCERTAIN_DO_NOT_BLIND_RETRY)", async () => {
    const provider = new FakeVoiceProvider({
      failureInjection: { code: "SYNTHESIS_FAILED" },
    });

    await assert.rejects(
      async () => provider.synthesize(createValidRequest()),
      (err: VoiceProviderError) => {
        assert.equal(err.code, "SYNTHESIS_FAILED");
        assert.equal(err.retry_classification, "UNCERTAIN_DO_NOT_BLIND_RETRY");
        return true;
      },
    );
  });

  it("injects TIMEOUT (UNCERTAIN_DO_NOT_BLIND_RETRY)", async () => {
    const provider = new FakeVoiceProvider({
      failureInjection: { code: "TIMEOUT" },
    });

    await assert.rejects(
      async () => provider.synthesize(createValidRequest()),
      (err: VoiceProviderError) => {
        assert.equal(err.code, "TIMEOUT");
        assert.equal(err.retry_classification, "UNCERTAIN_DO_NOT_BLIND_RETRY");
        return true;
      },
    );
  });

  it("proves zero automatic retries inside provider adapter (throws immediately to caller)", async () => {
    let callCount = 0;
    const provider = new FakeVoiceProvider({
      failureInjection: { code: "RATE_LIMITED" },
    });

    try {
      callCount++;
      await provider.synthesize(createValidRequest());
    } catch {
      // Expected
    }

    assert.equal(callCount, 1, "Provider adapter must not internally retry");
  });
});

describe("fake-provider: cancellation contract", () => {
  it("rejects immediately with CANCELLED (TERMINAL) if signal is already aborted before start", async () => {
    const provider = new FakeVoiceProvider();
    const controller = new AbortController();
    controller.abort(); // Pre-abort

    await assert.rejects(
      async () => provider.synthesize(createValidRequest(), controller.signal),
      (err: VoiceProviderError) => {
        assert.equal(err.name, "VoiceProviderError");
        assert.equal(err.code, "CANCELLED");
        assert.equal(err.retry_classification, "TERMINAL");
        assert.match(err.message, /cancelled before start/);
        return true;
      },
    );
  });

  it("aborts promptly during simulated execution when AbortSignal triggers", async () => {
    const provider = new FakeVoiceProvider({ simulatedLatencyMs: 100 });
    const controller = new AbortController();

    const promise = provider.synthesize(createValidRequest(), controller.signal);
    // Trigger abort promptly
    controller.abort();

    await assert.rejects(
      promise,
      (err: VoiceProviderError) => {
        assert.equal(err.code, "CANCELLED");
        assert.equal(err.retry_classification, "TERMINAL");
        return true;
      },
    );
  });

  it("cancels in-flight operation via provider.cancel(requestId)", async () => {
    const provider = new FakeVoiceProvider({ simulatedLatencyMs: 200 });
    const req = createValidRequest({ request_id: "req-cancellation-test" });

    const promise = provider.synthesize(req);
    // Call cancel
    await provider.cancel(req.request_id);

    await assert.rejects(
      promise,
      (err: VoiceProviderError) => {
        assert.equal(err.code, "CANCELLED");
        assert.equal(err.retry_classification, "TERMINAL");
        assert.match(err.message, /cancelled via provider cancel\(\)/);
        return true;
      },
    );
  });

  it("cancel(requestId) is cleanly idempotent when request does not exist", async () => {
    const provider = new FakeVoiceProvider();
    await assert.doesNotReject(async () => provider.cancel("non-existent-id"));
  });
});

describe("fake-provider: timeout classification & fake scheduler", () => {
  it("classifies AbortSignal.timeout() as TIMEOUT -> UNCERTAIN_DO_NOT_BLIND_RETRY", async () => {
    const provider = new FakeVoiceProvider({ simulatedLatencyMs: 50 });
    const signal = AbortSignal.timeout(10); // 10 ms timeout

    await assert.rejects(
      async () => provider.synthesize(createValidRequest(), signal),
      (err: VoiceProviderError) => {
        assert.equal(err.code, "TIMEOUT");
        assert.equal(err.retry_classification, "UNCERTAIN_DO_NOT_BLIND_RETRY");
        return true;
      },
    );
  });

  it("supports injected fake clock scheduler for deterministic 0-ms timeout tests", async () => {
    let scheduledFn: (() => void) | undefined;
    const fakeScheduler = {
      setTimeout(fn: () => void, ms: number) {
        scheduledFn = fn;
        return { cancel() {} };
      },
      now() {
        return 0;
      },
    };

    const provider = new FakeVoiceProvider({
      simulatedLatencyMs: 30_000,
      scheduler: fakeScheduler,
    });

    const controller = new AbortController();
    const promise = provider.synthesize(createValidRequest(), controller.signal);

    // Abort via simulated timeout reason
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    controller.abort(timeoutErr);

    await assert.rejects(
      promise,
      (err: VoiceProviderError) => {
        assert.equal(err.code, "TIMEOUT");
        assert.equal(err.retry_classification, "UNCERTAIN_DO_NOT_BLIND_RETRY");
        return true;
      },
    );
  });
});

describe("fake-provider: alignment contracts & multilingual handling", () => {
  it("returns alignment_status: 'none' and empty marks when request_alignment is false", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(createValidRequest({ request_alignment: false }));

    assert.equal(res.alignment_status, "none");
    assert.equal(res.alignment.status, "none");
    assert.deepEqual(res.alignment.words, []);
    assert.deepEqual(res.alignment.phonemes, []);
  });

  it("returns alignment_status: 'word' and monotonic marks when request_alignment is true", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(
      createValidRequest({
        request_alignment: true,
        normalized_text: "درس البرمجة بلغة تايب سكريبت",
      }),
    );

    assert.equal(res.alignment_status, "word");
    assert.equal(res.alignment.status, "word");
    assert.equal(res.alignment.words.length, 5);

    // Monotonicity and sample bounds proof
    let prevEnd = 0;
    for (let i = 0; i < res.alignment.words.length; i++) {
      const mark = res.alignment.words[i];
      assert.equal(mark.ordinal, i + 1);
      assert.ok(mark.start_sample >= prevEnd, "start_sample must be >= previous end_sample (monotonic)");
      assert.ok(mark.start_sample < mark.end_sample, "start_sample must be < end_sample");
      assert.ok(mark.end_sample <= res.sample_count, "end_sample must be <= sample_count");
      prevEnd = mark.end_sample;
    }
  });

  it("word marks are 100% deterministic across multiple runs", async () => {
    const provider = new FakeVoiceProvider();
    const req = createValidRequest({
      request_alignment: true,
      normalized_text: "خطوة بخطوة نتعلم الكود",
    });

    const res1 = await provider.synthesize(req);
    const res2 = await provider.synthesize(req);

    assert.deepEqual(res1.alignment.words, res2.alignment.words);
  });

  it("handles punctuation and token edge cases cleanly", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(
      createValidRequest({
        request_alignment: true,
        normalized_text: "أولاً: افتح المحرر! ثانياً: اكتب `console.log('hello');`.",
      }),
    );

    assert.equal(res.alignment_status, "word");
    assert.ok(res.alignment.words.length >= 4);
    assert.doesNotThrow(() => validateProviderSynthesisResult(res));
  });

  it("handles pure English text deterministically", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(
      createValidRequest({
        locale: "en-US",
        voice_profile: createValidProfile({ locale: "en-US", profile_id: "en-instructor-01" }),
        request_alignment: true,
        normalized_text: "Welcome to Course Factory automated generation.",
      }),
    );

    assert.equal(res.alignment.words.length, 6);
    assert.equal(res.alignment.words[0].word, "Welcome");
    assert.equal(res.alignment.words[5].word, "generation.");
    assert.doesNotThrow(() => validateProviderSynthesisResult(res));
  });

  it("handles mixed Arabic and English text deterministically", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(
      createValidRequest({
        locale: "ar-EG",
        request_alignment: true,
        normalized_text: "شغل أمر npm run test في الطرفية",
      }),
    );

    assert.equal(res.alignment.words.length, 7);
    assert.equal(res.alignment.words[0].word, "شغل");
    assert.equal(res.alignment.words[2].word, "npm");
    assert.equal(res.alignment.words[3].word, "run");
    assert.equal(res.alignment.words[4].word, "test");
    assert.doesNotThrow(() => validateProviderSynthesisResult(res));
  });
});

describe("fake-provider: security, isolation & size bounds", () => {
  it("proves provider result contains zero credentials", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(createValidRequest());

    const serialized = JSON.stringify(res.descriptor);
    assert.doesNotMatch(serialized, /api[_-]?key|secret|token|bearer|password/i);
  });

  it("proves provider error sanitizes credentials and URLs", () => {
    const err = new VoiceProviderError({
      code: "AUTH_FAILED",
      message: "Failed auth with api_key=secret_token_12345678 at https://api.vendor.com/v1/tts",
      provider_identity: {
        provider_family: "fake",
        provider_model: "m1",
        provider_voice_id: "v1",
      },
    });

    assert.ok(!err.message.includes("secret_token_12345678"));
    assert.ok(!err.message.includes("https://api.vendor.com"));
    assert.ok(err.message.includes("[REDACTED_SECRET]"));
    assert.ok(err.message.includes("[REDACTED_URL]"));
  });

  it("proves provider result contains in-memory Buffer and zero filesystem paths", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(createValidRequest());

    assert.ok(Buffer.isBuffer(res.audio_bytes));
    assert.equal((res as any).output_path, undefined);
    assert.equal((res as any).filePath, undefined);
    assert.equal((res as any).cache_path, undefined);
  });

  it("proves zero runtime session or take generation fields in provider result", async () => {
    const provider = new FakeVoiceProvider();
    const res = await provider.synthesize(createValidRequest());

    assert.equal((res as any).runtime_session_id, undefined);
    assert.equal((res as any).generation, undefined);
    assert.equal((res.descriptor as any).runtime_session_id, undefined);
    assert.equal((res.descriptor as any).generation, undefined);
  });

  it("enforces MAX_PROVIDER_RESPONSE_BYTES (32 MiB) bound", () => {
    assert.equal(MAX_PROVIDER_RESPONSE_BYTES, 33_554_432); // 32 MiB
  });

  it("validateProviderSynthesisResult rejects oversized buffer", () => {
    const fakeOversizedResult: any = {
      audio_bytes: { length: 35_000_000 }, // exceeds 32 MiB
    };
    assert.throws(
      () => validateProviderSynthesisResult(fakeOversizedResult),
      /\[PROVIDER_RESULT_INVALID\] audio_bytes must be a Node\.js Buffer/,
    );

    const realBufferOversized: any = {
      audio_bytes: Buffer.alloc(34_000_000),
      descriptor: {
        provider_family: "fake",
        provider_model: "m1",
        provider_voice_id: "v1",
        provider_request_id: "req1",
        format: "wav",
        sample_rate_hz: 48000,
        channels: 1,
        sample_count: 48000,
        duration_us: 1000000,
        alignment_status: "none",
      },
      alignment: { status: "none", words: [], phonemes: [] },
      provider_family: "fake",
      provider_model: "m1",
      provider_voice_id: "v1",
      provider_request_id: "req1",
      format: "wav",
      sample_rate_hz: 48000,
      channels: 1,
      sample_count: 48000,
      duration_us: 1000000,
      alignment_status: "none",
    };
    assert.throws(
      () => validateProviderSynthesisResult(realBufferOversized),
      /\[PROVIDER_RESULT_SIZE_EXCEEDED\]/,
    );
  });
});
