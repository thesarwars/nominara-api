# nominara-api

Domain model, database, every external call, and all workers for Nominara. See
`Nominara-Dev-Docs-main/references/project-structure.md` for the full repo
layout and boundary rationale, and `Nominara-Dev-Docs-main/README.md` §3 for
the settled architecture decisions (KAD-01…18) this repo must not contradict
without an ADR.

## Local setup

```bash
pnpm install
docker compose up -d          # Postgres 18 + pgvector on localhost:5432, pgBouncer on localhost:6432,
                              # Valkey cache on localhost:6379 (STORY-025 — required outside NODE_ENV=test)
cp .env.example .env
pnpm db:migrate
pnpm db:dev-credentials        # local-dev passwords for the runtime + break-glass roles (STORY-010)
```

If Docker is running under **colima** rather than Docker Desktop, testcontainers
(used by the integration suite) needs to be told where the socket is, and its
cleanup container (Ryuk) can't bind-mount colima's socket path, so it must be
disabled:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_RYUK_DISABLED=true
```

Add these to your shell profile if you use colima day to day. Docker Desktop
users don't need either.

## Database tooling (STORY-006)

| Command | Does |
|---|---|
| `pnpm db:generate <name>` | Scaffolds a new `NNNN_<name>.up.sql` / `.down.sql` pair under `src/db/migrations/sql/`. |
| `pnpm db:migrate` | Applies every migration not yet recorded, in filename order. |
| `pnpm db:rollback` | Rolls back the most recently applied migration using its `.down.sql`. |
| `pnpm db:drift-check` | Applies every committed migration to a disposable shadow database and fails if the result doesn't match `src/db/conventions.ts`. |
| `pnpm db:reset` | Drops everything this project owns (`public`, `app`, `_migrations`) and rebuilds from empty. |
| `pnpm db:role-check` | Inspects the role the current `DATABASE_URL` connection is actually authenticated as, and fails if it's the migration owner (STORY-010). |
| `pnpm db:dev-credentials` | Sets local-development passwords on the runtime + break-glass roles created by migration `0005` (never done by a migration itself — STORY-010). |
| `pnpm db:rls-generate` | Regenerates `0006_generated_rls_policies.up.sql` **and** `src/db/rls/tenant-tables.generated.ts` (the `TENANT_TABLES` set — fix pass item 11) from `src/db/rls/generate.ts` against a disposable shadow database. `--check` fails instead of writing, if either committed file would differ (STORY-011). |
| `pnpm db:rls-check` | Applies every committed migration to a disposable shadow database and reports 5 independent RLS-drift buckets — unclassified tables, missing RLS flags, missing/unexpected policies, `FOR ALL` policies without a `with_check`, and stray policies on `GLOBAL_TABLES` (STORY-011). |

**Why hand-rolled instead of drizzle-kit's own migrator:** drizzle-kit's
migration runner is forward-only — it has no paired down-migration concept.
STORY-006 requires every migration to be tested rolling back on a shadow
database, so `src/db/migrate-runner.ts` owns its own bookkeeping table
(`_migrations.applied`) and up/down file pairing. drizzle-kit still owns
schema-diff generation once STORY-007 adds the first `schema.ts` tables under
`src/db/schema/`.

**The additive-only guard** (`src/db/additive-guard.ts`) runs automatically
before every migration is applied. A migration that drops a column, drops a
table, truncates one, or adds/sets a `NOT NULL` constraint is rejected if the
target table has any rows, unless the file contains this line on its own
(`ci-cd-and-environments.md` §3's contract-phase annotation, verbatim):

```sql
-- @contract-phase
```

**Conventions and drift.** `src/db/conventions.ts` is the source of truth for
which Postgres extensions and `app`-schema functions must exist —
`db:drift-check` is what makes that file authoritative rather than aspirational.
The schema is named `app` (not something project-local) because
`security-and-tenancy.md`, `system-architecture.md`, and others already
reference `app.current_workspace()` and friends — STORY-011 lands its
tenant-context functions into this same schema.

## Database roles & grants (STORY-010)

Five roles plus one incident-response role, created by migration
`0005_roles_grants_and_pooling.up.sql`. Full spec:
`security-and-tenancy.md` §2, `src/db/conventions.ts`'s `DATABASE_ROLES`.

| Role | Login | Bypasses RLS | Connection limit | Used by |
|---|---|---|---|---|
| `nominara_owner` | No | No | unlimited (-1) | Nobody — migration/DDL owner only, never a running service |
| `nominara_app` | Yes | No | 400 | `src/api`, `src/gateway` |
| `nominara_worker` | Yes | No | 300 | `src/workers/*` |
| `nominara_report` | Yes | No | 40 | Read-only reporting, replica only (see gap G-3) |
| `nominara_portal` | Yes | No | 60 | Share-token portal, read-only |
| `nominara_breakglass` | Yes | **Yes** | 2 | Incident response only, direct connection, never through pgBouncer |

`nominara_app`/`nominara_worker` get `SELECT, INSERT, UPDATE, DELETE` on every
table (via `ALTER DEFAULT PRIVILEGES` too, so a table added by a later
migration isn't silently ungranted); `nominara_report`/`nominara_portal` get
`SELECT` only. Two grant-level exceptions, per `security-and-tenancy.md` §1/§2:

- `user_credentials` — only `nominara_app` (the auth path) has any privilege;
  `nominara_worker`/`nominara_report`/`nominara_portal` have none at all.
- `audit_log` — `nominara_app`/`nominara_worker` get `INSERT, SELECT` only
  (append-only at the grant level, alongside the `reject_update_delete`
  trigger from migration `0004`); `nominara_report`/`nominara_portal` get
  `SELECT`.

Local dev passwords for the runtime + break-glass roles are set by
`pnpm db:dev-credentials` (never by a migration — see that script's header)
and match `docker/pgbouncer/userlist.txt`'s LOCAL-DEVELOPMENT-ONLY entries.

## pgBouncer (STORY-010)

`docker compose up -d` brings up pgBouncer (`edoburu/pgbouncer:v1.25.2-p0` —
pinned at the `system-architecture.md` security floor of ≥1.25.2) on
`localhost:6432`, in front of the same Postgres. Config lives entirely in
checked-in files, never compose env vars:

- `docker/pgbouncer/pgbouncer.ini` — `pool_mode = transaction` (the only safe
  mode; see the comment at that exact setting for why), plus
  `server_reset_query_always = 0` with its own comment explaining why turning
  it on would paper over the exact class of leak this story's interleaved
  tenant test exists to catch.
- `docker/pgbouncer/userlist.txt` — LOCAL-DEVELOPMENT-ONLY plaintext
  passwords (gap G-2 below).

`DATABASE_URL` (port 5432) stays the direct migration/DDL connection.
`DATABASE_URL_POOLED` (port 6432, see `.env.example`) is what application
code uses. Never point a migration at the pooled URL — transaction-mode
pooling cannot support the runner's own long-lived migration transactions.

The interleaved-tenant test at pool size one
(`test/integration/pgbouncer-transaction-mode.spec.ts`) is the most important
test in EPIC-01: it proves two tenants sharing one pooled server connection
never see each other's `SET LOCAL` context, and — via a mandatory negative
control — that a session-scoped `SET` (banned in application code by
`NFR-SEC-02`) *would* leak if anyone ever used one.

## Row-level security & tenant context (STORY-011)

**This is the single most load-bearing story in the repository.** Migration
`0006_generated_rls_policies.up.sql` is **generated, not hand-written** —
regenerate it with `pnpm db:rls-generate` after touching `src/db/schema/`,
never hand-edit the file. Full spec: `security-and-tenancy.md` §3–4.

- `src/db/rls/generate.ts` — a pure function, `generateRlsSql(tables)`, with
  no table-name literals of its own. Every table-specific decision comes
  from `src/db/conventions.ts`'s `GLOBAL_TABLES` / `TENANT_SCOPE_COLUMN` /
  `PORTAL_READABLE_TABLES` / `PORTAL_SELF_SCOPED_TABLES`. A table with
  neither a `workspace_id` column nor an explicit decision in one of those
  lists makes the generator **throw**, naming the three remedies — a new
  table cannot ship without an explicit isolation decision.
- **The partition RLS hole, found and fixed by this story.** `ENABLE`/`FORCE
  ROW LEVEL SECURITY` on a partitioned parent table (`answer_captures`,
  `mention_facts`, `citation_facts`) does **not** cascade to its partition
  children — verified by direct probe: querying a partition child directly,
  as a non-superuser runtime role with no context set, returned every
  tenant's rows. `app.apply_tenant_rls(target regclass)` fixes this for one
  partition at a time (discovers the parent via `pg_inherits`, copies its
  `ws_isolation_*` policy predicate onto the child, idempotent); a
  `pg_inherits`-driven `DO` block in `0006` applies it to every partition
  that exists today. **STORY-013's monthly partition-maintenance job must
  call this exactly once per new partition it creates**, or every new
  partition reopens this hole — recorded in that story's own Technical
  Notes.
- `src/tenancy/tenant-context.ts` — `withTenantContext(client, context, fn)`
  opens one transaction, sets the three GUCs via parameterized
  `set_config(..., true)` calls, runs `fn` inside an `AsyncLocalStorage`
  store, commits on success, rolls back and rethrows the original error on
  throw. Framework-agnostic (no NestJS scaffold exists in this repo yet) —
  a future interceptor calls into this with a few lines of glue.
- `src/tenancy/with-tenant-job.ts` — `withTenantJob` verifies a queue job's
  HMAC-SHA256 signature **before** any `set_config` call, so a poisoned
  queue entry can never redirect a worker into another tenant's context.
  `hmacSha256JobVerifier` is a real (if minimal) verifier; queue
  integration itself (BullMQ, Valkey, key rotation) is out of scope here —
  a future queue-epic story's job.
- `src/tenancy/query-guard.ts` — `assertTenantContext`/`tenantAware` throw
  `TenantContextMissingError` when a tenant table is queried outside an
  active `withTenantContext` **on the same client the query is running on**
  (fix pass item 11(c) — the original check only verified SOME context was
  ambiently active, not that it was active on the client actually issuing
  the query). Checks against `src/db/rls/tenant-tables.generated.ts`'s
  `TENANT_TABLES` — a real, generated 59-member set (fix pass item 11(b);
  previously nothing generated one, despite `NFR-SEC-01` naming it). A regex
  heuristic over SQL text passed to `.query(...)`, **not** the security
  boundary (RLS is) — see gap G-6.
- `eslint-rules/no-session-scoped-config.js` — bans `set_config(..., false)`,
  a `set_config` call with fewer than 3 arguments, and any bare `SET`
  statement other than `SET LOCAL`/`SET ROLE` (`NFR-SEC-02`), wired in as a
  local flat-config plugin (`nominara/no-session-scoped-config`).

## Testing

```bash
pnpm test:unit               # pure functions — no network, clock, or DB
pnpm test:integration        # real Postgres via testcontainers, pgvector/pgvector:pg18
pnpm test:isolation          # STORY-012 — the 16 isolation assertions + ISO-00, one shared container
pnpm test:isolation:breakers # every assertion demonstrated failing against its own breaker
```

No test suite depends on a live external vendor. See
`references/testing-strategy.md` for the full pyramid and which gates block a
merge.

## Isolation verification suite (STORY-012)

`test/isolation` — sixteen assertions (`security-and-tenancy.md` §10,
`ISO-01`…`ISO-16`) plus this repo's own `ISO-00` anti-vacuity guard. Blocking
by policy on every pull request; nightly against staging is a **capability**,
not yet scheduled (no CI exists — see gap G-9 below).

- **Architecture.** Every assertion is an exported function under
  `test/isolation/assertions/iso-NN-*.ts`, called both by a green spec wrapper
  (`test/isolation/*.spec.ts`) and by the breaker matrix
  (`test/isolation/breakers/breaker-execution.spec.ts`). No assertion is ever
  written inline inside an `it()`. `test/isolation/assertions/registry.ts`
  aggregates all 17 as `{ id, assert, assertUnderBreaker, breaker, readOnly,
  needsFixture }` — `test/isolation/meta/breaker-matrix.spec.ts` asserts the
  registry's size and ID set structurally, so an assertion added without a
  breaker fails there, not silently.
- **One shared container.** `test/isolation/support/global-setup.ts` (Vitest
  `globalSetup` + `provide`/`inject`) starts ONE Postgres container, runs the
  full migration chain once, seeds the three-tenant fixture once, and builds
  a second database (`nominara_iso_breaker_template`) as a byte-for-byte
  template for breakers — never per test file, which would blow the runtime
  budget.
- **Discovery, not enumeration.** `test/isolation/support/discovery.ts`
  derives the tenant table set, the global table set, partition children, and
  every `*_enc` column live from the catalog, and cross-checks the result
  against `src/db/conventions.ts`'s `GLOBAL_TABLES` and
  `src/db/rls/tenant-tables.generated.ts`'s `TENANT_TABLES` — a table added
  without an isolation decision fails the census (`ISO-06`), not silently
  shrinks every other loop.
- **The fixture.** `test/isolation/support/three-tenant-fixture.ts` seeds 3
  tenants × 50 projects, with every one of the 59 tenant tables mapped
  (mostly 1:1 onto a project) so every genuine per-project `UNIQUE`
  constraint in the schema is satisfied automatically. Two tables are
  structurally capped at exactly 1 row per tenant by their own primary key
  (`credit_wallets`, `workspaces` itself) — documented, not fought.
  D-7's four "awkward shapes" (a single-prompt project, a common-word brand,
  a multi-word brand, a substring-colliding competitor pair) are present in
  every tenant. `test/isolation/three-tenant-fixture-coverage.spec.ts` is the
  fixture's own coverage spec.
- **Breakers.** `test/isolation/support/broken-database.ts` templates a
  disposable, throwaway database off `nominara_iso_breaker_template` per
  breaker (`CREATE DATABASE ... TEMPLATE ...`) so a breaker's mutation can
  never contaminate the shared fixture every other spec file reads. Three
  assertions (`ISO-11`, `ISO-13`, `ISO-14`) are pure application-layer/scanner
  properties with no database policy to mutate — their breakers operate on
  the application layer or on a planted `src/lib/_isoNN_breaker_probe.ts`
  file instead, cleaned up in `revert()`.
- **`ISO-12`** exercises a real (if minimal, non-KMS) envelope-encryption
  implementation added by this story: `src/lib/crypto/envelope.ts`
  (AES-256-GCM, `v1:{dek_id}:{iv}:{ct}`, AAD = `workspace_id|table|column|row_id`).
- **`ISO-13`/`ISO-14`** are fail-closed *scanners* over cache-key/object-key
  construction sites in `src/` (`test/isolation/support/key-construction-scanner.ts`),
  not a real Valkey/S3 integration — neither exists in this repo yet (D-3,
  D-4). Each scanner self-tests against a small fixture directory of known
  good/bad literals first, so an empty result against `src/` is a trustworthy
  "nothing constructs a key yet", not indistinguishable from a broken scanner.
  **Disclosed limitation:** the scanner's regex only matches template
  literals that OPEN with an interpolation (`` `${...}` ``) — a literal that
  opens with plain text before its first interpolation (e.g.
  `` `answers:${workspaceId}:${promptId}` ``) is not inspected at all. This is
  fail-open for that shape, not fail-closed; widening the pattern safely
  (without false-positiving on unrelated template literals such as error
  messages) is left for STORY-030's real Valkey/S3 integration rather than
  done here.
- **`ISO-08`** fuzzes at the data-access boundary (`withTenantContext` + the
  query guard), not the HTTP boundary — no NestJS app exists yet (D-1;
  STORY-022 extends this).
- **`ISOLATION_TARGET`** (`local` default, `pooled`, `staging`) switches
  `global-setup.ts`'s behavior; `staging` requires
  `ISOLATION_STAGING_DATABASE_URL`, seeds nothing, refuses to proceed unless
  `_migrations.applied` proves this suite's own migration chain created the
  target database, and narrows to the read-only, fixture-independent subset
  (`registry.ts`'s `selectAssertionsForTarget`) — a **runner-side capability**
  only (D-6); nothing schedules a nightly run yet (gap G-9).
- **`pnpm test:isolation:breakers`** stayed in the always-run set rather than
  splitting to nightly-only (D-8) — measured at ~8s locally, comfortably
  inside the 5-minute budget (D-5) alongside `pnpm test:isolation` itself
  (~15-25s locally).
- `test/isolation/pgbouncer.spec.ts` (T23) runs the data-path property
  through a real pgBouncer at `default_pool_size=1` (reusing
  `test/support/pgbouncer-fixture.ts`), with an interleaved two-tenant
  sequence over the same pooled server connection.
- `test/isolation/widen.spec.ts` (T26) covers the edge cases outside the 16
  spec'd assertions: empty/malformed GUCs, `workspaces`' own `id`-scoped
  policy, a partition child queried by name, a table with `NULL` in every
  row's scope column, the empty-collection trap, and two concurrent contexts
  on two different clients.

## Known gaps against EPIC-00

This repo was bootstrapped directly for EPIC-01 without first completing
EPIC-00 (`STORY-002`'s shared CI workflows, `STORY-003`'s Terraform baseline).
That means:

- No GitHub Actions workflow runs these gates on push yet — they're currently
  run locally only.
- No Valkey in `docker-compose.yml` yet — it joins in STORY-030 (queues).
  pgBouncer joined in STORY-010 (this story).
- No branch protection or required checks on `origin`.

These are real gaps, not deferred by decision — pick them up before this repo
takes any contribution that isn't run through the local gates by hand.

## Disclosed gaps (STORY-010)

STORY-003 (the Terraform baseline) hasn't landed, so four things genuinely
can't be done locally. Each is disclosed here rather than faked:

- **G-1 — no PagerDuty for break-glass paging.** The `ON login` event trigger
  (`app.breakglass_login_alert()`, migration `0005`) emits a structured
  `RAISE LOG` line naming the role, database, backend pid, and timestamp when
  `session_user = 'nominara_breakglass'`. In production this is what a
  log-based alert would page on; locally it's just a log line. The
  "immutable audit record" half of AC-19 is **not** achieved by this trigger
  either: break-glass connections aren't workspace-scoped, and a dedicated
  table for them would break the 69-table census (STORY-009). No workaround
  was invented for this — it's an open gap for whoever wires the production
  logging pipeline.
- **G-2 — break-glass / runtime-role credential issuance via Secrets
  Manager.** Production issues every database credential from Secrets
  Manager with 30-day automatic rotation (`NFR-SEC-16`); there is no static
  password file at all. Locally, `docker/pgbouncer/userlist.txt` carries
  loudly-labeled LOCAL-DEVELOPMENT-ONLY plaintext passwords, and
  `pnpm db:dev-credentials` sets the matching passwords on the roles
  themselves, sourced from environment variables (never from a migration).
- **G-3 — `nominara_report`'s "replica only" routing.** There is one local
  Postgres instance, not a writer + replicas, so "replica only" can't be
  faked without lying about the topology. The enforceable part —
  `nominara_report` holding `SELECT` only — is fully implemented and tested;
  the routing constraint itself is a comment at the role's definition, not a
  local behavior.
- **G-4 — production object ownership by `nominara_owner`.** In production,
  `nominara_owner` (NOLOGIN) owns every object and runs every migration.
  Locally, migrations keep running as the docker-compose superuser
  (`nominara`) — `src/db/migrate-runner.ts` and `src/db/client.ts` were
  deliberately NOT changed to introduce a `SET ROLE nominara_owner` for this.
  Migration `0005` only applies `ALTER DEFAULT PRIVILEGES IN SCHEMA public`
  (no `FOR ROLE` clause), which covers this repo's actual migration model —
  every migration, local or production, runs as whichever single role
  connects to run it. A `GRANT nominara_owner TO CURRENT_USER` +
  `ALTER DEFAULT PRIVILEGES FOR ROLE nominara_owner` variant was attempted
  and removed after review: it fails outright in both production
  migration-identity models that could plausibly exist (self-grant when the
  migration session already **is** `nominara_owner`, or "permission denied
  to grant role" when it's a separate non-superuser migrator), and even
  where the grant succeeds, `ALTER DEFAULT PRIVILEGES FOR ROLE
  nominara_owner` requires *inherited* membership (`has_privs_of_role`),
  which every role here deliberately lacks (all `NOINHERIT`) — it only ever
  "worked" locally because the docker-compose superuser can do anything
  regardless. **Disclosed limitation:** until a future story (alongside
  real Terraform/production infrastructure) decides production's actual
  migration-identity model, objects created by a future migration running
  as a role other than the one that ran `0005` will need their own
  `ALTER DEFAULT PRIVILEGES FOR ROLE <that role>` added at that time — this
  is deferred, not silently dropped.

**Rollback of migration `0005` does not remove the six roles.** This is
deliberate, not a bug: `CREATE ROLE` is cluster-scoped (shared across every
database in the cluster, including drift-check's disposable shadow database
and every integration test's container), so a bare `DROP ROLE` could fail if
the role holds privileges granted by a different database's migration run.
A role stripped of every privilege is harmless residue, and the guarded
`CREATE ROLE` / converging `ALTER ROLE` pattern in `0005.up.sql` already
makes re-applying the migration idempotent regardless of whether the role
pre-existed.

## Disclosed gaps (STORY-011)

- **G-5 — `pnpm db:rls-check` runs locally only, not in CI.** AC 32 ("the
  generator runs in the migration pipeline and in CI") is satisfied here by
  the CLI itself plus `test/integration/rls-check.spec.ts` exercising it —
  this repo has no `.github/workflows/` at all yet (see "Known gaps against
  EPIC-00" above), so there is no pipeline for it to run IN today. Not a new
  gap this story introduces, the same disclosed absence as every prior
  story's gates.
- **G-6 — the query guard (`src/tenancy/query-guard.ts`) is a `pg` client
  wrapper using regex-based table extraction, not a real Drizzle
  `beforeQuery` hook.** `drizzle-orm` is a dependency of this repo but is
  used **nowhere** for actual queries — every migration, seed script, and
  integration test in this codebase issues SQL through the raw `pg` client
  directly. Confirmed by inspection: no `src/` file imports a Drizzle query
  builder. Wiring a real Drizzle hook (which would get exact table names
  from the query builder's own AST instead of a heuristic) is a standing
  observation for whichever future story actually introduces Drizzle-built
  queries, not something this story fixes retroactively.
- **G-7 — no logger, metric, or span exists anywhere in this story's code**
  (consistent with no observability stack existing yet in this repo — see
  "Known gaps against EPIC-00" above). `pnpm db:rls-check`'s CLI output and
  `app.breakglass_login_alert`'s `RAISE LOG` line (STORY-010) are the only
  structured signals this area of the codebase emits today; nothing from
  this story adds a `nominara_<subsystem>_<measure>` metric, a span, or a
  redacted log line. A standing observation for whichever future story wires
  the actual observability stack.
- **G-8 — `TENANT_TABLES` (`src/db/rls/tenant-tables.generated.ts`, fix pass
  item 11) covers every classifiable tenant BASE table by name, but
  structurally cannot cover partition CHILD table names** (e.g.
  `answer_captures_2026_08`), because those are computed dynamically at
  migration-apply time / by STORY-013's maintenance job
  (`src/workers/rollup/maintenance.ts`), not known ahead of time the way a
  base table's name is. A query naming a partition
  child directly, instead of its parent, is therefore invisible to
  `src/tenancy/query-guard.ts`'s heuristic — RLS itself (migration `0006` +
  `app.apply_tenant_rls`) is the actual security boundary and is not fooled
  by this gap; see that migration's own partition-hole test.

## Disclosed gaps (STORY-012)

- **G-9 — the isolation suite is blocking by policy, but nothing schedules
  it.** `pnpm test:isolation`/`:breakers` exist and pass locally; the "nightly
  against staging" half of the Definition of Done is a **capability**
  (`ISOLATION_TARGET=staging`, D-6) rather than a running schedule — no CI
  exists in this repo at all (gap G-5, unchanged), so there is no pipeline to
  schedule it IN yet. Not a new class of gap, the same disclosed absence as
  every prior story's gates; picked up once STORY-002/003 land.
- `ISO-13`/`ISO-14` remain scanner-based, not a real Valkey/S3 integration
  test (D-3/D-4) — real containers join in STORY-030 and whichever story
  introduces object-storage infra. The scanner's own correctness is
  self-tested against a fixture directory each run (see the Testing section
  above), so this is a scope limitation, not an untested one.
- `ISO-12`'s envelope encryption (`src/lib/crypto/envelope.ts`) uses a local,
  in-memory test DEK — no KMS integration exists (D-2). DEK rotation,
  `workspace_keys.wrapped_dek` unwrapping, and the 90-day rotation job are all
  future-story territory.
- `ISO-08`'s fuzz assertion runs at the data-access boundary
  (`withTenantContext` + the query guard), not the HTTP boundary — no NestJS
  app exists yet (D-1). STORY-022 is expected to extend it to assert
  403/404 at the actual route layer.
- `ISO-15`'s fixture-derived anonymity check runs an ad hoc aggregate query
  written by this assertion itself, not any real production benchmark/rollup
  aggregation path (none exists yet). It is a self-fulfilling property test
  of the anonymization *shape*, not evidence a real rollup job never leaks a
  tenant id — picked up once a real aggregation job exists to test instead.

## Disclosed gaps (STORY-013)

- **G-12 — one test reads the reference from OUTSIDE this repository.**
  `test/unit/realtime-event-catalog.spec.ts` checks the §11 event catalog
  against `../Nominara-Dev-Docs-main/references/api-specification.md` itself,
  because a list transcribed into the test would only prove the transcription
  matches itself. That snapshot has no git history and is not part of a fresh
  clone, so when CI exists it must be given the reference — a submodule, a
  vendored copy, or a fetch step. Which of those is a decision, not something
  the test can make. The failure names the problem rather than reading as a
  broken assertion.
- **G-10 — no cron registration or queue-scheduler wiring for the
  partition-maintenance/retention jobs.** `src/workers/rollup/maintenance.ts`
  and `src/workers/rollup/retention.ts` are plain, exported, dependency-free
  TS functions (no BullMQ, no Nest) — STORY-022 (Nest bootstrap) and
  STORY-030 (queue topology, `worker.ts`, `WORKER_GROUP` selection) are both
  still `Backlog`. Runnable today only via `pnpm db:maintenance:run` (the
  monthly job) and `pnpm db:maintenance:sweep` (the nightly retention
  cascade + orphan scan), same standing as STORY-011/012's CI-scheduling
  gaps (G-5/G-9). STORY-030's BullMQ processor for the `rollup` worker group
  imports these same exported functions unchanged as its handler body when
  it lands — no rewrite, no move, just a new caller.
- **The orphan scan pages by throwing (a non-zero exit from `pnpm
  db:maintenance:sweep`), not by log line — but no real PagerDuty/alerting
  integration exists anywhere in this repo yet**, the same disclosed absence
  as G-1 (`app.breakglass_login_alert`'s `RAISE LOG`). A thrown error is the
  strongest signal a script-only environment can produce today; wiring it to
  an actual on-call page is a future observability-stack story's job, not a
  new gap this story introduces.
- **`pnpm db:purge-check` runs locally only, not in CI**, same absence as
  G-5 ("no CI to run it in"). `NFR-CMP-05`'s "blocks the next release train"
  requires an actual pipeline to block, which this repo does not have yet.
- **Cold tablespace provisioning is environment-specific and deliberately
  not a migration.** `CREATE TABLESPACE` requires a physical filesystem
  location on the database server, which a portable migration cannot
  embed — `test/integration/partition-maintenance.spec.ts` provisions a real
  one inside the testcontainers fixture (`container.exec` + `CREATE
  TABLESPACE`); production provisioning is infrastructure's responsibility
  (Terraform/EBS volume — gap against EPIC-00, unchanged).
- **`resolveDetachDropCutoffDays` does not merge `workspaces
  .entitlement_overrides`** — only the plan's own `entitlements` JSON. A
  workspace-level override that shortens or lengthens raw-capture retention
  is invisible to the detach/drop safety calculation. Scoped simplification,
  disclosed rather than silently assumed correct; revisit if a future story
  actually exercises per-workspace overrides for this entitlement.
- **Workspace deletion request's "custom domains released" is a status
  flip (`custom_domains.status = 'disabled'`), not a real DNS/ACM
  release** — no DNS or certificate-authority integration exists in this
  repo yet.
- **`executeWorkspaceHardDelete`/`requestIndividualErasure` require a
  PRIVILEGED (table-owner-class) connection**, not the ordinary
  `nominara_worker` runtime role: both disable/re-enable `audit_log`'s and
  `credit_ledger`'s `reject_update_delete` trigger for the span of one
  controlled operation (`ALTER TABLE ... DISABLE/ENABLE TRIGGER` requires
  ownership). This is the resolution of STORY-007's own deferred "KNOWN
  OPEN CONSTRAINT" comment on `credit_ledger`'s cascade — not a new
  limitation, the one that comment always said a future story would need to
  resolve.
- **The cross-tenant DISCOVERY functions (`runNightlySweep`,
  `runDailyPurgeCycle`, `scanForOrphans`/`runOrphanScan`,
  `resolveWorkspaceRetention`, `collectComplianceExport`) also require a
  privileged connection**, for a separate reason from the DDL-ownership one
  above: each issues a SELECT spanning every workspace with NO tenant
  context set, and `workspaces`/every fact table carry FORCE ROW LEVEL
  SECURITY (migration 0006) — under `nominara_worker` (no BYPASSRLS, not the
  table owner), that SELECT is filtered to zero rows, not merely "unsafe".
  Proven, not just claimed, by a dedicated test in
  `test/integration/retention-cascade.spec.ts` connecting as
  `nominara_worker` and asserting it sees nothing where the privileged
  connection sees real rows.
- **`0007_partition_maintenance_and_retention.down.sql`'s `DELETE FROM
  users` (the seeded system actor) has a known rollback limitation.** It
  fails with a foreign-key violation if any
  `credit_ledger.actor_id`/`milestones.created_by`/`task_events.actor_id`
  row has already been reassigned to it by a real
  `requestIndividualErasure` run. A fresh/empty shadow database (`pnpm
  migrate:check`) never exercises that path, so it passes there every time —
  this is a landmine only in an environment that has processed at least one
  individual erasure. Not fixed (no safe general "reassign back to the
  original, now-discarded actor" exists); disclosed here rather than left
  silent.
