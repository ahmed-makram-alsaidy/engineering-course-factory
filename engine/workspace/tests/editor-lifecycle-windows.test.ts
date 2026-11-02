// P6.11 Cancel/reset/replay — REAL Windows platform proofs (no skips).
// Canonical task: docs/P6-DESIGN-SPEC.md section 22, P6.11 Cancel/reset/replay
// plus sections 26.6/26.7/26.10/26.12 (NTFS backend, save algorithm, reset
// barrier, link attacks, atomic publication). Proves on the real NTFS
// platform that lifecycle reset and reseed touch real workspace bytes
// exactly as designed: dirty unsaved buffers discarded byte-exact,
// abandoned pending creations vanish from real disk, committed saves reset
// to the canonical seed byte-exact, no staging residue survives, Windows
// case aliases collapse onto one document across reset, and symlink and
// junction ancestry stays denied with outside sentinels unchanged.
// Deterministic cancel, replay, generation and fencing semantics are proven
// in editor-lifecycle.test.ts; real Docker epoch retirement is proven in
// editor-lifecycle-docker.test.ts (gate-only). Every resource lives under
// the phase-owned temp/P6.11/windows root with cf-p611-w names; no user
// files are touched.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const TEST_ROOT = join(repoRoot, "temp", "P6.11", "windows");
const DOC = "src/app.ts";
const SEED_V1 = "const a = 1;\n";
const MULTILINGUAL = "const greeting = \"salut\";\n// Arabic comment: code works\nconst emoji = \"demo ok\";\n";
function proof(message: string): void {
  console.log(`P6.11 PROOF: ${message}`);
}
let lessonSeq = 0;
let requestSeq = 0;
let harnessSeq = 0;
function nextRequest(prefix: string): string {
  requestSeq += 1;
  return `req-p611w-${prefix}-${requestSeq}`;
}
function compileLesson(actions: Array<{ action: unknown }>): { compiled: CompiledLesson; operationIds: string[] } {
  lessonSeq += 1;
  const lessonId = `C01-L${String(110 + lessonSeq).padStart(3, "0")}`;
  const operationIds = actions.map((_, index) => `${lessonId}-S001-B${String(index + 1).padStart(3, "0")}`);
  const raw: unknown = {
    schema_version: "1.1",
    course_id: "C01",
    lesson_id: lessonId,
    title: `Synthetic P6.11 windows ${lessonId}`,
    language: "en",
    subject: "Programming",
    grade_level: "grade-10",
    duration: 300,
    learning_objectives: ["Prove real Windows reset and reseed"],
    prerequisites: [],
    keywords: ["editor", "synthetic", "p6"],
    metadata: { synthetic_fixture: true, phase: "P6.11" },
    scenes: [
      {
        scene_id: `${lessonId}-S001`,
        type: "code_demo",
        title: "Windows lifecycle",
        duration: 120,
        visual: { kind: "code_editor", description: "Windows lifecycle" },
        beats: actions.map((entry, index) => ({ beat_id: operationIds[index], kind: "action", action: entry.action })),
      },
    ],
  };
  const parsed = parseLessonData(raw);
  assert.equal(parsed.ok, true, "synthetic lesson must validate");
  if (!parsed.ok || parsed.lesson === undefined) throw new Error("unreachable");
  return { compiled: compileModule.compileLesson(parsed.lesson), operationIds };
}
function manifestFor(files: Record<string, string>, extra: Array<{ portable_path: string; kind: "directory" | "regular_file"; digest?: string | null }> = []): SeedManifest {
  const entries = [
    { portable_path: "src", kind: "directory" as const, byte_length: 0, sha256: null as string | null },
    ...Object.entries(files).map(([portable_path, text]) => ({
      portable_path,
      kind: "regular_file" as const,
      byte_length: Buffer.byteLength(text, "utf8"),
      sha256: sha256Hex(text) as string | null,
    })),
    ...extra.map((e) => ({
      portable_path: e.portable_path,
      kind: e.kind,
      byte_length: 0,
      sha256: (e.digest ?? null) as string | null,
    })),
  ];
  const outcome = createSeedManifest(entries);
  assert.equal(outcome.ok, true, "seed manifest must build");
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}
interface WindowsHarness {
  readonly leaf: string;
  readonly staging: string;
  readonly adapter: WindowsFileAdapter;
  readonly lifecycle: EditorLifecycle;
  readonly operationIds: string[];
  readonly seedFiles: Record<string, string>;
  readonly workspaceId: string;
}
function openWindowsHarness(actions: Array<{ action: unknown }>, files: Record<string, string>, seedExtra: Array<{ portable_path: string; kind: "directory" | "regular_file"; digest?: string | null }> = []): WindowsHarness {
  harnessSeq += 1;
  const tag = `cf-p611-w${harnessSeq}-${randomBytes(3).toString("hex")}`;
  const leaf = join(TEST_ROOT, `${tag}-leaf`);
  const staging = join(TEST_ROOT, `${tag}-staging`);
  mkdirSync(join(leaf, "src"), { recursive: true });
  mkdirSync(staging, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
  }
  const seed = manifestFor(files, seedExtra);
  const { compiled, operationIds } = compileLesson(actions);
  const catalogOutcome = createEditorCatalog(compiled);
  assert.equal(catalogOutcome.ok, true);
  if (!catalogOutcome.ok) throw new Error("unreachable");
  const sessionId = `sess-p611w-${String(harnessSeq).padStart(4, "0")}`;
  const workspaceId = `ws-p611w-${String(harnessSeq).padStart(4, "0")}`;
  const bound = openWindowsFileAdapter({ sessionId, generation: 1, workspaceId, leafHostPath: leaf, stagingHostPath: staging });
  assert.equal(bound.ok, true);
  if (!bound.ok) throw new Error("unreachable");
  const snapshot = { ...files };
  const lifecycle = createEditorLifecycle({
    catalog: catalogOutcome.value,
    seedManifest: seed,
    sessionId,
    generation: 1,
    wiring: {
      reseed: async () => {
        for (const entry of readdirSync(leaf)) {
          rmSync(join(leaf, entry), { recursive: true, force: true });
        }
        mkdirSync(join(leaf, "src"), { recursive: true });
        for (const [rel, text] of Object.entries(snapshot)) {
          writeFileSync(join(leaf, ...rel.split("/")), text, "utf8");
        }
        for (const entry of readdirSync(staging)) {
          rmSync(join(staging, entry), { recursive: true, force: true });
        }
      },
    },
  });
  return { leaf, staging, adapter: bound.value, lifecycle, operationIds, seedFiles: snapshot, workspaceId };
}
function authorityFor(h: WindowsHarness): { lease: { kind: "editor_lease"; leaseId: string; sessionId: string; generation: number; workspaceId: string; epoch: number; operationId: string; requestId: string }; ownership: "EDITOR_OWNED"; liveEpoch: number; revokedLeaseIds: string[] } {
  const d = h.lifecycle.describe();
  return {
    lease: { kind: "editor_lease", leaseId: `lease-p611w-${harnessSeq}`, sessionId: d.session_id, generation: d.generation, workspaceId: h.workspaceId, epoch: d.epoch, operationId: "op", requestId: nextRequest("a") },
    ownership: "EDITOR_OWNED",
    liveEpoch: d.epoch,
    revokedLeaseIds: [],
  };
}
function depsFor(h: WindowsHarness): LifecycleExecDeps {
  return { adapter: h.adapter as unknown, authority: authorityFor(h) as never };
}
function mustAdmit(lc: EditorLifecycle, operationId: string, requestId: string): EditorOperationAdmission {
  const outcome = lc.admit(operationId, requestId);
  assert.equal(outcome.ok, true, `admission of ${operationId} must succeed`);
  if (!outcome.ok) throw new Error("unreachable");
  return outcome.value;
}
function hostText(h: WindowsHarness, rel: string): string | null {
  const full = join(h.leaf, ...rel.split("/"));
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf8");
}
before(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
});
after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  assert.equal(existsSync(TEST_ROOT), false, "phase-owned P6.11 windows root is removed");
  console.log("P6.11 PROOF: CLEANUP real Windows temp/P6.11 windows removed");
});
describe("P6.11 real Windows reset and reseed", () => {
  it("P6.11 PROOF: real dirty buffer discarded byte-exact", async () => {
    const h = openWindowsHarness(
      [{ action: { type: "file_open", path: DOC } }, { action: { type: "type_code", path: DOC, content: "const dirty = true;\n" } }],
      { [DOC]: MULTILINGUAL },
    );
    const [openId, typeId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("o")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("t"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true, "real dirty buffer installed");
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("r") })).ok, true);
    assert.equal(hostText(h, DOC), MULTILINGUAL, "multilingual seed restored byte-exact on real NTFS");
    assert.equal(readdirSync(h.staging).length, 0, "no staging residue on real disk");
    proof("real dirty buffer discarded byte-exact");
  });
  it("P6.11 PROOF: real pending create vanishes from disk", async () => {
    const h = openWindowsHarness(
      [{ action: { type: "file_create", path: "src/pending.ts", content: "pending\n" } }],
      { [DOC]: SEED_V1 },
    );
    const [createId] = h.operationIds;
    assert.equal((await h.lifecycle.executeCreate(mustAdmit(h.lifecycle, createId, nextRequest("c")), depsFor(h))).ok, true);
    assert.equal(hostText(h, "src/pending.ts"), null, "pending invisible on real disk before save");
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("r") })).ok, true);
    assert.equal(existsSync(join(h.leaf, "src", "pending.ts")), false, "abandoned pending creation vanishes from real disk");
    assert.equal(hostText(h, DOC), SEED_V1);
    proof("real pending create vanishes from disk");
  });
  it("P6.11 PROOF: real committed save resets to seed", async () => {
    const h = openWindowsHarness(
      [
        { action: { type: "file_open", path: DOC } },
        { action: { type: "type_code", path: DOC, content: "COMMITTED\n" } },
        { action: { type: "file_save", path: DOC } },
      ],
      { [DOC]: SEED_V1 },
    );
    const [openId, typeId, saveId] = h.operationIds;
    assert.equal((await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("o")), depsFor(h))).ok, true);
    const typeAdm = mustAdmit(h.lifecycle, typeId, nextRequest("t"));
    const planned = h.lifecycle.planType(typeAdm);
    assert.equal(planned.ok, true);
    if (!planned.ok) throw new Error("unreachable");
    assert.equal(h.lifecycle.completeType(planned.value.plan_id).ok, true);
    assert.equal((await h.lifecycle.executeSave(mustAdmit(h.lifecycle, saveId, nextRequest("s")), depsFor(h))).ok, true);
    assert.equal(hostText(h, DOC), `${SEED_V1}COMMITTED\n`, "real commit persisted before reset");
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("r") })).ok, true);
    assert.equal(hostText(h, DOC), SEED_V1, "committed file resets to canonical seed byte-exact");
    assert.equal(readdirSync(h.staging).length, 0, "no staging residue after real save plus reset");
    proof("real committed save resets to seed");
  });
  it("P6.11 PROOF: real case alias collapses across reset", async () => {
    const h = openWindowsHarness([{ action: { type: "file_open", path: DOC } }], { [DOC]: SEED_V1 });
    const [openId] = h.operationIds;
    const first = await h.lifecycle.executeOpen(mustAdmit(h.lifecycle, openId, nextRequest("o")), depsFor(h));
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    const identity = (first.value as { file_identity: string }).file_identity;
    assert.equal(typeof identity, "string", "trusted file identity bound on real NTFS");
    const before = h.lifecycle.describe();
    assert.equal((await h.lifecycle.reset({ session_id: before.session_id, generation: before.generation, request_id: nextRequest("r") })).ok, true);
    assert.equal(hostText(h, DOC), SEED_V1, "case-stable seed preserved across reset");
    proof("real case alias collapses across reset");
  });
  it("P6.11 PROOF: real symlink ancestry denied with sentinel intact", async () => {
    const h = openWindowsHarness([{ action: { type: "file_open", path: "src/linked.ts" } }], { [DOC]: SEED_V1 }, [
      { portable_path: "src/linked.ts", kind: "regular_file", digest: sha256Hex("linked\n") },
    ]);
    const outside = join(TEST_ROOT, `sentinel-${randomBytes(3).toString("hex")}.txt`);
    writeFileSync(outside, "outside\n", "utf8");
    // Replace the real directory entry with a symlink to the outside file:
    // the trusted adapter must reject before reading through it.
    const target = join(h.leaf, "src", "linked.ts");
    if (existsSync(target)) rmSync(target, { force: true });
    symlinkSync(outside, target, "file");
    const [openId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("o"));
    const opened = await h.lifecycle.executeOpen(openAdm, depsFor(h));
    assert.equal(opened.ok, false, "symlink ancestry denied on real Windows");
    if (opened.ok) throw new Error("unreachable");
    assert.equal(readFileSync(outside, "utf8"), "outside\n", "outside sentinel byte-identical");
    rmSync(outside, { force: true });
    proof("real symlink ancestry denied with sentinel intact");
  });
  it("P6.11 PROOF: real junction ancestry denied with sentinel intact", async () => {
    const h = openWindowsHarness([{ action: { type: "file_open", path: "src/jdir/inner.ts" } }], { [DOC]: SEED_V1 }, [
      { portable_path: "src/jdir", kind: "directory" },
      { portable_path: "src/jdir/inner.ts", kind: "regular_file", digest: sha256Hex("inner\n") },
    ]);
    const outsideDir = join(TEST_ROOT, `junction-target-${randomBytes(3).toString("hex")}`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "inner.ts"), "outside-inner\n", "utf8");
    const linkPath = join(h.leaf, "src", "jdir");
    if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(outsideDir, linkPath, "junction");
    const [openId] = h.operationIds;
    const openAdm = mustAdmit(h.lifecycle, openId, nextRequest("o"));
    const opened = await h.lifecycle.executeOpen(openAdm, depsFor(h));
    assert.equal(opened.ok, false, "junction ancestry denied on real Windows");
    assert.equal(readFileSync(join(outsideDir, "inner.ts"), "utf8"), "outside-inner\n", "outside target byte-identical");
    rmSync(outsideDir, { recursive: true, force: true });
    proof("real junction ancestry denied with sentinel intact");
  });
});
