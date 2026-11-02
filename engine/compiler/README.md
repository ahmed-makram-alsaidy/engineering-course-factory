# @course-factory/lesson-compiler (P3)

The **Lesson Compiler**: turns a validated lesson source file into a deterministic, machine-readable intermediate representation.

## Responsibility

**The compiler compiles. It does not author, and it does not execute.**

What it does (only this):

- validates source through the canonical lesson schema authority (`@course-factory/shared-types`)
- normalizes the validated document into a typed **Compiled Lesson IR** (`compiled_ir_version: "1.0"`)
- derives deterministic metadata: direction from language, action families, capability requirements, resource/process inventories, ordinals
- resolves authored *logical* references (e.g. `terminal_stop` → the earlier background process it names)
- computes a deterministic source hash (SHA-256 over canonical JSON of the validated source)
- emits stable, canonical JSON (sorted keys, 2-space indent, trailing newline)

What it must never do (enforced by tests): invent narration/code/commands/actions, reorder authored beats, execute commands, create files described by lessons, start processes, open browsers, probe ports, call Playwright/Unreal/Blender, generate voice, use an LLM, or touch the network. Authored execution instructions are **data**.

## Input

A lesson source file conforming to canonical `schema_version: "1.1"`:

- `.yaml` / `.yml` — the canonical authored format
- `.json` — accepted because JSON is a YAML subset and the canonical loader already parses it (no separate parser exists)

The single lesson-schema validation authority remains `packages/shared-types`. The compiler reuses it; it does not maintain a second validator.

## Output

`compiled-lesson.json` — a `CompiledLesson` IR document (contract: `src/ir.ts`, documented in `docs/P3-LESSON-COMPILER.md` and ADR-0008). The IR version (`"1.0"`) is independent of the source schema version (`"1.1"`) and of the compiler version (`0.1.0`).

Default output location: `<repoRoot>/runtime/compiled/<lesson_id>/compiled-lesson.json` — the generated-artifacts area, never a source directory. `--out` overrides it.

## CLI

```bash
# from the repository root
npm run compile:lesson -- <lesson.yaml|.yml|.json> [--out <path>]

# exit codes
#   0  compiled successfully
#   1  invalid or unreadable lesson source (canonical validation diagnostics printed)
#   2  usage error
#   3  compiler internal failure (compilation threw, or output failed its own IR contract)
#   4  output write failure
```

Invalid source produces no output file and no partial compile. The CLI validates its own output against the IR contract before writing and refuses to write an invalid IR.

## Strict non-execution boundary

`tests/safety.test.ts` proves the boundary:

- **Sentinel proof** — a fixture whose authored command would create a sentinel file if executed compiles without the file ever appearing; browser URLs stay untouched text.
- **Static boundary** — compiler source imports only `node:fs`, `node:path`, `node:url`, `node:crypto`, `zod`, and `@course-factory/shared-types`; no process/network/browser/evaluation constructs exist in it.
- **Portability** — no compiled output contains machine paths (drive letters, home dirs, usernames, repo paths).
- **Purity** — compiling a deep-frozen input succeeds, output is input-independent, and the parsed source is never mutated.

## Tests

```bash
npm test          # from repo root: shared-types suite + this package's suite
npm test          # from engine/compiler: compiler suite only
```

Suites: `compile.test.ts` (content/order/normalization/capabilities), `determinism.test.ts` (byte-identical double compiles, four encodings of one lesson, golden contract), `hash.test.ts` (source-hash strategy), `errors.test.ts` (exit codes, diagnostics, IR self-validation), `safety.test.ts` (non-execution boundary). `tests/golden/` holds one committed golden output.
