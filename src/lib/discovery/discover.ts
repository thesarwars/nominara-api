import {
  LOW_CONFIDENCE_THRESHOLD,
  type DiscoveredField,
  type DiscoveryResponse,
  type ProposedCompetitor,
} from "../../../contracts/projects/index.js";
import { guardedFetch } from "../net/guarded-fetch.js";
import { buildClassificationText, type CategoryClassification } from "../categories/classify.js";
import { CONFIDENCE, extractFromHtml, extractPageTitle } from "./extract.js";
import { proposeNegativeAliases } from "./common-words.js";
import { proposeCompetitors } from "./competitors.js";
import { extractHtmlSignals } from "./html-signals.js";

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
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("discovery: budget exceeded")), ms);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const DEFAULT_DISCOVER_DEPS: DiscoverDeps = { fetch: guardedFetch, now: () => Date.now() };

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

      // Hero copy only stands in where the page declared no description.
      let description = extracted.description;
      if (description === undefined && signals.heroCopy !== undefined) {
        const { headline, lede } = signals.heroCopy;
        const lead = /[.!?]$/.test(headline) ? headline : `${headline}.`;
        description = { value: lede === undefined ? headline : `${lead} ${lede}`, confidence: CONFIDENCE.heroCopy, source: "hero copy" };
      }
      if (!skip.has("description") && description) put(fields, "description", description);

      // Nav labels only where there is no Product schema.
      const products =
        extracted.products ??
        (signals.navProducts === undefined
          ? undefined
          : { value: signals.navProducts, confidence: CONFIDENCE.navStructure, source: "nav structure" });
      if (!skip.has("products") && products) put(fields, "products", products);
      if (!skip.has("locale") && extracted.locale) put(fields, "locale", extracted.locale);

      // STORY-189 AC3/AC4 — the category, from the text just read. Not derived at all when the caller supplied it or a person decided it
      // (supplied wins). A failed or empty classification proposes NOTHING: a missing category is honest, a guessed one corrupts the benchmark.
      if (!skip.has("category") && deps.classify !== undefined) {
        const siteText = buildClassificationText({
          title: extractPageTitle(html),
          description: description?.value,
          hero: signals.heroCopy === undefined ? undefined : [signals.heroCopy.headline, signals.heroCopy.lede].filter((p): p is string => p !== undefined).join(". "),
          nav: signals.navProducts,
          products: products?.value,
        });
        if (siteText !== "") {
          try {
            const remaining = Math.max(1, DISCOVERY_BUDGET_MS - (deps.now() - startedAt));
            const category = await withinBudget(deps.classify(siteText), remaining);
            if (category !== null) put(fields, "category", { value: category.slug, confidence: category.confidence, source: category.source });
          } catch {
            // The provider is down, slow or returned nonsense. Nothing proposed; the project is still usable and the customer can pick one.
          }
        }
      }

      // AC11 — read against every name the brand is known by, supplied or discovered, so a supplied name does not blind it.
      if (!skip.has("competitors")) {
        competitors = proposeCompetitors({
          brandNames: [
            ...(input.knownBrandNames ?? []),
            ...(extracted.brandName ? [extracted.brandName.value] : []),
            ...(signals.logoAlt ? [signals.logoAlt] : []),
            ...(domainStem(input.rootDomain) ? [domainStem(input.rootDomain)!] : []),
          ],
          links: signals.comparisonLinks,
        });
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
