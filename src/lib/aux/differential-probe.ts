import type { PolitenessBudget } from "./politeness.js";

// STORY-049 AC8 — the differential probe: the INPUTS to AUX-R-005 ("bot-hostile edge rules"). One browser-UA request and
// one agent-UA request to the same URL; "an AI user agent receives 403/429/challenge from the CDN or WAF while a browser
// UA receives 200" is the single highest-value rule in the catalog.
//
// BOTH REQUESTS DRAW FROM THE SAME POLITENESS BUDGET as every other request (aux-and-geo-analysis.md §2: "Both probes
// count against the politeness budget"). The probe doubles request volume on the page it runs against; exempting it
// would breach politeness on exactly the sites most likely to be sensitive about crawling. The budget also spaces the
// two requests by its interval, so they are never a burst.
//
// This module only OBSERVES and CLASSIFIES. Turning "hostile" into a finding is the rule evaluator's job (STORY-051);
// a probe that failed to run is `inconclusive`, never a finding, because our request failing is not evidence about the site.

/** A current desktop browser. The reference names no strings; this is a plain, ordinary one. */
export const BROWSER_PROBE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
/**
 * An AI-agent-shaped string that identifies Nominara. AUX-R-005 says only "an AI user agent". It deliberately does NOT
 * copy a named company's crawler string (GPTBot et al.): impersonating another company's bot is a product and legal
 * call nobody has signed off, and a site that verifies that bot by IP range would see us as a fake. Trade-off: a WAF
 * rule written for a specific named bot will not match this string, so the probe sees "AI-agent-shaped" rules only.
 */
export const AGENT_PROBE_USER_AGENT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; NominaraAIProbe/1.0; +https://nominara.com/bot)";

export type ProbeOutcome = "consistent" | "hostile" | "inconclusive" | "skipped_budget";

export interface ProbeResult {
  readonly outcome: ProbeOutcome;
  /** null = no response (the request failed or was not sent). A real status is never coerced to 0. */
  readonly browserStatus: number | null;
  readonly agentStatus: number | null;
}

export interface ProbeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

export interface ProbeInput {
  readonly url: string;
  readonly budget: PolitenessBudget;
  /**
   * `followRedirect` is always `() => false`: the probe observes the response the TARGET gives at this URL, so a 3xx is
   * returned, not followed (see `send`).
   */
  readonly fetch: (
    url: string,
    init: { readonly headers: Record<string, string>; readonly followRedirect?: (nextUrl: string) => boolean },
  ) => Promise<ProbeResponse>;
}

const CHALLENGE_BODY = /<title>\s*just a moment|cf-chl-|attention required!\s*\|\s*cloudflare|captcha-delivery|px-captcha/i;

function isChallenge(r: ProbeResponse): boolean {
  const mitigated = r.headers["cf-mitigated"];
  if ((Array.isArray(mitigated) ? mitigated.join(",") : (mitigated ?? "")).toLowerCase().includes("challenge")) return true;
  return CHALLENGE_BODY.test(r.body.subarray(0, 65_536).toString("utf8"));
}

const refusedAgent = (r: ProbeResponse): boolean => r.status === 403 || r.status === 429 || isChallenge(r);
const okForBrowser = (r: ProbeResponse): boolean => r.status >= 200 && r.status < 300 && !isChallenge(r);

async function send(input: ProbeInput, userAgent: string): Promise<ProbeResponse | null> {
  await input.budget.acquire("probe");
  try {
    // NEVER FOLLOW A REDIRECT. The page fetch vets every hop so that no request reaches a third party; the probe must hold
    // to the same rule. Following a root redirect to another host would send the spoofed agent string to that host and
    // classify ITS response as the target's AUX-R-005 input. A 3xx therefore comes back as a 3xx, which neither half of the
    // verdict accepts (browser not 2xx, agent not 2xx and not refused): the probe is `inconclusive`.
    return await input.fetch(input.url, { headers: { "user-agent": userAgent }, followRedirect: () => false });
  } catch {
    return null;
  }
}

export async function runDifferentialProbe(input: ProbeInput): Promise<ProbeResult> {
  // A half probe proves nothing, so with fewer than two requests left NEITHER is sent.
  if (input.budget.remaining < 2) return { outcome: "skipped_budget", browserStatus: null, agentStatus: null };

  const browser = await send(input, BROWSER_PROBE_USER_AGENT);
  const agent = await send(input, AGENT_PROBE_USER_AGENT);
  const browserStatus = browser?.status ?? null;
  const agentStatus = agent?.status ?? null;

  if (browser === null || agent === null || !okForBrowser(browser)) return { outcome: "inconclusive", browserStatus, agentStatus };
  if (refusedAgent(agent)) return { outcome: "hostile", browserStatus, agentStatus };
  if (agent.status >= 200 && agent.status < 300) return { outcome: "consistent", browserStatus, agentStatus };
  return { outcome: "inconclusive", browserStatus, agentStatus };
}
