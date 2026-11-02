// P5.1 guest supervisor tests — frame schemas, design limits, and the pure
// hello/init/lease state machine driven by injected monotonic times (no I/O,
// no processes, fully deterministic).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkFrameByteLimit,
  GuestErrorFrameSchema,
  HelloFrameSchema,
  HeartbeatFrameSchema,
  HostFrameSchema,
  InitAckFrameSchema,
  SUPERVISOR_FRAME_LIMITS,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_TIMING,
  type GuestFrame,
} from "../container/protocol.ts";
import { SupervisorCore } from "../container/supervisor-core.ts";

const DIGEST = "sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const SESSION = "sess-20260906-cf51";
const RUNTIME_INFO = { node_major: 24, node_version: "v24.20.0" };

/** Assert-and-narrow a guest frame to its concrete variant. */
function expectType<T extends GuestFrame["type"]>(frame: GuestFrame, type: T): Extract<GuestFrame, { type: T }> {
  assert.equal(frame.type, type);
  return frame as Extract<GuestFrame, { type: T }>;
}

function newCore(): SupervisorCore {
  return new SupervisorCore(RUNTIME_INFO);
}

function initFrame(overrides: Record<string, unknown> = {}) {
  return { type: "init", seq: 1, session_id: SESSION, generation: 1, image_digest: DIGEST, ...overrides };
}

describe("supervisor protocol: frame schemas", () => {
  it("hello/init/init_ack/heartbeat/error frames parse", () => {
    HelloFrameSchema.parse({ type: "hello", seq: 1, supervisor_protocol_version: 1, node_major: 24, node_version: "v24.20.0" });
    HostFrameSchema.parse(initFrame());
    InitAckFrameSchema.parse({ type: "init_ack", seq: 2, session_id: SESSION, generation: 1, image_digest: DIGEST });
    HeartbeatFrameSchema.parse({ type: "heartbeat", seq: 3, session_id: SESSION, generation: 1, monotonic_ms: 4000 });
    GuestErrorFrameSchema.parse({ type: "error", seq: 4, session_id: null, generation: null, code: "PROTOCOL_FAILED", message: "x" });
  });

  it("frames reject unknown types, extra keys and malformed digests", () => {
    assert.equal(HostFrameSchema.safeParse({ type: "execute", seq: 1, command: "rm -rf /" }).success, false, "no arbitrary execution frame exists");
    assert.equal(HostFrameSchema.safeParse(initFrame({ extra: true })).success, false);
    assert.equal(HostFrameSchema.safeParse(initFrame({ image_digest: "node:24-bookworm-slim" })).success, false, "digest must be sha256-pinned");
    assert.equal(HostFrameSchema.safeParse(initFrame({ image_digest: "sha256:xyz" })).success, false);
  });
});

describe("supervisor protocol: design limits and timing", () => {
  it("frame size limits match the design exactly", () => {
    assert.equal(SUPERVISOR_FRAME_LIMITS.init_max_bytes, 1_048_576);
    assert.equal(SUPERVISOR_FRAME_LIMITS.frame_max_bytes, 65_536);
    assert.equal(SUPERVISOR_FRAME_LIMITS.output_payload_max_bytes, 16_384);
  });

  it("timing constants match the design exactly", () => {
    assert.equal(SUPERVISOR_TIMING.heartbeat_interval_ms, 2_000);
    assert.equal(SUPERVISOR_TIMING.lease_ms, 15_000);
    assert.equal(SUPERVISOR_TIMING.shutdown_deadline_ms, 5_000);
  });

  it("byte limits: any frame up to 64 KiB, init up to 1 MiB, beyond that reject", () => {
    assert.equal(checkFrameByteLimit(65_536, "heartbeat"), "ok");
    assert.equal(checkFrameByteLimit(65_537, "heartbeat"), "oversized");
    assert.equal(checkFrameByteLimit(65_537, "init"), "ok");
    assert.equal(checkFrameByteLimit(1_048_576, "init"), "ok");
    assert.equal(checkFrameByteLimit(1_048_577, "init"), "oversized");
    assert.equal(checkFrameByteLimit(10_000_000, null), "oversized");
  });
});

describe("supervisor core: hello/init/lease", () => {
  it("boot emits hello first with protocol version 1 and anchors the lease at boot", () => {
    const core = newCore();
    const boot = core.boot(0);
    assert.equal(boot.frames.length, 1);
    const hello = expectType(boot.frames[0], "hello");
    assert.equal(hello.seq, 1);
    assert.equal(hello.supervisor_protocol_version, SUPERVISOR_PROTOCOL_VERSION);
    assert.equal(hello.node_major, 24);
    assert.equal(boot.phase, "awaiting-init");
    assert.equal(boot.lease_deadline_ms, 15_000);
    assert.equal(boot.exit_requested, false);
  });

  it("does not emit session heartbeats before init (frames need frozen session identity)", () => {
    const core = newCore();
    core.boot(0);
    const advanced = core.advance(5_000);
    assert.deepEqual(advanced.frames, []);
    assert.equal(advanced.phase, "awaiting-init");
  });

  it("a valid init freezes the session, acknowledges the digest and renews the lease", () => {
    const core = newCore();
    core.boot(0);
    const ack = core.handleHostFrame(initFrame(), 1_000);
    assert.equal(ack.frames.length, 1);
    const frame = expectType(ack.frames[0], "init_ack");
    assert.equal(frame.seq, 2);
    assert.equal(frame.session_id, SESSION);
    assert.equal(frame.generation, 1);
    assert.equal(frame.image_digest, DIGEST);
    assert.equal(ack.phase, "ready");
    assert.equal(ack.lease_deadline_ms, 16_000, "lease renewed at init time");
    assert.equal(ack.next_heartbeat_ms, 3_000);
    assert.deepEqual(core.session, { session_id: SESSION, generation: 1, image_digest: DIGEST });
  });

  it("emits heartbeats every 2 seconds after init, with strictly increasing seq", () => {
    const core = newCore();
    core.boot(0);
    core.handleHostFrame(initFrame(), 1_000);
    const first = expectType(core.advance(3_000).frames[0], "heartbeat");
    assert.equal(first.seq, 3);
    assert.equal(first.monotonic_ms, 3_000);
    const quiet = core.advance(4_000);
    assert.deepEqual(quiet.frames, [], "next heartbeat not yet due");
    const second = expectType(core.advance(5_000).frames[0], "heartbeat");
    assert.equal(second.seq, 4, "seq strictly increasing");
  });

  it("expires the lease 15 seconds after boot when init never arrives", () => {
    const core = newCore();
    core.boot(0);
    const expiry = core.advance(15_000);
    assert.equal(expiry.exit_requested, true);
    assert.equal(expiry.phase, "expired");
    const error = expectType(expiry.frames.at(-1) as GuestFrame, "error");
    assert.equal(error.code, "LEASE_EXPIRED");
    const after = core.advance(20_000);
    assert.deepEqual(after.frames, [], "no frames after expiry");
  });

  it("a late-but-correct init renews the lease instead of expiring", () => {
    const core = newCore();
    core.boot(0);
    const ack = core.handleHostFrame(initFrame(), 14_000);
    assert.equal(ack.phase, "ready");
    assert.equal(ack.lease_deadline_ms, 29_000);
    assert.equal(core.advance(28_999).exit_requested, false);
    const expiry = core.advance(29_000);
    assert.equal(expiry.phase, "expired");
    assert.equal(expiry.exit_requested, true);
  });

  it("fails closed on a malformed init (bad digest) with an error frame", () => {
    const core = newCore();
    core.boot(0);
    const result = core.handleHostFrame(initFrame({ image_digest: "latest" }), 1_000);
    assert.equal(result.phase, "failed");
    assert.equal(result.exit_requested, true);
    assert.equal(expectType(result.frames[0], "error").code, "PROTOCOL_FAILED");
  });

  it("fails closed when the first host frame is not init", () => {
    const core = newCore();
    core.boot(0);
    const result = core.handleHostFrame({ type: "heartbeat", seq: 1, session_id: SESSION, generation: 1, monotonic_ms: 0 }, 100);
    assert.equal(result.phase, "failed");
    assert.equal(expectType(result.frames[0], "error").code, "PROTOCOL_FAILED");
  });

  it("fails closed on any unexpected frame after init (P5.1 minimal frame set)", () => {
    const core = newCore();
    core.boot(0);
    core.handleHostFrame(initFrame(), 1_000);
    const result = core.handleHostFrame(initFrame({ seq: 2 }), 2_000);
    assert.equal(result.phase, "failed");
    assert.equal(expectType(result.frames[0], "error").code, "PROTOCOL_FAILED");
  });

  it("EOF requests exit without further frames", () => {
    const core = newCore();
    core.boot(0);
    const eof = core.notifyEof();
    assert.equal(eof.exit_requested, true);
    assert.deepEqual(eof.frames, []);
  });

  it("guest error frames stay schema-valid when no session was frozen", () => {
    const core = newCore();
    core.boot(0);
    const result = core.handleHostFrame("not-an-object", 1_000);
    const parsed = GuestErrorFrameSchema.parse(result.frames[0]);
    assert.equal(parsed.session_id, null);
    assert.equal(parsed.generation, null);
  });
});
