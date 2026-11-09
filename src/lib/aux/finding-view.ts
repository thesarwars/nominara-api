import type { AuxFinding } from "../../../contracts/aux/index.js";

// STORY-082 AC8 - the ONE place a finding is shaped for a customer, so the tool and the project's findings list can never word a finding differently.
// It leads with the AI consequence (the catalog's rationale, in customer language), then the rule's title; the rule code is a reference, not the headline.
// `toFinding` in the AUX service and the AUX audit tool both build their finding through this function.

export type FindingViewFields = Pick<
  AuxFinding,
  "consequence" | "title" | "rule_code" | "category" | "severity" | "url" | "affected_pages" | "measured_value" | "threshold_value" | "evidence" | "auto_fixable" | "requires_human_review"
>;

export function findingView(input: FindingViewFields): FindingViewFields {
  // Key order is the order a reader meets the fields: consequence first.
  return {
    consequence: input.consequence,
    title: input.title,
    rule_code: input.rule_code,
    category: input.category,
    severity: input.severity,
    url: input.url,
    affected_pages: input.affected_pages,
    measured_value: input.measured_value,
    threshold_value: input.threshold_value,
    evidence: input.evidence,
    auto_fixable: input.auto_fixable,
    requires_human_review: input.requires_human_review,
  };
}
