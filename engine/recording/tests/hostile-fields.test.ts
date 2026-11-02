// P9.1 hostile-field matrix: every renderer/attacker-controlled key must
// fail against every safe public schema. Fail closed by construction.
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 18, 24 (T1-T3, T11).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EncoderDescriptorSchema } from "../src/encoder-profile.ts";
import {
  RecordingManifestSchema,
  buildCanonicalManifest,
} from "../src/manifest.ts";
import {
  InternalRecordingStartDescriptorSchema,
  RecordingErrorDtoSchema,
  RecordingSnapshotDtoSchema,
} from "../src/protocol.ts";
import { RecordingTimelineAnchorSchema } from "../src/timeline.ts";
import { makeAnchor, makeManifestSeed } from "./fixtures.ts";

const HOSTILE_ENTRIES: [string, unknown][] = [
  ["path", "E:\\course-factory\\temp\\x"],
  ["outputPath", "E:\\renders\\evil.mp4"],
  ["ffmpegArgs", ["-y", "-f", "rawvideo"]],
  ["ffmpegPath", "E:\\ffmpeg\\ffmpeg.exe"],
  ["command", "npm run evil"],
  ["code", "console.log('x')"],
  ["source", "file bytes here"],
  ["selector", "#username"],
  ["fill", "secret-value"],
  ["key", "Enter"],
  ["url", "http://127.0.0.1:3000/?token=secret"],
  ["hostPort", 3000],
  ["guestPort", 3000],
  ["bindAddress", "127.0.0.1"],
  ["hwnd", 131072],
  ["pid", 4242],
  ["containerId", "abc123"],
  ["profilePath", "E:\\profiles\\x"],
  ["cookie", "session=abc"],
  ["authorization", "Bearer secret"],
  ["headers", { "x-evil": "1" }],
  ["executablePath", "/usr/bin/ffmpeg"],
  ["args", ["--no-sandbox"]],
  ["shell", true],
  ["env", { SECRET: "1" }],
  ["cwd", "E:\\x"],
  ["windowTitle", "Passwords - Notepad"],
];

function bases(): { name: string; value: Record<string, unknown> }[] {
  return [
    { name: "manifest", value: { ...buildCanonicalManifest(makeManifestSeed()) } },
    { name: "anchor", value: { ...makeAnchor() } },
    {
      name: "snapshot",
      value: {
        recording_session_id: "rec-a",
        take_id: "t01",
        state: "RECORDING",
        runtime_session_id: "sess-1",
        generation: 1,
        elapsed_us: 10,
        captured_frames: 1,
        encoded_frames: 1,
        dropped_frames: 0,
        filler_frames: 0,
        encoder_family: "NVENC",
        record_safe: true,
        last_outcome: null,
      },
    },
    {
      name: "start-descriptor",
      value: {
        lesson_id: "C01-L001",
        runtime_session_id: "sess-1",
        generation: 1,
        take_id: "t01",
        recording_profile_id: "rec-1080p30-h264-v1",
        record_safe: true,
      },
    },
    {
      name: "error-dto",
      value: { code: "ENCODER_FAILED", message: "x", retry: "NOT_RETRYABLE" },
    },
    {
      name: "encoder-descriptor",
      value: {
        family: "NVENC",
        profile: "nvenc-p4-cq23",
        profile_version: "1.0",
        fallback_used: false,
        encoder_version: "8.1.1",
      },
    },
  ];
}

const SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean } }> = {
  manifest: RecordingManifestSchema,
  anchor: RecordingTimelineAnchorSchema,
  snapshot: RecordingSnapshotDtoSchema,
  "start-descriptor": InternalRecordingStartDescriptorSchema,
  "error-dto": RecordingErrorDtoSchema,
  "encoder-descriptor": EncoderDescriptorSchema,
};

describe("P9.1: hostile fields fail every safe public schema", () => {
  for (const [key, hostileValue] of HOSTILE_ENTRIES) {
    it(`hostile key '${key}' is rejected by all public schemas`, () => {
      for (const base of bases()) {
        const candidate = { ...base.value, [key]: hostileValue };
        const schema = SCHEMAS[base.name]!;
        assert.equal(
          schema.safeParse(candidate).success,
          false,
          `${base.name} accepted hostile key '${key}'`,
        );
      }
    });
  }

  it("dynamic port fields are impossible (all port spellings rejected)", () => {
    const manifest = { ...buildCanonicalManifest(makeManifestSeed()) };
    for (const key of ["port", "hostPort", "guestPort", "bridgePort", "dynamicPort"]) {
      assert.ok(
        !RecordingManifestSchema.safeParse({ ...manifest, [key]: 3000 }).success,
        key,
      );
    }
  });

  it("process/handle identity fields are impossible", () => {
    const anchor = { ...makeAnchor() };
    for (const key of ["hwnd", "pid", "handle", "qpc", "qpcTicks", "containerId"]) {
      assert.ok(
        !RecordingTimelineAnchorSchema.safeParse({ ...anchor, [key]: 1 }).success,
        key,
      );
    }
  });
});
