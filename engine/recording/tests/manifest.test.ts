// Tests for P9.1 RecordingManifest 1.0: versions, published manifest,
// cross-field publication invariants, purge/quarantine rules, size bound,
// canonical serialization, digest convention, privacy allowlist.
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 15, 20-22.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AnyRecordingManifestSchema,
  HISTORICAL_RECORDING_MANIFEST_VERSION_1_0,
  MAX_MANIFEST_BYTES,
  RECORDING_MANIFEST_VERSION,
  RecordingManifest10Schema,
  RecordingManifest11Schema,
  RecordingManifestSchema,
  buildCanonicalManifest,
  canonicalManifestJson,
  manifestByteSize,
  parseCurrentRecordingManifest,
  parseRecordingManifest,
  parseRecordingManifestJson,
} from "../src/manifest.ts";
import { RECORDING_PROTOCOL_VERSION } from "../src/protocol.ts";
import { makeManifestSeed } from "./fixtures.ts";

describe("P9.1: manifest and protocol versions are frozen", () => {
  it("manifest current version is exactly 1.1", () => {
    assert.equal(RECORDING_MANIFEST_VERSION, "1.1");
    assert.equal(HISTORICAL_RECORDING_MANIFEST_VERSION_1_0, "1.0");
  });

  it("manifest references Recording Protocol v1 (not the P8 protocol)", () => {
    assert.equal(RECORDING_PROTOCOL_VERSION, 1);
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.equal(manifest.recording_protocol_version, 1);
    assert.equal(manifest.manifest_version, "1.1");
  });
});

describe("P9.1: valid published manifest", () => {
  it("accepts a canonical published manifest", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.ok(RecordingManifestSchema.safeParse(manifest).success);
  });

  it("published without digest is rejected", () => {
    const seed = makeManifestSeed({ media_sha256: null });
    assert.throws(() => buildCanonicalManifest(seed), /media_sha256|digest/i);
  });

  it("published with zero frames is rejected", () => {
    const seed = makeManifestSeed({
      frames: {
        captured_frame_count: 0,
        encoded_frame_count: 0,
        dropped_frame_count: 0,
        coalesced_frame_count: 0,
        filler_frame_count: 0,
      },
      recording_start_us: 0,
      recording_end_us: 0,
    });
    assert.throws(() => buildCanonicalManifest(seed));
  });

  it("cancelled + published is rejected", () => {
    const seed = makeManifestSeed({
      publication_status: "PUBLISHED",
      outcome: "CANCELLED",
      terminal_cause: "OPERATOR_CANCELLED",
    });
    assert.throws(() => buildCanonicalManifest(seed));
  });

  it("reset-interrupted + published is rejected", () => {
    const seed = makeManifestSeed({
      publication_status: "PUBLISHED",
      outcome: "RESET_INTERRUPTED",
      terminal_cause: "RESET_INTERRUPTED",
    });
    assert.throws(() => buildCanonicalManifest(seed));
  });

  it("capture-source-lost + published is rejected", () => {
    const seed = makeManifestSeed({
      publication_status: "PUBLISHED",
      outcome: "FAILED",
      terminal_cause: "CAPTURE_SOURCE_LOST",
    });
    assert.throws(() => buildCanonicalManifest(seed));
  });

  it("low-disk + published is rejected", () => {
    const seed = makeManifestSeed({
      publication_status: "PUBLISHED",
      outcome: "INCOMPLETE",
      terminal_cause: "LOW_DISK_ABORT",
    });
    assert.throws(() => buildCanonicalManifest(seed));
  });

  it("failed outcome cannot claim validation PASS", () => {
    const seed = makeManifestSeed({
      publication_status: "QUARANTINED",
      outcome: "FAILED",
      terminal_cause: "DIAGNOSTIC_PARTIAL",
      media_validation: {
        verdict: "FAIL",
        checks: [{ check: "container_readable", passed: false }],
      },
    });
    assert.ok(RecordingManifestSchema.safeParse(buildCanonicalManifest(seed)).success);
    const bad = makeManifestSeed({
      publication_status: "TEMPORARY",
      outcome: "FAILED",
      terminal_cause: "ENCODER_FAILED",
      media_validation: {
        verdict: "PASS",
        checks: [{ check: "container_readable", passed: true }],
      },
    });
    assert.throws(() => buildCanonicalManifest(bad));
  });

  it("accepts a quarantined diagnostic partial", () => {
    const seed = makeManifestSeed({
      publication_status: "QUARANTINED",
      outcome: "FAILED",
      terminal_cause: "DIAGNOSTIC_PARTIAL",
      media_sha256: "c".repeat(64),
      media_size_bytes: 12_000_000,
      media_validation: {
        verdict: "FAIL",
        checks: [{ check: "container_readable", passed: false }],
      },
    });
    assert.ok(RecordingManifestSchema.safeParse(buildCanonicalManifest(seed)).success);
  });

  it("accepts a purged cancelled take with no digest and no bytes", () => {
    const seed = makeManifestSeed({
      publication_status: "PURGED",
      outcome: "CANCELLED",
      terminal_cause: "OPERATOR_CANCELLED",
      media_sha256: null,
      media_size_bytes: 0,
      media_validation: null,
      frames: {
        captured_frame_count: 100,
        encoded_frame_count: 90,
        dropped_frame_count: 10,
        coalesced_frame_count: 0,
        filler_frame_count: 0,
      },
      tail_duration_ms: 0,
    });
    assert.ok(RecordingManifestSchema.safeParse(buildCanonicalManifest(seed)).success);
  });

  it("purged takes claiming a digest are rejected", () => {
    const seed = makeManifestSeed({
      publication_status: "PURGED",
      outcome: "CANCELLED",
      terminal_cause: "OPERATOR_CANCELLED",
      media_size_bytes: 0,
      media_validation: null,
    });
    assert.throws(() => buildCanonicalManifest(seed));
  });

  it("cause/outcome mismatch is rejected", () => {
    const seed = makeManifestSeed({
      outcome: "COMPLETED",
      terminal_cause: "ENCODER_FAILED",
      publication_status: "TEMPORARY",
      media_sha256: null,
      media_validation: null,
    });
    assert.throws(() => buildCanonicalManifest(seed));
  });

  it("duration must equal end - start", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.throws(() =>
      RecordingManifestSchema.parse({ ...manifest, duration_us: 1 }),
    );
  });

  it("record-safe downgrade is impossible", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.throws(() =>
      RecordingManifestSchema.parse({ ...manifest, record_safe: false }),
    );
  });

  it("geometry and fps are fixed to 1920x1080@30", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.throws(() =>
      RecordingManifestSchema.parse({ ...manifest, video_width: 1600 }),
    );
    assert.throws(() =>
      RecordingManifestSchema.parse({ ...manifest, video_fps: 60 }),
    );
  });
});

describe("P9.1: manifest size bound and canonical serialization", () => {
  it("manifest ceiling is 64 KiB", () => {
    assert.equal(MAX_MANIFEST_BYTES, 65_536);
  });

  it("canonical serialization is deterministic (byte-identical)", () => {
    const a = canonicalManifestJson(buildCanonicalManifest(makeManifestSeed()));
    const seed = makeManifestSeed();
    const reordered = buildCanonicalManifest({
      ...seed,
      frames: {
        coalesced_frame_count: seed.frames.coalesced_frame_count,
        dropped_frame_count: seed.frames.dropped_frame_count,
        encoded_frame_count: seed.frames.encoded_frame_count,
        captured_frame_count: seed.frames.captured_frame_count,
        filler_frame_count: seed.frames.filler_frame_count,
      },
    });
    const b = canonicalManifestJson(reordered);
    assert.equal(a, b);
    assert.ok(a.endsWith("\n"));
    assert.ok(!a.includes("\r"));
  });

  it("byte size uses UTF-8 bytes and stays far under the ceiling", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    const bytes = manifestByteSize(manifest);
    assert.equal(bytes, Buffer.byteLength(canonicalManifestJson(manifest), "utf8"));
    assert.ok(bytes < MAX_MANIFEST_BYTES);
  });

  it("manifest over 64 KiB is rejected", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    const bloated = {
      ...manifest,
      app_version: `v${"x".repeat(MAX_MANIFEST_BYTES)}`,
    };
    assert.throws(() => parseRecordingManifest(bloated), /TOO_LARGE|too/i);
  });

  it("JSON string parsing enforces schema and rejects empties", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    const roundTripped = parseRecordingManifestJson(canonicalManifestJson(manifest));
    assert.equal(roundTripped.take_id, "t01");
    assert.throws(() => parseRecordingManifestJson(""), /EMPTY/);
    assert.throws(() => parseRecordingManifestJson("{not json"), /./);
  });
});

describe("P9.1: SHA-256 digest convention", () => {
  it("accepts lowercase hex digests and rejects uppercase", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.ok(
      RecordingManifestSchema.safeParse({
        ...manifest,
        media_sha256: "A".repeat(64),
      }).success === false,
    );
    assert.ok(
      RecordingManifestSchema.safeParse({
        ...manifest,
        media_sha256: "g".repeat(64),
      }).success === false,
    );
  });
});

describe("P9.1: manifest must not include forbidden fields", () => {
  it("commands, selectors, code, paths, argv are structurally rejected", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    for (const hostile of [
      { command: "npm test" },
      { code: "console.log(1)" },
      { selector: "#app" },
      { outputPath: "E:\\out\\x.mp4" },
      { ffmpegArgs: ["-y"] },
      { ffmpegPath: "E:\\ffmpeg.exe" },
      { hwnd: 1234 },
      { pid: 99 },
      { containerId: "abc" },
      { profilePath: "E:\\prof" },
      { hostPort: 3000 },
      { url: "http://127.0.0.1:3000/?token=secret" },
      { cookie: "session=abc" },
      { authorization: "Bearer x" },
      { fill: "secret-value" },
      { source: "file bytes" },
    ]) {
      assert.ok(
        !RecordingManifestSchema.safeParse({ ...manifest, ...hostile }).success,
        Object.keys(hostile)[0]!,
      );
    }
  });

  it("absolute output paths are impossible via schema", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.ok(
      !RecordingManifestSchema.safeParse({
        ...manifest,
        output_path: "E:\\renders\\x.mp4",
      }).success,
    );
  });

  it("unsafe host path in free text is rejected", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.ok(
      !RecordingManifestSchema.safeParse({
        ...manifest,
        app_version: "built at E:\\course-factory",
      }).success,
    );
  });
});

describe("P9.1: manifest 1.1 / 1.0 versioning and backward compatibility", () => {
  it("historical valid Manifest 1.0 parses successfully", () => {
    const manifest11 = buildCanonicalManifest(makeManifestSeed());
    const { filler_frame_count: _f, ...frames10 } = manifest11.frames;
    void _f;
    const manifest10 = {
      ...manifest11,
      manifest_version: "1.0",
      frames: frames10,
    };
    const parsed = parseRecordingManifest(manifest10);
    assert.equal(parsed.manifest_version, "1.0");
    assert.equal("filler_frame_count" in parsed.frames, false);
  });

  it("historical 1.0 schema rejects filler_frame_count (strict fail-closed)", () => {
    const manifest11 = buildCanonicalManifest(makeManifestSeed());
    const manifest10WithFiller = {
      ...manifest11,
      manifest_version: "1.0",
    };
    assert.ok(!RecordingManifest10Schema.safeParse(manifest10WithFiller).success);
  });

  it("current 1.1 schema requires filler_frame_count", () => {
    const manifest11 = buildCanonicalManifest(makeManifestSeed());
    const { filler_frame_count: _f, ...missingFiller } = manifest11.frames;
    void _f;
    const manifest11Missing = {
      ...manifest11,
      frames: missingFiller,
    };
    assert.ok(!RecordingManifest11Schema.safeParse(manifest11Missing).success);
    assert.ok(!RecordingManifestSchema.safeParse(manifest11Missing).success);
  });

  it("builder emits 1.1 only (cannot emit 1.0)", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.equal(manifest.manifest_version, "1.1");
  });

  it("strict parseCurrentRecordingManifest accepts 1.1 and rejects 1.0", () => {
    const manifest11 = buildCanonicalManifest(makeManifestSeed());
    assert.equal(parseCurrentRecordingManifest(manifest11).manifest_version, "1.1");
    const { filler_frame_count: _f, ...frames10 } = manifest11.frames;
    void _f;
    const manifest10 = { ...manifest11, manifest_version: "1.0", frames: frames10 };
    assert.throws(() => parseCurrentRecordingManifest(manifest10));
  });

  it("PUBLISHED take requires captured_frame_count >= 1 (P4)", () => {
    const seed = makeManifestSeed({
      frames: {
        captured_frame_count: 0,
        encoded_frame_count: 10,
        dropped_frame_count: 0,
        coalesced_frame_count: 0,
        filler_frame_count: 10,
      },
    });
    assert.throws(() => buildCanonicalManifest(seed), /captured_frame_count/);
  });
});
