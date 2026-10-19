import { describe, expect, it } from "vitest";
import { BLACKOUT_PAGE_COOLDOWN_MS, BLACKOUT_THRESHOLD_MS, BlackoutMonitor } from "../../../src/lib/engines/blackout.js";
import { DLQ_DEPTH_SUSTAINED_MS, DlqDepthMonitor, type Pager } from "../../../src/lib/queue/dead-letter.js";

// STORY-179 — the monitors' small state must survive a change of replica, or a failover drops a half-elapsed window
// (never pages) or forgets it already paged (pages twice). Both are what exporting the state is for.

function recording() {
  const pages: Array<Record<string, unknown>> = [];
  const pager: Pager = { page: (_m, context) => void pages.push(context) };
  return { pager, pages };
}

describe("STORY-179 AC1 · DlqDepthMonitor state hands over between replicas", () => {
  it("a window begun on replica A completes on replica B and pages exactly once", () => {
    const { pager, pages } = recording();
    const nowRef = { now: 1_000 };
    const a = new DlqDepthMonitor({ clock: () => nowRef.now, pager });
    a.observe("capture.execute", 60);

    nowRef.now += DLQ_DEPTH_SUSTAINED_MS;
    const b = new DlqDepthMonitor({ clock: () => nowRef.now, pager });
    b.importState(a.exportState());
    b.observe("capture.execute", 60);
    expect(pages).toHaveLength(1);

    // …and the replica after that knows it already paged.
    const c = new DlqDepthMonitor({ clock: () => nowRef.now, pager });
    c.importState(b.exportState());
    c.observe("capture.execute", 60);
    expect(pages).toHaveLength(1);
  });

  it("an empty state imports as a no-op and a recovered queue leaves nothing behind", () => {
    const m = new DlqDepthMonitor({ clock: () => 0, pager: recording().pager });
    expect(m.exportState()).toEqual({ aboveSince: {}, alreadyPaged: [] });
    m.observe("q", 60);
    m.observe("q", 3);
    expect(m.exportState()).toEqual({ aboveSince: {}, alreadyPaged: [] });
  });
});

describe("STORY-179 AC2 · BlackoutMonitor.observeLastSuccess — seeded from the last recorded success", () => {
  it("a last success 48h and 1ms ago pages immediately; the page names the engine", () => {
    const { pager, pages } = recording();
    const now = 10 * BLACKOUT_THRESHOLD_MS;
    const m = new BlackoutMonitor(pager, () => now);
    m.observeLastSuccess("chatgpt", now - BLACKOUT_THRESHOLD_MS - 1);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ alertName: "engine_blackout", engineKey: "chatgpt" });
  });

  it("a last success exactly 48h ago does not page (strict >), and one inside the window clears dark state", () => {
    const { pager, pages } = recording();
    const now = 10 * BLACKOUT_THRESHOLD_MS;
    const m = new BlackoutMonitor(pager, () => now);
    m.observeLastSuccess("chatgpt", now - BLACKOUT_THRESHOLD_MS);
    m.observeLastSuccess("chatgpt", now - 1000);
    expect(pages).toHaveLength(0);
    expect(m.exportState().darkSinceMs).toEqual({});
  });

  it("the dark clock runs from the last success, so the page lands at 48h rather than 48h after the first look", () => {
    const { pager, pages } = recording();
    const nowRef = { now: 100 };
    const m = new BlackoutMonitor(pager, () => nowRef.now);
    const lastSuccess = 100;
    nowRef.now = lastSuccess + BLACKOUT_THRESHOLD_MS - 5;
    m.observeLastSuccess("chatgpt", lastSuccess);
    expect(pages).toHaveLength(0);
    nowRef.now = lastSuccess + BLACKOUT_THRESHOLD_MS + 5;
    m.observeLastSuccess("chatgpt", lastSuccess);
    expect(pages).toHaveLength(1);
  });

  it("repeat looks inside the 24h cooldown stay silent, and the cooldown carries across replicas", () => {
    const { pager, pages } = recording();
    const nowRef = { now: 10 * BLACKOUT_THRESHOLD_MS };
    const last = nowRef.now - BLACKOUT_THRESHOLD_MS - 1;
    const a = new BlackoutMonitor(pager, () => nowRef.now);
    a.observeLastSuccess("chatgpt", last);
    expect(pages).toHaveLength(1);

    nowRef.now += BLACKOUT_PAGE_COOLDOWN_MS - 1;
    const b = new BlackoutMonitor(pager, () => nowRef.now);
    b.importState(a.exportState());
    b.observeLastSuccess("chatgpt", last);
    expect(pages).toHaveLength(1);

    nowRef.now += 1;
    b.observeLastSuccess("chatgpt", last);
    expect(pages).toHaveLength(2);
  });

  it("null (no success ever recorded) is not 'dark since the epoch': it starts the clock at the first look", () => {
    const { pager, pages } = recording();
    const nowRef = { now: 5_000 };
    const m = new BlackoutMonitor(pager, () => nowRef.now);
    m.observeLastSuccess("chatgpt", null);
    expect(pages).toHaveLength(0);
    nowRef.now += BLACKOUT_THRESHOLD_MS + 1;
    m.observeLastSuccess("chatgpt", null);
    expect(pages).toHaveLength(1);
  });
});
