import { type AssertionContext } from "../support/assertion-context.js";
import { type Breaker } from "../support/breakers.js";
import { assertNoEffectiveExecute } from "./iso-29-maintenance-execute-effective.js";

// STORY-013 r5 — the same effective-EXECUTE check as ISO-29 (a refused role, or any role it is a member of in any way, may not EXECUTE a
// maintenance function), registered on its own because the registry allows one breaker per assertion and the ADMIN-only route is a different
// bypass: no INHERIT and no SET, yet the holder can grant itself both.
export const assertIso30MaintenanceExecuteAdminOnly = (ctx: AssertionContext): Promise<void> => assertNoEffectiveExecute(ctx, "ISO-30");

export const iso30Breaker: Breaker = {
  id: "ISO-30",
  description: "grants nominara_owner to nominara_worker WITH ADMIN TRUE, INHERIT FALSE, SET FALSE (a runtime role that can grant itself the rights) and revokes it",
  apply: async (client) => {
    await client.query("GRANT nominara_owner TO nominara_worker WITH ADMIN TRUE, INHERIT FALSE, SET FALSE");
  },
  revert: async (client) => {
    await client.query("REVOKE nominara_owner FROM nominara_worker");
  },
};
