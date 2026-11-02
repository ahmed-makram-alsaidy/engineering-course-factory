// P10.4 Content-Addressed Immutable Voice Cache & Publisher
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 18, 19, 20 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 8, 9, 10.
//
// Cache Semantics:
// - Content-Addressed: cache_key = SHA-256(canonical_json(CacheIdentityPayload)).
// - Prefix Sharding: <voiceCacheRoot>/<prefix>/<cache_key>/ (prefix = 2 hex chars).
// - Artifacts per entry:
//   - audio.wav: Canonical 48 kHz mono 16-bit PCM RIFF WAV.
//   - asset.json: Immutable VoiceAssetMetadata.
//   - alignment.json: NormalizedAlignment (only present when alignment_status !== "none").
// - Immutability: First validated publication is permanently sealed; never overwritten.
// - Atomic Publication: Written to same-volume temp staging, validated, then atomically renamed.
// - Failure Safety: Temp artifacts purged on failure; final cache left clean.
// - Bounded Recovery: Partial or corrupted entries classified CACHE_CORRUPT and purged for 1x retry.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "../src/canonical.ts";
import {
  NormalizedAlignmentSchema,
  VoiceAssetMetadataSchema,
  type NormalizedAlignment,
  type VoiceAssetMetadata,
} from "../src/protocol.ts";
import {
  assertContainedWithinRoot,
  assertSufficientDiskSpace,
  getCacheEntryPaths,
  resolveVoiceStorageRoots,
  type CacheEntryPaths,
} from "./storage-roots.ts";
import { validateVoiceAssetMetadataAgainstBytes } from "./asset-validator.ts";

export type CacheInspectionResult =
  | {
      readonly hit: true;
      readonly asset: VoiceAssetMetadata;
      readonly audioBytes: Buffer;
      readonly alignment: NormalizedAlignment;
      readonly paths: CacheEntryPaths;
    }
  | {
      readonly hit: false;
      readonly reason: "MISS";
      readonly paths: CacheEntryPaths;
    }
  | {
      readonly hit: false;
      readonly reason: "CORRUPT";
      readonly error: string;
      readonly paths: CacheEntryPaths;
    };

export interface VoiceCacheOptions {
  readonly voiceCacheRoot?: string;
  readonly voiceTempRoot?: string;
  readonly minFreeDiskBytes?: number;
}

export class VoiceCache {
  readonly cacheRoot: string;
  readonly tempRoot: string;
  private readonly minFreeDiskBytes?: number;

  constructor(options?: VoiceCacheOptions) {
    const roots = resolveVoiceStorageRoots({
      voiceCacheRoot: options?.voiceCacheRoot,
      voiceTempRoot: options?.voiceTempRoot,
    });
    this.cacheRoot = roots.voiceCacheRoot;
    this.tempRoot = roots.voiceTempRoot;
    this.minFreeDiskBytes = options?.minFreeDiskBytes;

    // Ensure root directories exist
    if (!existsSync(this.cacheRoot)) {
      mkdirSync(this.cacheRoot, { recursive: true });
    }
    if (!existsSync(this.tempRoot)) {
      mkdirSync(this.tempRoot, { recursive: true });
    }
  }

  /**
   * Inspects the cache for a given cache_key.
   * Performs full structural, digest, and 11-point validation if files are present.
   */
  async inspect(cacheKey: string): Promise<CacheInspectionResult> {
    const paths = getCacheEntryPaths(this.cacheRoot, cacheKey);

    if (!existsSync(paths.dirPath)) {
      return { hit: false, reason: "MISS", paths };
    }

    // Partial cache entry checks
    const hasAudio = existsSync(paths.audioPath);
    const hasAsset = existsSync(paths.assetPath);

    if (!hasAudio || !hasAsset) {
      return {
        hit: false,
        reason: "CORRUPT",
        error: `Partial cache entry detected: audio exists=${hasAudio}, metadata exists=${hasAsset}`,
        paths,
      };
    }

    try {
      // Read files
      const audioBytes = readFileSync(paths.audioPath);
      const assetText = readFileSync(paths.assetPath, "utf8");
      const assetJson = JSON.parse(assetText);
      const metadata = VoiceAssetMetadataSchema.parse(assetJson);

      // Validate metadata against audio bytes (checks digest + 11 validation gates)
      validateVoiceAssetMetadataAgainstBytes(metadata, audioBytes);

      // Read optional alignment sidecar
      let alignment: NormalizedAlignment = { status: "none", words: [], phonemes: [] };
      if (metadata.alignment_status !== "none") {
        if (!existsSync(paths.alignmentPath)) {
          return {
            hit: false,
            reason: "CORRUPT",
            error: `Missing required alignment.json for status '${metadata.alignment_status}'`,
            paths,
          };
        }
        const alignmentText = readFileSync(paths.alignmentPath, "utf8");
        const alignmentJson = JSON.parse(alignmentText);
        alignment = NormalizedAlignmentSchema.parse(alignmentJson);
      }

      return {
        hit: true,
        asset: metadata,
        audioBytes,
        alignment,
        paths,
      };
    } catch (err: unknown) {
      return {
        hit: false,
        reason: "CORRUPT",
        error: `Cache verification failed: ${err instanceof Error ? err.message : String(err)}`,
        paths,
      };
    }
  }

  /**
   * Evicts a corrupt cache entry directory. Never touches unrelated cache keys.
   */
  async evict(cacheKey: string): Promise<void> {
    const paths = getCacheEntryPaths(this.cacheRoot, cacheKey);
    if (existsSync(paths.dirPath)) {
      rmSync(paths.dirPath, { recursive: true, force: true });
    }
  }

  /**
   * Atomically publishes a newly synthesized & validated voice asset into the immutable cache.
   *
   * Pattern:
   * 1. Check volume free space preflight.
   * 2. Write artifacts into temporary staging folder on the SAME volume.
   * 3. Validate staged artifacts.
   * 4. Atomic rename staging directory into final immutable cache destination.
   * 5. Clean up staging folder on any error.
   */
  async publish(
    cacheKey: string,
    metadata: VoiceAssetMetadata,
    audioBytes: Buffer,
    alignment?: NormalizedAlignment,
  ): Promise<VoiceAssetMetadata> {
    const paths = getCacheEntryPaths(this.cacheRoot, cacheKey);

    // If already exists and valid, do not overwrite (immutability rule)
    const existing = await this.inspect(cacheKey);
    if (existing.hit) {
      return existing.asset;
    }

    // Disk space preflight check
    assertSufficientDiskSpace(this.tempRoot, this.minFreeDiskBytes);

    // Create unique staging directory on the same volume as cache
    const stagingDirName = `staging-${cacheKey}-${randomUUID()}`;
    const stagingDir = assertContainedWithinRoot(this.tempRoot, `${this.tempRoot}/${stagingDirName}`);
    mkdirSync(stagingDir, { recursive: true });

    const stagingAudioPath = `${stagingDir}/audio.wav`;
    const stagingAssetPath = `${stagingDir}/asset.json`;
    const stagingAlignmentPath = `${stagingDir}/alignment.json`;

    try {
      // 1. Write staging files
      writeFileSync(stagingAudioPath, audioBytes);
      writeFileSync(stagingAssetPath, canonicalJson(metadata), "utf8");

      if (alignment && alignment.status !== "none") {
        writeFileSync(stagingAlignmentPath, canonicalJson(alignment), "utf8");
      }

      // 2. Validate staged files
      validateVoiceAssetMetadataAgainstBytes(metadata, audioBytes);

      // 3. Ensure target parent sharded directory exists
      const targetParent = dirname(paths.dirPath);
      if (!existsSync(targetParent)) {
        mkdirSync(targetParent, { recursive: true });
      }

      // 4. Atomic rename into final location
      try {
        renameSync(stagingDir, paths.dirPath);
      } catch (renameErr: unknown) {
        // If destination was created concurrently by another process/flight
        if (existsSync(paths.dirPath)) {
          const checkConcurrent = await this.inspect(cacheKey);
          if (checkConcurrent.hit) {
            // Concurrent race won cleanly, return accepted immutable asset
            return checkConcurrent.asset;
          }
        }
        throw renameErr;
      }

      return metadata;
    } finally {
      // Always cleanup staging directory if it still exists
      if (existsSync(stagingDir)) {
        try {
          rmSync(stagingDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
}
