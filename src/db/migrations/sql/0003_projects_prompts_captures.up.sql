-- STORY-008: projects and their configuration, prompts with their vector
-- index, the engine registry, and the three monthly-partitioned fact tables.
-- Spec: schemas/projects-and-prompts.md, schemas/captures-and-facts.md
--
-- Forward-reference note: displacement_events.task_id will reference
-- tasks(id), but `tasks` doesn't exist until STORY-009. The column is created
-- here as a plain uuid; STORY-009 adds the FK constraint once the target
-- table exists (ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY, expand/contract
-- style, KAD-16).

-- ============================================================================
-- engines — global adapter registry
-- ============================================================================
CREATE TABLE engines (
  key                  text        PRIMARY KEY CHECK (key IN
                         ('google_aio','google_ai_mode','perplexity','chatgpt','gemini','claude',
                          'grok','copilot','meta_ai','deepseek')),
  display_name         text        NOT NULL,
  vendor               text        NOT NULL,
  capture_mode         text        NOT NULL CHECK (capture_mode IN ('api','licensed_serp','headless')),
  adapter_version      text        NOT NULL,
  model_fingerprint    text,
  supports_citations   boolean     NOT NULL DEFAULT true,
  cache_ttl_seconds    integer     NOT NULL,
  volatility_band      text        NOT NULL CHECK (volatility_band IN
                         ('low','medium','high','very_high')),
  min_plan_key         text        NOT NULL REFERENCES plans(key),
  cadence_by_plan      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status               text        NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active','degraded','disabled','beta')),
  legal_review_ref     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_engines_headless_reviewed
    CHECK (capture_mode <> 'headless' OR legal_review_ref IS NOT NULL)
);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON engines
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- engine_health — global telemetry, deliberately no workspace_id
-- ============================================================================
CREATE TABLE engine_health (
  engine_key     text        NOT NULL REFERENCES engines(key),
  bucket_start   timestamptz NOT NULL,
  attempts       integer     NOT NULL DEFAULT 0,
  successes      integer     NOT NULL DEFAULT 0,
  blocks         integer     NOT NULL DEFAULT 0,
  timeouts       integer     NOT NULL DEFAULT 0,
  rate_limited   integer     NOT NULL DEFAULT 0,
  p50_latency_ms integer,
  p95_latency_ms integer,
  circuit_state  text        NOT NULL DEFAULT 'closed'
                             CHECK (circuit_state IN ('closed','half_open','open')),
  PRIMARY KEY (engine_key, bucket_start)
);
CREATE INDEX ix_engine_health_recent ON engine_health (bucket_start DESC);

-- ============================================================================
-- projects
-- ============================================================================
CREATE TABLE projects (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  text        NOT NULL,
  slug                  citext      NOT NULL,
  kind                  text        NOT NULL DEFAULT 'brand'
                                    CHECK (kind IN ('brand','product_line')),
  parent_project_id     uuid        REFERENCES projects(id) ON DELETE SET NULL,

  root_url              text        NOT NULL,
  root_domain           text        NOT NULL,
  owned_domains         text[]      NOT NULL DEFAULT '{}',
  brand_aliases         text[]      NOT NULL DEFAULT '{}',
  negative_aliases      text[]      NOT NULL DEFAULT '{}',
  category_slug         text,
  verticals             text[]      NOT NULL DEFAULT '{}',
  locale                text        NOT NULL DEFAULT 'en-US',
  description           text,

  cadence               text        NOT NULL DEFAULT 'weekly'
                                    CHECK (cadence IN ('hourly','daily','twice_weekly','weekly','manual')),
  priority_prompt_limit integer     NOT NULL DEFAULT 50,
  next_run_at           timestamptz,
  last_run_at           timestamptz,

  discovery             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  discovery_status      text        NOT NULL DEFAULT 'pending'
                                    CHECK (discovery_status IN
                                      ('pending','running','completed','partial','failed')),
  fingerprint           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  domain_verified_at    timestamptz,

  visibility_blended    numeric(6,3),
  visibility_by_engine  jsonb,
  visibility_delta_30d  numeric(6,3),
  rendering_quality     numeric(6,3),
  entity_authority      numeric(6,3),
  aux_score_current     numeric(6,3),
  source_coverage       numeric(6,3),
  sparkline_30d         jsonb,
  open_task_count       integer     NOT NULL DEFAULT 0,
  prompts_active        smallint    NOT NULL DEFAULT 0,
  prompts_cap           smallint    NOT NULL DEFAULT 30,

  status                text        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('initializing','active','paused','archived')),
  created_by            uuid        REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX ux_projects_ws_slug ON projects (workspace_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX ix_projects_ws_status ON projects (workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_projects_next_run  ON projects (next_run_at)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX ix_projects_name_trgm ON projects USING gin (name gin_trgm_ops);
CREATE INDEX ix_projects_domain    ON projects (workspace_id, root_domain);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- project_engines
-- ============================================================================
CREATE TABLE project_engines (
  workspace_id uuid        NOT NULL,
  project_id   uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  engine_key   text        NOT NULL REFERENCES engines(key),
  enabled      boolean     NOT NULL DEFAULT true,
  weight       real        NOT NULL DEFAULT 1.0 CHECK (weight > 0 AND weight <= 5),
  sample_count smallint    NOT NULL DEFAULT 1 CHECK (sample_count BETWEEN 1 AND 5),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, engine_key)
);
CREATE INDEX ix_project_engines_ws ON project_engines (workspace_id, project_id);

-- ============================================================================
-- competitors
-- ============================================================================
CREATE TABLE competitors (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL,
  project_id         uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  aliases            text[]      NOT NULL DEFAULT '{}',
  root_domain        text,
  is_primary         boolean     NOT NULL DEFAULT false,
  source             text        NOT NULL DEFAULT 'user'
                                 CHECK (source IN ('user','auto_detected')),
  detected_count     integer     NOT NULL DEFAULT 0,
  visibility_blended numeric(6,3),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX ux_competitors_project_name ON competitors (project_id, lower(name))
  WHERE deleted_at IS NULL;
CREATE INDEX ix_competitors_ws ON competitors (workspace_id, project_id) WHERE deleted_at IS NULL;
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON competitors
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- domain_verifications
-- ============================================================================
CREATE TABLE domain_verifications (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL,
  project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain          text        NOT NULL,
  method          text        NOT NULL CHECK (method IN ('dns_txt','well_known_file','meta_tag')),
  nonce           text        NOT NULL,
  verified_at     timestamptz,
  last_checked_at timestamptz,
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_domain_verif ON domain_verifications (workspace_id, domain, method);

-- ============================================================================
-- tracked_prompts
-- ============================================================================
CREATE TABLE tracked_prompts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL,
  project_id          uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  generation_batch_id uuid,
  generation_source   text        NOT NULL DEFAULT 'generated' CHECK (generation_source IN
                        ('discovery','generated','manual','imported','tool_conversion','gsc_query')),
  text                text        NOT NULL,
  text_hash           bytea       NOT NULL,
  intent_archetype    text        NOT NULL CHECK (intent_archetype IN
                        ('recommendation','head_to_head','alternatives','use_case_fit','pricing_value',
                         'integration_capability','objection_risk','migration_switching',
                         'compliance_security','scale_fit','vertical_fit','feature_specific',
                         'implementation_effort','support_quality','buyer_shortlist','custom')),
  funnel_stage        text        NOT NULL CHECK (funnel_stage IN
                        ('awareness','consideration','decision')),
  generator_meta      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  embedding           halfvec(1536),
  cluster_id          uuid,
  is_priority         boolean     NOT NULL DEFAULT false,
  stability_score     real,
  superseded_by       uuid        REFERENCES tracked_prompts(id) ON DELETE SET NULL,
  last_captured_at    timestamptz,
  status              text        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','paused','archived')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE UNIQUE INDEX ux_prompts_project_hash ON tracked_prompts (project_id, text_hash)
  WHERE deleted_at IS NULL;
CREATE INDEX ix_prompts_ws_project ON tracked_prompts (workspace_id, project_id, status)
  WHERE deleted_at IS NULL;
CREATE INDEX ix_prompts_priority   ON tracked_prompts (project_id, is_priority)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX ix_prompts_batch      ON tracked_prompts (generation_batch_id);
CREATE INDEX ix_prompts_cluster    ON tracked_prompts (workspace_id, cluster_id);
CREATE INDEX ix_prompts_embedding  ON tracked_prompts
  USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX ix_prompts_text_trgm  ON tracked_prompts USING gin (text gin_trgm_ops);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON tracked_prompts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- prompt_stability
-- ============================================================================
CREATE TABLE prompt_stability (
  workspace_id      uuid        NOT NULL,
  prompt_id         uuid        NOT NULL REFERENCES tracked_prompts(id) ON DELETE CASCADE,
  engine_key        text        NOT NULL REFERENCES engines(key),
  window_start      date        NOT NULL,
  sample_count      smallint    NOT NULL,
  presence_rate     real        NOT NULL,
  sov_median        real        NOT NULL,
  sov_iqr           real        NOT NULL,
  entity_set_jsd    real        NOT NULL,
  model_fingerprint text,
  drift_flagged     boolean     NOT NULL DEFAULT false,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (prompt_id, engine_key, window_start)
);
CREATE INDEX ix_prompt_stability_drift ON prompt_stability
  (workspace_id, drift_flagged, window_start DESC);

-- ============================================================================
-- topic_clusters
-- ============================================================================
CREATE TABLE topic_clusters (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL,
  project_id        uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label             text        NOT NULL,
  label_source      text        NOT NULL DEFAULT 'auto'
                                CHECK (label_source IN ('auto','user')),
  centroid          halfvec(1536),
  prompt_count      smallint    NOT NULL DEFAULT 0,
  commercial_intent real        NOT NULL DEFAULT 0.7,
  visibility_score  numeric(6,3),
  authority_rank    smallint,
  leader_entity_id  uuid,
  gap_priority      real,
  achievability     real,
  computed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_topic_clusters   ON topic_clusters (project_id, lower(label));
CREATE INDEX ix_topic_clusters_gap      ON topic_clusters (workspace_id, project_id, gap_priority DESC);
CREATE INDEX ix_topic_clusters_hnsw     ON topic_clusters
  USING hnsw (centroid halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON topic_clusters
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- capture_runs
-- ============================================================================
CREATE TABLE capture_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL,
  project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger         text        NOT NULL CHECK (trigger IN
                    ('scheduled','manual','verification','drift_sample','conversion_backfill')),
  triggered_by    uuid        REFERENCES users(id),
  engine_keys     text[]      NOT NULL,
  prompt_scope    text        NOT NULL DEFAULT 'all'
                              CHECK (prompt_scope IN ('all','priority','cluster','single')),
  scope_ref       uuid,
  planned_cells   integer     NOT NULL DEFAULT 0,
  skipped_cells   integer     NOT NULL DEFAULT 0,
  captured_cells  integer     NOT NULL DEFAULT 0,
  failed_cells    integer     NOT NULL DEFAULT 0,
  scoring_version text        NOT NULL DEFAULT 'v1',
  status          text        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued','running','completed','partial',
                                                'failed','canceled')),
  error_summary   jsonb,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_runs_ws_project_time ON capture_runs (workspace_id, project_id, created_at DESC);
CREATE INDEX ix_runs_status          ON capture_runs (status) WHERE status IN ('queued','running');

-- ============================================================================
-- answer_captures — partitioned, highest-volume table in the platform.
--
-- No FKs on workspace_id/project_id/run_id/prompt_id/engine_key, matching the
-- literal reference DDL exactly. Code review (STORY-008) checked this
-- specifically: captures-and-facts.md's "Partitioned referential integrity"
-- section only explains why mention_facts.result_id / citation_facts.result_id
-- must be application-enforced (a Postgres constraint — you cannot cleanly FK
-- a partitioned table's non-partition-key column). It says nothing about
-- these columns' own outbound references to non-partitioned tables (projects,
-- capture_runs, tracked_prompts, engines), which could technically carry real
-- FKs. The doc is simply silent there, not stating a rationale either way —
-- this migration follows the literal DDL as given rather than inferring one.
-- Same applies to mention_facts and citation_facts below.
-- ============================================================================
CREATE TABLE answer_captures (
  id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL,
  project_id           uuid        NOT NULL,
  run_id               uuid        NOT NULL,
  prompt_id            uuid        NOT NULL,
  engine_key           text        NOT NULL,
  sample_index         smallint    NOT NULL DEFAULT 0,
  captured_at          timestamptz NOT NULL,

  capture_mode         text        NOT NULL CHECK (capture_mode IN
                         ('api','licensed_serp','headless')),
  adapter_version      text        NOT NULL,
  model_fingerprint    text,
  normalizer_version   text        NOT NULL,
  latency_ms           integer,
  response_tokens_est  integer,
  truncated            boolean     NOT NULL DEFAULT false,
  async_generated      boolean,

  raw_object_key       text,
  content_hash         bytea       NOT NULL,
  response_excerpt     text,
  payload              jsonb       NOT NULL DEFAULT '{}'::jsonb,

  brand_present        boolean     NOT NULL DEFAULT false,
  brand_rank_position  smallint,
  sov                  real,
  sentiment_label      text        CHECK (sentiment_label IN
                         ('positive','neutral','negative','absent')),
  sentiment_score      real,
  citation_count       smallint    NOT NULL DEFAULT 0,
  owned_citation_count smallint    NOT NULL DEFAULT 0,
  flags                text[]      NOT NULL DEFAULT '{}',

  cache_layer          text        NOT NULL DEFAULT 'live'
                                   CHECK (cache_layer IN ('live','l1','l2')),
  source_result_id     uuid,
  scoring_version      text        NOT NULL DEFAULT 'v1',
  status               text        NOT NULL DEFAULT 'captured'
                                   CHECK (status IN ('captured','parsed','failed','blocked','skipped')),
  error_code           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (captured_at, id)
) PARTITION BY RANGE (captured_at);

CREATE TABLE answer_captures_default PARTITION OF answer_captures DEFAULT;

CREATE UNIQUE INDEX ux_results_cell ON answer_captures
  (run_id, prompt_id, engine_key, sample_index, captured_at);
CREATE INDEX ix_results_ws_proj_engine ON answer_captures
  (workspace_id, project_id, engine_key, captured_at DESC);
CREATE INDEX ix_results_prompt_time ON answer_captures
  (workspace_id, prompt_id, captured_at DESC);
CREATE INDEX ix_results_run       ON answer_captures (run_id, status);
CREATE INDEX ix_results_hash      ON answer_captures (workspace_id, content_hash);
CREATE INDEX ix_results_brin      ON answer_captures USING brin (captured_at)
  WITH (pages_per_range = 32);
CREATE INDEX ix_results_payload   ON answer_captures USING gin (payload jsonb_path_ops);
CREATE INDEX ix_results_negative  ON answer_captures
  (workspace_id, project_id, captured_at DESC) WHERE sentiment_label = 'negative';

-- ============================================================================
-- mention_facts — partitioned. PRECONDITION 1 and PRECONDITION 3 live here.
-- ============================================================================
CREATE TABLE mention_facts (
  id                       uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id             uuid        NOT NULL,
  project_id               uuid        NOT NULL,
  result_id                uuid        NOT NULL,
  prompt_id                uuid        NOT NULL,
  engine_key               text        NOT NULL,
  captured_at              timestamptz NOT NULL,

  -- PRECONDITION 1: every detected entity is stored, not only tracked ones.
  entity_type              text        NOT NULL CHECK (entity_type IN
                             ('brand','competitor','other')),
  entity_id                uuid,
  entity_label             text        NOT NULL,
  matched_alias            text        NOT NULL,

  occurrence_index         smallint    NOT NULL,
  char_start               integer     NOT NULL,
  char_end                 integer     NOT NULL,
  first_token_index        integer     NOT NULL,
  prominence               real        NOT NULL,
  list_position            smallint,

  sentiment_label          text        NOT NULL CHECK (sentiment_label IN
                             ('positive','neutral','negative')),
  sentiment_score          real        NOT NULL,
  sentiment_confidence     real        NOT NULL,
  sentiment_method         text        NOT NULL CHECK (sentiment_method IN
                             ('lexicon','heuristic','llm_arbiter','arbiter_rejected')),
  evidence_start           integer,
  evidence_end             integer,
  negative_reasons         text[]      NOT NULL DEFAULT '{}',
  negative_source_url_hash bytea,

  -- PRECONDITION 3: rendering columns exist on the mention table from this migration.
  render_form              text        NOT NULL DEFAULT 'bare_text' CHECK (render_form IN
                             ('bare_text','linked','described','structured_row','featured')),
  render_attrs             text[]      NOT NULL DEFAULT '{}',
  render_score             real        NOT NULL DEFAULT 0,

  position_class           text        NOT NULL DEFAULT 'neutral_list' CHECK (position_class IN
                             ('recommendation','ranked','neutral_list','also_consider','caveat')),
  answer_form              text        CHECK (answer_form IN
                             ('ranked_list','comparison_table','single_recommendation',
                              'neutral_enumeration','narrative')),
  scoring_version          text        NOT NULL DEFAULT 'v1',
  PRIMARY KEY (captured_at, id)
) PARTITION BY RANGE (captured_at);

CREATE TABLE mention_facts_default PARTITION OF mention_facts DEFAULT;

CREATE INDEX ix_mentions_entity_time ON mention_facts
  (workspace_id, project_id, entity_type, entity_id, captured_at DESC);
CREATE INDEX ix_mentions_result   ON mention_facts (result_id);
CREATE INDEX ix_mentions_engine   ON mention_facts
  (workspace_id, project_id, engine_key, captured_at DESC);
CREATE INDEX ix_mentions_negative ON mention_facts
  (workspace_id, project_id, captured_at DESC) WHERE sentiment_label = 'negative';
CREATE INDEX ix_mentions_render   ON mention_facts
  (workspace_id, project_id, engine_key, render_form, captured_at DESC);
CREATE INDEX ix_mentions_position ON mention_facts
  (workspace_id, project_id, position_class, captured_at DESC);
CREATE INDEX ix_mentions_brin     ON mention_facts USING brin (captured_at);

-- ============================================================================
-- citation_facts — partitioned. PRECONDITION 2 lives here.
-- ============================================================================
CREATE TABLE citation_facts (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL,
  project_id      uuid        NOT NULL,
  result_id       uuid        NOT NULL,
  prompt_id       uuid        NOT NULL,
  engine_key      text        NOT NULL,
  captured_at     timestamptz NOT NULL,
  slot_index      smallint    NOT NULL,
  raw_url         text        NOT NULL,
  normalized_url  text        NOT NULL,
  url_hash        bytea       NOT NULL,
  domain          text        NOT NULL,
  path            text,
  anchor_text     text,
  title           text,
  is_owned        boolean     NOT NULL DEFAULT false,
  is_competitor   boolean     NOT NULL DEFAULT false,
  source_class    text        CHECK (source_class IN
                    ('community_forum','review_marketplace','encyclopedic','news_media',
                     'vendor_owned','developer_platform','social','blog','academic','other')),
  http_status     smallint,
  resolved_at     timestamptz,
  position_weight real        NOT NULL,
  text_fragment   text,
  PRIMARY KEY (captured_at, id)
) PARTITION BY RANGE (captured_at);

CREATE TABLE citation_facts_default PARTITION OF citation_facts DEFAULT;

CREATE INDEX ix_citations_domain_time ON citation_facts
  (workspace_id, project_id, domain, captured_at DESC);
CREATE INDEX ix_citations_result  ON citation_facts (result_id);
CREATE INDEX ix_citations_owned   ON citation_facts
  (workspace_id, project_id, captured_at DESC) WHERE is_owned;
CREATE INDEX ix_citations_urlhash ON citation_facts (workspace_id, url_hash);
CREATE INDEX ix_citations_brin    ON citation_facts USING brin (captured_at);

-- ============================================================================
-- displacement_events — the D1 differentiator. Not partitioned.
-- task_id has no FK yet — see the forward-reference note at the top of this file.
-- ============================================================================
CREATE TABLE displacement_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL,
  project_id            uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt_id             uuid        NOT NULL,
  engine_key            text        NOT NULL,
  detected_at           timestamptz NOT NULL DEFAULT now(),
  kind                  text        NOT NULL CHECK (kind IN
                          ('presence_lost','position_lost','recommendation_lost','render_downgraded')),
  before_result_id      uuid        NOT NULL,
  after_result_id       uuid        NOT NULL,
  before_position       smallint,
  after_position        smallint,
  before_position_class text,
  after_position_class  text,

  displaced_by          jsonb       NOT NULL,
  citation_gap          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  concept_gap           jsonb       NOT NULL DEFAULT '[]'::jsonb,

  impact_score          real        NOT NULL DEFAULT 0,
  task_id               uuid,  -- REFERENCES tasks(id) ON DELETE SET NULL, added by STORY-009
  acknowledged_at       timestamptz,
  recovered_at          timestamptz,
  scoring_version       text        NOT NULL DEFAULT 'v1'
);
CREATE INDEX ix_displacement_feed   ON displacement_events
  (workspace_id, project_id, detected_at DESC) WHERE recovered_at IS NULL;
CREATE INDEX ix_displacement_impact ON displacement_events
  (workspace_id, project_id, impact_score DESC) WHERE recovered_at IS NULL;
CREATE UNIQUE INDEX ux_displacement_cell ON displacement_events
  (project_id, prompt_id, engine_key, kind, before_result_id, after_result_id);

-- ============================================================================
-- Monthly partitions for the current and next month, computed dynamically at
-- migration-apply time (not hardcoded) — STORY-013 takes over creating
-- partitions three months ahead on an ongoing basis; this migration only
-- needs to make the schema usable before that maintenance job exists.
-- ============================================================================
DO $$
DECLARE
  month_start date := date_trunc('month', CURRENT_DATE)::date;
  next_month  date := (date_trunc('month', CURRENT_DATE) + interval '1 month')::date;
  month_after date := (date_trunc('month', CURRENT_DATE) + interval '2 months')::date;
  fact_table  text;
BEGIN
  FOREACH fact_table IN ARRAY ARRAY['answer_captures', 'mention_facts', 'citation_facts']
  LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      fact_table || '_' || to_char(month_start, 'YYYY_MM'), fact_table, month_start, next_month
    );
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      fact_table || '_' || to_char(next_month, 'YYYY_MM'), fact_table, next_month, month_after
    );
  END LOOP;
END $$;
