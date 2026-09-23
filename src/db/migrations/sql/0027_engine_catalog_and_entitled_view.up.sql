-- STORY-152 — the engine catalog, and how a project resolves its engines.
--
-- ⚠ THE CATALOG BEING EMPTY IS WHY NO SCHEDULED TRACKING RUN HAS EVER HAPPENED.
-- `resolveDueEngines` fails closed on a missing cadence entry by design, so an
-- empty `engines` means the scheduler covers zero engines for every project in
-- every environment. STORY-033 is Done with all ten criteria met and its AC4 is
-- inert; so is every capture story behind it. `engine-cadence.ts` says so in a
-- comment rather than papering over it with a fallback, which is why this is a
-- seed with a sign-off and not an INSERT somebody adds in passing.
--
-- Every number below is transcribed from plans-and-entitlements.md §11 and
-- tracking-engine.md §3/§5. Nothing is rounded, harmonised or inferred.

-- ---------------------------------------------------------------------------
-- The ten permitted engine keys.
-- ---------------------------------------------------------------------------
--
-- ⚠ `cadence_by_plan` IS AN INTERVAL DIVISOR, NOT A RUN COUNT, and that settles
-- the one number the references appear to disagree about. `engine-cadence.ts`
-- computes `intervalMs = CYCLE_MS / runs_per_cycle`, so the value answers "how
-- often", not "how many". The schema doc's worked example and §5's table both
-- say `priority: 26` for business — but 26 over a 30-day cycle is a 27.7-HOUR
-- interval, so a "daily" priority capture would slide four hours later every
-- day and sample a different diurnal slice each time. That is precisely the
-- drift §5's jitter budget exists to prevent. 30 gives exactly 24h.
--
-- ⚠ AND `plans.entitlements` NEEDS NO AMENDMENT, which is the trap next to it.
-- `scan.runs_per_cycle: "4_full_plus_26_priority"` counts distinct RUN-DAYS:
-- 4 full-set days + 26 priority-only days = 30 days, exactly as §5's prose
-- says. Two vocabularies, both correct. "Correcting" that published plan claim
-- to 30 would turn it into an overclaim of 34 runs.
--
-- ⚠ ENTERPRISE FULL-SET IS 30, NOT 4. §5: "720 priority + 30 full-set —
-- hourly on the priority subset; daily full-set across all engines". STORY-130
-- proposed `full: 4` inside DECISION 1's table; that under-delivers the
-- enterprise full set by 26 runs per cycle against a documented envelope.
--
-- ⚠ NO `free` KEY ON ANY ENGINE. §11 gives perplexity and chatgpt "tools only"
-- on free, and `resolveDueEngines` fails closed on a missing entry — so free
-- SCHEDULES nothing, which is what "tools only" means. Reachability from the
-- tools surface is carried by `min_plan_key`, not by the cadence map.
INSERT INTO engines
  (key, display_name, vendor, capture_mode, adapter_version, model_fingerprint,
   supports_citations, cache_ttl_seconds, volatility_band, min_plan_key, cadence_by_plan, status, legal_review_ref)
VALUES
  -- The six active engines. `adapter_version` is '0.1.0' for all of them: it is
  -- customer-visible provenance that each adapter's own story bumps when its
  -- capture behaviour changes, and seeding the version an adapter WILL have
  -- would record a version for code that does not exist. `model_fingerprint`
  -- stays NULL — it is vendor-reported at capture time, and inventing one puts
  -- a false fingerprint on the drift input.
  ('perplexity',     'Perplexity',   'Perplexity', 'api',           '0.1.0', NULL, true, 28800, 'high',      'free',
   '{"starter":{"full":4},"growth":{"full":8},"business":{"full":4,"priority":30},"enterprise":{"full":30,"priority":720}}'::jsonb, 'active', NULL),
  ('google_aio',     'AI Overviews', 'Google',     'licensed_serp', '0.1.0', NULL, true, 14400, 'very_high', 'starter',
   '{"starter":{"full":4},"growth":{"full":8},"business":{"full":4,"priority":30},"enterprise":{"full":30,"priority":720}}'::jsonb, 'active', NULL),
  ('google_ai_mode', 'AI Mode',      'Google',     'licensed_serp', '0.1.0', NULL, true, 14400, 'very_high', 'growth',
   '{"growth":{"full":8},"business":{"full":4,"priority":30},"enterprise":{"full":30,"priority":720}}'::jsonb, 'active', NULL),
  ('chatgpt',        'ChatGPT',      'OpenAI',     'api',           '0.1.0', NULL, true, 43200, 'high',      'free',
   '{"starter":{"full":4},"growth":{"full":8},"business":{"full":4,"priority":30},"enterprise":{"full":30,"priority":720}}'::jsonb, 'active', NULL),
  ('gemini',         'Gemini',       'Google',     'api',           '0.1.0', NULL, true, 28800, 'high',      'business',
   '{"business":{"full":4},"enterprise":{"full":30}}'::jsonb, 'active', NULL),
  ('claude',         'Claude',       'Anthropic',  'api',           '0.1.0', NULL, true, 86400, 'medium',    'business',
   '{"business":{"full":4},"enterprise":{"full":30}}'::jsonb, 'active', NULL),

  -- ⚠ THE FOUR DISABLED ENGINES EXIST SO THAT `status` IS THE ENABLING
  -- MECHANISM, rather than a later migration that adds a row. tracking-engine.md
  -- §3 describes them as existing. `capture_mode`, `volatility_band`,
  -- `cache_ttl_seconds` and `supports_citations` are NOT NULL and no reference
  -- states them, so these are PLACEHOLDERS on rows that cannot be scheduled or
  -- captured while disabled — to be replaced by whichever story enables each
  -- engine. Flagged here rather than quietly chosen, because a placeholder that
  -- outlives its story becomes a fact nobody remembers deciding.
  --
  -- `min_plan_key` is `enterprise` — the most restrictive floor — so that
  -- flipping `status` alone still exposes an engine to nobody, and an empty
  -- `cadence_by_plan` means nothing schedules it either. Two independent locks.
  ('grok',     'Grok',    'xAI',       'api', '0.1.0', NULL, true, 28800, 'high', 'enterprise', '{}'::jsonb, 'disabled', NULL),
  ('copilot',  'Copilot', 'Microsoft', 'api', '0.1.0', NULL, true, 28800, 'high', 'enterprise', '{}'::jsonb, 'disabled', NULL),
  ('meta_ai',  'Meta AI', 'Meta',      'api', '0.1.0', NULL, true, 28800, 'high', 'enterprise', '{}'::jsonb, 'disabled', NULL),
  ('deepseek', 'DeepSeek','DeepSeek',  'api', '0.1.0', NULL, true, 28800, 'high', 'enterprise', '{}'::jsonb, 'disabled', NULL)
-- Idempotent, so re-running the seed against an environment that already has
-- rows is safe. ⚠ CADENCE CHANGES AFTER THIS ARE NEW MIGRATIONS, NOT EDITS TO
-- THIS ONE: `projects.cadence` carries a trigger recording changes for chart
-- annotation (STORY-033 AC10), and a silently edited seed would leave that
-- annotation unexplained.
ON CONFLICT (key) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  vendor            = EXCLUDED.vendor,
  capture_mode      = EXCLUDED.capture_mode,
  adapter_version   = EXCLUDED.adapter_version,
  supports_citations= EXCLUDED.supports_citations,
  cache_ttl_seconds = EXCLUDED.cache_ttl_seconds,
  volatility_band   = EXCLUDED.volatility_band,
  min_plan_key      = EXCLUDED.min_plan_key,
  cadence_by_plan   = EXCLUDED.cadence_by_plan,
  status            = EXCLUDED.status,
  updated_at        = now();

-- ---------------------------------------------------------------------------
-- How a project resolves its engines: it does not GET them, it DERIVES them.
-- ---------------------------------------------------------------------------
--
-- ⚠ THERE IS NO WRITER, AND THAT IS THE DESIGN. Three designs were built and
-- judged. The two that write `project_engines` rows at project creation both
-- lose to the same fact: of the six production readers of `project_engines`,
-- only TWO carry the plan floor (`plan-cells.ts`, `engine-cadence.ts`) and
-- four do not. So a rows design makes correctness something a person must
-- remember at every call site — and the proposal whose entire thesis was "one
-- predicate, always remembered" forgot `scorecards.service.ts` INSIDE ITS OWN
-- ARGUMENT. Deriving removes the thing that can be forgotten.
--
-- ⚠ THE DRIVING TABLE IS `engines`, AND `project_engines` ENTERS THROUGH A
-- LEFT JOIN. That is the whole safety property, and it is structural rather
-- than a check: an override row can only ever SUBTRACT or reweight, because
-- there is no derived row for an unentitled engine to attach to. A stale,
-- wrong or hostile `project_engines` row contributes nothing. No rows design
-- can make that claim — under one, a seventh engine seeded at `starter`
-- silently gives every paying tier one more engine than it sold, and the first
-- place anyone notices is a vendor invoice.
--
-- ⚠ `security_invoker = true` IS LOAD-BEARING AND IS ASSERTED, NOT COMMENTED.
-- Without it a view runs as its OWNER, which would bypass RLS on `projects`,
-- `workspaces` and `project_engines` — a cross-tenant leak wearing a
-- convenience feature. It requires PG >= 15, so the version is checked here
-- rather than assumed: on an older server the option is silently ignored and
-- the view becomes SECURITY DEFINER.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'project_entitled_engines requires PostgreSQL >= 15 for security_invoker; '
                    'on an older server this view would silently run as its owner and bypass RLS';
  END IF;
END $$;

CREATE VIEW project_entitled_engines WITH (security_invoker = true) AS
SELECT p.workspace_id,
       p.id                                   AS project_id,
       w.plan_key                             AS plan_key,
       e.key                                  AS engine_key,
       -- An absent override means "entitled, default weighting".
       COALESCE(ov.enabled, true)             AS enabled,
       COALESCE(ov.weight, 1.0::real)         AS weight,
       COALESCE(ov.sample_count, 1::smallint) AS sample_count,
       e.display_name,
       e.cache_ttl_seconds,
       e.adapter_version,
       -- Projected so no reader re-joins `engines`. FR-CRD-09 asks that the
       -- customer-visible freshness row cannot drift from the scheduler; the
       -- way to guarantee that is for both to read this one expression.
       e.cadence_by_plan -> w.plan_key        AS cadence
  FROM projects p
  JOIN workspaces w          ON w.id = p.workspace_id
  JOIN plans workspace_plan  ON workspace_plan.key = w.plan_key
  JOIN engines e             ON e.status = 'active'
  JOIN plans engine_plan     ON engine_plan.key = e.min_plan_key
                            AND engine_plan.sort_order <= workspace_plan.sort_order
  LEFT JOIN project_engines ov ON ov.project_id = p.id AND ov.engine_key = e.key
 WHERE p.deleted_at IS NULL;

-- ⚠ THE PLAN FLOOR IS THE ONLY ENTITLEMENT TEST. A cadence key for the
-- workspace's plan is deliberately NOT one, and the distinction is the
-- product:
--
--   STORY-130 §57 seeds NO free key in any cadence_by_plan, and says why --
--   free "never *schedules* either engine -- which is what 'tools only'
--   means: reachable on demand from the tools surface, never on a cadence.
--   The distinction is then carried by min_plan_key, not by the cadence map."
--
-- An earlier draft of this view also required "e.cadence_by_plan ? w.plan_key"
-- on the theory that two predicates fail closed on whichever is stricter.
-- They are not two readings of one claim: "not sold below this tier" and
-- "this plan runs it on a schedule" are different facts, and AND-ing them
-- makes the second silently revoke entitlement. Concretely it returned ZERO
-- rows for every Free workspace -- the same unenterable product STORY-151
-- had just fixed one layer up.
--
-- The scheduler still fails closed on a missing cadence, on its own, one
-- layer down: engine-cadence.ts tests (pes.cadence ->> kind)::int > 0, and
-- NULL ->> anything is NULL, so an entitled-but-uncadenced engine is listed
-- here and is never due. STORY-130 AC:102 asks for exactly that -- such a row
-- "is not scheduled", not "is not entitled".

COMMENT ON VIEW project_entitled_engines IS
  'The engines a project may capture on, DERIVED per read from the catalog and the workspace plan. '
  'No writer: a project does not acquire engines, it resolves them. project_engines enters through a '
  'LEFT JOIN, so an override can only narrow or reweight — it can never add one. STORY-152.';

COMMENT ON TABLE project_engines IS
  'OVERRIDES ONLY — the entitled set is the view project_entitled_engines. A row here narrows or '
  'reweights an already-entitled engine; it can never add one. Empty is the correct state today: '
  'tools.engines_selectable is false on every plan, so no customer chooses. STORY-152.';

-- 0005's lesson is that an implicit grant is how a new object silently becomes
-- unreadable. ALTER DEFAULT PRIVILEGES does cover views and this runs as the
-- same role, so this is belt and braces rather than strictly required.
GRANT SELECT ON project_entitled_engines TO nominara_app, nominara_worker, nominara_report;
