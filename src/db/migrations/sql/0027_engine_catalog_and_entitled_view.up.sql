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
-- ⚠ `adapter_version` AND `status` ARE DELIBERATELY NOT IN THIS LIST, AND
-- LEAVING THEM OUT IS THE WHOLE POINT OF READING THIS BLOCK.
--
-- A re-run of this seed is a CORRECTION of transcribed reference data, never
-- a reset of operator state. The two excluded columns are operator state:
--
--   `status`          -- an incident responder sets 'degraded' when a vendor
--                        is down. Re-seeding it back to 'active' resumes
--                        scheduling against a broken vendor, silently, as a
--                        side effect of a deploy that was about a cadence.
--   `adapter_version` -- the catalog side of a provenance pair. Every
--                        `answer_captures` row records the adapter_version
--                        that produced it, and the down migration keeps the
--                        catalog rows precisely BECAUSE captures point at
--                        them. Rewriting 2.3.1 back to 0.1.0 makes the
--                        catalog contradict every capture already recorded.
--
-- `model_fingerprint` is excluded for the same reason and always was.
--
-- Reproduced, not theorised: a review of this story ran the real
-- rollback/migrate sequence against operator edits and watched a 'degraded'
-- status, a deliberate cadence throttle and adapter_version 2.3.1 all revert.
-- The cadence throttle is intended to revert -- that is transcribed data. The
-- other two were not.
ON CONFLICT (key) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  vendor            = EXCLUDED.vendor,
  capture_mode      = EXCLUDED.capture_mode,
  supports_citations= EXCLUDED.supports_citations,
  cache_ttl_seconds = EXCLUDED.cache_ttl_seconds,
  volatility_band   = EXCLUDED.volatility_band,
  min_plan_key      = EXCLUDED.min_plan_key,
  cadence_by_plan   = EXCLUDED.cadence_by_plan,
  updated_at        = now();

-- ---------------------------------------------------------------------------
-- A SHAPE CONSTRAINT ON cadence_by_plan, BECAUSE SEEDING THE CATALOG ARMS A
-- CAST THAT WAS DORMANT WHILE THE TABLE WAS EMPTY.
--
-- Two readers cast a cadence leaf to int:
--   engine-cadence.ts  (pes.cadence ->> $2)::int > 0     -- the scheduler
--   scorecards.service (pes.cadence ->> 'full')::int     -- the customer read
--
-- `::int` does not fail closed on a non-integer, it RAISES. A hand-written
-- operator migration setting a leaf to 4.5 or "daily" -- and the header of
-- this file invites exactly such a migration -- turns
-- GET /v1/projects/{id}/scorecards into a 500 for every tenant entitled to
-- that engine. Not their cadence: the whole Project Overview screen.
--
-- ⚠ ZERO AND NEGATIVE ARE DELIBERATELY STILL LEGAL. They cast cleanly and the
-- readers' own `> 0` already excludes them -- that IS the fail-closed rule,
-- and capture-engine-cadence.spec.ts seeds `{"growth":{"full":0}}` to prove
-- it. This constraint is scoped to exactly the values that RAISE, so it
-- closes the crash without taking over the scheduling decision.
--
-- ⚠ IT TESTS THE TEXT `->>` PRODUCES, NOT THE JSON VALUE'S TYPE, AND THE
-- DIFFERENCE IS THE WHOLE CONSTRAINT.
--
-- The first version of this asked "is it an integral JSON number". That is a
-- DIFFERENT SET from "does ::int accept it", and a review found two members of
-- the gap by trying them:
--
--   {"full": 4.0}          jsonb_typeof is 'number' and 4.0 = trunc(4.0), so
--                          it passed -- and '4.0'::int still raises. This is
--                          the most natural way an operator writes a cadence
--                          in JSON.
--   {"full": 99999999999}  integral, so it passed -- and it is out of range
--                          for int4, which raises too.
--
-- Both still 500'd the Project Overview. A guard that is most of the way
-- closed while reading as fully closed is worse than no guard, because the
-- next person stops checking.
--
-- So: take the text, require it to be an optionally-signed run of digits, and
-- require it to fit in int4. That is `::int`'s own contract, expressed the
-- only way that cannot drift from it -- over the same string the readers cast.
--
-- A FUNCTION because a CHECK constraint may not contain a subquery, and
-- walking two levels of jsonb needs one. IMMUTABLE so it is usable in a CHECK.
CREATE FUNCTION app.cadence_by_plan_is_castable(value jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT value IS NOT NULL
     AND jsonb_typeof(value) = 'object'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_each(value) AS per_plan(plan_key, plan_value)
        WHERE jsonb_typeof(per_plan.plan_value) <> 'object'
           OR EXISTS (
                SELECT 1
                  FROM jsonb_each(per_plan.plan_value) AS per_kind(kind_key, kind_value)
                 WHERE jsonb_typeof(per_kind.kind_value) <> 'number'
                    -- The text form, which is what the readers cast. '4.0' is
                    -- a number and is not a run of digits.
                    OR (per_kind.kind_value #>> '{}') !~ '^-?[0-9]+$'
                    -- int4's range. Checked as numeric, because casting to
                    -- int here to find out whether it casts would raise.
                    OR (per_kind.kind_value #>> '{}')::numeric
                         NOT BETWEEN -2147483648 AND 2147483647
              )
     );
$fn$;

COMMENT ON FUNCTION app.cadence_by_plan_is_castable(jsonb) IS
  'True when every cadence leaf survives ::int -- tested on the TEXT ->> produces, so 4.0 and out-of-int4 values are refused. Zero and negative are legal: the readers exclude them with > 0.';

ALTER TABLE engines
  ADD CONSTRAINT engines_cadence_by_plan_castable
  CHECK (app.cadence_by_plan_is_castable(cadence_by_plan));

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
-- ⚠ WHAT STOPS A FREE WORKSPACE CAPTURING AT ALL IS A DIFFERENT MECHANISM,
-- AND IT IS WORTH KNOWING WHICH. This view gives a free project perplexity
-- and chatgpt, correctly: plans.entitlements."tools.engine_set" is 2 and
-- §57 calls them reachable on demand. Nothing on the CAPTURE path
-- distinguishes free from the rest -- `resolveEnabledEngines` reads this same
-- view for the manual-run path too. The thing that actually prevents a free
-- workspace planning cells is `projects.max = 0`: it cannot create a project
-- to capture for.
--
-- That is a STRUCTURAL LIMIT doing a tier cap's job, which the four-separate-
-- mechanisms rule says should not be load-bearing. It holds today and is not
-- this story's to change; recorded so that whoever gives free a project finds
-- this sentence rather than discovering it from a bill.

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

-- ⚠ REVOKE FIRST, BECAUSE ALTER DEFAULT PRIVILEGES ALREADY GRANTED MORE THAN
-- THIS STATEMENT ASKS FOR.
--
-- 0005's lesson is that an implicit grant is how a new object silently becomes
-- unreadable, and its ALTER DEFAULT PRIVILEGES does cover views. The effect is
-- that the moment this view is created it carries SELECT/INSERT/UPDATE/DELETE
-- for nominara_app and nominara_worker, and SELECT for nominara_portal --
-- none of which is written anywhere. A review of this story read them out of
-- information_schema.role_table_grants and found exactly that.
--
-- Inert today: the view joins four relations, so it is not auto-updatable
-- ("cannot insert into view ... not automatically updatable") and the write
-- privileges cannot be exercised; nominara_portal reads zero rows because
-- `workspaces` carries no portal policy. Inert is not the same as intended,
-- and no gate covers view privileges -- role-check.ts only asserts "not the
-- migration owner", and the ACL census in database-roles-and-grants.spec.ts
-- is relkind IN ('r','p') and stops at 0005.
--
-- So the grant is stated in full: revoke everything, then grant exactly the
-- three reads. The statement and the catalog now say the same thing, and a
-- future reader comparing them finds no gap to interpret.
REVOKE ALL ON project_entitled_engines FROM PUBLIC;
REVOKE ALL ON project_entitled_engines FROM nominara_app, nominara_worker, nominara_report, nominara_portal;
GRANT SELECT ON project_entitled_engines TO nominara_app, nominara_worker, nominara_report;
