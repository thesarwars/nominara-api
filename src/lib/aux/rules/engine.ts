import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { AuxRuleFinding } from "../../../../contracts/aux/index.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import type { AuxCatalog } from "../catalog.js";
import type { AuxDocument } from "../document-model.js";
import { guidanceFor } from "../patches/guidance.js";
import { byCodePoint, clip } from "./helpers.js";
import type { AuxRule } from "./types.js";

// STORY-051 AC2, AC3, AC5, AC12, AC13 — the rule engine.
//
// PURE and DETERMINISTIC: the document model and the catalog go in, findings come out in a fixed order. There is no clock, no fetch,
// no model call, and no hidden state, so an audit is reproducible from its stored snapshot.
//
// THRESHOLDS ARE DATA. A rule is handed its row's `thresholds` from the loaded catalog and holds no number of its own; every
// finding records the row's `rule_version`. A rule with no catalog row, or a row whose thresholds do not parse, fails the page
// closed — an unknown number is never replaced by a default.

const logger = new Logger("aux-rule-engine");
const tracer = trace.getTracer("nominara-api");

export class AuxRuleConfigError extends Error {
  constructor(readonly ruleCode: string, reason: string) {
    super(`aux rule ${ruleCode} cannot run: ${reason}`);
    this.name = "AuxRuleConfigError";
  }
}

export class AuxRuleEvaluationError extends Error {
  constructor(readonly ruleCode: string, cause: unknown) {
    super(`aux rule ${ruleCode} failed while evaluating a page`, { cause });
    this.name = "AuxRuleEvaluationError";
  }
}


export interface EvaluateContext {
  readonly projectId: string;
}

async function runOne(rule: AuxRule, document: AuxDocument, catalog: AuxCatalog, ctx: EvaluateContext): Promise<AuxRuleFinding[]> {
  const row = catalog.byCode.get(rule.code);
  if (row === undefined) throw new AuxRuleConfigError(rule.code, "it has no catalog row");
  if (row.category !== rule.category) throw new AuxRuleConfigError(rule.code, "its catalog row is in a different category");
  if (row.autoFixable !== rule.autoFixable) throw new AuxRuleConfigError(rule.code, "its catalog row disagrees with the rule on auto-fixability");
  let hits;
  try {
    hits = rule.run(document, row.thresholds);
  } catch (e) {
    throw new AuxRuleEvaluationError(rule.code, e);
  }
  const guidance = rule.autoFixable ? null : guidanceFor(rule.code, { projectId: ctx.projectId, url: document.url });
  if (!rule.autoFixable && guidance === null) throw new AuxRuleConfigError(rule.code, "it is not auto-fixable and has no guidance");
  return hits.map((h) => ({
    rule_code: rule.code,
    rule_version: row.ruleVersion,
    severity: h.severity,
    measured_value: h.measured,
    threshold_value: h.threshold,
    url: document.url,
    evidence: { reason: h.reason, snippet: h.snippet === null ? null : clip(h.snippet), locator: h.locator },
    auto_fixable: rule.autoFixable,
    guidance,
  }));
}

/** Findings for one page. The rules are started together (the evaluators are synchronous, so this is not CPU parallelism); the result order is by rule code, then locator, never by completion. */
export async function evaluateDocument(
  document: AuxDocument,
  catalog: AuxCatalog,
  rules: readonly AuxRule[],
  ctx: EvaluateContext,
): Promise<AuxRuleFinding[]> {
  return tracer.startActiveSpan("aux.rules.evaluate", async (span) => {
    try {
      const batches = await Promise.all(rules.map((r) => runOne(r, document, catalog, ctx)));
      const findings = batches.flat().sort((a, b) => byCodePoint(a.rule_code, b.rule_code) || byCodePoint(a.evidence.locator, b.evidence.locator));
      for (const f of findings) incrementCounter("nominara_aux_rule_findings_total", { rule_code: f.rule_code, severity: f.severity });
      observeValue("nominara_aux_rules_evaluated_total", rules.length);
      span.setAttribute("nominara.aux.rules", rules.length);
      span.setAttribute("nominara.aux.findings", findings.length);
      // Counts and the project ID only: no URL, no page text, no workspace name.
      logger.debug({ event: "aux_rules_evaluated", project_id: ctx.projectId, rules: rules.length, findings: findings.length });
      return findings;
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Findings for many pages, concurrently per page (AC13). One page's findings never depend on another's. */
export async function evaluateDocuments(
  documents: readonly AuxDocument[],
  catalog: AuxCatalog,
  rules: readonly AuxRule[],
  ctx: EvaluateContext,
): Promise<AuxRuleFinding[][]> {
  return Promise.all(documents.map((d) => evaluateDocument(d, catalog, rules, ctx)));
}
