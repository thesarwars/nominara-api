# NEW-E-099b — portal tasks and first-view notification (STORY-099 part B)

Branch `7day/e-portal-3`. No migration. Dangerous area (RLS / tenant context).
Commits: contract `aec73a4`; RED `cc42b96`; GREEN `eb75328`.

## STATUS: PARTIAL — tasks and first-view notification built; SOURCES BLOCKED on a decision

## READ THIS FIRST

1. **`GET /portal/sources` is NOT built.** The portal role cannot read the domain name. `project_source_index` holds only
   `source_domain_id`; the name lives in `source_domains`, which is deliberately NOT in `PORTAL_READABLE_TABLES`
   (`src/db/conventions.ts`, STORY-011-E-2: it has no `project_id`, so a portal policy could only filter by workspace and a
   project-scoped token could enumerate every domain in the workspace). The track plan says "migrations: none (...
   project_source_index are portal-readable)" and "read from project_source_index only"; both cannot hold at once, and
   `schemas/README.md` line 48 still lists `source_domains` as portal-readable (spec and code disagree). Decision needed, one of:
   - (a) add a `project_id`-bearing read path: denormalise `domain` (and `source_class`, `is_seedable`) onto
     `project_source_index` (additive migration in 0112-0114, backfill, `refresh-project-source-index.ts` writes it).
     **Recommended**: keeps project scoping at the database and keeps "read from project_source_index only" true.
   - (b) add `source_domains` to `PORTAL_READABLE_TABLES` with a workspace-only policy (the README's reading): leaks the
     workspace's discovered-domain list to every project-scoped token. Not recommended.
   Also decide: the portal sources contract has `gap_severity` non-null and no `other` class; the agency read returns null
   gap while unverified and has `other`. This lane would make both match the agency read (null = unverified).
2. **The integration spec `test/integration/portal-tasks-http.spec.ts` (14 tests) was WRITTEN AND COMMITTED BUT NOT RUN.**
   `df -h /System/Volumes/Data` showed 6.4 GiB free (< 8 GiB): no testcontainers spec started. Every row citing it is
   UNPROVEN. Typecheck and lint pass on it. Its RED state was not observed.
3. The RED run is unit-only: at `cc42b96` the three unit specs gave **19 failed, 2 passed, exit 1** (`portalTasks is not a
   function`, no notification written); the 2 passing are "later view / refused view writes none", which hold vacuously
   before the change and guard the implementation after it.
4. Evidence that needs a running real API is collected in NEW-A-17.
5. dangerous-area-auditor (098a, 098b, 099a, 099b together) has NOT run: PENDING (merge step).
6. OpenTelemetry spans are deferred to week 2 by owner decision; a missing span is not a failed criterion this week.

## Criteria

| Criterion | Proof | Result |
|---|---|---|
| RED tests first; tasks returns completed items (title, completed_at, measured) and open items ordered by impact | unit `src/modules/tasks/tasks-portal.spec.ts` "STORY-099 s8 · completed items carry...", "open items are ordered by impact...", "completed items are tasks in status done, newest first..."; `src/modules/portal/portal-tasks.spec.ts` "maps completed work...", "measured is null (never 0...)", "no completed_at keeps null"; integration "STORY-099 s8 · completed work ... newest first; open work by impact..." | unit pass; integration NOT RUN |
| ...no cost or capture fields when hide_costs | `portal-tasks.spec.ts` "STORY-098 s12 · hide_costs ... key scan"; `contracts/portal/portal-read.schema.test.ts` (strict response, no extra field); service scans each payload before storing it (existing `cached()`); integration "STORY-098 s12" | unit pass; integration NOT RUN |
| Tasks refuses out-of-scope tab and project | `portal-tasks.spec.ts` "STORY-098 s10 · a project outside the token's scope..." and "...a tab outside scope_tabs..." (both assert nothing is read); integration "STORY-098 s10" (403 `project_out_of_scope`, body does not leak the other project's task) | unit pass; integration NOT RUN |
| Sources read from project_source_index only; refuses out-of-scope | not built | **BLOCKED (see 1)** |
| Portal queries touch no fact tables (query trace, STORY-099 s14) | unit `tasks-portal.spec.ts` "STORY-099 s14 · neither statement touches a fact table" (records every statement the read issues; none names answer_captures, mention_facts, citation_facts, capture_runs); integration "STORY-099 s14" uses `pg_stat_statements` if the extension is present, otherwise it passes vacuously (**weak**; the unit trace is the real proof). **Scope of this claim: the TASKS read only.** The 099a overview/growth-map/matrix reads reuse ScorecardsService/GrowthMapService, which DO query fact tables under portal policies (see NEW-E-099a decision 1) | unit pass for tasks; overview/growth-map/matrix NOT met |
| First session mint writes a notifications row for the workspace (FR-AGY-01o); in-app only, email deferred | unit `src/modules/agency/share-token-first-view.spec.ts` (5 tests: first view writes exactly one workspace-wide `portal.first_view` row, only after the counter UPDATE; view 2/3/50 write none; a refused view writes none; no visitor ip/agent/secret in params; no email channel); `consumeView` decides "first" from the same atomic UPDATE (`RETURNING view_count`), so the row lock serialises parallel mints. Integration: "first session mint ... one in-app notification", "two parallel first mints produce exactly one", "a refused mint writes no notification" | unit pass; integration NOT RUN |
| Reuse task/source read services rather than fork | `TasksService.portalTasks` is added to the OWNING service of `tasks` (one table, one owning service). `listProjectTasks` was not reused: it is cursor-paginated, returns descriptions/assignees/impact scores and has no measured impact; the portal needs a narrower, bounded projection. `SourcesService.sourceIndex` was not reused either (see 1: it joins `source_domains`, `competitors`, `workspaces`, which the portal role cannot read) | by construction; sources blocked |
| dangerous-area-auditor second engineer | not run in this lane | PENDING (merge step) |
| Timeframe lock honoured (STORY-098 s13) | `portal-tasks.spec.ts` "a timeframe lock bounds completed work to that many days; no lock means unbounded"; `tasks-portal.spec.ts` "completedSince is a bind parameter"; integration "STORY-098 s13" | unit pass; integration NOT RUN |
| Per-token cache (STORY-099 s15) | `portal-tasks.spec.ts` "the per-token cache: ... another token reads afresh"; integration "STORY-099 s15" | unit pass; integration NOT RUN |
| Read-only (STORY-099 s3) | controller declares GET only; integration "STORY-099 s3 · every mutating verb on /portal/tasks is refused, and no task changes" | NOT RUN |

## Decisions the owner should see

1. **hide_competitors drops tasks born of a displacement event** (`source_displacement_id IS NOT NULL`), in SQL. Their
   titles name a competitor by construction; showing them to a token with competitors hidden defeats the setting. The
   story does not say this; it is fail-closed and one clause to remove. Say if wanted otherwise.
2. **Caps**: each list is `LIMIT 100` (`PORTAL_TASKS_LIMIT`). The number is mine, not from the reference. The contract has no pagination.
3. **`measured` comes from the task's milestone** (`milestones.measured_impact`, the jsonb the schema documents), validated by
   the existing `toMeasuredImpact` (now exported); `tasks.completion_metrics` has no writer or documented shape. A milestone
   hidden from the portal contributes no measurement. Incomplete impact is null, never a partial object.
4. **Contract changes (own commit `aec73a4`)**: open `severity` is nullable (a manual task, or a gap not yet verified, has none)
   and open `status` is `todo | in_progress`.
5. **Completed work is bounded by the lock** (`completed_at >= now - lock`); with no lock it is unbounded (capped at 100).
6. Touched outside the portal module, minimally: `ShareTokensService.consumeView` (the first-view row, same transaction,
   `RETURNING view_count, label`), `TasksService.portalTasks`, `toMeasuredImpact` export. The notification title carries the
   token's label (agency-authored), not the workspace name; the log line carries workspace and token ids only.

## Observability

- Metrics: `nominara_portal_reads_total{tab="tasks",cache}` (existing counter, new tab value);
  `nominara_portal_first_view_notifications_total`.
- Log lines (redacted): `portal.read` (workspace id, token id, tab, cache, duration) and `portal first view notified`
  (workspace id, share token id). Not asserted by a test beyond the code path.
- Spans: deferred to week 2 by owner decision.

## Mutation check (unit)

Seven mutations, each caught by exactly one failing test: first-view `=== 1` -> `>= 1`; milestone visibility filter removed;
hide_competitors clause neutralised; open status widened to `<> 'done'`; tab check removed; project-in-scope check removed
(first attempt hit the growth-map copy and was redone on the tasks method); lock bound dropped. Files restored.

## Gates (on `eb75328`)

- `pnpm lint` exit 0
- `pnpm typecheck` exit 0
- `pnpm test:unit` exit 0 (283 files passed, 1 skipped; 3360 tests passed, 1 skipped)
- `pnpm contracts:generate` then `pnpm contracts:check` exit 0; `pnpm contracts:diff` against the previous file: `minor` (new endpoint)
- `pnpm test:integration` for `portal-tasks-http.spec.ts`: **NOT RUN** (disk 6.4 GiB < 8 GiB)
- `pnpm test:isolation`: not runnable at this tip (known support_grants fixture crash); merge step runs it

## Update 2026-10-08 — integration spec now run and GREEN (supersedes every "integration NOT RUN" row above)

Disk was 20 GiB free (rule: 8 GiB), so `test/integration/portal-tasks-http.spec.ts` was run on colima
(`DOCKER_HOST` and `TESTCONTAINERS_RYUK_DISABLED` set), at tip `31d021c`:
`pnpm exec vitest run --config vitest.integration.config.ts test/integration/portal-tasks-http.spec.ts` gave
`Tests 14 passed (14)`, exit 0. The spec runs the real HTTP stack on the real `nominara_portal` role, so tenant isolation
for tasks and the first-view row is proven under the portal role. Every row above that said "integration NOT RUN" is now
unit pass + integration pass, with these caveats:

- The spec was never observed RED (written and committed before the disk allowed a run; it was green on first run). The only
  RED evidence is the unit RED at `cc42b96` (19 failed, 2 passed, exit 1).
- "STORY-099 s14" in the integration spec still passes vacuously when `pg_stat_statements` is absent; the unit query trace
  remains the real proof, and covers the TASKS read only.
- The ERROR lines in the run output are the expected refusals the spec provokes (403, 404 on mutating verbs, 400, 401).
- Real-API evidence is collected in NEW-A-17.

## STILL BLOCKED: GET /portal/sources (needs an owner decision; nothing was built)

Why I did not choose: both ways to read domain names change a security boundary or a schema the story did not name.
- Spec: `schemas/README.md` lists `source_domains` as portal-readable "scoped to the share token's project allow-list", but the
  table has no `project_id`, so that policy cannot be written as the README says. Code (`PORTAL_READABLE_TABLES`) excludes it on purpose.
  The README sentence needs correcting in the docs repo whichever way this goes.
- (a) additive migration (0112-0114 range, 0112 is used by the lookup owner, so 0113): denormalise `domain`, `source_class`,
  `is_seedable` onto `project_source_index`, backfill, writer updated. Keeps project scoping in the database. Recommended.
- (c) no migration: read `project_source_index` on the portal pool (project-scoped by RLS), then read the names from
  `source_domains` by those ids on the app pool in the per-request step, as 099a does for workspace facts. No schema change, but
  it departs from "read from project_source_index only" and the app-pool read is filtered by id in application code, not by RLS.
- (b) workspace-wide policy on `source_domains`: leaks the domain list to every project-scoped token. Not recommended.
Also decide: portal `gap_severity` non-null and no `other` class in the contract versus the agency read (null while unverified; has `other`).
Decision 9 (unverified domains keep NULL coverage) points to nullable. Once decided this is about half a day.
Until then the sources criterion and the "no fact tables" criterion for sources are NOT MET.
