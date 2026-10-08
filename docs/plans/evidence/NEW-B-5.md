# NEW-B-5 evidence — POST/DELETE /v1/workspaces/{id}/transfer-ownership: NOT STARTED, awaiting the owner decision

Status: blocked at the story's own first acceptance criterion. Nothing is built; no RED commit; no gates to run for this item.

## Why

The first acceptance criterion in track-plans.json reads "Owner decision required before start; otherwise defer whole story to week 2". The planner's
open question (track-plans.json, open questions) is: "Ownership transfer: EC-15 calls it the single most dangerous multi-tenant operation. Approve
'initiate + cancel only' for week 1, or defer entirely to week 2." Neither the approved owner decisions (2026-10-07) nor the NEW decisions (2026-10-08)
answer it, and checkpoint-2-findings.json holds no answer. The "planner recommendation" fallback does not substitute for a decision that the story
itself says must be made by the owner, on what EC-15 calls the single most dangerous multi-tenant operation. So the story is deferred, not built.

## Acceptance criteria and their state

| Criterion | State |
|---|---|
| Owner decision before start, else defer | no decision recorded; deferred |
| `contracts/workspaces/transfer-ownership-request.schema.ts` in own commit | not built |
| EC-15 pre-flight (owner + step-up <= 5 min; recipient active admin, verified email; recipient owns nothing else -> 409 workspace_limit_reached) | not built |
| State none -> initiated/awaiting_acceptance under SELECT ... FOR UPDATE; cancel -> cancelled; audited | not built |
| No role swap, credential, share-token or billing handover | holds trivially (nothing exists) |
| dangerous-area-auditor review | n/a, no code |

## To start (one reply from the owner)

1. Approve "initiate + cancel only" for week 1.
2. Confirm the pre-flight subset. EC-15 also requires the recipient to have a strong authenticator enrolled and checks billing (no past-due invoice,
   payment method); the story's subset lists neither. Say whether they are in or out of this slice.
3. Confirm the existing `ownership-transfer.schema.ts` field names (initiatedBy/recipientId) stay, while the request body is `{recipient_id}` (the
   frontend currently sends `{to_user_id}`).

The lane's migration range (0096-0097) is not needed: the story names no schema change.
