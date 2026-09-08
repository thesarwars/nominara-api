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

### 2.1 `nominara-api` @ `f027660` (branch `main`, working tree clean)

Re-measured 2026-09-02: `pnpm lint` clean, `pnpm typecheck` clean, **1453 unit tests across 156 files pass** in 8.3s. Integration (**979 tests / 84 files**) and isolation (**51 assertions**) were measured 2026-09-01 on this same commit and are not re-run here — they need Docker.

Structure: **19 migrations**, 21 modules, **21 controllers carrying 27 routes between them**, 6 of those modules holding real logic and **14 still being [STORY-022](./stories/api/STORY-022-nest-bootstrap-and-module-skeleton.md) scaffolds with zero routes**.

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

### 2.2 `nominara-app` @ `d7fdd07` — further along than the story list suggests, and thinner than it looks

31 commits, three merged PRs, **396 files**. **[STORY-086](./stories/frontend/STORY-086-app-shell-and-state.md), 087, 088 and 089 have all landed.** Next in line is [STORY-090](./stories/frontend/STORY-090-project-overview.md).

**Real and substantial:** the App Router shell across both build targets, Zustand stores, URL-authoritative filter state, TanStack Query keys with a per-surface staleness table and an event→invalidation map, the realtime socket client with workspace-switch cache reset, the design-system token layer, the full four-step onboarding flow, and the Command Center. **147 unit test files, 18 Playwright e2e specs**, 44 components each with a co-located test, and **six custom ESLint rules** that enforce the honesty rules mechanically — `no-raw-design-values`, `no-duplicate-metric-copy`, `no-causal-language`, `no-direct-chart-import`, `no-direct-invalidate-queries`, `no-server-data-in-store`.

**Route stubs awaiting their story:** all **nine** project sections (`overview`, `prompts`, `competitors`, `sources`, `geo`, `aux`, `plan`, `attribution`, `reports`), **seven** of the eight settings pages, `action-items`, and both `tools` routes. Each is an 8-to-9-line placeholder that exists so the shell has a route to mount — exactly what [STORY-086](./stories/frontend/STORY-086-app-shell-and-state.md) asked for, and exactly what [STORY-090](./stories/frontend/STORY-090-project-overview.md)…096 will fill.

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

**`T0i` is the exception, and it was not in the first draft.** `nominara-api` serves 19 routes and the app called nine; four of the other ten had a screen already built and fed by fixtures, so wiring them was hours rather than days — and one of them, the workspace switch, was not merely unwired but *wrong*: the client moved tenants while the server's token stayed pinned to the old one. Six more (members, roles, passkeys, OAuth link/unlink, invitation accept) are **not** in Slice 0: their screens are eight-line scaffolds, and building them is [STORY-096](./stories/frontend/STORY-096-settings-and-team.md) in Slice 5.

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

**Backend first**

| Story | What | Est. |
|---|---|---|
| [STORY-131](./stories/projects/STORY-131-guarded-fetcher.md) | **The guarded fetcher + registrable-domain normalisation (G7)** — extracted from STORY-049; STORY-043 AC7 cannot be met without it | 0.75d |
| [STORY-043](./stories/projects/STORY-043-url-only-project-creation.md) | URL-only project creation + the discovery pipeline | 2.5d |
| [STORY-044](./stories/projects/STORY-044-discovery-review-and-confirm.md) | Discovery review, confidence surfacing, confirm/override | 1.0d |
| [STORY-048](./stories/projects/STORY-048-domain-verification.md) | Domain verification — DNS TXT, well-known file, meta tag | 1.0d |

The `crawl.discover` queue handler lands with [STORY-043](./stories/projects/STORY-043-url-only-project-creation.md) — this is the first slice that proves `T0d`'s registry on a real job.

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

| Story | What | Est. |
|---|---|---|
| [STORY-034](./stories/capture/STORY-034-run-lifecycle-api-and-progress.md) | Run lifecycle API, progress projection, cancel, replay | 1.5d |

Its AC7 (pre-signed raw-capture URLs) is deferred on object storage — build the rest, tick eight of nine, record the gap. The capture queue handlers land here too, driving the fixture adapters from [STORY-027](./stories/capture/STORY-027-capture-adapter-contract-and-registry.md).

**Then the screen** — first-results progress in onboarding and the deep-scan control. ~1.0d.

**Settle §11 item 5 before this slice starts.** The realtime socket cannot authenticate today, and this is the first screen that genuinely needs it. Progress that only arrives on a poll is not the thing you are trying to look at.

**What you can see:** a progress bar moving on real events, six engines resolving through fixture adapters, and a run that completes `partial` rather than `failed` when one engine's circuit opens.

---

### Slice 4 — *"I can read the answer and see the score"* · ~20.0d · the big one

All of [EPIC-05](./epics/EPIC-05-parser-and-scoring-core.md). **Every backend story here is dangerous-area work** and takes a second-engineer review by an agent that did not author it; [`development-workflow.md`](./references/development-workflow.md) §3 requires tests first without exception.

**4a — the answer becomes structured** · ~5.0d

| Story | What | Est. |
|---|---|---|
| [STORY-035](./stories/parser/STORY-035-normalizer-and-span-map.md) | Normaliser, span map, `normalizer_version` | 1.0d |
| [STORY-036](./stories/parser/STORY-036-entity-matcher.md) | Entity matcher — Aho-Corasick, aliases, candidate discovery | 2.0d |
| [STORY-037](./stories/parser/STORY-037-citation-extraction-and-resolution.md) | Citation extraction, redirect resolution, classification | 2.0d |

[STORY-036](./stories/parser/STORY-036-entity-matcher.md) and [STORY-037](./stories/parser/STORY-037-citation-extraction-and-resolution.md) are file-disjoint and run in parallel after 035.

**Then the screen** — [STORY-091](./stories/frontend/STORY-091-prompts-matrix-and-answer-drawer.md)'s prompts matrix and the Live Answer drawer, ~2.5d. The drawer renders **only** from the stored offset map, never engine-supplied HTML, and its adversarial XSS fixture suite is blocking from the first commit.

**What you can see after 4a:** the matrix filling with real cells in their five states, and a real captured answer opening in the drawer with its entities and citations marked.

**4b — the answer becomes a number** · ~10.0d

| Story | What | Est. |
|---|---|---|
| [STORY-038](./stories/parser/STORY-038-sentiment-classifier-and-arbiter.md) | Sentiment — lexicon, heuristics, calibration, LLM arbiter | 2.5d |
| [STORY-039](./stories/parser/STORY-039-rendering-quality-extraction.md) | Rendering quality extraction and score | 1.5d |
| [STORY-040](./stories/parser/STORY-040-answer-structure-and-position-class.md) | Answer form and position-class classification | 1.5d |
| [STORY-041](./stories/parser/STORY-041-scoring-library.md) | Scoring library — prominence, SoV, Visibility Score, confidence | 2.5d |
| [STORY-042](./stories/parser/STORY-042-rollup-worker-metric-daily.md) | Rollup worker, `metric_daily`, dirty dates, denormalisation | 2.0d |

[STORY-038](./stories/parser/STORY-038-sentiment-classifier-and-arbiter.md), [STORY-039](./stories/parser/STORY-039-rendering-quality-extraction.md) and [STORY-040](./stories/parser/STORY-040-answer-structure-and-position-class.md) all follow [STORY-036](./stories/parser/STORY-036-entity-matcher.md) and are mutually parallel. [STORY-041](./stories/parser/STORY-041-scoring-library.md) needs all three.

Two things this must not get wrong, both named in the corpus as the highest-risk correctness bugs in the product: **an absent brand mention contributes 0 to share of voice and still counts in the denominator**, and **`null` is never stored or rendered as `0`**. Each needs its own dedicated test.

[STORY-038](./stories/parser/STORY-038-sentiment-classifier-and-arbiter.md)'s arbiter carries R-14 — a ≤400-character evidence span in a delimited, instruction-free envelope, constrained to an enum schema, no tools, no network, failing closed to `neutral`, with the 60-payload red-team fixture suite in CI.

**The golden-set gate has no runner and cannot get one here.** [STORY-106](./stories/launch/STORY-106-golden-set-corpus-and-fixtures.md) is deferred behind [STORY-028](./stories/capture/STORY-028-api-engine-adapters.md)/029 (§4). Build and run the fixtures the stories name; record explicitly that the *launch* accuracy gate is not yet enforceable. Do not approximate it with a weaker assertion.

**Then the screen** — [STORY-090](./stories/frontend/STORY-090-project-overview.md), Project Overview: per-engine and blended scores, the five metric cards, the Growth Map. ~2.5d. Its upstream [STORY-066](./stories/tasks/STORY-066-milestones-and-growth-map.md) (milestones) and [STORY-062](./stories/geo/STORY-062-geo-digest-and-top-levers.md) (Top Three Levers) are not built, so those two surfaces ship empty-stated rather than fixture-filled, and say why.

**What you can see:** a Visibility Score on screen that you can recompute by hand from an exported cell list and match **exactly to 1e-9**. That is the success metric this whole slice exists to prove.

---

### Slice 5 — *"I can see what it costs and what I have left"* · ~9.5d

**Backend first** — the buildable remainder of [EPIC-10](./epics/EPIC-10-entitlements-credits-billing.md), with [STORY-075](./stories/billing/STORY-075-stripe-subscriptions-and-webhooks.md), [STORY-076](./stories/billing/STORY-076-credit-packs-purchases-autotopup-addons.md) and [STORY-077](./stories/billing/STORY-077-downgrade-and-retention-policy.md) deferred per §4.

| Story | What | Est. |
|---|---|---|
| [STORY-071](./stories/billing/STORY-071-daily-cap-guard.md) | `DailyCapGuard` and daily action counters | 1.0d |
| [STORY-072](./stories/billing/STORY-072-credit-wallet-reserve-commit-release.md) | Credit wallet, reserve/commit/release, `CreditGuard` | 2.5d |
| [STORY-073](./stories/billing/STORY-073-credit-ledger-and-reconciliation.md) | Append-only ledger, reconciler, nightly replay | 2.0d |
| [STORY-074](./stories/billing/STORY-074-estimates-and-confirmed-credits.md) | Free estimates, confirmed-credits header, `price_changed` | 1.5d |

**[STORY-072](./stories/billing/STORY-072-credit-wallet-reserve-commit-release.md) carries an inherited obligation.** [STORY-070](./stories/billing/STORY-070-quota-guard-tier-caps.md) reserves a tier cap under the request's `Idempotency-Key` and **nothing commits or releases it** — settlement belongs in an interceptor beside `CreditInterceptor`, still [STORY-022](./stories/api/STORY-022-nest-bootstrap-and-module-skeleton.md)'s pass-through scaffold. No production route carries `@Meter` yet, so nothing is wrong today; the first one that does must land the settlement with it, and that route arrives here. **The 200-way concurrent debit test lands with [STORY-072](./stories/billing/STORY-072-credit-wallet-reserve-commit-release.md) or the story is not done.**

KAD-12 is the thing to hold: structural limits, feature flags, tier caps, daily caps and the wallet are **five separate mechanisms** producing five separately actionable failures — `402 insufficient_credits`, `403 entitlement_exceeded`, `403 feature_not_in_plan`, `429 quota_exceeded`, `429 daily_limit_reached`. Never collapsed, each asserted distinctly.

**Then the screens** — [STORY-096](./stories/frontend/STORY-096-settings-and-billing-surfaces.md)'s settings and billing surfaces, and the cost-confirmation modal the app already built against fixtures, wired to [STORY-074](./stories/billing/STORY-074-estimates-and-confirmed-credits.md)'s real estimates. ~2.5d.

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
2. **The embedding provider (`NEW-B`).** Drafted as [STORY-133](./stories/capture/STORY-133-embedding-client.md); **four decisions in it need you.** Adding a provider is adding a dependency, and [`development-workflow.md`](./references/development-workflow.md) §6 puts that outside what an agent may decide: which provider, which model, and does it need its own credential in the same conversation as [STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md)? **The schema has already narrowed it** — `1536` is hard-coded in six vector columns and two HNSW index definitions, so a 1536-dimension model is a config change and anything else is an expand/contract migration plus a reindex. The story also surfaces a genuine specification defect: `EC-23` says `embedding_model` is stored on **every** vector row, and three of the six tables — including `tracked_prompts`, the one carrying all three similarity thresholds — do not have the column. **Blocks Slice 2.**
3. **[STORY-001](./stories/preflight/STORY-001-vendor-accounts-and-engine-smoke.md) itself.** Seven stories sit behind it (§4) and the wait is external, not engineering. Every week it is not started is a week added to the end.
4. **`share_tokens.max_active` is a spec defect.** §9 of [`plans-and-entitlements.md`](./references/plans-and-entitlements.md) names it a structural limit; §2's matrix — which the seed reads — has only `share_links.enabled` with `"10_active"`/`"50_active"` strings. [EPIC-09](./epics/EPIC-09-action-plan-growth-map-alerts.md) must either add the key to §2 or rule that those strings are the cap.
5. **The realtime socket cannot authenticate.** `nominara-app` connects its socket directly to the API host, and the `__Host-`-prefixed session cookie does not travel there — recorded as an unresolved finding in the app's README and never escalated. Slice 3 is the first screen that genuinely needs it, and every realtime surface after it. It is a cross-repo design question (CORS and cookie scope, or a token handshake), not a bug either repo can fix alone, and it should be settled **before** [STORY-091](./stories/frontend/STORY-091-prompts-matrix-and-answer-drawer.md) wires live run progress.
6. **Does `nominara-web` start now?** It is gated only on [STORY-002](./stories/preflight/STORY-002-repositories-and-shared-ci.md) and shares nothing with either repo above, so it is the one thing that can genuinely run alongside without competing for attention. Left to the end it lands in the last two weeks, which is precisely R-15.

---

## 12. Stories this plan requires that do not exist yet

Both are now drafted into `stories/` and need signing off before implementation. Neither is scope creep — both are gaps that existing `Done` stories depend on.

**`NEW-A` — Seed the engine catalog** · ~0.5d · [EPIC-04](./epics/EPIC-04-capture-and-tracking-engine.md) · closes **G2** — **drafted as [STORY-130](./stories/capture/STORY-130-seed-the-engine-catalog.md)**
Ten rows: six active with the cadence from [`plans-and-entitlements.md`](./references/plans-and-entitlements.md) §11, four (`grok`, `copilot`, `meta_ai`, `deepseek`) seeded `status='disabled'` per [`tracking-engine.md`](./references/tracking-engine.md) §3. Acceptance as drafted, plus two the first draft of this plan missed: **a disabled engine is never scheduled even when a project enables it**, and `min_plan_key` is enforced independently of the cadence map. Six decisions in the story need sign-off — see §11.1.

**`NEW-B` — Embedding client** · ~1.0d · [EPIC-04](./epics/EPIC-04-capture-and-tracking-engine.md) · closes **G3** — **drafted as [STORY-133](./stories/capture/STORY-133-embedding-client.md)**
One provider client behind a port, called only from a queue handler — never from a request path (`NFR-ARCH-01`). Acceptance: `prompt_embedding` is populated on prompt activation; L2 semantic suppression fires against a real embedding in an integration test; `embed_tokens` metering records actual spend through the internal-cost path, which must never gate a customer request.

---

## 13. What "done" looks like for this plan

The P2 exit criterion, unchanged from the README: **a project created from a URL alone reaches a rendered, scored answer within the time-to-first-insight objective**, with a Visibility Score reproducible by hand from an exported cell list to 1e-9 — on fixture adapters, with the vendor swap a one-interface change whenever the accounts arrive.

Slices 0 through 4 deliver that. Slice 5 makes it sellable.
