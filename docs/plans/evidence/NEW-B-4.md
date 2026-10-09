# NEW-B-4 evidence — POST /v1/projects/fingerprint: DEFERRED to week 2

Status: deferred by the owner (2026-10-08, decision 2). Nothing is built; there are no commits for this item and none are wanted this week.

## Why

1. The approved shape fetches a customer-supplied URL from inside a request handler. NFR-ARCH-01 and KAD-06 forbid a request handler making a
   network call to a crawl target, with a 2 s p99 handler budget. The lint rule `nominara/no-request-handler-network-call` would not catch a call through
   `src/lib/net` guardedFetch, so lint passing would not make it compliant. Doing it needs a written decision, one of: an async fingerprint job with a
   short-lived result store (a new pattern and a spec change), a bounded written exception for this one endpoint in coding-standards.md and NFR-ARCH-01
   (hard short timeout, rate limit, no transaction held across the await), or cutting the endpoint (FR-ONB-04 already allows a silent 404 and the frontend tolerates it).
2. The 180-category taxonomy that `category` would be classified against does not exist (stated in `src/lib/discovery/extract.ts`), and `verticals` has
   no source; only `cms` is derivable from one fetch. A cms-only answer needs owner confirmation.
3. The endpoint is not in `api-specification.md`; the addition still has to be written into the docs repo (no `.git` here) and the story.

## Acceptance criteria (track-plans.json) and their state

| Criterion | State |
|---|---|
| BLOCKED until owner/doc approval | not approved this week; deferred |
| `contracts/projects/fingerprint-request/response.schema.ts` in own commit | not built (deferred) |
| Uses guarded-fetch + discovery/extract; private/loopback refused | not built (deferred) |
| Rate limited; nulls rather than guesses on low confidence | not built (deferred) |
| Submission never waits on it (FR-ONB-04) | holds today: project creation does not call it, the frontend shows no suggestion |

RED commit: none (no code). Gates: nothing to run for this item.

## Needed in week 2

The decision in point 1, the taxonomy answer in point 2, and the spec/story text in point 3.
