import type { StripeUpstreamError } from "./stripe-gateway.js";

/**
 * Stripe answered and did not apply the change: a 4xx that is not a timeout (408), an in-flight conflict (409) or a
 * rate limit (429), and not `idempotency_error`. That one is also a 400, but it says the key was reused with a
 * DIFFERENT call, i.e. the original call under it may have been applied: it proves nothing about the change.
 *
 * Shared by the add-on purchase and the plan change: both release a recorded intent on a definite rejection and keep it
 * (for a replay under the same Stripe key) on anything else.
 */
export function isDefiniteRejection(error: StripeUpstreamError): boolean {
  const { statusCode, errorType } = error;
  return statusCode !== undefined && statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 409 && statusCode !== 429 && errorType !== "idempotency_error";
}
