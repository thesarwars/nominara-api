import { createHmac } from "node:crypto";
import { Logger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResendWebhookService } from "../../src/modules/identity/resend-webhook.service.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-178 AC5 — the webhook's observability, against a fake pool (the database behaviour is test/integration/resend-webhook.spec.ts).

const SECRET = "whsec_" + Buffer.from("a-test-signing-secret-of-32-bytes!").toString("base64");
const originalEnv = { ...process.env };
let queries: unknown[][];
const lines: string[] = [];

function pool(rowCount: number): Pool {
  return { query: async (_sql: string, values: unknown[]) => (queries.push(values), { rowCount, rows: rowCount > 0 ? [{ id: "x" }] : [] }) } as unknown as Pool;
}
function signed(body: string): { id: string; timestamp: string; signature: string } {
  const id = "msg_unit";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v1," + createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { id, timestamp, signature };
}

beforeEach(() => {
  applyFakeApiEnv();
  process.env.RESEND_WEBHOOK_SECRET = SECRET;
  queries = [];
  lines.length = 0;
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
  }
});
afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("STORY-178 AC5 · ResendWebhookService observability", () => {
  it("one email.suppression.record span per accepted event, carrying the outcome and no address", async () => {
    const exporter = new InMemorySpanExporter();
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    const body = JSON.stringify({ type: "email.bounced", data: { to: ["Someone@Example.org"], bounce: { type: "Permanent" } } });
    const result = await new ResendWebhookService(pool(1)).handle(Buffer.from(body), signed(body));
    expect(result).toEqual({ received: true, outcome: "suppressed" });
    const spans = exporter.getFinishedSpans().filter((s) => s.name === "email.suppression.record");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["nominara.email.webhook.outcome"]).toBe("suppressed");
    expect(JSON.stringify(spans[0]!.attributes).toLowerCase()).not.toContain("example");
  });

  it("a refused request never reaches the database: the signature is checked before anything is parsed or written", async () => {
    const body = JSON.stringify({ type: "email.bounced", data: { to: ["a@example.org"], bounce: { type: "Permanent" } } });
    const bad = { ...signed(body), signature: "v1," + Buffer.alloc(32).toString("base64") };
    await expect(new ResendWebhookService(pool(1)).handle(Buffer.from(body), bad)).rejects.toMatchObject({ code: "validation_failed" });
    expect(queries).toEqual([]);
  });

  it("the hash is what is bound to the query, never the address", async () => {
    const body = JSON.stringify({ type: "email.complained", data: { to: ["Someone@Example.org"] } });
    await new ResendWebhookService(pool(1)).handle(Buffer.from(body), signed(body));
    expect(queries).toHaveLength(1);
    const bound = queries[0]!;
    expect(bound.some((v) => typeof v === "string" && v.toLowerCase().includes("example"))).toBe(false);
    expect(Buffer.isBuffer(bound[1]) && (bound[1] as Buffer).length === 32).toBe(true);
    expect(bound[2]).toBe("complaint");
  });
});
