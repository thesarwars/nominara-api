import { incrementCounter } from "../telemetry/metrics.js";
import { engineKeySchema } from "./contract.js";
import type { SpendMeter } from "./spend-meter.js";

// Recording what an engine call cost, and REPORTING what the meter says about it. Shared by the scheduled capture path and the Tools path (owner
// decision 26: one monthly ceiling). The meter marks an alert fired BEFORE it returns it, so the call that crosses a threshold is the only one that can
// ever report it - a caller that drops the result loses the alert for the rest of the cycle.

export interface SpendLog {
  warn(message: string): void;
  error(message: string): void;
}

/** Never throws: the money is already spent. A meter that cannot record is logged and counted, not silent. */
export async function recordEngineSpend(meter: SpendMeter, log: SpendLog, engineKey: string, usd: number, source: "capture" | "lookup"): Promise<void> {
  const key = engineKeySchema.safeParse(engineKey);
  if (!key.success) return;
  const labels = { engine_key: key.data, source };
  let result: Awaited<ReturnType<SpendMeter["recordCost"]>>;
  try {
    result = await meter.recordCost(key.data, usd);
  } catch (error) {
    incrementCounter("nominara_capture_cost_record_failed_total", labels);
    log.warn(`engine spend could not be recorded for ${key.data}: ${error instanceof Error ? error.message : "unknown error"}`);
    return;
  }
  incrementCounter("nominara_capture_cost_recorded_total", labels);
  for (const level of result.newAlerts) {
    log.warn(`engine spend alert ${level} for ${key.data}: ${result.totalUsd.toFixed(2)} of ${String(result.ceilingUsd)} USD this month`);
  }
  if (result.hardStopped) {
    // Enforced by the ceiling check on the NEXT call; this is the crossing itself.
    log.error(`engine spend ceiling crossed for ${key.data}: ${result.totalUsd.toFixed(2)} of ${String(result.ceilingUsd)} USD this month`);
  }
}
