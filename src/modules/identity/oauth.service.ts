import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import type { KeyObject } from "node:crypto";
import type { Pool } from "pg";
import { API_VERSION_PREFIX } from "../../api/configure-app.js";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { importEd25519PublicKeyFromDer, verifyAccessToken, type KeyResolver } from "../../lib/auth/access-token.js";
import type { SessionStrongAuth } from "../../api/guards/auth.guard.js";
import { EmailNotVerifiedException, OauthFailedException } from "../../tenancy/errors.js";
import { hashBinding, newBindingValue, signState, verifyState } from "../../lib/auth/oauth-state.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { OAUTH_CLIENT, type OauthClient, type OauthIdentity } from "./ports/oauth-client.js";
import { ADDRESS_PROVED, applyFirstProof, requireFreshStrongAuth, requireProvedAccount } from "./account-proof.js";
import { SessionService, type SessionTokens } from "./session.service.js";
import type { OauthCallbackQuery, OauthCallbackResponse, OauthLinkItem, OauthProvider } from "./dto/index.js";
import type { PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { pageFrom, type Page } from "../../api/pagination/page.js";

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

interface OauthLinkRow {
  id: string;
  provider: string;
  last_used_at: Date | null;
  created_at: Date;
  created_at_key: string;
}

/**
 * ⚠ `.toISOString()`, NOT THE ROW AS IT COMES BACK. `pg` hands a `timestamptz`
 * over as a JS `Date`, and the published contract says `z.iso.datetime()` — a
 * string. Returning the row directly type-checks (the field is declared
 * `string`) and then fails its own schema at runtime, which is how a route
 * ships publishing a shape its contract does not describe. Same explicit
 * mapper `toMemberResponse` uses, and for the same reason.
 */
function toOauthLinkItem(row: OauthLinkRow): OauthLinkItem {
  return {
    provider: row.provider as OauthLinkItem["provider"],
    last_used_at: row.last_used_at === null ? null : row.last_used_at.toISOString(),
    created_at: row.created_at.toISOString(),
  };
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
  async start(
    provider: OauthProvider,
    purpose: "login" | "link",
    linkUserId: string | null,
    session?: SessionStrongAuth,
  ): Promise<OauthStartResult> {
    // STORY-173 — connecting a provider adds a credential, so it follows the
    // one rule for adding any credential: a proved address and a fresh step-up
    // (a stolen session cookie must not be able to attach the thief's own
    // Google account and keep the account after the cookie is revoked).
    if (purpose === "link") {
      requireFreshStrongAuth(linkUserId!, session, this.logger);
      await requireProvedAccount(this.pool, linkUserId!, this.logger);
    }
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
      const authenticated = await this.resolveAuthenticatedUser(accessCookieValue);
      if (authenticated === null || authenticated.userId !== row.link_user_id) {
        this.rejectCallback(httpRequestId, "link_session_mismatch");
      }
      // Re-checked here, not only at link/start: the person spent time at the
      // provider, and the window is five minutes.
      requireFreshStrongAuth(authenticated.userId, authenticated, this.logger);
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

    return {
      tokens: resolved.tokens,
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

  private async resolveAuthenticatedUser(
    accessCookieValue: string | undefined,
  ): Promise<{ userId: string; lastStrongAuthAt: Date | null } | null> {
    if (!accessCookieValue) {
      return null;
    }
    try {
      const claims = await verifyAccessToken(accessCookieValue, this.resolveKey);
      const sessionResult = await this.pool.query<{ revoked_at: Date | null; last_strong_auth_at: Date | null }>(
        "SELECT revoked_at, last_strong_auth_at FROM sessions WHERE id = $1",
        [claims.sid],
      );
      const session = sessionResult.rows[0];
      if (!session || session.revoked_at !== null) {
        return null;
      }
      return { userId: claims.sub, lastStrongAuthAt: session.last_strong_auth_at };
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
  ): Promise<{ tokens: SessionTokens; status: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        oauthCredentialLockKey(provider, identity.externalSubject),
      ]);

      // LOCK ORDER IS users, THEN user_credentials — the order the first-proof
      // writer (account-proof.ts applyFirstProof) takes them. The credential
      // is therefore PEEKED without a lock to learn whose it is, the users row
      // is locked, and only then is the credential row locked and re-read.
      // Locking the credential first would let a sign-in and a proof each hold
      // one lock and wait for the other.
      //
      // NOT filtered by revoked_at: ux_credentials_oauth is unique on
      // (provider, external_subject) regardless of revoked_at, so a
      // previously-unlinked credential for this subject is the SAME row a
      // fresh insert would collide with.
      const peek = await client.query<{ user_id: string }>(
        `SELECT user_id FROM user_credentials
         WHERE kind = 'oauth' AND provider = $1 AND external_subject = $2`,
        [provider, identity.externalSubject],
      );
      if (peek.rows[0]) {
        const ownerId = peek.rows[0].user_id;
        const account = await client.query<{ status: string; email_verified_at: Date | null; deleted_at: Date | null }>(
          `SELECT status, email_verified_at, deleted_at FROM users WHERE id = $1 FOR UPDATE`,
          [ownerId],
        );
        const credential = await client.query<{ id: string; revoked_at: Date | null; revoked_reason: string | null }>(
          `SELECT id, revoked_at, revoked_reason FROM user_credentials
           WHERE kind = 'oauth' AND provider = $1 AND external_subject = $2
           FOR UPDATE`,
          [provider, identity.externalSubject],
        );
        const owner = account.rows[0];
        const credentialRow = credential.rows[0];
        if (!owner || !credentialRow || owner.deleted_at !== null) {
          this.rejectCallback(httpRequestId, "account_not_active");
        }
        // An account whose address was never proved gets no session from a
        // credential, whoever put the credential there (STORY-173).
        if (owner.email_verified_at === null) {
          this.refuseUnverified(provider, "account_unproven");
        }
        if (owner.status !== "active") {
          this.rejectCallback(httpRequestId, "account_not_active");
        }
        if (credentialRow.revoked_at !== null) {
          // DURABLE: a credential the first proof of the address revoked is
          // never brought back by signing in with it again — that would undo
          // the revocation for anyone who kept the provider identity. Only a
          // credential its own owner unlinked (or a legacy row with no
          // reason) is reactivated.
          if (credentialRow.revoked_reason === ADDRESS_PROVED) {
            this.rejectCallback(httpRequestId, "credential_revoked_by_first_proof");
          }
          await client.query(`UPDATE user_credentials SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1`, [
            credentialRow.id,
          ]);
        }
        const tokens = await this.sessions.createSessionOn(client, ownerId);
        await client.query("COMMIT");
        return { tokens, status: owner.status };
      }

      if (identity.email === null) {
        this.rejectCallback(httpRequestId, "missing_email");
      }

      // STORY-173 (owner decision, 2026-10-05: "refuse it") — an address the
      // provider did NOT verify binds no credential, creates no account and
      // mints no session. It used to create an `unverified` account with the
      // credential attached, which is how someone could plant a working
      // sign-in on an address before its owner arrived. The refusal depends
      // only on what the provider said, never on whether an account exists, so
      // it is not an enumeration oracle.
      if (!identity.emailVerified) {
        this.refuseUnverified(provider, "provider_email_unverified");
      }

      // Locks any existing row at this email so a concurrent second
      // callback for the same address cannot also decide "no owner" and
      // double-insert.
      const emailOwner = await client.query<{ id: string; status: string; email_verified_at: Date | null }>(
        `SELECT id, status, email_verified_at FROM users WHERE email = $1 AND deleted_at IS NULL FOR UPDATE`,
        [identity.email],
      );
      const existingOwner = emailOwner.rows[0];

      let userId: string;
      if (existingOwner === undefined) {
        userId = uuidV7();
        // The provider verified the address -> active + email_verified_at now().
        await client.query(`INSERT INTO users (id, email, status, email_verified_at) VALUES ($1, $2, 'active', now())`, [
          userId,
          identity.email,
        ]);
      } else if (
        existingOwner.email_verified_at === null &&
        (existingOwner.status === "unverified" || existingOwner.status === "active")
      ) {
        // STORY-173 (owner decision "claim it + clean up") — a row nobody has
        // proved (an address squatted by an anonymous code request, or one
        // left by the pre-fix registration) is claimed by the provider's
        // verified assertion, as the FIRST PROOF: everything that predates it
        // is revoked durably, then this credential and session are bound — all
        // in this transaction. A PROVED row is never claimed: that would be
        // auto-linking by email, which STORY-015 forbids (email_collision).
        userId = existingOwner.id;
        await applyFirstProof(client, userId, this.logger);
        incrementCounter("nominara_identity_oauth_unproved_row_claimed_total", { provider });
      } else {
        this.logger.warn(`oauth sign-in refused: email already registered to a different account provider=${provider}`);
        incrementCounter("nominara_identity_oauth_email_collision_total", { provider });
        this.rejectCallback(httpRequestId, "email_collision");
      }

      await client.query(
        `INSERT INTO user_credentials (id, user_id, kind, provider, external_subject) VALUES ($1, $2, 'oauth', $3, $4)`,
        [uuidV7(), userId, provider, identity.externalSubject],
      );
      const tokens = await this.sessions.createSessionOn(client, userId);
      await client.query("COMMIT");
      return { tokens, status: "active" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof HttpException) {
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
   * The honest, distinct refusal for an address nobody has proved: `403
   * forbidden`, `details.reason = email_not_verified` — the client can show
   * "sign in with an email code first, then connect <provider> from settings".
   * Counted by reason; the provider name is the only variable and is not
   * sensitive. Never carries the address.
   */
  private refuseUnverified(provider: OauthProvider, reason: "provider_email_unverified" | "account_unproven"): never {
    this.logger.warn(`oauth sign-in refused reason=${reason} provider=${provider}`);
    incrementCounter("nominara_identity_oauth_refused_total", { reason, provider });
    throw new EmailNotVerifiedException(
      `${provider} did not verify this email address; sign in with an email code first, then connect ${provider} from settings`,
    );
  }

  /**
   * Links a provider identity onto `userId` — the already-authenticated
   * caller, re-verified by callback() just before this runs, with a fresh
   * step-up (checked at link/start and again in callback()). STORY-173: the
   * account's address must be proved, re-read under lock in THIS transaction.
   * The same subject-as-join-key rule applies: a subject already linked to
   * a DIFFERENT account is a conflict, never silently re-pointed — whether
   * that other account's row is active OR revoked. Already linked to THIS
   * same account is idempotent. A revoked row for THIS same account is
   * reactivated, whatever revoked it: here the caller is a proved, stepped-up
   * owner who has just authenticated at the provider on purpose, which is the
   * one thing a sign-in alone is not.
   */
  private async linkCredential(
    userId: string,
    provider: OauthProvider,
    identity: OauthIdentity,
    httpRequestId: string,
  ): Promise<{ tokens: SessionTokens; status: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        oauthCredentialLockKey(provider, identity.externalSubject),
      ]);
      await requireProvedAccount(client, userId, this.logger);
      const existing = await client.query<{ id: string; user_id: string; revoked_at: Date | null }>(
        `SELECT id, user_id, revoked_at FROM user_credentials
         WHERE kind = 'oauth' AND provider = $1 AND external_subject = $2
         FOR UPDATE`,
        [provider, identity.externalSubject],
      );
      const credentialRow = existing.rows[0];
      if (credentialRow && credentialRow.user_id !== userId) {
        this.logger.warn(`oauth link refused: credential already linked to a different account provider=${provider}`);
        incrementCounter("nominara_identity_oauth_link_conflict_total", { provider });
        this.rejectCallback(httpRequestId, "link_conflict");
      }
      if (credentialRow) {
        if (credentialRow.revoked_at !== null) {
          await client.query(`UPDATE user_credentials SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1`, [
            credentialRow.id,
          ]);
        }
      } else {
        await client.query(
          `INSERT INTO user_credentials (id, user_id, kind, provider, external_subject) VALUES ($1, $2, 'oauth', $3, $4)`,
          [uuidV7(), userId, provider, identity.externalSubject],
        );
      }
      const tokens = await this.sessions.createSessionOn(client, userId);
      await client.query("COMMIT");
      return { tokens, status: "active" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof HttpException) {
        throw error;
      }
      // Belt-and-suspenders: see resolveOrCreateForLogin.
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
   * STORY-096 slice C — `GET /me/oauth`, the providers this caller has linked.
   *
   * ⚠ REVOKED CREDENTIALS ARE NOT LINKS. `unlink` revokes by setting
   * `revoked_at` rather than deleting the row, so a history of every provider
   * the caller has ever connected sits in this table. Reading it without the
   * filter would offer "Disconnect" for an account they already disconnected,
   * and `unlink` would answer 403.
   *
   * ⚠ `kind = 'oauth'` ONLY. `ux_credentials_oauth` also covers `saml` and
   * `oidc`, which are enterprise SSO bindings rather than personal connected
   * accounts — they are not something an individual connects or disconnects
   * here, and listing them under "Connected accounts" would offer a Disconnect
   * for their organisation's sign-in.
   *
   * ⚠ SCOPED BY `user_id`, AND NOTHING ELSE. A credential belongs to a PERSON,
   * not to a workspace, so the route carries `@SkipTenantContext()` for the
   * same reason `GET /me/passkeys` does.
   *
   * ⚠ AND NO RLS POLICY BACKS THAT UP — I claimed ISO-18..22 covered this and
   * it does not. `ACTOR_SELF_SCOPED_TABLES` is `["workspaces",
   * "workspace_members"]`; `user_credentials` has `relrowsecurity = false` and
   * zero policies. The two real controls are:
   *
   *   1. THE GRANT. Migration 0005 revokes the table from `nominara_worker`,
   *      `nominara_report` and `nominara_portal` outright, leaving only
   *      `nominara_app`. Its own comment says why this is stronger than a
   *      policy: "RLS would be the weaker control here because it would imply
   *      the table was reachable and merely filtered."
   *   2. THE PREDICATE BELOW, which is hand-written and therefore deletable.
   *
   * So deleting `AND user_id = $1` fails no isolation assertion anywhere —
   * only `identity-oauth-links.spec.ts`'s cross-user test stands between that
   * and a cross-account credential listing. Said plainly here because the
   * route-permission EXEMPT list carries a written reason, and a reason that
   * names a safety net that does not exist is worse than no reason at all.
   */
  async listLinks(userId: string, pagination: PaginationRequest): Promise<Page<OauthLinkItem>> {
    const after = pagination.cursor === undefined ? undefined : decodeCursor(pagination.cursor, 2);
    const result = await this.pool.query<OauthLinkRow>(
      `SELECT id, provider, last_used_at, created_at, created_at::text AS created_at_key
         FROM user_credentials
        WHERE user_id = $1 AND kind = 'oauth' AND revoked_at IS NULL AND provider IS NOT NULL
          AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
        ORDER BY created_at ASC, id ASC
        LIMIT $4`,
      [userId, after?.[0] ?? null, after?.[1] ?? null, pagination.limit + 1],
    );
    return pageFrom(result.rows, pagination.limit, toOauthLinkItem, (row) => [row.created_at_key, row.id]);
  }

  /**
   * DELETE /me/oauth/:provider. Mirrors IdentityService.revokePasskey's
   * exact pattern (identity.service.ts): locks the user's WHOLE active
   * credential set before counting, not just the target row — see that
   * method's comment for why locking only the target row races two
   * concurrent last-two-credential revokes into a double self-lockout.
   */
  async unlink(userId: string, provider: OauthProvider, session?: SessionStrongAuth): Promise<void> {
    // STORY-173 — removing a credential is as sensitive as adding one: a
    // stolen session must not strip the owner's other methods to lock them out.
    requireFreshStrongAuth(userId, session, this.logger);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // ⚠ ORDERED, BECAUSE `find` BELOW TAKES THE FIRST MATCH. One person can
      // hold two accounts on the same provider — `ux_credentials_oauth` is
      // unique on (provider, external_subject), not (user_id, provider) — and
      // this route is keyed on the PROVIDER, so with two Google accounts it
      // revokes one of them. Unordered, which of the two was undefined: the
      // same click could take the work account on one call and the personal
      // one on the next. Oldest-first at least makes it a rule the screen can
      // state. Addressing a SPECIFIC link needs an id-keyed route, which is
      // a contract change and is filed rather than smuggled in here.
      const active = await client.query<{ id: string; kind: string; provider: string | null }>(
        `SELECT id, kind, provider FROM user_credentials
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY created_at ASC, id ASC
          FOR UPDATE`,
        [userId],
      );
      const target = active.rows.find((row) => row.kind === "oauth" && row.provider === provider);
      if (!target) {
        throw new ForbiddenException("not the caller's credential");
      }
      if (active.rows.length <= 1) {
        throw new ConflictException("cannot revoke the last remaining credential with no alternative auth method");
      }

      await client.query(`UPDATE user_credentials SET revoked_at = now(), revoked_reason = 'user' WHERE id = $1`, [target.id]);
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
