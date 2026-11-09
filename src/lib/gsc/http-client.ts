import { GSC_READ_ONLY_SCOPE } from "../../../contracts/integrations/index.js";
import { loadEnv } from "../../config/env.js";
import {
  GscQuotaError,
  GscSourceError,
  GscUnauthorizedError,
  type GscClient,
  type GscPropertyListing,
  type GscReportRequest,
  type GscReportRow,
  type GscTokenSet,
} from "./port.js";

// STORY-115 - the Google adapter behind the port. Decision 80: it REUSES `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`, asks
// for the READ-ONLY scope and nothing else, and the redirect it is handed is built from `OAUTH_REDIRECT_BASE_URL` by the caller.
//
// Never exercised against Google by the suite: tests fake the port. What is tested is the one thing that must never drift, the
// authorisation request's scope set. Credentials are read from the validated env at call time and never logged.
//
// THE AI-SURFACE REPORT IS NOT FETCHED HERE. The specification names the report but not the request that reads it, and a guessed one
// would sync the wrong data under the right label. It raises `GscSourceError("ai_surface_report_unavailable")`, which the sync job
// records as degraded health, until the owner confirms the request shape (see the story's report notes).

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SITES_ENDPOINT = "https://www.googleapis.com/webmasters/v3/sites";
const ROW_LIMIT = 25_000;

export function buildAuthorizationUrl(input: { readonly clientId: string; readonly redirectUri: string; readonly state: string }): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GSC_READ_ONLY_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", input.state);
  return url.toString();
}

function credentials(): { clientId: string; clientSecret: string } {
  const env = loadEnv();
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) throw new GscSourceError("google_oauth_not_configured");
  return { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET };
}

/** Google's own words for "a limit is spent" in a 403 body, across the classic (`errors[].reason`) and the newer (`status`, `details[].reason`) shapes. */
const LIMIT_REASON = /rate.?limit|quota|limit.?exceeded|resource.?exhausted/i;

/**
 * 401 is a credential problem; 429 is quota; a 403 is read by its REASON, because Google answers both "this account no longer has access to
 * the property" and "a usage limit is spent" with it. Lost access is a credential problem (the sync stops and the customer is told), a spent
 * limit degrades and resumes. A 403 whose body cannot be read is treated as lost access, which is the safe side: it stops the sync and asks
 * the customer to reconnect, rather than retrying a forbidden call forever. The rest is the source misbehaving.
 */
async function failureFor(response: Response): Promise<Error> {
  const status = response.status;
  if (status === 401) return new GscUnauthorizedError();
  if (status === 429) return new GscQuotaError();
  if (status === 403) {
    const body = (await response.json().catch(() => ({}))) as { error?: { status?: unknown; errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }> } };
    const reasons = [body.error?.status, ...(body.error?.errors ?? []).map((e) => e.reason), ...(body.error?.details ?? []).map((d) => d.reason)];
    return reasons.some((reason) => typeof reason === "string" && LIMIT_REASON.test(reason)) ? new GscQuotaError() : new GscUnauthorizedError();
  }
  return new GscSourceError(`http_${status}`);
}

type FetchLike = typeof fetch;

export class HttpGscClient implements GscClient {
  constructor(private readonly doFetch: FetchLike = fetch) {}

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    return buildAuthorizationUrl({ clientId: credentials().clientId, redirectUri: input.redirectUri, state: input.state });
  }

  private async token(form: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }> {
    const { clientId, clientSecret } = credentials();
    const response = await this.doFetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...form }),
    });
    if (response.status === 400) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      // `invalid_grant` is a revoked or expired grant. Any other 400 is a request we built wrong, not a customer problem.
      throw body.error === "invalid_grant" ? new GscUnauthorizedError() : new GscSourceError("token_request_rejected");
    }
    if (!response.ok) throw await failureFor(response);
    return (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<GscTokenSet> {
    const body = await this.token({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri });
    if (body.access_token === undefined) throw new GscSourceError("token_response_malformed");
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresInSeconds: body.expires_in ?? 3600,
      scopes: (body.scope ?? "").split(" ").filter((scope) => scope !== ""),
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const body = await this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
    if (body.access_token === undefined) throw new GscSourceError("token_response_malformed");
    return { accessToken: body.access_token, expiresInSeconds: body.expires_in ?? 3600 };
  }

  async listProperties(accessToken: string): Promise<readonly GscPropertyListing[]> {
    const response = await this.doFetch(SITES_ENDPOINT, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw await failureFor(response);
    const body = (await response.json()) as { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> };
    return (body.siteEntry ?? []).flatMap((entry) => (entry.siteUrl === undefined ? [] : [{ siteUrl: entry.siteUrl, permissionLevel: entry.permissionLevel ?? "" }]));
  }

  async fetchReport(request: GscReportRequest): Promise<readonly GscReportRow[]> {
    if (request.report === "ai_surface") throw new GscSourceError("ai_surface_report_unavailable");
    const rows: GscReportRow[] = [];
    for (let startRow = 0; ; startRow += ROW_LIMIT) {
      const response = await this.doFetch([SITES_ENDPOINT, encodeURIComponent(request.property), "searchAnalytics", "query"].join("/"), {
        method: "POST",
        headers: { authorization: `Bearer ${request.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          startDate: request.startDate,
          endDate: request.endDate,
          dimensions: ["date", request.dimension, "device"],
          rowLimit: ROW_LIMIT,
          startRow,
          dataState: "final",
        }),
      });
      if (!response.ok) throw await failureFor(response);
      const body = (await response.json()) as { rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }> };
      const page = body.rows ?? [];
      for (const row of page) {
        const [date, key, device] = row.keys;
        if (date === undefined || key === undefined) continue;
        const lowered = (device ?? "").toLowerCase();
        if (lowered !== "desktop" && lowered !== "mobile" && lowered !== "tablet") continue;
        rows.push({
          date,
          page: request.dimension === "page" ? key : null,
          query: request.dimension === "query" ? key : null,
          device: lowered,
          country: null,
          impressions: row.impressions,
          clicks: row.clicks,
          ctr: row.ctr,
          position: row.position,
        });
      }
      if (page.length < ROW_LIMIT) return rows;
    }
  }
}
