import type { z } from "zod";
import type { AuxDocument } from "../document-model.js";

// STORY-051 — what a rule is. A rule is a PURE function of the document model (STORY-050) and its catalog thresholds: no fetch, no
// clock, no randomness, no model call (AC2). A rule that needs more than the document model is a specification gap, not a reason to
// reach for it — those rules are listed in `AUX_RULES_NOT_EVALUATED` (index.ts), never silently passed.

export type RuleSeverity = "critical" | "high" | "medium" | "low" | "info";

/** One thing a rule found on one page. The engine adds the rule code, version, URL and guidance. */
export interface RuleHit {
  readonly severity: RuleSeverity;
  /** null = nothing was measured; 0 = measured zero. */
  readonly measured: number | null;
  readonly threshold: number | null;
  readonly reason: string;
  readonly snippet: string | null;
  readonly locator: string;
}

export interface RuleDefinition<T> {
  readonly code: string;
  readonly category: string;
  /** AC12: every rule declares it. A rule that is not auto-fixable carries guidance instead of a patch. */
  readonly autoFixable: boolean;
  /** The shape of this rule's `aux_rule_catalog.thresholds`. `.strict()`, so a mistyped key in the data fails the load. */
  readonly thresholds: z.ZodType<T>;
  evaluate(document: AuxDocument, thresholds: T): readonly RuleHit[];
}

export interface AuxRule {
  readonly code: string;
  readonly category: string;
  readonly autoFixable: boolean;
  /** Parses the catalog's thresholds (throws on a bad shape), then evaluates. */
  run(document: AuxDocument, catalogThresholds: unknown): readonly RuleHit[];
}

export function defineRule<T>(def: RuleDefinition<T>): AuxRule {
  return {
    code: def.code,
    category: def.category,
    autoFixable: def.autoFixable,
    run: (document, catalogThresholds) => def.evaluate(document, def.thresholds.parse(catalogThresholds)),
  };
}
