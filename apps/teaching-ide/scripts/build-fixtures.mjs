// Builds the Teaching IDE's compiled-lesson demo fixtures by running the
// canonical P3 lesson compiler over SYNTHETIC source fixtures. This documents
// provenance and keeps the fixtures regenerable — nothing here is hand-edited
// IR, and no production course material is involved.
//
//   - dev-server.json        <- packages/shared-types/fixtures/valid/p2a-dev-server.yaml
//   - editor-typing.json     <- packages/shared-types/fixtures/valid/p2a-editor-typing.yaml
//   - side-effect-safety.json<- engine/compiler/tests/fixtures/p3-side-effect-safety.yaml
//   - smoke-terminal.json    <- apps/teaching-ide/fixtures/sources/smoke-terminal.yaml (P5.14 visual smoke, synthetic)
//   - smoke-p615.json        <- apps/teaching-ide/fixtures/sources/smoke-p615.yaml (P6.15 visual proof, synthetic)
//   - smoke-p7.json          <- apps/teaching-ide/fixtures/sources/smoke-p7.yaml (P7.9 visual proof, synthetic)
//   - smoke-p8.json          <- apps/teaching-ide/fixtures/sources/smoke-p8.yaml (P8.9 visual proof, synthetic)
//   - invalid-corrupt.json   <- dev-server.json deliberately corrupted (must be REJECTED)
//
// The invalid fixture is built here so it can never be mistaken for valid IR:
// it is regenerated corrupt on every run.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(appRoot, "..", "..");
const cli = join(repoRoot, "engine", "compiler", "src", "cli.ts");
const outDir = join(appRoot, "fixtures", "compiled-lessons");
mkdirSync(outDir, { recursive: true });

const sources = [
  ["dev-server.json", "packages/shared-types/fixtures/valid/p2a-dev-server.yaml"],
  ["editor-typing.json", "packages/shared-types/fixtures/valid/p2a-editor-typing.yaml"],
  ["side-effect-safety.json", "engine/compiler/tests/fixtures/p3-side-effect-safety.yaml"],
  ["smoke-terminal.json", "apps/teaching-ide/fixtures/sources/smoke-terminal.yaml"],
  ["smoke-p615.json", "apps/teaching-ide/fixtures/sources/smoke-p615.yaml"],
  ["smoke-p7.json", "apps/teaching-ide/fixtures/sources/smoke-p7.yaml"],
  ["smoke-p8.json", "apps/teaching-ide/fixtures/sources/smoke-p8.yaml"],
];

for (const [outName, source] of sources) {
  const result = spawnSync(process.execPath, [cli, join(repoRoot, source), "--out", join(outDir, outName)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`compiling ${source} failed:\n${result.stdout}${result.stderr}`);
    process.exit(1);
  }
  console.log(`fixture: ${outName} <- ${source}`);
}

// Deliberately corrupted IR (wrong IR version + unknown top-level field + a
// tampered hash): the loader MUST reject this cleanly.
const devServer = JSON.parse(readFileSync(join(outDir, "dev-server.json"), "utf8"));
const corrupt = { ...devServer, compiled_ir_version: "9.9", renderer_note: "corrupted on purpose" };
corrupt.source.hash.value = "0".repeat(64);
writeFileSync(join(outDir, "invalid-corrupt.json"), JSON.stringify(corrupt, null, 2) + "\n");
console.log("fixture: invalid-corrupt.json (deliberately invalid)");
