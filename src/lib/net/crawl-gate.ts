import { SpanStatusCode, trace } from "@opentelemetry/api";
import { PolitenessBudget } from "../aux/politeness.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { MAX_REDIRECTS } from "./address-rules.js";
import { GuardedFetchRefusal, guardedFetch, type GuardedFetchInit, type GuardedResponse } from "./guarded-fetch.js";
import { CRAWL_AGENT, crawlDelayFor, isAllowed, parseRobots, type ParsedRobots } from "./robots.js";
import { NOMINARA_USER_AGENT } from "./user-agent.js";

// Owner decision 70(d): every outgoing fetch that identifies as NominaraBot checks the target host's robots.txt and keeps
// to a per-host request budget. The AUX site-audit crawl does this for itself (page-crawl.ts, politeness.ts); this is the
// one gate for the others (seeding verification, the corpus page fetcher), built from the SAME parser and the SAME budget.
//
// NETWORK I/O, SO NEVER INSIDE A DATABASE TRANSACTION. A caller reaches this from the `run` phase of a phased job (ADR-0003)
// or from a worker with no transaction open; the gate holds no connection and no tenant context of its own.
//
// FAIL CLOSED. A robots.txt that cannot be read (5xx, timeout, refusal) refuses the fetch (`robots_unavailable`), as RFC 9309
// and the AUX crawl do; a 4xx means "no rules". The failure is remembered for a short while so a down site is not hit again by
// every URL queued behind it.

/** NOT FROM THE REFERENCE: how long one host's robots.txt is trusted. RFC 9309 §2.4 says a cache should not exceed 24 h; an hour keeps a changed Disallow from outliving one batch of jobs. */
export const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000;
/** NOT FROM THE REFERENCE: how long "robots.txt could not be read" is remembered. */
export const ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000;
/** NOT FROM THE REFERENCE: hosts remembered at once (robots + budget); the oldest is dropped past it. Bounds memory under a stream of distinct hosts. */
export const MAX_TRACKED_HOSTS = 1000;

export type CrawlRefusalReason = "robots_disallowed" | "robots_unavailable";

/** The gate declined to send the request. Carries a reason code only: never the URL's query, never the robots body. */
export class CrawlRefusal extends Error {
  constructor(readonly reason: CrawlRefusalReason) {
    super(`crawl_gate: ${reason}`);
    this.name = "CrawlRefusal";
  }
}

export type FetchLike = (url: string, init?: GuardedFetchInit) => Promise<GuardedResponse>;

export interface CrawlGateOptions {
  /** The fetcher underneath (the SSRF-guarded one in production). Robots.txt is requested through it too. */
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly robotsTtlMs?: number;
  readonly failureTtlMs?: number;
}

interface HostState {
  readonly budget: PolitenessBudget;
  robots: { readonly value: ParsedRobots | null | "unavailable"; readonly expiresAt: number } | null;
  loading: Promise<ParsedRobots | null | "unavailable"> | null;
}

const tracer = trace.getTracer("nominara-api");

/**
 * Builds a fetch that checks robots.txt and the per-host budget before every request, and on every redirect hop (a hop
 * is a request to a host, which may be another host with other rules). State is per gate, so a process shares one by
 * using `crawlGatedFetch`.
 */
export function createCrawlGate(options: CrawlGateOptions = {}): FetchLike {
  const inner: FetchLike = options.fetch ?? ((url, init) => guardedFetch(url, init));
  const now = options.now ?? Date.now;
  const robotsTtl = options.robotsTtlMs ?? ROBOTS_CACHE_TTL_MS;
  const failureTtl = options.failureTtlMs ?? ROBOTS_FAILURE_TTL_MS;
  const hosts = new Map<string, HostState>();

  const stateFor = (host: string): HostState => {
    let state = hosts.get(host);
    if (state === undefined) {
      if (hosts.size >= MAX_TRACKED_HOSTS) {
        const oldest = hosts.keys().next().value;
        if (oldest !== undefined) hosts.delete(oldest);
      }
      // No hard cap: this budget is a rate, held for the life of the process. Integer, as the budget requires.
      state = { budget: new PolitenessBudget({ hardCap: Number.MAX_SAFE_INTEGER, now, ...(options.sleep === undefined ? {} : { sleep: options.sleep }) }), robots: null, loading: null };
      hosts.set(host, state);
    }
    return state;
  };

  async function loadRobots(origin: string, state: HostState): Promise<ParsedRobots | null | "unavailable"> {
    let value: ParsedRobots | null | "unavailable";
    try {
      await state.budget.acquire("site_file");
      const response = await inner(`${origin}/robots.txt`, { headers: { "user-agent": NOMINARA_USER_AGENT, accept: "text/plain,*/*;q=0.1" } });
      if (response.status >= 200 && response.status < 300) value = parseRobots(response.body.toString("utf8"));
      else if (response.status >= 400 && response.status < 500) value = null; // RFC 9309 §2.3.1.3: unavailable (4xx) = no rules
      else value = "unavailable";
    } catch {
      value = "unavailable";
    }
    if (value !== "unavailable" && value !== null) state.budget.setCrawlDelay(crawlDelayFor(value, CRAWL_AGENT));
    state.robots = { value, expiresAt: now() + (value === "unavailable" ? failureTtl : robotsTtl) };
    return value;
  }

  async function robotsFor(origin: string, state: HostState): Promise<ParsedRobots | null | "unavailable"> {
    if (state.robots !== null && state.robots.expiresAt > now()) {
      return state.robots.value;
    }
    // Concurrent first requests share one robots.txt fetch.
    state.loading ??= loadRobots(origin, state).finally(() => {
      state.loading = null;
    });
    return state.loading;
  }

  /** One request, gated. Returns the response as the inner fetch answered it (redirects are NOT followed here). */
  async function gateOne(url: URL, init: GuardedFetchInit): Promise<GuardedResponse> {
    const state = stateFor(url.host.toLowerCase());
    const isRobotsFile = url.pathname === "/robots.txt";
    if (!isRobotsFile) {
      const robots = await robotsFor(url.origin, state);
      if (robots === "unavailable") throw refuse("robots_unavailable");
      if (robots !== null && !isAllowed(robots, CRAWL_AGENT, `${url.pathname}${url.search}`)) throw refuse("robots_disallowed");
      await state.budget.acquire("page");
    } else {
      await state.budget.acquire("site_file");
    }
    return inner(url.href, { ...init, followRedirect: () => false });
  }

  return (rawUrl, init = {}) =>
    tracer.startActiveSpan("net.crawl_gate.fetch", async (span) => {
      try {
        let current: URL;
        try {
          current = new URL(rawUrl);
        } catch {
          // Not a URL: the guarded fetcher owns the verdict (scheme_not_allowed).
          return await inner(rawUrl, init);
        }
        const redirectChain: string[] = [];
        for (let hops = 0; ; hops += 1) {
          const response = await gateOne(current, init);
          const location = response.headers.location;
          const isRedirect = response.status >= 300 && response.status < 400 && typeof location === "string";
          if (!isRedirect) return { ...response, redirectChain };
          if (hops >= MAX_REDIRECTS) throw new GuardedFetchRefusal("too_many_redirects");
          const next = new URL(location, current);
          if (init.followRedirect !== undefined && !init.followRedirect(next.href)) return { ...response, redirectChain };
          redirectChain.push(current.href);
          current = next;
        }
      } catch (error) {
        if (error instanceof CrawlRefusal) {
          incrementCounter("nominara_net_crawl_gate_refusals_total", { reason: error.reason });
          span.setAttribute("nominara.net.crawl_gate_refusal", error.reason);
        } else span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });

  function refuse(reason: CrawlRefusalReason): CrawlRefusal {
    return new CrawlRefusal(reason);
  }
}

let shared: FetchLike | undefined;
/** The process-wide gated fetch: one robots cache and one set of per-host budgets for every NominaraBot fetch outside the AUX crawl. */
export const crawlGatedFetch: FetchLike = (url, init) => (shared ??= createCrawlGate())(url, init);
