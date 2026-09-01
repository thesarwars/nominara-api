import { z } from "zod";
import { ENTITLEMENT_KEYS } from "../../src/db/seed/plan-entitlements.js";
import { entitlementValueSchema } from "./plan-entitlements.schema.js";

// KAD-05: zod is the single contract source. This is `GET /billing/entitlements`
// (api-specification.md §"Billing, entitlements & credits"): "**Resolved**
// effective entitlements (plan + add-ons + overrides) with
// `entitlement_version`. The client renders every limit and gate from this one
// payload."
//
// "This one payload" is the load-bearing phrase, and it is why the response
// carries EVERY key rather than the handful a given screen needs. A client
// that has to ask a second question to render a limit will eventually answer
// it from a constant instead, which is exactly what STORY-069 AC10 forbids.

// ---------------------------------------------------------------------------
// Provenance — STORY-069 AC12
// ---------------------------------------------------------------------------
// AC12: "Enterprise-style overrides are applied and **surfaced**, so a
// non-standard limit is visible rather than mysterious."
//
// Surfacing needs two things, and one of them is easy to forget: WHERE the
// effective number came from, and WHAT the plan alone would have said. A
// payload carrying only `{"projects.max": 25}` for a Growth workspace is
// precisely the mystery the criterion names — 25 is not a Growth number, and
// nothing in the payload explains it. With `source: "override"` and
// `plan_value: 3` the interface can say "your plan includes 3; your agreement
// raises it to 25", which is the sentence a support conversation needs.
//
// The same applies to an add-on. `source: "add_on"` with `plan_value: 3` and
// `value: 4` is what makes a purchased project slot visible as a purchase
// rather than as an unexplained ceiling.
export const ENTITLEMENT_SOURCES = ["plan", "add_on", "override"] as const;

export const entitlementSourceSchema = z.enum(ENTITLEMENT_SOURCES);

export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

export const resolvedEntitlementSchema = z
  .object({
    value: entitlementValueSchema,
    live: z.boolean(),
    source: entitlementSourceSchema,
    // Always present, even when it equals `value`. An optional field would
    // make "the plan agrees" and "nobody recorded the plan's figure"
    // indistinguishable in the payload, and a client rendering the
    // comparison would have to guess which it was looking at.
    plan_value: entitlementValueSchema,
  })
  .strict();

const resolvedShape = Object.fromEntries(
  ENTITLEMENT_KEYS.map((key) => [key, resolvedEntitlementSchema]),
) as Record<(typeof ENTITLEMENT_KEYS)[number], typeof resolvedEntitlementSchema>;

export const resolvedEntitlementMapSchema = z.object(resolvedShape).strict();

export const resolvedEntitlementsResponseSchema = z
  .object({
    workspace_id: z.uuid(),
    plan_key: z.string().min(1),
    // §8: "The version bumps on any plan, add-on, or override change, which is
    // what makes the memoisation safe." It is in the payload so a client can
    // tell a refetch that changed nothing from one it has not yet received.
    entitlement_version: z.number().int().positive(),
    entitlements: resolvedEntitlementMapSchema,
  })
  .strict();

export type ResolvedEntitlement = z.infer<typeof resolvedEntitlementSchema>;
export type ResolvedEntitlementsResponse = z.infer<typeof resolvedEntitlementsResponseSchema>;

// ---------------------------------------------------------------------------
// workspaces.entitlement_overrides
// ---------------------------------------------------------------------------
// The other jsonb column in this story's blast radius, and it has no schema
// anywhere else. Same rule as `plans.entitlements` (coding-standards.md
// §"Contracts/validation rules": every jsonb column has a documented shape and
// a zod schema in contracts).
//
// STRICT, AND THAT IS THE POINT. An override is a hand-authored contract term
// typed by a human under time pressure. `{"project.max": 25}` — singular
// "project" — is a plausible typo that a permissive schema would accept and
// silently ignore, leaving an enterprise customer capped at their plan's 3
// projects with nothing anywhere saying why. AC12's "visible rather than
// mysterious" is unachievable if an unknown key can be dropped in silence, so
// an unrecognised key fails validation and resolution refuses loudly.
//
// Values are bare, NOT the `{value, live}` wrapper `plans.entitlements` uses.
// An override says what a workspace is entitled to; it does not decide whether
// a FEATURE EXISTS. `live` is a property of the build (§1 rule 5 — a deferred
// entitlement renders nowhere), so it stays sourced from the seed and no
// contract term can flip it.
const overrideShape = Object.fromEntries(
  ENTITLEMENT_KEYS.map((key) => [key, entitlementValueSchema.optional()]),
) as Record<(typeof ENTITLEMENT_KEYS)[number], z.ZodOptional<typeof entitlementValueSchema>>;

export const entitlementOverridesSchema = z.object(overrideShape).strict();

export type EntitlementOverrides = z.infer<typeof entitlementOverridesSchema>;
