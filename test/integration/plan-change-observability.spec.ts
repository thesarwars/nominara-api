import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { planChangePreviewResponseSchema } from "../../contracts/billing/index.js";
import { dataOf } from "../support/envelope.js";
import { usePlanChangeFixture } from "../support/plan-change-fixture.js";

// STORY-184 — observability, VERIFIED (coding standards: every story adds a span, a metric and a redacted log line, and
// proves them). The provider is installed before the application boots so this file's exporter is the one the service's
// tracer resolves to.
const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));

describe("STORY-184 · the plan change is observable, and what it logs is redacted", () => {
  const f = usePlanChangeFixture();

  const logged = (spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> =>
    spy.mock.calls.map((call) => call[0]).filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object");

  it("a span per route, ERROR on a refusal; the metric `nominara_billing_plan_change_total` per outcome; one log line per outcome carrying the workspace ID and nothing customer-identifying", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const log = vi.spyOn(Logger.prototype, "log");
    const warn = vi.spyOn(Logger.prototype, "warn");
    exporter.reset();

    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, "/billing/subscription/change/preview", { plan_key: "growth" })));
    expect((await f.post(owner, "/billing/subscription/change", { plan_key: "growth", quote: preview.quote })).statusCode).toBe(202);
    // A refusal: the same upgrade again is plan_change_pending.
    expect((await f.post(owner, "/billing/subscription/change", { plan_key: "growth", quote: preview.quote })).statusCode).toBe(409);

    const spans = exporter.getFinishedSpans().filter((span) => span.name.startsWith("billing.plan_change."));
    expect(spans.map((span) => span.name).sort()).toEqual(["billing.plan_change.change", "billing.plan_change.change", "billing.plan_change.preview"]);
    expect(spans.filter((span) => span.status.code === SpanStatusCode.ERROR)).toHaveLength(1);

    const metrics = logged(log).filter((entry) => entry.metric === "nominara_billing_plan_change_total");
    expect(metrics).toContainEqual({ metric: "nominara_billing_plan_change_total", value: 1, direction: "upgrade", outcome: "previewed" });
    expect(metrics).toContainEqual({ metric: "nominara_billing_plan_change_total", value: 1, direction: "upgrade", outcome: "requested" });
    expect(metrics).toContainEqual({ metric: "nominara_billing_plan_change_total", value: 1, direction: "upgrade", outcome: "plan_change_pending" });

    const lines = [...logged(log), ...logged(warn)].filter((entry) => typeof entry.message === "string" && entry.message.startsWith("plan upgrade requested"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ workspace_id: workspaceId, from_plan_key: "starter", to_plan_key: "growth" });
    // Redacted: no workspace NAME, no email, no Stripe object ids, no amounts, in ANY line the plan change logged.
    const everything = JSON.stringify([...logged(log), ...logged(warn)].filter((entry) => String(entry.metric ?? "").includes("plan_change") || /^plan (upgrade|downgrade|change)|plan change/u.test(String(entry.message ?? ""))));
    expect(everything).not.toMatch(/Workspace [0-9a-f-]{36}/u);
    expect(everything).not.toMatch(/@example\.com/u);
    expect(everything).not.toMatch(/\b(cus|sub|si|price|pi)_/u);
    expect(everything).not.toMatch(/\d+\.\d{2}/u);
  });
});
