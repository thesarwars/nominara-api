import { afterEach, describe, expect, it, vi } from "vitest";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { writeNotification, type NotificationInput } from "./writer.js";

// STORY-098 (PROVISIONAL) - `emailNow` emails an info notification at once through the same outbox; `relayOnly` records the outbox
// row and attempts no enqueue (the API request path has no queue producer).
const WS = "0198f6a0-0000-7000-8000-000000000001";
const USER = "0198f6a0-0000-7000-8000-0000000000u1".replace("u", "a");
const input = (over: Partial<NotificationInput> = {}): NotificationInput => ({
  workspaceId: WS, projectId: null, userId: null, kind: "portal.first_view", severity: "info", title: "T", body: null, eventKey: "k1", ...over,
});

function harness() {
  const sql: Array<{ text: string; params: unknown[] }> = [];
  const after: Array<() => void> = [];
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ afterCommit: (f: () => void) => after.push(f) } as never);
  const tx = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      sql.push({ text, params });
      if (/INSERT INTO notifications/.test(text)) return { rows: [{ id: "n1" }] };
      if (/FROM workspace_members/.test(text)) return { rows: [{ user_id: USER, role: "owner", digest_cadence: null, project_scope: null, sentiment_alerts_enabled: null }] };
      if (/INSERT INTO notification_emails/.test(text)) return { rows: [{ id: "e1" }] };
      return { rows: [] };
    }),
  };
  return { tx, sql, after };
}

describe("STORY-098 · writeNotification emailNow / relayOnly", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an info notification without emailNow waits for the digest: in-app only, no outbox row", async () => {
    const h = harness();
    const out = await writeNotification(h.tx as never, input());
    expect(out.emailIds).toEqual([]);
    expect(h.sql.some((q) => /notification_emails/.test(q.text))).toBe(false);
    expect(h.sql[0]!.params).toContainEqual(["in_app"]);
  });

  it("emailNow records channels in_app+email and one outbox row per emailable member", async () => {
    const h = harness();
    const out = await writeNotification(h.tx as never, input({ emailNow: true }), { relayOnly: true });
    expect(h.sql[0]!.params).toContainEqual(["in_app", "email"]);
    expect(out.emailIds).toEqual(["e1"]);
  });

  it("relayOnly attempts no enqueue after commit; without it the enqueue is attempted", async () => {
    const relay = harness();
    await writeNotification(relay.tx as never, input({ emailNow: true }), { relayOnly: true });
    expect(relay.after).toHaveLength(0);
    vi.restoreAllMocks();
    const enqueue = vi.fn(async () => undefined);
    const queued = harness();
    await writeNotification(queued.tx as never, input({ emailNow: true }), { enqueue });
    expect(queued.after).toHaveLength(1);
  });

  describe("emailNow audience (first-view, PROVISIONAL)", () => {
    const P1 = "0198f6a0-0000-7000-8000-0000000000c1";
    const P2 = "0198f6a0-0000-7000-8000-0000000000c2";
    const member = (id: string, role: string, scope: string[] | null, cadence: string | null = null) => ({ user_id: id, role, digest_cadence: cadence, project_scope: scope, sentiment_alerts_enabled: null });
    async function recipients(members: ReturnType<typeof member>[], projectIds: string[]): Promise<string[]> {
      const h = harness();
      const base = h.tx.query.getMockImplementation()! as (text: string, params: unknown[]) => Promise<unknown>;
      (h.tx.query as unknown as { mockImplementation(f: (t: string, p: unknown[]) => Promise<unknown>): void }).mockImplementation(async (text, params) => (/FROM workspace_members/.test(text) ? { rows: members } : base(text, params)));
      await writeNotification(h.tx as never, input({ emailNow: true, emailAudience: { permission: "share_token:mint", projectIds } }), { relayOnly: true });
      return h.sql.filter((q) => /INSERT INTO notification_emails/.test(q.text)).map((q) => q.params[1] as string);
    }

    it("a manager scoped to the token's project is included; a manager scoped elsewhere is excluded", async () => {
      expect(await recipients([member("in", "manager", [P1]), member("out", "manager", [P2])], [P1])).toEqual(["in"]);
    });
    it("a member who cannot manage share tokens (analyst, viewer) is excluded; owner and admin are included", async () => {
      expect(await recipients([member("a", "analyst", null), member("v", "viewer", [P1]), member("o", "owner", null), member("ad", "admin", null)], [P1])).toEqual(["o", "ad"]);
    });
    it("every project of the token must be visible: a manager scoped to only one of two is excluded", async () => {
      expect(await recipients([member("half", "manager", [P1]), member("both", "manager", [P1, P2])], [P1, P2])).toEqual(["both"]);
    });
    it("a token with no project scope needs a member who sees every project", async () => {
      expect(await recipients([member("scoped", "manager", [P1]), member("all", "owner", null)], [])).toEqual(["all"]);
    });
    it("the digest cadence does not matter: a member whose digest is off still gets the immediate notice", async () => {
      expect(await recipients([member("off", "owner", null, "off")], [P1])).toEqual(["off"]);
    });
  });

  it("a repeated event key writes nothing (no outbox row)", async () => {
    const h = harness();
    h.tx.query.mockImplementationOnce(async () => ({ rows: [] }));
    const out = await writeNotification(h.tx as never, input({ emailNow: true }));
    expect(out).toEqual({ id: null, created: false, emailIds: [] });
  });
});
