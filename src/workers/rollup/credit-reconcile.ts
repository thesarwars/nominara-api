import { fileURLToPath } from "node:url";
import { loadEnv } from "../../config/env.js";
import { connect } from "../../db/client.js";
import { createPgPool } from "../../db/pg-pool.js";
import { reconcileOrphanedReservations } from "../../lib/credits/reconcile.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../lib/queue/locks.js";

// STORY-073 — the orphan reconciler, reachable by hand.
//
// ⚠ IT NOW HAS A REAL PRODUCER. STORY-140 registered the BullMQ job
// scheduler §4's "cron every 10 min" always described, so this runs by itself
// every ten minutes in every worker-rollup replica. This script remains how an
// operator runs it OUT of cadence — during an incident, or to confirm a fix —
// exactly as `retention.ts` and `audit-verify.ts` are run.
//
// ⚠ That last clause was false when written: `audit-verify.ts` had no pnpm
// script at all and was reachable only from its own tests. STORY-143 gave it
// one (`pnpm audit:verify`) and a daily tick, so the sentence is true now.
//
// ⚠ WHICH MEANS IT CAN NOW COLLIDE WITH A SCHEDULED TICK, and that is exactly
// when an operator is most likely to run it. So it takes the SAME advisory
// lock the handler takes (STORY-141). Without this the "single-flight across
// the fleet" claim in `locks.ts` would be false in precisely the situation it
// exists for. Colliding is safe either way — `releaseReservation` takes the
// wallet row lock before reading the ledger, so the loser reports
// `already_settled` rather than double-returning — but "safe" and
// "single-flight" are different claims and only one of them was true.
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
  const lockKey = globalQueueLockKey("credit.reconcile");
  try {
    if (!(await tryAdvisorySessionLock(discovery, lockKey))) {
      // Non-zero, and says which lock — an operator who runs this during an
      // incident and sees nothing happen must not be left guessing whether it
      // ran and found nothing or never ran at all.
      console.error("another process holds the credit.reconcile advisory lock; nothing was scanned");
      process.exitCode = 1;
      return;
    }
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
