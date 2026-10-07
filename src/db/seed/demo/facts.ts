import type { ClientBase } from "pg";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import { structuralLimitFrom } from "../../../lib/entitlements/classification.js";
import { resolveEntitlements } from "../../../lib/entitlements/resolution.js";
import { PROMPT_OCCUPIES_SLOT } from "../../../lib/entitlements/structural-usage.js";
import type { EntitlementValue } from "../plan-entitlements.js";
import { insertRows } from "./batch-insert.js";
import { DEMO_COMPETITOR_NAMES, DEMO_PROMPT_MARKER_KEY, DEMO_PROMPT_TEMPLATES, DEMO_SEED_MARKER } from "./constants.js";
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

interface WorkspaceLocalDay {
  readonly day: string;
  /** Local noon of `day`, IN THE WORKSPACE'S OWN TIMEZONE, as the correct UTC instant — see this function's own header. */
  readonly capturedAt: Date;
}

/**
 * The `windowDays` workspace-local dates ending at today, ascending, EACH
 * PAIRED WITH ITS OWN LOCAL NOON — computed entirely in Postgres, never the
 * Node clock, and never a bare `Date.UTC(y, m, d, 12)`.
 *
 * ⚠ REVIEW FIX — a bare UTC-noon timestamp is wrong for any workspace whose
 * offset is +12 through +14 (Pacific/Auckland, Pacific/Tongatapu, Pacific/
 * Apia, Pacific/Kiritimati): 12:00 UTC on calendar day D is already D+1 in
 * those zones, so `rollUpDay`'s own bucketing (`(captured_at AT TIME ZONE
 * tz)::date`) would file every capture this seed writes for "day D" under
 * D+1 instead — today's facts land on a day that is never rolled up at all
 * (`workspaceLocalWindow`'s own last entry is "today", not "tomorrow"), and
 * the forced-presence day at the PRIOR/CURRENT window boundary
 * (`forcedPresenceDayIndices`, below) shifts a day out of the window it was
 * placed in to guarantee. `(gs::date::timestamp + interval '12 hours') AT
 * TIME ZONE $1` reads as "local noon, AS WALL-CLOCK TIME IN ZONE $1,
 * converted to the UTC instant that means" — Postgres's own tz database
 * resolves the DST-aware offset for that exact calendar day, which no fixed
 * JS offset arithmetic can.
 */
async function workspaceLocalWindow(tx: ClientBase, timezone: string, windowDays: number): Promise<WorkspaceLocalDay[]> {
  const result = await tx.query<{ d: string; noon_utc: Date }>(
    `SELECT to_char(gs::date, 'YYYY-MM-DD') AS d,
            ((gs::date::timestamp + interval '12 hours') AT TIME ZONE $1) AS noon_utc
       FROM generate_series(
              (now() AT TIME ZONE $1)::date - ($2 - 1),
              (now() AT TIME ZONE $1)::date,
              interval '1 day'
            ) gs`,
    [timezone, windowDays],
  );
  return result.rows.map((row) => ({ day: row.d, capturedAt: row.noon_utc }));
}

/**
 * A plan entitlement's numeric ceiling, resolved through the REAL
 * entitlement pipeline (never a hardcoded number — `no-hardcoded-plan-
 * values`) — delegating to `structuralLimitFrom`, the ONE place that knows
 * what a resolved entitlement value means (`classification.ts`'s own
 * comment), exactly as `projects.service.ts`'s `resolveCap` and
 * `activation.service.ts`'s `resolveCap` already do for this same key.
 *
 * ⚠ REVIEW FIX (STORY-169 re-audit) — this used to return `Infinity` for
 * ANY non-number, including `null` and `false`. `structuralLimitFrom`
 * resolves those to a FINITE limit of `0` ("no allowance at all" —
 * `classification.ts` names `prompts.max_per_project` on the free plan as
 * its own example), so on a plan whose cap is `null` this seed was writing
 * competitors and prompts PAST a cap that should have let it write none —
 * fail-open on exactly the values documentation says mean "nothing". Only
 * `"unlimited"`/`"uncapped"`/`"custom"`/`"negotiated"` resolve to `Infinity`
 * here (never bounded into a `smallint` column by this function, unlike
 * `prompts_cap`, so unbounded is the right reading for a `cap - used`
 * headroom computation). An unrecognised value — including an absent key —
 * fails closed at `0`, matching `projects.service.ts`'s own `resolveCap`.
 *
 * Exported so `purge.ts` can recompute `projects.prompts_cap` with this
 * SAME resolution when `--purge` removes the seed's own prompts from a
 * pre-existing project — never a stored pre-seed snapshot, for the same
 * reason `activation.service.ts`'s own `resolveCap` reads the entitlement
 * rather than the column: the entitlement is the authority and moves with
 * the plan, so recomputing it is always correct, not just at seed time.
 */
export async function structuralCap(
  tx: ClientBase,
  workspaceId: string,
  key: "prompts.max_total" | "prompts.max_per_project" | "competitors.max_per_project",
): Promise<number> {
  const resolved = await resolveEntitlements(tx, workspaceId);
  const raw = resolved.entitlements[key]?.value;
  const limit = structuralLimitFrom((raw ?? null) as EntitlementValue);
  if (limit === undefined) return 0;
  return limit.kind === "unlimited" ? Number.POSITIVE_INFINITY : limit.limit;
}

/** How many prompt slots (`PROMPT_OCCUPIES_SLOT`) are already used — workspace-wide, or one project's share of it. */
async function promptSlotsUsed(tx: ClientBase, workspaceId: string, projectId?: string): Promise<number> {
  const result = await tx.query<{ n: string }>(
    projectId === undefined
      ? `SELECT count(*)::text AS n FROM tracked_prompts WHERE workspace_id = $1 AND ${PROMPT_OCCUPIES_SLOT}`
      : `SELECT count(*)::text AS n FROM tracked_prompts WHERE workspace_id = $1 AND project_id = $2 AND ${PROMPT_OCCUPIES_SLOT}`,
    projectId === undefined ? [workspaceId] : [workspaceId, projectId],
  );
  return Number(result.rows[0]!.n);
}

/**
 * Up to `count` tracked prompts, never exceeding EITHER `prompts.max_total`
 * or `prompts.max_per_project` (STORY-169 review, PROBE E — the seed
 * previously ignored both and could push a project or a workspace over its
 * plan's cap). SELECT-first rather than `INSERT … ON CONFLICT`: the cap
 * check needs to know, before writing, whether a template will consume a
 * NEW slot or merely resolve to a prompt that already exists — reusing an
 * existing id never costs headroom, and a demo seed is a single-operator
 * dev tool, never a concurrent write path, so the `ON CONFLICT` race safety
 * that pattern bought is not needed here.
 *
 * A row this call actually INSERTS is marked
 * `generator_meta->>'demo_seed_marker'` (never one it only reused) — the
 * marker `--purge` reads to remove exactly what the seed added to a
 * pre-existing project, leaving that project's own prompts alone.
 */
async function ensurePrompts(tx: ClientBase, project: DemoProjectRef, count: number): Promise<string[]> {
  const templates = DEMO_PROMPT_TEMPLATES.slice(0, Math.min(count, DEMO_PROMPT_TEMPLATES.length));

  // Sequential, deliberately — `tx` is a single pg client/transaction, and
  // concurrent queries on one connection are a deprecated pattern (pg 8.23
  // warns on it; pg 9 removes it), not real parallelism. Same posture as
  // `seed-demo.spec.ts`'s own `countsFor` helper.
  const perProjectCap = await structuralCap(tx, project.workspaceId, "prompts.max_per_project");
  const totalCap = await structuralCap(tx, project.workspaceId, "prompts.max_total");
  const perProjectUsed = await promptSlotsUsed(tx, project.workspaceId, project.id);
  const totalUsed = await promptSlotsUsed(tx, project.workspaceId);
  let headroom = Math.max(0, Math.min(perProjectCap - perProjectUsed, totalCap - totalUsed));

  const ids: string[] = [];
  for (const template of templates) {
    const text = template.text(project.name);
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM tracked_prompts WHERE project_id = $1 AND text_hash = sha256($2::bytea) AND deleted_at IS NULL`,
      [project.id, text],
    );
    if (existing.rows[0] !== undefined) {
      ids.push(existing.rows[0].id);
      continue;
    }
    if (headroom <= 0) continue; // the plan's cap is already full — an honestly smaller demo prompt set, never one that exceeds it
    const id = uuidV7();
    await tx.query(
      `INSERT INTO tracked_prompts
         (id, workspace_id, project_id, generation_source, text, text_hash, intent_archetype, funnel_stage, status, generator_meta)
       VALUES ($1,$2,$3,'generated',$4,sha256($5::bytea),$6,$7,'active',$8::jsonb)`,
      // `text` is bound TWICE ($4 and $5) rather than referencing $4 a second
      // time under a `::bytea` cast — Postgres's parser refuses to deduce two
      // different types for one parameter number within a single statement
      // ("inconsistent types deduced for parameter $4"), even though the two
      // usages here never conflict at the value level.
      [
        id,
        project.workspaceId,
        project.id,
        text,
        text,
        template.intentArchetype,
        template.funnelStage,
        JSON.stringify({ [DEMO_PROMPT_MARKER_KEY]: DEMO_SEED_MARKER }),
      ],
    );
    ids.push(id);
    headroom -= 1;
  }

  // AC10/§10's own invariant — `prompts_active`/`prompts_cap` are maintained
  // in the SAME transaction as any prompt-status change, never by a later
  // job (activation.service.ts's own rule). Every prompt this seed writes is
  // inserted `status='active'` directly, bypassing that service entirely, so
  // this call is what keeps the denormalised columns from going stale the
  // same way a real activation call would have kept them current.
  await tx.query(
    `UPDATE projects
        SET prompts_active = (SELECT count(*) FROM tracked_prompts WHERE project_id = $1 AND ${PROMPT_OCCUPIES_SLOT}),
            prompts_cap = $2,
            updated_at = now()
      WHERE id = $1`,
    // `projects.prompts_cap` is `smallint` (activation.service.ts's own
    // `PROMPTS_CAP_COLUMN_MAX` — duplicated here rather than imported
    // cross-module for a one-line constant from an unrelated story's file).
    [project.id, Math.min(perProjectCap, 32_767)],
  );

  return ids;
}

async function ensureCompetitors(tx: ClientBase, project: DemoProjectRef, rng: Rng): Promise<string[]> {
  const count = uniformInt(rng, 2, 3);
  const names = DEMO_COMPETITOR_NAMES.slice(0, count);

  // STORY-169 review, PROBE E — `competitors.max_per_project` is a real cap
  // this seed previously ignored entirely. `competitors` carries no jsonb
  // column to mark a seed-INSERTED row the way `tracked_prompts.
  // generator_meta` does above, so unlike prompts, a seeded competitor
  // cannot be told apart from the project's own and `--purge` cannot remove
  // it — a known, undecided gap (`purge.ts`'s own header comment). This at
  // least stops the seed from writing PAST the plan's ceiling.
  const cap = await structuralCap(tx, project.workspaceId, "competitors.max_per_project");
  const used = await (async () => {
    const result = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM competitors WHERE workspace_id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [project.workspaceId, project.id],
    );
    return Number(result.rows[0]!.n);
  })();
  let headroom = Math.max(0, cap - used);

  const ids: string[] = [];
  for (const [index, name] of names.entries()) {
    const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.example.com`;
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM competitors WHERE project_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`,
      [project.id, name],
    );
    if (existing.rows[0] !== undefined) {
      ids.push(existing.rows[0].id);
      continue;
    }
    if (headroom <= 0) continue; // the plan's cap is already full
    const id = uuidV7();
    await tx.query(
      `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source, is_primary)
       VALUES ($1,$2,$3,$4,$5,ARRAY[]::text[],'user',$6)`,
      [id, project.workspaceId, project.id, name, domain, index === 0],
    );
    ids.push(id);
    headroom -= 1;
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

/**
 * ⚠ REVIEW FIX (STORY-169 re-audit) — `earliestDay` IS A WORKSPACE-LOCAL
 * DATE, and it must be compared as one, never cast bare to `::date`.
 * `$2::date` is midnight in the SESSION's timezone (`Etc/UTC`), but this
 * function's callers now stamp `captured_at` at LOCAL NOON of each
 * workspace-local day (`workspaceLocalWindow`'s own header). For any
 * workspace at UTC+13 or above (Pacific/Auckland in NZDT, Pacific/
 * Tongatapu, Pacific/Kiritimati, Pacific/Apia…), local noon on the
 * earliest window day falls BEFORE midnight UTC of that same calendar
 * day — on `earliestDay - 1` in UTC — so a bare `captured_at >=
 * $2::date` filter silently excludes it: a same-day re-run duplicates
 * the earliest day's facts instead of replacing them, and `--purge`
 * leaves them behind as unmarked, undated synthetic data on a real
 * project (STORY-169 re-audit, PROBE G).
 *
 * The fix casts the BOUND into the workspace's own local midnight,
 * expressed as the UTC instant it actually is —
 * `$2::date::timestamp AT TIME ZONE $4` — rather than wrapping the
 * (indexed, partitioned) `captured_at` column in `AT TIME ZONE`, which
 * would give the same answer but defeat partition pruning on every
 * demo-seed delete.
 */
export async function deleteExistingDemoFacts(
  tx: ClientBase,
  projectId: string,
  earliestDay: string,
  timezone: string,
): Promise<void> {
  // NEW-C-3 — displacement events point at demo captures by id (no FK), so they
  // go first or they would outlive the captures they diagnose.
  await tx.query(
    `DELETE FROM displacement_events
      WHERE project_id = $1
        AND (after_result_id IN (
               SELECT id FROM answer_captures
                WHERE project_id = $1 AND captured_at >= ($2::date::timestamp AT TIME ZONE $4) AND normalizer_version = $3)
             OR before_result_id IN (
               SELECT id FROM answer_captures
                WHERE project_id = $1 AND captured_at >= ($2::date::timestamp AT TIME ZONE $4) AND normalizer_version = $3))`,
    [projectId, earliestDay, DEMO_SEED_MARKER, timezone],
  );
  await tx.query(
    `DELETE FROM mention_facts
      WHERE project_id = $1
        AND captured_at >= ($2::date::timestamp AT TIME ZONE $4)
        AND result_id IN (
          SELECT id FROM answer_captures
           WHERE project_id = $1 AND captured_at >= ($2::date::timestamp AT TIME ZONE $4) AND normalizer_version = $3
        )`,
    [projectId, earliestDay, DEMO_SEED_MARKER, timezone],
  );
  await tx.query(
    `DELETE FROM citation_facts
      WHERE project_id = $1
        AND captured_at >= ($2::date::timestamp AT TIME ZONE $4)
        AND result_id IN (
          SELECT id FROM answer_captures
           WHERE project_id = $1 AND captured_at >= ($2::date::timestamp AT TIME ZONE $4) AND normalizer_version = $3
        )`,
    [projectId, earliestDay, DEMO_SEED_MARKER, timezone],
  );
  await tx.query(
    `DELETE FROM answer_captures
      WHERE project_id = $1 AND captured_at >= ($2::date::timestamp AT TIME ZONE $4) AND normalizer_version = $3`,
    [projectId, earliestDay, DEMO_SEED_MARKER, timezone],
  );
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
  // NEW-C-3 — a competitor's seeded citations sit on ITS root domain, so the
  // displacement citation gap can attribute them (the only stored link from a
  // competitor to a slot is the domain).
  const competitorDomains = new Map(
    (await tx.query<{ id: string; root_domain: string | null }>(`SELECT id, root_domain FROM competitors WHERE project_id = $1`, [project.id])).rows.map(
      (r) => [r.id, r.root_domain] as const,
    ),
  );

  await deleteExistingDemoFacts(tx, project.id, days[0]!.day, timezone);

  if (engines.length === 0 || promptIds.length === 0) {
    // No entitled engine (a plan with none active) or no prompt slot at all
    // — an honestly empty demo project. Nothing further to write.
    return { days: days.map((d) => d.day), promptIds, competitorIds, engineKeys: [] };
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
    "render_form", "render_score", "position_class", "answer_form",
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

  for (const [dayIndex, { capturedAt }] of days.entries()) {
    for (const engine of profiles) {
      const presenceProbability = clamp01(engine.basePresence + engine.drift * dayIndex);
      const isAttributeCapable = ATTRIBUTE_CAPABLE_ENGINES.has(engine.engineKey);

      for (const promptId of promptIds) {
        const isForcedDay = forcedPresenceDayIndices.has(dayIndex) && promptId === promptIds[0];
        const forcedRendering = isForcedDay && isAttributeCapable;
        const present = isForcedDay || chance(rng, presenceProbability);

        const capture = buildCapture(rng, { engine, promptId, capturedAt, present });
        const answerForm = demoAnswerForm(promptId, engine.engineKey, dayIndex);

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
            answerForm,
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
            "bare_text", 0, "neutral_list", answerForm,
          ]);

          if (chance(rng, 0.5)) {
            cellCitations.push(
              buildCitation(project.workspaceId, project.id, capture, cellCitations.length + 1, competitorDomains.get(competitorId) ?? `${competitorId.slice(0, 8)}.example.com`, false, rng),
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

  return { days: days.map((d) => d.day), promptIds, competitorIds, engineKeys: engines.map((engine) => engine.engineKey) };
}

const DEMO_ANSWER_FORMS = [
  ["ranked_list", 28],
  ["comparison_table", 30],
  ["single_recommendation", 12],
  ["neutral_enumeration", 12],
  ["narrative", 18],
] as const;

/**
 * STORY-060 — the answer's form. Every mention row of one answer carries the
 * answer's form, so it is a function of the cell, not of the mention. A hash
 * rather than an `rng` draw, on purpose: drawing from the shared generator
 * would shift every number the seed produces after this point.
 */
function demoAnswerForm(promptId: string, engineKey: string, dayIndex: number): string {
  let h = 2166136261;
  for (const ch of `${promptId}|${engineKey}|${String(dayIndex)}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let pick = h % 100;
  for (const [form, weight] of DEMO_ANSWER_FORMS) {
    if (pick < weight) return form;
    pick -= weight;
  }
  return "narrative";
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
