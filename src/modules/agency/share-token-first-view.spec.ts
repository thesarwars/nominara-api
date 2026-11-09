import { beforeEach, describe, expect, it, vi } from "vitest";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { ShareTokensService } from "./share-tokens.service.js";

// NEW-E-099b — FR-AGY-01o: "a first-view notification is sent". Only an in-app notification; email is deferred.
// The first view is decided by the SAME atomic UPDATE that takes the view, so two parallel first mints cannot both be first.
const WS = "0198f6a0-0000-7000-8000-000000000001";
const TOKEN = "0198f6a0-0000-7000-8000-0000000000a1";
const VIEW = "0198f6a0-0000-7000-8000-0000000000b1";

interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

describe("NEW-E-099b · ShareTokensService.consumeView first-view notification", () => {
  let calls: Recorded[];

  function service(updated: { rowCount: number; rows: unknown[] }): ShareTokensService {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      context: { workspaceId: WS, actorId: "0198f6a0-0000-7000-8000-0000000000ff" },
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return /UPDATE share_tokens/.test(sql) ? updated : /INSERT INTO share_token_views/.test(sql) ? { rowCount: 1, rows: [{ id: VIEW }] } : { rowCount: 1, rows: [] };
        }),
      },
    } as never);
    return new ShareTokensService({} as never);
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const view = { ip: "203.0.113.9", userAgent: "UA", authenticated: false };
  const notifications = () => calls.filter((c) => /INSERT INTO notifications/.test(c.sql));

  it("FR-AGY-01o · the first view of a token (view_count becomes 1) writes ONE workspace-wide in-app notification", async () => {
    const svc = service({ rowCount: 1, rows: [{ view_count: 1, label: "Q3 client report" }] });
    expect(await svc.consumeView(TOKEN, view)).toBe(VIEW);
    const n = notifications();
    expect(n).toHaveLength(1);
    expect(n[0]!.sql).toMatch(/'portal\.first_view'/);
    expect(n[0]!.params).toContain(WS);
    // Only in-app: email is deferred, so the channel list is never widened here.
    expect(n[0]!.sql).not.toMatch(/email/i);
  });

  it("FR-AGY-01o · the notification and the view row are written in the same flow as the counter (after it), never before the view is taken", async () => {
    const svc = service({ rowCount: 1, rows: [{ view_count: 1, label: "L" }] });
    await svc.consumeView(TOKEN, view);
    const order = calls.map((c) => (/UPDATE share_tokens/.test(c.sql) ? "update" : /share_token_views/.test(c.sql) ? "view" : "notify"));
    expect(order.indexOf("update")).toBe(0);
    expect(order).toContain("notify");
    expect(order.indexOf("notify")).toBeGreaterThan(order.indexOf("update"));
  });

  it("FR-AGY-01o · a later view (view_count 2 and up) writes no notification", async () => {
    for (const count of [2, 3, 50]) {
      const svc = service({ rowCount: 1, rows: [{ view_count: count, label: "L" }] });
      expect(await svc.consumeView(TOKEN, view)).toBe(VIEW);
      expect(notifications()).toHaveLength(0);
    }
  });

  it("d.71 (c) · a taken view returns the view row's id (the telemetry key); a refused one returns null, never an id", async () => {
    const svc = service({ rowCount: 1, rows: [{ view_count: 4, label: "L" }] });
    expect(await svc.consumeView(TOKEN, view)).toBe(VIEW);
    expect(calls.some((c) => /INSERT INTO share_token_views[\s\S]*RETURNING id/.test(c.sql))).toBe(true);
  });

  it("FR-AGY-01o · a refused view (nothing updated) writes no view row and no notification", async () => {
    const svc = service({ rowCount: 0, rows: [] });
    expect(await svc.consumeView(TOKEN, view)).toBeNull();
    expect(notifications()).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("FR-AGY-01o · the notification carries no visitor address, agent or secret; its payload names the token id only", async () => {
    const svc = service({ rowCount: 1, rows: [{ view_count: 1, label: "L" }] });
    await svc.consumeView(TOKEN, { ip: "203.0.113.77", userAgent: "SecretAgent/9", authenticated: true });
    const n = notifications()[0]!;
    const flat = JSON.stringify(n.params);
    expect(flat).not.toContain("203.0.113.77");
    expect(flat).not.toContain("SecretAgent");
    expect(flat).toContain(TOKEN);
  });
});
