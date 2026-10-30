import { cl100kTokenizer } from "./tokenizer-cl100k.js";
import { tokenizerLabel } from "./tokenizer.js";

// One place for what an `aux_audits` row records about how it was made, so the producer of a queued audit (POST /projects/{id}/aux-audits) and the
// `crawl.audit` handler that finishes it can never disagree.

/** The audit-level rule version. (Each page-rule finding also records its own catalog row's version.) */
export const AUX_AUDIT_RULE_VERSION = "2026.10.1";

/** STORY-050 AC3: the tokenizer the audit's token-count thresholds are measured with (the embedding model's own), so a change is visible. */
export const AUX_AUDIT_TOKENIZER = tokenizerLabel(cl100kTokenizer.identity);
