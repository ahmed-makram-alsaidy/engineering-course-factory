// P10.4 Storage Roots & Filesystem Safety Test Suite
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 18, 20, 28.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, parse, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assertContainedWithinRoot,
  assertSufficientDiskSpace,
  getCacheEntryPaths,
  isValidRootCandidate,
  measureFreeDiskBytes,
  MIN_FREE_DISK_BYTES,
  resolveVoiceStorageRoots,
} from "../host/storage-roots.ts";

describe("storage-roots: candidate validation & safety rules", () => {
  it("accepts valid absolute root paths", () => {
    assert.equal(isValidRootCandidate("D:\\course-factory\\voice-cache"), true);
    assert.equal(isValidRootCandidate("C:\\temp\\voice-temp"), true);
  });

  it("rejects relative paths, empty strings, and non-strings", () => {
    assert.equal(isValidRootCandidate(""), false);
    assert.equal(isValidRootCandidate("   "), false);
    assert.equal(isValidRootCandidate("relative/path"), false);
    assert.equal(isValidRootCandidate("./temp"), false);
    assert.equal(isValidRootCandidate(null), false);
    assert.equal(isValidRootCandidate(123), false);
  });

  it("rejects traversal patterns in root candidates", () => {
    assert.equal(isValidRootCandidate("D:\\course-factory\\..\\evil"), false);
    assert.equal(isValidRootCandidate("/var/../etc"), false);
  });

  it("rejects UNC network paths", () => {
    assert.equal(isValidRootCandidate("\\\\server\\share\\voice-cache"), false);
    assert.equal(isValidRootCandidate("//network-host/share"), false);
  });

  it("rejects Windows device paths", () => {
    assert.equal(isValidRootCandidate("\\\\.\\PhysicalDrive0"), false);
    assert.equal(isValidRootCandidate("\\\\.\\COM1"), false);
  });
});

describe("storage-roots: resolution and same-volume invariant", () => {
  it("resolves roots honoring explicit options", () => {
    const customTemp = resolve(tmpdir(), "test-voice-temp");
    const customCache = resolve(tmpdir(), "test-voice-cache");
    const roots = resolveVoiceStorageRoots({
      voiceCacheRoot: customCache,
      voiceTempRoot: customTemp,
    });
    assert.equal(roots.voiceCacheRoot, customCache);
    assert.equal(roots.voiceTempRoot, customTemp);
  });

  it("guarantees tempRoot and cacheRoot are on the same filesystem volume", () => {
    // If caller provided temp on C: and cache on D:, tempRoot is relocated to cacheRoot volume
    const roots = resolveVoiceStorageRoots({
      voiceCacheRoot: "D:\\custom-dir\\voice-cache",
      voiceTempRoot: "C:\\other-drive\\voice-temp",
    });

    const cacheVolume = parse(roots.voiceCacheRoot).root.toLowerCase();
    const tempVolume = parse(roots.voiceTempRoot).root.toLowerCase();
    assert.equal(cacheVolume, tempVolume, "temp and cache roots must share the exact same volume");
  });
});

describe("storage-roots: path confinement and escape prevention", () => {
  it("allows paths safely inside root", () => {
    const root = resolve(tmpdir(), "voice-test-root");
    const safeTarget = join(root, "ab", "abcdef1234");
    const verified = assertContainedWithinRoot(root, safeTarget);
    assert.equal(verified, safeTarget);
  });

  it("rejects paths escaping root via traversal", () => {
    const root = resolve(tmpdir(), "voice-test-root");
    const escapingTarget = join(root, "..", "outside");
    assert.throws(
      () => assertContainedWithinRoot(root, escapingTarget),
      /\[PATH_ESCAPE_DETECTED\]/,
    );
  });
});

describe("storage-roots: cache key sharding & path derivation", () => {
  const validKey = "3d9e87c0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef012345678";

  it("derives deterministic prefix-sharded cache paths", () => {
    const root = "D:\\course-factory\\voice-cache";
    const paths = getCacheEntryPaths(root, validKey);

    assert.equal(paths.prefix, "3d");
    assert.equal(paths.dirPath, resolve(root, "3d", validKey));
    assert.equal(paths.audioPath, resolve(root, "3d", validKey, "audio.wav"));
    assert.equal(paths.assetPath, resolve(root, "3d", validKey, "asset.json"));
    assert.equal(paths.alignmentPath, resolve(root, "3d", validKey, "alignment.json"));
  });

  it("rejects malformed cache keys (wrong length or non-hex)", () => {
    const root = "D:\\course-factory\\voice-cache";
    assert.throws(() => getCacheEntryPaths(root, "short-key"));
    assert.throws(() => getCacheEntryPaths(root, validKey.toUpperCase())); // must be lowercase
    assert.throws(() => getCacheEntryPaths(root, validKey + "extra"));
    assert.throws(() => getCacheEntryPaths(root, "../evil-traversal/".padEnd(64, "0")));
  });
});

describe("storage-roots: disk space preflight & measurement", () => {
  it("measures free bytes on system volume", () => {
    const free = measureFreeDiskBytes(process.cwd());
    assert.equal(typeof free, "number");
    assert.ok(free! > 0);
  });

  it("fails closed when free space is below required minimum threshold", () => {
    const testDir = mkdtempSync(join(tmpdir(), "cf-disk-test-"));
    try {
      // Expect failure if minimum required is impossibly huge (e.g. 100 Petabytes)
      assert.throws(
        () => assertSufficientDiskSpace(testDir, Number.MAX_SAFE_INTEGER),
        /\[LOW_DISK_ABORT\]/,
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("passes when free space meets minimum threshold", () => {
    const testDir = mkdtempSync(join(tmpdir(), "cf-disk-pass-"));
    try {
      // Passing 1024 bytes will succeed on any healthy development disk
      assert.doesNotThrow(() => assertSufficientDiskSpace(testDir, 1024));
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
