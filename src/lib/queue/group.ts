import { QUEUE_TOPOLOGY, QUEUE_WORKER_GROUPS, type QueueTopologyEntry } from "./topology.js";

// STORY-030 — AC "The worker entry point selects its queue group by
// configuration, so one image serves every worker group." src/worker.ts
// reads WORKER_GROUP from env and calls queuesForGroup(group) to get the
// exact set of queues that process's worker registers — one image, group
// selected at runtime, never a per-group build.

export type WorkerGroup = (typeof QUEUE_WORKER_GROUPS)[number];

export class UnknownWorkerGroupError extends Error {
  constructor(group: string) {
    super(`unknown worker group "${group}"`);
    this.name = "UnknownWorkerGroupError";
  }
}

function isWorkerGroup(group: string): group is WorkerGroup {
  return (QUEUE_WORKER_GROUPS as readonly string[]).includes(group);
}

/** Every queue belonging to `group`, per topology.ts's workerGroup field. */
export function queuesForGroup(group: WorkerGroup): readonly QueueTopologyEntry[] {
  if (!isWorkerGroup(group)) {
    throw new UnknownWorkerGroupError(group);
  }
  return QUEUE_TOPOLOGY.filter((entry) => entry.workerGroup === group);
}
