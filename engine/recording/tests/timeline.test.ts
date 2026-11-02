// Tests for P9.1 timeline anchors: schema, ordering invariants,
// generation fencing, stale rejection, frame sequence, drop accounting,
// frame-interval contract, JSONL sidecar bounds.
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 8-9, 14, 19.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_INTERVAL_US,
  FRAME_SEQ_INITIAL,
  FrameCounters10Schema,
  FrameCounters11Schema,
  FrameCountersSchema,
  FrameSeqSchema,
  MAX_ANCHOR_LINE_BYTES,
  MAX_SIDECAR_BYTES,
  RecordingTimelineAnchorSchema,
  checkAnchorBatchOrdering,
  isWithinOneFrameInterval,
  parseAnchorLine,
  serializeAnchorLine,
  validateSidecarText,
} from "../src/timeline.ts";
import { VALID_TAKE_FENCE, makeAnchor } from "./fixtures.ts";

describe("P9.1: valid timeline anchor", () => {
  it("accepts a canonical anchor", () => {
    assert.ok(RecordingTimelineAnchorSchema.safeParse(makeAnchor()).success);
  });

  it("rejects anchors with unknown fields (fail closed)", () => {
    const hostile = { ...makeAnchor(), hwnd: 12345, pid: 999 };
    assert.ok(!RecordingTimelineAnchorSchema.safeParse(hostile).success);
  });

  it("rejects stale-generation anchors via fence check", () => {
    const batch = checkAnchorBatchOrdering([makeAnchor()], {
      ...VALID_TAKE_FENCE,
      generation: 2,
    });
    assert.equal(batch.ok, false);
    assert.ok(batch.errors.some((e) => e.includes("fence")));
  });

  it("rejects decreasing video_time_us", () => {
    const batch = checkAnchorBatchOrdering([
      makeAnchor({}, 5),
      makeAnchor({}, 2),
    ]);
    assert.equal(batch.ok, false);
    assert.ok(batch.errors.some((e) => e.includes("video_time_us")));
  });

  it("rejects decreasing global_seq", () => {
    const a = makeAnchor({ video_time_us: 100_000, global_seq: 20 });
    const b = makeAnchor({ video_time_us: 200_000, global_seq: 15 });
    const batch = checkAnchorBatchOrdering([a, b]);
    assert.equal(batch.ok, false);
    assert.ok(batch.errors.some((e) => e.includes("global_seq")));
  });

  it("rejects duplicate anchors", () => {
    const batch = checkAnchorBatchOrdering([makeAnchor(), makeAnchor()]);
    assert.equal(batch.ok, false);
    assert.ok(batch.errors.some((e) => e.includes("duplicate")));
  });

  it("rejects generation change within one take", () => {
    const batch = checkAnchorBatchOrdering([
      makeAnchor(),
      makeAnchor({ generation: 2, global_seq: 11, video_time_us: 40_000 }),
    ]);
    assert.equal(batch.ok, false);
    assert.ok(batch.errors.some((e) => e.includes("generation")));
  });

  it("rejects runtime_session change within one take", () => {
    const batch = checkAnchorBatchOrdering([
      makeAnchor(),
      makeAnchor({
        runtime_session_id: "sess-runtime-002",
        global_seq: 11,
        video_time_us: 40_000,
      }),
    ]);
    assert.equal(batch.ok, false);
    assert.ok(batch.errors.some((e) => e.includes("runtime_session_id")));
  });

  it("accepts equal video_time_us with increasing global_seq (same tick)", () => {
    const a = makeAnchor({ video_time_us: 100_000, global_seq: 20 });
    const b = makeAnchor({ video_time_us: 100_000, global_seq: 21 });
    const batch = checkAnchorBatchOrdering([a, b]);
    assert.equal(batch.ok, true);
  });

  it("reports invalid anchor records instead of throwing", () => {
    const batch = checkAnchorBatchOrdering([{ nope: true }]);
    assert.equal(batch.ok, false);
    assert.equal(batch.anchor_count, 0);
  });
});

describe("P9.1: JSONL sidecar contract", () => {
  it("round-trips a valid JSONL record", () => {
    const line = serializeAnchorLine(makeAnchor());
    assert.ok(line.endsWith("\n"));
    assert.ok(!line.includes("\r"));
    assert.deepEqual(parseAnchorLine(line), makeAnchor());
  });

  it("each line is independently valid with deterministic field order", () => {
    const a = serializeAnchorLine(makeAnchor());
    const b = serializeAnchorLine(makeAnchor());
    assert.equal(a, b);
    const keys = Object.keys(JSON.parse(a));
    assert.deepEqual([...keys], [...keys].sort());
  });

  it("rejects unknown JSONL fields", () => {
    const raw = `${JSON.stringify({ ...makeAnchor(), command: "x" })}\n`;
    assert.throws(() => parseAnchorLine(raw));
  });

  it("rejects BOM, CRLF, blank lines", () => {
    const line = serializeAnchorLine(makeAnchor());
    assert.throws(() => parseAnchorLine(`\uFEFF${line}`), /BOM/);
    assert.throws(() => parseAnchorLine(line.replace("\n", "\r\n")), /LF/);
    assert.throws(() => parseAnchorLine("\n"), /blank/i);
  });

  it("enforces the per-line size bound", () => {
    assert.equal(MAX_ANCHOR_LINE_BYTES, 4_096);
    const huge = "x".repeat(MAX_ANCHOR_LINE_BYTES + 1);
    assert.throws(() => parseAnchorLine(`${huge}\n`), /TOO_LARGE/);
  });

  it("validates whole sidecar text with ordering", () => {
    const text = serializeAnchorLine(makeAnchor({}, 1)) + serializeAnchorLine(makeAnchor({}, 2));
    const check = validateSidecarText(text, VALID_TAKE_FENCE);
    assert.equal(check.ok, true);
    assert.equal(check.anchor_count, 2);
    assert.ok(check.bytes > 0 && check.bytes <= MAX_SIDECAR_BYTES);
  });

  it("rejects unordered sidecars and blank lines", () => {
    const badOrder =
      serializeAnchorLine(makeAnchor({}, 5)) + serializeAnchorLine(makeAnchor({}, 2));
    assert.equal(validateSidecarText(badOrder).ok, false);
    const blank = serializeAnchorLine(makeAnchor()) + "\n";
    const blankCheck = validateSidecarText(blank);
    assert.equal(blankCheck.ok, false);
  });

  it("enforces the 5 MiB sidecar ceiling", () => {
    assert.equal(MAX_SIDECAR_BYTES, 5_242_880);
    const over = "y".repeat(MAX_SIDECAR_BYTES + 1);
    const check = validateSidecarText(over);
    assert.equal(check.ok, false);
  });

  it("empty sidecar text is valid with zero anchors", () => {
    const check = validateSidecarText("");
    assert.equal(check.ok, true);
    assert.equal(check.anchor_count, 0);
  });
});

describe("P9.1: frame sequence and drop accounting", () => {
  it("frame_seq starts at 1 and rejects 0/negatives/fractionals", () => {
    assert.equal(FRAME_SEQ_INITIAL, 1);
    assert.equal(FrameSeqSchema.parse(1), 1);
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      assert.ok(!FrameSeqSchema.safeParse(bad).success, String(bad));
    }
  });

  it("frame counters accept bounded counts", () => {
    const good11 = {
      captured_frame_count: 18_000,
      encoded_frame_count: 17_990,
      dropped_frame_count: 10,
      coalesced_frame_count: 120,
      filler_frame_count: 0,
    };
    assert.ok(FrameCountersSchema.safeParse(good11).success);
    assert.ok(FrameCounters11Schema.safeParse(good11).success);
    const good10 = {
      captured_frame_count: 18_000,
      encoded_frame_count: 17_990,
      dropped_frame_count: 10,
      coalesced_frame_count: 120,
    };
    assert.ok(FrameCounters10Schema.safeParse(good10).success);
  });

  it("frame counters enforce accounting bounds", () => {
    const base = {
      captured_frame_count: 100,
      encoded_frame_count: 100,
      dropped_frame_count: 0,
      coalesced_frame_count: 0,
      filler_frame_count: 0,
    };
    // (I4) encoded <= captured + filler
    assert.ok(
      !FrameCountersSchema.safeParse({ ...base, encoded_frame_count: 101 }).success,
    );
    // Negative captured rejected
    assert.ok(
      !FrameCountersSchema.safeParse({ ...base, captured_frame_count: -1 }).success,
    );
    // Over-max rejected
    assert.ok(
      !FrameCountersSchema.safeParse({
        ...base,
        encoded_frame_count: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    );
    // (I1) filler <= encoded
    assert.ok(
      !FrameCountersSchema.safeParse({ ...base, filler_frame_count: 101 }).success,
    );
    // (I2) coalesced <= encoded
    assert.ok(
      !FrameCountersSchema.safeParse({ ...base, coalesced_frame_count: 101 }).success,
    );
    // (I3) coalesced + filler <= encoded
    assert.ok(
      !FrameCountersSchema.safeParse({ ...base, coalesced_frame_count: 60, filler_frame_count: 50 }).success,
    );
    // (I5) dropped + encoded >= captured + filler
    assert.ok(
      !FrameCountersSchema.safeParse({ ...base, encoded_frame_count: 90, dropped_frame_count: 5 }).success,
    );
    // (I6) coalesced <= captured
    assert.ok(
      !FrameCountersSchema.safeParse({ ...base, coalesced_frame_count: 101, captured_frame_count: 50, encoded_frame_count: 150, filler_frame_count: 100 }).success,
    );
    // Missing filler_frame_count in 1.1 rejected
    const { filler_frame_count: _drop, ...missingFiller } = base;
    void _drop;
    assert.ok(!FrameCountersSchema.safeParse(missingFiller).success);
    // 1.0 schema rejects filler_frame_count
    assert.ok(!FrameCounters10Schema.safeParse(base).success);
  });

  it("r3-equivalent sparse counters validate under 1.1", () => {
    const r3Golden = {
      captured_frame_count: 4,
      encoded_frame_count: 145,
      dropped_frame_count: 0,
      coalesced_frame_count: 0,
      filler_frame_count: 141,
    };
    assert.ok(FrameCountersSchema.safeParse(r3Golden).success);
  });

  it("old false sparse r3 shape is rejected under 1.1", () => {
    const oldFalse = {
      captured_frame_count: 4,
      encoded_frame_count: 4,
      dropped_frame_count: 0,
      coalesced_frame_count: 0,
      filler_frame_count: 141,
    };
    assert.ok(!FrameCountersSchema.safeParse(oldFalse).success);
  });

  it("one-frame-interval contract equals ceil(1e6/30)", () => {
    assert.equal(FRAME_INTERVAL_US, 33_334);
    assert.equal(isWithinOneFrameInterval(0), true);
    assert.equal(isWithinOneFrameInterval(33_334), true);
    assert.equal(isWithinOneFrameInterval(33_335), false);
    assert.equal(isWithinOneFrameInterval(-1), false);
  });
});
