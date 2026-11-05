import { afterEach, describe, expect, it, vi } from "vitest";
import * as metrics from "../telemetry/metrics.js";
import { recordEngineSpend } from "./record-spend.js";
import type { SpendMeter } from "./spend-meter.js";

// STORY-079 review round 2 - the Tools path must not discard the spend meter's verdict: a crossing is reported once, by the call that made it.

function meterReturning(result: Awaited<ReturnType<SpendMeter["recordCost"]>>): SpendMeter {
  return { recordCost: async () => result } as unknown as SpendMeter;
}

describe("STORY-079 · recordEngineSpend", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs each newly fired alert level and counts the recording, labelled with its source", async () => {
    const counter = vi.spyOn(metrics, "incrementCounter").mockImplementation(() => undefined);
    const warn = vi.fn();
    const error = vi.fn();
    await recordEngineSpend(meterReturning({ totalUsd: 81, ceilingUsd: 100, newAlerts: ["warn_80"], hardStopped: false }), { warn, error }, "gemini", 2, "lookup");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("warn_80");
    expect(error).not.toHaveBeenCalled();
    expect(counter).toHaveBeenCalledWith("nominara_capture_cost_recorded_total", { engine_key: "gemini", source: "lookup" });
  });

  it("logs the hard-stop crossing as an error", async () => {
    vi.spyOn(metrics, "incrementCounter").mockImplementation(() => undefined);
    const warn = vi.fn();
    const error = vi.fn();
    await recordEngineSpend(meterReturning({ totalUsd: 100, ceilingUsd: 100, newAlerts: ["warn_80", "warn_95"], hardStopped: true }), { warn, error }, "gemini", 1, "lookup");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("a meter that cannot record is logged and counted, never silent, and never throws", async () => {
    const counter = vi.spyOn(metrics, "incrementCounter").mockImplementation(() => undefined);
    const warn = vi.fn();
    const meter = { recordCost: async () => { throw new Error("valkey down"); } } as unknown as SpendMeter;
    await expect(recordEngineSpend(meter, { warn, error: vi.fn() }, "gemini", 1, "lookup")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(counter).toHaveBeenCalledWith("nominara_capture_cost_record_failed_total", { engine_key: "gemini", source: "lookup" });
  });

  it("an unknown engine key records nothing", async () => {
    const recordCost = vi.fn();
    await recordEngineSpend({ recordCost } as unknown as SpendMeter, { warn: vi.fn(), error: vi.fn() }, "nope", 1, "lookup");
    expect(recordCost).not.toHaveBeenCalled();
  });

  it("the scheduled capture path labels its spend counters { engine_key, source: \"capture\" }", async () => {
    const counter = vi.spyOn(metrics, "incrementCounter").mockImplementation(() => undefined);
    await recordEngineSpend(meterReturning({ totalUsd: 1, ceilingUsd: 100, newAlerts: [], hardStopped: false }), { warn: vi.fn(), error: vi.fn() }, "gemini", 1, "capture");
    expect(counter).toHaveBeenCalledWith("nominara_capture_cost_recorded_total", { engine_key: "gemini", source: "capture" });
    const failing = { recordCost: async () => { throw new Error("valkey down"); } } as unknown as SpendMeter;
    await recordEngineSpend(failing, { warn: vi.fn(), error: vi.fn() }, "gemini", 1, "capture");
    expect(counter).toHaveBeenCalledWith("nominara_capture_cost_record_failed_total", { engine_key: "gemini", source: "capture" });
  });
});
