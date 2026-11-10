# STORY-045 / owner decision 95(a) (2026-11-10) - background prompt generation (carry to the docs repo)

**api branch `story/b8-prompts`, migration 0193.** Closes STORY-045's decision #5 and binds the two halves it left unbound (AC3 naturaliser, AC6 vector dedupe). AC1 (slot mining) stays open and needs a design.

## api-specification.md

- §3 route table, the `POST /projects/{id}/prompts/generate` row: replace "§5. **Generation is free**..." with: "§5. **Generation is free** (a failed generation charges nothing either); activation is what consumes the cap and the credits. `202` with `{generation_batch_id, status: "pending", poll_url}`: the request validates and records a pending generation; the naturaliser and vector dedupe run in a signed `prompt.generate` job, outside any transaction (KAD-06, ADR-0003). Audited `prompt.generation_requested`."
- §3, a new row: `GET /projects/{id}/prompts/generations/{generation_batch_id}` | `tracking:read` | "the generation's state: `{generation_batch_id, project_id, status: pending|running|succeeded|failed, result, failure_code, requested_at, completed_at}`. `result` is the response §5 used to return synchronously (`variants[]`, `rejected[]`, `coverage[]`, `summary`, `cached`), null until `succeeded` and never a partial pass. `failure_code` is `dispatch_failed`, `project_not_found` or `generation_failed`, present exactly when `failed`. A naturaliser or embedder outage is not a failure: the pass completes on the template text and exact-hash dedupe, and `naturalized` / `novelty` (null, never 0) say what ran."
- §5 "Response - `POST /v1/projects/{id}/prompts/generate`": the body shown there is now the `result` of the GET above; the POST answers the 202 pointer.

## system-architecture.md section 4 - one added queue row

| Queue | Producer | Worker group | Concurrency | Retry | Priority | Idempotency key | Tenant-scoped |
|---|---|---|---|---|---|---|---|
| `prompt.generate` | API (STORY-045 decision 95a) | crawl | 3 | 2x exp (2s, 4s) | 1 | `promptgen:{generation}` | yes |

The topology is now 21 + the added queues; update any prose that counts them. The job is phased (ADR-0003): prepare (claim the row), run (no transaction: naturaliser, embedder; each vector comparison is its own short transaction), commit (project lock, hashes re-read, inserts, settled row). Settled `failed` on the last attempt (3 attempts), once.

## schemas/projects-and-prompts.md - one added table

`prompt_generations` (`id` = the `generation_batch_id`, `workspace_id`, `project_id`, `status` pending|running|succeeded|failed, `request` jsonb, `result` jsonb, `failure_code`, `created_at`, `updated_at`, `completed_at`). Tenant-scoped, RLS forced, not portal-readable. `result` is non-null exactly when `succeeded`, `failure_code` exactly when `failed`.

## tracking-engine.md section 4

Step 4 (naturalise) and step 5 (dedupe) run in the background job, not in the request. State that "embed all 15 in one batched call" is one call inside the job, and that an embedder failure falls back to exact `text_hash` dedupe.

## STORY-045 (stories/projects/STORY-045-prompt-generation-engine.md)

- Status: AC3 and AC6 move from "mechanism built, unbound" to met (the job binds `PROMPT_NATURALISER` and the embedder). **10 of 12 ACs**; AC1 stays partial.
- Delivery note: "Decision #5 answered 2026-11-10 (95a): option (a), a phased job read back by `generation_batch_id`." The route is now `202`; `variants[]` etc. are read from `GET .../generations/{id}`. `PROMPT_CANDIDATE_EMBEDDER` and the request-path naturaliser hold are gone.
- Test scenarios 6 (near-duplicate) and 9 (cache) now run in the job: `test/integration/prompt-generation-job.spec.ts` D95a-2.
- Still open (follow-ups, none blocks): the naturaliser and the dedupe embedder are absorbed costs with no `USAGE_METRICS` entry and the naturaliser draws from no Gemini engine bucket (`GEMINI_REQUESTS_PER_MINUTE`) or spend ceiling; a pass's candidates are never embedded, so a second pass cannot see the first pass's rows by vector (persist the batch vectors or enqueue `embed.batch`); `judgeVectors` clamps a negative cosine to 0.
