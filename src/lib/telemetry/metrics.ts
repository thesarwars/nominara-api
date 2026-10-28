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
 * One observation of a distribution (the Logger-based stand-in for a histogram, same no-dependency pattern as
 * `incrementCounter`; the backend that buckets it is a later story). A non-finite value is not an observation and is
 * refused rather than logged as 0 — `0` is a real measurement and stays distinct from "nothing measured".
 */
export function observeValue(name: string, value: number, labels: Record<string, string> = {}): void {
  if (!Number.isFinite(value)) return;
  logger.log({ metric: name, value, ...labels });
}
