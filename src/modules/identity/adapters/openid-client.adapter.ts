import * as client from "openid-client";
import { loadEnv } from "../../../config/env.js";
import type { OauthProvider } from "../../../../contracts/identity/oauth-provider.schema.js";
import {
  OAUTH_PROVIDER_ENDPOINTS,
  resolveGithubVerifiedEmail,
  resolveGoogleVerifiedEmail,
  resolveMicrosoftVerifiedEmail,
  type GithubEmailEntry,
  type OidcClaims,
  type RestProviderEndpoints,
} from "../../../lib/auth/oauth-providers.js";
import type { OauthAuthorizationUrlInput, OauthClient, OauthExchangeInput, OauthIdentity, OauthPkcePair } from "../ports/oauth-client.js";

// STORY-015 — the only file reaching into `openid-client` directly:
// PKCE verifier/challenge generation (generatePkce()) plus the actual
// provider integration — OIDC discovery, the authorization-code + PKCE
// grant, and ID-token claim access. OauthService calls generatePkce() via
// the OAUTH_CLIENT port and never imports `openid-client` itself. Google/
// Microsoft use discovery(); GitHub has
// no OIDC discovery document, so its Configuration is built from explicit
// server metadata (src/lib/auth/oauth-providers.ts) and its identity comes
// from GET /user + GET /user/emails rather than an ID token.
//
// Confirmed against openid-client@6.8.7's actual published API surface
// (function-based v6 API: discovery(), Configuration, buildAuthorizationUrl
// is NOT used here — see below — authorizationCodeGrant(), fetchUserInfo is
// NOT used for GitHub since it has no OIDC userinfo endpoint).

interface ProviderCredentials {
  readonly clientId: string;
  readonly clientSecret: string | undefined;
}

function credentialsFor(provider: OauthProvider): ProviderCredentials {
  const env = loadEnv();
  const byProvider: Record<OauthProvider, ProviderCredentials> = {
    google: { clientId: env.GOOGLE_OAUTH_CLIENT_ID ?? "", clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET },
    github: { clientId: env.GITHUB_OAUTH_CLIENT_ID ?? "", clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET },
    microsoft: { clientId: env.MICROSOFT_OAUTH_CLIENT_ID ?? "", clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET },
  };
  const credentials = byProvider[provider];
  if (!credentials.clientId) {
    // Provider credentials are optional config (Implementation decisions) —
    // every test fakes the provider at the OAUTH_CLIENT port boundary, so
    // this only ever fires against a real, unconfigured provider outside
    // the test suite, never inside it.
    throw new Error(`oauth provider not configured: ${provider}`);
  }
  return credentials;
}

export class OpenidClientAdapter implements OauthClient {
  private readonly configs = new Map<OauthProvider, Promise<client.Configuration>>();

  // authorizationUrl() is synchronous per the OAUTH_CLIENT port
  // (src/modules/identity/ports/oauth-client.ts), but OIDC discovery is a
  // network call — so the redirect is built from the well-known, static
  // authorization_endpoint (src/lib/auth/oauth-providers.ts), never from a
  // discovered Configuration. Discovery is reserved for exchangeCode(),
  // which the port's own shape already makes async.
  authorizationUrl(input: OauthAuthorizationUrlInput): string {
    const endpoints = OAUTH_PROVIDER_ENDPOINTS[input.provider];
    const { clientId } = credentialsFor(input.provider);
    const url = new URL(endpoints.authorizationEndpoint);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", endpoints.scope);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", input.state);
    return url.toString();
  }

  async generatePkce(): Promise<OauthPkcePair> {
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    return { verifier, challenge };
  }

  async exchangeCode(input: OauthExchangeInput): Promise<OauthIdentity> {
    const config = await this.configFor(input.provider);

    // The state parameter was already verified (signature, single-use,
    // session binding) by oauth.service.ts before this is ever called — the
    // synthetic URL below deliberately carries no `state`, so
    // authorizationCodeGrant's own CSRF check (which expects no `state`
    // when `expectedState` is omitted) is satisfied without re-deriving our
    // own check inside openid-client.
    const currentUrl = new URL(input.redirectUri);
    currentUrl.searchParams.set("code", input.code);

    const tokens = await client.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: input.codeVerifier,
    });

    if (input.provider === "github") {
      const endpoints = OAUTH_PROVIDER_ENDPOINTS.github as RestProviderEndpoints;
      return this.resolveGithubIdentity(tokens.access_token, endpoints);
    }

    const claims = tokens.claims() as unknown as (OidcClaims & { sub?: string }) | undefined;
    if (!claims?.sub) {
      throw new Error(`oauth provider ${input.provider} returned no subject claim`);
    }
    const resolveVerifiedEmail = input.provider === "google" ? resolveGoogleVerifiedEmail : resolveMicrosoftVerifiedEmail;
    const { email, emailVerified } = resolveVerifiedEmail(claims);
    return { externalSubject: claims.sub, email, emailVerified };
  }

  private configFor(provider: OauthProvider): Promise<client.Configuration> {
    const cached = this.configs.get(provider);
    if (cached) {
      return cached;
    }
    const credentials = credentialsFor(provider);
    const endpoints = OAUTH_PROVIDER_ENDPOINTS[provider];
    const promise = endpoints.isOidc
      ? client.discovery(new URL(endpoints.issuerUrl), credentials.clientId, credentials.clientSecret)
      : Promise.resolve(new client.Configuration(endpoints.serverMetadata, credentials.clientId, credentials.clientSecret));
    this.configs.set(provider, promise);
    return promise;
  }

  // GitHub is not OIDC — no ID token, no userinfo endpoint. The subject is
  // the numeric profile id (stringified — the join key, never the email);
  // the verified-email signal comes from GET /user/emails, never the
  // profile's public `email` field (Implementation decisions). Both REST
  // calls send `Accept: application/json` — GitHub's API otherwise responds
  // in a content type this adapter does not negotiate for.
  private async resolveGithubIdentity(accessToken: string, endpoints: RestProviderEndpoints): Promise<OauthIdentity> {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

    const profileResponse = await fetch(endpoints.userEndpoint, { headers });
    if (!profileResponse.ok) {
      throw new Error(`github profile request failed with status ${profileResponse.status}`);
    }
    const profile = (await profileResponse.json()) as { id: number | string };

    const emailsResponse = await fetch(endpoints.userEmailsEndpoint, { headers });
    if (!emailsResponse.ok) {
      throw new Error(`github emails request failed with status ${emailsResponse.status}`);
    }
    const emails = (await emailsResponse.json()) as GithubEmailEntry[];

    const { email, emailVerified } = resolveGithubVerifiedEmail(emails);
    return { externalSubject: String(profile.id), email, emailVerified };
  }
}
