import { z } from "zod";
import {
  auxAuditCompletedEventSchema,
  auxFindingCreatedEventSchema,
  displacementDetectedEventSchema,
  taskCreatedEventSchema,
  taskMovedEventSchema,
} from "./analysis-events.schema.js";
import {
  creditsDebitedEventSchema,
  creditsDepletedEventSchema,
  creditsThresholdEventSchema,
  creditsToppedUpEventSchema,
  quotaThresholdEventSchema,
  reportReadyEventSchema,
} from "./billing-events.schema.js";
import {
  engineDegradedEventSchema,
  runCompletedEventSchema,
  runFailedEventSchema,
  runProgressEventSchema,
  scanCompletedEventSchema,
  scanEngineResultEventSchema,
} from "./capture-events.schema.js";
import { realtimeEventNameSchema, type RealtimeEventName } from "./event-name.schema.js";
import {
  memberChangedEventSchema,
  resyncEventSchema,
  serverDrainingEventSchema,
  socketErrorEventSchema,
} from "./platform-events.schema.js";

// STORY-026 T19 — the catalog: every §11 event name bound to its payload.
//
// Exhaustive BY TYPE. `satisfies Record<RealtimeEventName, ZodType>` makes an
// event added to the name union without a payload a compile error, and a
// payload bound to a name the union does not contain the same. An event that
// is typed nowhere is an event a client cannot handle, and one bound to a
// misspelled name is worse — it type-checks and never fires.

export const REALTIME_EVENT_PAYLOADS = {
  "run.progress": runProgressEventSchema,
  "run.completed": runCompletedEventSchema,
  "run.failed": runFailedEventSchema,
  "scan.engine_result": scanEngineResultEventSchema,
  "scan.completed": scanCompletedEventSchema,
  "aux.audit_completed": auxAuditCompletedEventSchema,
  "aux.finding_created": auxFindingCreatedEventSchema,
  "task.created": taskCreatedEventSchema,
  "task.moved": taskMovedEventSchema,
  "displacement.detected": displacementDetectedEventSchema,
  "quota.threshold": quotaThresholdEventSchema,
  "credits.debited": creditsDebitedEventSchema,
  "credits.threshold": creditsThresholdEventSchema,
  "credits.depleted": creditsDepletedEventSchema,
  "credits.topped_up": creditsToppedUpEventSchema,
  "report.ready": reportReadyEventSchema,
  "engine.degraded": engineDegradedEventSchema,
  "member.changed": memberChangedEventSchema,
  "server.draining": serverDrainingEventSchema,
  "resync": resyncEventSchema,
  "error": socketErrorEventSchema,
} as const satisfies Record<RealtimeEventName, z.ZodType>;

export type RealtimeEventPayloads = {
  [Name in RealtimeEventName]: z.infer<(typeof REALTIME_EVENT_PAYLOADS)[Name]>;
};

/** The payload schema for an event name, when the name is DATA rather than a literal. */
export function realtimeEventPayloadSchema(name: RealtimeEventName): z.ZodType {
  return REALTIME_EVENT_PAYLOADS[name];
}

/**
 * The envelope every realtime frame travels in.
 *
 * `event` and `data` only. There is deliberately no `timestamp` and no
 * sequence number: neither is in §11, and inventing either would publish a
 * guarantee this repository has not designed — an ordering promise, or a clock
 * a client might reconcile against its own.
 *
 * AC10 IS DEFERRED, WITH A NAMED BLOCKER (decision D4). §11's prose says
 * "every event maps to a precise TanStack Query invalidation key", and §11's
 * table has no such column. The keys belong to `nominara-app`'s `lib/query/`
 * (project-structure.md §3), so inventing nineteen of them here would make
 * this repository the source of a contract it does not own. There is no
 * `invalidation_key` member below for exactly that reason, and AC10 must not
 * be reported as met.
 */
export const realtimeFrameSchema = z
  .object({
    event: realtimeEventNameSchema,
    data: z.unknown(),
  })
  .strict();

export type RealtimeFrame = z.infer<typeof realtimeFrameSchema>;
