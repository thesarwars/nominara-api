import { readFileSync } from "node:fs";
import { Reflector } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RETENTION_EXPORT_URL_SECONDS } from "../../../contracts/billing/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { AUDIT_METADATA_KEY } from "../../api/decorators/audit.decorator.js";
import { CREDITS_KEY } from "../../api/decorators/credits.decorator.js";
import { IDEMPOTENT_KEY } from "../../api/decorators/idempotent.decorator.js";
import { METER_KEY } from "../../api/decorators/meter.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { REQUIRE_STORAGE_KEY } from "../../api/decorators/require-storage.decorator.js";
import { DegradedError, NotFoundError } from "../../api/errors/domain-errors.js";
import * as afterTx from "../../api/after-transaction.js";
import * as metrics from "../../lib/telemetry/metrics.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { RetentionExportController } from "./retention-export.controller.js";
import { RetentionExportService } from "./retention-export.service.js";

// STORY-185 - the route's contract (owner and admin, audited, no credit or quota machinery) and the download's rules (a FRESH 15-minute presign
// per fetch, minted after the request transaction, tenant-checked, neutral 404, never a presign of an unfinished export).

const WS = "0190eeee-0000-7000-8000-000000000001";
const ID = "0190eeee-0000-7000-8000-0000000000a1";
const KEY = `test/${WS}/retention-exports/${ID}/run.zip`;
const reflector = new Reflector();
const route = (name: keyof RetentionExportController) => RetentionExportController.prototype[name] as (...a: never[]) => unknown;
const meta = (key: unknown, name: keyof RetentionExportController) => reflector.get(key as string, route(name));

describe("STORY-185 · the routes", () => {
  it("AC1 · only owner and admin: billing:write requests it, billing:read views and downloads it", () => {
    expect(meta(REQUIRE_PERMISSION_KEY, "request")).toBe("billing:write");
    expect(meta(REQUIRE_PERMISSION_KEY, "view")).toBe("billing:read");
    expect(meta(REQUIRE_PERMISSION_KEY, "download")).toBe("billing:read");
  });

  it("AC6 · audited, and 202: the request is a background job", () => {
    expect(meta(AUDIT_METADATA_KEY, "request")).toMatchObject({ action: "billing.retention_export.requested", resourceType: "retention_export", resourceIdFrom: "response" });
    expect(Reflect.getMetadata("__httpCode__", route("request"))).toBe(202);
  });

  it("AC6 · 0 credits and not the report export: no @Credits, no @Meter (the pdf_exports quota), and the export:data permission is not what gates it", () => {
    for (const name of ["request", "view", "download"] as const) {
      expect(meta(CREDITS_KEY, name), `${name} has no credit action`).toBeUndefined();
      expect(meta(METER_KEY, name), `${name} meters no quota`).toBeUndefined();
      expect(meta(REQUIRE_PERMISSION_KEY, name)).not.toBe("export:data");
    }
    expect(meta(IDEMPOTENT_KEY, "request")).toBeUndefined(); // dedupe is by state (one in flight), not by a client key
  });

  it("the request refuses when storage is not configured, before anything is recorded; the contract names the operations and the download redirects", () => {
    expect(meta(REQUIRE_STORAGE_KEY, "request")).toBe(true);
    expect(meta(API_CONTRACT_KEY, "request")).toMatchObject({ operationId: "requestRetentionExport" });
    expect(meta(API_CONTRACT_KEY, "view")).toMatchObject({ operationId: "getRetentionExport" });
    expect(meta(API_CONTRACT_KEY, "download")).toMatchObject({ operationId: "downloadRetentionExport", redirect: true });
  });

  it("AC6 · no code path of the build or the request reaches the wallet, the ledger, a reservation, a quota or the report-artifact tables", () => {
    const sources = [
      "src/modules/billing/retention-export.service.ts",
      "src/modules/billing/retention-export.controller.ts",
      "src/lib/queue/handlers/billing-retention-export.handler.ts",
      "src/lib/billing/retention-export/build.ts",
      "src/lib/billing/retention-export/scope.ts",
      "src/lib/billing/retention-export/ready-email.ts",
    ].map((p) => readFileSync(p, "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n"));
    for (const code of sources) {
      expect(code).not.toMatch(/credit_ledger|credit_wallets|credit_holds|usage_ledger|usage_reservations|usage_counters|report_artifacts|CreditLedger|CreditGuard|QuotaGuard|EntitlementResolver|reserveCredits|(?<![A-Za-z])ExportService/);
    }
  });
});

type Row = { id: string; status: string; created_at: Date; expires_at: Date; ready_at: Date | null; coverage: unknown; error_code: string | null; object_key: string | null; object_purged_at: Date | null };
const READY: Row = { id: ID, status: "ready", created_at: new Date("2026-11-12T00:00:00Z"), expires_at: new Date(Date.now() + 5 * 86_400_000), ready_at: new Date("2026-11-12T00:05:00Z"), coverage: null, error_code: null, object_key: KEY, object_purged_at: null };

function build(rows: Row[], presign?: () => Promise<string>) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const client = { query: vi.fn(async (text: string, params: unknown[]) => (queries.push({ text, params }), { rows, rowCount: rows.length })) };
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ context: { workspaceId: WS, actorId: "actor" }, client } as never);
  const tasks: Array<() => Promise<void>> = [];
  vi.spyOn(afterTx, "afterTransaction").mockImplementation((t) => (tasks.push(t), true));
  const presignGetStored = vi.fn(async (..._a: unknown[]) => (presign ? presign() : `https://s3.example.test/${KEY}?sig=${String(Math.random())}`));
  const service = new RetentionExportService({ bind: () => ({ presignGetStored }) } as never, "https://api.example.test");
  const location = vi.fn((_u: string) => undefined);
  const run = async (): Promise<void> => {
    await service.resolve({ id: ID }, location);
    for (const t of tasks.splice(0)) await t();
  };
  return { service, queries, presignGetStored, location, run, tasks };
}

afterEach(() => vi.restoreAllMocks());

describe("STORY-185 AC3 · GET /v1/billing/retention-export/{id}/download", () => {
  it("redirects to a 15-minute presign of the STORED key with a date-only file name", async () => {
    const h = build([READY]);
    await h.run();
    expect(h.presignGetStored).toHaveBeenCalledWith("reports", KEY, { expiresInSeconds: RETENTION_EXPORT_URL_SECONDS, downloadFilename: "nominara-full-export-2026-11-12.zip" });
    expect(RETENTION_EXPORT_URL_SECONDS).toBe(900);
    expect(h.location).toHaveBeenCalledTimes(1);
  });

  it("every fetch mints a FRESH presign (nothing cached), and the presign is minted after the request transaction, never inside it", async () => {
    const h = build([READY]);
    await h.service.resolve({ id: ID }, h.location);
    expect(h.presignGetStored, "nothing presigned while the request transaction is open").not.toHaveBeenCalled();
    for (const t of h.tasks.splice(0)) await t();
    await h.run();
    expect(h.presignGetStored).toHaveBeenCalledTimes(2);
    expect(new Set(h.location.mock.calls.map((c) => c[0])).size).toBe(2);
  });

  it("the lookup is tenant-checked by the workspace predicate on the ambient client, and the id is the only parameter (the workspace never comes from the request)", async () => {
    const h = build([READY]);
    await h.run();
    expect(h.queries[0]!.params).toEqual([ID]);
    expect(h.queries[0]!.text).toContain("workspace_id = app.current_workspace()");
  });

  it("unknown, other-workspace and expired are one neutral 404, and nothing is presigned", async () => {
    for (const rows of [[], [{ ...READY, expires_at: new Date(Date.now() - 1000) }]]) {
      const h = build(rows);
      await expect(h.run()).rejects.toBeInstanceOf(NotFoundError);
      expect(h.presignGetStored).not.toHaveBeenCalled();
    }
  });

  it("an export whose object the cleanup deleted is the same neutral 404 whatever its date says", async () => {
    const h = build([{ ...READY, object_purged_at: new Date() }]);
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundError);
    expect(h.presignGetStored).not.toHaveBeenCalled();
  });

  it("an export still building or failed is 503 degraded, never a presign", async () => {
    for (const status of ["requested", "building", "failed"]) {
      const h = build([{ ...READY, status, object_key: null }]);
      await expect(h.run()).rejects.toBeInstanceOf(DegradedError);
      expect(h.presignGetStored).not.toHaveBeenCalled();
    }
  });

  it("counts the outcome; never the key or the URL, and a refused presign sets no Location", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build([READY]);
    await h.run();
    expect(count).toHaveBeenCalledWith("nominara_billing_retention_export_downloads_total", { outcome: "redirected" });
    const bad = build([READY], async () => {
      throw new DegradedError({ message: "storage down" });
    });
    await expect(bad.run()).rejects.toBeInstanceOf(DegradedError);
    expect(bad.location).not.toHaveBeenCalled();
  });
});
