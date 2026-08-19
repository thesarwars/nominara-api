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
