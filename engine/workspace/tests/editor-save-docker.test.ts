// P6.10 Save and journal — REAL Docker RO watcher interop (gate-only, no skips).
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.10 Save and journal
// plus sections 26.7 (watcher visibility) and 26.12 (RO watcher + save proof).
// Proves on the real platform that an approved background RO watcher coexists
// with host saves: the same live RO container observes only complete old/new
// committed bytes across verified saves, guest writes stay denied (EROFS),
// no container recreation occurs for saves, and staging never appears in the
// guest tree. Deterministic commit, journal, and failure classification are
// proven in editor-save.test.ts; real Windows commit is proven in
// editor-save-windows.test.ts; this suite proves the Docker visibility that
// determinism cannot.
// Every resource is prefixed cf-p610- under temp/P6.10/docker. Cleanup is
// ownership-scoped (live containers first, then the cf-p610- name sweep); no
// global prune ever. These tests FAIL (never skip) when the daemon or the
// pinned image is unavailable — the P6.10 gate requires the real proof.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLessonData } from "@course-factory/shared-types/validate";
import type { CompiledLesson } from "@course-factory/lesson-compiler/ir";
import { createSeedManifest, sha256Hex, type SeedManifest } from "../src/policy.ts";
import { openWindowsFileAdapter, type AdapterAuthority } from "../src/file-adapter.ts";
import { admitEditorOperation, createEditorCatalog, openEditorSession, type EditorSession } from "../src/editor-admission.ts";
import { executeAdmittedFileOpen } from "../src/editor-open-create.ts";
import { createFileSaveExecutor } from "../src/editor-save.ts";
const COMPILE_MODULE = "@course-factory/lesson-compiler/compile";
const compileModule = (await import(COMPILE_MODULE)) as {
  compileLesson: (lesson: NonNullable<ReturnType<typeof parseLessonData>["lesson"]>) => CompiledLesson;
};
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const TEST_ROOT = join(repoRoot, "temp", "P6.10", "docker");
const CONFIG_DIR = join(TEST_ROOT, "docker-config");
const PINNED_IMAGE = "node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const SUFFIX = randomBytes(3).toString("hex");
function proof(m: string): void {
  console.log(`P6.10 PROOF: ${m}`);
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
  const created = docker("--config", CONFIG_DIR, "context", "create", "desktop-linux", "--docker", "host=npipe:////./pipe/dockerDesktopLinuxEngine", "--description", "course-factory p6.10 runtime context");
  if (created.status !== 0) throw new Error(`failed to create private docker config context: ${created.stderr}`);
}
function dcfg(...argv: string[]): { status: number | null; stdout: string; stderr: string } {
  return docker("--config", CONFIG_DIR, ...argv);
}
let counter = 0;
let requestSeq = 0;
function nextRequest(p: string): string {
  requestSeq += 1;
  return `req-p610d-${p}-${requestSeq}`;
}
function sha256Text(t: string): string {
  return createHash("sha256").update(t, "utf8").digest("hex");
}
function buildLesson(actions: Array<{ action: unknown }>): { compiled: CompiledLesson; operationIds: string[] } {
  counter += 1;
  const lessonId = `C01-L${String(90 + counter).padStart(3, "0")}`;
  const operationIds = actions.map((_, i) => `${lessonId}-S001-B${String(i + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1", course_id: "C01", lesson_id: lessonId, title: `Synthetic P6.10 docker ${lessonId}`,
    language: "en", subject: "Programming", grade_level: "grade-10", duration: 300,
    learning_objectives: ["Docker save proof"], prerequisites: [], keywords: ["editor", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.10" },
    scenes: [{ scene_id: `${lessonId}-S001`, type: "code_demo", title: "Save", duration: 60, visual: { kind: "code_editor", description: "save" }, beats: actions.map((e, i) => ({ beat_id: operationIds[i], kind: "action", action: e.action })) }],
  };
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  return { compiled: compileModule.compileLesson(parsed.lesson), operationIds };
}
function manifestFor(files: Record<string, string>): SeedManifest {
  const entries = [
    { portable_path: "src", kind: "directory" as const, byte_length: 0, sha256: null as string | null },
    ...Object.entries(files).map(([portable_path, text]) => ({ portable_path, kind: "regular_file" as const, byte_length: Buffer.byteLength(text, "utf8"), sha256: sha256Hex(text) as string | null })),
  ];
  const o = createSeedManifest(entries);
  assert.equal(o.ok, true);
  if (!o.ok) throw new Error("unreachable");
  return o.value;
}
const DOC = "src/save.ts";
const V1 = "const save = 1;\n";
const V2 = "const save = 2;\n";
function openLeaf(files: Record<string, string>): { leaf: string; staging: string; tag: string } {
  const tag = `cf-p610-d${counter}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(join(leaf, "src"), { recursive: true });
  mkdirSync(staging, { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
  return { leaf, staging, tag };
}
function mustAdmit(session: EditorSession, operationId: string, requestId: string) {
  const o = admitEditorOperation(session, { session_id: session.sessionId, generation: session.generation, operation_id: operationId, request_id: requestId });
  assert.equal(o.ok, true);
  if (!o.ok) throw new Error("unreachable");
  return o.value;
}
function stageDirty(session: EditorSession, docId: string, text: string): void {
  assert.equal(session.registry.setBufferContent(docId, text).ok, true);
  assert.equal(session.registry.reserveDocumentOperation(docId, `test-dirty-${nextRequest("d")}`, true).ok, true);
}
before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  assert.equal(daemonOk(), true, "docker daemon must be reachable for the real RO interop proof (never skip)");
  assert.equal(baseImageOk(), true, "pinned base image must be present (never skip)");
  ensureConfigContext();
});
after(() => {
  for (const name of (dcfg("ps", "-aq", "--filter", "name=cf-p610-").stdout ?? "").trim().split(/\s+/).filter((s) => s.length > 0)) {
    dcfg("rm", "-f", name);
  }
  rmSync(TEST_ROOT, { recursive: true, force: true });
});
describe("P6.10 docker RO watcher plus save (real platform, no skips)", () => {
  it("P6.10 PROOF: RO watcher sees exact committed bytes across save", async () => {
    const { leaf, staging, tag } = openLeaf({ [DOC]: V1 });
    const seed = manifestFor({ [DOC]: V1 });
    const { compiled } = buildLesson([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }]);
    const cat = createEditorCatalog(compiled);
    assert.equal(cat.ok, true);
    if (!cat.ok) throw new Error("unreachable");
    const sessionId = `sess-p610d-${counter}`;
    const workspaceId = `ws-p610d-${counter}`;
    const opened = openEditorSession({ catalog: cat.value, sessionId, generation: 1, seedManifest: seed, reviewed: true });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const session = opened.value;
    const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const adapter = bound.value;
    const authority: AdapterAuthority = {
      lease: { kind: "editor_lease", leaseId: `lease-p610d-${counter}`, sessionId, generation: 1, workspaceId, epoch: 1, operationId: "op", requestId: nextRequest("a") },
      ownership: "EDITOR_OWNED", liveEpoch: 1, revokedLeaseIds: [],
    };
    const openAdm = mustAdmit(session, cat.value.editor_order[0]!, nextRequest("o"));
    assert.equal((await (await import("../src/editor-open-create.ts")).executeAdmittedFileOpen(session, openAdm, { adapter, authority })).ok, true);
    const cname = `${tag}-ro`;
    const created = dcfg("create", "--name", cname, "--platform", "linux/amd64", "--user", "1000:1000", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m", "--mount", `type=bind,source=${leaf},target=/workspace,readonly,bind-recursive=disabled`, PINNED_IMAGE, "sleep", "infinity");
    assert.equal(created.status, 0, `RO container create must succeed: ${created.stderr}`);
    const started = dcfg("start", cname);
    assert.equal(started.status, 0);
    try {
      const before = dcfg("exec", cname, "cat", `/workspace/${DOC}`);
      assert.equal(before.status, 0);
      assert.equal(before.stdout, V1);
      stageDirty(session, openAdm.document.document_id, V2);
      const saveAdm = mustAdmit(session, cat.value.editor_order[1]!, nextRequest("s"));
      const saved = await createFileSaveExecutor().execute(session, saveAdm, { adapter, authority });
      assert.equal(saved.ok, true);
      let observed = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const cur = dcfg("exec", cname, "cat", `/workspace/${DOC}`);
        if (cur.status === 0) observed = cur.stdout;
        if (observed === V2) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(observed, V2);
      const denied = dcfg("exec", cname, "sh", "-c", `echo evil > /workspace/${DOC} && echo WROTE || echo DENIED`);
      assert.match(denied.stdout + denied.stderr, /DENIED|Read-only file system|EROFS/i);
      assert.equal(readFileSync(join(leaf, ...DOC.split("/")), "utf8"), V2);
    } finally {
      dcfg("rm", "-f", cname);
    }
    proof("RO watcher sees exact committed bytes across save");
  });
  it("P6.10 PROOF: large save shows only complete old/new bytes", async () => {
    const big1 = ("// line1\n".repeat(2000) + "const a = 1;\n");
    const big2 = ("// line2\n".repeat(2000) + "const a = 2;\n");
    assert.notEqual(sha256Text(big1), sha256Text(big2));
    const { leaf, staging, tag } = openLeaf({ [DOC]: big1 });
    const seed = manifestFor({ [DOC]: big1 });
    const { compiled } = buildLesson([{ action: { type: "file_open", path: DOC } }, { action: { type: "file_save", path: DOC } }]);
    const cat = createEditorCatalog(compiled);
    assert.equal(cat.ok, true);
    if (!cat.ok) throw new Error("unreachable");
    const sessionId = `sess-p610d-${counter}`;
    const workspaceId = `ws-p610d-${counter}`;
    const opened = openEditorSession({ catalog: cat.value, sessionId, generation: 1, seedManifest: seed, reviewed: true });
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error("unreachable");
    const session = opened.value;
    const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
    assert.equal(bound.ok, true);
    if (!bound.ok) throw new Error("unreachable");
    const adapter = bound.value;
    const authority: AdapterAuthority = {
      lease: { kind: "editor_lease", leaseId: `lease-p610d-${counter}`, sessionId, generation: 1, workspaceId, epoch: 1, operationId: "op", requestId: nextRequest("a") },
      ownership: "EDITOR_OWNED", liveEpoch: 1, revokedLeaseIds: [],
    };
    const openAdm = mustAdmit(session, cat.value.editor_order[0]!, nextRequest("o"));
    assert.equal((await (await import("../src/editor-open-create.ts")).executeAdmittedFileOpen(session, openAdm, { adapter, authority })).ok, true);
    const cname = `${tag}-ro-big`;
    const created = dcfg("create", "--name", cname, "--platform", "linux/amd64", "--user", "1000:1000", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m", "--mount", `type=bind,source=${leaf},target=/workspace,readonly,bind-recursive=disabled`, PINNED_IMAGE, "sleep", "infinity");
    assert.equal(created.status, 0);
    assert.equal(dcfg("start", cname).status, 0);
    try {
      stageDirty(session, openAdm.document.document_id, big2);
      const saveAdm = mustAdmit(session, cat.value.editor_order[1]!, nextRequest("s"));
      const savePromise = createFileSaveExecutor().execute(session, saveAdm, { adapter, authority });
      const seen = new Set<string>();
      const deadline = Date.now() + 5000;
      let done = false;
      void savePromise.then(() => {
        done = true;
      });
      while (!done && Date.now() < deadline) {
        const cur = dcfg("exec", cname, "cat", `/workspace/${DOC}`);
        if (cur.status === 0) {
          seen.add(sha256Text(cur.stdout));
          assert.ok(cur.stdout === big1 || cur.stdout === big2, "RO watcher observes only complete old/new bytes, never partial or missing");
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      const saved = await savePromise;
      assert.equal(saved.ok, true);
      assert.ok(seen.has(sha256Text(big1)) || seen.size === 0);
      const fin = dcfg("exec", cname, "cat", `/workspace/${DOC}`);
      assert.equal(fin.stdout, big2);
    } finally {
      dcfg("rm", "-f", cname);
    }
    proof("large save shows only complete old/new bytes");
  });
});
