import { Logger } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainError } from "../../api/errors/domain-errors.js";
import { encodeCursor } from "../../api/pagination/cursor.js";
import { Page } from "../../api/pagination/page.js";
import type { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { PromptListService } from "./prompt-list.service.js";

// STORY-134 AC1 / scenario 8 — `cursor` was accepted by promptListQuerySchema and silently ignored. These pin the
// keyset: the query carries the predicate, the page carries `cursor_next` / `has_more`, a bad cursor is a 400.

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "33333333-3333-7333-8333-333333333333";
const idOf = (n: number): string => `01a06ccd-0000-7000-8000-${String(n).padStart(12, "0")}`;
const AT = "2026-09-07T00:00:00.123456Z";

function row(n: number) {
  return {
    id: idOf(n),
    text: `prompt ${String(n)}`,
    text_hash: Buffer.from("a".repeat(64), "hex"),
    intent_archetype: "scale_fit",
    funnel_stage: "consideration",
    status: "active",
    is_priority: false,
    generation_source: "generated",
    generation_batch_id: null,
    cluster_id: null,
    stability_score: null,
    last_captured_at: null,
    created_at: "2026-09-07T00:00:00.123Z",
    created_at_key: AT,
  };
}

describe("STORY-134 · prompt list keyset paging", () => {
  let calls: { sql: string; params: unknown[] }[];

  function setup(rows: ReturnType<typeof row>[]): PromptListService {
    calls = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("FROM projects")) return { rows: [{ prompts_cap: 50 }] };
        if (sql.includes("FILTER (WHERE status")) return { rows: [{ active: rows.length, paused: 0, archived: 0 }] };
        return { rows };
      }),
    };
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: WS } } as never);
    const resolver = {
      resolveForWorkspace: vi.fn(async () => ({ entitlements: { "prompts.max_per_project": { value: 50 } } })),
    } as unknown as EntitlementResolver;
    return new PromptListService(resolver);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const listQuery = () => calls.find((call) => call.sql.includes("ORDER BY"));

  it("[STORY-134 #8] fetches limit+1 rows and returns a Page whose cursor_next/has_more are set when more remain", async () => {
    const page = (await setup([row(1), row(2), row(3)]).list(PROJECT, { limit: 2 }));
    expect(page).toBeInstanceOf(Page);
    expect(listQuery()?.params).toContain(3);
    expect(page.items).toHaveLength(2);
    expect(page.pagination.has_more).toBe(true);
    expect(page.pagination.cursor_next).not.toBeNull();
    expect(page.pagination.limit).toBe(2);
  });

  it("[STORY-134 #8] the last page has cursor_next null and has_more false", async () => {
    const page = (await setup([row(1), row(2)]).list(PROJECT, { limit: 2 }));
    expect(page.pagination).toEqual({ cursor_next: null, has_more: false, limit: 2 });
  });

  it("[STORY-134 #2] an empty project is an empty Page with no cursor, not an error", async () => {
    const page = (await setup([]).list(PROJECT, { limit: 50 }));
    expect(page.items).toEqual([]);
    expect(page.pagination.cursor_next).toBeNull();
  });

  it("[STORY-134 #8] a cursor becomes a (created_at, id) keyset predicate bound as parameters", async () => {
    const cursor = encodeCursor("prompts.prompts", [AT, idOf(7)]);
    await setup([row(8)]).list(PROJECT, { limit: 50, cursor });
    expect(listQuery()?.sql).toMatch(/\(created_at, id\) > \(\$\d+::timestamptz, \$\d+::uuid\)/u);
    expect(listQuery()?.params).toContain(AT);
    expect(listQuery()?.params).toContain(idOf(7));
  });

  it("[STORY-134 #8] cursor_next carries the LAST VISIBLE row's key at microsecond precision", async () => {
    const page = (await setup([row(1), row(2), row(3)]).list(PROJECT, { limit: 2 }));
    const next = Buffer.from(page.pagination.cursor_next!, "base64url").toString("utf8");
    expect(JSON.parse(next)).toEqual({ v: 2, l: "prompts.prompts", k: [AT, idOf(2)] });
  });

  it.each([
    ["garbage", "not a cursor!!"],
    ["a tuple of the wrong arity (a tasks-list cursor)", encodeCursor("prompts.prompts", [AT, idOf(1), AT, idOf(2), idOf(3)])],
    ["a same-arity cursor issued by another list (STORY-117 scenario 6)", encodeCursor("projects.projects", [AT, idOf(1)])],
    ["a tuple of the wrong types", encodeCursor("prompts.prompts", [1, 2])],
    ["a millisecond-precision timestamp", encodeCursor("prompts.prompts", ["2026-09-07T00:00:00.123Z", idOf(1)])],
    ["a non-uuid id", encodeCursor("prompts.prompts", [AT, "nope"])],
  ])("[STORY-134 #8] %s is a 400, never a silent first page", async (_label, cursor) => {
    const error = await setup([row(1)]).list(PROJECT, { limit: 50, cursor }).then(
      () => undefined,
      (caught: unknown) => caught as DomainError,
    );
    expect(error?.code).toBe("validation_failed");
    expect(calls.some((call) => call.sql.includes("ORDER BY"))).toBe(false);
  });

  it("[STORY-134 #1] the Page's data keeps the {prompts, summary} body the app already reads", async () => {
    const page = (await setup([row(1), row(2), row(3)]).list(PROJECT, { limit: 2 }));
    expect(page.data.prompts).toHaveLength(2);
    expect(page.data.summary).toEqual({ active: 3, paused: 0, archived: 0, cap: 50 });
  });

  it("[STORY-134 observability] counts each page served, labelled by has_more and continued only", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await setup([row(1), row(2), row(3)]).list(PROJECT, { limit: 2, cursor: encodeCursor("prompts.prompts", [AT, idOf(0)]) });
    const metric = log.mock.calls.map((call) => call[0] as Record<string, unknown>).find((entry) => entry?.metric === "nominara_prompts_list_pages_total");
    expect(metric).toEqual({ metric: "nominara_prompts_list_pages_total", value: 1, has_more: "true", continued: "true" });
  });

  it("[STORY-134 #8] keeps the ORDER BY total — id breaks a created_at tie", async () => {
    await setup([row(1)]).list(PROJECT, { limit: 50 });
    expect(listQuery()?.sql).toContain("ORDER BY created_at ASC, id ASC");
  });
});
