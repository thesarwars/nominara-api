import { describe, expect, it } from "vitest";
import { AGENT_PROBE_USER_AGENT, BROWSER_PROBE_USER_AGENT, runDifferentialProbe } from "./differential-probe.js";
import { PolitenessBudget } from "./politeness.js";

type Reply = { status: number; headers?: Record<string, string>; body?: string } | "throw";
function harness(replies: { browser: Reply; agent: Reply }, hardCap = 10) {
  let clock = 0;
  const sleeps: number[] = [];
  const budget = new PolitenessBudget({ hardCap, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  const seen: { ua: string | undefined }[] = [];
  const fetch = async (_url: string, init: { headers: Record<string, string> }) => {
    const ua = init.headers["user-agent"];
    seen.push({ ua });
    const reply = ua === BROWSER_PROBE_USER_AGENT ? replies.browser : replies.agent;
    if (reply === "throw") throw new Error("connection refused");
    return { status: reply.status, headers: reply.headers ?? {}, body: Buffer.from(reply.body ?? "") };
  };
  return { budget, fetch, seen, sleeps };
}

describe("STORY-049 AC8 · differential probe", () => {
  it("scenario 9 · issues BOTH requests, one per user agent, and BOTH are counted against the politeness budget", async () => {
    const h = harness({ browser: { status: 200 }, agent: { status: 200 } });
    const r = await runDifferentialProbe({ url: "https://acme.com/", budget: h.budget, fetch: h.fetch });
    expect(h.seen.map((s) => s.ua)).toEqual([BROWSER_PROBE_USER_AGENT, AGENT_PROBE_USER_AGENT]);
    expect(h.budget.usedBy("probe")).toBe(2);
    expect(h.budget.used).toBe(2);
    expect(r.outcome).toBe("consistent");
  });

  it("scenario 9 · the second request waits out the politeness interval: the probe is not exempt from it", async () => {
    const h = harness({ browser: { status: 200 }, agent: { status: 200 } });
    await runDifferentialProbe({ url: "https://acme.com/", budget: h.budget, fetch: h.fetch });
    expect(h.sleeps).toEqual([500]);
  });

  it("an agent 403 against a browser 200 is hostile", async () => {
    const h = harness({ browser: { status: 200 }, agent: { status: 403 } });
    const r = await runDifferentialProbe({ url: "https://acme.com/", budget: h.budget, fetch: h.fetch });
    expect(r).toMatchObject({ outcome: "hostile", browserStatus: 200, agentStatus: 403 });
  });

  it("an agent 429 against a browser 200 is hostile", async () => {
    const h = harness({ browser: { status: 200 }, agent: { status: 429 } });
    expect((await runDifferentialProbe({ url: "https://acme.com/", budget: h.budget, fetch: h.fetch })).outcome).toBe("hostile");
  });

  it("a challenge page counts as hostile even when it is not a 4xx (cf-mitigated header; 'Just a moment' body)", async () => {
    const a = harness({ browser: { status: 200 }, agent: { status: 200, headers: { "cf-mitigated": "challenge" } } });
    expect((await runDifferentialProbe({ url: "https://acme.com/", budget: a.budget, fetch: a.fetch })).outcome).toBe("hostile");
    const b = harness({ browser: { status: 200 }, agent: { status: 503, body: "<title>Just a moment...</title>" } });
    expect((await runDifferentialProbe({ url: "https://acme.com/", budget: b.budget, fetch: b.fetch })).outcome).toBe("hostile");
  });

  it("when the BROWSER is refused too the site is just down or closed to everyone: inconclusive, not hostile", async () => {
    const h = harness({ browser: { status: 403 }, agent: { status: 403 } });
    expect((await runDifferentialProbe({ url: "https://acme.com/", budget: h.budget, fetch: h.fetch })).outcome).toBe("inconclusive");
  });

  it("a request that throws is inconclusive with its reason, and never a finding", async () => {
    const h = harness({ browser: { status: 200 }, agent: "throw" });
    const r = await runDifferentialProbe({ url: "https://acme.com/", budget: h.budget, fetch: h.fetch });
    expect(r.outcome).toBe("inconclusive");
    expect(r.agentStatus).toBeNull();
  });

  it("with fewer than two requests left the probe sends NEITHER (one half would be a probe that proves nothing) and says so", async () => {
    const h = harness({ browser: { status: 200 }, agent: { status: 403 } }, 1);
    const r = await runDifferentialProbe({ url: "https://acme.com/", budget: h.budget, fetch: h.fetch });
    expect(r.outcome).toBe("skipped_budget");
    expect(h.seen).toHaveLength(0);
    expect(h.budget.used).toBe(0);
  });
});
