import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PG_POOL } from "../../db/pg-pool.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { AgencyService } from "./agency.service.js";
import { AgencyModule } from "./agency.module.js";
import { AgencyController } from "./agency.controller.js";

// AgencyService injects PG_POOL, which DbModule provides globally in the real composition root; this isolated compile supplies an inert stand-in.
@Global()
@Module({ providers: [{ provide: PG_POOL, useValue: {} }], exports: [PG_POOL] })
class InertPoolModule {}

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · AgencyModule compiles", () => {
  // The module now imports StorageModule (theme assets), whose providers read the environment and the pool's DATABASE_URL.
  const originalEnv = { ...process.env };
  beforeEach(() => {
    applyFakeApiEnv();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AgencyModule, InertPoolModule] }).compile();
    expect(moduleRef.get(AgencyController)).toBeInstanceOf(AgencyController);
    await moduleRef.close();
  });
});

// CP1 minor (carried through checkpoint 2) — the concurrent FIRST save of a workspace's theme.
describe("CP1 e-reports · AgencyService.saveTheme first-theme race", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setup(insertError?: unknown) {
    const sqls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        sqls.push(sql);
        if (sql.includes("INSERT INTO brand_themes") && insertError !== undefined) throw insertError;
        if (sql.includes("count(*)")) return { rows: [{ n: 0 }] };
        return { rows: [] };
      }),
    };
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: "ws-1", actorId: "a" } } as never);
    return { service: new AgencyService({} as never), sqls };
  }

  it("CP1 first-theme race · the per-workspace advisory lock is the first statement of a save, before the default is read", async () => {
    const { service, sqls } = setup(Object.assign(new Error("stop here"), { code: "XX000" }));
    await expect(service.saveTheme({ name: "A" })).rejects.toThrow("stop here");
    expect(sqls[0]).toContain("pg_advisory_xact_lock");
    expect(sqls.findIndex((q) => q.includes("count(*)"))).toBeGreaterThan(0);
  });

  it("CP1 first-theme race · a 23505 on ux_brand_themes_default is a 409 conflict, never a raw database error", async () => {
    const { service } = setup(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "ux_brand_themes_default" }));
    await expect(service.saveTheme({ name: "A" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("CP1 first-theme race · a 23505 on any OTHER constraint is not swallowed into a conflict", async () => {
    const { service } = setup(Object.assign(new Error("duplicate key"), { code: "23505", constraint: "some_other_index" }));
    await expect(service.saveTheme({ name: "A" })).rejects.toMatchObject({ code: "23505" });
  });
});

// STORY-097 review round 1 — an anonymous portal viewer is never sent the admin-only asset path.
describe("STORY-097 · AgencyService.themeForPortal and the logo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const row = {
    id: "0198f6a0-0000-7000-8000-0000000000aa", name: "Agency", is_default: true, color_primary: null, color_accent: null, color_bg: null, color_fg: null, font_family: "Inter",
    hide_nominara_brand: false, email_from_name: null, email_reply_to: null, custom_css: null, email_footer_html: null, logo_light_key: "dev/ws/reports/branding/t/logo_light-x.png",
  };

  it("review r1 · the portal's logo_url is null even when a logo is stored (its only route needs a workspace session and agency:branding); the editor still gets the path", async () => {
    const client = { query: vi.fn(async () => ({ rows: [row] })) };
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client, context: { workspaceId: "ws-1", actorId: "a" } } as never);
    const service = new AgencyService({} as never);
    expect((await service.themeForPortal(row.id)).logo_url).toBeNull();
    expect((await service.listThemes({ limit: 50 })).items[0]!.logo_url).toBe(`/v1/themes/${row.id}/assets/logo_light`);
  });
});
