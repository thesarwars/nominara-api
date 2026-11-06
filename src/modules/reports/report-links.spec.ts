import { afterEach, describe, expect, it, vi } from "vitest";
import { REPORT_LINK_REDIRECT_SECONDS } from "../../../contracts/reports/index.js";
import { DegradedError, NotFoundError, TokenRevokedError } from "../../api/errors/domain-errors.js";
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

function build(opts: { rows?: Array<{ object_key: string; id?: string; format?: string; revoked?: boolean }>; head?: () => Promise<unknown>; presign?: (ns: string, key: string, o: unknown) => Promise<string> } = {}) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  // The lookup selects id and format with the key; fixtures that only care about the key get plausible ones.
  const rows = (opts.rows ?? []).map((r) => ({ id: "0190dddd-0000-7000-8000-0000000000a1", format: "pdf", revoked: false, ...r }));
  const tx = {
    query: vi.fn(async (text: string, p: unknown[]) => {
      queries.push({ text, params: p });
      return { rows, rowCount: rows.length };
    }),
  };
  const contexts: unknown[] = [];
  vi.spyOn(tenantContext, "withTenantContext").mockImplementation(async (_c, ctx, fn) => {
    contexts.push(ctx);
    return fn(tx as never);
  });
  const release = vi.fn();
  const presignGetStored = vi.fn(opts.presign ?? (async (_ns: string, key: string) => `https://s3.example.test/${key}?sig=x`));
  const head = vi.fn(opts.head ?? (async () => ({ bytes: 1 })));
  const presignGet = vi.fn(async (_ns: string, relative: string) => `https://s3.example.test/relative/${relative}?sig=x`);
  const service = new ReportLinksService({ connect: async () => ({ release }) } as never, { bind: () => ({ presignGetStored, head, presignGet }) } as never);
  return { service, queries, contexts, release, presignGetStored, head, presignGet };
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
    expect(q.params).toHaveLength(1); // the workspace is the transaction's (app.current_workspace()), not a bind the caller can vary
    expect(q.text).toContain("a.workspace_id = app.current_workspace()");
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

  it.each(["pending", "failed", "purged"])("r5 · an artifact whose key is only a %s marker is the same 404, whatever storage holds (no fallback to a guessed key)", async (marker) => {
    const h = build({ rows: [{ object_key: `${marker}:0190dddd-0000-7000-8000-0000000000a1` }] });
    await expect(h.service.resolve(params)).rejects.toBeInstanceOf(NotFoundError);
    expect(h.presignGetStored).not.toHaveBeenCalled();
    expect(h.presignGet).not.toHaveBeenCalled();
    expect(h.head).not.toHaveBeenCalled();
  });

  it("r5 (d) · a REVOKED link answers token_revoked 'This link was revoked.', not the neutral 404, and presigns nothing", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build({ rows: [{ object_key: `unit/${WS}/a.pdf`, revoked: true }] });
    const error = await h.service.resolve(params).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenRevokedError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect((error as Error).message).toBe("This link was revoked.");
    expect(h.presignGetStored).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith("nominara_reports_link_clicks_total", { outcome: "revoked" });
    // Not counted as a served click.
    expect(h.queries.some((q) => q.text.includes("download_count"))).toBe(false);
  });

  it("r5 (d) · a revoked link whose artifact has also expired is still the neutral 404 (expiry is decided in the query, before revocation)", async () => {
    const h = build({ rows: [] });
    await expect(h.service.resolve(params)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("r5 (d) · revocation is a read of the row inside the path's workspace: another workspace's id finds nothing", async () => {
    const h = build({ rows: [] });
    await expect(h.service.resolve({ ...params, workspaceId: "0190dddd-0000-7000-8000-0000000000bb" })).rejects.toBeInstanceOf(NotFoundError);
    expect(h.contexts[0]).toMatchObject({ workspaceId: "0190dddd-0000-7000-8000-0000000000bb" });
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
    await build({ rows: [{ object_key: `unit/${WS}/a.pdf`, revoked: true }] }).service.resolve(params).catch(() => undefined);
    const outcomes = count.mock.calls.filter((c) => c[0] === "nominara_reports_link_clicks_total").map((c) => (c[1] as { outcome: string }).outcome);
    expect(outcomes).toEqual(["redirected", "refused", "revoked"]);
  });

  it("the route is public and declared as a redirect", () => {
    const reflector = new Reflector();
    const handler = ReportLinksController.prototype.open;
    expect(reflector.get(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(reflector.get(API_CONTRACT_KEY, handler)).toMatchObject({ operationId: "openReportLink", redirect: true });
  });
});

// STORY-180 r5 (d) - POST /v1/exports/{id}/revoke-link: owners and admins revoke a sent link.
describe("STORY-180 r5 (d) · revoking a report link", () => {
  const ID = "0190dddd-0000-7000-8000-0000000000a1";
  function buildRevoke(rows: Array<{ id: string; link_revoked_at: Date }>) {
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const client = { query: vi.fn(async (text: string, p: unknown[]) => (queries.push({ text, params: p }), { rows, rowCount: rows.length })) };
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ context: { workspaceId: WS, actorId: "actor" }, client } as never);
    return { service: new ReportLinksService({} as never, {} as never), queries };
  }

  it("sets link_revoked_at on the artifact in the caller's workspace and returns when", async () => {
    const at = new Date("2026-11-05T10:00:00.000Z");
    const h = buildRevoke([{ id: ID, link_revoked_at: at }]);
    await expect(h.service.revoke({ id: ID })).resolves.toEqual({ export_id: ID, link_revoked_at: "2026-11-05T10:00:00.000Z" });
    expect(h.queries[0]!.text).toContain("link_revoked_at = COALESCE(link_revoked_at, now())");
    expect(h.queries[0]!.text).toContain("workspace_id = app.current_workspace()");
    expect(h.queries[0]!.params).toEqual([ID]);
  });

  it("is idempotent: the first revocation's time is kept (COALESCE), a second call returns it", async () => {
    const first = new Date("2026-11-05T10:00:00.000Z");
    const h = buildRevoke([{ id: ID, link_revoked_at: first }]);
    const a = await h.service.revoke({ id: ID });
    const b = await h.service.revoke({ id: ID });
    expect(b).toEqual(a);
  });

  it("an unknown or other-workspace artifact is a 404 and nothing is claimed revoked", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = buildRevoke([]);
    await expect(h.service.revoke({ id: ID })).rejects.toBeInstanceOf(NotFoundError);
    expect(count).toHaveBeenCalledWith("nominara_reports_link_revocations_total", { outcome: "not_found" });
  });

  it("counts a revocation and logs the workspace id only", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    await buildRevoke([{ id: ID, link_revoked_at: new Date() }]).service.revoke({ id: ID });
    expect(count).toHaveBeenCalledWith("nominara_reports_link_revocations_total", { outcome: "revoked" });
  });
});
