# ADV-1 evidence (checkpoint-3 blocker, lane d-billing, branch `7day/d-billing-4`)

Finding: a retried add-on purchase whose first attempt failed was answered 202 `pending` but never sent to Stripe if another purchase landed in between, because "already applied" was inferred from `heldQuantity >= target_total`. `BillingAddonsService.add`, `src/modules/billing/billing-addons.service.ts`.

## Commits
- RED `75bceda` test(billing): ADV-1 — 5 new integration cases.
- Contract `f789cd6` — `pendingAddonChangeSchema` gains optional `settled_at` (internal jsonb shape; added optional field = minor; `contracts:check` exit 0, no OpenAPI drift).
- Fix: `fix(billing): ADV-1 checkpoint-3 — ...` (this file ships with it).

## RED (at 75bceda, `vitest run --config vitest.integration.config.ts test/integration/billing-addons.spec.ts`)
3 failed | 42 passed, for the stated reason: "the retried purchase was answered 202 but never sent to Stripe: expected 1 to be 2"; the +2/+1 case ended at 2, not 3 (stale lower total); the "unresolved earlier purchase" case got 202, not 409. The other two new cases (settled retry; 4xx release) already held on the old code and are regression guards.

## Fix (option b, local marker)
- Applied-ness is the intent's `settled_at`, written (own short tx) only after Stripe accepted that very change. A settled retry returns `replayed_applied` with no Stripe call, whatever the held quantity is now. The `heldQuantity >= target` inference is deleted.
- An unsettled retry (outcome unknown) re-sends the STORED total under the STORED Stripe key; Stripe replays its own answer for a key it has seen.
- A NEW purchase while an unsettled, unexpired intent of the same kind exists is `409 conflict` (metric outcome `earlier_change_unresolved`), so a retried +2 can never be overtaken by a +1 and no total is ever stale. An unsettled intent older than 24 h (Stripe's key retention) neither blocks nor can be retried (409, `intent_expired`).
- A definite Stripe rejection (4xx except 408, 409, 429) releases the intent so it does not block the customer.
- Intent map still capped at 20 (the trimmed map is what is persisted at settle).

## Acceptance criteria -> tests
| Criterion | Test |
|---|---|
| Every ACCEPTED +1 lands once (first attempt fails, B lands, A retries) | integration `billing-addons.spec.ts` > "ADV-1 . a retried purchase whose first attempt failed is never answered 202 unsent: every ACCEPTED +1 lands once ..." |
| A asks +2, B adds +1, A retries: no stale lower total; final = sum of accepted adds | "ADV-1 . A asks +2, B adds +1, A retries: ..." |
| New purchase while an earlier is unresolved: 409, no Stripe call; earlier retry lands; then purchases resume | "ADV-1 . a new purchase while an earlier one for the same kind is unresolved is a 409 ..." |
| Settled retry after another purchase: no Stripe call, total not lowered | "ADV-1 . a SETTLED purchase retried after another purchase moved the quantity ..." |
| Definite 4xx rejection releases the intent; next purchase derives a different Stripe key | "ADV-1 . a purchase Stripe REJECTED outright (4xx) is released ..." |
| Settled marker written; settled retry makes no call (unit) | `billing-addons.service.spec.ts` > "ADV-1 . a SETTLED intent retried is answered with NO Stripe call ..." |
| Existing "every accepted add lands once" under 12 concurrent POSTs | "audit . concurrent POSTs with DISTINCT Idempotency-Keys ..." (unchanged, green) |

## Existing tests whose assumption the decision outdated (property kept, setup changed)
- integration "AC1 retry . a create that FAILS without changing Stripe ...": its last step sent a DIFFERENT key while the first attempt was unresolved and expected a 503 attempt. That is exactly what ADV-1 forbids, so it now expects 409 and no attempt; the "different purchase derives a different Stripe key" property is proved by the 4xx-release case.
- integration "AC1 retry . Stripe APPLIED the change and the reply was lost": unchanged and green.
- unit `billing-addons.service.spec.ts`: "reply is lost" retry now re-sends under the same Stripe key (calls 2, identical, one unit) instead of asking for nothing; "committed BEFORE Stripe" now expects intent, stripe, intent (settle); AC13 "retry of a POST that already landed" fixture carries `settled_at`.
- `test/support/fake-stripe-gateway.ts`: the success path now replays a repeated idempotency key instead of applying it twice, as Stripe does (the failure path already did).

## Gates (all read from exit codes)
- `pnpm lint` exit 0 · `pnpm typecheck` exit 0 · `pnpm test:unit` exit 0 (302 files passed, 3702 tests passed, 1 skipped)
- integration (exit 0, 230 passed): billing-addons, billing-invoices, auto-topup-trigger, credit-packs, stripe-webhook, stripe-subscriptions
- `pnpm contracts:check` exit 0. `test:isolation` not run: no table, policy or tenant-scoped query changed (jsonb value on an existing column only).

## Notes
- Intents written before this change have no `settled_at`; they read as unresolved for up to 24 h. Nothing is deployed with such rows.
- Option (a) (intent id in Stripe metadata) was not chosen: it needs gateway-interface, real-gateway and fetch-expansion changes that cannot be verified without the sandbox.
