import { z } from "zod";
import { escapeRegExp, variantOf } from "./helpers.js";
import { defineRule } from "./types.js";

// freshness — AUX-R-030. AUX-R-031 needs the audit date and the cited corpus's median dateModified, neither of which is in the
// document model (see AUX_RULES_NOT_EVALUATED).

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DATE = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}|${MONTH}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${MONTH}\\s+\\d{4})`;

export const dateModifiedAbsent = defineRule({
  code: "AUX-R-030",
  category: "freshness",
  autoFixable: true,
  thresholds: z.object({ visible_date_labels: z.array(z.string().min(1)).min(1) }).strict(),
  evaluate(doc, t) {
    if (doc.meta.dateModified !== undefined) return [];
    const labels = t.visible_date_labels.map(escapeRegExp).join("|");
    const visible = new RegExp(`\\b(?:${labels})\\s*(?:on|:|-)?\\s*(?:on\\s+)?${DATE}`, "iu");
    if (visible.test(variantOf(doc).mainText)) return [];
    return [{ severity: "medium", measured: 0, threshold: 1, reason: "no_date_modified", snippet: null, locator: "meta.dateModified" }];
  },
});
