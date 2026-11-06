import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_RESEARCH_DISCOVER_COUNT, discoverPromptsResponseSchema, keepPromptsResponseSchema } from "../../../contracts/tools/index.js";
import { PriceChangedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import * as generate from "../../lib/promptgen/generate.js";
import { quoteActivation } from "../../lib/promptgen/activation-charge.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
vi.mock("../../lib/tools/tools-engine-set.js", () => ({
  toolsEngineSet: async () => [{ engine_key: "perplexity", display_name: "Perplexity" }, { engine_key: "chatgpt", display_name: "ChatGPT" }],
}));
import { PromptResearchService } from "./prompt-research.service.js";

// STORY-080 - Discover, Keep and the estimate, with the database and the queue replaced by fakes: what is under test is the service's decisions
// (what is free, what is charged, at what rate, and what is refused before anything is written). Scenario numbers are the story's table.

const WS = "00000000-0000-7000-8000-000000000001";
const ACTOR = "00000000-0000-7000-8000-000000000002";
const RICH = { category_slug: "crm", personas: ["marketing_director"], verticals: ["b2b_saas"], size_bands: ["mid_market"], integrations: ["slack"], compliance_terms: ["soc2"], capabilities: ["pipeline_automation"], competitors: [{ name: "Salesforce" }] };

const ENTITLEMENTS = { "prompts.credits_per_generated": { value: 1 }, "tools.engine_set": { value: 2 } };

function build(over: { price?: number } = {}) {
  const entitlements = { ...ENTITLEMENTS, "prompts.credits_per_generated": { value: over.price ?? 1 } };
  const startRun = vi.fn(async () => ({ id: "00000000-0000-7000-8000-0000000000aa", expiresAt: new Date(), creditsCharged: 0 }));
  const finishRun = vi.fn(async () => ({}));
  const tools = { startRun, finishRun };
  const resolver = { resolve: vi.fn(async () => ({ entitlements })), resolveForWorkspace: vi.fn(async () => ({ entitlements })) };
  const client = { query: vi.fn(async (sql: string) => (/entitlement_version/u.test(sql) ? { rows: [{ entitlement_version: 3 }] } : /credit_wallets/u.test(sql) ? { rows: [] } : { rows: [] })) };
  const service = new PromptResearchService(tools as never, resolver as never, {} as never, { connect: vi.fn() } as never);
  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => withTenantContext(client as never, { workspaceId: WS, actorId: ACTOR }, fn);
  return { service, startRun, finishRun, inTenant, entitlements };
}

describe("STORY-080 Discover", () => {
  it("scenario 1 - a brand with its context, and a topic with its context, each return the documented 15, archetype-aligned", async () => {
    const { service, inTenant } = build();
    for (const body of [{ brand_name: "Acme CRM", context: RICH }, { topic: "crm software", context: RICH }]) {
      const out = await inTenant(() => service.discover(body));
      expect(discoverPromptsResponseSchema.safeParse(out).success).toBe(true);
      expect(out.requested).toBe(PROMPT_RESEARCH_DISCOVER_COUNT);
      expect(out.generated).toBe(15);
      expect(out.candidates).toHaveLength(15);
      expect(new Set(out.candidates.map((c) => c.archetype)).size).toBe(15);
    }
  });
  it("scenario 1 - with no context the generator honestly returns fewer, and says what was requested", async () => {
    const { service, inTenant } = build();
    const out = await inTenant(() => service.discover({ brand_name: "Acme" }));
    expect(out.requested).toBe(15);
    expect(out.generated).toBeLessThan(15);
    expect(out.candidates).toHaveLength(out.generated);
  });
  it("scenario 2 - the candidates come from the project generator, with no second generation path", async () => {
    const spy = vi.spyOn(generate, "generatePass");
    const { service, inTenant } = build();
    await inTenant(() => service.discover({ topic: "crm", context: RICH }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].naturaliser).toBeNull();
    spy.mockRestore();
  });
  it("scenario 3 - generating writes nothing and debits nothing: no run, no debit, no partial charge", async () => {
    const { service, inTenant, startRun } = build();
    const out = await inTenant(() => service.discover({ brand_name: "Acme", context: RICH }));
    expect(out.credits_charged).toBe(0);
    expect(startRun).not.toHaveBeenCalled();
  });
  it("a discover with neither a brand nor a topic is refused", async () => {
    const { service, inTenant } = build();
    await expect(inTenant(() => service.discover({}))).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe("STORY-080 Keep", () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });
  it("scenario 4 - keeping 3 charges 3, the run records the kept count as its charge basis, and the ledger entry names it", async () => {
    const out = await ctx.inTenant(() => ctx.service.keep({ prompts: ["a", "b", "c"] }, "3"));
    expect(keepPromptsResponseSchema.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({ kept_count: 3, credits_per_prompt: 1, credits_charged: 3 });
    expect(ctx.startRun).toHaveBeenCalledWith(expect.objectContaining({ toolKey: "prompt_research", credits: 3, promptTexts: ["a", "b", "c"], engineKeys: [], unitDetail: { prompts: 3, engines: 0, cells_charged: 0, cells_cached: 0 } }));
    expect(ctx.finishRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headline: { items_kept: 3 } }));
  });
  it("scenario 5 - the per-prompt price is the in-project generation price, for every plan price", async () => {
    for (const price of [0, 1, 2, 7]) {
      const c = build({ price });
      const quote = await quoteActivation({ query: vi.fn(async () => ({ rows: [{ n: 99 }] })) } as never, {
        projectId: "p",
        candidates: [{ id: "x", generationSource: "generated", firstActivatedAt: null }],
        entitlements: c.entitlements,
      });
      const kept = await c.inTenant(() => c.service.keep({ prompts: ["a", "b"] }, String(price * 2)));
      // Beyond the free allowance a generated prompt costs `quote.price`; the tool charges exactly that per prompt kept.
      expect(kept.credits_per_prompt).toBe(quote.price);
    }
  });
  it("the confirmed figure is required and must equal the recomputed total (400 absent, 409 price_changed on a mismatch) - nothing is written", async () => {
    await expect(ctx.inTenant(() => ctx.service.keep({ prompts: ["a", "b"] }, undefined))).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(ctx.inTenant(() => ctx.service.keep({ prompts: ["a", "b"] }, "1"))).rejects.toBeInstanceOf(PriceChangedError);
    expect(ctx.startRun).not.toHaveBeenCalled();
  });
  it("a keep above the run shape's ten prompts is refused with the limit named, and an empty keep is refused", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `p${String(i)}`);
    await expect(ctx.inTenant(() => ctx.service.keep({ prompts: eleven }, "11"))).rejects.toThrow(/10/u);
    await expect(ctx.inTenant(() => ctx.service.keep({ prompts: [] }, "0"))).rejects.toBeInstanceOf(ValidationFailedError);
    expect(ctx.startRun).not.toHaveBeenCalled();
  });
});

describe("STORY-080 estimate", () => {
  it("scenario 7 - the estimate recomputes for every selection size and states the total the control restates", async () => {
    const { service, inTenant } = build();
    const totals: number[] = [];
    for (let n = 0; n <= 10; n += 1) {
      const e = await inTenant(() => service.estimate({ mode: "keep", prompt_count: n }));
      expect(e.total_credits).toBe(n * 1);
      totals.push(e.total_credits);
    }
    expect(new Set(totals).size).toBe(11);
  });
  it("scenario 7 - a run estimate is prompts x engines x 5, names the engines, and flags the eleventh prompt", async () => {
    const { service, inTenant } = build();
    const four = await inTenant(() => service.estimate({ mode: "run", prompt_count: 4 }));
    const five = await inTenant(() => service.estimate({ mode: "run", prompt_count: 5 }));
    expect(four.engines).toHaveLength(2);
    expect(four.credits_per_unit).toBe(5);
    expect(five.total_credits - four.total_credits).toBe(5 * four.engines.length);
    expect(four.total_credits).toBe(5 * 4 * four.engines.length);
    const eleven = await inTenant(() => service.estimate({ mode: "run", prompt_count: 11 }));
    expect(eleven).toMatchObject({ within_cap: false, max_prompts: 10 });
  });
});
