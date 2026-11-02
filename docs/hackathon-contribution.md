# Contribution boundary

This document distinguishes existing work from the work created for the Meta Global AI Developer Hackathon. A snapshot commit's timestamp is not a claim about when the original code was written.

## Pre-existing work

The 28-course source library, the 485 prepared package identities, the first course's published videos, the schema/compiler, workspace and execution components, and Teaching IDE were built before the hackathon. They provide the real production context and source material. They are **not presented as newly created during the event**.

The earlier broad Course Factory video is a portfolio overview. The hackathon submission demo must focus on the new reviewer below, with existing material identified as context.

## New work: November 2–3, 2026

- `tools/lesson-review/contract.mjs`: review-input validation, exact source-reference and quotation checks, content hashes and mandatory human-review states.
- `tools/lesson-review/provider.mjs`: direct Meta Model API Responses integration with bounded output, timeout and no automatic retries.
- `tools/review.mjs`: a bounded local example execution and an explicit offline/live review workflow.
- `examples/python-functions/review_checks.py`: boundary observations added for the new review demonstration. The predicate implementation itself is pre-existing.
- `tools/lesson-review/contract.test.mjs`: tests for fabricated evidence, ambiguous source identities, changed evidence and attempts to bypass human review.
- `tools/review-server.mjs` and `apps/review-dashboard/index.html`: inspectable contradictory/corrected results and a server-side fabricated-quote check.
- `evidence/live-review-contradictory.json` and `live-review-corrected.json`: actual direct `muse-spark-1.3` responses received on November 2 UTC, with the work continuing into November 3 Cairo time.
- Packaging, clean-install verification, documentation and the submission demo centered on these additions.

The demonstration deliberately introduces two false teaching claims in a test draft; it does not assert those claims occurred in the published course. The corrected draft is a separate new input, not a silent edit of an accepted lesson.

The participant guide requires demonstrations to identify functionality built during the hackathon. Existing-product reuse is expressly discussed for startups; the entrant should use the track appropriate to their actual status and the organizer's rules. No claim of eligibility approval by the organizers is made here.

[Participant guide](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details)

Pre-existing component snapshot commit: `1306626beaddd6b7e973d0aa060c4980df9e1274`. The following feature commit contains the new reviewer and submission packaging.
