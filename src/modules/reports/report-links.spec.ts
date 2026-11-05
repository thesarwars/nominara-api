import { afterEach, describe, expect, it, vi } from "vitest";
import { REPORT_LINK_REDIRECT_SECONDS } from "../../../contracts/reports/index.js";
import { DegradedError, NotFoundError } from "../../api/errors/domain-errors.js";
import { hashReportLinkToken, reportLinkToken } from "../../lib/reports/report-artifact-mail.js";
import { StorageTenancyError } from "../../lib/storage/storage-keys.js";
import * as metrics from "../../lib/telemetry/metrics.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { ReportLinksController } from "./report-links.controller.js";
import { ReportLinksService } from "./report-links.service.js";
import { Reflector } from "@nestjs/core";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { IS_PUBLIC_KEY } from "../../api/decorators/public.decorator.js";

// STORY-180 AC2 / AC3 - the emailed link: a stored, revocable token, then a redirect to a fresh 15-minute presign of the STORED key.

const WS = "0190dddd-0000-7000-8000-000000000001";
const TOKEN = reportLinkToken(Buffer.alloc(32, 3), "0190dddd-0000-7000-8000-0000000000a1");
const params = { workspaceId: WS, token: TOKEN };

function build(opts: { rows?: Array<{ object_key: string }>; presign?: (ns: string, key: string, o: unknown) => Promise<string> } = {}) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const tx = {
    query: vi.fn(async (text: string, p: unknown[]) => {
      queries.push({ text, params: p });
      return { rows: opts.rows ?? [], rowCount: (opts.rows ?? []).length };
    }),
  };
  const contexts: unknown[] = [];
  vi.spyOn(tenantContext, "withTenantContext").mockImplementation(async (_c, ctx, fn) => {
    contexts.push(ctx);
    return fn(tx as never);
  });
  const release = vi.fn();
  const presignGetStored = vi.fn(opts.presign ?? (async (_ns: string, key: string) => `https://s3.example.test/${key}?sig=x`));
  const service = new ReportLinksService({ connect: async () => ({ release }) } as never, { bind: () => ({ presignGetStored }) } as never);
  return { service, queries, contexts, release, presignGetStored };
}

afterEach(() => vi.restoreAllMocks());

describe("STORY-180 AC3 · GET /v1/report-links/{workspaceId}/{token}", () => {
  it("redirects to a 15-minute presign of the stored key, in the path's workspace, and counts the click", async () => {
    const h = build({ rows: [{ object_key: `unit/${WS}/a.pdf` }] });
    const out = await h.service.resolve(params);
    expect(out.url).toBe(`https://s3.example.test/unit/${WS}/a.pdf?sig=x`);
    expect(h.presignGetStored).toHaveBeenCalledWith("reports", `unit/${WS}/a.pdf`, { expiresInSeconds: REPORT_LINK_REDIRECT_SECONDS });
    expect(REPORT_LINK_REDIRECT_SECONDS).toBe(900);
    expect(h.contexts[0]).toMatchObject({ workspaceId: WS });
    expect(h.release).toHaveBeenCalledTimes(2); // the lookup, then the click count
  });

  it("looks the token up by its hash, never by the token, and checks revocation and expiry in the query", async () => {
    const h = build({ rows: [{ object_key: `unit/${WS}/a.pdf` }] });
    await h.service.resolve(params);
    const q = h.queries[0]!;
    expect((q.params[0] as Buffer).equals(hashReportLinkToken(TOKEN))).toBe(true);
    expect(JSON.stringify(q.params)).not.toContain(TOKEN);
    expect(q.params[1]).toBe(WS);
    expect(q.text).toContain("link_revoked_at IS NULL");
    expect(q.text).toContain("expires_at > now()");
  });

  it("refuses a workspace that is deleted or pending erasure, in the query itself", async () => {
    const h = build({ rows: [{ object_key: `unit/${WS}/a.pdf` }] });
    await h.service.resolve(params);
    expect(h.queries[0]!.text).toContain("w.deleted_at IS NULL");
    expect(h.queries[0]!.text).not.toContain("download_count");
    expect(h.queries[1]!.text).toContain("download_count = download_count + 1");
    expect(h.queries[0]!.text).toContain("w.deletion_execute_at IS NULL");
  });

  it("mints the presign only after the transaction has ended (no connection is held across it)", async () => {
    const h = build({ rows: [{ object_key: `unit/${WS}/a.pdf` }] });
    h.presignGetStored.mockImplementationOnce(async () => {
      expect(h.release).toHaveBeenCalledTimes(1);
      return "https://s3.example.test/x";
    });
    await h.service.resolve(params);
    expect(h.presignGetStored).toHaveBeenCalledTimes(1);
  });

  it("an unknown, revoked, expired or other-workspace token (no row) is the one neutral 404 and presigns nothing", async () => {
    const h = build({ rows: [] });
    await expect(h.service.resolve(params)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.presignGetStored).not.toHaveBeenCalled();
  });

  it("an artifact whose file never landed (key still pending) is the same 404", async () => {
    const h = build({ rows: [{ object_key: "pending:0190dddd-0000-7000-8000-0000000000a1" }] });
    await expect(h.service.resolve(params)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.presignGetStored).not.toHaveBeenCalled();
  });

  it("AC2 · a stored key outside the workspace is refused with the same 404, counted, and never signed", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build({
      rows: [{ object_key: "unit/0190dddd-0000-7000-8000-0000000000ff/a.pdf" }],
      presign: async () => {
        throw new StorageTenancyError("stored object key is outside the current workspace prefix");
      },
    });
    await expect(h.service.resolve(params)).rejects.toBeInstanceOf(NotFoundError);
    expect(count).toHaveBeenCalledWith("nominara_reports_link_clicks_total", { outcome: "tenancy_refused" });
  });

  it("storage not configured stays 503 degraded: it is not hidden behind the neutral 404", async () => {
    const h = build({
      rows: [{ object_key: `unit/${WS}/a.pdf` }],
      presign: async () => {
        throw new DegradedError({ message: "object storage is not configured" });
      },
    });
    await expect(h.service.resolve(params)).rejects.toBeInstanceOf(DegradedError);
  });

  it("emits a metric per outcome", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    await build({ rows: [{ object_key: `unit/${WS}/a.pdf` }] }).service.resolve(params);
    await build({ rows: [] }).service.resolve(params).catch(() => undefined);
    const outcomes = count.mock.calls.filter((c) => c[0] === "nominara_reports_link_clicks_total").map((c) => (c[1] as { outcome: string }).outcome);
    expect(outcomes).toEqual(["redirected", "refused"]);
  });

  it("the route is public and declared as a redirect", () => {
    const reflector = new Reflector();
    const handler = ReportLinksController.prototype.open;
    expect(reflector.get(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(reflector.get(API_CONTRACT_KEY, handler)).toMatchObject({ operationId: "openReportLink", redirect: true });
  });
});
