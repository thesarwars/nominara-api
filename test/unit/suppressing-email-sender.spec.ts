import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashEmailKey, normalizeEmail } from "../../src/lib/auth/email-otp.js";
import type { SuppressionKind, SuppressionStore } from "../../src/lib/email/suppression-store.js";
import { SuppressingEmailSender } from "../../src/modules/identity/adapters/suppressing-email-sender.js";
import { EmailSuppressedError, EmailSuppressionLookupError, type EmailMessage, type EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-178 AC3 / owner decisions 8 — the suppression check inside the ONE send path.
//   hard bounce  -> suppresses ALL mail, a sign-in code included (it cannot be delivered anyway)
//   complaint    -> suppresses only NON-transactional mail (reports, digests, alerts); a sign-in code is still sent
//   anything else (transient bounce, delay) never reaches the store, so it can never suppress

const PEPPER = "unit-test-pepper-0000000000000000";
const ADDRESS = "Bounced.Person@Example.org";
const hashOf = (address: string): string => hashEmailKey(normalizeEmail(address), PEPPER).toString("hex");

const logged: string[] = [];
let sent: EmailMessage[];
let inner: EmailSender & { delivers: boolean };
let store: SuppressionStore & { asked: string[]; kinds: Map<string, SuppressionKind[]>; fail: boolean };

const message = (over: Partial<EmailMessage> = {}): EmailMessage => ({ to: ADDRESS, subject: "A report", textBody: "body", ...over });

beforeEach(() => {
  applyFakeApiEnv();
  logged.length = 0;
  for (const level of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  sent = [];
  inner = { delivers: true, send: async (m) => void sent.push(m) };
  store = {
    asked: [],
    kinds: new Map(),
    fail: false,
    async activeKinds(hash) {
      this.asked.push(hash.toString("hex"));
      if (this.fail) throw new Error("connection refused: postgres://user:secret@db/x");
      return this.kinds.get(hash.toString("hex")) ?? [];
    },
  } as typeof store;
});
afterEach(() => vi.restoreAllMocks());

const make = () => new SuppressingEmailSender(inner, store, PEPPER);

describe("STORY-178 AC3 · SuppressingEmailSender", () => {
  it("an address with no suppression is sent, and the message reaches the inner sender untouched", async () => {
    const m = message({ fromName: "Acme", replyTo: "team@acme.example", idempotencyKey: "k1" });
    await make().send(m);
    expect(sent).toEqual([m]);
  });

  it("the lookup is by the NORMALISED address's peppered hash, so case and whitespace cannot dodge a suppression", async () => {
    store.kinds.set(hashOf("bounced.person@example.org"), ["bounce"]);
    await expect(make().send(message({ to: "  BOUNCED.PERSON@EXAMPLE.ORG " }))).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(store.asked).toEqual([hashOf("bounced.person@example.org")]);
    expect(sent).toEqual([]);
  });

  it("a hard bounce suppresses non-transactional mail AND a transactional one (the sign-in code)", async () => {
    store.kinds.set(hashOf(ADDRESS), ["bounce"]);
    await expect(make().send(message())).rejects.toMatchObject({ kind: "bounce" });
    await expect(make().send(message({ transactional: true }))).rejects.toMatchObject({ kind: "bounce" });
    expect(sent).toEqual([]);
  });

  it("a complaint suppresses non-transactional mail, and does NOT suppress transactional mail", async () => {
    store.kinds.set(hashOf(ADDRESS), ["complaint"]);
    await expect(make().send(message())).rejects.toMatchObject({ kind: "complaint" });
    await expect(make().send(message({ transactional: false }))).rejects.toMatchObject({ kind: "complaint" });
    expect(sent).toEqual([]);
    await make().send(message({ transactional: true }));
    expect(sent).toHaveLength(1);
  });

  it("a bounce AND a complaint on the same address: a transactional message is still blocked by the bounce", async () => {
    store.kinds.set(hashOf(ADDRESS), ["complaint", "bounce"]);
    await expect(make().send(message({ transactional: true }))).rejects.toMatchObject({ kind: "bounce" });
  });

  it("a suppression on ANOTHER address changes nothing", async () => {
    store.kinds.set(hashOf("someone.else@example.org"), ["bounce"]);
    await make().send(message());
    expect(sent).toHaveLength(1);
  });

  it("FAILS CLOSED: when the lookup cannot run nothing is sent, and the error carries none of the lookup's own text", async () => {
    store.fail = true;
    const error = await make().send(message()).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSuppressionLookupError);
    expect(String((error as Error).message)).not.toMatch(/secret|postgres:\/\//u);
    expect(sent).toEqual([]);
  });

  it("the suppressed error and every log line name the hash, never the address", async () => {
    store.kinds.set(hashOf(ADDRESS), ["bounce"]);
    const error = (await make().send(message()).then(() => undefined, (e: unknown) => e)) as Error;
    expect(error.message.toLowerCase()).not.toContain("example.org");
    const text = logged.join("\n");
    expect(text).toContain(hashOf(ADDRESS));
    expect(text.toLowerCase()).not.toContain("bounced.person");
    expect(text).not.toContain("example.org");
  });

  it("forwards `delivers` from the sender it wraps, so a caller's `logged` versus `delivered` honesty rule still holds", () => {
    expect(make().delivers).toBe(true);
    inner = { send: async () => undefined } as unknown as typeof inner;
    expect(make().delivers).toBeUndefined();
  });

  it("counts a refused send by kind (nominara_email_sends_suppressed_total) and emits one span per check, with no address", async () => {
    const exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    store.kinds.set(hashOf(ADDRESS), ["complaint"]);
    await expect(make().send(message())).rejects.toBeInstanceOf(EmailSuppressedError);
    await make().send(message({ to: "fine@example.net" }));
    expect(logged.some((l) => l.includes("nominara_email_sends_suppressed_total") && l.includes('"kind":"complaint"'))).toBe(true);
    const spans = exporter.getFinishedSpans().filter((s) => s.name === "email.suppression.check");
    expect(spans.map((s) => s.attributes["nominara.email.suppression.outcome"])).toEqual(["suppressed", "allowed"]);
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain("example");
  });

  it("the OPERATOR-ALERT policy sends when the list cannot be read (a page about the database must survive the database), but still honours a suppression it CAN read", async () => {
    const alert = new SuppressingEmailSender(inner, store, PEPPER, { onLookupFailure: "send" });
    store.fail = true;
    await alert.send(message());
    expect(sent).toHaveLength(1);
    expect(logged.some((l) => l.includes("nominara_email_suppression_lookups_failed_total"))).toBe(true);
    store.fail = false;
    store.kinds.set(hashOf(ADDRESS), ["bounce"]);
    await expect(alert.send(message())).rejects.toBeInstanceOf(EmailSuppressedError);
    expect(sent).toHaveLength(1);
  });

  it("the default policy is refuse: an explicitly empty options object still fails closed", async () => {
    store.fail = true;
    await expect(new SuppressingEmailSender(inner, store, PEPPER, {}).send(message())).rejects.toBeInstanceOf(EmailSuppressionLookupError);
  });
});
