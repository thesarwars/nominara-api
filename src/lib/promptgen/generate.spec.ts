import { describe, expect, it, vi } from "vitest";
import { generatePass, type GeneratePassInput } from "./generate.js";
import { promptTextHash } from "./text-hash.js";

// STORY-045 — the pipeline, §4 steps 1 through 8 composed.
//
// PURE APART FROM THE INJECTED PORTS. It takes the existing project's text
// hashes as a value rather than querying for them, so the whole pipeline —
// including FR-FAN-01a's backfill, which is the part most likely to loop
// forever or drop a variant — is testable without a database.

const BATCH = "01a06ccd-0000-7000-8000-0000000000ff";

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
    const cache = new Map<string, readonly string[]>();

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
    const cache = new Map<string, readonly string[]>();

    await generatePass(input({ naturaliser, cache }));
    expect(cache.size).toBe(0);
  });

  it("keys the cache on the normalised topic, so two phrasings share one entry", async () => {
    const naturaliser = { naturalise: vi.fn(async (r: { lines: readonly string[] }) => [...r.lines]) };
    const cache = new Map<string, readonly string[]>();

    await generatePass(input({ naturaliser, cache, topicHint: "Lead Management Platforms!" }));
    await generatePass(input({ naturaliser, cache, topicHint: "lead management platform" }));

    expect(naturaliser.naturalise).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
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
