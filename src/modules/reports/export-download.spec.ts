import { Reflector } from "@nestjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPORT_DOWNLOAD_URL_SECONDS } from "../../../contracts/reports/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { SCOPED_BY_QUERY_KEY } from "../../api/decorators/scoped-by-query.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { DegradedError, NotFoundError } from "../../api/errors/domain-errors.js";
import * as afterTx from "../../api/after-transaction.js";
import * as metrics from "../../lib/telemetry/metrics.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { ExportDownloadController } from "./export-download.controller.js";
import { exportDownloadUrl, ExportDownloadService } from "./export-download.service.js";

// STORY-180 AC2 + decision 54 (2) - the on-screen download: an authenticated route that mints a FRESH 15-minute presign of the
// STORED key on every fetch, and answers a clear 503 when the stored file is unavailable.
// Round 5 (owner decision 60): the lookup runs on the ambient request client; the presign (credential resolution) and the served-download
// count run AFTER the request transaction, outside it (ADR-0003).

const WS = "0190eeee-0000-7000-8000-000000000001";
const ID = "0190eeee-0000-7000-8000-0000000000a1";
const KEY = `unit/${WS}/${ID}.pdf`;

type Row = { object_key: string; format: string; period_end: string };

function build(opts: { rows?: Row[]; presign?: () => Promise<string>; countFails?: boolean; hideBrand?: boolean; removeBrandGranted?: boolean } = {}) {
  const order: string[] = [];
  const queries: Array<{ text: string; params: unknown[] }> = [];
  // The ambient request client: the lookup runs inside the interceptor's transaction, so the service must use THIS client for it.
  const client = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      order.push("lookup");
      queries.push({ text, params });
      return { rows: (opts.rows ?? []).map((r) => ({ ...r, hide_brand: opts.hideBrand ?? null })), rowCount: (opts.rows ?? []).length };
    }),
  };
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ context: { workspaceId: WS, actorId: "actor" }, client } as never);
  // The served-download count: its own short tenant transaction on a pooled connection, taken only AFTER the request transaction.
  const countQueries: Array<{ text: string; params: unknown[] }> = [];
  vi.spyOn(tenantContext, "withTenantContext").mockImplementation(async (_c, _ctx, fn) => {
    order.push("count-tx");
    if (opts.countFails) throw new Error("db down");
    return fn({ query: async (text: string, params: unknown[]) => (countQueries.push({ text, params }), { rows: [], rowCount: 1 }) } as never);
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ release })) };
  const afterTasks: Array<() => Promise<void>> = [];
  vi.spyOn(afterTx, "afterTransaction").mockImplementation((t) => (afterTasks.push(t), true));
  const presignGetStored = vi.fn(async (..._a: unknown[]) => {
    order.push("presign");
    return opts.presign ? opts.presign() : `https://s3.example.test/${KEY}?sig=x`;
  });
  const resolver = { resolveForWorkspace: async () => ({ entitlements: { "whitelabel.remove_branding": { value: opts.removeBrandGranted === true } } }) };
  const service = new ExportDownloadService({ bind: () => ({ presignGetStored }) } as never, pool as never, resolver as never);
  const location = vi.fn((_url: string) => void order.push("location"));
  /** The whole request: the lookup in the transaction, then the after-transaction work. */
  const run = async (): Promise<void> => {
    await service.resolve({ id: ID }, location);
    for (const task of afterTasks.splice(0)) await task();
  };
  return { service, queries, countQueries, order, client, presignGetStored, location, run, afterTasks, release, pool };
}

afterEach(() => vi.restoreAllMocks());

describe("STORY-180 AC2 · the download_url the export carries", () => {
  it("is the API's download route, an absolute http(s) URL", () => {
    expect(exportDownloadUrl("https://api.example.test", ID)).toBe(`https://api.example.test/v1/exports/${ID}/download`);
    expect(exportDownloadUrl("http://localhost:4000/", ID)).toBe(`http://localhost:4000/v1/exports/${ID}/download`);
  });
});

describe("STORY-180 AC2 · GET /v1/exports/{id}/download", () => {
  const stored: Row = { object_key: KEY, format: "pdf", period_end: "2026-10-31" };

  it("redirects to a 15-minute presign of the STORED key with the server-chosen filename", async () => {
    const h = build({ rows: [stored] });
    await h.run();
    expect(h.location).toHaveBeenCalledWith(`https://s3.example.test/${KEY}?sig=x`);
    expect(h.presignGetStored).toHaveBeenCalledWith("reports", KEY, { expiresInSeconds: EXPORT_DOWNLOAD_URL_SECONDS, downloadFilename: "nominara-report-2026-10-31.pdf" });
    expect(EXPORT_DOWNLOAD_URL_SECONDS).toBe(900);
  });

  it("r5 · the presign (credential resolution) happens AFTER the request transaction's lookup, never inside it", async () => {
    const h = build({ rows: [stored] });
    await h.service.resolve({ id: ID }, h.location);
    // Right after resolve() - still inside the request transaction - nothing has been presigned.
    expect(h.presignGetStored).not.toHaveBeenCalled();
    expect(h.afterTasks).toHaveLength(1);
    for (const task of h.afterTasks) await task();
    expect(h.order).toEqual(["lookup", "presign", "location", "count-tx"]);
  });

  it("r5 · the served-download count takes its own short transaction, after the presign, with the workspace predicate", async () => {
    const h = build({ rows: [stored] });
    await h.run();
    expect(h.pool.connect).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.countQueries[0]!.text).toContain("download_count = download_count + 1");
    expect(h.countQueries[0]!.text).toContain("workspace_id = app.current_workspace()");
    expect(h.client.query).toHaveBeenCalledTimes(1); // the ambient client ran the lookup and nothing else
  });

  it("a failed count never withholds the file and is counted", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build({ rows: [stored], countFails: true });
    await expect(h.run()).resolves.toBeUndefined();
    expect(h.location).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith("nominara_reports_downloads_total", { outcome: "count_failed" });
  });

  it("every fetch mints a new presign (nothing is cached or replayed)", async () => {
    const h = build({ rows: [{ ...stored, format: "csv" }] });
    await h.run();
    await h.run();
    expect(h.presignGetStored).toHaveBeenCalledTimes(2);
  });

  it("reads the artifact inside the caller's workspace, unexpired, by the workspace predicate", async () => {
    const h = build({ rows: [stored] });
    await h.run();
    expect(h.queries[0]!.params).toEqual([ID]);
    expect(h.queries[0]!.text).toContain("workspace_id = app.current_workspace()");
    expect(h.queries[0]!.text).toContain("expires_at > now()");
    // A scoped manager reaches only exports whose projects are all in scope (the route is @ScopedByQuery: this IS the check).
    expect(h.queries[0]!.text).toContain("project_ids <@ app.current_scope_projects()");
    expect(h.queries[0]!.text).not.toContain("download_count");
  });

  it("a refused presign counts no download and sets no Location", async () => {
    const h = build({
      rows: [stored],
      presign: async () => {
        throw new DegradedError({ message: "object storage is not configured" });
      },
    });
    await expect(h.run()).rejects.toBeInstanceOf(DegradedError);
    expect(h.order).not.toContain("count-tx");
    expect(h.location).not.toHaveBeenCalled();
  });

  it("no such artifact (unknown, expired, another workspace's) is the neutral 404 and presigns nothing", async () => {
    const h = build({ rows: [] });
    await expect(h.service.resolve({ id: ID }, h.location)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.afterTasks).toHaveLength(0);
    expect(h.presignGetStored).not.toHaveBeenCalled();
  });

  it.each(["pending", "failed", "purged"])("a file whose key is only a %s marker is a clear 503, never a 409 or a presign of a missing object", async (marker) => {
    const h = build({ rows: [{ ...stored, object_key: `${marker}:${ID}` }] });
    const error = await h.service.resolve({ id: ID }, h.location).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DegradedError);
    expect((error as { getStatus(): number }).getStatus()).toBe(503);
    expect(h.afterTasks).toHaveLength(0);
    expect(h.presignGetStored).not.toHaveBeenCalled();
  });

  it("storage not configured stays 503 degraded", async () => {
    const h = build({
      rows: [stored],
      presign: async () => {
        throw new DegradedError({ message: "object storage is not configured" });
      },
    });
    await expect(h.run()).rejects.toBeInstanceOf(DegradedError);
  });

  it("emits a metric per outcome", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    await build({ rows: [stored] }).run();
    await build({ rows: [] }).run().catch(() => undefined);
    await build({ rows: [{ ...stored, object_key: `pending:${ID}` }] }).run().catch(() => undefined);
    const outcomes = count.mock.calls.filter((c) => c[0] === "nominara_reports_downloads_total").map((c) => (c[1] as { outcome: string }).outcome);
    expect(outcomes).toEqual(["redirected", "refused", "unavailable"]);
  });

  it("the controller sets Location from the service and adds no Retry-After (there is no 409 any more)", async () => {
    const header = vi.fn();
    const reply = { header } as never;
    const controller = new ExportDownloadController({
      resolve: async (_p: unknown, setLocation: (u: string) => void) => setLocation("https://s3.example.test/x"),
    } as never, {} as never);
    await controller.download({ id: ID }, reply);
    expect(header.mock.calls).toEqual([["location", "https://s3.example.test/x"]]);
  });

  it("the route needs export:data and is declared as a redirect", () => {
    const reflector = new Reflector();
    const handler = ExportDownloadController.prototype.download;
    expect(reflector.get(REQUIRE_PERMISSION_KEY, handler)).toBe("export:data");
    expect(Reflect.getMetadata(SCOPED_BY_QUERY_KEY, handler)).toBe(true);
    expect(reflector.get(API_CONTRACT_KEY, handler)).toMatchObject({ operationId: "downloadExport", redirect: true });
  });
});

describe("STORY-097 AC4 · the download file name", () => {
  const row = { object_key: KEY, format: "pdf", period_end: "2026-10-31" };
  const nameOf = (h: ReturnType<typeof build>): string => (h.presignGetStored.mock.calls[0]![2] as { downloadFilename: string }).downloadFilename;

  it("brand not removed: the platform-named file", async () => {
    const h = build({ rows: [row] });
    await h.run();
    expect(nameOf(h)).toBe("nominara-report-2026-10-31.pdf");
  });
  it("brand removed with the entitlement: no platform name", async () => {
    const h = build({ rows: [row], hideBrand: true, removeBrandGranted: true });
    await h.run();
    expect(nameOf(h)).toBe("report-2026-10-31.pdf");
  });
  it("brand switch stored but the entitlement lapsed: the platform name returns", async () => {
    const h = build({ rows: [row], hideBrand: true, removeBrandGranted: false });
    await h.run();
    expect(nameOf(h)).toBe("nominara-report-2026-10-31.pdf");
  });
});

describe("STORY-097 (review fix) · the entitlement read happens after the request transaction", () => {
  it("resolveForWorkspace is not called by the in-transaction lookup, only by the after-transaction work", async () => {
    const h = build({ rows: [{ object_key: KEY, format: "pdf", period_end: "2026-10-31" }] });
    const resolver = (h.service as unknown as { resolver: { resolveForWorkspace: ReturnType<typeof vi.fn> } }).resolver;
    const spy = vi.spyOn(resolver, "resolveForWorkspace");
    await h.service.resolve({ id: ID }, h.location);
    expect(spy).not.toHaveBeenCalled();
    for (const task of h.afterTasks.splice(0)) await task();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
