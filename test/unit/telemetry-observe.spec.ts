import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { incrementCounter, observeValue } from "../../src/lib/telemetry/metrics.js";

// STORY-056 AC11 — the Logger-based histogram observation beside incrementCounter (no metrics dependency exists yet).
describe("STORY-056 · observeValue", () => {
  afterEach(() => vi.restoreAllMocks());
  const capture = (): unknown[] => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(m));
    return lines;
  };

  it("logs the metric name, the observed value and the labels", () => {
    const lines = capture();
    observeValue("nominara_rollup_displacement_detection_lag_seconds", 42.5, { outcome: "ok" });
    expect(lines).toEqual([{ metric: "nominara_rollup_displacement_detection_lag_seconds", value: 42.5, outcome: "ok" }]);
  });

  it("keeps 0 distinct from an absent observation: 0 is logged, a non-finite value is refused and logs nothing", () => {
    const lines = capture();
    observeValue("nominara_x_seconds", 0);
    expect(lines).toEqual([{ metric: "nominara_x_seconds", value: 0 }]);
    lines.length = 0;
    observeValue("nominara_x_seconds", Number.NaN);
    observeValue("nominara_x_seconds", Number.POSITIVE_INFINITY);
    expect(lines).toEqual([]);
  });

  it("incrementCounter is unchanged", () => {
    const lines = capture();
    incrementCounter("nominara_x_total", { a: "b" });
    expect(lines).toEqual([{ metric: "nominara_x_total", value: 1, a: "b" }]);
  });
});
