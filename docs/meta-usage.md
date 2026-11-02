# Meta usage

The **new reviewer** calls Meta Model API directly at `https://api.meta.ai/v1/responses`, requests `muse-spark-1.3`, and records the returned model, response identifier, timestamp, latency and usage. Its application code reads only `MODEL_API_KEY` from the process environment. No credential is stored in this repository.

Two saved live runs demonstrate the prototype:

1. A deliberately contradictory Arabic draft is compared with the actual Python code and freshly observed boundary outputs. Muse returned two blocking findings.
2. A corrected draft, describing the same predicates accurately, returned zero findings.

The output passes a separate local evidence validator. Each finding must cite a known source ID and a quotation that exists verbatim in that source. Source and input hashes make the binding inspectable. A citation check establishes reference integrity, not semantic truth; the model can still miss issues or draw a wrong conclusion. Human review is always required, even when there are zero findings.

The default offline example uses an explicitly labeled fixture and does **not** count as model inference. The dashboard replays the saved live responses, and the CLI makes fresh calls only with `--live`. There is no autonomous publication or editing of accepted lessons.

The owner also used Muse through OpenCode Go, alongside other models, for earlier content review and production. That earlier usage is separate from the new direct integration and is not substituted for its live receipts. Voice synthesis used ElevenLabs; motion rendering used local tools. They are not attributed to Muse.

Two examples do not establish overall model accuracy, time savings, cost savings or superiority over another model. Usage counts are recorded per call; no controlled production-cost benchmark has been completed.

[Meta quickstart](https://dev.meta.ai/docs/quickstart)

## Expanded six-context sample

Twelve additional actual calls cover paired source-derived and deliberately contradictory test drafts across HTTP, Python, SQL, idempotency, prompt injection and MCP. These newly written test drafts are not verbatim published narration. All quotations passed reference validation; the demonstration does not establish general accuracy. Existing execution receipts retain their original dates and limits. See [sample design](library-review-sample.md). `review-json.mjs` validates or reviews arbitrary input matching the evidence contract without executing supplied code. `review-library.mjs` uses a bounded checked-in manifest, preserves failed/rejected receipts and makes no requests during replay.
