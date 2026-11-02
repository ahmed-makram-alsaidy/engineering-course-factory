// P9.4 Anchor Writer Sink & Manifest Timeline Summary.
//
// Canonical authority: docs/P9-DESIGN-SPEC.md Sections 12, 14-15, 19 and
// P9.1 timeline.ts (sidecar contract) + manifest.ts (AnchorSummary).
//
// Bounded in-memory sink: streams anchors as canonical JSONL lines
// (sorted keys, LF, no BOM, strict schema) while enforcing continuously:
//   - per-line <= 4 KiB
//   - total <= 5 MiB
// Append is atomic at the line level: a full canonical line + LF is
// committed or the write fails safely (never a partially valid line, never
// a silent skip — failures propagate as TIMELINE_INVALID so the coordinator
// latches instead of publishing misleading anchors).
//
// Physical file append (<take>.anchors.jsonl under
// tempRoot/recording/<recording_session_id>/<take>/) is P9.5/P9.6
// composition: it must write each line from serializeAnchorLine atomically
// (one write call per line + LF, UTF-8, LF, no BOM) and enforce the same
// bounds continuously. This module owns the serialization truth and the
// manifest summary helper; it performs zero filesystem I/O, zero processes,
// zero Electron, zero clock reads.
//
// Manifest helper builds the exact P9.1 AnchorSummary shape
// (anchor_count, first/last_video_time_us, journal_high_seq_start/end,
// anchors_sha256) for future manifest finalization. Timeline status
// (ACTIVE / RESET_INTERRUPTED / TIMELINE_INVALID) is reported separately
// and never enters the manifest.

import { createHash } from "node:crypto";
import {
  MAX_ANCHOR_LINE_BYTES,
  MAX_SIDECAR_BYTES,
  serializeAnchorLine,
  type RecordingTimelineAnchor,
} from "./timeline.ts";
import type { AnchorSummary } from "./manifest.ts";

export const WRITER_MAX_LINE_BYTES = MAX_ANCHOR_LINE_BYTES;
export const WRITER_MAX_TOTAL_BYTES = MAX_SIDECAR_BYTES;

export interface AnchorWriterStats {
  readonly anchor_count: number;
  readonly bytes: number;
}

/**
 * Bounded anchor sink. Append-only; no removal, no reordering, no mutation
 * of committed lines. Memory is bounded by the sidecar ceiling (<= 5 MiB of
 * line bytes plus fixed per-anchor object overhead for the retained anchor
 * list, which the coordinator caps by the same ceiling).
 */
export class BoundedAnchorWriter {
  private lines: string[] = [];
  private bytes = 0;

  get anchorCount(): number {
    return this.lines.length;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  stats(): AnchorWriterStats {
    return { anchor_count: this.lines.length, bytes: this.bytes };
  }

  /**
   * Appends one anchor as a full canonical line + LF. Throws
   * [TIMELINE_INVALID] or [ANCHOR_LINE_TOO_LARGE] without mutating state
   * when the line or total bound would be exceeded.
   */
  append(anchor: RecordingTimelineAnchor): string {
    const line = serializeAnchorLine(anchor);
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > WRITER_MAX_LINE_BYTES) {
      throw new Error(
        `[TIMELINE_INVALID] anchor line exceeds per-line bound (${lineBytes} bytes)`,
      );
    }
    if (this.bytes + lineBytes > WRITER_MAX_TOTAL_BYTES) {
      throw new Error(
        `[TIMELINE_INVALID] anchors sidecar would exceed total bound`,
      );
    }
    this.lines.push(line);
    this.bytes += lineBytes;
    return line;
  }

  /** Serialized sidecar text (concatenated lines, LF-terminated, no BOM). */
  sidecarText(): string {
    return this.lines.join("");
  }

  /** Retained anchors in commit order (read-only copy for P10 seam/tests). */
  anchors(): readonly RecordingTimelineAnchor[] {
    return [...this.lines.map((line) => JSON.parse(line) as RecordingTimelineAnchor)];
  }

  /** SHA-256 (lowercase hex) over the serialized sidecar bytes. */
  sidecarSha256(): string {
    return createHash("sha256").update(this.sidecarText(), "utf8").digest("hex");
  }
}

/**
 * Builds the exact P9.1 AnchorSummary from committed anchors + sidecar text.
 * Empty anchor list maps to the canonical zero summary (count 0, times 0,
 * seqs 0, sha of empty string) so manifest invariants hold before the first
 * event. Throws [TIMELINE_INVALID] on ordering violations (defense in depth;
 * the coordinator enforces ordering at commit time).
 */
export function buildAnchorSummary(
  anchors: readonly RecordingTimelineAnchor[],
  sidecarText: string,
): AnchorSummary {
  const digest = createHash("sha256").update(sidecarText, "utf8").digest("hex");
  if (anchors.length === 0) {
    return {
      anchor_count: 0,
      first_video_time_us: 0,
      last_video_time_us: 0,
      journal_high_seq_start: 0,
      journal_high_seq_end: 0,
      anchors_sha256: digest,
    };
  }
  let firstSeq = anchors[0]!.global_seq;
  let lastSeq = anchors[0]!.global_seq;
  let firstTime = anchors[0]!.video_time_us;
  let lastTime = anchors[0]!.video_time_us;
  for (let i = 1; i < anchors.length; i += 1) {
    const a = anchors[i]!;
    if (a.global_seq <= lastSeq) {
      throw new Error("[TIMELINE_INVALID] anchor summary requires strictly increasing seq");
    }
    if (a.video_time_us < lastTime) {
      throw new Error("[TIMELINE_INVALID] anchor summary requires non-decreasing video time");
    }
    lastSeq = a.global_seq;
    lastTime = a.video_time_us;
  }
  void firstSeq;
  return {
    anchor_count: anchors.length,
    first_video_time_us: firstTime,
    last_video_time_us: lastTime,
    journal_high_seq_start: anchors[0]!.global_seq,
    journal_high_seq_end: lastSeq,
    anchors_sha256: digest,
  };
}
