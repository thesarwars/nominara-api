import { z } from "zod";
import { fold } from "../../parser/fold.js";
import type { EntityCheck, StoredEntityNode } from "../entity.js";
import type { JsonFetcher, JsonFetchResult } from "./json-fetcher.js";

// STORY-060 E1 (owner decision 99b) - the profile probe for TWO authoritative nodes, Wikidata and Wikipedia, and no other. Free (both are public
// APIs), behind a port (`WikiProfileProbe`), through the guarded JSON fetcher (SSRF guard + robots + per-host budget). The other five nodes stay "not
// checked", so the Entity Authority score stays withheld (it needs all seven).
//
// WHAT "PRESENT" MEANS. A Wikidata entity is the brand's profile only when it STATES the brand's website (P856) and that website is the project's
// domain: a name alone matches namesakes ("Notion" the concept) and would score false presence. A Wikipedia article is the brand's when the brand's
// Wikidata entity links to it, or, with no Wikidata match, when an English article that links to the brand's domain is titled by the brand's name.
// A candidate that names no website cannot be told from a namesake and is not the brand's profile.
//
// FAIL CLOSED. A node is reported ABSENT (a check with no url) only when every request it needed was answered and none matched. A refused, blocked,
// failed or malformed answer leaves the node UNCHECKED, so a blocked probe can never raise a "missing profile" alert.
//
// COMPLETENESS is the core fields the profile lacks (entity.ts: two or more missing = thin). Wikidata: description, instance_of, inception,
// headquarters_location. Wikipedia: lead_section (an introduction of at least 200 characters), official_website_link, wikidata_link. These field lists
// are BUILDER READINGS (the reference says "missing fields" without naming them).
//
// ONLY THE BRAND'S OWN VOCABULARY LEAVES: its name, aliases and domain. No workspace, project or user identifier is in any request.

export const WIKI_PROBE_MAX_TERMS = 3;
/** Search terms (<= 3), one entity fetch, one article query, one external-link search, one article query. */
export const WIKI_PROBE_MAX_REQUESTS = 8;
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const LEAD_SECTION_MIN_CHARS = 200;

export interface ProbeSubject {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly rootDomain: string;
}

export interface ProbeOutcome {
  /** Nodes whose check was ANSWERED: present (with a url) or affirmatively absent (url null). */
  readonly checks: EntityCheck[];
  /** Nodes that could not be checked this time, with a short reason code. They keep whatever they last recorded. */
  readonly unchecked: { readonly node: StoredEntityNode; readonly reason: string }[];
}

export interface WikiProfileProbe {
  probe(subject: ProbeSubject): Promise<ProbeOutcome>;
}

class Unanswered extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const searchSchema = z.object({ search: z.array(z.object({ id: z.string().regex(/^Q\d+$/u) })) });
const claimsSchema = z.record(z.string(), z.array(z.looseObject({ mainsnak: z.looseObject({ snaktype: z.string().optional(), datavalue: z.looseObject({ value: z.unknown() }).optional() }) })));
const entitiesSchema = z.object({
  entities: z.record(
    z.string(),
    z.looseObject({
      id: z.string().optional(),
      descriptions: z.record(z.string(), z.looseObject({ value: z.string() })).optional(),
      claims: claimsSchema.optional(),
      sitelinks: z.record(z.string(), z.looseObject({ title: z.string() })).optional(),
    }),
  ),
});
const articleSchema = z.object({
  query: z.object({
    pages: z.record(
      z.string(),
      z.looseObject({
        title: z.string().optional(),
        missing: z.unknown().optional(),
        extract: z.string().optional(),
        extlinks: z.array(z.looseObject({ "*": z.string().optional() })).optional(),
        pageprops: z.looseObject({ wikibase_item: z.string().optional() }).optional(),
      }),
    ),
  }),
});
const extUsageSchema = z.object({ query: z.object({ exturlusage: z.array(z.object({ title: z.string() })) }) });

const hostOf = (raw: string): string | null => {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return null;
  }
};
const onDomain = (url: string, rootDomain: string): boolean => {
  const host = hostOf(url);
  const root = rootDomain.toLowerCase().replace(/^www\./u, "");
  return host !== null && (host === root || host.endsWith(`.${root}`));
};
const api = (base: string, params: Record<string, string>): string => {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
};
const titleKey = (title: string): string => fold(title.replace(/\s*\([^)]*\)\s*$/u, "")).folded;

export function createWikiProfileProbe(fetchJson: JsonFetcher): WikiProfileProbe {
  async function get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const result: JsonFetchResult = await fetchJson(url);
    if (result.kind !== "json") throw new Unanswered(result.reason);
    const parsed = schema.safeParse(result.body);
    if (!parsed.success) throw new Unanswered("bad_response");
    return parsed.data;
  }

  async function wikidata(subject: ProbeSubject, terms: readonly string[]): Promise<{ check: EntityCheck; enwiki: string | null }> {
    const ids: string[] = [];
    for (const term of terms) {
      const found = await get(api(WIKIDATA_API, { action: "wbsearchentities", search: term, language: "en", type: "item", limit: "5", format: "json" }), searchSchema);
      for (const { id } of found.search) if (!ids.includes(id)) ids.push(id);
    }
    const absent = { check: { node: "wikidata" as const, url: null, missingFields: [] }, enwiki: null };
    if (ids.length === 0) return absent;
    const entities = await get(
      api(WIKIDATA_API, { action: "wbgetentities", ids: ids.slice(0, 10).join("|"), props: "claims|descriptions|sitelinks", languages: "en", sitefilter: "enwiki", format: "json" }),
      entitiesSchema,
    );
    for (const id of ids) {
      const entity = entities.entities[id];
      if (entity === undefined) continue;
      const claims = entity.claims ?? {};
      const websites = (claims.P856 ?? []).map((c) => c.mainsnak.datavalue?.value).filter((v): v is string => typeof v === "string");
      if (!websites.some((w) => onDomain(w, subject.rootDomain))) continue;
      const missingFields = [
        ...(entity.descriptions?.en?.value ? [] : ["description"]),
        ...((claims.P31?.length ?? 0) > 0 ? [] : ["instance_of"]),
        ...((claims.P571?.length ?? 0) > 0 ? [] : ["inception"]),
        ...((claims.P159?.length ?? 0) > 0 ? [] : ["headquarters_location"]),
      ];
      return { check: { node: "wikidata", url: `https://www.wikidata.org/wiki/${id}`, missingFields }, enwiki: entity.sitelinks?.enwiki?.title ?? null };
    }
    return absent;
  }

  async function wikipedia(subject: ProbeSubject, title: string): Promise<EntityCheck> {
    const article = await get(
      api(WIKIPEDIA_API, { action: "query", format: "json", redirects: "1", titles: title, prop: "extracts|extlinks|pageprops", exintro: "1", explaintext: "1", ellimit: "500", ppprop: "wikibase_item" }),
      articleSchema,
    );
    const page = Object.values(article.query.pages)[0];
    if (page === undefined) throw new Unanswered("bad_response");
    if (page.missing !== undefined) return { node: "wikipedia", url: null, missingFields: [] };
    const links = (page.extlinks ?? []).map((l) => l["*"]).filter((l): l is string => typeof l === "string");
    const missingFields = [
      ...((page.extract ?? "").length >= LEAD_SECTION_MIN_CHARS ? [] : ["lead_section"]),
      ...(links.some((l) => onDomain(l, subject.rootDomain)) ? [] : ["official_website_link"]),
      ...(page.pageprops?.wikibase_item === undefined ? ["wikidata_link"] : []),
    ];
    return { node: "wikipedia", url: `https://en.wikipedia.org/wiki/${(page.title ?? title).replace(/ /gu, "_")}`, missingFields };
  }

  async function wikipediaByDomain(subject: ProbeSubject, names: readonly string[]): Promise<EntityCheck> {
    const usage = await get(api(WIKIPEDIA_API, { action: "query", list: "exturlusage", euquery: subject.rootDomain, eunamespace: "0", eulimit: "20", format: "json" }), extUsageSchema);
    const wanted = new Set(names.map((n) => fold(n).folded));
    const hit = usage.query.exturlusage.find((u) => wanted.has(titleKey(u.title)));
    return hit === undefined ? { node: "wikipedia", url: null, missingFields: [] } : wikipedia(subject, hit.title);
  }

  return {
    async probe(subject) {
      const names = [...new Set([subject.name, ...subject.aliases].map((n) => n.trim()).filter((n) => n !== ""))];
      const terms: string[] = [];
      for (const name of names) if (!terms.some((t) => fold(t).folded === fold(name).folded)) terms.push(name);
      const searchTerms = terms.slice(0, WIKI_PROBE_MAX_TERMS);
      const checks: EntityCheck[] = [];
      const unchecked: ProbeOutcome["unchecked"][number][] = [];
      const reasonOf = (e: unknown): string => (e instanceof Unanswered ? e.reason : "probe_error");

      let enwiki: string | null | undefined; // undefined = Wikidata did not answer; null = answered, no English article
      try {
        const found = await wikidata(subject, searchTerms);
        checks.push(found.check);
        enwiki = found.check.url === null ? undefined : found.enwiki;
      } catch (error) {
        unchecked.push({ node: "wikidata", reason: reasonOf(error) });
      }
      const matched = checks.some((c) => c.node === "wikidata" && c.url !== null);

      try {
        // A matched Wikidata entity is trusted on its English sitelink (absent = no article); otherwise the article is found by the brand's domain.
        checks.push(matched ? (enwiki === null || enwiki === undefined ? { node: "wikipedia", url: null, missingFields: [] } : await wikipedia(subject, enwiki)) : await wikipediaByDomain(subject, names));
      } catch (error) {
        unchecked.push({ node: "wikipedia", reason: reasonOf(error) });
      }
      return { checks, unchecked };
    },
  };
}
