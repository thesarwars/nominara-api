import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { KeyObject } from "node:crypto";
import { loadEnv } from "../../config/env.js";
import { AccessTokenError, importEd25519PublicKeyFromDer, verifyAccessToken } from "../../lib/auth/access-token.js";
import type { AccessTokenClaims } from "../../../contracts/identity/access-token-claims.schema.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";

export interface AuthenticatedRequest {
  headers?: Record<string, string | string[] | undefined>;
  auth?: AccessTokenClaims;
}

// STORY-014 — real EdDSA (Ed25519) signature + expiry verification ONLY. No
// session-load, no jti deny-list, no revocation check — there is no sessions
// table until STORY-017 owns that. @Public() bypass must run BEFORE reading
// the Authorization header (STORY-022's guard-order test exercises this
// class against the unauthenticated /health/live route).
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly publicKey: KeyObject;

  constructor(private readonly reflector: Reflector) {
    this.publicKey = importEd25519PublicKeyFromDer(loadEnv().AUTH_TOKEN_ED25519_PUBLIC_KEY);
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
    const header = req.headers?.authorization;
    const headerValue = Array.isArray(header) ? header[0] : header;
    const match = headerValue?.match(/^Bearer (.+)$/);
    if (!match) {
      throw new UnauthorizedException("missing or malformed Authorization header");
    }

    try {
      req.auth = await verifyAccessToken(match[1]!, this.publicKey);
    } catch (error) {
      if (error instanceof AccessTokenError) {
        throw new UnauthorizedException("invalid or expired access token");
      }
      throw error;
    }

    return true;
  }
}
