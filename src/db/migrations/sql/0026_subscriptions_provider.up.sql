-- STORY-151 — where a subscription's plan came from.
--
-- ⚠ THIS IS A DETECTIVE CONTROL, AND IT EXISTS BECAUSE PREVENTION DOES NOT
-- REACH EVERYTHING. STORY-151's safety property is an absence: `applyPlanChange`
-- is imported by no controller, guard, interceptor or queue handler, so no HTTP
-- request can reach a statement that writes a paid `plan_key`. That is strong
-- against a customer and says nothing about a raw UPDATE, a staging dump
-- restored over production, or a self-service route merged in a hurry.
--
-- RLS is NOT the control here and this comment will not pretend it is:
-- `ws_isolation_workspaces` is `USING (id = app.current_workspace())`, so a
-- workspace updating its OWN plan_key under its own tenant context passes.
-- test/isolation asserts that it succeeds, by name, so no future reader rests
-- a safety argument on a mechanism that does not provide one.
--
-- `applyPlanChange` is the only writer of this column and always sets it. So
-- the invariant below holds by construction, and any paid row that did not come
-- through it is `provider = 'none'` and names its own workspace.
--
-- DEFAULT 'none' RATHER THAN 'operator' IS LOAD-BEARING. WorkspacesService.create
-- writes every subscription with synthetic `local_cus_<ws>` / `local_sub_<ws>`
-- ids on the free plan; leaving those at 'none' keeps a free placeholder
-- distinguishable from a granted plan. And because nothing in this codebase has
-- ever changed a plan, no backfill is needed — the invariant is 0 on day one.
ALTER TABLE subscriptions
  ADD COLUMN provider text NOT NULL DEFAULT 'none'
    CHECK (provider IN ('none', 'operator', 'stripe'));

COMMENT ON COLUMN subscriptions.provider IS
  'Who last wrote this subscription''s plan. STORY-151 invariant, checkable as a query: '
  'SELECT count(*) FROM subscriptions WHERE plan_key <> ''free'' AND provider = ''none'' '
  'must be 0 — a paid plan that did not come through applyPlanChange has no provenance. '
  'STORY-075''s nightly drift job must filter WHERE provider = ''stripe'', or it alerts on '
  'every workspace ever created, whose local_cus_/local_sub_ ids are synthetic placeholders.';

-- A partial index that is EMPTY while the invariant holds, so the check above
-- is an index-only scan over nothing rather than a sequential scan of the table.
CREATE INDEX ix_subscriptions_unvouched
  ON subscriptions (workspace_id)
  WHERE provider = 'none' AND plan_key <> 'free';
