import { z } from "zod";
import { ledgerUnitDetailSchema } from "./ledger-unit-detail.schema.js";

// STORY-073 AC12 — `GET /v1/billing/wallet/ledger`. api-specification.md §3:
// "cursor over credit_ledger; filter by action, project, actor, date; CSV
// export".
//
// ⚠ `seq` IS NOT EXPOSED. It is an internal ordering fact — see migration
// 0023 — and publishing it would make the row's position in a global
// sequence a thing customers could count, compare across workspaces, and
// infer our volume from. `occurred_at` is what a person reads a history by.

export const LEDGER_ENTRY_TYPES = [
  "grant",
  "purchase",
  "reserve",
  "commit",
  "release",
  "refund",
  "expire",
  "adjustment",
] as const;

export const LEDGER_ACTION_CODES = [
  "lookup",
  "manual_scan",
  "nlp_command",
  "aux_manual",
  "prompt_activate",
  "other",
] as const;

export const creditLedgerEntrySchema = z
  .object({
    id: z.string().uuid(),
    entry_type: z.enum(LEDGER_ENTRY_TYPES),
    /** Null on the entries that are not about an action — a grant, a purchase, an expiry. */
    action_code: z.enum(LEDGER_ACTION_CODES).nullable(),
    /**
     * A positive magnitude for every type but `adjustment`, which carries its
     * direction in the sign. `ck_credit_ledger_credits_sign` is what makes
     * that a guarantee rather than a convention.
     */
    credits: z.number().int(),
    /** Which balance moved. Null on `reserve`/`commit`/`release`, which move `reserved`. */
    bucket: z.enum(["included", "purchased"]).nullable(),

    /** The balances AFTER this entry — what makes the history reconstructable by eye, not just by replay. */
    included_after: z.number().int().nonnegative(),
    purchased_after: z.number().int().nonnegative(),
    reserved_after: z.number().int().nonnegative(),

    /**
     * ⚠ NULL FOR AN API KEY AS WELL AS FOR THE SYSTEM, and `actor_type` is
     * what tells the two apart. An API key is a workspace credential; saying
     * a person spent when a key did would put a name against an action they
     * did not take.
     */
    actor_id: z.string().uuid().nullable(),
    /**
     * Set only once the person has been erased, and then `actor_id` is null —
     * `ck_credit_ledger_actor_exclusive` makes the two mutually exclusive.
     *
     * ⚠ IT IS RETURNED RATHER THAN HIDDEN, because the whole reason it
     * survives erasure is that somebody disputing an invoice can still group
     * one person's charges together. A field kept for that purpose and then
     * withheld from the only screen that would use it keeps the data without
     * the justification for keeping it.
     */
    actor_pseudonym: z.string().uuid().nullable(),
    actor_type: z.enum(["user", "api_key", "system"]),
    project_id: z.string().uuid().nullable(),
    reference_type: z.string().nullable(),
    reference_id: z.string().uuid().nullable(),

    unit_detail: ledgerUnitDetailSchema,
    /** Required on an `adjustment` and null everywhere else — `ck_credit_ledger_adjustment_reason`. */
    reason: z.string().nullable(),
    occurred_at: z.string(),
    /**
     * STORY-073 AC9 - what serving this entry cost US, in USD, as a decimal string (`numeric(10,6)`, never a float).
     * Set on a `commit` entry only; null everywhere else.
     *
     * ⚠ NULL IS "NOT MEASURED" AND "0.000000" IS "MEASURED, AND IT COST NOTHING". They are different statements and
     * the field never turns one into the other: a commit whose run has no costed usage row reads null.
     */
    internal_cost_usd: z.string().nullable(),
  })
  .strict();

export type CreditLedgerEntry = z.infer<typeof creditLedgerEntrySchema>;

export const creditLedgerListResponseSchema = z.array(creditLedgerEntrySchema);
export type CreditLedgerListResponse = z.infer<typeof creditLedgerListResponseSchema>;
