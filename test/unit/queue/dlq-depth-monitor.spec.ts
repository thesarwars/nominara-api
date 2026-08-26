import { describe, expect, it } from "vitest";
import {
  DLQ_DEPTH_PAGE_THRESHOLD,
  DLQ_DEPTH_SUSTAINED_MS,
  DlqDepthMonitor,
  type Pager,
} from "../../../src/lib/queue/dead-letter.js";

// STORY-030 AC6 / Test scenario 6 — "Hold dead-letter depth above the
// threshold → pages." DlqDepthMonitor itself already exists (dead-letter.ts)
// with an injected clock + Pager seam specifically so this behaviour can be
// proven deterministically, with no real timers and no Valkey. This is that
// dedicated test.

function fakeClock(startMs = 0) {
  let now = startMs;
  return {
    clock: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function recordingPager(): { pager: Pager; pages: Array<{ message: string; context: Record<string, unknown> }> } {
  const pages: Array<{ message: string; context: Record<string, unknown> }> = [];
  return {
    pager: {
      page(message, context) {
        pages.push({ message, context });
      },
    },
    pages,
  };
}

describe("STORY-030 · DlqDepthMonitor — sustained dead-letter depth pages, exactly once per breach", () => {
  it("depth above threshold for 9m59s (just under the sustained window) → no page", () => {
    const { clock, advance } = fakeClock();
    const { pager, pages } = recordingPager();
    const monitor = new DlqDepthMonitor({ clock, pager });

    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 1);
    advance(DLQ_DEPTH_SUSTAINED_MS - 1_000);
    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 1);

    expect(pages).toHaveLength(0);
  });

  it("depth above threshold sustained past 10 minutes → exactly one page", () => {
    const { clock, advance } = fakeClock();
    const { pager, pages } = recordingPager();
    const monitor = new DlqDepthMonitor({ clock, pager });

    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 1);
    advance(DLQ_DEPTH_SUSTAINED_MS);
    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 1);

    expect(pages).toHaveLength(1);

    // Further observations while still above threshold must NOT page again.
    advance(60_000);
    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 1);
    advance(60_000);
    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 5);

    expect(pages).toHaveLength(1);
  });

  it("depth drops back to/below threshold then breaches again → window restarts and pages a second time", () => {
    const { clock, advance } = fakeClock();
    const { pager, pages } = recordingPager();
    const monitor = new DlqDepthMonitor({ clock, pager });

    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 1);
    advance(DLQ_DEPTH_SUSTAINED_MS);
    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 1);
    expect(pages).toHaveLength(1);

    // Drops back to the threshold — clears the sustained-breach state.
    advance(1_000);
    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD);

    // Breaches again — this is a NEW window, so an immediate re-check must not page yet.
    advance(1_000);
    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 1);
    expect(pages).toHaveLength(1);

    // ...but sustaining the second breach past the window pages again.
    advance(DLQ_DEPTH_SUSTAINED_MS);
    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD + 1);
    expect(pages).toHaveLength(2);
  });

  it("depth exactly at the threshold (not above it) sustained past the window → no page", () => {
    const { clock, advance } = fakeClock();
    const { pager, pages } = recordingPager();
    const monitor = new DlqDepthMonitor({ clock, pager });

    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD);
    advance(DLQ_DEPTH_SUSTAINED_MS + 60_000);
    monitor.observe("capture.execute", DLQ_DEPTH_PAGE_THRESHOLD);

    expect(pages).toHaveLength(0);
  });

  it("a single high-depth sample with no sustain (no follow-up observation) → no page", () => {
    const { clock } = fakeClock();
    const { pager, pages } = recordingPager();
    const monitor = new DlqDepthMonitor({ clock, pager });

    monitor.observe("capture.execute", 500);

    expect(pages).toHaveLength(0);
  });
});
