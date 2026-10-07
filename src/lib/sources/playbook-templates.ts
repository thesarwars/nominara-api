// NEW-C-7 / STORY-055 — versioned seeding-playbook templates, one per SEEDABLE
// source class (`aux-and-geo-analysis.md` §10), selected by the gap's class.
//
// Shipped as constant data keyed by `source_domains.seeding_playbook_slug`
// (no table: NEW-C-7 plan, "migrations: none"). A rules change is a new
// version appended here, so the prior version stays retrievable by
// (slug, version).
//
// ⚠ NOTHING HERE IS A QUOTE OF A PLATFORM'S RULES. `rules` is empty and
// `rulesUnavailableReason` says why: a verbatim quote needs the platform's
// published text and its URL, which the owner has not supplied. Inventing or
// paraphrasing platform rules is the one thing a playbook must not do.
//
// ⚠ NOMINARA NEVER POSTS ON THE CUSTOMER'S BEHALF. These are briefs for a
// human. Nothing in this module (or the system) contacts a third-party
// platform; test/unit/sources/no-platform-writes.spec.ts asserts it.

export interface PlaybookTemplate {
  readonly slug: string;
  readonly version: number;
  readonly sourceClass: string;
  readonly rules: ReadonlyArray<{ readonly quote: string; readonly url: string }>;
  readonly rulesUnavailableReason: string | null;
  readonly outline: readonly string[];
  readonly disclosure: string;
  readonly doNot: readonly string[];
  readonly verification: string;
}

const RULES_PENDING =
  "Platform rule text with source links has not been supplied for this platform class. Read the platform's own current rules before contributing; Nominara does not paraphrase them.";

const DISCLOSURE =
  "State your affiliation with the brand plainly in the contribution itself, in the first lines, wherever the platform's rules permit contributions from affiliated people. If they do not permit it, do not contribute.";

const COMMON_DO_NOT: readonly string[] = [
  "Do not post without disclosing your affiliation with the brand.",
  "Do not use multiple accounts, sockpuppets, or asked-for proxies to post or vote.",
  "Do not post the same text in more than one place (no mass or copy-paste posting).",
  "Do not offer or accept payment, discounts, or other incentives for reviews or votes where the platform prohibits it.",
  "Do not make claims about the brand you cannot support with a public source.",
];

const VERIFICATION =
  "Submit the URL of your published contribution when you complete the task. Nominara fetches that URL and checks that it mentions your brand; the gap closes only when it does.";

export const PLAYBOOK_TEMPLATES: readonly PlaybookTemplate[] = [
  {
    slug: "playbook-community_forum",
    version: 1,
    sourceClass: "community_forum",
    rules: [],
    rulesUnavailableReason: RULES_PENDING,
    outline: [
      "Find an existing thread where the question the engines are answering is being asked in good faith.",
      "Answer the actual question first, fully, in a way that is useful even if the brand is never clicked.",
      "Mention the brand only where it is a relevant option, alongside honest trade-offs.",
      "Return to answer follow-up questions.",
    ],
    disclosure: DISCLOSURE,
    doNot: COMMON_DO_NOT,
    verification: VERIFICATION,
  },
  {
    slug: "playbook-review_marketplace",
    version: 1,
    sourceClass: "review_marketplace",
    rules: [],
    rulesUnavailableReason: RULES_PENDING,
    outline: [
      "Claim and complete the vendor profile: accurate description, categories, pricing, and screenshots.",
      "Keep the profile current when the product changes.",
      "Invite genuine customers to review, using only the invitation methods the platform's policy allows.",
      "Respond to reviews factually and courteously.",
    ],
    disclosure: DISCLOSURE,
    doNot: [...COMMON_DO_NOT, "Do not write reviews of your own product or of competitors' products."],
    verification: VERIFICATION,
  },
  {
    slug: "playbook-developer_platform",
    version: 1,
    sourceClass: "developer_platform",
    rules: [],
    rulesUnavailableReason: RULES_PENDING,
    outline: [
      "Publish a real, working integration or package that solves a concrete problem.",
      "Write documentation a newcomer can follow: install, configure, a worked example, and known limits.",
      "Maintain it: respond to issues and keep it compatible with current versions.",
    ],
    disclosure: DISCLOSURE,
    doNot: [...COMMON_DO_NOT, "Do not publish placeholder or empty listings to occupy a name."],
    verification: VERIFICATION,
  },
  {
    slug: "playbook-news_media",
    version: 1,
    sourceClass: "news_media",
    rules: [],
    rulesUnavailableReason: RULES_PENDING,
    outline: [
      "Offer a publication an original data point, study, or expert commentary on a topic it already covers.",
      "Pitch the specific editor or reporter with the finding, not the brand.",
      "Provide the underlying data so claims can be checked.",
    ],
    disclosure: DISCLOSURE,
    doNot: [...COMMON_DO_NOT, "Do not pay for editorial coverage that is not labelled as sponsored."],
    verification: VERIFICATION,
  },
  {
    slug: "playbook-blog",
    version: 1,
    sourceClass: "blog",
    rules: [],
    rulesUnavailableReason: RULES_PENDING,
    outline: [
      "Check whether the publication accepts guest contributions and follow its submission process.",
      "Propose an article that serves its readers on a topic it has not covered well.",
      "Keep brand mentions relevant and in context.",
    ],
    disclosure: DISCLOSURE,
    doNot: [...COMMON_DO_NOT, "Do not submit thin or link-driven articles."],
    verification: VERIFICATION,
  },
];

export function playbookTemplateFor(sourceClass: string, version?: number): PlaybookTemplate | null {
  const matches = PLAYBOOK_TEMPLATES.filter((t) => t.sourceClass === sourceClass && (version === undefined || t.version === version));
  if (matches.length === 0) return null;
  return matches.reduce((latest, t) => (t.version > latest.version ? t : latest));
}
