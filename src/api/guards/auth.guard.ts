import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { KeyObject } from "node:crypto";
import type { Pool } from "pg";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import {
  AccessTokenError,
  importEd25519PublicKeyFromDer,
  verifyAccessToken,
  type KeyResolver,
} from "../../lib/auth/access-token.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../lib/auth/cookies.js";
import { verifyDoubleSubmit } from "../../lib/auth/csrf.js";
import type { AccessTokenClaims } from "../../../contracts/identity/access-token-claims.schema.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";

export interface SessionStrongAuth {
  readonly lastStrongAuthAt: Date | null;
  readonly lastStrongAuthMethod: string | null;
}

export interface AuthenticatedRequest {
  headers?: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  method?: string;
  auth?: AccessTokenClaims;
  authMethod?: "session" | "apiKey";
  session?: SessionStrongAuth;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// STORY-017 — cookie-only, full stop: the access token is read from
// __Host-nominara-access ONLY, no Authorization: Bearer fallback (that
// header is reserved for a future API-key mechanism, a structurally
// distinct credential this guard adds no branch for). Verification is
// kid-aware (a previous key still verifies through a rotation's overlap
// window) and, unlike STORY-014, now also loads the session row: revoked_at
// IS NULL is both the session-revocation check AND the jti deny list, since
// revoking a session invalidates every jti ever minted under it. CSRF
// double-submit is enforced here too, on every cookie-authenticated
// mutating request, rather than as a separate guard in the composition
// root's fixed chain.
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly resolveKey: KeyResolver;
  private readonly csrfSecret: string;

  constructor(
    private readonly reflector: Reflector,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {
    const env = loadEnv();
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
    this.csrfSecret = env.CSRF_SECRET;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const accessCookie = req.cookies?.[ACCESS_COOKIE_NAME];
    if (!accessCookie) {
      throw new UnauthorizedException("missing session cookie");
    }

    let claims: AccessTokenClaims;
    try {
      claims = await verifyAccessToken(accessCookie, this.resolveKey);
    } catch (error) {
      if (error instanceof AccessTokenError) {
        throw new UnauthorizedException(error.message === "token expired" ? "access token expired" : "invalid access token");
      }
      throw error;
    }

    // STORY-019 — the same query now also carries the strong-auth freshness
    // RbacGuard needs for step-up, so its own added-lookup count stays zero
    // (security-and-tenancy.md §5's step-up line).
    const sessionResult = await this.pool.query<{
      revoked_at: Date | null;
      last_strong_auth_at: Date | null;
      last_strong_auth_method: string | null;
    }>("SELECT revoked_at, last_strong_auth_at, last_strong_auth_method FROM sessions WHERE id = $1", [claims.sid]);
    const session = sessionResult.rows[0];
    if (!session || session.revoked_at !== null) {
      throw new UnauthorizedException("session revoked");
    }

    req.auth = claims;
    req.authMethod = "session";
    req.session = {
      lastStrongAuthAt: session.last_strong_auth_at ?? null,
      lastStrongAuthMethod: session.last_strong_auth_method ?? null,
    };

    const permitted = verifyDoubleSubmit({
      authMethod: "session",
      method: req.method ?? "GET",
      sid: claims.sid,
      cookieToken: req.cookies?.[CSRF_COOKIE_NAME],
      headerToken: firstValue(req.headers?.[CSRF_HEADER_NAME]),
      secret: this.csrfSecret,
    });
    if (!permitted) {
      throw new ForbiddenException("missing or invalid CSRF token");
    }

    return true;
  }
}
