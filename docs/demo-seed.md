# `pnpm db:seed-demo` — the dev-only Command Center demo seed

STORY-169 (API step 3/3). Fills one workspace's projects with a
deterministic, clearly-marked synthetic dataset so the Command Center matrix
renders every field `GET /v1/projects` and `GET /v1/workspaces/{id}/action-items`
can carry — real Visibility Score / AUX / source-coverage / task data, run
through the same production code paths (`rollUpDay`, `denormalizeProject`,
`refreshProjectAux`, `refreshProjectTaskCounts`, `refreshProjectSourceCoverage`)
those endpoints already use. Nothing about the data pipeline is faked; only
the underlying facts are synthetic, and every row it writes is marked as
such (see "What is marked" below).

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

1. Targets **every active project** in the workspace. If it has fewer than
   three, it creates demo projects — "HubSpot CRM" (hubspot.com), "Stripe
   Payments" (stripe.com), "Zendesk Service Hub" (zendesk.com) — up to
   `min(3, projects.max)` for the workspace's real plan entitlement. It never
   exceeds the plan's cap.
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
the real boundary, not a convention on a superuser connection. `DATABASE_URL`
(the owner connection) is used only to resolve the workspace and to create
the fact-table partitions the 60-day backfill needs, via
`ensurePartitionsForTable` — never a raw `CREATE TABLE ... PARTITION OF`.

## Re-running

Re-running the seed against the same workspace is idempotent: each producer
deletes its own previously-seeded rows for a project before writing a fresh,
deterministically-generated set (seeded by the project's own id), so cells
are never doubled. It does **not** re-provision the wallet or re-grant
credits if one already exists.

## What is marked

- `answer_captures.normalizer_version = 'demo-seed'`
- `aux_audits.rule_version` / `.tokenizer = 'demo-seed'`, and every
  `aux_findings.rule_version` it writes
- `tasks.playbook_payload ->> 'demo_seed_marker' = 'demo-seed'`
- `projects.demo_seeded_at` (non-null on every project the seed touched)
- `projects.fingerprint ->> 'demo_seed_created' = 'true'` on a project the
  seed **created** (as opposed to a pre-existing project it only seeded data
  into) — this is what `--purge` reads to decide whether to delete the
  project outright or only clean it.

`aux_rule_catalog` and `task_generation_rules` rows use real spec codes
(`AUX-R-001`, `TG-SOV-DROP-ENGINE`, …) and are inserted `ON CONFLICT DO
NOTHING` — they are global, shared catalogs, and this seed never overwrites
an existing row in either.

## `--purge`

For every project in the workspace with `demo_seeded_at` set:

- deletes its demo-marked facts, AUX audit/findings, source index rows and
  tasks;
- re-runs `refreshProjectAux` / `refreshProjectTaskCounts` /
  `refreshProjectSourceCoverage` (each already reports null/zero on empty
  input);
- directly nulls the metric-derived `projects` columns
  (`visibility_blended`, the two deltas, `rendering_quality`,
  `sentiment_score`, `cells_30d`, `sparkline_30d`, `visibility_by_engine`) —
  `denormalizeProject` cannot express "there was a rollup and now there is
  none" on its own (it returns early on zero `metric_daily` rows), so this
  is the one place `--purge` writes a null directly rather than through a
  producer;
- clears `demo_seeded_at`;
- **deletes the project row outright** if the seed created it, or leaves a
  pre-existing project in place with every demo-derived column back to null.

The wallet and `credit_ledger` are never touched by `--purge`.
