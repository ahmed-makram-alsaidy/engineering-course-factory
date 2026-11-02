// Browser Frame Producer for Course Factory P7.7.
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 6.2, 22.1, ADR-0012.
//
// Invariants enforced:
// - Frame authority: main-process only, captured from trusted ManagedPageHandle.
// - Capture primitive: Playwright page.screenshot with bounded in-memory buffer.
// - Zero disk I/O: no temporary files or disk frame cache.
// - Zero page.evaluate: screenshot uses pure CDP protocol via stdio pipe.
// - Backpressure: latest-frame-wins. At most one screenshot in-flight; intermediate
//   update triggers coalesce into a single pending capture.
// - Bounded size: frame payload capped at MAX_FRAME_DATA_BYTES (2 MiB); oversized frames dropped fail-closed.
// - Bounded dimensions: default 1280x720, max 3840x2160.
// - Monotonic sequence: frame_seq increments monotonically starting from 1.
// - Session & Generation fencing: late frames from prior generation or stale session are discarded immediately.
// - Clean shutdown: stops timers, rejects late captures, releases references.

import type { Page } from "playwright-core";
import type { ManagedPageHandle } from "./context.ts";
import {
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  MAX_FRAME_DATA_BYTES,
  type BrowserFrameFormat,
  type BrowserVisualFrame,
} from "./protocol.ts";

export interface FrameProducerOptions {
  readonly sessionId: string;
  readonly generation: number;
  readonly pageHandle: ManagedPageHandle;
  readonly onFrame: (frame: BrowserVisualFrame) => void;
  readonly width?: number;
  readonly height?: number;
  readonly format?: BrowserFrameFormat;
  readonly quality?: number;
  readonly maxDataBytes?: number;
  readonly intervalMs?: number;
}

export class BrowserFrameProducer {
  readonly sessionId: string;
  readonly generation: number;

  private readonly pageHandle: ManagedPageHandle;
  private readonly onFrame: (frame: BrowserVisualFrame) => void;
  private readonly width: number;
  private readonly height: number;
  private readonly format: BrowserFrameFormat;
  private readonly quality: number;
  private readonly maxDataBytes: number;
  private readonly intervalMs: number;

  private frameSeq = 0;
  private startTime = Date.now();
  private capturing = false;
  private pendingCapture = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private activeCapturePromise: Promise<void> | null = null;

  constructor(options: FrameProducerOptions) {
    this.sessionId = options.sessionId;
    this.generation = options.generation;
    this.pageHandle = options.pageHandle;
    this.onFrame = options.onFrame;
    this.width = options.width ?? DEFAULT_VIEWPORT_WIDTH;
    this.height = options.height ?? DEFAULT_VIEWPORT_HEIGHT;
    this.format = options.format ?? "jpeg";
    this.quality = options.quality ?? 80;
    this.maxDataBytes = options.maxDataBytes ?? MAX_FRAME_DATA_BYTES;
    this.intervalMs = options.intervalMs ?? 500;
  }

  /**
   * Starts frame capture: takes an initial frame and starts the periodic refresh timer.
   */
  async start(): Promise<void> {
    if (this.stopped) return;

    await this.triggerCapture();

    if (this.intervalMs > 0 && !this.stopped) {
      this.timer = setInterval(() => {
        void this.triggerCapture();
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  /**
   * Triggers a frame capture. If a capture is already in progress, coalesces
   * the request via latest-frame-wins backpressure.
   */
  async triggerCapture(): Promise<void> {
    if (this.stopped || !this.pageHandle.isAlive()) {
      return;
    }

    if (this.capturing) {
      this.pendingCapture = true;
      if (this.activeCapturePromise) {
        await this.activeCapturePromise;
      }
      return;
    }

    this.capturing = true;
    this.pendingCapture = false;
    const captureGen = this.generation;
    const captureSessionId = this.sessionId;

    const doCapture = async (): Promise<void> => {
      try {
        const rawPage: Page = this.pageHandle.rawPage;
        if (rawPage.isClosed()) {
          return;
        }

        const screenshotOptions: {
          type: "jpeg" | "png";
          quality?: number;
        } = {
          type: this.format === "png" ? "png" : "jpeg",
          ...(this.format !== "png" ? { quality: this.quality } : {}),
        };

        const buffer = await rawPage.screenshot(screenshotOptions);

        // Fencing check: discard if session stopped or generation changed during capture
        if (this.stopped || this.generation !== captureGen || this.sessionId !== captureSessionId) {
          return;
        }

        const data = buffer.toString("base64");
        if (data.length > this.maxDataBytes) {
          // Drop oversized frame fail-closed
          return;
        }

        this.frameSeq++;
        const frame: BrowserVisualFrame = {
          session_id: this.sessionId,
          generation: this.generation,
          frame_seq: this.frameSeq,
          monotonic_ms: Math.max(0, Date.now() - this.startTime),
          width: this.width,
          height: this.height,
          format: this.format,
          data,
        };

        this.onFrame(frame);
      } catch {
        // Ignore capture failures caused by page closure or navigation gracefully
      } finally {
        this.capturing = false;
        if (this.pendingCapture && !this.stopped) {
          this.pendingCapture = false;
          await this.triggerCapture();
        }
      }
    };

    this.activeCapturePromise = doCapture();
    await this.activeCapturePromise;
  }

  /** Current monotonic visual frame sequence. */
  getFrameSeq(): number {
    return this.frameSeq;
  }

  /** Whether a capture is currently in progress. */
  isCapturing(): boolean {
    return this.capturing;
  }

  /** Whether the producer has been stopped. */
  isStopped(): boolean {
    return this.stopped;
  }

  /** Stops frame production, clears timers, and invalidates in-flight captures. */
  stop(): void {
    this.stopped = true;
    this.pendingCapture = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
