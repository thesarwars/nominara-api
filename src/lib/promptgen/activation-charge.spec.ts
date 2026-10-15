import { InMemorySpanExporter, SimpleSpanProcessor, BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InsufficientCreditsError } from "../../api/errors/domain-errors.js";
import * as debit from "../credits/debit.js";
import {
  chargeForActivation,
  inheritFirstActivation,
  planActivationCharge,
  quoteActivation,
  type ActivationCandidate,
} from "./activation-charge.js";

// STORY-046 AC3 - the arithmetic and the observability of the activation
// charge. The database-backed half (the locks, the rollback, the durable fact)
// is test/integration/prompt-activation-charge.spec.ts.

const gen = (id: string, firstActivatedAt: Date | null = null): ActivationCandidate => ({ id, generationSource: "generated", firstActivatedAt });
const manual = (id: string): ActivationCandidate => ({ id, generationSource: "manual", firstActivatedAt: null });

describe("STORY-046 AC3 · planActivationCharge", () => {
  it("the first N prompts, in the order given, take the free slots; the rest are charged", () => {
    const plan = planActivationCharge([gen("a"), gen("b"), gen("c"), gen("d")], 2);
    expect(plan.free).toEqual(["a", "b"]);
    expect(plan.charged).toEqual(["c", "d"]);
  });

  it("with no allowance left every first activation is charged", () => {
    expect(planActivationCharge([gen("a"), gen("b")], 0)).toEqual({ free: [], charged: ["a", "b"] });
  });

  it("an allowance already overspent (a negative remainder) charges everything and never goes negative", () => {
    expect(planActivationCharge([gen("a")], -4)).toEqual({ free: [], charged: ["a"] });
  });

  it("an allowance larger than the batch makes the whole batch free", () => {
    expect(planActivationCharge([gen("a"), gen("b")], 10)).toEqual({ free: ["a", "b"], charged: [] });
  });

  it("a manually typed prompt is neither charged nor recorded, and does not spend the allowance", () => {
    const plan = planActivationCharge([manual("m"), gen("a"), gen("b")], 1);
    expect(plan.free).toEqual(["a"]);
    expect(plan.charged).toEqual(["b"]);
  });

  it("a prompt that has been activated before is neither charged nor recorded again, and does not spend the allowance", () => {
    const plan = planActivationCharge([gen("old", new Date()), gen("a"), gen("b")], 1);
    expect(plan.free).toEqual(["a"]);
    expect(plan.charged).toEqual(["b"]);
  });

  it("an empty batch plans nothing", () => {
    expect(planActivationCharge([], 10)).toEqual({ free: [], charged: [] });
  });
});

describe("STORY-046 AC3 · chargeForActivation", () => {
  const exporter = new InMemorySpanExporter();
  const calls: { sql: string; params: unknown[] }[] = [];
  let used = 0;

  const tx = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: sql.includes("count(*)") ? [{ n: used }] : [], rowCount: 0 };
    }),
  } as unknown as ClientBase;

  const entitlements = {
    "prompts.free_at_creation": { value: 10 },
    "prompts.credits_per_generated": { value: 1 },
    "credits.included_per_cycle": { value: 37 },
  };
  const input = (candidates: ActivationCandidate[], ents: Record<string, { value: unknown }> = entitlements) => ({
    workspaceId: "ws-1",
    actorId: "user-1",
    projectId: "proj-1",
    candidates,
    entitlements: ents,
  });

  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  });

  beforeEach(() => {
    calls.length = 0;
    used = 0;
    exporter.reset();
    vi.spyOn(debit, "debitInTransaction").mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("debits exactly price x charged prompts, as action prompt_activate, naming the project", async () => {
    used = 9;
    const charged = await chargeForActivation(tx, input([gen("a"), gen("b"), gen("c")]));

    expect(charged).toBe(2);
    expect(debit.debitInTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(debit.debitInTransaction).mock.calls[0]![1]).toMatchObject({
      workspaceId: "ws-1",
      actorId: "user-1",
      actionCode: "prompt_activate",
      credits: 2,
      projectId: "proj-1",
      includedGrant: 37,
      unitDetail: { prompts: 2, engines: 0, cells_charged: 0, cells_cached: 0 },
    });
  });

  it("the ledger key names the project and the charged set, whatever order they were sent in", async () => {
    used = 10;
    await chargeForActivation(tx, input([gen("a"), gen("b")]));
    await chargeForActivation(tx, input([gen("b"), gen("a")]));
    const [first, second] = vi.mocked(debit.debitInTransaction).mock.calls.map((c) => c[1].idempotencyKey);
    expect(first).toBe(second);
    expect(first).toMatch(/^prompt_activate:proj-1:[0-9a-f]{64}$/);
  });

  it("inside the free allowance nothing is debited, and the prompts are recorded at 0", async () => {
    used = 0;
    const charged = await chargeForActivation(tx, input([gen("a"), gen("b")]));

    expect(charged).toBe(0);
    expect(debit.debitInTransaction).not.toHaveBeenCalled();
    const writes = calls.filter((c) => c.sql.startsWith("UPDATE tracked_prompts"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.params).toEqual([["a", "b"], 0]);
  });

  it("charged prompts are recorded at the price they were charged", async () => {
    used = 10;
    await chargeForActivation(tx, input([gen("a")], { ...entitlements, "prompts.credits_per_generated": { value: 3 } }));
    const writes = calls.filter((c) => c.sql.startsWith("UPDATE tracked_prompts"));
    expect(writes.map((w) => w.params)).toEqual([[["a"], 3]]);
    expect(vi.mocked(debit.debitInTransaction).mock.calls[0]![1].credits).toBe(3);
  });

  it("a batch with nothing new in it (manual, or activated before) does no work at all - not even a read", async () => {
    const charged = await chargeForActivation(tx, input([manual("m"), gen("old", new Date())]));
    expect(charged).toBe(0);
    expect(calls).toEqual([]);
    expect(debit.debitInTransaction).not.toHaveBeenCalled();
  });

  it("a missing allowance means no free slots, not unlimited ones", async () => {
    used = 0;
    const { "prompts.free_at_creation": _drop, ...withoutAllowance } = entitlements;
    expect(await chargeForActivation(tx, input([gen("a")], withoutAllowance))).toBe(1);
  });

  it("a plan that holds prompts but publishes no price refuses rather than guessing one", async () => {
    used = 10;
    const { "prompts.credits_per_generated": _drop, ...withoutPrice } = entitlements;
    const error = await chargeForActivation(tx, input([gen("a")], withoutPrice)).catch((e: unknown) => e as { code?: string });
    expect((error as { code?: string }).code).toBe("precondition_unmet");
    expect(debit.debitInTransaction).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.sql.startsWith("UPDATE"))).toEqual([]);
  });

  it("a price that is not a whole non-negative number is refused too", async () => {
    used = 10;
    for (const bad of [-1, 1.5, "negotiated", null]) {
      const error = await chargeForActivation(tx, input([gen("a")], { ...entitlements, "prompts.credits_per_generated": { value: bad } })).catch(
        (e: unknown) => e as { code?: string },
      );
      expect((error as { code?: string }).code).toBe("precondition_unmet");
    }
  });

  it("a debit refusal writes nothing to the prompts", async () => {
    used = 10;
    vi.mocked(debit.debitInTransaction).mockRejectedValue(new InsufficientCreditsError({ message: "no" } as never));
    await expect(chargeForActivation(tx, input([gen("a")]))).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(calls.filter((c) => c.sql.startsWith("UPDATE"))).toEqual([]);
  });

  // ---- observability: a span, a metric and a redacted log line ----

  it("emits a span carrying the counts and no ids", async () => {
    used = 9;
    await chargeForActivation(tx, input([gen("a"), gen("b"), gen("c")]));

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["prompts.activation.charge"]);
    expect(spans[0]!.attributes).toMatchObject({
      "nominara.prompts.activated_free": 1,
      "nominara.prompts.activated_charged": 2,
      "nominara.credits.charged": 2,
    });
    expect(JSON.stringify(spans[0]!.attributes)).not.toContain("ws-1");
  });

  it("marks the span as an error when the debit is refused", async () => {
    used = 10;
    vi.mocked(debit.debitInTransaction).mockRejectedValue(new InsufficientCreditsError({ message: "no" } as never));
    await chargeForActivation(tx, input([gen("a")])).catch(() => undefined);
    expect(exporter.getFinishedSpans()[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("counts a charge, a free activation and a refusal under distinct outcomes, and logs the workspace ID only", async () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);

    used = 10;
    await chargeForActivation(tx, input([gen("a")]));
    used = 0;
    await chargeForActivation(tx, input([gen("b")]));
    used = 10;
    vi.mocked(debit.debitInTransaction).mockRejectedValue(new InsufficientCreditsError({ message: "no" } as never));
    await chargeForActivation(tx, input([gen("c")])).catch(() => undefined);

    const metrics = log.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.metric === "nominara_prompts_activation_charges_total");
    expect(metrics.map((m) => m.outcome)).toEqual(["charged", "free", "refused_insufficient_credits"]);

    const lines = log.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.event === "prompts.activation.charged");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      event: "prompts.activation.charged",
      workspace_id: "ws-1",
      project_id: "proj-1",
      prompts_free: 0,
      prompts_charged: 1,
      credits: 1,
    });
  });
});

describe("STORY-046 AC3 · the price quote (owner decision 2026-10-15, option C)", () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  let used = 0;
  const tx = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: sql.includes("count(*)") ? [{ n: used }] : [], rowCount: 0 };
    }),
  } as unknown as ClientBase;
  const entitlements = {
    "prompts.free_at_creation": { value: 10 },
    "prompts.credits_per_generated": { value: 1 },
    "credits.included_per_cycle": { value: 37 },
  };
  const input = (candidates: ActivationCandidate[], extra: Record<string, unknown> = {}) => ({
    workspaceId: "ws-1",
    actorId: "user-1",
    projectId: "proj-1",
    candidates,
    entitlements,
    ...extra,
  });

  beforeEach(() => {
    calls.length = 0;
    used = 0;
    vi.spyOn(debit, "debitInTransaction").mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("quoteActivation prices a batch by the same rule the charge uses and writes nothing", async () => {
    used = 9;
    const quote = await quoteActivation(tx, input([gen("a"), gen("b"), gen("c"), manual("m"), gen("old", new Date())]));

    expect(quote).toMatchObject({ free: ["a"], charged: ["b", "c"], total: 2 });
    expect(calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)/i.test(c.sql))).toEqual([]);
    expect(debit.debitInTransaction).not.toHaveBeenCalled();
  });

  it("a batch with nothing new quotes 0 without a read", async () => {
    expect(await quoteActivation(tx, input([manual("m")]))).toMatchObject({ free: [], charged: [], total: 0 });
    expect(calls).toEqual([]);
  });

  it("a charged activation with NO confirmed figure is refused before any debit or write", async () => {
    used = 10;
    await expect(chargeForActivation(tx, input([gen("a")], { confirmedCredits: null }))).rejects.toMatchObject({ code: "validation_failed" });
    expect(debit.debitInTransaction).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.sql.startsWith("UPDATE"))).toEqual([]);
  });

  it("a confirmed figure that differs is price_changed naming both figures, before any debit or write", async () => {
    used = 10;
    await expect(chargeForActivation(tx, input([gen("a"), gen("b")], { confirmedCredits: 1 }))).rejects.toMatchObject({
      code: "price_changed",
      details: { shown: 1, recomputed: 2 },
    });
    expect(debit.debitInTransaction).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.sql.startsWith("UPDATE"))).toEqual([]);
  });

  it("a matching figure debits exactly that figure", async () => {
    used = 10;
    expect(await chargeForActivation(tx, input([gen("a"), gen("b")], { confirmedCredits: 2 }))).toBe(2);
    expect(vi.mocked(debit.debitInTransaction).mock.calls[0]![1].credits).toBe(2);
  });

  it("a free activation needs no figure, and 0 is accepted when given", async () => {
    used = 0;
    expect(await chargeForActivation(tx, input([gen("a")], { confirmedCredits: null }))).toBe(0);
    expect(await chargeForActivation(tx, input([gen("b")], { confirmedCredits: 0 }))).toBe(0);
  });

  it("forwards the auto top-up request to the debit", async () => {
    used = 10;
    const autoTopup = vi.fn();
    await chargeForActivation(tx, input([gen("a")], { confirmedCredits: 1, autoTopup }));
    expect(vi.mocked(debit.debitInTransaction).mock.calls[0]![1].autoTopup).toBe(autoTopup);
  });
});

describe("STORY-046 AC3 · inheritFirstActivation", () => {
  it("copies the fact onto the reworded row", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const when = new Date("2026-10-01T00:00:00Z");
    await inheritFirstActivation({ query } as unknown as ClientBase, "new-id", { firstActivatedAt: when, activationCredits: 1 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE tracked_prompts"), ["new-id", when, 1]);
  });

  it("writes nothing when the question was never activated", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await inheritFirstActivation({ query } as unknown as ClientBase, "new-id", { firstActivatedAt: null, activationCredits: 0 });
    expect(query).not.toHaveBeenCalled();
  });
});
