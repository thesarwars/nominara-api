import {
  LOW_CONFIDENCE_THRESHOLD,
  type DiscoveredField,
  type DiscoveryResponse,
  type ProposedCompetitor,
} from "../../../contracts/projects/index.js";
import { GuardedFetchRefusal, guardedFetch } from "../net/guarded-fetch.js";
import { buildClassificationText, type CategoryClassification } from "../categories/classify.js";
import { CONFIDENCE, extractFromHtml, extractPageTitle } from "./extract.js";
import { proposeNegativeAliases } from "./common-words.js";
import { isSameSite, proposeCompetitors, selectComparisonPages } from "./competitors.js";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { incrementCounter } from "../telemetry/metrics.js";
import { extractHtmlSignals, type ComparisonLink } from "./html-signals.js";

// STORY-043 — the discovery pass. api-specification.md §4.5.
//
// TWO RULES SHAPE EVERY LINE BELOW.
//
//   "Supplied wins" (AC1) — a field the caller gave is never overwritten and
//   never re-proposed for review. Implemented by not DERIVING it at all,
//   rather than by deriving it and dropping the result: deriving and
//   discarding leaves the value one careless merge away from being applied,
//   and burns the work besides.
//
//   "Never silent" (AC13) — nothing discovered is applied without appearing
//   here with a confidence, and anything under 0.60 is listed as
//   low-confidence. This function therefore returns a REVIEW PAYLOAD. It
//   writes nothing to the project's own columns; STORY-044 owns confirm and
//   override. That split is why a low-confidence category cannot leak into
//   `projects.category_slug` by accident — there is no code path from here to
//   that column.

/** Every field name §4.5 can carry, so a caller's supplied set maps onto them. */
const FIELD_FOR_SUPPLIED: Record<string, string> = {
  name: "brand_name",
  description: "description",
  category_slug: "category",
  locale: "locale",
  brand_aliases: "aliases",
  negative_aliases: "negative_aliases",
};

/** STORY-190 - what happened to the comparison pages a pass tried to open. Counts only: never a URL, a name or page text. */
export interface ComparisonPageStats {
  readonly selected: number;
  readonly fetched: number;
  /** Links to another registrable domain: never followed. */
  readonly offSite: number;
  /** Answered, but the redirect went off the registrable domain (or was vetoed): the body is discarded. */
  readonly redirectedOff: number;
  readonly refused: number;
  readonly failed: number;
  readonly skippedBudget: number;
}

export interface DiscoverInput {
  readonly rootUrl: string;
  readonly rootDomain: string;
  /** Optional keys the caller supplied at creation — these are skipped entirely. */
  readonly fieldsSupplied: readonly string[];
  /** Names the project already goes by (its stored name and aliases), so "Acme vs X" is read correctly when the caller supplied the name. */
  readonly knownBrandNames?: readonly string[];
}

export interface DiscoverDeps {
  readonly fetch: typeof guardedFetch;
  readonly now: () => number;
  /**
   * STORY-189 — classifies the page text against the taxonomy (nearest-match embeddings). Absent means "no taxonomy to classify against":
   * discovery then proposes no category. It may throw (the provider is down); `discover` treats that as no category, not a failed pass.
   */
  readonly classify?: (siteText: string) => Promise<CategoryClassification | null>;
  /**
   * STORY-195 AC6 - called with a SNAPSHOT of the fields obtained so far, as each stage finishes (the document's fields, then the category),
   * so the project's discovery reads can show them before the pass ends. The caller owns where they go; it must not throw, and if it does
   * the pass carries on regardless: the final payload is what the handler commits, and this is progress only.
   */
  /** STORY-190 - told once, with counts, when comparison pages were considered. Must not throw; a throw is ignored. */
  readonly onComparisonPages?: (stats: ComparisonPageStats) => void;
  readonly onFields?: (fields: Readonly<Record<string, DiscoveredField>>) => Promise<void>;
}

/**
 * product-spec.md FR-ONB-02a / edge-cases-and-slos.md row 33 — "p50 <= 20 s, p95 <= 45 s".
 *
 * MEASURED, NOT ENFORCED. The objective is evidenced by `nominara_discovery_duration_seconds` (from submission, emitted by the
 * crawl.discover handler); no alert or recording rule judges it yet, so AC15 is not "met" until one does. An earlier in-process
 * `meetsLatencyObjective` helper had no production caller and was removed rather than left to imply enforcement.
 */
export const DISCOVERY_LATENCY_OBJECTIVE = { p50Ms: 20_000, p95Ms: 45_000 } as const;

/** A pass that outlives the upper-percentile objective is cut off and finishes as a partial project. */
export const DISCOVERY_BUDGET_MS = DISCOVERY_LATENCY_OBJECTIVE.p95Ms;

/**
 * Rejects after `ms`, clearing its timer when the race is settled either way. It does not abort `work`: the fetch behind it is
 * `guardedFetch`, which destroys its own request at TOTAL_TIMEOUT_MS (20 s, shorter than this budget), so an abandoned fetch is bounded.
 */
const BUDGET_EXCEEDED = "discovery: budget exceeded";

async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(BUDGET_EXCEEDED)), ms);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const DEFAULT_DISCOVER_DEPS: DiscoverDeps = { fetch: guardedFetch, now: () => Date.now() };

type PageSignals = ReturnType<typeof extractHtmlSignals>;
type Described = NonNullable<ReturnType<typeof extractFromHtml>["description"]>;

/** The description (hero copy only stands in where the page declared none) and the products (nav labels only where there is no Product schema). */
function describeAndList(extracted: ReturnType<typeof extractFromHtml>, signals: PageSignals) {
  let description: Described | undefined = extracted.description;
  if (description === undefined && signals.heroCopy !== undefined) {
    const { headline, lede } = signals.heroCopy;
    const lead = /[.!?]$/.test(headline) ? headline : `${headline}.`;
    description = { value: lede === undefined ? headline : `${lead} ${lede}`, confidence: CONFIDENCE.heroCopy, source: "hero copy" };
  }
  const products =
    extracted.products ??
    (signals.navProducts === undefined ? undefined : { value: signals.navProducts, confidence: CONFIDENCE.navStructure, source: "nav structure" });
  return { description, products };
}

function classificationText(html: string, description: string | undefined, products: readonly string[] | undefined, signals: PageSignals): string {
  return buildClassificationText({
    title: extractPageTitle(html),
    description,
    hero: signals.heroCopy === undefined ? undefined : [signals.heroCopy.headline, signals.heroCopy.lede].filter((p): p is string => p !== undefined).join(". "),
    nav: signals.navProducts,
    products,
  });
}

/**
 * STORY-195 / decision 88(b): the text `discover` classifies for a page, for any other reader of the same nearest match (the pre-creation fingerprint),
 * so the two can never read a page differently. Empty when the page gives nothing to classify.
 */
export function classificationTextFromHtml(html: string): string {
  const extracted = extractFromHtml(html);
  const signals = extractHtmlSignals(html);
  const { description, products } = describeAndList(extracted, signals);
  return classificationText(html, description?.value, products?.value, signals);
}

/**
 * Runs one discovery pass and returns the review payload.
 *
 * NEVER THROWS for a site-side problem. AC13: "a discovery timeout or failure
 * still leaves a usable project, marked partial, with whatever it obtained."
 * The project already exists and is already renderable — turning an
 * unreachable site into a thrown job would send it down the retry ladder and
 * eventually into the dead-letter queue, which reads to an operator as our
 * fault rather than as a site that was down.
 */
export async function discover(input: DiscoverInput, deps: DiscoverDeps = DEFAULT_DISCOVER_DEPS): Promise<DiscoveryResponse> {
  const startedAt = deps.now();
  const skip = new Set(input.fieldsSupplied.map((key) => FIELD_FOR_SUPPLIED[key] ?? key));

  const fields: Record<string, DiscoveredField> = {};
  let competitors: ProposedCompetitor[] = [];
  let reachedSite = true;

  const report = async (): Promise<void> => {
    if (deps.onFields === undefined || Object.keys(fields).length === 0) return;
    try {
      await deps.onFields({ ...fields });
    } catch {
      // Progress reporting only: a failure to show a field early must not fail, or change, the pass.
    }
  };

  try {
    const response = await withinBudget(deps.fetch(input.rootUrl), DISCOVERY_BUDGET_MS);
    if (response.status >= 400) {
      // Reached, and refused us. Whatever we can derive without the document
      // still stands, so this is not a clean completion.
      reachedSite = false;
    } else {
      const html = response.body.toString("utf8");
      const extracted = extractFromHtml(html);
      const signals = extractHtmlSignals(html);

      // The name, with the logo's alt text as a second reading: agreement lifts a title-derived name over the line, disagreement
      // changes nothing (the stronger source stands), and a logo alone is a low-confidence guess.
      let brandName = extracted.brandName;
      if (signals.logoAlt !== undefined) {
        if (brandName === undefined) {
          brandName = { value: signals.logoAlt, confidence: CONFIDENCE.logoAlt, source: "logo alt text" };
        } else if (sameName(brandName.value, signals.logoAlt) && brandName.confidence < CONFIDENCE.corroborated) {
          brandName = { value: brandName.value, confidence: CONFIDENCE.corroborated, source: `${brandName.source} + logo alt text` };
        }
      }
      if (!skip.has("brand_name") && brandName) put(fields, "brand_name", brandName);

      const { description, products } = describeAndList(extracted, signals);
      if (!skip.has("description") && description) put(fields, "description", description);

      if (!skip.has("products") && products) put(fields, "products", products);
      if (!skip.has("locale") && extracted.locale) put(fields, "locale", extracted.locale);
      // AC6 - the document's fields are known now; the category classification below is a provider call and can take seconds.
      await report();

      // STORY-189 AC3/AC4 — the category, from the text just read. Not derived at all when the caller supplied it or a person decided it
      // (supplied wins). A failed or empty classification proposes NOTHING: a missing category is honest, a guessed one corrupts the benchmark.
      if (!skip.has("category") && deps.classify !== undefined) {
        const siteText = classificationText(html, description?.value, products?.value, signals);
        if (siteText !== "") {
          try {
            const remaining = Math.max(1, DISCOVERY_BUDGET_MS - (deps.now() - startedAt));
            const category = await withinBudget(deps.classify(siteText), remaining);
            if (category !== null) {
              put(fields, "category", { value: category.slug, confidence: category.confidence, source: category.source });
              await report();
            }
          } catch {
            // The provider is down, slow or returned nonsense. Nothing proposed; the project is still usable and the customer can pick one.
          }
        }
      }

      // AC11 — read against every name the brand is known by, supplied or discovered, so a supplied name does not blind it.
      if (!skip.has("competitors")) {
        const brandNames = [
          ...(input.knownBrandNames ?? []),
          ...(extracted.brandName ? [extracted.brandName.value] : []),
          ...(signals.logoAlt ? [signals.logoAlt] : []),
          ...(domainStem(input.rootDomain) ? [domainStem(input.rootDomain)!] : []),
        ];
        // STORY-190 - up to 3 same-site comparison pages, in this run phase (no transaction held), inside what is left of the budget.
        const pages = await fetchComparisonPages(signals.comparisonLinks, input, deps, DISCOVERY_BUDGET_MS - (deps.now() - startedAt));
        competitors = proposeCompetitors({ brandNames, links: signals.comparisonLinks, pages });
      }
    }
  } catch {
    // Timeout, size cap, connection failure, or a guard refusal — the URL
    // passed the guard at creation, so a refusal here means a redirect went
    // somewhere it should not, or DNS moved under us. All of them mean the
    // same thing to the customer: we did not read the page.
    reachedSite = false;
  }

  // Aliases are derived from the DOMAIN, so they survive a failed fetch — part
  // of what "partial, with whatever it obtained" means in practice.
  if (!skip.has("aliases")) {
    const stem = domainStem(input.rootDomain);
    if (stem) {
      put(fields, "aliases", { value: [stem], confidence: CONFIDENCE.derived, source: "domain stem" });
    }
  }

  // AC16 — proposed off whichever brand name we ended with, discovered or
  // derived. Proposed, never applied: a wrong negative alias suppresses real
  // mentions, which is the one discovery error that destroys data rather than
  // just being wrong.
  if (!skip.has("negative_aliases")) {
    const brand = typeof fields.brand_name?.value === "string" ? fields.brand_name.value : domainStem(input.rootDomain);
    const negatives = proposeNegativeAliases(brand ?? "");
    if (negatives.length > 0) {
      put(fields, "negative_aliases", {
        value: negatives,
        confidence: CONFIDENCE.derived,
        source: "common-word dictionary",
      });
    }
  }

  // AC13 — "a timeout or failure still leaves a usable project, marked
  // partial, with whatever it obtained". `partial` when we obtained SOMETHING
  // despite not reading the page; `failed` only when we ended with nothing at
  // all, because calling an empty result partial overstates it and a customer
  // reading "partial" would sit waiting for fields that are never coming.
  const status: DiscoveryResponse["discovery_status"] = reachedSite
    ? "completed"
    : Object.keys(fields).length > 0
      ? "partial"
      : "failed";

  return {
    discovery_status: status,
    duration_ms: deps.now() - startedAt,
    fields,
    // Only as far as the root document shows (competitors.ts says why). Empty, never invented, when the page names none.
    competitors_proposed: competitors,
    // Generated and persisted by the handler's commit phase (free-prompts.ts) — this pass is pure and writes nothing.
    prompts_generated: [],
    prompts_free_remaining: FREE_PROMPT_ALLOWANCE,
    // AC12 — discovery charges nothing. A literal, so a future edit that
    // introduced a charge would have to change the contract to compile.
    credits_charged: 0,
    low_confidence_fields: Object.entries(fields)
      .filter(([, field]) => field.confidence < LOW_CONFIDENCE_THRESHOLD)
      .map(([name]) => name),
  };
}

/**
 * STORY-190 - opens the comparison pages the home page links to, through the guarded fetcher (`deps.fetch`), at most 3, same registrable
 * domain only. Concurrent, all inside ONE shared budget: a page that does not answer in what is left is skipped, and nothing here throws.
 * No transaction is open (the caller is the run phase); public pages only (a plain GET, no credentials, no forms); counts and ids only.
 */
async function fetchComparisonPages(
  links: readonly ComparisonLink[],
  input: DiscoverInput,
  deps: DiscoverDeps,
  budgetMs: number,
): Promise<{ url: string; html: string }[]> {
  const selection = selectComparisonPages(links, input.rootUrl, input.rootDomain);
  if (selection.urls.length === 0 && selection.offSite === 0) return [];
  return trace.getTracer("nominara.discovery").startActiveSpan("discovery.comparison_pages", async (span) => {
    const stats = { fetched: 0, redirectedOff: 0, refused: 0, failed: 0, skippedBudget: 0 };
    const pages: { url: string; html: string }[] = [];
    try {
      if (budgetMs <= 0) {
        stats.skippedBudget = selection.urls.length;
      } else {
        await Promise.all(
          selection.urls.map(async (url) => {
            try {
              const response = await withinBudget(
                deps.fetch(url, { truncateAtCap: true, followRedirect: (next) => isSameSite(next, input.rootUrl, input.rootDomain) }),
                budgetMs,
              );
              if (response.status >= 300 && response.status < 400) {
                stats.redirectedOff += 1; // a redirect the same-site veto stopped
              } else if (!isSameSite(response.finalUrl, input.rootUrl, input.rootDomain)) {
                stats.redirectedOff += 1;
              } else if (response.status >= 400 || !looksLikeHtml(response.headers["content-type"])) {
                stats.failed += 1; // a login wall, an error, or not a page
              } else {
                stats.fetched += 1;
                pages.push({ url: response.finalUrl, html: response.body.toString("utf8") });
              }
            } catch (error) {
              if (error instanceof GuardedFetchRefusal) stats.refused += 1;
              else if (error instanceof Error && error.message === BUDGET_EXCEEDED) stats.skippedBudget += 1;
              else stats.failed += 1;
            }
          }),
        );
      }
    } catch {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      span.setAttribute("nominara.discovery.comparison_pages_selected", selection.urls.length);
      span.setAttribute("nominara.discovery.comparison_pages_fetched", stats.fetched);
      span.end();
    }
    for (const [outcome, count] of Object.entries({ fetched: stats.fetched, off_site: selection.offSite, redirected_off: stats.redirectedOff, refused: stats.refused, failed: stats.failed, skipped_budget: stats.skippedBudget })) {
      for (let i = 0; i < count; i++) incrementCounter("nominara_discovery_comparison_pages_total", { outcome });
    }
    try {
      deps.onComparisonPages?.({ selected: selection.urls.length, offSite: selection.offSite, ...stats });
    } catch {
      // Reporting only.
    }
    return pages;
  });
}

function looksLikeHtml(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return value === undefined || /html|xml/i.test(value);
}

/** product-spec.md FR-ONB-02c — "the first 10 prompts are free". */
export const FREE_PROMPT_ALLOWANCE = 10;

function put(fields: Record<string, DiscoveredField>, name: string, field: { value: unknown; confidence: number; source: string }): void {
  fields[name] = { value: field.value, confidence: field.confidence, source: field.source, user_edited: false };
}

function sameName(a: string, b: string): boolean {
  const n = (x: string): string => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return n(a) !== "" && n(a) === n(b);
}

/** `hubspot.com` -> `HubSpot`-ish. The registrable domain's first label, capitalised. */
export function domainStem(rootDomain: string): string | undefined {
  const label = rootDomain.split(".")[0];
  if (label === undefined || label === "") return undefined;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
