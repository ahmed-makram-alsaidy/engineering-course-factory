# Review of unchanged existing teaching text

This follow-up used six existing source/production artifacts without deliberately injecting errors. It is separate from the earlier constructed paired sample.

| Material | Artifact | Initial result |
|---|---|---|
| C01.09 | All 393 published subtitle captions, with only SRT IDs/timecodes removed mechanically | 0 findings |
| C02.09 | Complete production narration Markdown | 0 findings |
| C07.11 | Existing short spoken-beat outline | 0 findings |
| C14.11 | Existing full idempotency teaching script | Invalid review JSON; request failed |
| C24.10 | Existing English teaching outline | 0 findings |
| C26.09 | Existing English teaching outline | 0 findings |

The primary batch made six requests with the unchanged reviewer prompt, model and 2200-token output allowance. Five returned valid reviews; none of those five returned findings. Total client request time was **93.334 seconds**, including the failed request. Zero findings does not establish that material is error-free, and supplied evidence has limited coverage. The artifacts differ substantially in length and maturity; outlines are not complete published lessons.

## Separate diagnostic follow-up

The failed C14.11 request was preserved. A separate, explicit follow-up used the same input/model/prompt with an output allowance of 6000. It returned four findings with valid quotations in **27.204 seconds**. The exact cause of the initial failure is unknown because the old adapter did not preserve the invalid response body. The budget change and successful second response do not prove causality. Neither call is omitted from the report.

The provider adapter now preserves response status, incomplete reason, usage and partial output on malformed/incomplete responses, without automatically retrying. The JSON runner saves a failure receipt and exits unsuccessfully. Tests cover these boundaries.

## Checking the findings

Codex, acting as the assistant rather than an independent human evaluator, checked the findings against the original material and RFC 9110:

- One supported technical correction: avoid presenting at-least-once delivery as a general network guarantee.
- One supported scope clarification: GET's intended resource effect can remain idempotent while logs or counters change.
- One useful wording qualification: caching is broader than GET, but the model's GET-only reading and blocking severity overstate what the quoted sentence explicitly says.
- One unresolved evidence gap: an illustrative standalone demo and an older HTTP service receipt are different artifacts; this alone does not establish a false lesson claim.

The owner explicitly judged the **three displayed proposed changes correct and useful**. This is feedback on those proposals, not independent blind review of the six lessons or blanket acceptance of every model finding. No review duration was supplied. Proposed edits remain separate; original course files were not changed.

A possible currency-unit consistency question was noted by the assistant but not raised by the model. It remains an owner-check question rather than a measured false negative. No precision/recall score is calculated.

## Additional verification and limits

Twelve original production Python files were rerun: raw file hashes and outputs matched all 12 recorded variants. The in-memory SQL demo returned commit [70,130] and rollback [100,100], then closed cleanly. These runs occurred after the model inputs were frozen and were not supplied to those calls.

The seven requests together took **120.538 seconds** of measured client request time. This excludes preparation, source research and adjudication and is not time saved. Monetary cost was not measured; usage for the first failed request is unavailable. There is no matched human-only baseline, randomized sample, independent ground truth or whole-library quality certification. Topic selection was purposive and the assistant had prior familiarity with these contexts.

Private complete teaching texts and full natural-review receipts remain local. The public [summary](../evidence/natural-review-summary.json) includes hashes, timings, usage where available, result status and assessment scope. The earlier constructed sample remains public and runnable. This report does not present private-input reviews as independently reproducible from the public repository alone.

References: [RFC 9110 safe methods](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.1), [idempotent methods](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2), [caching](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.3), [POST](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.3).
