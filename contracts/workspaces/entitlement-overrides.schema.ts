import { z } from "zod";

// Validates workspaces.entitlement_overrides (schemas/identity-and-tenancy.md).
// plans-and-entitlements.md: "Applied after plan and add-on resolution.
// Surfaced in the UI and stamped into every export when it changes a scoring
// weight." An override is a partial map — only the keys a workspace actually
// overrides are present — so the key set is intentionally NOT pinned to
// ENTITLEMENT_KEYS the way plan-entitlements.schema.ts pins the full matrix:
// resolution logic (STORY-069) is what decides which overrides are legal
// against which plan, and this schema only needs to describe the column's
// storage shape, not enforce resolution-time rules.
const overrideValueSchema = z.union([z.number(), z.boolean(), z.string(), z.null()]);

export const entitlementOverridesSchema = z.record(z.string(), overrideValueSchema);

export type EntitlementOverrides = z.infer<typeof entitlementOverridesSchema>;
