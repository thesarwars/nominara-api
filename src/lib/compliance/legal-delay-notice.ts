// Owner decision 70(f) - the subject-facing "erasure delayed for a legal reason" notice.
//
// A DRAFT. It has not been reviewed by legal and must not be sent to a data subject as it stands. The operator CLIs print it (hold place, and an
// erasure that was deferred) so the wording an operator would send is the wording under review, not text improvised at the time. The statutory
// deadline and the supervisory-authority sentence are left for legal to supply: guessing a legal claim in a draft is how it ends up sent.
//
// The only substitution is `{{request_id}}`. The notice names no workspace, no matter and no reason: the hold's reason is operator-written text
// about a legal matter and never leaves `legal_holds`.

export const LEGAL_DELAY_NOTICE_DRAFT_MARKER = "Draft — pending legal review";

export const LEGAL_DELAY_NOTICE_DRAFT = [
  LEGAL_DELAY_NOTICE_DRAFT_MARKER,
  "",
  "Subject: Your erasure request {{request_id}} is delayed for a legal reason",
  "",
  "We have received your request to erase your personal data (reference {{request_id}}).",
  "",
  "We cannot carry it out yet. A legal hold covers a workspace you belong to, and we are required to keep the records it covers while the hold lasts.",
  "We are not able to give details of the matter.",
  "",
  "Your request has not been lost. It is queued, nothing about you has been changed, and it will run automatically when the hold is released or expires.",
  "We will write to you when it has run. If you want to know where it stands, reply quoting the reference above.",
  "",
  "[Legal to confirm: the statutory deadline and any extension notice; the sentence on the right to complain to the supervisory authority; the sender and signature.]",
].join("\n");

/** The draft with the subject's erasure request id filled in (the only substitution). */
export function renderLegalDelayNotice(requestId: string): string {
  return LEGAL_DELAY_NOTICE_DRAFT.replaceAll("{{request_id}}", requestId);
}
