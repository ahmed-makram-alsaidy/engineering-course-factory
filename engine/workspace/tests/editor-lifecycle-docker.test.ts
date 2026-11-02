// P6.11 Cancel/reset/replay — REAL Docker epoch retirement proofs (gate-only, no skips).
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.11 Cancel/reset/replay
// plus sections 26.1/26.3/26.10/26.12 (exclusive writer epochs, Docker
// enforcement, reset barrier, RO watcher plus save). Proves on the real
// platform that lifecycle reset retires a live Docker epoch before any new
// generation is exposed: the read-only observer sees exact committed bytes
// across a lifecycle save with guest writes denied, reset revokes ownership
// and removes the container with daemon-confirmed absence, the old epoch
// stays fenced, the new generation is never exposed early, and zero owned
// containers remain. Deterministic cancel, replay, generation and fencing
// semantics are proven in editor-lifecycle.test.ts; real Windows reseed is
// proven in editor-lifecycle-windows.test.ts.
// Every resource is prefixed cf-p611- under temp/P6.11/docker. Cleanup is
// ownership-scoped (live containers first, then the cf-p611- name sweep); no
// global prune ever. These tests FAIL (never skip) when the daemon or the
// pinned image is unavailable — the P6.11 gate requires the real proof.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { createSeedManifest, sha256Hex, type SeedManifest } from "../src/policy.ts";
import { openWindowsFileAdapter, type WindowsFileAdapter } from "../src/file-adapter.ts";
import { createEditorCatalog, type EditorOperationAdmission } from "../src/editor-admission.ts";
import { createEditorLifecycle, type EditorLifecycle, type LifecycleExecDeps } from "../src/editor-lifecycle.ts";
const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.11", "docker");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");
const PINNED_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const DOC = "src/app.ts";
const V1 = "const a = 1;\n";
const V2 = "const a = 2;\n";
function proof(m: string): void {
  console.log(`P6.11 PROOF: ${m}`);
}
function resolveDockerExe(): string {
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
  const r = spawnSync(DOCKER_EXE, argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function daemonOk(): boolean {
  const r = docker("version", "--format", "{{.Server.Version}}");
  return r.status === 0 && r.stdout.trim().length > 0;
}
function baseImageOk(): boolean {
  const r = docker("image", "inspect", PINNED_IMAGE, "--format", "{{.Id}}");
  return r.status === 0 && /^sha256:[0-9a-f]{64}$/.test(r.stdout.trim());
}
function ensureConfigContext(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const ls = docker("--config", CONFIG_DIR, "context", "ls");
  if ((ls.stdout ?? "").includes("desktop-linux")) return;
  const created = docker("--config", CONFIG_DIR, "context", "create", "desktop-linux", "--docker", "host=npipe:////./pipe/dockerDesktopLinuxEngine", "--description", "course-factory p6.11 runtime context");
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}
function dcfg(...argv: string[]): { status: number | null; stdout: string; stderr: string } {
  return docker("--config", CONFIG_DIR, ...argv);
}
function containerExists(name: string): boolean {
  const r = dcfg("inspect", name, "--format", "{{.Id}}");
  return r.status === 0 && (r.stdout ?? "").trim().length > 0;
}
function removeContainer(name: string): void {
  dcfg("rm", "-f", name);
}
async function pollAbsent(name: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (!containerExists(name)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}
async function pollGuestText(name: string, guestPath: string, expected: string, deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let observed = "";
  for (;;) {
    const cur = dcfg("exec", name, "cat", guestPath);
    if (cur.status === 0) observed = cur.stdout;
    if (observed === expected) return observed;
    if (Date.now() >= deadline) return observed;
    await new Promise((r) => setTimeout(r, 250));
  }
}
let counter = 0;
let requestSeq = 0;
function nextRequest(p: string): string {
  requestSeq += 1;
  return `req-p611d-${p}-${requestSeq}`;
}
function buildLesson(actions: Array<{ action: unknown }>): { compiled: CompiledLesson; operationIds: string[] } {
  counter += 1;
  const lessonId = `C01-L${String(130 + counter).padStart(3, "0")}`;
  const operationIds = actions.map((_, i) => `${lessonId}-S001-B${String(i + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1", course_id: "C01", lesson_id: lessonId, title: `Synthetic P6.11 docker ${lessonId}`,
    language: "en", subject: "Programming", grade_level: "grade-10", duration: 300,
    learning_objectives: ["Docker epoch retirement proof"], prerequisites: [], keywords: ["editor", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.11" },
    scenes: [{ scene_id: `${lessonId}-S001`, type: "code_demo", title: "Docker", duration: 60, visual: { kind: "code_editor", description: "docker" }, beats: actions.map((e, i) => ({ beat_id: operationIds[i], kind: "action", action: e.action })) }],
  };
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  return { compiled: compileModule.compileLesson(parsed.lesson), operationIds };
}
function manifestFor(files: Record<string, string>): SeedManifest {
  const entries = [
    { portable_path: "src", kind: "directory" as const, byte_length: 0, sha256: null as string | null },
    ...Object.entries(files).map(([portable_path, text]) => ({
      portable_path, kind: "regular_file" as const, byte_length: Buffer.byteLength(text, "utf8"), sha256: sha256Hex(text) as string | null,
    })),
  ];
  const o = createSeedManifest(entries);
  assert.equal(o.ok, true);
  if (!o.ok) throw new Error("unreachable");
  return o.value;
}
function openLeaf(files: Record<string, string>): { leaf: string; staging: string; tag: string } {
  const tag = `cf-p611-d${counter}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(join(leaf, "src"), { recursive: true });
  mkdirSync(staging, { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
  return { leaf, staging, tag };
}
function startRoObserver(leaf: string, cname: string): void {
  const created = dcfg("create", "--name", cname, "--platform", "linux/amd64", "--user", "1000:1000", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m", "--mount", `type=bind,source=${leaf},target=/workspace,readonly,bind-recursive=disabled`, PINNED_IMAGE, "sleep", "infinity");
  assert.equal(created.status, 0, `RO observer create must succeed: ${created.stderr}`);
  assert.equal(dcfg("start", cname).status, 0, "RO observer must start");
}
function mustAdmit(lc: EditorLifecycle, operationId: string, requestId: string): EditorOperationAdmission {
  const o = lc.admit(operationId, requestId);
  assert.equal(o.ok, true, `admission of ${operationId} must succeed`);
  if (!o.ok) throw new Error("unreachable");
  return o.value;
}
before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  assert.equal(daemonOk(), true, "docker daemon must be reachable for the real epoch proof (never skip)");
  assert.equal(baseImageOk(), true, "pinned base image must be present (never skip)");
  ensureConfigContext();
});
after(() => {
  for (const name of (dcfg("ps", "-aq", "--filter", "name=cf-p611-").stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0)) {
    dcfg("rm", "-f", name);
  }
  rmSync(TEST_ROOT, { recursive: true, force: true });
});
describe("P6.11 docker epoch retirement across reset (real platform, no skips)", () => {
  it("P6.11 PROOF: reset retires live RO epoch with confirmed absence", async () => {
    const { leaf, staging, tag } = openLeaf({ [DOC]: V1 });
    const seed = manifestFor({ [DOC]: V1 });
    const { compiled, operationIds } = buildLesson([
      { action: { type: "file_open", path: DOC } },
      { action: { type: "type_code", path: DOC, content: "const b = 2;\n" } },
      { action: { type: "file_save", path: DOC } },
    ]);
    const cat = createEditorCatalog(compiled);
    assert.equal(cat.ok, true);
    if (!cat.ok) throw new Error("unreachable");
    const sessionId = `sess-p611d-${counter}`;
    const workspaceId = `ws-p611d-${counter}`;
    const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const adapter: WindowsFileAdapter = bound.value;
    let retireCalls = 0;
    const cname = `${tag}-ro`;
    const lifecycle = createEditorLifecycle({
      catalog: cat.value, seedManifest: seed, sessionId, generation: 1,
      wiring: {
        retireContainer: async () => {
          retireCalls += 1;
          removeContainer(cname);
          const absent = await pollAbsent(cname, 30000);
          return absent ? "confirmed" : "unconfirmed";
        },
        reseed: async () => {
          writeFileSync(join(leaf, ...DOC.split("/")), V1, "utf8");
        },
      },
    });
    const authority = {
      lease: { kind: "editor_lease" as const, leaseId: `lease-p611d-${counter}`, sessionId, generation: 1, workspaceId, epoch: 1, operationId: "op", requestId: nextRequest("a") },
      ownership: "EDITOR_OWNED" as const, liveEpoch: 1, revokedLeaseIds: [] as string[],
    };
    const deps: LifecycleExecDeps = { adapter: adapter as unknown, authority: authority as never };
    const [openId, typeId, saveId] = operationIds;
    assert.equal((await lifecycle.executeOpen(mustAdmit(lifecycle, openId, nextRequest("o")), deps)).ok, true);
    startRoObserver(leaf, cname);
    try {
      assert.equal(dcfg("exec", cname, "cat", `/workspace/${DOC}`).stdout, V1, "RO observer reads committed disk");
      const typeAdm = mustAdmit(lifecycle, typeId, nextRequest("t"));
      const planned = lifecycle.planType(typeAdm);
      assert.equal(planned.ok, true);
      if (!planned.ok) throw new Error("unreachable");
      assert.equal(lifecycle.completeType(planned.value.plan_id).ok, true);
      assert.equal((await lifecycle.executeSave(mustAdmit(lifecycle, saveId, nextRequest("s")), deps)).ok, true);
      assert.equal(await pollGuestText(cname, `/workspace/${DOC}`, `${V1}const b = 2;\n`, 5000), `${V1}const b = 2;\n`, "RO observes the saved bytes within the bound");
      const denied = dcfg("exec", cname, "sh", "-c", `echo evil > /workspace/${DOC} && echo WROTE || echo DENIED`);
      assert.match(denied.stdout + denied.stderr, /DENIED|Read-only file system|EROFS/i, "guest writes stay denied");
      const before = lifecycle.describe();
      const reset = await lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("r") });
      assert.equal(reset.ok, true, "reset retires the live RO epoch");
      assert.equal(retireCalls, 1, "exactly one daemon-confirmed retirement");
      assert.equal(containerExists(cname), false, "daemon absence confirmed: old epoch removed");
      assert.equal(lifecycle.describe().generation, 2, "new generation exposed only after confirmed cleanup");
    } finally {
      removeContainer(cname);
    }
    proof("reset retires live RO epoch with confirmed absence");
  });
  it("P6.11 PROOF: old epoch fenced after reset with zero survivors", async () => {
    const { leaf, staging, tag } = openLeaf({ [DOC]: V1 });
    const seed = manifestFor({ [DOC]: V1 });
    const { compiled, operationIds } = buildLesson([{ action: { type: "file_open", path: DOC } }]);
    const cat = createEditorCatalog(compiled);
    assert.equal(cat.ok, true);
    if (!cat.ok) throw new Error("unreachable");
    const sessionId = `sess-p611d-${counter}`;
    const workspaceId = `ws-p611d-${counter}`;
    const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const cname = `${tag}-ro`;
    const lifecycle = createEditorLifecycle({
      catalog: cat.value, seedManifest: seed, sessionId, generation: 1,
      wiring: {
        retireContainer: async () => {
          removeContainer(cname);
          return (await pollAbsent(cname, 30000)) ? "confirmed" : "unconfirmed";
        },
        reseed: async () => {},
      },
    });
    const deps: LifecycleExecDeps = {
      adapter: bound.value as unknown,
      authority: {
        lease: { kind: "editor_lease", leaseId: `lease-p611d-${counter}`, sessionId, generation: 1, workspaceId, epoch: 1, operationId: "op", requestId: nextRequest("a") },
        ownership: "EDITOR_OWNED", liveEpoch: 1, revokedLeaseIds: [],
      } as never,
    };
    assert.equal((await lifecycle.executeOpen(mustAdmit(lifecycle, operationIds[0]!, nextRequest("o")), deps)).ok, true);
    startRoObserver(leaf, cname);
    assert.equal(containerExists(cname), true, "RO epoch live before reset");
    const before = lifecycle.describe();
    assert.equal((await lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("r") })).ok, true);
    const exec = dcfg("exec", cname, "cat", `/workspace/${DOC}`);
    assert.notEqual(exec.status, 0, "old epoch fenced: no exec into a retired container");
    assert.equal(containerExists(cname), false, "zero survivors of the old epoch");
    assert.equal(readFileSync(join(leaf, ...DOC.split("/")), "utf8"), V1, "host leaf intact");
    removeContainer(cname);
    proof("old epoch fenced after reset with zero survivors");
  });
  it("P6.11 PROOF: new generation not exposed early", async () => {
    const { leaf, staging, tag } = openLeaf({ [DOC]: V1 });
    const seed = manifestFor({ [DOC]: V1 });
    const { compiled } = buildLesson([{ action: { type: "file_open", path: DOC } }]);
    const cat = createEditorCatalog(compiled);
    assert.equal(cat.ok, true);
    if (!cat.ok) throw new Error("unreachable");
    const sessionId = `sess-p611d-${counter}`;
    const workspaceId = `ws-p611d-${counter}`;
    const cname = `${tag}-ro`;
    startRoObserver(leaf, cname);
    let releaseRetire: ((v: "confirmed" | "unconfirmed") => void) | null = null;
    const gate = new Promise<"confirmed" | "unconfirmed">((resolve) => {
      releaseRetire = resolve;
    });
    const lifecycle = createEditorLifecycle({
      catalog: cat.value, seedManifest: seed, sessionId, generation: 1,
      wiring: {
        retireContainer: () => gate.then((v) => {
          if (v === "confirmed") {
            removeContainer(cname);
            return pollAbsent(cname, 30000);
          }
          return false;
        }).then((absent) => (absent ? "confirmed" : "unconfirmed")),
        reseed: async () => {},
      },
    });
    try {
      const before = lifecycle.describe();
      const pending = lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("r") });
      assert.equal(lifecycle.describe().resetting, true, "RESETTING latched while the old container survives");
      assert.equal(lifecycle.describe().generation, 1, "new generation not exposed early");
      assert.equal(containerExists(cname), true, "old incompatible container still present");
      assert.equal(lifecycle.admit(cat.value.editor_order[0]!, nextRequest("slip")).ok, false, "no acquisition slips through");
      releaseRetire!("confirmed");
      const done = await pending;
      assert.equal(done.ok, true, "reset completes after daemon-confirmed removal");
      assert.equal(lifecycle.describe().generation, 2, "new generation exposed only after cleanup");
      assert.equal(containerExists(cname), false, "absence confirmed before exposure");
    } finally {
      removeContainer(cname);
    }
    proof("new generation not exposed early");
  });
  it("P6.11 PROOF: zero owned containers after gate", () => {
    const leftover = (dcfg("ps", "-aq", "--filter", "name=cf-p611-").stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0);
    assert.deepEqual(leftover, [], "zero cf-p611 containers remain with ownership-scoped cleanup");
    assert.equal(existsSync(TEST_ROOT), true, "phase root intact until the file-level sweep");
    proof("zero owned containers after gate");
  });
});
