// P9.6 Real Filesystem Proof — tiny bounded artifacts, KB scale.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 20-22. Proves the
// Main-side file owner end to end with phase-owned temp directories only:
// temp lifecycle → quarantine → atomic publication → cleanup. No real video
// (tiny placeholder bytes stand in for media; digests prove byte identity).
// No gigabytes consumed, no unrelated files touched.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NodeSafetyTakeFiles,
  freeBytesOnVolume,
  resolveTrustedMediaRoots,
} from "../safety-host/take-files.ts";
import { planPublicationTransaction } from "../src/safety/publication.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const proofRoot = join(repoRoot, "temp", "p9.6-fs-proof");

after(() => {
  rmSync(proofRoot, { recursive: true, force: true });
});

function freshScope(name: string): { tempRoot: string; renderRoot: string } {
  const tempRoot = join(proofRoot, name, "temp");
  const renderRoot = join(proofRoot, name, "renders");
  rmSync(join(proofRoot, name), { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  mkdirSync(renderRoot, { recursive: true });
  return { tempRoot, renderRoot };
}

const SESSION = "rec-fs-001";
const TAKE = "t01";
const LESSON = "C01-L001";
const BASE = `${LESSON}--gen1--take${TAKE}`;

function tinyMediaBytes(): Buffer {
  // Deterministic tiny placeholder (not video): 8 KiB patterned bytes.
  const buf = Buffer.alloc(8192);
  for (let i = 0; i < buf.length; i += 1) buf[i] = i % 251;
  return buf;
}

function stagedFor(mediaDigest: string) {
  return {
    manifestJson: `${JSON.stringify({ manifest_version: "1.0", take_id: TAKE } satisfies Record<string, unknown>)}\n`,
    anchorsText: `${JSON.stringify({ take_id: TAKE, video_time_us: 0 })}\n`,
    expectedMediaDigest: mediaDigest,
    lessonId: LESSON,
    takeBaseName: BASE,
  };
}

describe("P9.6: real filesystem proof (KB scale, phase-owned dirs)", () => {
  it("trusted roots resolve from config with safe fallbacks", () => {
    const roots = resolveTrustedMediaRoots({ repoRoot, config: {} });
    assert.equal(roots.tempRoot, join(repoRoot, "temp"));
    assert.equal(roots.renderRoot, join(repoRoot, "renders"));
    const custom = resolveTrustedMediaRoots({
      repoRoot,
      config: { tempRoot: "E:\\course-factory\\temp", renderRoot: "E:\\course-factory\\renders" },
    });
    assert.equal(custom.tempRoot, "E:\\course-factory\\temp");
  });

  it("free-space query returns a positive number on this machine", () => {
    const free = freeBytesOnVolume(join(repoRoot, "temp"));
    assert.ok(free === null || (Number.isInteger(free) && free > 0));
    // Evidence runs on a healthy rig: the gate proves the numeric path.
    assert.ok(typeof free === "number" && free > 0);
  });

  it("temp lifecycle: create, purge, confirmed", async () => {
    const { tempRoot, renderRoot } = freshScope("lifecycle");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const dir = files.takeTempDir(SESSION, TAKE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screen.partial.mp4"), tinyMediaBytes());
    assert.equal(existsSync(join(dir, "screen.partial.mp4")), true);
    assert.equal(await files.purgeTakeTemp({ recordingSessionId: SESSION, takeId: TAKE }), "CONFIRMED");
    assert.equal(existsSync(dir), false);
  });

  it("quarantine renames the partial inside TEMP and never the delivery root", async () => {
    const { tempRoot, renderRoot } = freshScope("quarantine");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const dir = files.takeTempDir(SESSION, TAKE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screen.partial.mp4"), tinyMediaBytes());
    writeFileSync(join(dir, "manifest.partial.json"), "{}\n");
    const result = await files.quarantineTakeTemp({ recordingSessionId: SESSION, takeId: TAKE });
    assert.equal(result, "QUARANTINED");
    assert.equal(existsSync(join(dir, "screen.diagnostic.partial.mp4")), true);
    assert.equal(existsSync(join(dir, "screen.partial.mp4")), false);
    assert.equal(existsSync(join(dir, "manifest.partial.json")), false);
    // Nothing reached the delivery root.
    assert.equal(existsSync(join(renderRoot, "intermediate")), false);
  });

  it("quarantine with no partial reports ABSENT", async () => {
    const { tempRoot, renderRoot } = freshScope("quarantine-absent");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    mkdirSync(files.takeTempDir(SESSION, TAKE), { recursive: true });
    assert.equal(await files.quarantineTakeTemp({ recordingSessionId: SESSION, takeId: TAKE }), "ABSENT");
  });

  it("atomic publication: temp set becomes the exact final artifact set", async () => {
    const { tempRoot, renderRoot } = freshScope("publish");
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
    const mp4 = join(finalDir, `${BASE}.mp4`);
    const manifest = join(finalDir, `${BASE}.manifest.json`);
    const anchors = join(finalDir, `${BASE}.anchors.jsonl`);
    assert.equal(existsSync(mp4), true);
    assert.equal(existsSync(manifest), true);
    assert.equal(existsSync(anchors), true);
    // Digest preserved across the same-volume rename (byte-identical).
    assert.equal(createHash("sha256").update(readFileSync(mp4)).digest("hex"), digest);
    assert.equal(existsSync(join(dir, "screen.partial.mp4")), false);
    // Manifest and anchors refer to the same take.
    assert.ok(readFileSync(manifest, "utf8").includes(TAKE));
    assert.ok(readFileSync(anchors, "utf8").includes(TAKE));
  });

  it("digest mismatch fails the media rename and leaves no final", async () => {
    const { tempRoot, renderRoot } = freshScope("digest-mismatch");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const dir = files.takeTempDir(SESSION, TAKE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "screen.partial.mp4"), tinyMediaBytes());
    files.setStagedContent(stagedFor("0".repeat(64)));
    assert.equal(
      (await files.runPublicationStep("WRITE_MANIFEST_TEMP", { recordingSessionId: SESSION, takeId: TAKE })).ok,
      true,
    );
    assert.equal(
      (await files.runPublicationStep("WRITE_ANCHORS_TEMP", { recordingSessionId: SESSION, takeId: TAKE })).ok,
      true,
    );
    const renamed = await files.runPublicationStep("RENAME_MEDIA", { recordingSessionId: SESSION, takeId: TAKE });
    assert.equal(renamed.ok, false);
    assert.equal(existsSync(join(renderRoot, "intermediate", "screen", LESSON, `${BASE}.mp4`)), false);
  });

  it("rollback removes renamed finals (no false complete set)", async () => {
    const { tempRoot, renderRoot } = freshScope("rollback");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
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
    assert.equal(
      (await files.runPublicationStep("RENAME_MEDIA", { recordingSessionId: SESSION, takeId: TAKE })).ok,
      true,
    );
    // Simulate a manifest rename failure, then roll back the media rename.
    assert.equal(await files.removePublished({ recordingSessionId: SESSION, takeId: TAKE }), "CONFIRMED");
    assert.equal(existsSync(join(renderRoot, "intermediate", "screen", LESSON, `${BASE}.mp4`)), false);
  });

  it("path traversal rejected with safe codes (no paths leaked)", async () => {
    const { tempRoot, renderRoot } = freshScope("traversal");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    for (const bad of ["../evil", "t01/../../x", "..\\evil"]) {
      assert.throws(() => files.takeTempDir("rec-ok-001", bad), /\[INVALID_REQUEST\]/);
    }
    assert.throws(() => files.takeTempDir("../evil", TAKE), /\[INVALID_REQUEST\]/);
    assert.throws(() => files.finalTakeDir("../../evil"), /\[INVALID_REQUEST\]/);
    assert.throws(() => files.finalTakeDir("NOT-A-LESSON"), /\[INVALID_REQUEST\]/);
  });

  it("orphan sweep purges stale partials and ignores foreign files", () => {
    const { tempRoot, renderRoot } = freshScope("sweep");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const staleDir = join(tempRoot, "recording", "rec-stale-001", "t01");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "screen.partial.mp4"), tinyMediaBytes());
    writeFileSync(join(staleDir, "user-notes.txt"), "do not touch\n");
    writeFileSync(join(staleDir, "take.lock"), "{}\n");
    const report = files.sweepOrphans({
      activeSessionId: null,
      activeTakeId: null,
      policy: { staleDisposition: "PURGE" },
    });
    assert.equal(report.scanned, 3);
    assert.equal(report.purged, 2);
    assert.equal(report.ignored, 1);
    assert.equal(existsSync(join(staleDir, "screen.partial.mp4")), false);
    assert.equal(existsSync(join(staleDir, "take.lock")), false);
    assert.equal(existsSync(join(staleDir, "user-notes.txt")), true);
  });

  it("orphan sweep preserves the active take dir", () => {
    const { tempRoot, renderRoot } = freshScope("sweep-active");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const activeDir = join(tempRoot, "recording", "rec-live-001", "t01");
    mkdirSync(activeDir, { recursive: true });
    writeFileSync(join(activeDir, "screen.partial.mp4"), tinyMediaBytes());
    const report = files.sweepOrphans({
      activeSessionId: "rec-live-001",
      activeTakeId: "t01",
      policy: { staleDisposition: "PURGE" },
    });
    assert.equal(report.keptActive, 1);
    assert.equal(report.purged, 0);
    assert.equal(existsSync(join(activeDir, "screen.partial.mp4")), true);
  });

  it("sweep is idempotent (second run finds less work, same policy)", () => {
    const { tempRoot, renderRoot } = freshScope("sweep-idem");
    const files = new NodeSafetyTakeFiles({ tempRoot, renderRoot });
    const staleDir = join(tempRoot, "recording", "rec-stale-002", "t02");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "screen.partial.mp4"), tinyMediaBytes());
    const first = files.sweepOrphans({
      activeSessionId: null,
      activeTakeId: null,
      policy: { staleDisposition: "PURGE" },
    });
    const second = files.sweepOrphans({
      activeSessionId: null,
      activeTakeId: null,
      policy: { staleDisposition: "PURGE" },
    });
    assert.equal(first.purged, 1);
    assert.equal(second.purged, 0);
  });

  it("proof scope stays bounded (random temp name is unique per run)", () => {
    const marker = randomBytes(4).toString("hex");
    const dir = join(proofRoot, `scope-${marker}`);
    mkdirSync(dir, { recursive: true });
    assert.ok(readdirSync(proofRoot).includes(`scope-${marker}`));
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false);
  });
});
