import type { ClientBase } from "pg";
import type { CreditLedgerEntry, CreditLedgerQuery } from "../../../contracts/billing/index.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";

// STORY-073 AC12 — reading the ledger back.
//
// ⚠ NEWEST FIRST, BY `occurred_at` AND NOT BY `seq`, and the two orderings
// genuinely differ. Migration 0023 added `seq` precisely because `occurred_at`
// is transaction-start time and misorders concurrent movements — which is the
// right call for REPLAY, where a wrong order pages a human at 3am. It is the
// wrong call here. A person reading their own credit history reads it by
// when things happened; ordering their statement by an internal sequence
// would put a 12:00:00.010 entry above a 12:00:00.000 one with no visible
// reason, and "the second one took the row lock first" is not an explanation
// anybody wants in a billing screen.
//
// `seq` is still the tiebreaker, so the page boundary is stable when two
// entries share a timestamp — which they do, routinely, because a reserve
// and its commit inside one transaction share `now()`.

interface LedgerRow {
  id: string;
  entry_type: CreditLedgerEntry["entry_type"];
  action_code: CreditLedgerEntry["action_code"];
  credits: string;
  bucket: CreditLedgerEntry["bucket"];
  included_after: string;
  purchased_after: string;
  reserved_after: string;
  actor_id: string | null;
  actor_type: CreditLedgerEntry["actor_type"];
  project_id: string | null;
  reference_type: string | null;
  reference_id: string | null;
  unit_detail: CreditLedgerEntry["unit_detail"];
  reason: string | null;
  occurred_at_key: string;
  seq_key: string;
}

function toEntry(row: LedgerRow): CreditLedgerEntry {
  return {
    id: row.id,
    entry_type: row.entry_type,
    action_code: row.action_code,
    credits: Number(row.credits),
    bucket: row.bucket,
    included_after: Number(row.included_after),
    purchased_after: Number(row.purchased_after),
    reserved_after: Number(row.reserved_after),
    actor_id: row.actor_id,
    actor_type: row.actor_type,
    project_id: row.project_id,
    reference_type: row.reference_type,
    reference_id: row.reference_id,
    unit_detail: row.unit_detail,
    reason: row.reason,
    occurred_at: row.occurred_at_key,
  };
}

/**
 * One page of a workspace's credit history.
 *
 * ⚠ NO `workspace_id` PREDICATE, AND THAT IS NOT AN OVERSIGHT. RLS scopes
 * this to the context's workspace, and `query-guard.ts` refuses a tenant
 * table read on a connection with no context at all. Adding the filter here
 * would make the query look safe on a connection where it is not, which is
 * the habit that produces a cross-tenant read the first time someone copies
 * it somewhere the context is missing.
 *
 * ⚠ THE `_key` ALIASES BELOW ARE LOAD-BEARING. PostgreSQL lets ORDER BY
 * resolve to an OUTPUT COLUMN ALIAS, and WHERE never does. Spelling the
 * casts as "seq::text" aliases them straight back onto their own column
 * names, so ORDER BY sorted the TEXT while the keyset predicate compared the
 * BIGINT. Text ordering puts "9" above "10": the tenth entry was skipped
 * outright and the page after it came back short — rows silently missing
 * from a customer's billing history, which is the precise failure
 * NFR-API-03 exists to prevent. Found by the paging test, not by reading.
 *
 * ⚠ AND THE DATE FILTERS ARE HALF-OPEN IN SQL THOUGH THE CONTRACT IS
 * INCLUSIVE. `to = '2026-09-16'` means "the whole of the 16th", so the
 * predicate is `< the 17th` rather than `<= the 16th` — the latter compares a
 * timestamptz against midnight and silently drops everything after it, which
 * is a whole day of a customer's history missing from a statement they asked
 * for by date.
 */
export async function readLedgerPage(
  tx: ClientBase,
  query: CreditLedgerQuery,
): Promise<Page<CreditLedgerEntry>> {
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, 2);

  const result = await tx.query<LedgerRow>(
    `SELECT id, entry_type, action_code, credits::text, bucket,
            included_after::text, purchased_after::text, reserved_after::text,
            actor_id, actor_type, project_id, reference_type, reference_id,
            unit_detail, reason,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at_key,
            seq::text AS seq_key
       FROM credit_ledger
      WHERE ($1::text IS NULL OR action_code = $1)
        AND ($2::uuid IS NULL OR project_id = $2)
        AND ($3::uuid IS NULL OR actor_id = $3)
        AND ($4::text IS NULL OR entry_type = $4)
        AND ($5::date IS NULL OR occurred_at >= $5::date)
        AND ($6::date IS NULL OR occurred_at < ($6::date + 1))
        AND ($7::timestamptz IS NULL
             OR (occurred_at, seq) < ($7::timestamptz, $8::bigint))
      ORDER BY occurred_at DESC, seq DESC
      LIMIT $9`,
    [
      query.action ?? null,
      query.project_id ?? null,
      query.actor_id ?? null,
      query.entry_type ?? null,
      query.from ?? null,
      query.to ?? null,
      after?.[0] ?? null,
      after?.[1] ?? null,
      query.limit + 1,
    ],
  );

  // The tuple the query ORDERED BY, in the same order — `pageFrom`'s own
  // contract, and the reason the key is passed in rather than guessed at.
  return pageFrom(result.rows, query.limit, toEntry, (row) => [row.occurred_at_key, row.seq_key]);
}

/**
 * A page of entries, as CSV.
 *
 * ⚠ NO ROUTE CALLS THIS YET, and that is a decision rather than an oversight.
 * A synchronous `ledger.csv` route was built and removed: it required
 * `@NoEnvelope()`, which an architectural gate reserves for the health
 * probes, and it carried no `exports.csv` entitlement check though CSV
 * export is a plan feature Free and Starter do not have. The export belongs
 * in `POST /exports`'s async pipeline (api-specification.md §3), which has
 * both the gate and the artifact store. This is the serialiser that pipeline
 * will call, landed with the story that knows the ledger's shape rather than
 * left for the one that knows the worker's.
 *
 * ⚠ EVERY FIELD IS QUOTED AND EVERY QUOTE IS DOUBLED, including the ones
 * that "cannot" contain a comma. `reason` is free text a human wrote, so it
 * certainly can; and a formula-shaped value in a spreadsheet is a known
 * injection path, which is why a leading `=`, `+`, `-` or `@` is prefixed
 * with a tab. A billing export is exactly the file somebody opens in Excel.
 */
export function toLedgerCsv(entries: readonly CreditLedgerEntry[]): string {
  const header = [
    "occurred_at",
    "entry_type",
    "action_code",
    "credits",
    "bucket",
    "included_after",
    "purchased_after",
    "reserved_after",
    "actor_type",
    "actor_id",
    "project_id",
    "reference_type",
    "reference_id",
    "prompts",
    "engines",
    "cells_charged",
    "cells_cached",
    "reason",
  ];

  const rows = entries.map((entry) => [
    entry.occurred_at,
    entry.entry_type,
    entry.action_code ?? "",
    String(entry.credits),
    entry.bucket ?? "",
    String(entry.included_after),
    String(entry.purchased_after),
    String(entry.reserved_after),
    entry.actor_type,
    entry.actor_id ?? "",
    entry.project_id ?? "",
    entry.reference_type ?? "",
    entry.reference_id ?? "",
    entry.unit_detail === null ? "" : String(entry.unit_detail.prompts),
    entry.unit_detail === null ? "" : String(entry.unit_detail.engines),
    entry.unit_detail === null ? "" : String(entry.unit_detail.cells_charged),
    entry.unit_detail === null ? "" : String(entry.unit_detail.cells_cached),
    entry.reason ?? "",
  ]);

  // CRLF, because RFC 4180 says so and because Excel on Windows treats a
  // bare LF file as one long row.
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\r\n") + "\r\n";
}

const FORMULA_PREFIXES = new Set(["=", "+", "-", "@"]);

function csvField(value: string): string {
  const guarded = FORMULA_PREFIXES.has(value.slice(0, 1)) ? `\t${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}
