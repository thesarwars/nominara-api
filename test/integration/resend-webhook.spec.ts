import { createHmac, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { IS_PUBLIC_KEY } from "../../src/api/decorators/public.decorator.js";
import { SKIP_TENANT_CONTEXT_KEY } from "../../src/api/decorators/skip-tenant-context.decorator.js";
import { hashEmailKey, normalizeEmail } from "../../src/lib/auth/email-otp.js";
import { PgSuppressionStore } from "../../src/lib/email/suppression-store.js";
import { SuppressingEmailSender } from "../../src/modules/identity/adapters/suppressing-email-sender.js";
import { EMAIL_SENDER, EmailSuppressedError, type EmailMessage, type EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { discoverRealRoutes } from "../support/discover-contract-routes.js";

// STORY-178 AC1, AC2, AC5, AC6 — `POST /v1/webhooks/resend` through the REAL ApiModule, against a real Postgres, with the
// pool connected as `nominara_app` so the table's GRANTs are actually in force. Resend is not contacted: the events are
// signed here with the Svix scheme and a made-up secret.

const SECRET = "whsec_" + Buffer.from("a-test-signing-secret-of-32-bytes!").toString("base64");
const PEPPER = "test-otp-email-hash-pepper"; // test/support/fake-env.ts
const BOUNCED = "Bounced.Person@Example.org";

const hashOf = (address: string): Buffer => hashEmailKey(normalizeEmail(address), PEPPER);

function sign(body: string, over: { id?: string; timestamp?: number; secret?: string } = {}): Record<string, string> {
  const id = over.id ?? `msg_${randomUUID()}`;
  const timestamp = String(over.timestamp ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((over.secret ?? SECRET).slice("whsec_".length), "base64");
  const signature = "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature };
}

const bounce = (to: string[], type = "Permanent"): string => JSON.stringify({ type: "email.bounced", created_at: "2026-10-26T10:00:00Z", data: { email_id: "re_1", to, bounce: { type, subType: "General", message: `The recipient ${to[0] ?? ""} does not exist` } } });
const complaint = (to: string[]): string => JSON.stringify({ type: "email.complained", data: { email_id: "re_2", to } });

describe("STORY-178 · Resend webhook (suppression ingress)", () => {
  const harness = useApiHarness({ runAsAppRole: true, env: () => ({ RESEND_WEBHOOK_SECRET: SECRET }) });
  let warn: MockInstance<(...args: unknown[]) => void>;
  let log: MockInstance<(...args: unknown[]) => void>;
  let error: MockInstance<(...args: unknown[]) => void>;
  const lines = (): string => [...warn.mock.calls, ...log.mock.calls, ...error.mock.calls].map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");

  beforeEach(() => {
    vi.restoreAllMocks();
    warn = vi.spyOn(Logger.prototype, "warn") as unknown as typeof warn;
    log = vi.spyOn(Logger.prototype, "log") as unknown as typeof log;
    error = vi.spyOn(Logger.prototype, "error") as unknown as typeof error;
  });
  afterEach(() => vi.restoreAllMocks());

  async function post(body: string, headers: Record<string, string> = sign(body)) {
    return await harness.app().inject({ method: "POST", url: apiUrl("/webhooks/resend"), headers: { "content-type": "application/json", ...headers }, payload: body });
  }
  const outcomeOf = (res: { json: <T>() => T }): string => res.json<{ data: { outcome: string } }>().data.outcome;
  const rows = async () =>
    (await harness.db().query<{ recipient_hash: Buffer; kind: string; provider_event_id: string; deleted_at: Date | null }>("SELECT recipient_hash, kind, provider_event_id, deleted_at FROM email_suppressions ORDER BY created_at, id")).rows;

  it("the route is @Public() and @SkipTenantContext(): Resend has no session, and no workspace is known at this door", async () => {
    const route = (await discoverRealRoutes()).find((r) => r.fullPath === "webhooks/resend");
    expect(route, "POST /v1/webhooks/resend is registered").toBeDefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, route!.handler)).toBe(true);
    expect(Reflect.getMetadata(SKIP_TENANT_CONTEXT_KEY, route!.handler)).toBe(true);
  });

  it("AC6 · a signed hard bounce suppresses the address (as its peppered hash) and the response keeps the envelope", async () => {
    const res = await post(bounce([BOUNCED]), sign(bounce([BOUNCED]), { id: "msg_one" }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ data: { received: true, outcome: "suppressed" } });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "bounce", provider_event_id: "msg_one", deleted_at: null });
    expect(stored[0]!.recipient_hash.equals(hashOf(BOUNCED))).toBe(true);
    // The address is in no column at all.
    const everything = JSON.stringify((await harness.db().query("SELECT * FROM email_suppressions")).rows);
    expect(everything.toLowerCase()).not.toContain("bounced.person");
  });

  it("AC6 · the NEXT send to a suppressed address is refused by the real send path, through the real store as nominara_app", async () => {
    await post(bounce([BOUNCED]));
    const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
    try {
      const sent: EmailMessage[] = [];
      const inner: EmailSender = { async send(m) { sent.push(m); } };
      const sender = new SuppressingEmailSender(inner, new PgSuppressionStore(pool), PEPPER);
      await expect(sender.send({ to: "  bounced.person@EXAMPLE.org", subject: "s", textBody: "b" })).rejects.toBeInstanceOf(EmailSuppressedError);
      await expect(sender.send({ to: "bounced.person@example.org", subject: "s", textBody: "b", transactional: true })).rejects.toBeInstanceOf(EmailSuppressedError);
      await sender.send({ to: "someone.else@example.org", subject: "s", textBody: "b" });
      expect(sent.map((m) => m.to)).toEqual(["someone.else@example.org"]);
    } finally {
      await pool.end();
    }
  });

  it("owner decision 8 · a complaint suppresses reports, digests and alerts but NOT the sign-in code", async () => {
    const res = await post(complaint([BOUNCED]));
    expect(outcomeOf(res)).toBe("suppressed");
    expect((await rows())[0]).toMatchObject({ kind: "complaint" });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
    try {
      const sent: EmailMessage[] = [];
      const sender = new SuppressingEmailSender({ async send(m) { sent.push(m); } }, new PgSuppressionStore(pool), PEPPER);
      await expect(sender.send({ to: BOUNCED, subject: "report", textBody: "b" })).rejects.toBeInstanceOf(EmailSuppressedError);
      await sender.send({ to: BOUNCED, subject: "code", textBody: "b", transactional: true });
      expect(sent.map((m) => m.subject)).toEqual(["code"]);
    } finally {
      await pool.end();
    }
  });

  it("owner decision 8 · a transient or undetermined bounce NEVER suppresses: acknowledged, nothing stored, counted as a metric only", async () => {
    for (const type of ["Transient", "Undetermined"]) {
      const res = await post(bounce([BOUNCED], type));
      expect(res.statusCode, type).toBe(200);
      expect(outcomeOf(res)).toBe("ignored");
    }
    expect(await rows()).toEqual([]);
    expect(lines()).toContain("nominara_email_soft_bounces_total");
    expect(lines()).not.toContain("nominara_email_suppressions_total");
  });

  it("AC1 · a forged signature (another secret) is refused 400 and writes nothing", async () => {
    const body = bounce([BOUNCED]);
    const res = await post(body, sign(body, { secret: "whsec_" + Buffer.from("some-other-secret-of-32-bytes!!!!").toString("base64") }));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("validation_failed");
    expect(await rows()).toEqual([]);
  });

  it("AC1 · a body altered after signing, a missing header and a malformed signature are each refused 400, writing nothing", async () => {
    const body = bounce([BOUNCED]);
    const headers = sign(body);
    expect((await post(bounce(["other@example.org"]), headers)).statusCode).toBe(400);
    for (const drop of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const partial = { ...headers };
      delete partial[drop];
      expect((await post(body, partial)).statusCode, drop).toBe(400);
    }
    expect((await post(body, { ...headers, "svix-signature": "v1,not-base64!!" })).statusCode).toBe(400);
    expect((await post(body, {})).statusCode).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it("AC1 · a STALE timestamp and a FUTURE timestamp are refused 400 even when the signature is valid, writing nothing", async () => {
    const body = bounce([BOUNCED]);
    const now = Math.floor(Date.now() / 1000);
    expect((await post(body, sign(body, { timestamp: now - 301 }))).statusCode).toBe(400);
    expect((await post(body, sign(body, { timestamp: now + 301 }))).statusCode).toBe(400);
    expect(await rows()).toEqual([]);
    expect((await post(body, sign(body, { timestamp: now - 200 }))).statusCode).toBe(200);
  });

  it("AC6 · a REPLAYED event (same svix-id) changes nothing: one row, one count, `duplicate`", async () => {
    const body = bounce([BOUNCED]);
    const headers = sign(body, { id: "msg_replayed" });
    expect(outcomeOf(await post(body, headers))).toBe("suppressed");
    log.mockClear();
    expect(outcomeOf(await post(body, headers))).toBe("duplicate");
    expect(outcomeOf(await post(body, headers))).toBe("duplicate");
    expect(await rows()).toHaveLength(1);
    expect(lines()).not.toContain("nominara_email_suppressions_total");
  });

  it("a replay of a LIFTED suppression's event stays a no-op: only a new event can suppress the address again", async () => {
    const body = bounce([BOUNCED]);
    const headers = sign(body, { id: "msg_lifted" });
    await post(body, headers);
    await harness.db().query("UPDATE email_suppressions SET deleted_at = now()");
    expect(outcomeOf(await post(body, headers))).toBe("duplicate");
    const active = await harness.db().query("SELECT 1 FROM email_suppressions WHERE deleted_at IS NULL");
    expect(active.rowCount).toBe(0);
    expect(outcomeOf(await post(bounce([BOUNCED]), sign(bounce([BOUNCED]), { id: "msg_new" })))).toBe("suppressed");
  });

  it("one event naming two addresses suppresses both; its replay changes neither", async () => {
    const body = bounce(["one@example.org", "Two@Example.org"]);
    const headers = sign(body, { id: "msg_two" });
    expect(outcomeOf(await post(body, headers))).toBe("suppressed");
    expect((await rows()).map((r) => r.recipient_hash.toString("hex")).sort()).toEqual([hashOf("one@example.org"), hashOf("two@example.org")].map((h) => h.toString("hex")).sort());
    expect(outcomeOf(await post(body, headers))).toBe("duplicate");
    expect(await rows()).toHaveLength(2);
  });

  it("an event that is not a bounce or a complaint, or a bounce naming no address, is acknowledged and ignored", async () => {
    for (const body of [JSON.stringify({ type: "email.delivered", data: { to: [BOUNCED] } }), JSON.stringify({ type: "email.bounced", data: { bounce: { type: "Permanent" } } }), JSON.stringify({ type: "email.bounced", data: { to: [], bounce: { type: "Permanent" } } })]) {
      const res = await post(body);
      expect(res.statusCode, body).toBe(200);
      expect(outcomeOf(res)).toBe("ignored");
    }
    expect(await rows()).toEqual([]);
  });

  it("a correctly signed body that is not JSON, or lacks the envelope, is a 400 and writes nothing (the signature never vouches for shape)", async () => {
    for (const body of ["not json", "[]", JSON.stringify({ data: {} })]) expect((await post(body)).statusCode, body).toBe(400);
    expect(await rows()).toEqual([]);
  });

  it("an address with no account anywhere is suppressed the same way: the response never says whether an address is known", async () => {
    const known = await post(bounce(["nobody-at-all@example.org"]));
    const again = await post(bounce(["nobody-at-all@example.org"]), sign(bounce(["nobody-at-all@example.org"])));
    expect(known.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(Object.keys(known.json<{ data: object }>().data).sort()).toEqual(["outcome", "received"]);
  });

  it("AC5 · the counter nominara_email_suppressions_total{kind} and a span are emitted, and no log line carries the address or the provider's text", async () => {
    await post(bounce([BOUNCED]));
    await post(complaint(["Complainer@Example.net"]));
    const text = lines();
    expect(text).toMatch(/nominara_email_suppressions_total[^\n]*"kind":"bounce"/u);
    expect(text).toMatch(/nominara_email_suppressions_total[^\n]*"kind":"complaint"/u);
    expect(text).toContain(hashOf(BOUNCED).toString("hex"));
    expect(text.toLowerCase()).not.toContain("example.org");
    expect(text.toLowerCase()).not.toContain("example.net");
    expect(text).not.toContain("does not exist"); // Resend's bounce message quotes the address back
    expect(text).not.toContain(SECRET);
  });

  it("a request refused for its signature logs the refusal without the body, the secret or any header value", async () => {
    const body = bounce([BOUNCED]);
    await post(body, sign(body, { secret: "whsec_" + Buffer.from("some-other-secret-of-32-bytes!!!!").toString("base64") }));
    const text = lines();
    expect(text).toContain("resend webhook refused");
    expect(text.toLowerCase()).not.toContain("example.org");
    expect(text).not.toContain("v1,");
  });

  it("the route does not change how any OTHER JSON route parses: a body there is still parsed and an unknown key still refused", async () => {
    const res = await harness.app().inject({ method: "POST", url: apiUrl("/auth/otp/request"), headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "a@example.org", unknown_key: 1 }) });
    expect(res.statusCode).toBe(400);
  });
});

describe("STORY-178 · Resend webhook without a signing secret", () => {
  const harness = useApiHarness({ runAsAppRole: true });

  it("fails closed: 503 degraded, and nothing is written, even for a request that would verify against SOME secret", async () => {
    const body = bounce([BOUNCED]);
    const res = await harness.app().inject({ method: "POST", url: apiUrl("/webhooks/resend"), headers: { "content-type": "application/json", ...sign(body) }, payload: body });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("degraded");
    const count = await harness.db().query("SELECT count(*)::int AS n FROM email_suppressions");
    expect((count.rows[0] as { n: number }).n).toBe(0);
  });
});

// STORY-016 — the sign-in code must not reveal suppression. The check sits inside the deferred send, so the request path is
// the same for a suppressed address and any other: same status, same body, and the work is done after the response.
describe("STORY-178 · the sign-in request does not reveal a suppression (STORY-016)", () => {
  const sent: EmailMessage[] = [];
  let storePool: Pool | undefined;
  const harness = useApiHarness({
    runAsAppRole: true,
    configure: (builder) => {
      builder.overrideProvider(EMAIL_SENDER).useFactory({
        factory: () => {
          storePool = new Pool({ connectionString: process.env.DATABASE_URL! });
          storePool.on("error", () => undefined);
          return new SuppressingEmailSender({ async send(m) { sent.push(m); } }, new PgSuppressionStore(storePool), PEPPER);
        },
      });
    },
  });
  afterEach(async () => {
    await storePool?.end().catch(() => undefined);
    storePool = undefined;
  });

  const request = (email: string) => harness.app().inject({ method: "POST", url: apiUrl("/auth/otp/request"), headers: { "content-type": "application/json" }, payload: JSON.stringify({ email }) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  async function user(email: string): Promise<void> {
    await harness.db().query("INSERT INTO users (email, status) VALUES ($1, 'active')", [email]);
  }
  async function suppress(email: string, kind: "bounce" | "complaint"): Promise<void> {
    await harness.db().query("INSERT INTO email_suppressions (recipient_hash, kind, provider_event_id) VALUES ($1,$2,$3)", [hashOf(email), kind, `evt_${randomUUID()}`]);
  }

  it("a hard-bounced KNOWN user gets the identical response as an unknown address, and no code is sent", async () => {
    sent.length = 0;
    await user("bounced.user@example.org");
    await suppress("bounced.user@example.org", "bounce");
    const bouncedRes = await request("bounced.user@example.org");
    const unknownRes = await request("never.registered@example.org");
    await settle();
    expect(bouncedRes.statusCode).toBe(unknownRes.statusCode);
    // The envelope's `meta` carries a per-request id and clock; the DATA is what must not differ.
    expect(bouncedRes.json<{ data: unknown }>().data).toEqual(unknownRes.json<{ data: unknown }>().data);
    // (The unknown address is mailed a code too: that is STORY-016's design, so the two are indistinguishable.)
    expect(sent.map((m) => m.to)).not.toContain("bounced.user@example.org");
    expect(sent.map((m) => m.to)).toEqual(["never.registered@example.org"]);
  });

  it("a user who complained (but never hard-bounced) STILL gets the sign-in code", async () => {
    sent.length = 0;
    await user("complainer@example.org");
    await suppress("complainer@example.org", "complaint");
    const res = await request("complainer@example.org");
    expect(res.statusCode).toBeLessThan(300);
    await settle();
    expect(sent.map((m) => m.to)).toEqual(["complainer@example.org"]);
    expect(sent[0]!.transactional).toBe(true);
  });
});
