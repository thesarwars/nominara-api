import { parseCapture } from "../parser/parse-capture.js";
import { citationSourceDomain } from "../visibility-scan/scan-result.js";
import { extractEntities } from "./entities.js";

// STORY-080 - one engine answer, read for what it NAMES and what it CITES. The citations go through the same parser the scan uses (no aliases: there is no brand
// to find), with redirects unresolved - the interactive path makes no call to a citation target.

const NO_REDIRECTS = async (): Promise<never> => {
  throw new Error("redirects are not resolved on the interactive path");
};

export interface ReadAnswer {
  readonly entities: string[];
  /** One entry per citation whose real source host is known. */
  readonly domains: string[];
}

export async function readResearchAnswer(engineKey: string, text: string, structuredCitations?: readonly { readonly url: string; readonly title?: string; readonly slot: number }[]): Promise<ReadAnswer> {
  const parse = await parseCapture(
    {
      resultId: "research",
      workspaceId: "research",
      projectId: "research",
      promptId: "research",
      engineKey,
      capturedAt: new Date(),
      text,
      ...(structuredCitations !== undefined ? { structuredCitations } : {}),
      flags: [],
    },
    { rootDomain: "", ownedDomains: [], competitorDomains: [], negativeAliases: [], aliases: [], fetch: NO_REDIRECTS },
  );
  const domains = parse.citations.flatMap((c) => {
    const domain = citationSourceDomain(c);
    return domain === null ? [] : [domain];
  });
  return { entities: extractEntities(parse.normalizedText), domains };
}
