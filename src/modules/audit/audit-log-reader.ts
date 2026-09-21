import type { ClientBase } from "pg";
import type { AuditChainRow } from "../../lib/crypto/audit-chain.js";

// STORY-020 — the ONE place that reads audit_log rows back into AuditChainRow
// shape, so the daily verifier and AuditQueryService can never drift on how
// a column round-trips. `host(actor_ip)` matters: casting an inet column
// with `::text` renders "127.0.0.1/32" (the netmask Postgres defaults an
// unqualified IPv4 address to), which never matches the bare string that was
// hashed at write time — host() strips it back to the address alone.
// seq is bigserial (int8); node-pg already parses int8 columns as strings
// (never numbers, to avoid precision loss) — no `::text` cast needed, and
// casting it would be actively harmful: a cast output column named "seq"
// shadows the input column of the same name, so a later `ORDER BY seq`
// would sort lexicographically ("10" < "8") instead of numerically.
const ROW_COLUMNS = `
  audit_log.seq, workspace_id, occurred_at, actor_type, actor_id, host(actor_ip) AS actor_ip, actor_ua,
  action, resource_type, resource_id, before_state, after_state, request_id, support_grant_id,
  severity, prev_hash, row_hash
`;

interface RawAuditRow {
  seq: string;
  workspace_id: string;
  occurred_at: Date;
  actor_type: AuditChainRow["actor_type"];
  actor_id: string | null;
  actor_ip: string | null;
  actor_ua: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_state: unknown;
  after_state: unknown;
  request_id: string;
  support_grant_id: string | null;
  severity: AuditChainRow["severity"];
  prev_hash: Buffer;
  row_hash: Buffer;
}

function toAuditChainRow(raw: RawAuditRow): AuditChainRow {
  return { ...raw, occurred_at: raw.occurred_at.toISOString() };
}

/** Reads one workspace's full chain, oldest first — the order verifyChain requires. */
export async function readWorkspaceChain(client: ClientBase, workspaceId: string): Promise<AuditChainRow[]> {
  const result = await client.query<RawAuditRow>(
    `SELECT ${ROW_COLUMNS} FROM audit_log WHERE workspace_id = $1 ORDER BY audit_log.seq ASC`,
    [workspaceId],
  );
  return result.rows.map(toAuditChainRow);
}

/** Reads every distinct workspace_id that currently has at least one audit_log row (for the daily verifier's sweep). */
export async function listAuditedWorkspaceIds(client: ClientBase): Promise<string[]> {
  const result = await client.query<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM audit_log");
  return result.rows.map((row) => row.workspace_id);
}

// ---------------------------------------------------------------------------
// STORY-144 — the chunked walk.
// ---------------------------------------------------------------------------

/** How many rows one chunk of a chain walk pulls. */
export const CHAIN_CHUNK_ROWS = 2_000;

/**
 * The `seq` of the LAST rechaining marker in a workspace's chain, or null.
 *
 * `verifyChain` finds this by scanning the whole chain in memory. A chunked
 * walk cannot: it has to know where the strict zone starts BEFORE it begins
 * reading. One indexed aggregate answers it.
 */
export async function lastRechainSeq(client: ClientBase, workspaceId: string, markerAction: string): Promise<string | null> {
  const result = await client.query<{ seq: string | null }>(
    "SELECT max(seq)::text AS seq FROM audit_log WHERE workspace_id = $1 AND action = $2",
    [workspaceId, markerAction],
  );
  return result.rows[0]?.seq ?? null;
}

/**
 * The `row_hash` of the row immediately before `seq`, which is what the
 * strict zone starts from.
 *
 * ⚠ THIS IS WHY THE LENIENT ZONE NEED NOT BE READ AT ALL. `verifyChain` walks
 * every pre-marker row only to set `expectedPrevHash = row.row_hash` and move
 * on — it trusts them by design (STORY-020-E-9: erasure rewrites content, so
 * their hashes cannot be recomputed). The ONLY thing that survives that loop
 * is the last one's `row_hash`. Reading it directly skips the entire history
 * before the marker, which on a long-lived workspace is most of the chain.
 */
export async function chainAnchorBefore(client: ClientBase, workspaceId: string, seq: string): Promise<Buffer | null> {
  const result = await client.query<{ row_hash: Buffer }>(
    "SELECT row_hash FROM audit_log WHERE workspace_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 1",
    [workspaceId, seq],
  );
  return result.rows[0]?.row_hash ?? null;
}

/**
 * One chunk of a workspace's chain, oldest first, starting at `afterSeq`
 * exclusive (or at the beginning when null).
 *
 * ⚠ KEYSET, NOT OFFSET. `OFFSET n` re-reads and re-discards n rows per chunk,
 * which turns a linear walk quadratic — and on a table whose whole point is
 * that it only ever grows, that is the wrong shape. The `(workspace_id, seq)`
 * index added by migration 0025 is what makes this one index scan per chunk.
 */
export async function readChainChunk(
  client: ClientBase,
  workspaceId: string,
  afterSeq: string | null,
  limit: number = CHAIN_CHUNK_ROWS,
): Promise<AuditChainRow[]> {
  const result = await client.query<RawAuditRow>(
    `SELECT ${ROW_COLUMNS} FROM audit_log
      WHERE workspace_id = $1 AND ($2::int8 IS NULL OR audit_log.seq > $2::int8)
      ORDER BY audit_log.seq ASC
      LIMIT $3`,
    [workspaceId, afterSeq, limit],
  );
  return result.rows.map(toAuditChainRow);
}
