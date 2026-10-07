import { createHmac, timingSafeEqual } from "node:crypto";
import {
  StripeSignatureError,
  type FetchedStripeObject,
  type StripeGateway,
  type HostedSession,
  type StripeObjectKind,
  type SubscriptionCheckoutInput,
  type VerifiedStripeEvent,
} from "../../src/lib/billing/stripe/stripe-gateway.js";

// NEW-D-2 — the fake bound in every unit and integration test. It implements
// Stripe's real signing scheme (`t=<ts>,v1=HMAC_SHA256(secret, "<ts>.<body>")`,
// 300 s tolerance) so the route is tested against bytes that were really
// signed, but it never opens a socket: NO TEST CALLS THE REAL STRIPE API.

export const FAKE_WEBHOOK_SECRET = "whsec_fake_for_tests_only";

export function signFakeStripePayload(body: string, secret = FAKE_WEBHOOK_SECRET, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export class FakeStripeGateway implements StripeGateway {
  /** What `fetchObject` answers, keyed `${kind}:${id}`. A missing key means "Stripe has no such object". */
  readonly objects = new Map<string, FetchedStripeObject>();
  readonly fetches: string[] = [];
  configured = true;
  /** Set to make the next fetch fail like an upstream outage. */
  failFetchWith: Error | undefined;

  constructor(private readonly secret = FAKE_WEBHOOK_SECRET, private readonly now: () => number = () => Date.now()) {}

  putObject(kind: StripeObjectKind, id: string, metadata: Record<string, string>, raw: Record<string, unknown> = {}): void {
    this.objects.set(`${kind}:${id}`, { kind, id, metadata, raw: { id, ...raw } });
  }

  isConfigured(): boolean {
    return this.configured;
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): VerifiedStripeEvent {
    if (signatureHeader === undefined) throw new StripeSignatureError();
    const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=", 2) as [string, string]));
    const t = Number(parts.t);
    const v1 = parts.v1;
    if (!Number.isFinite(t) || typeof v1 !== "string") throw new StripeSignatureError();
    const expected = createHmac("sha256", this.secret).update(`${t}.${rawBody.toString("utf8")}`).digest();
    const given = Buffer.from(v1, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new StripeSignatureError();
    if (Math.abs(this.now() / 1000 - t) > 300) throw new StripeSignatureError();
    const event = JSON.parse(rawBody.toString("utf8")) as { id: string; type: string; data: { object: { id: string } } };
    return { id: event.id, type: event.type, objectId: event.data.object.id };
  }

  readonly checkouts: SubscriptionCheckoutInput[] = [];
  readonly portals: Array<{ customerId: string; returnUrl: string }> = [];
  /** Session ids closed through `closeCheckoutSession`, in call order. */
  readonly expired: string[] = [];
  /** Sessions Stripe reports as already paid, with whether their subscription is still live. */
  readonly completedSessions = new Map<string, { subscriptionLive: boolean }>();

  closeCheckoutSession(sessionId: string): Promise<{ status: "expired" } | { status: "complete"; subscriptionLive: boolean }> {
    if (this.failFetchWith !== undefined) return Promise.reject(this.failFetchWith);
    const completed = this.completedSessions.get(sessionId);
    if (completed !== undefined) return Promise.resolve({ status: "complete", subscriptionLive: completed.subscriptionLive });
    this.expired.push(sessionId);
    return Promise.resolve({ status: "expired" });
  }

  createSubscriptionCheckout(input: SubscriptionCheckoutInput): Promise<HostedSession> {
    if (this.failFetchWith !== undefined) return Promise.reject(this.failFetchWith);
    this.checkouts.push(input);
    return Promise.resolve({ id: `cs_test_${String(this.checkouts.length)}`, url: `https://checkout.stripe.test/c/pay/cs_test_${String(this.checkouts.length)}` });
  }

  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    if (this.failFetchWith !== undefined) return Promise.reject(this.failFetchWith);
    this.portals.push(input);
    return Promise.resolve({ url: `https://billing.stripe.test/p/session_${input.customerId}` });
  }

  /** Fetches held open by `holdNextFetch`, keyed `${kind}:${id}`. */
  private readonly held = new Map<string, Promise<void>>();

  /**
   * Makes the NEXT fetch of this object snapshot Stripe's state now and then wait
   * for the returned release — the interleaving a stale fetch needs: the answer is
   * old by the time it is used. Returns `release`.
   */
  holdNextFetch(kind: StripeObjectKind, objectId: string): () => void {
    let release!: () => void;
    this.held.set(`${kind}:${objectId}`, new Promise<void>((resolve) => (release = resolve)));
    return release;
  }

  async fetchObject(kind: StripeObjectKind, objectId: string): Promise<FetchedStripeObject | null> {
    const key = `${kind}:${objectId}`;
    this.fetches.push(key);
    if (this.failFetchWith !== undefined) throw this.failFetchWith;
    const snapshot = this.objects.get(key) ?? null;
    const hold = this.held.get(key);
    if (hold !== undefined) {
      this.held.delete(key);
      await hold;
    }
    return snapshot;
  }
}
