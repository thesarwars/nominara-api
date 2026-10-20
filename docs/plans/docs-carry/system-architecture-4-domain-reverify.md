# system-architecture.md section 4 — one added queue row, and STORY-048 status (carry to the docs repo)

STORY-048 AC7 / OWNER DECISION 2026-10-19: adding one queue to the topology for periodic domain re-verification. Section 4's table has no queue for it. Add, after `retention.purge` (or wherever the additions block sits):

| Queue | Producer | Worker group | Concurrency | Retry | Priority | Idempotency key | Tenant-scoped |
|---|---|---|---|---|---|---|---|
| `domain.reverify` | cron daily 02:20 UTC (STORY-048 AC7) | crawl | 1 | 3x exp (2s, 4s, 8s) | 9 | `domreverify:{yyyy_mm_dd}` | no |

NOT tenant-scoped: the tick has no workspace to name. Cross-tenant discovery runs on the owner connection; each outcome is applied inside ONE tenant's context as the runtime role. The advisory lock makes it single-flight; a domain checked within the last 20 hours is skipped, which is the idempotency. The topology is now 21 + the added queues; update any prose that counts them.

Also update `schedule` tables that list cron cadences: `domain.reverify` `20 2 * * *` (UTC), a chosen hour in the quiet window, not a reference transcription.

Story file `stories/projects/STORY-048-domain-verification.md`: remove the "AC7's schedule" paragraph under *What is deferred*; AC7 is met by `domain.reverify` (`src/lib/queue/handlers/domain-reverify.handler.ts`, `src/lib/verification/reverify.ts`, `test/integration/domain-reverify-handler.spec.ts`). AC6's consumer is closed by STORY-049 (crawl.audit reads the verification state).

Behaviour changes worth stating in the story: a notification is sent only when NO method still verifies the domain (it says scope was lost); a worker-initiated loss writes its own `audit_log` row `project.domain_verification_lost`; a re-check that still succeeds keeps the original `verified_at`.

## Review round 1 (carry into STORY-048's technical notes)

- **Our outage is not their absence.** A resolver failure other than ENOTFOUND/ENODATA (ETIMEOUT, ESERVFAIL, ECONNREFUSED), a network error or timeout, or a 5xx/429/408 from the target is an `inconclusive` check outcome. The manual `/check` still reports the reason (the customer retries). The daily sweep records `last_checked_at` and changes nothing else: scope kept, no notification, no audit row. Without this, one resolver outage at 02:20 UTC would de-verify every DNS-verified domain in the fleet. A domain that is inconclusive for good (e.g. a target that 5xx's forever) stays verified and is re-checked every 20 hours; an "N consecutive failures" policy is a product decision nobody has made, so it is not invented here.
- **Concurrency.** `applyCheckOutcome` takes the row `FOR UPDATE` and works out the previous state itself (never from the caller's copy), so a manual check holding a stale row cannot notify a loss the sweep already recorded. `DomainVerificationService.check` does NOT lock before its network wait (a row lock held across an external await would be a KAD-06 violation); the lock inside the transition is what makes it safe. The sweep discards an outcome computed before a newer check (`last_checked_at` later than the sweep's check start).
- The `domain.reverify` span and run log gain `inconclusive`; `nominara_domain_reverify_checked_total` gains the label value `outcome="inconclusive"`.
