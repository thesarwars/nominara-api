import {
  rateLimitConfigSchema,
  type RateLimitConfig,
} from "../../../contracts/common/rate-limit.schema.js";

// STORY-025 T17 — api-specification.md §12's table, transcribed.
//
// coding-standards.md §11: "Numeric constants match the reference exactly —
// not a plausible neighbour." Every number below is read off §12 and nothing
// is rounded, harmonised or inferred. Where §12 is ambiguous the ambiguity is
// named rather than resolved silently.
//
// SIXTEEN classes (fifteen from §12 plus `tool_site_files`, owner decision 71(d)). STORY-025's own acceptance criteria list nine; the
// reference outranks the story, so they ship and the story text goes on
// the hand-carried specification-fix list.
//
// The two columns are NOT redundant. §12 says "token buckets", so the rate
// column is the refill and the Burst column is the bucket's capacity: a
// client may spend `burst` at once, then proceeds at the steady rate. A fixed
// window counter would have nowhere to put the second number.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * §12's table, row for row and in its order.
 *
 * TWO READINGS ARE RECORDED HERE RATHER THAN GUESSED AT:
 *
 *   "40/day" (capture-backed tools) versus "3/**UTC-day** hard cap" (capped
 *   tiers). §12 marks only the second as a calendar day and only the second
 *   as hard, so the first is read as a rolling 24 hours. The difference is
 *   visible to a customer — a rolling window frees capacity continuously, a
 *   UTC-day cap frees it all at midnight — so if the reference meant both to
 *   be calendar days, this is the line to correct.
 *
 *   `POST /portal/session` also carries "5 failed passwords → 15-min lock per
 *   token". That is a LOCK, not a bucket: it counts failures rather than
 *   requests and it is per share token rather than per identity. It belongs to
 *   the portal story that owns share tokens, and inventing a bucket shaped
 *   like it here would be a mechanism nobody asked for. Only the 10/hour IP
 *   bucket is encoded.
 */
export const RATE_LIMIT_DEFAULTS: RateLimitConfig = rateLimitConfigSchema.parse([
  {
    route_class: "auth",
    burst: 5,
    buckets: [
      { scope: "user", limit: 10, window: "rolling", window_ms: MINUTE_MS },
      { scope: "ip", limit: 30, window: "rolling", window_ms: MINUTE_MS },
    ],
  },
  {
    route_class: "reads",
    burst: 60,
    buckets: [
      { scope: "user", limit: 300, window: "rolling", window_ms: MINUTE_MS },
      { scope: "workspace", limit: 1_200, window: "rolling", window_ms: MINUTE_MS },
    ],
  },
  {
    route_class: "writes",
    burst: 20,
    buckets: [
      { scope: "user", limit: 60, window: "rolling", window_ms: MINUTE_MS },
      { scope: "workspace", limit: 240, window: "rolling", window_ms: MINUTE_MS },
    ],
  },
  {
    route_class: "capture_backed_tools",
    burst: 2,
    buckets: [
      { scope: "user", limit: 5, window: "rolling", window_ms: MINUTE_MS },
      { scope: "user", limit: 40, window: "rolling", window_ms: DAY_MS },
      { scope: "workspace", limit: 20, window: "rolling", window_ms: MINUTE_MS },
    ],
  },
  {
    route_class: "capture_backed_tools_capped_tiers",
    burst: 1,
    buckets: [
      { scope: "user", limit: 1, window: "rolling", window_ms: MINUTE_MS },
      // The one hard cap in the whole table. Not liftable by buying credits,
      // which is what separates `daily_limit_reached` from
      // `insufficient_credits` — two of the five conditions NFR-API-13
      // forbids collapsing.
      { scope: "user", limit: 3, window: "utc_day", hard_cap: true },
      { scope: "workspace", limit: 3, window: "rolling", window_ms: DAY_MS },
      { scope: "ip", limit: 10, window: "rolling", window_ms: HOUR_MS },
    ],
  },
  {
    route_class: "project_runs",
    burst: 2,
    buckets: [
      { scope: "user", limit: 6, window: "rolling", window_ms: HOUR_MS },
      { scope: "workspace", limit: 30, window: "rolling", window_ms: HOUR_MS },
    ],
  },
  {
    route_class: "project_aux_audits",
    burst: 3,
    buckets: [
      { scope: "user", limit: 10, window: "rolling", window_ms: HOUR_MS },
      { scope: "workspace", limit: 60, window: "rolling", window_ms: HOUR_MS },
    ],
  },
  {
    // Owner decision 71(d) - the free site-files mode of the STORY-082 AUX audit tool. It crawls only the well-known files and is cached per
    // host, so it is generous: 60/hour per user, 600/hour per workspace, burst 10. Not a §12 row; the full mode keeps project_aux_audits.
    route_class: "tool_site_files",
    burst: 10,
    buckets: [
      { scope: "user", limit: 60, window: "rolling", window_ms: HOUR_MS },
      { scope: "workspace", limit: 600, window: "rolling", window_ms: HOUR_MS },
    ],
  },
  {
    route_class: "geo_alignment",
    burst: 5,
    buckets: [
      { scope: "user", limit: 30, window: "rolling", window_ms: HOUR_MS },
      { scope: "workspace", limit: 120, window: "rolling", window_ms: HOUR_MS },
    ],
  },
  {
    route_class: "command_parse",
    burst: 30,
    buckets: [{ scope: "user", limit: 120, window: "rolling", window_ms: MINUTE_MS }],
  },
  {
    route_class: "command_execute",
    burst: 5,
    buckets: [
      { scope: "user", limit: 20, window: "rolling", window_ms: MINUTE_MS },
      { scope: "workspace", limit: 60, window: "rolling", window_ms: MINUTE_MS },
    ],
  },
  {
    route_class: "credit_pack_purchase",
    burst: 2,
    buckets: [
      { scope: "user", limit: 5, window: "rolling", window_ms: HOUR_MS },
      { scope: "workspace", limit: 10, window: "rolling", window_ms: HOUR_MS },
    ],
  },
  {
    // STORY-184 — the in-app plan change takes the credit-pack purchase's shape (owner decision 2026-10-16).
    route_class: "plan_change",
    // Burst 3 (owner decision 2026-10-16, loosened from the credit-pack shape's 2): change, cancel, change again is a
    // normal sequence. The hourly limits are still the credit-pack purchase's.
    burst: 3,
    buckets: [
      { scope: "user", limit: 5, window: "rolling", window_ms: HOUR_MS },
      { scope: "workspace", limit: 10, window: "rolling", window_ms: HOUR_MS },
    ],
  },
  {
    // STORY-184 - the preview calls Stripe but charges nothing, so it has a class of its own rather than sharing the
    // money-moving one (owner decision 2026-10-16): 30/hour per user, 60/hour per workspace (chosen here), burst 5.
    route_class: "plan_change_preview",
    burst: 5,
    buckets: [
      { scope: "user", limit: 30, window: "rolling", window_ms: HOUR_MS },
      { scope: "workspace", limit: 60, window: "rolling", window_ms: HOUR_MS },
    ],
  },
  {
    route_class: "portal_session",
    burst: 2,
    buckets: [{ scope: "ip", limit: 10, window: "rolling", window_ms: HOUR_MS }],
  },
  {
    route_class: "public_niche_reports",
    burst: 1,
    buckets: [{ scope: "ip", limit: 120, window: "rolling", window_ms: HOUR_MS }],
  },
]);
