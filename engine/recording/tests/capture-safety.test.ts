// P9.2 backend safety + freeze tests (matrix items 35-40).
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 2, 6-7, 18 and
// ADR-0014. Proves: zero frame disk writes, zero FFmpeg/encoder scope,
// zero IPC, P9.1 protocol unchanged, and deterministic cleanup.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeWgcAddon } from "../src/capture/native-loader.ts";
import { NativeCapabilitySchema } from "../src/capture/capture-capability.ts";
import { RECORDING_PROTOCOL_VERSION } from "../src/protocol.ts";
import {
  MAX_MANIFEST_BYTES,
  RECORDING_MANIFEST_VERSION,
  buildCanonicalManifest,
} from "../src/manifest.ts";
import {
  FRAME_INTERVAL_US,
  FRAME_SEQ_INITIAL,
  MAX_SIDECAR_BYTES,
} from "../src/timeline.ts";
import {
  RECORDING_FPS,
  RECORDING_HEIGHT,
  RECORDING_WIDTH,
} from "../src/encoder-profile.ts";
import { makeManifestSeed } from "./fixtures.ts";
import { makeTestSession, openAndStart } from "./capture-helpers.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(__dirname, "..", "src");
const nativeDir = join(__dirname, "..", "native", "wgc", "src");

function readAll(dir: string, extension: string): { file: string; content: string }[] {
  const out: { file: string; content: string }[] = [];
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    if (entry.endsWith(extension)) {
      const file = join(dir, entry);
      out.push({ file, content: readFileSync(file, "utf8") });
    }
  }
  return out;
}

describe("P9.2: zero frame disk writes", () => {
  it("no frame/file-write tokens in TypeScript capture source", () => {
    const files = readAll(join(srcDir, "capture"), ".ts");
    assert.ok(files.length > 0);
    const forbidden = [
      "writeFileSync",
      "appendFileSync",
      "createWriteStream",
      "openSync",
      "writeFile(",
      ".png",
      ".bmp",
      "rawvideo",
      "frame cache",
      "frame dump",
    ];
    for (const { file, content } of files) {
      for (const token of forbidden) {
        assert.ok(!content.includes(token), `${file} contains '${token}'`);
      }
    }
  });

  it("no file-write APIs in native capture source", () => {
    const files = readAll(nativeDir, ".cc").concat(readAll(nativeDir, ".h"));
    assert.ok(files.length > 0);
    const forbidden = [
      "fopen",
      "ofstream",
      "CreateFile",
      "WriteFile",
      "<fstream>",
      "fprintf",
      ".png",
      ".bmp",
    ];
    for (const { file, content } of files) {
      for (const token of forbidden) {
        assert.ok(!content.includes(token), `${file} contains '${token}'`);
      }
    }
  });
});

describe("P9.2: no FFmpeg, no encoder, no IPC", () => {
  it("no media-process tokens in capture source", () => {
    const files = readAll(join(srcDir, "capture"), ".ts");
    const forbidden = [
      "ffmpeg",
      "ffprobe",
      "libx264",
      "h264_nvenc",
      "child_process",
      "spawn(",
      "execFile(",
      "execSync(",
      "shell:",
      "mp4",
      "yuv420p",
    ];
    for (const { file, content } of files) {
      const lowered = content.toLowerCase();
      for (const token of forbidden) {
        assert.ok(
          !content.includes(token) && !lowered.includes(token.toLowerCase()),
          `${file} contains '${token}'`,
        );
      }
    }
  });

  it("no encoder tokens in native source (P9.3 owns encoding)", () => {
    const files = readAll(nativeDir, ".cc");
    for (const { file, content } of files) {
      for (const token of ["ffmpeg", "ffprobe", "libx264", "avcodec", "mp4"]) {
        assert.ok(
          !content.toLowerCase().includes(token),
          `${file} contains '${token}'`,
        );
      }
    }
  });

  it("no Electron or IPC tokens in capture source", () => {
    const files = readAll(join(srcDir, "capture"), ".ts");
    for (const { file, content } of files) {
      for (const token of [
        "from \"electron\"",
        "from 'electron'",
        "ipcMain",
        "ipcRenderer",
        "desktopCapturer",
        "preload",
      ]) {
        assert.ok(!content.includes(token), `${file} contains '${token}'`);
      }
    }
  });

  it("no sibling product imports in capture source", () => {
    const files = readAll(join(srcDir, "capture"), ".ts");
    for (const { file, content } of files) {
      assert.ok(
        !/@course-factory\/(lesson-compiler|shared-types|terminal-engine|workspace|browser-engine)/.test(
          content,
        ),
        `${file} imports a sibling product package`,
      );
      assert.ok(
        !/runtime-orchestrator/.test(content),
        `${file} imports the P8 orchestrator`,
      );
    }
  });
});

describe("P9.2: P9.1 protocol and manifest frozen", () => {
  it("frozen contract values unchanged", () => {
    assert.equal(RECORDING_PROTOCOL_VERSION, 1);
    assert.equal(RECORDING_MANIFEST_VERSION, "1.1");
    assert.equal(MAX_MANIFEST_BYTES, 65536);
    assert.equal(MAX_SIDECAR_BYTES, 5242880);
    assert.equal(FRAME_INTERVAL_US, 33334);
    assert.equal(RECORDING_WIDTH, 1920);
    assert.equal(RECORDING_HEIGHT, 1080);
    assert.equal(RECORDING_FPS, 30);
    assert.equal(FRAME_SEQ_INITIAL, 1);
  });

  it("canonical manifest still builds and validates", () => {
    const manifest = buildCanonicalManifest(makeManifestSeed());
    assert.equal(manifest.manifest_version, "1.1");
    assert.equal(manifest.video_width, 1920);
    assert.equal(manifest.video_height, 1080);
  });
});

describe("P9.2: deterministic cleanup", () => {
  it("close releases driver, token, queue, listeners, and the session slot", () => {
    const test = makeTestSession({ defaultFrames: 3 });
    openAndStart(test);
    test.session.pump();
    let sourceCalls = 0;
    let geometryCalls = 0;
    test.session.onSourceClosed(() => {
      sourceCalls += 1;
    });
    test.session.onGeometryChange(() => {
      geometryCalls += 1;
    });
    assert.equal(test.session.pendingCount, 3);
    test.session.close();
    assert.equal(test.driver.closeCalls, 1);
    assert.equal(test.session.pendingCount, 0);
    assert.equal(test.session.pump(), 0);
    assert.equal(test.session.take(), undefined);
    assert.equal(sourceCalls, 0);
    assert.equal(geometryCalls, 0);
    assert.throws(() => test.registry.resolve(test.token));
    // The workstation slot is free for the next take.
    const next = makeTestSession();
    next.session.open();
    next.session.start();
    assert.equal(next.session.stats().state, "started");
    next.session.close();
  });
});

describe("P9.2: native loader seam", () => {
  it("loader reports a deterministic result without throwing", () => {
    const result = loadNativeWgcAddon();
    if (result.loaded) {
      assert.equal(result.driver.driverName, "wgc-native");
      const capability = result.driver.probe();
      assert.deepEqual(NativeCapabilitySchema.parse(capability), capability);
      assert.equal(capability.backend, "wgc-window");
      result.driver.close();
    } else {
      assert.ok(result.reason.length > 0);
    }
  });
});
