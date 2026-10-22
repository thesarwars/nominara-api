import { NoopRealtimePublisher } from "../../lib/cache/realtime-publisher.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TasksService } from "./tasks.service.js";
import * as tenantContext from "../../tenancy/tenant-context.js";

// STORY-169 (API step 2/3) — GET /v1/workspaces/{id}/action-items.
// api-specification.md §3 · product-spec.md `FR-GD-02`.
//
// RLS and tenant context are one of the four dangerous areas
// (development-workflow.md) — these SQL-text scenarios are the failing
// tests written BEFORE `listActionItems` existed, mirroring
// `ProjectsService.list`'s own scenarios 4/5/6 exactly, because this query
// copies that exact scope predicate (coding-standards.md: RLS scopes the
// WORKSPACE; `app.current_scope_projects()` is what scopes a manager or
// viewer restricted to fewer than all of it — FR-DASH-04 / ISO-08).

interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

describe("STORY-169 · TasksService.listActionItems", () => {
  let calls: Recorded[];

  function serviceReading(rows: unknown[]) {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return { rows };
        }),
      },
    } as never);
    return new TasksService(new NoopRealtimePublisher());
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function row(over: Record<string, unknown> = {}) {
    return {
      id: "0195e5b7-0000-7000-8000-000000000001",
      short_ref: "HUB-142",
      project_id: "0195e5b7-0000-7000-8000-0000000000f1",
      project_name: "HubSpot CRM",
      project_slug: "hubspot-crm",
      code: "AUX-R-014",
      title: "JSON-LD Product schema missing featureList",
      severity: "high",
      kind: "content",
      impact_score: 74,
      impact_key: "74",
      effort_band: "s",
      playbook_slug: null,
      source_finding_id: "0195e5b7-0000-7000-8000-0000000000a1",
      source_domain_id: null,
      source_displacement_id: null,
      created_at: new Date("2026-09-01T00:00:00Z"),
      created_at_key: "2026-09-01 00:00:00+00",
      project_count: 1,
      projects: [{ id: "0195e5b7-0000-7000-8000-0000000000f1", name: "HubSpot CRM", slug: "hubspot-crm" }],
      ...over,
    };
  }

  // NFR-SEC-01 — the tenant boundary is RLS's; this query adds none of its own.
  it("takes no workspace_id predicate — RLS scopes the tenant", async () => {
    await serviceReading([]).listActionItems({ limit: 50 } as never);
    expect(calls[0]!.sql).not.toContain("workspace_id");
  });

  // FR-DASH-04 / ISO-08 — a scoped manager must not see out-of-scope
  // projects' items. Copies ProjectsService.list's exact predicate.
  it("applies app.current_scope_projects() exactly like ProjectsService.list", async () => {
    await serviceReading([]).listActionItems({ limit: 50 } as never);
    expect(calls[0]!.sql).toContain("app.current_scope_projects()");
    expect(calls[0]!.sql).toContain("p.id = ANY(app.current_scope_projects())");
    expect(calls[0]!.sql).toContain("cardinality(app.current_scope_projects()) = 0");
  });

  it("excludes deleted projects and non-open tasks", async () => {
    await serviceReading([]).listActionItems({ limit: 50 } as never);
    expect(calls[0]!.sql).toContain("p.deleted_at IS NULL");
    expect(calls[0]!.sql).toContain("t.deleted_at IS NULL");
    expect(calls[0]!.sql).toContain("t.status IN ('todo', 'in_progress')");
  });

  // Ordering (FR-GD-02) is asserted on real rows in test/integration/action-items.spec.ts, not as an SQL substring here.

  it("an empty workspace is an empty array, not an error", async () => {
    await expect(serviceReading([]).listActionItems({ limit: 50 } as never)).resolves.toMatchObject({ items: [] });
  });

  it("maps a row to the wire shape, preserving SQL row order", async () => {
    const page = await serviceReading([
      row({ id: "0195e5b7-0000-7000-8000-000000000001" }),
      row({ id: "0195e5b7-0000-7000-8000-000000000002", title: "second" }),
    ]).listActionItems({ limit: 50 } as never);

    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.id).toBe("0195e5b7-0000-7000-8000-000000000001");
    expect(page.items[1]!.title).toBe("second");
    expect(page.items[0]).toMatchObject({
      short_ref: "HUB-142",
      project_id: "0195e5b7-0000-7000-8000-0000000000f1",
      project_name: "HubSpot CRM",
      project_slug: "hubspot-crm",
      code: "AUX-R-014",
      title: "JSON-LD Product schema missing featureList",
      severity: "high",
      source: "aux",
      kind: "content",
      impact: 74,
      effort: "s",
      created_at: "2026-09-01T00:00:00.000Z",
      project_count: 1,
      projects: [{ id: "0195e5b7-0000-7000-8000-0000000000f1", name: "HubSpot CRM", slug: "hubspot-crm" }],
    });
  });

  // STORY-064 AC10 — `jsonb_agg` returns the projects unordered; the wire order is the row's own project first, then by name.
  it("[STORY-064 #11] orders a collapsed row's projects: its own first, then by name", async () => {
    const own = "0195e5b7-0000-7000-8000-0000000000f1";
    const page = await serviceReading([
      row({
        project_count: 3,
        projects: [
          { id: "0195e5b7-0000-7000-8000-0000000000f3", name: "Zeta", slug: "zeta" },
          { id: own, name: "Mid", slug: "mid" },
          { id: "0195e5b7-0000-7000-8000-0000000000f2", name: "Alpha", slug: "alpha" },
        ],
      }),
    ]).listActionItems({ limit: 50 } as never);
    expect(page.items[0]!.project_count).toBe(3);
    expect(page.items[0]!.projects.map((p) => p.name)).toEqual(["Mid", "Alpha", "Zeta"]);
  });

  // STORY-169 review — REMOVED: a unit test here that fed `severity: null`
  // straight into the mapper and asserted `null` could not fail if the SQL's
  // `NULLIF`/`CASE WHEN` ever stopped turning `gap_severity = 'none'` into
  // SQL NULL — it tested the mapper's trivial null-passthrough, not the
  // "'none' → null" mapping it was named for. `test/integration/action-
  // items.spec.ts`'s "maps gap_severity = 'none' to null, never leaking the
  // literal onto the wire" is the real-SQL case that actually exercises the
  // SQL side; the mapper's out-of-enum defence is covered directly below.

  // aux_findings.severity's own CHECK allows 'info' — a real value, but one
  // outside the contract's 4-member critical|high|medium|low enum. The SQL
  // whitelist (`CASE WHEN ... IN (...)`) is what actually keeps it off the
  // wire in production; this pins the SQL text AND the mapper's own,
  // second, defensive normalisation (`normalizeSeverity`) in case a row
  // ever reaches the mapper with something the SQL should have already
  // excluded.
  it("SQL whitelists severity to the four contract values, not merely NULLIF(..., 'none')", async () => {
    await serviceReading([]).listActionItems({ limit: 50 } as never);
    expect(calls[0]!.sql).toContain("CASE WHEN COALESCE(af.severity, psi.gap_severity) IN ('critical', 'high', 'medium', 'low')");
  });

  it("maps an out-of-enum severity value (e.g. 'info') reaching the mapper to null, defensively", async () => {
    const page = await serviceReading([row({ severity: "info" })]).listActionItems({ limit: 50 } as never);
    expect(page.items[0]!.severity).toBeNull();
  });

  describe("effort normalisation — tasks.effort_band carries no CHECK constraint", () => {
    it.each([
      ["xs", "xs"],
      ["S", "s"],
      ["M", "m"],
      ["l", "l"],
      ["XL", "xl"],
    ])("lowercases a valid band %s -> %s", async (stored, expected) => {
      const page = await serviceReading([row({ effort_band: stored })]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.effort).toBe(expected);
    });

    it.each(["", "medium", "xxl", "  m  "])("maps an unrecognised stored value (%j) to null", async (stored) => {
      const page = await serviceReading([row({ effort_band: stored })]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.effort).toBeNull();
    });

    it("maps a SQL-null effort_band to null", async () => {
      const page = await serviceReading([row({ effort_band: null })]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.effort).toBeNull();
    });
  });

  describe("source classification — tasks.source_* columns, aux > source > displacement > content", () => {
    it("aux when source_finding_id is set", async () => {
      const page = await serviceReading([
        row({ source_finding_id: "0195e5b7-0000-7000-8000-0000000000a1", source_domain_id: null, source_displacement_id: null }),
      ]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.source).toBe("aux");
    });

    it("source when only source_domain_id is set", async () => {
      const page = await serviceReading([
        row({ source_finding_id: null, source_domain_id: "0195e5b7-0000-7000-8000-0000000000d1", source_displacement_id: null }),
      ]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.source).toBe("source");
    });

    it("displacement when only source_displacement_id is set", async () => {
      const page = await serviceReading([
        row({ source_finding_id: null, source_domain_id: null, source_displacement_id: "0195e5b7-0000-7000-8000-0000000000e1" }),
      ]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.source).toBe("displacement");
    });

    it("content when none of the three are set", async () => {
      const page = await serviceReading([
        row({ source_finding_id: null, source_domain_id: null, source_displacement_id: null }),
      ]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.source).toBe("content");
    });
  });

  // Documented judgement call (tasks.service.ts's derivePrimaryAction): the
  // spec names the inputs (source columns, playbook_slug) but not the
  // mapping. Pinned here so a future change to it is a deliberate edit, not
  // a drift nobody noticed.
  describe("primary_action derivation", () => {
    it("diagnose, targeting the displacement id, when source_displacement_id is set", async () => {
      const page = await serviceReading([
        row({ source_finding_id: null, source_domain_id: null, source_displacement_id: "0195e5b7-0000-7000-8000-0000000000e1", playbook_slug: null }),
      ]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.primary_action).toEqual({ kind: "diagnose", target: "0195e5b7-0000-7000-8000-0000000000e1" });
    });

    it("open_playbook, targeting the slug, when playbook_slug is set (even alongside a displacement id)", async () => {
      const page = await serviceReading([
        row({ source_displacement_id: "0195e5b7-0000-7000-8000-0000000000e1", playbook_slug: "seed-reddit-thread" }),
      ]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.primary_action).toEqual({ kind: "open_playbook", target: "seed-reddit-thread" });
    });

    it("copy_patch, targeting the finding id, when source_finding_id is set and no playbook", async () => {
      const page = await serviceReading([
        row({ source_finding_id: "0195e5b7-0000-7000-8000-0000000000a1", source_domain_id: null, source_displacement_id: null, playbook_slug: null }),
      ]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.primary_action).toEqual({ kind: "copy_patch", target: "0195e5b7-0000-7000-8000-0000000000a1" });
    });

    it("open_task, targeting the task id, when nothing else applies", async () => {
      const page = await serviceReading([
        row({ id: "0195e5b7-0000-7000-8000-000000000009", source_finding_id: null, source_domain_id: null, source_displacement_id: null, playbook_slug: null }),
      ]).listActionItems({ limit: 50 } as never);
      expect(page.items[0]!.primary_action).toEqual({ kind: "open_task", target: "0195e5b7-0000-7000-8000-000000000009" });
    });
  });

  it("uses a 4-element cursor tuple and asks for one row past the limit", async () => {
    await serviceReading([]).listActionItems({ limit: 50 } as never);
    expect(calls[0]!.params[calls[0]!.params.length - 1]).toBe(51);
  });
});
