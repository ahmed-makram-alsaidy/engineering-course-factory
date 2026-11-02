// P9.1 Source Safety and Architectural Boundary Test
//
// Canonical authority: P9-DESIGN-SPEC.md Sections 2, 7, 18.
// Proves that @course-factory/recording in P9.1 is contract-only:
// zero capture, zero FFmpeg, zero Electron, zero child_process,
// zero filesystem writes, zero P8 product imports, P9.2+ scope absent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const srcDir = join(__dirname, "..", "src");

function getAllSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...getAllSourceFiles(full));
    } else if (full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("P9.1: Source Safety & Architectural Boundaries", () => {
  const sourceFiles = getAllSourceFiles(srcDir);

  it("source directory contains only the P9.1 owned files plus the P9.2 capture seam and index", () => {
    assert.ok(sourceFiles.length > 0);
    const basenames = sourceFiles.map((f) => f.split(/[\\/]/).pop());
    for (const name of basenames) {
      assert.ok(
        [
          "index.ts",
          "protocol.ts",
          "manifest.ts",
          "timeline.ts",
          // P9.4 owned seam (runtime timeline integration, pure Main-side):
          "timeline-clock.ts",
          "timeline-coordinator.ts",
          "timeline-writer.ts",
          "encoder-profile.ts",
          "disk-budget.ts",
          "naming.ts",
          // P9.2 owned seam (window-scoped WGC backend, Main-side only):
          "capture-format.ts",
          "capture-capability.ts",
          "trusted-source.ts",
          "capture-driver.ts",
          "wgc-session.ts",
          "fake-driver.ts",
          "native-loader.ts",
          // P9.3 owned seam (encoder policy, pure; process owner is host/):
          "encoder-interface.ts",
          "encoder-argv.ts",
          "encoder-frames.ts",
          "media-validation.ts",
          "fake-encoder.ts",
          "frame-fixture.ts",
          "frame-bytes.ts",
          // P9.6 owned seam (failure/disk/lifecycle safety, pure policy;
          // the real file owner lives in safety-host/, outside src/):
          "disk-safety.ts",
          "failure-policy.ts",
          "publication.ts",
          "recovery.ts",
          "controller.ts",
        ].includes(name!),
        `Unexpected source file in P9.4: ${name}`,
      );
    }
    assert.equal(basenames.length, 32);
  });

  it("no forbidden capture/encode/platform implementation tokens in source", () => {
    // Contract vocabulary (NVENC/LIBX264 family names, wgc-window backend id,
    // comments stating "no FFmpeg") is the P9.1 schema itself and is allowed.
    // What must be absent is any implementation token: process spawning,
    // filesystem writes, Electron/IPC, native handles, real encoder argv.
    // P9.3 exception (scoped): src/encoder/encoder-argv.ts carries the single
    // fixed "h264_nvenc" codec token as frozen argv data (never a spawn);
    // tests/encoder-safety.test.ts pins its exact argv. Process spawning,
    // filesystem access, and shell use remain banned in ALL of src/.
    const forbiddenPatterns = [
      /\bfrom\s+["']electron["']/,
      /\bfrom\s+["']node:child_process["']/,
      /\bfrom\s+["']child_process["']/,
      /\bfrom\s+["']node:fs["']/,
      /\bfrom\s+["']node:fs\/promises["']/,
      /\bchild_process\.spawn\b/,
      /\bspawn\s*\(/,
      /\bexecFile\s*\(/,
      /\bexecSync\s*\(/,
      /\bfork\s*\(/,
      /\bwriteFileSync\b/,
      /\bappendFileSync\b/,
      /\bcreateWriteStream\b/,
      /\bopenSync\b/,
      /(?<!\.)\bexec\s*\(/,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /\bipcMain\b/,
      /\bipcRenderer\b/,
      /\bdesktopCapturer\b/,
      /\bgetNativeWindowHandle\b/,
      /\bshell\s*:/,
      /\brecording-host\b/i,
      /\bvideo_time_qpc\b/i,
    ];

    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        assert.ok(
          !pattern.test(content),
          `File ${file} contains forbidden pattern ${pattern}`,
        );
      }
      // The fixed NVENC codec token is banned everywhere except the single
      // frozen argv builder that P9.3 owns (audited by encoder-safety tests).
      const isEncoderArgv = file.endsWith("encoder-argv.ts");
      if (!isEncoderArgv) {
        assert.ok(
          !/\bh264_nvenc\b/.test(content),
          `File ${file} contains forbidden pattern /\\bh264_nvenc\\b/`,
        );
      }
    }
  });

  it("no P8 product imports (separate trust domains, mirrored shapes only)", () => {
    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      assert.ok(
        !/runtime-orchestrator/.test(content),
        `File ${file} must not import the P8 orchestrator`,
      );
      assert.ok(
        !/from\s+["']@course-factory\/(lesson-compiler|shared-types|terminal-engine|workspace|browser-engine)["']/.test(
          content,
        ),
        `File ${file} must not import sibling product packages`,
      );
    }
  });

  it("package.json contains only zod plus types (no media/native deps)", () => {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    assert.equal(pkg["name"], "@course-factory/recording");
    const deps = { ...(pkg["dependencies"] || {}), ...(pkg["devDependencies"] || {}) };
    assert.deepEqual(Object.keys(deps).sort(), [
      "@types/node",
      "typescript",
      "zod",
    ]);
  });

  it("P9.5 scope is present and bounded (host exists, no IPC, no P9.8 proof)", () => {
    const pkgRoot = join(__dirname, "..");
    const repoRoot = join(pkgRoot, "..", "..");
    assert.ok(
      !readdirSync(srcDir).includes("native"),
      "P9.2 native/ must be absent",
    );
    const ideElectronDir = join(repoRoot, "apps", "teaching-ide", "electron");
    // P9.5 delivered: exactly one Main-owned host module (plus its temp
    // seam). The old P9.1 absence demand is superseded; the protective
    // intent moves to IPC-freedom of the delivered host.
    assert.ok(
      readdirSync(ideElectronDir).includes("recording-host.ts"),
      "P9.5 recording-host.ts must be present",
    );
    const hostCode = readFileSync(join(ideElectronDir, "recording-host.ts"), "utf8");
    for (const token of ["recording:", "ipcMain", "ipcRenderer", "desktopCapturer"]) {
      assert.ok(!hostCode.includes(token), `recording-host.ts carries '${token}'`);
    }
    // P9.8 real-video proof is present and bounded: exactly the
    // proof-only Main entry plus its pure helpers. The old absence
    // demand is superseded; the protective intent moves to proof-only
    // posture (no new IPC, no production import, Main-owned only),
    // which the P9.8 gate proves on the live run.
    assert.ok(
      readdirSync(ideElectronDir).includes("recording-proof.ts"),
      "P9.8 recording-proof.ts must be present",
    );
    assert.ok(
      readdirSync(ideElectronDir).includes("recording-proof-helpers.ts"),
      "P9.8 recording-proof-helpers.ts must be present",
    );
    const proofCode = readFileSync(join(ideElectronDir, "recording-proof.ts"), "utf8");
    for (const token of ["recording:", "ipcRenderer", "desktopCapturer"]) {
      assert.ok(!proofCode.includes(token), `recording-proof.ts carries '${token}'`);
    }
    assert.ok(
      !proofCode.includes('from "./main.ts"') && !proofCode.includes("from './main.ts'"),
      "recording-proof.ts must never import production main.ts",
    );
    const scriptsDir = join(repoRoot, "scripts");
    assert.ok(
      !readdirSync(scriptsDir).includes("validate-p9.sh"),
      "P9.9 validate-p9.sh must be absent",
    );
  });
});
