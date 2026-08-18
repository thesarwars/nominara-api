// STORY-014 Technical Notes: "the sign-counter check is the one piece of
// logic that is genuinely ours." Everything else about a WebAuthn ceremony
// is delegated to @simplewebauthn/server; this is pure business policy on
// top of the counter value it returns, kept isolated and independently
// tested rather than folded into identity.service.ts's I/O.
//
// Pure — no clock, no randomness, no I/O.

export type SignCounterDecision = "accept" | "clone-signal";

/**
 * `stored` — the credential's last-known sign_count.
 * `reported` — the counter value the authenticator reported on this assertion.
 * `hasEverReportedNonZero` — whether any prior assertion from this credential
 * reported a nonzero counter. Some authenticators always report zero; those
 * stay exempt from the increasing-counter rule for as long as they keep
 * reporting zero. The moment one reports nonzero, every subsequent report
 * must be strictly greater than the stored value, including a report back
 * down to zero.
 */
export function nextCounter(stored: bigint, reported: bigint, hasEverReportedNonZero: boolean): SignCounterDecision {
  if (!hasEverReportedNonZero && reported === 0n) {
    return "accept";
  }
  return reported > stored ? "accept" : "clone-signal";
}
