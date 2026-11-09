import type { AttributionPattern } from "../../../contracts/attribution/index.js";
import { classifyUrl } from "./pattern-classifier.js";
import { joinUrlKey } from "./url-normalisation.js";

// STORY-114 J1-J5 - the join of one window's four sources, per URL, before it is written. Pure: no clock, no I/O, no model.
//
// EVERY SOURCE IS KEYED BY `joinUrlKey` ON ITS URL STRING - the one shared normalisation - so a trailing slash, a host in capitals, a
// default port or a tracking parameter on either side lands on the same row instead of splitting one page into several.
//
// NOTHING IS EXTRAPOLATED (NFR-ANL-09): every output count is a sum of measured integers, the prior window is carried beside the
// current one and never substituted for it, and the only derived figure is the conversion rate.
//
// `impressions` and `clicks` are `null` when Search Console is not connected: the output columns are then `null`, not 0.
// A CONNECTED source with no figure for a URL is a measured zero.

export interface CitationSource {
  readonly url: string;
  readonly current: number;
  readonly prior: number;
}
export interface SessionSource {
  readonly url: string;
  readonly sessions: number;
  readonly sessionsPrior: number;
  readonly conversions: number;
}
export interface SearchSource {
  readonly url: string;
  readonly value: number;
}
export interface JoinInput {
  readonly citations: readonly CitationSource[];
  readonly sessions: readonly SessionSource[];
  readonly impressions: readonly SearchSource[] | null;
  readonly clicks: readonly SearchSource[] | null;
}

export interface JoinedRow {
  readonly url: string;
  readonly urlHash: Buffer;
  readonly citations: number;
  readonly citationsPrior: number;
  readonly aiSessions: number;
  readonly aiSessionsPrior: number;
  readonly conversions: number;
  /** `conversions / aiSessions`; `null` when there were no sessions. */
  readonly cvr: number | null;
  readonly gscAiImpressions: number | null;
  readonly organicClicks: number | null;
  readonly pattern: AttributionPattern;
}

interface Acc {
  url: string;
  hash: Buffer;
  citations: number;
  citationsPrior: number;
  sessions: number;
  sessionsPrior: number;
  conversions: number;
  impressions: number;
  clicks: number;
}

export function joinWindow(input: JoinInput): JoinedRow[] {
  const byKey = new Map<string, Acc>();
  const slot = (raw: string): Acc | undefined => {
    const key = joinUrlKey(raw);
    if (key === null) return undefined;
    const id = key.hash.toString("hex");
    let acc = byKey.get(id);
    if (acc === undefined) {
      acc = { url: key.url, hash: key.hash, citations: 0, citationsPrior: 0, sessions: 0, sessionsPrior: 0, conversions: 0, impressions: 0, clicks: 0 };
      byKey.set(id, acc);
    }
    return acc;
  };

  for (const row of input.citations) {
    const acc = slot(row.url);
    if (acc === undefined) continue;
    acc.citations += row.current;
    acc.citationsPrior += row.prior;
  }
  for (const row of input.sessions) {
    const acc = slot(row.url);
    if (acc === undefined) continue;
    acc.sessions += row.sessions;
    acc.sessionsPrior += row.sessionsPrior;
    acc.conversions += row.conversions;
  }
  for (const row of input.impressions ?? []) {
    const acc = slot(row.url);
    if (acc !== undefined) acc.impressions += row.value;
  }
  for (const row of input.clicks ?? []) {
    const acc = slot(row.url);
    if (acc !== undefined) acc.clicks += row.value;
  }

  return [...byKey.values()]
    .map((acc): JoinedRow => {
      const organicClicks = input.clicks === null ? null : acc.clicks;
      return {
        url: acc.url,
        urlHash: acc.hash,
        citations: acc.citations,
        citationsPrior: acc.citationsPrior,
        aiSessions: acc.sessions,
        aiSessionsPrior: acc.sessionsPrior,
        conversions: acc.conversions,
        cvr: acc.sessions === 0 ? null : acc.conversions / acc.sessions,
        gscAiImpressions: input.impressions === null ? null : acc.impressions,
        organicClicks,
        pattern: classifyUrl({ citations: acc.citations, citationsPrior: acc.citationsPrior, aiSessions: acc.sessions, aiSessionsPrior: acc.sessionsPrior, organicClicks }),
      };
    })
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}
