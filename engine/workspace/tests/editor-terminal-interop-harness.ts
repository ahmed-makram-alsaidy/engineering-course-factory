// P6.13 terminal interoperability — shared main-side test harness.
//
// NOT a test file (no node:test describes here): deterministic, Docker and
// Windows suites build their interop sessions through these helpers so the
// fixture pipeline stays identical everywhere. Fixture IR is NEVER
// hand-authored: synthetic lesson sources compile through the canonical
// pipeline (parseLessonData -> compileLesson -> createEditorCatalog), the
// reviewed policy binds the REAL catalog digest, and the seed manifest is
// built from the exact setup bytes.
//
// The FakeEpochOps double simulates the guest bind by reading/writing the
// SAME authoritative leaf a container would mount (host node executes
// committed scripts for the deterministic run proof). It enforces the same
// fencing predicate order as the real provider (session -> generation ->
// epoch -> lease) and fails closed with the same coded errors. The REAL
// container bind is proven by the Docker suite (gate-only); this double
// proves orchestration logic only and can never authorize a PASS alone.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import {
  computeSeedManifestDigest,
  createReviewedWorkspacePolicy,
  createSeedManifest,
  sha256Hex,
  type ReviewedWorkspacePolicy,
  type SeedManifest,
} from "../src/policy.ts";
import { createEditorCatalog } from "../src/editor-admission.ts";
import { openWindowsFileAdapter } from "../src/file-adapter.ts";
import {
  createEditorTerminalInterop,
  type EditorTerminalInterop,
  type EpochHandleLike,
  type EpochObservation,
  type TerminalEpochOps,
} from "../src/editor-terminal-interop.ts";

const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..", "..");

let lessonSeq = 0;

export interface BuiltLesson {
  readonly raw: unknown;
  readonly compiled: CompiledLesson;
  readonly lessonId: string;
  readonly operationIds: string[];
  readonly catalogDigest: string;
}

/** Build one synthetic lesson through the canonical pipeline (editor + terminal beats in authored order). */
export function buildInteropLesson(tag: string, actions: Array<{ action: unknown }>): BuiltLesson {
  lessonSeq += 1;
  const lessonId = `C01-L${String(610 + lessonSeq).padStart(3, "0")}`;
  const operationIds = actions.map((_, index) => `${lessonId}-S001-B${String(index + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: `Synthetic P6.13 lesson ${tag} ${lessonId}`,
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Prove editor and terminal share one authoritative workspace"],
    prerequisites: [],
    keywords: ["editor", "terminal", "interop", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.13", tag },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        type: "code_demo",
        title: "Edit then run on the shared workspace",
        duration: 120,
        visual: { kind: "code_editor", description: "Editor and terminal share one leaf" },
        beats: actions.map((entry, index) => ({ beat_id: operationIds[index], kind: "action", action: entry.action })),
      },
    ],
  };
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true, `synthetic lesson must pass canonical source validation: ${JSON.stringify((parsed as { issues?: unknown }).issues ?? [])}`);
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  const compiled = compileModule.compileLesson(parsed.lesson);
  const catalog = createEditorCatalog(compiled);
  assert.equal(catalog.ok, true, "mixed editor/terminal lesson must build an editor catalog");
  if (!catalog.ok) throw new Error("unreachable");
  return { raw, compiled, lessonId, operationIds, catalogDigest: catalog.value.lesson_compiled_digest };
}

export function terminalRunForeground(command: string): { action: unknown } {
  return { action: { type: "terminal_run", command, mode: "foreground" } };
}

export function terminalWatcher(processId: string, command: string): { action: unknown } {
  return { action: { type: "terminal_run", command, mode: "background", process_id: processId } };
}

/** Reviewed seed manifest built from the exact setup bytes (plus parent dirs). */
export function manifestFor(files: Record<string, string>, extraDirs: readonly string[] = []): SeedManifest {
  const dirs = new Set<string>(extraDirs);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      dirs.add(parts.slice(0, depth).join("/"));
    }
  }
  const entries = [
    ...[...dirs].sort().map((portable_path) => ({ portable_path, kind: "directory" as const, byte_length: 0, sha256: null as string | null })),
    ...Object.entries(files).map(([portable_path, text]) => ({
      portable_path,
      kind: "regular_file" as const,
      byte_length: Buffer.byteLength(text, "utf8"),
      sha256: sha256Hex(text) as string | null,
    })),
  ];
  const outcome = createSeedManifest(entries);
  assert.equal(outcome.ok, true, "seed manifest must build");
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

/** Reviewed policy binding the REAL catalog digest (honest review binding, never a label hash). */
export function policyFor(lesson: BuiltLesson, seed: SeedManifest, access: Record<string, "read_only" | "read_write">): ReviewedWorkspacePolicy {
  const outcome = createReviewedWorkspacePolicy(
    {
      course_id: "C01",
      lesson_id: lesson.lessonId,
      lesson_compiled_digest: lesson.catalogDigest,
      seed_manifest_digest: computeSeedManifestDigest(seed),
      sandbox_policy_digest: sha256Hex("p613-sandbox-policy"),
      terminal_access: access,
      reviewed_by: "reviewer",
      review_note: "p6.13 terminal interoperability",
    },
    Object.keys(access),
  );
  assert.equal(outcome.ok, true, "reviewed policy must register with exact terminal coverage");
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}

function codedError(code: string, message: string): Error {
  const error = new Error(`[${code}] ${message}`);
  (error as Error & { code?: string }).code = code;
  return error;
}

/**
 * Deterministic epoch double over the same authoritative leaf. Reads and
 * writes go through the leaf a container would mount; script runs execute
 * host node over the committed bytes (real execution, not canned output).
 * Fencing mirrors the real provider predicate order with identical codes.
 */
export class FakeEpochOps implements TerminalEpochOps {
  readonly calls: string[] = [];
  readonly prepared: EpochHandleLike[] = [];
  live: EpochHandleLike | null = null;
  readonly revoked = new Set<string>();
  forceUnconfirmedRetire = false;
  /** When set, writes wait on the gate (proves in-flight RW exclusivity). */
  gateWrite: (() => Promise<void>) | null = null;
  private handleSeq = 0;
  readonly leaf: string;
  readonly namePrefix: string;

  constructor(leaf: string, namePrefix: string) {
    this.leaf = leaf;
    this.namePrefix = namePrefix;
  }

  private fence(handle: unknown): EpochHandleLike {
    const live = this.live;
    if (live === null) throw codedError("STALE_EPOCH", "no epoch container is live");
    const presented = handle as Partial<EpochHandleLike>;
    if (typeof presented.sessionId !== "string") throw codedError("INVALID_REQUEST", "epoch handle failed strict validation");
    if (presented.sessionId !== live.sessionId) throw codedError("WRONG_OWNER", "epoch handle names a different session");
    if (presented.generation !== live.generation) throw codedError("STALE_SESSION", "epoch handle carries a stale session generation");
    if (presented.epoch !== live.epoch) throw codedError("STALE_EPOCH", "epoch handle carries a stale container epoch");
    if (presented.containerId !== live.containerId) throw codedError("WRONG_OWNER", "epoch handle names a different container");
    if (presented.leaseId !== live.leaseId || this.revoked.has(presented.leaseId ?? "")) {
      throw codedError("WORKSPACE_REVOKED", "epoch lease was revoked");
    }
    return live;
  }

  private checkRel(relPath: string): void {
    if (typeof relPath !== "string" || relPath.length === 0 || relPath.length > 256) {
      throw codedError("INVALID_REQUEST", "epoch path is not a valid workspace-relative file path");
    }
    if (relPath.includes("\0") || relPath.includes("\\") || relPath.includes(":")) {
      throw codedError("INVALID_REQUEST", "epoch path is not a valid workspace-relative file path");
    }
    if (relPath.startsWith("/") || relPath === "." || relPath === "..") {
      throw codedError("INVALID_REQUEST", "epoch path is not a valid workspace-relative file path");
    }
    for (const segment of relPath.split("/")) {
      if (segment.length === 0 || segment === "." || segment === "..") {
        throw codedError("INVALID_REQUEST", "epoch path is not a valid workspace-relative file path");
      }
    }
  }

  async prepareEpoch(args: {
    readonly sessionId: string;
    readonly generation: number;
    readonly epoch: number;
    readonly access: "read_only" | "read_write";
    readonly leafHostPath: string;
    readonly leaseId: string;
    readonly policyDigest: string;
    readonly containerName: string;
    readonly testRunId: string;
  }): Promise<EpochHandleLike> {
    this.calls.push(`prepare:${args.access}:${args.epoch}`);
    if (!args.containerName.startsWith(this.namePrefix) || !args.testRunId.startsWith(this.namePrefix)) {
      throw codedError("INVALID_REQUEST", "epoch names must carry the phase-owned prefix");
    }
    if (this.live !== null) throw codedError("WORKSPACE_BUSY", "an epoch container is already live");
    this.handleSeq += 1;
    const handle: EpochHandleLike = {
      handleId: `fake-h-${this.handleSeq}`,
      sessionId: args.sessionId,
      generation: args.generation,
      epoch: args.epoch,
      access: args.access,
      leaseId: args.leaseId,
      containerId: `fake-container-${this.handleSeq}`,
      containerName: args.containerName,
    };
    this.live = handle;
    this.prepared.push({ ...handle });
    return { ...handle };
  }

  async readEpochFile(handle: EpochHandleLike, relPath: string): Promise<EpochObservation> {
    this.fence(handle);
    this.checkRel(relPath);
    this.calls.push(`read:${relPath}`);
    const abs = join(this.leaf, ...relPath.split("/"));
    if (!existsSync(abs)) return { exitCode: 1, stdout: "", stderr: `cat: ${relPath}: No such file or directory` };
    return { exitCode: 0, stdout: readFileSync(abs, "utf8"), stderr: "" };
  }

  async runEpochScript(handle: EpochHandleLike, relPath: string): Promise<EpochObservation> {
    this.fence(handle);
    this.checkRel(relPath);
    if (!relPath.endsWith(".js")) throw codedError("INVALID_REQUEST", "epoch scripts run committed workspace scripts only");
    this.calls.push(`run:${relPath}`);
    const abs = join(this.leaf, ...relPath.split("/"));
    if (!existsSync(abs)) return { exitCode: 1, stdout: "", stderr: `node: ${relPath}: No such file` };
    const result = spawnSync(process.execPath, [abs], { encoding: "utf8", timeout: 10_000 });
    return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  async attemptEpochWrite(handle: EpochHandleLike, relPath: string, content: string): Promise<EpochObservation> {
    const live = this.fence(handle);
    this.checkRel(relPath);
    if (typeof content !== "string" || content.includes("\0") || Buffer.byteLength(content, "utf8") > 4096) {
      throw codedError("INVALID_REQUEST", "epoch write content must be bounded text without NUL");
    }
    if (this.gateWrite !== null) await this.gateWrite();
    this.calls.push(`write:${relPath}`);
    if (live.access !== "read_write") {
      return { exitCode: 2, stdout: "", stderr: "sh: cannot create: Read-only file system" };
    }
    const abs = join(this.leaf, ...relPath.split("/"));
    try {
      writeFileSync(abs, content, "utf8");
    } catch {
      return { exitCode: 1, stdout: "", stderr: `sh: ${relPath}: No such file or directory` };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async retireEpoch(handle: EpochHandleLike, cause: string): Promise<{ cleanup: "confirmed" | "unconfirmed" }> {
    this.fence(handle);
    this.calls.push(`retire:${cause}`);
    if (this.forceUnconfirmedRetire) return { cleanup: "unconfirmed" };
    this.revoked.add((handle as EpochHandleLike).leaseId);
    this.live = null;
    return { cleanup: "confirmed" };
  }
}

export interface OpenHarness {
  readonly interop: EditorTerminalInterop;
  readonly ops: readonly string[];
  readonly leaf: string;
  readonly staging: string;
  readonly fake: FakeEpochOps;
  readonly lesson: BuiltLesson;
}

let harnessSeq = 0;
let requestSeq = 0;

/** Fresh request id per call (single-use semantics like production callers). */
export function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p613-${prefix}-${requestSeq}`;
}

export interface HarnessOptions {
  readonly root: string;
  readonly tag: string;
  readonly namePrefix: string;
  readonly actions: Array<{ action: unknown }>;
  readonly seedFiles: Record<string, string>;
  /** Explicit empty seed directories (parents for pending creations). */
  readonly seedDirs?: readonly string[];
  /** Reviewed access per terminal beat in authored order (exact coverage enforced). */
  readonly terminalModes: Array<"read_only" | "read_write">;
  readonly terminal?: TerminalEpochOps;
  readonly fake?: FakeEpochOps;
}

/** Main-held leaf preparation (clear, seed dirs/files, clear staging). */
export function makePrepareLeaf(leaf: string, staging: string, seedDirs: readonly string[]) {
  return (files: Readonly<Record<string, string>>): void => {
    rmSync(leaf, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(leaf, { recursive: true });
    mkdirSync(staging, { recursive: true });
    for (const dir of seedDirs) {
      mkdirSync(join(leaf, ...dir.split("/")), { recursive: true });
    }
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(leaf, ...rel.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text, "utf8");
    }
  };
}

/** Main-held adapter binding over the coordinator-issued identities. */
export function makeBindAdapter(leaf: string, staging: string) {
  return (descriptor: { sessionId: string; generation: number; workspaceId: string }) => {
    const bound = openWindowsFileAdapter({
      sessionId: descriptor.sessionId,
      generation: descriptor.generation,
      workspaceId: descriptor.workspaceId,
      leafHostPath: leaf,
      stagingHostPath: staging,
    });
    if (!bound.ok) return { ok: false as const, code: bound.rejection.code, message: bound.rejection.message };
    return { ok: true as const, adapter: bound.value };
  };
}

/** Open one interop session over a fresh phase-owned leaf (caller cleans TEST_ROOT in after()). */
export function openHarness(options: HarnessOptions): OpenHarness {
  harnessSeq += 1;
  const lesson = buildInteropLesson(options.tag, options.actions);
  const terminalOpIds = lesson.operationIds.filter((_, index) => {
    const action = (options.actions[index] as { action: { type?: unknown } }).action;
    return action.type === "terminal_run";
  });
  assert.equal(terminalOpIds.length, options.terminalModes.length, "one reviewed access per terminal beat in authored order");
  const access: Record<string, "read_only" | "read_write"> = {};
  terminalOpIds.forEach((id, index) => {
    access[id] = options.terminalModes[index] ?? "read_only";
  });
  const seed = manifestFor(options.seedFiles, options.seedDirs ?? []);
  const policy = policyFor(lesson, seed, access);
  const leaf = join(options.root, `leaf-${harnessSeq}`);
  const staging = join(options.root, `staging-${harnessSeq}`);
  const fake = options.fake ?? new FakeEpochOps(leaf, options.namePrefix);
  const terminal: TerminalEpochOps = options.terminal ?? fake;
  const created = createEditorTerminalInterop({
    compiledLesson: lesson.compiled,
    reviewedPolicy: policy,
    seedManifest: seed,
    seedFiles: options.seedFiles,
    leafHostPath: leaf,
    installationId: `${options.namePrefix}installation`,
    containerNamePrefix: options.namePrefix,
    testRunId: `${options.namePrefix}run`,
    terminal,
    prepareLeaf: makePrepareLeaf(leaf, staging, options.seedDirs ?? []),
    bindAdapter: makeBindAdapter(leaf, staging),
  });
  assert.equal(created.ok, true, `interop session must open: ${created.ok ? "" : created.rejection.message}`);
  if (!created.ok) throw new Error("unreachable");
  return { interop: created.value, ops: lesson.operationIds, leaf, staging, fake, lesson };
}

/** Identifier-only operation request bound to the live session. */
export function op(interop: EditorTerminalInterop, operationId: string, prefix: string): { session_id: string; generation: number; operation_id: string; request_id: string } {
  const described = interop.describe();
  return { session_id: described.session_id, generation: described.generation, operation_id: operationId, request_id: nextRequest(prefix) };
}

/** Identifier-only lifecycle request bound to the live session. */
export function life(interop: EditorTerminalInterop, prefix: string): { session_id: string; generation: number; request_id: string } {
  const described = interop.describe();
  return { session_id: described.session_id, generation: described.generation, request_id: nextRequest(prefix) };
}

export function rejectionCode(outcome: unknown): string {
  if (outcome !== null && typeof outcome === "object" && "ok" in outcome && (outcome as { ok: boolean }).ok === false) {
    return ((outcome as { ok: false; rejection: { code: string } }).rejection.code ?? "UNKNOWN");
  }
  return "OK";
}
