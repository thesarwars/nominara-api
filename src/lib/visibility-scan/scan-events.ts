import { z } from "zod";
import { scanEngineFailureSchema, scanStreamEngineResultSchema } from "../../../contracts/tools/index.js";
import type { Cache } from "../cache/cache.port.js";
import { tenantKey } from "../cache/valkey-keys.js";
import type { ScanPublished } from "./run-scan.js";

// STORY-079 - where a scan's per-engine events live while the run is in flight, so a client can reconnect and be replayed everything that has landed.
//
// ONE KEY PER ENGINE, in the workspace's own key namespace, written by the worker the moment the engine settles and read by whichever API replica
// holds the client's stream. A per-engine key (not a list) is deliberate: the cache port offers get/set, and a write of one engine's event is
// idempotent - a redelivered job overwrites the same value rather than appending a duplicate. The key outlives the run by an hour; the stored
// snapshot in the run row is the permanent record (re-opening reads that, never this).

export const SCAN_EVENT_TTL_MS = 60 * 60 * 1000;

const storedEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("engine_result"), result: scanStreamEngineResultSchema, mentioned: z.array(z.string()).optional() }).strict(),
  z.object({ kind: z.literal("engine_failed"), failure: scanEngineFailureSchema }).strict(),
]);

export function scanEventKey(env: string, workspaceId: string, runId: string, engine: string): string {
  return tenantKey(env, workspaceId, "tool-scan", runId, engine);
}

export async function writeScanEvent(cache: Cache, env: string, workspaceId: string, runId: string, event: ScanPublished): Promise<void> {
  const engine = event.kind === "engine_result" ? event.result.engine : event.failure.engine;
  await cache.set(scanEventKey(env, workspaceId, runId, engine), JSON.stringify(event), { ttlMs: SCAN_EVENT_TTL_MS });
}

/** The events that have landed, in the run's engine order. An unreadable or foreign value is skipped, never trusted. */
export async function readScanEvents(cache: Cache, env: string, workspaceId: string, runId: string, engines: readonly string[]): Promise<ScanPublished[]> {
  const values = await cache.getMany(engines.map((engine) => scanEventKey(env, workspaceId, runId, engine)));
  const events: ScanPublished[] = [];
  for (const value of values) {
    if (value === undefined || value === "") continue;
    try {
      const parsed = storedEventSchema.safeParse(JSON.parse(value));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // A corrupt value is a miss: the engine simply has not landed yet as far as this reader can tell.
    }
  }
  return events;
}
