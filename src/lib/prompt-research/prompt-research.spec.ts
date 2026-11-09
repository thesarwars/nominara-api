import { describe, expect, it } from "vitest";
import {
  PROMPT_RESEARCH_ALSO_MENTIONED_THRESHOLD,
  promptResearchResultSchema,
  promptResearchRunRequestSchema,
  promptResearchRunAcceptedSchema,
} from "../../../contracts/tools/index.js";
import { aggregateResearch, type ResearchAnswer } from "./aggregate.js";
import { extractEntities } from "./entities.js";
import { runPromptResearch, ResearchCaptureError, type ResearchPorts } from "./run-research.js";

// STORY-080 - the pure parts of Prompt Research: what an answer names, what a run's answers add up to, and how the cells are asked.
// Scenario numbers are the story's Test scenarios table.

const answer = (engine: string, promptIndex: number, entities: string[], domains: string[] = []): ResearchAnswer => ({ engine, promptIndex, entities, domains });

function keysOf(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keysOf(v, path));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [path + k, ...keysOf(v, `${path}${k}.`)]);
  return [];
}
/** Every property name a zod object schema declares, however deep (walks the JSON Schema the contract publishes). */
function schemaKeys(schema: import("zod").ZodType): string[] {
  const json = JSON.parse(JSON.stringify((schema as unknown as { toJSONSchema?: () => unknown }).toJSONSchema?.() ?? {})) as unknown;
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "properties" && v !== null && typeof v === "object") found.push(...Object.keys(v));
        walk(v);
      }
    }
  };
  walk(json);
  return found;
}

describe("STORY-080 scenario 8 - the run response schema has no brand-privileging field", () => {
  const BRAND_WORDS = /brand|own(ed|er)?|your|mine|self|home|highlight|competitor|tracked_entity|is_you/iu;
  it("the run request, the accepted response and the stored result name no brand and mark no entity", () => {
    for (const [schema, atLeast] of [[promptResearchRunRequestSchema, 1], [promptResearchRunAcceptedSchema, 5], [promptResearchResultSchema, 8]] as const) {
      const keys = schemaKeys(schema).filter((key) => key !== "not_tracked" && key !== "not_tracked_note");
      // The walk must actually have seen the schema's properties, or an empty list would pass for any shape.
      expect(keys.length).toBeGreaterThanOrEqual(atLeast);
      expect(keys.filter((key) => BRAND_WORDS.test(key))).toEqual([]);
    }
  });
  it("a run request that names a brand is refused (strict), not silently dropped", () => {
    expect(promptResearchRunRequestSchema.safeParse({ prompt_texts: ["best crm"], brand_name: "Acme" }).success).toBe(false);
  });
});

describe("STORY-080 scenario 6 - the per-run prompt cap", () => {
  it("ten prompts pass, the eleventh is refused with the limit named", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `prompt ${String(i)}`);
    expect(promptResearchRunRequestSchema.safeParse({ prompt_texts: ten }).success).toBe(true);
    const eleven = promptResearchRunRequestSchema.safeParse({ prompt_texts: [...ten, "one more"] });
    expect(eleven.success).toBe(false);
    expect(JSON.stringify(eleven.error?.issues)).toContain("capped at 10 prompts");
  });
  it("an empty selection is refused too (the database shape check cannot catch it)", () => {
    expect(promptResearchRunRequestSchema.safeParse({ prompt_texts: [] }).success).toBe(false);
  });
});

describe("STORY-080 entity extraction - what an answer names", () => {
  it("reads bolded names and the head of list items; one entity once per answer", () => {
    const text = "Top picks:\n1. **Stripe Billing** - the default for SaaS\n2. Chargebee: strong for subscriptions\n- [Recurly](https://recurly.com) handles dunning\n\n**Stripe Billing** is also cheap.";
    expect(extractEntities(text)).toEqual(["Stripe Billing", "Chargebee", "Recurly"]);
  });
  it("does not report headings and generic labels as entities", () => {
    expect(extractEntities("**Pros**\n- **Pricing** is fair\n**Summary**: use it")).toEqual([]);
  });
  it("does not report a whole sentence as one entity", () => {
    expect(extractEntities("1. This is a very long sentence about how the tooling works in general, really\n")).toEqual([]);
  });
  it("an empty answer names nothing", () => {
    expect(extractEntities("")).toEqual([]);
  });
});

describe("STORY-080 scenarios 10, 11 - ranked by share of answer, below the threshold collapsed", () => {
  const MIN = PROMPT_RESEARCH_ALSO_MENTIONED_THRESHOLD;
  it("ranks entities by answers named and computes share over all detected mentions (scenario 10)", () => {
    const answers = [
      answer("chatgpt", 0, ["HubSpot", "Zoho"], ["g2.com"]),
      answer("chatgpt", 1, ["HubSpot", "Salesforce"], ["g2.com", "reddit.com"]),
      answer("perplexity", 0, ["HubSpot", "Salesforce"], ["g2.com"]),
      answer("perplexity", 1, ["Salesforce", "Zoho"], []),
      answer("gemini", 0, ["Salesforce", "Zoho"], []),
    ];
    const out = aggregateResearch({ prompts: ["a", "b"], asked: 5, answers, failures: [], engines: ["chatgpt", "perplexity", "gemini"] });
    expect(out.result.entities.map((e) => [e.name, e.answers_named])).toEqual([["Salesforce", 4], ["HubSpot", 3], ["Zoho", 3]]);
    expect(out.result.entities[0]!.share_of_answer).toBeCloseTo(4 / 10, 6);
    expect(out.result.entities.reduce((a, e) => a + e.share_of_answer, 0)).toBeCloseTo(1, 6);
    expect(out.result.domains).toEqual([{ domain: "g2.com", citations: 3, answers_cited: 3 }, { domain: "reddit.com", citations: 1, answers_cited: 1 }]);
    expect(out.entitiesFound).toBe(3);
  });
  it(`an entity named in ${String(MIN - 1)} answers is collapsed, in exactly ${String(MIN)} it is ranked (boundary)`, () => {
    const answers = [
      ...[0, 1, 2].map((i) => answer("chatgpt", i, ["Peer"])),
      ...[0, 1].map((i) => answer("chatgpt", i, ["Once"])),
    ];
    const out = aggregateResearch({ prompts: ["a", "b", "c"], asked: 3, answers, failures: [], engines: ["chatgpt"] });
    expect(out.result.entities.map((e) => e.name)).toEqual(["Peer"]);
    expect(out.result.also_mentioned).toEqual([{ name: "Once", answers_named: 2 }]);
    expect(out.entitiesFound).toBe(2);
  });
  it("the stored result satisfies its own contract", () => {
    const out = aggregateResearch({ prompts: ["a"], asked: 1, answers: [answer("chatgpt", 0, ["A"], ["x.com"])], failures: [], engines: ["chatgpt"] });
    expect(promptResearchResultSchema.safeParse(out.result).success).toBe(true);
  });
});

describe("STORY-080 scenario 9 - absence is visible, never hidden", () => {
  it("answers that name entities, none of them the one the customer cares about, produce a normal ranked list with no brand slot to hide in", () => {
    const answers = [0, 1, 2].map((i) => answer("chatgpt", i, ["HubSpot"]));
    const out = aggregateResearch({ prompts: ["a", "b", "c"], asked: 3, answers, failures: [], engines: ["chatgpt"] });
    expect(out.result.entities.map((e) => e.name)).toEqual(["HubSpot"]);
    expect(keysOf(out.result)).not.toContain("brand_present");
  });
  it("answers that name nothing report a measured zero, not an absent figure; no answers at all report null", () => {
    const empty = aggregateResearch({ prompts: ["a"], asked: 1, answers: [answer("chatgpt", 0, [])], failures: [], engines: ["chatgpt"] });
    expect(empty.entitiesFound).toBe(0);
    expect(empty.result.entities).toEqual([]);
    const none = aggregateResearch({ prompts: ["a"], asked: 1, answers: [], failures: [{ engine: "chatgpt", prompt_index: 0, code: "timeout", reason: "x" }], engines: ["chatgpt"] });
    expect(none.entitiesFound).toBeNull();
  });
});

describe("STORY-080 scenarios 12, 13 - outcome of the cells", () => {
  const ports = (impl: (engine: string, prompt: string) => Promise<string>): ResearchPorts => ({
    cached: async () => undefined,
    capture: async (engine, prompt) => ({ text: await impl(engine, prompt), latencyMs: 1 }),
    now: () => new Date(),
  });
  it("every cell failing leaves no answers; every engine is reported failed with its code", async () => {
    const out = await runPromptResearch({ engines: ["a", "b"], prompts: ["p1", "p2"], deadlineMs: 1000 }, ports(async () => { throw new ResearchCaptureError("timeout"); }));
    expect(out.answers).toEqual([]);
    expect(out.failures).toHaveLength(4);
    expect(out.failures.every((f) => f.code === "timeout")).toBe(true);
  });
  it("one engine failing leaves the other's answers and names the failure", async () => {
    const out = await runPromptResearch({ engines: ["a", "b"], prompts: ["p1"], deadlineMs: 1000 }, ports(async (engine) => {
      if (engine === "b") throw new ResearchCaptureError("timeout");
      return "1. **HubSpot** - good";
    }));
    expect(out.answers.map((a) => [a.engine, a.entities])).toEqual([["a", ["HubSpot"]]]);
    expect(out.failures).toEqual([expect.objectContaining({ engine: "b", prompt_index: 0, code: "timeout" })]);
  });
  it("a cell still outstanding at the deadline is a named deadline_exceeded failure; what landed is kept", async () => {
    const out = await runPromptResearch({ engines: ["a", "b"], prompts: ["p1"], deadlineMs: 30 }, ports((engine) => (engine === "a" ? Promise.resolve("**X** here") : new Promise<string>(() => undefined))));
    expect(out.answers.map((a) => a.engine)).toEqual(["a"]);
    expect(out.failures).toEqual([expect.objectContaining({ engine: "b", code: "deadline_exceeded" })]);
    expect(out.deadlineReached).toBe(true);
  });
  it("no capture starts after the deadline: lanes stop taking cells once the run is closed", async () => {
    let started = 0;
    const slow: ResearchPorts = {
      cached: async () => undefined,
      capture: () => {
        started += 1;
        return new Promise((_, reject) => setTimeout(() => reject(new ResearchCaptureError("timeout")), 80));
      },
      now: () => new Date(),
    };
    const out = await runPromptResearch({ engines: ["a"], prompts: ["1", "2", "3", "4", "5", "6", "7"], deadlineMs: 30 }, slow);
    expect(out.deadlineReached).toBe(true);
    const atDeadline = started;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(started).toBe(atDeadline);
    expect(atDeadline).toBe(3);
  });
});
