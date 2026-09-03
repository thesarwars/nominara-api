import { randomBytes } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Pool } from "pg";
import { loadEnv } from "../../config/env.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type { PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { nextCounter } from "../../lib/webauthn/sign-counter-policy.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SessionService, type SessionTokens } from "./session.service.js";
import type {
  AssertionOptionsRequest,
  PasskeyListItem,
  PasskeyOptionsRequest,
  PasskeyVerifyRequest,
  RegistrationOptionsRequest,
} from "./dto/index.js";

// STORY-014 — ceremony validation (attestation, clientDataJSON, signature)
// is delegated entirely to @simplewebauthn/server; this file's only owned
// logic is challenge lifecycle (single-use, short-lived, atomic claim),
// persistence, and the sign-counter accept/clone-signal policy
// (src/lib/webauthn/sign-counter-policy.ts).

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// exactOptionalPropertyTypes forbids assigning `transports: undefined` —
// the key must be entirely absent when there is nothing to report.
function transportsField(transports: string[] | null): { transports?: AuthenticatorTransportFuture[] } {
  return transports && transports.length > 0 ? { transports: transports as AuthenticatorTransportFuture[] } : {};
}

export interface PasskeyOptionsResult {
  readonly ceremony_id: string;
  readonly options: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly sessions: SessionService,
  ) {}

  async createOptions(input: PasskeyOptionsRequest): Promise<PasskeyOptionsResult> {
    if (input.purpose === "registration") {
      return this.createRegistrationOptions(input);
    }
    return this.createAssertionOptions(input);
  }

  private async createRegistrationOptions(input: RegistrationOptionsRequest): Promise<PasskeyOptionsResult> {
    const env = loadEnv();
    const client = await this.pool.connect();
    try {
      const userResult = await client.query<{ id: string; email: string }>(
        `INSERT INTO users (id, email, status)
         VALUES ($1, $2, 'unverified')
         ON CONFLICT (email) WHERE deleted_at IS NULL
         DO UPDATE SET email = EXCLUDED.email
         RETURNING id, email`,
        [uuidV7(), input.email],
      );
      const user = userResult.rows[0]!;

      const existing = await client.query<{ credential_id: Buffer; transports: string[] | null }>(
        `SELECT credential_id, transports FROM user_credentials
         WHERE user_id = $1 AND kind = 'passkey' AND revoked_at IS NULL AND credential_id IS NOT NULL`,
        [user.id],
      );

      const challengeBytes = randomBytes(32);
      const options = await generateRegistrationOptions({
        rpName: env.WEBAUTHN_RP_NAME,
        rpID: env.WEBAUTHN_RP_ID,
        userName: user.email,
        userID: Buffer.from(user.id.replace(/-/g, ""), "hex"),
        ...(input.display_name === undefined ? {} : { userDisplayName: input.display_name }),
        challenge: challengeBytes,
        attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        excludeCredentials: existing.rows.map((row) => ({
          id: row.credential_id.toString("base64url"),
          ...transportsField(row.transports),
        })),
      });

      const ceremonyId = await this.storeChallenge(client, "registration", user.id, challengeBytes, env);
      return { ceremony_id: ceremonyId, options };
    } finally {
      client.release();
    }
  }

  private async createAssertionOptions(_input: AssertionOptionsRequest): Promise<PasskeyOptionsResult> {
    const env = loadEnv();
    const client = await this.pool.connect();
    try {
      const challengeBytes = randomBytes(32);
      const options = await generateAuthenticationOptions({
        rpID: env.WEBAUTHN_RP_ID,
        userVerification: "preferred",
        challenge: challengeBytes,
      });

      const ceremonyId = await this.storeChallenge(client, "assertion", null, challengeBytes, env);
      return { ceremony_id: ceremonyId, options };
    } finally {
      client.release();
    }
  }

  private async storeChallenge(
    client: { query: Pool["query"] },
    purpose: "registration" | "assertion",
    userId: string | null,
    challengeBytes: Buffer,
    env: { WEBAUTHN_RP_ID: string; WEBAUTHN_ORIGIN: string },
  ): Promise<string> {
    const ceremonyId = uuidV7();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
    await client.query(
      `INSERT INTO webauthn_challenges (id, purpose, user_id, challenge, rp_id, origin, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ceremonyId, purpose, userId, challengeBytes, env.WEBAUTHN_RP_ID, env.WEBAUTHN_ORIGIN, expiresAt],
    );
    return ceremonyId;
  }

  // Atomically claims a challenge row regardless of purpose — zero rows back
  // is rejected uniformly whether the ceremony never existed, already ran,
  // or expired (STORY-014 Technical Notes; do not differentiate the reason,
  // it would leak which case applies to a caller probing ceremony ids).
  private async claimChallenge(
    client: { query: Pool["query"] },
    ceremonyId: string,
  ): Promise<{
    id: string;
    purpose: "registration" | "assertion";
    user_id: string | null;
    challenge: Buffer;
  }> {
    const result = await client.query<{
      id: string;
      purpose: "registration" | "assertion";
      user_id: string | null;
      challenge: Buffer;
    }>(
      `UPDATE webauthn_challenges SET consumed_at = now()
       WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING id, purpose, user_id, challenge`,
      [ceremonyId],
    );
    if (result.rows.length === 0) {
      throw new BadRequestException("ceremony is unknown, already used, or expired");
    }
    return result.rows[0]!;
  }

  async verifyPasskey(input: PasskeyVerifyRequest): Promise<SessionTokens> {
    const env = loadEnv();
    const client = await this.pool.connect();
    try {
      const challenge = await this.claimChallenge(client, input.ceremony_id);
      const expectedChallenge = challenge.challenge.toString("base64url");

      if (challenge.purpose === "registration") {
        return await this.finishRegistration(client, challenge.user_id!, expectedChallenge, input, env);
      }
      return await this.finishAssertion(client, expectedChallenge, input, env);
    } finally {
      client.release();
    }
  }

  private async finishRegistration(
    client: { query: Pool["query"] },
    userId: string,
    expectedChallenge: string,
    input: PasskeyVerifyRequest,
    env: { WEBAUTHN_RP_ID: string; WEBAUTHN_ORIGIN: string },
  ): Promise<SessionTokens> {
    // The library throws on a bad attestation, a wrong origin, or an RP ID
    // hash mismatch (the last of which is what makes a credential minted in
    // one environment unusable in another — STORY-014 test scenario 7).
    // Never let its raw message reach the client; rewrap as the same
    // uniform 400 as an explicit `verified: false`.
    // STORY-127 — the reason is LOGGED before it is discarded.
    //
    // Swallowing it entirely is right for the response and wrong for the
    // server: "passkey registration could not be verified" is the same
    // sentence whether the origin is misconfigured, the RP ID is wrong, or
    // the attestation is genuinely bad, and an operator had no way to tell
    // which. Diagnosing one such failure took reading the database's
    // challenge rows to rule out everything else. The expected values are
    // logged alongside it because a mismatch is the common cause and the
    // message alone does not name what was expected.
    const verification = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: env.WEBAUTHN_ORIGIN,
      expectedRPID: env.WEBAUTHN_RP_ID,
      // STORY-127 — must MATCH the options this ceremony was created with.
      //
      // createRegistrationOptions asks for `userVerification: "preferred"`,
      // which is what security-and-tenancy.md §11's auth-methods table and
      // STORY-014's own AC both specify. @simplewebauthn/server defaults
      // `requireUserVerification` to TRUE, so the ceremony was told UV was
      // optional and the verification then demanded it: every authenticator
      // that did not perform UV — which "preferred" explicitly permits —
      // was rejected with "User verification was required, but user could
      // not be verified", after the browser had already saved the passkey.
      //
      // A registration that cannot complete on a conformant authenticator is
      // not a stricter policy, it is a broken one. Tightening this to
      // "required" is a real option, but it is a SPEC change: it would make
      // the table above wrong and lock out authenticators the product
      // promises to support.
      requireUserVerification: false,
    }).catch((error: unknown) => {
      this.logger.warn(
        `passkey registration verification failed: ${error instanceof Error ? error.message : String(error)} ` +
          `(expected_origin=${env.WEBAUTHN_ORIGIN} expected_rp_id=${env.WEBAUTHN_RP_ID})`,
      );
      return { verified: false as const, registrationInfo: undefined };
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException("passkey registration could not be verified");
    }

    const { credential } = verification.registrationInfo;
    const attachment = (input.response as { authenticatorAttachment?: string }).authenticatorAttachment ?? null;

    // Same explicit BEGIN/COMMIT/ROLLBACK shape as revokePasskey/
    // OauthService.unlink() — a crash between the insert and the status
    // promotion below can't leave a credential inserted with the user
    // still stuck 'unverified'.
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO user_credentials
           (id, user_id, kind, credential_id, public_key, sign_count, transports, authenticator_attachment, device_label)
         VALUES ($1, $2, 'passkey', $3, $4, $5, $6, $7, NULL)`,
        [
          uuidV7(),
          userId,
          Buffer.from(credential.id, "base64url"),
          Buffer.from(credential.publicKey),
          credential.counter,
          credential.transports ?? null,
          attachment,
        ],
      );

      // STORY-015 (approved fix, bundled here) — createRegistrationOptions
      // always creates the users row 'unverified'; a completed, verified
      // attestation is exactly the "confirmed the address is reachable and
      // controlled" signal that promotes it. Without this, every passkey
      // user would silently lose STORY-015's workspace-create right on
      // merge, since that gate reads users.status.
      await client.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'unverified'`, [userId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    this.logger.log(`passkey registered user_id=${userId}`);
    incrementCounter("nominara_identity_passkey_registered_total", { user_id: userId });

    return await this.sessions.createSession(userId);
  }

  private async finishAssertion(
    client: { query: Pool["query"] },
    expectedChallenge: string,
    input: PasskeyVerifyRequest,
    env: { WEBAUTHN_RP_ID: string; WEBAUTHN_ORIGIN: string },
  ): Promise<SessionTokens> {
    const rawId = (input.response as { rawId: string }).rawId;
    const credentialResult = await client.query<{
      id: string;
      user_id: string;
      credential_id: Buffer;
      public_key: Buffer;
      sign_count: string;
      transports: string[] | null;
    }>(
      `SELECT id, user_id, credential_id, public_key, sign_count, transports
       FROM user_credentials
       WHERE credential_id = $1 AND revoked_at IS NULL`,
      [Buffer.from(rawId, "base64url")],
    );
    if (credentialResult.rows.length === 0) {
      throw new BadRequestException("unknown or revoked credential");
    }
    const row = credentialResult.rows[0]!;

    // See finishRegistration's identical comment: the library throws on a
    // bad signature, wrong origin, or RP ID hash mismatch (test scenario
    // 7) — rewrap as the same uniform 400 rather than let its message
    // reach the client.
    const verification = await verifyAuthenticationResponse({
      response: input.response as unknown as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: env.WEBAUTHN_ORIGIN,
      expectedRPID: env.WEBAUTHN_RP_ID,
      // STORY-127 — same reasoning as finishRegistration: the assertion
      // options are also created with `userVerification: "preferred"`, so
      // demanding UV here would refuse sign-ins with credentials this
      // service itself registered.
      requireUserVerification: false,
      credential: {
        id: row.credential_id.toString("base64url"),
        publicKey: new Uint8Array(row.public_key),
        // Always 0 here — this neutralizes @simplewebauthn/server's OWN
        // internal counter-regression throw (it can only fire when
        // `counter <= credential.counter` and `credential.counter` is
        // pinned at 0), so nextCounter() below is the sole accept/reject
        // authority, per this story's "the sign-counter check is the one
        // piece of logic that is genuinely ours." Flagged for
        // second-engineer review: this deliberately overrides a
        // library-internal security check.
        counter: 0,
        ...transportsField(row.transports),
      },
    }).catch((error: unknown) => {
      // STORY-127 — same reasoning as finishRegistration's: uniform to the
      // client, diagnosable on the server.
      this.logger.warn(
        `passkey assertion verification failed: ${error instanceof Error ? error.message : String(error)} ` +
          `(expected_origin=${env.WEBAUTHN_ORIGIN} expected_rp_id=${env.WEBAUTHN_RP_ID})`,
      );
      return { verified: false as const, authenticationInfo: undefined };
    });

    if (!verification.verified || !verification.authenticationInfo) {
      throw new BadRequestException("passkey assertion could not be verified");
    }

    const stored = BigInt(row.sign_count);
    const reported = BigInt(verification.authenticationInfo.newCounter);
    // stored > 0n is equivalent to "this credential has ever reported a
    // nonzero counter": an accepted always-zero report never advances
    // `stored` past 0, and any accepted nonzero report irreversibly moves
    // it above 0 (nextCounter() never lets an accepted report reduce
    // `stored` back toward 0 once it has left 0).
    const decision = nextCounter(stored, reported, stored > 0n);
    if (decision === "clone-signal") {
      this.logger.warn(`passkey sign-counter clone signal credential_id=${row.id}`);
      incrementCounter("nominara_identity_passkey_clone_signal_total", { credential_id: row.id });
      throw new ForbiddenException("sign counter did not advance — possible cloned authenticator");
    }

    await client.query(`UPDATE user_credentials SET sign_count = $1, last_used_at = now() WHERE id = $2`, [
      reported.toString(),
      row.id,
    ]);

    return await this.sessions.createSession(row.user_id);
  }

  /**
   * STORY-117 — cursor-paginated (`NFR-API-03`). There is no documented cap
   * on passkeys per user and the reference's endpoint registry did not list
   * this route at all, so "it is naturally small" was an assumption rather
   * than a bound. `(created_at, id)` because a user can register two
   * credentials in the same transaction during a device-migration flow.
   *
   * `created_at_key` is Postgres's own text rendering, used ONLY as the
   * cursor key and stripped before the row reaches the response — the schema
   * is `.strict()`, and an extra member would fail it.
   */
  async listPasskeys(userId: string, pagination: PaginationRequest): Promise<Page<PasskeyListItem>> {
    const after = pagination.cursor === undefined ? undefined : decodeCursor(pagination.cursor, 2);
    const client = await this.pool.connect();
    try {
      const result = await client.query<PasskeyListItem & { created_at_key: string }>(
        `SELECT id, device_label, authenticator_attachment, transports,
                last_used_at, created_at, created_at::text AS created_at_key
         FROM user_credentials
         WHERE user_id = $1 AND kind = 'passkey' AND revoked_at IS NULL
           AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
         ORDER BY created_at ASC, id ASC
         LIMIT $4`,
        [userId, after?.[0] ?? null, after?.[1] ?? null, pagination.limit + 1],
      );
      return pageFrom(
        result.rows,
        pagination.limit,
        ({ created_at_key: _key, ...item }) => item,
        (row) => [row.created_at_key, row.id],
      );
    } finally {
      client.release();
    }
  }

  async renamePasskey(userId: string, credentialId: string, deviceLabel: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE user_credentials SET device_label = $1
         WHERE id = $2 AND user_id = $3 AND kind = 'passkey' AND revoked_at IS NULL
         RETURNING id`,
        [deviceLabel, credentialId, userId],
      );
      if (result.rows.length === 0) {
        throw new ForbiddenException("not the caller's passkey credential");
      }
    } finally {
      client.release();
    }
  }

  async revokePasskey(userId: string, credentialId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the user's WHOLE active-credential set before counting — not
      // just the target row. Under READ COMMITTED, locking only the target
      // row and then running an unlocked `count(*)` over the rest lets two
      // concurrent revokes of a user's last two distinct credentials each
      // see "1 remaining" (the other, not-yet-committed) and both succeed,
      // leaving zero (the exact self-lockout AC6 forbids). Locking the full
      // set here means a second concurrent call blocks on this SELECT until
      // the first commits, then re-evaluates `revoked_at IS NULL` against
      // the now-committed row (Postgres's EvalPlanQual re-check) and sees
      // one fewer credential — serializing count-then-revoke correctly.
      const active = await client.query<{ id: string }>(
        `SELECT id FROM user_credentials
         WHERE user_id = $1 AND revoked_at IS NULL
         FOR UPDATE`,
        [userId],
      );
      const target = active.rows.find((row) => row.id === credentialId);
      if (!target) {
        throw new ForbiddenException("not the caller's credential");
      }
      if (active.rows.length <= 1) {
        throw new ConflictException("cannot revoke the last remaining credential with no alternative auth method");
      }

      await client.query(`UPDATE user_credentials SET revoked_at = now() WHERE id = $1`, [credentialId]);
      await client.query("COMMIT");

      this.logger.log(`passkey revoked user_id=${userId} credential_id=${credentialId}`);
      incrementCounter("nominara_identity_passkey_revoked_total", { user_id: userId, credential_id: credentialId });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
