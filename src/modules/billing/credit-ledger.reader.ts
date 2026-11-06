import type { ClientBase } from "pg";
import type { CreditLedgerEntry, CreditLedgerQuery } from "../../../contracts/billing/index.js";
import { ValidationFailedError } from "../../api/errors/domain-errors.js";
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
  actor_pseudonym: string | null;
  actor_type: CreditLedgerEntry["actor_type"];
  project_id: string | null;
  reference_type: string | null;
  reference_id: string | null;
  unit_detail: CreditLedgerEntry["unit_detail"];
  reason: string | null;
  /** What the contract publishes — millisecond precision, which is what a person reads. */
  occurred_at: string;
  /**
   * ⚠ MICROSECONDS, AND IT IS A DIFFERENT COLUMN FROM `occurred_at` FOR A
   * REASON THAT COST ROWS. `pageFrom`'s contract is that the cursor key is
   * the tuple the query ORDERED BY. `occurred_at` is `timestamptz` — `now()`
   * routinely lands on a microsecond like `...525873` — and the published
   * value truncates to milliseconds. Keying the cursor on the truncated
   * value made the keyset predicate exclude every row whose real timestamp
   * sat between the truncated cursor and the row it was taken from: with
   * four entries in one millisecond and a page boundary between them, one
   * debit was returned by NO page and `has_more` still went false. A
   * customer paging to completion got a history whose total was wrong, with
   * no error.
   *
   * Two ledger writes land in the same millisecond whenever two requests
   * settle together, which is ordinary rather than contrived — and the
   * previous paging tests could not see it, because they seed whole seconds
   * or one identical timestamp for every row.
   */
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
    actor_pseudonym: row.actor_pseudonym,
    actor_type: row.actor_type,
    project_id: row.project_id,
    reference_type: row.reference_type,
    reference_id: row.reference_id,
    unit_detail: row.unit_detail,
    reason: row.reason,
    occurred_at: row.occurred_at,
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
 * ⚠ THE `_key` COLUMNS ARE THE CURSOR'S, AND THEY ARE NOT THE PUBLISHED
 * ONES. Two separate defects taught this, both of them rows silently missing
 * from a customer's billing history — the precise failure NFR-API-03 exists
 * to prevent, and neither visible as an error:
 *
 *   ORDER BY resolves to an OUTPUT COLUMN ALIAS and WHERE never does. Written
 *   as "seq::text", the cast aliases straight back onto `seq`, so the
 *   ordering compared TEXT while the keyset compared BIGINT — and text puts
 *   "9" above "10", so the tenth entry was skipped outright.
 *
 *   The cursor key must be the value the query ORDERED BY, at the SAME
 *   resolution. `occurred_at` is published at millisecond precision because
 *   that is what a person reads; ordering happens on the full timestamptz.
 *   Keying the cursor on the truncated value dropped every row sharing a
 *   millisecond with the page boundary.
 *
 * So the cursor gets its own full-precision columns, and the published
 * `occurred_at` stays readable. Both were found by tests rather than by
 * reading this query.
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
  const after = query.cursor === undefined ? undefined : cursorKeyOf(query.cursor);

  const result = await tx.query<LedgerRow>(
    `SELECT id, entry_type, action_code, credits::text, bucket,
            included_after::text, purchased_after::text, reserved_after::text,
            actor_id, actor_pseudonym, actor_type, project_id, reference_type, reference_id,
            unit_detail, reason,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
            to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_key,
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
  return pageFrom(result.rows, query.limit, "billing.credit_ledger", toEntry, (row) => [row.occurred_at_key, row.seq_key]);
}

/**
 * A page of entries, as CSV.
 *
 * STORY-073 AC10: `BillingService.ledgerExport` calls this for `GET /billing/wallet/ledger/export`, which carries the
 * `exports.csv` entitlement check and the normal response envelope. The earlier synchronous `ledger.csv` route needed
 * `@NoEnvelope()` and had neither.
 *
 * ⚠ EVERY FIELD IS QUOTED AND EVERY QUOTE IS DOUBLED, including the ones
 * that "cannot" contain a comma. `reason` is free text a human wrote, so it
 * certainly can.
 *
 * ⚠ AND THE FORMULA GUARD IS ON THE TEXT FIELDS ONLY, WHICH IT WAS NOT. A
 * leading `=`, `+`, `-` or `@` makes Excel treat a cell as a formula, so
 * those are tab-prefixed — but the first version applied that to EVERY
 * column including `credits`, which is a signed integer. `"\t-40"` imports
 * as TEXT, so a SUM over the credits column silently omitted every clawback
 * and negative adjustment while including every positive one: a billing
 * export that does not add up, which is the one thing a billing export has
 * to do. The test even asserted that output while its comment claimed the
 * opposite.
 *
 * The server generates the numeric columns, so none of them can carry a
 * formula in the first place. Only what a person typed needs defusing.
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
    "actor_pseudonym",
    "project_id",
    "reference_type",
    "reference_id",
    "prompts",
    "engines",
    "cells_charged",
    "cells_cached",
    "reason",
  ];

  // Which columns hold something a person wrote, or an identifier that could
  // begin with one of the formula characters. Everything else is a
  // server-generated number or a closed enum.
  const guarded = new Set(["action_code", "entry_type", "bucket", "actor_type", "reference_type", "reason"]);

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
    entry.actor_pseudonym ?? "",
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
  const render = (row: readonly string[]): string =>
    row.map((value, column) => csvField(value, guarded.has(header[column]!))).join(",");

  return [header.map((name) => csvField(name, false)).join(","), ...rows.map(render)].join("\r\n") + "\r\n";
}

/**
 * Decode the cursor AND check that its elements are the two things this
 * list is keyed on.
 *
 * ⚠ `decodeCursor` PINS ARITY, NOT TYPES, and the gap is reachable from a
 * URL a person can edit. `cursorPayloadSchema` permits null and integer
 * elements, so a two-element cursor of the wrong shape decoded cleanly and
 * then either rewound the page — `(occurred_at, seq) < (NULL, NULL)` is
 * NULL, the predicate drops out, and page one comes back forever, so a
 * paging loop never terminates — or reached Postgres as `invalid input
 * syntax for type timestamp with time zone`, which is a 500 from a query
 * string. `decodeCursor`'s own comment says it exists to prevent exactly the
 * first of those.
 */
function cursorKeyOf(cursor: string): [string, string] {
  const key = decodeCursor(cursor, "billing.credit_ledger", 2);
  const [occurredAt, seq] = key;
  if (typeof occurredAt !== "string" || !ISO_MICROS.test(occurredAt) || typeof seq !== "string" || !DIGITS.test(seq)) {
    throw new ValidationFailedError({
      message: "invalid pagination cursor",
      details: { issues: [{ path: ["cursor"], message: "cursor was not issued for this list" }] },
    });
  }
  return [occurredAt, seq];
}

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const DIGITS = /^\d{1,19}$/u;

const FORMULA_PREFIXES = new Set(["=", "+", "-", "@"]);

function csvField(value: string, defuse: boolean): string {
  const safe = defuse && FORMULA_PREFIXES.has(value.slice(0, 1)) ? `\t${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
