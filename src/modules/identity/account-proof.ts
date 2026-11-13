import { Logger } from "@nestjs/common";
import type { Pool } from "pg";
import type { SessionStrongAuth } from "../../api/guards/auth.guard.js";
import { EmailNotVerifiedException, StepUpRequiredException } from "../../tenancy/errors.js";
import { assertStepUpFresh } from "../../tenancy/step-up.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";

// STORY-173 — the three rules every way of attaching a credential to an
// account shares, in one place so a passkey, an OAuth link and an OTP sign-in
// can never disagree about them:
//
//   1. the account's ADDRESS must be proved (requireProvedAccount);
//   2. the session asking must have stepped up (requireFreshStrongAuth);
//   3. the FIRST proof of an address revokes whatever predates it
//      (applyFirstProof) — durably, with a reason no sign-in ever undoes.
//
// These are plain functions over a pg client, not a layer: IdentityService,
// OauthService and EmailOtpService each call them inside their own
// transaction, which is the point (the check and the write must share one).

type Queryable = { query: Pool["query"] };

/** What the person was trying to do when a rule refused them — the one label the refusal metric carries besides the reason. */
export type CredentialAction = "passkey_add" | "passkey_revoke" | "oauth_link" | "oauth_unlink" | "sessions_revoke_others" | "session_revoke";

/** Why a credential or session was revoked by the first proof of an address. Never reactivated by a sign-in. */
export const ADDRESS_PROVED = "address_proved";

/**
 * The account must exist, be active, and have a PROVED address. `active` alone
 * is not proof (historically a passkey registration promoted `unverified ->
 * active` without any proof, and rows from then still exist), so the proof
 * column is checked explicitly. `FOR SHARE` pins the row until the caller's
 * transaction ends, so the proof cannot be withdrawn between this check and the
 * write that follows it (pinned by a test that tries to).
 */
export async function requireProvedAccount(
  client: Queryable,
  userId: string,
  logger: Logger,
  action: CredentialAction,
): Promise<{ id: string; email: string }> {
  const result = await client.query<{ id: string; email: string }>(
    `SELECT id, email::text AS email FROM users
     WHERE id = $1 AND status = 'active' AND email_verified_at IS NOT NULL AND deleted_at IS NULL
     FOR SHARE`,
    [userId],
  );
  const user = result.rows[0];
  if (!user) {
    refuse(logger, userId, action, "address_unproven");
    throw new EmailNotVerifiedException(
      "the email address of this account has not been verified; sign in with an email code first",
    );
  }
  return user;
}

/** The shared "fresh WebAuthn or OTP within 5 minutes" rule; a refusal is counted and logged by account ID. */
export function requireFreshStrongAuth(
  userId: string,
  session: Pick<SessionStrongAuth, "lastStrongAuthAt"> | undefined,
  logger: Logger,
  action: CredentialAction,
): void {
  try {
    assertStepUpFresh(session?.lastStrongAuthAt ?? null);
  } catch (error) {
    if (error instanceof StepUpRequiredException) {
      refuse(logger, userId, action, "step_up_required");
    }
    throw error;
  }
}

/**
 * One metric for every credential change a rule refused — adding or revoking a
 * passkey, connecting or disconnecting a provider — labelled by what was being
 * attempted and why it was refused. (It used to be counted under a
 * passkey-registration name even for OAuth link and unlink.) The account ID is
 * logged, never the address.
 */
export function refuse(logger: Logger, userId: string, action: CredentialAction, reason: string): void {
  logger.warn(`credential change refused action=${action} reason=${reason} user_id=${userId}`);
  incrementCounter("nominara_identity_credential_change_refused_total", { action, reason });
}

/**
 * The FIRST proof of an address (users.email_verified_at NULL -> set), in the
 * caller's transaction. Until now nobody had shown control of the address, so
 * every credential and session already on the account was put there by someone
 * who never proved it either — a passkey from the old anonymous registration,
 * an OAuth link from a provider that did not verify the address. The person
 * who has just proved it is the first one entitled to it.
 *
 * - The users row is locked FOR UPDATE first, so two concurrent proofs cannot
 *   both see "first", and (every other writer locking users before
 *   user_credentials) no lock-order cycle forms.
 * - Revocation is DURABLE: the rows keep a reason (`address_proved`) that
 *   OAuth sign-in never reactivates. A plain `revoked_at` would be undone by
 *   signing in again with the same provider subject.
 * - Nothing happens for an account that is already proved.
 */
export async function applyFirstProof(
  client: Queryable,
  userId: string,
  logger: Logger,
): Promise<{ firstProof: boolean }> {
  const prior = await client.query<{ email_verified_at: Date | null }>(
    `SELECT email_verified_at FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  if (prior.rows[0]!.email_verified_at !== null) {
    return { firstProof: false };
  }
  // EVERY credential of the account that is not already marked, live or not.
  // One revoked BEFORE the proof (a planter's credential its planter unlinked a
  // day earlier, or one with no reason from before the column existed) keeps its
  // revocation time but takes the durable reason: left as `user` or NULL, a
  // sign-in would "reactivate" it, which is the revival this reason exists to
  // stop.
  const credentials = await client.query(
    `UPDATE user_credentials
     SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $2
     WHERE user_id = $1 AND revoked_reason IS DISTINCT FROM $2`,
    [userId, ADDRESS_PROVED],
  );
  const sessions = await client.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, ADDRESS_PROVED],
  );
  await client.query(
    `UPDATE users SET email_verified_at = now(), status = CASE WHEN status = 'unverified' THEN 'active' ELSE status END
     WHERE id = $1`,
    [userId],
  );
  if ((credentials.rowCount ?? 0) > 0 || (sessions.rowCount ?? 0) > 0) {
    // IDs and counts only — never the address.
    logger.warn(
      `first proof of address revoked earlier access user_id=${userId} ` +
        `credentials=${String(credentials.rowCount ?? 0)} sessions=${String(sessions.rowCount ?? 0)}`,
    );
    incrementCounter("nominara_identity_first_proof_revocation_total");
  }
  return { firstProof: true };
}
