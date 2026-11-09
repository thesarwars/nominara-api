import type { GrowthMapResponse, SourceIndexResponse } from "../../../contracts/analytics/index.js";
import {
  portalGrowthMapResponseSchema,
  portalMatrixResponseSchema,
  portalOverviewCostsHiddenSchema,
  portalOverviewCostsVisibleSchema,
  portalSourcesCostsHiddenSchema,
  portalSourcesCostsVisibleSchema,
  portalTasksResponseSchema,
  type PortalGrowthMapResponse,
  type PortalSourcesResponse,
} from "../../../contracts/portal/index.js";
import type { MethodologyFooter, ReportTimeframe } from "../../../contracts/reports/index.js";
import { ProjectOutOfScopeError, ValidationFailedError } from "../../api/errors/domain-errors.js";

// NEW-E-099a — the pure rules of the portal read model: which timeframe a token may be served, which tab it may
// open, how competitors are hidden and which fields can never appear under hide_costs. No I/O, so each rule has a
// unit test and the service is only wiring.

/** What a token with no lock and no `?timeframe=` is served. The product's own default window. */
export const PORTAL_DEFAULT_TIMEFRAME: ReportTimeframe = "30d";

const DAYS: Readonly<Record<ReportTimeframe, number>> = Object.freeze({ "24h": 1, "7d": 7, "30d": 30, "90d": 90 });

export function portalTimeframeDays(timeframe: ReportTimeframe): number {
  return DAYS[timeframe];
}

/**
 * The timeframe a portal read is served for.
 *
 * A lock is a CEILING the request can never exceed: no request gets the lock, the lock itself gets the lock, a
 * NARROWER request is honoured (it exposes less than the lock allows), and a WIDER one is refused rather than
 * silently clamped — a client that asked for 90 days and was quietly served 7 would believe it had read 90.
 */
export function resolvePortalTimeframe(requested: ReportTimeframe | undefined, lock: ReportTimeframe | null): ReportTimeframe {
  if (lock === null) return requested ?? PORTAL_DEFAULT_TIMEFRAME;
  if (requested === undefined) return lock;
  if (DAYS[requested] > DAYS[lock]) {
    throw new ValidationFailedError({
      message: "this link is locked to a shorter timeframe",
      details: { issues: [{ path: ["timeframe"], message: "wider than this link's locked timeframe" }] },
    });
  }
  return requested;
}

/** A tab outside `scope_tabs` is out of scope exactly as a project outside `scope_project_ids` is. */
export function assertPortalTab(session: { readonly scopeTabs: readonly string[] }, tab: string): void {
  if (!session.scopeTabs.includes(tab)) throw new ProjectOutOfScopeError();
}

/** A, B, ... Z, then numbered: unique at any count, and never a letter reused for a second competitor. */
export function competitorLabel(index: number): string {
  return index < 26 ? `Competitor ${String.fromCharCode(65 + index)}` : `Competitor ${String(index + 1)}`;
}

/**
 * The agency growth-map payload as the portal serves it: the per-day capture count (`cells`) is removed from every
 * point, and under hide_competitors each competitor series is relabelled Competitor A/B/C in series order with an id
 * that no longer carries the competitor's. Everything else — nulls included — passes through untouched.
 */
export function toPortalGrowthMap(source: GrowthMapResponse, opts: { readonly hideCompetitors: boolean }): PortalGrowthMapResponse {
  let competitorIndex = 0;
  const series = source.series.map((entry) => {
    const points = entry.points.map(({ cells: _cells, ...rest }) => rest);
    if (!opts.hideCompetitors || entry.entity_type !== "competitor") return { ...entry, points };
    const label = competitorLabel(competitorIndex);
    competitorIndex += 1;
    return { ...entry, label, series_id: label.toLowerCase().replace(" ", "_"), points };
  });
  return { ...source, series };
}

/**
 * Decision 83 (c) — the agency source index as the portal serves it. `seedable` and the per-url `last_seen` are never served. Under
 * hide_costs the citations and prompts counts (and the per-url citation count) are ABSENT, not zero. Under hide_competitors a
 * competitor's OWN domain is dropped: the domain string is the competitor's name, so relabelling the name would still leave it on the
 * row. Every other row carries no competitor, so `competitors_present` is empty. Null (unverified presence, no severity, no coverage)
 * passes through as null, never 0 or false.
 */
export function toPortalSources(source: SourceIndexResponse, opts: { readonly hideCosts: boolean; readonly hideCompetitors: boolean }): PortalSourcesResponse {
  const domains = source.domains
    .filter((row) => !opts.hideCompetitors || row.competitors_present.length === 0)
    .map((row) => ({
      domain: row.domain,
      influence: row.influence,
      ...(opts.hideCosts ? {} : { citations: row.citations, prompts: row.prompts }),
      source_class: row.source_class,
      brand_present: row.brand_present,
      verified_at: row.verified_at,
      gap_severity: row.gap_severity,
      top_urls: row.top_urls.map((entry) => (opts.hideCosts ? { url: entry.url } : { url: entry.url, citations: entry.citations })),
      competitors_present: opts.hideCompetitors ? [] : row.competitors_present,
    }));
  return { window: source.window, source_coverage: source.source_coverage, domains };
}

// A cost-side field: a quota, a credit balance, a cost or price, a usage meter, or a capture/cell count. The
// methodology footer's `live_capture_ratio` is NOT here (a ratio, and the footer is mandatory and unremovable,
// NFR-AGY-05). `sample_size` IS: owner decision 2026-10-08, it is derived from the capture count, so under hide_costs it
// is dropped from the footer and this scan is the second line behind the allow-list.
const COST_KEY = /(^|_)(quota|quotas|credit|credits|cost|costs|spend|price|prices|usage|cells|cells_total|captures_total|capture_count|sample_size)($|_)/;

/** The footer as the portal serves it: `sample_size` is removed when costs are hidden, nothing else is touched. */
export function toPortalFooter(footer: MethodologyFooter, opts: { readonly hideCosts: boolean }): Omit<MethodologyFooter, "sample_size"> & { sample_size?: number } {
  if (!opts.hideCosts) return footer;
  const { sample_size: _dropped, ...rest } = footer;
  return rest;
}

/** Paths of every key in `value`, at any depth, that names a cost-side field. Empty means the payload is clean. */
export function findCostFields(value: unknown, path = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, i) => findCostFields(item, `${path}[${String(i)}]`));
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path === "" ? key : `${path}.${key}`;
    // The overview echoes the token's own policy flag, `hide_costs: boolean`, at the top level. That is a switch, not a
    // cost; the exemption is that exact key, at the top, holding a boolean, so a figure under the same name still trips.
    const isPolicyFlag = path === "" && key === "hide_costs" && typeof child === "boolean";
    return [...(COST_KEY.test(key) && !isPolicyFlag ? [here] : []), ...findCostFields(child, here)];
  });
}

const PORTAL_PAYLOAD_SCHEMAS = {
  overview: portalOverviewCostsVisibleSchema,
  growth_map: portalGrowthMapResponseSchema,
  matrix: portalMatrixResponseSchema,
  tasks: portalTasksResponseSchema,
  sources: portalSourcesCostsVisibleSchema,
} as const;

/**
 * The ALLOW-LIST. Every portal payload is parsed against its strict response schema before it is cached or served, so
 * a key no schema names (a new capture count, a usage meter, whatever the next change adds) throws a ZodError instead
 * of reaching a client. The key scan above is the denylist and only a second line: it can miss a name nobody listed.
 */
export function parsePortalPayload<T extends keyof typeof PORTAL_PAYLOAD_SCHEMAS>(tab: T, value: unknown, opts: { readonly hideCosts: boolean }): ReturnType<(typeof PORTAL_PAYLOAD_SCHEMAS)[T]["parse"]> {
  // `hideCosts` is required, not defaulted: a caller that forgets it does not compile rather than serving the wrong footer.
  const schema =
    opts.hideCosts && tab === "overview" ? portalOverviewCostsHiddenSchema : opts.hideCosts && tab === "sources" ? portalSourcesCostsHiddenSchema : PORTAL_PAYLOAD_SCHEMAS[tab];
  return schema.parse(value) as ReturnType<(typeof PORTAL_PAYLOAD_SCHEMAS)[T]["parse"]>;
}
