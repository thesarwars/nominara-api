# STORY-049 — per-AC status, decisions taken, and what is open (carry to the docs repo)

Update `stories/aux/STORY-049-crawl-pipeline-and-ssrf-guard.md` status from `Partial — 2 of 12 ACs` to **`Partial — 9 of 12 ACs (3 and 10 open; 6 half met)`**, replacing the 2026-10-12 table with the one below. **Do not mark AC6 or AC10 met**: with the default renderer every production audit that crawls a page ends `partial`.

| AC | State | Evidence / what is missing |
|---|---|---|
| 1 Refusals are 422 `unsafe_target`, reason names the check | Met | unchanged since the 2026-10-12 check |
| 2 Guarded fetcher enforces every control | Met | unchanged; round 1 adds an opt-in `followRedirect` veto (a caller can stop a hop BEFORE it is requested; SSRF validation of every followed hop is untouched) |
| 3 Egress via a dedicated path with no identity role | **Open — infrastructure (D4)** | nothing in this repo can deliver it; no code change here claims it |
| 4 Site files: robots verbatim + hash, agent-guidance file, sitemap with bounded recursion and sampling cap | Met | `site-files.ts`, `sitemap.ts` (`MAX_SITEMAP_FILES`, depth limit, sampling cap) |
| 5 Page selection by every scope, page cap from the plan | Met | `page-selection.ts`; the cap is **provisional** (below) |
| 6 Two fetches per page, both stored compressed | **Half met: port-only for the rendered copy** | the plain copy is fetched and stored. The rendered copy goes through the `Renderer` port; the default is `unavailableRenderer` because Playwright (a new dependency) has not been approved. The 2026-10-19 owner decisions cover the queue and STORY-053's parser, not Playwright. Tests use a fake renderer |
| 7 Politeness: rate, interval, crawl-delay, identified agent, hard cap | Met | `politeness.ts`; round 1 clamps the honoured Crawl-delay and adds a wall-clock budget (below) |
| 8 Differential probe, both requests budgeted | Met | `differential-probe.ts` |
| 9 Authorisation by verification state | Met | reads `domain_verifications` (the table, not the mirror column) |
| 10 Renderer sandboxed: no filesystem, no network beyond the target | **Open: port-only** | `createRenderRequestGuard` (request-level policy) exists and is unit-tested; there is no sandboxed renderer deployed to apply it to. Scenario 12 is therefore not a real sandbox inspection |
| 11 Crawled content untrusted: size caps, no script execution in the plain fetch, sanitisation before storage | Met, on the interpretation below | |
| 12 Failed page recorded with its reason, audit continues | Met | |

## Decisions taken (each needs the owner or architect to confirm, or reject)

1. **Provisional page cap of 25** behind `pageCapForPlan` (`page-selection.ts`) until the entitlement key exists.
2. **No pages table.** Per-page outcomes live in `aux_audits.error_summary` (jsonb, `auxErrorSummarySchema`) and in `manifest.json` under `dom_object_prefix`. A pages table is a schema decision (migration pair, isolation entry, RLS) nobody has made; STORY-050/051 may raise it.
3. **"Sanitisation before storage" means text bound for Postgres only** (`sanitise.ts`: NUL bytes and other characters Postgres text cannot hold). The two stored page copies are the bytes AS FETCHED, gzipped, with a sha256 of the uncompressed content, because the render-mode rules compare them and a rewrite would destroy the difference.
4. **Evidence URLs are ranked before sitemap-priority pages** in `key_pages`: owned citations (last 90 days) and open-task URLs first.
5. **"The supplied URL" for an unverified domain is the project's `root_url`**; `payload.targetUrls` is ignored when the domain is not verified, so a job cannot ask for more than ownership was proved.
6. **`pages_failed` counts pages with NO stored copy (plus site-file failures).** A page with a stored plain copy and no rendered one is `partial`, counted in `error_summary.pages_partial`, and still makes the audit `partial`. With no renderer installed `pages_failed` is therefore 0 and `pages_partial` equals `pages_crawled`.
7. **Bounds that are NOT FROM THE REFERENCE** (review round 1): `MAX_CRAWL_DELAY_SECONDS = 10` (`politeness.ts`), `CRAWL_WALL_CLOCK_BUDGET_MS = 10 min` and `IDLE_IN_TRANSACTION_TIMEOUT_MS = 15 min` (`crawl-audit.handler.ts`). robots.txt is untrusted input read even for an unverified project; without the clamp and the budget `Crawl-delay: 86400` kept one job asleep for days holding a worker slot and an open tenant transaction. The page list is shrunk up front to what fits the budget and recorded: `error_summary.crawl_delay_limited` plus the pages as `crawl_delay_budget` in `skipped_pages` and the manifest's `selection_skipped`. The architect should replace these numbers.
8. **Redirects.** Each hop is vetted before it is requested: off the registrable domain, or into a path NominaraBot's robots rules disallow, is not followed (`redirect_not_followed`). A page that still lands in a disallowed path is discarded (`robots_disallowed_after_redirect`).
9. **Manifest keys are snake_case**, including the probe (`browser_status`, `agent_status`); STORY-051 reads this document.

## OPEN — needs the architect before merge

**The crawl still runs inside one tenant transaction** (KAD-06). Round 1 BOUNDS it (clamp, wall-clock budget, transaction-local `idle_in_transaction_session_timeout`) but does not remove it. Removing it means a fetch phase with no transaction open and a short tenant transaction for the writes, which changes the worker-factory pattern: an architectural decision, not slipped into this story. Record the decision here before merge.

## Second-engineer review

`dangerous-area-auditor` must review both 048 and 049 before merge: 049 changes the SSRF guard (`guarded-fetch.ts`), adds a renderer request guard, reads `domain_verifications` under RLS to decide scope and writes tenant-prefixed object keys; 048 adds cross-tenant discovery on the owner connection and writes per tenant from a worker, including the hash-chained `audit_log`.
