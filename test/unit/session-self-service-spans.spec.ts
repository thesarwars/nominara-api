import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// STORY-096 AC4/AC7 - the list and the single revoke each emit a span. The provider is installed BEFORE the service module is loaded (a tracer caches
// its provider on first use), so this is a unit spec with a fake pool rather than part of the HTTP spec.
describe("STORY-096 AC4/AC7 · session self-service spans", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  let service: import("../../src/modules/identity/session.service.js").SessionService;
  const queries: string[] = [];

  beforeAll(async () => {
    trace.setGlobalTracerProvider(provider);
    const { SessionService } = await import("../../src/modules/identity/session.service.js");
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return /^\s*UPDATE sessions/.test(sql) ? { rowCount: 1, rows: [] } : { rowCount: 0, rows: [] };
      },
    };
    service = new SessionService(pool as never, {} as never, {} as never);
  });
  afterAll(async () => {
    trace.disable();
    await provider.shutdown();
  });

  it("STORY-096 AC4 · listing emits identity.sessions.list carrying the account ID and no User-Agent", async () => {
    await service.listForUser("00000000-0000-7000-8000-000000000001", "00000000-0000-7000-8000-000000000002", { limit: 20 } as never);
    const span = exporter.getFinishedSpans().find((s) => s.name === "identity.sessions.list");
    expect(span).toBeDefined();
    expect(span!.attributes["nominara.user_id"]).toBe("00000000-0000-7000-8000-000000000001");
    expect(JSON.stringify(span!.attributes)).not.toMatch(/user.?agent/i);
  });

  it("STORY-096 AC7 · revoking emits identity.sessions.revoke_one and marks whether it was the current session", async () => {
    const id = "00000000-0000-7000-8000-000000000003";
    await service.revokeOne("00000000-0000-7000-8000-000000000001", id, id);
    const span = exporter.getFinishedSpans().find((s) => s.name === "identity.sessions.revoke_one");
    expect(span).toBeDefined();
    expect(span!.attributes["nominara.sessions.current"]).toBe(true);
  });

  it("STORY-096 AC7 · an unknown session ends its span (a refusal is not an error status) and still throws", async () => {
    exporter.reset();
    const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
    const { SessionService } = await import("../../src/modules/identity/session.service.js");
    const none = new SessionService(pool as never, {} as never, {} as never);
    await expect(none.revokeOne("00000000-0000-7000-8000-000000000001", "00000000-0000-7000-8000-000000000009", "x")).rejects.toMatchObject({
      code: "not_found",
    });
    const span = exporter.getFinishedSpans().find((s) => s.name === "identity.sessions.revoke_one");
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(0);
  });
});
