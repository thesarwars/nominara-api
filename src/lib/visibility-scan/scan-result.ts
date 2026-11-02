import { SCAN_SAMPLE_STATEMENT, type ScanStreamEngineResult } from "../../../contracts/tools/index.js";
import { parseCapture, type ParseResult } from "../parser/parse-capture.js";
import type { AliasEntry } from "../parser/entity-matcher.js";

// STORY-079 - turning one engine's answer into the scan's per-engine result, and the per-engine results into the headline.
//
// LEXICON-ONLY (AC5): `parseCapture` is called with NO arbiter, so a sentiment the lexicon cannot settle stays a lexicon verdict. An arbiter would
// add seconds and a per-run model cost, and the result is already labelled a single unsampled observation. Citation redirects are NOT resolved
// either - the fetch is replaced with a refusal, which the parser records as "unresolved" (http_status null, excluded from share) - because the
// interactive path makes no call to a citation target.

const EXCERPT_CHARS = 280;
const INTERACTIVE_NO_REDIRECTS = async (): Promise<never> => {
  throw new Error("redirects are not resolved on the interactive path");
};

export interface ParseScanAnswerInput {
  readonly engineKey: string;
  readonly text: string;
  readonly structuredCitations?: readonly { readonly url: string; readonly title?: string; readonly slot: number }[];
  readonly brandName: string;
  readonly brandUrl: string | null;
  readonly competitors: readonly string[];
}

function hostOf(url: string | null): string {
  if (url === null) return "";
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "";
  }
}

export async function parseScanAnswer(input: ParseScanAnswerInput): Promise<ParseResult> {
  const rootDomain = hostOf(input.brandUrl);
  const aliases: AliasEntry[] = [
    { entityType: "brand", entityId: null, label: input.brandName, alias: input.brandName },
    ...input.competitors.map((name) => ({ entityType: "competitor" as const, entityId: null, label: name, alias: name })),
  ];
  return await parseCapture(
    {
      resultId: "scan",
      workspaceId: "scan",
      projectId: "scan",
      promptId: "scan",
      engineKey: input.engineKey,
      capturedAt: new Date(),
      text: input.text,
      ...(input.structuredCitations !== undefined ? { structuredCitations: input.structuredCitations } : {}),
      flags: [],
    },
    { rootDomain, ownedDomains: rootDomain === "" ? [] : [rootDomain], competitorDomains: [], negativeAliases: [], aliases, fetch: INTERACTIVE_NO_REDIRECTS },
  );
}

export interface ToEngineResultInput {
  readonly engine: string;
  readonly parse: ParseResult;
  /** WHEN THE ANSWER WAS CAPTURED - for a cached engine, the original capture time, never the run's. */
  readonly capturedAt: Date;
  readonly now: Date;
  readonly latencyMs: number;
  readonly cacheLayer: "l1" | "none";
  readonly excerpt: string;
}

export function toEngineResult(input: ToEngineResultInput): ScanStreamEngineResult {
  const { parse } = input;
  const brand = parse.mentions.filter((m) => m.mention.entityType === "brand" && !m.mention.inLink);
  const scores = brand.map((m) => m.sentiment.score);
  const labelCounts = new Map<string, number>();
  for (const m of brand) labelCounts.set(m.sentiment.label, (labelCounts.get(m.sentiment.label) ?? 0) + 1);
  const label = (["positive", "negative", "neutral"] as const).reduce<"positive" | "neutral" | "negative" | null>(
    (best, candidate) => ((labelCounts.get(candidate) ?? 0) > (labelCounts.get(best ?? "") ?? 0) ? candidate : best),
    null,
  );
  return {
    engine: input.engine,
    cache_layer: input.cacheLayer,
    captured_at: input.capturedAt.toISOString(),
    latency_ms: input.latencyMs,
    brand_present: parse.brandPresent,
    rank_position: parse.brandRankPosition,
    sov: Math.min(1, Math.max(0, parse.brandSov)),
    sentiment: !parse.brandPresent || label === null ? { label: "absent", score: null } : { label, score: Math.min(1, Math.max(-1, scores.reduce((a, b) => a + b, 0) / scores.length)) },
    citations: parse.citations.map((c) => ({ slot: c.slotIndex, domain: c.domain === "" ? c.rawUrl : c.domain, is_owned: c.isOwned })),
    excerpt: input.excerpt.slice(0, EXCERPT_CHARS),
    age_ms: Math.max(0, input.now.getTime() - input.capturedAt.getTime()),
    estimated: true,
  };
}

export { aggregateScan, failureFor } from "./scan-aggregate.js";
export { SCAN_SAMPLE_STATEMENT };
