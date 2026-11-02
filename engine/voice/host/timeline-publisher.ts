// P10.5 Voice Timeline Host Publisher
//
// Canonical authority: docs/P10-DESIGN-SPEC.md Section 20, 27 and
// docs/adr/ADR-0015-voice-generation-boundary.md Section 10, 14.
//
// Manages atomic publication of VoiceTimeline metadata and assembled lesson tracks
// under the controlled P10 voiceAssemblyRoot (Class RENDERS):
//   D:\course-factory\renders\intermediate\voice\<course_id>\<lesson_id>\
//     ├── voice-timeline.json
//     └── narration-track.wav
//
// Invariants:
// - Atomic publication via same-volume temporary staging and rename.
// - Disk preflight safety check (minimum 2 GiB free).
// - Rejects traversal (..) and unconfined paths.
// - Cancellation cleans up staging and leaves zero partial publication artifacts.
// - Zero renderer authority, zero credentials, zero absolute paths in artifacts.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parseVoiceTimeline,
  serializeVoiceTimeline,
  type VoiceTimeline,
  VoiceTimelineSchema,
} from "../src/timeline.ts";
import { parseWavHeader } from "../src/wav.ts";
import {
  assertContainedWithinRoot,
  assertSufficientDiskSpace,
  MIN_FREE_DISK_BYTES,
  resolveVoiceStorageRoots,
  type VoiceStorageRoots,
} from "./storage-roots.ts";

export interface TimelinePublisherOptions {
  readonly roots?: Partial<VoiceStorageRoots>;
  readonly minFreeDiskBytes?: number;
}

export interface PublishTimelineResult {
  readonly timelinePath: string;
  readonly lessonDir: string;
  readonly byteLength: number;
}

export interface PublishTrackResult {
  readonly trackPath: string;
  readonly lessonDir: string;
  readonly byteLength: number;
  readonly sampleCount: number;
}

export class VoiceTimelinePublisher {
  private readonly roots: VoiceStorageRoots;
  private readonly minFreeDiskBytes: number;

  constructor(options?: TimelinePublisherOptions) {
    this.roots = resolveVoiceStorageRoots(options?.roots);
    this.minFreeDiskBytes = options?.minFreeDiskBytes ?? MIN_FREE_DISK_BYTES;
  }

  getRoots(): VoiceStorageRoots {
    return { ...this.roots };
  }

  /**
   * Resolves the canonical assembly directory for a lesson:
   * <voiceAssemblyRoot>/<course_id>/<lesson_id>/
   */
  resolveLessonAssemblyDir(courseId: string, lessonId: string): string {
    const rawPath = join(this.roots.voiceAssemblyRoot, courseId, lessonId);
    return assertContainedWithinRoot(this.roots.voiceAssemblyRoot, rawPath);
  }

  /**
   * Atomically publishes a validated VoiceTimeline document to disk.
   */
  async publishTimeline(
    timeline: VoiceTimeline,
    options?: { signal?: AbortSignal },
  ): Promise<PublishTimelineResult> {
    if (options?.signal?.aborted) {
      throw new Error("[TIMELINE_PUBLISH_ABORTED] Operation cancelled before publication");
    }

    const validated = VoiceTimelineSchema.parse(timeline);
    const courseId = validated.course_id ?? validated.lesson_id.split("-")[0] ?? "unknown";
    const lessonDir = this.resolveLessonAssemblyDir(courseId, validated.lesson_id);

    // Preflight disk check
    assertSufficientDiskSpace(this.roots.voiceTempRoot, this.minFreeDiskBytes);

    // Prepare temp staging on the same volume (voiceTempRoot)
    const stagingDirName = `staging-timeline-${validated.lesson_id}-${randomUUID()}`;
    const stagingDir = assertContainedWithinRoot(
      this.roots.voiceTempRoot,
      join(this.roots.voiceTempRoot, stagingDirName),
    );
    mkdirSync(stagingDir, { recursive: true });

    const stagingPath = join(stagingDir, "voice-timeline.json");
    const finalPath = join(lessonDir, "voice-timeline.json");

    try {
      if (options?.signal?.aborted) {
        throw new Error("[TIMELINE_PUBLISH_ABORTED] Operation cancelled during publication");
      }

      const serialized = serializeVoiceTimeline(validated);
      writeFileSync(stagingPath, serialized, "utf8");

      // Verify staged content can be parsed back
      parseVoiceTimeline(readFileSync(stagingPath, "utf8"));

      if (options?.signal?.aborted) {
        throw new Error("[TIMELINE_PUBLISH_ABORTED] Operation cancelled before rename");
      }

      // Ensure destination directory exists
      mkdirSync(lessonDir, { recursive: true });

      // Atomic rename
      renameSync(stagingPath, finalPath);

      // Clean staging directory
      rmSync(stagingDir, { recursive: true, force: true });

      const byteLength = Buffer.byteLength(serialized, "utf8");
      return {
        timelinePath: finalPath,
        lessonDir,
        byteLength,
      };
    } catch (err) {
      // Clean up staging directory on any failure
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
      throw err;
    }
  }

  /**
   * Atomically publishes an assembled PCM WAV track to disk.
   */
  async publishTrack(
    timeline: VoiceTimeline,
    trackWavBuffer: Buffer,
    options?: { signal?: AbortSignal },
  ): Promise<PublishTrackResult> {
    if (options?.signal?.aborted) {
      throw new Error("[TRACK_PUBLISH_ABORTED] Operation cancelled before publication");
    }

    const validated = VoiceTimelineSchema.parse(timeline);
    const wavInfo = parseWavHeader(trackWavBuffer);

    const courseId = validated.course_id ?? validated.lesson_id.split("-")[0] ?? "unknown";
    const lessonDir = this.resolveLessonAssemblyDir(courseId, validated.lesson_id);

    // Preflight disk check
    assertSufficientDiskSpace(this.roots.voiceTempRoot, this.minFreeDiskBytes);

    const stagingDirName = `staging-track-${validated.lesson_id}-${randomUUID()}`;
    const stagingDir = assertContainedWithinRoot(
      this.roots.voiceTempRoot,
      join(this.roots.voiceTempRoot, stagingDirName),
    );
    mkdirSync(stagingDir, { recursive: true });

    const stagingPath = join(stagingDir, "narration-track.wav");
    const finalPath = join(lessonDir, "narration-track.wav");

    try {
      if (options?.signal?.aborted) {
        throw new Error("[TRACK_PUBLISH_ABORTED] Operation cancelled during publication");
      }

      writeFileSync(stagingPath, trackWavBuffer);

      if (options?.signal?.aborted) {
        throw new Error("[TRACK_PUBLISH_ABORTED] Operation cancelled before rename");
      }

      mkdirSync(lessonDir, { recursive: true });
      renameSync(stagingPath, finalPath);
      rmSync(stagingDir, { recursive: true, force: true });

      return {
        trackPath: finalPath,
        lessonDir,
        byteLength: trackWavBuffer.byteLength,
        sampleCount: wavInfo.sampleCount,
      };
    } catch (err) {
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
      throw err;
    }
  }
}
