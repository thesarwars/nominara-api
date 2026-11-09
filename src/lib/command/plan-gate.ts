import type { CommandIntent } from "../../../contracts/command/command-intent.schema.js";
import {
  isFeatureGranted,
  structuralLimitFrom,
  wouldExceed,
  type FeatureFlagKey,
  type StructuralLimitKey,
} from "../entitlements/classification.js";

// STORY-085 / FR-CMD-05 - which entitlement gates each command-bar intent, in ONE table. An action the caller's plan cannot complete is returned
// DISABLED with the reason, not offered and then refused on the screen it opens.
//
// The classification is the underlying route's own (classification.ts): a structural limit is `entitlement_exceeded` (a slot or seat to add or an
// upgrade), a feature flag is `feature_not_in_plan` (an upgrade only). `projects.max` at 0 is the first kind, `exports.pdf_per_cycle` at 0 the second.
// An intent absent from the table has no plan gate. A key the resolved plan does not carry at all is not a refusal here: the parse only informs, and the
// route the action reaches is the authority that enforces (and fails closed).

export type IntentGate =
  | { readonly kind: "structural"; readonly key: StructuralLimitKey }
  | { readonly kind: "feature"; readonly key: FeatureFlagKey };

export const INTENT_GATES: Readonly<Partial<Record<CommandIntent, IntentGate>>> = {
  create_project: { kind: "structural", key: "projects.max" },
  invite_member: { kind: "structural", key: "seats.max" },
  build_report: { kind: "feature", key: "exports.pdf_per_cycle" },
};

/** The structural key whose current count the caller must supply for `intent`, or null when the gate needs no count. */
export function structuralKeyFor(intent: CommandIntent): StructuralLimitKey | null {
  const gate = INTENT_GATES[intent];
  return gate?.kind === "structural" ? gate.key : null;
}

/** `feature_not_in_plan:<key>` or `entitlement_exceeded:<key>` when the plan cannot complete `intent`; null when it can (or the intent has no gate). */
export function planGateReason(
  intent: CommandIntent,
  entitlements: Readonly<Record<string, { readonly value: unknown }>>,
  current: number,
): string | null {
  const gate = INTENT_GATES[intent];
  if (gate === undefined) return null;
  const entry = entitlements[gate.key];
  if (entry === undefined) return null;
  const value = entry.value as Parameters<typeof isFeatureGranted>[0];
  if (gate.kind === "feature") return isFeatureGranted(value) ? null : `feature_not_in_plan:${gate.key}`;
  const limit = structuralLimitFrom(value);
  return limit !== undefined && wouldExceed(limit, current) ? `entitlement_exceeded:${gate.key}` : null;
}
