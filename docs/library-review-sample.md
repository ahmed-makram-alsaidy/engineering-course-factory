# A broader review sample

Twelve actual `muse-spark-1.3` Responses calls cover six lesson contexts across six courses: HTTP/API/database (C01.09), Python functions (C02.09), SQL transactions (C07.11), idempotency (C14.11), prompt injection (C24.10), and MCP (C26.09).

Each context has a newly written Arabic draft derived from selected source material and a deliberately contradictory draft. These inputs are **not verbatim published narration** and do not assert that these errors occur in the published lessons. The source files are small excerpts or fixtures selected from the existing library. Origin paths and SHA-256 values are in the manifest. No original curriculum file was modified.

## Observed results

| Context | Source-derived findings | Seeded findings |
|---|---:|---:|
| HTTP | 0 | 1 |
| Python | 0 | 1 |
| SQL transactions | 0 | 2 |
| Idempotency | 0 | 2 |
| Prompt injection | 0 | 2 |
| MCP | 0 | 3 |

All 12 returned reviews passed exact-reference validation. All six source-derived drafts returned no findings; all six deliberately contradictory drafts returned findings. No draft was approved for publication. The stored receipts retain the actual model identifiers, timestamps, usage, client latency and quotations.

This is a purposive convenience sample, not a random or representative evaluation, and not an independent human-labeled benchmark. It does not establish general accuracy, a false-positive rate, educational effectiveness, superiority to another model, or time/cost savings. A source can itself be wrong. Exact-quote checks establish reference integrity, not truth.

## Evidence scope

The C01 case uses a local Dart simulator explicitly marked as a semantic reconstruction. The C02 case includes the earlier captured Python boundary-check output. SQL uses lesson reference notes; no fresh SQL execution is claimed. Idempotency uses an existing receipt dated September 17, 2026. Injection uses documented expected fixture outputs; MCP uses a reference card describing local protocol execution without model inference. The source material's older execution dates are not replaced by the new review timestamps.

## Reproduce

`npm run review:sample` revalidates the saved receipts without a key and makes zero requests. `npm run review:sample:live` calls Meta only for missing receipts, with at most 12 requests. Existing, failed and rejected receipts are preserved and never retried or replaced automatically. Changing an input requires a new case identity so old evidence is not silently overwritten.

For your own material, use `npm run review:json -- --input your-draft.json --output a-new-receipt.json` to validate the review contract without calling a model. Add `--live` and set `MODEL_API_KEY` to make one real request. This JSON path never executes supplied code or commands. It does not yet ingest an entire production folder or write accepted lessons back into the curriculum.
