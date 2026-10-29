import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { createCrawlDiscoverHandler } from "./crawl-discover.handler.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { DiscoverDeps } from "../../discovery/discover.js";
import { phasesOf } from "../worker-factory.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";

vi.mock("../../telemetry/metrics.js", () => ({ observeValue: vi.fn(), incrementCounter: vi.fn() }));

// STORY-043 scenario 2 — "read the project before discovery finishes:
// usable, initialising, discovery running."

const PROJECT = "0f9e2a7c-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
const WORKSPACE = "11111111-1111-7111-8111-111111111111";

function jobWith(payload: Record<string, unknown>): Job {
  return { data: { payload: { workspaceId: WORKSPACE, kid: "k1", ...payload } } } as unknown as Job;
}

function txRecording(
  calls: { sql: string; params: unknown[] }[],
  projectRows: unknown[] = [{ root_domain: "hubspot.com", discovery: {} }],
) {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: sql.includes("SELECT root_domain") ? projectRows : [] };
    }),
  } as unknown as ClientBase;
}

const CONTEXT = { pool: {} as never, env: {} as never } satisfies QueueHandlerContext;

function depsServing(html: string): DiscoverDeps {
  return {
    fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(html), finalUrl: "https://hubspot.com/" })),
    now: () => Date.now(),
  };
}

const PAGE = `<html lang="en-US"><head>
  <script type="application/ld+json">{"@type":"Organization","name":"HubSpot"}</script>
</head></html>`;

describe("STORY-043 · crawl.discover handler", () => {
  it("scenario 2 — marks the project running BEFORE discovering, so a poll mid-flight says so", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(txRecording(calls), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    const running = calls.findIndex((c) => c.sql.includes("discovery_status = 'running'"));
    const final = calls.findIndex((c) => c.sql.includes("SET discovery = $2"));
    expect(running).toBeGreaterThanOrEqual(0);
    expect(final).toBeGreaterThan(running);
  });

  it("writes the whole review payload and the resulting status", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(txRecording(calls), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as { fields: Record<string, unknown>; discovery_status: string };
    expect(payload.discovery_status).toBe("completed");
    expect(payload.fields.brand_name).toBeDefined();
    expect(write.params[2]).toBe("completed");
  });

  // §4.5's "never silent": a discovered value is applied by STORY-044's
  // confirm step, not by the pass that found it. Asserted as the ABSENCE of
  // any write to those columns, which stays true as fields are added.
  it("applies nothing — it writes the review payload, never the project's own columns", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(txRecording(calls), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    const updates = calls.filter((c) => c.sql.includes("UPDATE projects")).map((c) => c.sql).join(" ");
    for (const column of ["SET name", "name =", "category_slug =", "brand_aliases =", "description ="]) {
      expect(updates, `discovery must not write ${column}`).not.toContain(column);
    }
  });

  it("skips a project that no longer exists rather than failing the job", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    // RLS makes another tenant's project invisible, which lands here as the
    // same empty result as a deleted one — both mean "nothing to enrich".
    await expect(
      handler(txRecording(calls, []), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] })),
    ).resolves.toBeUndefined();

    expect(calls.some((c) => c.sql.includes("UPDATE projects"))).toBe(false);
  });

  it("reads root_domain from the ROW, not from the job payload", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    // A page with no brand facts, so everything derivable comes from the
    // DOMAIN — which is the only way to tell which source was used.
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing("<html></html>"));

    await handler(
      txRecording(calls, [{ root_domain: "notion.so", discovery: {} }]),
      jobWith({ projectId: PROJECT, rootUrl: "https://notion.so", fieldsSupplied: [] }),
    );

    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as { fields: Record<string, { value: unknown }> };
    expect(payload.fields.aliases?.value).toEqual(["Notion"]);
    // And "Notion" is a common word, so the negatives follow from the same stem.
    expect(payload.fields.negative_aliases?.value).toContain("the notion");
  });

  it("carries fieldsSupplied through, so a supplied field is never re-proposed", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(
      txRecording(calls),
      jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: ["name"] }),
    );

    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as { fields: Record<string, unknown> };
    expect(payload.fields.brand_name).toBeUndefined();
  });

  it("takes no workspace_id predicate — RLS scopes the transaction (NFR-SEC-01)", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(txRecording(calls), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    for (const call of calls) {
      expect(call.sql, "the tenant filter belongs in the policy, not in application SQL").not.toContain("workspace_id");
    }
  });

  it("rejects a payload of the wrong shape at the boundary", async () => {
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));
    await expect(handler(txRecording([]), jobWith({ projectId: "not-a-uuid" }))).rejects.toThrow();
  });

  // STORY-044 AC4 / scenario 5 — the durable half of the confirm story.
  it("scenario 5 — a human-overridden field survives re-discovery untouched", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const overridden = {
      fields: {
        brand_name: { value: "HubSpot, Inc.", confidence: 1, source: "Organization schema", user_edited: true },
      },
    };
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(
      txRecording(calls, [{ root_domain: "hubspot.com", discovery: overridden }]),
      jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }),
    );

    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as {
      fields: Record<string, { value: unknown; user_edited?: boolean }>;
    };
    // The page says "HubSpot"; the human said "HubSpot, Inc.". The human wins,
    // and the record that a human decided survives too — without the second
    // half the NEXT pass would happily re-derive it.
    expect(payload.fields.brand_name?.value).toBe("HubSpot, Inc.");
    expect(payload.fields.brand_name?.user_edited).toBe(true);
  });

  it("scenario 5 — fields NOT overridden are still re-derived normally", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const overridden = {
      fields: { brand_name: { value: "Held", confidence: 1, user_edited: true } },
    };
    const handler = createCrawlDiscoverHandler(
      CONTEXT,
      depsServing(`<html lang="fr-FR"><head>
        <script type="application/ld+json">{"@type":"Organization","name":"Fresh","description":"New copy."}</script>
      </head></html>`),
    );

    await handler(
      txRecording(calls, [{ root_domain: "hubspot.com", discovery: overridden }]),
      jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }),
    );

    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as { fields: Record<string, { value: unknown }> };
    expect(payload.fields.brand_name?.value).toBe("Held");
    expect(payload.fields.description?.value).toBe("New copy.");
    expect(payload.fields.locale?.value).toBe("fr-FR");
  });

  it("a field merely ACCEPTED (not overridden) is re-derived — only a human override is sticky", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const accepted = {
      fields: { brand_name: { value: "Old", confidence: 0.96, user_edited: false } },
    };
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(
      txRecording(calls, [{ root_domain: "hubspot.com", discovery: accepted }]),
      jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }),
    );

    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as { fields: Record<string, { value: unknown }> };
    expect(payload.fields.brand_name?.value).toBe("HubSpot");
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
// ADR-0003 / NFR-ARCH-04 — no transaction across the fetch. AC8, AC11, AC12 (first half), AC15.
// ---------------------------------------------------------------------------------------------------------------------------------

const COMPARISON_PAGE = `<html><head><title>HubSpot | CRM</title></head><body>
  <a href="/compare/hubspot-vs-salesforce">HubSpot vs Salesforce</a></body></html>`;

/** A transaction stub rich enough for the commit phase's prompt generation: a real project row, no prior prompts. */
function richTx(
  calls: { sql: string; params: unknown[] }[],
  opts: { existingDiscoveryPrompts?: unknown[]; projectRow?: Record<string, unknown> } = {},
) {
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT root_domain")) return { rows: [{ root_domain: "hubspot.com", discovery: {}, ...opts.projectRow }] };
      if (sql.includes("FROM projects") && sql.includes("FOR NO KEY UPDATE")) {
        return { rows: [{ name: "HubSpot", root_domain: "hubspot.com", category_slug: "crm", verticals: ["saas"], locale: null }] };
      }
      if (sql.includes("generation_source = 'generated'")) return { rows: opts.existingDiscoveryPrompts ?? [] };
      return { rows: [] };
    }),
  } as unknown as ClientBase;
}

describe("STORY-043 · crawl.discover is a phased job (ADR-0003)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is registered as a PHASED processor, so the production worker splits the transaction", () => {
    expect(phasesOf(createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE)))).toBeDefined();
  });

  it("AC8 / KAD-06 — the fetch happens with NO transaction: prepare's client is untouched from the moment the fetch begins", async () => {
    const prepareCalls: { sql: string; params: unknown[] }[] = [];
    const commitCalls: { sql: string; params: unknown[] }[] = [];
    const events: string[] = [];
    const prepareTx = richTx(prepareCalls);
    const inner = prepareTx.query as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    (prepareTx as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => {
      events.push("tx1");
      return inner(sql, params);
    };
    const deps: DiscoverDeps = {
      fetch: vi.fn(async () => {
        events.push("fetch");
        return { status: 200, headers: {}, body: Buffer.from(PAGE), finalUrl: "https://hubspot.com/" };
      }),
      now: () => Date.now(),
    };
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, deps))!;
    const job = jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] });

    const prepared = await phases.prepare(prepareTx, job);
    const fetched = await phases.run(prepared as never, job);
    await phases.commit(richTx(commitCalls), prepared as never, fetched, job);

    expect(events.indexOf("fetch")).toBeGreaterThan(events.lastIndexOf("tx1"));
    expect(prepareCalls.some((c) => c.sql.includes("discovery_status = 'running'"))).toBe(true);
    expect(commitCalls.some((c) => c.sql.includes("SET discovery = $2"))).toBe(true);
    // Nothing written by the commit phase marks the project running a second time, and the fetch phase wrote nothing.
    expect(commitCalls.some((c) => c.sql.includes("discovery_status = 'running'"))).toBe(false);
  });
});

describe("STORY-043 · crawl.discover writes competitors and the free allowance into the review payload", () => {
  afterEach(() => vi.restoreAllMocks());

  it("AC11 — competitors_proposed from the site's own comparison link reach the payload with a basis", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(COMPARISON_PAGE));
    await handler(richTx(calls), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as { competitors_proposed: { name: string; basis: string }[] };
    expect(payload.competitors_proposed).toEqual([expect.objectContaining({ name: "Salesforce", basis: "own comparison page" })]);
  });

  it("AC12 — the free allowance is generated (10 inserts, archived) and reported; the payload says 0 credits and 0 remaining", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));
    await handler(richTx(calls), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    expect(calls.filter((c) => c.sql.includes("INSERT INTO tracked_prompts"))).toHaveLength(10);
    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as {
      prompts_generated: { generation_source: string }[];
      prompts_free_remaining: number;
      credits_charged: number;
    };
    expect(payload.prompts_generated).toHaveLength(10);
    expect(payload.prompts_generated.every((p) => p.generation_source === "discovery")).toBe(true);
    expect(payload.prompts_free_remaining).toBe(0);
    expect(payload.credits_charged).toBe(0);
    // Nothing in this job touches the wallet.
    expect(calls.some((c) => /credit|wallet|ledger/i.test(c.sql))).toBe(false);
  });

  it("AC12 — prompts the caller supplied at creation: supplied wins, so none are generated and the allowance is untouched", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));
    await handler(richTx(calls), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: ["prompts"] }));

    expect(calls.some((c) => c.sql.includes("INSERT INTO tracked_prompts"))).toBe(false);
    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as { prompts_generated: unknown[]; prompts_free_remaining: number };
    expect(payload.prompts_generated).toEqual([]);
    expect(payload.prompts_free_remaining).toBe(10);
  });

  it("scenario 13 — an unreachable site still gets its allowance and a partial payload (the project stays usable)", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const deps: DiscoverDeps = { fetch: vi.fn(async () => { throw new Error("down"); }), now: () => Date.now() };
    await createCrawlDiscoverHandler(CONTEXT, deps)(richTx(calls), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    expect(write.params[2]).toBe("partial");
  });
});

describe("STORY-043 · crawl.discover and the explicit generate share ONE allowance", () => {
  it("AC12 — a project already holding generated prompts (onboarding's generate call) gets none from discovery, and reports 0 remaining", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const held = Array.from({ length: 10 }, (_, i) => ({
      id: `p${String(i)}`, text: `t${String(i)}`, intent_archetype: "recommendation", funnel_stage: "consideration", origin: null,
    }));
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));
    await handler(richTx(calls, { existingDiscoveryPrompts: held }), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    expect(calls.some((c) => c.sql.includes("INSERT INTO tracked_prompts"))).toBe(false);
    const write = calls.find((c) => c.sql.includes("SET discovery = $2"))!;
    const payload = JSON.parse(write.params[1] as string) as { prompts_generated: unknown[]; prompts_free_remaining: number };
    expect(payload.prompts_generated).toEqual([]);
    expect(payload.prompts_free_remaining).toBe(0);
  });
});

describe("STORY-043 · crawl.discover recovers a job whose retries ran out", () => {
  const FAILED = { error: new Error("boom"), phase: "commit" as const };

  function recovering(attemptsMade: number, attempts: number | undefined) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const phases = phasesOf(createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE)))!;
    const job = {
      attemptsMade,
      ...(attempts === undefined ? {} : { opts: { attempts } }),
      data: { payload: { workspaceId: WORKSPACE, kid: "k1", projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] } },
    } as unknown as Job;
    return { calls, phases, job, tx: txRecording(calls) };
  }

  it("is defined — without it a failed commit leaves the project 'running' for ever", () => {
    expect(phasesOf(createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE)))!.recover).toBeDefined();
  });

  it("AC13 — on the LAST attempt it marks the project partial (still usable) and settles the job", async () => {
    const { calls, phases, job, tx } = recovering(3, 4);
    await expect(phases.recover!(tx, job, FAILED as never)).resolves.toBe(true);
    const write = calls.find((c) => c.sql.includes("UPDATE projects"))!;
    expect(write.sql).toContain("discovery_status = 'partial'");
    // Only a pass still in flight is touched: a completed payload a redelivery wrote is never clobbered.
    expect(write.sql).toMatch(/discovery_status IN \('pending', ?'running'\)/);
  });

  it("AC13 — keeps whatever the run obtained: a failed COMMIT writes the fetched payload, marked partial", async () => {
    const { calls, phases, job, tx } = recovering(3, 4);
    const fetched = { discovery_status: "completed", duration_ms: 10, fields: { brand_name: { value: "HubSpot", confidence: 0.9, source: "x", user_edited: false } },
      competitors_proposed: [], prompts_generated: [], prompts_free_remaining: 10, credits_charged: 0, low_confidence_fields: [] };
    await phases.recover!(tx, job, { ...FAILED, fetched } as never);
    const write = calls.find((c) => c.sql.includes("UPDATE projects"))!;
    const payload = JSON.parse(write.params[1] as string) as { discovery_status: string; fields: Record<string, unknown> };
    expect(payload.discovery_status).toBe("partial");
    expect(payload.fields.brand_name).toBeDefined();
  });

  it("an earlier attempt is left to the queue's retry ladder: nothing written, not settled", async () => {
    const { calls, phases, job, tx } = recovering(1, 4);
    await expect(phases.recover!(tx, job, FAILED as never)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it("a job with no known attempt count is not known to be final", async () => {
    const { calls, phases, job, tx } = recovering(9, undefined);
    await expect(phases.recover!(tx, job, FAILED as never)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("STORY-043 · crawl.discover observability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("AC15 — records the end-to-end duration as nominara_discovery_duration_seconds, labelled by status, and counts the outcome", async () => {
    const observe = vi.mocked(observeValue);
    const count = vi.mocked(incrementCounter);
    observe.mockClear();
    count.mockClear();
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(richTx([], { projectRow: { created_at: new Date() } }), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    expect(observe).toHaveBeenCalledWith("nominara_discovery_duration_seconds", expect.any(Number), { status: "completed" });
    expect(count).toHaveBeenCalledWith("nominara_discovery_completed_total", { status: "completed" });
  });

  // edge-cases-and-slos.md row 33: "URL submitted -> confidence-scored payload". The queue wait (crawl.discover runs at concurrency 3), the
  // prepare transaction and the commit all sit inside that, and none of them is inside `discover()`'s own timer.
  it("AC15 — the objective is measured from SUBMISSION: time spent waiting in the queue is in the observed value", async () => {
    const observe = vi.mocked(observeValue);
    observe.mockClear();
    const submittedAt = new Date(Date.now() - 30_000); // the project row was created 30 s before the worker picked the job up
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(richTx([], { projectRow: { created_at: submittedAt } }), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    const total = observe.mock.calls.find(([name]) => name === "nominara_discovery_duration_seconds")![1];
    expect(total).toBeGreaterThanOrEqual(30);
    // discover()'s own run is a sub-measure and stays small: a backlog must not hide inside it.
    const run = observe.mock.calls.find(([name]) => name === "nominara_discovery_run_seconds")![1];
    expect(run).toBeLessThan(5);
  });

  it("AC15 — no submission time (a row without created_at) is no observation, not a 0-second one", async () => {
    const observe = vi.mocked(observeValue);
    observe.mockClear();
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(PAGE));

    await handler(richTx([]), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    expect(observe.mock.calls.some(([name]) => name === "nominara_discovery_duration_seconds")).toBe(false);
  });

  it("logs the workspace ID and never the brand name, a competitor or prompt text", async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(String(m)));
    const handler = createCrawlDiscoverHandler(CONTEXT, depsServing(COMPARISON_PAGE));

    await handler(richTx([]), jobWith({ projectId: PROJECT, rootUrl: "https://hubspot.com", fieldsSupplied: [] }));

    const summary = lines.find((l) => l.includes(PROJECT))!;
    expect(summary).toContain(WORKSPACE);
    for (const leak of ["HubSpot", "Salesforce"]) expect(summary).not.toContain(leak);
  });
});
