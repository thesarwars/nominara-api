import type { WalletMismatch } from "../../../lib/credits/replay.js";

// STORY-073 D-1 — port for the nightly wallet verifier's paging. Real target
// is PagerDuty; no paging client exists in this repo yet, so production
// wiring is a disclosed gap, exactly as STORY-020's audit-chain verifier
// left it (STORY-020-E-4).
//
// ⚠ NOT `modules/audit`'s `PagingNotifier`, and the reason is the payload
// rather than tidiness. That port's alert is `{workspaceId, seq, reason}`,
// which is the right amount for "this hash does not chain" and not enough
// for "this wallet is wrong": the two balances are what tell the person
// woken up whether they are looking at 3 credits or 30,000, and whether the
// wallet is high or low. Sharing the interface would have meant either
// widening the audit alert with billing fields or paging without the numbers.
//
// What it still does NOT carry is any row content — no actor, no reference,
// no request key. Enough to locate and triage, matching the
// no-raw-content-in-logs rule.

export interface WalletPagingNotifier {
  page(mismatch: WalletMismatch): Promise<void>;
}
