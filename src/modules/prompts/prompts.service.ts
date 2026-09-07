import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  GeneratePromptsRequest,
  GeneratePromptsResponse,
  GeneratedVariant,
} from "../../../contracts/prompts/index.js";
import { NotFoundError, PreconditionUnmetError } from "../../api/errors/domain-errors.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { l5TemplateCacheKey } from "../../lib/promptgen/cache-key.js";
import { generatePass, type ExistingHashes, type TemplateCache } from "../../lib/promptgen/generate.js";
import { insertPromptStatement, type PromptRow } from "../../lib/promptgen/persist.js";
import type { SlotContext } from "../../lib/promptgen/slots.js";
import { promptTextHash } from "../../lib/promptgen/text-hash.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { loadEnv } from "../../config/env.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { PROMPT_NATURALISER, type PromptNaturaliser } from "./ports/naturaliser.js";

// STORY-045 — `POST /v1/projects/{id}/prompts/generate`.
// api-specification.md §5, tracking-engine.md §4.
//
// THIN BY DESIGN. Every decision the generator makes lives in
// src/lib/promptgen/ as a pure function, so this file does four things and
// nothing else: read the project's context and its live text hashes, run the
// pass, insert the rows in one transaction, and shape the response. That
// split is what makes the backfill loop, the anonymous floor and the
// determinism guarantee testable without a database.
//
// §8's L5 cache TTL: 30 days.
const L5_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface ProjectContextRow {
  name: string;
  root_domain: string;
  category_slug: string | null;
  verticals: string[] | null;
  locale: string | null;
  brand_aliases: string[] | null;
}

@Injectable()
export class PromptsService {
  constructor(
    @Inject(CACHE) private readonly cache: Cache,
    // OPTIONAL, and that is the whole state of §4 step 4 today: no adapter is
    // bound because which model naturalises is a dependency decision
    // (development-workflow.md §6). Absent means every pass runs the
    // `template_only` path, which is not a degraded mode but FR-FAN-01d's
    // determinism guarantee.
    @Optional() @Inject(PROMPT_NATURALISER) private readonly naturaliser: PromptNaturaliser | null = null,
  ) {}

  async generate(projectId: string, request: GeneratePromptsRequest): Promise<GeneratePromptsResponse> {
    // BOTH REFUSALS BEFORE ANY WORK. A caller who asked for something this
    // build cannot do gets told so, rather than a plausible-looking response
    // that silently did something else.
    this.refuseUnsupported(request);

    const store = currentTenantStore();
    if (store === undefined) throw new Error("PromptsService.generate requires an active tenant context");
    const client = store.client;

    const project = await this.loadProjectContext(client, projectId);
    const existingHashes = await this.loadExistingHashes(client, projectId);

    // The schema defaults these when the object is PRESENT; an absent object
    // means the documented defaults, restated here rather than duplicated as
    // `?? "template_first"` at each use.
    const generation = request.generation ?? {
      strategy: "template_first" as const,
      naturalizer_enabled: true,
      temperature: 0.35,
      single_batched_call: true,
    };
    const naturaliserEnabled = generation.strategy !== "template_only" && generation.naturalizer_enabled;

    const pass = await generatePass({
      generationBatchId: uuidV7(),
      workspaceId: store.context.workspaceId,
      projectId,
      context: this.slotContext(project, request),
      existingHashes,
      batchSize: request.batch_size ?? 1,
      prioritySubsetSize: request.options?.priority_subset_size ?? 6,
      naturaliser: naturaliserEnabled ? this.naturaliser : null,
      temperature: generation.temperature,
      ...(request.topic_hint === undefined ? {} : { topicHint: request.topic_hint }),
      ...(project.locale === null ? {} : { locale: project.locale }),
      ...(request.archetype_plan?.include === undefined ? {} : { includeArchetypes: request.archetype_plan.include }),
      ...(request.archetype_plan?.exclude === undefined ? {} : { excludeArchetypes: request.archetype_plan.exclude }),
      // No cache when nothing will be naturalised — there is nothing worth
      // storing, and a `template_only` pass is already free and deterministic.
      ...(naturaliserEnabled && this.naturaliser !== null
        ? { cache: this.templateCache(store.context.workspaceId) }
        : {}),
    });

    for (const row of pass.rows) {
      const { sql, params } = insertPromptStatement(row);
      await client.query(sql, [...params]);
    }

    return {
      generation_batch_id: pass.rows[0]?.generationBatchId ?? uuidV7(),
      variants: pass.rows.map((row, index) => this.toVariant(row, pass.candidates[index]!.slots)),
      rejected: [...pass.rejected],
      coverage: [...pass.coverage],
      summary: pass.summary,
      cached: pass.cached,
    };
  }

  /**
   * The two documented request members this build cannot honour.
   *
   * `422 precondition_unmet` and not a new error code: `error-code.schema.ts`
   * is a closed union whose own header says "a new code is a specification
   * change to §2 first, this file second — never the other way round".
   *
   * MESSAGE ONLY, no `details`. §2 states no details member for
   * `precondition_unmet`, and `domain-errors.ts` types that as
   * `details?: never` on purpose — "inventing one at a throw site is now a
   * type error rather than a silent new contract nobody reviewed". A
   * structured `{ reason }` was tried first and correctly refused to compile;
   * the reason belongs in the message until §2 gives the code a shape.
   *
   * REFUSED RATHER THAN IGNORED. A caller who set `auto_activate` and
   * received `activated: 0` cannot tell that apart from activation running
   * and selecting nothing — the same shape of quiet lie as an empty project
   * list over a populated database.
   */
  private refuseUnsupported(request: GeneratePromptsRequest): void {
    if (request.options?.auto_activate === true) {
      throw new PreconditionUnmetError({
        message: "auto_activate requires prompt activation, which is not implemented yet — STORY-046 owns the cap binding",
      });
    }
    if (request.generation?.strategy === "model_first") {
      throw new PreconditionUnmetError({
        message: "generation.strategy 'model_first' is reserved for custom grammars and is not implemented",
      });
    }
  }

  /**
   * The project's own vocabulary, with the request's `brand_context` on top.
   *
   * §5 documents `brand_context` on the wire because onboarding generates
   * BEFORE the discovery confirm step has written anything — so a caller can
   * supply what the row does not have yet. Where a key is absent the stored
   * value is used, which is why a caller sending only `topic_hint` still gets
   * a full pass.
   *
   * NO WORKSPACE PREDICATE in the query below: RLS scopes the tenant
   * (`NFR-SEC-01`), and adding one would imply the boundary lives here.
   */
  private slotContext(project: ProjectContextRow, request: GeneratePromptsRequest): SlotContext {
    const supplied = request.brand_context ?? {};
    const value = <T>(from: T | undefined, fallback: T | null): T | undefined => from ?? fallback ?? undefined;

    return {
      ...optional("brandName", value(supplied.brand_name, project.name)),
      ...optional("categorySlug", value(supplied.category_slug, project.category_slug)),
      ...optional("verticals", value(supplied.verticals, project.verticals)),
      ...optional("competitors", supplied.competitors?.map((competitor) => competitor.name)),
      ...optional("personas", supplied.personas),
      ...optional("sizeBands", supplied.size_bands),
      ...optional("integrations", supplied.integrations),
      ...optional("complianceTerms", supplied.compliance_terms),
      ...optional("capabilities", supplied.capabilities),
    };
  }

  private async loadProjectContext(
    client: { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> },
    projectId: string,
  ): Promise<ProjectContextRow> {
    const result = await client.query<ProjectContextRow>(
      `SELECT name, root_domain, category_slug, verticals, locale, brand_aliases
         FROM projects
        WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    const project = result.rows[0];
    if (project === undefined) throw new NotFoundError({ message: "no such project" });
    return project;
  }

  /**
   * Every live `text_hash` in the project, mapped to the prompt that owns it.
   *
   * Read in ONE query rather than probed per candidate: fifteen round trips
   * on the request path to answer a question one query answers, and the
   * pipeline needs the whole set anyway to dedupe within the batch.
   *
   * `deleted_at IS NULL` matches `ux_prompts_project_hash`'s own predicate
   * exactly — a soft-deleted prompt does not hold its hash, so a candidate
   * colliding with one must be ACCEPTED. Using a wider predicate here would
   * reject a variant the index would have let through.
   */
  private async loadExistingHashes(
    client: { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> },
    projectId: string,
  ): Promise<ExistingHashes> {
    const result = await client.query<{ id: string; text_hash: Buffer }>(
      `SELECT id, text_hash FROM tracked_prompts WHERE project_id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    return new Map(result.rows.map((row) => [row.text_hash.toString("hex"), row.id]));
  }

  /** §8's L5 cache, tenant-scoped and 30-day, behind the pipeline's narrow port. */
  private templateCache(workspaceId: string): TemplateCache {
    const env = loadEnv();
    const cache = this.cache;
    return {
      async get(suffix) {
        const raw = await cache.get(l5TemplateCacheKey({ env: env.NODE_ENV, workspaceId, topicNorm: suffix, locale: "" }));
        if (raw === undefined) return undefined;
        try {
          const parsed: unknown = JSON.parse(raw);
          // A cache entry is not a contract. Anything that is not an array of
          // strings is treated as a miss rather than trusted into prompt text
          // — the entry may predate a code change, or have been written by a
          // version that stored a different shape.
          if (!Array.isArray(parsed) || parsed.some((line) => typeof line !== "string")) return undefined;
          return parsed as readonly string[];
        } catch {
          return undefined;
        }
      },
      async set(suffix, lines) {
        await cache.set(
          l5TemplateCacheKey({ env: env.NODE_ENV, workspaceId, topicNorm: suffix, locale: "" }),
          JSON.stringify(lines),
          { ttlMs: L5_TTL_MS },
        );
      },
    };
  }

  /**
   * A stored row as §5's `variants[]` entry.
   *
   * `novelty` is null on both members, and that is the honest value rather
   * than a convenience: nothing computes an embedding (`G3`, STORY-133), so
   * `max_cosine_to_existing` was not MEASURED. Reporting 0 would claim
   * "measured, and maximally distant from everything" — a novelty check that
   * reads as passed.
   */
  private toVariant(row: PromptRow, slots: Readonly<Record<string, string>>): GeneratedVariant {
    const meta = row.generatorMeta as {
      template_id: string;
      naturalized: boolean;
      brand_named: boolean;
      competitor_named: boolean;
    };
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
      novelty: { max_cosine_to_existing: null, nearest_prompt_id: null },
      is_priority: row.isPriority,
      status: row.status,
    };
  }
}

/** `exactOptionalPropertyTypes` forbids an explicit undefined, so a key is present or absent. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
