// P9.4 anchor writer sink & manifest summary — deterministic, zero sleeps.
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 12, 15, 19 and P9.1
// timeline.ts / manifest.ts contracts. Proves atomic line appends, the
// 4 KiB / 5 MiB sidecar bounds held continuously, deterministic lines, and
// the exact P9.1 AnchorSummary shape for future manifest finalization.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ANCHOR_LINE_BYTES,
  MAX_SIDECAR_BYTES,
  serializeAnchorLine,
} from "../src/timeline.ts";
import {
  BoundedAnchorWriter,
  buildAnchorSummary,
} from "../src/timeline-writer.ts";
import { makeAnchor } from "./fixtures.ts";

describe("P9.4: anchor line deterministic", () => {
  it("anchor line deterministic", () => {
    const a = serializeAnchorLine(makeAnchor());
    const b = serializeAnchorLine(makeAnchor());
    assert.equal(a, b);
    assert.ok(a.endsWith("\n"));
  });

  it("line <=4KiB", () => {
    assert.equal(MAX_ANCHOR_LINE_BYTES, 4_096);
    const line = serializeAnchorLine(makeAnchor());
    assert.ok(Buffer.byteLength(line, "utf8") <= MAX_ANCHOR_LINE_BYTES);
  });
});

describe("P9.4: bounded writer enforces sidecar bounds continuously", () => {
  it("sidecar <=5MiB", () => {
    assert.equal(MAX_SIDECAR_BYTES, 5_242_880);
    const writer = new BoundedAnchorWriter();
    writer.append(makeAnchor());
    assert.equal(writer.anchorCount, 1);
    assert.ok(writer.totalBytes <= MAX_SIDECAR_BYTES);
  });

  it("total overflow rejected", () => {
    const writer = new BoundedAnchorWriter();
    let appended = 0;
    let overflowed = false;
    for (let i = 0; i < 100_000; i += 1) {
      try {
        writer.append(makeAnchor({ global_seq: 1000 + i, video_time_us: Math.min(i * 1_000, 1_800_000_000) }));
        appended += 1;
      } catch {
        overflowed = true;
        break;
      }
    }
    assert.ok(appended > 100);
    assert.equal(overflowed, true);
    assert.ok(writer.totalBytes <= MAX_SIDECAR_BYTES);
  });

  it("atomic append never leaves a partially valid line", () => {
    const writer = new BoundedAnchorWriter();
    writer.append(makeAnchor());
    const before = writer.sidecarText();
    assert.throws(() => writer.append({ ...makeAnchor(), video_time_us: -1 as never }));
    assert.equal(writer.sidecarText(), before);
    assert.equal(writer.anchorCount, 1);
  });
});

describe("P9.4: manifest timeline summary uses the exact P9.1 contract", () => {
  it("manifest timeline summary", () => {
    const writer = new BoundedAnchorWriter();
    const a1 = makeAnchor({ global_seq: 11, video_time_us: 0 });
    const a2 = makeAnchor({ global_seq: 12, video_time_us: 33_334 });
    const a3 = makeAnchor({ global_seq: 15, video_time_us: 66_668 });
    writer.append(a1);
    writer.append(a2);
    writer.append(a3);
    const summary = buildAnchorSummary([a1, a2, a3], writer.sidecarText());
    assert.equal(summary.anchor_count, 3);
    assert.equal(summary.journal_high_seq_start, 11);
    assert.equal(summary.journal_high_seq_end, 15);
    assert.equal(summary.first_video_time_us, 0);
    assert.equal(summary.last_video_time_us, 66_668);
    assert.match(summary.anchors_sha256, /^[0-9a-f]{64}$/);
  });

  it("first/last seq correct and first/last video time correct", () => {
    const writer = new BoundedAnchorWriter();
    const anchors = [1, 2, 3, 4, 5].map((i) =>
      makeAnchor({ global_seq: 100 + i, video_time_us: (i - 1) * 33_334 }),
    );
    for (const a of anchors) {
      writer.append(a);
    }
    const summary = buildAnchorSummary(anchors, writer.sidecarText());
    assert.equal(summary.journal_high_seq_start, 101);
    assert.equal(summary.journal_high_seq_end, 105);
    assert.equal(summary.first_video_time_us, 0);
    assert.equal(summary.last_video_time_us, 4 * 33_334);
  });

  it("empty anchor list yields the canonical zero summary", () => {
    const writer = new BoundedAnchorWriter();
    const summary = buildAnchorSummary([], writer.sidecarText());
    assert.equal(summary.anchor_count, 0);
    assert.equal(summary.first_video_time_us, 0);
    assert.equal(summary.last_video_time_us, 0);
    assert.equal(summary.journal_high_seq_start, 0);
    assert.equal(summary.journal_high_seq_end, 0);
  });
});
