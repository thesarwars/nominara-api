import { fileURLToPath } from "node:url";
import { loadEnv } from "../../config/env.js";
import { connect } from "../../db/client.js";
import { createPgPool } from "../../db/pg-pool.js";
import { reconcileOrphanedReservations } from "../../lib/credits/reconcile.js";

// STORY-073 — the orphan reconciler, reachable by hand.
//
// ⚠ ITS REAL PRODUCER DOES NOT EXIST YET. `system-architecture.md` §4 gives
// `credit.reconcile` a "cron every 10 min" producer, and nothing in this repo
// registers a BullMQ repeatable job for any queue — not this one, not
// `capture.plan`'s scheduler. The handler is wired
// (`lib/queue/handlers/credit-reconcile.handler.ts`) and will run the moment
// something enqueues; until then this script is how an operator runs it,
// exactly as `retention.ts` and `audit-verify.ts` are run.
//
// The logic lives in `lib/credits/reconcile.ts` and is shared with the
// handler rather than duplicated here, so the hand-run path and the queued
// path cannot drift — which is the failure `maintenance.ts` is currently
// exposed to and this one is not.

async function main(): Promise<void> {
  const env = loadEnv();
  // ⚠ TWO CONNECTIONS, AND THE FIRST ONE IS THE PRIVILEGED ONE.
  // `DATABASE_URL` is the owner role; `DATABASE_URL_POOLED` is
  // `nominara_app`, which FORCE RLS reduces to zero rows for the
  // cross-tenant scan. Building both from the pooled URL is exactly the
  // defect the second-engineer review reproduced — see `ReconcileConnections`.
  const discovery = await connect(env.DATABASE_URL);
  const pool = createPgPool(env.DATABASE_URL_POOLED);
  try {
    const outcome = await reconcileOrphanedReservations({ discovery, work: pool });
    console.log(JSON.stringify(outcome, null, 2));
    // A reservation that could not be released is not a reason to fail the
    // whole run — the others were released — but it is a reason for a
    // non-zero exit, so a cron wrapper notices.
    if (outcome.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
    await discovery.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
