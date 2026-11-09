import { normalizeCitationUrl, UnparsableCitationError } from "../parser/citation-url.js";
import type { ReferrerClass } from "../../../contracts/attribution/index.js";

// STORY-113 - the only four things the beacon ever derives from a request: the landing URL, the referrer CLASS, a coarse country
// and a device category. Everything here is a pure function of its input; nothing reads or returns an address, an agent string or
// a visitor identifier, which is what lets the privacy test assert "no per-visitor data" about the whole ingest path.

/** AI engines by referrer host. A host matches itself and its subdomains, never a longer host that merely ends with it. */
const CLASS_HOSTS: Readonly<Record<Exclude<ReferrerClass, "other_ai" | "unattributed_direct">, readonly string[]>> = {
  chatgpt: ["chatgpt.com", "chat.openai.com"],
  perplexity: ["perplexity.ai"],
  gemini: ["gemini.google.com", "bard.google.com"],
  claude: ["claude.ai"],
  copilot: ["copilot.microsoft.com"],
  meta_ai: ["meta.ai"],
};

/**
 * AI hosts that have no class of their own. The list is deliberately coarse (the story: precision would need a host list nobody
 * can keep current); the `.ai` top-level domain below is what keeps a NEW engine from vanishing between releases.
 */
const OTHER_AI_HOSTS: readonly string[] = ["you.com", "phind.com", "poe.com", "grok.com", "x.ai", "deepseek.com", "chat.deepseek.com", "chat.mistral.ai", "kimi.com", "doubao.com"];

export type ClassifiedReferrer = ReferrerClass | "non_ai";

const matchesHost = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

function classifyHost(rawHost: string): ReferrerClass | undefined {
  const host = rawHost.toLowerCase().replace(/\.$/, "");
  for (const [klass, domains] of Object.entries(CLASS_HOSTS) as [keyof typeof CLASS_HOSTS, readonly string[]][]) {
    if (domains.some((domain) => matchesHost(host, domain))) return klass;
  }
  if (OTHER_AI_HOSTS.some((domain) => matchesHost(host, domain)) || host.endsWith(".ai")) return "other_ai";
  return undefined;
}

const siteHost = (host: string): string => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/**
 * The site's own navigation is never an AI referral. A referrer on the landing page's own host (ignoring case and `www.`) is an internal
 * click, and it must be decided BEFORE the host is classified: a customer whose domain is itself a `.ai` one would otherwise count every
 * internal page view as an `other_ai` session. It is also decided before `utm_source`, which a site's own links can carry along.
 */
export function isSameSite(referrer: string, landingUrl: string): boolean {
  return URL.canParse(referrer) && URL.canParse(landingUrl) && siteHost(new URL(referrer).hostname) === siteHost(new URL(landingUrl).hostname);
}

/**
 * Referrer host first; the landing URL's `utm_source` second (an engine that strips the referrer often still tags the link).
 * An empty or unparsable referrer is the unattributed class - stored and displayed, never dropped (NFR-ANL-09). A referrer that
 * names a non-AI site is `non_ai`: not an AI referral, so the caller stores nothing for it.
 */
export function classifyReferrer(referrer: string | undefined, landingUrl: string): ClassifiedReferrer {
  const trimmed = referrer?.trim() ?? "";
  if (trimmed !== "" && isSameSite(trimmed, landingUrl)) return "non_ai";
  if (trimmed !== "" && URL.canParse(trimmed)) {
    const fromReferrer = classifyHost(new URL(trimmed).hostname);
    if (fromReferrer !== undefined) return fromReferrer;
  }
  if (URL.canParse(landingUrl)) {
    const tagged = new URL(landingUrl).searchParams.get("utm_source");
    if (tagged !== null) {
      const fromTag = classifyHost(tagged);
      if (fromTag !== undefined) return fromTag;
    }
  }
  if (trimmed !== "" && URL.canParse(trimmed)) return "non_ai";
  return "unattributed_direct";
}

export class InvalidLandingUrlError extends Error {
  constructor() {
    super("landing_url must be an absolute http or https URL");
    this.name = "InvalidLandingUrlError";
  }
}

/**
 * The landing URL without its query and fragment. A query can carry anything a visitor was sent (a reset token, an address), the snippet
 * posts `location.href` whole, and the product's privacy posture is that nothing visitor-specific is stored. Applied to the stored URL at
 * ingest AND to every source's URL in the rollup's join (rollup-join.ts), so the join still meets on one key. A string that is not a URL is
 * returned as it came, for `normalizeLanding` to refuse.
 */
export function withoutQueryAndFragment(raw: string): string {
  if (!URL.canParse(raw)) return raw;
  const url = new URL(raw);
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The same normalisation and hash `citation_facts.url_hash` carries, so the two sides join exactly (STORY-114). */
export function normalizeLanding(raw: string): { readonly url: string; readonly hash: Buffer } {
  if (!URL.canParse(raw)) throw new InvalidLandingUrlError();
  const protocol = new URL(raw).protocol;
  if (protocol !== "http:" && protocol !== "https:") throw new InvalidLandingUrlError();
  try {
    const normalized = normalizeCitationUrl(raw);
    return { url: normalized.normalized, hash: normalized.urlHash };
  } catch (error) {
    if (error instanceof UnparsableCitationError) throw new InvalidLandingUrlError();
    throw error;
  }
}

export type DeviceCategory = "desktop" | "mobile" | "tablet";

/** `attribution_daily.device` is NOT NULL in the built schema (it is inside the primary key), so an unknown agent is `desktop`. */
export function deviceFromUserAgent(userAgent: string | undefined): DeviceCategory {
  const agent = userAgent ?? "";
  if (/iPad|Tablet/i.test(agent) || (/Android/i.test(agent) && !/Mobile/i.test(agent))) return "tablet";
  if (/Mobi|iPhone|Android/i.test(agent)) return "mobile";
  return "desktop";
}

/** `attribution_daily.country` is NOT NULL in the built schema (primary key), so an unknown country is ISO 3166's user-assigned `ZZ`. */
export const UNKNOWN_COUNTRY = "ZZ";

export function countryFromHeader(value: string | undefined): string {
  const code = value?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(code) || code === "XX") return UNKNOWN_COUNTRY;
  return code;
}
