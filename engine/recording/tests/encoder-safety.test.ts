// P9.3 encoder safety tests: injection impossibility, single Main-owned
// spawn site, shell disabled, no publication/IPC/journal scope creep,
// P9.1/P9.2 freeze (unit matrix 54-60 + security matrix). Deterministic.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeEncoderSession } from "../src/encoder/fake-encoder.ts";
import { buildEncodeArgv } from "../src/encoder/encoder-argv.ts";
import {
  InternalRecordingStartDescriptorSchema,
  TakeFenceSchema,
} from "../src/protocol.ts";
import { EncoderDescriptorSchema } from "../src/encoder-profile.ts";
import { openAndStart, makeTestSession } from "./capture-helpers.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const pkgRoot = join(__dirname, "..");
const encoderDir = join(pkgRoot, "src", "encoder");
const hostDir = join(pkgRoot, "host");

function readAllTs(dir: string): Array<{ file: string; content: string }> {
  const out: Array<{ file: string; content: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...readAllTs(full));
    } else if (full.endsWith(".ts")) {
      out.push({ file: full, content: readFileSync(full, "utf8") });
    }
  }
  return out;
}

describe("P9.3: shell disabled at the single spawn site", () => {
  it("host owns exactly one spawn call site with shell false", () => {
    const files = readAllTs(hostDir);
    assert.ok(files.length >= 2);
    const combined = files.map((f) => f.content).join("\n");
    assert.equal(combined.split("nodeSpawn(").length - 1, 1);
    assert.ok(combined.includes("shell: false"));
    assert.ok(!combined.includes("shell:true"));
    assert.ok(!combined.includes("shell: true"));
  });

  it("no shell execution primitives anywhere in recording src or host", () => {
    const files = readAllTs(join(pkgRoot, "src")).concat(readAllTs(hostDir));
    for (const { file, content } of files) {
      for (const token of ["execFile(", "execSync(", "eval(", "new Function", "cmd.exe", "powershell"]) {
        assert.ok(!content.includes(token), `${file} contains '${token}'`);
      }
      // Bare exec( (excluding legitimate `.exec(` regex-receiver calls,
      // mirroring the frozen source-safety gate semantics).
      assert.ok(
        !/(?<!\.)\bexec\s*\(/.test(content),
        `${file} contains a bare exec(`,
      );
    }
  });
});

describe("P9.3: command injection impossible", () => {
  it("hostile output strings stay one opaque final argv element", () => {
    const reference = buildEncodeArgv({
      family: "NVENC",
      geometry: { width: 1920, height: 1080, fps: 30 },
      outputPath: "SENTINEL",
    });
    const hostile = [
      "; rm -rf /",
      "a&b|c>d<e",
      "\\\\server\\share\\x.mp4",
      "..\\..\\evil.mp4",
      "out.mp4 -c:v libx264",
      "-filter:v scale=320:240",
      "x.mp4;powershell",
    ];
    for (const outputPath of hostile) {
      const argv = buildEncodeArgv({
        family: "NVENC",
        geometry: { width: 1920, height: 1080, fps: 30 },
        outputPath,
      });
      assert.equal(argv.length, reference.length);
      assert.deepEqual(argv.slice(0, -1), reference.slice(0, -1));
      assert.equal(argv[argv.length - 1], outputPath);
    }
  });

  it("hostile families, codecs, presets, filters structurally rejected", () => {
    for (const family of ["h264_nvenc;evil", "libx264 -preset ultrafast", "", "X264", "NVENC "]) {
      assert.throws(() =>
        buildEncodeArgv({
          family: family as never,
          geometry: { width: 1920, height: 1080, fps: 30 },
          outputPath: "OUT",
        }),
      );
    }
    assert.throws(() =>
      EncoderDescriptorSchema.parse({
        family: "NVENC; rm",
        profile: "nvenc-p4-cq23",
        profile_version: "1.0",
        fallback_used: false,
        encoder_version: "8.1.1",
      }),
    );
  });

  it("public start descriptor rejects every hostile media key", () => {
    const base = {
      lesson_id: "C01-L003",
      runtime_session_id: "sess-001",
      generation: 1,
      take_id: "t01",
      recording_profile_id: "rec-1080p30-h264-v1",
      record_safe: true,
    };
    for (const key of [
      "ffmpegPath", "ffprobePath", "outputPath", "args", "extraArgs",
      "filter", "codec", "preset", "shell", "command", "cwd", "env",
      "hostPort", "pid", "ffmpegArgs", "path",
    ]) {
      assert.equal(
        InternalRecordingStartDescriptorSchema.safeParse({ ...base, [key]: "x" }).success,
        false,
        `descriptor accepted hostile key '${key}'`,
      );
    }
  });

  it("take fence rejects hostile identity keys", () => {
    assert.equal(
      TakeFenceSchema.safeParse({
        recording_session_id: "rec-001",
        runtime_session_id: "sess-001",
        generation: 1,
        outputPath: "E:\\evil.mp4",
      }).success,
      false,
    );
  });
});

describe("P9.3: renderer cannot provide output path", () => {
  it("prepare binds mismatched fences to STALE_SESSION", async () => {
    const session = new FakeEncoderSession({
      fence: {
        recording_session_id: "rec-p93-safe-001",
        runtime_session_id: "sess-001",
        generation: 1,
      },
      takeId: "t01",
    });
    await assert.rejects(
      session.prepare({
        tempRoot: "E:\\p93",
        recordingSessionId: "rec-p93-other-002",
        takeId: "t01",
      }),
      /STALE_SESSION/,
    );
    await session.close();
  });
});

describe("P9.3: abort only the owned process", () => {
  it("host source never kills by image name or globally", () => {
    const files = readAllTs(hostDir);
    for (const { file, content } of files) {
      const lowered = content.toLowerCase();
      for (const token of ["taskkill", "pkill", "killall", "/im ffmpeg", "stop-process", "get-process"]) {
        assert.ok(!lowered.includes(token), `${file} contains '${token}'`);
      }
      assert.ok(!content.includes(".raw"));
      assert.ok(!content.includes(".bgra"));
      assert.ok(!content.includes(".rgb"));
      assert.ok(!content.includes(".bmp"));
    }
  });
});

describe("P9.3: no MP4 publication", () => {
  it("finish result carries no publication status or final path", async () => {
    const session = new FakeEncoderSession({
      fence: {
        recording_session_id: "rec-p93-safe-002",
        runtime_session_id: "sess-001",
        generation: 1,
      },
      takeId: "t01",
    });
    await session.prepare({
      tempRoot: "E:\\p93",
      recordingSessionId: "rec-p93-safe-002",
      takeId: "t01",
    });
    await session.start({
      family: "NVENC",
      profile: "nvenc-p4-cq23",
      profile_version: "1.0",
      fallback_used: false,
      encoder_version: "8.1.1-test",
    });
    await session.writeFrame({
      frame_seq: 1,
      capture_timestamp_us: 1_000_000,
      width: 1920,
      height: 1080,
      pixel_format: "bgra8",
      stride_bytes: 7680,
      recording_session_id: "rec-p93-safe-002",
      take_id: "t01",
      runtime_session_id: "sess-001",
      generation: 1,
      bytes: new Uint8Array(1920 * 1080 * 4),
    });
    const result = await session.finish();
    const keys = Object.keys(result);
    assert.ok(!keys.some((k) => /publish|final|render/i.test(k)));
    await session.close();
  });

  it("host source never marks PUBLISHED", () => {
    const files = readAllTs(hostDir);
    for (const { file, content } of files) {
      assert.ok(!content.includes("PUBLISHED"), `${file} mentions PUBLISHED`);
      assert.ok(!content.includes("renderRoot"), `${file} touches renderRoot`);
    }
  });
});

describe("P9.3: no Electron IPC", () => {
  it("encoder and host sources stay Electron-free", () => {
    const files = readAllTs(encoderDir).concat(readAllTs(hostDir));
    for (const { file, content } of files) {
      for (const token of ["ipcMain", "ipcRenderer", "desktopCapturer", "contextBridge", "webContents"]) {
        assert.ok(!content.includes(token), `${file} contains '${token}'`);
      }
    }
  });
});

describe("P9.3: no RuntimeJournal integration", () => {
  it("no journal subscription, runtime host, or timeline emission tokens", () => {
    const files = readAllTs(encoderDir).concat(readAllTs(hostDir));
    for (const { file, content } of files) {
      for (const token of ["RuntimeJournal", "LessonRuntime", "RuntimeHost", "runtime:event", "subscribe", "anchors.jsonl"]) {
        assert.ok(!content.includes(token), `${file} contains '${token}'`);
      }
    }
  });
});

describe("P9.3: no P9.4 runtime timeline implementation", () => {
  it("no epoch mapping or anchor emission in encoder scope", () => {
    const files = readAllTs(encoderDir).concat(readAllTs(hostDir));
    for (const { file, content } of files) {
      for (const token of ["epoch_skew", "global_seq", "scene_id", "step_id", "RecordingTimeline"]) {
        assert.ok(!content.includes(token), `${file} contains '${token}'`);
      }
    }
  });
});

describe("P9.3: no audio capture", () => {
  it("no microphone, loopback, TTS, or audio-track tokens", () => {
    const files = readAllTs(encoderDir).concat(readAllTs(hostDir));
    for (const { file, content } of files) {
      const lowered = content.toLowerCase();
      for (const token of ["microphone", "loopback", "getusermedia", "text-to-speech", "unreal", "synthesize"]) {
        assert.ok(!lowered.includes(token), `${file} contains '${token}'`);
      }
      assert.ok(!content.includes("aac"), `${file} contains audio codec token`);
    }
  });
});

describe("P9.3: P9.1 contract unchanged", () => {
  it("frozen profile and descriptor invariants still hold", async () => {
    assert.ok(
      EncoderDescriptorSchema.safeParse({
        family: "NVENC",
        profile: "nvenc-p4-cq23",
        profile_version: "1.0",
        fallback_used: false,
        encoder_version: "8.1.1",
      }).success,
    );
    assert.equal(
      EncoderDescriptorSchema.safeParse({
        family: "LIBX264",
        profile: "libx264-veryfast-crf21",
        profile_version: "1.0",
        fallback_used: true,
        encoder_version: "8.1.1",
      }).success,
      false,
    );
  });
});

describe("P9.3: P9.2 seam intact", () => {
  it("capture session still opens, pumps, and closes deterministically", () => {
    const test = makeTestSession({ defaultFrames: 3 });
    openAndStart(test);
    assert.equal(test.session.pump(), 3);
    assert.equal(test.session.pendingCount, 3);
    test.session.close();
    assert.equal(test.session.pendingCount, 0);
  });
});
