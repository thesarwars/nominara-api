import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ResendEmailSenderAdapter, EmailDeliveryError } from "../../src/modules/identity/adapters/resend-email-sender.adapter.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// Group C item 1 — the Resend adapter behind the EMAIL_SENDER port. The HTTP layer is a FAKE fetch: no test in this
// file (or anywhere) calls the real Resend API. Every secret below is a made-up placeholder.

const API_KEY = "re_test_PLACEHOLDER_KEY_0000";
const FROM = "Nominara <no-reply@nominara.test>";
const RECIPIENT = "alice.person@example.org";
const CODE = "48151623";
const MESSAGE = {
  to: RECIPIENT,
  subject: "Your Nominara sign-in code",
  textBody: `Your sign-in code is ${CODE}. It expires in 10 minutes.`,
};

interface Captured {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
  body: Record<string, unknown>;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(responses: Array<Response | Error | (() => Promise<Response>)>) {
  const calls: Captured[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init as Captured["init"],
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    // A fresh Response per call: a clone() is a tee, and cancelling one branch of a tee waits for the other.
    return new Response(await next.clone().text(), { status: next.status, headers: next.headers });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function make(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof ResendEmailSenderAdapter>[0]> = {},
) {
  const sleeps: number[] = [];
  const adapter = new ResendEmailSenderAdapter({
    apiKey: API_KEY,
    from: FROM,
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...extra,
  });
  return { adapter, sleeps };
}

const logged: string[] = [];
const originalEnv = { ...process.env };

beforeEach(() => {
  applyFakeApiEnv();
  process.env.NODE_ENV = "test";
  logged.length = 0;
  for (const level of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("Resend adapter · request shape", () => {
  it("POSTs to https://api.resend.com/emails with a Bearer key, JSON body and the fixed from", async () => {
    const f = fakeFetch([jsonResponse(200, { id: "msg_1" })]);
    await make(f.impl).adapter.send(MESSAGE);

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.init.headers["Content-Type"]).toBe("application/json");
    expect(call.body).toMatchObject({ from: FROM, to: [RECIPIENT], subject: MESSAGE.subject, text: MESSAGE.textBody });
    expect(call.body).not.toHaveProperty("html");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes an html body through when the message has one", async () => {
    const f = fakeFetch([jsonResponse(200, { id: "msg_1" })]);
    await make(f.impl).adapter.send({ ...MESSAGE, htmlBody: "<p>hi</p>" });
    expect(f.calls[0]!.body).toMatchObject({ html: "<p>hi</p>", text: MESSAGE.textBody });
  });

  it("sends an Idempotency-Key header and an X-Entity-Ref-ID body header carrying the same key", async () => {
    const f = fakeFetch([jsonResponse(200, { id: "msg_1" })]);
    await make(f.impl).adapter.send(MESSAGE);
    const key = f.calls[0]!.init.headers["Idempotency-Key"];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect((f.calls[0]!.body.headers as Record<string, string>)["X-Entity-Ref-ID"]).toBe(key);
  });

  it("uses a DIFFERENT idempotency key for a different send", async () => {
    const f = fakeFetch([jsonResponse(200, { id: "msg_1" })]);
    const { adapter } = make(f.impl);
    await adapter.send(MESSAGE);
    await adapter.send(MESSAGE);
    expect(f.calls[0]!.init.headers["Idempotency-Key"]).not.toBe(f.calls[1]!.init.headers["Idempotency-Key"]);
  });

  it("STORY-077 (owner 2026-10-23) · a message that CARRIES an idempotency key sends exactly that key on every attempt and every send, so a retried job cannot deliver twice", async () => {
    const f = fakeFetch([jsonResponse(503, { name: "application_error" }), jsonResponse(200, { id: "msg_1" })]);
    const { adapter } = make(f.impl);
    const keyed = { ...MESSAGE, idempotencyKey: "downgrade-notice/55555555-5555-7555-8555-555555555555" };
    await adapter.send(keyed);
    await adapter.send(keyed); // the job's retry: a second send() of the same notice
    expect(f.calls.map((c) => c.init.headers["Idempotency-Key"])).toEqual(Array(3).fill(keyed.idempotencyKey));
    expect((f.calls[0]!.body.headers as Record<string, string>)["X-Entity-Ref-ID"]).toBe(keyed.idempotencyKey);
    expect(f.calls[0]!.body, "the key is not part of the message body").not.toHaveProperty("idempotencyKey");
  });
});

describe("Resend adapter · retries", () => {
  it("retries a 5xx and succeeds, reusing the SAME idempotency key so a retry cannot double-send", async () => {
    const f = fakeFetch([jsonResponse(503, { name: "application_error" }), jsonResponse(200, { id: "msg_1" })]);
    const { adapter, sleeps } = make(f.impl);
    await adapter.send(MESSAGE);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.init.headers["Idempotency-Key"]).toBe(f.calls[0]!.init.headers["Idempotency-Key"]);
    expect(sleeps).toHaveLength(1);
  });

  it("retries a 429 and honours Retry-After (seconds) instead of its own backoff", async () => {
    const f = fakeFetch([jsonResponse(429, { name: "rate_limit_exceeded" }, { "retry-after": "2" }), jsonResponse(200, { id: "m" })]);
    const { adapter, sleeps } = make(f.impl);
    await adapter.send(MESSAGE);
    expect(sleeps).toEqual([2000]);
  });

  it.each([400, 401, 403, 404, 422])("does NOT retry a %i — one attempt, then a non-retryable error", async (status) => {
    const f = fakeFetch([jsonResponse(status, { name: "validation_error", message: `bad address ${RECIPIENT}` })]);
    const { adapter, sleeps } = make(f.impl);
    const error = await adapter.send(MESSAGE).catch((e: unknown) => e);
    expect(f.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as EmailDeliveryError).status).toBe(status);
    expect((error as EmailDeliveryError).retryable).toBe(false);
  });

  it("gives up after a bounded number of attempts on a persistent 5xx", async () => {
    const f = fakeFetch([jsonResponse(500, { name: "application_error" })]);
    const { adapter } = make(f.impl, { maxAttempts: 3 });
    const error = (await adapter.send(MESSAGE).catch((e: unknown) => e)) as EmailDeliveryError;
    expect(f.calls).toHaveLength(3);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
  });

  it("refuses to wait on a Retry-After longer than the cap — fails instead of stalling the worker", async () => {
    const f = fakeFetch([jsonResponse(429, {}, { "retry-after": "3600" }), jsonResponse(200, { id: "m" })]);
    const { adapter, sleeps } = make(f.impl);
    await expect(adapter.send(MESSAGE)).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(f.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries a 409 concurrent_idempotent_requests (our own attempt still in flight) with backoff", async () => {
    const f = fakeFetch([jsonResponse(409, { name: "concurrent_idempotent_requests" }), jsonResponse(200, { id: "m" })]);
    const { adapter, sleeps } = make(f.impl);
    await adapter.send(MESSAGE);
    expect(f.calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(f.calls[1]!.init.headers["Idempotency-Key"]).toBe(f.calls[0]!.init.headers["Idempotency-Key"]);
  });

  it("does NOT retry any other 409 (a real conflict, e.g. invalid_idempotent_request)", async () => {
    const f = fakeFetch([jsonResponse(409, { name: "invalid_idempotent_request" })]);
    const error = (await make(f.impl).adapter.send(MESSAGE).catch((e: unknown) => e)) as EmailDeliveryError;
    expect(f.calls).toHaveLength(1);
    expect(error.retryable).toBe(false);
  });

  it("honours a Retry-After given as an HTTP date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    try {
      const date = new Date("2026-10-15T12:00:07Z").toUTCString();
      const f = fakeFetch([jsonResponse(429, {}, { "retry-after": date }), jsonResponse(200, { id: "m" })]);
      const { adapter, sleeps } = make(f.impl);
      await adapter.send(MESSAGE);
      expect(sleeps).toEqual([7000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Retry-After of exactly the 30 s cap is waited out; 31 s is refused", async () => {
    const ok = fakeFetch([jsonResponse(429, {}, { "retry-after": "30" }), jsonResponse(200, { id: "m" })]);
    const first = make(ok.impl);
    await first.adapter.send(MESSAGE);
    expect(first.sleeps).toEqual([30_000]);

    const over = fakeFetch([jsonResponse(429, {}, { "retry-after": "31" }), jsonResponse(200, { id: "m" })]);
    const second = make(over.impl);
    await expect(second.adapter.send(MESSAGE)).rejects.toBeInstanceOf(EmailDeliveryError);
    expect(over.calls).toHaveLength(1);
    expect(second.sleeps).toEqual([]);
  });

  it("cancels the body of a non-2xx response it does not read", async () => {
    const response = jsonResponse(400, { name: "validation_error" });
    const cancel = vi.spyOn(response.body!, "cancel");
    const f = fakeFetch([() => Promise.resolve(response)]);
    await make(f.impl).adapter.send(MESSAGE).catch(() => undefined);
    expect(cancel).toHaveBeenCalled();
  });

  it("backoff grows between attempts when there is no Retry-After", async () => {
    const f = fakeFetch([jsonResponse(502, {}), jsonResponse(502, {}), jsonResponse(200, { id: "m" })]);
    const { adapter, sleeps } = make(f.impl, { maxAttempts: 3 });
    await adapter.send(MESSAGE);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it("retries a network failure (idempotency key makes it safe) and then succeeds", async () => {
    const f = fakeFetch([new TypeError("fetch failed"), jsonResponse(200, { id: "m" })]);
    await make(f.impl).adapter.send(MESSAGE);
    expect(f.calls).toHaveLength(2);
  });
});

describe("Resend adapter · timeout", () => {
  it("aborts a request that never answers and reports a retryable timeout", async () => {
    // Settles only when the adapter's own abort signal fires.
    const impl = vi.fn((_url: unknown, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
    const { adapter } = make(impl, { timeoutMs: 20, maxAttempts: 2 });
    const error = (await adapter.send(MESSAGE).catch((e: unknown) => e)) as EmailDeliveryError;
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect(error.message).toMatch(/timed out/);
    expect(impl).toHaveBeenCalledTimes(2);
  });
});

describe("Resend adapter · redaction", () => {
  it("no log line on success, retry or failure contains the address, the code or the key", async () => {
    const f = fakeFetch([
      jsonResponse(503, { message: `could not deliver to ${RECIPIENT}` }),
      jsonResponse(200, { id: "msg_1" }),
    ]);
    await make(f.impl).adapter.send(MESSAGE);

    const f2 = fakeFetch([jsonResponse(422, { name: "validation_error", message: `invalid to ${RECIPIENT} key ${API_KEY}` })]);
    const failure = (await make(f2.impl).adapter.send(MESSAGE).catch((e: unknown) => e)) as Error;

    const everything = [...logged, failure.message].join("\n");
    expect(logged.length).toBeGreaterThan(0);
    expect(everything).not.toContain(RECIPIENT);
    expect(everything).not.toContain("alice.person");
    expect(everything).not.toContain(CODE);
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain("re_test_");
  });

  it("the success log identifies the message by provider id and recipient HASH only", async () => {
    const f = fakeFetch([jsonResponse(200, { id: "msg_abc" })]);
    await make(f.impl).adapter.send(MESSAGE);
    const line = logged.join("\n");
    expect(line).toContain("msg_abc");
    expect(line).toMatch(/recipient_hash=[0-9a-f]{64}/);
  });
});

describe("Resend adapter · RESEND_TO_EMAIL dev override", () => {
  it("redirects EVERY recipient to the override address", async () => {
    const f = fakeFetch([jsonResponse(200, { id: "m" })]);
    await make(f.impl, { toOverride: "owner@example.net" }).adapter.send(MESSAGE);
    expect(f.calls[0]!.body.to).toEqual(["owner@example.net"]);
  });

  it("is refused by the constructor under NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    expect(
      () => new ResendEmailSenderAdapter({ apiKey: API_KEY, from: FROM, toOverride: "owner@example.net" }),
    ).toThrow(/RESEND_TO_EMAIL/);
  });

  it("constructs without an override under production", () => {
    process.env.NODE_ENV = "production";
    expect(() => new ResendEmailSenderAdapter({ apiKey: API_KEY, from: FROM })).not.toThrow();
  });
});

describe("Resend adapter · observability", () => {
  it("emits one email.send span per send with provider, attempts and outcome — and no address", async () => {
    const exporter = new InMemorySpanExporter();
    // No trace.disable(): it swaps the global proxy provider, orphaning the adapter's module-level tracer.
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    {
      const f = fakeFetch([jsonResponse(503, {}), jsonResponse(200, { id: "m" })]);
      await make(f.impl).adapter.send(MESSAGE);
      const spans = exporter.getFinishedSpans().filter((span) => span.name === "email.send");
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes).toMatchObject({
        "nominara.email.provider": "resend",
        "nominara.email.attempts": 2,
        "nominara.email.outcome": "sent",
      });
      expect(JSON.stringify(spans[0]!.attributes)).not.toContain(RECIPIENT);
    }
  });

  it("counts sends and retries with unit-bearing metric names", async () => {
    const f = fakeFetch([jsonResponse(503, {}), jsonResponse(200, { id: "m" })]);
    await make(f.impl).adapter.send(MESSAGE);
    const metrics = logged.filter((line) => line.includes("nominara_email_"));
    expect(metrics.some((line) => line.includes("nominara_email_send_retry_total"))).toBe(true);
    expect(metrics.some((line) => line.includes("nominara_email_send_total") && line.includes('"outcome":"sent"'))).toBe(true);
  });
});
