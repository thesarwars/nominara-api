import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { NotFoundError } from "../../../api/errors/domain-errors.js";
import { buildAuxDocument } from "../../aux/document-model.js";
import type { Tokenizer } from "../../aux/tokenizer.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import type { PageFetcher } from "../corpus/page-fetcher.js";
import { writeEntityNodes } from "../entity.js";
import { brandSameAsFrom } from "./same-as.js";
import type { ProbeOutcome, ProbeSubject, WikiProfileProbe } from "./wiki-probe.js";

// STORY-060 E1/E3 (owner decision 99b) - the three phases of the entity profile probe job (ADR-0003). The job handler (geo-analyze.handler.ts) wires
// them into the phased `geo.analyze` processor:
//
//   prepareProbe  one short tenant transaction: the project's brand vocabulary and domain, and whether the two probed nodes were checked recently.
//   runProbe      NO transaction, NO pooled client: Wikidata and Wikipedia through the guarded JSON fetcher, and the home page through the guarded page
//                 fetcher, both behind the crawl gate (robots + per-host budget).
//   commitProbe   one short tenant transaction: `writeEntityNodes` (the one write path into `entity_nodes`), which derives presence, completeness and
//                 link coverage against the brand's own `sameAs`.
//
// IDEMPOTENT under at-least-once delivery: a re-run overwrites the same two rows on their composite key, and prepare skips a project probed within
// `PROBE_MIN_INTERVAL_DAYS`. The Entity Authority analysis is recomputed by the next daily rollup (it reads `entity_nodes`); this job computes no score.

const logger = new Logger("geo.entity_probe");

/** NOT FROM THE REFERENCE: a project's two probed nodes are re-checked at most this often. Profiles change slowly; the target sites are free public APIs. */
export const PROBE_MIN_INTERVAL_DAYS = 7;

export interface ProbePrepared {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly subject: ProbeSubject;
  readonly homeUrl: string;
  /** URLs of profiles already recorded as linked from the brand's structured data: kept as linked when the home page cannot be read this time. */
  readonly priorLinkedUrls: readonly string[];
}

export interface ProbeResult extends ProbeOutcome {
  /** The `sameAs` links read off the home page; null when the home page could not be read (the links are then UNKNOWN, not empty). */
  readonly brandSameAs: readonly string[] | null;
  readonly homeReason: string | null;
}

export interface ProbeRunDeps {
  readonly probe: WikiProfileProbe;
  readonly fetchPage: PageFetcher;
  readonly tokenizer: Tokenizer;
}

/** Null when there is nothing to do: the project is gone, or both probed nodes were checked within the interval. */
export async function prepareProbe(tx: ClientBase, projectId: string, minIntervalDays: number = PROBE_MIN_INTERVAL_DAYS): Promise<ProbePrepared | null> {
  const project = await tx.query<{ workspace_id: string; name: string; brand_aliases: string[]; root_domain: string; root_url: string }>(
    "SELECT workspace_id, name, brand_aliases, root_domain, root_url FROM projects WHERE id = $1 AND deleted_at IS NULL",
    [projectId],
  );
  const p = project.rows[0];
  if (p === undefined) return null;
  const fresh = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM entity_nodes
      WHERE project_id = $1 AND node IN ('wikidata', 'wikipedia') AND last_checked_at > now() - make_interval(days => $2::int)`,
    [projectId, minIntervalDays],
  );
  if ((fresh.rows[0]?.n ?? 0) === 2) return null;
  const linked = await tx.query<{ url: string }>("SELECT url FROM entity_nodes WHERE project_id = $1 AND in_brand_sameas AND url IS NOT NULL", [projectId]);
  return { workspaceId: p.workspace_id, projectId, subject: { name: p.name, aliases: p.brand_aliases, rootDomain: p.root_domain }, homeUrl: p.root_url, priorLinkedUrls: linked.rows.map((r) => r.url) };
}

/** Holds NO transaction and NO client: it is handed what `prepareProbe` returned and the ports, and reads no tenant data. */
export async function runProbe(prepared: ProbePrepared, deps: ProbeRunDeps): Promise<ProbeResult> {
  const outcome = await deps.probe.probe(prepared.subject);
  const page = await deps.fetchPage(prepared.homeUrl);
  if (page.kind !== "html") return { ...outcome, brandSameAs: null, homeReason: `${page.kind}:${page.reason}` };
  // The STORY-050 document model, built from the fetched HTML (no rendered copy): its JSON-LD and microdata are what the brand says it is.
  const document = buildAuxDocument(
    { url: prepared.homeUrl, finalUrl: prepared.homeUrl, httpStatus: 200, redirectChain: [], headers: {}, rawHtml: page.html, renderedHtml: null, timing: { ttfbMs: null, loadMs: null } },
    deps.tokenizer,
  );
  return { ...outcome, brandSameAs: brandSameAsFrom(document.structured.jsonLd, document.structured.microdata), homeReason: null };
}

/** Records the answered checks. Returns how many nodes were written. A project deleted while the probe ran writes nothing. */
export async function commitProbe(tx: ClientBase, prepared: ProbePrepared, result: ProbeResult): Promise<number> {
  let written = 0;
  if (result.checks.length > 0) {
    try {
      // With the home page unreadable the brand's links are unknown: the links already recorded stand, and a profile is never newly called unlinked.
      written = (await writeEntityNodes(tx, prepared.projectId, result.checks, result.brandSameAs ?? prepared.priorLinkedUrls)).length;
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  for (const check of result.checks) incrementCounter("nominara_geo_entity_probe_checked_total", { node: check.node, present: String(check.url !== null) });
  for (const skipped of result.unchecked) incrementCounter("nominara_geo_entity_probe_unchecked_total", { node: skipped.node, reason: skipped.reason });
  // IDs, node names and counts only: never the brand's name, a profile URL or a page.
  logger.log({
    event: "geo.entity_probe.settled",
    workspace_id: prepared.workspaceId,
    project_id: prepared.projectId,
    checked: result.checks.length,
    unchecked: result.unchecked.length,
    written,
    same_as_known: result.brandSameAs !== null,
    same_as_count: result.brandSameAs?.length ?? null,
    home_reason: result.homeReason,
  });
  return written;
}
