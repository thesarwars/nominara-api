import type { GrowthMapResponse } from "../../../contracts/analytics/index.js";
import {
  portalGrowthMapResponseSchema,
  portalMatrixResponseSchema,
  portalOverviewResponseSchema,
  portalTasksResponseSchema,
  type PortalGrowthMapResponse,
} from "../../../contracts/portal/index.js";
import type { ReportTimeframe } from "../../../contracts/reports/index.js";
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

// A cost-side field: a quota, a credit balance, a cost or price, a usage meter, or a capture/cell count. The
// methodology footer's `sample_size` and `live_capture_ratio` are NOT here: the footer is mandatory and unremovable
// (NFR-AGY-05), and they describe the statistical basis of a figure, not what it cost.
const COST_KEY = /(^|_)(quota|quotas|credit|credits|cost|costs|spend|price|prices|usage|cells|cells_total|captures_total|capture_count)($|_)/;

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
  overview: portalOverviewResponseSchema,
  growth_map: portalGrowthMapResponseSchema,
  matrix: portalMatrixResponseSchema,
  tasks: portalTasksResponseSchema,
} as const;

/**
 * The ALLOW-LIST. Every portal payload is parsed against its strict response schema before it is cached or served, so
 * a key no schema names (a new capture count, a usage meter, whatever the next change adds) throws a ZodError instead
 * of reaching a client. The key scan above is the denylist and only a second line: it can miss a name nobody listed.
 */
export function parsePortalPayload<T extends keyof typeof PORTAL_PAYLOAD_SCHEMAS>(tab: T, value: unknown): ReturnType<(typeof PORTAL_PAYLOAD_SCHEMAS)[T]["parse"]> {
  return PORTAL_PAYLOAD_SCHEMAS[tab].parse(value) as ReturnType<(typeof PORTAL_PAYLOAD_SCHEMAS)[T]["parse"]>;
}
