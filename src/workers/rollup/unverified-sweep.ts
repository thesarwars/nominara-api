import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { connect, requireDatabaseUrl } from "../../db/client.js";

// STORY-173 — an anonymous email-code request for an address with no account
// creates that account `unverified` (it is how a new person proves their
// address before their first credential exists). Most are real sign-ups that
// finish within minutes; some are a typo, an abandoned attempt, or someone
// typing another person's address. This sweep deletes the ones nobody came
// back for, so the table does not accumulate them and a squatted address does
// not stay squatted.
//
// Same surface as credit-verify.ts / audit-verify.ts: a plain exported function
// over a privileged client, plus a main() an operator or a scheduler runs.
// ⚠ NOT YET ON A SCHEDULE. Running it from the queue needs a new queue
// (topology.ts + schedule.ts + a handler), which is a decision for the owner
// rather than something this story slips in. Until then it is run by hand:
// `pnpm identity:sweep-unverified`.

/** An unproved account nobody has touched for this long is stale. A decision, proposed here, adjustable by one constant. */
export const UNVERIFIED_ACCOUNT_TTL_DAYS = 7;

export interface UnverifiedSweepResult {
  readonly deleted: number;
  /** Candidates that a foreign key still referenced; left in place, never forced. */
  readonly skipped: number;
}

/**
 * Deletes `unverified` accounts that are STALE: no proof, NO credential
 * (revoked ones included — a revoked row is evidence), no session, no workspace
 * membership, nothing happening on them within the TTL, and created before it.
 *
 * "Nothing happening" is measured from the last ACTIVITY, not from creation: an
 * account whose email code was issued inside the TTL is a person mid sign-up
 * (an old squatted row that its owner has just re-requested a code for), and
 * sweeping it would make their verify fail. The age of the row alone is not
 * staleness.
 *
 * Each row is its own transaction, so no lock outlives its own row. Locks are
 * taken in the order the email-code verify takes them (codes, then the users
 * row — the cascade would take them the other way round) and with NOWAIT: a row
 * somebody else is holding is by definition not stale, and is skipped rather
 * than waited for. The DELETE re-checks every condition, so a row that gained a
 * credential, session or code since it was selected is not removed, and a row
 * another table still references is skipped, never forced.
 */
export async function sweepStaleUnverifiedAccounts(
  client: ClientBase,
  now: Date = new Date(),
  ttlDays: number = UNVERIFIED_ACCOUNT_TTL_DAYS,
): Promise<UnverifiedSweepResult> {
  const cutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);
  const candidates = await client.query<{ id: string }>(
    `SELECT u.id FROM users u
     WHERE u.status = 'unverified' AND u.email_verified_at IS NULL AND u.deleted_at IS NULL AND u.created_at < $1
       AND NOT EXISTS (SELECT 1 FROM email_otp_codes o WHERE o.user_id = u.id AND o.created_at >= $1)
     ORDER BY u.created_at`,
    [cutoff],
  );
  let deleted = 0;
  let skipped = 0;
  for (const { id } of candidates.rows) {
    await client.query("BEGIN");
    try {
      await client.query("SELECT id FROM email_otp_codes WHERE user_id = $1 FOR UPDATE NOWAIT", [id]);
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT", [id]);
      // Its own pending codes go with it (the FK cascades) — only if it is
      // STILL unproved, credential-less, session-less, memberless and idle.
      const result = await client.query(
        `DELETE FROM users u
         WHERE u.id = $1 AND u.status = 'unverified' AND u.email_verified_at IS NULL AND u.deleted_at IS NULL
           AND u.created_at < $2
           AND NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM email_otp_codes o WHERE o.user_id = u.id AND o.created_at >= $2)`,
        [id, cutoff],
      );
      await client.query("COMMIT");
      deleted += result.rowCount ?? 0;
    } catch {
      // 55P03 (held by someone: not stale) or 23503 (still referenced).
      await client.query("ROLLBACK").catch(() => {});
      skipped += 1;
    }
  }
  return { deleted, skipped };
}

async function main(): Promise<void> {
  const client = await connect(requireDatabaseUrl());
  try {
    const result = await sweepStaleUnverifiedAccounts(client);
    console.log(`identity:sweep-unverified — deleted ${String(result.deleted)}, skipped ${String(result.skipped)}`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
