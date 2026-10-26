# STORY-178 — review round 1: doc changes and open items (carry to the docs repo)

## Deploy precondition (launch checklist, owner item 6)

Production boot now REFUSES to start when the Resend pair is configured and `RESEND_WEBHOOK_SECRET` is not (fail closed: without
it no bounce or complaint is heard). Add to the launch checklist, as a merge/deploy precondition for any environment that has
Resend configured: provision `RESEND_WEBHOOK_SECRET` (the endpoint's Svix signing secret) and register the Resend webhook
(`POST /v1/webhooks/resend`, events `email.bounced` and `email.complained`) BEFORE rolling out this change.

## Mail classification (owner decision 8) — needs the owner's confirmation

Decision 8 names reports, digests and alerts as the mail a complaint suppresses. Billing notices are not in that list, so this
change marks them `transactional: true`: the auto top-up "triggered" and "disabled" notices and the downgrade pause/resume
notice. A spam complaint therefore no longer stops them; a hard bounce still does (nothing can be delivered). If the owner
wants billing notices non-transactional, remove the flag in `auto-topup.service.ts` and `billing-downgrade-notice.handler.ts`.
Add "billing notices" to the transactional set in decision 8 and `references/` if confirmed.

## Pepper (documented, no code defect)

* Suppressions are keyed on `OTP_EMAIL_HASH_PEPPER`. Rotating it silently voids every suppression and the operator command can
  no longer lift them (see the comment in migration 0141). There is no rotation procedure: add one to the runbook (re-hash
  before rotating is impossible, the addresses are not stored; keep the old pepper for suppression lookups, or accept the loss).
* The API (webhook writer) and the report worker (sender) must run the SAME pepper. A boot check that both agree, or a dedicated
  suppression pepper, is the follow-up (a new secret is a decision, so not done here).
* Oracle (decision 9, platform-wide): a workspace can learn whether an address is suppressed somewhere on the platform by adding
  it as a recipient and reading the delivery reason or the fan-out notification. Accepted by decision 9; record it in the
  STORY-178 evidence.

## Open: a terminal "suppressed" state for the outbox rows (STOPPED, needs an owner decision)

`notify.dispatch` and `billing.downgrade_notice` now end normally on a suppressed recipient (no retry ladder, no dead-letter
entry, counted `suppressed`). The outbox row cannot yet be SETTLED as suppressed: `notification_emails.status` has no such value
(`ck_notification_emails_status`) and `downgrade_notices` has only `sent_at`. Adding either is a schema change STORY-178 does not
name. Until it lands, each such row stays unsent and its relay re-offers it every five minutes until `*_RELAY_MAX_AGE` (23 h),
then it is counted `abandoned`. Proposed: migration adding `'suppressed'` to the `notification_emails` status CHECK (and a
`suppressed_at` on `downgrade_notices`), relays skipping them.

## Auto top-up and a hard bounce

With the billing contact hard-bounced, `AutoTopupService.trigger` returns `email_failed` (the pre-charge email is refused, so
nobody is charged), the purchase is marked failed and auto top-up stays enabled. Nothing tells the workspace; `trigger` is not
yet wired to the debit path (see NEW-D-7), so a notification kind for this belongs with that wiring.
