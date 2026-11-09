import type { GscReport } from "../../../contracts/integrations/index.js";

// STORY-115 - the Search Console port. The ONLY seam to Google: the OAuth token exchange, the property list and the report pulls all
// go through it, so a test fakes Google here and nothing in the suite can reach a real provider. The sync job is its only caller of
// `fetchReport`/`refresh` (it holds no transaction while it waits); the OAuth callback uses `exchangeCode` and `listProperties` with no
// transaction open either (ADR-0003).

export const GSC_CLIENT = Symbol("GSC_CLIENT");

export interface GscTokenSet {
  readonly accessToken: string;
  /** Present on the first grant (`access_type=offline`); a refresh never returns a new one. */
  readonly refreshToken: string | null;
  /** Seconds the access token lives. The CALLER turns it into a timestamp with the database's clock: no gsc code reads the process clock. */
  readonly expiresInSeconds: number;
  /** The scopes Google says were GRANTED, which is what is stored and what the read-only assertion checks. */
  readonly scopes: readonly string[];
}

export interface GscPropertyListing {
  readonly siteUrl: string;
  readonly permissionLevel: string;
}

export interface GscReportRequest {
  readonly accessToken: string;
  readonly property: string;
  readonly report: GscReport;
  /** `page` rows carry a landing URL; `query` rows a search query. The AI-surface report has no query dimension. */
  readonly dimension: "page" | "query";
  /** `YYYY-MM-DD`, inclusive. */
  readonly startDate: string;
  readonly endDate: string;
}

export interface GscReportRow {
  readonly date: string;
  readonly page: string | null;
  readonly query: string | null;
  readonly device: "desktop" | "mobile" | "tablet";
  /** Two letters when the source provides one, else `null`. */
  readonly country: string | null;
  readonly impressions: number;
  /** The AI-surface report has no clicks, CTR or position. */
  readonly clicks: number | null;
  readonly ctr: number | null;
  readonly position: number | null;
}

export interface GscClient {
  authorizationUrl(input: { readonly state: string; readonly redirectUri: string }): string;
  exchangeCode(input: { readonly code: string; readonly redirectUri: string }): Promise<GscTokenSet>;
  refresh(refreshToken: string): Promise<{ readonly accessToken: string; readonly expiresInSeconds: number }>;
  listProperties(accessToken: string): Promise<readonly GscPropertyListing[]>;
  fetchReport(request: GscReportRequest): Promise<readonly GscReportRow[]>;
}

/** The credential was revoked or expired for good: the grant is gone and only the customer can restore it. */
export class GscUnauthorizedError extends Error {
  constructor() {
    super("search console credential is no longer valid");
    this.name = "GscUnauthorizedError";
  }
}

/** The source's rate limit or quota is spent. Transient: the sync degrades and resumes at its next run. */
export class GscQuotaError extends Error {
  constructor() {
    super("search console quota or rate limit reached");
    this.name = "GscQuotaError";
  }
}

/** Any other failure at the source (5xx, malformed answer, an unsupported report). Retryable on the queue's ladder. */
export class GscSourceError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`search console source error (${reason})`);
    this.name = "GscSourceError";
    this.reason = reason;
  }
}
