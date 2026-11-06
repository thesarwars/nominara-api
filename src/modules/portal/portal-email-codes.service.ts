import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { hash as argon2idHash, verify as argon2idVerify, verifyDecoy } from "../../lib/crypto/argon2id.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { PORTAL_CODE_ISSUE_LIMIT_PER_HOUR, PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_DAY, PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_HOUR, PORTAL_CODE_MAX_ATTEMPTS, PORTAL_CODE_TTL_MS } from "./portal-email-code.js";

export type IssueOutcome = { readonly kind: "issued" } | { readonly kind: "rate_limited"; readonly retryAfterMs: number };
export type CheckOutcome = "match" | "wrong" | "none";

// Owner decision 71 (b) — owns `share_token_email_codes` (one table, one owning service). Every statement runs on the ambient tenant
// transaction PortalSessionService opens for the token's workspace AFTER it has taken the token's row lock, so the issue caps, the
// supersede and the attempt budget are all evaluated under that lock: parallel requests for one link queue, they do not race. Every
// statement also carries `workspace_id = app.current_workspace()`; RLS is the guarantee, the predicate is for the planner.
//
// Nothing here touches the network: the mail is sent by the caller AFTER the transaction commits (ADR-0003).
@Injectable()
export class PortalEmailCodesService {
  /** Applies the per-address and per-link hourly caps and the per-link daily cap, supersedes the address's live codes, stores the new one hashed. */
  async issue(tokenId: string, emailHash: Buffer, code: string): Promise<IssueOutcome> {
    const { client, workspaceId } = this.store();
    const perAddress = await client.query<{ n: number; retry_ms: number | null }>(
      `SELECT count(*)::int AS n, (extract(epoch from (min(created_at) + interval '1 hour' - now())) * 1000)::int AS retry_ms
         FROM share_token_email_codes
        WHERE workspace_id = app.current_workspace() AND share_token_id = $1 AND email_hash = $2 AND created_at > now() - interval '1 hour'`,
      [tokenId, emailHash],
    );
    if ((perAddress.rows[0]?.n ?? 0) >= PORTAL_CODE_ISSUE_LIMIT_PER_HOUR) return { kind: "rate_limited", retryAfterMs: Math.max(1, perAddress.rows[0]?.retry_ms ?? 0) };
    const perToken = await client.query<{ n: number; retry_ms: number | null }>(
      `SELECT count(*)::int AS n, (extract(epoch from (min(created_at) + interval '1 hour' - now())) * 1000)::int AS retry_ms
         FROM share_token_email_codes
        WHERE workspace_id = app.current_workspace() AND share_token_id = $1 AND created_at > now() - interval '1 hour'`,
      [tokenId],
    );
    if ((perToken.rows[0]?.n ?? 0) >= PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_HOUR) return { kind: "rate_limited", retryAfterMs: Math.max(1, perToken.rows[0]?.retry_ms ?? 0) };
    // The oldest code leaving the window is when the next one may be issued.
    const perDay = await client.query<{ n: number; retry_ms: number | null }>(
      `SELECT count(*)::int AS n, (extract(epoch from (min(created_at) + interval '24 hours' - now())) * 1000)::int AS retry_ms
         FROM share_token_email_codes
        WHERE workspace_id = app.current_workspace() AND share_token_id = $1 AND created_at > now() - interval '24 hours'`,
      [tokenId],
    );
    if ((perDay.rows[0]?.n ?? 0) >= PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_DAY) return { kind: "rate_limited", retryAfterMs: Math.max(1, perDay.rows[0]?.retry_ms ?? 0) };

    await client.query(
      `UPDATE share_token_email_codes SET invalidated_at = now(), invalidated_reason = 'superseded'
        WHERE workspace_id = app.current_workspace() AND share_token_id = $1 AND email_hash = $2 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [tokenId, emailHash],
    );
    await client.query(
      `INSERT INTO share_token_email_codes (id, workspace_id, share_token_id, email_hash, code_hash, max_attempts, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::float8 / 1000))`,
      [uuidV7(), workspaceId, tokenId, emailHash, await argon2idHash(code), PORTAL_CODE_MAX_ATTEMPTS, PORTAL_CODE_TTL_MS],
    );
    return { kind: "issued" };
  }

  /**
   * Checks `code` against the live codes of (token, address). "none" (no live code) pays the same Argon2 cost as a wrong guess, so the two
   * cannot be told apart by duration. A wrong guess spends one attempt of every live code; the one that reaches its budget is invalidated
   * (not merely refused), so it cannot be attacked again. A match consumes the code.
   */
  async check(tokenId: string, emailHash: Buffer, code: string): Promise<CheckOutcome> {
    const { client } = this.store();
    const live = await client.query<{ id: string; code_hash: string }>(
      `SELECT id, code_hash FROM share_token_email_codes
        WHERE workspace_id = app.current_workspace() AND share_token_id = $1 AND email_hash = $2
          AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
        ORDER BY created_at, id
        FOR UPDATE`,
      [tokenId, emailHash],
    );
    if (live.rows.length === 0) {
      await verifyDecoy(code);
      return "none";
    }
    for (const row of live.rows) {
      if (await safeVerify(code, row.code_hash)) {
        await client.query(`UPDATE share_token_email_codes SET consumed_at = now() WHERE workspace_id = app.current_workspace() AND id = $1`, [row.id]);
        return "match";
      }
    }
    await client.query(
      `UPDATE share_token_email_codes
          SET attempts = attempts + 1,
              invalidated_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE invalidated_at END,
              invalidated_reason = CASE WHEN attempts + 1 >= max_attempts THEN 'attempts_exhausted' ELSE invalidated_reason END
        WHERE workspace_id = app.current_workspace() AND id = ANY($1::uuid[])`,
      [live.rows.map((r) => r.id)],
    );
    return "wrong";
  }

  private store(): { client: ClientBase; workspaceId: string } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PortalEmailCodesService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId };
  }
}

async function safeVerify(code: string, encoded: string): Promise<boolean> {
  try {
    return await argon2idVerify(code, encoded);
  } catch {
    return false;
  }
}
