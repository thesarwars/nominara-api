import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuxModule } from "./aux.module.js";
import { AuxController } from "./aux.controller.js";
import { AuxService } from "./aux.service.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { ConflictError, NotFoundError, PreconditionUnmetError } from "../../api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { AUDIT_METADATA_KEY } from "../../api/decorators/audit.decorator.js";
import { updateAuxFindingRequestSchema } from "../../../contracts/aux/index.js";

// STORY-022 — one compiles-test per scaffolded module.
describe("STORY-022 · AuxModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuxModule] }).compile();
    expect(moduleRef.get(AuxController)).toBeInstanceOf(AuxController);
    await moduleRef.close();
  });
});

// NEW-C-10 (STORY-052; api-specification.md "AUX") — reads and finding actions.
// SQL-text and fake-client scenarios; the real-SQL, real-role proof is
// test/integration/aux-reads-and-actions.spec.ts.

const AUDIT_ID = "0195e5b7-0000-7000-8000-0000000000a1";
const PROJECT_ID = "0195e5b7-0000-7000-8000-0000000000f1";
const FINDING_ID = "0195e5b7-0000-7000-8000-0000000000b1";

interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

let calls: Recorded[];

/** `route` answers by SQL text; anything it returns undefined for gets zero rows. */
function serviceWith(route: (sql: string, params: unknown[]) => unknown[] | undefined): AuxService {
  calls = [];
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
    client: {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return { rows: route(sql, params) ?? [] };
      }),
    },
    context: { workspaceId: "0195e5b7-0000-7000-8000-0000000000c1", actorId: "0195e5b7-0000-7000-8000-0000000000d1" },
  } as never);
  return new AuxService();
}

const updates = (): Recorded[] => calls.filter((c) => /^\s*UPDATE aux_findings/.test(c.sql));

function auditRow(over: Record<string, unknown> = {}) {
  return {
    id: AUDIT_ID,
    project_id: PROJECT_ID,
    trigger: "scheduled",
    scope: "key_pages",
    status: "completed",
    started_at: new Date("2026-10-01T10:00:00Z"),
    finished_at: new Date("2026-10-01T10:05:00Z"),
    created_at: new Date("2026-10-01T09:59:00Z"),
    pages_crawled: 12,
    pages_failed: 0,
    aux_score: "68.500",
    score_capped: true,
    score_breakdown: { crawler_access: 0.4, freshness: 0 },
    rule_version: "2026.10.1",
    findings_critical: 1,
    findings_high: 0,
    findings_medium: 2,
    findings_low: 0,
    llms_txt_present: false,
    sitemap_url_count: 0,
    excluded: [{ rule_code: "AUX-R-010", title: "Product schema" }],
    previous_score: "60.000",
    in_scope: true,
    ...over,
  };
}

function findingRow(over: Record<string, unknown> = {}) {
  return {
    id: FINDING_ID,
    audit_id: AUDIT_ID,
    project_id: PROJECT_ID,
    rule_code: "AUX-R-001",
    title: "robots.txt blocks AI crawlers",
    category: "crawler_access",
    severity: "critical",
    status: "open",
    consequence: "Engines cannot read your site.",
    url: "https://example.com/robots.txt",
    affected_pages: 1,
    measured_value: null,
    threshold_value: "0",
    evidence: { selector: null, snippet: null, measured: null, expected: null },
    auto_fixable: false,
    requires_human_review: false,
    wont_fix_reason: null,
    first_detected_at: new Date("2026-09-01T00:00:00Z"),
    last_detected_at: new Date("2026-10-01T00:00:00Z"),
    resolved_at: null,
    regressed_at: null,
    occurrence_count: 3,
    rule_version: "2026.10.1",
    task_id: null,
    severity_key: "0",
    ...over,
  };
}

/** The route for PATCH scenarios: lock row -> `status`, the final read -> a finding in `after`. */
function patchRoute(status: string, over: { inScope?: boolean; missing?: boolean; after?: Record<string, unknown> } = {}) {
  return (sql: string): unknown[] | undefined => {
    if (/FOR UPDATE/.test(sql)) return over.missing === true ? [] : [{ id: FINDING_ID, project_id: PROJECT_ID, status, in_scope: over.inScope ?? true }];
    if (/^\s*UPDATE aux_findings/.test(sql)) return [];
    if (/FROM aux_findings/.test(sql)) return [findingRow({ status, ...over.after })];
    return undefined;
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("NEW-C-10 · contract", () => {
  it("[NEW-C-10 AC1] the PATCH body is strict: an unknown key is refused", () => {
    expect(updateAuxFindingRequestSchema.safeParse({ status: "acknowledged", resolved_at: "2026-10-01T00:00:00Z" }).success).toBe(false);
  });

  it("[NEW-C-10 AC2] wont_fix without a reason is refused, with a reason is accepted", () => {
    expect(updateAuxFindingRequestSchema.safeParse({ status: "wont_fix" }).success).toBe(false);
    expect(updateAuxFindingRequestSchema.safeParse({ status: "wont_fix", reason: "   " }).success).toBe(false);
    expect(updateAuxFindingRequestSchema.safeParse({ status: "wont_fix", reason: "Intentional: staging noindex" }).success).toBe(true);
  });

  it("[NEW-C-10 AC2] a reason with any other status is refused", () => {
    expect(updateAuxFindingRequestSchema.safeParse({ status: "acknowledged", reason: "x" }).success).toBe(false);
  });

  it("[NEW-C-10 AC2] states a client does not own (in_progress, regressed, stale) are a 400, not a refusal", () => {
    for (const status of ["in_progress", "regressed", "stale"]) {
      expect(updateAuxFindingRequestSchema.safeParse({ status }).success, status).toBe(false);
    }
  });
});

describe("NEW-C-10 · controller", () => {
  const proto = AuxController.prototype as unknown as Record<string, () => unknown>;
  const meta = (key: string, name: string): unknown => Reflect.getMetadata(key, proto[name]!);

  it("[NEW-C-10 AC3] reads require aux:read", () => {
    for (const name of ["getAudit", "listProjectAudits", "listProjectFindings"]) {
      expect(meta(REQUIRE_PERMISSION_KEY, name), name).toBe("aux:read");
    }
  });

  it("[NEW-C-10 AC3] PATCH requires task:create and is audited", () => {
    expect(meta(REQUIRE_PERMISSION_KEY, "updateFinding")).toBe("task:create");
    expect(meta(AUDIT_METADATA_KEY, "updateFinding")).toMatchObject({ action: "aux_finding.updated", resourceType: "aux_finding" });
  });

  it("[NEW-C-10 AC1] no route can set resolved: the controller has exactly the four reads/actions", () => {
    const routes = Object.getOwnPropertyNames(AuxController.prototype).filter((n) => n !== "constructor").sort();
    expect(routes).toEqual(["getAudit", "listProjectAudits", "listProjectFindings", "updateFinding"]);
  });
});

describe("NEW-C-10 · AuxService.getAudit", () => {
  it("[NEW-C-10 AC4] maps a demo-seeded audit; the score is a number, the cap and the named exclusions ride along", async () => {
    const audit = await serviceWith(() => [auditRow()]).getAudit(AUDIT_ID);
    expect(audit).toMatchObject({
      audit_id: AUDIT_ID,
      project_id: PROJECT_ID,
      scope: "key_pages",
      status: "completed",
      aux_score: 68.5,
      capped: true,
      delta: 8.5,
      findings: { critical: 1, high: 0, medium: 2, low: 0 },
      excluded_rules: [{ rule_code: "AUX-R-010", title: "Product schema" }],
      started_at: "2026-10-01T10:00:00.000Z",
      completed_at: "2026-10-01T10:05:00.000Z",
    });
  });

  it("[NEW-C-10 AC4] the breakdown becomes weighted categories; a subscore of 0 is kept, an absent category is not invented", async () => {
    const audit = await serviceWith(() => [auditRow()]).getAudit(AUDIT_ID);
    expect(audit.categories).toEqual([
      { category: "crawler_access", weight: 0.28, subscore: 0.4 },
      { category: "freshness", weight: 0.06, subscore: 0 },
    ]);
  });

  it("[NEW-C-10 AC4] a real site-file audit: aux_score null stays null, delta null, no breakdown beyond what ran, 0 and null distinguished", async () => {
    const audit = await serviceWith(() =>
      [auditRow({ aux_score: null, previous_score: null, status: "partial", llms_txt_present: null, sitemap_url_count: null, score_breakdown: { crawler_access: 1 }, excluded: [] })],
    ).getAudit(AUDIT_ID);
    expect(audit.aux_score).toBeNull();
    expect(audit.delta).toBeNull();
    expect(audit.status).toBe("partial");
    expect(audit.llms_txt_present).toBeNull();
    expect(audit.sitemap_url_count).toBeNull();
    expect(audit.categories).toEqual([{ category: "crawler_access", weight: 0.28, subscore: 1 }]);
  });

  it("[NEW-C-10 AC4] a score of 0 is 0, not null; a null breakdown is no categories", async () => {
    const audit = await serviceWith(() => [auditRow({ aux_score: "0.000", previous_score: "0.000", score_breakdown: null })]).getAudit(AUDIT_ID);
    expect(audit.aux_score).toBe(0);
    expect(audit.delta).toBe(0);
    expect(audit.categories).toEqual([]);
  });

  it("[NEW-C-10 AC3] an audit that is not visible is a 404; an out-of-scope project's is a 403 naming scope", async () => {
    await expect(serviceWith(() => []).getAudit(AUDIT_ID)).rejects.toBeInstanceOf(NotFoundError);
    await expect(serviceWith(() => [auditRow({ in_scope: false })]).getAudit(AUDIT_ID)).rejects.toBeInstanceOf(ProjectOutOfScopeException);
  });

  it("[NEW-C-10 AC3] takes no workspace_id predicate — RLS scopes the tenant", async () => {
    await serviceWith(() => [auditRow()]).getAudit(AUDIT_ID);
    expect(calls[0]!.sql).not.toContain("workspace_id");
    expect(calls[0]!.sql).toContain("app.current_scope_projects()");
  });
});

describe("NEW-C-10 · AuxService.listProjectAudits", () => {
  it("[NEW-C-10 AC4] ?limit=1 returns the newest audit first and says whether there are more", async () => {
    const page = await serviceWith((sql) => (/FROM projects/.test(sql) && !/aux_audits/.test(sql) ? [{ id: PROJECT_ID }] : [auditRow(), auditRow({ id: "0195e5b7-0000-7000-8000-0000000000a2" })]))
      .listProjectAudits(PROJECT_ID, { limit: 1 } as never);
    expect(page.items).toHaveLength(1);
    expect(page.pagination.has_more).toBe(true);
    expect(page.pagination.cursor_next).not.toBeNull();
    const listSql = calls.find((c) => /FROM aux_audits/.test(c.sql))!;
    expect(listSql.sql).toContain("ORDER BY a.created_at DESC, a.id DESC");
    expect(listSql.params).toContain(2);
  });

  it("[NEW-C-10 AC3] a project the caller cannot see is a 404", async () => {
    await expect(serviceWith(() => []).listProjectAudits(PROJECT_ID, { limit: 1 } as never)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("[NEW-C-10 AC4] a project with no audits is an empty page, not an error", async () => {
    const page = await serviceWith((sql) => (/aux_audits/.test(sql) ? [] : [{ id: PROJECT_ID }])).listProjectAudits(PROJECT_ID, { limit: 1 } as never);
    expect(page.items).toEqual([]);
    expect(page.pagination).toMatchObject({ has_more: false, cursor_next: null });
  });
});

describe("NEW-C-10 · AuxService.listProjectFindings", () => {
  const projectThen = (rows: unknown[]) => (sql: string) => (/FROM aux_findings/.test(sql) ? rows : [{ id: PROJECT_ID }]);

  it("[NEW-C-10 AC4] maps a demo-seeded finding (selector/snippet evidence, null measured, no wont_fix) and a task link", async () => {
    const page = await serviceWith(projectThen([findingRow({ task_id: "0195e5b7-0000-7000-8000-0000000000e1" })])).listProjectFindings(PROJECT_ID, { limit: 50 } as never);
    expect(page.items[0]).toMatchObject({
      finding_id: FINDING_ID,
      category: "crawler_access",
      severity: "critical",
      status: "open",
      consequence: "Engines cannot read your site.",
      measured_value: null,
      threshold_value: 0,
      wont_fix: null,
      task_id: "0195e5b7-0000-7000-8000-0000000000e1",
      first_detected_at: "2026-09-01T00:00:00.000Z",
    });
  });

  it("[NEW-C-10 AC4] a real site-file finding keeps its evidence and numeric 0 versus null", async () => {
    const evidence = { file: "robots.txt", reason: "root_disallow", snippet: "Disallow: /", line: 2, subjects: ["GPTBot"] };
    const page = await serviceWith(projectThen([findingRow({ evidence, measured_value: "0", threshold_value: null })])).listProjectFindings(PROJECT_ID, { limit: 50 } as never);
    expect(page.items[0]!.evidence).toEqual(evidence);
    expect(page.items[0]!.measured_value).toBe(0);
    expect(page.items[0]!.threshold_value).toBeNull();
  });

  it("[NEW-C-10 AC2] a wont_fix finding carries its reason as a visible annotation", async () => {
    const page = await serviceWith(projectThen([findingRow({ status: "wont_fix", wont_fix_reason: "Staging only" })])).listProjectFindings(PROJECT_ID, { limit: 50 } as never);
    expect(page.items[0]!.wont_fix).toEqual({ reason: "Staging only" });
  });

  it("[NEW-C-10 AC4] filters by severity, status, rule and URL as bound parameters, never text", async () => {
    await serviceWith(projectThen([])).listProjectFindings(PROJECT_ID, { limit: 50, severity: "high", status: "open", rule_code: "AUX-R-002", url: "https://x.test/a" } as never);
    const list = calls.find((c) => /FROM aux_findings/.test(c.sql))!;
    expect(list.params).toEqual(expect.arrayContaining(["high", "open", "AUX-R-002", "https://x.test/a"]));
    expect(list.sql).not.toContain("AUX-R-002");
    expect(list.sql).not.toContain("x.test");
  });

  it("[NEW-C-10 AC3] takes no workspace_id predicate and applies the project scope", async () => {
    await serviceWith(projectThen([])).listProjectFindings(PROJECT_ID, { limit: 50 } as never);
    for (const c of calls) expect(c.sql).not.toContain("workspace_id");
    expect(calls[0]!.sql).toContain("app.current_scope_projects()");
  });

  it("[NEW-C-10 AC4] an unknown project is a 404, an empty project is an empty page", async () => {
    await expect(serviceWith(() => []).listProjectFindings(PROJECT_ID, { limit: 50 } as never)).rejects.toBeInstanceOf(NotFoundError);
    const page = await serviceWith(projectThen([])).listProjectFindings(PROJECT_ID, { limit: 50 } as never);
    expect(page.items).toEqual([]);
  });
});

describe("NEW-C-10 · AuxService.updateFinding", () => {
  it("[NEW-C-10 AC2] resolved is a 422 and writes nothing", async () => {
    for (const from of ["open", "acknowledged", "in_progress", "regressed", "wont_fix", "stale", "resolved"]) {
      const service = serviceWith(patchRoute(from));
      await expect(service.updateFinding(FINDING_ID, { status: "resolved" }), from).rejects.toBeInstanceOf(PreconditionUnmetError);
      expect(updates(), from).toHaveLength(0);
    }
  });

  it("[NEW-C-10 AC2] acknowledged from open or regressed writes the status", async () => {
    for (const from of ["open", "regressed"]) {
      const result = await serviceWith(patchRoute(from, { after: { status: "acknowledged" } })).updateFinding(FINDING_ID, { status: "acknowledged" });
      expect(updates(), from).toHaveLength(1);
      expect(updates()[0]!.params).toEqual(expect.arrayContaining([FINDING_ID, "acknowledged"]));
      expect(result.status).toBe("acknowledged");
    }
  });

  it("[NEW-C-10 AC2] open is accepted from acknowledged only", async () => {
    const result = await serviceWith(patchRoute("acknowledged", { after: { status: "open" } })).updateFinding(FINDING_ID, { status: "open" });
    expect(updates()).toHaveLength(1);
    expect(result.status).toBe("open");
    for (const from of ["open", "in_progress", "regressed", "wont_fix", "stale", "resolved"]) {
      await expect(serviceWith(patchRoute(from)).updateFinding(FINDING_ID, { status: "open" }), from).rejects.toBeInstanceOf(ConflictError);
      expect(updates(), from).toHaveLength(0);
    }
  });

  it("[NEW-C-10 AC2] wont_fix stores the reason; from a resolved or stale finding it is a 409", async () => {
    const result = await serviceWith(patchRoute("open", { after: { status: "wont_fix", wont_fix_reason: "Staging only" } })).updateFinding(FINDING_ID, { status: "wont_fix", reason: "Staging only" });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.params).toEqual(expect.arrayContaining(["wont_fix", "Staging only"]));
    expect(result.wont_fix).toEqual({ reason: "Staging only" });
    for (const from of ["resolved", "stale", "wont_fix"]) {
      await expect(serviceWith(patchRoute(from)).updateFinding(FINDING_ID, { status: "wont_fix", reason: "x" }), from).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it("[NEW-C-10 AC2] a refused transition names the current state", async () => {
    const error = await serviceWith(patchRoute("stale")).updateFinding(FINDING_ID, { status: "acknowledged" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).getResponse()).toMatchObject({ details: { current_state: "stale" } });
  });

  it("[NEW-C-10 AC3] a missing finding is 404; an out-of-scope project's is 403, and neither writes", async () => {
    await expect(serviceWith(patchRoute("open", { missing: true })).updateFinding(FINDING_ID, { status: "acknowledged" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(serviceWith(patchRoute("open", { inScope: false })).updateFinding(FINDING_ID, { status: "acknowledged" })).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    expect(updates()).toHaveLength(0);
  });

  it("[NEW-C-10 AC1] the only UPDATE is on status and wont_fix_reason: no resolved_at, no severity, no fingerprint", async () => {
    await serviceWith(patchRoute("open", { after: { status: "acknowledged" } })).updateFinding(FINDING_ID, { status: "acknowledged" });
    const sql = updates()[0]!.sql;
    expect(sql).not.toMatch(/resolved_at|severity|fingerprint|first_detected_at/);
    expect(sql).not.toContain("'resolved'");
  });

  it("[NEW-C-10 AC3] locks the row so two concurrent PATCHes serialise", async () => {
    await serviceWith(patchRoute("open", { after: { status: "acknowledged" } })).updateFinding(FINDING_ID, { status: "acknowledged" });
    expect(calls[0]!.sql).toMatch(/FOR UPDATE/);
  });
});
