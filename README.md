# nominara-api

Domain model, database, every external call, and all workers for Nominara. See
`Nominara-Dev-Docs-main/references/project-structure.md` for the full repo
layout and boundary rationale, and `Nominara-Dev-Docs-main/README.md` §3 for
the settled architecture decisions (KAD-01…18) this repo must not contradict
without an ADR.

## Local setup

```bash
pnpm install
docker compose up -d          # Postgres 18 + pgvector on localhost:5432
cp .env.example .env
pnpm db:migrate
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
- No pgBouncer or Valkey in `docker-compose.yml` yet — they join in STORY-010.
- No branch protection or required checks on `origin`.

These are real gaps, not deferred by decision — pick them up before this repo
takes any contribution that isn't run through the local gates by hand.
