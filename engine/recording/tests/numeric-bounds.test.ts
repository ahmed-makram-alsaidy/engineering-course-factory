// P9.1 numeric bounds: negative / zero / MAX_SAFE_INTEGER vicinity /
// NaN / Infinity / fractional values across microsecond, counter, and
// generation fields. Deterministic; no randomness.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MicrosecondSchema,
  RecordingGenerationSchema,
  TakeIdSchema,
} from "../src/protocol.ts";
import { FrameCountersSchema } from "../src/timeline.ts";

const EDGE_VALUES: unknown[] = [
  -1,
  -9007199254740991,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  "0",
  null,
  undefined,
  {},
  [],
  true,
];

describe("P9.1: numeric edge values fail microsecond fields", () => {
  for (const bad of EDGE_VALUES) {
    it(`microseconds reject ${String(bad)}`, () => {
      assert.equal(MicrosecondSchema.safeParse(bad).success, false);
    });
  }

  it("microseconds accept 0 and MAX_SAFE_INTEGER", () => {
    assert.equal(MicrosecondSchema.safeParse(0).success, true);
    assert.equal(
      MicrosecondSchema.safeParse(Number.MAX_SAFE_INTEGER).success,
      true,
    );
    assert.equal(
      MicrosecondSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success,
      false,
    );
  });
});

describe("P9.1: numeric edge values fail frame counters", () => {
  it("zero counters are valid; edges are rejected per field", () => {
    const zero = {
      captured_frame_count: 0,
      encoded_frame_count: 0,
      dropped_frame_count: 0,
      coalesced_frame_count: 0,
      filler_frame_count: 0,
    };
    assert.equal(FrameCountersSchema.safeParse(zero).success, true);
    for (const field of Object.keys(zero)) {
      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(
          FrameCountersSchema.safeParse({ ...zero, [field]: bad }).success,
          false,
          `${field}=${String(bad)}`,
        );
      }
    }
  });
});

describe("P9.1: generation and take id edges", () => {
  it("generation rejects 0, negatives, fractionals, non-numbers", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, "1", null, {}, []]) {
      assert.equal(RecordingGenerationSchema.safeParse(bad).success, false, String(bad));
    }
    assert.equal(RecordingGenerationSchema.safeParse(1).success, true);
  });

  it("take id rejects single-digit and non-t-prefixed forms", () => {
    for (const bad of ["t1", "t", "01", "take01", "", "t01 "]) {
      assert.equal(TakeIdSchema.safeParse(bad).success, false, bad);
    }
    assert.equal(TakeIdSchema.safeParse("t01").success, true);
    assert.equal(TakeIdSchema.safeParse("t100").success, true);
  });
});
