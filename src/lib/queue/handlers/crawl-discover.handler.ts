import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import type { Job } from "bullmq";
import { z } from "zod";
import { LOW_CONFIDENCE_THRESHOLD, type DiscoveredField, type DiscoveryResponse } from "../../../../contracts/projects/index.js";
import { classifyCategory, type CategoryDescriptor, type TextEmbedder } from "../../categories/classify.js";
import { mergeCategoryPeers } from "../../categories/peers.js";
import { loadCategoryPeers, loadTaxonomy } from "../../categories/taxonomy.js";
import { DEFAULT_DISCOVER_DEPS, discover, FREE_PROMPT_ALLOWANCE, type DiscoverDeps } from "../../discovery/discover.js";
import { generateFreeAllowance } from "../../discovery/free-prompts.js";
import { defaultDiscoveryLatencyMonitor } from "../../discovery/latency-alert.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import { emailAlert } from "../../alerts/alerts.js";
import { CATEGORY_EMBED_ALERT_NAME, CategoryEmbedBudget, InMemoryTokenCounterStore } from "../../categories/embed-budget.js";
import { textEmbedderFor } from "./embed-batch.handler.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor, type PhaseFailure, type TenantStep } from "../worker-factory.js";

// STORY-043 — the first real entry in STORY-124's registry, and the one its
// own comment named: "crawl.discover with STORY-043".
//
// `tx` is a transaction already inside the job's tenant context: worker-factory
// verified the signature first, then withTenantJob opened the context on the
// client it acquired. So every query below is RLS-scoped to the job's
// workspace without this file setting anything — which is why it must not
// take a workspace_id predicate of its own (NFR-SEC-01: the filter lives in
// the policy, not in application SQL).

const payloadSchema = z
  .object({
    projectId: z.string().uuid(),
    rootUrl: z.string(),
    fieldsSupplied: z.array(z.string()).default([]),
    // Added by the producer for every tenant-scoped queue; parsed here so an
    // unexpected payload shape fails loudly at the boundary rather than as an
    // undefined three frames in.
    workspaceId: z.string().uuid(),
    kid: z.string(),
  })
  .strict();

interface Prepared {
  readonly payload: z.infer<typeof payloadSchema>;
  readonly rootDomain: string;
  /** When the project (and so the job) was submitted: AC15's clock starts here, not when `discover()` does. */
  readonly submittedAt: Date | null;
  readonly knownBrandNames: readonly string[];
  /** Field names a person decided: skipped by `discover`, then carried forward verbatim. */
  readonly humanDecided: readonly string[];
  readonly preserved: Record<string, unknown>;
  /** What `projects.discovery` held when the pass began: a checkpoint keeps its other parts (competitors, prompts) until the commit replaces them. */
  readonly stored: unknown;
  /** STORY-189 — the taxonomy to classify against, read in `prepare`. Empty when the category is supplied or decided, or nothing is seeded. */
  readonly categories: readonly CategoryDescriptor[];
  /** The category the project already holds (supplied at creation, or confirmed): where its curated peers come from. */
  readonly currentCategory: string | null;
}

// ADR-0003 / NFR-ARCH-04 — a PHASED job. The middle of this handler is a fetch of a site we do not control, so it must not hold a
// tenant transaction (or the pooled connection under it) across that await.
//   prepare  short tenant transaction: confirm the project, mark it running (committed BEFORE the fetch, so a poll mid-flight says so).
//   run      NO transaction: the guarded fetch and the pure parsing.
//   commit   short tenant transaction: the free allowance and the review payload, written together.
export function createCrawlDiscoverHandler(context: QueueHandlerContext, deps?: DiscoverDeps, categoryEmbedder?: TextEmbedder, categoryBudget?: CategoryEmbedBudget): JobProcessor {
  const logger = new Logger("crawl.discover");
  // Built on first use: a process that never classifies (nothing seeded, or every category supplied) never selects a provider.
  let embedder: TextEmbedder | undefined = categoryEmbedder;
  // STORY-189 AC7 / decision 107(b) - the spend limit. Env values are optional on the context (absent = the documented defaults).
  const budget =
    categoryBudget ??
    new CategoryEmbedBudget({
      store: context.categoryTokenStore ?? new InMemoryTokenCounterStore(),
      ...(context.env.CATEGORY_EMBED_MAX_INPUT_TOKENS === undefined ? {} : { maxInputTokens: context.env.CATEGORY_EMBED_MAX_INPUT_TOKENS }),
      ...(context.env.CATEGORY_EMBED_DAILY_TOKEN_CEILING === undefined ? {} : { dailyCeiling: context.env.CATEGORY_EMBED_DAILY_TOKEN_CEILING }),
    });
  const embedderFor = (): TextEmbedder => (embedder ??= textEmbedderFor(context.env));

  return phasedProcessor<Prepared, DiscoveryResponse>({
    async prepare(tx: ClientBase, job: Job) {
      const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);

      // The project's own root_domain, read back rather than carried on the job.
      // A job payload is a snapshot from enqueue time; the row is the truth, and
      // reading it also confirms the project still exists — it may have been
      // deleted between creation and this job being picked up.
      const project = await tx.query<{ root_domain: string; discovery: unknown; name?: string | null; brand_aliases?: string[] | null; created_at?: Date | string | null; category_slug?: string | null }>(
        "SELECT root_domain, discovery, name, brand_aliases, created_at, category_slug FROM projects WHERE id = $1 AND deleted_at IS NULL",
        [payload.projectId],
      );
      const row = project.rows[0];
      if (row === undefined) {
        // Deleted, or in another tenant and invisible to RLS. Either way there
        // is nothing to enrich and nothing wrong — returning is correct, and
        // throwing would send a job down the retry ladder for a project that no
        // longer exists.
        logger.log(`project ${payload.projectId} is gone; skipping discovery`);
        return PHASES_DONE;
      }

      await tx.query("UPDATE projects SET discovery_status = 'running' WHERE id = $1", [payload.projectId]);

      // STORY-044 AC4/scenario 5 — a field a human overrode is NEVER overwritten by a later pass. Folded into the same
      // `fieldsSupplied` skip list that makes "supplied wins" work: both mean "a person decided this, do not derive it".
      const humanDecided = userEditedFields(row.discovery);
      // STORY-189 — a global, read-only table: nothing to filter by tenant. Not read at all when the category is already decided.
      const categories = categoryIsDecided(payload.fieldsSupplied, humanDecided) ? [] : await loadTaxonomy(tx);
      return {
        payload,
        rootDomain: row.root_domain,
        submittedAt: toDate(row.created_at),
        knownBrandNames: [...(row.name ? [row.name] : []), ...(row.brand_aliases ?? [])],
        humanDecided,
        preserved: userEditedEntries(row.discovery),
        stored: row.discovery,
        categories,
        currentCategory: row.category_slug ?? null,
      };
    },

    // `discover` does not throw for a site-side problem — it returns `partial` or `failed` with whatever it obtained (AC13). A
    // throw here would be OUR bug, and should reach the retry ladder.
    // The category classification (an embedding call) lives HERE, in `run`: no transaction and no pooled connection is held across it
    // (ADR-0003 / KAD-06). A provider failure proposes no category; it never fails the pass.
    async run(prepared, _job, step?: TenantStep) {
      const classification = { attempted: false, failed: false, tokens: 0, refused: undefined as "daily_ceiling" | "budget_unavailable" | undefined };
      const classify =
        prepared.categories.length === 0
          ? undefined
          : (siteText: string) =>
              trace.getTracer("nominara.discovery").startActiveSpan("discovery.classify_category", async (span) => {
                classification.attempted = true;
                try {
                  const admitted = await budget.admit(siteText);
                  if (admitted.status === "refused") {
                    // Not classified, with the reason; the pass carries on. No provider call, and nothing charged to the workspace.
                    classification.refused = admitted.reason;
                    span.setAttribute("nominara.discovery.category_refused", admitted.reason);
                    return null;
                  }
                  // Tokens are paid for whether or not a category matches, so settle with what was spent, not with the result's.
                  const spend = { tokens: 0 };
                  let result: Awaited<ReturnType<typeof classifyCategory>>;
                  try {
                    result = await classifyCategory(admitted.text, prepared.categories, embedderFor(), spend);
                  } finally {
                    await budget.settle(admitted.reservedTokens, spend.tokens, admitted.dayKey);
                    classification.tokens += spend.tokens;
                  }
                  span.setAttribute("nominara.discovery.category_found", result !== null);
                  return result;
                } catch (error) {
                  classification.failed = true;
                  span.setStatus({ code: SpanStatusCode.ERROR });
                  throw error;
                } finally {
                  span.end();
                }
              });
      // STORY-195 AC6 - each field is written as it is found, in its own short tenant transaction (`step`), so `GET /projects/{id}/discovery`
      // shows it with its confidence before the pass ends. Progress only: the commit below is authoritative, and a failed checkpoint is
      // counted and skipped, never allowed to fail the pass.
      const onFields =
        step === undefined
          ? undefined
          : async (found: Readonly<Record<string, DiscoveredField>>): Promise<void> => {
              try {
                await step((tx) => writeCheckpoint(tx, prepared, found));
              } catch (error) {
                incrementCounter("nominara_discovery_checkpoint_failed_total", {});
                logger.warn(`workspace ${prepared.payload.workspaceId} project ${prepared.payload.projectId}: discovery checkpoint not written (${error instanceof Error ? error.name : "unknown"})`);
              }
            };
      const result = await discover(
        {
          rootUrl: prepared.payload.rootUrl,
          rootDomain: prepared.rootDomain,
          fieldsSupplied: [...prepared.payload.fieldsSupplied, ...prepared.humanDecided],
          knownBrandNames: prepared.knownBrandNames,
        },
        {
          ...(deps ?? DEFAULT_DISCOVER_DEPS),
          ...(classify === undefined ? {} : { classify }),
          ...(onFields === undefined ? {} : { onFields }),
          // STORY-190 - counts and ids only: never a page URL, its text or a competitor name.
          onComparisonPages: (s) =>
            logger.log(
              `workspace ${prepared.payload.workspaceId} project ${prepared.payload.projectId}: comparison pages ${String(s.selected)} selected, ${String(s.fetched)} read, ` +
                `${String(s.offSite)} off-site, ${String(s.redirectedOff)} redirected off-site, ${String(s.refused)} refused, ${String(s.failed)} failed, ${String(s.skippedBudget)} over budget`,
            ),
        },
      );
      const category = result.fields.category;
      const outcome = categoryIsDecided(prepared.payload.fieldsSupplied, prepared.humanDecided)
        ? "supplied"
        : classification.refused !== undefined
          ? classification.refused === "daily_ceiling"
            ? "budget_exhausted"
            : "budget_unavailable"
          : classification.failed
          ? "failed"
          : category === undefined
            ? "none"
            : category.confidence < LOW_CONFIDENCE_THRESHOLD
              ? "low_confidence"
              : "proposed";
      incrementCounter("nominara_discovery_category_total", { outcome });
      if (classification.refused !== undefined) {
        // Workspace and project IDs only. The alert is fixed text plus IDs and numbers (see Pager).
        logger.warn(`workspace ${prepared.payload.workspaceId} project ${prepared.payload.projectId}: category not classified (${classification.refused})`);
        emailAlert("category classification skipped: the daily embedding token ceiling is reached or its counter is unreadable", {
          alertName: CATEGORY_EMBED_ALERT_NAME,
          reason: classification.refused,
          ceilingTokens: budget.ceiling,
        });
      }
      // What the provider reported for this pass. The budget is stated, not metered to the workspace: one site text of at most
      // MAX_CLASSIFICATION_TEXT_CHARS, plus the category vectors once per process and model.
      if (classification.attempted && classification.tokens > 0) observeValue("nominara_discovery_category_embed_tokens_total", classification.tokens);
      return result;
    },

    async commit(tx: ClientBase, prepared: Prepared, result: DiscoveryResponse) {
      const { payload } = prepared;

      // AC12 (first half) — the free allowance, generated and charged nothing. A caller who supplied prompts at creation has
      // already chosen them: supplied wins, so nothing is generated and the allowance is untouched. (Whether supplied prompts should
      // use up part of the ten is a product question, reported to the owner rather than decided here.)
      const allowance = payload.fieldsSupplied.includes("prompts")
        ? { prompts: [], remaining: FREE_PROMPT_ALLOWANCE }
        : await generateFreeAllowance(tx, { workspaceId: payload.workspaceId, projectId: payload.projectId, allowance: FREE_PROMPT_ALLOWANCE });
      const generated = allowance.prompts;

      // The overridden entries are carried forward verbatim: `discover` skipped them, so without this they would vanish from the
      // payload and the NEXT pass would re-derive them.
      // Merged against the row AS IT IS NOW, not the prepare-time snapshot: a person may have confirmed or overridden a field while the pass
      // ran (confirm is allowed mid-pass), and that decision must survive this write (STORY-044 AC4).
      const current = await readCurrent(tx, payload.projectId);
      const decided = current === undefined ? prepared.preserved : userEditedEntries(current.discovery);
      const fields = { ...result.fields, ...(decided as DiscoveryResponse["fields"]) };
      const peerBase = current === undefined ? prepared.currentCategory : current.categorySlug;

      // STORY-189 AC5 — curated category peers, after the site's own comparison links. The category is the one the project already holds
      // (supplied at creation or confirmed), else the one just discovered when it is confident; a low-confidence guess brings no peers.
      // Not proposed when the caller supplied competitors. A global read: peers are never derived from other customers' projects.
      const peerCategory = peerBase ?? confidentCategory(fields.category);
      const competitors =
        peerCategory === null || payload.fieldsSupplied.includes("competitors")
          ? result.competitors_proposed
          : mergeCategoryPeers({ own: result.competitors_proposed, peers: await loadCategoryPeers(tx, peerCategory), ownDomain: prepared.rootDomain });

      const merged: DiscoveryResponse = {
        ...result,
        fields,
        // A field a person decided is no longer awaiting confirmation, however uncertain the machine was about it.
        low_confidence_fields: result.low_confidence_fields.filter((name) => !(name in decided)),
        competitors_proposed: competitors,
        prompts_generated: generated,
        prompts_free_remaining: allowance.remaining,
      };

      // The whole review payload into `discovery`, and only the STATUS onto its own column. Nothing here writes name, description,
      // category or aliases: a discovered value is applied by STORY-044's confirm step, not by the pass that found it.
      await tx.query("UPDATE projects SET discovery = $2, discovery_status = $3, updated_at = now() WHERE id = $1", [
        payload.projectId,
        JSON.stringify(merged),
        merged.discovery_status,
      ]);

      // AC15 / edge-cases-and-slos.md row 33 — the objective is "URL submitted -> confidence-scored payload", so the clock starts at
      // SUBMISSION (the project row's created_at) and stops here, after the queue wait, the prepare transaction and the commit above.
      // A row with no submission time is no observation: `0` would read as an instant pass. `discover()`'s own timer stays as a
      // sub-measure, so a slow site can be told apart from a backlog.
      const now = (deps?.now ?? Date.now)();
      if (prepared.submittedAt !== null) {
        const sinceSubmissionMs = Math.max(0, now - prepared.submittedAt.getTime());
        observeValue("nominara_discovery_duration_seconds", sinceSubmissionMs / 1000, { status: merged.discovery_status });
        // AC15 - the judge of the objective. Every status counts, as it does in the duration metric: a pass that timed out is the slow case it exists to catch.
        defaultDiscoveryLatencyMonitor.observe(sinceSubmissionMs);
      }
      if (merged.duration_ms !== null && merged.duration_ms !== undefined) {
        observeValue("nominara_discovery_run_seconds", merged.duration_ms / 1000, { status: merged.discovery_status });
      }
      incrementCounter("nominara_discovery_completed_total", { status: merged.discovery_status });

      // Counts and IDs only: never the brand, a competitor or prompt text, none of which belongs in a log line.
      logger.log(
        `workspace ${payload.workspaceId} project ${payload.projectId}: ${merged.discovery_status} in ${String(merged.duration_ms ?? 0)}ms, ` +
          `${String(Object.keys(merged.fields).length)} field(s), ${String(merged.low_confidence_fields.length)} low-confidence, ` +
          `${String(merged.competitors_proposed.length)} competitor(s) (${String(merged.competitors_proposed.filter((c) => c.basis === "category peer").length)} category peer), ` +
          `category ${merged.fields.category === undefined ? "none" : merged.low_confidence_fields.includes("category") ? "low-confidence" : "proposed"}, ${String(generated.length)} prompt(s) generated, ` +
          `${String(prepared.humanDecided.length)} preserved from a human decision`,
      );
    },

    // `prepare` commits 'running' BEFORE the fetch, so a job that then fails until its retries run out would leave the project
    // 'running' for ever. AC13: failed or partial, still usable. On the LAST attempt only (an earlier one is the queue's retry
    // ladder), mark it partial and keep whatever the run obtained. `IN ('pending','running')` so a completed payload that another
    // delivery wrote is never clobbered. Runs in a fresh tenant transaction, after signature verification.
    async recover(tx: ClientBase, job: Job, failure: PhaseFailure<Prepared, DiscoveryResponse>) {
      if (!isFinalAttempt(job)) return false;
      const payload = payloadSchema.safeParse((job.data as { payload: unknown }).payload);
      if (!payload.success) return false;

      // The same carry-forward `commit` does, against the row as it is now: `discover` skipped the human-decided fields, so without this a
      // failed commit would drop them from the stored payload and the next pass would re-derive them (STORY-044 AC4).
      const current = failure.fetched === undefined ? undefined : await readCurrent(tx, payload.data.projectId);
      const decided = current === undefined ? (failure.prepared?.preserved ?? {}) : userEditedEntries(current.discovery);
      const kept: DiscoveryResponse | undefined =
        failure.fetched === undefined
          ? undefined
          : {
              ...failure.fetched,
              fields: { ...failure.fetched.fields, ...(decided as DiscoveryResponse["fields"]) },
              discovery_status: "partial",
            };
      // Nothing kept: the stored payload may still say 'running' from a checkpoint, and GET /projects/{id}/discovery reads that, so it is
      // settled to the same value as the column (AC13).
      await tx.query(
        `UPDATE projects SET discovery_status = 'partial',
                discovery = COALESCE($2::jsonb, CASE WHEN jsonb_typeof(discovery) = 'object' AND discovery ? 'discovery_status'
                                                     THEN jsonb_set(discovery, '{discovery_status}', '"partial"') ELSE discovery END),
                updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL AND discovery_status IN ('pending', 'running')`,
        [payload.data.projectId, kept === undefined ? null : JSON.stringify(kept)],
      );
      incrementCounter("nominara_discovery_completed_total", { status: "partial" });
      logger.warn(`workspace ${payload.data.workspaceId} project ${payload.data.projectId}: discovery gave up after ${failure.phase} failed; marked partial`);
      return true;
    },
  });
}

/**
 * STORY-195 AC6 - the review payload as it stands mid-pass: what the project held, with the fields found so far laid over it and the human-decided
 * ones laid over those. The status stays `running`; the commit phase writes the final payload and status. Guarded so a pass that lost a race
 * (a finished payload another delivery wrote, a deleted project) writes nothing. No `workspace_id` predicate: RLS scopes the transaction.
 */
async function writeCheckpoint(tx: ClientBase, prepared: Prepared, found: Readonly<Record<string, DiscoveredField>>): Promise<void> {
  // Re-read under FOR UPDATE: a confirm made since the last write is part of the row now, and must not be overwritten by a snapshot.
  const current = await readCurrent(tx, prepared.payload.projectId);
  const base = current === undefined ? prepared.stored : current.discovery;
  const stored = typeof base === "object" && base !== null && "fields" in base ? (base as DiscoveryResponse) : undefined;
  const decided = current === undefined ? prepared.preserved : userEditedEntries(base);
  const fields = { ...(stored?.fields ?? {}), ...found, ...(decided as DiscoveryResponse["fields"]) };
  const payload: DiscoveryResponse = {
    discovery_status: "running",
    duration_ms: stored?.duration_ms ?? null,
    fields,
    competitors_proposed: stored?.competitors_proposed ?? [],
    prompts_generated: stored?.prompts_generated ?? [],
    prompts_free_remaining: stored?.prompts_free_remaining ?? FREE_PROMPT_ALLOWANCE,
    credits_charged: 0,
    low_confidence_fields: Object.entries(fields)
      .filter(([, field]) => field.confidence < LOW_CONFIDENCE_THRESHOLD)
      .map(([name]) => name),
  };
  await tx.query(
    `UPDATE projects SET updated_at = now(), discovery = $2
      WHERE id = $1 AND deleted_at IS NULL AND discovery_status IN ('pending', 'running')`,
    [prepared.payload.projectId, JSON.stringify(payload)],
  );
}

/** The project's discovery payload and category as they are now, locked for the rest of the transaction. Undefined when the row is not visible. */
async function readCurrent(tx: ClientBase, projectId: string): Promise<{ discovery: unknown; categorySlug: string | null } | undefined> {
  const read = await tx.query<{ discovery: unknown; category_slug: string | null }>(
    "SELECT discovery, category_slug FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
    [projectId],
  );
  const row = read.rows[0];
  return row === undefined ? undefined : { discovery: row.discovery, categorySlug: row.category_slug ?? null };
}

/** The category is already decided: the caller supplied it at creation, or a person overrode it. Discovery neither derives nor re-proposes it. */
function categoryIsDecided(fieldsSupplied: readonly string[], humanDecided: readonly string[]): boolean {
  return fieldsSupplied.includes("category_slug") || fieldsSupplied.includes("category") || humanDecided.includes("category");
}

/** The discovered category's slug, only when it clears the confidence line. */
function confidentCategory(field: { value: unknown; confidence: number } | undefined): string | null {
  return field !== undefined && typeof field.value === "string" && field.confidence >= LOW_CONFIDENCE_THRESHOLD ? field.value : null;
}

/** BullMQ increments `attemptsMade` when an attempt fails, so during attempt N it is N-1. An unknown attempt count is "not known to be final". */
function isFinalAttempt(job: Pick<Job, "attemptsMade" | "opts">): boolean {
  const attempts = job.opts?.attempts;
  if (attempts === undefined) return false;
  return (job.attemptsMade ?? 0) + 1 >= attempts;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface StoredDiscovery {
  readonly fields?: Record<string, { user_edited?: boolean } | undefined>;
}

function storedDiscovery(value: unknown): StoredDiscovery | undefined {
  return typeof value === "object" && value !== null ? (value as StoredDiscovery) : undefined;
}

/** The field names a human has overridden, in the shape `discover` skips. */
function userEditedFields(stored: unknown): string[] {
  const fields = storedDiscovery(stored)?.fields ?? {};
  return Object.entries(fields)
    .filter(([, field]) => field?.user_edited === true)
    .map(([name]) => name);
}

/** Those same entries, to merge back over a fresh pass's result. */
function userEditedEntries(stored: unknown): Record<string, unknown> {
  const fields = storedDiscovery(stored)?.fields ?? {};
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => field?.user_edited === true));
}
