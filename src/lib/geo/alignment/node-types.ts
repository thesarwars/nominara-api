import { CLAIM_BEARING_NODE_TYPES, type SemanticNodeType } from "../../../../contracts/analytics/index.js";

// STORY-059 AC5 / AC13 - "classify node_type via a deterministic keyword/pattern map". First match wins, in the order below; the
// order puts the types that make a CLAIM about the customer first, so a phrase that is both ("soc 2 integration") is the stricter.
// A phrase that matches nothing is a `capability`: it is what the page does, the least specific and the least risky.

const RULES: readonly { readonly type: SemanticNodeType; readonly pattern: RegExp }[] = [
  { type: "compliance", pattern: /\b(soc ?[123]|iso ?\d{4,5}|hipaa|gdpr|ccpa|pci|fedramp|compliance|compliant|certified|certification|attestation|data residency)\b/ },
  { type: "metric", pattern: /(\d+(\.\d+)?\s?%|\b\d+(\.\d+)?x\b|\buptime\b|\bsla\b|\blatency\b|\b\d+\s?(ms|seconds|minutes|hours)\b|\bfaster\b|\bavailability\b)/ },
  { type: "pricing_term", pattern: /(\bpricing\b|\bprice[sd]?\b|\bper (seat|user|month|year)\b|\bfree (trial|plan|tier)\b|\bsubscription\b|\bfreemium\b|\bpay as you go\b|\bdiscount\b|[$€£]\s?\d)/ },
  { type: "integration", pattern: /\b(integrat\w*|api|webhooks?|zapier|plugin|connector|sync(s|ed)? with|connects? to)\b/ },
  { type: "industry", pattern: /\b(healthcare|finance|financial|fintech|banking|insurance|retail|e-?commerce|saas|education|manufacturing|government|legal|logistics|real estate|telecom|pharma\w*)\b/ },
  { type: "persona", pattern: /\b(managers?|developers?|engineers?|admins?|administrators?|marketers?|analysts?|founders?|executives?|leaders?|ciso|cto|cmo|agencies|practitioners|buyers?|teams?)\b/ },
];

export function classifyNodeType(phrase: string): SemanticNodeType {
  const lowered = phrase.toLowerCase();
  for (const rule of RULES) if (rule.pattern.test(lowered)) return rule.type;
  return "capability";
}

export function requiresHumanReview(type: SemanticNodeType): boolean {
  return CLAIM_BEARING_NODE_TYPES.includes(type);
}

const WARNINGS: Partial<Record<SemanticNodeType, string>> = {
  compliance: "This is a compliance claim. Only add it if it is true of your product and you can show the attestation; a customer who publishes one they do not hold carries the risk.",
  metric: "This is a performance claim. Only add a figure that is true of your product and that you can substantiate; it is reproduced verbatim by engines more often than other text.",
  pricing_term: "This is a pricing claim. Only add terms that are true of your current offer; engines repeat prices and plan names as stated.",
};

/** The accuracy warning a claim-bearing node renders with; null for every other type. */
export function accuracyWarningFor(type: SemanticNodeType): string | null {
  return WARNINGS[type] ?? null;
}
