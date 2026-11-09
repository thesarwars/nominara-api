import { signState, verifyState } from "../../lib/auth/oauth-state.js";

// STORY-115 - the OAuth `state` for the Search Console connect flow.
//
// STATELESS BY DESIGN, so no table is added: the state carries everything the callback needs (workspace, project, the member who
// started it, the property, an expiry and the digest of the browser-binding cookie) and is HMAC-signed with the existing OAuth state
// secret, so it cannot be forged or altered. Google's authorisation code is itself single-use, which is what makes a replayed callback
// harmless: the second exchange is refused by Google, and a repeat of a completed one meets the one-active-connection rule.
//
// The binding digest ties the state to the browser that started the flow (the same cookie the sign-in flow sets): a state lifted from a
// redirect URL and replayed from another browser has no cookie to match, which is what stops one person's grant being attached to
// another's workspace.

export const GSC_STATE_TTL_MS = 10 * 60 * 1000;

export interface GscStatePayload {
  /** workspace id */
  readonly w: string;
  /** project id */
  readonly p: string;
  /** actor (the member who started the flow) */
  readonly a: string;
  /** property, as stored */
  readonly u: string;
  /** expiry, epoch milliseconds */
  readonly e: number;
  /** hex SHA-256 of the binding cookie value */
  readonly b: string;
}

export function signGscState(payload: GscStatePayload, secret: string): string {
  return signState(Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"), secret);
}

/** The payload, or `null` for anything malformed, forged or expired. Never throws. */
export function verifyGscState(token: string, secret: string, nowMs: number): GscStatePayload | null {
  const body = verifyState(token, secret);
  if (body === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<GscStatePayload>;
    if (typeof parsed.w !== "string" || typeof parsed.p !== "string" || typeof parsed.a !== "string" || typeof parsed.u !== "string" || typeof parsed.b !== "string" || typeof parsed.e !== "number") return null;
    if (parsed.e <= nowMs) return null;
    return { w: parsed.w, p: parsed.p, a: parsed.a, u: parsed.u, e: parsed.e, b: parsed.b };
  } catch {
    return null;
  }
}
