// P9.3 encoder lifecycle tests: finish/abort/close semantics and scripted
// faults (unit matrix 36-44). Deterministic fake; no processes, no disk.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeEncoderSession } from "../src/encoder/fake-encoder.ts";

const FENCE = {
  recording_session_id: "rec-p93-life-001",
  runtime_session_id: "sess-runtime-001",
  generation: 1,
};
const TAKE_ID = "t01";
const FRAME_BYTES = 1920 * 1080 * 4;
const SHARED_BYTES = new Uint8Array(FRAME_BYTES).fill(0x40);

const DESCRIPTOR = {
  family: "LIBX264",
  profile: "libx264-veryfast-crf21",
  profile_version: "1.0",
  fallback_used: true,
  fallback_reason: "NVENC_ENCODER_MISSING",
  encoder_version: "8.1.1-test",
} as const;

function makeFrame(seq: number): Record<string, unknown> & { bytes: Uint8Array } {
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
  };
}

async function makeStartedSession(faults?: ConstructorParameters<typeof FakeEncoderSession>[0]["faults"]): Promise<FakeEncoderSession> {
  const session = new FakeEncoderSession({ fence: FENCE, takeId: TAKE_ID, faults });
  await session.prepare({
    tempRoot: "E:\\p93",
    recordingSessionId: FENCE.recording_session_id,
    takeId: TAKE_ID,
  });
  await session.start({ ...DESCRIPTOR });
  return session;
}

describe("P9.3: finish closes stdin", () => {
  it("finish drains pending and reports COMPLETED with digest", async () => {
    const session = await makeStartedSession();
    await session.writeFrame(makeFrame(1));
    await session.writeFrame(makeFrame(2));
    const result = await session.finish();
    assert.equal(result.validation_verdict, "PASS");
    assert.match(result.media_digest, /^[0-9a-f]{64}$/);
    assert.ok(result.media_size_bytes > 0);
    assert.equal(result.stats.state, "COMPLETED");
    assert.equal(result.stats.pending_frames, 0);
    assert.equal(result.stats.exit_code, 0);
    await session.close();
    assert.equal(session.getStats().state, "CLOSED");
  });
});

describe("P9.3: process successful exit", () => {
  it("exit code 0 recorded on the finished stats", async () => {
    const session = await makeStartedSession();
    await session.writeFrame(makeFrame(1));
    await session.finish();
    assert.equal(session.getStats().exit_code, 0);
    await session.close();
  });
});

describe("P9.3: nonzero exit fails", () => {
  it("exit code 1 throws ENCODER_FAILED", async () => {
    const session = await makeStartedSession({ exitCode: 1 });
    await session.writeFrame(makeFrame(1));
    await assert.rejects(session.finish(), /ENCODER_FAILED/);
    await session.close();
  });
});

describe("P9.3: startup failure", () => {
  it("scripted start refusal throws ENCODER_START_FAILED", async () => {
    const session = new FakeEncoderSession({
      fence: FENCE,
      takeId: TAKE_ID,
      faults: { failOnStart: true },
    });
    await session.prepare({
      tempRoot: "E:\\p93",
      recordingSessionId: FENCE.recording_session_id,
      takeId: TAKE_ID,
    });
    await assert.rejects(session.start({ ...DESCRIPTOR }), /ENCODER_START_FAILED/);
    await session.close();
  });
});

describe("P9.3: flush timeout", () => {
  it("scripted flush hang throws ENCODER_TIMEOUT", async () => {
    const session = await makeStartedSession({ flushTimeout: true });
    await session.writeFrame(makeFrame(1));
    await assert.rejects(session.finish(), /ENCODER_TIMEOUT/);
    await session.close();
  });
});

describe("P9.3: abort active process", () => {
  it("abort stops intake and reports removal", async () => {
    const session = await makeStartedSession();
    await session.writeFrame(makeFrame(1));
    const result = await session.abort("operator-cancel");
    assert.equal(result.aborted, true);
    assert.equal(result.exitObserved, true);
    assert.equal(result.tempRemoved, true);
    const after = await session.writeFrame(makeFrame(2));
    assert.equal(after.accepted, false);
    await session.close();
  });
});

describe("P9.3: abort only owned process", () => {
  it("aborting one session leaves a sibling session accepting", async () => {
    const first = await makeStartedSession();
    const second = new FakeEncoderSession({
      fence: {
        recording_session_id: "rec-p93-life-002",
        runtime_session_id: "sess-runtime-002",
        generation: 1,
      },
      takeId: TAKE_ID,
    });
    await second.prepare({
      tempRoot: "E:\\p93",
      recordingSessionId: "rec-p93-life-002",
      takeId: TAKE_ID,
    });
    await second.start({ ...DESCRIPTOR });
    await first.abort("cancel-first");
    const siblingFrame = {
      ...makeFrame(1),
      recording_session_id: "rec-p93-life-002",
      runtime_session_id: "sess-runtime-002",
    };
    assert.equal((await second.writeFrame(siblingFrame)).accepted, true);
    await first.close();
    await second.close();
  });
});

describe("P9.3: duplicate abort deterministic", () => {
  it("second abort returns the same shape without throwing", async () => {
    const session = await makeStartedSession();
    const first = await session.abort("cancel");
    const second = await session.abort("cancel");
    assert.deepEqual(
      { aborted: second.aborted, exitObserved: second.exitObserved, tempRemoved: second.tempRemoved },
      { aborted: first.aborted, exitObserved: first.exitObserved, tempRemoved: first.tempRemoved },
    );
    await session.close();
  });
});

describe("P9.3: abort after finish is a safe no-op", () => {
  it("abort on COMPLETED reports aborted false", async () => {
    const session = await makeStartedSession();
    await session.writeFrame(makeFrame(1));
    await session.finish();
    const result = await session.abort("late-cancel");
    assert.equal(result.aborted, false);
    assert.equal(result.tempRemoved, false);
    await session.close();
  });
});

describe("P9.3: close idempotency", () => {
  it("double close resolves without throwing", async () => {
    const session = await makeStartedSession();
    await session.close();
    await session.close();
    assert.equal(session.getStats().state, "CLOSED");
  });
});

describe("P9.3: zero-frame finish rejected", () => {
  it("finish with no accepted frames throws MEDIA_VALIDATION_FAILED", async () => {
    const session = await makeStartedSession();
    await assert.rejects(session.finish(), /MEDIA_VALIDATION_FAILED/);
    await session.close();
  });
});

describe("P9.3: validation failure", () => {
  it("scripted validation FAIL throws MEDIA_VALIDATION_FAILED", async () => {
    const session = await makeStartedSession({ validationFails: true });
    await session.writeFrame(makeFrame(1));
    await assert.rejects(session.finish(), /MEDIA_VALIDATION_FAILED/);
    await session.close();
  });
});

describe("P9.3: finish after abort rejected", () => {
  it("finish on an aborted session throws", async () => {
    const session = await makeStartedSession();
    await session.writeFrame(makeFrame(1));
    await session.abort("cancel");
    await assert.rejects(session.finish(), /INVALID_REQUEST/);
    await session.close();
  });
});
