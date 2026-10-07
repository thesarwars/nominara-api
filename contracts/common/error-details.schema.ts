import { z } from "zod";
import { idempotencyConflictDetailsSchema } from "./idempotency.schema.js";
import type { ErrorCode } from "./error-code.schema.js";
import { MONEY_AMOUNT_USD_PATTERN } from "./money.schema.js";

// STORY-024 T7 — api-specification.md §2's per-code `error.details` shapes,
// in full. STORY-023 left `problemErrorSchema.details` an open record and
// said why: §2 gives each code its OWN shape, not every code has one, and
// modelling them there would have invented shapes the reference had not
// committed to. This file is that work, and it models ONLY what §2 (and
// plans-and-entitlements.md §9, which agrees with it) actually states.
//
// Codes with NO details shape here, deliberately, because the reference
// commits to none: `unauthenticated`, `token_expired`, `token_revoked`,
// `not_found`, `idempotency_conflict`, `workspace_mismatch`,
// `project_out_of_scope`, `domain_not_verified`, `capture_mode_unavailable`,
// `degraded`, and `retention_exceeded`.
//
// `quota_exceeded` WAS in that list and no longer is. STORY-024's rule was to
// model only what §2 states, and §2 states nothing for it — but STORY-070 AC6
// does: "Exhaustion returns the quota failure with the metric, the limit, and
// the reset time." A story asking for a shape is not the same as inventing
// one, and `NFR-API-13` needs "wait for the cycle" to be actionable, which it
// is not without saying when the cycle ends. See the 429 section.
// `precondition_unmet` WAS ALSO IN THAT LIST and no longer is, for the same
// reason and by the same precedent. §2 illustrates it with "e.g. a patch whose
// `content_before_hash` no longer matches" — an example, not a committed shape,
// and "e.g." is not something to freeze into a published client. But STORY-034
// then made ONE endpoint (`POST /projects/{id}/runs`) refuse for two different
// reasons under that single code — an enterprise workspace whose negotiated
// deep-scan price was never written down, and a scope with nothing to capture —
// and the remedies do not overlap (tell the operator to finish setup, versus
// add prompts or wait for an engine that can capture). A client that can only
// read the `message` string would have to pattern-match prose to choose
// between them, and prose is not a contract. So the shape is exactly ONE
// member, `reason`, naming the check that refused — and it is OPTIONAL, because
// the other `precondition_unmet` sites (a missing `If-Match`, prompt
// generation not yet available, a result with no parsed document) belong to
// other stories, commit no reason, and must keep compiling untouched; a client
// treats an absent `reason` as "unclassified". A later story that classifies
// one of those adds its value to PRECONDITION_UNMET_REASONS here first.

// ---------------------------------------------------------------------------
// Remediation (decision D11)
// ---------------------------------------------------------------------------
// `NFR-API-13`: the five spend-and-limit conditions "are five distinct,
// non-overlapping conditions… Conflating any two is a specification
// violation, not a cosmetic issue." §2 commits to exactly ONE remediation
// kind by name — `purchase_credits`, in its worked example — so the other
// four names are decision D11, each taken from the reference's own wording
// for that code rather than invented freely:
//
//   purchase_credits      402 insufficient_credits   §2's example, verbatim
//   increase_limit        403 entitlement_exceeded   §2 "upgrade/add-on remediation"
//   upgrade_plan          403 feature_not_in_plan    §2 `details.min_plan`
//   wait_for_cycle        429 quota_exceeded         plans §9 "upgrade versus wait"
//   wait_for_daily_reset  429 daily_limit_reached    §2 `details.resets_at`
//
// These five are NOT collapsed into one closed enum replacing
// `problemRemediationSchema`. That schema stays open, because a remediation
// for some other code is not yet specified anywhere and closing the union
// now would forbid it. What NFR-API-13 needs is that these five are
// pairwise distinct, which literal `kind`s give exactly.
//
// `url` is the client-navigable path from §2's example
// ("/settings/billing?pack=agency_vault"). Optional: only that one example
// carries it, so requiring it everywhere would be an invention.
function remediation<K extends string>(kind: K) {
  return z
    .object({
      kind: z.literal(kind),
      url: z.string().min(1).optional(),
    })
    .strict();
}

export const purchaseCreditsRemediationSchema = remediation("purchase_credits");
export const increaseLimitRemediationSchema = remediation("increase_limit");
export const upgradePlanRemediationSchema = remediation("upgrade_plan");
export const waitForCycleRemediationSchema = remediation("wait_for_cycle");
export const waitForDailyResetRemediationSchema = remediation("wait_for_daily_reset");

/** The five `NFR-API-13` kinds, in §2's own order. Pairwise distinct by construction. */
export const SPEND_AND_LIMIT_REMEDIATION_KINDS = [
  "purchase_credits",
  "increase_limit",
  "upgrade_plan",
  "wait_for_cycle",
  "wait_for_daily_reset",
] as const;

export type SpendAndLimitRemediationKind = (typeof SPEND_AND_LIMIT_REMEDIATION_KINDS)[number];

// ---------------------------------------------------------------------------
// 400
// ---------------------------------------------------------------------------
// §2: "zod failure; `details.issues[]` carries path and message". `path` is
// an ARRAY, not a dotted string: a zod issue path is a sequence of keys and
// ARRAY INDICES, and flattening `["prompts", 3, "text"]` to "prompts.3.text"
// makes an index indistinguishable from a key literally named "3" — which
// matters to a form that has to highlight the right field.
export const validationIssueSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number().int()])),
    message: z.string().min(1),
  })
  .strict();

export const validationFailedDetailsSchema = z
  .object({
    issues: z.array(validationIssueSchema).min(1),
  })
  .strict();

// §2: "`engine_key` not in the workspace's entitlement, or `engines.status='disabled'`"
export const unsupportedEngineDetailsSchema = z.object({ engine_key: z.string().min(1) }).strict();

// ---------------------------------------------------------------------------
// 401
// ---------------------------------------------------------------------------
// §2: "Privileged action; `details.methods` lists acceptable re-auth methods".
// The method names themselves are NOT enumerated anywhere in the reference,
// so this stays an array of strings rather than a closed union invented here.
export const stepUpRequiredDetailsSchema = z
  .object({
    methods: z.array(z.string().min(1)).min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// 402 — the wallet split and the purchasable packs
// ---------------------------------------------------------------------------
// Field-for-field from §2's worked example. `cycle_end` is a DATE, not a
// timestamp: `credit_wallets.cycle_end` is a `date` column
// (schemas/billing-and-credits.md:85) and §2 prints "2026-09-01", so
// `z.iso.date()` is the honest type — `z.iso.datetime()` would demand a time
// component the column cannot supply.
export const creditWalletSummarySchema = z
  .object({
    included_balance: z.number().int().nonnegative(),
    purchased_balance: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    cycle_end: z.iso.date(),
  })
  .strict();

// `price_usd` is a bare 2-decimal STRING, not `moneySchema`'s
// `{amount_usd, currency}` object — decision D10, matching §2's printed body
// exactly ("price_usd": "15.00"). The `_usd` suffix already carries the
// currency here. The pattern is shared with money.schema.ts so the decimal
// shape has one definition even though the wrapper differs.
export const creditPackSchema = z
  .object({
    key: z.string().min(1),
    credits: z.number().int().positive(),
    price_usd: z.string().regex(MONEY_AMOUNT_USD_PATTERN),
  })
  .strict();

export const insufficientCreditsDetailsSchema = z
  .object({
    required: z.number().int().positive(),
    available: z.number().int().nonnegative(),
    wallet: creditWalletSummarySchema,
    packs: z.array(creditPackSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// 403
// ---------------------------------------------------------------------------
// §2: "`details.required_permission` names the missing permission"
export const forbiddenDetailsSchema = z.object({ required_permission: z.string().min(1) }).strict();

// §2 + plans §9: a STRUCTURAL limit — `details.{key, limit, current}`.
// `current` is what the caller has now; it can legitimately EXCEED `limit`
// after a downgrade, so neither bound is expressed in terms of the other.
export const entitlementExceededDetailsSchema = z
  .object({
    key: z.string().min(1),
    limit: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
  })
  .strict();

// §2 + plans §9: a FEATURE FLAG is absent — `details.{key, min_plan}`.
export const featureNotInPlanDetailsSchema = z
  .object({
    key: z.string().min(1),
    min_plan: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// 409
// ---------------------------------------------------------------------------
// §2: "`If-Match` mismatch, unique violation, or state-machine violation
// (`details.current_state`)" — three conditions under one code, and only the
// third carries a state, hence optional.
export const conflictDetailsSchema = z.object({ current_state: z.string().min(1).optional() }).strict();

// §2: "A user may own only one workspace. `details.{owned_workspace_id,
// owned_workspace_name}` plus the transfer path." The NAME is included on
// purpose and is not a §7 violation: §7 forbids a workspace name in a LOG
// LINE, where it becomes customer data in an operator's tooling. This is a
// response body sent to the one user who owns that workspace and already
// knows its name — without it the client can only say "you already own a
// workspace" without saying which.
export const workspaceLimitReachedDetailsSchema = z
  .object({
    owned_workspace_id: z.uuid(),
    owned_workspace_name: z.string().min(1),
  })
  .strict();

// §2: "`X-Nominara-Confirmed-Credits` does not match the server's current
// price. `details.{shown, recomputed, reason}`; the client re-presents the
// modal." Both figures are CREDIT counts (integers), not money.
export const priceChangedDetailsSchema = z
  .object({
    shown: z.number().int().nonnegative(),
    recomputed: z.number().int().nonnegative(),
    reason: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// 422
// ---------------------------------------------------------------------------
// §2: "`details.reason` names the check that refused it, **never the
// resolved address**". The prohibition is the point of this shape: a
// resolved internal address echoed back to the caller is an SSRF
// reconnaissance oracle. One field, and it names a CHECK.
export const unsafeTargetDetailsSchema = z.object({ reason: z.string().min(1) }).strict();

// STORY-034 — `precondition_unmet`'s one member. See the header for why it
// exists and why it is optional. Each value names the CHECK that refused, in
// the way `unsafeTargetDetailsSchema.reason` does, never a resolved value:
//
//   price_not_agreed      the plan's deep-scan price resolves to something that
//                         is not a credit figure (enterprise, `"negotiated"`,
//                         no workspace override written) — an operator's
//                         unfinished setup, not the customer's doing
//   no_capturable_scope   the scan would plan zero cells: no engine this
//                         project is entitled to can capture yet, or it has no
//                         active prompts — nothing was started, nothing charged
export const PRECONDITION_UNMET_REASONS = ["price_not_agreed", "no_capturable_scope"] as const;

export const preconditionUnmetDetailsSchema = z
  .object({ reason: z.enum(PRECONDITION_UNMET_REASONS).optional() })
  .strict();

// ---------------------------------------------------------------------------
// 429
// ---------------------------------------------------------------------------
// §2: "`details.retry_after_ms`; `Retry-After` set" — `NFR-API-05`'s
// integer-milliseconds duration with the `_ms` suffix.
export const rateLimitedDetailsSchema = z.object({ retry_after_ms: z.number().int().nonnegative() }).strict();

// §2: "`details.{action_code, used, limit, resets_at}`. Debits nothing, and
// is not liftable by buying credits." plans §9 and `FR-CRD-14` name
// `details.resets_at` specifically; §2 is the wider shape and wins for the
// wire. `resets_at` is the next UTC midnight (plans-and-entitlements.md:189)
// — a real instant, so a timestamp rather than a date.
export const dailyLimitReachedDetailsSchema = z
  .object({
    action_code: z.string().min(1),
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    resets_at: z.iso.datetime(),
  })
  .strict();

// STORY-070 AC6 — "Exhaustion returns the quota failure with the metric, the
// limit, and the reset time." Deliberately parallel to
// `dailyLimitReachedDetailsSchema` above: the two are §9's third and fourth
// enforcement mechanisms, and a client that can render one should not have to
// learn a second shape to render the other.
//
// `resets_at` is a DATE, not a timestamp, and the difference is not cosmetic.
// A daily cap resets at the next UTC midnight — a real instant. A tier cap
// resets when the BILLING CYCLE rolls, and the cycle is bounded by
// `credit_wallets.cycle_end` / `subscriptions.current_period_end`, both of
// which this system holds as dates. `z.iso.datetime()` would demand a time
// component nothing can supply, so it would be filled with a fabricated
// midnight.
//
// `limit` IS OPTIONAL, AND THAT IS AC10. `FR-CRD-19`: the fair-use ceiling
// "is not published — a limit nobody hits adds a dimension and reduces trust
// at the same time". A 429 carrying `limit: 6000` publishes it to precisely
// the customer who was about to ask what it is. So the figure is withheld for
// the unpublished metrics and present for the rest, while the metric and the
// reset date — the two things a customer needs to act — are always there.
export const quotaExceededDetailsSchema = z
  .object({
    metric: z.string().min(1),
    limit: z.number().int().nonnegative().optional(),
    resets_at: z.iso.date(),
  })
  .strict();

// NOTE — `quota_exceeded` has NO details schema, and that is a finding, not
// an omission. It is the ONE spend-and-limit code the reference gives no
// `details` for: §2's row says only "A non-credit tier cap is exhausted",
// and plans §9's table shows `429 quota_exceeded` with no `+ details.{…}`
// while the four rows around it all have one. Its `NFR-API-13` distinctness
// therefore rests on `error.code` plus the `wait_for_cycle` remediation, not
// on a details shape. Inventing `{key, limit, used, resets_at}` here would
// look consistent and would be a shape no reference committed to.

// ---------------------------------------------------------------------------
// 502
// ---------------------------------------------------------------------------
// §2: "Upstream circuit open; `details.circuit_opened_at`"
export const engineUnavailableDetailsSchema = z.object({ circuit_opened_at: z.iso.datetime() }).strict();

// ---------------------------------------------------------------------------
// The code → details binding
// ---------------------------------------------------------------------------
// A map, not a discriminated union folded into `problemDetailsSchema`.
// Binding `error.code` to `error.details` as a 28-member union belongs with
// the change that first puts error RESPONSES into the OpenAPI document
// (T9/T10) — today `buildOperation()` emits success statuses only, so a
// union here would be a contract nothing serves yet. This map is what T9's
// typed domain errors validate their own payloads against, and it is
// exhaustive over the codes that HAVE a shape, so a new code with a details
// shape cannot be added without appearing here.
export const errorDetailsSchemaByCode = {
  validation_failed: validationFailedDetailsSchema,
  unsupported_engine: unsupportedEngineDetailsSchema,
  step_up_required: stepUpRequiredDetailsSchema,
  insufficient_credits: insufficientCreditsDetailsSchema,
  forbidden: forbiddenDetailsSchema,
  entitlement_exceeded: entitlementExceededDetailsSchema,
  feature_not_in_plan: featureNotInPlanDetailsSchema,
  quota_exceeded: quotaExceededDetailsSchema,
  conflict: conflictDetailsSchema,
  idempotency_conflict: idempotencyConflictDetailsSchema,
  workspace_limit_reached: workspaceLimitReachedDetailsSchema,
  price_changed: priceChangedDetailsSchema,
  precondition_unmet: preconditionUnmetDetailsSchema,
  unsafe_target: unsafeTargetDetailsSchema,
  rate_limited: rateLimitedDetailsSchema,
  daily_limit_reached: dailyLimitReachedDetailsSchema,
  engine_unavailable: engineUnavailableDetailsSchema,
} as const;

export type ErrorDetailsSchemaByCode = typeof errorDetailsSchemaByCode;
export type ErrorCodeWithDetails = keyof ErrorDetailsSchemaByCode;

// Compile-time guard: every key of the map above must be a real §2 code, so a
// typo — or a code deleted from the taxonomy — is a typecheck failure here
// rather than a details shape bound to a code that does not exist.
//
// This is deliberately NOT `as const satisfies Partial<Record<ErrorCode,
// ZodType>>`. That reads like it does this job and does not: verified by
// injecting a bogus key, which `tsc --noEmit` accepted without complaint
// because `as const` strips the literal's freshness and excess-property
// checking with it. The conditional below has no such hole — when a key is
// not a code, `_KeysAreErrorCodes` resolves to a tuple and the assignment
// fails, naming the offending key in the error.
type _KeysAreErrorCodes =
  Exclude<ErrorCodeWithDetails, ErrorCode> extends never
    ? true
    : ["not a member of errorCodeSchema:", Exclude<ErrorCodeWithDetails, ErrorCode>];
const _keysAreErrorCodes: _KeysAreErrorCodes = true;

export type ValidationIssue = z.infer<typeof validationIssueSchema>;
export type ValidationFailedDetails = z.infer<typeof validationFailedDetailsSchema>;
export type UnsupportedEngineDetails = z.infer<typeof unsupportedEngineDetailsSchema>;
export type StepUpRequiredDetails = z.infer<typeof stepUpRequiredDetailsSchema>;
export type CreditWalletSummary = z.infer<typeof creditWalletSummarySchema>;
export type CreditPack = z.infer<typeof creditPackSchema>;
export type InsufficientCreditsDetails = z.infer<typeof insufficientCreditsDetailsSchema>;
export type ForbiddenDetails = z.infer<typeof forbiddenDetailsSchema>;
export type EntitlementExceededDetails = z.infer<typeof entitlementExceededDetailsSchema>;
export type FeatureNotInPlanDetails = z.infer<typeof featureNotInPlanDetailsSchema>;
export type QuotaExceededDetails = z.infer<typeof quotaExceededDetailsSchema>;
export type ConflictDetails = z.infer<typeof conflictDetailsSchema>;
export type WorkspaceLimitReachedDetails = z.infer<typeof workspaceLimitReachedDetailsSchema>;
export type PriceChangedDetails = z.infer<typeof priceChangedDetailsSchema>;
export type PreconditionUnmetReason = (typeof PRECONDITION_UNMET_REASONS)[number];
export type PreconditionUnmetDetails = z.infer<typeof preconditionUnmetDetailsSchema>;
export type UnsafeTargetDetails = z.infer<typeof unsafeTargetDetailsSchema>;
export type RateLimitedDetails = z.infer<typeof rateLimitedDetailsSchema>;
export type DailyLimitReachedDetails = z.infer<typeof dailyLimitReachedDetailsSchema>;
export type EngineUnavailableDetails = z.infer<typeof engineUnavailableDetailsSchema>;
