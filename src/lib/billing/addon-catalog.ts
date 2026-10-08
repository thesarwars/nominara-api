import type { AddonGrant } from "../../../contracts/billing/addon.schema.js";
import type { Entitlement } from "../../db/seed/plan-entitlements.js";
import { addonContributions, type AddonKind } from "../entitlements/resolution.js";

// STORY-076b — what the two subscription add-ons are, what they cost, and what
// ONE unit of each grants.

export interface AddonCatalogEntry {
  readonly displayName: string;
  /** `numeric(12,2)` text, never a float. Owner decision (2026-10-07): $49 and $15, priced inline in Stripe. */
  readonly monthlyUsd: string;
  /** The plan flag that makes the add-on purchasable (`plans.entitlements`); the tier that first grants it is read from `plans`, never named here. */
  readonly allowedKey: "projects.addon_allowed" | "seats.addon_allowed";
}

export const ADDON_CATALOG: Readonly<Record<AddonKind, AddonCatalogEntry>> = {
  extra_project: { displayName: "Extra project", monthlyUsd: "49.00", allowedKey: "projects.addon_allowed" },
  extra_seat: { displayName: "Extra seat", monthlyUsd: "15.00", allowedKey: "seats.addon_allowed" },
};

function delta(plan: Readonly<Record<string, Entitlement>>, contributions: Readonly<Record<string, unknown>>, key: string): number {
  const base = plan[key]?.value;
  const contributed = contributions[key];
  return typeof base === "number" && typeof contributed === "number" ? contributed - base : 0;
}

/**
 * STORY-076 AC11 — what one unit grants on `plan`, DERIVED from the resolver's
 * own `addonContributions` so the statement on the purchase control and the
 * resolved entitlements are the same arithmetic and cannot disagree. A ceiling
 * that is not a number (enterprise's "custom") grants nothing here, exactly as
 * the resolver treats it.
 */
export function addonGrant(plan: Readonly<Record<string, Entitlement>>, kind: AddonKind): AddonGrant {
  const contributions = addonContributions(plan, { [kind]: 1 });
  const projects = delta(plan, contributions, "projects.max");
  const promptSlots = delta(plan, contributions, "prompts.max_total");
  const seats = delta(plan, contributions, "seats.max");

  const parts: string[] = [];
  if (projects > 0) parts.push(`${String(projects)} project${projects === 1 ? "" : "s"}`);
  if (promptSlots > 0) parts.push(`${String(promptSlots)} prompt slot${promptSlots === 1 ? "" : "s"}`);
  if (seats > 0) parts.push(`${String(seats)} seat${seats === 1 ? "" : "s"}`);
  const statement = parts.length === 0 ? "Adds no capacity on this plan" : `Each adds ${parts.join(" and ")}`;
  return { projects, prompt_slots: promptSlots, seats, statement };
}
