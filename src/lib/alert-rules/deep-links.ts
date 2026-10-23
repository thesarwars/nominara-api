import type { NotificationDeepLink } from "../../../contracts/notifications/index.js";

// STORY-068 AC13 — every alert links to the surface that DIAGNOSES it, with its filters pre-applied, so one click lands
// on the answer rather than on a prompt to go hunting. Every query parameter below is one the client's section already
// reads from its URL (app-fnt-dev-main: `engines`/`tf` via useProjectFilters, PromptsSection's `presence`/`sentiment`/
// `stability`/`sort`, AuxSection's `finding`, CompetitorsSection's `displacement`, SourcesSection's `playbook`,
// GeoSection's `analysis`). A project is named by id; the client resolves an id or a slug.

export interface DeepLinkFacts {
  readonly projectId: string | null;
  readonly engine?: string;
  /** The window the alert compared over, for the timeframe filter. */
  readonly windowDays?: number;
  readonly findingId?: string;
  readonly displacementId?: string;
  readonly domain?: string;
}

/** The narrowest timeframe filter the client offers that covers the window. */
function timeframe(windowDays: number | undefined): string {
  if (windowDays === undefined || windowDays <= 7) return "7d";
  return windowDays <= 30 ? "30d" : "90d";
}

function compact(query: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export function alertDeepLink(code: string, facts: DeepLinkFacts): NotificationDeepLink {
  const project = (section: string, query: Record<string, string | undefined> = {}): NotificationDeepLink => {
    if (facts.projectId === null) throw new Error(`alert '${code}' needs a project to link to`);
    return { path: `/p/${facts.projectId}/${section}`, query: compact(query) };
  };
  const tf = timeframe(facts.windowDays);
  switch (code) {
    case "sov_drop_engine":
      return project("prompts", { engines: facts.engine, tf, sort: "worst" });
    case "presence_loss":
      return project("prompts", { engines: facts.engine, tf, presence: "absent" });
    case "negative_spike":
      return project("prompts", { engines: facts.engine, sentiment: "negative" });
    case "citation_loss":
      return project("sources", { engines: facts.engine, tf });
    case "sov_drop_global":
      return project("overview", { tf });
    case "competitor_overtake":
      return project("competitors", { tf });
    case "source_gap_critical":
      return project("sources", { playbook: facts.domain });
    case "aux_critical":
    case "rendering_downgrade":
      return project("aux", { finding: facts.findingId });
    case "stability_collapse":
      return project("prompts", { stability: "unstable" });
    case "displacement_detected":
      return project("competitors", { displacement: facts.displacementId });
    case "entity_node_missing":
      return project("geo", { analysis: "entity" });
    case "divergence_high":
      return project("geo", { analysis: "divergence" });
    case "topic_gap_high":
      return project("geo", { analysis: "topics" });
    case "quota_threshold":
      return { path: "/settings/plan", query: {} };
    default:
      throw new Error(`alert '${code}' has no diagnosing surface`);
  }
}

/** Where a credit-balance warning is acted on. */
export const CREDITS_DEEP_LINK: NotificationDeepLink = Object.freeze({ path: "/settings/billing", query: Object.freeze({}) }) as NotificationDeepLink;
