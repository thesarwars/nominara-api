import type { OauthProvider } from "../../../../contracts/identity/oauth-provider.schema.js";

// STORY-015 — the seam a real `openid-client`-backed adapter fills behind,
// without OauthService ever importing the provider SDK directly. Same
// port-plus-adapter precedent as DEK_PROVISIONER
// (src/modules/workspaces/ports/dek-provisioner.ts): every test fakes the
// provider HERE, at this boundary, rather than mocking `openid-client`
// itself or hitting a real provider network endpoint (no-expensive-work-on-
// the-request-path rule; this story's Implementation decisions).
//
// Interface-only — no logic, no adapter, no DI wiring here. The real
// adapter and the module registration that provides OAUTH_CLIENT land with
// oauth.service.ts/oauth.controller.ts (this story's later tasks).
export const OAUTH_CLIENT = Symbol("OAUTH_CLIENT");

export interface OauthAuthorizationUrlInput {
  readonly provider: OauthProvider;
  readonly redirectUri: string;
  /** Already-computed PKCE S256 challenge — the client embeds it verbatim, it never derives one. */
  readonly codeChallenge: string;
  readonly state: string;
}

export interface OauthExchangeInput {
  readonly provider: OauthProvider;
  readonly code: string;
  /** The server-held verifier read back from oauth_authorization_requests — never request input (AC "proof-key exchange"). */
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface OauthIdentity {
  /** The provider's subject claim — the join key. Never the email. */
  readonly externalSubject: string;
  readonly email: string | null;
  /** Provider-specific verified-email signal, already resolved fail-closed by the adapter (Implementation decisions). */
  readonly emailVerified: boolean;
}

export interface OauthPkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export interface OauthClient {
  authorizationUrl(input: OauthAuthorizationUrlInput): string;
  exchangeCode(input: OauthExchangeInput): Promise<OauthIdentity>;
  /** Generates a fresh PKCE verifier/S256-challenge pair. Pure in-process crypto — no network call. */
  generatePkce(): Promise<OauthPkcePair>;
}
