import type { ClientBase } from "pg";
import type { DiscoveryResponse } from "../../../contracts/projects/index.js";
import { uuidV7 } from "../ids/uuidv7.js";
import { generatePass } from "../promptgen/generate.js";
import { insertPromptStatement, type PromptRow } from "../promptgen/persist.js";
import type { SlotContext } from "../promptgen/slots.js";

// STORY-043 AC12 (first half) — "the free prompt allowance is generated and charges nothing" (product-spec.md FR-ONB-02c: the first
// 10 prompts are free).
//
// WHAT THE ALLOWANCE IS. The same template grammar STORY-045 ships, run once with NO naturaliser and NO embedder: no model call, so
// nothing here can cost a credit or wait on a provider, and there is no wallet or ledger call anywhere in this file's reach. The 15
// variants a pass yields are trimmed to the allowance, PRIORITY PROMPTS FIRST, so trimming never drops the ones prioritisation
// picked as most informative.
//
// STORED `archived`, exactly as FR-FAN-01g stores any generated variant: generation activates nothing, so no plan slot is consumed
// (`PROMPT_OCCUPIES_SLOT` excludes archived). Activating them stays STORY-046's job, at 0 credits for the first ten.
// `generation_source` is 'generated' (the column's CHECK has no 'discovery'; and STORY-046's "one free ten" counts generated rows, so
// a distinct value would double it); the discovery origin lives in `generator_meta.origin`, which is also how a redelivered job
// finds what it already wrote. The wire says "discovery" because §4.5 does.
//
// THIN CONTEXT IS REPORTED, NOT PADDED. The grammar fills a template only from slots the project really has; a brand with no category
// (the 180-category taxonomy does not exist, so discovery cannot supply one) fills a single template. That is what is generated, and
// `prompts_free_remaining` says how much of the allowance is still unused. A URL-only project's row carries its DOMAIN as its name
// (projects.service inserts `name = root_domain` as a placeholder): that is not a brand, so it is never written into a prompt.
// The top-up is STORY-044's confirm step (ProjectsService.confirmDiscovery calls this again once a name, category or products are
// confirmed): this function is idempotent, so calling it again generates only what the confirmed context now fills.
//
// ONE ALLOWANCE, NOT TWO WRITERS. Onboarding calls POST /prompts/generate straight after creation (PromptsService.generate), and
// STORY-046's "one free ten" counts `generation_source='generated'` rows. So EVERY live generated row, whoever wrote it, counts toward
// the ten; discovery only returns (in the wire list) the ones it wrote itself. PromptsService.generate takes the same project-row lock,
// so the two cannot both read "nothing yet".
//
// IDEMPOTENT under at-least-once delivery: the project row is locked first, prompts already generated are counted, and only the
// shortfall is generated (so a job that died halfway tops up rather than doubling).

type GeneratedPrompt = DiscoveryResponse["prompts_generated"][number];

export const DISCOVERY_ORIGIN = "discovery";
const WIRE_SOURCE = "discovery";
const PRIORITY_SUBSET_SIZE = 6;

interface ProjectRow {
  name: string | null;
  root_domain: string | null;
  category_slug: string | null;
  verticals: string[] | null;
  locale: string | null;
}

interface StoredPrompt {
  id: string;
  text: string;
  intent_archetype: string;
  funnel_stage: string;
  origin: string | null;
}

function wire(prompt: { id: string; text: string; intent: string; stage: string }): GeneratedPrompt {
  return {
    prompt_id: prompt.id,
    text: prompt.text,
    intent_archetype: prompt.intent,
    funnel_stage: prompt.stage,
    generation_source: WIRE_SOURCE,
  };
}

export interface FreeAllowanceInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly allowance: number;
}

export interface FreeAllowanceResult {
  /** The prompts discovery itself wrote (a redelivery returns the same ones). */
  readonly prompts: GeneratedPrompt[];
  /** What is left of the allowance after EVERY live generated prompt, whoever wrote it. `0` is "used up"; never negative. */
  readonly remaining: number;
}

/** Runs inside the job's tenant transaction (no workspace predicate in a SELECT: RLS scopes it). */
export async function generateFreeAllowance(tx: ClientBase, input: FreeAllowanceInput): Promise<FreeAllowanceResult> {
  if (input.allowance <= 0) return { prompts: [], remaining: Math.max(0, input.allowance) };

  // The lock is what makes two concurrent deliveries serialise: the second sees the first's rows.
  const projects = await tx.query<ProjectRow>(
    `SELECT name, root_domain, category_slug, verticals, locale FROM projects WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`,
    [input.projectId],
  );
  const project = projects.rows[0];
  if (project === undefined) return { prompts: [], remaining: input.allowance };

  const existing = await tx.query<StoredPrompt>(
    `SELECT id, text, intent_archetype, funnel_stage, generator_meta->>'origin' AS origin FROM tracked_prompts
      WHERE project_id = $1 AND deleted_at IS NULL AND generation_source = 'generated'
      ORDER BY created_at, id`,
    [input.projectId],
  );
  const kept = existing.rows
    .filter((row) => row.origin === DISCOVERY_ORIGIN)
    .slice(0, input.allowance)
    .map((row) => wire({ id: row.id, text: row.text, intent: row.intent_archetype, stage: row.funnel_stage }));
  const shortfall = input.allowance - existing.rows.length;
  if (shortfall <= 0) return { prompts: kept, remaining: 0 };

  const hashes = await tx.query<{ id: string; text_hash: Buffer }>(
    `SELECT id, text_hash FROM tracked_prompts WHERE project_id = $1 AND deleted_at IS NULL`,
    [input.projectId],
  );

  // `name = root_domain` is the URL-only placeholder, not a brand: leave the slot absent rather than print the domain into a prompt.
  const isPlaceholderName = project.name === null || project.name.trim().toLowerCase() === (project.root_domain ?? "").trim().toLowerCase();
  const context: SlotContext = {
    ...(isPlaceholderName || project.name === null ? {} : { brandName: project.name }),
    ...(project.category_slug === null ? {} : { categorySlug: project.category_slug }),
    ...(project.verticals === null ? {} : { verticals: project.verticals }),
  };
  const pass = await generatePass({
    generationBatchId: uuidV7(),
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    context,
    existingHashes: new Map(hashes.rows.map((row) => [row.text_hash.toString("hex"), row.id])),
    // Two surfaces per archetype: a project with a category and a vertical fills 13, so ten can be chosen with priority first.
    batchSize: 2,
    prioritySubsetSize: PRIORITY_SUBSET_SIZE,
    naturaliser: null,
    temperature: 0,
    ...(project.locale === null ? {} : { locale: project.locale }),
  });

  // Priority first, then the pass's own order; stable, so the result is deterministic.
  const chosen: PromptRow[] = pass.rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => Number(b.row.isPriority) - Number(a.row.isPriority) || a.index - b.index)
    .slice(0, shortfall)
    .sort((a, b) => a.index - b.index)
    .map(({ row }) => ({ ...row, generatorMeta: { ...row.generatorMeta, origin: DISCOVERY_ORIGIN } }));

  for (const row of chosen) {
    const { sql, params } = insertPromptStatement(row);
    await tx.query(sql, [...params]);
  }

  return {
    prompts: [...kept, ...chosen.map((row) => wire({ id: row.id, text: row.text, intent: row.intentArchetype, stage: row.funnelStage }))],
    remaining: shortfall - chosen.length,
  };
}
