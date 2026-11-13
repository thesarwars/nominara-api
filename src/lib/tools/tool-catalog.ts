import {
  COMPETITOR_FINDER_CREDITS,
  TOOL_KEYS,
  VISIBILITY_SCAN_CREDITS,
  type ToolCatalogEntry,
  type ToolCatalogMode,
  type ToolCatalogResponse,
  type ToolKey,
} from "../../../contracts/tools/index.js";
import { AUX_AUDITS_ENTITLEMENT } from "../aux/onboarding-audit.js";
import { entitlementGranted } from "../entitlements/granted.js";

// STORY-078 AC23 - the tool catalog for a plan, as a pure function of the plan's resolved entitlements.
//
// WHICH ENTITLEMENT GATES WHICH TOOL IS DATA, NOT LOGIC (`TOOL_GATES`). plans-and-entitlements.md section 2 records that no entitlement key names a tool today, so
// no whole tool is gated: every tier's plan allows all six. The one real gate is the full AUX audit mode (`aux.scheduled_audits`, decision 47; the same key
// `requireAuxAudits` enforces on the route, so the catalog and the 403 cannot disagree). When a per-tool key is added to the plans reference, the entry goes in
// `tools` and the descriptor disables with no other change.
//
// A tool the plan lacks is a disabled descriptor naming the lowest plan that grants it, never a missing entry. Whether a plan grants an entitlement is `entitlementGranted` (fail closed:
// true, a number above 0, or a non-empty string other than "none" / "none_tools_only"), the one reading `auxAuditsIncluded`, the plan gate and the unlocking-plan SQL share.

export interface ToolGates {
  /** A whole tool gated on a boolean-or-quota entitlement key. */
  readonly tools: Partial<Readonly<Record<ToolKey, string>>>;
  /** A tool's separately gated modes, keyed by mode name. */
  readonly modes: Partial<Readonly<Record<ToolKey, Readonly<Record<string, string>>>>>;
}

export const TOOL_GATES: ToolGates = Object.freeze({
  tools: {},
  modes: { aux_audit: { full: AUX_AUDITS_ENTITLEMENT } },
});

export interface UnlockPlan {
  readonly key: string;
  readonly display_name: string;
}

type Entitlements = Readonly<Record<string, { readonly value: unknown } | undefined>>;

const granted = (entitlements: Entitlements, key: string): boolean => entitlementGranted(entitlements[key]?.value);

const PRICING: Readonly<Record<ToolKey, ToolCatalogEntry["pricing"]>> = {
  visibility_scan: { rate: "flat", credits: VISIBILITY_SCAN_CREDITS },
  competitor_finder: { rate: "flat", credits: COMPETITOR_FINDER_CREDITS },
  // Per prompt kept / per answer, at the plan's rate: not one figure, so the paired estimate carries it.
  prompt_research: { rate: "per_unit", credits: null },
  aux_audit: { rate: "per_page_band", credits: null },
  schema_builder: { rate: "free", credits: 0 },
  compare_runs: { rate: "free", credits: 0 },
};

/** The AUX audit's modes in display order; `credits` is the mode's own price (site files 0 on every plan, the full audit priced per page band). */
const MODES: Partial<Readonly<Record<ToolKey, readonly { readonly mode: string; readonly credits: number | null }[]>>> = {
  aux_audit: [
    { mode: "site_files", credits: 0 },
    { mode: "full", credits: null },
  ],
};

export function buildToolCatalog(input: { entitlements: Entitlements; gates: ToolGates; unlockers: ReadonlyMap<string, UnlockPlan> }): ToolCatalogResponse {
  const { entitlements, gates, unlockers } = input;
  const gate = (key: string | undefined): { enabled: boolean; unlocked_by_plan: UnlockPlan | null } => {
    if (key === undefined || granted(entitlements, key)) return { enabled: true, unlocked_by_plan: null };
    return { enabled: false, unlocked_by_plan: unlockers.get(key) ?? null };
  };
  const tools = TOOL_KEYS.map((tool_key): ToolCatalogEntry => {
    const modeGates = gates.modes[tool_key] ?? {};
    const modes = (MODES[tool_key] ?? []).map((m): ToolCatalogMode => ({ mode: m.mode, credits: m.credits, ...gate(modeGates[m.mode]) }));
    return { tool_key, pricing: PRICING[tool_key], ...gate(gates.tools[tool_key]), modes };
  });
  return { tools };
}

/** Every entitlement key the catalog gates on, so the caller can look each one's lowest unlocking plan up once. */
export function gatedEntitlementKeys(gates: ToolGates): string[] {
  const keys = new Set<string>(Object.values(gates.tools).filter((k): k is string => k !== undefined));
  for (const byMode of Object.values(gates.modes)) for (const key of Object.values(byMode ?? {})) keys.add(key);
  return [...keys];
}
