import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import type { Cache } from "../../cache/cache.port.js";
import type { ScheduledRun } from "../../capture/scheduler.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// NEW-A-10 RED stub — replaced by the implementation in the next commit.
export interface CapturePlanDeps {
  readonly cache?: Cache;
  readonly dispatch?: (scheduled: ScheduledRun) => Promise<unknown>;
  readonly now?: () => Date;
}

export function createCapturePlanHandler(_context: QueueHandlerContext, _deps?: CapturePlanDeps): JobProcessor {
  return (_tx: ClientBase, _job: Job): Promise<void> => Promise.reject(new Error("capture.plan handler not implemented"));
}
