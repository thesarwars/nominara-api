import { createHash, createHmac } from "node:crypto";
import type { ClientBase } from "pg";
import { REPORT_ATTACHMENT_MAX_BYTES } from "../../../contracts/reports/index.js";
import { DegradedError } from "../../api/errors/domain-errors.js";
import { API_VERSION_PREFIX } from "../../api/configure-app.js";
import type { EmailAttachment } from "../../modules/identity/ports/email-sender.js";
import type { BoundObjectStore, TenantObjectStore } from "../storage/tenant-object-store.js";

// STORY-180 AC3 - how a scheduled report's files reach the recipients.
//
//   a file of at most REPORT_ATTACHMENT_MAX_BYTES (8 MiB, owner decision 54 (4)) is ATTACHED, read back from the reports bucket
//   a larger file is a LINK, valid 7 days, through an API route that checks a stored, revocable token on every click and redirects
//   to a fresh 15-minute presign (decision 54 (3), option 3B: no static keys, nothing that dies with an STS session)
//
// THE TOKEN IS DERIVED, NOT RANDOM. A cadence delivery that fails is retried and REUSES its artifacts, and its email must then be
// byte-identical (Resend refuses a changed body under the same idempotency key). A random token cannot be recovered from the SHA-256
// the database keeps, so the token is HMAC-SHA256(job signing key, purpose || artifact id): the same artifact always yields the same
// link, the key never leaves the process, and the table holds only the hash, so a database read cannot be replayed as a link.
// Rotating the key does not break an issued link (the lookup is by the stored hash); it changes only links issued afterwards.
//
// Everything here that touches the database runs in the caller's TENANT TRANSACTION and makes no network call (KAD-06). The only
// network read, the attachment bytes, happens in `resolveMailParts`, which the caller runs with no transaction open.

const TOKEN_PURPOSE = "nominara/report-artifact-link/v1:";

export function reportLinkToken(signingKey: Uint8Array, artifactId: string): string {
  return createHmac("sha256", signingKey).update(TOKEN_PURPOSE).update(artifactId).digest("base64url");
}

/** What the database stores: the token itself is never written. */
export function hashReportLinkToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function reportLinkUrl(apiBaseUrl: string, workspaceId: string, token: string): string {
  return new URL(`/${API_VERSION_PREFIX}/report-links/${workspaceId}/${token}`, apiBaseUrl).href;
}

export interface ArtifactMailDeps {
  readonly store: TenantObjectStore;
  /** The API's public origin (the same value OAuth redirects are built from). */
  readonly apiBaseUrl: string;
  /** The queue job signing key; absent means no link can be issued. */
  readonly signingKey: Uint8Array | undefined;
  /** Resolves when the named artifacts' post-commit uploads have finished (immediately for ones this process did not upload). */
  readonly uploaded: (ids: readonly string[]) => Promise<void>;
}

export interface MailArtifact {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: number;
  /** The key inside the workspace's reports prefix: `{id}.{format}`. */
  readonly relativeKey: string;
  /** Set when the file is over the attachment limit: the URL the email carries instead. */
  readonly link: string | null;
}

export interface ArtifactMailPlan {
  readonly items: readonly MailArtifact[];
  readonly store: Pick<BoundObjectStore, "get">;
  readonly uploaded: () => Promise<void>;
}

export interface MailParts {
  readonly attachments: readonly EmailAttachment[];
  readonly links: readonly { readonly filename: string; readonly url: string }[];
}

interface ArtifactRow {
  id: string;
  format: "pdf" | "csv";
  bytes: number;
  period_end: string;
}

const CONTENT_TYPE = { pdf: "application/pdf", csv: "text/csv" } as const;

/**
 * Decides attach-or-link for each artifact and issues the link tokens. Runs in the tenant transaction that recorded the artifacts;
 * the only write is the SHA-256 of a link token on an oversize artifact. Throws rather than skip: an artifact the report built and
 * the database cannot show is a defect, not a smaller email.
 */
export async function planArtifactMail(tx: ClientBase, deps: ArtifactMailDeps, workspaceId: string, artifactIds: readonly string[]): Promise<ArtifactMailPlan> {
  const store = deps.store.bind();
  const found = await tx.query<ArtifactRow>(
    "SELECT id, format, bytes, period_end::text AS period_end FROM report_artifacts WHERE id = ANY($1::uuid[])",
    [artifactIds],
  );
  const byId = new Map(found.rows.map((r) => [r.id, r]));
  const sameFormat = new Map<string, number>();
  for (const id of artifactIds) {
    const row = byId.get(id);
    if (row !== undefined) sameFormat.set(row.format, (sameFormat.get(row.format) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const items: MailArtifact[] = [];
  for (const id of artifactIds) {
    const row = byId.get(id);
    if (row === undefined) throw new Error("a report artifact that was just built is not readable");
    const index = (seen.get(row.format) ?? 0) + 1;
    seen.set(row.format, index);
    // Several projects in one report give several files of one format: number them so the names differ.
    const suffix = (sameFormat.get(row.format) ?? 1) > 1 ? `-${String(index)}` : "";
    const filename = `nominara-report-${row.period_end}${suffix}.${row.format}`;
    let link: string | null = null;
    if (row.bytes > REPORT_ATTACHMENT_MAX_BYTES) {
      if (deps.signingKey === undefined) throw new DegradedError({ message: "report download links are not available" });
      const token = reportLinkToken(deps.signingKey, id);
      // A revoked link stays revoked: the hash is only (re)written, never the revocation cleared.
      await tx.query("UPDATE report_artifacts SET link_token_hash = $2 WHERE id = $1 AND link_token_hash IS DISTINCT FROM $2", [id, hashReportLinkToken(token)]);
      link = reportLinkUrl(deps.apiBaseUrl, workspaceId, token);
    }
    items.push({ id, filename, contentType: CONTENT_TYPE[row.format], bytes: row.bytes, relativeKey: `${id}.${row.format}`, link });
  }
  return { items, store, uploaded: () => deps.uploaded(artifactIds) };
}

/** Waits for the uploads, then reads each attached file once. NO transaction may be open. Throws if a file is not in storage. */
export async function resolveMailParts(plan: ArtifactMailPlan): Promise<MailParts> {
  await plan.uploaded();
  const attachments: EmailAttachment[] = [];
  const links: Array<{ filename: string; url: string }> = [];
  for (const item of plan.items) {
    if (item.link !== null) links.push({ filename: item.filename, url: item.link });
    else attachments.push({ filename: item.filename, contentType: item.contentType, content: await plan.store.get("reports", item.relativeKey) });
  }
  return { attachments, links };
}

/** The environment-derived half of the dependencies (the part that does not depend on who exported). */
export function mailDepsFromEnv(store: TenantObjectStore, env: { readonly OAUTH_REDIRECT_BASE_URL: string; readonly QUEUE_JOB_SIGNING_KEY: string }): Omit<ArtifactMailDeps, "uploaded"> {
  return { store, apiBaseUrl: env.OAUTH_REDIRECT_BASE_URL, signingKey: Buffer.from(env.QUEUE_JOB_SIGNING_KEY, "base64") };
}
