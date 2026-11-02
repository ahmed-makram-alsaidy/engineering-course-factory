// P5.6 REAL Docker integration — the main journal over the REAL guest pipes:
//
//   canonical admission (compiled synthetic fixture -> catalog -> session ->
//   grants) -> trusted workspace leaf -> DockerSandboxProvider -> live session
//   container -> guest supervisor process groups -> provider events ->
//   SessionJournal (seq/monotonic stamping, chunk-spanning redaction BEFORE
//   storage, coherence, per-process transcripts) -> bounded replay pages/feed.
//
// Every resource is prefixed cf-p56- (installation label cf-p56-installation)
// under the repository's ignored temp root. Tests are skipped (never silently
// passed) only when the daemon or the supervisor runtime image is unavailable
// — the P5.6 gate REQUIRES a real run and fails otherwise. Every test's
// finally/after removes only its own owned containers (never a global prune).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSandboxProvider, type DockerProviderConfig } from "../src/providers/docker.ts";
import type { AdmittedSession, ProviderEvent, ProviderSession } from "../src/providers/execution-provider.ts";
import type { ExecutionGrant } from "../src/admission.ts";
import { createAdmissionService, type AdmissionService, type AdmissionSession } from "../src/admission.ts";
import type { RuntimeSessionIdentity, RuntimeEvent } from "../src/protocol.ts";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { SessionJournal } from "../src/journal.ts";
import { createRuntimeEventFeed } from "../src/events.ts";
import { JOURNAL_POLICY } from "../src/policy.ts";
import {
  resolveConfiguredWorkspaceRoot,
  createSessionWorkspace,
  resolveGrantWorkspace,
  buildWorkspaceMountPlan,
  resolveExecutionContext,
  type ResolvedWorkspaceRoot,
} from "../src/workspace.ts";
import { resolveEnvironmentPlan } from "../src/environment.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P5.6");
const WS_ROOT = join(TEST_ROOT, "workspaces-root");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5.6";
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_BASE_DIGEST = PINNED_BASE.split("@")[1]!;
const INSTALLATION_ID = "cf-p56-installation";
const INSTALL_LABEL = "com.course-factory.installation";
const LESSON_ID = "C01-L056";

/** The synthetic fake secret the guest splits across two output frames. */
const FAKE_SECRET = "sk-FAKEp56SECRET";

function resolveDockerExe(): string {
  const configured = process.env.CF_P56_DOCKER_EXE ?? process.env.CF_P55_DOCKER_EXE ?? process.env.CF_P54_DOCKER_EXE;
  if (configured !== undefined && configured.length > 0) return configured;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["docker"], { encoding: "utf8" });
  if (probe.status === 0 && (probe.stdout ?? "").trim().length > 0) {
    const lines = (probe.stdout as string).trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const withExe = process.platform === "win32" ? lines.find((l) => l.toLowerCase().endsWith(".exe")) : undefined;
    return (withExe ?? lines[0] ?? "docker")!;
  }
  return "docker";
}

const DOCKER_EXE = resolveDockerExe();

function docker(...argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(DOCKER_EXE, argv, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function containerIdsForInstallation(): string[] {
  const r = docker("ps", "-aq", "--filter", `label=${INSTALL_LABEL}=${INSTALLATION_ID}`);
  return (r.stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
}

function daemonOk(): boolean {
  const r = docker("version", "--format", "{{.Server.Version}}");
  return r.status === 0 && r.stdout.trim().length > 0;
}

function resolveRuntimeImageRef(): string | null {
  const configured = process.env.CF_P56_RUNTIME_IMAGE ?? process.env.CF_P55_RUNTIME_IMAGE ?? process.env.CF_P54_RUNTIME_IMAGE;
  if (configured !== undefined && /^sha256:[0-9a-f]{64}$/.test(configured)) return configured;
  const r = docker("image", "inspect", RUNTIME_IMAGE_TAG, "--format", "{{.Id}}");
  if (r.status === 0) {
    const id = r.stdout.trim();
    if (/^sha256:[0-9a-f]{64}$/.test(id)) return id;
  }
  return null;
}

const DAEMON_OK = daemonOk();
const RUNTIME_IMAGE_REF = resolveRuntimeImageRef();
const AVAILABLE = DAEMON_OK && RUNTIME_IMAGE_REF !== null;

function ensureConfigContext(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ls = docker("--config", CONFIG_DIR, "context", "ls");
  if ((ls.stdout ?? "").includes("desktop-linux")) return;
  const created = docker(
    "--config", CONFIG_DIR, "context", "create",
    "desktop-linux",
    "--docker", "host=npipe:////./pipe/dockerDesktopLinuxEngine",
    "--description", "course-factory p5.6 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

// -- synthetic lesson scripts (seeded into the session leaf; guest-only) ------

const SCRIPTS: Record<string, string> = {
  // The fake secret is written in TWO separate writes (150 ms apart): two raw
  // pipe data events -> two guest frames -> the secret spans two output
  // events. The journal's holdback must keep the raw prefix unemitted until
  // the secret is either completed or the process's terminal event flushes it.
  "secret_chunks.js": [
    "const w = (fd, s) => require('node:fs').writeSync(fd, s);",
    "w(1, 'P56_BEGIN token=sk-');",
    "setTimeout(() => { w(1, 'FAKEp56SECRET part2\\n'); }, 150);",
    "let n = 0;",
    "const t = setInterval(() => { n += 1; w(2, 'P56_ERR_' + n + '\\n'); if (n >= 3) { clearInterval(t); } }, 100);",
    "process.on('SIGINT', () => { w(1, 'P56_SIGINT_SEEN\\n'); setTimeout(() => process.exit(0), 100); });",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
  // Deterministic interleaved per-stream output for the replay/feed test.
  "interleave.js": [
    "const w = (fd, s) => require('node:fs').writeSync(fd, s);",
    "let n = 0;",
    "const t = setInterval(() => {",
    "  n += 1;",
    "  w(1, 'P56_OUT_A' + n + '\\n');",
    "  w(2, 'P56_ERR_B' + n + '\\n');",
    "  if (n >= 4) { clearInterval(t); }",
    "}, 150);",
    "process.on('SIGINT', () => { setTimeout(() => process.exit(0), 50); });",
    "setTimeout(() => process.exit(0), 30000);",
  ].join("\n"),
};

// -- canonical admission -> grants ----------------------------------------------

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: never) => CompiledLesson;
};
const { parseLessonData } = await import("@course-factory/shared-types/validate");

interface OpSpec {
  readonly op_id: string;
  readonly command: string;
  readonly process_id: string;
}

function lessonSource(ops: readonly OpSpec[]): unknown {
  const beats = ops.map((op) => ({
    beat_id: op.op_id,
    kind: "action",
    action: {
      type: "terminal_run",
      command: op.command,
      mode: "background",
      process_id: op.process_id,
    },
  }));
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: LESSON_ID,
    title: "P5.6 synthetic journal lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Journal/redaction over real guest output in the P5 sandbox"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p56"],
    metadata: { synthetic_fixture: true, phase: "P5.6" },
    scenes: [
      {
        scene_id: `${LESSON_ID}-S001`,
        type: "code_demo",
        title: "Journaled background output",
        duration: 120,
        visual: { kind: "terminal", description: "synthetic" },
        beats,
      },
    ],
  };
}

function makeProvider(): DockerSandboxProvider {
  return new DockerSandboxProvider({
    cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR, clientEnv: {} },
    imageReference: RUNTIME_IMAGE_REF!,
    installationId: INSTALLATION_ID,
  });
}

interface P56Fixture {
  readonly provider: DockerSandboxProvider;
  readonly session: ProviderSession;
  readonly journal: SessionJournal;
  /** Every stamped journal event (subscriber copy — redacted, ordered). */
  readonly journalSeen: RuntimeEvent[];
  /** Every journal rejection (must stay empty in green tests). */
  readonly journalRejections: Array<{ code: string; message: string }>;
  readonly grants: ReadonlyMap<string, ExecutionGrant>;
  readonly identity: RuntimeSessionIdentity;
  readonly service: AdmissionService;
  readonly admissionSession: AdmissionSession;
  readonly leafPath: string;
  readonly wsRoot: ResolvedWorkspaceRoot;
  waitForJournalEvent(type: RuntimeEvent["type"], predicate: ((event: RuntimeEvent) => boolean) | null, timeoutMs: number): Promise<RuntimeEvent>;
  dispose(): Promise<void>;
}

async function openSessionFixture(args: {
  ops: readonly OpSpec[];
  sessionId?: string;
}): Promise<P56Fixture> {
  const sessionId = args.sessionId ?? `sess-p56-${randomBytes(4).toString("hex")}`;
  const raw = lessonSource(args.ops);
  const parsed = parseLessonData(raw);
  if (!parsed.ok || parsed.lesson === undefined) {
    throw new Error(`synthetic lesson failed source validation: ${JSON.stringify(parsed.issues)}`);
  }
  const ir = compileModule.compileLesson(parsed.lesson as never);
  const service = createAdmissionService();
  const catalogResult = service.installLesson(ir);
  if (!catalogResult.ok) throw new Error(`catalog rejected fixture: ${catalogResult.rejection.message}`);
  const opened = service.openSession(catalogResult.value, { session_id: sessionId, executionAuthorized: true });
  if (!opened.ok) throw new Error(`session open failed: ${opened.rejection.message}`);
  const identity = opened.value.identity;

  const grants = new Map<string, ExecutionGrant>();
  for (const op of args.ops) {
    const admitted = service.admitRunOperation(identity, {
      session_id: sessionId,
      operation_id: op.op_id,
      request_id: `req-${op.op_id}`,
    });
    if (!admitted.ok) throw new Error(`admission rejected ${op.op_id}: ${admitted.rejection.message}`);
    if (admitted.value.kind !== "execution_grant") throw new Error(`expected an execution grant for ${op.op_id}`);
    grants.set(op.op_id, admitted.value);
  }

  const root = resolveConfiguredWorkspaceRoot(WS_ROOT);
  if (!root.ok) throw new Error("workspace root resolution failed");
  const leaf = createSessionWorkspace(root.value, {
    lesson_id: LESSON_ID,
    session_id: sessionId,
    generation: identity.generation,
  });
  if (!leaf.ok) throw new Error(`session workspace failed: ${leaf.error.message}`);
  for (const [name, content] of Object.entries(SCRIPTS)) {
    writeFileSync(join(leaf.value.host_root, name), content, "utf8");
  }

  const primaryGrant = grants.values().next().value;
  if (primaryGrant === undefined) throw new Error("fixture has no background grant");
  const paths = resolveGrantWorkspace(leaf.value, primaryGrant);
  if (!paths.ok) throw new Error(`grant workspace failed: ${paths.error.message}`);
  const mountPlan = buildWorkspaceMountPlan(paths.value);
  if (!mountPlan.ok) throw new Error(`mount plan failed: ${mountPlan.error.message}`);
  const env = resolveEnvironmentPlan(Object.freeze({ TZ: "UTC", FAKE_P56_TOKEN: "DO_NOT_LEAK" }), ["TZ"]);
  if (!env.ok) throw new Error("environment plan failed");
  const context = resolveExecutionContext({
    workspace_paths: paths.value,
    mount_plan: mountPlan.value,
    environment_plan: env.value,
    image_identity: {
      pinned_reference: PINNED_BASE,
      digest: PINNED_BASE_DIGEST,
      platform: "linux/amd64",
      pull_policy: "never",
      source: "base-image.lock.json",
    },
  });
  if (!context.ok) throw new Error(`execution context failed: ${context.error.message}`);

  const provider = makeProvider();
  const admittedSession: AdmittedSession = {
    session_id: sessionId,
    generation: identity.generation,
    resolvedContext: context.value,
    grants: [...grants.values()],
  };
  const session = await provider.prepare(admittedSession);

  // P5.6 wiring under test: the trusted main-owned journal consumes the
  // provider's translated events (no seq/monotonic stamps) and is the only
  // component that stamps and stores them.
  const journal = new SessionJournal({
    session_id: sessionId,
    generation: identity.generation,
    secrets: [FAKE_SECRET],
  });
  const journalSeen: RuntimeEvent[] = [];
  journal.subscribe((event) => journalSeen.push(event));
  const journalRejections: Array<{ code: string; message: string }> = [];
  const providerSubscription = provider.events(session, (event) => {
    const result = journal.ingest(event);
    if (!result.ok) journalRejections.push({ code: result.code, message: result.message });
  });

  const fixture: P56Fixture = {
    provider,
    session,
    journal,
    journalSeen,
    journalRejections,
    grants,
    identity,
    service,
    admissionSession: opened.value,
    leafPath: leaf.value.host_root,
    wsRoot: root.value,
    async waitForJournalEvent(type, predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = [...journalSeen].reverse().find((event) => {
          if (event.type !== type) return false;
          return predicate === null || predicate(event);
        });
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    },
    async dispose() {
      // Close FIRST so the journal observes the full closing trace
      // (runtime.closing -> ... -> runtime.closed), then unsubscribe.
      await provider.close(session, "lesson_end");
      providerSubscription.dispose();
      try { rmSync(leaf.value.host_root, { recursive: true, force: true }); } catch { /* explicit below */ }
    },
  };
  return fixture;
}

// -----------------------------------------------------------------------------

describe("P5.6 real Docker journal integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(WS_ROOT, { recursive: true });
    ensureConfigContext();
  });

  after(() => {
    for (const id of containerIdsForInstallation()) docker("rm", "--force", id);
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("journal over real guest pipes: bounded coherent trace, chunk-spanning redaction before storage, per-stream transcripts", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L056-S001-B001", command: "node secret_chunks.js", process_id: "secret_proc" }],
    });
    try {
      const grant = fx.grants.get("C01-L056-S001-B001")!;
      await fx.provider.start(fx.session, grant.operation_id, grant.attempt_id);
      // The second write completes the spanning secret; its redacted chunk
      // ("[REDACTED] part2") is stored on arrival. Also wait until the full
      // interleaved stderr trace exists so the stop cannot race the stream.
      await fx.waitForJournalEvent("process.output", (e) => (e.payload as { text: string }).text.includes("part2"), 15_000);
      await fx.waitForJournalEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P56_ERR_3"), 15_000);
      const stopResult = await fx.provider.stop(fx.session, "secret_proc", "operator_stop");
      assert.equal(stopResult.outcome, "stopped");
      await fx.waitForJournalEvent("process.stopped", null, 10_000);
      await fx.dispose();

      // -- no silent journal rejections, strictly consecutive seq -------------
      assert.deepEqual(fx.journalRejections, [], "the journal accepted every provider event");
      const seqs = fx.journalSeen.map((e) => e.seq);
      assert.ok(seqs.length > 5, `a real trace was journaled (${seqs.length} events)`);
      assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), "journal seq is strictly consecutive");
      assert.equal(fx.journal.status().high_seq, seqs[seqs.length - 1]!);
      assert.equal(fx.journalSeen[0]!.type, "operation.accepted", "the trace opens with the accepted operation");
      assert.equal(fx.journalSeen[1]!.type, "process.started", "started precedes buffered output");
      assert.equal(fx.journalSeen[seqs.length - 1]!.type, "runtime.closed", "runtime.closed closes the trace");
      // Monotonic host stamps, labelled separately from guest durations.
      const stamps = fx.journalSeen.map((e) => e.monotonic_ms);
      assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), "monotonic_ms never regresses");

      // -- redaction: no raw duplicate of the chunk-spanning fake secret ------
      const page = fx.journal.snapshot(0);
      const serialized = JSON.stringify(page);
      assert.equal(serialized.includes(FAKE_SECRET), false, "the spanning secret is not stored raw anywhere in the journal");
      assert.ok(serialized.includes(JOURNAL_POLICY.redaction_marker), "the redaction marker IS present");
      for (const event of fx.journalSeen) {
        assert.equal(JSON.stringify(event).includes(FAKE_SECRET), false, "no subscriber ever received the raw secret");
      }
      // Coherent redacted transcript: the raw prefix of the spanning secret was
      // never emitted; the flushed tail is redacted; order preserved.
      const transcript = fx.journal.transcript("secret_proc");
      assert.equal(
        transcript.stdout,
        "P56_BEGIN token=[REDACTED] part2\nP56_SIGINT_SEEN\n",
        `coherent redacted stdout (got ${JSON.stringify(transcript.stdout)})`,
      );
      // Per-stream separation: stderr is its own ordered stream, never blended.
      assert.equal(transcript.stderr, "P56_ERR_1\nP56_ERR_2\nP56_ERR_3\n");
      const stderrOffsets = transcript.stderr_offsets;
      assert.deepEqual(stderrOffsets, [...stderrOffsets].sort((a, b) => a - b), "stderr offsets strictly increase");
      const stdoutOffsets = transcript.stdout_offsets;
      assert.deepEqual(stdoutOffsets, [...stdoutOffsets].sort((a, b) => a - b), "stdout offsets strictly increase");
      assert.equal(stdoutOffsets[0], 0, "raw-stream offsets start at the stream origin");

      // -- diagnostic separation ---------------------------------------------
      for (const event of fx.journalSeen.filter((e) => e.type.startsWith("runtime."))) {
        assert.equal(event.operation_id, null, "session/diagnostic events carry null operation provenance");
        assert.equal(event.attempt_id, null);
        assert.equal(event.type === "process.output", false, "diagnostics never become lesson output");
      }
      assert.ok(fx.journalSeen.some((e) => e.type === "runtime.closed"), "the session-terminal diagnostic was journaled");
    } finally {
      try { await fx.dispose(); } catch { /* already disposed above */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("replay: the feed delivers the real trace exactly once in order; real reset pages exist for stale cursors", async () => {
    const fx = await openSessionFixture({
      ops: [{ op_id: "C01-L056-S001-B001", command: "node interleave.js", process_id: "interleaved" }],
    });
    try {
      // The feed subscribes BEFORE its first snapshot fetch, then applies the
      // real journal pages while the session is live.
      const delivered: RuntimeEvent[] = [];
      const gaps: Array<{ from: number; to: number }> = [];
      const feed = createRuntimeEventFeed({
        snapshot: (afterSeq) => fx.journal.snapshot(afterSeq),
        subscribe: (listener) => fx.journal.subscribe(listener),
        onEvent: (event) => delivered.push(event),
        onGap: (gap) => gaps.push(gap),
      });
      await feed.start();
      const grant = fx.grants.get("C01-L056-S001-B001")!;
      await fx.provider.start(fx.session, grant.operation_id, grant.attempt_id);
      await fx.waitForJournalEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P56_OUT_A4"), 15_000);
      await fx.provider.stop(fx.session, "interleaved", "operator_stop");
      await fx.waitForJournalEvent("process.stopped", null, 10_000);
      await fx.dispose();
      // Exactly-once, in order, no gaps over a REAL live session.
      const stored = fx.journal.status();
      assert.equal(delivered.length, stored.event_count, "the feed delivered every journaled event exactly once");
      assert.deepEqual(delivered.map((e) => e.seq), Array.from({ length: stored.event_count }, (_, i) => i + 1));
      assert.deepEqual(gaps, []);
      assert.equal(feed.appliedSeq, stored.high_seq);
      // A stale future cursor against the REAL journal is an explicit reset page.
      const stalePage = fx.journal.snapshot(stored.high_seq + 5);
      assert.equal(stalePage.reset, true);
      assert.equal(stalePage.events.length, 0);
      assert.equal(stalePage.page_end_seq, stored.high_seq);
      // Cursor continuation pages never repeat events.
      const page1 = fx.journal.snapshot(0);
      const page2 = fx.journal.snapshot(page1.page_end_seq);
      const overlap = page1.events.filter((e) => page2.events.some((o) => o.seq === e.seq));
      assert.equal(overlap.length, 0, "page continuation never repeats an event");
    } finally {
      try { await fx.dispose(); } catch { /* already disposed above */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });

  it("close: no output enters the journal after runtime.closed; cleanup confirmed; zero owned containers", async () => {
    const fx = await openSessionFixture({
      ops: [
        { op_id: "C01-L056-S001-B001", command: "node interleave.js", process_id: "proc_a" },
        { op_id: "C01-L056-S001-B002", command: "node secret_chunks.js", process_id: "proc_b" },
      ],
    });
    try {
      const grantA = fx.grants.get("C01-L056-S001-B001")!;
      const grantB = fx.grants.get("C01-L056-S001-B002")!;
      await fx.provider.start(fx.session, grantA.operation_id, grantA.attempt_id);
      await fx.provider.start(fx.session, grantB.operation_id, grantB.attempt_id);
      await fx.waitForJournalEvent("process.output", (e) => (e.payload as { text: string }).text.includes("P56_OUT_A2"), 15_000);
      const cleanup = await fx.provider.close(fx.session, "app_close");
      assert.equal(cleanup.cleanup_status, "confirmed");
      await fx.waitForJournalEvent("runtime.closed", (e) => (e.payload as { cleanup_status: string }).cleanup_status === "confirmed", 20_000);
      const closedAt = fx.journalSeen.length;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
      assert.equal(fx.journalSeen.length, closedAt, "no late output or stale-generation event entered the journal after runtime.closed");
      assert.equal(fx.journalSeen[fx.journalSeen.length - 1]!.type, "runtime.closed");
    } finally {
      try { await fx.dispose(); } catch { /* close already removed the session */ }
    }
    assert.equal(containerIdsForInstallation().length, 0, "no owned container survives");
  });
});

describe("P5.6 daemon-free guarantees (no Docker required)", () => {
  it("the journal and feed modules import no execution machinery (fs/network/child_process/Docker)", () => {
    for (const rel of ["../src/journal.ts", "../src/events.ts"]) {
      const code = readFileSync(join(here, rel), "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      for (const forbidden of ["node:fs", "node:net", "node:child_process", "node:http", "docker", "node-pty"]) {
        assert.equal(code.includes(forbidden), false, `${rel} must not reference ${forbidden}`);
      }
    }
  });
});
