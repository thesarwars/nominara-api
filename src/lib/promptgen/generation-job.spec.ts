import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  buildVectorDedupe,
  commitGeneration,
  failGeneration,
  generationJobPayloadSchema,
  prepareGeneration,
  promptGenerateKey,
  runGeneration,
  type GenerationJobPayload,
  type GenerationPrepared,
} from "./generation-job.js";
import { PHASES_DONE } from "../queue/worker-factory.js";

// STORY-045 / owner decision 95(a) - the phases of the background generation job, against a recording fake client. The real statements run in
// test/integration/prompt-generation-job.spec.ts; what is pinned here is ORDER and GUARDS: where the lock is taken, what a redelivery may write,
// and that no phase is ever inside a transaction while an external call is awaited.

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "22222222-2222-7222-8222-222222222222";
const GEN = "33333333-3333-7333-8333-333333333333";
const PAYLOAD: GenerationJobPayload = { generationId: GEN, projectId: PROJECT, workspaceId: WS, kid: "k1" };

type Reply = { rows: unknown[] };
function fakeTx(reply: (sql: string, params: unknown[]) => Reply | undefined): { tx: ClientBase; sqls: string[] } {
  const sqls: string[] = [];
  const tx = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      sqls.push(sql.replace(/\s+/g, " ").trim());
      return reply(sql, params) ?? { rows: [] };
    }),
  } as unknown as ClientBase;
  return { tx, sqls };
}

const PROJECT_ROW = { name: "HubSpot", root_domain: "hubspot.com", category_slug: "crm", verticals: [], locale: null, brand_aliases: [] };

describe("STORY-045 / decision 95(a) · the job payload and key", () => {
  it("the payload is strict and names the generation, the project and the workspace", () => {
    expect(generationJobPayloadSchema.safeParse(PAYLOAD).success).toBe(true);
    expect(generationJobPayloadSchema.safeParse({ ...PAYLOAD, extra: 1 }).success).toBe(false);
    expect(generationJobPayloadSchema.safeParse({ ...PAYLOAD, generationId: "nope" }).success).toBe(false);
  });

  it("one generation is one queue key, so a re-enqueue is the same job", () => {
    expect(promptGenerateKey(GEN)).toBe(`promptgen:${GEN}`);
  });
});

describe("STORY-045 / decision 95(a) · prepare", () => {
  it("marks a pending generation running and reads the project and its live hashes in the same short transaction", async () => {
    const { tx, sqls } = fakeTx((sql) => {
      if (/FROM prompt_generations/.test(sql)) return { rows: [{ status: "pending", request: { batch_size: 2 } }] };
      if (/FROM projects/.test(sql)) return { rows: [PROJECT_ROW] };
      return undefined;
    });
    const prepared = await prepareGeneration(tx, PAYLOAD);
    expect(prepared).not.toBe(PHASES_DONE);
    expect((prepared as GenerationPrepared).request).toMatchObject({ batch_size: 2 });
    expect(sqls.some((sql) => /UPDATE prompt_generations SET status = 'running'/.test(sql))).toBe(true);
  });

  it("every statement carries workspace_id = app.current_workspace()", async () => {
    const { tx, sqls } = fakeTx((sql) => {
      if (/FROM prompt_generations/.test(sql)) return { rows: [{ status: "pending", request: {} }] };
      if (/FROM projects/.test(sql)) return { rows: [PROJECT_ROW] };
      return undefined;
    });
    await prepareGeneration(tx, PAYLOAD);
    for (const sql of sqls) expect(sql, sql).toMatch(/workspace_id = app\.current_workspace\(\)/);
  });

  it("a redelivery after the generation settled ends the job and writes nothing (idempotent under at-least-once)", async () => {
    for (const status of ["succeeded", "failed"]) {
      const { tx, sqls } = fakeTx((sql) => (/FROM prompt_generations/.test(sql) ? { rows: [{ status, request: {} }] } : undefined));
      expect(await prepareGeneration(tx, PAYLOAD)).toBe(PHASES_DONE);
      expect(sqls.filter((sql) => /^(UPDATE|INSERT)/.test(sql))).toEqual([]);
    }
  });

  it("a generation that is not this workspace's (or is gone) ends the job quietly", async () => {
    const { tx } = fakeTx(() => ({ rows: [] }));
    expect(await prepareGeneration(tx, PAYLOAD)).toBe(PHASES_DONE);
  });

  it("a project deleted since the request settles the generation failed(project_not_found) rather than retrying", async () => {
    const { tx, sqls } = fakeTx((sql) => (/FROM prompt_generations/.test(sql) ? { rows: [{ status: "pending", request: {} }] } : undefined));
    expect(await prepareGeneration(tx, PAYLOAD)).toBe(PHASES_DONE);
    expect(sqls.some((sql) => /UPDATE prompt_generations SET status = 'failed'/.test(sql))).toBe(true);
  });
});

describe("STORY-045 / decision 95(a) · the vector port runs outside any transaction", () => {
  it("the embedder is awaited with NO tenant transaction open, and each comparison is its own short one", async () => {
    let open = 0;
    const openAtEmbed: number[] = [];
    const withTenantTx = async <T>(_workspaceId: string, fn: (tx: ClientBase) => Promise<T>): Promise<T> => {
      open += 1;
      try {
        return await fn({ query: async () => ({ rows: [] }) } as unknown as ClientBase);
      } finally {
        open -= 1;
      }
    };
    const embedder = {
      model: "m",
      embed: async (texts: readonly string[]) => {
        openAtEmbed.push(open);
        return { vectors: texts.map(() => [1, 0]), totalTokens: 1 };
      },
    };
    const port = buildVectorDedupe(embedder, PROJECT, WS, withTenantTx);
    const vectors = await port.embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    await port.compare(vectors);
    await port.compare(vectors);
    expect(openAtEmbed).toEqual([0]);
    expect(open).toBe(0);
  });

  it("an embedder that throws propagates (generate.ts then falls back to exact-hash dedupe) and holds nothing open", async () => {
    let open = 0;
    const withTenantTx = async <T>(_w: string, fn: (tx: ClientBase) => Promise<T>): Promise<T> => {
      open += 1;
      try { return await fn({} as ClientBase); } finally { open -= 1; }
    };
    const port = buildVectorDedupe({ model: "m", embed: async () => { throw new Error("provider down"); } }, PROJECT, WS, withTenantTx);
    await expect(port.embed(["a"])).rejects.toThrow("provider down");
    expect(open).toBe(0);
  });
});

describe("STORY-045 / decision 95(a) · commit", () => {
  const prepared = { generationId: GEN, workspaceId: WS, projectId: PROJECT, request: {}, project: PROJECT_ROW, existingHashes: new Map() } as unknown as GenerationPrepared;
  const emptyPass = {
    rows: [], candidates: [], rejected: [], coverage: [],
    summary: { requested: 15, generated: 0, accepted: 0, rejected_duplicate: 0, activated: 0, priority_flagged: 0 },
    cached: false, topicNorm: "",
  } as never;

  it("locks the generation row first and does nothing when another delivery already settled it", async () => {
    const { tx, sqls } = fakeTx((sql) => (/FROM prompt_generations/.test(sql) ? { rows: [{ status: "succeeded" }] } : undefined));
    expect(await commitGeneration(tx, prepared, emptyPass)).toBe("already_settled");
    expect(sqls[0]).toMatch(/FROM prompt_generations .* FOR UPDATE/);
    expect(sqls.filter((sql) => /^(UPDATE|INSERT)/.test(sql))).toEqual([]);
  });

  it("takes the project lock only after the generation row, re-reads the hashes, then settles succeeded in the same transaction", async () => {
    const { tx, sqls } = fakeTx((sql) => {
      if (/FROM prompt_generations/.test(sql)) return { rows: [{ status: "running" }] };
      if (/FOR NO KEY UPDATE/.test(sql)) return { rows: [{ id: PROJECT }] };
      return undefined;
    });
    expect(await commitGeneration(tx, prepared, emptyPass)).toBe("committed");
    const at = (re: RegExp): number => sqls.findIndex((sql) => re.test(sql));
    expect(at(/FROM prompt_generations/)).toBeLessThan(at(/FOR NO KEY UPDATE/));
    expect(at(/FOR NO KEY UPDATE/)).toBeLessThan(at(/SELECT id, text_hash FROM tracked_prompts/));
    expect(at(/SELECT id, text_hash FROM tracked_prompts/)).toBeLessThan(at(/UPDATE prompt_generations SET status = 'succeeded'/));
  });
});

describe("STORY-045 / decision 95(a) · failing a generation", () => {
  it("only an unsettled generation can be failed, and it never touches the wallet or the ledger", async () => {
    const { tx, sqls } = fakeTx(() => ({ rows: [{ id: GEN }] }));
    expect(await failGeneration(tx, GEN, "generation_failed")).toBe(true);
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toMatch(/UPDATE prompt_generations SET status = 'failed'/);
    expect(sqls[0]).toMatch(/status IN \('pending', 'running'\)/);
    expect(sqls.join(" ")).not.toMatch(/credit|wallet|ledger|usage/i);
  });

  it("reports false when nothing was unsettled (a delivery that lost the race)", async () => {
    const { tx } = fakeTx(() => ({ rows: [] }));
    expect(await failGeneration(tx, GEN, "generation_failed")).toBe(false);
  });
});

describe("STORY-045 / decision 95(a) · run", () => {
  it("is not a database phase: it takes no client at all", () => {
    expect(runGeneration.length).toBe(2);
  });
});

describe("decision 112 · the project's confirmed competitors fill the competitor slot", () => {
  const NONE = { naturaliser: null, vectorDedupe: null, cache: null };
  const prep = (project: Record<string, unknown>, request: Record<string, unknown> = {}) =>
    ({ generationId: GEN, workspaceId: WS, projectId: PROJECT, request, project, existingHashes: new Map() }) as unknown as GenerationPrepared;
  const headToHead = (pass: Awaited<ReturnType<typeof runGeneration>>) => pass.candidates.filter((c) => c.archetype === "head_to_head");

  it("a stored competitor fills the competitor slot when the request supplies none (alternatives.a1, migration_switching.a1)", async () => {
    const pass = await runGeneration(prep({ ...PROJECT_ROW, competitors: ["Salesforce"] }), NONE);
    const ids = pass.candidates.filter((c) => c.slots.competitor === "Salesforce").map((c) => c.templateId);
    expect(ids).toEqual(expect.arrayContaining(["alternatives.a1"]));
  });

  // head_to_head.a1 is "Is {brand} or {competitor} better for {persona}?": it needs a persona as well, which only the request carries.
  it("a stored competitor unlocks head_to_head.a1 once a persona is known", async () => {
    const pass = await runGeneration(prep({ ...PROJECT_ROW, competitors: ["Salesforce"] }, { brand_context: { personas: ["sales leaders"] } }), NONE);
    expect(headToHead(pass).map((c) => [c.templateId, c.slots.competitor])).toEqual([["head_to_head.a1", "Salesforce"]]);
  });

  it("no stored and no supplied competitor: no competitor-named prompt", async () => {
    const pass = await runGeneration(prep({ ...PROJECT_ROW, competitors: [] }), NONE);
    expect(pass.candidates.some((c) => c.competitorNamed)).toBe(false);
  });

  it("request-supplied competitors win over the stored ones", async () => {
    const pass = await runGeneration(prep({ ...PROJECT_ROW, competitors: ["Salesforce"] }, { brand_context: { competitors: [{ name: "Pipedrive" }] } }), NONE);
    const named = pass.candidates.filter((c) => c.competitorNamed).map((c) => c.slots.competitor);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((n) => n === "Pipedrive")).toBe(true);
  });

  it("prepare reads only live competitors of this project in this workspace, inside the same transaction", async () => {
    const { tx, sqls } = fakeTx((sql) => {
      if (/FROM prompt_generations/.test(sql)) return { rows: [{ status: "pending", request: {} }] };
      if (/FROM projects/.test(sql)) return { rows: [{ ...PROJECT_ROW, competitors: ["Salesforce"] }] };
      return undefined;
    });
    const prepared = (await prepareGeneration(tx, PAYLOAD)) as GenerationPrepared;
    expect(prepared.project.competitors).toEqual(["Salesforce"]);
    const read = sqls.find((sql) => /FROM competitors/.test(sql))!;
    expect(read).toMatch(/project_id = p\.id/);
    expect(read).toMatch(/workspace_id = app\.current_workspace\(\)/);
    expect(read).toMatch(/deleted_at IS NULL/);
  });
});
