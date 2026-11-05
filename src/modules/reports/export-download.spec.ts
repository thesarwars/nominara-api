import { Reflector } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPORT_DOWNLOAD_URL_SECONDS } from "../../../contracts/reports/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { SCOPED_BY_QUERY_KEY } from "../../api/decorators/scoped-by-query.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { ConflictError, DegradedError, NotFoundError } from "../../api/errors/domain-errors.js";
import * as metrics from "../../lib/telemetry/metrics.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { ExportDownloadController } from "./export-download.controller.js";
import { exportDownloadUrl, ExportDownloadService } from "./export-download.service.js";

// STORY-180 AC2 + decision 54 (2) - the on-screen download: an authenticated route that mints a FRESH 15-minute presign of the
// STORED key on every fetch, and refuses while the file has not landed.

const WS = "0190eeee-0000-7000-8000-000000000001";
const ID = "0190eeee-0000-7000-8000-0000000000a1";
const KEY = `unit/${WS}/${ID}.pdf`;

type Row = { object_key: string; format: string; period_end: string };

function build(opts: { rows?: Row[]; presign?: () => Promise<string> } = {}) {
  const order: string[] = [];
  const queries: Array<{ text: string; params: unknown[] }> = [];
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ context: { workspaceId: WS, actorId: "actor" } } as never);
  vi.spyOn(tenantContext, "withTenantContext").mockImplementation(async (_c, _ctx, fn) => {
    const tx = {
      query: vi.fn(async (text: string, params: unknown[]) => {
        queries.push({ text, params });
        return { rows: opts.rows ?? [], rowCount: (opts.rows ?? []).length };
      }),
    };
    const out = await fn(tx as never);
    order.push("tx-committed");
    return out;
  });
  const release = vi.fn();
  const presignGetStored = vi.fn(async (..._a: unknown[]) => {
    order.push("presign");
    return opts.presign ? opts.presign() : `https://s3.example.test/${KEY}?sig=x`;
  });
  const service = new ExportDownloadService({ connect: async () => ({ release }) } as never, { bind: () => ({ presignGetStored }) } as never);
  return { service, queries, order, release, presignGetStored };
}

afterEach(() => vi.restoreAllMocks());

describe("STORY-180 AC2 · the download_url the export carries", () => {
  it("is the API's download route, an absolute http(s) URL", () => {
    expect(exportDownloadUrl("https://api.example.test", ID)).toBe(`https://api.example.test/v1/exports/${ID}/download`);
    expect(exportDownloadUrl("http://localhost:4000/", ID)).toBe(`http://localhost:4000/v1/exports/${ID}/download`);
  });
});

describe("STORY-180 AC2 · GET /v1/exports/{id}/download", () => {
  it("redirects to a 15-minute presign of the STORED key with the server-chosen filename, minted AFTER the transaction", async () => {
    const h = build({ rows: [{ object_key: KEY, format: "pdf", period_end: "2026-10-31" }] });
    const out = await h.service.resolve({ id: ID });
    expect(out.url).toBe(`https://s3.example.test/${KEY}?sig=x`);
    expect(h.presignGetStored).toHaveBeenCalledWith("reports", KEY, { expiresInSeconds: EXPORT_DOWNLOAD_URL_SECONDS, downloadFilename: "nominara-report-2026-10-31.pdf" });
    expect(EXPORT_DOWNLOAD_URL_SECONDS).toBe(900);
    // The lookup transaction ends before the presign; a second short one then counts the served download.
    expect(h.order).toEqual(["tx-committed", "presign", "tx-committed"]);
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it("every fetch mints a new presign (nothing is cached or replayed)", async () => {
    const h = build({ rows: [{ object_key: KEY, format: "csv", period_end: "2026-10-31" }] });
    await h.service.resolve({ id: ID });
    await h.service.resolve({ id: ID });
    expect(h.presignGetStored).toHaveBeenCalledTimes(2);
  });

  it("reads the artifact inside the caller's workspace, unexpired, and counts the download", async () => {
    const h = build({ rows: [{ object_key: KEY, format: "pdf", period_end: "2026-10-31" }] });
    await h.service.resolve({ id: ID });
    expect(h.queries[0]!.params).toEqual([ID, WS]);
    expect(h.queries[0]!.text).toContain("workspace_id = $2");
    expect(h.queries[0]!.text).toContain("expires_at > now()");
    // A scoped manager reaches only exports whose projects are all in scope (the route is @ScopedByQuery: this IS the check).
    expect(h.queries[0]!.text).toContain("project_ids <@ app.current_scope_projects()");
    expect(h.queries[0]!.text).not.toContain("download_count");
    // Counted afterwards, in its own statement, and only for a served download.
    expect(h.queries[1]!.text).toContain("download_count = download_count + 1");
  });

  it("a refused presign counts no download", async () => {
    const h = build({
      rows: [{ object_key: KEY, format: "pdf", period_end: "2026-10-31" }],
      presign: async () => {
        throw new DegradedError({ message: "object storage is not configured" });
      },
    });
    await h.service.resolve({ id: ID }).catch(() => undefined);
    expect(h.queries.some((q) => q.text.includes("download_count"))).toBe(false);
  });

  it("no such artifact (unknown, expired, another workspace's) is the neutral 404 and presigns nothing", async () => {
    const h = build({ rows: [] });
    await expect(h.service.resolve({ id: ID })).rejects.toBeInstanceOf(NotFoundError);
    expect(h.presignGetStored).not.toHaveBeenCalled();
  });

  it("a file that has not landed yet (key still pending) is 409 conflict, not a presign of a missing object", async () => {
    const h = build({ rows: [{ object_key: `pending:${ID}`, format: "pdf", period_end: "2026-10-31" }] });
    await expect(h.service.resolve({ id: ID })).rejects.toBeInstanceOf(ConflictError);
    expect(h.presignGetStored).not.toHaveBeenCalled();
  });

  it("storage not configured stays 503 degraded", async () => {
    const h = build({
      rows: [{ object_key: KEY, format: "pdf", period_end: "2026-10-31" }],
      presign: async () => {
        throw new DegradedError({ message: "object storage is not configured" });
      },
    });
    await expect(h.service.resolve({ id: ID })).rejects.toBeInstanceOf(DegradedError);
  });

  it("emits a metric per outcome", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    await build({ rows: [{ object_key: KEY, format: "pdf", period_end: "2026-10-31" }] }).service.resolve({ id: ID });
    await build({ rows: [] }).service.resolve({ id: ID }).catch(() => undefined);
    await build({ rows: [{ object_key: `pending:${ID}`, format: "pdf", period_end: "2026-10-31" }] }).service.resolve({ id: ID }).catch(() => undefined);
    const outcomes = count.mock.calls.filter((c) => c[0] === "nominara_reports_downloads_total").map((c) => (c[1] as { outcome: string }).outcome);
    expect(outcomes).toEqual(["redirected", "refused", "not_ready"]);
  });

  it("the route needs export:data and is declared as a redirect", () => {
    const reflector = new Reflector();
    const handler = ExportDownloadController.prototype.download;
    expect(reflector.get(REQUIRE_PERMISSION_KEY, handler)).toBe("export:data");
    expect(Reflect.getMetadata(SCOPED_BY_QUERY_KEY, handler)).toBe(true);
    expect(reflector.get(API_CONTRACT_KEY, handler)).toMatchObject({ operationId: "downloadExport", redirect: true });
  });
});
