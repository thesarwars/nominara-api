import { randomUUID } from "node:crypto";
import type { ComplianceExportRow, ComplianceExportTable } from "../../workers/rollup/retention.js";
import { pseudonymiseWorkspaceId } from "../crypto/pseudonymise.js";
import type { KeyListingPort, ObjectStoragePort } from "../storage/storage.port.js";
import type { JournalStore } from "./purge-journal.js";

// STORY-111 - the object-storage halves of the retention purge.
//
// 1. S3JournalStore: the purge journal in the RAW bucket under `purge-journal/{env}/`, a prefix no workspace prefix (`{env}/{ws}/`) can
//    reach, so neither a workspace purge nor an object-prefix delete can remove its own record. Every entry is a new key (a UUID is in the
//    name); nothing here overwrites or deletes.
// 2. writeComplianceExports: the two surviving record sets (audit log; financial records = credit ledger, invoices, subscriptions, add-ons, credit purchases), written BEFORE the cascade by
//    executeWorkspaceHardDelete. Each object carries its expiry (`expires_at`, 7 years) and a retention-class prefix, which is what the
//    bucket's lifecycle rule keys on: "a retention with no end is not a retention" (data-model.md section 7). The lifecycle rule and the
//    Object Lock configuration themselves are infrastructure (owner decision 45: Terraform parked); this code is what they act on.

export class S3JournalStore implements JournalStore {
  constructor(private readonly port: ObjectStoragePort & KeyListingPort) {}
  async putNew(key: string, body: string): Promise<void> {
    await this.port.put({ bucket: "raw", key, body, contentType: "application/json" });
  }
  list(prefix: string): Promise<readonly string[]> {
    return this.port.listKeys("raw", prefix);
  }
  async get(key: string): Promise<string> {
    return (await this.port.get("raw", key)).toString("utf8");
  }
}

/** Statutory accounting retention and the audit-log retention are both seven years (data-model.md section 7). */
export const COMPLIANCE_EXPORT_RETENTION_YEARS = 7;

const FINANCIAL_PREFIX = "compliance-exports/financial/";

/** One retention-class prefix per exported table. The financial records (data-model.md section 7: ledger, invoices, subscription state) share one. */
export const COMPLIANCE_EXPORT_CLASSES: Readonly<Record<ComplianceExportTable, string>> = {
  audit_log: "compliance-exports/audit-log/",
  credit_ledger: FINANCIAL_PREFIX,
  invoices: FINANCIAL_PREFIX,
  subscriptions: FINANCIAL_PREFIX,
  subscription_addons: FINANCIAL_PREFIX,
  credit_purchases: FINANCIAL_PREFIX,
};

/** The columns of each financial table that name a PERSON. Each is replaced by a random per-export alias; nothing else in these tables identifies one. */
const PERSON_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  credit_ledger: ["actor_id"],
  credit_purchases: ["purchased_by"],
  subscription_addons: ["created_by"],
};

export function complianceExpiry(now: Date): Date {
  const expiry = new Date(now.getTime());
  expiry.setUTCFullYear(expiry.getUTCFullYear() + COMPLIANCE_EXPORT_RETENTION_YEARS);
  return expiry;
}

/**
 * Returns the `exportComplianceRecords` callback. Keys use the PSEUDONYMISED workspace id, never the literal one, so the surviving object
 * does not name the erased tenant. Every row of the financial export has `actor_id` pseudonymised ("actor IDs pseudonymised").
 */
export function writeComplianceExports(
  port: ObjectStoragePort,
  keyEnv: string,
  workspaceId: string,
  now: () => Date = () => new Date(),
): (records: readonly ComplianceExportRow[]) => Promise<void> {
  return async (records) => {
    const at = now();
    const expiresAt = complianceExpiry(at).toISOString();
    const pseudonym = pseudonymiseWorkspaceId(workspaceId);
    for (const record of records) {
      // A RANDOM per-export mapping, not a hash: a hash of an identifier that survives in `users` is a pseudonym anyone holding `users` can
      // brute-force (see pseudonymise.ts). Rows of one actor still group together inside the export; nothing maps back.
      const actors = new Map<string, string>();
      const actorPseudonym = (id: unknown): string | null => {
        if (id === null || id === undefined) return null;
        const key = String(id);
        let alias = actors.get(key);
        if (alias === undefined) {
          alias = randomUUID();
          actors.set(key, alias);
        }
        return alias;
      };
      const rows =
        record.table === "audit_log"
          ? record.rows
          : record.rows.map((row) => {
              const out: Record<string, unknown> = { ...row, workspace_id: pseudonym };
              for (const column of PERSON_COLUMNS[record.table] ?? []) if (column in out) out[column] = actorPseudonym(out[column]);
              return out;
            });
      await port.put({
        bucket: "raw",
        key: `${COMPLIANCE_EXPORT_CLASSES[record.table]}${keyEnv}/${pseudonym}/${at.toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
        body: JSON.stringify({ table: record.table, exported_at: at.toISOString(), rows }),
        contentType: "application/json",
        metadata: { expires_at: expiresAt, retention_class: record.table === "audit_log" ? "audit-log-7y" : "financial-7y" },
      });
    }
  };
}
