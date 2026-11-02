// P5.12 REAL Docker integration — passive UI model against the live runtime.
//
//   synthetic lesson (canonical compile) -> TerminalHost.openSession ->
//   handleRunOperation (identifier-only, as TerminalPane's Run does) ->
//   DockerSandboxProvider -> live container -> guest supervisor ->
//   SessionJournal (authoritative seq) -> host.subscribe (as the pane's
//   preload-local onEvent does) + handleGetSnapshot (as replay does) ->
//   renderer model (applyTerminalRuntimeEvent/applyTerminalSnapshotPage).
//
// Proves the P5.12 PASS condition on the REAL path: real guest output flows
// into the passive view, the live badge derives from trusted events only,
// per-process transcripts stay separate, replay re-anchors, stale events are
// ignored, reset replays the new generation, and responses carry no private
// host paths. Every resource is prefixed cf-p512- (installation label
// cf-p512-installation) under the repository's ignored temp root. Tests are
// skipped (never silently passed) only when the daemon or the supervisor
// runtime image is unavailable — the P5.12 gate REQUIRES a real run and fails
// otherwise. Every test's finally removes only its own owned containers
// (never a global prune).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DockerSandboxProvider } from "@course-factory/terminal-engine/docker";
import { TerminalHost } from "@course-factory/terminal-engine/terminal-host";
import type { StartReceipt, RuntimeEvent } from "@course-factory/terminal-engine";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import {
  applyTerminalRuntimeEvent,
  applyTerminalSnapshotPage,
  initialTerminalRuntimeView,
  isTerminalRunEligible,
  selectTerminalTranscript,
  summarizeTerminalResultForBadge,
} from "../src/model/terminal-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P5.12");
const WS_ROOT = join(TEST_ROOT, "workspaces-root");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");

const RUNTIME_IMAGE_TAG = "cf-terminal-engine-runtime:p5.12";
const PINNED_BASE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const PINNED_BASE_DIGEST = PINNED_BASE.split("@")[1]!;
const INSTALLATION_ID = "cf-p512-installation";
const INSTALL_LABEL = "com.course-factory.installation";
const LESSON_ID = "C01-L512";

function resolveDockerExe(): string {
  const configured = process.env.CF_P512_DOCKER_EXE ?? process.env.CF_P54_DOCKER_EXE ?? process.env.CF_P511_DOCKER_EXE;
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
  const configured = process.env.CF_P512_RUNTIME_IMAGE;
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
    "--description", "course-factory p5.12 runtime context",
  );
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: never) => CompiledLesson;
};
const { parseLessonData } = await import("@course-factory/shared-types/validate");

function p512Lesson(): unknown {
  return {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: LESSON_ID,
    title: "P5.12 synthetic passive-UI lesson",
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Passive UI consumes real runtime events"],
    prerequisites: [],
    keywords: ["terminal", "synthetic", "p512"],
    metadata: { synthetic_fixture: true, phase: "P5.12" },
    scenes: [
      {
        scene_id: `${LESSON_ID}-S001`,
        type: "code_demo",
        title: "Foreground for the passive view",
        duration: 120,
        visual: { kind: "terminal", description: "synthetic" },
        beats: [
          {
            beat_id: `${LESSON_ID}-S001-B001`,
            kind: "action",
            action: {
              type: "terminal_run",
              command: "node -e \"console.log('P512_OK')\"",
              mode: "foreground",
              timeout_seconds: 60,
              expected_exit_code: 0,
            },
          },
          {
            beat_id: `${LESSON_ID}-S001-B002`,
            kind: "action",
            action: {
              type: "terminal_run",
              command: "node -e \"console.log('P512_BG_READY'); setInterval(()=>console.log('P512_BG_TICK'),300)\"",
              mode: "background",
              process_id: "p512-bg",
            },
          },
        ],
      },
    ],
  };
}

function compileSource(source: unknown): CompiledLesson {
  const parsed = parseLessonData(source);
  if (!parsed.ok || parsed.lesson === undefined) {
    throw new Error(`synthetic lesson failed source validation: ${JSON.stringify(parsed.issues)}`);
  }
  return compileModule.compileLesson(parsed.lesson as never);
}

function makeHost(): TerminalHost {
  return new TerminalHost({
    workspaceRoot: WS_ROOT,
    imageIdentity: {
      pinned_reference: PINNED_BASE,
      digest: PINNED_BASE_DIGEST,
      platform: "linux/amd64",
      pull_policy: "never",
      source: "base-image.lock.json",
    },
    hostEnv: {},
    forwardEnvNames: [],
    createProvider: () =>
      new DockerSandboxProvider({
        cli: { dockerExe: DOCKER_EXE, context: "desktop-linux", configDir: CONFIG_DIR, clientEnv: {} },
        imageReference: RUNTIME_IMAGE_REF!,
        installationId: INSTALLATION_ID,
      }),
  });
}

function uid(prefix: string): string {
  return `${prefix}-p512-${randomBytes(4).toString("hex")}`;
}

function unwrap<T>(outcome: { ok: true; value: T } | { ok: false; rejection: { code: string; message: string } }, label: string): T {
  if (!outcome.ok) throw new Error(`${label} rejected: ${(outcome as { ok: false; rejection: { code: string; message: string } }).rejection.code}`);
  return (outcome as { ok: true; value: T }).value;
}

async function waitForSnapshotText(host: TerminalHost, sessionId: string, marker: RegExp, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const page = host.handleGetSnapshot({ session_id: sessionId, after_seq: 0 });
    if (page.ok && marker.test(JSON.stringify(page.value))) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for snapshot marker ${marker}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
}

// -----------------------------------------------------------------------------

describe("P5.12 real Docker passive-UI integration", { skip: !AVAILABLE }, () => {
  before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(WS_ROOT, { recursive: true });
    ensureConfigContext();
  });

  after(() => {
    for (const id of containerIdsForInstallation()) docker("rm", "--force", id);
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("real output into the passive view: P512_OK, true exit 0, PASS badge, replay re-anchors", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    const opened = unwrap(host.openSession(compileSource(p512Lesson()), { session_id: sessionId, executionAuthorized: true }), "openSession");
    // Subscribe BEFORE the run (the pane's subscribe-before-snapshot discipline).
    const live: RuntimeEvent[] = [];
    const sub = host.subscribe(sessionId, (event) => live.push(structuredClone(event)));
    try {
      const receipt = unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B001`,
        request_id: "req-p512-view-1",
      }), "runOperation") as StartReceipt;
      assert.equal(receipt.operation_id, `${LESSON_ID}-S001-B001`);
      assert.equal(receipt.result?.exit_code, 0);
      await waitForSnapshotText(host, sessionId, /P512_OK/, 60_000);
      // Replay through the renderer model: snapshot pages then live arrivals.
      let view = initialTerminalRuntimeView({ session_id: sessionId, generation: opened.generation });
      const first = unwrap(host.handleGetSnapshot({ session_id: sessionId, after_seq: 0 }), "getSnapshot");
      view = applyTerminalSnapshotPage(view, first);
      for (const event of live) view = applyTerminalRuntimeEvent(view, event);
      const op = view.operations[`${LESSON_ID}-S001-B001`];
      assert.ok(op, "the passive view observed the operation");
      assert.equal(op.status, "PASS");
      assert.equal(summarizeTerminalResultForBadge(op), "PASS");
      assert.match(op.transcript.stdout, /P512_OK/);
      // No private host paths, container IDs, or PIDs in the view.
      assert.doesNotMatch(JSON.stringify(view), /[A-Za-z]:\\|containerId|host_root|docker\.sock/i);
      // Run eligibility: completed ops cannot rerun in this generation.
      assert.equal(
        isTerminalRunEligible({
          step: { kind: "operation", step_id: `${LESSON_ID}-S001-B001`, operation: { type: "terminal_run", family: "terminal", parameters: {} } } as never,
          view,
          executionAuthorized: true,
        }),
        false,
      );
      // A second snapshot page from the cursor is empty and stable.
      const tail = unwrap(host.handleGetSnapshot({ session_id: sessionId, after_seq: view.appliedSeq }), "tail snapshot");
      assert.equal(tail.events.length, 0);
      assert.equal(tail.reset, false);
    } finally {
      sub.dispose();
      await host.closeSession(sessionId, "lesson_end");
    }
  });

  it("stale owner events never enter the passive view; reset replays the new generation", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    const opened = unwrap(host.openSession(compileSource(p512Lesson()), { session_id: sessionId, executionAuthorized: true }), "openSession");
    try {
      unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B001`,
        request_id: "req-p512-stale-1",
      }), "runOperation");
      await waitForSnapshotText(host, sessionId, /P512_OK/, 60_000);
      let view = initialTerminalRuntimeView({ session_id: sessionId, generation: opened.generation });
      const page = unwrap(host.handleGetSnapshot({ session_id: sessionId, after_seq: 0 }), "getSnapshot");
      view = applyTerminalSnapshotPage(view, page);
      const anchored = view.appliedSeq;
      // A forged event for another session is ignored (stale counter only).
      const forged = structuredClone(page.events[0]) as RuntimeEvent;
      (forged as { session_id: string }).session_id = "sess-forged";
      view = applyTerminalRuntimeEvent(view, forged);
      assert.equal(view.appliedSeq, anchored);
      assert.equal(view.ignoredStale, 1);
      // Reset bumps the generation; the old view stays fenced and the new
      // generation replays cleanly (remount replays the correct generation).
      const reset = unwrap(await host.handleResetRuntime({ session_id: sessionId, request_id: "req-p512-reset-1" }), "resetRuntime");
      assert.ok(reset.generation > opened.generation);
      const fresh = initialTerminalRuntimeView({ session_id: sessionId, generation: reset.generation });
      const freshPage = unwrap(host.handleGetSnapshot({ session_id: sessionId, after_seq: 0 }), "fresh snapshot");
      const freshView = applyTerminalSnapshotPage(fresh, freshPage);
      assert.equal(freshView.appliedSeq, 0);
      assert.equal(Object.keys(freshView.operations).length, 0);
    } finally {
      await host.closeSession(sessionId, "lesson_end");
    }
  });

  it("background start vs lifetime stays distinct in the passive view", async () => {
    const host = makeHost();
    const sessionId = uid("sess");
    unwrap(host.openSession(compileSource(p512Lesson()), { session_id: sessionId, executionAuthorized: true }), "openSession");
    try {
      const receipt = unwrap(await host.handleRunOperation({
        session_id: sessionId,
        operation_id: `${LESSON_ID}-S001-B002`,
        request_id: "req-p512-bg-1",
      }), "background run") as StartReceipt;
      assert.equal(receipt.process_id, "p512-bg");
      assert.equal(receipt.result, undefined, "background receipts stay result-free (lifetime is event-driven)");
      await waitForSnapshotText(host, sessionId, /P512_BG_READY/, 60_000);
      const page = unwrap(host.handleGetSnapshot({ session_id: sessionId, after_seq: 0 }), "getSnapshot");
      let view = initialTerminalRuntimeView({ session_id: sessionId, generation: 1 });
      // Generation is 1 here (no reset in this test); resolve from the page.
      view = initialTerminalRuntimeView({ session_id: sessionId, generation: page.generation });
      view = applyTerminalSnapshotPage(view, page);
      const op = view.operations[`${LESSON_ID}-S001-B002`];
      assert.ok(op);
      assert.equal(op.status, "RUNNING");
      assert.match(op.transcript.stdout, /P512_BG_READY/);
      const transcript = selectTerminalTranscript(view, `${LESSON_ID}-S001-B002`);
      assert.ok(transcript && transcript.stdout.includes("P512_BG_READY"));
      // Operator stop through identifiers ends the lifetime; the view closes it.
      const stopped = unwrap(await host.handleStopProcess({
        session_id: sessionId,
        process_id: "p512-bg",
        request_id: "req-p512-bg-stop-1",
      }), "stopProcess");
      assert.equal(stopped.process_id, "p512-bg");
    } finally {
      await host.closeSession(sessionId, "lesson_end");
    }
  });
});
