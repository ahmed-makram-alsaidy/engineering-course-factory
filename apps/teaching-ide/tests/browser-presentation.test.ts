// P7.7 Browser Presentation & Renderer Projection Tests.
// Canonical authority: docs/P7-DESIGN-SPEC.md Sections 6.2, 22.1, ADR-0012.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initialBrowserViewState,
  applyBrowserVisualFrame,
  applyBrowserRuntimeEvent,
  reanchorBrowserSession,
  clearBrowserVisualState,
  sanitizeLogicalUrl,
  sanitizeBrowserError,
  isValidVisualFrame,
  type BrowserViewState,
} from "../src/model/browser-runtime.ts";
import type {
  BrowserRuntimeEvent,
  BrowserVisualFrame,
} from "@course-factory/browser-engine";

function proof(message: string): void {
  console.log(`P7.7 PROOF: ${message}`);
}

const SESSION = "sess-proj-01";
const GEN = 1;

function sampleFrame(overrides: Partial<BrowserVisualFrame> = {}): BrowserVisualFrame {
  return {
    session_id: SESSION,
    generation: GEN,
    frame_seq: 1,
    monotonic_ms: 100,
    width: 1280,
    height: 720,
    format: "jpeg",
    data: "dGVzdC1mcmFtZS1ieXRlcw==", // base64 "test-frame-bytes"
    ...overrides,
  };
}

describe("P7.7 Browser Presentation: Frame Validation & Lifecycle", () => {
  it("proves initial view state is inactive with about:blank URL and zero frames", () => {
    proof("initial view state is empty and safe");
    const state = initialBrowserViewState();
    assert.equal(state.session_id, null);
    assert.equal(state.generation, 0);
    assert.equal(state.status, "NOT_STARTED");
    assert.equal(state.activeUrl, "about:blank");
    assert.equal(state.lastFrame, null);
    assert.equal(state.activeBadge, null);
    assert.equal(state.errorMessage, null);
    assert.equal(state.stats.framesReceived, 0);
    assert.equal(state.stats.framesApplied, 0);
  });

  it("proves valid frame renders and transitions status to READY", () => {
    proof("trusted frame renders successfully");
    const initial = initialBrowserViewState();
    const frame = sampleFrame();
    const state = applyBrowserVisualFrame(initial, frame);

    assert.equal(state.status, "READY");
    assert.equal(state.session_id, SESSION);
    assert.equal(state.generation, GEN);
    assert.ok(state.lastFrame);
    assert.equal(state.lastFrame.frame_seq, 1);
    assert.equal(state.lastFrame.width, 1280);
    assert.equal(state.lastFrame.height, 720);
    assert.equal(state.stats.framesApplied, 1);
    assert.equal(state.stats.framesReceived, 1);
  });

  it("proves second frame replaces first and prompts old object URL revocation", () => {
    proof("second frame replaces first with object URL revocation");
    const revoked: string[] = [];
    const created: string[] = [];

    const mockCreate = (blob: Blob) => {
      const url = `blob:http://localhost/${created.length + 1}`;
      created.push(url);
      return url;
    };
    const mockRevoke = (url: string) => {
      revoked.push(url);
    };

    let state = initialBrowserViewState();
    state = applyBrowserVisualFrame(state, sampleFrame({ frame_seq: 1 }), mockCreate, mockRevoke);
    assert.equal(state.lastFrame?.frame_seq, 1);
    assert.equal(revoked.length, 0);

    state = applyBrowserVisualFrame(state, sampleFrame({ frame_seq: 2 }), mockCreate, mockRevoke);
    assert.equal(state.lastFrame?.frame_seq, 2);
    assert.equal(revoked.length, 1, "First blob URL must be revoked when second frame arrives");
    assert.equal(revoked[0], created[0]);
  });

  it("proves duplicate frame_seq is ignored and counted in stats", () => {
    proof("duplicate frame_seq is ignored");
    let state = initialBrowserViewState();
    state = applyBrowserVisualFrame(state, sampleFrame({ frame_seq: 1 }));
    const duplicate = applyBrowserVisualFrame(state, sampleFrame({ frame_seq: 1 }));

    assert.equal(duplicate.lastFrame?.frame_seq, 1);
    assert.equal(duplicate.stats.framesApplied, 1);
    assert.equal(duplicate.stats.duplicateFramesDropped, 1);
  });

  it("proves backwards frame_seq is ignored fail-closed", () => {
    proof("backwards frame_seq is rejected");
    let state = initialBrowserViewState();
    state = applyBrowserVisualFrame(state, sampleFrame({ frame_seq: 5 }));
    const backwards = applyBrowserVisualFrame(state, sampleFrame({ frame_seq: 3 }));

    assert.equal(backwards.lastFrame?.frame_seq, 5);
    assert.equal(backwards.stats.framesApplied, 1);
    assert.equal(backwards.stats.duplicateFramesDropped, 1);
  });

  it("proves stale session ID frame is ignored fail-closed", () => {
    proof("stale session ID frame is ignored");
    let state = initialBrowserViewState();
    state = applyBrowserVisualFrame(state, sampleFrame({ session_id: "session-alpha" }));
    const stale = applyBrowserVisualFrame(state, sampleFrame({ session_id: "session-beta" }));

    assert.equal(stale.session_id, "session-alpha");
    assert.equal(stale.stats.staleFramesDropped, 1);
  });

  it("proves stale generation frame is ignored fail-closed", () => {
    proof("stale generation frame is ignored");
    let state = initialBrowserViewState();
    state = applyBrowserVisualFrame(state, sampleFrame({ generation: 2 }));
    const stale = applyBrowserVisualFrame(state, sampleFrame({ generation: 1 }));

    assert.equal(stale.generation, 2);
    assert.equal(stale.stats.staleFramesDropped, 1);
  });

  it("proves oversized frame (> 2 MiB) is rejected fail-closed", () => {
    proof("oversized frame (> 2 MiB) is rejected");
    const state = initialBrowserViewState();
    const hugeData = "A".repeat(2 * 1024 * 1024 + 1);
    const result = applyBrowserVisualFrame(state, sampleFrame({ data: hugeData }));

    assert.equal(result.lastFrame, null);
    assert.equal(result.stats.invalidFramesDropped, 1);
  });

  it("proves malformed dimensions and unsupported formats are rejected fail-closed", () => {
    proof("malformed dimensions and formats rejected");
    const state = initialBrowserViewState();

    // 0x0 dimensions
    const res1 = applyBrowserVisualFrame(state, sampleFrame({ width: 0 }));
    assert.equal(res1.stats.invalidFramesDropped, 1);

    // Negative dimensions
    const res2 = applyBrowserVisualFrame(state, sampleFrame({ height: -10 }));
    assert.equal(res2.stats.invalidFramesDropped, 1);

    // Exorbitant dimensions
    const res3 = applyBrowserVisualFrame(state, sampleFrame({ width: 9999 }));
    assert.equal(res3.stats.invalidFramesDropped, 1);

    // Unsupported format
    const res4 = applyBrowserVisualFrame(state, { ...sampleFrame(), format: "bmp" });
    assert.equal(res4.stats.invalidFramesDropped, 1);
  });

  it("proves reanchorBrowserSession revokes old frame and establishes clean generation", () => {
    proof("session reanchor cleans old resources");
    const revoked: string[] = [];
    const mockCreate = () => "blob:http://localhost/active-frame";
    const mockRevoke = (u: string) => revoked.push(u);

    let state = initialBrowserViewState();
    state = applyBrowserVisualFrame(state, sampleFrame({ frame_seq: 1 }), mockCreate, mockRevoke);
    assert.ok(state.lastFrame);

    const reanchored = reanchorBrowserSession(
      state,
      {
        session_id: "sess-fresh-02",
        generation: 2,
        lesson_id: "L01",
        course_id: "C01",
        status: "ready",
      },
      mockRevoke,
    );

    assert.equal(reanchored.session_id, "sess-fresh-02");
    assert.equal(reanchored.generation, 2);
    assert.equal(reanchored.lastFrame, null);
    assert.equal(revoked.length, 1, "Old frame URL revoked on session reanchor");
  });

  it("proves clearBrowserVisualState purges all display state and revokes URLs", () => {
    proof("clear cleans display state");
    const revoked: string[] = [];
    const mockCreate = () => "blob:http://localhost/purge-me";
    const mockRevoke = (u: string) => revoked.push(u);

    let state = initialBrowserViewState();
    state = applyBrowserVisualFrame(state, sampleFrame(), mockCreate, mockRevoke);
    const cleared = clearBrowserVisualState(state, mockRevoke);

    assert.equal(cleared.lastFrame, null);
    assert.equal(cleared.status, "NOT_STARTED");
    assert.equal(revoked.length, 1);
  });
});

describe("P7.7 Browser Presentation: Semantic Events, URL & Error Sanitization", () => {
  it("proves semantic events update status and operation badges cleanly", () => {
    proof("semantic events update status and badges");
    let state = initialBrowserViewState();

    // 1. browser.started
    const evStarted: BrowserRuntimeEvent = {
      type: "browser.started",
      session_id: SESSION,
      generation: GEN,
      seq: 1,
      monotonic_ms: 50,
    };
    state = applyBrowserRuntimeEvent(state, evStarted);
    assert.equal(state.status, "READY");

    // 2. browser.operation.started
    const evOpStart: BrowserRuntimeEvent = {
      type: "browser.operation.started",
      session_id: SESSION,
      generation: GEN,
      seq: 2,
      monotonic_ms: 100,
      operation_id: "op-click-01",
      operation_type: "browser_click",
      request_id: "req-01",
    };
    state = applyBrowserRuntimeEvent(state, evOpStart);
    assert.equal(state.status, "RUNNING");
    assert.equal(state.activeBadge?.status, "RUNNING");
    assert.equal(state.activeBadge?.label, "Clicking...");

    // 3. browser.operation.completed
    const evOpDone: BrowserRuntimeEvent = {
      type: "browser.operation.completed",
      session_id: SESSION,
      generation: GEN,
      seq: 3,
      monotonic_ms: 150,
      operation_id: "op-click-01",
      operation_type: "browser_click",
      request_id: "req-01",
      duration_ms: 50,
    };
    state = applyBrowserRuntimeEvent(state, evOpDone);
    assert.equal(state.status, "READY");
    assert.equal(state.activeBadge?.status, "PASS");
  });

  it("proves page or browser crash transitions status to CRASHED with safe error", () => {
    proof("crash transitions safely to CRASHED state");
    let state = initialBrowserViewState();

    const evCrash: BrowserRuntimeEvent = {
      type: "browser.operation.failed",
      session_id: SESSION,
      generation: GEN,
      seq: 4,
      monotonic_ms: 200,
      operation_id: "op-02",
      operation_type: "browser_click",
      request_id: "req-02",
      error_code: "PAGE_CRASHED",
      message: "Process died unexpectedly at E:\\course-factory\\engine\\browser.ts:120",
    };
    state = applyBrowserRuntimeEvent(state, evCrash);
    assert.equal(state.status, "CRASHED");
    assert.ok(state.errorMessage);
    assert.doesNotMatch(state.errorMessage, /E:\\course-factory/, "Path must be redacted");
    assert.match(state.errorMessage, /\[path\]/);
  });

  it("proves sanitizeLogicalUrl never leaks dynamic ports, credentials or secret query params", () => {
    proof("URL sanitizer redacts credentials and dynamic ports");
    // Dynamic reverse proxy port on loopback
    const url1 = sanitizeLogicalUrl("http://127.0.0.1:49215/dashboard");
    assert.equal(url1, "http://localhost/dashboard", "Dynamic ephemeral port must be stripped");

    // Embedded credentials
    const url2 = sanitizeLogicalUrl("http://admin:supersecret@localhost:3000/login");
    assert.doesNotMatch(url2, /admin/, "Username must be stripped");
    assert.doesNotMatch(url2, /supersecret/, "Password must be stripped");
    assert.equal(url2, "http://localhost:3000/login");

    // Sensitive query params
    const url3 = sanitizeLogicalUrl("http://localhost:3000/page?token=tok_12345&auth=true&public=1");
    assert.doesNotMatch(url3, /tok_12345/);
    assert.doesNotMatch(url3, /token=/);
    assert.match(url3, /public=1/);

    // Record Safe Mode
    const url4 = sanitizeLogicalUrl("http://127.0.0.1:3000/course", true);
    assert.equal(url4, "http://localhost/course");
  });

  it("proves sanitizeBrowserError redacts local paths and enforces bounded length", () => {
    proof("error sanitizer redacts machine paths");
    const longMsg = "Error in E:\\course-factory\\temp\\profile-01\\context.ts: " + "X".repeat(200);
    const cleaned = sanitizeBrowserError(longMsg);

    assert.doesNotMatch(cleaned, /E:\\course-factory/);
    assert.match(cleaned, /\[path\]/);
    assert.ok(cleaned.length <= 123, "Must be capped with ellipsis");
  });
});
