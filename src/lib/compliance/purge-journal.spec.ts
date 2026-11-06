import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, PurgeJournal, replayPurgeJournal, type PurgeJournalEntry } from "./purge-journal.js";

const WS = "01990000-0000-7000-8000-000000000001";

// STORY-111 AC "purge journal" / NFR-CMP-08. Scenarios 20 and 21.
describe("STORY-111 purge journal", () => {
  it("S20 a written entry holds identifiers, a timestamp and a reason, and no customer content", async () => {
    const store = new InMemoryJournalStore();
    const journal = new PurgeJournal(store, "test", () => new Date("2026-11-06T10:00:00Z"));
    await journal.append({ scope: "workspace", scopeId: WS, workspaceId: WS, reason: "workspace_deletion_executed" });
    const [key] = [...store.objects.keys()];
    expect(key).toMatch(/^purge-journal\/test\/2026-11-06T10-00-00\.000Z-[0-9a-f-]{36}\.json$/);
    const entry = JSON.parse(store.objects.get(key!)!) as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["id", "purged_at", "reason", "scope", "scope_id", "v", "workspace_id"]);
    expect(entry.reason).toBe("workspace_deletion_executed");
  });

  it("S20 refuses a reason that is free text, so content cannot be smuggled in", async () => {
    const journal = new PurgeJournal(new InMemoryJournalStore(), "test");
    await expect(journal.append({ scope: "project", scopeId: WS, workspaceId: WS, reason: "customer said: hello" as never })).rejects.toThrow();
    await expect(journal.append({ scope: "project", scopeId: "not-a-uuid", workspaceId: WS, reason: "project_hard_deleted" })).rejects.toThrow();
  });

  it("S20 is append-only: a second append never overwrites the first", async () => {
    const store = new InMemoryJournalStore();
    const journal = new PurgeJournal(store, "test", () => new Date("2026-11-06T10:00:00Z"));
    await journal.append({ scope: "project", scopeId: WS, workspaceId: WS, reason: "project_hard_deleted" });
    await journal.append({ scope: "project", scopeId: WS, workspaceId: WS, reason: "project_hard_deleted" });
    expect(store.objects.size).toBe(2);
  });

  it("S21 replay returns only entries recorded after the snapshot, oldest first, and applies each", async () => {
    const store = new InMemoryJournalStore();
    const times = ["2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z", "2026-11-05T00:00:00Z"];
    for (const [i, t] of times.entries()) {
      const journal = new PurgeJournal(store, "test", () => new Date(t));
      await journal.append({ scope: "workspace", scopeId: `0199000${i}-0000-7000-8000-000000000001`, workspaceId: `0199000${i}-0000-7000-8000-000000000001`, reason: "workspace_deletion_executed" });
    }
    const applied: PurgeJournalEntry[] = [];
    const result = await replayPurgeJournal(new PurgeJournal(store, "test"), new Date("2026-11-02T00:00:00Z"), async (e) => void applied.push(e));
    expect(applied.map((e) => e.purged_at)).toEqual(["2026-11-03T00:00:00.000Z", "2026-11-05T00:00:00.000Z"]);
    expect(result).toEqual({ replayed: 2, failed: [] });
  });

  it("S21 replay reports an entry it could not apply instead of accepting traffic silently", async () => {
    const store = new InMemoryJournalStore();
    const journal = new PurgeJournal(store, "test", () => new Date("2026-11-05T00:00:00Z"));
    await journal.append({ scope: "workspace", scopeId: WS, workspaceId: WS, reason: "workspace_deletion_executed" });
    const result = await replayPurgeJournal(journal, new Date("2026-11-01T00:00:00Z"), async () => {
      throw new Error("db down");
    });
    expect(result.replayed).toBe(0);
    expect(result.failed).toHaveLength(1);
  });

  it("S20 ignores objects under the prefix that are not journal entries (fail closed on unparseable)", async () => {
    const store = new InMemoryJournalStore();
    store.objects.set("purge-journal/test/garbage.json", "{not json");
    const journal = new PurgeJournal(store, "test");
    await expect(replayPurgeJournal(journal, new Date(0), async () => undefined)).rejects.toThrow(/unreadable/);
  });
});
