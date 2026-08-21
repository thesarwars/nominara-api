import type { OauthProvider } from "../../../contracts/identity/oauth-provider.schema.js";

// STORY-015 — the per-provider table src/modules/identity/adapters/
// openid-client.adapter.ts reads from: which endpoints to use, whether the
// provider is discoverable via OIDC, and how to read its verified-email
// signal. Kept separate from the adapter (which owns the `openid-client`
// calls themselves) so the provider-specific DECISIONS here stay plain data
// and a couple of pure functions — reviewable without also reading
// `openid-client`'s API.
//
// `authorizationEndpoint` is listed explicitly, even for the two OIDC
// providers whose Configuration is otherwise built via discovery(): the
// OauthClient port's authorizationUrl() is synchronous
// (src/modules/identity/ports/oauth-client.ts), but OIDC discovery is a
// network call. Building the authorization redirect never needs the
// discovered Configuration — only the token exchange (which IS async) does
// — so the well-known, stable authorization endpoint is recorded here and
// discovery is reserved for exchangeCode().
//
// Verified-email signal is provider-specific and fails closed (Implementation
// decisions): an unrecognized or missing signal is always `emailVerified:
// false`, never assumed true.

export interface OidcProviderEndpoints {
  readonly isOidc: true;
  readonly authorizationEndpoint: string;
  /** Issuer URL passed to openid-client's discovery() at token-exchange time. */
  readonly issuerUrl: string;
  readonly scope: string;
}

export interface RestProviderEndpoints {
  readonly isOidc: false;
  readonly authorizationEndpoint: string;
  /** GitHub has no OIDC discovery document — server metadata is supplied explicitly. */
  readonly serverMetadata: {
    readonly issuer: string;
    readonly authorization_endpoint: string;
    readonly token_endpoint: string;
  };
  readonly scope: string;
  readonly userEndpoint: string;
  readonly userEmailsEndpoint: string;
}

export type ProviderEndpoints = OidcProviderEndpoints | RestProviderEndpoints;

export const OAUTH_PROVIDER_ENDPOINTS: Record<OauthProvider, ProviderEndpoints> = {
  google: {
    isOidc: true,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    issuerUrl: "https://accounts.google.com",
    scope: "openid email",
  },
  microsoft: {
    isOidc: true,
    // "common" — the multi-tenant endpoint; this app is not scoped to a
    // single Microsoft Entra tenant.
    authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    issuerUrl: "https://login.microsoftonline.com/common/v2.0",
    scope: "openid email",
  },
  github: {
    isOidc: false,
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    serverMetadata: {
      issuer: "https://github.com",
      authorization_endpoint: "https://github.com/login/oauth/authorize",
      token_endpoint: "https://github.com/login/oauth/access_token",
    },
    scope: "read:user user:email",
    userEndpoint: "https://api.github.com/user",
    userEmailsEndpoint: "https://api.github.com/user/emails",
  },
};

export interface OidcClaims {
  readonly email?: string | null;
  readonly email_verified?: boolean;
  /** Microsoft's optional "email domain verified" claim — absent unless explicitly configured on the tenant. */
  readonly xms_edov?: boolean;
}

/** Google — `email_verified === true` claim, nothing else counts (Implementation decisions). */
export function resolveGoogleVerifiedEmail(claims: OidcClaims): { email: string | null; emailVerified: boolean } {
  return { email: claims.email ?? null, emailVerified: claims.email_verified === true };
}

/**
 * Microsoft — the v2.0 token carries no verification claim by default, so
 * this fails closed to `unverified` unless the tenant explicitly asserts
 * `xms_edov === true` (Implementation decisions).
 */
export function resolveMicrosoftVerifiedEmail(claims: OidcClaims): { email: string | null; emailVerified: boolean } {
  return { email: claims.email ?? null, emailVerified: claims.xms_edov === true };
}

export interface GithubEmailEntry {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

/** GitHub — the `primary && verified` entry from GET /user/emails (Implementation decisions), never the profile's public `email` field. */
export function resolveGithubVerifiedEmail(emails: readonly GithubEmailEntry[]): {
  email: string | null;
  emailVerified: boolean;
} {
  const primaryVerified = emails.find((entry) => entry.primary && entry.verified);
  if (primaryVerified) {
    return { email: primaryVerified.email, emailVerified: true };
  }
  const fallback = emails.find((entry) => entry.primary) ?? emails[0];
  return { email: fallback?.email ?? null, emailVerified: false };
}
