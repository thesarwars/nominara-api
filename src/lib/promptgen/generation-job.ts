import type { ClientBase } from "pg";
import { z } from "zod";
import {
  generatePromptsRequestSchema,
  generatePromptsResponseSchema,
  type GeneratedVariant,
  type GeneratePromptsRequest,
  type GeneratePromptsResponse,
  type PromptGenerationFailureCode,
  type RejectedCandidate,
} from "../../../contracts/prompts/index.js";
import type { PromptNaturaliser } from "../../modules/prompts/ports/naturaliser.js";
import type { Cache } from "../cache/cache.port.js";
import type { TextEmbedder } from "../categories/classify.js";
import { PHASES_DONE } from "../queue/worker-factory.js";
import { l5TemplateCacheKey } from "./cache-key.js";
import type { Candidate } from "./emit.js";
import { DEFAULT_GENERATION_TEMPERATURE, DEFAULT_PRIORITY_SUBSET_SIZE, generatePass, type GeneratePass, type TemplateCache } from "./generate.js";
import { insertPromptStatement, type PromptRow } from "./persist.js";
import type { SlotContext } from "./slots.js";
import { promptTextHash } from "./text-hash.js";
import { compareInSql, type VectorDedupePort } from "./vector-dedupe.js";

// STORY-045 / OWNER DECISION 95(a) (2026-11-10) - the phases of the background prompt-generation job (`prompt.generate`).
//
// `POST /v1/projects/{id}/prompts/generate` used to run all of this inside the request's transaction. It now records a `prompt_generations`
// row and answers 202; this module is what the worker runs, in the three phases ADR-0003 prescribes:
//
//   prepare   one short tenant transaction: claim the row (pending -> running), read the project's context and its live text hashes.
//   run       NO transaction, no connection held: the pure pipeline (generatePass) with the naturaliser (a model call) and the embedder (an
//             embedding call) awaited. The only database access left is vector comparison, which is one SHORT transaction of its own per
//             comparison (`buildVectorDedupe`) - never one that spans the embedder's await.
//   commit    one short tenant transaction: the project-row lock, the hashes RE-READ, the inserts and the settled row, together.
//
// IDEMPOTENT UNDER AT-LEAST-ONCE DELIVERY. A delivery after the generation settled ends in `prepare`; two deliveries racing past `prepare`
// serialise on the generation row's lock in `commit`, and the loser finds it settled and writes nothing. A generation is settled exactly once
// (every settling UPDATE says `WHERE status IN ('pending','running')`).
//
// NOTHING HERE CHARGES, failed or not (FR-FAN-01g): no wallet, ledger, entitlement or usage statement exists in this file or anywhere it reaches.
//
// A naturaliser outage or an embedder outage is NOT a failed generation: the first falls back to the template text and the second to exact
// `text_hash` dedupe (generate.ts), and the pass is stored as it was actually produced - `naturalized` and `novelty` say what ran. What FAILS a
// generation is what cannot be honest about: a database error while comparing or writing, retried down the queue's ladder and then settled.

/** The queue's idempotency key (`promptgen:{generation}`): one generation, one job. */
export const promptGenerateKey = (generationId: string): string => `promptgen:${generationId}`;

export const generationJobPayloadSchema = z
  .object({
    generationId: z.string().uuid(),
    projectId: z.string().uuid(),
    // Added by the producer for every tenant-scoped queue; parsed so an unexpected shape fails at the boundary.
    workspaceId: z.string().uuid(),
    kid: z.string(),
  })
  .strict();
export type GenerationJobPayload = z.infer<typeof generationJobPayloadSchema>;

/** §8's L5 cache TTL: 30 days. */
const L5_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ProjectContextRow {
  name: string;
  root_domain: string;
  category_slug: string | null;
  verticals: string[] | null;
  locale: string | null;
  brand_aliases: string[] | null;
  /** Decision 112: the project's live competitors (primary first), the competitor slot's fallback when the request names none. */
  competitors?: string[] | null;
}

export interface GenerationPrepared {
  readonly generationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly request: GeneratePromptsRequest;
  readonly project: ProjectContextRow;
  /** Live `text_hash` (hex) -> owning prompt id, as of `prepare`. `commit` re-reads it under the project lock. */
  readonly existingHashes: ReadonlyMap<string, string>;
}

export interface GenerationRunDeps {
  /** Null = the template-only path (FR-FAN-01d). */
  readonly naturaliser: PromptNaturaliser | null;
  /** Null = exact-hash dedupe only and `novelty` not measured. */
  readonly vectorDedupe: VectorDedupePort | null;
  /** Only consulted when a naturaliser will run. */
  readonly cache: TemplateCache | null;
}

/** Runs `fn` in one short tenant transaction on a connection that is released when it returns. */
export type TenantTx = <T>(workspaceId: string, fn: (tx: ClientBase) => Promise<T>) => Promise<T>;

/**
 * `prepare`. Returns PHASES_DONE when there is nothing to do: the generation is not this workspace's, or already settled (a redelivery).
 * A project deleted since the request settles the generation `failed` here - retrying cannot bring it back.
 */
export async function prepareGeneration(tx: ClientBase, payload: GenerationJobPayload): Promise<GenerationPrepared | typeof PHASES_DONE> {
  // FOR UPDATE: two deliveries cannot both claim the row, and the claim is committed before `run` starts, so a poll mid-flight says `running`.
  const row = await tx.query<{ status: string; request: unknown }>(
    `SELECT status, request FROM prompt_generations WHERE id = $1 AND project_id = $2 AND workspace_id = app.current_workspace() FOR UPDATE`,
    [payload.generationId, payload.projectId],
  );
  const generation = row.rows[0];
  if (generation === undefined || generation.status === "succeeded" || generation.status === "failed") return PHASES_DONE;

  const project = await tx.query<ProjectContextRow>(
    `SELECT p.name, p.root_domain, p.category_slug, p.verticals, p.locale, p.brand_aliases,
            ARRAY(SELECT c.name FROM competitors c
                   WHERE c.project_id = p.id AND c.workspace_id = app.current_workspace() AND c.deleted_at IS NULL
                   ORDER BY c.is_primary DESC, c.created_at, c.id) AS competitors
       FROM projects p
      WHERE p.id = $1 AND p.workspace_id = app.current_workspace() AND p.deleted_at IS NULL`,
    [payload.projectId],
  );
  if (project.rows[0] === undefined) {
    await failGeneration(tx, payload.generationId, "project_not_found");
    return PHASES_DONE;
  }

  await tx.query(
    `UPDATE prompt_generations SET status = 'running', updated_at = now()
      WHERE id = $1 AND workspace_id = app.current_workspace() AND status IN ('pending', 'running')`,
    [payload.generationId],
  );

  return {
    generationId: payload.generationId,
    workspaceId: payload.workspaceId,
    projectId: payload.projectId,
    // The stored request was validated at the door; parsing it again is how a row written by an older shape fails loudly rather than odd.
    request: generatePromptsRequestSchema.parse(generation.request),
    project: project.rows[0],
    existingHashes: await loadExistingHashes(tx, payload.projectId),
  };
}

/** `run`. Takes no database client: the pipeline, its two external calls and nothing that holds a transaction. */
export async function runGeneration(prepared: GenerationPrepared, deps: GenerationRunDeps): Promise<GeneratePass> {
  const { request, project } = prepared;
  // The schema defaults these when the object is PRESENT; an absent object means the documented defaults.
  const generation = request.generation ?? {
    strategy: "template_first" as const,
    naturalizer_enabled: true,
    temperature: DEFAULT_GENERATION_TEMPERATURE,
    single_batched_call: true,
  };
  const naturaliserEnabled = generation.strategy !== "template_only" && generation.naturalizer_enabled;
  const naturaliser = naturaliserEnabled ? deps.naturaliser : null;

  return generatePass({
    generationBatchId: prepared.generationId,
    workspaceId: prepared.workspaceId,
    projectId: prepared.projectId,
    context: slotContext(project, request),
    existingHashes: prepared.existingHashes,
    batchSize: request.batch_size ?? 1,
    prioritySubsetSize: request.options?.priority_subset_size ?? DEFAULT_PRIORITY_SUBSET_SIZE,
    naturaliser,
    temperature: generation.temperature,
    ...(deps.vectorDedupe === null ? {} : { vectorDedupe: deps.vectorDedupe }),
    ...(request.topic_hint === undefined ? {} : { topicHint: request.topic_hint }),
    ...(project.locale === null ? {} : { locale: project.locale }),
    ...(request.archetype_plan?.include === undefined ? {} : { includeArchetypes: request.archetype_plan.include }),
    ...(request.archetype_plan?.exclude === undefined ? {} : { excludeArchetypes: request.archetype_plan.exclude }),
    // No cache when nothing will be naturalised: a template-only pass is already free and deterministic.
    ...(naturaliser !== null && deps.cache !== null ? { cache: deps.cache } : {}),
  });
}

/**
 * `commit`. The database tail, and the only part that holds the project-row lock (taken AFTER the provider calls, so a model call never runs
 * under a row lock that blocks discovery's prepare/commit, confirm and PATCH). Returns `already_settled` when another delivery got here first.
 */
export async function commitGeneration(tx: ClientBase, prepared: GenerationPrepared, pass: GeneratePass): Promise<"committed" | "already_settled"> {
  const state = await tx.query<{ status: string }>(
    `SELECT status FROM prompt_generations WHERE id = $1 AND workspace_id = app.current_workspace() FOR UPDATE`,
    [prepared.generationId],
  );
  const status = state.rows[0]?.status;
  if (status === undefined || status === "succeeded" || status === "failed") return "already_settled";

  await lockProject(tx, prepared.projectId);
  const committed = await loadExistingHashes(tx, prepared.projectId);

  // A prompt another writer committed between `prepare` and now (discovery's free allowance, a hand-written prompt) is a duplicate, reported as
  // one rather than failing the insert on `ux_prompts_project_hash`.
  const kept: number[] = [];
  const raced: RejectedCandidate[] = [];
  pass.rows.forEach((row, index) => {
    const owner = committed.get(row.textHash.toString("hex"));
    if (owner === undefined) {
      kept.push(index);
      return;
    }
    const candidate = pass.candidates[index]!;
    raced.push({
      text: row.text,
      text_hash: promptTextHash(row.text).wire,
      intent_archetype: candidate.archetype,
      template_id: candidate.templateId,
      reason: "rejected_duplicate",
      conflicting_prompt_id: owner,
    });
  });
  const rows = kept.map((index) => pass.rows[index]!);
  const candidates = kept.map((index) => pass.candidates[index]!);

  for (const row of rows) {
    const { sql, params } = insertPromptStatement(row);
    await tx.query(sql, [...params]);
  }

  const result: GeneratePromptsResponse = generatePromptsResponseSchema.parse({
    generation_batch_id: prepared.generationId,
    variants: rows.map((row, index) => toVariant(row, candidates[index]!.slots, candidates[index]!.novelty)),
    rejected: [...pass.rejected, ...raced],
    coverage: [...pass.coverage],
    summary:
      raced.length === 0
        ? pass.summary
        : {
            ...pass.summary,
            generated: candidates.length,
            accepted: candidates.length,
            rejected_duplicate: pass.summary.rejected_duplicate + raced.length,
            priority_flagged: rows.filter((row) => row.isPriority).length,
          },
    cached: pass.cached,
  });

  await tx.query(
    `UPDATE prompt_generations SET status = 'succeeded', result = $2::jsonb, completed_at = now(), updated_at = now()
      WHERE id = $1 AND workspace_id = app.current_workspace() AND status IN ('pending', 'running')`,
    [prepared.generationId, JSON.stringify(result)],
  );
  return "committed";
}

/** Settles an UNSETTLED generation as failed. False when it was already settled (a delivery that lost the race changes nothing). */
export async function failGeneration(tx: ClientBase, generationId: string, code: PromptGenerationFailureCode): Promise<boolean> {
  const updated = await tx.query(
    `UPDATE prompt_generations SET status = 'failed', failure_code = $2, completed_at = now(), updated_at = now()
      WHERE id = $1 AND workspace_id = app.current_workspace() AND status IN ('pending', 'running') RETURNING id`,
    [generationId, code],
  );
  return (updated.rowCount ?? updated.rows.length) > 0;
}

/**
 * §4 step 5's port for the job: the embedder is awaited with no transaction open, and every comparison is ONE short tenant transaction of its
 * own. `embed` failing propagates to generate.ts, which falls back to exact-hash dedupe; `compare` failing propagates to the job (fails closed).
 */
export function buildVectorDedupe(embedder: TextEmbedder, projectId: string, workspaceId: string, withTenantTx: TenantTx): VectorDedupePort {
  return {
    embed: async (texts) => (await embedder.embed(texts)).vectors,
    compare: (vectors) => withTenantTx(workspaceId, (tx) => compareInSql(tx, projectId, embedder.model, vectors)),
  };
}

/** §8's L5 cache, tenant-scoped and 30-day, behind the pipeline's narrow port. */
export function templateCacheFor(cache: Cache, workspaceId: string, nodeEnv: string): TemplateCache {
  const keyOf = (suffix: string): string => l5TemplateCacheKey({ env: nodeEnv, workspaceId, topicNorm: suffix, locale: "" });
  return {
    async get(suffix) {
      const raw = await cache.get(keyOf(suffix));
      if (raw === undefined) return undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        // A cache entry is not a contract: anything that is not an array of strings is a miss, not prompt text.
        if (!Array.isArray(parsed) || parsed.some((line) => typeof line !== "string")) return undefined;
        return parsed as readonly string[];
      } catch {
        return undefined;
      }
    },
    async set(suffix, lines) {
      await cache.set(keyOf(suffix), JSON.stringify(lines), { ttlMs: L5_TTL_MS });
    },
  };
}

/**
 * The project's own vocabulary, with the request's `brand_context` on top. §5 documents `brand_context` because onboarding generates BEFORE the
 * discovery confirm step has written anything; where a key is absent the stored value is used.
 */
function slotContext(project: ProjectContextRow, request: GeneratePromptsRequest): SlotContext {
  const supplied = request.brand_context ?? {};
  const value = <T>(from: T | undefined, fallback: T | null): T | undefined => from ?? fallback ?? undefined;
  return {
    ...optional("brandName", value(supplied.brand_name, project.name)),
    ...optional("categorySlug", value(supplied.category_slug, project.category_slug)),
    ...optional("verticals", value(supplied.verticals, project.verticals)),
    // Decision 112: the request's competitors win; absent (or empty), the project's confirmed ones fill the slot.
    ...optional(
      "competitors",
      supplied.competitors !== undefined && supplied.competitors.length > 0
        ? supplied.competitors.map((competitor) => competitor.name)
        : project.competitors !== undefined && project.competitors !== null && project.competitors.length > 0
          ? project.competitors
          : undefined,
    ),
    ...optional("personas", supplied.personas),
    ...optional("sizeBands", supplied.size_bands),
    ...optional("integrations", supplied.integrations),
    ...optional("complianceTerms", supplied.compliance_terms),
    ...optional("capabilities", supplied.capabilities),
  };
}

/** FOR NO KEY UPDATE is the lock crawl.discover's free-allowance writer takes on the same row: two writers of generated prompts cannot both read "nothing yet". */
async function lockProject(tx: ClientBase, projectId: string): Promise<void> {
  const locked = await tx.query<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL FOR NO KEY UPDATE`,
    [projectId],
  );
  if (locked.rows[0] === undefined) throw new ProjectGoneError();
}

/** The project was deleted between `prepare` and `commit`. Not retried: the recovery settles it `project_not_found`. */
export class ProjectGoneError extends Error {
  constructor() {
    super("the project was deleted while its prompts were being generated");
    this.name = "ProjectGoneError";
  }
}

/**
 * Every live `text_hash` in the project, mapped to the prompt that owns it. `deleted_at IS NULL` matches `ux_prompts_project_hash`'s own predicate:
 * a soft-deleted prompt does not hold its hash, so a candidate colliding with one must be ACCEPTED.
 */
async function loadExistingHashes(tx: ClientBase, projectId: string): Promise<ReadonlyMap<string, string>> {
  const result = await tx.query<{ id: string; text_hash: Buffer }>(
    `SELECT id, text_hash FROM tracked_prompts WHERE project_id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL`,
    [projectId],
  );
  return new Map(result.rows.map((row) => [row.text_hash.toString("hex"), row.id]));
}

/**
 * A stored row as §5's `variants[]` entry. `novelty` is what the vector comparison measured, or null on both members when none ran: reporting 0
 * would claim "measured, and maximally distant from everything". A MEASURED 0 stays 0.
 */
function toVariant(row: PromptRow, slots: Readonly<Record<string, string>>, novelty: Candidate["novelty"]): GeneratedVariant {
  const meta = row.generatorMeta as { template_id: string; naturalized: boolean; brand_named: boolean; competitor_named: boolean };
  return {
    prompt_id: row.id,
    text: row.text,
    text_hash: promptTextHash(row.text).wire,
    intent_archetype: row.intentArchetype as GeneratedVariant["intent_archetype"],
    funnel_stage: row.funnelStage,
    template_id: meta.template_id,
    naturalized: meta.naturalized,
    brand_named: meta.brand_named,
    competitor_named: meta.competitor_named,
    slots: { ...slots },
    novelty: {
      max_cosine_to_existing: novelty?.maxCosineToExisting ?? null,
      nearest_prompt_id: novelty?.nearestPromptId ?? null,
    },
    is_priority: row.isPriority,
    status: row.status,
  };
}

/** `exactOptionalPropertyTypes` forbids an explicit undefined, so a key is present or absent. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
