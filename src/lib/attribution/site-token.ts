import { createHash } from "node:crypto";

// STORY-113 - the public site token. `nat_<workspace uuid>_<24 random bytes, base64url>`.
//
// The token is public by design (it sits in the customer's page), so it carries the workspace id in the clear. That is not a leak:
// a workspace id is not a secret (the report-link route makes the same bet), and here it does one job - choosing whose row-level
// security the ingest lookup runs under, so a public route never needs a cross-tenant read. What authorises the lookup is the
// SHA-256 of the WHOLE token, matched by equality inside that workspace; a token presented under another workspace finds no row.
const TOKEN_PATTERN = /^nat_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{20,64}$/;

export function hashSiteToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** The workspace a well-formed token names, or undefined for anything else. */
export function workspaceOfSiteToken(token: string): string | undefined {
  return TOKEN_PATTERN.exec(token)?.[1];
}
