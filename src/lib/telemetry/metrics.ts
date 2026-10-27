import { Logger } from "@nestjs/common";

// STORY-014 review fix — no metrics library exists anywhere in this
// codebase yet (grepped: every existing module, e.g. HealthService, uses
// only @nestjs/common's Logger). This is the minimal Logger-based counter
// until a real metrics backend is wired in by its own story/ADR — it
// follows coding-standards.md §7's `nominara_<subsystem>_<measure>` naming
// (units in the name, e.g. `_total`) without introducing a new dependency
// or pattern.
const logger = new Logger("metrics");

export function incrementCounter(name: string, labels: Record<string, string> = {}): void {
  logger.log({ metric: name, value: 1, ...labels });
}

/**
 * A histogram observation (a duration or a lag), in the unit the metric name
 * carries (`_ms`, `_seconds`). Same Logger-backed shape as the counter until a
 * metrics backend is wired in by its own story: the aggregation (p95) happens
 * where the log line is collected, not here.
 */
export function observeHistogram(name: string, value: number, labels: Record<string, string | number> = {}): void {
  logger.log({ metric: name, value, ...labels });
}
