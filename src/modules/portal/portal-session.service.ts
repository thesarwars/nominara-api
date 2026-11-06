import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import type { PortalCookiePayload, PortalSessionRequest, PortalSessionResponse, PortalSessionVerifyRequest } from "../../../contracts/portal/index.js";
import { DegradedError, RateLimitedError, TokenRevokedError, UnauthenticatedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { loadEnv } from "../../config/env.js";
import { normalizeEmail } from "../../lib/auth/email-otp.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { verify as argon2idVerify, verifyDecoy } from "../../lib/crypto/argon2id.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { gateRefusal, hashShareSecret, PASSWORD_LOCK_MS, ShareTokensService, type GateRow } from "../agency/share-tokens.service.js";
import { EMAIL_SENDER, type EmailSender } from "../identity/ports/email-sender.js";
import { loadPortalCookieKey, PORTAL_SESSION_TTL_SECONDS, sealPortalCookie } from "./portal-cookie.js";
import { domainAllowed, generatePortalCode, PORTAL_CODE_TTL_MS, portalEmailHash, renderPortalCodeEmail } from "./portal-email-code.js";
import { PortalEmailCodesService } from "./portal-email-codes.service.js";

export interface RequestFacts {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface MintedPortalSession {
  readonly kind: "minted";
  readonly response: PortalSessionResponse;
  readonly cookie: { readonly value: string; readonly maxAgeSeconds: number };
}

/** Owner decision 71 (b): a code was mailed; there is no session yet. */
export interface CodeSentOutcome {
  readonly kind: "code_sent";
}

const MAX_USER_AGENT_LENGTH = 512;

type AttemptOutcome =
  | { readonly kind: "minted"; readonly viewId: string }
  | { readonly kind: "code_issued"; readonly code: string; readonly email: string }
  | { readonly kind: "code_rate_limited"; readonly retryAfterMs: number }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "locked"; readonly until: Date }
  | { readonly kind: "wrong_password" }
  | { readonly kind: "email_required" }
  | { readonly kind: "domain_refused" };

type VerifyOutcome =
  | { readonly kind: "minted"; readonly viewId: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "locked"; readonly until: Date }
  | { readonly kind: "wrong_code" };

// STORY-098 part B — POST /portal/session, integrations-and-sharing.md §3 session flow:
//   1. hash lookup; reject if revoked, expired, or view_count >= max_views        (ONE neutral refusal)
//   2. Argon2id verify, constant-time; 5 failures per token -> 15-minute lock
//   3. allowed_email_domains set -> require the email, verify the domain, issue a code (stored hashed, ONE transaction with the
//      checks above), and mail it AFTER that transaction commits (ADR-0003). Answers 202; there is no session yet.
//      POST /portal/session/verify then checks the code under the same token row lock and carries on to 4 and 5.
//   4. mint the scoped cookie
//   5. INSERT a view row; increment view_count
//
// The route is public and tenant-less: the workspace is the thing step 1 discovers, through the one SECURITY DEFINER
// lookup (migration 0080). Everything after it runs in a tenant context for THAT workspace on the app pool, so the
// lock, the view row and the counter are written under RLS like any other tenant write.
//
// What does NOT happen here: no network call inside a request transaction (KAD-06, ADR-0003). The code mail is handed to the sender
// after the commit, off the request path, and its failure is logged and counted, never shown to the visitor (a bounce would
// otherwise tell them whether the mailbox exists).
@Injectable()
export class PortalSessionService {
  private readonly logger = new Logger(PortalSessionService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly shareTokens: ShareTokensService,
    private readonly codes: PortalEmailCodesService,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
  ) {}

  async mint(body: PortalSessionRequest, facts: RequestFacts): Promise<MintedPortalSession | CodeSentOutcome> {
    return this.spanned("portal.session.mint", () => this.run(body, facts));
  }

  /**
   * POST /portal/session/verify (owner decision 71 b). Where the link has a password it is checked again (same lock as the first step).
   * Everything that is not a right code answers ONE way (401, the same message) whether the link is unknown, the password is wrong, the
   * link carries no domain list, the address is not allowed, no code is live, or the code is wrong; each of them pays one Argon2 verify.
   */
  async verify(body: PortalSessionVerifyRequest, facts: RequestFacts): Promise<MintedPortalSession> {
    return this.spanned("portal.session.verify", () => this.runVerify(body, facts));
  }

  private async spanned<T extends { readonly kind: string }>(span: string, run: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let outcome = "error";
    try {
      const result = await run();
      outcome = result.kind;
      return result;
    } catch (error) {
      outcome = error instanceof Error ? error.name : "error";
      throw error;
    } finally {
      // The span: one line per attempt, duration and outcome, no secret, no address, no workspace name.
      this.logger.log(`span=${span} outcome=${outcome} duration_ms=${String(Math.round(performance.now() - started))}`);
    }
  }

  private async run(body: PortalSessionRequest, facts: RequestFacts): Promise<MintedPortalSession | CodeSentOutcome> {
    // Fail closed before touching a token: an unconfigured portal mints nothing.
    const key = this.cookieKey();

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
      case "code_rate_limited":
        this.count("code_rate_limited");
        throw new RateLimitedError({ message: "too many codes requested; try again later", details: { retry_after_ms: outcome.retryAfterMs } });
      case "code_issued":
        // The transaction has COMMITTED: the row is durable before the provider hears of it (ADR-0003).
        this.count("code_sent");
        this.dispatchCode(row.workspaceId, row.id, outcome.email, outcome.code);
        return { kind: "code_sent" };
      case "minted":
        return this.sealSession(row, outcome.viewId, key);
    }
  }

  private async runVerify(body: PortalSessionVerifyRequest, facts: RequestFacts): Promise<MintedPortalSession> {
    const key = this.cookieKey();
    const neutral = (): never => {
      throw new UnauthenticatedError({ message: "the link or code is not valid" });
    };

    const row = await this.shareTokens.findForGate(this.pool, hashShareSecret(body.secret));
    if (row === null) {
      await verifyDecoy(body.code);
      this.count("verify_unknown");
      return neutral();
    }

    const outcome = await this.inTenant(row.workspaceId, () => this.attemptVerify(row.id, body, facts));
    switch (outcome.kind) {
      case "refused":
        return this.refuse(outcome.reason, new TokenRevokedError({ message: "this link is no longer available" }));
      case "locked":
        this.count("locked");
        throw new RateLimitedError({ message: "too many attempts; try again later", details: { retry_after_ms: this.retryAfterMs(outcome.until) } });
      case "wrong_code":
        this.count("wrong_code");
        return neutral();
      case "minted":
        return this.sealSession(row, outcome.viewId, key);
    }
  }

  private cookieKey(): ReturnType<typeof loadPortalCookieKey> {
    const keyMaterial = loadEnv().PORTAL_COOKIE_KEY;
    if (keyMaterial === undefined) throw new DegradedError({ message: "the portal is not available" });
    return loadPortalCookieKey(keyMaterial);
  }

  private async sealSession(row: GateRow, viewId: string, key: ReturnType<typeof loadPortalCookieKey>): Promise<MintedPortalSession> {
    const sealed = await sealPortalCookie(
      {
        token_id: row.id,
        workspace_id: row.workspaceId,
        scope_project_ids: [...row.scopeProjectIds],
        scope_tabs: row.scopeTabs as PortalCookiePayload["scope_tabs"],
        theme_id: row.themeId,
        view_id: viewId,
      },
      key,
      new Date(),
    );
    this.count("minted");
    this.logger.log(`portal session minted workspace_id=${row.workspaceId} share_token_id=${row.id} view_id=${viewId}`);
    return {
      kind: "minted",
      response: { expires_at: sealed.expiresAt.toISOString() },
      cookie: { value: sealed.value, maxAgeSeconds: PORTAL_SESSION_TTL_SECONDS },
    };
  }

  /**
   * Hands the mail to the sender off the request path, AFTER the code's transaction committed. Its failure is logged and counted and is
   * NEVER part of the response: a provider bounce for one address and not another would be an existence oracle. The log line carries
   * workspace and token ids and no address, no code.
   */
  private dispatchCode(workspaceId: string, tokenId: string, email: string, code: string): void {
    setImmediate(() => {
      const rendered = renderPortalCodeEmail({ code, expiresInMinutes: PORTAL_CODE_TTL_MS / 60_000 });
      this.emailSender.send({ to: email, subject: rendered.subject, textBody: rendered.textBody, transactional: true }).then(
        () => this.count("code_mail_handed_over"),
        (error: unknown) => {
          this.count("code_mail_failed");
          this.logger.warn(`portal code mail failed workspace_id=${workspaceId} share_token_id=${tokenId} error=${error instanceof Error ? error.name : "unknown"}`);
        },
      );
    });
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
      if (!domainAllowed(body.email, row.allowedEmailDomains)) return { kind: "domain_refused" };
      // No session yet: issue the code, in this transaction, and let the caller mail it once the transaction has committed.
      const email = normalizeEmail(body.email);
      const code = generatePortalCode();
      const issued = await this.codes.issue(row.id, portalEmailHash(email, loadEnv().OTP_EMAIL_HASH_PEPPER), code);
      return issued.kind === "issued" ? { kind: "code_issued", code, email } : { kind: "code_rate_limited", retryAfterMs: issued.retryAfterMs };
    }

    const viewId = await this.shareTokens.consumeView(row.id, {
      ip: facts.ip,
      userAgent: facts.userAgent === null ? null : facts.userAgent.slice(0, MAX_USER_AGENT_LENGTH),
      authenticated: row.passwordRequired,
    });
    return viewId === null ? { kind: "refused", reason: "raced" } : { kind: "minted", viewId };
  }

  /** The code step against the locked row. Same order as `attempt`: lifecycle, then the lock, then the check. */
  private async attemptVerify(id: string, body: PortalSessionVerifyRequest, facts: RequestFacts): Promise<VerifyOutcome> {
    const row = await this.shareTokens.lockForAttempt(id);
    if (row === null) return { kind: "refused", reason: "raced" };
    const now = new Date();
    const refusal = gateRefusal(row, now);
    if (refusal !== null) return { kind: "refused", reason: refusal };
    if (row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime()) return { kind: "locked", until: row.lockedUntil };

    // The password again, with the same failure count and lock as the first step: the code must never be the only thing between a
    // visitor holding the link and a password-protected portal.
    if (row.passwordRequired && !(await this.passwordIsRight(row, body.password))) {
      const { lockedUntil } = await this.shareTokens.recordFailedPassword(row.id);
      return lockedUntil !== null ? { kind: "locked", until: lockedUntil } : { kind: "wrong_code" };
    }

    // A link with no domain list has no code step, and an address outside the list never had a code: both are a wrong code, at the cost of one.
    if (row.allowedEmailDomains.length === 0 || !domainAllowed(body.email, row.allowedEmailDomains)) {
      await verifyDecoy(body.code);
      return { kind: "wrong_code" };
    }
    const checked = await this.codes.check(row.id, portalEmailHash(body.email, loadEnv().OTP_EMAIL_HASH_PEPPER), body.code);
    if (checked !== "match") return { kind: "wrong_code" };

    // `authenticated`: the visitor proved control of an allowed mailbox (and the password, where the link has one).
    const viewId = await this.shareTokens.consumeView(row.id, {
      ip: facts.ip,
      userAgent: facts.userAgent === null ? null : facts.userAgent.slice(0, MAX_USER_AGENT_LENGTH),
      authenticated: true,
    });
    return viewId === null ? { kind: "refused", reason: "raced" } : { kind: "minted", viewId };
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
