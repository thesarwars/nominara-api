import { describe, expect, it, vi } from "vitest";
import { generatePass, type GeneratePassInput } from "./generate.js";
import { promptTextHash } from "./text-hash.js";
import type { VectorComparison, VectorDedupePort } from "./vector-dedupe.js";

// STORY-045 — the pipeline, §4 steps 1 through 8 composed.
//
// PURE APART FROM THE INJECTED PORTS. It takes the existing project's text
// hashes as a value rather than querying for them, so the whole pipeline —
// including FR-FAN-01a's backfill, which is the part most likely to loop
// forever or drop a variant — is testable without a database.

const BATCH = "01a06ccd-0000-7000-8000-0000000000ff";

/** The L5 port over a Map, so a test can look at what was stored. */
function memoryCache() {
  const store = new Map<string, readonly string[]>();
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key)),
    set: (key: string, lines: readonly string[]) => {
      store.set(key, lines);
      return Promise.resolve();
    },
  };
}

const FULL_CONTEXT = {
  brandName: "HubSpot CRM",
  categorySlug: "crm",
  competitors: ["Salesforce"],
  personas: ["marketing_director"],
  verticals: ["b2b_saas"],
  sizeBands: ["mid_market"],
  integrations: ["slack"],
  complianceTerms: ["soc2"],
  capabilities: ["pipeline_automation"],
};

function input(overrides: Partial<GeneratePassInput> = {}): GeneratePassInput {
  return {
    generationBatchId: BATCH,
    workspaceId: "01a0676a-a3e5-7d2f-9da8-144bcae0adfd",
    projectId: "01a06ccd-9e37-7f0c-957b-195fa6d263dd",
    context: FULL_CONTEXT,
    existingHashes: new Set<string>(),
    batchSize: 1,
    prioritySubsetSize: 6,
    naturaliser: null,
    temperature: 0.35,
    ...overrides,
  };
}

describe("STORY-045 · generatePass — scenario 1, a full pass", () => {
  it("produces fifteen accepted variants with all fifteen archetypes covered", async () => {
    const pass = await generatePass(input());
    expect(pass.summary.accepted).toBe(15);
    expect(pass.summary.generated).toBe(15);
    expect(pass.summary.rejected_duplicate).toBe(0);
    expect(pass.coverage.filter((c) => c.represented)).toHaveLength(15);
    expect(pass.rows).toHaveLength(15);
  });

  it("reports `requested` as what the plan asked for, not what came out", async () => {
    // A pass that produced four must not report four as requested — the
    // difference between the two is the only signal that context was thin.
    const thin = await generatePass(input({ context: { categorySlug: "crm" } }));
    expect(thin.summary.requested).toBe(15);
    expect(thin.summary.generated).toBeLessThan(15);
  });

  it("flags the priority subset and reports its size", async () => {
    const pass = await generatePass(input());
    expect(pass.summary.priority_flagged).toBe(6);
    expect(pass.rows.filter((r) => r.isPriority)).toHaveLength(6);
  });

  it("activates nothing — scenario 10, and FR-FAN-01g", async () => {
    // Generation is free and uncapped. `activated: 0` here is not a
    // placeholder: STORY-046 owns activation, and every row lands archived so
    // the pass consumes no plan slot at all.
    const pass = await generatePass(input());
    expect(pass.summary.activated).toBe(0);
    expect(pass.rows.every((r) => r.status === "archived")).toBe(true);
  });
});

describe("STORY-045 · generatePass — scenario 6, dedupe against the project", () => {
  it("rejects a candidate colliding with an existing prompt and names it", async () => {
    const first = await generatePass(input());
    const collidingRow = first.rows[0]!;

    const second = await generatePass(
      input({ existingHashes: new Map([[collidingRow.textHash.toString("hex"), "01a06ccd-1111-7000-8000-000000000001"]]) }),
    );

    const rejected = second.rejected.find((r) => r.text_hash === promptTextHash(collidingRow.text).wire);
    expect(rejected).toBeDefined();
    expect(rejected?.reason).toBe("rejected_duplicate");
    // §4 step 5: "keeping the earlier prompt". The caller has to be able to
    // show WHAT it collided with, not only that it collided.
    expect(rejected?.conflicting_prompt_id).toBe("01a06ccd-1111-7000-8000-000000000001");
  });

  it("keeps the earlier prompt — the duplicate is never persisted", async () => {
    const first = await generatePass(input());
    const hash = first.rows[0]!.textHash.toString("hex");

    const second = await generatePass(input({ existingHashes: new Map([[hash, "01a06ccd-1111-7000-8000-000000000001"]]) }));

    expect(second.rows.some((r) => r.textHash.toString("hex") === hash)).toBe(false);
  });

  it("BACKFILLS from a secondary template rather than returning short — FR-FAN-01a", async () => {
    // "the engine backfills from secondary templates until 15 are accepted or
    // all templates are exhausted". A rejected candidate must not just leave
    // a hole; its archetype gets another surface.
    const first = await generatePass(input());
    const collided = first.rows[0]!;

    const second = await generatePass(input({ existingHashes: new Map([[collided.textHash.toString("hex"), "p-1"]]) }));

    expect(second.summary.accepted).toBe(15);
    expect(second.summary.rejected_duplicate).toBe(1);
    // The archetype is still represented, from a different surface.
    const meta = second.rows.map((r) => r.generatorMeta as { template_id: string });
    expect(meta.some((m) => m.template_id === (collided.generatorMeta as { template_id: string }).template_id)).toBe(false);
    expect(second.coverage.filter((c) => c.represented)).toHaveLength(15);
  });

  it("returns fewer and reports the reason once every surface is exhausted", async () => {
    // The other ending FR-FAN-01a documents. Every template of every
    // archetype is pre-seeded as existing, so backfill has nowhere to go.
    const probe = await generatePass(input({ batchSize: 4 }));
    const everyHash = new Map(probe.rows.map((r) => [r.textHash.toString("hex"), "p-existing"]));

    const exhausted = await generatePass(input({ batchSize: 4, existingHashes: everyHash }));

    expect(exhausted.summary.accepted).toBe(0);
    expect(exhausted.summary.rejected_duplicate).toBeGreaterThan(0);
    expect(exhausted.rows).toHaveLength(0);
    // A pass that produced nothing is still a successful pass, reported.
    expect(exhausted.coverage.every((c) => !c.represented)).toBe(true);
  });

  it("dedupes WITHIN the batch, not only against the project", async () => {
    // Two archetypes can emit identical text from different surfaces. Left
    // in, the second INSERT violates ux_prompts_project_hash and takes the
    // whole pass down — the collision has to be caught before persistence.
    const pass = await generatePass(input({ batchSize: 4 }));
    const hashes = pass.rows.map((r) => r.textHash.toString("hex"));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("terminates rather than looping when backfill cannot make progress", async () => {
    // The loop's guard. Each round skips the colliding surfaces and re-emits;
    // if a round accepts nothing new it must stop, or a pathological set of
    // existing hashes spins forever on the request path.
    const probe = await generatePass(input({ batchSize: 4 }));
    const everyHash = new Map(probe.rows.map((r) => [r.textHash.toString("hex"), "p"]));
    await expect(generatePass(input({ batchSize: 4, existingHashes: everyHash }))).resolves.toBeDefined();
  });
});

describe("STORY-045 · generatePass — scenario 5, determinism (FR-FAN-01d)", () => {
  it("produces identical rows for identical input, naturaliser disabled", async () => {
    const a = await generatePass(input());
    const b = await generatePass(input());
    // Ids are UUIDv7 and differ by design; everything else must match.
    const strip = (pass: Awaited<ReturnType<typeof generatePass>>) =>
      pass.rows.map(({ id: _id, ...rest }) => ({ ...rest, textHash: rest.textHash.toString("hex") }));
    expect(strip(a)).toEqual(strip(b));
    expect(a.summary).toEqual(b.summary);
    expect(a.coverage).toEqual(b.coverage);
  });
});

describe("STORY-045 · generatePass — the naturaliser and the L5 cache", () => {
  it("uses the naturaliser when one is supplied", async () => {
    const naturaliser = { naturalise: vi.fn(async (r: { lines: readonly string[] }) => r.lines.map((l) => `rewritten: ${l}`)) };
    const pass = await generatePass(input({ naturaliser }));
    expect(naturaliser.naturalise).toHaveBeenCalledTimes(1);
    expect(pass.rows.every((r) => r.text.startsWith("rewritten: "))).toBe(true);
    expect(pass.rows.every((r) => (r.generatorMeta as { naturalized: boolean }).naturalized)).toBe(true);
  });

  it("scenario 9 — a cached naturalised array costs no model call", async () => {
    const naturaliser = { naturalise: vi.fn(async (r: { lines: readonly string[] }) => r.lines.map((l) => `rewritten: ${l}`)) };
    const cache = memoryCache();

    const first = await generatePass(input({ naturaliser, cache }));
    expect(first.cached).toBe(false);
    expect(naturaliser.naturalise).toHaveBeenCalledTimes(1);

    const second = await generatePass(input({ naturaliser, cache }));
    expect(second.cached).toBe(true);
    expect(naturaliser.naturalise).toHaveBeenCalledTimes(1);
    expect(second.rows.map((r) => r.text)).toEqual(first.rows.map((r) => r.text));
  });

  it("does not cache a failed rewrite", async () => {
    // Caching the template text under the naturalised key would make a
    // transient model outage look like the permanent answer for thirty days.
    const naturaliser = { naturalise: vi.fn(async () => Promise.reject(new Error("503"))) };
    const cache = memoryCache();

    await generatePass(input({ naturaliser, cache }));
    expect(cache.store.size).toBe(0);
  });

  it("AC3 hazard - the cache is keyed on the TEMPLATE input too, so another project's brand is never served from it", async () => {
    // Same workspace, same (empty) topic, same grammar version, DIFFERENT brand. Keyed on topic alone, project B would be handed project
    // A's naturalised lines - A's brand name inside B's prompts. It was unreachable while only a stub naturaliser existed.
    const naturaliser = { naturalise: vi.fn(async (r: { lines: readonly string[] }) => r.lines.map((l) => `rewritten: ${l}`)) };
    const cache = memoryCache();

    await generatePass(input({ naturaliser, cache }));
    const other = await generatePass(input({ naturaliser, cache, context: { ...FULL_CONTEXT, brandName: "Zendesk Sell" } }));

    expect(other.cached).toBe(false);
    expect(naturaliser.naturalise).toHaveBeenCalledTimes(2);
    expect(other.rows.some((r) => r.text.includes("HubSpot"))).toBe(false);
    expect(other.rows.some((r) => r.text.includes("Zendesk Sell"))).toBe(true);
  });

  it("AC3 hazard - a rewrite that collides with an existing prompt's hash keeps its template text instead of failing the INSERT", async () => {
    const plain = await generatePass(input());
    const rewrittenHash = promptTextHash(`real: ${plain.rows[0]!.text}`).bytes.toString("hex");
    const existing = new Map([[rewrittenHash, "01a06ccd-0000-7000-8000-0000000000aa"]]);
    const naturaliser = { naturalise: vi.fn(async (r: { lines: readonly string[] }) => r.lines.map((l) => `real: ${l}`)) };

    const pass = await generatePass(input({ naturaliser, existingHashes: existing }));

    expect(pass.rows[0]!.text).toBe(plain.rows[0]!.text);
    expect((pass.rows[0]!.generatorMeta as { naturalized: boolean }).naturalized).toBe(false);
    expect(pass.rows).toHaveLength(15);
    expect(pass.rows.some((r) => promptTextHash(r.text).bytes.toString("hex") === rewrittenHash)).toBe(false);
  });

  it("AC3 hazard - two lines rewritten to the SAME text: the earlier keeps the rewrite, the later keeps its template", async () => {
    const plain = await generatePass(input());
    const a = plain.rows.findIndex((r) => r.text === "Best crm for pipeline automation?");
    const b = plain.rows.findIndex((r) => r.text === "Which crm has the best pipeline automation?");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    const naturaliser = {
      naturalise: vi.fn(async (r: { lines: readonly string[] }) => r.lines.map((l, i) => (i === a || i === b ? "crm pipeline automation, which is best?" : l))),
    };

    const pass = await generatePass(input({ naturaliser }));

    const hashes = pass.rows.map((r) => promptTextHash(r.text).bytes.toString("hex"));
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(pass.rows[a]!.text).toBe("crm pipeline automation, which is best?");
    expect(pass.rows[b]!.text).toBe(plain.rows[b]!.text);
  });

  it("keys the cache on the normalised topic, so two phrasings share one entry", async () => {
    const naturaliser = { naturalise: vi.fn(async (r: { lines: readonly string[] }) => [...r.lines]) };
    const cache = memoryCache();

    await generatePass(input({ naturaliser, cache, topicHint: "Lead Management Platforms!" }));
    await generatePass(input({ naturaliser, cache, topicHint: "lead management platform" }));

    expect(naturaliser.naturalise).toHaveBeenCalledTimes(1);
    expect(cache.store.size).toBe(1);
  });
});

describe("STORY-045 · generatePass — the archetype plan", () => {
  it("honours an exclusion", async () => {
    const pass = await generatePass(input({ excludeArchetypes: ["objection_risk"] }));
    expect(pass.coverage.some((c) => c.intent_archetype === "objection_risk")).toBe(false);
    expect(pass.coverage).toHaveLength(14);
  });

  it("honours an explicit include list", async () => {
    const pass = await generatePass(input({ includeArchetypes: ["recommendation", "support_quality"] }));
    expect(pass.coverage.map((c) => c.intent_archetype)).toEqual(["recommendation", "support_quality"]);
    expect(pass.summary.requested).toBe(2);
  });

  it("emits `batch_size` variants per included archetype", async () => {
    const pass = await generatePass(input({ includeArchetypes: ["support_quality"], batchSize: 3 }));
    expect(pass.summary.accepted).toBe(3);
    expect(pass.summary.requested).toBe(3);
  });
});

// STORY-045 AC6 - §4 step 5, the vector half. The port is faked: the SQL half is test/integration/promptgen-vector-dedupe.spec.ts.

const EXISTING_ID = "01a06ccd-0000-7000-8000-0000000000e1";

/** Each text gets a one-element "vector" holding its ordinal, so `compare` can look the text back up. */
function fakePort(rule: {
  nearest?: (text: string) => { promptId: string; cosine: number } | null;
  pairs?: (texts: readonly string[]) => VectorComparison["batchPairs"];
  embedThrows?: boolean;
  compareThrows?: boolean;
} = {}) {
  const texts: string[] = [];
  const embedCalls: string[][] = [];
  const port: VectorDedupePort = {
    embed: vi.fn(async (batch: readonly string[]) => {
      if (rule.embedThrows) throw new Error("embedding provider unreachable");
      embedCalls.push([...batch]);
      return batch.map((text) => [texts.push(text) - 1]);
    }),
    compare: vi.fn(async (vectors: readonly (readonly number[])[]) => {
      if (rule.compareThrows) throw new Error("sql failed");
      const batch = vectors.map((v) => texts[v[0]!]!);
      return { nearest: batch.map((text) => rule.nearest?.(text) ?? null), batchPairs: rule.pairs?.(batch) ?? [] };
    }),
  };
  return { port, embedCalls };
}

describe("STORY-045 AC6 - generatePass vector dedupe", () => {
  it("embeds the whole batch in ONE call and compares it in ONE round trip", async () => {
    const { port, embedCalls } = fakePort();
    const pass = await generatePass(input({ vectorDedupe: port }));
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(15);
    expect(embedCalls[0]).toEqual(pass.rows.map((r) => r.text));
    expect(port.compare).toHaveBeenCalledTimes(1);
  });

  it("scenario 6 - a near-duplicate of an existing prompt is rejected, the earlier prompt kept, the reason and the conflicting id reported", async () => {
    const { port } = fakePort({ nearest: (text) => (text.includes("recommend") ? { promptId: EXISTING_ID, cosine: 0.95 } : null) });
    const pass = await generatePass(input({ vectorDedupe: port }));

    const rejected = pass.rejected.find((r) => r.intent_archetype === "recommendation");
    expect(rejected).toMatchObject({ reason: "rejected_duplicate", conflicting_prompt_id: EXISTING_ID });
    expect(pass.summary.rejected_duplicate).toBe(pass.rejected.length);
    expect(pass.rows.some((r) => r.text === rejected!.text)).toBe(false);
  });

  it("FR-FAN-01a - a vector rejection is BACKFILLED from the archetype's next template, embedding only the replacement", async () => {
    const { port, embedCalls } = fakePort({ nearest: (text) => (text.includes("recommend") ? { promptId: EXISTING_ID, cosine: 0.95 } : null) });
    const pass = await generatePass(input({ vectorDedupe: port }));

    expect(pass.rows).toHaveLength(15);
    expect(pass.coverage.every((c) => c.represented)).toBe(true);
    const rejected = pass.rejected.find((r) => r.intent_archetype === "recommendation")!;
    expect(pass.candidates.find((c) => c.archetype === "recommendation")!.templateId).not.toBe(rejected.template_id);
    expect(embedCalls).toHaveLength(2);
    expect(embedCalls[1]).toHaveLength(1);
  });

  it("within the batch the earlier prompt is kept and the later one rejected (no conflicting id: the kept one has none yet)", async () => {
    const { port } = fakePort({
      pairs: (texts) => {
        const a = texts.findIndex((t) => t.startsWith("Best crm for pipeline automation"));
        const b = texts.findIndex((t) => t.startsWith("Which crm has the best pipeline automation"));
        return a >= 0 && b > a ? [{ earlier: a, later: b, cosine: 0.97 }] : [];
      },
    });
    const pass = await generatePass(input({ vectorDedupe: port }));
    const rejected = pass.rejected.find((r) => r.text.startsWith("Which crm has the best pipeline automation"));
    expect(rejected).toMatchObject({ reason: "rejected_duplicate", conflicting_prompt_id: null });
    expect(pass.rows.some((r) => r.text.startsWith("Best crm for pipeline automation"))).toBe(true);
  });

  it("reports novelty from the measurement: a number when compared (0 stays 0), null when there was nothing to compare against", async () => {
    const { port } = fakePort({
      nearest: (text) => (text.includes("support") ? { promptId: EXISTING_ID, cosine: 0 } : text.includes("soc2") ? { promptId: EXISTING_ID, cosine: 0.4 } : null),
    });
    const pass = await generatePass(input({ vectorDedupe: port }));
    const byArchetype = (a: string) => pass.candidates.find((c) => c.archetype === a)!.novelty;
    expect(byArchetype("support_quality")).toEqual({ maxCosineToExisting: 0, nearestPromptId: EXISTING_ID });
    expect(byArchetype("compliance_security")).toEqual({ maxCosineToExisting: 0.4, nearestPromptId: EXISTING_ID });
    expect(byArchetype("buyer_shortlist")).toEqual({ maxCosineToExisting: null, nearestPromptId: null });
  });

  it("without a vector port novelty is simply absent (exact-hash dedupe only), as before", async () => {
    const pass = await generatePass(input());
    expect(pass.candidates.every((c) => c.novelty === undefined)).toBe(true);
  });

  it("FAIL OPEN - an embedding failure degrades to exact-hash dedupe: fifteen still produced, no novelty claimed, nothing thrown", async () => {
    const { port } = fakePort({ embedThrows: true });
    const pass = await generatePass(input({ vectorDedupe: port }));
    expect(pass.rows).toHaveLength(15);
    expect(pass.candidates.every((c) => c.novelty === undefined)).toBe(true);
    expect(port.compare).not.toHaveBeenCalled();
  });

  it("a SQL failure is NOT swallowed: it has aborted the request transaction, so continuing would write into a dead one", async () => {
    const { port } = fakePort({ compareThrows: true });
    await expect(generatePass(input({ vectorDedupe: port }))).rejects.toThrow("sql failed");
  });

  it("terminates when EVERYTHING is a duplicate, returning fewer rather than looping", async () => {
    const { port } = fakePort({ nearest: () => ({ promptId: EXISTING_ID, cosine: 0.99 }) });
    const pass = await generatePass(input({ vectorDedupe: port }));
    expect(pass.rows).toHaveLength(0);
    expect(pass.summary.accepted).toBe(0);
    expect(pass.summary.rejected_duplicate).toBe(pass.rejected.length);
    expect(pass.rejected.length).toBeGreaterThanOrEqual(15);
  });

  it("the template-only pass is still deterministic with a vector port (FR-FAN-01d)", async () => {
    const a = await generatePass(input({ vectorDedupe: fakePort().port }));
    const b = await generatePass(input({ vectorDedupe: fakePort().port }));
    expect(a.rows.map((r) => r.text)).toEqual(b.rows.map((r) => r.text));
  });
});
