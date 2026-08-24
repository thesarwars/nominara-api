import { ConflictException, ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import type { KeyObject } from "node:crypto";
import type { Pool } from "pg";
import { API_VERSION_PREFIX } from "../../api/configure-app.js";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { importEd25519PublicKeyFromDer, verifyAccessToken, type KeyResolver } from "../../lib/auth/access-token.js";
import { OauthFailedException } from "../../tenancy/errors.js";
import { hashBinding, newBindingValue, signState, verifyState } from "../../lib/auth/oauth-state.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { OAUTH_CLIENT, type OauthClient, type OauthIdentity } from "./ports/oauth-client.js";
import { SessionService, type SessionTokens } from "./session.service.js";
import type { OauthCallbackQuery, OauthCallbackResponse, OauthProvider } from "./dto/index.js";

// STORY-015 — dangerous area: state-signing/session-binding and the
// provider-subject-as-join-key account-resolution logic (second-engineer
// review required, alongside src/lib/auth/oauth-state.ts).
//
// PKCE verifier/challenge generation goes through OAUTH_CLIENT.generatePkce()
// (Implementation decisions: "No ... hand-rolled PKCE/JOSE") — OauthService
// never imports `openid-client` directly, same port-plus-adapter precedent
// as DEK_PROVISIONER. code_verifier must still be persisted here
// (oauth_authorization_requests.code_verifier) before the redirect exists;
// the OAUTH_CLIENT port's authorizationUrl() takes an ALREADY-computed
// challenge and never derives one itself.

const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
export const OAUTH_BINDING_COOKIE_MAX_AGE_SECONDS = AUTHORIZATION_REQUEST_TTL_MS / 1000;

// `SELECT ... FOR UPDATE` on (provider, external_subject) locks nothing when
// zero rows match, so two concurrent FIRST-TIME completions for the same
// brand-new subject both see zero rows and both attempt the insert — the
// loser hits ux_credentials_oauth's unique violation. This transaction-scoped
// advisory lock (same idiom as AuditChainService.append) closes that gap: it
// serializes every resolution attempt for a given (provider, subject) pair
// globally, auto-releasing at COMMIT/ROLLBACK, so the second transaction
// blocks until the first commits and then its own FOR UPDATE lookup sees the
// now-committed row.
function oauthCredentialLockKey(provider: OauthProvider, externalSubject: string): string {
  return `oauth_credential:${provider}:${externalSubject}`;
}

interface OauthAuthorizationRequestRow {
  readonly id: string;
  readonly provider: OauthProvider;
  readonly purpose: "login" | "link";
  readonly link_user_id: string | null;
  readonly code_verifier: string;
  readonly binding_hash: Buffer;
  readonly redirect_uri: string;
}

export interface OauthStartResult {
  readonly authorizationUrl: string;
  readonly stateExpiresAt: Date;
  readonly bindingValue: string;
}

export interface OauthCallbackResult {
  readonly tokens: SessionTokens;
  readonly body: OauthCallbackResponse;
}

@Injectable()
export class OauthService {
  private readonly logger = new Logger(OauthService.name);
  private readonly resolveKey: KeyResolver;
  private readonly stateSecret: string;
  private readonly redirectBaseUrl: string;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(OAUTH_CLIENT) private readonly client: OauthClient,
    private readonly sessions: SessionService,
  ) {
    const env = loadEnv();
    this.stateSecret = env.OAUTH_STATE_SECRET;
    this.redirectBaseUrl = env.OAUTH_REDIRECT_BASE_URL;

    // Same kid-aware key-resolution shape as AuthGuard (src/api/guards/
    // auth.guard.ts) — duplicated rather than shared, since AuthGuard's own
    // copy is itself inline in its constructor, not an exported helper.
    const keysByKid = new Map<string, KeyObject>();
    keysByKid.set(env.AUTH_TOKEN_ED25519_KID, importEd25519PublicKeyFromDer(env.AUTH_TOKEN_ED25519_PUBLIC_KEY));
    if (env.AUTH_TOKEN_ED25519_PREVIOUS_KID && env.AUTH_TOKEN_ED25519_PREVIOUS_PUBLIC_KEY) {
      keysByKid.set(
        env.AUTH_TOKEN_ED25519_PREVIOUS_KID,
        importEd25519PublicKeyFromDer(env.AUTH_TOKEN_ED25519_PREVIOUS_PUBLIC_KEY),
      );
    }
    this.resolveKey = (kid) => {
      const key = kid === undefined ? undefined : keysByKid.get(kid);
      if (!key) {
        throw new Error(`unrecognized signing key kid: ${String(kid)}`);
      }
      return key;
    };
  }

  // The path MUST be derived from API_VERSION_PREFIX — the same constant
  // configure-app.ts's setGlobalPrefix() and test/support/api-url.ts's
  // apiUrl() read — never a second hardcoded copy of the route path.
  //
  // A hardcoded "/auth/oauth/:provider/callback" here is what broke when
  // decision D1's global /v1 prefix landed: this value is handed to the
  // provider as `redirect_uri` AND persisted to
  // oauth_authorization_requests.redirect_uri, so the provider bounced the
  // browser to a route the API no longer served, and the token exchange —
  // which must present the identical redirect_uri — went with it. The whole
  // 1400-line OAuth suite stayed green because every other test reaches the
  // callback through the router path directly, while the adapter rebuilds
  // its `currentUrl` from the STORED redirect_uri, comparing it to itself.
  //
  // OPERATIONAL NOTE: this changes the redirect_uri sent to Google, GitHub
  // and Microsoft, so the registered redirect URIs in each provider's
  // console must be updated to the /v1-prefixed path before deploy.
  private redirectUriFor(provider: OauthProvider): string {
    return new URL(`/${API_VERSION_PREFIX}/auth/oauth/${provider}/callback`, this.redirectBaseUrl).toString();
  }

  /** POST /auth/oauth/:provider/start and /link/start — purpose='link' carries the authenticated caller's own id, never anyone else's. */
  async start(provider: OauthProvider, purpose: "login" | "link", linkUserId: string | null): Promise<OauthStartResult> {
    const id = uuidV7();
    const { verifier: codeVerifier, challenge: codeChallenge } = await this.client.generatePkce();
    const bindingValue = newBindingValue();
    const bindingHash = hashBinding(bindingValue);
    const expiresAt = new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_MS);
    const redirectUri = this.redirectUriFor(provider);

    await this.pool.query(
      `INSERT INTO oauth_authorization_requests
         (id, provider, purpose, link_user_id, code_verifier, binding_hash, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, provider, purpose, linkUserId, codeVerifier, bindingHash, redirectUri, expiresAt],
    );

    const state = signState(id, this.stateSecret);
    const authorizationUrl = this.client.authorizationUrl({ provider, redirectUri, codeChallenge, state });

    return { authorizationUrl, stateExpiresAt: expiresAt, bindingValue };
  }

  /**
   * GET /auth/oauth/:provider/callback. Order is security-critical:
   * 1. verifyState (HMAC) — reject before any DB round-trip.
   * 2. Atomic single-use claim (mirrors webauthn_challenges' UPDATE ...
   *    RETURNING idiom) — zero rows is refused identically whether the
   *    state was unknown, already used, or expired.
   * 3. Constant-time binding-hash comparison — deliberately AFTER the
   *    claim, so a wrong-binding attempt burns the state rather than
   *    leaving it replayable.
   * 4. purpose/link_user_id are read ONLY from the claimed row.
   * 5. Token exchange via the OAUTH_CLIENT port, using the row's
   *    server-held code_verifier/redirect_uri — never request input.
   * 6. Resolve-or-create (login) or link, then mint a session.
   */
  async callback(
    provider: OauthProvider,
    query: OauthCallbackQuery,
    bindingCookieValue: string | undefined,
    accessCookieValue: string | undefined,
    httpRequestId: string,
  ): Promise<OauthCallbackResult> {
    const authorizationRequestId = verifyState(query.state, this.stateSecret);
    if (authorizationRequestId === null) {
      this.rejectCallback(httpRequestId, "invalid_state");
    }

    const claimResult = await this.pool.query<OauthAuthorizationRequestRow>(
      `UPDATE oauth_authorization_requests SET consumed_at = now()
       WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
       RETURNING id, provider, purpose, link_user_id, code_verifier, binding_hash, redirect_uri`,
      [authorizationRequestId],
    );
    const row = claimResult.rows[0];
    if (!row) {
      this.rejectCallback(httpRequestId, "unknown_used_or_expired_state");
    }

    if (row.provider !== provider) {
      this.rejectCallback(httpRequestId, "provider_mismatch");
    }

    if (!this.bindingMatches(bindingCookieValue, row.binding_hash)) {
      this.rejectCallback(httpRequestId, "binding_mismatch");
    }

    // AC "A provider error returns a neutral message with the request
    // identifier, and never reflects the provider's raw error into the
    // response." The raw text is logged at warn (permitted — it never
    // reaches the thrown exception), never placed anywhere the response
    // body can pick it up.
    if (query.error !== undefined) {
      this.logger.warn(
        `oauth provider returned an error request_id=${httpRequestId} provider=${row.provider} error=${
          query.error
        } error_description=${query.error_description ?? ""}`,
      );
      incrementCounter("nominara_identity_oauth_provider_error_total", { provider: row.provider });
      this.rejectCallback(httpRequestId, "provider_error");
    }

    // A stolen state+code must not graft onto someone else's account: the
    // caller completing a link-purpose callback must STILL be authenticated
    // as the exact same user that started it (AC "Linking a provider ...
    // requires the user to already be authenticated — a callback alone
    // never links"). Read from the claimed row's link_user_id only, never
    // from any request parameter.
    if (row.purpose === "link") {
      const authenticatedUserId = await this.resolveAuthenticatedUserId(accessCookieValue);
      if (authenticatedUserId === null || authenticatedUserId !== row.link_user_id) {
        this.rejectCallback(httpRequestId, "link_session_mismatch");
      }
    }

    let identity: OauthIdentity;
    try {
      identity = await this.client.exchangeCode({
        provider: row.provider,
        code: query.code ?? "",
        codeVerifier: row.code_verifier,
        redirectUri: row.redirect_uri,
      });
    } catch (error) {
      this.logger.warn(
        `oauth token exchange failed request_id=${httpRequestId} provider=${row.provider} message=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.rejectCallback(httpRequestId, "exchange_failed");
    }

    const resolved =
      row.purpose === "link"
        ? await this.linkCredential(row.link_user_id!, row.provider, identity, httpRequestId)
        : await this.resolveOrCreateForLogin(identity, row.provider, httpRequestId);

    const tokens = await this.sessions.createSession(resolved.userId);

    return {
      tokens,
      body: {
        outcome: row.purpose === "link" ? "linked" : "signed_in",
        user_status: resolved.status as OauthCallbackResponse["user_status"],
      },
    };
  }

  private bindingMatches(bindingCookieValue: string | undefined, storedHash: Buffer): boolean {
    if (bindingCookieValue === undefined) {
      return false;
    }
    const providedHash = hashBinding(bindingCookieValue);
    if (providedHash.length !== storedHash.length) {
      return false;
    }
    return providedHash.equals(storedHash);
  }

  private async resolveAuthenticatedUserId(accessCookieValue: string | undefined): Promise<string | null> {
    if (!accessCookieValue) {
      return null;
    }
    try {
      const claims = await verifyAccessToken(accessCookieValue, this.resolveKey);
      const sessionResult = await this.pool.query<{ revoked_at: Date | null }>(
        "SELECT revoked_at FROM sessions WHERE id = $1",
        [claims.sid],
      );
      const session = sessionResult.rows[0];
      if (!session || session.revoked_at !== null) {
        return null;
      }
      return claims.sub;
    } catch {
      return null;
    }
  }

  /**
   * Every callback rejection funnels through here — same fixed neutral
   * message and shape ({ code: "oauth_failed", details: { request_id } })
   * regardless of `reason`, which never leaves this process (server-side
   * warn log + metric only). This is what keeps scenarios 2/3/4/7/9 (replay,
   * wrong binding, omitted verifier, email/subject conflict, provider
   * error) indistinguishable from one another to the caller.
   */
  private rejectCallback(httpRequestId: string, reason: string): never {
    this.logger.warn(`oauth callback rejected reason=${reason} request_id=${httpRequestId}`);
    incrementCounter("nominara_identity_oauth_callback_failed_total", { reason });
    throw new OauthFailedException(httpRequestId);
  }

  /**
   * The provider's subject identifier is the join key — never the email
   * (AC/Technical Notes). A subject already on file resolves to that same
   * account, full stop: the email on file is NEVER overwritten from a
   * later sign-in, even when the provider now reports a different address
   * — joining on email would let a changed or reissued provider address
   * hijack a different account. A subject not on file, but whose reported
   * email already belongs to a DIFFERENT account, is a uniform neutral
   * failure — never an auto-link — logged at warn with a metric so the
   * caller never learns which of the two failure cases applied.
   */
  private async resolveOrCreateForLogin(
    identity: OauthIdentity,
    provider: OauthProvider,
    httpRequestId: string,
  ): Promise<{ userId: string; status: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        oauthCredentialLockKey(provider, identity.externalSubject),
      ]);
      // NOT filtered by revoked_at: ux_credentials_oauth is unique on
      // (provider, external_subject) regardless of revoked_at, so a
      // previously-unlinked credential for this subject is the SAME row a
      // fresh insert would collide with — it must be found and reactivated,
      // never blindly inserted around. FOR UPDATE closes the same race the
      // create path already closes on the email row below.
      const existing = await client.query<{ id: string; user_id: string; revoked_at: Date | null }>(
        `SELECT id, user_id, revoked_at FROM user_credentials
         WHERE kind = 'oauth' AND provider = $1 AND external_subject = $2
         FOR UPDATE`,
        [provider, identity.externalSubject],
      );
      const credentialRow = existing.rows[0];
      if (credentialRow) {
        if (credentialRow.revoked_at !== null) {
          await client.query(`UPDATE user_credentials SET revoked_at = NULL WHERE id = $1`, [credentialRow.id]);
        }
        const statusResult = await client.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [
          credentialRow.user_id,
        ]);
        await client.query("COMMIT");
        return { userId: credentialRow.user_id, status: statusResult.rows[0]!.status };
      }

      if (identity.email === null) {
        await client.query("ROLLBACK");
        this.rejectCallback(httpRequestId, "missing_email");
      }

      // Locks any existing row at this email so a concurrent second
      // callback for the same address cannot also decide "no owner" and
      // double-insert.
      const emailOwner = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL FOR UPDATE`,
        [identity.email],
      );
      if (emailOwner.rows[0]) {
        await client.query("ROLLBACK");
        this.logger.warn(`oauth sign-in refused: email already registered to a different account provider=${provider}`);
        incrementCounter("nominara_identity_oauth_email_collision_total", { provider });
        this.rejectCallback(httpRequestId, "email_collision");
      }

      const userId = uuidV7();
      // AC "An email the provider did not verify creates the account in an
      // unverified state with no workspace-create right" — a provider
      // asserting an address it never confirmed is an account-takeover
      // vector for any address at that domain, so this fails closed:
      // verified -> active + email_verified_at now(); anything else ->
      // unverified + email_verified_at NULL (workspaces.service.ts's
      // create() gate reads this status).
      const status = identity.emailVerified ? "active" : "unverified";
      await client.query(`INSERT INTO users (id, email, status, email_verified_at) VALUES ($1, $2, $3, $4)`, [
        userId,
        identity.email,
        status,
        identity.emailVerified ? new Date() : null,
      ]);
      await client.query(
        `INSERT INTO user_credentials (id, user_id, kind, provider, external_subject) VALUES ($1, $2, 'oauth', $3, $4)`,
        [uuidV7(), userId, provider, identity.externalSubject],
      );
      await client.query("COMMIT");
      return { userId, status };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof OauthFailedException) {
        throw error;
      }
      // Belt-and-suspenders: should never happen once the advisory lock
      // above serializes resolution attempts, but an unhandled DB error
      // here must still funnel through rejectCallback's neutral shape
      // rather than rethrow raw and become an untyped 500 via ProblemFilter.
      this.logger.warn(
        `oauth credential resolution failed unexpectedly request_id=${httpRequestId} message=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.rejectCallback(httpRequestId, "credential_resolution_failed");
    } finally {
      client.release();
    }
  }

  /**
   * Links a provider identity onto `userId` — the already-authenticated
   * caller, re-verified by callback() just before this runs. The same
   * subject-as-join-key rule applies here too: a subject already linked to
   * a DIFFERENT account is a conflict, never silently re-pointed (this
   * would let a stolen state+code steal a credential FROM one account and
   * attach it to another) — this holds whether that other account's row is
   * active OR revoked (ux_credentials_oauth is unique on (provider,
   * external_subject) regardless of revoked_at). Already linked to THIS
   * same account is idempotent, not an error; a revoked row for THIS same
   * account is reactivated rather than blindly re-inserted.
   */
  private async linkCredential(
    userId: string,
    provider: OauthProvider,
    identity: OauthIdentity,
    httpRequestId: string,
  ): Promise<{ userId: string; status: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        oauthCredentialLockKey(provider, identity.externalSubject),
      ]);
      const existing = await client.query<{ id: string; user_id: string; revoked_at: Date | null }>(
        `SELECT id, user_id, revoked_at FROM user_credentials
         WHERE kind = 'oauth' AND provider = $1 AND external_subject = $2
         FOR UPDATE`,
        [provider, identity.externalSubject],
      );
      const credentialRow = existing.rows[0];
      if (credentialRow && credentialRow.user_id !== userId) {
        await client.query("ROLLBACK");
        this.logger.warn(`oauth link refused: credential already linked to a different account provider=${provider}`);
        incrementCounter("nominara_identity_oauth_link_conflict_total", { provider });
        this.rejectCallback(httpRequestId, "link_conflict");
      }
      if (credentialRow) {
        if (credentialRow.revoked_at !== null) {
          await client.query(`UPDATE user_credentials SET revoked_at = NULL WHERE id = $1`, [credentialRow.id]);
        }
      } else {
        await client.query(
          `INSERT INTO user_credentials (id, user_id, kind, provider, external_subject) VALUES ($1, $2, 'oauth', $3, $4)`,
          [uuidV7(), userId, provider, identity.externalSubject],
        );
      }
      const statusResult = await client.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [userId]);
      await client.query("COMMIT");
      return { userId, status: statusResult.rows[0]!.status };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof OauthFailedException) {
        throw error;
      }
      // Belt-and-suspenders: should never happen once the advisory lock
      // above serializes resolution attempts, but an unhandled DB error
      // here must still funnel through rejectCallback's neutral shape
      // rather than rethrow raw and become an untyped 500 via ProblemFilter.
      this.logger.warn(
        `oauth credential resolution failed unexpectedly request_id=${httpRequestId} message=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.rejectCallback(httpRequestId, "credential_resolution_failed");
    } finally {
      client.release();
    }
  }

  /**
   * DELETE /me/oauth/:provider. Mirrors IdentityService.revokePasskey's
   * exact pattern (identity.service.ts): locks the user's WHOLE active
   * credential set before counting, not just the target row — see that
   * method's comment for why locking only the target row races two
   * concurrent last-two-credential revokes into a double self-lockout.
   */
  async unlink(userId: string, provider: OauthProvider): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const active = await client.query<{ id: string; kind: string; provider: string | null }>(
        `SELECT id, kind, provider FROM user_credentials WHERE user_id = $1 AND revoked_at IS NULL FOR UPDATE`,
        [userId],
      );
      const target = active.rows.find((row) => row.kind === "oauth" && row.provider === provider);
      if (!target) {
        throw new ForbiddenException("not the caller's credential");
      }
      if (active.rows.length <= 1) {
        throw new ConflictException("cannot revoke the last remaining credential with no alternative auth method");
      }

      await client.query(`UPDATE user_credentials SET revoked_at = now() WHERE id = $1`, [target.id]);
      await client.query("COMMIT");

      this.logger.log(`oauth credential unlinked user_id=${userId} provider=${provider}`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
