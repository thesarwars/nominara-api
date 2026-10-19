# system-architecture.md section 4 — one added queue row, and STORY-048 status (carry to the docs repo)

STORY-048 AC7 / OWNER DECISION 2026-10-19: adding one queue to the topology for periodic domain re-verification. Section 4's table has no queue for it. Add, after `retention.purge` (or wherever the additions block sits):

| Queue | Producer | Worker group | Concurrency | Retry | Priority | Idempotency key | Tenant-scoped |
|---|---|---|---|---|---|---|---|
| `domain.reverify` | cron daily 02:20 UTC (STORY-048 AC7) | crawl | 1 | 3x exp (2s, 4s, 8s) | 9 | `domreverify:{yyyy_mm_dd}` | no |

NOT tenant-scoped: the tick has no workspace to name. Cross-tenant discovery runs on the owner connection; each outcome is applied inside ONE tenant's context as the runtime role. The advisory lock makes it single-flight; a domain checked within the last 20 hours is skipped, which is the idempotency. The topology is now 21 + the added queues; update any prose that counts them.

Also update `schedule` tables that list cron cadences: `domain.reverify` `20 2 * * *` (UTC), a chosen hour in the quiet window, not a reference transcription.

Story file `stories/projects/STORY-048-domain-verification.md`: remove the "AC7's schedule" paragraph under *What is deferred*; AC7 is met by `domain.reverify` (`src/lib/queue/handlers/domain-reverify.handler.ts`, `src/lib/verification/reverify.ts`, `test/integration/domain-reverify-handler.spec.ts`). AC6's consumer is closed by STORY-049 (crawl.audit reads the verification state).

Behaviour changes worth stating in the story: a notification is sent only when NO method still verifies the domain (it says scope was lost); a worker-initiated loss writes its own `audit_log` row `project.domain_verification_lost`; a re-check that still succeeds keeps the original `verified_at`.
