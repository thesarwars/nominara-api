# Carry to the docs repo: STORY-076 (add-ons), decided 2026-10-08, built in STORY-076b checkpoint-3

- `POST /v1/billing/addons`: `quantity` is the number of units to ADD to the held quantity (not a total). Held plus added may not exceed 100.
- Retry safety is the chain Idempotency-Key -> stored intent -> Stripe idempotency key. The intent (kind, units, resulting total, Stripe key) is committed before Stripe is asked, so a retry after Stripe applied the change adds nothing. The same key with a different kind or quantity is `409 idempotency_conflict`.
- Annual subscriptions: `409` until week 2 (no annual add-on price is decided).
- `GET /v1/billing/addons` returns the purchasable catalog with prices: one item per add-on kind, with `quantity` 0 when the workspace holds none, and `purchasable` from the plan.
- A request that cannot get the workspace lock within 3 seconds is a retryable `409` (not a queue without end).
