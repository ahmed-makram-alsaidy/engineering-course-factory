// P9.7 Teaching IDE recording matrix — host lifecycle, IPC, Electron and
// boundary audits for the full P9 subsystem.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md, ADR-0014, P9.5/P9.6.
// VERIFICATION ONLY: no product code, no real capture, no FFmpeg, no video,
// no wall-clock sleeps. Static source audits plus frozen-constant imports
// prove the Main-owned posture as one subsystem with P9.1–P9.6.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECORDING_HOST_WIDTH,
  RECORDING_HOST_HEIGHT,
  FRAME_PUMP_INTERVAL_MS,
  MAX_FRAMES_PER_TICK,
  READINESS_MAX_PUMPS,
  RECORDING_HOST_SKEW_BOUND_US,
  TIGHT_STRIDE_BYTES_1080P,
} from "../electron/recording-host.ts";
import { TERMINAL_INVOKE_CHANNELS } from "../electron/terminal-host.ts";
import { EDITOR_INVOKE_CHANNELS } from "../electron/editor-host.ts";
import { BROWSER_INVOKE_CHANNELS } from "@course-factory/browser-engine";
import { RUNTIME_INVOKE_CHANNELS } from "../electron/runtime-host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const electronDir = join(here, "..", "electron");

function readElectron(name: string): string {
  return readFileSync(join(electronDir, name), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("P9.7: RecordingHost frozen bounds", () => {
  it("host drives canonical 1080p with bounded pump and skew", () => {
    assert.equal(RECORDING_HOST_WIDTH, 1920);
    assert.equal(RECORDING_HOST_HEIGHT, 1080);
    assert.equal(FRAME_PUMP_INTERVAL_MS, 33);
    assert.equal(MAX_FRAMES_PER_TICK, 8);
    assert.equal(READINESS_MAX_PUMPS, 3);
    assert.equal(RECORDING_HOST_SKEW_BOUND_US, 1_000);
    assert.equal(TIGHT_STRIDE_BYTES_1080P, 1920 * 4);
  });

  it("invoke channel tables still expose the frozen counts", () => {
    assert.equal(TERMINAL_INVOKE_CHANNELS.length, 5);
    assert.equal(EDITOR_INVOKE_CHANNELS.length, 4);
    assert.equal(BROWSER_INVOKE_CHANNELS.length, 4);
    assert.equal(RUNTIME_INVOKE_CHANNELS.length, 6);
  });
});

describe("P9.7: IPC surface unchanged (21 invokes + 1 send + 7 pushes)", () => {
  it("zero recording channels anywhere in electron/", () => {
    for (const file of walk(electronDir)) {
      const content = readFileSync(file, "utf8");
      assert.ok(!content.includes("recording:"), `recording channel in ${file}`);
    }
  });

  it("single renderer send (app:ready) unchanged", () => {
    assert.ok(readElectron("preload.ts").includes('ipcRenderer.send("app:ready"'));
  });

  it("main.ts wires exactly two app invokes and no recording wiring", () => {
    const main = readElectron("main.ts");
    const handles = main.match(/ipcMain\.handle\("[a-z]*:[a-zA-Z]*"/g) ?? [];
    assert.equal(handles.length, 2);
    assert.ok(!main.includes("recording-host"));
    assert.ok(!main.includes("RecordingHost"));
  });

  it("preload exposes no recording surface and no raw ipcRenderer", () => {
    const preload = readElectron("preload.ts");
    assert.ok(!preload.includes("recording"));
    assert.ok(!preload.includes("desktopCapturer"));
    // No generic invoke/send bridge: every channel is a fixed literal.
    assert.ok(!preload.includes("invoke(channel"));
    assert.ok(!preload.includes("send(channel"));
  });
});

describe("P9.7: Electron security posture intact", () => {
  it("sandbox flags frozen with navigation and window-open denial", () => {
    const main = readElectron("main.ts");
    assert.ok(main.includes("contextIsolation: true"));
    assert.ok(main.includes("nodeIntegration: false"));
    assert.ok(main.includes("sandbox: true"));
    assert.ok(main.includes("will-navigate"));
    assert.ok(main.includes("setWindowOpenHandler"));
    assert.ok(main.includes('action: "deny"'));
  });

  it("recording files import nothing from Electron and expose no IPC", () => {
    for (const name of ["recording-host.ts", "recording-files.ts"]) {
      const content = readElectron(name);
      assert.ok(!content.includes('from "electron"'), `${name} electron import`);
      assert.ok(!content.includes("ipcMain"), `${name} ipcMain`);
      assert.ok(!content.includes("ipcRenderer"), `${name} ipcRenderer`);
      assert.ok(!content.includes("desktopCapturer"), `${name} desktopCapturer`);
    }
  });
});

describe("P9.7: P9.8 real proof harness present and bounded", () => {
  it("recording-proof.ts present and bounded with zero MP4 under recording scopes", () => {
    assert.equal(existsSync(join(electronDir, "recording-proof.ts")), true);
    assert.equal(existsSync(join(electronDir, "recording-proof-helpers.ts")), true);
    assert.equal(existsSync(join(repoRoot, "scripts", "build-p98-proof.mjs")), true);
    assert.equal(existsSync(join(repoRoot, "scripts", "validate-p9.sh")), false);
    const proof = readElectron("recording-proof.ts");
    for (const token of ["recording:", "ipcRenderer", "desktopCapturer"]) {
      assert.ok(!proof.includes(token), `recording-proof.ts carries '${token}'`);
    }
    const suspects: string[] = [];
    for (const dir of [electronDir, join(repoRoot, "engine", "recording")]) {
      for (const file of walk(dir)) {
        if (file.endsWith(".mp4")) suspects.push(file);
      }
    }
    assert.deepEqual(suspects, []);
  });
});

describe("P9.7: P8 freeze from the Teaching IDE side", () => {
  it("recording host never mutates the P8 journal or playhead", () => {
    for (const name of ["recording-host.ts", "recording-files.ts"]) {
      const content = readElectron(name);
      for (const token of [
        "journal.append", "playhead.advance", "commitStep",
        "appendGlobalEvent", "advance(proof",
      ]) {
        assert.ok(!content.includes(token), `${name} carries ${token}`);
      }
    }
  });

  it("main.ts and preload.ts untouched since the P9.5 metadata baseline", () => {
    // Proven by git in the gate; here we assert the posture markers that
    // would move first if recording activation wiring landed early: no
    // RecordingHost wiring and no standalone --record driver flag (the
    // pre-existing --record-safe smoke flags are P8 presentation mode).
    const main = readElectron("main.ts");
    assert.ok(!main.includes("recording-host"));
    assert.ok(!main.includes("RecordingHost"));
    assert.ok(!/--record["'\s=]/.test(main));
  });
});

describe("P9.7: P10 and P11 absent from the Teaching IDE scope", () => {
  it("no voice, audio-capture, TTS, or Unreal tokens in recording files", () => {
    for (const name of ["recording-host.ts", "recording-files.ts"]) {
      const content = readElectron(name);
      for (const token of [
        "microphone", "getUserMedia", "TextToSpeech", "speechSynthesis",
        "unreal", "Unreal", "MetaHuman", "LevelSequence",
      ]) {
        assert.ok(!content.includes(token), `${name} carries ${token}`);
      }
    }
  });
});

describe("P9.7: process and filesystem safety from the host side", () => {
  it("owned-handle cleanup only: no global process kill", () => {
    for (const name of ["recording-host.ts", "recording-files.ts"]) {
      const content = readElectron(name).toLowerCase();
      for (const token of ["taskkill", "pkill", "killall", "/im ffmpeg"]) {
        assert.ok(!content.includes(token), `${name} carries ${token}`);
      }
    }
  });

  it("no shell execution and no render-root publication in host files", () => {
    for (const name of ["recording-host.ts", "recording-files.ts"]) {
      const content = readElectron(name);
      assert.ok(!content.includes("shell: true"), `${name} shell:true`);
      assert.ok(!content.includes("shell:true"), `${name} shell:true`);
    }
    const files = readElectron("recording-files.ts");
    assert.ok(!files.includes("renderRoot"));
    assert.ok(!files.includes("renders/final"));
  });
});
