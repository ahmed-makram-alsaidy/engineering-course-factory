// P9.3 host owner tests: bounded queue, backpressure, drain timeout,
// lifecycle, confinement, and spawn audit with an injected fake process.
// Real filesystem only for prepare() dirs under E: temp (cleaned); no real
// FFmpeg/FFprobe; deterministic.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { rmSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EncoderHostError,
  EncoderHostSession,
  runBoundedTool,
  type OwnedProcess,
  type SpawnFn,
} from "../host/encoder-host.ts";
import { resolveTrustedRoots } from "../host/tool-resolution.ts";

const UNIT_ROOT = "E:\\course-factory\\temp\\p9.3-unit";
mkdirSync(UNIT_ROOT, { recursive: true });
after(() => {
  rmSync(UNIT_ROOT, { recursive: true, force: true });
});

const FENCE = {
  recording_session_id: "rec-p93-host-001",
  runtime_session_id: "sess-runtime-001",
  generation: 1,
};
const TAKE_ID = "t01";
const FRAME_BYTES = 1920 * 1080 * 4;
const SHARED_BYTES = new Uint8Array(FRAME_BYTES).fill(0x70);
const TOOLS = { ffmpeg: "E:\\tools\\ffmpeg.exe", ffprobe: "E:\\tools\\ffprobe.exe" };
const DESCRIPTOR = {
  family: "NVENC",
  profile: "nvenc-p4-cq23",
  profile_version: "1.0",
  fallback_used: false,
  encoder_version: "8.1.1-test",
} as const;

// ---------------------------------------------------------------------------
// Fake process machinery
// ---------------------------------------------------------------------------

interface SpawnCall {
  exe: string;
  argv: readonly string[];
  options: unknown;
}

class FakeStdin extends Writable {
  bytesAccepted = 0;
  gated = false;
  neverDrain = false;
  private releaseCallbacks: Array<() => void> = [];

  constructor() {
    super({ highWaterMark: 1024 });
  }

  override _write(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    void _encoding;
    if (this.neverDrain) {
      return;
    }
    if (this.gated) {
      this.releaseCallbacks.push(() => {
        this.bytesAccepted += chunk.length;
        callback(null);
      });
      return;
    }
    this.bytesAccepted += chunk.length;
    setImmediate(() => callback(null));
  }

  release(): void {
    const pending = this.releaseCallbacks;
    this.releaseCallbacks = [];
    for (const resume of pending) {
      setImmediate(resume);
    }
  }
}

class FakeOwnedProcess extends EventEmitter implements OwnedProcess {
  stdin: FakeStdin;
  stderr: Readable;
  stdout: Readable | null = null;
  exitCode: number | null = null;
  killed = false;
  exitCodeToReport = 0;
  neverExit = false;
  killCalls = 0;

  constructor(stderrText = "") {
    super();
    this.stdin = new FakeStdin();
    this.stderr = Readable.from(stderrText === "" ? [] : [stderrText]);
    this.stdin.on("finish", () => {
      if (this.neverExit || this.exitCode !== null) {
        return;
      }
      // Mirror process semantics: exit is observable only after piped
      // stdout is fully consumed, so bounded readers never race the JSON.
      const out = this.stdout;
      if (out === null) {
        setImmediate(() => this.emitExit());
        return;
      }
      out.once("end", () => setImmediate(() => this.emitExit()));
      out.resume();
    });
  }

  emitExit(): void {
    if (this.exitCode !== null) {
      return;
    }
    this.exitCode = this.exitCodeToReport;
    this.emit("exit", this.exitCodeToReport, null);
  }

  kill(): boolean {
    this.killCalls += 1;
    this.killed = true;
    if (!this.neverExit) {
      setImmediate(() => this.emitExit());
    }
    return true;
  }
}

interface FakeSpawnHarness {
  spawnFn: SpawnFn;
  calls: SpawnCall[];
  procs: FakeOwnedProcess[];
  ffprobeJson: string;
  ffmpegExit: number;
}

function makeFakeSpawn(): FakeSpawnHarness {
  const harness: FakeSpawnHarness = {
    calls: [],
    procs: [],
    ffprobeJson: "",
    ffmpegExit: 0,
    spawnFn: ((exe: string, argv: readonly string[], options: unknown) => {
      harness.calls.push({ exe, argv, options });
      const proc = new FakeOwnedProcess();
      harness.procs.push(proc);
      if (exe.toLowerCase().endsWith("ffprobe.exe")) {
        proc.stdout = Readable.from([harness.ffprobeJson]);
        proc.exitCodeToReport = 0;
      } else {
        proc.exitCodeToReport = harness.ffmpegExit;
      }
      return proc as unknown as OwnedProcess;
    }) as SpawnFn,
  };
  return harness;
}

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

function ffprobeJsonFor(accepted: number): string {
  const duration = (accepted / 30).toFixed(6);
  return JSON.stringify({
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration, size: "500000" },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30/1",
        pix_fmt: "yuv420p",
        nb_frames: `${accepted}`,
      },
    ],
    packets: [
      { pts: 0, dts: 0, stream_index: 0 },
      { pts: 1024, dts: 1024, stream_index: 0 },
    ],
  });
}

function tinyFaststartMp4(): Uint8Array {
  const box = (type: string, size: number): Uint8Array => {
    const out = new Uint8Array(size).fill(0xab);
    out[0] = (size >>> 24) & 0xff;
    out[1] = (size >>> 16) & 0xff;
    out[2] = (size >>> 8) & 0xff;
    out[3] = size & 0xff;
    for (let i = 0; i < 4; i += 1) {
      out[4 + i] = type.charCodeAt(i);
    }
    return out;
  };
  const ftyp = box("ftyp", 24);
  const moov = box("moov", 64);
  const mdat = box("mdat", 256);
  const out = new Uint8Array(344);
  out.set(ftyp, 0);
  out.set(moov, 24);
  out.set(mdat, 88);
  return out;
}

async function makeSession(
  harness: FakeSpawnHarness,
  dirName: string,
  timeouts?: ConstructorParameters<typeof EncoderHostSession>[0]["timeouts"],
): Promise<{ session: EncoderHostSession; dir: string }> {
  const session = new EncoderHostSession({
    fence: FENCE,
    takeId: TAKE_ID,
    tools: TOOLS,
    spawnFn: harness.spawnFn,
    nowMs: () => 1_000_000,
    timeouts,
  });
  const prepared = await session.prepare({
    tempRoot: join(UNIT_ROOT, dirName),
    recordingSessionId: FENCE.recording_session_id,
    takeId: TAKE_ID,
  });
  return { session, dir: prepared.dir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("P9.3: stdin backpressure respected", () => {
  it("small pipe buffer still accepts every frame via drain", async () => {
    const harness = makeFakeSpawn();
    const { session, dir } = await makeSession(harness, "backpressure");
    await session.start({ ...DESCRIPTOR });
    for (let seq = 1; seq <= 5; seq += 1) {
      const result = await session.writeFrame(makeFrame(seq));
      assert.equal(result.accepted, true);
    }
    const proc = harness.procs[0]!;
    assert.equal(proc.stdin.bytesAccepted, 5 * FRAME_BYTES);
    assert.equal(session.getStats().dropped_frames, 0);
    await session.abort("test-done");
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: drain resumes", () => {
  it("gated pipe drains fully after release", async () => {
    const harness = makeFakeSpawn();
    const { session, dir } = await makeSession(harness, "drain-resume");
    await session.start({ ...DESCRIPTOR });
    const proc = harness.procs[0]!;
    proc.stdin.gated = true;
    const pending = [
      session.writeFrame(makeFrame(1)),
      session.writeFrame(makeFrame(2)),
      session.writeFrame(makeFrame(3)),
    ];
    proc.stdin.gated = false;
    proc.stdin.release();
    const results = await Promise.all(pending);
    assert.ok(results.every((r) => r.accepted));
    await session.abort("test-done");
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: bounded queue at the host", () => {
  it("20-frame burst against a stalled pipe drops oldest, peaks bounded", async () => {
    const harness = makeFakeSpawn();
    const { session, dir } = await makeSession(harness, "bounded");
    await session.start({ ...DESCRIPTOR });
    const proc = harness.procs[0]!;
    proc.stdin.gated = true;
    const pending: Array<Promise<unknown>> = [];
    for (let seq = 1; seq <= 20; seq += 1) {
      pending.push(session.writeFrame(makeFrame(seq)));
    }
    const stats = session.getStats();
    assert.equal(stats.submitted_frames, 20);
    assert.equal(stats.accepted_frames, 20);
    assert.equal(stats.dropped_frames, 8);
    assert.equal(stats.pending_frames, 12);
    assert.equal(stats.peak_pending_frames, 12);
    assert.ok(stats.peak_pending_bytes <= 96 * 1024 * 1024);
    proc.stdin.gated = false;
    proc.stdin.release();
    await Promise.all(pending);
    await session.abort("test-done");
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: drain timeout fails", () => {
  it("a never-draining pipe fails bounded with ENCODER_TIMEOUT", async () => {
    const harness = makeFakeSpawn();
    const { session, dir } = await makeSession(harness, "drain-timeout", { drainMs: 50 });
    await session.start({ ...DESCRIPTOR });
    const proc = harness.procs[0]!;
    proc.stdin.neverDrain = true;
    const result = await session.writeFrame(makeFrame(1));
    assert.equal(result.accepted, false);
    if (!result.accepted) {
      assert.equal(result.code, "ENCODER_TIMEOUT");
    }
    assert.ok(proc.killCalls >= 1);
    await session.abort("test-done");
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: duplicate start deterministic at the host", () => {
  it("second start throws and keeps the first process", async () => {
    const harness = makeFakeSpawn();
    const { session, dir } = await makeSession(harness, "dup-start");
    await session.start({ ...DESCRIPTOR });
    await assert.rejects(session.start({ ...DESCRIPTOR }), /INVALID_REQUEST/);
    assert.equal(harness.calls.filter((c) => c.exe === TOOLS.ffmpeg).length, 1);
    await session.abort("test-done");
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: early process exit fails writes", () => {
  it("exit before frames surfaces ENCODER_FAILED", async () => {
    const harness = makeFakeSpawn();
    harness.ffmpegExit = 1;
    const { session, dir } = await makeSession(harness, "early-exit");
    await session.start({ ...DESCRIPTOR });
    const proc = harness.procs[0]!;
    proc.emitExit();
    await new Promise((resolve) => setImmediate(resolve));
    const result = await session.writeFrame(makeFrame(1));
    assert.equal(result.accepted, false);
    await session.abort("test-done");
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: spawn throw maps to ENCODER_START_FAILED", () => {
  it("spawn failure throws a sanitized start error", async () => {
    const throwing: SpawnFn = () => {
      throw new Error("E:\\secret\\path exploded");
    };
    const session = new EncoderHostSession({
      fence: FENCE,
      takeId: TAKE_ID,
      tools: TOOLS,
      spawnFn: throwing,
      nowMs: () => 1_000_000,
    });
    await session.prepare({
      tempRoot: join(UNIT_ROOT, "spawn-throw"),
      recordingSessionId: FENCE.recording_session_id,
      takeId: TAKE_ID,
    });
    await assert.rejects(session.start({ ...DESCRIPTOR }), /ENCODER_START_FAILED/);
    await session.close();
    rmSync(join(UNIT_ROOT, "spawn-throw"), { recursive: true, force: true });
  });
});

describe("P9.3: stderr sanitized", () => {
  it("host error DTOs redact host paths and stay bounded", () => {
    const error = new EncoderHostError(
      "ENCODER_FAILED",
      "boom at E:\\secret\\place\\tool.exe line 1\nat foo (E:\\x.js:1:1)",
      { ...FENCE, take_id: TAKE_ID },
    );
    assert.match(String(error), /\[ENCODER_FAILED\]/);
    assert.ok(!error.dto.message.includes("E:\\secret"));
    assert.ok(!error.dto.message.includes("at foo"));
    assert.ok(error.dto.message.length <= 512);
    assert.equal(error.dto.code, "ENCODER_FAILED");
    assert.equal(error.dto.retry, "NOT_RETRYABLE");
  });
});

describe("P9.3: finish success path at the host", () => {
  it("flush, exit 0, validation PASS, digest, COMPLETED", async () => {
    const harness = makeFakeSpawn();
    harness.ffprobeJson = ffprobeJsonFor(3);
    const { session, dir } = await makeSession(harness, "finish-ok");
    await session.start({ ...DESCRIPTOR });
    for (let seq = 1; seq <= 3; seq += 1) {
      assert.equal((await session.writeFrame(makeFrame(seq))).accepted, true);
    }
    writeFileSync(join(dir, "screen.partial.mp4"), tinyFaststartMp4());
    const result = await session.finish();
    assert.equal(result.validation_verdict, "PASS");
    assert.match(result.media_digest, /^[0-9a-f]{64}$/);
    assert.ok(result.media_size_bytes > 0);
    assert.equal(result.stats.state, "COMPLETED");
    assert.equal(result.stats.exit_code, 0);
    assert.equal(result.stats.validation_verdict, "PASS");
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: nonzero exit fails at the host", () => {
  it("exit 1 at flush throws ENCODER_FAILED", async () => {
    const harness = makeFakeSpawn();
    harness.ffmpegExit = 1;
    const { session, dir } = await makeSession(harness, "finish-bad-exit");
    await session.start({ ...DESCRIPTOR });
    await session.writeFrame(makeFrame(1));
    // The early-exit listener already failed the session; finish surfaces it.
    await assert.rejects(session.finish(), /ENCODER_FAILED/);
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: abort removes only the owned partial", () => {
  it("abort unlinks the session partial and keeps siblings", async () => {
    const harness = makeFakeSpawn();
    const { session, dir } = await makeSession(harness, "abort-clean");
    await session.start({ ...DESCRIPTOR });
    await session.writeFrame(makeFrame(1));
    const sibling = join(dir, "sibling.txt");
    writeFileSync(sibling, "keep");
    writeFileSync(join(dir, "screen.partial.mp4"), tinyFaststartMp4());
    const result = await session.abort("operator-cancel");
    assert.equal(result.aborted, true);
    assert.equal(result.exitObserved, true);
    assert.equal(result.tempRemoved, true);
    assert.equal(existsSync(join(dir, "screen.partial.mp4")), false);
    assert.equal(existsSync(sibling), true);
    assert.equal(statSync(sibling).size, 4);
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: prepare confinement at the host", () => {
  it("creates the trusted dir and rejects escapes", async () => {
    const harness = makeFakeSpawn();
    const session = new EncoderHostSession({
      fence: FENCE,
      takeId: TAKE_ID,
      tools: TOOLS,
      spawnFn: harness.spawnFn,
      nowMs: () => 1_000_000,
    });
    const root = join(UNIT_ROOT, "confine");
    const prepared = await session.prepare({
      tempRoot: root,
      recordingSessionId: FENCE.recording_session_id,
      takeId: TAKE_ID,
    });
    assert.ok(existsSync(prepared.dir));
    assert.equal(prepared.partialFileName, "screen.partial.mp4");
    await session.close();
    await assert.rejects(
      new EncoderHostSession({
        fence: FENCE,
        takeId: TAKE_ID,
        tools: TOOLS,
        spawnFn: harness.spawnFn,
      }).prepare({
        tempRoot: join(root, "..", "escape"),
        recordingSessionId: "..",
        takeId: TAKE_ID,
      }),
      /STALE_SESSION|INVALID_REQUEST/,
    );
    rmSync(root, { recursive: true, force: true });
  });
});

describe("P9.3: spawn audit at the host", () => {
  it("encode spawn uses the pinned exe, fixed argv, shell false", async () => {
    const harness = makeFakeSpawn();
    const { session, dir } = await makeSession(harness, "spawn-audit");
    await session.start({ ...DESCRIPTOR });
    assert.equal(harness.calls.length, 1);
    const call = harness.calls[0]!;
    assert.equal(call.exe, TOOLS.ffmpeg);
    const options = call.options as Record<string, unknown>;
    assert.equal(options["shell"], false);
    assert.equal(options["windowsHide"], true);
    assert.deepEqual(options["stdio"], ["pipe", "ignore", "pipe"]);
    const argv = [...call.argv];
    assert.equal(argv[argv.length - 1]?.endsWith("screen.partial.mp4"), true);
    assert.ok(argv.includes("h264_nvenc"));
    await session.abort("test-done");
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("P9.3: runBoundedTool bounds", () => {
  it("hanging tool resolves null exit after the timeout", async () => {
    const hanging: SpawnFn = () => {
      const proc = new FakeOwnedProcess();
      proc.neverExit = true;
      return proc as unknown as OwnedProcess;
    };
    const started = Date.now();
    const result = await runBoundedTool(hanging, "E:\\tools\\ffmpeg.exe", ["-version"], 60);
    assert.equal(result.exitCode, null);
    assert.ok(Date.now() - started < 5_000);
  });
});

describe("P9.3: trusted roots resolve without renderer input", () => {
  it("temp root defaults under the repository", () => {
    const roots = resolveTrustedRoots();
    assert.ok(roots.tempRoot.endsWith("temp"));
    assert.ok(roots.repoRoot.length > 0);
  });
});
