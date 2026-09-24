# Nominara — Development Execution Plan

**Companion to [`README.md`](./README.md).** The README says what v1 *is* — the epics, the stories, the settled decisions, the dependency map. This document says what we **build next**, in **what order**, in **which repository**, and through **which agent**. Where the two disagree about scope, the README wins; where they disagree about *sequence*, this file wins, because the README's dependency map offers several legal orders and this one picks a single path and defends it.

**Written:** 2026-09-02 · **Measured against:** `nominara-api` @ `f027660`, `nominara-app` @ `d7fdd07`
**Horizon:** the P2 exit criterion — *a project created from a URL alone reaches a rendered, scored answer* — reached in six slices, each of which ends with a working screen in front of you.

---

## 1. How to use this document

Read §2 first. **The `**Status:**` line in a story file is not evidence** — eighteen stories read `Backlog` against demonstrably shipped code, and two read `Done` against code that cannot execute. §2 is the measured state and it is what the sequencing in §6 is built on.

Then read §3 and §4. §3 names the six gaps that stop the product working end to end; none of them was owned by a story when this plan was written, and five of the six are invisible from the story list. `G6` is closed; the rest are not. §4 says what we are deliberately not building yet and what that decision actually costs.

§5 is the agentic workflow — which agent runs which step, and what a brief must contain. §6 is the plan itself. §7–§9 are the cross-repo protocol, the gates, and the definition of done. §11 is the short list of decisions that need a human.

**Every story, epic and reference is a live link back to its own file** — click through, read the source, come back. This document never restates what those files say; it only decides the order.

**This document is a plan, not a specification.** It cites requirement IDs and story IDs; it never restates a requirement. If you find a number here that also lives in `references/`, the reference is authoritative and this file has a bug.

---

## 2. Ground truth — measured, not assumed

### 2.1 `nominara-api` @ `38f7113` (branch `main`, working tree clean)

Re-measured 2026-09-18 after PR #73: lint, typecheck, `contracts:check`, `db:drift-check`, `db:rls-check` and `db:schema-check` all clean. **2,343 unit tests / 207 files**, **1,362 integration / 108 files**, **51 isolation assertions + 23 breakers** (every assertion still fails against its own breaker — ISO-00 holds).

Structure: **24 migrations**, 20 modules, **27 controllers carrying 51 routes between them**. The route count has roughly doubled since this section was first written — Slice 5 added the wallet, the ledger, the members and invitations reads, and `GET /v1/me/oauth`.

| Epic | Shipped | Partial | Absent |
|---|---|---|---|
| **[EPIC-01](./epics/EPIC-01-data-layer-and-isolation.md)** Data & isolation | [006](./stories/data/STORY-006-extensions-conventions-migration-tooling.md), [007](./stories/data/STORY-007-ddl-identity-tenancy-billing.md), [008](./stories/data/STORY-008-ddl-projects-prompts-captures.md), [009](./stories/data/STORY-009-ddl-rollups-aux-tasks-geo-tools.md), [010](./stories/data/STORY-010-database-roles-and-pgbouncer.md), [011](./stories/data/STORY-011-generated-rls-and-tenant-context.md), [012](./stories/data/STORY-012-isolation-verification-suite.md), [013](./stories/data/STORY-013-partition-and-vacuum-maintenance.md) | — | — |
| **[EPIC-02](./epics/EPIC-02-identity-rbac-audit.md)** Identity, RBAC, audit | [014](./stories/identity/STORY-014-passkey-webauthn.md), [015](./stories/identity/STORY-015-oauth-pkce-providers.md), [016](./stories/identity/STORY-016-email-otp.md), [017](./stories/identity/STORY-017-session-model-and-refresh-rotation.md), [018](./stories/identity/STORY-018-workspace-guard-and-revocation.md), [019](./stories/identity/STORY-019-rbac-guard-and-step-up.md), [020](./stories/identity/STORY-020-hash-chained-audit-log.md), [021](./stories/identity/STORY-021-workspaces-members-invitations.md) | — | — |
| **[EPIC-03](./epics/EPIC-03-api-platform-and-contracts.md)** API platform | [022](./stories/api/STORY-022-nest-bootstrap-and-module-skeleton.md) | [023](./stories/api/STORY-023-zod-openapi-client-pipeline.md), [024](./stories/api/STORY-024-error-taxonomy-pagination-etag.md), [025](./stories/api/STORY-025-idempotency-and-rate-limiting.md), [026](./stories/api/STORY-026-realtime-gateway-and-sse.md) | — |
| **[EPIC-04](./epics/EPIC-04-capture-and-tracking-engine.md)** Capture | [027](./stories/capture/STORY-027-capture-adapter-contract-and-registry.md), [030](./stories/capture/STORY-030-queue-topology-and-job-signing.md), [031](./stories/capture/STORY-031-rate-limiting-circuit-breaking-engine-health.md), [032](./stories/capture/STORY-032-run-planning-and-cache-suppression.md), [033](./stories/capture/STORY-033-scheduler-cadence-windows-jitter.md) | — | [028](./stories/capture/STORY-028-api-engine-adapters.md), [029](./stories/capture/STORY-029-licensed-serp-google-adapters.md), **[034](./stories/capture/STORY-034-run-lifecycle-api-and-progress.md)** |
| **[EPIC-10](./epics/EPIC-10-entitlements-credits-billing.md)** Billing | [069](./stories/billing/STORY-069-plans-seed-and-entitlement-resolution.md), [070](./stories/billing/STORY-070-quota-guard-tier-caps.md) | — | [071](./stories/billing/STORY-071-daily-cap-guard.md), [072](./stories/billing/STORY-072-credit-wallet-reserve-commit-release.md), [073](./stories/billing/STORY-073-credit-ledger-and-reconciliation.md), [074](./stories/billing/STORY-074-estimates-and-confirmed-credits.md), [075](./stories/billing/STORY-075-stripe-subscriptions-and-webhooks.md), [076](./stories/billing/STORY-076-credit-packs-purchases-autotopup-addons.md), [077](./stories/billing/STORY-077-downgrade-and-retention-policy.md) |
| **Defect stories** | [119](./stories/api/STORY-119-taxonomy-code-for-the-unmodelled-failure.md), [120](./stories/api/STORY-120-readiness-can-never-succeed.md), [121](./stories/capture/STORY-121-queue-connection-conflates-worker-and-reader.md) | [117](./stories/api/STORY-117-cursor-paginate-shipped-list-endpoints.md) | **[118](./stories/data/STORY-118-install-the-tenant-query-guard.md)** |
| **[EPIC-05](./epics/EPIC-05-parser-and-scoring-core.md), [06](./epics/EPIC-06-projects-prompts-onboarding.md), [07](./epics/EPIC-07-aux-and-source-index.md), [08](./epics/EPIC-08-displacement-and-geo-insights.md), [09](./epics/EPIC-09-action-plan-growth-map-alerts.md), [11](./epics/EPIC-11-tools-and-command-surfaces.md), [15](./epics/EPIC-15-hardening-accuracy-launch.md), 16** | — | — | **all of them** |

The four `Partial` rows in [EPIC-03](./epics/EPIC-03-api-platform-and-contracts.md) each carry a named, recorded gap rather than unfinished work: [STORY-023](./stories/api/STORY-023-zod-openapi-client-pipeline.md)'s automated client publish (needs a registry and OIDC that live in `nominara-infra`), [STORY-024](./stories/api/STORY-024-error-taxonomy-pagination-etag.md)'s request-id/trace-id join (needs a tracing backend), [STORY-025](./stories/api/STORY-025-idempotency-and-rate-limiting.md)'s rate-limit buckets being compiled-in constants rather than data, and [STORY-026](./stories/api/STORY-026-realtime-gateway-and-sse.md)'s per-event invalidation keys and project-room delivery. **None of them blocks the path in §6.**

### 2.2 `nominara-app` @ `7b61241` — further along than the story list suggests, and thinner than it looks

Re-measured 2026-09-18 after PR #34: **510 files**, **1,391 unit tests / 185 files**, **159 Playwright specs across 24 files**, `pnpm gate` exit 0. STORY-086 through 091 have landed, and [STORY-096](./stories/frontend/STORY-096-settings-and-billing-surfaces.md) is three-quarters through.

**Real and substantial:** the App Router shell across both build targets, Zustand stores, URL-authoritative filter state, TanStack Query keys with a per-surface staleness table and an event→invalidation map, the realtime socket client with workspace-switch cache reset, the design-system token layer, the full four-step onboarding flow, and the Command Center. **185 unit test files, 24 Playwright e2e spec files**, components each with a co-located test, and **seven custom ESLint rules** that enforce the honesty and safety rules mechanically — `no-raw-design-values`, `no-duplicate-metric-copy`, `no-causal-language`, `no-direct-chart-import`, `no-direct-invalidate-queries`, `no-server-data-in-store`, and STORY-091's `no-engine-markup`.

**Route stubs awaiting their story:** the remaining project sections, and **three** of the eight settings pages — `trust`, `integrations` and `whitelabel`, each blocked on a route or a story that does not exist (see Slice 5). `workspace`, `team`, `billing`, `plan` and `security` are now real screens. Each is an 8-to-9-line placeholder that exists so the shell has a route to mount — exactly what [STORY-086](./stories/frontend/STORY-086-app-shell-and-state.md) asked for, and exactly what [STORY-090](./stories/frontend/STORY-090-project-overview.md)…096 will fill.

**How much of it is actually live is the number that matters:** `lib/api/client.ts` is the only module that imports `@nominara/client`, and **`getApiClient()` has no call site in production code.** Real wire calls exist for precisely two things, both bypassing the generated client — the auth cookie-exchange proxy (`app/api/auth/[...auth]/`, hitting the shipped `/v1/auth/*`) and three workspace Server Actions (`createWorkspace`, `updateWorkspace`, `createInvitation`, hitting the shipped `/v1/workspaces*`). Both land on [STORY-014](./stories/identity/STORY-014-passkey-webauthn.md)…021, which are shipped, so **those two paths are genuinely integrated.** Everything else — the entire Command Center, discovery, run progress, cost and pricing, action items, health and wallet — is served from **17 fixture modules, 1,522 lines**.

That is exactly what [EPIC-12](./epics/EPIC-12-frontend-application.md) sanctions — *"building against fixture data first and live endpoints as they appear"* — and the repo already tracks the debt in a **"Backend integration gaps" table in its own README**, naming the upstream story each fixture stands in for. **Keep using that table; it is the mechanism §10 P-01 depends on.**

**It does not currently type-check against `api` HEAD.** Three errors and five failing tests, all from one gap in the realtime event map — pre-existing drift, not a regression, and fully diagnosed in §7.1a. Everything else above is green.

**One correction to a common assumption:** the portal build target exists mechanically (`portal/r/[token]/`, `stage-portal-root.mjs`, `check-portal-readonly.ts`, an a11y sweep and a theme test), but `portal/r/[token]/page.tsx` is an 8-line stub. **[STORY-099](./stories/agency/STORY-099-portal-build-target.md) is not partly done in any meaningful sense** — the password gate, scope derivation, read-only content, caching, and the expired/revoked/exhausted states are all absent, and its three-layer enforcement has only the first layer, unwired (§8).

### 2.3 The other two repositories

- **`nominara-web`** — the repository exists and is **empty** (zero branches). [EPIC-14](./epics/EPIC-14-marketing-site.md) has not started.
- **`nominara-infra`** — **does not exist**. [STORY-003](./stories/preflight/STORY-003-terraform-baseline.md) has not started, and with it the object storage that KAD-08 assumes, the secrets manager [STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md) requires, and the registry [STORY-023](./stories/api/STORY-023-zod-openapi-client-pipeline.md)'s AC6 needs.

### 2.4 The story statuses are stale, and this is now a known hazard

Eighteen stories in `stories/` read `Backlog` against shipped code. Two — [STORY-032](./stories/capture/STORY-032-run-planning-and-cache-suppression.md) and [STORY-033](./stories/capture/STORY-033-scheduler-cadence-windows-jitter.md) — read `Done` against code that **cannot execute in production** for the reasons in §3. Until someone reconciles the files, **treat the code as the source of truth for status and the story as the source of truth for scope.** Reconciling them is task `T0e` in §6.

---

## 3. The structural gaps

None of these was a story when this plan was written. Five are invisible from the story list — `G6` was found only by doing `T0a` and reading the specification back against the code. Together they are the reason the product does not run end to end, and **every one of them is cheap relative to what it unblocks.**

`G6` is closed by [STORY-122](./stories/data/STORY-122-drizzle-schema-and-service.md); `G1`–`G5` are open.

### G1 · No queue handler is wired — the entire async spine is inert · **seam built by [STORY-124](./stories/capture/STORY-124-queue-handler-registry.md), handlers still absent**

`src/worker.ts` threw `queue "…": no handler wired yet — business logic lands in a later story` for **every one of the 21 queues**, and there was nowhere to put a handler that would do otherwise. The topology, signing, idempotency, dead-letter routing, worker factory and queue-group selection from [STORY-030](./stories/capture/STORY-030-queue-topology-and-job-signing.md) are all real and tested. Nothing processes a job — that part is still true, and stays true until the stories that produce work land their handlers.

This is why [STORY-032](./stories/capture/STORY-032-run-planning-and-cache-suppression.md) and [STORY-033](./stories/capture/STORY-033-scheduler-cadence-windows-jitter.md) can be honestly `Done` and the product still capture nothing: planning enqueues, the scheduler enqueues, and the worker throws.

**[STORY-124](./stories/capture/STORY-124-queue-handler-registry.md) (`T0d`) built the seam, and deliberately no handlers.** A queue with an entry in `src/lib/queue/handlers.ts` autoruns and processes on a pooled client; one without stays inert and never pulls a job — which is the safer default, because a worker that pulled a job it could not process would fail it into the dead-letter queue and turn "not built yet" into "tried and failed". **Every slice in §6 that produces work still lands its handler with it**, now as one typed line rather than a change to the bootstrap.

### G2 · The engine catalog is unseeded, and no story owns the seed

There is no `INSERT INTO engines` anywhere in `src/`. `engines.cadence_by_plan` defaults to `{}`, `resolveDueEngines` fails closed by design, and so **the scheduler covers zero engines for every project.** The data — ten engines and their per-plan cadence — is specified in [`plans-and-entitlements.md`](./references/plans-and-entitlements.md) §11. This needs a story and a sign-off, not a guess. See §12, `NEW-A`.

### G3 · Nothing computes an embedding

`prompt_embedding` and the `vector` columns exist and are indexed. L2 semantic suppression reads them, L3 reads them, `embed_tokens` is a metered metric. **No embedding provider client exists** — no HTTP call to any embedding API anywhere in `src/`. Until one does, L2 suppression can never fire, topic clustering ([STORY-047](./stories/projects/STORY-047-topic-clustering.md)) cannot run, and every [EPIC-08](./epics/EPIC-08-displacement-and-geo-insights.md) centroid is unreachable. **`embed.batch` and `topic.cluster` are declared in the live topology with no handler registered for either, and `worker-embed` is deployed with nothing to run.** See §12, `NEW-B` — **drafted as [STORY-133](./stories/capture/STORY-133-embedding-client.md)**.

### G9 · The prompt list and manual creation are unowned

`api-specification.md` §3 documents five prompt routes. Three shipped with [STORY-045](./stories/projects/STORY-045-prompt-generation-engine.md) and [STORY-046](./stories/projects/STORY-046-prompt-lifecycle-and-activation.md); **`GET /projects/{id}/prompts` and `POST /projects/{id}/prompts` are built by nobody.** So generation writes fifteen rows, activation turns them on, and **there is no way to read them back** — a customer who finishes onboarding has fifteen tracked prompts and no surface that can list one. "Add manually", the only 0-credit way to add a prompt, has no endpoint at all.

The same inversion as `G7` and `G8`, for the third time: [STORY-091](./stories/frontend/STORY-091-prompts-matrix-and-answer-drawer.md) is the consumer and names five upstreams, none of which is the endpoint it reads every row from. **Drafted as [STORY-134](./stories/projects/STORY-134-list-and-create-prompts.md).**

### G4 · There is no CI in either repository

`api/.github` is absent. `nominara-app` has no workflow either. **Every gate in [`testing-strategy.md`](./references/testing-strategy.md) §10 — including the four that "cannot be talked past" — is run by hand today.** The gates themselves are real and they pass; nothing enforces that they were run. This is [STORY-002](./stories/preflight/STORY-002-repositories-and-shared-ci.md)'s job and [STORY-002](./stories/preflight/STORY-002-repositories-and-shared-ci.md) has not started.

### G5 · The product API surface does not exist yet

27 routes across 21 controllers, and 14 of those controllers are empty scaffolds. There is no `/projects`, no `/prompts`, no `/runs`, no `/results`, no `/matrix`, no wallet. The capture machinery is built and has no HTTP surface; the frontend has four finished sections and nothing to call.

**This is the headline: the frontend is four stories ahead of a backend that cannot serve it.** Closing G5 is what §6 is mostly about.

### G7 · The guarded fetcher is referenced by seven stories and built by none — **closed by [STORY-131](./stories/projects/STORY-131-guarded-fetcher.md)**

`UnsafeTargetError` is defined in `src/api/errors/domain-errors.ts:192` and mapped to `422`, and **nothing throws it**. There is no SSRF guard and no registrable-domain normaliser anywhere in `src/`. [STORY-043](./stories/projects/STORY-043-url-only-project-creation.md), [STORY-048](./stories/projects/STORY-048-domain-verification.md), [STORY-049](./stories/aux/STORY-049-crawl-pipeline-and-ssrf-guard.md), [STORY-050](./stories/aux/STORY-050-aux-document-extraction.md), [STORY-058](./stories/geo/STORY-058-corpus-passages-and-centroid.md), [STORY-081](./stories/tools/STORY-081-competitor-finder.md) and [STORY-082](./stories/tools/STORY-082-aux-audit-tool.md) all reference "the guarded fetcher" as an existing thing.

It is nominally [STORY-049](./stories/aux/STORY-049-crawl-pipeline-and-ssrf-guard.md)'s — but that story is in **no slice of this plan**, sits in EPIC-07, and **depends on [STORY-048](./stories/projects/STORY-048-domain-verification.md)**, which is scheduled *after* [STORY-043](./stories/projects/STORY-043-url-only-project-creation.md) inside Slice 1. The first story needing the fetcher is upstream of the one that would have built it. Found while starting Slice 1; extracted into [STORY-131](./stories/projects/STORY-131-guarded-fetcher.md) (0.75d) by decision on 2026-09-04, and STORY-049 keeps the crawl pipeline.

### G6 · The data-access architecture the specification describes was never built — **closed by [STORY-122](./stories/data/STORY-122-drizzle-schema-and-service.md)**

Found while doing `T0a`, and not visible from the story list at all.

[`project-structure.md`](./references/project-structure.md) §2 names `src/db/schema/` ("Drizzle pgTable definitions, one file per subsystem") and `src/db/drizzle.service.ts`. [`coding-standards.md`](./references/coding-standards.md) and `NFR-ARCH-09` say services call Drizzle **directly**, and that a repository layer between the two needs an ADR whose default answer is no. `NFR-ARCH-03` names a Drizzle `beforeQuery` hook. `drizzle.config.ts` sits in the repository pointing at `./src/db/schema/*.ts`, and its own comment says "STORY-007 adds the first table definitions".

**None of it existed.** `drizzle-orm` and `drizzle-kit` were declared dependencies with **zero imports anywhere in `src/`**. [STORY-007](./stories/data/STORY-007-ddl-identity-tenancy-billing.md), [STORY-008](./stories/data/STORY-008-ddl-projects-prompts-captures.md) and [STORY-009](./stories/data/STORY-009-ddl-rollups-aux-tasks-geo-tools.md) shipped 77 tables of hand-authored SQL and none of them mentions a schema file. All 213 `.query(` call sites in `src/` issue raw SQL.

This was not a defect in what shipped — the raw SQL works and is tested. It meant every story that followed was adding call sites to an architecture the specification does not describe, and the debt compounded fastest at the start of §6 rather than the end.

**Two things were settled to close it.** Drizzle does *not* own migrations — `drizzle-kit` models no extensions, functions, triggers, roles, grants, RLS policies or partitions, which is migrations 0001, 0005, 0006 and 0007 in their entirety; migrations stay hand-authored SQL and the schema files describe what they produced. And the ~101 raw-SQL call sites in shipped services were **not** rewritten: they move when a story touches them anyway, never as a bulk rewrite of working code beside two dangerous areas. The other ~112 stay raw permanently — partition and retention DDL, the migration tooling itself, and `tenant-context.ts`'s `BEGIN`/`set_config`/`COMMIT`, which must stay literal.

---

## 4. What we defer, and what it actually costs

**The rule, per the standing decision:** a story blocked only on [EPIC-00](./epics/EPIC-00-preflight-and-bootstrap.md) is deferred, not cancelled. We build everything the block does not reach.

**Directly blocked on [STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md)** (vendor accounts, credentials, six live smoke calls — 1.0d of work plus an external wait that can run for weeks):

| Story | What it is |
|---|---|
| [STORY-028](./stories/capture/STORY-028-api-engine-adapters.md) | The four vendor-API adapters — Perplexity, ChatGPT, Gemini, Claude |
| [STORY-029](./stories/capture/STORY-029-licensed-serp-google-adapters.md) | The two licensed-SERP Google adapters |
| [STORY-075](./stories/billing/STORY-075-stripe-subscriptions-and-webhooks.md) | Stripe subscriptions and webhooks |

**Transitively blocked, and this is the part worth saying out loud:** deferring [STORY-075](./stories/billing/STORY-075-stripe-subscriptions-and-webhooks.md) also defers **[STORY-076](./stories/billing/STORY-076-credit-packs-purchases-autotopup-addons.md)** (packs, purchases, auto-top-up, add-ons) and **[STORY-077](./stories/billing/STORY-077-downgrade-and-retention-policy.md)** (downgrade, retention, enterprise identity), because both name it upstream. Deferring [STORY-028](./stories/capture/STORY-028-api-engine-adapters.md) and [STORY-029](./stories/capture/STORY-029-licensed-serp-google-adapters.md) also defers **[STORY-106](./stories/launch/STORY-106-golden-set-corpus-and-fixtures.md)** (golden-set corpus — it needs real captures) and therefore **[STORY-107](./stories/launch/STORY-107-accuracy-gates-in-ci.md)** (accuracy gates in CI). So the true deferral set is **seven stories, not three**: [STORY-028](./stories/capture/STORY-028-api-engine-adapters.md), [STORY-029](./stories/capture/STORY-029-licensed-serp-google-adapters.md), [STORY-075](./stories/billing/STORY-075-stripe-subscriptions-and-webhooks.md), [STORY-076](./stories/billing/STORY-076-credit-packs-purchases-autotopup-addons.md), [STORY-077](./stories/billing/STORY-077-downgrade-and-retention-policy.md), [STORY-106](./stories/launch/STORY-106-golden-set-corpus-and-fixtures.md) and [STORY-107](./stories/launch/STORY-107-accuracy-gates-in-ci.md).

**What the deferral does *not* cost, and this is the load-bearing observation in this plan:**

> **[STORY-027](./stories/capture/STORY-027-capture-adapter-contract-and-registry.md) shipped fixture adapters for all six engines.** The capture pipeline can be driven end to end — planned, dispatched, captured, parsed, scored, rolled up and rendered — **without a single vendor account.** The deferred adapters swap in behind an interface that already exists and is already tested.

So [STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md) blocks *live* capture. It does not block the loop, the parser, the scoring, the API surface, or the frontend. **We build the entire product on fixtures and slot the real adapters in when the accounts land.**

**Also deferred, on [STORY-003](./stories/preflight/STORY-003-terraform-baseline.md) (`nominara-infra`, which does not exist):** [STORY-034](./stories/capture/STORY-034-run-lifecycle-api-and-progress.md)'s AC7 (raw-capture pre-signed URLs need object storage), [STORY-023](./stories/api/STORY-023-zod-openapi-client-pipeline.md)'s AC6 (client publish needs a registry), [STORY-005](./stories/preflight/STORY-005-observability-baseline.md), and [STORY-101](./stories/agency/STORY-101-custom-domains.md). Each is a named AC inside an otherwise buildable story — build the story, tick the rest, record the gap.

---

## 5. The agentic workflow

### 5.1 The pipeline

Six steps, of which **step 2 is deliberately a human**.

| # | Step | Who | Output |
|---|---|---|---|
| 1 | Compile the brief | `/compile-prompt <STORY-NNN>` | A work brief: the story, the reference sections it cites, the repo state that matters |
| 2 | **Sign off the brief** | **you** | Scope confirmed before a single planning token is spent. There is no agent here and there should not be |
| 3 | Plan | `planner-agent` | An ordered execution plan: tasks, files, RED-before-GREEN pairs, commit shape |
| 4 | Validate the plan | `system-architect` | Required revisions, or a sign-off against KAD-01…18 and the spec |
| 5 | Execute | `coordinator-engineer` | Delegates to executors, runs independent tasks in parallel, drives to green |
| 6 | Verify | `qa-reviewer` | Pass/fail against the acceptance criteria and the definition of done |

**Do not skip step 4.** [`development-workflow.md`](./references/development-workflow.md) §6 names the six things an agent may not do without a human decision — new dependency, new pattern, new vocabulary, unnamed schema change, a file outside the story's Technical Notes, and *relaxing a threshold to make a test pass*. The architect is where five of those six get caught before code exists.

### 5.2 Routing — which agent gets which work

| Agent | Gets | Never gets |
|---|---|---|
| `api-dev` | Everything in `api/` — contracts, controllers, services, migrations, RLS, guards, workers, vitest | Frontend code, or a decision the architect has not signed off |
| `frontend-dev` | Everything in `nominara-app` and later `nominara-web` — screens, stores, query wiring, tokens, charts, Playwright | Backend code; inventing an API shape the contract does not carry |
| `code-reviewer` | Every diff, before it is called done | Reviewing its own prior output |
| `dangerous-area-auditor` | **Mandatory** on RLS/tenant context, the credit ledger and wallet, the parser, and the scoring functions | Anything it authored — its independence is the point |
| `Explore` | Broad read-only sweeps across many files where only the conclusion is wanted | Writing anything |

**The four dangerous areas are not advisory.** In the plan below, Slice 4 (parser and scoring) and Slice 5 (wallet and ledger) are *entirely* dangerous-area work. Every story in them takes a second-engineer review by an agent that did not author the change, and [`development-workflow.md`](./references/development-workflow.md) §4 does not permit waiving it.

### 5.3 The briefing contract

From [`development-workflow.md`](./references/development-workflow.md) §6 — **do**: hand over the story file plus the reference sections it cites; name the exact files from Technical Notes; ask for failing tests first and *read them before implementation*; point at an existing module as the pattern; require each change to state which acceptance criterion it satisfies. **Do not**: paraphrase the requirement in chat, let the agent choose where code lives, ask for tests and implementation in one turn, say "follow best practices", or accept a diff with no mapping back to the story.

A paraphrase is how a specification forks. Hand over the file.

### 5.4 Two conventions this repository has settled that are worth restating

- **One branch per story, several commits on it** — not a branch per commit. Branch `story-043-url-only-project-creation`, commits `STORY-043: <imperative>`.
- **No `Co-Authored-By` trailer and no AI attribution in any commit message.** Nothing is pushed, and no pull request is opened, unless it is explicitly asked for.

---

## 6. The plan — six slices, each one ending in something you can look at

**The ordering principle, and it is the one that shapes everything below.** We are not running a backend lane and a frontend lane side by side. We finish a piece of API, then **immediately build the screen that renders it**, and look at it. The frontend follows the backend by one feature, never by four.

That has a consequence worth stating plainly, because it reverses the first draft of this plan and it reverses [EPIC-12](./epics/EPIC-12-frontend-application.md)'s own default: **we stop building frontend screens against fixtures ahead of their endpoints.** [EPIC-12](./epics/EPIC-12-frontend-application.md) sanctions fixture-first work, and it is the right call for a team where a frontend engineer would otherwise idle. It is the wrong call here, because a fixture screen shows you nothing about whether the backend works — which is the entire reason for wiring it up early. [STORY-092](./stories/frontend/STORY-092-competitors-and-displacement.md), [STORY-093](./stories/frontend/STORY-093-sources-and-geo-insights.md), [STORY-094](./stories/frontend/STORY-094-aux-health-and-action-plan.md) and [STORY-095](./stories/frontend/STORY-095-tools-surfaces-and-history.md) are therefore **not** scheduled early; they wait for [EPIC-07](./epics/EPIC-07-aux-and-source-index.md), [EPIC-08](./epics/EPIC-08-displacement-and-geo-insights.md), [EPIC-09](./epics/EPIC-09-action-plan-growth-map-alerts.md) and [EPIC-11](./epics/EPIC-11-tools-and-command-surfaces.md).

The cost of that choice is honest: wall-clock is roughly the **sum** of the two streams rather than the longer of them. What you buy is that at the end of every slice there is a working screen in front of you, driven by real data, and a defect surfaces the week it is written instead of the month it is integrated.

**Each slice below states what becomes visible.** If a slice cannot name that, it is plumbing and says so.

Estimates are the story files' own, plus a named figure for the wiring. **Roughly 48 days of work** across all six.

---

### Slice 0 — the spine · ~7.75d · almost nothing becomes visible, and that is the point

Pure plumbing. Everything after this depends on it, and almost none of it renders.

**`T0i` is the exception, and it was not in the first draft.** `nominara-api` serves 19 routes and the app called nine; four of the other ten had a screen already built and fed by fixtures, so wiring them was hours rather than days — and one of them, the workspace switch, was not merely unwired but *wrong*: the client moved tenants while the server's token stayed pinned to the old one. Six more (members, roles, passkeys, OAuth link/unlink, invitation accept) are **not** in Slice 0: their screens are eight-line scaffolds, and building them is [STORY-096](./stories/frontend/STORY-096-settings-and-billing-surfaces.md) in Slice 5.

| Task | What | Est. | Status |
|---|---|---|---|
| **T0a** | [STORY-118](./stories/data/STORY-118-install-the-tenant-query-guard.md) — install the tenant query guard on the pool | 1.0d | **done** |
| **T0h** | [STORY-122](./stories/data/STORY-122-drizzle-schema-and-service.md) — the Drizzle schema layer (G6) | 3.0d | **done** |
| **T0b** | [STORY-130](./stories/capture/STORY-130-seed-the-engine-catalog.md) (`NEW-A`) — seed the engine catalog (§12) | 0.5d | **drafted — needs sign-off** |
| **T0d** | [STORY-124](./stories/capture/STORY-124-queue-handler-registry.md) — wire the queue-handler registry | 0.75d | **done** |
| **T0e** | Reconcile the 20 stale story statuses | 0.25d | |
| **T0f** | Wire the app's three unenforced checks into `gate` (§8) | 0.25d | **done** |
| **T0g** | [STORY-123](./stories/frontend/STORY-123-restore-the-app-to-contract.md) — restore the app to contract with the API (§7.1a) | 0.5d | **done** |
| **T0i** | [STORY-125](./stories/frontend/STORY-125-connect-the-finished-workspace-endpoints.md) — connect the workspace endpoints that already exist | 1.5d | **done** |

`T0a` is dangerous-area work and takes an auditor. `T0b` needs your sign-off before a migration exists. **`T0g` came before any frontend task in any slice** — the app did not type-check, so nothing downstream of it could be trusted green. It is done, and `pnpm gate` is green in `client/`.

**`T0h` was not in the first draft of this plan** — it is `G6` below, found while doing `T0a`. It lands here rather than later because Slices 1–5 add roughly forty services, and every one written before it is a call site against an architecture the specification does not describe. It takes [STORY-118](./stories/data/STORY-118-install-the-tenant-query-guard.md) as its base: the guard sits beneath the query builder, which is what lets Drizzle inherit it instead of needing a second hook.

**Exit:** isolation suite green with the guard installed; `pnpm db:schema-check` green; the scheduler resolves a non-empty engine set; `pnpm gate` green in `client/`.

---

### Slice 1 — *"I paste a URL and a real project appears"* · ~6.25d

**Backend first** — all four merged 2026-09-04.

| Story | What | Est. | Status |
|---|---|---|---|
| [STORY-131](./stories/projects/STORY-131-guarded-fetcher.md) | **The guarded fetcher + registrable-domain normalisation (G7)** — extracted from STORY-049; STORY-043 AC7 cannot be met without it | 0.75d | **done** |
| [STORY-043](./stories/projects/STORY-043-url-only-project-creation.md) | URL-only project creation + the discovery pipeline | 2.5d | **done** — three of §2.1's eight derivations blocked on absent inputs, named in the story |
| [STORY-044](./stories/projects/STORY-044-discovery-review-and-confirm.md) | Discovery review, confidence surfacing, confirm/override | 1.0d | **done** — AC9's trigger built, inert until a rollup handler exists |
| [STORY-048](./stories/projects/STORY-048-domain-verification.md) | Domain verification — DNS TXT, well-known file, meta tag | 1.0d | **done** — AC7's schedule and AC6's excluded-rule naming deferred to their owners |

The `crawl.discover` queue handler landed with [STORY-043](./stories/projects/STORY-043-url-only-project-creation.md) — `T0d`'s registry is proven on a real job, and it is still the only live queue of the twenty-one.

**Two things the backend half found, both recorded in their stories rather than worked around.** `G7` — the guarded fetcher was referenced by seven stories and built by none, and the story that nominally owned it was scheduled after the first story that needed it. And three of auto-discovery's eight derivations are blocked on inputs that do not exist: the 180-category taxonomy (named once in the whole specification, owned by nobody — the same shape as `G2`), competitor proposal (needs [STORY-049](./stories/aux/STORY-049-crawl-pipeline-and-ssrf-guard.md)'s multi-page crawl), and the free prompt allowance ([STORY-045](./stories/projects/STORY-045-prompt-generation-engine.md), which is downstream of the story that would have used it). All three return empty rather than plausible-looking invented values.

**Then the screen**

Wire onboarding's project step ([STORY-088](./stories/frontend/STORY-088-onboarding-flows.md), already built) off `project-fixtures.ts` and onto the real `POST /projects`, and build the discovery-review surface on [STORY-044](./stories/projects/STORY-044-discovery-review-and-confirm.md)'s payload. Replace the fixture, do not layer over it (§7.2). ~1.0d.

**What you can see at the end:** paste a URL into onboarding, get back a real project row, and watch discovery fields arrive with their confidences — including a low-confidence one flagged rather than silently applied, which is the behaviour worth watching for.

---

### Slice 2 — *"I can see the prompts it generated and choose which ones to run"* · ~8.0d

**Backend first**

| Story | What | Est. | Status |
|---|---|---|---|
| [STORY-133](./stories/capture/STORY-133-embedding-client.md) | **Embedding client (G3)** — `NEW-B`, drafted; **four decisions need sign-off**, one of them a dependency choice | 1.0d | blocked on you |
| [STORY-045](./stories/projects/STORY-045-prompt-generation-engine.md) | Prompt generation — archetype grammar, naturaliser, dedupe | 2.5d | **done** — nine of twelve ACs met, endpoint live, six gates green. Naturaliser model, vector dedupe and site-mined slots blocked on their own dependencies; six derivations need sign-off. Found and fixed STORY-043's supplied-prompt insert, a live 500. |
| [STORY-046](./stories/projects/STORY-046-prompt-lifecycle-and-activation.md) | Prompt lifecycle and activation against caps | 1.5d | **done** — eleven of twelve ACs, both endpoints live, six gates green. AC3 (the charge) blocked on EPIC-10 *and* on §4 contradicting §10's `FR-CRD-06` about the price. **STORY-032's run planner now has an input.** |
| [STORY-047](./stories/projects/STORY-047-topic-clustering.md) | Topic clustering with editable labels | 1.5d | hard-blocked on STORY-133 |

[STORY-046](./stories/projects/STORY-046-prompt-lifecycle-and-activation.md) is the keystone of the whole plan, not just this slice: [STORY-032](./stories/capture/STORY-032-run-planning-and-cache-suppression.md) names it upstream — *"planning has nothing to plan without activated prompts"* — so until it lands, the shipped run planner has an empty input for every project that exists.

**Then the screen** — the prompt-selection step in onboarding, live. ~1.5d.

**What you can see:** 15 real candidates, at least six of them brand-anonymous; the cap binding at activation with the three offered paths; a rejected prompt costing nothing. All of it visible rather than asserted in a test.

---

### Slice 3 — *"I trigger a run and watch it move"* · ~2.5d

**Backend first**

| Story | What | Est. | Status |
|---|---|---|---|
| [STORY-034](./stories/capture/STORY-034-run-lifecycle-api-and-progress.md) | Run lifecycle API, progress projection, cancel, replay | 1.5d | **done — seven of ten ACs.** Five routes live: free estimate, trigger, progress, cancel, matrix. `capture.execute` wired, so a run actually moves and emits `run.progress`/`run.completed`. Three ACs blocked on the parser and object storage. |

**This plan estimated the gap wrong, and the correction is worth recording.** The line above previously read "AC7 (pre-signed raw-capture URLs) is deferred on object storage — build the rest, tick eight of nine". Object storage is one of FOUR missing dependencies, not one: `GET /results/{id}` returns §6's **parser document**, and the parser is Slice 4; AC9's re-parse needs the same parser; AC10's retention failure rides on those read paths; and AC6's progress events need something to actually move a cell, which is the capture handler. Six of ten, with each gap naming its blocker.

**`capture.execute` did land, and it is what makes the slice's sentence true.** The handler resolves the engine, writes one of three rows (`captured` / `blocked` / `failed` — "we could not ask" is never confused with "the engine did not mention you"), seeds L1, emits `run.progress` coalesced across processes, and finalises the run through STORY-031's `resolveRunOutcome`. `capture.plan`, `capture.parse` and `capture.arbitrate` stay inert on purpose.

**⚠ SLICE 3'S VISIBLE OUTCOME IS BLOCKED, AND NOT BY ANYTHING IN THE STORY.** The line above promises "six engines resolving through fixture adapters". `FixtureAdapter.fetchVendorResponse` matches `input.promptText` EXACTLY against six case names — `normal`, `refusal`, `empty`, `truncated`, `redirect_heavy_citations`, `priced_product_element` — and throws a plain `Error` for anything else. A manual scan over a real project's prompts therefore fails every cell into the dead-letter queue. **This needs a decision before the slice can be demonstrated:** either STORY-027's adapter gains a documented default case, or the demo waits for real adapters ([STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md), [STORY-028](./stories/capture/STORY-028-api-engine-adapters.md)). Loosening a test double's matching changes what the demo proves, so it is not a detail an agent should settle.

**Three latent defects surfaced while wiring this, all pre-existing and all fixed.** `dispatchCaptureCells` enqueued cell payloads UNSIGNED against a `verify`-first worker; the L1 seed and the L1 probe would have keyed on different adapter versions (catalog `1.0.0` vs adapter `0.1.0-fixture`), making every capture invisible to the cache forever; and `worker.close()` never returns when Redis is unreachable, so a worker pod would refuse to terminate during exactly the incident you want it to restart in. Each went unnoticed because no capture handler had ever existed to exercise the path.

**Then the screen** — first-results progress in onboarding and the deep-scan control. ~1.0d.

**Settle §11 item 5 before this slice starts.** The realtime socket cannot authenticate today, and this is the first screen that genuinely needs it. Progress that only arrives on a poll is not the thing you are trying to look at.

**What you can see:** a progress bar moving on real events, six engines resolving through fixture adapters, and a run that completes `partial` rather than `failed` when one engine's circuit opens.

---

### Slice 4 — *"I can read the answer and see the score"* · ~20.0d · the big one

All of [EPIC-05](./epics/EPIC-05-parser-and-scoring-core.md). **Every backend story here is dangerous-area work** and takes a second-engineer review by an agent that did not author it; [`development-workflow.md`](./references/development-workflow.md) §3 requires tests first without exception.

**4a — the answer becomes structured** · ~5.0d

| Story | What | Est. | Status |
|---|---|---|---|
| [STORY-035](./stories/parser/STORY-035-normalizer-and-span-map.md) | Normaliser, span map, `normalizer_version` | 1.0d | **done — all seven ACs.** `normalizer_version` is now `n1` and owned in one place. ⚠ **Second-engineer review not run.** |
| [STORY-036](./stories/parser/STORY-036-entity-matcher.md) | Entity matcher — Aho-Corasick, aliases, candidate discovery | 2.0d | **done — eight of eleven ACs.** All three false-positive defences proven; untracked entities recorded. Automaton cache, discovery task and precision report blocked. ⚠ **No second-engineer review.** |
| [STORY-037](./stories/parser/STORY-037-citation-extraction-and-resolution.md) | Citation extraction, redirect resolution, classification | 2.0d | **done — nine of eleven ACs.** Text directives preserved, unresolved citations excluded from share, owned matching on a dot boundary. Alert emitter and persistence blocked on the parse stage. ⚠ **No second-engineer review.** |

[STORY-036](./stories/parser/STORY-036-entity-matcher.md) and [STORY-037](./stories/parser/STORY-037-citation-extraction-and-resolution.md) are file-disjoint and run in parallel after 035.

**✅ THE SECOND-ENGINEER REVIEW IS NOW RUNNING — and STORY-072 is the evidence for why it must.** Authorised 2026-09-15 and run four times on the credit wallet. Every round found real defects in code that already passed all eight gates: a wallet drained to zero by three retries, a compensation that rolled back, a pool deadlock at ten concurrent failures, a forgeable key namespace that moved money between seats in one workspace. **Two of the author's own tests passed against mutants of the exact thing they were named for.** The remaining unreviewed dangerous-area work below has had none of this.

**⚠ THE SECOND-ENGINEER REVIEW WAS NOT RUNNING, AND SLICE 4 DID NOT GET ONE.** [`development-workflow.md`](./references/development-workflow.md) §4 requires every dangerous-area change to be reviewed by an agent that did not author it, and does not permit waiving it. The parser is one of the four. STORY-035 shipped without one because the operating agent is under a standing instruction not to spawn sub-agents unless asked — a conflict between the project's rule and the session's, and one only you can resolve. Each further parser story compounds it: STORY-041's scoring library and STORY-038's LLM arbiter are the two places in the product where an unreviewed error is least visible and most expensive.

**✅ G10 — CLOSED by [STORY-135](./stories/capture/STORY-135-parse-stage.md), 2026-09-14.** `capture.parse` now calls the chain and writes `mention_facts` and `citation_facts`; `capture.execute` hands each captured cell on. The gap as it was found:

**⚠ G10 — NOTHING OWNED THE PARSE STAGE, and 4a's visible outcome depended on it.** STORY-035, 036 and 037 have landed as pure libraries. EPIC-05's eight stories are 035–037 (libraries), 038–041 (more libraries) and 042 (the rollup, which READS facts). **Not one of them wires `capture.parse`**: nothing calls `normalize` → `matchEntities` → `resolveCitation`, nothing writes `mention_facts` or `citation_facts`, and nothing moves `answer_captures.status` from `captured` to `parsed`. Same class of gap as `G7` (the guarded fetcher, extracted as [STORY-131](./stories/projects/STORY-131-guarded-fetcher.md)) and `G9`. It blocks 4a's stated outcome, [STORY-034](./stories/capture/STORY-034-run-lifecycle-api-and-progress.md)'s three remaining ACs, STORY-091's drawer, and STORY-042's rollup.

**And it cannot be built before [STORY-038](./stories/parser/STORY-038-sentiment-classifier-and-arbiter.md).** `mention_facts` has NO DEFAULTS on `sentiment_label`, `sentiment_score`, `sentiment_confidence`, `sentiment_method` or `prominence`, and all five are `NOT NULL` — **the table cannot represent an unscored mention.** A parse stage landing before sentiment would have to invent those values, which is precisely the "`null` is never stored or rendered as `0`" failure §6 names as one of the two highest-risk correctness bugs in the product. Citations have no such problem; mentions must wait. So the order is 038 → the parse stage, not the reverse.

**✅ The screen — [STORY-091](./stories/frontend/STORY-091-prompts-matrix-and-answer-drawer.md), done 2026-09-14.** The prompts matrix and the Live Answer drawer, across both repos. The adversarial XSS fixture suite landed in the first commit, as planned.

| Half | Branch | What |
|---|---|---|
| API | `story-091-matrix-and-drawer-api` | `GET /v1/results/{id}` (§6's `answer_capture.v3`); the matrix cell gains `brand_present`, `brand_rank_position`, `sov`, `sentiment_label`, `cache_age_ms`; **migration 0021**. |
| App | `story-091-prompt-matrix-and-drawer` | The grid in its five cell states, the drawer, the offset-only renderer, the URL-mirrored filters. |

**Twelve of twenty-one ACs, and every one of the nine outstanding is blocked upstream** — topic clusters (STORY-047 → STORY-133), the displacement marker (STORY-092/056), verified-query candidates (Search Console), the generate batch flow (Slice 2's screen), raw download (object storage), re-parse (no endpoint), create task (no endpoint). The three missing filters and the four unavailable drawer actions are **named on screen with their reason**, not hidden.

**The offset-only guarantee is enforced in three layers**, because no one of them covers the others: a pure segmenter proven byte-for-byte against twenty adversarial fixtures; a component suite asserting the rendered *element structure* with text nodes stripped (React escapes `<` and `>` but not `=`, so a substring check on `innerHTML` calls the safe fixture `onerror=alert(1)` an injection); and `eslint-rules/no-engine-markup.js`, which bans `dangerouslySetInnerHTML` app-wide and restricts `AnswerText.tsx` to `<span>` and `<mark>`. The story asks for the guarantee to be "structural rather than a sanitiser call that someone may forget", and only the third layer stops a future edit.

**⚠ Migration 0021 fixes a defect a second-engineer review had already found and nobody had closed.** `answer_captures.brand_present` was `NOT NULL DEFAULT false`, so it could not tell "not parsed yet" from "the engine did not name the brand" — `src/lib/capture/l1-exact-hash.ts` records the finding verbatim. `citation_count` and `owned_citation_count` share the shape and the problem.

**⚠ Two URL writers were erasing each other.** The project shell's filter bar rebuilt the query string from its own store, dropping every other parameter — invisible while it was the only writer. Both now merge, against the live URL rather than a captured `useSearchParams()`.

**⚠ Spec gap — the filter bar offers `24h` and `custom`; the matrix endpoint accepts only `7d · 30d · 90d`.** The grid narrows to the nearest window and says which. Either the endpoint should accept them or the bar should disable them on this route. **Your call.**

**What you can see after 4a:** the matrix filling with real cells in their five states, and a real captured answer opening in the drawer with its entities and citations marked.

**4b — the answer becomes a number** · ~10.0d

| Story | What | Est. | Status |
|---|---|---|---|
| [STORY-038](./stories/parser/STORY-038-sentiment-classifier-and-arbiter.md) | Sentiment — lexicon, heuristics, calibration, LLM arbiter | 2.5d | **done — eleven of fourteen ACs.** Band-limited, fails closed, ten-payload red-team suite in CI. **No model bound** — same decision as STORY-133. Tuned lexicon and fitted calibration blocked on STORY-106. ⚠ **No second-engineer review.** |
| [STORY-039](./stories/parser/STORY-039-rendering-quality-extraction.md) | Rendering quality extraction and score | 1.5d | **done — seven of nine ACs.** Attributes only from typed elements; incapable engines excluded from their own denominator; `null` never 0. AUX link and labelled gate blocked. ⚠ **No review.** |
| [STORY-040](./stories/parser/STORY-040-answer-structure-and-position-class.md) | Answer form and position-class classification | 1.5d | **done — eight of nine ACs.** Derived from elements where available, inferred otherwise, method recorded. Window aggregate blocked on `G10`. ⚠ **No review.** |
| [STORY-041](./stories/parser/STORY-041-scoring-library.md) | Scoring library — prominence, SoV, Visibility Score, confidence | 2.5d | **done — thirteen of fourteen ACs.** Both highest-risk rules have dedicated tests; purity asserted by a static sweep. ⚠ **Found `scoring-models.md` §2.4's worked example to be arithmetically wrong** — implemented the formula, recorded the correction. Golden-set gate blocked on STORY-106. ⚠ **No second-engineer review.** |
| [STORY-042](./stories/parser/STORY-042-rollup-worker-metric-daily.md) | Rollup worker, `metric_daily`, dirty dates, denormalisation | 2.0d | **done — ten of twelve ACs.** Workspace-local dates proven on 23- and 25-hour days; scores from the library, not from SQL. ⚠ **Migration 0020 fixes a NOT NULL that §14's own SQL violates.** Dirty-date set and rebuild endpoint outstanding. ⚠ **No review.** |

[STORY-038](./stories/parser/STORY-038-sentiment-classifier-and-arbiter.md), [STORY-039](./stories/parser/STORY-039-rendering-quality-extraction.md) and [STORY-040](./stories/parser/STORY-040-answer-structure-and-position-class.md) all follow [STORY-036](./stories/parser/STORY-036-entity-matcher.md) and are mutually parallel. [STORY-041](./stories/parser/STORY-041-scoring-library.md) needs all three.

Two things this must not get wrong, both named in the corpus as the highest-risk correctness bugs in the product: **an absent brand mention contributes 0 to share of voice and still counts in the denominator**, and **`null` is never stored or rendered as `0`**. Each needs its own dedicated test.

[STORY-038](./stories/parser/STORY-038-sentiment-classifier-and-arbiter.md)'s arbiter carries R-14 — a ≤400-character evidence span in a delimited, instruction-free envelope, constrained to an enum schema, no tools, no network, failing closed to `neutral`, with the 60-payload red-team fixture suite in CI.

**The golden-set gate has no runner and cannot get one here.** [STORY-106](./stories/launch/STORY-106-golden-set-corpus-and-fixtures.md) is deferred behind [STORY-028](./stories/capture/STORY-028-api-engine-adapters.md)/029 (§4). Build and run the fixtures the stories name; record explicitly that the *launch* accuracy gate is not yet enforceable. Do not approximate it with a weaker assertion.

**⚠ G11 — THE PROJECT OVERVIEW HAS NO ENDPOINT TO READ A SINGLE NUMBER FROM.** [`api-specification.md`](./references/api-specification.md) §3 lists `GET /projects/{id}/scorecards` and `GET /projects/{id}/growth-map` under Analytics, and [STORY-090](./stories/frontend/STORY-090-project-overview.md) reads every figure on the screen from those two. **`src/modules/analytics/` is still [STORY-022](./stories/api/STORY-022-nest-bootstrap-and-module-skeleton.md)'s scaffold — a controller with no routes.** [STORY-042](./stories/parser/STORY-042-rollup-worker-metric-daily.md)'s rollup WRITES `metric_daily` and nothing reads it back for a customer.

The same inversion as `G7` ([STORY-131](./stories/projects/STORY-131-guarded-fetcher.md)), `G8` ([STORY-132](./stories/projects/STORY-132-list-projects.md)), `G9` ([STORY-134](./stories/projects/STORY-134-list-and-create-prompts.md)) and `G10` ([STORY-135](./stories/capture/STORY-135-parse-stage.md)) — for the fifth time, a screen story names five upstreams and not one of them is the endpoint it reads from. **This is a pattern in the story graph, not five coincidences: screen stories name the features they display and never the read models that serve them.** Worth a sweep of the remaining screens before each is picked up.

**Extracted as [STORY-136](./stories/analytics/STORY-136-project-scorecards.md) (scorecards) and [STORY-137](./stories/analytics/STORY-137-growth-map-payload.md) (§7's Growth Map payload). ✅ Both done 2026-09-14 — `G11` is closed and [STORY-090](./stories/frontend/STORY-090-project-overview.md) now has both endpoints it reads from.**

**✅ [STORY-136](./stories/analytics/STORY-136-project-scorecards.md) done 2026-09-14**, branch `story-136-project-scorecards`, all fourteen scenarios and all eight gates. It found a second defect on the way in: **`aggregateRange` derived its entity set from `mention_facts` alone, so a window in which the brand was never mentioned produced NO ROW AT ALL** — the day vanished from `metric_daily`, and presence rate 0 was indistinguishable from never having asked. Invisible because the only test that could have caught it asserted `toBeUndefined()` on exactly that row. The rollup now always writes a brand row wherever there are cells.

The window aggregate comes from the **facts**, not from `metric_daily`: §3 defines every component over `C(T)`, a window rate is not the mean of daily rates, and re-deriving through `avg_prominence` (a `real`) cannot hit the 1e-9 the slice's success metric demands. `metric_daily` keeps its job as the per-day series STORY-137 plots.

**✅ [STORY-137](./stories/analytics/STORY-137-growth-map-payload.md) done 2026-09-14**, branch `story-137-growth-map`, all seven scenarios. The chart reads `metric_daily`'s `engine_key='all'` rows — the two stories use different sources because they are different questions. A missing day is a **null point that still carries its date** (zero draws a collapse nobody measured; omitting it lets a renderer draw a straight line through), and the baseline is the **median**, built from the competitor series so a gap day is excluded rather than counted as zero. `measured_impact` is validated rather than trusted, and the mandatory caveat is stamped when a validated delta carries none. **`annotations.cadence_changes` is permanently empty — `project_engines` has no history table and nothing records a change.**

**⚠ And `metric_daily` cannot answer the question honestly on its own.** `presence_rate`, `sov`, `citation_share` and `visibility_score` are `NOT NULL DEFAULT 0`, and `toMetricRow` coalesces a null ratio to `0` before writing them — so a day with cells but no citations stores `citation_share = 0`, which reads as "cited, none of them mine" rather than "nothing cited anything". STORY-136 therefore **re-derives every ratio from the stored COUNTS**, which do not have the problem. Same class as migrations 0020 and 0021; the columns are left alone because nothing else reads them and widening the fix would touch the rollup's write path.

**✅ The screen — [STORY-090](./stories/frontend/STORY-090-project-overview.md), done 2026-09-14.** Two branches: `story-090-overview-api` (three fields the ACs name — per-metric deltas, last scan per engine, next run) and `story-090-project-overview`. **Merge the API branch first.**

**Eleven of twenty-two ACs fully, five partially, six not at all** — and the honest split matters here, because most of the design-system guarantees were already in place: `BlendedScore` refuses to render without its per-engine set, `Scorecard` refuses a delta below the threshold, `MetricValue` renders the em dash, and STORY-087's `TrendChart` already refuses to bridge a null. **The smallest outstanding item is not blocked on anything**: the deep-scan control never says a manual scan does the same work as a scheduled one, which is unwritten copy.

**⚠ Scenario 18 is untested, not proven.** "A manual deep scan updates every metric exactly as a scheduled run does" protects the whole deep-scan proposition, and it cannot be exercised until a scan can run against a real engine (STORY-001/028/130). No amount of frontend work closes it.

**⚠ A late filter-bar write could navigate a customer backwards.** `useUrlSyncedFilters` wrote `router.replace(pathname + params)` with a pathname captured at render, so an effect firing after the customer clicked away sent them **back to the page they had just left**. `e2e/navigation.spec.ts` had been red on `main` for exactly this and read as flaky — it passes alone and fails under load. Fixed by skipping the write when the live pathname has moved on. Related: `POST /runs/estimate` had no e2e stub, so **every screen carrying the deep-scan control rendered a refusal** in the suite.

Its upstreams [STORY-066](./stories/tasks/STORY-066-milestones-and-growth-map.md) (milestones) and [STORY-062](./stories/geo/STORY-062-geo-digest-and-top-levers.md) (Top Three Levers) are not built, and both surfaces ship empty-stated with the reason rather than fixture-filled.

**What you can see:** a Visibility Score on screen that you can recompute by hand from an exported cell list and match **exactly to 1e-9**. That is the success metric this whole slice exists to prove.

---

### Slice 5 — *"I can see what it costs and what I have left"* · ~9.5d

**Backend first** — the buildable remainder of [EPIC-10](./epics/EPIC-10-entitlements-credits-billing.md), with [STORY-075](./stories/billing/STORY-075-stripe-subscriptions-and-webhooks.md), [STORY-076](./stories/billing/STORY-076-credit-packs-purchases-autotopup-addons.md) and [STORY-077](./stories/billing/STORY-077-downgrade-and-retention-policy.md) deferred per §4.

| Story | What | Est. | Status |
|---|---|---|---|
| [STORY-071](./stories/billing/STORY-071-daily-cap-guard.md) | `DailyCapGuard` and daily action counters | 1.0d | **✅ done 2026-09-14** — eleven of twelve ACs, branch `story-071-daily-cap-guard`. Found `G12`. |
| [STORY-072](./stories/billing/STORY-072-credit-wallet-reserve-commit-release.md) | Credit wallet, reserve/commit/release, `CreditGuard` | 2.5d | **✅ done 2026-09-15** — branch `story-072-credit-wallet`. **Four rounds of second-engineer review**; the ledger came forward from STORY-073. |
| [STORY-073](./stories/billing/STORY-073-credit-ledger-and-reconciliation.md) | Append-only ledger, reconciler, nightly replay | 2.0d | **◐ half done 2026-09-16** — branch `story-073a-ledger-reconciliation`, **split in two**. **A (landed):** migration 0023, all eight entry types written, replay verification, orphan reconciler, nightly verifier that pages, `credit.reconcile` handler. **Second-engineer review found four blockers, all reproduced, all against green gates** — the reconciler was RLS-blind in production and reported success; a refused release entry committed its balance movement anyway and destroyed a live hold; a swept reservation could be charged against someone else's credits with the verifier reporting clean; and the "cannot self-heal" tests were source greps that passed against a working self-heal. **B (merged, PR #67, reviewed):** actor/project/reference on every debit, `unit_detail`, `GET /v1/billing/wallet/ledger` with cursor and five filters, erasure pseudonymisation (migration 0024). **Its review found three blockers**, all reproduced: the erasure pseudonym was reversible three ways and was a REGRESSION against `main`, which had retained nothing; 877 of 1,000 generated pseudonyms violated the published `uuid` contract; and the cursor truncated microseconds to milliseconds, dropping rows at a page boundary. **CSV export deferred to `POST /exports`** — it needed `@NoEnvelope()`, which a gate reserves for the health probes, and it carried no `exports.csv` entitlement check. Internal cost is plumbed and always 0 until STORY-028/029. **⚠ Its "advisory-locked" half landed 2026-09-18 as [STORY-141](./stories/billing/STORY-141-reconciler-advisory-lock.md)** — see below. **Only the CSV export remains.** |
| [STORY-074](./stories/billing/STORY-074-estimates-and-confirmed-credits.md) | Free estimates, confirmed-credits header, `price_changed` | 1.5d | **◐ backend done 2026-09-16** — branch `story-074-estimates-and-confirmation`. §7's five escalation thresholds (new, server-side), the estimate carrying wallet/shortfall/confirmation, AC6 proven end to end by a real plan change. **Second-engineer review found three blockers** — the estimate took a second `PG_POOL` connection inside the request's own transaction and deadlocked the whole API; §7's threshold NUMBERS were untested (25→100 passed all 2,337 tests); and AC6 held on the happy path but not on a re-attached retry, where the confirmed figure was checked against today's price and the HELD amount was debited. **⚠ THE CONTRACT CHANGE IS A `major` BUMP** by `contracts:diff`, and there is no version-bump process in the repo — needs a decision. **AC8 done 2026-09-16** on `story-074b-undo-window` — the undo REFUNDS (no reservation survives the 202) and is gated to sub-threshold actions, so it refuses every deep scan: §7 gives the undo to actions below all thresholds and the cheapest deep scan is 100 against a threshold of 25. **Review found three blockers** — a fully cached re-run refunded in full (free, unbounded); the refund laundered expiring credits into the durable bucket with the nightly verifier reporting clean; and the cancel/refund ordering contradicted its own comment. **Client, first slice done 2026-09-16** on `story-074c-cost-surfaces` — the deep-scan control read a HARDCODED ZERO balance (`availableCredits={0}` on the overview page) and computed `wallet after` itself under a `Math.max(0, …)` clamp that hid a shortfall; both now come from the estimate, and the confirmation step is the server's verdict. AC9's purchase-in-place met. **Still open:** AC8's toast (nothing to call — every deep scan is above threshold), AC12's post-completion summary, `CostModal` off fixtures (moves with STORY-085), and the unrecorded `major` contract bump. |

**⚠ G12 — NOTHING IN THE PRODUCT SCHEDULES A REPEATABLE JOB, and it is not a billing problem.** Found while wiring STORY-071's nightly purge. **Ten of the twenty-one queues in `src/lib/queue/topology.ts` declare a cron producer and no BullMQ job scheduler is registered for any of them** — `capture.plan` ("scheduler cron, API"), `rollup.metric_daily` ("cron hourly"), `geo.analyze`, `gsc.sync`, `attribution.rollup`, `credit.reconcile` ("every 10 min"), `topic.cluster`, `crawl.audit`, `report.build`, `maintenance.partition`.

The consequence is larger than any one story: **no scheduled tracking run has ever been possible.** Every capture the product has taken came from a manual trigger, and the freshness, cadence and rollup surfaces built on top of scheduled runs describe something that does not happen yet. It also means STORY-042's rollup only runs when something enqueues it by hand.

**STORY-073 landed against it, as predicted.** The reconciler's handler is wired and correct and nothing enqueues it — so the queue is live and will simply never be handed a job until a scheduler exists. Two `tsx` entry points close the gap by hand in the meantime: `pnpm credits:reconcile` and `pnpm credits:verify`, sharing their logic with the handler rather than duplicating it. **The nightly replay verifier is in the same position**: written, tested, exits non-zero on a mismatch, and run by nobody on a schedule.

`producer:` in the topology is a declaration of INTENT, and nothing has ever read it.

**✅ G12 slice A done 2026-09-18** — [STORY-140](./stories/api/STORY-140-queue-job-schedulers.md), api branch `story-140-queue-scheduler`. A schedule table beside the topology and a registrar that reconciles BullMQ job schedulers at every worker boot, both directions, scoped to the calling group's own queues and to the `cron:` keys the table owns.

**⚠ THE NOTE ABOVE THAT "EVERY HANDLER IS WRITTEN" IS WRONG, and that is the finding.** Five of the twenty-one queues have a handler — `crawl.discover`, `capture.execute`, `capture.parse`, `rollup.metric_daily`, `credit.reconcile`. And the gap is narrower and stranger than "no scheduler exists": **`src/lib/capture/scheduler.ts` is a complete `SchedulerService` from [STORY-033](./stories/capture/STORY-033-scheduler-cadence-windows-jitter.md)** — `claimDueProjects` with `FOR UPDATE SKIP LOCKED`, fairness ordering, the watermark advanced in the same transaction as the enqueue — with two integration specs and **zero production callers**. Built at both ends, connected at neither; the same shape as the credit chip. What was missing was the tick.

**One queue actually ticks: `credit.reconcile`, every ten minutes.** The arithmetic is pinned in a test — ten rows carry a cron, six state a period with no time of day, two have no handler, **one is tenant-scoped**, one is left. Six carry `null` rather than an invented off-peak hour, because "daily" says how often and not when, and an off-peak hour is a real decision that lands on the vendors, the database, and whoever is awake.

**⚠ A BARE CRON TICK CANNOT DRIVE A TENANT-SCOPED QUEUE** — the review's first blocker, and the one worth carrying forward. A job scheduler produces the same template every tick and has no workspace to name and no key to sign with, so for a `tenantScoped` queue the processor throws in the signature path *before the handler is reached*. Scheduling `rollup.metric_daily` (which has both a cron and a handler) would have written to its dead-letter queue once an hour forever, paging on-call by day three. **What §4's "cron hourly" means for a tenant-scoped queue is a per-project SWEEP** — exactly what `SchedulerService` is for `capture.plan` — a handler on a different queue, not a repeatable on that one. So the remaining cron queues need producers, not schedulers.

**The review also found the feature entirely untested in production shape**: the reconcile call could be mutated out of `src/worker.ts` with all nine bootstrap tests green, boot log reading "scheduled: none". Reproduced before acting. Three integration tests now read the real Valkey the boot wrote to.

**✅ The reconciler's advisory lock, merged as [STORY-141](./stories/billing/STORY-141-reconciler-advisory-lock.md) 2026-09-18.** §4 specifies `credit.reconcile` as "1, advisory-locked" and only the concurrency half existed — the **third** helper this line of work found built, tested and never wired (`globalQueueLockKey` names that queue in its own doc comment; `queue-advisory-locks.spec.ts` has tested the key for as long as it has existed). Moot until G12 gave the job a timer; reachable the moment it did, because BullMQ's `concurrency` bounds one Worker instance and not the queue.

**Its review found that the lock introduced a new way for credits NOT to come back**, which is worth carrying as a general lesson: a fleet-wide lock converts a single wedged replica from a local problem into a global one. A **partitioned** replica — not killed, where the backend dies and Postgres drops the lock — leaves a live backend holding it, and **there is not one timeout setting anywhere in the repository**, so the bound was the OS TCP keepalive default of two hours. Silently: a yielded tick *completes*, so the dead-letter queue stays empty and every alarm reads green. Fixed with server-side keepalives in the connection's startup options (not a `SET` — `no-session-scoped-config` bans those, rightly) plus a counter and WARN.

**And five of its first seven tests passed against the unchanged handler** — two could not tell "lock released" from "lock never taken", and one re-proved `releaseReservation`'s pre-existing idempotency rather than the lock. The missing one was the whole premise: that the lock is held ACROSS the per-reservation transactions, which run on a different connection. **This is the same defect the previous four reviews caught**, and it is now the clearest standing risk in how this work is being done.

**✅ The partition-maintenance tick, [STORY-142](./stories/api/STORY-142-partition-maintenance-tick.md), 2026-09-18 — and it had a DATE on it.** The estate had partitions for 2026-09 and 2026-10 and nothing beyond. From 1 November every capture, mention and citation would have landed in the `default` partition — which does not error, which is why nobody would have noticed — and **Postgres will not attach a partition whose range overlaps rows already in `default`**, so the remedy stops being "create a partition" and becomes "move rows out under a lock", getting worse daily. `runMonthlyMaintenance` was complete and tested under [STORY-013](./stories/data/STORY-013-partition-and-vacuum-maintenance.md) and ran only when an operator remembered. **The FOURTH capability in four stories found built, tested and reachable by nobody.**

**Its review found the schedule could have caused the very failure it prevents.** One row stranded in a `default` partition inside the lead window made `CREATE...ATTACH` fail, and the loop propagated — so nothing was created, for any table, and the tick then failed identically every day while the runway expired. Also: the suite could not distinguish the handler from a stub (the advisory lock, the whole premise for the previous story's keepalives, was unasserted), and `cold_tier` is provisioned nowhere, so from 2026-12-30 the tick would have thrown daily and taken the default-partition alert with it.

**⚠ The cadence is SPLIT, and the reasoning generalises.** The tick runs the runway half only — detect, then create. The destructive half (cold-tier moves, detach/drop past retention, vector rebuilds) stays operator-invoked, because the drop cutoff is the **minimum retention across active workspaces**: one reversible soft-delete collapses it platform-wide and the next daily tick would drop nine partitions, where monthly gave a month to notice. **A cadence must not be shorter than the window in which a reversible decision is still reversible.**

**And BullMQ resolves crons in the process's local timezone.** Found by STORY-142's own boot test — a 03:20 schedule firing at 21:20 UTC on a UTC+6 machine. Every schedule [STORY-140](./stories/api/STORY-140-queue-job-schedulers.md) registered is timezone-independent, so nothing could have caught it until the first time-of-day cron existed. All schedules now pin `tz: "UTC"`.

**⚠ FOUR IN A ROW IS NOT COINCIDENCE.** `SchedulerService`, `onCreditHeader`, `globalQueueLockKey` and now `runMonthlyMaintenance` were each complete, tested, and unreachable. §2.4 already warns the story statuses are stale; this sharpens it — **"Done" in this plan has been tracking *written*, not *reachable*.** Every remaining `Done` that claims a background behaviour deserves the question "what calls it?" before it is believed.

**✅ The audit-chain verifier's tick, [STORY-143](./stories/identity/STORY-143-audit-chain-verifier-tick.md), 2026-09-18 — found by the reachability sweep, and it is a SECURITY control.** Of six ops scripts under `src/workers/`, `audit-verify.ts` and `audit-export.ts` had **no pnpm script and no production caller** — reachable only from their own tests. [`security-and-tenancy.md`](./references/security-and-tenancy.md) §12 requires the verifier daily; §4's queue table never allocated it a home, so it had none. The audit log is hash-chained so tampering is *detectable* and this walk is the whole of the detection; unrun, the chain was a cost with no benefit. A 22nd queue, with the §4 divergence guarded the way the schedule divergence is.

**Its review found the control failing silently in three separate places, and all three were live.** A detected tamper produced only log lines and a green job — `LoggingPagingNotifier` is a stub and `incrementCounter` is a `Logger.log`, so nothing failed, nothing reached a dead-letter queue, nothing a machine watches; **and the comment claiming §12's paging "has happened" was written in this story.** One bad chain stopped the estate walk permanently, since the walk returned at the first mismatch found anywhere and discovery has no ordering. And a connection that cannot see through FORCE RLS reported a **clean estate** — reproduced against `nominara_app` — which is the worst outcome available to an integrity check, because it is believed.

**⚠ AND THE FIRST FIX FOR THAT LAST ONE WAS ALSO WRONG.** Comparing audited workspaces against `count(*) FROM workspaces` reads that count through the same blind connection, and `workspaces` is tenant-scoped too — so "0 audited, 0 existing" looked like an empty estate. Its own new test caught it. The guard is now on the *privilege*, which cannot be hidden by the thing it checks for. **The general lesson: a guard must not be readable through the failure it guards against.**

**Two detection gaps remain, now pinned as tests rather than discovered later**: tail truncation and whole-chain deletion both pass clean, and the first is the tamper an attacker actually performs. Closing them needs a stored per-workspace high-water mark. The walk is also not chunked and has no `(workspace_id, seq)` index — deferred deliberately, because it is a rewrite of a crypto verification path and did not belong in the same commit as three security blockers.

**⚠ FIVE IN A ROW.** `SchedulerService`, `onCreditHeader`, `globalQueueLockKey`, `runMonthlyMaintenance`, and now `verifyAllChains` — each complete, tested, and unreachable. **This one had two comments in the repo asserting it ran daily.** The sweep that found it is cheap and should be repeated: `src/workers/` invokers, queue producers, and any `Done` story claiming a background behaviour.

**✅ The chunked chain walk, [STORY-144](./stories/identity/STORY-144-chunked-chain-walk.md), 2026-09-21** — the obligation STORY-143 filed when it deferred the performance work. The walk no longer reads a whole chain into memory, the lenient zone is not read at all, and migration 0025 adds the `(workspace_id, seq)` index the verifier has been sorting around since STORY-020.

**⚠ THE LESSON IS ABOUT TESTS, AND IT REPEATS ONE THIS PLAN HAS ALREADY RECORDED.** The classic chunking bug — resetting the carried hash per chunk — survived seven tests, because the tamper they used edits CONTENT and the content hash takes the carried value as an input, so a wrongly-reset walk still catches it. Only a broken LINK exercises it. Then the review found four more of the same shape: **every test in the new file used one workspace**, so dropping a tenant filter was invisible — and that is a cross-tenant false clean, where one tenant's ordinary GDPR erasure makes every other tenant's chain lenient and unverified while the run reports no mismatch. **A suite can be fully mutation-tested against the mutants you thought of and still be blind to a whole dimension it never varies.**

**✅ The free tier's dashboard, [STORY-145](./stories/frontend/STORY-145-free-tier-dashboard.md), 2026-09-21 — the app's own instance of the pattern, and the first story chosen by a SURVEY rather than from memory.** A fourteen-agent workflow read both repos and this plan from six lenses and fact-checked every claim; it found that `zeroProjectPlan` was keyed on `FIXTURE_WORKSPACE_PLAN`, a map of five invented ids, so a UUID never matched and the flag was **always false**. `ZeroProjectLayout` — built, tested, with the real tools launcher in it — had mounted for nobody, and since `POST /v1/workspaces` creates every workspace on free with `projects.max: 0`, that is the DEFAULT tier. The default signup journey terminated on a seven-line file whose body is `<h1>Tools</h1>`.

**⚠ AND THE E2E SUITE RATIFIED IT.** `onboarding-workspace-zero-project.spec.ts` had `toHaveURL(/\/tools$/)` as the **pass condition** for that journey, asserting nothing about what rendered. Making the flag real then broke **twenty specs at once** — because the stub serves `projects.max: 0` by default while every dashboard spec asserts a workspace WITH projects. **The dashboard suite had been asserting a paid-tier UI over a free-tier payload and passing, because nothing read the value.** The tier now rides in the access token's claims, since registering a stub on a shared GET poisons the parallel run — the leak that same spec already documents.

**⚠ THE SURVEY IS THE METHOD TO REPEAT.** Five stories running, I answered "what next" from memory and was wrong each time. Fourteen agents, every candidate independently fact-checked, cost about a million tokens and produced a ranked list with evidence — including three things nobody was tracking: the product loop is a no-op end to end (`INSERT INTO project_engines` appears in 13 integration specs and **zero** production files); seeding the engine catalog **alone would be worse than not seeding it**, converting a visible no-op into DLQ flooding behind an unconditionally-green engine board; and **reachability sweeps of the api under-report by default**, because `entity-matcher.ts` contains NUL bytes and both grep and ripgrep skip it as binary without `--text` — so the method the last six stories were built on has been inventing dead code and missing real callers.

**✅ The free tier's landing page, [STORY-146](./stories/frontend/STORY-146-free-tier-landing-honesty.md), 2026-09-22.** STORY-145 made `ZeroProjectLayout` the first screen every signup sees; it was offering six tools that cannot run — `tools.controller.ts` has **zero** route decorators — each behind a real credit price and a link to `<h1>{tool}</h1>`. And it told free users Schema Builder needs Starter, while §2 says that tool is "free and unlimited".

**⚠ THE PLAN FIX WAS UNFALSIFIABLE UNTIL THE SPECS WERE EXTRACTED — the fix sat behind the fix.** Restoring the bad gate passed all 67 tests, because the availability gate short-circuits before the plan branch is reached. A correction that no test can fail on is the same defect class as an unrun verifier; the decision is now asserted on the data rather than through a render that cannot see it.

**⚠ AND A FLAKE WAS NEARLY MIS-ATTRIBUTED.** `command-bar-shell.spec.ts:85` failed two of three full-suite runs on the branch while main passed four of four — conclusive-looking, and wrong. Twelve repetitions of that single test give **5 failed / 7 passed on both**. **Small-sample comparisons between a branch and main are not evidence**; the fix is to repeat the one test, not to re-run the suite.

**✅ The dashboard stops issuing a clean bill of health, [STORY-147](./stories/frontend/STORY-147-action-items-honesty.md), 2026-09-22 (app #37).** Third in STORY-145's family and the same root cause: `FIXTURE_ACTION_ITEMS_BY_WORKSPACE[workspaceId] ?? []` keyed on invented ids, so a real UUID resolved `[]` — and `[]` rendered as *"No action items match these filters."* with a `(0)` count, which says this workspace **has been assessed**. `tasks.controller.ts` has zero route decorators and `TasksService` is empty, so nothing assessed anything. **Absence of a producer is not absence of findings**, and on a visibility product "nothing to fix" is the most flattering lie available.

**⚠ SUPPRESSING THE COUNT AT THE RENDER WAS NOT ENOUGH, AND WHY IS THE USEFUL PART.** The fixture resolves after a 25ms timer, so the assertion ran before the count could appear and a mutation removing the guard passed. Two mechanisms said the same thing and neither could be falsified. The query is **disabled at the source** instead — no `data`, no length to print — and the test asserts **the fetch never happened**, a fact with no timer in it. Third occurrence in three stories of the same shape: *an assertion one level away from where production decides.*

**◐ The caller's IP chain, [STORY-148](./stories/identity/STORY-148-forward-client-ip.md), 2026-09-22 — pushed, in review.** nominara-api computes two things from `request.ip`: §12's ip-scoped rate-limit buckets, and `actorIp` on **every** audit row. The browser never reaches api.* directly, so both saw one address — ours — on every request the product has ever made. The api's mitigation is already built and correct (`TRUST_PROXY_HOPS` → a **hop count**, never `trustProxy: true`), and **nominara-app never sent a chain**, so it had no input at any setting. §12's `auth` bucket is 30/min and pre-auth ip buckets are global: thirty sign-ins a minute for the entire platform.

**⚠ THE AUDIT CONSEQUENCE IS THE LARGER ONE.** STORY-143 and STORY-144 were spent proving `audit_log`'s hash chain is intact. **An intact chain of the wrong value is still the wrong value.** All fourteen client call sites relay now, and `check:forwarded-for` makes the rule structural — a unit test per module could not have caught this, because nothing was broken in any one file; the rule was written down nowhere a fourteenth file would meet it. **`TRUST_PROXY_HOPS` is still unset**: forwarding is a strict prerequisite and is inert until an operator sets the count, which must include nominara-app itself as a hop.

**⚠ AND ONE VERIFICATION RUN WAS VACUOUS.** The first mutation sweep reported nothing: `SPECS="a b c"; vitest run $SPECS` — **zsh does not word-split an unquoted parameter expansion** — so every run was one nonsense filter matching zero files and four mutants "passed" without executing. Same class as STORY-145's silent scripted no-op: *assert that the thing you ran actually ran.* It recurred once more after the review, differently: a backup directory keyed by **basename** clobbered `app/api/session/status/route.ts` with `app/api/workspace-enter/route.ts` — both are `route.ts` — and only a test count dropping from 80 to 74 mid-sweep exposed it.

**⚠ THE REVIEW RETURNED CHANGES REQUIRED, AND THE WORST BLOCKER WAS THE DOCUMENTATION.** The paragraph telling an operator what to set produced the exact bug the paragraph below it warns about. It said to count the proxies you operate "**counting this server as one of them**" — but nominara-app RELAYS rather than appends, and `proxy-addr` starts at the socket peer, which is nominara-app, so a relaying hop consumes no count. `browser → ingress → app → api` is **1**; the rule said 2, and 2 returns whatever the caller prepended. **And it is invisible in testing** — under honest traffic 1 and 2 agree, so a staging environment set to 2 looks perfect until someone attacks it. Careful reading did not catch this; running the arithmetic against the real `@fastify/proxy-addr` did. Four tests in `api/test/unit/trust-proxy.spec.ts` pin it now, including "2 is indistinguishable from 1 under honest traffic".

**⚠ AND THE GUARD WRITTEN FOR THIS STORY COULD NOT GUARD ITS MOST IMPORTANT CALL SITE.** `check:forwarded-for` was textual, and the review walked through it four times — the worst being that a **comment** satisfied it, so deleting the header from `cookie-proxy.ts`'s forwarded list still reported ✓ because the docblock above the list names it twice. Every `/auth/*` request goes through that file. It is an AST walk now, the same move `no-cost-literals.ts` made one review earlier, and it immediately found a fifteenth caller the textual scan could not see.

**⚠ AND MY OWN NEW TESTS COULD NOT FAIL.** Nine call sites had no test at all; writing them exposed that the first version **passed the moved-below mutant on all nine**, which only running the mutant revealed. `fetchMock.mock.calls[0][1].headers` is a LIVE REFERENCE to the object the action mutates, so a relay moved after the request still shows the header present by the time the assertion reads it — **the test cannot see WHEN the write happened, which is the only thing the mutation changes.** The same flaw was in four other files. Every relay assertion snapshots inside the stub now, and one e2e observes a real Next server rather than a mock of `next/headers`.

**⚠ AND A CALLER COULD HAVE BROKEN A TENANT'S AUDIT CHAIN.** `audit_log.actor_ip` is `inet`, the row hash is computed over the string sent, and the verifier reads it back with `host(actor_ip)` — so `203.0.113.9/32` or `2001:0DB8::0001` yields a row that can never be recomputed: a permanent `hash_mismatch` reported as tampering against that tenant. `'not-an-ip'::inet` is worse — 22P02 inside the transaction the append shares with the **mutation**, so the request fails and no audit row is written, repeatably. STORY-143/144 proved that chain's hashes are intact; **an intact chain of the wrong value is still the wrong value, and an intact chain a caller can break is not intact.** `safeActorIp` closes the castable and mask-suffixed cases; the IPv6 spelling is deferred with the break *demonstrated* in an integration test rather than described, and **`TRUST_PROXY_HOPS` must stay unset in every environment until it closes.**

**◐ Canonicalise `actor_ip`, [STORY-149](./stories/identity/STORY-149-canonicalise-actor-ip.md), 2026-09-22 — pushed, in review.** The other half of STORY-148's review finding, and the last thing standing between this platform and a working per-IP control surface. `AuditChainService.append` now folds `host($2::inet)` into the chain-tail read, so the value hashed and stored is the one the verifier reads back.

**⚠ THE FIX IS "ASK POSTGRES", AND THAT IS THE WHOLE POINT.** Normalising in Node was the obvious reach and the wrong one: no Node API agrees with `host()` — WHATWG's URL parser turns `::ffff:127.0.0.1` into `::ffff:7f00:1`, breaking the single most common real value (the dual-stack form Fastify itself produces) to fix a rare one. **A hand-rolled canonicaliser is a second implementation that must track Postgres forever, and the failure mode of drift is the exact bug being fixed.** Asking the database is correct BY CONSTRUCTION because it is the same function the verifier reads with, and it costs nothing — it folds into a query that was already being made.

**Both halves proven separately necessary by mutation:** hashing the sent string reproduces the poisoning; dropping `safeActorIp` lets `22P02` abort the mutation's own transaction; replacing `host()` with a passthrough cast fails the same four tests, so it is `host()` doing the work and not the query restructure. The test that *demonstrated* the break now proves the fix, over three rewrite classes and a five-row chain — a single-row chain cannot fail on `prev_hash`, so it is the weakest possible shape for the claim.

**⚠ ITS REVIEW FOUND THAT `actor_ip` WAS THE FIELD, NOT THE CLASS — AND THE OPEN INSTANCE NEEDED NO PROXY CONFIG AT ALL.** `workspace_id`, `actor_id`, `resource_id` and `support_grant_id` are all `uuid`, so Postgres lowercases them; `UUID_PATTERN` in the audit interceptor is case-INSENSITIVE and **there is no `ParseUUIDPipe` anywhere in the repository**. So `POST /v1/projects/{UPPERCASE-UUID}/discovery/confirm` succeeds, writes its audit row, and leaves that tenant's chain reporting `hash_mismatch` forever — **any authenticated member, by typing the path in capitals**, live since STORY-020. Worse, the chain's advisory lock was keyed on `hashtextextended(<the raw string>)`, which differs between spellings, so two appends to the same workspace in different cases did not serialize and the chain could FORK as well as break. `POST /v1/workspaces/{id}/switch` hit all of it at once.

**⚠ AND THE GUARD THAT WAS SUPPOSED TO STOP AN UNCASTABLE VALUE DID NOT.** `isIP('fe80::1%eth0')` is 6 and `'fe80::1%eth0'::inet` raises 22P02 — inside the transaction the append shares with the MUTATION — and `@fastify/proxy-addr` passes a zone id through verbatim. One header was a reliable kill switch on every mutating request a caller made, leaving no audit row: *verbatim the failure the guard's own comment claimed to close.*

**⚠ AND A MUTANT SURVIVED MY TESTS AGAIN.** Every negative case was IPv4-shaped or colon-free, so `isIP(raw) === 0 && !raw.includes(":")` passed all sixteen assertions while admitting a network as a host and an uncastable literal. **A negative-case set that shares one shape tests one shape.**

`env.schema.ts`'s audit blocker on `TRUST_PROXY_HOPS` is lifted; **the topology decision is all that is left, and the variable is still unset everywhere.** `UUID_PATTERN` stays case-insensitive and a `ParseUUIDPipe` is still owed — the chain is safe because `append` canonicalises, but every other consumer of a raw path param still sees whatever the caller typed.

**◐ One canonical form for a uuid, [STORY-150](./stories/api/STORY-150-canonical-uuid-params.md), 2026-09-22 — pushed, in review.** RFC 4122 uuids are case-insensitive on input and lowercase on output; Postgres enforces that on every `uuid` column and nothing in the application did, so **the database and the application disagreed about what a request's id WAS.** A `CanonicalParamsGuard` registered first in `ApiModule` settles it before any guard, interceptor or handler reads it.

**⚠ THE MECHANISM WAS THE REAL DECISION.** The natural home is a Fastify `preHandler` hook — but `fastifyServerOptions()` cannot carry one and this repo constructs `new FastifyAdapter(...)` in dozens of places, so a hook at the bootstrap would be absent from all the others and **every test would exercise a configuration production does not have.** That is STORY-140's defect exactly. Nest's guard chain is the only pre-handler stage the module itself registers.

**⚠ ITS REVIEW RETURNED CHANGES REQUIRED, AND THE STORY HAD LED WITH A SURFACE IT EXCLUDED.** `@ProjectParam` appears on **zero** controllers, so `RbacGuard.assertInScope` — the motivation the story opened with — never runs over HTTP. Its only live caller is the realtime gateway's `join:project`, which the guard's own `getType()` short-circuit made un-fixable by the obvious route. And the failure there is worse than the 4403 it caused: an **unrestricted** member passes the scope check, the ownership read casts to `uuid` and passes, and the socket joins `proj:A0EE…` — **a room no publisher will ever match.** The one live HTTP instance was `assertMatchesTenant`, whose `!==` gave a caller **404 on their own workspace**.

**⚠ AND THE FINGERPRINT WAS STILL ESCAPABLE, BY ACCIDENT RATHER THAN DESIGN.** `req.params` is percent-DECODED by Fastify and `request.url` is not, so one encoded hex digit made a request **identical everywhere it is observed** and different only in the idempotency key — three spellings, three records, three `deep_scan` debits under one `Idempotency-Key`. A caller escaping their own idempotency deliberately has an easier way; **HTTP clients disagreeing about what to percent-encode do it by accident**, on the retry the guarantee exists to protect. It keys on the matched route pattern plus the decoded params now.

**⚠ AND TWO OF MY OWN GUARDS WERE ASSERTED BY A MIRROR.** `api.module.spec.ts` compares the observed guard order against `GUARD_ORDER` — an array in the same file, edited in the same commit. The review moved the guard from first to **last** in both and the suite stayed green while production was broken exactly as both files describe at length. **A list that is edited alongside the thing it checks is not an oracle.** The property is the CONJUNCTION — that a guard running after this one sees a canonical value on a real request to a route that HAS a param — and nothing asserted it, because `/health/live` has no params.

**⚠ AND THE SPELLING CHECK WAS A SECOND UUID PARSER.** Postgres accepts hyphens in the wrong places, hyphens missing, braces, and 32 bare hex digits — all the same row. A plausible-looking optional-hyphen regex caught two of five. It strips and counts now, over-approximating on purpose, and an integration test pins it against the real database rather than against its own comment. **STORY-149's rule, applied one story later to the story that quoted it.**

**◐ Plan transitions, [STORY-151](./stories/billing/STORY-151-plan-transitions.md), 2026-09-23 — pushed in BOTH repos, in review.** Chosen by a 40-agent survey of all 17 epics, which found the product is not merely incomplete but **unenterable**: `workspaces.service.ts:232` hardcodes `plan_key 'free'`, nothing in production ever wrote any other value, free's `projects.max` is 0, and `POST /v1/projects` is gated on it with `current >= limit` — so **every workspace that could exist was refused its first project.** ~100 downstream stories were waiting behind a transition no code performed.

**⚠ AND ~330 SPEC FILES ROUTED AROUND IT.** At least ten integration specs open with `INSERT INTO workspaces (…, plan_key) VALUES (…, 'growth')`, bypassing the only production writer. **The paid tier was built, tested, and never wired** — the repo's signature defect, applied to the thing that makes it a business.

**⚠ THE DESIGN DECISION WAS THE MECHANISM, NOT THE SQL.** Three competing designs, three judges (security, spec-fidelity, buildability). `billing:write` is held by every workspace OWNER, so a route would let any customer grant themselves Business. The env-gate design lost on a **confirmed fatal flaw**: its post-commit token re-mint is not executable on a tenant route, because `TenantContextInterceptor` wraps the handler INSIDE the transaction and the body finishes before COMMIT. The winner ships **no route at all** — the safety property is an absence, and breaking it requires merging new code, which is reviewable.

**⚠ ITS REVIEW RETURNED CHANGES REQUIRED, AND THE ROOT CAUSE WAS ONE MISSING FIXTURE.** Wallets are provisioned lazily, so **not one of 33 tests ever called `grantCredits`** — deleting the entire §5 top-up, breaking its idempotency key and removing the advisory lock ALL left every test green. Three real defects were hiding there: a free-text ticket written into `credit_ledger.reference_id`, which is `uuid`, aborting the whole change on any workspace that had ever spent; `date` columns read at LOCAL midnight, **over-granting ~6 credits per Growth upgrade in us-east-1** and minting into an already-ended cycle; and an advisory lock taken before the wallet row lock, **inverting the request pipeline's order and deadlocking the customer's settle transaction** after the engine had already been paid. `wallet.ts:83` had documented the date trap already, after a previous review caught the production READ keeping it — I reintroduced it on the write path, where it mints money instead of rendering a date a day early.

**⚠ AND THE SAFETY SCAN — THE STORY'S ENTIRE SAFETY PROPERTY — WAS EVADABLE SEVEN WAYS**, including `await import()`, which `run-estimate.service.ts` already uses inside a directory the scan covered. **A detector that cannot fail is not a control.**

**⚠ AND THE CLIENT HALF COULD NEVER FIRE.** `ProblemFilter` maps `entitlement_stale` onto `unauthenticated` and demotes the original into `details.reason`; I verified the code was absent from §2's taxonomy — true — and concluded it therefore reached the wire raw. **Its test asserted `"unauthenticated"` is NOT recoverable, which is exactly what the api sends** — worse than unfalsifiable, it made the bug look deliberate. The envelope is pinned from the api side now, because its shape is a cross-repo contract that nothing asserted.

**⚠ AND CHASING "THE RECOVERY ONLY REACHES OWNERS" FOUND SOMETHING LARGER.** The dashboard layout was using `resolveOnboardingResume`'s OWNERSHIP answer to decide whether anyone belongs at all — so **an invited member could never reach the dashboard**, redirected to `/onboarding/persona` on every visit, forever. The entire invited-teammate path landed there. **One signal answering two questions**: onboarding asks "have you set up your own workspace?", the dashboard asks "do you belong anywhere?", and only the first was written. Split into `belongsToAWorkspace` / `belongsNowhere`, the latter three-valued because `anonymous` means "we could not tell" rather than "no" — a distinction the first draft lost and an existing test caught.

**MERGE STATE: BOTH HALVES ARE IN.** The api merged as PR #83 and the client as PR #39, so `pnpm plan:set` and the `entitlement_stale` recovery that answers it are in `main` together. The window the design warned about ("if it ships later, STORY-151 ships the cascade") was open in the repository for part of 2026-09-23 and is now closed.

**Still owed:** `entitlement_stale` is not in §2's taxonomy at all, so every generated client normalises it to `"unknown"` — its own story (taxonomy, regeneration, package publish).

**Still open:** `capture.plan`'s tick — the one that would make a scheduled tracking run possible at all — is slice B, and its handler is blocked on the **unseeded, unowned engine catalog** ([STORY-130](./stories/capture/STORY-130-seed-the-engine-catalog.md)). And §4 specifies `credit.reconcile` as "advisory-locked": `globalQueueLockKey` names that queue in its own doc comment and `queue-advisory-locks.spec.ts` already tests it, and **the production handler does not call it** — a third helper built, tested and never wired. Left for a credit story, because it changes that handler's transaction shape; the safety it would add is already proven by the existing "two OVERLAPPING runs" test.

**[STORY-072](./stories/billing/STORY-072-credit-wallet-reserve-commit-release.md) carries an inherited obligation.** [STORY-070](./stories/billing/STORY-070-quota-guard-tier-caps.md) reserves a tier cap under the request's `Idempotency-Key` and **nothing commits or releases it** — settlement belongs in an interceptor beside `CreditInterceptor`, still [STORY-022](./stories/api/STORY-022-nest-bootstrap-and-module-skeleton.md)'s pass-through scaffold. No production route carries `@Meter` yet, so nothing is wrong today; the first one that does must land the settlement with it, and that route arrives here. **The 200-way concurrent debit test lands with [STORY-072](./stories/billing/STORY-072-credit-wallet-reserve-commit-release.md) or the story is not done.**

KAD-12 is the thing to hold: structural limits, feature flags, tier caps, daily caps and the wallet are **five separate mechanisms** producing five separately actionable failures — `402 insufficient_credits`, `403 entitlement_exceeded`, `403 feature_not_in_plan`, `429 quota_exceeded`, `429 daily_limit_reached`. Never collapsed, each asserted distinctly.

**Then the screens** — [STORY-096](./stories/frontend/STORY-096-settings-and-billing-surfaces.md)'s settings and billing surfaces, and the cost-confirmation modal the app already built against fixtures, wired to [STORY-074](./stories/billing/STORY-074-estimates-and-confirmed-credits.md)'s real estimates. ~2.5d.

**◐ STORY-096 slice A merged 2026-09-16** — api #70, app #28. `GET /v1/billing/wallet` (the balance had no route; it was reachable only through the project-scoped run estimate) plus the billing and plan screens off their stubs. **Five of seven screens stay stubs**, each blocked on deferred work: packs and auto-top-up on [STORY-076](./stories/billing/STORY-076-credit-packs-purchases-autotopup-addons.md), downgrade on [STORY-077](./stories/billing/STORY-077-downgrade-and-retention-policy.md), white-label on STORY-097/101, trust on a missing audit-log route, integrations on Search Console. **The second-engineer review ran after the merge** and returned CHANGES REQUIRED — 4 blockers, 9 majors, all against green gates, all fixed on `story-096a-review-followup`. Two gates came out of it: `check:no-cost-literals` is now an AST walk (AC17 was **not** met — a const plan table passed every gate), and a new `route-permission-coverage` spec walks the real router, because `RbacGuard` is fail-open on a route with no `@RequirePermission` and nothing asserted the wallet carried one.

**✅ STORY-096 slice B merged 2026-09-17** — app PR #30/#31, app only. The Team & Access screen off its stub: members with roles and project scoping, role change, removal, pending invitations. **Three of the section's five AC bullets have no route at all** — checked against all 50 registered routes: no sessions endpoint (so no individual or bulk revocation), no api-keys endpoint, no SAML/SCIM. **Ownership transfer is a fourth**: `workspaces.ownership_transfer` is a column and `ownershipTransferSchema` validates its state machine, and nothing initiates or accepts one. None rendered.

**Its review returned CHANGES REQUIRED — three blockers, all authorization, all fixed on the same branch.** Every refusal reached the admin as `Minified React error #441` (a client component throwing across a Server Action boundary — a defect this repo had already fixed once for `createWorkspace` and documented); the screen armed role pickers and Remove buttons for manager, analyst and viewer, all of whom hold `workspace:read` and none of whom hold `member:update_role`; and the wrong-member hazard was pinned by no test, since every test rendered one member. Also: `/settings/team` rendered only error callouts in every e2e run, so the a11y sweep had been auditing two callouts rather than the table.

**✅ STORY-096 slice C merged 2026-09-17** — api PR #72, app PR #32. `GET /v1/me/oauth` (link and unlink shipped with STORY-015 and nothing could read the state between them) plus the passkey and connected-account halves. **Adding a passkey is not buildable**: registration is keyed on email and no route returns the caller's own, so a control here would have to ask — and a typed email registers a credential against whatever account owns it. `GET /v1/me` is filed.

**Its review returned CHANGES REQUIRED — three blockers, all fixed.** The worst was documentation: the route's comment and the `route-permission-coverage` EXEMPT entry both claimed ISO-18..22 covers `user_credentials`, and it does not — that table has no RLS at all, and its controls are migration 0005's grant plus a hand-written predicate. A false reason in the list whose purpose is a truthful reason. Also: the page test's mock discarded arguments, so the screen could rename or revoke the wrong credential with the whole gate green; and two accounts on one provider rendered as one row with one Disconnect that removed an arbitrary one.

**✅ The credit chip, merged 2026-09-17** — api PR #73, app PR #33. **It had never shown a number.** The mechanism was built at both ends and connected at neither: `onCreditHeader` had no production subscriber — its only callers were its own tests — and its only producer was `reportCreditHeader`, wired into `getApiClient()`, which STORY-125 already recorded as having zero call sites. So it read "—" on every page and only a realtime `credits.*` event could ever fill it. `NFR-UI-09` forbids fixing that by polling the wallet, so the figure now rides `x-nominara-credits-available`, stamped on every authenticated tenant-scoped success and carried back by the Server Action that already fetches `/v1/projects`. The api side had no test at all: `stampWallet` could have been deleted and every gate stayed green.

**✅ The Command Center health strip, merged 2026-09-18** — app PR #34. The chip fix made a standing lie visible: two lines below a truthful 1,400, the strip said "Credit balance is depleted", "◈ 0 available", "Free plan" and "Projects 0 of 0". `AuthenticatedShell` fell back to `defaultWalletFixture(...)` — a zeroed, depleted, free-tier wallet — whenever the health read had not landed, and that read was itself a fixture keyed by workspace id, so a real workspace never matched and the fallback was permanent. The strip now assembles from the same stamp plus the entitlements and the project list, and **nothing falls back**: a missing figure renders as absence.

**Its review returned CHANGES REQUIRED — four blockers, and two were earlier fixes of ours undone by the new code.** The expiring figure disagreed with `GET /v1/billing/wallet` by exactly `reserved`, because the header carries the raw included bucket while the billing route nets out what a running action has spoken for and suppresses a lapsed cycle — both rules STORY-096A's own review had added. An unknown balance was allowed to SKIP §7's balance-dependent thresholds on the reasoning that they were "a courtesy the server enforces anyway"; §7 says the modal is **required**, and the skipped rule fires when the balance is *sufficient*, so no 402 stands behind it and the debit lands. Gating the strip on the wallet stamp deleted it — and the tools strip with it — for every workspace that has never spent, since `provisionWalletWithGrant` only creates the wallet row on the first priced request; on free, the tools strip *is* the dashboard. And it rendered "Projects 3 of 0" past a spec written to catch exactly that, because the e2e asserted the absence of one literal string rather than the real pair.

⚠ **THESE TWO PIECES CARRY THE WRONG STORY IDS.** The branches were named `story-133-credit-chip` and `story-134-health-strip`, and **STORY-133 is [Embedding client](./stories/capture/STORY-133-embedding-client.md) and STORY-134 is [List and create prompts](./stories/projects/STORY-134-list-and-create-prompts.md)** — both real, both still open, and STORY-133 is one of the decisions waiting in §11. The ids were invented without checking the registry; the highest in use is STORY-137, so these should have been **STORY-138** and **STORY-139**. The branches are merged and the history is not worth rewriting, but no story file exists for either piece and the next new id must be taken from the registry, not guessed.

⚠ **AND THE VERY NEXT STORY REPEATED IT.** G12's branch was first pushed as `story-138-queue-scheduler` — reading "the highest in use is STORY-137" from the line above and taking 138, without reading the sentence that reserved 138 and 139 for the two pieces named here. Caught before merge and moved to [STORY-140](./stories/api/STORY-140-queue-job-schedulers.md); the `story-138` branch is deleted locally and on the remote. **Checking the registry is only worth doing if you read what it says.** 138 and 139 remain reserved for the chip and the strip.

**What you can see:** a real balance, a ledger that explains every debit, and a confirmation modal quoting a price the server actually computed — including the `price_changed` path when it moves between quote and confirm.

---

### After Slice 5

[EPIC-07](./epics/EPIC-07-aux-and-source-index.md) → [EPIC-08](./epics/EPIC-08-displacement-and-geo-insights.md) → [EPIC-09](./epics/EPIC-09-action-plan-growth-map-alerts.md) in the README's order, each followed immediately by its screen — [STORY-094](./stories/frontend/STORY-094-aux-health-and-action-plan.md) after [EPIC-07](./epics/EPIC-07-aux-and-source-index.md) and [EPIC-09](./epics/EPIC-09-action-plan-growth-map-alerts.md), [STORY-092](./stories/frontend/STORY-092-competitors-and-displacement.md) and [STORY-093](./stories/frontend/STORY-093-sources-and-geo-insights.md) after [EPIC-08](./epics/EPIC-08-displacement-and-geo-insights.md) — then [EPIC-11](./epics/EPIC-11-tools-and-command-surfaces.md) with [STORY-095](./stories/frontend/STORY-095-tools-surfaces-and-history.md). [EPIC-14](./epics/EPIC-14-marketing-site.md) (`nominara-web`) is gated only on [STORY-002](./stories/preflight/STORY-002-repositories-and-shared-ci.md) and can start whenever you want a third thing running.

**[STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md) landing at any point re-opens [STORY-028](./stories/capture/STORY-028-api-engine-adapters.md), [STORY-029](./stories/capture/STORY-029-licensed-serp-google-adapters.md) and [STORY-075](./stories/billing/STORY-075-stripe-subscriptions-and-webhooks.md).** Because [STORY-027](./stories/capture/STORY-027-capture-adapter-contract-and-registry.md) shipped fixture adapters, those slot in behind an interface that already exists and is already tested — no slice above needs rescheduling when they arrive.

## 7. The cross-repo protocol

### 7.1 The local layout, and the one symlink that makes it work

Both repositories are cloned side by side under `nominara/`. **`nominara-app` is checked out as `client/`** — the repository is still `nominara-app` on the remote, only the working directory is named differently.

```
nominara/
├── api/                     ← git@github.com:Nominara/nominara-api.git
│   └── client/              ← the generated @nominara/client package
├── client/                  ← git@github.com:Nominara/nominara-app.git
├── nominara-api -> api      ← symlink, see below
└── Nominara-Dev-Docs-main/  ← extracted snapshot, no .git (§7.3)
```

**Why the symlink exists.** `client/package.json` declares `"@nominara/client": "file:../nominara-api/client"` and pins it with `"nominara": {"clientPin": "0.0.0"}`. That path is resolved relative to the app's own directory, so it looks for `nominara/nominara-api/client` — and the API is checked out as `api/`. The symlink satisfies the declared path without renaming a checkout that every agent definition and skill already refers to as `api/`. It is a local development convenience and nothing in either repository depends on it.

Both clones pin the Nominara SSH identity per-repo, because a plain `git@github.com:` authenticates as the personal account, which has no access:

```bash
git -C client config --local core.sshcommand \
  "ssh -i /Users/sarwaralam/.ssh/id_ed25519_elegant -o IdentitiesOnly=yes"
```

**Refreshing the client after any contract change** — this is the step that makes a backend contract visible to the app, and it is manual because no registry exists yet (§7.2):

```bash
cd api && pnpm client:generate && pnpm --dir client build
cd ../client && pnpm install          # re-links the file: dependency
pnpm check:client-pin                 # fails loudly if the version drifted from the pin
```

**Two stale references to correct in the same pass:** `.claude/agents/frontend-dev.md` still says neither frontend is cloned and tells an agent to clone into `app/` — it is now `client/`. `.claude/commands/compile-prompt.md` still says [STORY-023](./stories/api/STORY-023-zod-openapi-client-pipeline.md) has not landed.

### 7.1a The two repositories are already out of contract, and the pin did not notice

**Found on 2026-09-02, the first time the client was regenerated against current `api` HEAD.** `nominara-app` @ `d7fdd07` **does not type-check** against `nominara-api` @ `f027660`:

```
lib/realtime/socket-client.ts(212,23): error TS7053 — 'error' | 'resync' cannot index REALTIME_INVALIDATION_MAP
```

One root cause. [STORY-026](./stories/api/STORY-026-realtime-gateway-and-sse.md)'s follow-up commits added `resync` and `error` to the realtime event catalog, taking `REALTIME_EVENTS` from 19 entries to **21**. The app's `REALTIME_INVALIDATION_MAP` still has **19**. Three type errors and five failing unit tests, all the same gap.

**The app's own tests caught it, exactly as designed.** `lib/query/invalidation-map.test.ts` asserts the map covers *"exactly the events the published client declares — no more, no fewer"*, and it went RED the moment the client was regenerated. That test is the real drift detector in this pair of repositories, and it works.

**`check:client-pin` did not catch it, and structurally cannot.** Both sides declare `0.0.0` — `api/client/package.json#version` and `client/package.json#nominara.clientPin` — and the version never moves, because the publish step that would derive a semver from the spec diff is [STORY-023](./stories/api/STORY-023-zod-openapi-client-pipeline.md)'s AC6, which is deferred on a registry in `nominara-infra` (§4). So the pin check passes while the contract changes underneath it. **It is currently a check that can only ever say yes.** Treat a green `check:client-pin` as meaning "the file resolved", not "the contract matches"; the type-check and the exhaustiveness tests are what actually hold the line until `NFR-REPO-02` has somewhere to publish to.

Closed by [STORY-123](./stories/frontend/STORY-123-restore-the-app-to-contract.md) (`T0g`). It was **not** two entries in a map, which is why it needed a story: `resync` carries a `scope` the map cannot see, so it is a payload-scoped branch, and `error` is the 4403 refusal, which needed a decision about the connection rather than the cache. The pin check now states its own blind spot on every green run, so nobody has to rediscover it.

### 7.2 How a feature crosses the boundary

`NFR-REPO-01…06` govern this, and the order is not negotiable:

1. **Contract first.** The zod schema lands in `api/contracts/`, alone, in its own commit. `pnpm contracts:generate` regenerates the OpenAPI document; drift fails the API build.
2. **API deploys additively, behind a flag.** `NFR-REPO-06`: *there is never a window in which the app requires an endpoint that is not live.*
3. **Client regenerates and the pin moves.** `pnpm client:generate && pnpm --dir client build`, then the app's `check:client-pin` either passes or fails loudly.
4. **The app wires the real endpoint** and deletes the fixture it was using — in the same PR, so the two never coexist and quietly diverge.
5. **The flag opens.**

**A fixture is a scaffold, never a destination — and under §6 it is now only ever written in the same slice that removes it.** `NFR-REPO-05` is blunt about why the contract gate in particular can never be mocked: *"Mocks drift and hide exactly the failures this protocol exists to catch."* The app's contract tests are supposed to run against a deployed API preview. **No preview environment exists yet** — that is [STORY-002](./stories/preflight/STORY-002-repositories-and-shared-ci.md) and [STORY-003](./stories/preflight/STORY-003-terraform-baseline.md) work — so until it does, every live-wiring pass in §6 is verified by hand against a locally-running API, and that limitation is recorded rather than papered over.

### 7.3 The docs repository cannot be committed to

`Nominara-Dev-Docs-main/` is an extracted snapshot with **no `.git`**. Story-status changes and spec fixes can be made on disk and cannot be pushed from here. Every one of them must be surfaced as a hand-carry item — that is what `T0e` is, and §12's new stories will need the same treatment.

**This file has the same problem.** A copy is committed to `api/docs/plans/dev-plan.md`, which is version-controlled, alongside the [EPIC-03](./epics/EPIC-03-api-platform-and-contracts.md) execution plan that set the precedent. **Read the docs-repo copy, not the mirror** — every link in this document is relative to the docs root and resolves only there. The mirror exists so the plan survives, not so it is browsed.

---

## 8. Gates — what exists, and what does not

Honest accounting. A gate that has no runner is listed as having no runner.

### `nominara-api`

| Gate | Runner | State |
|---|---|---|
| Lint | `pnpm lint` | ✅ green |
| Type-check | `pnpm typecheck` | ✅ green |
| Unit | `pnpm test:unit` | ✅ 1453 / 156 files |
| Integration | `pnpm test:integration` | ✅ 979 / 84 files — needs Docker |
| **Isolation `ISO-01…16`** | `pnpm test:isolation` | ✅ 51 assertions — **blocking, always** |
| **Contract drift** | `pnpm contracts:check` | ✅ — **blocking, always** |
| Migration fwd + rollback | `pnpm db:drift-check`, `db:rollback` | ✅ |
| RLS policy drift | `pnpm db:rls-check` | ✅ |
| **Scoring / parser golden sets** | — | ❌ **no runner.** [EPIC-05](./epics/EPIC-05-parser-and-scoring-core.md) is unbuilt; the corpus ([STORY-106](./stories/launch/STORY-106-golden-set-corpus-and-fixtures.md)) is deferred behind [STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md) |
| **200-way concurrent debit** | — | ❌ **no runner.** Lands with [STORY-072](./stories/billing/STORY-072-credit-wallet-reserve-commit-release.md) in Slice 5 |
| EXPLAIN budget regression | — | ❌ no runner |

Two of the four unskippable gates therefore **do not exist yet**. Slice 4 and Slice 5 each create one of them. Until then, say so in the PR body rather than reporting a green that was never run.

### `nominara-app`

`pnpm gate` chains lint → typecheck → unit → build → build:portal → self-hosted-fonts → e2e. The a11y audit and visual regression are inside `test:e2e`; `check:client-pin` is inside both builds. That much is real and enforced.

**Three checks existed but were wired to nothing, and each was a claim believed on trust. `T0f` closed all three:**

| Check | What it proves | How it is enforced now |
|---|---|---|
| `check:portal-readonly` | No mutating client method reached the portal bundle | Appended to `build:portal`, so the **build itself** fails on a mutating method — which is what [STORY-099](./stories/agency/STORY-099-portal-build-target.md)'s Definition of Done always claimed. It therefore also runs inside the portal e2e web server's build step |
| `lib/build/check-matrix-single-fetch.ts` | The Command Center matrix does not fetch per series | `scripts/check-matrix-single-fetch.ts` → `pnpm check:matrix-single-fetch`, in `gate` before `test:unit` |
| `lib/pricing/no-cost-literals.ts` | Every monetary figure comes from `CREDIT_SCHEDULE` | `scripts/check-no-cost-literals.ts` → `pnpm check:no-cost-literals`, same position. Scans `components/cost/**` and `ToolsStrip.tsx` |

Each was verified to **fail** on a planted violation before being wired — a check that cannot go red enforces nothing. `gate` is now `lint → typecheck → check:matrix-single-fetch → check:no-cost-literals → test:unit → build → build:portal (→ check:portal-readonly) → check:fonts-self-hosted → test:e2e`.

The genuinely missing gate is the contract test against a deployed preview (§7.2). And one gate that exists is currently **green for the wrong reason** — `check:client-pin` compares two hardcoded `0.0.0` strings that nothing ever increments, so it cannot detect contract drift at all (§7.1a).

**As first measured 2026-09-02 against a fresh checkout:** `pnpm lint` green, `pnpm typecheck` **failed with 9 errors**, `pnpm test:unit` **5 failed / 848 passed across 147 files**. [STORY-123](./stories/frontend/STORY-123-restore-the-app-to-contract.md) (`T0g`) closed all of them; `pnpm gate` now runs green end to end — lint, typecheck, 865 unit tests, both builds, self-hosted fonts, 120 e2e. **A first run of `pnpm test:e2e` on a new machine fails 120/120** with `browserType.launch: Executable doesn't exist` until `npx playwright install chromium` has been run; that is setup, not a defect.

### Both

**No CI runs any of this** (G4). Every gate above is a local command today.

### Environment

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_RYUK_DISABLED=true
# every pnpm script in api/ needs:  --config.verify-deps-before-run=false
```

Never bypass pnpm's `minimumReleaseAge` 24-hour supply-chain hold. If a gate is wrong, **that is a story** — it is never something to relax to get a green.

---

## 9. Definition of done

The twelve items in [`development-workflow.md` §8](./references/development-workflow.md#8-definition-of-done) apply unchanged. Four of them are the ones this plan will actually strain:

- **#4** — a migration is tested **forward and backward** and respects expand/contract. One migration per schema-changing story; `KAD-16`.
- **#5** — touching a tenant table means the isolation suite covers it. Slices 1 and 2 both add tenant tables. **The new-table rule:** create the table and its `ws_isolation_<table>` policy in **one** migration, add the name to `POLICY_IN_OWN_MIGRATION` in `src/db/conventions.ts`, and hand-add the migration to the two fixtures that apply an isolated subset — `rls-check.spec.ts` and `identity-tenancy-billing.spec.ts`. Skipping this breaks a fresh migrate thirteen migrations earlier, which is how it was found.
- **#6** — touching scoring means the golden-set regression is green **or** `scoring_version` is bumped with dual-compute. Slice 4 has no golden runner, so this reduces to the version discipline, and that must be stated plainly.
- **#8** — one span, one metric, one redacted log line, **verified rather than assumed**.

---

## 10. Risks specific to this plan

| # | Risk | Mitigation |
|---|---|---|
| P-01 | **Fixture debt compounds.** 17 fixture modules stand in for unbuilt endpoints today. | Structurally addressed rather than managed: §6 stops scheduling screens ahead of their endpoints, so the count only goes down from here. The app's README carries a **"Backend integration gaps" table** naming the upstream story behind each fixture — keep it current, it is the ledger, and §7.2 step 4 requires the fixture to be **replaced, not layered over**, in the same PR. |
| P-02 | **Slice 4 is 15 days of unbroken dangerous-area backend work** and second-engineer review becomes the bottleneck — R-10 arriving for real. | The parallel branches ([STORY-036](./stories/parser/STORY-036-entity-matcher.md) ‖ [STORY-037](./stories/parser/STORY-037-citation-extraction-and-resolution.md), then [STORY-039](./stories/parser/STORY-039-rendering-quality-extraction.md) ‖ [STORY-040](./stories/parser/STORY-040-answer-structure-and-position-class.md)) are file-disjoint by design. If review is the constraint, the date moves, not the standard. |
| P-03 | **Two of the four unskippable gates do not exist** for most of this plan. | §8 names them. Slice 4 and Slice 5 create them. No PR claims a gate it did not run. |
| P-04 | **G1–G3 are invisible from the story list**, so a plan built only from story statuses would sequence straight past them and produce a product that appears finished and captures nothing. | Slice 0 exists solely to close them, before any feature work. |
| P-05 | **[STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md) slips indefinitely** and the fixture-only build is never validated against reality. | R-01's own mitigation holds — fixtures carry the build. But the loop has never been observed on live data until it lands, and that is a launch gate, so **the accounts are still the single highest-value non-engineering action available.** |
| P-06 | **The docs repository cannot be committed to**, so the specification drifts from reality with every hand-carry that is forgotten. | Every hand-carry is enumerated in the PR body. This file is mirrored into `api/docs/plans/`. |

---

## 11. Decisions that need you

1. **The engine catalog seed.** Drafted as [STORY-130](./stories/capture/STORY-130-seed-the-engine-catalog.md); **six decisions in it need you** before a migration is written. Most of the catalog transcribed cleanly from the references — `tracking-engine.md` §3's closing line resolves the "ten engines" question (four are seeded `status='disabled'`), and it also settles mode, volatility and TTL for all six active engines. What did not transcribe: §11 states the business and enterprise cadences in prose ("daily on the priority subset", "hourly priority") and `cadence_by_plan` needs integers, and **`schemas/captures-and-facts.md`:31's worked example says `priority: 26` where daily over a 30-day cycle is 30**. That number is unexplained anywhere and I will not seed a figure I cannot derive. **Blocks Slice 3, not Slice 1** — discovery does not capture.
2. **The embedding provider (`NEW-B`).** Drafted as [STORY-133](./stories/capture/STORY-133-embedding-client.md); **four decisions in it need you.** ⚠ Note when searching the history: a merged branch is named `story-133-credit-chip` and has nothing to do with this story — see the ID collision recorded in Slice 5. Adding a provider is adding a dependency, and [`development-workflow.md`](./references/development-workflow.md) §6 puts that outside what an agent may decide: which provider, which model, and does it need its own credential in the same conversation as [STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md)? **The schema has already narrowed it** — `1536` is hard-coded in six vector columns and two HNSW index definitions, so a 1536-dimension model is a config change and anything else is an expand/contract migration plus a reindex. The story also surfaces a genuine specification defect: `EC-23` says `embedding_model` is stored on **every** vector row, and three of the six tables — including `tracked_prompts`, the one carrying all three similarity thresholds — do not have the column. **Blocks Slice 2.**
3. **[STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md) itself.** Seven stories sit behind it (§4) and the wait is external, not engineering. Every week it is not started is a week added to the end.
4. **`share_tokens.max_active` is a spec defect.** §9 of [`plans-and-entitlements.md`](./references/plans-and-entitlements.md) names it a structural limit; §2's matrix — which the seed reads — has only `share_links.enabled` with `"10_active"`/`"50_active"` strings. [EPIC-09](./epics/EPIC-09-action-plan-growth-map-alerts.md) must either add the key to §2 or rule that those strings are the cap.
5. **The realtime socket cannot authenticate.** `nominara-app` connects its socket directly to the API host, and the `__Host-`-prefixed session cookie does not travel there — recorded as an unresolved finding in the app's README and never escalated. Slice 3 is the first screen that genuinely needs it, and every realtime surface after it. It is a cross-repo design question (CORS and cookie scope, or a token handshake), not a bug either repo can fix alone. **STORY-091 shipped without needing it** — the matrix is a server-rendered read and the run progress panel polls — so it is no longer blocking a screen, but every live surface after this one still wants it.

6. **The matrix window and the filter bar's window disagree.** The shell's filter bar offers `24h · 7d · 30d · 90d · custom`; `GET /projects/{id}/matrix` accepts `7d · 30d · 90d`. STORY-091 narrows to the nearest and says so on screen, which is honest but is not a decision. Either the endpoint gains `24h` and a custom range, or the bar disables them on project routes that cannot serve them.
6. **Does `nominara-web` start now?** It is gated only on [STORY-002](./stories/preflight/STORY-002-repositories-and-shared-ci.md) and shares nothing with either repo above, so it is the one thing that can genuinely run alongside without competing for attention. Left to the end it lands in the last two weeks, which is precisely R-15.

---

## 12. Stories this plan requires that do not exist yet

Both are now drafted into `stories/` and need signing off before implementation. Neither is scope creep — both are gaps that existing `Done` stories depend on.

**`NEW-A` — Seed the engine catalog** · ~0.5d · [EPIC-04](./epics/EPIC-04-capture-and-tracking-engine.md) · closes **G2** — **drafted as [STORY-130](./stories/capture/STORY-130-seed-the-engine-catalog.md)**
Ten rows: six active with the cadence from [`plans-and-entitlements.md`](./references/plans-and-entitlements.md) §11, four (`grok`, `copilot`, `meta_ai`, `deepseek`) seeded `status='disabled'` per [`tracking-engine.md`](./references/tracking-engine.md) §3. Acceptance as drafted, plus two the first draft of this plan missed: **a disabled engine is never scheduled even when a project enables it**, and `min_plan_key` is enforced independently of the cadence map. Six decisions in the story need sign-off — see §11.1.

**`NEW-B` — Embedding client** · ~1.0d · [EPIC-04](./epics/EPIC-04-capture-and-tracking-engine.md) · closes **G3** — **drafted as [STORY-133](./stories/capture/STORY-133-embedding-client.md)**
One provider client behind a port, called only from a queue handler — never from a request path (`NFR-ARCH-01`). Acceptance: `prompt_embedding` is populated on prompt activation; L2 semantic suppression fires against a real embedding in an integration test; `embed_tokens` metering records actual spend through the internal-cost path, which must never gate a customer request.

---

**✓ The engine catalog and the set derived from it, [STORY-152](./stories/capture/STORY-152-engine-catalog-and-entitled-view.md), 2026-09-23 — api pushed, APPROVED after six review rounds, ready to merge.** Implements [STORY-130](./stories/capture/STORY-130-seed-the-engine-catalog.md)'s six signed-off decisions, and adds the half that story did not have. Seeding `engines` was necessary and **not sufficient**: `resolveEnabledEngines` read `project_engines`, and `project_engines` has **no production writer** — zero statements in `src/` — so the planner would still have resolved `[]` for every real project. The entitled set is now DERIVED per read by `project_entitled_engines`, and `project_engines` is narrowed to what it always should have been: **overrides only**, entering through a LEFT JOIN so an override can narrow and can never widen.

**⚠ AND THE FIRST DRAFT OF THAT VIEW REINTRODUCED STORY-151'S OWN DEFECT, ONE LAYER DOWN.** It gated entitlement on the plan floor **and** on `cadence_by_plan ? plan_key`, justified in its own comment as failing closed on whichever is stricter. They are not two readings of one claim: "not sold below this tier" and "this plan runs it on a schedule" are different facts, and the seed deliberately gives **no engine a `free` cadence key** — so every Free workspace would have been entitled to **zero engines**. That is the unenterable product STORY-151 had just finished fixing, in the same week, by the story that read STORY-151's post-mortem. STORY-130 §57 had already settled it in terms — *"the distinction is then carried by `min_plan_key`, not by the cadence map"* — and its AC:102 says such a row **"is not scheduled"**, not "is not entitled".

**⚠ THE TESTS SAID SO FIRST, AND I READ THEM AS THE THING THAT WAS STALE.** 26 failures appeared in two specs I had not touched, and the first diagnosis was that their fixtures were out of date. `scorecards.spec.ts` was already asserting the correct rule, in a test named *"reports a NULL cadence when the plan does not schedule the engine"* — an engine LISTED, with a null cadence. Both specs now pass **with no fixture edit at all.** A parallel six-agent workflow reached the opposite conclusion and four of its agents wrote an invented `cadence_by_plan` literal to satisfy the predicate; one agent's own verifier flagged that the literal granted a `free` cadence *"which 0027 deliberately gives NO engine"* — the right observation attached to the wrong conclusion, because every agent took the migration as ground truth and the tests as the thing to bend. All four were reverted. **When a green test starts failing, the migration is a hypothesis and the test is evidence.**

**⚠ AND REMOVING THE WRONG PREDICATE IS WHAT MADE THE RIGHT ONE LOAD-BEARING.** Deleting the plan floor from the view fails **ten** tests now. Under the first draft it failed **one**, because the cadence predicate excluded everything the floor would have — the floor was dead code that nine tests could not see, and a comment in the spec claimed exactly that narrower result. Corrected in place rather than left to age.

**⚠ AND THREE SPECS WERE SEEDING THE WORLD THE PRODUCT NOW HAS.** `engine-health-service`, `health-engines-summary` and `canary-runtime-real` hand-wrote `INSERT INTO engines` for catalog keys and began failing on `engines_pkey`. `health-engines-summary` had been asserting the readiness surface against **six engine rows it wrote itself**. The seeds were deleted rather than made conflict-tolerant. Briefly misdiagnosed as container exhaustion — genuine `57P01` noise from eleven leaked testcontainers was in the same output — and a grep for what those specs touched came back clean **because the pattern set that ran did not include `INSERT INTO engines`.** The duplicate-key error was in the output the whole time.

**Entitled is not capturable, and that gap is deliberate.** `resolveEnabledEngines` returns entitlement ∩ capture-ready, and `captureReadyEngineKeys()` is **empty**: every active engine is bound to a fixture adapter that matches six hard-coded prompt strings by exact equality. Planning a cell for one would manufacture a failure out of a thing we never tried — attempted, thrown, transaction unwound so no capture row of any status survives, five retries burned, dead-lettered, behind a `healthProbe()` that returns ok unconditionally. The alternative, an `adapter_unsupported` failure code, needs a ninth entry in a taxonomy §2 calls "Fixed, because the circuit breaker and retry ladder branch on it". **The cost is a test seam in five signatures that production never sets**, written down in the story rather than hidden; `engine-catalog-entitlement.spec.ts` asserts what production resolves *without* it, which is what keeps the default falsifiable.

**`aggregate-day.ts` deliberately did not switch.** A rollup weights a day that already happened; the view reflects today's plan, so switching it would re-weight history on an upgrade.

**Still owed:** capture-readiness is `false` for all six engines until an adapter story flips it — **the catalog is seeded and nothing can capture on it yet**, which is STORY-001's dependency, not a defect in this one.

**⚠ ITS REVIEW RETURNED CHANGES REQUIRED WITH A LIVE REPRODUCTION, AND THE FIRST FINDING WAS A HOLE IN THE GATE ITSELF.** `db:rls-check` reported `isClean: true` on a database containing `CREATE VIEW leaky AS SELECT * FROM projects`, granted to all four runtime roles, that served **every tenant's rows** to a caller pinned to one workspace. The census filters `relkind IN ('r','p')`; the isolation suite's discovery uses the same filter; ISO-16 inspects `pg_matviews`. **A plain view was outside every gate's universe** — and this story shipped the first one, whose entire tenant safety is one reloption that `ALTER VIEW … SET (security_invoker = false)` removes silently. Closed with a seventh `checkRls` bucket and **ISO-23**, registered with a breaker so ISO-00's anti-vacuity covers it; extension views are excluded by `pg_depend`, not by name, because an allow-list of two names admits the next extension's.

**⚠ AND "FAIL CLOSED" FAILED OPEN, WITH A 500.** `(cadence ->> kind)::int` does not fail closed on a non-integer — it RAISES, and the raise reaches the customer as a 500 on the whole Project Overview screen. `cadence_by_plan` is edited by hand-written operator migrations, and **seeding the catalog is what armed a cast that was dormant while the table was empty.** A CHECK constraint now rejects exactly the values that raise; zero and negative stay legal, because they cast cleanly and the readers' own `> 0` is the actual fail-closed rule.

**⚠ AND THE "IDEMPOTENT" RE-SEED WAS AN OVERWRITE.** Reproduced against the real rollback/migrate sequence: an incident responder's `status='degraded'` reverted to `active`, resuming scheduling against a vendor that was down, and `adapter_version` 2.3.1 reverted to 0.1.0 — **rewriting the catalog side of the very provenance pair the down migration keeps the rows to preserve.** Both dropped from the SET list.

**⚠ AND SWITCHING THE SCORECARD ONTO THE VIEW SILENTLY REDEFINED THE HEADLINE SCORE.** The header blended plan-entitled engines only; the stored `engine_key='all'` row that Growth Map and the trend series read blends every engine holding a `metric_daily` row with no floor at all. Before this story both were unfiltered and agreed — after it they differed by **17.75 points**, with `SCORING_VERSION` still `v1` and no dual-compute window, reachable the moment a workspace downgrades. **Decided: a blend is a statement about what was MEASURED.** Entitlement governs what may be captured next and cannot retroactively un-measure something, because a past day's score has to stay reproducible from an export.

**⚠ AND THE SCHEDULER WOULD HAVE MANUFACTURED EMPTY RUNS FOREVER.** `resolveDueEngines` had no capture-ready filter, so a tick would write a run row, resolve zero cells, record `engine_keys = '{}'` — which the coverage LATERAL cannot match, leaving `last_covered_at` NULL and the engine **permanently due**. Latent only because no capture worker exists; the next story to wire one would have inherited it.

**⚠ AND THE PLAN FLOOR WAS INERT IN BOTH SPECS THAT COVER THE SURFACES IT NEWLY GOVERNS.** `tracking-matrix.spec.ts` and `scorecards.spec.ts` truncate `engines` and rebuild it with `min_plan_key='free'` on everything, so the floor could have been deleted and neither would have noticed — every one of the ten tests the mutation note cites lives in a third file. **A mutation result is scoped to the files that ran.**

**⚠ AND ONE OF MY OWN TESTS LOST ITS PRECISION WHILE I FIXED ANOTHER FINDING.** Adding the capture-ready filter made the free-tier "due nothing" assertion pass for TWO reasons — no cadence, and nothing capture-ready — so the cadence mutation stopped failing it. Fixing a finding can silently disarm the test that guards a different one; re-run the old mutations after every fix, not just the new ones.

**⚠ AND THE RE-REVIEW RETURNED CHANGES REQUIRED AGAIN — BOTH MISSES WERE THE SAME MISTAKE.** Five of seven fixes cleared. The two that did not were **narrowed versions of the right idea**, and in both cases the tests I wrote alongside them reproduced the narrowing rather than probing it. The cadence constraint checked "is this an integral JSON number" when the crash comes from the TEXT `->>` produces: `4.0` and `99999999999` both passed it and both still 500'd the Project Overview — and my `it.each` asserted **exactly the three inputs the constraint caught**, because it was written from the implementation. The `measured` CTE spelled the window differently from the aggregation whose membership it governs (`>= from AND < to`, session zone, against `BETWEEN from AND to`, workspace zone), so an engine measured **today** was dropped from the blend while the stored rollup counted it — the 17.75-point divergence reopened at the window's most recent day, which is the day a customer looks after a scan. **A test written from the implementation inherits its blind spot; write it from the hazard.** Both now ask Postgres what the real behaviour is instead of encoding my reading of it.

**⚠ AND THE VIEW FIX CLOSED ONE ENTRY, NOT THE CLASS.** The original defect was that `rls-check` enumerates an allow-list of relkinds and everything outside it is invisible. I added views to the list. The review walked **one relkind over** and did it again with a foreign table — to which RLS does not apply at all, so there is no policy to be missing and no flag to be unset — and `isClean` returned true with it present and granted to every runtime role. The census is inverted now: every relkind is either handled by a bucket or reported. **When a gap comes from an allow-list, adding an entry is not the fix.** The gate could also DETECT the seventh bucket and not print it, so `pnpm db:rls-check` failed with a bare header and no line under it, on the one invariant nobody was looking for.

**⚠ AND A TEST OF MINE WAS DECORATIVE, WHICH ONLY A MUTATION SHOWED.** The timezone half of the window fix had a Sydney test that passed — and forcing the conversion to UTC left **all 27 tests green**. Both bounds are dates compared inclusively, so a ten-hour skew only changes the answer within hours of a boundary, and my fixture was nowhere near one. The test now sits at 00:30 on the window's first day in Sydney, whose UTC date is the day before, and asserts the two zones genuinely disagree before relying on that. **Two of the sweep's mutations were also initially vacuous** — dropping a bind parameter failed 26 of 27 tests, a red that proved nothing. A mutation that fails everything is as suspicious as one that fails nothing.

**⚠ ROUND THREE: BOTH BLOCKERS CLOSED, AND EVERY REMAINING FINDING WAS A FIX'S OWN SHAPE ONE STEP OVER.** The cadence constraint was fuzzed against a real `::int` over 27 jsonb leaf forms with **no false accept anywhere**, and the `measured` predicate now matches the aggregation character for character. What was left was latent: the relkind census was `public`-only **while ISO-23 had already been widened** — the reasoning was written in ISO-23's own comment and not carried across, and a foreign table in `app` fell through all three controls. The status predicate was a deny-list in the rollup and an allow-list in the membership: same set today, opposite kind, and a sixth `answer_captures.status` value reopens round two's divergence by the last unshared predicate. `security_invoker = t` was still rejected, one spelling past the `true|on|1|yes` list. **Three rounds, and each round's fix was right in direction and one notch short in extent** — the recurring error is fixing the instance I was shown instead of the class it belongs to.

**⚠ AND A TEST PREMISE THAT WOULD HAVE TAUGHT THE NEXT ENGINEER TO WEAKEN A GUARD.** The cadence differential test asserted `accepted === casts`, an equivalence that is FALSE — the constraint is deliberately stricter for JSON strings, and `'"4"'` stores as `4`, which `::int` accepts. It passed only because no string was in the list. Anyone adding that case gets a red whose obvious fix is to **loosen the constraint the test exists to protect**. It is one-directional now (accepted ⇒ casts), true for every input, with a companion pinning the values that must stay storable so the implication cannot go vacuous.

**⚠ AND THE MEMBERSHIP PREDICATE WAS PINNED ON ONE EDGE ONLY.** Every test asserted an engine IS present, so deleting the window clause outright survived the whole suite — admitting an engine the customer neither buys nor used, rendered identically to "entitled and never measured". **Assertions that something appears do not test the rule that decides what appears.**

**The prior-window blend leg is folded in** on your instruction, against the reviewer's recommendation to defer it — its argument was that a fixed engine set across both legs is a defensible definition of a delta, and that this is a second published number. It is finished rather than half-done: span `priorFrom … to`, corrected comments, and a test asserting the CONSEQUENCE (identical current data, different blended delta) with `CONFIDENCE_THRESHOLDS.medium` imported rather than hardcoded, since below that threshold both deltas are null and the comparison would prove nothing.

**⚠ ROUND FOUR: ASKED FOR A FOURTH INSTANCE OF THE CLASS, THE REVIEW FOUND TWO — BOTH IN CODE THIS STORY HAD ALREADY TOUCHED.** The RLS widening reached the two queries a reviewer had planted objects in and not the census feeding the other six buckets, so an ORDINARY TABLE in another schema — `workspace_id`, granted to every runtime role, RLS not even enabled — left all eight buckets empty. And the structural guard written to stop status-predicate copies was itself an allow-list of one alias spelling across two named files: it missed a copy **185 lines below the declaration in a file it already read**, because that line says `status` and the scan required `c.status`. Widening it then surfaced three more hand-written copies of the same `{failed, blocked}` boundary. **The repo had four spellings of one question while a guard against exactly that reported clean.**

**⚠ AND THE FIX WAS NOT TO WIDEN THE GENERATOR'S CENSUS.** `introspect.ts` feeds `db:rls-generate`, which emits UNQUALIFIED `ALTER TABLE` / `CREATE POLICY` — widening it would make the generator write statements that resolve by `search_path`. The generator managing `public` is a real boundary; what was missing is that nothing said so and nothing reported a table outside it. `unmanagedTables` now does, with the migration ledger as the single declared exception and **report as the default** — which is the difference between it and the three allow-lists that failed earlier in this story. Same reasoning for the status guard: its file list is DERIVED from "mentions `answer_captures`", and it discriminates by the status DOMAIN rather than by a file list, because `capture_runs.status` shares the column name and must not be unified with it.

**⚠ AND A TEST PREMISE I HAD NOT SEEN: THE CROSSING CASE.** I guarded the delta test against too-few cells; the reviewer named the trap that actually mattered — if the prior blend were under the confidence threshold without the added engine and over it with, the two deltas would differ *because one is null*, and the test would pass while proving nothing about membership. The `not.toBeNull()` pair excludes it. Its other correction: the comment claimed "identical current-window data" and nothing asserted it, so that is an assertion now.

**Four rounds, and the recurring error has one name: fixing the instance rather than the class.** Views added to a relkind allow-list that a foreign table then walked through; a schema scope widened in one control and not the one beside it; a boolean spelling list grown by three and still one short; a scan widened to the file it was shown and not to the question it was guarding. The controls that finally held are the ones where the default is to REPORT and the exceptions are declared — not the ones with a longer list.

**⚠ ROUND FIVE: THE NARROWEST, THE FIRST WITH NO LIVE DEFECT, AND THE ONE THAT NAMED THE SIGNATURE.** Three items, each the same shape one dimension further out. The copy-detection scan's OPERATOR list was one short — it matched `IN`/`NOT IN` while `l2-semantic-reuse.ts` says `ac.status = 'parsed'`, a live predicate in a file the derived reader list already covered. Round four's miss escaped on the alias prefix; this escaped on the operator. The spec's FILE list was derived and its RULE list was not, so `capturedInRunStatusSql` — whose whole subtlety is that `skipped` is excluded because `capture_runs.skipped_cells` already counts those cells — had no assertion anywhere and could have been widened into a double-count with no test failing. And the CHECK-constraint parse sliced to end of file, safe only because `answer_captures` happens to be the last of five `status IN (…)` constraints in `0003` — a property of the file, not of the parse.

**⚠ AND THE ESTIMATE FOR WIDENING THE OPERATOR WAS WRONG IN AN INSTRUCTIVE WAY.** The prediction was "exactly one new flag, and it is the real one". It flagged SIX, and NONE were predicates: four comments — one of them this story's own docblock explaining the widening — and two `SET` assignments. The real one had already been converted by the same edit. The prediction came from reasoning about the domain discriminator, which correctly rejects other tables' vocabularies; `status = 'parsed'` in a comment or a write uses OURS. **The discriminator was right and the population was wrong** — a scanner's population is every place the text can appear, not every place the concept applies. Two more discriminators followed, each tested in both directions: prose is not code (this repo was bitten before, when ISO-13's cache-namespacing scanner read an interpolated string inside a comment), and an assignment is not a predicate.

**THE SIGNATURE, after five rounds: a control whose scope is an enumeration when the population is open.** Relkinds, schemas, boolean spellings, status values, alias prefixes, operators, rule names — every one was complete for the world as it stood. What holds is the shapes where omission FAILS rather than passes: an inverted relkind census, a bucket that reports by default with one declared exception, a reader list derived from content, a status domain parsed from the migration that defines it, a rule list derived from the module's exports, and letting Postgres parse its own boolean. **A longer list was never the fix, and it took five rounds to stop reaching for one.**

**✓ ROUND SIX: APPROVED, NOTHING LIVE — AND THE ONE PLACE MY OWN FAIL-SAFE REASONING WAS WRONG.** The review built a single fixture carrying every live hazard from all six rounds at once — a Sydney workspace, a below-floor override at weight 2, and its only capture TODAY, which is the exclusive-bound bug and the timezone bug simultaneously on the engine the plan floor removes. No row leaked, no number moved, no request 500'd, header membership and the stored rollup agreed, weights matched. All five named status rules executed in four reader shapes: 20 for 20 valid SQL.

**⚠ AND IT DISPROVED THE FAIL-SAFE ARGUMENT I HAD ASKED IT TO CHECK.** I claimed both new discriminators fail safe. `stripProse` does. `isAssignment` did not: `UPDATE t SET flag = CASE WHEN status = 'parsed' THEN 1 END` is a genuine predicate whose nearest listed keyword is `SET`, so the scan skipped it SILENTLY — the direction I said I cared about. **The fix was not to add `WHEN`** — that list is an enumeration of predicate introducers, the signature shape one member short for the sixth time. It asks a narrow POSITIVE question now (is the column directly in a SET list?), so `CASE WHEN`, `HAVING`, `FILTER (WHERE …)` and anything nobody has thought of fall through to FLAGGED. An unrecognised context now costs a false positive somebody looks at rather than a real copy nobody sees.

**THE STORY'S RECORD, six rounds: a gate that called a fully leaking view clean; a customer-facing 500 reachable by the most natural operator typo; a 17.75-point divergence between a published header number and the chart beside it; and four successive generalisations of one error — each found because the previous fix was the right idea at too small a scope.** Asking for the class rather than the symptom is what eventually closed it, and asking the reviewer to disprove my own reasoning is what caught the last one.


## 13. What "done" looks like for this plan

The P2 exit criterion, unchanged from the README: **a project created from a URL alone reaches a rendered, scored answer within the time-to-first-insight objective**, with a Visibility Score reproducible by hand from an exported cell list to 1e-9 — on fixture adapters, with the vendor swap a one-interface change whenever the accounts arrive.

Slices 0 through 4 deliver that. Slice 5 makes it sellable.
