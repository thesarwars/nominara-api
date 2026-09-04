import { LOW_CONFIDENCE_THRESHOLD, type DiscoveredField, type DiscoveryResponse } from "../../../contracts/projects/index.js";
import { guardedFetch } from "../net/guarded-fetch.js";
import { CONFIDENCE, extractFromHtml } from "./extract.js";
import { proposeNegativeAliases } from "./common-words.js";

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
}

export interface DiscoverDeps {
  readonly fetch: typeof guardedFetch;
  readonly now: () => number;
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
  let reachedSite = true;

  try {
    const response = await deps.fetch(input.rootUrl);
    if (response.status >= 400) {
      // Reached, and refused us. Whatever we can derive without the document
      // still stands, so this is not a clean completion.
      reachedSite = false;
    } else {
      const html = response.body.toString("utf8");
      const extracted = extractFromHtml(html);

      if (!skip.has("brand_name") && extracted.brandName) put(fields, "brand_name", extracted.brandName);
      if (!skip.has("description") && extracted.description) put(fields, "description", extracted.description);
      if (!skip.has("products") && extracted.products) put(fields, "products", extracted.products);
      if (!skip.has("locale") && extracted.locale) put(fields, "locale", extracted.locale);
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
    // NOT built, and deliberately empty rather than faked:
    //   competitors — needs the site's own comparison pages, i.e. multi-page
    //     selection, which is STORY-049.
    //   prompts — the free allowance comes from the archetype grammar, which
    //     is STORY-045 and is explicitly downstream of this story.
    // An invented competitor list is worse than none: §4.5 requires a BASIS
    // per competitor precisely because an unexplained list is not something a
    // customer can judge.
    competitors_proposed: [],
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

/** `hubspot.com` -> `HubSpot`-ish. The registrable domain's first label, capitalised. */
export function domainStem(rootDomain: string): string | undefined {
  const label = rootDomain.split(".")[0];
  if (label === undefined || label === "") return undefined;
  return label.charAt(0).toUpperCase() + label.slice(1);
}
