# Runbook: `pnpm plan:set` (operator plan comp)

`plan:set` writes a workspace's plan from the shell (STORY-151). It is **blocked on a workspace whose subscription is Stripe-tracked**
(STORY-184, owner decision 2026-10-16).

## When it refuses

```
refusing: workspace <id> is billed through Stripe (live subscription on '<plan>'). ...
```

The check is `subscriptions.provider = 'stripe'` with a live status (`trialing`, `active`, `past_due`) and a plan other than `free`.
It runs inside the same transaction as the plan write.

**Why.** The Stripe webhook accepts a plan change on a tracked subscription only through the workspace's own recorded plan-change
intent. A comp written over a tracked subscription is invisible to Stripe, so the next event for that subscription would be refused as
a relabel and the workspace's reconciliation would stay frozen (plan, add-ons, cycle roll).

## What to do instead

| Situation | Action |
|---|---|
| The customer wants a different paid plan | They use the in-app plan change (Settings > Plan). |
| Support must move a paying customer | Change the subscription in Stripe **and** keep its metadata consistent (`plan_key`), or ask engineering to record the intent; do not comp. |
| The customer should stop paying and be comped | Cancel the Stripe subscription first. Once the webhook has reconciled it to `free` (the row keeps `provider = stripe`), `plan:set` is allowed again. |
| A workspace with no Stripe subscription (trial, partner, internal) | `plan:set` as before. |

## Not blocked

An ended Stripe subscription (reconciled to `free`), an operator-comped workspace (`provider = operator`), a workspace with
`provider = none`, and a workspace with no subscription row.
