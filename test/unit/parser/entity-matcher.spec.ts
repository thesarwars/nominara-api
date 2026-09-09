import { describe, expect, it } from "vitest";
import { normalize } from "../../../src/lib/parser/normalize.js";
import {
  aliasSetHash,
  buildMatcher,
  matchEntities,
  type AliasEntry,
  type Mention,
} from "../../../src/lib/parser/entity-matcher.js";

// STORY-036's eleven scenarios, minus the two that need subsystems that do
// not exist (see the story for the gaps).
//
// THE COMMON-WORD BRAND IS WHAT THESE TESTS ARE ABOUT. A project called
// "Notion" or "Ghost" matches ordinary prose constantly, and each false match
// inflates presence and distorts share of voice — a number wrong in the
// direction the customer likes, which is the hardest kind to notice.

const HUBSPOT: AliasEntry = { entityType: "brand", entityId: null, label: "HubSpot", alias: "HubSpot" };
const SALESFORCE: AliasEntry = {
  entityType: "competitor",
  entityId: "01a06ccd-9e37-7f0c-957b-195fa6d263dd",
  label: "Salesforce",
  alias: "Salesforce",
};

function match(text: string, aliases: readonly AliasEntry[] = [HUBSPOT], negativeAliases: readonly string[] = []): Mention[] {
  return matchEntities({ text: normalize(text), aliases, negativeAliases });
}

/** What the mention actually covers in the source — the span contract, checked. */
function covered(text: string, mention: Mention): string {
  return normalize(text).slice(mention.charStart, mention.charEnd);
}

describe("STORY-036 · matching", () => {
  it("Scenario 1 — matches a plain mention with its span and occurrence index", () => {
    const text = "HubSpot is popular. Many teams pick HubSpot for pipelines.";
    const mentions = match(text);

    expect(mentions).toHaveLength(2);
    expect(mentions.map((m) => m.occurrenceIndex)).toEqual([0, 1]);
    expect(covered(text, mentions[0]!)).toBe("HubSpot");
    expect(covered(text, mentions[1]!)).toBe("HubSpot");
  });

  it("counts occurrence index PER ENTITY, not per response", () => {
    const text = "Salesforce, then HubSpot, then Salesforce again.";
    const mentions = match(text, [HUBSPOT, SALESFORCE]);

    const salesforce = mentions.filter((m) => m.entityLabel === "Salesforce");
    expect(salesforce.map((m) => m.occurrenceIndex)).toEqual([0, 1]);
    expect(mentions.find((m) => m.entityLabel === "HubSpot")!.occurrenceIndex).toBe(0);
  });

  it("folds case and diacritics but reports the ORIGINAL span", () => {
    // Folding is not length-preserving — NFD decomposition plus mark
    // stripping shortens the string — so a matcher reporting folded offsets
    // would highlight the wrong characters in every answer with an accent.
    const cafe: AliasEntry = { entityType: "brand", entityId: null, label: "Café", alias: "Café" };
    const text = "We rate CAFÉ highly, and café again.";
    const mentions = match(text, [cafe]);

    expect(mentions).toHaveLength(2);
    for (const mention of mentions) {
      expect(covered(text, mention).toLowerCase().startsWith("caf")).toBe(true);
    }
  });

  it("keeps the CONFIGURED alias, not the text as written", () => {
    const mentions = match("hubspot is fine", [HUBSPOT]);
    expect(mentions[0]!.matchedAlias).toBe("HubSpot");
  });
});

describe("STORY-036 · the three false-positive defences", () => {
  const GHOST: AliasEntry = { entityType: "brand", entityId: null, label: "Ghost", alias: "Ghost" };
  const NOTION: AliasEntry = { entityType: "brand", entityId: null, label: "Notion", alias: "Notion" };

  it("Scenario 2 — a common-word brand does NOT match inside another word", () => {
    // Defence one. Without boundaries "Ghost" matches "Ghostwriter",
    // "ghosting" and "ghosted" — and a project with that name reports
    // presence in answers that never mentioned it.
    expect(match("A ghostwriter drafted it; the client kept ghosting us.", [GHOST])).toEqual([]);
  });

  it("still matches the same word standing alone, in any case", () => {
    expect(match("We host on Ghost.", [GHOST])).toHaveLength(1);
    expect(match("ghost is a CMS", [GHOST])).toHaveLength(1);
  });

  it("Scenario 5 — a negative alias suppresses the match inside it", () => {
    // Defence two, and the reference's own example: a project named "Notion"
    // suppressing "notion of".
    expect(match("The notion of a single source of truth is appealing.", [NOTION], ["notion of"])).toEqual([]);
  });

  it("suppresses only inside the negative phrase, never the entity everywhere", () => {
    const text = "The notion of it aside, Notion is a good tool.";
    const mentions = match(text, [NOTION], ["notion of"]);

    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.charStart).toBe(normalize(text).indexOf("Notion is") );
  });

  it("Scenario 3 — a brand inside a URL is flagged and kept, not dropped", () => {
    // Defence three. Recorded rather than dropped because the interface shows
    // it in the citation panel and the task generator reads it as "you are
    // being linked but not described".
    const mentions = match("See https://blog.example.com/hubspot-review for details.");

    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.inLink).toBe(true);
  });

  it("Scenario 4 — a brand inside a code span or fence is flagged the same way", () => {
    expect(match("Set `provider = HubSpot` in the config.")[0]!.inLink).toBe(true);
    expect(match("```\nclient = HubSpot()\n```")[0]!.inLink).toBe(true);
  });

  it("flags a markdown link TARGET but not its TEXT", () => {
    // `[HubSpot](https://hubspot.com)` genuinely mentions HubSpot in the
    // visible text; only the parenthesised target is a citation.
    const mentions = match("Try [HubSpot](https://hubspot.com/crm) today.");

    expect(mentions).toHaveLength(2);
    expect(mentions.map((m) => m.inLink)).toEqual([false, true]);
  });

  it("a plain mention in prose is NOT flagged", () => {
    expect(match("HubSpot is popular.")[0]!.inLink).toBe(false);
  });
});

describe("STORY-036 · possessives, plurals and collisions", () => {
  it("Scenario 6 — matches possessive and plural forms", () => {
    // The boundary rule and the suffix rule have to apply together: ending
    // the span at the alias would fail the boundary check on the very next
    // character and drop these entirely.
    for (const text of ["HubSpot's pipelines are good", "HubSpot’s pipelines are good", "two HubSpots later"]) {
      expect(match(text), text).toHaveLength(1);
    }
  });

  it("Scenario 7 — the longer name wins and the shorter does not double-match", () => {
    const sales: AliasEntry = { entityType: "competitor", entityId: "s", label: "Sales", alias: "Sales" };
    const mentions = match("Salesforce leads the category.", [sales, SALESFORCE]);

    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.entityLabel).toBe("Salesforce");
  });

  it("still matches the shorter name where it stands alone", () => {
    const sales: AliasEntry = { entityType: "competitor", entityId: "s", label: "Sales", alias: "Sales" };
    const mentions = match("Sales tools, and Salesforce in particular.", [sales, SALESFORCE]);

    expect(mentions.map((m) => m.entityLabel)).toEqual(["Sales", "Salesforce"]);
  });
});

describe("STORY-036 · structure", () => {
  it("records the list position, because position one is not a closing caveat", () => {
    const text = ["## Best CRMs", "", "1. Salesforce — deep reporting", "2. HubSpot — easy pipelines", "", "HubSpot also has a free tier."].join("\n");
    const mentions = match(text, [HUBSPOT, SALESFORCE]);

    const inList = mentions.filter((m) => m.listPosition !== null);
    expect(inList.map((m) => [m.entityLabel, m.listPosition])).toEqual([
      ["Salesforce", 1],
      ["HubSpot", 2],
    ]);
    // The mention in the trailing paragraph is in no list.
    expect(mentions.at(-1)!.listPosition).toBeNull();
  });

  it("numbers by ORDINAL, not by the digit the engine wrote", () => {
    // Engines emit `1.` for every item about as often as they number them.
    const text = ["1. Salesforce", "1. HubSpot"].join("\n");
    expect(match(text, [HUBSPOT, SALESFORCE]).map((m) => m.listPosition)).toEqual([1, 2]);
  });

  it("restarts numbering after a blank line, so two lists do not run together", () => {
    const text = ["- Salesforce", "", "- HubSpot"].join("\n");
    expect(match(text, [HUBSPOT, SALESFORCE]).map((m) => m.listPosition)).toEqual([1, 1]);
  });

  it("records the first token index", () => {
    expect(match("The best option is HubSpot today.")[0]!.firstTokenIndex).toBe(4);
    expect(match("HubSpot leads.")[0]!.firstTokenIndex).toBe(0);
  });
});

describe("STORY-036 · the automaton", () => {
  it("Scenario 10 — match time does not grow with the alias count", () => {
    // The bound the algorithm exists for: linear in RESPONSE length,
    // independent of alias count. Asserted as a ratio rather than a wall-clock
    // budget, because an absolute threshold on a shared machine is a flake
    // generator — and a naive scan would be ~100x here, not 4x.
    const text = normalize(`${"Filler prose about software. ".repeat(400)}HubSpot appears once.`);
    const few = [HUBSPOT];
    const many: AliasEntry[] = [
      HUBSPOT,
      ...Array.from({ length: 1_000 }, (_, i) => ({
        entityType: "competitor" as const,
        entityId: `c${String(i)}`,
        label: `Competitor${String(i)}`,
        alias: `Competitor${String(i)}`,
      })),
    ];

    const smallAutomaton = buildMatcher(few);
    const largeAutomaton = buildMatcher(many);

    const smallStart = performance.now();
    for (let i = 0; i < 20; i += 1) matchEntities({ text, aliases: few, negativeAliases: [] }, smallAutomaton);
    const smallMs = performance.now() - smallStart;

    const largeStart = performance.now();
    for (let i = 0; i < 20; i += 1) matchEntities({ text, aliases: many, negativeAliases: [] }, largeAutomaton);
    const largeMs = performance.now() - largeStart;

    expect(largeMs).toBeLessThan(Math.max(smallMs * 4, 50));
  });

  it("is built once and reused — the same automaton answers for many texts", () => {
    const automaton = buildMatcher([HUBSPOT]);
    expect(matchEntities({ text: "HubSpot one", aliases: [], negativeAliases: [] }, automaton)).toHaveLength(1);
    expect(matchEntities({ text: "HubSpot two", aliases: [], negativeAliases: [] }, automaton)).toHaveLength(1);
  });

  it("ignores an empty alias rather than matching at every position", () => {
    const empty: AliasEntry = { entityType: "brand", entityId: null, label: "X", alias: "" };
    expect(match("nothing here", [empty])).toEqual([]);
  });
});

describe("STORY-036 · the alias-set hash", () => {
  it("is order-independent, so reordering the same set is a cache hit", () => {
    expect(aliasSetHash([HUBSPOT, SALESFORCE], ["a", "b"])).toBe(aliasSetHash([SALESFORCE, HUBSPOT], ["b", "a"]));
  });

  it("changes when an alias is added, removed or edited", () => {
    const base = aliasSetHash([HUBSPOT], []);
    expect(aliasSetHash([HUBSPOT, SALESFORCE], [])).not.toBe(base);
    expect(aliasSetHash([{ ...HUBSPOT, alias: "Hubspot" }], [])).not.toBe(base);
  });

  it("changes when a NEGATIVE alias changes — they are part of the matcher too", () => {
    expect(aliasSetHash([HUBSPOT], ["notion of"])).not.toBe(aliasSetHash([HUBSPOT], []));
  });

  it("cannot be collided by moving a separator between aliases", () => {
    const ab: AliasEntry = { ...HUBSPOT, alias: "ab" };
    const c: AliasEntry = { ...HUBSPOT, alias: "c" };
    const a: AliasEntry = { ...HUBSPOT, alias: "a" };
    const bc: AliasEntry = { ...HUBSPOT, alias: "bc" };
    expect(aliasSetHash([ab, c], [])).not.toBe(aliasSetHash([a, bc], []));
  });
});

describe("STORY-036 · candidate discovery — the precondition", () => {
  // AC8 is called "the architectural precondition that cannot be retrofitted",
  // and the story says why: without these rows, displacement cannot name who
  // took a slot and promoting a detected competitor cannot backfill history.
  // The rows have to exist from the first capture or the history is gone.

  const listOfTools = [
    "Best CRMs for scaling teams:",
    "",
    "1. HubSpot — easy pipelines",
    "2. Zoho CRM — cheapest at scale",
    "3. Pipedrive Sales — simple",
  ].join("\n");

  it("Scenario 8 — records an untracked brand with the untracked type and a NULL reference", () => {
    const mentions = match(listOfTools, [HUBSPOT]);
    const untracked = mentions.filter((m) => m.entityType === "other");

    expect(untracked.map((m) => m.entityLabel)).toEqual(["Zoho CRM", "Pipedrive Sales"]);
    for (const mention of untracked) {
      expect(mention.entityId).toBeNull();
      expect(mention.entityType).toBe("other");
    }
  });

  it("gives an untracked entity its list position, which is the whole point", () => {
    // A competitor in slot two took a slot the brand wanted. Without the
    // position, displacement has a name and no place.
    const untracked = match(listOfTools, [HUBSPOT]).filter((m) => m.entityType === "other");
    expect(untracked.map((m) => m.listPosition)).toEqual([2, 3]);
  });

  it("never proposes a KNOWN entity as a discovery", () => {
    const mentions = match(listOfTools, [HUBSPOT, { ...SALESFORCE, label: "Zoho CRM", alias: "Zoho CRM" }]);
    expect(mentions.filter((m) => m.entityType === "other").map((m) => m.entityLabel)).toEqual(["Pipedrive Sales"]);
  });

  it("does not propose capitalised prose OUTSIDE a list", () => {
    // The reference's own restriction. A capitalised phrase in prose is
    // usually a sentence start or a feature name; one occupying a slot in a
    // list of tools is a competitor taking a position.
    expect(match("Many Teams Prefer Something Else entirely.", [HUBSPOT])).toEqual([]);
  });

  it("skips a sentence-leading capital rather than proposing it as a company", () => {
    expect(match("- The best option is obvious", [HUBSPOT]).filter((m) => m.entityType === "other")).toEqual([]);
  });

  it("does not propose a single capitalised word", () => {
    // One capitalised word in a list is far more often a sentence start.
    expect(match("- Pipedrive", [HUBSPOT]).filter((m) => m.entityType === "other")).toEqual([]);
  });

  it("does not propose a phrase inside a link or a code span", () => {
    expect(match("- see https://example.com/Zoho-CRM-review", [HUBSPOT]).filter((m) => m.entityType === "other")).toEqual([]);
  });

  it("returns known and discovered mentions in ONE list, in document order", () => {
    const positions = match(listOfTools, [HUBSPOT]).map((m) => m.charStart);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
