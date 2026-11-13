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

  it("a repeated event key writes nothing (no outbox row)", async () => {
    const h = harness();
    h.tx.query.mockImplementationOnce(async () => ({ rows: [] }));
    const out = await writeNotification(h.tx as never, input({ emailNow: true }));
    expect(out).toEqual({ id: null, created: false, emailIds: [] });
  });
});
