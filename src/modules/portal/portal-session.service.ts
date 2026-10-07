import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import type { PortalCookiePayload, PortalSessionRequest, PortalSessionResponse } from "../../../contracts/portal/index.js";
import { DegradedError, RateLimitedError, TokenRevokedError, UnauthenticatedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { verify as argon2idVerify, verifyDecoy } from "../../lib/crypto/argon2id.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { gateRefusal, hashShareSecret, PASSWORD_LOCK_MS, ShareTokensService, type GateRow } from "../agency/share-tokens.service.js";
import { loadPortalCookieKey, PORTAL_SESSION_TTL_SECONDS, sealPortalCookie } from "./portal-cookie.js";

export interface RequestFacts {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface MintedPortalSession {
  readonly response: PortalSessionResponse;
  readonly cookie: { readonly value: string; readonly maxAgeSeconds: number };
}

const MAX_USER_AGENT_LENGTH = 512;

type AttemptOutcome =
  | { readonly kind: "minted" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "locked"; readonly until: Date }
  | { readonly kind: "wrong_password" }
  | { readonly kind: "email_required" }
  | { readonly kind: "domain_refused" }
  | { readonly kind: "code_flow_unavailable" };

// STORY-098 part B — POST /portal/session, integrations-and-sharing.md §3 session flow:
//   1. hash lookup; reject if revoked, expired, or view_count >= max_views        (ONE neutral refusal)
//   2. Argon2id verify, constant-time; 5 failures per token -> 15-minute lock
//   3. allowed_email_domains set -> require the email, verify the domain, send a code
//   4. mint the scoped cookie
//   5. INSERT a view row; increment view_count
//
// The route is public and tenant-less: the workspace is the thing step 1 discovers, through the one SECURITY DEFINER
// lookup (migration 0080). Everything after it runs in a tenant context for THAT workspace on the app pool, so the
// lock, the view row and the counter are written under RLS like any other tenant write.
//
// What does NOT happen here: no network call (KAD-06). The domain-allow-list code step needs an email transport, which
// does not exist yet — see `requireEmailCode`.
@Injectable()
export class PortalSessionService {
  private readonly logger = new Logger(PortalSessionService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly shareTokens: ShareTokensService,
  ) {}

  async mint(body: PortalSessionRequest, facts: RequestFacts): Promise<MintedPortalSession> {
    const started = performance.now();
    let outcome = "error";
    try {
      const minted = await this.run(body, facts);
      outcome = "minted";
      return minted;
    } catch (error) {
      outcome = error instanceof Error ? error.name : "error";
      throw error;
    } finally {
      // The span: one line per mint attempt, duration and outcome, no secret, no address, no workspace name.
      this.logger.log(`span=portal.session.mint outcome=${outcome} duration_ms=${String(Math.round(performance.now() - started))}`);
    }
  }

  private async run(body: PortalSessionRequest, facts: RequestFacts): Promise<MintedPortalSession> {
    // Fail closed before touching a token: an unconfigured portal mints nothing.
    const keyMaterial = loadEnv().PORTAL_COOKIE_KEY;
    if (keyMaterial === undefined) throw new DegradedError({ message: "the portal is not available" });
    const key = loadPortalCookieKey(keyMaterial);
    const now = new Date();

    const row = await this.shareTokens.findForGate(this.pool, hashShareSecret(body.secret));
    if (row === null) {
      // Constant-time in structure: the unknown path pays one full-cost Argon2id verify, so it cannot be told apart
      // from a wrong password by its duration, and it answers identically.
      await verifyDecoy(body.password ?? "");
      return this.refuse("unknown", new UnauthenticatedError({ message: "the link or password is not valid" }));
    }

    // Everything from here is ONE transaction in the token's workspace, opened with the row lock held: attempts on a
    // token queue behind it, so the 5-failure limit holds under parallel guessing, the cap and the lock are evaluated
    // against the row as it is NOW (not as the lookup saw it), and the failure count commits even though the visitor
    // gets an error — which is why the outcome is RETURNED here and thrown after the commit, never thrown inside it.
    const outcome = await this.inTenant(row.workspaceId, () => this.attempt(row.id, body, facts));

    switch (outcome.kind) {
      case "refused":
        return this.refuse(outcome.reason, new TokenRevokedError({ message: "this link is no longer available" }));
      case "locked":
        this.count("locked");
        throw new RateLimitedError({ message: "too many attempts; try again later", details: { retry_after_ms: this.retryAfterMs(outcome.until) } });
      case "wrong_password":
        this.count("wrong_password");
        throw new UnauthenticatedError({ message: "the link or password is not valid" });
      case "email_required":
        throw new ValidationFailedError({
          message: "an email address is required for this link",
          details: { issues: [{ path: ["email"], message: "required for this link" }] },
        });
      case "domain_refused":
        this.count("domain_refused");
        throw new UnauthenticatedError({ message: "the link or password is not valid" });
      case "code_flow_unavailable":
        // Scenario 7, the deferred half: the DOMAIN check passed, but sending the code needs an email transport that
        // does not exist yet. Fails CLOSED (nothing written, no cookie) rather than minting for an unverified address.
        this.count("code_flow_unavailable");
        throw new DegradedError({ message: "email verification is not available yet" });
      case "minted":
        break;
    }

    const sealed = await sealPortalCookie(
      {
        token_id: row.id,
        workspace_id: row.workspaceId,
        scope_project_ids: [...row.scopeProjectIds],
        scope_tabs: row.scopeTabs as PortalCookiePayload["scope_tabs"],
        theme_id: row.themeId,
      },
      key,
      now,
    );
    this.count("minted");
    this.logger.log(`portal session minted workspace_id=${row.workspaceId} share_token_id=${row.id}`);
    return {
      response: { expires_at: sealed.expiresAt.toISOString() },
      cookie: { value: sealed.value, maxAgeSeconds: PORTAL_SESSION_TTL_SECONDS },
    };
  }

  /** Steps 1-3 and 5 against the locked row. Returns what happened; throws nothing the visitor would see. */
  private async attempt(id: string, body: PortalSessionRequest, facts: RequestFacts): Promise<AttemptOutcome> {
    const row = await this.shareTokens.lockForAttempt(id);
    if (row === null) return { kind: "refused", reason: "raced" };
    const now = new Date();

    const refusal = gateRefusal(row, now);
    if (refusal !== null) return { kind: "refused", reason: refusal };

    // Refused BEFORE any password is checked: a locked token must not be a password oracle.
    if (row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime()) return { kind: "locked", until: row.lockedUntil };

    if (row.passwordRequired && !(await this.passwordIsRight(row, body.password))) {
      const { lockedUntil } = await this.shareTokens.recordFailedPassword(row.id);
      return lockedUntil !== null ? { kind: "locked", until: lockedUntil } : { kind: "wrong_password" };
    }

    if (row.allowedEmailDomains.length > 0) {
      // Scenario 7 — AFTER the password, so it is never an oracle for which links carry a domain list.
      if (body.email === undefined) return { kind: "email_required" };
      const domain = body.email.slice(body.email.lastIndexOf("@") + 1).toLowerCase();
      if (!row.allowedEmailDomains.some((d) => d.toLowerCase() === domain)) return { kind: "domain_refused" };
      return { kind: "code_flow_unavailable" };
    }

    const consumed = await this.shareTokens.consumeView(row.id, {
      ip: facts.ip,
      userAgent: facts.userAgent === null ? null : facts.userAgent.slice(0, MAX_USER_AGENT_LENGTH),
      authenticated: row.passwordRequired,
    });
    return consumed ? { kind: "minted" } : { kind: "refused", reason: "raced" };
  }

  private async passwordIsRight(row: GateRow, password: string | undefined): Promise<boolean> {
    if (password === undefined || row.passwordHash === null) {
      // Missing password, or a password-required token with NO hash (inconsistent data): never a grant, same cost.
      await verifyDecoy(password ?? "");
      return false;
    }
    try {
      return await argon2idVerify(password, row.passwordHash);
    } catch {
      return false;
    }
  }

  /** Never above the lock itself: the database clock and ours differ by milliseconds, and the contract's number is the cooldown. */
  private retryAfterMs(until: Date): number {
    return Math.min(PASSWORD_LOCK_MS, Math.max(0, until.getTime() - Date.now()));
  }

  private refuse(reason: string, error: Error): never {
    this.count(`refused_${reason}`);
    throw error;
  }

  private count(outcome: string): void {
    incrementCounter("nominara_portal_session_attempts_total", { outcome });
  }

  private async inTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
    } finally {
      client.release();
    }
  }
}
