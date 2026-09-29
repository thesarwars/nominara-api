# `pnpm db:seed-demo` — the dev-only Command Center demo seed

STORY-169 (API step 3/3). Fills one workspace's projects with a
deterministic, clearly-marked synthetic dataset so the Command Center matrix
renders every field `GET /v1/projects` and `GET /v1/workspaces/{id}/action-items`
can carry — real Visibility Score / AUX / source-coverage / task data, run
through the same production code paths (`rollUpDay`, `denormalizeProject`,
`refreshProjectAux`, `refreshProjectTaskCounts`, `refreshProjectSourceCoverage`)
those endpoints already use. Nothing about the data pipeline is faked; only
the underlying facts are synthetic. **Not every row it writes carries a
marker** — see "What is marked" below for exactly which tables do and which
do not.

**Dev-only.** It refuses to run unless `NODE_ENV` is not `production`, both
`DATABASE_URL` and `DATABASE_URL_POOLED` name a local host, and you pass an
explicit opt-in — see `src/db/seed/demo/guard.ts`.

## Usage

```bash
export DATABASE_URL="postgres://nominara:nominara@localhost:55432/nominara"
export DATABASE_URL_POOLED="postgres://nominara_app:nominara_app_dev_local@localhost:6432/nominara"
export NOMINARA_DEMO_SEED=1

pnpm db:seed-demo --workspace <workspace-uuid>
```

`--workspace` is required unless the database has **exactly one** workspace,
in which case it is inferred.

To undo everything the seed created for a workspace:

```bash
NOMINARA_DEMO_SEED=1 pnpm db:seed-demo --workspace <workspace-uuid> --purge
```

## What it does

1. Targets **every active project** in the workspace. If the workspace has
   fewer than three NON-DELETED projects (any status — the same count
   `structural-usage.ts`'s own `projects.max` guard uses, not just
   `active`), it creates demo projects — "HubSpot CRM" (hubspot.com),
   "Stripe Payments" (stripe.com), "Zendesk Service Hub" (zendesk.com) — up
   to `min(3, projects.max)`. It never exceeds the plan's cap, for
   projects, prompts (`prompts.max_per_project` AND `prompts.max_total`) or
   competitors (`competitors.max_per_project`) — including on a
   pre-existing project the seed writes INTO, not just one it creates.
2. For each target project: 60 workspace-local days of tracked prompts,
   entitled-engine answer captures, brand and competitor mentions, and
   citations — then the **real** rollup (`rollUpDay` + `denormalizeProject`,
   under the same `rollup.metric_daily` advisory lock the queue handler
   takes).
3. An AUX audit with real findings (always including one **critical**
   `crawler_access` finding), scored by the real `auxScore()` function, then
   `refreshProjectAux`.
4. Source domains and a `project_source_index` window (always including at
   least one `critical` and one `high` gap), then `refreshProjectSourceCoverage`.
5. 5–12 tasks linked to the findings and source gaps above, plus a few
   generic ones with no derivable severity, then `refreshProjectTaskCounts`.
6. `projects.demo_seeded_at` is set on every project it touched.
7. If the workspace has no `credit_wallets` row, one is provisioned through
   the real `resolveBillingPeriod` + `provisionWalletWithGrant` path — the
   plan's real grant, never an invented balance. **This step is not
   reversible**: `credit_ledger` is append-only, and `--purge` never touches
   it.

Every tenant write runs as `nominara_app` inside `withTenantContext` — RLS is
the real boundary, not a convention on a superuser connection. The FIRST
statement inside that transaction checks `current_user`/`rolsuper`/
`rolbypassrls` against `pg_roles` and refuses to write anything unless the
pooled connection is really `nominara_app` with both flags false — a
`DATABASE_URL_POOLED` that happens to authenticate as the owner or the
superuser (easy when connection strings are exported by hand) would
otherwise run every write with RLS bypassed, silently. `DATABASE_URL` (the
owner connection) is used only to resolve the workspace and to create the
fact-table partitions the 60-day backfill needs, via
`ensurePartitionsForTable` — never a raw `CREATE TABLE ... PARTITION OF`.

## Re-running

Re-running the seed against the same workspace is idempotent: each producer
deletes its own previously-seeded rows for a project before writing a fresh,
deterministically-generated set (seeded by the project's own id), so cells
are never doubled. It does **not** re-provision the wallet or re-grant
credits if one already exists.

## What is marked

**Carries an explicit marker:**

- `answer_captures.normalizer_version = 'demo-seed'`
- `aux_audits.rule_version` / `.tokenizer = 'demo-seed'`, and every
  `aux_findings.rule_version` it writes
- `tasks.playbook_payload ->> 'demo_seed_marker' = 'demo-seed'`
- `tracked_prompts.generator_meta ->> 'demo_seed_marker' = 'demo-seed'` — set
  ONLY on a prompt row the seed actually inserted, never on one it reused
  because a pre-existing project already had a prompt with the same
  `text_hash`.
- `projects.demo_seeded_at` (non-null on every project the seed touched)
- `projects.fingerprint ->> 'demo_seed_created' = 'true'` on a project the
  seed **created** (as opposed to a pre-existing project it only seeded data
  into) — this is what `--purge` reads to decide whether to delete the
  project outright or only clean it.

**Carries NO marker at all:**

- `competitors` — a competitor the seed adds to a PRE-EXISTING project
  cannot be told apart from that project's own, so `--purge` cannot remove
  it (see "`--purge`" below). `ensureCompetitors` still respects
  `competitors.max_per_project`, so it stops writing once the plan's cap is
  reached; it just cannot clean up what it already wrote.
- `source_domains` and `project_source_index` — NOT because the seed forgot
  to mark them, but because nothing else in the codebase writes either table
  today (`sources.ts`'s own header comment: "there is no `crawl.audit`-
  equivalent producer for sources yet"), so every row `--purge` finds for a
  project is, by construction, something this seed put there. That fact
  could stop being true the day a real producer for either table ships,
  and this seed would then need a real marker too.
- `metric_daily` — rolled up FROM marked facts, but the rollup itself keeps
  no column saying so. `--purge` never deletes it by a marker: it re-rolls
  the demo facts' own date range (read from `answer_captures` before they
  are deleted) from whatever facts remain, real or demo, which is correct
  regardless of whether any individual `metric_daily` row is markable (see
  "`--purge`" below).

`aux_rule_catalog` and `task_generation_rules` rows use real spec codes
(`AUX-R-001`, `TG-SOV-DROP-ENGINE`, …) and are inserted `ON CONFLICT DO
NOTHING` — they are global, shared catalogs, and this seed never overwrites
an existing row in either.

## `--purge`

For every project in the workspace with `demo_seeded_at` set:

- deletes its demo-marked facts (`answer_captures`/`mention_facts`/
  `citation_facts`), AUX audit/findings, source index rows, tasks, and the
  `tracked_prompts` rows it marked as its own inserts;
- **re-rolls `metric_daily`, never deletes it wholesale.** The affected date
  range is read from the demo facts' OWN min/max `captured_at` (never
  `metric_daily`'s), so a PRE-EXISTING project's real rollup history outside
  that window is untouched. Inside the range, `metric_daily` is deleted and
  every day that still has REAL facts left (`datesWithFacts`) is re-rolled
  from them via the real `rollUpDay`; a day left with no facts at all
  correctly ends up with no row, exactly like a day the real pipeline never
  captured — never a blanket `DELETE FROM metric_daily WHERE project_id = …`;
- re-runs `refreshProjectAux` / `refreshProjectTaskCounts` /
  `refreshProjectSourceCoverage` (each already reports null/zero on empty
  input) and recomputes BOTH `prompts_active` (a count over what remains)
  AND `prompts_cap` (resolved fresh from the workspace's CURRENT
  entitlement — the same resolution `activation.service.ts`'s own
  `resolveCap` uses, never a value stored from the seed run or from before
  it — so a plan change between seeding and purging is reflected, exactly
  as it would be for a real project);
- calls `denormalizeProject` over the re-rolled range, then directly nulls
  the metric-derived `projects` columns ONLY if `metric_daily` is left
  genuinely empty for the project afterward — `denormalizeProject` cannot
  express "there was a rollup and now there is none" on its own (it returns
  early on zero `metric_daily` rows), so this is the one place `--purge`
  writes a null directly rather than through a producer;
- clears `demo_seeded_at`;
- **deletes the project row outright** if the seed created it, or leaves a
  pre-existing project in place, restored as above. **Except competitors**
  (see "What is marked" above): a competitor the seed added to a
  pre-existing project is not removed, because it carries no marker to tell
  it apart from that project's own.

The wallet and `credit_ledger` are never touched by `--purge`.
