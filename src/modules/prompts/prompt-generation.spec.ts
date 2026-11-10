import { Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreconditionUnmetError, NotFoundError } from "../../api/errors/domain-errors.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { PromptsService } from "./prompts.service.js";

// STORY-045 / owner decision 95(a) - the REQUEST half of background generation: validate, record a pending generation, answer 202, enqueue
// after commit. No external call is possible here (the service holds no naturaliser, no embedder and no cache), and a failed enqueue is
// compensated rather than left pending for ever.

const WS = "11111111-1111-7111-8111-111111111111";
const ACTOR = "22222222-2222-7222-8222-222222222222";
const PROJECT = "0f9e2a7c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";

function harness(options: { projectExists?: boolean; enqueue?: () => Promise<unknown>; row?: Record<string, unknown> | null } = {}) {
  const events: string[] = [];
  const sqls: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = sql.replace(/\s+/g, " ").trim();
      sqls.push({ sql: text, params });
      if (text === "COMMIT") events.push("COMMIT");
      if (/^INSERT INTO prompt_generations/.test(text)) events.push("INSERT");
      if (/FROM projects/.test(text)) return { rows: options.projectExists === false ? [] : [{ id: PROJECT }] };
      if (/FROM prompt_generations/.test(text)) return { rows: options.row === undefined || options.row === null ? [] : [options.row] };
      return { rows: [] };
    }),
  } as unknown as ClientBase;
  const enqueueTenantJob = vi.fn(async (...args: unknown[]) => {
    events.push("ENQUEUE");
    void args;
    return options.enqueue === undefined ? {} : options.enqueue();
  });
  const compensation: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        compensation.push(sql.replace(/\s+/g, " ").trim());
        return { rows: [] };
      },
      release: () => undefined,
    }),
  } as unknown as Pool;
  const service = new PromptsService(pool, { enqueueTenantJob } as never);
  const run = <T>(fn: () => Promise<T>): Promise<T> => withTenantContext(client, { workspaceId: WS, actorId: ACTOR }, fn);
  return { service, run, events, sqls, enqueueTenantJob, compensation };
}

afterEach(() => vi.restoreAllMocks());

describe("STORY-045 / decision 95(a) · POST /prompts/generate records and answers at once", () => {
  it("records ONE pending generation and answers with a pointer, not with prompts", async () => {
    const h = harness();
    const response = await h.run(() => h.service.requestGeneration(PROJECT, {} as never));
    expect(response).toEqual({ generation_batch_id: expect.stringMatching(/^[0-9a-f-]{36}$/), status: "pending", poll_url: expect.stringContaining(response.generation_batch_id) });
    expect(response.poll_url).toBe(`/v1/projects/${PROJECT}/prompts/generations/${response.generation_batch_id}`);
    expect(h.sqls.filter((q) => /^INSERT INTO prompt_generations/.test(q.sql))).toHaveLength(1);
    expect(h.sqls.some((q) => /INSERT INTO tracked_prompts/.test(q.sql))).toBe(false);
  });

  it("stores the validated request, so the job re-runs the SAME pass, and carries workspace_id = app.current_workspace()", async () => {
    const h = harness();
    const request = { batch_size: 2, topic_hint: "crm" } as never;
    await h.run(() => h.service.requestGeneration(PROJECT, request));
    const insert = h.sqls.find((q) => /^INSERT INTO prompt_generations/.test(q.sql))!;
    expect(insert.sql).toMatch(/app\.current_workspace\(\)/);
    expect(JSON.parse(insert.params.find((p) => typeof p === "string" && p.startsWith("{")) as string)).toMatchObject({ batch_size: 2, topic_hint: "crm" });
  });

  it("enqueues the signed job only AFTER the transaction commits, keyed by the generation", async () => {
    const h = harness();
    const response = await h.run(() => h.service.requestGeneration(PROJECT, {} as never));
    expect(h.events).toEqual(["INSERT", "COMMIT", "ENQUEUE"]);
    const [queue, workspaceId, payload, options] = h.enqueueTenantJob.mock.calls[0]!;
    expect(queue).toBe("prompt.generate");
    expect(workspaceId).toBe(WS);
    expect(payload).toEqual({ generationId: response.generation_batch_id, projectId: PROJECT });
    expect(options).toMatchObject({ idempotencyKey: `promptgen:${response.generation_batch_id}` });
  });

  it("makes no network call and holds no provider: the service takes only a pool and a queue producer", () => {
    expect(PromptsService.length).toBeLessThanOrEqual(2);
  });

  it("an unknown project is a 404 and records nothing", async () => {
    const h = harness({ projectExists: false });
    await expect(h.run(() => h.service.requestGeneration(PROJECT, {} as never))).rejects.toBeInstanceOf(NotFoundError);
    expect(h.sqls.some((q) => /^INSERT INTO prompt_generations/.test(q.sql))).toBe(false);
    expect(h.enqueueTenantJob).not.toHaveBeenCalled();
  });

  it("the two capability gaps are still refused BEFORE anything is recorded", async () => {
    const h = harness();
    await expect(h.run(() => h.service.requestGeneration(PROJECT, { options: { auto_activate: true } } as never))).rejects.toBeInstanceOf(PreconditionUnmetError);
    await expect(h.run(() => h.service.requestGeneration(PROJECT, { generation: { strategy: "model_first" } } as never))).rejects.toBeInstanceOf(PreconditionUnmetError);
    expect(h.sqls.some((q) => /^INSERT INTO prompt_generations/.test(q.sql))).toBe(false);
    expect(h.enqueueTenantJob).not.toHaveBeenCalled();
  });

  it("a failed enqueue is compensated: the generation is settled failed(dispatch_failed), never left pending", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const h = harness({ enqueue: async () => { throw new Error("redis down"); } });
    await h.run(() => h.service.requestGeneration(PROJECT, {} as never));
    await vi.waitFor(() => expect(h.compensation.some((sql) => /UPDATE prompt_generations SET status = 'failed'/.test(sql))).toBe(true));
    const update = h.compensation.find((sql) => /UPDATE prompt_generations/.test(sql))!;
    expect(update).toMatch(/status IN \('pending', 'running'\)/);
  });

  it("logs the workspace ID and nothing of the request body", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const h = harness();
    await h.run(() => h.service.requestGeneration(PROJECT, { topic_hint: "secret-topic-text", brand_context: { brand_name: "Secret Brand" } } as never));
    const lines = JSON.stringify(log.mock.calls);
    expect(lines).toContain(WS);
    expect(lines).toContain("nominara_prompts_generation_requests_total");
    expect(lines).not.toContain("secret-topic-text");
    expect(lines).not.toContain("Secret Brand");
  });
});

describe("STORY-045 / decision 95(a) · GET /prompts/generations/{id}", () => {
  const GEN = "33333333-3333-7333-8333-333333333333";
  const base = { id: GEN, project_id: PROJECT, created_at: new Date("2026-11-10T10:00:00Z"), completed_at: null, failure_code: null, result: null };

  it("reads a pending generation as pending with no result", async () => {
    const h = harness({ row: { ...base, status: "pending" } });
    const got = await h.run(() => h.service.readGeneration(PROJECT, GEN));
    expect(got).toEqual({ generation_batch_id: GEN, project_id: PROJECT, status: "pending", result: null, failure_code: null, requested_at: "2026-11-10T10:00:00.000Z", completed_at: null });
    expect(h.sqls.filter((q) => /^SELECT (?!set_config)/.test(q.sql)).every((q) => /workspace_id = app\.current_workspace\(\)/.test(q.sql))).toBe(true);
  });

  it("reads a failed generation with its closed failure code and no result (never a partial pass)", async () => {
    const h = harness({ row: { ...base, status: "failed", failure_code: "generation_failed", completed_at: new Date("2026-11-10T10:00:09Z") } });
    const got = await h.run(() => h.service.readGeneration(PROJECT, GEN));
    expect(got).toMatchObject({ status: "failed", failure_code: "generation_failed", result: null, completed_at: "2026-11-10T10:00:09.000Z" });
  });

  it("is a 404 for a generation that is not in this project and workspace", async () => {
    const h = harness({ row: null });
    await expect(h.run(() => h.service.readGeneration(PROJECT, GEN))).rejects.toBeInstanceOf(NotFoundError);
  });
});
