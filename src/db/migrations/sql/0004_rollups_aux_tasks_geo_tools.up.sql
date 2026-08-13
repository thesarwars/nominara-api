-- STORY-009: DDL 3, the third and final DDL migration for EPIC-01. Completes
-- the full 69-table census (59 tenant-scoped, 10 global): the source index
-- and rollups, the AUX rule catalog and findings, tasks and goals, the GEO
-- analyses and vector store, the shared tool table, the agency surface, the
-- hash-chained audit log, and the two remaining global content tables.
-- Spec: schemas/sources-and-rollups.md, schemas/aux.md,
--       schemas/tasks-and-goals.md, schemas/geo-and-vectors.md,
--       schemas/tools-attribution-agency.md
--
-- Every pre-aggregation table below is an ordinary table, maintained
-- incrementally by its owning worker — never a view over its base tables,
-- because a view would not enforce their RLS at query time. That is the
-- entire reason the migration lint rule added alongside this file exists.
--
-- displacement_events FK discharge: STORY-008's migration (0003) created
-- displacement_events.task_id as a plain uuid with no FK, because `tasks`
-- didn't exist yet. Now that this migration creates `tasks`, it discharges
-- that debt with the ALTER TABLE ... ADD CONSTRAINT below, expand/contract
-- style (KAD-16). This is the ONLY new foreign key this migration adds
-- beyond what each table's own literal DDL already specifies — every other
-- cross-reference-shaped uuid column in the five schema pages (tasks.goal_id,
-- tasks.source_displacement_id, tasks.prompt_cluster_id,
-- tasks.alignment_session_id, aux_findings.resolved_by_task_id,
-- audit_log.support_grant_id, milestones.affected_prompt_cluster,
-- semantic_nodes.prompt_cluster_id, corpus_passages.prompt_cluster_id) stays
-- a plain column with no FK, exactly as each schema page's own DDL states.
--
-- ============================================================================
-- Group A — global, no tenant dependencies
-- ============================================================================

-- ----------------------------------------------------------------------------
-- aux_rule_catalog — global, versioned catalog (schemas/aux.md)
-- ----------------------------------------------------------------------------
CREATE TABLE aux_rule_catalog (
  code              text        PRIMARY KEY,
  category          text        NOT NULL CHECK (category IN
                      ('crawler_access','structured_data','render_mode','context_fitness',
                       'freshness','entity_clarity')),
  title             text        NOT NULL,
  description       text        NOT NULL,
  rationale         text        NOT NULL,
  severity_default  text        NOT NULL CHECK (severity_default IN
                      ('critical','high','medium','low','info')),
  weight            real        NOT NULL,
  auto_fixable      boolean     NOT NULL DEFAULT false,
  fix_template_slug text,
  thresholds        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  task_threshold    text        NOT NULL DEFAULT 'high'
                                CHECK (task_threshold IN ('critical','high','medium','low')),
  rule_version      text        NOT NULL,
  enabled           boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- task_generation_rules — global, versioned catalog (schemas/tasks-and-goals.md)
-- ----------------------------------------------------------------------------
CREATE TABLE task_generation_rules (
  code                 text        PRIMARY KEY,
  category             text        NOT NULL CHECK (category IN
                         ('content','technical','authority','monitoring')),
  title_template       text        NOT NULL,
  description_template text        NOT NULL,
  trigger_kind         text        NOT NULL CHECK (trigger_kind IN
                         ('aux_finding','sov_drop','presence_loss','citation_gap',
                          'sentiment_negative','competitor_gain','source_absence','stale_content',
                          'schema_missing','displacement','divergence','topic_gap',
                          'entity_node','render_downgrade','prompt_unstable')),
  condition            jsonb       NOT NULL,
  default_priority     smallint    NOT NULL CHECK (default_priority BETWEEN 1 AND 5),
  impact_weight        real        NOT NULL,
  effort_band          text        NOT NULL CHECK (effort_band IN ('xs','s','m','l','xl')),
  opens_alignment      boolean     NOT NULL DEFAULT false,
  playbook_slug        text,
  cooldown_days        smallint    NOT NULL DEFAULT 14,
  rule_version         text        NOT NULL,
  enabled              boolean     NOT NULL DEFAULT true
);

-- ----------------------------------------------------------------------------
-- niche_reports — global, build-time artifact (schemas/tools-attribution-agency.md)
-- ----------------------------------------------------------------------------
CREATE TABLE niche_reports (
  slug             text        PRIMARY KEY,
  title            text        NOT NULL,
  category_slug    text        NOT NULL,
  engine_keys      text[]      NOT NULL,
  period_label     text        NOT NULL,
  generated_at     timestamptz NOT NULL,
  next_refresh_at  timestamptz NOT NULL,
  payload          jsonb       NOT NULL,
  sample_size      integer     NOT NULL,
  meta_description text        NOT NULL,
  og_image_key     text,
  published        boolean     NOT NULL DEFAULT false,
  view_count       bigint      NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_niche_reports_published ON niche_reports (published, category_slug);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON niche_reports
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ----------------------------------------------------------------------------
-- platform_metrics — global, anonymised (schemas/sources-and-rollups.md)
-- ----------------------------------------------------------------------------
CREATE TABLE platform_metrics (
  metric_date        date        NOT NULL,
  category_slug      text        NOT NULL,
  engine_key         text        NOT NULL REFERENCES engines(key),
  sample_size        integer     NOT NULL CHECK (sample_size >= 20),
  median_visibility  numeric(6,3) NOT NULL,
  p25_visibility     numeric(6,3) NOT NULL,
  p75_visibility     numeric(6,3) NOT NULL,
  median_aux_score   numeric(6,3) NOT NULL,
  top_source_domains jsonb       NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_date, category_slug, engine_key)
);

-- ============================================================================
-- Group B — sources & rollups (tenant-scoped)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- source_domains
-- ----------------------------------------------------------------------------
CREATE TABLE source_domains (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL,
  domain                text        NOT NULL,
  display_name          text,
  source_class          text        NOT NULL DEFAULT 'other',
  authority_tier        smallint    NOT NULL DEFAULT 3 CHECK (authority_tier BETWEEN 1 AND 5),
  robots_allows_ai      jsonb,
  is_seedable           boolean     NOT NULL DEFAULT false,
  seeding_playbook_slug text,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_source_domains ON source_domains (workspace_id, domain);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON source_domains
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ----------------------------------------------------------------------------
-- project_source_index
-- ----------------------------------------------------------------------------
CREATE TABLE project_source_index (
  workspace_id            uuid     NOT NULL,
  project_id              uuid     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_domain_id        uuid     NOT NULL REFERENCES source_domains(id) ON DELETE CASCADE,
  engine_key              text     NOT NULL,
  window_start            date     NOT NULL,
  window_days             smallint NOT NULL CHECK (window_days IN (7,30,90)),
  citation_count          integer  NOT NULL DEFAULT 0,
  distinct_prompts        integer  NOT NULL DEFAULT 0,
  distinct_urls           integer  NOT NULL DEFAULT 0,
  avg_position_weight     real     NOT NULL DEFAULT 0,
  context_weight          real     NOT NULL DEFAULT 0,
  rank_position           smallint,
  brand_present_on_domain boolean  NOT NULL DEFAULT false,
  gap_severity            text     CHECK (gap_severity IN ('none','low','medium','high','critical')),
  top_urls                jsonb    NOT NULL DEFAULT '[]'::jsonb,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, source_domain_id, engine_key, window_start, window_days)
);
CREATE INDEX ix_psi_rank ON project_source_index
  (workspace_id, project_id, engine_key, window_start, rank_position);
CREATE INDEX ix_psi_gaps ON project_source_index
  (workspace_id, project_id, gap_severity) WHERE gap_severity IN ('high','critical');

-- ----------------------------------------------------------------------------
-- metric_daily — the aggregation layer
-- ----------------------------------------------------------------------------
CREATE TABLE metric_daily (
  workspace_id       uuid     NOT NULL,
  project_id         uuid     NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  engine_key         text     NOT NULL,
  entity_type        text     NOT NULL CHECK (entity_type IN ('brand','competitor')),
  entity_id          uuid     NOT NULL,
  metric_date        date     NOT NULL,
  cells_total        integer  NOT NULL DEFAULT 0,
  cells_present      integer  NOT NULL DEFAULT 0,
  presence_rate      real     NOT NULL DEFAULT 0,
  sov                real     NOT NULL DEFAULT 0,
  avg_prominence     real     NOT NULL DEFAULT 0,
  avg_rank_position  real,
  mentions_total     integer  NOT NULL DEFAULT 0,
  mentions_positive  integer  NOT NULL DEFAULT 0,
  mentions_neutral   integer  NOT NULL DEFAULT 0,
  mentions_negative  integer  NOT NULL DEFAULT 0,
  sentiment_score    real     NOT NULL DEFAULT 0,
  citations_total    integer  NOT NULL DEFAULT 0,
  citations_owned    integer  NOT NULL DEFAULT 0,
  citation_share     real     NOT NULL DEFAULT 0,
  visibility_score   numeric(6,3) NOT NULL DEFAULT 0,
  rendering_quality  numeric(6,3),
  live_capture_ratio real     NOT NULL DEFAULT 1,
  scoring_version    text     NOT NULL DEFAULT 'v1',
  computed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, engine_key, entity_type, entity_id, metric_date, scoring_version)
);
CREATE INDEX ix_metric_daily_ws_time ON metric_daily
  (workspace_id, project_id, engine_key, metric_date DESC);
CREATE INDEX ix_metric_daily_entity  ON metric_daily
  (workspace_id, entity_type, entity_id, metric_date DESC);

-- ----------------------------------------------------------------------------
-- milestones — Growth Map pins
-- ----------------------------------------------------------------------------
CREATE TABLE milestones (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid        NOT NULL,
  project_id              uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  occurred_at             timestamptz NOT NULL,
  kind                    text        NOT NULL CHECK (kind IN
                            ('task_completed','deployment','aux_status_change','schema_fixed',
                             'source_seeded','competitor_added','engine_model_change',
                             'prompt_set_change','annotation')),
  title                   text        NOT NULL,
  detail                  text,
  icon                    text,
  severity                text        NOT NULL DEFAULT 'info'
                                      CHECK (severity IN ('info','positive','warning')),
  source_type             text        CHECK (source_type IN
                            ('task','aux_finding','cms_deployment','user','system')),
  source_id               uuid,
  affected_engines        text[]      NOT NULL DEFAULT '{}',
  affected_prompt_cluster uuid,
  measured_impact         jsonb,
  visible_in_portal       boolean     NOT NULL DEFAULT true,
  created_by              uuid        REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_milestones_project_time ON milestones (workspace_id, project_id, occurred_at DESC);
CREATE UNIQUE INDEX ux_milestones_source ON milestones (source_type, source_id)
  WHERE source_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- notifications
-- ----------------------------------------------------------------------------
CREATE TABLE notifications (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL,
  project_id    uuid,
  user_id       uuid,
  kind          text        NOT NULL,
  severity      text        NOT NULL CHECK (severity IN ('info','warning','critical')),
  title         text        NOT NULL,
  body          text,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  channels      text[]      NOT NULL DEFAULT '{in_app}',
  read_at       timestamptz,
  dispatched_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_notifications_inbox ON notifications
  (workspace_id, user_id, read_at, created_at DESC);

-- ============================================================================
-- Group C — AUX audit (tenant-scoped)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- aux_audits
-- ----------------------------------------------------------------------------
CREATE TABLE aux_audits (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL,
  project_id        uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger           text        NOT NULL CHECK (trigger IN
                      ('scheduled','manual','post_fix','onboarding')),
  triggered_by      uuid        REFERENCES users(id),
  scope             text        NOT NULL DEFAULT 'key_pages'
                                CHECK (scope IN ('domain_root','key_pages','single_url',
                                                 'sitemap_sample','public_surface')),
  target_urls       text[]      NOT NULL,
  pages_crawled     integer     NOT NULL DEFAULT 0,
  pages_failed      integer     NOT NULL DEFAULT 0,
  excluded_rules    text[]      NOT NULL DEFAULT '{}',
  robots_snapshot   text,
  robots_hash       bytea,
  llms_txt_present  boolean,
  sitemap_url_count integer,
  aux_score         numeric(6,3),
  score_capped      boolean     NOT NULL DEFAULT false,
  score_breakdown   jsonb,
  findings_critical smallint    NOT NULL DEFAULT 0,
  findings_high     smallint    NOT NULL DEFAULT 0,
  findings_medium   smallint    NOT NULL DEFAULT 0,
  findings_low      smallint    NOT NULL DEFAULT 0,
  rule_version      text        NOT NULL,
  tokenizer         text        NOT NULL,
  dom_object_prefix text,
  status            text        NOT NULL DEFAULT 'queued'
                                CHECK (status IN ('queued','running','completed','partial','failed')),
  error_summary     jsonb,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_aux_audits_project ON aux_audits (workspace_id, project_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- aux_findings
-- ----------------------------------------------------------------------------
CREATE TABLE aux_findings (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL,
  project_id          uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  audit_id            uuid        NOT NULL REFERENCES aux_audits(id) ON DELETE CASCADE,
  rule_code           text        NOT NULL REFERENCES aux_rule_catalog(code),
  url                 text,
  severity            text        NOT NULL CHECK (severity IN
                        ('critical','high','medium','low','info')),
  status              text        NOT NULL DEFAULT 'open'
                                  CHECK (status IN ('open','acknowledged','in_progress','resolved',
                                                    'regressed','wont_fix','stale')),
  fingerprint         bytea       NOT NULL,
  title               text        NOT NULL,
  evidence            jsonb       NOT NULL,
  measured_value      numeric,
  threshold_value     numeric,
  affected_pages      integer     NOT NULL DEFAULT 1,
  suggested_fix       jsonb,
  requires_human_review boolean   NOT NULL DEFAULT false,
  wont_fix_reason     text,
  first_detected_at   timestamptz NOT NULL DEFAULT now(),
  last_detected_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  resolved_by_task_id uuid,
  regressed_at        timestamptz,
  occurrence_count    integer     NOT NULL DEFAULT 1,
  rule_version        text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_aux_findings_fp ON aux_findings (project_id, fingerprint)
  WHERE status <> 'resolved';
CREATE INDEX ix_aux_findings_open  ON aux_findings (workspace_id, project_id, severity, status);
CREATE INDEX ix_aux_findings_audit ON aux_findings (audit_id);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON aux_findings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- Group D — tasks & goals (tenant-scoped)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- tasks
-- ----------------------------------------------------------------------------
CREATE TABLE tasks (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL,
  project_id           uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  short_ref            text        NOT NULL,
  kind                 text        NOT NULL CHECK (kind IN
                         ('content','technical','authority','monitoring')),
  origin               text        NOT NULL DEFAULT 'auto'
                                   CHECK (origin IN ('auto','manual','command_bar')),
  rule_code            text        REFERENCES task_generation_rules(code),
  dedupe_fingerprint   bytea       NOT NULL,
  title                text        NOT NULL,
  description          text        NOT NULL,

  -- Four statuses. No ordering column exists anywhere.
  status               text        NOT NULL DEFAULT 'todo'
                                   CHECK (status IN ('todo','in_progress','done','dismissed')),
  dismissed_reason     text,
  resurface_at         timestamptz,
  goal_id              uuid,
  priority             smallint    NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  impact_score         real        NOT NULL DEFAULT 0,
  effort_band          text        NOT NULL DEFAULT 'm',
  assignee_id          uuid        REFERENCES users(id),
  due_at               timestamptz,

  source_finding_id    uuid        REFERENCES aux_findings(id) ON DELETE SET NULL,
  source_domain_id     uuid        REFERENCES source_domains(id) ON DELETE SET NULL,
  source_displacement_id uuid,
  source_geo_analysis  text,
  affected_url         text,
  affected_engines     text[]      NOT NULL DEFAULT '{}',
  affected_prompt_ids  uuid[]      NOT NULL DEFAULT '{}',
  prompt_cluster_id    uuid,
  playbook_slug        text,
  playbook_payload     jsonb,
  alignment_session_id uuid,

  baseline_metrics     jsonb,
  completion_metrics   jsonb,
  completed_at         timestamptz,
  completed_by         uuid        REFERENCES users(id),
  milestone_id         uuid        REFERENCES milestones(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
CREATE UNIQUE INDEX ux_tasks_short_ref ON tasks (workspace_id, short_ref);
CREATE UNIQUE INDEX ux_tasks_dedupe    ON tasks (project_id, dedupe_fingerprint)
  WHERE status <> 'done' AND deleted_at IS NULL;
CREATE INDEX ix_tasks_list     ON tasks (workspace_id, project_id, status, impact_score DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX ix_tasks_assignee ON tasks (workspace_id, assignee_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_tasks_open     ON tasks (workspace_id, impact_score DESC, priority DESC)
  WHERE status IN ('todo','in_progress') AND deleted_at IS NULL;
CREATE INDEX ix_tasks_goal     ON tasks (goal_id, status) WHERE goal_id IS NOT NULL;
CREATE INDEX ix_tasks_resurface ON tasks (resurface_at) WHERE status = 'dismissed';
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ----------------------------------------------------------------------------
-- goals
-- ----------------------------------------------------------------------------
CREATE TABLE goals (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL,
  project_id   uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        text        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN
                 ('prompt_recommendation','engine_score','topic_authority',
                  'citation_presence','rendering_quality','sentiment_recovery','custom')),
  target       jsonb       NOT NULL,
  baseline     jsonb,
  current      jsonb,
  progress_pct numeric(5,2) NOT NULL DEFAULT 0,
  target_date  date,
  status       text        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','achieved','abandoned')),
  achieved_at  timestamptz,
  created_by   uuid        REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_goals_project ON goals (workspace_id, project_id, status);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ----------------------------------------------------------------------------
-- task_events
-- ----------------------------------------------------------------------------
CREATE TABLE task_events (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL,
  task_id      uuid        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id     uuid        REFERENCES users(id),
  actor_type   text        NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system')),
  event        text        NOT NULL CHECK (event IN
                 ('created','status_changed','assigned','commented','priority_changed',
                  'goal_linked','completed','reopened','dismissed','evidence_refreshed')),
  from_value   text,
  to_value     text,
  comment_body text,
  payload      jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_task_events_task ON task_events (task_id, occurred_at DESC);

-- ----------------------------------------------------------------------------
-- ref_counters
-- ----------------------------------------------------------------------------
CREATE TABLE ref_counters (
  workspace_id uuid    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prefix       text    NOT NULL,
  next_value   integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, prefix)
);

-- ----------------------------------------------------------------------------
-- STORY-008 FK debt discharge: tasks now exists, so the FK that was
-- structurally impossible in 0003 can be added. Not matched by any
-- DESTRUCTIVE_PATTERNS entry (a bare ADD CONSTRAINT ... FOREIGN KEY), so no
-- `-- @contract-phase` annotation is needed.
-- ----------------------------------------------------------------------------
ALTER TABLE displacement_events
  ADD CONSTRAINT displacement_events_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

-- ============================================================================
-- Group E — GEO analyses & vector store (tenant-scoped)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- geo_analyses — the persisted output of every analysis
-- ----------------------------------------------------------------------------
-- DEFECT (E-5), fixed: the schema page's literal DDL declares BOTH
-- `id uuid PRIMARY KEY` and a table-level composite `PRIMARY KEY (project_id,
-- analysis, window_start, window_days, scoring_version)` — two primary keys
-- on one table, which Postgres rejects outright (not a judgement call, a
-- syntax impossibility). The AC and this table's own prose ("the natural
-- composite primary key makes each analysis idempotent per window") both
-- call for the composite key to be the only key, so `id` is dropped entirely
-- here rather than kept as an unreferenced convenience column with no
-- uniqueness guarantee of its own — this mirrors project_source_index and
-- metric_daily, this migration's two sibling tables, neither of which has a
-- separate `id` column. Recorded as a follow-up doc fix in this story's
-- Technical Notes.
CREATE TABLE geo_analyses (
  workspace_id       uuid        NOT NULL,
  project_id         uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  analysis           text        NOT NULL CHECK (analysis IN
                       ('alignment','entity','structure','divergence','topics','sentiment','freshness')),
  window_start       date        NOT NULL,
  window_days        smallint    NOT NULL CHECK (window_days IN (7,30,90)),
  score              numeric(6,3),
  score_label        text,
  evidence_cells     integer     NOT NULL DEFAULT 0,
  evidence_passages  integer     NOT NULL DEFAULT 0,
  sufficient         boolean     NOT NULL DEFAULT false,
  suppression_reason text,
  findings           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  lever_rank         smallint,
  scoring_version    text        NOT NULL DEFAULT 'v1',
  computed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, analysis, window_start, window_days, scoring_version)
);
CREATE INDEX ix_geo_analyses_project ON geo_analyses (workspace_id, project_id, computed_at DESC);
CREATE INDEX ix_geo_analyses_levers  ON geo_analyses
  (workspace_id, project_id, lever_rank) WHERE lever_rank IS NOT NULL;

-- ----------------------------------------------------------------------------
-- entity_nodes
-- ----------------------------------------------------------------------------
CREATE TABLE entity_nodes (
  workspace_id    uuid        NOT NULL,
  project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node            text        NOT NULL CHECK (node IN
                    ('wikidata','wikipedia','g2','capterra','crunchbase','linkedin',
                     'github','category_directory')),
  present         boolean     NOT NULL DEFAULT false,
  complete        boolean     NOT NULL DEFAULT false,
  url             text,
  missing_fields  text[]      NOT NULL DEFAULT '{}',
  in_brand_sameas boolean     NOT NULL DEFAULT false,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, node)
);
CREATE INDEX ix_entity_nodes_gaps ON entity_nodes (workspace_id, project_id)
  WHERE NOT present OR NOT in_brand_sameas;

-- ----------------------------------------------------------------------------
-- geo_alignments
-- ----------------------------------------------------------------------------
CREATE TABLE geo_alignments (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL,
  project_id            uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id               uuid        REFERENCES tasks(id) ON DELETE SET NULL,
  target_url            text        NOT NULL,
  prompt_cluster_id     uuid,
  engine_keys           text[]      NOT NULL,
  embedding_model       text        NOT NULL,
  embedding_dims        smallint    NOT NULL DEFAULT 1536,
  centroid              halfvec(1536),
  centroid_source_count smallint    NOT NULL DEFAULT 0,
  centroid_domains      text[]      NOT NULL DEFAULT '{}',
  live_content_md       text,
  draft_content_md      text,
  baseline_alignment    real,
  current_alignment     real,
  target_band_low       real,
  target_band_high      real,
  percentile_vs_corpus  smallint,
  coverage_ratio        real,
  recommendations       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status                text        NOT NULL DEFAULT 'open'
                                    CHECK (status IN ('open','patched','discarded')),
  created_by            uuid        REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_alignment_project ON geo_alignments (workspace_id, project_id, created_at DESC);
CREATE INDEX ix_alignment_task    ON geo_alignments (task_id);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON geo_alignments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ----------------------------------------------------------------------------
-- content_chunks — the customer's side of the comparison
-- ----------------------------------------------------------------------------
CREATE TABLE content_chunks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL,
  project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id      uuid        REFERENCES geo_alignments(id) ON DELETE CASCADE,
  url             text        NOT NULL,
  chunk_index     smallint    NOT NULL,
  heading_path    text[]      NOT NULL DEFAULT '{}',
  text            text        NOT NULL,
  token_count     smallint    NOT NULL,
  content_hash    bytea       NOT NULL,
  embedding       halfvec(1536),
  embedding_model text,
  alignment       real,
  is_draft        boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- KNOWN LIMITATION (E-3): embedding_model is nullable, so this unique index
-- does NOT dedupe rows sharing a NULL model (Postgres NULL-distinct default).
-- Not "fixed" with NULLS NOT DISTINCT — that would be an unauthorized
-- deviation from the schema page's literal DDL.
CREATE UNIQUE INDEX ux_content_chunks ON content_chunks
  (workspace_id, content_hash, embedding_model, is_draft);
CREATE INDEX ix_content_chunks_session ON content_chunks (session_id, chunk_index);
CREATE INDEX ix_content_chunks_hnsw ON content_chunks
  USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ----------------------------------------------------------------------------
-- corpus_passages — what engines actually cited
-- ----------------------------------------------------------------------------
CREATE TABLE corpus_passages (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL,
  project_id          uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  citation_url_hash   bytea       NOT NULL,
  url                 text        NOT NULL,
  domain              text        NOT NULL,
  prompt_cluster_id   uuid,
  engine_keys         text[]      NOT NULL DEFAULT '{}',
  passage_index       smallint    NOT NULL,
  text                text        NOT NULL,
  from_text_fragment  boolean     NOT NULL DEFAULT false,
  token_count         smallint    NOT NULL,
  content_hash        bytea       NOT NULL,
  embedding           halfvec(1536),
  embedding_model     text        NOT NULL,
  citation_frequency  integer     NOT NULL DEFAULT 1,
  avg_position_weight real        NOT NULL DEFAULT 0,
  centroid_weight     real        NOT NULL DEFAULT 1,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_corpus_passages ON corpus_passages
  (workspace_id, content_hash, embedding_model);
CREATE INDEX ix_corpus_cluster ON corpus_passages (workspace_id, project_id, prompt_cluster_id);
CREATE INDEX ix_corpus_hnsw ON corpus_passages
  USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);

-- ----------------------------------------------------------------------------
-- semantic_nodes — NO HNSW index and NO embedding_model column (E-3: this
-- diverges from data-model.md §6's "Vector ANN" table, which lists
-- semantic_nodes among the HNSW-indexed tables — the schema page's own
-- literal DDL here has neither, and this migration follows the schema page.
-- ----------------------------------------------------------------------------
CREATE TABLE semantic_nodes (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL,
  project_id         uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt_cluster_id  uuid,
  phrase             text        NOT NULL,
  phrase_normalized  text        NOT NULL,
  node_type          text        NOT NULL CHECK (node_type IN
                       ('capability','compliance','integration','metric','persona','industry',
                        'pricing_term','entity','differentiator')),
  corpus_frequency   integer     NOT NULL DEFAULT 0,
  corpus_doc_ratio   real        NOT NULL DEFAULT 0,
  embedding          halfvec(1536),
  present_in_content boolean     NOT NULL DEFAULT false,
  projected_gain     real,
  priority_rank      smallint,
  evidence_url       text        NOT NULL,
  evidence_snippet   text        NOT NULL,
  requires_human_review boolean  NOT NULL DEFAULT false,
  computed_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_semantic_nodes ON semantic_nodes
  (project_id, prompt_cluster_id, phrase_normalized);
CREATE INDEX ix_semantic_nodes_missing ON semantic_nodes
  (workspace_id, project_id, present_in_content, priority_rank);

-- ----------------------------------------------------------------------------
-- patches
-- ----------------------------------------------------------------------------
CREATE TABLE patches (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL,
  project_id          uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id          uuid        REFERENCES geo_alignments(id) ON DELETE CASCADE,
  finding_id          uuid        REFERENCES aux_findings(id) ON DELETE SET NULL,
  target_url          text        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN
                        ('markdown','html_fragment','jsonld','robots')),
  unified_diff        text,
  content_before_hash bytea       NOT NULL,
  content_after       text        NOT NULL,
  jsonld_blocks       jsonb,
  reversal            jsonb,
  risk_flags          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  applied_node_ids    uuid[]      NOT NULL DEFAULT '{}',
  alignment_before    real,
  alignment_projected real,
  created_by          uuid        REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_patches_session ON patches (session_id, created_at DESC);
CREATE INDEX ix_patches_finding ON patches (finding_id);

-- ============================================================================
-- Group F — tools, attribution, agency & audit (tenant-scoped, except
-- niche_reports which was created in Group A)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- tool_runs — one table for all six tools
-- ----------------------------------------------------------------------------
CREATE TABLE tool_runs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by          uuid        REFERENCES users(id),
  tool_key            text        NOT NULL CHECK (tool_key IN
                        ('visibility_scan','prompt_research','competitor_finder',
                         'aux_audit','schema_builder','compare_runs')),
  brand_name          text,
  brand_url           text,
  target_url          text,
  query_text          text,
  prompt_texts        text[],
  input_hash          bytea      NOT NULL,
  engine_keys         text[]     NOT NULL DEFAULT '{}',
  locale              text       NOT NULL DEFAULT 'en-US',

  result_json         jsonb,

  sov_estimate        real,
  citation_count      smallint,
  sentiment_label     text       CHECK (sentiment_label IN
                        ('positive','neutral','negative','absent')),
  brand_present       boolean,
  aux_score           smallint   CHECK (aux_score BETWEEN 0 AND 100),
  entities_found      smallint,
  pages_scanned       smallint,
  items_kept          smallint,
  engines_succeeded   text[]     NOT NULL DEFAULT '{}',
  engines_failed      text[]     NOT NULL DEFAULT '{}',
  cache_layer         text       NOT NULL DEFAULT 'live' CHECK (cache_layer IN ('live','l1')),
  cells_charged       smallint,
  cells_cached        smallint,
  credits_charged     smallint   NOT NULL DEFAULT 0,
  duration_ms         integer,
  status              text       NOT NULL DEFAULT 'running'
                                 CHECK (status IN ('running','completed','partial','failed','expired')),
  error_code          text,

  diff_base_run_id    uuid       REFERENCES tool_runs(id) ON DELETE SET NULL,
  diff_compare_run_id uuid       REFERENCES tool_runs(id) ON DELETE SET NULL,

  converted_project_id uuid      REFERENCES projects(id) ON DELETE SET NULL,
  converted_at        timestamptz,
  pinned              boolean    NOT NULL DEFAULT false,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Per-tool input shape. KNOWN GAP (E-1): array_length() of a NULL or empty
  -- ('{}') array returns SQL NULL, and a CASE branch evaluating to NULL makes
  -- the whole CHECK pass (NULL is not FALSE). This affects BOTH branches that
  -- depend solely on an array_length() test: prompt_research's
  -- `array_length(prompt_texts, 1) BETWEEN 1 AND 10`, and visibility_scan's
  -- `array_length(engine_keys, 1) BETWEEN 1 AND 4` (visibility_scan's other
  -- two conditions, brand_name/query_text IS NOT NULL, are still enforced
  -- directly). So a prompt_research row with prompt_texts NULL or '{}', or a
  -- visibility_scan row with engine_keys NULL or '{}', is NOT rejected here.
  -- This is a real gap in tools-attribution-agency.md's literal DDL; not
  -- patched with a COALESCE, per the accepted escalation.
  CONSTRAINT ck_tr_shape CHECK (
    CASE tool_key
      WHEN 'visibility_scan'   THEN brand_name IS NOT NULL AND query_text IS NOT NULL
                                    AND array_length(engine_keys, 1) BETWEEN 1 AND 4
      WHEN 'prompt_research'   THEN array_length(prompt_texts, 1) BETWEEN 1 AND 10
      WHEN 'competitor_finder' THEN brand_url IS NOT NULL
      WHEN 'aux_audit'         THEN target_url IS NOT NULL
      WHEN 'schema_builder'    THEN result_json IS NOT NULL
      WHEN 'compare_runs'      THEN diff_base_run_id IS NOT NULL AND diff_compare_run_id IS NOT NULL
    END),
  CONSTRAINT ck_tr_engine_set CHECK (NOT (engine_keys && ARRAY['gemini','claude'])),
  CONSTRAINT ck_tr_free_tools CHECK (
    tool_key NOT IN ('schema_builder','compare_runs') OR credits_charged = 0)
);
CREATE INDEX ix_tr_timeline   ON tool_runs (workspace_id, created_at DESC);
CREATE INDEX ix_tr_tool       ON tool_runs (workspace_id, tool_key, created_at DESC);
CREATE INDEX ix_tr_user       ON tool_runs (workspace_id, created_by, created_at DESC);
CREATE INDEX ix_tr_hash       ON tool_runs (workspace_id, input_hash, created_at DESC);
CREATE INDEX ix_tr_pinned     ON tool_runs (workspace_id, created_at DESC) WHERE pinned;
CREATE INDEX ix_tr_brand_trgm ON tool_runs USING gin (brand_name gin_trgm_ops);
CREATE INDEX ix_tr_expiry     ON tool_runs (expires_at) WHERE status <> 'expired';
CREATE INDEX ix_tr_diff_pairs ON tool_runs (workspace_id, tool_key, input_hash, created_at DESC)
  WHERE status IN ('completed','partial');

CREATE TRIGGER ck_tr_payload_size AFTER INSERT OR UPDATE OF result_json ON tool_runs
  FOR EACH ROW EXECUTE FUNCTION app.assert_jsonb_size('result_json', '24576');

-- ----------------------------------------------------------------------------
-- attribution_configs / attribution_daily / attribution_url_rollup
-- ----------------------------------------------------------------------------
CREATE TABLE attribution_configs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id          uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  method              text        NOT NULL CHECK (method IN ('script','ga4')),
  site_token          text        NOT NULL,
  site_token_hash     bytea       NOT NULL,
  allowed_origins     text[]      NOT NULL DEFAULT '{}',
  ga4_property_id     text,
  ga4_credentials_enc text,
  dek_id              text,
  conversion_events   text[]      NOT NULL DEFAULT '{}',
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','receiving','stale','disabled')),
  first_event_at      timestamptz,
  last_event_at       timestamptz,
  created_by          uuid        REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_attribution_project ON attribution_configs (project_id)
  WHERE status <> 'disabled';
CREATE UNIQUE INDEX ux_attribution_token   ON attribution_configs (site_token_hash);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON attribution_configs
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Daily per-URL rollup. Sessions are aggregated AT INGEST — no per-visitor
-- row, no cookie, no full IP.
CREATE TABLE attribution_daily (
  workspace_id     uuid        NOT NULL,
  project_id       uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric_date      date        NOT NULL,
  landing_url_hash bytea       NOT NULL,
  landing_url      text        NOT NULL,
  referrer_class   text        NOT NULL CHECK (referrer_class IN
                     ('chatgpt','perplexity','gemini','claude','copilot','meta_ai',
                      'other_ai','unattributed_direct')),
  sessions         integer     NOT NULL DEFAULT 0,
  conversions      integer     NOT NULL DEFAULT 0,
  conversion_value numeric(12,2) NOT NULL DEFAULT 0,
  bounce_sessions  integer     NOT NULL DEFAULT 0,
  country          char(2),
  device           text        CHECK (device IN ('desktop','mobile','tablet')),
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  -- E-4 known defect: nullable columns (country, device) inside a primary
  -- key are silently forced NOT NULL by Postgres. Implemented literally per
  -- the schema page — not repaired here (see this migration's header /
  -- STORY-009's Technical Notes for the follow-up-story note).
  PRIMARY KEY (project_id, metric_date, landing_url_hash, referrer_class, country, device)
);
CREATE INDEX ix_attribution_url  ON attribution_daily
  (workspace_id, project_id, landing_url_hash, metric_date DESC);
CREATE INDEX ix_attribution_brin ON attribution_daily USING brin (metric_date);

CREATE TABLE attribution_url_rollup (
  workspace_id       uuid        NOT NULL,
  project_id         uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  window_start       date        NOT NULL,
  window_days        smallint    NOT NULL CHECK (window_days IN (7,30,90)),
  landing_url_hash   bytea       NOT NULL,
  landing_url        text        NOT NULL,
  citations          integer     NOT NULL DEFAULT 0,
  citations_prior    integer     NOT NULL DEFAULT 0,
  ai_sessions        integer     NOT NULL DEFAULT 0,
  ai_sessions_prior  integer     NOT NULL DEFAULT 0,
  conversions        integer     NOT NULL DEFAULT 0,
  cvr                real,
  gsc_ai_impressions integer,
  organic_clicks     integer,
  pattern            text        NOT NULL CHECK (pattern IN
                       ('dual_visibility','ai_only','organic_only',
                        'ai_substitution_candidate','invisible_both','insufficient_data')),
  computed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, window_start, window_days, landing_url_hash)
);
CREATE INDEX ix_attr_rollup_pattern ON attribution_url_rollup
  (workspace_id, project_id, pattern, window_start DESC);

-- ----------------------------------------------------------------------------
-- gsc_connections / gsc_daily
-- ----------------------------------------------------------------------------
CREATE TABLE gsc_connections (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL,
  project_id         uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  property_url       text        NOT NULL,
  property_type      text        NOT NULL CHECK (property_type IN ('domain','url_prefix')),
  credentials_enc    text        NOT NULL,
  dek_id             text        NOT NULL,
  refresh_enc        text,
  scopes             text[]      NOT NULL,
  token_expires_at   timestamptz,
  last_sync_at       timestamptz,
  last_sync_date     date,
  backfill_completed boolean     NOT NULL DEFAULT false,
  health_status      text        NOT NULL DEFAULT 'unknown'
                                 CHECK (health_status IN
                                   ('unknown','healthy','degraded','unauthorized','revoked')),
  last_error         text,
  created_by         uuid        REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz
);
CREATE UNIQUE INDEX ux_gsc_project ON gsc_connections (project_id) WHERE revoked_at IS NULL;
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON gsc_connections
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE gsc_daily (
  workspace_id   uuid        NOT NULL,
  project_id     uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric_date    date        NOT NULL,
  report         text        NOT NULL CHECK (report IN ('ai_surface','classic')),
  dimension      text        NOT NULL CHECK (dimension IN ('page','query','page_query')),
  page_url       text,
  page_url_hash  bytea,
  query_text     text,
  query_hash     bytea,
  clicks         integer     NOT NULL DEFAULT 0,
  impressions    integer     NOT NULL DEFAULT 0,
  ctr            real        NOT NULL DEFAULT 0,
  avg_position   real,
  country        char(2),
  device         text        CHECK (device IN ('desktop','mobile','tablet')),
  synced_at      timestamptz NOT NULL DEFAULT now(),
  -- E-4 known defect: nullable columns (page_url_hash, query_hash, country,
  -- device) inside a primary key are silently forced NOT NULL by Postgres,
  -- and query_hash's presence in the PK contradicts the prose stating the
  -- ai_surface report has no query dimension. Implemented literally per the
  -- schema page.
  PRIMARY KEY (project_id, metric_date, report, dimension, page_url_hash, query_hash, country, device)
);
CREATE INDEX ix_gsc_daily_page  ON gsc_daily (workspace_id, project_id, page_url_hash, metric_date DESC);
CREATE INDEX ix_gsc_daily_query ON gsc_daily (workspace_id, project_id, query_hash, metric_date DESC);
CREATE INDEX ix_gsc_daily_brin  ON gsc_daily USING brin (metric_date);

-- ----------------------------------------------------------------------------
-- brand_themes / custom_domains / share_tokens / share_token_views /
-- scheduled_reports / report_artifacts
-- ----------------------------------------------------------------------------
CREATE TABLE brand_themes (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                text        NOT NULL DEFAULT 'Default',
  is_default          boolean     NOT NULL DEFAULT true,
  logo_light_key      text,
  logo_dark_key       text,
  favicon_key         text,
  color_primary       text        NOT NULL DEFAULT '#4f46e5',
  color_accent        text        NOT NULL DEFAULT '#0ea5e9',
  color_bg            text        NOT NULL DEFAULT '#ffffff',
  color_fg            text        NOT NULL DEFAULT '#0f172a',
  font_family         text        NOT NULL DEFAULT 'Inter',
  custom_css          text,
  email_from_name     text,
  email_footer_html   text,
  hide_nominara_brand boolean     NOT NULL DEFAULT false,
  report_cover_key    text,
  contrast_report     jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_brand_themes_default ON brand_themes (workspace_id) WHERE is_default;
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON brand_themes
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE custom_domains (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hostname            citext      NOT NULL,
  purpose             text        NOT NULL DEFAULT 'portal' CHECK (purpose IN ('portal','app')),
  cname_target        text        NOT NULL,
  verification_token  text        NOT NULL,
  dns_cname_verified_at timestamptz,
  dns_txt_verified_at   timestamptz,
  cert_status         text        NOT NULL DEFAULT 'pending'
                                  CHECK (cert_status IN ('pending','issuing','issued','renewing',
                                                         'failed','revoked')),
  cert_arn            text,
  cert_expires_at     timestamptz,
  last_check_at       timestamptz,
  last_error          text,
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','active','failed','disabled')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- Deliberately GLOBAL uniqueness across all workspaces, per the schema page.
CREATE UNIQUE INDEX ux_custom_domains_host ON custom_domains (hostname);
CREATE INDEX ix_custom_domains_ws ON custom_domains (workspace_id, status);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON custom_domains
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE share_tokens (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label                 text        NOT NULL,
  token_hash            bytea       NOT NULL,
  token_prefix          text        NOT NULL,
  password_hash         text,
  password_required     boolean     NOT NULL DEFAULT true,
  scope_project_ids     uuid[]      NOT NULL,
  scope_tabs            text[]      NOT NULL DEFAULT '{overview}'
                                    CHECK (scope_tabs <@ ARRAY['overview','tracking','sources',
                                                               'aux','tasks']),
  hide_competitors      boolean     NOT NULL DEFAULT false,
  hide_costs            boolean     NOT NULL DEFAULT true,
  timeframe_lock        text        CHECK (timeframe_lock IN ('24h','7d','30d','90d','custom')),
  theme_id              uuid        REFERENCES brand_themes(id) ON DELETE SET NULL,
  allowed_email_domains citext[],
  max_views             integer,
  view_count            integer     NOT NULL DEFAULT 0,
  last_viewed_at        timestamptz,
  expires_at            timestamptz,
  revoked_at            timestamptz,
  created_by            uuid        NOT NULL REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_share_scope_nonempty CHECK (cardinality(scope_project_ids) > 0)
);
CREATE UNIQUE INDEX ux_share_tokens_hash ON share_tokens (token_hash);
CREATE INDEX ix_share_tokens_ws ON share_tokens (workspace_id, revoked_at, expires_at);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON share_tokens
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE share_token_views (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid        NOT NULL,
  share_token_id uuid        NOT NULL REFERENCES share_tokens(id) ON DELETE CASCADE,
  ip             inet,
  user_agent     text,
  country        char(2),
  authenticated  boolean     NOT NULL DEFAULT false,
  pages_viewed   text[]      NOT NULL DEFAULT '{}',
  duration_ms    integer,
  viewed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_share_views_token ON share_token_views (share_token_id, viewed_at DESC);

CREATE TABLE scheduled_reports (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             text        NOT NULL,
  project_ids      uuid[]      NOT NULL,
  cadence          text        NOT NULL CHECK (cadence IN
                     ('weekly','biweekly','monthly','quarterly')),
  day_of_period    smallint    NOT NULL DEFAULT 1,
  send_hour_local  smallint    NOT NULL DEFAULT 8,
  timeframe        text        NOT NULL DEFAULT '30d',
  format           text        NOT NULL DEFAULT 'pdf' CHECK (format IN ('pdf','csv','both')),
  recipients       citext[]    NOT NULL,
  theme_id         uuid        REFERENCES brand_themes(id) ON DELETE SET NULL,
  include_sections text[]      NOT NULL DEFAULT '{scorecards,growth_map,competitors,tasks}',
  last_sent_at     timestamptz,
  last_error       text,
  next_send_at     timestamptz,
  active           boolean     NOT NULL DEFAULT true,
  created_by       uuid        REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_scheduled_reports_due ON scheduled_reports (next_send_at) WHERE active;
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON scheduled_reports
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE report_artifacts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL,
  scheduled_report_id uuid        REFERENCES scheduled_reports(id) ON DELETE SET NULL,
  project_ids         uuid[]      NOT NULL,
  period_start        date        NOT NULL,
  period_end          date        NOT NULL,
  format              text        NOT NULL,
  object_key          text        NOT NULL,
  bytes               integer     NOT NULL,
  methodology_footer  jsonb       NOT NULL,
  download_count      integer     NOT NULL DEFAULT 0,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_report_artifacts_ws ON report_artifacts (workspace_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- audit_log — hash-chained, append-only (E-6: the hash chain itself is
-- computed by application code, not a DB trigger — the schema page describes
-- no computing trigger. In scope here: the two hash columns, the
-- support_grant_id column, and the reject_mutation append-only trigger,
-- reusing the exact pattern from credit_ledger in 0002. Out of scope: any
-- hash-computing trigger, any REVOKE (no runtime roles exist until
-- STORY-010).
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
  seq           bigserial   PRIMARY KEY,
  workspace_id  uuid        NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text        NOT NULL CHECK (actor_type IN ('user','api_key','system','support')),
  actor_id      uuid,
  actor_ip      inet,
  actor_ua      text,
  action        text        NOT NULL,
  resource_type text        NOT NULL,
  resource_id   uuid,
  before_state  jsonb,
  after_state   jsonb,
  request_id    text        NOT NULL,
  support_grant_id uuid,
  severity      text        NOT NULL DEFAULT 'info'
                            CHECK (severity IN ('info','notice','warning','critical')),
  prev_hash     bytea       NOT NULL,
  row_hash      bytea       NOT NULL
);
CREATE INDEX ix_audit_ws_time  ON audit_log (workspace_id, occurred_at DESC);
CREATE INDEX ix_audit_action   ON audit_log (workspace_id, action, occurred_at DESC);
CREATE INDEX ix_audit_resource ON audit_log (resource_type, resource_id);
CREATE TRIGGER reject_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
