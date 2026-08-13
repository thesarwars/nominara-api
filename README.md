# nominara-api

Domain model, database, every external call, and all workers for Nominara. See
`Nominara-Dev-Docs-main/references/project-structure.md` for the full repo
layout and boundary rationale, and `Nominara-Dev-Docs-main/README.md` §3 for
the settled architecture decisions (KAD-01…18) this repo must not contradict
without an ADR.

## Local setup

```bash
pnpm install
docker compose up -d          # Postgres 18 + pgvector on localhost:5432, pgBouncer on localhost:6432
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

## Testing

```bash
pnpm test:unit          # pure functions — no network, clock, or DB
pnpm test:integration   # real Postgres via testcontainers, pgvector/pgvector:pg18
```

No test suite depends on a live external vendor. See
`references/testing-strategy.md` for the full pyramid and which gates block a
merge.

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
