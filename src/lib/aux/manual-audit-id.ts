import { createHash } from "node:crypto";
import { AUX_AUDIT_REFERENCE } from "../credits/aux-audit-refund.js";

// AUXLIVE-3 (review round 1, critical) - the identity of a MANUAL audit, derived from the caller's `Idempotency-Key`.
//
// A random id per execution meant the ledger could never refuse a replay: the Valkey `IdempotencyInterceptor` is the only guard, and it is documented to fail
// open (allkeys-lru; an evicted or unreadable record degrades to executing). With the audit id and the ledger key both a function of (workspace, client key),
// a replay is refused by the DATABASE whatever the cache holds: `ux_credit_ledger_idem` refuses the second reserve, and the `aux_audits` primary key refuses
// the second row. The workspace is part of the hash, so one tenant's key never collides with another's, and neither the workspace nor the key appears in
// the ledger key in clear.

/** Namespace for the derived id: changing it changes every manual audit's id, so it is versioned. */
const MANUAL_AUDIT_NAMESPACE = "nominara.aux.manual-audit.v1";

/**
 * OWNER DECISION 48: an `Idempotency-Key` is honoured for 24 hours, as on every paid action (api-specification.md section 1). The database-backed replay of a manual
 * audit is bounded by the audit's own `created_at`: inside the window the key's audit is replayed, after it the same key starts a NEW audit.
 */
export const IDEMPOTENCY_REPLAY_WINDOW_HOURS = 24;

export interface ManualAuditIdentity {
  /** The `aux_audits` primary key: a version-5-shaped UUID (the `crawl.audit` job contract requires a UUID). */
  readonly auditId: string;
  /** The credit ledger's idempotency key, in the server-reserved `aux_audit:` namespace. */
  readonly ledgerKey: string;
}

/** Namespace for a key's LATER generations; the generation sits before the key, so no key can imitate one. */
const MANUAL_AUDIT_GENERATION_NAMESPACE = "nominara.aux.manual-audit.v1.generation";

/**
 * `generation` counts how many replay windows the client's key has outlived: 0 is the identity as it has always been (every audit already made keeps its id and
 * its ledger key), and each later one is a new audit id and a new ledger key, so the unique indexes that refuse a replay inside a window do not refuse the new
 * audit after it.
 */
export function manualAuditIdentity(workspaceId: string, clientKey: string, generation = 0): ManualAuditIdentity {
  const parts = generation === 0 ? [MANUAL_AUDIT_NAMESPACE, workspaceId, clientKey] : [MANUAL_AUDIT_GENERATION_NAMESPACE, workspaceId, String(generation), clientKey];
  const digest = createHash("sha256").update(parts.join("|")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const auditId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
  // join, not a template: ISO-13's scanner reads a colon-separated template as a cache key lacking its namespace, and this is a ledger key.
  return { auditId, ledgerKey: [AUX_AUDIT_REFERENCE, digest.toString("hex")].join(":") };
}
