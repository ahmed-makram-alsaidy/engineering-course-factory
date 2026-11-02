// P9.4 timeline source safety — Main-side trust boundary.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 2, 7-8, 18 and
// ADR-0014. Proves P9.4 production sources carry no timing authority, no
// renderer input surface, no Electron IPC, no P8 mutation calls, no runtime
// execution, and no P9.5/FFmpeg/WGC implementation. Documentation mentions
// of absent scope (e.g. "no Date.now", "no P8 mutation") are allowed; what
// is banned is executable usage: calls, imports, and owned implementation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(__dirname, "..", "src");

const P94_FILES = [
  join(srcDir, "timeline-clock.ts"),
  join(srcDir, "timeline-coordinator.ts"),
  join(srcDir, "timeline-writer.ts"),
];

function readP94(): Array<{ file: string; content: string }> {
  return P94_FILES.map((file) => ({ file, content: readFileSync(file, "utf8") }));
}

/** Strips // comment lines so documentation of absent scope stays allowed. */
function codeOnly(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("P9.4: no Date.now authority", () => {
  it("no Date.now authority", () => {
    for (const { file, content } of readP94()) {
      const code = codeOnly(content);
      assert.ok(!code.includes("Date.now("), `${file} calls Date.now`);
      assert.ok(!code.includes("setInterval("), `${file} calls setInterval`);
      assert.ok(!code.includes("performance.now("), `${file} reads performance.now`);
      assert.ok(!code.includes("globalThis.setTimeout"), `${file} arms host timers`);
    }
  });

  it("no renderer timing authority", () => {
    for (const { file, content } of readP94()) {
      assert.ok(!content.includes("desktopCapturer"));
      assert.ok(!content.includes("getUserMedia"));
    }
  });

  it("no IPC", () => {
    for (const { file, content } of readP94()) {
      for (const token of ["ipcMain", "ipcRenderer", "ipcMain.handle", "ipcRenderer.invoke"]) {
        assert.ok(!content.includes(token), `${file} contains '${token}'`);
      }
      assert.ok(!/from\s+["']electron["']/.test(content), `${file} imports electron`);
    }
  });
});

describe("P9.4: no P8 mutation and no scope creep", () => {
  it("P8 unchanged", () => {
    for (const { file, content } of readP94()) {
      assert.ok(!/from\s+["'][^"']*engine\/runtime/.test(content), `${file} imports P8 runtime`);
      assert.ok(!content.includes("new RuntimeJournal("), `${file} constructs P8 journal`);
      assert.ok(!content.includes("new LessonRuntime("), `${file} constructs P8 runtime`);
      assert.ok(!content.includes("playhead.advance("), `${file} advances P8 playhead`);
      assert.ok(!content.includes("journal.commit("), `${file} commits to P8 journal`);
    }
  });

  it("no P8 journal mutation", () => {
    for (const { file, content } of readP94()) {
      assert.ok(!content.includes("startLesson("));
      assert.ok(!content.includes("resetLesson("));
    }
  });

  it("no renderer-provided global_seq or step authority", () => {
    for (const { file, content } of readP94()) {
      assert.ok(!content.includes("ipcRenderer"));
      assert.ok(!content.includes("window.cfApi"));
    }
  });

  it("no voice, audio-track, TTS, or Unreal scope", () => {
    for (const { file, content } of readP94()) {
      assert.ok(!content.includes("TextToSpeech"));
      assert.ok(!content.includes("AudioContext("));
      assert.ok(!content.includes("speak("));
      assert.ok(!/from\s+["'][^"']*unreal/i.test(content));
      assert.ok(!content.includes("class Unreal"));
    }
  });

  it("no P9.5 implementation", () => {
    for (const { file, content } of readP94()) {
      assert.ok(!content.includes("class RecordingHost"));
      assert.ok(!content.includes("ipcMain.handle"));
      assert.ok(!content.includes("BrowserWindow"));
      assert.ok(!content.includes("getNativeWindowHandle("));
    }
  });

  it("no FFmpeg process or WGC backend changes", () => {
    for (const { file, content } of readP94()) {
      assert.ok(!/from\s+["'](node:)?child_process["']/.test(content), `${file} imports child_process`);
      assert.ok(!content.includes("nodeSpawn("));
      assert.ok(!content.includes("execFile("));
      assert.ok(!content.includes("CreateForWindow("));
      assert.ok(!content.includes("TryGetNextFrame"));
    }
  });

  it("no raw QPC public leak", () => {
    for (const { file, content } of readP94()) {
      assert.ok(!content.includes("video_time_qpc"));
      assert.ok(!content.includes("raw_qpc"));
    }
  });
});
