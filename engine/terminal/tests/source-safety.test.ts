// P5.1 source safety tests — P5.1 product source imports no process/Docker/
// network machinery, contains no execution constructs, and stays portable
// (no machine paths). These are the in-suite counterparts of the validation
// gate's static scans.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");

/** Product source = src/ + container/ sources (the guest bundle dist/ is generated and checked by the build script). */
function collectProductSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push(full);
      }
    }
  };
  walk(join(packageRoot, "src"));
  walk(join(packageRoot, "container"));
  return files;
}

/** Strip comments so documentation about (forbidden) constructs cannot trip the scans. */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every static module specifier in a source file (`from "x"` and bare `import "x"`). */
function importSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  for (const match of code.matchAll(/from\s*["']([^"']+)["']/g)) specifiers.push(match[1]);
  for (const match of code.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specifiers.push(match[1]);
  return specifiers;
}

/**
 * The complete allowlist: relative modules, the shared Zod authority, the
 * canonical clean compiler subpath, and the sanctioned builtins. P5.3
 * amendment (scripts/validate-p5-3.sh): fs/path/url/os for the trusted
 * workspace/environment layer. P5.5 amendment (documented in
 * scripts/validate-p5-5.sh and docs/P5-IMPLEMENTATION.md): the guest
 * supervisor needs node:string_decoder (bounded UTF-8 stream decoding).
 * Network/process builtins stay forbidden in HOST product code.
 */
const ALLOWED_IMPORTS = new Set([
  "zod",
  "node:readline",
  "node:fs",
  "node:path",
  "node:url",
  "node:os",
  "node:string_decoder",
  "@course-factory/lesson-compiler/ir",
  "@course-factory/shared-types",
]);

// P5.4 amendment: docker-cli.ts is the ONLY HOST product file sanctioned to
// import node:child_process (the direct-executable argv transport).
// P5.5 amendment: the GUEST supervisor bundle (container/supervisor.ts) is the
// one sanctioned guest process-creation site (it runs inside the container
// entrypoint; it is never imported by host code).
const CHILD_PROCESS_FILES = new Set([
  "src/providers/docker-cli.ts",
  "container/supervisor.ts",
]);

// P5.5: the guest process table calls the INJECTED spawn seam only (it imports
// no child_process); the adapter owns the real spawn. Both guest files are
// exempt from the process-creation-call scan; the import allowlist above is
// the real guarantee (only container/supervisor.ts reaches child_process).
const GUEST_PROCESS_FILES = new Set([
  "container/supervisor.ts",
  "container/process-groups.ts",
]);

/** Normalize a scanned file path to package-relative posix form. */
function relativeSpecifier(file: string): string {
  return file.slice(packageRoot.length + 1).split("\\").join("/");
}

describe("P5.1 product source safety", () => {
  const sources = collectProductSources();

  it("product source exists and was scanned (guard against a vacuously green scan)", () => {
    assert.ok(sources.length >= 5, `expected the P5.1 modules, scanned ${sources.length}`);
  });

  it("imports only relative modules, zod, and P5.1/P5.3/P5.5-sanctioned builtins — no node-pty/Docker SDK/network in product code", () => {
    const violations: string[] = [];
    for (const file of sources) {
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        const allowed =
          ALLOWED_IMPORTS.has(specifier) ||
          specifier.startsWith("./") ||
          specifier.startsWith("../") ||
          (CHILD_PROCESS_FILES.has(relativeSpecifier(file)) && (specifier === "node:child_process" || specifier === "node:stream" || specifier === "node:path"));
        if (!allowed) violations.push(`${file}: ${specifier}`);
      }
    }
    assert.deepEqual(violations, [], "forbidden imports found");
  });

  it("contains no dynamic imports and confines process creation to the sanctioned transport + guest supervisor files", () => {
    const violations: string[] = [];
    for (const file of sources) {
      const code = stripComments(readFileSync(file, "utf8"));
      const rel = relativeSpecifier(file);
      if (/import\s*\(/.test(code)) violations.push(`${file}: dynamic import`);
      // P5.4 amendment: docker-cli.ts is the only HOST file sanctioned to
      // spawn the Docker executable directly. P5.5 amendment: the guest
      // supervisor adapter is the one sanctioned GUEST process-creation site.
      if (!CHILD_PROCESS_FILES.has(rel) && !GUEST_PROCESS_FILES.has(rel) && /\b(?:spawn|exec|execFile|fork)\s*\(/.test(code)) {
        violations.push(`${file}: process creation call`);
      }
      if (!CHILD_PROCESS_FILES.has(rel) && /\bnode-pty\b|\bdockerode\b|\bchild_process\b/.test(code)) {
        violations.push(`${file}: forbidden module reference`);
      }
    }
    assert.deepEqual(violations, [], "execution constructs found");
  });

  it("contains no docker CLI invocations and no absolute machine paths", () => {
    const violations: string[] = [];
    // P5.4 amendment: the sanctioned Docker transport files are the ONLY
    // product code permitted to contain docker CLI argv literals. Everything
    // else stays forbidden (defense-in-depth: renderer/lesson/IR never invoke Docker).
    // P6.3 amendment (docs/P6-DESIGN-SPEC.md 26.11, ADR-0011): the reviewed
    // cross-phase ownership extension adds the access-epoch transport
    // (docker-epochs.ts) and its mount/scratch planning (workspace-epochs.ts)
    // to the sanctioned set. No other file gains Docker literals.
    const SANCTIONED_DOCKER_FILES = new Set([
      join(packageRoot, "src", "providers", "docker-cli.ts"),
      join(packageRoot, "src", "providers", "docker.ts"),
      join(packageRoot, "src", "providers", "docker-inspect.ts"),
      join(packageRoot, "src", "providers", "docker-policy.ts"),
      join(packageRoot, "src", "providers", "docker-ledger.ts"),
      join(packageRoot, "src", "providers", "docker-epochs.ts"),
      join(packageRoot, "src", "workspace-epochs.ts"),
    ]);
    for (const file of sources) {
      const code = stripComments(readFileSync(file, "utf8"));
      const isSanctioned = SANCTIONED_DOCKER_FILES.has(file);
      if (!isSanctioned && /["'`]docker\b|docker\s+(?:run|exec|create|start|stop|rm)\b/.test(code)) {
        violations.push(`${file}: docker invocation`);
      }
      if (!isSanctioned && /\b[A-Za-z]:[\\/]/.test(code)) {
        violations.push(`${file}: drive-letter path`);
      }
      if (!isSanctioned && /E:\\course-factory/.test(code)) {
        violations.push(`${file}: repository path`);
      }
    }
    assert.deepEqual(violations, [], "portability/execution violations found");
  });

  it("the guest build script itself uses only esbuild and node builtins (no process/Docker machinery)", () => {
    const code = readFileSync(join(packageRoot, "scripts", "build-guest.mjs"), "utf8");
    const specifiers = importSpecifiers(code);
    const allowedBuildImports = new Set(["esbuild", "node:crypto", "node:fs", "node:url", "node:path"]);
    const unexpected = specifiers.filter((s) => !allowedBuildImports.has(s));
    assert.deepEqual(unexpected, [], "build script imports");
    // The script's own blocklist literals mention forbidden module names; the
    // import allowlist above is the real guarantee — there is no import and
    // therefore no way to reach child_process/Docker SDKs from it.
  });

  it("the generated guest bundle is excluded from version control by the root .gitignore", () => {
    const gitignore = readFileSync(join(packageRoot, "..", "..", ".gitignore"), "utf8");
    assert.match(gitignore, /^engine\/\*\*\/dist\/$/m, "engine dist build output must be git-ignored at any depth");
  });
});
