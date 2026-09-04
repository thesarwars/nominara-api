import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { createCrawlDiscoverHandler } from "./crawl-discover.handler.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { DiscoverDeps } from "../../discovery/discover.js";

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
