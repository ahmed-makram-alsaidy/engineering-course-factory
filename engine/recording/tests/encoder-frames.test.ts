// P9.3 frame ingest tests: validation, fencing, PTS, pacing, bounded queue
// (unit matrix 24-34). Deterministic, offline; full-size 1080p BGRA buffers
// are shared across tests (validation never mutates payload bytes).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FakeEncoderSession,
  assertConfinedTempTarget,
} from "../src/encoder/fake-encoder.ts";
import {
  classifyPacing,
  packTightRows,
  ptsForEncodeIndex,
  validateEncoderFrame,
} from "../src/encoder/encoder-frames.ts";
import { generateFixtureFrame } from "../src/encoder/frame-fixture.ts";

const FRAME_BYTES = 1920 * 1080 * 4;
const SHARED_BYTES = new Uint8Array(FRAME_BYTES).fill(0x80);

const FENCE = {
  recording_session_id: "rec-p93-frames-001",
  runtime_session_id: "sess-runtime-001",
  generation: 1,
};
const TAKE_ID = "t01";

function makeFrame(seq: number, overrides: Record<string, unknown> = {}): Record<string, unknown> & { bytes: Uint8Array } {
  return {
    frame_seq: seq,
    capture_timestamp_us: 1_000_000 + seq * 33_334,
    width: 1920,
    height: 1080,
    pixel_format: "bgra8",
    stride_bytes: 1920 * 4,
    recording_session_id: FENCE.recording_session_id,
    take_id: TAKE_ID,
    runtime_session_id: FENCE.runtime_session_id,
    generation: 1,
    bytes: SHARED_BYTES,
    ...overrides,
  };
}

async function makeStartedSession(
  faults?: ConstructorParameters<typeof FakeEncoderSession>[0]["faults"],
  manualDrain?: boolean,
): Promise<FakeEncoderSession> {
  const session = new FakeEncoderSession({ fence: FENCE, takeId: TAKE_ID, faults, manualDrain });
  await session.prepare({
    tempRoot: "E:\\p93",
    recordingSessionId: FENCE.recording_session_id,
    takeId: TAKE_ID,
  });
  await session.start({
    family: "LIBX264",
    profile: "libx264-veryfast-crf21",
    profile_version: "1.0",
    fallback_used: true,
    fallback_reason: "NVENC_ENCODER_MISSING",
    encoder_version: "8.1.1-test",
  });
  return session;
}

describe("P9.3: start once", () => {
  it("prepare then start reaches an accepting session", async () => {
    const session = await makeStartedSession();
    const result = await session.writeFrame(makeFrame(1));
    assert.equal(result.accepted, true);
    await session.close();
  });
});

describe("P9.3: duplicate start deterministic", () => {
  it("second start throws INVALID_REQUEST", async () => {
    const session = await makeStartedSession();
    await assert.rejects(session.start({
      family: "LIBX264",
      profile: "libx264-veryfast-crf21",
      profile_version: "1.0",
      fallback_used: true,
      fallback_reason: "NVENC_ENCODER_MISSING",
      encoder_version: "8.1.1-test",
    }), /INVALID_REQUEST/);
    await session.close();
  });
});

describe("P9.3: write before start rejected", () => {
  it("writeFrame before start returns INVALID_REQUEST", async () => {
    const session = new FakeEncoderSession({ fence: FENCE, takeId: TAKE_ID });
    await session.prepare({
      tempRoot: "E:\\p93",
      recordingSessionId: FENCE.recording_session_id,
      takeId: TAKE_ID,
    });
    const result = await session.writeFrame(makeFrame(1));
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.code, "INVALID_REQUEST");
    }
    await session.close();
  });
});

describe("P9.3: valid frame accepted", () => {
  it("first frame gets encode_seq 1 and pts 0", async () => {
    const session = await makeStartedSession();
    const result = await session.writeFrame(makeFrame(1));
    assert.equal(result.accepted, true);
    if (result.accepted) {
      assert.equal(result.encode_seq, 1);
      assert.equal(result.pts_us, 0);
    }
    await session.close();
  });

  it("pts advances one frame interval per accepted frame", async () => {
    assert.equal(ptsForEncodeIndex(1), 0);
    assert.equal(ptsForEncodeIndex(2), 33_333);
    assert.equal(ptsForEncodeIndex(3), 66_666);
    assert.equal(ptsForEncodeIndex(31), 1_000_000);
    assert.throws(() => ptsForEncodeIndex(0));
  });

  it("pts matches the exact 30/1 rational timeline with zero long-duration drift", async () => {
    assert.equal(ptsForEncodeIndex(30), 966_666);
    assert.equal(ptsForEncodeIndex(301), 10_000_000);
    assert.equal(ptsForEncodeIndex(1_801), 60_000_000);
    assert.equal(ptsForEncodeIndex(54_001), 1_800_000_000);
    assert.notEqual(ptsForEncodeIndex(31), 30 * 33_334);
  });
});

describe("P9.3: wrong session frame rejected", () => {
  it("foreign recording_session_id returns STALE_SESSION", async () => {
    const session = await makeStartedSession();
    const result = await session.writeFrame(
      makeFrame(1, { recording_session_id: "rec-p93-other-999" }),
    );
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.code, "STALE_SESSION");
    }
    await session.close();
  });
});

describe("P9.3: stale generation frame rejected", () => {
  it("old generation returns STALE_GENERATION", async () => {
    const session = await makeStartedSession();
    const result = await session.writeFrame(makeFrame(1, { generation: 7 }));
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.code, "STALE_GENERATION");
    }
    await session.close();
  });
});

describe("P9.3: wrong take rejected", () => {
  it("foreign take_id returns STALE_SESSION", async () => {
    const session = await makeStartedSession();
    const result = await session.writeFrame(makeFrame(1, { take_id: "t02" }));
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.code, "STALE_SESSION");
    }
    await session.close();
  });
});

describe("P9.3: bad frame_seq rejected", () => {
  it("duplicate and decreasing sequences rejected without reuse", async () => {
    const session = await makeStartedSession();
    assert.equal((await session.writeFrame(makeFrame(1))).accepted, true);
    const dup = await session.writeFrame(makeFrame(1));
    assert.equal(dup.accepted, false);
    if (!dup.accepted) {
      assert.equal(dup.code, "INVALID_REQUEST");
    }
    assert.equal((await session.writeFrame(makeFrame(3))).accepted, true);
    const stats = session.getStats();
    assert.equal(stats.accepted_frames, 2);
    assert.equal(stats.last_pts_us, 33_333);
    await session.close();
  });
});

describe("P9.3: wrong frame bytes rejected", () => {
  it("short payload rejected", async () => {
    const session = await makeStartedSession();
    const result = await session.writeFrame(
      makeFrame(1, { bytes: new Uint8Array(100) }),
    );
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.code, "INVALID_REQUEST");
    }
    await session.close();
  });

  it("wrong geometry rejected with WINDOW_GEOMETRY_MISMATCH", async () => {
    const session = await makeStartedSession();
    const result = await session.writeFrame(
      makeFrame(1, {
        width: 1280,
        height: 720,
        stride_bytes: 1280 * 4,
        bytes: new Uint8Array(1280 * 720 * 4),
      }),
    );
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.code, "WINDOW_GEOMETRY_MISMATCH");
    }
    await session.close();
  });

  it("wrong pixel format rejected", async () => {
    const verdict = validateEncoderFrame(
      makeFrame(1, { pixel_format: "rgba8" }) as never,
      { ...FENCE, take_id: TAKE_ID, lastFrameSeq: 0 },
      0,
    );
    assert.equal(verdict.ok, false);
  });
});

describe("P9.3: bounded queue", () => {
  it("burst beyond 12 frames drops oldest with honest accounting", async () => {
    const session = await makeStartedSession(undefined, true);
    for (let seq = 1; seq <= 20; seq += 1) {
      const result = await session.writeFrame(makeFrame(seq));
      assert.equal(result.accepted, true);
    }
    const stats = session.getStats();
    assert.equal(stats.submitted_frames, 20);
    assert.equal(stats.accepted_frames, 20);
    assert.equal(stats.dropped_frames, 8);
    assert.equal(stats.pending_frames, 12);
    assert.equal(stats.peak_pending_frames, 12);
    assert.ok(stats.peak_pending_bytes <= 96 * 1024 * 1024);
    await session.close();
  });
});

describe("P9.3: drop-oldest accounting", () => {
  it("queue drops settle honestly: pending equals accepted minus dropped", async () => {
    const session = await makeStartedSession(undefined, true);
    for (let seq = 1; seq <= 15; seq += 1) {
      await session.writeFrame(makeFrame(seq));
    }
    const stats = session.getStats();
    assert.equal(stats.submitted_frames, stats.accepted_frames);
    assert.equal(stats.pending_frames, stats.accepted_frames - stats.dropped_frames);
    assert.equal(stats.dropped_frames, 3);
    await session.close();
  });
});

describe("P9.3: duplicate pacing coalesced but written", () => {
  it("identical consecutive digests count coalesced, still accepted", async () => {
    assert.equal(classifyPacing("ab", "ab"), "coalesce-duplicate");
    assert.equal(classifyPacing("ab", "cd"), "accept");
    assert.equal(classifyPacing("ab", undefined), "accept");
    const session = await makeStartedSession();
    await session.writeFrame(makeFrame(1, { content_digest_fnv1a64: "0123456789abcdef" }));
    await session.writeFrame(makeFrame(2, { content_digest_fnv1a64: "0123456789abcdef" }));
    assert.equal(session.getStats().coalesced_frames, 1);
    await session.close();
  });
});

describe("P9.3: stride packing", () => {
  it("padded rows pack to tight width*4 layout", () => {
    const width = 1920;
    const height = 2;
    const stride = width * 4 + 64;
    const padded = new Uint8Array(stride * height).fill(0x11);
    padded[stride] = 0x22;
    const tight = packTightRows(padded, width, height, stride);
    assert.equal(tight.length, width * 4 * height);
    assert.equal(tight[width * 4], 0x22);
  });

  it("tight buffers pass through with exact length", () => {
    const frame = generateFixtureFrame(3);
    assert.equal(frame.length, FRAME_BYTES);
    const tight = packTightRows(frame, 1920, 1080, 1920 * 4);
    assert.equal(tight.length, FRAME_BYTES);
  });
});

describe("P9.3: safe temp path", () => {
  it("canonical temp target resolves under the trusted root", () => {
    assert.equal(
      assertConfinedTempTarget("E:\\cf\\temp", "rec-session-001", "t01"),
      "E:\\cf\\temp/recording/rec-session-001/t01",
    );
  });
});

describe("P9.3: traversal rejected", () => {
  it("dot-dot components rejected in every position", () => {
    assert.throws(() => assertConfinedTempTarget("E:\\x\\..\\y", "rec-001", "t01"));
    assert.throws(() => assertConfinedTempTarget("E:\\x", "..", "t01"));
    assert.throws(() => assertConfinedTempTarget("E:\\x", "rec-001", ".."));
    assert.throws(() => assertConfinedTempTarget("", "rec-001", "t01"));
    assert.throws(() => assertConfinedTempTarget("E:\\x", "rec 001", "t01"));
    assert.throws(() => assertConfinedTempTarget("E:\\x", "rec-001", "take1"));
  });
});
