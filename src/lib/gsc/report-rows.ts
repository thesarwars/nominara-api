import { createHash } from "node:crypto";
import { joinUrlKey } from "../attribution/url-normalisation.js";
import { UNKNOWN_COUNTRY } from "../attribution/beacon-dimensions.js";
import type { GscReportRow } from "./port.js";

// STORY-115 S3 - one source row to one `gsc_daily` row, and the arithmetic that merges rows sharing a key.
//
// THE KEY. `gsc_daily`'s primary key has `page_url_hash`, `query_hash`, `country` and `device` in it, and Postgres forces every column
// of a primary key NOT NULL (the schema's recorded E-4 defect). So an absent dimension is the ZERO-LENGTH hash (`''::bytea`) and an
// unknown country is `ZZ`, exactly as the beacon's `attribution_daily` does it. A `page` row has no query; a `query` row has no page.
//
// THE PAGE HASH IS THE SHARED NORMALISED-URL HASH (`joinUrlKey`, the one `citation_facts.url_hash` carries), so the page join is exact.
// Two source URLs that normalise to one key (a trailing slash, a tracking parameter) collapse to one row whose figures are summed; a
// string that is not an absolute http(s) URL is dropped and counted, never joined wrongly.
//
// THE QUERY HASH is SHA-256 of the lower-cased, whitespace-collapsed query: the same query typed two ways is one row.

export const NO_HASH: Buffer = Buffer.alloc(0);

export interface DailyRow {
  readonly metricDate: string;
  readonly dimension: "page" | "query";
  readonly pageUrl: string | null;
  readonly pageUrlHash: Buffer;
  readonly queryText: string | null;
  readonly queryHash: Buffer;
  readonly country: string;
  readonly device: "desktop" | "mobile" | "tablet";
  readonly clicks: number;
  readonly impressions: number;
  readonly ctr: number;
  readonly avgPosition: number | null;
}

export function queryKey(query: string): { readonly text: string; readonly hash: Buffer } {
  const text = query.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return { text, hash: createHash("sha256").update(text, "utf8").digest() };
}

export interface RowsBuilt {
  readonly rows: DailyRow[];
  readonly dropped: number;
}

/** Merges rows that share a primary key: clicks and impressions add, position is impression-weighted, CTR is recomputed. */
export function toDailyRows(dimension: "page" | "query", source: readonly GscReportRow[]): RowsBuilt {
  const merged = new Map<string, { row: DailyRow; weighted: number; weight: number }>();
  let dropped = 0;
  for (const item of source) {
    let pageUrl: string | null = null;
    let pageHash: Buffer = NO_HASH;
    let queryText: string | null = null;
    let queryHash: Buffer = NO_HASH;
    if (dimension === "page") {
      const key = item.page === null ? null : joinUrlKey(item.page);
      if (key === null) {
        dropped += 1;
        continue;
      }
      pageUrl = key.url;
      pageHash = key.hash;
    } else {
      if (item.query === null || item.query.trim() === "") {
        dropped += 1;
        continue;
      }
      const key = queryKey(item.query);
      queryText = key.text;
      queryHash = key.hash;
    }
    const country = item.country === null || !/^[A-Za-z]{2}$/u.test(item.country) ? UNKNOWN_COUNTRY : item.country.toUpperCase();
    const mapKey = [item.date, dimension, pageHash.toString("hex"), queryHash.toString("hex"), country, item.device].join("|");
    const clicks = item.clicks ?? 0;
    const existing = merged.get(mapKey);
    if (existing === undefined) {
      merged.set(mapKey, {
        row: { metricDate: item.date, dimension, pageUrl, pageUrlHash: pageHash, queryText, queryHash, country, device: item.device, clicks, impressions: item.impressions, ctr: 0, avgPosition: null },
        weighted: item.position === null ? 0 : item.position * item.impressions,
        weight: item.position === null ? 0 : item.impressions,
      });
    } else {
      existing.row = { ...existing.row, clicks: existing.row.clicks + clicks, impressions: existing.row.impressions + item.impressions };
      if (item.position !== null) {
        existing.weighted += item.position * item.impressions;
        existing.weight += item.impressions;
      }
    }
  }
  const rows = [...merged.values()].map(({ row, weighted, weight }) => ({
    ...row,
    ctr: row.impressions === 0 ? 0 : row.clicks / row.impressions,
    avgPosition: weight === 0 ? null : weighted / weight,
  }));
  return { rows, dropped };
}
