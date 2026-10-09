import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { IDEMPOTENT_KEY } from "../../api/decorators/idempotent.decorator.js";
import { METER_KEY, type MeterSpec } from "../../api/decorators/meter.decorator.js";
import { PROJECT_PARAM_KEY } from "../../api/decorators/project-param.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { QuotaGuard } from "../../api/guards/quota.guard.js";
import { isMeteredPdfExport } from "./export-metering.js";
import { ExportService } from "./export.service.js";
import { ReportsController } from "./reports.controller.js";
import { ReportsModule } from "./reports.module.js";
import { MethodologyService } from "./methodology.service.js";

describe("ReportsModule", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    applyFakeApiEnv();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("NEW-E-100a — mounts the methodology route and its service", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ReportsModule] }).compile();
    expect(moduleRef.get(ReportsController)).toBeInstanceOf(ReportsController);
    expect(moduleRef.get(MethodologyService)).toBeInstanceOf(MethodologyService);
    await moduleRef.close();
  });

  it("NEW-E-100a AC2 — the route is project-scoped through the project param guard", () => {
    const reflector = new Reflector();
    expect(reflector.get(PROJECT_PARAM_KEY, ReportsController.prototype.methodology)).toBe("id");
  });
});

describe("NEW-E-100b · the export route's declarations", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    applyFakeApiEnv();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });
  const reflector = new Reflector();
  const handler = ReportsController.prototype.export;

  it("NEW-E-100b — mounts ExportService", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ReportsModule] }).compile();
    expect(moduleRef.get(ExportService)).toBeInstanceOf(ExportService);
    await moduleRef.close();
  });

  it("NEW-E-100b — export:data, project-scoped, idempotent, and metered on pdf_exports (1 unit)", () => {
    expect(reflector.get(REQUIRE_PERMISSION_KEY, handler)).toBe("export:data");
    expect(reflector.get(PROJECT_PARAM_KEY, handler)).toBe("id");
    expect(reflector.get(IDEMPOTENT_KEY, handler)).toBe(true);
    const meter = reflector.get<MeterSpec>(METER_KEY, handler);
    expect(meter).toMatchObject({ metric: "pdf_exports", quantity: 1 });
    expect(meter.when).toBe(isMeteredPdfExport);
  });

  const request = (body: unknown, key: string | null = "k-1") => ({ body, headers: key === null ? {} : { "idempotency-key": key } });
  const valid = { format: "pdf", sections: ["overview"], timeframe: "30d", hide_competitors: false, hide_costs: true };

  it("NEW-E-100b — only a valid PDF request with an Idempotency-Key is metered", () => {
    expect(isMeteredPdfExport(request(valid))).toBe(true);
    expect(isMeteredPdfExport(request({ ...valid, format: "csv" }))).toBe(false);
    expect(isMeteredPdfExport(request(valid, null))).toBe(false);
    expect(isMeteredPdfExport(request(valid, ""))).toBe(false);
    expect(isMeteredPdfExport(request(valid, "x".repeat(256)))).toBe(false);
    expect(isMeteredPdfExport(request({ ...valid, extra: 1 }))).toBe(false);
    expect(isMeteredPdfExport(request({ ...valid, sections: [] }))).toBe(false);
    expect(isMeteredPdfExport(request(undefined))).toBe(false);
    expect(isMeteredPdfExport({})).toBe(false);
  });

  it("NEW-E-100b — QuotaGuard lets an unmetered variant through without resolving entitlements or touching the pool", async () => {
    const boom = (): never => {
      throw new Error("the cap logic ran for an unmetered variant");
    };
    const guard = new QuotaGuard(reflector, { resolve: boom, resolveForWorkspace: boom } as never, {} as never, { connect: boom } as never);
    const context = {
      getHandler: () => handler,
      getClass: () => ReportsController,
      switchToHttp: () => ({ getRequest: () => ({ ...request({ ...valid, format: "csv" }), tenant: { workspaceId: "w" } }) }),
    } as never;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
