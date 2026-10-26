// STORY-053 AC9 — a rule that cannot be fixed by a patch carries structured guidance and a link to the alignment analysis, not an
// empty patch.
//
// THE SET. aux-and-geo-analysis.md section 5 rule 4 names twelve rules; the section 2 catalog marks FOURTEEN with no auto-fix.
// AUX-R-003 (robots.txt unreachable or malformed) and AUX-R-022 (paragraph density) are the two the list leaves out. A broken robots
// file and paragraph density both need human judgement, so they get guidance too; the catalog is the finer source and this follows it
// (the reference list is corrected in the same change). AUX-R-007 (sitemap) is fixable in the catalog but has no patch kind in v1
// (the patches table has no sitemap kind), so it is guidance-only, with no alignment link: the fix is not about content.

export const NON_FIXABLE_RULES: readonly string[] = [
  "AUX-R-003", "AUX-R-005", "AUX-R-013", "AUX-R-019", "AUX-R-020", "AUX-R-021", "AUX-R-022",
  "AUX-R-025", "AUX-R-026", "AUX-R-027", "AUX-R-028", "AUX-R-029", "AUX-R-031", "AUX-R-033",
];

/** Every rule the catalog marks auto-fixable (20). */
export const PATCHABLE_RULES: readonly string[] = [
  "AUX-R-001", "AUX-R-002", "AUX-R-004", "AUX-R-006", "AUX-R-007", "AUX-R-008", "AUX-R-009", "AUX-R-010", "AUX-R-011", "AUX-R-012",
  "AUX-R-014", "AUX-R-015", "AUX-R-016", "AUX-R-017", "AUX-R-018", "AUX-R-023", "AUX-R-024", "AUX-R-030", "AUX-R-032", "AUX-R-034",
];

/** Fixable in the catalog, but with no patch kind in v1. */
export const GUIDANCE_ONLY_RULES: readonly string[] = ["AUX-R-007"];

export interface Guidance {
  readonly summary: string;
  readonly steps: string[];
  /** Where the analysis that sees the page against the category lives. null where an alignment analysis would not help. */
  readonly alignment_link: { readonly path: string; readonly target_url: string | null } | null;
}

interface GuidanceText {
  readonly summary: string;
  readonly steps: readonly string[];
}

const TEXT: Readonly<Record<string, GuidanceText>> = {
  "AUX-R-003": {
    summary: "robots.txt could not be read as a valid file, so AI crawlers may skip or mis-crawl the whole site.",
    steps: [
      "Make /robots.txt return 200 with a plain-text body from the site root, not an error page or a redirect to another host.",
      "Remove or correct every line that is not a User-agent, Allow, Disallow, Sitemap or Crawl-delay directive.",
      "Keep the file under 500 KiB; split rules by path rather than listing every URL.",
    ],
  },
  "AUX-R-005": {
    summary: "Your edge (CDN or firewall) may turn AI crawlers away even though robots.txt allows them. Nominara cannot observe this from outside.",
    steps: [
      "Check the CDN or WAF rules for bot management, rate limiting and challenge pages that apply to AI crawler user agents.",
      "Allow the AI crawlers you want to be cited by (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) through the bot rules, by their published IP ranges where the vendor lists them.",
      "Re-run the audit after the change and compare the AI-bot access section.",
    ],
  },
  "AUX-R-013": {
    summary: "The structured data on the page disagrees with the text a visitor sees. One of them is wrong, and only you know which.",
    steps: [
      "Compare the price, name and rating in the JSON-LD with the same values in the visible page.",
      "Correct whichever is out of date, and make the two come from one source in your template so they cannot drift apart again.",
    ],
  },
  "AUX-R-019": {
    summary: "The page is long enough that AI engines will truncate it, and what they cut may be the part you want cited.",
    steps: [
      "Split the page by topic into separate pages that each answer one question.",
      "Move the most important facts and the summary to the top of each page.",
      "Link the pages to each other so the set remains one navigable resource.",
    ],
  },
  "AUX-R-020": {
    summary: "Little of the page is main content; navigation, scripts and boilerplate crowd out what engines should read.",
    steps: [
      "Reduce repeated navigation, footers and widgets that render inside the main content area.",
      "Mark the main content with a <main> element so extractors find it.",
    ],
  },
  "AUX-R-021": {
    summary: "A section runs on for too long without a subheading, list or table, so engines may cut it mid-thought.",
    steps: [
      "Break the section with subheadings that name what each part answers.",
      "Turn enumerations into lists and comparisons into tables.",
      "Keep each block short enough to stand alone as a quotable answer.",
    ],
  },
  "AUX-R-022": {
    summary: "Paragraphs or sentences are long enough to be hard for an engine to quote cleanly.",
    steps: [
      "Split paragraphs over about 900 characters at the point where the topic changes.",
      "Shorten sentences that run past roughly 32 words; one claim per sentence.",
    ],
  },
  "AUX-R-025": {
    summary: "Key facts (pricing, capabilities, comparisons) are only in images, which engines do not read.",
    steps: [
      "Repeat the facts as text next to each image, or replace the image with a table.",
      "Write alt text that states the fact in a full sentence, not the image's filename or a label.",
    ],
  },
  "AUX-R-026": {
    summary: "Most of the page's content only exists after JavaScript runs, so crawlers that do not execute scripts see an empty page.",
    steps: [
      "Render the main content on the server (server-side rendering or static generation) so it is in the first HTML response.",
      "If a rewrite is not possible, pre-render the key pages and serve that version to crawlers.",
    ],
  },
  "AUX-R-027": {
    summary: "Structured data is injected by JavaScript only, so crawlers that do not execute scripts never see it.",
    steps: [
      "Put the JSON-LD in the server-rendered HTML instead of adding it from client-side code.",
      "Confirm with 'view source' that the script type=application/ld+json block is present before any script runs.",
    ],
  },
  "AUX-R-028": {
    summary: "Content that matters appears only after a click or scroll, and is absent from the HTML crawlers fetch.",
    steps: [
      "Include the content in the initial HTML and use CSS to collapse it, rather than loading it on interaction.",
      "Give tabs and accordions real headings and text in the markup.",
    ],
  },
  "AUX-R-029": {
    summary: "The page is slow to start responding to a crawler that does not run scripts, or is very large.",
    steps: [
      "Cache the page at the edge so a crawler's first byte does not wait on the origin.",
      "Cut the HTML payload: remove inlined data and unused markup, and compress responses.",
    ],
  },
  "AUX-R-031": {
    summary: "The page has not been updated recently compared with what the engines cite in your category.",
    steps: [
      "Review the page for facts that have changed since it was last edited, and update them.",
      "Record the real revision date in the page (visibly, and in dateModified) only when the content was actually revised.",
    ],
  },
  "AUX-R-033": {
    summary: "The page describes your product with pronouns and phrases like 'our platform' instead of naming it, so an engine cannot tell what is being described.",
    steps: [
      "Name the product or company in the sentences that describe what it does.",
      "Keep the name consistent with the one used in the title and the structured data.",
    ],
  },
  "AUX-R-007": {
    summary: "The sitemap is missing, out of date, or declared in robots.txt but not served. Nominara does not generate sitemap files in v1.",
    steps: [
      "Generate a sitemap.xml from your CMS or framework and serve it from the site root.",
      "Add a 'Sitemap:' line pointing at it to robots.txt, and keep each entry's lastmod accurate.",
    ],
  },
};

/** The guidance for `ruleCode`, or null where the rule has a patch (or is unknown). */
export function guidanceFor(ruleCode: string, context: { readonly projectId: string; readonly url: string | null }): Guidance | null {
  const text = TEXT[ruleCode];
  if (text === undefined) return null;
  const guidanceOnly = GUIDANCE_ONLY_RULES.includes(ruleCode);
  if (!guidanceOnly && !NON_FIXABLE_RULES.includes(ruleCode)) return null;
  return {
    summary: text.summary,
    steps: [...text.steps],
    alignment_link: guidanceOnly ? null : { path: "/geo/alignment", target_url: context.url },
  };
}
