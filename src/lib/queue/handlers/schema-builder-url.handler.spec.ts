import { readFileSync } from "node:fs";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import { schemaBuilderUrlResultSchema } from "../../../../contracts/tools/index.js";
import { CATALOG_ROWS } from "../../../../test/support/aux-rules.js";
import type { GuardedResponse } from "../../net/guarded-fetch.js";
import { GuardedFetchRefusal } from "../../net/guarded-fetch.js";
import { PHASES_DONE, phasesOf } from "../worker-factory.js";
import type { QueueHandlerContext } from "../handlers.js";
import { createLookupExecuteHandler } from "./lookup-execute.handler.js";
import { createSchemaBuilderUrlPhases } from "./schema-builder-url.handler.js";

// STORY-083 AC5 / decision 82 - the worker half of Schema Builder URL mode. Phases are driven directly with a fake tenant client, so the ADR-0003 shape is
// visible: `prepare` and `commit` take the transaction, `run` takes none. Scenario ids are SH-n.

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const URL_ = "https://shop.example/products/crm";
const PAYLOAD = { tool: "schema_builder", toolRunId: RUN, targetUrl: URL_, startedAt: "2026-11-09T10:00:00.000Z", workspaceId: WORKSPACE };
const job = (over: { attemptsMade?: number; attempts?: number } = {}): Job => ({ data: { payload: PAYLOAD }, attemptsMade: over.attemptsMade ?? 0, opts: { attempts: over.attempts ?? 3 } }) as unknown as Job;
const CATALOG_DB = CATALOG_ROWS.map((r) => ({ code: r.code, category: r.category, title: r.title, weight: String(r.weight), rule_version: r.ruleVersion, thresholds: r.thresholds, task_threshold: r.taskThreshold, auto_fixable: r.autoFixable, rationale: r.rationale }));
const PRODUCT_NO_PRICE = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Acme", offers: { "@type": "Offer" } })}</script>`;
const page = (body: string, over: Partial<GuardedResponse> = {}): GuardedResponse => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(`<html><head><title>x</title>${body}</head><body><main><p>Pricing: $37 per month.</p></main></body></html>`), finalUrl: URL_, ...over });

function setup(opts: { runStatus?: string | null; fetch?: () => Promise<GuardedResponse> } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (/FROM tool_runs/.test(sql)) return { rows: opts.runStatus === null ? [] : [{ status: opts.runStatus ?? "running" }] };
      if (/FROM aux_rule_catalog/.test(sql)) return { rows: CATALOG_DB };
      return { rows: [] };
    },
  } as unknown as ClientBase;
  const finished: { id: string; finish: Record<string, unknown> }[] = [];
  const phases = createSchemaBuilderUrlPhases({ pool: {}, env: {} } as unknown as QueueHandlerContext, {
    tools: async () => ({ finishRun: async (id: string, finish: Record<string, unknown>) => void finished.push({ id, finish }) }) as never,
    check: { fetch: opts.fetch ?? (async () => page(PRODUCT_NO_PRICE)) },
    now: () => new Date("2026-11-09T10:00:05.000Z"),
  });
  return { tx, queries, finished, phases };
}

describe("STORY-083 AC5 · the Schema Builder URL worker", () => {
  it("SH-1 prepare reads the run row under the workspace predicate and returns the catalog; a settled run (a redelivery) does nothing and reads no catalog", async () => {
    const live = setup();
    const prepared = await live.phases.prepare(live.tx, job());
    expect(prepared).not.toBe(PHASES_DONE);
    expect(live.queries[0]!.sql).toContain("app.current_workspace()");
    expect(live.queries.some((q) => /aux_rule_catalog/.test(q.sql))).toBe(true);

    const settled = setup({ runStatus: "completed" });
    expect(await settled.phases.prepare(settled.tx, job())).toBe(PHASES_DONE);
    expect(settled.queries.some((q) => /aux_rule_catalog/.test(q.sql))).toBe(false);
    const missing = setup({ runStatus: null });
    expect(await missing.phases.prepare(missing.tx, job())).toBe(PHASES_DONE);
  });

  it("SH-2 a checked page finishes the run: a result with the findings, not failed, free of any error code", async () => {
    const h = setup();
    const prepared = (await h.phases.prepare(h.tx, job())) as never;
    const fetched = await h.phases.run(prepared, job());
    await h.phases.commit(h.tx, prepared, fetched, job());
    expect(h.finished).toHaveLength(1);
    const { id, finish } = h.finished[0]!;
    expect(id).toBe(RUN);
    expect(finish.failed).toBeFalsy();
    expect(finish.errorCode).toBeUndefined();
    const result = schemaBuilderUrlResultSchema.parse(finish.result);
    expect(result.state).toBe("checked");
    if (result.state === "checked") expect(result.findings.some((f) => f.rule_code === "AUX-R-012")).toBe(true);
  });

  it("SH-3 an unreachable page finishes the run as FAILED with a reason, and says nothing about the page", async () => {
    const h = setup({ fetch: async () => { throw new GuardedFetchRefusal("address_not_global"); } });
    const prepared = (await h.phases.prepare(h.tx, job())) as never;
    await h.phases.commit(h.tx, prepared, await h.phases.run(prepared, job()), job());
    expect(h.finished[0]!.finish).toMatchObject({ failed: true, errorCode: "page_unreachable", result: { schema_version: 1, source: "url", state: "unreachable", reason: "refused" } });
  });

  it("SH-4 the last attempt of a failing job settles the run as failed instead of dead-lettering it; an earlier attempt leaves the error to the queue", async () => {
    const h = setup();
    expect(await h.phases.recover!(h.tx, job({ attemptsMade: 0, attempts: 3 }), { error: new Error("x"), phase: "run" })).toBe(false);
    expect(h.finished).toHaveLength(0);
    expect(await h.phases.recover!(h.tx, job({ attemptsMade: 2, attempts: 3 }), { error: new Error("x"), phase: "run" })).toBe(true);
    expect(h.finished[0]).toMatchObject({ id: RUN, finish: { failed: true, errorCode: "schema_builder_job_failed" } });
    // A failed run never keeps the placeholder: `pending` states nothing, and a settled run must state something.
    const result = schemaBuilderUrlResultSchema.parse(h.finished[0]!.finish["result"]);
    expect(result.state).not.toBe("pending");
  });

  it("SH-5 a payload for another tool is refused at parse, never run as a URL check", async () => {
    const h = setup();
    const wrong = { data: { payload: { ...PAYLOAD, tool: "aux_audit" } }, opts: {} } as unknown as Job;
    await expect(h.phases.prepare(h.tx, wrong)).rejects.toThrow();
  });

  it("SH-6 the lookup.execute dispatcher routes a schema_builder job here, and not to the scan", async () => {
    const h = setup();
    const processor = createLookupExecuteHandler({ pool: {}, env: {} } as unknown as QueueHandlerContext, { cache: {} as never, schemaBuilderUrl: { tools: async () => ({ finishRun: async () => undefined }) as never } });
    const phases = phasesOf(processor)!;
    const prepared = await phases.prepare(h.tx, job());
    expect(prepared).not.toBe(PHASES_DONE);
    expect(h.queries.some((q) => /aux_rule_catalog/.test(q.sql))).toBe(true);
  });

  it("SH-7 emits a span, a metric and a log line carrying the run and workspace ids and never the URL or a finding", async () => {
    const logs: unknown[] = [];
    const spies = [vi.spyOn(Logger.prototype, "log"), vi.spyOn(Logger.prototype, "warn")].map((s) => s.mockImplementation((m: unknown) => void logs.push(m)));
    try {
      const h = setup();
      const prepared = (await h.phases.prepare(h.tx, job())) as never;
      await h.phases.commit(h.tx, prepared, await h.phases.run(prepared, job()), job());
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(logs).toContainEqual(expect.objectContaining({ metric: "nominara_tools_schema_builder_url_runs_total", outcome: "checked" }));
    const line = logs.find((l) => (l as { event?: string }).event === "tools.schema_builder_url.finished") as Record<string, unknown>;
    expect(line).toMatchObject({ workspace_id: WORKSPACE, run_id: RUN, outcome: "checked" });
    expect(JSON.stringify(logs)).not.toContain("shop.example");
  });

  it("SH-8 the worker has no fetch path of its own", () => {
    const source = readFileSync(new URL("./schema-builder-url.handler.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:https?|undici|\bfetch\(|axios|got\(/u);
  });
});
