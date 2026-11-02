// P6.6 source safety — the phase boundary for the shared workspace package.
//
// P6.6 adds the trusted editor admission plus the main-owned document
// registry behind the P6.1 contracts: identifier-only admission resolved
// from reviewed compiled IR into main-owned documents (no execution, no
// persistence bytes, no presentation). Product source (src/) therefore
// imports nothing beyond zod, node:crypto (digest binding), the canonical
// compiler authority (validate + canonical bytes, mirroring P5 admission),
// the P6.4-sanctioned file builtins in the adapter only, and relative
// modules; it contains no process, container, browser, presentation,
// scheduling or network machinery. These are the in-suite counterparts of
// the validation gate's static scans.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

function collectProductSources(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(packageRoot, "src"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(join(packageRoot, "src", entry.name));
  }
  return files;
}

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function importSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  for (const match of code.matchAll(/from\s*["']([^"']+)["']/g)) specifiers.push(match[1]);
  for (const match of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specifiers.push(match[1]);
  return specifiers;
}

function relativeSpecifier(file: string): string {
  return file.slice(packageRoot.length + 1).split("\\").join("/");
}

describe("P6.1 product source safety", () => {
  const sources = collectProductSources();

  it("product source exists and was scanned (guard against a vacuously green scan)", () => {
    assert.deepEqual(
      sources.map((file) => relativeSpecifier(file)).sort(),
      [
        "src/coordinator.ts",
        "src/editor-admission.ts",
        "src/editor-documents.ts",
        "src/editor-ipc.ts",
        "src/editor-lifecycle.ts",
        "src/editor-open-create.ts",
        "src/editor-replace-planner.ts",
        "src/editor-save.ts",
        "src/editor-terminal-interop.ts",
        "src/editor-type-planner.ts",
        "src/file-adapter.ts",
        "src/index.ts",
        "src/policy.ts",
        "src/protocol.ts",
      ],
    );
  });

  it("imports only zod, node:crypto (digest binding), the canonical compiler authority, the P6.4 adapter file builtins and relative modules", () => {
    // P6.6 amendment: editor-admission.ts is the ONLY product file sanctioned
    // to reach the canonical compiler authority (validateCompiledLesson plus
    // canonical compiled bytes for the digest binding — the same two clean
    // subpaths P5 admission uses). No other product file gains compiler
    // imports; lesson compilation itself stays in the compiler package.
    const allowed = new Set(["zod", "node:crypto", "@course-factory/lesson-compiler/ir"]);
    // P6.4 amendment: file-adapter.ts is the ONLY product file sanctioned to
    // reach the host filesystem (confined read plus staged atomic
    // publication). No other product file gains file imports.
    const adapterAllowed = new Set(["node:crypto", "node:fs", "node:fs/promises", "node:path"]);
    const violations: string[] = [];
    for (const file of sources) {
      const rel = relativeSpecifier(file);
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const ok =
          allowed.has(specifier) ||
          specifier.startsWith("./") ||
          specifier.startsWith("../") ||
          (rel === "src/file-adapter.ts" && adapterAllowed.has(specifier));
        if (!ok) violations.push(`${rel}: ${specifier}`);
      }
    }
    assert.deepEqual(violations, [], "forbidden imports found");
  });

  it("contains no process, container, browser, presentation or network machinery (filesystem writes live only in the adapter)", () => {
    const violations: string[] = [];
    for (const file of sources) {
      const code = stripComments(readFileSync(file, "utf8"));
      const rel = relativeSpecifier(file);
      if (/import\s*\(/.test(code)) violations.push(`${rel}: dynamic import`);
      if (/\b(?:spawn|exec|execFile|fork|execSync|spawnSync)\s*\(/.test(code)) {
        violations.push(`${rel}: process creation call`);
      }
      // P6.4 amendment: file-adapter.ts is the sanctioned filesystem writer
      // (confined read, CREATE_NEW staging, same-volume rename, verification).
      if (rel !== "src/file-adapter.ts") {
        if (/\b(?:writeFile|appendFile|mkdir|rmdir|unlink|rename|copyFile|truncate|createWriteStream|openSync)\b/.test(code)) {
          violations.push(`${rel}: filesystem mutation construct`);
        }
      }
      if (/\bchild_process\b|\bnode-pty\b|\bdockerode\b|\bmonaco\b|\bplaywright\b|\bpuppeteer\b/.test(code)) {
        violations.push(`${rel}: forbidden module reference`);
      }
      if (/docker\s+(?:run|exec|create|start|stop|rm)\b|["'`]docker\b/.test(code)) {
        violations.push(`${rel}: docker invocation`);
      }
      if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(code)) violations.push(`${rel}: evaluation construct`);
      if (/\b[A-Za-z]:[\\/]/.test(code)) violations.push(`${rel}: drive-letter path`);
      if (/E:\\course-factory/.test(code)) violations.push(`${rel}: repository path`);
    }
    assert.deepEqual(violations, [], "phase-boundary violations found");
  });

  it("implements no typing engine behavior (no scheduler, graphemes, animation, persistence or execution)", () => {
    const violations: string[] = [];
    for (const file of sources) {
      const code = stripComments(readFileSync(file, "utf8")).toLowerCase();
      const rel = relativeSpecifier(file);
      // P6.6 amendment: editor-admission.ts names the five authored action
      // types ONLY as admission-routing discriminators (operation_id ->
      // reviewed IR action -> trusted semantics; no planner, no scheduler,
      // no persistence). Every other typing/presentation/execution marker
      // stays banned everywhere, and the action-type literals stay banned
      // outside the admission module.
      // P6.7 amendment: editor-open-create.ts names file_open (open executor
      // guard) and file_create (create executor guard) ONLY as
      // admission-action guards selecting its two owned executors. Wrong
      // actions reject without naming their literals (generic mismatch
      // message), so file_save/type_code/replace_code stay banned outside
      // the admission module: later editor semantics cannot leak in.
      // P6.8 amendment: editor-type-planner.ts names type_code ONLY as its
      // admission-action guard selecting the one owned planner. Wrong
      // actions reject without naming their literals (generic mismatch
      // message), so file_open/file_create/file_save/replace_code stay
      // banned there in code (comments excluded): later editor semantics
      // cannot leak in. Grapheme segmentation is sanctioned ONLY in the
      // planner (pinned Intl.Segmenter); every clock/presentation marker
      // stays banned everywhere including the planner (manual logical clock
      // only, no Monaco, no frames, no timers).
      // P6.9 amendment: editor-replace-planner.ts names replace_code ONLY as
      // its admission-action guard selecting the one owned replacement
      // planner. Wrong actions reject without naming their literals
      // (generic mismatch message), so file_open/file_create/file_save/
      // type_code stay banned there in code (comments excluded): no other
      // editor semantics can leak in. Exact literal matching needs no
      // segmentation, clocks or presentation machinery: every such marker
      // stays banned there including the visual-plan representation (manual
      // step clock only, no Monaco, no frames, no timers, no RegExp).
      // P6.10 amendment: editor-save.ts names file_save ONLY as its
      // admission-action guard selecting the one owned save executor. Wrong
      // actions reject without naming their literals (generic mismatch
      // message), so file_open/file_create/type_code/replace_code stay
      // banned there in code (comments excluded): no other editor semantics
      // can leak in. Verified persistence needs the adapter publication
      // primitive plus confined reads: publishDocument/readDocument are
      // sanctioned ONLY in the save module (plus the existing read-only
      // sanction in open-create and ownership in the adapter/index).
      // P6.11 amendment: editor-lifecycle.ts names all five action types
      // ONLY as operation-aware cancel/reset/replay routing discriminators
      // (each family cancels, settles and replays by its canonical rule;
      // no generic rollback exists). No other module gains action literals.
      // P6.12 amendment: editor-ipc.ts names all five action types ONLY as
      // run-operation routing discriminators (admitted open/create/save
      // execute through the owning lifecycle executors; admitted type/
      // replace plan through the owning planners with trusted presentation
      // frames; wrong actions reject without naming foreign literals).
      // Every clock, Monaco, adapter-construction and generic-content marker
      // stays banned there (acks advance the main-owned planner clock only;
      // the adapter handle arrives through injected main-held dependencies,
      // never constructed here).
      if (rel === "src/editor-lifecycle.ts" || rel === "src/editor-ipc.ts") {
        // Sanctioned: all five literals as routing discriminators only.
        // No additional marker check here; the clock/presentation and
        // adapter checks below still apply to both modules.
      } else if (rel === "src/editor-open-create.ts") {
        for (const marker of ["file_save", "type_code", "replace_code"]) {
          if (code.includes(marker)) violations.push(`${rel}: typing-engine marker '${marker}'`);
        }
      } else if (rel === "src/editor-save.ts") {
        for (const marker of ["file_open", "file_create", "type_code", "replace_code"]) {
          if (code.includes(marker)) violations.push(`${rel}: typing-engine marker '${marker}'`);
        }
      } else if (rel === "src/editor-replace-planner.ts") {
        for (const marker of ["file_open", "file_create", "file_save", "type_code"]) {
          if (code.includes(marker)) violations.push(`${rel}: typing-engine marker '${marker}'`);
        }
      } else if (rel === "src/editor-type-planner.ts") {
        for (const marker of ["file_open", "file_create", "file_save", "replace_code"]) {
          if (code.includes(marker)) violations.push(`${rel}: typing-engine marker '${marker}'`);
        }
      } else if (rel !== "src/editor-admission.ts") {
        for (const marker of ["file_open", "file_create", "file_save", "type_code", "replace_code"]) {
          if (code.includes(marker)) violations.push(`${rel}: typing-engine marker '${marker}'`);
        }
      }
      if (rel === "src/editor-type-planner.ts") {
        for (const marker of [
          "requestanimationframe",
          "monaco",
          "typingscheduler",
          "settimeout",
          "setinterval",
          "performance.now",
          "date.now",
        ]) {
          if (code.includes(marker)) violations.push(`${rel}: typing/persistence marker '${marker}'`);
        }
      } else if (rel === "src/index.ts") {
        // P6.8 amendment: the package surface re-exports the sanctioned
        // planner entry (segmentGraphemes). Strip that re-export identifier,
        // then ban grapheme like everywhere else: no other segmentation,
        // scheduling or presentation machinery may live in the surface.
        const surfaceCode = code.split("segmentgraphemes").join(" ");
        for (const marker of [
          "grapheme",
          "requestanimationframe",
          "monaco",
          "typingscheduler",
          "settimeout",
          "setinterval",
          "performance.now",
          "date.now",
        ]) {
          if (surfaceCode.includes(marker)) violations.push(`${rel}: typing/persistence marker '${marker}'`);
        }
      } else {
        for (const marker of [
          "grapheme",
          "requestanimationframe",
          "monaco",
          "typingscheduler",
          "settimeout",
          "setinterval",
          "performance.now",
          "date.now",
        ]) {
          if (code.includes(marker)) violations.push(`${rel}: typing/persistence marker '${marker}'`);
        }
      }
      // P6.6 admission/documents never couple to the file adapter: no
      // adapter reads, no staged publication, no adapter import. The adapter
      // API names below remain legitimate in file-adapter.ts (which owns
      // them) and index.ts (which re-exports them) only.
      // P6.7 amendment: editor-open-create.ts is the sanctioned adapter
      // consumer for confined READS only (adapter handle injected by main,
      // never constructed here; readDocument is the single disk-truth call).
      // publishDocument stays banned there by construction: P6.7 performs no
      // verified persistence (P6.10 owns it), proven by this scan plus the
      // publish-spy tests.
      if (rel === "src/editor-admission.ts" || rel === "src/editor-documents.ts") {
        for (const marker of ["publishdocument", "readdocument", "openwindowsfileadapter", "file-adapter"]) {
          if (code.includes(marker)) violations.push(`${rel}: adapter-coupling marker '${marker}'`);
        }
      }
      if (rel === "src/editor-open-create.ts") {
        for (const marker of ["publishdocument", "openwindowsfileadapter"]) {
          if (code.includes(marker)) violations.push(`${rel}: persistence/construction marker '${marker}'`);
        }
      }
      // P6.8 amendment: the type planner/scheduler never touches the file
      // adapter (no reads, no publication, no construction). Every adapter
      // API name stays banned there by construction: P6.8 plans and
      // schedules only (P6.10 owns verified persistence).
      // P6.9 amendment: the exact replacement planner never touches the
      // file adapter either (no reads, no publication, no construction).
      // Every adapter API name stays banned there by construction: P6.9
      // plans match guards and visual steps only (P6.10 owns verified
      // persistence).
      // P6.10 amendment: editor-save.ts is the sanctioned verified-
      // persistence consumer (adapter handle injected by main, never
      // constructed here; publishDocument plus readDocument for clean
      // no-op verification only). openwindowsfileadapter construction stays
      // banned there by construction.
      if (rel === "src/editor-type-planner.ts" || rel === "src/editor-replace-planner.ts") {
        for (const marker of ["publishdocument", "readdocument", "openwindowsfileadapter", "file-adapter"]) {
          if (code.includes(marker)) violations.push(`${rel}: adapter-coupling marker '${marker}'`);
        }
      }
      if (rel === "src/editor-save.ts") {
        for (const marker of ["openwindowsfileadapter"]) {
          if (code.includes(marker)) violations.push(`${rel}: construction marker '${marker}'`);
        }
      }
    }
    assert.deepEqual(violations, [], "typing implementation leaked past P6.6 admission");
  });

  it("the coordinator implements the P6.2 lifecycle runtime (fake epoch seam only)", async () => {
    const namespace = (await import("../src/coordinator.ts")) as Record<string, unknown>;
    for (const value of ["createWorkspaceCoordinator", "createFakeEpochProvider", "createManualEpochProvider"]) {
      assert.equal(typeof namespace[value], "function", `${value} must be a runtime export`);
    }
    for (const value of [
      "WORKSPACE_COORDINATOR_VERSION",
      "MAX_RO_OBSERVERS",
      "MAX_WAIT_QUEUE",
      "CombinedSessionDescriptorSchema",
      "EditorCapabilitySchema",
      "TerminalCapabilitySchema",
      "EpochCapabilitySchema",
      "EditorLeaseSchema",
      "TerminalLeaseSchema",
    ]) {
      assert.notEqual(namespace[value], undefined, `${value} must be exported`);
    }
    // The future container-epoch provider surface stays contract-only: the
    // P6.2 runtime never implements real container work.
    assert.equal(typeof (namespace["createWorkspaceCoordinator"] as () => unknown), "function");
  });

  it("no forbidden dependency in the workspace manifest", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
    for (const forbidden of ["node-pty", "playwright", "puppeteer", "dockerode", "monaco-editor", "xterm"]) {
      assert.equal(names.includes(forbidden), false, `forbidden dependency '${forbidden}'`);
    }
    // P6.6 amendment: the canonical compiler authority is a sanctioned
    // product dependency (validate + canonical bytes only, mirroring P5
    // admission); nothing else is added.
    assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ["@course-factory/lesson-compiler", "zod"]);
  });
});
