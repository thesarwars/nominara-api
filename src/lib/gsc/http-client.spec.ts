import { describe, expect, it, vi } from "vitest";
import { GSC_READ_ONLY_SCOPE } from "../../../contracts/integrations/index.js";
import { HttpGscClient, buildAuthorizationUrl } from "./http-client.js";
import { GscQuotaError, GscSourceError, GscUnauthorizedError } from "./port.js";

// STORY-115 C1 - the requested scope set is asserted, not assumed.
describe("STORY-115 authorisation request", () => {
  it("S115-1: the requested scope set is the read-only scope and nothing else", () => {
    const url = new URL(buildAuthorizationUrl({ clientId: "cid", redirectUri: "https://api.example.test/v1/integrations/gsc/oauth/callback", state: "s" }));
    const scopes = (url.searchParams.get("scope") ?? "").split(" ").filter((s) => s !== "");
    expect(scopes).toEqual([GSC_READ_ONLY_SCOPE]);
    expect(scopes.every((scope) => scope.endsWith(".readonly"))).toBe(true);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.test/v1/integrations/gsc/oauth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  const reply = (status: number, body: unknown = {}): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const request = { accessToken: "t", property: "sc-domain:shop.example.com", report: "classic", dimension: "query", startDate: "2026-01-01", endDate: "2026-01-02" } as const;

  it("S115-12c: the source's answers map to the three failure kinds the sync job settles on", async () => {
    await expect(new HttpGscClient(reply(401)).fetchReport(request)).rejects.toBeInstanceOf(GscUnauthorizedError);
    await expect(new HttpGscClient(reply(429)).fetchReport(request)).rejects.toBeInstanceOf(GscQuotaError);
    await expect(new HttpGscClient(reply(503)).fetchReport(request)).rejects.toBeInstanceOf(GscSourceError);
    await expect(new HttpGscClient(reply(401)).listProperties("t")).rejects.toBeInstanceOf(GscUnauthorizedError);
  });

  it("S115-12d: the AI-surface report is not guessed at: it raises its own reason, and asks Google nothing", async () => {
    const asked = vi.fn();
    const client = new HttpGscClient((async () => (asked(), new Response("{}"))) as unknown as typeof fetch);
    await expect(client.fetchReport({ ...request, report: "ai_surface", dimension: "page" })).rejects.toMatchObject({ reason: "ai_surface_report_unavailable" });
    expect(asked).not.toHaveBeenCalled();
  });

  it("S115-12e: classic rows are read with their device, a page or a query, and a non-device row is skipped", async () => {
    const rows = [
      { keys: ["2026-01-01", "best crm", "DESKTOP"], clicks: 3, impressions: 30, ctr: 0.1, position: 2 },
      { keys: ["2026-01-01", "best crm", "SMART_TV"], clicks: 1, impressions: 5, ctr: 0.2, position: 4 },
    ];
    const out = await new HttpGscClient(reply(200, { rows })).fetchReport(request);
    expect(out).toEqual([{ date: "2026-01-01", page: null, query: "best crm", device: "desktop", country: null, impressions: 30, clicks: 3, ctr: 0.1, position: 2 }]);
  });
});
