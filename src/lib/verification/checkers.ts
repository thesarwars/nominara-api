import { Resolver } from "node:dns/promises";
import { guardedFetch, GuardedFetchRefusal } from "../net/guarded-fetch.js";
import {
  dnsRecordName,
  wellKnownPath,
  type VerificationFailure,
  type VerificationMethod,
} from "../../../contracts/projects/index.js";

// STORY-048 — the three proofs of control, each isolated and each returning a
// specific reason on failure (AC9).
//
// AC4 IS THE SECURITY REQUIREMENT: "DNS resolution goes through a trusted
// resolver path, and the file and tag checks go through the guarded fetcher,
// so verification itself cannot be turned into a request-forgery vector."
// A verification target is a user-supplied URL like any other — without the
// guarded fetcher, "verify this domain" is a free SSRF primitive: point it at
// an internal address and read the failure reason to learn what is there.

export const TXT_PREFIX = "nominara-verify=";
export const META_TAG_NAME = "nominara-verify";

/**
 * `inconclusive` marks a failure on OUR side of the wire (resolver outage, network error, timeout, 5xx/429), as
 * opposed to the customer's proof being absent or wrong. The manual `/check` treats it as the failure it reports
 * (the customer retries); the unattended re-verification must NOT read it as "the domain stopped verifying".
 */
export type CheckOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: VerificationFailure; readonly inconclusive?: true };

const INCONCLUSIVE = true as const;

/**
 * A refusal that is OUR resolver failing, not a policy decision and not the customer's name being absent. The
 * guarded fetcher reports every resolution failure as a refusal; ENOTFOUND/ENODATA are a conclusive "no such name"
 * (the same rule as the DNS-TXT method), anything else (EAI_AGAIN, ESERVFAIL, ETIMEOUT, ECONNREFUSED, no errno) is
 * an outage on our side. A policy refusal (private address, port, scheme) has no `resolverCode` and stays conclusive.
 */
const isResolverOutage = (error: unknown): boolean =>
  error instanceof GuardedFetchRefusal &&
  error.resolverCode !== undefined &&
  error.resolverCode !== "ENOTFOUND" &&
  error.resolverCode !== "ENODATA";

/** Statuses that say "the server could not answer now", not "the file is not there". */
const isTransientStatus = (status: number): boolean => status >= 500 || status === 429 || status === 408;

export interface CheckDeps {
  /** TXT lookup. Separate from the guarded fetcher's `lookup`, which resolves A/AAAA only. */
  readonly resolveTxt: (name: string) => Promise<string[][]>;
  readonly fetch: typeof guardedFetch;
}

/**
 * `dns.Resolver`, not `dns.resolveTxt`.
 *
 * The module-level functions go through whatever the host is configured with,
 * which in a container is whatever the runtime injected into /etc/resolv.conf.
 * A `Resolver` instance queries the nameservers IT is given, so the resolver
 * used for a security decision is one we chose rather than ambient
 * configuration — which is what AC4's "trusted resolver path" has to mean to
 * be worth anything.
 *
 * Pinning the actual server IPs is infrastructure and belongs with
 * STORY-003's Terraform baseline, the same place STORY-131's egress NAT sits.
 * `servers` is accepted here so that lands as configuration, not a code change.
 */
export function createResolver(servers?: readonly string[]): Resolver {
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  if (servers && servers.length > 0) resolver.setServers([...servers]);
  return resolver;
}

export function defaultCheckDeps(servers?: readonly string[]): CheckDeps {
  const resolver = createResolver(servers);
  return { resolveTxt: (name) => resolver.resolveTxt(name), fetch: guardedFetch };
}

/** AC1 — a DNS TXT record carrying this domain's nonce. */
export async function checkDnsTxt(domain: string, nonce: string, deps: CheckDeps): Promise<CheckOutcome> {
  let records: string[][];
  try {
    records = await deps.resolveTxt(dnsRecordName(domain));
  } catch (error) {
    // ENOTFOUND and ENODATA both mean "no such record": conclusive absence. Anything else (ETIMEOUT, ESERVFAIL,
    // ECONNREFUSED to the resolver) is a failure to ASK, not an answer, and is marked inconclusive so the
    // periodic sweep cannot de-verify a fleet on one resolver outage. The customer-facing reason is unchanged.
    const code = (error as { code?: unknown }).code ?? (error as Error).message;
    if (code === "ENOTFOUND" || code === "ENODATA") return { ok: false, reason: "record_absent" };
    return { ok: false, reason: "record_absent", inconclusive: INCONCLUSIVE };
  }

  // A TXT record arrives as an array of string CHUNKS — a value over 255 bytes
  // is split by the protocol itself. Joining them is not optional: a long
  // record would otherwise never match, and the failure would look like a
  // wrong value rather than a chunking bug.
  const values = records.map((chunks) => chunks.join(""));
  if (values.length === 0) return { ok: false, reason: "record_absent" };

  const expected = `${TXT_PREFIX}${nonce}`;
  if (values.some((value) => value.trim() === expected)) return { ok: true };

  // Something is there, but it is not ours — a different remedy from adding a
  // record, so a different reason.
  return { ok: false, reason: "record_present_but_wrong" };
}

/** AC1 — a file at a per-nonce well-known path, served directly. */
export async function checkWellKnownFile(domain: string, nonce: string, deps: CheckDeps): Promise<CheckOutcome> {
  const url = `https://${domain}${wellKnownPath(nonce)}`;
  let response: Awaited<ReturnType<typeof guardedFetch>>;
  try {
    response = await deps.fetch(url);
  } catch (error) {
    // Scenario 6 — the guard refused. Reported as a refusal, and deliberately
    // WITHOUT its reason: the caller chose this URL, so echoing which check
    // fired would turn verification into the address oracle STORY-131 exists
    // to deny.
    if (isResolverOutage(error)) return { ok: false, reason: "fetch_refused", inconclusive: INCONCLUSIVE };
    if (error instanceof GuardedFetchRefusal) return { ok: false, reason: "fetch_refused" };
    return { ok: false, reason: "file_absent", inconclusive: INCONCLUSIVE };
  }

  // Scenario 5 — a redirect is NOT proof. The file must be served by this
  // domain; a 301 to somewhere else proves control of the redirect target, not
  // of the domain being verified, and following it is how this check would
  // become forgeable.
  if (response.status >= 300 && response.status < 400) return { ok: false, reason: "file_redirected" };
  if (isTransientStatus(response.status)) return { ok: false, reason: "file_absent", inconclusive: INCONCLUSIVE };
  if (response.status !== 200) return { ok: false, reason: "file_absent" };

  const body = response.body.toString("utf8").trim();
  return body === nonce ? { ok: true } : { ok: false, reason: "file_wrong_content" };
}

const META_TAG_RE = new RegExp(
  `<meta[^>]+name\\s*=\\s*["']${META_TAG_NAME}["'][^>]*\\scontent\\s*=\\s*["']([^"']*)["']`,
  "i",
);
const META_TAG_REVERSED_RE = new RegExp(
  `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*\\sname\\s*=\\s*["']${META_TAG_NAME}["']`,
  "i",
);

/** AC1 — a meta tag on the domain's root page. */
export async function checkMetaTag(domain: string, nonce: string, deps: CheckDeps): Promise<CheckOutcome> {
  let response: Awaited<ReturnType<typeof guardedFetch>>;
  try {
    response = await deps.fetch(`https://${domain}/`);
  } catch (error) {
    if (isResolverOutage(error)) return { ok: false, reason: "fetch_refused", inconclusive: INCONCLUSIVE };
    if (error instanceof GuardedFetchRefusal) return { ok: false, reason: "fetch_refused" };
    return { ok: false, reason: "tag_absent", inconclusive: INCONCLUSIVE };
  }

  if (isTransientStatus(response.status)) return { ok: false, reason: "tag_absent", inconclusive: INCONCLUSIVE };
  if (response.status !== 200) return { ok: false, reason: "tag_absent" };

  const html = response.body.toString("utf8");
  const found = META_TAG_RE.exec(html)?.[1] ?? META_TAG_REVERSED_RE.exec(html)?.[1];
  if (found === undefined) return { ok: false, reason: "tag_absent" };
  return found.trim() === nonce ? { ok: true } : { ok: false, reason: "tag_wrong_value" };
}

export function runCheck(
  method: VerificationMethod,
  domain: string,
  nonce: string,
  deps: CheckDeps,
): Promise<CheckOutcome> {
  switch (method) {
    case "dns_txt":
      return checkDnsTxt(domain, nonce, deps);
    case "well_known_file":
      return checkWellKnownFile(domain, nonce, deps);
    case "meta_tag":
      return checkMetaTag(domain, nonce, deps);
  }
}
