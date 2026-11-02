# @course-factory/shared-types

Canonical **lesson schema (v1.1)**, types, validation authority, and fixtures for Course Factory.

## Contents

```
packages/shared-types/
  src/schema.ts      # THE Zod validation authority (single source of truth)
  src/validate.ts    # YAML loading + validation, stable {path, code, message} issues
  src/cli.ts         # CLI: node src/cli.ts <lesson.yaml>  (exit 0/1/2)
  src/index.ts       # public surface
  tests/             # node:test suites (schema, fixtures, execution contract)
  fixtures/          # valid: ar/en/mixed + P2A execution contract · invalid: one violation per file
  schema/            # reserved for future DERIVED exports (e.g. JSON Schema) — do not hand-write
```

## Usage

```bash
# from repo root
npm run validate:lesson -- packages/shared-types/fixtures/valid/en-lesson.yaml
npm test                      # full suite (107 tests)
```

```ts
import { validateLessonFile, type Lesson } from "@course-factory/shared-types";
const result = validateLessonFile("courses/C01/lessons/L001/lesson.yaml");
if (!result.ok) console.table(result.issues); // { path, code, message }
```

## The execution contract (P2A)

Beyond pedagogical content (narration, on-screen text, visuals), scenes can carry an **ordered `beats` sequence** — the explicit, deterministic production instructions:

```yaml
beats:
  - { beat_id: C01-L003-S014-B001, kind: narration, narration: { text: "...", language: ar } }
  - { beat_id: C01-L003-S014-B002, kind: action, action: { type: terminal_run, command: npm run dev,
      mode: background, process_id: dev_server } }
  - { beat_id: C01-L003-S014-B003, kind: pause, seconds: 2 }
  - { beat_id: C01-L003-S014-B004, kind: action, action: { type: wait, until: port, port: 3000, timeout_seconds: 60 } }
```

- 16 action types across file/editor, terminal/process, readiness, browser, and highlight families (see `docs/P2-LESSON-SCHEMA.md`).
- `narration` and `beats` are mutually exclusive — one narration source per scene, never duplicated.
- Every `code_demo` scene requires beats with at least one action — execution is authored, never inferred.
- Background processes carry logical `process_id`s; stops and output-waits must reference an earlier definition.
- All file paths project-relative POSIX; browser selectors semantic (`role/label/test_id/text/css`) — no pixels, ever.
- Full rules, tokens, and the compiler boundary: `docs/P2-LESSON-SCHEMA.md`, ADR-0007.

## Rules

- `src/schema.ts` is the **only** place the lesson schema is defined. Everything else (types via `z.infer`, future JSON Schema, future Python models) must be derived from it.
- Unknown fields are errors (strict). Extensions bump `schema_version` — `1.1` is the P2A execution-contract amendment (ADR-0007).
- Fixtures are synthetic samples, **not** production course content. Every invalid fixture must have a registered expectation in `tests/fixtures.test.ts` — unregistered fixtures fail the suite.
- Never put machine paths, usernames, or secrets in fixtures (tested; the only exceptions are the intentional absolute-path invalid fixtures).
