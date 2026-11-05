import { SCAN_SAMPLE_STATEMENT, type ScanStreamEngineResult } from "../../../contracts/tools/index.js";
import { parseCapture, type ParseResult } from "../parser/parse-capture.js";
import { labelFor } from "../parser/sentiment/classify.js";
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

export function hostOf(url: string | null): string {
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
  /** The brand's own host (no `www.`), for judging a hinted citation host; null when the caller gave no URL. */
  readonly brandHost?: string | null;
}

/** Hosts that only redirect to the real source (Gemini grounding). Only a listed host is treated as a wrapper; a hostname-looking TITLE alone is never evidence of one. */
const REDIRECT_WRAPPER_HOSTS: ReadonlySet<string> = new Set(["vertexaisearch.cloud.google.com"]);

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/u;

/** An engine's own title for a source, when it is a bare hostname (Gemini titles a grounding chunk with the site's domain). Otherwise null. */
function hostnameHint(title: string | null): string | null {
  if (title === null) return null;
  const candidate = title.trim().toLowerCase().replace(/^www\./u, "");
  return HOSTNAME.test(candidate) ? candidate : null;
}

function isHostOrSubdomain(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

/** The label is the PARSER's band for the clamped mean, so an engine row and the headline can never label one score two ways. */
function sentimentOf(brandPresent: boolean, scores: readonly number[]): ScanStreamEngineResult["sentiment"] {
  if (!brandPresent || scores.length === 0) return { label: "absent", score: null };
  const score = Math.min(1, Math.max(-1, scores.reduce((a, b) => a + b, 0) / scores.length));
  return { label: labelFor(score), score };
}

export function toEngineResult(input: ToEngineResultInput): ScanStreamEngineResult {
  const { parse } = input;
  const brand = parse.mentions.filter((m) => m.mention.entityType === "brand" && !m.mention.inLink);
  const scores = brand.map((m) => m.sentiment.score);
  return {
    engine: input.engine,
    cache_layer: input.cacheLayer,
    captured_at: input.capturedAt.toISOString(),
    latency_ms: input.latencyMs,
    brand_present: parse.brandPresent,
    rank_position: parse.brandRankPosition,
    sov: Math.min(1, Math.max(0, parse.brandSov)),
    sentiment: sentimentOf(parse.brandPresent, scores),
    citations: parse.citations.map((c) => {
      const urlHost = hostOf(c.rawUrl);
      const hint = hostnameHint(c.title);
      // A REDIRECT WRAPPER is a URL whose host is the engine's, not the source's - a known wrapper host (a title that merely LOOKS like a hostname, such as
      // 'Next.js', is not evidence of one). It is not fetched on the interactive path, so its real host is only the hint, and its ownership is only as good as the hint.
      const wrapper = REDIRECT_WRAPPER_HOSTS.has(urlHost);
      if (!wrapper) return { slot: c.slotIndex, domain: c.domain === "" ? c.rawUrl : c.domain, is_owned: c.isOwned };
      // Unknown real host: null - neither foreign nor owned. The wrapper's own host is never reported as a source.
      if (hint === null) return { slot: c.slotIndex, domain: null, is_owned: null };
      const brandHost = (input.brandHost ?? "").replace(/^www\./u, "").toLowerCase();
      return { slot: c.slotIndex, domain: hint, is_owned: brandHost !== "" && isHostOrSubdomain(hint, brandHost) };
    }),
    excerpt: input.excerpt.slice(0, EXCERPT_CHARS),
    age_ms: Math.max(0, input.now.getTime() - input.capturedAt.getTime()),
    estimated: true,
  };
}

export { aggregateScan, failureFor } from "./scan-aggregate.js";
export { SCAN_SAMPLE_STATEMENT };
