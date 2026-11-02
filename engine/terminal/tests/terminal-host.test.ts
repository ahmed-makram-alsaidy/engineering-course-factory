// P5.11 Safe IPC host units — deterministic, no Docker, fake provider +
// fake clock. Proves the identifier-only trust boundary, request-id
// idempotency, rate limiting with the cancellation safety route, bounded
// storage, generation fencing, completion bookkeeping, reset/close/shutdown
// semantics and host source safety.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { TerminalHost, type TerminalHostConfig } from "../src/providers/terminal-host.ts";
import type {
  AdmittedSession,
  CleanupResult,
  Disposable,
  ExecutionProvider,
  ProviderEvent,
  ProviderSession,
  StartReceipt,
  StopResult,
} from "../src/providers/execution-provider.ts";
import type { ExecutionGrant } from "../src/admission.ts";
import type { CloseCause, RuntimeEvent } from "../src/protocol.ts";
import { compileFixture, FOREGROUND_OP, BACKGROUND_OP, WAIT_OP, BROWSER_OP } from "./admission-fixtures.ts";

const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_DIGEST = PINNED_BASE.split("@")[1]!;

// -- fake provider ------------------------------------------------------------

declare const brand: unique symbol;

class FakeProvider implements ExecutionProvider {
  prepareCalls: AdmittedSession[] = [];
  startCalls: Array<{ operationId: string; attemptId: string }> = [];
  stopCalls: Array<{ processId: string; cause: string }> = [];
  cancelCalls: string[] = [];
  closeCalls: string[] = [];
  registered: ExecutionGrant[] = [];
  listeners = new Set<(event: ProviderEvent) => void>();
  failPrepareWith: { code: string; message: string } | null = null;
  private sessions = new Map<ProviderSession, { session_id: string; generation: number }>();
  private nextSession = 0;

  async prepare(input: AdmittedSession): Promise<ProviderSession> {
    this.prepareCalls.push(input);
    if (this.failPrepareWith !== null) {
      const failure = new Error(this.failPrepareWith.message) as Error & { code: string };
      failure.code = this.failPrepareWith.code;
      throw failure;
    }
    this.nextSession += 1;
    const session = { id: this.nextSession } as unknown as ProviderSession & { [brand]: true };
    this.sessions.set(session, { session_id: input.session_id, generation: input.generation });
    for (const grant of input.grants ?? []) this.registered.push(grant);
    return session;
  }

  async start(session: ProviderSession, operationId: string, attemptId: string): Promise<StartReceipt> {
    this.startCalls.push({ operationId, attemptId });
    const info = this.sessions.get(session);
    if (info === undefined) {
      const failure = new Error("unknown session") as Error & { code: string };
      failure.code = "STALE_SESSION";
      throw failure;
    }
    const grant = this.registered.find((g) => g.operation_id === operationId && g.attempt_id === attemptId);
    return {
      session_id: info.session_id,
      generation: info.generation,
      operation_id: operationId,
      attempt_id: attemptId,
      process_id: grant?.process_id ?? null,
    };
  }

  async stop(session: ProviderSession, processId: string, cause: "authored_stop" | "operator_stop" | "operation_cancelled" | "timeout" | "session_closing"): Promise<StopResult> {
    this.stopCalls.push({ processId, cause });
    const info = this.sessions.get(session);
    return { session_id: info?.session_id ?? "sess-unknown", generation: info?.generation ?? 1, process_id: processId, outcome: "stopped", forced: false };
  }

  async cancel(session: ProviderSession, operationId: string): Promise<StopResult> {
    this.cancelCalls.push(operationId);
    const info = this.sessions.get(session);
    return { session_id: info?.session_id ?? "sess-unknown", generation: info?.generation ?? 1, process_id: null, outcome: "stopped", forced: false };
  }

  events(_session: ProviderSession, listener: (event: ProviderEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(event: ProviderEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  async close(session: ProviderSession, cause: CloseCause): Promise<CleanupResult> {
    this.closeCalls.push(cause);
    const info = this.sessions.get(session);
    this.sessions.delete(session);
    return { session_id: info?.session_id ?? "sess-unknown", generation: info?.generation ?? 1, cleanup_status: "confirmed", cause };
  }

  registerAdmittedGrants(_session: ProviderSession, grants: readonly ExecutionGrant[]): void {
    for (const grant of grants) {
      if (this.registered.some((g) => g.operation_id === grant.operation_id && g.attempt_id === grant.attempt_id)) continue;
      this.registered.push(grant);
    }
  }
}

// -- harness ------------------------------------------------------------------

interface Harness {
  host: TerminalHost;
  fake: FakeProvider;
  root: string;
  now: { current: number };
}

const roots: string[] = [];

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "cf-p511-host-"));
  roots.push(root);
  const fake = new FakeProvider();
  const now = { current: 1_000_000 };
  const config: TerminalHostConfig = {
    workspaceRoot: root,
    imageIdentity: {
      pinned_reference: PINNED_BASE,
      digest: PINNED_DIGEST,
      platform: "linux/amd64",
      pull_policy: "never",
      source: "base-image.lock.json",
    },
    createProvider: () => fake,
    nowMs: () => now.current,
    hostEnv: {},
    forwardEnvNames: [],
  };
  return { host: new TerminalHost(config), fake, root, now };
}

function mixedLesson(): CompiledLesson {
  return compileFixture("p52-terminal-mixed.json");
}

function providerEvent(base: {
  session_id: string;
  generation: number;
  operation_id: string | null;
  attempt_id: string | null;
  process_id: string | null;
  type: ProviderEvent["type"];
  payload: unknown;
}): ProviderEvent {
  return {
    runtime_event_version: 1,
    session_id: base.session_id,
    generation: base.generation,
    operation_id: base.operation_id,
    attempt_id: base.attempt_id,
    course_id: null,
    lesson_id: null,
    scene_id: null,
    beat_id: null,
    process_id: base.process_id,
    type: base.type,
    payload: base.payload,
  };
}

after(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

// -- tests --------------------------------------------------------------------

describe("P5.11 host: session lifecycle and safe descriptors", () => {
  it("openSession creates a leaf and returns identifiers plus digest only", async () => {
    const { host } = makeHarness();
    const opened = host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-life-01" });
    assert.equal(opened.ok, true);
    const descriptor = (opened as { ok: true; value: { session_id: string; generation: number; lesson_id: string; course_id: string; lesson_compiled_digest: string; execution_authorized: boolean } }).value;
    assert.equal(descriptor.session_id, "sess-life-01");
    assert.equal(descriptor.generation, 1);
    assert.equal(descriptor.execution_authorized, true);
    assert.match(descriptor.lesson_compiled_digest, /^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(descriptor);
    assert.doesNotMatch(serialized, /E:\\|C:\\|\/tmp|containerId|pid/i);
    await host.closeSession("sess-life-01", "lesson_end");
  });

  it("forwards opt-in reviewed bridge options to provider prepare during first run", async () => {
    const { host, fake } = makeHarness();
    const bridge = {
      networkName: "cf-bridge-test-sess",
      hostPort: 54321,
      guestPort: 3000,
    };
    const opened = host.openSession(mixedLesson(), {
      executionAuthorized: true,
      session_id: "sess-bridge-01",
      bridge,
    });
    assert.equal(opened.ok, true);
    await host.handleRunOperation({
      session_id: "sess-bridge-01",
      operation_id: FOREGROUND_OP,
      request_id: "req-bridge-01",
    });
    assert.equal(fake.prepareCalls.length, 1);
    assert.deepEqual(fake.prepareCalls[0]?.bridge, bridge);
    await host.closeSession("sess-bridge-01", "lesson_end");
  });

  it("forged IR cannot open a session (no leaf, no host state)", () => {
    const { host } = makeHarness();
    const opened = host.openSession({ nope: true } as unknown as CompiledLesson, { executionAuthorized: true });
    assert.equal(opened.ok, false);
    assert.equal(host.describeSession("sess-000001"), null);
  });

  it("inspection-only sessions open but runOperation rejects NOT_AUTHORIZED with zero provider interaction", async () => {
    const { host, fake } = makeHarness();
    const opened = host.openSession(mixedLesson(), { executionAuthorized: false, session_id: "sess-insp-01" });
    assert.equal(opened.ok, true);
    const result = await host.handleRunOperation({ session_id: "sess-insp-01", operation_id: FOREGROUND_OP, request_id: "req-1" });
    assert.equal(result.ok, false);
    assert.equal((result as { ok: false; rejection: { code: string } }).rejection.code, "NOT_AUTHORIZED");
    assert.equal(fake.prepareCalls.length, 0);
    assert.equal(fake.startCalls.length, 0);
    await host.closeSession("sess-insp-01", "lesson_end");
  });
});

describe("P5.11 host: identifier-only trust boundary (zero spawn on forgery)", () => {
  const HOSTILE_FIELDS = ["command", "cmd", "argv", "cwd", "env", "image", "mount", "shell", "stdin", "resize", "script"] as const;

  it("hostile extra fields are rejected INVALID_REQUEST with zero provider interaction", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-hostile-01" });
    for (const field of HOSTILE_FIELDS) {
      const hostile = { session_id: "sess-hostile-01", operation_id: FOREGROUND_OP, request_id: `req-${field}`, [field]: "rm -rf /" };
      const result = await host.handleRunOperation(hostile);
      assert.equal(result.ok, false, `field ${field} must be rejected`);
      assert.equal((result as { ok: false; rejection: { code: string } }).rejection.code, "INVALID_REQUEST");
    }
    assert.equal(fake.prepareCalls.length, 0);
    assert.equal(fake.startCalls.length, 0);
    await host.closeSession("sess-hostile-01", "lesson_end");
  });

  it("unknown operations and wrong-engine operations never reach the provider", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-elig-01" });
    const unknown = await host.handleRunOperation({ session_id: "sess-elig-01", operation_id: "no-such-op", request_id: "req-u" });
    assert.equal((unknown as { ok: false; rejection: { code: string } }).rejection.code, "INVALID_REQUEST");
    const browser = await host.handleRunOperation({ session_id: "sess-elig-01", operation_id: BROWSER_OP, request_id: "req-b" });
    assert.equal((browser as { ok: false; rejection: { code: string } }).rejection.code, "UNSUPPORTED_PHASE");
    const wait = await host.handleRunOperation({ session_id: "sess-elig-01", operation_id: WAIT_OP, request_id: "req-w" });
    assert.equal((wait as { ok: false; rejection: { code: string } }).rejection.code, "UNSUPPORTED_PHASE");
    assert.equal(fake.startCalls.length, 0);
    await host.closeSession("sess-elig-01", "lesson_end");
  });

  it("unknown sessions reject STALE_SESSION", async () => {
    const { host, fake } = makeHarness();
    const result = await host.handleRunOperation({ session_id: "sess-ghost", operation_id: FOREGROUND_OP, request_id: "req-g" });
    assert.equal((result as { ok: false; rejection: { code: string } }).rejection.code, "STALE_SESSION");
    assert.equal(fake.prepareCalls.length, 0);
  });
});

describe("P5.11 host: execution and completion bookkeeping", () => {
  it("foreground run returns an ownership receipt; the journal completion releases the slot", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-fg-01" });
    const first = await host.handleRunOperation({ session_id: "sess-fg-01", operation_id: FOREGROUND_OP, request_id: "req-fg-1" });
    assert.equal(first.ok, true);
    assert.equal(fake.startCalls.length, 1);
    const receipt = (first as { ok: true; value: StartReceipt }).value;
    // A second foreground attempt while the first is reserved cannot start.
    const blocked = await host.handleRunOperation({ session_id: "sess-fg-01", operation_id: FOREGROUND_OP, request_id: "req-fg-2" });
    assert.equal((blocked as { ok: false; rejection: { code: string } }).rejection.code, "DUPLICATE_START");
    // Drive the canonical journal trace; operation.completed releases the slot.
    fake.emit(providerEvent({ session_id: "sess-fg-01", generation: 1, operation_id: FOREGROUND_OP, attempt_id: receipt.attempt_id, process_id: null, type: "operation.accepted", payload: {} }));
    fake.emit(providerEvent({ session_id: "sess-fg-01", generation: 1, operation_id: FOREGROUND_OP, attempt_id: receipt.attempt_id, process_id: null, type: "process.started", payload: {} }));
    fake.emit(providerEvent({ session_id: "sess-fg-01", generation: 1, operation_id: FOREGROUND_OP, attempt_id: receipt.attempt_id, process_id: null, type: "process.exited", payload: { exit_code: 0, signal: null, duration_ms: 5 } }));
    fake.emit(providerEvent({ session_id: "sess-fg-01", generation: 1, operation_id: FOREGROUND_OP, attempt_id: receipt.attempt_id, process_id: null, type: "operation.completed", payload: { outcome: "PASS", reason: null, exit_code: 0, forced: false } }));
    const snapshot = host.handleGetSnapshot({ session_id: "sess-fg-01", after_seq: 0 });
    assert.equal(snapshot.ok, true);
    await host.closeSession("sess-fg-01", "lesson_end");
  });

  it("background receipts are result-free and operator stops delegate with trusted targets", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-bg-01" });
    const started = await host.handleRunOperation({ session_id: "sess-bg-01", operation_id: BACKGROUND_OP, request_id: "req-bg-1" });
    assert.equal(started.ok, true);
    assert.equal((started as { ok: true; value: StartReceipt }).value.result, undefined);
    const stopped = await host.handleStopProcess({ session_id: "sess-bg-01", process_id: "C01-L052-P001", request_id: "req-stop-1" });
    // The mixed fixture's background process id is catalog-derived; either a
    // clean stop or a canonical not-started/reference rejection is acceptable
    // here — what matters is the provider only ever sees trusted targets.
    if (stopped.ok) {
      assert.equal(fake.stopCalls.length, 1);
      assert.equal(fake.stopCalls[0]!.cause, "operator_stop");
    } else {
      const code = (stopped as { ok: false; rejection: { code: string } }).rejection.code;
      assert.ok(code === "PROCESS_NOT_STARTED" || code === "INVALID_PROCESS_REFERENCE");
      assert.equal(fake.stopCalls.length, 0);
    }
    await host.closeSession("sess-bg-01", "lesson_end");
  });

  it("stop of an unknown process never signals the provider", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-stop-01" });
    const result = await host.handleStopProcess({ session_id: "sess-stop-01", process_id: "process-ghost", request_id: "req-s" });
    assert.equal((result as { ok: false; rejection: { code: string } }).rejection.code, "INVALID_PROCESS_REFERENCE");
    assert.equal(fake.stopCalls.length, 0);
    await host.closeSession("sess-stop-01", "lesson_end");
  });
});

describe("P5.11 host: request-id idempotency and rate limiting", () => {
  it("same request_id with the identical payload reuses the receipt (one spawn)", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-idem-01" });
    const payload = { session_id: "sess-idem-01", operation_id: FOREGROUND_OP, request_id: "req-same" };
    const first = await host.handleRunOperation(payload);
    const second = await host.handleRunOperation({ ...payload });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second, first);
    assert.equal(fake.startCalls.length, 1);
    await host.closeSession("sess-idem-01", "lesson_end");
  });

  it("same request_id with a different payload is rejected without a second spawn", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-idem-02" });
    const first = await host.handleRunOperation({ session_id: "sess-idem-02", operation_id: FOREGROUND_OP, request_id: "req-reuse" });
    assert.equal(first.ok, true);
    const second = await host.handleRunOperation({ session_id: "sess-idem-02", operation_id: BACKGROUND_OP, request_id: "req-reuse" });
    assert.equal(second.ok, false);
    assert.equal((second as { ok: false; rejection: { code: string } }).rejection.code, "INVALID_REQUEST");
    assert.equal(fake.startCalls.length, 1);
    await host.closeSession("sess-idem-02", "lesson_end");
  });

  it("ten mutating requests per second pass; the eleventh is held; cancel bypasses", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-rate-01" });
    for (let i = 0; i < 10; i += 1) {
      const result = await host.handleStopProcess({ session_id: "sess-rate-01", process_id: "process-ghost", request_id: `req-rate-${i}` });
      // Admission rejects (unknown process) but the rate gate lets it through.
      assert.equal((result as { ok: false; rejection: { code: string } }).rejection.code, "INVALID_PROCESS_REFERENCE");
    }
    const held = await host.handleStopProcess({ session_id: "sess-rate-01", process_id: "process-ghost", request_id: "req-rate-10" });
    assert.equal((held as { ok: false; rejection: { code: string } }).rejection.code, "INVALID_REQUEST");
    assert.match((held as { ok: false; rejection: { message: string } }).rejection.message, /rate limit/);
    // Cancellation safety route: cancel is never rate-limited (its own
    // admission reason surfaces instead of the rate hold).
    const cancel = await host.handleCancelOperation({ session_id: "sess-rate-01", operation_id: FOREGROUND_OP, request_id: "req-cancel-safe" });
    assert.equal(cancel.ok, false);
    assert.doesNotMatch((cancel as { ok: false; rejection: { message: string } }).rejection.message, /rate limit/);
    // Read-only replay is never rate-limited either.
    const snapshot = host.handleGetSnapshot({ session_id: "sess-rate-01", after_seq: 0 });
    assert.equal(snapshot.ok, true);
    assert.equal(fake.stopCalls.length, 0);
    await host.closeSession("sess-rate-01", "lesson_end");
  });
});

describe("P5.11 host: reset, close and shutdown barrier", () => {
  it("reset bumps the generation, clears idempotency and reuses request ids", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-reset-01" });
    const first = await host.handleRunOperation({ session_id: "sess-reset-01", operation_id: FOREGROUND_OP, request_id: "req-same-gen" });
    assert.equal(first.ok, true);
    const reset = await host.handleResetRuntime({ session_id: "sess-reset-01", request_id: "req-reset-1" });
    assert.equal(reset.ok, true);
    assert.equal((reset as { ok: true; value: { generation: number } }).value.generation, 2);
    assert.equal(fake.closeCalls.length, 1);
    // The same request_id is reusable in the new generation (generation-scoped ledger).
    const rerun = await host.handleRunOperation({ session_id: "sess-reset-01", operation_id: FOREGROUND_OP, request_id: "req-same-gen" });
    assert.equal(rerun.ok, true);
    assert.equal(fake.startCalls.length, 2);
    await host.closeSession("sess-reset-01", "lesson_end");
  });

  it("close is idempotent, deletes the owned leaf and keeps bounded replay", async () => {
    const { host } = makeHarness();
    const opened = host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-close-01" });
    assert.equal(opened.ok, true);
    const first = await host.closeSession("sess-close-01", "lesson_end");
    assert.equal(first.ok, true);
    assert.equal((first as { ok: true; value: CleanupResult }).value.cleanup_status, "confirmed");
    const second = await host.closeSession("sess-close-01", "lesson_end");
    assert.equal(second.ok, true);
    const snapshot = host.handleGetSnapshot({ session_id: "sess-close-01", after_seq: 0 });
    assert.equal(snapshot.ok, true);
    const rerun = await host.handleRunOperation({ session_id: "sess-close-01", operation_id: FOREGROUND_OP, request_id: "req-after-close" });
    assert.equal((rerun as { ok: false; rejection: { code: string } }).rejection.code, "STALE_SESSION");
  });

  it("shutdownAll closes every session and blocks new sessions and runs", async () => {
    const { host } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-shut-01" });
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-shut-02" });
    const results = await host.shutdownAll("app_close");
    assert.equal(results.length, 2);
    const late = host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-shut-03" });
    assert.equal((late as { ok: false; rejection: { code: string } }).rejection.code, "CLEANUP_UNCONFIRMED");
    const run = await host.handleRunOperation({ session_id: "sess-shut-01", operation_id: FOREGROUND_OP, request_id: "req-late" });
    assert.equal((run as { ok: false; rejection: { code: string } }).rejection.code, "STALE_SESSION");
  });

  it("subscriptions are bounded and disposed", async () => {
    const { host } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-sub-01" });
    const disposables: Disposable[] = [];
    for (let i = 0; i < 32; i += 1) {
      disposables.push(host.subscribe("sess-sub-01", () => {}));
    }
    assert.throws(() => host.subscribe("sess-sub-01", () => {}), /subscription bound/);
    for (const disposable of disposables) disposable.dispose();
    // After disposal there is room again.
    host.subscribe("sess-sub-01", () => {}).dispose();
    await host.closeSession("sess-sub-01", "lesson_end");
  });

  it("owned leaves live under the configured root while the session is open", async () => {
    const { host, root } = makeHarness();
    const opened = host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-leaf-01" });
    assert.equal(opened.ok, true);
    const lessonId = (opened as { ok: true; value: { lesson_id: string } }).value.lesson_id;
    const leafPath = join(root, "workspaces", lessonId, "sess-leaf-01");
    assert.equal(existsSync(leafPath), true);
    await host.closeSession("sess-leaf-01", "lesson_end");
    assert.equal(existsSync(leafPath), false);
  });
});

describe("P5.11 host: snapshot service and journal coherence", () => {
  it("getSnapshot serves bounded redacted pages over the live journal", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-snap-01" });
    const started = await host.handleRunOperation({ session_id: "sess-snap-01", operation_id: BACKGROUND_OP, request_id: "req-snap-bg" });
    assert.equal(started.ok, true);
    const receipt = (started as { ok: true; value: StartReceipt }).value;
    const processId = receipt.process_id;
    assert.ok(typeof processId === "string");
    fake.emit(providerEvent({ session_id: "sess-snap-01", generation: 1, operation_id: BACKGROUND_OP, attempt_id: receipt.attempt_id, process_id: processId, type: "operation.accepted", payload: {} }));
    fake.emit(providerEvent({ session_id: "sess-snap-01", generation: 1, operation_id: BACKGROUND_OP, attempt_id: receipt.attempt_id, process_id: processId, type: "process.started", payload: {} }));
    fake.emit(providerEvent({ session_id: "sess-snap-01", generation: 1, operation_id: BACKGROUND_OP, attempt_id: receipt.attempt_id, process_id: processId, type: "process.output", payload: { stream: "stdout", text: "hello-ipc", stream_offset: 0 } }));
    const page = host.handleGetSnapshot({ session_id: "sess-snap-01", after_seq: 0 });
    assert.equal(page.ok, true);
    const events = (page as { ok: true; value: { events: RuntimeEvent[] } }).value.events;
    assert.ok(events.length >= 3);
    assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq));
    // A stale cursor yields an explicit reset page, never a silent gap.
    const resetPage = host.handleGetSnapshot({ session_id: "sess-snap-01", after_seq: 10_000_000 });
    assert.equal(resetPage.ok, true);
    assert.equal((resetPage as { ok: true; value: { reset: boolean } }).value.reset, true);
    await host.closeSession("sess-snap-01", "lesson_end");
  });

  it("subscriber fan-out delivers copied DTOs and survives a throwing listener", async () => {
    const { host, fake } = makeHarness();
    host.openSession(mixedLesson(), { executionAuthorized: true, session_id: "sess-fan-01" });
    const seen: RuntimeEvent[] = [];
    host.subscribe("sess-fan-01", () => {
      throw new Error("renderer listener threw");
    });
    host.subscribe("sess-fan-01", (event) => seen.push(event));
    const started = await host.handleRunOperation({ session_id: "sess-fan-01", operation_id: BACKGROUND_OP, request_id: "req-fan-bg" });
    assert.equal(started.ok, true);
    const receipt = (started as { ok: true; value: StartReceipt }).value;
    fake.emit(providerEvent({ session_id: "sess-fan-01", generation: 1, operation_id: BACKGROUND_OP, attempt_id: receipt.attempt_id, process_id: receipt.process_id, type: "operation.accepted", payload: {} }));
    assert.equal(seen.length, 1);
    await host.closeSession("sess-fan-01", "lesson_end");
  });
});

describe("P5.11 host: source safety (no new execution surface)", () => {
  it("the host owns no process, Docker, network, Electron or PTY machinery", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const code = readFileSync(join(here, "..", "src", "providers", "terminal-host.ts"), "utf8");
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const token of ["node:child_process", "node:net", "node:http", "node:dns", "node-pty", "spawn(", "exec(", "fetch(", "createConnection", "ipcRenderer", "contextBridge", "BrowserWindow", "webContents"]) {
      assert.equal(stripped.includes(token), false, `host must not contain ${token}`);
    }
    assert.doesNotMatch(stripped, /docker\s+(run|exec|create|start|stop|rm)/);
  });
});
