import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ReportSweepRuntime } from "../../../src/lib/reports/report-sweep.js";

// STORY-178 — the suppression fan-out rides on the report sweep's elected owner connection. These pin its contract with the
// sweep: it runs once per elected tick, after the sweep, on the same connection, and it can never break the sweep.

function fakeClient(opts: { elected: boolean }) {
  const queries: string[] = [];
  const client = {
    ended: false,
    async query(text: string) {
      queries.push(text);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ locked: opts.elected }] };
      if (text.includes("pg_advisory_unlock")) return { rows: [{ released: true }] };
      if (text.includes("FROM pg_roles")) return { rows: [{ can_see: true, who: "owner" }] };
      return { rows: [] };
    },
    async end() {
      client.ended = true;
    },
  };
  return { client, queries };
}

describe("STORY-178 · ReportSweepRuntime `after` step", () => {
  it("runs once per elected tick, AFTER the sweep, on the same connection, before the lock is released", async () => {
    const { client, queries } = fakeClient({ elected: true });
    const after = vi.fn(async (c: ClientBase) => {
      expect(c).toBe(client);
      queries.push("AFTER");
    });
    const runtime = new ReportSweepRuntime({ connect: async () => client as never, enqueue: async () => undefined, after });
    const result = await runtime.tick();
    expect(result).toMatchObject({ status: "complete" });
    expect(after).toHaveBeenCalledTimes(1);
    const order = queries.map((q) => (q === "AFTER" ? "after" : q.includes("FROM scheduled_reports") ? "sweep" : q.includes("pg_advisory_unlock") ? "unlock" : "other"));
    expect(order.indexOf("sweep")).toBeLessThan(order.indexOf("after"));
    expect(order.indexOf("after")).toBeLessThan(order.indexOf("unlock"));
  });

  it("does NOT run when this replica was not elected", async () => {
    const { client } = fakeClient({ elected: false });
    const after = vi.fn(async () => undefined);
    const runtime = new ReportSweepRuntime({ connect: async () => client as never, enqueue: async () => undefined, after });
    expect(await runtime.tick()).toBeNull();
    expect(after).not.toHaveBeenCalled();
  });

  it("a failing step never changes the sweep's result, never throws, and the connection is still released", async () => {
    const { client } = fakeClient({ elected: true });
    const runtime = new ReportSweepRuntime({ connect: async () => client as never, enqueue: async () => undefined, after: async () => Promise.reject(new Error("boom")) });
    await expect(runtime.tick()).resolves.toMatchObject({ status: "complete" });
    expect(client.ended).toBe(true);
  });

  it("without the step the sweep behaves exactly as before", async () => {
    const { client } = fakeClient({ elected: true });
    const runtime = new ReportSweepRuntime({ connect: async () => client as never, enqueue: async () => undefined });
    await expect(runtime.tick()).resolves.toMatchObject({ status: "complete", due: 0 });
  });
});
