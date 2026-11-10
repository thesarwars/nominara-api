import { parse, type DefaultTreeAdapterMap } from "parse5";
import {
  SCHEMA_BUILDER_MAX_FINDINGS,
  SCHEMA_BUILDER_RULE_CODES,
  type SchemaBuilderFinding,
  type SchemaBuilderUrlResult,
} from "../../../contracts/tools/index.js";
import { loadAuxCatalog } from "../aux/catalog.js";
import { buildAuxDocument } from "../aux/document-model.js";
import { evaluateDocument } from "../aux/rules/engine.js";
import { AUX_RULES } from "../aux/rules/index.js";
import { cl100kTokenizer } from "../aux/tokenizer-cl100k.js";
import { GuardedFetchRefusal, guardedFetch, type GuardedFetchInit, type GuardedResponse } from "../net/guarded-fetch.js";
import { NOMINARA_USER_AGENT } from "../net/user-agent.js";
import type { ToolCatalogRow } from "./aux-audit-run.js";

// STORY-083 AC5 / owner decision 82 - Schema Builder URL mode, the worker's computing half: ONE page, fetched through the guarded fetcher, judged by the SAME
// structured-data rules the in-project audit runs (the engine's own `AUX_RULES`, narrowed to the codes the Schema Builder accepts: AUX-R-008..018 without the held
// AUX-R-013). There is no second rule implementation and no second fetch path: the only way out is `guardedFetch` (imported here, injectable for a test).
//
// PURE APART FROM THE FETCH. No database, no clock, no queue. The caller (the `lookup.execute` handler) runs this OUTSIDE any transaction (ADR-0003).
//
// WHAT IT NEVER DOES: store page text. A finding is the rule code, its severity, the catalog's consequence, and a property path - never a snippet or a value.
// A page that could not be read is `unreachable` with a short reason and no finding: "could not look" is never "found nothing wrong".

/** The longest the worker waits for the page. Shorter than the guarded fetcher's own ceiling, like the in-project audit tool's per-request bound. */
export const SCHEMA_BUILDER_URL_FETCH_TIMEOUT_MS = 10_000;

export interface UrlCheckDeps {
  readonly fetch?: (url: string, init?: GuardedFetchInit) => Promise<GuardedResponse>;
  readonly timeoutMs?: number;
}

export type UrlCheckOutcome =
  | { readonly kind: "checked"; readonly result: Extract<SchemaBuilderUrlResult, { state: "checked" }> }
  | { readonly kind: "unreachable"; readonly reason: Extract<SchemaBuilderUrlResult, { state: "unreachable" }>["reason"] };

const RULE_CODES: ReadonlySet<string> = new Set(SCHEMA_BUILDER_RULE_CODES);
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;
const FIELD_RE = /^[A-Za-z@][A-Za-z0-9@_.]{0,79}$/;

/** A JSON-LD locator (`raw.jsonld[0].offers`, `jsonld[1].hasVariant[0].offers`) as a property path (`offers`, `hasVariant.offers`); `null` when it names no property. */
function fieldOf(locator: string): string | null {
  const m = /^(?:(?:raw|rendered)\.)?jsonld\[\d+\]\.(.+)$/.exec(locator.replace(/@\d+$/, ""));
  if (m === null) return null;
  const path = m[1]!.replace(/\[\d+\]/g, "");
  return FIELD_RE.test(path) ? path : null;
}

type Node = DefaultTreeAdapterMap["node"];

/**
 * Where a JSON-LD parse error sits IN THE PAGE. The rule's locator carries `@<offset>`, and that offset is relative to the BLOCK: it is V8's `position` in the
 * UNTRIMMED text `JSON.parse` was given (UTF-16 units, line breaks normalised by the HTML tokenizer), not an offset into the page. So the block's own text is
 * found again (the Nth `application/ld+json` script, in document order, as the engine counted it), its start location is read from the parser, and the
 * block-relative line and column are added to it. Numbers only: no text is kept. `null` when the locator carries no offset or the block cannot be found.
 */
function positionOf(locator: string, rawHtml: string): { line: number; column: number } | null {
  const m = /^raw\.jsonld\[(\d+)\]@(\d+)$/.exec(locator);
  if (m === null) return null;
  const wanted = Number(m[1]);
  const offset = Number(m[2]);
  let seen = 0;
  let found: { text: string; line: number; column: number } | null = null;
  const visit = (node: Node): void => {
    if (found !== null) return;
    const el = node as { tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: Node[] };
    if (el.tagName === "script" && (el.attrs?.find((a) => a.name === "type")?.value ?? "").trim().toLowerCase() === "application/ld+json") {
      const texts = (el.childNodes ?? []).filter((c) => c.nodeName === "#text") as Array<Node & { value: string; sourceCodeLocation?: { startLine: number; startCol: number } | null }>;
      if (seen === wanted) {
        const first = texts[0]?.sourceCodeLocation;
        if (first) found = { text: texts.map((t) => t.value).join(""), line: first.startLine, column: first.startCol };
        else seen = -1; // no location: stop matching rather than let the NEXT block answer for this one
        return;
      }
      seen += 1;
    }
    for (const child of el.childNodes ?? []) visit(child);
  };
  visit(parse(rawHtml, { sourceCodeLocationInfo: true }) as Node);
  if (found === null) return null;
  const block = found as { text: string; line: number; column: number };
  if (offset > block.text.length) return null;
  const before = block.text.slice(0, offset);
  const breaks = before.split("\n").length - 1;
  const line = block.line + breaks;
  const column = breaks === 0 ? block.column + offset : offset - before.lastIndexOf("\n");
  return line <= 1_000_000 && column <= 1_000_000 ? { line, column } : null;
}

export async function checkUrlStructuredData(input: { readonly url: string; readonly catalog: readonly ToolCatalogRow[] }, deps: UrlCheckDeps = {}): Promise<UrlCheckOutcome> {
  const fetchOne = deps.fetch ?? ((url: string, init?: GuardedFetchInit) => guardedFetch(url, init));
  const timeoutMs = deps.timeoutMs ?? SCHEMA_BUILDER_URL_FETCH_TIMEOUT_MS;

  let response: GuardedResponse;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("schema builder url: fetch timeout")), timeoutMs);
    });
    response = await Promise.race([fetchOne(input.url, { headers: { "user-agent": NOMINARA_USER_AGENT, accept: "text/html,application/xhtml+xml" }, truncateAtCap: true }), timeout]);
  } catch (error) {
    // A reason code, never the error's message: for a connect failure it carries the resolved address.
    return { kind: "unreachable", reason: error instanceof GuardedFetchRefusal ? "refused" : "unreachable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (response.status < 200 || response.status >= 300) return { kind: "unreachable", reason: "http_error" };
  const type = String(Array.isArray(response.headers["content-type"]) ? response.headers["content-type"][0] : (response.headers["content-type"] ?? "")).toLowerCase();
  if (!type.includes("html")) return { kind: "unreachable", reason: "not_html" };

  const catalog = loadAuxCatalog(input.catalog.map((r) => ({ code: r.code, category: r.category, weight: r.weight, ruleVersion: r.rule_version, autoFixable: r.auto_fixable, thresholds: r.thresholds })));
  const rawHtml = response.body.toString("utf8");
  const document = buildAuxDocument(
    {
      url: input.url,
      finalUrl: response.finalUrl,
      httpStatus: response.status,
      redirectChain: response.redirectChain ?? [],
      headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(", ") : (value ?? "")])),
      rawHtml,
      renderedHtml: null,
      timing: { ttfbMs: response.ttfbMs ?? null, loadMs: response.loadMs ?? null },
    },
    cl100kTokenizer,
  );
  const rules = AUX_RULES.filter((rule) => RULE_CODES.has(rule.code));
  const found = await evaluateDocument(document, catalog, rules, { projectId: "schema-builder-url" });

  const byCode = new Map(input.catalog.map((r) => [r.code, r]));
  const findings: SchemaBuilderFinding[] = found
    .map((f) => {
      const row = byCode.get(f.rule_code);
      // The consequence is the catalog's, never invented: a rule with none fails the check closed.
      if (row === undefined || row.rationale === null || row.rationale === "") throw new Error(`the rule catalog has no consequence for ${f.rule_code}`);
      // Key order is the order a reader meets the fields: the consequence first, the rule code a reference.
      return { consequence: row.rationale, title: row.title, rule_code: f.rule_code as SchemaBuilderFinding["rule_code"], severity: f.severity, position: f.rule_code === "AUX-R-008" ? positionOf(f.evidence.locator, rawHtml) : null, field: fieldOf(f.evidence.locator) };
    })
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || (a.rule_code < b.rule_code ? -1 : a.rule_code > b.rule_code ? 1 : 0));

  const ruleVersion = input.catalog[0]?.rule_version ?? "unknown";
  return {
    kind: "checked",
    result: {
      schema_version: 1,
      source: "url",
      state: "checked",
      mode: "check",
      entity_type: null,
      vocab_version: `aux-rules@${ruleVersion}`,
      rules_evaluated: rules.length,
      page_truncated: response.truncated === true,
      findings: findings.slice(0, SCHEMA_BUILDER_MAX_FINDINGS),
      findings_omitted: Math.max(0, findings.length - SCHEMA_BUILDER_MAX_FINDINGS),
    },
  };
}
