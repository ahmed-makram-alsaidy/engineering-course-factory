// P9 Storage Relocation Proof — D: recording authority, KB scale.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 20-21, ADR-0005
// (relocation strategy), config/recording-paths.example.json. Proves the
// relocated P9 recording TEMP + FINAL render authority: configured D:
// roots resolve from machine config, stay on one fixed volume, confine
// takes/quarantine/recovery/publication, reject hostile roots, keep disk
// queries on the target volume, and stay unreachable from the renderer.
// Tiny placeholder bytes only (never video); every artifact cleaned.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NodeSafetyTakeFiles,
  RECORDING_PATHS_FILE_NAME,
  freeBytesOnVolume,
  isValidRecordingRoot,
  resolveConfiguredRecordingRoots,
  resolveTrustedMediaRoots,
} from "../safety-host/take-files.ts";
import { planPublicationTransaction } from "../src/safety/publication.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

// Live machine authority (config/recording-paths.json on this rig).
const liveRoots = resolveConfiguredRecordingRoots({ repoRoot });
const LIVE_TEMP = liveRoots.tempRoot;
const LIVE_RENDER = liveRoots.renderRoot;

// Phase-owned proof scopes only (cleaned after every run).
const repoProofRoot = join(repoRoot, "temp", "p9-storage-proof");
const dTemp = join(LIVE_TEMP, "p9-storage-proof");
const dRender = join(LIVE_RENDER, "p9-storage-proof");

after(() => {
  rmSync(repoProofRoot, { recursive: true, force: true });
  rmSync(dTemp, { recursive: true, force: true });
  rmSync(dRender, { recursive: true, force: true });
});

function driveOf(absPath: string): string {
  return resolve(absPath).slice(0, 1).toLowerCase();
}

function freshD(name: string): { tempRoot: string; renderRoot: string } {
  const tempRoot = join(dTemp, name, "temp");
  const renderRoot = join(dRender, name, "renders");
  rmSync(join(dTemp, name), { recursive: true, force: true });
  rmSync(join(dRender, name), { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(renderRoot, { recursive: true });
  return { tempRoot, renderRoot };
}

const SESSION = "rec-store-001";
const TAKE = "t01";
const LESSON = "C01-L001";
const BASE = `${LESSON}--gen1--take${TAKE}`;

function tinyMediaBytes(): Buffer {
  const buf = Buffer.alloc(8192);
  for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 7) % 251;
  return buf;
}

function stagedFor(mediaDigest: string) {
  return {
    manifestJson: `${JSON.stringify({ manifest_version: "1.0", take_id: TAKE })}\n`,
    anchorsText: `${JSON.stringify({ take_id: TAKE, video_time_us: 0 })}\n`,
    expectedMediaDigest: mediaDigest,
    lessonId: LESSON,
    takeBaseName: BASE,
  };
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
      continue;
    }
    try {
      if (readdirSync(full) !== undefined) out.push(...walkTsFiles(full));
    } catch {
      // Not a directory (or unreadable): skip, never throw.
    }
  }
  return out;
}

describe("P9 storage relocation: D: recording authority (KB scale)", () => {
  it("recording temp root resolves to D config", () => {
    assert.equal(RECORDING_PATHS_FILE_NAME, "recording-paths.json");
    const roots = resolveConfiguredRecordingRoots({
      repoRoot,
      recordingConfig: { recordingTempRoot: "D:\\course-factory\\recording-temp" },
      legacyConfig: {},
    });
    assert.equal(roots.tempRoot, "D:\\course-factory\\recording-temp");
    // Live machine file agrees on this rig.
    assert.equal(LIVE_TEMP, "D:\\course-factory\\recording-temp");
  });

  it("render root resolves to D config", () => {
    const roots = resolveConfiguredRecordingRoots({
      repoRoot,
      recordingConfig: { recordingRenderRoot: "D:\\course-factory\\renders" },
      legacyConfig: {},
    });
    assert.equal(roots.renderRoot, "D:\\course-factory\\renders");
    assert.equal(LIVE_RENDER, "D:\\course-factory\\renders");
  });

  it("mirrored tempRoot/renderRoot share the same D: authority", () => {
    const roots = resolveConfiguredRecordingRoots({
      repoRoot,
      recordingConfig: {
        tempRoot: "D:\\course-factory\\recording-temp",
        renderRoot: "D:\\course-factory\\renders",
      },
      legacyConfig: {},
    });
    assert.equal(roots.tempRoot, "D:\\course-factory\\recording-temp");
    assert.equal(roots.renderRoot, "D:\\course-factory\\renders");
  });

  it("both roots share the same volume", () => {
    const roots = resolveConfiguredRecordingRoots({
      repoRoot,
      recordingConfig: {
        recordingTempRoot: "D:\\course-factory\\recording-temp",
        recordingRenderRoot: "D:\\course-factory\\renders",
      },
      legacyConfig: {},
    });
    assert.equal(driveOf(roots.tempRoot), driveOf(roots.renderRoot));
    assert.equal(driveOf(roots.tempRoot), "d");
    assert.equal(driveOf(LIVE_TEMP), driveOf(LIVE_RENDER));
  });

  it("temp take stays inside the recording temp root", () => {
    const { tempRoot, renderRoot } = freshD("take");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const dir = files.takeTempDir(SESSION, TAKE);
    assert.ok(dir.startsWith(resolve(tempRoot) + sep));
    assert.equal(driveOf(dir), driveOf(LIVE_TEMP));
  });

  it("quarantine stays inside the recording temp root", async () => {
    const { tempRoot, renderRoot } = freshD("quarantine");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const dir = files.takeTempDir(SESSION, TAKE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screen.partial.mp4"), tinyMediaBytes());
    assert.equal(
      await files.quarantineTakeTemp({ recordingSessionId: SESSION, takeId: TAKE }),
      "QUARANTINED",
    );
    assert.equal(existsSync(join(dir, "screen.diagnostic.partial.mp4")), true);
    assert.equal(existsSync(join(renderRoot, "intermediate")), false);
    assert.equal(await files.purgeTakeTemp({ recordingSessionId: SESSION, takeId: TAKE }), "CONFIRMED");
  });

  it("recovery scans the configured recording temp only", () => {
    const { tempRoot, renderRoot } = freshD("sweep");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const staleDir = join(tempRoot, "recording", "rec-stale-901", "t09");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "screen.partial.mp4"), tinyMediaBytes());
    // A foreign file beside recording/ is outside the sweep scope.
    writeFileSync(join(tempRoot, "operator-notes.txt"), "do not touch\n");
    // An E:-side orphan the D:-scoped owner must never see.
    const eStaleDir = join(repoProofRoot, "e-plant", "recording", "rec-stale-902", "t09");
    mkdirSync(eStaleDir, { recursive: true });
    writeFileSync(join(eStaleDir, "screen.partial.mp4"), tinyMediaBytes());
    const report = files.sweepOrphans({
      activeSessionId: null,
      activeTakeId: null,
      policy: { staleDisposition: "PURGE" },
    });
    assert.equal(report.purged, 1);
    assert.equal(existsSync(join(staleDir, "screen.partial.mp4")), false);
    assert.equal(existsSync(join(tempRoot, "operator-notes.txt")), true);
    assert.equal(existsSync(join(eStaleDir, "screen.partial.mp4")), true);
  });

  it("publication stays inside the configured render root", async () => {
    const { tempRoot, renderRoot } = freshD("publish");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const media = tinyMediaBytes();
    const digest = createHash("sha256").update(media).digest("hex");
    const dir = files.takeTempDir(SESSION, TAKE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screen.partial.mp4"), media);
    files.setStagedContent(stagedFor(digest));
    for (const step of planPublicationTransaction()) {
      const result = await files.runPublicationStep(step, { recordingSessionId: SESSION, takeId: TAKE });
      assert.equal(result.ok, true, step);
    }
    const finalDir = join(renderRoot, "intermediate", "screen", LESSON);
    assert.equal(files.finalTakeDir(LESSON), finalDir);
    assert.equal(existsSync(join(finalDir, `${BASE}.mp4`)), true);
    assert.equal(existsSync(join(finalDir, `${BASE}.manifest.json`)), true);
    assert.equal(existsSync(join(finalDir, `${BASE}.anchors.jsonl`)), true);
    assert.equal(createHash("sha256").update(readFileSync(join(finalDir, `${BASE}.mp4`))).digest("hex"), digest);
    assert.equal(await files.removePublished({ recordingSessionId: SESSION, takeId: TAKE }), "CONFIRMED");
    assert.equal(await files.purgeTakeTemp({ recordingSessionId: SESSION, takeId: TAKE }), "CONFIRMED");
  });

  it("traversal roots rejected (config + identity)", () => {
    assert.equal(isValidRecordingRoot("D:\\x\\..\\evil"), false);
    const roots = resolveConfiguredRecordingRoots({
      repoRoot,
      recordingConfig: { recordingTempRoot: "D:\\x\\..\\evil" },
      legacyConfig: {},
    });
    assert.equal(roots.tempRoot, join(repoRoot, "temp"));
    const { tempRoot, renderRoot } = freshD("traversal");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    assert.throws(() => files.takeTempDir("a..b", TAKE), /\[INVALID_REQUEST\]/);
    assert.throws(() => files.takeTempDir("../evil", TAKE), /\[INVALID_REQUEST\]/);
  });

  it("UNC roots rejected", () => {
    assert.equal(isValidRecordingRoot("\\\\server\\share\\rec"), false);
    const roots = resolveConfiguredRecordingRoots({
      repoRoot,
      recordingConfig: {
        recordingTempRoot: "\\\\server\\share\\rec",
        recordingRenderRoot: "\\\\server\\share\\renders",
      },
      legacyConfig: {},
    });
    assert.equal(roots.tempRoot, join(repoRoot, "temp"));
    assert.equal(roots.renderRoot, join(repoRoot, "renders"));
  });

  it("relative and empty roots rejected", () => {
    for (const bad of ["recording-temp", "", ".\\rec", "/mnt/rec", 42, null]) {
      assert.equal(isValidRecordingRoot(bad), false);
    }
    const roots = resolveConfiguredRecordingRoots({
      repoRoot,
      recordingConfig: { recordingTempRoot: "recording-temp", recordingRenderRoot: "" },
      legacyConfig: {},
    });
    assert.equal(roots.tempRoot, join(repoRoot, "temp"));
    assert.equal(roots.renderRoot, join(repoRoot, "renders"));
  });

  it("reparse escape rejected on the D: temp root", () => {
    const { tempRoot, renderRoot } = freshD("reparse");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const sessionDir = join(tempRoot, "recording", "rec-junc-001");
    // Sibling of the trusted temp root: outside containment by construction.
    const outside = join(dTemp, "reparse", "outside-target");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "sentinel.txt"), "sentinel\n");
    symlinkSync(outside, join(sessionDir, "t77"), "junction");
    assert.throws(() => files.takeTempDir("rec-junc-001", "t77"), /\[INVALID_REQUEST\]/);
    assert.equal(existsSync(join(outside, "sentinel.txt")), true);
  });

  it("disk query uses the target volume", () => {
    mkdirSync(dTemp, { recursive: true });
    const free = freeBytesOnVolume(dTemp);
    assert.ok(typeof free === "number" && free > 0);
    assert.equal(driveOf(LIVE_TEMP), "d");
  });

  it("E capacity is irrelevant after D config", () => {    // Legacy E: values lose to explicit P9 D: roots by precedence.
    const roots = resolveConfiguredRecordingRoots({
      repoRoot,
      recordingConfig: {
        recordingTempRoot: "D:\\course-factory\\recording-temp",
        recordingRenderRoot: "D:\\course-factory\\renders",
      },
      legacyConfig: {
        tempRoot: "E:\\course-factory\\temp",
        renderRoot: "E:\\course-factory\\renders",
      },
    });
    assert.equal(roots.tempRoot, "D:\\course-factory\\recording-temp");
    assert.equal(roots.renderRoot, "D:\\course-factory\\renders");
    // Legacy E: config still honored when no P9-specific roots exist.
    const legacy = resolveConfiguredRecordingRoots({
      repoRoot,
      recordingConfig: {},
      legacyConfig: { tempRoot: "E:\\course-factory\\temp" },
    });
    assert.equal(legacy.tempRoot, "E:\\course-factory\\temp");
    // And the object-level primitive is unchanged.
    const classic = resolveTrustedMediaRoots({ repoRoot, config: {} });
    assert.equal(classic.tempRoot, join(repoRoot, "temp"));
  });

  it("same-volume publication enforced on D (cross-volume refused)", async () => {
    const { tempRoot } = freshD("same-volume");
    const eRender = join(repoProofRoot, "cross-render");
    mkdirSync(eRender, { recursive: true });
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot: eRender });
    const media = tinyMediaBytes();
    const digest = createHash("sha256").update(media).digest("hex");
    const dir = files.takeTempDir(SESSION, TAKE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screen.partial.mp4"), media);
    files.setStagedContent(stagedFor(digest));
    assert.equal(
      (await files.runPublicationStep("WRITE_MANIFEST_TEMP", { recordingSessionId: SESSION, takeId: TAKE })).ok,
      true,
    );
    assert.equal(
      (await files.runPublicationStep("WRITE_ANCHORS_TEMP", { recordingSessionId: SESSION, takeId: TAKE })).ok,
      true,
    );
    // D: staging -> E: final crosses volumes: refused before any copy.
    const renamed = await files.runPublicationStep("RENAME_MEDIA", { recordingSessionId: SESSION, takeId: TAKE });
    assert.equal(renamed.ok, false);
    assert.equal(existsSync(join(eRender, "intermediate")), false);
    assert.equal(await files.purgeTakeTemp({ recordingSessionId: SESSION, takeId: TAKE }), "CONFIRMED");
  });

  it("renderer cannot override roots", () => {
    const banned = /recordingTempRoot|recordingRenderRoot|recording-paths/;
    const rendererFiles = walkTsFiles(join(repoRoot, "apps", "teaching-ide", "src"));
    assert.ok(rendererFiles.length > 0);
    for (const file of rendererFiles) {
      assert.ok(!banned.test(readFileSync(file, "utf8")), `renderer authority leak: ${file}`);
    }
    for (const file of [
      join(repoRoot, "apps", "teaching-ide", "electron", "preload.ts"),
      join(repoRoot, "apps", "teaching-ide", "electron", "recording-files.ts"),
      join(repoRoot, "apps", "teaching-ide", "electron", "recording-host.ts"),
    ]) {
      assert.ok(!banned.test(readFileSync(file, "utf8")), `electron authority leak: ${file}`);
    }
    assert.throws(
      () => new NodeSafetyTakeFiles({ tempRoot: "", renderRoot: "D:\\course-factory\\renders" }),
      /\[INVALID_REQUEST\]/,
    );
  });
});
