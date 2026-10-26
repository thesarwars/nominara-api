import { Pool } from "pg";
import { loadEnv } from "../../config/env.js";

// STORY-178 — the read side of `email_suppressions` (migration 0141), for the send path. A GLOBAL table (no tenant context
// exists or is needed: a bounce is a property of the address), read by every process that sends mail: the API (OTP,
// scheduled-report send-now) and the workers (cadence reports, digests, alerts, billing notices). The pool is the process's
// own small one, built on the first send, so a process that never sends never connects, and it lets itself go idle.

export type SuppressionKind = "bounce" | "complaint";

export interface SuppressionStore {
  /** The ACTIVE (not lifted) suppression kinds for one peppered address hash; empty when the address is clean. */
  activeKinds(recipientHash: Buffer): Promise<readonly SuppressionKind[]>;
}

interface Queryable {
  query<R extends Record<string, unknown>>(text: string, values: unknown[]): Promise<{ rows: R[] }>;
}

export class PgSuppressionStore implements SuppressionStore {
  constructor(private readonly db: Queryable) {}

  async activeKinds(recipientHash: Buffer): Promise<readonly SuppressionKind[]> {
    const result = await this.db.query<{ kind: SuppressionKind }>(
      "SELECT DISTINCT kind FROM email_suppressions WHERE recipient_hash = $1 AND deleted_at IS NULL",
      [recipientHash],
    );
    return result.rows.map((row) => row.kind);
  }
}

let shared: SuppressionStore | undefined;

/** The process-wide store, on a lazily built pool (the app/worker pooled connection, max 2 clients, released when idle). */
export function sharedSuppressionStore(): SuppressionStore {
  if (shared === undefined) {
    let pool: Pool | undefined;
    shared = new PgSuppressionStore({
      query: (text, values) => {
        if (pool === undefined) {
          pool = new Pool({ connectionString: loadEnv().DATABASE_URL_POOLED, max: 2, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 3_000, query_timeout: 3_000, allowExitOnIdle: true });
          pool.on("error", () => undefined); // once, when the pool is built: an idle client's error must not crash the process
        }
        return pool.query(text, values) as never;
      },
    });
  }
  return shared;
}
