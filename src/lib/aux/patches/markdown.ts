import { unifiedDiff } from "./diff.js";
import { sha256Of, sha256Tag } from "./precondition.js";
import { PatchRejectedError, type PatchDraft } from "./types.js";

// STORY-053 AC1 (kind `markdown`) — the two markdown patches the catalog's auto-fix column names:
//   * AUX-R-004, the llms.txt file: a Nominara template filled with the site's OWN URLs (its sitemap). It states no description,
//     because a description would be a new claim about the business.
//   * AUX-R-023, the answer-shaped structure template: a summary slot after the page's first heading. The slot is a placeholder
//     the customer writes into in their own words; the only text taken from the page is its own heading.

/** NOT FROM THE REFERENCE. llms.txt is a short orientation file; 50 links keeps it that and the diff reviewable. */
export const LLMS_TXT_MAX_LINKS = 50;
const MAX_LABEL = 100;

// `\s` covers the line breaks and tabs; any other control character is dropped.
const oneLine = (s: string): string => Array.from(s, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("").replace(/\s+/g, " ").trim();
const noBrackets = (s: string): string => s.replace(/[[\]]/g, "");

const capitalise = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));
function segmentLabel(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // a malformed escape stays as written
  }
  // A decoded %0A is a real line break: one line only, or a segment could start a heading or a list item of its own.
  return capitalise(oneLine(decoded).replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_+]+/g, " ").trim());
}

export interface BuildLlmsTxtInput {
  readonly ruleCode: string;
  /** `https://host`, no path. */
  readonly origin: string;
  readonly siteName: string;
  /** The site's own page URLs (its sitemap). Other origins are dropped. */
  readonly pageUrls: readonly string[];
  /** The /llms.txt the site serves now (invalid), or null when there is none. */
  readonly existing: string | null;
}

export function buildLlmsTxtPatch(input: BuildLlmsTxtInput): PatchDraft {
  const host = new URL(input.origin).hostname;
  const name = oneLine(input.siteName).slice(0, MAX_LABEL) || host;
  const seen = new Set<string>();
  const pages: { url: string; path: string }[] = [];
  for (const raw of input.pageUrls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.origin !== input.origin || (u.protocol !== "https:" && u.protocol !== "http:")) continue;
    const href = u.href.replace(/\)/g, "%29");
    if (seen.has(href)) continue;
    seen.add(href);
    pages.push({ url: href, path: u.pathname });
  }
  // Root first, then alphabetical: the same site yields the same file, so a re-run does not look like a change.
  pages.sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const items = pages.slice(0, LLMS_TXT_MAX_LINKS).map((p) => {
    const label = p.path === "/" ? noBrackets(name) : p.path.split("/").filter(Boolean).map(segmentLabel).join(" / ");
    return `- [${noBrackets(label) || p.url}](${p.url})`;
  });
  const content = `# ${name}\n${items.length === 0 ? "" : `\n## Pages\n\n${items.join("\n")}\n`}`;

  const existing = input.existing;
  const before = sha256Of(existing ?? "");
  return {
    ruleCode: input.ruleCode,
    kind: "markdown",
    targetUrl: new URL("/llms.txt", input.origin).href,
    contentBeforeHash: before,
    contentAfter: content,
    unifiedDiff: unifiedDiff("llms.txt", existing ?? "", content),
    jsonldBlocks: null,
    reversal: existing === null ? { operation: "delete_file", content: null } : { operation: "replace_file", content: existing },
    preconditions: [existing === null ? { kind: "file_absent", value: null } : { kind: "file_hash", value: sha256Tag(before) }],
    explanation:
      existing === null
        ? "There is no /llms.txt. Publish this file at the root of the site so AI engines that read it find your canonical page list."
        : "The /llms.txt on the site does not follow the llmstxt.org format. Replace it with this file; the previous content is kept in the reversal.",
    derivation:
      "Link targets are URLs from the site's own sitemap, on the site's own origin; link text is the URL path; the title is the site name. No description is generated.",
    requiresHumanReview: false,
    reviewReason: null,
    riskFlags: [],
  };
}

export interface BuildStructureInput {
  readonly ruleCode: string;
  readonly targetUrl: string;
  /** The page's main content as markdown. */
  readonly markdown: string;
}

export function buildStructurePatch(input: BuildStructureInput): PatchDraft {
  const lines = input.markdown.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s+\S/.test(l));
  if (at < 0) throw new PatchRejectedError("no_heading", "the page has no heading to anchor a summary to");
  const title = noBrackets(lines[at]!.replace(/^#{1,6}\s+/, "")).replace(/"/g, "'").trim().slice(0, MAX_LABEL);
  const rest = lines.slice(at + 1);
  while (rest.length > 0 && rest[0]!.trim() === "") rest.shift();
  const head = `${lines.slice(0, at + 1).join("\n")}\n\n## Summary\n\n[Write a summary of "${title}" in up to three sentences, in your own words.]\n`;
  const after = rest.length === 0 ? head : `${head}\n${rest.join("\n")}`;

  const before = sha256Of(input.markdown);
  return {
    ruleCode: input.ruleCode,
    kind: "markdown",
    targetUrl: input.targetUrl,
    contentBeforeHash: before,
    contentAfter: after,
    unifiedDiff: unifiedDiff("page.md", input.markdown, after),
    jsonldBlocks: null,
    reversal: { operation: "replace_file", content: input.markdown },
    preconditions: [{ kind: "page_hash", value: sha256Tag(before) }],
    explanation: "AI engines quote short, self-contained answers. Add a summary directly under the first heading, written in your own words.",
    derivation: "The summary slot is a Nominara template; the only text taken from the page is its own first heading. The slot is a placeholder, not a statement.",
    requiresHumanReview: false,
    reviewReason: null,
    riskFlags: [],
  };
}
