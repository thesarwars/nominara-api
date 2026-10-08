# NEW-D-2 evidence (checkpoint-2 close-out: the CP1 audit fixes)

Stripe gateway port and public webhook ingress, with the checkpoint-1 and audit fixes: per-subscription stale-fetch marks, prevented double checkout, plan verified against the charge, committed checkout intent with a replayable idempotency key.

Specs: `test/integration/stripe-webhook.spec.ts` (W), `test/integration/stripe-subscriptions.spec.ts` (S), `src/lib/billing/stripe/stripe-gateway.spec.ts` (G), `src/lib/billing/stripe/subscription-state.spec.ts` (U).

## RED commits (failing for the stated reason, re-run on Docker this pass)

| RED commit | Command | Result |
|---|---|---|
| e419c3a (CP1: stale-fetch resurrection, double checkout, plan/price, clock skew) | S at e419c3a, pre-fix src | exit 1, **12 failed**, 30 passed (42). Failures are the "CP1 BLOCKER", "CP1 MAJOR", "CP1 MINOR" tests, not setup errors. |
| f645f8f (audit: PROBE-A/B/C, frozen charge) | S at f645f8f, pre-fix src | exit 1, **6 failed**, 44 passed (50). Unit RED for the same commit: 4 failures (U). |
| 580ca7b and b39560a | the fix commits also carry unit specs; their RED is the two commits above | |

GREEN: S at HEAD exit 0, 53 passed (the 52 existing plus the test added in this pass).

## Acceptance criteria

| Criterion | Proof (file > test) | Status |
|---|---|---|
| AC2 raw body only on the webhook route; other JSON routes still validate | W > "scenario 14 · another JSON route still validates strictly and still receives parsed JSON"; "scenario 14 · the webhook route's own body, once parsed, is untouched by the raw capture" | met |
| Scenarios 2, 3 bad/missing/stale signature is 400 and writes nothing; valid is processed | W > "scenario 3 · a valid signature is processed…", "scenario 2 · …wrong secret…", "…missing Stripe-Signature…", "…body tampered…", "…outside the 300 s tolerance…"; G > the same five | met |
| AC3 / scenario 4 duplicate event is a no-op; dedupe and effect share one transaction | W > "scenario 4 · the same event delivered twice is a no-op…", "scenario 4 · eight concurrent deliveries…", "AC3 · the claim and the effect are ONE transaction…", "AC3 · after a failed attempt, Stripe's redelivery…is processed" | met |
| AC12 / scenario 12 unresolvable workspace is warn + 2xx | W > "scenario 12 · an object with no workspace_id is acknowledged 2xx, logged at warn…", "scenario 12 · an object Stripe no longer has…" | met |
| Workspace only from the freshly fetched object's metadata; writes in `withTenantContext` as nominara_app | W > "the workspace comes from the re-fetched object's metadata — the event payload's claim is ignored", "the handler's transaction carries the workspace's tenant context as nominara_app, and RLS hides the other tenant", "the handler cannot write into another tenant…", "no tenant context leaks onto the pooled connection afterwards" | met |
| Route is @Public() and @SkipTenantContext(), listed with a reason | W > "the route is @Public() and @SkipTenantContext()…"; test/unit/route-permission-coverage.spec.ts lists `POST /v1/webhooks/stripe (NEW-D-2)` with its reason | met |
| STRIPE_* optional secrets; no log or error contains them; unconfigured is 503 | G > "a refused signature carries neither secret…", "an upstream failure carries a status code and nothing else", "the adapter never writes to the console at all", "with no webhook secret configured nothing verifies"; W > "with Stripe unconfigured every delivery is a 503 degraded and nothing is written", "a refused signature logs a warn line…with no signature material" | met |
| StripeGateway port, HTTP adapter and fake adapter; no test calls real Stripe | `src/lib/billing/stripe/stripe-gateway.ts`, `stripe-http.gateway.ts` (stripe 23.0.0, pinned), `test/support/fake-stripe-gateway.ts`; every spec overrides `STRIPE_GATEWAY` | met |

## Checkpoint-1 and audit findings (money path), each with a test that fails when its guard is removed

Mutation method: apply the one-line mutation to the guard, run the spec, expect red, `git checkout` the file. All run on a clean tree on this branch; the file was verified restored after each.

| Finding | Guard (file) | Mutation | Tests that go red (S) |
|---|---|---|---|
| BLOCKER stale fetch resurrects a cancelled subscription | per-subscription mark, `stripe-subscription.handler.ts` | stale check made `if (false)` | "CP1 BLOCKER · a cancelled NEW subscription's held 'active' fetch…", "CP1 BLOCKER · the same through checkout.session.completed…", "audit · a fetch taken before a newer event committed cannot overwrite it" (3) |
| same | mark recorded whether or not the row adopts it | the INSERT made to write nothing | the same 3 |
| MAJOR double checkout | previous session expired before the next exists | previous session id forced to null | 6: PROBE-B, "retry asks for a DIFFERENT plan", "write that recorded the session is lost too", "previous session already PAID is a 409", "opening a second checkout expires the first", "two checkouts opened at the same moment" |
| same | row lock serialises checkouts | `FOR UPDATE` removed | "two checkouts opened at the same moment leave exactly one payable session" |
| same | paid previous session is a 409 | check made `if (false)` | "a previous session that was already PAID…is a 409" |
| same | already-subscribed workspace refused | check made `if (false)` | 2: "a workspace already subscribed through Stripe is told to use the portal (409)", "the 409…does not send plan changes to the portal" |
| audit PROBE-B intent committed before Stripe | pending_checkout write | the write made a no-op | 15 tests |
| audit replay of a lost intent | replay branch | removed | "even when the write that recorded the session is lost too, the retry replays the intent…" |
| audit replayable idempotency key | `subscription-checkout-${intent.id}` | random key | the same test |
| MAJOR plan trusted from metadata | `chargedPriceMatches` gate, `subscription-state.ts` | gate made `if (false)` | 8: "metadata that names a dearer plan…", "portal price switch…", "monthly amount on a yearly price", "amount of another plan", "right amount in the wrong currency", and three audit tests |
| audit PROBE-C catalog change must not freeze existing subscriptions | frozen charge wins over catalog | frozen ignored | 3: PROBE-C, "checkout paid after the catalog moved is adopted at the price it was opened at", "catalog's NEW price is still not accepted…" |
| audit frozen charge bound to its plan | `row.plan_key === planKey` | removed | 4 (incl. "a frozen charge belongs to the plan it was frozen for") |
| audit pending intent honoured only for the subscription it named | `pending.data.id === metadata.checkout_intent_id` | removed | **this mutant SURVIVED the existing suite** (exit 0). Fixed in this pass: new test "AUDIT MAJOR · the frozen price of a pending checkout is honoured only for the subscription that checkout named…" fails against the mutant (1 failed) and passes on HEAD. |
| double live subscription | different-subscription guard | made inert | "audit · two live Stripe subscriptions for one workspace…" |
| stale ended subscription must not take the plan | free-from-old-subscription guard | removed | "a late event for an OLD, ended subscription cannot take the plan away from the newer one" |
| MINOR clock skew between instances | the DB-clock `fetchStartedAt` (`SELECT clock_timestamp()`) | RED proof is the e419c3a run above, where "CP1 MINOR · the stale guard is ordered by the database clock…" is one of the 12 failures; it passes at HEAD | |

### MINOR: "the stale-fetch test is an intermittent detector" (investigated)
Test: S > "audit · a fetch taken before a newer event committed cannot overwrite it". It holds event A's fetch behind a gate, sleeps 20 ms, delivers B, then releases A. `fetchStartedAt` comes from the database's `clock_timestamp()`, so the 20 ms gap makes A's mark strictly older than B's regardless of host clock. Measured: with the stale check mutated to `if (false)`, **6 of 6 runs red**; on the unmutated code **6 of 6 runs green**. It is deterministic in both directions, so it is not an intermittent detector.

### MINOR: ISO-13/ISO-14 scanner gap for keys built with `+` (recorded, not fixed here)
`test/isolation/support/key-construction-scanner.ts` matches template-literal key shapes by regex per line; a cache or object-storage key built with `+` concatenation passes ISO-13/ISO-14 unseen (checkpoint-1 showed commits 96d7ce8, 86a3ec1 and fb50262 rewriting `${x}T…` as `x + "T…"` to get past it). That file belongs to STORY-012 and is outside this lane's story; it needs its own story (scan `+` and `concat`/`join` shapes, with a good and a bad fixture). This lane has no such key.

### Not addressed / open, stated
- `sweepStripeWebhookEvents` (30-day retention) is still not scheduled by any job. Scheduling needs a job registration outside this story's files. The sweep itself is tested (W > "retention…"). Needs a story.
- The header comment of migration 0049 says NEW-D-1; it is an applied migration and is not hand-edited.
- Migrations 0074 (stripe_subscription_syncs), 0075 and 0077 (checkout intent columns) were added by this lane's CP1/audit fixes beyond the plan's "migrations: none expected". QA asked for written owner sign-off; none is recorded in the task text. **Needs owner confirmation.**

## Observability
- Metrics: `nominara_billing_stripe_webhook_events_total`, `nominara_billing_subscription_reconcile_total`, `nominara_billing_checkout_session_total`, `nominara_billing_plan_price_mismatch_total`, `nominara_billing_double_subscription_total`. W > "the outcome counter is emitted for a processed event".
- Log lines carry the workspace ID only: W > "the unauthenticated warn log carries the workspace ID and never its name or raw Stripe text".
- **Spans: not added.** OpenTelemetry spans are deferred to week 2 by owner decision (2026-10-08); a missing span is not a failed criterion this week.
- Evidence that needs a running real API (live signed delivery against a running process) is collected in NEW-A-17, not here.

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
