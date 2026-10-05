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
 * Deletes `unverified` accounts with NO proof, NO credential (revoked ones
 * included — a revoked row is evidence), NO session and NO workspace
 * membership, older than the TTL. Each row is deleted under its own savepoint
 * and re-checks every condition in the DELETE itself, so a row that gained a
 * credential or session between the SELECT and the DELETE is not removed, and
 * a row some other table still references is skipped rather than forced.
 */
export async function sweepStaleUnverifiedAccounts(
  client: ClientBase,
  now: Date = new Date(),
  ttlDays: number = UNVERIFIED_ACCOUNT_TTL_DAYS,
): Promise<UnverifiedSweepResult> {
  const cutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);
  await client.query("BEGIN");
  try {
    const candidates = await client.query<{ id: string }>(
      `SELECT id FROM users
       WHERE status = 'unverified' AND email_verified_at IS NULL AND deleted_at IS NULL AND created_at < $1
       ORDER BY created_at`,
      [cutoff],
    );
    let deleted = 0;
    let skipped = 0;
    for (const { id } of candidates.rows) {
      await client.query("SAVEPOINT sweep_one");
      try {
        // Its own pending codes go with it (the FK cascades), then the row —
        // only if it is STILL unproved, credential-less, session-less and
        // memberless.
        const result = await client.query(
          `DELETE FROM users u
           WHERE u.id = $1 AND u.status = 'unverified' AND u.email_verified_at IS NULL AND u.deleted_at IS NULL
             AND u.created_at < $2
             AND NOT EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id)
             AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = u.id)`,
          [id, cutoff],
        );
        deleted += result.rowCount ?? 0;
        await client.query("RELEASE SAVEPOINT sweep_one");
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT sweep_one");
        skipped += 1;
      }
    }
    await client.query("COMMIT");
    return { deleted, skipped };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
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
