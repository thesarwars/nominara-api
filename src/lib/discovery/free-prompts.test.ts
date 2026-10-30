import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "pg";
import { DISCOVERY_ORIGIN, generateFreeAllowance } from "./free-prompts.js";

// STORY-043 AC12 (first half) — the free prompt allowance is GENERATED at discovery, and charges nothing.
// The real statement is executed in test/integration/discovery-free-prompts.spec.ts; this file pins the decisions.

const WORKSPACE = "11111111-1111-7111-8111-111111111111";
const PROJECT = "0f9e2a7c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";

interface Stored {
  id: string;
  text: string;
  intent_archetype: string;
  funnel_stage: string;
  text_hash: Buffer;
}

function tx(opts: { project?: Record<string, unknown> | null; existing?: (Stored & { origin?: string | null })[]; hashes?: Stored[] } = {}) {
  const inserts: unknown[][] = [];
  const sqls: string[] = [];
  const project = opts.project === undefined ? { name: "HubSpot", category_slug: "crm", verticals: ["saas"], locale: null } : opts.project;
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      sqls.push(sql);
      if (sql.includes("FROM projects")) return { rows: project === null ? [] : [project] };
      if (sql.includes("INSERT INTO tracked_prompts")) {
        inserts.push(params);
        return { rows: [] };
      }
      // Every live GENERATED row, whoever wrote it: an `origin` of "discovery" marks discovery's own, anything else is another writer's.
      if (sql.includes("generation_source = 'generated'")) return { rows: (opts.existing ?? []).map((row) => ({ origin: "discovery", ...row })) };
      if (sql.includes("FROM tracked_prompts")) return { rows: opts.hashes ?? opts.existing ?? [] };
      return { rows: [] };
    }),
  } as unknown as ClientBase;
  return { client, inserts, sqls };
}

// INSERT_PROMPT_COLUMNS order: id, workspace_id, project_id, generation_batch_id, generation_source, text, text_hash,
// intent_archetype, funnel_stage, generator_meta, is_priority, status
const COL = { source: 4, text: 5, meta: 9, priority: 10, status: 11 };

describe("STORY-043 · generateFreeAllowance", () => {
  it("generates the allowance — ten prompts — and returns them in the §4.5 wire shape", async () => {
    const { client, inserts } = tx();
    const { prompts: out } = await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });

    expect(inserts).toHaveLength(10);
    expect(out).toHaveLength(10);
    for (const p of out) {
      expect(Object.keys(p).sort()).toEqual(["funnel_stage", "generation_source", "intent_archetype", "prompt_id", "text"]);
      expect(p.generation_source).toBe("discovery");
    }
  });

  it("stores them ARCHIVED: generation activates nothing, so no plan slot is consumed and nothing is charged", async () => {
    const { client, inserts } = tx();
    await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
    for (const params of inserts) expect(params[COL.status]).toBe("archived");
  });

  it("stores them as 'generated' (so the ONE free-ten of STORY-046 is not doubled) with the discovery origin in generator_meta", async () => {
    const { client, inserts } = tx();
    await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
    for (const params of inserts) {
      expect(params[COL.source]).toBe("generated");
      expect((JSON.parse(params[COL.meta] as string) as { origin: string }).origin).toBe(DISCOVERY_ORIGIN);
    }
  });

  it("is template-only: it names the project's own brand, from the row, and makes no model call", async () => {
    const { client, inserts } = tx();
    await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
    for (const params of inserts) expect((JSON.parse(params[COL.meta] as string) as { naturalized: boolean }).naturalized).toBe(false);
    expect(inserts.some((p) => String(p[COL.text]).includes("HubSpot"))).toBe(true);
  });

  it("keeps every priority prompt when it trims a full pass to ten", async () => {
    const { client, inserts } = tx();
    await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
    const priority = inserts.filter((p) => p[COL.priority] === true);
    expect(priority.length).toBeGreaterThan(0);
    expect(priority.length).toBeLessThanOrEqual(6);
  });

  it("is idempotent: a redelivered job that finds the allowance already generated inserts nothing and returns the same prompts", async () => {
    const first = tx();
    const generated = (await generateFreeAllowance(first.client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 })).prompts;
    const existing: Stored[] = generated.map((p, i) => ({
      id: p.prompt_id,
      text: p.text,
      intent_archetype: p.intent_archetype,
      funnel_stage: p.funnel_stage,
      text_hash: Buffer.from([i]),
    }));

    const second = tx({ existing });
    const again = (await generateFreeAllowance(second.client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 })).prompts;
    expect(second.inserts).toHaveLength(0);
    expect(again.map((p) => p.prompt_id)).toEqual(generated.map((p) => p.prompt_id));
  });

  it("tops up a partial earlier run to the allowance, never past it", async () => {
    const seed = tx();
    const four = (await generateFreeAllowance(seed.client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 4 })).prompts.map((p) => ({
      id: p.prompt_id,
      text: p.text,
      intent_archetype: p.intent_archetype,
      funnel_stage: p.funnel_stage,
      text_hash: Buffer.from(p.text),
    }));
    expect(four).toHaveLength(4);

    const { client, inserts } = tx({ existing: four });
    const { prompts: out, remaining } = await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
    expect(inserts).toHaveLength(6);
    expect(out).toHaveLength(10);
    expect(remaining).toBe(0);
  });

  it("a thin context (a brand and nothing else) generates only what the grammar can fill, and reports exactly that: no padding, no invented category", async () => {
    const { client, inserts } = tx({ project: { name: "HubSpot", category_slug: null, verticals: null, locale: null } });
    const { prompts: out, remaining } = await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(10);
    expect(inserts).toHaveLength(out.length);
    expect(remaining).toBe(10 - out.length);
  });

  it("an allowance of 0 generates nothing — 0 stays 0", async () => {
    const { client, inserts } = tx();
    expect(await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 0 })).toEqual({ prompts: [], remaining: 0 });
    expect(inserts).toHaveLength(0);
  });

  it("a project that no longer exists generates nothing", async () => {
    const { client, inserts } = tx({ project: null });
    expect(await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 })).toEqual({ prompts: [], remaining: 10 });
    expect(inserts).toHaveLength(0);
  });

  it("locks the project row before deciding, so two deliveries cannot both generate", async () => {
    const { client, sqls } = tx();
    await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
    expect(sqls[0]).toMatch(/FROM projects[\s\S]*FOR NO KEY UPDATE/);
  });

  it("takes no workspace_id predicate in a SELECT — RLS scopes it", async () => {
    const { client, sqls } = tx();
    await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
    for (const sql of sqls.filter((s) => s.trimStart().startsWith("SELECT"))) expect(sql).not.toContain("workspace_id");
  });

  // STORY-043 review (round 1), finding 3 — the onboarding step calls POST /prompts/generate right after creation. Those rows are
  // generated prompts too: the free ten is ONE allowance (STORY-046 counts generated rows), so discovery must not add ten more.
  describe("shares the allowance with prompts someone else generated", () => {
    const held = (n: number, origin: string | null): (Stored & { origin: string | null })[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `p${String(i)}`,
        text: `explicit ${String(i)}`,
        intent_archetype: "recommendation",
        funnel_stage: "consideration",
        text_hash: Buffer.from(`explicit ${String(i)}`),
        origin,
      }));

    it("adds none when the project already holds a full allowance of generated prompts (from the explicit generate call)", async () => {
      const { client, inserts } = tx({ existing: held(10, null) });
      const out = await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
      expect(inserts).toHaveLength(0);
      expect(out.prompts).toEqual([]);
      expect(out.remaining).toBe(0);
    });

    it("adds only the shortfall when the explicit call produced some, and reports what is left of the ten", async () => {
      const { client, inserts } = tx({ existing: held(6, null) });
      const out = await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
      expect(inserts).toHaveLength(4);
      expect(out.prompts).toHaveLength(4);
      expect(out.remaining).toBe(0);
    });

    it("more than the allowance already generated elsewhere still leaves 0 remaining, never a negative", async () => {
      const { client } = tx({ existing: held(15, null) });
      expect((await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 })).remaining).toBe(0);
    });
  });

  // Finding 2 — the real URL-only row: projects.service inserts name = root_domain, no category, no verticals.
  describe("a URL-only project (the placeholder row projects.service inserts)", () => {
    const URL_ONLY = { name: "hubspot.com", root_domain: "hubspot.com", category_slug: null, verticals: [], locale: null };

    it("never writes the domain placeholder into a prompt as though it were the brand's name", async () => {
      const { client, inserts } = tx({ project: URL_ONLY });
      await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
      for (const params of inserts) expect(String(params[COL.text]).toLowerCase()).not.toContain("hubspot.com");
    });

    it("generates only what the thin context fills, and `remaining` is exactly the unused part of the ten", async () => {
      const { client, inserts } = tx({ project: URL_ONLY });
      const out = await generateFreeAllowance(client, { workspaceId: WORKSPACE, projectId: PROJECT, allowance: 10 });
      expect(out.prompts.length).toBeLessThan(10);
      expect(inserts).toHaveLength(out.prompts.length);
      expect(out.remaining).toBe(10 - out.prompts.length);
    });
  });
});
