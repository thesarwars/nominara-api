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
// It runs DAILY at 02:50 UTC as the `identity.sweep_unverified` queue (owner
// decision, 2026-10-05; see lib/queue/handlers/identity-sweep-unverified.handler.ts),
// and `pnpm identity:sweep-unverified` remains the manual entry point.

/** An unproved account nobody has touched for this long is stale. A decision, proposed here, adjustable by one constant. */
export const UNVERIFIED_ACCOUNT_TTL_DAYS = 7;

export interface UnverifiedSweepResult {
  readonly deleted: number;
  /** Candidates that another table still references (a foreign key); left in place, never forced. */
  readonly skippedReferenced: number;
  /** Candidates somebody else held a lock on (NOWAIT): by definition not stale this run, retried tomorrow. */
  readonly skippedLocked: number;
}

/** Thrown, before anything is read or deleted, when the connection cannot see past row-level security. */
export class SweepBlindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepBlindError";
  }
}

/**
 * ⚠ THE SWEEP DELETES FROM A TABLE WHOSE CHILDREN IT CANNOT SEE ON A BLIND
 * CONNECTION. `workspace_members` carries FORCE ROW LEVEL SECURITY with
 * policies for the runtime roles only, and its `user_id` foreign key is
 * `ON DELETE CASCADE`. A connection that is neither a superuser nor BYPASSRLS
 * sees ZERO memberships, concludes an unverified user has none, deletes it —
 * and the cascade silently removes the membership it could not see. Same
 * precedent and same query as `assertVerifierCanSee` in audit-verify.ts, with
 * its own words: a property of the role, true or false regardless of how much
 * data exists, so it cannot itself be hidden by what it guards against.
 */
export async function assertSweepCanSee(client: ClientBase): Promise<void> {
  const result = await client.query<{ can_see: boolean; who: string }>(
    "SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user",
  );
  const row = result.rows[0];
  if (row?.can_see === true) return;
  throw new SweepBlindError(
    `the unverified-account sweep is connected as "${row?.who ?? "unknown"}", which neither bypasses row-level security nor is a superuser — ` +
      "workspace_members carries FORCE ROW LEVEL SECURITY and cascades on delete, so this role would see no memberships and delete accounts that have them",
  );
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
  // Before anything is read: a blind role's empty view is exactly what must not
  // be mistaken for "nothing holds this account".
  await assertSweepCanSee(client);
  const cutoff = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);
  const candidates = await client.query<{ id: string }>(
    `SELECT u.id FROM users u
     WHERE u.status = 'unverified' AND u.email_verified_at IS NULL AND u.deleted_at IS NULL AND u.created_at < $1
       AND NOT EXISTS (SELECT 1 FROM email_otp_codes o WHERE o.user_id = u.id AND o.created_at >= $1)
     ORDER BY u.created_at`,
    [cutoff],
  );
  let deleted = 0;
  let skippedReferenced = 0;
  let skippedLocked = 0;
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
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const code = (error as { code?: string }).code;
      if (code === "55P03") {
        skippedLocked += 1; // held by someone: not stale this run
      } else if (code === "23503") {
        skippedReferenced += 1; // still referenced by another table
      } else {
        throw error; // anything else is a fault, not a skip
      }
    }
  }
  return { deleted, skippedReferenced, skippedLocked };
}

async function main(): Promise<void> {
  const client = await connect(requireDatabaseUrl());
  try {
    const result = await sweepStaleUnverifiedAccounts(client);
    console.log(`identity:sweep-unverified — deleted ${String(result.deleted)}, skipped ${String(result.skippedReferenced)} referenced / ${String(result.skippedLocked)} locked`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
