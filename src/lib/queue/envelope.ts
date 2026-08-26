import { signJobPayload } from "./signing.js";
import type { TenantJob } from "../../tenancy/with-tenant-job.js";

// STORY-030 Phase B — the on-the-wire shape of a tenant-scoped BullMQ job's
// `data` field. `TenantJob` (src/tenancy/with-tenant-job.ts) models
// `{ data, signature }` as two SIBLING fields, but a BullMQ job only carries
// one `data` blob — so that blob IS this envelope, and `toTenantJob` below
// is the one place that reshapes it back into `{ data, signature }` for
// `withTenantJob`/`rotatingHmacJobVerifier` to consume unchanged.

export interface TenantScopedPayload extends Record<string, unknown> {
  readonly workspaceId: string;
  /** Identifies which configured signing key (current/previous) signed this payload — read by rotatingHmacJobVerifier. */
  readonly kid: string;
}

export interface QueueJobEnvelope<P extends TenantScopedPayload = TenantScopedPayload> {
  readonly payload: P;
  readonly signature: string;
}

/** Producer side: signs `payload`'s canonical JSON with `key` and wraps it into the envelope shape a tenant-scoped queue's worker expects. */
export function signQueueJobPayload<P extends TenantScopedPayload>(payload: P, key: Buffer): QueueJobEnvelope<P> {
  return { payload, signature: signJobPayload(payload, key) };
}

/** Reshapes a received envelope back into the `{ data, signature }` pair every JobVerifier / withTenantJob expects. */
export function toTenantJob<P extends TenantScopedPayload>(envelope: QueueJobEnvelope<P>): TenantJob<P> {
  return { data: envelope.payload, signature: envelope.signature };
}
