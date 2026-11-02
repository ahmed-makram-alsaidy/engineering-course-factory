// P7.7 Browser Frame Producer Tests: Unit, Backpressure, Fencing & Real Chromium.
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 6.2, 22.1, ADR-0012.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import {
  BrowserFrameProducer,
  type FrameProducerOptions,
} from "../src/frame-producer.ts";
import type { ManagedPageHandle } from "../src/context.ts";
import {
  BrowserRuntimeHost,
  startFixtureServer,
  type FixtureServerInstance,
} from "../src/index.ts";
import {
  MAX_FRAME_DATA_BYTES,
  type BrowserVisualFrame,
} from "../src/protocol.ts";

function createMockPageHandle(options?: {
  screenshotDelayMs?: number;
  screenshotBytes?: number;
  isAlive?: boolean;
}): {
  pageHandle: ManagedPageHandle;
  screenshotCalls: number;
} {
  let callCount = 0;
  const isAlive = options?.isAlive ?? true;
  const delayMs = options?.screenshotDelayMs ?? 0;
  const byteCount = options?.screenshotBytes ?? 1024;

  const rawPage = {
    isClosed: () => !isAlive,
    screenshot: async () => {
      callCount++;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return Buffer.alloc(byteCount, 0x42);
    },
  } as unknown as Page;

  const pageHandle: ManagedPageHandle = {
    pageId: "mock-page-01",
    rawPage,
    isAlive: () => isAlive,
    close: async () => {},
  };

  return {
    pageHandle,
    get screenshotCalls() {
      return callCount;
    },
  };
}

describe("P7.7 Frame Producer: Invariants, Fencing & Backpressure", () => {
  it("proves producer captures frame conforming strictly to BrowserVisualFrameSchema", async () => {
    const frames: BrowserVisualFrame[] = [];
    const mock = createMockPageHandle();

    const producer = new BrowserFrameProducer({
      sessionId: "sess-frame-01",
      generation: 1,
      pageHandle: mock.pageHandle,
      intervalMs: 0, // Event-driven only
      onFrame: (frame) => frames.push(frame),
    });

    await producer.start();

    assert.equal(frames.length, 1);
    const frame = frames[0]!;
    assert.equal(frame.session_id, "sess-frame-01");
    assert.equal(frame.generation, 1);
    assert.equal(frame.frame_seq, 1);
    assert.equal(frame.width, 1280);
    assert.equal(frame.height, 720);
    assert.equal(frame.format, "jpeg");
    assert.ok(typeof frame.data === "string" && frame.data.length > 0);
    assert.ok(frame.monotonic_ms >= 0);

    producer.stop();
  });

  it("proves frame_seq increments monotonically across successive captures", async () => {
    const frames: BrowserVisualFrame[] = [];
    const mock = createMockPageHandle();

    const producer = new BrowserFrameProducer({
      sessionId: "sess-frame-02",
      generation: 1,
      pageHandle: mock.pageHandle,
      intervalMs: 0,
      onFrame: (frame) => frames.push(frame),
    });

    await producer.start();
    await producer.triggerCapture();
    await producer.triggerCapture();

    assert.equal(frames.length, 3);
    assert.equal(frames[0]!.frame_seq, 1);
    assert.equal(frames[1]!.frame_seq, 2);
    assert.equal(frames[2]!.frame_seq, 3);

    producer.stop();
  });

  it("proves latest-frame-wins backpressure: bursts coalesce into single follow-up capture", async () => {
    const frames: BrowserVisualFrame[] = [];
    // Simulate 50ms screenshot encoding time
    const mock = createMockPageHandle({ screenshotDelayMs: 50 });

    const producer = new BrowserFrameProducer({
      sessionId: "sess-frame-03",
      generation: 1,
      pageHandle: mock.pageHandle,
      intervalMs: 0,
      onFrame: (frame) => frames.push(frame),
    });

    // Start initial capture
    const p1 = producer.triggerCapture();

    // While p1 is in flight, trigger 4 rapid updates
    const p2 = producer.triggerCapture();
    const p3 = producer.triggerCapture();
    const p4 = producer.triggerCapture();
    const p5 = producer.triggerCapture();

    await Promise.all([p1, p2, p3, p4, p5]);

    // Total frames emitted must be exactly 2: initial capture + 1 coalesced latest frame
    assert.equal(frames.length, 2, "Concurrent burst must coalesce into exactly one pending follow-up");
    assert.equal(frames[0]!.frame_seq, 1);
    assert.equal(frames[1]!.frame_seq, 2);

    producer.stop();
  });

  it("proves late capture race: capture from old generation is discarded after reset", async () => {
    const frames: BrowserVisualFrame[] = [];
    // Long screenshot delay to simulate in-flight race
    const mock = createMockPageHandle({ screenshotDelayMs: 60 });

    const producerGen1 = new BrowserFrameProducer({
      sessionId: "sess-frame-04",
      generation: 1,
      pageHandle: mock.pageHandle,
      intervalMs: 0,
      onFrame: (frame) => frames.push(frame),
    });

    // Start in-flight capture on Gen 1
    const capturePromise = producerGen1.triggerCapture();

    // Immediate reset: producer is stopped before capture finishes
    producerGen1.stop();

    await capturePromise;

    // Zero frames should have been pushed
    assert.equal(frames.length, 0, "Late capture resolving after stop/reset must be discarded");
  });

  it("proves oversized frame (> 2 MiB) is rejected fail-closed without emission", async () => {
    const frames: BrowserVisualFrame[] = [];
    // Produce payload exceeding 2 MiB
    const mock = createMockPageHandle({ screenshotBytes: MAX_FRAME_DATA_BYTES + 1024 });

    const producer = new BrowserFrameProducer({
      sessionId: "sess-frame-05",
      generation: 1,
      pageHandle: mock.pageHandle,
      intervalMs: 0,
      onFrame: (frame) => frames.push(frame),
    });

    await producer.triggerCapture();

    assert.equal(frames.length, 0, "Oversized frame must be dropped fail-closed");
    producer.stop();
  });

  it("proves dead page handle skips capture without throwing", async () => {
    const frames: BrowserVisualFrame[] = [];
    const mock = createMockPageHandle({ isAlive: false });

    const producer = new BrowserFrameProducer({
      sessionId: "sess-frame-06",
      generation: 1,
      pageHandle: mock.pageHandle,
      intervalMs: 0,
      onFrame: (frame) => frames.push(frame),
    });

    await producer.triggerCapture();

    assert.equal(frames.length, 0);
    assert.equal(mock.screenshotCalls, 0);
    producer.stop();
  });

  it("proves stop clears timers and terminates frame production cleanly", async () => {
    const frames: BrowserVisualFrame[] = [];
    const mock = createMockPageHandle();

    const producer = new BrowserFrameProducer({
      sessionId: "sess-frame-07",
      generation: 1,
      pageHandle: mock.pageHandle,
      intervalMs: 50,
      onFrame: (frame) => frames.push(frame),
    });

    await producer.start();
    assert.equal(producer.isStopped(), false);

    producer.stop();
    assert.equal(producer.isStopped(), true);

    const countAtStop = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(frames.length, countAtStop, "No new frames emitted after stop");
  });
});

describe("P7.7 Real Chromium Integration: Live Frame Streaming & DOM Mutation", () => {
  let fixtureServer: FixtureServerInstance;
  let runtimeHost: BrowserRuntimeHost;

  it("proves real Chromium frame capture produces valid JPEG and reflects visual DOM change", async () => {
    fixtureServer = await startFixtureServer({ port: 0 });
    const fixtureOrigin = fixtureServer.origin;

    runtimeHost = new BrowserRuntimeHost();
    const sessionId = "sess-real-frame-01";
    const gen = 1;

    const prep = await runtimeHost.prepareSession({
      sessionId,
      generation: gen,
      allowedOrigins: [fixtureOrigin],
      headless: true,
    });
    assert.equal(prep.ok, true);

    const session = runtimeHost.getActiveSession();
    assert.ok(session);
    const pageHandle = session.getPrimaryPageHandle();
    assert.ok(pageHandle);

    // Navigate to form page
    await pageHandle.rawPage.goto(`${fixtureOrigin}/form`, { waitUntil: "load" });

    const frames: BrowserVisualFrame[] = [];
    const producer = new BrowserFrameProducer({
      sessionId,
      generation: gen,
      pageHandle,
      intervalMs: 0,
      onFrame: (f) => frames.push(f),
    });

    // Capture initial frame
    await producer.start();

    assert.equal(frames.length, 1);
    const frame1 = frames[0]!;
    assert.equal(frame1.frame_seq, 1);
    assert.equal(frame1.format, "jpeg");
    assert.equal(frame1.width, 1280);
    assert.equal(frame1.height, 720);
    assert.ok(frame1.data.length > 1000, "Frame buffer must contain non-trivial JPEG data");
    assert.ok(frame1.data.length <= MAX_FRAME_DATA_BYTES, "Frame must be within 2 MiB bound");

    // Fill form input to mutate DOM visually
    await pageHandle.rawPage.fill("#username", "Course Factory Visual Frame Test");
    await pageHandle.rawPage.click("#counter-btn");

    // Capture second frame after DOM mutation
    await producer.triggerCapture();

    assert.equal(frames.length, 2);
    const frame2 = frames[1]!;
    assert.equal(frame2.frame_seq, 2);
    assert.notEqual(frame1.data, frame2.data, "Visual frame bytes must change when DOM mutates");

    producer.stop();
    await runtimeHost.close();
    await fixtureServer.close();
  });
});
