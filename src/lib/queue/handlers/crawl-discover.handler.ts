import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { Job } from "bullmq";
import { z } from "zod";
import { discover, type DiscoverDeps } from "../../discovery/discover.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

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

export function createCrawlDiscoverHandler(_context: QueueHandlerContext, deps?: DiscoverDeps): JobProcessor {
  const logger = new Logger("crawl.discover");

  return async (tx: ClientBase, job: Job): Promise<void> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);

    // The project's own root_domain, read back rather than carried on the job.
    // A job payload is a snapshot from enqueue time; the row is the truth, and
    // reading it also confirms the project still exists — it may have been
    // deleted between creation and this job being picked up.
    const project = await tx.query<{ root_domain: string; discovery: unknown }>(
      "SELECT root_domain, discovery FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [payload.projectId],
    );
    if (project.rows.length === 0) {
      // Deleted, or in another tenant and invisible to RLS. Either way there
      // is nothing to enrich and nothing wrong — returning is correct, and
      // throwing would send a job down the retry ladder for a project that no
      // longer exists.
      logger.log(`project ${payload.projectId} is gone; skipping discovery`);
      return;
    }

    await tx.query("UPDATE projects SET discovery_status = 'running' WHERE id = $1", [payload.projectId]);

    // `discover` does not throw for a site-side problem — it returns `partial`
    // or `failed` with whatever it obtained (AC13). A throw here would be OUR
    // bug, and should reach the retry ladder.
    // STORY-044 AC4/scenario 5 — a field a human overrode is NEVER overwritten
    // by a later pass. Folded into the same `fieldsSupplied` skip list that
    // makes "supplied wins" work, rather than added as a second mechanism:
    // both mean "a person decided this, do not derive it", and one code path
    // cannot drift out of step with itself. Without this a re-crawl silently
    // reverts the customer's correction and they have no way to tell.
    const humanDecided = userEditedFields(project.rows[0]!.discovery);
    const result = await discover(
      {
        rootUrl: payload.rootUrl,
        rootDomain: project.rows[0]!.root_domain,
        fieldsSupplied: [...payload.fieldsSupplied, ...humanDecided],
      },
      deps,
    );

    // The overridden entries are carried forward verbatim. `discover` skipped
    // them, so without this they would simply vanish from the payload — the
    // value would survive on the project column but the record that a human
    // set it would not, and the NEXT pass would happily re-derive it.
    const merged = { ...result, fields: { ...result.fields, ...preservedFields(project.rows[0]!.discovery) } };

    // The whole review payload into `discovery`, and only the STATUS onto its
    // own column. Nothing here writes name, description, category or aliases:
    // §4.5's "never silent" means a discovered value is applied by STORY-044's
    // confirm step, not by the pass that found it. There is deliberately no
    // code path from this handler to those columns.
    await tx.query("UPDATE projects SET discovery = $2, discovery_status = $3, updated_at = now() WHERE id = $1", [
      payload.projectId,
      JSON.stringify(merged),
      merged.discovery_status,
    ]);

    logger.log(
      `project ${payload.projectId}: ${merged.discovery_status} in ${String(merged.duration_ms ?? 0)}ms, ` +
        `${String(Object.keys(merged.fields).length)} field(s), ` +
        `${String(merged.low_confidence_fields.length)} low-confidence, ` +
        `${String(humanDecided.length)} preserved from a human decision`,
    );
  };
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
