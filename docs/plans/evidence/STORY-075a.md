# STORY-075a evidence (checkpoint-2 close-out)

Subscription checkout, billing portal, and subscription state reconciled from a fresh fetch. Spec: `test/integration/stripe-subscriptions.spec.ts` (S, 53 tests, exit 0 at HEAD), `src/lib/billing/stripe/subscription-state.spec.ts` (U). The money-path guards and their mutation proofs are in `NEW-D-2.md`; RED commits: 15da22b/bd26c2d (original), e419c3a (12 failed, exit 1), f645f8f (6 failed, exit 1).

| Criterion | Proof (S > test) | Status |
|---|---|---|
| AC1 / scenario 1: checkout and portal need billing:write; session carries client_reference_id and workspace metadata; no card data; entitlements resolve to the new plan after the webhook | "scenario 1 · checkout is billing:write only; owner and admin get a hosted URL, manager and viewer a 403 naming the permission"; "scenario 1 · the session carries client_reference_id inputs and the workspace in subscription metadata, prices from the catalog, and never a client-chosen redirect"; "scenario 1 · after the webhook, the subscription read and the entitlements resolve to the new plan"; "GET /billing/subscription is billing:read…"; "portal · …" (3 tests) | met |
| AC4 / scenario 5: every event re-fetches and writes the subscription whole through applyPlanChange with provider='stripe'; two events in either order give the same row | "scenario 5 · two events delivered in either order leave the same row"; "scenario 5 · the written state is Stripe's CURRENT state, not the state the event described" | met |
| AC6 / scenario 6: a plan change bumps entitlement_version; a stale token gets entitlement_stale | "scenario 6 · a plan change bumps entitlement_version and a token minted before it gets 401 entitlement_stale" | met |
| AC8 / scenarios 7, 8: upgrade immediate and idempotent with a pro-rata top-up from plan-grant; downgrade changes feature access only, structural reductions labelled deferred | "scenario 4 + 7 · a redelivered event is a no-op…"; "scenario 7 · an upgrade applies immediately with a pro-rata top-up from plan-grant, written once"; "scenario 8 · a downgrade changes feature access now and labels the structural reductions deferred…"; "scenario 8 · cancellation at period end only sets the flag…" | met |
| AC5: status, period boundaries, cancel_at_period_end, seats_purchased, projects_purchased synchronised | "scenario 8 · cancellation at period end…"; "scenario 5 · the written state is Stripe's CURRENT state…"; U > period and add-on quantity cases | met |
| AC13 / scenario 13: every state change writes an audit_log row, actor_type 'system' | "scenario 13 · every state change writes one audit row, actor_type 'system', carrying the Stripe event id"; "scenario 13 · creating a checkout or portal session is itself audited…" | met |
| plan-change-import-surface gate names exactly one importer (the webhook reconciler) | `test/unit/billing/plan-change-import-surface.spec.ts` (in the 3313-test unit run, exit 0) | met |
| STORY-151 invariant: no non-free plan with provider 'none' | "STORY-151 invariant · after webhook-driven changes no paid plan has provider 'none'" | met |
| Tenant isolation | "tenant isolation · a subscription event for workspace A writes nothing in workspace B" (runs as nominara_app) | met |
| Frontend: PlanSettings.tsx / onboarding startCheckout navigates to the Stripe URL; return state polls entitlements; demo route stops mutating the plan | **not done**: the app repo is outside this API lane. Needs the fe lane. | not met this week |
| Spans | deferred to week 2 by owner decision (2026-10-08) | deferred |

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
Checkout held the request's main-pool connection while taking a second one from the same pool for its two short writes, and waited on the workspace row lock without a bound: about 10 concurrent checkouts from one workspace emptied the pool and hung the API. Fix `bd443c2` (RED `8976cd1`, `eaf1971`): the writes use `BILLING_WRITE_POOL` (see `STORY-076b.md`, finding 2) and the lock wait is 3 s, then a retryable 409.
- Pool: integration `billing-pool-contention.spec.ts` "STORY-075a AC-pool-checkout" and "AC-pool-mixed" (RED: "the pool is deadlocked"; GREEN: 0).
- Bounded lock: unit `billing-subscription.service.spec.ts` "AC-checkout-lock" (RED 1 failed / 1 passed; mutation of dropping `lock_timeout` fails it).
- Gates: lint 0, typecheck 0, test:unit 0 (3802), isolation 0, 7 integration files 0 (239 passed). Details and mutations in `STORY-076b.md`.
