import { buildRobotsPatch } from "./robots-directive.js";
import { buildLlmsTxtPatch } from "./markdown.js";
import { guidanceFor, GUIDANCE_ONLY_RULES, NON_FIXABLE_RULES, type Guidance } from "./guidance.js";
import type { PatchDraft } from "./types.js";

// STORY-053 — the dispatcher for the findings the crawl produces today: the site-file rules (AUX-R-001, 002, 003, 004, 007).
// The page-level generators (jsonld.ts, html-fragment.ts, markdown.ts#buildStructurePatch) are built and tested as pure functions and
// are wired here when STORY-051 produces the page-level findings and the extracted page content that drives them.
//
// PURE. It either returns a draft, returns guidance, returns `none` (nothing to offer: an honest empty, never an empty patch), or
// throws PatchRejectedError when its own output fails a gate. The caller records a rejection; it does not abort the audit.

export interface SiteInputs {
  /** `https://host`. */
  readonly origin: string;
  readonly siteName: string;
  readonly projectId: string;
  /** The site's own page URLs, from its sitemap. */
  readonly pageUrls: readonly string[];
  /** robots.txt as fetched: null when it could not be read. */
  readonly robots: { readonly body: string; readonly hash: Buffer } | null;
  /** The /llms.txt the site serves now: null when there is none. */
  readonly llms: { readonly body: string } | null;
  /**
   * False when /llms.txt cannot be told absent or present: it answered with an error status other than 404 or 410, or it is absent
   * but the same audit found one at /.well-known/llms.txt. A "file_absent" patch (or a replacement of a file we never read) would
   * then be wrong or judged `changed` at once, so none is offered.
   */
  readonly llmsPatchable: boolean;
  /** The paths the audit judged robots.txt against (what it passed to evaluateRobotsTxt). Default: the root. */
  readonly trackedPaths?: readonly string[];
}

export interface GenerateInput {
  readonly ruleCode: string;
  /** The file the finding is about. */
  readonly targetUrl: string;
  /** The finding's url (null = domain-level). */
  readonly url: string | null;
  readonly site: SiteInputs;
}

export type Generated =
  | { readonly outcome: "patch"; readonly draft: PatchDraft }
  | { readonly outcome: "guidance"; readonly guidance: Guidance }
  | { readonly outcome: "none" };

export function generateSiteFilePatch(input: GenerateInput): Generated {
  const { ruleCode, site } = input;
  if (NON_FIXABLE_RULES.includes(ruleCode) || GUIDANCE_ONLY_RULES.includes(ruleCode)) {
    const guidance = guidanceFor(ruleCode, { projectId: site.projectId, url: input.url });
    return guidance === null ? { outcome: "none" } : { outcome: "guidance", guidance };
  }
  if (ruleCode === "AUX-R-001" || ruleCode === "AUX-R-002") {
    if (site.robots === null) return { outcome: "none" };
    const draft = buildRobotsPatch({ ruleCode, targetUrl: input.targetUrl, body: site.robots.body, bodyHash: site.robots.hash, ...(site.trackedPaths === undefined ? {} : { trackedPaths: site.trackedPaths }) });
    return draft === null ? { outcome: "none" } : { outcome: "patch", draft };
  }
  if (ruleCode === "AUX-R-004") {
    if (!site.llmsPatchable) return { outcome: "none" };
    return { outcome: "patch", draft: buildLlmsTxtPatch({ ruleCode, origin: site.origin, siteName: site.siteName, pageUrls: site.pageUrls, existing: site.llms?.body ?? null }) };
  }
  return { outcome: "none" };
}
