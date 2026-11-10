import { Logger } from "@nestjs/common";
import { emailAlert } from "../alerts/alerts.js";
import type { Pager } from "../queue/dead-letter.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { DISCOVERY_LATENCY_OBJECTIVE } from "./discover.js";

// STORY-043 AC15 - the judge of the discovery latency objective: p50 20 s and p95 45 s from submission to a confidence-scored payload
// (FR-ONB-02a, edge-cases-and-slos.md row 33). `nominara_discovery_duration_seconds` measures it; this raises an alert when a window of passes
// breaches it, through the same `Pager` seam and email leg the parser and queue alerts use.
//
// NO SINGLE-SAMPLE ALERT (STORY-005: "they page on noise and get muted"). A window must hold DISCOVERY_ALERT_MIN_SAMPLE passes before it is
// judged, and the median and the upper percentile are judged separately against their own objectives.
//
// WHAT IS NOT IN A REFERENCE, and named here for the owner to move: the window (one hour, tumbling), the minimum sample (20: the smallest in
// which nearest-rank p95 is not just the slowest pass) and the cooldown (6 h, as the parser alerts). The objective numbers are NOT here: they
// are read from DISCOVERY_LATENCY_OBJECTIVE.
//
// PER PROCESS, AND THAT IS A LIMIT. Durations live in this worker's memory, as ParseAlertMonitor's counts do: a restart forgets the window and
// N replicas each need the minimum sample from their own share, so it can be late, never wrong. This is the in-process stand-in until the
// metrics backend (STORY-005 / STORY-108) holds multi-window burn-rate rules over the durable `nominara_discovery_duration_seconds`.
//
// WHAT AN ALERT CARRIES: counts and durations only. No workspace, project, URL, brand or competitor.

export const DISCOVERY_ALERT_WINDOW_MS = 60 * 60 * 1000;
export const DISCOVERY_ALERT_MIN_SAMPLE = 20;
export const DISCOVERY_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface DiscoveryLatencyVerdict {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p50Breached: boolean;
  readonly p95Breached: boolean;
}

/** Nearest-rank percentile of an ascending list: the value at rank ceil(p * n). */
function percentile(sortedAscending: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sortedAscending.length));
  return sortedAscending[rank - 1]!;
}

/** Null (nothing judged) below the minimum sample; otherwise each percentile against its objective, "at most" meaning equal is met. */
export function judgeDiscoveryLatency(durationsMs: readonly number[]): DiscoveryLatencyVerdict | null {
  if (durationsMs.length < DISCOVERY_ALERT_MIN_SAMPLE) return null;
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const p50Ms = percentile(sorted, 0.5);
  const p95Ms = percentile(sorted, 0.95);
  return {
    samples: sorted.length,
    p50Ms,
    p95Ms,
    p50Breached: p50Ms > DISCOVERY_LATENCY_OBJECTIVE.p50Ms,
    p95Breached: p95Ms > DISCOVERY_LATENCY_OBJECTIVE.p95Ms,
  };
}

const logger = new Logger("discovery-latency");

/** The default `Pager`: an error line and a counter, and the email leg when ALERT_EMAIL_TO is configured. */
export const discoveryLatencyPager: Pager = {
  page(message, context) {
    logger.error({ message, ...context });
    emailAlert(message, context);
  },
};

export interface DiscoveryLatencyMonitorOptions {
  readonly pager?: Pager;
  /** Epoch ms, injectable so a test does not wait an hour. */
  readonly clock?: () => number;
}

export class DiscoveryLatencyMonitor {
  private readonly pager: Pager;
  private readonly clock: () => number;
  private windowStartedAt = 0;
  private durations: number[] = [];
  private lastPagedAt: number | undefined;

  constructor(options: DiscoveryLatencyMonitorOptions = {}) {
    this.pager = options.pager ?? discoveryLatencyPager;
    this.clock = options.clock ?? Date.now;
  }

  /** One finished pass, measured from submission. A non-finite or negative duration is not an observation (`0` is: an instant pass). */
  observe(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const now = this.clock();
    if (this.durations.length === 0 || now - this.windowStartedAt >= DISCOVERY_ALERT_WINDOW_MS) {
      this.windowStartedAt = now;
      this.durations = [];
    }
    this.durations.push(durationMs);

    const verdict = judgeDiscoveryLatency(this.durations);
    if (verdict === null || (!verdict.p50Breached && !verdict.p95Breached)) return;
    if (this.lastPagedAt !== undefined && now - this.lastPagedAt < DISCOVERY_ALERT_COOLDOWN_MS) return;
    this.lastPagedAt = now;
    incrementCounter("nominara_discovery_latency_alert_total", {});
    this.pager.page("discovery latency is over its objective: URL submitted to confidence-scored payload is slower than the median or upper-percentile target", {
      alert: "discovery_latency_objective",
      samples: verdict.samples,
      p50_ms: verdict.p50Ms,
      p95_ms: verdict.p95Ms,
      p50_breached: verdict.p50Breached,
      p95_breached: verdict.p95Breached,
      p50_objective_ms: DISCOVERY_LATENCY_OBJECTIVE.p50Ms,
      p95_objective_ms: DISCOVERY_LATENCY_OBJECTIVE.p95Ms,
    });
  }
}

/** The process-wide monitor the crawl.discover handler feeds. */
export const defaultDiscoveryLatencyMonitor = new DiscoveryLatencyMonitor();
