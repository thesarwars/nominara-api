import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { Job } from "bullmq";
import { z } from "zod";
import type { DiscoveryResponse } from "../../../../contracts/projects/index.js";
import { discover, FREE_PROMPT_ALLOWANCE, type DiscoverDeps } from "../../discovery/discover.js";
import { generateFreeAllowance } from "../../discovery/free-prompts.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";

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
  readonly knownBrandNames: readonly string[];
  /** Field names a person decided: skipped by `discover`, then carried forward verbatim. */
  readonly humanDecided: readonly string[];
  readonly preserved: Record<string, unknown>;
}

// ADR-0003 / NFR-ARCH-04 — a PHASED job. The middle of this handler is a fetch of a site we do not control, so it must not hold a
// tenant transaction (or the pooled connection under it) across that await.
//   prepare  short tenant transaction: confirm the project, mark it running (committed BEFORE the fetch, so a poll mid-flight says so).
//   run      NO transaction: the guarded fetch and the pure parsing.
//   commit   short tenant transaction: the free allowance and the review payload, written together.
export function createCrawlDiscoverHandler(_context: QueueHandlerContext, deps?: DiscoverDeps): JobProcessor {
  const logger = new Logger("crawl.discover");

  return phasedProcessor<Prepared, DiscoveryResponse>({
    async prepare(tx: ClientBase, job: Job) {
      const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);

      // The project's own root_domain, read back rather than carried on the job.
      // A job payload is a snapshot from enqueue time; the row is the truth, and
      // reading it also confirms the project still exists — it may have been
      // deleted between creation and this job being picked up.
      const project = await tx.query<{ root_domain: string; discovery: unknown; name?: string | null; brand_aliases?: string[] | null }>(
        "SELECT root_domain, discovery, name, brand_aliases FROM projects WHERE id = $1 AND deleted_at IS NULL",
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
      return {
        payload,
        rootDomain: row.root_domain,
        knownBrandNames: [...(row.name ? [row.name] : []), ...(row.brand_aliases ?? [])],
        humanDecided: userEditedFields(row.discovery),
        preserved: preservedFields(row.discovery),
      };
    },

    // `discover` does not throw for a site-side problem — it returns `partial` or `failed` with whatever it obtained (AC13). A
    // throw here would be OUR bug, and should reach the retry ladder.
    run: (prepared) =>
      discover(
        {
          rootUrl: prepared.payload.rootUrl,
          rootDomain: prepared.rootDomain,
          fieldsSupplied: [...prepared.payload.fieldsSupplied, ...prepared.humanDecided],
          knownBrandNames: prepared.knownBrandNames,
        },
        deps,
      ),

    async commit(tx: ClientBase, prepared: Prepared, result: DiscoveryResponse) {
      const { payload } = prepared;

      // AC12 (first half) — the free allowance, generated and charged nothing. A caller who supplied prompts at creation has
      // already chosen them: supplied wins, so nothing is generated and the allowance is untouched.
      const generated = payload.fieldsSupplied.includes("prompts")
        ? []
        : await generateFreeAllowance(tx, { workspaceId: payload.workspaceId, projectId: payload.projectId, allowance: FREE_PROMPT_ALLOWANCE });

      // The overridden entries are carried forward verbatim: `discover` skipped them, so without this they would vanish from the
      // payload and the NEXT pass would re-derive them.
      const merged: DiscoveryResponse = {
        ...result,
        fields: { ...result.fields, ...(prepared.preserved as DiscoveryResponse["fields"]) },
        prompts_generated: generated,
        prompts_free_remaining: FREE_PROMPT_ALLOWANCE - generated.length,
      };

      // The whole review payload into `discovery`, and only the STATUS onto its own column. Nothing here writes name, description,
      // category or aliases: a discovered value is applied by STORY-044's confirm step, not by the pass that found it.
      await tx.query("UPDATE projects SET discovery = $2, discovery_status = $3, updated_at = now() WHERE id = $1", [
        payload.projectId,
        JSON.stringify(merged),
        merged.discovery_status,
      ]);

      // AC15 — the duration, so the p50/p95 objective can be read off a real distribution (meetsLatencyObjective judges it).
      observeValue("nominara_discovery_duration_ms", merged.duration_ms ?? 0, { status: merged.discovery_status });
      incrementCounter("nominara_discovery_completed_total", { status: merged.discovery_status });

      // Counts and IDs only: never the brand, a competitor or prompt text, none of which belongs in a log line.
      logger.log(
        `workspace ${payload.workspaceId} project ${payload.projectId}: ${merged.discovery_status} in ${String(merged.duration_ms ?? 0)}ms, ` +
          `${String(Object.keys(merged.fields).length)} field(s), ${String(merged.low_confidence_fields.length)} low-confidence, ` +
          `${String(merged.competitors_proposed.length)} competitor(s), ${String(generated.length)} prompt(s) generated, ` +
          `${String(prepared.humanDecided.length)} preserved from a human decision`,
      );
    },
  });
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
function preservedFields(stored: unknown): Record<string, unknown> {
  const fields = storedDiscovery(stored)?.fields ?? {};
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => field?.user_edited === true));
}
