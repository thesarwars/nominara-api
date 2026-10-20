import { assertSafeUrl, GuardedFetchRefusal } from "../net/guarded-fetch.js";
import { toRegistrableDomain } from "../net/registrable-domain.js";

// STORY-049 AC6 / AC10 — the rendered fetch's port, and the request guard every renderer must install.
//
// THE PORT, NOT THE BROWSER. The reference names Playwright + Chromium for the rendered fetch ("networkidle + 2 s, JS
// enabled"). Playwright is a new dependency and a Chromium image, neither of which this change adds: that needs the owner's
// sign-off. What is here is everything that does not need a browser: the port the crawl calls, the typed "not available"
// answer, and the request guard, which is the part that carries the security requirement. An adapter that cannot be
// plugged in without passing every request through `createRenderRequestGuard` is the one this port is shaped to refuse.
//
// WHAT THE GUARD DOES, AND WHAT IT DOES NOT. Every request the page makes (script, image, XHR, WebSocket upgrade, a
// redirect) is checked by `assertSafeUrl` AND must stay on the target's registrable domain, so a hostile page cannot make
// the renderer fetch an internal address or beacon to a third party. It cannot pin the address the way `guardedFetch`
// does (Chromium resolves for itself), so a rebinding answer between check and connect is NOT closed by this layer: the
// no-identity, no-internal-route egress path (AC3, infrastructure) is the control that contains that, and it is why the two
// are specified as independent.

export interface RenderedPage {
  readonly html: string;
  readonly finalUrl: string;
  /** The navigation's HTTP status, null when the engine does not report one. */
  readonly status: number | null;
}

export type RequestDecision = { readonly allow: true } | { readonly allow: false; readonly reason: string };
export type RenderRequestGuard = (requestUrl: string) => Promise<RequestDecision>;

export interface Renderer {
  /**
   * False when this renderer cannot render at all (no browser is installed). The crawl then records `renderer_unavailable`
   * WITHOUT charging the politeness budget for a request that is never sent (an interval slot of up to the clamped
   * Crawl-delay, and a hard-cap unit). Absent means available.
   *
   * AN ADAPTER THAT DOES RENDER MUST CHARGE ITS SUBRESOURCES. `render` is one budget request, but a real browser makes up to
   * MAX_RENDER_REQUESTS (100) further requests to the same host for one page. The reference caps the host at 2 requests per
   * second, so each request the guard ALLOWS must also be charged to the crawl's `PolitenessBudget`; until an adapter does,
   * the per-host cap holds for the plain fetches only. The Playwright story inherits this as a requirement.
   */
  readonly available?: boolean;
  /** `guard` MUST be consulted for every request the page makes, including the navigation and every redirect. */
  render(url: string, guard: RenderRequestGuard): Promise<RenderedPage>;
}

/** The renderer is not installed here. Typed so a page records `renderer_unavailable`, not an empty "no JS content" result. */
export class RendererUnavailable extends Error {
  constructor() {
    super("renderer: no browser is available in this process");
    this.name = "RendererUnavailable";
  }
}

export const unavailableRenderer: Renderer = {
  available: false,
  render: () => Promise.reject(new RendererUnavailable()),
};

/** A page that loads more than this many resources is not being audited, it is being crawled. NOT FROM THE REFERENCE. */
export const MAX_RENDER_REQUESTS = 100;

export interface RenderGuardOptions {
  readonly assertSafe?: (url: string) => Promise<unknown>;
  readonly maxRequests?: number;
}

export function createRenderRequestGuard(targetUrl: string, options: RenderGuardOptions = {}): RenderRequestGuard {
  const assertSafe = options.assertSafe ?? ((url: string) => assertSafeUrl(url));
  const maxRequests = options.maxRequests ?? MAX_RENDER_REQUESTS;
  const target = new URL(targetUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("renderer: the target must be an http(s) URL");
  const targetDomain = toRegistrableDomain(targetUrl);
  let seen = 0;

  return async (requestUrl) => {
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      return { allow: false, reason: "invalid_url" };
    }
    // No network, no filesystem: an inline resource and the blank page are the only non-http(s) things a page may use.
    if (url.protocol === "data:" || requestUrl === "about:blank") return { allow: true };
    if (url.protocol !== "http:" && url.protocol !== "https:") return { allow: false, reason: "scheme_not_allowed" };

    seen += 1;
    if (seen > maxRequests) return { allow: false, reason: "request_cap" };

    let domain: string | null = null;
    try {
      domain = toRegistrableDomain(requestUrl);
    } catch {
      // an IP literal or an unlisted TLD is never the target's domain
    }
    if (domain !== targetDomain) return { allow: false, reason: "foreign_site" };

    try {
      await assertSafe(requestUrl);
    } catch (error) {
      return { allow: false, reason: error instanceof GuardedFetchRefusal ? error.reason : "unsafe_target" };
    }
    return { allow: true };
  };
}
