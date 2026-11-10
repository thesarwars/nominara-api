import { describe, expect, it, vi } from "vitest";
import type { Pager } from "../queue/dead-letter.js";
import { DISCOVERY_LATENCY_OBJECTIVE } from "./discover.js";
import { DISCOVERY_ALERT_COOLDOWN_MS, DISCOVERY_ALERT_MIN_SAMPLE, DISCOVERY_ALERT_WINDOW_MS, DiscoveryLatencyMonitor, judgeDiscoveryLatency } from "./latency-alert.js";

// STORY-043 AC15 - "Discovery meets its latency objective at the median and the upper percentile": the judge. The objective is p50 20 s and
// p95 45 s (FR-ONB-02a, edge-cases-and-slos.md row 33), read from DISCOVERY_LATENCY_OBJECTIVE, never copied here.

const { p50Ms, p95Ms } = DISCOVERY_LATENCY_OBJECTIVE;
const many = (n: number, ms: number): number[] => Array.from({ length: n }, () => ms);

describe("STORY-043 · judgeDiscoveryLatency", () => {
  it("AC15 · a window exactly AT the objective is not a breach (the objective is 'at most')", () => {
    expect(judgeDiscoveryLatency(many(DISCOVERY_ALERT_MIN_SAMPLE, p50Ms))).toMatchObject({ p50Breached: false, p95Breached: false });
  });

  it("AC15 · the median one millisecond over its objective breaches the median", () => {
    const verdict = judgeDiscoveryLatency(many(DISCOVERY_ALERT_MIN_SAMPLE, p50Ms + 1));
    expect(verdict).toMatchObject({ p50Breached: true, p95Breached: false });
  });

  it("AC15 · the upper percentile over its objective breaches it, while a healthy median does not", () => {
    // 20 samples: 18 fast, 2 slow -> nearest-rank p95 (rank 19) is a slow one; p50 is fast.
    const verdict = judgeDiscoveryLatency([...many(18, 5_000), p95Ms + 1, p95Ms + 1]);
    expect(verdict).toMatchObject({ p50Breached: false, p95Breached: true });
  });

  it("AC15 · one slow pass among many is not a breach of the upper percentile", () => {
    expect(judgeDiscoveryLatency([...many(19, 5_000), p95Ms * 3])).toMatchObject({ p95Breached: false });
  });

  it("AC15 · below the minimum sample nothing is judged: a single sample can never alert", () => {
    expect(judgeDiscoveryLatency(many(DISCOVERY_ALERT_MIN_SAMPLE - 1, p95Ms * 10))).toBeNull();
    expect(judgeDiscoveryLatency([])).toBeNull();
  });
});

describe("STORY-043 · DiscoveryLatencyMonitor", () => {
  function monitor() {
    const page = vi.fn();
    const pager: Pager = { page };
    let now = 1_000_000;
    const m = new DiscoveryLatencyMonitor({ pager, clock: () => now });
    return { m, page, advance: (ms: number) => void (now += ms) };
  }

  it("AC15 · pages once the window holds the minimum sample and the median is over, naming the numbers and nothing else", () => {
    const { m, page } = monitor();
    for (let i = 0; i < DISCOVERY_ALERT_MIN_SAMPLE; i++) m.observe(p50Ms + 5_000);
    expect(page).toHaveBeenCalledTimes(1);
    const [message, context] = page.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toMatch(/discovery/i);
    expect(context).toMatchObject({ alert: "discovery_latency_objective", samples: DISCOVERY_ALERT_MIN_SAMPLE, p50_ms: p50Ms + 5_000, p50_objective_ms: p50Ms, p95_objective_ms: p95Ms });
    // Counts and durations only: no workspace, project, URL or brand.
    expect(Object.keys(context).sort()).toEqual(["alert", "p50_breached", "p50_ms", "p50_objective_ms", "p95_breached", "p95_ms", "p95_objective_ms", "samples"]);
  });

  it("AC15 · a healthy window never pages", () => {
    const { m, page } = monitor();
    for (let i = 0; i < DISCOVERY_ALERT_MIN_SAMPLE * 3; i++) m.observe(4_000);
    expect(page).not.toHaveBeenCalled();
  });

  it("AC15 · inside the cooldown a still-slow window does not page again; after it, it does", () => {
    const { m, page, advance } = monitor();
    for (let i = 0; i < DISCOVERY_ALERT_MIN_SAMPLE; i++) m.observe(p50Ms + 5_000);
    for (let i = 0; i < DISCOVERY_ALERT_MIN_SAMPLE; i++) m.observe(p50Ms + 5_000);
    expect(page).toHaveBeenCalledTimes(1);
    advance(DISCOVERY_ALERT_COOLDOWN_MS + 1);
    for (let i = 0; i < DISCOVERY_ALERT_MIN_SAMPLE; i++) m.observe(p50Ms + 5_000);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("AC15 · the window tumbles: a slow hour ago does not combine with a fast now", () => {
    const { m, page, advance } = monitor();
    for (let i = 0; i < DISCOVERY_ALERT_MIN_SAMPLE - 1; i++) m.observe(p50Ms + 5_000);
    advance(DISCOVERY_ALERT_WINDOW_MS + 1);
    for (let i = 0; i < DISCOVERY_ALERT_MIN_SAMPLE; i++) m.observe(4_000);
    expect(page).not.toHaveBeenCalled();
  });

  it("AC15 · a non-finite or negative duration is not an observation", () => {
    const { m, page } = monitor();
    for (let i = 0; i < DISCOVERY_ALERT_MIN_SAMPLE * 2; i++) m.observe(Number.NaN);
    for (let i = 0; i < DISCOVERY_ALERT_MIN_SAMPLE * 2; i++) m.observe(-5);
    expect(page).not.toHaveBeenCalled();
  });

});
