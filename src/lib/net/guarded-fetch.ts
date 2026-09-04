import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  ALLOWED_PORTS,
  ALLOWED_SCHEMES,
  CONNECT_TIMEOUT_MS,
  isGloballyReachable,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  TOTAL_TIMEOUT_MS,
  type UnsafeTargetReason,
} from "./address-rules.js";

// STORY-131 — the single entry point every user-supplied URL passes through.
// security-and-tenancy.md §9's SSRF control, in one place, because three
// surfaces need it (project root URL, audit target, beacon origin) and three
// implementations would drift.
//
// WHY node:http/node:https AND NOT fetch(). The control is "DNS resolved
// BEFORE connect and re-checked after every redirect". Resolving and then
// handing the HOSTNAME to a client re-resolves it at connect time, and the
// second answer can differ from the one we validated — that is DNS rebinding,
// and it defeats the check entirely while looking correct in review. Closing it
// requires connecting to the exact address we validated, which needs a custom
// `lookup`. Node's global fetch is undici, and undici's Agent is not importable
// from a plain Node install (verified: `require("undici")` is MODULE_NOT_FOUND
// on v24.7.0), so there is no way to inject one without adding a dependency.
// node:https.request takes `lookup` directly. No new dependency, and the window
// is genuinely closed rather than nearly closed.
//
// Passing `lookup` keeps the hostname everywhere it matters — the TLS SNI and
// the Host header are still the name, so certificate validation is unchanged —
// while the socket goes to the address we already approved.

/** A refusal that maps to `422 unsafe_target`. Carries the reason, never the address. */
export class GuardedFetchRefusal extends Error {
  constructor(readonly reason: UnsafeTargetReason) {
    // The MESSAGE is part of the refusal's public surface. It names the check
    // and nothing else — no hostname, no resolved address. Scenario 13.
    super(`unsafe_target: ${reason}`);
    this.name = "GuardedFetchRefusal";
  }
}

export interface SafeTarget {
  readonly url: URL;
  /** Every address the host resolved to. All validated; the first is connected to. */
  readonly addresses: readonly string[];
}

export interface GuardedResponse {
  readonly status: number;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly body: Buffer;
  /** The URL actually fetched, after redirects. */
  readonly finalUrl: string;
}

/**
 * Validates a URL and resolves its host, without connecting.
 *
 * Callers that only need to know a URL is acceptable — project creation, which
 * stores the URL and hands the fetch to a queue handler — use this and never
 * open a socket on the request path (NFR-ARCH-01).
 */
export async function assertSafeUrl(
  rawUrl: string,
  resolve: (hostname: string) => Promise<string[]> = resolveAll,
): Promise<SafeTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GuardedFetchRefusal("scheme_not_allowed");
  }

  if (!ALLOWED_SCHEMES.includes(url.protocol)) throw new GuardedFetchRefusal("scheme_not_allowed");

  // An empty `url.port` means the scheme's default, which is always allowed
  // because both allowed schemes' defaults are in the allow-list.
  if (url.port !== "" && !ALLOWED_PORTS.includes(Number(url.port))) {
    throw new GuardedFetchRefusal("port_not_allowed");
  }

  if (url.hostname === "") throw new GuardedFetchRefusal("hostname_missing");

  // `resolve` is injectable so scenario 10 — a host answering with one public
  // and one private address — is testable. There is no reliable public host
  // with a mixed round-robin to point at, and the bypass it guards against is
  // real: without the loop below, retrying until the private address comes
  // back first is enough to reach it.
  const addresses = await resolve(url.hostname);

  // EVERY address, not the first. A round-robin that answers with one public
  // and one private address would otherwise be reachable by simply retrying
  // until the private one is returned first — the check would pass most times
  // and fail open exactly when it mattered.
  for (const address of addresses) {
    if (!isGloballyReachable(address)) throw new GuardedFetchRefusal("address_not_global");
  }

  return { url, addresses };
}

/** Resolves a hostname to every address it answers with, or a bare IP to itself. */
async function resolveAll(hostname: string): Promise<string[]> {
  // A bracketed IPv6 literal arrives from URL.hostname with its brackets still
  // on; dns.lookup would not resolve it and the check below would never run.
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  try {
    const results = await dnsLookup(bare, { all: true, verbatim: true });
    return results.map((entry) => entry.address);
  } catch {
    // An IP literal is not resolvable on some platforms; treat the literal as
    // its own answer so it still reaches the address check rather than
    // escaping as a resolution failure.
    if (/^[0-9a-f:.]+$/i.test(bare)) return [bare];
    throw new GuardedFetchRefusal("dns_resolution_failed");
  }
}

/**
 * The validator `guardedFetch` uses, injectable for ONE reason: without it the
 * redirect loop, the size cap and the timeouts are untestable.
 *
 * Every address a test server can bind is loopback on an ephemeral port, so
 * the real validator refuses it before a socket opens — which is correct, and
 * which also means scenarios 11, 12, 14 and 15 cannot be reached at all. The
 * alternative was to "prove" them by asserting a constant equals a constant,
 * which demonstrates nothing about whether a hostile server can make us follow
 * a redirect to loopback or buffer 6 MB.
 *
 * NOT exported from ./index.ts. Production callers get the two-argument form
 * and the strict default; a test reaches this by importing the module
 * directly. `defaultDepsAreStrict` below is asserted by a test so that the
 * default cannot be loosened without a test going red.
 */
export interface GuardedFetchDeps {
  readonly assertSafe: (rawUrl: string) => Promise<SafeTarget>;
}

const DEFAULT_DEPS: GuardedFetchDeps = { assertSafe: assertSafeUrl };

/** True when the built-in deps are the strict validator — asserted by test. */
export function defaultDepsAreStrict(): boolean {
  return DEFAULT_DEPS.assertSafe === assertSafeUrl;
}

/**
 * Fetches a user-supplied URL under every §9 control.
 *
 * Every hop is re-validated: a public URL that 302s to `169.254.169.254` is
 * refused at the hop, with `redirect_target_refused` rather than the initial
 * check's reason, so the log says which check actually fired.
 */
export async function guardedFetch(
  rawUrl: string,
  init: { readonly method?: string } = {},
  deps: GuardedFetchDeps = DEFAULT_DEPS,
): Promise<GuardedResponse> {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let target = await deps.assertSafe(rawUrl);
  let hops = 0;

  for (;;) {
    const response = await requestOnce(target, init.method ?? "GET", deadline);

    const location = response.headers.location;
    const isRedirect = response.status >= 300 && response.status < 400 && typeof location === "string";
    if (!isRedirect) return response;

    hops += 1;
    if (hops > MAX_REDIRECTS) throw new GuardedFetchRefusal("too_many_redirects");

    // Resolved against the CURRENT url, so a relative Location works and an
    // absolute one replaces it — matching how a browser would follow it, which
    // is the behaviour an attacker would be reasoning about.
    const next = new URL(location, target.url).toString();
    try {
      // The SAME validator as the initial URL — one policy for the whole call.
      // In production `deps` is DEFAULT_DEPS, so every hop goes through the
      // strict `assertSafeUrl`; the seam changes test behaviour only, and
      // `defaultDepsAreStrict` is asserted so it cannot quietly stop being
      // true. Using assertSafeUrl directly here was tried first and is wrong:
      // it makes a SAME-ORIGIN redirect unreachable for any caller whose
      // origin the validator permitted, which is a policy split between hop 0
      // and hop 1 that nothing in §9 asks for.
      target = await deps.assertSafe(next);
    } catch (error) {
      // Re-labelled so the reason names the redirect check. Without this a
      // 302 to loopback reports `address_not_global`, which reads as though
      // the ORIGINAL url was refused — and someone debugging looks at the
      // wrong URL.
      if (error instanceof GuardedFetchRefusal) throw new GuardedFetchRefusal("redirect_target_refused");
      throw error;
    }
  }
}

/** One hop: connect to an already-validated address, bounded in time and size. */
function requestOnce(target: SafeTarget, method: string, deadline: number): Promise<GuardedResponse> {
  return new Promise<GuardedResponse>((resolve, reject) => {
    const isHttps = target.url.protocol === "https:";
    const pinned = target.addresses[0]!;

    // The whole point of the file. `lookup` is called by the connector INSTEAD
    // of a real DNS query, and hands back the address assertSafeUrl already
    // approved — so there is no second resolution to disagree with the first.
    //
    // TWO CALLING CONVENTIONS, AND BOTH ARE REACHED. Node's `net` module has
    // `autoSelectFamily` on by default since v20, and that path calls lookup
    // with `{ all: true }` and expects an ARRAY of `{address, family}`; the
    // older path expects `(err, address, family)`. Answering only the second
    // hands the first `undefined` and fails every connection with
    // "Invalid IP address: undefined".
    //
    // This was live, and the unit tests could not have caught it: they connect
    // to `127.0.0.1`, and `net.connect` skips lookup ENTIRELY for a literal
    // address — so the function under test was never called. Found by fetching
    // a real hostname, which is what the regression test now does.
    const family = pinned.includes(":") ? 6 : 4;
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === "object" && options !== null && options.all === true) {
        (callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
          { address: pinned, family },
        ]);
        return;
      }
      (callback as (err: null, address: string, family: number) => void)(null, pinned, family);
    };

    const options: RequestOptions = {
      method,
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port !== "" ? target.url.port : isHttps ? 443 : 80,
      path: `${target.url.pathname}${target.url.search}`,
      lookup,
      // Redirects are followed by hand above so each hop is re-validated.
      headers: { host: target.url.host, "accept-encoding": "identity" },
    };

    const send = isHttps ? httpsRequest : httpRequest;
    const req = send(options);

    let settled = false;
    const fail = (reason: UnsafeTargetReason | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      req.destroy();
      reject(reason instanceof Error ? reason : new GuardedFetchRefusal(reason));
    };

    // ONE timer for the whole call, carried across redirects via `deadline` —
    // a per-hop timeout would let 3 redirects take 3x the documented total,
    // which is how a "20 second" bound becomes a minute.
    const totalTimer = setTimeout(() => fail(new Error("guarded-fetch: total timeout")), Math.max(0, deadline - Date.now()));

    req.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("guarded-fetch: connect timeout")));
    req.on("error", (error) => fail(error));

    req.on("response", (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let received = 0;

      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        // Checked AS IT STREAMS. Buffering the whole body and measuring after
        // means a hostile server can make us allocate whatever it likes before
        // we notice — the cap would bound what we KEEP, not what we accept.
        if (received > MAX_RESPONSE_BYTES) {
          fail(new Error("guarded-fetch: response exceeded the size cap"));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          finalUrl: target.url.toString(),
        });
      });

      res.on("error", (error) => fail(error));
    });

    req.end();
  });
}
