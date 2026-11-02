import { randomInt } from "node:crypto";
import { isIP } from "node:net";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { taskVerificationSubmittedPayloadSchema, type TaskVerificationFailedPayload } from "../../../contracts/tasks/index.js";
import { GuardedFetchRefusal, type GuardedResponse } from "../net/guarded-fetch.js";
import { ALLOWED_PORTS, ALLOWED_SCHEMES, isGloballyReachable, type UnsafeTargetReason } from "../net/address-rules.js";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withProjectQueueLock } from "../queue/locks.js";
import { refreshProjectSourceIndex } from "../rollup/refresh-project-source-index.js";
import { refreshProjectTaskCounts } from "../rollup/refresh-project-task-counts.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { mentionsBrand, sourceSeededSourceId, seededTargetUrl, verifyUrlPresence, visibleText, type BrandForMatching } from "./verify-presence.js";

// STORY-055 AC5-AC8 + AC11, owner decision 30 (plans-7day/decisions-2026-10-28.md) - the customer's contribution is verified, not
// self-reported. Completing a SEEDING task takes a URL and sends the task to `in_review` (TasksService.completeTask); the
// `source.verify_presence` job then runs these three phases, and the task either becomes `done` or STAYS `in_review` with a
// stated reason (the story: "an unverifiable URL leaves the task in a review state with the reason" - not back to in_progress).
//
// Three rules carry the whole story, the same three as verify-presence.ts:
//   1. THE FETCH IS THE JOB'S (KAD-06) AND GOES THROUGH THE GUARDED FETCHER. `fetch` is injected: the caller passes `guardedFetch`,
//      a test a fake. The request path runs only the PURE host check below.
//   2. NO TRANSACTION IS HELD ACROSS THE FETCH (ADR-0003): `prepare` reads in one short transaction, `fetchSubmission` has no
//      client, `commit` writes in a second short one.
//   3. AN OUTAGE IS NOT AN ACCUSATION, AND A CLAIM IS NOT A FACT: a page that does not name the brand, or is not reachable, is
//      reported with its own reason and closes nothing; only a fetched page that names the brand on the task's own domain does.
//
// Where the URL and the reason live: `task_events` (migration 0155). `verification_submitted` carries `{ url }` and is the
// submission's id; `verification_failed` carries `{ submission_id, reason }`; a success is the `completed` event carrying
// `{ submission_id }`. A submission is ANSWERED once either exists for its id, which is what makes a redelivery a no-op.

const logger = new Logger("verify-submission");

/** The rollup's per-project lock, taken FIRST by every presence write (see verify-presence.ts `PRESENCE_WRITE_LOCK`). */
const PRESENCE_WRITE_LOCK = "rollup.metric_daily";

/** A seeding task: one with a playbook or a source class (a source domain). Only these are completed with a URL. */
export function isSeedingTask(task: { readonly playbook_slug: string | null; readonly source_domain_id: string | null }): boolean {
  return task.playbook_slug !== null || task.source_domain_id !== null;
}

/** `credentials`: the URL embeds a user name or password - not an unsafe TARGET, a malformed submission (a 400, never stored or echoed). */
export type SubmittedUrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: UnsafeTargetReason | "credentials" };

/** Host names that are internal by their label alone (RFC 6761 `localhost`, mDNS `.local`, the conventional `.internal`, RFC 8375 `.home.arpa`). */
const INTERNAL_SUFFIXES: readonly string[] = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * STORY-055 scenario 8 - the PURE host check at submit: no DNS, no socket, so it is safe in the request handler (KAD-06). It
 * reuses the guarded fetcher's own rules (allowed schemes and ports, `isGloballyReachable` for an address literal) and its own
 * reasons, so `422 unsafe_target` reads the same on every surface. A public-looking NAME that resolves to a private address is
 * the one thing it cannot see; the guarded fetch in the job refuses that again (`unsafe_target` in the review reason).
 * The accepted URL is returned as `url.href` (normalised: default port dropped, scheme and host lowercased) and THAT is what is stored,
 * fetched and returned. `new URL` canonicalises the odd literal forms (`127.1`, `0x7f.0.0.1`, `2130706433`) to dotted quads before the check.
 */
export function checkSubmittedUrl(raw: string): SubmittedUrlCheck {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "scheme_not_allowed" };
  }
  if (!ALLOWED_SCHEMES.includes(url.protocol)) return { ok: false, reason: "scheme_not_allowed" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  if (url.port !== "" && !ALLOWED_PORTS.includes(Number(url.port))) return { ok: false, reason: "port_not_allowed" };

  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "") return { ok: false, reason: "hostname_missing" };
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) return isGloballyReachable(bare) ? { ok: true, url: url.href } : { ok: false, reason: "address_not_global" };

  const internal = host === "localhost" || !host.includes(".") || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
  return internal ? { ok: false, reason: "address_not_global" } : { ok: true, url: url.href };
}

/** The guarded fetcher, as the submission job calls it: `followRedirect` lets it refuse a hop (the guarded fetch supports it natively). */
export type SubmissionFetcher = (url: string, init?: { readonly followRedirect?: (nextUrl: string) => boolean }) => Promise<GuardedResponse>;

/** What the job read: everything `fetchSubmission` and `commitSubmissionVerification` need, and nothing else. */
export interface SubmissionPlan {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly submissionId: string;
  readonly url: string;
  /** The submitter: the `completed_by` of the task and the `created_by` of its milestone. */
  readonly submittedBy: string | null;
  readonly title: string;
  readonly sourceDomainId: string | null;
  readonly domain: string | null;
  readonly today: string;
  readonly brand: BrandForMatching;
}

export type SubmissionOutcome =
  | { readonly status: "verified" }
  | { readonly status: "unverified"; readonly reason: TaskVerificationFailedPayload["reason"] };

/**
 * Phase 1 (one short tenant transaction). Null - nothing to fetch - when the task is gone or not visible (another tenant's), is no
 * longer `in_review`, the submission is not its LATEST (a resubmission superseded it), or the submission was already answered (a
 * redelivery). RLS bounds every read to the context's workspace.
 */
export async function prepareSubmissionVerification(tx: ClientBase, projectId: string, taskId: string, submissionId: string): Promise<SubmissionPlan | null> {
  const found = await tx.query<{
    workspace_id: string;
    title: string;
    source_domain_id: string | null;
    domain: string | null;
    name: string;
    brand_aliases: string[];
    negative_aliases: string[];
    today: string;
    payload: unknown;
    actor_id: string | null;
    answered: boolean;
    latest: boolean;
  }>(
    `SELECT p.workspace_id::text AS workspace_id, t.title, t.source_domain_id::text AS source_domain_id, sd.domain,
            p.name, p.brand_aliases, p.negative_aliases,
            to_char((now() AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS today,
            s.payload, s.actor_id::text AS actor_id,
            EXISTS (SELECT 1 FROM task_events a
                     WHERE a.task_id = t.id AND a.workspace_id = app.current_workspace() AND a.payload->>'submission_id' = s.id::text
                       AND a.event IN ('verification_failed', 'completed')) AS answered,
            NOT EXISTS (SELECT 1 FROM task_events n
                         WHERE n.task_id = t.id AND n.workspace_id = app.current_workspace() AND n.event = 'verification_submitted'
                           AND (n.occurred_at, n.id) > (s.occurred_at, s.id)) AS latest
       FROM tasks t
       JOIN projects p   ON p.id = t.project_id AND p.deleted_at IS NULL
       JOIN workspaces w ON w.id = p.workspace_id
       JOIN task_events s ON s.task_id = t.id AND s.workspace_id = app.current_workspace() AND s.id = $3 AND s.event = 'verification_submitted'
       LEFT JOIN source_domains sd ON sd.id = t.source_domain_id
      WHERE t.id = $2 AND t.project_id = $1 AND t.workspace_id = app.current_workspace() AND t.status = 'in_review' AND t.deleted_at IS NULL`,
    [projectId, taskId, submissionId],
  );
  const row = found.rows[0];
  if (row === undefined || row.answered || !row.latest) return null;
  const payload = taskVerificationSubmittedPayloadSchema.safeParse(row.payload);
  if (!payload.success) return null; // a malformed submission is not fetched
  return {
    workspaceId: row.workspace_id,
    projectId,
    taskId,
    submissionId,
    url: payload.data.url,
    submittedBy: row.actor_id,
    title: row.title,
    sourceDomainId: row.source_domain_id,
    domain: row.domain,
    today: row.today,
    brand: { name: row.name, aliases: row.brand_aliases, negativeAliases: row.negative_aliases },
  };
}

/**
 * Phase 2 (NO transaction, no client): fetch the submitted URL through the injected guarded fetcher and say why it does not close
 * the gap, if it does not. The URL (and the page it ended on after redirects) must be on the task's own domain: a mention on
 * another site is not a contribution to THIS platform. Never throws - every failure is a reason the customer can act on.
 *
 * A TRANSIENT FETCH ERROR IS FINAL HERE, on purpose (unlike the legacy `taskId` mode, which throws so the queue retries): the task
 * stays `in_review`, the reason is `unreachable`, and the customer resubmits - a retry loop would leave the task showing "pending"
 * for the length of the backoff, and a 404 and a connection reset are indistinguishable to us. The cost is that a one-off blip needs
 * a resubmit; the benefit is that no submission can sit pending behind a failing fetch.
 */
export async function fetchSubmission(plan: SubmissionPlan, fetch: SubmissionFetcher, options: SubmissionFetchOptions = {}): Promise<SubmissionOutcome> {
  // FAIL CLOSED: `completeTask` refuses a seeding task with no source domain (`no_source_domain`), so none reaches here; if one
  // ever did, an unconstrained mention anywhere on the web must not close a gap.
  const domain = plan.domain;
  if (domain === null || seededTargetUrl(plan.url, domain) === null) return { status: "unverified", reason: "wrong_domain" };
  // No hop is followed off the task's domain: a redirect is not fetched just to find out where it lands.
  const onDomain = (next: string): boolean => seededTargetUrl(next, domain) !== null;

  // `verifyUrlPresence` folds every GuardedFetchRefusal into "refused" and drops the error. The reason matters here, so the wrapper
  // keeps the refusal itself: only a refusal about the ADDRESS, PORT or SCHEME is the customer's unsafe target.
  const seen: { response?: GuardedResponse; refusal?: GuardedFetchRefusal; offDomainRedirect?: boolean } = {};
  const outcome = await verifyUrlPresence(plan.url, plan.brand, async (url) => {
    try {
      seen.response = await fetch(url, {
        followRedirect: (next) => {
          const on = onDomain(next);
          if (!on) seen.offDomainRedirect = true;
          return on;
        },
      });
    } catch (error) {
      if (error instanceof GuardedFetchRefusal) seen.refusal = error;
      throw error;
    }
    return seen.response;
  });
  if (seen.offDomainRedirect === true) return { status: "unverified", reason: "wrong_domain" };
  if (outcome.status === "failed") {
    if (outcome.reason === "refused" && seen.refusal !== undefined) return { status: "unverified", reason: refusalReason(seen.refusal) };
    const reason = outcome.reason === "refused" ? "unsafe_target" : outcome.reason === "not_text" ? "not_a_page" : outcome.reason === "no_aliases" ? "no_brand_names" : "unreachable";
    return { status: "unverified", reason };
  }
  const page = seen.response;
  // Before present/absent: a page the redirects carried OFF the task's domain says nothing about a contribution THERE, whether or
  // not it names the brand (a customer told "no mention" would look for a mention on a page that was never theirs).
  if (page !== undefined && !onDomain(page.finalUrl)) return { status: "unverified", reason: "wrong_domain" };
  if (outcome.status === "absent") return { status: "unverified", reason: "no_mention" };

  // REFLECTION (owner decision 46): the customer chooses the URL, and a site search, a tag page or a soft-404 echoes it into the page -
  // so a brand name that is IN the URL could "appear" on a page that never mentioned it. A brand in the URL is not refused at once
  // (`/products/acme-analytics/` is a real page): the CANARY decides, on the submitted URL and again on the page the redirects ended on.
  if (page !== undefined) {
    const nonce = options.nonce ?? randomLetters;
    const checked = new Set<string>();
    for (const target of [plan.url, page.finalUrl]) {
      const key = normalisedHref(target);
      if (checked.has(key)) continue;
      checked.add(key);
      const refusal = await canaryRefusal(plan, target, page, fetch, onDomain, nonce);
      if (refusal !== null) return refusal;
    }
  }
  return { status: "verified" };
}

// ───────────────────────── URL reflection: lenient decoding, the echo test, and the canary (owner decision 46) ─────────────────────────

/** How many times a URL component is percent-decoded before it is read: a name encoded up to four layers deep is still a name. */
const DECODE_PASSES = 4;

/** One UTF-16 code unit of a decoded string, and where it came from in the RAW string (`start`..`end`) and how (`styles`: "p" = %XX, "u" = %uXXXX, one letter per decode pass, first pass first). */
interface DecodedUnit {
  readonly ch: string;
  readonly start: number;
  readonly end: number;
  readonly styles: string;
}

const ESCAPES = /(?:%[0-9A-Fa-f]{2})+|%u[0-9A-Fa-f]{4}/gu;

function longestStyles(units: readonly DecodedUnit[]): string {
  return units.reduce((best, unit) => (unit.styles.length > best.length ? unit.styles : best), "");
}

/** UTF-8 -> text with U+FFFD for each maximal invalid subpart (the WHATWG decoder's replacement behaviour), keeping which bytes each unit came from. */
function decodeUtf8Run(bytes: readonly number[]): { str: string; from: number; to: number }[] {
  const out: { str: string; from: number; to: number }[] = [];
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i]!;
    if (lead < 0x80) {
      out.push({ str: String.fromCharCode(lead), from: i, to: i + 1 });
      i += 1;
      continue;
    }
    const need = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0;
    if (need === 0) {
      out.push({ str: "�", from: i, to: i + 1 });
      i += 1;
      continue;
    }
    let lower = 0x80;
    let upper = 0xbf;
    if (lead === 0xe0) lower = 0xa0;
    else if (lead === 0xed) upper = 0x9f;
    else if (lead === 0xf0) lower = 0x90;
    else if (lead === 0xf4) upper = 0x8f;
    let code = lead & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    let taken = 1;
    while (taken <= need) {
      const next = bytes[i + taken];
      if (next === undefined || next < lower || next > upper) break;
      code = (code << 6) | (next & 0x3f);
      lower = 0x80;
      upper = 0xbf;
      taken += 1;
    }
    out.push({ str: taken === need + 1 ? String.fromCodePoint(code) : "�", from: i, to: i + taken });
    i += taken;
  }
  return out;
}

function decodePass(units: readonly DecodedUnit[]): DecodedUnit[] {
  const text = units.map((unit) => unit.ch).join("");
  const next: DecodedUnit[] = [];
  let at = 0;
  for (const match of text.matchAll(ESCAPES)) {
    const from = match.index;
    const to = from + match[0].length;
    next.push(...units.slice(at, from));
    if (match[0].startsWith("%u")) {
      const covered = units.slice(from, to);
      next.push({ ch: String.fromCharCode(Number.parseInt(match[0].slice(2), 16)), start: covered[0]!.start, end: covered[covered.length - 1]!.end, styles: `${longestStyles(covered)}u` });
    } else {
      const bytes: number[] = [];
      for (let k = from; k < to; k += 3) bytes.push(Number.parseInt(text.slice(k + 1, k + 3), 16));
      for (const part of decodeUtf8Run(bytes)) {
        const covered = units.slice(from + part.from * 3, from + part.to * 3);
        for (const ch of part.str) {
          for (const unit of ch.length === 2 ? [ch[0]!, ch[1]!] : [ch]) next.push({ ch: unit, start: covered[0]!.start, end: covered[covered.length - 1]!.end, styles: `${longestStyles(covered)}p` });
        }
      }
    }
    at = to;
  }
  next.push(...units.slice(at));
  return next;
}

/** The raw string as units, decoded to a fixed point (at most DECODE_PASSES passes). */
function decodeUnits(raw: string): DecodedUnit[] {
  let units: DecodedUnit[] = Array.from({ length: raw.length }, (_unused, i) => ({ ch: raw[i]!, start: i, end: i + 1, styles: "" }));
  for (let pass = 0; pass < DECODE_PASSES; pass += 1) {
    const next = decodePass(units);
    if (next.length === units.length && next.every((unit, i) => unit.ch === units[i]!.ch)) break; // stable
    units = next;
  }
  return units;
}

/**
 * Percent-decodes ESCAPE BY ESCAPE (round 5): a run of `%XX` is grouped into bytes and decoded as UTF-8 with U+FFFD for invalid bytes,
 * `%uXXXX` is decoded, and a malformed escape (`%ZZ`, a lone `%`) is KEPT IN PLACE - one bad escape no longer leaves the whole
 * segment raw, which is what `decodeURIComponent` did (it throws, and the segment was then read undecoded: `%41cme%C0` hid a name).
 * Repeated until the string is stable, at most DECODE_PASSES times. Never throws.
 */
export function decodeLoosely(value: string): string {
  return decodeUnits(value)
    .map((unit) => unit.ch)
    .join("");
}

/** The URL's request-bearing parts as RAW strings: path segments, then each query key and value. The fragment is never sent to the server, so it is not one. */
function urlPieces(url: URL): { readonly segments: string[]; readonly query: { key: string; value: string | null }[] } {
  const search = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  return {
    segments: url.pathname.split("/"),
    query:
      search === ""
        ? []
        : search.split("&").map((pair) => {
            const eq = pair.indexOf("=");
            return eq === -1 ? { key: pair, value: null } : { key: pair.slice(0, eq), value: pair.slice(eq + 1) };
          }),
  };
}

const SEPARATORS = /[-_+.]+/gu;

/**
 * True when the brand is named by the URL's path segments or query keys or values - the parts the SERVER receives (the fragment stays in
 * the browser, so it cannot be reflected). Decoded leniently first, and separators (`-`, `_`, `+`, `.`) read as spaces, so
 * `?search=Acme+Analytics` and `/acme-analytics-review` both match. The host is not read: a brand's own subdomain is not an echo of the
 * request. This only says the URL NAMES the brand; whether the site reflects it is the canary's question.
 */
export function urlEchoesBrand(rawUrl: string, brand: BrandForMatching): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const { segments, query } = urlPieces(url);
  const parts = [...segments, ...query.flatMap((pair) => (pair.value === null ? [pair.key] : [pair.key, pair.value]))].map(decodeLoosely);
  return mentionsBrand(parts.join(" ").replace(SEPARATORS, " "), brand);
}

// ---- the canary

/** A nonce is at least this long, so a chance appearance of it in a page is negligible. */
const NONCE_MIN_LENGTH = 8;
/** Pages are the same when their word 3-shingle sets (brand and nonce words removed) overlap at least this much (Jaccard). */
export const SAME_PAGE_SHINGLE_OVERLAP = 0.9;
const SHINGLE_WORDS = 3;

export interface SubmissionFetchOptions {
  /** Test seam: the nonce for one brand-token occurrence (letters only), given the length wanted. Default: random lowercase letters. */
  readonly nonce?: (length: number) => string;
}

function randomLetters(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(97 + randomInt(26));
  return out;
}

function labelsOf(brand: BrandForMatching): string[] {
  return [...new Set([brand.name, ...brand.aliases].map((value) => value.trim()).filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** A label as a token: its words in order, any run of separators between them, never inside a longer word. Null for a label with no word. */
function labelPattern(label: string): RegExp | null {
  const words = label.split(/[\s\-_+.]+/u).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRegExp).join("[-_+.\\s]+")}(?![\\p{L}\\p{N}])`, "giu");
}

/** The brand tokens in `text` as [start, end) spans, longest label first and never overlapping. */
function brandSpans(text: string, brand: BrandForMatching): [number, number][] {
  const spans: [number, number][] = [];
  for (const label of labelsOf(brand)) {
    const pattern = labelPattern(label);
    if (pattern === null) continue;
    for (const match of text.matchAll(pattern)) {
      const span: [number, number] = [match.index, match.index + match[0].length];
      if (!spans.some(([from, to]) => span[0] < to && from < span[1])) spans.push(span);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}

/** One decoded character written back as the escape(s) it came from: `styles` is the decode history, so the LAST pass's escape is made first and each earlier pass escapes its '%'. */
function encodeLike(ch: string, styles: string): string {
  if (styles === "") return ch;
  const code = ch.charCodeAt(0);
  const escape = (style: string, c: number): string => (style === "u" ? `%u${c.toString(16).toUpperCase().padStart(4, "0")}` : `%${c.toString(16).toUpperCase().padStart(2, "0")}`);
  let out = escape(styles[styles.length - 1]!, code);
  for (let k = styles.length - 2; k >= 0; k -= 1) out = escape(styles[k]!, 0x25) + out.slice(1);
  return out;
}

/** One raw piece with every brand token replaced by a nonce encoded the way the token was; the rest is kept byte for byte. */
function canaryPiece(raw: string, brand: BrandForMatching, nonce: (length: number) => string, used: string[]): string {
  const units = decodeUnits(raw);
  const spans = brandSpans(units.map((unit) => unit.ch).join(""), brand);
  if (spans.length === 0) return raw;
  let out = "";
  let at = 0; // index into `units`
  let rawEnd = 0; // how much of `raw` has been written
  for (const [from, to] of spans) {
    for (; at < from; at += 1) {
      out += raw.slice(Math.max(units[at]!.start, rawEnd), units[at]!.end);
      rawEnd = Math.max(rawEnd, units[at]!.end);
    }
    const value = nonce(Math.max(NONCE_MIN_LENGTH, to - from));
    used.push(value);
    for (let j = 0; j < value.length; j += 1) out += encodeLike(value[j]!, units[from + Math.min(j, to - from - 1)]!.styles);
    rawEnd = Math.max(rawEnd, units[to - 1]!.end);
    at = to;
  }
  for (; at < units.length; at += 1) {
    out += raw.slice(Math.max(units[at]!.start, rawEnd), units[at]!.end);
    rawEnd = Math.max(rawEnd, units[at]!.end);
  }
  return out + raw.slice(rawEnd);
}

/** The canary: the same URL (fragment dropped - never sent) with each brand token replaced by a random nonce. Null when no token could be located in a single piece (fail closed). */
function buildCanary(rawUrl: string, brand: BrandForMatching, nonce: (length: number) => string): { readonly url: string; readonly nonces: readonly string[] } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const used: string[] = [];
  const { segments, query } = urlPieces(url);
  const path = segments.map((segment) => canaryPiece(segment, brand, nonce, used)).join("/");
  const search = query.map((pair) => (pair.value === null ? canaryPiece(pair.key, brand, nonce, used) : `${canaryPiece(pair.key, brand, nonce, used)}=${canaryPiece(pair.value, brand, nonce, used)}`)).join("&");
  const built = `${url.origin}${path}${query.length > 0 ? `?${search}` : ""}`;
  // The token must be GONE from the canary: one split over two pieces (`/acme/analytics`) or one this locator could not see leaves it.
  if (used.length === 0 || urlEchoesBrand(built, brand)) return null;
  return { url: built, nonces: used };
}

function normalisedHref(rawUrl: string): string {
  try {
    return new URL(rawUrl).href;
  } catch {
    return rawUrl;
  }
}

function isTextResponse(response: GuardedResponse): boolean {
  const raw = response.headers["content-type"];
  const type = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase();
  if (type === undefined || type.length === 0) return true;
  return type.startsWith("text/") || type.includes("xml") || type.includes("json");
}

/** A page's words with the brand tokens and the nonces taken out: what is left is the TEMPLATE. */
function templateWords(response: GuardedResponse, brand: BrandForMatching, nonces: readonly string[]): string[] {
  let text = visibleText(response.body.toString("utf8")).normalize("NFKC").toLowerCase();
  for (const label of labelsOf(brand)) {
    const pattern = labelPattern(label);
    if (pattern !== null) text = text.replace(pattern, " ");
  }
  for (const value of nonces) text = text.split(value.toLowerCase()).join(" ");
  return text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

/**
 * THE SAME-PAGE RULE (documented, simple): two pages are the same when, with the brand tokens and the nonces removed, their words are
 * identical, or - for pages of at least SHINGLE_WORDS words - their sets of 3-word shingles overlap by at least
 * SAME_PAGE_SHINGLE_OVERLAP (Jaccard). The tolerance absorbs a counter or a date that differs between two fetches; a different
 * page (a not-found template, a listing) shares almost no shingles. Two empty pages are the same: nothing distinguishes them.
 */
export function isSameTemplate(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === b.length && a.every((word, i) => word === b[i])) return true;
  if (a.length < SHINGLE_WORDS || b.length < SHINGLE_WORDS) return false;
  const shingles = (words: readonly string[]): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) set.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
    return set;
  };
  const left = shingles(a);
  const right = shingles(b);
  let shared = 0;
  for (const shingle of left) if (right.has(shingle)) shared += 1;
  return shared / (left.size + right.size - shared) >= SAME_PAGE_SHINGLE_OVERLAP;
}

/** A word of at least ECHO_PREFIX_MIN_LENGTH characters that is a prefix of the nonce: the page printed a truncated copy of what it was given. */
const ECHO_PREFIX_MIN_LENGTH = 5;
function echoesPrefix(haystack: string, nonce: string): boolean {
  return haystack.split(/[^\p{L}\p{N}]+/u).some((word) => word.length >= ECHO_PREFIX_MIN_LENGTH && nonce.startsWith(word));
}

type CanaryResult = "not_named" | "different" | "echoed_nonce" | "same_page" | "unbuildable" | "failed";

function recordCanary(plan: SubmissionPlan, result: CanaryResult): void {
  incrementCounter("nominara_tasks_url_canary_total", { result });
  trace.getActiveSpan()?.setAttribute("nominara.tasks.url_canary", result);
  // IDs and the result only - never the URL, the nonce, the brand or page text.
  if (result !== "not_named") logger.log({ event: "task_verification_url_canary", workspaceId: plan.workspaceId, taskId: plan.taskId, result });
}

/**
 * Owner decision 46 - the test fetch. When `target` (the submitted URL, or the page the redirects ended on) names the brand in its path
 * or query, fetch the same URL with the brand replaced by a random nonce, through the same fetcher with the same domain and redirect
 * rules, and compare it with the page already fetched (`page`, the page at `target`). Null = proceed to verify the page.
 *   - the nonce (or a 5+ letter prefix of it) is in the canary's text: the site reflects what it is given -> url_echoes_brand
 *   - the canary still names the brand, or ended on the original page's URL (decision 49)            -> null (verify: id-routed sites)
 *   - the canary is a 2xx page that is the SAME TEMPLATE, brand and nonce removed, and no longer names the brand -> url_echoes_brand
 *   - the canary is 404/410, a redirect that was not followed, not text, or a different page      -> null (the site tells slugs apart)
 *   - the canary could not be fetched, or answered 5xx/429/403/...                                 -> FAIL CLOSED, with the fetch's own reason
 *   - no canary can be built (the token is split over two pieces, or cannot be located)            -> url_echoes_brand (fail closed)
 */
async function canaryRefusal(
  plan: SubmissionPlan,
  target: string,
  page: GuardedResponse,
  fetch: SubmissionFetcher,
  onDomain: (url: string) => boolean,
  nonce: (length: number) => string,
): Promise<SubmissionOutcome | null> {
  if (!urlEchoesBrand(target, plan.brand)) return null;
  const canary = buildCanary(target, plan.brand, nonce);
  if (canary === null) {
    recordCanary(plan, "unbuildable");
    return { status: "unverified", reason: "url_echoes_brand" };
  }
  let response: GuardedResponse;
  try {
    response = await fetch(canary.url, { followRedirect: onDomain });
  } catch (error) {
    recordCanary(plan, "failed");
    return { status: "unverified", reason: error instanceof GuardedFetchRefusal ? refusalReason(error) : "unreachable" };
  }
  if (response.status === 404 || response.status === 410 || (response.status >= 300 && response.status < 400)) {
    recordCanary(plan, "different");
    return null;
  }
  if (response.status < 200 || response.status >= 300) {
    recordCanary(plan, "failed"); // a rate limit, a WAF block or an outage says nothing about whether the site reflects
    return { status: "unverified", reason: "unreachable" };
  }
  if (!onDomain(response.finalUrl) || !isTextResponse(response)) {
    recordCanary(plan, "different");
    return null;
  }
  const text = visibleText(response.body.toString("utf8"));
  // The text only: a redirect that keeps the slug (/tag/x -> /tag/x/) is not a reflection, so the landed URL is not read (round 6).
  const haystack = `${text}\n${decodeLoosely(text)}`.toLowerCase();
  const lowerNonces = canary.nonces.map((value) => value.toLowerCase());
  if (lowerNonces.some((value) => haystack.includes(value) || echoesPrefix(haystack, value))) {
    recordCanary(plan, "echoed_nonce");
    return { status: "unverified", reason: "url_echoes_brand" };
  }
  // Owner decision 49: the nonce is not reflected. A canary that still names the brand got it from the content; one redirected back
  // to the canonical page is the site normalising the slug. Both mean the original page is a real page: verify.
  if (mentionsBrand(text, plan.brand) || normalisedHref(response.finalUrl) === normalisedHref(page.finalUrl)) {
    recordCanary(plan, "different");
    return null;
  }
  // The same template that no longer names the brand: a disguised reflection.
  if (isSameTemplate(templateWords(page, plan.brand, []), templateWords(response, plan.brand, canary.nonces))) {
    recordCanary(plan, "same_page");
    return { status: "unverified", reason: "url_echoes_brand" };
  }
  recordCanary(plan, "different");
  return null;
}

/**
 * A guard refusal is either about the TARGET (an address that is not global, a port or scheme that is not allowed - including on a
 * redirect hop) or about the NETWORK (the name did not resolve, the resolver is down, the redirects never ended). `resolverCode`
 * is set only for a resolution failure, on the first request or on a hop. Telling a customer their URL is "unsafe" because our
 * resolver timed out would be a false accusation, so the network cases are `unreachable`.
 */
function refusalReason(refusal: GuardedFetchRefusal): "unsafe_target" | "unreachable" {
  if (refusal.resolverCode !== undefined) return "unreachable";
  if (refusal.reason === "dns_resolution_failed" || refusal.reason === "too_many_redirects") return "unreachable";
  return "unsafe_target";
}

/**
 * Phase 3 (a second short tenant transaction). Returns true when it changed the task. Under the rollup's lock and the task's row
 * lock it re-checks that the task is STILL `in_review` on THIS submission and unanswered (a PATCH out of review, a resubmission or a
 * racing delivery makes it a no-op), then:
 *   - verified: `done`, `completed_at` now, the `task_completed` milestone, the `completed` event, the domain's presence flag
 *     true, the `source_seeded` milestone (AC7) and the index recompute that closes the gap (AC8), then the open counts;
 *   - unverified: a `verification_failed` event with the reason. The task stays `in_review`, and nothing else changes.
 */
export async function commitSubmissionVerification(tx: ClientBase, plan: SubmissionPlan, outcome: SubmissionOutcome, now: Date): Promise<boolean> {
  incrementCounter("nominara_tasks_verification_total", { outcome: outcome.status === "verified" ? "verified" : outcome.reason });
  // The rollup's lock FIRST, before the task row lock: the presence written below must not be lost to a rollup's index rebuild.
  return withProjectQueueLock(tx, PRESENCE_WRITE_LOCK, plan.projectId, () => commitLocked(tx, plan, outcome, now));
}

async function commitLocked(tx: ClientBase, plan: SubmissionPlan, outcome: SubmissionOutcome, now: Date): Promise<boolean> {
  // TWO STATEMENTS, on purpose. In READ COMMITTED a `SELECT ... FOR UPDATE` that waits for a row lock re-checks that row's own
  // columns when it wakes, but not its subqueries over OTHER tables: with the checks in the same statement, a resubmission that
  // committed while this one waited (it holds the task row lock, not the rollup's) would be invisible to them and this stale answer
  // would complete the task. The lock first, then the checks in a statement that takes a fresh snapshot.
  const locked = await tx.query(
    `SELECT id FROM tasks WHERE id = $1 AND project_id = $2 AND workspace_id = app.current_workspace() AND deleted_at IS NULL FOR NO KEY UPDATE`,
    [plan.taskId, plan.projectId],
  );
  const current =
    locked.rows.length === 0
      ? locked
      : await tx.query(
          `SELECT t.id FROM tasks t
            WHERE t.id = $1 AND t.project_id = $2 AND t.workspace_id = app.current_workspace() AND t.status = 'in_review' AND t.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM task_events n WHERE n.task_id = t.id AND n.workspace_id = app.current_workspace()
                                AND n.event = 'verification_submitted' AND n.id <> $3::uuid
                                AND (n.occurred_at, n.id) > (SELECT s.occurred_at, s.id FROM task_events s WHERE s.id = $3 AND s.workspace_id = app.current_workspace()))
              AND NOT EXISTS (SELECT 1 FROM task_events a WHERE a.task_id = t.id AND a.workspace_id = app.current_workspace()
                                AND a.payload->>'submission_id' = $3::text AND a.event IN ('verification_failed', 'completed'))`,
          [plan.taskId, plan.projectId, plan.submissionId],
        );
  if (current.rows.length === 0) {
    logger.log({ event: "task_verification_stale", workspaceId: plan.workspaceId, projectId: plan.projectId, taskId: plan.taskId });
    return false;
  }

  // THE TIMELINE IS STAMPED BY THE DATABASE CLOCK, like completeTask's: the submission event was, and an app-server clock that
  // differs by a second would put the answer before the question. `now` (the job's clock) is only the index's `verified_at`.
  if (outcome.status === "unverified") {
    await tx.query(
      `INSERT INTO task_events (workspace_id, task_id, actor_type, event, from_value, to_value, payload, occurred_at)
       VALUES (app.current_workspace(), $1, 'system', 'verification_failed', 'in_review', 'in_review', $2::jsonb, clock_timestamp())`,
      [plan.taskId, JSON.stringify({ submission_id: plan.submissionId, reason: outcome.reason } satisfies TaskVerificationFailedPayload)],
    );
    incrementCounter("nominara_tasks_events_written_total", { event: "verification_failed" });
    // IDs and the reason code only - never the URL, the brand or page text.
    logger.log({ event: "task_verification_unverified", workspaceId: plan.workspaceId, projectId: plan.projectId, taskId: plan.taskId, reason: outcome.reason });
    return true;
  }

  const completed = await tx.query<{ id: string; occurred_at: Date }>(
    `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, severity, source_type, source_id, created_by)
     VALUES (app.current_workspace(), $1, clock_timestamp(), 'task_completed', $2, 'positive', 'task', $3, $4)
     RETURNING id, occurred_at`,
    [plan.projectId, plan.title, plan.taskId, plan.submittedBy],
  );
  const completedAt = completed.rows[0]!.occurred_at; // the completion instant: the task's, both milestones', and STORY-067's window anchor
  await tx.query(`UPDATE tasks SET status = 'done', completed_at = $2, completed_by = $3, milestone_id = $4 WHERE id = $1 AND workspace_id = app.current_workspace()`, [
    plan.taskId,
    completedAt,
    plan.submittedBy,
    completed.rows[0]!.id,
  ]);
  await tx.query(
    `INSERT INTO task_events (workspace_id, task_id, actor_type, event, from_value, to_value, payload, occurred_at)
     VALUES (app.current_workspace(), $1, 'system', 'completed', 'in_review', 'done', $2::jsonb, clock_timestamp())`,
    [plan.taskId, JSON.stringify({ submission_id: plan.submissionId })],
  );

  if (plan.sourceDomainId !== null) {
    await tx.query(`UPDATE project_source_index SET brand_present_on_domain = true, verified_at = $3 WHERE project_id = $1 AND source_domain_id = $2 AND workspace_id = app.current_workspace()`, [
      plan.projectId,
      plan.sourceDomainId,
      now,
    ]);
  }
  // `source_seeded`, once per task for ever (ux_milestones_source). Titled by the DOMAIN, never the task: a task born of a
  // displacement names a competitor in its title, and the portal's competitor exclusion recognises that only on a `task` pin.
  const domainLabel = plan.domain ?? new URL(plan.url).hostname;
  await tx.query(
    `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, severity, source_type, source_id, visible_in_portal)
     VALUES (app.current_workspace(), $1, $2, 'source_seeded', $3, 'positive', 'system', $4, true)
     ON CONFLICT (source_type, source_id) WHERE source_id IS NOT NULL DO NOTHING`,
    [plan.projectId, completedAt, `Source seeded: ${domainLabel}`, sourceSeededSourceId(plan.projectId, plan.taskId)],
  );
  await refreshProjectSourceIndex(tx, plan.projectId, plan.today);
  await refreshProjectTaskCounts(tx, plan.projectId);

  incrementCounter("nominara_tasks_events_written_total", { event: "completed" });
  incrementCounter("nominara_tasks_completed_total", {});
  logger.log({ event: "task_verification_verified", workspaceId: plan.workspaceId, projectId: plan.projectId, taskId: plan.taskId });

  // The audit row for the in_review -> done transition (the submission was audited by the route as `task.verification_submitted`).
  // LAST, as the rollup does: an audit append takes the workspace's audit-chain lock until COMMIT and nothing after it may wait.
  // The actor is the system (the job); the submitter is the task's `completed_by`. No ids in the state: the audit redactor
  // stores a long high-entropy string as "[redacted]".
  await new AuditChainService().append(tx, {
    workspaceId: plan.workspaceId,
    actorType: "system",
    actorId: SYSTEM_ACTOR_ID,
    actorIp: null,
    actorUa: "job:source.verify_presence",
    action: "task.verification_completed",
    resourceType: "task",
    resourceId: plan.taskId,
    beforeState: { status: "in_review" },
    afterState: { status: "done" },
    requestId: "",
    supportGrantId: null,
    severity: "info",
  });
  return true;
}

/**
 * The job's LAST attempt failed (a database error in `prepare` or `commit`, retries spent): answer the submission `unreachable` so the
 * task does not sit `pending` for ever with every resubmit a 409. Called from the handler's `recover` hook in a fresh tenant
 * transaction; the same lock-then-check shape as `commitLocked`, so a submission that was answered, superseded or moved out of review
 * meanwhile writes nothing. Returns true when it wrote the answer.
 */
export async function recordSubmissionGaveUp(tx: ClientBase, ids: { workspaceId: string; projectId: string; taskId: string; submissionId: string }): Promise<boolean> {
  return withProjectQueueLock(tx, PRESENCE_WRITE_LOCK, ids.projectId, async () => {
    const locked = await tx.query(
      `SELECT id FROM tasks WHERE id = $1 AND project_id = $2 AND workspace_id = app.current_workspace() AND deleted_at IS NULL FOR NO KEY UPDATE`,
      [ids.taskId, ids.projectId],
    );
    if (locked.rows.length === 0) return false;
    const current = await tx.query(
      `SELECT t.id FROM tasks t
        WHERE t.id = $1 AND t.workspace_id = app.current_workspace() AND t.status = 'in_review'
          AND EXISTS (SELECT 1 FROM task_events s WHERE s.id = $2::uuid AND s.task_id = t.id AND s.workspace_id = app.current_workspace()
                        AND s.event = 'verification_submitted')
          AND NOT EXISTS (SELECT 1 FROM task_events n WHERE n.task_id = t.id AND n.workspace_id = app.current_workspace()
                            AND n.event = 'verification_submitted' AND n.id <> $2::uuid
                            AND (n.occurred_at, n.id) > (SELECT s.occurred_at, s.id FROM task_events s WHERE s.id = $2 AND s.workspace_id = app.current_workspace()))
          AND NOT EXISTS (SELECT 1 FROM task_events a WHERE a.task_id = t.id AND a.workspace_id = app.current_workspace()
                            AND a.payload->>'submission_id' = $2::text AND a.event IN ('verification_failed', 'completed'))`,
      [ids.taskId, ids.submissionId],
    );
    if (current.rows.length === 0) return false;
    await tx.query(
      `INSERT INTO task_events (workspace_id, task_id, actor_type, event, from_value, to_value, payload, occurred_at)
       VALUES (app.current_workspace(), $1, 'system', 'verification_failed', 'in_review', 'in_review', $2::jsonb, clock_timestamp())`,
      [ids.taskId, JSON.stringify({ submission_id: ids.submissionId, reason: "unreachable" } satisfies TaskVerificationFailedPayload)],
    );
    incrementCounter("nominara_tasks_verification_total", { outcome: "gave_up" });
    incrementCounter("nominara_tasks_events_written_total", { event: "verification_failed" });
    logger.warn({ event: "task_verification_gave_up", workspaceId: ids.workspaceId, projectId: ids.projectId, taskId: ids.taskId });
    return true;
  });
}
