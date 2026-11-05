import { Logger } from "@nestjs/common";
import type { AuxRuleFinding, CrawlManifest } from "../../../contracts/aux/index.js";
import type { AuxCatalog } from "./catalog.js";
import { buildAuxDocument, type AuxDocument } from "./document-model.js";
import { loadDocumentSnapshot, type ReadStoredObject } from "./document-snapshot.js";
import { findingFingerprint } from "./lifecycle.js";
import { byCodePoint } from "./rules/helpers.js";
import { AuxRuleEvaluationError, evaluateDocument } from "./rules/engine.js";
import { AUX_RULES } from "./rules/index.js";
import type { AuxRule } from "./rules/types.js";
import { cl100kTokenizer } from "./tokenizer-cl100k.js";

// STORY-051 AC13 - the page rule engine over a crawl's stored pages (aux-and-geo-analysis.md section 1, step 6, EVALUATE).
//
// loadDocumentSnapshot -> buildAuxDocument(cl100k) -> evaluateDocuments. PURE CPU over bytes the crawl already stored: no request, no
// clock, no database. `crawl.audit` calls it in the fetch phase, OUTSIDE any transaction, and hands the result to `commit`, which
// reconciles the findings inside its own short transaction (ADR-0003).

const logger = new Logger("aux-page-rules");

/** A rule that needs an input the page does not have is UNDECIDED on it, not passed: it stays out of `evaluated` and so out of `scope`. */
const NEEDS_RENDERED: readonly string[] = ["AUX-R-026", "AUX-R-027"];
const NEEDS_TIMING = "AUX-R-029";

/**
 * The engine's rules that could actually be DECIDED on this page. AUX-R-026 and 027 compare the rendered copy with the plain one, so a page with
 * no rendered copy (no renderer is installed; STORY-049 AC6) cannot decide them. AUX-R-029 is about the response, so a page the fetcher recorded no
 * timing for cannot decide it: null is "not measured", and a measured 0 ms is a measurement. A rule the engine does not run (AUX-R-013, held)
 * is never in this set.
 */
export function evaluablePageRules(doc: AuxDocument): ReadonlySet<string> {
  const decided = new Set<string>();
  for (const rule of AUX_RULES) {
    if (NEEDS_RENDERED.includes(rule.code) && doc.rendered === null) continue;
    if (rule.code === NEEDS_TIMING && doc.timing.ttfbMs === null && doc.timing.loadMs === null) continue;
    decided.add(rule.code);
  }
  return decided;
}

/**
 * Identity of a page finding: sha256 over rule, URL and WHERE (the locator) and WHY (the reason), the same recipe as a site-file finding with the
 * locator in the file's place. The snippet and the measured value are deliberately not part of it: they drift between audits of one
 * unchanged defect, and a drifting identity would resolve one finding and open another for the same problem.
 */
export function pageFindingFingerprint(f: Pick<AuxRuleFinding, "rule_code" | "url"> & { readonly evidence: { readonly reason: string; readonly locator: string; readonly [key: string]: unknown } }): string {
  return findingFingerprint(f.rule_code, f.url, { file: f.evidence.locator, reason: f.evidence.reason });
}

export interface PageRulesResult {
  /** Ordered by URL, then rule code, then locator (code-point order): the same stored audit always gives the same list. */
  readonly findings: AuxRuleFinding[];
  /** Per page that was modelled: the rules that could be decided on it. A page absent here was NOT looked at by the page rules. */
  readonly evaluated: Map<string, ReadonlySet<string>>;
  /** A stored page that could not be read back or modelled. Reason codes only; never the content or the error text. */
  readonly unmodelled: { readonly url: string; readonly reason: "snapshot_unreadable" | `rule_error:${string}` }[];
}

export async function runPageRules(
  pages: CrawlManifest["pages"],
  read: ReadStoredObject,
  catalog: AuxCatalog,
  ctx: { readonly projectId: string },
  /** The rules to run: the engine's own by default. Injectable so a test can make a rule crash on one page. */
  rules: readonly AuxRule[] = AUX_RULES,
): Promise<PageRulesResult> {
  const documents: AuxDocument[] = [];
  const unmodelled: PageRulesResult["unmodelled"] = [];
  for (const page of pages) {
    let document: AuxDocument | null;
    try {
      const snapshot = await loadDocumentSnapshot(page, read);
      document = snapshot === null ? null : buildAuxDocument(snapshot, cl100kTokenizer);
    } catch (error) {
      // The stored bytes did not match their hash, an object is missing, or the markup defeated the model. That page is not evidence about
      // the site, so it is reported and left out; the other pages are still audited.
      logger.warn({ event: "aux.page_rules.unmodelled", project_id: ctx.projectId, error: error instanceof Error ? error.name : "unknown" });
      unmodelled.push({ url: page.url, reason: "snapshot_unreadable" });
      continue;
    }
    // No stored plain copy, or a manifest from before the fetch record: nothing to model, and not a failure of this stage.
    if (document !== null) documents.push(document);
  }

  // A rule that cannot RUN (no catalog row, a threshold that does not parse) is a configuration fault: it fails the evaluation, and the job,
  // closed. It is never turned into "that page is fine". A rule that CRASHES on one page's markup (AuxRuleEvaluationError) is that page's problem, and a
  // deterministic one - every retry would fail the same way and the whole audit, onboarding and scheduled ones too, would never publish. So the page is
  // reported as unmodelled with the rule code (never the error text, never the content) and the audit ends partial.
  const evaluated = new Map<string, ReadonlySet<string>>();
  const findings: AuxRuleFinding[] = [];
  for (const document of documents) {
    try {
      findings.push(...(await evaluateDocument(document, catalog, rules, ctx)));
      evaluated.set(document.url, evaluablePageRules(document));
    } catch (error) {
      if (!(error instanceof AuxRuleEvaluationError)) throw error;
      logger.warn({ event: "aux.page_rules.rule_error", project_id: ctx.projectId, rule_code: error.ruleCode });
      unmodelled.push({ url: document.url, reason: `rule_error:${error.ruleCode}` });
    }
  }
  findings.sort((a, b) => byCodePoint(a.url, b.url) || byCodePoint(a.rule_code, b.rule_code) || byCodePoint(a.evidence.locator, b.evidence.locator));
  return { findings, evaluated, unmodelled };
}
