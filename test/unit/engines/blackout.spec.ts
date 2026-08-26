import { describe, expect, it } from "vitest";
import { BLACKOUT_PAGE_COOLDOWN_MS, BLACKOUT_THRESHOLD_MS, BlackoutMonitor } from "../../../src/lib/engines/blackout.js";
import type { Pager } from "../../../src/lib/queue/dead-letter.js";

// STORY-031 Phase G stage 6 — EC-06: "blackout > 48h → page on-call...".
// 48h is the exact reference constant. The 24h repeat-page cooldown is THIS
// STORY'S OWN interpolation (not stated anywhere in EC-06) — asserted as
// our own number, never re-asserted as spec-derived. Reuses the EXISTING
// Pager port (src/lib/queue/dead-letter.ts, D14) rather than a new one.
// Same `observe()` shape as DlqDepthMonitor's own sustained-breach paging.

function fakePager() {
  const pages: Array<{ message: string; context: Record<string, unknown> }> = [];
  const pager: Pager = { page: (message, context) => pages.push({ message, context }) };
  return { pager, pages };
}

describe("STORY-031 · BlackoutMonitor — pages exactly once per sustained >48h blackout, 24h cooldown between repeats", () => {
  it("D4-style disclosure: 48h threshold is exact; 24h cooldown is this story's own interpolation", () => {
    expect(BLACKOUT_THRESHOLD_MS).toBe(48 * 60 * 60 * 1000);
    expect(BLACKOUT_PAGE_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("a failure that has been dark for exactly 48:00:00:000 does NOT yet page (strict >)", () => {
    const nowRef = { now: 0 };
    const { pager, pages } = fakePager();
    const monitor = new BlackoutMonitor(pager, () => nowRef.now);

    monitor.observe("chatgpt", false); // dark starts at t=0
    nowRef.now = BLACKOUT_THRESHOLD_MS;
    monitor.observe("chatgpt", false);
    expect(pages).toHaveLength(0);
  });

  it("one ms past the 48h threshold pages exactly once", () => {
    const nowRef = { now: 0 };
    const { pager, pages } = fakePager();
    const monitor = new BlackoutMonitor(pager, () => nowRef.now);

    monitor.observe("chatgpt", false);
    nowRef.now = BLACKOUT_THRESHOLD_MS + 1;
    monitor.observe("chatgpt", false);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.context.engineKey).toBe("chatgpt");
  });

  it("repeated dark observations within the 24h cooldown never page again", () => {
    const nowRef = { now: 0 };
    const { pager, pages } = fakePager();
    const monitor = new BlackoutMonitor(pager, () => nowRef.now);

    monitor.observe("chatgpt", false);
    nowRef.now = BLACKOUT_THRESHOLD_MS + 1;
    monitor.observe("chatgpt", false);
    expect(pages).toHaveLength(1);

    nowRef.now += BLACKOUT_PAGE_COOLDOWN_MS - 1;
    monitor.observe("chatgpt", false);
    expect(pages).toHaveLength(1);
  });

  it("after the 24h cooldown elapses, a STILL-dark engine pages again", () => {
    const nowRef = { now: 0 };
    const { pager, pages } = fakePager();
    const monitor = new BlackoutMonitor(pager, () => nowRef.now);

    monitor.observe("chatgpt", false);
    nowRef.now = BLACKOUT_THRESHOLD_MS + 1;
    monitor.observe("chatgpt", false);
    expect(pages).toHaveLength(1);

    nowRef.now += BLACKOUT_PAGE_COOLDOWN_MS;
    monitor.observe("chatgpt", false);
    expect(pages).toHaveLength(2);
  });

  it("a success clears the dark-since clock entirely — a LATER failure starts counting from zero, not from the old dark-since timestamp", () => {
    const nowRef = { now: 0 };
    const { pager, pages } = fakePager();
    const monitor = new BlackoutMonitor(pager, () => nowRef.now);

    monitor.observe("chatgpt", false); // dark starts at t=0
    nowRef.now = BLACKOUT_THRESHOLD_MS - 1000; // almost 48h dark
    monitor.observe("chatgpt", true); // recovers — clears dark-since

    nowRef.now += 2000; // only 2s since the recovery
    monitor.observe("chatgpt", false); // dark starts AGAIN, fresh, at this new t
    expect(pages).toHaveLength(0); // nowhere near 48h from the NEW dark-since
  });

  it("each engine's blackout is tracked independently", () => {
    const nowRef = { now: 0 };
    const { pager, pages } = fakePager();
    const monitor = new BlackoutMonitor(pager, () => nowRef.now);

    monitor.observe("chatgpt", false);
    nowRef.now = BLACKOUT_THRESHOLD_MS + 1;
    monitor.observe("chatgpt", false);
    monitor.observe("claude", false); // claude's OWN dark-since starts only now

    expect(pages).toHaveLength(1);
    expect(pages[0]!.context.engineKey).toBe("chatgpt");
  });
});
