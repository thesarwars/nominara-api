import type { Client } from "pg";

// STORY-012 T6 — the shared Breaker shape. `apply` mutates a DISPOSABLE
// database copy (never the shared fixture) to reopen exactly the hole the
// paired assertion exists to catch. `revert` undoes anything that isn't
// automatically discarded when the disposable database is dropped — in
// practice this only matters for the rare breaker that mutates a
// CLUSTER-WIDE object (a role attribute), since every other breaker's
// changes are schema-local to the disposable database and vanish with it.
export interface Breaker {
  readonly id: string;
  readonly description: string;
  apply(client: Client): Promise<void>;
  revert(client: Client): Promise<void>;
}

/** Most breakers only touch objects local to the disposable database — dropping it is the whole revert. */
export const NOOP_REVERT = async (_client: Client): Promise<void> => {
  // intentionally empty
};
