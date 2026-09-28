import type { ClientBase } from "pg";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import { insertRows } from "./batch-insert.js";
import { DEMO_COMPETITOR_NAMES, DEMO_PROMPT_TEMPLATES, DEMO_SEED_MARKER } from "./constants.js";
import { type Rng, chance, pick, rngFor, uniform, uniformInt } from "./rng.js";

// STORY-169 — the fact layer: `tracked_prompts`, `competitors`,
// `answer_captures`, `mention_facts`, `citation_facts` for one project.
//
// ⚠ RESET-THEN-WRITE, NOT UPSERT. Every run first deletes this project's own
// demo-marked facts (found by `answer_captures.normalizer_version =
// DEMO_SEED_MARKER`, scoped by `project_id`) and then re-inserts a freshly
// computed, deterministic set. `answer_captures` has no natural key that
// survives a re-run (`ux_results_cell` includes `run_id`, which this seed
// regenerates every call, since the table carries no FK to `capture_runs`
// for a demo seed to reuse), so upserting is not available — and reset-then-
// write is simpler besides: "seeding a project" means "this project's demo
// dataset is exactly what today's deterministic generation says", which is
// also what makes a same-day re-run produce byte-identical rows (idempotent,
// per the story's own requirement) without a second code path to prove it.

const ATTRIBUTE_CAPABLE_ENGINES: ReadonlySet<string> = new Set(["google_ai_mode", "google_aio"]);

export interface EntitledEngine {
  readonly engineKey: string;
  readonly adapterVersion: string;
  readonly captureMode: string;
}

export interface DemoProjectRef {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly rootDomain: string;
}

export interface SeedFactsOptions {
  /** Workspace-local days to backfill, ending at today, inclusive. Spec default 60. */
  readonly windowDays?: number;
  /** Tracked prompts to create. Spec default 8 (capped at the template count). */
  readonly promptsPerProject?: number;
}

export interface SeedFactsResult {
  readonly days: readonly string[];
  readonly promptIds: readonly string[];
  readonly competitorIds: readonly string[];
  readonly engineKeys: readonly string[];
}

/** The project's entitled, enabled engines — `project_entitled_engines` (STORY-152), joined to `engines` for `capture_mode`. */
async function entitledEngines(tx: ClientBase, projectId: string): Promise<EntitledEngine[]> {
  const result = await tx.query<{ engine_key: string; adapter_version: string; capture_mode: string }>(
    `SELECT pee.engine_key, pee.adapter_version, e.capture_mode
       FROM project_entitled_engines pee
       JOIN engines e ON e.key = pee.engine_key
      WHERE pee.project_id = $1 AND pee.enabled
      ORDER BY pee.engine_key`,
    [projectId],
  );
  return result.rows.map((row) => ({ engineKey: row.engine_key, adapterVersion: row.adapter_version, captureMode: row.capture_mode }));
}

/** The `windowDays` workspace-local dates ending at today, ascending — computed in Postgres, never the Node clock. */
async function workspaceLocalWindow(tx: ClientBase, timezone: string, windowDays: number): Promise<string[]> {
  const result = await tx.query<{ d: string }>(
    `SELECT to_char(gs::date, 'YYYY-MM-DD') AS d
       FROM generate_series(
              (now() AT TIME ZONE $1)::date - ($2 - 1),
              (now() AT TIME ZONE $1)::date,
              interval '1 day'
            ) gs`,
    [timezone, windowDays],
  );
  return result.rows.map((row) => row.d);
}

async function ensurePrompts(tx: ClientBase, project: DemoProjectRef, count: number): Promise<string[]> {
  const templates = DEMO_PROMPT_TEMPLATES.slice(0, Math.min(count, DEMO_PROMPT_TEMPLATES.length));
  const ids: string[] = [];
  for (const template of templates) {
    const text = template.text(project.name);
    const id = uuidV7();
    const result = await tx.query<{ id: string }>(
      `INSERT INTO tracked_prompts
         (id, workspace_id, project_id, generation_source, text, text_hash, intent_archetype, funnel_stage, status)
       VALUES ($1,$2,$3,'generated',$4,sha256($5::bytea),$6,$7,'active')
       ON CONFLICT (project_id, text_hash) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id`,
      // `text` is bound TWICE ($4 and $5) rather than referencing $4 a second
      // time under a `::bytea` cast — Postgres's parser refuses to deduce two
      // different types for one parameter number within a single statement
      // ("inconsistent types deduced for parameter $4"), even though the two
      // usages here never conflict at the value level.
      [id, project.workspaceId, project.id, text, text, template.intentArchetype, template.funnelStage],
    );
    if (result.rows[0] !== undefined) {
      ids.push(result.rows[0].id);
    } else {
      // Already exists from a prior run — the id is stable by text_hash, so
      // re-select it rather than mint a second one this run would orphan.
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM tracked_prompts WHERE project_id = $1 AND text_hash = sha256($2::bytea) AND deleted_at IS NULL`,
        [project.id, text],
      );
      ids.push(existing.rows[0]!.id);
    }
  }
  return ids;
}

async function ensureCompetitors(tx: ClientBase, project: DemoProjectRef, rng: Rng): Promise<string[]> {
  const count = uniformInt(rng, 2, 3);
  const names = DEMO_COMPETITOR_NAMES.slice(0, count);
  const ids: string[] = [];
  for (const [index, name] of names.entries()) {
    const id = uuidV7();
    const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.example.com`;
    const result = await tx.query<{ id: string }>(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source, is_primary)
       VALUES ($1,$2,$3,$4,$5,ARRAY[]::text[],'user',$6)
       ON CONFLICT (project_id, lower(name)) WHERE deleted_at IS NULL DO NOTHING
       RETURNING id`,
      [id, project.workspaceId, project.id, name, domain, index === 0],
    );
    if (result.rows[0] !== undefined) {
      ids.push(result.rows[0].id);
    } else {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM competitors WHERE project_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`,
        [project.id, name],
      );
      ids.push(existing.rows[0]!.id);
    }
  }
  return ids;
}

/** Clamp to [0,1] — local, not imported, matching the scoring library's own zero-import convention for a one-line helper. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

interface EngineProfile extends EntitledEngine {
  /** Presence probability at day offset 0 (the earliest day in the window). */
  readonly basePresence: number;
  /** Change in presence probability per day offset — deliberately different per engine, so best/worst and deltas are meaningful. */
  readonly drift: number;
  readonly baseSentiment: number;
}

function buildEngineProfiles(projectId: string, engines: readonly EntitledEngine[]): EngineProfile[] {
  return engines.map((engine) => {
    const rng = rngFor(projectId, `engine-profile:${engine.engineKey}`);
    return {
      ...engine,
      basePresence: uniform(rng, 0.3, 0.75),
      // Small enough that basePresence + drift*windowDays stays well inside [0,1].
      drift: uniform(rng, -0.005, 0.005),
      baseSentiment: uniform(rng, -0.1, 0.5),
    };
  });
}

export async function deleteExistingDemoFacts(tx: ClientBase, projectId: string, earliestDay: string): Promise<void> {
  await tx.query(
    `DELETE FROM mention_facts
      WHERE project_id = $1
        AND captured_at >= $2::date
        AND result_id IN (
          SELECT id FROM answer_captures
           WHERE project_id = $1 AND captured_at >= $2::date AND normalizer_version = $3
        )`,
    [projectId, earliestDay, DEMO_SEED_MARKER],
  );
  await tx.query(
    `DELETE FROM citation_facts
      WHERE project_id = $1
        AND captured_at >= $2::date
        AND result_id IN (
          SELECT id FROM answer_captures
           WHERE project_id = $1 AND captured_at >= $2::date AND normalizer_version = $3
        )`,
    [projectId, earliestDay, DEMO_SEED_MARKER],
  );
  await tx.query(`DELETE FROM answer_captures WHERE project_id = $1 AND captured_at >= $2::date AND normalizer_version = $3`, [
    projectId,
    earliestDay,
    DEMO_SEED_MARKER,
  ]);
}

/** Midday UTC of a `YYYY-MM-DD` calendar date, as a Date — built from `Date.UTC`, never a colon-joined interpolated timestamp string (ISO-13's key-construction scanner). */
function noonUtc(day: string): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date, 12, 0, 0));
}

interface CaptureRow {
  readonly id: string;
  readonly engineKey: string;
  readonly promptId: string;
  readonly capturedAt: Date;
  readonly captureMode: string;
  readonly adapterVersion: string;
  readonly brandPresent: boolean;
  readonly brandRank: number | null;
  readonly sov: number;
  readonly sentimentLabel: "positive" | "neutral" | "negative" | "absent";
  readonly sentimentScore: number | null;
}

/**
 * Reset and re-seed one project's facts for `windowDays` workspace-local
 * days ending today. Returns the dimension ids/keys the caller (AUX/sources/
 * tasks) can reuse.
 */
export async function resetAndSeedProjectFacts(
  tx: ClientBase,
  project: DemoProjectRef,
  timezone: string,
  options: SeedFactsOptions = {},
): Promise<SeedFactsResult> {
  const windowDays = options.windowDays ?? 60;
  const promptCount = options.promptsPerProject ?? 8;

  const days = await workspaceLocalWindow(tx, timezone, windowDays);
  const engines = await entitledEngines(tx, project.id);
  const promptIds = await ensurePrompts(tx, project, promptCount);
  const competitorIds = await ensureCompetitors(tx, project, rngFor(project.id, "competitors"));

  await deleteExistingDemoFacts(tx, project.id, days[0]!);

  if (engines.length === 0 || promptIds.length === 0) {
    // No entitled engine (a plan with none active) or no prompt slot at all
    // — an honestly empty demo project. Nothing further to write.
    return { days, promptIds, competitorIds, engineKeys: [] };
  }

  const profiles = buildEngineProfiles(project.id, engines);
  const rng = rngFor(project.id, "facts");

  const captureRows: (readonly unknown[])[] = [];
  const mentionRows: (readonly unknown[])[] = [];
  const citationRows: (readonly unknown[])[] = [];

  const captureColumns = [
    "id", "workspace_id", "project_id", "run_id", "prompt_id", "engine_key", "sample_index", "captured_at",
    "capture_mode", "adapter_version", "normalizer_version", "content_hash", "payload",
    "brand_present", "brand_rank_position", "sov", "sentiment_label", "sentiment_score",
    "citation_count", "owned_citation_count", "flags", "cache_layer", "status",
  ];
  const mentionColumns = [
    "workspace_id", "project_id", "result_id", "prompt_id", "engine_key", "captured_at",
    "entity_type", "entity_id", "entity_label", "matched_alias",
    "occurrence_index", "char_start", "char_end", "first_token_index", "prominence", "list_position",
    "sentiment_label", "sentiment_score", "sentiment_confidence", "sentiment_method",
    "render_form", "render_score", "position_class",
  ];
  const citationColumns = [
    "workspace_id", "project_id", "result_id", "prompt_id", "engine_key", "captured_at",
    "slot_index", "raw_url", "normalized_url", "url_hash", "domain", "is_owned", "is_competitor",
    "http_status", "position_weight",
  ];

  // Two day offsets, deliberately one in EACH of `denormalizeProject`'s two
  // 30-day windows (the boundary day itself falls in the PRIOR one — see
  // that function's own `current = ... > boundary` / `prior = ... <=
  // boundary` split). `visibilityDelta`/rendering's delta rule both refuse
  // to report anything unless BOTH windows have at least one usable day —
  // sentiment and visibility need a measured CELL (guaranteed already, since
  // every cell attempt writes a row regardless of presence), but sentiment's
  // delta and the rendering delta specifically need a PRESENT, mentioned
  // brand — which a purely probabilistic draw could (rarely) fail to place
  // in one window, especially at a small `promptsPerProject` in a test. So
  // this project's very first prompt, on EVERY entitled engine, is forced
  // present on these two days — a deterministic floor under the delta
  // fields, not a replacement for the probabilistic draw everywhere else.
  const forcedPresenceDayIndices = new Set([days.length - 1, days.length - 31].filter((index) => index >= 0));

  for (const [dayIndex, day] of days.entries()) {
    const capturedAt = noonUtc(day);

    for (const engine of profiles) {
      const presenceProbability = clamp01(engine.basePresence + engine.drift * dayIndex);
      const isAttributeCapable = ATTRIBUTE_CAPABLE_ENGINES.has(engine.engineKey);

      for (const promptId of promptIds) {
        const isForcedDay = forcedPresenceDayIndices.has(dayIndex) && promptId === promptIds[0];
        const forcedRendering = isForcedDay && isAttributeCapable;
        const present = isForcedDay || chance(rng, presenceProbability);

        const capture = buildCapture(rng, { engine, promptId, capturedAt, present });

        // Mentions and citations are computed FIRST, into cell-local arrays,
        // so the capture row's own `citation_count`/`owned_citation_count`
        // can be written once, correctly, on its only push — rather than
        // inserted as a placeholder and patched after the fact.
        const cellMentions: (readonly unknown[])[] = [];
        const cellCitations: (readonly unknown[])[] = [];
        let ownedCitationCount = 0;

        if (present) {
          const renderScore = isAttributeCapable ? (forcedRendering ? uniform(rng, 0.4, 0.9) : uniform(rng, 0.1, 0.9)) : 0;
          cellMentions.push([
            project.workspaceId, project.id, capture.id, capture.promptId, capture.engineKey, capture.capturedAt,
            "brand", null, project.name, project.name,
            0, 0, 100, 0, uniform(rng, 0.3, 0.95), capture.brandRank,
            capture.sentimentLabel === "absent" ? "neutral" : capture.sentimentLabel, capture.sentimentScore ?? 0,
            uniform(rng, 0.6, 0.95), "lexicon",
            isAttributeCapable ? pick(rng, ["linked", "described", "structured_row"] as const) : "bare_text",
            renderScore,
            capture.brandRank === 1 ? "recommendation" : capture.brandRank !== null && capture.brandRank <= 3 ? "ranked" : "neutral_list",
          ]);

          if (chance(rng, 0.7)) {
            cellCitations.push(buildCitation(project.workspaceId, project.id, capture, cellCitations.length + 1, project.rootDomain, true, rng));
            ownedCitationCount += 1;
          }
        }

        // Competitor mentions — independent of brand presence: an engine can
        // recommend a competitor on a cell that never names the brand at all.
        for (const [competitorIndex, competitorId] of competitorIds.entries()) {
          if (!chance(rng, 0.3)) continue;
          const prominence = uniform(rng, 0.2, 0.8);
          const sentimentScore = uniform(rng, -0.3, 0.4);
          cellMentions.push([
            project.workspaceId, project.id, capture.id, capture.promptId, capture.engineKey, capture.capturedAt,
            "competitor", competitorId, `Competitor ${String(competitorIndex + 1)}`, `Competitor ${String(competitorIndex + 1)}`,
            1, 100, 200, 10, prominence, uniformInt(rng, 1, 5),
            labelFor(sentimentScore), sentimentScore, uniform(rng, 0.5, 0.9), "lexicon",
            "bare_text", 0, "neutral_list",
          ]);

          if (chance(rng, 0.5)) {
            cellCitations.push(
              buildCitation(project.workspaceId, project.id, capture, cellCitations.length + 1, `${competitorId.slice(0, 8)}.example.com`, false, rng),
            );
          }
        }

        captureRows.push([
          capture.id, project.workspaceId, project.id, uuidV7(), capture.promptId, capture.engineKey, 0, capture.capturedAt,
          capture.captureMode, capture.adapterVersion, DEMO_SEED_MARKER, sha1Buffer(capture.id), "{}",
          capture.brandPresent, capture.brandRank, capture.sov, capture.sentimentLabel, capture.sentimentScore,
          cellCitations.length, ownedCitationCount, [], "live", "parsed",
        ]);
        mentionRows.push(...cellMentions);
        citationRows.push(...cellCitations);
      }
    }
  }

  await insertRows(tx, "answer_captures", captureColumns, captureRows, { payload: "jsonb", flags: "text[]", captured_at: "timestamptz" });
  await insertRows(tx, "mention_facts", mentionColumns, mentionRows, { captured_at: "timestamptz" });
  await insertRows(tx, "citation_facts", citationColumns, citationRows, { captured_at: "timestamptz" });

  return { days, promptIds, competitorIds, engineKeys: engines.map((engine) => engine.engineKey) };
}

function buildCapture(
  rng: Rng,
  input: { engine: EngineProfile; promptId: string; capturedAt: Date; present: boolean },
): CaptureRow {
  const sentimentScore = input.present ? clamp01to(uniform(rng, -1, 1)) : null;
  return {
    id: uuidV7(),
    engineKey: input.engine.engineKey,
    promptId: input.promptId,
    capturedAt: input.capturedAt,
    captureMode: input.engine.captureMode,
    adapterVersion: input.engine.adapterVersion,
    brandPresent: input.present,
    brandRank: input.present ? uniformInt(rng, 1, 5) : null,
    sov: input.present ? uniform(rng, 0.1, 0.6) : 0,
    sentimentLabel: input.present ? labelFor(sentimentScore ?? 0) : "absent",
    sentimentScore,
  };
}

function clamp01to(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

function labelFor(score: number): "positive" | "neutral" | "negative" {
  if (score >= 0.15) return "positive";
  if (score <= -0.15) return "negative";
  return "neutral";
}

function buildCitation(
  workspaceId: string,
  projectId: string,
  capture: CaptureRow,
  slotIndex: number,
  domain: string,
  isOwned: boolean,
  rng: Rng,
): readonly unknown[] {
  const url = `https://${domain}/demo-${String(slotIndex)}`;
  const resolved = chance(rng, 0.9);
  return [
    workspaceId, projectId, capture.id, capture.promptId, capture.engineKey, capture.capturedAt,
    slotIndex, url, url, sha1Buffer(`${capture.id}:${String(slotIndex)}`), domain, isOwned, !isOwned,
    resolved ? 200 : null, uniform(rng, 0.2, 1),
  ];
}

function sha1Buffer(value: string): Buffer {
  // A cheap, non-cryptographic content hash — good enough to satisfy the NOT
  // NULL `content_hash`/`url_hash bytea` columns with a value unique per
  // input; nothing reads it for anything but uniqueness/dedup display.
  let h1 = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h1 ^= value.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const buffer = Buffer.alloc(20);
  buffer.writeUInt32BE(h1 >>> 0, 0);
  buffer.write(value.slice(0, 16), 4, "utf8");
  return buffer;
}
