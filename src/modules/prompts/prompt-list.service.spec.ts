import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainError } from "../../api/errors/domain-errors.js";
import type { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { PromptListService } from "./prompt-list.service.js";

// STORY-134 — `GET /projects/{id}/prompts` and `POST /projects/{id}/prompts`.
// api-specification.md §3, page-inventory.md §6.

interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "33333333-3333-7333-8333-333333333333";
const P1 = "01a06ccd-0000-7000-8000-000000000001";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: P1,
    text: "most reliable crm for a 50-rep sales team",
    text_hash: Buffer.from("a".repeat(64), "hex"),
    intent_archetype: "scale_fit",
    funnel_stage: "consideration",
    status: "active",
    is_priority: true,
    generation_source: "generated",
    generation_batch_id: null,
    cluster_id: null,
    stability_score: null,
    last_captured_at: null,
    created_at: "2026-09-07T00:00:00.000Z",
    created_at_key: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function clientAnsweringWith(calls: Recorded[], answers: { match: string; rows: unknown[] }[], failOn?: { match: string; error: Error }) {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (failOn !== undefined && sql.includes(failOn.match)) throw failOn.error;
      const answer = answers.find((candidate) => sql.includes(candidate.match));
      return { rows: answer?.rows ?? [] };
    }),
  };
}

function resolverReturning(limit: number): EntitlementResolver {
  return {
    resolveForWorkspace: vi.fn(async () => ({ entitlements: { "prompts.max_per_project": { value: limit } } })),
  } as unknown as EntitlementResolver;
}

interface Scenario {
  readonly rows?: Record<string, unknown>[];
  readonly counts?: { active: number; paused: number; archived: number };
  readonly cap?: number;
  readonly missingProject?: boolean;
  readonly failOn?: { match: string; error: Error };
}

describe("STORY-134 · PromptListService", () => {
  let calls: Recorded[];

  function setup(scenario: Scenario = {}) {
    calls = [];
    const counts = scenario.counts ?? { active: 47, paused: 0, archived: 3 };
    const client = clientAnsweringWith(
      calls,
      [
        { match: "FROM projects", rows: scenario.missingProject === true ? [] : [{ prompts_cap: scenario.cap ?? 50 }] },
        { match: "FILTER (WHERE status", rows: [counts] },
        { match: "ORDER BY", rows: scenario.rows ?? [row()] },
      ],
      scenario.failOn,
    );
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: WS } } as never);
    return new PromptListService(resolverReturning(scenario.cap ?? 50));
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // The list.
  // ---------------------------------------------------------------------------

  it("scenario 1 — returns the project's prompts", async () => {
    const page = await setup().list(PROJECT, { limit: 50 });
    expect(page.data.prompts).toHaveLength(1);
    expect(page.data.prompts[0]?.id).toBe(P1);
    expect(page.data.prompts[0]?.intent_archetype).toBe("scale_fit");
  });

  it("scenario 2 — an empty project is an empty array, not an error", async () => {
    const page = await setup({ rows: [], counts: { active: 0, paused: 0, archived: 0 } }).list(PROJECT, { limit: 50 });
    expect(page.data.prompts).toEqual([]);
    expect(page.data.summary).toEqual({ active: 0, paused: 0, archived: 0, cap: 50 });
  });

  it("scenario 3 — a soft-deleted prompt is excluded by the QUERY", async () => {
    // Matching `ux_prompts_project_hash`'s own predicate exactly. Filtering in
    // application code over a wider payload would ship deleted rows to the
    // client and rely on the client to hide them.
    await setup().list(PROJECT, { limit: 50 });
    const listQuery = calls.find((call) => call.sql.includes("ORDER BY"));
    expect(listQuery?.sql).toContain("deleted_at IS NULL");
  });

  it("scenario 4 — scopes to the PROJECT, not only the tenant", async () => {
    // RLS scopes the workspace; it does not scope the project, and this
    // route's path names one. Without the predicate a sibling project's
    // prompts would appear in this project's matrix.
    await setup().list(PROJECT, { limit: 50 });
    const listQuery = calls.find((call) => call.sql.includes("ORDER BY"));
    expect(listQuery?.sql).toContain("project_id = $1");
    expect(listQuery?.params[0]).toBe(PROJECT);
  });

  it("adds NO workspace_id predicate — RLS owns the tenant boundary", async () => {
    // NFR-SEC-01. A predicate here would imply the boundary lives in
    // application code.
    await setup().list(PROJECT, { limit: 50 });
    for (const call of calls) {
      expect(call.sql, call.sql.slice(0, 40)).not.toContain("workspace_id =");
    }
  });

  it("scenarios 5 and 6 — filters by status, archetype and funnel stage", async () => {
    await setup().list(PROJECT, { limit: 50, status: "active", intent_archetype: "scale_fit", funnel_stage: "decision" });
    const listQuery = calls.find((call) => call.sql.includes("ORDER BY"));
    expect(listQuery?.params).toContain("active");
    expect(listQuery?.params).toContain("scale_fit");
    expect(listQuery?.params).toContain("decision");
  });

  it("passes a filter as a PARAMETER, never interpolated", async () => {
    // The values come from a `.strict()` enum so they cannot be hostile
    // today, but a filter built by string concatenation is a pattern that
    // outlives the enum that made it safe.
    await setup().list(PROJECT, { limit: 50, status: "archived" });
    const listQuery = calls.find((call) => call.sql.includes("ORDER BY"));
    expect(listQuery?.sql).not.toContain("'archived'");
  });

  it("scenario 10 — never fabricates a score or a capture time", async () => {
    const page = await setup().list(PROJECT, { limit: 50 });
    expect(page.data.prompts[0]?.stability_score).toBeNull();
    expect(page.data.prompts[0]?.last_captured_at).toBeNull();
    expect(page.data.prompts[0]?.cluster_id).toBeNull();
  });

  it("renders the hash in the `sha256:` wire form", async () => {
    const page = await setup().list(PROJECT, { limit: 50 });
    expect(page.data.prompts[0]?.text_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("FR-PA-03a — counts PAUSED separately from active", async () => {
    // A header showing only active/cap would tell a customer with 40 active
    // and 8 paused that they have 10 slots free on a cap of 50, when a paused
    // prompt still occupies one and they have 2.
    const page = await setup({ counts: { active: 40, paused: 8, archived: 3 } }).list(PROJECT, { limit: 50 });
    expect(page.data.summary).toEqual({ active: 40, paused: 8, archived: 3, cap: 50 });
  });

  it("takes the cap from the ENTITLEMENT, not from the column", async () => {
    // The column is a creation-time snapshot; reading it would mean an
    // upgrade did not raise the header's cap until the project was
    // recreated. Same reasoning as the activation service.
    const page = await setup({ cap: 500 }).list(PROJECT, { limit: 50 });
    expect(page.data.summary.cap).toBe(500);
  });

  it("refuses an unknown project", async () => {
    const error = await setup({ missingProject: true })
      .list(PROJECT, { limit: 50 })
      .catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("not_found");
  });

  // ---------------------------------------------------------------------------
  // Manual creation.
  // ---------------------------------------------------------------------------

  it("scenario 11 — creates a manual prompt as `manual`, `custom`, `active`", async () => {
    const created = await setup({ counts: { active: 5, paused: 0, archived: 0 } }).create(PROJECT, {
      text: "best crm for a 10-person startup",
    });
    expect(created.generation_source).toBe("manual");
    expect(created.intent_archetype).toBe("custom");
    expect(created.status).toBe("active");
    expect(created.generation_batch_id).toBeNull();
  });

  it("charges nothing, and touches no wallet or ledger", async () => {
    await setup({ counts: { active: 5, paused: 0, archived: 0 } }).create(PROJECT, { text: "a prompt?" });
    const touched = calls.map((call) => call.sql).join(" ").toLowerCase();
    for (const table of ["wallet", "credit_ledger", "debit", "reserve"]) {
      expect(touched, `manual creation must not touch ${table}`).not.toContain(table);
    }
  });

  it("scenario 12 — refuses at the cap, naming the remaining slots", async () => {
    // STORY-046 AC7: manual entry is "always free and STILL SUBJECT TO THE
    // CAP". Without this, typing prompts is an unbounded way past a limit
    // that generation respects.
    const service = setup({ cap: 50, counts: { active: 50, paused: 0, archived: 3 } });
    const error = await service.create(PROJECT, { text: "one more?" }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("entitlement_exceeded");
    expect((error as DomainError).details).toEqual({ key: "prompts.max_per_project", limit: 50, current: 50 });
  });

  it("counts PAUSED prompts against the cap on creation", async () => {
    // The same occupancy rule as everywhere else: 45 active + 5 paused on a
    // cap of 50 is full, even though only 45 are capturing.
    const service = setup({ cap: 50, counts: { active: 45, paused: 5, archived: 0 } });
    const error = await service.create(PROJECT, { text: "one more?" }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("entitlement_exceeded");
  });

  it("refuses BEFORE inserting, so a capped project writes nothing", async () => {
    const service = setup({ cap: 50, counts: { active: 50, paused: 0, archived: 0 } });
    await service.create(PROJECT, { text: "one more?" }).catch(() => undefined);
    expect(calls.filter((call) => call.sql.includes("INSERT"))).toHaveLength(0);
  });

  it("scenario 13 — a duplicate wording is a 409, not a 500", async () => {
    // `ux_prompts_project_hash` is unique on (project_id, text_hash). Typing
    // a prompt the project already tracks is something the customer can act
    // on, not an unhandled database error.
    const service = setup({
      counts: { active: 5, paused: 0, archived: 0 },
      failOn: { match: "INSERT INTO tracked_prompts", error: Object.assign(new Error("dup"), { code: "23505" }) },
    });
    const error = await service.create(PROJECT, { text: "a duplicate?" }).catch((e: unknown) => e as DomainError);
    expect((error as DomainError).code).toBe("conflict");
  });

  it("scenario 14 — maintains the active count in the same statement sequence", async () => {
    await setup({ counts: { active: 5, paused: 0, archived: 0 } }).create(PROJECT, { text: "a prompt?" });
    const update = calls.find((call) => call.sql.includes("UPDATE projects"));
    expect(update?.sql).toContain("prompts_active");
  });

  it("reuses persist.ts's insert rather than a third copy of the column list", async () => {
    // The STORY-043 defect was a second copy of this statement that omitted
    // three NOT NULL columns. A third copy is how it recurs.
    await setup({ counts: { active: 5, paused: 0, archived: 0 } }).create(PROJECT, { text: "a prompt?" });
    const insert = calls.find((call) => call.sql.includes("INSERT INTO tracked_prompts"));
    for (const column of ["text_hash", "intent_archetype", "funnel_stage"]) {
      expect(insert?.sql, column).toContain(column);
    }
  });
});
