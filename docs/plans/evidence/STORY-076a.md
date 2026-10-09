# STORY-076a evidence (checkpoint-2 close-out)

Credit packs: tier-filtered catalog, purchase through Stripe Checkout, credits only on the verified webhook. Spec: `test/integration/credit-packs.spec.ts` (P, 25 tests, exit 0 at HEAD).

## RED commits
| Commit | What | Result |
|---|---|---|
| 1848b69 | RED tests for catalog, purchase and settlement (no controller, no handler yet) | P at 1848b69: exit 1, **20 failed** (`Cannot POST /v1/billing/credit-packs/starter_vault/purchase` 404 and the missing catalog route) |
| 13d7592 | audit fix (row committed before Stripe, paid orphan is an error alarm); its tests were added in the same commit | P at 13d7592 with the PRE-fix `src/` restored from 13d7592^: exit 1, **2 failed, 23 passed** ("AUDIT BLOCKER (PROBE-A)…", "AUDIT BLOCKER · a PAID session that names a purchase the workspace has no row for is an error-level alarm…") |
| this pass | scenario 5 and the exact rate-limit assertion | RED shown by mutation (below), not a separate commit |

## Acceptance criteria
| Criterion | Proof (P > test) | Status |
|---|---|---|
| AC1 / scenario 1: catalog is purchasableOptions() filtered to the tier in SQL; a pack above the tier is 403 before any Stripe call | "scenario 1 · the catalog is filtered to the tier in SQL: free sees only starter_vault, growth sees both…"; "scenario 1 · a pack above the tier is a 403 feature_not_in_plan BEFORE any Stripe call and any row"; "scenario 1 · an unknown pack is a 404"; "scenario 1 · a viewer may read the catalog but not buy (403 naming billing:write)". Mutation: tier check made `if (false)` fails the above-tier test. Also `test/integration/credit-guard-settlement.spec.ts` > "the refusal carries the required amount, the bucket split and the tier-filtered packs" (see CP2-d-billing-fixes.md) | met |
| AC2 / scenario 2: pending row with purchased_by, session carries workspace_id and purchase_id, wallet and ledger unchanged | "scenario 2 · a purchase inserts a pending credit_purchases row, creates the session with workspace and purchase ids, and moves no credits"; "scenario 2 · a Stripe outage is a 503…" now also asserts the upstream-failed row is positively `failed` (QA gap: nothing asserted it) | met |
| AC3 / scenario 3: one 'purchase' ledger entry keyed by the PaymentIntent id; succeeded with expires_at = paid + 12 months; redelivery is a no-op, twice and concurrently | "scenario 3 · on success one 'purchase' ledger entry keyed by the PaymentIntent id lands…and replay stays green"; "scenario 3 · the same event delivered twice, and the same payment arriving as a different event, credit exactly once"; "scenario 3 · eight concurrent deliveries…". Mutations: terminal-status check removed (2 red), `FOR UPDATE` removed (1 red). `paid_at` has no column; `expires_at = now() at settlement + 12 months` stands in (unchanged, stated) | met |
| Payment failure: marked failed, no credits move, a later success still settles, a failure never undoes a success | "on payment failure the purchase is marked failed and no credits move; a later successful retry of the same payment still settles"; "a failure event can never undo a purchase that already succeeded"; "an unpaid session (payment_status != paid) credits nothing". Mutation: failure-guard removed, 1 red | met |
| AC5 / scenario 5: on a daily-capped tier a purchase followed by exceeding the cap is still refused | **Rewritten this pass.** "scenario 5 · on a daily-capped tier, a purchase followed by exceeding the daily cap is still refused BY DailyCapGuard at the tier's resolved limit…": real DailyCapGuard, real EntitlementResolver, free tier's own limit of 3 (the test chooses none), three guard passes, purchase and settlement (purchased_balance 1000), fourth pass rejects with `daily_limit_reached` {used 3, limit 3}, counter still 3. Mutation: settlement deleting the workspace's `credit_daily_counters` fails it (1 red). No route in src carries `@DailyCap` yet, so the guard is driven directly rather than over HTTP | met |
| Amount credited comes from the credit_purchases row, never the payload | "the amount credited comes from the credit_purchases row, never the payload: forged metadata credits cannot raise it"; "fail closed · a charged amount that differs from the purchase row credits nothing and is alarmed". Mutations: credits from payload (1 red), mismatch check disabled (1 red) | met |
| Idempotency-Key required; rate limit 5/hour | "the Idempotency-Key header is required on the purchase POST (400), and a body key is a 400 (.strict())". Rate limit: P > "the purchase route is rate limited…" is now exact: statuses are `[200, 200, 429 x6]` (the route class bursts at 2); the 5/hour user and 10/hour workspace buckets are pinned in `test/unit/rate-limit-buckets.spec.ts` ("credit_pack_purchase / user is 5 per 3600000 ms", "…/ workspace is 10…", "bursts at 2"). The old "at most 5" assertion would also pass with a lower limit; replaced | met |
| AC14: the purchase and its settlement each write an audit row | "scenario 14 · the purchase and its settlement each write an audit row against the purchase"; "a failed settlement writes its own audit row" | met |
| Nightly replay verifier stays green | the scenario 3 test calls `verifyWorkspaceWallet` and expects null after settlement | met |
| Cross-workspace | "a purchase id that belongs to ANOTHER workspace credits nothing (RLS), whatever the metadata claims" (nominara_app) | met |
| Crash after Stripe: a payable session never exists without its purchase row (audit BLOCKER) | "AUDIT BLOCKER (PROBE-A)…", "AUDIT BLOCKER · a PAID session that names a purchase the workspace has no row for is an error-level alarm…", "AUDIT BLOCKER · a Stripe failure after the row was committed leaves no PENDING row…". Mutation: the pending insert moved into the request transaction fails 2; alarm downgraded to warn fails 1 | met |
| Migration 0076 pack values | The task's owner decisions (2026-10-08) approve exactly starter_vault 1,000 credits at $15 (every tier) and agency_vault 5,000 credits at $50 (growth and above). `0076_seed_credit_packs` matches them and its header already says so; the down only deletes packs no purchase references. Up/down is exercised by test/integration/migrations.spec.ts (exit 0) | met |
| DoD 11 runbook for the new money alarms | `docs/runbooks/billing-money-alarms.md` covers `nominara_billing_credit_pack_orphan_payment_total`, `nominara_billing_plan_price_mismatch_total`, `nominara_billing_double_subscription_total` (meaning, severity, steps) | met |
| Frontend: BillingSettings.tsx redirect to checkout_url, remove the "<n> credits added" toast, poll the wallet; demo purchase route returns pending | **not done**: the app repo is outside this API lane; today's UI still claims credits that have not landed. Needs the fe lane | not met this week |
| Spans | deferred to week 2 by owner decision (2026-10-08); metrics (`nominara_billing_credit_pack_purchase_total`, `…_settlement_total`, `…_orphan_payment_total`) and redacted logs are tested by "emits the purchase and settlement counters, and the log lines carry the workspace id and no PII or Stripe text" | deferred |

Evidence that needs a running real API (a real signed Stripe delivery against a live process) is collected in NEW-A-17.

## Gate commands (worktree api-wt-d1, branch 7day/d-billing-3, base integration/7day f201f35)

| Command | Exit | Result |
|---|---|---|
| `pnpm lint` | 0 | clean |
| `pnpm typecheck` | 0 | clean |
| `pnpm test:unit` | 0 | 277 files passed, 1 skipped; 3313 tests passed, 1 skipped |
| `pnpm exec vitest run --config vitest.integration.config.ts` on credit-guard-settlement, credit-ledger-schema, track-e-sharing-migration, credit-packs, stripe-subscriptions, stripe-webhook, migrations, credit-settlement, credit-wallet | 0 | 9 files, 205 tests passed |
| `pnpm test:isolation`, `pnpm test:isolation:breakers` | not run | known to crash in fixture setup (support_grants 24 h TTL vs ck_support_ttl_max); the d-admin lane fixes it and the merge step runs them. Tenant isolation for this story is instead proven under `nominara_app` in the integration specs named below. |
| Docker env for the integration run | | `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock TESTCONTAINERS_RYUK_DISABLED=true` |

No contract, schema or migration changed in this checkpoint-2 pass, so `contracts:generate`, `db:rls-generate` and the drift checks have nothing new to regenerate.

## Checkpoint-4, fix pass 2 (lane 7day/d-billing-5)
The credit-pack purchase takes no lock but shared checkout's hold-and-wait shape (main-pool connection held while `pool.connect()` on the same pool for the pending-row insert): about 10 concurrent purchases from different workspaces deadlocked the pool. Fix `bd443c2` (RED `8976cd1`): the insert and the `failed` mark run on `BILLING_WRITE_POOL`. Proof: integration `billing-pool-contention.spec.ts` "STORY-076a AC-pool-pack" (14 concurrent purchases; RED: "the pool is deadlocked") and "AC-pool-mixed". `credit-packs.spec.ts` (incl. the killed-connection test) passes unchanged. Gates and mutations in `STORY-076b.md`.
